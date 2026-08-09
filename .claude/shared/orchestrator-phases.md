# Orchestrator — Phase Pipeline Details

**Audience:** `orchestrator.md` includes this fragment via `@.claude/shared/orchestrator-phases.md`. The detailed phase descriptions, dispatch examples, and unified-report template live here to keep the controller file focused on the dispatch protocol and decision rules.

The pipeline has **7 phases** (Phase 1, 2, 3, **3.5**, 4, **4.5**, 5, 6). Phase 3.5, Phase 4.5, and Phase 6 are conditional and trigger only when the criteria below are met. All other phases run on every review cycle.

## Phase 1 — Change Analysis

Run `git diff --name-only` (against main or the specified base) to get the list of changed files. Map each file to one or more agents via the routing table in `.claude/shared/orchestrator-routing-table.md`. Verify every changed file matches ≥1 primary agent; unmatched paths are PROCESS HIGH per the special dispatch rules in that file.

## Phase 2 — Parallel Dispatch (Two Lanes)

Phase 2 dispatches agents on **two parallel lanes** (Phase 13 of the post-audit consolidation plan):

- **Lane-A (code quality)** — the enterprise-v2 roster listed in `orchestrator.md` § Runtime Review Roster. Domain experts + cross-cutting reviewers (security-reviewer, performance-expert, compliance-expert, data-expert, etc.). These agents read source code + event contracts + migrations + infra; their finding prefix is `{AGENT}-{SEVERITY}-{NNN}` per the agent's own output-format contract.
- **Lane-B (product quality)** — the `.claude/agents/product-audit/` roster listed in `.claude/agents/product-audit/README.md` § Runtime Roster. <!-- cardinality:lane-b-specialists -->19<!-- /cardinality --> UI/product specialists (ui-action-mapper, button-action-auditor, form-write-auditor, table-grid-auditor, chart-widget-auditor, file-transfer-auditor, realtime-sync-auditor, workflow-state-auditor, list-visibility-auditor, data-readback-auditor, access-boundary-auditor, tenant-isolation-auditor, mobile-app-auditor, webhook-ingress-auditor, job-queue-auditor, billing-reconciliation-auditor, edge-industrial-auditor, accessibility-auditor, schema-surface-parity-auditor) + 3 meta-agents (product-audit-orchestrator, product-audit-context-manager, product-audit-arbiter). Finding prefix is `PRODUCT-{AGENT-PREFIX}-{SEVERITY}-{NNN}` (for example `PRODUCT-FORM-HIGH-001`) so cross-lane compaction can join on finding-file path while preserving which product auditor produced the signal.

Both lanes dispatch **in parallel** — every selected agent across both lanes runs concurrently unless an explicit dependency (e.g., contract-parity-enforcer consumes data-expert output) forces sequencing.

For each agent on either lane, provide:

1. Clear task description: "Review the following changes in your domain: [list of changed files]".
2. Context about what changed (brief git diff summary for their files).
3. Whether this is a focused review or full audit.
4. Any cross-domain context from other agents' domains that might be relevant.
5. The lane identifier + cycle topic (so Phase 3.5 cross-lane compaction can group).

### Lane selection — when to dispatch each

- **Always both lanes** for full-cycle reviews (full platform audit, weekly cycle, PR labeled `full-review`).
- **Lane-A only** for backend-only scope (no `web/**` changes) OR for agent-maintenance cycles where scope is `.claude/agents/**`.
- **Lane-B only** for pure UI/E2E change scope (e.g., a `web/modules/**`-only PR with no backend diff).
- **Both lanes with narrow Lane-B** when scope touches `web/**` + `apps/**` — Lane-B routes to the UI auditors whose `testMatch` glob intersects the changed web files (e.g., a form change dispatches form-write + data-readback but not table-grid).

### Lane overlap — consolidation discipline

Four agent names previously in `.claude/agents/product-audit/` were promoted into Lane-A during Phase 9/10:

