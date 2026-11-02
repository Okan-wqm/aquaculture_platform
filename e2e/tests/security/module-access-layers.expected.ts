/**
 * TODAY's cells of the ADR-051 access matrix (ADR-054 draft D-H, its rollout PR-1), recorded on
 * main at 7a547f528 with every service in `account-role` mode.
 *
 * Each cell is one characterized operation (CHARACTERIZED_OPERATIONS in
 * module-access-layers.matrix.ts) × one ADR-051 §4 viewer:
 *   - today: the decision the code makes now, from the handler's gate and its service's
 *     enrolment. The gates, read at 7a547f528: farm.tanks `@Roles(TENANT_ADMIN, MODULE_MANAGER,
 *     MODULE_USER)` (tank.resolver.ts:217); farm.archiveFinanceCategory `@Roles(TENANT_ADMIN)`
 *     (finance.resolver.ts:267); hr.payrolls `@Roles(TENANT_ADMIN, MODULE_MANAGER)`
 *     (hr.resolver.ts:210), since the hr enrolment step also `@Access.module('hr')` decided by its
 *     `@AccessCaller()` parameter (D6, ADR-054 draft door 2: A′, B′ and the TENANT_ADMIN of a
 *     tenant without hr moved from open-today to holds); hr.employees `@Roles(TENANT_ADMIN, MODULE_MANAGER, MODULE_USER)`
 *     (hr.resolver.ts:143); sensor.sensors no `@Roles` on it or its class
 *     (registration.resolver.ts:87); alert.alertHistory no `@Roles` (alert.resolver.ts:88);
 *     gateway.presignedUrl no role decision (upload.controller.ts:706; gateway-api's global
 *     guards authenticate and fix the tenant only). No guard of these services checks that the
 *     tenant has the module enabled, hence the tenant-admin-without-hr cells;
 *   - target: what `decideAccess` answers once the operation carries its ADR-051 spec;
 *   - status: `holds`, `open-today` (today is wider than the target: a hole an enrolment package
 *     closes) or `narrower-today` (the package opens it).
 *
 * tests/invariants/module-access-characterization.spec.ts recomputes every cell from the code on
 * every PR and fails on any difference, so a PR that changes a gate or an enrolment updates this
 * file and its diff names the cells it moved. module-access-layers.spec.ts checks `today` against
 * a deployed stack.
 */
import type { CellOutcome, CellStatus } from './module-access-layers.matrix';

export interface ExpectedCell {
  readonly today: CellOutcome;
  readonly target: CellOutcome;
  readonly status: CellStatus;
}

export const MODULE_ACCESS_EXPECTED_CELLS: Readonly<
  Record<string, Readonly<Record<string, ExpectedCell>>>
