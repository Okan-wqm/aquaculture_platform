import { createHash } from 'crypto';

import { NotificationChannel } from '../entities/notification-log.entity';

/** A sensor rule's external (non-person) target paired with the channel that reaches it. */
export interface ExternalDelivery {
  channel: NotificationChannel.EMAIL | NotificationChannel.SMS | NotificationChannel.WEBHOOK;
  address: string;
}

export interface ExternalTargetSplit {
  deliveries: ExternalDelivery[];
  /** Recipients that are user ids — paged by the incident's escalation, never here. */
  userIds: number;
  /** Recipients that are no address this service can reach, or whose channel the rule lacks. */
  unreachable: number;
}

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9]{7,15}$/;
const WEBHOOK = /^https?:\/\//i;

type ExternalChannel = ExternalDelivery['channel'];

function channelOf(address: string): ExternalChannel | null {
  if (EMAIL.test(address)) return NotificationChannel.EMAIL;
  if (PHONE.test(address)) return NotificationChannel.SMS;
  if (WEBHOOK.test(address)) return NotificationChannel.WEBHOOK;
  return null;
}

/**
 * Split an AlertTriggered rule's recipients (decision 7).
 *
 * People are paged by the incident's escalation — a user id is NEVER delivered
 * from here, so nobody is reached through both paths. Every other recipient is
 * an external address, delivered over the ONE channel its form names (an e-mail
 * address by e-mail, a phone number by SMS, a URL by webhook) and only when the
 * rule lists that channel — an SMS is never sent to an e-mail address.
 */
export function splitExternalTargets(
  recipients: readonly string[],
  ruleChannels: readonly string[],
): ExternalTargetSplit {
  const enabled = new Set(ruleChannels.map((channel) => channel.toLowerCase()));
  const deliveries: ExternalDelivery[] = [];
  const seen = new Set<string>();
  let userIds = 0;
  let unreachable = 0;
  for (const raw of recipients) {
    const address = raw.trim();
    if (USER_ID.test(address)) {
      userIds++;
      continue;
    }
    const channel = channelOf(address);
    if (channel === null || !enabled.has(channel)) {
      unreachable++;
      continue;
    }
    const key = `${channel}:${address.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deliveries.push({ channel, address });
  }
  return { deliveries, userIds, unreachable };
}

/**
 * The delivery key of one external target of one incident (decision 7):
 * `alert-triggered:{incidentId}:{channel}:{hash(address)}`. Keyed by the
 * INCIDENT, so a later trigger that only bumps the open incident — or a
 * redelivery — finds the receipt and sends nothing new. The address is hashed:
 * the key is stored, and a webhook URL can carry a secret.
 */
export function externalDeliveryKey(incidentId: string, delivery: ExternalDelivery): string {
  const digest = createHash('sha256').update(delivery.address.toLowerCase()).digest('hex');
  return `alert-triggered:${incidentId}:${delivery.channel}:${digest.slice(0, 32)}`;
}

/**
 * The receipt payload hash of an external delivery — derived from the delivery
 * KEY alone (a `char(64)` sha256), not from the rendered message: a later
 * trigger of the same incident carries a new message and must REPLAY the
 * receipt, never conflict with it on a payload-hash mismatch.
 */
export function externalDeliveryPayloadHash(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
