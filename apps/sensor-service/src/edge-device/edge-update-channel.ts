import channelsContract from '../../../../contracts/suderra-edge/v1/channels.json';

import { STATEMENT } from './edge-contract';
import type { EdgeResult } from './edge-result-document';

/**
 * The update channel's rules, read from the contract (ADR-048 DEC-2, DEC-4.12;
 * `channels.json` `update_channel`): the bounds a producer holds to, the result
 * kind that concludes each carried statement, and how a result settles a request.
 * Nothing here is a copy: the numbers and the reason classes come from the
 * contract file, and `fixtures/update-channel/settlement-vectors.json` — the
 * contract's own settlement cases — is run against {@link settleVerdict} by
 * `edge-update-channel.spec.ts`, so the cloud and the agent read one result the
 * same way.
 */

const channel = channelsContract.update_channel;
const settlement = channel.settlement;

export const UPDATE_CHANNEL = {
  /** A statement with a window is delivered only with at least this much of it left. */
  deliveryMarginSeconds: settlement.delivery_window.delivery_margin_seconds,
  /** The longest window: the agent prunes a spool entry older than this. */
  maxWindowSeconds: channel.spool.max_entry_age_seconds,
  /** The spool holds at most this many unconcluded requests; the agent refuses a fifth. */
  maxPendingEntries: channel.spool.max_pending_entries,
  /** The most a hand-over command may carry (the DSSE envelope as one string). */
  maxStatementBytes: channelsContract.handoff.statement_param.max_bytes,
  /** A re-issue is a new statement at the earliest this long after the refusal. */
  reissueMinIntervalSeconds: settlement.reissue.min_interval_seconds,
  /** The cloud stops re-issuing an intent this long after its first statement. */
  campaignMaxSeconds: settlement.reissue.campaign_max_seconds,
  maxSiteBundleBytes: channel.fetch.max_site_bundle_bytes,
} as const;

/** A statement type the update channel carries to root. */
export type CarriedStatementType =
  | typeof STATEMENT.edgeUpdate
  | typeof STATEMENT.osUpdate
  | typeof STATEMENT.siteConfig
  | typeof STATEMENT.siteNetpolicy
  | typeof STATEMENT.trustAnchors;

const CARRIED_TYPES: readonly CarriedStatementType[] = [
  STATEMENT.edgeUpdate,
  STATEMENT.osUpdate,
  STATEMENT.siteConfig,
  STATEMENT.siteNetpolicy,
  STATEMENT.trustAnchors,
];

export function isCarriedStatementType(value: string): value is CarriedStatementType {
  return CARRIED_TYPES.some((type) => type === value);
}

const carried: Readonly<Record<string, { readonly result_kind: string }>> =
  channel.carried_statements;

/** The result kind that concludes a request carrying `type` (`result_kind`). */
export function resultKindOf(type: CarriedStatementType): string {
  const entry = carried[type];
  if (entry === undefined) throw new Error(`channels.json carries no ${type}`);
  return entry.result_kind;
}

/** The statement types the hand-over command `request_update` accepts. */
export const REQUEST_UPDATE_TYPES: readonly CarriedStatementType[] = [
  ...channelsContract.handoff.commands.request_update.statement_types,
].map((type) => {
  if (!isCarriedStatementType(type)) throw new Error(`request_update carries unknown ${type}`);
  return type;
});

// ------------------------------------------------------------------ settlement

/** How a refusal ends a request (channels.json update_channel.settlement.reason_classes). */
export type ReasonClass = 'retryable' | 'reschedule' | 'final';

const CLASS_OF = new Map<string, ReasonClass>();
for (const reason of settlement.reason_classes.retryable) CLASS_OF.set(reason, 'retryable');
for (const reason of settlement.reason_classes.reschedule) CLASS_OF.set(reason, 'reschedule');
for (const reason of settlement.reason_classes.final) CLASS_OF.set(reason, 'final');

/**
 * The class of a refusal reason. A reason the contract's lists do not name is
 * `final`: the cloud never re-issues what it cannot classify, it alerts.
 */
export function reasonClassOf(reason: string): ReasonClass {
  return CLASS_OF.get(reason) ?? 'final';
}

/** What the cloud does about a request, judged from the results a device reported. */
export type SettleVerdict = 'done' | 'reissue' | 'reschedule' | 'final' | 'wait' | 'lapsed';

/** The statement a request carries, as far as settlement reads it. */
export interface SettleSubject {
  readonly resultKind: string;
  readonly digestSha256: string;
  /** Null for a statement with no window of its own (trust-anchors). */
  readonly expiresAt: Date | null;
}

type SettlingResult = Pick<EdgeResult, 'seq' | 'kind' | 'outcome' | 'reason' | 'subject'>;

/**
 * The result that settles a request: of the request's result kind, naming its
 * statement digest. Nothing else settles one — not the hand-over response, not
 * the agent pruning the spool entry, not silence. Root concludes an entry with
 * exactly one result, so the lowest seq is the conclusion if a device ever
 * reports two.
 */
export function settlingResult(
  subject: SettleSubject,
  results: readonly SettlingResult[],
): SettlingResult | null {
  const matching = results
    .filter(
      (result) =>
        result.kind === subject.resultKind &&
        result.subject?.statement_digest?.sha256 === subject.digestSha256,
    )
    .sort((a, b) => a.seq - b.seq);
  return matching[0] ?? null;
}

/**
 * How a request stands (channels.json update_channel.settlement): `done` when an
 * ok result concludes it; `reissue` (retryable), `reschedule` or `final` when a
 * refusal of that class does; `lapsed` when nothing concluded it by `expires_at`;
 * otherwise `wait`, and the cloud keeps delivering inside the window.
 */
export function settleVerdict(
  subject: SettleSubject,
  results: readonly SettlingResult[],
  now: Date,
): SettleVerdict {
  const result = settlingResult(subject, results);
  if (result !== null) {
    if (result.outcome === 'ok') return 'done';
    const refusal = reasonClassOf(result.reason ?? '');
    return refusal === 'retryable' ? 'reissue' : refusal;
  }
  return subject.expiresAt !== null && now.getTime() >= subject.expiresAt.getTime()
    ? 'lapsed'
    : 'wait';
}

/** Whether the cloud may issue a retryable request's intent again now. */
export type ReissueDecision = 'allowed' | 'too-early' | 'campaign-over';

/**
 * A re-issue is a new statement at the earliest `reissueMinIntervalSeconds` after
 * the refusal, and never later than `campaignMaxSeconds` after the first statement
 * of the intent (channels.json update_channel.settlement.reissue).
 */
export function reissueDecision(
  campaignStartedAt: Date,
  refusedAt: Date,
  now: Date,
): ReissueDecision {
  if (now.getTime() >= campaignStartedAt.getTime() + UPDATE_CHANNEL.campaignMaxSeconds * 1000) {
    return 'campaign-over';
  }
  return now.getTime() >= refusedAt.getTime() + UPDATE_CHANNEL.reissueMinIntervalSeconds * 1000
    ? 'allowed'
    : 'too-early';
}

/** Whether a statement with this window may be delivered at `now` (settlement.delivery_window). */
export function inDeliveryWindow(notBefore: Date, expiresAt: Date, now: Date): boolean {
  return (
    notBefore.getTime() <= now.getTime() &&
    now.getTime() < expiresAt.getTime() - UPDATE_CHANNEL.deliveryMarginSeconds * 1000
  );
}
