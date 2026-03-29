import {
  Entity,
  PrimaryColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  Check,
} from 'typeorm';
import { ObjectType, Field, registerEnumType } from '@nestjs/graphql';
import { Message } from './message.entity';

export enum ReceiptStatus {
  DELIVERED = 'delivered',
  READ = 'read',
}

registerEnumType(ReceiptStatus, { name: 'ReceiptStatus' });

/**
 * Read receipts — partitioned by receipt_created_at (RANGE monthly).
 * TypeORM synchronize=false; migrations only.
 */
@ObjectType()
@Entity('message_receipts')
@Check(`"status" IN ('delivered', 'read')`)
@Index('idx_receipts_user_status', ['userId', 'status'])
@Index('idx_receipts_message', ['messageId'])
export class MessageReceipt {
  @PrimaryColumn({ type: 'uuid', default: () => 'gen_random_uuid()' })
  id: string;

  @Column({ type: 'uuid' })
  messageId: string;

  @Column({ type: 'timestamptz' })
  messageCreatedAt: Date;

  @Field()
  @Column({ type: 'uuid' })
  userId: string;

  @Field(() => ReceiptStatus)
  @Column({ type: 'varchar', length: 20, default: ReceiptStatus.DELIVERED })
  status: ReceiptStatus;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt: Date | null;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  readAt: Date | null;

  @PrimaryColumn({ type: 'timestamptz', default: () => 'NOW()' })
  receiptCreatedAt: Date;

  @ManyToOne(() => Message, (msg) => msg.receipts, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'messageId', referencedColumnName: 'id' },
    { name: 'messageCreatedAt', referencedColumnName: 'createdAt' },
  ])
  message: Message;
}
