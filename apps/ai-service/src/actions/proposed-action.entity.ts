import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A held actuation-class tool call awaiting human confirmation (MOB-HIGH-001,
 * the "Faz 6" human-in-the-loop flow AISAFETY-MEDIUM-017 pointed at).
 *
 * When the agent loop holds a `requiresConfirmation` tool (actuation policy
 * `confirm_required`), the FULL execution intent — tool name, params and the
 * ORIGINAL requester's authorization context — is persisted here and only its
 * id travels through the chat metadata to the client. Confirmation
 * (`request.ai.executeAction`) then executes the STORED row, so a tampered
 * params blob in the confirm path can never change what runs: the proposal row
 * is the single source of truth for the action.
 *
 * Status machine: proposed → executing → completed | failed. The transition
 * out of `proposed` is claimed atomically (UPDATE … WHERE status='proposed'),
 * so double-confirms converge on one execution.
 *
 * PER-TENANT table (ADR-011): no `schema:` in @Entity — registered in
 * MODULE_SCHEMAS['ai'].tables so it is cloned into every tenant_<uuid> schema
 * and strict ownership does not drop it.
 */
@Entity('ai_proposed_actions')
@Index(['tenantId', 'status', 'createdAt'])
export class ProposedAction {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  /** Registry tool name (e.g. 'create_task') — the executable identity. */
  @Column({ type: 'varchar', length: 100 })
  toolName!: string;

  /** The exact tool input held for confirmation. */
  @Column({ type: 'jsonb' })
  params!: Record<string, unknown>;

  /** Human-readable summary shown on the confirmation card. */
  @Column({ type: 'text' })
  description!: string;

  /** The user whose chat turn proposed the action — execution runs AS them. */
  @Column({ type: 'uuid' })
  requestedBy!: string;

  /** Requester's roles at proposal time — re-checked by the executor. */
  @Column({ type: 'jsonb' })
  requesterRoles!: string[];

  @Column({ type: 'varchar', length: 50 })
  persona!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  correlationId?: string;

  @Column({ type: 'varchar', length: 20, default: 'proposed' })
  status!: 'proposed' | 'executing' | 'completed' | 'failed';

  /** Human-readable outcome posted back into the channel. */
  @Column({ type: 'text', nullable: true })
  result?: string;

  @Column({ type: 'uuid', nullable: true })
  confirmedBy?: string;

  @Column({ type: 'timestamp', nullable: true })
  executedAt?: Date;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
