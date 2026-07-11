import { createHash } from 'node:crypto';

import { Role } from '@aquaculture/backend-common/decorators';
import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { UserInvitedEvent, createBaseEvent } from '@platform/event-contracts';
import { Repository, DataSource } from 'typeorm';

import { AuditLogSeverity } from '../../../audit/audit-log.entity';
import { AuditLogService } from '../../../audit/audit-log.service';
import { BestEffortEventPublisher } from '../../../outbox/best-effort-event-publisher';
// WHY: Import AccessType so createTenantUser and updateTenantUser can accept and
// persist the platform access level chosen by the tenant admin.
import { User, AccessType } from '../../authentication/entities/user.entity';
import { MobileUserSettings, DEFAULT_MOBILE_FEATURES } from '../entities/mobile-user-settings.entity';
import { Tenant } from '../entities/tenant.entity';

import {
  applyPermissionOverrides,
  parsePermissionOverrides as parsePermissionOverridesSSoT,
} from './permission-overrides.util';
import { CapabilityAuthorityService, ValidatedOverrideSet } from './capability-authority';
import { TenantRoleService, TenantRoleWithDetails } from './tenant-role.service';
import { UserLifecycleService } from './user-lifecycle.service';

/**
 * Raw-SQL trust boundary: dataSource.query returns untyped rows. Each
 * call site declares the row shape its SELECT/RETURNING projects, so
 * the any never propagates past the query line.
 */
function rowsAs<T extends object>(result: unknown): readonly T[] {
  return Array.isArray(result) ? (result as readonly T[]) : [];
}

/** Row shape of the user_role_assignments join used by role lookups. */
interface UserRoleAssignmentRow extends Record<string, unknown> {
  id: string;
  role_id: string;
  role_name: string;
  role_color: string | null;
  role_icon: string | null;
  role_level: number | null;
  permission_overrides: unknown;
  panel_permissions: unknown;
  resource_permissions: string[] | null;
}

/**
 * Created tenant user result
 */
export interface CreatedTenantUser {
  user: User;
  roleAssignment: UserRoleAssignmentResult;
  invitationSent: boolean;
}

/**
 * User role assignment result
 */
export interface UserRoleAssignmentResult {
  id: string;
  userId: string;
  roleId: string;
  roleName: string;
  roleColor: string;
  roleIcon: string;
  roleLevel: number;
  permissionOverrides: {
    grants: string[];
    revokes: string[];
  };
  panelPermissions: Record<string, Record<string, Record<string, boolean>>>;
  resourcePermissions: string[];
  effectivePermissions: string[];
  isActive: boolean;
  expiresAt: Date | null;
  assignedAt: Date;
  assignedBy: string;
}

/**
 * Effective permissions result
 */
export interface EffectivePermissionsResult {
  roleId: string;
  roleName: string;
  panelPermissions: Record<string, Record<string, Record<string, boolean>>>;
  resourcePermissions: string[];
  overrides: {
    grants: string[];
    revokes: string[];
  };
}

/**
 * Bulk assignment result
 */
export interface BulkAssignmentResult {
  success: string[];
  failed: Array<{ userId: string; error: string }>;
}

@Injectable()
export class TenantUserManagementService {
  private readonly logger = new Logger(TenantUserManagementService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    // WHY: MobileUserSettings repository needed for auto-provisioning/deactivating
    // mobile settings when accessType changes (MOBILE_ONLY, BOTH, PANEL_ONLY).
    @InjectRepository(MobileUserSettings)
    private readonly mobileSettingsRepository: Repository<MobileUserSettings>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly tenantRoleService: TenantRoleService,
    // DATA-HIGH-001: UserInvited routes through the allowlisted best-effort
    // path (the invitation row is its durable record). See ORPHAN-HIGH-090 for
    // the durable upgrade.
    private readonly bestEffort: BestEffortEventPublisher,
    private readonly auditLogService: AuditLogService,
    // WHY: UserLifecycleService is the single owner of the user-creation
    // pipeline (tenant validation, email uniqueness, invitation-token
    // hashing, mobile-settings provisioning, role assignment, invitation
    // delivery). This service previously carried a line-for-line duplicate
    // of that pipeline, which drifted — createTenantUser is a delegation
    // facade so exactly one creation path exists (SSoT).
    private readonly userLifecycleService: UserLifecycleService,
    // SECURITY (RBAC-C1/C2): the single write-time grant-authority SSoT. Every
    // path here that writes permission_overrides routes the grants through it so
    // a delegate cannot grant capabilities they do not hold or outside the
    // catalogue. The branded ValidatedOverrideSet it returns is the only value
    // createRoleAssignment accepts.
    private readonly capabilityAuthority: CapabilityAuthorityService,
  ) {}

  /**
   * Create a new user within a tenant schema and assign initial role.
   *
   * WHAT: thin facade over UserLifecycleService.createUser — see constructor
   * note. Tenant existence is validated up front so callers of this facade
   * get the same guard regardless of lifecycle-internal ordering.
   */
  async createTenantUser(
    tenantId: string,
    input: {
      firstName: string;
      lastName: string;
      email: string;
      password?: string;
      roleId: string;
      // WHY: accessType lets the tenant admin control which platforms a new user
      // can access. Defaults to BOTH for backward compatibility.
      accessType?: AccessType;
      permissionOverrides?: {
        grants: string[];
        revokes: string[];
      };
    },
    createdBy: string,
    sendInvitation = true,
  ): Promise<CreatedTenantUser> {
    // Validate tenant exists before delegating
    const tenant = await this.tenantRepository.findOne({ where: { id: tenantId } });
    if (!tenant) {
      throw new NotFoundException(`Tenant with ID "${tenantId}" not found`);
    }

    return this.userLifecycleService.createUser(tenantId, input, createdBy, sendInvitation);
  }

