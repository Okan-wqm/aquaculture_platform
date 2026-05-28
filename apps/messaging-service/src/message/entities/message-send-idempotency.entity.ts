import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

@Entity('message_send_idempotency')
@Index('idx_message_send_idempotency_message', ['tenantId', 'messageId', 'messageCreatedAt'])
export class MessageSendIdempotency {
  @PrimaryColumn({ type: 'uuid' })
  tenantId!: string;

  @PrimaryColumn({ type: 'uuid' })
  channelId!: string;

  @PrimaryColumn({ type: 'uuid' })
  senderId!: string;

  @PrimaryColumn({ type: 'uuid' })
  idempotencyKey!: string;

  @Column({ type: 'uuid' })
  messageId!: string;

  @Column({ type: 'timestamptz' })
  messageCreatedAt!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
