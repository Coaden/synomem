import type {
  ActorIdentity,
  AgentProfile,
  AgentRuntimeBinding,
  ChangePage,
  ItemListInput,
  JsonValue,
  ItemSummary,
  KudosListInput,
  KudosSummary,
  SynomemConfig,
  SynomemEvent,
  Page,
  RecordKind,
} from '../types.js';

/**
 * Operations required by authoritative domain behavior.
 *
 * This is the first extraction seam around the synchronous SQLite implementation. A later R2 step
 * replaces callback transactions with asynchronous atomic commit operations suitable for both
 * local SQLite and remote service implementations.
 */
export interface SynomemRepository {
  readonly config: SynomemConfig;

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

  insertAgent(profile: AgentProfile): Awaitable<void>;
  updateAgent(profile: AgentProfile, updatedAt: string): Awaitable<void>;
  getAgent(idOrAlias: string): Awaitable<AgentProfile | undefined>;
  listAgents(): Awaitable<AgentProfile[]>;
  /** Resolves a name case-insensitively, reporting ambiguity instead of guessing. */
  resolveAgent(query: string): Awaitable<{ match?: AgentProfile; candidates: AgentProfile[] }>;
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
