import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * RBAC-HIGH-011 — `auth.tenant_role_permissions` persistence mapping.
 * See tenant-role.entity.ts for why these entities exist (ADR-012 drift
 * visibility for the centralized RBAC tables). Columns mirror the migration
 * DDL exactly. `role_id` has a DB FK → tenant_roles(id) ON DELETE CASCADE
 * (already in the DDL). This table carries NO `tenantId` column — tenant
 * ownership is transitive via the join to tenant_roles.
 */
@Entity('tenant_role_permissions', { schema: 'auth' })
@Index('idx_tenant_role_permissions_role_id', ['roleId'])
export class TenantRolePermission {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'role_id' })
  roleId!: string;

  @Column({ type: 'jsonb', name: 'panel_permissions', default: () => "'{}'" })
  panelPermissions!: unknown;

  @Column({ type: 'text', name: 'resource_permissions', array: true, default: () => "'{}'" })
  resourcePermissions!: string[];

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
