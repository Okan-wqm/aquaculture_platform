import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import {
  ADMIN_LEGAL_HOLD_RELEASE_APPROVAL_WINDOW_SECONDS_V1,
  ADMIN_LEGAL_HOLD_RELEASE_MFA_MAX_AGE_SECONDS_V1,
  ADMIN_LEGAL_HOLD_RELEASE_REASON_MAX_LENGTH_V1,
  ADMIN_LEGAL_HOLD_RELEASE_REASON_MIN_LENGTH_V1,
  type AdminCreateLegalHoldReleaseOperationRpcV1,
  type AdminAuthorizeLegalHoldReleaseOperationRpcV1,
  type AdminLegalHoldReleaseOperationStatusV1,
  type AdminRecentMfaActorV1,
} from '@platform/admin-http-contracts';
import { createBaseEvent, type LegalHoldReleasedEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';

import { ComplianceAction } from '../entities/compliance-audit-log.entity';
import { LegalHoldReleaseOperation } from '../entities/legal-hold-release-operation.entity';
import { LegalHold } from '../entities/legal-hold.entity';
import { tenantAdvisoryLockKey } from './legal-hold.advisory-lock';
import { ComplianceAuditService } from './compliance-audit.service';
import { LegalHoldService } from './legal-hold.service';

const MFA_FUTURE_SKEW_MS = 30_000;
/** Deterministic actor used when the approval-window rule expires an operation. */
export const LEGAL_HOLD_RELEASE_EXPIRY_AUTHORITY_ID = '00000000-0000-0000-0000-000000000000';

interface ReleaseExecutionResult {
  readonly operation: LegalHoldReleaseOperation;
  readonly releasedScope: { readonly tenantId: string; readonly channelId: string | null } | null;
}

function reasonDigest(reason: string): string {
  return createHash('sha256').update(reason, 'utf8').digest('hex');
}

@Injectable()
export class LegalHoldReleaseOperationService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly legalHoldService: LegalHoldService,
    private readonly auditService: ComplianceAuditService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async request(
    command: AdminCreateLegalHoldReleaseOperationRpcV1,
  ): Promise<LegalHoldReleaseOperation> {
    const initiatedMfaAt = this.parseSuperAdminMfaEvidence(command.initiator);
    const releaseReason = this.normalizeReason(command.releaseReason);

    return runInTenantTransaction(
      this.dataSource,
      'messaging',
      command.tenantId,
      async (queryRunner) => {
        const { manager } = queryRunner;
        await manager.query('SELECT pg_advisory_xact_lock($1::bigint)', [
          tenantAdvisoryLockKey(command.tenantId).toString(),
        ]);
        const now = await this.readTransactionInstant(manager);
        this.assertRecentMfaAt(initiatedMfaAt, now);

        const operationRepo = tenantManagerRepo(
          manager,
          LegalHoldReleaseOperation,
          command.tenantId,
        );
        const existing = await operationRepo.findOne({
          where: {
            tenantId: command.tenantId,
            initiationRequestId: command.requestId,
          },
          lock: { mode: 'pessimistic_write' },
        });
        if (existing) {
          this.assertSameInitiation(existing, command, releaseReason);
          return existing;
        }

        const holdRepo = tenantManagerRepo(manager, LegalHold, command.tenantId);
        const hold = await holdRepo.findOne({
          where: {
            id: command.holdId,
            tenantId: command.tenantId,
          },
          lock: { mode: 'pessimistic_write' },
        });
        if (!hold) {
          throw new NotFoundException(`Legal hold not found: ${command.holdId}`);
        }
        if (!hold.isActive) {
          throw new ConflictException(`Legal hold ${command.holdId} is already released`);
        }

        const pending = await operationRepo.findOne({
          where: {
            tenantId: command.tenantId,
            holdId: command.holdId,
            status: 'PENDING',
          },
          lock: { mode: 'pessimistic_write' },
        });
        if (pending) {
          if (pending.expiresAt.getTime() > now.getTime()) {
            throw new ConflictException(
              `Legal hold ${command.holdId} already has pending release operation ${pending.id}`,
            );
          }
          await this.expireOperation(pending, now, manager);
        }

        const operation = operationRepo.create({
          tenantId: command.tenantId,
          holdId: command.holdId,
          status: 'PENDING',
          releaseReason,
          initiationRequestId: command.requestId,
          initiatedBy: command.initiator.actorId,
          initiatorMfaVerifiedAt: initiatedMfaAt,
          initiatorTokenId: command.initiator.tokenId,
          expiresAt: new Date(
            now.getTime() + ADMIN_LEGAL_HOLD_RELEASE_APPROVAL_WINDOW_SECONDS_V1 * 1_000,
          ),
          authorizationRequestId: null,
          authorizedBy: null,
          authorizedAt: null,
          approverMfaVerifiedAt: null,
          approverTokenId: null,
          releasedAt: null,
          expiredAt: null,
          expiredBy: null,
        });
        const saved = await operationRepo.save(operation);

        await this.auditService.log(
          {
            tenantId: command.tenantId,
            userId: command.initiator.actorId,
            action: ComplianceAction.LEGAL_HOLD_RELEASE_REQUEST,
            resourceType: 'legal_hold_release_operation',
            resourceId: saved.id,
            details: {
              holdId: command.holdId,
              requestId: command.requestId,
              reasonSha256: reasonDigest(releaseReason),
              expiresAt: saved.expiresAt.toISOString(),
              mfaTokenId: command.initiator.tokenId,
            },
            ipAddress: null,
            userAgent: null,
          },
          manager,
        );

        return saved;
      },
    );
  }

  async authorize(
    command: AdminAuthorizeLegalHoldReleaseOperationRpcV1,
  ): Promise<LegalHoldReleaseOperation> {
    const approvedMfaAt = this.parseSuperAdminMfaEvidence(command.approver);

    const result = await runInTenantTransaction(
      this.dataSource,
      'messaging',
      command.tenantId,
      async (queryRunner): Promise<ReleaseExecutionResult> => {
        const { manager } = queryRunner;
        await manager.query('SELECT pg_advisory_xact_lock($1::bigint)', [
          tenantAdvisoryLockKey(command.tenantId).toString(),
        ]);
        const now = await this.readTransactionInstant(manager);
        this.assertRecentMfaAt(approvedMfaAt, now);

        const operationRepo = tenantManagerRepo(
          manager,
          LegalHoldReleaseOperation,
          command.tenantId,
        );
        const replay = await operationRepo.findOne({
          where: {
            tenantId: command.tenantId,
            authorizationRequestId: command.requestId,
          },
          lock: { mode: 'pessimistic_write' },
        });
        if (replay) {
          if (
            replay.id !== command.operationId ||
            replay.authorizedBy !== command.approver.actorId
          ) {
            throw new ConflictException(
              `Authorization request ${command.requestId} was already used for another command`,
            );
          }
          return { operation: replay, releasedScope: null };
        }

        const operation = await operationRepo.findOne({
          where: {
            id: command.operationId,
            tenantId: command.tenantId,
          },
          lock: { mode: 'pessimistic_write' },
        });
        if (!operation) {
          throw new NotFoundException(
            `Legal hold release operation not found: ${command.operationId}`,
          );
        }
        if (operation.status === 'EXPIRED') {
          return { operation, releasedScope: null };
        }
        if (operation.status !== 'PENDING') {
          throw new ConflictException(
            `Legal hold release operation ${operation.id} is ${operation.status}`,
          );
        }
        if (operation.initiatedBy === command.approver.actorId) {
          throw new ForbiddenException(
            'Legal hold release requires a distinct authenticated second approver',
          );
        }

        if (operation.expiresAt.getTime() <= now.getTime()) {
          return {
            operation: await this.expireOperation(operation, now, manager),
            releasedScope: null,
          };
        }

        const holdRepo = tenantManagerRepo(manager, LegalHold, command.tenantId);
        const hold = await holdRepo.findOne({
          where: { id: operation.holdId, tenantId: command.tenantId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!hold) {
          throw new NotFoundException(`Legal hold not found: ${operation.holdId}`);
        }
        if (!hold.isActive) {
          throw new ConflictException(`Legal hold ${operation.holdId} is already released`);
        }

        operation.status = 'RELEASED';
        operation.authorizationRequestId = command.requestId;
        operation.authorizedBy = command.approver.actorId;
        operation.authorizedAt = now;
        operation.approverMfaVerifiedAt = approvedMfaAt;
        operation.approverTokenId = command.approver.tokenId;
        operation.releasedAt = now;
        operation.expiredAt = null;
        operation.expiredBy = null;
        const saved = await operationRepo.save(operation);

        hold.isActive = false;
        hold.releasedBy = operation.initiatedBy;
        hold.releasedByApprover = command.approver.actorId;
        hold.releaseReason = operation.releaseReason;
        hold.releasedAt = now;
        await holdRepo.save(hold);

        await this.auditService.log(
          {
            tenantId: command.tenantId,
            userId: command.approver.actorId,
            action: ComplianceAction.LEGAL_HOLD_RELEASE_AUTHORIZE,
            resourceType: 'legal_hold_release_operation',
            resourceId: saved.id,
            details: {
              holdId: operation.holdId,
              initiatedBy: operation.initiatedBy,
              authorizationRequestId: command.requestId,
              reasonSha256: reasonDigest(operation.releaseReason),
              mfaTokenId: command.approver.tokenId,
            },
            ipAddress: null,
            userAgent: null,
          },
          manager,
        );

        const event: LegalHoldReleasedEvent = {
          ...createBaseEvent<LegalHoldReleasedEvent>('LegalHoldReleased', command.tenantId, {
            aggregateId: hold.id,
            aggregateType: 'LegalHold',
            version: 1,
          }),
          version: 1,
          holdId: hold.id,
          scope: hold.channelId === null ? 'tenant' : 'channel',
          resourceId: hold.channelId,
          legalMatterId: hold.legalMatterId,
          releaseOperationId: saved.id,
          releaseRequestedBy: saved.initiatedBy,
          releaseAuthorizedBy: command.approver.actorId,
          releaseReason: saved.releaseReason,
          releasedAtIso: now.toISOString(),
        };
        await this.outboxPublisher.enqueue(event, manager);

        return {
          operation: saved,
          releasedScope: { tenantId: hold.tenantId, channelId: hold.channelId },
        };
      },
    );

    if (result.releasedScope) {
      await this.legalHoldService.invalidateLegalHoldProjection(
        result.releasedScope.tenantId,
        result.releasedScope.channelId,
      );
    }
    return result.operation;
  }

  async list(
    tenantId: string,
    status?: AdminLegalHoldReleaseOperationStatusV1,
  ): Promise<LegalHoldReleaseOperation[]> {
    return runInTenantTransaction(this.dataSource, 'messaging', tenantId, async (queryRunner) => {
      const { manager } = queryRunner;
      await manager.query('SELECT pg_advisory_xact_lock($1::bigint)', [
        tenantAdvisoryLockKey(tenantId).toString(),
      ]);
      const now = await this.readTransactionInstant(manager);
      const operationRepo = tenantManagerRepo(manager, LegalHoldReleaseOperation, tenantId);
      const pendingOperations = await operationRepo.find({
        where: { tenantId, status: 'PENDING' },
        order: { initiatedAt: 'ASC' },
      });
      for (const operation of pendingOperations) {
        if (operation.expiresAt.getTime() <= now.getTime()) {
          await this.expireOperation(operation, now, manager);
        }
      }

      return operationRepo.find({
        where: status ? { tenantId, status } : { tenantId },
        order: { initiatedAt: 'DESC' },
      });
    });
  }

  private parseSuperAdminMfaEvidence(actor: AdminRecentMfaActorV1): Date {
    const isSuperAdmin = actor.roles.some((role) => role.toUpperCase() === 'SUPER_ADMIN');
    if (!isSuperAdmin) {
      throw new ForbiddenException('Legal hold release requires SUPER_ADMIN');
    }
    if (!actor.mfaVerified || actor.tokenId.trim().length === 0) {
      throw new ForbiddenException(
        'Legal hold release requires a verified MFA-bearing access token',
      );
    }

    const issuedAt = new Date(actor.tokenIssuedAt);
    const issuedAtMs = issuedAt.getTime();
    if (!Number.isFinite(issuedAtMs)) {
      throw new ForbiddenException('MFA token issue time is invalid');
    }
    return issuedAt;
  }

  private assertRecentMfaAt(issuedAt: Date, transactionInstant: Date): void {
    const ageMs = transactionInstant.getTime() - issuedAt.getTime();
    if (
      ageMs < -MFA_FUTURE_SKEW_MS ||
      ageMs > ADMIN_LEGAL_HOLD_RELEASE_MFA_MAX_AGE_SECONDS_V1 * 1_000
    ) {
      throw new ForbiddenException(
        'Legal hold release requires MFA step-up within the last five minutes',
      );
    }
  }

  private async readTransactionInstant(manager: EntityManager): Promise<Date> {
    const rows: Array<{ instant: Date | string }> = await manager.query(
      'SELECT transaction_timestamp() AS instant',
    );
    const instant = new Date(rows[0]?.instant ?? Number.NaN);
    if (!Number.isFinite(instant.getTime())) {
      throw new ConflictException('PostgreSQL did not return a legal-hold transaction timestamp');
    }
    return instant;
  }

  private normalizeReason(reason: string): string {
    const normalized = reason.trim();
    if (
      normalized.length < ADMIN_LEGAL_HOLD_RELEASE_REASON_MIN_LENGTH_V1 ||
      normalized.length > ADMIN_LEGAL_HOLD_RELEASE_REASON_MAX_LENGTH_V1
    ) {
      throw new BadRequestException(
        `Legal hold release reason must contain ${ADMIN_LEGAL_HOLD_RELEASE_REASON_MIN_LENGTH_V1}-${ADMIN_LEGAL_HOLD_RELEASE_REASON_MAX_LENGTH_V1} characters`,
      );
    }
    return normalized;
  }

  private assertSameInitiation(
    operation: LegalHoldReleaseOperation,
    command: AdminCreateLegalHoldReleaseOperationRpcV1,
    normalizedReason: string,
  ): void {
    if (
      operation.holdId !== command.holdId ||
      operation.initiatedBy !== command.initiator.actorId ||
      operation.releaseReason !== normalizedReason
    ) {
      throw new ConflictException(
        `Initiation request ${command.requestId} was already used for another command`,
      );
    }
  }

  private async expireOperation(
    operation: LegalHoldReleaseOperation,
    expiredAt: Date,
    manager: EntityManager,
  ): Promise<LegalHoldReleaseOperation> {
    operation.status = 'EXPIRED';
    operation.expiredAt = expiredAt;
    operation.expiredBy = LEGAL_HOLD_RELEASE_EXPIRY_AUTHORITY_ID;
    const saved = await tenantManagerRepo(
      manager,
      LegalHoldReleaseOperation,
      operation.tenantId,
    ).save(operation);
    await this.auditService.log(
      {
        tenantId: operation.tenantId,
        userId: LEGAL_HOLD_RELEASE_EXPIRY_AUTHORITY_ID,
        action: ComplianceAction.LEGAL_HOLD_RELEASE_EXPIRE,
        resourceType: 'legal_hold_release_operation',
        resourceId: operation.id,
        details: {
          holdId: operation.holdId,
          initiatedBy: operation.initiatedBy,
          approvalDeadline: operation.expiresAt.toISOString(),
          expiredAt: saved.expiredAt?.toISOString(),
          expiredBy: saved.expiredBy,
        },
        ipAddress: null,
        userAgent: null,
      },
      manager,
    );
    return saved;
  }
}
