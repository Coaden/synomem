import { describe, it, expect } from 'vitest';
import { tempHome, testClient } from './helpers.js';
describe('lifecycle version preconditions', () => {
  it('serializes competing lifecycle actions, preserves retry results and separates post text versions', async () => {
    const home = tempHome();
    const client = await testClient(home);
    const second = await testClient(home);
    const todo = await client.todos.create({ title: 'One intentional action' });
    const request = {
      todoId: todo.record.event.id,
      expectedVersion: 1,
      idempotencyKey: 'complete-once',
    };
    const results = await Promise.allSettled([
      client.todos.complete(request),
      second.todos.cancel({ todoId: request.todoId, expectedVersion: 1 }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected')
      expect(rejected.reason as unknown).toMatchObject({ code: 'REVISION_CONFLICT' });
    const completed = await client.todos.get(request.todoId);
    expect(completed.lifecycleVersion).toBe(2);
    expect((await client.todos.complete(request)).lifecycleVersion).toBe(2);
    const post = await client.posts.create({ title: 'Notice', body: 'Original' });
    await client.posts.acknowledge({ postId: post.record.event.id, expectedVersion: 1 });
    const edited = await client.posts.update({
      postId: post.record.event.id,
      expectedVersion: 1,
      title: 'Notice',
      body: 'Changed',
    });
    expect(edited.version).toBe(2);
    expect(edited.lifecycleVersion).toBe(3);
    await client.replies.create({ rootId: post.record.event.id, body: 'Comment' });
    expect((await client.posts.get(post.record.event.id)).lifecycleVersion).toBe(3);
    await expect(
      client.posts.archive({ postId: post.record.event.id, expectedVersion: 2 }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await second.close();
    await client.close();
  });
});
