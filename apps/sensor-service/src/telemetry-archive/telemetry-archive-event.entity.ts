import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity('telemetry_archive_events', { schema: 'sensor' })
@Unique('UQ_telemetry_archive_operation_state', ['operationId', 'state'])
@Index('IDX_telemetry_archive_tenant_range', ['tenantId', 'rangeStart', 'rangeEnd'])
@Check(
  'CHK_telemetry_archive_state',
  `"state" IN ('EXPORT_STARTED', 'EXPORTED', 'VERIFIED', 'DROPPED', 'FAILED')`,
)
@Check('CHK_telemetry_archive_range', `"range_start" < "range_end"`)
@Check('CHK_telemetry_archive_sha256', `"sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'`)
export class TelemetryArchiveEvent {
  @PrimaryGeneratedColumn('uuid', { name: 'event_id' })
  eventId!: string;

  @Column({ name: 'operation_id', type: 'uuid' })
  operationId!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 20 })
  state!: string;

  @Column({ name: 'range_start', type: 'timestamptz' })
  rangeStart!: Date;

  @Column({ name: 'range_end', type: 'timestamptz' })
  rangeEnd!: Date;

  @Column({ name: 'supersedes_operation_id', type: 'uuid', nullable: true })
  supersedesOperationId!: string | null;

  @Column({ name: 'object_key', type: 'text', nullable: true })
  objectKey!: string | null;

  @Column({ name: 'row_count', type: 'bigint', nullable: true })
  rowCount!: string | null;

  @Column({ type: 'char', length: 64, nullable: true })
  sha256!: string | null;

  @Column({ name: 'schema_version', type: 'integer', nullable: true })
  schemaVersion!: number | null;

  @Column({ name: 'snapshot_id', type: 'text', nullable: true })
  snapshotId!: string | null;

  @Column({ name: 'wal_lsn', type: 'text', nullable: true })
  walLsn!: string | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @Column({ name: 'bucket_name', type: 'text', nullable: true })
  bucketName!: string | null;

  @Column({ name: 'object_version_id', type: 'text', nullable: true })
  objectVersionId!: string | null;

  @Column({ name: 'archive_format', type: 'varchar', length: 10, nullable: true })
  archiveFormat!: string | null;

  @Column({ name: 'min_time', type: 'timestamptz', nullable: true })
  minTime!: Date | null;

  @Column({ name: 'max_time', type: 'timestamptz', nullable: true })
  maxTime!: Date | null;

  @CreateDateColumn({ name: 'recorded_at', type: 'timestamptz' })
  recordedAt!: Date;
}
