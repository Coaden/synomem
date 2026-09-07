import { actorSchema } from './schemas.js';
import { asSynomemError, errorCodes, SynomemError, type SynomemErrorCode } from './errors.js';
import type { SynomemService, SynomemServiceCapabilities, SynomemServiceInfo } from './service.js';
import type {
  ActorIdentity,
  ChangesInput,
  BindRuntimeInput,
  CreateAgentInput,
  CreatePostInput,
  UpdatePostInput,
  CreateNoteInput,
  CreateTaskInput,
  GiveKudosInput,
  ItemListInput,
  KudosListInput,
  ReviseNoteInput,
  SendMemoInput,
  UpdateAgentInput,
  UpdateTaskInput,
  UpdateTodoInput,
  CreateTodoInput,
} from './types.js';

const defaultMaximumResponseBytes = 1024 * 1024;
const defaultTimeoutMs = 15_000;

export interface SynomemCredentialProvider {
  getAccessToken(signal?: AbortSignal): Promise<string | undefined>;
}

export interface RemoteSynomemOptions {
  baseUrl: string;
  workspaceId: string;
  expectedActor: ActorIdentity;
  credentialProvider: SynomemCredentialProvider;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  maximumResponseBytes?: number;
}

interface ApiErrorEnvelope {
  ok: false;
  error: { code: string; message: string; details?: Record<string, unknown>; requestId?: string };
}

interface ApiSuccessEnvelope<T> {
  ok: true;
  data: T;
  requestId?: string;
}

function remoteBaseUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SynomemError('CONFIG_INVALID', 'Remote Synomem baseUrl must be an absolute URL.');
  }
  const loopback =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new SynomemError(
      'CONFIG_INVALID',
      'Remote Synomem requires HTTPS except for explicit loopback development URLs.',
    );
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== '/'
  ) {
    throw new SynomemError(
      'CONFIG_INVALID',
      'Remote Synomem baseUrl cannot contain credentials, paths, query parameters, or fragments.',
    );
  }
  return new URL(parsed.href.endsWith('/') ? parsed.href : `${parsed.href}/`);
}

function queryString(input: object): string {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) parameters.append(key, String(item));
    } else {
      parameters.set(key, String(value));
    }
  }
  const encoded = parameters.toString();
  return encoded ? `?${encoded}` : '';
}

function knownErrorCode(value: string): SynomemErrorCode {
  return errorCodes.some((code) => code === value)
    ? (value as SynomemErrorCode)
    : 'REMOTE_PROTOCOL';
}

async function boundedResponseBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader() as unknown as {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(): Promise<void>;
  };
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) {
      throw new SynomemError('REMOTE_PROTOCOL', 'Remote response stream was malformed.');
    }
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw new SynomemError('REMOTE_PROTOCOL', 'Remote response exceeded the configured limit.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function environmentCredentialProvider(
  env: NodeJS.ProcessEnv = process.env,
): SynomemCredentialProvider {
  return {
    async getAccessToken() {
      return env.SYNOMEM_ACCESS_TOKEN;
    },
  };
}

export class RemoteSynomemService implements SynomemService {
  readonly actor: ActorIdentity;
  private readonly baseUrl: URL;
  private readonly workspaceId: string;
  private readonly credentialProvider: SynomemCredentialProvider;
  private readonly fetchImplementation: typeof fetch;
  private readonly signal?: AbortSignal;
  private readonly timeoutMs: number;
  private readonly maximumResponseBytes: number;
  private initialized = false;
  private cachedCapabilities?: SynomemServiceCapabilities;

