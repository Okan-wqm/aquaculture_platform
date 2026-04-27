import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

import { TenantRole } from './tenant-role.entity';

/**
 * Permission Overrides Interface
 * Allows granting or revoking specific permissions on top of role
 */
export interface PermissionOverrides {
  grants: string[];  // Additional permissions to grant (e.g., ['sites:delete'])
  revokes: string[]; // Permissions to revoke from role (e.g., ['users:invite'])
}

/**
 * User Role Assignment Entity
 * Links users to tenant-specific roles with optional permission overrides
 * Stored in tenant-specific schema (tenant_XXXX)
 */
@Entity({ schema: 'admin', name: 'user_role_assignments', synchronize: false })
@Index(['userId'], { unique: true })
@Index(['roleId'])
@Index(['isActive'])
export class UserRoleAssignment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'uuid', name: 'role_id' })
  roleId!: string;

  @Column({ type: 'jsonb', default: { grants: [], revokes: [] }, name: 'permission_overrides' })
  permissionOverrides!: PermissionOverrides;

  @Column({ type: 'uuid', name: 'assigned_by' })
  assignedBy!: string;

  @Column({ type: 'timestamptz', name: 'assigned_at', default: () => 'NOW()' })
  assignedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'expires_at' })
  expiresAt?: Date;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive!: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  // Relations
  @ManyToOne(() => TenantRole, { eager: true })
  @JoinColumn({ name: 'role_id' })
  role!: TenantRole;

  // Helper to check if assignment is expired
  isExpired(): boolean {
    if (!this.expiresAt) return false;
    return new Date() > this.expiresAt;
  }

  // Helper to check if assignment is valid (active and not expired)
  isValid(): boolean {
    return this.isActive && !this.isExpired();
  }
}

/**
 * Effective Permissions Result
 * Combined role permissions + overrides
 */
export interface EffectivePermissions {
  roleId: string;
  roleName: string;
  panelPermissions: Record<string, Record<string, Record<string, boolean>>>;
  resourcePermissions: string[];
  overrides: PermissionOverrides;
}

/**
 * Compute effective permissions by merging role permissions with overrides
 */
export function computeEffectivePermissions(
  rolePermissions: string[],
  overrides: PermissionOverrides
): string[] {
  // Start with role permissions
  const permissions = new Set(rolePermissions);

  // Add granted permissions
  for (const grant of overrides.grants) {
    permissions.add(grant);
  }

  // Remove revoked permissions
  for (const revoke of overrides.revokes) {
    permissions.delete(revoke);
  }

  return Array.from(permissions);
}
