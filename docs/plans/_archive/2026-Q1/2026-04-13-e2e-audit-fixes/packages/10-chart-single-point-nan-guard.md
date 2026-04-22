# Package 10: chart-single-point-nan-guard

## Metadata
Status: PENDING
Estimated Tokens: ~8K
Priority: MEDIUM
Security-Sensitive: no
Parallelizable: yes (with 09)
Prerequisites: 07-tenant-admin-cache-key-scoping, 08-web-shell-access-type-enforcement

## Source Reviews
- docs/test-audits/chart-widget-auditor/2026-04-11-full-platform-e2e.md
- docs/test-audits/context-manager/2026-04-11-full-platform-e2e.md

## Closing Findings
Closing-Findings: [chart-widget-auditor/MEDIUM-004]

## Context
Both LineChart and AreaChart components divide by `(data.length - 1)` (or `(labels.length - 1)`) when computing x-axis positions. When there is only one data point, this produces `0/0 = NaN`, which propagates through SVG path coordinates and renders a broken/invisible chart. The fix is a simple single-point guard: when data.length is 1, place the single point at the chart center rather than dividing by zero.

## Findings
chart-widget-auditor MEDIUM-004: Chart single-point NaN/Infinity.
- Files: `web/shared-ui/src/components/Charts/LineChart.tsx` line 82, `web/shared-ui/src/components/Charts/AreaChart.tsx` line 76
- Divides by `(data.length - 1)` with no single-point guard. When data has exactly 1 point, division produces NaN.
- Severity: MEDIUM
- Gap class: visibility-gap

## Affected Files
- web/shared-ui/src/components/Charts/LineChart.tsx (primary -- line 82, add single-point guard)
- web/shared-ui/src/components/Charts/AreaChart.tsx (primary -- line 76, add single-point guard)

## Dependencies
Prerequisites: Tier 3 packages (07, 08) must be committed first (tier ordering).
This package touches only the shared-ui chart components. No backend changes.

## Atomic Commit Plan
```
fix(charts): guard against NaN when rendering single-point datasets

LineChart and AreaChart divide by (data.length - 1) to compute x-axis
spacing. With exactly one data point this produces 0/0 = NaN, breaking
SVG path rendering. Add a guard: when length is 1, place the single
point at the horizontal center of the chart area. Both components share
the same bug pattern and fix.

Addresses: chart-widget-auditor/MEDIUM-004

Plan: docs/plans/2026-04-13-e2e-audit-fixes/packages/10-chart-single-point-nan-guard.md
Closes: docs/test-audits/chart-widget-auditor/2026-04-11-full-platform-e2e.md#MEDIUM-004
```

## Test Plan
- Unit test: render LineChart with a single data point. Assert no NaN in rendered SVG path attributes.
- Unit test: render AreaChart with a single data point. Assert no NaN in rendered SVG path attributes.
- Unit test: render LineChart with two data points. Assert correct x-axis spacing (regression guard).
- Unit test: render AreaChart with two data points. Assert correct x-axis spacing (regression guard).
- Unit test: render both charts with empty data. Assert graceful empty state (no crash).

## Verification Command
`npx tsc --noEmit -p web/shared-ui/tsconfig.json && npx vitest run web/shared-ui/src/components/Charts`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
