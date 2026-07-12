import { Injectable, Logger, NotFoundException, ConflictException, ForbiddenException, Inject } from '@nestjs/common';
import {
  USER_TOKEN_REVOCATION,
  IUserTokenRevocation,
} from '@aquaculture/backend-common/security';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';

import { AuditLogSeverity } from '../../../audit/audit-log.entity';
import { AuditLogService } from '../../../audit/audit-log.service';

import { CapabilityAuthorityService } from './capability-authority';
import {
  PERMISSION_CATEGORIES,
  panelPermissionsToResourceArray,
  resolveEntitledCapabilities,
} from './permission-catalogue';

// Re-export the catalogue SSoT so existing importers (tenant-role.resolver,
// permission-catalogue.spec) keep their import path. The definition now lives in
// permission-catalogue.ts so CapabilityAuthorityService can share it with no cycle.
export { PERMISSION_CATEGORIES };

/**
 * Default tenant roles seed data
 */
const DEFAULT_TENANT_ROLES = [
  {
    name: 'Supervisor',
    description: 'Can manage daily operations, view reports, and oversee staff',
    color: '#8B5CF6',
    icon: 'user-check',
    level: 70,
    isSystem: true,
    isDefault: false,
  },
  {
    name: 'Technician',
    description: 'Can manage sensors, equipment, and maintenance tasks',
    color: '#06B6D4',
    icon: 'wrench',
    level: 50,
    isSystem: true,
    isDefault: false,
  },
  {
    name: 'Feed Manager',
    description: 'Can manage feeding schedules, inventory, and records',
    color: '#F59E0B',
    icon: 'package',
    level: 50,
    isSystem: true,
    isDefault: false,
  },
  {
    name: 'Operator',
    description: 'Basic operational access for daily tasks',
    color: '#10B981',
    icon: 'activity',
    level: 30,
    isSystem: true,
    isDefault: true,
  },
  {
    name: 'Viewer',
    description: 'Read-only access to dashboards and reports',
    color: '#6B7280',
    icon: 'eye',
    level: 10,
    isSystem: true,
    isDefault: false,
  },
];

/**
 * Default role permissions
 */
const DEFAULT_ROLE_PERMISSIONS: Record<string, Record<string, Record<string, Record<string, boolean>>>> = {
  Supervisor: {
    farm: {
      sites: { view: true, create: false, edit: true, delete: false },
      departments: { view: true, create: true, edit: true, delete: false },
      systems: { view: true, create: true, edit: true, delete: false },
      tanks: { view: true, create: true, edit: true, delete: false, assign: true },
      ponds: { view: true, create: true, edit: true, delete: false },
      equipment: { view: true, create: true, edit: true, delete: false, assign: true },
    },
    batch: {
      batches: { view: true, create: true, edit: true, delete: false, transfer: true, split: true, merge: true },
      species: { view: true, create: false, edit: false, delete: false },
      mortality: { view: true, record: true },
      growth: { view: true, record: true, analyze: true },
      harvest: { view: true, plan: true, record: true },
    },
    operations: {
      feeding: { view: true, record: true, manage_schedules: true, manage_inventory: true },
      sensors: { view: true, configure: true, calibrate: false, manage_alerts: true },
      maintenance: { view: true, create_work_orders: true, complete: true, manage_schedules: true },
      water_quality: { view: true, record: true },
    },
    hr: {
      employees: { view: true, create: false, edit: false, delete: false },
      attendance: { view: true, manage: true },
      leave: { view: true, approve: true },
      shifts: { view: true, create: true, edit: true, delete: false },
    },
    reports: {
      dashboard: { view: true, analytics: true },
      reports: { view: true, export: true, create_custom: false },
    },
    admin: {
      settings: { view: true, edit: false },
      users: { view: true, invite: false, edit_permissions: false, deactivate: false },
      roles: { view: true, create: false, edit: false, delete: false },
    },
    messaging: {
      channels: { view: true, create_group: true, create_dm: true, manage: true },
      messages: { send: true },
    },
    ai: {
      ai_assistant: { use: true },
      ai_settings: { view: true, manage: true },
      ai_personas: { operator: true, manager: true, expert: true, supervisor: false },
    },
  },
  Technician: {
    farm: {
      sites: { view: true, create: false, edit: false, delete: false },
      equipment: { view: true, create: true, edit: true, delete: false, assign: false },
    },
    operations: {
      sensors: { view: true, configure: true, calibrate: true, manage_alerts: true },
      maintenance: { view: true, create_work_orders: true, complete: true, manage_schedules: true },
      water_quality: { view: true, record: true },
    },
    reports: {
      dashboard: { view: true, analytics: false },
      reports: { view: true, export: false, create_custom: false },
    },
    messaging: {
      channels: { view: true, create_group: true, create_dm: true, manage: false },
      messages: { send: true },
    },
    ai: {
      ai_assistant: { use: true },
      ai_personas: { operator: true, manager: true, expert: false, supervisor: false },
    },
  },
  'Feed Manager': {
    farm: {
      sites: { view: true, create: false, edit: false, delete: false },
      tanks: { view: true, create: false, edit: false, delete: false, assign: false },
    },
    batch: {
      batches: { view: true, create: false, edit: false, delete: false },
      growth: { view: true, record: true, analyze: false },
    },
    operations: {
      feeding: { view: true, record: true, manage_schedules: true, manage_inventory: true },
    },
    reports: {
      dashboard: { view: true, analytics: false },
      reports: { view: true, export: true, create_custom: false },
    },
    messaging: {
      channels: { view: true, create_group: true, create_dm: true, manage: false },
      messages: { send: true },
    },
    ai: {
      ai_assistant: { use: true },
      ai_personas: { operator: true, manager: true, expert: false, supervisor: false },
    },
  },
  Operator: {
    farm: {
      sites: { view: true, create: false, edit: false, delete: false },
      tanks: { view: true, create: false, edit: false, delete: false, assign: false },
    },
    batch: {
      batches: { view: true, create: false, edit: false, delete: false },
      mortality: { view: true, record: true },
      growth: { view: true, record: true, analyze: false },
    },
    operations: {
      feeding: { view: true, record: true, manage_schedules: false, manage_inventory: false },
      sensors: { view: true, configure: false, calibrate: false, manage_alerts: false },
      maintenance: { view: true, create_work_orders: true, complete: true, manage_schedules: false },
      water_quality: { view: true, record: true },
    },
    hr: {
      attendance: { view: true, manage: false },
      leave: { view: true, approve: false },
      shifts: { view: true, create: false, edit: false, delete: false },
    },
    reports: {
      dashboard: { view: true, analytics: false },
      reports: { view: true, export: false, create_custom: false },
    },
    messaging: {
      channels: { view: true, create_group: true, create_dm: true, manage: false },
      messages: { send: true },
    },
    ai: {
      ai_assistant: { use: true },
      ai_personas: { operator: true, manager: false, expert: false, supervisor: false },
    },
  },
  Viewer: {
    farm: {
      sites: { view: true, create: false, edit: false, delete: false },
      departments: { view: true, create: false, edit: false, delete: false },
      systems: { view: true, create: false, edit: false, delete: false },
      tanks: { view: true, create: false, edit: false, delete: false, assign: false },
      ponds: { view: true, create: false, edit: false, delete: false },
      equipment: { view: true, create: false, edit: false, delete: false, assign: false },
    },
    batch: {
      batches: { view: true, create: false, edit: false, delete: false },
      species: { view: true, create: false, edit: false, delete: false },
      mortality: { view: true, record: false },
      growth: { view: true, record: false, analyze: false },
      harvest: { view: true, plan: false, record: false },
    },
    operations: {
      feeding: { view: true, record: false, manage_schedules: false, manage_inventory: false },
      sensors: { view: true, configure: false, calibrate: false, manage_alerts: false },
      maintenance: { view: true, create_work_orders: false, complete: false, manage_schedules: false },
      water_quality: { view: true, record: false },
    },
    reports: {
      dashboard: { view: true, analytics: false },
      reports: { view: true, export: false, create_custom: false },
    },
    messaging: {
      // Most-restricted role: can view channels, DM, and chat — but not start
      // groups. A tenant admin can widen this per role in the role editor.
      channels: { view: true, create_group: false, create_dm: true, manage: false },
      messages: { send: true },
    },
    ai: {
      ai_assistant: { use: true },
      ai_personas: { operator: true, manager: false, expert: false, supervisor: false },
    },
  },
};

