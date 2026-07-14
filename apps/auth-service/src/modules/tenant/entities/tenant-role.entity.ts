import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * RBAC-HIGH-011 — `auth.tenant_roles` persistence mapping.
 *
 * The three centralized RBAC tables (tenant_roles / tenant_role_permissions /
 * user_role_assignments) previously had NO `@Entity` anywhere: DDL was owned by
 * admin-api migrations and DML was issued as raw SQL from both auth-service and
 * admin-api, so they were INVISIBLE to the `SchemaDriftValidator` (ADR-012 blind
 * spot) — a column-shape change on either writer went undetected until a query
 * crashed. These entities give the tables a canonical shape in the OWNING
 * runtime service (auth), so the boot-time drift validator now checks
 * entity ↔ DB parity for them (tier-3 make-it-detectable).
 *
 * The columns mirror the migration DDL EXACTLY
 * (admin-api `1800200000000-CreateAdminEntitySurfaceTables`). Runtime read/write
 * still flows through the existing tenant-pinned raw SQL + CapabilityAuthority
 * write path; this entity does not change that. `schema: 'auth'` is explicit —
 * `auth` is a platform-level schema (auth-service/CLAUDE.md).
 *
 * Known outstanding hardening tracked separately (needs a live-data migration):
 *   - FK `tenantId` → `auth.tenants(id)` ON DELETE RESTRICT (RBAC-MEDIUM-012);
 *   - UNIQUE `(tenantId, LOWER(name))` (duplicate role NAMES are currently
 *     possible — the only uniqueness is on `(tenantId, code)` and the new model
 *     never sets `code`);
 *   - partial UNIQUE `(tenantId) WHERE is_default` (single-default invariant is
 *     app-only today, RBAC-MEDIUM-013).
 */
@Entity('tenant_roles', { schema: 'auth' })
@Index('idx_tenant_roles_tenant_id', ['tenantId'])
export class TenantRole {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenantId', nullable: true })
  tenantId!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  code!: string | null;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  permissions!: unknown;

  @Column({ type: 'varchar', length: 20, default: '#6366F1' })
  color!: string;

  @Column({ type: 'varchar', length: 50, default: 'shield' })
  icon!: string;

  @Column({ type: 'int', default: 50 })
  level!: number;

  @Column({ type: 'boolean', name: 'is_system', default: false })
  isSystem!: boolean;

  @Column({ type: 'boolean', name: 'is_default', default: false })
  isDefault!: boolean;

  @Column({ type: 'boolean', name: 'is_editable', default: true })
  isEditable!: boolean;

  @Column({ type: 'int', name: 'display_order', default: 0 })
  displayOrder!: number;

  @Column({ type: 'uuid', name: 'created_by', nullable: true })
  createdBy!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
