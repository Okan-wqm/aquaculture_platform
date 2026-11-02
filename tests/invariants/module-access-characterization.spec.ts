/**
 * INVARIANT: the ADR-051 access matrix, characterized under today's enrolment, changes only when
 * a PR says so (ADR-054 draft D-H, its rollout PR-1; ADR-051 §4 and Enforcement, PKG-41).
 *
 * WHY: every service is `account-role` today (libs/backend-common/src/security/
 * access-enrolment.ts), so ADR-051 decides nothing yet and its §4 matrix describes a target, not
 * the system. Each enrolment package will change some cells on purpose. Without a record of
 * today's cells a reviewer cannot see which access a package closes, or that nothing else moved.
 *
 * WHAT: for each operation of CHARACTERIZED_OPERATIONS (e2e/tests/security/
 * module-access-layers.matrix.ts), one per §4 row that a root GraphQL field or gateway REST route
 * serves:
 *   1. the scanner finds its handler, and the field the live request names is that handler's;
 *   2. the gate the code declares is one the matrix models exactly: `@Roles` (or an alias),
 *      `@Public`, `@Access`, under RolesGuard and authentication guards only. A handler that also
 *      carries `@RequireTenantPermission`, `@RequiresMobileFeature`, `@RequiresCapability`,
 *      `@Destructive` or another `@UseGuards` guard fails here, so the matrix never records an
 *      outcome a guard it does not model would change; a farm operation must be in farm's
 *      permission matrix, whose guard (PermissionMatrixGuard) checks only that membership;
 *   3. its target spec reproduces ADR-051 §4's own cells for Role A, Role B and TENANT_ADMIN
 *      through `decideAccess`;
 *   4. every cell, today and target, equals MODULE_ACCESS_EXPECTED_CELLS
 *      (e2e/tests/security/module-access-layers.expected.ts), holes marked `open-today`.
 * An enrolling package that changes a gate or flips a service changes cells here; it updates the
 * expected file in the same PR, and that diff is the list of what it closed or opened.
 *
 * Only the decision layer is characterized: every viewer passes authentication and the tenant
 * guards alike (one tenant, valid tokens), and resolver bodies may still narrow (site checks,
 * the HR PII mask). The live counterpart, module-access-layers.spec.ts, runs the same cells
 * against a deployed stack. It changes no runtime behaviour.
 */
import ts from 'typescript';

import { MODULE_ACCESS_EXPECTED_CELLS } from '../../e2e/tests/security/module-access-layers.expected';
import {
  CHARACTERIZED_OPERATIONS,
  MODULE_ACCESS_VIEWERS,
  characterizationCells,
  targetOutcome,
  type CharacterizedOperation,
  type OperationGate,
} from '../../e2e/tests/security/module-access-layers.matrix';
import {
  MODULE_ACCESS_ENROLMENT,
  isAccessEnrolledService,
} from '../../libs/backend-common/src/security/access-enrolment';

import {
  memberSpecOf,
  platformRolesOf,
  scanService,
  type ScannedHandler,
} from './helpers/module-access-handlers';
import { readRepoFile } from './helpers/module-dictionary-sources';

/** Decorators that add a decision the matrix does not model. */
const UNMODELLED_GATES: ReadonlySet<string> = new Set([
  'RequireTenantPermission',
  'RequiresMobileFeature',
  'RequiresCapability',
  'Destructive',
]);

/**
 * Guards a handler may name through `@UseGuards` without changing who among the §4 viewers
 * passes: RolesGuard (the modelled decision), the services' GqlAuthGuard (common/guards/
 * gql-auth.guard.ts: a verified user with a non-empty `roles`, which every viewer has) and
 * TenantGuard (libs/backend-common/src/guards/tenant.guard.ts: the tenant context, special-casing
 * only SUPER_ADMIN, which no viewer is).
 */
const MODELLED_GUARDS: ReadonlySet<string> = new Set(['RolesGuard', 'GqlAuthGuard', 'TenantGuard']);

const FARM_PERMISSION_MATRIX = 'apps/farm-service/src/common/authz/permission-matrix.ts';

function keyOf(handler: ScannedHandler): string {
  return `${handler.file}#${handler.className}.${handler.method}`;
}

const handlersByService = new Map<string, readonly ScannedHandler[]>();
function handlerOf(operation: CharacterizedOperation): ScannedHandler | undefined {
  let handlers = handlersByService.get(operation.service);
  if (handlers === undefined) {
    handlers = scanService(operation.service);
    handlersByService.set(operation.service, handlers);
  }
  return handlers.find((handler) => keyOf(handler) === operation.handler);
}

