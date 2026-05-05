# V2 Agents Review-Only Compliance Review

**Date:** 2026-04-10
**Scope:** `.claude/agents/*.md` (README excluded from agent verdicts)
**Goal:** verify that the V2 agent set stays inside a strict `review-only` operating model and does not drift into source editing or execution ownership.

## Review Criteria

For this review, an agent is considered **strictly compliant** when it:

- reads code, reports, tests, or metadata
- produces review outputs, findings, recommendations, or meta-review synthesis
- does **not** edit source code, migrations, configs, or workflows
- does **not** own remediation execution

Two special classes are called out separately:

- **Meta-review compliant:** does not review source directly, but coordinates/synthesizes/arbitrates review output
- **Borderline / review-adjacent:** does not edit source code, but moves beyond review into planning or prompt generation

## Overall Verdict

The V2 set is **mostly aligned** with a strict review-only model, but not perfectly.

- **17 agents are cleanly compliant reviewer agents**
- **2 agents are cleanly compliant meta-reviewers**
- **2 agents are review-adjacent and should be treated with policy caveats**
- **1 agent is a direct scope exception under a strict review-only charter**

## Findings

### HIGH-001: `prompt-writer` is not a review agent under a strict review-only charter

Evidence:
- `.claude/agents/prompt-writer.md:3` says it "Generates enterprise production-grade system prompts"
- `.claude/agents/prompt-writer.md:10-12` explicitly says its purpose is to write agent definitions

Assessment:
- This is a **tooling/authoring agent**, not a code reviewer or meta-reviewer.
- It does not edit application source code, but it still creates prompt assets rather than performing review.
- If the folder is intended to contain only review agents, `prompt-writer` is the clearest mismatch.

Operational implication:
- Keep it outside the runtime review roster.
- Treat it as maintenance tooling for agent evolution, not as part of the production review pipeline.

### MEDIUM-001: `implementation-planner` stays doc-only but extends beyond pure review into remediation planning

Evidence:
- `.claude/agents/implementation-planner.md:3` says it produces an implementation plan
- `.claude/agents/implementation-planner.md:10` says it writes plans for executors
- `.claude/agents/implementation-planner.md:16-20` writes under `docs/plans/`

Assessment:
- This agent is **not a code editor**, so it does not violate the no-source-change rule.
- But it is not pure review either; it is a **review-to-execution bridge**.
- Under a strict "only review" interpretation, it is outside the clean reviewer set.

Operational implication:
- Safe to keep as a separate post-review tool.
- Should not be counted as a primary review agent if you want a fully pure review roster.

### MEDIUM-002: `orchestrator` is review-first, but its Phase 6 path expands the pipeline into planning

Evidence:
- `.claude/agents/orchestrator.md:207-227` defines Phase 6 implementation packaging
- `.claude/agents/orchestrator.md:216` dispatches `implementation-planner`

Assessment:
- The orchestrator is fundamentally a **meta-review coordinator** and is valid in a review-only system.
- However, the current document embeds a conditional handoff to implementation planning.
- That means the file represents a **review pipeline plus optional planning pipeline**, not a pure review pipeline.

Operational implication:
- If you want strict review-only runtime behavior, treat Phase 6 as disabled by policy.
- The orchestrator itself can stay; the planning branch should simply not be invoked.

## Agent-by-Agent Verdicts

### `admin-expert`

Verdict: **Compliant**

- Reviews admin backend and admin UIs.
- Operating mode is explicit `REVIEWER ONLY`.
- No source-editing or implementation ownership language.

### `architectural-arbiter`

Verdict: **Compliant (meta-reviewer)**

- Arbitrates conflicts between review outputs instead of editing code.
- Reads reports and, only when required, source files for conflict verification.
- Stays within review/meta-review boundaries.

### `auth-security-expert`

Verdict: **Compliant**

- Pure security/domain reviewer.
- Strong no-edit posture.
- Correctly scoped to auth pipeline surfaces plus review escalations.

### `context-manager`

Verdict: **Compliant (meta-reviewer)**

- Compacts and synthesizes review outputs.
- Does not edit code and does not cross into execution.
- Fully acceptable inside a review-only architecture.

### `data-expert`

Verdict: **Compliant**

- Reviews migrations, event contracts, schema behavior, and shared data surfaces.
- No implementation ownership.
- Strong traceability contract.

### `database-reviewer`

Verdict: **Compliant**

- Audits resulting schema state rather than writing migrations.
- Clear separation from execution.
- Strongly aligned with review-only policy.

### `edge-expert`

