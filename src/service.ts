import type {
  ActorDirectoryInput,
  ActorDirectoryPage,
  ActorProfile,
  ActorProfileInput,
} from './actor-directory.js';
import type { BookmarkInput, BookmarkPage } from './bookmarks.js';
import type { SearchInput, SearchPage } from './search.js';
import type { NotificationInput, NotificationPage } from './notifications.js';
import type {
  ReplyCreateInput,
  ReplyDeleteInput,
  ReplyRecord,
  ReactionSetInput,
  ReactionSummary,
  ThreadInput,
  ThreadPage,
} from './participation.js';
import type { OverrideTaskDecisionInput } from './types.js';
import type { ActorRef, AddressableActor } from './policy.js';
import type {
  ActorIdentity,
  AgentDirectoryEntry,
  AgentProfile,
  CreatePostInput,
  PostRecord,
  PostRoster,
  UpdatePostInput,
  AgentResolution,
  AgentRuntimeBinding,
  BindRuntimeInput,
  ChangePage,
  ChangesInput,
  CreateAgentInput,
  CreateNoteInput,
  CreateNoteResult,
  CreateTaskInput,
  CreateTodoInput,
  CreateTodoResult,
  CreateTaskResult,
  DoctorResult,
  ProjectionStatus,
  GiveKudosInput,
  GiveKudosResult,
  ItemListInput,
  ItemRecord,
  ItemSummary,
  KudosChangesInput,
  KudosListInput,
  KudosRecord,
  KudosStats,
  KudosSummary,
  MemoRecord,
  SynomemClientOptions,
  SynomemEvent,
  NoteRecord,
  Page,
  ReviseNoteInput,
  SendMemoInput,
  SendMemoResult,
  TaskRecord,
  TodoRecord,
  UpdateAgentInput,
  UpdateTaskInput,
  UpdateTodoInput,
  Topic,
  CreateTopicInput,
  UpdateTopicInput,
  TopicListInput,
  TopicResolution,
} from './types.js';

export interface SynomemServiceCapabilities {
  backend: 'local' | 'remote';
  participation?: {
    version: 2;
    replies: boolean;
    reactions: boolean;
    personalInbox: boolean;
    search?: boolean;
    canWrite: boolean;
    administrator: boolean;
    managedAgentIds: string[];
  };
  binding: {
    workspaceId: string;
    actor: ActorIdentity;
    /** The stable context this service is bound to, when the backend reports one. */
    contextId?: string;
  };
  administration: {
    agentCreationViaMcp: boolean;
    agentArchiveViaMcp: boolean;
    rebuildViaMcp: boolean;
  };
  projections: {
    writeWinsMarkdown: boolean;
    writeMemoryMarkdown: boolean;
    writeTasksMarkdown: boolean;
    writeInboxEntries: boolean;
  };
}

export type SynomemServiceInfo =
  | { backend: 'local'; home: string; databasePath: string }
  | { backend: 'remote'; baseUrl: string; workspaceId: string };

export interface ProjectionRebuildResult {
  generated: string[];
  removed: string[];
}

export interface SynomemDomainService {
  readonly bookmarks: {
    list(input?: BookmarkInput): Promise<BookmarkPage>;
    has(rootId: string): Promise<{ saved: boolean }>;
    set(input: { rootId: string; present: boolean }): Promise<{ saved: boolean }>;
  };
  search(input: SearchInput): Promise<SearchPage>;
  readonly notifications: {
    list(input?: NotificationInput): Promise<NotificationPage>;
    read(id: string): Promise<void>;
    dismiss(id: string): Promise<void>;
    readThrough(through: string): Promise<void>;
  };

  readonly replies: {
    changes(input: ThreadInput): Promise<ThreadPage>;
    create(input: ReplyCreateInput): Promise<ReplyRecord>;
    get(id: string): Promise<ReplyRecord>;
    delete(input: ReplyDeleteInput): Promise<ReplyRecord>;
  };
  readonly threads: {
    read(input: { rootId: string; through: string }): Promise<void>;
    get(input: ThreadInput): Promise<ThreadPage>;
    subscription(input: { rootId: string; following: boolean; muted: boolean }): Promise<void>;
  };
  readonly reactions: {
    set(input: ReactionSetInput): Promise<ReactionSummary>;
    get(targetId: string): Promise<ReactionSummary>;
  };