/** The root field a GraphQL document selects first: `tanks` of `query Q { tanks { … } }`. */
function rootFieldOf(document: string): string | null {
  return /^[^{]*\{\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(document)?.[1] ?? null;
}

/** The property names of the top-level object literals of farm's permission matrix. */
function farmMatrixOperations(): Set<string> {
  const source = ts.createSourceFile(
    FARM_PERMISSION_MATRIX,
    readRepoFile(FARM_PERMISSION_MATRIX),
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      names.add(node.name.getText().replace(/^['"]|['"]$/g, ''));
    }
    if (ts.isStringLiteral(node) && ts.isArrayLiteralExpression(node.parent)) names.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function gateOf(operation: CharacterizedOperation, handler: ScannedHandler): OperationGate {
  return {
    enrolment: isAccessEnrolledService(operation.service)
      ? MODULE_ACCESS_ENROLMENT[operation.service]
      : 'account-role',
    roles: platformRolesOf(handler),
    isPublic: handler.handlerPublic || handler.classPublic,
    spec: memberSpecOf(handler.handlerAccess ?? handler.classAccess),
  };
}

const gates: Record<string, OperationGate> = {};
for (const operation of CHARACTERIZED_OPERATIONS) {
  const handler = handlerOf(operation);
  if (handler !== undefined) gates[operation.id] = gateOf(operation, handler);
}

describe('INVARIANT: the ADR-051 matrix under today’s enrolment changes only on purpose (ADR-054 D-H)', () => {
  it.each(CHARACTERIZED_OPERATIONS.map((operation) => [operation.id, operation] as const))(
    '%s: the scanner finds the handler the live request reaches',
    (_id, operation) => {
      const handler = handlerOf(operation);
      expect(handler).toBeDefined();
      if (handler === undefined) return;
      if ('graphql' in operation.request) {
        expect(['query', 'mutation']).toContain(handler.role);
        expect(rootFieldOf(operation.request.graphql)).toBe(handler.fieldName);
      } else {
        expect(handler.role).toBe('rest');
        expect(handler.decorators).toContain('Post');
      }
    },
  );

  it.each(CHARACTERIZED_OPERATIONS.map((operation) => [operation.id, operation] as const))(
    '%s: its gate is one the matrix models exactly',
    (_id, operation) => {
      const handler = handlerOf(operation);
      if (handler === undefined) throw new Error(`${operation.handler} not found`);
      expect(handler.decorators.filter((name) => UNMODELLED_GATES.has(name))).toEqual([]);
      expect(handler.guards.filter((guard) => !MODELLED_GUARDS.has(guard))).toEqual([]);
      expect(handler.roles.length).toBe(platformRolesOf(handler).length);
      if (!isAccessEnrolledService(operation.service)) {
        // gateway-api registers no RolesGuard globally (apps/gateway-api/src/app.module.ts):
        // a @Roles there decides only under @UseGuards(RolesGuard), which the model would miss.
        expect(handler.roles).toEqual([]);
      }
      if (operation.service === 'farm-service') {
        expect(farmMatrixOperations().has(handler.fieldName)).toBe(true);
      }
    },
  );

  it.each(CHARACTERIZED_OPERATIONS.map((operation) => [operation.id, operation] as const))(
    '%s: its target spec reproduces ADR-051 §4 for Role A, Role B and TENANT_ADMIN',
    (_id, operation) => {
      const gate = gates[operation.id];
      if (gate === undefined) throw new Error(`no gate for ${operation.id}`);
      const reproduced = Object.fromEntries(
        (['role-a', 'role-b', 'tenant-admin'] as const).map((id) => {
          const viewer = MODULE_ACCESS_VIEWERS.find((candidate) => candidate.id === id);
          if (viewer === undefined) throw new Error(`no §4 viewer ${id}`);
          return [id, targetOutcome(operation, gate.roles, viewer)];
        }),
      );
      expect(reproduced).toEqual(operation.section4);
    },
  );

  it('every cell, today and target, is the recorded one', () => {
    const cells = characterizationCells(gates);
    const actual: Record<string, Record<string, unknown>> = {};
    for (const cell of cells) {
      actual[cell.operation] ??= {};
      (actual[cell.operation] as Record<string, unknown>)[cell.viewer] = {
        today: cell.today,
        target: cell.target,
        status: cell.status,
      };
    }
    expect(actual).toEqual(MODULE_ACCESS_EXPECTED_CELLS);
  });
});
