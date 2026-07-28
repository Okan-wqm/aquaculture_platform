/**
 * APA-152 — the platform's CSRF protection is SameSite, and the properties it
 * rests on must stay true.
 *
 * # What the finding described, and what is actually there
 *
 * The admin panel's http-client used to implement the OWASP double-submit
 * pattern on mutating methods — read an `XSRF-TOKEN` cookie, echo it as
 * `X-CSRF-Token` — with a comment asserting "server rejects on mismatch".
 * Nothing on the server ever set that cookie or checked that header; admin-api
 * did not even list `X-CSRF-Token` in its CORS allowed headers. It was
 * decorative, and the comment was false. That machinery is now gone.
 *
 * Adding real double-submit middleware in its place would have defended against
 * an attack this auth model already precludes. Admin requests authenticate with
 * a Bearer header the client attaches from storage, which a cross-site page can
 * neither read nor make the browser send. The ONE credential the browser sends
 * automatically is the refresh-token cookie — and it is `SameSite=Lax` while
 * the refresh call is a POST, which Lax does not send cross-site. The
 * protection is real; it simply is not a token.
 *
 * # Why this gate exists
 *
 * That protection is IMPLICIT. It rests on three independent properties, none
 * of which announces that it is load-bearing, and any of which could be changed
 * for an unrelated reason — someone enabling a cross-site embed flips
 * `sameSite` to `'none'`, someone adds a GET refresh route, someone widens CORS.
 * Each would silently remove the platform's entire CSRF defence. Pinning them
 * turns "remember why this is safe" into a build failure.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-152
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');

const REFRESH_COOKIE = readFileSync(
  join(
    REPO_ROOT,
    'apps/auth-service/src/modules/authentication/utils/refresh-token-cookie.ts',
  ),
  'utf8',
);
const BOOTSTRAP = readFileSync(
  join(REPO_ROOT, 'libs/backend-common/src/bootstrap/create-service-app.ts'),
  'utf8',
);
const HTTP_CLIENT = readFileSync(
  join(REPO_ROOT, 'web/modules/admin-panel/src/services/http-client.ts'),
  'utf8',
);

/** Source with comments removed — a docblock explaining a rule must not satisfy it. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('admin CSRF posture (APA-152)', () => {
  const cookieCode = withoutComments(REFRESH_COOKIE);

  it('keeps the refresh cookie SameSite=Lax or stricter', () => {
    // `'none'` would send it on cross-site POSTs, which is precisely the
    // request a CSRF attack makes — and there is no token check to fall back on.
    const sameSiteValues = [...cookieCode.matchAll(/sameSite:\s*'(\w+)'/g)].map(
      (match) => match[1],
    );

    expect(sameSiteValues.length).toBeGreaterThan(0);
    for (const value of sameSiteValues) {
      expect(['lax', 'strict']).toContain(value);
    }
  });

  it('keeps the refresh cookie httpOnly', () => {
    // Readable from JS, it would be stealable by XSS and the SameSite argument
    // would no longer be the only thing protecting it.
    const httpOnlyValues = [...cookieCode.matchAll(/httpOnly:\s*(\w+)/g)].map(
      (match) => match[1],
    );

    expect(httpOnlyValues.length).toBeGreaterThan(0);
    for (const value of httpOnlyValues) {
      expect(value).toBe('true');
    }
  });

  it('never enables credentialed CORS with a wildcard origin', () => {
    // A wildcard origin with credentials is rejected by browsers anyway, but
    // the production hard-fail is what stops a permissive dev config reaching
    // an environment where the refresh cookie is live.
    expect(BOOTSTRAP).toMatch(/credentials:\s*!isWildcard/);
    expect(BOOTSTRAP).toMatch(/CORS_ORIGINS cannot be "\*" in production/);
  });

  it('re-introduces no decorative CSRF token machinery in the admin panel', () => {
    // The regression this finding is about: a client-side half of a protocol
    // whose server half does not exist reads as protection to the next person
    // and provides none.
    const clientCode = withoutComments(HTTP_CLIENT);

    expect(clientCode).not.toMatch(/X-CSRF-Token/);
    expect(clientCode).not.toMatch(/XSRF-TOKEN/);
  });

  it('states the posture where the credentialed fetch is made', () => {
    // The one place a reader asks "why does this send cookies?" — leaving it
    // unanswered is how the decorative machinery got written the first time.
    expect(HTTP_CLIENT).toMatch(/CSRF POSTURE/);
    expect(HTTP_CLIENT).toMatch(/SameSite/);
  });
});
