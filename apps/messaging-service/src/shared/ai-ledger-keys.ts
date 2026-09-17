/**
 * MSGFIX-FAZ2 2.3: deterministic UUID derivation for idempotency ledger keys.
 *
 * WHY: `messages.idempotencyKey` and the `message_send_idempotency` ledger
 * PK are `uuid` columns, but the AI bridge needs a STABLE key derived from a
 * business identity ("this trigger message already produced its AI reply")
 * — not a random one. UUIDv5 (SHA-1, RFC 4122 §4.3) maps a fixed namespace +
 * name onto the same UUID every time, so:
 *
 *   - a JetStream redelivery of the same MessageSent derives the SAME ledger
 *     key → the INSERT ... ON CONFLICT DO NOTHING claim keeps the reply
 *     exactly-once;
 *   - the value satisfies the uuid column type (a plain `ai-reply:{uuid}`
 *     string would fail the insert).
 *
 * The namespace constant is arbitrary but FIXED — changing it re-keys every
 * future claim (one-time duplicate window), so treat it as immutable.
 */
import { v5 as uuidv5 } from 'uuid';

/** Stable namespace for messaging AI ledger keys (v5, random-once). */
export const AI_LEDGER_NAMESPACE = '9a2b1c0d-5e4f-4a3b-8d7c-6b5a49382710';

/** Derive the deterministic ledger UUID for an AI reply to `triggerMessageId`. */
export function aiReplyLedgerKey(triggerMessageId: string): string {
  return uuidv5(`ai-reply:${triggerMessageId}`, AI_LEDGER_NAMESPACE);
}

/** Derive the deterministic ledger UUID for an action-result follow-up. */
export function aiActionResultLedgerKey(actionMessageId: string): string {
  return uuidv5(`ai-action-result:${actionMessageId}`, AI_LEDGER_NAMESPACE);
}

/** Derive the deterministic ledger UUID for a channel system notice. */
export function aiNoticeLedgerKey(channelId: string, noticeId: string): string {
  return uuidv5(`ai-notice:${channelId}:${noticeId}`, AI_LEDGER_NAMESPACE);
}
