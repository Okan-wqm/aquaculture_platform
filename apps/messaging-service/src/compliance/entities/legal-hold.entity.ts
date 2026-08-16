import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ObjectType, Field, ID } from '@nestjs/graphql';

export const LEGAL_HOLD_REVIEW_DEADLINE_DB_COMMENT =
  'Review deadline only; isActive remains authoritative until an explicit two-person release.';

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
@Index('uq_legal_hold_id_tenant', ['id', 'tenantId'], { unique: true })
@Index('idx_legal_hold_tenant_active', ['tenantId', 'isActive'])
@Index('idx_legal_hold_channel', ['channelId'], { where: '"isActive" = true' })
@Check(
  'chk_legal_hold_no_self_approval',
  '"releasedByApprover" IS NULL OR "releasedByApprover" <> "releasedBy"',
)
@Check(
  'chk_legal_hold_release_reason',
  '"releaseReason" IS NULL OR char_length(btrim("releaseReason")) >= 50',
)
@Check(
  'chk_legal_hold_release_state',
  `(
    "isActive" = true
    AND "releasedBy" IS NULL
    AND "releasedByApprover" IS NULL
    AND "releaseReason" IS NULL
    AND "releasedAt" IS NULL
  ) OR (
    "isActive" = false
    AND "releasedBy" IS NOT NULL
    AND "releasedByApprover" IS NOT NULL
    AND "releaseReason" IS NOT NULL
    AND "releasedAt" IS NOT NULL
  )`,
)
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
   * Free-text justification recorded at release time. The database requires
   * at least 50 characters on every new or updated release. The nullable
   * column keeps pre-protocol history readable while the release-state CHECK
   * prevents a newly active hold from carrying forged release evidence.
   */
  @Field(() => String, { nullable: true })
  @Column({ type: 'text', nullable: true })
  releaseReason!: string | null;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  releasedAt!: Date | null;

  /**
   * Optional review deadline for the hold. Crossing this timestamp never
   * releases or weakens the hold: isActive remains authoritative until the
   * explicit two-person release operation commits. The deadline only makes
   * overdue legal review observable.
   */
  @Field(() => Date, {
    nullable: true,
    description: LEGAL_HOLD_REVIEW_DEADLINE_DB_COMMENT,
  })
  @Column({
    type: 'timestamptz',
    nullable: true,
    comment: LEGAL_HOLD_REVIEW_DEADLINE_DB_COMMENT,
  })
  expiresAt!: Date | null;

  @Field()
  @Column({ type: 'boolean', default: true })
  isActive!: boolean;
}
