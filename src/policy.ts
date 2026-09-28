import type { ActorIdentity } from './types.js';

/** A delivery/ownership target. Identity is always scoped to a workspace. */
export type ActorRef = Readonly<{ kind: 'human' | 'agent'; id: string }>;

export interface AddressableActor extends ActorRef {
  handle: string;
  displayName: string;
  status: 'active' | 'inactive';
}

/** Verified adapter authority, never accepted from a request or tool argument. */
export interface RecordAuthority {
  mode: 'local-owner' | 'local-member' | 'hosted';
  workspaceAdministrator: boolean;
  organizationAdministrator: boolean;
  operatedAgentIds: ReadonlySet<string>;
}

export function sameActor(
  a: Pick<ActorIdentity, 'kind' | 'id'>,
  b: Pick<ActorIdentity, 'kind' | 'id'>,
): boolean {
  return a.kind === b.kind && a.id === b.id;
}

export function actorKey(actor: Pick<ActorIdentity, 'kind' | 'id'>): string {
  return `${actor.kind}:${actor.id}`;
}

export function resolveAuthority(authority?: RecordAuthority): RecordAuthority {
  return {
    mode: authority?.mode ?? 'local-member',
    workspaceAdministrator: authority?.workspaceAdministrator ?? false,
    organizationAdministrator: authority?.organizationAdministrator ?? false,
    operatedAgentIds: new Set(authority?.operatedAgentIds ?? []),
  };
}

export function isRecordAdministrator(actor: ActorIdentity, authority: RecordAuthority): boolean {
  return (
    actor.kind === 'human' &&
    (authority.mode === 'local-owner' ||
      authority.workspaceAdministrator ||
      authority.organizationAdministrator)
  );
}

export function overseesAgent(
  actor: ActorIdentity,
  authority: RecordAuthority,
  id?: string,
): boolean {
  return (
    actor.kind === 'human' &&
    (isRecordAdministrator(actor, authority) || (!!id && authority.operatedAgentIds.has(id)))
  );
}

/** Explicit local filesystem-owner entry points supply this; human profiles do not. */
export function localOwnerAuthority(): RecordAuthority {
  return {
    mode: 'local-owner',
    workspaceAdministrator: true,
    organizationAdministrator: false,
    operatedAgentIds: new Set(),
  };
}

/** SQL authority predicate; placeholder parameters are independent of the adapter. */
export function recordVisibilityPredicate(
  viewer: ActorIdentity,
  authority: RecordAuthority,
  kudosOnly = false,
  prefix = '',
): { sql: string; values: string[] } {
  if (isRecordAdministrator(viewer, authority)) return { sql: '1=1', values: [] };
  const participantColumns = kudosOnly ? ['recipient'] : ['recipient', 'owner', 'assignee'];
  const ordinary = [
    `${prefix}visibility!='private'`,
    `(${prefix}actor_kind=? AND ${prefix}actor_id=?)`,
  ];
  const values = [viewer.kind, viewer.id];
  for (const column of participantColumns) {
    ordinary.push(`(${prefix}${column}_kind=? AND ${prefix}${column}_id=?)`);
    values.push(viewer.kind, viewer.id);
  }
  if (viewer.kind === 'human')
    for (const id of authority.operatedAgentIds) {
      ordinary.push(`(${prefix}actor_kind='agent' AND ${prefix}actor_id=?)`);
      values.push(id);
      for (const column of participantColumns) {
        ordinary.push(`(${prefix}${column}_kind='agent' AND ${prefix}${column}_id=?)`);
        values.push(id);
      }
    }
  if (kudosOnly) return { sql: `(${ordinary.join(' OR ')})`, values };
  const memory = [`(${prefix}owner_kind=? AND ${prefix}owner_id=?)`];
  const memoryValues = [viewer.kind, viewer.id];
  if (viewer.kind === 'human')
    for (const id of authority.operatedAgentIds) {
      memory.push(`(${prefix}owner_kind='agent' AND ${prefix}owner_id=?)`);
      memoryValues.push(id);
    }
  return {
    sql: `((${prefix}kind NOT IN ('note','todo') AND (${ordinary.join(' OR ')})) OR (${prefix}kind IN ('note','todo') AND (${memory.join(' OR ')})))`,
    values: [...values, ...memoryValues],
  };
}
