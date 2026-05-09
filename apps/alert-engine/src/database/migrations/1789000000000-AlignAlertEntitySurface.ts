import { MigrationInterface, QueryRunner } from 'typeorm';
import { pinSearchPath } from '@aquaculture/backend-common/database';

/**
 * AlignAlertEntitySurface1789000000000
 * ============================================================================
 *
 * Aligns the live `alert` schema with the entity-declared NOT NULL
 * shape on `alert.alert_incidents.rule_id`. The 2026-05-08
 * bootstrap-from-scratch test reported one drift:
 *
 *   [alert.alert_incidents.rule_id] entity declares NOT NULL but
 *   DB column is nullable
 *
 * # Why DELETE-orphan, not backfill
 *
 * `rule_id` is a FK reference to `alert.alert_rules(id)` with
 * `ON DELETE SET NULL` semantics. Any backfill default would invent a
 * rule association that never existed; a sentinel UUID would itself
 * become an orphan FK. Architecturally, NULL rule_id rows are residue
 * from ON DELETE SET NULL — under the new entity contract they are
 * malformed and cannot round-trip through the ORM. Removing them is
 * the only correct cure.
 *
 * # Note on FK ON DELETE behaviour going forward
 *
 * After this migration completes, the FK still has ON DELETE SET NULL
 * but the column is NOT NULL — meaning a future DELETE of an alert_rule
 * referenced by any incident will FAIL with FK violation. This is the
 * correct shape: deleting a rule with live incident history must be
 * refused at the DB level. A separate migration may switch the FK to
 * ON DELETE RESTRICT to make the intent explicit.
 *
 * Closes: docs/reviews/orphan-findings.md#ORPHAN-HIGH-055
 */
export class AlignAlertEntitySurface1789000000000 implements MigrationInterface {
  name = 'AlignAlertEntitySurface1789000000000';

  public async up(qr: QueryRunner): Promise<void> {
    await pinSearchPath(qr, 'alert');

    // DELETE orphans then SET NOT NULL.
    await qr.query(`
      DELETE FROM alert.alert_incidents
       WHERE rule_id IS NULL
    `);

    await qr.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = 'alert'
             AND table_name = 'alert_incidents'
             AND column_name = 'rule_id'
             AND is_nullable = 'YES'
        ) THEN
          ALTER TABLE alert.alert_incidents
            ALTER COLUMN rule_id SET NOT NULL;
        END IF;
      END $$;
    `);
  }

  public async down(qr: QueryRunner): Promise<void> {
    await pinSearchPath(qr, 'alert');

    await qr.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = 'alert'
             AND table_name = 'alert_incidents'
             AND column_name = 'rule_id'
             AND is_nullable = 'NO'
        ) THEN
          ALTER TABLE alert.alert_incidents
            ALTER COLUMN rule_id DROP NOT NULL;
        END IF;
      END $$;
    `);
  }
}
