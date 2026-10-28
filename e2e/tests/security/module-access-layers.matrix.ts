/**
 * The ADR-051 access matrix (§4 viewers, Enforcement "module-access-layers.matrix.ts"; plan
 * PKG-05, PKG-41).
 *
 * Cells are generated, never hand-written: every reference resolver the classification scanner
 * lists (tests/invariants/helpers/module-access-handlers.ts, `referenceInventory`) × every §4
 * viewer, sent as `_entities` to its subgraph with that viewer's gateway-signed assertion. A
 * reference of a `module-access` service expects what `decideAccess` answers for the viewer, its
 * read intent, its `@Access` spec and its `@Roles`; one of an `account-role` service expects the
 * behaviour before ADR-051 (`account-role`: any authenticated member of the tenant, own tenant
 * only, as auth-service's `PublicUserProfile`). The root-operation cells join from the PKG-34
 * operation manifest, and PKG-41's module-access-layers.spec.ts runs every cell against the
 * deployed stack; `tests/invariants/module-access-classification.spec.ts` requires a cell for
 * every reference resolver and viewer.
 */
import {
  decideAccess,
  userCaller,
  type AccessRequest,
  type MemberAccessSpec,
  type ModuleAccess,
  type PlatformRole,
} from '@aquaculture/shared-contracts';

export interface MatrixViewer {
  readonly id: string;
  readonly description: string;
  /** `users.role` as the token carries it. */
  readonly roles: readonly PlatformRole[];
  readonly moduleAccess: ModuleAccess;
  /** The `resourcePermissions` claim. */
  readonly capabilities: readonly string[];
  readonly assignedSiteIds: readonly string[];
}

const ALL_MODULES_MANAGED: ModuleAccess = {
  farm: 'MODULE_MANAGER',
  hr: 'MODULE_MANAGER',
  sensor: 'MODULE_MANAGER',
};

/** ADR-051 §4 (plan §2 "Test viewers"). */
export const MODULE_ACCESS_VIEWERS: readonly MatrixViewer[] = Object.freeze([
  {
    id: 'role-a',
    description: 'Role A: farm MODULE_MANAGER grant, no company:view',
    roles: ['MODULE_USER'],
    moduleAccess: { farm: 'MODULE_MANAGER' },
    capabilities: [],
    assignedSiteIds: [],
  },
  {
    id: 'role-b',
    description: 'Role B: Company Viewer, no grants',
    roles: ['MODULE_USER'],
    moduleAccess: {},
    capabilities: ['company:view'],
    assignedSiteIds: [],
  },
  {
    id: 'role-a-prime',
    description: 'Role A plus the legacy global MODULE_MANAGER',
    roles: ['MODULE_MANAGER'],
    moduleAccess: { farm: 'MODULE_MANAGER' },
    capabilities: [],
    assignedSiteIds: [],
  },
  {
    id: 'role-b-prime',
    description: 'Role B plus the legacy global MODULE_MANAGER',
    roles: ['MODULE_MANAGER'],
    moduleAccess: {},
    capabilities: ['company:view'],
    assignedSiteIds: [],
  },
  {
    id: 'farm-operator-s1',
    description: 'A farm operator on site S1',
    roles: ['MODULE_USER'],
    moduleAccess: { farm: 'MODULE_USER' },
    capabilities: [],
    assignedSiteIds: ['site-s1'],
  },
  {
    id: 'hr-manager',
    description: 'An HR manager',
    roles: ['MODULE_USER'],
    moduleAccess: { hr: 'MODULE_MANAGER' },
    capabilities: [],
    assignedSiteIds: [],
  },
  {
    id: 'sensor-manager-s9',
    description: 'A sensor manager on site S9',
    roles: ['MODULE_USER'],
    moduleAccess: { sensor: 'MODULE_MANAGER' },
    capabilities: [],
    assignedSiteIds: ['site-s9'],
  },
  {
    id: 'tenant-admin',
    description: 'TENANT_ADMIN (its claim lists every enabled module)',
    roles: ['TENANT_ADMIN'],
    moduleAccess: ALL_MODULES_MANAGED,
    capabilities: [],
    assignedSiteIds: [],
  },
  {
    id: 'tenant-admin-without-hr',
    description: 'TENANT_ADMIN of a tenant without hr',
    roles: ['TENANT_ADMIN'],
    moduleAccess: { farm: 'MODULE_MANAGER', sensor: 'MODULE_MANAGER' },
    capabilities: [],
    assignedSiteIds: [],
  },
]);

/** One `@ResolveReference` as the classification scanner lists it. */
export interface ReferenceResolverEntry {
  readonly service: string;
  readonly enrolment: 'account-role' | 'module-access';
  readonly typeName: string;
  /** The `@Access` spec of the handler or its class; null when none (denied when enrolled). */
  readonly spec: MemberAccessSpec | null;
  readonly roles: readonly PlatformRole[];
}

/** `account-role`: decided as before ADR-051 (own tenant, any authenticated member). */
export type CellExpectation = 'allowed' | 'FORBIDDEN' | 'account-role';

export interface MatrixCell {
  readonly operation: string;
  readonly service: string;
  readonly viewer: string;
  readonly expected: CellExpectation;
}

function referenceRequest(
  entry: ReferenceResolverEntry,
  spec: MemberAccessSpec,
): AccessRequest | null {
  switch (spec.kind) {
    case 'module':
    case 'scoped':
      return { spec, intent: 'read', roles: entry.roles };
    case 'company':
    case 'self':
    case 'account':
      return entry.roles.length === 0 ? { spec, intent: 'read' } : null;
  }
}

function expectationOf(entry: ReferenceResolverEntry, viewer: MatrixViewer): CellExpectation {
  if (entry.enrolment === 'account-role') return 'account-role';
  if (entry.spec === null) return 'FORBIDDEN';
  const request = referenceRequest(entry, entry.spec);
  if (request === null) return 'FORBIDDEN';
  const caller = userCaller({
    userId: `viewer-${viewer.id}`,
    tenantId: 'tenant-matrix',
    roles: viewer.roles,
    moduleAccess: viewer.moduleAccess,
    capabilities: viewer.capabilities,
  });
  return decideAccess(caller, request).allowed ? 'allowed' : 'FORBIDDEN';
}

/** Every reference resolver × every §4 viewer, with the outcome the deployed stack must show. */
export function referenceCells(references: readonly ReferenceResolverEntry[]): MatrixCell[] {
  return references.flatMap((entry) =>
    MODULE_ACCESS_VIEWERS.map((viewer) => ({
      operation: `_entities:${entry.typeName}`,
      service: entry.service,
      viewer: viewer.id,
      expected: expectationOf(entry, viewer),
    })),
  );
}
