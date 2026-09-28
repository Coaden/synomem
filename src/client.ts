import { actorDirectoryInput } from './actor-directory.js';
import type { ActorDirectoryInput, ActorProfileInput } from './actor-directory.js';
import type { BookmarkInput } from './bookmarks.js';
import type { SearchInput, SearchPage } from './search.js';
import { z } from 'zod';
import type { NotificationInput } from './notifications.js';
import type {
  ReplyCreateInput,
  ReplyDeleteInput,
  ReplyRecord,
  ReactionSetInput,
  ThreadInput,
} from './participation.js';
import {
  threadInputSchema,
  threadSubscriptionSchema,
  replyCreateSchema,
  replyDeleteSchema,
  reactionSetSchema,
} from './schemas.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { cursorFilter } from './cursors.js';
import {
  isRecordAdministrator,
  localOwnerAuthority,
  overseesAgent,
  resolveAuthority,
  sameActor,
} from './policy.js';
import type { ActorRef, AddressableActor, RecordAuthority } from './policy.js';
import { accessSync, constants as fsConstants, existsSync, lstatSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ulid } from 'ulid';
import { resolveHome } from './config.js';
import { asSynomemError, SynomemError } from './errors.js';
import { assertNoSymlinkEscape } from './fs-utils.js';
import {
  escapeMarkdown,
  memoRecordsFromEvents,
  noteRecordsFromEvents,
  postRecordsFromEvents,
  ProjectionManager,
  recordsFromEvents,
  taskRecordsFromEvents,
  todoRecordsFromEvents,
} from './projections.js';
import {
  actorSchema,
  eventSchema,
  overrideTaskDecisionSchema,
  agentLookupSchema,
  bindRuntimeSchema,
  createAgentSchema,
  createPostSchema,
  updatePostSchema,
  createNoteSchema,
  createTaskSchema,
  createTodoSchema,
  changesInputSchema,
  giveKudosSchema,
  itemListInputSchema,
  listInputSchema,
  reviseNoteSchema,
  sendMemoSchema,
  updateTaskSchema,
  updateTodoSchema,
  updateAgentSchema,
  createTopicSchema,
  updateTopicSchema,
  topicListInputSchema,
  topicLookupSchema,
} from './schemas.js';
import { SynomemStorage } from './storage.js';
import type {
  SynomemService,
  SynomemDomainService,
  SynomemServiceCapabilities,
  SynomemServiceInfo,
  ProjectionRebuildResult,
} from './service.js';
import type { SynomemRepository } from './ports/repository.js';
import type { ProjectionWriter } from './ports/projections.js';
import type {
  ActorIdentity,
  AgentDirectoryEntry,
  AgentProfile,
  AgentResolution,
  AgentRuntimeBinding,
  BindRuntimeInput,
  CreateAgentInput,
  CreatePostInput,
  PostRecord,
  PostRoster,
  UpdatePostInput,
  Diagnostic,
  DoctorResult,
  ProjectionStatus,
  GiveKudosInput,
  GiveKudosResult,
  SendMemoInput,
  SendMemoResult,
  MemoRecord,
  CreateNoteInput,
  CreateNoteResult,
  ReviseNoteInput,
  NoteRecord,
  CreateTaskInput,
  CreateTodoInput,
  CreateTodoResult,
  CreateTaskResult,
  UpdateTaskInput,
  UpdateTodoInput,
  TaskRecord,
  OverrideTaskDecisionInput,
  TodoRecord,
  ItemListInput,
  ItemRecord,
  Topic,
  CreateTopicInput,
  UpdateTopicInput,
  TopicListInput,
  TopicResolution,
  ItemSummary,
  ChangesInput,
  KudosChangesInput,
  KudosAcknowledgedEvent,
  SynomemClientOptions,
  SynomemEvent,
  KudosGivenEvent,
  KudosListInput,
  KudosRecord,
  KudosRevokedEvent,
  KudosStats,
  KudosSummary,
  ChangePage,
  Page,
  UpdateAgentInput,
} from './types.js';
export interface SynomemCoreOptions {
  repository: SynomemRepository;
  projectionWriter: ProjectionWriter;
  actor?: ActorIdentity;
  clock?: () => Date;
  idGenerator?: () => string;
  signal?: AbortSignal;
  /** Authority from the trusted adapter; defaults to no administration. */
  authority?: RecordAuthority;
  canWrite?: boolean;
}
export class SynomemCore implements SynomemDomainService {
  /**
   * Mutable because an agent actor is resolved to its canonical identity on
   * init: callers name a handle, events record the opaque ID.
   */
  actor: ActorIdentity;
  private readonly repository: SynomemRepository;
  private readonly projectionWriter: ProjectionWriter;
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;
  private readonly signal?: AbortSignal;
  protected administrative: boolean;
  private writeAllowed: boolean;
  private readonly mutationContext = new AsyncLocalStorage<{
    key?: string;
    projections: Set<string>;
  }>();
  protected authority: RecordAuthority;
  private initialized = false;
  readonly bookmarks = {
    list: (input: BookmarkInput = {}) => {
      const parsed = this.validate(() =>
        z
          .object({
            after: z.string().max(4096).optional(),
            limit: z.number().int().min(1).max(100).optional(),
          })
          .strict()
          .parse(input),
      );
      return this.repository.bookmarks.list(parsed, this.actor);
    },
    has: async (rootId: string) => {
      await this.getItem(rootId);
      return { saved: await this.repository.bookmarks.has(rootId, this.boundRef()) };
    },
    set: async (input: { rootId: string; present: boolean }) => {
      const parsed = this.validate(() =>
        z
          .object({ rootId: z.string().length(26), present: z.boolean() })
          .strict()
          .parse(input),
      );
      if (!this.writeAllowed)
        throw new SynomemError('READ_ONLY', 'This binding cannot change saved records.');
      await this.repository.transaction(async () => {
        await this.resolveActor(this.boundRef(), true);
        await this.getItem(parsed.rootId);
        await this.repository.bookmarks.set(parsed.rootId, this.boundRef(), parsed.present);
      });
      return { saved: parsed.present };
    },
  };
  readonly notifications = {
    list: async (input: NotificationInput = {}) => {
      const parsed = this.validate(() =>
        z
          .object({
            after: z.string().max(4096).optional(),
            limit: z.number().int().min(1).max(100).optional(),
            view: z.enum(['all', 'unread', 'action_required', 'default']).optional(),
          })
          .strict()
          .parse(input),
      );
      if (this.writeAllowed)
        await this.repository.transaction(() => this.repository.notifications.drain());
      const page = await this.repository.notifications.list(parsed, this.actor);
      return page;
    },
    read: (id: string) =>
      this.personalWrite(() => this.repository.notifications.read(id, this.boundRef())),
    dismiss: (id: string) =>
      this.personalWrite(() => this.repository.notifications.dismiss(id, this.boundRef())),
    readThrough: (through: string) =>
      this.personalWrite(() => this.repository.notifications.readThrough(through, this.boundRef())),
  };
  readonly replies = {
    changes: async (input: ThreadInput) => {
      const parsed = this.validate(() => threadInputSchema.parse(input));
      await this.getItem(parsed.rootId);
      return this.repository.participation.changes(parsed, this.actor);
    },
    create: (input: ReplyCreateInput) =>
      this.mutate('replies.create', input, () => this.createReply(input)),
    get: (id: string) => this.getReply(id),
    delete: (input: ReplyDeleteInput) =>
      this.mutate('replies.delete', input, () => this.deleteReply(input)),
  };
  readonly threads = {
    read: async (input: { rootId: string; through: string }) => {
      const parsed = this.validate(() =>
        z
          .object({ rootId: z.string().length(26), through: z.string().max(4096) })
          .strict()
          .parse(input),
      );
      await this.personalWrite(async () => {
        await this.getItem(parsed.rootId);
        await this.repository.participation.read(parsed.rootId, parsed.through, this.boundRef());
      });
    },
    get: async (input: ThreadInput) => {
      const parsed = this.validate(() => threadInputSchema.parse(input));
      await this.getItem(parsed.rootId);
      return this.repository.participation.thread(parsed, this.actor);
    },
    subscription: async (input: { rootId: string; following: boolean; muted: boolean }) => {
      const parsed = this.validate(() => threadSubscriptionSchema.parse(input));
      await this.personalWrite(async () => {
        await this.getItem(parsed.rootId);
        await this.repository.participation.subscription(
          parsed.rootId,
          this.boundRef(),
          parsed.following,
          parsed.muted,
        );
      });
    },
  };
  readonly reactions = {
    set: (input: ReactionSetInput) =>
      this.mutate('reactions.set', input, () => this.setReaction(input)),
    get: async (targetId: string) => {
      await this.reactionRoot(targetId);
      return this.repository.participation.reactions(targetId, this.boundRef());
    },
  };
  private allowedActions(record: ItemRecord): Record<string, boolean> {
    const event = record.event;
    const active =
      record.status !== 'archived' &&
      (!('revocationStatus' in record) || record.revocationStatus !== 'revoked');
    const owner = 'owner' in event ? event.owner : event.actor;
    const participant =
      'assignee' in event &&
      (this.canManage(event.assignee) || this.canManage(event.actor as ActorRef));
    const managed =
      event.type === 'memo.sent'
        ? this.canManage(event.recipient)
        : event.type === 'task.created'
          ? participant
          : this.canManage(owner as ActorRef);
    const flags: Record<string, boolean> = {
      reply: active,
      edit:
        active &&
        managed &&
        ['post.created', 'note.created', 'task.created', 'todo.created'].includes(event.type),
      archive: active && managed && !['task.created', 'kudos.given'].includes(event.type),
      moderateReplies: this.canModerateRoot(record),
      acknowledge:
        event.type === 'kudos.given'
          ? active && sameActor(this.actor, event.recipient) && record.status === 'unacknowledged'
          : event.type === 'post.created'
            ? active &&
              'acknowledgments' in record &&
              !record.acknowledgments.some((entry) => sameActor(this.actor, entry.actor))
            : false,
      withdrawAcknowledgment:
        event.type === 'post.created' &&
        active &&
        'acknowledgments' in record &&
        record.acknowledgments.some((entry) => sameActor(this.actor, entry.actor)),
      readMemo:
        event.type === 'memo.sent' &&
        active &&
        sameActor(this.actor, event.recipient) &&
        record.status === 'unread',
      revoke: event.type === 'kudos.given' && active && this.canManage(event.actor as ActorRef),
    };
    if (event.type === 'task.created')
      Object.assign(flags, {
        accept: record.status === 'assigned' && this.canManage(event.assignee),
        reject: record.status === 'assigned' && this.canManage(event.assignee),
        complete: record.status === 'open' && participant,
        reopen: ['completed', 'canceled'].includes(record.status) && participant,
        cancel: ['assigned', 'open'].includes(record.status) && participant,
        overrideDecision:
          ['open', 'rejected'].includes(record.status) &&
          this.actor.kind === 'human' &&
          (this.administrative ||
            (event.assignee.kind === 'agent' &&
              overseesAgent(this.actor, this.authority, event.assignee.id)) ||
            (event.actor.kind === 'agent' &&
              overseesAgent(this.actor, this.authority, event.actor.id))),
      });
    if (event.type === 'todo.created')
      Object.assign(flags, {
        complete: record.status === 'open' && managed,
        reopen: ['completed', 'canceled'].includes(record.status) && managed,
        cancel: record.status === 'open' && managed,
      });
    return Object.fromEntries(
      Object.entries(flags).map(([name, allowed]) => [name, this.writeAllowed && allowed]),
    );
  }
  private async decorateRecord<T extends ItemRecord>(record: T): Promise<T> {
    return {
      ...record,
      lifecycleVersion: (await this.repository.nextAggregateVersion(record.event.id)) - 1,
      allowedActions: this.allowedActions(record),
    };
  }
  private async getReply(id: string): Promise<ReplyRecord> {
    const reply = await this.repository.participation.getReply(id);
    if (!reply) throw new SynomemError('ITEM_NOT_FOUND', 'Unknown reply.');
    await this.getItem(reply.rootId);
    return reply;
  }
  private async createReply(input: ReplyCreateInput): Promise<ReplyRecord> {
    await this.repository.assertEventCompatibility();
    const parsed = this.validate(() => replyCreateSchema.parse(input));
    const root = await this.getItem(parsed.rootId);
    if (
      root.status === 'archived' ||
      ('revocationStatus' in root && root.revocationStatus === 'revoked')
    )
      throw new SynomemError('MUTATION_FORBIDDEN', 'This root no longer accepts replies.');
    if (parsed.parentId) {
      const parent = await this.getReply(parsed.parentId);
      if (parent.rootId !== parsed.rootId)
        throw new SynomemError('INVALID_INPUT', 'The parent must belong to this thread.');
    }
    const mentions: ActorRef[] = [];
    for (const supplied of parsed.mentions ?? []) {
      const target = await this.resolveActor(supplied, true);
      const ref = { kind: target.kind, id: target.id };
      if (!(await this.repository.canActorReadItem(parsed.rootId, ref)))
        throw new SynomemError('INVALID_INPUT', 'Mention targets must already have access.');
      if (!mentions.some((actor) => sameActor(actor, ref))) mentions.push(ref);
    }
    await this.repository.participation.reserveBudget('reply', this.boundRef(), this.now());
    const id = this.nextId();
    await this.repository.insertEvent({
      ...this.eventBase(id, 1, id),
      type: 'reply.created',
      rootId: parsed.rootId,
      parentId: parsed.parentId ?? null,
      body: parsed.body,
      mentions,
    });
    return this.getReply(id);
  }
  private canModerateRoot(root: ItemRecord): boolean {
    if (this.actor.kind !== 'human') return false;
    const event = root.event;
    if (this.administrative || sameActor(event.actor, this.actor)) return true;
    const targets = [
      event.actor,
      ...('recipient' in event ? [event.recipient] : []),
      ...('owner' in event ? [event.owner] : []),
      ...('assignee' in event ? [event.assignee] : []),
    ];
    return targets.some(
      (ref) => ref.kind === 'agent' && overseesAgent(this.actor, this.authority, ref.id),
    );
  }
  private async deleteReply(input: ReplyDeleteInput): Promise<ReplyRecord> {
    await this.repository.assertEventCompatibility();
    const parsed = this.validate(() => replyDeleteSchema.parse(input));
    const reply = await this.getReply(parsed.replyId);
    const root = await this.getItem(reply.rootId);
    const own = sameActor(reply.author, this.actor);
    if (!own && !this.canModerateRoot(root))
      throw new SynomemError(
        'MUTATION_FORBIDDEN',
        'Only the reply author or an authorized human moderator may delete it.',
      );
    if (!own && !parsed.reason)
      throw new SynomemError('INVALID_INPUT', 'Moderation requires a reason.');
    if (reply.version !== parsed.expectedVersion)
      throw new SynomemError('REVISION_CONFLICT', 'The reply changed. Refresh before deleting.');
    if (reply.deleted) return reply;
    await this.repository.insertEvent({
      ...this.eventBase(reply.id, reply.version + 1),
      ...(!own ? this.intervention(reply.author as ActorRef, parsed.reason) : {}),
      type: 'reply.deleted',
      replyId: reply.id,
      rootId: reply.rootId,
      ...(parsed.reason ? { reason: parsed.reason } : {}),
    });
    return this.getReply(reply.id);
  }
  private async reactionRoot(targetId: string): Promise<string> {
    const reply = await this.repository.participation.getReply(targetId);
    if (reply) {
      await this.getItem(reply.rootId);
      if (reply.deleted)
        throw new SynomemError('MUTATION_FORBIDDEN', 'Deleted replies cannot receive reactions.');
      return reply.rootId;
    }
    await this.getItem(targetId);
    return targetId;
  }
  private async setReaction(input: ReactionSetInput) {
    await this.repository.assertEventCompatibility();
    const parsed = this.validate(() => reactionSetSchema.parse(input));
    const rootId = await this.reactionRoot(parsed.targetId);
    const actor = this.boundRef();
    const present = await this.repository.participation.hasReaction(
      parsed.targetId,
      actor,
      parsed.code,
    );
    if (present !== parsed.present) {
      await this.repository.participation.reserveBudget('reaction', actor, this.now());
      const id = this.nextId();
      await this.repository.insertEvent({
        ...this.eventBase(id, 1, id),
        type: parsed.present ? 'reaction.added' : 'reaction.removed',
        rootId,
        targetId: parsed.targetId,
        code: parsed.code,
      });
    }
    return this.repository.participation.reactions(parsed.targetId, actor);
  }
  async search(input: SearchInput): Promise<SearchPage> {
    this.checkAbort();
    if (!this.repository.search)
      throw new SynomemError('UNSUPPORTED_BACKEND', 'Search is available on hosted workspaces.');
    return this.repository.search(input, this.actor);
  }
  readonly agents = {
    create: (input: CreateAgentInput) => this.createAgent(input),
    update: (id: string, changes: UpdateAgentInput) => this.updateAgent(id, changes),
    get: (idOrAlias: string) => this.getAgent(idOrAlias),
    list: () => this.listAgents(),
    resolve: (query: string) => this.resolveAgent(query),
    archive: (idOrAlias: string) => this.setAgentStatus(idOrAlias, 'archived'),
    restore: (idOrAlias: string) => this.setAgentStatus(idOrAlias, 'active'),
    addAliases: (idOrAlias: string, aliases: string[]) => this.addAgentAliases(idOrAlias, aliases),
    removeAliases: (idOrAlias: string, aliases: string[]) =>
      this.removeAgentAliases(idOrAlias, aliases),
    directory: () => this.agentDirectory(),
    bindings: (idOrAlias: string) => this.listRuntimeBindings(idOrAlias),
    bindRuntime: (input: BindRuntimeInput) => this.bindRuntime(input),
    unbindRuntime: (bindingId: string) => this.unbindRuntime(bindingId),
  };
  readonly topics = {
    create: (input: CreateTopicInput) => this.createTopic(input),
    update: (idOrAlias: string, changes: UpdateTopicInput) =>
      this.updateTopicRecord(idOrAlias, changes),
    get: (idOrAlias: string) => this.getTopicRecord(idOrAlias),
    list: (input: TopicListInput = {}) => this.listTopicsRecord(input),
    resolve: (query: string) => this.resolveTopicRecord(query),
    archive: (idOrAlias: string) => this.setTopicStatus(idOrAlias, 'archived'),
    restore: (idOrAlias: string) => this.setTopicStatus(idOrAlias, 'active'),
  };
  readonly kudos = {
    give: (input: GiveKudosInput) => this.mutate('kudos.give', input, () => this.giveKudos(input)),
    list: (input: KudosListInput = {}) => this.listKudos(input),
    changes: (input: KudosChangesInput = {}) => this.listKudosChanges(input),
    get: (id: string) => this.getKudos(id),
    acknowledge: (input: {
      expectedVersion: number;
      kudosId: string;
      note?: string;
      idempotencyKey?: string;
    }) => this.mutate('kudos.acknowledge', input, () => this.acknowledgeKudos(input)),
    revoke: (input: {
      expectedVersion: number;
      kudosId: string;
      reason: string;
      administrative?: boolean;
      idempotencyKey?: string;
    }) => this.mutate('kudos.revoke', input, () => this.revokeKudos(input)),
  };
  readonly memos = {
    send: (input: SendMemoInput) => this.mutate('memos.send', input, () => this.sendMemo(input)),
    list: (input: Omit<ItemListInput, 'kinds'> = {}) =>
      this.listItems({ ...input, kinds: ['memo'] }),
    get: (id: string) => this.getMemo(id),
    read: (input: { expectedVersion: number; memoId: string; idempotencyKey?: string }) =>
      this.mutate('memos.read', input, () => this.readMemo(input)),
    archive: (input: { expectedVersion: number; memoId: string; idempotencyKey?: string }) =>
      this.mutate('memos.archive', input, () => this.archiveMemo(input)),
  };
  readonly posts = {
    create: (input: CreatePostInput) =>
      this.mutate('posts.create', input, () => this.createPost(input)),
    list: (input: Omit<ItemListInput, 'kinds'> = {}) =>
      this.listItems({ ...input, kinds: ['post'] }),
    get: (id: string) => this.getPost(id),
    update: (input: UpdatePostInput) =>
      this.mutate('posts.update', input, () => this.updatePost(input)),
    archive: (input: {
      expectedVersion: number;
      postId: string;
      reason?: string;
      idempotencyKey?: string;
    }) => this.mutate('posts.archive', input, () => this.archivePost(input)),
    /*
     * Acknowledging is an explicit call and always speaks for the caller alone.
     * There is no bulk form and no acknowledge-on-behalf-of: an acknowledgement
     * is one actor saying "I have seen this", and reading a post must never
     * append one, or the roster stops meaning anything.
     */
    acknowledge: (input: {
      expectedVersion: number;
      postId: string;
      note?: string;
      idempotencyKey?: string;
    }) => this.mutate('posts.acknowledge', input, () => this.acknowledgePost(input)),
    withdrawAcknowledgment: (input: {
      expectedVersion: number;
      postId: string;
      reason?: string;
      idempotencyKey?: string;
    }) =>
      this.mutate('posts.withdrawAcknowledgment', input, () =>
        this.withdrawPostAcknowledgment(input),
      ),
    roster: (postId: string) => this.postRoster(postId),
  };
  readonly notes = {
    create: (input: CreateNoteInput) =>
      this.mutate('notes.create', input, () => this.createNote(input)),
    list: (input: Omit<ItemListInput, 'kinds'> = {}) =>
      this.listItems({ ...input, kinds: ['note'] }),
    get: (id: string) => this.getNote(id),
    revise: (input: ReviseNoteInput) =>
      this.mutate('notes.revise', input, () => this.reviseNote(input)),
    archive: (input: { expectedVersion: number; noteId: string; idempotencyKey?: string }) =>
      this.mutate('notes.archive', input, () => this.archiveNote(input)),
  };
  readonly tasks = {
    overrideDecision: (input: OverrideTaskDecisionInput) =>
      this.mutate('tasks.overrideDecision', input, () => this.overrideTaskDecision(input)),
    create: (input: CreateTaskInput) =>
      this.mutate('tasks.create', input, () => this.createTask(input)),
    list: (input: Omit<ItemListInput, 'kinds'> = {}) =>
      this.listItems({ ...input, kinds: ['task'] }),
    get: (id: string) => this.getTask(id),
    update: (input: UpdateTaskInput) =>
      this.mutate('tasks.update', input, () => this.updateTask(input)),
    // A response is optional when accepting and required when rejecting: a
    // refusal without a reason leaves the assigner unable to act on it.
    accept: (input: {
      expectedVersion: number;
      taskId: string;
      response?: string;
      idempotencyKey?: string;
    }) => this.mutate('tasks.accept', input, () => this.acceptTask(input)),
    reject: (input: {
      expectedVersion: number;
      taskId: string;
      response: string;
      idempotencyKey?: string;
    }) => this.mutate('tasks.reject', input, () => this.rejectTask(input)),
    complete: (input: {
      expectedVersion: number;
      taskId: string;
      note?: string;
      idempotencyKey?: string;
    }) => this.mutate('tasks.complete', input, () => this.completeTask(input)),
    reopen: (input: { expectedVersion: number; taskId: string; idempotencyKey?: string }) =>
      this.mutate('tasks.reopen', input, () => this.reopenTask(input)),
    cancel: (input: {
      expectedVersion: number;
      taskId: string;
      reason?: string;
      idempotencyKey?: string;
    }) => this.mutate('tasks.cancel', input, () => this.cancelTask(input)),
  };
  readonly todos = {
    create: (input: CreateTodoInput) =>
      this.mutate('todos.create', input, () => this.createTodo(input)),
    list: (input: Omit<ItemListInput, 'kinds'> = {}) =>
      this.listItems({ ...input, kinds: ['todo'] }),
    get: (id: string) => this.getTodo(id),
    update: (input: UpdateTodoInput) =>
      this.mutate('todos.update', input, () => this.updateTodo(input)),
    complete: (input: {
      expectedVersion: number;
      todoId: string;
      note?: string;
      idempotencyKey?: string;
    }) => this.mutate('todos.complete', input, () => this.todoTransition(input, 'todo.completed')),
    reopen: (input: { expectedVersion: number; todoId: string; idempotencyKey?: string }) =>
      this.mutate('todos.reopen', input, () => this.todoTransition(input, 'todo.reopened')),
    cancel: (input: {
      expectedVersion: number;
      todoId: string;
      reason?: string;
      idempotencyKey?: string;
    }) => this.mutate('todos.cancel', input, () => this.todoTransition(input, 'todo.canceled')),
    archive: (input: { expectedVersion: number; todoId: string; idempotencyKey?: string }) =>
      this.mutate('todos.archive', input, () => this.todoTransition(input, 'todo.archived')),
  };
  /**
   * Unanswered and overdue discovery.
   *
   * The plan asks for shared work to be observable without treating runtime
   * metadata as a delivery guarantee. These are query states derived from
   * durable events: they say nobody has answered yet, not that the agent was
   * offline, missed a notification, or lacks a capability it claimed.
   */
  readonly discovery = {
    /**
     * Tasks awaiting acceptance, unread memos, and unacknowledged kudos —
     * optionally only those older than a given age or instant.
     */
    unanswered: (
      input: Omit<ItemListInput, 'awaitingResponse' | 'pending'> & {
        olderThanHours?: number;
      } = {},
    ) => {
      const { olderThanHours, awaitingSince, ...rest } = input;
      const since =
        awaitingSince ??
        (olderThanHours !== undefined
          ? new Date(Date.now() - olderThanHours * 3600000).toISOString()
          : undefined);
      return this.listItems({
        ...rest,
        awaitingResponse: true,
        ...(since ? { awaitingSince: since } : {}),
      });
    },
    /** Open work whose deadline has passed. Defaults to "now". */
    overdue: (
      input: Omit<ItemListInput, 'overdueAsOf'> & {
        asOf?: string;
      } = {},
    ) => {
      const { asOf, ...rest } = input;
      return this.listItems({ ...rest, overdueAsOf: asOf ?? new Date().toISOString() });
    },
  };
  readonly items = {
    list: (input: ItemListInput = {}) => this.listItems(input),
    get: (id: string) => this.getItem(id),
    changes: (input: ChangesInput = {}) => this.listItemChanges(input),
  };
  constructor(options: SynomemCoreOptions) {
    try {
      this.actor = actorSchema.parse(options.actor ?? { kind: 'system', id: 'workspace' });
    } catch (error) {
      throw asSynomemError(error);
    }
    this.clock = options.clock ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => ulid(this.clock().getTime()));
    this.signal = options.signal;
    this.authority = resolveAuthority(options.authority);
    this.writeAllowed = options.canWrite ?? true;
    this.administrative = isRecordAdministrator(this.actor, this.authority);
    this.repository = options.repository;
    this.projectionWriter = options.projectionWriter;
  }
  /** Trusted adapters refresh live authority after acquiring the workspace write boundary. Never exposed as a tool/input. */
  setAuthority(authority: RecordAuthority, canWrite = this.writeAllowed): void {
    this.writeAllowed = canWrite;
    this.authority = resolveAuthority(authority);
    this.administrative = isRecordAdministrator(this.actor, this.authority);
    this.repository.setAuthority(this.authority);
  }
  async init(): Promise<void> {
    this.checkAbort();
    if (this.initialized) return;
    await this.repository.init();
    this.initialized = true;
    if (
      this.actor.kind === 'human' &&
      this.authority.mode === 'local-owner' &&
      !(await this.repository.getActor({ kind: 'human', id: this.actor.id }))
    ) {
      await this.repository.transaction(() =>
        this.repository.registerHuman({
          kind: 'human',
          id: this.actor.id,
          handle: this.actor.id,
          displayName: this.actor.displayName ?? this.actor.id,
          status: 'active',
        }),
      );
    }
    /*
     * An agent actor is resolved to its canonical identity here.
     *
     * Callers name a handle because that is what people and harnesses know,
     * but every event must record the opaque ID — otherwise renaming a handle
     * would orphan the history written under the old one. The display name
     * comes from the profile for the same reason a harness cannot assert it on
     * the command line: the stored record is the authority, not the argument.
     *
     * An unresolvable name is left as given rather than rejected, so a system
     * actor can still create the agent that does not exist yet. Writing as an
     * unknown agent is refused later by the checks that already exist.
     */
    if (this.actor.kind === 'agent') {
      const resolved = await this.repository.resolveAgent(this.actor.id);
      if (resolved.match) {
        this.actor = {
          kind: 'agent',
          id: resolved.match.id,
          ...(resolved.match.displayName ? { displayName: resolved.match.displayName } : {}),
        };
      }
    }
  }
  async close(): Promise<void> {
    await this.repository.close();
    this.initialized = false;
  }
  readonly actors = {
    profile: async (input: ActorProfileInput) => {
      const actor = await this.resolveActor(input.target);
      return {
        actor,
        counts: await this.repository.actorCounts(actor, this.actor),
        authored: await this.listItems({
          actorKind: actor.kind,
          actorId: actor.id,
          cursor: input.after,
          limit: input.limit,
        }),
      };
    },
    list: async (input: ActorDirectoryInput = {}) => {
      this.checkAbort();
      return await this.repository.listActors(actorDirectoryInput(input));
    },
    get: (ref: ActorRef) => this.resolveActor(ref),
    registerHuman: async (input: { id: string; handle: string; displayName: string }) => {
      if (this.actor.kind !== 'human' || this.authority.mode !== 'local-owner')
        throw new SynomemError('MUTATION_FORBIDDEN', 'Only the local owner may register a human.');
      const ref = actorSchema.parse({
        kind: 'human',
        id: input.id,
        displayName: input.displayName,
      });
      const handle = agentLookupSchema.parse(input.handle);
      await this.repository.registerHuman({
        kind: 'human',
        id: ref.id,
        handle,
        displayName: input.displayName,
        status: 'active',
      });
      return this.resolveActor({ kind: 'human', id: ref.id });
    },
  };
  private async resolveActor(ref?: ActorRef, requireActive = false): Promise<AddressableActor> {
    if (!ref || (ref.kind !== 'human' && ref.kind !== 'agent'))
      throw new SynomemError('INVALID_INPUT', 'An actor reference is required.');
    const actor = await this.repository.getActor(ref);
    if (!actor) throw new SynomemError('AGENT_NOT_FOUND', `Unknown ${ref.kind}: ${ref.id}`);
    if (requireActive && actor.status !== 'active')
      throw new SynomemError('MUTATION_FORBIDDEN', 'Inactive actors cannot receive new work.');
    return actor;
  }
  private boundRef(): ActorRef {
    if (this.actor.kind === 'system')
      throw new SynomemError('MUTATION_FORBIDDEN', 'A human or agent identity is required.');
    return { kind: this.actor.kind, id: this.actor.id };
  }
  private canManage(ref: ActorRef): boolean {
    return (
      sameActor(ref, this.actor) ||
      this.administrative ||
      (ref.kind === 'agent' && overseesAgent(this.actor, this.authority, ref.id))
    );
  }
  private intervention(ref: ActorRef, reason?: string): Pick<SynomemEvent, 'intervention'> {
    if (this.actor.kind !== 'human' || sameActor(this.actor, ref) || !this.canManage(ref))
      return {};
    const basis =
      this.authority.mode === 'local-owner'
        ? 'local_owner'
        : this.authority.organizationAdministrator
          ? 'organization_admin'
          : this.authority.workspaceAdministrator
            ? 'workspace_admin'
            : 'operator';
    return { intervention: { basis, ...(reason ? { reason } : {}) } };
  }
  private async syncActor(ref: ActorRef): Promise<void> {
    if (ref.kind === 'agent') {
      const context = this.mutationContext.getStore();
      if (context) context.projections.add(ref.id);
      else await this.projectionWriter.syncAgent(ref.id);
    }
  }
  private async normalizeMutation(
    operation: string,
    input: object,
  ): Promise<Record<string, unknown>> {
    const schemas: Record<string, { parse: (value: unknown) => unknown }> = {
      'kudos.give': giveKudosSchema,
      'replies.create': replyCreateSchema,
      'replies.delete': replyDeleteSchema,
      'reactions.set': reactionSetSchema,
      'memos.send': sendMemoSchema,
      'notes.create': createNoteSchema,
      'notes.revise': reviseNoteSchema,
      'posts.create': createPostSchema,
      'posts.update': updatePostSchema,
      'tasks.create': createTaskSchema,
      'tasks.update': updateTaskSchema,
      'tasks.overrideDecision': overrideTaskDecisionSchema,
      'todos.create': createTodoSchema,
      'todos.update': updateTodoSchema,
    };
    const value = this.validate(
      () =>
        schemas[operation]?.parse(
          operation === 'kudos.give'
            ? {
                ...input,
                visibility:
                  (input as GiveKudosInput).visibility ?? this.repository.config.defaultVisibility,
              }
            : input,
        ) ?? input,
    ) as Record<string, unknown>;
    const normalized = { ...value };
    delete normalized.idempotencyKey;
    for (const field of ['recipient', 'owner', 'assignee']) {
      const supplied = normalized[field] as ActorRef | undefined;
      if (supplied) {
        const actor = await this.resolveActor(supplied);
        normalized[field] = { kind: actor.kind, id: actor.id };
      }
    }
    for (const field of [
      'title',
      'body',
      'subject',
      'reason',
      'response',
      'note',
      'details',
      'description',
    ])
      if (typeof normalized[field] === 'string') normalized[field] = normalized[field].trim();
    for (const field of ['tags', 'topicIds'])
      if (
        field in normalized ||
        operation.endsWith('.create') ||
        ['kudos.give', 'memos.send'].includes(operation)
      )
        normalized[field] = [...new Set((normalized[field] ?? []) as string[])].sort();
    if (['kudos.give', 'memos.send', 'tasks.create'].includes(operation))
      normalized.visibility ??= this.repository.config.defaultVisibility;
    if (['notes.create', 'todos.create'].includes(operation)) normalized.owner ??= this.boundRef();
    if (operation === 'tasks.create') normalized.assignee ??= this.boundRef();
    if (['tasks.create', 'todos.create'].includes(operation)) normalized.priority ??= 3;
    if (['replies.create', 'posts.create', 'posts.update'].includes(operation)) {
      if (operation === 'replies.create') normalized.parentId ??= null;
      if (operation === 'posts.update' && normalized.mentions === undefined) return normalized;
      const mentions: ActorRef[] = [];
      for (const supplied of (normalized.mentions ?? []) as ActorRef[]) {
        let actor: AddressableActor;
        try {
          actor = await this.resolveActor(supplied, true);
        } catch (error) {
          if (
            error instanceof SynomemError &&
            ['AGENT_NOT_FOUND', 'INVALID_INPUT'].includes(error.code)
          )
            throw new SynomemError(
              'INVALID_INPUT',
              'Mention targets must be active and accessible.',
            );
          throw error;
        }
        if (!mentions.some((ref) => sameActor(ref, actor)))
          mentions.push({ kind: actor.kind, id: actor.id });
      }
      normalized.mentions = mentions.sort((a, b) =>
        `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`),
      );
    }
    return normalized;
  }
  private async authorizeReceipt(operation: string, result: unknown): Promise<void> {
    if (operation.startsWith('replies.')) {
      const reply = await this.getReply((result as ReplyRecord).id);
      if (
        operation === 'replies.delete' &&
        !sameActor(reply.author, this.actor) &&
        !this.canModerateRoot(await this.getItem(reply.rootId))
      )
        throw new SynomemError('MUTATION_FORBIDDEN', 'Moderation authority was removed.');
      return;
    }
    if (operation === 'reactions.set') {
      await this.reactionRoot((result as { targetId: string }).targetId);
      return;
    }
    const candidate = result as { record?: { event?: { id?: string } }; event?: { id?: string } };
    const id = candidate.record?.event?.id ?? candidate.event?.id;
    if (!id)
      throw new SynomemError(
        'IDEMPOTENCY_EXPIRED',
        'The cached mutation result cannot be reconstructed.',
      );
    const record = await this.getItem(id);
    const event = record.event;
    if (operation.startsWith('notes.')) this.assertNoteOwner(record as NoteRecord);
    else if (operation.startsWith('todos.')) this.assertTodoOwner(record as TodoRecord);
    else if (operation.startsWith('tasks.') && operation !== 'tasks.create') {
      if (['tasks.accept', 'tasks.reject'].includes(operation))
        this.assertTaskAssignee(record as TaskRecord);
      else this.assertTaskParticipant(record as TaskRecord);
      if (
        operation === 'tasks.overrideDecision' &&
        (this.actor.kind !== 'human' ||
          !(
            this.administrative ||
            ((record as TaskRecord).event.assignee.kind === 'agent' &&
              overseesAgent(
                this.actor,
                this.authority,
                (record as TaskRecord).event.assignee.id,
              )) ||
            (event.actor.kind === 'agent' &&
              overseesAgent(this.actor, this.authority, event.actor.id))
          ))
      )
        throw new SynomemError('MUTATION_FORBIDDEN', 'Only a human overseer may override a task.');
    } else if (
      operation.startsWith('posts.') &&
      ['posts.update', 'posts.archive'].includes(operation)
    )
      this.assertPostAuthor(record as PostRecord);
    else if (operation === 'memos.read')
      this.assertRecipient((record as MemoRecord).event.recipient, 'mark this memo read');
    else if (operation === 'memos.archive')
      this.assertRecipient((record as MemoRecord).event.recipient, 'archive this memo', true);
    else if (
      operation === 'kudos.acknowledge' &&
      !sameActor(this.actor, (record as KudosRecord).event.recipient)
    )
      throw new SynomemError(
        'ACKNOWLEDGMENT_FORBIDDEN',
        'Only the recipient may acknowledge kudos.',
      );
    else if (operation === 'kudos.revoke' && !this.canManage(event.actor as ActorRef))
      throw new SynomemError(
        'REVOCATION_FORBIDDEN',
        'Only the author or an authorized overseer may revoke kudos.',
      );
    for (const field of ['recipient', 'owner', 'assignee'] as const)
      if (field in event) {
        const ref = (event as unknown as Record<string, ActorRef>)[field]!;
        await this.syncActor(ref);
      }
  }
  private personalWrite<T>(operation: () => Promise<T>): Promise<T> {
    this.checkAbort();
    if (!this.writeAllowed)
      throw new SynomemError('READ_ONLY', 'This binding cannot change personal state.');
    return this.repository.transaction(async () => {
      await this.resolveActor(this.boundRef(), true);
      return operation();
    });
  }
  private async mutate<T>(operation: string, input: object, action: () => Promise<T>): Promise<T> {
    this.checkAbort();
    if (!this.writeAllowed)
      throw new SynomemError('READ_ONLY', 'This binding cannot write records.');
    const rawKey = (input as { idempotencyKey?: unknown }).idempotencyKey;
    if (
      rawKey !== undefined &&
      (typeof rawKey !== 'string' || !rawKey.trim() || rawKey.trim().length > 200)
    )
      throw new SynomemError('INVALID_INPUT', 'Idempotency keys must contain 1–200 characters.');
    const key = typeof rawKey === 'string' ? rawKey.trim() : undefined;
    const state = { ...(key ? { key } : {}), projections: new Set<string>() };
    const result = await this.mutationContext.run(state, () =>
      this.repository.transaction(async () => {
        if (this.actor.kind !== 'system') await this.resolveActor(this.boundRef(), true);
        const normalized = await this.normalizeMutation(operation, input);
        const requestHash = cursorFilter({ operation, request: normalized });
        const keyHash = key ? cursorFilter(key) : undefined;
        const prior = keyHash
          ? await this.repository.getMutationReceipt(this.actor.kind, this.actor.id, keyHash)
          : undefined;
        if (prior) {
          if (prior.operation !== operation || prior.requestHash !== requestHash)
            throw new SynomemError(
              'IDEMPOTENCY_CONFLICT',
              'This key was already used for a different request.',
            );
          if (!prior.resultJson)
            throw new SynomemError(
              'IDEMPOTENCY_EXPIRED',
              'The original response expired. This request will not execute again.',
            );
          const response = JSON.parse(prior.resultJson) as T;
          await this.authorizeReceipt(operation, response);
          if (operation === 'replies.create' || operation === 'replies.delete') {
            const current = await this.getReply((response as ReplyRecord).id);
            if (current.deleted)
              return { ...response, body: undefined, mentions: undefined, deleted: true };
          }
          if (response && typeof response === 'object' && 'created' in response)
            return { ...response, created: false, deduplicated: true };
          return response;
        }
        if (
          key &&
          (await this.repository.getEventByIdempotency(this.actor.kind, this.actor.id, key))
        )
          throw new SynomemError(
            'IDEMPOTENCY_EXPIRED',
            'The original request receipt is unavailable. This key will not execute again.',
          );
        const lifecycleOperations = new Set([
          'kudos.acknowledge',
          'kudos.revoke',
          'memos.read',
          'memos.archive',
          'posts.archive',
          'posts.acknowledge',
          'posts.withdrawAcknowledgment',
          'notes.archive',
          'tasks.accept',
          'tasks.reject',
          'tasks.complete',
          'tasks.reopen',
          'tasks.cancel',
          'todos.complete',
          'todos.reopen',
          'todos.cancel',
          'todos.archive',
        ]);
        if (lifecycleOperations.has(operation)) {
          const supplied = (input as { expectedVersion?: unknown }).expectedVersion;
          if (!Number.isSafeInteger(supplied) || (supplied as number) < 1)
            throw new SynomemError(
              'INVALID_INPUT',
              'expectedVersion must be the current positive lifecycleVersion.',
            );
          const rootId = normalized[
            (operation.startsWith('kudos.')
              ? 'kudos'
              : operation.split('.')[0]!.replace(/s$/, '')) + 'Id'
          ] as string;
          const current = await this.getItem(rootId);
          await this.authorizeReceipt(operation, current);
          if (current.lifecycleVersion !== supplied)
            throw new SynomemError(
              'REVISION_CONFLICT',
              'The record changed. Refresh before applying this action.',
            );
        }
        const response = await action();
        if (keyHash) {
          const resultJson = JSON.stringify(response);
          if (Buffer.byteLength(resultJson) > 262144)
            throw new SynomemError(
              'INVALID_INPUT',
              'The mutation response exceeds the receipt budget.',
            );
          const eventId = (
            key
              ? await this.repository.getEventByIdempotency(this.actor.kind, this.actor.id, key)
              : undefined
          )?.id;
          await this.repository.insertMutationReceipt(this.actor.kind, this.actor.id, keyHash, {
            operation,
            requestHash,
            resultJson,
            ...(eventId ? { eventId } : {}),
            createdAt: this.now(),
          });
        }
        return response;
      }),
    );
    for (const id of state.projections) await this.projectionWriter.syncAgent(id);
    return result;
  }
  private now(): string {
    return this.clock().toISOString();
  }
  private nextId(): string {
    return this.idGenerator();
  }
  private eventBase(aggregateId: string, aggregateVersion: number, id = this.nextId()) {
    return {
      schemaVersion: 2 as const,
      ...(this.mutationContext.getStore()?.key
        ? { idempotencyKey: this.mutationContext.getStore()!.key }
        : {}),
      id,
      workspaceId: this.repository.config.workspaceId,
      aggregateId,
      aggregateVersion,
      createdAt: this.now(),
      actor: this.actor,
    };
  }
  protected checkAbort(): void {
    this.signal?.throwIfAborted();
  }
  private validate<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      throw asSynomemError(error);
    }
  }
  private async createAgent(input: CreateAgentInput): Promise<AgentProfile> {
    this.checkAbort();
    await this.repository.assertEventCompatibility();
    const parsed = this.validate(() => createAgentSchema.parse(input));
    if (await this.repository.getAgent(parsed.handle)) {
      throw new SynomemError('AGENT_EXISTS', `Agent or alias already exists: ${parsed.handle}`);
    }
    const aliases = [...new Set(parsed.aliases ?? [])].sort();
    if (aliases.includes(parsed.handle)) {
      throw new SynomemError('ALIAS_CONFLICT', 'An agent cannot use its own handle as an alias.');
    }
    for (const alias of aliases) {
      if (await this.repository.getAgent(alias)) {
        throw new SynomemError('ALIAS_CONFLICT', `Alias already belongs to an agent: ${alias}`);
      }
    }
    /*
     * The canonical ID is generated here and never supplied by the caller.
     * Every event references it permanently, so it has to be free of meaning:
     * a caller that could choose it could choose one that collides with an
     * archived agent's history, and a meaningful ID becomes a handle nobody can
     * rename.
     */
    const profile: AgentProfile = {
      id: this.nextId(),
      handle: parsed.handle,
      status: 'active',
      displayName: parsed.displayName,
      ...(aliases.length ? { aliases } : {}),
      ...(parsed.description !== undefined ? { description: parsed.description } : {}),
      createdAt: this.now(),
      ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
    };
    const event: SynomemEvent = {
      ...this.eventBase(profile.id, 1),
      type: 'agent.created',
      agent: profile,
    };
    await this.repository.transaction(async () => {
      await this.repository.insertAgent(profile);
      await this.repository.insertEvent(event);
    });
    await this.projectionWriter.syncAgent(profile.id);
    return profile;
  }
  private async updateAgent(idOrAlias: string, changes: UpdateAgentInput): Promise<AgentProfile> {
    this.checkAbort();
    await this.repository.assertEventCompatibility();
    this.validate(() => agentLookupSchema.parse(idOrAlias));
    const parsed = this.validate(() => updateAgentSchema.parse(changes));
    const existing = await this.repository.getAgent(idOrAlias);
    if (!existing) throw new SynomemError('AGENT_NOT_FOUND', `Unknown agent: ${idOrAlias}`);
    const aliases = parsed.aliases ? [...new Set(parsed.aliases)].sort() : existing.aliases;
    const handle = parsed.handle ?? existing.handle;
    if (aliases?.includes(handle)) {
      throw new SynomemError('ALIAS_CONFLICT', 'An agent cannot use its own handle as an alias.');
    }
    // Renaming the handle is allowed and is why the canonical ID exists, but a
    // handle another agent already answers to is still refused.
    if (parsed.handle && parsed.handle !== existing.handle) {
      const owner = await this.repository.getAgent(parsed.handle);
      if (owner && owner.id !== existing.id) {
        throw new SynomemError(
          'ALIAS_CONFLICT',
          `Handle already belongs to ${owner.id}: ${parsed.handle}`,
        );
      }
    }
    for (const alias of aliases ?? []) {
      const owner = await this.repository.getAgent(alias);
      if (owner && owner.id !== existing.id) {
        throw new SynomemError('ALIAS_CONFLICT', `Alias already belongs to ${owner.id}: ${alias}`);
      }
    }
    const updated: AgentProfile = {
      ...existing,
      ...parsed,
      ...(aliases?.length ? { aliases } : { aliases: undefined }),
    };
    const changesForEvent = { ...parsed, ...(parsed.aliases ? { aliases } : {}) };
    await this.repository.transaction(async () => {
      const event: SynomemEvent = {
        ...this.eventBase(existing.id, await this.repository.nextAggregateVersion(existing.id)),
        type: 'agent.updated',
        agentId: existing.id,
        changes: changesForEvent,
      };
      await this.repository.updateAgent(updated, event.createdAt);
      await this.repository.insertEvent(event);
    });
    /*
     * Projections are named by handle, so a rename has to move the directory
     * before it is regenerated. Otherwise the generated files appear under the
     * new handle and `NOTES.md` -- which belongs to the reader and is never
     * deleted -- is left stranded under the old one.
     */
    if (existing.handle !== updated.handle && this.projectionWriter.renameAgentDirectory) {
      await this.projectionWriter.renameAgentDirectory(existing.handle, updated.handle);
    }
    await this.projectionWriter.syncAgent(updated.id);
    return updated;
  }
  /**
   * Archiving stops an agent acting without erasing it.
   *
   * Events reference the actor permanently, so deleting an agent would leave
   * history pointing at nothing. Archived agents keep their records and their
   * handle, and can be restored.
   */
  private async setAgentStatus(
    idOrAlias: string,
    status: 'active' | 'archived',
  ): Promise<AgentProfile> {
    this.checkAbort();
    await this.repository.assertEventCompatibility();
    this.validate(() => agentLookupSchema.parse(idOrAlias));
    const existing = await this.repository.getAgent(idOrAlias);
    if (!existing) throw new SynomemError('AGENT_NOT_FOUND', `Unknown agent: ${idOrAlias}`);
    if (existing.status === status) return existing;
    const updated: AgentProfile = { ...existing, status };
    await this.repository.transaction(async () => {
      const event: SynomemEvent = {
        ...this.eventBase(existing.id, await this.repository.nextAggregateVersion(existing.id)),
        type: 'agent.updated',
        agentId: existing.id,
        changes: { status },
      };
      await this.repository.updateAgent(updated, event.createdAt);
      await this.repository.insertEvent(event);
    });
    await this.projectionWriter.syncAgent(updated.id);
    return updated;
  }
  /** Adds aliases without disturbing the ones already there. */
  private async addAgentAliases(idOrAlias: string, add: string[]): Promise<AgentProfile> {
    const existing = await this.getAgent(idOrAlias);
    const merged = [...new Set([...(existing.aliases ?? []), ...add])].sort();
    return await this.updateAgent(existing.id, { aliases: merged });
  }
  private async removeAgentAliases(idOrAlias: string, remove: string[]): Promise<AgentProfile> {
    const existing = await this.getAgent(idOrAlias);
    const drop = new Set(remove.map((alias) => alias.trim().toLowerCase()));
    const kept = (existing.aliases ?? []).filter((alias) => !drop.has(alias));
    return await this.updateAgent(existing.id, { aliases: kept });
  }
  private async getAgent(idOrAlias: string): Promise<AgentProfile> {
    this.checkAbort();
    this.validate(() => agentLookupSchema.parse(idOrAlias));
    const profile = await this.repository.getAgent(idOrAlias);
    if (!profile) throw new SynomemError('AGENT_NOT_FOUND', `Unknown agent: ${idOrAlias}`);
    return profile;
  }
  private async listAgents(): Promise<AgentProfile[]> {
    this.checkAbort();
    return await this.repository.listAgents();
  }
  /**
   * Resolves a name without ever choosing between equally valid answers.
   *
   * Callers that want a single agent should treat an empty `match` as a
   * question for the user, not as "not found": `candidates` distinguishes the
   * two cases.
   */
  private async resolveAgent(query: string): Promise<AgentResolution> {
    this.checkAbort();
    const trimmed = query.trim();
    if (!trimmed) throw new SynomemError('INVALID_INPUT', 'A lookup name is required.');
    const resolved = await this.repository.resolveAgent(trimmed);
    return {
      query: trimmed,
      ...(resolved.match ? { match: resolved.match } : {}),
      candidates: resolved.candidates,
    };
  }
  private async agentDirectory(): Promise<AgentDirectoryEntry[]> {
    this.checkAbort();
    const profiles = await this.repository.listAgents();
    const entries: AgentDirectoryEntry[] = [];
    for (const profile of profiles) {
      entries.push({
        profile,
        runtimeBindings: await this.repository.listRuntimeBindings(profile.id),
      });
    }
    return entries;
  }
  private async listRuntimeBindings(idOrAlias: string): Promise<AgentRuntimeBinding[]> {
    const profile = await this.getAgent(idOrAlias);
    return await this.repository.listRuntimeBindings(profile.id);
  }
  /**
   * Records where an agent runs. Re-binding the same runtime and profile
   * updates the claim in place rather than accumulating duplicates, because a
   * reinstall is the same agent in the same place, not a second one.
   */
  private async bindRuntime(input: BindRuntimeInput): Promise<AgentRuntimeBinding> {
    this.checkAbort();
    const parsed = this.validate(() => bindRuntimeSchema.parse(input));
    const profile = await this.getAgent(parsed.agentId);
    await this.repository.bindRuntime({
      id: this.idGenerator(),
      agentId: profile.id,
      ...(parsed.installationId !== undefined ? { installationId: parsed.installationId } : {}),
      runtime: parsed.runtime,
      ...(parsed.profile !== undefined ? { profile: parsed.profile } : {}),
      ...(parsed.capabilities !== undefined ? { capabilities: parsed.capabilities } : {}),
      boundAt: this.now(),
    });
    const bindings = await this.repository.listRuntimeBindings(profile.id);
    const binding = bindings.find(
      (candidate) =>
        candidate.runtime === parsed.runtime &&
        (candidate.profile ?? '') === (parsed.profile ?? '') &&
        (candidate.installationId ?? '') === (parsed.installationId ?? ''),
    );
    if (!binding) throw new SynomemError('INTERNAL_ERROR', 'Runtime binding was not persisted.');
    return binding;
  }
  private async unbindRuntime(bindingId: string): Promise<boolean> {
    this.checkAbort();
    return await this.repository.unbindRuntime(bindingId);
  }
  /* ---------------------------------------------------------------- topics *
   * A topic is a controlled, reusable subject a record can be filed under —
   * one canonical display name and a set of aliases, so a stable "Synomem"
   * page survives a rename without retagging every record that carries it.
   * Any actor may create one freely, the same as a tag; only the creator or
   * an administrator renames or archives it, matching how an agent's own
   * identity is managed.
   */
  private async createTopic(input: CreateTopicInput): Promise<Topic> {
    this.checkAbort();
    await this.repository.assertEventCompatibility();
    const parsed = this.validate(() => createTopicSchema.parse(input));
    if (await this.repository.getTopic(parsed.displayName)) {
      throw new SynomemError(
        'TOPIC_EXISTS',
        `Topic or alias already exists: ${parsed.displayName}`,
      );
    }
    const aliases = [...new Set(parsed.aliases ?? [])].sort();
    for (const alias of aliases) {
      if (await this.repository.getTopic(alias)) {
        throw new SynomemError('ALIAS_CONFLICT', `Alias already belongs to a topic: ${alias}`);
      }
    }
    const topic: Topic = {
      id: this.nextId(),
      displayName: parsed.displayName,
      ...(aliases.length ? { aliases } : {}),
      status: 'active',
      createdAt: this.now(),
    };
    const event: SynomemEvent = {
      ...this.eventBase(topic.id, 1),
      type: 'topic.created',
      topic,
    };
    await this.repository.transaction(async () => {
      await this.repository.insertTopic(topic);
      await this.repository.insertEvent(event);
    });
    return topic;
  }
  private async updateTopicRecord(idOrAlias: string, changes: UpdateTopicInput): Promise<Topic> {
    this.checkAbort();
    await this.repository.assertEventCompatibility();
    this.validate(() => topicLookupSchema.parse(idOrAlias));
    const parsed = this.validate(() => updateTopicSchema.parse(changes));
    const existing = await this.repository.getTopic(idOrAlias);
    if (!existing) throw new SynomemError('TOPIC_NOT_FOUND', `Unknown topic: ${idOrAlias}`);
    if (parsed.displayName && parsed.displayName !== existing.displayName) {
      const owner = await this.repository.getTopic(parsed.displayName);
      if (owner && owner.id !== existing.id) {
        throw new SynomemError(
          'ALIAS_CONFLICT',
          `Display name already belongs to ${owner.id}: ${parsed.displayName}`,
        );
      }
    }
    const aliases = parsed.aliases ? [...new Set(parsed.aliases)].sort() : existing.aliases;
    for (const alias of aliases ?? []) {
      const owner = await this.repository.getTopic(alias);
      if (owner && owner.id !== existing.id) {
        throw new SynomemError('ALIAS_CONFLICT', `Alias already belongs to ${owner.id}: ${alias}`);
      }
    }
    const updated: Topic = {
      ...existing,
      ...parsed,
      ...(aliases?.length ? { aliases } : { aliases: undefined }),
    };
    const changesForEvent = { ...parsed, ...(parsed.aliases ? { aliases } : {}) };
    await this.repository.transaction(async () => {
      const event: SynomemEvent = {
        ...this.eventBase(existing.id, await this.repository.nextAggregateVersion(existing.id)),
        type: 'topic.updated',
        topicId: existing.id,
        changes: changesForEvent,
      };
      await this.repository.updateTopic(updated, event.createdAt);
      await this.repository.insertEvent(event);
    });
    return updated;
  }
  private async setTopicStatus(idOrAlias: string, status: 'active' | 'archived'): Promise<Topic> {
    this.checkAbort();
    await this.repository.assertEventCompatibility();
    this.validate(() => topicLookupSchema.parse(idOrAlias));
    const existing = await this.repository.getTopic(idOrAlias);
    if (!existing) throw new SynomemError('TOPIC_NOT_FOUND', `Unknown topic: ${idOrAlias}`);
    if (existing.status === status) return existing;
    const updated: Topic = { ...existing, status };
    await this.repository.transaction(async () => {
      const event: SynomemEvent = {
        ...this.eventBase(existing.id, await this.repository.nextAggregateVersion(existing.id)),
        type: 'topic.updated',
        topicId: existing.id,
        changes: { status },
      };
      await this.repository.updateTopic(updated, event.createdAt);
      await this.repository.insertEvent(event);
    });
    return updated;
  }
  private async getTopicRecord(idOrAlias: string): Promise<Topic> {
    this.checkAbort();
    this.validate(() => topicLookupSchema.parse(idOrAlias));
    const topic = await this.repository.getTopic(idOrAlias);
    if (!topic) throw new SynomemError('TOPIC_NOT_FOUND', `Unknown topic: ${idOrAlias}`);
    return topic;
  }
  private async listTopicsRecord(input: TopicListInput): Promise<Topic[]> {
    this.checkAbort();
    const parsed = this.validate(() => topicListInputSchema.parse(input));
    return await this.repository.listTopics(parsed.status);
  }
  private async resolveTopicRecord(query: string): Promise<TopicResolution> {
    this.checkAbort();
    const trimmed = this.validate(() => topicLookupSchema.parse(query));
    const resolved = await this.repository.resolveTopic(trimmed);
    return { query: trimmed, ...resolved };
  }
  /**
   * Every topic in `topicIds` must already exist and be active — a record
   * cannot be filed under a subject that does not exist, or one somebody
   * archived precisely to stop new records collecting under it.
   */
  private async assertTopicsExist(topicIds: string[] | undefined): Promise<void> {
    for (const topicId of topicIds ?? []) {
      const topic = await this.repository.getTopic(topicId);
      if (!topic || topic.status !== 'active') {
        throw new SynomemError('TOPIC_NOT_FOUND', `Unknown or archived topic: ${topicId}`);
      }
    }
  }
  private async giveKudos(input: GiveKudosInput): Promise<GiveKudosResult> {
    this.checkAbort();
    await this.repository.assertEventCompatibility();
    const parsed = this.validate(() =>
      giveKudosSchema.parse({
        ...input,
        visibility: input.visibility ?? this.repository.config.defaultVisibility,
      }),
    );
    await this.assertTopicsExist(parsed.topicIds);
    const recipient = await this.resolveActor(parsed.recipient, true);
    if (!recipient) {
      throw new SynomemError('AGENT_NOT_FOUND', `Unknown recipient: ${parsed.recipient?.id}`);
    }
    if (
      !this.repository.config.allowSelfAwards &&
      this.actor.kind !== 'human' &&
      sameActor(this.actor, recipient)
    ) {
      throw new SynomemError(
        'SELF_AWARD_FORBIDDEN',
        'Non-human actors cannot award kudos to a matching agent identity.',
      );
    }
    const outcome = await this.repository.transaction(async () => {
      const prior = await this.priorMutation(parsed.idempotencyKey, 'kudos.given');
      if (prior?.type === 'kudos.given') return { event: prior, created: false };
      const id = this.nextId();
      const event: KudosGivenEvent = {
        ...this.eventBase(id, 1, id),
        type: 'kudos.given',
        recipient: { kind: recipient.kind, id: recipient.id },
        recipientDisplayName: recipient.displayName,
        title: parsed.title,
        reason: parsed.reason,
        visibility: parsed.visibility,
        ...(parsed.evidence ? { evidence: parsed.evidence } : {}),
        ...(parsed.tags ? { tags: [...new Set(parsed.tags)].sort() } : {}),
        ...(parsed.topicIds ? { topicIds: [...new Set(parsed.topicIds)].sort() } : {}),
        ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
        ...(parsed.source ? { source: parsed.source } : {}),
        ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
      };
      await this.repository.insertEvent(event);
      return { event, created: true };
    });
    if (outcome.created) await this.syncActor(recipient);
    const record = await this.getKudosRecord(outcome.event.id);
    return { record, created: outcome.created, deduplicated: !outcome.created };
  }
  private async getKudosRecord(id: string): Promise<KudosRecord> {
    await this.requireVisibleItem(id, 'kudos');
    const record = recordsFromEvents(await this.repository.getReadableSynomemEvents(id))[0];
    if (!record) throw new SynomemError('KUDOS_NOT_FOUND', `Unknown kudos: ${id}`);
    return this.decorateRecord(record);
  }
  private async getKudos(id: string): Promise<KudosRecord> {
    this.checkAbort();
    return await this.getKudosRecord(id);
  }
  private async listKudos(input: KudosListInput): Promise<Page<KudosSummary>> {
    this.checkAbort();
    const filters = this.validate(() => listInputSchema.parse(input));
    const recipient = filters.recipient?.id
      ? await this.resolveActor(filters.recipient)
      : undefined;
    if (filters.recipient?.id && !recipient) {
      throw new SynomemError('AGENT_NOT_FOUND', `Unknown agent: ${filters.recipient?.id}`);
    }
    return await this.repository.listKudosSummaries(
      {
        ...filters,
        ...(recipient ? { recipient: { kind: recipient.kind, id: recipient.id } } : {}),
      },
      this.actor,
    );
  }
  private async listKudosChanges(input: KudosChangesInput): Promise<ChangePage> {
    this.checkAbort();
    const parsed = this.validate(() => changesInputSchema.parse(input));
    return await this.repository.listKudosChanges(parsed.after, parsed.limit, this.actor);
  }
  private async acknowledgeKudos(input: {
    expectedVersion: number;
    kudosId: string;
    note?: string;
  }): Promise<KudosRecord> {
    this.checkAbort();
    await this.repository.assertEventCompatibility();
    if (input.note !== undefined && (input.note.trim().length < 1 || input.note.length > 2000)) {
      throw new SynomemError('INVALID_INPUT', 'Acknowledgment notes must be 1–2000 characters.');
    }
    const record = await this.getKudosRecord(input.kudosId);
    if (record.acknowledgment) return record;
    if (record.revocation)
      throw new SynomemError('INVALID_INPUT', 'Revoked kudos cannot be acknowledged.');
    const isRecipient = sameActor(this.actor, record.event.recipient);
    if (!isRecipient) {
      throw new SynomemError(
        'ACKNOWLEDGMENT_FORBIDDEN',
        'Only the recipient may acknowledge kudos.',
      );
    }
    const event: KudosAcknowledgedEvent = {
      ...this.eventBase(record.event.id, 2),
      type: 'kudos.acknowledged',
      kudosId: record.event.id,
      recipient: record.event.recipient,
      ...(input.note ? { note: input.note.trim() } : {}),
    };
    await this.repository.transaction(() => this.repository.insertEvent(event));
    await this.syncActor(record.event.recipient);
    return await this.getKudosRecord(input.kudosId);
  }
  private async revokeKudos(input: {
    expectedVersion: number;
    kudosId: string;
    reason: string;
    administrative?: boolean;
  }): Promise<KudosRecord> {
    this.checkAbort();
    await this.repository.assertEventCompatibility();
    const reason = input.reason.trim();
    if (!reason || reason.length > 2000) {
      throw new SynomemError('INVALID_INPUT', 'Revocation reasons must be 1–2000 characters.');
    }
    const record = await this.getKudosRecord(input.kudosId);
    if (record.revocation) return record;
    const isOriginalActor =
      record.event.actor.kind === this.actor.kind && record.event.actor.id === this.actor.id;
    if (input.administrative === true && !this.administrative) {
      throw new SynomemError(
        'REVOCATION_FORBIDDEN',
        'Only an administrator may request an administrative revocation.',
      );
    }
    const administrative = this.administrative && !isOriginalActor;
    if (!this.canManage(record.event.actor as ActorRef)) {
      throw new SynomemError(
        'REVOCATION_FORBIDDEN',
        'Only the author or an authorized overseer may revoke kudos.',
      );
    }
    const event: KudosRevokedEvent = {
      ...this.eventBase(record.event.id, record.acknowledgment ? 3 : 2),
      ...this.intervention(record.event.actor as ActorRef, reason),
      type: 'kudos.revoked',
      kudosId: record.event.id,
      reason,
      mode: administrative && !isOriginalActor ? 'administrative' : 'actor-requested',
    };
    await this.repository.transaction(() => this.repository.insertEvent(event));
    await this.syncActor(record.event.recipient);
    return await this.getKudosRecord(input.kudosId);
  }
  private async priorMutation(
    idempotencyKey: string | undefined,
    expectedType: SynomemEvent['type'],
  ) {
    if (!idempotencyKey) return undefined;
    const prior = await this.repository.getEventByIdempotency(
      this.actor.kind,
      this.actor.id,
      idempotencyKey,
    );
    if (prior && prior.type !== expectedType) {
      throw new SynomemError(
        'IDEMPOTENCY_CONFLICT',
        `Idempotency key was already used for ${prior.type}.`,
      );
    }
    return prior;
  }
  private canViewItem(summary: ItemSummary): boolean {
    if (summary.kind === 'note' || summary.kind === 'todo')
      return !!summary.owner && this.canManage(summary.owner);
    return (
      this.administrative ||
      summary.visibility !== 'private' ||
      [summary.actor, summary.recipient, summary.assignee].some(
        (ref) =>
          !!ref &&
          (sameActor(ref, this.actor) ||
            (ref.kind === 'agent' && overseesAgent(this.actor, this.authority, ref.id))),
      )
    );
  }
  private async requireVisibleItem(id: string, kind: ItemSummary['kind']): Promise<ItemSummary> {
    const summary = await this.repository.getItemSummary(id);
    if (!summary || summary.kind !== kind) {
      const code =
        kind === 'memo'
          ? 'MEMO_NOT_FOUND'
          : kind === 'note'
            ? 'NOTE_NOT_FOUND'
            : kind === 'task'
              ? 'TODO_NOT_FOUND'
              : 'KUDOS_NOT_FOUND';
      throw new SynomemError(code, `Unknown ${kind}: ${id}`);
    }
    if (!this.canViewItem(summary)) {
      throw new SynomemError(
        'POLICY_FORBIDDEN',
        `This ${kind} is not visible to the configured actor.`,
      );
    }
    return summary;
  }
  private async getMemoRecord(id: string): Promise<MemoRecord> {
    await this.requireVisibleItem(id, 'memo');
    const record = memoRecordsFromEvents(await this.repository.getReadableItemEvents(id))[0];
    if (!record) throw new SynomemError('MEMO_NOT_FOUND', `Unknown memo: ${id}`);
    return this.decorateRecord(record);
  }
  private async getMemo(id: string): Promise<MemoRecord> {
    this.checkAbort();
    return await this.getMemoRecord(id);
  }
  private async sendMemo(input: SendMemoInput): Promise<SendMemoResult> {
    this.checkAbort();
    await this.repository.assertEventCompatibility();
    const parsed = this.validate(() => sendMemoSchema.parse(input));
    await this.assertTopicsExist(parsed.topicIds);
    const recipient = await this.resolveActor(parsed.recipient, true);
    if (!recipient)
      throw new SynomemError('AGENT_NOT_FOUND', `Unknown recipient: ${parsed.recipient?.id}`);
    const outcome = await this.repository.transaction(async () => {
      const prior = await this.priorMutation(parsed.idempotencyKey, 'memo.sent');
      if (prior?.type === 'memo.sent') return { id: prior.id, created: false };
      const id = this.nextId();
      const event: SynomemEvent = {
        ...this.eventBase(id, 1, id),
        type: 'memo.sent',
        recipient: { kind: recipient.kind, id: recipient.id },
        recipientDisplayName: recipient.displayName,
        subject: parsed.subject,
        body: parsed.body,
        tags: [...new Set(parsed.tags ?? [])].sort(),
        topicIds: [...new Set(parsed.topicIds ?? [])].sort(),
        visibility: parsed.visibility ?? this.repository.config.defaultVisibility,
        ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
        ...(parsed.source ? { source: parsed.source } : {}),
        ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
      };
      await this.repository.insertEvent(event);
      return { id, created: true };
    });
    if (outcome.created) await this.syncActor(recipient);
    return {
      record: await this.getMemoRecord(outcome.id),
      created: outcome.created,
      deduplicated: !outcome.created,
    };
  }
  private assertRecipient(recipient: ActorRef, operation: string, oversight = false): void {
    if (!(oversight ? this.canManage(recipient) : sameActor(this.actor, recipient)))
      throw new SynomemError('MUTATION_FORBIDDEN', `Only the recipient may ${operation}.`);
  }
  private async readMemo(input: {
    expectedVersion: number;
    memoId: string;
    idempotencyKey?: string;
  }): Promise<MemoRecord> {
    const record = await this.getMemoRecord(input.memoId);
    this.assertRecipient(record.event.recipient, 'mark this memo read');
    if (record.read) return record;
    await this.repository.transaction(async () => {
      const prior = await this.priorMutation(input.idempotencyKey, 'memo.read');
      if (prior) return;
      const event: SynomemEvent = {
        ...this.eventBase(
          record.event.id,
          await this.repository.nextAggregateVersion(record.event.id),
        ),
        type: 'memo.read',
        memoId: record.event.id,
        recipient: record.event.recipient,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      };
      await this.repository.insertEvent(event);
    });
    await this.syncActor(record.event.recipient);
    return await this.getMemoRecord(input.memoId);
  }
  private async archiveMemo(input: {
    expectedVersion: number;
    memoId: string;
    idempotencyKey?: string;
  }): Promise<MemoRecord> {
    const record = await this.getMemoRecord(input.memoId);
    this.assertRecipient(record.event.recipient, 'archive this memo', true);
    if (record.archived) return record;
    await this.repository.transaction(async () => {
      const prior = await this.priorMutation(input.idempotencyKey, 'memo.archived');
      if (prior) return;
      const event: SynomemEvent = {
        ...this.intervention(record.event.recipient),
        ...this.eventBase(
          record.event.id,
          await this.repository.nextAggregateVersion(record.event.id),
        ),
        type: 'memo.archived',
        memoId: record.event.id,
        recipient: record.event.recipient,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      };
      await this.repository.insertEvent(event);
    });
    await this.syncActor(record.event.recipient);
    return await this.getMemoRecord(input.memoId);
  }
  private async getPostRecord(id: string): Promise<PostRecord> {
    await this.requireVisibleItem(id, 'post');
    const record = postRecordsFromEvents(await this.repository.getReadableItemEvents(id))[0];
    if (!record) throw new SynomemError('ITEM_NOT_FOUND', `Unknown post: ${id}`);
    return this.decorateRecord(record);
  }
  private async getPost(id: string): Promise<PostRecord> {
    this.checkAbort();
    return await this.getPostRecord(id);
  }
  private async canonicalPostMentions(input: ActorRef[]): Promise<ActorRef[]> {
    const mentions: ActorRef[] = [];
    for (const reference of input) {
      const actor = await this.resolveActor(reference, true);
      const ref = { kind: actor.kind, id: actor.id };
      if (!mentions.some((mention) => sameActor(mention, ref))) mentions.push(ref);
    }
    return mentions.sort((left, right) =>
      `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`),
    );
  }
  private async createPost(input: CreatePostInput): Promise<{
    record: PostRecord;
    created: boolean;
    deduplicated: boolean;
  }> {
    this.checkAbort();
    await this.repository.assertEventCompatibility();
    const parsed = this.validate(() => createPostSchema.parse(input));
    await this.assertTopicsExist(parsed.topicIds);
    const mentions = parsed.mentions
      ? await this.canonicalPostMentions(parsed.mentions)
      : undefined;
    const outcome = await this.repository.transaction(async () => {
      const prior = await this.priorMutation(parsed.idempotencyKey, 'post.created');
      if (prior?.type === 'post.created') return { id: prior.id, created: false };
      const id = this.nextId();
      const event: SynomemEvent = {
        ...this.eventBase(id, 1, id),
        type: 'post.created',
        title: parsed.title,
        body: parsed.body,
        mentions: mentions ?? [],
        tags: [...new Set(parsed.tags ?? [])].sort(),
        topicIds: [...new Set(parsed.topicIds ?? [])].sort(),
        ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
        ...(parsed.source ? { source: parsed.source } : {}),
        ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
      };
      await this.repository.insertEvent(event);
      return { id, created: true };
    });
    return {
      record: await this.getPostRecord(outcome.id),
      created: outcome.created,
      deduplicated: !outcome.created,
    };
  }
  /** Only the author edits a post. Everyone else responds to it. */
  private assertPostAuthor(record: PostRecord): void {
    if (
      this.administrative ||
      (record.event.actor.kind === 'agent' &&
        overseesAgent(this.actor, this.authority, record.event.actor.id))
    )
      return;
    if (record.event.actor.id !== this.actor.id || record.event.actor.kind !== this.actor.kind) {
      throw new SynomemError('MUTATION_FORBIDDEN', 'Only the author can change a post.');
    }
  }
  private async updatePost(input: UpdatePostInput): Promise<PostRecord> {
    this.checkAbort();
    const parsed = this.validate(() => updatePostSchema.parse(input));
    await this.assertTopicsExist(parsed.topicIds);
    const mentions = parsed.mentions
      ? await this.canonicalPostMentions(parsed.mentions)
      : undefined;
    const record = await this.getPostRecord(parsed.postId);
    this.assertPostAuthor(record);
    if (record.status === 'archived') {
      throw new SynomemError('MUTATION_FORBIDDEN', 'An archived post cannot be edited.');
    }
    if (record.version !== parsed.expectedVersion) {
      throw new SynomemError(
        'REVISION_CONFLICT',
        `Post ${parsed.postId} is at version ${record.version}.`,
      );
    }
    await this.repository.transaction(async () => {
      const event: SynomemEvent = {
        ...this.intervention(record.event.actor as ActorRef),
        ...this.eventBase(parsed.postId, await this.repository.nextAggregateVersion(parsed.postId)),
        type: 'post.edited',
        postId: parsed.postId,
        title: parsed.title ?? record.title,
        body: parsed.body ?? record.body,
        mentions: mentions ?? record.mentions ?? [],
        tags: [...new Set(parsed.tags ?? record.tags ?? [])].sort(),
        topicIds: [...new Set(parsed.topicIds ?? record.topicIds ?? [])].sort(),
        ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
      };
      await this.repository.insertEvent(event);
    });
    return await this.getPostRecord(parsed.postId);
  }
  private async archivePost(input: {
    expectedVersion: number;
    postId: string;
    reason?: string;
    idempotencyKey?: string;
  }): Promise<PostRecord> {
    this.checkAbort();
    const record = await this.getPostRecord(input.postId);
    this.assertPostAuthor(record);
    if (record.status !== 'archived') {
      await this.repository.transaction(async () => {
        const event: SynomemEvent = {
          ...this.intervention(record.event.actor as ActorRef),
          ...this.eventBase(input.postId, await this.repository.nextAggregateVersion(input.postId)),
          type: 'post.archived',
          postId: input.postId,
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        };
        await this.repository.insertEvent(event);
      });
    }
    return await this.getPostRecord(input.postId);
  }
  private async acknowledgePost(input: {
    expectedVersion: number;
    postId: string;
    note?: string;
    idempotencyKey?: string;
  }): Promise<PostRecord> {
    this.checkAbort();
    const record = await this.getPostRecord(input.postId);
    // Acknowledging twice is the same statement, so the second is a no-op
    // rather than a second row or an error.
    const already = record.acknowledgments.some(
      (entry) => entry.actor.id === this.actor.id && entry.actor.kind === this.actor.kind,
    );
    if (!already) {
      await this.repository.transaction(async () => {
        const event: SynomemEvent = {
          ...this.eventBase(input.postId, await this.repository.nextAggregateVersion(input.postId)),
          type: 'post.acknowledged',
          postId: input.postId,
          ...(input.note ? { note: input.note } : {}),
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        };
        await this.repository.insertEvent(event);
      });
    }
    return await this.getPostRecord(input.postId);
  }
  private async withdrawPostAcknowledgment(input: {
    expectedVersion: number;
    postId: string;
    reason?: string;
    idempotencyKey?: string;
  }): Promise<PostRecord> {
    this.checkAbort();
    const record = await this.getPostRecord(input.postId);
    const mine = record.acknowledgments.some(
      (entry) => entry.actor.id === this.actor.id && entry.actor.kind === this.actor.kind,
    );
    if (mine) {
      await this.repository.transaction(async () => {
        const event: SynomemEvent = {
          ...this.eventBase(input.postId, await this.repository.nextAggregateVersion(input.postId)),
          type: 'post.acknowledgment.withdrawn',
          postId: input.postId,
          ...(input.reason ? { reason: input.reason } : {}),
        };
        await this.repository.insertEvent(event);
      });
    }
    return await this.getPostRecord(input.postId);
  }
  private async postRoster(postId: string): Promise<PostRoster> {
    this.checkAbort();
    await this.requireVisibleItem(postId, 'post');
    const roster = await this.repository.postRoster(postId);
    if (!roster) throw new SynomemError('ITEM_NOT_FOUND', `Unknown post: ${postId}`);
    return roster;
  }
  private async getNoteRecord(id: string): Promise<NoteRecord> {
    await this.requireVisibleItem(id, 'note');
    const record = noteRecordsFromEvents(await this.repository.getReadableItemEvents(id))[0];
    if (!record) throw new SynomemError('NOTE_NOT_FOUND', `Unknown note: ${id}`);
    return this.decorateRecord(record);
  }
  private async getNote(id: string): Promise<NoteRecord> {
    this.checkAbort();
    return await this.getNoteRecord(id);
  }
  private async createNote(input: CreateNoteInput): Promise<CreateNoteResult> {
    this.checkAbort();
    await this.repository.assertEventCompatibility();
    const parsed = this.validate(() => createNoteSchema.parse(input));
    await this.assertTopicsExist(parsed.topicIds);
    const owner = await this.resolveActor(parsed.owner ?? this.boundRef(), true);
    if (!this.canManage(owner))
      throw new SynomemError(
        'MUTATION_FORBIDDEN',
        'Only the owner or an authorized overseer may create private memory.',
      );
    const outcome = await this.repository.transaction(async () => {
      const prior = await this.priorMutation(parsed.idempotencyKey, 'note.created');
      if (prior?.type === 'note.created') return { id: prior.id, created: false };
      const id = this.nextId();
      const event: SynomemEvent = {
        ...this.eventBase(id, 1, id),
        ...this.intervention({ kind: owner.kind, id: owner.id }),
        type: 'note.created',
        owner: { kind: owner.kind, id: owner.id },
        ownerDisplayName: owner.displayName,
        title: parsed.title,
        body: parsed.body,
        tags: [...new Set(parsed.tags ?? [])].sort(),
        topicIds: [...new Set(parsed.topicIds ?? [])].sort(),
        visibility: 'private',
        ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
        ...(parsed.source ? { source: parsed.source } : {}),
        ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
      };
      await this.repository.insertEvent(event);
      return { id, created: true };
    });
    if (outcome.created) await this.syncActor(owner);
    return {
      record: await this.getNoteRecord(outcome.id),
      created: outcome.created,
      deduplicated: !outcome.created,
    };
  }
  private assertNoteOwner(record: NoteRecord): void {
    if (!this.canManage(record.event.owner))
      throw new SynomemError(
        'MUTATION_FORBIDDEN',
        'Only the owner or an authorized overseer may change private memory.',
      );
  }
  private async reviseNote(input: ReviseNoteInput): Promise<NoteRecord> {
    const parsed = this.validate(() => reviseNoteSchema.parse(input));
    await this.assertTopicsExist(parsed.topicIds);
    const record = await this.getNoteRecord(parsed.noteId);
    this.assertNoteOwner(record);
    if (record.status === 'archived')
      throw new SynomemError('INVALID_INPUT', 'Archived notes cannot be revised.');
    if (parsed.expectedVersion !== record.current.version)
      throw new SynomemError(
        'REVISION_CONFLICT',
        `Expected note version ${parsed.expectedVersion}; current version is ${record.current.version}.`,
      );
    await this.repository.transaction(async () => {
      const prior = await this.priorMutation(parsed.idempotencyKey, 'note.revised');
      if (prior) return;
      if (
        (await this.repository.nextAggregateVersion(record.event.id)) !==
        parsed.expectedVersion + 1
      )
        throw new SynomemError(
          'REVISION_CONFLICT',
          'The note changed before this revision was stored.',
        );
      const event: SynomemEvent = {
        ...this.intervention(record.event.owner),
        ...this.eventBase(record.event.id, parsed.expectedVersion + 1),
        type: 'note.revised',
        noteId: record.event.id,
        title: parsed.title ?? record.current.title,
        body: parsed.body ?? record.current.body,
        tags: parsed.tags ?? record.current.tags,
        topicIds: parsed.topicIds ?? record.current.topicIds,
        visibility: 'private',
        ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
        ...(parsed.source ? { source: parsed.source } : {}),
        ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
      };
      await this.repository.insertEvent(event);
    });
    await this.syncActor(record.event.owner);
    return await this.getNoteRecord(parsed.noteId);
  }
  private async archiveNote(input: {
    expectedVersion: number;
    noteId: string;
    idempotencyKey?: string;
  }): Promise<NoteRecord> {
    const record = await this.getNoteRecord(input.noteId);
    this.assertNoteOwner(record);
    if (record.archived) return record;
    await this.repository.transaction(async () => {
      const prior = await this.priorMutation(input.idempotencyKey, 'note.archived');
      if (prior) return;
      const event: SynomemEvent = {
        ...this.intervention(record.event.owner),
        ...this.eventBase(
          record.event.id,
          await this.repository.nextAggregateVersion(record.event.id),
        ),
        type: 'note.archived',
        noteId: record.event.id,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      };
      await this.repository.insertEvent(event);
    });
    await this.syncActor(record.event.owner);
    return await this.getNoteRecord(input.noteId);
  }
  private async getTaskRecord(id: string): Promise<TaskRecord> {
    await this.requireVisibleItem(id, 'task');
    const record = taskRecordsFromEvents(await this.repository.getReadableItemEvents(id))[0];
    if (!record) throw new SynomemError('TODO_NOT_FOUND', `Unknown task: ${id}`);
    return this.decorateRecord(record);
  }
  private async getTask(id: string): Promise<TaskRecord> {
    this.checkAbort();
    return await this.getTaskRecord(id);
  }
  private async createTask(input: CreateTaskInput): Promise<CreateTaskResult> {
    this.checkAbort();
    await this.repository.assertEventCompatibility();
    const parsed = this.validate(() => createTaskSchema.parse(input));
    await this.assertTopicsExist(parsed.topicIds);
    const assignee = await this.resolveActor(parsed.assignee ?? this.boundRef(), true);
    if (
      this.actor.kind === 'agent' &&
      !sameActor(this.actor, assignee) &&
      !this.repository.config.allowCrossAgentTasks
    )
      throw new SynomemError('POLICY_FORBIDDEN', 'Cross-actor task assignment is disabled.');
    const outcome = await this.repository.transaction(async () => {
      const prior = await this.priorMutation(parsed.idempotencyKey, 'task.created');
      if (prior?.type === 'task.created') return { id: prior.id, created: false };
      const id = this.nextId();
      const requiresAcceptance = !sameActor(this.actor, assignee);
      const event: SynomemEvent = {
        ...this.eventBase(id, 1, id),
        type: 'task.created',
        assignee: { kind: assignee.kind, id: assignee.id },
        assigneeDisplayName: assignee.displayName,
        title: parsed.title,
        ...(parsed.description !== undefined ? { description: parsed.description } : {}),
        priority: parsed.priority ?? 3,
        ...(parsed.due ? { due: parsed.due } : {}),
        tags: [...new Set(parsed.tags ?? [])].sort(),
        topicIds: [...new Set(parsed.topicIds ?? [])].sort(),
        visibility: parsed.visibility ?? this.repository.config.defaultVisibility,
        requiresAcceptance,
        ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
        ...(parsed.source ? { source: parsed.source } : {}),
        ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
      };
      await this.repository.insertEvent(event);
      return { id, created: true };
    });
    if (outcome.created) await this.syncActor(assignee);
    return {
      record: await this.getTaskRecord(outcome.id),
      created: outcome.created,
      deduplicated: !outcome.created,
    };
  }
  private assertTaskParticipant(record: TaskRecord): void {
    if (!this.canManage(record.event.assignee) && !this.canManage(record.event.actor as ActorRef))
      throw new SynomemError(
        'MUTATION_FORBIDDEN',
        'Only task participants or authorized overseers may change it.',
      );
  }
  private assertTaskAssignee(record: TaskRecord): void {
    if (!this.canManage(record.event.assignee))
      throw new SynomemError(
        'MUTATION_FORBIDDEN',
        'Only the assignee or an authorized overseer may decide this task.',
      );
  }
  private async updateTask(input: UpdateTaskInput): Promise<TaskRecord> {
    const parsed = this.validate(() => updateTaskSchema.parse(input));
    await this.assertTopicsExist(parsed.topicIds);
    const record = await this.getTaskRecord(parsed.taskId);
    this.assertTaskParticipant(record);
    if (record.status !== 'open')
      throw new SynomemError('INVALID_INPUT', 'Only open tasks can be updated.');
    if (parsed.expectedVersion !== record.current.version)
      throw new SynomemError(
        'REVISION_CONFLICT',
        `Expected task version ${parsed.expectedVersion}; current version is ${record.current.version}.`,
      );
    await this.repository.transaction(async () => {
      const prior = await this.priorMutation(parsed.idempotencyKey, 'task.updated');
      if (prior) return;
      if (
        (await this.repository.nextAggregateVersion(record.event.id)) !==
        parsed.expectedVersion + 1
      )
        throw new SynomemError(
          'REVISION_CONFLICT',
          'The task changed before this update was stored.',
        );
      const due = parsed.due === null ? undefined : (parsed.due ?? record.current.due);
      const event: SynomemEvent = {
        ...this.intervention(record.event.assignee),
        ...this.eventBase(record.event.id, parsed.expectedVersion + 1),
        type: 'task.updated',
        taskId: record.event.id,
        title: parsed.title ?? record.current.title,
        ...(parsed.description !== undefined
          ? { description: parsed.description }
          : record.current.description !== undefined
            ? { description: record.current.description }
            : {}),
        priority: parsed.priority ?? record.current.priority,
        ...(due ? { due } : {}),
        tags: parsed.tags ?? record.current.tags,
        topicIds: parsed.topicIds ?? record.current.topicIds,
        visibility: parsed.visibility ?? record.current.visibility,
        ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
        ...(parsed.source ? { source: parsed.source } : {}),
        ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
      };
      await this.repository.insertEvent(event);
    });
    await this.syncActor(record.event.assignee);
    return await this.getTaskRecord(parsed.taskId);
  }
  private async overrideTaskDecision(input: OverrideTaskDecisionInput): Promise<TaskRecord> {
    this.checkAbort();
    const parsed = this.validate(() => overrideTaskDecisionSchema.parse(input));
    await this.repository.transaction(async () => {
      const record = await this.getTaskRecord(parsed.taskId);
      if (
        this.actor.kind !== 'human' ||
        !(
          this.administrative ||
          (record.event.assignee.kind === 'agent' &&
            overseesAgent(this.actor, this.authority, record.event.assignee.id)) ||
          (record.event.actor.kind === 'agent' &&
            overseesAgent(this.actor, this.authority, record.event.actor.id))
        )
      )
        throw new SynomemError(
          'MUTATION_FORBIDDEN',
          'Only an authorized human overseer may override a decision.',
        );
      if (record.current.version !== parsed.expectedVersion)
        throw new SynomemError(
          'REVISION_CONFLICT',
          'The task changed. Reload it before overriding.',
        );
      if (record.status !== 'open' && record.status !== 'rejected')
        throw new SynomemError(
          'INVALID_INPUT',
          'Only accepted/open or rejected decisions can be overridden.',
        );
      if (record.status === parsed.nextStatus)
        throw new SynomemError('INVALID_INPUT', 'The requested decision is already in effect.');
      const event: SynomemEvent = {
        ...this.eventBase(parsed.taskId, parsed.expectedVersion + 1),
        ...this.intervention(record.event.assignee, parsed.reason),
        type: 'task.decision_overridden',
        taskId: parsed.taskId,
        previousStatus: record.status,
        nextStatus: parsed.nextStatus,
        reason: parsed.reason,
        ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
      };
      await this.repository.insertEvent(event);
    });
    return this.getTaskRecord(parsed.taskId);
  }
  private async taskTransition(
    input: {
      expectedVersion: number;
      taskId: string;
      idempotencyKey?: string;
      note?: string;
      reason?: string;
      response?: string;
    },
    type: 'task.accepted' | 'task.rejected' | 'task.completed' | 'task.reopened' | 'task.canceled',
  ): Promise<TaskRecord> {
    const record = await this.getTaskRecord(input.taskId);
    // A rejection must say why. Enforced here as well as in the schema so the
    // failure names the missing thing rather than surfacing as a parse error.
    if (type === 'task.rejected' && !input.response?.trim()) {
      throw new SynomemError(
        'INVALID_INPUT',
        'Rejecting a task requires a response explaining why, so the assigner knows whether to reassign it, wait, or change the request.',
      );
    }
    if (type === 'task.accepted' || type === 'task.rejected') this.assertTaskAssignee(record);
    else this.assertTaskParticipant(record);
    if ((type === 'task.accepted' || type === 'task.rejected') && record.status !== 'assigned') {
      if (type === 'task.accepted' && record.status === 'open') return record;
      if (type === 'task.rejected' && record.status === 'rejected') return record;
      throw new SynomemError('INVALID_INPUT', 'Only assigned tasks may be accepted or rejected.');
    }
    if (type === 'task.completed' && record.status !== 'open') {
      if (record.status === 'completed') return record;
      throw new SynomemError(
        'INVALID_INPUT',
        'Only accepted or self-created open tasks may be completed.',
      );
    }
    if (type === 'task.reopened' && record.status !== 'completed' && record.status !== 'canceled') {
      if (record.status === 'open') return record;
      throw new SynomemError('INVALID_INPUT', 'Only completed or canceled tasks may be reopened.');
    }
    if (type === 'task.canceled' && record.status !== 'assigned' && record.status !== 'open') {
      if (record.status === 'canceled') return record;
      throw new SynomemError('INVALID_INPUT', 'Only assigned or open tasks may be canceled.');
    }
    await this.repository.transaction(async () => {
      const prior = await this.priorMutation(input.idempotencyKey, type);
      if (prior) return;
      const base = {
        ...this.intervention(record.event.assignee),
        ...this.eventBase(
          record.event.id,
          await this.repository.nextAggregateVersion(record.event.id),
        ),
        taskId: record.event.id,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      };
      const event: SynomemEvent =
        type === 'task.completed'
          ? { ...base, type, ...(input.note ? { note: input.note.trim() } : {}) }
          : type === 'task.rejected'
            ? { ...base, type, response: input.response!.trim() }
            : type === 'task.accepted'
              ? {
                  ...base,
                  type,
                  ...(input.response ? { response: input.response.trim() } : {}),
                }
              : type === 'task.canceled'
                ? { ...base, type, ...(input.reason ? { reason: input.reason.trim() } : {}) }
                : { ...base, type };
      await this.repository.insertEvent(event);
    });
    await this.syncActor(record.event.assignee);
    return await this.getTaskRecord(input.taskId);
  }
  private completeTask(input: {
    expectedVersion: number;
    taskId: string;
    note?: string;
    idempotencyKey?: string;
  }) {
    return this.taskTransition(input, 'task.completed');
  }
  private acceptTask(input: {
    expectedVersion: number;
    taskId: string;
    response?: string;
    idempotencyKey?: string;
  }) {
    return this.taskTransition(input, 'task.accepted');
  }
  private rejectTask(input: {
    expectedVersion: number;
    taskId: string;
    response: string;
    idempotencyKey?: string;
  }) {
    return this.taskTransition(input, 'task.rejected');
  }
  private reopenTask(input: { expectedVersion: number; taskId: string; idempotencyKey?: string }) {
    return this.taskTransition(input, 'task.reopened');
  }
  private cancelTask(input: {
    expectedVersion: number;
    taskId: string;
    reason?: string;
    idempotencyKey?: string;
  }) {
    return this.taskTransition(input, 'task.canceled');
  }
  /* ----------------------------------------------------------------- todos *
   * A Todo is a private reminder an agent creates for itself. There is no
   * assignee, no acceptance, and no visibility choice: it belongs to its author
   * and only its author reads it. Every method below asserts that ownership
   * rather than relying on a visibility filter, so a Todo cannot be reached by
   * guessing its id.
   */
  private async createTodo(input: CreateTodoInput): Promise<CreateTodoResult> {
    this.checkAbort();
    await this.repository.assertEventCompatibility();
    const parsed = this.validate(() => createTodoSchema.parse(input));
    await this.assertTopicsExist(parsed.topicIds);
    const owner = await this.resolveActor(parsed.owner ?? this.boundRef(), true);
    if (!this.canManage(owner))
      throw new SynomemError(
        'MUTATION_FORBIDDEN',
        'Only the owner or an authorized overseer may create private memory.',
      );
    const outcome = await this.repository.transaction(async () => {
      const prior = await this.priorMutation(parsed.idempotencyKey, 'todo.created');
      if (prior?.type === 'todo.created') return { id: prior.id, created: false };
      const id = this.nextId();
      const event: SynomemEvent = {
        ...this.eventBase(id, 1, id),
        ...this.intervention({ kind: owner.kind, id: owner.id }),
        type: 'todo.created',
        owner: { kind: owner.kind, id: owner.id },
        title: parsed.title,
        ...(parsed.details !== undefined ? { details: parsed.details } : {}),
        priority: parsed.priority ?? 3,
        ...(parsed.due ? { due: parsed.due } : {}),
        tags: [...new Set(parsed.tags ?? [])].sort(),
        topicIds: [...new Set(parsed.topicIds ?? [])].sort(),
        ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
        ...(parsed.source ? { source: parsed.source } : {}),
        ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
      };
      await this.repository.insertEvent(event);
      return { id, created: true };
    });
    return {
      record: await this.getTodoRecord(outcome.id),
      created: outcome.created,
      deduplicated: !outcome.created,
    };
  }
  private async getTodoRecord(id: string): Promise<TodoRecord> {
    const record = todoRecordsFromEvents(await this.repository.getReadableItemEvents(id))[0];
    if (!record) throw new SynomemError('ITEM_NOT_FOUND', `Unknown todo: ${id}`);
    this.assertTodoOwner(record);
    return this.decorateRecord(record);
  }
  /**
   * Todos are owner-only for every ordinary actor — the same rule notes
   * already follow (`assertNoteOwner`): an organization owner or admin is the
   * deliberate exception, since only they can create an agent in the first
   * place, so the account behind any todo's owner is always one they
   * administer. Without this exception, a human administrator viewing an
   * agent they created themselves could see that agent's private Todos in a
   * list (the repository's own visibility query already grants that) but
   * never open one — a redundant, stricter, and contradictory check sitting
   * on top of a permission that had already been granted.
   */
  private assertTodoOwner(record: TodoRecord): void {
    if (!this.canManage(record.event.owner))
      throw new SynomemError(
        'MUTATION_FORBIDDEN',
        'Only the owner or an authorized overseer may change private memory.',
      );
  }
  private async getTodo(id: string): Promise<TodoRecord> {
    this.checkAbort();
    return await this.getTodoRecord(id);
  }
  private async updateTodo(input: UpdateTodoInput): Promise<TodoRecord> {
    this.checkAbort();
    const parsed = this.validate(() => updateTodoSchema.parse(input));
    await this.assertTopicsExist(parsed.topicIds);
    const record = await this.getTodoRecord(parsed.todoId);
    if (record.current.version !== parsed.expectedVersion) {
      throw new SynomemError(
        'REVISION_CONFLICT',
        `Todo ${parsed.todoId} is at version ${record.current.version}.`,
      );
    }
    const due = parsed.due === null ? undefined : (parsed.due ?? record.current.due);
    await this.repository.transaction(async () => {
      const prior = await this.priorMutation(parsed.idempotencyKey, 'todo.updated');
      if (prior) return;
      const event: SynomemEvent = {
        ...this.intervention(record.event.owner),
        ...this.eventBase(
          record.event.id,
          await this.repository.nextAggregateVersion(record.event.id),
        ),
        type: 'todo.updated',
        todoId: record.event.id,
        title: parsed.title ?? record.current.title,
        ...((parsed.details ?? record.current.details)
          ? { details: parsed.details ?? record.current.details }
          : {}),
        priority: parsed.priority ?? record.current.priority,
        ...(due ? { due } : {}),
        tags: [...new Set<string>(parsed.tags ?? record.current.tags)].sort(),
        topicIds: [...new Set<string>(parsed.topicIds ?? record.current.topicIds)].sort(),
        ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
      };
      await this.repository.insertEvent(event);
    });
    return await this.getTodoRecord(parsed.todoId);
  }
  private async todoTransition(
    input: {
      expectedVersion: number;
      todoId: string;
      idempotencyKey?: string;
      note?: string;
      reason?: string;
    },
    type: 'todo.completed' | 'todo.reopened' | 'todo.canceled' | 'todo.archived',
  ): Promise<TodoRecord> {
    const record = await this.getTodoRecord(input.todoId);
    this.assertTodoOwner(record);
    if (type === 'todo.completed' && record.status !== 'open') {
      if (record.status === 'completed') return record;
      throw new SynomemError('INVALID_INPUT', 'Only an open todo may be completed.');
    }
    if (type === 'todo.reopened' && record.status === 'open') return record;
    if (type === 'todo.canceled' && record.status !== 'open') {
      if (record.status === 'canceled') return record;
      throw new SynomemError('INVALID_INPUT', 'Only an open todo may be canceled.');
    }
    if (type === 'todo.archived' && record.status === 'archived') return record;
    await this.repository.transaction(async () => {
      const prior = await this.priorMutation(input.idempotencyKey, type);
      if (prior) return;
      const base = {
        ...this.eventBase(
          record.event.id,
          await this.repository.nextAggregateVersion(record.event.id),
        ),
        todoId: record.event.id,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      };
      const event: SynomemEvent =
        type === 'todo.completed'
          ? { ...base, type, ...(input.note ? { note: input.note.trim() } : {}) }
          : type === 'todo.canceled'
            ? { ...base, type, ...(input.reason ? { reason: input.reason.trim() } : {}) }
            : { ...base, type };
      await this.repository.insertEvent(event);
    });
    return await this.getTodoRecord(input.todoId);
  }
  /**
   * Turns an agent name in a filter into the canonical ID the records hold.
   *
   * Callers filter by the name they know — a handle or an alias — while every
   * record stores the opaque ID. Without this the filter silently matches
   * nothing, which reads as "there is nothing here" rather than "that name
   * means something else now".
   *
   * An unresolvable name is passed through unchanged so it can match a legacy
   * name-shaped ID rather than being swallowed.
   */
  private async canonicalAgentId(name: string | undefined): Promise<string | undefined> {
    if (!name) return name;
    const resolved = await this.repository.resolveAgent(name);
    return resolved.match?.id ?? name;
  }
  private async listItems(input: ItemListInput): Promise<Page<ItemSummary>> {
    this.checkAbort();
    const parsed = this.validate(() => itemListInputSchema.parse(input));
    const resolved = {
      ...parsed,
      ...(parsed.participant ? { participant: await this.resolveActor(parsed.participant) } : {}),
      ...(parsed.actorId && parsed.actorKind === 'agent'
        ? { actorId: await this.canonicalAgentId(parsed.actorId) }
        : {}),
    };
    return await this.repository.listItemSummaries(resolved, this.actor);
  }
  private async listItemChanges(input: ChangesInput): Promise<ChangePage> {
    this.checkAbort();
    const parsed = this.validate(() =>
      changesInputSchema
        .extend({
          kinds: itemListInputSchema.shape.kinds,
        })
        .parse(input),
    );
    return await this.repository.listItemChanges(
      parsed.after,
      parsed.limit,
      this.actor,
      parsed.kinds,
    );
  }
  private async getItem(id: string): Promise<ItemRecord> {
    const summary = await this.repository.getItemSummary(id);
    if (!summary) throw new SynomemError('ITEM_NOT_FOUND', `Unknown item: ${id}`);
    if (!this.canViewItem(summary)) {
      throw new SynomemError(
        'POLICY_FORBIDDEN',
        'This item is not visible to the configured actor.',
      );
    }
    if (summary.kind === 'kudos') return this.getKudos(id);
    if (summary.kind === 'memo') return this.getMemo(id);
    if (summary.kind === 'note') return this.getNote(id);
    if (summary.kind === 'post') return this.getPost(id);
    if (summary.kind === 'todo') return this.getTodo(id);
    return this.getTask(id);
  }
  async stats(input: KudosListInput = {}): Promise<KudosStats> {
    this.checkAbort();
    const parsed = this.validate(() => listInputSchema.parse(input));
    const { cursor: _cursor, limit: _limit, offset: _offset, ...filters } = parsed;
    void _cursor;
    void _limit;
    void _offset;
    const recipient = filters.recipient?.id
      ? await this.resolveActor(filters.recipient)
      : undefined;
    if (filters.recipient?.id && !recipient) {
      throw new SynomemError('AGENT_NOT_FOUND', `Unknown agent: ${filters.recipient?.id}`);
    }
    const records: KudosSummary[] = [];
    let cursor: string | undefined;
    const viewer = this.actor;
    let hasMore = true;
    while (hasMore) {
      const page = await this.repository.listKudosSummaries(
        {
          ...filters,
          ...(recipient ? { recipient: { kind: recipient.kind, id: recipient.id } } : {}),
          limit: 50,
          offset: 0,
          ...(cursor ? { cursor } : {}),
        },
        viewer,
      );
      records.push(...page.items);
      cursor = page.nextCursor;
      hasMore = page.hasMore && Boolean(cursor) && page.items.length > 0;
    }
    const includedRecords = this.repository.config.includePrivateInStats
      ? records
      : records.filter((record) => record.visibility !== 'private');
    const stats: KudosStats = {
      total: includedRecords.length,
      active: includedRecords.filter((record) => record.revocationStatus === 'active').length,
      acknowledged: includedRecords.filter(
        (record) => record.status === 'acknowledged' && record.revocationStatus === 'active',
      ).length,
      revoked: includedRecords.filter((record) => record.revocationStatus === 'revoked').length,
      byAgent: {},
      byActor: {},
      byTag: {},
    };
    for (const record of includedRecords) {
      stats.byAgent[record.recipient?.id] = (stats.byAgent[record.recipient?.id] ?? 0) + 1;
      const actor = `${record.actor.kind}:${record.actor.id}`;
      stats.byActor[actor] = (stats.byActor[actor] ?? 0) + 1;
      for (const tag of record.tags) stats.byTag[tag] = (stats.byTag[tag] ?? 0) + 1;
    }
    return stats;
  }
}
/**
 * The schema version this package writes and expects. Named rather than
 * repeated as a literal because it is asserted in three places, and a doctor
 * check that silently lags the migration runner reports a healthy database as
 * broken.
 */
