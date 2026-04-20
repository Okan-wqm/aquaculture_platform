import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('sensor_audit_logs', { schema: 'sensor' })
@Index(['tenantId', 'entityType', 'entityId'])
@Index(['tenantId', 'changedAt'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  @Index()
  tenantId!: string;

  @Column({ name: 'entity_type', type: 'varchar', length: 100 })
  entityType!: string;

  @Column({ name: 'entity_id', type: 'uuid' })
  entityId!: string;

  @Column({ type: 'varchar', length: 20 })
  action!: 'INSERT' | 'UPDATE' | 'DELETE';

  @Column({ name: 'previous_value', type: 'jsonb', nullable: true })
  previousValue?: Record<string, unknown>;

  @Column({ name: 'new_value', type: 'jsonb', nullable: true })
  newValue?: Record<string, unknown>;

  @Column({ name: 'changed_fields', type: 'jsonb', nullable: true })
  changedFields?: string[];

  @Column({ name: 'changed_by', type: 'uuid', nullable: true })
  changedBy?: string;

  @CreateDateColumn({ name: 'changed_at' })
  changedAt!: Date;
}
