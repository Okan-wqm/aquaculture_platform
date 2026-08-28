import { Check, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import type {
  FindingEventPayloadMap,
  FindingEventType,
} from '@aquaculture/backend-common/finding-registry';

/**
 * Persistence envelope for the immutable finding event ledger.
 *
 * Business state is never stored as a mutable row. It is rebuilt from the
 * ordered events for one stable finding_id. Database triggers reject UPDATE,
 * DELETE, and TRUNCATE; FindingRegistryService is the only write path.
 */
@Entity({ name: 'finding_events', schema: 'event_store' })
@Check('finding_events_version_chk', '"version" > 0')
@Check(
  'finding_events_event_type_chk',
  `"event_type" IN ('CREATED', 'EVIDENCE_ADDED', 'OWNER_ASSIGNED', 'STATE_TRANSITIONED', 'SUPERSEDED')`,
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
  eventType!: FindingEventType;

  @Column({ name: 'payload', type: 'jsonb' })
  payload!: FindingEventPayloadMap[FindingEventType];

  @Column({ name: 'main_sha', type: 'char', length: 40 })
  mainSha!: string;

  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;

  @Column({ name: 'prev_hash', type: 'char', length: 64 })
  prevHash!: string;

  @Column({ name: 'content_hash', type: 'char', length: 64 })
  contentHash!: string;
}
