import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { configuredServiceFactory } from '../backend.js';
import { SynomemError, asSynomemError } from '../errors.js';
import {
  actorSchema,
  agentHandleSchema,
  agentIdSchema,
  changesInputSchema,
  createNoteSchema,
  createTaskSchema,
  createTodoSchema,
  giveKudosMcpSchema,
  itemListInputSchema,
  listInputSchema,
  reviseNoteSchema,
  sendMemoSchema,
  updateTaskSchema,
  updateTodoSchema,
} from '../schemas.js';
import { packageVersion } from '../version.js';
import type { SynomemService, SynomemServiceFactory } from '../service.js';
import type { ActorIdentity, SynomemClientOptions, KudosRecord } from '../types.js';

export interface SynomemMcpOptions extends Omit<SynomemClientOptions, 'actor'> {
  actor: ActorIdentity;
}

const outputSchema = z.object({
  ok: z.boolean(),
  actor: actorSchema,
  message: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
  errorCode: z.string().optional(),
});

function dataRecord(value: unknown): Record<string, unknown> {
  const normalized = JSON.parse(JSON.stringify(value)) as unknown;
  return typeof normalized === 'object' && normalized !== null && !Array.isArray(normalized)
    ? (normalized as Record<string, unknown>)
    : { value: normalized };
}

function success(actor: ActorIdentity, message: string, data: unknown): CallToolResult {
  const structuredContent = { ok: true, actor, message, data: dataRecord(data) };
  return {
    content: [{ type: 'text', text: message }],
    structuredContent,
  };
}

function failure(actor: ActorIdentity, error: unknown): CallToolResult {
  const kudosError = asSynomemError(error);
  const structuredContent = {
    ok: false,
    actor,
    message: kudosError.message,
    errorCode: kudosError.code,
  };
  return {
    content: [{ type: 'text', text: `${kudosError.code}: ${kudosError.message}` }],
    structuredContent,
    isError: true,
  };
}

function canView(actor: ActorIdentity, record: KudosRecord): boolean {
  if (record.event.visibility !== 'private') return true;
  return (
    actor.kind === 'human' ||
    (actor.kind === 'agent' && record.event.recipientAgentId === actor.id) ||
    (record.event.actor.kind === actor.kind && record.event.actor.id === actor.id)
  );
}

function describeRecord(record: KudosRecord): string {
  return `${record.event.recipientDisplayName} received “${record.event.title}” on ${record.event.createdAt.slice(0, 10)} (ID ${record.event.id}).`;
}

export interface SynomemMcpRuntime {
  server: McpServer;
  client: SynomemService;
  close(): Promise<void>;
}

