/**
 * APA-366 — the dead double-submit CSRF control stays removed, and the CSRF
 * cookie/header names have one canonical definition.
 *
 * The admin panel shipped the CLIENT half of a double-submit CSRF contract
 * (read an `XSRF-TOKEN` cookie / `<meta name="csrf-token">`, echo it back in an
 * `X-CSRF-Token` header on mutations) against a server that never set the cookie
 * and never validated the header: admin-api has no CSRF middleware, prod nginx
 * routes /api/ past the gateway, the gateway's `CsrfMiddleware` is never mounted,
 * and it used cookie name `csrf-token` while the FE read `XSRF-TOKEN` — so the
 * control was dead end-to-end and, being Bearer-authenticated, admin-api cannot
 * be hit by classic CSRF anyway. The dead FE code was removed and the platform
 * commits to the Bearer + SameSite model.
 *
 * This gate makes the false control's re-introduction detectable:
 *   1. No `web/` source may read an `XSRF-TOKEN` cookie or attach an
 *      `X-CSRF-Token` header (the dead double-submit reader must stay gone).
 *   2. The gateway's `CsrfMiddleware` cookie/header names are exported as the
 *      single canonical SSoT (`csrf-token` / `x-csrf-token`), so if a real
 *      end-to-end control is ever wired, every side references ONE definition
 *      instead of the drifting hardcoded literals that caused this bug.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const DEAD_CSRF = /XSRF-TOKEN|X-CSRF-Token/i;

function webSourcesReadingDeadCsrf(): string[] {
  const files = execSync("git ls-files -- 'web/**/*.ts' 'web/**/*.tsx'", {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 128 * 1024 * 1024,
  })
    .split('\n')
    .filter((f) => f.trim().length > 0);
  return files.filter((rel) => DEAD_CSRF.test(stripComments(readFileSync(resolve(REPO_ROOT, rel), 'utf-8'))));
}

describe('APA-366 — CSRF double-submit is not resurrected; cookie name is SSoT', () => {
  it('no web/ source reads an XSRF-TOKEN cookie or attaches an X-CSRF-Token header', () => {
    expect(webSourcesReadingDeadCsrf()).toEqual([]);
  });

  it('the gateway CsrfMiddleware exports the canonical CSRF cookie/header names', () => {
    const src = readFileSync(
      resolve(REPO_ROOT, 'apps/gateway-api/src/middleware/csrf.middleware.ts'),
      'utf-8',
    );
    expect(/export const CSRF_COOKIE_NAME = ['"]csrf-token['"]/.test(src)).toBe(true);
    expect(/export const CSRF_HEADER_NAME = ['"]x-csrf-token['"]/.test(src)).toBe(true);
  });
});
