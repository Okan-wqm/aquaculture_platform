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
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  CLOSES_TRAILER_REGEX,
  ORPHAN_HEADING_REGEX,
  REQUIRE_CLOSES_TYPES,
  extractTrailers,
  isAriaArtifactPath,
  isAriaFindingId,
  readAriaArtifactId,
  validateCommit,
  type Commit,
} from './commit-msg-validator';

// Plan 018 Phase 4 fixtures live under aria-findings/.test-fixtures/ +
// aria-debts/.test-fixtures/. The kernel's _refresh_index globs
// `F-*.json` / `DEBT-*.json` so dot-prefixed dirs are excluded; commit-
// msg-validator references files by literal path so it sees them
// regardless. Fixtures are written in `before` and removed in `after`.
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();
const FIXTURE_FINDINGS_DIR = resolve(REPO_ROOT, 'aria-findings/.test-fixtures');
const FIXTURE_DEBTS_DIR = resolve(REPO_ROOT, 'aria-debts/.test-fixtures');

// ---------------------------------------------------------
// CLOSES_TRAILER_REGEX
// ---------------------------------------------------------

void test('CLOSES_TRAILER_REGEX matches ULTRA-HIGH-NNN trailer', () => {
  const m = CLOSES_TRAILER_REGEX.exec(
    'Closes: docs/reviews/orphan-findings.md#ULTRA-HIGH-091',
  );
  assert.notStrictEqual(m, null);
  assert.strictEqual(m?.[1], 'docs/reviews/orphan-findings.md');
  assert.strictEqual(m?.[2], 'ULTRA-HIGH-091');
});

void test('CLOSES_TRAILER_REGEX matches ORPHAN-MEDIUM-NNN trailer', () => {
  const m = CLOSES_TRAILER_REGEX.exec(
    'Closes: docs/reviews/orphan-findings.md#ORPHAN-MEDIUM-031',
  );
  assert.notStrictEqual(m, null);
  assert.strictEqual(m?.[2], 'ORPHAN-MEDIUM-031');
});

void test('CLOSES_TRAILER_REGEX rejects malformed ID (no severity)', () => {
  // Severity must be one of CRITICAL/HIGH/MEDIUM/LOW per
  // the regex contract.
  const m = CLOSES_TRAILER_REGEX.exec(
    'Closes: docs/reviews/orphan-findings.md#ORPHAN-XYZ-001',
  );
  assert.strictEqual(m, null);
});

void test('CLOSES_TRAILER_REGEX rejects 2-digit ID (must be 3-digit)', () => {
  const m = CLOSES_TRAILER_REGEX.exec(
    'Closes: docs/reviews/orphan-findings.md#ULTRA-HIGH-91',
  );
  assert.strictEqual(m, null);
});

void test('CLOSES_TRAILER_REGEX rejects line without Closes: prefix', () => {
  const m = CLOSES_TRAILER_REGEX.exec(
    'See: docs/reviews/orphan-findings.md#ULTRA-HIGH-091',
  );
  assert.strictEqual(m, null);
});

// ---------------------------------------------------------
// ORPHAN_HEADING_REGEX
// ---------------------------------------------------------

void test('ORPHAN_HEADING_REGEX extracts ID from canonical heading', () => {
  const m = ORPHAN_HEADING_REGEX.exec(
    '## ORPHAN-MEDIUM-031 — `KeyPurpose` enum projects 4 SqlCipher consumers',
  );
  assert.notStrictEqual(m, null);
  assert.strictEqual(m?.[1], 'ORPHAN-MEDIUM-031');
});

void test('ORPHAN_HEADING_REGEX matches all 4 severities', () => {
  for (const sev of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']) {
    const m = ORPHAN_HEADING_REGEX.exec(`## ORPHAN-${sev}-001 — title`);
    assert.notStrictEqual(m, null, `failed to match ORPHAN-${sev}-001`);
    assert.strictEqual(m?.[1], `ORPHAN-${sev}-001`);
  }
});

void test('ORPHAN_HEADING_REGEX rejects non-orphan prefixes', () => {
  // ULTRA-HIGH lives in the registry, not orphan-findings.
  // Only ORPHAN-* prefixed headings count.
  const m = ORPHAN_HEADING_REGEX.exec('## ULTRA-HIGH-091 — title');
  assert.strictEqual(m, null);
});

void test('ORPHAN_HEADING_REGEX rejects H1 / H3 headings (only H2)', () => {
  assert.strictEqual(
    ORPHAN_HEADING_REGEX.exec('# ORPHAN-MEDIUM-031 — title'),
    null,
  );
  assert.strictEqual(
    ORPHAN_HEADING_REGEX.exec('### ORPHAN-MEDIUM-031 — title'),
    null,
  );
});

