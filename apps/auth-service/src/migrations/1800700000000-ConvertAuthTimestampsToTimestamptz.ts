import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ConvertAuthTimestampsToTimestamptz1800700000000 (DATA-HIGH-002 / HIGH-009)
 *
 * WHY: every auth-schema timestamp column was `timestamp without time zone`
 * (TypeORM's @CreateDateColumn/@UpdateDateColumn default). A tz-naive column
 * silently reinterprets its wall-clock value under whatever the session
 * TimeZone happens to be, so a row written under one server TZ and read under
 * another drifts by the offset — an audit/forensics and ordering hazard. All
 * stored values are already UTC, so converting each column to `timestamptz` with
 * `USING <col> AT TIME ZONE 'UTC'` pins the existing instants and makes every
 * future read/write tz-aware. The matching entities declare `{ type:
 * 'timestamptz' }` so SchemaDriftValidator confirms parity at boot.
 *
 * Column list is the live `information_schema` ground truth (27 columns across
 * 17 auth tables); column identifiers are mostly camelCase ("createdAt") with
 * mobile_user_settings on the snake_case convention ("created_at").
 *
 * audit_logs safety: `audit_logs."createdAt"` carries the append-only
 * `trg_audit_logs_prevent_update` BEFORE DELETE OR UPDATE trigger. An
 * `ALTER COLUMN ... TYPE` is a table rewrite (DDL), NOT a row UPDATE/DELETE, so
 * the row-level trigger does not fire — verified empirically against the live
 * schema. No trigger drop/recreate is needed (and avoiding it removes the risk
 * of a faulty immutability re-install); audit-immutability invariants are
 * unchanged.
 *
 * Blue-green safe: type-widening only. An older entity still typed `timestamp`
 * reads a `timestamptz` column as a `Date` without error, so there is no
 * breaking transient between the migration and the new service revision.
 * Idempotent: re-running an already-timestamptz column ALTER is a no-op rewrite.
 */
export class ConvertAuthTimestampsToTimestamptz1800700000000 implements MigrationInterface {
  name = 'ConvertAuthTimestampsToTimestamptz1800700000000';

  // [table, column] — the 27 `timestamp without time zone` columns in `auth`.
  private static readonly COLUMNS: ReadonlyArray<readonly [string, string]> = [
    ['announcement_acknowledgments', 'viewedAt'],
    ['announcements', 'createdAt'],
    ['announcements', 'updatedAt'],
    ['audit_logs', 'createdAt'],
    ['invitations', 'createdAt'],
    ['invitations', 'updatedAt'],
    ['message_threads', 'createdAt'],
    ['message_threads', 'updatedAt'],
    ['messages', 'createdAt'],
    ['mobile_user_settings', 'created_at'],
    ['mobile_user_settings', 'updated_at'],
    ['modules', 'createdAt'],
    ['modules', 'updatedAt'],
    ['refresh_tokens', 'createdAt'],
    ['support_tickets', 'createdAt'],
    ['support_tickets', 'updatedAt'],
    ['tenant_modules', 'createdAt'],
    ['tenant_modules', 'updatedAt'],
    ['tenants', 'createdAt'],
    ['tenants', 'updatedAt'],
    ['ticket_comments', 'createdAt'],
    ['user_module_assignments', 'createdAt'],
    ['user_module_assignments', 'updatedAt'],
    ['users', 'createdAt'],
    ['users', 'updatedAt'],
    ['webauthn_credentials', 'createdAt'],
    ['webauthn_credentials', 'updatedAt'],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [table, column] of ConvertAuthTimestampsToTimestamptz1800700000000.COLUMNS) {
      // R10 idempotency: convert ONLY a column still typed `timestamp without
      // time zone`. Re-running an unconditional `... TYPE timestamptz USING <col>
      // AT TIME ZONE 'UTC'` on an already-timestamptz column would reinterpret it
      // under the session TZ and shift the instant — corruption on replay. The
      // information_schema guard makes a replay (e.g. ledger reset) a clean no-op.
      // Existing values are UTC wall-clock; interpret them as UTC and pin the
      // instant as a timestamptz.
      await queryRunner.query(`
        DO $$ BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'auth' AND table_name = '${table}'
              AND column_name = '${column}'
              AND data_type = 'timestamp without time zone'
          ) THEN
            EXECUTE 'ALTER TABLE "auth"."${table}" ALTER COLUMN "${column}" TYPE timestamptz USING "${column}" AT TIME ZONE ''UTC''';
          END IF;
        END $$;
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [table, column] of ConvertAuthTimestampsToTimestamptz1800700000000.COLUMNS) {
      // Reverse: project the timestamptz back to its UTC wall-clock as a
      // tz-naive timestamp. Guarded so a replay is a clean no-op.
      await queryRunner.query(`
        DO $$ BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'auth' AND table_name = '${table}'
              AND column_name = '${column}'
              AND data_type = 'timestamp with time zone'
          ) THEN
            EXECUTE 'ALTER TABLE "auth"."${table}" ALTER COLUMN "${column}" TYPE timestamp USING "${column}" AT TIME ZONE ''UTC''';
          END IF;
        END $$;
      `);
    }
  }
}