const CURRENT_SCHEMA_VERSION = 9;
const EXPECTED_APPLIED_MIGRATIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
export class SynomemClient extends SynomemCore implements SynomemService {
  readonly home: string;
  readonly storage: SynomemStorage;
  readonly projections: ProjectionManager;
  constructor(options: SynomemClientOptions = {}) {
    const home = resolveHome(options.home);
    const storage = new SynomemStorage({
      home,
      ...(options.actor ? { actor: options.actor } : {}),
      readOnly: options.readOnly ?? false,
      ...(options.authority ? { authority: options.authority } : {}),
      ...(options.config ? { config: options.config } : {}),
    });
    const projections = new ProjectionManager(storage);
    super({
      repository: storage,
      projectionWriter: projections,
      ...(options.actor ? { actor: options.actor } : {}),
      ...(options.authority ? { authority: options.authority } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.idGenerator ? { idGenerator: options.idGenerator } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      canWrite: !options.readOnly,
    });
    this.home = home;
    this.storage = storage;
    this.projections = projections;
  }
  /*
   * Answers "would a rebuild change anything, and when did one last run?"
   *
   * The comparison is against the manifest rather than a directory walk, so a
   * file a person dropped into the projection tree by hand is not reported as
   * drift -- Synomem only claims authority over what it wrote.
   */
  async projectionStatus(): Promise<ProjectionStatus> {
    this.checkAbort();
    const expected = this.projections.expectedPaths();
    const entries = this.storage.projectionManifestEntries();
    const manifest = entries.map((entry) => entry.path);
    const inManifest = new Set(manifest);
    const inExpected = new Set(expected);
    const missing = expected.filter(
      (path) => !inManifest.has(path) || !existsSync(join(this.home, path)),
    );
    const unexpected = manifest.filter((path) => !inExpected.has(path));
    const limit = 20;
    return {
      directory: this.home,
      settings: { ...this.storage.config.projection },
      current: missing.length === 0 && unexpected.length === 0,
      ...(entries[0] ? { lastRebuiltAt: entries[0].generatedAt } : {}),
      counts: {
        expected: expected.length,
        manifest: manifest.length,
        missing: missing.length,
        unexpected: unexpected.length,
      },
      missing: missing.slice(0, limit),
      unexpected: unexpected.slice(0, limit),
    };
  }
  async doctor(): Promise<DoctorResult> {
    this.checkAbort();
    const diagnostics: Diagnostic[] = [];
    try {
      try {
        accessSync(this.home, fsConstants.R_OK | (this.storage.readOnly ? 0 : fsConstants.W_OK));
        diagnostics.push({
          level: 'ok',
          code: 'HOME_PERMISSIONS_OK',
          message: `Storage home is ${this.storage.readOnly ? 'readable' : 'readable and writable'}.`,
        });
      } catch {
        diagnostics.push({
          level: 'error',
          code: 'HOME_PERMISSIONS_FAILED',
          message: 'Storage home permissions do not permit the configured access mode.',
          path: this.home,
        });
      }
      const integrity = this.storage.integrityCheck();
      if (integrity.length === 1 && integrity[0] === 'ok') {
        diagnostics.push({
          level: 'ok',
          code: 'SQLITE_INTEGRITY_OK',
          message: 'SQLite integrity check passed.',
        });
      } else {
        diagnostics.push({
          level: 'error',
          code: 'SQLITE_INTEGRITY_FAILED',
          message: integrity.join('; '),
        });
      }
      const journal = this.storage.journalMode();
      diagnostics.push({
        level: journal === 'wal' || this.storage.readOnly ? 'ok' : 'warning',
        code: 'SQLITE_JOURNAL_MODE',
        message: `SQLite journal mode is ${journal}.`,
      });
      const eventScan = this.storage.scanEvents();
      if (eventScan.invalid.length) {
        for (const invalid of eventScan.invalid) {
          diagnostics.push({
            level: 'error',
            code: invalid.error.code,
            message: invalid.error.message,
          });
        }
      } else {
        diagnostics.push({
          level: 'ok',
          code: 'EVENTS_VALID',
          message: `${eventScan.events.length} canonical event${eventScan.events.length === 1 ? '' : 's'} validated.`,
        });
      }
      const indexHealth = this.storage.currentIndexHealth();
      const indexValid =
        indexHealth.given === indexHealth.indexed && indexHealth.stateMismatches === 0;
      diagnostics.push({
        level: indexValid ? 'ok' : 'error',
        code: indexValid ? 'CURRENT_INDEX_VALID' : 'CURRENT_INDEX_INCONSISTENT',
        message: `${indexHealth.indexed} of ${indexHealth.given} kudos are present in the current-state index; ${indexHealth.stateMismatches} state mismatch${indexHealth.stateMismatches === 1 ? '' : 'es'} detected.`,
      });
      const itemHealth = this.storage.itemIndexHealth();
      const itemsValid = itemHealth.created === itemHealth.indexed;
      diagnostics.push({
        level: itemsValid ? 'ok' : 'error',
        code: itemsValid ? 'ITEM_INDEX_VALID' : 'ITEM_INDEX_INCONSISTENT',
        message: `${itemHealth.indexed} of ${itemHealth.created} item aggregates are present in the shared current-state index.`,
      });
      const migrationState = this.storage.migrationState();
      const migrationsValid =
        migrationState.schemaVersion === CURRENT_SCHEMA_VERSION &&
        JSON.stringify(migrationState.appliedVersions) ===
          JSON.stringify(EXPECTED_APPLIED_MIGRATIONS);
      diagnostics.push({
        level: migrationsValid ? 'ok' : 'error',
        code: migrationsValid ? 'MIGRATIONS_VALID' : 'MIGRATIONS_INCONSISTENT',
        message: `Database schema version is ${migrationState.schemaVersion}; recorded migrations: ${migrationState.appliedVersions.join(', ') || 'none'}.`,
      });
      const aliasConflicts = this.storage.aliasIdentityConflicts();
      diagnostics.push({
        level: aliasConflicts.length ? 'error' : 'ok',
        code: aliasConflicts.length ? 'ALIAS_CONFLICTS_FOUND' : 'ALIASES_VALID',
        message: aliasConflicts.length
          ? `Aliases collide with direct agent identities: ${aliasConflicts.map((item) => `${item.alias}→${item.agentId}`).join(', ')}.`
          : 'No aliases collide with direct agent identities.',
      });
      const expected = this.projections.expectedPaths();
      const manifest = this.storage.projectionManifest().sort();
      const stale = JSON.stringify(expected) === JSON.stringify(manifest) ? [] : expected;
      diagnostics.push({
        level: stale.length ? 'warning' : 'ok',
        code: stale.length ? 'PROJECTIONS_STALE' : 'PROJECTIONS_CURRENT',
        message: stale.length
          ? 'Generated projections need rebuilding.'
          : 'Projection manifest is current.',
      });
      for (const profile of this.storage.listAgents()) {
        // Named by handle, which is what the projection writers create. Using
        // the canonical ID here checks a directory that does not exist, which
        // makes the check pass on a workspace whose agent directory really has
        // been replaced with a symbolic link.
        const directory = join(this.home, profile.handle);
        try {
          assertNoSymlinkEscape(this.home, directory);
          if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) {
            throw new SynomemError('UNSAFE_PATH', 'Agent directory is a symbolic link.');
          }
        } catch (error) {
          diagnostics.push({
            level: 'error',
            code: 'UNSAFE_SYMLINK',
            message: error instanceof Error ? error.message : String(error),
            path: relative(this.home, directory),
          });
        }
      }
    } catch (error) {
      diagnostics.push({
        level: 'error',
        code: error instanceof SynomemError ? error.code : 'DOCTOR_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return { healthy: !diagnostics.some((item) => item.level === 'error'), diagnostics };
  }
  async export(format: 'json' | 'jsonl' | 'markdown'): Promise<string> {
    this.checkAbort();
    const rows = [] as ReturnType<SynomemStorage['rawEventRows']>;
    const access = new Map<string, boolean>();
    for (const row of this.storage.rawEventRows()) {
      let event: SynomemEvent;
      try {
        event = eventSchema.parse(JSON.parse(row.payload));
      } catch {
        if (this.administrative) rows.push(row);
        continue;
      }
      const rootId = 'rootId' in event ? event.rootId : event.aggregateId;
      if (event.type.startsWith('agent.')) {
        if (this.administrative) rows.push(row);
        continue;
      }
      if (!access.has(rootId))
        access.set(rootId, this.storage.canActorReadItem(rootId, this.actor as ActorRef));
      if (!access.get(rootId)) continue;
      if (
        event.type === 'reply.created' &&
        (await this.storage.participation.getReply(event.id))?.deleted
      )
        continue;
      rows.push(row);
    }
    if (format === 'jsonl') return `${rows.map((row) => row.payload).join('\n')}\n`;
    const exported = rows.map((row) => {
      try {
        return JSON.parse(row.payload) as unknown;
      } catch {
        return { _synomemUnreadableEvent: { id: row.id, rawPayload: row.payload } };
      }
    });
    if (format === 'json') return `${JSON.stringify(exported, null, 2)}\n`;
    const scan = this.storage.scanEvents();
    const allowedIds = new Set(rows.map((row) => row.id));
    const events = scan.events.filter((event) => allowedIds.has(event.id));
    const records = recordsFromEvents(events);
    const memos = memoRecordsFromEvents(events);
    const notes = noteRecordsFromEvents(events);
    const tasks = taskRecordsFromEvents(events);
    const warning = scan.invalid.length
      ? `> Warning: ${scan.invalid.length} unsupported or malformed event(s) omitted from this Markdown view: ${scan.invalid.map((item) => item.id).join(', ')}\n\n`
      : '';
    const sections = [
      ...records.map(
        (record) =>
          `## Kudos: ${escapeMarkdown(record.event.title)}\n\n${escapeMarkdown(record.event.reason)}\n\nStatus: ${record.revocationStatus === 'revoked' ? 'Revoked' : record.status}\n\nID: \`${record.event.id}\``,
      ),
      ...memos.map(
        (record) =>
          `## Memo: ${escapeMarkdown(record.event.subject)}\n\n${escapeMarkdown(record.event.body)}\n\nStatus: ${record.status}\n\nID: \`${record.event.id}\``,
      ),
      ...notes.map(
        (record) =>
          `## Note: ${escapeMarkdown(record.current.title)}\n\n${escapeMarkdown(record.current.body)}\n\nStatus: ${record.status}; version ${record.current.version}\n\nID: \`${record.event.id}\``,
      ),
      ...tasks.map(
        (record) =>
          `## Task: ${escapeMarkdown(record.current.title)}\n\n${record.current.description ? `${escapeMarkdown(record.current.description)}\n\n` : ''}Status: ${record.status}; priority ${record.current.priority}\n\nID: \`${record.event.id}\``,
      ),
    ];
    return `${warning}${sections.join('\n\n')}\n`;
  }
  async backup(destination: string): Promise<string> {
    this.checkAbort();
    return this.storage.backup(resolve(destination));
  }
  async rebuild(): Promise<ProjectionRebuildResult> {
    this.checkAbort();
    return this.projections.rebuild();
  }
  async capabilities(): Promise<SynomemServiceCapabilities> {
    this.checkAbort();
    return {
      backend: 'local',
      participation: {
        version: 2,
        replies: true,
        reactions: true,
        personalInbox: true,
        search: false,
        canWrite: !this.storage.readOnly,
        administrator: this.administrative,
        managedAgentIds: [...this.authority.operatedAgentIds],
      },
      binding: { workspaceId: this.storage.config.workspaceId, actor: this.actor },
      administration: {
        agentCreationViaMcp: this.storage.config.allowAgentCreationViaMcp,
        agentArchiveViaMcp: this.storage.config.allowAgentArchiveViaMcp,
        rebuildViaMcp: this.storage.config.allowRebuildViaMcp,
      },
      projections: { ...this.storage.config.projection },
    };
  }
  async info(): Promise<SynomemServiceInfo> {
    this.checkAbort();
    return { backend: 'local', home: this.home, databasePath: this.storage.databasePath };
  }
  async getCanonicalEvent(id: string): Promise<SynomemEvent | undefined> {
    this.checkAbort();
    const event = this.storage.getEvent(id);
    if (!event) return undefined;
    if (event.type.startsWith('agent.')) return this.administrative ? event : undefined;
    const rootId = 'rootId' in event ? event.rootId : event.aggregateId;
    if (!this.storage.canActorReadItem(rootId, this.actor as ActorRef))
      throw new SynomemError('POLICY_FORBIDDEN', 'This event is not visible.');
    if (
      event.type === 'reply.created' &&
      (await this.storage.participation.getReply(event.id))?.deleted
    )
      return undefined;
    return event;
  }
}
export function createLocalOwnerClient(
  options: Omit<SynomemClientOptions, 'authority'> = {},
): SynomemClient {
  if (options.actor?.kind !== 'human')
    throw new SynomemError(
      'POLICY_FORBIDDEN',
      'Local owner administration requires an explicit human actor.',
    );
  return new SynomemClient({ ...options, authority: localOwnerAuthority() });
}
