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

- `.claude/agents/product-audit/INVOCATION-PACK.md`

## Runtime Roster

- `orchestrator.md`
- `context-manager.md`
- `architectural-arbiter.md`
- `ui-action-mapper.md`
- `mobile-app-auditor.md`
- `button-action-auditor.md`
- `form-write-auditor.md`
- `data-readback-auditor.md`
- `contract-parity-auditor.md`
- `schema-surface-parity-auditor.md`
- `access-boundary-auditor.md`
- `table-grid-auditor.md`
- `chart-widget-auditor.md`
- `file-transfer-auditor.md`
- `realtime-sync-auditor.md`
- `tenant-isolation-auditor.md`
- `workflow-state-auditor.md`
- `list-visibility-auditor.md`

## Runtime Discipline

- `context-manager` is the compaction and dependency-graph layer for multi-agent audit cycles
- `architectural-arbiter` resolves conflicts when one agent's recommendation would break another agent's invariant
- planning and prompt maintenance are not part of runtime audit cycles
- every non-trivial rule in this set should trace to repo evidence or research under `docs/research/agents/product-audit/`

## Output Convention

Recommended output locations:

- Per-agent reviews: `docs/test-audits/{agent}/{YYYY-MM-DD}-{topic}.md`
- Unified report: `docs/test-audits/orchestrator/{YYYY-MM-DD}-{topic}.md`

All reviewer agents should assign finding IDs in format `{severity}-{NNN}`.

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
