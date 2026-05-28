import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

@Entity('tenant_isolation_remediation_log')
@Index('idx_tenant_isolation_remediation_log_tenant_created', ['tenantId', 'createdAt'])
export class TenantIsolationRemediationLog {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 128 })
  tableName!: string;

  @Column({ type: 'text' })
  rowId!: string;

  @Column({ type: 'varchar', length: 64 })
  action!: string;

  @Column({ type: 'text' })
  reason!: string;

  @Column({ type: 'jsonb' })
  rowSnapshot!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
