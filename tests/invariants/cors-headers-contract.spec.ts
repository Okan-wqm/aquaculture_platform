/**
 * APA-373 — CORS allow-list contract.
 *
 * Two drift defects motivated this gate:
 *   1. admin-api allow-listed 'X-Impersonate-User', but a repo-wide grep proves
 *      nothing reads it (impersonation runs through /impersonation REST + JWT,
 *      not a header) — a misleading remnant on a security surface.
 *   2. The shared FE http-clients emit a fixed set of custom headers
 *      (Authorization, X-Tenant-Id, X-Request-Id, X-Correlation-Id); if
 *      DEFAULT_CORS_HEADERS ever drops one, every mutating cross-origin preflight
 *      for that header would fail.
 *
 * This gate asserts DEFAULT_CORS_HEADERS is a superset of the FE-emitted header
 * set, and that no service allow-lists the dead X-Impersonate-User header.
 *
 * NOTE: X-CSRF-Token is intentionally NOT in the FE-emitted set — the dead
 * double-submit CSRF control was removed in APA-366; the FE no longer emits it.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();

const CREATE_SERVICE_APP = 'libs/backend-common/src/bootstrap/create-service-app.ts';

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * The custom request headers the shared FE http-clients attach on every call
 * (web/shared-ui api-client + admin-panel http-client). DEFAULT_CORS_HEADERS
 * must be a superset of these (case-insensitive) or cross-origin preflight fails.
 */
const FE_EMITTED_HEADERS = ['authorization', 'x-tenant-id', 'x-request-id', 'x-correlation-id'];

/** A header allow-listed by a service that no code reads — must never reappear. */
const DEAD_HEADER = 'X-Impersonate-User';

function defaultCorsHeadersLowercased(): string[] {
  const src = readFileSync(resolve(REPO_ROOT, CREATE_SERVICE_APP), 'utf-8');
  const block = /const DEFAULT_CORS_HEADERS:\s*string\[\]\s*=\s*\[([\s\S]*?)\]/.exec(src);
  if (!block) throw new Error('DEFAULT_CORS_HEADERS array not found in create-service-app.ts');
  const body = block[1] ?? '';
  return [...body.matchAll(/['"]([^'"]+)['"]/g)]
    .map((m) => m[1]?.toLowerCase())
    .filter((h): h is string => h !== undefined);
}

function serviceMainFiles(): string[] {
  return execSync("git ls-files -- 'apps/*/src/main.ts'", {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\n')
    .filter((f) => f.trim().length > 0);
}

describe('APA-373 — CORS allow-list contract', () => {
  it('DEFAULT_CORS_HEADERS is a superset of the FE-emitted header set', () => {
    const defaults = defaultCorsHeadersLowercased();
    const missing = FE_EMITTED_HEADERS.filter((h) => !defaults.includes(h));
    expect(missing).toEqual([]);
  });

  it('no service allow-lists the dead X-Impersonate-User header', () => {
    // Strip comments so a doc-comment explaining the removal is not mistaken for
    // a live allow-list entry.
    const offenders = serviceMainFiles().filter((rel) =>
      stripComments(readFileSync(resolve(REPO_ROOT, rel), 'utf-8')).includes(DEAD_HEADER),
    );
    expect(offenders).toEqual([]);
  });
});
