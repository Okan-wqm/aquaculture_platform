# Test Agents Invocation Pack

This file defines how to run the `test-agents` set in a repeatable, enterprise-style way.

The goal is not "run random reviewers until we have a lot of notes."
The goal is to produce bounded, high-signal audit cycles that answer:

- does the user-facing surface actually work
- does it persist correctly
- does it read back correctly
- does it remain visible in the right product surfaces
- is it tenant-safe and access-safe
- does it remain truthful in tables, charts, exports, and live views
- are there blind spots where UI has no real data counterpart or data has no product counterpart

## Default Output Tree

Use these locations consistently:

- Unified reports: `docs/test-audits/orchestrator/{YYYY-MM-DD}-{topic}.md`
- Specialist reports: `docs/test-audits/{agent}/{YYYY-MM-DD}-{topic}.md`
- Meta-review compaction: `docs/test-audits/context-manager/{YYYY-MM-DD}-{topic}.md`
- Arbitration reports: `docs/test-audits/architectural-arbiter/{YYYY-MM-DD}-{topic}.md`
- Recommendations: `docs/recommendations/test-audits/{agent}/{YYYY-MM-DD}-{topic}.md`
- Research: `docs/research/test-agents/{YYYY-MM-DD}-{topic}.md` or agent-specific research paths when created

## Topic Naming

Use stable topic names so repeated audits can be compared:

- `full-platform-e2e`
- `farm-crud-roundtrip`
- `sensor-dashboard-truth`
- `tenant-admin-access-boundaries`
- `aquamobil-offline-sync`
- `schema-surface-parity`
- `tables-charts-exports`

Prefer product-surface names over technical task names.

Good:

- `2026-04-11-farm-crud-roundtrip`
- `2026-04-11-aquamobil-offline-sync`

Bad:

- `2026-04-11-fix-things`
- `2026-04-11-random-review`

## Gap Taxonomy

Every consolidated cycle should classify issues using one or more of:

- `write-gap`
- `read-gap`
- `visibility-gap`
- `schema-gap`
- `access-gap`
- `sync-gap`
- `tenant-gap`

This keeps the cycle focused on root-cause classes instead of one-off symptoms.

## Default Review Flow

### Phase 1: Surface Discovery

Always start with:

- `ui-action-mapper`

Add these immediately when relevant:

- `mobile-app-auditor` for AquaMobil scope
- `access-boundary-auditor` when roles, guards, impersonation, or feature flags matter
- `tenant-isolation-auditor` when the surface is tenant-scoped

### Phase 2: Roundtrip Tracing

For create/edit/delete/approve/retry/save flows, add:

- `button-action-auditor`
- `form-write-auditor`
- `data-readback-auditor`
- `list-visibility-auditor`
- `workflow-state-auditor`

### Phase 3: Surface-Specific Truth Review

Add the specialist reviewers that match the rendered surface:

- `table-grid-auditor` for list pages, tables, grids, row actions, filters, pagination, exports
- `chart-widget-auditor` for KPI cards, charts, dashboards, widgets, drill-downs
- `file-transfer-auditor` for upload/import/export/download/preview/attachment flows
- `realtime-sync-auditor` for polling, SSE, notifications, live status, sync pages, progress views

### Phase 4: Parity and Boundary Review

Use these whenever you need root-cause coverage beyond the visible happy path:

- `contract-parity-auditor`
- `schema-surface-parity-auditor`
- `access-boundary-auditor`
- `tenant-isolation-auditor`

### Phase 5: Meta Review

When 4 or more specialists ran, or any `CRITICAL` finding exists:

- run `context-manager`

When two specialists disagree on the root cause or the right direction:

- run `architectural-arbiter`

### Phase 6: Unified Report

Always end with:

- `orchestrator`

The orchestrator report is the decision artifact.

## Audit Profiles

### 1. Full Platform Confidence Sweep

Use when:

- release confidence is low
- many modules changed
- the ask is "at the end of the day every important button and surface should work"

Run:

- `ui-action-mapper`
- `button-action-auditor`
- `form-write-auditor`
- `data-readback-auditor`
- `list-visibility-auditor`
- `workflow-state-auditor`
- `contract-parity-auditor`
- `schema-surface-parity-auditor`
- `access-boundary-auditor`
- `table-grid-auditor`
- `chart-widget-auditor`
- `file-transfer-auditor`
- `realtime-sync-auditor`
- `tenant-isolation-auditor`
- `mobile-app-auditor`
- `context-manager`
- `orchestrator`

Use `architectural-arbiter` only if conflicts appear.

### 2. CRUD Roundtrip Sweep

Use when:

- the goal is create/edit/delete/archive/restore correctness
- forms, modals, save buttons, inline edits, and detail pages are the focus

Run:

- `ui-action-mapper`
- `button-action-auditor`
- `form-write-auditor`
- `data-readback-auditor`
- `list-visibility-auditor`
- `workflow-state-auditor`
- `contract-parity-auditor`
- `schema-surface-parity-auditor`
- `tenant-isolation-auditor`
- `context-manager`
- `orchestrator`

