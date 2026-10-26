# ARIA Phase-1 PoC

Operator decision tool. `poc.py` is a pure-mechanical analysis of this repository — no LLM, no API, no network (except optional `npx nx graph` subprocess).

That claim covers `poc.py` only. The other modules in this directory are not the PoC, and several of them run LLMs and reach the network — see [Other contents of this directory](#other-contents-of-this-directory-not-the-poc).

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
7. Mechanical drift scan: TypeScript `enum`, string-literal union types, string `as const` arrays, Zod `z.enum([...])`, GraphQL SDL enums, frontend literal option groups, and PostgreSQL `CREATE TYPE ... AS ENUM`.
8. Promote UI option groups only when they sit on a frontend UI surface and relate to a named value-set concept. Value overlap alone is not enough.
9. Enrich candidates with git-blame metadata, named gate/test references, and summary counts.
10. Generate `.aria-poc/aria-poc-report.md` with the operator decision gate.

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

| File                      | Content                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `aria-poc-report.md`      | The decision-gate report                                                                                |
| `REPO_FINGERPRINT.json`   | Mechanical repo summary                                                                                 |
| `CLAUDE_MD_PRIORS.md`     | CLAUDE.md heading extraction                                                                            |
| `ADR_PRIORS.md`           | Per-ADR title + status                                                                                  |
| `AGENT_PRIORS.md`         | Per-agent description                                                                                   |
| `BUILD_GRAPH.json`        | Nx project graph (if available)                                                                         |
| `MECHANICAL_DRIFTS.json`  | Value sets, SQL enums, annotated UI option groups, drift candidates, evidence summary                   |
| `FATES.json`              | Per-file fate ledger (Coverage Invariant proof: `read_deeply` / `read_skimmed` / `skipped_with_reason`) |
| `SKIMMED_FILES.md`        | Every `read_skimmed` file, enumerated                                                                   |
| `GIT_RECONCILIATION.json` | Explains the git ↔ filesystem gap                                                                      |
| `INDEX.json`              | Artifact manifest with a sha256 checksum per generated file                                             |

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
- No AST import tracing. Dynamic UI option providers and computed enum adapters remain invisible.

## Code budget

The budget covers the PoC only: `poc.py` and `invariants/test_poc.py`. The modules under [Other contents of this directory](#other-contents-of-this-directory-not-the-poc) are not part of it.

- Stdlib + pyyaml only (pyyaml optional, for agent frontmatter), plus two repo-local helpers: `drift_wire.py` and `tools/shared/excluded_paths.py`
- Source: `poc.py`; tests: `invariants/test_poc.py`
- Runs in ≈30 seconds on the full repo

## Other contents of this directory (not the PoC)

These modules grew beside the PoC. None of the PoC's "no LLM, no API, no network" claims apply to them. The ones marked **LLM/network** spawn a model CLI, call a model API, or download from GitHub. Each role below is taken from the module's own docstring.

ARIA executor runtime:

| Module                       | Role                                                                                                                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci_executor.py`             | **LLM/network.** The ARIA CI executor: one next-pending → claim → invoke Claude Code CLI → submit-result cycle per GitHub Actions run (`.github/workflows/aria-agent-executor.yml`).                              |
| `ci_executor_drain.py`       | **LLM/network.** Batch (drain) mode for the scheduled executor lane. It decides what runs next and dispatches each request through `ci_executor.py`'s single-request argv.                                        |
| `ci_executor_judge_batch.py` | **LLM/network.** The batch judge child: K read-only judge requests answered in one model call.                                                                                                                    |
| `ci_executor_lease.py`       | Hands the executor's hold on a claim back to the kernel on every exit of the executor body.                                                                                                                       |
| `worker_executor.py`         | **LLM/network.** The per-assignment counterpart to `ci_executor.py` (Plan 025 §E): reads a dispatch assignment, runs the work in its worktree through the Claude Code CLI, and submits the worker result.         |
| `claude_runtime.py`          | **LLM/network.** The executor-side SSoT for ARIA's live LLM runtime: agents run through the Claude Code CLI.                                                                                                      |
| `codex_runtime.py`           | **LLM/network.** Codex CLI runtime bridge: bounded `codex exec` spawns mapped onto the shared typed-failure vocabulary.                                                                                           |
| `zai_runtime.py`             | **LLM/network.** Z.ai (GLM) runtime: a distinct HTTP transport to the Z.ai subscription API, never a redirected managed CLI.                                                                                      |
| `zai_tool_loop.py`           | **LLM/network.** The Z.ai write runtime (ARIA-HIGH-434): a kernel-owned tool loop that speaks Z.ai's function calling from outside every sandbox and runs each tool call under the Claude writer's gate and room. |
| `zai_room_child.py`          | The file tools of the Z.ai write runtime (Read, Write, Edit, Glob, Grep), run by `zai_tool_loop.py` inside the room, one call per room, under `python -I`.                                                        |
| `hook_probe.py`              | **LLM/network.** Plan 032b-2 probe: one bounded `claude -p` turn on the live runner that proves the execution envelope's deny rule and PreToolUse hook bind.                                                      |
| `dispatch_failure.py`        | The typed executor failure contract. Both executors call it to classify a failed dispatch into a closed vocabulary.                                                                                               |
| `status_answers.py`          | Classifies a vendor CLI's login-status answer before its exit code.                                                                                                                                               |
| `kernel_cli.py`              | The one spelling of a kernel CLI subprocess an ARIA executor runs.                                                                                                                                                |

Adapters, which the kernel runs as tools:

| Module                              | Role                                                                                                                                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapter_scope.py`                  | The one predicate (`is_excluded_source`) deciding which non-production sources (specs, `__tests__`, `.test.ts`, migrations, `node_modules`, `dist`) the cqrs and outbox adapters never read.                               |
| `agent_harness_security_adapter.py` | Plan 020 Phase 10 agent-harness security adapter: six detection rules over agent prompts, workflows, ARIA tooling and the kernel (workflow token scope is workflow-shell-safety-adapter's, ARIA-LOW-592).                  |
| `banned_phrase_adapter.py`          | Wraps the `tools/gates/banned-phrase.ts` Node CLI and emits its result in the kernel runner's observation/finding shape.                                                                                                   |
| `cqrs_adapter.py`                   | Plan 020 Phase 14.B: flags a controller that skips the command/query bus or injects a repository directly.                                                                                                                 |
| `dual_alias_adapter.py`             | Checks that every module-resolution surface maps both `@aquaculture/backend-common` and `@platform/backend-common` to the same entrypoint.                                                                                 |
| `outbox_adapter.py`                 | Flags a domain event published around the transactional outbox (a dual write).                                                                                                                                             |
| `shadow_runner.py`                  | Minimal SHADOW-phase adapter shim for end-to-end smoke runs. It emits zero findings.                                                                                                                                       |
| `genesis_adapter_launcher.py`       | The kernel launcher every skill-genesis drafted adapter runs under (ARIA-HIGH-414): it checks the bytes against their digest, loads exactly the import allowlist, and installs the audit hook before the adapter compiles. |

Drift-scan support and one-off tools:

| Module                         | Role                                                                                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drift_wire.py`                | Wire semantics for the mechanical drift scan, imported by `poc.py`.                                                                                                                                   |
| `fetch_supergraph.py`          | **Network.** Downloads the composed supergraph (`supergraph-sdl` artifact) that the nightly drift scan judges wire values against. It accepts only the artifact that is exact for the cycle's commit. |
| `seed_drift_findings.py`       | Seeds ARIA findings from a fresh PoC mechanical drift scan at HEAD.                                                                                                                                   |
| `seed_experiment_recipes.py`   | Registers this repository's experiment recipes (`experiment-recipes.json`) on the kernel's bench.                                                                                                     |
| `measure_watchdog_fp_rate.py`  | V10.5 watchdog soak harness: computes the watchdog's false-positive rate from the finding-event fold.                                                                                                 |
| `backfill_validated_chains.py` | Plan 020 Phase 9.A backfill: emits `change_validated` rows for Plan 019 committed chains that lack one.                                                                                               |

Other files: `ci_executor_contract_proven.md` (the Claude Code CLI invocation contract the executors follow), `experiment-recipes.json` (the recipe data `seed_experiment_recipes.py` registers), `migrations/` (one-off ledger migration scripts), and `invariants/` (tests for the PoC and these modules, run by `.github/workflows/aria-kernel.yml`).

## Known limitations (treated as proto-debt records per IDENTITY §3.6)

The PoC ships with these **known gaps**. Each is recorded here in proto-debt form to demonstrate the discipline (CONTRACTS §6.6). When full ARIA exists, these become real `aria-debts/DEBT-*.json` records with kernel-enforced lifecycles.

```
DEBT-POC-001 — Dynamic frontend dropdown providers remain invisible
  root_cause: drift between SQL enum and frontend status selectors is a
              known pattern in this repo. PoC now records literal
              `<option>`, `<MenuItem>`, `options={[...]}`, and named
              option arrays, but dynamic providers loaded from API data or
              computed constants still require a real adapter.
  short_term: literal UI option groups only; high-confidence promotion gate
              prevents broad false positives
  permanent_fix: add AST-based JSX/TS adapter that traces imported option
                 providers and component props
  owner: poc-maintainer
  due: 2026-08-15
  severity: HIGH (literal version of the operator's "FarmStatusSelect renders
                  3 of 4 enum values" case is covered; dynamic forms are not)

DEBT-POC-002 — Value-set adapters are regex-level, not AST-level
  root_cause: PoC must stay zero-dependency and cheap. It scans TS enum,
              union literals, string `as const` arrays, Zod enum calls, and
              GraphQL SDL enums mechanically, but it does not resolve imports,
              aliases, generated schema files, or computed values.
  short_term: every extracted value-set carries `kind`, `ref`, and `surface`;
              absence claims stay capped
  permanent_fix: first full ARIA adapter should be a TS/JS AST adapter with
                 import tracing and repo-calibrated false-positive metrics
  owner: full-aria-implementer
  due: blocked-on-phase-0
  severity: MEDIUM

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
  root_cause: `scan_prior_audits()` greps for the literal value-set NAMES
              on both sides of a drift in
              `docs/audits|reviews|product-audits/`. Misses paraphrased
              mentions, conceptual mentions ("department taxonomy
              inconsistency"), or Turkish-language descriptions.
  short_term: name-only grep, accepts false negatives
  permanent_fix: full ARIA's TRUSTED-prior ingestion (SPEC §5.1) extracts
                 finding-level claims; scan compares structurally
  owner: full-aria-implementer
  due: blocked-on-phase-0
  severity: LOW (operator manually verifies "appears to be NEW signal" claims)

DEBT-POC-005 — schema-invariants test not executed
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

DEBT-POC-006 — Existing gate references are named-contract search only
  root_cause: PoC should not run the full test suite or infer semantic
              coverage. It scans invariant/e2e/workflow files for named enum
              contracts, not for arbitrary missing values.
  short_term: `existing_gate_refs` is evidence of nearby named coverage,
              not proof that the drift is already enforced
  permanent_fix: Phase 0 validation spine should map findings to runnable
                 affected tests and store pass/fail evidence
  owner: full-aria-implementer
  due: blocked-on-phase-0
  severity: LOW
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
- ✅ `.github/` coverage: filesystem walk no longer excludes `.github/**` by accident
- ✅ TS union literal scan: `type XStatus = 'a' | 'b'` now participates in value-set drift
- ✅ Literal UI option scan: `<option>`, `<MenuItem>`, inline `options`, and named option arrays are recorded with frontend-surface and concept-relationship gates
- ✅ Value-set surface expansion: string `as const` arrays, Zod `z.enum([...])`, and GraphQL SDL enums now participate in the value-set ledger
- ✅ UI promotion metadata: raw UI groups now include `promotion_status`, `promotion_reason`, and `nearest_value_sets`
- ✅ Decision evidence: drift candidates now include git-blame metadata and named existing gate/test refs
- ✅ Summary: `MECHANICAL_DRIFTS.json` now includes value-set kind counts, UI promotion counts, and novelty counts
- ✅ PoC unit tests: stdlib `unittest` coverage added for discovery, value-set extraction, UI grouping, relationship matching, and false-positive suppression
