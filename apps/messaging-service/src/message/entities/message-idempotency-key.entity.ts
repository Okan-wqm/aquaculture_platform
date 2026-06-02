import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Durable tenant-scoped idempotency ledger for message sends.
 *
 * Redis may cache/pin in-flight requests, but this table is the DB-owned
 * source of truth for idempotency completion and replay lookup.
 */
@Entity('message_idempotency_keys')
@Index('idx_message_idempotency_keys_message', ['messageId', 'messageCreatedAt'])
export class MessageIdempotencyKey {
  @PrimaryColumn({ type: 'uuid' })
  tenantId: string;

  @PrimaryColumn({ type: 'uuid' })
  idempotencyKey: string;

  @Column({ type: 'uuid', nullable: true })
  messageId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  messageCreatedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
