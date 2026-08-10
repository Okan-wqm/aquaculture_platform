import { MigrationInterface, QueryRunner } from 'typeorm';

const ASSIGNMENTS = 'feeder_assignments';
const TOTALS = 'feeder_assignment_unit_totals';
const RECONCILE_FN = 'feeder_assignments_reconcile_unit_total';
const TRIGGER_FN = 'feeder_assignments_assert_unit_share_sum';
const TRIGGER = 'trg_feeder_assignments_share_sum';

/**
 * CreateFeederAssignments1808900000000
 *
 * WHAT: the unit → feeder binding and the database-level guarantee that a unit's
 * active feeders cover exactly 100% of its daily dose.
 *
 *  - `feeder_assignments`: one row per (unit, feeder) generation, carrying the
 *    feeder's share of the daily dose and an ACTIVE/ENDED lifecycle. Rows are
 *    ended, never deleted, so a feeding record written last month can still name
 *    the feeder that delivered it and the share it then had.
 *  - `feeder_assignment_unit_totals`: exactly one row per unit that has ever had
 *    a feeder, carrying the summed active share with
 *    `CHECK (total = 0 OR total = 100)`.
 *  - a DEFERRABLE INITIALLY DEFERRED constraint trigger on `feeder_assignments`
 *    that recomputes that total at COMMIT.
 *
 * WHY the invariant is expressed as a derived row plus a CHECK rather than as a
 * service-layer sum:
 *
 *  1. A unit whose shares sum to 90 silently underfeeds fish every single day
 *     and nothing downstream would notice, so the guarantee has to hold against
 *     writers that never see the service — raw SQL, a data-fix script, a future
 *     handler. A sum cannot be written as a CHECK over the assignment table
 *     itself, but it CAN be written as a CHECK over a derived total; the trigger
 *     keeps the total honest and the CHECK makes any other value uncommittable.
 *
 *  2. Checking at COMMIT is what makes multi-row edits possible at all. Adding a
 *     second feeder necessarily passes through a moment where the shares do not
 *     sum to 100 (the first row still says 100, the second says 40). An IMMEDIATE
 *     check would reject that intermediate state and make a two-feeder unit
 *     unreachable. Judging at COMMIT looks only at the state the transaction
 *     actually leaves behind. The corollary is deliberate: a multi-row edit
 *     outside a transaction fails, because each autocommit statement IS its own
 *     transaction — feeder-set edits must be transactional, and now they must be
 *     structurally.
 *
 *  3. Concurrency. The totals row is the serialization anchor: the trigger
 *     UPDATEs it before it reads, so two transactions touching the same unit
 *     conflict on one row. Under READ COMMITTED (the runtime default here) the
 *     second transaction blocks on that row, and its subsequent SUM runs in a
 *     fresh statement snapshot that includes the first transaction's committed
 *     rows — so it sees the true total and is rejected. Under REPEATABLE READ or
 *     SERIALIZABLE the same UPDATE raises `could not serialize access due to
 *     concurrent update` and the second transaction aborts. Without the anchor
 *     two concurrent inserts could each observe a locally valid sum and commit a
 *     unit at 150%.
 *
 * Ünite kimliği ProtocolAssignment ile aynıdır ve legacy `tanks` satırı da
 * olabildiği için `unitId` üzerinde FK YOKTUR (ProtocolAssignment de koymaz).
 * `feederEquipmentId` her zaman bir Equipment satırıdır ve gerçek FK ile
 * bağlanır — bir SubEquipment id'sinin buraya yazılması yapısal olarak
 * imkânsızdır.
 *
 * Her iki tablo TENANT-SCOPED'tur; DDL bu yüzden ŞEMA-NİTELEMESİZDİR (tablolar,
 * enum tipleri, fonksiyonlar ve trigger) — her schema pass'i nesneleri kendi
 * şemasına indirir (CreateFeedingProtocolV2Tables / CreateIncidentMedia deseni).
 * Trigger yalnızca bu iki tabloya bağlanır; hiçbir reconciler tüm şemayı
 * taramaz, dolayısıyla declarative-partition child trigger'larına dokunma
 * ihtimali yoktur.
 */
