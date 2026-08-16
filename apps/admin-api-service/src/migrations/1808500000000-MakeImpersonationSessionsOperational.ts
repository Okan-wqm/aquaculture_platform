import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Reclassifies admin.impersonation_sessions as an operational security state
 * machine. The baseline's append-only trigger blocks every legitimate end,
 * terminate, extend, expire, and action-log UPDATE.
 */
export class MakeImpersonationSessionsOperational1808500000000 implements MigrationInterface {
  name = 'MakeImpersonationSessionsOperational1808500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_impersonation_sessions_prevent_update
      ON "admin"."impersonation_sessions"
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS "admin".impersonation_sessions_prevent_update_or_delete()
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "admin".impersonation_sessions_enforce_lifecycle()
      RETURNS trigger AS $impersonation_lifecycle$
      BEGIN
        IF ROW(
          NEW."id", NEW."superAdminId", NEW."superAdminEmail",
          NEW."targetTenantId", NEW."targetTenantName", NEW."targetUserId",
          NEW."targetUserEmail", NEW."reason", NEW."reasonDetails",
          NEW."ticketReference", NEW."permissions", NEW."ipAddress",
          NEW."userAgent", NEW."originalSessionToken", NEW."impersonationToken",
          NEW."mfaCompleted", NEW."metadata", NEW."createdAt"
        ) IS DISTINCT FROM ROW(
          OLD."id", OLD."superAdminId", OLD."superAdminEmail",
          OLD."targetTenantId", OLD."targetTenantName", OLD."targetUserId",
          OLD."targetUserEmail", OLD."reason", OLD."reasonDetails",
          OLD."ticketReference", OLD."permissions", OLD."ipAddress",
          OLD."userAgent", OLD."originalSessionToken", OLD."impersonationToken",
          OLD."mfaCompleted", OLD."metadata", OLD."createdAt"
        ) THEN
          RAISE EXCEPTION 'impersonation session identity and authorization fields are immutable';
        END IF;

        IF OLD."status" <> 'active' THEN
          RAISE EXCEPTION 'terminal impersonation sessions are immutable';
        END IF;
        IF NEW."status" NOT IN ('active', 'ended', 'expired', 'terminated') THEN
          RAISE EXCEPTION 'invalid impersonation session transition: active -> %', NEW."status";
        END IF;
        IF NEW."status" = 'active' AND NEW."endedAt" IS NOT NULL THEN
          RAISE EXCEPTION 'active impersonation session cannot have endedAt';
        END IF;
        IF NEW."status" <> 'active' AND NEW."endedAt" IS NULL THEN
          RAISE EXCEPTION 'terminal impersonation session requires endedAt';
        END IF;
        IF NEW."status" = 'active' AND NEW."expiresAt" < OLD."expiresAt" THEN
          RAISE EXCEPTION 'active impersonation expiry may only be extended';
        END IF;
        IF NEW."actionCount" < OLD."actionCount" THEN
          RAISE EXCEPTION 'impersonation actionCount is monotonic';
        END IF;

        RETURN NEW;
      END;
      $impersonation_lifecycle$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_impersonation_sessions_enforce_lifecycle
      BEFORE UPDATE ON "admin"."impersonation_sessions"
      FOR EACH ROW EXECUTE FUNCTION "admin".impersonation_sessions_enforce_lifecycle()
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "admin".impersonation_sessions_prevent_delete()
      RETURNS trigger AS $impersonation_retention$
      BEGIN
        RAISE EXCEPTION 'impersonation session rows are retention records and cannot be deleted';
      END;
      $impersonation_retention$ LANGUAGE plpgsql;
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_impersonation_sessions_prevent_delete
      ON "admin"."impersonation_sessions"
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_impersonation_sessions_prevent_delete
      BEFORE DELETE ON "admin"."impersonation_sessions"
      FOR EACH ROW EXECUTE FUNCTION "admin".impersonation_sessions_prevent_delete()
    `);
  }

  public async down(): Promise<void> {
    throw new Error(
      'MakeImpersonationSessionsOperational1808500000000 is forward-only: ' +
        'restoring the blanket UPDATE guard would disable session termination and expiry',
    );
  }
}
