# ARIA Phase-1 PoC

Operator decision tool. Pure-mechanical analysis of this repository — no LLM, no API, no network (except optional `npx nx graph` subprocess).

**Spec:** `docs/aria/CONTRACTS.md` §13.

## Why this exists

`docs/aria/SPEC.md`, `docs/aria/IDENTITY.md`, and `docs/aria/CONTRACTS.md` describe a system that does not yet exist. Building the kernel is months of work.

This PoC answers **"do we even need ARIA?"** in one week of zero-LLM mechanical analysis. If the PoC's decision gate says no, the contracts are archived as research artifacts and no kernel is built.

## What it does

1. Walk filesystem (excluding `agent-workspace/`, `node_modules/`, `.git/`, `dist/`, `build/`, `.aria-poc/`, etc.)
2. Reconcile with `git ls-files`
3. Assign every file a fate (Coverage Invariant: `read_deeply` / `read_skimmed` / `skipped_with_reason`)
4. Compute `REPO_FINGERPRINT.json` (language histogram, manifest detection, service count, ADR count, agent count)
5. Ingest TRUSTED priors (mechanical, no LLM):
   - `CLAUDE.md` → `CLAUDE_MD_PRIORS.md` (heading inventory)
   - `docs/adr/[0-9][0-9][0-9]-*.md` → `ADR_PRIORS.md` (canonical only, title + status)
   - `.claude/agents/*.md` → `AGENT_PRIORS.md` (frontmatter description per agent)
6. Run `npx nx graph` (best-effort, optional)
7. Mechanical drift scan: TypeScript `enum` keyword vs PostgreSQL `CREATE TYPE ... AS ENUM`. Heuristic name match; report any name match where value sets differ.
8. Generate `.aria-poc/aria-poc-report.md` with the operator decision gate.

## Run

```bash
python3 tools/aria-poc/poc.py --workspace-root .
```

Or via Claude Code session:

```
/aria-poc
```

(see `.claude/commands/aria-poc.md`)

Optional flags:

- `--skip-nx-graph` — skip the `npx nx graph` subprocess (faster, useful when nx is broken)
- `--out-dir <path>` — output directory (default: `.aria-poc/`)

## Outputs (in `.aria-poc/`, gitignored)

| File | Content |
|---|---|
| `aria-poc-report.md` | The decision-gate report |
| `REPO_FINGERPRINT.json` | Mechanical repo summary |
| `CLAUDE_MD_PRIORS.md` | CLAUDE.md heading extraction |
| `ADR_PRIORS.md` | Per-ADR title + status |
| `AGENT_PRIORS.md` | Per-agent description |
| `BUILD_GRAPH.json` | Nx project graph (if available) |
| `MECHANICAL_DRIFTS.json` | TS enums, SQL enums, drift candidates |

## Decision gate (per CONTRACTS §13)

After running, answer YES/NO to each:

1. Did the fingerprint reveal anything you did not already know?
2. Did the mechanical drift scan surface real drift not caught by existing 38 specialized agents on PR cycles?
3. Is the value surface of (2) large enough to justify months of kernel work?
4. Is the LLM cost (Claude Code session-based, NOT direct API) within scope?

**3 of 4 NO** → archive contracts as research artifacts.
**3 of 4 YES** → proceed to Phase 0 (kernel skeleton).

## What this PoC does NOT do

- No skill genesis. No adapter birth. No capsule storage. No mastery levels.
- No LLM. No findings. No recommendations.
- No PR creation. No worktree. No baseline capture.
- No persistence beyond `.aria-poc/`.

## Code budget

- ≈630 lines (≈540 effective code lines, rest blank + docstring)
- Stdlib + pyyaml only
- Single file: `poc.py`
- Runs in ≈30 seconds on the full repo

## Known limitations (treated as proto-debt records per IDENTITY §3.6)

The PoC ships with these **known gaps**. Each is recorded here in proto-debt form to demonstrate the discipline (CONTRACTS §6.6). When full ARIA exists, these become real `aria-debts/DEBT-*.json` records with kernel-enforced lifecycles.

