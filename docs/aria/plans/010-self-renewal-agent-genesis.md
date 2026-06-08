<!-- ARIA-HISTORICAL: Historical plan document. Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 010: Self-Renewal and Agent Genesis Foundation

## Summary

Plan 010 moves ARIA from evidence renewal toward capability renewal without allowing arbitrary runtime agents. ARIA maps existing `.claude/agents`, recommends calibration changes from feedback, detects capability gaps, drafts `aria-*` agent definitions into ARIA ledgers, and requires sandbox plus operator approval before any agent PR lane can be used.

## Key Changes

- Reflection calibration records recommendation-only pressure/tool threshold changes from feedback, tool health, budget, crash, and precision evidence.
- Agent priors mapping extracts existing specialized agent ownership so ARIA extends existing domains before proposing new agents.
- Capability gap detection combines SHADOW runs, repeated unknowns, and low fitness dimensions into typed gaps with evidence refs and related agent domains.
- Agent genesis drafts are stored under ARIA ledgers with fixed fields for scope, forbidden scope, evidence contract, output schema, and three validation fixtures.
- Genesis sandbox requires at least three fixture results and blocks duplicates owned by existing agents.
- Operator approval can mark a passed draft as `approved_for_agent_pr`; ARIA does not write `.claude/agents/*.md` outside the gated PR lane. Plan 012 §Agent genesis PR lane and Plan 016 §Snowball and PR ownership define that lane: ARIA prepares the diff via `aria-kernel pr create --base snowball`, kernel-side validation enforces scope and separation of duties, and only after that gate does the diff modify `.claude/agents/aria-*.md`.

## Acceptance

- Agent priors map fixture `.claude/agents/*.md` into domain, scope globs, claim types, and output contracts.
- Capability gaps prefer `existing_agent_extension` when an owner already covers the affected path.
- Unowned recurring SHADOW patterns can produce `draft_shadow` agent drafts with three validation fixtures.
- Sandbox pass is required before `approved_for_agent_pr`.
- Capability gaps appear as task candidates with `source_authority=capability_gap`.
- Calibration recommendations remain recommendation-only and preserve hash-chain integrity.

## Assumptions

- “Agent yazma” means safe draft and PR planning, not uncontrolled runtime agent spawning.
- Existing `.claude/agents` are canonical prior art.
- New `aria-*` agents start in SHADOW and require operator approval before repo-tracked files are created.
- Kernel self-modification remains separate from agent genesis and cannot auto-merge.
