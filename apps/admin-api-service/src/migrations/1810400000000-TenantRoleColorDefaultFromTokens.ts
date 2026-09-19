import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TenantRoleColorDefaultFromTokens1810400000000
 * ============================================================================
 *
 * Moves `auth.tenant_roles.color`'s DDL default from Tailwind indigo-500
 * (`#6366F1`) to the product's brand primary (`#0073e6`), the value
 * `colors.primary[500]` carries in
 * `libs/shared-contracts/src/design/color-tokens.ts` (FE-MEDIUM-093).
 *
 * # Why the column has a default at all, and why it drifted
 *
 * `TenantRoleService.createRole` always supplies a colour, falling back to the
 * same brand primary when the caller omits one. The DDL default is the second
 * line: a role row written by a raw SQL path — the tenant-provisioning seed, an
 * operator repair — takes it. Those two therefore have to agree, and they did
 * not: the service inserted one value and the table defaulted to another, so
 * the same role looked one colour when the API created it and another when the
 * database did. That is the two-sources-of-truth defect this wave exists to
 * remove, in its smallest form.
 *
 * # Why this migration lives in admin-api and not in auth-service
 *
 * `auth.tenant_roles` sits in the `auth` schema but its DDL is owned here:
 * `1800200000000-CreateAdminEntitySurfaceTables` creates it, along with
 * `tenant_role_permissions` and `user_role_assignments` (RBAC-HIGH-011 gave the
 * three tables an `@Entity` in auth-service for drift detection only — the
 * owning runtime for their SHAPE is this service). Shipping the ALTER from
 * auth-service's runner fails outright on a fresh database: the runners are
 * independent, auth's runs before admin-api has created the table, and the
 * migration aborts with `relation "auth.tenant_roles" does not exist`. The
 * altering migration has to sit behind the creating one, which means here.
 *
 * # Why this is not a data migration
 *
 * Existing rows keep the colour they were created with. A tenant that chose a
 * role colour, or accepted the old default, sees no change — repainting rows
 * would overwrite a customer's own choice, and the old default is
 * indistinguishable from a deliberate pick of the same value. Only rows created
 * after this point take the new default.
 *
 * Blue-green: `ALTER COLUMN … SET DEFAULT` rewrites a catalog entry and takes
 * no table lock beyond the brief ACCESS EXCLUSIVE needed for the catalog
 * update; no row is read or written. The running (pre-migration) service
 * always names `color` in its INSERT, so it never observes the default at all,
 * and the down path restores the previous value exactly.
 */
export class TenantRoleColorDefaultFromTokens1810400000000 implements MigrationInterface {
  name = 'TenantRoleColorDefaultFromTokens1810400000000';

  /** `colors.primary[500]` — the brand blue every other surface paints with. */
  private static readonly BRAND_PRIMARY = '#0073e6';

  /** Tailwind indigo-500, the value `CreateAdminEntitySurfaceTables` wrote. */
  private static readonly PREVIOUS_DEFAULT = '#6366F1';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "auth"."tenant_roles" ALTER COLUMN "color" SET DEFAULT '${TenantRoleColorDefaultFromTokens1810400000000.BRAND_PRIMARY}'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "auth"."tenant_roles" ALTER COLUMN "color" SET DEFAULT '${TenantRoleColorDefaultFromTokens1810400000000.PREVIOUS_DEFAULT}'`,
    );
  }
}
