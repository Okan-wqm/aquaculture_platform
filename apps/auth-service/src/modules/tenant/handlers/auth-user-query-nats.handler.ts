import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { UUID_REGEX } from '@aquaculture/backend-common/constants';
import {
  AUTH_USER_QUERY_SUBJECTS,
  ValidateTenantUsersQuery,
  ValidateTenantUsersResult,
} from '@platform/event-contracts';

import { User } from '../../authentication/entities/user.entity';

/**
 * Internal auth-service read-side queries.
 *
 * These handlers deliberately return only membership state. They are used by
 * tenant-owned services to enforce tenant boundaries without fetching user PII.
 */
@Controller()
export class AuthUserQueryNatsHandler {
  private readonly logger = new Logger(AuthUserQueryNatsHandler.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  @MessagePattern(AUTH_USER_QUERY_SUBJECTS.VALIDATE_TENANT_USERS)
  async validateTenantUsers(
    @Payload() payload: ValidateTenantUsersQuery,
  ): Promise<ValidateTenantUsersResult> {
    const requireActive = payload.requireActive !== false;
    const tenantId = payload.tenantId;
    const userIds = Array.from(new Set(payload.userIds ?? []));

    if (!UUID_REGEX.test(tenantId) || userIds.some((id) => !UUID_REGEX.test(id))) {
      return {
        success: false,
        allValid: false,
        validUserIds: [],
        invalidUserIds: userIds,
        inactiveUserIds: [],
        errorCode: 'VALIDATION_ERROR',
        error: 'Invalid tenantId or userIds',
      };
    }

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

      return {
        success: true,
        allValid,
        validUserIds,
        invalidUserIds,
        inactiveUserIds,
      };
    } catch (error) {
      this.logger.error(
        `validateTenantUsers failed for tenant=${tenantId}`,
        error instanceof Error ? error.stack : String(error),
      );
      return {
        success: false,
        allValid: false,
        validUserIds: [],
        invalidUserIds: [],
        inactiveUserIds: [],
        errorCode: 'INTERNAL_ERROR',
        error: 'Unable to validate tenant users',
      };
    }
  }
}
