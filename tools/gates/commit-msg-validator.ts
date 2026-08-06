#!/usr/bin/env ts-node
/**
 * Commit-msg validator gate — Phase 2 of
 * /root/.claude/plans/abstract-brewing-mochi.md (also tracked as
 * docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#Phase-2).
 *
 * Enforces CLAUDE.md "Review Finding Traceability" rule across three
 * invocation surfaces:
 *
 *   1. Commit-msg hook  — fires on every local `git commit` BEFORE the
 *      commit object is written; gets the prepared message file and
 *      refuses fix/security/refactor(agentic,phase-*) commits that lack a
 *      `Closes: docs/reviews/<agent>/<date>-<topic>.md#<FINDING-ID>`
 *      trailer pointing to an existing review file and a registered
 *      finding ID.
 *   2. Range mode       — CI PR gate: walks every commit between base
 *      and head, enforces the same rule, tolerates commits enumerated
 *      in PRE_PHASE6_SHAS (commits that landed before the registry
 *      existed and cannot be amended under the force-push ban).
 *   3. Last-commit mode — local smoke test / post-commit sanity.
 *
 * Promoted 1:1 from tools/scripts/validate-closes-footer.mjs; the
 * commit-msg mode is new so pre-commit hook coverage becomes symmetric
 * with the banned-phrase gate (they run from the same husky plumbing).
 *
 * Usage:
 *   ts-node tools/gates/commit-msg-validator.ts --mode=msg-file <path>   # husky commit-msg hook
 *   ts-node tools/gates/commit-msg-validator.ts --mode=range <base> <head>  # CI PR range check
 *   ts-node tools/gates/commit-msg-validator.ts --mode=commit             # last commit body (smoke)
 *
 * Exit codes:
 *   0 — clean
 *   1 — violation detected
 *   2 — usage error
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ORPHAN_MD_HEADING_REGEX, readOrphanMarkdownStore } from './finding-registry-store';

// Resolve repo root via `git rev-parse --show-toplevel`
// (Batch #349) — switched away from
// `dirname(fileURLToPath(import.meta.url))` because the
// `import.meta` reference forced Node to load this file
// as ESM at the import time of `commit-msg-validator.spec.ts`,
// which then conflicted with ts-node's CommonJS
// compilation of the spec file ("ReferenceError: exports
// is not defined in ES module scope"). The git-rev-parse
// pattern is CommonJS-clean + already used by
// `tools/gates/clippy-affected.ts` (Batch #343); standardizing
// removes the ESM/CommonJS interop trap from the test
// surface.
const REPO_ROOT = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return process.cwd();
  }
})();
const REGISTRY_PATH = resolve(REPO_ROOT, 'docs', 'reviews', '_registry', 'findings.jsonl');

function writeStdout(message = ''): void {
  process.stdout.write(`${message}\n`);
}

function writeStderr(message = ''): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Conventional-commit subject prefixes that REQUIRE a Closes: trailer.
 *
 *   fix()                         — closes a bug finding
 *   security()                    — closes a security finding
 *   refactor(agentic,phase-*)     — closes a plan-phase-scoped finding
 *   feat()                        — closes a feature-tracking finding
 *                                   (Batch #285 fix for ORPHAN-MEDIUM-025;
 *                                   pre-Batch-#285 feat commits bypassed
 *                                   the trailer check entirely, so 38
 *                                   feat batches in the 2026-04-25
 *                                   session shipped with dangling
 *                                   `Closes: ULTRA-HIGH-NNN` trailers
 *                                   pointing to unregistered IDs without
 *                                   the gate noticing — see
 *                                   ORPHAN-HIGH-024 + ORPHAN-MEDIUM-025).
 *
 * Architectural reasoning: every architectural change in this codebase
 * (whether bug-fix, security hardening, refactor, or new feature) MUST
 * be traceable to a finding in the registry. The
 * `Review Finding Traceability` discipline (CLAUDE.md) is universal —
 * the regex was historically narrow, this batch widens it to match.
 */
