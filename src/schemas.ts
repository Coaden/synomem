import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import type { JsonValue } from './types.js';

const reservedIds = new Set([
  '.',
  '..',
  'kudos',
  'synomem',
  'exports',
  'inbox',
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'lpt1',
]);

export const agentIdSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase ASCII letters, digits, and hyphens')
  .refine((id) => !reservedIds.has(id), 'Reserved agent ID');

export const actorSchema = z.object({
  kind: z.enum(['human', 'agent', 'system']),
  id: agentIdSchema,
  displayName: z.string().trim().min(1).max(200).optional(),
});

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const metadataSchema = z.record(z.string().max(200), jsonValueSchema);

export const sourceSchema = z.object({
  runtime: z.string().trim().min(1).max(200).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  sessionId: z.string().trim().min(1).max(500).optional(),
  repository: z.string().trim().min(1).max(1000).optional(),
  commit: z.string().trim().min(1).max(200).optional(),
  workingDirectory: z.string().trim().min(1).max(2000).optional(),
});

function isSafeFileEvidence(value: string): boolean {
  const normalized = normalize(value);
  return (
    !isAbsolute(value) &&
    normalized !== '..' &&
    !normalized.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  );
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export const evidenceSchema = z
  .object({
    kind: z.enum(['tool-call', 'commit', 'file', 'url', 'task', 'note']),
    label: z.string().trim().min(1).max(200).optional(),
    value: z.string().trim().min(1).max(2000),
  })
  .superRefine((evidence, context) => {
    if (evidence.kind === 'url' && !isHttpUrl(evidence.value)) {
      context.addIssue({ code: 'custom', message: 'URL evidence must use http or https' });
    }
    if (evidence.kind === 'file' && !isSafeFileEvidence(evidence.value)) {
      context.addIssue({ code: 'custom', message: 'File evidence must be a safe relative path' });
    }
  });

export const profileSchema = z.object({
  id: agentIdSchema,
  displayName: z.string().trim().min(1).max(200),
  aliases: z.array(agentIdSchema).max(50).optional(),
  description: z.string().trim().max(2000).optional(),
  createdAt: z.string().datetime({ offset: true }),
  metadata: metadataSchema.optional(),
});

export const createAgentSchema = profileSchema.omit({ createdAt: true });
export const updateAgentSchema = createAgentSchema.omit({ id: true }).partial();

const baseEventSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  workspaceId: z.string().trim().min(1).max(100),
  aggregateId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$|^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  aggregateVersion: z.number().int().min(1),
  createdAt: z.string().datetime({ offset: true }),
  actor: actorSchema,
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
  source: sourceSchema.optional(),
  metadata: metadataSchema.optional(),
});

export const kudosTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\r\n]+$/, 'Kudos titles must be a single line');

export const kudosTagSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u);

const kudosGivenSchema = baseEventSchema.extend({
  type: z.literal('kudos.given'),
  recipientAgentId: agentIdSchema,
  recipientDisplayName: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(5000),
  evidence: z.array(evidenceSchema).max(50).optional(),
  tags: z.array(kudosTagSchema).max(50).optional(),
  visibility: z.enum(['private', 'workspace', 'public']),
});

const acknowledgedSchema = baseEventSchema.extend({
  type: z.literal('kudos.acknowledged'),
  kudosId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  recipientAgentId: agentIdSchema,
  note: z.string().trim().min(1).max(2000).optional(),
});

const revokedSchema = baseEventSchema.extend({
  type: z.literal('kudos.revoked'),
  kudosId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  reason: z.string().trim().min(1).max(2000),
  mode: z.enum(['actor-requested', 'administrative']),
});

const agentCreatedSchema = baseEventSchema.extend({
  type: z.literal('agent.created'),
  agent: profileSchema,
});

const agentUpdatedSchema = baseEventSchema.extend({
  type: z.literal('agent.updated'),
  agentId: agentIdSchema,
  changes: updateAgentSchema,
});

