/**
 * @module KnowledgeEntry
 * @description Extracted operational knowledge from message history. Created
 * when actionable content is detected (feeding schedules, water quality notes,
 * incident reports). Source message FK uses ON DELETE SET NULL so knowledge
 * persists even after message purge.
 * @see ADR-012 section 12.3 (Knowledge Extraction)
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { ObjectType, Field, ID, Float, registerEnumType } from '@nestjs/graphql';
import { DecimalTransformer } from '@aquaculture/backend-common/database';
import GraphQLJSON from 'graphql-type-json';
import { Message } from '../../message/entities/message.entity';

/**
 * Categories of operational knowledge that can be extracted from messages.
 */
export enum KnowledgeCategory {
  FEEDING_SCHEDULE = 'feeding_schedule',
  WATER_QUALITY_NOTE = 'water_quality_note',
  INCIDENT_REPORT = 'incident_report',
}

registerEnumType(KnowledgeCategory, { name: 'KnowledgeCategory' });

/**
 * Entity reference embedded in knowledge entry JSONB.
 */
export interface KnowledgeEntityRef {
  type: string;
  id: string;
  name: string;
}

@ObjectType()
@Entity('knowledge_entries')
@Index('idx_knowledge_category', ['category', 'createdAt'])
@Index('idx_knowledge_tenant', ['tenantId'])
export class KnowledgeEntry {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Tenant identifier — backfilled from sourceMessageId → messages.tenantId
   * in migration 1782300000000-AddTenantIdToMessageChildren. Rows that
   * were orphaned (sourceMessageId NULL after FK ON DELETE SET NULL)
   * are deleted by that migration; surviving rows always have a tenant.
   * Required for tenant_isolation_policy RLS predicate (ADR-011).
   */
  @Column({ type: 'uuid' })
  tenantId!: string;

  @Field(() => String, { nullable: true })
  @Column({ type: 'uuid', nullable: true })
  sourceMessageId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  sourceMessageCreatedAt!: Date | null;

  @Field(() => KnowledgeCategory)
  @Column({ type: 'varchar', length: 50 })
  category!: KnowledgeCategory;

  @Field()
  @Column({ type: 'text' })
  content!: string;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  entities!: KnowledgeEntityRef[] | null;

  @Field(() => Float)
  // DecimalTransformer: confidence score (0.00-1.00) is used in AI relevance ranking.
  // String comparison of scores produces wrong ordering in knowledge retrieval.
  @Column({ type: 'numeric', precision: 3, scale: 2, default: 1.0, transformer: new DecimalTransformer() })
  confidence!: number;

  @Field(() => String, { nullable: true })
  @Column({ type: 'uuid', nullable: true })
  verifiedBy!: string | null;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @ManyToOne(() => Message, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn([
    { name: 'sourceMessageId', referencedColumnName: 'id' },
    { name: 'sourceMessageCreatedAt', referencedColumnName: 'createdAt' },
  ])
  sourceMessage!: Message | null;
}
