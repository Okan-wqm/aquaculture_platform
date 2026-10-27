import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MF-2 (MF-DESIGN §9 Q2) — `event_store.finding_events` becomes a pure mirror
 * of the git finding event store.
 *
 * The table enumerated its own event vocabulary (CREATED, EVIDENCE_ADDED,
 * OWNER_ASSIGNED, STATE_TRANSITIONED, SUPERSEDED), a second vocabulary beside
 * the registry's in git (docs/reviews/_registry/finding-event.schema.json),
 * which records CLOSURE_REJECTED and AMENDED and can never record RESOLVED.
 * The mirror stores each git event line verbatim in `payload`, so the
 * vocabulary check goes and a mirror check takes its place: every envelope
 * column must equal the field of the line it carries.
 *
 * NOT VALID: the ledger was never wired to a lane, but a row written under the
 * old vocabulary cannot be rewritten (the table is immutable by trigger), so
 * the constraint binds every new row and `finding-event-ledger parity` names
 * any old one as a row the registry does not hold. Additive for readers;
 * blue-green safe (the one writer is the mirror CLI).
 */
export class MirrorGitFindingEvents1801300000000 implements MigrationInterface {
  name = 'MirrorGitFindingEvents1801300000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE event_store.finding_events
        DROP CONSTRAINT IF EXISTS finding_events_event_type_chk
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TABLE event_store.finding_events
          ADD CONSTRAINT finding_events_git_mirror_chk CHECK (
            payload->>'event_id' = event_id::text
            AND payload->>'finding_id' = finding_id
            AND (payload->>'version')::integer = version
            AND payload->>'event_type' = event_type
            AND payload->>'prev_hash' = prev_hash
            AND payload->>'content_hash' = content_hash
          ) NOT VALID;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE event_store.finding_events
        DROP CONSTRAINT IF EXISTS finding_events_git_mirror_chk
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TABLE event_store.finding_events
          ADD CONSTRAINT finding_events_event_type_chk CHECK (
            event_type IN (
              'CREATED',
              'EVIDENCE_ADDED',
              'OWNER_ASSIGNED',
              'STATE_TRANSITIONED',
              'SUPERSEDED'
            )
          ) NOT VALID;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }
}
