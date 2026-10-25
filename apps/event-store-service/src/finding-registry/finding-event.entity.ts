import { Check, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Persistence envelope of the finding event mirror (MF-2, MF-DESIGN §9 Q2).
 *
 * The finding registry's authority is git: a frozen genesis segment and one
 * append-only event log per finding under docs/reviews/_registry/findings/.
 * This table mirrors those event lines verbatim. `payload` is the git line
 * itself; `event_id`, `finding_id`, `version`, `event_type`, `prev_hash` and
 * `content_hash` are that line's own fields, held equal to it by
 * `finding_events_git_mirror_chk`, so the table keeps no vocabulary of its
 * own; `main_sha` is the origin/main commit the mirror read the line at.
 * Database triggers reject UPDATE, DELETE and TRUNCATE; the one writer is
 * tools/gates/finding-event-ledger.ts `mirror`.
 */
@Entity({ name: 'finding_events', schema: 'event_store' })
@Check('finding_events_version_chk', '"version" > 0')
@Check(
  'finding_events_git_mirror_chk',
  `"payload"->>'event_id' = "event_id"::text AND "payload"->>'finding_id' = "finding_id" AND ("payload"->>'version')::integer = "version" AND "payload"->>'event_type' = "event_type" AND "payload"->>'prev_hash' = "prev_hash" AND "payload"->>'content_hash' = "content_hash"`,
)
@Check('finding_events_main_sha_chk', '"main_sha" ~ \'^[0-9a-f]{40}$\'')
@Check('finding_events_prev_hash_chk', '"prev_hash" ~ \'^[0-9a-f]{64}$\'')
@Check('finding_events_content_hash_chk', '"content_hash" ~ \'^[0-9a-f]{64}$\'')
@Index(['eventId'], { unique: true })
@Index(['findingId', 'version'], { unique: true })
@Index(['contentHash'], { unique: true })
@Index(['mainSha', 'ledgerSeq'])
export class FindingEventEntity {
  @PrimaryGeneratedColumn('increment', {
    name: 'ledger_seq',
    type: 'bigint',
  })
  ledgerSeq!: string;

  @Column({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @Column({ name: 'finding_id', type: 'varchar', length: 80 })
  findingId!: string;

  @Column({ name: 'version', type: 'integer' })
  version!: number;

  @Column({ name: 'event_type', type: 'varchar', length: 32 })
  eventType!: string;

  /** The git event line, verbatim (docs/reviews/_registry/finding-event.schema.json). */
  @Column({ name: 'payload', type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ name: 'main_sha', type: 'char', length: 40 })
  mainSha!: string;

  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;

  @Column({ name: 'prev_hash', type: 'char', length: 64 })
  prevHash!: string;

  @Column({ name: 'content_hash', type: 'char', length: 64 })
  contentHash!: string;
}