const memoSentSchema = baseEventSchema.extend({
  type: z.literal('memo.sent'),
  recipientAgentId: agentIdSchema,
  recipientDisplayName: z.string().trim().min(1).max(200),
  subject: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\r\n]+$/),
  body: z.string().trim().min(1).max(16_000),
  tags: z.array(kudosTagSchema).max(20).optional(),
  visibility: z.enum(['private', 'workspace', 'public']),
});

const memoReadSchema = baseEventSchema.extend({
  type: z.literal('memo.read'),
  memoId: z.string().length(26),
  recipientAgentId: agentIdSchema,
});
const memoArchivedSchema = baseEventSchema.extend({
  type: z.literal('memo.archived'),
  memoId: z.string().length(26),
  recipientAgentId: agentIdSchema,
});

const noteCreatedSchema = baseEventSchema.extend({
  type: z.literal('note.created'),
  ownerAgentId: agentIdSchema,
  ownerDisplayName: z.string().trim().min(1).max(200),
  title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\r\n]+$/),
  body: z.string().trim().min(1).max(32_000),
  tags: z.array(kudosTagSchema).max(20).optional(),
  visibility: z.literal('private'),
});
const noteRevisedSchema = baseEventSchema.extend({
  type: z.literal('note.revised'),
  noteId: z.string().length(26),
  title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\r\n]+$/),
  body: z.string().trim().min(1).max(32_000),
  tags: z.array(kudosTagSchema).max(20).optional(),
  visibility: z.literal('private'),
});
const noteArchivedSchema = baseEventSchema.extend({
  type: z.literal('note.archived'),
  noteId: z.string().length(26),
});

const taskDueSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('date'),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((value) => {
        const date = new Date(`${value}T00:00:00Z`);
        return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
      }, 'Use a valid calendar date'),
  }),
  z.object({
    kind: z.literal('datetime'),
    datetime: z.string().datetime({ offset: true }),
    timeZone: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, 'Use a valid IANA time-zone identifier'),
  }),
]);
const taskFields = {
  title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\r\n]+$/),
  description: z.string().trim().max(16_000).optional(),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  due: taskDueSchema.optional(),
  tags: z.array(kudosTagSchema).max(20).optional(),
  visibility: z.enum(['private', 'workspace', 'public']),
};
const taskCreatedSchema = baseEventSchema.extend({
  type: z.literal('task.created'),
  assigneeAgentId: agentIdSchema,
  assigneeDisplayName: z.string().trim().min(1).max(200),
  requiresAcceptance: z.boolean(),
  ...taskFields,
});
const taskUpdatedSchema = baseEventSchema.extend({
  type: z.literal('task.updated'),
  taskId: z.string().length(26),
  ...taskFields,
});
const taskCompletedSchema = baseEventSchema.extend({
  type: z.literal('task.completed'),
  taskId: z.string().length(26),
  note: z.string().trim().min(1).max(2000).optional(),
});
const taskReopenedSchema = baseEventSchema.extend({
  type: z.literal('task.reopened'),
  taskId: z.string().length(26),
});
const taskAcceptedSchema = baseEventSchema.extend({
  type: z.literal('task.accepted'),
  taskId: z.string().length(26),
  // Optional: accepting without comment is a complete answer on its own.
  response: z.string().trim().min(1).max(2000).optional(),
});
const taskRejectedSchema = baseEventSchema.extend({
  type: z.literal('task.rejected'),
  taskId: z.string().length(26),
  // Required. A refusal with no reason tells the assigner only that the work
  // will not happen, not whether to reassign it, wait, or change the request.
  response: z.string().trim().min(1).max(2000),
});
const taskCanceledSchema = baseEventSchema.extend({
  type: z.literal('task.canceled'),
  taskId: z.string().length(26),
  reason: z.string().trim().min(1).max(2000).optional(),
});

/**
 * A Todo is owner-only, so it carries no assignee and no acceptance lifecycle.
 * `details` rather than `description` keeps it lexically distinct from a Task in
 * every payload, which makes a mix-up visible in a log rather than silent.
 */
