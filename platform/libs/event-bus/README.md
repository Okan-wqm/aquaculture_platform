# Event Bus

## Lint debt boundary

`event-bus:lint` checks every TypeScript file under `src/`. The ESLint v9 bulk-suppression
file records the exact existing violations by file, rule, and count; those entries are legacy
debt and do not mean this library is lint-clean. A new violation or a higher count fails lint.
A lower count also fails as an unused suppression, so corrected entries must be removed with:

```bash
node --max-old-space-size=4096 ./node_modules/eslint/bin/eslint.js \
  --rule "@typescript-eslint/explicit-function-return-type:error" \
  --prune-suppressions \
  --suppressions-location platform/libs/event-bus/eslint-suppressions.json \
  "platform/libs/event-bus/src/**/*.ts"
```

Do not regenerate the baseline to admit new violations. Owner: Platform. Removal deadline:
before Phase 1 activates any Marine responder. `ORPHAN-MEDIUM-093` tracks the type-resolution
subset of this debt.
