# 2026-05-05 - Shared UI Package Module Boundary Warnings

## Affected Area
- `web/shared-ui/package.json`
- `web/shared-ui/postcss.config.mjs`

## Observed Issue
CI `shared-ui:test` emitted package-boundary warnings: the `types` export condition came after `import` and `require`, and Node reparsed `postcss.config.js` as ESM because the file used ESM syntax without an ESM file boundary.

## Root Cause
The package export map mixed TypeScript metadata after runtime conditions, making the `types` condition unreachable for condition-aware resolvers. The PostCSS config used `export default` in a `.js` file inside a package that must not be globally converted to `"type": "module"` because its package contract still exposes a CommonJS `require` entry.

## Architectural Fix
- Move the `types` condition before runtime export conditions.
- Rename the PostCSS config to `.mjs` to give the config its own ESM boundary without changing the package-wide CJS/ESM semantics.

## Verification
- `npm --workspace @aquaculture/shared-ui run test`

## Status
Fixed on 2026-05-05; pending GitHub Actions confirmation.
