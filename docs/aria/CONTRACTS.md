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

| Concern | v7.2 assumed | Reality (CLI mode) |
|---|---|---|
| Orchestrator | Custom Python daemon | Claude Code session driven by slash command (`/aria-cycle`) and/or cron-launched `claude` invocations |
| Engines (Discovery, Memory, Pressure, Reflection) | In-process Python modules | Python scripts in `tools/aria/` invoked via `Bash` tool |
| Adapters | In-process Python ABCs | Python scripts in `tools/aria/adapters/` invoked via `Bash`; output JSON to disk |
| Skills | Subclasses of `Skill` Protocol | Sub-agent definitions in `.claude/agents/aria-*.md`; invoked via Claude Code `Agent` tool |
| Hooks (gates, redactor) | In-process Python | `.claude/settings.json` PreToolUse / PostToolUse hooks, e.g. `tools/aria/gates/*.ts` |
| LLM amplification | Direct `anthropic` SDK calls | Claude Code's own model selection — kernel never imports `anthropic` |
| Budget tracking | Custom `budget_gate.py` | Claude Code's existing cost telemetry + a thin observation hook |
| Cycle scheduler | Custom Python timer | OS cron / systemd timer running `claude /aria-cycle` |
| State persistence | Same — filesystem + workspace-internal git | Same |
| Kill switch | Same — file sentinel checked at every step | Same — slash command checks sentinel before tool calls |

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

- The `aria-kernel/llm_bridge.py` file mentioned in SPEC §6.1 — does not exist. Kernel never imports
  `anthropic`.

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

| Document | What it describes |
|---|---|
| `SPEC.md` | Boundaries (laws, engines, mastery, claim authority). Mostly unchanged by CLI mode; references to `anthropic` SDK are inaccurate but non-load-bearing. |
| `IDENTITY.md` | Behavior. Unchanged by CLI mode. |
| `CONTRACTS.md` (this) | Data + protocol contracts + CLI execution model + Phase-1 PoC. |
| `ROADMAP.md` | Physical phase gates after the PoC decision. Details link to `docs/aria/plans/`. |
| `plans/` | Decision-complete implementation plans for Phase 0 kernel, skill/agent genesis, and validation harness. |
| `plans/004-self-renewal-feedback-loop.md` | How missed signals, false positives, and external scanner disagreements become pressure without becoming trusted findings. |
| `.claude/knowledge/layer-1-aria.md` | Discoverable knowledge anchor for OTHER specialized agents — not ARIA's own configuration. |

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

| # | Eksen | Pattern manifesti | Hangi servisleri etkiler |
|---|---|---|---|
| 1 | CQRS folder topology | `commands/ handlers/ queries/ query-handlers/` per domain | 17 backend |
| 2 | Event contracts | `BaseEvent extends` + JSON Schema + upcaster chain | event-store + tüm event publisher'lar |
| 3 | Outbox pattern | `@PublishToOutbox` + outbox table + consumer | 12 service |
| 4 | Dual-alias | `@aquaculture/backend-common` ↔ `@platform/backend-common` aynı modül | tüm backend |
| 5 | NATS BEGIN GENERATED | `services.yaml` SSoT → `nats.conf` generated region (ADR-015) | infrastructure |
| 6 | Schema drift validator | `SchemaDriftModule.forRoot` per service, boot-time check (ADR-012) | 13 schema-owning |
| 7 | Banned-phrase enforcement | `tools/gates/banned-phrase.ts` CI gate (CLAUDE.md) | tüm commit'ler |
| 8 | Nx graph weighting | `nx.json` + `project.json` dependency depth | 17 backend + 7 frontend |
| 9 | Tenant scoping discipline | `getScopedRepository()` + tenant_id where-clause + JWT trust anchor | tüm tenant-data services |
| 10 | Sensor protocol register maps | Modbus / OPC UA / Atlas EZO register definitions | sens-api-gateway + sensor-service |
| 11 | Path → agent mapping | `apps/auth-service/**` → `auth-security-expert`, vs. | 38+ agent ↔ 17+7+1 servis |
| 12 | Sensor-ingestion sidecar | Rust sidecar + NATS publish + TS consumer (hybrid runtime) | hybrid TS+Rust |
| 13 | TypeORM auto-mapping | snake_case column ↔ camelCase property (drift değil, framework convention) | tüm TypeORM kullanan |
| 14 | NATS cert-CN identity | `services.yaml` + cert mint + `verify_and_map: true` (ADR-014/015) | NATS infrastructure |