  readonly agents = {
    create: (input: CreateAgentInput) =>
      this.request<Awaited<ReturnType<SynomemService['agents']['create']>>>(
        'POST',
        'agents',
        input,
      ),
    update: (id: string, changes: UpdateAgentInput) =>
      this.request<Awaited<ReturnType<SynomemService['agents']['update']>>>(
        'PATCH',
        `agents/${encodeURIComponent(id)}`,
        changes,
      ),
    get: (idOrAlias: string) =>
      this.request<Awaited<ReturnType<SynomemService['agents']['get']>>>(
        'GET',
        `agents/${encodeURIComponent(idOrAlias)}`,
      ),
    list: () =>
      this.request<Awaited<ReturnType<SynomemService['agents']['list']>>>('GET', 'agents'),
    resolve: (query: string) =>
      this.request<Awaited<ReturnType<SynomemService['agents']['resolve']>>>(
        'GET',
        `agents/resolve?query=${encodeURIComponent(query)}`,
      ),
    directory: () =>
      this.request<Awaited<ReturnType<SynomemService['agents']['directory']>>>(
        'GET',
        'agents/directory',
      ),
    bindings: (idOrAlias: string) =>
      this.request<Awaited<ReturnType<SynomemService['agents']['bindings']>>>(
        'GET',
        `agents/${encodeURIComponent(idOrAlias)}/runtimes`,
      ),
    bindRuntime: (input: BindRuntimeInput) =>
      this.mutation<Awaited<ReturnType<SynomemService['agents']['bindRuntime']>>>(
        'POST',
        `agents/${encodeURIComponent(input.agentId)}/runtimes`,
        input,
      ),
    unbindRuntime: (bindingId: string) =>
      this.request<Awaited<ReturnType<SynomemService['agents']['unbindRuntime']>>>(
        'DELETE',
        `agents/runtimes/${encodeURIComponent(bindingId)}`,
      ),
  };

  readonly posts = {
    create: (input: CreatePostInput) =>
      this.mutation<Awaited<ReturnType<SynomemService['posts']['create']>>>('POST', 'posts', input),
    list: (input: Omit<ItemListInput, 'kinds'> = {}) =>
      this.request<Awaited<ReturnType<SynomemService['posts']['list']>>>(
        'GET',
        `posts${queryString(input)}`,
      ),
    get: (id: string) =>
      this.request<Awaited<ReturnType<SynomemService['posts']['get']>>>(
        'GET',
        `posts/${encodeURIComponent(id)}`,
      ),
    update: (input: UpdatePostInput) =>
      this.mutation<Awaited<ReturnType<SynomemService['posts']['update']>>>(
        'POST',
        `posts/${encodeURIComponent(input.postId)}/revisions`,
        input,
        ['postId'],
      ),
    archive: (input: { postId: string; reason?: string; idempotencyKey?: string }) =>
      this.mutation<Awaited<ReturnType<SynomemService['posts']['archive']>>>(
        'POST',
        `posts/${encodeURIComponent(input.postId)}/archive`,
        input,
        ['postId'],
      ),
    acknowledge: (input: { postId: string; note?: string; idempotencyKey?: string }) =>
      this.mutation<Awaited<ReturnType<SynomemService['posts']['acknowledge']>>>(
        'POST',
        `posts/${encodeURIComponent(input.postId)}/acknowledgment`,
        input,
        ['postId'],
      ),
    withdrawAcknowledgment: (input: { postId: string; reason?: string }) =>
      this.request<Awaited<ReturnType<SynomemService['posts']['withdrawAcknowledgment']>>>(
        'DELETE',
        `posts/${encodeURIComponent(input.postId)}/acknowledgment`,
      ),
    roster: (postId: string) =>
      this.request<Awaited<ReturnType<SynomemService['posts']['roster']>>>(
        'GET',
        `posts/${encodeURIComponent(postId)}/roster`,
      ),
  };

