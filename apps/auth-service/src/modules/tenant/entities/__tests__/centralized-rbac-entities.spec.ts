import 'reflect-metadata';
import { getMetadataArgsStorage } from 'typeorm';

import { TenantRolePermission } from '../tenant-role-permission.entity';
import { TenantRole } from '../tenant-role.entity';
import { UserRoleAssignment } from '../user-role-assignment.entity';

/**
 * RBAC-HIGH-011 — the three centralized RBAC tables now have `@Entity` mappings,
 * so the SchemaDriftValidator sees them (they were an ADR-012 blind spot — "0
 * @Entity matches" in the audit). This is the STATIC (DB-independent) guard:
 * it pins each entity's table name, schema, and the DB column names against the
 * migration DDL so a future column rename/removal on the entity side is caught
 * at unit-test time. The runtime entity ↔ live-DB parity is enforced separately
 * by the boot SchemaDriftValidator (needs a DB; runs in CI/prod).
 */

const storage = getMetadataArgsStorage();

type EntityClass = new () => object;

function entityMeta(target: EntityClass): { name?: string; schema?: string } {
  const table = storage.tables.find((t) => t.target === target);
  if (!table) throw new Error(`No @Entity for ${target.name}`);
  return { name: table.name, schema: table.schema };
}

function dbColumnNames(target: EntityClass): Set<string> {
  const names = new Set<string>();
  // Own columns (@Column / @PrimaryGeneratedColumn) declare `name` or default
  // to the property name; @CreateDateColumn/@UpdateDateColumn declare `name`.
  for (const col of storage.columns.filter((c) => c.target === target)) {
    names.add(col.options.name ?? col.propertyName);
  }
  return names;
}

describe('RBAC-HIGH-011 — centralized RBAC table entities', () => {
  it('maps auth.tenant_roles with its DDL columns', () => {
    expect(entityMeta(TenantRole)).toEqual({ name: 'tenant_roles', schema: 'auth' });
    expect(dbColumnNames(TenantRole)).toEqual(
      new Set([
        'id',
        'tenantId',
        'code',
        'name',
        'description',
        'permissions',
        'color',
        'icon',
        'level',
        'is_system',
        'is_default',
        'is_editable',
        'display_order',
        'created_by',
        'created_at',
        'updated_at',
      ]),
    );
  });

  it('maps auth.tenant_role_permissions with its DDL columns', () => {
    expect(entityMeta(TenantRolePermission)).toEqual({
      name: 'tenant_role_permissions',
      schema: 'auth',
    });
    expect(dbColumnNames(TenantRolePermission)).toEqual(
      new Set(['id', 'role_id', 'panel_permissions', 'resource_permissions', 'created_at', 'updated_at']),
    );
  });

  it('maps auth.user_role_assignments with its DDL columns', () => {
    expect(entityMeta(UserRoleAssignment)).toEqual({
      name: 'user_role_assignments',
      schema: 'auth',
    });
    expect(dbColumnNames(UserRoleAssignment)).toEqual(
      new Set([
        'id',
        'user_id',
        'role_id',
        'permission_overrides',
        'assigned_by',
        'assigned_at',
        'expires_at',
        'is_active',
        'created_at',
        'updated_at',
      ]),
    );
  });

  it('the three tables are all in the platform-level `auth` schema (never per-tenant)', () => {
    for (const target of [TenantRole, TenantRolePermission, UserRoleAssignment]) {
      expect(entityMeta(target).schema).toBe('auth');
    }
  });
});