### 1.2 — First-day adapter set (15 adapter, repo-aware)

Generic adapter (TypeScript-only / NestJS-only) yerine, her biri **belirli bir repo pattern'i** için
yazılmıştır. Sıra üretim önceliği — pressure'a göre adapter doğum sırası.

| # | Adapter | Globs | Ne çıkartır (pattern manifest) | Eksen | Tamamlayıcı agent(lar) |
|---|---|---|---|---|---|
| 1 | `typescript-nestjs-cqrs` | `apps/*/src/**/*.ts` minus `__tests__` | `@CommandHandler`, `@QueryHandler`, `@EventsHandler`, command/query/event class defs, `commandBus.execute()` call sites, **command → handler → event chain** | 1 | data-expert, contract-parity-enforcer |
| 2 | `typescript-event-contracts` | `libs/event-contracts/src/**/*.ts` + event publisher call sites | `BaseEvent extends` interfaces, `createBaseEvent()` factory calls, JSON Schema validators, upcaster transformations, **PascalCase eventType enforcement** | 2 | data-expert, contract-parity-enforcer |
| 3 | `typescript-outbox` | files importing `@platform/outbox` + `*.outbox.entity.ts` | `@PublishToOutbox` decorators, outbox entity registrations, publisher call paths, **entity → event → consumer matching** | 3 | data-expert, messaging-expert |
| 4 | `typescript-dual-alias` | `tsconfig.json` paths + `import` statements across `apps/`, `libs/` | resolves `@aquaculture/*` ↔ `@platform/*` to **canonical single module identity**; mismatched imports = alias-drift, NOT module-drift | 4 | platform-kernel-expert |
| 5 | `typescript-tenant-scoping` | files calling `getRepository\|getScopedRepository\|x-tenant-id` | `getScopedRepository()` vs forbidden `getRepository()`, tenant_id where-clause discipline, JWT-claim-vs-header trust path | 9 | tenant-isolation-auditor, auth-security-expert |
| 6 | `typescript-nestjs` | residual `apps/*/src/**/*.ts` not covered by 1–5 | generic `@Module`, `@Controller`, `@Injectable`, `@Entity` (dual-alias-normalized), `@Body()`, **TypeORM camelCase↔snake_case framework convention** (NOT drift) | 13 | (generic NestJS) |
| 7 | `sql-typeorm-migration` | `apps/*/src/database/migrations/*.ts` | migration class extends, schema declaration (per ADR-011), table CRUD, **timestamp ordering**, BEGIN-GENERATED region detection | 6 | database-reviewer, data-expert |
| 8 | `sql-schema-invariants-delegation` | (no globs — orchestrator) | runs `e2e/tests/integration/schema-invariants.spec.ts` headlessly, parses pass/fail per invariant; **defers schema-drift detection to existing validator instead of duplicating** | 6 | database-reviewer |
| 9 | `nats-services-yaml` | `infrastructure/nats/services.yaml` + `infrastructure/docker/nats/nats.conf` | services.yaml accounts list, nats.conf BEGIN-GENERATED region, **invariant: regenerate from services.yaml = exact byte match** | 5, 14 | infra-expert |
| 10 | `rust-sensor-protocol` | `sens-api-gateway/src/protocols/**/*.rs` + sensor protocol .md docs | Modbus register map, OPC UA NodeIds, Atlas EZO command sets, **register definition ↔ TS DTO drift detection** | 10, 12 | edge-expert, sensor-expert |
| 11 | `rust-sens-gateway-core` | `sens-api-gateway/src/**/*.rs` minus protocols | tokio runtime, async fn signatures, spawn/TaskTracker discipline, offline queue patterns, IEC 62443 surface markers | 10 | edge-expert, edge-industrial-auditor |
| 12 | `nx-graph` | `nx.json` + `apps/*/project.json` + `web/modules/*/project.json` | parses `npx nx graph --json`, builds dependency depth map, **weights cross-service drift severity by graph distance** | 8 | infra-expert |
| 13 | `agent-priors-mapper` | `.claude/agents/*.md` + `.claude/shared/orchestrator-routing-table.md` | agent name + scope from frontmatter, routing-table glob → agent mapping, **path → specialized-agent reference resolver** for finding `related_specialized_agent_domains` | 11 | (meta — no specialized agent owner) |
| 14 | `config-yaml-toml` | residual `**/*.{yaml,yml,toml,json}` not covered above | manifest sniff, package.json/Cargo.toml metadata, helm values, terraform IaC | (none specific) | infra-expert |
| 15 | `generic-bootstrap` | everything else | extension histogram, manifest detection, regex import extraction (≈70%) | (fallback) | (fallback) |

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

