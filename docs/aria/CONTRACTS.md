<!-- ARIA-LIVE-AUTHORITY: docs/aria/CURRENT_STATE.md and executable contracts supersede stale
runtime/provider/branch statements in this document. -->

<!-- ARIA-CURRENT-STATE-NOTICE: This document may contain historical state. For normative current
state, see docs/aria/CURRENT_STATE.md and executable contracts. -->

# ARIA Contracts & Phase-1 PoC

> **Purpose:** Data schemas, protocol contracts, and the minimum-viable Proof-of-Concept the
> operator can run next week to test if ARIA is worth building
> **Companion to:** `SPEC.md` (boundaries) and `IDENTITY.md` (behavior)
> **Authority:** Subordinate to SPEC.md
> **Length budget:** ≤700 lines

## 0.1 — Snowball v9 Root Contract

The kernel now has two separately bound v2 roots:

- Workspace root: `~/.aria/workspaces/<repo_hash>/`, or `--workspace-base` for tests/CI. It owns
  feedback, pressure, workspace governance, and `aria-state/integrity_index.json`.

- Tools root: `--tools-dir`, `ARIA_TOOLS_DIR`, or `aria-tools`. It owns runs, health, cycle
  lifecycle, tools governance, and `integrity_index.json`.

Both roots have `repo_identity.json`. Workspace identity records `aria_workspace_contract_version:
2`; tools identity records `aria_tools_contract_version: 2`, `bound_repo_hash`, and
`bound_repo_root`. `integrity verify` reports nested `workspace` and `tools` sections and returns
drift when identities, versions, or covered ledger hashes disagree.

Fresh bootstrap is symmetric. If `<workspace>/repo_identity.json` is absent and no covered workspace
ledger exists, the first workspace-mutating or read-touching command bootstraps v2 and writes
`workspace_bootstrapped` governance with `{workspace_root, schema_version, repo_hash}`. If
`<tools-dir>/repo_identity.json` is absent and no covered tools ledger exists, the first
tools-mutating command bootstraps v2 and writes `tools_root_bootstrapped` governance with
`{tools_dir, schema_version, bound_repo_hash}`. If identity is absent but covered state exists, the
command fails closed instead of guessing ownership.

Bootstrap writes are atomic: temp file write, atomic rename, integrity index update, governance
event. If a crash leaves `repo_identity.json` without `integrity_index.json`, `integrity verify`
reports `bootstrap_incomplete`/index drift; the next bootstrap-capable command resumes by rebuilding
the missing index.

Discovery does not touch workspace files. On a v1 workspace it writes only to the tools root, and
cycle lifecycle rows are tools-owned. Workspace cycle artifacts are not created by discovery.

Covered ledgers are:

- Workspace: `unknowns`, `missed_signals`, `external_feedback`, `pressure`, `pressure_state`,
  `since_migration_events`, `governance`.

- Tools: `runs`, `health`, `cycles`, `governance`. Optional tools ledgers become integrity-covered
  when present: `problem_clusters`, `triage_decisions`, `dispatch_requests`, `worker_results`,
  `verification_results`, and `agent_fitness`.

Workspace rollback force-discard writes discarded rows to
`<workspace>/aria-memory/since_migration_events.jsonl`; the file is a normal workspace ledger and is
covered by `ledger_hashes`. Tools rollback force-discard writes
`<tools-dir>/since_migration_events.jsonl`; it is covered by optional
`integrity_index.json.file_hashes["since_migration_events.jsonl"]` when present. Missing
`file_hashes` is valid for roots that have no file-level artifacts.

Feedback and pressure rows use v2 schemas. Feedback IDs are stable `FB-...-<sha16>` values from
canonical identity. Pressure dedup is based only on `pressure_evidence_fingerprints_emitted`,
computed from primitive, subtype, and the set of feedback event IDs.

Governance known kinds include `workspace_bootstrapped`, `tools_root_bootstrapped`,
`tools_root_bound`, `vocabulary_loaded`, `vocabulary_normalization_drift`, `learning_hook_failed`,
`learning_hook_items_failed`, `pressure_decayed`, `cycle_artifact_archived`,
`pressure_closed_via_trailer`, `pressure_addresses_recorded`, `pressure_trailer_ignored`,
`pressure_satisfied_by_skill`, `agent_removed`, `feedback_escalated_to_trusted`,
`ref_stale_detected`, `reverify_action_recorded`, `vocabulary_extension_proposed`,
`vocabulary_extension_approved`, `agent_report_ingested`, `report_ingestion_skipped`,
`report_ingestion_cache_missing`, `semantic_cluster_merged`, `pressure_triaged`,
`dispatch_request_created`, `dispatch_request_state_changed`, `agent_resolution_failed`,
`worker_result_accepted`, `worker_result_rejected`, `verification_gate_passed`,
`verification_gate_failed`, `agent_fitness_computed`, `agent_dispatch_quarantined`,
`worktree_pruned`, `discovery_dirty_tree_skipped`, `lock_reaped`, `migration_started`,
`migration_phase`, `migration_completed`, `orphan_partial_backup_cleaned`, `rollback_started`,
`rollback_phase`, `rollback_completed`, and `tool_unhealthy`. Unknown kinds remain additive-open and
parse with warning semantics.

Default governance actor: if `ARIA_ACTOR` is set, parse it as JSON `{kind, id, session?}`. Otherwise
use `{kind: "human", id: "<user>@<hostname>"}`.

### 0.1.1 — State-transaction bound (`ledger.state_transaction`)

Every governed writer — a claim, a release, a submit, a cycle's governance row, the publish/replay
orchestrator — reaches a ledger through one ordered acquisition: manifest state-group locks, then
integrity-index locks, then concrete file locks, each bucket sorted by absolute path. The wait for a
LIVE holder is bounded by ONE deadline for the whole acquisition, `ledger.STATE_LOCK_LIVENESS_SECONDS`
(900 s), not by a wait per lock: each lock is asked only for the time that remains, so a writer behind
a wedged group holder and a wedged file holder fails at the bound, not at N times it. The bound is a
liveness guard DERIVED from the longest legitimate holder, never a performance budget or a count typed
beside it: three `state_store` regions keep one transaction open across tree-or-remote-scaled git
steps, each capped at `state_store.GIT_TIMEOUT_SECONDS` — the resumed accepted-loser recovery
(fetch, fast-forward, probe), the rebase (fetch, then `reset --hard` or a fast-forward) and the
checkout cleanup (probe, worktree removal) — each written as an arc in
`state_store_lifecycle_arcs.STATE_TRANSACTION_ARCS`, and the bound is the longest arc's sum (the
recovery: 3 x 300 s). A registered step from a lifecycle arc that no transaction arc prices (a push,
a worktree add) is refused by the raw git runner while a transaction is held
(`state_store_transaction_git_step_unpriced`); a wedge fails loudly as
`state_transaction_liveness_bound_exhausted: bound=<s> lock_ordinal=<n>
lock=<path>`. A caller passes `timeout_seconds` only when it knows its holder (a probe that must not
wait, a fixture proving lock order). Readers of a writer-owned ledger (the worker-result gate's
claim check) take the same ordered acquisition, never a bare file lock. One layer up, the
state-store lifecycle lock (checkout, publish, recovery) waits
`state_store.STATE_STORE_LIFECYCLE_LIVENESS_SECONDS` — the holder's longest arc at the git cap,
DERIVED from the code rather than typed beside it: every tree-or-remote-scaled git call under the
lock (push, fetch, ls-remote, reset, merge, worktree add/remove, checkout, rm) is a registered step
in `state_store_lifecycle_arcs`, each arc the lock is held across is written as the steps it runs
(the pending-recovery replay every arc starts with: fetch, fast-forward, probe; one publish attempt
at its longest: push, probe, reconciliation fetch, the rebase's fresh fetch, the tree move — for
`PUBLISH_MAX_ATTEMPTS` attempts; the checkout: probes, fetch, the recovery, the old store's
removal, the new worktree), and the bound is the longest arc's sum
(`STATE_STORE_PUBLISH_ARC_SECONDS`, `STATE_STORE_CHECKOUT_ARC_SECONDS`). A metadata-scaled call
(rev-parse, cat-file, update-ref, …) is classified as such and not priced; a call in neither class
fails `tests/test_state_lifecycle_arcs_derived.py`, which walks the lifecycle-locked and the
state-transaction regions' AST and checks the steps each region reaches against its arcs, and the raw
runner refuses a tree-or-remote-scaled call made under the lock outside a registered step.
`tests/test_state_lock_arcs_traced.py` runs the holders (a lost-race publish, a resumed recovery, a
checkout over an existing store) and checks the steps they spawn under the lock and under each
transaction equal the registered arc in order and multiplicity; `tests/test_state_lock_liveness_bound.py`
pins the numbers and every executor and workflow figure that cascades from them. The executor's job
reserve (`ci_executor_drain.JOB_RESERVE_SECONDS`) reads the restore and publish arcs from the same
derivation.

## 0.2 — Phase-2A Learning Pass Contract

Each cycle runs an ordered learning pass before normal cycle work:

1. `decay_recompute`
2. `artifact_prune`
3. `vocabulary_reload_check`
4. `git_trailer_scan`
5. `agent_satisfaction_scan`
6. `report_ingestion_scan`
7. `semantic_dedup_compute`
8. `trust_escalation_derive`
9. `ref_staleness_check`
10. `triage_policy_apply`
11. `agent_fitness_score` (weekly-gated)

Hooks are idempotent. Hook-to-hook communication is ledger-only; no shared in-memory hook state is
authoritative. Workspace integrity drift, workspace precondition failures, and tools lock failures
fail closed and abort the cycle. Local hook failures such as malformed hook config or unparsable
hook-local files write workspace governance `learning_hook_failed` with `{hook_name, error_class,
error_message, traceback_first_line?}` and the next hook continues.

A hook that processes a batch contains failure per item: one bad item costs that item, never the
batch. The hook's payload then carries `item_failures` as `[{item_kind, item_id, error_class,
error_message}]`, the runner reports that hook `partial` rather than `ok`, and workspace governance
records `learning_hook_items_failed` with `{hook_name, failure_count, failures}` — the failure list
sampled to the first 20 so one pathological cycle cannot flood the ledger. `LedgerIntegrityError` is
never contained this way: a corrupt ledger aborts the cycle rather than being demoted to one item's
problem. A hook with no contained failures omits `item_failures` entirely and stays `ok`.

Pressure decay thresholds default to `{faded: 90d, sleeping: 180d, archived: 365d}` and may be
overridden by `<workspace>/aria-config/decay_thresholds.json` using integer day values or strings
like `"90d"`. The cycle recomputes effective non-terminal pressure age and appends necessary
`pressure_state.jsonl` transitions with reason `decay_recompute`. If any transitions are written,
workspace governance records `pressure_decayed` with `{transitions, total, cycle_id}`. Terminal
`closed` and `satisfied` pressures never decay.

Artifact pruning archives only non-ledger cycle artifacts with default TTL `365d`. Workspace cycle
files matching `<workspace>/aria-state/cycles/cyc-*.json` use their filename timestamp. Tools
discovery artifact directories under `<tools-dir>/discovery/<cycle_id>/` use cycle timestamp when
present and filesystem mtime as fallback. Archives are moved under
`<workspace|tools>/.archive/<year>/...`. Hash-covered ledgers are never archived by this hook. Each
archive emits `cycle_artifact_archived` governance in the root that owns the artifact.

Completed cycle outputs include `git_head_sha_at_cycle` in both the tools cycle completion event and
workspace cycle artifact. The value is `git rev-parse HEAD` at cycle start, or `null` outside a Git
worktree / on timeout.

`vocabulary_reload_check` recomputes the failure-mode vocabulary marker. If the marker is unchanged
it is a no-op; if it changes it writes `vocabulary_loaded` and updates the workspace integrity
index.

`git_trailer_scan` scans from the previous completed cycle's non-null `git_head_sha_at_cycle` to
`HEAD`. It supports strict `Closes-Pressure: PE-...` and `Addresses-Pressure: PE-...` trailer lines.
`Closes-Pressure` writes a `closed_signal` feedback row and directly appends `pressure_state` with
reason `commit_trailer_closed`; the existing manual `closed_signal` threshold path remains
unchanged. `Addresses-Pressure` writes `pressure_addresses_recorded` with `{pressure_event_id,
commit_sha, trailer_kind, changed_files, cycle_id}`. Unknown pressure IDs, malformed trailer lines,
and comma-separated trailer values write `pressure_trailer_ignored`. Git timeout, non-zero git exit,
OSError while reading commits, or cycle artifact parse errors are operational hook failures and
write `learning_hook_failed`.

`agent_satisfaction_scan` reads `.claude/agents/*.md`, `.claude/agents/product-audit/*.md`, and
`agents/aria-*.md`, excluding `.claude/agents.legacy/**`. Missing directories and empty matches are
no-ops. It parses a stdlib-only minimal frontmatter subset for `addresses_pressure` inline or
block-list values. Frontmatter alone never satisfies pressure; satisfaction requires matching
genesis/proposal evidence or `pressure_addresses_recorded` whose `changed_files` includes the agent
path. `<workspace>/aria-state/agent_index.json` is rebuildable state; first build emits no removals,
later missing agents emit `agent_removed`, and satisfied pressure is never reopened by agent
deletion.

Feedback v2 may include `observed_commit` and `evidence_chain`. `feedback add` records `git
rev-parse HEAD` when available; `feedback import` reads HEAD once for rows missing
`observed_commit`. Missing or null `observed_commit` means `ref_stale: unknown`. `--evidence-chain`
accepts repeatable JSON objects with `source_type`, `reference`, and `trust_level`; one malformed
entry fails the whole operation. `trust_escalation_derive` marks a capability gap trusted when three
distinct feedback sources exist and emits `feedback_escalated_to_trusted`. `ref_staleness_check`
samples at most 100 refs per cycle and emits `ref_stale_detected` for stale, missing, or unknown
evidence.

`pressure reverify` supports dry-run, apply with `--acknowledge --reason`, and cursor reset. Dry-run
mutates nothing. Apply archives only faded/sleeping non-terminal pressures whose evidence refs are
all stale or missing and whose feedback is older than 30 days; active pressures return
`needs_operator_review` and are never auto-archived. The cursor lives at
`<workspace>/aria-state/reverify_cursor.json`.

`vocabulary_rejections.jsonl` is a workspace ledger covered by integrity. Failure-mode validation
rejection writes to it only when workspace paths are available. Three rejections in 90 days for the
same surface/parser cluster emit one `vocabulary_extension_proposed`;
`vocabulary_extension_approved` requires explicit operator approval and does not automatically edit
vocabulary.

`telemetry export --format prometheus|otel` writes to stdout by default, with optional `--output`.
Required metrics include pressure state counts, effective magnitude, hook failures, decay
transitions, trailer closes/addresses, satisfied pressures, removed agents, trusted pressure count,
stale refs, reverify actions, vocabulary rejections/proposals, archived artifacts, report ingestion,
semantic cluster size, triage totals, dispatch request counts, worker result counts, verification
gate totals, and per-agent fitness score.

`auto_merge.py` remains explicit opt-in operational tooling. No learning hook, reverify path, trust
path, satisfaction path, or default autonomous dispatcher path may call `merge_if_green`.

### Phase-3 Autonomous Learning Closure

`report_ingestion_scan` reads `docs/reviews/_registry/findings.jsonl` without modifying it. The
first missing `<workspace>/aria-state/ingested_findings.json` creates a baseline only. A later
missing cache writes `report_ingestion_cache_missing`, rebuilds the baseline, and emits no feedback.
Default backfill is 100 rows; registries over 500 rows require `--confirm-large-backfill
--acknowledge` at call sites that expose backfill.

`semantic_dedup_compute` deterministically clusters active pressures using stdlib token cosine, same
surface/parser from `capability_gap_key`, and overlapping evidence ref roots. It writes derived
cluster rows to `<tools-dir>/problem_clusters.jsonl`; `capability_gap_key` remains authoritative.

`triage_policy_apply` writes `<tools-dir>/triage/decisions.jsonl` with tier `auto_fix_safe`,
`needs_review`, `human_only`, `observe`, or `blocked`. Stale-only evidence becomes `observe`; unsafe
or unresolved cases become `human_only`/`blocked`, never auto-dispatch. New or calibrating agents
are capped at `needs_review`; quarantined agents block dispatch.

`worker dispatch --pressure-event-id PE-...` writes a dispatch request only. `--prepare-worktree
--acknowledge` is required to create `aria-worktrees/<assignment_id>/`. Dispatch rows include
`assignment_id`, `pressure_event_id`, `target_agent`, `triage_tier`, `worktree_path`, `base_sha`,
`required_tests`, `expected_trailer`, and `state`. If the target agent cannot be resolved from an
explicit argument, triage decision, or routing table, no dispatch row is created and
`agent_resolution_failed` is emitted.

`worker-result submit --from-worktree <path>` resolve-normalizes the path against the dispatch
request. Mismatches write `worker_result_rejected` with reason `worktree_path_mismatch`. Accepted
results store `worktree_path`, `base_sha`, `head_sha`, allowed validation commands, and an inline
unified diff capped at 1 MB.

`verification verify --assignment-id A-...` reruns allowed validation commands inside the worker
worktree and checks the expected trailer. `auto_fix_safe` expects `Closes-Pressure: PE-...`;
`needs_review` expects `Addresses-Pressure: PE-...`. Auto-merge evaluation is skipped unless
`--auto-merge-eligible` is explicitly set, and even then remains bounded by the existing low-risk
policy.

Snapshot mode enum is `{committed, working_tree, staged}`. `committed` is the default and CI mode;
it reads the HEAD-tracked snapshot and ignores dirty/staged changes with a governance event.
`working_tree` is Phase-1 supported and includes dirty/staged/untracked files. `staged` is Phase-2
reserved.

Fail-closed bootstrap/migration codes are CLI error codes, not governance events, because the root
lock/ownership is not trusted yet: `tools_migration_required = 10`, `ambiguous_tools_root = 11`,
`workspace_migration_required = 12`, `binding_mismatch = 13`, `repo_resolution_failed = 14`.

Tools migration and rollback run under `tools.lock`. Workspace migration and rollback are
intentionally lock-less in Phase-1 stabilization and assume single-operator semantics; concurrent
workspace migrate/rollback is operator responsibility until Phase-2 locking is specified.

Run status enum owner is `aria-kernel/aria_kernel/tool_health.py::RUN_STATUSES`; new runner statuses
must be added there before any producer emits them.

---

## 0 — Why this document exists

`SPEC.md` defines what the system must obey. `IDENTITY.md` defines how the system must behave.
Neither tells an implementer **what data shapes flow between engines** or **what the smallest
runnable thing looks like.**

Without that, two implementers reading SPEC + IDENTITY would produce two incompatible systems that
both technically satisfy the laws. This document closes that gap.

It is also the operator's decision tool: the Phase-1 PoC at the end (§13) is the smallest concrete
artifact that answers "do we actually need ARIA?" before committing to months of kernel work.

**Honesty floor:** the PoC at §13 IS implemented (`tools/aria-poc/poc.py`). All other schemas are
contracts for code that has not been written.

---

## 0.6 — CLI Execution Model (NEW — corrects v7.2 API assumption)

ARIA does **not** run as a standalone Python daemon calling the Anthropic API directly. ARIA runs
**inside Claude Code CLI sessions**. This changes substantially what the kernel needs to implement.

### Component map (CLI mode)

| Concern                                           | v7.2 assumed                               | Reality (CLI mode)                                                                                    |
| ------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Orchestrator                                      | Custom Python daemon                       | Claude Code session driven by slash command (`/aria-cycle`) and/or cron-launched `claude` invocations |
| Engines (Discovery, Memory, Pressure, Reflection) | In-process Python modules                  | Python scripts in `tools/aria/` invoked via `Bash` tool                                               |
| Adapters                                          | In-process Python ABCs                     | Python scripts in `tools/aria/adapters/` invoked via `Bash`; output JSON to disk                      |
| Skills                                            | Subclasses of `Skill` Protocol             | Sub-agent definitions in `.claude/agents/aria-*.md`; invoked via Claude Code `Agent` tool             |
| Hooks (gates, redactor)                           | In-process Python                          | `.claude/settings.json` PreToolUse / PostToolUse hooks, e.g. `tools/aria/gates/*.ts`                  |
| LLM amplification                                 | Direct `anthropic` SDK calls               | Claude Code's own model selection — kernel never imports `anthropic`                                  |
| Budget tracking                                   | Custom `budget_gate.py`                    | Claude Code's existing cost telemetry + a thin observation hook                                       |
| Cycle scheduler                                   | Custom Python timer                        | OS cron / systemd timer running `claude /aria-cycle`                                                  |
| State persistence                                 | Same — filesystem + workspace-internal git | Same                                                                                                  |
| Kill switch                                       | Same — file sentinel checked at every step | Same — slash command checks sentinel before tool calls                                                |

### What this means for the §1–§12 contracts

- `Adapter` and `Skill` classes (§1, §2) are still useful, but:
  - Adapters are **invoked from Bash by Claude Code**, not imported as Python modules. They read a
    target file and write a JSON result.

  - Skills are **sub-agent markdown files** with a metadata header that maps to the `Skill`
    Protocol's fields (`scope`, `minimum_mastery`, `claim_types`).

- The Cycle State Machine (§11) is implemented as **explicit steps inside the `/aria-cycle` slash
  command**, not as a Python `match` statement. Crash recovery happens because Claude Code sessions
  are themselves resumable / re-runnable.

- LLM Call Discipline (§10) is **mostly delegated to Claude Code**. The kernel still owns:
  - Secret redaction (must run before any data is shown to Claude in tool results)
  - Customer-data redaction
  - Budget observation (read Claude Code's telemetry, fail closed if cap exceeded)
  - Episodic logging of which tool calls were made
- The Capsule, Spine, Evidence Chain, Finding, Critical Observation, Pressure, Calibration schemas
  (§3–§9) are **unchanged** — they are file-format contracts, independent of execution model.

### What this kills from v7.2

- `aria-kernel/aria_kernel/llm_bridge.py` EXISTS (ORPHAN-MEDIUM-771 correction: this bullet
  used to say it does not). It is the SINGLE sanctioned LLM-wrapper boundary — the one entry in
  the agent-harness security adapter's `_APPROVED_WRAPPERS` allowlist that may touch the
  Anthropic SDK; no other kernel module imports `anthropic`.

- The `ANTHROPIC_API_KEY` requirement in SPEC §6.5 Day-0 prerequisites — the operator already
  authenticated with Claude Code; no separate key.

- The custom budget circuit breaker as a primary cost-enforcement mechanism — Claude Code is the
  primary; ARIA's budget gate is a secondary observability layer.

### What this saves

- ≈40–60% of the kernel implementation budget. No need to write LLM call orchestration, retry logic,
  prompt caching, streaming, error handling — all of that lives in Claude Code already.

- No API key management, no rotation, no leakage surface beyond what Claude Code already manages.

### Implications for trust boundaries

- ARIA does not have **independent** authentication to Anthropic. ARIA's "trust" is the operator's
  Claude Code session.

- A compromised ARIA cannot exfiltrate via direct API — it can only do what Claude Code session
  permissions allow. This is a **smaller attack surface** than the v7.2 design assumed.

- Conversely: ARIA cannot run truly headless. There must be a Claude Code session for the slash
  command to execute. Operator presence (or a cron+session pattern) is required.

### Skills are EMERGENT, not imposed

**Critical principle (operator-enforced):** ARIA does not arrive with a pre-defined set of
`.claude/agents/aria-*.md` sub-agent files. Doing so would put ARIA in a box — a fixed-shape system
imposed on the repository, exactly the opposite of "the structure that takes the shape of the
container".

The right model:

```text
Day 0: zero aria-* sub-agent files in .claude/agents/
       ↓
Pressure (Engine 3) detects a recurring problem ARIA cannot solve
with existing tools (e.g. "spine drift between TS enums and SQL types
recurring across services")
       ↓
Skill Genesis Pipeline (Engine 4):
  1. Birth request (gap defined precisely)
  2. Capability check (no existing tool covers it)
  3. Draft from genesis template
  4. Sandbox (3+ scenarios pass)
  5. Shadow (14 days parallel comparison)
  6. Metric gate (precision ≥ 0.85, zero critical FP, scope mastery sufficient)
       ↓
Promotion: skill becomes .claude/agents/aria-spine-drift.md
           — born from this repo's actual pressure, not predefined
       ↓
Mortal: degraded performance → CALIBRATE → DEPRECATE → ARCHIVE
```

The kernel ships with no behavioral skills. It ships with: orchestrator slash command, redactor,
banned-phrase gate, integrity check, kill switch — pure infrastructure. **What ARIA learns to
detect, and how, comes from operating on this specific repository.**

A different repository would produce a different set of `aria-*.md` files. The shape comes from the container.

### Documents in this folder, after CLI clarification

| Document                                  | What it describes                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SPEC.md`                                 | Boundaries (laws, engines, mastery, claim authority). Mostly unchanged by CLI mode; references to `anthropic` SDK are inaccurate but non-load-bearing. |
| `IDENTITY.md`                             | Behavior. Unchanged by CLI mode.                                                                                                                       |
| `CONTRACTS.md` (this)                     | Data + protocol contracts + CLI execution model + Phase-1 PoC.                                                                                         |
| `ROADMAP.md`                              | Physical phase gates after the PoC decision. Details link to `docs/aria/plans/`.                                                                       |
| `plans/`                                  | Decision-complete implementation plans for Phase 0 kernel, skill/agent genesis, and validation harness.                                                |
| `plans/004-self-renewal-feedback-loop.md` | How missed signals, false positives, and external scanner disagreements become pressure without becoming trusted findings.                             |
| `.claude/knowledge/layer-1-aria.md`       | Discoverable knowledge anchor for OTHER specialized agents — not ARIA's own configuration.                                                             |

---

## 1 — Adapter Protocol

Adapter'lar ARIA'nın repo'yu okuduğu soyut arayüzlerdir. Her biri bir dilin/format'ın belirli bir
pattern'ini deterministic + LLM-siz extract eder. Kernel hiçbir dile/framework'e doğrudan bağlanmaz;
bağlanmayı adapter'lar üstlenir.

> Aşağıdaki Python kod bloğu **adapter sözleşmesini** tanımlar. Her dil/format için yazılan Python
> script bu Protocol'ü uygular. `parse()` saf fonksiyondur: aynı (path, content) girdisi her zaman
> aynı `AdapterResult` döndürmeli; yan etki yok, network yok, eval yok.

```python
class Adapter(Protocol):
    name: str                    # e.g. "typescript-nestjs-cqrs"
    version: str                 # semver, owned by adapter author
    file_globs: list[str]        # e.g. ["apps/*/src/**/*.ts"]
    excluded_globs: list[str]    # e.g. ["**/*.d.ts", "**/__tests__/**"]

    def can_parse(self, path: Path) -> bool:
        """Cheap accept check (extension + manifest sniff). No full parse."""

    def parse(self, path: Path, content: bytes) -> AdapterResult:
        """Full structural parse. Deterministic, sandboxed, no network, no eval."""

    def parse_window_signature(self, path: Path) -> str:
        """Stable hash of features this adapter cares about. Used by Mastery
        Downgrade Protocol (IDENTITY §12) to detect when a file moved beyond
        the adapter's parse window."""
