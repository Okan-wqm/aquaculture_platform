import { MigrationInterface, QueryRunner } from 'typeorm';

const TABLE = 'regulatory_reports';
const FUNCTION = 'regulatory_reports_prevent_submitted_mutation';
const TRIGGER = 'trg_regulatory_reports_immutable_submitted';

/**
 * AddRegulatoryReportImmutabilityTrigger1804800000000
 *
 * COMPLIANCE-HIGH-002 — a SUBMITTED regulatory report is the legal record of
 * what was filed to Mattilsynet and must never be silently overwritten. The
 * service-layer `upsert` guard already refuses to reset an accepted row to
 * PENDING (tier-2/3), but a bug, a raw SQL path, or a future code change could
 * still mutate the row. This adds the tier-1 "make it impossible" backstop: a
 * BEFORE UPDATE trigger that RAISEs if a row already in status SUBMITTED has any
 * of its filing-identity fields changed (status, klientReferanse, reportType,
 * payload, or the Mattilsynet referanse). Benign updatedAt/submittedAt-only
 * writes are allowed, so no legitimate flow is affected — nothing in the code
 * re-saves a SUBMITTED row, and the transition INTO SUBMITTED sees OLD.status =
 * PENDING/FAILED (not terminal), so markSubmitted is unaffected.
 *
 * QUEUED (varsling) is intentionally NOT covered here: recordQueued inserts a
 * QUEUED row then immediately UPDATEs it to attach the outbox referanse, so a
 * QUEUED-immutability trigger would fire on that legitimate second write. QUEUED
 * stays protected by the upsert service guard.
 *
 * current_schema-relative (per-tenant fan-out): regulatory_reports is a
 * per-tenant table, so the function + trigger are created UNqualified and
 * db-migrate installs them into farm + every tenant_<uuid> schema. Guarded on
 * table presence so a schema without the table (partial state) is a no-op.
 * Idempotent, forward-only.
 */
export class AddRegulatoryReportImmutabilityTrigger1804800000000 implements MigrationInterface {
  name = 'AddRegulatoryReportImmutabilityTrigger1804800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass(current_schema() || '.${TABLE}') IS NULL THEN
          RETURN;
        END IF;

        CREATE OR REPLACE FUNCTION ${FUNCTION}()
        RETURNS TRIGGER AS $fn$
        BEGIN
          IF OLD.status = 'SUBMITTED' AND (
               NEW.status IS DISTINCT FROM OLD.status
            OR NEW."klientReferanse" IS DISTINCT FROM OLD."klientReferanse"
            OR NEW."reportType" IS DISTINCT FROM OLD."reportType"
            OR NEW.payload IS DISTINCT FROM OLD.payload
            OR NEW.referanse IS DISTINCT FROM OLD.referanse
          ) THEN
            RAISE EXCEPTION
              'regulatory_reports row % is SUBMITTED; its filing record is immutable (COMPLIANCE-HIGH-002)',
              OLD.id;
          END IF;
          RETURN NEW;
        END;
        $fn$ LANGUAGE plpgsql;

        DROP TRIGGER IF EXISTS ${TRIGGER} ON ${TABLE};
        CREATE TRIGGER ${TRIGGER}
          BEFORE UPDATE ON ${TABLE}
          FOR EACH ROW EXECUTE FUNCTION ${FUNCTION}();
      END $$;
    `);
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    // Where the table exists in the active schema, the trigger must exist too.
    const rows = (await queryRunner.query(`
      SELECT
        to_regclass(current_schema() || '.${TABLE}') IS NULL
        OR EXISTS (
          SELECT 1
          FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = current_schema()
            AND c.relname = '${TABLE}'
            AND t.tgname = '${TRIGGER}'
        ) AS ok
    `)) as Array<{ ok: boolean }>;

    return rows[0]?.ok === true;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass(current_schema() || '.${TABLE}') IS NOT NULL THEN
          DROP TRIGGER IF EXISTS ${TRIGGER} ON ${TABLE};
        END IF;
        DROP FUNCTION IF EXISTS ${FUNCTION}();
      END $$;
    `);
  }
}
