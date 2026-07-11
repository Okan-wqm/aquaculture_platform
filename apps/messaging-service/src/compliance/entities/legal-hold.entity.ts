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
  id!: string;

  @Field()
  @Column({ type: 'uuid' })
  tenantId!: string;

  @Field(() => String, { nullable: true })
  @Column({ type: 'uuid', nullable: true })
  channelId!: string | null;

  /**
   * Reference to the specific legal matter or regulatory request that
   * necessitates this hold. Required for GDPR proportionality -- a hold
   * must be tied to a concrete legal proceeding, not an open-ended freeze.
   * @see MSG-CRITICAL-018 (GDPR proportionality requirement)
   */
  @Field()
  @Column({ type: 'uuid' })
  legalMatterId!: string;

  /**
   * Human-readable description of the legal matter (e.g., case number,
   * regulatory reference). Optional but recommended for audit clarity.
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'text', nullable: true })
  legalMatterDescription!: string | null;

  @Field()
  @Column({ type: 'text' })
  reason!: string;

  /**
   * User or system entity that requested the hold (may differ from startedBy
   * when an admin activates a hold on behalf of legal counsel).
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'uuid', nullable: true })
  requestedBy!: string | null;

  @Field()
  @Column({ type: 'uuid' })
  startedBy!: string;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  startedAt!: Date;

  @Field(() => String, { nullable: true })
  @Column({ type: 'uuid', nullable: true })
  releasedBy!: string | null;

  /**
   * The SECOND SUPER_ADMIN that countersigned the release (dual-approver
   * protocol per LEGAL-MEDIUM-002 cure). NULL while the hold is active;
   * non-NULL on every released hold post-cure.
   *
   * The DB enforces `releasedByApprover IS NULL OR releasedBy <> releasedByApprover`
   * via CHECK constraint `chk_legal_hold_no_self_approval` so a code
   * regression cannot let the same identity self-approve.
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'uuid', nullable: true })
  releasedByApprover!: string | null;

  /**
   * Free-text justification recorded at release time. Required to be
   * ≥ 50 chars by the service layer; column is nullable for backward
   * compatibility with rows released before the dual-approver protocol
   * landed (LEGAL-MEDIUM-002).
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'text', nullable: true })
  releaseReason!: string | null;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  releasedAt!: Date | null;

  /**
   * Optional expiration date for the hold. After this date, the hold should
   * be reviewed and either renewed or released. Prevents indefinite blanket
   * holds that violate GDPR proportionality.
   */
  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @Field()
  @Column({ type: 'boolean', default: true })
  isActive!: boolean;
}
