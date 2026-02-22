import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('tool_execution_audit')
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

  @Column({ type: 'jsonb', nullable: true })
  output?: Record<string, unknown>;

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
