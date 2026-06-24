import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  Unique,
} from 'typeorm';

import { Message } from './message.entity';
import { ReceiptStatus } from './message-receipt.entity';

/**
 * Logical receipt identity ledger.
 *
 * PostgreSQL partitioned `message_receipts` cannot enforce a unique
 * (messageId, userId) constraint without the partition key. This table is the
 * tenant-scoped SSoT for the latest receipt identity; `message_receipts`
 * remains the append/history table.
 */
@Entity('message_receipt_ledger')
@Check(`"status" IN ('delivered', 'read')`)
@Unique('uq_message_receipt_ledger_receipt_identity', [
  'receiptId',
  'receiptCreatedAt',
])
@Index('idx_message_receipt_ledger_message', ['messageId'])
@Index('idx_message_receipt_ledger_user_status', ['userId', 'status'])
export class MessageReceiptLedger {
  @PrimaryColumn({ type: 'uuid' })
  tenantId: string;

  @PrimaryColumn({ type: 'uuid' })
  messageId: string;

  @PrimaryColumn({ type: 'uuid' })
  userId: string;

  @Column({ type: 'timestamptz' })
  messageCreatedAt: Date;

  @Column({ type: 'uuid', default: () => 'gen_random_uuid()' })
  receiptId: string;

  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  receiptCreatedAt: Date;

  @Column({ type: 'varchar', length: 20, default: ReceiptStatus.DELIVERED })
  status: ReceiptStatus;

  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  readAt: Date | null;

  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  createdAt: Date;

  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  updatedAt: Date;

  @ManyToOne(() => Message, { onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn([
    { name: 'messageId', referencedColumnName: 'id' },
    { name: 'messageCreatedAt', referencedColumnName: 'createdAt' },
  ])
  message: Message;
}
