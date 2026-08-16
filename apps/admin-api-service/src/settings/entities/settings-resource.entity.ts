import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export interface EmailTemplateVariable {
  name: string;
  description: string;
  required: boolean;
  defaultValue?: string;
}

@Entity('email_templates', { schema: 'admin' })
@Index(['code'], { unique: true })
@Index(['category'])
export class EmailTemplate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  code!: string;

  @Column()
  name!: string;

  @Column({ nullable: true })
  description?: string;

  @Column()
  category!: string;

  @Column()
  subject!: string;

  @Column('text')
  bodyHtml!: string;

  @Column('text', { nullable: true })
  bodyText?: string;

  @Column('jsonb', { default: '[]' })
  variables!: EmailTemplateVariable[];

  @Column({ default: true })
  isActive!: boolean;

  @Column({ default: false })
  isSystem!: boolean;

  @Column({ nullable: true })
  tenantId?: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column({ nullable: true })
  updatedBy?: string;
}

@Entity('ip_access_rules', { schema: 'admin' })
@Index(['ipAddress'])
@Index(['tenantId'])
@Index(['ruleType'])
export class IpAccessRule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ nullable: true })
  tenantId?: string;

  @Column()
  ipAddress!: string;

  @Column({ type: 'varchar', length: 20 })
  ruleType!: 'whitelist' | 'blacklist';

  @Column({ nullable: true })
  description?: string;

  @Column({ default: true })
  isActive!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt?: Date;

  @Column({ type: 'int', default: 0 })
  hitCount!: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastHitAt?: Date;

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ nullable: true })
  createdBy?: string;
}
