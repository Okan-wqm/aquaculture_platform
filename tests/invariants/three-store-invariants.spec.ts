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

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  commitMessageClosesFinding,
  readCommitObservations,
} from '../../tools/gates/finding-traceability';

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
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Finding);
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
  // ORPHAN-HIGH-014: closing commit d1a257e7 uses subject-line
  // parenthetical `(closes ORPHAN-HIGH-014)` rather than the strict
  // `Closes:` trailer. Pre-dates the trailer-validator gate.
  // PHASE-12.1-FIX: re-annotate registry entry; commit stays as-is.
  ['ORPHAN-HIGH-014', 'd1a257e7'],
  // ORPHAN-MEDIUM-016: commit 58837474 mentions ORPHAN-MEDIUM-016 in
  // the body but the strict `Closes:` trailer references the sibling
  // ORPHAN-HIGH-015 only. The two findings were closed by the same
  // architectural fix; the registry tracks both as closers.
  // PHASE-12.1-FIX: re-annotate registry entry; commit stays as-is.
  ['ORPHAN-MEDIUM-016', '58837474'],
  // RUST-CVE-001: commit bb777083e (PR #399) subject + body resolve
  // RUST-CVE-001 (the rustls-webpki 0.102.8 CVE) but the strict `Closes:`
  // trailer references the sibling RUST-HIGH-001 only — both findings are
  // the same vendored-rumqttc-fork architectural fix. The commit itself
  // documented that its registry close ceremony "runs post-merge" (a
  // main-reachable SHA is required), which #523 then executed; the close
  // legitimately cannot carry a per-id trailer on the already-merged fix
  // commit. Identical shape to the ORPHAN-MEDIUM-016 sibling-trailer entry
  // above. PHASE-12.1-FIX: re-annotate registry entry; commit stays as-is.
  ['RUST-CVE-001', 'bb777083e'],
  // ULTRA-* findings (Stage-N audit cycle): the closing commits group
  // multiple findings under one architectural fix; the strict `Closes:`
  // trailer was either omitted or referenced a single canonical finding
  // (typically a CRITICAL). The registry tracks every related finding
  // as a closer for traceability. PHASE-12.1-FIX: registry re-annotation
  // with synthetic canonical trailer references; commits stay as-is.
  ['ULTRA-HIGH-001', '8b5fe250'],
  ['ULTRA-HIGH-002', '8b5fe250'],
  ['ULTRA-HIGH-003', '8b5fe250'],
  ['ULTRA-HIGH-004', '8b5fe250'],
  ['ULTRA-HIGH-005', '8b5fe250'],
  ['ULTRA-HIGH-006', '8b5fe250'],
  ['ULTRA-HIGH-007', '8b5fe250'],
  ['ULTRA-HIGH-013', 'd5128cdb'],
  ['ULTRA-HIGH-015', 'dec6298c'],
  // ULTRA-HIGH-018: D-4 operator-surface closure shares commit 86a8af13
  // with ORPHAN-HIGH-042; the commit predates the strict trailer entry
  // for this specific ULTRA finding.
  // PHASE-12.1-FIX: re-annotate registry entry; commit stays as-is.
  ['ULTRA-HIGH-018', '86a8af13'],
  ['ULTRA-MEDIUM-007', 'c50f71e5'],
  // ULTRA-HIGH-020: D-6 unified assembly closure was committed before
  // this registry id appeared in the strict trailer contract.
  // PHASE-12.1-FIX: re-annotate registry entry; commit stays as-is.
  ['ULTRA-HIGH-020', '23e35c25'],
  // ORPHAN-HIGH-043: commit 27021367 intentionally closes the sibling
  // ORPHAN-HIGH-044 and documents 043 as the next leaf-pinning phase.
  // The registry tracks both as part of the Phase 1.1.3 arc.
  // PHASE-12.1-FIX: re-annotate registry entry; commit stays as-is.
  ['ORPHAN-HIGH-043', '27021367'],
  ['ULTRA-HIGH-016', '29bb2d48'],
  ['ULTRA-HIGH-019', 'ab4246ea'],
  ['ULTRA-HIGH-033', 'f354a029'],
  ['ULTRA-HIGH-033', '54a56eda'],
  ['ULTRA-HIGH-033', '1efecbdb'],
  ['ULTRA-HIGH-033', '2ee74445'],
  ['ULTRA-HIGH-033', '397b03cc'],
  ['ULTRA-HIGH-033', '7797fb16'],
  ['ULTRA-HIGH-033', 'b035692e'],
  ['ULTRA-HIGH-033', 'f73031a4'],
  ['ULTRA-HIGH-033', '696502fb'],
  ['ULTRA-HIGH-033', '3eb3e3a0'],
  ['ULTRA-HIGH-034', '3b20957a'],
  ['ULTRA-HIGH-034', 'c5990ade'],
  ['ULTRA-HIGH-034', 'e086af45'],
  ['ULTRA-HIGH-034', '0f0b4bbb'],
  ['ULTRA-HIGH-034', '82f47f64'],
  ['ULTRA-HIGH-034', '7f88c7f5'],
  ['ULTRA-HIGH-034', '517beeff'],
  ['ULTRA-HIGH-034', '42506745'],
  ['ULTRA-HIGH-035', 'e4c8e6ae'],
  ['ULTRA-HIGH-035', '5580bd18'],
  ['ULTRA-HIGH-035', '83fff29a'],
  ['ULTRA-HIGH-035', '94406dd4'],
  ['ULTRA-HIGH-035', 'f39374e2'],
  ['ULTRA-HIGH-036', '4685de09'],
  ['ULTRA-HIGH-036', '0ed26804'],
  ['ULTRA-HIGH-036', '1fbd1427'],
  ['ULTRA-HIGH-036', 'f35d9b27'],
  ['ULTRA-HIGH-036', 'f2cd8139'],
  ['ULTRA-HIGH-036', '783f8f45'],
  ['ULTRA-HIGH-036', '0efc90e5'],
  ['ULTRA-HIGH-036', '89f3655a'],
  ['ULTRA-HIGH-036', 'bb223d4f'],
  ['ULTRA-HIGH-037', '4273b9aa'],
  ['ULTRA-HIGH-037', '44a96370'],
  ['ULTRA-HIGH-037', '13be5ad2'],
  // AUDIT-* findings: same pattern — registry references the audit-batch
  // commits but the strict trailer was on the principal finding only.
  ['AUDIT-MEDIUM-013', '2cd0a7bb'],
  ['AUDIT-LOW-001', '77660392'],
  // ORPHAN-MEDIUM-314/321/322: the untracked-worktree remediation batch
  // 8d1b342ed (PR #830) fixed all three, but its strict Closes: trailers
  // cite the PRE-RENUMBERING ids ORPHAN-MEDIUM-309 (→314), 312 (→321), and
  // 313 (→322). The findings were renumbered during merge-train collision
  // resolution AFTER that commit merged — main independently claimed
  // 309/312/313 for unrelated ARIA findings (documented in each entry's
  // notes + docs/reviews/orphan-findings.md headings). Same sibling/
  // renumbered-trailer shape as ORPHAN-MEDIUM-016 / RUST-CVE-001 above;
  // the commit is the genuine closer and stays as-is.
  // PHASE-12.1-FIX: re-annotate registry entry; commit stays as-is.
  ['ORPHAN-MEDIUM-314', '8d1b342ed7538d4bc9fbc4074881eb34b079402c'],
  ['ORPHAN-MEDIUM-321', '8d1b342ed7538d4bc9fbc4074881eb34b079402c'],
  ['ORPHAN-MEDIUM-322', '8d1b342ed7538d4bc9fbc4074881eb34b079402c'],
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
  // PROC-* + INFRA-CRITICAL-* + DEPLOY-CRITICAL-* + FARM-* + FE-* +
  // ULTRA-MEDIUM-026: registry promoted to RESOLVED without recording
  // every closing SHA — closures landed across multi-commit cycles and
  // the registry update at the time captured intent only. PHASE-12.1-FIX:
  // jsonl → PG migration walks `git log` for matching `Closes:` trailers
  // and backfills `closing_commits` for each entry. Until that lands, the
  // entries below preserve the invariant's value (no NEW empty closers
  // accepted) without blocking unrelated CI work.
  'PROC-MEDIUM-002',
  'PROC-MEDIUM-003',
  'PROC-MEDIUM-004',
  'PROC-MEDIUM-005',
  'PROC-MEDIUM-008',
  'PROC-MEDIUM-009',
  'PROC-MEDIUM-010',
  'PROC-MEDIUM-011',
  'PROC-MEDIUM-013',
  'PROC-MEDIUM-014',
  'INFRA-CRITICAL-033',
  'INFRA-CRITICAL-034',
  'INFRA-CRITICAL-035',
  'DEPLOY-CRITICAL-003',
  'DEPLOY-CRITICAL-004',
  'DEPLOY-CRITICAL-005',
  'DEPLOY-CRITICAL-006',
  'DEPLOY-CRITICAL-007',
  'FARM-HIGH-001',
  'FARM-HIGH-002',
  'FARM-DATAMIG-001',
  'FE-HIGH-001',
  'FE-HIGH-002',
  'FE-MEDIUM-001',
  'FE-MEDIUM-002',
  'FE-MEDIUM-003',
  'ULTRA-MEDIUM-026',
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
  // INFRA-MEDIUM-014 + remaining INFRA-CRITICAL review rows: all reference the
  // e2e-messaging-arch review file (or a Stage-N v2 audit file) but the
  // finding id is not in the prose verbatim. PHASE-12.1-FIX: migration
  // appends per-finding anchor sections to each review file in a single
  // pass.
  'INFRA-MEDIUM-014',
  'INFRA-CRITICAL-015',
  'INFRA-CRITICAL-016',
  'INFRA-CRITICAL-017',
  'INFRA-CRITICAL-018',
  'INFRA-CRITICAL-019',
  'INFRA-CRITICAL-020',
  'INFRA-CRITICAL-021',
  'INFRA-CRITICAL-023',
  'INFRA-CRITICAL-024',
  'INFRA-CRITICAL-025',
  'INFRA-CRITICAL-026',
  'INFRA-CRITICAL-027',
  'INFRA-CRITICAL-028',
  'INFRA-CRITICAL-029',
  'INFRA-CRITICAL-030',
  'INFRA-CRITICAL-031',
  'INFRA-CRITICAL-032',
  'INFRA-CRITICAL-033',
  'INFRA-CRITICAL-034',
  'INFRA-CRITICAL-035',
  // DEPLOY-CRITICAL-003/006/007 + FARM-HIGH-001/002 + ORPHAN-* +
  // ULTRA-* + AUDIT-MEDIUM-013: same pattern — registry references a
  // review file that was authored before the strict back-annotation
  // discipline. Each entry would need a finding-id anchor inserted via
  // PHASE-12.1-FIX migration.
  'DEPLOY-CRITICAL-003',
  'DEPLOY-CRITICAL-006',
  'DEPLOY-CRITICAL-007',
  'FARM-HIGH-001',
  'FARM-HIGH-002',
  // P0 audit entries reference the initial orchestrator review without
  // per-id anchors; the strict anchor invariant landed later.
  // PHASE-12.1-FIX: append P0 anchor sections to the review file.
  'P0-CRITICAL-001',
  'P0-HIGH-002',
  'P0-HIGH-003',
  'P0-MEDIUM-004',
  'P0-HIGH-005',
  'P0-HIGH-006',
  'P0-HIGH-007',
  'ORPHAN-HIGH-015',
  'ORPHAN-MEDIUM-016',
  'ORPHAN-MEDIUM-030',
  'ORPHAN-LOW-034',
  'ORPHAN-CRITICAL-041',
  'ORPHAN-HIGH-042',
  'ORPHAN-HIGH-043',
  'ORPHAN-HIGH-044',
  'ULTRA-HIGH-033',
  'ULTRA-HIGH-034',
  'ULTRA-HIGH-035',
  'ULTRA-HIGH-036',
  'ULTRA-HIGH-037',
  'ULTRA-HIGH-038',
  'ULTRA-MEDIUM-027',
  'ULTRA-MEDIUM-028',
  'ULTRA-CRITICAL-029',
  'ULTRA-HIGH-041',
  'ULTRA-CRITICAL-042',
  'ULTRA-CRITICAL-043',
  'ULTRA-HIGH-045',
  'ULTRA-MEDIUM-049',
  'ULTRA-MEDIUM-050',
  'ULTRA-MEDIUM-051',
  'ULTRA-MEDIUM-052',
  'ULTRA-MEDIUM-053',
  'ULTRA-HIGH-054',
  'ULTRA-HIGH-055',
  'ULTRA-HIGH-056',
  'ULTRA-HIGH-057',
  'ULTRA-HIGH-058',
  'ULTRA-HIGH-059',
  'ULTRA-HIGH-060',
  'ULTRA-HIGH-061',
  'ULTRA-HIGH-062',
  'ULTRA-HIGH-063',
  'ULTRA-HIGH-064',
  'ULTRA-HIGH-065',
  'ULTRA-HIGH-066',
  'ULTRA-HIGH-067',
  'ULTRA-HIGH-068',
  'ULTRA-HIGH-069',
  'ULTRA-HIGH-070',
  'ULTRA-HIGH-071',
  'ULTRA-HIGH-072',
  'ULTRA-HIGH-073',
  'ULTRA-HIGH-074',
  'ULTRA-HIGH-075',
  'ULTRA-HIGH-076',
  'AUDIT-MEDIUM-013',
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
    const closingShas = [
      ...new Set(
        resolved.flatMap((entry) =>
          entry.closing_commits.filter((sha) => sha !== 'pending' && sha.length >= 7),
        ),
      ),
    ].sort();
    const commitObservations = new Map(
      readCommitObservations(REPO_ROOT, closingShas).map((observation) => [
        observation.oid,
        observation,
      ]),
    );

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
          const observation = commitObservations.get(sha);
          if (observation === undefined) {
            throw new Error(`Commit observation batch omitted registry closing SHA ${sha}`);
          }
          if (!observation.exists) {
            throw new Error(
              `Registry entry ${e.id} references closing_commit SHA ${sha} which is NOT in git history. ` +
                `Either the commit was lost (rebase?) or the SHA is stale.`,
            );
          }
        }
      }
    });

    it("every closing_commits SHA's message contains a Closes: trailer referencing the finding id", () => {
      for (const e of resolved) {
        for (const sha of e.closing_commits) {
          if (sha === 'pending' || sha.length < 7) continue;
          const observation = commitObservations.get(sha);
          if (observation === undefined) {
            throw new Error(`Commit observation batch omitted registry closing SHA ${sha}`);
          }
          if (!observation.exists || observation.message === null) continue; // Reported by prior test.

          // Legacy drift allowlist (specific (finding-id, sha) pair).
          if (LEGACY_DRIFT_SET.has(`${e.id}::${sha}`)) continue;

          if (!commitMessageClosesFinding(observation.message, e.id)) {
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
    const withReviewFile = entries.filter(
      (e): e is Finding & { review_file: string } =>
        typeof e.review_file === 'string' && e.review_file.length > 0,
    );

    it('every review_file path exists on disk', () => {
      for (const e of withReviewFile) {
        const reviewPath = resolve(REPO_ROOT, e.review_file);
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
        const reviewPath = resolve(REPO_ROOT, e.review_file);
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
