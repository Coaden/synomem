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
  TodoRecord,
  ItemListInput,
  ItemRecord,
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
  /** Explicit administrator authority. Defaults to true only for local-style human actors. */
  administrative?: boolean;
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
  private readonly administrative: boolean;
  private initialized = false;

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

  readonly kudos = {
    give: (input: GiveKudosInput) => this.giveKudos(input),
    list: (input: KudosListInput = {}) => this.listKudos(input),
    changes: (input: KudosChangesInput = {}) => this.listKudosChanges(input),
    get: (id: string) => this.getKudos(id),
    acknowledge: (input: { kudosId: string; note?: string }) => this.acknowledgeKudos(input),
    revoke: (input: { kudosId: string; reason: string; administrative?: boolean }) =>
      this.revokeKudos(input),
  };

  readonly memos = {
    send: (input: SendMemoInput) => this.sendMemo(input),
    list: (input: Omit<ItemListInput, 'kinds'> = {}) =>
      this.listItems({ ...input, kinds: ['memo'] }),
    get: (id: string) => this.getMemo(id),
    read: (input: { memoId: string; idempotencyKey?: string }) => this.readMemo(input),
    archive: (input: { memoId: string; idempotencyKey?: string }) => this.archiveMemo(input),
  };

  readonly posts = {
    create: (input: CreatePostInput) => this.createPost(input),
    list: (input: Omit<ItemListInput, 'kinds'> = {}) =>
      this.listItems({ ...input, kinds: ['post'] }),
    get: (id: string) => this.getPost(id),
    update: (input: UpdatePostInput) => this.updatePost(input),
    archive: (input: { postId: string; reason?: string; idempotencyKey?: string }) =>
      this.archivePost(input),
    /*
     * Acknowledging is an explicit call and always speaks for the caller alone.
     * There is no bulk form and no acknowledge-on-behalf-of: an acknowledgement
     * is one actor saying "I have seen this", and reading a post must never
     * append one, or the roster stops meaning anything.
     */
    acknowledge: (input: { postId: string; note?: string; idempotencyKey?: string }) =>
      this.acknowledgePost(input),
    withdrawAcknowledgment: (input: { postId: string; reason?: string }) =>
      this.withdrawPostAcknowledgment(input),
    roster: (postId: string) => this.postRoster(postId),
  };

  readonly notes = {
    create: (input: CreateNoteInput) => this.createNote(input),
    list: (input: Omit<ItemListInput, 'kinds'> = {}) =>
      this.listItems({ ...input, kinds: ['note'] }),
    get: (id: string) => this.getNote(id),
    revise: (input: ReviseNoteInput) => this.reviseNote(input),
    archive: (input: { noteId: string; idempotencyKey?: string }) => this.archiveNote(input),
  };

  readonly tasks = {
    create: (input: CreateTaskInput) => this.createTask(input),
    list: (input: Omit<ItemListInput, 'kinds'> = {}) =>
      this.listItems({ ...input, kinds: ['task'] }),
    get: (id: string) => this.getTask(id),
    update: (input: UpdateTaskInput) => this.updateTask(input),
    // A response is optional when accepting and required when rejecting: a
    // refusal without a reason leaves the assigner unable to act on it.
    accept: (input: { taskId: string; response?: string; idempotencyKey?: string }) =>
      this.acceptTask(input),
    reject: (input: { taskId: string; response: string; idempotencyKey?: string }) =>
      this.rejectTask(input),
    complete: (input: { taskId: string; note?: string; idempotencyKey?: string }) =>
      this.completeTask(input),
    reopen: (input: { taskId: string; idempotencyKey?: string }) => this.reopenTask(input),
    cancel: (input: { taskId: string; reason?: string; idempotencyKey?: string }) =>
      this.cancelTask(input),
  };

  readonly todos = {
    create: (input: CreateTodoInput) => this.createTodo(input),
    list: (input: Omit<ItemListInput, 'kinds'> = {}) =>
      this.listItems({ ...input, kinds: ['todo'] }),
    get: (id: string) => this.getTodo(id),
    update: (input: UpdateTodoInput) => this.updateTodo(input),
    complete: (input: { todoId: string; note?: string; idempotencyKey?: string }) =>
      this.todoTransition(input, 'todo.completed'),
    reopen: (input: { todoId: string; idempotencyKey?: string }) =>
      this.todoTransition(input, 'todo.reopened'),
    cancel: (input: { todoId: string; reason?: string; idempotencyKey?: string }) =>
      this.todoTransition(input, 'todo.canceled'),
    archive: (input: { todoId: string; idempotencyKey?: string }) =>
      this.todoTransition(input, 'todo.archived'),
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
      input: Omit<ItemListInput, 'awaitingResponse' | 'pending'> & { olderThanHours?: number } = {},
    ) => {
      const { olderThanHours, awaitingSince, ...rest } = input;
      const since =
        awaitingSince ??
        (olderThanHours !== undefined
          ? new Date(Date.now() - olderThanHours * 3_600_000).toISOString()
          : undefined);
      return this.listItems({
        ...rest,
        awaitingResponse: true,
        ...(since ? { awaitingSince: since } : {}),
      });
    },
    /** Open work whose deadline has passed. Defaults to "now". */
    overdue: (input: Omit<ItemListInput, 'overdueAsOf'> & { asOf?: string } = {}) => {
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
    this.administrative = options.administrative ?? this.actor.kind === 'human';
    this.repository = options.repository;
    this.projectionWriter = options.projectionWriter;
  }

  async init(): Promise<void> {
    this.checkAbort();
    if (this.initialized) return;
    await this.repository.init();
    this.initialized = true;

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

  private now(): string {
    return this.clock().toISOString();
  }

  private nextId(): string {
    return this.idGenerator();
  }

  private eventBase(aggregateId: string, aggregateVersion: number, id = this.nextId()) {
    return {
      schemaVersion: 1 as const,
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

  private async giveKudos(input: GiveKudosInput): Promise<GiveKudosResult> {
    this.checkAbort();
    await this.repository.assertEventCompatibility();
    const parsed = this.validate(() =>
      giveKudosSchema.parse({
        ...input,
        visibility: input.visibility ?? this.repository.config.defaultVisibility,
      }),
    );
    const recipient = await this.repository.getAgent(parsed.recipientAgentId);
    if (!recipient) {
      throw new SynomemError('AGENT_NOT_FOUND', `Unknown recipient: ${parsed.recipientAgentId}`);
    }
    if (
      !this.repository.config.allowSelfAwards &&
      this.actor.kind !== 'human' &&
      this.actor.id === recipient.id
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
        recipientAgentId: recipient.id,
        recipientDisplayName: recipient.displayName,
        title: parsed.title,
        reason: parsed.reason,
        visibility: parsed.visibility,
        ...(parsed.evidence ? { evidence: parsed.evidence } : {}),
        ...(parsed.tags ? { tags: [...new Set(parsed.tags)].sort() } : {}),
        ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
        ...(parsed.source ? { source: parsed.source } : {}),
        ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
      };
      await this.repository.insertEvent(event);
      return { event, created: true };
    });
    if (outcome.created) await this.projectionWriter.syncAgent(recipient.id);
    const record = await this.getKudosRecord(outcome.event.id);
    return { record, created: outcome.created, deduplicated: !outcome.created };
  }

  private async getKudosRecord(id: string): Promise<KudosRecord> {
    await this.requireVisibleItem(id, 'kudos');
    const record = recordsFromEvents(await this.repository.getReadableSynomemEvents(id))[0];
    if (!record) throw new SynomemError('KUDOS_NOT_FOUND', `Unknown kudos: ${id}`);
    return record;
  }

  private async getKudos(id: string): Promise<KudosRecord> {
    this.checkAbort();
    return await this.getKudosRecord(id);
  }

  private async listKudos(input: KudosListInput): Promise<Page<KudosSummary>> {
    this.checkAbort();
    const filters = this.validate(() => listInputSchema.parse(input));
    const recipient = filters.recipientAgentId
      ? await this.repository.getAgent(filters.recipientAgentId)
      : undefined;
    if (filters.recipientAgentId && !recipient) {
      throw new SynomemError('AGENT_NOT_FOUND', `Unknown agent: ${filters.recipientAgentId}`);
    }
    return await this.repository.listKudosSummaries(
      {
        ...filters,
        ...(recipient ? { recipientAgentId: recipient.id } : {}),
      },
      this.actor,
    );
  }

  private async listKudosChanges(input: KudosChangesInput): Promise<ChangePage> {
    this.checkAbort();
    const parsed = this.validate(() => changesInputSchema.parse(input));
    return await this.repository.listKudosChanges(parsed.after, parsed.limit, this.actor);
  }

  private async acknowledgeKudos(input: { kudosId: string; note?: string }): Promise<KudosRecord> {
    this.checkAbort();
    await this.repository.assertEventCompatibility();
    if (input.note !== undefined && (input.note.trim().length < 1 || input.note.length > 2000)) {
      throw new SynomemError('INVALID_INPUT', 'Acknowledgment notes must be 1–2000 characters.');
    }
    const record = await this.getKudosRecord(input.kudosId);
    if (record.acknowledgment) return record;
    if (record.revocation)
      throw new SynomemError('INVALID_INPUT', 'Revoked kudos cannot be acknowledged.');
    const isRecipient =
      this.actor.kind === 'agent' && this.actor.id === record.event.recipientAgentId;
    if (!this.administrative && !isRecipient) {
      throw new SynomemError(
        'ACKNOWLEDGMENT_FORBIDDEN',
        'Only the recipient agent or a human administrator may acknowledge kudos.',
      );
    }
    const event: KudosAcknowledgedEvent = {
      ...this.eventBase(record.event.id, 2),
      type: 'kudos.acknowledged',
      kudosId: record.event.id,
      recipientAgentId: record.event.recipientAgentId,
      ...(input.note ? { note: input.note.trim() } : {}),
    };
    await this.repository.transaction(() => this.repository.insertEvent(event));
    await this.projectionWriter.syncAgent(record.event.recipientAgentId);
    return await this.getKudosRecord(input.kudosId);
  }

  private async revokeKudos(input: {
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
    if (!isOriginalActor && !this.administrative) {
      throw new SynomemError(
        'REVOCATION_FORBIDDEN',
        'Only the original actor or an administrator may revoke kudos.',
      );
    }
    const event: KudosRevokedEvent = {
      ...this.eventBase(record.event.id, record.acknowledgment ? 3 : 2),
      type: 'kudos.revoked',
      kudosId: record.event.id,
      reason,
      mode: administrative && !isOriginalActor ? 'administrative' : 'actor-requested',
    };
    await this.repository.transaction(() => this.repository.insertEvent(event));
    await this.projectionWriter.syncAgent(record.event.recipientAgentId);
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
    return (
      this.administrative ||
      summary.visibility !== 'private' ||
      (summary.actor.kind === this.actor.kind && summary.actor.id === this.actor.id) ||
      (this.actor.kind === 'agent' &&
        (summary.recipientAgentId === this.actor.id ||
          summary.ownerAgentId === this.actor.id ||
          summary.assigneeAgentId === this.actor.id))
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
    return record;
  }

  private async getMemo(id: string): Promise<MemoRecord> {
    this.checkAbort();
    return await this.getMemoRecord(id);
  }

  private async sendMemo(input: SendMemoInput): Promise<SendMemoResult> {
    this.checkAbort();
    await this.repository.assertEventCompatibility();
    const parsed = this.validate(() => sendMemoSchema.parse(input));
    const recipient = await this.repository.getAgent(parsed.recipientAgentId);
    if (!recipient)
      throw new SynomemError('AGENT_NOT_FOUND', `Unknown recipient: ${parsed.recipientAgentId}`);
    const outcome = await this.repository.transaction(async () => {
      const prior = await this.priorMutation(parsed.idempotencyKey, 'memo.sent');
      if (prior?.type === 'memo.sent') return { id: prior.id, created: false };
      const id = this.nextId();
      const event: SynomemEvent = {
        ...this.eventBase(id, 1, id),
        type: 'memo.sent',
        recipientAgentId: recipient.id,
        recipientDisplayName: recipient.displayName,
        subject: parsed.subject,
        body: parsed.body,
        tags: [...new Set(parsed.tags ?? [])].sort(),
        visibility: parsed.visibility ?? this.repository.config.defaultVisibility,
        ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
        ...(parsed.source ? { source: parsed.source } : {}),
        ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
      };
      await this.repository.insertEvent(event);
      return { id, created: true };
    });
    if (outcome.created) await this.projectionWriter.syncAgent(recipient.id);
    return {
      record: await this.getMemoRecord(outcome.id),
      created: outcome.created,
      deduplicated: !outcome.created,
    };
  }

  private assertRecipient(recipientAgentId: string, operation: string): void {
    if (
      !this.administrative &&
      !(this.actor.kind === 'agent' && this.actor.id === recipientAgentId)
    ) {
      throw new SynomemError(
        'MUTATION_FORBIDDEN',
        `Only the recipient agent or a human administrator may ${operation}.`,
      );
    }
  }

  private async readMemo(input: { memoId: string; idempotencyKey?: string }): Promise<MemoRecord> {
    const record = await this.getMemoRecord(input.memoId);
    this.assertRecipient(record.event.recipientAgentId, 'mark this memo read');
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
        recipientAgentId: record.event.recipientAgentId,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      };
      await this.repository.insertEvent(event);
    });
    await this.projectionWriter.syncAgent(record.event.recipientAgentId);
    return await this.getMemoRecord(input.memoId);
  }

  private async archiveMemo(input: {
    memoId: string;
    idempotencyKey?: string;
  }): Promise<MemoRecord> {
    const record = await this.getMemoRecord(input.memoId);
    this.assertRecipient(record.event.recipientAgentId, 'archive this memo');
    if (record.archived) return record;
    await this.repository.transaction(async () => {
      const prior = await this.priorMutation(input.idempotencyKey, 'memo.archived');
      if (prior) return;
      const event: SynomemEvent = {
        ...this.eventBase(
          record.event.id,
          await this.repository.nextAggregateVersion(record.event.id),
        ),
        type: 'memo.archived',
        memoId: record.event.id,
        recipientAgentId: record.event.recipientAgentId,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      };
      await this.repository.insertEvent(event);
    });
    await this.projectionWriter.syncAgent(record.event.recipientAgentId);
    return await this.getMemoRecord(input.memoId);
  }

  private async getPostRecord(id: string): Promise<PostRecord> {
    await this.requireVisibleItem(id, 'post');
    const record = postRecordsFromEvents(await this.repository.getReadableItemEvents(id))[0];
    if (!record) throw new SynomemError('ITEM_NOT_FOUND', `Unknown post: ${id}`);
    return record;
  }

  private async getPost(id: string): Promise<PostRecord> {
    this.checkAbort();
    return await this.getPostRecord(id);
  }

  private async createPost(input: CreatePostInput): Promise<{
    record: PostRecord;
    created: boolean;
    deduplicated: boolean;
  }> {
    this.checkAbort();
    await this.repository.assertEventCompatibility();
    const parsed = this.validate(() => createPostSchema.parse(input));

    // A reply inherits its parent's workspace by construction, and cannot name
    // a different target — there is no target to name.
    if (parsed.replyTo) await this.requireVisibleItem(parsed.replyTo, 'post');

    const outcome = await this.repository.transaction(async () => {
      const prior = await this.priorMutation(parsed.idempotencyKey, 'post.created');
      if (prior?.type === 'post.created') return { id: prior.id, created: false };
      const id = this.nextId();
      const event: SynomemEvent = {
        ...this.eventBase(id, 1, id),
        type: 'post.created',
        title: parsed.title,
        body: parsed.body,
        tags: [...new Set(parsed.tags ?? [])].sort(),
        ...(parsed.replyTo ? { replyTo: parsed.replyTo } : {}),
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
    if (this.administrative) return;
    if (record.event.actor.id !== this.actor.id || record.event.actor.kind !== this.actor.kind) {
      throw new SynomemError('MUTATION_FORBIDDEN', 'Only the author can change a post.');
    }
  }

  private async updatePost(input: UpdatePostInput): Promise<PostRecord> {
    this.checkAbort();
    const parsed = this.validate(() => updatePostSchema.parse(input));
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
        ...this.eventBase(parsed.postId, await this.repository.nextAggregateVersion(parsed.postId)),
        type: 'post.edited',
        postId: parsed.postId,
        title: parsed.title ?? record.title,
        body: parsed.body ?? record.body,
        tags: [...new Set(parsed.tags ?? record.tags ?? [])].sort(),
        ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
      };
      await this.repository.insertEvent(event);
    });
    return await this.getPostRecord(parsed.postId);
  }

  private async archivePost(input: {
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
    postId: string;
    reason?: string;
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
    return record;
  }
  private async getNote(id: string): Promise<NoteRecord> {
    this.checkAbort();
    return await this.getNoteRecord(id);
  }

  private async createNote(input: CreateNoteInput): Promise<CreateNoteResult> {
    this.checkAbort();
    await this.repository.assertEventCompatibility();
    const parsed = this.validate(() => createNoteSchema.parse(input));
    const ownerId =
      parsed.ownerAgentId ?? (this.actor.kind === 'agent' ? this.actor.id : undefined);
    if (!ownerId)
      throw new SynomemError('INVALID_INPUT', 'A human or system actor must specify ownerAgentId.');
    const owner = await this.repository.getAgent(ownerId);
    if (!owner) throw new SynomemError('AGENT_NOT_FOUND', `Unknown note owner: ${ownerId}`);
    if (!this.administrative && (this.actor.kind !== 'agent' || this.actor.id !== owner.id)) {
      throw new SynomemError('MUTATION_FORBIDDEN', 'Agents may create notes only for themselves.');
    }
    const outcome = await this.repository.transaction(async () => {
      const prior = await this.priorMutation(parsed.idempotencyKey, 'note.created');
      if (prior?.type === 'note.created') return { id: prior.id, created: false };
      const id = this.nextId();
      const event: SynomemEvent = {
        ...this.eventBase(id, 1, id),
        type: 'note.created',
        ownerAgentId: owner.id,
        ownerDisplayName: owner.displayName,
        title: parsed.title,
        body: parsed.body,
        tags: [...new Set(parsed.tags ?? [])].sort(),
        visibility: 'private',
        ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
        ...(parsed.source ? { source: parsed.source } : {}),
        ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
      };
      await this.repository.insertEvent(event);
      return { id, created: true };
    });
    if (outcome.created) await this.projectionWriter.syncAgent(owner.id);
    return {
      record: await this.getNoteRecord(outcome.id),
      created: outcome.created,
      deduplicated: !outcome.created,
    };
  }

  private assertNoteOwner(record: NoteRecord): void {
    if (
      !this.administrative &&
      !(this.actor.kind === 'agent' && this.actor.id === record.event.ownerAgentId)
    ) {
      throw new SynomemError(
        'MUTATION_FORBIDDEN',
        'Only the note owner or a human administrator may change it.',
      );
    }
  }

  private async reviseNote(input: ReviseNoteInput): Promise<NoteRecord> {
    const parsed = this.validate(() => reviseNoteSchema.parse(input));
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
        ...this.eventBase(record.event.id, parsed.expectedVersion + 1),
        type: 'note.revised',
        noteId: record.event.id,
        title: parsed.title ?? record.current.title,
        body: parsed.body ?? record.current.body,
        tags: parsed.tags ?? record.current.tags,
        visibility: 'private',
        ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
        ...(parsed.source ? { source: parsed.source } : {}),
        ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
      };
      await this.repository.insertEvent(event);
    });
    await this.projectionWriter.syncAgent(record.event.ownerAgentId);
    return await this.getNoteRecord(parsed.noteId);
  }

  private async archiveNote(input: {
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
    await this.projectionWriter.syncAgent(record.event.ownerAgentId);
    return await this.getNoteRecord(input.noteId);
  }

  private async getTaskRecord(id: string): Promise<TaskRecord> {
    await this.requireVisibleItem(id, 'task');
    const record = taskRecordsFromEvents(await this.repository.getReadableItemEvents(id))[0];
    if (!record) throw new SynomemError('TODO_NOT_FOUND', `Unknown task: ${id}`);
    return record;
  }
  private async getTask(id: string): Promise<TaskRecord> {
    this.checkAbort();
    return await this.getTaskRecord(id);
  }

  private async createTask(input: CreateTaskInput): Promise<CreateTaskResult> {
    this.checkAbort();
    await this.repository.assertEventCompatibility();
    const parsed = this.validate(() => createTaskSchema.parse(input));
    const assigneeId =
      parsed.assigneeAgentId ?? (this.actor.kind === 'agent' ? this.actor.id : undefined);
    if (!assigneeId)
      throw new SynomemError(
        'INVALID_INPUT',
        'A human or system actor must specify assigneeAgentId.',
      );
    const assignee = await this.repository.getAgent(assigneeId);
    if (!assignee)
      throw new SynomemError('AGENT_NOT_FOUND', `Unknown task assignee: ${assigneeId}`);
    if (
      this.actor.kind === 'agent' &&
      this.actor.id !== assignee.id &&
      !this.repository.config.allowCrossAgentTasks
    )
      throw new SynomemError('POLICY_FORBIDDEN', 'Cross-agent task assignment is disabled.');
    const outcome = await this.repository.transaction(async () => {
      const prior = await this.priorMutation(parsed.idempotencyKey, 'task.created');
      if (prior?.type === 'task.created') return { id: prior.id, created: false };
      const id = this.nextId();
      const requiresAcceptance = this.actor.kind !== 'agent' || this.actor.id !== assignee.id;
      const event: SynomemEvent = {
        ...this.eventBase(id, 1, id),
        type: 'task.created',
        assigneeAgentId: assignee.id,
        assigneeDisplayName: assignee.displayName,
        title: parsed.title,
        ...(parsed.description !== undefined ? { description: parsed.description } : {}),
        priority: parsed.priority ?? 3,
        ...(parsed.due ? { due: parsed.due } : {}),
        tags: [...new Set(parsed.tags ?? [])].sort(),
        visibility: parsed.visibility ?? this.repository.config.defaultVisibility,
        requiresAcceptance,
        ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
        ...(parsed.source ? { source: parsed.source } : {}),
        ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
      };
      await this.repository.insertEvent(event);
      return { id, created: true };
    });
    if (outcome.created) await this.projectionWriter.syncAgent(assignee.id);
    return {
      record: await this.getTaskRecord(outcome.id),
      created: outcome.created,
      deduplicated: !outcome.created,
    };
  }

  private assertTaskParticipant(record: TaskRecord): void {
    const isCreator =
      record.event.actor.kind === this.actor.kind && record.event.actor.id === this.actor.id;
    const isAssignee =
      this.actor.kind === 'agent' && this.actor.id === record.event.assigneeAgentId;
    if (!this.administrative && !isCreator && !isAssignee)
      throw new SynomemError(
        'MUTATION_FORBIDDEN',
        'Only the task creator, assignee, or a human administrator may change it.',
      );
  }

  private assertTaskAssignee(record: TaskRecord): void {
    if (
      !this.administrative &&
      !(this.actor.kind === 'agent' && this.actor.id === record.event.assigneeAgentId)
    ) {
      throw new SynomemError(
        'MUTATION_FORBIDDEN',
        'Only the assigned agent or a human administrator may accept or reject this task.',
      );
    }
  }

  private async updateTask(input: UpdateTaskInput): Promise<TaskRecord> {
    const parsed = this.validate(() => updateTaskSchema.parse(input));
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
        visibility: parsed.visibility ?? record.current.visibility,
        ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
        ...(parsed.source ? { source: parsed.source } : {}),
        ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
      };
      await this.repository.insertEvent(event);
    });
    await this.projectionWriter.syncAgent(record.event.assigneeAgentId);
    return await this.getTaskRecord(parsed.taskId);
  }

  private async taskTransition(
    input: {
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
    await this.projectionWriter.syncAgent(record.event.assigneeAgentId);
    return await this.getTaskRecord(input.taskId);
  }
  private completeTask(input: { taskId: string; note?: string; idempotencyKey?: string }) {
    return this.taskTransition(input, 'task.completed');
  }
  private acceptTask(input: { taskId: string; response?: string; idempotencyKey?: string }) {
    return this.taskTransition(input, 'task.accepted');
  }
  private rejectTask(input: { taskId: string; response: string; idempotencyKey?: string }) {
    return this.taskTransition(input, 'task.rejected');
  }
  private reopenTask(input: { taskId: string; idempotencyKey?: string }) {
    return this.taskTransition(input, 'task.reopened');
  }
  private cancelTask(input: { taskId: string; reason?: string; idempotencyKey?: string }) {
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
    const outcome = await this.repository.transaction(async () => {
      const prior = await this.priorMutation(parsed.idempotencyKey, 'todo.created');
      if (prior?.type === 'todo.created') return { id: prior.id, created: false };
      const id = this.nextId();
      const event: SynomemEvent = {
        ...this.eventBase(id, 1, id),
        type: 'todo.created',
        title: parsed.title,
        ...(parsed.details !== undefined ? { details: parsed.details } : {}),
        priority: parsed.priority ?? 3,
        ...(parsed.due ? { due: parsed.due } : {}),
        tags: [...new Set(parsed.tags ?? [])].sort(),
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
    return record;
  }

  /**
   * Todos are owner-only. No role, however broad, reads another actor's
   * private reminders — that is a named administrative capability this release
   * does not have, not something a permission check quietly allows.
   */
  private assertTodoOwner(record: TodoRecord): void {
    const owner = record.event.actor;
    if (owner.kind !== this.actor.kind || owner.id !== this.actor.id) {
      throw new SynomemError(
        'MUTATION_FORBIDDEN',
        'A todo is private to the actor who created it.',
      );
    }
  }

  private async getTodo(id: string): Promise<TodoRecord> {
    this.checkAbort();
    return await this.getTodoRecord(id);
  }

  private async updateTodo(input: UpdateTodoInput): Promise<TodoRecord> {
    this.checkAbort();
    const parsed = this.validate(() => updateTodoSchema.parse(input));
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
        ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
      };
      await this.repository.insertEvent(event);
    });
    return await this.getTodoRecord(parsed.todoId);
  }

  private async todoTransition(
    input: { todoId: string; idempotencyKey?: string; note?: string; reason?: string },
    type: 'todo.completed' | 'todo.reopened' | 'todo.canceled' | 'todo.archived',
  ): Promise<TodoRecord> {
    const record = await this.getTodoRecord(input.todoId);
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
      ...(parsed.participantAgentId
        ? { participantAgentId: await this.canonicalAgentId(parsed.participantAgentId) }
        : {}),
      ...(parsed.actorId ? { actorId: await this.canonicalAgentId(parsed.actorId) } : {}),
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
    return this.getTask(id);
  }

  async stats(input: KudosListInput = {}): Promise<KudosStats> {
    this.checkAbort();
    const parsed = this.validate(() => listInputSchema.parse(input));
    const { cursor: _cursor, limit: _limit, offset: _offset, ...filters } = parsed;
    void _cursor;
    void _limit;
    void _offset;
    const recipient = filters.recipientAgentId
      ? await this.repository.getAgent(filters.recipientAgentId)
      : undefined;
    if (filters.recipientAgentId && !recipient) {
      throw new SynomemError('AGENT_NOT_FOUND', `Unknown agent: ${filters.recipientAgentId}`);
    }
    const records: KudosSummary[] = [];
    let cursor: string | undefined;
    const viewer = this.actor;
    let hasMore = true;
    while (hasMore) {
      const page = await this.repository.listKudosSummaries(
        {
          ...filters,
          ...(recipient ? { recipientAgentId: recipient.id } : {}),
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
      stats.byAgent[record.recipientAgentId] = (stats.byAgent[record.recipientAgentId] ?? 0) + 1;
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
const CURRENT_SCHEMA_VERSION = 7;
const EXPECTED_APPLIED_MIGRATIONS = [1, 2, 3, 4, 5, 6, 7];

export class SynomemClient extends SynomemCore implements SynomemService {
  readonly home: string;
  readonly storage: SynomemStorage;
  readonly projections: ProjectionManager;

  constructor(options: SynomemClientOptions = {}) {
    const home = resolveHome(options.home);
    const storage = new SynomemStorage({
      home,
      readOnly: options.readOnly ?? false,
      ...(options.config ? { config: options.config } : {}),
    });
    const projections = new ProjectionManager(storage);
    super({
      repository: storage,
      projectionWriter: projections,
      ...(options.actor ? { actor: options.actor } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.idGenerator ? { idGenerator: options.idGenerator } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
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
    const rows = this.storage.rawEventRows();
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
    const events = scan.events;
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
    return this.storage.getEvent(id);
  }
}
