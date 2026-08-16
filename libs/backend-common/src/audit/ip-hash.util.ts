import { createHash } from 'node:crypto';

import { Logger } from '@nestjs/common';

/**
 * Region-gated IP hashing for audit row PII (AUDITTRAIL-LOW-002).
 *
 * # Why this exists
 *
 * The audit-trail-completeness-auditor agent's invariant on
 * `shared.audit_logs.ip` is:
 *
 *     "IP addresses: hash for EU subjects (GDPR); store plaintext
 *      otherwise (region-gated via tenant config)."
 *
 * GDPR Art 6 / Art 32 treat IP as personal data. Storing it
 * plaintext on EU-subject audit rows is a data-protection-by-default
 * violation. Storing it plaintext on non-EU subjects is fine and
 * preferred — operators need plaintext for incident response /
 * range-containment queries (`<<` operator on inet) that hashing
 * destroys.
 *
 * # Architectural shape
 *
 * Two pure functions:
 *
 *   - `hashIpForGdpr(ip)` — produces the canonical EU-subject
 *     audit-IP token. Hex SHA-256 over `${salt}:${ip}` so:
 *       * the value is reversible only with the salt (kept in
 *         env / secret store, never in the audit row);
 *       * rainbow tables over the IPv4 32-bit / IPv6 128-bit
 *         spaces cannot brute-force the cleartext IP without
 *         the salt;
 *       * the same IP under the same salt always produces the
 *         same hash, so operator-side "find all rows from this
 *         IP" still works *if the operator knows the salt*.
 *     The salt comes from `process.env.AUDIT_IP_HASH_SALT` and
 *     defaults to a build-time placeholder when missing — the
 *     placeholder ensures the function never crashes (audit
 *     emission must not block on a missing env var) but ALSO
 *     emits a one-time warning so deployments running without
 *     a real salt are loud, not silent.
 *
 *   - `shouldHashIp(tenantRegion)` — region predicate. Returns
 *     true for the closed set of EU-residency markers; false
 *     otherwise. Centralizing the predicate here means a future
 *     residency expansion (UK GDPR carve-out, Brazil LGPD, etc.)
 *     adds one entry to the EU_REGIONS Set rather than touching
 *     every audit interceptor.
 *
 * # Why two functions, not one
 *
 * The hashing path is pure (input → output). The decision path
 * is policy. Splitting them:
 *
 *   - lets the `hashIpForGdpr` function be unit-tested without
 *     stubbing region lookups;
 *   - lets the policy be applied at multiple layers (audit
 *     interceptor, structured logger, error reporter) without
 *     each layer reimplementing the EU/non-EU predicate.
 *
 * # Tier classification
 *
 * Tier-1 "make it impossible" — the helper is the single
 * source of truth for audit-IP hashing across the platform. Any
 * future "I'll just hash inline here" code path that bypasses
 * it would be visible in code review and trip the
 * `tests/invariants/audit-ip-hashing-canonical.spec.ts`
 * (added alongside) which forbids inline `createHash('sha256')`
 * over an `ip` field outside this util.
 */

/**
 * Closed set of region markers that map to EU GDPR jurisdiction.
 *
 * The strings are lowercased so callers can pass JWT claims, OPA
 * decision attributes, or tenant-config column values without
 * prior normalisation. Membership is constant-time via Set.has().
 *
 * # Why these specific entries
 *
 *   - 'eu' / 'eea' — generic EU + European Economic Area marker
 *     for tenants that don't pin a country.
 *   - The 27 EU member-state ISO 3166-1 alpha-2 codes — the
 *     authoritative residency signal when tenants pin a country.
 *
 * Future expansions (UK GDPR retained-law, Switzerland nDPA,
 * Brazil LGPD, etc.) ARE policy decisions and should land via
 * a deliberate ADR + invariant update — not a silent set
 * extension that would change every audit row's shape mid-
 * deployment.
 */
const EU_REGIONS: ReadonlySet<string> = new Set([
  'eu',
  'eea',
  // EU-27 ISO 3166-1 alpha-2:
  'at',
  'be',
  'bg',
  'cy',
  'cz',
  'de',
  'dk',
  'ee',
  'es',
  'fi',
  'fr',
  'gr',
  'hr',
  'hu',
  'ie',
  'it',
  'lt',
  'lu',
  'lv',
  'mt',
  'nl',
  'pl',
  'pt',
  'ro',
  'se',
  'si',
  'sk',
]);

/**
 * Build-time placeholder salt. Used iff `AUDIT_IP_HASH_SALT` is
 * absent so the function never throws on a missing env var
 * (audit emission must not block on missing config — that would
 * convert a config gap into a 5xx for every authenticated
 * request once the new fail-closed audit interceptors land).
 *
 * The placeholder is intentionally NOT the empty string so that
 * a deployment running without the env var still produces a
 * non-trivially-distinguishable hash output.
 *
 * Note: a future deployment-time check (env-var presence
 * invariant) should fail fast on missing AUDIT_IP_HASH_SALT
 * in production. Tracked as a follow-up to this finding.
 */
