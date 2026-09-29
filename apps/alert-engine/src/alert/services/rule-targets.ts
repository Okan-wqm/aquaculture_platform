import { UUID_PATTERN } from '@platform/event-contracts';

import type { AlertRule } from '../../database/entities/alert-rule.entity';
import { NotificationChannel } from '../../database/entities/escalation-policy.entity';
import type { DirectTargets } from '../../escalation/first-level-plan';

const USER_ID = new RegExp(UUID_PATTERN);

/** Rule channel codes (lower-case, as stored) that can page a PERSON by user id. */
const PERSON_CHANNELS: Readonly<Record<string, NotificationChannel>> = {
  push: NotificationChannel.PUSH,
  email: NotificationChannel.EMAIL,
};

/** True when a rule recipient is a platform user id (a person), not a raw address. */
export function isUserIdRecipient(recipient: string): boolean {
  return USER_ID.test(recipient);
}

/**
 * A sensor rule's PERSON targets for its incident's escalation level 1
 * (decision 7): the recipients that are user ids, over the rule's push/e-mail
 * channels. Raw addresses (e-mail, phone, webhook URL) are the rule's EXTERNAL
 * targets — notification-service delivers those from `AlertTriggered`, and
 * never pages a user id from it, so nobody is reached through both paths.
 *
 * A rule that names people but no person channel still pages them in-app (the
 * notification floor channel), so its user ids are never dropped here.
 */
export function directPersonTargetsOf(rule: AlertRule): DirectTargets | undefined {
  const userIds = (rule.recipients ?? []).filter(isUserIdRecipient);
  if (userIds.length === 0) return undefined;
  const channels = Array.from(
    new Set(
      (rule.notificationChannels ?? [])
        .map((code) => PERSON_CHANNELS[code.toLowerCase()])
        .filter((channel): channel is NotificationChannel => channel !== undefined),
    ),
  );
  return { userIds: Array.from(new Set(userIds)), channels };
}
