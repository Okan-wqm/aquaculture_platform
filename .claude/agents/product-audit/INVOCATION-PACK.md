# Lane-B Product-Audit Invocation Pack

This file defines how to run the Lane-B product-audit set in a repeatable, enterprise-style way.

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
- Research: `docs/research/agents/product-audit/{YYYY-MM-DD}-{topic}.md` or agent-specific research paths when created

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

- `contract-parity-enforcer`
- `schema-surface-parity-auditor`
- `access-boundary-auditor`
- `tenant-isolation-auditor`

### Phase 5: Meta Review

When 4 or more specialists ran, or any `CRITICAL` finding exists:

- run `product-audit-context-manager`

When two specialists disagree on the root cause or the right direction:

- run `product-audit-arbiter`

### Phase 6: Unified Report

Always end with:

- `product-audit-orchestrator`

The orchestrator report is the decision artifact.

Budget-aware handoff rules:

- If 4 or more specialists ran, invoke `product-audit-context-manager` before `product-audit-orchestrator`.
- When a current-cycle `product-audit-context-manager` report exists, pass that report as the orchestrator's primary synthesis input.
- Do not make the orchestrator reload every specialist report after compaction. Reopen only the reports needed for exact `CRITICAL` and `HIGH` evidence or unresolved dependency edges.
- If the raw specialist corpus is too large for a clean final synthesis, split the audit into smaller surface-specific cycles instead of forcing one oversized final pass.

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
- `contract-parity-enforcer`
- `schema-surface-parity-auditor`
- `access-boundary-auditor`
- `table-grid-auditor`
- `chart-widget-auditor`
- `file-transfer-auditor`
- `realtime-sync-auditor`
- `tenant-isolation-auditor`
- `mobile-app-auditor`
- `product-audit-context-manager`
- `product-audit-orchestrator`

Use `product-audit-arbiter` only if conflicts appear.

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
- `contract-parity-enforcer`
- `schema-surface-parity-auditor`
- `tenant-isolation-auditor`
- `product-audit-context-manager`
- `product-audit-orchestrator`

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
- `product-audit-context-manager`
- `product-audit-orchestrator`

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
- `product-audit-context-manager`
- `product-audit-orchestrator`

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
- `product-audit-context-manager`
- `product-audit-orchestrator`

### 6. Schema-to-Surface Parity Sweep

Use when:

- you suspect hidden DB-only fields, dead entities, or fake UI fields
- the question is "what exists in product with no durable counterpart, and what exists in data with no product counterpart"

Run:

- `ui-action-mapper`
- `contract-parity-enforcer`
- `schema-surface-parity-auditor`
- `form-write-auditor`
- `data-readback-auditor`
- `table-grid-auditor`
- `chart-widget-auditor` when dashboards matter
- `product-audit-context-manager`
- `product-audit-orchestrator`

## Invocation Templates

### Template A: Full Platform Confidence Sweep

Use this as the orchestrator brief:

```text
Run a strict review-only Lane-B product-audit for topic `{YYYY-MM-DD}-full-platform-e2e`.
Goal: verify end-to-end product truth across web, mobile, API, persistence, read-back, visibility, tenant isolation, access boundaries, tables, charts, exports, files, and live/sync surfaces.
Primary outputs:
- docs/test-audits/orchestrator/{YYYY-MM-DD}-full-platform-e2e.md
- docs/test-audits/context-manager/{YYYY-MM-DD}-full-platform-e2e.md
Classify findings as write-gap, read-gap, visibility-gap, schema-gap, access-gap, sync-gap, or tenant-gap.
Preserve all CRITICAL/HIGH finding IDs verbatim.
Use the current-cycle context-manager report as the primary input to final synthesis.
Reopen specialist reports only when exact evidence is needed for preserved CRITICAL/HIGH findings or unresolved dependency edges.
```

### Template B: CRUD Roundtrip Sweep

