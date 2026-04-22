# Test Agents

This folder contains a dedicated agent set for end-to-end product audits that follow a user action across:

- `web/**` UI surfaces
- `web/apps/aquamobil/**` mobile app surfaces
- `apps/**` backend services
- persistence and event side effects
- read-back and on-screen visibility
- tenant isolation boundaries

## Design Intent

This set intentionally follows the enterprise-v2 prompt methodology in `.claude/agents/`:

- reviewer-only operation
- explicit output locations
- root-cause-first findings
- strict severity discipline
- cross-agent dependency handoff
- prior-work awareness
- no workaround recommendations
- no "fix later" posture
- report traceability with `{severity}-{NNN}` IDs
- deterministic routing where practical
- meta-review compaction and conflict resolution

This set is optimized for "does the product actually work end to end?" review cycles, especially for:

- forms
- edit/save buttons
- inline actions
- modal submits
- list/detail pages
- filters and search inputs
- destructive actions
- bulk actions
- roundtrip persistence
- tenant isolation
- role and permission boundaries
- tables, grids, sorting, filtering, pagination
- charts, KPIs, widgets, dashboards
- file upload/import/export/download flows
- realtime, polling, sync, notification, and live-update surfaces

The prompts are for reviewer agents, not implementation agents. They are meant to discover gaps such as:

- UI fields that never reach the backend
- backend writes that never persist correctly
- DB writes that never come back to the UI
- stale list/detail views after saves
- weak tenant scoping in UI, API, cache, events, or DB
- button states that allow invalid lifecycle transitions
- DTO/entity/UI mismatches
- UI forms/actions with no real DB counterpart
- DB tables/columns/entities with no product-facing counterpart
- table columns, filters, or exports that diverge from stored truth
- chart/widget math that does not match backend aggregates or read models
- file flows that upload, export, or preview the wrong thing
- realtime surfaces that lag, lie, or cross contexts
- soft-delete, audit, outbox, and side-effect gaps
- mobile-only offline draft, reconnect, and cached-view drift

Methodology research for this set lives at:

- `docs/research/agents/product-audit/2026-04-11-professional-e2e-review-methodology.md`

Operational runbook for invoking this set lives at:

- `docs/runbooks/product-audit-invocation.md` (moved out of `.claude/agents/` dispatch surface 2026-04-18)

## Runtime Roster

<!-- cardinality:lane-b-active-agents -->22<!-- /cardinality --> agents. Dispatch name (the `name:` frontmatter) is the `Agent(subagent_type=...)` token; file path shown in parentheses when it differs from the name.

Meta-agents (product-audit-* prefix for global name uniqueness vs Lane-A):

- `product-audit-orchestrator` (file: `orchestrator.md`)
- `product-audit-context-manager` (file: `context-manager.md`)
- `product-audit-arbiter` (file: `product-audit-arbiter.md`)

Specialists:

- `access-boundary-auditor`
- `accessibility-auditor`
- `billing-reconciliation-auditor`
- `button-action-auditor`
- `chart-widget-auditor`
- `data-readback-auditor`
- `edge-industrial-auditor`
- `file-transfer-auditor`
- `form-write-auditor`
- `job-queue-auditor`
- `list-visibility-auditor`
- `mobile-app-auditor`
- `realtime-sync-auditor`
- `schema-surface-parity-auditor`
- `table-grid-auditor`
- `tenant-isolation-auditor`
- `ui-action-mapper`
- `webhook-ingress-auditor`
- `workflow-state-auditor`

Deprecated and retired to `.claude/agents.legacy/product-audit/` (no dispatch):
`contract-parity-auditor` → Lane-A `contract-parity-enforcer`;
`gdpr-compliance-auditor` + `soc2-readiness-auditor` → Lane-A `compliance-expert`;
`ai-tool-execution-auditor` → Lane-A `ai-safety-auditor`.

## Runtime Discipline

- `product-audit-context-manager` is the compaction and dependency-graph layer for multi-agent audit cycles
- `product-audit-arbiter` resolves conflicts when one agent's recommendation would break another agent's invariant
- planning and prompt maintenance are not part of runtime audit cycles
- every non-trivial rule in this set should trace to repo evidence or research under `docs/research/agents/product-audit/`

## Output Convention

Recommended output locations:

- Per-agent reviews: `docs/product-audits/{agent}/{YYYY-MM-DD}-{topic}.md`
- Unified report: `docs/product-audits/orchestrator/{YYYY-MM-DD}-{topic}.md`

All reviewer agents should assign finding IDs in format `{severity}-{NNN}`.

## Integration with the enterprise-v2 orchestrator (Phase 13)

Since Phase 13 of the post-audit consolidation plan (2026-04-17), this set is dispatched as **Lane-B (product quality)** of the unified two-lane review pipeline coordinated by `.claude/agents/orchestrator.md`.

- Lane-A (code quality) = the enterprise-v2 roster (domain experts + cross-cutting reviewers).
- Lane-B (product quality) = this roster.
- Both lanes fire in parallel from the same orchestrator cycle; Phase 3.5 cross-lane compaction merges findings that reference the same root cause.

Finding prefix in Lane-B is `PRODUCT-{SEVERITY}-{NNN}` so cross-lane compaction can distinguish Lane-A findings (prefix per agent: `FARM-*`, `DATA-*`, `FE-*`, `SEC-*`, etc.) from Lane-B findings at a glance. See `.claude/shared/orchestrator-phases.md` § Phase 2 for lane selection rules and § Phase 3.5 for cross-lane consolidation.

Four agents originally in this set were promoted to Lane-A during Phase 9/10 and MUST NOT be re-dispatched from here:
- `gdpr-compliance-auditor` + `soc2-readiness-auditor` → absorbed into `compliance-expert`.
- `ai-tool-execution-auditor` → promoted to `ai-safety-auditor`.
- `contract-parity-auditor` → promoted to `contract-parity-enforcer`.

The file copies remain on disk for backwards compatibility (older review cycles reference them by path) but the active dispatch paths go through the Lane-A promotion targets. New PRs touching those domains should expect the Lane-A agent name in the unified report.

`tenant-isolation-auditor` (Lane-B, product-surface UI leak detection) is distinct from `multi-tenant-saas-expert` (Lane-A, code-surface isolation + RLS + guards). Both dispatch in parallel on cycles touching tenant-scope surfaces; their mandates do not overlap — they cross-compact in Phase 3.5.

## Activation

Point your orchestration flow at `.claude/agents/product-audit/` when the goal is a product roundtrip audit rather than a pure architecture review.

Typical examples:

- "Scan every form in farm + admin and verify create/edit actually persists"
- "Check whether all frontend actions have a real backend write path"
- "Verify tenant isolation across create/list/detail/edit flows"
- "Audit whether saved values are reloaded and rendered correctly"
- "Check whether AquaMobil create/edit flows survive offline, reconnect, and tenant switching"
- "Find frontend forms that have no durable database counterpart"
- "Find database entities or columns that never surface back into product flows"
- "Verify every table, chart, widget, and export reflects real stored data"

## Exclusions

This set is not for:

- generic static code review
- prompt maintenance
- patch planning
- infra-only audits
- low-level schema-only audits without UI/API behavior in scope
