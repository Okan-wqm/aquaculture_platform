import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('agent_conversations')
@Index(['tenantId', 'userId', 'createdAt'])
export class AgentConversation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 50 })
  persona!: string;

  @Column({ type: 'jsonb' })
  messages!: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
    toolUse?: Array<{ name: string; input: Record<string, unknown>; result: unknown }>;
    timestamp: string;
  }>;

  @Column({ type: 'varchar', length: 255, nullable: true })
  title?: string;

  @Column({ type: 'int', default: 0 })
  totalTokens!: number;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
