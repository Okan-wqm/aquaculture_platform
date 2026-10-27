/**
 * PARENT_SCOPED_FIELDS — the field resolvers of enrolled services that decide nothing themselves,
 * each with the reason its parent's decision covers it (ADR-051 §3 "Field resolvers").
 *
 * WHY: Nest runs no guard on a `@ResolveField` (no service sets `fieldResolverEnhancers`;
 * apps/hr-service/src/hr/department-fields.resolver.ts:12-15). In a `module-access` service every
 * field resolver therefore takes `@AccessCaller()`, which decides again, or is listed here with a
 * reason: the field derives only from its parent's own row, which an operation that already
 * decided the caller returned. `tests/invariants/module-access-classification.spec.ts` fails a
 * field resolver that does neither, an entry with an empty reason and an entry that names no
 * field. A reviewer reads every new entry.
 *
 * Keys are `<Type>.<field>`: the type the resolver class names in `@Resolver(() => Type)` and the
 * GraphQL field name. Each enrolling package (PKG-07, PKG-08, PKG-11, PKG-12, PKG-25) fills its
 * own service in the PR that flips its enrolment.
 */
import type { AccessEnrolledService } from './access-enrolment';

export const PARENT_SCOPED_FIELDS: Readonly<
  Record<AccessEnrolledService, Readonly<Record<string, string>>>
> = Object.freeze({
  'ai-service': Object.freeze({}),
  'alert-engine': Object.freeze({}),
  'auth-service': Object.freeze({}),
  'billing-service': Object.freeze({}),
  'config-service': Object.freeze({}),
  'farm-service': Object.freeze({}),
  'hr-service': Object.freeze({}),
  'hydroponics-service': Object.freeze({}),
  'messaging-service': Object.freeze({}),
  'notification-service': Object.freeze({}),
  'sensor-service': Object.freeze({}),
});