const todoFields = {
  title: z.string().trim().min(1).max(200),
  details: z.string().trim().min(1).max(4000).optional(),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  due: taskDueSchema.optional(),
  tags: z.array(kudosTagSchema).max(20).optional(),
};
const todoCreatedSchema = baseEventSchema.extend({
  type: z.literal('todo.created'),
  ...todoFields,
});
const todoUpdatedSchema = baseEventSchema.extend({
  type: z.literal('todo.updated'),
  todoId: z.string().length(26),
  ...todoFields,
});
const todoCompletedSchema = baseEventSchema.extend({
  type: z.literal('todo.completed'),
  todoId: z.string().length(26),
  note: z.string().trim().min(1).max(2000).optional(),
});
const todoReopenedSchema = baseEventSchema.extend({
  type: z.literal('todo.reopened'),
  todoId: z.string().length(26),
});
const todoCanceledSchema = baseEventSchema.extend({
  type: z.literal('todo.canceled'),
  todoId: z.string().length(26),
  reason: z.string().trim().min(1).max(2000).optional(),
});
const todoArchivedSchema = baseEventSchema.extend({
  type: z.literal('todo.archived'),
  todoId: z.string().length(26),
});

export const eventSchema = z.discriminatedUnion('type', [
  kudosGivenSchema,
  acknowledgedSchema,
  revokedSchema,
  agentCreatedSchema,
  agentUpdatedSchema,
  memoSentSchema,
  memoReadSchema,
  memoArchivedSchema,
  noteCreatedSchema,
  noteRevisedSchema,
  noteArchivedSchema,
  taskCreatedSchema,
  taskUpdatedSchema,
  taskCompletedSchema,
  taskReopenedSchema,
  taskAcceptedSchema,
  taskRejectedSchema,
  taskCanceledSchema,
  todoCreatedSchema,
  todoUpdatedSchema,
  todoCompletedSchema,
  todoReopenedSchema,
  todoCanceledSchema,
  todoArchivedSchema,
]);

const giveKudosInputSchema = kudosGivenSchema
  .omit({
    schemaVersion: true,
    id: true,
    type: true,
    workspaceId: true,
    aggregateId: true,
    aggregateVersion: true,
    createdAt: true,
    actor: true,
    recipientDisplayName: true,
  })
  .extend({
    title: kudosTitleSchema,
    evidence: z.array(evidenceSchema).max(10).optional(),
    tags: z.array(kudosTagSchema).max(20).optional(),
  });

function enforceKudosPayloadSize(value: unknown, context: z.RefinementCtx): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 32_768) {
    context.addIssue({ code: 'custom', message: 'Kudos payload must not exceed 32 KiB' });
  }
}

export const giveKudosSchema = giveKudosInputSchema.superRefine(enforceKudosPayloadSize);

export const giveKudosMcpSchema = giveKudosInputSchema
  .extend({ visibility: z.enum(['private', 'workspace', 'public']).optional() })
  .superRefine(enforceKudosPayloadSize);

export const listInputSchema = z
  .object({
    recipientAgentId: agentIdSchema.optional(),
    actorId: agentIdSchema.optional(),
    actorKind: z.enum(['human', 'agent', 'system']).optional(),
    tag: z.string().trim().min(1).max(64).optional(),
    status: z.enum(['acknowledged', 'unacknowledged']).optional(),
    visibility: z.enum(['private', 'workspace', 'public']).optional(),
    revoked: z.boolean().optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    cursor: z.string().min(1).max(500).optional(),
    limit: z.number().int().min(1).max(50).default(10),
    offset: z.number().int().min(0).default(0),
  })
  .superRefine((value, context) => {
    if (value.cursor && value.offset > 0) {
      context.addIssue({ code: 'custom', message: 'Use either cursor or offset pagination' });
    }
  });

export const changesInputSchema = z.object({
  after: z.string().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(100).default(20),
});

const mutationMetadata = {
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
  source: sourceSchema.optional(),
  metadata: metadataSchema.optional(),
};
export const sendMemoSchema = z
  .object({
    recipientAgentId: agentIdSchema,
    subject: memoSentSchema.shape.subject,
    body: memoSentSchema.shape.body,
    tags: z.array(kudosTagSchema).max(20).optional(),
    visibility: z.enum(['private', 'workspace', 'public']).optional(),
    ...mutationMetadata,
  })
  .strict();
