import type { Provider } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';

import { bindModuleAccessService } from '../metrics/module-access-denied.metrics';
import { MODULE_ACCESS_ENROLMENT, type AccessEnrolledService } from '../security/access-enrolment';

import { AccessClassificationGuard } from './access-classification.guard';
import { RolesGuard, type RolesGuardEnrolment } from './roles.guard';

/** Provider token whose value is the service `accessGuardProviders` registered this process as. */
export const MODULE_ACCESS_SERVICE = Symbol('MODULE_ACCESS_SERVICE');

/**
 * The access guards of one service, as its MODULE_ACCESS_ENROLMENT entry says (ADR-051 §3
 * "Enrolment"; RBAC-HIGH-030, RBAC-HIGH-031).
 *
 * WHY one registration point: which guards a service runs follows its enrolment entry, so a
 * service cannot enforce ADR-051 without being recorded as doing so, nor be recorded without
 * enforcing it. The argument is a key of the map, so a service missing from it does not compile;
 * `tests/invariants/module-access-guard-adoption.spec.ts` requires every service that registers
 * the guards to do it here, with its own key, and no app.module to construct RolesGuard.
 *
 * WHAT, spread where the service registered RolesGuard (after TenantGuard):
 *   - `account-role`: exactly one APP_GUARD, RolesGuard, deciding as before ADR-051;
 *   - `module-access`: AccessClassificationGuard (unclassified operations fail closed), then
 *     RolesGuard deciding `@Access` with `@Roles` by kind, plus the provider that labels
 *     `@AccessCaller()` denials in module_access_denied_total with this service.
 * Guards built with `useFactory` (as every APP_GUARD of the platform): reflect-metadata
 * resolution fails in the Docker Alpine images.
 */
export function accessGuardProviders(service: AccessEnrolledService): Provider[] {
  return guardProvidersForEnrolment(
    Object.freeze({ service, mode: MODULE_ACCESS_ENROLMENT[service] }),
  );
}

/**
 * The guards an enrolment entry selects. Exported for the specs that prove both modes; the
 * barrels do not export it and module-access-guard-adoption.spec.ts forbids it under `apps/`, so a
 * service's mode always comes from its MODULE_ACCESS_ENROLMENT entry.
 */
export function guardProvidersForEnrolment(enrolment: RolesGuardEnrolment): Provider[] {
  const { service } = enrolment;
  const rolesGuard: Provider = {
    provide: APP_GUARD,
    useFactory: (reflector: Reflector): RolesGuard => new RolesGuard(reflector, enrolment),
    inject: [Reflector],
  };
  if (enrolment.mode === 'account-role') return [rolesGuard];
  const classificationGuard: Provider = {
    provide: APP_GUARD,
    useFactory: (reflector: Reflector): AccessClassificationGuard =>
      new AccessClassificationGuard(reflector, service),
    inject: [Reflector],
  };
  const serviceLabel: Provider = {
    provide: MODULE_ACCESS_SERVICE,
    useFactory: (): AccessEnrolledService => bindModuleAccessService(service),
  };
  return [serviceLabel, classificationGuard, rolesGuard];
}
