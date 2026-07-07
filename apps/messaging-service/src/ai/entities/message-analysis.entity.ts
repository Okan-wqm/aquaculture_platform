/**
 * @module MessageAnalysis
 * @description AI analysis result entity for messages. Stores sentiment scores,
 * entity extractions, and topic classifications. Uses composite FK to the
 * partitioned messages table.
 * @see ADR-012 section 12.2 (Sentiment Analysis Architecture)
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  Check,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import { Message } from '../../message/entities/message.entity';

/**
 * Types of AI analysis that can be performed on a message.
 */
export enum AnalysisType {
  SENTIMENT = 'sentiment',
  ENTITY = 'entity',
  TOPIC = 'topic',
}

registerEnumType(AnalysisType, { name: 'AnalysisType' });

/**
 * Sentiment analysis result structure stored in the JSONB `result` column.
 */
export interface SentimentResult {
  label: 'POSITIVE' | 'NEGATIVE';
  score: number;
  confidence: number;
}

/**
 * Entity extraction result structure stored in the JSONB `result` column.
 */
export interface EntityResult {
  entities: Array<{
    text: string;
    type: string;
    entityId: string;
  }>;
}

/**
 * Topic classification result structure stored in the JSONB `result` column.
 */
export interface TopicResult {
  topics: string[];
  confidence: number[];
}

@ObjectType()
@Entity('message_analysis')
@Check(`"analysisType" IN ('sentiment', 'entity', 'topic')`)
@Index('idx_analysis_message', ['messageId'])
@Index('idx_analysis_type', ['analysisType', 'analyzedAt'])
@Index('idx_analysis_tenant', ['tenantId'])
export class MessageAnalysis {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Tenant identifier — backfilled from parent message in migration
   * 1782300000000-AddTenantIdToMessageChildren. Required for
   * tenant_isolation_policy RLS predicate (ADR-011).
   */
  @Column({ type: 'uuid' })
  tenantId!: string;

  @Field()
  @Column({ type: 'uuid' })
  messageId!: string;

  @Field()
  @Column({ type: 'timestamptz' })
  messageCreatedAt!: Date;

  @Field(() => AnalysisType)
  @Column({ type: 'varchar', length: 20 })
  analysisType!: AnalysisType;

  @Field(() => String, { description: 'JSONB analysis result' })
  @Column({ type: 'jsonb' })
  result!: SentimentResult | EntityResult | TopicResult;

  @Field()
  @Column({ type: 'varchar', length: 64 })
  modelVersion!: string;

  @Field()
  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  analyzedAt!: Date;

  @ManyToOne(() => Message, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'messageId', referencedColumnName: 'id' },
    { name: 'messageCreatedAt', referencedColumnName: 'createdAt' },
  ])
  message!: Message;
}