void test('ORPHAN_HEADING_REGEX matches the forms the narrow pattern skipped', () => {
  // These are all real headings in docs/reviews/orphan-findings.md. The
  // previous ORPHAN-(CRITICAL|HIGH|MEDIUM|LOW)-\d{3} pattern matched
  // none of them, so 16 occupied sequences looked free to the ID
  // allocator — which is how nineteen IDs were minted onto findings
  // that already existed.
  for (const [line, expected] of [
    ['## ORPHAN-001 — pre-severity era heading', 'ORPHAN-001'],
    ['## ORPHAN-063 — pre-severity era heading', 'ORPHAN-063'],
    ['## ORPHAN-INFO-363 — a severity the registry does not use', 'ORPHAN-INFO-363'],
    ['## ORPHAN-LOW-337b — a suffixed re-open', 'ORPHAN-LOW-337b'],
  ] as const) {
    const m = ORPHAN_HEADING_REGEX.exec(line);
    assert.notStrictEqual(m, null, `failed to match: ${line}`);
    assert.strictEqual(m?.[1], expected);
  }
});

void test('ORPHAN_HEADING_REGEX captures the bare sequence for the allocator', () => {
  // Group 2 is what makes a markdown-held sequence visible to
  // nextFindingId; severity and suffix must be discarded.
  assert.strictEqual(ORPHAN_HEADING_REGEX.exec('## ORPHAN-LOW-337b — x')?.[2], '337');
  assert.strictEqual(ORPHAN_HEADING_REGEX.exec('## ORPHAN-416 — x')?.[2], '416');
});

// ---------------------------------------------------------
// REQUIRE_CLOSES_TYPES
// ---------------------------------------------------------

