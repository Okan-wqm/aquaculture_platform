# ARIA Contracts & Phase-1 PoC

> **Purpose:** Data schemas, protocol contracts, and the minimum-viable Proof-of-Concept the operator can run next week to test if ARIA is worth building
> **Companion to:** `SPEC.md` (boundaries) and `IDENTITY.md` (behavior)
> **Authority:** Subordinate to SPEC.md
> **Length budget:** ≤700 lines

---

## 0 — Why this document exists

`SPEC.md` defines what the system must obey. `IDENTITY.md` defines how the system must behave. Neither tells an implementer **what data shapes flow between engines** or **what the smallest runnable thing looks like.**

Without that, two implementers reading SPEC + IDENTITY would produce two incompatible systems that both technically satisfy the laws. This document closes that gap.

It is also the operator's decision tool: the Phase-1 PoC at the end (§13) is the smallest concrete artifact that answers "do we actually need ARIA?" before committing to months of kernel work.

**Honesty floor (still):** none of the schemas below are implemented. Every JSON example is a contract for code that has not been written.

---

## 1 — Adapter Protocol

Every adapter (TypeScript, SQL, Rust, config-file, etc.) implements this protocol. Adapters are how the kernel sees specific languages without baking them into the kernel.

```python
class Adapter(Protocol):
    name: str                    # e.g. "typescript-nestjs"
    version: str                 # semver, owned by adapter author
    file_globs: list[str]        # e.g. ["**/*.ts", "**/*.tsx"]
    excluded_globs: list[str]    # e.g. ["**/*.d.ts", "**/node_modules/**"]

    def can_parse(self, path: Path) -> bool:
        """Returns True if this adapter accepts this file. Cheap check
        (extension + manifest sniff), no full parse."""

    def parse(self, path: Path, content: bytes) -> AdapterResult:
        """Full structural parse. MUST be deterministic — same input
        always produces same output. MUST be sandboxed — adapter
        cannot read other files, cannot call network, cannot execute
        repo code."""

    def parse_window_signature(self, path: Path) -> str:
        """Stable hash of the file features this adapter cares about.
        Used by Mastery Downgrade Protocol (IDENTITY §12) to detect
        when a file moved beyond the adapter's parse window."""

@dataclass(frozen=True)
class AdapterResult:
    symbols: list[Symbol]        # functions, classes, types, exports
    imports: list[Import]        # what this file imports
    exports: list[Export]        # what this file exports
    annotations: list[Annotation]  # decorators, attributes, pragmas
    parse_errors: list[ParseError]
    parser_version: str          # for cache invalidation
    parsed_at: datetime
```

**Adapter discipline:**
- Pure function: `(path, content) -> AdapterResult`. No side effects.
- No LLM calls. Adapters are mechanical.
- Sandboxed: adapter process cannot exceed declared file scope.
- Crash-isolated: an adapter crash on one file does not stop Discovery.
- Reports parse errors as data, never raises into kernel.

**First-day adapter set for this repo (per SPEC §5.3):**

| Adapter | Globs | What it extracts |
|---|---|---|
| `typescript-nestjs` | `**/*.{ts,tsx}` minus `*.d.ts`, `node_modules` | NestJS decorators (`@Module`, `@Controller`, `@Entity`, `@Column`, `@Injectable`), TypeORM entities + `schema:` declarations, `getScopedRepository` calls |
| `sql-typeorm-migration` | `apps/*/src/database/migrations/*.ts` | Schema declarations (per ADR-011), table CRUD, `BEGIN GENERATED`/`END GENERATED` regions for nats.conf-style |
| `rust-sens-gateway` | `sens-api-gateway/**/*.rs` | Modules, traits, `#[tokio::main]`, async fn signatures, sensor protocol implementations |
| `config-yaml-toml` | `**/*.{yaml,yml,toml,json}` filtered | nx project graph, services.yaml, nats.conf, package.json/Cargo.toml manifests |
| `generic-bootstrap` | everything else | Extension histogram, manifest detection, regex import extraction (≈70% accuracy fallback per SPEC §4 Engine 1) |

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
- Every capsule MUST have ≥1 `evidence_anchors` entry. A capsule with no anchor cannot be drilled down → fraudulent (L1 violation).
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

