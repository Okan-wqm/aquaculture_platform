/**
 * @module AuthAdminNatsHandler
 * @description NATS request-reply handler exposing auth-service user
 * lifecycle operations to admin-api-service.
 *
 * Why this handler exists
 * -----------------------
 * admin-api-service was historically writing to `auth.users` via raw SQL
 * (CRITICAL-001 in
 * `docs/reviews/code-reviewer/2026-04-21-raw-sql-audit.md`). That pattern
 * produced column drift (`passwordHash` vs `password`) and violated service
 * ownership — admin-api does not own the auth schema.
 *
 * Replacing those raw-SQL writes with NATS calls to this handler makes
 * column drift structurally impossible: the TypeORM `User` entity on
 * auth-service is the SINGLE writer and the column name is defined once,
 * on the entity. Any admin-api call that used to shape SQL against a
 * non-existent column now fails at the TypeScript layer (the
 * `AdminCreateUserCommand` / `AdminResetUserPasswordCommand` contracts
 * don't model column names at all — they model intent).
 *
 * Subject convention: `request.auth.admin.*`, consistent with the
 * `request.messaging.admin.*` pattern already in production on
 * `MessagingAdminNatsHandler`.
 *
 * @see libs/event-contracts/src/tenant-commands.ts (AUTH_ADMIN_COMMAND_SUBJECTS)
 */
import { Controller, Logger, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  AUTH_ADMIN_COMMAND_SUBJECTS,
  type AdminCreateUserCommand,
  type AdminCreateUserResult,
  type AdminResetUserPasswordCommand,
  type AdminResetUserPasswordResult,
} from '@platform/event-contracts';

import { UserLifecycleService } from '../services/user-lifecycle.service';

/**
 * Map a typed service-layer exception to the fixed error-code vocabulary
 * the admin-api client maps to HTTP status. Returning a typed error code
 * instead of re-throwing across the NATS boundary keeps the wire contract
 * stable; domain exception classes would not serialise cleanly over NATS.
 */
type CreateErrorCode = NonNullable<AdminCreateUserResult['errorCode']>;
type ResetErrorCode = NonNullable<AdminResetUserPasswordResult['errorCode']>;

@Controller()
export class AuthAdminNatsHandler {
  private readonly logger = new Logger(AuthAdminNatsHandler.name);

  constructor(private readonly userLifecycleService: UserLifecycleService) {}

  /**
   * Create a user on behalf of a SUPER_ADMIN operator.
   *
   * The implementation delegates to `UserLifecycleService.adminCreateUser`
   * which writes through the TypeORM `User` repository — the entity's
   * `@BeforeInsert` hook is the ONLY place the password column is hashed,
   * making double-hashing and column-name drift impossible.
   */
  @MessagePattern(AUTH_ADMIN_COMMAND_SUBJECTS.CREATE_USER)
  async createUser(
    @Payload() command: AdminCreateUserCommand,
  ): Promise<AdminCreateUserResult> {
    try {
      const user = await this.userLifecycleService.adminCreateUser({
        email: command.email,
        firstName: command.firstName,
        lastName: command.lastName,
        password: command.password,
        role: command.role,
        tenantId: command.tenantId ?? null,
      });

      return {
        success: true,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName ?? null,
          lastName: user.lastName ?? null,
          role: user.role,
          tenantId: user.tenantId ?? null,
          isActive: user.isActive,
          createdAt: user.createdAt.toISOString(),
        },
      };
    } catch (err) {
      const errorCode = this.mapCreateError(err);
      const message = err instanceof Error ? err.message : String(err);
      // SECURITY: log the error code path, never the caller's password.
      this.logger.warn(
        `adminCreateUser failed: code=${errorCode}, reason=${message}`,
      );
      return { success: false, errorCode, error: message };
    }
  }

  /**
   * Reset a user's password on behalf of a SUPER_ADMIN operator.
   *
   * Delegates to `UserLifecycleService.adminResetPassword` which writes
   * through the TypeORM `User` repository (correct `password` column) and
   * revokes all refresh tokens as a security side-effect.
   */
  @MessagePattern(AUTH_ADMIN_COMMAND_SUBJECTS.RESET_USER_PASSWORD)
  async resetUserPassword(
    @Payload() command: AdminResetUserPasswordCommand,
  ): Promise<AdminResetUserPasswordResult> {
    try {
      const result = await this.userLifecycleService.adminResetPassword(
        command.userId,
        command.newPassword,
      );
      return {
        success: true,
        userId: result.userId,
        refreshTokensRevoked: result.refreshTokensRevoked,
      };
    } catch (err) {
      const errorCode = this.mapResetError(err);
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `adminResetPassword failed: userId=${command.userId}, code=${errorCode}, reason=${message}`,
      );
      return { success: false, errorCode, error: message };
    }
  }

  private mapCreateError(err: unknown): CreateErrorCode {
    if (err instanceof ConflictException) return 'DUPLICATE_EMAIL';
    if (err instanceof NotFoundException) return 'TENANT_NOT_FOUND';
    if (err instanceof BadRequestException) {
      const msg = err.message.toLowerCase();
      if (msg.includes('role')) return 'INVALID_ROLE';
      return 'VALIDATION_ERROR';
    }
    return 'INTERNAL_ERROR';
  }

  private mapResetError(err: unknown): ResetErrorCode {
    if (err instanceof NotFoundException) return 'USER_NOT_FOUND';
    if (err instanceof BadRequestException) return 'VALIDATION_ERROR';
    return 'INTERNAL_ERROR';
  }
}
