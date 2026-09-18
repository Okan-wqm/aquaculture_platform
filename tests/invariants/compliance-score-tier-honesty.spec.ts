/**
 * Platform-wide invariant — COMPLIANCE-MEDIUM-002:
 *
 * `ComplianceService.checkRequirement()` MUST NOT have a `default:`
 * branch that returns `status: 'compliant'`. The compliance score
 * (`calculateComplianceScore`) averages 'compliant' as 100%; a
 * default-compliant fallback inflates the score with fictitious
 * passes for every requirement that has no real automated check.
 *
 * # Why this lives in tests/invariants/
 *
 * The compliance-score function is the highest-leverage row a
 * SOC 2 / KVKK auditor reads. Pre-cure, 6 of 8 GDPR requirements
 * fell through to `default: 'compliant'`, producing a misleading
 * 88% headline that an auditor would interpret as evidence of
 * substantive automated coverage. The cure flipped the default
 * to 'partial' with explicit attestation pointers.
 *
 * A future maintainer "tidying" the default branch back to
 * 'compliant' would silently re-introduce the same misleading-
 * headline regression class. This Tier-3 source-level invariant
 * trips at PR review.
 *
 * # What this spec asserts
 *
 *   1. The default branch returns `status: 'partial'` (NOT
 *      'compliant').
 *   2. The default branch's `details` references the canonical
 *      attestation document path
 *      `docs/compliance/evidence/${req.id}.md` so operators have
 *      a documented elevation path.
 *   3. NO line in the file reads `status: 'compliant', details:
 *      'Requirement met'` (the pre-cure shape).
 *
 * Closes: docs/reviews/compliance-expert/2026-04-28-core-platform-review.md#COMPLIANCE-MEDIUM-002
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const COMPLIANCE_SERVICE_PATH =
  'apps/admin-api-service/src/security/services/compliance.service.ts';

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

describe('COMPLIANCE-MEDIUM-002 — compliance-score tier honesty', () => {
  it('checkRequirement default branch returns status:partial (not compliant)', () => {
    const src = read(COMPLIANCE_SERVICE_PATH);
    // Locate the checkRequirement method body and zoom into the
    // default branch.
    // Anchored on the METHOD, not on one spelling of its return type. Pinning
    // the body by `Promise<ComplianceCheckResult>` made this spec fail the
    // moment that type was legitimately split into `ComplianceCheckOutcome`
    // (what a check concludes) and `ComplianceCheckResult` (that, plus the
    // runner's `checkedAt`) — a rename is not the regression this gate exists
    // to catch, and a gate that trips on one is a gate people learn to edit.
    const declRe =
      /private\s+async\s+checkRequirement\s*\([\s\S]*?\)\s*:\s*Promise<\w+>\s*{/;
    const declMatch = declRe.exec(src);
    expect(declMatch).not.toBeNull();
    const after = src.slice(declMatch!.index);
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
    // The default branch's return statement.
    const defaultBranch = /default\s*:\s*([\s\S]*?)\n\s+}/.exec(body);
    expect(defaultBranch).not.toBeNull();
    const defaultBody = defaultBranch![1] ?? '';

    expect(defaultBody).toMatch(/status\s*:\s*['"]partial['"]/);
    expect(defaultBody).not.toMatch(/status\s*:\s*['"]compliant['"]/);
  });

  it('checkRequirement default branch points at the canonical attestation document path', () => {
    const src = read(COMPLIANCE_SERVICE_PATH);
    expect(src).toMatch(
      /docs\/compliance\/evidence\/\$\{[^}]*req\.id[^}]*\}\.md/,
    );
  });

  it('the pre-cure misleading shape (compliant + Requirement met) is absent file-wide', () => {
    const src = read(COMPLIANCE_SERVICE_PATH);
    // Both halves must NOT appear together. We allow `'compliant'`
    // elsewhere (the gdpr-2 / gdpr-3 real-check returns are still
    // legitimately 'compliant'), but the specific
    // "compliant + Requirement met" pair was the misleading
    // default — checking the pair forbids reintroduction.
    expect(src).not.toMatch(
      /status\s*:\s*['"]compliant['"]\s*,\s*details\s*:\s*['"]Requirement met['"]/,
    );
  });
});
