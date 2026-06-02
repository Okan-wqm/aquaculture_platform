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
import { PASSWORD_POLICY_MESSAGE } from '@aquaculture/backend-common/security';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { InjectDataSource } from '@nestjs/typeorm';
import * as crypto from 'crypto';
import {
  AUTH_ADMIN_COMMAND_SUBJECTS,
  type AdminAssignTenantModulesCommand,
  type AdminAssignTenantModulesResult,
  type AdminClaimTenantProvisioningCommand,
  type AdminClaimTenantProvisioningResult,
  type AdminCreateUserCommand,
  type AdminCreateUserResult,
  type AdminCreateModuleCommand,
  type AdminDeleteModuleCommand,
  type AdminDeleteModuleResult,
  type AdminModuleMutationResult,
  type AdminResetUserPasswordCommand,
  type AdminResetUserPasswordResult,
  type AdminRemoveTenantAuthResourcesCommand,
  type AdminRemoveTenantAuthResourcesResult,
  type AdminRemoveTenantModuleCommand,
  type AdminSetTenantStatusCommand,
  type AdminSetTenantStatusResult,
  type AdminSetupTenantRolesCommand,
  type AdminSetupTenantRolesResult,
  type AdminTenantModuleMutationResult,
  type AdminUpdateModuleCommand,
  type AdminUpdateTenantBillingStateCommand,
  type AdminUpdateTenantBillingStateResult,
  type AdminUpdateUserCommand,
  type AdminUpdateUserResult,
  type AdminUpsertTenantModuleCommand,
  type AdminDeactivateUserCommand,
  type AdminDeactivateUserResult,
  type AdminForceLogoutUserCommand,
  type AdminForceLogoutUserResult,
  type AdminInviteUserCommand,
  type AdminInviteUserResult,
  type AdminCheckUserLimitQuery,
  type AdminCheckUserLimitResult,
  type AdminCreateTenantRoleCommand,
  type AdminDeleteTenantRoleCommand,
  type AdminAssignUserRoleCommand,
  type AdminRevokeUserRoleAssignmentCommand,
  type AdminSeedTenantRolesCommand,
  type AdminTenantRoleMutationResult,
  type AdminUpdateTenantRoleCommand,
  type AdminUpdateUserRoleAssignmentCommand,
  type AdminUserRoleAssignmentMutationResult,
  type CreateTenantAdminCommand,
  type CreateTenantAdminResult,
} from '@platform/event-contracts';
import { ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';

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

  constructor(
    private readonly userLifecycleService: UserLifecycleService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

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
      if (err.message === PASSWORD_POLICY_MESSAGE) return 'PASSWORD_POLICY_VIOLATION';
      const msg = err.message.toLowerCase();
      if (msg.includes('role')) return 'INVALID_ROLE';
      return 'VALIDATION_ERROR';
    }
    return 'INTERNAL_ERROR';
  }

  private mapResetError(err: unknown): ResetErrorCode {
    if (err instanceof NotFoundException) return 'USER_NOT_FOUND';
    if (err instanceof BadRequestException) {
      return err.message === PASSWORD_POLICY_MESSAGE
        ? 'PASSWORD_POLICY_VIOLATION'
        : 'VALIDATION_ERROR';
    }
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

  @MessagePattern(AUTH_ADMIN_COMMAND_SUBJECTS.CREATE_TENANT_ADMIN)
  async createTenantAdmin(
    @Payload() command: CreateTenantAdminCommand,
  ): Promise<CreateTenantAdminResult> {
    try {
      if (!(await this.tenantExists(command.tenantId))) {
        return { success: false, errorCode: 'TENANT_NOT_FOUND', error: 'Tenant not found' };
      }

      const existing = await this.dataSource.query<{ id: string }[]>(
        `SELECT id FROM auth.users WHERE LOWER(email) = LOWER($1)`,
        [command.email],
      );
      if (existing.length > 0) {
        return {
          success: false,
          errorCode: 'DUPLICATE_EMAIL',
          error: 'A user with this email already exists',
        };
      }

      const rawInvitationToken = crypto.randomBytes(32).toString('hex');
      const hashedToken = crypto.createHash('sha256').update(rawInvitationToken).digest('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const result = await this.dataSource.transaction(async (manager) => {
        const userRows = await manager.query<{ id: string }[]>(
          `INSERT INTO auth.users (
             id, email, "firstName", "lastName", role, "tenantId",
             "isActive", "isEmailVerified", "invitationToken", "invitationExpiresAt",
             "createdAt", "updatedAt"
           ) VALUES (
             gen_random_uuid(), $1, $2, $3, 'TENANT_ADMIN', $4,
             true, false, $5, $6, NOW(), NOW()
           )
           RETURNING id`,
          [
            command.email,
            command.firstName,
            command.lastName,
            command.tenantId,
            hashedToken,
            expiresAt,
          ],
        );
        const createdUser = userRows[0];
        if (!createdUser) {
          throw new Error('Tenant admin insert returned no user id');
        }
        const userId = createdUser.id;

        await manager.query(
          `INSERT INTO auth.invitations (
             id, token, email, "firstName", "lastName", role, "tenantId",
             status, "expiresAt", "invitedBy", "sendCount", "lastSentAt", "createdAt", "updatedAt"
           ) VALUES (
             gen_random_uuid(), $1, $2, $3, $4, 'TENANT_ADMIN', $5,
             'PENDING', $6, $7, 1, NOW(), NOW(), NOW()
           )`,
          [
            hashedToken,
            command.email,
            command.firstName,
            command.lastName,
            command.tenantId,
            expiresAt,
            userId,
          ],
        );

        await manager.query(`UPDATE auth.tenants SET user_count = 1 WHERE id = $1`, [
          command.tenantId,
        ]);

        return { userId };
      });

      return {
        success: true,
        userId: result.userId,
        email: command.email,
        invitationToken: rawInvitationToken,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`createTenantAdmin failed: ${message}`);
      return { success: false, errorCode: 'INTERNAL_ERROR', error: message };
    }
  }

  @MessagePattern(AUTH_ADMIN_COMMAND_SUBJECTS.CLAIM_TENANT_PROVISIONING)
  async claimTenantProvisioning(
    @Payload() command: AdminClaimTenantProvisioningCommand,
  ): Promise<AdminClaimTenantProvisioningResult> {
    try {
      const rows = await this.dataSource.query<{ id: string }[]>(
        `UPDATE auth.tenants
            SET status = $2, "updatedAt" = NOW()
          WHERE id = $1 AND status = ANY($3::text[])
          RETURNING id`,
        [command.tenantId, command.provisioningStatus, command.allowedStatuses],
      );
      if (rows.length > 0) {
        return { success: true, claimed: true };
      }

      const tenant = await this.findTenantStatus(command.tenantId);
      if (!tenant) {
        return { success: false, errorCode: 'TENANT_NOT_FOUND', error: 'Tenant not found' };
      }
      return {
        success: false,
        errorCode: 'INVALID_STATUS',
        error: `Tenant status ${tenant.status} is not claimable`,
      };
    } catch (err) {
      return this.internalError<AdminClaimTenantProvisioningResult>('claimTenantProvisioning', err);
    }
  }

  @MessagePattern(AUTH_ADMIN_COMMAND_SUBJECTS.SET_TENANT_STATUS)
  async setTenantStatus(
    @Payload() command: AdminSetTenantStatusCommand,
  ): Promise<AdminSetTenantStatusResult> {
    try {
      const rows = await this.dataSource.query<{ id: string }[]>(
        `UPDATE auth.tenants
            SET status = $2, "updatedAt" = NOW()
          WHERE id = $1 AND ($3::text IS NULL OR status = $3)
          RETURNING id`,
        [command.tenantId, command.status, command.expectedStatus ?? null],
      );
      if (rows.length > 0) {
        return { success: true, updated: true };
      }

      const tenant = await this.findTenantStatus(command.tenantId);
      if (!tenant) {
        return { success: false, errorCode: 'TENANT_NOT_FOUND', error: 'Tenant not found' };
      }
      return {
        success: false,
        errorCode: 'INVALID_STATUS',
        error: command.expectedStatus
          ? `Tenant status ${tenant.status} did not match expected ${command.expectedStatus}`
          : `Tenant ${command.tenantId} was not updated`,
      };
    } catch (err) {
      return this.internalError<AdminSetTenantStatusResult>('setTenantStatus', err);
    }
  }

  @MessagePattern(AUTH_ADMIN_COMMAND_SUBJECTS.UPDATE_TENANT_BILLING_STATE)
  async updateTenantBillingState(
    @Payload() command: AdminUpdateTenantBillingStateCommand,
  ): Promise<AdminUpdateTenantBillingStateResult> {
    try {
      const columns = await this.tenantColumns();
      const planColumn = columns.has('tier') ? 'tier' : 'plan';
      const assignments = [`${planColumn} = $2`, `"updatedAt" = NOW()`];
      const params: unknown[] = [command.tenantId, command.planTier];
      if (columns.has('limits')) {
        params.push(JSON.stringify(command.limits));
        assignments.splice(1, 0, `limits = $${params.length}`);
      }

      const rows = await this.dataSource.query<{ id: string }[]>(
        `UPDATE auth.tenants SET ${assignments.join(', ')} WHERE id = $1 RETURNING id`,
        params,
      );
      if (rows.length === 0) {
        return { success: false, errorCode: 'TENANT_NOT_FOUND', error: 'Tenant not found' };
      }
      return { success: true };
    } catch (err) {
      return this.internalError<AdminUpdateTenantBillingStateResult>(
        'updateTenantBillingState',
        err,
      );
    }
  }

  @MessagePattern(AUTH_ADMIN_COMMAND_SUBJECTS.SETUP_TENANT_ROLES)
  async setupTenantRoles(
    @Payload() command: AdminSetupTenantRolesCommand,
  ): Promise<AdminSetupTenantRolesResult> {
    try {
      if (!(await this.tenantExists(command.tenantId))) {
        return { success: false, errorCode: 'TENANT_NOT_FOUND', error: 'Tenant not found' };
      }

      let rolesCreated = 0;
      for (const role of command.roles) {
        const rows = await this.dataSource.query<{ id: string }[]>(
          `INSERT INTO auth.tenant_roles (
             id, "tenantId", code, name, description, permissions,
             is_default, is_editable, display_order, created_at, updated_at
           ) VALUES (
             gen_random_uuid(), $1, $2, $3, $4, $5::jsonb,
             $6, $7, $8, NOW(), NOW()
           )
           ON CONFLICT ("tenantId", code) DO NOTHING
           RETURNING id`,
          [
            command.tenantId,
            role.code,
            role.name,
            role.description,
            JSON.stringify(role.permissions),
            role.isDefault,
            role.isEditable,
            role.displayOrder,
          ],
        );
        rolesCreated += rows.length;
      }

      return { success: true, rolesCreated };
    } catch (err) {
      return this.internalError<AdminSetupTenantRolesResult>('setupTenantRoles', err);
    }
  }

  @MessagePattern(AUTH_ADMIN_COMMAND_SUBJECTS.ASSIGN_TENANT_MODULES)
  async assignTenantModules(
    @Payload() command: AdminAssignTenantModulesCommand,
  ): Promise<AdminAssignTenantModulesResult> {
    try {
      if (!(await this.tenantExists(command.tenantId))) {
        return { success: false, errorCode: 'TENANT_NOT_FOUND', error: 'Tenant not found' };
      }
      await this.assertModulesExist(command.modules.map((module) => module.moduleId));

      let modulesAssigned = 0;
      await this.dataSource.transaction(async (manager) => {
        for (const module of command.modules) {
          const rows = await manager.query<{ id: string }[]>(
            `INSERT INTO auth.tenant_modules (
               id, "tenantId", "moduleId", "isEnabled", "activatedAt",
               "expiresAt", "assignedBy", configuration, "createdAt", "updatedAt"
             ) VALUES (
               gen_random_uuid(), $1, $2, true, NOW(), $3, $4, $5::jsonb, NOW(), NOW()
             )
             ON CONFLICT ("tenantId", "moduleId") DO UPDATE SET
               "isEnabled" = true,
               "activatedAt" = NOW(),
               "expiresAt" = EXCLUDED."expiresAt",
               "assignedBy" = EXCLUDED."assignedBy",
               configuration = COALESCE(EXCLUDED.configuration, auth.tenant_modules.configuration),
               "updatedAt" = NOW()
             RETURNING id`,
            [
              command.tenantId,
              module.moduleId,
              module.expiresAt ?? null,
              module.assignedBy ?? command.tenantId,
              module.configuration ? JSON.stringify(module.configuration) : null,
            ],
          );
          modulesAssigned += rows.length;
        }
      });

      return { success: true, modulesAssigned };
    } catch (err) {
      return this.mapTenantModuleError('assignTenantModules', err) as AdminAssignTenantModulesResult;
    }
  }

  @MessagePattern(AUTH_ADMIN_COMMAND_SUBJECTS.REMOVE_TENANT_AUTH_RESOURCES)
  async removeTenantAuthResources(
    @Payload() command: AdminRemoveTenantAuthResourcesCommand,
  ): Promise<AdminRemoveTenantAuthResourcesResult> {
    try {
      if (!(await this.tenantExists(command.tenantId))) {
        return { success: false, errorCode: 'TENANT_NOT_FOUND', error: 'Tenant not found' };
      }

      await this.dataSource.transaction(async (manager) => {
        if (command.removeInvitations ?? true) {
          await manager.query(`DELETE FROM auth.invitations WHERE "tenantId" = $1`, [
            command.tenantId,
          ]);
        }
        if (command.deactivateUsers ?? true) {
          await manager.query(
            `UPDATE auth.users
                SET "isActive" = false, "updatedAt" = NOW()
              WHERE "tenantId" = $1`,
            [command.tenantId],
          );
        }
        if (command.removeTenantModules ?? true) {
          await manager.query(`DELETE FROM auth.tenant_modules WHERE "tenantId" = $1`, [
            command.tenantId,
          ]);
        }
        if (command.removeTenantRoles ?? true) {
          await manager.query(`DELETE FROM auth.tenant_roles WHERE "tenantId" = $1`, [
            command.tenantId,
          ]);
        }
      });

      return { success: true };
    } catch (err) {
      return this.internalError<AdminRemoveTenantAuthResourcesResult>(
        'removeTenantAuthResources',
        err,
      );
    }
  }

  @MessagePattern(AUTH_ADMIN_COMMAND_SUBJECTS.CREATE_MODULE)
  async createModule(
    @Payload() command: AdminCreateModuleCommand,
  ): Promise<AdminModuleMutationResult> {
    try {
      const rows = await this.dataSource.query<ModuleRow[]>(
        `INSERT INTO auth.modules (
           code, name, description, "defaultRoute", icon, is_core, "isActive", price
         ) VALUES ($1, $2, $3, $4, $5, $6, true, $7)
         RETURNING ${this.moduleSelectColumns()}`,
        [
          command.code,
          command.name,
          command.description ?? null,
          command.defaultRoute,
          command.icon ?? null,
          command.isCore ?? false,
          command.price ?? 0,
        ],
      );
      return { success: true, module: this.toModuleResult(rows[0]!) };
    } catch (err) {
      return this.mapModuleError('createModule', err);
    }
  }

  @MessagePattern(AUTH_ADMIN_COMMAND_SUBJECTS.UPDATE_MODULE)
  async updateModule(
    @Payload() command: AdminUpdateModuleCommand,
  ): Promise<AdminModuleMutationResult> {
    const updates: string[] = [];
    const params: unknown[] = [command.moduleId];

    const add = (sql: string, value: unknown): void => {
      params.push(value);
      updates.push(`${sql} = $${params.length}`);
    };
    if (command.name !== undefined) add('name', command.name);
    if (command.description !== undefined) add('description', command.description);
    if (command.defaultRoute !== undefined) add('"defaultRoute"', command.defaultRoute);
    if (command.icon !== undefined) add('icon', command.icon);
    if (command.isActive !== undefined) add('"isActive"', command.isActive);
    if (command.price !== undefined) add('price', command.price);

    try {
      if (updates.length === 0) {
        return this.findModuleMutation(command.moduleId);
      }

      const rows = await this.dataSource.query<ModuleRow[]>(
        `UPDATE auth.modules
            SET ${updates.join(', ')}, "updatedAt" = NOW()
          WHERE id = $1
          RETURNING ${this.moduleSelectColumns()}`,
        params,
      );
      if (rows.length === 0) {
        return { success: false, errorCode: 'MODULE_NOT_FOUND', error: 'Module not found' };
      }
      return { success: true, module: this.toModuleResult(rows[0]!) };
    } catch (err) {
      return this.mapModuleError('updateModule', err);
    }
  }

  @MessagePattern(AUTH_ADMIN_COMMAND_SUBJECTS.DELETE_MODULE)
  async deleteModule(
    @Payload() command: AdminDeleteModuleCommand,
  ): Promise<AdminDeleteModuleResult> {
    try {
      const assignments = await this.dataSource.query<{ count: string }[]>(
        `SELECT COUNT(*)::text as count FROM auth.tenant_modules WHERE "moduleId" = $1`,
        [command.moduleId],
      );
      if (parseInt(assignments[0]?.count ?? '0', 10) > 0) {
        return {
          success: false,
          errorCode: 'MODULE_ASSIGNED',
          error: 'Cannot delete module that is assigned to tenants',
        };
      }

      const rows = await this.dataSource.query<{ id: string }[]>(
        `DELETE FROM auth.modules WHERE id = $1 RETURNING id`,
        [command.moduleId],
      );
      if (rows.length === 0) {
        return { success: false, errorCode: 'MODULE_NOT_FOUND', error: 'Module not found' };
      }
      return { success: true };
    } catch (err) {
      return this.internalError<AdminDeleteModuleResult>('deleteModule', err);
    }
  }

  @MessagePattern(AUTH_ADMIN_COMMAND_SUBJECTS.UPSERT_TENANT_MODULE)
  async upsertTenantModule(
    @Payload() command: AdminUpsertTenantModuleCommand,
  ): Promise<AdminTenantModuleMutationResult> {
    try {
      if (!(await this.tenantExists(command.tenantId))) {
        return { success: false, errorCode: 'TENANT_NOT_FOUND', error: 'Tenant not found' };
      }
      await this.assertModulesExist([command.moduleId]);

      const configuration = {
        ...(command.configuration ?? {}),
        ...(command.quantities ? { quantities: command.quantities } : {}),
      };
      const rows = await this.dataSource.query<TenantModuleRow[]>(
        `INSERT INTO auth.tenant_modules (
           id, "tenantId", "moduleId", "isEnabled", "activatedAt",
           "expiresAt", "assignedBy", configuration, "createdAt", "updatedAt"
         ) VALUES (
           gen_random_uuid(), $1, $2, true, NOW(), $3, $4, $5::jsonb, NOW(), NOW()
         )
         ON CONFLICT ("tenantId", "moduleId") DO UPDATE SET
           "isEnabled" = true,
           "expiresAt" = EXCLUDED."expiresAt",
           "assignedBy" = EXCLUDED."assignedBy",
           configuration = COALESCE(EXCLUDED.configuration, auth.tenant_modules.configuration),
           "updatedAt" = NOW()
         RETURNING id, "tenantId", "moduleId", "activatedAt", "expiresAt", configuration`,
        [
          command.tenantId,
          command.moduleId,
          command.expiresAt ?? null,
          command.assignedBy ?? command.tenantId,
          JSON.stringify(configuration),
        ],
      );
      return { success: true, assignment: this.toTenantModuleResult(rows[0]!) };
    } catch (err) {
      return this.mapTenantModuleError('upsertTenantModule', err) as AdminTenantModuleMutationResult;
    }
  }

  @MessagePattern(AUTH_ADMIN_COMMAND_SUBJECTS.REMOVE_TENANT_MODULE)
  async removeTenantModule(
    @Payload() command: AdminRemoveTenantModuleCommand,
  ): Promise<AdminTenantModuleMutationResult> {
    try {
      const rows = await this.dataSource.query<TenantModuleRow[]>(
        command.softDisable
          ? `UPDATE auth.tenant_modules
                SET "isEnabled" = false, "updatedAt" = NOW()
              WHERE "tenantId" = $1 AND "moduleId" = $2 AND "isEnabled" = true
              RETURNING id, "tenantId", "moduleId", "activatedAt", "expiresAt", configuration`
          : `DELETE FROM auth.tenant_modules
              WHERE "tenantId" = $1 AND "moduleId" = $2
              RETURNING id, "tenantId", "moduleId", "activatedAt", "expiresAt", configuration`,
        [command.tenantId, command.moduleId],
      );
      if (rows.length === 0) {
        return {
          success: false,
          errorCode: 'ASSIGNMENT_NOT_FOUND',
          error: 'Tenant module assignment not found',
        };
      }
      return { success: true, assignment: this.toTenantModuleResult(rows[0]!) };
    } catch (err) {
      return this.mapTenantModuleError('removeTenantModule', err) as AdminTenantModuleMutationResult;
    }
  }

  @MessagePattern(AUTH_ADMIN_COMMAND_SUBJECTS.CREATE_TENANT_ROLE)
  async createTenantRole(
    @Payload() command: AdminCreateTenantRoleCommand,
  ): Promise<AdminTenantRoleMutationResult> {
    try {
      const roleId = await this.dataSource.transaction(async (manager) => {
        if (command.isDefault) {
          await manager.query(
            `UPDATE auth.tenant_roles
                SET is_default = false
              WHERE "tenantId" = $1 AND is_default = true`,
            [command.tenantId],
          );
        }
        const roleRows = await manager.query<{ id: string }[]>(
          `INSERT INTO auth.tenant_roles (
             "tenantId", name, description, color, icon, level,
             is_system, is_default, created_by, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8, NOW(), NOW())
           RETURNING id`,
          [
            command.tenantId,
            command.name,
            command.description ?? null,
            command.color ?? '#6366F1',
            command.icon ?? 'shield',
            command.level ?? 50,
            command.isDefault ?? false,
            command.createdBy,
          ],
        );
        const createdRole = roleRows[0];
        if (!createdRole) {
          throw new Error('Tenant role insert returned no role id');
        }
        const newRoleId = createdRole.id;
        await manager.query(
          `INSERT INTO auth.tenant_role_permissions (
             role_id, panel_permissions, resource_permissions, created_at, updated_at
           ) VALUES ($1, $2::jsonb, $3, NOW(), NOW())`,
          [
            newRoleId,
            JSON.stringify(command.panelPermissions),
            panelPermissionsToResourceArray(command.panelPermissions),
          ],
        );
        return newRoleId;
      });
      return { success: true, roleId };
    } catch (err) {
      return this.mapRoleError('createTenantRole', err);
    }
  }

  @MessagePattern(AUTH_ADMIN_COMMAND_SUBJECTS.UPDATE_TENANT_ROLE)
  async updateTenantRole(
    @Payload() command: AdminUpdateTenantRoleCommand,
  ): Promise<AdminTenantRoleMutationResult> {
    try {
      await this.dataSource.transaction(async (manager) => {
        if (command.isDefault) {
          await manager.query(
            `UPDATE auth.tenant_roles
                SET is_default = false
              WHERE "tenantId" = $1 AND is_default = true AND id <> $2`,
            [command.tenantId, command.roleId],
          );
        }

        const updates: string[] = [];
        const values: unknown[] = [];
        const add = (column: string, value: unknown): void => {
          values.push(value);
          updates.push(`${column} = $${values.length}`);
        };
        if (command.name !== undefined) add('name', command.name);
        if (command.description !== undefined) add('description', command.description);
        if (command.color !== undefined) add('color', command.color);
        if (command.icon !== undefined) add('icon', command.icon);
        if (command.level !== undefined) add('level', command.level);
        if (command.isDefault !== undefined) add('is_default', command.isDefault);

        if (updates.length > 0) {
          values.push(command.tenantId, command.roleId);
          await manager.query(
            `UPDATE auth.tenant_roles
                SET ${updates.join(', ')}, updated_at = NOW()
              WHERE "tenantId" = $${values.length - 1} AND id = $${values.length}`,
            values,
          );
        }

        if (command.panelPermissions) {
          await manager.query(
            `UPDATE auth.tenant_role_permissions
                SET panel_permissions = $1::jsonb,
                    resource_permissions = $2,
                    updated_at = NOW()
              WHERE role_id = $3`,
            [
              JSON.stringify(command.panelPermissions),
              panelPermissionsToResourceArray(command.panelPermissions),
              command.roleId,
            ],
          );
        }
      });
      return { success: true, roleId: command.roleId };
    } catch (err) {
      return this.mapRoleError('updateTenantRole', err);
    }
  }

  @MessagePattern(AUTH_ADMIN_COMMAND_SUBJECTS.DELETE_TENANT_ROLE)
  async deleteTenantRole(
    @Payload() command: AdminDeleteTenantRoleCommand,
  ): Promise<AdminTenantRoleMutationResult> {
    try {
      const rows = await this.dataSource.query<{ id: string }[]>(
        `DELETE FROM auth.tenant_roles
          WHERE "tenantId" = $1 AND id = $2
          RETURNING id`,
        [command.tenantId, command.roleId],
      );
      if (rows.length === 0) {
        return { success: false, errorCode: 'ROLE_NOT_FOUND', error: 'Role not found' };
      }
      return { success: true, roleId: command.roleId };
    } catch (err) {
      return this.mapRoleError('deleteTenantRole', err);
    }
  }

  @MessagePattern(AUTH_ADMIN_COMMAND_SUBJECTS.SEED_TENANT_ROLES)
  async seedTenantRoles(
    @Payload() command: AdminSeedTenantRolesCommand,
  ): Promise<AdminTenantRoleMutationResult> {
    try {
      let rolesCreated = 0;
      await this.dataSource.transaction(async (manager) => {
        for (const roleTemplate of command.roles) {
          const roleRows = await manager.query<{ id: string }[]>(
            `INSERT INTO auth.tenant_roles (
               "tenantId", name, description, color, icon, level,
               is_system, is_default, created_by, created_at, updated_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
             RETURNING id`,
            [
              command.tenantId,
              roleTemplate.name,
              roleTemplate.description,
              roleTemplate.color,
              roleTemplate.icon,
              roleTemplate.level,
              roleTemplate.isSystem,
              roleTemplate.isDefault,
              command.createdBy,
            ],
          );
          const createdRole = roleRows[0];
          if (!createdRole) {
            throw new Error(`Tenant role seed returned no id for ${roleTemplate.name}`);
          }
          const roleId = createdRole.id;
          await manager.query(
            `INSERT INTO auth.tenant_role_permissions (
               role_id, panel_permissions, resource_permissions, created_at, updated_at
             ) VALUES ($1, $2::jsonb, $3, NOW(), NOW())`,
            [
              roleId,
              JSON.stringify(roleTemplate.panelPermissions),
              panelPermissionsToResourceArray(roleTemplate.panelPermissions),
            ],
          );
          rolesCreated += 1;
        }
      });
      return { success: true, rolesCreated };
    } catch (err) {
      return this.mapRoleError('seedTenantRoles', err);
    }
  }

  @MessagePattern(AUTH_ADMIN_COMMAND_SUBJECTS.ASSIGN_USER_ROLE)
  async assignUserRole(
    @Payload() command: AdminAssignUserRoleCommand,
  ): Promise<AdminUserRoleAssignmentMutationResult> {
    try {
      await this.dataSource.query(
        `INSERT INTO auth.user_role_assignments (
           user_id, role_id, permission_overrides, assigned_by,
           assigned_at, expires_at, is_active, created_at, updated_at
         ) VALUES ($1, $2, $3::jsonb, $4, NOW(), $5, true, NOW(), NOW())`,
        [
          command.userId,
          command.roleId,
          JSON.stringify(command.permissionOverrides),
          command.assignedBy,
          command.expiresAt ?? null,
        ],
      );
      return { success: true };
    } catch (err) {
      return this.mapAssignmentError('assignUserRole', err);
    }
  }

  @MessagePattern(AUTH_ADMIN_COMMAND_SUBJECTS.UPDATE_USER_ROLE_ASSIGNMENT)
  async updateUserRoleAssignment(
    @Payload() command: AdminUpdateUserRoleAssignmentCommand,
  ): Promise<AdminUserRoleAssignmentMutationResult> {
    const updates: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown): void => {
      values.push(value);
      updates.push(`${column} = $${values.length}`);
    };
    if (command.roleId !== undefined) add('role_id', command.roleId);
    if (command.permissionOverrides !== undefined) {
      add('permission_overrides', JSON.stringify(command.permissionOverrides));
    }
    if (command.expiresAt !== undefined) add('expires_at', command.expiresAt);
    if (command.isActive !== undefined) add('is_active', command.isActive);

    try {
      if (updates.length === 0) {
        return { success: true };
      }
      values.push(command.tenantId, command.userId);
      const rows = await this.dataSource.query<{ user_id: string }[]>(
        `UPDATE auth.user_role_assignments a
            SET ${updates.join(', ')}, updated_at = NOW()
           FROM auth.tenant_roles r
          WHERE a.role_id = r.id
            AND r."tenantId" = $${values.length - 1}
            AND a.user_id = $${values.length}
          RETURNING a.user_id`,
        values,
      );
      if (rows.length === 0) {
        return {
          success: false,
          errorCode: 'ASSIGNMENT_NOT_FOUND',
          error: 'Role assignment not found',
        };
      }
      return { success: true };
    } catch (err) {
      return this.mapAssignmentError('updateUserRoleAssignment', err);
    }
  }

  @MessagePattern(AUTH_ADMIN_COMMAND_SUBJECTS.REVOKE_USER_ROLE_ASSIGNMENT)
  async revokeUserRoleAssignment(
    @Payload() command: AdminRevokeUserRoleAssignmentCommand,
  ): Promise<AdminUserRoleAssignmentMutationResult> {
    try {
      const rows = await this.dataSource.query<{ user_id: string }[]>(
        `DELETE FROM auth.user_role_assignments a
          USING auth.tenant_roles r
          WHERE a.role_id = r.id AND r."tenantId" = $1 AND a.user_id = $2
          RETURNING a.user_id`,
        [command.tenantId, command.userId],
      );
      if (rows.length === 0) {
        return {
          success: false,
          errorCode: 'ASSIGNMENT_NOT_FOUND',
          error: 'Role assignment not found',
        };
      }
      return { success: true };
    } catch (err) {
      return this.mapAssignmentError('revokeUserRoleAssignment', err);
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

  private async tenantExists(tenantId: string): Promise<boolean> {
    return (await this.findTenantStatus(tenantId)) !== null;
  }

  private async findTenantStatus(tenantId: string): Promise<{ status: string } | null> {
    const rows = await this.dataSource.query<{ status: string }[]>(
      `SELECT status FROM auth.tenants WHERE id = $1`,
      [tenantId],
    );
    return rows[0] ?? null;
  }

  private async tenantColumns(): Promise<Set<string>> {
    const rows = await this.dataSource.query<{ column_name: string }[]>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'auth' AND table_name = 'tenants'`,
    );
    return new Set(rows.map((row) => row.column_name));
  }

  private async assertModulesExist(moduleIds: string[]): Promise<void> {
    const unique = [...new Set(moduleIds)];
    if (unique.length === 0) return;
    const rows = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM auth.modules WHERE id = ANY($1::uuid[])`,
      [unique],
    );
    if (rows.length !== unique.length) {
      throw new NotFoundException('One or more modules were not found');
    }
  }

  private moduleSelectColumns(): string {
    return `id, code, name, description, "defaultRoute", icon,
      COALESCE(is_core, false) as "isCore",
      "isActive", COALESCE(price, 0)::float as price,
      "createdAt", "updatedAt"`;
  }

  private async findModuleMutation(moduleId: string): Promise<AdminModuleMutationResult> {
    const rows = await this.dataSource.query<ModuleRow[]>(
      `SELECT ${this.moduleSelectColumns()} FROM auth.modules WHERE id = $1`,
      [moduleId],
    );
    if (rows.length === 0) {
      return { success: false, errorCode: 'MODULE_NOT_FOUND', error: 'Module not found' };
    }
    return { success: true, module: this.toModuleResult(rows[0]!) };
  }

  private toModuleResult(row: ModuleRow): NonNullable<AdminModuleMutationResult['module']> {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      description: row.description ?? null,
      defaultRoute: row.defaultRoute,
      icon: row.icon ?? null,
      isCore: row.isCore,
      isActive: row.isActive,
      price: row.price,
      createdAt: row.createdAt?.toISOString?.() ?? String(row.createdAt),
      updatedAt: row.updatedAt?.toISOString?.() ?? String(row.updatedAt),
    };
  }

  private toTenantModuleResult(
    row: TenantModuleRow,
  ): NonNullable<AdminTenantModuleMutationResult['assignment']> {
    const configuration = row.configuration ?? {};
    const quantities =
      typeof configuration === 'object' && configuration !== null
        ? (configuration['quantities'] as Record<string, unknown> | undefined)
        : undefined;
    return {
      id: row.id,
      tenantId: row.tenantId,
      moduleId: row.moduleId,
      assignedAt: row.activatedAt.toISOString?.() ?? String(row.activatedAt),
      expiresAt: row.expiresAt ? row.expiresAt.toISOString?.() ?? String(row.expiresAt) : null,
      quantities,
      configuration,
    };
  }

  private mapModuleError(operation: string, err: unknown): AdminModuleMutationResult {
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      return { success: false, errorCode: 'DUPLICATE_CODE', error: 'Module code already exists' };
    }
    this.logger.warn(`${operation} failed: ${(err as Error).message}`);
    return { success: false, errorCode: 'INTERNAL_ERROR', error: (err as Error).message };
  }

  private mapTenantModuleError(
    operation: string,
    err: unknown,
  ): AdminAssignTenantModulesResult | AdminTenantModuleMutationResult {
    if (err instanceof NotFoundException) {
      return { success: false, errorCode: 'MODULE_NOT_FOUND', error: err.message };
    }
    this.logger.warn(`${operation} failed: ${(err as Error).message}`);
    return { success: false, errorCode: 'INTERNAL_ERROR', error: (err as Error).message };
  }

  private mapRoleError(operation: string, err: unknown): AdminTenantRoleMutationResult {
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      return { success: false, errorCode: 'DUPLICATE_ROLE', error: 'Role already exists' };
    }
    this.logger.warn(`${operation} failed: ${(err as Error).message}`);
    return { success: false, errorCode: 'INTERNAL_ERROR', error: (err as Error).message };
  }

  private mapAssignmentError(
    operation: string,
    err: unknown,
  ): AdminUserRoleAssignmentMutationResult {
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      return {
        success: false,
        errorCode: 'DUPLICATE_ASSIGNMENT',
        error: 'User already has a role assignment',
      };
    }
    if (code === '23503') {
      return { success: false, errorCode: 'ROLE_NOT_FOUND', error: 'Role not found' };
    }
    this.logger.warn(`${operation} failed: ${(err as Error).message}`);
    return { success: false, errorCode: 'INTERNAL_ERROR', error: (err as Error).message };
  }

  private internalError<TResult extends { success: boolean; errorCode?: string; error?: string }>(
    operation: string,
    err: unknown,
  ): TResult {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.warn(`${operation} failed: ${message}`);
    return { success: false, errorCode: 'INTERNAL_ERROR', error: message } as TResult;
  }
}

interface ModuleRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  defaultRoute: string;
  icon: string | null;
  isCore: boolean;
  isActive: boolean;
  price: number;
  createdAt: Date;
  updatedAt: Date;
}

interface TenantModuleRow {
  id: string;
  tenantId: string;
  moduleId: string;
  activatedAt: Date;
  expiresAt: Date | null;
  configuration: Record<string, unknown> | null;
}

function panelPermissionsToResourceArray(panel: Record<string, unknown>): string[] {
  const result: string[] = [];
  for (const resources of Object.values(panel)) {
    if (!resources || typeof resources !== 'object') continue;
    for (const [resource, actions] of Object.entries(resources as Record<string, unknown>)) {
      if (!actions || typeof actions !== 'object') continue;
      for (const [action, enabled] of Object.entries(actions as Record<string, unknown>)) {
        if (enabled === true) {
          result.push(`${resource}:${action}`);
        }
      }
    }
  }
  return result;
}
