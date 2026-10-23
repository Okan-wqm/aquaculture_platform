import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One time an administrator took an escrowed envelope out of the cloud
 * (ADR-048 DEC-14.3): who, which envelope of which device, when, and the reason they
 * gave. A row is written in the same transaction that reads the envelope, so an
 * envelope that left the cloud always has its row, and it is never edited or deleted by
 * any service path: the record of who could have opened a volume's recovery.
 *
 * Per-tenant table — no `schema:` (ADR-011 search_path routing).
 */
@Entity('recovery_key_escrow_retrievals')
@Index('idx_recovery_key_escrow_retrievals_device', ['tenantId', 'deviceId', 'retrievedAt'])
export class RecoveryKeyEscrowRetrieval {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'escrow_id' })
  escrowId!: string;

  @Column({ type: 'uuid', name: 'device_id' })
  deviceId!: string;

  /** The authenticated user (JWT subject) who retrieved it. */
  @Column({ type: 'varchar', length: 128, name: 'retrieved_by' })
  retrievedBy!: string;

  @Column({ type: 'varchar', length: 256 })
  reason!: string;

  @CreateDateColumn({ name: 'retrieved_at', type: 'timestamptz' })
  retrievedAt!: Date;
}
