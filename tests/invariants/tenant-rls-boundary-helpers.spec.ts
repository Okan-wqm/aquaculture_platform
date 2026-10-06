/**
 * Invariant (SENSOR-HIGH-137 / SENSOR-MEDIUM-136): service code reaches tenant
 * data through the asserted tenant boundary, never through a search_path pin.
 *
 * `pinTenantTransactionSearchPath` and `pinTenantSchemaTransactionSearchPath`
 * set ONLY `search_path`. Tenant tables carry FORCE RLS and the pool is
 * deny-by-default outside a request context, so a query behind a bare pin
 * returns zero rows — silently. That is how every MQTT reading was dropped
 * from 2026-09-19 and how the stale-device and deploy-timeout jobs matched
 * nothing. `runInTenantRead` / `runInTenantTransaction` pin search_path AND the
 * tenant GUC and assert both before the callback runs; they are the only
 * sanctioned entry points for `apps/**`.
 *
 * KNOWN_IMPORTERS is a ratchet tied to MSG-MEDIUM-084: it may only shrink. A
 * file that stops importing the helpers must leave the list (the second test
 * fails until it does), so a fixed file can never regress unnoticed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
// An import binding or a call — not a prose mention in a comment.
const SEARCH_PATH_ONLY_HELPERS =
  /\b(pinTenantTransactionSearchPath|pinTenantSchemaTransactionSearchPath)\b\s*[(,}]/;

/** MSG-MEDIUM-084 (owner claude, deadline 2026-10-20). */
const KNOWN_IMPORTERS: readonly string[] = [
  'apps/messaging-service/src/ai/services/knowledge-extraction.service.ts',
  'apps/messaging-service/src/compliance/services/retention-policy.service.ts',
];

function importersOfSearchPathOnlyHelpers(): string[] {
  const files = execFileSync('git', ['ls-files', 'apps/**/*.ts'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => file.length > 0)
    .filter((file) => !/(\.spec|\.test)\.ts$|\/__tests__\//.test(file));

  return files.filter((file) =>
    SEARCH_PATH_ONLY_HELPERS.test(readFileSync(path.join(REPO_ROOT, file), 'utf8')),
  );
}

describe('tenant RLS boundary helpers (SENSOR-HIGH-137)', () => {
  const importers = importersOfSearchPathOnlyHelpers();

  it('no service outside the MSG-MEDIUM-084 ratchet uses a search_path-only helper', () => {
    expect(importers.filter((file) => !KNOWN_IMPORTERS.includes(file))).toEqual([]);
  });

  it('every ratchet entry still imports a helper (remove fixed files from the list)', () => {
    expect(KNOWN_IMPORTERS.filter((file) => !importers.includes(file))).toEqual([]);
  });
});
