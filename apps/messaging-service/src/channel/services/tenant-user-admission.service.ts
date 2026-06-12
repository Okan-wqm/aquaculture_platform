import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';

import { UUID_REGEX } from '@aquaculture/backend-common/constants';
import {
  AUTH_USER_QUERY_SUBJECTS,
  ValidateTenantMembershipQuery,
  ValidateTenantMembershipResult,
} from '@platform/event-contracts';

const AUTH_VALIDATION_TIMEOUT_MS = 2500;

/**
 * Channel-admission gate (cluster-8 DİLİM-2).
 *
 * Every channel membership write (create GROUP/AI/DIRECT, add member)
 * routes its candidate userIds through here BEFORE the ChannelMember
 * insert, closing the create-channel "TODO Phase 2" cross-tenant
 * injection gap: an actor could otherwise write another tenant's
 * userId into their own channel graph.
 *
 * FAIL-CLOSED (security review condition 7): if auth-service is
 * unreachable or returns a non-success/!allValid result, admission is
 * REJECTED. This mirrors the platform's POLICY_FAIL_OPEN=false stance —
 * an unavailable authority must never default to "allow".
 */
@Injectable()
export class TenantUserAdmissionService {
  private readonly logger = new Logger(TenantUserAdmissionService.name);

  constructor(
    @Inject('NATS_SERVICE')
    private readonly natsClient: ClientProxy,
  ) {}

  /**
   * Assert every userId is an active member of `tenantId`. Returns the
   * de-duplicated id list on success; throws ForbiddenException
   * (caller's fault) or ServiceUnavailableException (authority down) —
   * never returns on failure.
   */
  async assertActiveTenantUsers(
    tenantId: string,
    userIds: string[],
  ): Promise<string[]> {
    const uniqueUserIds = Array.from(new Set(userIds));

    if (uniqueUserIds.length === 0) {
      return uniqueUserIds;
    }

    // Cheap local boundary check before spending a NATS round-trip; the
    // auth handler re-validates against the AJV schema regardless.
    if (
      !UUID_REGEX.test(tenantId) ||
      uniqueUserIds.some((id) => !UUID_REGEX.test(id))
    ) {
      throw new ForbiddenException(
        'One or more users cannot be added to this channel',
      );
    }

    const payload: ValidateTenantMembershipQuery = {
      tenantId,
      userIds: uniqueUserIds,
      requireActive: true,
    };

    let result: ValidateTenantMembershipResult;
    try {
      result = await firstValueFrom(
        this.natsClient
          .send<ValidateTenantMembershipResult, ValidateTenantMembershipQuery>(
            AUTH_USER_QUERY_SUBJECTS.VALIDATE_TENANT_MEMBERSHIP,
            payload,
          )
          .pipe(timeout(AUTH_VALIDATION_TIMEOUT_MS)),
      );
    } catch (error) {
      // Authority unreachable → fail closed (do NOT admit).
      this.logger.warn(
        `Auth tenant-membership validation unavailable for tenant=${tenantId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new ServiceUnavailableException('Unable to validate channel users');
    }

    if (!result?.success) {
      throw new ServiceUnavailableException('Unable to validate channel users');
    }

    if (!result.allValid) {
      // Local security signal; the durable awaited audit of the rejected
      // validation is recorded auth-side (AuthUserQueryNatsHandler,
      // where the global AuditLogService is wired).
      this.logger.warn(
        `Rejected channel admission for tenant=${tenantId}; invalid=${result.invalidUserIds.length}; inactive=${result.inactiveUserIds.length}`,
      );
      throw new ForbiddenException(
        'One or more users cannot be added to this channel',
      );
    }

    return uniqueUserIds;
  }
}
