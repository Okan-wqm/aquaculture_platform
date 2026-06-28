import {
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Column,
  OneToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

import { TenantRole } from './tenant-role.entity';

/**
 * Permission Categories for Tenant Admin Panel
 * Each category contains resources with CRUD-style actions
 */
export const PERMISSION_CATEGORIES = {
  // Farm Management
  farm: {
    name: 'Farm Management',
    resources: {
      sites: { name: 'Sites', actions: ['view', 'create', 'edit', 'delete'] },
      departments: { name: 'Departments', actions: ['view', 'create', 'edit', 'delete'] },
      systems: { name: 'Systems', actions: ['view', 'create', 'edit', 'delete'] },
      tanks: { name: 'Tanks', actions: ['view', 'create', 'edit', 'delete', 'assign'] },
      ponds: { name: 'Ponds', actions: ['view', 'create', 'edit', 'delete'] },
      equipment: { name: 'Equipment', actions: ['view', 'create', 'edit', 'delete', 'assign'] },
    },
  },
  // Batch & Production
  batch: {
    name: 'Batch & Production',
    resources: {
      batches: { name: 'Batches', actions: ['view', 'create', 'edit', 'delete', 'transfer', 'split', 'merge'] },
      species: { name: 'Species', actions: ['view', 'create', 'edit', 'delete'] },
      mortality: { name: 'Mortality Records', actions: ['view', 'record'] },
      growth: { name: 'Growth Measurements', actions: ['view', 'record', 'analyze'] },
      harvest: { name: 'Harvest', actions: ['view', 'plan', 'record'] },
    },
  },
  // Operations
  operations: {
    name: 'Operations',
    resources: {
      feeding: { name: 'Feeding', actions: ['view', 'record', 'manage_schedules', 'manage_inventory'] },
      sensors: { name: 'Sensors', actions: ['view', 'configure', 'calibrate', 'manage_alerts'] },
      maintenance: { name: 'Maintenance', actions: ['view', 'create_work_orders', 'complete', 'manage_schedules'] },
      water_quality: { name: 'Water Quality', actions: ['view', 'record'] },
    },
  },
  // HR & Administration
  hr: {
    name: 'HR & Administration',
    resources: {
      employees: { name: 'Employees', actions: ['view', 'create', 'edit', 'delete'] },
      attendance: { name: 'Attendance', actions: ['view', 'manage'] },
      leave: { name: 'Leave Management', actions: ['view', 'approve'] },
      shifts: { name: 'Shifts', actions: ['view', 'create', 'edit', 'delete'] },
    },
  },
  // Reports & Analytics
  reports: {
    name: 'Reports & Analytics',
    resources: {
      dashboard: { name: 'Dashboard', actions: ['view', 'analytics'] },
      reports: { name: 'Reports', actions: ['view', 'export', 'create_custom'] },
    },
  },
  // Settings & User Management
  admin: {
    name: 'Settings & User Management',
    resources: {
      settings: { name: 'Settings', actions: ['view', 'edit'] },
      users: { name: 'Users', actions: ['view', 'invite', 'edit_permissions', 'deactivate'] },
      roles: { name: 'Roles', actions: ['view', 'create', 'edit', 'delete'] },
    },
  },
} as const;

// Type for resource permissions
export type ResourcePermission = {
  [resource: string]: {
    [action: string]: boolean;
  };
};

// Type for panel permissions (category -> resource -> action -> boolean)
export interface PanelPermissions {
  farm?: ResourcePermission;
  batch?: ResourcePermission;
  operations?: ResourcePermission;
  hr?: ResourcePermission;
  reports?: ResourcePermission;
  admin?: ResourcePermission;
}

/**
 * Tenant Role Permissions Entity
 * Stores both panel-level and resource:action permissions
 */
// ORPHAN-105: index the token-mint JOIN key. Token minting JOINs
// tenant_role_permissions ON role_id per request; without this index the JOIN
// seq-scans the table on every mint. DDL lands via the paired migration
// (synchronize:false), this decorator records the intent for generated diffs.
@Index('idx_tenant_role_permissions_role_id', ['roleId'])
@Entity({ schema: 'auth', name: 'tenant_role_permissions', synchronize: false })
export class TenantRolePermissions {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'role_id' })
  roleId!: string;

  @Column({ type: 'jsonb', default: {}, name: 'panel_permissions' })
  panelPermissions!: PanelPermissions;

  @Column({ type: 'text', array: true, default: [], name: 'resource_permissions' })
  resourcePermissions!: string[]; // Array of 'resource:action' strings

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  // Relations
  @OneToOne(() => TenantRole, (role) => role.permissions)
  @JoinColumn({ name: 'role_id' })
  role!: TenantRole;
}

