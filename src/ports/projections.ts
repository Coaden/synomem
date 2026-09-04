import type { ProjectionRebuildResult } from '../service.js';
import type { Awaitable } from './repository.js';

export interface ProjectionWriter {
  syncAgent(agentId: string): Awaitable<ProjectionRebuildResult>;
}
