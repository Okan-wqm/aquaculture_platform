import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PlatformCapabilityGrants1808500000000 — `auth.platform_capability_grants`
 * (ADR-0016, SEC-HIGH-059).
 *
 * WHY: the SUPER_ADMIN role was the whole authorization model of the
 * platform-admin surface. This table narrows it: TokenService projects a
 * user's live rows into the `platformCapabilities` JWT claim and the kernel
 * PlatformCapabilityGuard requires the claim on every mutating admin route.
 *
 * BOOTSTRAP: every ACTIVE SUPER_ADMIN that exists when this migration runs
 * receives the three standing capabilities (`billing-ops`, `support-ops`,
 * `security-ops`), granted by themselves with a reason that names this
 * migration. Without the seed the first deploy would lock every operator out
 * of every mutation, and nobody could grant the capability that grants
 * capabilities. `break-glass` is deliberately NOT seeded: it is minted per
 * incident, time-boxed, by a second SUPER_ADMIN.
 *
 * The seed is idempotent (`NOT EXISTS` per user + capability) so a re-run
 * after a partial apply grants nothing twice. Forward-only: dropping the table
 * would silently return the surface to one-bit authorization.
 */
export class PlatformCapabilityGrants1808500000000 implements MigrationInterface {
  name = 'PlatformCapabilityGrants1808500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "auth"."platform_capability_grants" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL,
        "capability" character varying(32) NOT NULL,
        "grantedBy" uuid NOT NULL,
        "grantedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "expiresAt" TIMESTAMP WITH TIME ZONE,
        "revokedBy" uuid,
        "revokedAt" TIMESTAMP WITH TIME ZONE,
        "reason" character varying(512) NOT NULL,
        CONSTRAINT "PK_platform_capability_grants" PRIMARY KEY ("id"),
        CONSTRAINT "FK_platform_capability_grants_user"
          FOREIGN KEY ("userId") REFERENCES "auth"."users"("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_platform_capability_grants_capability"
          CHECK ("capability" IN ('billing-ops', 'support-ops', 'security-ops', 'platform-read-only', 'break-glass')),
        CONSTRAINT "CHK_platform_capability_grants_break_glass_bounded"
          CHECK ("capability" <> 'break-glass' OR ("expiresAt" IS NOT NULL AND "expiresAt" <= "grantedAt" + interval '4 hours')),
        CONSTRAINT "CHK_platform_capability_grants_revocation_pair"
          CHECK (("revokedAt" IS NULL) = ("revokedBy" IS NULL))
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_platform_capability_grants_user"
        ON "auth"."platform_capability_grants" ("userId")
    `);

    // One live row per user + capability. Partial, so history rows (revoked)
    // do not block a re-grant.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_platform_capability_grants_live"
        ON "auth"."platform_capability_grants" ("userId", "capability")
        WHERE "revokedAt" IS NULL
    `);

    await queryRunner.query(`
      INSERT INTO "auth"."platform_capability_grants" ("userId", "capability", "grantedBy", "reason")
      SELECT u."id", c.capability, u."id",
             'ADR-0016 bootstrap (PlatformCapabilityGrants1808500000000): pre-capability SUPER_ADMIN reach preserved'
        FROM "auth"."users" u
        CROSS JOIN (VALUES ('billing-ops'), ('support-ops'), ('security-ops')) AS c(capability)
       WHERE u."role" = 'SUPER_ADMIN'
         AND u."isActive" = true
         AND NOT EXISTS (
           SELECT 1 FROM "auth"."platform_capability_grants" g
            WHERE g."userId" = u."id" AND g."capability" = c.capability AND g."revokedAt" IS NULL
         )
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only. Dropping the grant table would return the platform-admin
    // surface to one-bit authorization (ADR-0016); revoke rows instead.
  }
}
