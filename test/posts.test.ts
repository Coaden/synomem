import { describe, expect, it } from 'vitest';
import { tempHome, testClient } from './helpers.js';

async function workspace() {
  const home = tempHome();
  const operator = await testClient(home);
  const mycroftProfile = await operator.agents.create({
    handle: 'mycroft',
    displayName: 'Mycroft',
  });
  const atlasProfile = await operator.agents.create({ handle: 'atlas', displayName: 'Atlas' });
  const mycroft = await testClient(home, { kind: 'agent', id: 'mycroft', displayName: 'Mycroft' });
  const atlas = await testClient(home, { kind: 'agent', id: 'atlas', displayName: 'Atlas' });
  return { home, operator, mycroft, atlas, mycroftId: mycroftProfile.id, atlasId: atlasProfile.id };
}

describe('posts', () => {
  it('is readable by everyone in the workspace, unlike a note or a todo', async () => {
    const { operator, mycroft, atlas } = await workspace();
    const post = await mycroft.posts.create({
      title: 'Migration is landing tonight',
      body: 'Expect a short read-only window around 22:00.',
    });

    // The author, another agent, and a human operator all see the same post.
    for (const [name, client] of [
      ['author', mycroft],
      ['peer', atlas],
      ['operator', operator],
    ] as const) {
      expect((await client.posts.get(post.record.event.id)).title, name).toBe(
        'Migration is landing tonight',
      );
    }
    // A private todo written by the same agent stays invisible to the peer,
    // which is the contrast that makes posts a separate domain.
    await mycroft.todos.create({ title: 'Private reminder' });
    expect((await atlas.items.list({ kinds: ['todo'] })).items).toHaveLength(0);

    await Promise.all([operator.close(), mycroft.close(), atlas.close()]);
  });

  it('records an acknowledgement per actor, and only for that actor', async () => {
    const { operator, mycroft, atlas, atlasId } = await workspace();
    const post = await mycroft.posts.create({ title: 'Read me', body: 'Please acknowledge.' });
    const id = post.record.event.id;

    await atlas.posts.acknowledge({ postId: id, note: 'Already handled in the other workspace.' });
    const seen = await mycroft.posts.get(id);
    expect(seen.acknowledgments).toHaveLength(1);
    expect(seen.acknowledgments[0]?.actor.id).toBe(atlasId);
    expect(seen.acknowledgments[0]?.note).toContain('Already handled');

    // Acknowledging twice is the same statement, not a second one.
    await atlas.posts.acknowledge({ postId: id });
    expect((await mycroft.posts.get(id)).acknowledgments).toHaveLength(1);

    // And it can be taken back.
    await atlas.posts.withdrawAcknowledgment({ postId: id });
    expect((await mycroft.posts.get(id)).acknowledgments).toHaveLength(0);

    await Promise.all([operator.close(), mycroft.close(), atlas.close()]);
  });

  it('never acknowledges as a side effect of reading', async () => {
    const { operator, mycroft, atlas } = await workspace();
    const post = await mycroft.posts.create({ title: 'Quiet', body: 'Reading is not answering.' });

    // Reading it repeatedly, from two actors, must leave the roster untouched.
    await atlas.posts.get(post.record.event.id);
    await atlas.posts.list();
    await operator.posts.get(post.record.event.id);

    const roster = await mycroft.posts.roster(post.record.event.id);
    expect(roster.acknowledged).toHaveLength(0);
    await Promise.all([operator.close(), mycroft.close(), atlas.close()]);
  });

  it('does not count agents that did not exist when the post was written', async () => {
    const { home, operator, mycroft, atlas, mycroftId, atlasId } = await workspace();
    const post = await mycroft.posts.create({ title: 'Before', body: 'Written first.' });
    await atlas.posts.acknowledge({ postId: post.record.event.id });

    // A newcomer is neither acknowledged nor outstanding: it was not there, and
    // saying otherwise accuses it of ignoring something it never saw.
    await operator.agents.create({ handle: 'newcomer', displayName: 'Newcomer' });
    const roster = await mycroft.posts.roster(post.record.event.id);

    expect(roster.acknowledged.map((entry) => entry.actor.id)).toEqual([atlasId]);
    expect(roster.outstanding.map((entry) => entry.id)).toEqual([mycroftId]);
    expect(roster.joinedSince).toBe(1);

    const newcomer = await testClient(home, { kind: 'agent', id: 'newcomer' });
    expect((await newcomer.posts.get(post.record.event.id)).title).toBe('Before');
    await newcomer.close();
    await Promise.all([operator.close(), mycroft.close(), atlas.close()]);
  });

  it('lets only the author edit, and keeps the edit visible', async () => {
    const { operator, mycroft, atlas } = await workspace();
    const post = await mycroft.posts.create({ title: 'Draft', body: 'First wording.' });
    const id = post.record.event.id;

    await expect(
      atlas.posts.update({ postId: id, expectedVersion: 1, body: 'Sneaky rewrite.' }),
    ).rejects.toMatchObject({ code: 'MUTATION_FORBIDDEN' });

    const edited = await mycroft.posts.update({
      postId: id,
      expectedVersion: 1,
      body: 'Clearer wording.',
    });
    expect(edited.body).toBe('Clearer wording.');
    // The edit is kept, not collapsed: somebody who acknowledged the first
    // version has to be able to see that it changed.
    expect(edited.edits).toHaveLength(1);
    expect(edited.event.body).toBe('First wording.');

    await expect(
      mycroft.posts.update({ postId: id, expectedVersion: 1, body: 'Stale write.' }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });

    await Promise.all([operator.close(), mycroft.close(), atlas.close()]);
  });

  it('appears in the shared item list under its own kind', async () => {
    const { operator, mycroft, atlas } = await workspace();
    await mycroft.posts.create({ title: 'Listed', body: 'Findable.' });
    const page = await atlas.items.list({ kinds: ['post'] });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.kind).toBe('post');
    await Promise.all([operator.close(), mycroft.close(), atlas.close()]);
  });
});