  /**
   * Update a tenant user's profile fields (firstName, lastName) and optionally their role assignment
   */
  async updateTenantUser(
    tenantId: string,
    userId: string,
    input: {
      firstName?: string;
      lastName?: string;
      roleId?: string;
      // WHY: accessType in update allows tenant admin to change platform access
      // after user creation. Service handles mobile settings lifecycle.
      accessType?: AccessType;
    },
    updatedBy: string,
  ): Promise<User> {
    // SECURITY: Prevent self-demotion / self-modification of role
    // (profile field changes on self are allowed)

    // Validate user exists and belongs to tenant
    const user = await this.userRepository.findOne({
      where: { id: userId, tenantId },
    });
    if (!user) {
      throw new NotFoundException(`User with ID "${userId}" not found in tenant`);
    }

    // Update profile fields
    let profileChanged = false;
    if (input.firstName !== undefined) {
      user.firstName = input.firstName;
      profileChanged = true;
    }
    if (input.lastName !== undefined) {
      user.lastName = input.lastName;
      profileChanged = true;
    }

    // WHY: Process accessType change separately from profile fields because it
    // triggers side effects (mobile settings provisioning/deactivation).
    if (input.accessType !== undefined && input.accessType !== user.accessType) {
      const oldAccessType = user.accessType;
      user.accessType = input.accessType;
      profileChanged = true;

      const hadMobileAccess = oldAccessType === AccessType.MOBILE_ONLY || oldAccessType === AccessType.BOTH;
      const hasMobileAccess = input.accessType === AccessType.MOBILE_ONLY || input.accessType === AccessType.BOTH;

      if (!hadMobileAccess && hasMobileAccess) {
        // WHY: User gained mobile access — auto-provision mobile settings if they don't exist.
        try {
          const existing = await this.mobileSettingsRepository.findOne({ where: { userId, tenantId } });
          if (existing) {
            // Re-enable existing settings
            existing.isMobileEnabled = true;
            await this.mobileSettingsRepository.save(existing);
          } else {
            const mobileSettings = this.mobileSettingsRepository.create({
              userId,
              tenantId,
              allowedFeatures: { ...DEFAULT_MOBILE_FEATURES },
              isMobileEnabled: true,
            });
            await this.mobileSettingsRepository.save(mobileSettings);
          }
          this.logger.debug(`Provisioned mobile settings for user ${userId} (accessType -> ${input.accessType})`);
        } catch (mobileErr) {
          this.logger.warn(`Failed to provision mobile settings for ${userId}: ${(mobileErr as Error).message}`);
        }
      } else if (hadMobileAccess && !hasMobileAccess) {
        // WHY: User lost mobile access — deactivate mobile settings to enforce access restriction.
        try {
          const existing = await this.mobileSettingsRepository.findOne({ where: { userId, tenantId } });
          if (existing) {
            existing.isMobileEnabled = false;
            await this.mobileSettingsRepository.save(existing);
            this.logger.debug(`Deactivated mobile settings for user ${userId} (accessType -> PANEL_ONLY)`);
          }
        } catch (mobileErr) {
          this.logger.warn(`Failed to deactivate mobile settings for ${userId}: ${(mobileErr as Error).message}`);
        }
      }
    }

    if (profileChanged) {
      await this.userRepository.save(user);
      // SECURITY: Log user ID instead of email to prevent PII exposure in logs (H-14)
      this.logger.log(`Updated profile for userId=${userId} in tenant ${tenantId}`);
    }

    // Update role assignment if roleId is provided
    if (input.roleId) {
      // Validate new role exists in tenant
      const newRole = await this.tenantRoleService.getRoleById(tenantId, input.roleId);
      if (!newRole) {
        throw new NotFoundException(`Role with ID "${input.roleId}" not found in tenant`);
      }

      // SECURITY (SEC-MEDIUM-001): the dead "Prevent self-demotion" comment at
      // the top of this method never enforced anything — updateTenantUser was a
      // GraphQL-exposed (tenant-role.resolver) role-mutation surface with NO
      // self-target or upward-escalation guard, a horizontal-privilege hole
      // parallel to the one assignUserRole/updateUserRole already block. Route
      // the role-CHANGE path through the same authority ceiling check so an
      // admin cannot grant a role above their own level or rewrite their own
      // assignment via this path. Profile-only updates (no roleId) skip the
      // guard, so self profile edits stay allowed.
      await this.assertRoleGrantAuthority(tenantId, updatedBy, userId, newRole);

      // ORPHAN-CRITICAL-100: read the existing assignment from auth.* and launder
      // ownership through the tenant_roles JOIN — user_role_assignments has no
      // tenantId column, so the only proof the existing assignment belongs to
      // this tenant is that its role_id resolves to an in-tenant tenant_roles row
      // (tr."tenantId" = $2). A foreign-tenant assignment returns 0 rows and falls
      // to the create branch (which re-validates tenant ownership), never silently
      // mutated.
      const existingResult = rowsAs<{ id: string; role_id: string }>(
        await this.dataSource.query(
          `SELECT ura.id, ura.role_id
           FROM "auth"."user_role_assignments" ura
           JOIN "auth"."tenant_roles" tr ON tr.id = ura.role_id AND tr."tenantId" = $2
           WHERE ura.user_id = $1 AND ura.is_active = true`,
          [userId, tenantId],
        ),
      );
      const existing = existingResult[0];

      if (existing) {
        // Only update if role actually changed
        if (existing.role_id !== input.roleId) {
          // SECURITY (SEC-MEDIUM-002): the role UPDATE and its audit row commit
          // ATOMICALLY. Previously the audit was a swallowed try/catch AFTER the
          // committed UPDATE (fail-OPEN) — a role change could persist with no
          // evidence (SOC 2 CC6.1). A throwing audit now rolls back the UPDATE
          // (fail-CLOSED), matching updateUserRole. The audit log call is passed
          // `manager` so it writes on the SAME transaction connection (FINDING #5
          // — fail-CLOSED for real, not just in the comment).
          await this.dataSource.transaction(async (manager) => {
            // ORPHAN-CRITICAL-100: write-side FROM-join re-asserts tenant
            // ownership on the PRE-IMAGE role (you must own the row you mutate);
            // the new role was already validated in-tenant by getRoleById +
            // assertRoleGrantAuthority above.
            await manager.query(
              `UPDATE "auth"."user_role_assignments" ura
               SET role_id = $1, updated_at = NOW()
               FROM "auth"."tenant_roles" tr
               WHERE ura.id = $2 AND tr.id = ura.role_id AND tr."tenantId" = $3`,
              [input.roleId, existing.id, tenantId],
            );

            await this.auditLogService.log(
              {
                tenantId,
                performedBy: updatedBy,
                action: 'USER_ROLE_CHANGED',
                entityType: 'UserRoleAssignment',
                entityId: userId,
                previousValue: { roleId: existing.role_id },
                newValue: { roleId: input.roleId },
                details: {
                  newRoleName: newRole.name,
                  timestamp: new Date().toISOString(),
                },
                severity: AuditLogSeverity.WARNING,
              },
              manager,
            );
          });
          this.logger.log(`Updated role assignment for user ${userId} to role ${newRole.name} in tenant ${tenantId}`);
        }
      } else {
        // No existing assignment — create one through the shared
        // createRoleAssignment helper (D1 #3 / FINDING — Tier-1 "make it
        // impossible") so the INSERT...SELECT FROM auth.tenant_roles tenant
        // guard AND its manager-aware USER_ROLE_CHANGED audit live in exactly
        // ONE place, shared with assignUserRole. SECURITY (SEC-MEDIUM-002): the
        // INSERT and audit commit atomically (fail-CLOSED).
        await this.createRoleAssignment(
          tenantId,
          userId,
          input.roleId,
          newRole,
          // No per-user overrides on the create-on-assign branch — a validated
          // empty set (nothing to authorize).
          this.capabilityAuthority.emptyOverrides(),
          updatedBy,
          undefined,
        );
        this.logger.log(`Created role assignment for user ${userId} with role ${newRole.name} in tenant ${tenantId}`);
      }
    }

    // Return updated user
    const updatedUser = await this.userRepository.findOne({ where: { id: userId } });
    if (!updatedUser) {
      throw new NotFoundException(`User with ID "${userId}" disappeared during update`);
    }
    return updatedUser;
  }

