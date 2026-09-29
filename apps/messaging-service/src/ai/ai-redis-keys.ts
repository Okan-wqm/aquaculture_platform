import { tenantScopedKey } from '@aquaculture/backend-common/redis';

/**
 * messaging-service AI Redis key builders — the ONLY place the AI bridge,
 * trigger, privacy and capability code spells a Redis key (K10 layer 5 /
 * MT-HIGH-062; tests/invariants/ai-tenant-boundary.spec.ts calls every
 * builder here with two tenants and proves the tenant is the first variable
 * segment).
 *
 * Shapes are unchanged from before K10 except the channel in-flight lock,
 * which carried no tenant (`msg:ai-inflight:{channelId}`) and now does. That
 * lock is a short-TTL marker, so a deploy leaves at most one stale pre-K10
 * marker per channel to expire on its own.
 */

/** At-most-once claim for one MessageSent trigger. */
export function aiTriggerClaimKey(tenantId: string, messageId: string): string {
  return tenantScopedKey('msg:ai-trigger', tenantId, messageId);
}

/** One AI reply in flight per channel. */
export function aiChannelInflightKey(tenantId: string, channelId: string): string {
  return tenantScopedKey('msg:ai-inflight', tenantId, channelId);
}

/** Per-channel daily AI reply counter. */
export function aiChannelDailyKey(tenantId: string, channelId: string, dayKey: string): string {
  return tenantScopedKey('msg:ai-daily', tenantId, channelId, dayKey);
}

/** Throttle for the AI system notice posted into a channel. */
export function aiNoticeThrottleKey(tenantId: string, channelId: string): string {
  return tenantScopedKey('msg:ai-notice', tenantId, channelId);
}

/** Cached tenant AI enablement (request.ai.isEnabled). */
export function aiTenantEnablementKey(tenantId: string): string {
  return tenantScopedKey('ai:tenant', tenantId);
}

/** Cached per-user AI consent. */
export function aiUserConsentKey(tenantId: string, userId: string): string {
  return tenantScopedKey('ai:user:consent', tenantId, userId);
}

/** Cached caller capabilities (request.auth.user.resolveCallerCapabilities). */
export function aiCallerCapabilitiesKey(tenantId: string, userId: string): string {
  return tenantScopedKey('ai:caller-caps', tenantId, userId);
}
