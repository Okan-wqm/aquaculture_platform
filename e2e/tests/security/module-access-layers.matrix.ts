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
 *
 * Until the PKG-34 manifest exists, `CHARACTERIZED_OPERATIONS` stands for each §4 row that a root
 * GraphQL field or gateway REST route serves (ADR-054 draft D-H, its rollout PR-1).
 * `characterizationCells` answers each one × each viewer twice: TODAY, under the service's
 * enrolment and the gate the scanner reads from the code, and at the TARGET, `decideAccess` with
 * the spec ADR-051 gives the operation. module-access-layers.expected.ts records today's cells,
 * holes marked `open-today`; tests/invariants/module-access-characterization.spec.ts fails any
 * change to them, and module-access-layers.spec.ts runs them against a deployed stack.
 */
import {
  decideAccess,
  platformRoleSatisfies,
  userCaller,
  type AccessDecision,
  type AccessIntent,
  type AccessRequest,
  type MemberAccessSpec,
  type ModuleAccess,
  type ModuleScope,
  type PlatformRole,
  type UserCaller,
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

/** The verified member caller a viewer's token makes, as `resolveHandlerAccess` builds it. */
function callerOf(viewer: MatrixViewer): UserCaller {
  return userCaller({
    userId: `viewer-${viewer.id}`,
    tenantId: 'tenant-matrix',
    roles: viewer.roles,
    moduleAccess: viewer.moduleAccess,
    capabilities: viewer.capabilities,
  });
}

/**
 * The request `decideHandler` (libs/backend-common/src/security/access-caller.ts) builds:
 * `company`, `self` and `account` read no `@Roles`, so pairing one of them with roles is a deny.
 */
function memberRequest(
  spec: MemberAccessSpec,
  intent: AccessIntent,
  roles: readonly PlatformRole[],
): AccessRequest | null {
  switch (spec.kind) {
    case 'module':
    case 'scoped':
      return { spec, intent, roles };
    case 'company':
    case 'self':
    case 'account':
      return roles.length === 0 ? { spec, intent } : null;
  }
}

function expectationOf(entry: ReferenceResolverEntry, viewer: MatrixViewer): CellExpectation {
  if (entry.enrolment === 'account-role') return 'account-role';
  if (entry.spec === null) return 'FORBIDDEN';
  const request = memberRequest(entry.spec, 'read', entry.roles);
  if (request === null) return 'FORBIDDEN';
  return decideAccess(callerOf(viewer), request).allowed ? 'allowed' : 'FORBIDDEN';
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

// ---------------------------------------------------------------------------------------------
// Root-operation characterization (ADR-054 draft D-H, its rollout PR-1)
// ---------------------------------------------------------------------------------------------

/**
 * What a viewer gets: denied, allowed, or allowed for a module scope (`allowed:ALL`,
 * `allowed:farm`, as `decideAccess` answers a `scoped` spec). An `account-role` decision has no
 * scope: `allowed` there means every row of the tenant.
 */
export type CellOutcome = 'FORBIDDEN' | 'allowed' | `allowed:${string}`;

/**
 * Today against the ADR-051 target, for one cell:
 *   - `holds`: today already answers what the target answers;
 *   - `open-today`: today is wider (allowed where the target denies, or every row where the target
 *     answers a scope): a hole the enrolling package closes;
 *   - `narrower-today`: today denies what the target allows; the enrolling package opens it.
 */
export type CellStatus = 'holds' | 'open-today' | 'narrower-today';

/** The gate one handler declares today, as the classification scanner reads it. */
export interface OperationGate {
  readonly enrolment: 'account-role' | 'module-access';
  /** `@Roles` (or an alias) of the handler, else its class. */
  readonly roles: readonly PlatformRole[];
  readonly isPublic: boolean;
  /** The `@Access` spec of the handler, else its class; null when none. */
  readonly spec: MemberAccessSpec | null;
  /**
   * The handler takes `@AccessCaller()`. Under `account-role` that parameter is the one place an
   * `@Access` spec is decided (RolesGuard's account-role path never reads it): once the guard has
   * admitted the global role, `resolveHandlerAccess` decides the spec with the handler's `@Roles`,
   * exactly as RolesGuard does under `module-access`.
   */
  readonly takesAccessCaller: boolean;
}

export type CharacterizedRequest =
  | { readonly graphql: string; readonly variables?: Readonly<Record<string, unknown>> }
  | { readonly rest: { readonly method: 'POST'; readonly path: string } };

export interface CharacterizedOperation {
  readonly id: string;
  /** The ADR-051 §4 row the operation stands for. */
  readonly surface: string;
  /** Its `apps/` directory; gateway-api is in no enrolment, its routes decide as `account-role`. */
  readonly service: string;
  /** `file#Class.method`: the handler the scanner must find. */
  readonly handler: string;
  readonly intent: AccessIntent;
  /** The spec ADR-051 gives it once its service enrols (§1 kinds, the §4 row). */
  readonly targetSpec: MemberAccessSpec;
  /**
   * The §4 table's own cells for Role A, Role B and TENANT_ADMIN. `targetSpec` with today's
   * `@Roles` must reproduce them through `decideAccess`; the characterization invariant checks it,
   * so the target is ADR-051's and not this file's.
   */
  readonly section4: {
    readonly 'role-a': CellOutcome;
    readonly 'role-b': CellOutcome;
    readonly 'tenant-admin': CellOutcome;
  };
  /** What the live spec sends through the gateway. */
  readonly request: CharacterizedRequest;
}

export interface CharacterizationCell {
  readonly operation: string;
  readonly viewer: string;
  readonly today: CellOutcome;
  readonly target: CellOutcome;
  readonly status: CellStatus;
}

const FARM: MemberAccessSpec = { kind: 'module', module: 'farm' };

/**
 * One root operation per ADR-051 §4 row that a root GraphQL field or gateway REST route serves.
 * The other rows are characterized where they are tested: `_entities` by `referenceCells`; the
 * Company layer has no operation yet (PKG-33); sockets, AI channels, notifications and NATS by the
 * specs ADR-051 Enforcement names, and gateway sockets and routes are frozen by
 * tests/invariants/gateway-surface-access.spec.ts (ADR-054 D-F 2).
 */
export const CHARACTERIZED_OPERATIONS: readonly CharacterizedOperation[] = Object.freeze([
  {
    id: 'farm.tanks',
    surface: 'batches, tanks, feeds, water quality, storage',
    service: 'farm-service',
    handler: 'apps/farm-service/src/tank/resolvers/tank.resolver.ts#TankResolver.listTanks',
    intent: 'read',
    targetSpec: FARM,
    section4: { 'role-a': 'allowed', 'role-b': 'FORBIDDEN', 'tenant-admin': 'allowed' },
    request: { graphql: 'query MatrixFarmTanks { tanks { __typename } }' },
  },
  {
    id: 'farm.archiveFinanceCategory',
    surface: 'farm operations gated to TENANT_ADMIN (archiveFinanceCategory)',
    service: 'farm-service',
    handler:
      'apps/farm-service/src/finance/resolvers/finance.resolver.ts#FinanceResolver.archiveFinanceCategory',
    intent: 'write',
    targetSpec: FARM,
    section4: { 'role-a': 'FORBIDDEN', 'role-b': 'FORBIDDEN', 'tenant-admin': 'allowed' },
    // An id no category has: an allowed caller reaches the command, which archives nothing.
    request: {
      graphql:
        'mutation MatrixArchiveFinanceCategory($id: ID!) { archiveFinanceCategory(id: $id) { __typename } }',
      variables: { id: '00000000-0000-4000-8000-000000000051' },
    },
  },
  {
    id: 'hr.payrolls',
    surface: 'payroll, HR finance, labour cost (D6)',
    service: 'hr-service',
    handler: 'apps/hr-service/src/hr/hr.resolver.ts#HRResolver.getPayrolls',
    intent: 'read',
    targetSpec: { kind: 'module', module: 'hr' },
    section4: { 'role-a': 'FORBIDDEN', 'role-b': 'FORBIDDEN', 'tenant-admin': 'allowed' },
    request: { graphql: 'query MatrixPayrolls { payrolls { __typename } }' },
  },
  {
    id: 'hr.employees',
    surface: 'workforce reads, employee(id)',
    service: 'hr-service',
    handler: 'apps/hr-service/src/hr/hr.resolver.ts#HRResolver.getEmployees',
    intent: 'read',
    targetSpec: { kind: 'scoped', scope: 'workforce' },
    section4: { 'role-a': 'allowed:farm', 'role-b': 'FORBIDDEN', 'tenant-admin': 'allowed:ALL' },
    request: { graphql: 'query MatrixEmployees { employees { __typename } }' },
  },
  {
    id: 'sensor.sensors',
    surface: 'sensor resolvers, SCADA handshake',
    service: 'sensor-service',
    handler:
      'apps/sensor-service/src/registration/resolvers/registration.resolver.ts#RegistrationResolver.listSensors',
    intent: 'read',
    targetSpec: { kind: 'module', module: 'sensor' },
    section4: { 'role-a': 'FORBIDDEN', 'role-b': 'FORBIDDEN', 'tenant-admin': 'allowed' },
    request: { graphql: 'query MatrixSensors { sensors { __typename } }' },
  },
  {
    id: 'alert.alertHistory',
    surface: 'alarms',
    service: 'alert-engine',
    handler:
      'apps/alert-engine/src/alert/resolvers/alert.resolver.ts#AlertResolver.getAlertHistory',
    intent: 'read',
    targetSpec: { kind: 'scoped', scope: 'alerts' },
    section4: { 'role-a': 'allowed:farm', 'role-b': 'FORBIDDEN', 'tenant-admin': 'allowed:ALL' },
    request: { graphql: 'query MatrixAlertHistory { alertHistory { __typename } }' },
  },
  {
    id: 'gateway.presignedUrl',
    surface: 'farm uploads, farm AI channel, farm daily summary',
    service: 'gateway-api',
    handler: 'apps/gateway-api/src/upload/upload.controller.ts#UploadController.getPresignedUrl',
    intent: 'read',
    targetSpec: FARM,
    section4: { 'role-a': 'allowed', 'role-b': 'FORBIDDEN', 'tenant-admin': 'allowed' },
    request: { rest: { method: 'POST', path: '/api/v1/upload/presigned-url' } },
  },
]);

function scopeText(scope: ModuleScope): string {
  return scope.kind === 'all' ? 'ALL' : scope.modules.join('+');
}

function outcomeOf(decision: AccessDecision): CellOutcome {
  if (!decision.allowed) return 'FORBIDDEN';
  return decision.kind === 'scoped' ? `allowed:${scopeText(decision.scope)}` : 'allowed';
}

function decide(
  spec: MemberAccessSpec,
  intent: AccessIntent,
  roles: readonly PlatformRole[],
  viewer: MatrixViewer,
): CellOutcome {
  const request = memberRequest(spec, intent, roles);
  return request === null ? 'FORBIDDEN' : outcomeOf(decideAccess(callerOf(viewer), request));
}

/**
 * Today's outcome of one gate for one viewer. `account-role` is `canActivateByAccountRole`
 * (libs/backend-common/src/guards/roles.guard.ts): `@Public` passes; no `@Roles` admits any
 * authenticated caller; otherwise one of the token's roles satisfies one listed role through the
 * one hierarchy. A handler the guard admits that takes `@AccessCaller()` under an `@Access` spec
 * is then decided by `resolveHandlerAccess` as well (hr pay, ADR-054 draft door 2).
 * `module-access` is `resolveHandlerAccess`: no `@Access` denies, else `decideAccess` with
 * `@Roles` checked by kind.
 */
export function todayOutcome(
  gate: OperationGate,
  intent: AccessIntent,
  viewer: MatrixViewer,
): CellOutcome {
  if (gate.isPublic) return 'allowed';
  if (gate.enrolment === 'account-role') {
    const admitted =
      gate.roles.length === 0 ||
      viewer.roles.some((held) =>
        gate.roles.some((required) => platformRoleSatisfies(held, required)),
      );
    if (!admitted) return 'FORBIDDEN';
    if (gate.spec === null || !gate.takesAccessCaller) return 'allowed';
    return decide(gate.spec, intent, gate.roles, viewer);
  }
  return gate.spec === null ? 'FORBIDDEN' : decide(gate.spec, intent, gate.roles, viewer);
}

/** The outcome once the operation carries its target spec, with today's `@Roles`. */
export function targetOutcome(
  operation: CharacterizedOperation,
  roles: readonly PlatformRole[],
  viewer: MatrixViewer,
): CellOutcome {
  return decide(operation.targetSpec, operation.intent, roles, viewer);
}

/** 0 denied, 1 a module scope, 2 every row (unscoped, or `allowed:ALL`). */
function breadth(outcome: CellOutcome): number {
  if (outcome === 'FORBIDDEN') return 0;
  return outcome === 'allowed' || outcome === 'allowed:ALL' ? 2 : 1;
}

export function cellStatus(today: CellOutcome, target: CellOutcome): CellStatus {
  if (breadth(today) > breadth(target)) return 'open-today';
  if (breadth(today) < breadth(target)) return 'narrower-today';
  return 'holds';
}

/** Every characterized operation × every §4 viewer, today and at the target. */
export function characterizationCells(
  gates: Readonly<Record<string, OperationGate>>,
): CharacterizationCell[] {
  return CHARACTERIZED_OPERATIONS.flatMap((operation) => {
    const gate = gates[operation.id];
    if (gate === undefined) throw new Error(`no gate was read for ${operation.id}`);
    return MODULE_ACCESS_VIEWERS.map((viewer) => {
      const today = todayOutcome(gate, operation.intent, viewer);
      const target = targetOutcome(operation, gate.roles, viewer);
      return {
        operation: operation.id,
        viewer: viewer.id,
        today,
        target,
        status: cellStatus(today, target),
      };
    });
  });
}