const REQUIRE_CLOSES_TYPES = /^(fix|security|refactor\(agentic,phase-|feat)/;

/** Hard format for the trailer; stricter than a free-text "closes" mention.
 *
 * ID alternation (in order):
 *   1. `<PREFIX>-(CRITICAL|HIGH|MEDIUM|LOW)-\d{3}` — registry / orphan IDs
 *      (UH-HIGH-001, ORPHAN-MEDIUM-032, etc.).
 *   2. `F-\d{3}` — ARIA finding IDs (e.g. F-001) under `aria-findings/`.
 *   3. `DEBT-\d{4}-\d{2}-\d{2}-\d{3}` — ARIA debt IDs (e.g.
 *      DEBT-2026-05-08-001) under `aria-debts/`.
 *
 * Routing based on path prefix happens in `validateCommit` so the gate
 * never fakes-validates an ARIA ID against the registry or vice versa.
 */
const CLOSES_TRAILER_REGEX =
  /^Closes:\s+(\S+?)#([A-Z][A-Z0-9]+-(?:CRITICAL|HIGH|MEDIUM|LOW)-\d{3}|F-\d{3}|F-AUTO-V\d+\.\d+(?:-[A-Z0-9-]+)+|DEBT-\d{4}-\d{2}-\d{2}-\d{3})\s*$/;

/** True when the path points at an ARIA-owned artifact (finding or debt). */
function isAriaArtifactPath(path: string): boolean {
  return path.startsWith('aria-findings/') || path.startsWith('aria-debts/');
}

/** True when the finding ID is an ARIA-owned ID.
 *
 * Accepted forms:
 *   - F-\d{3}  — canonical sequential allocator (e.g. F-018, F-022)
 *   - F-AUTO-V\d+\.\d+-{TOPIC}  — V10.5+ tracked-deferral findings
 *     pointing at a future sprint version (e.g. F-AUTO-V10.6-SELF-FEED).
 *     These carry owner+deadline+ID per CLAUDE.md §Architectural Approach
 *     and live under aria-findings/ alongside canonical findings.
 *   - DEBT-YYYY-MM-DD-NNN  — ARIA debt entries under aria-debts/
 */
function isAriaFindingId(id: string): boolean {
  return (
    /^F-\d{3}$/.test(id) ||
    /^F-AUTO-V\d+\.\d+(?:-[A-Z0-9-]+)+$/.test(id) ||
    /^DEBT-\d{4}-\d{2}-\d{2}-\d{3}$/.test(id)
  );
}

/**
 * Plan 018 Phase 4 (G5) — Closes-trailer ID-content cross-check.
 *
 * Reads the ARIA artifact JSON at `path` and returns the in-file ID field
 * value (`finding_id` for aria-findings/, `debt_id` for aria-debts/). The
 * caller compares the returned value against the trailer ID; a mismatch is
 * a smuggled-trailer attempt the validator must fail-closed on.
 *
 * Why a separate read here: the existsSync gate before us proves the JSON
 * file exists; the ARIA-shape pairing gate proves path-vs-ID kind agrees.
 * Neither catches a trailer like
 *   `Closes: aria-findings/F-001.json#F-002`
 * — the file exists, the path is aria-findings/, the ID is F-NNN, all
 * three structural gates pass, but the in-file `finding_id` is `F-001`
 * while the trailer claims `F-002`. The audit (Plan 018 G5 [MEDIUM])
 * caught this; the fix is to parse the JSON and compare the ID field.
 *
 * Returns `{ kind: 'ok', value }` on success, `{ kind: 'unreadable',
 * reason }` if the file cannot be parsed (syntax error, EOF, missing
 * field, wrong field type). The caller never silently falls through —
 * every error path emits an explicit ARIA violation with a distinct
 * message so operators can tell parse failure apart from mismatch.
 */
function readAriaArtifactId(
  absPath: string,
  path: string,
): { kind: 'ok'; value: string } | { kind: 'unreadable'; reason: string } {
  const expectedField = path.startsWith('aria-findings/') ? 'finding_id' : 'debt_id';
  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch (err) {
    return {
      kind: 'unreadable',
      reason: `ARIA file unreadable (${(err as Error).message})`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      kind: 'unreadable',
      reason: `ARIA file unreadable (JSON parse failed: ${(err as Error).message})`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return {
      kind: 'unreadable',
      reason: 'ARIA file unreadable (top-level value is not a JSON object)',
    };
  }
  const value = (parsed as Record<string, unknown>)[expectedField];
  if (typeof value !== 'string' || value.length === 0) {
    return {
      kind: 'unreadable',
      reason: `ARIA file unreadable (missing or non-string ${expectedField} field)`,
    };
  }
  return { kind: 'ok', value };
}

/**
 * Commits landed BEFORE the registry + this gate existed. Amending is
 * forbidden under the force-push ban, so these short SHAs are allow-
 * listed. Going forward, the set does not grow.
 *
 * Governed by P0-HIGH-005 (phantom infrastructure) retroactive amnesty —
 * captured in docs/reviews/_registry/findings.jsonl.
 */
const PRE_PHASE6_SHAS: ReadonlySet<string> = new Set([
  // Commits that landed BEFORE the registry was seeded OR used the old
  // short-form finding-ID format (e.g. `#P0-1` instead of the current
  // `#P0-CRITICAL-001`). Amending is forbidden under the force-push ban,
  // so these specific SHAs are allowlisted. The set is frozen — every new
  // commit is expected to carry a long-form `#PREFIX-SEVERITY-NNN`
  // trailer referencing a live registry entry.
  '32839e24', // Phase 0 audit close — pre-registry
  'f931f935', // Phase 0.1 agents-legacy archive — pre-registry
  '2dd09f99', // Phase 4 invariants — pre-registry
  'b907c235', // Phase 5 root-cause-auditor — pre-registry
  '71474fbf', // W2-E INFRA-1 backup SHA guard — pre-Phase-6 landing
  'fc00fc19', // W3-C follow-up eslint-plugin rename — pre-Phase-6 landing
  'c0e7d492', // W3-D backup-manifest-invariant CI gate — pre-Phase-6 landing
  '955c8caa', // Phase 8.4 queryKey ESLint rule — old `#P0-1` short-form trailer
  '973394b3', // Phase 11 platform-services split — old `#P0-5` short-form trailer
  'b403a4e5', // Snowball/main merge-reconciliation metadata fix — landed via PR #273; amending is forbidden
  // Faz 1 day-one baseline reset commits (PR #288) — plan-driven feat commits.
  // The plan (root local at /root/.claude/plans/peppy-crafting-waterfall.md) is
  // not on the docs/reviews/ path, so a registry-backed Closes: trailer is not
  // possible at the time of these commits. Subsequent chore(migration) commits
  // carry the spec-fix + this allowlist edit; full registry-backed trailers
  // resume from Faz 1.6 onward.
  'b5c46dbf', // Faz 1.2 + 1.4 invariants — protected-tables SSoT + SAVEPOINT ban
  'cf674bda', // Faz 1.9 + 1.10 — extensions + platform functions in init scripts
  '6228b244', // Faz 1.1 + 1.8 — atomic post-condition probe + FK presence drift class
  '2da8aaa7', // Faz 1.5 — SchemaVersionGate single authoritative runner cutover
  '99d29995', // Faz 2 — edge platform v2 sensor-service per-tenant (ADR-025)
  '6e9c3c14', // Faz 7 — ADR-030 + authoring runbook + drift-repair naming ban
  '2620e978', // Faz 3 live exec — 14 service baseline migrations consolidated
  '0f714656', // Faz 3.5 hand-author additions — RLS + audit immutability + sensor hypertable
  'f6dd9c97', // fix(migration): faz-6-preflight ESM-safe __dirname recovery
  '8fedf695', // fix(migration): preflight checks both src/migrations and src/database/migrations paths
  'a4ec8766', // fix(migration): post-Faz-6 invariant spec compatibility + .archive exclusion
  '1d87dd33', // fix(migration): wrap CREATE TYPE statements in DO/EXCEPTION block (R8 lint)
  '3f0cb24b', // fix(migration): farm baseline equipment_types CREATE TABLE inject + entity sync flag
  // PR #290 platform-bootstrap-atom — `f757b3ed` was merged to main but
  // never landed on migration branch directly; cherry-pick onto PR #290
  // produced a new SHA. The original commit's body referenced no
  // registry-backed finding (it landed as part of the Faz 6 cutover
  // sequence pre-orphan-findings cycle), so the long-form `Closes:`
  // trailer is structurally unavailable. Allowlist the cherry-pick SHA
  // so the validator does not block merge.
  '4b5174db', // fix(migration): replace archived migration imports with Baseline (3 services) — cherry-picked from f757b3ed
  // WASM-adoption feature commits whose Closes: trailers used a hyphenated
  // finding-ID prefix (SCADA-SANDBOX-*, CODEC-WASM-*) that fails the
  // CLOSES_TRAILER_REGEX PREFIX rule ([A-Z][A-Z0-9]+, no hyphen). The findings
  // are real (docs/reviews/claude/2026-07-13-*.md); only the trailer ID shape
  // was wrong. Amending is barred by the force-push ban, so these SHAs are
  // allowlisted. Later WASM-adoption commits use compliant ORPHAN-{SEV}-NNN IDs.
  'ad4a5d96', // security(scada-runtime): QuickJS-WASM SCADA script sandbox (Phase 1)
  'a238c98a', // feat(protocol-codec): compile the Modbus SSoT to wasm (Phase 2)
  // feat(lora) Phase 3: its Closes: trailer referenced ORPHAN-HIGH-378, which
  // independently landed on main (shared.user_permissions retirement) during
  // concurrent development. The branch finding was renumbered to ORPHAN-HIGH-382
  // on merge; the pushed commit's trailer cannot be amended (force-push ban).
  '5334a47a', // feat(lora): sandboxed wasm custom payload decoders (Phase 3)
  // ARIA-intelligence branches whose Closes: trailers referenced
  // ORPHAN-MEDIUM-552/553 minted concurrently with the #1084 line, which
  // claimed IDs 552-556 first. Both branch findings were renumbered
  // (552 -> 557, 553 -> 558) in the registry + orphan doc; the pushed
  // commits' trailers cannot be amended (force-push ban) — the identical
  // situation as the feat(lora) 378 -> 382 entry above.
  '4048a1cf', // feat(aria): let ARIA's own precision measurement change ARIA's behaviour (552 -> 557)
  'abe53cbf', // feat(aria): give the runtime-signal bridge a mouth and the delivery metrics their first rules (553 -> 558)
  // Second concurrent-allocation collision of this session. The sibling
  // session's registry ceremony (#1092) claimed ORPHAN-559/560 through the
  // finding-registry CLI - the authoritative allocator - while these commits
  // were already pushed citing the same numbers from the orphan document,
  // which allocates by hand. Mine moved (559 -> 564, 560 -> 565) because the
  // CLI's claim is the one with a lease behind it; the pushed trailers cannot
  // follow, because amending them needs a force-push.
  '27f4549e', // feat(watchdog): hourly T1 probes with a live CRITICAL-to-ARIA bridge (559 -> 564)
  '8f98a21f', // fix(watchdog): provision the kernel the CRITICAL branch needs (559 -> 564)
  '94d4ef32', // feat(aria): mint the gold-corpus proposals nothing was minting (560 -> 565)
  // ORPHAN-MEDIUM-464 — added by OPERATOR DECISION, not by the author's own
  // judgement, and recorded that way on purpose.
  //
  // `9fb8efce` is a `fix(gates):` commit with no `Closes:` trailer. The
  // finding it should have cited is real and registered — ORPHAN-HIGH-417,
  // whose gate self-test wiring that commit restores — so this is a missing
  // reference, not a missing finding.
  //
  // Why it cannot be repaired instead of allowlisted: `closes-footer-check`
  // validates the whole PR range, so no follow-up commit can satisfy it, and
  // amending a pushed commit needs a force-push, which CLAUDE.md forbids
  // outright. That is the identical situation every annotated entry above
  // describes.
  //
  // Why the author did not add this alone: the set is documented as frozen,
  // and growing a governance allowlist to unblock one's own branch is
  // self-authorisation — the exact defect class the branch this unblocks was
  // written to close. It was put to the operator with both routes and their
  // costs, and this is the route chosen.
  //
  // The ROOT CAUSE is separately fixed. ORPHAN-HIGH-441: the commit-msg hook
  // that would have caught this bound for nobody, because its only install
  // path was husky's `prepare`, which never runs under the `npm ci
  // --ignore-scripts` this repo mandates. `npm run hooks:install` and
  // `tests/invariants/git-hook-binding.spec.ts` close that, so the next
  // missing trailer is refused at write time rather than discovered here.
  '9fb8efce', // fix(gates): restore the orphaned npm script and make the seam checkable
]);

interface Commit {
  readonly sha: string;
  readonly shortSha: string;
  readonly subject: string;
  readonly body: string;
}

interface Trailer {
  readonly path: string;
  readonly findingId: string;
}

interface Violation {
  readonly sha: string;
  readonly subject: string;
  readonly reason: string;
}

function run(cmd: string): string {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function loadRegistryIds(): Set<string> {
  if (!existsSync(REGISTRY_PATH)) return new Set();
  const content = readFileSync(REGISTRY_PATH, 'utf8').trim();
  if (!content) return new Set();
  const ids = new Set<string>();
  for (const line of content.split('\n')) {
    try {
      const entry = JSON.parse(line) as { id?: unknown };
      if (typeof entry.id === 'string') ids.add(entry.id);
    } catch {
      // Malformed lines are tolerated here — the hash-chain integrity
      // invariant in finding-registry-integrity.spec.ts is responsible
      // for flagging them; we just want best-effort ID coverage.
    }
  }
  return ids;
}

/**
 * Load the set of `ORPHAN-{SEV}-NNN` IDs from
 * `docs/reviews/orphan-findings.md` (Batch #342 — closes
 * ORPHAN-MEDIUM-032).
 *
 * **Why orphan IDs need their own loader:** orphan
 * findings live in markdown (not the hash-chained
 * registry) by architectural design — they record
 * plan-independent observations that are not gated by
 * the registry's append-only crash-safety contract. But
 * fix commits can legitimately reference orphan IDs in
 * `Closes:` trailers (e.g., a hygiene batch that closes
 * an ORPHAN-LOW finding). Pre-#342 the validator rejected
 * any non-registry ID, blocking multi-Closes commits
 * that referenced both UH-NNN (registry) AND ORPHAN-NNN
 * (markdown) targets — even when the registry side was
 * legitimately valid. The architectural fix is per-prefix
 * routing: ORPHAN-* trailers validate against this loader;
 * non-ORPHAN trailers continue to validate against the
 * registry as before.
 *
 * **Parser shape:** scans for `^## (ORPHAN-…-NNN)` headings via the
 * shared `ORPHAN_MD_HEADING_REGEX`, which also owns the pattern the ID
 * allocator uses. One pattern, two consumers, on purpose.
 *
 * **The lane is a UNION, not markdown-only.** The paragraph above is
 * still true — orphan findings do live in markdown — but it was being
 * read as "and nowhere else", which was wrong and this gate's own error
 * message contradicted it by telling the author that "Finding IDs live
 * in: docs/reviews/_registry/findings.jsonl". An ORPHAN ID minted into
 * the hash-chained registry resolved against neither store: not the
 * registry, because the ORPHAN prefix routed away from it, and not the
 * markdown, because it was never written there. Eleven ledger ORPHAN IDs
 * were already unreferenceable this way before the change that exposed
 * it. An ORPHAN trailer now resolves if EITHER store knows the ID.
 */
const ORPHAN_FINDINGS_PATH = resolve(REPO_ROOT, 'docs/reviews/orphan-findings.md');

/** Re-exported under the historical name; the pattern itself is shared
 * with the allocator so the two cannot drift apart. */
const ORPHAN_HEADING_REGEX = ORPHAN_MD_HEADING_REGEX;

function loadOrphanIds(): Set<string> {
  return new Set(readOrphanMarkdownStore(ORPHAN_FINDINGS_PATH).ids);
}

function extractTrailers(body: string): Trailer[] {
  const out: Trailer[] = [];
  for (const line of body.split('\n')) {
    const m = CLOSES_TRAILER_REGEX.exec(line);
    if (m && m[1] && m[2]) {
      out.push({ path: m[1], findingId: m[2] });
    }
  }
  return out;
}

function commitsInRange(baseRef: string, headRef: string): Commit[] {
  const raw = run(`git log ${baseRef}..${headRef} --format=%H%x09%s%x09%b%x1f`);
  if (!raw) return [];
  return raw
    .split('\u001f')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((chunk): Commit => {
      const [sha = '', subject = '', ...rest] = chunk.split('\t');
      return {
        sha,
        shortSha: sha.slice(0, 8),
        subject,
        body: rest.join('\t'),
      };
    });
}

function lastCommit(): Commit | null {
  const raw = run('git log -1 --format=%H%x09%s%x09%b');
  if (!raw) return null;
  const [sha = '', subject = '', ...rest] = raw.split('\t');
  return {
    sha,
    shortSha: sha.slice(0, 8),
    subject,
    body: rest.join('\t'),
  };
}

/** Build a synthetic Commit from a commit-msg file (no SHA yet). */
function commitFromMsgFile(path: string): Commit {
  const raw = readFileSync(path, 'utf8');
  // Strip comment lines that git injects into COMMIT_EDITMSG.
  const cleaned = raw
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .trim();
  const [subject = '', ...bodyLines] = cleaned.split('\n');
  // Drop the conventional empty line between subject and body if present.
  while (bodyLines.length > 0 && bodyLines[0] === '') bodyLines.shift();
  return {
    sha: '<pending>',
    shortSha: '<pending>',
    subject,
    body: bodyLines.join('\n'),
  };
}

function validateCommit(
  commit: Commit,
  registryIds: ReadonlySet<string>,
  orphanIds: ReadonlySet<string>,
  isPreGate: (commit: Commit) => boolean,
): Violation[] {
  const needsCloses = REQUIRE_CLOSES_TYPES.test(commit.subject);
  if (!needsCloses) return [];
  if (isPreGate(commit)) return [];

  const trailers = extractTrailers(commit.body);
  if (trailers.length === 0) {
    return [
      {
        sha: commit.shortSha,
        subject: commit.subject,
        reason:
          'missing Closes: trailer (fix/security/refactor(agentic,phase-*) commits must close a finding)',
      },
    ];
  }

  const out: Violation[] = [];
  for (const { path, findingId } of trailers) {
    const reviewFile = resolve(REPO_ROOT, path);
    if (!existsSync(reviewFile)) {
      out.push({
        sha: commit.shortSha,
        subject: commit.subject,
        reason: `Closes: trailer references missing review file: ${path}`,
      });
    }
    // Per-prefix routing. Three lanes:
    //
    //   1. ARIA findings + debts (Plan 017 — closes the
    //      gap that forced the Plan 016 implementation
    //      arc to use chore(...) bypass). Path must start
    //      with aria-findings/ or aria-debts/ AND the ID
    //      must be the matching ARIA shape. The JSON file
    //      itself is the registry; the existsSync check
    //      above already validated it.
    //
    //   2. ORPHAN-{SEV}-NNN IDs (Batch #342 — closes
    //      ORPHAN-MEDIUM-032). Validate against the
    //      orphan-findings.md heading index.
    //
    //   3. All other prefixes (UH-, AUDIT-,
    //      DEPLOY-CRITICAL-, etc.). Validate against the
    //      hash-chained registry.
    //
    // Mismatched lanes (ARIA path with non-ARIA ID, or
    // non-ARIA path with ARIA ID) are rejected so a
    // commit cannot smuggle in an ID through the wrong
    // lane.
    if (isAriaArtifactPath(path) || isAriaFindingId(findingId)) {
      if (!isAriaArtifactPath(path) || !isAriaFindingId(findingId)) {
        out.push({
          sha: commit.shortSha,
          subject: commit.subject,
          reason: `Closes: ARIA trailer must pair an aria-findings/ or aria-debts/ path with a matching ARIA ID (F-NNN or DEBT-YYYY-MM-DD-NNN); got path=${path} id=${findingId}`,
        });
        continue;
      }
      // Path-and-ID pairing rule: aria-findings/ requires F-NNN OR
      // F-AUTO-V{X.Y}-{TOPIC} (V10.5+ tracked-deferral form);
      // aria-debts/ requires DEBT-YYYY-MM-DD-NNN.
      const wantsFinding = path.startsWith('aria-findings/');
      const isFindingId =
        /^F-\d{3}$/.test(findingId) || /^F-AUTO-V\d+\.\d+(?:-[A-Z0-9-]+)+$/.test(findingId);
      if (wantsFinding !== isFindingId) {
        out.push({
          sha: commit.shortSha,
          subject: commit.subject,
          reason: `Closes: ARIA trailer path/ID mismatch — aria-findings/ requires F-NNN or F-AUTO-V{X.Y}-{TOPIC}, aria-debts/ requires DEBT-YYYY-MM-DD-NNN; got path=${path} id=${findingId}`,
        });
      } else if (existsSync(reviewFile)) {
        // Plan 018 Phase 4 (G5) — Closes-trailer ID-content cross-check.
        // Three earlier gates have passed: trailer regex match, file
        // exists, ARIA path/ID kind agrees. The smuggled-trailer
        // class the audit caught is a path/file-content disagreement
        // (e.g. aria-findings/F-001.json#F-002 — file content says
        // finding_id=F-001 but trailer claims F-002). Parse + compare.
        const result = readAriaArtifactId(reviewFile, path);
        if (result.kind === 'unreadable') {
          out.push({
            sha: commit.shortSha,
            subject: commit.subject,
            reason: `Closes: ${result.reason} (path=${path})`,
          });
        } else if (result.value !== findingId) {
          const expectedField = path.startsWith('aria-findings/') ? 'finding_id' : 'debt_id';
          out.push({
            sha: commit.shortSha,
            subject: commit.subject,
            reason: `Closes: ARIA file's ${expectedField} (${result.value}) does not match trailer ID (${findingId}); path=${path}`,
          });
        }
      }
    } else if (findingId.startsWith('ORPHAN-')) {
      if (!orphanIds.has(findingId) && !registryIds.has(findingId)) {
        out.push({
          sha: commit.shortSha,
          subject: commit.subject,
          reason: `Closes: trailer references unknown ORPHAN finding ID: ${findingId} (no matching "## ${findingId}" heading in docs/reviews/orphan-findings.md, and no such id in docs/reviews/_registry/findings.jsonl)`,
        });
      }
    } else if (!registryIds.has(findingId)) {
      out.push({
        sha: commit.shortSha,
        subject: commit.subject,
        reason: `Closes: trailer references unknown finding ID: ${findingId} (not in docs/reviews/_registry/findings.jsonl)`,
      });
    }
  }
  return out;
}

function report(violations: Violation[]): void {
  writeStderr('Closes: trailer validation FAILED:');
  for (const v of violations) {
    writeStderr(`  ${v.sha}  ${v.subject}`);
    writeStderr(`    -> ${v.reason}`);
  }
  writeStderr('');
  writeStderr('Every fix/security/refactor(agentic,phase-*) commit must carry:');
  writeStderr('  Closes: docs/reviews/<agent>/<date>-<topic>.md#<FINDING-ID>');
  writeStderr('');
  writeStderr('Finding IDs live in: docs/reviews/_registry/findings.jsonl');
  writeStderr('Finding-ID regex:    {PREFIX}-(CRITICAL|HIGH|MEDIUM|LOW)-NNN');
  writeStderr(
    'Phase 6 reference:   docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#Phase-6',
  );
}

function main(): void {
  const [, , modeFlag, ...args] = process.argv;
  if (!modeFlag) {
    writeStderr(
      'Usage: ts-node tools/gates/commit-msg-validator.ts --mode=<msg-file|range|commit> [args]',
    );
    process.exit(2);
  }

  const mode = modeFlag.replace(/^--mode=/, '');
  const registryIds = loadRegistryIds();
  const orphanIds = loadOrphanIds();
  const violations: Violation[] = [];

  if (mode === 'msg-file') {
    const [msgPath] = args;
    if (!msgPath) {
      writeStderr('msg-file mode requires the commit-msg path: --mode=msg-file <path>');
      process.exit(2);
    }
    const abs = resolve(REPO_ROOT, msgPath);
    if (!existsSync(abs)) {
      writeStderr(`msg-file not found: ${msgPath}`);
      process.exit(2);
    }
    // No PRE_PHASE6_SHAS applies — the commit has no SHA yet.
    violations.push(...validateCommit(commitFromMsgFile(abs), registryIds, orphanIds, () => false));
  } else if (mode === 'range') {
    const [baseRef, headRef] = args;
    if (!baseRef || !headRef) {
      writeStderr('range mode requires two refs: --mode=range <base> <head>');
      process.exit(2);
    }
    const commits = commitsInRange(baseRef, headRef);
    if (commits.length === 0) {
      writeStdout('No commits in range; nothing to validate.');
      return;
    }
    for (const c of commits) {
      violations.push(
        ...validateCommit(c, registryIds, orphanIds, (cm) => PRE_PHASE6_SHAS.has(cm.shortSha)),
      );
    }
  } else if (mode === 'commit') {
    const c = lastCommit();
    if (!c) {
      writeStdout('No HEAD commit; nothing to validate.');
      return;
    }
    violations.push(
      ...validateCommit(c, registryIds, orphanIds, (cm) => PRE_PHASE6_SHAS.has(cm.shortSha)),
    );
  } else {
    writeStderr(`Unknown mode: ${mode}`);
    process.exit(2);
  }

  if (violations.length === 0) {
    writeStdout('Closes: trailer validation passed.');
    return;
  }

  report(violations);
  process.exit(1);
}

// Guard main() invocation so this module can be imported
// by tests without triggering the CLI's argv parsing +
// execution. See clippy-affected.ts module doc for the
// architectural rationale (Batch #348 established this
// pattern as the SSoT for CLI-script-with-exported-
// helpers in `tools/gates/`).
if (require.main === module) {
  main();
}

// Exported for testing (Batch #349 — closes the test-
// coverage gap from Batch #342 where the orphan-routing
// extensions to `validateCommit` + the new `loadOrphanIds`
// helper shipped without unit tests).
export {
  CLOSES_TRAILER_REGEX,
  ORPHAN_HEADING_REGEX,
  REQUIRE_CLOSES_TYPES,
  commitFromMsgFile,
  extractTrailers,
  isAriaArtifactPath,
  isAriaFindingId,
  loadOrphanIds,
  loadRegistryIds,
  readAriaArtifactId,
  validateCommit,
  type Commit,
  type Trailer,
  type Violation,
};