---

## 6 — Finding & Recommendation Schema

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
  "certainty": "CONFIRMED" | "OBSERVED" | "SUSPECTED" | "UNCERTAIN" | "UNKNOWN",
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

| Claim type | What it captures | Min severity floor | Min evidence count |
|---|---|---|---|
| `spine_drift` | Same domain concept differs across layers (DB vs entity vs DTO vs frontend). | MEDIUM | 2 (one per drifted layer) |
| `naming_drift` | Same concept named with different conventions across layers (`tenant_id` vs `tenantId` for the same column). | LOW | 2 |
| `convention_inconsistency` | A convention used uniformly in N places, broken in M places, no documented reason. | LOW | 3 (consistent samples + violator) |
| `wrong_code` | Bug — dead branch, unreachable return, swapped argument, missing await, swallowed exception, off-by-one, type-coerced equality with security implication. | MEDIUM | 1 (single code ref + reasoning) — this is the **bug note** category |
| `absence_in_scope` | Capability expected to exist but evidence not found in searched scope. Confidence cap 0.7 per L1 absence-claim discipline. | INFORMATIONAL | searched-scope record + synonym list |
| `currency_gap` | Dependency / pattern / library is N versions behind current stable. Informational only — recommendation requires L1 five-criteria gate. | INFORMATIONAL | 1 (registry + repo usage ref) |
| `duplication` | Identical-or-near-identical code structure repeated ≥3 times. May be intentional. | LOW | 3 |
| `contradiction` | Two evidences disagree (test asserts X, code does Y). | MEDIUM | 2 |
| `test_disagreement` | Test name suggests behavior, test body asserts different behavior. | MEDIUM | 1 (test ref) |
| `regression` | ARIA's own action's baseline comparison failed — emergency. | HIGH | baseline + comparison artifact |
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
  "shadow_value": 0.80,
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
so the operator can audit *what kind* of LLM work each skill triggered, even though ARIA cannot
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

| Component | Source of truth | Backup needed |
|---|---|---|
| `aria-kernel/`, `aria-immutable/` | Versioned in separate kernel repo | No (re-install) |
| `aria-grown/` | This workspace | Yes — skills are unique investment |
| `aria-memory/` | This workspace, internal git | Yes — knowledge is the product |
| `aria-capsules/` | Regenerable from repo + adapters, but expensive | Optional (rebuild on restore is acceptable) |
| `aria-spines/` | Same as capsules | Optional |
| `aria-indices/` | Regenerable from capsules | No |
| `aria-findings/`, `aria-proposals/` | This workspace | Yes — audit trail |
| `aria-config/` | Operator-managed | Yes (operator's responsibility) |
| `aria-baselines/` | This workspace | No (only useful for in-flight actions) |
| `aria-worktrees/` | Transient | No |
| `aria-episodic/` | This workspace, append-only | Yes — audit trail |
| `private_reports/` | This workspace | Yes — security record |

**Backup discipline:**

- Daily: `aria-memory/` (workspace-internal git push to operator-controlled remote)
- Weekly: full snapshot of `aria-grown/`, `aria-findings/`, `aria-proposals/`, `private_reports/`, `aria-episodic/`
- Restore validation: integrity check before restored kernel resumes operation
- No automated remote backup. Operator owns the backup destination — ARIA does not "phone home."

---

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

| Document | Layer |
|---|---|
| `SPEC.md` | Boundaries — laws, engines, mastery, claim authority, workspace |
| `IDENTITY.md` | Behavior — daily rhythm, refusals, speech, trajectory, self-honesty, missing-protocols (§12–§22) |
| `CONTRACTS.md` (this) | Data shapes, protocol contracts, LLM discipline, state machine, Phase-1 PoC |

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

---
