import { Entity, PrimaryGeneratedColumn } from 'typeorm';

// Semantic fixture TP: `outbox_events` is in
// MODULE_SCHEMAS['farm'].infrastructureTables in the real SSoT — a
// cross-tenant infrastructure table MUST declare a literal `schema:` even in a
// tenant-scoped service. The adapter must keep flagging this omission.
@Entity('outbox_events')
export class OutboxEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;
}
