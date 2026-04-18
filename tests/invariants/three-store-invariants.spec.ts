/**
 * Three-Store Invariants
 * ============================================================================
 *
 * Phase 4 + Phase 12.1 joint deliverable of
 * docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md.
 *
 * Enforces 3-way hash/ID consistency across the three sources of truth
 * for review findings:
 *
 *   1. `docs/reviews/_registry/findings.jsonl` (the ledger)
 *      — hash-chained append-only log. The `finding-registry-integrity`
 *        spec already verifies chain integrity internally; this spec
 *        treats it as authoritative for (state, closing_commits,
 *        review_file, id) tuples.
 *
 *   2. Merged-commit `Closes:` trailers (implementation evidence)
 *      — every RESOLVED finding's recorded `closing_commits` SHAs
 *        MUST exist in git history AND the commit message MUST
 *        contain a `Closes:` trailer that references the finding id.
 *
 *   3. Review files under `docs/reviews/` (evidence trail)
 *      — the `review_file` path recorded against each finding must
 *        exist on disk AND contain the finding's id as an anchor.
 *
 * When Phase 12.1 lands the PostgreSQL `event_store.findings` table,
 * this spec pivots to sourcing the ledger from the table (configured
 * via env var, jsonl remains the mirror for workstation tooling).
 *
 * # Why this spec exists
 *
 * Without cross-store verification the three artefacts drift. Drift
 * is not caught by any individual invariant:
 *
 *   - finding-registry-integrity checks the jsonl in isolation.
 *   - commit-msg-validator checks trailer shape, not ID validity.
 *   - review files are free-form markdown; nothing enforces the
 *     existence of the anchor a registry entry references.
 *
 * The failure mode this prevents: someone marks a finding RESOLVED
 * in the jsonl with a `closing_commits` SHA, but the SHA's commit
 * message has no matching `Closes:` trailer (or the trailer was
 * mangled by a rebase/squash), or the review file referenced by
 * `review_file` was renamed without updating the registry. Silent
 * drift of audit state.
 *
 * Plan ref: docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#12.1
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, '..', '..');
const REGISTRY_PATH = resolve(REPO_ROOT, 'docs/reviews/_registry/findings.jsonl');

interface Finding {
  id: string;
  severity: string;
  state: string;
  title: string;
  layer: number;
  owner_agent: string;
  raised_in_cycle: string;
  review_file?: string;
  created_at: string;
  closed_at: string | null;
  closing_commits: string[];
  evidence?: string[];
  rule_violated?: string;
  deadline: string | null;
  owner_user: string | null;
  override_of: string | null;
  notes?: string;
  prev_hash: string;
  content_hash: string;
}

function loadRegistry(): Finding[] {
  if (!existsSync(REGISTRY_PATH)) return [];
  const raw = readFileSync(REGISTRY_PATH, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Finding);
}

function commitExists(sha: string): boolean {
  try {
    execSync(`git cat-file -e ${sha}^{commit}`, { cwd: REPO_ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function commitMessage(sha: string): string {
  try {
    return execSync(`git log -1 --format=%B ${sha}`, { cwd: REPO_ROOT, encoding: 'utf8' });
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Known legacy drift (explicit allowlist — do not grow)
// ---------------------------------------------------------------------------
//
// Each entry documents a pre-Phase-6 drift the Phase 12.1 registry
// migration cleans up. The invariant stays STRICT for every
// non-allowlisted (finding-id, sha) pair — new fix commits MUST carry
// canonical `Closes: … #{PREFIX}-{SEVERITY}-{NNN}` trailers and the
// registry MUST cite existing anchors.
//
// Remediation path: Phase 12.1 migrates the jsonl ledger into the
// event_store.findings PostgreSQL table. The migration runs a
// re-annotation pass that rewrites these entries' closing_commits
// to include the strict ID form as a synthetic reference column, and
// appends the canonical anchor to the review file (an amendment, not
// a rebase of merged commits). Each allowlist entry carries a
// `// PHASE-12.1-FIX:` comment describing the remediation step.
//
// Do not add new entries without an accompanying plan item. Drift
// introduced AFTER Phase 12.1 is a strict test failure.

/** (finding-id, short-sha) pairs whose trailer pre-dates strict ID form. */
const LEGACY_TRAILER_DRIFT: ReadonlyArray<[string, string]> = [
  // P0-HIGH-005: commit b907c235 used short-form "P0-5" trailer.
  // PHASE-12.1-FIX: re-annotate registry entry with canonical trailer.
  ['P0-HIGH-005', 'b907c235'],
  // P0-HIGH-005: commit eb9f4f9d used "Closes portion of:" phrase
  // instead of strict "Closes:" prefix.
  // PHASE-12.1-FIX: re-annotate registry entry.
  ['P0-HIGH-005', 'eb9f4f9d'],
  // P0-HIGH-002: both closing commits pre-date strict ID form.
  // PHASE-12.1-FIX: re-annotate both commits.
  ['P0-HIGH-002', '32839e24'],
  ['P0-HIGH-002', '2dd09f99'],
  // P0-HIGH-003: same as P0-HIGH-002.
  ['P0-HIGH-003', '32839e24'],
  ['P0-HIGH-003', '2dd09f99'],
  // P0-MEDIUM-004: same as P0-HIGH-002.
  ['P0-MEDIUM-004', '32839e24'],
  ['P0-MEDIUM-004', '2dd09f99'],
  // P0-CRITICAL-001: used short-form anchor in Closes:.
  ['P0-CRITICAL-001', '32839e24'],
  // P0-HIGH-006: closing commit predates the canonical trailer shape.
  ['P0-HIGH-006', 'f931f935'],
  // P0-HIGH-007: closing commit uses legacy trailer form.
  ['P0-HIGH-007', '87ff9d1f'],
  // PROC-MEDIUM-001: closed by commit 47bea207 which predates strict
  // trailer discipline. PHASE-12.1-FIX: registry re-annotation.
  ['PROC-MEDIUM-001', '47bea207'],
  // FE-CRITICAL-001: 6 closing commits from the Phase 8.4 bare-queryKey
  // mass migration (506 sites across 57 web/modules + 27 web/apps/aquamobil
  // files). 955c8caa uses a legacy "Closes: … #P0-1" trailer (the
  // cross-tenant leak was originally tracked under the P0 finding ID
  // before the frontend-expert audit promoted it to FE-CRITICAL-001).
  // The five subsequent migration commits were part of a rolling fix
  // window that pre-dated the strict-trailer-per-commit discipline.
  // PHASE-12.1-FIX: re-annotate the registry with synthetic canonical
  // trailer references; commits themselves stay as-is.
  ['FE-CRITICAL-001', '955c8caa'],
  ['FE-CRITICAL-001', 'cbbd9624'],
  ['FE-CRITICAL-001', 'bcb9f38a'],
  ['FE-CRITICAL-001', 'a2a345db'],
  ['FE-CRITICAL-001', '63879cb2'],
  ['FE-CRITICAL-001', 'a495bc1e'],
];

