/**
 * @module MessageEntityReference
 * @description Junction entity linking messages to domain entities such as
 * tanks, batches, sites, species, or water quality parameters. Created by the
 * knowledge extraction pipeline via regex + NER.
 * @see ADR-012 section 12.3 (Knowledge Extraction)
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  Unique,
  Check,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { ObjectType, Field, ID, Float, registerEnumType } from '@nestjs/graphql';
import { DecimalTransformer } from '@aquaculture/backend-common/database';
import { Message } from '../../message/entities/message.entity';

/**
 * Domain entity types that can be referenced from messages.
 */
export enum DomainEntityType {
  TANK = 'tank',
  BATCH = 'batch',
  SITE = 'site',
  SPECIES = 'species',
  PARAMETER = 'parameter',
}

registerEnumType(DomainEntityType, { name: 'DomainEntityType' });

@ObjectType()
@Entity('message_entity_references')
@Check(`"entityType" IN ('tank', 'batch', 'site', 'species', 'parameter')`)
@Unique('uq_message_entity', ['messageId', 'entityType', 'entityId'])
@Index('idx_entity_refs_entity', ['entityType', 'entityId'])
@Index('idx_entity_refs_message', ['messageId'])
@Index('idx_entity_refs_tenant', ['tenantId'])
export class MessageEntityReference {
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

  @Field(() => DomainEntityType)
  @Column({ type: 'varchar', length: 30 })
  entityType!: DomainEntityType;

  @Field()
  @Column({ type: 'uuid' })
  entityId!: string;

  @Field(() => Float)
  // DecimalTransformer: entity reference confidence score (0.00-1.00) used in AI relevance ranking.
  // String comparison of scores produces wrong ordering in entity disambiguation.
  @Column({ type: 'numeric', precision: 3, scale: 2, default: 1.0, transformer: new DecimalTransformer() })
  confidence!: number;

  @Field()
  @Column({ type: 'timestamptz', default: () => 'NOW()' })
  extractedAt!: Date;

  @ManyToOne(() => Message, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'messageId', referencedColumnName: 'id' },
    { name: 'messageCreatedAt', referencedColumnName: 'createdAt' },
  ])
  message!: Message;
}
