import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum TenantOnboardingReceiptState {
  PROCESSING = 'PROCESSING',
  ACKNOWLEDGED = 'ACKNOWLEDGED',
  FAILED = 'FAILED',
}

@Entity({ schema: 'farm', name: 'tenant_onboarding_receipts', synchronize: false })
@Index('uk_farm_tenant_onboarding_receipt_operation_attempt', ['operationId', 'attempt'], {
  unique: true,
})
@Index('uk_farm_tenant_onboarding_receipt_request_event', ['requestEventId'], { unique: true })
@Index('idx_farm_tenant_onboarding_receipt_lease', ['state', 'leaseExpiresAt'])
export class TenantOnboardingReceipt {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  operationId!: string;

  @Column({ type: 'integer' })
  attempt!: number;

  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'uuid' })
  requestEventId!: string;

  @Column({ type: 'char', length: 64 })
  requestHash!: string;

  @Column({ type: 'char', length: 64 })
  requestFingerprint!: string;

  @Column({ type: 'varchar', length: 20 })
  state!: TenantOnboardingReceiptState;

  @Column({ type: 'uuid', nullable: true })
  leaseToken!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  leaseExpiresAt!: Date | null;

  @Column({ type: 'integer', default: 1 })
  processingAttempts!: number;

  @Column({ type: 'char', length: 64, nullable: true })
  outcomeHash!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  evidence!: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  updatedAt!: Date;
}
