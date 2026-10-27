import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AlignAlertIncidentRuleIdWithEntity1824200000000
 * ============================================================================
 *
 * `alert_incidents.rule_id` becomes text, the way the entity has always
 * declared it (`ruleId: string`), and loses the foreign key to `alert_rules`.
 *
 * # Why
 *
 * The baseline created the column as `uuid NOT NULL` referencing
 * `alert.alert_rules(id)`. Every farm signal — mortality, low stock, water
 * quality, FCR, feed coverage and the feeding-execution signals — identifies
 * its incident by a SYNTHETIC rule key (`system:meal-underfed:<unitId>`,
 * `system:low-stock:feed:<feedId>`…): there is no `alert_rules` row behind a
 * signal the platform raises on its own. Writing such a key to a uuid column
 * fails with "invalid input syntax for type uuid" on the very first query of
 * `FarmSignalIncidentService.ensureIncident`, AFTER the history row was
 * already saved. The event handler rethrows (NAK + backoff), so every
 * redelivery saved one more history row and failed again: four poison
 * messages ran their full 7-day delivery budget on the production tenant and
 * wrote 99,5 thousand `alert_history` rows, and not one incident was ever
 * opened.
 *
 * Rule-driven incidents keep working unchanged: their `rule_id` is the rule's
 * uuid rendered as text. The key is now what it is named — the identity of
 * what fired — and the entity declares it as such (`type: 'varchar'`); the
 * unused `rule` relation that contradicted it is gone with this change.
 *
 * # Foreign key
 *
 * Only the source schema's table carries the constraint (tenant schemas are
 * cloned without foreign keys), so it is dropped wherever it exists, found by
 * what it constrains rather than by name.
 *
 * # Blue-green
 *
 * uuid → text is widening: the running release keeps reading and writing
 * uuid-shaped values (a uuid string is a valid text value) and the new release
 * writes synthetic keys. The type change rewrites the (small) incident table
 * and its indexes under ACCESS EXCLUSIVE, so the migration bounds its own lock
 * wait and statement time: it fails fast instead of queueing behind a live
 * alarm transaction, and the deploy stops with the table as it was.
 *
 * Table and constraint names are UNQUALIFIED: the migration is replayed into
 * every tenant schema (and the source schema) with the search_path pinned.
 */
export class AlignAlertIncidentRuleIdWithEntity1824200000000 implements MigrationInterface {
  name = 'AlignAlertIncidentRuleIdWithEntity1824200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    await queryRunner.query(
      `DO $$
       DECLARE
         fk text;
       BEGIN
         FOR fk IN
           SELECT con.conname
             FROM pg_constraint con
            WHERE con.conrelid = to_regclass('alert_incidents')
              AND con.contype = 'f'
              AND con.conkey = ARRAY[
                (SELECT att.attnum FROM pg_attribute att
                  WHERE att.attrelid = con.conrelid AND att.attname = 'rule_id')
              ]
         LOOP
           EXECUTE format('ALTER TABLE alert_incidents DROP CONSTRAINT IF EXISTS %I', fk);
         END LOOP;
       END $$`,
    );

    await queryRunner.query(
      `DO $$
       BEGIN
         IF EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'alert_incidents'
              AND column_name = 'rule_id'
              AND data_type = 'uuid'
         ) THEN
           ALTER TABLE alert_incidents ALTER COLUMN rule_id TYPE character varying USING rule_id::text;
         END IF;
       END $$`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);
    // Narrowing back is only possible while every key is still a uuid: a farm
    // signal incident cannot be represented in the old column, and deleting
    // incident history to fit it is not a rollback.
    await queryRunner.query(
      `DO $$
       BEGIN
         IF EXISTS (
           SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'alert_incidents'
              AND column_name = 'rule_id'
              AND data_type = 'character varying'
         ) THEN
           IF EXISTS (
             SELECT 1 FROM alert_incidents
              WHERE rule_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           ) THEN
             RAISE EXCEPTION 'alert_incidents holds farm-signal rule keys that are not uuids; refusing to narrow rule_id';
           END IF;
           ALTER TABLE alert_incidents ALTER COLUMN rule_id TYPE uuid USING rule_id::uuid;
         END IF;
       END $$`,
    );
  }
}
