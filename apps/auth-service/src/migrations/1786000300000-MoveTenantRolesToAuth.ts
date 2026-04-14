import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MoveTenantRolesToAuth1786000300000
 * ============================================================================
 *
 * Moves the RBAC source table from public → auth:
 *
 *   public.tenant_roles → auth.tenant_roles
 *
 * Phase 8 of docs/plans/2026-04-14 public-schema teardown. tenant_roles
 * is declared in MODULE_SCHEMAS[auth].tables (schema-manager.service.ts:403)
 * so the auth schema is its canonical home. It previously lived in
 * public because the admin-api-service TenantRole entity
 * (apps/admin-api-service/src/users/entities/tenant-role.entity.ts:18)
 * omitted the `schema:` option — TypeORM defaulted to public and the
 * table was created there first.
 *
 * # Runtime read path is unaffected
 *
 * Every runtime reader accesses tenant_roles through per-tenant schema
 * interpolation: `"${schemaName}"."tenant_roles"` where schemaName is
 * `tenant_<uuid>`. Those rows are CREATE TABLE LIKE copies provisioned
 * during tenant onboarding, not the source table being moved here.
 * Moving the source from public → auth does not touch any tenant_<uuid>
 * schema — the per-tenant copies keep their existing location.
 *
 * # admin-api entity update
 *
 * admin-api-service's TenantRole entity is updated in the same PR
 * (P6-P8 bundle) to declare `schema: 'auth'`. The entity uses
 * synchronize: false so it will not try to recreate the table after the
 * move — it reads from auth.tenant_roles via its own connection.
 *
 * # See farm-service migration 1786000000000 for full architectural
 *   rationale (SET SCHEMA semantics, ownership, RLS preservation).
 */
export class MoveTenantRolesToAuth1786000300000 implements MigrationInterface {
  name = 'MoveTenantRolesToAuth1786000300000';

  public async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'tenant_roles'
        ) AND NOT EXISTS (
          SELECT 1 FROM pg_tables WHERE schemaname = 'auth' AND tablename = 'tenant_roles'
        ) THEN
          ALTER TABLE public.tenant_roles SET SCHEMA auth;
          ALTER TABLE auth.tenant_roles OWNER TO auth_service;
          ALTER TABLE auth.tenant_roles ENABLE ROW LEVEL SECURITY;
          ALTER TABLE auth.tenant_roles FORCE ROW LEVEL SECURITY;
        END IF;
      END $$;
    `);
  }

  public async down(qr: QueryRunner): Promise<void> {
    await qr.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_tables WHERE schemaname = 'auth' AND tablename = 'tenant_roles'
        ) AND NOT EXISTS (
          SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'tenant_roles'
        ) THEN
          ALTER TABLE auth.tenant_roles SET SCHEMA public;
          ALTER TABLE public.tenant_roles OWNER TO shared_public_owner;
        END IF;
      END $$;
    `);
  }
}