- `gdpr-compliance-auditor` + `soc2-readiness-auditor` → absorbed into `compliance-expert` (Lane-A).
- `ai-tool-execution-auditor` → promoted to `ai-safety-auditor` (Lane-A).
- `contract-parity-auditor` → promoted to `contract-parity-enforcer` (Lane-A).

Those four MUST dispatch from Lane-A only; the duplicates in `.claude/agents/product-audit/` are retained for backwards-compatibility but are NOT re-dispatched by the orchestrator. `tenant-isolation-auditor` (Lane-B, product-surface UI leak detection) and `multi-tenant-saas-expert` (Lane-A, code-surface isolation + RLS + guards) are BOTH dispatched on cycles touching tenant-scope surfaces — their mandates do not overlap; they cross-compact in Phase 3.5.

### Example dispatch

```
Lane-A (code quality):
  Agent(farm-expert): "Review changes to apps/farm-service/src/batch/commands/create-batch.handler.ts
  and apps/farm-service/src/batch/entities/batch.entity.ts. A new 'priority' field was added to the
  batch entity. Check batch lifecycle integrity, event contract compatibility, and tenant isolation."

  Agent(data-expert): "Review the migration added at database/migrations/modules/farm/V007__add_batch_priority.sql.
  Verify it is idempotent, handles existing tenant schemas, and the new column type matches the TypeORM entity."

  Agent(security-reviewer): "Cross-cutting security review of batch entity changes. New field 'priority'
  added — verify it cannot be used for tenant data leakage or privilege escalation."

Lane-B (product quality):
  Agent(form-write-auditor): "Audit the create-batch form in web/modules/farm-module/src/create-batch-form.tsx.
  Verify the new 'priority' field reaches the backend, persists, and survives round-trip. Prefix findings PRODUCT-FORM-*."

  Agent(data-readback-auditor): "Verify 'priority' is read back on batch detail + batch list views in
  web/modules/farm-module/**. Detect read-gap vs write-gap classification. Prefix findings PRODUCT-READBACK-*."

  Agent(list-visibility-auditor): "Verify batch list + dashboard widgets correctly reflect the new 'priority'
  column after a create/edit. Prefix findings PRODUCT-LIST-*."
```

**Run agents on both lanes in parallel — never sequentially unless one agent's output is needed as input for another.**

## Phase 3 — Result Collection

Collect all agent reports. For each agent:

1. Note their findings (CRITICAL / HIGH / MEDIUM / LOW counts).
2. Note any cross-domain dependencies they flagged.
3. Note any SYSTEMIC issues identified.

## Phase 3.5 — Context Compression & Dependency Resolution (Cross-Lane)

Trigger conditions (any ONE sufficient):

- 3+ expert agents produced reports this cycle (counting both lanes — Lane-A + Lane-B combined).
- Estimated total report corpus > ~50K tokens.
- Multi-phase review is active (`.full-review/state.json` present).
- Any explicit cross-domain dependency was flagged by a domain expert.
- Both lanes fired (any review that dispatched to both Lane-A AND Lane-B MUST pass through cross-lane compaction — see §"Cross-lane consolidation" below).

Actions:

1. Dispatch `Agent(context-manager)` with the list of agents that produced reports and the paths under both `docs/reviews/{agent}/` (Lane-A) and `docs/product-audits/{agent}/` (Lane-B).
2. `context-manager` returns: a compacted finding set (CRITICAL/HIGH verbatim, MEDIUM grouped, LOW counted), a cross-domain dependency graph, a systemic pattern analysis, and a token budget status.
3. Any SYSTEMIC pattern flagged by `context-manager` automatically escalates severity by +1 per the existing escalation policy.
4. Any unresolved cross-domain edge from the dependency graph feeds into Phase 4 as a mandatory dispatch.
5. If two or more agents produced contradictory recommendations, OR any recommendation would break another agent's domain invariant → dispatch `Agent(architectural-arbiter)` with the conflicting reports. The arbiter produces a decision report (or escalates to human) before Phase 5 runs.