void test('REQUIRE_CLOSES_TYPES matches gated commit types', () => {
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

void test('REQUIRE_CLOSES_TYPES does not match free types', () => {
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

void test('extractTrailers: empty body returns empty array', () => {
  assert.deepStrictEqual(extractTrailers(''), []);
});

void test('extractTrailers: single Closes trailer', () => {
  const trailers = extractTrailers(
    'body text\n\nCloses: docs/reviews/orphan-findings.md#ULTRA-HIGH-091',
  );
  assert.strictEqual(trailers.length, 1);
  assert.strictEqual(trailers[0]?.findingId, 'ULTRA-HIGH-091');
});

void test('extractTrailers: multi-Closes (UH + ORPHAN together)', () => {
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

void test('extractTrailers: ignores non-Closes lines that mention findings', () => {
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

void test('validateCommit: feat commit without Closes fails', () => {
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

void test('validateCommit: chore commit without Closes passes', () => {
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

void test('validateCommit: ORPHAN-* trailer routes to orphan-IDs (passes when present)', () => {
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

void test('validateCommit: ORPHAN-* trailer resolves against the REGISTRY too', () => {
  // The lane is a union. An ORPHAN ID minted into the hash-chained
  // registry used to resolve against neither store — not the registry,
  // because the ORPHAN prefix routed away from it, and not the markdown,
  // because it was never written there. Eleven ledger ORPHAN IDs were
  // already unreferenceable this way.
  const commit: Commit = {
    sha: 'abc123',
    shortSha: 'abc123',
    subject: 'fix(gates): close a registry-held orphan finding',
    body: 'body\n\nCloses: CLAUDE.md#ORPHAN-CRITICAL-333',
  };
  const violations = validateCommit(
    commit,
    new Set(['ORPHAN-CRITICAL-333']), // registryIds
    new Set(), // orphanIds — markdown knows nothing about it
    NEVER_PRE_GATE,
  );
  assert.strictEqual(
    violations.length,
    0,
    `expected the registry to satisfy the ORPHAN lane, got: ${JSON.stringify(violations)}`,
  );
});

void test('validateCommit: ORPHAN-* trailer with unknown ID fails with orphan-routed reason', () => {
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

void test('validateCommit: non-ORPHAN trailer routes to registry-IDs', () => {
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

void test('validateCommit: non-ORPHAN trailer with unknown ID fails with registry-routed reason', () => {
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

void test('validateCommit: multi-Closes (UH valid + ORPHAN valid) both route correctly', () => {
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

void test('validateCommit: pre-gate predicate skips validation', () => {
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

void test('CLOSES_TRAILER_REGEX matches aria-findings F-NNN trailer', () => {
  const m = CLOSES_TRAILER_REGEX.exec('Closes: aria-findings/F-001.json#F-001');
  assert.notStrictEqual(m, null);
  assert.strictEqual(m?.[1], 'aria-findings/F-001.json');
  assert.strictEqual(m?.[2], 'F-001');
});

void test('CLOSES_TRAILER_REGEX matches aria-debts DEBT-YYYY-MM-DD-NNN trailer', () => {
  const m = CLOSES_TRAILER_REGEX.exec(
    'Closes: aria-debts/DEBT-2026-05-08-001.json#DEBT-2026-05-08-001',
  );
  assert.notStrictEqual(m, null);
  assert.strictEqual(m?.[1], 'aria-debts/DEBT-2026-05-08-001.json');
  assert.strictEqual(m?.[2], 'DEBT-2026-05-08-001');
});

void test('isAriaArtifactPath / isAriaFindingId classify correctly', () => {
  assert.strictEqual(isAriaArtifactPath('aria-findings/F-001.json'), true);
  assert.strictEqual(isAriaArtifactPath('aria-debts/DEBT-2026-05-08-001.json'), true);
  assert.strictEqual(isAriaArtifactPath('docs/reviews/x.md'), false);
  assert.strictEqual(isAriaFindingId('F-001'), true);
  assert.strictEqual(isAriaFindingId('DEBT-2026-05-08-001'), true);
  assert.strictEqual(isAriaFindingId('UH-HIGH-091'), false);
  assert.strictEqual(isAriaFindingId('ORPHAN-MEDIUM-031'), false);
});

void test('validateCommit: ARIA finding trailer routes to filesystem (no registry lookup)', () => {
  // Plan 018 Phase 6.1 (G6) — refactored to a self-contained tempfile
  // fixture so the test no longer depends on snowball's working-tree
  // state (the original implementation read aria-findings/F-001.json
  // from disk and would behave differently if that file were renamed,
  // moved, or removed by future ARIA work). The fixture lives under
  // aria-findings/.test-fixtures/ — same dot-prefix carve-out the kernel
  // _refresh_index excludes via `glob('F-*.json')`.
  mkdirSync(FIXTURE_FINDINGS_DIR, { recursive: true });
  const fixturePath = resolve(FIXTURE_FINDINGS_DIR, 'F-903.json');
  writeFileSync(
    fixturePath,
    JSON.stringify({ finding_id: 'F-903', severity: 'LOW', status: 'OPEN' }),
  );
  try {
    const commit: Commit = {
      sha: 'abc123',
      shortSha: 'abc123',
      subject: 'feat(aria-kernel): close finding',
      body: 'body\n\nCloses: aria-findings/.test-fixtures/F-903.json#F-903',
    };
    const violations = validateCommit(
      commit,
      new Set(), // empty registry — must not be consulted for ARIA path
      new Set(), // empty orphan list — must not be consulted
      () => false,
    );
    // No violations — the fixture exists, the path/ID kind agrees, and
    // the in-file finding_id matches the trailer ID.
    assert.strictEqual(
      violations.length,
      0,
      `expected zero violations on the ARIA finding routing happy path, got: ${JSON.stringify(violations)}`,
    );
  } finally {
    rmSync(FIXTURE_FINDINGS_DIR, { recursive: true, force: true });
  }
});

void test('validateCommit: ARIA path with non-ARIA ID is rejected', () => {
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

void test('validateCommit: aria-findings path with DEBT-style ID is rejected', () => {
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

void test('validateCommit: registry trailer still routes to registry (not ARIA)', () => {
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

// ---------------------------------------------------------
// Plan 018 Phase 4 — Closes-trailer ID-content cross-check (G5)
// ---------------------------------------------------------
//
// Earlier gates (trailer regex, existsSync, ARIA path/ID kind agreement)
// all pass on a smuggled trailer like
//   `Closes: aria-findings/F-001.json#F-002`
// because the file exists, the path is aria-findings/, and the trailer ID
// is F-NNN-shaped. Plan 017 Phase 1.1 only added the structural checks;
// the audit caught that no gate parsed the file content. These tests pin
// the new ID-vs-content match, mismatch, and unreadable-file lanes.

void test('validateCommit: ARIA finding trailer with matching finding_id passes ID cross-check', () => {
  // Setup: write a fixture file with finding_id=F-901 at a real on-disk
  // path under aria-findings/.test-fixtures/. The validator reads the
  // file, parses it, and compares the in-file finding_id to the trailer
  // ID — equality means no ID-content violation surfaces.
  mkdirSync(FIXTURE_FINDINGS_DIR, { recursive: true });
  const fixturePath = resolve(FIXTURE_FINDINGS_DIR, 'F-901.json');
  writeFileSync(
    fixturePath,
    JSON.stringify({ finding_id: 'F-901', severity: 'LOW', status: 'OPEN' }, null, 2),
  );
  try {
    const commit: Commit = {
      sha: 'abc123',
      shortSha: 'abc123',
      subject: 'feat(aria-kernel): id-match',
      body: 'body\n\nCloses: aria-findings/.test-fixtures/F-901.json#F-901',
    };
    const violations = validateCommit(commit, new Set(), new Set(), () => false);
    // No violations — the file exists, the path/ID kind agrees, and the
    // in-file finding_id matches the trailer ID.
    assert.strictEqual(
      violations.length,
      0,
      `expected zero violations on ID match, got: ${JSON.stringify(violations)}`,
    );
  } finally {
    rmSync(FIXTURE_FINDINGS_DIR, { recursive: true, force: true });
  }
});

void test('validateCommit: ARIA finding trailer with mismatched finding_id fires ID cross-check violation', () => {
  // Setup: write a fixture file with finding_id=F-901 but craft a trailer
  // claiming F-902. Earlier structural gates pass (file exists, path is
  // aria-findings/, ID is F-NNN); the new ID-content check fires.
  mkdirSync(FIXTURE_FINDINGS_DIR, { recursive: true });
  const fixturePath = resolve(FIXTURE_FINDINGS_DIR, 'F-901.json');
  writeFileSync(
    fixturePath,
    JSON.stringify({ finding_id: 'F-901', severity: 'LOW', status: 'OPEN' }, null, 2),
  );
  try {
    const commit: Commit = {
      sha: 'abc123',
      shortSha: 'abc123',
      subject: 'feat(aria-kernel): id-mismatch',
      body: 'body\n\nCloses: aria-findings/.test-fixtures/F-901.json#F-902',
    };
    const violations = validateCommit(commit, new Set(), new Set(), () => false);
    const idMismatch = violations.find((v) =>
      /ARIA file's finding_id \(F-901\) does not match trailer ID \(F-902\)/.test(v.reason),
    );
    assert.notStrictEqual(
      idMismatch,
      undefined,
      `expected ID mismatch violation, got: ${JSON.stringify(violations)}`,
    );
  } finally {
    rmSync(FIXTURE_FINDINGS_DIR, { recursive: true, force: true });
  }
});

void test('validateCommit: ARIA debt trailer with malformed JSON fires unreadable violation', () => {
  // Setup: write a non-JSON file at a debt path. Earlier structural gates
  // pass (file exists, path is aria-debts/, ID is DEBT-shaped); the new
  // unreadable lane fires.
  mkdirSync(FIXTURE_DEBTS_DIR, { recursive: true });
  const fixturePath = resolve(FIXTURE_DEBTS_DIR, 'DEBT-2026-05-07-901.json');
  writeFileSync(fixturePath, 'this is not valid json {[');
  try {
    const commit: Commit = {
      sha: 'abc123',
      shortSha: 'abc123',
      subject: 'feat(aria-kernel): malformed-json',
      body: 'body\n\nCloses: aria-debts/.test-fixtures/DEBT-2026-05-07-901.json#DEBT-2026-05-07-901',
    };
    const violations = validateCommit(commit, new Set(), new Set(), () => false);
    const unreadable = violations.find((v) =>
      /ARIA file unreadable \(JSON parse failed/.test(v.reason),
    );
    assert.notStrictEqual(
      unreadable,
      undefined,
      `expected unreadable violation, got: ${JSON.stringify(violations)}`,
    );
  } finally {
    rmSync(FIXTURE_DEBTS_DIR, { recursive: true, force: true });
  }
});

void test('readAriaArtifactId returns finding_id for aria-findings/ path', () => {
  // Direct unit-level coverage of the new helper.
  mkdirSync(FIXTURE_FINDINGS_DIR, { recursive: true });
  const fixturePath = resolve(FIXTURE_FINDINGS_DIR, 'F-902.json');
  writeFileSync(fixturePath, JSON.stringify({ finding_id: 'F-902' }));
  try {
    const result = readAriaArtifactId(fixturePath, 'aria-findings/.test-fixtures/F-902.json');
    assert.deepStrictEqual(result, { kind: 'ok', value: 'F-902' });
  } finally {
    rmSync(FIXTURE_FINDINGS_DIR, { recursive: true, force: true });
  }
});
