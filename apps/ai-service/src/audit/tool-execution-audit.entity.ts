import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('tool_execution_audit', { schema: 'ai' })
@Index(['tenantId', 'executedAt'])
@Index(['toolName', 'executedAt'])
export class ToolExecutionAudit {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 100 })
  toolName!: string;

  @Column({ type: 'varchar', length: 50 })
  persona!: string;

  @Column({ type: 'jsonb' })
  input!: Record<string, unknown>;

  @Column({ type: 'boolean' })
  success!: boolean;

  /**
   * Legacy payload column — rows written before PR-T1 only. New rows leave it
   * NULL: this table is cross-tenant (schema `ai`), so it must not hold tenant
   * business data (K7 / V-T1b-6). It stays mapped because the table is an
   * append-only protected audit trail: its columns are not dropped.
   */
  @Column({ type: 'jsonb', nullable: true })
  output?: Record<string, unknown>;

  /** sha256 (hex) of the serialized tool output — proves WHAT was returned without storing it. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  outputSha256?: string;

  /** UTF-8 byte size of the serialized tool output. */
  @Column({ type: 'int', nullable: true })
  outputBytes?: number;

  @Column({ type: 'text', nullable: true })
  errorMessage?: string;

  @Column({ type: 'int' })
  durationMs!: number;

  @Column({ type: 'varchar', length: 100, nullable: true })
  correlationId?: string;

  @Column({ type: 'uuid', nullable: true })
  conversationId?: string;

  @CreateDateColumn({ name: 'executed_at' })
  executedAt!: Date;
}
