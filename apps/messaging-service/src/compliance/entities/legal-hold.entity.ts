import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { ObjectType, Field, ID } from '@nestjs/graphql';

/**
 * Legal hold entity — prevents deletion/anonymisation of messages within scope.
 *
 * When channelId is null, the hold covers the entire tenant.
 * When channelId is set, only that channel is under hold.
 *
 * While active, messages in scope CANNOT be deleted even by GDPR anonymise
 * or retention cleanup.
 *
 * @see ADR-012 Phase 3 (Compliance — Legal Hold Support)
 */
@ObjectType()
@Entity('legal_holds')
@Index('idx_legal_hold_tenant_active', ['tenantId', 'isActive'])
@Index('idx_legal_hold_channel', ['channelId'], { where: '"isActive" = true' })
export class LegalHold {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column({ type: 'uuid' })
  tenantId: string;

  @Field(() => String, { nullable: true })
  @Column({ type: 'uuid', nullable: true })
  channelId: string | null;

  @Field()
  @Column({ type: 'text' })
  reason: string;

  @Field()
  @Column({ type: 'uuid' })
  startedBy: string;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  startedAt: Date;

  @Field(() => String, { nullable: true })
  @Column({ type: 'uuid', nullable: true })
  releasedBy: string | null;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  releasedAt: Date | null;

  @Field()
  @Column({ type: 'boolean', default: true })
  isActive: boolean;
}
