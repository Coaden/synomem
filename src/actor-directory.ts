import { SynomemError } from './errors.js';
import { cursorFilter } from './cursors.js';
import type { CursorBinding } from './cursors.js';
import type { AddressableActor, ActorRef } from './policy.js';
import type { ActorIdentity, ItemSummary, Page } from './types.js';
export interface ActorProfileInput {
  target: ActorRef;
  after?: string;
  limit?: number;
}
export interface ActorProfile {
  actor: AddressableActor;
  counts: { kudosReceived: number; usefulReceived: number };
  authored: Page<ItemSummary>;
}
export interface ActorDirectoryInput {
  query?: string;
  kind?: 'human' | 'agent';
  cursor?: string;
  limit?: number;
}
export interface ActorDirectoryPage {
  items: AddressableActor[];
  hasMore: boolean;
  nextCursor?: string;
  total: number;
  limit: number;
}
export function actorDirectoryBinding(
  workspaceId: string,
  viewer: ActorIdentity,
  input: ActorDirectoryInput,
): CursorBinding {
  return {
    purpose: 'actor-directory',
    workspaceId,
    actor: { kind: viewer.kind, id: viewer.id },
    filter: cursorFilter({ query: (input.query ?? '').toLowerCase(), kind: input.kind ?? null }),
  };
}
export function actorDirectoryKey(actor: Pick<AddressableActor, 'kind' | 'handle' | 'id'>): string {
  return JSON.stringify([actor.kind, actor.handle, actor.id]);
}
export function parseActorDirectoryKey(key: string): [string, string, string] {
  try {
    const parts: unknown = JSON.parse(key);
    if (
      Array.isArray(parts) &&
      parts.length === 3 &&
      (parts[0] === 'human' || parts[0] === 'agent') &&
      typeof parts[1] === 'string' &&
      typeof parts[2] === 'string' &&
      parts[1].length <= 100 &&
      parts[2].length <= 200
    )
      return parts as [string, string, string];
  } catch {
    // A signed cursor can still be stale or malformed after a codec change.
  }
  throw new SynomemError('INVALID_INPUT', 'Invalid actor directory cursor.');
}
export function actorDirectoryInput(
  input: ActorDirectoryInput = {},
): Required<Pick<ActorDirectoryInput, 'query' | 'limit'>> &
  Pick<ActorDirectoryInput, 'kind' | 'cursor'> {
  if (
    Object.keys(input).some((key) => !['query', 'kind', 'cursor', 'limit'].includes(key)) ||
    (input.query !== undefined && typeof input.query !== 'string') ||
    (input.kind !== undefined && !['human', 'agent'].includes(input.kind)) ||
    (input.cursor !== undefined &&
      (typeof input.cursor !== 'string' ||
        input.cursor.length < 1 ||
        input.cursor.length > 4096)) ||
    (input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50))
  )
    throw new SynomemError('INVALID_INPUT', 'Invalid actor directory query.');
  const query = (input.query ?? '').trim();
  if (query.length > 100)
    throw new SynomemError('INVALID_INPUT', 'Actor query is limited to 100 characters.');
  return {
    query,
    limit: input.limit ?? 20,
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
  };
}
