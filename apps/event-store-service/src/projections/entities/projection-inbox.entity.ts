import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { BigIntTransformer } from '../../event-store/transformers/bigint.transformer';

/**
 * Idempotency ledger for projection handlers.
 *
 * Each row means "projectionName has applied eventId for tenantId".
 * The unique constraint is the projection-side inbox: if a process crashes
 * after applying a handler but before checkpoint state is refreshed in memory,
 * the next replay sees the inbox row and advances the checkpoint without
 * applying the handler again.
 */
@Entity('projection_inbox', { schema: 'event_store' })
@Index('IDX_projection_inbox_tenant_projection_event', ['tenantId', 'projectionName', 'eventId'], {
  unique: true,
})
@Index('IDX_projection_inbox_tenant_projection_position', [
  'tenantId',
  'projectionName',
  'globalPosition',
])
export class ProjectionInbox {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'varchar', length: 255 })
  projectionName!: string;

  @Column({ type: 'uuid' })
  eventId!: string;

  @Column({ type: 'bigint', transformer: new BigIntTransformer() })
  globalPosition!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  processedAt!: Date;
}
