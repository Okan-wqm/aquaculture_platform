/**
 * APA-367 (tier-3) — every directly-reachable JWT auth boundary consults the
 * token-revocation infrastructure.
 *
 * ROOT CAUSE this gate closes: there was no single shared verify-and-authorize
 * primitive. Each guard independently calls
 * `getJwtVerifyOptions()` + `verifyAsync()` + `enforceAccessTokenType()`, and
 * only `enforceAccessTokenType()` was a shared mandatory post-verify step — the
 * revocation lookup was copy-pasted per guard, so admin-api's copy simply
 * omitted it. A signature-valid but force-logged-out / deleted / password-reset
 * SUPER_ADMIN token stayed fully valid on the most privileged surface until its
 * natural TTL, silently defeating the platform's emergency-cutoff controls.
 *
 * This gate makes recurrence DETECTABLE:
 *  1. The canonical set of directly-reachable auth boundaries (each nginx- /
 *     internet-reachable as a PRIMARY authenticator, so each MUST self-enforce
 *     revocation) references the shared revocation check.
 *  2. A repo sweep: any guard that cryptographically verifies a token
 *     (`getJwtVerifyOptions(`) must EITHER reference the revocation check itself
 *     OR structurally delegate to the gateway via an upstream-trust
 *     short-circuit (a `request.user && … return true` path). A new
 *     directly-reachable guard that verifies a token and omits revocation with
 *     no gateway delegation fails the build.
 *
 * Not a drift allowlist: the canonical set is a positive REQUIREMENT list that
 * only ever shrinks the exemption. The subgraph exemption is a detectable code
 * property (gateway delegation), not a filename allowlist.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const readAbs = (abs: string): string => readFileSync(abs, 'utf-8');
const readRel = (rel: string): string => readAbs(resolve(REPO_ROOT, rel));

/**
 * Symbols that constitute a token-revocation consultation:
 *  - `enforceTokenNotRevoked` — the shared post-verify primitive (backend-common).
 *  - `isValidToken`           — ITokenBlacklist composite (per-jti + user bulk).
 *  - `isBlacklisted`          — ITokenBlacklist per-jti (gateway path).
 *  - `isTokenValid`           — IUserTokenRevocation user_blacklist epoch.
 */
const REVOCATION_SYMBOLS = [
  'enforceTokenNotRevoked',
  'isValidToken',
  'isBlacklisted',
  'isTokenValid',
] as const;

const referencesRevocation = (src: string): boolean =>
  REVOCATION_SYMBOLS.some((symbol) => src.includes(symbol));

/**
 * A cryptographic verifier: the guard performs a full RS256 verify itself
 * (rather than only trusting a pre-populated principal).
 */
const verifiesToken = (src: string): boolean => src.includes('getJwtVerifyOptions(');

/**
 * A gateway-fronted subgraph guard delegates revocation to the gateway, evidenced
 * by an upstream-trust short-circuit: it returns `true` immediately when
 * `request.user` was already populated by the gateway (network-isolated so the
 * gateway is the sole entry point). Such guards are never nginx-exposed directly,
 * so the gateway — which they trust — already performed the revocation check.
 */
const delegatesToGateway = (src: string): boolean =>
  /request\.user\s*&&[\s\S]{0,800}?return true/.test(src);

/**
 * The canonical directly-reachable auth boundaries. Each is exposed as a PRIMARY
 * authenticator (gateway-api + admin-api are nginx-routed; auth-service issues
 * and re-verifies). admin-api specifically is routed straight past gateway-api in
 * prod (droplet.conf `location /api/`), so it cannot lean on the gateway's check.
 */
const DIRECTLY_REACHABLE_GUARDS = [
  'apps/gateway-api/src/guards/auth.guard.ts',
  'apps/auth-service/src/modules/authentication/guards/jwt-auth.guard.ts',
  'apps/admin-api-service/src/guards/platform-admin.guard.ts',
] as const;

/** Recursively collect production `*.guard.ts` files (excluding specs/tests). */
function collectGuardFiles(dirAbs: string): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dirAbs);
  } catch {
    return out;
  }
  for (const name of names) {
    const abs = join(dirAbs, name);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      if (name === 'node_modules' || name === '__tests__') continue;
      out.push(...collectGuardFiles(abs));
    } else if (name.endsWith('.guard.ts') && !name.endsWith('.spec.ts')) {
      out.push(abs);
    }
  }
  return out;
}

describe('APA-367 — JWT auth guards consult token revocation', () => {
  describe('directly-reachable auth boundaries self-enforce revocation', () => {
    it.each(DIRECTLY_REACHABLE_GUARDS)(
      '%s references the shared revocation check',
      (rel) => {
        const src = readRel(rel);
        expect(verifiesToken(src)).toBe(true);
        expect(referencesRevocation(src)).toBe(true);
      },
    );
  });

  describe('every token-verifying guard either checks revocation or delegates to the gateway', () => {
    const verifierGuards = collectGuardFiles(resolve(REPO_ROOT, 'apps'))
      .map((abs) => ({ abs, rel: abs.slice(REPO_ROOT.length + 1), src: readAbs(abs) }))
      .filter(({ src }) => verifiesToken(src));

    it('discovers the known token-verifying guards (glob sanity floor)', () => {
      // Guards against a broken walk silently vacuously passing the sweep.
      expect(verifierGuards.length).toBeGreaterThanOrEqual(5);
      const rels = verifierGuards.map((g) => g.rel);
      for (const canonical of DIRECTLY_REACHABLE_GUARDS) {
        expect(rels).toContain(canonical);
      }
    });

    it('no verifying guard omits BOTH the revocation check and gateway delegation', () => {
      const offenders = verifierGuards
        .filter(({ src }) => !referencesRevocation(src) && !delegatesToGateway(src))
        .map(({ rel }) => rel);
      expect(offenders).toEqual([]);
    });
  });

  it('the shared revocation primitive is exported from backend-common/auth', () => {
    const barrel = readRel('libs/backend-common/src/auth/index.ts');
    expect(barrel.includes('enforceTokenNotRevoked')).toBe(true);
  });
});
