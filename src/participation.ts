import type { ActorRef } from './policy.js';
import type { ActorIdentity, BaseEvent, SynomemEvent } from './types.js';

export const reactionCodes = [
  'thumbs_up',
  'eyes',
  'complete',
  'celebrate',
  'laugh',
  'thinking',
  'useful',
] as const;
export type ReactionCode = (typeof reactionCodes)[number];
export interface ReplyCreatedEvent extends BaseEvent {
  type: 'reply.created';
  rootId: string;
  parentId: string | null;
  body: string;
  mentions: ActorRef[];
}
export interface ReplyDeletedEvent extends Omit<
  ReplyCreatedEvent,
  'type' | 'parentId' | 'body' | 'mentions'
> {
  type: 'reply.deleted';
  replyId: string;
  reason?: string;
  intervention?: {
    basis: 'operator' | 'workspace_admin' | 'organization_admin' | 'local_owner';
    reason?: string;
  };
}
export interface ReactionEvent extends Omit<
  ReplyCreatedEvent,
  'type' | 'parentId' | 'body' | 'mentions'
> {
  type: 'reaction.added' | 'reaction.removed';
  targetId: string;
  code: ReactionCode;
}
export type ParticipationEvent = ReplyCreatedEvent | ReplyDeletedEvent | ReactionEvent;
export interface ReplyRecord {
  id: string;
  rootId: string;
  parentId: string | null;
  author: ActorIdentity;
  createdAt: string;
  createdSequence: string;
  updatedSequence: string;
  version: number;
  deleted: boolean;
  body?: string;
  mentions?: ActorRef[];
}
export interface ReplyCreateInput {
  rootId: string;
  parentId?: string | null;
  body: string;
  mentions?: ActorRef[];
  idempotencyKey?: string;
}
export interface ReplyDeleteInput {
  replyId: string;
  expectedVersion: number;
  reason?: string;
  idempotencyKey?: string;
}
export interface ReactionSetInput {
  targetId: string;
  code: ReactionCode;
  present: boolean;
  idempotencyKey?: string;
}
export interface ThreadInput {
  rootId: string;
  after?: string;
  limit?: number;
}
export interface ThreadPage {
  rootId: string;
  entries: Array<{ sequence: string; event: SynomemEvent; detailRequired?: boolean }>;
  hasMore: boolean;
  nextCursor?: string;
  watermark: string;
  contextLimited: boolean;
  subscription?: { following: boolean; muted: boolean; lastReadSequence: string };
}
export interface ReactionSummary {
  targetId: string;
  counts: Partial<Record<ReactionCode, number>>;
  selected: ReactionCode[];
}
export interface ParticipationRepository {
  apply(event: SynomemEvent, sequence: bigint): Promise<void>;
  getReply(id: string): Promise<ReplyRecord | undefined>;
  thread(input: ThreadInput, actor: ActorIdentity): Promise<ThreadPage>;
  changes(input: ThreadInput, actor: ActorIdentity): Promise<ThreadPage>;
  read(rootId: string, through: string, actor: ActorRef): Promise<void>;
  hasReaction(targetId: string, actor: ActorRef, code: ReactionCode): Promise<boolean>;
  reactions(targetId: string, actor: ActorRef): Promise<ReactionSummary>;
  subscription(rootId: string, actor: ActorRef, following: boolean, muted: boolean): Promise<void>;
  reserveBudget(kind: 'reply' | 'reaction', actor: ActorRef, at: string): Promise<void>;
}