  /**
   * Soft-delete a tenant user
   *
   * Sets isActive = false, revokes role assignment, and revokes all refresh tokens.
   * This is a "soft delete" — the user record remains but is fully deactivated.
   */
  async deleteTenantUser(
    tenantId: string,
    userId: string,
    deletedBy: string,
  ): Promise<boolean> {
    // SECURITY: Prevent self-deletion
    if (deletedBy === userId) {
      throw new BadRequestException('Cannot delete your own account');
    }

    // Validate user exists and belongs to tenant
    const user = await this.userRepository.findOne({
      where: { id: userId, tenantId },
    });
    if (!user) {
      throw new NotFoundException(`User with ID "${userId}" not found in tenant`);
    }

    // SECURITY: Cannot delete another TENANT_ADMIN
    if (user.role === Role.TENANT_ADMIN) {
      throw new ForbiddenException('Cannot delete a tenant admin user');
    }

    // SECURITY: the admin lookup that supplies performedByEmail is pinned to the
    // acting tenant (ORPHAN-CRITICAL-100): a cross-tenant deletedBy id cannot
    // surface another tenant's admin email into this tenant's audit row.
    const admin = await this.userRepository.findOne({ where: { id: deletedBy, tenantId } });

    // SECURITY (SEC-MEDIUM-002): the soft-delete, role revocation, and audit
    // row commit ATOMICALLY. Previously the user was deactivated and roles
    // revoked first, then the audit ran in a swallowed try/catch (fail-OPEN) —
    // a user deletion could persist with no audit evidence (SOC 2 CC6.1), and a
    // swallowed role-revoke failure could leave a "deleted" user with live role
    // assignments. A throwing audit OR a failed role revoke now rolls back the
    // whole soft-delete (fail-CLOSED): no deletion persists without both the
    // role revocation and its audit trail. The audit log call is passed
    // `manager` so it writes on the SAME transaction connection (FINDING #5).
    await this.dataSource.transaction(async (manager) => {
      // 1. Deactivate the user
      user.isActive = false;
      await manager.save(user);

      // 2. Revoke role assignments. ORPHAN-CRITICAL-100: user_role_assignments
      // has no tenantId column, so the write launders ownership through the
      // tenant_roles JOIN (tr."tenantId" = $2) — only assignments whose role
      // belongs to this tenant are deactivated. GROUND-TRUTH: no updated_by
      // column on this table; the deleting actor is recorded in the USER_DELETED
      // audit row (performedBy) written in step 3 below.
      await manager.query(
        `UPDATE "auth"."user_role_assignments" ura
         SET is_active = false, updated_at = NOW()
         FROM "auth"."tenant_roles" tr
         WHERE ura.user_id = $1 AND ura.is_active = true AND tr.id = ura.role_id AND tr."tenantId" = $2`,
        [userId, tenantId],
      );

      // 3. SECURITY AUDIT: Log user deletion (BULGU-016)
      await this.auditLogService.log(
        {
          tenantId,
          performedBy: deletedBy,
          performedByEmail: admin?.email,
          action: 'USER_DELETED',
          entityType: 'User',
          entityId: userId,
          details: {
            targetEmail: user.email,
            targetRole: user.role,
            timestamp: new Date().toISOString(),
          },
          severity: AuditLogSeverity.WARNING,
        },
        manager,
      );
    });

    // SECURITY: Log user ID instead of email to prevent PII exposure in logs (H-14)
    this.logger.log(`Deleted (soft) userId=${user.id} from tenant ${tenantId}`);

    return true;
  }

