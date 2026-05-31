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
import {
  Controller,
  Logger,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  AUTH_ADMIN_COMMAND_SUBJECTS,
  type AdminCreateUserCommand,
  type AdminCreateUserResult,
  type AdminResetUserPasswordCommand,
  type AdminResetUserPasswordResult,
  type AdminUpdateUserCommand,
  type AdminUpdateUserResult,
  type AdminDeactivateUserCommand,
  type AdminDeactivateUserResult,
  type AdminForceLogoutUserCommand,
  type AdminForceLogoutUserResult,
  type AdminInviteUserCommand,
  type AdminInviteUserResult,
  type AdminCheckUserLimitQuery,
  type AdminCheckUserLimitResult,
} from '@platform/event-contracts';
import { ForbiddenException } from '@nestjs/common';

import { UserLifecycleService } from '../services/user-lifecycle.service';

/**
 * Map a typed service-layer exception to the fixed error-code vocabulary
 * the admin-api client maps to HTTP status. Returning a typed error code
 * instead of re-throwing across the NATS boundary keeps the wire contract
 * stable; domain exception classes would not serialise cleanly over NATS.
 */
type CreateErrorCode = NonNullable<AdminCreateUserResult['errorCode']>;
type ResetErrorCode = NonNullable<AdminResetUserPasswordResult['errorCode']>;
type UpdateErrorCode = NonNullable<AdminUpdateUserResult['errorCode']>;
type DeactivateErrorCode = NonNullable<AdminDeactivateUserResult['errorCode']>;
type ForceLogoutErrorCode = NonNullable<AdminForceLogoutUserResult['errorCode']>;
type InviteErrorCode = NonNullable<AdminInviteUserResult['errorCode']>;
type CheckUserLimitErrorCode = NonNullable<AdminCheckUserLimitResult['errorCode']>;

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
  async createUser(@Payload() command: AdminCreateUserCommand): Promise<AdminCreateUserResult> {
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
      this.logger.warn(`adminCreateUser failed: code=${errorCode}, reason=${message}`);
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
        command.performedBy,
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

  /**
   * Update an existing user (admin-initiated partial update).
   *
   * CRITICAL-002 — replaces admin-api's raw-SQL `UPDATE auth.users SET ...`
   * dynamic statement. The entity is the single writer, so a column
   * rename on the entity automatically propagates; admin-api never
   * names columns.
   */
  @MessagePattern(AUTH_ADMIN_COMMAND_SUBJECTS.UPDATE_USER)
  async updateUser(@Payload() command: AdminUpdateUserCommand): Promise<AdminUpdateUserResult> {
    try {
      const user = await this.userLifecycleService.adminUpdateUser(command.userId, {
        firstName: command.firstName,
        lastName: command.lastName,
        role: command.role,
        tenantId: command.tenantId,
        isActive: command.isActive,
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
          lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
          createdAt: user.createdAt.toISOString(),
          updatedAt: user.updatedAt.toISOString(),
        },
      };
    } catch (err) {
      const errorCode = this.mapUpdateError(err);
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `adminUpdateUser failed: userId=${command.userId}, code=${errorCode}, reason=${message}`,
      );
      return { success: false, errorCode, error: message };
    }
  }

  /**
   * Deactivate (soft-delete) a user (platform-scoped).
   *
   * CRITICAL-002 — replaces admin-api's raw-SQL
   * `UPDATE auth.users SET "isActive" = false` plus the
   * `DELETE FROM auth.refresh_tokens` side-effect.
   */
  @MessagePattern(AUTH_ADMIN_COMMAND_SUBJECTS.DEACTIVATE_USER)
  async deactivateUser(
    @Payload() command: AdminDeactivateUserCommand,
  ): Promise<AdminDeactivateUserResult> {
    try {
      const result = await this.userLifecycleService.adminDeactivateUser(command.userId);
      return {
        success: true,
        userId: result.userId,
        refreshTokensRemoved: result.refreshTokensRemoved,
      };
    } catch (err) {
      const errorCode = this.mapDeactivateError(err);
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `adminDeactivateUser failed: userId=${command.userId}, code=${errorCode}, reason=${message}`,
      );
      return { success: false, errorCode, error: message };
    }
  }

  /**
   * Force logout — hard-delete all refresh tokens for a user. User record
   * is untouched; the account remains active.
   *
   * CRITICAL-002 — replaces admin-api's raw-SQL
   * `DELETE FROM auth.refresh_tokens WHERE "userId" = $1`.
   */
  @MessagePattern(AUTH_ADMIN_COMMAND_SUBJECTS.FORCE_LOGOUT_USER)
  async forceLogoutUser(
    @Payload() command: AdminForceLogoutUserCommand,
  ): Promise<AdminForceLogoutUserResult> {
    try {
      const result = await this.userLifecycleService.adminForceLogout(command.userId);
      return {
        success: true,
        userId: result.userId,
        sessionsInvalidated: result.sessionsInvalidated,
      };
    } catch (err) {
      const errorCode = this.mapForceLogoutError(err);
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `adminForceLogout failed: userId=${command.userId}, code=${errorCode}, reason=${message}`,
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

  private mapUpdateError(err: unknown): UpdateErrorCode {
    if (err instanceof NotFoundException) {
      // The service throws NotFound for both "user not found" and
      // "tenant not found"; disambiguate on the message so admin-api
      // can surface the correct REST status.
      return err.message.toLowerCase().includes('tenant') ? 'TENANT_NOT_FOUND' : 'USER_NOT_FOUND';
    }
    if (err instanceof BadRequestException) {
      return err.message.toLowerCase().includes('role') ? 'INVALID_ROLE' : 'VALIDATION_ERROR';
    }
    return 'INTERNAL_ERROR';
  }

  private mapDeactivateError(err: unknown): DeactivateErrorCode {
    if (err instanceof NotFoundException) return 'USER_NOT_FOUND';
    if (err instanceof BadRequestException) return 'VALIDATION_ERROR';
    return 'INTERNAL_ERROR';
  }

  private mapForceLogoutError(err: unknown): ForceLogoutErrorCode {
    if (err instanceof NotFoundException) return 'USER_NOT_FOUND';
    return 'INTERNAL_ERROR';
  }

  /**
   * Tenant-admin-initiated invite (CRITICAL-005 NATS path).
   *
   * Replaces the admin-api raw-SQL inviteUser path that wrote across
   * `auth.users` / `auth.invitations` / `auth.user_module_assignments`
   * with snake_case columns drifting from the entity definitions.
   */
  @MessagePattern(AUTH_ADMIN_COMMAND_SUBJECTS.INVITE_USER)
  async inviteUser(@Payload() command: AdminInviteUserCommand): Promise<AdminInviteUserResult> {
    try {
      const result = await this.userLifecycleService.adminInviteUser({
        tenantId: command.tenantId,
        email: command.email,
        firstName: command.firstName,
        lastName: command.lastName,
        role: command.role,
        moduleIds: command.moduleIds,
        primaryModuleId: command.primaryModuleId,
        invitedBy: command.invitedBy,
        message: command.message,
      });
      return {
        success: true,
        userId: result.userId,
        invitationId: result.invitationId,
        invitationToken: result.invitationToken,
      };
    } catch (err) {
      const errorCode = this.mapInviteError(err);
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `adminInviteUser failed: tenantId=${command.tenantId}, code=${errorCode}, reason=${message}`,
      );
      return { success: false, errorCode, error: message };
    }
  }

  /**
   * Read-side companion to inviteUser — returns a snapshot of the
   * tenant's user-slot capacity. Used by admin-panel to gate the
   * "invite" button before the user fills the form.
   */
  @MessagePattern(AUTH_ADMIN_COMMAND_SUBJECTS.CHECK_USER_LIMIT)
  async checkUserLimit(
    @Payload() query: AdminCheckUserLimitQuery,
  ): Promise<AdminCheckUserLimitResult> {
    try {
      const result = await this.userLifecycleService.adminCheckUserLimit(query.tenantId);
      return {
        success: true,
        canCreate: result.canCreate,
        currentCount: result.currentCount,
        limit: result.limit,
        remaining: result.remaining,
        message: result.message,
      };
    } catch (err) {
      const errorCode = this.mapCheckUserLimitError(err);
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `adminCheckUserLimit failed: tenantId=${query.tenantId}, code=${errorCode}, reason=${message}`,
      );
      return { success: false, errorCode, error: message };
    }
  }

  private mapInviteError(err: unknown): InviteErrorCode {
    if (err instanceof ConflictException) return 'DUPLICATE_EMAIL';
    if (err instanceof ForbiddenException) return 'ROLE_VALIDATION_FAILED';
    if (err instanceof NotFoundException) {
      const msg = err.message.toLowerCase();
      if (msg.includes('inviter')) return 'INVITER_NOT_FOUND';
      return 'TENANT_NOT_FOUND';
    }
    if (err instanceof BadRequestException) {
      const msg = err.message.toLowerCase();
      if (msg.includes('user limit reached')) return 'USER_LIMIT_REACHED';
      if (msg.includes('role') || msg.includes('super_admin')) {
        return 'INVALID_ROLE';
      }
      return 'VALIDATION_ERROR';
    }
    return 'INTERNAL_ERROR';
  }

  private mapCheckUserLimitError(err: unknown): CheckUserLimitErrorCode {
    if (err instanceof NotFoundException) return 'TENANT_NOT_FOUND';
    return 'INTERNAL_ERROR';
  }
}
