import { describe, expect, it } from 'vitest';
import { tempHome, testClient } from './helpers.js';

describe('topics', () => {
  it('is created freely by any actor, resolved by alias, and renamed without retagging', async () => {
    const home = tempHome();
    const gracie = await testClient(home, { kind: 'agent', id: 'gracie' });
    await gracie.agents.create({ handle: 'codex', displayName: 'Codex' });
    const topic = await gracie.topics.create({
      displayName: 'Synomem',
      aliases: ['syno', 'memory'],
    });
    expect(topic.status).toBe('active');

    // A different agent — no admin role required — reaches it by any alias,
    // case-insensitively.
    const codex = await testClient(home, { kind: 'agent', id: 'codex' });
    for (const query of ['synomem', 'SYNO', 'Memory']) {
      expect((await codex.topics.resolve(query)).match?.id, query).toBe(topic.id);
    }

    // Renaming the display name does not disturb the topic's ID, so records
    // already carrying it keep pointing at the same subject.
    const renamed = await gracie.topics.update(topic.id, { displayName: 'Synomem Project' });
    expect(renamed.id).toBe(topic.id);
    expect((await gracie.topics.resolve('syno')).match?.id).toBe(topic.id);
    expect((await gracie.topics.get(topic.id)).displayName).toBe('Synomem Project');

    await Promise.all([gracie.close(), codex.close()]);
  });

  it('refuses a duplicate display name or alias', async () => {
    const home = tempHome();
    const client = await testClient(home);
    await client.topics.create({ displayName: 'Synomem', aliases: ['syno'] });
    await expect(client.topics.create({ displayName: 'synomem' })).rejects.toMatchObject({
      code: 'TOPIC_EXISTS',
    });
    await expect(
      client.topics.create({ displayName: 'Other', aliases: ['Syno'] }),
    ).rejects.toMatchObject({ code: 'ALIAS_CONFLICT' });
    await client.close();
  });

  it('archives and restores without losing the topic or its history', async () => {
    const home = tempHome();
    const client = await testClient(home);
    const topic = await client.topics.create({ displayName: 'Deprecated feature' });
    const archived = await client.topics.archive(topic.id);
    expect(archived.status).toBe('archived');
    expect((await client.topics.list({ status: 'active' })).map((t) => t.id)).not.toContain(
      topic.id,
    );
    const restored = await client.topics.restore(topic.id);
    expect(restored.status).toBe('active');
    await client.close();
  });

  it('rejects an unknown or archived topic on any record, and files a record under several at once', async () => {
    const home = tempHome();
    const operator = await testClient(home);
    const gracieProfile = await operator.agents.create({ handle: 'gracie', displayName: 'Gracie' });
    await operator.close();
    const gracie = await testClient(home, { kind: 'agent', id: gracieProfile.id });
    const synomem = await gracie.topics.create({ displayName: 'Synomem' });
    const docMatching = await gracie.topics.create({ displayName: 'Doc Matching' });
    const archived = await gracie.topics.create({ displayName: 'Old thing' });
    await gracie.topics.archive(archived.id);

    await expect(
      gracie.todos.create({ title: 'Bad topic', topicIds: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'] }),
    ).rejects.toMatchObject({ code: 'TOPIC_NOT_FOUND' });
    await expect(
      gracie.todos.create({ title: 'Archived topic', topicIds: [archived.id] }),
    ).rejects.toMatchObject({ code: 'TOPIC_NOT_FOUND' });

    const todo = await gracie.todos.create({
      title: 'File under two topics',
      topicIds: [synomem.id, docMatching.id],
    });
    expect(todo.record.event.topicIds?.slice().sort()).toEqual([synomem.id, docMatching.id].sort());

    const note = await gracie.notes.create({
      title: 'Synomem note',
      body: 'Testing the topicId filter.',
      topicIds: [synomem.id],
    });

    // The stable, cross-kind filter a tag search on the same word cannot
    // give: exactly the note and the todo carrying this topic, and nothing
    // filed only under the other one.
    const filtered = await gracie.items.list({ topicId: synomem.id });
    const ids = filtered.items.map((item) => item.id);
    expect(ids).toContain(todo.record.event.id);
    expect(ids).toContain(note.record.event.id);

    const onlyDocMatching = await gracie.items.list({ topicId: docMatching.id });
    expect(onlyDocMatching.items.map((item) => item.id)).toEqual([todo.record.event.id]);

    await gracie.close();
  });

  it('keeps a kudos filed under a topic reachable by kudos.list(topicId)', async () => {
    const home = tempHome();
    const gracie = await testClient(home, { kind: 'agent', id: 'gracie' });
    await gracie.agents.create({ handle: 'codex', displayName: 'Codex' });
    const topic = await gracie.topics.create({ displayName: 'Great reviews' });
    const kudos = await gracie.kudos.give({
      recipientAgentId: 'codex',
      title: 'Sharp catch',
      reason: 'Found a real bug before merge.',
      topicIds: [topic.id],
    });
    const page = await gracie.kudos.list({ topicId: topic.id });
    expect(page.items.map((item) => item.id)).toEqual([kudos.record.event.id]);
    await gracie.close();
  });

  it('keeps a topic filed on an update, defaulting to what the record already carried', async () => {
    const home = tempHome();
    const gracie = await testClient(home, { kind: 'agent', id: 'gracie' });
    const topic = await gracie.topics.create({ displayName: 'Ongoing' });
    const todo = await gracie.todos.create({
      title: 'Track this',
      topicIds: [topic.id],
    });
    // An update that does not mention topicIds keeps the ones already there.
    const updated = await gracie.todos.update({
      todoId: todo.record.event.id,
      expectedVersion: 1,
      title: 'Track this, renamed',
    });
    expect(updated.current.topicIds).toEqual([topic.id]);
    await gracie.close();
  });
});