```text
Run a strict review-only Lane-B product-audit for topic `{YYYY-MM-DD}-{surface}-crud-roundtrip`.
Goal: verify create/edit/delete/archive/restore flows from UI action to persistence to read-back to visible product state.
Prioritize form-write, data-readback, list-visibility, workflow-state, contract parity, schema parity, and tenant isolation.
```

### Template C: Dashboard Truth Sweep

```text
Run a strict review-only Lane-B product-audit for topic `{YYYY-MM-DD}-{surface}-truth`.
Goal: verify that tables, charts, KPI cards, widgets, exports, and drill-down surfaces reflect real backend or calculated truth.
Prioritize table-grid, chart-widget, file-transfer, data-readback, list-visibility, schema-surface parity, and tenant isolation.
```

### Template D: Mobile Offline Sweep

```text
Run a strict review-only Lane-B product-audit for topic `{YYYY-MM-DD}-aquamobil-offline-sync`.
Goal: verify mobile create/edit/read flows across offline drafts, queued writes, reconnect, sync status, notifications, cached views, access boundaries, and tenant isolation.
Prioritize mobile-app, realtime-sync, form-write, data-readback, list-visibility, tenant-isolation, and access-boundary.
```

## Two-Lane Orchestration (Phase 13)

This pack is the **Lane-B (product quality)** half of the enterprise-v2 two-lane review pipeline. The orchestrator at `.claude/agents/orchestrator.md` dispatches both lanes in parallel:

- Lane-A (code quality): `.claude/agents/` roster — domain experts + cross-cutting reviewers.
- Lane-B (product quality): THIS roster — UI / E2E / tenant-surface product auditors.

When invoking this pack standalone (no Lane-A dispatch), use the templates above and write reports under `docs/test-audits/{agent}/`. When invoked as part of a full two-lane cycle, the enterprise-v2 orchestrator handles dispatch + Phase 3.5 cross-lane compaction + Phase 5 unified-report assembly — you do not need to re-invoke the orchestrator here; just declare the topic and let the enterprise-v2 side route.

Finding prefix under Lane-B dispatch is `PRODUCT-{SEVERITY}-{NNN}` so Phase 3.5 context-manager can merge root-cause duplicates across lanes (e.g., a Lane-B form-write `PRODUCT-HIGH-002` + Lane-A data-expert `DATA-HIGH-007` about the same missing column collapse into one `MERGED-HIGH-NNN` entry whose closing commit clears both origin IDs).

Four agent files in this directory were promoted to Lane-A during Phase 9/10 consolidation:

- `gdpr-compliance-auditor.md` + `soc2-readiness-auditor.md` → superseded by `compliance-expert` (Lane-A).
- `ai-tool-execution-auditor.md` → superseded by `ai-safety-auditor` (Lane-A).
- `contract-parity-auditor.md` → superseded by `contract-parity-enforcer` (Lane-A).

The files remain for reference; dispatch calls from the enterprise-v2 orchestrator route to the Lane-A promotion targets, not these.

## Enterprise Rules For Running The Pack

- Do not run every specialist blindly on every tiny scope. Start with the smallest complete profile that answers the question.
- Do not stop at the first visible bug. Follow it to the true gap class.
- Do not treat UI success as proof of persistence.
- Do not treat DB rows as proof of product visibility.
- Do not treat one fresh screen as proof of live correctness across tables, charts, exports, and mobile cache.
- Do not treat hidden controls as safe if backend boundaries remain open.
- Do not treat tenant safety as proven until cache, export, live, and mobile storage paths are traced.
- Do not force the final orchestrator to re-read a large specialist corpus after `product-audit-context-manager` already compacted it.

## Exit Criteria

An audit cycle is only complete when:

- the relevant specialist reports exist
- `product-audit-context-manager` ran when the cycle was large or overlapping
- `product-audit-arbiter` ran if conflicts existed
- the orchestrator wrote a unified report
- the final report names the blocking and non-blocking gap classes explicitly
