/*
 * Finding out what a credential can reach, so nobody has to type an id from memory.
 *
 * Two questions, two routes, because they carry different authority:
 *
 *   `discoverContexts` / `describeIdentity` ask the DATA plane, with any credential
 *   (OAuth access token or `syn_` access key), which workspace/actor targets that
 *   credential's grant may use right now (identity contract §4). No context has to be
 *   chosen first — that is the point.
 *
 *   `discoverOrganizations` asks the control plane which organizations an account
 *   belongs to, for first-party setup flows that hold an account session.
 */
import { SynomemError } from './errors.js';
import type { ContextListing, IdentityDescription } from './types.js';

export interface DiscoveredWorkspace {
  id: string;
  displayName: string;
}

export interface DiscoveredOrganization {
  id: string;
  slug: string;
  displayName: string;
  role: string;
  workspaces: DiscoveredWorkspace[];
}

export interface DiscoveryOptions {
  baseUrl: string;
  accessToken: string;
  /** Injected by tests. Defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

interface Envelope<T> {
  ok?: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}

async function readJson<T>(
  options: DiscoveryOptions,
  path: string,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const request = options.fetch ?? globalThis.fetch;
  const url = new URL(
    path,
    options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`,
  );
  let response: Response;
  try {
    response = await request(url, {
      headers: {
        authorization: `Bearer ${options.accessToken}`,
        accept: 'application/json',
        ...extraHeaders,
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    throw new SynomemError(
      'REMOTE_UNAVAILABLE',
      `Could not reach ${url.origin}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let body: Envelope<T>;
  try {
    body = (await response.json()) as Envelope<T>;
  } catch {
    throw new SynomemError('REMOTE_PROTOCOL', `${url.pathname} did not return JSON.`);
  }
  if (!response.ok || body.ok !== true || body.data === undefined) {
    // 401 and 403 are the ones a person can act on, so they keep their own
    // codes rather than being flattened into a generic protocol error.
    const reported = body.error?.code;
    const code =
      reported === 'CONTEXT_REQUIRED' ||
      reported === 'CONTEXT_FORBIDDEN' ||
      reported === 'CONTEXT_AMBIGUOUS' ||
      reported === 'REAUTHORIZATION_REQUIRED'
        ? reported
        : response.status === 401
          ? 'AUTH_REQUIRED'
          : response.status === 403
            ? 'AUTH_FORBIDDEN'
            : null;
    const message = body.error?.message ?? `${url.pathname} returned ${response.status}.`;
    throw new SynomemError(code ?? 'REMOTE_PROTOCOL', message);
  }
  return body.data;
}

/**
 * Every organization this account belongs to, each with its workspaces.
 *
 * Organizations are listed even when they hold no workspaces yet, because
 * "you belong to this organization and it is empty" is a different and more
 * useful answer than omitting it and appearing to have found nothing.
 */
export async function discoverOrganizations(
  options: DiscoveryOptions,
): Promise<DiscoveredOrganization[]> {
  const me = await readJson<{
    organizations: { id: string; slug: string; displayName: string; role: string }[];
  }>(options, 'v1/me');
  const organizations: DiscoveredOrganization[] = [];
  for (const organization of me.organizations ?? []) {
    const workspaces = await readJson<{ id: string; displayName: string }[]>(
      options,
      `v1/organizations/${encodeURIComponent(organization.id)}/workspaces`,
    );
    organizations.push({
      id: organization.id,
      slug: organization.slug,
      displayName: organization.displayName,
      role: organization.role,
      workspaces: (workspaces ?? []).map((workspace) => ({
        id: workspace.id,
        displayName: workspace.displayName,
      })),
    });
  }
  return organizations;
}

/**
 * Every context this credential's grant may use right now, with canonical ids
 * (`GET /v1/contexts`). Follows `nextCursor` until the listing is complete, bounded.
 */
export async function discoverContexts(options: DiscoveryOptions): Promise<ContextListing> {
  let listing: ContextListing | undefined;
  let cursor: string | null | undefined;
  for (let page = 0; page < 20; page += 1) {
    const next: ContextListing = await readJson<ContextListing>(
      options,
      `v1/contexts?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    listing = listing ? { ...next, contexts: [...listing.contexts, ...next.contexts] } : next;
    cursor = next.nextCursor;
    if (!cursor) break;
  }
  return { ...listing!, nextCursor: null };
}

/** Who this credential is: account, connection, grant, and effective context if selected. */
export async function describeIdentity(
  options: DiscoveryOptions & { contextId?: string },
): Promise<IdentityDescription> {
  return await readJson<IdentityDescription>(
    options,
    'v1/identity',
    options.contextId ? { 'synomem-context-id': options.contextId } : undefined,
  );
}

/** Flattens discovery into the choices a person picks from. */
export function workspaceChoices(
  organizations: DiscoveredOrganization[],
): Array<{ value: string; label: string; detail?: string }> {
  const choices: Array<{ value: string; label: string; detail?: string }> = [];
  for (const organization of organizations) {
    for (const workspace of organization.workspaces) {
      choices.push({
        value: workspace.id,
        // The organization is part of the label, not the detail: two
        // organizations may both have a workspace called "Production", and the
        // label is the only part a person is guaranteed to read.
        label: `${organization.displayName} / ${workspace.displayName}`,
        detail: workspace.id,
      });
    }
  }
  return choices;
}
