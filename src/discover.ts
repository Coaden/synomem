/*
 * Finding out which workspaces a credential can reach, so nobody has to type
 * one from memory.
 *
 * A hosted workspace ID looks like `ws-04psqx2rkt8ttft7a1t2z69r97`. Asking a
 * person to enter that during setup is asking them to leave and go find it, and
 * the credential they just authorized already knows the answer -- or knows
 * enough to offer a short list.
 *
 * Two credentials, two routes, because they carry different authority:
 *
 *   A member-owned access key authenticates the ACCOUNT that created it, and
 *   reaches every workspace in that account's organization -- never just one
 *   -- so `discoverAccessKeyWorkspaces` lists them off the data plane, with no
 *   workspace chosen yet, which is exactly what setup cannot supply up front.
 *
 *   A browser sign-in also authorizes an ACCOUNT, which may reach several
 *   organizations, each with several workspaces. `discoverOrganizations` lists
 *   them for selection.
 */
import { SynomemError } from './errors.js';

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

export interface WorkspaceMembership {
  id: string;
  displayName: string;
  roles: string[];
  /**
   * Reachable right now, with this same credential, by naming it as
   * Synomem-Workspace-Id — no new token or re-authentication. A human
   * credential's own organization is the boundary; an agent credential has
   * only ever one such entry, its own.
   */
  addressableWithThisToken: boolean;
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

async function readJson<T>(options: DiscoveryOptions, path: string): Promise<T> {
  const request = options.fetch ?? globalThis.fetch;
  const url = new URL(
    path,
    options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`,
  );
  let response: Response;
  try {
    response = await request(url, {
      headers: { authorization: `Bearer ${options.accessToken}`, accept: 'application/json' },
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
    const code =
      response.status === 401 ? 'AUTH_REQUIRED' : response.status === 403 ? 'AUTH_FORBIDDEN' : null;
    const message = body.error?.message ?? `${url.pathname} returned ${response.status}.`;
    throw new SynomemError(code ?? 'REMOTE_PROTOCOL', message);
  }
  return body.data;
}

/**
 * Every workspace a member-owned access key can reach, asked before any one
 * of them has been chosen.
 *
 * Answered by the data plane rather than the control plane: an access key is
 * not an account principal the control plane recognizes, but the data plane
 * already knows which organization owns it and can list that organization's
 * workspaces without requiring one to be named first.
 */
export async function discoverAccessKeyWorkspaces(
  options: DiscoveryOptions,
): Promise<{ organizationId: string; workspaces: DiscoveredWorkspace[] }> {
  return await readJson<{ organizationId: string; workspaces: DiscoveredWorkspace[] }>(
    options,
    'v1/access-keys/workspaces',
  );
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
 * Every workspace this credential's account belongs to, and which are
 * reachable right now without a new token — the data-plane counterpart to
 * `discoverOrganizations`, and the one that actually works with an ordinary
 * bearer token (OAuth or access key alike). `/v1/me` requires a first-party
 * control-plane credential a CLI never holds; `/v1/identity` requires only
 * the normal `synomem:read` scope every credential already has.
 */
export async function discoverIdentity(
  options: DiscoveryOptions,
): Promise<{ workspaceId: string; workspaces: WorkspaceMembership[] }> {
  return await readJson<{ workspaceId: string; workspaces: WorkspaceMembership[] }>(
    options,
    'v1/identity',
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
