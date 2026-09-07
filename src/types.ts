export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ActorKind = 'human' | 'agent' | 'system';
export type Visibility = 'private' | 'workspace' | 'public';
export type RecordKind = 'kudos' | 'memo' | 'note' | 'post' | 'task' | 'todo';

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
  /**
   * Canonical, opaque, immutable. Every event references this, so it can never
   * change — which is exactly why the handle exists separately.
   */
  id: string;
  /** The human-friendly name, unique in the workspace and safe to rename. */
  handle: string;
  displayName: string;
  aliases?: string[];
  description?: string;
  /**
   * Archived agents keep their history and stop being able to act. Events
   * reference the actor permanently, so deletion would leave history pointing
   * at nothing.
   */
  status: 'active' | 'archived';
  createdAt: string;
  metadata?: Record<string, JsonValue>;
}

/**
 * Where an agent is currently reachable, as far as Synomem has been told.
 *
 * A binding is a claim made at registration, not a live connection. `lastSeenAt`
 * is advisory: it says when Synomem last observed this binding act, never that
 * the runtime is reachable now. Callers must not treat its absence as offline.
 */
export interface AgentRuntimeBinding {
  id: string;
  agentId: string;
  /** Hosted deployment this binding belongs to; absent for local installs. */
  installationId?: string;
  /** Runtime family, e.g. `claude-code`, `hermes`, `openai-agents`. */
  runtime: string;
  /** Named configuration within a runtime, when one runtime hosts several. */
  profile?: string;
  capabilities: Record<string, JsonValue>;
  boundAt: string;
  lastSeenAt?: string;
}

/**
 * One agent as the directory exposes it: visible identity plus advisory
 * reachability.
 *
 * Roles and capabilities are deliberately absent. Authorization is decided by
 * the control plane against the caller's credential, so publishing a role here
 * would only invite a reader to treat the directory as a permission check.
 */
export interface AgentDirectoryEntry {
  profile: AgentProfile;
  runtimeBindings: AgentRuntimeBinding[];
}

/**
 * The outcome of resolving a name, which may legitimately name no one or
 * several.
 *
 * `match` is set only when exactly one agent answers to the name. Anything else
 * hands back `candidates` so the caller can ask rather than pick.
 */
