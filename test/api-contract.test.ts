import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const specification = readFileSync(join(process.cwd(), 'openapi', 'synomem-v1.yaml'), 'utf8');

describe('Synomem v1 API contract', () => {
  it('specifies every initial remote domain operation', () => {
    for (const operation of [
      'getCapabilities',
      'createAgent',
      'listAgents',
      'getAgent',
      'updateAgent',
      'giveKudos',
      'listKudos',
      'getKudosChanges',
      'getKudosStats',
      'getKudos',
      'acknowledgeKudos',
      'revokeKudos',
      'sendMemo',
      'listMemos',
      'getMemo',
      'readMemo',
      'archiveMemo',
      'createNote',
      'listNotes',
      'getNote',
      'reviseNote',
      'archiveNote',
      'createTodo',
      'listTodos',
      'getTodo',
      'updateTodo',
      'transitionTodo',
      'listItems',
      'getItem',
      'getChanges',
      'getDiagnostics',
      'listWorkspaceAudit',
      'previewWorkspaceImport',
      'confirmWorkspaceImport',
      'exportWorkspace',
      'rebuildWorkspaceIndexes',
      'getCanonicalEvent',
    ]) {
      expect(specification).toContain(`operationId: ${operation}`);
    }
  });

  it('keeps actor authority and idempotency keys out of mutation bodies', () => {
    expect(specification).not.toMatch(/^\s+actor(?:Id|Kind)?:/mu);
    expect(specification).not.toMatch(/^\s+idempotencyKey:/mu);
    expect(specification).toContain('name: Idempotency-Key');
    expect(specification).toContain('additionalProperties: false');
  });
});
