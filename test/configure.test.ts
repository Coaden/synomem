import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  credentialFingerprint,
  credentialStoreChoices,
  defaultCredentialBackend,
  parseCredentialBackend,
  readAccessKey,
} from '../src/configure.js';
import type { PromptIo } from '../src/prompt.js';

function piped(input: string): PromptIo {
  return {
    input: Readable.from([input]),
    output: new Writable({ write: (_chunk, _encoding, done) => done() }),
    interactive: false,
  };
}

describe('setup helpers', () => {
  it('offers only stores that can read their credential back on each platform', () => {
    expect(credentialStoreChoices('darwin').map((c) => c.value)).toEqual([
      'keychain',
      'file',
      'environment',
    ]);
    expect(credentialStoreChoices('win32').map((c) => c.value)).toEqual(['file', 'environment']);
  });

  it('defaults to the keychain and refuses to guess where none exists', () => {
    expect(defaultCredentialBackend('darwin')).toBe('keychain');
    expect(defaultCredentialBackend('linux')).toBe('keychain');
    expect(() => defaultCredentialBackend('win32')).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
    expect(parseCredentialBackend('file', 'win32')).toBe('file');
    expect(() => parseCredentialBackend('plaintext')).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  });

  it('reads an access key from stdin and refuses anything that is not one', async () => {
    await expect(readAccessKey(piped('syn_abc.def\n'))).resolves.toBe('syn_abc.def');
    await expect(readAccessKey(piped(''))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(readAccessKey(piped('ghp_notours'))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('fingerprints a key without revealing it', () => {
    expect(credentialFingerprint('syn_0123456789abcdef')).toBe('syn_01234567…');
  });
});
