# Orchestrator — Phase Pipeline Details

**Audience:** `orchestrator.md` includes this fragment via `@.claude/agents-enterprise-v2/_shared/orchestrator-phases.md`. The detailed phase descriptions, dispatch examples, and unified-report template live here to keep the controller file focused on the dispatch protocol and decision rules.

The pipeline has **7 phases** (Phase 1, 2, 3, **3.5**, 4, **4.5**, 5, 6). Phase 3.5, Phase 4.5, and Phase 6 are conditional and trigger only when the criteria below are met. All other phases run on every review cycle.

## Phase 1 — Change Analysis

Run `git diff --name-only` (against main or the specified base) to get the list of changed files. Map each file to one or more agents via the routing table in `_shared/orchestrator-routing-table.md`. Verify every changed file matches ≥1 primary agent; unmatched paths are PROCESS HIGH per the special dispatch rules in that file.

## Phase 2 — Parallel Dispatch

Invoke all identified agents **in parallel** using the Agent tool. For each agent, provide:

1. Clear task description: "Review the following changes in your domain: [list of changed files]".
2. Context about what changed (brief git diff summary for their files).
3. Whether this is a focused review or full audit.
4. Any cross-domain context from other agents' domains that might be relevant.

**Example dispatch:**

```
Agent(farm-expert): "Review changes to apps/farm-service/src/batch/commands/create-batch.handler.ts 
and apps/farm-service/src/batch/entities/batch.entity.ts. A new 'priority' field was added to the 
batch entity. Check batch lifecycle integrity, event contract compatibility, and tenant isolation."

Agent(data-expert): "Review the migration added at database/migrations/modules/farm/V007__add_batch_priority.sql. 
Verify it is idempotent, handles existing tenant schemas, and the new column type matches the TypeORM entity."

Agent(security-reviewer): "Cross-cutting security review of batch entity changes. New field 'priority' 
added — verify it cannot be used for tenant data leakage or privilege escalation."
```

**Run agents in parallel — never sequentially unless one agent's output is needed as input for another.**

## Phase 3 — Result Collection

Collect all agent reports. For each agent:
1. Note their findings (CRITICAL / HIGH / MEDIUM / LOW counts).
2. Note any cross-domain dependencies they flagged.
3. Note any SYSTEMIC issues identified.

## Phase 3.5 — Context Compression & Dependency Resolution

Trigger conditions (any ONE sufficient):
- 3+ expert agents produced reports this cycle.
- Estimated total report corpus > ~50K tokens.
- Multi-phase review is active (`.full-review/state.json` present).
- Any explicit cross-domain dependency was flagged by a domain expert.

Actions:
1. Dispatch `Agent(context-manager)` with the list of agents that produced reports and the paths under `docs/reviews/{agent}/`.
2. `context-manager` returns: a compacted finding set (CRITICAL/HIGH verbatim, MEDIUM grouped, LOW counted), a cross-domain dependency graph, a systemic pattern analysis, and a token budget status.
3. Any SYSTEMIC pattern flagged by `context-manager` automatically escalates severity by +1 per the existing escalation policy.
4. Any unresolved cross-domain edge from the dependency graph feeds into Phase 4 as a mandatory dispatch.
5. If two or more agents produced contradictory recommendations, OR any recommendation would break another agent's domain invariant → dispatch `Agent(architectural-arbiter)` with the conflicting reports. The arbiter produces a decision report (or escalates to human) before Phase 5 runs.

## Phase 4 — Cross-Domain Resolution

Check if any agent flagged a cross-domain dependency that requires another agent. The context-manager's dependency graph (from Phase 3.5) is authoritative when present.

- If YES and the required agent was already invoked → check if their report addresses it.
- If YES and the required agent was NOT invoked → dispatch that agent now with the specific cross-domain task.
- If circular dependencies exist → flag for human resolution.
- If `architectural-arbiter` produced a decision in Phase 3.5 → apply that decision as the final word, overriding any individual agent's recommendation on the disputed point.

## Phase 4.5 — Root-Cause Auditor

**Status:** active (landed 2026-04-16 per Phase 5 of the post-audit consolidation plan; agent file `.claude/agents-enterprise-v2/root-cause-auditor.md`).

Runs after Phase 4 cross-domain resolution and before Phase 5 unified report. Role split (avoids same-cycle circularity per BLOCKER-12):

- **Within-cycle verification (current diff):** classify every author-authored `// tier-N:` claim against the 4-tier hierarchy and flag `OVER_CLAIMED` violations. Safe on the current diff because the author's inline claim exists before Phase 4 runs; no arbiter output needed. Consumes `tools/gates/tier-claim-lint.ts` output.
- **Cross-cycle verification (cycle N−1):** verify that `architectural-arbiter` rulings issued in the PREVIOUS review cycle have been implemented in the current cycle's diff. Rulings from the CURRENT cycle's Phase 4 land in the finding state registry as `IN-PROGRESS`; verified in the next cycle's Phase 4.5. Auditor never attempts to verify same-cycle arbiter rulings — those cannot have been implemented yet.

**Dispatch:** orchestrator invokes `Agent(root-cause-auditor, mode=review)` with the cycle's changed-file set + prior-cycle ruling list (from `docs/reviews/_registry/findings.jsonl`). Any `AUDIT-CRITICAL-*` blocks merge per the same severity contract as domain experts. Rulings transitioning `IN-PROGRESS → RESOLVED` trigger finding-registry state update via `tools/gates/finding-registry.ts close` in the Phase 6 pipeline.

**Fallback behaviour** (when gate / registry infrastructure is not yet live in a branch): auditor emits observations as a report in `docs/reviews/root-cause-auditor/{date}-{topic}.md` with `AUDIT-*` finding IDs; orchestrator Phase 5 incorporates the section as any other agent's output. State transitions recorded by hand in the review-file YAML front matter until the CLI is reachable.

## Phase 5 — Unified Report

Produce a unified report combining all agent findings. Save to `docs/reviews/orchestrator/{YYYY-MM-DD}-{topic}.md`.

```markdown
# Unified Review Report
**Date:** {YYYY-MM-DD}
**Scope:** {PR number or description}
**Agents Invoked:** {list}

## Deployment Decision
**{BLOCK / PASS WITH CONDITIONS / PASS}**
- Blocking findings: {CRITICAL count and IDs, or "None"}

## Summary
| Agent | CRITICAL | HIGH | MEDIUM | LOW |
|-------|----------|------|--------|-----|
| {agent} | {n} | {n} | {n} | {n} |
| **Total** | **{n}** | **{n}** | **{n}** | **{n}** |

## Critical Findings (Deployment Blockers)
{List all CRITICAL findings from all agents with file paths}

## High Priority Findings
{List all HIGH findings}

## Cross-Domain Dependencies
| From Agent | To Agent | Issue | Status |
|-----------|----------|-------|--------|
| {source} | {target} | {description} | {Resolved/Open} |

## Systemic Issues
{Any recurring patterns flagged by multiple agents}

## Agent Reports
- farm-expert: `docs/reviews/farm-expert/{date}-{topic}.md`
- security-reviewer: `docs/reviews/security-reviewer/{date}-{topic}.md`
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
