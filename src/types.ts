export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ActorKind = 'human' | 'agent' | 'system';
export type Visibility = 'private' | 'workspace' | 'public';
export type RecordKind = 'kudos' | 'memo' | 'note' | 'todo';

export interface ActorIdentity {
  kind: ActorKind;
  id: string;
  displayName?: string;
}

export interface EventSource {
  runtime?: string;
  model?: string;
  sessionId?: string;
  repository?: string;
  commit?: string;
  workingDirectory?: string;
}

export type EvidenceKind = 'tool-call' | 'commit' | 'file' | 'url' | 'task' | 'note';
export interface EvidenceReference {
  kind: EvidenceKind;
  label?: string;
  value: string;
}

export interface AgentProfile {
  id: string;
  displayName: string;
  aliases?: string[];
  description?: string;
  createdAt: string;
  metadata?: Record<string, JsonValue>;
}

export interface BaseEvent {
  schemaVersion: 1;
  id: string;
  type: string;
  workspaceId: string;
  aggregateId: string;
  aggregateVersion: number;
  createdAt: string;
  actor: ActorIdentity;
  idempotencyKey?: string;
  source?: EventSource;
  metadata?: Record<string, JsonValue>;
}

export interface KudosGivenEvent extends BaseEvent {
  type: 'kudos.given';
  recipientAgentId: string;
  recipientDisplayName: string;
  title: string;
  reason: string;
  evidence?: EvidenceReference[];
  tags?: string[];
  visibility: Visibility;
}
export interface KudosAcknowledgedEvent extends BaseEvent {
  type: 'kudos.acknowledged';
  kudosId: string;
  recipientAgentId: string;
  note?: string;
}
export interface KudosRevokedEvent extends BaseEvent {
  type: 'kudos.revoked';
  kudosId: string;
  reason: string;
  mode: 'actor-requested' | 'administrative';
}

export interface MemoSentEvent extends BaseEvent {
  type: 'memo.sent';
  recipientAgentId: string;
  recipientDisplayName: string;
  subject: string;
  body: string;
  tags?: string[];
  visibility: Visibility;
}
export interface MemoReadEvent extends BaseEvent {
  type: 'memo.read';
  memoId: string;
  recipientAgentId: string;
}
export interface MemoArchivedEvent extends BaseEvent {
  type: 'memo.archived';
  memoId: string;
  recipientAgentId: string;
}

export interface NoteCreatedEvent extends BaseEvent {
  type: 'note.created';
  ownerAgentId: string;
  ownerDisplayName: string;
  title: string;
  body: string;
  tags?: string[];
  visibility: 'private';
}
export interface NoteRevisedEvent extends BaseEvent {
  type: 'note.revised';
  noteId: string;
  title: string;
  body: string;
  tags?: string[];
  visibility: 'private';
}
export interface NoteArchivedEvent extends BaseEvent {
  type: 'note.archived';
  noteId: string;
}

export type TodoPriority = 1 | 2 | 3 | 4;
export type TodoDue =
  { kind: 'date'; date: string } | { kind: 'datetime'; datetime: string; timeZone: string };
export interface TodoCreatedEvent extends BaseEvent {
  type: 'todo.created';
  assigneeAgentId: string;
  assigneeDisplayName: string;
  title: string;
  description?: string;
  priority: TodoPriority;
  due?: TodoDue;
  tags?: string[];
  visibility: Visibility;
  requiresAcceptance: boolean;
}
export interface TodoUpdatedEvent extends BaseEvent {
  type: 'todo.updated';
  todoId: string;
  title: string;
  description?: string;
  priority: TodoPriority;
  due?: TodoDue;
  tags?: string[];
  visibility: Visibility;
}
export interface TodoCompletedEvent extends BaseEvent {
  type: 'todo.completed';
  todoId: string;
  note?: string;
}
export interface TodoReopenedEvent extends BaseEvent {
  type: 'todo.reopened';
  todoId: string;
}
export interface TodoAcceptedEvent extends BaseEvent {
  type: 'todo.accepted';
  todoId: string;
}
export interface TodoRejectedEvent extends BaseEvent {
  type: 'todo.rejected';
  todoId: string;
  reason?: string;
}
export interface TodoCanceledEvent extends BaseEvent {
  type: 'todo.canceled';
  todoId: string;
  reason?: string;
}

