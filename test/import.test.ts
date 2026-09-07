import { describe, expect, it } from 'vitest';
import { createLocalImportBundle, validateImportBundle } from '../src/import.js';
import { tempHome, testClient } from './helpers.js';

describe('local-to-remote import bundles', () => {
  it('backs up without mutating the source and validates the exact bundle', async () => {
    const home = tempHome();
    const source = await testClient(home);
    await source.agents.create({ handle: 'codex', displayName: 'Codex' });
    await source.notes.create({ ownerAgentId: 'codex', title: 'Memory', body: 'Keep this.' });
    const before = source.storage.rawEventRows();
    await source.close();

    const bundle = await createLocalImportBundle(home);
    expect(bundle.events).toHaveLength(2);
    expect(bundle.profiles).toHaveLength(1);
    expect(validateImportBundle(bundle)).toEqual(bundle);

    const reopened = await testClient(home, undefined, { readOnly: true });
    expect(reopened.storage.rawEventRows()).toEqual(before);
    await reopened.close();
  });

  it('rejects checksum changes and non-contiguous aggregate history', async () => {
    const home = tempHome();
    const source = await testClient(home);
    await source.agents.create({ handle: 'codex', displayName: 'Codex' });
    await source.close();
    const bundle = await createLocalImportBundle(home);
    expect(() => validateImportBundle({ ...bundle, checksum: '0'.repeat(64) })).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
    expect(() =>
      validateImportBundle({
        ...bundle,
        events: [{ ...bundle.events[0]!, aggregateVersion: 2 }],
      }),
    ).toThrow();
  });
});