```
DEBT-POC-001 — Drift scan limited to TS `enum` keyword + SQL CREATE TYPE
  root_cause: TypeScript repos increasingly use union types
              (`type FarmStatus = 'active' | 'inactive'`) and Zod schemas
              instead of `enum`. PoC misses these entirely.
  short_term: regex confined to `enum` keyword, accepts incomplete coverage
  permanent_fix: extend detector to union literal types + Zod .enum() + GraphQL enums
  owner: poc-maintainer
  due: 2026-08-01
  severity: MEDIUM (~30% of real drift surface invisible to PoC)

DEBT-POC-002 — No frontend dropdown / select-options scan
  root_cause: drift between SQL enum and FrontendStatusSelect.tsx
              hard-coded options is a known pattern in this repo (see
              FarmStatusSelect.tsx canonical example), but PoC doesn't scan
              JSX/TSX option lists.
  short_term: limited to symbol-table-visible enums
  permanent_fix: add JSX literal-array detector for `<option value="...">`
                 patterns and `<Select options={...}>` patterns
  owner: poc-maintainer
  due: 2026-08-15
  severity: HIGH (this is exactly the surface the operator described in early
                  conversation as "FarmStatusSelect render 3 of 4 enum values")

DEBT-POC-003 — Jaccard threshold is hand-tuned (0.3)
  root_cause: false-positive vs missed-drift trade-off chosen mechanically
              (0.3 catches Drift 1 cross-service department drift while
              filtering DepartmentStatus-vs-department_type collision); no
              empirical validation across other repos.
  short_term: --jaccard-threshold flag; default 0.3 documented
  permanent_fix: full ARIA's Reflection engine (SPEC §4 Engine 5) calibrates
                 per-pattern threshold with shadow comparison
  owner: full-aria-implementer
  due: blocked-on-phase-0
  severity: LOW (operator can override via flag)

DEBT-POC-004 — Prior-audit scan is keyword-only
  root_cause: `scan_prior_audits()` greps for the literal enum NAME in
              `docs/audits|reviews|product-audits/`. Misses paraphrased
              mentions, conceptual mentions ("department taxonomy
              inconsistency"), or Turkish-language descriptions.
  short_term: name-only grep, accepts false negatives
  permanent_fix: full ARIA's TRUSTED-prior ingestion (SPEC §5.1) extracts
                 finding-level claims; scan compares structurally
  owner: full-aria-implementer
  due: blocked-on-phase-0
  severity: LOW (operator manually verifies "appears to be NEW signal" claims)

DEBT-POC-005 — No git-blame age data on drifts
  root_cause: when both sides of a drift are flagged, knowing which side
              was added later (and whether the other side was updated
              correspondingly) is decision-relevant evidence operator
              currently must compute manually.
  short_term: report shows file:line refs only
  permanent_fix: per-drift git-blame for both sides; "TS added 2024-08-15,
                 SQL updated 2026-04-12" → late-arriving-SQL signal
  owner: poc-maintainer
  due: 2026-09-01
  severity: LOW

DEBT-POC-006 — schema-invariants test not executed
  root_cause: repo has `e2e/tests/integration/schema-invariants.spec.ts`
              that may already enforce the contract surface. PoC reports
              drift candidates without checking whether the existing test
              would currently pass — duplicating known signal.
  short_term: drift report stands alone; operator manually correlates
  permanent_fix: invoke schema-invariants.spec.ts as part of phase 6 and
                 elide drifts that the test already enforces
  owner: poc-maintainer
  due: 2026-08-30
  severity: MEDIUM (potential duplicate signal noise)
```

These proto-debts demonstrate the discipline: **every known limitation has root cause + short-term action + permanent fix + owner + deadline.** No "we'll handle later". No "out of scope". No "for now". Per IDENTITY §3.6 Rule 2, the discipline applies even to the PoC's own README.

### What changed when these gaps were closed (this iteration)

The previous version of this PoC had the following gaps, identified in operator review and **closed** in the current version:

- ✅ Coverage Invariant proof: `FATES.json` now persisted (was: count-only in report)
- ✅ Git ↔ filesystem reconciliation: `GIT_RECONCILIATION.json` now explains the gap (was: silent 70-file difference)
- ✅ Prior audit findings comparison: `scan_prior_audits()` now greps `docs/{audits,reviews,product-audits}/` (was: every drift treated as new)
- ✅ Exit code discipline: `--fail-on-drifts N` flag, default 0 → exit 1 on any drift (was: always exit 0, CI-untestable)
- ✅ Better normalization: strip ONE suffix only + Jaccard ≥ 0.3 threshold (was: multi-suffix strip caused 23→12 drift inflation; now 12 above-threshold + 11 transparently filtered)
- ✅ Cross-service drift flag: `cross_service: bool` per drift, sorted to top of report (was: same-priority listing; now 5 cross-service drifts headline-flagged)
- ✅ Skimmed-files visibility: `SKIMMED_FILES.md` lists every read_skimmed file (was: 181-file count without enumeration)
- ✅ Artifact manifest: `INDEX.json` with checksums per generated file (was: no manifest)
