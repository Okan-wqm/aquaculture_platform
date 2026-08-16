import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

import type { AdminLegalHoldReleaseOperationStatusV1 } from '@platform/admin-http-contracts';

import { LegalHold } from './legal-hold.entity';

/**
 * Durable two-person control record for releasing a legal hold.
 *
 * A release is never inferred from a browser-supplied approver id. One
 * authenticated SUPER_ADMIN creates this operation and another authenticated
 * SUPER_ADMIN authorizes it with a fresh MFA-bearing token. The authorization
 * transition and the legal-hold mutation are committed in one transaction.
 */
@Entity('legal_hold_release_operations')
@Index('idx_legal_hold_release_operation_tenant_created', ['tenantId', 'initiatedAt'])
@Index('uq_legal_hold_release_operation_initiation_request', ['tenantId', 'initiationRequestId'], {
  unique: true,
})
@Index(
  'uq_legal_hold_release_operation_authorization_request',
  ['tenantId', 'authorizationRequestId'],
  {
    unique: true,
    where: '"authorizationRequestId" IS NOT NULL',
  },
)
@Index('uq_legal_hold_release_operation_pending_hold', ['tenantId', 'holdId'], {
  unique: true,
  where: '"status" = \'PENDING\'',
})
@ForeignKey(() => LegalHold, ['holdId', 'tenantId'], ['id', 'tenantId'], {
  name: 'fk_legal_hold_release_operation_hold',
  onDelete: 'RESTRICT',
})
@Check(
  'chk_legal_hold_release_operation_status',
  "\"status\" IN ('PENDING', 'RELEASED', 'EXPIRED')",
)
@Check(
  'chk_legal_hold_release_operation_reason',
  'char_length(btrim("releaseReason")) >= 50 AND char_length("releaseReason") <= 1000',
)
@Check(
  'chk_legal_hold_release_operation_token_evidence',
  `char_length(btrim("initiatorTokenId")) > 0
   AND ("approverTokenId" IS NULL OR char_length(btrim("approverTokenId")) > 0)`,
)
@Check(
  'chk_legal_hold_release_operation_distinct_actors',
  '"authorizedBy" IS NULL OR "authorizedBy" <> "initiatedBy"',
)
@Check(
  'chk_legal_hold_release_operation_state',
  `(
    "status" = 'PENDING'
    AND "authorizationRequestId" IS NULL
    AND "authorizedBy" IS NULL
    AND "authorizedAt" IS NULL
    AND "approverMfaVerifiedAt" IS NULL
    AND "approverTokenId" IS NULL
    AND "releasedAt" IS NULL
    AND "expiredAt" IS NULL
    AND "expiredBy" IS NULL
  ) OR (
    "status" = 'EXPIRED'
    AND "authorizationRequestId" IS NULL
    AND "authorizedBy" IS NULL
    AND "authorizedAt" IS NULL
    AND "approverMfaVerifiedAt" IS NULL
    AND "approverTokenId" IS NULL
    AND "releasedAt" IS NULL
    AND "expiredAt" IS NOT NULL
    AND "expiredBy" IS NOT NULL
  ) OR (
    "status" = 'RELEASED'
    AND "authorizationRequestId" IS NOT NULL
    AND "authorizedBy" IS NOT NULL
    AND "authorizedAt" IS NOT NULL
    AND "approverMfaVerifiedAt" IS NOT NULL
    AND "approverTokenId" IS NOT NULL
    AND "releasedAt" IS NOT NULL
    AND "expiredAt" IS NULL
    AND "expiredBy" IS NULL
  )`,
)
@Check(
  'chk_legal_hold_release_operation_temporal_evidence',
  `"expiresAt" > "initiatedAt"
   AND "initiatorMfaVerifiedAt" >= "initiatedAt" - interval '5 minutes'
   AND "initiatorMfaVerifiedAt" <= "initiatedAt" + interval '30 seconds'
   AND (
     "authorizedAt" IS NULL
     OR (
       "approverMfaVerifiedAt" >= "authorizedAt" - interval '5 minutes'
       AND "approverMfaVerifiedAt" <= "authorizedAt" + interval '30 seconds'
       AND "releasedAt" = "authorizedAt"
     )
   )
   AND (
     "status" = 'PENDING'
     OR ("status" = 'EXPIRED' AND "expiredAt" >= "expiresAt")
     OR ("status" = 'RELEASED' AND "authorizedAt" < "expiresAt")
   )`,
)
export class LegalHoldReleaseOperation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'uuid' })
  holdId!: string;

  @Column({ type: 'varchar', length: 16 })
  status!: AdminLegalHoldReleaseOperationStatusV1;

  @Column({ type: 'text' })
  releaseReason!: string;

  @Column({ type: 'uuid' })
  initiationRequestId!: string;

  @Column({ type: 'uuid' })
  initiatedBy!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  initiatedAt!: Date;

  @Column({ type: 'timestamptz' })
  initiatorMfaVerifiedAt!: Date;

  @Column({ type: 'varchar', length: 128 })
  initiatorTokenId!: string;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'uuid', nullable: true })
  authorizationRequestId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  authorizedBy!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  authorizedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  approverMfaVerifiedAt!: Date | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  approverTokenId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  releasedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  expiredAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  expiredBy!: string | null;
}