Verdict: **Compliant**

- Reviews Rust edge agent and protocol contract docs.
- No code-writing authority.
- `sensorprotocols/**` inclusion remains reviewer-oriented.

### `farm-expert`

Verdict: **Compliant**

- Standard domain reviewer.
- No execution drift.
- Clear cross-domain escalation rules.

### `frontend-expert`

Verdict: **Compliant**

- Reviews frontend shell/shared-ui/module surfaces.
- No implementation ownership.
- Stays inside analysis/reporting boundaries.

### `hr-expert`

Verdict: **Compliant**

- Pure domain reviewer.
- No write path.
- Properly constrained to HR domain plus escalations.

### `implementation-planner`

Verdict: **Borderline / review-adjacent**

- Does not edit source code.
- Does write execution packages and plan state under `docs/plans/`.
- Acceptable as auxiliary tooling, but not as a strict reviewer.

### `infra-expert`

Verdict: **Compliant**

- Reviews infra, deploy, workflows, actions, Docker, and nginx surfaces.
- No config editing allowed.
- Strongly aligned with enterprise review-only posture.

### `mcp-expert`

Verdict: **Compliant**

- Reviews MCP runtime, auth/session scope, tools, prompts, and backend adapters.
- No source-editing authority.
- New agent is correctly reviewer-shaped, not builder-shaped.

### `messaging-expert`

Verdict: **Compliant**

- Reviews messaging and AI-service domain logic.
- No execution authority.
- Cross-domain routing is reviewer-oriented.

### `multi-tenant-saas-expert`

Verdict: **Compliant**

- Cross-cutting tenancy reviewer.
- Strong review-only framing.
- Good separation between SaaS concerns and lower-level auth/data concerns.

### `orchestrator`

Verdict: **Compliant (meta-reviewer) with planning drift**

- Core role is review coordination, dispatch, synthesis, and unified reporting.
- That is valid meta-review behavior.
- Phase 6 should be considered optional/off-policy if strict review-only runtime is required.

### `platform-kernel-expert`

Verdict: **Compliant**

- Reviews shared runtime/kernel surfaces.
- No code-editing or rollout ownership.
- Strongly aligned with reviewer-only expectations.

### `platform-services`

Verdict: **Compliant**

- Reviews billing/notification/config/event-store/observability/hydroponics/alert-engine service implementations.
- No scope drift into shared kernel ownership or implementation.

### `prompt-writer`

Verdict: **Non-compliant with strict review-only charter**

- This agent writes/updates agent definitions.
- It is useful and safe as tooling, but it is not a reviewer.
- It should be treated as maintenance infrastructure, not as part of the strict review roster.

### `security-reviewer`

Verdict: **Compliant**

- Explicitly `READ-ONLY REVIEWER`.
- Strongest example of strict review-only behavior.
- No execution drift.

### `sensor-expert`

Verdict: **Compliant**

- Pure reviewer for sensor backend/frontend and industrial protocol concerns.
- No write path.
- Correctly delegates edge implementation review to `edge-expert`.

### `test-runner`

Verdict: **Compliant**

- Runs tests and build checks, but still as a review-quality gate.
- Does not edit code.
- This is operationally active review, not implementation.

## Clean Reviewer Core

If the goal is a **strict review-only runtime roster**, the clean core is:

- `admin-expert`
- `architectural-arbiter`
- `auth-security-expert`
- `context-manager`
- `data-expert`
- `database-reviewer`
- `edge-expert`
- `farm-expert`
- `frontend-expert`
- `hr-expert`
- `infra-expert`
- `mcp-expert`
- `messaging-expert`
- `multi-tenant-saas-expert`
- `orchestrator` (with Phase 6 treated as disabled by policy)
- `platform-kernel-expert`
- `platform-services`
- `security-reviewer`
- `sensor-expert`
- `test-runner`

## Auxiliary / Out-of-Band Agents

These are the files that should be treated as outside the strict runtime review roster:

- `prompt-writer` — tooling/authoring
- `implementation-planner` — post-review planning

## Final Recommendation

The V2 set is close to the target, but the strict sentence "only review yapmaliyiz" is not literally true for the full folder as it stands.

The most accurate statement is:

- the **core domain and meta-review agents are compliant**
- `prompt-writer` should be treated as **non-review maintenance tooling**
- `implementation-planner` should be treated as **optional post-review planning tooling**
- `orchestrator` should be run in **review-only mode**, meaning **Phase 6 is policy-disabled**

Under that interpretation, the V2 roster is operationally safe for detailed, agent-by-agent review work without code changes.
