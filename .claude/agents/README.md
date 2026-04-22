# Enterprise V2 Agent Set

This folder contains a new candidate agent set built from the existing `.claude/agents/` prompts, the April 10 review findings, and the repo's existing research docs. The legacy agents remain untouched.

## What Changed

- Routing now has explicit primary ownership for previously uncovered surfaces:
  - `platform/configs/**`
  - `platform/libs/cqrs/**`
  - `platform/libs/event-bus/**`
  - `libs/backend-common` runtime foundations
  - `mcp/**`
  - `infra/**`, `deploy/**`, `.github/actions/**`
  - `sensorprotocols/**`
- Two new agents were added:
  - `platform-kernel-expert.md`
  - `mcp-expert.md`
- Reviewer traceability is normalized: agents that were missing the finding-ID contract now require `{severity}-{NNN}` IDs.
- `prompt-writer.md` is tightened to prefer production-proven rules, explicit ownership, and sibling-folder generation when old agents must stay in place.

## Design Intent

This set is optimized for enterprise architecture review, not patch-level code advice. The prompt bar is:

- no speculative rules
- no workaround recommendations
- no "fix later" posture
- shared-layer defects fixed at the shared layer
- every meaningful repo surface has a primary owner

Runtime review roster excludes maintenance tooling:

- `prompt-writer` is for agent-definition maintenance
- `implementation-planner` is for explicit post-review planning only
- strict orchestrator operation is Phase 1-5 review flow unless a human asks for planning separately

## Activation

**Status (2026-04-16): CANONICAL.** Legacy `.claude/agents/` archived to `.claude/agents.legacy/` as part of Phase 0.1 of `/root/.claude/plans/abstract-brewing-mochi.md`. This directory is now the single-source runtime agent roster. See `.claude/agents.legacy/README.md` for archival rationale and 30-day deletion window.

W3 conversion wave (in-flight) brings remaining legacy-style agents (security-reviewer, orchestrator, implementation-planner, frontend-expert, platform-services, hr-expert, database-reviewer, context-manager, admin-expert, prompt-writer) under the ≤200-line SSoT-reference template (`.claude/shared/_conversion-template.md`). Phase 1 of the abstract-brewing-mochi plan completes it.
