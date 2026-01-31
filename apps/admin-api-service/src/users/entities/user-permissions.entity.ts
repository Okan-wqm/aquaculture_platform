import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * Permission categories that map to frontend panel sections
 */
export interface PanelPermissions {
  // Dashboard
  dashboard: {
    view: boolean;
    viewAnalytics: boolean;
    exportReports: boolean;
  };

  // Farm Management
  farms: {
    view: boolean;
    create: boolean;
    edit: boolean;
    delete: boolean;
  };

  // Batch/Fish Management
  batches: {
    view: boolean;
    create: boolean;
    edit: boolean;
    delete: boolean;
    recordMortality: boolean;
    transfer: boolean;
  };

  // Feeding
  feeding: {
    view: boolean;
    createRecords: boolean;
    manageSchedules: boolean;
    manageInventory: boolean;
  };

  // Sensors & IoT
  sensors: {
    view: boolean;
    configure: boolean;
    manageAlerts: boolean;
    viewRawData: boolean;
  };

  // Maintenance
  maintenance: {
    view: boolean;
    createWorkOrders: boolean;
    completeWorkOrders: boolean;
    manageSpareParts: boolean;
    manageSchedules: boolean;
  };

  // HR (if enabled)
  hr: {
    view: boolean;
    manageEmployees: boolean;
    manageAttendance: boolean;
    manageLeave: boolean;
    viewPayroll: boolean;
    managePayroll: boolean;
  };

  // Reports
  reports: {
    view: boolean;
    export: boolean;
    createCustom: boolean;
  };

  // Settings
  settings: {
    viewTenantSettings: boolean;
    editTenantSettings: boolean;
    manageIntegrations: boolean;
  };

  // User Management (only for admins)
  users: {
    view: boolean;
    invite: boolean;
    editPermissions: boolean;
    deactivate: boolean;
  };
}

@Entity('user_permissions', { schema: 'public' })
@Index('idx_user_permissions_user', ['userId'])
@Index('idx_user_permissions_tenant', ['tenantId'])
export class UserPermissions {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  @Column({ type: 'jsonb', default: {} })
  permissions!: PanelPermissions;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'uuid', nullable: true })
  grantedBy?: string; // TENANT_ADMIN who granted these permissions

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}

/**
 * Default permissions for new users (minimal access)
 */
export const DEFAULT_USER_PERMISSIONS: PanelPermissions = {
  dashboard: { view: true, viewAnalytics: false, exportReports: false },
  farms: { view: true, create: false, edit: false, delete: false },
  batches: {
    view: true,
    create: false,
    edit: false,
    delete: false,
    recordMortality: false,
    transfer: false,
  },
  feeding: {
    view: true,
    createRecords: false,
    manageSchedules: false,
    manageInventory: false,
  },
  sensors: {
    view: true,
    configure: false,
    manageAlerts: false,
    viewRawData: false,
  },
  maintenance: {
    view: true,
    createWorkOrders: false,
    completeWorkOrders: false,
    manageSpareParts: false,
    manageSchedules: false,
  },
  hr: {
    view: false,
    manageEmployees: false,
    manageAttendance: false,
    manageLeave: false,
    viewPayroll: false,
    managePayroll: false,
  },
  reports: { view: true, export: false, createCustom: false },
  settings: {
    viewTenantSettings: false,
    editTenantSettings: false,
    manageIntegrations: false,
  },
  users: { view: false, invite: false, editPermissions: false, deactivate: false },
};

/**
 * Full permissions for TENANT_ADMIN
 */
export const TENANT_ADMIN_PERMISSIONS: PanelPermissions = {
  dashboard: { view: true, viewAnalytics: true, exportReports: true },
  farms: { view: true, create: true, edit: true, delete: true },
  batches: {
    view: true,
    create: true,
    edit: true,
    delete: true,
    recordMortality: true,
    transfer: true,
  },
  feeding: {
    view: true,
    createRecords: true,
    manageSchedules: true,
    manageInventory: true,
  },
  sensors: {
    view: true,
    configure: true,
    manageAlerts: true,
    viewRawData: true,
  },
  maintenance: {
    view: true,
    createWorkOrders: true,
    completeWorkOrders: true,
    manageSpareParts: true,
    manageSchedules: true,
  },
  hr: {
    view: true,
    manageEmployees: true,
    manageAttendance: true,
    manageLeave: true,
    viewPayroll: true,
    managePayroll: true,
  },
  reports: { view: true, export: true, createCustom: true },
  settings: {
    viewTenantSettings: true,
    editTenantSettings: true,
    manageIntegrations: true,
  },
  users: { view: true, invite: true, editPermissions: true, deactivate: true },
};
