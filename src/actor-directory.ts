import { SynomemError } from './errors.js';
import type { AddressableActor, ActorRef } from './policy.js';
import type { ItemSummary, Page } from './types.js';
export interface ActorProfileInput {
  target: ActorRef;
  after?: string;
  limit?: number;
}
export interface ActorProfile {
  actor: AddressableActor;
  counts: { kudosReceived: number; usefulReceived: number };
  authored: Page<ItemSummary>;
}
export interface ActorDirectoryInput {
  query?: string;
  kind?: 'human' | 'agent';
  limit?: number;
}
export function actorDirectoryInput(
  input: ActorDirectoryInput = {},
): Required<Pick<ActorDirectoryInput, 'query' | 'limit'>> & Pick<ActorDirectoryInput, 'kind'> {
  if (
    Object.keys(input).some((key) => !['query', 'kind', 'limit'].includes(key)) ||
    (input.query !== undefined && typeof input.query !== 'string') ||
    (input.kind !== undefined && !['human', 'agent'].includes(input.kind)) ||
    (input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50))
  )
    throw new SynomemError('INVALID_INPUT', 'Invalid actor directory query.');
  const query = (input.query ?? '').trim();
  if (query.length > 100)
    throw new SynomemError('INVALID_INPUT', 'Actor query is limited to 100 characters.');
  return { query, limit: input.limit ?? 20, ...(input.kind ? { kind: input.kind } : {}) };
}
