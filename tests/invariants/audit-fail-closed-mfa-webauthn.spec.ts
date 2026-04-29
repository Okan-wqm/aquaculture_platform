/**
 * Platform-wide invariants — AUDITTRAIL-HIGH-002, HIGH-003, HIGH-006:
 *
 * Every audit-emission path on the legacy + MFA + WebAuthn surfaces
 * MUST be fail-closed:
 *
 *   - Legacy AuditLogInterceptor uses `recordAwait` (NOT `record`)
 *     and a switchMap pipe (NOT `tap`) so the response stream waits
 *     for the audit-row write to commit before emission. (HIGH-002,
 *     HIGH-006)
 *   - MFA + WebAuthn audit-emit helpers MUST NOT wrap the
 *     `auditLogService.log(...)` call in a try/catch that swallows
 *     the error. (HIGH-003)
 *
 * Combined invariant: silent audit loss on any security gate is
 * forbidden.
 *
 * # Why this lives in tests/invariants/
 *
 * The auditor flagged 16 MFA gate callsites (`MFA_VERIFY_FAILED`,
 * `MFA_LOCKOUT`, `MFA_STEPUP_FAILED`, `MFA_STEPUP_LOCKOUT`,
 * `MFA_STEPUP_SUCCESS`, etc.) that all emit audit via the same
 * private helper. A future maintainer "tidying" the helper by
 * re-introducing a try/catch (the seemingly-defensive change that
 * triggered the original incident) would silently regress every gate.
 * This Tier-3 "make detectable" gate trips at CI on the source-level
 * shape so the regression cannot land.
 *
 * # Failure mode
 *
 * If a try { ... } catch { ... } block reappears around the
 * auditLogService.log call inside `logMfaEvent` or `logAudit` (the
 * WebAuthn equivalent), this spec fails with an exact-line evidence
 * pointer. Maintainers must either:
 *
 *   - Restore the fail-closed shape (preferred), or
 *   - If a legitimate fallback is needed (e.g. NATS audit-fallback
 *     event for degraded-DB scenarios per the auditor's alternative
 *     proposal), update this invariant to require the fallback
 *     emission as part of the catch path.
 *
 * Closes: docs/reviews/audit-trail-completeness-auditor/2026-04-28-core-platform-review.md#AUDITTRAIL-HIGH-003
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const MFA_SOURCE =
  'apps/auth-service/src/modules/authentication/services/mfa.service.ts';
const WEBAUTHN_SOURCE =
  'apps/auth-service/src/modules/authentication/services/webauthn.service.ts';

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

/**
 * Slice the body of a private method out of the source by name. The
 * matcher is permissive — it locates the method declaration and pulls
 * everything to the next `}\n  ` (end of method body at 2-space
 * indent). For audit-helper methods this is precise enough.
 */
function methodBody(src: string, methodName: string): string {
  const declRe = new RegExp(
    String.raw`private\s+async\s+${methodName}\s*\([\s\S]*?\)\s*:\s*Promise<void>\s*{`,
  );
  const declMatch = declRe.exec(src);
  if (!declMatch) {
    throw new Error(`Could not locate ${methodName} in source`);
  }
  const start = declMatch.index;
  const after = src.slice(start);
  // Find the matching closing brace by counting nested {}.
  let depth = 0;
  for (let i = 0; i < after.length; i++) {
    const ch = after[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return after.slice(0, i + 1);
      }
    }
  }
  throw new Error(`Unbalanced braces in ${methodName}`);
}