export class CreateFeederAssignments1808900000000 implements MigrationInterface {
  name = 'CreateFeederAssignments1808900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE feeder_assignments_unittype_enum AS ENUM ('tank', 'pond', 'cage');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE feeder_assignments_status_enum AS ENUM ('active', 'ended');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${ASSIGNMENTS}" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "unitId" uuid NOT NULL,
        "unitType" feeder_assignments_unittype_enum NOT NULL,
        "unitName" character varying(200) NOT NULL,
        "unitCode" character varying(50) NOT NULL,
        "siteId" uuid NOT NULL,
        "feederEquipmentId" uuid NOT NULL,
        "feederName" character varying(200) NOT NULL,
        "feederCode" character varying(50) NOT NULL,
        "doseSharePercent" numeric(6,3) NOT NULL,
        "status" feeder_assignments_status_enum NOT NULL DEFAULT 'active',
        "effectiveFrom" date NOT NULL,
        "endedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "createdBy" uuid,
        "updatedBy" uuid,
        "version" integer NOT NULL,
        CONSTRAINT "PK_feeder_assignments" PRIMARY KEY ("id"),
        -- A feeder that delivers nothing is not an assignment; a feeder that
        -- delivers more than the whole dose is arithmetic nonsense.
        CONSTRAINT "CK_fa_share_range"
          CHECK ("doseSharePercent" > 0 AND "doseSharePercent" <= 100),
        -- Lifecycle and timestamp cannot disagree: ended rows carry an end,
        -- active rows do not.
        CONSTRAINT "CK_fa_ended_at_matches_status"
          CHECK (("status" = 'ended') = ("endedAt" IS NOT NULL))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${TOTALS}" (
        "tenantId" uuid NOT NULL,
        "unitId" uuid NOT NULL,
        "activeSharePercentTotal" numeric(6,3) NOT NULL,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_feeder_assignment_unit_totals" PRIMARY KEY ("tenantId", "unitId"),
        -- THE invariant. A unit is either hand-fed (no active feeder, total 0)
        -- or its feeders cover the whole daily dose. Nothing else can commit.
        CONSTRAINT "CK_fault_total_is_zero_or_full"
          CHECK ("activeSharePercentTotal" = 0 OR "activeSharePercentTotal" = 100)
      )
    `);

    // Bir yemleyici aynı ünitede iki kez aktif olamaz (pay ikiye bölünemez).
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_fa_tenant_unit_feeder_active" ON "${ASSIGNMENTS}" ("tenantId", "unitId", "feederEquipmentId") WHERE "status" = 'active'`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fa_tenant_unit_status" ON "${ASSIGNMENTS}" ("tenantId", "unitId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fa_tenant_feeder_status" ON "${ASSIGNMENTS}" ("tenantId", "feederEquipmentId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fa_tenant_site" ON "${ASSIGNMENTS}" ("tenantId", "siteId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fa_tenant" ON "${ASSIGNMENTS}" ("tenantId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fault_tenant" ON "${TOTALS}" ("tenantId")`,
    );

    // A feeder IS an Equipment row. The FK is what makes the losing
    // interpretation (a SubEquipment id) impossible to store.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass(current_schema() || '.equipment') IS NOT NULL THEN
          ALTER TABLE "${ASSIGNMENTS}"
            ADD CONSTRAINT "FK_fa_feeder_equipment"
            FOREIGN KEY ("feederEquipmentId") REFERENCES "equipment" ("id");
        END IF;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${RECONCILE_FN}(p_tenant uuid, p_unit uuid)
      RETURNS void AS $fn$
      DECLARE
        v_total numeric(6,3);
      BEGIN
        -- (1) Take the per-unit serialization anchor BEFORE reading. Every
        -- mutation of this unit's feeder set passes through this one row, so
        -- concurrent transactions serialise here instead of each computing a
        -- sum from a snapshot that misses the other's rows.
        INSERT INTO ${TOTALS} ("tenantId", "unitId", "activeSharePercentTotal", "updatedAt")
        VALUES (p_tenant, p_unit, 0, now())
        ON CONFLICT ("tenantId", "unitId") DO UPDATE SET "updatedAt" = now();

        -- (2) Read the active set AFTER the anchor is held. Under READ
        -- COMMITTED this statement takes a fresh snapshot, so it sees whatever
        -- a competing transaction committed while we waited.
        SELECT COALESCE(SUM("doseSharePercent"), 0)
          INTO v_total
          FROM ${ASSIGNMENTS}
         WHERE "tenantId" = p_tenant
           AND "unitId" = p_unit
           AND "status" = 'active';

        -- (3) Publish the total. The CHECK on ${TOTALS} admits only 0 or 100,
        -- so this UPDATE is where an under- or over-fed unit dies. The handler
        -- below only replaces the message with an operator-readable one; the
        -- constraint is the enforcement.
        BEGIN
          UPDATE ${TOTALS}
             SET "activeSharePercentTotal" = v_total,
                 "updatedAt" = now()
           WHERE "tenantId" = p_tenant AND "unitId" = p_unit;
        EXCEPTION WHEN check_violation THEN
          RAISE EXCEPTION
            'Unit % has active feeder shares summing to %, which must be exactly 100 (or the unit must have no active feeder at all)',
            p_unit, v_total
            USING ERRCODE = 'check_violation';
        END;
      END;
      $fn$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION ${TRIGGER_FN}()
      RETURNS TRIGGER AS $fn$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          PERFORM ${RECONCILE_FN}(OLD."tenantId", OLD."unitId");
          RETURN NULL;
        END IF;

        PERFORM ${RECONCILE_FN}(NEW."tenantId", NEW."unitId");

        -- A row moved between units leaves the OLD unit short; settle it too.
        IF TG_OP = 'UPDATE'
           AND (OLD."tenantId", OLD."unitId") IS DISTINCT FROM (NEW."tenantId", NEW."unitId") THEN
          PERFORM ${RECONCILE_FN}(OLD."tenantId", OLD."unitId");
        END IF;

        RETURN NULL;
      END;
      $fn$ LANGUAGE plpgsql;
    `);

    // WHAT: pin both functions to the schema they were created in.
    //
    // WHY this is load-bearing and not hygiene: PL/pgSQL resolves the table and
    // function names in a body through the CALLER's `search_path` at execution
    // time, not the creator's. A writer that reaches the table schema-qualified
    // from a session whose search_path is the default would make the trigger
    // body fail to find `${TOTALS}` and `${RECONCILE_FN}` — the write would be
    // rejected, but with "function does not exist" instead of the invariant, and
    // the guard would be reporting on its own plumbing rather than on the data.
    // Pinning makes the guard independent of who calls it. Per-tenant fan-out is
    // preserved because each schema pass creates its own pair of functions and
    // pins each to its own schema.
    await queryRunner.query(`
      DO $mig$
      DECLARE
        v_schema text := current_schema();
      BEGIN
        EXECUTE format(
          'ALTER FUNCTION %I.${RECONCILE_FN}(uuid, uuid) SET search_path TO %I, pg_temp',
          v_schema, v_schema);
        EXECUTE format(
          'ALTER FUNCTION %I.${TRIGGER_FN}() SET search_path TO %I, pg_temp',
          v_schema, v_schema);
      END $mig$;
    `);

    await queryRunner.query(`DROP TRIGGER IF EXISTS ${TRIGGER} ON "${ASSIGNMENTS}"`);
    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER ${TRIGGER}
        AFTER INSERT OR UPDATE OR DELETE ON "${ASSIGNMENTS}"
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION ${TRIGGER_FN}()
    `);
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`
      SELECT
        to_regclass(current_schema() || '.${ASSIGNMENTS}') IS NOT NULL
        AND to_regclass(current_schema() || '.${TOTALS}') IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = current_schema()
            AND c.relname = '${ASSIGNMENTS}'
            AND t.tgname = '${TRIGGER}'
            AND t.tgdeferrable
            AND t.tginitdeferred
        ) AS ok
    `)) as Array<{ ok: boolean }>;

    return rows[0]?.ok === true;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass(current_schema() || '.${ASSIGNMENTS}') IS NOT NULL THEN
          DROP TRIGGER IF EXISTS ${TRIGGER} ON "${ASSIGNMENTS}";
        END IF;
      END $$;
    `);
    await queryRunner.query(`DROP FUNCTION IF EXISTS ${TRIGGER_FN}()`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS ${RECONCILE_FN}(uuid, uuid)`);
    // DESTRUCTIVE: down() of CreateFeederAssignments1808900000000 — drops the
    // unit→feeder binding introduced by this same migration; rollback reference
    // is this file's up().
    await queryRunner.query(`DROP TABLE IF EXISTS "${ASSIGNMENTS}"`);
    // DESTRUCTIVE: down() of CreateFeederAssignments1808900000000 — drops the
    // derived share-total anchor introduced by this same migration; rollback
    // reference is this file's up().
    await queryRunner.query(`DROP TABLE IF EXISTS "${TOTALS}"`);
    await queryRunner.query(`DROP TYPE IF EXISTS feeder_assignments_status_enum`);
    await queryRunner.query(`DROP TYPE IF EXISTS feeder_assignments_unittype_enum`);
  }
}
