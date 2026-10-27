import { Logger } from '@nestjs/common';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RemoveInertTenantCapabilities1810500000000 (RBAC-HIGH-025, plan PKG-03)
 *
 * WHY: the tenant capability catalogue offered 100 `resource:action` keys and backend checks read
 * 18 of them. PKG-03 removed the keys no check read from the catalogue
 * (libs/shared-contracts/src/access/tenant-capabilities.ts). The token mint already intersects a
 * member's grants with the catalogue, so a stored grant of a removed key has no effect — but the
 * stored rows still name them: the role editor reads a role's panel and resource list, and the
 * write path refuses every key outside the catalogue, so a role saved back with a removed key
 * would fail. This migration removes the removed keys from what is stored:
 *
 *   - `auth.tenant_role_permissions.resource_permissions`: the enforced grant list;
 *   - `auth.tenant_role_permissions.panel_permissions`: the editor's panel — the action is
 *     dropped, then any resource and category left empty;
 *   - `auth.user_role_assignments.permission_overrides`: per-user grants and revokes.
 *
 * The removed set is the snapshot below, never the live catalogue: a migration states a fact
 * about one release. `settings:view` is not in it — only the web reads it, and it leaves with
 * the PKG-03 web part (release R2). A key outside the snapshot (a display-name panel entry, a
 * key a later release adds) is left as it is.
 *
 * Idempotent: a row without a removed key is not written, so a second run changes nothing.
 * Every row read is locked (`FOR UPDATE`) inside the migration's transaction, so a role edit
 * running beside it waits instead of writing over the cleaned row. Per-tenant counts are logged.
 *
 * No token is revoked: removing a key nothing reads changes no access decision, and the mint
 * already leaves these keys out of every new token.
 *
 * Tables live in the `auth` schema and are owned by the admin-api-service migration runner
 * (1800500000000-TenantProvisioningTopology; precedent 1810300000000), so statements are
 * schema-qualified, not a per-tenant fan-out.
 */

/** The keys PKG-03 removed from the catalogue: no backend check read any of them. */
export const INERT_TENANT_CAPABILITIES: readonly string[] = Object.freeze([
  // Farm Management
  'sites:view',
  'sites:create',
  'sites:edit',
  'sites:delete',
  'departments:view',
  'departments:create',
  'departments:edit',
  'departments:delete',
  'systems:view',
  'systems:create',
  'systems:edit',
  'systems:delete',
  'tanks:view',
  'tanks:create',
  'tanks:edit',
  'tanks:delete',
  'tanks:assign',
  'ponds:view',
  'ponds:create',
  'ponds:edit',
  'ponds:delete',
  'equipment:view',
  'equipment:create',
  'equipment:edit',
  'equipment:delete',
  'equipment:assign',
  // Batch & Production
  'batches:view',
  'batches:create',
  'batches:edit',
  'batches:delete',
  'batches:transfer',
  'batches:split',
  'batches:merge',
  'species:view',
  'species:create',
  'species:edit',
  'species:delete',
  'mortality:view',
  'mortality:record',
  'growth:view',
  'growth:record',
  'growth:analyze',
  'harvest:view',
  'harvest:plan',
  'harvest:record',
  // Operations
  'feeding:view',
  'feeding:record',
  'feeding:manage_schedules',
  'feeding:manage_inventory',
  'sensors:view',
  'sensors:configure',
  'sensors:calibrate',
  'sensors:manage_alerts',
  'maintenance:view',
  'maintenance:create_work_orders',
  'maintenance:complete',
  'maintenance:manage_schedules',
  'water_quality:view',
  'water_quality:record',
  // HR & Administration
  'employees:view',
  'employees:create',
  'employees:edit',
  'employees:delete',
  'attendance:view',
  'attendance:manage',
  'leave:view',
  'leave:approve',
  'shifts:view',
  'shifts:create',
  'shifts:edit',
  'shifts:delete',
  // Reports & Analytics
  'dashboard:view',
  'dashboard:analytics',
  'reports:view',
  'reports:export',
  'reports:create_custom',
  // Settings & User Management
  'settings:edit',
  // Messaging
  'channels:view',
  'channels:create_dm',
  'channels:manage',
  'messages:send',
]);

const INERT: ReadonlySet<string> = new Set(INERT_TENANT_CAPABILITIES);

/** A role panel: category → resource → action → granted. */
type Panel = Record<string, Record<string, Record<string, boolean>>>;

interface OverrideSet {
  grants: string[];
  revokes: string[];
}

interface RoleRow {
  role_id: string;
  tenant_id: string;
  panel_permissions: unknown;
  resource_permissions: string[] | null;
}

interface AssignmentRow {
  id: string;
  tenant_id: string;
  permission_overrides: unknown;
}