### 3. Tables, Charts, Exports Truth Sweep

Use when:

- operators rely on dashboards, tables, and exports
- the question is "does the screen tell the truth"

Run:

- `ui-action-mapper`
- `table-grid-auditor`
- `chart-widget-auditor`
- `file-transfer-auditor`
- `data-readback-auditor`
- `list-visibility-auditor`
- `schema-surface-parity-auditor`
- `tenant-isolation-auditor`
- `context-manager`
- `orchestrator`

### 4. Access and Tenant Boundary Sweep

Use when:

- the product has role-gated actions
- admin or impersonation flows are in scope
- tenant bleed-through risk is high

Run:

- `ui-action-mapper`
- `access-boundary-auditor`
- `tenant-isolation-auditor`
- `button-action-auditor`
- `workflow-state-auditor`
- `file-transfer-auditor`
- `mobile-app-auditor` when AquaMobil is in scope
- `context-manager`
- `orchestrator`

### 5. Mobile Offline and Reconnect Sweep

Use when:

- AquaMobil is involved
- offline queue, drafts, reconnect, sync status, notifications, or cached views matter

Run:

- `ui-action-mapper`
- `mobile-app-auditor`
- `form-write-auditor`
- `data-readback-auditor`
- `realtime-sync-auditor`
- `list-visibility-auditor`
- `tenant-isolation-auditor`
- `access-boundary-auditor`
- `file-transfer-auditor` when attachments/media exist
- `context-manager`
- `orchestrator`

### 6. Schema-to-Surface Parity Sweep

Use when:

- you suspect hidden DB-only fields, dead entities, or fake UI fields
- the question is "what exists in product with no durable counterpart, and what exists in data with no product counterpart"

Run:

- `ui-action-mapper`
- `contract-parity-auditor`
- `schema-surface-parity-auditor`
- `form-write-auditor`
- `data-readback-auditor`
- `table-grid-auditor`
- `chart-widget-auditor` when dashboards matter
- `context-manager`
- `orchestrator`

## Invocation Templates

### Template A: Full Platform Confidence Sweep

Use this as the orchestrator brief:

```text
Run a strict review-only test-agents audit for topic `{YYYY-MM-DD}-full-platform-e2e`.
Goal: verify end-to-end product truth across web, mobile, API, persistence, read-back, visibility, tenant isolation, access boundaries, tables, charts, exports, files, and live/sync surfaces.
Primary outputs:
- docs/test-audits/orchestrator/{YYYY-MM-DD}-full-platform-e2e.md
- docs/test-audits/context-manager/{YYYY-MM-DD}-full-platform-e2e.md
Classify findings as write-gap, read-gap, visibility-gap, schema-gap, access-gap, sync-gap, or tenant-gap.
Preserve all CRITICAL/HIGH finding IDs verbatim.
```

### Template B: CRUD Roundtrip Sweep

```text
Run a strict review-only test-agents audit for topic `{YYYY-MM-DD}-{surface}-crud-roundtrip`.
Goal: verify create/edit/delete/archive/restore flows from UI action to persistence to read-back to visible product state.
Prioritize form-write, data-readback, list-visibility, workflow-state, contract parity, schema parity, and tenant isolation.
```

### Template C: Dashboard Truth Sweep

```text
Run a strict review-only test-agents audit for topic `{YYYY-MM-DD}-{surface}-truth`.
Goal: verify that tables, charts, KPI cards, widgets, exports, and drill-down surfaces reflect real backend or calculated truth.
Prioritize table-grid, chart-widget, file-transfer, data-readback, list-visibility, schema-surface parity, and tenant isolation.
```

### Template D: Mobile Offline Sweep

```text
Run a strict review-only test-agents audit for topic `{YYYY-MM-DD}-aquamobil-offline-sync`.
Goal: verify mobile create/edit/read flows across offline drafts, queued writes, reconnect, sync status, notifications, cached views, access boundaries, and tenant isolation.
Prioritize mobile-app, realtime-sync, form-write, data-readback, list-visibility, tenant-isolation, and access-boundary.
```

## Enterprise Rules For Running The Pack

- Do not run every specialist blindly on every tiny scope. Start with the smallest complete profile that answers the question.
- Do not stop at the first visible bug. Follow it to the true gap class.
- Do not treat UI success as proof of persistence.
- Do not treat DB rows as proof of product visibility.
- Do not treat one fresh screen as proof of live correctness across tables, charts, exports, and mobile cache.
- Do not treat hidden controls as safe if backend boundaries remain open.
- Do not treat tenant safety as proven until cache, export, live, and mobile storage paths are traced.

## Exit Criteria

An audit cycle is only complete when:

- the relevant specialist reports exist
- `context-manager` ran when the cycle was large or overlapping
- `architectural-arbiter` ran if conflicts existed
- the orchestrator wrote a unified report
- the final report names the blocking and non-blocking gap classes explicitly
