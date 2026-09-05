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

export type { components, operations, paths };
