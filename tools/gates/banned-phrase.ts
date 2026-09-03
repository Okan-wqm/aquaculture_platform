#!/usr/bin/env ts-node
/**
 * Banned-phrase gate — Phase 2 of /root/.claude/plans/abstract-brewing-mochi.md.
 *
 * Scans staged / changed files + commit messages for phrases forbidden by
 * CLAUDE.md's "Architectural Approach" section. Fails the run when any
 * match is found in a non-exempt path.
 *
 * Banned phrases (canonical in CLAUDE.md and _shared/tier-claim-syntax.md:49-60):
 *   - "for now"
 *   - "interim solution" / "interim"
 *   - "temporary"
 *   - "pragmatic"
 *   - "simpler approach"
 *   - "middle ground"
 *   - "for momentum"
 *   - "just this commit"
 *   - "deferred" (unless paired with owner + deadline + finding ID OR plan phase reference)
 *   - "out of scope" (unless paired with ADR / review / plan reference)
 *   - "good enough"
 *   - "sufficient for now"
 *
 * Exempt paths (from CLAUDE.md + _shared/tier-claim-syntax.md:62):
 *   - docs/adr/**, docs/reviews/**, docs/architecture/**  — may discuss rejected alternatives
 *   - docs/plans/**                                        — plan docs carry tracked-deferral vocabulary
 *                                                            with owner+deadline+finding-ID and quote
 *                                                            the banned-phrase list itself verbatim
 *   - CHANGELOG.md                                         — historical record
 *   - .claude/{agents,agents.legacy,shared,knowledge,skills}/** — agent prompts, knowledge
 *                                                            SSoT, and skills catalog may legitimately
 *                                                            reference banned phrases in rule
 *                                                            definitions and architectural-gate citations
 *   - CLAUDE.md                                            — canonical source of the banned list
 *   - tools/gates/banned-phrase.ts                         — this file itself
 *   - tests/invariants/**                                  — invariant specs may reference banned phrases by name
 *
 * Usage:
 *   ts-node tools/gates/banned-phrase.ts --mode=staged        # pre-commit hook — full staged file
 *   ts-node tools/gates/banned-phrase.ts --mode=range A B     # CI PR check — ADDED LINES only
 *   ts-node tools/gates/banned-phrase.ts --mode=commit        # last commit body only
 *   ts-node tools/gates/banned-phrase.ts --mode=file <path>   # ad-hoc single file — whole file
 *
 * Range mode rationale: on long-lived feature branches pre-existing hits
 * (e.g. SQL enum values like 'deferred' in hr migration 1736000000000)
 * would retrigger on every PR build. The ADDED-LINES-only filter respects
 * the invariant "the gate catches banned phrases this PR introduces" —
 * pre-existing hits are grandfathered. allowIf windowing still reads the
 * full file context around the hit so a plan reference one or two lines
 * away outside the diff still exempts.
 *
 * Exit codes:
 *   0 — clean
 *   1 — banned phrase detected
 *   2 — usage error
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

// Round-2 cluster-0: the -U0 added-line parser moved to the shared
// git-diff-ranges module (SSOT — banned-construct.ts and
// farm-service-enterprise-guardrails.ts consume the same parser, so a
// hunk-header edge case can no longer be fixed in one gate and stay
// broken in another).
import { addedLinesByFile, collectRangeAddedLines, stagedChangedFiles } from './git-diff-ranges';

const REPO_ROOT = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return process.cwd();
  }
})();

function writeStdout(message = ''): void {
  process.stdout.write(`${message}\n`);
}

function writeStderr(message = ''): void {
  process.stderr.write(`${message}\n`);
}

interface BannedPhraseRule {
  phrase: RegExp;
  allowIf: RegExp | null;
  allowMatch?: (line: string, matchIndex: number) => boolean;
  label: string;
}

/**
 * PostgreSQL uses this exact clause to select deferred constraint checking.
 * The final token is SQL grammar, not architectural prose, so the phrase gate
 * must recognise the clause without exempting the surrounding file or any
 * other occurrence on the same line.
 */
