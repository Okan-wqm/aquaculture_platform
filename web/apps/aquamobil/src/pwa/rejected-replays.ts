/**
 * Offline replays the server rejected, listed for re-entry (PKG-42; ADR-051 C6).
 *
 * WHY: a write recorded offline and replayed after the worker's access changed — a revoked
 * module grant answers FORBIDDEN from R4 — or after a release changed the contract
 * (GRAPHQL_VALIDATION_FAILED, BAD_USER_INPUT) never succeeds on retry. The queue already stops
 * retrying it (graphql-replay-error.ts) and keeps it; but the Sync Status page showed it as
 * "Permanently failed — please remove", without what had been entered or why it was refused,
 * so removing it meant losing the record.
 *
 * WHAT — what the page needs to list one for re-entry:
 *   - rejectionCodeOf / isRejectedReplay: a failed operation whose last failure carries a code
 *     in PERMANENT_GRAPHQL_ERROR_CODES (every one, not only FORBIDDEN). A transport failure
 *     carries no code and is not listed: the queue retries it.
 *   - rejectedReplayReason: the reason, as a message key, per code — exhaustive by type.
 *   - recordedValues: what the worker entered, flattened to field/value pairs, without the
 *     command envelope the queue stamped on it.
 */
import type { MessageKey } from '@aquaculture/shared-ui/i18n';

import {
  isPermanentGraphQLErrorCode,
  type PermanentGraphQLErrorCode,
} from './graphql-replay-error';

import type { MobileCommandEnvelope, QueuedOperation } from '@/types';

/** The fields the queue stamps on every payload; keyed by the envelope type, so none is missed. */
const ENVELOPE_FIELDS = {
  clientCommandId: true,
  clientCreatedAt: true,
  deviceId: true,
  operationType: true,
  payloadHash: true,
  schemaVersion: true,
} as const satisfies Record<keyof MobileCommandEnvelope, true>;

const ENVELOPE_FIELD_NAMES: ReadonlySet<string> = new Set(Object.keys(ENVELOPE_FIELDS));

const REASON: { readonly [C in PermanentGraphQLErrorCode]: MessageKey } = {
  FORBIDDEN: 'm.sync.rejected.reason.forbidden',
  UNAUTHENTICATED: 'm.sync.rejected.reason.unauthenticated',
  BAD_USER_INPUT: 'm.sync.rejected.reason.invalid',
  BAD_REQUEST: 'm.sync.rejected.reason.invalid',
  GRAPHQL_VALIDATION_FAILED: 'm.sync.rejected.reason.outdated',
  NOT_FOUND: 'm.sync.rejected.reason.notFound',
};

/** The permanent code the server rejected the replay with; null for anything still in play. */
export function rejectionCodeOf(
  op: Pick<QueuedOperation, 'status' | 'lastErrorCode'>,
): PermanentGraphQLErrorCode | null {
  if (op.status !== 'failed' || op.lastErrorCode === undefined) return null;
  return isPermanentGraphQLErrorCode(op.lastErrorCode) ? op.lastErrorCode : null;
}

export function isRejectedReplay(op: Pick<QueuedOperation, 'status' | 'lastErrorCode'>): boolean {
  return rejectionCodeOf(op) !== null;
}

export function rejectedReplayReason(code: PermanentGraphQLErrorCode): MessageKey {
  return REASON[code];
}

export interface RecordedValue {
  readonly field: string;
  readonly value: string;
}

function rendered(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (Array.isArray(value)) {
    const items = value.map(rendered).filter((item): item is string => item !== null);
    return items.length === 0 ? null : items.join(', ');
  }
  // An object inside a list (a nested record of a line item) keeps its JSON form.
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return null;
}

function flatten(record: object, path: string): RecordedValue[] {
  const values: RecordedValue[] = [];
  const fields: [string, unknown][] = Object.entries(record);
  for (const [field, value] of fields) {
    if (path === '' && ENVELOPE_FIELD_NAMES.has(field)) continue;
    const name = path === '' ? field : `${path}.${field}`;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      values.push(...flatten(value, name));
      continue;
    }
    const text = rendered(value);
    if (text !== null) values.push({ field: name, value: text });
  }
  return values;
}

/** What the worker entered, in the payload's own field order. */
export function recordedValues(payload: object): RecordedValue[] {
  return flatten(payload, '');
}