export const createNoteSchema = z
  .object({
    ownerAgentId: agentIdSchema.optional(),
    title: noteCreatedSchema.shape.title,
    body: noteCreatedSchema.shape.body,
    tags: z.array(kudosTagSchema).max(20).optional(),
    ...mutationMetadata,
  })
  .strict();
export const reviseNoteSchema = z
  .object({
    noteId: z.string().length(26),
    expectedVersion: z.number().int().min(1),
    title: noteCreatedSchema.shape.title.optional(),
    body: noteCreatedSchema.shape.body.optional(),
    tags: z.array(kudosTagSchema).max(20).optional(),
    ...mutationMetadata,
  })
  .strict();
export const createTaskSchema = z
  .object({
    assigneeAgentId: agentIdSchema.optional(),
    title: taskCreatedSchema.shape.title,
    description: taskCreatedSchema.shape.description,
    priority: taskCreatedSchema.shape.priority.optional(),
    due: taskDueSchema.optional(),
    tags: z.array(kudosTagSchema).max(20).optional(),
    visibility: z.enum(['private', 'workspace', 'public']).optional(),
    ...mutationMetadata,
  })
  .strict();
export const updateTaskSchema = z
  .object({
    taskId: z.string().length(26),
    expectedVersion: z.number().int().min(1),
    title: taskCreatedSchema.shape.title.optional(),
    description: taskCreatedSchema.shape.description,
    priority: taskCreatedSchema.shape.priority.optional(),
    due: taskDueSchema.nullable().optional(),
    tags: z.array(kudosTagSchema).max(20).optional(),
    visibility: z.enum(['private', 'workspace', 'public']).optional(),
    ...mutationMetadata,
  })
  .strict();
/**
 * A Todo takes no assignee and no visibility: it belongs to its author and is
 * always private. Omitting those fields from the input — rather than accepting
 * and ignoring them — means an attempt to assign a Todo fails loudly instead of
 * silently producing a private reminder nobody else can see.
 */
export const createTodoSchema = z
  .object({
    title: todoCreatedSchema.shape.title,
    details: todoCreatedSchema.shape.details,
    priority: todoCreatedSchema.shape.priority.optional(),
    due: taskDueSchema.optional(),
    tags: z.array(kudosTagSchema).max(20).optional(),
    ...mutationMetadata,
  })
  .strict();
export const updateTodoSchema = z
  .object({
    todoId: z.string().length(26),
    expectedVersion: z.number().int().min(1),
    title: todoCreatedSchema.shape.title.optional(),
    details: todoCreatedSchema.shape.details,
    priority: todoCreatedSchema.shape.priority.optional(),
    due: taskDueSchema.nullable().optional(),
    tags: z.array(kudosTagSchema).max(20).optional(),
    ...mutationMetadata,
  })
  .strict();

export const itemListInputSchema = z
  .object({
    kinds: z
      .array(z.enum(['kudos', 'memo', 'note', 'task', 'todo']))
      .max(5)
      .optional(),
    participantAgentId: agentIdSchema.optional(),
    actorId: agentIdSchema.optional(),
    actorKind: z.enum(['human', 'agent', 'system']).optional(),
    awaitingResponse: z.boolean().optional(),
    awaitingSince: z.string().datetime({ offset: true }).optional(),
    overdueAsOf: z.string().datetime({ offset: true }).optional(),
    tag: kudosTagSchema.optional(),
    status: z.string().trim().min(1).max(50).optional(),
    pending: z.boolean().optional(),
    visibility: z.enum(['private', 'workspace', 'public']).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    cursor: z.string().min(1).max(500).optional(),
    limit: z.number().int().min(1).max(50).default(10),
    offset: z.number().int().min(0).default(0),
  })
  .superRefine((value, context) => {
    if (value.cursor && value.offset > 0)
      context.addIssue({ code: 'custom', message: 'Use either cursor or offset pagination' });
  });