  readonly kudos = {
    give: (input: GiveKudosInput) =>
      this.mutation<Awaited<ReturnType<SynomemService['kudos']['give']>>>('POST', 'kudos', input),
    list: (input: KudosListInput = {}) =>
      this.request<Awaited<ReturnType<SynomemService['kudos']['list']>>>(
        'GET',
        `kudos${queryString(input)}`,
      ),
    changes: (input: ChangesInput = {}) =>
      this.request<Awaited<ReturnType<SynomemService['kudos']['changes']>>>(
        'GET',
        `kudos/changes${queryString(input)}`,
      ),
    get: (id: string) =>
      this.request<Awaited<ReturnType<SynomemService['kudos']['get']>>>(
        'GET',
        `kudos/${encodeURIComponent(id)}`,
      ),
    acknowledge: (input: { kudosId: string; note?: string }) =>
      this.request<Awaited<ReturnType<SynomemService['kudos']['acknowledge']>>>(
        'POST',
        `kudos/${encodeURIComponent(input.kudosId)}/acknowledgment`,
        input.note === undefined ? {} : { note: input.note },
      ),
    revoke: (input: { kudosId: string; reason: string; administrative?: boolean }) =>
      this.request<Awaited<ReturnType<SynomemService['kudos']['revoke']>>>(
        'POST',
        `kudos/${encodeURIComponent(input.kudosId)}/revocation`,
        { reason: input.reason },
      ),
  };

  readonly memos = {
    send: (input: SendMemoInput) =>
      this.mutation<Awaited<ReturnType<SynomemService['memos']['send']>>>('POST', 'memos', input),
    list: (input: Omit<ItemListInput, 'kinds'> = {}) =>
      this.request<Awaited<ReturnType<SynomemService['memos']['list']>>>(
        'GET',
        `memos${queryString(input)}`,
      ),
    get: (id: string) =>
      this.request<Awaited<ReturnType<SynomemService['memos']['get']>>>(
        'GET',
        `memos/${encodeURIComponent(id)}`,
      ),
    read: (input: { memoId: string; idempotencyKey?: string }) =>
      this.mutation<Awaited<ReturnType<SynomemService['memos']['read']>>>(
        'POST',
        `memos/${encodeURIComponent(input.memoId)}/read`,
        input,
        ['memoId'],
      ),
    archive: (input: { memoId: string; idempotencyKey?: string }) =>
      this.mutation<Awaited<ReturnType<SynomemService['memos']['archive']>>>(
        'POST',
        `memos/${encodeURIComponent(input.memoId)}/archive`,
        input,
        ['memoId'],
      ),
  };

  readonly notes = {
    create: (input: CreateNoteInput) =>
      this.mutation<Awaited<ReturnType<SynomemService['notes']['create']>>>('POST', 'notes', input),
    list: (input: Omit<ItemListInput, 'kinds'> = {}) =>
      this.request<Awaited<ReturnType<SynomemService['notes']['list']>>>(
        'GET',
        `notes${queryString(input)}`,
      ),
    get: (id: string) =>
      this.request<Awaited<ReturnType<SynomemService['notes']['get']>>>(
        'GET',
        `notes/${encodeURIComponent(id)}`,
      ),
    revise: (input: ReviseNoteInput) =>
      this.mutation<Awaited<ReturnType<SynomemService['notes']['revise']>>>(
        'POST',
        `notes/${encodeURIComponent(input.noteId)}/revisions`,
        input,
        ['noteId'],
      ),
    archive: (input: { noteId: string; idempotencyKey?: string }) =>
      this.mutation<Awaited<ReturnType<SynomemService['notes']['archive']>>>(
        'POST',
        `notes/${encodeURIComponent(input.noteId)}/archive`,
        input,
        ['noteId'],
      ),
  };

