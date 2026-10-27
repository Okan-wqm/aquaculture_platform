import { Logger } from '@nestjs/common';
import { MigrationInterface, QueryRunner } from 'typeorm';

import {
  INERT,
  overrideEntryCount,
  overridesWithoutInert,
  panelWithoutInert,
  readPanel,
} from './support/inert-tenant-capabilities';

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
 * The removed set is the snapshot in ./support/inert-tenant-capabilities.ts, never the live
 * catalogue: a migration states a fact about one release. `settings:view` is not in it — only the web reads it, and it leaves with
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
