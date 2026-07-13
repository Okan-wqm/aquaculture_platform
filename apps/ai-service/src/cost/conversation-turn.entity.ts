import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * ConversationTurn — the durable per-invocation AI cost ledger
 * (DB-PEOPLE-MEDIUM-002 / ORPHAN-MEDIUM-380).
 *
 * WHY: cost enforcement previously rode ONLY the ephemeral Redis counter
 * (`ai:tokens:{tenantId}:{YYYY-MM}`, TokenBudgetService) plus the mutable
 * aggregate `agent_conversations.totalTokens`. Neither is a record: the Redis
 * key expires ~48h after month end and the aggregate is overwritten in place,
 * so BYOK cost caps, finance reconciliation, and safety forensics had no
 * durable per-turn evidence. This table is the append-only ledger the
 * layer-1-ai knowledge SSoT specifies for `ai.conversation_turns`.
 *
 * IMMUTABILITY: append-only BY CONSTRUCTION at the service layer —
 * TurnLedgerService exposes only an append operation (no update/delete
 * methods exist anywhere in the codebase for this entity). Corrections are
 * new rows, never edits.
 *
 * SCHEMA DISCIPLINE (ADR-011): PER-TENANT table in a tenant-scoped service —
 * `schema:` is intentionally OMITTED so search_path routes rows into
 * `tenant_<uuid>` at runtime. The table is declared in MODULE_SCHEMAS['ai']
 * .tables (schema-manager.service.ts) so tenant fan-out clones it and
 * strictOwnership does not DROP it from the source `ai` schema.
 */
@Entity('conversation_turns')
@Index(['tenantId', 'createdAt'])
@Index(['tenantId', 'conversationId'])
export class ConversationTurn {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  /**
   * FK-style reference to agent_conversations.id — intentionally NOT a real
   * foreign key: the ledger must outlive conversation deletion (GDPR erasure
   * removes chat CONTENT; aggregate token counts in this ledger are not PII
   * and remain for finance reconciliation), and per-tenant clones cannot
   * carry cross-schema constraints anyway.
   */
  @Column({ type: 'uuid' })
  conversationId!: string;

  /** Persona identifier (e.g. 'operator-v1'); null for personaless paths. */
  @Column({ type: 'varchar', length: 50, nullable: true })
  personaId?: string | null;

  /** Exact provider model ID the turn ran on (e.g. 'claude-sonnet-5'). */
  @Column({ type: 'varchar', length: 64 })
  model!: string;

  @Column({ type: 'int', default: 0 })
  inputTokens!: number;

  @Column({ type: 'int', default: 0 })
  outputTokens!: number;

  @Column({ type: 'int', default: 0 })
  cacheReadTokens!: number;

  @Column({ type: 'int', default: 0 })
  cacheCreationTokens!: number;

  /**
   * Cost-weighted USD for this turn including cache read AND cache creation
   * classes (model-pricing.ts is the rate SSoT). Postgres `numeric` maps to a
   * string in TypeORM (no float rounding on money — WHY string, not number).
   */
  @Column({ type: 'numeric', precision: 12, scale: 6 })
  costUsd!: string;

  /**
   * Safety-pipeline flags observed on this turn (e.g. input filter pattern
   * names, 'output:pii_redacted'); null when the turn was clean.
   */
  @Column({ type: 'jsonb', nullable: true })
  flaggedCategories?: string[] | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