export interface AgentCreatedEvent extends BaseEvent {
  type: 'agent.created';
  agent: AgentProfile;
}
export interface AgentUpdatedEvent extends BaseEvent {
  type: 'agent.updated';
  agentId: string;
  changes: Partial<Omit<AgentProfile, 'id' | 'createdAt'>>;
}

export type SynomemEvent =
  | KudosGivenEvent
  | KudosAcknowledgedEvent
  | KudosRevokedEvent
  | MemoSentEvent
  | MemoReadEvent
  | MemoArchivedEvent
  | NoteCreatedEvent
  | NoteRevisedEvent
  | NoteArchivedEvent
  | TodoCreatedEvent
  | TodoUpdatedEvent
  | TodoCompletedEvent
  | TodoReopenedEvent
  | TodoAcceptedEvent
  | TodoRejectedEvent
  | TodoCanceledEvent
  | AgentCreatedEvent
  | AgentUpdatedEvent;

export type AcknowledgmentStatus = 'acknowledged' | 'unacknowledged';
export type RevocationStatus = 'revoked' | 'active';
export interface KudosRecord {
  event: KudosGivenEvent;
  acknowledgment?: KudosAcknowledgedEvent;
  revocation?: KudosRevokedEvent;
  status: AcknowledgmentStatus;
  revocationStatus: RevocationStatus;
}
export interface MemoRecord {
  event: MemoSentEvent;
  read?: MemoReadEvent;
  archived?: MemoArchivedEvent;
  status: 'unread' | 'read' | 'archived';
}
export interface NoteRecord {
  event: NoteCreatedEvent;
  revision?: NoteRevisedEvent;
  archived?: NoteArchivedEvent;
  current: { title: string; body: string; tags: string[]; visibility: Visibility; version: number };
  status: 'active' | 'archived';
}
export interface TodoRecord {
  event: TodoCreatedEvent;
  update?: TodoUpdatedEvent;
  terminal?: TodoCompletedEvent | TodoRejectedEvent | TodoCanceledEvent;
  reopened?: TodoReopenedEvent;
  current: {
    title: string;
    description?: string;
    priority: TodoPriority;
    due?: TodoDue;
    tags: string[];
    visibility: Visibility;
    version: number;
  };
  status: 'assigned' | 'open' | 'completed' | 'rejected' | 'canceled';
}
export type ItemRecord = KudosRecord | MemoRecord | NoteRecord | TodoRecord;

export interface ItemSummary {
  id: string;
  kind: RecordKind;
  createdAt: string;
  updatedAt: string;
  actor: ActorIdentity;
  title: string;
  tags: string[];
  visibility: Visibility;
  status: string;
  recipientAgentId?: string;
  ownerAgentId?: string;
  assigneeAgentId?: string;
}
export interface KudosSummary extends ItemSummary {
  kind: 'kudos';
  recipientAgentId: string;
  recipientDisplayName: string;
  status: AcknowledgmentStatus;
  revocationStatus: RevocationStatus;
}

export interface PaginationInput {
  limit?: number;
  cursor?: string;
  /** @deprecated */ offset?: number;
}
export interface ItemListInput extends PaginationInput {
  kinds?: RecordKind[];
  participantAgentId?: string;
  actorId?: string;
  actorKind?: ActorKind;
  tag?: string;
  status?: string;
  visibility?: Visibility;
  from?: string;
  to?: string;
  /** Limit results to actionable inbox states; intended for the participant's own inbox. */
  pending?: boolean;
}
export interface KudosListInput extends PaginationInput {
  recipientAgentId?: string;
  actorId?: string;
  actorKind?: ActorKind;
  tag?: string;
  status?: AcknowledgmentStatus;
  visibility?: Visibility;
  revoked?: boolean;
  from?: string;
  to?: string;
}
export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  nextCursor?: string;
  hasMore: boolean;
  watermark: string;
  contextLimited: boolean;
}
export interface ItemChange {
  cursor: string;
  sequence: number;
  eventId: string;
  type: SynomemEvent['type'];
  createdAt: string;
  actor: ActorIdentity;
  itemId?: string;
  kind?: RecordKind;
  summary?: ItemSummary;
  /** Present for kudos changes. */ kudosId?: string;
  /** Present for direct-recipient changes. */ recipientAgentId?: string;
}
export interface KudosChange extends ItemChange {
  kudosId?: string;
  recipientAgentId?: string;
  summary?: KudosSummary;
}
export interface ChangesInput {
  after?: string;
  limit?: number;
  kinds?: RecordKind[];
}
export type KudosChangesInput = ChangesInput;
export interface ChangePage {
  items: ItemChange[];
  limit: number;
  nextCursor?: string;
  hasMore: boolean;
  watermark: string;
  contextLimited: boolean;
}

