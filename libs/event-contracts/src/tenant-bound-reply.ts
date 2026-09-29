/**
 * Tenant-bound NATS request-reply envelope (K10 / PR-T1, MT-HIGH-062).
 *
 * WHY: an AI tool that asks another service for tenant data must be able to
 * prove that the answer belongs to the tenant it asked for. The earlier farm
 * AI envelope carried `{ ok, data }` only, so a reply served for the wrong
 * tenant (a responder bug, an ambient-context slip, an inbox mix-up) looked
 * exactly like a correct one and went straight into the model's context.
 *
 * WHAT: the contract half — the envelope, its structural guard, and the ONE
 * consumer check. The responder half (`respondTenantBound`) lives in
 * `@aquaculture/backend-common/nats`; it is the only producer of this shape.
 *
 * INVARIANT: a consumer that reads `data` without `verifyTenantBoundReply`
 * can hand a foreign tenant's rows to an LLM. ai-service reaches these
 * subjects only through `TenantBoundNatsClient`, which calls it on every reply
 * (tests/invariants/ai-tenant-boundary.spec.ts).
 */

/** Transport-level failure codes. Domain outcomes (e.g. "task rejected") ride in `data`. */
export const TENANT_BOUND_REPLY_ERRORS = [
  'INVALID_REQUEST',
  'NOT_FOUND',
  'INTERNAL_ERROR',
] as const;
export type TenantBoundReplyError = (typeof TENANT_BOUND_REPLY_ERRORS)[number];

/**
 * Every reply names the tenant it served.
 *
 * WHY `tenantId: string | null` on failure: a payload whose tenant is not a
 * UUID has no tenant to name. A consumer that sent a valid tenant treats a
 * null echo as a mismatch too (see verifyTenantBoundReply).
 */
export type TenantBoundReply<TData> =
  | { readonly ok: true; readonly tenantId: string; readonly data: TData }
  | {
      readonly ok: false;
      readonly tenantId: string | null;
      readonly error: TenantBoundReplyError;
    };

/** Every tenant-bound request names its tenant; the AI client sets it, never the model. */
export interface TenantBoundRequest {
  tenantId: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReplyError(value: unknown): value is TenantBoundReplyError {
  return (
    typeof value === 'string' && (TENANT_BOUND_REPLY_ERRORS as readonly string[]).includes(value)
  );
}

/** Structural guard for the envelope. It says nothing about WHICH tenant — that is verifyTenantBoundReply's job. */
export function isTenantBoundReply(value: unknown): value is TenantBoundReply<unknown> {
  if (!isPlainRecord(value) || typeof value['ok'] !== 'boolean') return false;
  if (value['ok'] === true) {
    return typeof value['tenantId'] === 'string' && 'data' in value;
  }
  const tenantId = value['tenantId'];
  return (tenantId === null || typeof tenantId === 'string') && isReplyError(value['error']);
}

/** What a consumer may do with a reply, decided before any data is read. */
export type TenantBoundReplyVerdict<TData> =
  | { readonly kind: 'data'; readonly data: TData }
  | { readonly kind: 'error'; readonly error: TenantBoundReplyError }
  | { readonly kind: 'malformed'; readonly reason: 'envelope' | 'contract' }
  | { readonly kind: 'tenant_mismatch'; readonly servedTenantId: string | null };

/**
 * The one consumer check for tenant-bound replies.
 *
 * WHY the order: envelope shape → tenant → outcome → data contract. The tenant
 * comparison runs before `ok` is read, so a foreign reply is classified as a
 * boundary violation even when it is a failure, and foreign data is never
 * handed to the contract guard (nor anywhere else).
 *
 * INVARIANT: `kind: 'data'` is returned only when the served tenant equals
 * `expectedTenantId` exactly; if violated → another tenant's rows reach the caller.
 */
export function verifyTenantBoundReply<TData>(
  reply: unknown,
  expectedTenantId: string,
  isData: (value: unknown) => value is TData,
): TenantBoundReplyVerdict<TData> {
  if (!isTenantBoundReply(reply)) {
    return { kind: 'malformed', reason: 'envelope' };
  }
  if (reply.tenantId !== expectedTenantId) {
    return { kind: 'tenant_mismatch', servedTenantId: reply.tenantId };
  }
  if (!reply.ok) {
    return { kind: 'error', error: reply.error };
  }
  if (!isData(reply.data)) {
    return { kind: 'malformed', reason: 'contract' };
  }
  return { kind: 'data', data: reply.data };
}
