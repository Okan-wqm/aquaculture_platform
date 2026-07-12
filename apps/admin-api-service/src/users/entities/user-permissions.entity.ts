import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * RBAC-HIGH-009 — persistence mapping ONLY.
 *
 * `shared.user_permissions` is a phantom authorization store: NO guard or
 * token-mint path reads it (enforcement is the auth-service tenant-RBAC folded
 * into the JWT `resourcePermissions` claim). Its write/read service, the
 * SUPER_ADMIN controller endpoints, and the FE surface were removed. This
 * entity is retained SOLELY so the schema-drift validator keeps a shape for
 * the canonical protected `shared.user_permissions` table — dropping the table
 * is governed (ADR + architectural-arbiter) and tracked separately. Do NOT
 * reintroduce a service or endpoint over this entity; per-user authority lives
 * in `auth.tenant_role_permissions`.
 */

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

@Entity('user_permissions', { schema: 'shared' })
@Index('idx_user_permissions_user', ['userId'])
@Index('idx_user_permissions_tenant', ['tenantId'])
@Index('idx_user_permissions_user_tenant_unique', ['userId', 'tenantId'], { unique: true })
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
