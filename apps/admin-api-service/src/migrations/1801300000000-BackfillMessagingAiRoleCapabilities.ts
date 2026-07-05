import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BackfillMessagingAiRoleCapabilities1801300000000 (MT-HIGH-057)
 *
 * WHY: Faz 7 added `messaging` + `ai` capabilities to the RBAC catalogue and to
 * the seeded-role defaults (auth-service tenant-role.service.ts
 * DEFAULT_ROLE_PERMISSIONS). New tenants get them at provisioning via
 * seedDefaultRoles — but that method SKIPS any tenant that already has roles, so
 * EXISTING tenants' `auth.tenant_role_permissions` rows carry none of
 * channels:*, messages:send, ai_assistant:use, ai_personas:*, ai_settings:*.
 * The Faz 7c enforcement (createChannel group gate, ai-service settings/chat/
 * persona gates) fail closed for every non-admin without those grants, so
 * shipping it without this backfill would lock existing members out of group
 * creation AND the AI assistant. Admins bypass the permission check, so they are
 * unaffected either way.
 *
 * This is an ADDITIVE, IDEMPOTENT backfill keyed by role NAME against the
 * DEFAULT_TENANT_ROLES templates:
 *   - panel_permissions: the new `messaging` + `ai` top-level keys are merged in
 *     (`||`). Existing keys (farm/batch/operations/…) are untouched; a re-run
 *     re-writes the same subtree, so it is a no-op.
 *   - resource_permissions: the derived `resource:action` strings are UNION-ed in
 *     and de-duplicated, so prior grants survive and a re-run adds nothing.
 * Tenants that RENAMED or added custom roles are the tenant admin's
 * responsibility (they grant the new capabilities in the role editor) — this
 * only touches roles still named like the shipped defaults.
 *
 * These tables live in the `auth` schema but are owned by the admin-api-service
 * migration runner (it created them in 1800500000000-TenantProvisioningTopology),
 * so the statements are schema-qualified `"auth"."…"`, NOT a per-tenant fan-out
 * (auth is not in TENANT_AWARE_SCHEMAS).
 *
 * The panel objects below are a POINT-IN-TIME SNAPSHOT of the messaging/ai blocks
 * of DEFAULT_ROLE_PERMISSIONS at the time Faz 7 shipped; new tenants continue to
 * receive them directly from that constant via seedDefaultRoles.
 */

interface RoleBackfill {
  readonly name: string;
  /** messaging + ai panel sub-tree merged into panel_permissions. */
  readonly panel: Record<string, Record<string, Record<string, boolean>>>;
  /** `resource:action` strings for every enabled action above (UNION-ed in). */
  readonly resources: readonly string[];
}

export const BACKFILL: readonly RoleBackfill[] = [
  {
    name: 'Supervisor',
    panel: {
      messaging: {
        channels: { view: true, create_group: true, create_dm: true, manage: true },
        messages: { send: true },
      },
      ai: {
        ai_assistant: { use: true },
        ai_settings: { view: true, manage: true },
        ai_personas: { operator: true, manager: true, expert: true, supervisor: false },
      },
    },
    resources: [
      'channels:view', 'channels:create_group', 'channels:create_dm', 'channels:manage',
      'messages:send',
      'ai_assistant:use', 'ai_settings:view', 'ai_settings:manage',
      'ai_personas:operator', 'ai_personas:manager', 'ai_personas:expert',
    ],
  },
  {
    name: 'Technician',
    panel: {
      messaging: {
        channels: { view: true, create_group: true, create_dm: true, manage: false },
        messages: { send: true },
      },
      ai: {
        ai_assistant: { use: true },
        ai_personas: { operator: true, manager: true, expert: false, supervisor: false },
      },
    },
    resources: [
      'channels:view', 'channels:create_group', 'channels:create_dm',
      'messages:send',
      'ai_assistant:use', 'ai_personas:operator', 'ai_personas:manager',
    ],
  },
  {
    name: 'Feed Manager',
    panel: {
      messaging: {
        channels: { view: true, create_group: true, create_dm: true, manage: false },
        messages: { send: true },
      },
      ai: {
        ai_assistant: { use: true },
        ai_personas: { operator: true, manager: true, expert: false, supervisor: false },
      },
    },
    resources: [
      'channels:view', 'channels:create_group', 'channels:create_dm',
      'messages:send',
      'ai_assistant:use', 'ai_personas:operator', 'ai_personas:manager',
    ],
  },
  {
    name: 'Operator',
    panel: {
      messaging: {
        channels: { view: true, create_group: true, create_dm: true, manage: false },
        messages: { send: true },
      },
      ai: {
        ai_assistant: { use: true },
        ai_personas: { operator: true, manager: false, expert: false, supervisor: false },
      },
    },
    resources: [
      'channels:view', 'channels:create_group', 'channels:create_dm',
      'messages:send',
      'ai_assistant:use', 'ai_personas:operator',
    ],
  },
  {
    name: 'Viewer',
    panel: {
      messaging: {
        channels: { view: true, create_group: false, create_dm: true, manage: false },
        messages: { send: true },
      },
      ai: {
        ai_assistant: { use: true },
        ai_personas: { operator: true, manager: false, expert: false, supervisor: false },
      },
    },
    resources: [
      'channels:view', 'channels:create_dm',
      'messages:send',
      'ai_assistant:use', 'ai_personas:operator',
    ],
  },
];

export class BackfillMessagingAiRoleCapabilities1801300000000
  implements MigrationInterface
{
  name = 'BackfillMessagingAiRoleCapabilities1801300000000';

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
    // Inverse of the additive merge: drop the messaging/ai panel keys and remove
    // the resource strings this migration added. The capabilities were new, so no
    // pre-existing messaging/ai grant is lost.
    for (const role of BACKFILL) {
      await queryRunner.query(
        `
        UPDATE "auth"."tenant_role_permissions" trp
        SET panel_permissions = (trp.panel_permissions - 'messaging' - 'ai'),
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
