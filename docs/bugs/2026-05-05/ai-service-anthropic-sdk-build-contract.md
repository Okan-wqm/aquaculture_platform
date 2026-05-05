# 2026-05-05 - AI Service Anthropic SDK Build Contract

## Affected Area
- `apps/ai-service/src/agent/agent-runner.service.ts`
- Root `package.json` / `package-lock.json`

## Observed Issue
GitHub Actions `build` failed for `ai-service:build:production` with:

```text
Cannot find module '@anthropic-ai/sdk' or its corresponding type declarations.
```

## Root Cause
`AgentRunnerService` directly imports and uses the Anthropic Messages API from `@anthropic-ai/sdk`, but the workspace dependency graph only declared `@anthropic-ai/claude-agent-sdk`. The missing direct dependency made production compilation depend on an undeclared package.

## Architectural Fix
Add `@anthropic-ai/sdk` as an explicit root workspace dependency and keep the lockfile as the single install source. This preserves deterministic CI installs and avoids type shims, transitive import reliance, or package alias workarounds.

## Verification
- `npx tsc -p apps/ai-service/tsconfig.build.json --noEmit`
- `npx nx run ai-service:build:production`

## Status
Fixed on 2026-05-05.
