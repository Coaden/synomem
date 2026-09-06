import type {
  ActorIdentity,
  AgentProfile,
  ChangePage,
  ChangesInput,
  CreateAgentInput,
  CreateNoteInput,
  CreateNoteResult,
  CreateTaskInput,
  CreateTaskResult,
  DoctorResult,
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
  UpdateAgentInput,
  UpdateTaskInput,
} from './types.js';

export interface SynomemServiceCapabilities {
  backend: 'local' | 'remote';
  binding: {
    workspaceId: string;
    actor: ActorIdentity;
  };
  administration: {
    agentCreationViaMcp: boolean;
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
  readonly actor: ActorIdentity;
  readonly agents: {
    create(input: CreateAgentInput): Promise<AgentProfile>;
    update(id: string, changes: UpdateAgentInput): Promise<AgentProfile>;
    get(idOrAlias: string): Promise<AgentProfile>;
    list(): Promise<AgentProfile[]>;
  };
  readonly kudos: {
    give(input: GiveKudosInput): Promise<GiveKudosResult>;
    list(input?: KudosListInput): Promise<Page<KudosSummary>>;
    changes(input?: KudosChangesInput): Promise<ChangePage>;
    get(id: string): Promise<KudosRecord>;
    acknowledge(input: { kudosId: string; note?: string }): Promise<KudosRecord>;
    revoke(input: {
      kudosId: string;
      reason: string;
      administrative?: boolean;
    }): Promise<KudosRecord>;
  };
  readonly memos: {
    send(input: SendMemoInput): Promise<SendMemoResult>;
    list(input?: Omit<ItemListInput, 'kinds'>): Promise<Page<ItemSummary>>;
    get(id: string): Promise<MemoRecord>;
    read(input: { memoId: string; idempotencyKey?: string }): Promise<MemoRecord>;
    archive(input: { memoId: string; idempotencyKey?: string }): Promise<MemoRecord>;
  };
  readonly notes: {
    create(input: CreateNoteInput): Promise<CreateNoteResult>;
    list(input?: Omit<ItemListInput, 'kinds'>): Promise<Page<ItemSummary>>;
    get(id: string): Promise<NoteRecord>;
    revise(input: ReviseNoteInput): Promise<NoteRecord>;
    archive(input: { noteId: string; idempotencyKey?: string }): Promise<NoteRecord>;
  };
  readonly tasks: {
    create(input: CreateTaskInput): Promise<CreateTaskResult>;
    list(input?: Omit<ItemListInput, 'kinds'>): Promise<Page<ItemSummary>>;
    get(id: string): Promise<TaskRecord>;
    update(input: UpdateTaskInput): Promise<TaskRecord>;
    accept(input: { taskId: string; idempotencyKey?: string }): Promise<TaskRecord>;
    reject(input: {
      taskId: string;
      reason?: string;
      idempotencyKey?: string;
    }): Promise<TaskRecord>;
    complete(input: {
      taskId: string;
      note?: string;
      idempotencyKey?: string;
    }): Promise<TaskRecord>;
    reopen(input: { taskId: string; idempotencyKey?: string }): Promise<TaskRecord>;
    cancel(input: {
      taskId: string;
      reason?: string;
      idempotencyKey?: string;
    }): Promise<TaskRecord>;
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
  rebuild(): Promise<ProjectionRebuildResult>;
  capabilities(): Promise<SynomemServiceCapabilities>;
  info(): Promise<SynomemServiceInfo>;
  getCanonicalEvent(id: string): Promise<SynomemEvent | undefined>;
}

export type SynomemServiceFactory = (options: SynomemClientOptions) => SynomemService;