  readonly tasks = {
    create: (input: CreateTaskInput) =>
      this.mutation<Awaited<ReturnType<SynomemService['tasks']['create']>>>('POST', 'tasks', input),
    list: (input: Omit<ItemListInput, 'kinds'> = {}) =>
      this.request<Awaited<ReturnType<SynomemService['tasks']['list']>>>(
        'GET',
        `tasks${queryString(input)}`,
      ),
    get: (id: string) =>
      this.request<Awaited<ReturnType<SynomemService['tasks']['get']>>>(
        'GET',
        `tasks/${encodeURIComponent(id)}`,
      ),
    update: (input: UpdateTaskInput) =>
      this.mutation<Awaited<ReturnType<SynomemService['tasks']['update']>>>(
        'POST',
        `tasks/${encodeURIComponent(input.taskId)}/revisions`,
        input,
        ['taskId'],
      ),
    accept: (input: { taskId: string; response?: string; idempotencyKey?: string }) =>
      this.taskTransition('accept', input),
    reject: (input: { taskId: string; response: string; idempotencyKey?: string }) =>
      this.taskTransition('reject', input),
    complete: (input: { taskId: string; note?: string; idempotencyKey?: string }) =>
      this.taskTransition('complete', input),
    reopen: (input: { taskId: string; idempotencyKey?: string }) =>
      this.taskTransition('reopen', input),
    cancel: (input: { taskId: string; reason?: string; idempotencyKey?: string }) =>
      this.taskTransition('cancel', input),
  };

  /**
   * Private self-reminders. The remote surface mirrors the local one exactly so
   * a caller does not have to know which backend it is talking to.
   */
  readonly todos = {
    create: (input: CreateTodoInput) =>
      this.mutation<Awaited<ReturnType<SynomemService['todos']['create']>>>('POST', 'todos', input),
    list: (input: Omit<ItemListInput, 'kinds'> = {}) =>
      this.request<Awaited<ReturnType<SynomemService['todos']['list']>>>(
        'GET',
        `todos${queryString(input)}`,
      ),
    get: (id: string) =>
      this.request<Awaited<ReturnType<SynomemService['todos']['get']>>>(
        'GET',
        `todos/${encodeURIComponent(id)}`,
      ),
    update: (input: UpdateTodoInput) =>
      this.mutation<Awaited<ReturnType<SynomemService['todos']['update']>>>(
        'POST',
        `todos/${encodeURIComponent(input.todoId)}/revisions`,
        input,
        ['todoId'],
      ),
    complete: (input: { todoId: string; note?: string; idempotencyKey?: string }) =>
      this.todoTransition('complete', input),
    reopen: (input: { todoId: string; idempotencyKey?: string }) =>
      this.todoTransition('reopen', input),
    cancel: (input: { todoId: string; reason?: string; idempotencyKey?: string }) =>
      this.todoTransition('cancel', input),
    archive: (input: { todoId: string; idempotencyKey?: string }) =>
      this.todoTransition('archive', input),
  };

  /**
   * Discovery mirrors the local semantics: the age/deadline is resolved here so
   * both backends answer the same question, rather than each server deciding
   * what "older than 24 hours" means.
   */
  readonly discovery = {
    unanswered: (
      input: Omit<ItemListInput, 'awaitingResponse' | 'pending'> & { olderThanHours?: number } = {},
    ) => {
      const { olderThanHours, awaitingSince, ...rest } = input;
      const since =
        awaitingSince ??
        (olderThanHours !== undefined
          ? new Date(Date.now() - olderThanHours * 3_600_000).toISOString()
          : undefined);
      return this.request<Awaited<ReturnType<SynomemService['items']['list']>>>(
        'GET',
        `items${queryString({ ...rest, awaitingResponse: true, ...(since ? { awaitingSince: since } : {}) })}`,
      );
    },
    overdue: (input: Omit<ItemListInput, 'overdueAsOf'> & { asOf?: string } = {}) => {
      const { asOf, ...rest } = input;
      return this.request<Awaited<ReturnType<SynomemService['items']['list']>>>(
        'GET',
        `items${queryString({ ...rest, overdueAsOf: asOf ?? new Date().toISOString() })}`,
      );
    },
  };