interface TenantCounts {
  roles: number;
  roleGrants: number;
  assignments: number;
  overrideEntries: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A jsonb cell as the driver returns it: an object, or its text. */
function jsonCell(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/** The panel without the removed keys; a resource or category left empty is dropped. */
export function panelWithoutInert(panel: Panel): Panel {
  const result: Panel = {};
  for (const [category, resources] of Object.entries(panel)) {
    const keptResources: Record<string, Record<string, boolean>> = {};
    for (const [resource, actions] of Object.entries(resources)) {
      const kept = Object.fromEntries(
        Object.entries(actions).filter(([action]) => !INERT.has(`${resource}:${action}`)),
      );
      if (Object.keys(kept).length > 0) keptResources[resource] = kept;
    }
    if (Object.keys(keptResources).length > 0) result[category] = keptResources;
  }
  return result;
}

/** The stored panel as a panel, or `null` when the cell is not one (left untouched). */
function readPanel(value: unknown): Panel | null {
  const cell = jsonCell(value);
  if (!isRecord(cell)) return null;
  const panel: Panel = {};
  for (const [category, resources] of Object.entries(cell)) {
    if (!isRecord(resources)) return null;
    panel[category] = {};
    for (const [resource, actions] of Object.entries(resources)) {
      if (!isRecord(actions)) return null;
      const typed: Record<string, boolean> = {};
      for (const [action, granted] of Object.entries(actions)) {
        if (typeof granted !== 'boolean') return null;
        typed[action] = granted;
      }
      panel[category][resource] = typed;
    }
  }
  return panel;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** The overrides without the removed keys, or `null` when they hold none. */
export function overridesWithoutInert(value: unknown): OverrideSet | null {
  const cell = jsonCell(value);
  if (!isRecord(cell)) return null;
  const grants = stringList(cell['grants']);
  const revokes = stringList(cell['revokes']);
  if (![...grants, ...revokes].some((key) => INERT.has(key))) return null;
  return {
    grants: grants.filter((key) => !INERT.has(key)),
    revokes: revokes.filter((key) => !INERT.has(key)),
  };
}

export class RemoveInertTenantCapabilities1810500000000 implements MigrationInterface {
  name = 'RemoveInertTenantCapabilities1810500000000';

  private readonly logger = new Logger(RemoveInertTenantCapabilities1810500000000.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    const counts = new Map<string, TenantCounts>();
    const countsOf = (tenantId: string): TenantCounts => {
      const existing = counts.get(tenantId);
      if (existing !== undefined) return existing;
      const created = { roles: 0, roleGrants: 0, assignments: 0, overrideEntries: 0 };
      counts.set(tenantId, created);
      return created;
    };

    const roles: RoleRow[] = await queryRunner.query(`
      SELECT trp.role_id, tr."tenantId" AS tenant_id, trp.panel_permissions,
             trp.resource_permissions
      FROM "auth"."tenant_role_permissions" trp
      JOIN "auth"."tenant_roles" tr ON tr.id = trp.role_id
      ORDER BY tr."tenantId", trp.role_id
      FOR UPDATE OF trp
    `);
    for (const role of roles) {
      const stored = role.resource_permissions ?? [];
      const resources = stored.filter((key) => !INERT.has(key));
      const storedPanel = readPanel(role.panel_permissions);
      const panel = storedPanel === null ? null : panelWithoutInert(storedPanel);
      const panelChanged =
        storedPanel !== null && JSON.stringify(panel) !== JSON.stringify(storedPanel);
      if (resources.length === stored.length && !panelChanged) continue;
      await queryRunner.query(
        `
        UPDATE "auth"."tenant_role_permissions"
        SET panel_permissions = COALESCE($1::jsonb, panel_permissions),
            resource_permissions = $2::text[],
            updated_at = NOW()
        WHERE role_id = $3
        `,
        [panel === null ? null : JSON.stringify(panel), resources, role.role_id],
      );
      const tenant = countsOf(role.tenant_id);
      tenant.roles += 1;
      tenant.roleGrants += stored.length - resources.length;
    }

    const assignments: AssignmentRow[] = await queryRunner.query(`
      SELECT ura.id, tr."tenantId" AS tenant_id, ura.permission_overrides
      FROM "auth"."user_role_assignments" ura
      JOIN "auth"."tenant_roles" tr ON tr.id = ura.role_id
      ORDER BY tr."tenantId", ura.id
      FOR UPDATE OF ura
    `);
    for (const assignment of assignments) {
      const cleaned = overridesWithoutInert(assignment.permission_overrides);
      if (cleaned === null) continue;
      const before = overrideEntryCount(assignment.permission_overrides);
      await queryRunner.query(
        `
        UPDATE "auth"."user_role_assignments"
        SET permission_overrides = $1::jsonb,
            updated_at = NOW()
        WHERE id = $2
        `,
        [JSON.stringify(cleaned), assignment.id],
      );
      const tenant = countsOf(assignment.tenant_id);
      tenant.assignments += 1;
      tenant.overrideEntries += before - cleaned.grants.length - cleaned.revokes.length;
    }

    let roleTotal = 0;
    let assignmentTotal = 0;
    for (const [tenantId, tenant] of counts) {
      roleTotal += tenant.roles;
      assignmentTotal += tenant.assignments;
      this.logger.log(
        JSON.stringify({ event: 'inert_tenant_capabilities_removed', tenantId, ...tenant }),
      );
    }
    this.logger.log(
      JSON.stringify({
        event: 'inert_tenant_capabilities_cleanup_done',
        tenants: counts.size,
        roles: roleTotal,
        assignments: assignmentTotal,
      }),
    );
  }

  /**
   * Restores nothing: the removed keys were read by no check, and which role or override held
   * which of them is not kept. Re-granting one would grant nothing.
   */
  public async down(_queryRunner: QueryRunner): Promise<void> {
    this.logger.log(JSON.stringify({ event: 'inert_tenant_capabilities_down_noop' }));
  }
}

/** How many override entries a cell holds, removed keys included. */
function overrideEntryCount(value: unknown): number {
  const cell = jsonCell(value);
  if (!isRecord(cell)) return 0;
  return stringList(cell['grants']).length + stringList(cell['revokes']).length;
}