  /**
   * Assign a role to an existing user in a tenant
   */
  /**
   * SECURITY (SEC-MEDIUM-001): role-grant authority guard.
   *
   * Enforces two invariants the tenant role-assignment paths previously
   * lacked, allowing horizontal privilege manipulation within a tenant:
   *   1. Self-modification is FORBIDDEN — an admin cannot assign/change their
   *      own role assignment (no self-escalation, no self-lockout).
   *   2. Upward escalation is FORBIDDEN — the granted role's level must not
   *      exceed the caller's authority ceiling.
   *
   * Global TENANT_ADMIN/SUPER_ADMIN sit ABOVE every tenant role, so their
   * ceiling is unbounded for tenant-role grants; a non-admin caller is capped
   * at their own highest active tenant-role level.
   *
   * ORPHAN-CRITICAL-100 / FINDING #1 (CRITICAL): this guard is the actual
   * cross-tenant door — the tenant-bound WRITE joins below do NOT close it.
   * The actor lookup is now PINNED to the acting tenant
   * (findOne where { id: actingUserId, tenantId }). The unbounded
   * SUPER_ADMIN/TENANT_ADMIN early-return is safe ONLY because the lookup is
   * tenant-pinned: a TENANT_ADMIN of tenant A invoking a tenant-B mutation
   * resolves to a NULL actor (no row in tenant B), falls through to the ceiling
   * query, scores ceiling 0, and is denied. A legitimately in-tenant admin
   * still manages every role in their own tenant.
   */
  private async assertRoleGrantAuthority(
    tenantId: string,
    actingUserId: string,
    targetUserId: string,
    targetRole: TenantRoleWithDetails,
  ): Promise<void> {
    if (actingUserId === targetUserId) {
      throw new ForbiddenException(
        'You cannot modify your own role assignment. Ask another administrator.',
      );
    }

    // SECURITY (ORPHAN-CRITICAL-100): pin the actor to the acting tenant. A
    // null actor (cross-tenant id or not found) MUST fall through to the
    // ceiling query and score 0 (effective deny) — never short-circuit.
    const actor = await this.userRepository.findOne({ where: { id: actingUserId, tenantId } });
    // Global platform admins outrank every tenant role — but only when the
    // tenant-pinned lookup above actually resolved them inside THIS tenant.
    if (actor && (actor.role === Role.SUPER_ADMIN || actor.role === Role.TENANT_ADMIN)) {
      return;
    }

    // ORPHAN-CRITICAL-100: the actor's ceiling is read from auth.* with the
    // tenant filter laundered through the tenant_roles JOIN (tr."tenantId" = $2)
    // since user_role_assignments has no tenantId column. A cross-tenant actor
    // produces 0 rows → ceiling 0 → any positive-level grant is denied.
    const actorLevelRows = rowsAs<{ level: number }>(
      await this.dataSource.query(
        `SELECT tr.level AS level
         FROM "auth"."user_role_assignments" ura
         JOIN "auth"."tenant_roles" tr ON tr.id = ura.role_id
         WHERE ura.user_id = $1 AND ura.is_active = true AND tr."tenantId" = $2
         ORDER BY tr.level DESC
         LIMIT 1`,
        [actingUserId, tenantId],
      ),
    );
    const actorCeiling = actorLevelRows[0]?.level ?? 0;
    if (targetRole.level > actorCeiling) {
      throw new ForbiddenException(
        'You cannot grant a role above your own authority level.',
      );
    }
  }

  async assignUserRole(
    tenantId: string,
    userId: string,
    input: {
      roleId: string;
      permissionOverrides?: {
        grants: string[];
        revokes: string[];
      };
      expiresAt?: Date;
    },
    assignedBy: string,
  ): Promise<UserRoleAssignmentResult> {
    // Validate user exists and belongs to tenant
    const user = await this.userRepository.findOne({
      where: { id: userId, tenantId },
    });
    if (!user) {
      throw new NotFoundException(`User with ID "${userId}" not found in tenant`);
    }

    // Validate role exists in tenant
    const role = await this.tenantRoleService.getRoleById(tenantId, input.roleId);
    if (!role) {
      throw new NotFoundException(`Role with ID "${input.roleId}" not found in tenant`);
    }

    // SECURITY (SEC-MEDIUM-001): self-target + upward-escalation guard.
    await this.assertRoleGrantAuthority(tenantId, assignedBy, userId, role);

    // SECURITY (RBAC-C1/C2): validate the per-user override grants against the
    // catalogue AND the assigner's own authority. A non-admin assigner cannot
    // attach a grant they do not themselves hold.
    const validatedOverrides = this.capabilityAuthority.assertGrantableOverrides(
      input.permissionOverrides,
      await this.capabilityAuthority.resolveActorAuthority(tenantId, assignedBy),
    );

    // Check if user already has an active role assignment. ORPHAN-CRITICAL-100:
    // keyed to user_id (the table has UNIQUE(user_id)) and laundered through the
    // tenant_roles JOIN (tr."tenantId" = $2) so the conflict check cannot leak a
    // cross-tenant enumeration oracle.
    const existingAssignment = rowsAs<{ id: string }>(
      await this.dataSource.query(
        `SELECT ura.id
         FROM "auth"."user_role_assignments" ura
         JOIN "auth"."tenant_roles" tr ON tr.id = ura.role_id AND tr."tenantId" = $2
         WHERE ura.user_id = $1 AND ura.is_active = true`,
        [userId, tenantId],
      ),
    );

    if (existingAssignment.length > 0) {
      throw new ConflictException(
        `User already has an active role assignment. Use updateUserRole to change it.`
      );
    }

    // Create role assignment
    const roleAssignment = await this.createRoleAssignment(
      tenantId,
      userId,
      input.roleId,
      role,
      validatedOverrides,
      assignedBy,
      input.expiresAt,
    );

    this.logger.log(`Assigned role "${role.name}" to user ${userId} in tenant ${tenantId}`);

    return roleAssignment;
  }

