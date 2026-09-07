import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RetireAdminUserSessions — `admin.user_sessions` is deleted, not projected
 * (ADMIN-HIGH-014, ADR-0018).
 *
 * WHY: it was the third session store and the only one with no writer. Its two
 * sibling detective stores in the same finding — `login_attempts` and
 * `api_usage_logs` — were fixed by projecting the security-event stream into
 * them, because nothing else held those facts. Sessions are the opposite case,
 * on both halves:
 *
 *  - Nothing can fill it. `sessionToken` is NOT NULL + UNIQUE, and no
 *    session-lifecycle event exists anywhere in `libs/event-contracts` (no
 *    SessionCreated / SessionRevoked / SessionTerminated / UserLoggedOut). The
 *    only session id the platform ever mints is discarded at
 *    `token.service.ts:436` and never reaches a JWT, a cookie or a
 *    `refresh_tokens` row, so no wire fact can address one session. Projecting
 *    would mean inventing an event family AND threading a session id through
 *    auth's token issuance — building a third session system, not projecting.
 *  - Nothing needs it. `auth.refresh_tokens` already carries ip, userAgent,
 *    deviceId, expiry, revoked + reason + time per session, with an
 *    authoritative writer and a working admin read path
 *    (`GET /users/:id/sessions`), and the panel's "log out of all sessions"
 *    action goes over NATS to auth-service. No admin-panel component reads
 *    this table; its two routes have returned empty since the day they shipped.
 *
 * The only non-route reader was `SecurityMonitoringService.checkSessionHijacking`,
 * which had zero callers repo-wide — and whose "the IP changed" heuristic is a
 * false-positive generator next to `RefreshTokenReuseDetectedEvent`, the real
 * token-theft signal auth already emits. If session-hijack detection is wanted
 * it belongs in auth-service over `auth.refresh_tokens` (familyId + ipAddress),
 * not as a projected copy in admin.
 *
 * SAFETY SHAPE: the table is empty by construction — no INSERT exists in any
 * service — so there is nothing to archive, and the reverse step recreates the
 * table, its unique constraint and all four indexes exactly as
 * `1800000000000-Baseline` declared them.
 *
 * Blue-green: deploy the code change ahead of, or with, this migration. Reads
 * from an older replica already return empty, but its `SchemaDriftValidator`
 * would fail at cold start once the table is gone.
 *
 * Closes: docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#ADMIN-HIGH-014
 */
export class RetireAdminUserSessions1809400000000 implements MigrationInterface {
  name = 'RetireAdminUserSessions1809400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    // Refuse to retire a table that somehow holds rows: this migration's whole
    // premise is that nothing writes it, and a row would mean that is false.
    await queryRunner.query(`
      DO $$
      DECLARE
        row_count bigint;
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'admin' AND table_name = 'user_sessions'
        ) THEN
          RETURN;
        END IF;

        EXECUTE 'SELECT count(*) FROM admin.user_sessions' INTO row_count;
        IF row_count > 0 THEN
          RAISE EXCEPTION
            'admin.user_sessions holds % row(s); the retire premise (no writer exists) is false — stop and re-audit',
            row_count;
        END IF;
      END $$;
    `);

    await queryRunner.query(`DROP TABLE IF EXISTS "admin"."user_sessions"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "admin"."user_sessions" (
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
       )`,
    );
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
