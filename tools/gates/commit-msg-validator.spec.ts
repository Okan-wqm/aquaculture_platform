#!/usr/bin/env ts-node
/**
 * Unit tests for tools/gates/commit-msg-validator.ts
 * pure helper functions (Batch #349 — closes the test-
 * coverage gap from Batch #342 where the orphan-routing
 * extensions to `validateCommit` + the new
 * `loadOrphanIds` helper shipped without unit tests).
 *
 * Same architectural shape as
 * `tools/gates/clippy-affected.spec.ts` (Batch #348):
 * node:test (zero new dependencies), pure-function
 * coverage, exported-helper testing via the
 * `require.main === module` guard pattern.
 *
 * ## What this file pins
 *
 * - `CLOSES_TRAILER_REGEX` shape — accepts ULTRA-HIGH-NNN,
 *   ORPHAN-MEDIUM-NNN, etc.
 * - `ORPHAN_HEADING_REGEX` shape — extracts ID from
 *   `## ORPHAN-{SEV}-NNN — title` markdown headings.
 * - `REQUIRE_CLOSES_TYPES` regex — only fix/security/
 *   refactor(agentic,phase-*)/feat commits require a
 *   Closes trailer.
 * - `extractTrailers` — multi-Closes, single, none.
 * - `validateCommit` orphan-routing branches:
 *   - missing Closes on feat commit fails
 *   - chore commit without Closes passes (not in REQUIRE_CLOSES_TYPES)
 *   - ORPHAN-* trailer routes to orphan-IDs set
 *   - non-ORPHAN trailer routes to registry-IDs set
 *   - mixed UH + ORPHAN trailers both validated
 *   - missing review file fails (regardless of ID validity)
 *
 * ## What this file does NOT pin
 *
 * - `loadOrphanIds()` integration with the actual
 *   orphan-findings.md (depends on filesystem state;
 *   live-fire coverage exists via Batch #342's commit-
 *   landing test).
 * - `loadRegistryIds()` integration (same — depends on
 *   findings.jsonl).
 * - Git integration (commitsInRange, lastCommit) — these
 *   require a temp git repo; live-fire coverage from
 *   Batch #342's commit-landing test is the relevant
 *   integration check for these branches.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  CLOSES_TRAILER_REGEX,
  ORPHAN_HEADING_REGEX,
  REQUIRE_CLOSES_TYPES,
  extractTrailers,
  isAriaArtifactPath,
  isAriaFindingId,
  validateCommit,
  type Commit,
} from './commit-msg-validator';

// ---------------------------------------------------------
// CLOSES_TRAILER_REGEX
// ---------------------------------------------------------

test('CLOSES_TRAILER_REGEX matches ULTRA-HIGH-NNN trailer', () => {
  const m = CLOSES_TRAILER_REGEX.exec(
    'Closes: docs/reviews/orphan-findings.md#ULTRA-HIGH-091',
  );
  assert.notStrictEqual(m, null);
  assert.strictEqual(m?.[1], 'docs/reviews/orphan-findings.md');
  assert.strictEqual(m?.[2], 'ULTRA-HIGH-091');
});

test('CLOSES_TRAILER_REGEX matches ORPHAN-MEDIUM-NNN trailer', () => {
  const m = CLOSES_TRAILER_REGEX.exec(
    'Closes: docs/reviews/orphan-findings.md#ORPHAN-MEDIUM-031',
  );
  assert.notStrictEqual(m, null);
  assert.strictEqual(m?.[2], 'ORPHAN-MEDIUM-031');
});

test('CLOSES_TRAILER_REGEX rejects malformed ID (no severity)', () => {
  // Severity must be one of CRITICAL/HIGH/MEDIUM/LOW per
  // the regex contract.
  const m = CLOSES_TRAILER_REGEX.exec(
    'Closes: docs/reviews/orphan-findings.md#ORPHAN-XYZ-001',
  );
  assert.strictEqual(m, null);
});

test('CLOSES_TRAILER_REGEX rejects 2-digit ID (must be 3-digit)', () => {
  const m = CLOSES_TRAILER_REGEX.exec(
    'Closes: docs/reviews/orphan-findings.md#ULTRA-HIGH-91',
  );
  assert.strictEqual(m, null);
});

test('CLOSES_TRAILER_REGEX rejects line without Closes: prefix', () => {
  const m = CLOSES_TRAILER_REGEX.exec(
    'See: docs/reviews/orphan-findings.md#ULTRA-HIGH-091',
  );
  assert.strictEqual(m, null);
});

// ---------------------------------------------------------
// ORPHAN_HEADING_REGEX
// ---------------------------------------------------------

test('ORPHAN_HEADING_REGEX extracts ID from canonical heading', () => {
  const m = ORPHAN_HEADING_REGEX.exec(
    '## ORPHAN-MEDIUM-031 — `KeyPurpose` enum projects 4 SqlCipher consumers',
  );
  assert.notStrictEqual(m, null);
  assert.strictEqual(m?.[1], 'ORPHAN-MEDIUM-031');
});

test('ORPHAN_HEADING_REGEX matches all 4 severities', () => {
  for (const sev of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']) {
    const m = ORPHAN_HEADING_REGEX.exec(`## ORPHAN-${sev}-001 — title`);
    assert.notStrictEqual(m, null, `failed to match ORPHAN-${sev}-001`);
    assert.strictEqual(m?.[1], `ORPHAN-${sev}-001`);
  }
});

test('ORPHAN_HEADING_REGEX rejects non-orphan prefixes', () => {
  // ULTRA-HIGH lives in the registry, not orphan-findings.
  // Only ORPHAN-* prefixed headings count.
  const m = ORPHAN_HEADING_REGEX.exec('## ULTRA-HIGH-091 — title');
  assert.strictEqual(m, null);
});

test('ORPHAN_HEADING_REGEX rejects H1 / H3 headings (only H2)', () => {
  assert.strictEqual(
    ORPHAN_HEADING_REGEX.exec('# ORPHAN-MEDIUM-031 — title'),
    null,
  );
  assert.strictEqual(
    ORPHAN_HEADING_REGEX.exec('### ORPHAN-MEDIUM-031 — title'),
    null,
  );
});

// ---------------------------------------------------------
// REQUIRE_CLOSES_TYPES
// ---------------------------------------------------------

test('REQUIRE_CLOSES_TYPES matches gated commit types', () => {
  for (const subject of [
    'fix(edge): bug fix',
    'security(edge): hardening',
    'feat(tooling): new gate',
    'refactor(agentic,phase-6): cleanup',
  ]) {
    assert.ok(
      REQUIRE_CLOSES_TYPES.test(subject),
      `expected '${subject}' to require Closes`,
    );
  }
});

test('REQUIRE_CLOSES_TYPES does not match free types', () => {
  for (const subject of [
    'chore(registry): close UH',
    'docs(reviews): update orphan finding',
    'test(invariants): add coverage',
    'build(deps): bump version',
  ]) {
    assert.ok(
      !REQUIRE_CLOSES_TYPES.test(subject),
      `expected '${subject}' to NOT require Closes`,
    );
  }
});

// ---------------------------------------------------------
// extractTrailers
// ---------------------------------------------------------

test('extractTrailers: empty body returns empty array', () => {
  assert.deepStrictEqual(extractTrailers(''), []);
});

test('extractTrailers: single Closes trailer', () => {
  const trailers = extractTrailers(
    'body text\n\nCloses: docs/reviews/orphan-findings.md#ULTRA-HIGH-091',
  );
  assert.strictEqual(trailers.length, 1);
  assert.strictEqual(trailers[0]?.findingId, 'ULTRA-HIGH-091');
});

test('extractTrailers: multi-Closes (UH + ORPHAN together)', () => {
  const trailers = extractTrailers(
    [
      'body',
      '',
      'Closes: docs/reviews/orphan-findings.md#ULTRA-HIGH-091',
      'Closes: docs/reviews/orphan-findings.md#ORPHAN-MEDIUM-033',
    ].join('\n'),
  );
  assert.strictEqual(trailers.length, 2);
  assert.strictEqual(trailers[0]?.findingId, 'ULTRA-HIGH-091');
  assert.strictEqual(trailers[1]?.findingId, 'ORPHAN-MEDIUM-033');
});

test('extractTrailers: ignores non-Closes lines that mention findings', () => {
  // Free-text mention of a finding shouldn't count as a Closes trailer.
  const trailers = extractTrailers(
    'body\n\nSee #ULTRA-HIGH-091 for context\nCloses: docs/x.md#ORPHAN-LOW-030',
  );
  assert.strictEqual(trailers.length, 1);
  assert.strictEqual(trailers[0]?.findingId, 'ORPHAN-LOW-030');
});

// ---------------------------------------------------------
// validateCommit — orphan routing
// ---------------------------------------------------------

const NEVER_PRE_GATE = (_c: Commit): boolean => false;

test('validateCommit: feat commit without Closes fails', () => {
  const commit: Commit = {
    sha: 'abc123',
    shortSha: 'abc123',
    subject: 'feat(test): no closes',
    body: 'body text without trailers',
  };
  const violations = validateCommit(
    commit,
    new Set(),
    new Set(),
    NEVER_PRE_GATE,
  );
  assert.strictEqual(violations.length, 1);
  assert.match(violations[0]?.reason ?? '', /missing Closes: trailer/);
});

test('validateCommit: chore commit without Closes passes', () => {
  // chore is NOT in REQUIRE_CLOSES_TYPES, so it doesn't
  // need a trailer.
  const commit: Commit = {
    sha: 'abc123',
    shortSha: 'abc123',
    subject: 'chore(registry): cleanup',
    body: 'body without trailers',
  };
  const violations = validateCommit(
    commit,
    new Set(),
    new Set(),
    NEVER_PRE_GATE,
  );
  assert.strictEqual(violations.length, 0);
});

test('validateCommit: ORPHAN-* trailer routes to orphan-IDs (passes when present)', () => {
  // The trailer points at a path that does NOT exist on
  // disk (we don't want the test to depend on the actual
  // filesystem state). This will trigger ONE violation
  // (missing review file) but NOT the unknown-ID
  // violation — pinning that the orphan-routing code path
  // is taken.
  const commit: Commit = {
    sha: 'abc123',
    shortSha: 'abc123',
    subject: 'feat(tooling): orphan close',
    body: 'body\n\nCloses: docs/reviews/nonexistent.md#ORPHAN-MEDIUM-099',
  };
  const orphanIds = new Set(['ORPHAN-MEDIUM-099']);
  const violations = validateCommit(
    commit,
    new Set(),
    orphanIds,
    NEVER_PRE_GATE,
  );
  // Only the missing-review-file violation; the ID is
  // valid in the orphan set.
  assert.strictEqual(violations.length, 1);
  assert.match(
    violations[0]?.reason ?? '',
    /missing review file/,
  );
});

test('validateCommit: ORPHAN-* trailer with unknown ID fails with orphan-routed reason', () => {
  const commit: Commit = {
    sha: 'abc123',
    shortSha: 'abc123',
    subject: 'feat(tooling): bogus orphan',
    body: 'body\n\nCloses: docs/reviews/nonexistent.md#ORPHAN-LOW-998',
  };
  const violations = validateCommit(
    commit,
    new Set(),
    new Set(['ORPHAN-MEDIUM-099']), // 998 is NOT in this set
    NEVER_PRE_GATE,
  );
  // Two violations: missing review file + unknown orphan ID.
  // Pin the orphan-routed reason format (mentions
  // `## ORPHAN-LOW-998` heading + orphan-findings.md).
  const orphanReason = violations.find((v) =>
    v.reason.includes('unknown ORPHAN'),
  );
  assert.notStrictEqual(orphanReason, undefined);
  assert.match(
    orphanReason?.reason ?? '',
    /no matching "## ORPHAN-LOW-998" heading/,
  );
});

test('validateCommit: non-ORPHAN trailer routes to registry-IDs', () => {
  // ULTRA-HIGH-091 in registryIds → passes (only file-
  // missing violation surfaces).
  const commit: Commit = {
    sha: 'abc123',
    shortSha: 'abc123',
    subject: 'feat(tooling): registry close',
    body: 'body\n\nCloses: docs/reviews/nonexistent.md#ULTRA-HIGH-091',
  };
  const violations = validateCommit(
    commit,
    new Set(['ULTRA-HIGH-091']),
    new Set(),
    NEVER_PRE_GATE,
  );
  assert.strictEqual(violations.length, 1);
  assert.match(violations[0]?.reason ?? '', /missing review file/);
});

test('validateCommit: non-ORPHAN trailer with unknown ID fails with registry-routed reason', () => {
  const commit: Commit = {
    sha: 'abc123',
    shortSha: 'abc123',
    subject: 'feat(tooling): bogus uh',
    body: 'body\n\nCloses: docs/reviews/nonexistent.md#ULTRA-HIGH-998',
  };
  const violations = validateCommit(
    commit,
    new Set(['ULTRA-HIGH-091']),
    new Set(),
    NEVER_PRE_GATE,
  );
  const registryReason = violations.find((v) =>
    v.reason.includes('not in docs/reviews/_registry/findings.jsonl'),
  );
  assert.notStrictEqual(registryReason, undefined);
  assert.match(registryReason?.reason ?? '', /unknown finding ID/);
});

test('validateCommit: multi-Closes (UH valid + ORPHAN valid) both route correctly', () => {
  // The Batch #341 case: a commit closing both a registry-
  // tracked UH-NNN AND a markdown-tracked ORPHAN-NNN. Pre-
  // Batch-#342 this would fail because the ORPHAN side
  // routed to registry. Post-#342 each side routes to its
  // proper source. Pin that BOTH validate cleanly.
  const commit: Commit = {
    sha: 'abc123',
    shortSha: 'abc123',
    subject: 'feat(tooling): multi-close',
    body: [
      'body',
      '',
      'Closes: docs/reviews/nonexistent.md#ULTRA-HIGH-091',
      'Closes: docs/reviews/nonexistent.md#ORPHAN-MEDIUM-099',
    ].join('\n'),
  };
  const violations = validateCommit(
    commit,
    new Set(['ULTRA-HIGH-091']),
    new Set(['ORPHAN-MEDIUM-099']),
    NEVER_PRE_GATE,
  );
  // Only TWO file-missing violations (one per Closes line);
  // NO unknown-ID violations because both IDs are in
  // their respective sets.
  for (const v of violations) {
    assert.match(
      v.reason,
      /missing review file/,
      `unexpected violation: ${v.reason}`,
    );
  }
  assert.strictEqual(violations.length, 2);
});

test('validateCommit: pre-gate predicate skips validation', () => {
  // Allowlist commits (pre-Phase-6 SHAs) skip the gate.
  const commit: Commit = {
    sha: 'abc123',
    shortSha: 'abc123',
    subject: 'feat(legacy): allowlisted',
    body: 'body without trailers',
  };
  const violations = validateCommit(
    commit,
    new Set(),
    new Set(),
    () => true, // pre-gate true = skip
  );
  assert.strictEqual(violations.length, 0);
});

// ---------------------------------------------------------
// Plan 017 Phase 1.1 — ARIA artifact trailer routing
// ---------------------------------------------------------

test('CLOSES_TRAILER_REGEX matches aria-findings F-NNN trailer', () => {
  const m = CLOSES_TRAILER_REGEX.exec('Closes: aria-findings/F-001.json#F-001');
  assert.notStrictEqual(m, null);
  assert.strictEqual(m?.[1], 'aria-findings/F-001.json');
  assert.strictEqual(m?.[2], 'F-001');
});

test('CLOSES_TRAILER_REGEX matches aria-debts DEBT-YYYY-MM-DD-NNN trailer', () => {
  const m = CLOSES_TRAILER_REGEX.exec(
    'Closes: aria-debts/DEBT-2026-05-08-001.json#DEBT-2026-05-08-001',
  );
  assert.notStrictEqual(m, null);
  assert.strictEqual(m?.[1], 'aria-debts/DEBT-2026-05-08-001.json');
  assert.strictEqual(m?.[2], 'DEBT-2026-05-08-001');
});

test('isAriaArtifactPath / isAriaFindingId classify correctly', () => {
  assert.strictEqual(isAriaArtifactPath('aria-findings/F-001.json'), true);
  assert.strictEqual(isAriaArtifactPath('aria-debts/DEBT-2026-05-08-001.json'), true);
  assert.strictEqual(isAriaArtifactPath('docs/reviews/x.md'), false);
  assert.strictEqual(isAriaFindingId('F-001'), true);
  assert.strictEqual(isAriaFindingId('DEBT-2026-05-08-001'), true);
  assert.strictEqual(isAriaFindingId('UH-HIGH-091'), false);
  assert.strictEqual(isAriaFindingId('ORPHAN-MEDIUM-031'), false);
});

test('validateCommit: ARIA finding trailer routes to filesystem (no registry lookup)', (t) => {
  // Stub the file existence check via a real file in /tmp won't work in
  // this test runner; instead rely on the actual snowball state's F-001
  // file being present when the spec runs. The validator's existsSync
  // check passes; the routing branch then validates ARIA shape pairing.
  const commit: Commit = {
    sha: 'abc123',
    shortSha: 'abc123',
    subject: 'feat(aria-kernel): close finding',
    body: 'body\n\nCloses: aria-findings/F-001.json#F-001',
  };
  const violations = validateCommit(
    commit,
    new Set(), // empty registry — must not be consulted for ARIA path
    new Set(), // empty orphan list — must not be consulted
    () => false,
  );
  // The only possible violation here is "missing review file" if F-001.json
  // is absent from the worktree. When it is present, ZERO violations.
  for (const v of violations) {
    assert.match(
      v.reason,
      /missing review file|ARIA trailer/,
      `unexpected violation: ${v.reason}`,
    );
  }
});

test('validateCommit: ARIA path with non-ARIA ID is rejected', () => {
  const commit: Commit = {
    sha: 'abc123',
    shortSha: 'abc123',
    subject: 'feat(aria-kernel): mismatched',
    body: 'Closes: aria-findings/F-001.json#UH-HIGH-001',
  };
  // The trailer regex still extracts; routing must reject the mismatch.
  // First confirm extractTrailers caught it (UH-HIGH-001 matches alt 1).
  const trailers = extractTrailers(commit.body);
  assert.strictEqual(trailers.length, 1);
  // Now validate — the mismatch lane fires.
  const violations = validateCommit(commit, new Set(['UH-HIGH-001']), new Set(), () => false);
  assert.ok(
    violations.some((v) => /ARIA trailer/.test(v.reason)),
    `expected ARIA trailer mismatch violation, got: ${JSON.stringify(violations)}`,
  );
});

test('validateCommit: aria-findings path with DEBT-style ID is rejected', () => {
  const commit: Commit = {
    sha: 'abc123',
    shortSha: 'abc123',
    subject: 'feat(aria-kernel): wrong shape',
    body: 'Closes: aria-findings/F-001.json#DEBT-2026-05-08-001',
  };
  const violations = validateCommit(commit, new Set(), new Set(), () => false);
  assert.ok(
    violations.some((v) => /path\/ID mismatch/.test(v.reason)),
    `expected path/ID mismatch violation, got: ${JSON.stringify(violations)}`,
  );
});

test('validateCommit: registry trailer still routes to registry (not ARIA)', () => {
  const commit: Commit = {
    sha: 'abc123',
    shortSha: 'abc123',
    subject: 'feat(non-aria): legacy',
    body: 'Closes: docs/reviews/x.md#UH-HIGH-091',
  };
  // Registry lookup MUST still gate non-ARIA paths.
  const violations = validateCommit(commit, new Set(['UH-HIGH-091']), new Set(), () => false);
  // missing review file violation is fine (test fixture); only ARIA-routed
  // violations would be wrong here.
  for (const v of violations) {
    assert.doesNotMatch(
      v.reason,
      /ARIA trailer/,
      `unexpected ARIA-routed violation on legacy registry trailer: ${v.reason}`,
    );
  }
});
