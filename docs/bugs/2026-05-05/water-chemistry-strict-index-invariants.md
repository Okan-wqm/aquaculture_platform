# 2026-05-05 - Water Chemistry Strict Index Invariants

## Affected Area
- `libs/aquaculture-engines/src/water-chemistry/reagents.ts`

## Observed Issue
GitHub Actions `build` failed under strict TypeScript settings with `Object is possibly 'undefined'` and related `noUncheckedIndexedAccess` errors in dosing recipe and forward dosing calculations.

## Root Cause
The water chemistry engine relies on domain invariants such as non-empty dosing steps and paired selected reagents, but those invariants were represented implicitly through array indexing. With `noUncheckedIndexedAccess`, TypeScript correctly requires those invariants to be explicit.

## Architectural Fix
Model the invariants in the calculation flow:
- return the single-step recipe from the actual first step after an explicit guard
- skip impossible empty reagent pair reads
- guard on-demand input reads before destructuring
- guard final-step relabeling before mutation

This keeps the domain algorithm intact and avoids non-null assertions or compiler suppression.

## Verification
- `npx tsc -p apps/ai-service/tsconfig.build.json --noEmit`
- `npx nx run ai-service:build:production`

## Status
Fixed on 2026-05-05.
