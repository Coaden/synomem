/*
 * Finding out which workspace a credential belongs to, so nobody has to type
 * one from memory.
 *
 * A hosted workspace ID looks like `ws-04psqx2rkt8ttft7a1t2z69r97`. Asking a
 * person to enter that during setup is asking them to leave and go find it, and
 * the credential they just authorized already knows the answer -- or knows
 * enough to offer a short list.
 *
 * Two credentials, two routes, because they carry different authority:
 *
 *   An installation access key is bound to exactly one workspace. There is
 *   nothing to choose, so `discoverBoundWorkspace` reads it off the data plane
 *   and setup asks nothing at all.
 *
 *   A browser sign-in authorizes an ACCOUNT, which may reach several
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
 * The single workspace an installation access key can address.
 *
 * Answered by the data plane rather than the control plane: an installation key
 * is not an account principal, so it cannot list organizations, but it can
 * always say where it is bound.
 */
export async function discoverBoundWorkspace(
  options: DiscoveryOptions,
): Promise<{ workspaceId: string; actor: { kind: string; id: string; displayName?: string } }> {
  const identity = await readJson<{
    workspaceId: string;
    actor: { kind: string; id: string; displayName?: string };
  }>(options, 'v1/identity');
  if (!identity.workspaceId) {
    throw new SynomemError('REMOTE_PROTOCOL', 'The service did not report a bound workspace.');
  }
  return { workspaceId: identity.workspaceId, actor: identity.actor };
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
