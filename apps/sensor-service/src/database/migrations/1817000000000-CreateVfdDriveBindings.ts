import { MigrationInterface, QueryRunner } from 'typeorm';
import { ExpandContract } from '@aquaculture/backend-common/database';

const BINDINGS = 'vfd_drive_bindings';
const UNITS = 'vfd_drive_binding_units';

/**
 * CreateVfdDriveBindings1817000000000 — EXPAND phase.
 *
 * WHAT: the drive → equipment binding, and the units that follow from it.
 *
 *  - `vfd_drive_bindings`: one row per VFD, naming the farm `equipment.id` the
 *    drive actuates plus what the owning service last said about it (`state`,
 *    `equipment_category`, `attested_at`). The VFD id IS the primary key, so a
 *    second binding for the same drive is unrepresentable — a drive turns one
 *    shaft.
 *  - `vfd_drive_binding_units`: the units that equipment currently serves. Rows
 *    exist only for feeders with active assignments. A set, not a column, because
 *    a feeder can legitimately serve two units and a column would have to pick
 *    one — picking one is exactly how a drive doses the wrong container.
 *
 * WHY there is no foreign key onto `equipment`: farm-service owns that table and
 * grants it to a different database role (`farm_service`; this service holds
 * `sensor_service`). A constraint across that line would trade an integrity gap
 * for a deploy-ordering coupling between two independently released services, and
 * it still could not answer the question that matters — a valid-but-wrong id
 * satisfies a foreign key perfectly. The integrity discipline is instead an
 * attestation the owner issues (`VfdDriveBindingAttested`) with an expiry the
 * drive refuses to act past. See VfdDriveBindingService for what that cannot
 * guarantee.
 *
 * The `pump_id` backfill: rows that carried one get a PENDING binding. PENDING
 * cannot actuate, and the drive re-asks on first read — so an inherited value is
 * confirmed before it can move anything, rather than trusted because it was
 * already in the database.
 *
 * Both tables are TENANT-SCOPED, so the DDL is schema-unqualified and every schema
 * pass lands the objects in its own schema (the CreateFeederAssignments pattern).
 */
@ExpandContract({ phase: 'expand' })
export class CreateVfdDriveBindings1817000000000 implements MigrationInterface {
  name = 'CreateVfdDriveBindings1817000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${BINDINGS}" (
        "vfd_device_id" uuid NOT NULL,
        "tenant_id" uuid NOT NULL,
        "driven_equipment_id" uuid NOT NULL,
        "state" character varying(32) NOT NULL DEFAULT 'pending',
        "equipment_category" character varying(50),
        "equipment_code" character varying(50),
        "equipment_name" character varying(200),
        "site_id" uuid,
        "requested_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "attested_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "bound_by" uuid,
        CONSTRAINT "PK_vfd_drive_bindings" PRIMARY KEY ("vfd_device_id"),
        -- The state vocabulary is closed at the database, not only in TypeScript:
        -- a writer that skips the service cannot invent a fourth state that the
        -- actuation gate would then fail to recognise.
        CONSTRAINT "CK_vdb_state"
          CHECK ("state" IN ('pending', 'attested', 'unknown_equipment', 'inactive_equipment')),
        -- Attested and stamped travel together. A row claiming to be attested with
        -- no timestamp would have no age, and the expiry that bounds this whole
        -- mechanism's residual risk is computed from that age.
        CONSTRAINT "CK_vdb_attested_at_matches_state"
          CHECK (("state" = 'attested') = ("attested_at" IS NOT NULL))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "${UNITS}" (
        "vfd_device_id" uuid NOT NULL,
        "unit_id" uuid NOT NULL,
        "tenant_id" uuid NOT NULL,
        "unit_type" character varying(16) NOT NULL,
        "unit_code" character varying(50) NOT NULL,
        "dose_share_percent" numeric(6,3) NOT NULL,
        CONSTRAINT "PK_vfd_drive_binding_units" PRIMARY KEY ("vfd_device_id", "unit_id"),
        CONSTRAINT "CK_vdbu_share_range"
          CHECK ("dose_share_percent" > 0 AND "dose_share_percent" <= 100)
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_vdb_tenant" ON "${BINDINGS}" ("tenant_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_vdb_tenant_equipment" ON "${BINDINGS}" ("tenant_id", "driven_equipment_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_vdb_tenant_state" ON "${BINDINGS}" ("tenant_id", "state")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_vdbu_tenant_unit" ON "${UNITS}" ("tenant_id", "unit_id")`,
    );

    // A unit row without its binding is meaningless, and a deleted drive must not
    // leave one behind. Both tables belong to this service, so this FK crosses no
    // ownership line.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass(current_schema() || '.${BINDINGS}') IS NOT NULL
           AND to_regclass(current_schema() || '.${UNITS}') IS NOT NULL THEN
          ALTER TABLE "${UNITS}"
            ADD CONSTRAINT "FK_vdbu_binding"
            FOREIGN KEY ("vfd_device_id") REFERENCES "${BINDINGS}" ("vfd_device_id")
            ON DELETE CASCADE;
        END IF;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // Same for the drive itself: a binding for a device that no longer exists is
    // an orphan the health surface would keep counting.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass(current_schema() || '.${BINDINGS}') IS NOT NULL
           AND to_regclass(current_schema() || '.vfd_devices') IS NOT NULL THEN
          ALTER TABLE "${BINDINGS}"
            ADD CONSTRAINT "FK_vdb_device"
            FOREIGN KEY ("vfd_device_id") REFERENCES "vfd_devices" ("id")
            ON DELETE CASCADE;
        END IF;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // Backfill: every drive that named a pump now names it generically, PENDING.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass(current_schema() || '.vfd_devices') IS NULL
           OR to_regclass(current_schema() || '.${BINDINGS}') IS NULL THEN
          RETURN;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'vfd_devices'
             AND column_name = 'pump_id'
        ) THEN
          RETURN;
        END IF;

        INSERT INTO "${BINDINGS}"
          ("vfd_device_id", "tenant_id", "driven_equipment_id", "state", "requested_at")
        SELECT d."id", d."tenant_id", d."pump_id", 'pending', now()
          FROM "vfd_devices" d
         WHERE d."pump_id" IS NOT NULL
        ON CONFLICT ("vfd_device_id") DO NOTHING;
      END $$;
    `);
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`
      SELECT
        to_regclass(current_schema() || '.${BINDINGS}') IS NOT NULL
        AND to_regclass(current_schema() || '.${UNITS}') IS NOT NULL AS ok
    `)) as Array<{ ok: boolean }>;

    return rows[0]?.ok === true;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // DESTRUCTIVE: down() of CreateVfdDriveBindings1817000000000 — drops the
    // drive→equipment binding introduced by this same migration; rollback
    // reference is this file's up().
    await queryRunner.query(`DROP TABLE IF EXISTS "${UNITS}"`);
    // DESTRUCTIVE: down() of CreateVfdDriveBindings1817000000000 — drops the
    // binding table introduced by this same migration; rollback reference is this
    // file's up().
    await queryRunner.query(`DROP TABLE IF EXISTS "${BINDINGS}"`);
  }
}
