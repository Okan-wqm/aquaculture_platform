# Package 02: frontend-a11y-contrast

## Metadata
Status: PENDING
Estimated Tokens: 6K
Priority: MEDIUM
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none

## Closing-Findings
Closing-Findings: [FE-MEDIUM-024]

## Source-Reviews
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md

## Context
A single accessibility finding: gray-400 text on white background fails WCAG 2.1 AA contrast ratio (4.5:1 minimum for normal text). Isolated because it touches shared-ui design tokens, not application logic.

## Findings

**FE-MEDIUM-024 — gray-400 (#9ca3af) contrast ratio below WCAG AA**
The design system uses `gray-400` for secondary/helper text. On a white (#ffffff) background, the contrast ratio is approximately 2.9:1 — below the 4.5:1 AA requirement. Must bump to `gray-500` (#6b7280, ratio ~4.6:1) or `gray-600` (#4b5563, ratio ~7.0:1).

## Affected Files
- web/shared-ui/src/theme/colors.ts (or Tailwind config)
- web/shared-ui/src/components/ (any component using gray-400 for text)

## Dependencies
None.

## Atomic Commit Plan
```
fix(shared-ui): bump secondary text color from gray-400 to gray-500 for WCAG AA compliance

gray-400 (#9ca3af) on white has 2.9:1 contrast ratio, below WCAG 2.1 AA minimum of 4.5:1.
gray-500 (#6b7280) achieves 4.6:1.

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#FE-MEDIUM-024
Plan: docs/plans/2026-04-09-medium-fixes/packages/02-frontend-a11y-contrast.md
```

## Test Plan
- Visual regression test: snapshot diff on components using secondary text color
- Verify contrast ratio with axe-core or manual calculation

## Verification Command
`npx tsc --noEmit -p web/shared-ui/tsconfig.json && npx vitest run web/shared-ui`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
