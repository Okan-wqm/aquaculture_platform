/**
 * PlatformCapability — the closed set of platform-operator capabilities
 * (ADR-0016, SEC-HIGH-059).
 *
 * # Why this lives in event-contracts
 *
 * Until 2026-09-05 one bit — the SUPER_ADMIN role — governed every page,
 * controller and mutation route of the platform-admin surface, tenant erasure
 * and the SQL explorer included. A capability set narrows that bit. It is
 * minted by auth-service into the `platformCapabilities` JWT claim, read by
 * the kernel `PlatformCapabilityGuard`, granted over the
 * `request.auth.admin.*` NATS commands and rendered by the admin panel, so
 * the vocabulary must be declared once, where every side already imports
 * from. A string that is not in this list is not a capability anywhere.
 *
 * # Semantics
 *
 * - `billing-ops`    — subscription, invoice, payment and plan mutations.
 * - `support-ops`    — tickets, onboarding, announcements, operator messaging.
 * - `security-ops`   — users, tenants, security monitoring, compliance,
 *                      settings, database management, jobs; also the only
 *                      capability that may grant capabilities to others.
 * - `platform-read-only` — a SUPER_ADMIN with no mutating reach. Every
 *                      admin GET is admitted by the role alone, so this
 *                      capability is the explicit statement that a
 *                      principal is read-only; it admits no mutation.
 * - `break-glass`    — time-boxed (`expiresAt` ≤ 4 h), dual-controlled
 *                      (never self-granted), the only capability admitting
 *                      an irreversible operation, always with fresh MFA
 *                      (ADR-0011). It implies nothing else: an erasure needs
 *                      `security-ops` for the route AND `break-glass` for
 *                      the `@Destructive()` guard.
 */

export const PLATFORM_CAPABILITIES = [
  'billing-ops',
  'support-ops',
  'security-ops',
  'platform-read-only',
  'break-glass',
] as const;

export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[number];

/** The JWT claim name auth-service mints and every consumer reads. */
export const PLATFORM_CAPABILITIES_CLAIM = 'platformCapabilities';

/** `break-glass` is never open-ended: four hours is the ceiling on `expiresAt`. */
export const BREAK_GLASS_MAX_TTL_SECONDS = 4 * 60 * 60;

/** Capabilities that exist to be granted for ordinary operation; `break-glass` is minted per incident. */
export const STANDING_PLATFORM_CAPABILITIES: readonly PlatformCapability[] = [
  'billing-ops',
  'support-ops',
  'security-ops',
];

export function isPlatformCapability(value: unknown): value is PlatformCapability {
  return typeof value === 'string' && (PLATFORM_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Narrow an untyped claim (a decoded JWT array, a NATS payload) to the closed
 * set. Unknown strings are dropped, never widened: a forged or stale value
 * cannot become a capability by being present.
 */
export function toPlatformCapabilities(value: unknown): PlatformCapability[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<PlatformCapability>();
  for (const item of value) {
    if (isPlatformCapability(item)) seen.add(item);
  }
  return [...seen];
}
