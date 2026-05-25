import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum HrMobileCommandReceiptStatus {
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
}

@Entity('hr_mobile_command_receipts')
@Index('idx_hr_mobile_command_receipts_tenant_command', ['tenantId', 'clientCommandId'], { unique: true })
@Index('idx_hr_mobile_command_receipts_tenant_status', ['tenantId', 'status'])
export class HrMobileCommandReceipt {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  tenantId!: string;

  @Column('uuid')
  clientCommandId!: string;

  @Column({ type: 'varchar', length: 128 })
  payloadHash!: string;

  @Column({ type: 'varchar', length: 80 })
  operationType!: string;

  @Column({ type: 'uuid', nullable: true })
  deviceId?: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  clientCreatedAt?: Date | null;

  @Column({
    type: 'varchar',
    length: 20,
    default: HrMobileCommandReceiptStatus.IN_PROGRESS,
  })
  status!: HrMobileCommandReceiptStatus;

  @Column({ type: 'varchar', length: 120, nullable: true })
  responseType?: string | null;

  @Column({ type: 'uuid', nullable: true })
  responseId?: string | null;

  @Column({ type: 'jsonb', nullable: true })
  responsePayload?: unknown;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