function isSqlConstraintTimingClause(line: string, matchIndex: number): boolean {
  for (const clause of line.matchAll(/\bDEFERRABLE\s+INITIALLY\s+DEFERRED\b/gi)) {
    const clauseIndex = clause.index ?? -1;
    const keywordOffset = clause[0].toLowerCase().lastIndexOf('deferred');
    if (clauseIndex + keywordOffset === matchIndex) {
      return true;
    }
  }
  return false;
}

/**
 * Each banned phrase as a case-insensitive word-boundary regex plus an
 * optional exemption matcher. If the exemption pattern matches on the same
 * line, the hit is suppressed (e.g., "deferred" followed by plan-phase
 * reference is a tracked deferral, not a banned hedge).
 */
/**
 * Meta-discussion allowIf — recognises commit bodies / review notes
 * that DESCRIBE a hedge-word being removed, rather than ADVOCATE for
 * hedging. The architectural claim is: the gate's invariant is "no
 * hedge language advocating compromise in code/commits", not "no
 * hedge word appears in any line at all". Describing a fix of
 * `"Temporary ID"` → `"Client-side optimistic ID"` is the inverse
 * of the gate's target class.
 *
 * Match requires BOTH of these to be present on the same line (the
 * allowIf callsite tests one-line windows against the phrase's line):
 *
 *   Precondition A — context marker:
 *     - quoted string `"..."`                    (normal prose quote-back), OR
 *     - git-diff leading `-` or `+`              (rebase-style diff quote), OR
 *     - a `L<number>` file:line reference        (commit body pointing to a fix)
 *
 *   Precondition B — transformation intent:
 *     - a `→` arrow                              (ASCII alternative `->` covered), OR
 *     - a diff-style `-` / `+` line prefix       (already satisfies via A)
 *
 * The old permissive branch `→` alone is REMOVED — a stray arrow on
 * a plain-prose hedge line (e.g. "we'll do temporary fix → Monday")
 * no longer slips through.
 */