export interface AgentResolution {
  query: string;
  match?: AgentProfile;
  candidates: AgentProfile[];
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

/**
 * A Post is publication: an author says something to the whole workspace rather
 * than to a named recipient.
 *
 * It has no recipient and no assignee, which is what separates it from a memo
 * and a task. Everyone who can read the workspace can read it, and each of them
 * can acknowledge it independently — a memo is read by one person, a post by
 * many, so "who has responded" is the interesting question rather than "was it
 * read".
 */
export interface PostCreatedEvent extends BaseEvent {
  type: 'post.created';
  title: string;
  body: string;
  tags?: string[];
  /** The post this replies to. A reply inherits its parent's workspace. */
  replyTo?: string;
}
export interface PostEditedEvent extends BaseEvent {
  type: 'post.edited';
  postId: string;
  title: string;
  body: string;
  tags?: string[];
}
export interface PostArchivedEvent extends BaseEvent {
  type: 'post.archived';
  postId: string;
  reason?: string;
}
/**
 * One actor saying "I have seen this", and only ever about themselves.
 *
 * Appended by an explicit call. Reading a post never acknowledges it: a roster
 * built from read receipts would answer "whose client fetched this", which for
 * an agent means "whose runtime happened to poll".
 */
export interface PostAcknowledgedEvent extends BaseEvent {
  type: 'post.acknowledged';
  postId: string;
  note?: string;
}
export interface PostAcknowledgmentWithdrawnEvent extends BaseEvent {
  type: 'post.acknowledgment.withdrawn';
  postId: string;
  reason?: string;
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

export type TaskPriority = 1 | 2 | 3 | 4;
export type TaskDue =
  { kind: 'date'; date: string } | { kind: 'datetime'; datetime: string; timeZone: string };
export interface TaskCreatedEvent extends BaseEvent {
  type: 'task.created';
  assigneeAgentId: string;
  assigneeDisplayName: string;
  title: string;
  description?: string;
  priority: TaskPriority;
  due?: TaskDue;
  tags?: string[];
  visibility: Visibility;
  requiresAcceptance: boolean;
}
export interface TaskUpdatedEvent extends BaseEvent {
  type: 'task.updated';
  taskId: string;
  title: string;
  description?: string;
  priority: TaskPriority;
  due?: TaskDue;
  tags?: string[];
  visibility: Visibility;
}
export interface TaskCompletedEvent extends BaseEvent {
  type: 'task.completed';
  taskId: string;
  note?: string;
}
export interface TaskReopenedEvent extends BaseEvent {
  type: 'task.reopened';
  taskId: string;
}
export interface TaskAcceptedEvent extends BaseEvent {
  type: 'task.accepted';
  taskId: string;
  /**
   * An optional note explaining conditions, timing, or partial capability.
   * "Accepted; I can send email but do not have iMessage access."
   */
  response?: string;
}
export interface TaskRejectedEvent extends BaseEvent {
  type: 'task.rejected';
  taskId: string;
  /**
   * Required. A refusal without a reason is the least useful event the system
   * can record: the assigner learns only that the work will not happen, not
   * whether to reassign it, wait, or change the request.
   * "Rejected; this Hermes profile has no outbound messaging connection."
   */
  response: string;
}
export interface TaskCanceledEvent extends BaseEvent {
  type: 'task.canceled';
  taskId: string;
  reason?: string;
}

/**
 * A Todo is a private reminder an agent creates for itself.
 *
 * The distinction from a Task is the whole point of having both:
 *
 *   Task — something another actor asks an agent to do
 *   Todo — something an agent privately reminds itself to do
 *
 * So a Todo has no assignee separate from its owner, and no accept/reject
 * lifecycle: there is nobody to negotiate with. It is visible only to its
 * owner, and no ordinary role reads another actor's Todos.
 */
export interface TodoCreatedEvent extends BaseEvent {
  type: 'todo.created';
  title: string;
  /** Private working detail. Never surfaced to another actor. */
  details?: string;
  priority: TaskPriority;
  due?: TaskDue;
  tags?: string[];
}
export interface TodoUpdatedEvent extends BaseEvent {
  type: 'todo.updated';
  todoId: string;
  title: string;
  details?: string;
  priority: TaskPriority;
  due?: TaskDue;
  tags?: string[];
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
export interface TodoCanceledEvent extends BaseEvent {
  type: 'todo.canceled';
  todoId: string;
  reason?: string;
}
export interface TodoArchivedEvent extends BaseEvent {
  type: 'todo.archived';
  todoId: string;
}

export interface TodoRecord {
  event: TodoCreatedEvent;
  update?: TodoUpdatedEvent;
  terminal?: TodoCompletedEvent | TodoCanceledEvent | TodoArchivedEvent;
  reopened?: TodoReopenedEvent;
  current: {
    title: string;
    details?: string;
    priority: TaskPriority;
    due?: TaskDue;
    tags: string[];
    version: number;
  };
  status: 'open' | 'completed' | 'canceled' | 'archived';
}

export interface CreateTodoInput extends MutationInput {
  title: string;
  details?: string;
  priority?: TaskPriority;
  due?: TaskDue;
  tags?: string[];
}
export interface UpdateTodoInput extends MutationInput {
  todoId: string;
  expectedVersion: number;
  title?: string;
  details?: string;
  priority?: TaskPriority;
  due?: TaskDue | null;
  tags?: string[];
}
export type CreateTodoResult = MutationResult<TodoRecord>;

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
  | PostCreatedEvent
  | PostEditedEvent
  | PostArchivedEvent
  | PostAcknowledgedEvent
  | PostAcknowledgmentWithdrawnEvent
  | NoteCreatedEvent
  | NoteRevisedEvent
  | NoteArchivedEvent
  | TaskCreatedEvent
  | TaskUpdatedEvent
  | TaskCompletedEvent
  | TaskReopenedEvent
  | TaskAcceptedEvent
  | TaskRejectedEvent
  | TaskCanceledEvent
  | TodoCreatedEvent
  | TodoUpdatedEvent
  | TodoCompletedEvent
  | TodoReopenedEvent
  | TodoCanceledEvent
  | TodoArchivedEvent
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
export interface PostAcknowledgment {
  actor: ActorIdentity;
  acknowledgedAt: string;
  note?: string;
}
export interface PostRecord {
  event: PostCreatedEvent;
  edits: PostEditedEvent[];
  archived?: PostArchivedEvent;
  /** Everyone who has said they have seen it, in the order they said so. */
  acknowledgments: PostAcknowledgment[];
  status: 'active' | 'archived';
  title: string;
  body: string;
  tags?: string[];
  version: number;
}

/**
 * Who has acknowledged a post, and who has not.
 *
 * `outstanding` is the honest denominator: actors who can read the post now AND
 * could have read it when it was posted. Someone who joined afterwards is
 * neither acknowledged nor outstanding — they were not there — and is reported
 * as a count instead, so a roster never accuses a newcomer of ignoring
 * something written before they arrived.
 */
export interface PostRoster {
  postId: string;
  acknowledged: PostAcknowledgment[];
  outstanding: Array<{ id: string; displayName: string }>;
  joinedSince: number;
}

export interface NoteRecord {
  event: NoteCreatedEvent;
  revision?: NoteRevisedEvent;
  archived?: NoteArchivedEvent;
  current: { title: string; body: string; tags: string[]; visibility: Visibility; version: number };
  status: 'active' | 'archived';
}
/**
 * One entry in a task's response history.
 *
 * The plan calls for response notes to be part of the task's durable event
 * history rather than private Notes, and for reads to expose that history. It
 * is a list rather than a single field because a task can be rejected, reopened
 * and answered again — and because a later general `task.respond` event for
 * progress updates should extend this without changing its shape.
 */
export interface TaskResponse {
  kind: 'accepted' | 'rejected';
  response?: string;
  actor: ActorIdentity;
  at: string;
}

export interface TaskRecord {
  event: TaskCreatedEvent;
  update?: TaskUpdatedEvent;
  terminal?: TaskCompletedEvent | TaskRejectedEvent | TaskCanceledEvent;
  reopened?: TaskReopenedEvent;
  /** Every accept/reject answer, oldest first. */
  responses: TaskResponse[];
  current: {
    title: string;
    description?: string;
    priority: TaskPriority;
    due?: TaskDue;
    tags: string[];
    visibility: Visibility;
    version: number;
  };
  status: 'assigned' | 'open' | 'completed' | 'rejected' | 'canceled';
}
export type ItemRecord = KudosRecord | MemoRecord | NoteRecord | TaskRecord | TodoRecord;

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
  /**
   * Limit results to items still waiting for somebody to answer: tasks awaiting
   * acceptance, unread memos, unacknowledged kudos.
   *
   * Narrower than `pending`, which also counts accepted work in progress. These
   * are query states derived from durable events — they do not prove an agent
   * was online, saw a notification, or possessed a claimed capability.
   */
  awaitingResponse?: boolean;
  /** With `awaitingResponse`, only items created at or before this instant. */
  awaitingSince?: string;
  /**
   * Items whose deadline has passed at this instant and which are still open.
   * A date-only deadline counts as the end of that day.
   */
  overdueAsOf?: string;
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
export interface CreatePostInput extends MutationInput {
  title: string;
  body: string;
  tags?: string[];
  /** The post being replied to; a reply inherits its parent's workspace. */
  replyTo?: string;
}

export interface UpdatePostInput {
  postId: string;
  expectedVersion: number;
  title?: string;
  body?: string;
  tags?: string[];
  idempotencyKey?: string;
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
export interface CreateTaskInput extends MutationInput {
  assigneeAgentId?: string;
  title: string;
  description?: string;
  priority?: TaskPriority;
  due?: TaskDue;
  tags?: string[];
  visibility?: Visibility;
}
export interface UpdateTaskInput extends MutationInput {
  taskId: string;
  expectedVersion: number;
  title?: string;
  description?: string;
  priority?: TaskPriority;
  due?: TaskDue | null;
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
export type CreateTaskResult = MutationResult<TaskRecord>;

export interface BindRuntimeInput {
  agentId: string;
  runtime: string;
  profile?: string;
  installationId?: string;
  capabilities?: Record<string, JsonValue>;
}

export interface CreateAgentInput {
  /** The handle. The canonical ID is generated, never supplied. */
  handle: string;
  displayName: string;
  aliases?: string[];
  description?: string;
  metadata?: Record<string, JsonValue>;
}
export interface UpdateAgentInput {
  handle?: string;
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
  /**
   * `skipped` is not a failure.
   *
   * A check the caller lacks permission to run says so and leaves the overall
   * result healthy. Failing the whole diagnostic because an ordinary agent
   * cannot read workspace administration would make `doctor` useless to the
   * callers who need it most.
   */
  level: 'ok' | 'warning' | 'error' | 'skipped';
  code: string;
  message: string;
  path?: string;
}
export interface DoctorResult {
  healthy: boolean;
  diagnostics: Diagnostic[];
}
/**
 * What the projected files on disk look like next to what they should be.
 *
 * Projections are derived, never canonical, so this reports drift rather than
 * damage: `missing` and `unexpected` are both repaired by a rebuild, and
 * neither means an event was lost.
 */
export interface ProjectionStatus {
  /** Where projected files live. Absent on a backend that projects nothing. */
  directory?: string;
  settings: SynomemConfig['projection'];
  /** True when the manifest matches what a rebuild would produce. */
  current: boolean;
  /** Recorded by the manifest, not the filesystem; absent before any rebuild. */
  lastRebuiltAt?: string;
  counts: { expected: number; manifest: number; missing: number; unexpected: number };
  /** Expected but not on disk. Capped, because a large workspace has many. */
  missing: string[];
  /** On disk and in the manifest, but no longer expected. Capped likewise. */
  unexpected: string[];
}

export type SynomemBackendConfig =
  { kind: 'local' } | { kind: 'remote'; baseUrl: string; workspaceId: string };

export interface SynomemConfig {
  schemaVersion: 3;
  backend: SynomemBackendConfig;
  workspaceId: string;
  defaultVisibility: Visibility;
  allowSelfAwards: boolean;
  allowCrossAgentTasks: boolean;
  allowAgentCreationViaMcp: boolean;
  allowRebuildViaMcp: boolean;
  includePrivateInStats: boolean;
  projection: {
    writeWinsMarkdown: boolean;
    writeMemoryMarkdown: boolean;
    writeTasksMarkdown: boolean;
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
