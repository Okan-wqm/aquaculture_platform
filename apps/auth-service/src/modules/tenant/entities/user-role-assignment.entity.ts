import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * RBAC-HIGH-011 — `auth.user_role_assignments` persistence mapping.
 * See tenant-role.entity.ts for why these entities exist (ADR-012 drift
 * visibility for the centralized RBAC tables). Columns mirror the migration
 * DDL exactly. `role_id` has a DB FK → tenant_roles(id) ON DELETE CASCADE
 * (already in the DDL). This table carries NO `tenantId` column — tenant
 * ownership is transitive via the join to tenant_roles.
 *
 * Outstanding hardening tracked separately (needs a live-data migration):
 *   - FK `user_id` → `auth.users(id)` ON DELETE CASCADE (RBAC-MEDIUM-012):
 *     hard-deleting a user currently strands assignment rows.
 * A DB UNIQUE index already pins `user_id` (one active assignment per user).
 */
@Entity('user_role_assignments', { schema: 'auth' })
@Index('idx_user_role_assignments_role_id', ['roleId'])
@Index('idx_user_role_assignments_is_active', ['isActive'])
export class UserRoleAssignment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'uuid', name: 'role_id' })
  roleId!: string;

  @Column({ type: 'jsonb', name: 'permission_overrides', default: () => `'{"grants":[],"revokes":[]}'` })
  permissionOverrides!: unknown;

  @Column({ type: 'uuid', name: 'assigned_by' })
  assignedBy!: string;

  @Column({ type: 'timestamptz', name: 'assigned_at', default: () => 'now()' })
  assignedAt!: Date;

  @Column({ type: 'timestamptz', name: 'expires_at', nullable: true })
  expiresAt!: Date | null;

  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive!: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
