# Legacy Agents — FROZEN

**Status:** FROZEN (2026-04-16, during W2 of the agent+skill+gate initiative)

## What this means

This directory contains the original 20-agent review roster. It is **no longer the canonical set**. All new agent authoring, review routing, and skill integration target `.claude/agents-enterprise-v2/` instead.

- **No new work may land in this directory.** PRs modifying files here require @Okan-wqm review (CODEOWNERS gate, BLOCKER-9) and will be rejected by default.
- **Orchestration flows are migrating to enterprise-v2.** Until the cutover (scheduled W14 of the plan), the original `.claude/agents/` remains available for opt-in use by explicitly naming it in the Agent tool invocation.
- **Scheduled archival:** W14 — this directory will be renamed to `.claude/agents.legacy/` (AMENDMENT-C in plan v4). Content will remain for historical reference through a 30-day grace period, after which the folder may be removed.

## Why frozen (not deleted)

1. Gradual cutover — until enterprise-v2 proves stable for 2 review cycles (plan v4 W13 calibration), the legacy set is a fallback.
2. Historical record — review output authored against legacy agents (`docs/reviews/<agent>/*.md`) references these agent files. Deleting them would break historical finding IDs.
3. Migration evidence — file-level diff between legacy and enterprise-v2 agents captures the design intent of the v2 cycle. Keeping both preserves the delta.

## Where new work goes

All NEW work lands under:

```
.claude/agents-enterprise-v2/                   ← review agents (v2)
.claude/agents-enterprise-v2/_shared/           ← shared template fragments
.claude/knowledge/                              ← 3-layer knowledge SSoT
.claude/skills/                                 ← procedural recipes (W5 onwards)
.claude/gates/                                  ← rule manifest, mandatory rules
.claude/allowlists/                             ← boundary allowlist
```

Routing: `.claude/agents-enterprise-v2/orchestrator.md` dispatches to enterprise-v2 agents; legacy agents are invoked only with explicit `legacy:` prefix (W14 cutover removes this affordance).

## References

- `/root/.claude/plans/declarative-riding-shamir.md` AMENDMENT-C — lifecycle
- `.claude/agents-enterprise-v2/README.md` — v2 design intent + activation
- Plan v4 W14 deliverable — archival + cutover
