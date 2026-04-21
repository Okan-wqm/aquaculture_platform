import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DropRlsFromAuthUsersIdentity1787000000000
 * ============================================================================
 *
 * Removes `tenant_isolation_policy` from `auth.users` and disables ROW LEVEL
 * SECURITY on it, restoring the platform's original identity-primitive
 * contract: `auth.users` is cross-tenant by design because every login flow
 * reads from it BEFORE the tenant can be determined.
 *
 * # Incident this migration closes (DEPLOY-CRITICAL-006, 2026-04-21)
 *
 * The policy was installed by `RlsSchemaBootstrap` at auth-service boot,
 * triggered by `RlsModule.forPoolService({ serviceName: 'auth', autoApply:
 * true })` in app.module.ts. The module's own helper
 * (`libs/backend-common/src/database/rls/tenant-rls-sync.service.ts:106-108`)
 * explicitly warns against this:
 *
 *   "auth-service — can't support RLS because of nullable tenantId on
 *    SUPER_ADMIN rows. Don't register this service for those."
 *
 * Despite that, `autoApply: true` was committed and the bootstrap silently
 * added `tenant_isolation_policy` to `auth.users`. Consequences:
 *
 *   1. Every login fails with "User not found" — because the login query
 *      `findOne({ where: { email } })` runs with NO `app.current_tenant`
 *      GUC set (tenant is DETERMINED by the user row, not queried with it).
 *      The policy predicate `"tenantId" = NULLIF(current_setting(...),'')::uuid`
 *      evaluates to UNKNOWN → 0 rows visible → "User not found".
 *
 *   2. SUPER_ADMIN users have `tenantId = NULL` by design. `NULL = <any uuid>`
 *      is never TRUE, so platform administrators are STRUCTURALLY hidden
 *      from the auth service regardless of GUC state.
 *
 * Evidence from the production droplet 2026-04-21 at 17:38–17:42 UTC:
 *   - LOGIN_FAILED audit rows with reason="User not found" for a user that
 *     does exist (`okan@oceanfarm.eu`, `lastLoginAt = 2026-04-14`).
 *   - Query as superuser `aquaculture` returns the row; query as
 *     `auth_service` (the PG role auth-service connects with) returns 0 rows
 *     on the same SELECT.
 *   - `pg_policies` shows `auth | users | tenant_isolation_policy` active.
 *
 * # Why DROP and not "bypass in login code"
 *
 * This is a Tier-1 architectural correction, not a workaround. The policy
 * was wrong because the table is cross-tenant by design — applying a
 * tenant-isolation policy is a category error. Defense-in-depth for
 * `auth.users` is correctly enforced out-of-band:
 *
 *   1. Schema-role isolation: only the `auth_service` PG role can access
 *      `auth.*` (00-init-schemas.sh + per-service DB roles).
 *   2. Application-layer tenant scoping: every post-auth query against
 *      users (e.g. TenantAdminService.listTenantUsers) has explicit
 *      `WHERE tenantId = ?` in code, verified by TenantGuard + e2e tests.
 *   3. JWT-authenticated handlers: the only pre-auth query is the
 *      login-by-email lookup itself; all other flows run with tenant
 *      context from JwtAuthGuard.
 *
 * The companion code changes in the same commit:
 *   - `apps/auth-service/src/app.module.ts`: adds `users`, `tenants` to
 *     `excludeTables` so future `autoApply` passes skip identity primitives.
 *   - `libs/backend-common/src/database/rls/apply-tenant-rls.helper.ts`:
 *     adds `DEFAULT_IDENTITY_TABLES = ['users', 'tenants']` that the helper
 *     auto-skips regardless of caller config — Tier-1 "make impossible".
 *
 * # Idempotent
 *
 * `DROP POLICY IF EXISTS` + `DISABLE ROW LEVEL SECURITY` are both no-ops
 * when already applied, so the migration is safe to re-run in environments
 * where RLS was never enabled in the first place (dev laptops, fresh CI
 * clusters) or where a prior migration already reverted it.
 *
 * # Reversibility
 *
 * `down()` re-applies the policy and re-enables RLS. This exists for
 * symmetry only — DO NOT use it to restore the broken state. If a future
 * incident requires revoking tenant access to users, the correct fix is
 * application-layer `WHERE tenantId = ?`, not RLS.
 */
export class DropRlsFromAuthUsersIdentity1787000000000
  implements MigrationInterface
{
  name = 'DropRlsFromAuthUsersIdentity1787000000000';

  public async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_tables WHERE schemaname = 'auth' AND tablename = 'users'
        ) THEN
          DROP POLICY IF EXISTS tenant_isolation_policy ON auth.users;
          ALTER TABLE auth.users NO FORCE ROW LEVEL SECURITY;
          ALTER TABLE auth.users DISABLE ROW LEVEL SECURITY;
        END IF;
        IF EXISTS (
          SELECT 1 FROM pg_tables WHERE schemaname = 'auth' AND tablename = 'tenants'
        ) THEN
          DROP POLICY IF EXISTS tenant_isolation_policy ON auth.tenants;
          ALTER TABLE auth.tenants NO FORCE ROW LEVEL SECURITY;
          ALTER TABLE auth.tenants DISABLE ROW LEVEL SECURITY;
        END IF;
      END $$;
    `);
  }

  public async down(qr: QueryRunner): Promise<void> {
    // Reversibility for completeness only — see class docblock.
    await qr.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_tables WHERE schemaname = 'auth' AND tablename = 'users'
        ) THEN
          ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;
          ALTER TABLE auth.users FORCE ROW LEVEL SECURITY;
          CREATE POLICY tenant_isolation_policy ON auth.users FOR ALL
            USING (
              current_setting('app.bypass_rls', true) = 'on'
              OR "tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
            )
            WITH CHECK (
              current_setting('app.bypass_rls', true) = 'on'
              OR "tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
            );
        END IF;
      END $$;
    `);
  }
}
