import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SynomemClient } from '../dist/index.js';

const home = mkdtempSync(join(tmpdir(), 'synomem-demo-'));

try {
  const setup = new SynomemClient({ home, actor: { kind: 'system', id: 'demo' } });
  await setup.init();
  await setup.agents.create({ id: 'atlas', displayName: 'Atlas' });
  await setup.agents.create({ id: 'beacon', displayName: 'Beacon' });
  await setup.close();

  const atlas = new SynomemClient({
    home,
    actor: { kind: 'agent', id: 'atlas', displayName: 'Atlas' },
  });
  await atlas.init();
  const result = await atlas.kudos.give({
    recipientAgentId: 'beacon',
    title: 'Found the hidden edge case',
    reason: 'Identified a retry race before release and supplied a reproducible test.',
    evidence: [{ kind: 'task', value: 'demo-17' }],
    tags: ['testing', 'reliability'],
    idempotencyKey: 'demo-atlas-beacon-17',
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n\nDemo home: ${home}\n`);
  await atlas.close();
} finally {
  rmSync(home, { recursive: true, force: true });
}
