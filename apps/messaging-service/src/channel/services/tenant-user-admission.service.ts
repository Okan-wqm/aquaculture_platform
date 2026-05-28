import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { UUID_REGEX } from '@aquaculture/backend-common/constants';
import {
  AUTH_USER_QUERY_SUBJECTS,
  ValidateTenantUsersQuery,
  ValidateTenantUsersResult,
} from '@platform/event-contracts';
import { firstValueFrom, timeout } from 'rxjs';

const AUTH_VALIDATION_TIMEOUT_MS = 2500;

@Injectable()
export class TenantUserAdmissionService {
  private readonly logger = new Logger(TenantUserAdmissionService.name);

  constructor(
    @Inject('NATS_SERVICE')
    private readonly natsClient: ClientProxy,
  ) {}

  async assertActiveTenantUsers(
    tenantId: string,
    userIds: string[],
  ): Promise<string[]> {
    const uniqueUserIds = Array.from(new Set(userIds));

    if (!UUID_REGEX.test(tenantId) || uniqueUserIds.some((id) => !UUID_REGEX.test(id))) {
      throw new ForbiddenException('One or more users cannot be added to this channel');
    }

    const payload: ValidateTenantUsersQuery = {
      tenantId,
      userIds: uniqueUserIds,
      requireActive: true,
    };

    let result: ValidateTenantUsersResult;
    try {
      result = await firstValueFrom(
        this.natsClient
          .send<ValidateTenantUsersResult, ValidateTenantUsersQuery>(
            AUTH_USER_QUERY_SUBJECTS.VALIDATE_TENANT_USERS,
            payload,
          )
          .pipe(timeout(AUTH_VALIDATION_TIMEOUT_MS)),
      );
    } catch (error) {
      this.logger.warn(
        `Auth tenant-user validation unavailable for tenant=${tenantId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new ServiceUnavailableException('Unable to validate channel users');
    }

    if (!result?.success) {
      throw new ServiceUnavailableException('Unable to validate channel users');
    }

    if (!result.allValid) {
      this.logger.warn(
        `Rejected channel admission for tenant=${tenantId}; invalid=${result.invalidUserIds.length}; inactive=${result.inactiveUserIds.length}`,
      );
      throw new ForbiddenException('One or more users cannot be added to this channel');
    }

    return uniqueUserIds;
  }
}