  /**
   * Update an existing user role assignment
   */
  async updateUserRole(
    tenantId: string,
    userId: string,
    input: {
      roleId?: string;
      permissionOverrides?: {
        grants: string[];
        revokes: string[];
      };
      expiresAt?: Date;
      isActive?: boolean;
    },
    updatedBy: string,
  ): Promise<UserRoleAssignmentResult> {
    // Validate user exists and belongs to tenant
    const user = await this.userRepository.findOne({
      where: { id: userId, tenantId },
    });
    if (!user) {
      throw new NotFoundException(`User with ID "${userId}" not found in tenant`);
    }

    // Get existing assignment. ORPHAN-CRITICAL-100: read from auth.* and launder
    // tenant ownership through the tenant_roles JOIN (tr."tenantId" = $2) — a
    // foreign-tenant assignment id returns 0 rows → NotFoundException.
    const existingResult = rowsAs<{ id: string; role_id: string } & Record<string, unknown>>(
      await this.dataSource.query(
        `SELECT ura.*
         FROM "auth"."user_role_assignments" ura
         JOIN "auth"."tenant_roles" tr ON tr.id = ura.role_id AND tr."tenantId" = $2
         WHERE ura.user_id = $1 AND ura.is_active = true`,
        [userId, tenantId],
      ),
    );

    const existing = existingResult[0];
    if (!existing) {
      throw new NotFoundException(`No active role assignment found for user ${userId}`);
    }

    const assignmentId = existing.id;

    // If changing role, validate new role exists
    let newRole: TenantRoleWithDetails | null = null;
    if (input.roleId && input.roleId !== existing.role_id) {
      newRole = await this.tenantRoleService.getRoleById(tenantId, input.roleId);
      if (!newRole) {
        throw new NotFoundException(`Role with ID "${input.roleId}" not found in tenant`);
      }
    }

    // SECURITY (RBAC-C1): the self-target + level-ceiling guard MUST run on EVERY
    // update, not only when the role id changes. It was previously gated behind
    // `if (roleId changed)`, so an override-only update (permissionOverrides with
    // no/unchanged roleId) SKIPPED it — the exact path a delegate holding
    // `users:edit_permissions` used to self-grant arbitrary capabilities. Measure
    // the ceiling against the incoming role if it is changing, else the user's
    // current role.
    const ceilingRole = newRole ?? (await this.tenantRoleService.getRoleById(tenantId, existing.role_id));
    if (!ceilingRole) {
      throw new NotFoundException(`No active role assignment found for user ${userId}`);
    }
    await this.assertRoleGrantAuthority(tenantId, updatedBy, userId, ceilingRole);

    // SECURITY (RBAC-C1/C2): validate the override grants against the catalogue +
    // the editor's own authority. Combined with the self-target block above, an
    // override-only self-grant now (a) cannot target self and (b) can only carry
    // capabilities the editor already holds — the escalation is closed on both axes.
    const validatedOverrides =
      input.permissionOverrides !== undefined
        ? this.capabilityAuthority.assertGrantableOverrides(
            input.permissionOverrides,
            await this.capabilityAuthority.resolveActorAuthority(tenantId, updatedBy),
          )
        : undefined;

    // Build update query
    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.roleId !== undefined) {
      updates.push(`role_id = $${paramIndex++}`);
      values.push(input.roleId);
    }

    if (validatedOverrides !== undefined) {
      updates.push(`permission_overrides = $${paramIndex++}`);
      values.push(CapabilityAuthorityService.serializeOverrides(validatedOverrides));
    }

    if (input.expiresAt !== undefined) {
      updates.push(`expires_at = $${paramIndex++}`);
      values.push(input.expiresAt);
    }

    if (input.isActive !== undefined) {
      updates.push(`is_active = $${paramIndex++}`);
      values.push(input.isActive);
    }

    // GROUND-TRUTH columns only: user_role_assignments has updated_at but NO
    // updated_by column (see CreateAdminEntitySurfaceTables migration). Writing
    // updated_by would fail at runtime. The actor (updatedBy) is captured in the
    // USER_ROLE_CHANGED audit row's performedBy, which is the durable record of
    // who made the change — not a non-existent column on the assignment table.
    updates.push(`updated_at = NOW()`);

    // ORPHAN-CRITICAL-100 / FINDING #6 — param-index discipline (off-by-one
    // silently drops the tenant guard): push assignmentId FIRST, capture its
    // index, then push tenantId and capture its index. The WHERE binds both by
    // the captured indices, never by arithmetic guesswork.
    values.push(assignmentId);
    const idIdx = values.length;
    values.push(tenantId);
    const tenantIdx = values.length;

    // SECURITY (SEC-MEDIUM-002): the role UPDATE and its audit row commit
    // ATOMICALLY. Previously the audit was a swallowed try/catch AFTER the
    // committed UPDATE — a failed audit left a role change with no evidence
    // (SOC 2 CC6.1 violation), fail-OPEN. Now an audit failure rolls back the
    // role change (fail-CLOSED, matching the MFA audit pattern): no role
    // mutation persists without its audit trail. The audit log call is passed
    // `manager` so it writes on the SAME transaction connection (FINDING #5).
    await this.dataSource.transaction(async (manager) => {
      // ORPHAN-CRITICAL-100 / FINDING #6: FROM-join re-asserts tenant ownership
      // on the PRE-IMAGE role_id (Postgres evaluates the FROM-join against the
      // current/pre-image row, correct when role_id is being changed — you must
      // own the row you mutate). user_role_assignments has no tenantId column,
      // so the only tenant predicate is tr."tenantId" via the role join.
      await manager.query(
        `UPDATE "auth"."user_role_assignments" ura
         SET ${updates.join(', ')}
         FROM "auth"."tenant_roles" tr
         WHERE ura.id = $${idIdx} AND tr.id = ura.role_id AND tr."tenantId" = $${tenantIdx}`,
        values,
      );

      await this.auditLogService.log(
        {
          tenantId,
          performedBy: updatedBy,
          action: 'USER_ROLE_CHANGED',
          entityType: 'UserRoleAssignment',
          entityId: userId,
          previousValue: {
            roleId: existing.role_id,
          },
          newValue: {
            roleId: input.roleId ?? existing.role_id,
            isActive: input.isActive ?? true,
            permissionOverrides: input.permissionOverrides,
          },
          details: {
            assignmentId,
            timestamp: new Date().toISOString(),
          },
          severity: AuditLogSeverity.WARNING,
        },
        manager,
      );
    });

