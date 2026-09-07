import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `admin.user_sessions` was a session store nothing ever wrote to.
 * ============================================================================
 *
 * The table was created by the Baseline and carried a full session model —
 * token, device, geo, request counts, termination reason. The only INSERT
 * anywhere in the platform was `ActivityLoggingService.createSession`, and
 * that method had no callers; neither did `updateSessionActivity` or
 * `terminateSession`. So the table stayed empty for its whole life, and the
 * three surfaces that read it read nothing:
 *
 *   - `GET /security/activities/sessions/user/:userId` always answered `[]`,
 *     while the user's real sessions sat in `auth.refresh_tokens`.
 *   - `POST /security/activities/sessions/user/:userId/terminate` always
 *     answered `{ terminated: 0 }` and revoked nothing. An operator locking
 *     out a compromised account through it got HTTP 200 and left every live
 *     session working.
 *   - `SecurityMonitoringService.checkSessionHijacking` returned `false` at
 *     its first lookup. It had no callers either, so it was dead code rather
 *     than a control silently switched off — but it could never have worked.
 *
 * An hourly cron (`cleanupExpiredSessions`) swept the empty table forever.
 *
 * Session state belongs to auth-service: `auth.refresh_tokens` plus the Redis
 * `SessionManagerService`, with `AUTH_ADMIN_COMMAND_SUBJECTS.FORCE_LOGOUT_USER`
 * as the admin write path. That is the same rule already applied to
 * `auth.users`, where admin-api's raw-SQL INSERT was replaced by a NATS
 * delegation because admin-api is not the owner of the auth schema. A second
 * copy of session state in `admin` could only ever disagree with the first,
 * and here it disagreed by being permanently empty.
 *
 * The working admin surface is untouched and is what the admin panel calls:
 * `GET /users/:id/sessions` reads `auth.refresh_tokens`, and
 * `PATCH /users/:id/force-logout` delegates to auth-service over NATS.
 *
 * Dropping is safe without a backfill window precisely because the table has
 * no writer: there is no row anywhere in any environment to preserve. The
 * `down` recreates the empty table so the migration is reversible in shape,
 * which is all that can be reversed — the deleted rows never existed.
 *
 * ADMIN-HIGH-100.
 */
export class DropDeadAdminUserSessions1808500000000 implements MigrationInterface {
  name = 'DropDeadAdminUserSessions1808500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Indexes go with the table under DROP TABLE; naming them is redundant.
    await queryRunner.query(`DROP TABLE IF EXISTS "admin"."user_sessions"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // IF NOT EXISTS throughout: the runner replays a migration on every cold
    // start until the ledger records success, so a half-applied `down` must be
    // safe to re-run. CONCURRENTLY is not an option — it cannot run inside the
    // transaction the runner wraps each migration in — and is not needed here:
    // the table it indexes is empty and brand new in this same block.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "admin"."user_sessions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "sessionToken" character varying(255) NOT NULL,
        "userId" character varying(100) NOT NULL,
        "userName" character varying(255) NOT NULL,
        "tenantId" character varying(100),
        "tenantName" character varying(255),
        "isActive" boolean NOT NULL DEFAULT true,
        "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "ipAddress" character varying(45) NOT NULL,
        "geoLocation" jsonb,
        "deviceInfo" jsonb,
        "requestCount" integer NOT NULL DEFAULT '0',
        "lastActivityAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "lastActivityPath" character varying(500),
        "terminatedAt" TIMESTAMP WITH TIME ZONE,
        "terminationReason" character varying(50),
        "terminatedBy" character varying(100),
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_cd183bcb9ffe40bd858ed6b6b87" UNIQUE ("sessionToken"),
        CONSTRAINT "PK_e93e031a5fed190d4789b6bfd83" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_1f04707a77dae48b72dffd2c89" ON "admin"."user_sessions" ("lastActivityAt")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_cd183bcb9ffe40bd858ed6b6b8" ON "admin"."user_sessions" ("sessionToken")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_9129fe4a216108e1a227b4fee7" ON "admin"."user_sessions" ("tenantId", "isActive")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_36cbbaa23a16cc814fc39f1a7e" ON "admin"."user_sessions" ("userId", "isActive")`,
    );
  }
}
