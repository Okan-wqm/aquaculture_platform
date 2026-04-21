import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * SchemaObjectHistory — SOC2 change-management audit trail for DDL.
 * ============================================================================
 *
 * Every DDL mutation the platform emits lands here: CREATE / ALTER / DROP
 * on tables, columns, indexes, constraints, enums, policies. Consumers:
 *
 *   - SOC2 CC8.1 change-management evidence (7-year retention per ADR-024)
 *   - "When did this column exist?" forensic queries — tied to a
 *     migration name via `actor`
 *   - Phase 4 PR-gate diff rendering (post-migration snapshot hash vs
 *     pre-migration hash, both persisted here with the migration name
 *     that caused the transition)
 *
 * # Event sources
 *
 * Lifecycle hooks in the db-migrate orchestrator (Phase 6) emit a row
 * per DDL statement parsed from each migration's log(). TypeORM's
 * `synchronize=true` in dev is the other source, tagged
 * `actor='typeorm-synchronize:<service>'`. Manual DB patches are
 * detected via a boot-time reconciler that diffs introspectSchema()
 * against the latest stored snapshot — any delta it attributes to
 * `actor='manual:<detected-at-boot>'` and emits.
 *
 * # schema_snapshot_hash — deterministic introspector output
 *
 * sha256(JSON.stringify(introspectSchema(qr, schema))) at time of the
 * DDL event. Identical snapshots produce identical hashes by design
 * (introspector is deterministic — see pg-catalog-introspector.ts
 * docblock). Two consecutive rows with the same hash mean the DDL
 * was a no-op; divergence means the schema actually moved.
 *
 * # Retention
 *
 * 7 years — SOC2 CC8.1 change-management requires evidence of every
 * schema change for the full audit cycle. Enforced by scheduled
 * retention job (Phase 9), NOT this migration.
 *
 * # Why NOT a single events table with migration_events
 *
 * migration_events tracks the MIGRATION LIFECYCLE (start, applied,
 * failed). schema_object_history tracks the SCHEMA OBJECTS those
 * migrations mutate. Different retention (13mo vs 7yr), different
 * query patterns (by service vs by schema/object), different
 * authoring sources (orchestrator vs reconciler). Separate tables
 * keep the indexes selective.
 */
@Entity('schema_object_history', { schema: 'observability' })
@Index('IDX_schema_object_history_schema_object_time', [
  'schemaName',
  'objectType',
  'objectName',
  'observedAt',
])
@Index('IDX_schema_object_history_actor_time', ['actor', 'observedAt'])
export class SchemaObjectHistoryEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'timestamptz', name: 'observed_at' })
  observedAt!: Date;

  /** Source schema this DDL targets (e.g. `hr`, `farm`, `shared`). */
  @Column({ type: 'varchar', length: 64, name: 'schema_name' })
  schemaName!: string;

  @Column({
    type: 'enum',
    enum: ['table', 'column', 'index', 'constraint', 'enum', 'policy'],
    enumName: 'schema_object_type_enum',
    name: 'object_type',
  })
  objectType!: 'table' | 'column' | 'index' | 'constraint' | 'enum' | 'policy';

  /**
   * Fully-qualified object name in its schema. For tables: `employees`.
   * For columns: `employees.national_id`. For indexes: index name.
   * For enums: enum type name. For policies: policy name with table
   * suffix (e.g. `tenant_scope@employees`).
   */
  @Column({ type: 'varchar', length: 256, name: 'object_name' })
  objectName!: string;

  @Column({
    type: 'enum',
    enum: ['created', 'altered', 'dropped', 'renamed'],
    enumName: 'schema_object_action_enum',
  })
  action!: 'created' | 'altered' | 'dropped' | 'renamed';

  /**
   * sha256 of the normalized introspectSchema() output for the target
   * schema AFTER the DDL applied. 64-char lowercase hex. Nullable for
   * pre-Phase-0 backfill rows where the snapshot was not captured.
   */
  @Column({
    type: 'varchar',
    length: 64,
    name: 'schema_snapshot_hash',
    nullable: true,
  })
  schemaSnapshotHash!: string | null;

  /**
   * Attribution string identifying WHO emitted the DDL:
   *   - `db-migrate:<migration-name>` (canonical path)
   *   - `typeorm-synchronize:<service>` (dev)
   *   - `manual:<detected-at-boot>` (unattributed — flagged by reconciler)
   */
  @Column({ type: 'varchar', length: 256 })
  actor!: string;

  /** Free-form JSONB with before/after excerpts (column type, etc). */
  @Column({ type: 'jsonb', name: 'detail', nullable: true })
  detail!: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 32 })
  environment!: string;
}
