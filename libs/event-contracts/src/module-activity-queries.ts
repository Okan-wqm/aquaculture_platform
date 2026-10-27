/**
 * Count-only readiness queries: how many of the members auth names wrote to a module recently
 * (PKG-06 "Readiness"; ADR-051 §3 "NATS requests" and Plan amendments).
 *
 * WHY: before any service decides by module grants (R4), the operator has to know how many
 * members would lose a module they work in. Only the module's owner knows who wrote to it, and
 * only auth knows who holds which grant. So auth names the members without a grant, and the
 * owner answers how many of them wrote — a count, never a list (ADR-051 §3: a service subject
 * answers only about ids the sender's own rows reference, and no member stands behind it).
 *
 * WHAT:
 *   - MODULE_ACTIVITY_QUERY_SUBJECTS: one subject per active owner module (hydroponics is
 *     reserved and has no writers, D3), each answered by that module.
 *   - MODULE_ACTIVITY_QUERY_ACCESS: each subject's entry — a read-only service subject that only
 *     auth_service sends — in the shape REQUEST_ACCESS (PKG-09) takes, so that table absorbs
 *     these entries as they stand and SERVICE_GRANTS derives from them.
 *   - The request carries the sender's ServiceCaller from the subject's first release (C5: no
 *     older caller exists, so the field is required from birth), the tenant, at most 500 user
 *     ids and a window of 1..90 days. The guards read exact keys.
 *   - admitRecentWriterIdsRequest: the responder's chokepoint — decode, then decideAccess against
 *     the subject's entry, before any read.
 *   - The reply is the AiQueryReply envelope (`{ ok, data }` / `{ ok: false, error }`) with
 *     FORBIDDEN for a caller that is no declared sender (ADR-051 §3). PKG-09 PR1 adds FORBIDDEN
 *     to the shared envelope; until then this subject's error union names it itself.
 */
import {
  NATS_SERVICE_NAMES,
  decideAccess,
  serviceCaller,
  type ActiveOwnerModuleCode,
  type ServiceCaller,
  type ServiceSubjectAccess,
} from '@aquaculture/shared-contracts';

import { isBoundedInt, isRecord, isUuidString, type AiQueryErrorCode } from './farm-ai-queries';

export const MODULE_ACTIVITY_QUERY_SUBJECTS = Object.freeze({
  farm: 'request.farm.recentWriterIds',
  hr: 'request.hr.recentWriterIds',
  sensor: 'request.sensor.recentWriterIds',
} as const satisfies {
  readonly [Code in ActiveOwnerModuleCode]: `request.${Code}.recentWriterIds`;
});

export type ModuleActivitySubject =
  (typeof MODULE_ACTIVITY_QUERY_SUBJECTS)[keyof typeof MODULE_ACTIVITY_QUERY_SUBJECTS];

export const RECENT_WRITER_QUERY_LIMITS = Object.freeze({
  /** The most user ids one request may name; the sender splits a larger set. */
  MAX_USER_IDS: 500,
  /** The longest window, in days (the plan's readiness window). */
  MAX_WINDOW_DAYS: 90,
} as const);

const AUTH_SERVICE_ONLY: ServiceSubjectAccess = Object.freeze({
  caller: 'service',
  intent: 'read',
  senders: Object.freeze(['auth_service'] as const),
});

/** Each subject's access entry (ADR-051 §3): read-only, auth_service only. */
export const MODULE_ACTIVITY_QUERY_ACCESS: {
  readonly [Subject in ModuleActivitySubject]: ServiceSubjectAccess;
} = Object.freeze({
  [MODULE_ACTIVITY_QUERY_SUBJECTS.farm]: AUTH_SERVICE_ONLY,
  [MODULE_ACTIVITY_QUERY_SUBJECTS.hr]: AUTH_SERVICE_ONLY,
  [MODULE_ACTIVITY_QUERY_SUBJECTS.sensor]: AUTH_SERVICE_ONLY,
});