const META_DISCUSSION_ALLOW_IF =
  /(^[-+]\s*["'])|("[^"\n]*"\s*(→|->))|(\bL\d+\s*:\s*"[^"\n]*"\s*(→|->)?)|("[^"\n]*"\s*\bL\d+)/;

/**
 * Tracked-deferral allowIf — recognises any of the structured pointers
 * that turn a `deferred` mention into a tracked obligation rather than a
 * silent hedge:
 *
 *   - Full inline contract: `owner:@user deadline:YYYY-MM-DD #FINDING-ID`
 *   - Plan-phase reference: `Phase N`, `W<N>`, `Faz N` (Turkish "Phase",
 *     used canonically in the Rust migration plan + edge security plan)
 *   - § section reference: `§5a`, `§ 6.4` (security ceremony plan markers)
 *   - Explicit plan filename: `abstract-brewing-mochi`, `declarative-riding-shamir`
 *   - Finding ID with severity: `#PREFIX-(CRITICAL|HIGH|MEDIUM|LOW|NIT)-NNN`
 *     (NIT = nitpick — first-class severity in edge-expert audit dialect)
 *   - Compound finding ID: `BATCH-007-FU-01` (Sprint follow-up dialect)
 *
 * The patterns are intentionally narrow — each is a structural pointer to
 * an external tracking artefact, not free-form hedging.
 */
const TRACKED_DEFERRAL_ALLOW_IF =
  /(owner\s*:\s*@[\w-]+.*deadline\s*:\s*\d{4}-\d{2}-\d{2}.*#[A-Z]+-[A-Z]+-\d+)|(\b[Pp]hase[\s-]\d+(\.\d+)?\b)|(\bW\d+(\.\d+)?\b)|(\bFaz[\s-]\d+(\.\d+)?\b)|(§\s*\d+[a-z]?)|(abstract-brewing-mochi|declarative-riding-shamir)|(#?[A-Z][A-Z0-9]+-(CRITICAL|HIGH|MEDIUM|LOW|NIT)-\d{2,3})|(\b[A-Z]+-\d{2,3}-FU-\d{1,3}\b)/i;

/**
 * Plan / ADR / § reference allowIf — for `interim` and `temporary` the
 * legitimate use is naming a defined system concept (e.g. "interim HSM
 * anchor key" in PKI ceremony vocabulary, "§5a interim" in a plan
 * section header). Same structural pointers as the deferred matcher,
 * minus the owner/deadline contract (those apply only to deferrals).
 */
const STRUCTURED_REFERENCE_ALLOW_IF =
  /(ADR-\d+)|(\b[Pp]hase[\s-]\d+(\.\d+)?\b)|(\bW\d+(\.\d+)?\b)|(\bFaz[\s-]\d+(\.\d+)?\b)|(§\s*\d+[a-z]?)|(abstract-brewing-mochi|declarative-riding-shamir)|(#?[A-Z][A-Z0-9]+-(CRITICAL|HIGH|MEDIUM|LOW|NIT)-\d{2,3})|(\b[A-Z]+-\d{2,3}-FU-\d{1,3}\b)/i;

/**
 * Combined `interim` / `temporary` allowIf — matches either the
 * meta-discussion form (quoted/diff) OR a structured reference (ADR / §
 * / phase). The combination handles two distinct legitimate uses:
 *   1. Describing a removed annotation: `the temporary X comment removed`
 *      → quoted-region detection in scanContent (no allowIf change needed)
 *   2. Naming a defined concept: `§5a Interim offline-HSM anchor key`
 *      → STRUCTURED_REFERENCE_ALLOW_IF
 */
const INTERIM_TEMPORARY_ALLOW_IF = new RegExp(
  `(${META_DISCUSSION_ALLOW_IF.source})|(${STRUCTURED_REFERENCE_ALLOW_IF.source})`,
  'i',
);

const BANNED_PHRASES: readonly BannedPhraseRule[] = [
  { phrase: /\bfor now\b/i, allowIf: META_DISCUSSION_ALLOW_IF, label: 'for now' },
  {
    phrase: /\binterim solution\b/i,
    allowIf: INTERIM_TEMPORARY_ALLOW_IF,
    label: 'interim solution',
  },
  { phrase: /\binterim\b/i, allowIf: INTERIM_TEMPORARY_ALLOW_IF, label: 'interim' },
  { phrase: /\btemporary\b/i, allowIf: INTERIM_TEMPORARY_ALLOW_IF, label: 'temporary' },
  { phrase: /\bpragmatic\b/i, allowIf: META_DISCUSSION_ALLOW_IF, label: 'pragmatic' },
  { phrase: /\bsimpler approach\b/i, allowIf: META_DISCUSSION_ALLOW_IF, label: 'simpler approach' },
  { phrase: /\bmiddle ground\b/i, allowIf: META_DISCUSSION_ALLOW_IF, label: 'middle ground' },
  { phrase: /\bfor momentum\b/i, allowIf: META_DISCUSSION_ALLOW_IF, label: 'for momentum' },
  { phrase: /\bjust this commit\b/i, allowIf: META_DISCUSSION_ALLOW_IF, label: 'just this commit' },
  {
    phrase: /\bdeferred\b/i,
    allowIf: TRACKED_DEFERRAL_ALLOW_IF,
    allowMatch: isSqlConstraintTimingClause,
    label: 'deferred (without plan phase / W-N / Faz-N / § / finding ID reference)',
  },
  {
    phrase: /\bout of scope\b/i,
    allowIf:
      /(ADR-\d+|docs\/reviews\/|docs\/adr\/|\b[Pp]hase[\s-]\d|\bW\d+|\bFaz[\s-]\d+|abstract-brewing-mochi|declarative-riding-shamir)/i,
    label: 'out of scope (without ADR / review / plan / Faz reference)',
  },
  { phrase: /\bgood enough\b/i, allowIf: META_DISCUSSION_ALLOW_IF, label: 'good enough' },
  {
    phrase: /\bsufficient for now\b/i,
    allowIf: META_DISCUSSION_ALLOW_IF,
    label: 'sufficient for now',
  },
];

const EXEMPT_PATHS: readonly RegExp[] = [
  /^docs\/adr\//,
  /^docs\/reviews\//,
  /^docs\/architecture\//,
  /^docs\/compliance\//,
  /^docs\/plans\//,
  // ARIA review and plan documents legitimately quote the banned phrase
  // list when they review the platform's compliance with CLAUDE.md or
  // when they document the gate itself (Plan 016 + Plan 017 reviews).
  // Same exemption rationale as docs/reviews/ and docs/plans/ above —
  // the doc IS the meta-text describing the discipline.
  /^docs\/aria\/reviews\//,
  /^docs\/aria\/plans\//,
  // ARIA closure reports (post-sprint architectural records) legitimately
  // discuss tracked deferrals with owner+deadline+finding-ID context and
  // self-audit the banned-phrase discipline. Same meta-text exemption
  // rationale as reviews/plans above. Pattern matches v{major}-{minor}-
  // closure-report.md and architectural arc summaries.
  /^docs\/aria\/v\d+-\d+-closure-report\.md$/,
  // Architectural-arbiter recommendations (ADRs) legitimately discuss
  // tracked deferrals with owner+deadline+finding-ID context per
  // CLAUDE.md §Architectural Approach. Same exemption rationale as
  // docs/adr/ above.
  /^docs\/recommendations\//,
  // Finding artifacts (aria-findings/F-*.json) legitimately use the
  // word "deferred" in the title/scope of V10.6 tracked-deferral
  // findings. The finding JSON itself IS the structured form of the
  // owner+deadline+finding-ID compliance.
  /^aria-findings\/F-AUTO-V\d+-/,
  // Vendored upstream fork (RUST-CVE-001): third-party prose (README,
  // design.md, CHANGELOG) is upstream-authored text, not our discipline
  // surface. Editing it would violate the fork-hygiene gate's 2-file diff
  // policy (tools/gates/local-rumqttc-fork-hygiene.spec.ts), which is the
  // stronger guarantee: any change to these files outside Cargo.toml +
  // src/tls.rs fails CI.
  /^crates\/local-rumqttc\//,
  /^CHANGELOG\.md$/,
  /^\.claude\/agents\.legacy\//,
  /^\.claude\/agents\//,
  /^\.claude\/shared\//,
  /^\.claude\/knowledge\//,
  /^\.claude\/skills\//,
  /^CLAUDE\.md$/,
  // Community docs that DOCUMENT the banned-phrase discipline by name.
  // They list "for now", "good enough", etc. as forbidden phrases — the
  // doc IS the meta-text describing this very gate. Same exemption
  // rationale as banned-phrase.ts itself below.
  /^CONTRIBUTING\.md$/,
  /^SECURITY\.md$/,
  /^tools\/gates\/banned-phrase\.(ts|mjs)$/,
  /^tools\/gates\/banned-phrase\.test\.(ts|mjs)$/,
  /^tools\/scripts\/seed-finding-registry\.(mjs|ts)$/, // finding seed text references banned phrases by name (meta-text)
  /^tests\/invariants\//,
  // new-aria/ is a verbatim transport copy of the ARIA surface (kernel, executor,
  // agent prompts, ADRs, plans) destined for its own repository. Every line in it
  // already exists at a canonical path that is either exempt above or governed
  // by range-mode grandfathering; the copy is not authored prose.
  /^new-aria\//,
  // HR performance domain: GoalStatus.DEFERRED is a legitimate enum value
  // for the performance-management domain (a deferred goal is parked but
  // not cancelled — see Workday/SuccessFactors GoalStatus models). Renaming
  // the enum value would require a database migration on persisted goal
  // rows. The file is exempt only for the "deferred" rule; other banned
  // phrases (for now, pragmatic, etc.) still apply.
  /^apps\/hr-service\/src\/performance\/entities\/goal\.entity\.ts$/,
  // Same rationale: the migration that CREATES the goal_status enum ships
  // `'deferred'` as a SQL literal to match the entity. The phrase appears
  // inside an SQL string, not as a gating excuse.
  /^apps\/hr-service\/src\/database\/migrations\/1736000000000-CreateHRModuleSchema\.ts$/,
  // Same rationale: the migration that CREATES the goals_status_enum
  // ships `'DEFERRED'` as a SQL literal to match the GoalStatus entity
  // enum. The phrase appears inside an SQL ENUM declaration, not as a
  // gating excuse.
  /^apps\/hr-service\/src\/database\/migrations\/1789100000000-AddHrPayrollsHolidaysGoals\.ts$/,
  // The defer-goal command handler reads / writes `GoalStatus.DEFERRED`
  // and embeds the word "Deferred:" in the audit log entry it constructs.
  // Same rationale as the enum file above: the word IS the product
  // semantics for the performance-management domain (a parked goal),
  // not an architectural gating excuse. Renaming the enum or the audit
  // string would require database + audit-log migrations on persisted
  // historical state.
  /^apps\/hr-service\/src\/performance\/handlers\/defer-goal\.handler\.ts$/,
];

const GENERATED_OUTPUT_MANIFEST_PATH =
  'docs/plans/2026-06-19-root-ssot-stabilization/stabilization-manifest.json';

type GeneratedOutputManifest = {
  waves?: Array<{
    generated_outputs?: Array<{
      path?: string;
      manual_edits_allowed?: boolean;
    }>;
  }>;
};

let generatedOutputPathsCache: ReadonlySet<string> | null = null;

function generatedOutputPaths(): ReadonlySet<string> {
  if (generatedOutputPathsCache) return generatedOutputPathsCache;

  const manifestPath = resolve(REPO_ROOT, GENERATED_OUTPUT_MANIFEST_PATH);
  if (!existsSync(manifestPath)) {
    generatedOutputPathsCache = new Set<string>();
    return generatedOutputPathsCache;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as GeneratedOutputManifest;
  const paths = new Set<string>();
  for (const wave of manifest.waves ?? []) {
    for (const output of wave.generated_outputs ?? []) {
      if (output.path && output.manual_edits_allowed === false) {
        paths.add(output.path);
      }
    }
  }

  generatedOutputPathsCache = paths;
  return generatedOutputPathsCache;
}

interface Violation {
  source: string;
  line: number;
  column: number;
  phrase: string;
  context: string;
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

function isExempt(relPath: string): boolean {
  return EXEMPT_PATHS.some((re) => re.test(relPath)) || generatedOutputPaths().has(relPath);
}

/**
 * Width of the allowIf context window (in lines around the hit). Commit
 * bodies and file sections often carry the hit word on one line and the
 * plan-phase reference on an adjacent line; a single-line check
 * produces false positives of the form
 *
 *    ... deferred to the      <- hit here
 *    Phase 4 testing sweep    <- reference here
 *
 * A 3-before / 3-after window is wide enough for natural paragraph
 * wrapping without opening the door to unrelated-paragraph coupling.
 */
const ALLOW_IF_WINDOW_FILE = 3;
/**
 * Commit bodies are short, self-contained units; the plan-phase reference
 * often appears in the subject line while the hedge word appears in the
 * body text many lines away. A per-line window would flag legitimate
 * commits whose subject is already scoped (e.g. `fix(agentic,phase-2)`).
 * For commit-body scans, allowIf is evaluated against the ENTIRE content
 * so the subject line counts. `Infinity` flags this to scanContent.
 */
const ALLOW_IF_WINDOW_COMMIT = Infinity;

/**
 * A match is meta-discussion (descriptive, not advocacy) when it sits
 * inside a balanced double-quoted region or Markdown inline-code span
 * on the same line. Count of unescaped delimiters before `matchIndex`
 * is odd when we are inside that literal region.
 *
 * Architectural rationale: the gate's invariant is "no hedge language
 * advocating compromise". Words appearing inside `"..."` are by
 * convention the SUBJECT of discussion (a cited label, error string,
 * or quoted CLAUDE.md rule), not advocacy in the surrounding voice.
 * This generalises the META_DISCUSSION_ALLOW_IF arrow patterns: any
 * double-quoted region containing the hit is descriptive context.
 *
 * Handles double quotes and Markdown backticks. Single quotes are
 * intentionally excluded because `'` appears as an apostrophe in English
 * prose and would produce false positives.
 */
// 2026-04-30: PR range scans include historical commit bodies. When a
// commit body quotes a removed code comment in a Markdown inline-code span,
// the phrase is evidence of a cure, not a new architectural hedge.
function isInsideLiteralRegion(line: string, matchIndex: number): boolean {
  let count = 0;
  for (let i = 0; i < matchIndex; i++) {
    if (line[i] === '"' && (i === 0 || line[i - 1] !== '\\')) count++;
  }
  if (count % 2 === 1) return true;

  let backtickCount = 0;
  for (let i = 0; i < matchIndex; i++) {
    if (line[i] === '`' && (i === 0 || line[i - 1] !== '\\')) backtickCount++;
  }
  return backtickCount % 2 === 1;
}

function scanContent(content: string, sourceLabel: string, allowIfWindow: number): Violation[] {
  const violations: Violation[] = [];
  const lines = content.split('\n');
  lines.forEach((line, i) => {
    for (const rule of BANNED_PHRASES) {
      const match = rule.phrase.exec(line);
      if (!match) continue;
      if (isInsideLiteralRegion(line, match.index)) continue;
      if (rule.allowMatch?.(line, match.index)) continue;
      if (rule.allowIf) {
        let windowText: string;
        if (allowIfWindow === Infinity) {
          windowText = content;
        } else {
          const windowStart = Math.max(0, i - allowIfWindow);
          const windowEnd = Math.min(lines.length, i + allowIfWindow + 1);
          windowText = lines.slice(windowStart, windowEnd).join('\n');
        }
        if (rule.allowIf.test(windowText)) continue;
      }
      violations.push({
        source: sourceLabel,
        line: i + 1,
        column: match.index + 1,
        phrase: rule.label,
        context: line.trim().slice(0, 180),
      });
    }
  });
  return violations;
}

function scanFile(relPath: string, ignoreExemptions = false): Violation[] {
  // Plan 020 Phase 0.4 — operator gap: fixture-mode flag bypasses
  // EXEMPT_PATHS. Default behaviour preserved (husky/CI gate paths
  // continue to honour exemptions); --ignore-exemptions flag turns
  // every path into a scan target so verification fixtures under
  // tests/invariants/fixtures/ surface as violations as designed.
  if (!ignoreExemptions && isExempt(relPath)) return [];
  const abs = resolve(REPO_ROOT, relPath);
  if (!existsSync(abs)) return [];
  const content = readFileSync(abs, 'utf8');
  return scanContent(content, relPath, ALLOW_IF_WINDOW_FILE);
}

/**
 * Like scanFile but only reports hits whose (1-based) line number is in
 * `onlyLines`. Used by range mode to restrict the gate to lines the PR
 * actually touched. allowIf windowing still sees the full file context
 * so that a reference line one or two lines away (outside the hit set)
 * still exempts the hit.
 */
function scanFileAddedLinesOnly(
  relPath: string,
  onlyLines: ReadonlySet<number>,
  ignoreExemptions = false,
): Violation[] {
  if (!ignoreExemptions && isExempt(relPath)) return [];
  if (onlyLines.size === 0) return [];
  const abs = resolve(REPO_ROOT, relPath);
  if (!existsSync(abs)) return [];
  const content = readFileSync(abs, 'utf8');
  return scanContent(content, relPath, ALLOW_IF_WINDOW_FILE).filter((v) => onlyLines.has(v.line));
}

function scanCommitBody(): Violation[] {
  const body = run('git log -1 --pretty=%B');
  return scanContent(body, '<last commit message>', ALLOW_IF_WINDOW_COMMIT);
}

/**
 * Commits landed BEFORE this gate existed (or before it ran in CI on the
 * PR that merged them) cannot be expected to comply with its retroactive
 * rules. Amending is forbidden (force-push ban) so these specific SHAs
 * are allowlisted. Going forward the gate runs on every PR.
 *
 * Governed by P0-HIGH-005 (phantom infrastructure) retroactive amnesty —
 * captured in docs/reviews/_registry/findings.jsonl.
 *
 * Two sub-classes live in this set:
 *
 *   1. PRE-GATE commits (gate infrastructure did not exist yet):
 *      Phase 0 through Phase 7 landing commits. Set is frozen.
 *
 *   2. FAZ-0/1/2/3 commits authored on `agentic-rust-*` branches where
 *      the gate existed but did not fire in CI due to PR #16/#17 lacking
 *      the quality-gates workflow trigger. The phrases in these commits
 *      use the banned words in past-tense descriptions or scope-of-CI
 *      statements — not as architectural hedges. Force-push amend is
 *      forbidden (CLAUDE.md) so the same retroactive-amnesty pattern
 *      applies. Gate enhancements landed alongside this amnesty:
 *        - isInsideQuotedRegion() strips out most meta-discussion hits.
 *        - TRACKED_DEFERRAL_ALLOW_IF now recognises Faz N + § + NIT/FU
 *          severity words + compound finding IDs (BATCH-007-FU-01 style).
 *        - INTERIM_TEMPORARY_ALLOW_IF accepts ADR-NNN / §N / phase refs.
 *      These cover the majority of hits; the SHAs below are the residual
 *      class where the banned word legitimately describes past/scope
 *      state without any structural pointer (by design short-form prose).
 */
const PRE_GATE_SHAS = new Set<string>([
  '32839e24', // Phase 0 — landed before Phase 2 gate infrastructure
  'f931f935', // Phase 0.1
  '2dd09f99', // Phase 4 invariants
  'b907c235', // Phase 5 root-cause-auditor
  '7090c950', // Phase 6 finding registry
  '4eb35921', // Phase 7 CODEOWNERS
  '47bea207', // Phase 2 banned-phrase gate landing itself (META — names the banned words)
  '0af5c197', // W1.5 ADR fix — pre-gate docs commit
  '5703de4e', // W1 Part A unified synthesis — pre-gate docs commit
  '9f977259', // W0 ripple-tracer DRAFT spec — pre-gate docs commit
  // --- Faz-0/1/2/3 retroactive amnesty (PR #16/#17 CI gate mis-trigger) ---
  '01b036a4', // Faz-3 jest-runner split — "the temporary X location removed" (past-tense annotation)
  'cdd6f9f3', // Faz-2 push-policy alignment — "(commit expected, push deferred to the user)" (task delegation, not arch deferral)
  '59ef849a', // Faz-2 stage 5 — "for now unit + clippy + fmt + test coverage gates merges" (scope-of-CI-coverage description, tracked follow-up in same body)
  'e29c7416', // Faz-2 stage 2 — "for now the trybuild + unit + cargo-deny coverage" (scope-of-CI-coverage, tracked follow-up in same body)
  '0a5043b7', // Faz-0 stage 11b — "temporary-rename comparison" (verification method name, past tense)
  'f1eb2142', // Phase-5 biomass Altinn backend — "for now" marks the commit's backend-only scope ("...backend now; the frontend three-step Review -> Ready-for-Altinn -> Confirm UI ... follow"); the follow-up frontend landed in 1ba1a394 on this same branch. Immutable message (no-force-push), tracked follow-up delivered — same shape as 59ef849a/e29c7416 above.
  // --- Rust migration delta (/root/.claude/plans/snappy-sniffing-pine.md) amnesty ---
  // Commits landed before this gate was wired to scan the full PR-range
  // (pre-merge-into-main). Same shape as the Faz-0/1/2/3 entries above:
  // the "for now" / "out of scope" hits describe the commit's scope
  // boundary in prose, with the actual architectural work tracked in a
  // same-body "What this commit does NOT do" section pointing at the
  // follow-up commit SHA.
  'cfc714cb', // ADR-029 part 1 V016 outbox migration — "events keep flowing through the in-memory channel for now. The cut-over is a subsequent commit" (scope-boundary description — cut-over landed in 9cac59f0)
  '54228f19', // CI unblock commit — META: its body QUOTES the cfc714cb amnesty rationale, so the literal banned substring appears when the commit message describes why cfc714cb was amnesty'd. Meta-mention, not deferral.
  '8f5d9fed', // Finance PERF-HIGH-004 debt-refinement commit — META: its body QUOTES the OLD vague debt text ("self-contained caching subsystem, out of scope") to explain why it is being REPLACED with a concrete prerequisite. Meta-mention of a removed hedge, not advocacy. Immutable (no-force-push); same shape as 54228f19.
  '70efe9d7', // Snowball historical gate-hardening commit — meta text enumerates the banned phrase vocabulary
  '22c60810', // Snowball historical ARIA handoff commit — pre-main-range enforcement language
  '0f5ae29a', // Snowball historical ARIA verification commit — pre-main-range enforcement language
  'b98ee050', // Snowball historical ARIA plan commit — pre-main-range enforcement language
]);

function scanRangeCommitBodies(baseRef: string, headRef: string): Violation[] {
  const bodies = run(`git log ${baseRef}..${headRef} --pretty=%H%x09%B%x1f`);
  if (!bodies) return [];
  const chunks = bodies
    .split('\u001f')
    .map((c) => c.trim())
    .filter(Boolean);
  const violations: Violation[] = [];
  for (const chunk of chunks) {
    const [sha, ...rest] = chunk.split('\t');
    const body = rest.join('\t');
    const shortSha = sha?.slice(0, 8) ?? '<unknown>';
    if (PRE_GATE_SHAS.has(shortSha)) continue;
    violations.push(...scanContent(body, `<commit ${shortSha} message>`, ALLOW_IF_WINDOW_COMMIT));
  }
  return violations;
}

/**
 * Plan 020 Phase 0.4 — two-stage argv parser.
 *
 * Splits raw argv into mode/flags/positional groups so flags like
 * --ignore-exemptions can appear before OR after the mode/positional
 * tokens without the parser confusing them with file paths. Earlier
 * positional-only parser would treat
 *   --mode=file --ignore-exemptions <path>
 * as positional[0]=--ignore-exemptions, positional[1]=<path>, which
 * silently broke the verification command.
 */
function parseArgv(rawArgv: string[]): {
  mode: string;
  flags: Set<string>;
  positional: string[];
  modeExplicit: boolean;
} {
  const flags = new Set<string>();
  const positional: string[] = [];
  let modeArg: string | null = null;
  for (const tok of rawArgv) {
    if (tok.startsWith('--mode=')) {
      modeArg = tok.replace(/^--mode=/, '');
      continue;
    }
    if (tok.startsWith('--')) {
      flags.add(tok.replace(/^--/, ''));
      continue;
    }
    positional.push(tok);
  }
  return {
    mode: modeArg ?? 'staged',
    flags,
    positional,
    modeExplicit: modeArg !== null,
  };
}

function main(): void {
  const rawArgv = process.argv.slice(2);
  const { mode, flags, positional, modeExplicit } = parseArgv(rawArgv);
  if (!modeExplicit) {
    writeStderr('[banned-phrase] no --mode supplied; defaulting to --mode=staged.');
  }
  const ignoreExemptions = flags.has('ignore-exemptions');

  const violations: Violation[] = [];

  if (mode === 'staged') {
    for (const f of stagedChangedFiles(REPO_ROOT)) {
      violations.push(...scanFile(f, ignoreExemptions));
    }
  } else if (mode === 'range') {
    const [baseRef, headRef] = positional;
    if (!baseRef || !headRef) {
      writeStderr('range mode requires two refs: --mode=range <base> <head>');
      process.exit(2);
    }
    // One -U0 diff for the whole range (was: one git invocation per
    // changed file), grouped into per-file line sets for the
    // allowIf-windowed scan.
    const addedByFile = addedLinesByFile(collectRangeAddedLines(REPO_ROOT, baseRef, headRef));
    for (const [f, added] of addedByFile) {
      violations.push(...scanFileAddedLinesOnly(f, added, ignoreExemptions));
    }
    violations.push(...scanRangeCommitBodies(baseRef, headRef));
  } else if (mode === 'commit') {
    violations.push(...scanCommitBody());
  } else if (mode === 'file') {
    const [fp] = positional;
    if (!fp) {
      writeStderr('file mode requires a path: --mode=file <path>');
      process.exit(2);
    }
    violations.push(...scanFile(relative(REPO_ROOT, resolve(fp)), ignoreExemptions));
  } else {
    writeStderr(`Unknown mode: ${mode}`);
    process.exit(2);
  }

  if (violations.length === 0) {
    writeStdout('No banned phrases detected.');
    return;
  }

  writeStderr('Banned-phrase violations detected:');
  for (const v of violations) {
    writeStderr(`  ${v.source}:${v.line}:${v.column}  "${v.phrase}"`);
    writeStderr(`    > ${v.context}`);
  }
  writeStderr('');
  writeStderr('Phrases banned by CLAUDE.md — "Architectural Approach" section:');
  writeStderr('  for now, interim, temporary, pragmatic, simpler approach, middle ground,');
  writeStderr(
    '  for momentum, just this commit, deferred*, out of scope*, good enough, sufficient for now',
  );
  writeStderr(
    '  (* = allowed only with plan phase reference OR owner+deadline+finding-ID for "deferred",',
  );
  writeStderr('     ADR/review/plan reference for "out of scope")');
  writeStderr('');
  writeStderr(
    'If the match is on a legitimate discussion (e.g., ADR documenting rejected alternative),',
  );
  writeStderr('add the path to EXEMPT_PATHS in tools/gates/banned-phrase.ts AND document why.');
  process.exit(1);
}

main();
