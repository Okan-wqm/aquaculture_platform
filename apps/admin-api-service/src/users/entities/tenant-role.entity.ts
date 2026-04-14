import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToOne,
  Index,
} from 'typeorm';

import { TenantRolePermissions } from './tenant-role-permissions.entity';

/**
 * Tenant Custom Role Entity
 * Stored in tenant-specific schema (tenant_XXXX)
 * Allows tenant admins to create custom roles for their organization
 */
@Entity({ name: 'tenant_roles', schema: 'auth', synchronize: false })
@Index(['name'], { unique: true })
@Index(['level'])
@Index(['isDefault'])
export class TenantRole {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'varchar', length: 20, default: '#6366F1' })
  color!: string;

  @Column({ type: 'varchar', length: 50, default: 'shield' })
  icon!: string;

  @Column({ type: 'int', default: 50 })
  level!: number;

  @Column({ type: 'boolean', default: false, name: 'is_system' })
  isSystem!: boolean;

  @Column({ type: 'boolean', default: false, name: 'is_default' })
  isDefault!: boolean;

  @Column({ type: 'uuid', name: 'created_by' })
  createdBy!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  // Relations
  // MEDIUM-001 fix: removed eager: true — permissions are now fetched explicitly
  // when needed to avoid automatic JOIN on every TenantRole query.
  @OneToOne(() => TenantRolePermissions, (perms) => perms.role)
  permissions?: TenantRolePermissions;

  // Virtual field - populated by service
  userCount?: number;
}

// Default role templates for new tenants
export const DEFAULT_TENANT_ROLES = [
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
