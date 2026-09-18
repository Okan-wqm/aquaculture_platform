/**
 * The admin contract, as the backend declares it (CONTRACT-CRITICAL-003).
 *
 * `generated/admin-api.ts` is produced by `openapi-typescript` from
 * `apps/admin-api-service/openapi.json`, which is itself generated from the
 * Nest module graph. A type sourced through here therefore cannot drift from
 * the server: a field the backend renamed, made required, or dropped becomes a
 * compile error in the page that used it, instead of a 400 in production.
 *
 * Use `ApiSchema<'CreateTenantDto'>` rather than re-declaring a shape by hand.
 */
import type { components, operations, paths } from './generated/admin-api';

export type ApiSchemas = components['schemas'];

/** One schema from the generated contract, by name. */
export type ApiSchema<Name extends keyof ApiSchemas> = ApiSchemas[Name];

/**
 * The query string one operation accepts, by operation id.
 *
 * A hand-built query object is a second place the parameter NAMES live, and
 * the two drift silently because a query parameter the server does not know
 * is not an error — it is ignored. `PerformanceDashboardPage` sent
 * `?start=…&end=…` to an endpoint whose parameters are `startDate` and
 * `endDate`, so its five-entry time-range selector changed the URL and
 * nothing else: every range returned the server's default last hour
 * (ADMIN-HIGH-123). Typing the object through here makes that a compile
 * error.
 */
export type ApiQuery<Name extends keyof operations> = NonNullable<
  operations[Name] extends { parameters: { query?: infer Q } } ? Q : never
>;

export type { components, operations, paths };
