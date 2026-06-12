import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { AuditLogService, AuditSeverity } from '@aquaculture/backend-common/audit';
import {
  AUTH_USER_QUERY_SUBJECTS,
  ValidateTenantMembershipQuery,
  ValidateTenantMembershipResult,
  validateTenantMembershipQuerySchema,
} from '@platform/event-contracts';

import { User } from '../../authentication/entities/user.entity';

/**
 * Internal auth-service read-side membership query (cluster-8 DİLİM-2).
 *
 * Deliberately returns ONLY membership state — no email, no display
 * name, no profile fields. Tenant-owned services (messaging channel
 * admission today) use it to enforce tenant boundaries without this
 * surface ever becoming a PII or user-probing oracle:
 *
 *   - The answer is tenant-scoped: a userId that exists on the platform
 *     but under ANOTHER tenant lands in `invalidUserIds` exactly like a
 *     nonexistent one (the `where: { tenantId }` filter is the
 *     load-bearing line — platform-wide existence must not leak).
 *   - NATS payloads are a trust boundary (compromised-container threat
 *     model): the AJV schema (additionalProperties:false) rejects the
 *     payload BEFORE any field is read.
 *   - requireActive semantics are locked in the contract: true (the
 *     admission default) pushes inactive members into `inactiveUserIds`
 *     AND forces allValid=false.
 */
@Controller()
export class AuthUserQueryNatsHandler {
  private readonly logger = new Logger(AuthUserQueryNatsHandler.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly auditLogService: AuditLogService,
  ) {}

  @MessagePattern(AUTH_USER_QUERY_SUBJECTS.VALIDATE_TENANT_MEMBERSHIP)
  async validateTenantMembership(
    @Payload() payload: ValidateTenantMembershipQuery,
  ): Promise<ValidateTenantMembershipResult> {
    // Trust-boundary gate FIRST — shape, UUID formats and the ≤200
    // userIds cap all enforced by the compiled schema before any
    // business logic touches the payload.
    if (!validateTenantMembershipQuerySchema(payload)) {
      return {
        success: false,
        allValid: false,
        validUserIds: [],
        invalidUserIds: [],
        inactiveUserIds: [],
        errorCode: 'VALIDATION_ERROR',
        error: 'Invalid membership query payload',
      };
    }

    const requireActive = payload.requireActive !== false;
    const tenantId = payload.tenantId;
    const userIds = Array.from(new Set(payload.userIds));

    if (userIds.length === 0) {
      return {
        success: true,
        allValid: true,
        validUserIds: [],
        invalidUserIds: [],
        inactiveUserIds: [],
      };
    }

    try {
      const users = await this.userRepository.find({
        select: ['id', 'tenantId', 'isActive'],
        where: {
          tenantId,
          id: In(userIds),
        },
      });

      const foundById = new Map(users.map((user) => [user.id, user]));
      const inactiveUserIds = requireActive
        ? users.filter((user) => !user.isActive).map((user) => user.id)
        : [];
      const validUserIds = users
        .filter((user) => !requireActive || user.isActive)
        .map((user) => user.id);
      const invalidUserIds = userIds.filter((id) => !foundById.has(id));
      const allValid = invalidUserIds.length === 0 && inactiveUserIds.length === 0;

      if (!allValid) {
        // Cross-tenant userId injection ATTEMPTS are security signal —
        // awaited audit per the platform rule (cross-tenant access
        // attempts, allowed AND rejected, are recorded; fire-and-forget
        // audit is banned).
        await this.auditLogService.recordAwait({
          action: 'auth.membership_validation.rejected',
          resource: 'tenant_membership_query',
          tenantId,
          severity: AuditSeverity.WARNING,
          metadata: {
            invalidCount: invalidUserIds.length,
            inactiveCount: inactiveUserIds.length,
            requireActive,
            correlationId: payload.correlationId ?? null,
          },
        });
      }

      return {
        success: true,
        allValid,
        validUserIds,
        invalidUserIds,
        inactiveUserIds,
      };
    } catch (error) {
      this.logger.error(
        `validateTenantMembership failed for tenant=${tenantId}`,
        error instanceof Error ? error.stack : String(error),
      );
      return {
        success: false,
        allValid: false,
        validUserIds: [],
        invalidUserIds: [],
        inactiveUserIds: [],
        errorCode: 'INTERNAL_ERROR',
        error: 'Unable to validate tenant membership',
      };
    }
  }
}