**Drift signature stability:** the signature includes only structural diffs (which values are missing where), not cosmetic ordering. Same drift state = same signature even if member order changes.

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

**source_type allowlist:** `code_reference`, `external_authoritative_source`, `test_demand`, `git_history`, `trusted_config_file`, `trusted_prior_doc` (CLAUDE.md, ADRs, knowledge layers per SPEC §5.1). Anything else = L1 violation, claim rejected at the gate.

---

## 6 — Finding & Recommendation Schema

```json
{
  "$schema": "aria/finding/v1",
  "finding_id": "F-247",
  "severity": "HIGH" | "MEDIUM" | "LOW" | "INFORMATIONAL",
  "status": "OPEN" | "IN_PROGRESS" | "RESOLVED" | "SUPPRESSED" | "WITHDRAWN",
  "claim_type": "spine_drift",
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

When `recommendation` is non-null, it MUST contain the five recommendation evidences (per IDENTITY §4 Step 8 Gate 3):

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

## 7 — Critical Observation Schema

Critical observations bypass the ≥2-evidence requirement (single trigger sufficient per L1) but cannot be lost.

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

`persisted_before_next_tool_call: true` is a hard invariant. If `false`, the kernel itself is broken — emergency stop.

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

`subtype` is intentionally free-form — Reflection discovers useful subtypes per repo. The kernel does not enumerate them.

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

## 10 — LLM Call Discipline

When the kernel calls Anthropic API:

```python
@dataclass(frozen=True)
class LLMCallSpec:
    purpose: str                       # e.g. "summarize-capsule-content"
    tier: Literal["haiku", "sonnet", "opus"]
    max_input_tokens: int
    max_output_tokens: int
    cache_key: str | None              # None = uncacheable
    cache_ttl_seconds: int | None
    redaction_passes_required: list[str]  # e.g. ["secret", "customer_data"]
    skill_attribution: str             # which skill is paying for this call
    budget_check: BudgetCheck

@dataclass(frozen=True)
class BudgetCheck:
    skill_daily_remaining_tokens: int
    workspace_daily_remaining_tokens: int
    workspace_monthly_remaining_tokens: int
    blocked: bool
    blocked_reason: str | None
```

**Tiering policy:**
- `haiku` — capsule summaries, small classification, mechanical-feel work
- `sonnet` — drift interpretation, finding text composition, reflection
- `opus` — sparingly, only for cross-capability synthesis when reflection demands it

**Mandatory ordering (every call):**
1. `secret_redactor.redact(prompt_inputs)` — fail-closed: if redactor errors, call is blocked
2. `customer_data_redactor.redact(prompt_inputs)` if scope flagged as customer-data-bearing
3. `budget_gate.check(workspace, skill)` — fail-closed: if exceeded, call is blocked, kill switch warmed
4. `cache_lookup(cache_key)` — return cached if present, no API call
5. API call with prompt caching headers when applicable
6. `output_redactor.scrub(response)` — strip any sensitive content the model emitted
7. `episodic_log.record(call_spec, redaction_proof, budget_delta, cache_outcome)`

**Budget config (`aria-config/budget.json`):**

```json
{
  "workspace_daily_token_cap": 5000000,
  "workspace_monthly_token_cap": 100000000,
  "per_skill_daily_token_cap_default": 200000,
  "per_skill_overrides": {
    "spine-drift-detector": 500000
  },
  "soft_stop_threshold_pct": 80,
  "hard_stop_threshold_pct": 100,
  "on_hard_stop": "kill_switch_trigger"
}
```

`on_hard_stop: kill_switch_trigger` is the safe default — exceeding the cap halts ARIA, not silent overrun. Operator must explicitly raise the cap to resume.

---

## 11 — Cycle State Machine

```
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

**Crash recovery:** if the process dies between `READ_SELF` and `HALT_CLEAN`, the next cycle's `INIT` detects the missing `HALT_*` marker and triggers integrity audit on all writes since the last clean halt. Capsules written but not committed to workspace-internal git are rolled back.

**Concurrency model:** single ARIA instance per workspace. File lock is mandatory. A second instance attempting to start exits 0 silently — no crash, no error report, no race.

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

