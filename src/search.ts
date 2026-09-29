import type { ActorIdentity, RecordKind } from './types.js';
export interface SearchInput {
  q: string;
  kinds?: RecordKind[];
  after?: string;
  limit?: number;
}
export interface SearchHit {
  documentId: string;
  rootId: string;
  replyId?: string;
  kind: RecordKind;
  title: string;
  snippet: string;
  author: ActorIdentity;
  updatedAt: string;
}
export interface SearchPage {
  items: SearchHit[];
  hasMore: boolean;
  nextCursor?: string;
  watermark: string;
  contextLimited: boolean;
}
