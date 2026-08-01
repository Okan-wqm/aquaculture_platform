import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export enum TenantErasureOperationStatus {
  IN_PROGRESS = 'IN_PROGRESS',
  BLOCKED = 'BLOCKED',
  FAILED = 'FAILED',
  COMPLETED = 'COMPLETED',
}

@Entity({ schema: 'admin', name: 'tenant_erasure_operations', synchronize: false })
@Index('idx_tenant_erasure_operations_tenant_status', ['tenantId', 'status'])
@Index('idx_tenant_erasure_operations_status', ['status'])
@Index('idx_tenant_erasure_operations_schema_job', ['schemaDeletionJobId'])
export class TenantErasureOperation {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 32 })
  status!: TenantErasureOperationStatus;

  @Column({ type: 'varchar', length: 255 })
  requestedBy!: string;

  @Column({ type: 'varchar', length: 500 })
  reason!: string;

  @Column({ type: 'timestamptz' })
  requestedAt!: Date;

  @Column({ type: 'timestamptz' })
  legalHoldCheckedAt!: Date;

  @Column({ type: 'boolean' })
  dryRun!: boolean;

  @Column({ type: 'text', array: true })
  targetServices!: string[];

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  proofs!: Record<string, unknown>;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  failures!: unknown[];

  @Column({ type: 'varchar', length: 255, nullable: true })
  proofHash!: string | null;

  @Column({ type: 'uuid', nullable: true })
  schemaDeletionJobId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  schemaDeletionRequestedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  schemaDeletedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
