import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';

export interface CreateFirstAdminDto {
  tenantId: string;
  email: string;
  firstName: string;
  lastName: string;
  createdBy: string;
}

export interface CreateFirstAdminResult {
  success: boolean;
  userId?: string;
  invitationToken?: string;
  temporaryPassword?: string;
  error?: string;
}

export interface UserLimitCheckResult {
  canCreate: boolean;
  currentCount: number;
  limit: number;
  remaining: number;
  message?: string;
}

export interface InviteUserDto {
  tenantId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: string;
  moduleIds?: string[];
  primaryModuleId?: string;
  invitedBy: string;
  message?: string;
}

export interface InviteUserResult {
  success: boolean;
  userId?: string;
  invitationId?: string;
  invitationToken?: string;
  error?: string;
}

@Injectable()
export class UserProvisioningService {
  private readonly logger = new Logger(UserProvisioningService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Create first tenant admin user during tenant provisioning
   * This creates a user with TENANT_ADMIN role and sends invitation
   */
  async createFirstTenantAdmin(
    dto: CreateFirstAdminDto,
  ): Promise<CreateFirstAdminResult> {
    const { tenantId, email, firstName, lastName, createdBy } = dto;

    try {
      // Check if tenant already has users
      const existingUserCount = await this.getTenantUserCount(tenantId);
      if (existingUserCount > 0) {
        return {
          success: false,
          error: 'Tenant already has users. Use invite endpoint instead.',
        };
      }

      // Check if email already exists
      const existingUser = await this.checkEmailExists(email);
      if (existingUser) {
        return {
          success: false,
          error: 'A user with this email already exists in the system.',
        };
      }

      // Generate invitation token and temporary password
      const invitationToken = this.generateSecureToken(64);
      const temporaryPassword = this.generateTemporaryPassword();
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7); // 7 days expiration

      // Create user and invitation in transaction
      const result = await this.dataSource.transaction(async (manager) => {
        // Create user with invitation token
        const userResult = await manager.query(
          `
          INSERT INTO users (
            id, email, first_name, last_name, role, tenant_id,
            is_active, is_email_verified, invitation_token, invitation_expires_at,
            invited_by, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), $1, $2, $3, 'TENANT_ADMIN', $4,
            true, false, $5, $6,
            $7, NOW(), NOW()
          )
          RETURNING id
        `,
          [email, firstName, lastName, tenantId, invitationToken, expiresAt, createdBy],
        );

        const userId = userResult[0].id;

        // Create invitation record for tracking
        await manager.query(
          `
          INSERT INTO invitations (
            id, token, email, first_name, last_name, role, tenant_id,
            status, expires_at, invited_by, send_count, last_sent_at, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), $1, $2, $3, $4, 'TENANT_ADMIN', $5,
            'PENDING', $6, $7, 1, NOW(), NOW(), NOW()
          )
          RETURNING id
        `,
          [invitationToken, email, firstName, lastName, tenantId, expiresAt, createdBy],
        );

        // Update tenant user count
        await manager.query(
          `UPDATE tenants SET user_count = user_count + 1 WHERE id = $1`,
          [tenantId],
        );

        return { userId, invitationToken };
      });

      this.logger.log(
        `Created first tenant admin for tenant ${tenantId}: ${email}`,
      );

      return {
        success: true,
        userId: result.userId,
        invitationToken: result.invitationToken,
        temporaryPassword,
      };
    } catch (error) {
      this.logger.error(
        `Failed to create first tenant admin: ${(error as Error).message}`,
        (error as Error).stack,
      );

      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Check if tenant can add more users based on plan limits
   */
  async checkUserLimit(tenantId: string): Promise<UserLimitCheckResult> {
    try {
      const result = await this.dataSource.query(
        `
        SELECT
          t.user_count as current_count,
          t.limits->>'maxUsers' as max_users,
          t.tier
        FROM tenants t
        WHERE t.id = $1
      `,
        [tenantId],
      );

      if (!result || result.length === 0) {
        return {
          canCreate: false,
          currentCount: 0,
          limit: 0,
          remaining: 0,
          message: 'Tenant not found',
        };
      }

      const tenant = result[0];
      const currentCount = parseInt(tenant.current_count || '0', 10);
      const limit = parseInt(tenant.max_users || '0', 10);

      // -1 means unlimited
      if (limit === -1) {
        return {
          canCreate: true,
          currentCount,
          limit: -1,
          remaining: -1,
          message: 'Unlimited users allowed',
        };
      }

      const remaining = limit - currentCount;
      const canCreate = remaining > 0;

      return {
        canCreate,
        currentCount,
        limit,
        remaining: Math.max(0, remaining),
        message: canCreate
          ? `${remaining} user slots remaining`
          : `User limit reached (${limit} users). Upgrade plan to add more users.`,
      };
    } catch (error) {
      this.logger.error(
        `Failed to check user limit: ${(error as Error).message}`,
      );
      return {
        canCreate: false,
        currentCount: 0,
        limit: 0,
        remaining: 0,
        message: 'Failed to check user limit',
      };
    }
  }

  /**
   * Invite a new user to tenant
   * Enforces user limits and role hierarchy
   */
  async inviteUser(dto: InviteUserDto): Promise<InviteUserResult> {
    const {
      tenantId,
      email,
      firstName,
      lastName,
      role,
      moduleIds,
      primaryModuleId,
      invitedBy,
      message,
    } = dto;

    // Check user limit
    const limitCheck = await this.checkUserLimit(tenantId);
    if (!limitCheck.canCreate) {
      return {
        success: false,
        error: limitCheck.message,
      };
    }

    // Check if email already exists
    const existingUser = await this.checkEmailExists(email);
    if (existingUser) {
      return {
        success: false,
        error: 'A user with this email already exists in the system.',
      };
    }

    // Validate role hierarchy
    const roleValidation = await this.validateRoleHierarchy(
      tenantId,
      invitedBy,
      role,
    );
    if (!roleValidation.valid) {
      return {
        success: false,
        error: roleValidation.message,
      };
    }

    try {
      const invitationToken = this.generateSecureToken(64);
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

      const result = await this.dataSource.transaction(async (manager) => {
        // Create user with invitation token
        const userResult = await manager.query(
          `
          INSERT INTO users (
            id, email, first_name, last_name, role, tenant_id,
            is_active, is_email_verified, invitation_token, invitation_expires_at,
            invited_by, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), $1, $2, $3, $4, $5,
            true, false, $6, $7,
            $8, NOW(), NOW()
          )
          RETURNING id
        `,
          [
            email,
            firstName,
            lastName,
            role,
            tenantId,
            invitationToken,
            expiresAt,
            invitedBy,
          ],
        );

        const userId = userResult[0].id;

        // Create invitation record
        const invitationResult = await manager.query(
          `
          INSERT INTO invitations (
            id, token, email, first_name, last_name, role, tenant_id,
            module_ids, primary_module_id, status, expires_at,
            invited_by, message, send_count, last_sent_at, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), $1, $2, $3, $4, $5, $6,
            $7, $8, 'PENDING', $9,
            $10, $11, 1, NOW(), NOW(), NOW()
          )
          RETURNING id
        `,
          [
            invitationToken,
            email,
            firstName,
            lastName,
            role,
            tenantId,
            moduleIds ? moduleIds.join(',') : null,
            primaryModuleId,
            expiresAt,
            invitedBy,
            message,
          ],
        );

        // Assign modules if provided
        if (moduleIds && moduleIds.length > 0) {
          for (const moduleId of moduleIds) {
            await manager.query(
              `
              INSERT INTO user_module_assignments (
                id, user_id, module_id, tenant_id, is_active,
                can_read, can_write, can_delete, can_manage,
                assigned_by, created_at, updated_at
              ) VALUES (
                gen_random_uuid(), $1, $2, $3, true,
                true, true, false, false,
                $4, NOW(), NOW()
              )
            `,
              [userId, moduleId, tenantId, invitedBy],
            );
          }
        }

        // Update tenant user count
        await manager.query(
          `UPDATE tenants SET user_count = user_count + 1 WHERE id = $1`,
          [tenantId],
        );

        return {
          userId,
          invitationId: invitationResult[0].id,
          invitationToken,
        };
      });

      this.logger.log(`User invited: ${email} to tenant ${tenantId}`);

      return {
        success: true,
        userId: result.userId,
        invitationId: result.invitationId,
        invitationToken: result.invitationToken,
      };
    } catch (error) {
      this.logger.error(
        `Failed to invite user: ${(error as Error).message}`,
        (error as Error).stack,
      );

      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Validate that inviter can create user with the given role
   */
  private async validateRoleHierarchy(
    tenantId: string,
    inviterId: string,
    targetRole: string,
  ): Promise<{ valid: boolean; message?: string }> {
    try {
      // Get inviter's role
      const inviterResult = await this.dataSource.query(
        `SELECT role, tenant_id FROM users WHERE id = $1`,
        [inviterId],
      );

      if (!inviterResult || inviterResult.length === 0) {
        return { valid: false, message: 'Inviter not found' };
      }

      const inviter = inviterResult[0];
      const inviterRole = inviter.role;

      // Role hierarchy: SUPER_ADMIN > TENANT_ADMIN > MODULE_MANAGER > MODULE_USER
      const roleHierarchy: Record<string, number> = {
        SUPER_ADMIN: 4,
        TENANT_ADMIN: 3,
        MODULE_MANAGER: 2,
        MODULE_USER: 1,
      };

      const inviterLevel = roleHierarchy[inviterRole] ?? 0;
      const targetLevel = roleHierarchy[targetRole] ?? 0;

      // SUPER_ADMIN can create any role
      if (inviterRole === 'SUPER_ADMIN') {
        return { valid: true };
      }

      // TENANT_ADMIN can only create roles within their tenant
      if (inviterRole === 'TENANT_ADMIN') {
        if (inviter.tenant_id !== tenantId) {
          return {
            valid: false,
            message: 'Cannot invite users to a different tenant',
          };
        }
        // Can create TENANT_ADMIN, MODULE_MANAGER, or MODULE_USER
        if (targetLevel <= inviterLevel) {
          return { valid: true };
        }
        return {
          valid: false,
          message: 'Cannot create user with higher role than your own',
        };
      }

      // MODULE_MANAGER can only create MODULE_USER
      if (inviterRole === 'MODULE_MANAGER') {
        if (inviter.tenant_id !== tenantId) {
          return {
            valid: false,
            message: 'Cannot invite users to a different tenant',
          };
        }
        if (targetRole === 'MODULE_USER') {
          return { valid: true };
        }
        return {
          valid: false,
          message: 'Module managers can only invite module users',
        };
      }

      return {
        valid: false,
        message: 'You do not have permission to invite users',
      };
    } catch (error) {
      return { valid: false, message: 'Failed to validate role hierarchy' };
    }
  }

  private async getTenantUserCount(tenantId: string): Promise<number> {
    const result = await this.dataSource.query(
      `SELECT COUNT(*) as count FROM users WHERE tenant_id = $1`,
      [tenantId],
    );
    return parseInt(result[0]?.count || '0', 10);
  }

  private async checkEmailExists(email: string): Promise<boolean> {
    const result = await this.dataSource.query(
      `SELECT id FROM users WHERE LOWER(email) = LOWER($1)`,
      [email],
    );
    return result && result.length > 0;
  }

  private generateSecureToken(length: number): string {
    return crypto.randomBytes(length).toString('hex').substring(0, length);
  }

  private generateTemporaryPassword(): string {
    // Generate a secure temporary password: 16 chars with upper, lower, numbers, special
    const chars =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
    let password = '';
    const randomBytes = crypto.randomBytes(16);
    for (let i = 0; i < 16; i++) {
      const byte = randomBytes[i];
      if (byte !== undefined) {
        password += chars[byte % chars.length];
      }
    }
    return password;
  }
}