  readonly actor: ActorIdentity;
  readonly actors: {
    profile(input: ActorProfileInput): Promise<ActorProfile>;
    list(input?: ActorDirectoryInput): Promise<ActorDirectoryPage>;
    get(ref: ActorRef): Promise<AddressableActor>;
    registerHuman(input: {
      id: string;
      handle: string;
      displayName: string;
    }): Promise<AddressableActor>;
  };
  readonly agents: {
    create(input: CreateAgentInput): Promise<AgentProfile>;
    update(id: string, changes: UpdateAgentInput): Promise<AgentProfile>;
    get(idOrAlias: string): Promise<AgentProfile>;
    list(): Promise<AgentProfile[]>;
    resolve(query: string): Promise<AgentResolution>;
    archive(idOrAlias: string): Promise<AgentProfile>;
    restore(idOrAlias: string): Promise<AgentProfile>;
    addAliases(idOrAlias: string, aliases: string[]): Promise<AgentProfile>;
    removeAliases(idOrAlias: string, aliases: string[]): Promise<AgentProfile>;
    directory(): Promise<AgentDirectoryEntry[]>;
    bindings(idOrAlias: string): Promise<AgentRuntimeBinding[]>;
    bindRuntime(input: BindRuntimeInput): Promise<AgentRuntimeBinding>;
    unbindRuntime(bindingId: string): Promise<boolean>;
  };
  /**
   * A controlled, reusable subject a record can be filed under — one
   * canonical display name and a set of aliases, distinct from a tag.
   */
  readonly topics: {
    create(input: CreateTopicInput): Promise<Topic>;
    update(idOrAlias: string, changes: UpdateTopicInput): Promise<Topic>;
    get(idOrAlias: string): Promise<Topic>;
    list(input?: TopicListInput): Promise<Topic[]>;
    resolve(query: string): Promise<TopicResolution>;
    archive(idOrAlias: string): Promise<Topic>;
    restore(idOrAlias: string): Promise<Topic>;
  };
  readonly posts: {
    create(input: CreatePostInput): Promise<{
      record: PostRecord;
      created: boolean;
      deduplicated: boolean;
    }>;
    list(input?: Omit<ItemListInput, 'kinds'>): Promise<Page<ItemSummary>>;
    get(id: string): Promise<PostRecord>;
    update(input: UpdatePostInput): Promise<PostRecord>;
    archive(input: {
      expectedVersion: number;
      postId: string;
      reason?: string;
      idempotencyKey?: string;
    }): Promise<PostRecord>;
    acknowledge(input: {
      expectedVersion: number;
      postId: string;
      note?: string;
      idempotencyKey?: string;
    }): Promise<PostRecord>;
    withdrawAcknowledgment(input: {
      expectedVersion: number;
      postId: string;
      reason?: string;
      idempotencyKey?: string;
    }): Promise<PostRecord>;
    roster(postId: string): Promise<PostRoster>;
  };
  readonly kudos: {
    give(input: GiveKudosInput): Promise<GiveKudosResult>;
    list(input?: KudosListInput): Promise<Page<KudosSummary>>;
    changes(input?: KudosChangesInput): Promise<ChangePage>;
    get(id: string): Promise<KudosRecord>;
    acknowledge(input: {
      expectedVersion: number;
      kudosId: string;
      note?: string;
      idempotencyKey?: string;
    }): Promise<KudosRecord>;
    revoke(input: {
      expectedVersion: number;
      kudosId: string;
      reason: string;
      administrative?: boolean;
      idempotencyKey?: string;
    }): Promise<KudosRecord>;
  };
  readonly memos: {
    send(input: SendMemoInput): Promise<SendMemoResult>;
    list(input?: Omit<ItemListInput, 'kinds'>): Promise<Page<ItemSummary>>;
    get(id: string): Promise<MemoRecord>;
    read(input: {
      expectedVersion: number;
      memoId: string;
      idempotencyKey?: string;
    }): Promise<MemoRecord>;
    archive(input: {
      expectedVersion: number;
      memoId: string;
      idempotencyKey?: string;
    }): Promise<MemoRecord>;
  };
  readonly notes: {
    create(input: CreateNoteInput): Promise<CreateNoteResult>;
    list(input?: Omit<ItemListInput, 'kinds'>): Promise<Page<ItemSummary>>;
    get(id: string): Promise<NoteRecord>;
    revise(input: ReviseNoteInput): Promise<NoteRecord>;
    archive(input: {
      expectedVersion: number;
      noteId: string;
      idempotencyKey?: string;
    }): Promise<NoteRecord>;
  };
  readonly tasks: {
    overrideDecision(input: OverrideTaskDecisionInput): Promise<TaskRecord>;
    create(input: CreateTaskInput): Promise<CreateTaskResult>;
    list(input?: Omit<ItemListInput, 'kinds'>): Promise<Page<ItemSummary>>;
    get(id: string): Promise<TaskRecord>;
    update(input: UpdateTaskInput): Promise<TaskRecord>;
    accept(input: {
      expectedVersion: number;
      taskId: string;
      /** Optional: conditions, timing, or partial capability. */
      response?: string;
      idempotencyKey?: string;
    }): Promise<TaskRecord>;
    reject(input: {
      expectedVersion: number;
      taskId: string;
      /** Required: a refusal the assigner cannot act on is barely an answer. */
      response: string;
      idempotencyKey?: string;
    }): Promise<TaskRecord>;
    complete(input: {
      expectedVersion: number;
      taskId: string;
      note?: string;
      idempotencyKey?: string;
    }): Promise<TaskRecord>;
    reopen(input: {
      expectedVersion: number;
      taskId: string;
      idempotencyKey?: string;
    }): Promise<TaskRecord>;
    cancel(input: {
      expectedVersion: number;
      taskId: string;
      reason?: string;
      idempotencyKey?: string;
    }): Promise<TaskRecord>;
  };
  /**
   * Private self-reminders. No assignee, no acceptance, owner-only reads.
   */
  readonly todos: {
    create(input: CreateTodoInput): Promise<CreateTodoResult>;
    list(input?: Omit<ItemListInput, 'kinds'>): Promise<Page<ItemSummary>>;
    get(id: string): Promise<TodoRecord>;
    update(input: UpdateTodoInput): Promise<TodoRecord>;
    complete(input: {
      expectedVersion: number;
      todoId: string;
      note?: string;
      idempotencyKey?: string;
    }): Promise<TodoRecord>;
    reopen(input: {
      expectedVersion: number;
      todoId: string;
      idempotencyKey?: string;
    }): Promise<TodoRecord>;
    cancel(input: {
      expectedVersion: number;
      todoId: string;
      reason?: string;
      idempotencyKey?: string;
    }): Promise<TodoRecord>;
    archive(input: {
      expectedVersion: number;
      todoId: string;
      idempotencyKey?: string;
    }): Promise<TodoRecord>;
  };
  /**
   * Unanswered and overdue discovery. Derived from durable events; never a
   * statement about whether an agent is reachable.
   */
  readonly discovery: {
    unanswered(
      input?: Omit<ItemListInput, 'awaitingResponse' | 'pending'> & { olderThanHours?: number },
    ): Promise<Page<ItemSummary>>;
    overdue(
      input?: Omit<ItemListInput, 'overdueAsOf'> & { asOf?: string },
    ): Promise<Page<ItemSummary>>;
  };
  readonly items: {
    list(input?: ItemListInput): Promise<Page<ItemSummary>>;
    get(id: string): Promise<ItemRecord>;
    changes(input?: ChangesInput): Promise<ChangePage>;
  };

  init(): Promise<void>;
  close(): Promise<void>;
  stats(input?: KudosListInput): Promise<KudosStats>;
}

export interface SynomemService extends SynomemDomainService {
  doctor(): Promise<DoctorResult>;
  export(format: 'json' | 'jsonl' | 'markdown'): Promise<string>;
  backup?(destination: string): Promise<string>;
  /*
   * Optional, because only a backend that writes projected files can report on
   * them. The remote backend keeps no filesystem projections at all, and
   * inventing an empty answer there would read as "nothing is stale" rather
   * than "there is nothing to be stale".
   */
  projectionStatus?(): Promise<ProjectionStatus>;
  rebuild(): Promise<ProjectionRebuildResult>;
  capabilities(): Promise<SynomemServiceCapabilities>;
  info(): Promise<SynomemServiceInfo>;
  getCanonicalEvent(id: string): Promise<SynomemEvent | undefined>;
}

export type SynomemServiceFactory = (options: SynomemClientOptions) => SynomemService;