  readonly items = {
    list: (input: ItemListInput = {}) =>
      this.request<Awaited<ReturnType<SynomemService['items']['list']>>>(
        'GET',
        `items${queryString(input)}`,
      ),
    get: (id: string) =>
      this.request<Awaited<ReturnType<SynomemService['items']['get']>>>(
        'GET',
        `items/${encodeURIComponent(id)}`,
      ),
    changes: (input: ChangesInput = {}) =>
      this.request<Awaited<ReturnType<SynomemService['items']['changes']>>>(
        'GET',
        `changes${queryString(input)}`,
      ),
  };

  constructor(options: RemoteSynomemOptions) {
    this.baseUrl = remoteBaseUrl(options.baseUrl);
    if (!options.workspaceId.trim() || options.workspaceId.length > 100) {
      throw new SynomemError('CONFIG_INVALID', 'Remote Synomem workspaceId is required.');
    }
    this.workspaceId = options.workspaceId;
    try {
      this.actor = actorSchema.parse(options.expectedActor);
    } catch (error) {
      throw asSynomemError(error);
    }
    this.credentialProvider = options.credentialProvider;
    this.fetchImplementation = options.fetch ?? fetch;
    this.signal = options.signal;
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.maximumResponseBytes = options.maximumResponseBytes ?? defaultMaximumResponseBytes;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new SynomemError('CONFIG_INVALID', 'Remote timeoutMs must be a positive integer.');
    }
    if (!Number.isSafeInteger(this.maximumResponseBytes) || this.maximumResponseBytes < 1024) {
      throw new SynomemError(
        'CONFIG_INVALID',
        'Remote maximumResponseBytes must be an integer of at least 1024.',
      );
    }
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.cachedCapabilities = await this.request<SynomemServiceCapabilities>(
      'GET',
      '../../capabilities',
    );
    if (this.cachedCapabilities.backend !== 'remote') {
      throw new SynomemError('REMOTE_PROTOCOL', 'The configured server is not a remote backend.');
    }
    const binding = this.cachedCapabilities.binding;
    if (
      binding.workspaceId !== this.workspaceId ||
      binding.actor.kind !== this.actor.kind ||
      binding.actor.id !== this.actor.id
    ) {
      throw new SynomemError(
        'AUTH_FORBIDDEN',
        'The authenticated Synomem actor does not match the configured actor.',
      );
    }
    this.initialized = true;
  }

  async close(): Promise<void> {
    this.initialized = false;
  }

  stats(input: KudosListInput = {}) {
    return this.request<Awaited<ReturnType<SynomemService['stats']>>>(
      'GET',
      `kudos/stats${queryString(input)}`,
    );
  }

  doctor() {
    return this.request<Awaited<ReturnType<SynomemService['doctor']>>>('GET', 'diagnostics');
  }

  async export(format: 'json' | 'jsonl' | 'markdown'): Promise<string> {
    const result = await this.request<{ content: string }>(
      'GET',
      `export${queryString({ format })}`,
    );
    return result.content;
  }

  rebuild() {
    return this.request<Awaited<ReturnType<SynomemService['rebuild']>>>(
      'POST',
      'administration/rebuild',
      {},
    );
  }

  async capabilities(): Promise<SynomemServiceCapabilities> {
    return (
      this.cachedCapabilities ??
      (await this.request<SynomemServiceCapabilities>('GET', '../../capabilities'))
    );
  }

  async info(): Promise<SynomemServiceInfo> {
    return { backend: 'remote', baseUrl: this.baseUrl.href, workspaceId: this.workspaceId };
  }

  getCanonicalEvent(id: string) {
    return this.request<Awaited<ReturnType<SynomemService['getCanonicalEvent']>>>(
      'GET',
      `events/${encodeURIComponent(id)}`,
    );
  }

  private taskTransition(
    transition: 'accept' | 'reject' | 'complete' | 'reopen' | 'cancel',
    input: {
      taskId: string;
      idempotencyKey?: string;
      reason?: string;
      note?: string;
      response?: string;
    },
  ) {
    return this.mutation<Awaited<ReturnType<SynomemService['tasks']['accept']>>>(
      'POST',
      `tasks/${encodeURIComponent(input.taskId)}/${transition}`,
      input,
      ['taskId'],
    );
  }

  private todoTransition(
    transition: 'complete' | 'reopen' | 'cancel' | 'archive',
    input: { todoId: string; idempotencyKey?: string; reason?: string; note?: string },
  ) {
    return this.mutation<Awaited<ReturnType<SynomemService['todos']['complete']>>>(
      'POST',
      `todos/${encodeURIComponent(input.todoId)}/${transition}`,
      input,
      ['todoId'],
    );
  }

  private mutation<T>(
    method: 'POST' | 'PATCH',
    path: string,
    input: object,
    omittedKeys: string[] = [],
  ): Promise<T> {
    const body = { ...input } as Record<string, unknown>;
    const idempotencyKey =
      typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined;
    delete body.idempotencyKey;
    for (const key of omittedKeys) delete body[key];
    return this.request<T>(method, path, body, idempotencyKey);
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: object,
    idempotencyKey?: string,
  ): Promise<T> {
    const accessToken = await this.credentialProvider.getAccessToken(this.signal);
    if (!accessToken) {
      throw new SynomemError('AUTH_REQUIRED', 'Remote Synomem authentication is required.');
    }
    const workspaceBase = new URL(
      `v1/workspaces/${encodeURIComponent(this.workspaceId)}/`,
      this.baseUrl,
    );
    const url = new URL(path, workspaceBase);
    if (url.origin !== this.baseUrl.origin) {
      throw new SynomemError('CONFIG_INVALID', 'Remote request escaped the configured origin.');
    }
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = this.signal ? AbortSignal.any([this.signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        method,
        redirect: 'manual',
        signal,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${accessToken}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      if (this.signal?.aborted) throw error;
      throw new SynomemError('REMOTE_UNAVAILABLE', 'The remote Synomem service is unavailable.', {
        cause: error instanceof Error ? error.name : 'network_error',
      });
    }
    if (response.status >= 300 && response.status < 400) {
      throw new SynomemError('REMOTE_PROTOCOL', 'Remote redirects are not followed.');
    }
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > this.maximumResponseBytes) {
      throw new SynomemError('REMOTE_PROTOCOL', 'Remote response exceeded the configured limit.');
    }
    const bytes = await boundedResponseBytes(response, this.maximumResponseBytes);
    let envelope: ApiSuccessEnvelope<T> | ApiErrorEnvelope;
    try {
      envelope = JSON.parse(new TextDecoder().decode(bytes)) as
        ApiSuccessEnvelope<T> | ApiErrorEnvelope;
    } catch {
      throw new SynomemError('REMOTE_PROTOCOL', 'Remote Synomem returned invalid JSON.');
    }
    if (!response.ok || envelope.ok !== true) {
      if (envelope.ok !== false || !envelope.error || typeof envelope.error.message !== 'string') {
        throw new SynomemError('REMOTE_PROTOCOL', 'Remote Synomem returned an invalid error.');
      }
      const code =
        response.status === 401
          ? 'AUTH_REQUIRED'
          : response.status === 403
            ? 'AUTH_FORBIDDEN'
            : response.status === 429
              ? 'RATE_LIMITED'
              : knownErrorCode(envelope.error.code);
      throw new SynomemError(code, envelope.error.message, {
        ...(envelope.error.details ?? {}),
        ...(envelope.error.requestId ? { requestId: envelope.error.requestId } : {}),
      });
    }
    if (!('data' in envelope)) {
      throw new SynomemError('REMOTE_PROTOCOL', 'Remote Synomem response omitted data.');
    }
    return envelope.data;
  }
}
