# ESLint rules dist dependency graph drift

Date: 2026-05-02

## Problem

PR #228 failed the `banned-phrase-gate` job during the
`ESLint-rules dist drift check`. The failure was not a banned phrase; CI rebuilt
`tools/eslint-rules/dist/` and found committed declaration files out of sync
with the source.

Local reproduction initially produced no diff because `node_modules` contained
`@typescript-eslint/utils@6.21.0`, while the package contract requires
`@typescript-eslint/utils@^8.59.1`. The stale local dependency graph masked the
generated-artifact drift that CI correctly detected.

## Impact

The repository commits `tools/eslint-rules/dist/` so CI and deploy jobs can load
the custom ESLint plugin without a runtime build step. If source and dist drift,
quality gates may execute stale rule contracts even when TypeScript source has
changed.

## Root Cause

The generated declaration output was produced with an older
`@typescript-eslint/utils` type surface. The current dependency graph emits
`RuleModule<..., unknown, RuleListener> & { name: string }` declarations.

## Fix

Rebuilt `tools/eslint-rules/dist/` after aligning `node_modules` from
`package-lock.json` with strict peer checks. No runtime JavaScript rule behavior
changed; this closes generated declaration drift.

## Verification

- `npm ci --ignore-scripts --no-audit --no-fund`
- `(cd tools/eslint-rules && npm run build)`
- `git diff -- tools/eslint-rules/dist/` shows declaration/map updates only.

