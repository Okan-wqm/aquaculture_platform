# Product-Audit Orchestrator — Phase Pipeline Details (Lane-B)

**Audience:** `.claude/agents/product-audit/orchestrator.md` includes this
fragment via `@.claude/shared/product-audit-orchestrator-phases.md`. The
detailed phase descriptions + dependency resolution + decision rules live
here so the main controller file stays under the ≤200-line template cap.

## Phase 1 — Surface Mapping

Inventory the product surface under review:

- forms and modals
- buttons and inline row actions
- filters, search bars, and pagination controls
- detail pages and list pages
- tables, grids, row actions, and exports
- charts, KPIs, widgets, dashboards, and trend views
- uploads, attachments, imports, downloads, and previews
- polling, SSE, notifications, and live status surfaces
- route guards, permissions, role-gated entry points, and impersonation
- create, edit, delete, archive, restore, retry, approve, sync, import, export flows

Deterministic routing for each surface + auditor dispatch bullet list lives
in `.claude/shared/product-audit-orchestrator-routing.md`.

## Phase 2 — Roundtrip Verification

Treat every meaningful user action as a roundtrip:

1. User sees a control
2. User can interact with it under the right state/role
3. Payload reaches the intended backend contract
4. Backend validates and persists correctly
5. Side effects happen or intentionally do not happen
6. Data can be fetched back
7. Updated state is visible in the expected UI surfaces
8. Tenant boundaries remain intact throughout
9. Mobile-specific offline or reconnect behavior does not break truth or isolation
10. Table, chart, widget, and export surfaces reflect the same truth
11. No blind surfaces exist in either direction:
    - UI surface with no durable data counterpart
    - data surface with no intended product counterpart

## Phase 3 — Dependency Resolution

If an agent finds a gap that belongs to another specialist, dispatch that
agent with the exact path and failing roundtrip.

Examples:

- write path exists but list never refreshes → `list-visibility-auditor`
- UI field exists but DTO drops it → `contract-parity-enforcer`
- UI field exists but no entity/table/column ever stores it → `schema-surface-parity-auditor`
- DB table/column exists but no product surface can read, edit, or display it → `schema-surface-parity-auditor`
- edit works but cross-tenant visibility leaks → `tenant-isolation-auditor`
- button is shown in an invalid lifecycle state → `workflow-state-auditor`
- mobile reconnect or offline cache replays stale tenant data → `mobile-app-auditor`
- table filter/export/row action diverges from backend truth → `table-grid-auditor`
- chart or KPI differs from aggregate/query truth → `chart-widget-auditor`
- attachment or export flow breaks boundary or read-back → `file-transfer-auditor`
- live status or notification surface drifts from real backend state → `realtime-sync-auditor`
- control is visible to the wrong role, guard, or impersonation state → `access-boundary-auditor`

## Phase 3.5 — Context Compaction

Dispatch `product-audit-context-manager` whenever one or more of these are true:

- 4 or more specialist agents ran in the same cycle
- any agent produced a `CRITICAL` or 3+ `HIGH` findings
- multiple agents reported the same surface from different angles
- the audit spans both web and mobile or both UI and schema parity
- estimated raw report corpus is 30K tokens or higher

`product-audit-context-manager` is responsible for:

- preserving all `CRITICAL` and `HIGH` findings verbatim with IDs
- deduplicating repeated root causes across agents
- building the dependency graph between write-gap, read-gap, visibility-gap, schema-gap, access-gap, sync-gap, and tenant-gap
- identifying whether any recommendation conflict requires arbitration
- emitting a compact budget status the orchestrator can use for Phase 5 input selection

## Phase 4 — Conflict Resolution

If two or more agents disagree about the right root-cause fix or one
recommendation would break another agent's invariant, dispatch
`product-audit-arbiter` before final reporting.

Typical triggers:

- `schema-surface-parity-auditor` says a field must surface, while another agent establishes it is internal-only by design
- `access-boundary-auditor` and `workflow-state-auditor` disagree on whether a role should reach a transition
- `chart-widget-auditor` and `data-readback-auditor` disagree on the source of truth for a metric
- `table-grid-auditor` and `list-visibility-auditor` disagree on whether the defect is stale cache or wrong backend list semantics

## Phase 5 — Unified Report

Produce a single report that answers:

- Which product surfaces were checked
- Which flows are complete end to end
- Which flows break on write, read-back, visibility, or isolation
- Which tables, charts, widgets, exports, and live surfaces are trustworthy
- Which schema/data surfaces are orphaned from product flows
- Which issues block production confidence

Phase 5 input order is mandatory:

1. Read the current-cycle `product-audit-context-manager` report first when it exists.
2. Read the current-cycle `product-audit-arbiter` report only if the context-manager or specialists flagged a conflict.
3. Re-open only the minimum specialist reports needed to quote exact file references for preserved `CRITICAL` and `HIGH` findings.
4. Do not reopen the full specialist corpus merely to restate counts already compacted by `product-audit-context-manager`.

## Decision Rules (severity taxonomy)

- `CRITICAL`: tenant leak, cross-tenant write/read, destructive action without proper boundary, write acknowledged but not persisted, or persisted sensitive data visible to the wrong tenant/user
- `HIGH`: broken create/edit/delete/approve/retry/save path, lifecycle-gating failure, read-back inconsistency, or UI/backend contract mismatch that corrupts business behavior
- `MEDIUM`: stale list/detail sync, table/chart drift, missing invalidation, offline/reconnect inconsistency, weak empty/error state, or incomplete verification evidence
- `LOW`: labeling, affordance, or non-blocking operator UX issue

Every finding in the unified report must preserve the source agent and
original `{severity}-{NNN}` ID.
