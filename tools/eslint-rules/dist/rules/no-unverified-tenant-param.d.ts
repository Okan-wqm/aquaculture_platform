/**
 * no-unverified-tenant-param — on the platform-admin surface a tenant id is
 * never taken raw from the request (ADMIN-CRITICAL-009).
 *
 * `@Param('tenantId')`, `@Query('tenantId')` and a validated body DTO with a
 * `tenantId` property hand the handler a transport value: any UUID, any
 * lifecycle state, possibly no tenant at all. `@TenantParam(...)` resolves the
 * id through `VerifiedTenantPipe` against `auth.tenants` before the handler
 * runs, and states which lifecycle statuses the route admits. The rule makes
 * the raw forms an error, whatever the handler does with the value.
 *
 * Scope: admin-api controllers and validated input DTOs. Query / filter DTOs
 * (`…QueryDto`, `…FilterDto`, `…SearchDto`) may FILTER by tenant on a read;
 * the ban is on taking a tenant identity as an operand.
 */
import { ESLintUtils } from '@typescript-eslint/utils';
/** Request keys that name a tenant. Extend here, never per-file. */
export declare const TENANT_KEYS: ReadonlySet<string>;
declare const _default: ESLintUtils.RuleModule<
  'rawTenantParam' | 'tenantInInputDto',
  [],
  unknown,
  ESLintUtils.RuleListener
> & {
  name: string;
};
export default _default;
//# sourceMappingURL=no-unverified-tenant-param.d.ts.map
