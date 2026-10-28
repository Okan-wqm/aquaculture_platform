import type { AccessKind } from '@aquaculture/shared-contracts';
import * as client from 'prom-client';

import type { AccessEnrolledService } from '../security/access-enrolment';

/**
 * `module_access_denied_total{service,spec_kind}` — every access denial an ADR-051 guard or
 * `@AccessCaller()` answers (plan PKG-05, §7 "After each deploy"; RBAC-HIGH-030).
 *
 * WHY: enforcement switches on service by service (R4, R5). A deny spike after a deploy is a
 * caller missing a grant, fixed by granting access (PKG-06), never by loosening a guard, and this
 * counter is how the operator sees it per service. `spec_kind` is the access kind of the denied
 * spec, or `unclassified` for an operation that declares none. Malformed claims are answered with
 * 400 and are not denials of access, so they are not counted here (the gateway counts them by
 * claim state).
 *
 * Its own registry: ServiceMetricsService contributes it to every service's /metrics, so no
 * service wires it. No tenant or user label (the scrape surface is unauthenticated); both labels
 * are bounded (11 services, 6 kinds).
 */
export const MODULE_ACCESS_DENIED_METRIC = 'module_access_denied_total';

export const MODULE_ACCESS_DENIED_REGISTRY = new client.Registry();

/** The access kind a denial counts under; `unclassified` when the handler declares no spec. */
export type DeniedSpecKind = AccessKind | 'unclassified';

/** The service label; `unbound` only where no `accessGuardProviders` registered this process. */
export type DeniedServiceLabel = AccessEnrolledService | 'unbound';

const denials = new client.Counter({
  name: MODULE_ACCESS_DENIED_METRIC,
  help:
    'Operations an ADR-051 access guard or @AccessCaller() denied, by service and by the access ' +
    'kind of the denied spec (unclassified: the operation declares none)',
  labelNames: ['service', 'spec_kind'] as const,
  registers: [MODULE_ACCESS_DENIED_REGISTRY],
});

export function recordModuleAccessDenied(
  service: DeniedServiceLabel,
  specKind: DeniedSpecKind,
): void {
  denials.inc({ service, spec_kind: specKind });
}

/**
 * The service this process runs, as `accessGuardProviders` registered it.
 *
 * WHY a process binding: `@AccessCaller()` is a parameter decorator, built outside dependency
 * injection, and it decides on reference and field resolvers where no guard runs, so it cannot
 * receive the service from a guard or a provider. One process runs one service, and the binding is
 * set once, by the `MODULE_ACCESS_SERVICE` provider of `accessGuardProviders`, from the same key
 * that selected the guards. It labels the metric only; no decision reads it.
 */
const processService: { current: DeniedServiceLabel } = { current: 'unbound' };

export function bindModuleAccessService(service: AccessEnrolledService): AccessEnrolledService {
  processService.current = service;
  return service;
}

export function moduleAccessServiceLabel(): DeniedServiceLabel {
  return processService.current;
}