const PLACEHOLDER_SALT = 'AUDIT_IP_HASH_SALT_NOT_SET_DEPLOYMENT_PLACEHOLDER_DO_NOT_USE_IN_PROD';

let warnedAboutMissingSalt = false;
const logger = new Logger('AuditIpHash');

function resolveSalt(): string {
  const fromEnv = process.env['AUDIT_IP_HASH_SALT'];
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  if (!warnedAboutMissingSalt) {
    warnedAboutMissingSalt = true;
    // A deliberate one-time structured warning keeps every runtime (including
    // CLI consumers) on the same observable logging surface without flooding
    // logs on every audit emission.
    logger.warn(
      '[audit-ip-hash] AUDIT_IP_HASH_SALT env var not set; ' +
        'using deployment placeholder. EU-subject audit-IP ' +
        'hashing is still active, but the placeholder is ' +
        'shared across deployments — set a unique salt in ' +
        'production to prevent cross-deployment hash linkage.',
    );
  }
  return PLACEHOLDER_SALT;
}

/**
 * Hex SHA-256 of `${salt}:${ip}`. Pure function; safe to call
 * from any context.
 *
 * Returns null when `ip` itself is null/empty so callers can
 * write `audit.ip = ip ? hashIpForGdpr(ip) : null` without
 * sentinel handling.
 */
export function hashIpForGdpr(ip: string | null | undefined): string | null {
  if (!ip) {
    return null;
  }
  const salt = resolveSalt();
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex');
}

/**
 * Region-gated decision: should this row's IP be hashed?
 *
 * # Inputs
 *
 *   - `tenantRegion` — typically read from a JWT claim, an OPA
 *     decision attribute, or a tenant-config column. Pass `null`
 *     or `undefined` for "unknown region."
 *   - `policy` — deployment-resolved knobs:
 *       * `forceHashAllIps` (env: `AUDIT_FORCE_IP_HASH`) — escape
 *         hatch for EU-only deployments that want every audit
 *         row hashed unconditionally.
 *       * `hashUnknownRegions` (env: `AUDIT_HASH_UNKNOWN_REGIONS`)
 *         — conservative-default opt-in for deployments where
 *         residency claims may be missing on some rows; treat
 *         missing as EU. Operators with strict residency claim
 *         coverage leave this off so the audit row gets
 *         plaintext IPs (preserved range-query semantics) when
 *         residency is genuinely non-EU.
 *
 * # Decision matrix
 *
 *   forceHashAllIps=true                                → true
 *   tenantRegion ∈ EU_REGIONS                            → true
 *   tenantRegion ∉ EU_REGIONS                            → false
 *   tenantRegion null AND hashUnknownRegions=true        → true (conservative)
 *   tenantRegion null AND hashUnknownRegions=false       → false (legacy default)
 *
 * # Why two opt-ins instead of one
 *
 * Splitting the "force-hash everything" knob from the
 * "conservative-on-unknown" knob lets each deployment pick the
 * tier that matches its residency-claim coverage:
 *
 *   - GDPR-strict, EU-only deployment: forceHashAllIps=true.
 *     Simplest config; no need to claim residency on every
 *     login.
 *   - Mixed deployment with reliable residency claims:
 *     forceHashAllIps=false, hashUnknownRegions=false. Trust
 *     the per-tenant claim; non-EU rows stay plaintext.
 *   - Mixed deployment with patchy residency claim coverage:
 *     hashUnknownRegions=true. Plaintext only when the claim
 *     definitely indicates non-EU — missing-claim cases get
 *     hashed.
 *
 * Folding both into a single boolean would force operators
 * with patchy claims into the all-hash mode, losing range-
 * query value for the rows that genuinely could be plaintext.
 */
export interface IpHashingPolicy {
  forceHashAllIps?: boolean;
  hashUnknownRegions?: boolean;
}

export function shouldHashIp(
  tenantRegion: string | null | undefined,
  policy: IpHashingPolicy = {},
): boolean {
  if (policy.forceHashAllIps === true) {
    return true;
  }
  if (tenantRegion === null || tenantRegion === undefined) {
    return policy.hashUnknownRegions === true;
  }
  return EU_REGIONS.has(tenantRegion.toLowerCase());
}

/**
 * Convenience: read the deployment-resolved IP-hashing policy
 * from the environment. Defined here so callers don't sprinkle
 * env-var-literal comparisons across the codebase (which would
 * invite typo drift between `'true'` / `true` / `'1'`).
 */
export function readIpHashingPolicyFromEnv(): IpHashingPolicy {
  return {
    forceHashAllIps: parseEnvBool(process.env['AUDIT_FORCE_IP_HASH']),
    hashUnknownRegions: parseEnvBool(process.env['AUDIT_HASH_UNKNOWN_REGIONS']),
  };
}

function parseEnvBool(raw: string | undefined): boolean {
  return raw === 'true' || raw === '1';
}

/**
 * @deprecated Use `readIpHashingPolicyFromEnv()` instead. Kept
 * temporarily for any caller that landed against the prior
 * single-flag shape; new callers MUST use the policy object.
 */
export function isForceHashAllIpsEnabled(): boolean {
  return parseEnvBool(process.env['AUDIT_FORCE_IP_HASH']);
}
