import type { ProjectionRebuildResult } from '../service.js';
import type { Awaitable } from './repository.js';

export interface ProjectionWriter {
  syncAgent(agentId: string): Awaitable<ProjectionRebuildResult>;

  /**
   * Move an agent's projected directory when its handle changes.
   *
   * Optional: only a writer that owns a filesystem has a directory to move. A
   * backend that keeps no projections implements nothing and the rename is
   * simply a database change.
   */
  renameAgentDirectory?(previousHandle: string, nextHandle: string): Awaitable<void>;
}
