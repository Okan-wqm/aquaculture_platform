import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ALERT-CRITICAL-009 / ALERT-CRITICAL-004 / ALERT-MEDIUM-007 — farm-signal
 * incidents can be recorded, and reach a person.
 *
 * 1. `alert_incidents.rule_id` was `uuid NOT NULL` with a FOREIGN KEY to
 *    `alert_rules`, so every farm-signal incident — keyed by a synthetic,
 *    non-uuid identity and owning no AlertRule by design — failed on insert
 *    (22P02). The FK stays (rule-driven incidents keep their referential
 *    integrity); `rule_id` becomes NULLable and a farm-signal incident records
 *    its identity in the new `signal_key` (the event-contracts `signalKey()`).
 *    `CHECK (num_nonnulls(rule_id, signal_key) = 1)` makes "both" and "neither"
 *    impossible. Added NOT VALID then VALIDATEd: existing rows are rule-driven
 *    (rule_id set, signal_key null) and pass; the validation proves it.
 * 2. One OPEN incident per (tenant, signal key) — a partial unique index. Two
 *    concurrent deliveries of the same condition can no longer open two
 *    incidents; the loser of the race bumps the winner's incident.
 * 3. `site_id` (nullable) — the site the farm event named, so escalation can
 *    page the people assigned to that site.
 * 4. At most one default escalation policy per tenant (partial unique index).
 *    The default-policy seeder's ON CONFLICT DO NOTHING relies on it. Any
 *    duplicate defaults left by the pre-index write path collapse to the
 *    newest first.
 *
 * Blue-green safe: only additive DDL (nullable columns, relaxed NOT NULL, a
 * NOT VALID → VALIDATE check, new indexes). No FK, column or type is dropped.
 * UNQUALIFIED table names on purpose: both tables are per-tenant and this
 * migration is replayed into every tenant schema by the provisioner.
 */
export class FarmSignalIncidentDelivery1801200000000 implements MigrationInterface {
  name = 'FarmSignalIncidentDelivery1801200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE alert_incidents ADD COLUMN IF NOT EXISTS signal_key character varying(200)`,
    );
    await queryRunner.query(`ALTER TABLE alert_incidents ADD COLUMN IF NOT EXISTS site_id uuid`);
    // Replay-safe (the provisioner replays this into every tenant schema):
    // relax the column only while it is still NOT NULL in the schema being
    // migrated — `current_schema()` is the head of the pinned search_path.
    await queryRunner.query(
      `DO $$
       BEGIN
         IF EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'alert_incidents'
              AND column_name = 'rule_id'
              AND is_nullable = 'NO'
         ) THEN
           ALTER TABLE alert_incidents ALTER COLUMN rule_id DROP NOT NULL;
         END IF;
       END $$`,
    );

    // PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS: a replay that finds the
    // check already present swallows exactly duplicate_object (42710).
    await queryRunner.query(
      `DO $$
       BEGIN
         ALTER TABLE alert_incidents
           ADD CONSTRAINT "CHK_alert_incidents_rule_xor_signal"
           CHECK (num_nonnulls(rule_id, signal_key) = 1) NOT VALID;
       EXCEPTION
         WHEN duplicate_object THEN NULL;
       END $$`,
    );
    await queryRunner.query(
      `ALTER TABLE alert_incidents VALIDATE CONSTRAINT "CHK_alert_incidents_rule_xor_signal"`,
    );

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_incidents_open_signal
         ON alert_incidents (tenant_id, signal_key)
      WHERE signal_key IS NOT NULL
        AND status IN ('NEW', 'ACKNOWLEDGED', 'INVESTIGATING')`,
    );

    await queryRunner.query(
      `UPDATE escalation_policies AS stale
          SET is_default = false
        WHERE stale.is_default
          AND EXISTS (
            SELECT 1
              FROM escalation_policies AS newer
             WHERE newer.tenant_id = stale.tenant_id
               AND newer.is_default
               AND (newer.created_at, newer.id) > (stale.created_at, stale.id)
          )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_escalation_policies_tenant_default
         ON escalation_policies (tenant_id)
      WHERE is_default = true`,
    );
  }

  /**
   * Reverses the DDL. Restoring `rule_id NOT NULL` REFUSES while any
   * farm-signal incident exists (its rule_id is NULL) — the down path will not
   * silently delete alarms.
   */
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_escalation_policies_tenant_default`);
    await queryRunner.query(`DROP INDEX IF EXISTS uq_alert_incidents_open_signal`);
    await queryRunner.query(
      `ALTER TABLE alert_incidents DROP CONSTRAINT IF EXISTS "CHK_alert_incidents_rule_xor_signal"`,
    );
    await queryRunner.query(
      `DO $$
       BEGIN
         IF EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'alert_incidents'
              AND column_name = 'rule_id'
              AND is_nullable = 'YES'
         ) THEN
           ALTER TABLE alert_incidents ALTER COLUMN rule_id SET NOT NULL;
         END IF;
       END $$`,
    );
    await queryRunner.query(`ALTER TABLE alert_incidents DROP COLUMN IF EXISTS site_id`);
    await queryRunner.query(`ALTER TABLE alert_incidents DROP COLUMN IF EXISTS signal_key`);
  }
}
