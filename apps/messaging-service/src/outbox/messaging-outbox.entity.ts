import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * Transactional outbox for guaranteed event delivery.
 * Message INSERT + outbox INSERT occur in the same DB transaction.
 * A background worker polls unpublished rows and publishes to NATS.
 */
@Entity('messaging_outbox')
@Index('idx_outbox_poll', ['createdAt'], {
  where: '"publishedAt" IS NULL',
})
export class MessagingOutbox {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ type: 'varchar', length: 100 })
  eventType: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @Column({ type: 'integer', default: 0 })
  retryCount: number;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;
}
