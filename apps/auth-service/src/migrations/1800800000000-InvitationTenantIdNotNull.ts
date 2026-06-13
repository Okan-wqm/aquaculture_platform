import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * InvitationTenantIdNotNull1800800000000 (DATA-MEDIUM-002)
 *
 * WHY: `auth.invitations.tenantId` was nullable, but an invitation is
 * structurally always tenant-bound — you invite a user INTO a tenant. A
 * nullable column let a malformed write (or a future refactor) orphan an
 * invitation with no tenant, which would then escape every tenant-scoped query
 * and RLS predicate. The column carries zero NULL rows in practice and the
 * invite flow always sets it, so the constraint is enforceable today.
 *
 * NOT enforced here (deliberate): `auth.refresh_tokens.tenantId` stays nullable.
 * Unlike invitations, a SUPER_ADMIN session has NO tenant, so its refresh tokens
 * legitimately carry NULL tenantId (verified: all NULL-tenant refresh tokens are
 * SUPER_ADMIN-owned). This mirrors `auth.users.tenantId`, which is nullable with
 * the same documented platform-actor exception; a DB constraint cannot express
 * "non-null unless the owning user is SUPER_ADMIN" (cross-table), so the
 * application contract owns that rule. The refresh-token entity documents it.
 *
 * Blue-green safe: invitations.tenantId has no NULL rows and the invite flow
 * always sets it, so SET NOT NULL is a single safe step (no backfill window) —
 * an older revision still typed nullable never inserts a NULL. Idempotent:
 * SET NOT NULL on an already-NOT NULL column is a no-op.
 */
export class InvitationTenantIdNotNull1800800000000 implements MigrationInterface {
  name = 'InvitationTenantIdNotNull1800800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Guard: refuse to apply if any orphan (tenant-less) invitation exists — a
    // fail-loud signal that the application contract was violated, rather than a
    // silent constraint error.
    const orphans = (await queryRunner.query(
      `SELECT count(*)::int AS c FROM "auth"."invitations" WHERE "tenantId" IS NULL`,
    )) as Array<{ c: number }>;
    if ((orphans[0]?.c ?? 0) > 0) {
      throw new Error(
        `Cannot set auth.invitations.tenantId NOT NULL: ${orphans[0]?.c} tenant-less invitation(s) exist; backfill or remove them first`,
      );
    }
    // R10 idempotency: only flip the constraint when the column is still
    // nullable, so a replay (e.g. ledger reset) is a clean no-op.
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'auth' AND table_name = 'invitations'
            AND column_name = 'tenantId' AND is_nullable = 'YES'
        ) THEN
          EXECUTE 'ALTER TABLE "auth"."invitations" ALTER COLUMN "tenantId" SET NOT NULL';
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'auth' AND table_name = 'invitations'
            AND column_name = 'tenantId' AND is_nullable = 'NO'
        ) THEN
          EXECUTE 'ALTER TABLE "auth"."invitations" ALTER COLUMN "tenantId" DROP NOT NULL';
        END IF;
      END $$;
    `);
  }
}
