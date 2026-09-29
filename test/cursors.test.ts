import { describe, expect, it } from 'vitest';
import { SignedCursorCodec, cursorFilter } from '../src/cursors.js';
const key = 'disposable-cursor-signing-key-32-bytes';
const binding = {
  purpose: 'thread',
  workspaceId: 'workspace',
  actor: { kind: 'human' as const, id: 'troy' },
  filter: cursorFilter({ rootId: 'root' }),
};
describe('signed cursor codec', () => {
  it('keeps exact sequences and binds purpose, viewer, workspace and filter', () => {
    const codec = new SignedCursorCodec({ keyId: 'current', key });
    const position = { sequence: '9007199254740993', watermark: '9007199254740999' };
    const token = codec.encode(binding, position);
    expect(codec.decode(token, binding, position.watermark)).toEqual(position);
    const projected = { ...binding, generation: 'before-rebuild' };
    const projectionToken = codec.encode(projected, position);
    expect(() =>
      codec.decode(
        projectionToken,
        { ...projected, generation: 'after-rebuild' },
        position.watermark,
      ),
    ).toThrow(expect.objectContaining({ code: 'CURSOR_EXPIRED' }));
    for (const other of [
      { ...binding, purpose: 'inbox' },
      { ...binding, workspaceId: 'other' },
      { ...binding, actor: { kind: 'agent' as const, id: 'troy' } },
      { ...binding, filter: 'other' },
    ])
      expect(() => codec.decode(token, other, position.watermark)).toThrow();
    expect(() =>
      codec.decode(
        token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'),
        binding,
        position.watermark,
      ),
    ).toThrow();
    expect(() => codec.decode(token, binding, '1')).toThrow();
  });
  it('expires and verifies rotated keys without granting mutation authority', () => {
    let now = 0;
    const old = new SignedCursorCodec({ keyId: 'old', key, now: () => now });
    const token = old.encode(binding, { sequence: '1', watermark: '2' });
    const next = new SignedCursorCodec({
      keyId: 'new',
      key: key + 'new',
      verificationKeys: new Map([['old', key]]),
      now: () => now,
    });
    expect(next.decode(token, binding, '2').sequence).toBe('1');
    now = 86400_000;
    expect(() => next.decode(token, binding, '2')).toThrow(
      expect.objectContaining({ code: 'CURSOR_EXPIRED' }),
    );
  });
});
