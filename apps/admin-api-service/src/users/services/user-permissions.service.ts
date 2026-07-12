import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UserPermissions, PanelPermissions, DEFAULT_USER_PERMISSIONS, TENANT_ADMIN_PERMISSIONS } from '../entities/user-permissions.entity';

@Injectable()
export class UserPermissionsService {
  constructor(
    @InjectRepository(UserPermissions)
    private readonly permissionsRepository: Repository<UserPermissions>,
  ) {}

  /**
   * Create default permissions for a new user
   */
  async createDefaultPermissions(
    userId: string,
    tenantId: string,
    grantedBy?: string,
    isAdmin = false,
  ): Promise<UserPermissions> {
    const permissions = this.permissionsRepository.create({
      userId,
      tenantId,
      permissions: isAdmin ? TENANT_ADMIN_PERMISSIONS : DEFAULT_USER_PERMISSIONS,
      grantedBy,
      isActive: true,
    });
    return this.permissionsRepository.save(permissions);
  }

  /**
   * Get permissions for a user
   */
  async getUserPermissions(userId: string, tenantId: string): Promise<UserPermissions | null> {
    return this.permissionsRepository.findOne({
      where: { userId, tenantId, isActive: true },
    });
  }

  /**
   * Update user permissions (TENANT_ADMIN only)
   */
  async updatePermissions(
    userId: string,
    tenantId: string,
    newPermissions: Partial<PanelPermissions>,
    updatedBy: string,
  ): Promise<UserPermissions> {
    const existing = await this.permissionsRepository.findOne({
      where: { userId, tenantId },
    });

    if (!existing) {
      throw new NotFoundException(`Permissions not found for user ${userId}`);
    }

    // Merge existing permissions with new ones
    const mergedPermissions = this.mergePermissions(existing.permissions, newPermissions);

    existing.permissions = mergedPermissions;
    existing.grantedBy = updatedBy;

    return this.permissionsRepository.save(existing);
  }

  /**
   * Check if user has a specific permission
   */
  hasPermission(permissions: PanelPermissions, category: keyof PanelPermissions, action: string): boolean {
    const categoryPerms = permissions[category];
    if (!categoryPerms) return false;
    return (categoryPerms as Record<string, boolean>)[action] === true;
  }

  /**
   * Get all users with permissions for a tenant
   */
  async getTenantUsersPermissions(tenantId: string): Promise<UserPermissions[]> {
    return this.permissionsRepository.find({
      where: { tenantId, isActive: true },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Deactivate user permissions
   */
  async deactivatePermissions(userId: string, tenantId: string): Promise<void> {
    await this.permissionsRepository.update(
      { userId, tenantId },
      { isActive: false },
    );
  }

  /**
   * Deep merge permissions
   */
  private mergePermissions(
    existing: PanelPermissions,
    updates: Partial<PanelPermissions>,
  ): PanelPermissions {
    const result = JSON.parse(JSON.stringify(existing)) as PanelPermissions;

    // BUG-026 fix: removed the `category in result` guard that silently dropped new
    // permission categories. New categories (e.g. from newly added modules) are now
    // merged in instead of being discarded.
    // PanelPermissions has known categories but new ones can be added dynamically,
    // so merge through a record view of the SAME object being returned. (A prior
    // regression rebuilt a detached `{ ...result }` copy on every loop iteration
    // and discarded each merge, so permission updates were never applied.)
    const resultRecord = result as PanelPermissions &
      Record<string, Record<string, boolean>>;
    for (const [category, perms] of Object.entries(updates)) {
      if (perms && typeof perms === 'object') {
        resultRecord[category] = {
          ...(resultRecord[category] ?? {}),
          ...(perms as Record<string, boolean>),
        };
      }
    }

    return result;
  }

  /**
   * Get permission categories for frontend display
   */
  getPermissionCategories(): { category: string; permissions: string[]; label: string }[] {
    return [
      { category: 'dashboard', label: 'Dashboard', permissions: ['view', 'viewAnalytics', 'exportReports'] },
      { category: 'farms', label: 'Farm Management', permissions: ['view', 'create', 'edit', 'delete'] },
      { category: 'batches', label: 'Batch Management', permissions: ['view', 'create', 'edit', 'delete', 'recordMortality', 'transfer'] },
      { category: 'feeding', label: 'Feeding', permissions: ['view', 'createRecords', 'manageSchedules', 'manageInventory'] },
      { category: 'sensors', label: 'Sensors & IoT', permissions: ['view', 'configure', 'manageAlerts', 'viewRawData'] },
      { category: 'maintenance', label: 'Maintenance', permissions: ['view', 'createWorkOrders', 'completeWorkOrders', 'manageSpareParts', 'manageSchedules'] },
      { category: 'hr', label: 'HR Management', permissions: ['view', 'manageEmployees', 'manageAttendance', 'manageLeave', 'viewPayroll', 'managePayroll'] },
      { category: 'reports', label: 'Reports', permissions: ['view', 'export', 'createCustom'] },
      { category: 'settings', label: 'Settings', permissions: ['viewTenantSettings', 'editTenantSettings', 'manageIntegrations'] },
      { category: 'users', label: 'User Management', permissions: ['view', 'invite', 'editPermissions', 'deactivate'] },
    ];
  }
}