describe('AUDITTRAIL-HIGH-003 — MFA / WebAuthn audit fail-closed invariant', () => {
  it('mfa.service.ts logMfaEvent MUST NOT wrap auditLogService.log in try/catch', () => {
    const src = read(MFA_SOURCE);
    const body = methodBody(src, 'logMfaEvent');
    expect(body).toMatch(/this\.auditLogService\.log\(/);
    // Forbidden shape: a try {} catch (...) block surrounding the
    // audit write. We check both the try-block presence AND the
    // tell-tale "Failed to log" log line that the previous swallow
    // emitted.
    expect(body).not.toMatch(/\btry\s*{/);
    expect(body).not.toMatch(/Failed to log MFA event/);
  });

  it('webauthn.service.ts logAudit MUST NOT wrap auditLogService.log in try/catch', () => {
    const src = read(WEBAUTHN_SOURCE);
    const body = methodBody(src, 'logAudit');
    expect(body).toMatch(/this\.auditLogService\.log\(/);
    expect(body).not.toMatch(/\btry\s*{/);
    expect(body).not.toMatch(/Failed to log WebAuthn audit event/);
  });

  // ──────────────────────────────────────────────────────────────────
  // AUDITTRAIL-HIGH-002 + HIGH-006 — legacy AuditLogInterceptor
  // fail-closed contract.
  // ──────────────────────────────────────────────────────────────────

  it('legacy AuditLogInterceptor recordAuditLog calls recordAwait (not the fire-and-forget record())', () => {
    const src = readFileSync(
      resolve(REPO_ROOT, 'libs/backend-common/src/audit/audit-log.interceptor.ts'),
      'utf8',
    );
    // Locate the recordAuditLog method body.
    const declRe =
      /private\s+async\s+recordAuditLog\s*\([\s\S]*?\)\s*:\s*Promise<void>\s*{/;
    const match = declRe.exec(src);
    expect(match).not.toBeNull();
    const after = src.slice(match!.index);
    let depth = 0;
    let body = '';
    for (let i = 0; i < after.length; i++) {
      const ch = after[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          body = after.slice(0, i + 1);
          break;
        }
      }
    }
    // The audit-row write inside the helper MUST be recordAwait —
    // record() (fire-and-forget) silently loses evidence.
    expect(body).toMatch(/await\s+this\.auditLogService\.recordAwait\(/);
    expect(body).not.toMatch(/this\.auditLogService\.record\(/);
  });

  it('legacy AuditLogInterceptor intercept() uses switchMap (not tap) so the response stream waits for the audit write', () => {
    const src = readFileSync(
      resolve(REPO_ROOT, 'libs/backend-common/src/audit/audit-log.interceptor.ts'),
      'utf8',
    );
    // The intercept() method must pipe through switchMap (which awaits
    // the promise) on the success path. tap() does NOT wait for
    // promises — using it would race the response stream against the
    // DB write.
    expect(src).toMatch(/import\s*{[^}]*switchMap[^}]*}\s+from\s+'rxjs\/operators'/);
    expect(src).not.toMatch(/import\s*{\s*tap\s*}\s+from\s+'rxjs\/operators'/);
    // Specifically, the intercept body should funnel through
    // `switchMap(...) => from(this.recordAuditLog(...))`.
    expect(src).toMatch(
      /switchMap\s*\(\s*\(result[\s\S]*?from\s*\(\s*\n?\s*this\.recordAuditLog\(/,
    );
  });

  // ──────────────────────────────────────────────────────────────────

  it('every MFA gate callsite still awaits logMfaEvent (failure must propagate)', () => {
    const src = read(MFA_SOURCE);
    // Count `await this.logMfaEvent` occurrences — the auditor
    // documented 16 such callsites; all of them must be awaited so
    // a thrown audit error becomes a thrown gate error. We accept
    // ≥10 (defensive against future call additions/removals — what
    // matters is that NO bare `this.logMfaEvent(` exists, only
    // `await this.logMfaEvent(`).
    const awaitedCount = (src.match(/await\s+this\.logMfaEvent\(/g) ?? [])
      .length;
    expect(awaitedCount).toBeGreaterThanOrEqual(10);
    // Bare callsites (without await) would silently swallow the
    // throw. There must be zero of them outside the helper itself.
    const bareCallsites = src
      .split('\n')
      .filter(
        (line) =>
          /\bthis\.logMfaEvent\(/.test(line) &&
          !/\bawait\s+this\.logMfaEvent\(/.test(line) &&
          !/private\s+async\s+logMfaEvent/.test(line),
      );
    expect(bareCallsites).toEqual([]);
  });
});
