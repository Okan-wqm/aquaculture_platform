import { AlertSeverity } from '../database/entities/alert-rule.entity';
import {
  EscalationActionType,
  EscalationLevel,
  EscalationPolicy,
  EscalationRecipientRole,
  EscalationRecipientScope,
  NotificationChannel,
} from '../database/entities/escalation-policy.entity';
import { isLifeSafetySeverity } from './policy-coverage';

/**
 * A sensor rule's own PERSON recipients (decision 7): the user ids the rule
 * names and the channels it asks for. Raw addresses (e-mail, SMS, webhook,
 * Slack) never come here — they are the rule's external targets, delivered
 * from `AlertTriggered` by notification-service.
 */
export interface DirectTargets {
  userIds: readonly string[];
  channels: readonly NotificationChannel[];
}

/** Where the level-1 recipients came from. */
export type FirstLevelOrigin = 'policy' | 'hard-floor' | 'direct';

export interface FirstLevelPlan {
  /** The level actually executed (policy level 1 merged with direct targets). */
  level: EscalationLevel;
  origin: FirstLevelOrigin;
  /** The matched policy, when one drives the ladder (timers for later levels). */
  policy: EscalationPolicy | null;
}

/**
 * The HARD FLOOR (V-S1a-2c, V-S1b-2): every active TENANT_ADMIN, by push and
 * e-mail. Used when a CRITICAL/HIGH incident matches no policy at all — the
 * coverage invariant makes that impossible for a correctly written policy set,
 * so reaching the floor is itself an alertable event.
 */
export function hardFloorLevel(): EscalationLevel {
  return {
    level: 1,
    name: 'Hard floor — tenant admins',
    timeoutMinutes: 0,
    notifyUserIds: [],
    notifyRoles: [
      { role: EscalationRecipientRole.TENANT_ADMIN, scope: EscalationRecipientScope.TENANT },
    ],
    channels: [NotificationChannel.PUSH, NotificationChannel.EMAIL],
    action: EscalationActionType.NOTIFY,
  };
}

function withDirect(level: EscalationLevel, direct: DirectTargets | undefined): EscalationLevel {
  if (!direct) return level;
  return {
    ...level,
    notifyUserIds: Array.from(new Set([...level.notifyUserIds, ...direct.userIds])),
    channels: Array.from(new Set([...level.channels, ...direct.channels])),
  };
}

/**
 * Decide who level 1 pages (decisions 3 and 7).
 *
 *   - a matched, unsuppressed policy → its level 1 ∪ the rule's own people;
 *   - no policy (or a suppressed one) for CRITICAL/HIGH → the hard floor ∪ the
 *     rule's own people (a suppressed HIGH was already refused by
 *     `EscalationPolicy.suppresses` unless an admin's window allows it — see
 *     `suppressed`);
 *   - otherwise, the rule's own people alone, when it names any;
 *   - otherwise nobody (null): a low-severity incident no policy covers.
 *
 * `suppressed` means the matched policy's window silences this severity: the
 * policy's recipients are dropped, the rule's own people are still paged (a
 * policy window governs the policy, not a rule author's direct subscription).
 */
export function planFirstLevel(input: {
  severity: AlertSeverity;
  policy: EscalationPolicy | null;
  suppressed: boolean;
  direct?: DirectTargets;
}): FirstLevelPlan | null {
  const { severity, policy, suppressed, direct } = input;
  const policyLevel = policy?.getLevel(1);

  if (policy && policyLevel && !suppressed) {
    return { level: withDirect(policyLevel, direct), origin: 'policy', policy };
  }
  if (!policy && isLifeSafetySeverity(severity)) {
    return { level: withDirect(hardFloorLevel(), direct), origin: 'hard-floor', policy: null };
  }
  if (direct && direct.userIds.length > 0) {
    return {
      level: {
        level: 1,
        name: 'Rule recipients',
        timeoutMinutes: 0,
        notifyUserIds: [...direct.userIds],
        notifyRoles: [],
        channels: [...direct.channels],
        action: EscalationActionType.NOTIFY,
      },
      origin: 'direct',
      policy: null,
    };
  }
  return null;
}