/** Nested role permission matrix: category → resource → action → granted. */
type PanelMatrix = Record<string, Record<string, Record<string, boolean>>>;

export interface TenantRoleWithDetails {
  id: string;
  name: string;
  description: string | null;
  color: string;
  icon: string;
  level: number;
  isSystem: boolean;
  isDefault: boolean;
  userCount: number;
  permissions: {
    id: string;
    roleId: string;
    panelPermissions: Record<string, Record<string, Record<string, boolean>>>;
    resourcePermissions: string[];
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class TenantRoleService {
  private readonly logger = new Logger(TenantRoleService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly capabilityAuthority: CapabilityAuthorityService,
    // SECURITY (RBAC-C3): role-definition mutations (create/edit/delete/
    // set-default/seed) previously wrote ZERO audit rows — a privileged
    // permission rewrite that re-scopes every holder of a role was forensically
    // invisible (SOC 2 CC6.1/CC7.2, GDPR Art 30). Every mutation now writes an
    // audit row on its own transaction (fail-CLOSED: a throwing audit rolls the
    // mutation back), mirroring the tenant-user-management assignment paths.
    private readonly auditLogService: AuditLogService,
    // SECURITY (RBAC-HIGH-001): editing a role's permissions changes the
    // effective set of EVERY active holder — revoke their live tokens so the new
    // (possibly reduced) permissions take effect on the next request.
    @Inject(USER_TOKEN_REVOCATION)
    private readonly userTokenRevocation: IUserTokenRevocation,
  ) {}

  /**
   * Get all roles for a tenant
   */
  async getTenantRoles(tenantId: string): Promise<TenantRoleWithDetails[]> {
    // Repointed to auth.* (ORPHAN-CRITICAL-100): tenant_roles is the only table
    // carrying "tenantId"; the user_count subquery launders tenant ownership
    // through an inner join on tenant_roles so foreign-tenant assignments cannot
    // inflate the count. tenant_role_permissions has no tenantId column.
    const roles = await this.dataSource.query(
      `
      SELECT
        r.*,
        p.id as permission_id,
        p.panel_permissions,
        p.resource_permissions,
        COALESCE(uc.user_count, 0)::int as user_count
      FROM "auth"."tenant_roles" r
      LEFT JOIN "auth"."tenant_role_permissions" p ON r.id = p.role_id
      LEFT JOIN (
        SELECT ura.role_id, COUNT(*)::int as user_count
        FROM "auth"."user_role_assignments" ura
        JOIN "auth"."tenant_roles" trc ON trc.id = ura.role_id AND trc."tenantId" = $1
        WHERE ura.is_active = true
        GROUP BY ura.role_id
      ) uc ON r.id = uc.role_id
      WHERE r."tenantId" = $1
      ORDER BY r.level DESC, r.name ASC
      `,
      [tenantId],
    );

    return roles.map((row: Record<string, unknown>) => this.mapRowToRole(row));
  }

  /**
   * Get a single role by ID
   */
  async getRoleById(tenantId: string, roleId: string): Promise<TenantRoleWithDetails | null> {
    // Repointed to auth.* (ORPHAN-CRITICAL-100, FINDING #3): this is the
    // in-tenant validator other methods (createRole/updateRole) re-read through,
    // so it MUST scope to "tenantId" — previously it filtered by id alone,
    // returning a foreign-tenant role to its callers.
    const result = await this.dataSource.query(
      `
      SELECT
        r.*,
        p.id as permission_id,
        p.panel_permissions,
        p.resource_permissions,
        COALESCE(uc.user_count, 0)::int as user_count
      FROM "auth"."tenant_roles" r
      LEFT JOIN "auth"."tenant_role_permissions" p ON r.id = p.role_id
      LEFT JOIN (
        SELECT ura.role_id, COUNT(*)::int as user_count
        FROM "auth"."user_role_assignments" ura
        JOIN "auth"."tenant_roles" trc ON trc.id = ura.role_id AND trc."tenantId" = $2
        WHERE ura.is_active = true
        GROUP BY ura.role_id
      ) uc ON r.id = uc.role_id
      WHERE r.id = $1 AND r."tenantId" = $2
      `,
      [roleId, tenantId],
    );

    if (result.length === 0) {
      return null;
    }

    return this.mapRowToRole(result[0]);
  }

  /**
   * Get the default role for a tenant
   */
  async getDefaultRole(tenantId: string): Promise<TenantRoleWithDetails | null> {
    // Repointed to auth.* (ORPHAN-CRITICAL-100, FINDING #3 CRITICAL site):
    // without the tenantId predicate this returned ANY tenant's default role.
    // Equality on "tenantId" intentionally skips NULL-tenant (platform-global)
    // rows — see NULL-tenant decision in the blueprint.
    const result = await this.dataSource.query(
      `
      SELECT
        r.*,
        p.id as permission_id,
        p.panel_permissions,
        p.resource_permissions,
        0 as user_count
      FROM "auth"."tenant_roles" r
      LEFT JOIN "auth"."tenant_role_permissions" p ON r.id = p.role_id
      WHERE r.is_default = true AND r."tenantId" = $1
      LIMIT 1
      `,
      [tenantId],
    );

    if (result.length === 0) {
      return null;
    }

    return this.mapRowToRole(result[0]);
  }

  /**
   * Create a new tenant role
   *
   * Uses SERIALIZABLE transaction with pessimistic locking to prevent:
   * - Duplicate role name race conditions
   * - Inconsistent state between role and permissions tables
   */
  async createRole(
    tenantId: string,
    input: {
      name: string;
      description?: string;
      color?: string;
      icon?: string;
      level?: number;
      isDefault?: boolean;
      panelPermissions: Record<string, Record<string, Record<string, boolean>>>;
    },
    createdBy: string,
  ): Promise<TenantRoleWithDetails> {
    // SECURITY (RBAC-C2): validate the requested capabilities BEFORE opening the
    // transaction. `panelPermissionsToResourceArray` flattens the panel matrix to
    // `resource:action` strings; the authority check rejects any capability outside
    // the catalogue AND — for a non-admin delegate holding `roles:create` — any
    // capability the actor does not themselves hold. A TENANT_ADMIN/SUPER_ADMIN
    // author may grant any catalogue capability. The branded return value is the
    // only value the permission INSERT below accepts.
    const actorAuthority = await this.capabilityAuthority.resolveActorAuthority(tenantId, createdBy);
    const grantableResourcePermissions = this.capabilityAuthority.assertGrantableResourcePermissions(
      panelPermissionsToResourceArray(input.panelPermissions),
      actorAuthority,
    );

    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      // Check for duplicate name with FOR UPDATE to prevent race conditions
      // This locks any matching rows and prevents concurrent inserts with same name.
      // Repointed to auth.* (ORPHAN-CRITICAL-100): the dup check is scoped to
      // this tenant so a same name in another tenant is not a conflict.
      const existing = await queryRunner.query(
        `SELECT id FROM "auth"."tenant_roles" WHERE LOWER(name) = LOWER($1) AND "tenantId" = $2 FOR UPDATE`,
        [input.name, tenantId],
      );

      if (existing.length > 0) {
        throw new ConflictException(`Role with name "${input.name}" already exists`);
      }

      // If this is set as default, unset other defaults (with locking).
      // CRITICAL (FINDING #3): the AND "tenantId" = $1 guard prevents
      // platform-wide default-role corruption across every other tenant.
      if (input.isDefault) {
        await queryRunner.query(
          `UPDATE "auth"."tenant_roles" SET is_default = false, updated_at = NOW() WHERE is_default = true AND "tenantId" = $1`,
          [tenantId],
        );
      }

      // Create the role. "tenantId" is the leading bound param ($1); every
      // subsequent positional param shifted +1 from the pre-repoint shape.
      const roleResult = await queryRunner.query(
        `
        INSERT INTO "auth"."tenant_roles" (
          "tenantId", name, description, color, icon, level, is_system, is_default, created_by, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8, NOW(), NOW())
        RETURNING *
        `,
        [
          tenantId,
          input.name,
          input.description || null,
          input.color || '#6366F1',
          input.icon || 'shield',
          input.level ?? 50,
          input.isDefault ?? false,
          createdBy,
        ],
      );

      const roleId = roleResult[0].id;

      // Create role permissions within the same transaction. tenant_role_permissions
      // has no tenantId column; ownership is transitive via the role_id of the
      // tenant-owned role inserted above in the same SERIALIZABLE tx. The
      // resource_permissions written are the AUTHORITY-VALIDATED set (branded),
      // not a re-flattening of the raw input — so an unvalidated capability can
      // never reach this column.
      await queryRunner.query(
        `
        INSERT INTO "auth"."tenant_role_permissions" (
          role_id, panel_permissions, resource_permissions, created_at, updated_at
        ) VALUES ($1, $2, $3, NOW(), NOW())
        `,
        [roleId, JSON.stringify(input.panelPermissions), [...grantableResourcePermissions]],
      );

      // RBAC-C3: fail-CLOSED audit on the SAME transaction (queryRunner.manager)
      // — a throwing audit rolls the role creation back.
      await this.auditLogService.log(
        {
          tenantId,
          performedBy: createdBy,
          action: 'ROLE_CREATED',
          entityType: 'TenantRole',
          entityId: roleId,
          newValue: {
            name: input.name,
            level: input.level ?? 50,
            isDefault: input.isDefault ?? false,
            resourcePermissions: [...grantableResourcePermissions],
          },
          details: { timestamp: new Date().toISOString() },
          severity: AuditLogSeverity.WARNING,
        },
        queryRunner.manager,
      );

      await queryRunner.commitTransaction();

      this.logger.log(`Created role "${input.name}" in tenant ${tenantId}`);

      const createdRole = await this.getRoleById(tenantId, roleId);
      if (!createdRole) {
        throw new Error('Failed to retrieve created role');
      }
      return createdRole;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Failed to create role "${input.name}" in tenant ${tenantId}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Update a tenant role
   *
   * Uses SERIALIZABLE transaction with pessimistic locking to ensure:
   * - Atomic update of role and permissions
   * - Prevention of duplicate name race conditions
   * - Consistent default role state
   */
  async updateRole(
    tenantId: string,
    roleId: string,
    input: {
      name?: string;
      description?: string;
      color?: string;
      icon?: string;
      level?: number;
      isDefault?: boolean;
      panelPermissions?: Record<string, Record<string, Record<string, boolean>>>;
    },
    updatedBy: string,
  ): Promise<TenantRoleWithDetails> {
    // SECURITY (RBAC-C2): if the permission matrix is being rewritten, validate
    // the new capabilities against the catalogue + the editor's own authority
    // BEFORE the transaction. A non-admin delegate with `roles:edit` therefore
    // cannot rewrite a role (their own, or a seeded one) to include capabilities
    // they do not hold — the escalation-by-role-authoring vector. Resolved once
    // here; the branded result is the only value the permission UPDATE accepts.
    const grantableResourcePermissions = input.panelPermissions
      ? this.capabilityAuthority.assertGrantableResourcePermissions(
          panelPermissionsToResourceArray(input.panelPermissions),
          await this.capabilityAuthority.resolveActorAuthority(tenantId, updatedBy),
        )
      : null;

    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      // Lock the role row for update to prevent concurrent modifications.
      // Repointed to auth.* (ORPHAN-CRITICAL-100): the tenantId predicate makes
      // a foreign roleId return 0 rows → NotFoundException (no cross-tenant peek).
      const existingResult = await queryRunner.query(
        `
        SELECT r.*, p.id as permission_id, p.panel_permissions, p.resource_permissions
        FROM "auth"."tenant_roles" r
        LEFT JOIN "auth"."tenant_role_permissions" p ON r.id = p.role_id
        WHERE r.id = $1 AND r."tenantId" = $2
        FOR UPDATE OF r
        `,
        [roleId, tenantId],
      );

      if (existingResult.length === 0) {
        throw new NotFoundException(`Role with ID "${roleId}" not found`);
      }

      const existing = this.mapRowToRole(existingResult[0]);

      if (existing.isSystem) {
        if (input.name || input.level !== undefined) {
          throw new ForbiddenException('Cannot modify name or level of system roles');
        }
      }

      // Check for duplicate name with locking to prevent race conditions.
      // Repointed to auth.* (ORPHAN-CRITICAL-100): scoped to this tenant.
      if (input.name && input.name !== existing.name) {
        const duplicate = await queryRunner.query(
          `SELECT id FROM "auth"."tenant_roles" WHERE LOWER(name) = LOWER($1) AND id != $2 AND "tenantId" = $3 FOR UPDATE`,
          [input.name, roleId, tenantId],
        );
        if (duplicate.length > 0) {
          throw new ConflictException(`Role with name "${input.name}" already exists`);
        }
      }

      // If setting as default, unset other defaults within transaction.
      // CRITICAL (FINDING #3): AND "tenantId" = $2 scopes the unset to this
      // tenant; without it the write would clear defaults in every tenant.
      if (input.isDefault && !existing.isDefault) {
        await queryRunner.query(
          `UPDATE "auth"."tenant_roles" SET is_default = false, updated_at = NOW() WHERE is_default = true AND id != $1 AND "tenantId" = $2`,
          [roleId, tenantId],
        );
      }

      const updateFields: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (input.name !== undefined) {
        updateFields.push(`name = $${paramIndex++}`);
        values.push(input.name);
      }
      if (input.description !== undefined) {
        updateFields.push(`description = $${paramIndex++}`);
        values.push(input.description);
      }
      if (input.color !== undefined) {
        updateFields.push(`color = $${paramIndex++}`);
        values.push(input.color);
      }
      if (input.icon !== undefined) {
        updateFields.push(`icon = $${paramIndex++}`);
        values.push(input.icon);
      }
      if (input.level !== undefined) {
        updateFields.push(`level = $${paramIndex++}`);
        values.push(input.level);
      }
      if (input.isDefault !== undefined) {
        updateFields.push(`is_default = $${paramIndex++}`);
        values.push(input.isDefault);
      }

      updateFields.push(`updated_at = NOW()`);
      // Param-index discipline (ORPHAN-CRITICAL-100): roleId occupies
      // $${paramIndex}; tenantId is pushed immediately after at $${paramIndex + 1}.
      // The WHERE carries its own tenant guard so the write is fail-closed
      // independent of the lock-load above. An off-by-one here would silently
      // drop the tenant guard, so the two pushes mirror the two positional refs.
      values.push(roleId);
      values.push(tenantId);
      const roleIdParam = paramIndex;
      const tenantIdParam = paramIndex + 1;

      if (updateFields.length > 1) {
        await queryRunner.query(
          `UPDATE "auth"."tenant_roles" SET ${updateFields.join(', ')} WHERE id = $${roleIdParam} AND "tenantId" = $${tenantIdParam}`,
          values,
        );
      }

      // Update permissions within the same transaction. tenant_role_permissions
      // has no tenantId column, so ownership is laundered through a write-side
      // join on tenant_roles (ORPHAN-CRITICAL-100).
      if (input.panelPermissions && grantableResourcePermissions) {
        await queryRunner.query(
          `
          UPDATE "auth"."tenant_role_permissions" trp
          SET panel_permissions = $1, resource_permissions = $2, updated_at = NOW()
          FROM "auth"."tenant_roles" tr
          WHERE trp.role_id = tr.id AND trp.role_id = $3 AND tr."tenantId" = $4
          `,
          [JSON.stringify(input.panelPermissions), [...grantableResourcePermissions], roleId, tenantId],
        );
      }

      // RBAC-C3: fail-CLOSED audit with the before/after permission set, so a
      // privileged rewrite that re-scopes every holder of the role is traceable.
      await this.auditLogService.log(
        {
          tenantId,
          performedBy: updatedBy,
          action: 'ROLE_UPDATED',
          entityType: 'TenantRole',
          entityId: roleId,
          previousValue: {
            name: existing.name,
            level: existing.level,
            isDefault: existing.isDefault,
            resourcePermissions: existing.permissions?.resourcePermissions ?? [],
          },
          newValue: {
            name: input.name ?? existing.name,
            level: input.level ?? existing.level,
            isDefault: input.isDefault ?? existing.isDefault,
            resourcePermissions: grantableResourcePermissions
              ? [...grantableResourcePermissions]
              : (existing.permissions?.resourcePermissions ?? []),
          },
          details: { timestamp: new Date().toISOString() },
          severity: AuditLogSeverity.WARNING,
        },
        queryRunner.manager,
      );

      await queryRunner.commitTransaction();

      this.logger.log(`Updated role "${existing.name}" (${roleId}) in tenant ${tenantId}`);

      // RBAC-HIGH-001: if the permission set changed, every active holder's
      // effective permissions changed — revoke their live tokens (fleet-wide via
      // the shared user_blacklist key) so the new set is enforced on their next
      // request rather than after the access-token TTL. Runs AFTER commit so a
      // revoke is never issued for a change that rolled back.
      if (grantableResourcePermissions) {
        await this.revokeTokensForRoleHolders(tenantId, roleId);
      }

      const updatedRole = await this.getRoleById(tenantId, roleId);
      if (!updatedRole) {
        throw new Error('Failed to retrieve updated role');
      }
      return updatedRole;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Failed to update role ${roleId} in tenant ${tenantId}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Delete a tenant role
   *
   * Uses SERIALIZABLE transaction with pessimistic locking to ensure:
   * - Atomic deletion of role and associated permissions (cascade)
   * - Accurate user count check (prevents race with role assignment)
   * - Prevents deletion while users are being assigned
   */
  async deleteRole(tenantId: string, roleId: string, deletedBy: string): Promise<boolean> {
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      // Lock the role and get accurate user count within transaction.
      // Repointed to auth.* (ORPHAN-CRITICAL-100): outer filter on r."tenantId"
      // and the user_count subquery join on trc."tenantId" both scope to tenant.
      const roleResult = await queryRunner.query(
        `
        SELECT
          r.*,
          COALESCE(uc.user_count, 0)::int as user_count
        FROM "auth"."tenant_roles" r
        LEFT JOIN (
          SELECT ura.role_id, COUNT(*)::int as user_count
          FROM "auth"."user_role_assignments" ura
          JOIN "auth"."tenant_roles" trc ON trc.id = ura.role_id AND trc."tenantId" = $2
          WHERE ura.is_active = true
          GROUP BY ura.role_id
        ) uc ON r.id = uc.role_id
        WHERE r.id = $1 AND r."tenantId" = $2
        FOR UPDATE OF r
        `,
        [roleId, tenantId],
      );

      if (roleResult.length === 0) {
        throw new NotFoundException(`Role with ID "${roleId}" not found`);
      }

      const existing = roleResult[0];

      if (existing.is_system) {
        throw new ForbiddenException('Cannot delete system roles');
      }

      if (existing.user_count > 0) {
        throw new ForbiddenException(
          `Cannot delete role "${existing.name}" - ${existing.user_count} users are still assigned`,
        );
      }

      // Delete role permissions first (if not using CASCADE). tenant_role_permissions
      // has no tenantId column, so the delete is laundered through a write-side
      // join on tenant_roles (ORPHAN-CRITICAL-100).
      await queryRunner.query(
        `DELETE FROM "auth"."tenant_role_permissions" trp USING "auth"."tenant_roles" tr WHERE trp.role_id = tr.id AND trp.role_id = $1 AND tr."tenantId" = $2`,
        [roleId, tenantId],
      );

      // Delete the role. Carries its own tenant guard (ORPHAN-CRITICAL-100).
      await queryRunner.query(
        `DELETE FROM "auth"."tenant_roles" WHERE id = $1 AND "tenantId" = $2`,
        [roleId, tenantId],
      );

      // RBAC-C3: fail-CLOSED audit snapshotting the deleted role (the CASCADE
      // erases the row, so this is the only durable record of what existed).
      await this.auditLogService.log(
        {
          tenantId,
          performedBy: deletedBy,
          action: 'ROLE_DELETED',
          entityType: 'TenantRole',
          entityId: roleId,
          previousValue: {
            name: existing.name as string,
            level: existing.level as number,
            isSystem: existing.is_system as boolean,
            isDefault: existing.is_default as boolean,
          },
          details: { timestamp: new Date().toISOString() },
          severity: AuditLogSeverity.WARNING,
        },
        queryRunner.manager,
      );

      await queryRunner.commitTransaction();

      this.logger.log(`Deleted role "${existing.name}" (${roleId}) in tenant ${tenantId}`);

      return true;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Failed to delete role ${roleId} in tenant ${tenantId}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Seed AND upgrade the default roles for a tenant (RBAC-MEDIUM-015).
   *
   * This is a catalogue-driven seed/upgrade routine — the SSoT for what the
   * shipped default roles look like is `DEFAULT_TENANT_ROLES` +
   * `DEFAULT_ROLE_PERMISSIONS` in THIS file, and both the create and the
   * top-up derive from it live. It replaces the point-in-time, name-keyed
   * snapshot backfill migrations (e.g. MT-HIGH-057
   * `1801300000000-BackfillMessagingAiRoleCapabilities`): when a future
   * capability is added to the templates, existing tenants pick it up on the
   * next run of this routine with NO new migration.
   *
   * Two phases, one SERIALIZABLE transaction:
   *   1. CREATE the named defaults that are ABSENT (per-role idempotent — the
   *      old guard skipped the whole seed when any role existed, but
   *      provisioning always inserts a TENANT_ADMIN row first, so the 5
   *      operational roles were never created — RBAC-H10 / DATA-HIGH-002).
   *   2. RECONCILE existing default-NAMED, `is_system` roles: UNION any missing
   *      entitled template capabilities into their stored permissions. Additive
   *      only — a re-run adds nothing (idempotent) and no prior grant is removed.
   *
   * Both phases are ENTITLEMENT-GATED against the tenant's enabled modules
   * (RBAC-HIGH-010): a non-entitled capability (e.g. `ai_settings:manage` for a
   * tenant without the AI module) is never written to `tenant_role_permissions`,
   * so this raw-SQL path matches the CapabilityAuthorityService write boundary
   * and the token-mint intersection instead of bypassing them.
   */
  async seedDefaultRoles(tenantId: string, createdBy: string): Promise<TenantRoleWithDetails[]> {
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      // Lock the tenant's roles (FOR UPDATE OF r serializes concurrent seeds;
      // ORPHAN-CRITICAL-100 tenant filter is load-bearing) and load their id,
      // name, is_system flag AND current stored permissions so the reconcile
      // phase can compute an additive top-up without a second round-trip.
      const existingRoles = (await queryRunner.query(
        `
        SELECT r.id, LOWER(r.name) AS name, r.is_system,
               p.panel_permissions, p.resource_permissions
        FROM "auth"."tenant_roles" r
        LEFT JOIN "auth"."tenant_role_permissions" p ON p.role_id = r.id
        WHERE r."tenantId" = $1
        FOR UPDATE OF r
        `,
        [tenantId],
      )) as Array<{
        id: string;
        name: string;
        is_system: boolean;
        panel_permissions: PanelMatrix | string | null;
        resource_permissions: string[] | null;
      }>;
      const existingNames = new Set(existingRoles.map((r) => r.name));

      // Resolve the tenant's entitled capability set ONCE, inside the tx so it
      // reflects the committed module state. Fail-safe: zero module rows ⇒ only
      // CORE capabilities (module-gated grants denied, never silently allowed).
      const entitled = await resolveEntitledCapabilities(
        (sql, params) => queryRunner.query(sql, [...params]),
        tenantId,
      );

      // ---- Phase 1: create the ABSENT named defaults --------------------------
      const createdNames: string[] = [];
      for (const roleTemplate of DEFAULT_TENANT_ROLES) {
        // Idempotent: a default already present (by name, this tenant) is left to
        // the reconcile phase. Re-running only fills gaps — it never duplicates.
        if (existingNames.has(roleTemplate.name.toLowerCase())) {
          continue;
        }

        // "tenantId" prepended as $1 (ORPHAN-CRITICAL-100); template params shift +1.
        const roleResult = await queryRunner.query(
          `
          INSERT INTO "auth"."tenant_roles" (
            "tenantId", name, description, color, icon, level, is_system, is_default, created_by, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
          RETURNING id
          `,
          [
            tenantId,
            roleTemplate.name,
            roleTemplate.description,
            roleTemplate.color,
            roleTemplate.icon,
            roleTemplate.level,
            roleTemplate.isSystem,
            roleTemplate.isDefault,
            createdBy,
          ],
        );

        const roleId = roleResult[0].id;
        // Entitlement-gated: the stored panel + resources carry only capabilities
        // the tenant's plan licenses, so a non-entitled grant is never seeded.
        const { panel, resources } = this.entitledTemplate(roleTemplate.name, entitled);

        // Tenant-safe transitively via the role_id inserted above in this tx.
        await queryRunner.query(
          `
          INSERT INTO "auth"."tenant_role_permissions" (
            role_id, panel_permissions, resource_permissions, created_at, updated_at
          ) VALUES ($1, $2, $3, NOW(), NOW())
          `,
          [roleId, JSON.stringify(panel), resources],
        );

        createdNames.push(roleTemplate.name);
        this.logger.debug(`Created default role: ${roleTemplate.name}`);
      }

      // ---- Phase 2: reconcile EXISTING default-named system roles -------------
      const reconciled = await this.reconcileDefaultRolePermissions(
        queryRunner,
        existingRoles,
        entitled,
      );
      const reconciledNames = reconciled.map((r) => r.name);

      // RBAC-C3: fail-CLOSED audit, atomic with the writes. One row for the
      // create phase (real names/count, not the template list) and one for the
      // reconcile phase — each only when it actually changed state.
      if (createdNames.length > 0) {
        await this.auditLogService.log(
          {
            tenantId,
            performedBy: createdBy,
            action: 'ROLES_SEEDED',
            entityType: 'TenantRole',
            details: {
              count: createdNames.length,
              roleNames: createdNames,
              timestamp: new Date().toISOString(),
            },
            severity: AuditLogSeverity.WARNING,
          },
          queryRunner.manager,
        );
      }
      if (reconciledNames.length > 0) {
        await this.auditLogService.log(
          {
            tenantId,
            performedBy: createdBy,
            action: 'ROLES_RECONCILED',
            entityType: 'TenantRole',
            details: {
              count: reconciledNames.length,
              roleNames: reconciledNames,
              timestamp: new Date().toISOString(),
            },
            severity: AuditLogSeverity.WARNING,
          },
          queryRunner.manager,
        );
      }

      await queryRunner.commitTransaction();

      this.logger.log(
        `Seeded ${createdNames.length} and reconciled ${reconciledNames.length} default role(s) for tenant ${tenantId}` +
          (createdNames.length === 0 && reconciledNames.length === 0
            ? ' (all defaults already current)'
            : ''),
      );

      // RBAC-HIGH-001: a reconcile widened at least one active role's effective
      // set — revoke live tokens of every holder so the new grants take effect on
      // the next request. Runs AFTER commit so a revoke is never issued for a
      // change that rolled back. Best-effort per user (see helper).
      for (const role of reconciled) {
        await this.revokeTokensForRoleHolders(tenantId, role.id);
      }

      return this.getTenantRoles(tenantId);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Failed to seed default roles for tenant ${tenantId}: ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * RBAC-MEDIUM-015: additively top-up existing default-NAMED, `is_system` roles
   * with any entitled template capability they are missing, derived live from the
   * `DEFAULT_ROLE_PERMISSIONS` SSoT. Returns the names of roles actually changed
   * (empty ⇒ everything already current, so the caller writes no audit and
   * revokes no tokens). Runs inside the caller's SERIALIZABLE transaction on its
   * queryRunner, so the top-up commits atomically with the create phase.
   *
   * Discipline:
   *  - ADDITIVE only (set UNION): a prior grant is never removed, so a tenant
   *    admin's widening of a default role survives; a re-run adds nothing.
   *  - Scope: ONLY roles whose current name matches a shipped default AND
   *    `is_system = true`. A renamed or custom role is the tenant admin's to
   *    manage in the role editor — never touched here.
   *  - ENTITLEMENT-GATED: the template is intersected with `entitled` first, so a
   *    module-gated capability is never persisted for a tenant without the module
   *    (consistent with the CapabilityAuthorityService write boundary).
   */
  private async reconcileDefaultRolePermissions(
    queryRunner: QueryRunner,
    existingRoles: ReadonlyArray<{
      id: string;
      name: string;
      is_system: boolean;
      panel_permissions: PanelMatrix | string | null;
      resource_permissions: string[] | null;
    }>,
    entitled: ReadonlySet<string>,
  ): Promise<Array<{ id: string; name: string }>> {
    const defaultTemplateByName = new Map(
      DEFAULT_TENANT_ROLES.map((t) => [t.name.toLowerCase(), t.name]),
    );

    const reconciled: Array<{ id: string; name: string }> = [];
    for (const role of existingRoles) {
      // Only shipped, system-owned defaults are platform-managed baselines.
      const templateName = defaultTemplateByName.get(role.name);
      if (!templateName || !role.is_system) {
        continue;
      }

      const { panel: templatePanel, resources: templateResources } = this.entitledTemplate(
        templateName,
        entitled,
      );

      const storedResources = new Set(role.resource_permissions ?? []);
      const missing = templateResources.filter((cap) => !storedResources.has(cap));
      if (missing.length === 0) {
        continue; // idempotent: already carries every entitled template capability
      }

      const mergedResources = [...storedResources, ...missing];
      const storedPanel = this.parsePanel(role.panel_permissions);
      const mergedPanel = this.mergeGrantsIntoPanel(storedPanel, templatePanel);

      await queryRunner.query(
        `
        UPDATE "auth"."tenant_role_permissions"
        SET panel_permissions = $1, resource_permissions = $2, updated_at = NOW()
        WHERE role_id = $3
        `,
        [JSON.stringify(mergedPanel), mergedResources, role.id],
      );

      reconciled.push({ id: role.id, name: templateName });
      this.logger.debug(
        `Reconciled default role "${templateName}" (${role.id}): +${missing.length} capability(ies)`,
      );
    }

    return reconciled;
  }

  /**
   * The template capabilities a default role should carry, filtered to the
   * tenant's entitled set. Returns the enforced `resource:action` list AND the
   * display panel with every non-entitled grant stripped, so a stored role never
   * advertises or enforces a capability the tenant's plan does not license.
   */
  private entitledTemplate(
    roleName: string,
    entitled: ReadonlySet<string>,
  ): { panel: PanelMatrix; resources: string[] } {
    const template = DEFAULT_ROLE_PERMISSIONS[roleName] ?? {};
    const panel: PanelMatrix = {};
    for (const [category, resources] of Object.entries(template)) {
      const categoryOut: Record<string, Record<string, boolean>> = {};
      for (const [resource, actions] of Object.entries(resources)) {
        const actionsOut: Record<string, boolean> = {};
        for (const [action, enabled] of Object.entries(actions)) {
          // A grant survives only if the tenant is entitled to it; a non-grant
          // (false) is display metadata and is kept verbatim.
          actionsOut[action] = enabled && entitled.has(`${resource}:${action}`);
        }
        categoryOut[resource] = actionsOut;
      }
      panel[category] = categoryOut;
    }
    // Derived from the already entitlement-filtered panel ⇒ entitled trues only.
    return { panel, resources: panelPermissionsToResourceArray(panel) };
  }

  /**
   * Deep additive merge: every GRANT (`true`) in `additions` is turned on in a
   * copy of `stored`; nothing is ever turned off. Preserves a tenant admin's own
   * edits to actions the template does not grant.
   */
  private mergeGrantsIntoPanel(stored: PanelMatrix, additions: PanelMatrix): PanelMatrix {
    const merged: PanelMatrix = {};
    for (const [category, resources] of Object.entries(stored)) {
      merged[category] = {};
      for (const [resource, actions] of Object.entries(resources)) {
        merged[category][resource] = { ...actions };
      }
    }
    for (const [category, resources] of Object.entries(additions)) {
      merged[category] ??= {};
      for (const [resource, actions] of Object.entries(resources)) {
        merged[category][resource] ??= {};
        for (const [action, enabled] of Object.entries(actions)) {
          if (enabled) {
            merged[category][resource][action] = true;
          }
        }
      }
    }
    return merged;
  }

  /** Normalize a stored panel_permissions cell (jsonb object or string) to an object. */
  private parsePanel(value: PanelMatrix | string | null): PanelMatrix {
    if (!value) {
      return {};
    }
    return typeof value === 'string' ? (JSON.parse(value) as PanelMatrix) : value;
  }

  /**
   * Get permission categories structure for UI
   */
  getPermissionCategories(): typeof PERMISSION_CATEGORIES {
    return PERMISSION_CATEGORIES;
  }

  /**
   * RBAC-HIGH-001: revoke the live tokens of every ACTIVE holder of a role after
   * its permission set changed. Tenant-scoped via the tenant_roles join
   * (ORPHAN-CRITICAL-100). Best-effort per user — one Redis hiccup must not undo
   * the committed role edit — but each failure is logged.
   */
  private async revokeTokensForRoleHolders(tenantId: string, roleId: string): Promise<void> {
    const holders = await this.dataSource.query<Array<{ user_id: string }>>(
      `
      SELECT ura.user_id
      FROM "auth"."user_role_assignments" ura
      JOIN "auth"."tenant_roles" tr ON tr.id = ura.role_id
      WHERE ura.role_id = $1 AND ura.is_active = true AND tr."tenantId" = $2
      `,
      [roleId, tenantId],
    );

    for (const { user_id: userId } of holders) {
      try {
        await this.userTokenRevocation.revokeUserTokens(userId);
      } catch (error) {
        this.logger.error(
          `Failed to revoke tokens for role holder ${userId} after role ${roleId} edit: ${(error as Error).message}`,
        );
      }
    }
  }

  private mapRowToRole(row: Record<string, unknown>): TenantRoleWithDetails {
    return {
      id: row['id'] as string,
      name: row['name'] as string,
      description: row['description'] as string | null,
      color: row['color'] as string,
      icon: row['icon'] as string,
      level: row['level'] as number,
      isSystem: row['is_system'] as boolean,
      isDefault: row['is_default'] as boolean,
      userCount: (row['user_count'] as number) || 0,
      permissions: row['permission_id']
        ? {
            id: row['permission_id'] as string,
            roleId: row['id'] as string,
            panelPermissions:
              typeof row['panel_permissions'] === 'string'
                ? JSON.parse(row['panel_permissions'])
                : (row['panel_permissions'] as Record<string, Record<string, Record<string, boolean>>>) || {},
            resourcePermissions: (row['resource_permissions'] as string[]) || [],
          }
        : null,
      createdAt: row['created_at'] as Date,
      updatedAt: row['updated_at'] as Date,
    };
  }
}
