import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { SynomemClient } from '../src/index.js';
import type { ActorIdentity, SynomemClientOptions } from '../src/types.js';

const temporaryHomes: string[] = [];

export function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'synomem-test-'));
  temporaryHomes.push(home);
  return home;
}

export async function testClient(
  home: string,
  actor: ActorIdentity = { kind: 'human', id: 'troy', displayName: 'Troy' },
  options: Omit<SynomemClientOptions, 'home' | 'actor'> = {},
): Promise<SynomemClient> {
  const client = new SynomemClient({ home, actor, ...options });
  await client.init();
  return client;
}

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
