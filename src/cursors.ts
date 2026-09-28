import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { SynomemError } from './errors.js';
import type { ActorIdentity } from './types.js';
export interface CursorBinding {
  purpose: string;
  workspaceId: string;
  actor: Pick<ActorIdentity, 'kind' | 'id'>;
  filter: string;
  generation?: string;
}
export interface CursorPosition {
  sequence: string;
  watermark: string;
  id?: string;
}
interface CursorEnvelope extends CursorBinding, CursorPosition {
  v: 1;
  kid: string;
  expiresAt: number;
}
const decimal = /^(0|[1-9][0-9]{0,18})$/;
const maximumSequence = 9223372036854775807n;
export function exactSequence(value: string | bigint | number): string {
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    throw new SynomemError('INVALID_INPUT', 'A sequence must be an exact integer.');
  const text = String(value);
  if (!decimal.test(text) || BigInt(text) > maximumSequence)
    throw new SynomemError('INVALID_INPUT', 'Invalid sequence.');
  return text;
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function cursorFilter(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('base64url');
}
/** Integrity codec shared by adapters; callers always recheck current record authority. */
export class SignedCursorCodec {
  private readonly keys: ReadonlyMap<string, string | Uint8Array>;
  constructor(
    private readonly options: {
      keyId: string;
      key: string | Uint8Array;
      verificationKeys?: ReadonlyMap<string, string | Uint8Array>;
      now?: () => number;
    },
  ) {
    if (Buffer.byteLength(options.key) < 32)
      throw new SynomemError('CONFIG_INVALID', 'Cursor signing keys require at least 32 bytes.');
    this.keys = new Map([...(options.verificationKeys ?? []), [options.keyId, options.key]]);
  }
  encode(binding: CursorBinding, position: CursorPosition): string {
    const envelope: CursorEnvelope = {
      ...binding,
      ...position,
      sequence: exactSequence(position.sequence),
      watermark: exactSequence(position.watermark),
      v: 1,
      kid: this.options.keyId,
      expiresAt:
        (this.options.now?.() ?? Date.now()) +
        (binding.purpose.includes('changes') ? 90 * 86400_000 : 86400_000),
    };
    if (BigInt(envelope.sequence) > BigInt(envelope.watermark))
      throw new SynomemError('INVALID_INPUT', 'Cursor position exceeds its watermark.');
    const body = Buffer.from(canonicalJson(envelope)).toString('base64url');
    return `${body}.${createHmac('sha256', this.options.key).update(body).digest('base64url')}`;
  }
  decode(token: string, binding: CursorBinding, maximum: string): CursorPosition {
    try {
      if (token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token))
        throw new Error();
      const [body, signature] = token.split('.') as [string, string];
      const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CursorEnvelope;
      const key = this.keys.get(value.kid);
      if (!key) throw new Error();
      const expected = createHmac('sha256', key).update(body).digest();
      const actual = Buffer.from(signature, 'base64url');
      if (
        actual.toString('base64url') !== signature ||
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        throw new Error();
      if (
        value.v !== 1 ||
        value.purpose !== binding.purpose ||
        value.workspaceId !== binding.workspaceId ||
        value.actor?.kind !== binding.actor.kind ||
        value.actor?.id !== binding.actor.id ||
        value.filter !== binding.filter ||
        !Number.isSafeInteger(value.expiresAt)
      )
        throw new Error();
      if (value.generation !== binding.generation)
        throw new SynomemError(
          'CURSOR_EXPIRED',
          'This projection was rebuilt. Start from the latest page.',
        );
      if (value.expiresAt <= (this.options.now?.() ?? Date.now()))
        throw new SynomemError(
          'CURSOR_EXPIRED',
          'This cursor expired. Refresh to synchronize again.',
        );
      exactSequence(value.sequence);
      exactSequence(value.watermark);
      exactSequence(maximum);
      if (
        BigInt(value.sequence) > BigInt(value.watermark) ||
        BigInt(value.watermark) > BigInt(maximum)
      )
        throw new Error();
      if (value.id !== undefined && (typeof value.id !== 'string' || value.id.length > 200))
        throw new Error();
      return {
        sequence: value.sequence,
        watermark: value.watermark,
        ...(value.id ? { id: value.id } : {}),
      };
    } catch (error) {
      if (error instanceof SynomemError && error.code === 'CURSOR_EXPIRED') throw error;
      throw new SynomemError('INVALID_INPUT', `Invalid ${binding.purpose} cursor.`);
    }
  }
}
