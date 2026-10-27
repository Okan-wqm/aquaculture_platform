/**
 * MODULE_ACCESS_ENROLMENT — the one record of which services enforce ADR-051 (§3 "Enrolment";
 * RBAC-HIGH-030, RBAC-HIGH-031).
 *
 * WHY one map: enforcement switches on per service, in the package that classifies that service's
 * operations (hr-service in PKG-07, farm-service in PKG-08 PR2, sensor-service in PKG-11,
 * alert-engine, ai-service and hydroponics-service in PKG-12, messaging-service in PKG-25 PR2).
 * Enrolling every service at once would deny every unannotated operation on the first release,
 * before any grant exists (ADR-051, Alternatives). Each service registers its guards only through
 * `accessGuardProviders('<service>')` (guards/access-guard-providers.ts), whose argument is a key of
 * this map, so registration follows the entry and a service missing from it does not compile.
 * `tests/invariants/module-access-guard-adoption.spec.ts` pins the keys to the services that
 * register the guards.
 *
 * WHAT:
 *   - `account-role`: only RolesGuard is registered and it decides exactly as before ADR-051:
 *     `@Roles` against the token's `role`/`roles` through the one hierarchy. PKG-46 ends this.
 *   - `module-access`: AccessClassificationGuard and RolesGuard are registered; an operation
 *     without `@Access(...)` or `@Public()` is denied and `@Roles` is checked by kind through
 *     `decideAccess` (ADR-051 §1).
 *   PKG-05 lands every entry as `account-role`; the enrolling package flips its own entry.
 *
 * Zero-dependency on Nest, so the invariants can read it without booting a module.
 */
import type { OwnerModuleCode } from '@aquaculture/shared-contracts';

export type AccessEnrolmentMode = 'account-role' | 'module-access';

/** The 11 services that register RolesGuard as an APP_GUARD, by their `apps/` directory name. */
export const ACCESS_ENROLLED_SERVICES = Object.freeze([
  'ai-service',
  'alert-engine',
  'auth-service',
  'billing-service',
  'config-service',
  'farm-service',
  'hr-service',
  'hydroponics-service',
  'messaging-service',
  'notification-service',
  'sensor-service',
] as const);

export type AccessEnrolledService = (typeof ACCESS_ENROLLED_SERVICES)[number];

export const MODULE_ACCESS_ENROLMENT: Readonly<Record<AccessEnrolledService, AccessEnrolmentMode>> =
  Object.freeze({
    'ai-service': 'account-role',
    'alert-engine': 'account-role',
    'auth-service': 'account-role',
    'billing-service': 'account-role',
    'config-service': 'account-role',
    'farm-service': 'account-role',
    'hr-service': 'account-role',
    'hydroponics-service': 'account-role',
    'messaging-service': 'account-role',
    'notification-service': 'account-role',
    'sensor-service': 'account-role',
  });

/**
 * The owner modules whose `Access.module(m)` a service may declare (ADR-051 Enforcement,
 * module-access-classification: "`Access.module` names the service's own module"). Each owner
 * module service names its own. alert-engine names sensor: its rules evaluate only SensorReading
 * (plan PKG-12). The other services keep module-private data of no owner module, so they declare
 * `scoped`, `self`, `company` or `account` specs; their enrolling package adds a module here, with
 * its reason, if it needs one.
 */
export const SERVICE_ACCESS_MODULES: Readonly<
  Record<AccessEnrolledService, readonly OwnerModuleCode[]>
> = Object.freeze({
  'ai-service': Object.freeze([]),
  'alert-engine': Object.freeze(['sensor'] as const),
  'auth-service': Object.freeze([]),
  'billing-service': Object.freeze([]),
  'config-service': Object.freeze([]),
  'farm-service': Object.freeze(['farm'] as const),
  'hr-service': Object.freeze(['hr'] as const),
  'hydroponics-service': Object.freeze(['hydroponics'] as const),
  'messaging-service': Object.freeze([]),
  'notification-service': Object.freeze([]),
  'sensor-service': Object.freeze(['sensor'] as const),
});

export function isAccessEnrolledService(value: unknown): value is AccessEnrolledService {
  return ACCESS_ENROLLED_SERVICES.some((service) => service === value);
}

/** The services that enforce ADR-051, in dictionary order. */
export function moduleAccessServices(): readonly AccessEnrolledService[] {
  return ACCESS_ENROLLED_SERVICES.filter(
    (service) => MODULE_ACCESS_ENROLMENT[service] === 'module-access',
  );
}