describe('post acknowledgement concurrency', () => {
  it('does not let an acknowledgement invalidate an edit in flight', async () => {
    // Acknowledgements are events on the post, so they advance the aggregate
    // version. If the author's expectedVersion were that number, somebody
    // acknowledging would produce a conflict with nothing to reconcile.
    const home = tempHome();
    const operator = await testClient(home);
    await operator.agents.create({ handle: 'mycroft', displayName: 'Mycroft' });
    await operator.agents.create({ handle: 'atlas', displayName: 'Atlas' });
    const mycroft = await testClient(home, { kind: 'agent', id: 'mycroft' });
    const atlas = await testClient(home, { kind: 'agent', id: 'atlas' });

    const post = await mycroft.posts.create({ title: 'Notice', body: 'Original.' });
    const id = post.record.event.id;
    expect(post.record.version).toBe(1);

    await atlas.posts.acknowledge({ postId: id });
    // Still version 1: the text has not changed.
    expect((await mycroft.posts.get(id)).version).toBe(1);

    const edited = await mycroft.posts.update({ postId: id, expectedVersion: 1, body: 'Revised.' });
    expect(edited.version).toBe(2);
    expect(edited.acknowledgments).toHaveLength(1);

    await Promise.all([operator.close(), mycroft.close(), atlas.close()]);
  });

  it('accepts acknowledgements from several actors on one post', async () => {
    const home = tempHome();
    const operator = await testClient(home);
    const ids: Record<string, string> = {};
    for (const handle of ['one', 'two', 'three']) {
      ids[handle] = (await operator.agents.create({ handle, displayName: handle })).id;
    }
    const author = await testClient(home, { kind: 'agent', id: 'one' });
    const post = await author.posts.create({ title: 'Many', body: 'Everyone read this.' });

    for (const id of ['two', 'three']) {
      const client = await testClient(home, { kind: 'agent', id });
      await client.posts.acknowledge({ postId: post.record.event.id });
      await client.close();
    }

    const roster = await author.posts.roster(post.record.event.id);
    expect(roster.acknowledged.map((e) => e.actor.id).sort()).toEqual(
      [ids.two!, ids.three!].sort(),
    );
    expect(roster.outstanding.map((e) => e.id)).toEqual([ids.one]);
    await Promise.all([operator.close(), author.close()]);
  });
});