const LEGACY_DRIFT_SET: ReadonlySet<string> = new Set(
  LEGACY_TRAILER_DRIFT.map(([id, sha]) => `${id}::${sha}`),
);

/**
 * Registry entries whose `closing_commits` is empty despite state=RESOLVED.
 *
 * These were closed as part of Phase 2 gate-work shakedown — the
 * remediation amended the gate implementations in multiple commits but
 * the registry was updated to RESOLVED without cherry-picking every SHA.
 * PHASE-12.1-FIX: the jsonl → PG migration walks the git log,
 * identifies commits whose `Closes:` trailer matches each entry's id,
 * and backfills `closing_commits`.
 */
const LEGACY_EMPTY_CLOSERS: ReadonlySet<string> = new Set([
  'PROC-MEDIUM-002',
  'PROC-MEDIUM-003',
  'PROC-MEDIUM-004',
]);

/**
 * Registry entries whose `review_file` does NOT contain the finding id
 * verbatim. These were added to the registry by a later session that
 * did not back-annotate the earlier review file.
 * PHASE-12.1-FIX: migration pass appends the anchor to the review file.
 */
const LEGACY_MISSING_ANCHORS: ReadonlySet<string> = new Set([
  'COMPLIANCE-CRITICAL-001',
  // PROC-* findings are orchestrator process-findings added by
  // self-audit dog-food; they reference the main audit file but were
  // not back-annotated with a section.
  // PHASE-12.1-FIX: migration appends a ## Process Findings section to
  // 2026-04-16-v2-audit.md with each PROC-* anchor.
  'PROC-MEDIUM-001',
  'PROC-MEDIUM-002',
  'PROC-MEDIUM-003',
  'PROC-MEDIUM-004',
  // DEPLOY-* findings reference a separate infra-expert review file
  // that exists but does not name the finding id in its prose.
  // PHASE-12.1-FIX: back-annotate the review file.
  'DEPLOY-HIGH-001',
  'DEPLOY-HIGH-002',
]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('three-store invariants', () => {
  const entries = loadRegistry();

  it('registry is non-empty (otherwise nothing to cross-check)', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  describe('store-2: commit trailers match registry', () => {
    const resolved = entries.filter((e) => e.state === 'RESOLVED');

    it('every RESOLVED finding has at least one closing_commits entry (legacy-allowlisted exceptions permitted)', () => {
      for (const e of resolved) {
        if (LEGACY_EMPTY_CLOSERS.has(e.id)) continue;
        if (e.closing_commits.length === 0) {
          throw new Error(
            `Finding ${e.id} is RESOLVED but has empty closing_commits. ` +
              `Either add the SHA(s) of the commit(s) that closed it, or ` +
              `add the id to LEGACY_EMPTY_CLOSERS with a PHASE-12.1-FIX comment.`,
          );
        }
      }
    });

    it('every closing_commits SHA exists in git history', () => {
      for (const e of resolved) {
        for (const sha of e.closing_commits) {
          // Skip "pending" placeholder SHAs used during draft-state
          // registry edits that haven't been rechained yet.
          if (sha === 'pending' || sha.length < 7) continue;
          if (!commitExists(sha)) {
            throw new Error(
              `Registry entry ${e.id} references closing_commit SHA ${sha} which is NOT in git history. ` +
                `Either the commit was lost (rebase?) or the SHA is stale.`,
            );
          }
        }
      }
    });

    it('every closing_commits SHA\'s message contains a Closes: trailer referencing the finding id', () => {
      for (const e of resolved) {
        for (const sha of e.closing_commits) {
          if (sha === 'pending' || sha.length < 7) continue;
          if (!commitExists(sha)) continue; // Reported by prior test.

          // Legacy drift allowlist (specific (finding-id, sha) pair).
          if (LEGACY_DRIFT_SET.has(`${e.id}::${sha}`)) continue;

          const msg = commitMessage(sha);
          // Accept either:
          //   Closes: ...#<finding-id>            (anchor reference)
          //   Closes: <finding-id>                (bare reference)
          //   Closes: BACKLOG-<word>              (legacy backlog reference,
          //                                        registry cross-listed)
          const idPattern = e.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const closesRx = new RegExp(
            `^Closes:\\s+.*\\b(${idPattern}|BACKLOG-[A-Z0-9_-]+)\\b`,
            'm',
          );
          if (!closesRx.test(msg)) {
            throw new Error(
              `Finding ${e.id} claims SHA ${sha} as a closer but the commit message has no matching Closes: trailer. ` +
                `Either fix the Closes: trailer (requires rebase/amend on an unmerged commit), update the registry entry, ` +
                `or add the SHA to PRE_STRICT_TRAILER_SHAS only if it genuinely pre-dates the strict-ID era.`,
            );
          }
        }
      }
    });
  });

  describe('store-3: review files exist + contain finding anchors', () => {
    const withReviewFile = entries.filter((e) => e.review_file);

    it('every review_file path exists on disk', () => {
      for (const e of withReviewFile) {
        const reviewPath = resolve(REPO_ROOT, e.review_file!);
        if (!existsSync(reviewPath)) {
          throw new Error(
            `Finding ${e.id} references review_file=${e.review_file} which does NOT exist on disk. ` +
              `Either the file was renamed (update the registry entry) or the reference is stale.`,
          );
        }
      }
    });

    it('every review_file contains the finding id OR a short-form anchor referring to it (legacy-allowlisted exceptions permitted)', () => {
      for (const e of withReviewFile) {
        if (LEGACY_MISSING_ANCHORS.has(e.id)) continue;
        const reviewPath = resolve(REPO_ROOT, e.review_file!);
        if (!existsSync(reviewPath)) continue; // Reported by prior test.
        const content = readFileSync(reviewPath, 'utf8');

        // Accept either full-id anchor (canonical) or short-form anchor
        // for pre-Phase-6 seed findings. Registry re-annotation under
        // Phase 12.1 collapses these to canonical.
        const shortForm = e.id.match(/^P0-(?:CRITICAL|HIGH|MEDIUM|LOW)-0*(\d+)$/);
        const shortAnchor = shortForm ? `P0-${shortForm[1]}` : null;

        const hasFullId = content.includes(e.id);
        const hasShort = shortAnchor !== null && content.includes(shortAnchor);

        if (!hasFullId && !hasShort) {
          throw new Error(
            `Finding ${e.id} references review_file=${e.review_file} but the file does NOT contain ${e.id}` +
              (shortAnchor ? ` or ${shortAnchor}` : '') +
              ` anywhere. ` +
              `The review document should cite the finding id verbatim so readers can cross-reference.`,
          );
        }
      }
    });
  });

  describe('schema compliance', () => {
    it('every entry has the required fields for cross-store traceability', () => {
      const required: readonly (keyof Finding)[] = [
        'id',
        'severity',
        'state',
        'owner_agent',
        'raised_in_cycle',
        'created_at',
        'closing_commits',
        'prev_hash',
        'content_hash',
      ];
      for (const e of entries) {
        for (const key of required) {
          expect(e[key]).toBeDefined();
        }
      }
    });
  });
});
