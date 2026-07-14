/**
 * Tenant Module Entities
 */
export * from './tenant.entity';
export * from './tenant-module.entity';
// RBAC-HIGH-011: persistence mappings for the centralized RBAC tables so the
// SchemaDriftValidator sees them (ADR-012). Runtime DML still uses raw SQL.
export * from './tenant-role.entity';
export * from './tenant-role-permission.entity';
export * from './user-role-assignment.entity';