### Cross-lane consolidation

When a code-quality finding (Lane-A) and a product-quality finding (Lane-B) reference the same file / component / user flow, `context-manager` MUST merge them into a single root-cause entry rather than reporting them as two independent findings. Example merges:

- `form-write-auditor` `PRODUCT-FORM-HIGH-002` ("create-batch form submits but priority field never persists") + `data-expert` `DATA-HIGH-007` ("batch entity missing priority column after migration") → **SAME root cause** (missing column). Consolidated finding carries both IDs in its `origin_findings:` list and inherits the higher-severity classification (HIGH).
- `data-readback-auditor` `PRODUCT-READBACK-MEDIUM-004` ("stale batch list after tenant switch") + `frontend-expert` `FE-CRITICAL-001` ("bare `queryKey` array produces cross-tenant cache leak") → SAME root cause. Consolidated severity: CRITICAL (the write-surface leak dominates the read-surface lag).
- `workflow-state-auditor` `PRODUCT-WORKFLOW-HIGH-003` ("user can re-submit archived batch from detail page") + `farm-expert` `FARM-HIGH-005` ("create-batch handler lacks idempotency guard") → SAME root cause. Consolidated finding dispatches the fix to Lane-A agent (farm-expert), with Lane-B as the verification owner.

The consolidated finding:

- Preserves BOTH original IDs in `origin_findings: [LANE-A-ID, LANE-B-ID]`.
- Adopts the higher severity of the two inputs.
- Is owned by the Lane-A agent whose domain contains the root cause (product auditors surface symptoms; code experts own fixes).
- Enters the finding registry with a single consolidated ID `MERGED-{SEVERITY}-{NNN}` so downstream closing commits can `Closes:` one ID and automatically clear both origin IDs.

Cross-lane merges reduce noise — same root cause surfaced from two angles SHOULD appear once. A context-manager run that emits two adjacent findings with overlapping file paths + matching symptoms but no `origin_findings` list is a compaction defect.

## Phase 4 — Cross-Domain Resolution

Check if any agent flagged a cross-domain dependency that requires another agent. The context-manager's dependency graph (from Phase 3.5) is authoritative when present.

- If YES and the required agent was already invoked → check if their report addresses it.
- If YES and the required agent was NOT invoked → dispatch that agent now with the specific cross-domain task.
- If circular dependencies exist → flag for human resolution.
- If `architectural-arbiter` produced a decision in Phase 3.5 → apply that decision as the final word, overriding any individual agent's recommendation on the disputed point.

## Phase 4.5 — Root-Cause Auditor

**Status:** active (landed 2026-04-16 per Phase 5 of the post-audit consolidation plan; agent file `.claude/agents/root-cause-auditor.md`).

Runs after Phase 4 cross-domain resolution and before Phase 5 unified report. Role split (avoids same-cycle circularity per BLOCKER-12):

- **Within-cycle verification (current diff):** classify every author-authored `// tier-N:` claim against the 4-tier hierarchy and flag `OVER_CLAIMED` violations. Safe on the current diff because the author's inline claim exists before Phase 4 runs; no arbiter output needed. Consumes `tools/gates/tier-claim-lint.ts` output.
- **Cross-cycle verification (cycle N−1):** verify that `architectural-arbiter` rulings issued in the PREVIOUS review cycle have been implemented in the current cycle's diff. Rulings from the CURRENT cycle's Phase 4 land in the finding state registry as `IN-PROGRESS`; verified in the next cycle's Phase 4.5. Auditor never attempts to verify same-cycle arbiter rulings — those cannot have been implemented yet.

