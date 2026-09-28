import type { ActorDirectoryInput, ActorDirectoryPage } from '../actor-directory.js';
import type { BookmarkRepository } from '../bookmarks.js';
import type { SearchInput, SearchPage } from '../search.js';
import type { NotificationRepository } from '../notifications.js';
import type { ParticipationRepository } from '../participation.js';
import type { MutationReceipt } from '../mutation-receipts.js';
import type { ActorRef, AddressableActor, RecordAuthority } from '../policy.js';
import type {
  ActorIdentity,
  AgentProfile,
  AgentRuntimeBinding,
  ChangePage,
  ItemListInput,
  JsonValue,
  PostAcknowledgment,
  PostRoster,
  ItemSummary,
  KudosListInput,
  KudosSummary,
  SynomemConfig,
  SynomemEvent,
  Page,
  RecordKind,
  Topic,
} from '../types.js';

/**
 * Operations required by authoritative domain behavior.
 *
 * This is the first extraction seam around the synchronous SQLite implementation. A later R2 step
 * replaces callback transactions with asynchronous atomic commit operations suitable for both
 * local SQLite and remote service implementations.
 */
export interface SynomemRepository {
  search?(input: SearchInput, actor: ActorIdentity): Promise<SearchPage>;
  readonly bookmarks: BookmarkRepository;
  readonly config: SynomemConfig;
  readonly notifications: NotificationRepository;
  readonly participation: ParticipationRepository;

  setAuthority(authority: RecordAuthority): void;
  init(): Awaitable<void>;
  close(): Awaitable<void>;
  assertEventCompatibility(): Awaitable<void>;
  transaction<T>(operation: () => Awaitable<T>): Promise<T>;

  insertEvent(event: SynomemEvent): Awaitable<void>;
  nextAggregateVersion(aggregateId: string): Awaitable<number>;
  getEventByIdempotency(
    actorKind: ActorIdentity['kind'],
    actorId: string,
    key: string,
  ): Awaitable<SynomemEvent | undefined>;
  getReadableSynomemEvents(kudosId: string): Awaitable<SynomemEvent[]>;
  getReadableItemEvents(id: string): Awaitable<SynomemEvent[]>;

  getMutationReceipt(
    actorKind: string,
    actorId: string,
    keyHash: string,
  ): Awaitable<MutationReceipt | undefined>;
  insertMutationReceipt(
    actorKind: string,
    actorId: string,
    keyHash: string,
    receipt: MutationReceipt,
  ): Awaitable<void>;
  compactMutationReceipts(before: string): Awaitable<number>;
  canActorReadItem(id: string, actor: ActorRef): Awaitable<boolean>;
  getActor(ref: ActorRef): Awaitable<AddressableActor | undefined>;
  actorCounts(
    target: ActorRef,
    viewer: ActorIdentity,
  ): Awaitable<{ kudosReceived: number; usefulReceived: number }>;
  listActors(input: ActorDirectoryInput, viewer: ActorIdentity): Awaitable<ActorDirectoryPage>;
  registerHuman(actor: AddressableActor): Awaitable<void>;

  insertAgent(profile: AgentProfile): Awaitable<void>;
  updateAgent(profile: AgentProfile, updatedAt: string): Awaitable<void>;
  getAgent(idOrAlias: string): Awaitable<AgentProfile | undefined>;
  listAgents(): Awaitable<AgentProfile[]>;
  /** Resolves a name case-insensitively, reporting ambiguity instead of guessing. */
  resolveAgent(query: string): Awaitable<{ match?: AgentProfile; candidates: AgentProfile[] }>;
  listPostAcknowledgments(postId: string): Awaitable<PostAcknowledgment[]>;
  /** Who has acknowledged a post and who has not; see PostRoster. */
  postRoster(postId: string): Awaitable<PostRoster | undefined>;
  listRuntimeBindings(agentId: string): Awaitable<AgentRuntimeBinding[]>;
  bindRuntime(binding: {
    id: string;
    agentId: string;
    installationId?: string;
    runtime: string;
    profile?: string;
    capabilities?: Record<string, JsonValue>;
    boundAt: string;
  }): Awaitable<void>;
  unbindRuntime(bindingId: string): Awaitable<boolean>;
  touchRuntimeBinding(agentId: string, runtime: string, at: string): Awaitable<void>;

  insertTopic(topic: Topic): Awaitable<void>;
  updateTopic(topic: Topic, updatedAt: string): Awaitable<void>;
  getTopic(idOrAlias: string): Awaitable<Topic | undefined>;
  listTopics(status?: 'active' | 'archived'): Awaitable<Topic[]>;
  /** Resolves a name case-insensitively, reporting ambiguity instead of guessing. */
  resolveTopic(query: string): Awaitable<{ match?: Topic; candidates: Topic[] }>;

  listKudosSummaries(
    input: Required<Pick<KudosListInput, 'limit' | 'offset'>> & KudosListInput,
    viewer: ActorIdentity,
  ): Awaitable<Page<KudosSummary>>;
  listKudosChanges(
    after: string | undefined,
    limit: number,
    viewer: ActorIdentity,
  ): Awaitable<ChangePage>;
  listItemSummaries(
    input: Required<Pick<ItemListInput, 'limit' | 'offset'>> & ItemListInput,
    viewer: ActorIdentity,
  ): Awaitable<Page<ItemSummary>>;
  listItemChanges(
    after: string | undefined,
    limit: number,
    viewer: ActorIdentity,
    kinds?: RecordKind[],
  ): Awaitable<ChangePage>;
  getItemSummary(id: string): Awaitable<ItemSummary | undefined>;
}

export type Awaitable<T> = T | Promise<T>;
