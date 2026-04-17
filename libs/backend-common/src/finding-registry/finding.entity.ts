import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * FindingEntity — Phase 12.1 completion piece.
 *
 * TypeORM mapping for `event_store.findings` (migration
 * apps/event-store-service/src/migrations/1800000000000-AddFindingsTable.ts).
 *
 * The table is IMMUTABLE — UPDATE and DELETE are blocked at the
 * DB layer by trigger. All state mutations (OPEN → IN-PROGRESS →
 * RESOLVED) land as NEW append-only rows that reference the parent
 * via `supersedesId`; the `findings_id_unique` constraint ONLY
 * applies to `id`, so state-transition rows must either carry a
 * distinct id (e.g., `<id>#state-<seq>`) or this entity's
 * FindingRegistryService must serialize them via advisory lock
 * + UPSERT-by-content-hash.
 *
 * The canonical mutation path is the FindingRegistryService class;
 * direct writes via this entity bypass the hash-chain discipline
 * and will trip the immutability trigger.
 */
@Entity({ name: 'findings', schema: 'event_store' })
@Index(['state'])
@Index(['severity', 'state'])
@Index(['ownerAgent', 'state'])
@Index(['createdAt'])
export class FindingEntity {
  /**
   * Monotonic chain sequence — primary key. Advisory-lock-serialized
   * BIGSERIAL. NOT the finding's business id.
   */
  @PrimaryGeneratedColumn('increment', {
    name: 'chain_seq',
    type: 'bigint',
  })
  chainSeq!: string;

  /** Business id — canonical `{PREFIX}-{SEVERITY}-{NNN}`. Unique. */
  @Column({ name: 'id', type: 'varchar', length: 64, unique: true })
  id!: string;

  @Column({ name: 'severity', type: 'varchar', length: 16 })
  severity!: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

  @Column({ name: 'state', type: 'varchar', length: 16 })
  state!: 'OPEN' | 'IN-PROGRESS' | 'RESOLVED' | 'STALE' | 'BLOCKED';

  @Column({ name: 'title', type: 'text' })
  title!: string;

  @Column({ name: 'layer', type: 'smallint' })
  layer!: 1 | 2 | 3 | 4;

  @Column({ name: 'owner_agent', type: 'varchar', length: 128 })
  ownerAgent!: string;

  @Column({ name: 'raised_in_cycle', type: 'varchar', length: 256 })
  raisedInCycle!: string;

  @Column({ name: 'review_file', type: 'text', nullable: true })
  reviewFile?: string | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamptz',
  })
  createdAt!: Date;

  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt?: Date | null;

  @Column({
    name: 'closing_commits',
    type: 'text',
    array: true,
    default: () => "ARRAY[]::text[]",
  })
  closingCommits!: string[];

  @Column({ name: 'deadline', type: 'timestamptz', nullable: true })
  deadline?: Date | null;

  @Column({ name: 'owner_user', type: 'varchar', length: 128, nullable: true })
  ownerUser?: string | null;

  @Column({ name: 'override_of', type: 'varchar', length: 64, nullable: true })
  overrideOf?: string | null;

  @Column({ name: 'notes', type: 'text', nullable: true })
  notes?: string | null;

  @Column({ name: 'evidence', type: 'jsonb', default: () => "'[]'::jsonb" })
  evidence!: Array<string | Record<string, unknown>>;

  @Column({ name: 'rule_violated', type: 'varchar', length: 256, nullable: true })
  ruleViolated?: string | null;

  /** Phase 13 cross-lane merge support. */
  @Column({
    name: 'origin_findings',
    type: 'text',
    array: true,
    default: () => "ARRAY[]::text[]",
  })
  originFindings!: string[];

  @Column({ name: 'supersedes_id', type: 'varchar', length: 64, nullable: true })
  supersedesId?: string | null;

  /** Hash-chain — `prev_hash` points to previous row's `contentHash`. */
  @Column({ name: 'prev_hash', type: 'char', length: 64 })
  prevHash!: string;

  /** Hash-chain — sha256(canonical JSON of row minus contentHash). */
  @Column({ name: 'content_hash', type: 'char', length: 64 })
  contentHash!: string;
}