**Dispatch:** orchestrator invokes `Agent(root-cause-auditor, mode=review)` with
the cycle's changed-file set + prior-cycle ruling list (from
`docs/reviews/_registry/findings.jsonl`). Any `AUDIT-CRITICAL-*` blocks merge
per the same severity contract as domain experts. After a ruling's closing
commit is merged to protected `main`, its `IN-PROGRESS → RESOLVED` transition
is requested through the Finding Registry Authority workflow with a
retry-stable `command_id` and the full lowercase 40-character protected-main
closing SHA.

**Mechanical trigger (CLAUDE-MEDIUM-009):** Orchestrator MUST dispatch `root-cause-auditor` in Phase 4.5 when EITHER (a) the current diff contains at least one author-authored `// tier-N:` claim (detected by `tools/gates/tier-claim-lint.ts`), OR (b) the prior cycle's `architectural-arbiter` ruling transitioned to `IN-PROGRESS` state in the finding registry. Skipping dispatch when either condition is met is a `PROC-HIGH-*` self-finding against the orchestrator and halts the cycle. The `tests/invariants/orchestrator-routing-coverage.spec.ts` invariant asserts this "MUST dispatch" clause remains in this file (regex-anchored — silent prose removal fails CI).

**Build-validator cross-cutting dispatch (CLAUDE-MEDIUM-010):** In parallel with Phase 4.5 root-cause-auditor, orchestrator dispatches `build-validator` whenever the cycle's diff touches `apps/**`, `libs/**`, `platform/**`, or `web/**`. Its `BUILD-CRITICAL-*` findings block merge under the same contract as domain CRITICAL. Build-validator carries `dispatch: cross-cutting` frontmatter so the routing-coverage reverse check treats it as roster-reachable without requiring a glob primary.

**Registry is a hard dependency.** `docs/reviews/_registry/findings.jsonl` and
its read-only verifier are LANDED infrastructure; orchestrator cycles run
through them unconditionally. The previously-documented "fallback behaviour"
(emit observations as a review-file-only artifact when the registry is
unreachable) was removed 2026-04-18 to eliminate the dual-mode ambiguity
flagged as `CLAUDE-HIGH-003`. Every add or close uses `workflow_dispatch`
through `.github/workflows/finding-registry-authority.yml` on protected `main`; each
request uses a retry-stable `command_id`, and close supplies the full lowercase
40-character protected-main SHA carrying the `Closes:` trailer. Lifecycle
aging is owned exclusively by `.github/workflows/finding-state-sweep.yml`.
Agents never edit the JSONL or invoke seed, explicit-ID, rechain, dedupe, or
local mutating commands.

If the registry is missing or its chain is broken, halt the cycle and run
`npm run findings:verify` as a read-only diagnostic against a fresh
protected-main checkout. Record an operational incident and reconcile the
unauthorized delta against the last verified protected-main state; do not
manufacture a replacement ledger. A silent fallback would desynchronise the
registry, commits, and review files that the invariant suite cross-checks.

## Phase 5 — Unified Report (Two-Lane)

Produce a unified report combining all agent findings from both lanes. Save to `docs/reviews/orchestrator/{YYYY-MM-DD}-{topic}.md`.

