import { ZodError } from 'zod';

export const errorCodes = [
  'INVALID_INPUT',
  'INVALID_AGENT_ID',
  'INVALID_EVENT',
  'UNSUPPORTED_EVENT',
  'AGENT_NOT_FOUND',
  'AGENT_EXISTS',
  'ALIAS_CONFLICT',
  'KUDOS_NOT_FOUND',
  'ITEM_NOT_FOUND',
  'MEMO_NOT_FOUND',
  'NOTE_NOT_FOUND',
  'TODO_NOT_FOUND',
  'REVISION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'MUTATION_FORBIDDEN',
  'SELF_AWARD_FORBIDDEN',
  'ACKNOWLEDGMENT_FORBIDDEN',
  'REVOCATION_FORBIDDEN',
  'READ_ONLY',
  'DATABASE_BUSY',
  'DATABASE_CORRUPT',
  'UNSUPPORTED_SCHEMA',
  'UNSAFE_PATH',
  'POLICY_FORBIDDEN',
  'CONFIG_INVALID',
  'AUTH_REQUIRED',
  'AUTH_FORBIDDEN',
  'REMOTE_UNAVAILABLE',
  'REMOTE_PROTOCOL',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;

export type SynomemErrorCode = (typeof errorCodes)[number];

export class SynomemError extends Error {
  readonly code: SynomemErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: SynomemErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'SynomemError';
    this.code = code;
    this.details = details;
  }
}

export function asSynomemError(error: unknown): SynomemError {
  if (error instanceof SynomemError) return error;
  if (error instanceof ZodError) {
    return new SynomemError('INVALID_INPUT', 'Input validation failed.', { issues: error.issues });
  }
  const message = error instanceof Error ? error.message : 'Unexpected Synomem error';
  if (/SQLITE_BUSY|database is locked/i.test(message)) {
    return new SynomemError('DATABASE_BUSY', 'The Synomem database is busy; retry shortly.');
  }
  if (/malformed|not a database|database disk image/i.test(message)) {
    return new SynomemError('DATABASE_CORRUPT', 'The Synomem database failed an integrity check.');
  }
  return new SynomemError('INTERNAL_ERROR', message);
}