## 13 — Phase-1 PoC (operator decision tool)

Before committing to months of kernel work, the operator runs this PoC to answer: **"do we actually need ARIA?"**

### Scope

- Duration: **1 working week** (≈5 days, ≈20 hours)
- Code budget: **≤300 lines Python**, no external dependencies beyond stdlib + `tomli` + `pyyaml`
- LLM calls: **zero**. Pure mechanical analysis.
- Deliverable: report at `/tmp/aria-poc-report.md`

### What it does

```
1. Filesystem walk (excluding agent-workspace/, node_modules/, .git/, dist/, build/)
2. Reconcile with `git ls-files`
3. Assign every file a fate (read_deeply | read_skimmed | skipped_with_reason)
4. Compute REPO_FINGERPRINT.json:
   - language histogram
   - manifest detection (package.json, Cargo.toml, project.json, nx.json)
   - service count per apps/*
   - frontend MFE count per web/*
   - migration count per service
5. Ingest CLAUDE.md → CLAUDE_MD_PRIORS.md (markdown summary, no LLM)
6. Ingest docs/adr/*.md → ADR_PRIORS.md (per-ADR title + first-line decision)
7. Index .claude/agents/*.md → AGENT_PRIORS.md (per-agent name + scope from frontmatter)
8. Run nx graph --file=.aria-poc/build-graph.json (if nx available)
9. Mechanical drift scan (no LLM, no skills):
   - Find every TypeScript enum
   - Find every SQL CREATE TYPE ... AS ENUM
   - Match by name (heuristic)
   - Report any name match where value sets differ
10. Generate /tmp/aria-poc-report.md with:
    - REPO_FINGERPRINT summary
    - Coverage stats (files / fates)
    - Top 5 mechanical drifts found (or "none detected" with searched-scope notation)
    - Estimated full-ARIA value: would these drifts have been caught by existing 38 agents on next PR cycle? (operator answers manually)
```

### What this PoC does NOT do

- No skill genesis. No adapter birth. No capsule storage. No mastery levels.
- No LLM. No findings. No recommendations.
- No PR creation. No worktree. No baseline capture.
- No persistence beyond `/tmp/aria-poc-report.md` and `.aria-poc/` (gitignored).

### Decision criteria

After running the PoC, the operator answers:

1. Did the fingerprint reveal anything they did not already know? (yes/no)
2. Did the mechanical drift scan surface real drift not caught by existing 38 agents? (yes/no)
3. Is the surface area of step (2) large enough to justify months of kernel work? (yes/no)
4. Is the LLM budget required for full ARIA (estimate: $200–$2000/month) within scope? (yes/no)

If 3 of 4 are "no", **do not build the kernel**. Archive SPEC, IDENTITY, CONTRACTS as research artifacts. The 38 specialized agents + Nx + CI already cover the value surface.

If 3 of 4 are "yes", proceed to Phase 0 (kernel skeleton, ≈4 weeks: orchestrator state machine + Discovery + Memory + budget gate + kill switch + integrity hash chain — no skills yet).

### PoC location

Implement in this branch as `tools/aria-poc/` (single Python file, single test file). Operator runs:

```
cd /home/user/aquaculture_platform
python tools/aria-poc/poc.py --workspace-root .
cat /tmp/aria-poc-report.md
```

The PoC is the only ARIA-related code that is allowed to land in this branch without the full kernel surrounding it. It is the operator's "do we even start?" gate.

---

## 14 — Closing

Three documents now define ARIA on paper:

| Document | Layer |
|---|---|
| `SPEC.md` | Boundaries — laws, engines, mastery, claim authority, workspace |
| `IDENTITY.md` | Behavior — daily rhythm, refusals, speech, trajectory, self-honesty, missing-protocols (§12–§22) |
| `CONTRACTS.md` (this) | Data shapes, protocol contracts, LLM discipline, state machine, Phase-1 PoC |

What is **still missing on paper:** nothing structural. Future revisions to these documents should come from operating ARIA (after it is built), not from more rounds of pre-implementation specification.

What is missing **as code:** all of it. None of these contracts are implemented.

The next legitimate step is the Phase-1 PoC (§13). The kernel does not begin until the PoC's decision gate is passed.
