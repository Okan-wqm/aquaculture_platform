import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BackfillAiSpecialtyRoleCapabilities1808600000000 (RBAC-MEDIUM-016)
 *
 * WHY: the farm AI specialists (`<tier>-farm-*-v1` personas) are gated by a new
 * catalogue capability `ai_specialties:farm` (auth-service permission-catalogue,
 * category `ai_specialists`, module-gated on ai + farm). New tenants receive it
 * from DEFAULT_ROLE_PERMISSIONS at provisioning, and the RBAC-MEDIUM-015
 * per-role reconcile in tenant-role.service.ts would grant it additively to
 * existing tenants — but that reconcile runs ONLY when a tenant admin invokes
 * the `seedTenantRoles` mutation, never on deploy. Without this migration,
 * every existing tenant's shipped default roles would hold none of it until
 * an admin happened to re-seed, and ai-service's persona authorization
 * (`ai_personas:<tier>` ∧ `ai_specialties:<module>`) would fail closed for
 * every non-admin. Same shape and semantics as the MT-HIGH-057 backfill
 * (1801300000000): additive, idempotent, keyed by role NAME.
 *
 *   - panel_permissions: the `ai_specialists` top-level key is merged in (`||`).
 *   - resource_permissions: `ai_specialties:farm` is UNION-ed in, de-duplicated.
 *
 * Entitlement is NOT decided here, deliberately: the grant is written for
 * every tenant so a tenant that enables the farm module later becomes live
 * without a re-seed, while a tenant without the ai or farm module keeps the
 * grant row and never receives the capability — the token mint and
 * `resolveCallerCapabilities` intersect grants with `entitledCapabilities()`
 * (the single entitlement SSoT), so a non-entitled grant row is inert.
 *
 * Tables live in the `auth` schema but are owned by the admin-api-service
 * migration runner (1800500000000-TenantProvisioningTopology), so statements
 * are schema-qualified, not a per-tenant fan-out.
 */

interface RoleBackfill {
  readonly name: string;
  /** ai_specialists panel sub-tree merged into panel_permissions. */
  readonly panel: Record<string, Record<string, Record<string, boolean>>>;
  /** `resource:action` strings for every enabled action above (UNION-ed in). */
  readonly resources: readonly string[];
}

const AI_SPECIALISTS_PANEL = {
  ai_specialists: {
    ai_specialties: { farm: true },
  },
} as const;

const AI_SPECIALISTS_RESOURCES = ['ai_specialties:farm'] as const;

export const BACKFILL: readonly RoleBackfill[] = [
  'Supervisor',
  'Technician',
  'Feed Manager',
  'Operator',
  'Viewer',
].map((name) => ({ name, panel: AI_SPECIALISTS_PANEL, resources: AI_SPECIALISTS_RESOURCES }));

export class BackfillAiSpecialtyRoleCapabilities1808600000000 implements MigrationInterface {
  name = 'BackfillAiSpecialtyRoleCapabilities1808600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const role of BACKFILL) {
      await queryRunner.query(
        `
        UPDATE "auth"."tenant_role_permissions" trp
        SET panel_permissions =
              COALESCE(trp.panel_permissions, '{}'::jsonb) || $2::jsonb,
            resource_permissions = ARRAY(
              SELECT DISTINCT e
              FROM unnest(
                COALESCE(trp.resource_permissions, '{}'::text[]) || $3::text[]
              ) AS e
            ),
            updated_at = NOW()
        FROM "auth"."tenant_roles" tr
        WHERE trp.role_id = tr.id AND tr.name = $1
        `,
        [role.name, JSON.stringify(role.panel), role.resources],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Inverse of the additive merge: drop the ai_specialists panel key and the
    // resource strings this migration added. The capability was new, so no
    // pre-existing grant is lost.
    for (const role of BACKFILL) {
      await queryRunner.query(
        `
        UPDATE "auth"."tenant_role_permissions" trp
        SET panel_permissions = (trp.panel_permissions - 'ai_specialists'),
            resource_permissions = ARRAY(
              SELECT e
              FROM unnest(trp.resource_permissions) AS e
              WHERE e <> ALL($2::text[])
            ),
            updated_at = NOW()
        FROM "auth"."tenant_roles" tr
        WHERE trp.role_id = tr.id AND tr.name = $1
        `,
        [role.name, role.resources],
      );
    }
  }
}
