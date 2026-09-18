/**
 * Platform-admin MFA policy — one switch, read by everyone (ADR-0011,
 * SEC-CRITICAL-058).
 *
 * The mechanism ships now; the enforcement date is the operator's decision.
 * `SUPER_ADMIN_MFA_ENFORCED_AT` is:
 *
 *   - `detective`            — enforcement OFF. auth-service still mints a
 *                              SUPER_ADMIN token for an un-enrolled account and
 *                              DestructiveActionGuard still lets a stale or
 *                              absent MFA claim through, but both emit a
 *                              security event naming the account, so the
 *                              operator can see exactly who would be locked out
 *                              on the day the date is set.
 *   - an ISO-8601 date-time  — enforcement ON from that instant: no SUPER_ADMIN
 *                              token without enrolment, no irreversible admin
 *                              operation without a fresh MFA claim.
 *
 * In production the variable MUST be set (an omission is not a decision —
 * the same posture INFRA-HIGH-142 established); elsewhere it defaults to
 * `detective` so local stacks keep working. Flipping the platform to enforced
 * is therefore a one-line compose change, and flipping it back is the same
 * line, visible in git.
 */

export const SUPER_ADMIN_MFA_ENFORCED_AT_ENV = 'SUPER_ADMIN_MFA_ENFORCED_AT';
export const MFA_FRESHNESS_SECONDS_ENV = 'MFA_FRESHNESS_SECONDS';
export const DETECTIVE_MODE = 'detective';
/** How recently an MFA claim must have been minted for an irreversible operation. */
export const DEFAULT_MFA_FRESHNESS_SECONDS = 15 * 60;

export type PlatformAdminMfaMode = 'detective' | 'scheduled' | 'enforced';

export interface PlatformAdminMfaPolicy {
  readonly mode: PlatformAdminMfaMode;
  /** The instant enforcement starts; null in detective mode. */
  readonly enforcedAt: Date | null;
  /** True once `now >= enforcedAt`. */
  readonly enforced: boolean;
}

export type PlatformAdminMfaEnv = Readonly<Record<string, string | undefined>>;

/**
 * Parse the switch. Throws on an unset value in production and on any value
 * that is neither `detective` nor a parseable ISO-8601 date-time, so a typo
 * fails the boot instead of silently disabling a compliance control.
 */
export function parsePlatformAdminMfaPolicy(
  raw: string | undefined,
  isProduction: boolean,
  now: Date = new Date(),
): PlatformAdminMfaPolicy {
  const value = raw?.trim();
  if (value === undefined || value === '') {
    if (isProduction) {
      throw new Error(
        `${SUPER_ADMIN_MFA_ENFORCED_AT_ENV} is required in production: set '${DETECTIVE_MODE}' to record un-enrolled ` +
          `platform admins without locking them out, or an ISO-8601 date-time from which SUPER_ADMIN tokens ` +
          `require MFA enrolment (ADR-0011).`,
      );
    }
    return { mode: 'detective', enforcedAt: null, enforced: false };
  }
  if (value === DETECTIVE_MODE) {
    return { mode: 'detective', enforcedAt: null, enforced: false };
  }
  const enforcedAt = new Date(value);
  if (Number.isNaN(enforcedAt.getTime())) {
    throw new Error(
      `${SUPER_ADMIN_MFA_ENFORCED_AT_ENV}=${value} is neither '${DETECTIVE_MODE}' nor an ISO-8601 date-time (ADR-0011).`,
    );
  }
  const enforced = now.getTime() >= enforcedAt.getTime();
  return { mode: enforced ? 'enforced' : 'scheduled', enforcedAt, enforced };
}

/** Read the policy from an environment (defaults to process.env) — the one call sites use. */
export function readPlatformAdminMfaPolicy(
  env: PlatformAdminMfaEnv = process.env,
  now: Date = new Date(),
): PlatformAdminMfaPolicy {
  return parsePlatformAdminMfaPolicy(
    env[SUPER_ADMIN_MFA_ENFORCED_AT_ENV],
    env['NODE_ENV'] === 'production',
    now,
  );
}

/** Freshness window for an MFA claim on an irreversible operation, in seconds. */
export function readMfaFreshnessSeconds(env: PlatformAdminMfaEnv = process.env): number {
  const raw = env[MFA_FRESHNESS_SECONDS_ENV]?.trim();
  if (raw === undefined || raw === '') return DEFAULT_MFA_FRESHNESS_SECONDS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `${MFA_FRESHNESS_SECONDS_ENV}=${raw} must be a positive integer number of seconds (ADR-0011).`,
    );
  }
  return parsed;
}

/**
 * Is an MFA claim minted at `mfaIssuedAtEpochSeconds` still fresh at `now`?
 * A missing issue time is never fresh: freshness cannot be assumed.
 */
export function isMfaClaimFresh(
  mfaVerified: boolean,
  issuedAtEpochSeconds: number | undefined,
  freshnessSeconds: number,
  now: Date = new Date(),
): boolean {
  if (!mfaVerified || issuedAtEpochSeconds === undefined) return false;
  return now.getTime() / 1000 - issuedAtEpochSeconds <= freshnessSeconds;
}
