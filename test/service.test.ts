import { describe, expect, it } from 'vitest';
import { SynomemClient, SynomemCore } from '../src/client.js';
import { ProjectionManager } from '../src/projections.js';
import type { SynomemDomainService, SynomemService } from '../src/service.js';
import { SynomemStorage } from '../src/storage.js';
import { tempHome } from './helpers.js';

describe('domain service boundary', () => {
  it('runs authoritative behavior with injected repository and projection ports', async () => {
    const home = tempHome();
    const repository = new SynomemStorage({ home, readOnly: false });
    const service: SynomemDomainService = new SynomemCore({
      repository,
      projectionWriter: new ProjectionManager(repository),
      actor: { kind: 'human', id: 'troy', displayName: 'Troy' },
    });
    await service.init();

    await service.agents.create({ handle: 'codex', displayName: 'Codex' });
    const memo = await service.memos.send({
      recipientAgentId: 'codex',
      subject: 'Repository boundary',
      body: 'The core received its repository and projection writer as ports.',
    });
    expect(await service.items.get(memo.record.event.id)).toMatchObject({ status: 'unread' });

    await service.close();
  });

  it('allows adapters to deny the local human-administrator default explicitly', async () => {
    const home = tempHome();
    const repository = new SynomemStorage({ home, readOnly: false });
    const administrator = new SynomemCore({
      repository,
      projectionWriter: new ProjectionManager(repository),
      actor: { kind: 'human', id: 'owner', displayName: 'Owner' },
    });
    await administrator.init();
    await administrator.agents.create({ handle: 'codex', displayName: 'Codex' });
    const kudos = await administrator.kudos.give({
      recipientAgentId: 'codex',
      title: 'Explicit authority',
      reason: 'Provides an aggregate for the adapter-level boundary.',
    });
    await administrator.close();

    const restrictedRepository = new SynomemStorage({ home, readOnly: false });
    const restrictedHuman = new SynomemCore({
      repository: restrictedRepository,
      projectionWriter: new ProjectionManager(restrictedRepository),
      actor: { kind: 'human', id: 'member', displayName: 'Member' },
      administrative: false,
    });
    await restrictedHuman.init();
    await expect(
      restrictedHuman.kudos.revoke({
        kudosId: kudos.record.event.id,
        reason: 'A hosted human membership is not implicitly administrative.',
        administrative: true,
      }),
    ).rejects.toMatchObject({ code: 'REVOCATION_FORBIDDEN' });
    await restrictedHuman.close();
  });

  it('exposes local behavior without requiring storage or projections from adapters', async () => {
    const home = tempHome();
    const service: SynomemService = new SynomemClient({
      home,
      actor: { kind: 'human', id: 'troy', displayName: 'Troy' },
    });
    await service.init();

    const info = await service.info();
    expect(info).toMatchObject({ backend: 'local', home });
    expect(await service.capabilities()).toMatchObject({
      backend: 'local',
      administration: { agentCreationViaMcp: false, agentArchiveViaMcp: false, rebuildViaMcp: false },
      projections: { writeWinsMarkdown: true },
    });

    await service.agents.create({ handle: 'codex', displayName: 'Codex' });
    const result = await service.kudos.give({
      recipientAgentId: 'codex',
      title: 'Preserved the domain boundary',
      reason: 'Kept transport adapters independent from concrete local storage.',
    });
    expect(await service.getCanonicalEvent(result.record.event.id)).toEqual(result.record.event);
    expect((await service.rebuild()).generated.length).toBeGreaterThan(0);

    await service.close();
  });
});