```

> Aşağıdaki dataclass adapter'ın çıktısını sabitler. Memory engine kapsül oluştururken **bu shape'i
> bekler**; herhangi bir adapter bu yapıyı bozarsa kernel reject eder.

```python
@dataclass(frozen=True)
class AdapterResult:
    symbols: list[Symbol]          # functions, classes, types, exports
    imports: list[Import]          # what this file imports
    exports: list[Export]          # what this file exports
    annotations: list[Annotation]  # decorators, attributes, pragmas
    parse_errors: list[ParseError]
    parser_version: str            # for cache invalidation
    parsed_at: datetime
```

### 1.1 — Bu repo'nun şekli: 14 pattern eksen

ARIA'nın "su gibi şekil alması" iddiasının test edilebilir olması için adapter set'in bu 14 ekseni
karşılaması zorunlu. Eksen-adapter eşleştirmesi §1.2'de.

| #   | Eksen                         | Pattern manifesti                                                           | Hangi servisleri etkiler              |
| --- | ----------------------------- | --------------------------------------------------------------------------- | ------------------------------------- |
| 1   | CQRS folder topology          | `commands/ handlers/ queries/ query-handlers/` per domain                   | 17 backend                            |
| 2   | Event contracts               | `BaseEvent extends` + JSON Schema + upcaster chain                          | event-store + tüm event publisher'lar |
| 3   | Outbox pattern                | `@PublishToOutbox` + outbox table + consumer                                | 12 service                            |
| 4   | Dual-alias                    | `@aquaculture/backend-common` ↔ `@platform/backend-common` aynı modül      | tüm backend                           |
| 5   | NATS BEGIN GENERATED          | `services.yaml` SSoT → `nats.conf` generated region (ADR-015)               | infrastructure                        |
| 6   | Schema drift validator        | `SchemaDriftModule.forRoot` per service, boot-time check (ADR-012)          | 13 schema-owning                      |
| 7   | Banned-phrase enforcement     | `tools/gates/banned-phrase.ts` CI gate (CLAUDE.md)                          | tüm commit'ler                        |
| 8   | Nx graph weighting            | `nx.json` + `project.json` dependency depth                                 | 17 backend + 7 frontend               |
| 9   | Tenant scoping discipline     | `getScopedRepository()` + tenant_id where-clause + JWT trust anchor         | tüm tenant-data services              |
| 10  | Sensor protocol register maps | Modbus / OPC UA / Atlas EZO register definitions                            | sens-api-gateway + sensor-service     |
| 11  | Path → agent mapping          | `apps/auth-service/**` → `auth-security-expert`, vs.                        | 38+ agent ↔ 17+7+1 servis            |
| 12  | Sensor-ingestion sidecar      | Rust sidecar + NATS publish + TS consumer (hybrid runtime)                  | hybrid TS+Rust                        |
| 13  | TypeORM auto-mapping          | snake_case column ↔ camelCase property (drift değil, framework convention) | tüm TypeORM kullanan                  |
| 14  | NATS cert-CN identity         | `services.yaml` + cert mint + `verify_and_map: true` (ADR-014/015)          | NATS infrastructure                   |

### 1.2 — First-day adapter set (15 adapter, repo-aware)

Generic adapter (TypeScript-only / NestJS-only) yerine, her biri **belirli bir repo pattern'i** için
yazılmıştır. Sıra üretim önceliği — pressure'a göre adapter doğum sırası.

| #   | Adapter                            | Globs                                                                        | Ne çıkartır (pattern manifest)                                                                                                                                                    | Eksen           | Tamamlayıcı agent(lar)                         |
| --- | ---------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ---------------------------------------------- |
| 1   | `typescript-nestjs-cqrs`           | `apps/*/src/**/*.ts` minus `__tests__`                                       | `@CommandHandler`, `@QueryHandler`, `@EventsHandler`, command/query/event class defs, `commandBus.execute()` call sites, **command → handler → event chain**                      | 1               | data-expert, contract-parity-enforcer          |
| 2   | `typescript-event-contracts`       | `libs/event-contracts/src/**/*.ts` + event publisher call sites              | `BaseEvent extends` interfaces, `createBaseEvent()` factory calls, JSON Schema validators, upcaster transformations, **PascalCase eventType enforcement**                         | 2               | data-expert, contract-parity-enforcer          |
| 3   | `typescript-outbox`                | files importing `@platform/outbox` + `*.outbox.entity.ts`                    | `@PublishToOutbox` decorators, outbox entity registrations, publisher call paths, **entity → event → consumer matching**                                                          | 3               | data-expert, messaging-expert                  |
| 4   | `typescript-dual-alias`            | `tsconfig.json` paths + `import` statements across `apps/`, `libs/`          | resolves `@aquaculture/*` ↔ `@platform/*` to **canonical single module identity**; mismatched imports = alias-drift, NOT module-drift                                            | 4               | platform-kernel-expert                         |
| 5   | `typescript-tenant-scoping`        | files calling `getRepository\|getScopedRepository\|x-tenant-id`              | `getScopedRepository()` vs forbidden `getRepository()`, tenant_id where-clause discipline, JWT-claim-vs-header trust path                                                         | 9               | tenant-isolation-auditor, auth-security-expert |
| 6   | `typescript-nestjs`                | residual `apps/*/src/**/*.ts` not covered by 1–5                             | generic `@Module`, `@Controller`, `@Injectable`, `@Entity` (dual-alias-normalized), `@Body()`, **TypeORM camelCase↔snake_case framework convention** (NOT drift)                 | 13              | (generic NestJS)                               |
| 7   | `sql-typeorm-migration`            | `apps/*/src/database/migrations/*.ts`                                        | migration class extends, schema declaration (per ADR-011), table CRUD, **timestamp ordering**, BEGIN-GENERATED region detection                                                   | 6               | database-reviewer, data-expert                 |
| 8   | `sql-schema-invariants-delegation` | (no globs — orchestrator)                                                    | runs `e2e/tests/integration/schema-invariants.spec.ts` headlessly, parses pass/fail per invariant; **defers schema-drift detection to existing validator instead of duplicating** | 6               | database-reviewer                              |
| 9   | `nats-services-yaml`               | `infrastructure/nats/services.yaml` + `infrastructure/docker/nats/nats.conf` | services.yaml accounts list, nats.conf BEGIN-GENERATED region, **invariant: regenerate from services.yaml = exact byte match**                                                    | 5, 14           | infra-expert                                   |
| 10  | `rust-sensor-protocol`             | `sens-api-gateway/src/protocols/**/*.rs` + sensor protocol .md docs          | Modbus register map, OPC UA NodeIds, Atlas EZO command sets, **register definition ↔ TS DTO drift detection**                                                                    | 10, 12          | edge-expert, sensor-expert                     |
| 11  | `rust-sens-gateway-core`           | `sens-api-gateway/src/**/*.rs` minus protocols                               | tokio runtime, async fn signatures, spawn/TaskTracker discipline, offline queue patterns, IEC 62443 surface markers                                                               | 10              | edge-expert, edge-industrial-auditor           |
| 12  | `nx-graph`                         | `nx.json` + `apps/*/project.json` + `web/modules/*/project.json`             | parses `npx nx graph --json`, builds dependency depth map, **weights cross-service drift severity by graph distance**                                                             | 8               | infra-expert                                   |
| 13  | `agent-priors-mapper`              | `.claude/agents/*.md` + `.claude/shared/orchestrator-routing-table.md`       | agent name + scope from frontmatter, routing-table glob → agent mapping, **path → specialized-agent reference resolver** for finding `related_specialized_agent_domains`          | 11              | (meta — no specialized agent owner)            |
| 14  | `config-yaml-toml`                 | residual `**/*.{yaml,yml,toml,json}` not covered above                       | manifest sniff, package.json/Cargo.toml metadata, helm values, terraform IaC                                                                                                      | (none specific) | infra-expert                                   |
| 15  | `generic-bootstrap`                | everything else                                                              | extension histogram, manifest detection, regex import extraction (≈70%)                                                                                                           | (fallback)      | (fallback)                                     |

> **Sayım:** 15 adapter, 14 ekseni karşılar (8 adapter ekseni doğrudan kapatır; 1 delegation-only; 1
> meta; 2 generic NestJS+config; 2 jenerik fallback; 1 framework-convention adapter eksen 13'ü
> "drift değil" olarak işaretler).
>
> **Day-0 öncelik sırası (pressure-driven):** 1 → 7 → 6 → 12 → 13 → 9 → 5 → 4 → 3 → 2 → 8 → 11 → 10
> → 14 → 15. CQRS adapter ilk, çünkü 17 service'in tamamı bu pattern'de; Modbus en geç çünkü tek
> service'i etkiler. Pressure değişirse sıra değişebilir.

### 1.3 — Adapter discipline

- Pure function: `(path, content) -> AdapterResult`. No side effects.
- No LLM calls. Adapters are mechanical.
- Sandboxed: adapter process cannot exceed declared file scope.
- Crash-isolated: an adapter crash on one file does not stop Discovery.
- Parse errors reported as data, never raised into kernel.
- **Delegation > duplication:** if existing repo tooling (`SchemaDriftValidator`,
  `tools/gates/banned-phrase.ts`, `e2e/tests/integration/*-invariants.spec.ts`, `npx nx affected`)
  covers a check, the adapter wraps it instead of reimplementing. Reimplementation requires a
  `delegation-record.md` justifying why existing is insufficient.

---

## 2 — Skill Protocol

Every skill (linter-style local check, drift detector, capability auditor) implements this protocol.

```python
class Skill(Protocol):
    name: str                    # e.g. "tenant-id-where-clause-drift"
    version: str
    scope: SkillScope            # declared local scope, enforced by L1
    minimum_mastery: MasteryLevel  # M2 RELATED required to activate
    claim_types: list[str]       # which Claim Authority Matrix rows this skill emits

    def applicable(self, capsule: Capsule) -> bool:
        """Returns True if skill should run on this capsule. Cheap."""

    def analyse(self, capsule: Capsule, neighbors: NeighborView) -> SkillResult:
        """Produce observations / findings / uncertainties. MUST be
        bounded by declared scope — accessing capsules outside scope
        raises ScopeViolation (L1 enforcement)."""

@dataclass(frozen=True)
class SkillScope:
    file_globs: list[str]              # what files this skill examines
    capsule_types: list[str]           # what capsule types are read
    aggregator: bool                   # if True: reads capsules only,
                                       # never raw code outside scope
    cross_capsule_distance: int        # 0 = local only, 1 = direct
                                       # neighbors, 2 = neighbors of
                                       # neighbors. Hard cap: 2.

@dataclass(frozen=True)
class SkillResult:
    observations: list[Observation]
    findings: list[Finding]            # only if Claim Authorization Gate passes
    uncertainties: list[Uncertainty]
    metrics: SkillMetrics              # for Reflection
```

**Skill discipline:**

- Declared scope is structurally enforced; runtime violation = `ScopeViolation` exception, skill quarantined.
- Aggregator skills read capsules but **never** raw file content outside their declared scope.
- LLM amplification optional and budget-tracked (see §10).
- Every emitted finding carries the originating skill name + version for audit.

---

## 3 — Capsule Schema

The atomic knowledge unit. One capsule per node (file, symbol, capability).

```json
{
  "$schema": "aria/capsule/v1",
  "capsule_id": "caps_a3f9...",
  "node": {
    "type": "file" | "symbol" | "capability" | "module" | "service",
    "ref": "apps/auth-service/src/auth.controller.ts",
    "ref_type": "filesystem_path" | "symbol_fqn" | "capability_name"
  },
  "mastery": {
    "level": "DISCOVERED" | "PARSED" | "RELATED" | "VALIDATED",
    "evidence_basis": ["evid_..."],
    "promoted_at": "2026-05-02T10:30:00Z",
    "downgrade_history": [
      {
        "from": "VALIDATED",
        "to": "RELATED",
        "at": "2026-05-15T08:00:00Z",
        "reason": "test_linkage_broken: auth.controller.spec.ts removed"
      }
    ]
  },
  "freshness": {
    "captured_at": "2026-05-02T10:30:00Z",
    "expires_at": "2026-05-09T10:30:00Z",
    "source_signature": "sha256_of_file_content_at_capture",
    "parser_version": "typescript-nestjs@1.4.0"
  },
  "content": {
    "summary": "<short, drillable, never raw code>",
    "facts": [
      {"key": "imports_count", "value": 14},
      {"key": "exports_default", "value": "AuthController"}
    ],
    "interpretations": [
      {
        "claim": "appears to enforce JWT guard on all routes",
        "confidence": "suspected",
        "verification_status": "pending"
      }
    ]
  },
  "relations": [
    {
      "kind": "imports",
      "target_capsule": "caps_b1e7..."
    },
    {
      "kind": "tested_by",
      "target_capsule": "caps_c4d2..."
    }
  ],
  "evidence_anchors": [
    {
      "type": "file_line_range",
      "ref": "apps/auth-service/src/auth.controller.ts:1-47"
    }
  ],
  "owning_adapter": "typescript-nestjs",
  "schema_version": 1
}
```

**Required invariants:**

- Every capsule MUST have ≥1 `evidence_anchors` entry. A capsule with no anchor cannot be drilled
  down → fraudulent (L1 violation).

- `content.summary` is short prose, never embeds raw source code.
- `content.facts` are mechanical extractions (counts, names, refs); no judgment.
- `content.interpretations` are tagged with `confidence`; never collapsed into facts.
- `mastery.evidence_basis` MUST list the evidence IDs that justify the current level.

---

## 4 — Spine Schema

Cross-layer concept tracing. Spines are how ARIA detects drift between database, backend, frontend, contracts.

```json
{
  "$schema": "aria/spine/v1",
  "spine_id": "spin_farmstatus",
  "concept_name": "farm_status_enum",
  "members": [
    {
      "layer": "database",
      "ref": "farm.farms.status (enum)",
      "values": ["active", "inactive", "maintenance", "archived"],
      "capsule": "caps_db_farm_status"
    },
    {
      "layer": "backend_entity",
      "ref": "apps/farm-service/src/farm/entities/farm.entity.ts:FarmStatus",
      "values": ["active", "inactive", "maintenance", "archived", "draft"],
      "capsule": "caps_be_farm_status"
    },
    {
      "layer": "graphql_contract",
      "ref": "apps/farm-service/src/farm/graphql/farm-status.enum.ts",
      "values": ["active", "inactive", "maintenance", "archived"],
      "capsule": "caps_gql_farm_status"
    },
    {
      "layer": "frontend",
      "ref": "web/modules/farm-module/src/components/FarmStatusSelect.tsx",
      "values": ["active", "inactive", "maintenance"],
      "capsule": "caps_fe_farm_status"
    }
  ],
  "drift_detected": true,
  "drift_signature": "sha256_of_normalized_member_diff",
  "first_detected_at": "2026-05-02T10:30:00Z",
  "last_verified_at": "2026-05-02T10:30:00Z",
  "freshness_window_hours": 168,
  "schema_version": 1
}
```

**Drift signature stability:** the signature includes only structural diffs (which values are
missing where), not cosmetic ordering. Same drift state = same signature even if member order
changes.

---

## 5 — Evidence Chain Schema

Every finding's L1 compliance proof.

```json
{
  "$schema": "aria/evidence-chain/v1",
  "chain_id": "chain_xy12...",
  "claim_summary": "FarmStatus enum drifts between DB and frontend",
  "evidences": [
    {
      "evidence_id": "evid_001",
      "source_type": "code_reference",
      "trust_level": "CURRENT_STATE",
      "ref": "apps/farm-service/src/farm/migrations/0042-create-farm.ts:14-18",
      "captured_at": "2026-05-02T10:30:00Z",
      "captured_by": "skill:spine-drift-detector@1.2.0"
    },
    {
      "evidence_id": "evid_002",
      "source_type": "code_reference",
      "trust_level": "CURRENT_STATE",
      "ref": "web/modules/farm-module/src/components/FarmStatusSelect.tsx:8-22",
      "captured_at": "2026-05-02T10:30:00Z",
      "captured_by": "skill:spine-drift-detector@1.2.0"
    }
  ],
  "independence_check": {
    "passed": true,
    "rationale": "two code refs in distinct apps, no shared origin"
  },
  "self_output_check": {
    "passed": true,
    "rationale": "no evidence sourced from prior ARIA findings or capsule summaries"
  },
  "pattern_re_verification": {
    "applicable": false
  },
  "schema_version": 1
}
```

<!-- The judge-digest marker pairs in this file feed docs/aria/generated/JUDGE-DIGEST.md
     (rendered by aria-kernel/aria_kernel/contract_digest.py). Marked text is extracted
     VERBATIM — this file stays the SSoT; edit here, then regenerate the digest. -->
<!-- judge-digest:begin -->

**source_type allowlist:** `code_reference`, `external_authoritative_source`, `test_demand`,
`git_history`, `trusted_config_file`, `trusted_prior_doc` (CLAUDE.md, ADRs, knowledge layers per
SPEC §5.1). Anything else = L1 violation, claim rejected at the gate.

<!-- judge-digest:end -->

### 5.1 — Evidence-probe session contract (`evidence_probe.GitProbeSession`)

Every evidence ref is graded against the committed tree with a git probe (`git rev-parse` for the
baseline, `git show` / `git cat-file` for the path). The probes of ONE decision — a submission, a
belief, a finding, an expert panel, a debt, an acceptance-harness run — run on ONE session that the
decision constructs and threads through every `classify_evidence_ref` call:

- **Attempts and backoff.** One probe is tried up to `GIT_PROBE_ATTEMPTS` (3) times, each attempt
  bounded by `GIT_PROBE_ATTEMPT_TIMEOUT_SECONDS` (30 s), with `GIT_PROBE_BACKOFF_SECONDS` (1 s, 2 s)
  between attempts. A completed attempt — any exit code — is the answer; only a stall or a spawn
  failure is retried. One probe's worst case is `GIT_PROBE_WORST_CASE_SECONDS` (93 s).
- **Per-decision clock.** All probes of the decision share `EVIDENCE_VERIFICATION_LIVENESS_SECONDS`
  (300 s); once it runs out no further probe is spawned and every remaining ref grades
  `verification_unavailable` at once.
- **Baseline once.** The target commit is resolved once per decision with
  `git rev-parse --verify <target>^{commit}` and cached (under the requested name and the resolved
  id). A readable baseline means a non-zero path probe is a verdict about the PATH
  (`worktree_candidate`); an unreachable baseline (`bad object`, `not a git repository`) or a probe
  that did not answer grades `verification_unavailable` — the host's or the workspace's gap, never
  the agent's.
- **Pre-claim git gate.** The executor refuses to CLAIM a request when `git rev-parse HEAD` in the
  workspace does not answer through the same probe (`git_unavailable`); the request stays PENDING
  for a host whose git answers instead of burning a paid run the validator could not verify.
- **Evidence-target proof on the same session.** The `evidence_target_sha` override (ARIA-HIGH-022;
  `auto` = the workspace HEAD, resolved INSIDE the submit decision, not by the CLI) is proven on the
  decision's session: `rev-parse --verify` for existence, `merge-base --is-ancestor` for descent
  from the request's base. Git ANSWERING "no" is the request's fault (`GovernanceError`:
  `evidence_target_sha_unknown_commit`, `_not_descendant_of_base`); git NOT answering is
  `agent_invocations.EvidenceTargetUnavailable` — the decision rejects under
  `agent_evidence_verification_unavailable` and grades its refs at the same requested anchor through
  the same session, so the session's memory of the non-answer makes every ref
  `verification_unavailable` rather than `worktree_candidate` against a base the submitter did not
  cite.
- **Selection anchor gate on a session.** `next_pending_request`'s anchor probes (`cat-file -e`,
  `rev-parse --is-shallow-repository`) run on ONE session per selection and are tri-state
  (`AnchorVerdict`): `anchor_unreachable` needs git to have ANSWERED "not here" and "not shallow";
  a non-answer is `undecided` — the candidate is skipped and stays PENDING, no `anchor_stale` row is
  written, age still refuses without git. A selection that could claim nothing and could not decide
  something writes one `agent_request_anchor_undecided` governance row and raises
  `AnchorVerificationUnavailable`; the CLI prints `{"stop_reason": "anchor_verification_unavailable",
…}` non-zero and the drain stops by that name.
- **Drain worktree bracket.** With `executor.worktree_per_request`, the drain's `git worktree add`
  before a child and `git worktree remove` after it each run at `state_store.GIT_TIMEOUT_SECONDS`
  (`ci_executor_drain.REQUEST_WORKTREE_GIT_TIMEOUT_SECONDS`) and are priced into the child
  (`ci_executor.REQUEST_WORKTREE_WORST_CASE_SECONDS`). An add git did not answer starts no child —
  the request stays PENDING — and stops the drain (`worktree_unavailable`, breaker kind
  `subprocess_timeout`); a remove that did not answer is a breaker row, never a request failure.
- **Human-required record child.** The executor's `human-required record` children run at
  `HUMAN_REQUIRED_RECORD_TIMEOUT_SECONDS`, derived from the kernel's own worst case for that path
  (`human_required.HUMAN_REQUIRED_RECORD_WAIT_SECONDS` = one state transaction for the governance
  row + `notify.NOTIFY_WORST_CASE_SECONDS`: every channel at `SENDER_WALL_CLOCK_SECONDS` on a
  joined worker, then ONE transaction for the call's outbox rows) plus the kernel work allowance.
  The terminal-writer slot of `child_worst_case_seconds` is priced at the longer of the submit and
  the record.
- **`rejection_codes` on the submit response.** A rejected `agent submit-result` carries one machine
  code per prose reason (`rejection_codes`, same length and order as `reasons`, persisted on the
  rejection row). A rejection whose codes are ALL in
  `evidence_validator.EVIDENCE_VERIFICATION_UNAVAILABLE_CODES` is released by the executor as
  `evidence_verification_unavailable` (harness class, no requeue budget charged); any other code
  stays `submit_rejected`.

---

## 6 — Finding & Recommendation Schema

> **E21-c (ORPHAN-693) — event-sourced lifecycle.** `finding-events.jsonl` speaks a
> CLOSED vocabulary: `finding_emitted`, `finding_reproduced`, `finding_fix_verified`,
> `finding_status_changed`; replay REFUSES unknown types. `certainty` shrank to its
> producers — `CONFIRMED` is EARNED only by `finding_reproduced` (a matched red run of
> a finding-bound experiment recipe); `OBSERVED` is the mint default. `RESOLVED` via
> `finding_fix_verified` requires the SAME recipe re-running green with unforgeable
> run provenance; hand transitions follow `STATUS_TRANSITIONS` (RESOLVED/WITHDRAWN
> terminal). A future certainty grade re-enters the vocabulary only in the same PR
> that adds its producer.

```json
{
  "$schema": "aria/finding/v1",
  "finding_id": "F-247",
  "severity": "HIGH" | "MEDIUM" | "LOW" | "INFORMATIONAL",
  "status": "OPEN" | "IN_PROGRESS" | "RESOLVED" | "SUPPRESSED" | "WITHDRAWN",
  "claim_type": "spine_drift" | "naming_drift" | "convention_inconsistency" | "wrong_code" |
    "absence_in_scope" | "currency_gap" | "duplication" | "contradiction" | "test_disagreement" |
    "regression",
  "claim_summary": "FarmStatus enum drifts: DB has 4 values, frontend has 3",
  "certainty": "CONFIRMED" | "OBSERVED",
  "evidence_chain_id": "chain_xy12...",
  "originating_skill": "spine-drift-detector@1.2.0",
  "scope": {
    "files": ["apps/farm-service/src/farm/migrations/0042-create-farm.ts",
              "web/modules/farm-module/src/components/FarmStatusSelect.tsx"]
  },
  "related_specialized_agent_domains": ["data-expert", "frontend-expert"],
  "facts": [
    "DB enum values: [active, inactive, maintenance, archived]",
    "Frontend select renders: [active, inactive, maintenance]"
  ],
  "interpretations": [
    {
      "text": "Frontend may intentionally exclude 'archived' from user-selectable options",
      "verification_required": true
    }
  ],
  "recommendation": null,
  "created_at": "2026-05-02T10:30:00Z",
  "closes_in_commit": null,
  "schema_version": 1
}
```

<!-- judge-digest:begin -->

### `claim_type` allowlist (semantics)

The kernel rejects any finding emitted with a claim_type outside this list. New types require an ADR.

| Claim type                 | What it captures                                                                                                                                          | Min severity floor | Min evidence count                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------- |
| `spine_drift`              | Same domain concept differs across layers (DB vs entity vs DTO vs frontend).                                                                              | MEDIUM             | 2 (one per drifted layer)                                           |
| `naming_drift`             | Same concept named with different conventions across layers (`tenant_id` vs `tenantId` for the same column).                                              | LOW                | 2                                                                   |
| `convention_inconsistency` | A convention used uniformly in N places, broken in M places, no documented reason.                                                                        | LOW                | 3 (consistent samples + violator)                                   |
| `wrong_code`               | Bug — dead branch, unreachable return, swapped argument, missing await, swallowed exception, off-by-one, type-coerced equality with security implication. | MEDIUM             | 1 (single code ref + reasoning) — this is the **bug note** category |
| `absence_in_scope`         | Capability expected to exist but evidence not found in searched scope. Confidence cap 0.7 per L1 absence-claim discipline.                                | INFORMATIONAL      | searched-scope record + synonym list                                |
| `currency_gap`             | Dependency / pattern / library is N versions behind current stable. Informational only — recommendation requires L1 five-criteria gate.                   | INFORMATIONAL      | 1 (registry + repo usage ref)                                       |
| `duplication`              | Identical-or-near-identical code structure repeated ≥3 times. May be intentional.                                                                         | LOW                | 3                                                                   |
| `contradiction`            | Two evidences disagree (test asserts X, code does Y).                                                                                                     | MEDIUM             | 2                                                                   |
| `test_disagreement`        | Test name suggests behavior, test body asserts different behavior.                                                                                        | MEDIUM             | 1 (test ref)                                                        |
| `regression`               | ARIA's own action's baseline comparison failed — emergency.                                                                                               | HIGH               | baseline + comparison artifact                                      |

<!-- judge-digest:end -->

**Bug note as first-class concept.** A "bug note" is a Finding with `claim_type: "wrong_code"` and
`severity: MEDIUM` (default). Single code-reference evidence is sufficient because the code IS the
evidence. The operator's daily report includes a "Bug Notes" section listing all `wrong_code`
findings opened since last cycle, with file:line + drill-down. This is the surface the user
described as "ARIA depoyu gezerken bug notu alır".

When `recommendation` is non-null, it MUST contain the five recommendation evidences (per IDENTITY
§4 Step 8 Gate 3):

```json
"recommendation": {
  "proposed_change": "...",
  "evidence_repo_fit": {"ref": "...", "summary": "..."},
  "evidence_current_stable": {"source": "...", "version": "...", "verified_at": "..."},
  "evidence_authoritative_source": {"url": "...", "publisher": "RFC|OWASP|NIST|framework_official"},
  "evidence_migration_risk": {"breaking_changes": [], "rollback_plan": "..."},
  "evidence_repo_specific_value": {"measurement": "...", "delta": "..."},
  "cve_bypass_criterion_5": false
}
```

---

## 6.5 — Observation Schema (NEW — nuance-aware preliminary record)

An Observation is what ARIA produces when a candidate **survives mechanical detection but does not
survive Nuance Discrimination cleanly** (per IDENTITY §3.5). It is below the bar of a confirmed
Finding but above pure noise.

Observations exist so that ARIA does not lose nuance-flagged signals to time, but also does not
promote them to bug notes prematurely.

```json
{
  "$schema": "aria/observation/v1",
  "observation_id": "OBS-2026-05-02-0017",
  "claim_type": "naming_drift" | "convention_inconsistency" | "wrong_code" | "spine_drift" |
    "duplication" | "absence_in_scope",
  "apparent_issue": "tenant_id (snake_case) in farm.farms vs tenantId (camelCase) in FarmController DTO",
  "trigger_evidence": {
    "type": "code_reference",
    "ref": "apps/farm-service/src/farm/dto/create-farm.dto.ts:14"
  },
  "supporting_refs": [
    "apps/farm-service/src/farm/migrations/0042-create-farm.ts:18"
  ],
  "nuance_check_results": {
    "framework_convention": {
      "checked": true,
      "explanation_found": true,
      "explanation": "TypeORM auto-maps snake_case columns to camelCase entity properties; this is the documented framework contract.",
      "verdict": "DISMISSED_FRAMEWORK"
    },
    "documented_intent": {"checked": true, "explanation_found": false},
    "adjacent_test_demand": {"checked": false, "skip_reason": "framework check sufficient"},
    "versioning_context": {"checked": false},
    "git_history_intent": {"checked": false},
    "repo_side_comment": {"checked": false},
    "prior_suppression": {"checked": false}
  },
  "verification_status": "DISMISSED" | "PENDING_OPERATOR_REVIEW" | "ESCALATED_TO_FINDING",
  "rationale": "TypeORM camelCase property convention; not drift.",
  "promote_to_finding_if": [],
  "originating_skill": "naming-drift-detector@0.3.0",
  "created_at": "2026-05-02T10:30:00Z",
  "decided_at": "2026-05-02T10:30:00Z",
  "decided_by": "nuance_discrimination_protocol",
  "schema_version": 1
}
```

**Observation lifecycle:**

```text
[CANDIDATE_DETECTED] -> Nuance Discrimination Protocol (IDENTITY §3.5)
   any check yields TRUSTED explanation -> [DISMISSED]
   only repo-side comment plausible      -> [PENDING_OPERATOR_REVIEW]
   no check explains it                  -> [ESCALATED_TO_FINDING] (becomes F-*)

[PENDING_OPERATOR_REVIEW]:
   operator confirms "intentional"  -> [DISMISSED] + suppression record for skill
   operator confirms "real bug"     -> [ESCALATED_TO_FINDING] (becomes F-*)
   operator silent for 14 days      -> [DISMISSED] (default; logged in episodic)
```

**Why Observations are not Findings:**

- Findings require ≥2 independent evidences per L1; Observations require only the trigger evidence +
  nuance-check record

- Findings carry severity that drives SLA timers; Observations don't
- Findings appear in public daily reports; Observations appear only in the operator's "review queue"
  section

- Findings can ground recommendations; Observations cannot

**Why Observations are not noise:**

- They persist (versioned in `aria-memory/`)
- They count against skill calibration metrics (a skill producing 80% PENDING that all become
  DISMISSED is mis-calibrated)

- They surface to operator at controlled cadence — never lost

The "bug note" surface (per IDENTITY §3 + CONTRACTS §6 claim_type table) lives in **Findings**.
Observations are the **pre-bug-note** intake queue, where nuance is sorted before escalation.

---

## 6.6 — Architectural Debt Record (NEW — short-term workaround = tracked debt)

Every short-term action that does not permanently fix a verified problem creates an Architectural
Debt record. No silent debt accumulation. No "we'll do it later" without owner + deadline. Per
IDENTITY §3.6 Rule 3.

```json
{
  "$schema": "aria/architectural-debt/v1",
  "debt_id": "DEBT-2026-05-02-007",
  "originating_finding_id": "F-247",
  "originating_finding_evidence_chain_id": "chain_xy12...",
  "verification_status": "VERIFIED",
  "root_cause_summary": "Frontend FarmStatusSelect.tsx hard-codes 3 enum values; DB and backend define 4. The fourth ('archived') is intentionally hidden from end-user selection but the hiding mechanism is wrong: code copy not contract enforcement.",
  "short_term_action_taken": {
    "kind": "test_added" | "feature_flag" | "runtime_guard" | "api_narrowing" | "code_marker" |
      "no_action_yet",
    "ref": "web/modules/farm-module/src/__tests__/farm-status-select.spec.ts:42",
    "rationale": "Regression test asserts FarmStatusSelect renders exactly the 3 user-selectable values. If a fourth ever leaks through, test fails and forces awareness — but the underlying duplication remains."
  },
  "permanent_fix_required": "Replace hard-coded enum-value list in FarmStatusSelect.tsx with a derived list from FarmStatus enum filtered by an explicit predicate (e.g. `FarmStatus.userSelectable`). Remove the duplication; let the contract enforce the filter.",
  "permanent_fix_owner": "frontend-platform-team",
  "due_date": "2026-08-02T00:00:00Z",
  "severity": "MEDIUM",
  "current_status": "OPEN",
  "status_history": [
    {"status": "OPEN", "at": "2026-05-02T10:30:00Z", "by": "skill:spine-drift-detector"}
  ],
  "escalation_history": [],
  "auto_close_forbidden": true,
  "withdrawn_reason": null,
  "schema_version": 1
}
```

### Required fields (kernel rejects record without these)

- `originating_finding_id` — every debt must trace to a Finding
- `verification_status: VERIFIED` — debts cannot be created from PROVISIONAL findings
- `root_cause_summary` — passes banned-phrase gate (no "for now", "pragmatic", "good enough", etc.)
- `short_term_action_taken.kind` — one of the closed enum
- `permanent_fix_required` — concrete description of what real fix needs
- `permanent_fix_owner` — must be specific person OR specific team; not "the team", not "someone",
  not "TBD"

- `due_date` — required; CRITICAL severity ≤30 days, HIGH ≤60 days, MEDIUM ≤90 days, LOW ≤180 days

### Lifecycle (state machine, kernel-enforced)

```text
[OPEN]
  ↓ — someone declares working on it (commit referencing DEBT-id)
[IN_PROGRESS]
  ↓ — permanent fix shipped, original finding's evidence-chain re-verified passing
[RESOLVED]

[OPEN | IN_PROGRESS]
  ↓ — current_date > due_date
[OVERDUE]  ← daily-report headline; PR escalation comment if originating PR exists

[any state]
  ↓ — operator explicit action with recorded `withdrawn_reason`
  ↓ — withdrawn_reason itself passes banned-phrase gate
[WITHDRAWN]

❌ NEVER:
  auto-close on age
  silent disappearance from reports
  state change without operator action OR fix-shipped event
```

### Auto-close forbidden

Setting `auto_close_forbidden: true` means: even if the originating finding is marked resolved by
some other mechanism, the debt record itself stays alive until either:

1. A commit explicitly closes it with `Closes: docs/aria/debts/DEBT-XXX.md`, OR
2. Operator explicitly withdraws with `withdrawn_reason` (which passes banned-phrase gate)

### Where debts live

- Disk: `aria-debts/DEBT-*.json` (workspace-internal git-tracked)
- Index: `aria-debts/_index.json` with current state of every debt
- Source-side marker: `// aria-debt:DEBT-XXX` adjacent to the workaround code, so future readers see
  the debt directly

- Daily report: every OPEN/IN_PROGRESS debt due within 7 days appears in its own section
- Daily report: every OVERDUE debt is a headline line with age-since-overdue

This schema closes the loop on IDENTITY §3.6: a workaround without a debt record is rejected at the
kernel; a debt without an owner+deadline is rejected at the kernel; a debt past its deadline grows
louder, never quieter; a debt cannot be retired without an explicit operator reason that itself
follows the banned-phrase discipline.

---

## 7 — Critical Observation Schema

Critical observations bypass the ≥2-evidence requirement (single trigger sufficient per L1) but
cannot be lost.

```json
{
  "$schema": "aria/critical-observation/v1",
  "observation_id": "CO-2026-05-02-001",
  "severity": "CRITICAL" | "HIGH" | "MEDIUM",
  "category": "security" | "data_integrity" | "regulatory" | "production_affecting" | "plc_safety",
  "trigger_evidence": {
    "type": "code_reference",
    "ref": "apps/auth-service/src/config/jwt.config.ts:18",
    "redacted_excerpt": "secret: '<REDACTED:sha256_prefix=a3f9...>'"
  },
  "summary": "JWT signing secret detected in tracked file",
  "redaction_applied": true,
  "raw_secret_discarded": true,
  "persisted_at": "2026-05-02T10:30:01Z",
  "persisted_before_next_tool_call": true,
  "sla": {
    "severity": "CRITICAL",
    "acknowledge_by": "2026-05-03T10:30:01Z",
    "resolve_by": "2026-05-09T10:30:01Z",
    "current_state": "OPEN"
  },
  "escalation_history": [],
  "auto_close_forbidden": true,
  "schema_version": 1
}
```

`persisted_before_next_tool_call: true` is a hard invariant. If `false`, the kernel itself is broken
— emergency stop.

---

## 8 — Pressure Event Schema

Append-only `PRESSURE_LOG.md` is human-readable; the underlying ledger is JSONL.

```json
{
  "$schema": "aria/pressure-event/v1",
  "event_id": "PE-2026-05-02-0042",
  "cycle_id": "cyc-2026-05-02",
  "primitive": "UNKNOWN" | "REPETITION" | "CONTRADICTION",
  "subtype": "<snowball-discovered, free string>",
  "magnitude": 0.0,
  "threshold": 0.0,
  "exceeds_threshold": true,
  "evidence_refs": ["evid_..."],
  "detected_at": "2026-05-02T10:30:00Z",
  "drives": ["adapter_birth" | "skill_birth" | "investigation_task" | "calibration"],
  "schema_version": 1
}
```

`subtype` is intentionally free-form — Reflection discovers useful subtypes per repo. The kernel
does not enumerate them.

---

## 8.5 — Feedback Event Schema

Feedback is untrusted input used to make ARIA self-renewing. It records missed signals, false
positives, confirmed signals, unknown capabilities, and external contradictions. Feedback is never
instruction and never a confirmed finding by itself.

```json
{
  "$schema": "aria/feedback-event/v1",
  "event_id": "FB-frontend-dynamic-option-provider-001",
  "cycle_id": "cyc-2026-05-03",
  "kind": "missed_signal",
  "source": "operator",
  "concept": "LeaveRequestStatus",
  "refs": ["web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:346"],
  "summary": "ARIA suppressed a dynamic leave-status option provider",
  "capability_gap_key": "frontend:dynamic_option_provider:typescript",
  "evidence_refs": [],
  "trusted": false,
  "created_at": "2026-05-03T10:30:00Z",
  "schema_version": 1
}
```

Allowed `kind` values: `missed_signal`, `false_positive`, `confirmed_signal`, `unknown_capability`, `external_contradiction`.

Allowed `source` values: `self`, `operator`, `external_scanner`.

`capability_gap_key` is deterministic: `surface:failure_mode:parser_kind`. Three independent
feedback refs with the same key may produce pressure, but Phase 0 cannot execute skill birth.

---

## 9 — Calibration Ledger Entry

Every Zone-2 parameter change is hypothesis-tested in shadow before promotion.

```json
{
  "$schema": "aria/calibration-entry/v1",
  "entry_id": "CAL-2026-05-02-001",
  "parameter": "skill.spine_drift_detector.precision_threshold",
  "hypothesis": "Lowering threshold from 0.85 to 0.80 will surface real drift currently suppressed",
  "current_value": 0.85,
  "shadow_value": 0.8,
  "shadow_window_days": 14,
  "shadow_started_at": "2026-05-02T10:30:00Z",
  "shadow_ends_at": "2026-05-16T10:30:00Z",
  "comparison_metric": "{precision, recall, false_positive_rate}",
  "decision": null,
  "decision_at": null,
  "decision_rationale": null,
  "schema_version": 1
}
```

`decision` becomes one of `PROMOTED` / `ROLLED_BACK` / `INCONCLUSIVE` / `EXTENDED` after the shadow window.

---

## 10 — LLM Call Discipline (CLI mode)

ARIA does not call the Anthropic API directly. ARIA runs inside Claude Code. Claude Code owns model
selection, retries, prompt caching, streaming, and rate-limit handling. ARIA owns the **discipline
around** LLM use, not the LLM call itself.

### What ARIA still owns

```python
@dataclass(frozen=True)
class LLMTaskSpec:
    purpose: str                       # e.g. "summarize-capsule-content"
    suggested_tier: Literal["haiku", "sonnet", "opus", "fable"]   # advisory only
    redaction_passes_required: list[str]  # ["secret", "customer_data", ...]
    skill_attribution: str             # which sub-agent is doing this work
    expected_input_tokens_max: int     # for budget observation
```

`LLMTaskSpec` is metadata attached to every sub-agent invocation. It is recorded in the episodic log
so the operator can audit _what kind_ of LLM work each skill triggered, even though ARIA cannot
directly observe the underlying API call.

### Tiering policy (advisory)

When ARIA sub-agents are invoked, they declare their suggested tier. Operator and Claude Code
together decide actual tier:

- `haiku` — capsule summaries, small classification, mechanical-feel work where Claude amplifies a
  Python script's output

- `sonnet` — drift interpretation, finding text composition, weekly reflection
- `opus` — rare, cross-capability synthesis only

The operator can override globally via Claude Code settings; ARIA never disagrees.

### Mandatory ordering (every cycle step that yields data to Claude)

1. `secret_redactor` runs over **all tool results** before they enter Claude's context. Fail-closed:
   redactor error = step abort.

2. `customer_data_redactor` runs when scope flagged customer-data-bearing.
3. `budget_observer` reads Claude Code's cost telemetry **after** the step (not before — ARIA does
   not hold the call). If observed cost exceeds soft threshold, next cycle starts in degraded mode
   (skills skip LLM amplification, run mechanically only).

4. `episodic_log.record(task_spec, redaction_proof, observed_cost, kill_switch_state)`

The redactors are kernel-owned because **a Claude Code session sees raw tool results unless ARIA
scrubs them first**. Redaction is the only privacy layer that survives the API-handoff to Claude.

### Budget config (`aria-config/budget.json`)

```json
{
  "soft_observation_threshold_usd_daily": 20,
  "hard_observation_threshold_usd_daily": 100,
  "soft_observation_threshold_usd_monthly": 200,
  "hard_observation_threshold_usd_monthly": 1000,
  "on_soft_threshold": "degrade_to_mechanical_mode",
  "on_hard_threshold": "kill_switch_trigger"
}
```

Thresholds are USD because that is the unit Claude Code's telemetry exposes. ARIA cannot directly
enforce token caps (Claude Code owns that surface) but it can refuse to start the next cycle if
observed spend crosses thresholds — that surface IS in ARIA's hands via the slash command's
pre-flight check.

### What this kernel does NOT need to implement

- `anthropic` SDK integration. Forbidden. ARIA must not import it.
- Retry / backoff / rate-limit handling. Claude Code's job.
- Prompt caching primitives. Claude Code's job (ARIA may hint via cache-key suggestions in tool
  result metadata, but does not enforce).

- Streaming response handling. Claude Code's job.
- API key management. Operator + Claude Code's job.

`on_hard_stop: kill_switch_trigger` is the safe default — exceeding the cap halts ARIA, not silent
overrun. Operator must explicitly raise the cap to resume.

---

## 11 — Cycle State Machine

```text
[INIT] -> integrity_check_passed?
   no  -> [HALT_INTEGRITY_FAILURE]
   yes -> [READ_SELF]

[READ_SELF] -> [SEE_CHANGES]
[SEE_CHANGES] -> [DISCOVERY]
[DISCOVERY] -> coverage_invariant_satisfied?
   no  -> [HALT_COVERAGE_FAILURE]
   yes -> [UPDATE_CAPSULES]

[UPDATE_CAPSULES] -> [MEASURE_PRESSURES]
[MEASURE_PRESSURES] -> [MAYBE_BIRTH_TOOLS]
[MAYBE_BIRTH_TOOLS] -> [RUN_ACTIVE_SKILLS]
[RUN_ACTIVE_SKILLS] -> critical_observation_detected?
   yes -> [PERSIST_CRITICAL] -> [VALIDATE_CLAIMS]
   no  -> [VALIDATE_CLAIMS]

[VALIDATE_CLAIMS] -> [REFLECT_IF_DUE]   # weekly only
[REFLECT_IF_DUE] -> [GENERATE_REPORTS]
[GENERATE_REPORTS] -> kill_switch_present?
   yes -> [HALT_KILL_SWITCH]
   no  -> [SCHEDULE_NEXT] -> [HALT_CLEAN]

# Failure recovery
[HALT_*] -> last_known_good_state preserved
            cycle_id marked failed in episodic log
            next [INIT] reads failure record before READ_SELF

# Concurrency
[INIT] -> file_lock("~/.aria/workspaces/<hash>/aria.lock")
   contended -> [HALT_CONCURRENCY] (silent, exits 0)
```

**Crash recovery:** if the process dies between `READ_SELF` and `HALT_CLEAN`, the next cycle's
`INIT` detects the missing `HALT_*` marker and triggers integrity audit on all writes since the last
clean halt. Capsules written but not committed to workspace-internal git are rolled back.

**Concurrency model:** single ARIA instance per workspace. File lock is mandatory. A second instance
attempting to start exits 0 silently — no crash, no error report, no race.

---

## 12 — Backup & Restore

Workspace components by recoverability:

| Component                           | Source of truth                                 | Backup needed                               |
| ----------------------------------- | ----------------------------------------------- | ------------------------------------------- |
| `aria-kernel/`, `aria-immutable/`   | Versioned in separate kernel repo               | No (re-install)                             |
| `aria-grown/`                       | This workspace                                  | Yes — skills are unique investment          |
| `aria-memory/`                      | This workspace, internal git                    | Yes — knowledge is the product              |
| `aria-capsules/`                    | Regenerable from repo + adapters, but expensive | Optional (rebuild on restore is acceptable) |
| `aria-spines/`                      | Same as capsules                                | Optional                                    |
| `aria-indices/`                     | Regenerable from capsules                       | No                                          |
| `aria-findings/`, `aria-proposals/` | This workspace                                  | Yes — audit trail                           |
| `aria-config/`                      | Operator-managed                                | Yes (operator's responsibility)             |
| `aria-baselines/`                   | This workspace                                  | No (only useful for in-flight actions)      |
| `aria-worktrees/`                   | Transient                                       | No                                          |
| `aria-episodic/`                    | This workspace, append-only                     | Yes — audit trail                           |
| `private_reports/`                  | This workspace                                  | Yes — security record                       |

**Backup discipline:**

- Daily: `aria-memory/` (workspace-internal git push to operator-controlled remote)
- Weekly: full snapshot of `aria-grown/`, `aria-findings/`, `aria-proposals/`, `private_reports/`, `aria-episodic/`
- Restore validation: integrity check before restored kernel resumes operation
- No automated remote backup. Operator owns the backup destination — ARIA does not "phone home."

---

## 12.14 — Built Validation Child Environment

`aria-kernel/aria_kernel/validation_env.py` (ARIA-MEDIUM-066) owns the environment a validation
command runs under. The runner no longer copies its own process environment into the child: the
child's environment is BUILT from an explicit baseline (`VALIDATION_BASELINE_ENV_NAMES`: the
agent-spawn baseline plus `HOME`/`USER`/`LOGNAME`, the `XDG_*` roots, `CI`/`FORCE_COLOR`/`NO_COLOR`
and the hermetic git redirects `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`/`GIT_CONFIG_NOSYSTEM`), the
toolchain namespaces the allowed commands read (`VALIDATION_TOOLCHAIN_ENV_PREFIXES`: `PYTHON*`,
`NODE_*`, `NX_*`, `CARGO_*`, `RUST*`), and the variables the command itself declares. Three
classes never reach the child unless declared: secret-shaped names (`agent_env.SECRET_SHAPED_ENV_NAME`,
also applied inside an admitted prefix, so `NX_CLOUD_ACCESS_TOKEN` is dropped while `NX_DAEMON` is
passed), the durable-store bindings (`ARIA_TOOLS_DIR`, `ARIA_WORKSPACE_BASE`, `ARIA_REPO_STATE_ROOT`,
`ARIA_STATE_STORE_ROOT` — an in-cycle self-validation that runs the kernel suite otherwise writes
fixture state into the store `restore-aria-state` bound for the job), and the `GIT_CONFIG_COUNT`
triple / `GIT_DIR` location family (a CI publish step carries an `AUTHORIZATION` header under a
name the secret shape cannot recognise; a git hook exports `GIT_DIR` into its children).

Every `validation_runs` row the spawn seam writes carries a `spawn_environment` column
(`ValidationEnvReport.to_ledger()`): `passed` (every name the child saw), `declared` (the subset
the command declared and therefore overrode), `dropped_count`, `dropped_secret_shaped` and
`dropped_store_bindings` — names only, never values. The column is optional on the surface
(a caller recording a run executed elsewhere may not know it) and REQUIRED at the spawn seam;
`validation_runs_ledger._validated_spawn_environment` admits only the closed shape (exactly those
keys, sorted unique printable-ASCII names without `=`, bounded list lengths) and refuses rather
than truncates, because a truncated "what the child saw" is a claim the merge gate would honour.

`aria-kernel/tests/test_validation_env.py` owns the build rules (inherited store bindings and
secret-shaped names do not reach the child; `PATH`/`HOME`/`PYTHONPATH` and a declared variable do;
a declared value wins over an inherited one) and `test_validation_runs_unified_surface.py` owns the
ledger column through the real spawn seam.

## 12.15 — Plan Contract

`aria-kernel/aria_kernel/plan_contract.py` owns what a plan body must carry before it may CONVERGE,
and renders that rule everywhere a planner reads. The first plan the native chain ever drove to
CONVERGED (trial ten, 2026-09-12, `flow-85199a4b5051d7b27f16`) could not be staged:
`apply_engine.stage_converged_plan_for_pr` refused a plan-authored `npx nx run shell:test`
(`stage_validation_command_not_declared`) and would then have refused the missing
`architectural_tier` (`stage_requires_architectural_tier`). Neither rule was stated by any planning
contract, and by the time it fired the plan was CONVERGED and immutable.

The two rules, in the one wording the refusals use:

- `plan_content.architectural_tier` is REQUIRED of every agent-authored body and must be one of
  `change_ledger.ARCHITECTURAL_TIERS` (1 make it impossible, 2 make it automatic, 3 make it
  detectable, 4 document it — `ARCHITECTURAL_TIER_MEANINGS`). Reasons: `plan_architectural_tier_missing`,
  `plan_architectural_tier_invalid`.
- Every `plan_content.validation_commands[]` entry is either `{cmd}` naming one of the admissible
  commands — the canonical executable suite (`implementation_safety.CANONICAL_VALIDATION_COMMANDS_EXECUTABLE`:
  `npx nx affected --target=test`, `npx nx affected --target=lint`, `npm run type-check`,
  `npm run format:check`; matched
  after whitespace is collapsed, the bare `nx ...` form read as its `npx nx ...` spelling under
  `implementation_safety.executable_spelling`) or a registered recipe's command — or `{recipe_id}`
  naming a recipe registered with
  `experiment.register_recipe`. Reasons: `plan_validation_command_not_declared`,
  `plan_validation_recipe_unknown`. `resolve_declared_validation_command` is the ONE matching rule;
  staging reads it too, so what a planner was told is what staging runs.
- Every `plan_content.key_changes[]` entry is a string (one step) or an object
  `{id?, description, paths?}` (`plan_convergence.KEY_CHANGE_FIELDS`); any other object shape is
  refused as `plan_key_change_shape` (ARIA-HIGH-104 (3) — the implementer prompt used to read a
  `file` field no producer wrote).
- `plan_content.finding_id`, when present, names an origin `plan_origin` derives a commit contract
  for — `ORPHAN-<SEV>-NNN` or `F-NNN` / `F-AUTO-V<x.y>-<TOPIC>`; any other id is refused as
  `plan_origin_unrecognised` at submission and at the `plan_contract_complete` gate, the same read
  the implementation mint makes, so a plan the mint would refuse never CONVERGES (a registry-form
  `<PREFIX>-<SEV>-NNN` id is one the kernel does not contract: the review-file binding the commit-msg
  gate checks lives in the checkout's `findings.jsonl`, not the plan store, and no synthesizer source
  mints such a plan).

Where it is stated (rendered, never retyped): every planning envelope
(`convergent_planning_bridge.issue_challenger_envelope`,
`cross_review_bridge.issue_cross_review_envelope`, `cross_review_bridge.issue_primary_envelope`,
`plan_round_controller`) carries a `plan_contract` block (`render_plan_contract(base_dir)`: the tier
vocabulary with meanings, the canonical suite, THIS store's recipes, the refusal reasons) rendered
into the sealed prompt as `## Plan contract`; every delivered agent contract ends with the same
rules (`agent_contract.render_response_validator_contract`);
`.claude/knowledge/layer-2-aria-canonical-envelope.md` carries the prose mirror.

Where it is enforced (all through `plan_contract_violations`): `agent_invocations.submit_claim_result`
REJECTS a `primary_plan` / `challenger_plan` envelope whose body breaks it (`plan_contract: <reason>`;
the claim is released for a retry under the same sealed prompt — an accepted-then-unbridged envelope
would read as dead, ARIA-HIGH-080); `tools/aria-poc/ci_executor._pre_submit_validate_envelope` releases
with `plan_content_invalid:<reason>`; `plan_convergence.submit_challenger_plan` and
`plan_convergence.record_revision` (structured bodies) refuse before the event is appended
(`_validate_submitted_plan`, command path only — the fold keeps replaying every historical
`plan_started` without a tier); `plan_convergence.evaluate_plan` records a `plan_contract_complete`
gate row and turns an otherwise-CONVERGED decision into `NEXT_ROUND_REQUIRED` (`HUMAN_REQUIRED` at the
round cap) so no writer reaches CONVERGED around the submission refusal — the kernel-synthesized round-1
seed carries no tier by design (it is a pressure description, not an architectural claim), so round one
cannot converge on it and the drainer's primary-revision envelope carries each gate reason as a
`plan_contract:<reason>` obligation; staging keeps its own refusals as the last line.

`aria-kernel/tests/test_plan_contract.py` owns the module; `tests/test_plan_convergence.py` owns the
submission refusals, the historical fold and the gate row; `tests/test_agent_submit_result_e2e.py` owns
the acceptance-seam rejection; `tests/test_convergence_resumable_step.py` owns the carried obligations;
`tests/test_pr_manager_e2e.py` owns staging past both refusals.

## 12.16 — Native Fleet Admission: a probe that did not answer is not an auth fact

`aria-kernel/aria_kernel/native_admission.py` (split out of `model_fleet.py`, which keeps the fleet
declaration) owns one dispatch's whole-fleet decision; `aria-kernel/aria_kernel/status_probe.py` owns
the observation type and the liveness bound the decision is reached under. Measured on 2026-09-12
(trial eleven, host load ~7, `AIR-aria-primary-planner-31777217eba4` dispatch 03): the managed
Anthropic probe `claude auth status --json` stalled to its 20 s cap (`status_timeout`) and the
admission read the row like an auth refusal — anthropic not eligible, next vendor — so a converging
plan's primary planner ran on openai/gpt-6-astra while two dispatches earlier the same probe had
answered `available`. Operator decision on record (2026-09-12): opus is a leaf for its roles; read-only
roles fail over across vendors for AUTH reasons only (auth unavailable, quota exhausted or cooled), and
a probe that did not answer is neither.

The observation is three-valued BY CONSTRUCTION. Every `_RuntimeStatusObservation` carries a
required `decision: StatusDecision` named at the site that saw the answer — `AVAILABLE` (the vendor
confirmed the managed session / credential), `UNAVAILABLE` (the vendor or the ledger SAID no:
`managed_session_logged_out`, `api_key_auth_not_managed`, `managed_login_required`,
`cli_reported_not_logged_in`, a Z.ai 401/403, a Z.ai 429/402 or entitlement refusal,
`cli_unavailable`, `provider_not_configured`, `provider_quota_cooldown`,
`provider_readonly_runtime`, and the managed Codex route's decided refusals
`codex_managed_auth_file_unavailable` / `codex_managed_auth_directory_unavailable` /
`codex_cli_unavailable` / `codex_native_profile_controls_unavailable` —
`codex_runtime.ManagedCodexRouteUnavailable`, its own type beside the host's `SandboxUnavailable`)
or `UNDECIDED` (nothing was heard: `status_timeout`, `status_command_unavailable`,
`status_deadline_elapsed`, `status_not_confirmed` and `status_output_unrecognized` — both ONLY when
no status document or line was read —, `status_output_limit`, `control_plane_failure`, a transport
error, a vendor 5xx, a managed context this host could not bind). A contradictory row (auth
`unavailable` marked undecided, auth `unknown` marked available) cannot be built. Readers branch on
the type, never on a reason string. The Z.ai probe's `_classify` returns the decision beside
auth/quota/reason; a 429 is DECIDED unavailable with auth still `available`.

The answer decides before the exit code (verifier, 2026-09-12). Both managed CLIs report a
logged-out session as an answer AND a non-zero exit: Claude Code 2.1.269 prints `{"loggedIn": false,
…}` then `process.exit(loggedIn ? 0 : 1)` (read from the installed binary; reproduced offline with
an empty config dir), Codex 0.154.0 prints `Not logged in` and exits 1 (reproduced offline with an
empty `CODEX_HOME`). `tools/aria-poc/status_answers.py` owns the classification for both:
`classify_claude_status_answer(stdout, returncode)` reads the JSON document first (a boolean
`loggedIn` is the vendor's answer whatever the exit — logged out → `managed_session_logged_out`
UNAVAILABLE carrying `exit_code=1`), `classify_codex_status_answer(output, returncode)` reads the
line first (`Not logged in` → `cli_reported_not_logged_in` UNAVAILABLE, with the same read-only
PATH-alias-warning tolerance as the login lines). The exit code is consulted in the shared no-answer
arm and nowhere else — pinned structurally by `tests/test_status_answers_before_exit_codes.py` (an
AST scan: neither classifier compares `returncode`) and behaviourally through the real probes with
scripted binaries that mirror the installed exit codes; the lane fixtures
(`test_ci_executor_native_claude._fake_claude`, the smoke suite's Codex status fixture) exit as the
real CLIs do. The probes (`claude_runtime._probe_claude_auth_status`,
`codex_runtime._probe_codex_auth_status`) keep the spawn — environment boundary, per-attempt cap,
byte cap, reaping, the limiter's dead-bus arm — and hand the bytes to the classifier.

The liveness bound. `recheck_timeout_seconds` (genesis policy, 20 s) keeps its meaning as the cap of
ONE attempt. `status_probe.observe_until_decided` retries ONLY an undecided observation:
`STATUS_PROBE_ATTEMPTS` (3) attempts with `STATUS_PROBE_BACKOFF_SECONDS` (2 s, 5 s) between them, so
one provider costs at most `status_probe_liveness_seconds(cap)` = 3 × 20 + 7 = 67 s; a decided
observation — available OR unavailable — ends the retry at once. One `AdmissionClock` per admission
bounds the whole fleet: `native_admission_budget_seconds(policy)` = 67 s × fleet size (201 s). Every
attempt is offered `min(cap, remaining)`; once the clock is spent the observation is
`status_deadline_elapsed` with the attempts so far (zero for a member never reached). The executor
passes no deadline; the fleet builds the clock from the policy. The `ProbeRecord` beside the
observation lists EVERY undecided attempt's reason, the last one included, on both paths (attempts
exhausted, clock elapsed): `len(undecided_reasons)` is the number of attempts that established
nothing.

The ladder. `_native_runtime_admission` walks `_FLEET` in order and moves past a provider ONLY on a
DECIDED unavailable observation or a policy fact the row names (controls never bound —
`controls.status` "unknown", the metered policy's bare probe — or the monetary policy not applying).
The first provider still in contention whose row is neither eligible nor decided-unavailable halts
it, by the name of what stopped it: `AdmissionOutcome.PROVIDER_CONTROL_UNAVAILABLE` when the vendor
did not refuse but THIS host could not bind the route's controls (`controls.status` "unavailable":
an attempted binding that failed — the Claude arm's `sandbox_unavailable` after a decided-available
auth, the Codex arm's managed context failing on `SandboxUnavailable` / `ResourceLimitsUnavailable`
/ `OSError` before its probe, the limiter's `user_bus_unavailable`),
`AdmissionOutcome.PROVIDER_UNDECIDED` when the probe stayed UNDECIDED after its bound. A host fault
is not an auth reason any more than a stall is (operator decision 2026-09-12), so neither moves the
ladder. Both name `halting_provider` and leave `eligible_routes` EMPTY — a later vendor that
answered `available` is observed and recorded, never admitted (the type refuses an admission whose
outcome is in `HALTING_OUTCOMES` without a halting provider, or with one and a route). A
later-ranked provider that is undecided or unbindable behind an eligible one is skipped for this
admission and never cooled. `ADMITTED` (first eligible route runs) and `NO_ELIGIBLE_PROVIDER` (every
provider decided, none eligible) are the other two outcomes. The Codex arm reaches its host fault
BEFORE its probe (the managed context wraps the status command), so it is seen as an undecided probe
and retried within the bound first; the Claude arm reaches it AFTER a decided auth and is not
retried — the outcome, release and back-off are the same by name. A Z.ai transport error (timeout,
DNS, connection) is the stall class: UNDECIDED with controls "unknown", never a host control fault.
Every candidate row carries `decision` and `probe` (`{attempts, undecided_reasons,
backoff_seconds}`) so a reader can tell a stalled probe from a refused login from a broken host; the
whole decision rides the attempt row as `admission` (`as_row()`).

The executor. `tools/aria-poc/ci_executor._adaptive_pre_claim_admission` dispatches only on
`ADMITTED`; otherwise it records `runtime_admission_unavailable` with `reason` = the outcome and
`halting_provider`, writes the child's `refused` summary, and — on the inherited-claim path — releases
the claim under the reason its refusal was BUILT with. `ADMISSION_REFUSALS` is one
`_AdmissionRefusalKind(release_reason, failure_class, retryable)` per non-admitted outcome, so the
claims-ledger release and the summary shape cannot be declared apart: `provider_undecided` →
`native_runtime_provider_undecided`, `provider_control_unavailable` → `native_runtime_control_unavailable`
(both `harness_unavailable`, retryable — the host, not the request, and the daemon retries after a
back-off), `no_eligible_provider` → `native_runtime_admission_unavailable` (`policy_violation`, not
retryable); a task-binding refusal → `TASK_BINDING_REFUSAL` (the same general reason, `policy_violation`).
`harness_unavailable` is a member of `dispatch_failure.DISPATCH_FAILURE_CLASSES` (a refused summary
whose cause is the executor's own host); the drain never counts a refusal as a failure or a breaker
event. On the pre-claim path no claim is taken: the request stays PENDING with no attempt burned.
`native_runtime_provider_undecided` and `native_runtime_control_unavailable` are registered in
`release_reason.RELEASE_REASON_CODES` (`NATIVE_RUNTIME_PROVIDER_UNDECIDED`,
`NATIVE_RUNTIME_CONTROL_UNAVAILABLE`, harness) and `agent_invocations.HARNESS_FAULT_RELEASE_REASONS`,
so the requeue budget does not burn for a stalled or broken host.

The dispatcher. `planner_dispatch_hook.dispatch_one_pending_planner_request` reads the claim's release
row after the child exits and reports the halt status the release names (`ADMISSION_HALT_STATUSES`:
`native_runtime_provider_undecided` → `provider_undecided`, `native_runtime_control_unavailable` →
`provider_control_unavailable`; governance `planner_dispatch_<status>`);
`autonomous_planner_dispatcher.run_planner_dispatch_daemon` treats every status in the derived
`ADMISSION_BACKOFF_STATUSES` as a back-off tick — recorded, not counted as a dispatch, one poll interval
slept — exactly as the worker scheduler treats a provider cooldown, so a stalled or broken host is not
re-probed on the very next tick.

Pinned by `aria-kernel/tests/test_native_admission_undecided.py` (the type, the retry, the ladder for
both halts and the policy pass, the clock arithmetic, the refusal kinds, the hook and daemon statuses),
`tests/test_status_answers_before_exit_codes.py` (the answer-before-exit-code contract for both CLIs,
structurally and through the real probes; the managed Codex route refusal's type),
`tests/test_ci_executor_provider_undecided.py` (the real executor child: a probe that stalls once then
answers is admitted with its attempts on the row; one that stays undecided admits nobody — no openai
route although openai is up — and burns nothing; a logged-out document with exit 1 is DECIDED and a
read-only role fails over to openai on it; an unusable sandbox with the session logged in halts as
`provider_control_unavailable` naming anthropic; through the real planner hook three real 20 s stalls
release under `native_runtime_provider_undecided` and the hook reports `provider_undecided`),
`tests/test_ci_executor_live_path_smoke.py` (Codex `Not logged in` + exit 1 is decided once and the
fleet reaches `no_eligible_provider`) and `tests/test_native_admission_status_budget.py`
(ARIA-HIGH-075's arithmetic under the new bound).

## 12.17 — The Implementer→Merge Seam (ARIA-HIGH-104)

Five gaps between the implementation envelope and the gates behind it, each a rule one side enforced
and no contract stated. What is now true, in one derivation per fact:

- **The request row is the request envelope.** `agent_invocations.create_agent_invocation_request`
  writes `$schema` = `agent_contract.REQUEST_SCHEMA` (`aria/agent-request/v1`; rows sealed earlier
  carry `aria/agent-invocation-request/v1` and replay unchanged — nothing reads a row's `$schema`
  back), always writes `forbidden_scope` and `validation_commands`, and for every role in
  `agent_contract.CONTRACT_ENFORCED_ROLES` (`implementation`) calls `validate_request(row, base_dir)`
  BEFORE the append — a row the contract refuses never reaches the queue, and the plan stays
  CONVERGED. ORPHAN-MEDIUM-572's dormant `validate_request` has its production caller. The set's
  boundary is what the contract binds — a request to its cycle (`cycle_id`) and to the plan
  revision it works from (`convergence_id` + `plan_revision_hash`); the implementation role has
  both on every production mint, while the operator-driven judge, curation, questioning and
  self-change lanes run in no cycle and implement no plan revision, so the contract has nothing to
  bind them to (their rows are held by the queue's field validation at mint and `validate_response`
  at submit).
- **`validation_commands` are derived, never supplied.** `plan_contract.plan_validation_suite(body)`
  is the ONE composition (canonical executable suite + the body's declared entries resolved through
  the contract's matching rule); staging's baseline and staged apply action, the queue's
  `_validation_commands_for_revision` (over `plan_convergence.plan_body_for_revision`, the body the
  row's `convergence_id` + `plan_revision_hash` name — the CONVERGED body for the implementation role,
  the seed's for a planner — through `plan_contract.envelope_validation_suite`, which states an
  EMPTY suite for a body whose declared commands the contract refuses rather than one the lane
  cannot run) and `validate_request`'s agreement check all read it. The drainer's opener
  (`convergent_planning_bridge.start_convergent_plan_drafted_by_primary`) refuses such a seed
  before the plan is opened (`require_plan_contract(..., require_tier=False)`), so no round is spent
  on a body the `plan_contract_complete` gate would refuse
  (`validation_commands_disagree_with_plan_revision`; an implementation envelope must name a body the
  store reproduces, `implementation_plan_body_unavailable`, and its `commit_contract` must equal the
  origin's derivation, `commit_contract_disagrees_with_plan_origin`). The prompt prints the list under
  `## Validation commands`; the implementation `must_satisfy` obligation `validation:canonical_suite`
  carries it as data.
- **One validation suite.** `validation_suite.CANONICAL_VALIDATION_COMMANDS` (re-exported by
  `implementation_safety` under the names every importer uses) grew `npm run format:check`;
  `auto_merge._HYGIENE_DIMENSIONS` IS that tuple (one dimension per command, reason
  `triple_gate_hygiene_run_missing:<command>`), and `canonical_command_satisfied_by` is the
  whole-entry matching rule the pre-PR-open `test_gate_canonical_suite` check and the hygiene battery
  share. The suite lives below `command_policy` so the implementer's Bash allowlist is DERIVED from it
  too: `command_policy.VALIDATION_SUITE_RULES` is one allow rule per executable spelling
  (`validation_suite.bash_allow_pattern_for` — the invocation plus trailing narrowing arguments), so
  the commands the envelope and the prompt tell the implementer to run are commands its PreToolUse
  hook admits, by construction (the hand-kept rules admitted `npm run format`, which writes, and a
  bare `nx`, and refused three of the four suite entries). A direct run by the agent records nothing;
  the recorded run the merge gate reads is the apply gate's (`validation.run_validation_commands`
  at the branch HEAD). `tests/test_validation_suite_ssot.py` pins that every command the merge gate
  requires is one the plan contract admits, the implementer contract names, and the implementer's
  own gate (kernel matcher, hook and Claude projection) allows.
- **One `key_changes[]` shape.** `plan_convergence.KEY_CHANGE_FIELDS` = `(id, description, paths)`
  with `key_change_description` / `key_change_paths` / `key_change_violation`; the plan contract
  refuses any other object (`plan_key_change_shape`), staging's `intended_affected_files` and the
  envelope's per-change obligations read `paths`, and the implementer prompt cites only fields in
  that tuple (`tests/invariants/v9/test_phase_v9_1_aria_implementer_agent.py` derives the check).
- **The commit trailer is the kernel's.** `plan_synthesizer.convert_candidate_to_plan_content` stamps
  a finding-sourced plan's origin into `plan_content.finding_id`; `plan_origin.commit_contract_for_plan`
  derives the `commit_contract` — the exact `Closes: docs/reviews/orphan-findings.md#ORPHAN-<SEV>-NNN`
  line for an ORPHAN origin, no trailer (and only the commit types the gate does not require one for:
  `refactor`, `test`, `chore`) for an origin the gate cannot resolve on a CI checkout (`aria-findings/`
  is gitignored, so an F-NNN trailer fails the range check) or for a plan with no finding. It rides on
  the implementation envelope as a structured field, the prompt prints it under `## Commit contract`,
  and the pre-PR-open check `commit_contract_honoured` (`HardFailContext.commit_contract` +
  `branch_commits`, supplied by `pr_manager.open_pr_for_action`) refuses a branch whose commits carry
  anything else. The mirrored gate rules (`REQUIRE_CLOSES_SUBJECT_RE`, `CLOSES_TRAILER_RE`) are pinned
  against `tools/gates/commit-msg-validator.ts` by `tests/test_plan_origin_commit_contract.py`.
- **One `must_satisfy` item shape.** `aria_kernel/must_satisfy.py`: `{id, description, kind?, ...data}`,
  built through `must_satisfy_item`, validated by `validate_must_satisfy` (which
  `agent_contract._ensure_must_satisfy` and the queue's mint both call), rendered through
  `must_satisfy_text`. The `statement` field the validator once required had no producer; the
  `criterion` spelling the judge lanes minted is readable on sealed rows only (prompt-hash replay) and
  unmintable. `description` is KERNEL-AUTHORED, always: the banned-phrase scan the validator applies
  is a rule over what the kernel asserts, and the plan contract applies no such rule to a plan body —
  a CONVERGED plan whose key change named a file carrying a banned word was refused at its
  implementation mint, every cycle. Text a plan or an agent wrote rides as DATA under its own key: `key_change_obligation`
  carries the plan's wording as `plan_description` (plus `key_change_id`, `paths`) and
  `waiver_adjudication_obligation` carries a waiver's `claimed_reason` (plus `node_id`); both compose
  the description themselves, so no producer has a parameter through which foreign prose reaches the
  scanned field (`cross_review_bridge._implementation_must_satisfy`,
  `issue_completeness_critic_envelope`, the orchestrator's convergence obligations). The same rule
  holds for the suite: a registered recipe's command is opaque operator text
  (`experiment.register_recipe` validates none of it), so the `validation:canonical_suite` obligation
  carries the suite under its `validation_commands` data key and its description names that key
  rather than joining the commands in (`tests/test_must_satisfy_shape.py` drives a plan declaring a
  recipe whose command carries a banned word to CONVERGED and mints its envelope). Prompt render
  version 6 (`agent_invocations.PROMPT_RENDER_VERSION`) renders each obligation's data keys under its
  bullet as an `<obligation_data id=…>` JSON block (`<` escaped; the DATA notice names the tag) — the
  `content_hash`, `paths` and `plan_description` the contract says the agent receives were, before v6,
  never shown to it; v5 rows keep their v5 bytes for prompt-hash replay. Agent files document the item
  shape from the module constants (`tests/test_must_satisfy_shape.py` scans `.claude/agents/aria-*.md`,
  `_shared/*.md` and the canonical-envelope knowledge file).

`tests/test_implementer_merge_seam.py` drives a plan to CONVERGED, runs
`AutonomousV9ImplementationRunner.run` under `strict`, and asserts the minted envelope validates under
`validate_request`, carries the plan's suite, its commit contract, and a prompt naming `paths` and the
trailer; `tests/test_must_satisfy_shape.py`, `tests/test_plan_origin_commit_contract.py`,
`tests/test_validation_suite_ssot.py` and `tests/test_request_contract_minter.py` own the parts.

## 12.18 — Cycle Runtime Verdict and the Tool Degradation Contract

`aria-kernel/aria_kernel/cycle_runtime_status.py` (ARIA-HIGH-098) owns the one rule every reader of
a cycle's verdict applies — `cycle._runtime_status`, the metrics row, `runtime_artifacts._cycle_result_status`,
`autonomy_output_summary` and the orchestrator's continue/fail-closed decision. Trial eleven
(`cyc-20260912T221237Z-auto`, 2026-09-12): nine of ten tools ok, artifact index 10/10 verified, a
CONVERGED plan in the store, and one adapter's `evidence_error` made the cycle `integrity_failed`;
the orchestrator failed closed and the funnel counter, knowledge signer, memory hook and V9
implementation never ran. The 2026-09-04 morning died the same way on a 651 ms budget overrun.

The verdict vocabulary (`RUNTIME_STATUSES`):

- `failed` — a phase raised or declared itself failed. Terminal row `failed`; fail-closed.
- `integrity_failed` — the STORE cannot be trusted: the artifact index did not verify, or a run's own
  artifact is missing / mismatched / never written (`INTEGRITY_ARTIFACT_STATUSES`, or the run status
  `integrity_failed` that `tool_health.record_run` assigns on a failed artifact write). Terminal row
  `failed`; the orchestrator fails closed on this and only this. An index that compaction emptied
  lawfully — zero rows, every artifact the runs still reference attested on
  `run-artifacts/compacted.jsonl` — DID verify (§12.5, ARIA-HIGH-117): `verify_artifacts` answers
  valid with `compacted_artifact_count`, and the night's verdict is its own.
- `degraded` — the index is valid and at least one tool run is non-ok (`budget_exceeded`,
  `evidence_error`, `crash`, `schema_error`, `scope_violation`, `tool_unhealthy`,
  `environment_unavailable`). The cycle COMPLETES (terminal row `completed`, every post-tool phase
  runs, the orchestrator's drainers, planner, convergence and post-CONVERGED phases run as on `ok`);
  the state carries `runtime_status: degraded` and `degraded_tools[]` (tool_id, run_id, status,
  `degradation_class`, artifact_status), the metrics row carries `degraded`, the autonomy-state
  `cycle_completed` row carries status `degraded` with the tools in its summary, and
  `autonomy_output_summary.overall_status` is `degraded` (exit code 2). The tool's raw findings are
  already quarantined by `feedback_store` (`invalid_evidence`) and the tool by `tool_health`.
- `ok` — none of the above.

`degradation_class` is the run status, or `artifact_missing` when the run's artifact — not the tool —
is what failed (a store-class entry, which is what makes the cycle `integrity_failed`).

`aria-kernel/aria_kernel/tool_degradation.py` is the recording and escalation side. The `tool_degradation`
cycle phase (post_tool, writes-permitted, record_and_continue, consulted every cycle) appends one
`tool_run_degraded` governance row per degraded tool per cycle (`cycle_id`, `tool_id`, `run_id`,
`status`, `degradation_class`, `consecutive_cycles`, `human_required_at`, and `quarantine_reason`
for a sat-out tool) and, at `TOOL_DEGRADATION_HUMAN_REQUIRED_STREAK` (3) consecutive degraded cycles
of one tool, opens a HIGH HUMAN_REQUIRED record `tool-degraded:<tool_id>:<first cycle of the streak>`
with
context kind `tool_degradation` (`tool_id`, `degradation_class`, `quarantine_reason`,
`consecutive_cycles`, `cycle_ids`, `latest_run_id`). A tool's streak is its trailing degraded runs read
off `runs.jsonl` PLUS, for a QUARANTINED tool, every cycle it has sat out
(`aria-kernel/aria_kernel/tool_sit_out.py`: the `started` rows of `cycles.jsonl` stamped at or after
the tool's standing quarantine took effect, in which the tool has no run; class `quarantined`). The
standing quarantine is ONE record (`tool_sit_out.standing_quarantine`: `at` + `reason`): the registry
row's `last_transition` into QUARANTINED while it carries one, else the tool's latest QUARANTINED row
in `quarantine.jsonl` — and the ledger is the production anchor, not the edge: the nightly manifest
re-sync re-registers a shipped adapter with its live status, which keeps the status but replaces the
row and drops `last_transition`, so a date or reason read from the row alone was gone by night 2
(`quarantine_tool` stamps the ledger row with the transition's own `at` and the same reason, so
the two anchors agree to the byte). `tool_health` quarantines an
`evidence_error` / `schema_error` / `scope_violation` / `tool_unhealthy` run on the spot and
`cycle._phase_tools` never dispatches a QUARANTINED tool, so a streak read off runs alone froze at 1
for exactly the trial-eleven class; the third night the tool sits out now opens the record, keyed on
the quarantining cycle. A sat-out tool does not change the CYCLE's verdict (`runtime_status` reads the
runs of the cycle; a tool that did not run did nothing wrong tonight) — its standing is a tool fact.
The kind is not panel-adjudicable, so the record stays with the operator; the id is keyed on the
streak's first cycle, so one streak escalates once and a tool that recovers and breaks again escalates
again; an operator release (`unquarantine_tool`, QUARANTINED → CALIBRATE) ends the streak it was asked
about whether the next run is ok or not — a quarantined tool cannot run, so a run recorded after a
quarantine row proves a release (`tool_sit_out.released_after`), and only runs after the last such
release count, so a tool released and re-quarantined without an ok run in between starts a NEW streak
keyed on its own first cycle rather than re-using a record id the operator may already have resolved.
The doctor's `tools` organ reads the same streak: FAIL at the streak line, WARN for a
shorter streak (`<tool>=<class>x<n>`, quarantined included) or a QUARANTINED tool with no cycle behind
it yet. A streak is a live fact only for a tool with standing
(`tool_degradation.DEGRADATION_STANDING_STATUSES`: the roster `cycle._phase_tools` dispatches — ACTIVE
/ SHADOW / CALIBRATE — and QUARANTINED, the tools awaiting release): a DRAFT or SANDBOX tool was never
dispatched and an ARCHIVED tool never runs again, so archiving — the exit the escalation reason itself
names — retires the tool from the organ and from the sat-out roster at once, while the HUMAN_REQUIRED
record the escalation opened stays with the operator to resolve; without that rule the organ stayed
FAIL forever after the operator had done what the record asked (the scheduler paging
`doctor_unhealthy` every tick, `self_improvement` opening a mission). `orchestrator_exit_history` does
not list a degraded cycle among the causes of a `cycle_failed` exit.

The adapter side of the same finding: every registered adapter carries a fixture-backed evidence
contract. `aria-kernel/aria_kernel/adapter_fixture_contract.py` refuses, at the manifest-sync door
(`cycle._phase_tool_manifest_sync`, the one production path from `tools/aria-adapters/*.tool.json`
into the registry), a manifest whose `fixture_set` holds no `cases/*.json` expecting an `ok` run
(`fixture_cases_missing:<tool_id>`, `fixture_case_expects_non_ok_run:<tool_id>:<case>`,
`fixture_case_malformed:<tool_id>:<case>` for a case that is not a JSON object). What a case expects
is read by ONE function, `expected_run_status` (`expected.status` when declared, `ok` otherwise), shared
with the runner's judge `fixture_runner.evaluate_fixture_expectation`, so a case with no `expected`
block is admitted by the door and judged against `ok` by the runner alike. The fixture runner
(`run_fixture_case`) applies `validate_tool_output_evidence` before judging the expectation, so a case
expecting `ok` IS the evidence contract: per-finding `evidence: [{path, line?}]`, `path`/`line` split,
plain paths in `evidence_sources`, every evidence path declared in `read_paths`.
`tools/aria-poc/agent_harness_security_adapter.py` emits that shape and ships its case under
`tools/aria-adapters/fixtures/agent-harness-security-adapter/cases/`.

The PR-time pin (`tests/test_adapter_fixture_evidence_contract.py`, in the `aria-kernel` lane whose
budget it raised from 60 to 75 minutes) runs every shipped manifest's suite through the real fixture
runner against the checkout and requires each case's _status_ to be `ok` — the tool executed, its
envelope parsed, the validator accepted it. The kernel PR lane (`aria-kernel.yml`; the fast
lane was retired under ARIA-MEDIUM-135) fires on `tools/aria-adapters/**` and the pre-push selector
(`scripts/ci/aria-suite-changed.mjs`) maps that directory to every kernel test module naming
`aria-adapters`, so an adapters-only change — a manifest without a case, a case rewritten to expect a
non-ok run, a TS adapter that drops per-finding evidence — meets the pin before merge, not on the push
to main (pinned by `tests/invariants/aria-doc-runtime-ssot.spec.ts` and
`aria-kernel/tests/test_ci_workflow_invariants.py`). A case's expectations (`max_findings`,
`raw_observations_count`, required observation types) are the fixture's calibration of the corpus:
the nightly `fixture_refresh` phase judges them and `readiness`/`promotion` consume the verdict, so a
stale count blocks a promotion without making an adapter's evidence invalid, and the PR pin does not
turn a corpus change into a fixture treadmill. A `budget_exceeded` case is reported as unverified by
name (the tool never answered, so its shape was not observed; `tool_health` prices the miss), and an
adapter whose repo-local node runner is absent is skipped by the runner's own predicate
(`tool_runner._runner_missing_node_deps`).

The fixture path guard (`fixture_runner._repo_root_for_path_guard`) resolves its anchor as
`ARIA_REPO_ROOT` → the caller's `workspace_root` → checkout discovery from the tools root, when the
discovered checkout is a worktree of the repository the store's declared `bound_repo_root` names or
the store declares none → the declared `bound_repo_root` (`tool_registry.declared_bound_repo_root`) →
`tools_dir.parent`. The binding writes `bound_repo_root` on the first bind only and every worktree of
one repository binds identically, so a store carried into a sibling worktree keeps the path of the
checkout it was born in; discovery therefore outranks the binding for the SAME repository
(`checkout_root.same_repository`: the two checkouts share a git common directory — filesystem only,
no subprocess), while a binding to ANOTHER repository outranks a checkout that merely encloses the
store (a git-tracked home directory), and a store outside every checkout is anchored by its binding
alone. Discovery is `aria-kernel/aria_kernel/checkout_root.py`: a checkout root is the directory
holding `.git` whether a directory or a `gitdir:` pointer file (a linked worktree — the trial
workspace and the executor's `aria-worktrees/` are both one), and the state store is skipped by the
`GENESIS` record the kernel wrote into it, not by the shape of its `.git`. `latest_fixture_status`
takes `workspace_root` and the refresh threads it through, so the reader that judges a verdict current
finds the corpus the runner did.

`aria-kernel/tests/test_cycle_runtime_status_degraded.py` owns the verdict rule, the orchestrator's
continuation, the full-cycle degraded pin, the fail-closed integrity pin and the streak escalation for
both the crashing and the quarantined class (three real cycles, release, recovery);
`tests/test_tool_sit_out.py` the sat-out reader; `tests/test_doctor.py::ToolsOrgan` the organ;
`tests/test_adapter_fixture_evidence_contract.py` the registry contract over every shipped manifest and
the sync door; `tests/test_fixture_guard_linked_worktree.py` the path guard on real linked worktrees.

## 12.19 — A deadline the kernel enforces is a deadline the doctor announces (ARIA-MEDIUM-128)

**The rule.** A deadline the kernel will enforce is announced by the doctor seven days ahead
(`deadlines.DEADLINE_WARNING_DAYS`), named, with days left, from the authoritative place the enforcing
gate reads it from. Eight dormant-surface waivers lapsed on 2026-09-13 and every kernel lane on main
was red the next morning; nothing had said a word the week before, because the only reader of a
waiver's date was the gate that refuses it, and a gate reads a date on the day it fires.

**One reader.** `aria-kernel/aria_kernel/deadlines.py` holds the registry of clock-bound rules
(`DEADLINE_SOURCES`); each `DeadlineSource` yields `(kind, key, due_at, enforced_by, consequence)`
rows from the source of record, never from a kept list of dates:

| kind                       | read from                                                                                                                       | enforced by                                                                                                                          | lapse       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| `surface_waiver`           | `aria-kernel/surface-reachability.unwritten.json` (surface → member → entry)                                                    | `tests/test_surface_reachability.py::test_a_waiver_expires_against_the_clock_not_against_a_regex` (kernel lanes red on main)         | FAULT       |
| `control_waiver`           | `aria-kernel/control-reachability.dormant.json` (name → entry)                                                                  | `tests/test_control_reachability.py::test_a_waiver_expires_against_the_clock_not_against_a_regex` (kernel lanes red on main)         | FAULT       |
| `batch_containment_waiver` | `aria-kernel/batch-containment.waivers.json` (name → entry; absent = no waivers)                                                | `tests/test_batch_containment_gate.py::test_the_declared_waivers_are_all_valid` (kernel lanes red on main)                           | FAULT       |
| `human_required_sla`       | the open records through `human_required.list_human_required` — the daily report's HUMAN_REQUIRED section counts the same queue | `SLA_WINDOWS` (Plan 016 operator SLA; the report's escalation ladder)                                                                | FAULT       |
| `registry_finding`         | `docs/reviews/_registry/findings.jsonl`, every finding not RESOLVED or BLOCKED that carries a `deadline`                        | `finding-state-sweep.yml` → sweep PR (`finding-registry.ts planSweep` plans BLOCKED; the state lands when a CODEOWNER merges the PR) | information |

**The waiver manifests are one closed registry.** `surface_waivers.WAIVER_MANIFESTS`
(`WaiverManifest`: kind, path, shape, enforcing gate, consequence) is the closed registry of every
dated waiver manifest the kernel enforces; the three waiver rows above are built from it (one
`DeadlineSource` per manifest, never written by hand), every manifest is read by ONE parser
(`surface_waivers.load_waiver_manifest` — absent file = no waivers; present and malformed RAISES,
never `{}`), walked by `iter_waivers` and judged by ONE predicate,
`surface_waivers.waiver_has_lapsed` (`expires_on < today`, UTC: honoured through its own day). Each
gate imports its reader and its predicate from there and keeps no `json.loads` and no
`fromisoformat` of its own. A kernel gate that reads a dated waiver manifest without registering it
in `WAIVER_MANIFESTS` is the defect this section exists to prevent: the first cut of this contract
registered the surface manifest alone while `control-reachability.dormant.json` carried six waivers
dated 2026-09-20 under the control gate's own parser and clock — the lanes would have gone red on
the 21st with the organ, the report and the scan silent, the opening incident wearing another
manifest's name. Such a gate has two doors, and each is closed where it is passed rather than only
named here. A gate that borrows the reader with a `WaiverManifest` of its own is refused by every
reader (`waiver_manifest_path`, `load_waiver_manifest`, `iter_waivers`, `lapsed_waivers` raise
`LookupError` naming the spec and `register it in surface_waivers.WAIVER_MANIFESTS`) the first time
it runs. A gate that keeps a parser or a clock of its own is found by `test_deadlines.py` walking
EVERY Python module under `aria-kernel/tests/` by AST — helpers and invariants included, not only
the gates the registry names: a walk over the registry cannot open the gate that never registered,
which is how a fourth gate with its own `json.loads` and `fromisoformat` over
`aria-kernel/closure.waivers.json` once passed every pin (round-3 verifier, M6) — and refusing a
module that handles dated waivers (the `expires_on` field, a
`*.waivers.json`/`*.dormant.json`/`*.unwritten.json` path, `REQUIRED_WAIVER_FIELDS`) with a
`json.load`/`json.loads`, `fromisoformat`, `strptime` or `date.today` call of its own, or that
constructs a `WaiverManifest`, with the same instruction. The manifest file is the third witness:
every JSON file under `aria-kernel/` outside `tests/` whose entries carry `expires_on`, in either
shape, must be a registered spec's path. Registering the manifest is the whole remedy — the source
list is built from the registry, so the organ, the report and the scan announce the new manifest's
waivers the day it is registered (confirmed on a throwaway copy: the M6 manifest, once registered,
was a `closure_waiver` row at +6d on 2026-09-14 and a lapsed FAULT on the 21st with no other
change).

Each row mirrors the CLOCK of its enforcer so the organ and the gate cannot disagree by a day: a
waiver is honoured through its `expires_on` day (`waiver_has_lapsed`, the gates' own call); a registry
deadline lapses at the start of its day (`new Date(deadline) < now`); an SLA lapses at its instant. A
source that cannot be read answers undecided BY NAME (`<kind>:<ExceptionName>`, or
`<kind>:checkout_unbound` when a committed source has no checkout to be read from) — one malformed
manifest is undecided under its own kind and the other manifests are still read.

**Three consumers, one readout.** The doctor's `deadlines` organ (`doctor._check_deadlines`): FAIL on
`deadlines_undecided:<sources>` or `deadlines_lapsed:<n>:<key(±days)…>` for a lapsed FAULT row; WARN
on `deadlines_due:<n>:…` (inside the window) and on `deadlines_lapsed_swept:<n>:…` (a lapsed registry
deadline — the daily sweep plans BLOCKED into a sweep PR that lands only when merged; the workflow
never pushes to main because auto-commits are a tampering surface, and the sweep PR opened on
2026-08-28 (#1335) has carried lapsed rows unmerged for weeks — so the doctor names the row without
declaring the store ill: 132 registry deadlines had lapsed on the day the organ was written, and an
organ red for a quarter is one nobody reads); every part is named in the reason and every row is in
the detail. The daily report renders `## Deadlines` beside HUMAN_REQUIRED
(`reflection._render_deadlines_section`, undecided sources first). `self_improvement.scan_signals`
emits one `deadline_due` signal per lapsed or in-window row (key `<kind>:<key>`, priority 2 at two
days or lapsed, 3 otherwise). Adding a rule the kernel enforces means adding its reader to
`DEADLINE_SOURCES`; the organ, the report and the scan follow.

**A signal is routed by its remedy, not by its priority.** `self_improvement.SIGNAL_REMEDIES` gives
every signal kind exactly one closed remedy — `self_change` for the five kinds whose answer is a
change to ARIA's own code (`capability_gap`, `funnel_stall`, `delivery_slo_gap`, `mcp_quarantine`,
`doctor_fail`, together `SELF_CHANGE_SIGNAL_KINDS`) and `announce` for `deadline_due` — and a
`Signal` of a kind outside the table cannot be built (`signal_kind_unknown`). The mission opener
(`open_self_improvement_missions` → `self_change_signals`) mints `propose_self_change` missions only
for the `self_change` remedy, ordered by priority within it. `deadline_due` is announced — the doctor,
the daily report and `aria-kernel self-improve scan` (whose rows carry `remedy`) — and never becomes
a mission: the mission's contract (`mission_dispatch._self_change_contract` →
`SELF_CHANGE_ALLOWED_PREFIXES`) cannot address a registry finding's or an operator SLA's date, and its
accepted answer would mint a HUMAN_REQUIRED adjudication that itself becomes a `human_required_sla`
row. Confirmed on a throwaway store over the pre-fix tree: five lapsed registry rows and one
quarantined MCP server; three nights of `self_improve` opened three `deadline_due:registry_finding:*`
missions and the `mcp_quarantine:context7` row never got one (132 lapsed rows on the live checkout
made the starvation permanent). A lapsed FAULT still reaches the opener at priority 1 as the
`deadlines` organ's own `doctor_fail`. When HIGH-122's adaptation loop owns a contract for a dated
row, that contract is added to `SIGNAL_REMEDIES` — not to the opener's sort key.

Not in the registry, on purpose: rolling housekeeping windows (`state_compact` `retain_days`, the
signing-key 24 h grace in `prune_stale_signing_keys`). Passing those windows IS their design — the row
is archived, the orphan key is pruned — not a lapse anyone must act on before the day; a "deadline"
that is always due within the window would make the organ the always-burning signal this contract
exists to prevent.

`aria-kernel/tests/test_deadlines.py` pins every row above, the one-reader identity (every manifest
in `WAIVER_MANIFESTS` is a `DeadlineSource`; every gate a manifest names imports `load_waiver_manifest`
and `lapsed_waivers`/`waiver_has_lapsed` from `surface_waivers` and, by AST over its `Call` nodes,
keeps no parser and no clock of its own; the organ resolves each manifest through the same function;
the live checkout's control waivers are `control_waiver` rows due the day after each `expires_on`),
the closed-registry rule from outside the registry (`UnregisteredWaiverManifests`: every reader refuses
a spec outside `WAIVER_MANIFESTS`; no module under `aria-kernel/tests/` other than the registered gates
handles dated waivers with a parser or a clock of its own or builds a `WaiverManifest`; no dated
manifest file under `aria-kernel/` is unregistered; and the walk's positive control, the M6 gate
byte-shaped, is refused on every count), the undecided-by-name rule, the daily report as written to
disk by `run_reflection` (`## Deadlines` with the LAPSED/DUE rows in the file, not a render helper
checked in isolation) and
the signal. `aria-kernel/tests/test_self_improvement_remedy.py` pins the remedy table, the refusal of
a kind without one, and the opener over lapsed registry rows beside a quarantined server.

Named, not pinned: a registry `deadline` the sweep cannot parse (`planSweep` skips a NaN date, and
`finding-registry.ts` validates no deadline format) makes the whole `registry_finding` source
undecided by name (`deadlines_undecided:registry_finding:ValueError`) — a date the sweep can never
compare is a defect in the registry, and the organ says so rather than counting the rest as clean.
`days_left` is a floor: a row that lapsed N days ago reads `-(N+1)d` once the clock is past the
instant, the same convention the report and the doctor share.

## 13 — Phase-1 PoC (IMPLEMENTED)

Before committing to months of kernel work, the operator runs this PoC to answer: **"do we actually
need ARIA?"**

This PoC is **implemented** at `tools/aria-poc/poc.py` with stdlib tests at
`tools/aria-poc/test_poc.py` (no LLM, no API). All other content in this document remains
unimplemented contracts.

### How to run

```bash
python3 tools/aria-poc/poc.py --workspace-root .
```

Or via Claude Code session:

```text
/aria-poc
```

(see `.claude/commands/aria-poc.md`)

Runtime: ≈30 seconds on the full repo. Output: `.aria-poc/` (gitignored).

### What it does (per implementation)

1. Filesystem walk excluding `agent-workspace/`, `node_modules/`, `.git/`, `dist/`, `build/`,
   `coverage/`, `.next/`, `.nx/`, `target/`, `tmp/`, `.aria-poc/`, `.turbo/`, `.cache/`

2. Reconcile with `git ls-files`
3. Assign every file a fate (Coverage Invariant per SPEC §4 Engine 1)
4. Compute `REPO_FINGERPRINT.json` (language histogram, manifests, apps/web counts, migration count,
   ADR count, agent count, nx availability)

5. Ingest TRUSTED priors (mechanical extraction, no LLM):
   - `CLAUDE.md` → `CLAUDE_MD_PRIORS.md` (heading inventory + content SHA-256)
   - `docs/adr/[0-9][0-9][0-9]-*.md` → `ADR_PRIORS.md` (canonical only, title + status)
   - `.claude/agents/*.md` → `AGENT_PRIORS.md` (frontmatter `description` field per agent)

6. Run `npx nx graph --file=.aria-poc/BUILD_GRAPH.json` (best-effort, optional; `--skip-nx-graph` to
   disable)

7. Mechanical drift scan: TypeScript `enum`, string-literal union types, string `as const` arrays,
   Zod `z.enum([...])`, GraphQL SDL enums, frontend literal option groups, and PostgreSQL `CREATE
TYPE ... AS ENUM`.

8. Gate UI option promotion by frontend surface plus named concept relationship. Value overlap alone
   is never enough.

9. Enrich candidates with git-blame metadata, named existing gate/test references, and summary counts.
10. Write `MECHANICAL_DRIFTS.json` (value sets, SQL enums, annotated UI option groups, drift
    candidates, evidence summary) + `aria-poc-report.md` (operator-facing decision gate)

### What this PoC does NOT do

- No skill genesis. No adapter birth. No capsule storage. No mastery levels.
- No LLM. No findings. No recommendations.
- No PR creation. No worktree. No baseline capture.
- No persistence beyond `.aria-poc/`.
- Drift scan is still heuristic. It does not resolve imports, generated schemas, computed values, or
  dynamic frontend option providers. **Absence here does not mean absence in repo.**

### First-run results on this repo (snowball branch)

The PoC has been run against `Okan-wqm/aquaculture_platform`:

- 6987 files visited, Coverage Invariant: PASS
- 17 apps, 7 web modules, 61 migrations, 35 canonical ADRs, 34 specialized agents
- 498 TypeScript enums, 399 TypeScript union value sets, 45 string `as const` arrays, 32 SQL enums
- 184 literal frontend option groups recorded separately with frontend-surface and
  concept-relationship gates

- **16 TS/SQL drift candidates above threshold** detected mechanically
- 1 frontend dropdown drift candidate after clustering multiple supporting value sets into one
  observation; raw UI groups remain available in `MECHANICAL_DRIFTS.json`

- 9 drift candidates have named existing gate/test references; this is nearby evidence, not
  enforcement proof

The most striking real drift: `apps/farm-service/.../DepartmentType` (aquaculture-flavored values:
BROODSTOCK, HATCHERY, NURSERY, GROW_OUT, QUARANTINE, PROCESSING, ...) versus
`apps/hr-service/.../department_type` SQL enum (office-flavored values: administration, management,
security, operations, ...). **Same conceptual name, completely different value sets across
services.** This is exactly the kind of cross-service drift that PR-cycle agents don't catch
(because each service's PR looks internally consistent) but continuous mode would.

This single finding alone gives the operator concrete data for decision question #2.

### Decision criteria

After running the PoC, the operator answers (PoC report has the checkboxes):

1. Did the fingerprint reveal anything you did not already know? (yes/no)
2. Did the mechanical drift scan surface real drift not caught by existing 38 specialized agents on
   PR cycles? (yes/no)

3. Is the value surface of (2) large enough to justify months of kernel work? (yes/no)
4. Is the LLM cost (Claude Code session-based, NOT direct API — see §0.6) within scope? (yes/no)

If **3 of 4 are NO**: archive SPEC, IDENTITY, CONTRACTS as research artifacts. The 38 specialized
agents + Nx + CI cover the value surface.

If **3 of 4 are YES**: proceed to Phase 0 (kernel skeleton — orchestrator slash command + Discovery

Phase 0 ships: Memory + redactor + budget observer + kill switch + integrity hash chain — no skills yet).

### Files committed

- `tools/aria-poc/poc.py` — implementation
- `tools/aria-poc/test_poc.py` — stdlib unit tests
- `tools/aria-poc/README.md` — how-to
- `.claude/commands/aria-poc.md` — Claude Code slash command wrapper
- `.gitignore` — adds `.aria-poc/` exclusion

The PoC is the only ARIA-related code allowed in this branch without the full kernel surrounding it.
It is the operator's "do we even start?" gate.

---

## 14 — Closing

Three documents now define ARIA on paper:

| Document              | Layer                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `SPEC.md`             | Boundaries — laws, engines, mastery, claim authority, workspace                                  |
| `IDENTITY.md`         | Behavior — daily rhythm, refusals, speech, trajectory, self-honesty, missing-protocols (§12–§22) |
| `CONTRACTS.md` (this) | Data shapes, protocol contracts, LLM discipline, state machine, Phase-1 PoC                      |

What is **still missing on paper:** runtime implementation, not plan shape. The physical
implementation plans live in `docs/aria/plans/`, with the phase-level summary in
`docs/aria/ROADMAP.md`.

What is missing **as code:** all of it. None of these contracts are implemented.

The next legitimate step is still the Phase-1 PoC (§13). If the PoC decision gate passes, Phase 0
begins from `docs/aria/plans/001-phase-0-kernel-skeleton.md`.

## 12.5 — Runtime v2 Ledger Promotion Contract

> Ported from `fix/aria-runtime-stabilization-2026-05-29` (Tranche 2 of the ARIA→main
> controlled merge, `docs/plans/2026-06-13-aria-to-main-controlled-merge/`). The full
> runtime artifact contract lives in [`runtime-artifact-contract.md`][rt-contract]; the
> operator promotion decision is governed by [ADR-035][adr-035]. Retention/restore:
> [`runbooks/runtime-retention.md`][rt-retention]; observability SLOs:
> [`aria-codex-runtime-observability.md`][rt-observability].
>
> [rt-contract]: ./runtime-artifact-contract.md
> [adr-035]: ../adr/035-aria-runtime-v2-promotion.md
> [rt-retention]: ./runbooks/runtime-retention.md
> [rt-observability]: ../runbooks/aria-codex-runtime-observability.md

### v2 Promotion Contract

`ARIA_RUN_LEDGER_FORMAT=v2` is a promotion ceremony, not a single environment-variable flip.
`v2-shadow` remains the default until an operator-approved evidence bundle proves that bounded
stdout did not shrink audit capacity.

Promotion requires:

- 10 consecutive isolated `v2-shadow` cycles with every expected tool either recorded as `ok` or
  explicitly failed closed.

- `runtime verify-artifacts` and `integrity verify` after every cycle.
- A short isolated `v2` smoke after shadow soak, followed by retention dry-run, apply, restore,
  rollback, and final verification.

- Parity evidence that raw finding counts, emitted finding counts, artifact references, hashes,
  suppressed counts, and truncated counts did not regress between `v1`/`v2-shadow` readers.

- Negative evidence tests for missing artifact, corrupt artifact, hash mismatch, path escape,
  artifact write failure, restore failure, summary over 32KB, and lifecycle failure before
  planner/worker drains.

Promotion is blocked if any consumer reads `runs.jsonl` directly instead of
`aria_kernel.runs_reader`, any artifact hash status is not `ok`, any raw finding pointer cannot
resolve to artifact payload, or any omission/truncation/suppression lacks a count, reason code,
artifact ref, hash, and verification status.

The current implementation records `suppressed_count` and `truncated_count` in the summary contract.
Real `v2` source-of-truth promotion remains blocked until those counters are derived from runtime
evidence and covered by tests; hard-coded zero counters are smoke evidence only.

### Compaction ↔ verification (ARIA-HIGH-117)

`state compact` (`aria-kernel/aria_kernel/state_compact.py`, run daily by
`aria-state-maintenance.yml` with `--retain-days 7`) removes hot-artifact cycle directories older
than the retention window and drops their `run-artifacts/artifact-index.jsonl` rows
(ORPHAN-CRITICAL-805; presence on disk is the predicate). `runs.jsonl` refs and
`raw-findings.jsonl` pointers keep naming the stripped artifacts BY DESIGN — the rows compaction
slims keep `finding_summary`, `evidence_hash`, `artifact_hash` and `artifact_ref`, and the compact
archive `archives/artifact_index-compact-<stamp>.jsonl.gz` holds every dropped index row; nothing
is lost. Until 2026-09-13 the verifier had no notion of a compacted artifact: it read every such
ref as `artifact_ref_missing`, every such pointer as `raw_pointer_corrupt` and the emptied index as
`artifact_index_empty_with_run_refs` (3,898 issues on the tip the executor lane restored), so the
store the kernel's own maintenance produced was refused by the kernel's own integrity verb and no
executor publish landed after 09-04. The contract that ends that contradiction:

- **Compaction attests what it strips.** `run-artifacts/compacted.jsonl` (surface
  `runtime_artifact_compactions`, declared in `state_manifest.py`, hash-chained, published) carries
  one row per stripped artifact — `artifact_id`, `uri`, `sha256`, `cycle_id`, `run_id`, `kind`,
  `compacted_at`, `archive` (the compact archive holding the dropped index row), `retain_days`,
  `retention_cutoff`, `attested_by` — appended inside the index compaction's own transaction
  (`_compact_artifact_index`). The `state_compacted` governance row carries the count as
  `compacted_artifacts_attested` and names the compact archive the run wrote as
  `artifact_index_archive` (`null` when it dropped no index row).
- **The ledger attests policy, not absence.** A dropped index row is attested only when the
  retention policy removed its artifact: its cycle stamp (or `created_at`) is older than the
  cutoff in force when its archive was written, or this very run pruned its hot directory
  (`pruned_paths`). A row whose artifact is absent inside the window is archived but NOT
  attested — the verifier keeps reporting it, and a later compaction never re-judges it: that is
  the lost artifact the verifier exists to catch.
- **The window in force is the archive's own.** The cutoff an archive is judged by is
  `<archive stamp> − retain_days` where `retain_days` is the `--retain-days` of the compaction
  that WROTE the archive — never the input of the run that reads it, so a supported operator
  dispatch with a shorter window cannot re-judge a row the daily runs refused. That value lives
  on the writing run's `state_compacted` governance row: a row names its archive
  (`artifact_index_archive`) and speaks for that archive alone; the rows that predate the name
  (the nine on the live store, each stamped to the second of its archive) are paired by clock —
  the first such row at or after the archive's stamp, provided it precedes the next archive. A
  run's own archive (and a dry run's pending drop) is judged by that run's `--retain-days`. An
  archive no row vouches for — a run that died between its archive and its governance row — is
  attested from NOT AT ALL; its artifacts stay visibly missing rather than judged under a guessed
  window, and the lane refuses to publish (`_archive_windows`).
- **Backfill is the same mechanism.** Every compaction reads every
  `artifact_index-compact-*.jsonl.gz` archive, not only the one it wrote, and attests any row whose
  artifact is absent and policy-eligible and whose id the ledger does not yet carry
  (`attested_by: archive_backfill`; idempotent — a second pass appends nothing). A store stripped
  before the ledger existed (the live store: 0 index rows, 3,825 thin raw rows, three compact
  archives, no ledger) is therefore healed by the NEXT maintenance run by construction — no
  manual repair of `aria/state`.
- **The verifier classifies, it does not launder.** `verify_runtime_artifacts` loads the ledger
  once (`CompactedArtifacts`; a ledger whose chain fails to verify attests nothing) and, for an
  artifact that is ABSENT from the hot tier, consults it before the retention ledger: a run ref
  or index ref into an attested artifact is `compacted` — valid, counted in
  `compacted_artifact_count`, and exempt from `artifact_index_ref_missing` /
  `artifact_index_empty_with_run_refs` / `missing_artifact_index`. A raw-findings pointer into an
  attested artifact is verified STRUCTURALLY instead of dereferenced: the row must be the thin
  pointer `record_findings` writes (a v2 `artifact_ref`, a `/payload/raw_findings/<n>` pointer, a
  `finding_summary` with `rule` and `id`, a sha256 `evidence_hash`, and an `artifact_hash` equal to
  the ref's `sha256`); anything less is still `raw_pointer_corrupt` (`artifact: compacted`, with
  `reasons`). A present hot file is always verified by its bytes; an attestation whose recorded
  `sha256` differs from the ref's names a different artifact and does not apply. Absent, unattested
  and unretained stays `artifact_ref_missing` / `raw_pointer_corrupt`. Both counts are per
  REFERENCE (a run's `artifact_ref` and `artifact_refs[0]`, each raw pointer), the convention
  `verified_artifact_count` already used: 3,861 on the live store for 18 artifacts.
  `verify_artifacts` (the index walk `cycle._runtime_status` reads) was already valid on a
  zero-row index; it now reports `compacted_artifact_count` (ledger rows) so that verdict says
  why the index is empty. `compacted_artifacts(base_dir).attesting(ref)` is the one query — the
  verifier's own — that answers, by name, whether a ref names a compacted artifact; the readers
  that surface raw findings (`feedback_store`, `rule_health`) fall back to `finding_summary` for
  one.
- **No lane publishes an unverified store.** `state_store.publish_state` — the ONE publish path —
  runs `verify_runtime_artifacts` on the store's tools root with the checkout as workspace root
  (the same call `integrity verify` makes) before its first mutation and refuses
  `state_publish_runtime_artifacts_unverified`, naming the issues; the verdict travels in the
  publish result as `runtime_artifacts`. `aria-state-maintenance.yml` additionally runs the
  executor lane's whole `integrity verify` step after compaction and gates its publish on the same
  `state_valid` output, failing closed (`Fail when the compacted state was not published`), so
  the producer of the compacted tree applies the consumer's verdict, not only the pointer half.

Pinned by `aria-kernel/tests/test_compaction_attestation.py` (the live store's shape rebuilt,
one `compact_state` pass, the verifier and `integrity verify` answering valid; a hand-deleted
artifact still refused; a later `--retain-days 1` pass attesting nothing a 7-day archive
refused; a pre-name row paired by clock and its window ruling; an archive no row vouches for
attested from not at all; the publish refusal) alongside `tests/test_state_compact.py`,
`tests/test_runtime_artifacts.py` and `tests/test_state_publish_maintenance.py`.

---

## 12.6 — Memory Learning Reporting Contract

This implemented reporting contract is owned by `runtime_artifacts.py`, `reflection_inputs.py`,
`reflection.py` and the final CLI envelope. `autonomy_output_summary` projects the supplied **outer**
`per_cycle` results, where `memory_hook` and `memory_completion` are produced after the inner cycle
summary. The same private projector feeds post-drain reflection through
`producer_reflection_kwargs`; newly written reflection rows and daily reports carry the optional
`memory_learning` projection (version 1). `report.emit_anchor_to_path` retains the existing report
publisher contract. Earlier inner cycle projections are not consumers of these outer fields.

- Initial observation status, completion batch status and individual observation receipts remain
  separate. A `completed` batch can contain failed observations. `needs_signing` is an unsigned
  initial observation, not a failed merge. Missing input and explicit no-op are distinct; unknown
  attempts/recorded/verification facts remain null.
- The signer is the cycle's own ephemeral ed25519 key, minted by the orchestrator's post-CONVERGED
  seam (`cycle_phases.knowledge_signer`) for every profile holding the `knowledge_record` cell of
  `runtime_profile.ACTION_PERMISSIONS` (`standard`, `strict`, `autonomous`) and revoked before the
  cycle proceeds. The initial observation is therefore signed in the cycle that converged;
  `needs_signing` is reached only when the profile lacks the cell or the mint failed
  (`knowledge_signer_mint_failed` governance row, `stage` = `mint_key` or `register_public_key`).
  A `convention_record_needs_signing` disclosure carries a `reason`: `cycle_signer_unavailable`
  (no signer) or `cycle_append_failed` (a signer was present and the append failed;
  `convention_record_failed` sits next to it with the error class). The seam replays every
  disclosure reason under the cycle's own signer (`memory_completion`) — in the disclosing cycle
  first and in every later cycle that holds a signer — so an observation that could not be
  appended is never lost. `memory_hook.pending_reason` names the disclosure written, or is null.
  Knowledge-write authority is independent of `pr_create`; the V9 runner mints no identity of
  its own (ARIA-HIGH-115, below), so this key signs the convention row and nothing else, and the
  implementer's commits carry a second, separately registered fingerprint under the same cycle
  id. `memory_hook` and `knowledge_signer` on the outer cycle summary carry public signer
  provenance (`signer_cycle_id`, `signer_key_fp`), never the key.
- The PUBLIC half of every knowledge signer is registered in `knowledge-graph/signers.jsonl`
  (declared surface `kg_signers`; `knowledge_graph.register_convention_signer`) before the seam
  hands out the fingerprint, and a fingerprint whose key could not be registered is never handed
  out (the key is revoked on the spot). `knowledge_graph.verify_convention_signer(row)` re-derives
  the fingerprint from the registered key (`fingerprint_of_public_key`, the value `ssh-keygen -lf`
  prints) so a reader can check a row's `signer_key_fp` names a real key after the cycle's key
  files are gone. The registry refuses a fingerprint that is not the supplied key's own.
  Promotion is where the signature is read: `knowledge_graph.reconcile_convention_promotion`
  verifies the hypothesis row's signer before it promotes, and a row whose `signer_key_fp` names
  no registered key (or a key that does not hash to it) is answered `signer_unverified` with the
  pattern id and fingerprint — recorded beside the plan, never promoted.
- The mint/revoke pair is a transaction on the workspace checkout's LOCAL git signing config
  (`commit.gpgsign`, `gpg.format`, `user.signingkey`, `gpg.ssh.allowedSignersFile`): the mint
  snapshots the operator's values to `.git/aria-signing-config-snapshots/<cycle_id>.json` (0600, the
  directory 0700), a commit made inside the cycle is signed by the cycle key, and the revoke restores
  the snapshot byte-for-byte when the config still names the cycle key
  (`git_signing_config_restored`). The snapshot is checkout-resident, next to
  `.git/aria-allowed-signers`, and NOT next to the key in the gitignored `aria-debts/keys/`: the
  production lane (`.github/workflows/aria-auto-cycle.yml`) runs `git reset --hard && git clean
-ffdx -e node_modules` on the persistent self-hosted workspace at the start of every run, which
  wipes the keys dir but never `.git/`, so a cycle killed mid-window (OOM, a cancelled run — the
  autonomy CLI installs no SIGTERM handler) loses its key to the next run's pre-clean while its
  config and its snapshot both survive. The orchestrator runs
  `gh_token_factory.prune_stale_signing_keys` at startup next to the orphan-implementation reaper:
  a crashed cycle's key files are pruned after the 24h grace window, and the snapshot of every
  cycle whose private key file no longer exists — pruned just now, or wiped by the pre-clean — is
  unwound at once (a snapshot without its key is an orphan by definition; no age gate), ownership-
  checked like the revoke. A `keys_pruned` governance row names what was pruned (`pruned`), which
  snapshots were unwound (`snapshots_unwound`) and which cycles' config was restored
  (`git_signing_config_restored`); it is emitted when any of `pruned`, `snapshots_unwound` or
  `errors` is non-empty. The factory resolves the workspace root once (`_resolve_workspace_root`),
  so the key path the mint writes into `user.signingkey` and the path the revoke, the prune and the
  inheritance check compare against are the same absolute path whatever spelling each caller
  passed. A snapshot always records the state before ANY kernel key: a mint that finds a crashed
  cycle's key still installed — inside the grace window, or already wiped — inherits that cycle's
  snapshot from `.git/` (`inherited_from_cycle_id`), so the operator's config comes back from
  whichever snapshot still owns the checkout, however many cycles crashed in a row; a crashed cycle
  whose config a later cycle replaced fails the ownership check at prune and its snapshot is
  discarded, never replayed. The restore answers with a decision
  (`gh_token_factory.SigningConfigRestore`: `restored`, `foreign`, `absent`, `undecided`); a
  snapshot is consumed only by a decision. `undecided` — the snapshot did not read, or `git config`
  did not answer (a timeout on a loaded host, an `OSError` on `.git/`) — keeps the snapshot and the
  ownership marker in place: the revoke reports `git_signing_config_restore=undecided` with the
  error class, the prune lists the snapshot in `errors` as
  `git_signing_config_restore_undecided:<ErrorClass>` and does not unlink it, and the next revoke
  or startup prune finishes the same restore. That retry is sound because `user.signingkey` — the
  ownership marker — is released by the restore's LAST git call, after every other key and
  section is back: an interrupted restore always leaves the marker for the retry to recognise, and
  re-setting a key to its snapshot value or unsetting an absent one is a no-op.
- The checkout the transaction runs on is what git says it is, not `<workspace>/.git` tested as
  a directory (ARIA-HIGH-114): `gh_token_factory.SigningCheckout` reads the `.git` marker through
  `checkout_root` (the one parser for every walker: the directory or the `gitdir:` pointer file, its
  per-worktree git dir, its `commondir`), and the allowed-signers file and the snapshots live in
  that private git dir — `.git/` on a main checkout, `.git/worktrees/<name>/` on a linked
  worktree, the shape of every executor per-request worktree and every trial task-source, where
  `.git` is a file and the old test skipped the wiring without a word. On a linked worktree the
  config scope is `--worktree` (`config.worktree`), because `--local` there is the config every
  worktree of the repository shares and a per-cycle key installed there signs everybody's
  commits; the mint turns `extensions.worktreeConfig` on in the common config once and leaves it
  on (git's rule: a repository carrying `core.worktree` or a true `core.bare` is refused by name
  instead of re-shaped). The mint's receipt (`SigningKey.git_signing`, a `GitSigningWiring`:
  `configured`, `scope`, `reason` ∈ `not_a_checkout`, `git_unavailable`,
  `worktree_scope_unavailable:<why>`, `git_config_failed:<key>:rc=<n>`) is read by the executor
  child that holds the implementer's identity (next paragraph), which refuses by name before an
  implementer turn is spent on commits the merge gate's `verify_commit_signature` could never
  accept.
- The implementer's signing identity is minted where the commit is made, and stamped and
  verified by the kernel (ARIA-HIGH-115). WHO mints: the executor child
  (`tools/aria-poc/ci_executor.py`), for a claimed request of role `implementation`, as the LAST
  step before the spawn — after the dispatch-budget, prompt-renderer, recovery and operator-cancel
  refusals, so none of them costs an ssh-keygen or leaves a `kg_signers` row for a key that never
  signed — and before any agent turn, through
  `implementation_identity.hold_implementation_identity(cycle_id=<request's cycle_id>,
workspace_root=<the tree the agent runs in>)`. WHERE: inside that tree — the per-request
  worktree the drain adds (`worktree_per_request`) — with `--worktree` scope, so a plain
  `git commit` by the agent signs and no other worktree or the shared checkout sees the key. The
  V9 runner (`cycle_phases.implementer`) mints nothing: its former key + installation-token
  bracket had no consumer inside its window (staging and the envelope mint make no commit and no
  GitHub call; the delivery token is the spawn's, `delivery_credentials`), and revoking it in its
  `finally` before the implementer was even claimed is what left every executor-lane result
  without an identity. The identity is REFUSED by name, before any turn, when it cannot be held
  in that tree: the claim is released under the harness-class reason
  `implementation_signing_unavailable` — the executor's own refusal record
  `IMPLEMENTATION_IDENTITY_REFUSAL` (an `_AdmissionRefusalKind`, rostered in the release-site
  invariant like `ADMISSION_REFUSALS` / `TASK_BINDING_REFUSAL`) spells that reason, and the
  dispatch summary it writes says the same thing: `harness_unavailable`, retryable — the request
  returns to the queue with its requeue budget intact, and a governance row of the same name
  carries the cause. The cause is decided in two stages. From the checkout's SHAPE first
  (`gh_token_factory.signing_checkout`: the `.git` marker and its `commondir`, no git process),
  BEFORE the mint, so the refused path writes nothing — no key file, no config, no snapshot:
  `not_a_checkout`, and `shared_checkout_scope:--local` (the tree is a main checkout, whose
  `--local` config every worktree of the repository shares: an implementation is served only from
  a linked worktree, and a lane without `worktree_per_request` is refused rather than signing
  everybody's commits — the mint that used to precede this refusal had already replaced the
  operator's `user.signingkey` in that shared config). Then from the mint's receipt and the
  registry, the mint unwound by the same revoke the body's exit uses: the receipt reasons above,
  `identity_already_held` (the key file already existed, so the mint wired nothing — another
  holder owns this cycle's identity in this tree), `mint_failed:<ErrorClass>` and
  `register_failed:<ErrorClass>`. The PUBLIC half is registered in `kg_signers`
  (`knowledge_graph.register_convention_signer`, under the request's cycle id) before the agent
  starts, and the key is revoked — config restored — on every exit after the submit or the
  release; the worktree's removal takes its private git dir with it. WHO stamps: the executor,
  after the agent returns and before the submit, writes the fingerprint of the key it holds on
  the result's outcome record (`implementation_identity.stamp_implementation_signer`, at the
  place `implementation_record` reads — `details.implementation`, or the flat legacy `details`);
  a value the agent wrote is replaced, and a differing one recorded
  (`implementation_signer_fp_overridden`: `agent_supplied`, `signer_key_fp`), never trusted. The
  agent contract asks for no `signer_key_fp` at all. The same fingerprint reaches the cost row
  (`record_cost_attribution(signer_key_fp=)`) from the one holder, explicitly; a role that holds
  no key records `SHA256:no-key`, and no environment variable carries it. WHO verifies, against
  WHAT, WHERE: the bridge (`plan_convergence_bridge.verify_implementation_commit`), before any
  plan-state mutation, resolves the stamped fingerprint in `kg_signers` — an unregistered one, or
  one registered under any cycle but the request's own `cycle_id`, is refused
  `commit_signature_unverified` by name with no git step — builds an allowed-signers file
  of that one registered key and runs `git verify-commit --raw` with it as the only trust anchor
  (`verify_commit_signature(..., allowed_signers=)`) in the checkout the submission names
  (`submit_claim_result(workspace_root=)`: the request worktree, on the submit path) or, on the
  bridge replay where no such tree exists, in the checkout the store is bound to
  (`bound_workspace_root`), where the branch ref the worktree created survives its removal —
  never in the process cwd, and never against the checkout's own signing config. A commit made
  unsigned, or with any other key, is refused `commit_signature_unverified` and the IMPL row never
  lands; the plan stays where the envelope mint left it. Pinned end to end through the real
  executor child in `aria-kernel/tests/test_executor_implementation_identity.py` and at the
  boundary in `tests/test_implementation_signature_boundary.py`.
- The implementer's sandbox never writes the shared repository, and never sees the store
  (ARIA-HIGH-123). The write-containment sandbox (`implementation_safety.wrap_bash_in_sandbox`,
  and `wrap_managed_claude_in_sandbox` on top of it — ONE builder, `_sandbox_argv`, for both
  routes and for the probe) used to bind the workspace and ro-bind `.git/` and nothing else, so
  in a linked worktree — the executor's per-request tree, whose `.git` is a pointer file and whose
  git dirs live outside the workspace — every git command died `not a git repository`, in a main
  checkout `git add` died on `index.lock`, and the private signing key was readable inside
  (`aria-debts/` ro-bound). The binds are now DERIVED from the checkout's shape by
  `git_containment.derive_git_containment` (the one parser, `checkout_root` +
  `gh_token_factory.signing_checkout`), measured under real bwrap one bind at a time — and the
  agent's git runs against a REPLICA and a QUARANTINE, git's own receive-pack shape. The REPLICA
  is a kernel-made copy of the worktree's private git dir (`<private>/aria-sandbox/`: `HEAD`,
  `index`, `logs/HEAD`, the control files) bound over `<private>` inside, so `git switch`, `git add`
  and `git commit` rewrite the replica's `HEAD` and `index` and the host's stay as the drain left
  them (a `locked` the agent writes lands in the replica; the reaper's `git worktree remove --force`
  is never refused). The QUARANTINE is what git writes to: `GIT_OBJECT_DIRECTORY` at the
  replica's `objects/` (its `info/alternates` names the shared store for READS), the replica's
  `refs/heads/` and `logs/refs/heads/` bound AT `<common>/refs/heads` and `<common>/logs/refs/heads`
  — so a plain `git switch -c aria-impl-…` + `git commit` + `git push origin aria-impl-…` works
  unchanged inside while the shared common dir is bound READ-ONLY as a whole (`config`, `hooks/`,
  `info/`, `objects/` with its packs, `objects/info/alternates` and `maintenance.lock`,
  `packed-refs`, `refs/tags`, `refs/remotes`, the main checkout's `HEAD`/`index`/`logs/HEAD`): a
  write there is EROFS at the syscall. Existing loose refs under `refs/heads/` are overlaid
  read-only on top of the quarantine (visible, not rewritable — EBUSY on the mountpoint), bounded
  by `LOOSE_REF_OVERLAY_BOUND` (refused `loose_refs_exceed_overlay_bound:<n>`; `git pack-refs
  --all` is the remedy — bwrap admits at most 9000 argv tokens, which is also why existing loose
  OBJECTS are not overlaid one by one). READ-ONLY beside the workspace: the nearest ancestor
  `node_modules` (a per-request worktree resolves the checkout's tree). The EFFECTIVE hooks
  directory (`git rev-parse --path-format=absolute --git-path hooks`) is read-only inside. HIDDEN:
  `<common>/worktrees/` is a fresh tmpfs with only this worktree's entry (the replica) bound back;
  the main checkout's working tree is never bound; `<worktree>/aria-debts/keys/` is a fresh tmpfs
  with only the held identity's PUBLIC key bound back. The temp dir is the sandbox's own /tmp
  (`TMPDIR` exported by name). READONLY_PATHS keeps `.git/` and `aria-debts/` as the SCOPE and HOOK
  unit; `.git/` is no longer the unit of the mount layer.
  PUBLICATION: after the spawn — whatever its exit — the executor publishes the quarantine from
  OUTSIDE (`git_containment.publish_quarantine`, `ci_executor._publish_sandbox_commits`,
  governance row `implementation_quarantine_published`): every loose object is inflated and
  re-hashed before it moves (git reads loose objects BEFORE packed ones, so a crafted file under a
  packed object's name would shadow the good object — refused `object_hash_mismatch`, never
  migrated); a verified object is renamed into the shared store (content-addressed, an object the
  store holds is dropped, never overwritten); a pack the agent's git made is fed to `git
  unpack-objects --strict` against the shared store (each object under the hash of its inflated
  bytes; never a pack file copied whole); only ref files whose name matches the push grammar's own
  fragment (`command_policy.ARIA_IMPL_BRANCH_FRAGMENT`) and whose content is an object the store
  now holds are published with `git update-ref` (a real reflog row, the kernel's); everything else
  — a planted `main.lock`, a shadow `main`, a branch of the agent's naming — is discarded and named
  in the receipt; the worktree's HEAD then adopts the published branch the replica's HEAD names,
  so the executor's evidence check (`--evidence-target-sha auto`) grades the agent's files against
  the agent's commit. A killed executor publishes nothing: the quarantine dies with its worktree,
  and the shared repository never carried a byte of it.
  WHERE THE KEY LIVES: with the kernel. `implementation_identity` holds an ssh-agent
  (`signing_agent.hold_signing_agent`) for the identity window — started after the mint and BEFORE
  the registry write, so a refusal leaves no `kg_signers` row; listing exactly the cycle key;
  stopped on every exit of the body AND dying with its holder however the holder dies
  (`PR_SET_PDEATHSIG`, armed under `PR_SET_NO_NEW_PRIVS` because the distribution's set-gid
  `ssh-agent` drops the death signal at exec); its key lifetime is the window's remaining time
  (`-t`, from `ARIA_JOB_DEADLINE_EPOCH`, `lifetime_until`) so a socket that outlived everything
  holds no key past the deadline; started with PATH only (never the executor's environ) and with
  `-P '!*'` (no provider library can be loaded through the socket the sandbox holds) — and hands
  the sandbox the agent's socket (`/tmp/aria-signing-agent.sock`, `SSH_AUTH_SOCK` set by bwrap
  after the spawn environment was built, which drops the name as secret-shaped). `user.signingkey`
  still names the private path (the B7 config transaction's ownership marker is unchanged): git
  2.43 / OpenSSH 9.6 load `<private path>.pub` when the private file is absent and sign through the
  agent; without the agent the commit fails `No private key found`, never silently unsigned. The
  orchestrator's startup sweep (`prune_stale_signing_agents`, `prune_stale_hook_brokers`,
  governance `sockets_pruned`) removes socket directories whose listener is gone. The refusals
  ride the HIGH-115 release reason `implementation_signing_unavailable` with the cause in the
  governance row: `signing_agent_unavailable:<reason>`, `git_containment_refused:<reason>`; a MAIN
  checkout is refused `shared_checkout_scope:--local` (one spelling, one reading) and is never
  bound writable.
  WHERE THE STORE LIVES: outside, only. The hook commands compiled into the spawn's settings run
  the stdlib-only hook CLIENT by path (`<python> <kernel_root>/aria_kernel/hook_client.py <verb>`,
  `claude_settings.hook_command` — no store, no request id, no cap on the line) which ships the
  CLI's payload to the kernel-side BROKER (`hook_broker.serve_hook_broker`, served in the executor
  process around the spawn with the store, the workspace, the request id and the compiled turn cap
  as ITS facts) over one unix socket bound into the sandbox (`/tmp/aria-hook-broker.sock`,
  `ARIA_HOOK_BROKER_SOCKET` set by bwrap; an unconfined spawn gets the host path in its
  environment). The decision ledger, the turn count, the work journal, the checkpoint and the
  handoff snapshot are written by the kernel outside; a broker that cannot be reached is a DENY
  for PreToolUse and an "unrecorded" note for the verbs that cannot block. Nothing of the state
  store is mounted in the sandbox — not writable, not at all: the round-1 shape (the store root
  bound writable) handed the agent the request queue, claims, governance, the signer registry,
  operator control, adjudications, the cost ledgers and the very turn count it is gated by. What
  the agent can do through the socket is what a hook could always do for its own request. (The
  store-touching kernel commands the implementer contract still has the agent run inside —
  `apply gate`, `pr create` — and the `aria` MCP server spawned inside are ARIA-HIGH-124: they
  never worked in the production sandbox and are served outside next.)
  WHAT THE PROBE PROVES: `sandbox_backend()` is non-None only when bwrap builds its namespaces AND
  hosts the SIGNED contract (`containment_probe.probe_git_containment`: a throwaway linked
  worktree, a throwaway key minted into it by the identity's own mint, the kernel-held agent, a
  commit-capable containment derived with that signing exposure, `git status` / `git switch -c` /
  a signed `git commit` inside the real argv built with the managed route's network setting
  (`MANAGED_SPAWN_ALLOW_NETWORK`), `git config --local`, a hooks write and a read of the private
  key REFUSED inside, a planted `refs/heads/main.lock` that must not reach the repository, then
  the executor's own publication and `git verify-commit` against the minted key from outside).
  `/etc/passwd` and `/etc/group` are system binds: `ssh-keygen -Y sign` resolves its uid before it
  signs and dies `No user exists for uid N?` without them — the production runner's uid, which a
  root shell never showed because nss-systemd synthesizes root when `nsswitch.conf` is bound. A
  runner whose sandbox cannot host the signed commit is therefore refused by the pre-claim
  environment gate (`sandbox_unavailable`, the probe's reason in the row): the request stays
  PENDING, nothing is claimed, no identity is minted, no turn is spent. Pinned under real bwrap in
  `tests/test_git_containment.py` (the measurement, the refusals, the publication, the store's
  absence with a hook row reaching it through the broker, three mutations),
  `tests/test_containment_probe.py`, `tests/test_signing_agent.py` (a SIGKILLed holder),
  `tests/test_hook_broker.py`, `tests/test_implementation_identity_hold.py`, and end to end — the
  HIGH-115 chain through the REAL wrapper as the runner's uid and as root — in
  `tests/test_executor_implementation_identity.py`.
- Original cycle/plan/revision/content identities and public signer provenance retain their
  separate meanings. If the initial hook omits its plan ID, the supplied outer convergence linkage
  can provide it. No plan is inferred from a cycle name. An overlong supplied identity is omitted
  with `identity_omissions[field] = "display_length_exceeded"`, never shortened or replaced by
  fallback linkage. Exception messages, private paths and arbitrary hook fields are excluded.
- `reported_observation_counts` counts supplied receipt occurrences, not distinct hypotheses,
  successful new appends, a global pending backlog or measured gain. Replay receipts and audit
  failures can overlap persisted receipts. Persistence truth remains visible when an audit fails.
  Existing top-level status/exit policy, merge truth and error/warning counters are unchanged.
- Display limits are four cycles, eight observations total and 8 KiB of pretty-printed JSON.
  Cycle selection favors errors/unresolved work; observation allocation and byte trimming use
  global receipt priority with original-source-order ties. Omission counts cover all supplied
  cycles/receipts. These are display bounds, not history-scan or latency guarantees.
- The final CLI object, including `full_result_artifact` and the printed newline, must fit
  32,768 UTF-8 bytes. Optional memory detail shrinks before required counts. If essential data
  cannot fit, the CLI retains `contract_error` / exit 4. The full artifact retains the complete
  original result; it is not included in the stdout budget.
- Absent memory inputs leave legacy summary/reflection fields and report sections absent. Old
  reflection rows, sealed requests and published report bodies are not rewritten. New reports
  render a dedicated `Memory Learning` section from supplied results without scanning ledgers.

Ordinary contracts are exercised by `MemoryLearningSummaryTests` in `test_runtime_artifacts.py`,
the `test_pending_memory_reaches_*` and `test_memory_projection_survives_persisted_reflection_to_local_anchor`
cases in `test_autonomy_orchestrator.py`, CLI artifact/ceiling cases in
`test_cli_autonomy_subcommand.py`, and the real signature/legacy-input checks in
`test_reflection_inputs.py`. This establishes a local producer-to-report contract; live publication,
durable `pr_ci_scan`/promotion-summary visibility and measured learning usefulness require their
own acceptance evidence.

## 12.7 — Captured Rejected-Submission Context

`agent_invocations.create_agent_invocation_request` captures related native submission history
inside the existing `established_knowledge` envelope member. Its private reader takes one verified
`ledger.state_transaction` snapshot of the bound tools root's invocation requests, claims and
results. It joins a rejected result to its original `claimed` event and the canonical request
(the existing last-matching-request semantics). Worker identity and configured target remain
distinct. The snapshot records presence, row counts and tail hashes. Joining and rendering happen
after lock release; a later append does not invalidate this explicitly captured earlier cutoff.

Relevance uses complete original request refs and static scope prefixes before display limits,
with directory-boundary matching. Rejection text and rejected response refs do not establish
historical scope. A native join establishes the producer's recorded rejection and its provenance;
it does not prove that the rejected response passed evidence/context/transcript validation.

- `past_failed_attempts_state` distinguishes missing optional results, a complete search without
  rejections or related episodes, related episodes, and unavailable reads/joins. Unknown matching
  counts and truncation state are null. Unavailable history does not erase independently valid
  positive context; ordinary optional knowledge read failures do not erase qualified history.
  KG errors wrapping `OSError` are isolated at this optional boundary; other KG validation errors
  retain their existing behavior. No validation, admission, signing or lease authority changes.
- Five episodes are returned in reverse append order, with the complete matching count. Each has
  at most three reasons, scopes and refs. A long reason preserves a 120-character **native prefix**
  followed by a visible truncation marker; this is not a 120-byte or total rendered-length limit.
  Omission metadata records original/omitted counts and shortened detail. Scalars and displayed
  refs/scopes over 512 characters are explicitly omitted rather than silently conflated with
  absent provenance. Identity and relevance checks operate on complete source values first.
- These are display bounds. Full verified history reads and joins remain proportional to history
  size; neither bounded latency nor archive-resolvable retention is established by this slice.
  No path query starts a global history search. The reader creates no additional state surface.
- Render version 4 introduced this history projection (new v5 requests retain it). Hypotheses,
  recorded legacy verified status, supported beliefs, operator-adjudicated anti-patterns and
  rejected submission episodes retain distinct labels. This projection does not revalidate merge
  lineage or measured gain, and rejection is not a permanent prohibition or measured ineffective
  repair. Historical refs are provenance, not newly admissible evidence for the current task.
- The captured data is sealed at mint. Exact submission replay serves one episode, while a later
  legitimate result can inform a new request without rewriting an earlier prompt. Absent version
  and literal versions 2/3 keep their entire original UTF-8 rendering; no legacy expectation is
  regenerated under version 4. Existing public exports, ledgers and fused top-level keys remain.

Ordinary producer, availability, scope, replay and omission contracts are in
`tests/test_learned_context_and_intent.py::RejectedHistoryAtMintTest` and
`RejectedHistoryContractsTest`. Complete immutable v1-v3 bytes and versioned labels are covered
by `tests/test_prompt_render_versioning.py` and `tests/fixtures/prompt_render_legacy/`.
This is a local consumer contract. Measured usefulness, later outcome/retraction, retention and
deployed operation remain separate acceptance slices.

## 12.8 — Committed Source Snapshot

`snapshot.build_repo_snapshot` resolves one commit before enumerating a committed Git view.
Membership comes from that commit's tree with NUL-delimited path names; every blob read and
`base_commit_sha` use the same captured commit even if HEAD advances during collection. Staged
additions and deletions do not choose committed membership. The existing snapshot hash and
repository-state ID therefore describe that selected content view, not a mixture of revisions.

- A Git repository without a resolvable commit reports `committed_snapshot_base_unavailable`.
  A failed tree enumeration reports `committed_snapshot_tree_unavailable`; it does not become a
  successful empty snapshot. An unavailable committed blob produces an `unknown` fate with
  `committed_blob_unavailable`, no content hash/size and no allowed-source entry. Discovery carries
  that missing fate into an incomplete completion proof. Working bytes never replace that blob.
- In a working view, a selected missing, non-file or unreadable input has the existing `unknown`
  fate and `stat_or_read_failed` error, with no hash/size or allowed-source entry. Available source
  and generated files retain their classification; size and hash describe the same read bytes.
  An ordinary unstaged deletion therefore reaches discovery as an incomplete observation.
- `discovery.run_discovery` propagates the captured snapshot, fates and completion metadata to its
  return value and the existing `SNAPSHOT.json`, `FATES.json` and `COMPLETION_PROOF.json` artifacts.
  This contract does not make their sequential publication atomic across a crash.
- Public signatures, schema/result keys, dirty-workspace `enforce_clean` policy, working-mode
  alias and nonignored-untracked support remain unchanged. No-Git directories retain the existing
  filesystem observation with `base_commit_sha=None`; that is not an immutable committed proof.
  Dirty paths and `git_tracked`/`working_tree` counts remain observed index/working diagnostics,
  distinct from the selected committed fates and allowed paths.
- Whole discovery is not revision-pinned: fingerprint directory/existence fields and service-map
  project-marker reads still inspect the working filesystem. Working-mode `ls-files` path parsing
  remains unchanged; the quoted-name correction applies to committed tree enumeration. Later
  self-knowledge/assessment consumers must not claim these working observations as complete
  immutable source evidence. No read-latency or full-scan cost bound is established here.

Ordinary regressions in `tests/test_phase2_fates_snapshot.py::CommittedSnapshotViewTests` exercise
staged membership, a real commit transition during scanning, and the returned/written discovery
consumer. `CommittedSnapshotAvailabilityTests` covers missing commit/tree and ordinary committed
blob read failures; `SnapshotViewCompatibilityTests` covers committed quoted names, working/untracked
input, actual unstaged deletion with generated-file preservation and no-Git observations. Existing
FATES consumers and the three ordinary discovery cases in
`test_enterprise_cycle.py` preserve their existing behavior. This is the shared snapshot
prerequisite; outcome assessment, retained evidence and revision-bound self-feature qualification
retain their separate acceptance work.

## 12.9 — Scoped Executed Validation Inputs

`validation.run_validation_commands(..., input_scope=None)` optionally captures input provenance
around **each actual command**. Existing change/HEAD/clean-worktree admission stays at the batch
boundary; this metadata does not introduce per-command HEAD admission or continuous immutability.
The descriptor names explicit files, never hashes, verdicts or claims of coverage:

```json
{
  "schema_version": 1,
  "files": {
    "source": ["feature.py"],
    "test": ["test_feature.py"],
    "config": ["settings.json"],
    "dependency": ["local_helper.py"]
  }
}
```

Roles may be omitted or empty; their absence means unknown, not a proven empty input universe.
The snapshot owner's private explicit-path and file-reading helpers normalize the finite scope,
read working bytes without repository enumeration, and share a 16 MiB content-read budget across
before/after observations per command. Limits are 256 unique paths, 512 UTF-8 bytes per path and
2 MiB per file. Opened regular-file size/type checks precede unbuffered bounded reads; unavailable,
changed-during-read or over-budget inputs remain unknown. These limits do not bound existing Git
metadata/clean checks, command stdout/stderr collection, complete log hashing or total latency.

The optional `input_binding` uses the agreed v1 seventeen-field object: repository identity,
working-tree mode, admitted full commit, nullable full snapshot/state IDs, sorted scope paths,
source/test-selection/test-content/config/dependency/environment digests, scoped stability,
capture start/completion and per-dimension availability. Full snapshot/state IDs stay null because
a partial manifest is not the full snapshot. Identity and its diagnostic derive from one selected
observation in the existing workspace owner; public identity recipes/signatures remain unchanged.
Remote/root-commit identity may be available; basename fallback remains null/unknown in provenance.
The identity owner's sequential Git subprocesses are not an atomic metadata snapshot.

Canonical JSON manifests live in the existing hash-bound run log, containing before/after path,
length/hash/availability observations, role membership and actual supported argv/selectors.
Source, test-content, config and declared-dependency digests hash the before-observation role
manifest (`schema_version` plus its sorted file rows). Test-selection digest hashes its versioned
argv/selectors object. `unchanged` means all scoped file observations were available and equal;
`changed` and `unknown` preserve command status independently. Capture completion follows file
and identity observation. File contents and environment values are not added to these manifests.

Explicit `python3 -m unittest [-v|-q|--verbose|--quiet] dotted.selector...` records the requested
selector vector. Discovery, other command families and unsupported selector forms remain unknown.
Even explicit selectors do not prove actual collection, custom `load_tests` behavior or coverage.
Named config files do not establish effective configuration closure. Declared dependency-file
hashes do not establish installed/transitive dependencies; dependency qualification remains
unknown, and uncaptured runner environment has a null digest and unknown availability.

`validation_runs_ledger.record_validation_run(..., input_binding=None)` validates and copies a
bounded, fixed-depth v1 shape before native serialization: canonical identity/digest/path spellings,
bounded parseable dates, required availability and available/non-null consistency. This is shape
validation, not authentication that a direct caller executed a command. New bound rows receive an
owner-derived `ArtifactRefV2` only for the declared `validation_run_logs` surface, with the native
run ID and actual log hash. Omission preserves old row/log shape and external-log callers.
`verify_validation_run` resolves an existing native `log_ref` beneath the supplied tools root,
joining its artifact/run/producer/hash/content-type/surface through the existing owners before
hashing the complete hot log. Absent-reference legacy rows retain their recorded `log_path`.
It returns the unchanged native row; neither relocation nor repeated verification rewrites its
original path or ledger bytes. The public signature and large hot-log admission are unchanged.
The R2 local publish/teardown/receiving-bind fixture exercises this shared verifier in a fresh
child with candidate module origins. It does not execute the whole matrix/merge gate, remove
receiving hot logs or resolve cold validation archives. R3 retained-log/prefix closure remains
separate. Source, consumer edges and exact evidence are in
[catalogue-runtime-retention.md](./catalogue-runtime-retention.md#validation-run-ledger).

Ordinary producer/native verifier, known-byte and digest oracles, timestamp order, fresh revision
lineage, two-command working changes, unknown inputs, actual read bounds and schema contracts are
in `test_validation_runs_unified_surface.py::ValidationInputBindingTests`. Existing ledger readers
and snapshot/discovery consumers retain their contracts; `test_canonical_identity.py` covers the
workspace owner's remote/root/basename/worktree compatibility.

Tracked prerequisite **S2-E-ENV** belongs to validation, experiment and validation-run owners before
S3 Card 4 or S2-F may claim fully current demonstration/reinstatement. Section 12.11 supplies a
bounded partial observation; remaining producers must observe applicable dependency scope, with relevant
ordinary behavior and change-invalidates-applicability acceptance. Otherwise those consumers must
retain historical execution with unknown current applicability. Matching files and exit zero
cannot clear these unknowns; no measured learning gain or whole-system operation is established.

## 12.10 — Scoped Self-Feature Observations and Planner Context

The existing `twin/map.json` projection carries two named pilots:
`knowledge_graph.conventions_for_paths` and `runtime_artifacts.autonomy_output_summary`.
`cycle._phase_twin_refresh` supplies the actual discovery return to `twin.build_twin_map` /
`refresh_twin_map` through an optional `discovery` argument. The source reader consumes only bytes
matching that selected working or committed view; a matching HEAD alone cannot authorize reading
working AST bytes as committed facts. Changed or unavailable inputs remain unknown. Twin test
associations are inferred links, not executed coverage: a changed surviving test replaces its old
edges, and source membership changes re-resolve unchanged importing tests against the new tree.

The feature projection records owning symbol/path/hash, source-inferred purpose, named static
callers and test IDs, source/test/config/declared-dependency digests, discovery provenance and
separate implemented/reachable/configured/demonstrated/runtime labels. Definition presence and
optional annotation/display extraction have separate availability. Static reachability is not
runtime execution. The bounded named scope is partial; configured, demonstrated and runtime
status remain unknown, as do effective environment and installed/loaded dependency closure.
Existing agent-surface, capability-gap and registry owners retain their responsibilities.

At new-request mint, `agent_invocations` qualifies the captured projection against the exact supplied
source root, selected revision, named files and scoped Git membership. Root mismatch, changed target,
missing content or exhausted work withhold positive feature facts, with owner diagnostics retained.
This is an exact local-root association, not a new canonical repository identity recipe. There is
no full discovery, history refresh or test execution at mint, and no automatic inference that a
feature is absent when coverage is unknown. Public legacy twin status remains HEAD-based and does
not substitute for this mint qualification.

- Trial qualification limits are a 2 MiB projection read, 256 content paths, 2 MiB per file,
  16 MiB cumulative source/transport allowance, 4,096 consumed/emitted Git membership records and
  a common two-second cooperative deadline. The implemented pilot uses a fixed named input scope
  and observes direct imported-symbol calls, labelled `static_hops: 1`. The proposed two-hop /
  64-additional-path expansion is a future design maximum, not an implemented traversal.
  Whole cycle discovery/FATES selection, project scans, association
  rebuilds and Git history maintenance are separate costs. Pipe counts do not measure how many
  entries Git inspected internally; subprocess deadlines and scoped commands constrain that work.
- The state-store Git transport's strict mode is private and optional. It reserves both pipes and
  EOF headroom within the remaining allowance before reads, and closes/reaps acquired children on
  failure. An exhausted boundary can conservatively be unknown. Default callers retain legacy
  exact-cap behavior. Known source bytes and conservative transport reservations are distinct.
  Cooperative checks do not make Python parsing or filesystem observation continuously atomic.
- The drainer and round controller use `plan_convergence.plan_body_from_state` on their existing
  fold for structured current-body text/refs/hash. Legacy latest prose remains text with no matched
  structured-body claim; an older seed is not substituted. Independent challengers receive common
  source context without primary proposal content. Legal cross-review/later-primary state guards,
  existing agents, review obligations and caller-provided `allowed_scope` remain unchanged.
- Optional `context_source_paths` flow through the existing bridge/mint owners. The shared scoped
  literal-path normalizer bounds each path to 512 UTF-8 bytes before sorting/deduplication; at most
  the existing 200 affected-path entries are admitted. Historical broad/long plan surfaces stay
  valid plan data but are not expanded as retrieval hints. Partial status records supplied,
  accepted-unique, omitted and, when present, deduplicated counts. Request validation requires
  canonical sorted unique literals and consistent paired status. Hints do not become evidence refs
  or write permissions. Omitted/None retains the old request identity; normalized equivalents replay;
  different captured omission status participates in identity even when supported paths are equal.
- The outer orchestrator forwards its actual cycle/root; the controller preserves missing cycle
  provenance. `plan advance-rounds` uses the existing workspace argument/resolution owners. Omitted
  root on the public controller preserves legacy optional orientation, with no qualified feature
  claim. No signer, model, profile, merge, review or credential permission changes are implied.

New prompts use render version 6 (5 plus the `<obligation_data>` block, §12.17). The native request
captures qualification and whole feature entries before sealing. Selection considers at most eight
candidates/four displayed entries and 1,200 estimated tokens for the feature section, including
labels/diagnostics, under the existing total context cap. Up to four unavailable-source diagnostics
are displayed with an omission count. These are development-trial parameters, not optimality or
useful-coverage guarantees. Evidence, retrieval hints, feature observations, rejected history and
proposal permissions retain distinct labels.

The existing context-budget owner prices the final rendered prompt once plus captured agent/bookmark
costs. Optional feature entries shrink before sealing. An oversized mandatory baseline retains the
existing audit-only versus explicit enforcement choice. The request, native context and persisted
final audit share `budget_audit_hash`. The existing serialized native-write operation rechecks request
identity before persisting an audit; ordinary same-request callers leave one winning request/context/
prompt and final audit, without speculative trial/loser audits. This is not a multi-ledger rollback
guarantee. Early replay returns stored bytes without requalification or another budget audit.

Literal v1-v3 fixtures and genuinely issued v4 request/context/prompt artifacts are immutable inputs.
Actual rendering/fusion of these captures performs no current map/history/learning lookup. New
observations and refreshes preserve earlier native ledger prefixes; sealed prompts are never refreshed.

Ordinary source/association/deadline/qualification/render-budget contracts are in `test_twin_map.py`,
`test_twin_cycle_wiring.py`, `test_phase2_fates_snapshot.py` and `test_state_store.py::ScopedGitTransportTests`.
`test_convergence_resumable_step.py::PlannerTwinContextTests` covers real native initial/adopted/revised,
controller/CLI and legal later planner paths. The two native outer-planner cases in
`test_autonomy_orchestrator.py` inject a cycle wrapper and synthesizer but run real discovery/twin,
drainer and native mint; they do not execute the full enterprise-cycle/runtime pipeline.
`test_prompt_render_versioning.py` owns complete old prompt bytes; existing contract, bridge,
context-budget and native S2-E validation tests retain compatibility responsibility.

S2 assessment and archive-resolvable retention, S2-E-ENV partial observations plus actual autonomous
caller input binding/loaded-content evidence, and S3 Card 4 applicable behavioral demonstration remain
open prerequisites. S4 must establish requested/propagated/observed Astra Ultra execution without
misrepresenting the distinct-model gate; S5 must evaluate ordinary temporal tasks, negative transfer,
teaching and total memory cost. Source/config presence, merge status and repeated feedback alone do
not prove deployed operation, independent corroboration or measured improvement. Pressure-statistics
root propagation and repeated-feedback confidence remain separately tracked owner/phase obligations.

## 12.11 — Bounded Partial Child Environment Observation

`validation.run_validation_commands` retains its signature and default/v1 execution. An explicit
v2 `input_scope` adds exactly `execution_profile: {kind: "python_unittest_public_v1", modules: [...]}`
to the existing files descriptor. At most eight bounded dotted module names are admitted; the
existing command authority and explicit unittest selector recognition remain enforced. Other
admitted command shapes execute through their original path with profile observation unknown.
`experiment.run_experiment(..., input_scope=None)` forwards an explicit scope or selects one from
an opted-in recipe as specified in §12.12. Recipes and experiment observations retain their
existing schema versions and record-only comparator meaning.

The private `_validation_unittest_child.py` runs the selected unittest in the observed process,
preserving the actual unittest argument convention and checkout import root. It observes only
modules already in `sys.modules`; it does not import declared modules to manufacture applicability.
Interpreter implementation/version/flags are same-child observations. The closed public environment
set is `PYTHONHASHSEED`, `PYTHONUTF8`, `PYTHONDONTWRITEBYTECODE`, `LC_ALL`, and `TZ`, with bounded
numeric/boolean/locale/timezone forms; unsupported values are unknown without retaining their raw
contents. Values and file facts are post-run observations, not proof of startup configuration.
Source/cache/extension file hashes are not loaded or executed byte hashes. An ordinary test can
change a source file while an already imported function keeps its previous behavior.

One inherited pipe carries one final receipt of at most `min(4096, PIPE_BUF)` bytes. The parent
performs a bounded nonblocking read and never waits for descendant EOF. Optional pipe setup failure
can fall back to the original admitted command only before spawn; no execution is retried after
spawn. Independent best-effort descriptor closes preserve the real exit/stdout/stderr/timeout even
if optional cleanup reports an I/O error. Such error handling does not prove the OS released a
descriptor after a failed close. Native subprocess timeout/reaping and native ledger/log ownership
remain unchanged. No receipt sidefile, state surface, permission or credential lifecycle is added.

Selected content observations share 16 MiB actual reads, at most 256 admitted content paths and
2 MiB per file across before/observer/child/after. The child receives at most 4 MiB and sixteen
additional content paths, reserved before execution. Missing/unusable receipts charge the full
reservation before after-capture. Successful receipt work and original selected file facts are
retained even when later ENV qualification is unknown. These limits exclude unittest's own I/O,
output capture and native log hashing/persistence; reported child counters are observation work,
not telemetry of all reads performed by the test or interpreter.

One cooperative 250 ms active observation allowance covers parent observer identity/setup, child
post-run observation/preparation, parent receipt handling, and final ENV construction/encoding/hash.
Real test runtime and the unchanged S2 before/after capture/binding intervals are excluded. Parent
identity expiry retains charged bytes, withholds the hash and issues no renewed child allowance.
Missing timing receipts charge the full issued child allowance. Parent receipt and finalization
expiry withhold new positive ENV facts and hash the resulting compact unknown object. There is
at most one positive finalization and one unknown fallback. The child's elapsed scalar cannot
measure its later final wire/close tail; a final cooperative encoding check does not preempt a
blocked filesystem call. Native log serialization, append/fsync and cleanup tail costs are not
claimed to fit a hard wall-time cap.

The existing v1 `input_binding.runner_environment_digest` hashes the stable partial comparison
object. Detailed phase/work/PID/argv diagnostics live only in the existing hash-bound input-manifest
log. Stable identity excludes scratch paths, PIDs, timing and receipt resource handles. Original
requested argv remains selector provenance; actual spawned argv remains the log's executed vector.
The native row schema, original log verifier and public exports remain unchanged.

`test_validation_runs_unified_surface.py::ValidationInputBindingTests` owns the real producer,
argv control, cached source change, timeout/reaping, shared byte pressure, active deadline and
ordinary optional I/O tests. Its private child-cleanup test is a direct unit seam with a stubbed
unittest exit, not an additional native command proof. `test_experiment_bench.py::ExperimentBenchTests`
owns real opt-in bench forwarding and omitted/None compatibility. Control-profile observation is
explicitly unknown (`bounded_profile_observation_pending`); existing profile and scheduler-ceiling
readers/writers remain the only control owners and are unchanged.

This increment leaves effective configuration, installed/loaded dependency closure, actual test
collection, applicable native state and current behavioral demonstration unknown. The normal
recipe-to-stage/night connection is specified in §12.12. Portable restored log resolution,
S2 corrective/outcome assessment, S3 Card 4 and matched learning utility remain separate
obligations. A successful native run or comparison digest does not establish gain.

## 12.12 — Optional Recipe Inputs Through Normal Validation Callers

`experiment.register_recipe(..., input_scope=None)` accepts the existing canonical v1/v2
descriptor through the validation owner. Omitted/None recipes keep their previous row shape.
An opted-in recipe adds only `input_scope`, capped at 65,536 canonical JSON bytes; rejection
occurs before append. This carrier limit does not change direct validation's descriptor limits.
No public export, state surface, schema version, command permission or required plan field is added.

`apply_engine` resolves commands, timeouts and optional inputs from the same verified recipe
read. A recipe ID selects its latest row; a command lookup uses the exact row that supplied that
command, even if a later registration of that ID supplies a different command. Canonical commands
remain first, exact command strings retain their existing execution deduplication, and existing
timeout contributions and admission remain intact.
Contributing references are deduplicated and merged in execution-position, recipe-ID, ledger-hash
order. Scope paths are case-sensitive sorted unions within the existing fixed roles; a path may
retain more than one role. Different descriptor versions or profile kinds cannot be merged.

The optional v1 `validation_input_selection` object contains `status`, `input_scope`,
`recipe_sources`, `plan_content_hash` and `reason`. Source entries identify the exact recipe ID,
ledger hash and executed command. Staging binds the current verified plan body hash, forwards the
selected descriptor to the real baseline, and persists the selection on the existing apply action.
The candidate uses that stored selection; it does not replace it with a later recipe registration.
The existing two-result command helper and public stage/apply signatures remain callable unchanged.

Selection retains at most eight distinct recipe rows, 256 distinct paths and eight module names.
Source-reference recipe IDs are limited to 256 UTF-8 bytes and source commands to 4,096 UTF-8 bytes.
Reference gathering and the complete selection each have a 65,536-byte canonical JSON cap. These
bound retained metadata, not the existing full recipe-ledger read. An unsupported or oversized
optional selection becomes `unknown` metadata within 1,024 canonical JSON bytes with no retained
scope or source prefix; otherwise admitted commands still execute. Gather failures have
deterministic priority: intrinsic source metadata, unavailable source identity, distinct-row limit,
then aggregate reference bytes. Both byte failures report `selection_metadata_limit`;
row/path/module excess reports `selection_input_limit`. After successful gathering, sorted
descriptor merging retains its first diagnostic, including `selection_incompatible_scope` or
`selection_input_unavailable`. The final complete-selection cap independently accounts for scope and
source metadata together.

`experiment.run_experiment` gives an explicit non-None scope precedence. Omitted/None selects
only from an opted-in recipe and records that selection on the ordinary observation. Legacy
recipes retain their original call/row behavior. Both default `experiment_night` problem and
regression paths inherit this bench-owned selection without changing night runner injection.
`selected` means descriptor selection only: canonical or other admitted commands can have partial
file observations and unknown/unsupported environment observations. It is not dependency,
configuration, loaded-code or test-selection closure, nor a current-demonstration verdict.

`test_pr_manager_e2e.py::StagedConvergedPlanChainTests` owns actual baseline/candidate tests using
offline Nx test/lint, TypeScript and named unittest execution, plus deterministic union/limit
controls. `test_experiment_night.py::NightIntegrationTests` owns actual default problem/regression
execution with native finding/change/fix lineage. `test_experiment_bench.py::ExperimentBenchTests`
owns recipe retention, byte limits, automatic None/omitted selection and explicit precedence.
The ordinary boundary controls cover exact 256-path/eight-module/eight-row admission and overflow,
row-limit-over-reference-byte priority and an independently sized complete-selection overflow.

Engineering evidence captures original selected native rows and command-log bytes before fixture
cleanup, retaining native URIs/hashes and separate capture mappings. That bounded copy is not runtime
archive resolution or portable restoration. Retention R1/R2/R3, durable assessment/reinstatement,
applicable loaded-content/native-state evidence, S3 Card 4, runtime integration and measured learning
utility keep their existing owners and acceptance obligations.

## 12.13 — Explicit Manifest Provisioning of Optional Recipe Inputs

`tools/aria-poc/seed_experiment_recipes.py` retains its closed schema-v1 manifest and adds only
the optional recipe key `input_scope`. Its main entry preserves the existing command parser,
cycle identity, returned declarations and stdout. Missing or JSON-null scope means no opt-in;
the tracked default manifest remains unchanged.

Direct `seed(doc, ...)` callers preflight every non-null descriptor before either native append
loop. The private experiment-owner `_validated_recipe_input_scope` is shared with
`register_recipe`: it delegates to the existing canonical descriptor validation and 65,536-byte
canonical metadata limit. No second parser, public signature/export, state surface or scope
inference is introduced. Canonicalization does not mutate the supplied manifest. The per-descriptor
limit does not bound the loader's whole-manifest read or number of recipes. Optional-descriptor
rejection preserves existing native history; unrelated later writer failures retain the existing
separate-append behavior, without a general all-or-nothing transaction guarantee.

An explicit manifest reaches the existing latest-recipe resolver and automatic bench selection
from §12.12. Reseeding the same recipe ID appends a new registration; later runs resolve that
latest row. Scoped runs record its exact row/hash in selection provenance, while null/legacy runs
retain their original shape without that optional provenance. A subsequent null-scope registration
turns opt-in off for later runs. Earlier
recipe/experiment/observation/run records and logs retain their original bytes and references.
This does not rewrite a staged action's already selected inputs.

The autonomous author reuses an explicitly provisioned service recipe without extending its
scope from another finding. When no such recipe exists, its current service/finding inputs do
not establish test/configuration/dependency scope, so the authored recipe remains unscoped.
Author/planner reuse is not proof of command execution or environment completeness. This slice
does not schedule the seeder, infer descriptors, migrate legacy recipes or opt in the default
Nx/Cargo recipes. Loaded-content applicability, portable retention and measured utility remain open.

`tools/aria-poc/invariants/test_experiment_recipes_manifest.py::ExperimentRecipeManifestTests` owns
actual alternate-manifest main/seed/bench execution, null/legacy runs, three-registration reseed
continuity and positive canonicalization. Its separate direct-seed regression owns the
before-all-appends invalid/oversized-descriptor proof against genuine preexisting native history.
`aria-kernel/tests/test_x2_experiment_author.py::AuthorTests` owns unscoped author and explicit
recipe reuse through actual finding/author/planner owners, with a separate repository-state root per
fixture.