export async function createSynomemMcpServer(
  options: SynomemMcpOptions,
  serviceFactory: SynomemServiceFactory = configuredServiceFactory,
): Promise<SynomemMcpRuntime> {
  const requested = actorSchema.parse(options.actor);
  const client = serviceFactory({ ...options, actor: requested });
  await client.init();
  /*
   * Every tool reports the CANONICAL actor, not the one that was asked for.
   *
   * A harness registers with a handle because that is what a person typed, but
   * init resolves it against stored state — so the identity echoed back is the
   * one the events will actually carry. Reporting the requested name would let
   * a misconfigured runtime appear to be acting as somebody it is not.
   */
  const actor = client.actor;
  const server = new McpServer(
    { name: 'synomem', version: packageVersion() },
    {
      instructions:
        'Use Synomem for durable kudos, memos, notes, and tasks. Store only necessary, factual content; never secrets or raw sensitive tool output. The server binds every write to its configured actor.',
    },
  );

  server.registerTool(
    'synomem_kudos_give',
    {
      title: 'Give kudos',
      description:
        'Use when a human explicitly requests recognition or a peer agent made a concrete, unusually useful contribution. State what the recipient did and why it mattered. Do not use for routine completion, generic politeness, self-congratulation, invented work, secrets, or raw sensitive tool output.',
      inputSchema: giveKudosMcpSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => {
      try {
        const result = await client.kudos.give(input);
        return success(
          actor,
          `${describeRecord(result.record)} ${result.deduplicated ? 'Deduplicated; the original event was returned.' : `Recorded by ${actor.displayName ?? actor.id}.`}`,
          result,
        );
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'synomem_kudos_list',
    {
      title: 'List kudos',
      description:
        'Return a context-safe page of compact kudos summaries, newest first. The default is 10 and maximum is 50. Use nextCursor for another page and kudos_get only for records whose full reason or evidence is needed.',
      inputSchema: listInputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      try {
        const page = await client.kudos.list(input);
        return success(
          actor,
          `Returned ${page.items.length} of ${page.total} visible kudos summaries${page.hasMore ? '; use nextCursor to continue' : ''}.`,
          page,
        );
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'synomem_kudos_changes',
    {
      title: 'Get kudos changes',
      description:
        'Return compact kudos changes after an opaque watermark. Persist nextCursor (or watermark when empty) and pass it as after on the next poll. The default is 20 and maximum is 100.',
      inputSchema: changesInputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      try {
        const page = await client.kudos.changes(input);
        return success(
          actor,
          `Returned ${page.items.length} visible kudos change(s)${page.hasMore ? '; use nextCursor to continue' : ''}.`,
          page,
        );
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'synomem_kudos_get',
    {
      title: 'Get kudos',
      description: 'Use to inspect one kudos item and its acknowledgment or revocation state.',
      inputSchema: z.object({ kudosId: z.string().length(26) }),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ kudosId }) => {
      try {
        const record = await client.kudos.get(kudosId);
        if (!canView(actor, record))
          throw new SynomemError(
            'POLICY_FORBIDDEN',
            'This private kudos item is not visible to the configured actor.',
          );
        return success(actor, describeRecord(record), { record });
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'synomem_kudos_acknowledge',
    {
      title: 'Acknowledge kudos',
      description:
        'Use when the configured recipient has reviewed received kudos. Acknowledgment records receipt and does not imply agreement with every detail.',
      inputSchema: z.object({
        kudosId: z.string().length(26),
        note: z.string().trim().min(1).max(2000).optional(),
      }),
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      try {
        const record = await client.kudos.acknowledge(input);
        return success(
          actor,
          `Acknowledged kudos ${record.event.id} as ${actor.displayName ?? actor.id}.`,
          {
            record,
          },
        );
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'synomem_kudos_revoke',
    {
      title: 'Revoke kudos',
      description:
        'Use to record a revocation with a concrete reason. This preserves history and does not delete the original kudos.',
      inputSchema: z.object({
        kudosId: z.string().length(26),
        reason: z.string().trim().min(1).max(2000),
        administrative: z.boolean().default(false),
      }),
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async (input) => {
      try {
        if (input.administrative && actor.kind !== 'human') {
          throw new SynomemError(
            'POLICY_FORBIDDEN',
            'Only human actors can request administrative revocation.',
          );
        }
        const record = await client.kudos.revoke(input);
        return success(actor, `Revoked kudos ${record.event.id}; history was preserved.`, {
          record,
        });
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'synomem_kudos_stats',
    {
      title: 'Kudos statistics',
      description: 'Return aggregate recognition counts without exposing private message content.',
      inputSchema: listInputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      try {
        const stats = await client.stats(input);
        return success(actor, `Computed statistics for ${stats.total} kudos item(s).`, { stats });
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'synomem_agent_create',
    {
      title: 'Create agent identity',
      description:
        'Administrative tool for creating a stable agent identity. Disabled by default so runtime agents cannot silently create identities.',
      inputSchema: z.object({
        handle: agentHandleSchema,
        displayName: z.string().trim().min(1).max(200),
        aliases: z.array(agentHandleSchema).max(50).optional(),
        description: z.string().trim().max(2000).optional(),
      }),
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => {
      try {
        const capabilities = await client.capabilities();
        if (!capabilities.administration.agentCreationViaMcp) {
          throw new SynomemError(
            'POLICY_FORBIDDEN',
            'Agent creation via MCP is disabled by configuration.',
          );
        }
        const profile = await client.agents.create(input);
        return success(
          actor,
          `Created agent ${profile.displayName}: handle ${profile.handle}, ID ${profile.id}.`,
          { profile },
        );
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'synomem_agent_list',
    {
      title: 'List agent identities',
      description: 'List known stable agent identities and aliases. This is read-only.',
      inputSchema: z.object({}),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      try {
        const agents = await client.agents.list();
        return success(actor, `Found ${agents.length} agent identity or identities.`, { agents });
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'synomem_post_create',
    {
      title: 'Publish a post',
      description:
        'Publish something the whole workspace can read. Use for an announcement, a decision, or context several agents need. A post has no recipient — if one named actor must act, send a memo or assign a task instead.',
      inputSchema: z.object({
        title: z.string().trim().min(1).max(200),
        body: z.string().trim().min(1).max(32_000),
        tags: z.array(z.string()).max(20).optional(),
        replyTo: z.string().length(26).optional(),
        idempotencyKey: z.string().max(200).optional(),
      }),
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => {
      try {
        const result = await client.posts.create(input);
        return success(actor, `Published post ${result.record.event.id}.`, {
          post: result.record,
        });
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'synomem_post_acknowledge',
    {
      title: 'Acknowledge a post',
      description:
        'Record that YOU have seen a post. This speaks only for the configured actor and is never implied by reading one: acknowledge when you have actually taken it in, not to clear a list. An optional note tells the author something useful, such as work already done.',
      inputSchema: z.object({
        postId: z.string().length(26),
        note: z.string().trim().min(1).max(2000).optional(),
        idempotencyKey: z.string().max(200).optional(),
      }),
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      try {
        const record = await client.posts.acknowledge(input);
        return success(actor, `Acknowledged post ${input.postId}.`, { post: record });
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'synomem_post_roster',
    {
      title: 'See who has acknowledged a post',
      description:
        'Who has acknowledged a post and who has not. An outstanding entry means no acknowledgement was recorded — never that somebody has not read it. Agents created after the post are counted separately, because they were not there when it was written. This is read-only and does not acknowledge anything.',
      inputSchema: z.object({ postId: z.string().length(26) }),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ postId }) => {
      try {
        const roster = await client.posts.roster(postId);
        return success(
          actor,
          `${roster.acknowledged.length} acknowledged, ${roster.outstanding.length} with no acknowledgement recorded.`,
          roster,
        );
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'synomem_agent_resolve',
    {
      title: 'Resolve an agent name',
      description:
        'Resolve a name or alias to exactly one agent. Matching ignores case. When several agents answer to the name, no match is returned and the candidates are listed instead — ask which one is meant rather than choosing.',
      inputSchema: z.object({
        query: z.string().min(1).describe('An agent ID or alias, in any casing.'),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ query }) => {
      try {
        const resolution = await client.agents.resolve(query);
        const message = resolution.match
          ? `"${resolution.query}" resolves to ${resolution.match.id}.`
          : resolution.candidates.length
            ? `"${resolution.query}" is ambiguous across ${resolution.candidates.length} agents. Ask which one is meant.`
            : `No agent answers to "${resolution.query}".`;
        return success(actor, message, resolution);
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'synomem_agent_directory',
    {
      title: 'Browse the agent directory',
      description:
        'List known agents with their aliases and runtime bindings. Runtime bindings describe where an agent was registered to run and when Synomem last observed it act; they never mean the agent is reachable now. This is read-only.',
      inputSchema: z.object({}),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      try {
        const entries = await client.agents.directory();
        return success(actor, `Found ${entries.length} agent identity or identities.`, { entries });
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'synomem_rebuild',
    {
      title: 'Rebuild projections',
      description:
        'Administrative operation that deterministically regenerates the SQLite current-state index, WINS.md, and inbox projections.',
      inputSchema: z.object({}),
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      try {
        const capabilities = await client.capabilities();
        if (!capabilities.administration.rebuildViaMcp) {
          throw new SynomemError(
            'POLICY_FORBIDDEN',
            'Projection rebuild via MCP is disabled by configuration.',
          );
        }
        const result = await client.rebuild();
        return success(actor, `Rebuilt ${result.generated.length} generated file(s).`, result);
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'synomem_doctor',
    {
      title: 'Run Synomem diagnostics',
      description: 'Run safe, read-only database, projection, permission, and path diagnostics.',
      inputSchema: z.object({}),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      try {
        const result = await client.doctor();
        return success(actor, result.healthy ? 'Synomem is healthy.' : 'Synomem found problems.', {
          result,
        });
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'synomem_list',
    {
      title: 'List Synomem items',
      description:
        'Discover a bounded page of compact kudos, memo, note, and task summaries. Full bodies, reasons, evidence, descriptions, source, and metadata are omitted; use synomem_get for one selected item.',
      inputSchema: itemListInputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      try {
        const page = await client.items.list(input);
        return success(
          actor,
          `Returned ${page.items.length} of ${page.total} visible item summaries${page.hasMore ? '; use nextCursor to continue' : ''}.`,
          page,
        );
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'synomem_get',
    {
      title: 'Get one Synomem item',
      description:
        'Read the full authorized record for one explicitly selected kudos, memo, note, or task ID.',
      inputSchema: z.object({ itemId: z.string().length(26) }),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ itemId }) => {
      try {
        const record = await client.items.get(itemId);
        return success(actor, `Retrieved item ${itemId}.`, { record });
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'synomem_changes',
    {
      title: 'Get Synomem changes',
      description:
        'Read bounded compact changes after an opaque saved watermark. Persist nextCursor for the next poll and do not drain history speculatively.',
      inputSchema: changesInputSchema.extend({ kinds: itemListInputSchema.shape.kinds }),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      try {
        const page = await client.items.changes(input);
        return success(
          actor,
          `Returned ${page.items.length} visible change(s)${page.hasMore ? '; use nextCursor to continue' : ''}.`,
          page,
        );
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'synomem_inbox',
    {
      title: 'Review an agent inbox',
      description:
        'Return compact pending kudos, unread memos, and open tasks for the configured agent. An agent may inspect only its own private items.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(10),
        cursor: z.string().max(500).optional(),
      }),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      try {
        if (actor.kind !== 'agent')
          throw new SynomemError('POLICY_FORBIDDEN', 'Inbox review requires an agent-bound actor.');
        const page = await client.items.list({
          participantAgentId: actor.id,
          limit: input.limit,
          pending: true,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        });
        return success(actor, `Returned ${page.items.length} pending inbox item(s).`, page);
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'synomem_memo_send',
    {
      title: 'Send a memo',
      description:
        'Send a durable one-to-one memo to an agent or to the configured actor itself. Use for information that should survive the chat, not conversational chatter, transcripts, or secrets.',
      inputSchema: sendMemoSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => {
      try {
        const result = await client.memos.send(input);
        return success(
          actor,
          `${result.deduplicated ? 'Returned existing' : 'Sent'} memo “${result.record.event.subject}” to ${result.record.event.recipientDisplayName} (ID ${result.record.event.id}).`,
          result,
        );
      } catch (error) {
        return failure(actor, error);
      }
    },
  );
  for (const operation of ['read', 'archive'] as const) {
    server.registerTool(
      `synomem_memo_${operation}`,
      {
        title: `${operation === 'read' ? 'Mark memo read' : 'Archive memo'}`,
        description: `Use when the configured recipient should ${operation === 'read' ? 'record reviewing' : 'remove'} a memo${operation === 'archive' ? ' from its active inbox' : ''}.`,
        inputSchema: z.object({
          memoId: z.string().length(26),
          idempotencyKey: z.string().max(200).optional(),
        }),
        outputSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async (input) => {
        try {
          const record = await client.memos[operation](input);
          return success(actor, `Memo ${record.event.id} is ${record.status}.`, { record });
        } catch (error) {
          return failure(actor, error);
        }
      },
    );
  }

  server.registerTool(
    'synomem_note_create',
    {
      title: 'Create a note',
      description:
        'Retain concise agent-owned knowledge for deliberate later retrieval. Agents may write only their own notes. Do not store secrets, unnecessary private content, or raw transcripts.',
      inputSchema: createNoteSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => {
      try {
        const result = await client.notes.create(input);
        return success(
          actor,
          `${result.deduplicated ? 'Returned existing' : 'Created'} note “${result.record.current.title}” (ID ${result.record.event.id}).`,
          result,
        );
      } catch (error) {
        return failure(actor, error);
      }
    },
  );
  server.registerTool(
    'synomem_note_revise',
    {
      title: 'Revise a note',
      description:
        'Append a complete new revision to an owned note. Pass the version last read; stale versions fail with REVISION_CONFLICT.',
      inputSchema: reviseNoteSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => {
      try {
        const record = await client.notes.revise(input);
        return success(
          actor,
          `Revised note ${record.event.id} to version ${record.current.version}.`,
          { record },
        );
      } catch (error) {
        return failure(actor, error);
      }
    },
  );
  server.registerTool(
    'synomem_note_archive',
    {
      title: 'Archive a note',
      description: 'Archive an owned note while preserving its full revision history.',
      inputSchema: z.object({
        noteId: z.string().length(26),
        idempotencyKey: z.string().max(200).optional(),
      }),
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      try {
        const record = await client.notes.archive(input);
        return success(actor, `Archived note ${record.event.id}.`, { record });
      } catch (error) {
        return failure(actor, error);
      }
    },
  );

  server.registerTool(
    'synomem_task_create',
    {
      title: 'Create a task',
      description:
        'Create a concrete actionable task assigned to an agent, optionally with a date-only or timezone-aware deadline. Do not use as a substitute for a memo when no action is required.',
      inputSchema: createTaskSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => {
      try {
        const result = await client.tasks.create(input);
        return success(
          actor,
          `${result.deduplicated ? 'Returned existing' : 'Created'} task “${result.record.current.title}” for ${result.record.event.assigneeDisplayName} (ID ${result.record.event.id}).`,
          result,
        );
      } catch (error) {
        return failure(actor, error);
      }
    },
  );
  server.registerTool(
    'synomem_task_update',
    {
      title: 'Update a task',
      description:
        'Append an update to an open task using the version last read. Stale versions fail rather than overwriting concurrent work.',
      inputSchema: updateTaskSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => {
      try {
        const record = await client.tasks.update(input);
        return success(
          actor,
          `Updated task ${record.event.id} to version ${record.current.version}.`,
          { record },
        );
      } catch (error) {
        return failure(actor, error);
      }
    },
  );
  server.registerTool(
    'synomem_todo_create',
    {
      title: 'Create a private todo',
      description:
        'Create a private reminder for yourself. A todo has no assignee and nobody else can read it — use synomem_task_create when the work belongs to another agent.',
      inputSchema: createTodoSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => {
      try {
        const result = await client.todos.create(input);
        return success(
          actor,
          `${result.deduplicated ? 'Returned existing' : 'Created'} private todo “${result.record.current.title}” (ID ${result.record.event.id}).`,
          result,
        );
      } catch (error) {
        return failure(actor, error);
      }
    },
  );
  server.registerTool(
    'synomem_todo_update',
    {
      title: 'Update a private todo',
      description:
        'Append an update to one of your own todos using the version last read. Stale versions fail rather than overwriting concurrent work.',
      inputSchema: updateTodoSchema,
      outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => {
      try {
        const record = await client.todos.update(input);
        return success(
          actor,
          `Updated todo ${record.event.id} to version ${record.current.version}.`,
          {
            record,
          },
        );
      } catch (error) {
        return failure(actor, error);
      }
    },
  );
  for (const operation of ['complete', 'reopen', 'cancel', 'archive'] as const) {
    const todoInputSchema = z.object({
      todoId: z.string().length(26),
      note: z.string().trim().min(1).max(2000).optional(),
      reason: z.string().trim().min(1).max(2000).optional(),
      idempotencyKey: z.string().max(200).optional(),
    });
    server.registerTool(
      `synomem_todo_${operation}`,
      {
        title: `${operation[0]!.toUpperCase()}${operation.slice(1)} a private todo`,
        description: `${operation[0]!.toUpperCase()}${operation.slice(1)} one of your own todos by appending a lifecycle event; history is never deleted.`,
        inputSchema: todoInputSchema,
        outputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: operation === 'cancel',
          idempotentHint: true,
        },
      },
      async (input) => {
        try {
          const record =
            operation === 'complete'
              ? await client.todos.complete({
                  todoId: input.todoId,
                  ...(input.note ? { note: input.note } : {}),
                  ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
                })
              : operation === 'cancel'
                ? await client.todos.cancel({
                    todoId: input.todoId,
                    ...(input.reason ? { reason: input.reason } : {}),
                    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
                  })
                : operation === 'archive'
                  ? await client.todos.archive({
                      todoId: input.todoId,
                      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
                    })
                  : await client.todos.reopen({
                      todoId: input.todoId,
                      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
                    });
          return success(actor, `Todo ${record.event.id} is now ${record.status}.`, { record });
        } catch (error) {
          return failure(actor, error);
        }
      },
    );
  }

  for (const operation of ['accept', 'reject', 'complete', 'reopen', 'cancel'] as const) {
    const inputSchema = z.object({
      taskId: z.string().length(26),
      note: z.string().trim().min(1).max(2000).optional(),
      reason: z.string().trim().min(1).max(2000).optional(),
      // Required on reject, optional on accept. Declaring it required in the
      // tool schema for reject means a model is told before it calls, rather
      // than discovering it from an error.
      ...(operation === 'reject'
        ? { response: z.string().trim().min(1).max(2000) }
        : operation === 'accept'
          ? { response: z.string().trim().min(1).max(2000).optional() }
          : {}),
      idempotencyKey: z.string().max(200).optional(),
    });
    server.registerTool(
      `synomem_task_${operation}`,
      {
        title: `${operation[0]!.toUpperCase()}${operation.slice(1)} a task`,
        description: `${operation[0]!.toUpperCase()}${operation.slice(1)} an authorized task by appending a lifecycle event; history is never deleted.`,
        inputSchema,
        outputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: operation === 'cancel',
          idempotentHint: true,
        },
      },
      async (input) => {
        try {
          const record =
            operation === 'accept'
              ? await client.tasks.accept({
                  taskId: input.taskId,
                  ...('response' in input && input.response ? { response: input.response } : {}),
                  ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
                })
              : operation === 'reject'
                ? await client.tasks.reject({
                    taskId: input.taskId,
                    response:
                      ('response' in input ? input.response : undefined) ?? input.reason ?? '',
                    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
                  })
                : operation === 'complete'
                  ? await client.tasks.complete({
                      taskId: input.taskId,
                      ...(input.note ? { note: input.note } : {}),
                      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
                    })
                  : operation === 'cancel'
                    ? await client.tasks.cancel({
                        taskId: input.taskId,
                        ...(input.reason ? { reason: input.reason } : {}),
                        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
                      })
                    : await client.tasks.reopen({
                        taskId: input.taskId,
                        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
                      });
          return success(actor, `Task ${record.event.id} is ${record.status}.`, { record });
        } catch (error) {
          return failure(actor, error);
        }
      },
    );
  }

  server.registerResource(
    'agents',
    'synomem://agents',
    {
      title: 'Agent identities',
      description: 'Known Synomem identities',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(await client.agents.list(), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    'agent-profile',
    new ResourceTemplate('synomem://agents/{agentId}/profile', { list: undefined }),
    {
      title: 'Agent profile',
      description: 'One stable agent profile',
      mimeType: 'application/json',
    },
    async (uri, { agentId }) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(await client.agents.get(String(agentId)), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    'agent-wins',
    new ResourceTemplate('synomem://agents/{agentId}/wins', { list: undefined }),
    {
      title: 'Agent wins',
      description: 'Ten most recent visible, active kudos summaries for one agent',
      mimeType: 'application/json',
    },
    async (uri, { agentId }) => {
      const page = await client.kudos.list({
        recipientAgentId: String(agentId),
        revoked: false,
        limit: 10,
      });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(page, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    'agent-inbox',
    new ResourceTemplate('synomem://agents/{agentId}/inbox', { list: undefined }),
    {
      title: 'Agent inbox',
      description: 'Ten recent visible pending kudos, memos, and tasks for one agent',
      mimeType: 'application/json',
    },
    async (uri, { agentId }) => {
      const requested = String(agentId);
      const profile = await client.agents.get(requested);
      if (actor.kind === 'agent' && profile.id !== actor.id) {
        throw new SynomemError(
          'POLICY_FORBIDDEN',
          'An agent may read only its own inbox resource.',
        );
      }
      const page = await client.items.list({
        participantAgentId: profile.id,
        limit: 10,
      });
      page.items = page.items.filter((item) =>
        ['unacknowledged', 'unread', 'open'].includes(item.status),
      );
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(page, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    'event',
    new ResourceTemplate('synomem://events/{eventId}', { list: undefined }),
    {
      title: 'Synomem event',
      description: 'One visible canonical event',
      mimeType: 'application/json',
    },
    async (uri, { eventId }) => {
      const event = await client.getCanonicalEvent(String(eventId));
      if (!event) throw new SynomemError('ITEM_NOT_FOUND', `Unknown event: ${String(eventId)}`);
      if (!event.type.startsWith('agent.')) await client.items.get(event.aggregateId);
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(event, null, 2) },
        ],
      };
    },
  );

  server.registerResource(
    'item',
    new ResourceTemplate('synomem://items/{itemId}', { list: undefined }),
    {
      title: 'Synomem item',
      description: 'One authorized full item record',
      mimeType: 'application/json',
    },
    async (uri, { itemId }) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(await client.items.get(String(itemId)), null, 2),
        },
      ],
    }),
  );

  server.registerPrompt(
    'synomem_recognize_contribution',
    {
      title: 'Recognize a contribution',
      description: 'Draft concrete, evidence-based kudos without inventing accomplishments.',
      argsSchema: {
        recipient: z.string().describe('Known agent ID'),
        contribution: z.string().describe('Observed contribution and why it mattered'),
      },
    },
    ({ recipient, contribution }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Prepare specific kudos for ${recipient}. Describe what the agent did, why it mattered, and only evidence actually observed: ${contribution}. Do not invent details or include secrets.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'synomem_review_kudos_inbox',
    {
      title: 'Review kudos inbox',
      description:
        'Review the configured agent’s unacknowledged kudos before acknowledging any item.',
    },
    () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Review the kudos inbox for ${actor.displayName ?? actor.id}. Summarize each concrete contribution. Acknowledge only after it has been reviewed; acknowledgment records receipt, not blanket agreement.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'synomem_summarize_agent_wins',
    {
      title: 'Summarize agent wins',
      description: 'Summarize supported recognition without embellishment.',
      argsSchema: { agentId: agentIdSchema },
    },
    ({ agentId }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Summarize active, visible wins for ${agentId}. Stay factual, distinguish acknowledgment state, and do not infer accomplishments absent from the records.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'synomem_send_durable_memo',
    {
      title: 'Send a durable memo',
      description: 'Turn necessary inter-agent information into a concise, secret-free memo.',
      argsSchema: { recipient: agentIdSchema, information: z.string() },
    },
    ({ recipient, information }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Prepare a concise one-to-one memo for ${recipient} containing only the durable information needed later: ${information}. Do not include secrets, raw tool output, or unnecessary transcript content.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'synomem_capture_agent_note',
    {
      title: 'Capture agent memory',
      description: 'Turn reusable knowledge into a concise owner-private note.',
      argsSchema: { knowledge: z.string() },
    },
    ({ knowledge }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Prepare an owner-private Synomem note containing concise reusable knowledge: ${knowledge}. Distinguish verified facts from uncertainty and omit secrets.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'synomem_create_actionable_task',
    {
      title: 'Create an actionable task',
      description:
        'Turn requested work into a concrete assigned action without inventing deadlines.',
      argsSchema: { assignee: agentIdSchema, action: z.string() },
    },
    ({ assignee, action }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Prepare a concrete task assigned to ${assignee}: ${action}. Preserve a date-only deadline as a date, require timezone data for a timed deadline, and do not invent missing timing.`,
          },
        },
      ],
    }),
  );

  return {
    server,
    client,
    async close() {
      await server.close();
      await client.close();
    },
  };
}

export async function startMcpServer(
  options: SynomemMcpOptions,
  serviceFactory: SynomemServiceFactory = configuredServiceFactory,
): Promise<SynomemMcpRuntime> {
  const runtime = await createSynomemMcpServer(options, serviceFactory);
  const transport = new StdioServerTransport();
  await runtime.server.connect(transport);
  return runtime;
}
