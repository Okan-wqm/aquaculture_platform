# Package 14: hydroponics-decimal-math

## Metadata
Status: PENDING
Estimated Tokens: 16K
Priority: CRITICAL
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none
Sprint: 0

## Closing-Findings
Closing-Findings: [platform-services/CRITICAL-001]

## Source-Reviews
- /var/aqua-saas/docs/reviews/platform-services/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
Hydroponics nutrient math uses native JS `number` arithmetic throughout the calculation layer, causing cumulative rounding drift in recipe/balance outputs. The input layer silently coerces invalid input to `0` instead of producing validation errors, which masks data entry mistakes and corrupts downstream calculations.

## Findings
`CRITICAL-001` (platform-services): Hydroponics nutrient math is still built on native JS `number` arithmetic, and the UI path silently coerces invalid input to `0`. Files: `web/modules/hydroponics-module/src/lib/calculator/balance.ts`, `web/modules/hydroponics-module/src/lib/units.ts`, `web/modules/hydroponics-module/src/components/solution/ParameterRow.tsx`, `web/modules/hydroponics-module/src/components/solution/FertilizerOptionRow.tsx`, `web/modules/hydroponics-module/src/components/solution/DynamicTankTable.tsx`.

## Affected Files
- /var/aqua-saas/web/modules/hydroponics-module/src/lib/calculator/balance.ts
- /var/aqua-saas/web/modules/hydroponics-module/src/lib/units.ts
- /var/aqua-saas/web/modules/hydroponics-module/src/components/solution/ParameterRow.tsx
- /var/aqua-saas/web/modules/hydroponics-module/src/components/solution/FertilizerOptionRow.tsx
- /var/aqua-saas/web/modules/hydroponics-module/src/components/solution/DynamicTankTable.tsx

## Dependencies
None.

## Atomic Commit Plan
```
fix(hydroponics): migrate nutrient math to Decimal and validate inputs

All recipe, balance, and unit conversion math used native JS number
arithmetic, causing cumulative rounding drift in nutrient calculations.
The UI coerced invalid input to 0 instead of surfacing validation
errors. This migrates the calculation layer to Decimal.js for exact
arithmetic and replaces silent zero-coercion with explicit validation
errors that prevent invalid data from entering the calculation pipeline.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/14-hydroponics-decimal-math.md
Closes: docs/reviews/platform-services/2026-04-10-full-repo-audit.md#CRITICAL-001
```

## Test Plan
- Unit test: balance calculations produce exact Decimal results, not floating-point.
- Unit test: known rounding-prone inputs produce deterministic outputs.
- Unit test: invalid input produces validation error, not zero.
- Unit test: ParameterRow and FertilizerOptionRow reject non-numeric input.
- Regression test: existing recipes produce identical outputs after migration.

## Verification Command
`npx tsc --noEmit -p web/modules/hydroponics-module/tsconfig.json`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