```markdown
# Unified Review Report

**Date:** {YYYY-MM-DD}
**Scope:** {PR number or description}
**Lanes Fired:** {Lane-A | Lane-B | Both}
**Agents Invoked — Lane-A (code):** {list}
**Agents Invoked — Lane-B (product):** {list}

## Deployment Decision

**{BLOCK / PASS WITH CONDITIONS / PASS}**

- Blocking findings: {CRITICAL count and IDs, or "None"}

## Summary — Lane-A (code quality)

| Agent            | CRITICAL | HIGH    | MEDIUM  | LOW     |
| ---------------- | -------- | ------- | ------- | ------- |
| {agent}          | {n}      | {n}     | {n}     | {n}     |
| **Lane-A Total** | **{n}**  | **{n}** | **{n}** | **{n}** |

## Summary — Lane-B (product quality)

| Agent            | CRITICAL | HIGH    | MEDIUM  | LOW     |
| ---------------- | -------- | ------- | ------- | ------- |
| {agent}          | {n}      | {n}     | {n}     | {n}     |
| **Lane-B Total** | **{n}**  | **{n}** | **{n}** | **{n}** |

## Cross-Lane Consolidated Findings

| Merged ID           | Origin IDs                           | Severity | Root Cause                              | Owner           |
| ------------------- | ------------------------------------ | -------- | --------------------------------------- | --------------- |
| MERGED-CRITICAL-001 | FE-CRITICAL-001 + PRODUCT-MEDIUM-004 | CRITICAL | bare queryKey → cross-tenant cache leak | frontend-expert |

## Critical Findings (Deployment Blockers)

{List all CRITICAL findings from both lanes + merged IDs with file paths}

## High Priority Findings

{List all HIGH findings from both lanes}

## Cross-Domain Dependencies

| From Agent | Lane  | To Agent | Lane  | Issue         | Status          |
| ---------- | ----- | -------- | ----- | ------------- | --------------- |
| {source}   | {A/B} | {target} | {A/B} | {description} | {Resolved/Open} |

## Systemic Issues

{Any recurring patterns flagged by multiple agents across either lane}

## Agent Reports

### Lane-A (code)

- farm-expert: `docs/reviews/farm-expert/{date}-{topic}.md`
- security-reviewer: `docs/reviews/security-reviewer/{date}-{topic}.md`
- ...

### Lane-B (product)

- form-write-auditor: `docs/product-audits/form-write-auditor/{date}-{topic}.md`
- data-readback-auditor: `docs/product-audits/data-readback-auditor/{date}-{topic}.md`
- ...
```

**Finding ID propagation across phases:**

- Phase 2 expert reports assign `{PREFIX}-{SEVERITY}-{NNN}` IDs to every finding (prompt-writer content rule).
- Phase 3.5 context-manager preserves IDs verbatim during compaction and computes per-finding state (OPEN / IN-PROGRESS / RESOLVED / STALE / BLOCKED).
- Phase 5 unified report lists every CRITICAL and HIGH finding with its ID, state, and source review file path.
- If a separate post-review planning session is explicitly requested later, implementation-planner package files include `Closing-Findings:` and `Source-Reviews:` referencing those IDs.
- When fixes are implemented, executor commits include `Closes:` footers referencing the IDs verbatim (CLAUDE.md review traceability convention; enforced by `tools/gates/commit-msg-validator.ts`).
- STALE CRITICAL / HIGH findings from prior cycles appear in Phase 4 as mandatory dispatch targets to the source agent for escalation re-review.

## Phase 6 — Implementation Packaging (out-of-band, disabled by default)

This phase does NOT run during strict review-only operation. It runs only when a human explicitly asks for a separate planning session after the review is complete.

Actions:

1. Dispatch `Agent(implementation-planner)` with:
   - Path to the unified report from Phase 5.
   - Path to the context-manager compaction from Phase 3.5 (when present).
   - Path to any `architectural-arbiter` arbitration decisions (authoritative over individual expert recommendations on conflicting points).
2. `implementation-planner` produces `docs/plans/{YYYY-MM-DD}-{topic}/` tree:
   - `plan.md` — index with checkboxes, topologically-sorted package list, dependency graph link.
   - `packages/NN-{slug}.md` — self-contained per-package files (findings verbatim, affected files, atomic commit plan, test plan, verification command, rollback plan).
   - `dependency-graph.md` — Mermaid DAG of package prerequisites.
   - `verification-log.md` — append-only execution log scaffold.
3. The package plan is what a human reviewer or executor agent consumes to implement fixes in a fresh bounded context per package. Context resets between packages keep the LLM within safe budget, enabling reliable execution of large review outputs.
4. `implementation-planner` is REVIEWER ONLY — writes plans under `docs/plans/`, never source code.
5. Packaging cycles in the package DAG → escalate to `architectural-arbiter` per the implementation-planner's domain rules.