// Default permissions for each system role
export const DEFAULT_ROLE_PERMISSIONS: Record<string, Partial<PanelPermissions>> = {
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
  },
  Technician: {
    farm: {
      sites: { view: true, create: false, edit: false, delete: false },
      departments: { view: true, create: false, edit: false, delete: false },
      systems: { view: true, create: false, edit: true, delete: false },
      tanks: { view: true, create: false, edit: true, delete: false, assign: false },
      ponds: { view: true, create: false, edit: true, delete: false },
      equipment: { view: true, create: true, edit: true, delete: false, assign: false },
    },
    batch: {
      batches: { view: true, create: false, edit: false, delete: false, transfer: false, split: false, merge: false },
      species: { view: true, create: false, edit: false, delete: false },
      mortality: { view: true, record: false },
      growth: { view: true, record: false, analyze: false },
      harvest: { view: true, plan: false, record: false },
    },
    operations: {
      feeding: { view: true, record: false, manage_schedules: false, manage_inventory: false },
      sensors: { view: true, configure: true, calibrate: true, manage_alerts: true },
      maintenance: { view: true, create_work_orders: true, complete: true, manage_schedules: true },
      water_quality: { view: true, record: true },
    },
    hr: {
      employees: { view: false, create: false, edit: false, delete: false },
      attendance: { view: false, manage: false },
      leave: { view: false, approve: false },
      shifts: { view: true, create: false, edit: false, delete: false },
    },
    reports: {
      dashboard: { view: true, analytics: false },
      reports: { view: true, export: false, create_custom: false },
    },
    admin: {
      settings: { view: false, edit: false },
      users: { view: false, invite: false, edit_permissions: false, deactivate: false },
      roles: { view: false, create: false, edit: false, delete: false },
    },
  },
  'Feed Manager': {
    farm: {
      sites: { view: true, create: false, edit: false, delete: false },
      departments: { view: true, create: false, edit: false, delete: false },
      systems: { view: true, create: false, edit: false, delete: false },
      tanks: { view: true, create: false, edit: false, delete: false, assign: false },
      ponds: { view: true, create: false, edit: false, delete: false },
      equipment: { view: true, create: false, edit: false, delete: false, assign: false },
    },
    batch: {
      batches: { view: true, create: false, edit: false, delete: false, transfer: false, split: false, merge: false },
      species: { view: true, create: false, edit: false, delete: false },
      mortality: { view: true, record: false },
      growth: { view: true, record: true, analyze: false },
      harvest: { view: true, plan: false, record: false },
    },
    operations: {
      feeding: { view: true, record: true, manage_schedules: true, manage_inventory: true },
      sensors: { view: true, configure: false, calibrate: false, manage_alerts: false },
      maintenance: { view: true, create_work_orders: false, complete: false, manage_schedules: false },
      water_quality: { view: true, record: false },
    },
    hr: {
      employees: { view: false, create: false, edit: false, delete: false },
      attendance: { view: false, manage: false },
      leave: { view: false, approve: false },
      shifts: { view: true, create: false, edit: false, delete: false },
    },
    reports: {
      dashboard: { view: true, analytics: false },
      reports: { view: true, export: true, create_custom: false },
    },
    admin: {
      settings: { view: false, edit: false },
      users: { view: false, invite: false, edit_permissions: false, deactivate: false },
      roles: { view: false, create: false, edit: false, delete: false },
    },
  },
  Operator: {
    farm: {
      sites: { view: true, create: false, edit: false, delete: false },
      departments: { view: true, create: false, edit: false, delete: false },
      systems: { view: true, create: false, edit: false, delete: false },
      tanks: { view: true, create: false, edit: false, delete: false, assign: false },
      ponds: { view: true, create: false, edit: false, delete: false },
      equipment: { view: true, create: false, edit: false, delete: false, assign: false },
    },
    batch: {
      batches: { view: true, create: false, edit: false, delete: false, transfer: false, split: false, merge: false },
      species: { view: true, create: false, edit: false, delete: false },
      mortality: { view: true, record: true },
      growth: { view: true, record: true, analyze: false },
      harvest: { view: true, plan: false, record: false },
    },
    operations: {
      feeding: { view: true, record: true, manage_schedules: false, manage_inventory: false },
      sensors: { view: true, configure: false, calibrate: false, manage_alerts: false },
      maintenance: { view: true, create_work_orders: true, complete: true, manage_schedules: false },
      water_quality: { view: true, record: true },
    },
    hr: {
      employees: { view: false, create: false, edit: false, delete: false },
      attendance: { view: true, manage: false },
      leave: { view: true, approve: false },
      shifts: { view: true, create: false, edit: false, delete: false },
    },
    reports: {
      dashboard: { view: true, analytics: false },
      reports: { view: true, export: false, create_custom: false },
    },
    admin: {
      settings: { view: false, edit: false },
      users: { view: false, invite: false, edit_permissions: false, deactivate: false },
      roles: { view: false, create: false, edit: false, delete: false },
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
      batches: { view: true, create: false, edit: false, delete: false, transfer: false, split: false, merge: false },
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
    hr: {
      employees: { view: false, create: false, edit: false, delete: false },
      attendance: { view: false, manage: false },
      leave: { view: false, approve: false },
      shifts: { view: false, create: false, edit: false, delete: false },
    },
    reports: {
      dashboard: { view: true, analytics: false },
      reports: { view: true, export: false, create_custom: false },
    },
    admin: {
      settings: { view: false, edit: false },
      users: { view: false, invite: false, edit_permissions: false, deactivate: false },
      roles: { view: false, create: false, edit: false, delete: false },
    },
  },
};

// Helper to convert panel permissions to resource:action array
export function panelPermissionsToResourceArray(panel: PanelPermissions): string[] {
  const result: string[] = [];
  for (const [_category, resources] of Object.entries(panel)) {
    for (const [resource, actions] of Object.entries(resources as ResourcePermission)) {
      for (const [action, enabled] of Object.entries(actions)) {
        if (enabled) {
          result.push(`${resource}:${action}`);
        }
      }
    }
  }
  return result;
}

// Helper to check if user has a specific permission
export function hasPermission(
  permissions: PanelPermissions,
  resource: string,
  action: string
): boolean {
  for (const resources of Object.values(permissions)) {
    if (resources && resources[resource] && resources[resource][action]) {
      return true;
    }
  }
  return false;
}