export interface RecentWriterIdsRequest {
  /** The sending service, in its own name; the broker's ACL binds it (ADR-015). */
  readonly caller: ServiceCaller;
  readonly tenantId: string;
  /** The members asked about: 1..500 distinct ids. */
  readonly userIds: readonly string[];
  /** Writes within this many days count: 1..90. */
  readonly windowDays: number;
}

export interface RecentWriterIdsData {
  /** How many of the asked ids wrote to the module within the window. */
  readonly recentWriterCount: number;
}

export type ModuleActivityErrorCode = AiQueryErrorCode | 'FORBIDDEN';

export type RecentWriterIdsReply =
  | { readonly ok: true; readonly data: RecentWriterIdsData }
  | { readonly ok: false; readonly error: ModuleActivityErrorCode };

const MODULE_ACTIVITY_ERROR_CODES: readonly ModuleActivityErrorCode[] = Object.freeze([
  'INVALID_REQUEST',
  'FORBIDDEN',
  'INTERNAL_ERROR',
]);

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => present.includes(key));
}

function isServiceCaller(value: unknown): value is ServiceCaller {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['kind', 'service']) &&
    value['kind'] === 'service' &&
    NATS_SERVICE_NAMES.some((name) => name === value['service'])
  );
}

function isUserIdList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= RECENT_WRITER_QUERY_LIMITS.MAX_USER_IDS &&
    value.every(isUuidString) &&
    new Set(value).size === value.length
  );
}

/** Runtime trust-boundary validation of the request, exact keys. */
export function isRecentWriterIdsRequest(value: unknown): value is RecentWriterIdsRequest {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['caller', 'tenantId', 'userIds', 'windowDays']) &&
    isServiceCaller(value['caller']) &&
    isUuidString(value['tenantId']) &&
    isUserIdList(value['userIds']) &&
    isBoundedInt(value['windowDays'], 1, RECENT_WRITER_QUERY_LIMITS.MAX_WINDOW_DAYS)
  );
}

/** Runtime trust-boundary validation of the reply, exact keys. */
export function isRecentWriterIdsReply(value: unknown): value is RecentWriterIdsReply {
  if (!isRecord(value)) return false;
  if (value['ok'] === true) {
    const data = value['data'];
    return (
      hasExactKeys(value, ['ok', 'data']) &&
      isRecord(data) &&
      hasExactKeys(data, ['recentWriterCount']) &&
      isBoundedInt(data['recentWriterCount'], 0, RECENT_WRITER_QUERY_LIMITS.MAX_USER_IDS)
    );
  }
  return (
    value['ok'] === false &&
    hasExactKeys(value, ['ok', 'error']) &&
    MODULE_ACTIVITY_ERROR_CODES.some((code) => code === value['error'])
  );
}

/** The request auth_service sends, in its own name. */
export function recentWriterIdsRequest(
  tenantId: string,
  userIds: readonly string[],
  windowDays: number,
): RecentWriterIdsRequest {
  return { caller: serviceCaller('auth_service'), tenantId, userIds: [...userIds], windowDays };
}

export type RecentWriterIdsAdmission =
  | { readonly admitted: true; readonly request: RecentWriterIdsRequest }
  | { readonly admitted: false; readonly reply: RecentWriterIdsReply };

/**
 * The responder's chokepoint: a request that does not match the contract is INVALID_REQUEST; a
 * caller the subject's entry does not admit is FORBIDDEN. Only an admitted request is read.
 */
export function admitRecentWriterIdsRequest(
  module: ActiveOwnerModuleCode,
  value: unknown,
): RecentWriterIdsAdmission {
  if (!isRecentWriterIdsRequest(value)) {
    return { admitted: false, reply: { ok: false, error: 'INVALID_REQUEST' } };
  }
  const entry = MODULE_ACTIVITY_QUERY_ACCESS[MODULE_ACTIVITY_QUERY_SUBJECTS[module]];
  const decision = decideAccess(value.caller, {
    spec: { kind: 'service', entry },
    intent: 'read',
  });
  if (!decision.allowed) {
    return { admitted: false, reply: { ok: false, error: 'FORBIDDEN' } };
  }
  return { admitted: true, request: value };
}
