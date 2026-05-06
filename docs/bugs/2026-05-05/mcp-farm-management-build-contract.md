# 2026-05-05 - MCP Farm Management Build Contract

## Affected Area
- `mcp/farm-management/tsconfig.json`
- `mcp/farm-management/src/graphql/client.ts`
- `mcp/farm-management/src/tools/math/plan-water-treatment.ts`

## Observed Issue
GitHub Actions `build` failed for `@platform/mcp-farm-management:build` with missing Node type definitions. After removing that blocker locally, production compilation also exposed source-level type drift and test fixture files being compiled as production output.

## Root Cause
The package `tsconfig.json` pinned `typeRoots` to local `./node_modules/@types`, but the npm workspace install hoists `@types/node` to the root. The same production build config also included `src/__tests__` files, mixing test harness drift with production artifact validation. Production source had two strict type problems: partial GraphQL failure was thrown with a payload shape not accepted by the local `GraphQLError` class, and Deffeyes dosing recipes used a conditional type that collapsed to `never[]`.

## Architectural Fix
- Let TypeScript resolve hoisted workspace types by removing the local-only `typeRoots`.
- Exclude test files from the production `tsc` build; Vitest remains the test owner.
- Align partial GraphQL failures with the MCP `GraphQLError` constructor by passing a GraphQL error array.
- Promote the Deffeyes output shape to explicit domain interfaces instead of deriving it from a nullable runtime variable.

## Verification
- `npx nx run @platform/mcp-farm-management:build`

## Status
Fixed on 2026-05-05.