interface MutationInput {
  idempotencyKey?: string;
  source?: EventSource;
  metadata?: Record<string, JsonValue>;
}
export interface GiveKudosInput extends MutationInput {
  recipientAgentId: string;
  title: string;
  reason: string;
  evidence?: EvidenceReference[];
  tags?: string[];
  visibility?: Visibility;
}
export interface SendMemoInput extends MutationInput {
  recipientAgentId: string;
  subject: string;
  body: string;
  tags?: string[];
  visibility?: Visibility;
}
export interface CreateNoteInput extends MutationInput {
  ownerAgentId?: string;
  title: string;
  body: string;
  tags?: string[];
}
export interface ReviseNoteInput extends MutationInput {
  noteId: string;
  expectedVersion: number;
  title?: string;
  body?: string;
  tags?: string[];
}
export interface CreateTodoInput extends MutationInput {
  assigneeAgentId?: string;
  title: string;
  description?: string;
  priority?: TodoPriority;
  due?: TodoDue;
  tags?: string[];
  visibility?: Visibility;
}
export interface UpdateTodoInput extends MutationInput {
  todoId: string;
  expectedVersion: number;
  title?: string;
  description?: string;
  priority?: TodoPriority;
  due?: TodoDue | null;
  tags?: string[];
  visibility?: Visibility;
}
export interface MutationResult<T> {
  record: T;
  created: boolean;
  deduplicated: boolean;
}
export type GiveKudosResult = MutationResult<KudosRecord>;
export type SendMemoResult = MutationResult<MemoRecord>;
export type CreateNoteResult = MutationResult<NoteRecord>;
export type CreateTodoResult = MutationResult<TodoRecord>;

export interface CreateAgentInput {
  id: string;
  displayName: string;
  aliases?: string[];
  description?: string;
  metadata?: Record<string, JsonValue>;
}
export interface UpdateAgentInput {
  displayName?: string;
  aliases?: string[];
  description?: string;
  metadata?: Record<string, JsonValue>;
}
export interface KudosStats {
  total: number;
  active: number;
  acknowledged: number;
  revoked: number;
  byAgent: Record<string, number>;
  byActor: Record<string, number>;
  byTag: Record<string, number>;
}
export interface Diagnostic {
  level: 'ok' | 'warning' | 'error';
  code: string;
  message: string;
  path?: string;
}
export interface DoctorResult {
  healthy: boolean;
  diagnostics: Diagnostic[];
}

export type SynomemBackendConfig =
  { kind: 'local' } | { kind: 'remote'; baseUrl: string; workspaceId: string };

export interface SynomemConfig {
  schemaVersion: 3;
  backend: SynomemBackendConfig;
  workspaceId: string;
  defaultVisibility: Visibility;
  allowSelfAwards: boolean;
  allowCrossAgentTodos: boolean;
  allowAgentCreationViaMcp: boolean;
  allowRebuildViaMcp: boolean;
  includePrivateInStats: boolean;
  projection: {
    writeWinsMarkdown: boolean;
    writeMemoryMarkdown: boolean;
    writeTodosMarkdown: boolean;
    writeInboxEntries: boolean;
  };
}
export type SynomemConfigOverrides = Omit<Partial<SynomemConfig>, 'projection' | 'backend'> & {
  projection?: Partial<SynomemConfig['projection']>;
  backend?: SynomemBackendConfig;
};
export interface SynomemClientOptions {
  home?: string;
  actor?: ActorIdentity;
  clock?: () => Date;
  idGenerator?: () => string;
  readOnly?: boolean;
  config?: SynomemConfigOverrides;
  signal?: AbortSignal;
}
