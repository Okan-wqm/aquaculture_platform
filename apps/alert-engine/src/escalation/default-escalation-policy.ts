import { EntityManager, QueryDeepPartialEntity } from 'typeorm';

import { AlertSeverity } from '../database/entities/alert-rule.entity';
import {
  EscalationActionType,
  EscalationLevel,
  EscalationPolicy,
  EscalationRecipientRole,
  EscalationRecipientScope,
  NotificationChannel,
} from '../database/entities/escalation-policy.entity';

/**
 * The tenant's default escalation policy (ALERT-CRITICAL-004).
 *
 * WHY: escalation starts only when a policy matches, and no tenant was ever
 * given one — so every farm-signal incident (critical water quality, mortality,
 * stock-out) stayed on a screen nobody was paged to look at. A default policy
 * that exists for every tenant makes delivery the zero-effort state.
 *
 * WHAT (plan PR-S1): CRITICAL and HIGH incidents page the site's assigned
 * MODULE_MANAGERs and every TENANT_ADMIN, by push and e-mail. One level, no
 * repeats: until incidents can be acknowledged (plan PR-S2), a repeat would
 * re-page people who already acted. The row is an ordinary policy the tenant
 * can edit; it is only ever INSERTED here, never overwritten.
 */

/** `created_by` of the seeded row — tells an operator where it came from. */
export const DEFAULT_ESCALATION_POLICY_CREATOR = 'system:default-escalation-policy';

export const DEFAULT_ESCALATION_POLICY_NAME = 'Varsayılan alarm politikası';

/** The default policy's recipients, channels and timing (the plan's content). */
export function defaultEscalationLevels(): EscalationLevel[] {
  return [
    {
      level: 1,
      name: 'Saha yöneticileri ve tenant yöneticileri',
      timeoutMinutes: 30,
      notifyUserIds: [],
      notifyRoles: [
        {
          role: EscalationRecipientRole.MODULE_MANAGER,
          scope: EscalationRecipientScope.INCIDENT_SITE,
        },
        { role: EscalationRecipientRole.TENANT_ADMIN, scope: EscalationRecipientScope.TENANT },
      ],
      channels: [NotificationChannel.PUSH, NotificationChannel.EMAIL],
      action: EscalationActionType.NOTIFY,
    },
  ];
}

/** The row the seed inserts — pure, so its content is pinned without a database. */
export function defaultEscalationPolicyRow(
  tenantId: string,
): QueryDeepPartialEntity<EscalationPolicy> {
  return {
    tenantId,
    name: DEFAULT_ESCALATION_POLICY_NAME,
    description:
      'Kritik ve yüksek önemdeki çiftlik alarmları, olayın sahasına atanmış modül ' +
      'yöneticilerine ve tüm tenant yöneticilerine push ve e-posta ile iletilir. ' +
      'Tenant yöneticisi bu politikayı düzenleyebilir.',
    severity: [AlertSeverity.CRITICAL, AlertSeverity.HIGH],
    levels: defaultEscalationLevels(),
    repeatIntervalMinutes: 30,
    maxRepeats: 0,
    isActive: true,
    isDefault: true,
    priority: 0,
    createdBy: DEFAULT_ESCALATION_POLICY_CREATOR,
  };
}

export type DefaultEscalationPolicyOutcome = 'created' | 'present';

/**
 * Ensure the tenant has a default escalation policy. Idempotent and race-safe.
 *
 * INVARIANT: at most one default per tenant, held by the partial unique index
 * `uq_escalation_policies_tenant_default`. The insert is ON CONFLICT DO NOTHING
 * against it, so the provisioning event, the periodic reconcile and the
 * point-of-use ensure can run concurrently: exactly one inserts, the rest see
 * `present`. A tenant that already chose its own default keeps it untouched.
 *
 * `manager` must already be bound to the tenant (search_path + RLS GUC): a
 * tenant transaction, a verified fan-out connection, or a request-scoped
 * repository manager. The function never chooses a schema itself.
 */
export async function ensureDefaultEscalationPolicy(
  manager: EntityManager,
  tenantId: string,
): Promise<DefaultEscalationPolicyOutcome> {
  const result = await manager
    .createQueryBuilder()
    .insert()
    .into(EscalationPolicy)
    .values(defaultEscalationPolicyRow(tenantId))
    .orIgnore()
    .returning(['id'])
    .execute();

  const inserted: unknown = result.raw;
  return Array.isArray(inserted) && inserted.length > 0 ? 'created' : 'present';
}
