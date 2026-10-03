import { describe, it, expect } from 'vitest';
import { SynomemClient } from '../src/client.js';
import { tempHome, testClient } from './helpers.js';
describe('bounded frozen follower fanout', () => {
  it('accepts another replier beyond 500 participants and recovers every one of 10,001 followers', async () => {
    const home = tempHome();
    const owner = await testClient(home);
    const root = await owner.posts.create({
      title: 'Busy workspace discussion',
      body: 'Every follower remains eligible.',
    });
    const workspace = owner.storage.config.workspaceId;
    owner.storage.transactionSync(() => {
      const register = owner.storage
        .db()
        .prepare("INSERT INTO human_actors(id,handle,display_name,status) VALUES(?,?,?,'active')");
      const follow = owner.storage
        .db()
        .prepare(
          "INSERT INTO thread_members(workspace_id,root_id,actor_kind,actor_id,following,muted,joined_sequence) VALUES(?,?,'human',?,1,0,0)",
        );
      for (let index = 0; index < 10001; index++) {
        const id = `follower-${index}`;
        register.run(id, id, id);
        follow.run(workspace, root.record.event.id, id);
      }
    });
    const replier = new SynomemClient({ home, actor: { kind: 'human', id: 'follower-501' } });
    await replier.init();
    const reply = await replier.replies.create({
      rootId: root.record.event.id,
      body: 'Participant 501 can still reply.',
    });
    expect(reply.author.id).toBe('follower-501');
    const count = () =>
      Number(
        (
          owner.storage
            .db()
            .prepare(
              "SELECT COUNT(*) AS count FROM notification_fanout_targets WHERE event_id=? AND state='pending'",
            )
            .get(reply.id) as { count: number }
        ).count,
      );
    expect(count()).toBe(10000);
    await owner.storage.transaction(() => owner.storage.notifications.drain(200));
    expect(count()).toBe(9800);
    await owner.close();
    await replier.close();
    const resumed = await testClient(home);
    for (let batch = 0; batch < 49; batch++) {
      const result = await resumed.storage.transaction(() =>
        resumed.storage.notifications.drain(200),
      );
      expect(result.delivered + result.suppressed).toBeLessThanOrEqual(200);
    }
    expect(
      Number(
        (
          resumed.storage
            .db()
            .prepare(
              "SELECT COUNT(*) AS count FROM notification_fanout_targets WHERE event_id=? AND state='pending'",
            )
            .get(reply.id) as { count: number }
        ).count,
      ),
    ).toBe(0);
    expect(
      Number(
        (
          resumed.storage
            .db()
            .prepare('SELECT COUNT(*) AS count FROM inbox_notifications WHERE event_id=?')
            .get(reply.id) as { count: number }
        ).count,
      ),
    ).toBe(10001);
    await resumed.rebuild();
    await resumed.storage.transaction(() => resumed.storage.notifications.drain(200));
    expect(
      Number(
        (
          resumed.storage
            .db()
            .prepare('SELECT COUNT(*) AS count FROM inbox_notifications WHERE event_id=?')
            .get(reply.id) as { count: number }
        ).count,
      ),
    ).toBe(10001);
    await resumed.close();
  }, 90000);
});
