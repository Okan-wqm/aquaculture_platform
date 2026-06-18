/**
 * farm-service security-hardening invariants (Phase 6)
 * ============================================================================
 *
 * Two make-it-detectable backstops:
 *
 *   RULE 1 — no plaintext PII in log MESSAGE strings (pii-plaintext-log /
 *     FARM-HIGH-072). StructuredLoggerService masks only the `extra` metadata
 *     object, never the message string, so interpolating a decrypted PII field
 *     (`${x.firstName}`, `${x.email}`, …) into a `this.logger.*` message leaks
 *     plaintext PII to stdout/Loki. The platform rule ("string concatenation in
 *     log calls is banned") was previously unenforced. Dotted access keeps
 *     `${x.emailHash}` allowed (a hash, not PII — the `\b` after `email` fails).
 *
 *   RULE 2 — the global guard stack stays registered (global-auth-guard /
 *     FARM-LOW: the finding was a FALSE POSITIVE — farm IS protected by a
 *     ServiceIdentityGuard + RolesGuard + PermissionMatrixGuard APP_GUARD
 *     stack — but nothing failed CI if a refactor deleted those providers).
 *     This freezes the guard floor so unauthenticated execution can't silently
 *     become reachable.
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '..', '..');
const FARM_BE_ROOT = 'apps/farm-service/src';

function farmBackendFiles(): string[] {
  const out = execFileSync('git', ['ls-files', FARM_BE_ROOT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .filter(Boolean)
    .filter((f) => existsSync(join(REPO_ROOT, f)))
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => !f.includes('__tests__') && !f.endsWith('.spec.ts'));
}

const LOGGER_CALL = /\.logger\.(log|warn|error|debug|verbose|fatal)\(/;
// PII field accessed via dotted property inside a `${ … }` interpolation. The
// `\b` after each token keeps `.emailHash` (a blind index, not PII) allowed.
const PII_INTERP =
  /\$\{[^}]*\.(firstName|lastName|email|phone|address|nationalId|dateOfBirth|contactInfo)\b/;

describe('farm-service security-hardening invariants', () => {
  it('RULE 1: no decrypted PII interpolated into a logger message string', () => {
    const offenders: string[] = [];
    for (const file of farmBackendFiles()) {
      const content = readFileSync(join(REPO_ROOT, file), 'utf8');
      content.split('\n').forEach((line, i) => {
        if (LOGGER_CALL.test(line) && PII_INTERP.test(line)) {
          offenders.push(`${file}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    if (offenders.length > 0) {
      throw new Error(
        `farm-service must not interpolate decrypted PII (name/email/phone/etc.) ` +
          `into a logger message — it bypasses maskPii (StructuredLoggerService masks ` +
          `only the \`extra\` object). Log surrogate keys (id/employeeNumber/tenant) ` +
          `instead. Offenders:\n${offenders.join('\n')}`,
      );
    }
  });

  it('RULE 2: app.module registers the global ServiceIdentity + Roles + PermissionMatrix guard stack', () => {
    const appModule = readFileSync(join(REPO_ROOT, FARM_BE_ROOT, 'app.module.ts'), 'utf8');
    const required = ['APP_GUARD', 'ServiceIdentityGuard', 'RolesGuard', 'PermissionMatrixGuard'];
    const missing = required.filter((token) => !appModule.includes(token));
    if (missing.length > 0) {
      throw new Error(
        `farm-service app.module.ts must register the global guard stack as ` +
          `APP_GUARD providers (the authn/authz floor — see global-auth-guard). ` +
          `Missing tokens: ${missing.join(', ')}`,
      );
    }
  });
});
