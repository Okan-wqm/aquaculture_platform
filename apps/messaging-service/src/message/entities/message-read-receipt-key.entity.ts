import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity('message_read_receipt_keys')
export class MessageReadReceiptKey {
  @PrimaryColumn({ type: 'uuid' })
  tenantId!: string;

  @PrimaryColumn({ type: 'uuid' })
  messageId!: string;

  @PrimaryColumn({ type: 'timestamptz' })
  messageCreatedAt!: Date;

  @PrimaryColumn({ type: 'uuid' })
  userId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
