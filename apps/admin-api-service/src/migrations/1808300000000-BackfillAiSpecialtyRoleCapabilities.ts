import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BackfillAiSpecialtyRoleCapabilities1808300000000 (FARM-AI PR-1)
 *
 * WHY: the `ai_specialists` category (`ai_specialties:farm` — the capability
 * the farm-specialist personas require on top of their tier grant) was added
 * to the RBAC catalogue and to the seeded-role defaults. New tenants get it at
 * provisioning via seedDefaultRoles — but that method SKIPS tenants that
 * already have roles, so EXISTING tenants' auth.tenant_role_permissions rows
 * would carry no `ai_specialties:farm`. The specialist personas' availability
 * filter and the ai-service permission check fail closed without it, so
 * shipping the catalogue without this backfill would show every existing
 * tenant the specialists as unavailable forever (admins bypass, members do
 * not).
 *
 * Same shape as 1801300000000-BackfillMessagingAiRoleCapabilities: ADDITIVE,
 * IDEMPOTENT, keyed by role NAME against the shipped default-role templates
 * (renamed/custom roles stay the tenant admin's responsibility). panel key is
 * merged with `||`, the `resource:action` string is UNION-ed in with DISTINCT.
 * All five shipped roles get farm:true — the persona TIER grant
 * (ai_personas:operator/manager/expert) remains the actual access divider.
 *
 * Entitlement note: holding `ai_specialties:farm` requires the tenant to have
 * BOTH the ai and farm modules (CATEGORY_MODULE_REQUIREMENTS all-of). The
 * grant authority would reject a write for an unlicensed tenant; this
 * backfill writes the capability regardless and lets the entitlement filter
 * neutralize it at token-mint time — identical posture to the Faz 7 backfill
 * (a stale grant has zero runtime effect until the modules are enabled).
 *
 * `auth` is not in TENANT_AWARE_SCHEMAS — schema-qualified single-schema DDL,
 * no fan-out (see 1801300000000).
 */

interface RoleBackfill {
  readonly name: string;
  readonly panel: Record<string, Record<string, Record<string, boolean>>>;
  readonly resources: readonly string[];
}

export const BACKFILL: readonly RoleBackfill[] = [
  {
    name: 'Supervisor',
    panel: {
      ai_specialists: { ai_specialties: { farm: true } },
    },
    resources: ['ai_specialties:farm'],
  },
  {
    name: 'Technician',
    panel: {
      ai_specialists: { ai_specialties: { farm: true } },
    },
    resources: ['ai_specialties:farm'],
  },
  {
    name: 'Feed Manager',
    panel: {
      ai_specialists: { ai_specialties: { farm: true } },
    },
    resources: ['ai_specialties:farm'],
  },
  {
    name: 'Operator',
    panel: {
      ai_specialists: { ai_specialties: { farm: true } },
    },
    resources: ['ai_specialties:farm'],
  },
  {
    name: 'Viewer',
    panel: {
      ai_specialists: { ai_specialties: { farm: true } },
    },
    resources: ['ai_specialties:farm'],
  },
];

export class BackfillAiSpecialtyRoleCapabilities1808300000000
  implements MigrationInterface
{
  name = 'BackfillAiSpecialtyRoleCapabilities1808300000000';

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