> = {
  'farm.tanks': {
    'role-a': { today: 'allowed', target: 'allowed', status: 'holds' },
    'role-b': { today: 'allowed', target: 'FORBIDDEN', status: 'open-today' },
    'role-a-prime': { today: 'allowed', target: 'allowed', status: 'holds' },
    'role-b-prime': { today: 'allowed', target: 'FORBIDDEN', status: 'open-today' },
    'farm-operator-s1': { today: 'allowed', target: 'allowed', status: 'holds' },
    'hr-manager': { today: 'allowed', target: 'FORBIDDEN', status: 'open-today' },
    'sensor-manager-s9': { today: 'allowed', target: 'FORBIDDEN', status: 'open-today' },
    'tenant-admin': { today: 'allowed', target: 'allowed', status: 'holds' },
    'tenant-admin-without-hr': { today: 'allowed', target: 'allowed', status: 'holds' },
  },
  'farm.archiveFinanceCategory': {
    'role-a': { today: 'FORBIDDEN', target: 'FORBIDDEN', status: 'holds' },
    'role-b': { today: 'FORBIDDEN', target: 'FORBIDDEN', status: 'holds' },
    'role-a-prime': { today: 'FORBIDDEN', target: 'FORBIDDEN', status: 'holds' },
    'role-b-prime': { today: 'FORBIDDEN', target: 'FORBIDDEN', status: 'holds' },
    'farm-operator-s1': { today: 'FORBIDDEN', target: 'FORBIDDEN', status: 'holds' },
    'hr-manager': { today: 'FORBIDDEN', target: 'FORBIDDEN', status: 'holds' },
    'sensor-manager-s9': { today: 'FORBIDDEN', target: 'FORBIDDEN', status: 'holds' },
    'tenant-admin': { today: 'allowed', target: 'allowed', status: 'holds' },
    'tenant-admin-without-hr': { today: 'allowed', target: 'allowed', status: 'holds' },
  },
  'hr.payrolls': {
    'role-a': { today: 'FORBIDDEN', target: 'FORBIDDEN', status: 'holds' },
    'role-b': { today: 'FORBIDDEN', target: 'FORBIDDEN', status: 'holds' },
    'role-a-prime': { today: 'FORBIDDEN', target: 'FORBIDDEN', status: 'holds' },
    'role-b-prime': { today: 'FORBIDDEN', target: 'FORBIDDEN', status: 'holds' },
    'farm-operator-s1': { today: 'FORBIDDEN', target: 'FORBIDDEN', status: 'holds' },
    'hr-manager': { today: 'FORBIDDEN', target: 'allowed', status: 'narrower-today' },
    'sensor-manager-s9': { today: 'FORBIDDEN', target: 'FORBIDDEN', status: 'holds' },
    'tenant-admin': { today: 'allowed', target: 'allowed', status: 'holds' },
    'tenant-admin-without-hr': { today: 'FORBIDDEN', target: 'FORBIDDEN', status: 'holds' },
  },
  'hr.employees': {
    'role-a': { today: 'allowed', target: 'allowed:farm', status: 'open-today' },
    'role-b': { today: 'allowed', target: 'FORBIDDEN', status: 'open-today' },
    'role-a-prime': { today: 'allowed', target: 'allowed:farm', status: 'open-today' },
    'role-b-prime': { today: 'allowed', target: 'FORBIDDEN', status: 'open-today' },
    'farm-operator-s1': { today: 'allowed', target: 'allowed:farm', status: 'open-today' },
    'hr-manager': { today: 'allowed', target: 'allowed:ALL', status: 'holds' },
    'sensor-manager-s9': { today: 'allowed', target: 'allowed:sensor', status: 'open-today' },
    'tenant-admin': { today: 'allowed', target: 'allowed:ALL', status: 'holds' },
    'tenant-admin-without-hr': { today: 'allowed', target: 'allowed:ALL', status: 'holds' },
  },
  'sensor.sensors': {
    'role-a': { today: 'allowed', target: 'FORBIDDEN', status: 'open-today' },
    'role-b': { today: 'allowed', target: 'FORBIDDEN', status: 'open-today' },
    'role-a-prime': { today: 'allowed', target: 'FORBIDDEN', status: 'open-today' },
    'role-b-prime': { today: 'allowed', target: 'FORBIDDEN', status: 'open-today' },
    'farm-operator-s1': { today: 'allowed', target: 'FORBIDDEN', status: 'open-today' },
    'hr-manager': { today: 'allowed', target: 'FORBIDDEN', status: 'open-today' },
    'sensor-manager-s9': { today: 'allowed', target: 'allowed', status: 'holds' },
    'tenant-admin': { today: 'allowed', target: 'allowed', status: 'holds' },
    'tenant-admin-without-hr': { today: 'allowed', target: 'allowed', status: 'holds' },
  },
  'alert.alertHistory': {
    'role-a': { today: 'allowed', target: 'allowed:farm', status: 'open-today' },
    'role-b': { today: 'allowed', target: 'FORBIDDEN', status: 'open-today' },
    'role-a-prime': { today: 'allowed', target: 'allowed:farm', status: 'open-today' },
    'role-b-prime': { today: 'allowed', target: 'FORBIDDEN', status: 'open-today' },
    'farm-operator-s1': { today: 'allowed', target: 'allowed:farm', status: 'open-today' },
    'hr-manager': { today: 'allowed', target: 'allowed:hr', status: 'open-today' },
    'sensor-manager-s9': { today: 'allowed', target: 'allowed:sensor', status: 'open-today' },
    'tenant-admin': { today: 'allowed', target: 'allowed:ALL', status: 'holds' },
    'tenant-admin-without-hr': { today: 'allowed', target: 'allowed:ALL', status: 'holds' },
  },
  'gateway.presignedUrl': {
    'role-a': { today: 'allowed', target: 'allowed', status: 'holds' },
    'role-b': { today: 'allowed', target: 'FORBIDDEN', status: 'open-today' },
    'role-a-prime': { today: 'allowed', target: 'allowed', status: 'holds' },
    'role-b-prime': { today: 'allowed', target: 'FORBIDDEN', status: 'open-today' },
    'farm-operator-s1': { today: 'allowed', target: 'allowed', status: 'holds' },
    'hr-manager': { today: 'allowed', target: 'FORBIDDEN', status: 'open-today' },
    'sensor-manager-s9': { today: 'allowed', target: 'FORBIDDEN', status: 'open-today' },
    'tenant-admin': { today: 'allowed', target: 'allowed', status: 'holds' },
    'tenant-admin-without-hr': { today: 'allowed', target: 'allowed', status: 'holds' },
  },
};