    this.logger.log(`Updated role assignment for user ${userId} in tenant ${tenantId}`);

    // Return updated assignment
    return this.getUserRoleAssignment(tenantId, userId);
  }

  /**
   * Revoke a user's role (soft delete or hard delete)
   */
  async revokeUserRole(
    tenantId: string,
    userId: string,
    hardDelete = false,
    revokedBy: string,
  ): Promise<boolean> {
    // Validate user exists and belongs to tenant
    const user = await this.userRepository.findOne({
      where: { id: userId, tenantId },
    });
    if (!user) {
      throw new NotFoundException(`User with ID "${userId}" not found in tenant`);
    }

    // Get existing active assignment. ORPHAN-CRITICAL-100: keyed to user_id and
    // laundered through the tenant_roles JOIN (tr."tenantId" = $2). role_id is
    // read so the revoke audit can record which role was removed (previousValue).
    const existingResult = rowsAs<{ id: string; role_id: string }>(
      await this.dataSource.query(
        `SELECT ura.id, ura.role_id
         FROM "auth"."user_role_assignments" ura
         JOIN "auth"."tenant_roles" tr ON tr.id = ura.role_id AND tr."tenantId" = $2
         WHERE ura.user_id = $1 AND ura.is_active = true`,
        [userId, tenantId],
      ),
    );

    const existing = existingResult[0];
    if (!existing) {
      throw new NotFoundException(`No active role assignment found for user ${userId}`);
    }

    // GROUND-TRUTH columns only: user_role_assignments has NO updated_by column,
    // so the revoke actor (revokedBy) cannot be stamped on the assignment row.
    // The actor is the durable record IN the audit log (performedBy), matching
    // the fail-CLOSED pattern of deleteTenantUser/updateUserRole: the revoke
    // write and its USER_ROLE_CHANGED audit commit ATOMICALLY in one transaction
    // with the audit threaded `manager` — a throwing audit rolls the revoke back
    // so no role removal persists without its actor trail.
    await this.dataSource.transaction(async (manager) => {
      if (hardDelete) {
        // Hard delete - remove the record. ORPHAN-CRITICAL-100: the DELETE
        // carries its OWN tenant guard via the USING join (tr."tenantId" = $2)
        // — never relies on the prior read.
        await manager.query(
          `DELETE FROM "auth"."user_role_assignments" ura
           USING "auth"."tenant_roles" tr
           WHERE ura.user_id = $1 AND tr.id = ura.role_id AND tr."tenantId" = $2`,
          [userId, tenantId],
        );
        this.logger.log(`Hard deleted role assignment for user ${userId} in tenant ${tenantId}`);
      } else {
        // Soft delete - set is_active = false. ORPHAN-CRITICAL-100: the UPDATE
        // carries its own tenant guard via the FROM join (tr."tenantId" = $2).
        await manager.query(
          `UPDATE "auth"."user_role_assignments" ura
           SET is_active = false, updated_at = NOW()
           FROM "auth"."tenant_roles" tr
           WHERE ura.user_id = $1 AND ura.is_active = true AND tr.id = ura.role_id AND tr."tenantId" = $2`,
          [userId, tenantId],
        );
        this.logger.log(`Soft deleted (deactivated) role assignment for user ${userId} in tenant ${tenantId}`);
      }

      await this.auditLogService.log(
        {
          tenantId,
          performedBy: revokedBy,
          action: 'USER_ROLE_CHANGED',
          entityType: 'UserRoleAssignment',
          entityId: userId,
          previousValue: { roleId: existing.role_id, isActive: true },
          newValue: { roleId: null, isActive: false, hardDelete },
          details: {
            assignmentId: existing.id,
            revoked: true,
            timestamp: new Date().toISOString(),
          },
          severity: AuditLogSeverity.WARNING,
        },
        manager,
      );
    });

    return true;
  }

  /**
   * Get a user's effective permissions (role permissions + overrides)
   */
  async getUserEffectivePermissions(
    tenantId: string,
    userId: string,
  ): Promise<EffectivePermissionsResult> {
    // Validate user exists and belongs to tenant
    const user = await this.userRepository.findOne({
      where: { id: userId, tenantId },
    });
    if (!user) {
      throw new NotFoundException(`User with ID "${userId}" not found in tenant`);
    }

    // Get user's role assignment with role details. ORPHAN-CRITICAL-100: the
    // tenant filter folds into the role JOIN (r."tenantId" = $2);
    // tenant_role_permissions has no tenantId column so it is reached
    // transitively through the in-tenant role.
    const assignmentResult = rowsAs<UserRoleAssignmentRow>(
      await this.dataSource.query(
        `
      SELECT
        ura.*,
        r.name as role_name,
        r.color as role_color,
        r.icon as role_icon,
        r.level as role_level,
        rp.panel_permissions,
        rp.resource_permissions
      FROM "auth"."user_role_assignments" ura
      JOIN "auth"."tenant_roles" r ON ura.role_id = r.id AND r."tenantId" = $2
      LEFT JOIN "auth"."tenant_role_permissions" rp ON r.id = rp.role_id
      WHERE ura.user_id = $1 AND ura.is_active = true
      `,
        [userId, tenantId],
      ),
    );

    const assignment = assignmentResult[0];
    if (!assignment) {
      throw new NotFoundException(`No active role assignment found for user ${userId}`);
    }

    const overrides = this.parsePermissionOverrides(assignment.permission_overrides);
    const panelPermissions = this.parsePanelPermissions(assignment.panel_permissions);
    const resourcePermissions: string[] = assignment.resource_permissions ?? [];

    return {
      roleId: assignment.role_id,
      roleName: assignment.role_name,
      panelPermissions,
      resourcePermissions,
      overrides,
    };
  }

  /**
   * Bulk assign role to multiple users
   */
  async bulkAssignRole(
    tenantId: string,
    userIds: string[],
    roleId: string,
    assignedBy: string,
  ): Promise<BulkAssignmentResult> {
    const result: BulkAssignmentResult = {
      success: [],
      failed: [],
    };

    // Validate role exists
    const role = await this.tenantRoleService.getRoleById(tenantId, roleId);
    if (!role) {
      throw new NotFoundException(`Role with ID "${roleId}" not found in tenant`);
    }

    for (const userId of userIds) {
      try {
        await this.assignUserRole(
          tenantId,
          userId,
          { roleId, permissionOverrides: { grants: [], revokes: [] } },
          assignedBy,
        );
        result.success.push(userId);
      } catch (error) {
        result.failed.push({
          userId,
          error: (error as Error).message,
        });
      }
    }

    this.logger.log(
      `Bulk assigned role "${role.name}" to ${result.success.length} users, ${result.failed.length} failed`
    );

    return result;
  }

  /**
   * Get a user's role assignment from tenant schema
   */
  private async getUserRoleAssignment(
    tenantId: string,
    userId: string,
  ): Promise<UserRoleAssignmentResult> {
    // ORPHAN-CRITICAL-100: tenant filter folds into the role JOIN
    // (r."tenantId" = $2); tenant_role_permissions reached transitively.
    const result = rowsAs<UserRoleAssignmentRow>(
      await this.dataSource.query(
        `
      SELECT
        ura.*,
        r.name as role_name,
        r.color as role_color,
        r.icon as role_icon,
        r.level as role_level,
        rp.panel_permissions,
        rp.resource_permissions
      FROM "auth"."user_role_assignments" ura
      JOIN "auth"."tenant_roles" r ON ura.role_id = r.id AND r."tenantId" = $2
      LEFT JOIN "auth"."tenant_role_permissions" rp ON r.id = rp.role_id
      WHERE ura.user_id = $1 AND ura.is_active = true
      `,
        [userId, tenantId],
      ),
    );

    const row = result[0];
    if (!row) {
      throw new NotFoundException(`No active role assignment found for user ${userId}`);
    }

    return this.mapRowToUserRoleAssignment(row);
  }

  /**
   * Create a new role assignment in the auth schema (SSoT INSERT path).
   *
   * ORPHAN-CRITICAL-100 / D1 #3 (Tier-1 "make it impossible"): this is the
   * single hand-written INSERT for user_role_assignments. Both assignUserRole
   * and the updateTenantUser no-existing-assignment branch route through here,
   * so the tenant-ownership guard exists in exactly ONE place and cannot drift.
   *
   * - The INSERT is an INSERT...SELECT FROM "auth"."tenant_roles" WHERE
   *   tr."tenantId" = $6: a role that does NOT belong to the caller's tenant
   *   yields zero source rows → zero inserts → NotFoundException. The role_id
   *   written is `tr.id` (the in-tenant role), never an attacker-supplied id
   *   that bypassed validation.
   * - The INSERT and its USER_ROLE_CHANGED audit commit ATOMICALLY in one
   *   transaction with the audit threaded `manager` (FINDING #5 / D1 #2 — a
   *   throwing audit rolls the INSERT back, fail-CLOSED).
   */
  private async createRoleAssignment(
    tenantId: string,
    userId: string,
    roleId: string,
    role: TenantRoleWithDetails,
    // SECURITY (RBAC-C1/C2): only a ValidatedOverrideSet (produced solely by
    // CapabilityAuthorityService) is accepted here, so this INSERT path — the
    // single write sink for user_role_assignments — cannot persist an
    // unvalidated / over-privileged grant. Callers MUST validate first.
    permissionOverrides: ValidatedOverrideSet,
    assignedBy: string,
    expiresAt?: Date,
  ): Promise<UserRoleAssignmentResult> {
    const assignmentId = await this.dataSource.transaction(async (manager) => {
      // INSERT...SELECT laundering: the SELECT source is the in-tenant role,
      // so a foreign-tenant roleId produces zero rows and zero inserts.
      //
      // GLOBAL UNIQUE(user_id): user_role_assignments has a unique index on
      // user_id ALONE (idx_user_role_assignments_user_id) — NOT partial on
      // is_active. A user therefore holds AT MOST ONE row (active or inactive).
      // A plain INSERT for a user who already has a row (e.g. previously revoked
      // → is_active=false, or re-assigned through a different path) would raise a
      // 23505 unique violation. ON CONFLICT (user_id) DO UPDATE re-points the
      // single existing row instead of inserting a duplicate, structurally
      // respecting the constraint (Tier-1 "make it impossible"). The conflict
      // branch refreshes role_id, overrides, is_active, expires_at, assigned_by,
      // and assigned_at from EXCLUDED (the tenant-guarded candidate values), so
      // a re-point is a fresh assignment, not a stale resurrection. EXCLUDED
      // exists only when the SELECT produced a candidate row, so the tenant
      // guard is preserved: a foreign-tenant role yields zero source rows →
      // nothing inserted OR updated → empty RETURNING → NotFoundException.
      const insertResult = rowsAs<{ id: string }>(
        await manager.query(
          `
        INSERT INTO "auth"."user_role_assignments" (
          user_id, role_id, permission_overrides, is_active, expires_at, assigned_by, assigned_at, created_at, updated_at
        )
        SELECT $1, tr.id, $3::jsonb, true, $4, $5, NOW(), NOW(), NOW()
        FROM "auth"."tenant_roles" tr
        WHERE tr.id = $2 AND tr."tenantId" = $6
        ON CONFLICT (user_id) DO UPDATE
          SET role_id = EXCLUDED.role_id,
              permission_overrides = EXCLUDED.permission_overrides,
              is_active = true,
              expires_at = EXCLUDED.expires_at,
              assigned_by = EXCLUDED.assigned_by,
              assigned_at = NOW(),
              updated_at = NOW()
        RETURNING id
        `,
          [
            userId,
            roleId,
            CapabilityAuthorityService.serializeOverrides(permissionOverrides),
            expiresAt || null,
            assignedBy,
            tenantId,
          ],
        ),
      );

      const insertedRow = insertResult[0];
      if (!insertedRow) {
        // Zero rows = the role is not owned by this tenant (the tenant-guarded
        // SELECT produced no candidate, so neither INSERT nor the ON CONFLICT
        // re-point fired). Convert the old generic "INSERT returned no id" Error
        // into a tenant-scoped 404.
        throw new NotFoundException(`Role with ID "${roleId}" not found in tenant`);
      }

      // D1 #3 / D1 #2: manager-threaded audit so both INSERT callers get
      // identical atomic USER_ROLE_CHANGED evidence (fail-CLOSED).
      await this.auditLogService.log(
        {
          tenantId,
          performedBy: assignedBy,
          action: 'USER_ROLE_CHANGED',
          entityType: 'UserRoleAssignment',
          entityId: userId,
          previousValue: { roleId: null },
          newValue: { roleId },
          details: {
            newRoleName: role.name,
            assignment: 'created',
            timestamp: new Date().toISOString(),
          },
          severity: AuditLogSeverity.WARNING,
        },
        manager,
      );

      return insertedRow.id;
    });

    // Build response
    const effectivePermissions = this.calculateEffectivePermissions(
      role.permissions?.resourcePermissions || [],
      permissionOverrides,
    );

    return {
      id: assignmentId,
      userId,
      roleId,
      roleName: role.name,
      roleColor: role.color,
      roleIcon: role.icon,
      roleLevel: role.level,
      // Strip the internal validation brand from the client-facing result.
      permissionOverrides: { grants: permissionOverrides.grants, revokes: permissionOverrides.revokes },
      panelPermissions: role.permissions?.panelPermissions || {},
      resourcePermissions: role.permissions?.resourcePermissions || [],
      effectivePermissions,
      isActive: true,
      expiresAt: expiresAt || null,
      assignedAt: new Date(),
      assignedBy,
    };
  }

  /**
   * Send invitation email to new user.
   *
   * SECURITY (CRITICAL-001/002): Only opaque references are published on the event bus.
   * PII (email, firstName, lastName, tenantName) and secret URLs are NEVER placed on
   * the immutable event bus. The notification service resolves user/tenant details
   * and builds the action URL at delivery time via authenticated internal API calls.
   */
  private async sendInvitationEmail(
    tenant: Tenant,
    user: User,
    invitationToken: string,
  ): Promise<void> {
    // SECURITY: Hash the invitation token for the opaque actionTokenId reference.
    // The raw token is NEVER placed on the event bus.
    const actionTokenHash = createHash('sha256').update(invitationToken).digest('hex');

    const event: UserInvitedEvent = {
      ...createBaseEvent<UserInvitedEvent>('UserInvited', tenant.id, { aggregateId: user.id, aggregateType: 'User' }),
      userId: user.id,
      role: user.role,
      invitedBy: user.invitedBy || undefined,
      credentialType: 'reset_token',
      actionTokenId: actionTokenHash,
      cryptoShredKeyId: user.id,
    };

    await this.bestEffort.publish(event);
    // SECURITY: Log user ID instead of email to prevent PII exposure in logs (H-14)
    this.logger.log(`Published UserInvitedEvent for userId=${user.id}`);
  }

  /**
   * Calculate effective permissions by applying overrides to role permissions
   */
  private calculateEffectivePermissions(
    rolePermissions: string[],
    overrides: { grants: string[]; revokes: string[] },
  ): string[] {
    // Delegates to the shared SSoT so this read path and TokenService's JWT
    // `resourcePermissions` mint apply overrides identically (see
    // permission-overrides.util.ts).
    return applyPermissionOverrides(rolePermissions, overrides);
  }

  /**
   * Parse permission overrides from JSON or object
   */
  private parsePermissionOverrides(
    raw: unknown,
  ): { grants: string[]; revokes: string[] } {
    // Delegates to the shared SSoT (permission-overrides.util.ts) so the
    // jsonb/string/object normalisation is defined in exactly one place.
    return parsePermissionOverridesSSoT(raw);
  }

  /**
   * Parse panel permissions from JSON or object
   */
  private parsePanelPermissions(
    raw: unknown,
  ): Record<string, Record<string, Record<string, boolean>>> {
    if (!raw) {
      return {};
    }

    if (typeof raw === 'string') {
      try {
        const parsed: unknown = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, Record<string, Record<string, boolean>>>)
          : {};
      } catch {
        return {};
      }
    }

    if (typeof raw === 'object') {
      return raw as Record<string, Record<string, Record<string, boolean>>>;
    }

    return {};
  }

  /**
   * Map database row to UserRoleAssignmentResult
   */
  private mapRowToUserRoleAssignment(row: Record<string, unknown>): UserRoleAssignmentResult {
    const overrides = this.parsePermissionOverrides(row['permission_overrides']);
    const panelPermissions = this.parsePanelPermissions(row['panel_permissions']);
    const resourcePermissions: string[] = (row['resource_permissions'] as string[]) || [];
    const effectivePermissions = this.calculateEffectivePermissions(resourcePermissions, overrides);

    return {
      id: row['id'] as string,
      userId: row['user_id'] as string,
      roleId: row['role_id'] as string,
      roleName: row['role_name'] as string,
      roleColor: row['role_color'] as string,
      roleIcon: row['role_icon'] as string,
      roleLevel: row['role_level'] as number,
      permissionOverrides: overrides,
      panelPermissions,
      resourcePermissions,
      effectivePermissions,
      isActive: row['is_active'] as boolean,
      expiresAt: row['expires_at'] as Date | null,
      assignedAt: row['created_at'] as Date,
      assignedBy: row['assigned_by'] as string,
    };
  }
}
