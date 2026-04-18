# Package 10: console-log-to-logger

## Metadata
Status: PENDING
Estimated Tokens: 14K
Priority: MEDIUM
Security-Sensitive: yes (MEDIUM-007 is secret leak vector)
Parallelizable: yes
Prerequisites: none

## Context
6 `console.log/warn/error` usages in production code bypass NestJS structured logging and tenant/request context. One instance in credential.transformer.ts is a secret leak vector (MQTT credential vault error messages may include credential fragments in stdout). CLAUDE.md requires NestJS `Logger` for all logging.

## Findings

**MEDIUM-005 [security-reviewer]: 6 console.log/warn/error usages in production code**
- CLAUDE.md requires NestJS `Logger`. Bypasses structured logging and tenant/request context.
- Files:
  - `apps/sensor-service/src/infrastructure/vault/credential.transformer.ts:15` — `console.error` with vault security message
  - `apps/sensor-service/src/infrastructure/vault/credential.transformer.ts:30` — `console.error` with decryption failure (includes partial credential value)
  - `libs/backend-common/src/bootstrap/safe-error-logger.ts:85` — `console.error` with JSON.stringify (bootstrap context, Logger may not be available)
  - `libs/backend-common/src/bootstrap/create-service-app.ts:755` — documented ARCH-032 violation

**MEDIUM-007 [sensor-expert]: MQTT credential vault uses custom encryption with console.log**
- File: `apps/sensor-service/src/infrastructure/vault/credential.transformer.ts`
- Line 30 logs `value.substring(0, 10)` of encrypted credential on decryption failure. This is a secret/PII leak vector through stdout.

Closing-Findings: [MEDIUM-005, MEDIUM-007]
Source-Reviews:
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md
- docs/reviews/context-manager/2026-04-09-tier1-compaction.md

## Affected Files
- `/var/aqua-saas/apps/sensor-service/src/infrastructure/vault/credential.transformer.ts`
- `/var/aqua-saas/libs/backend-common/src/bootstrap/safe-error-logger.ts`
- `/var/aqua-saas/libs/backend-common/src/bootstrap/create-service-app.ts`

## Dependencies
None.

Note: `safe-error-logger.ts` and `create-service-app.ts` use `console.error` in bootstrap context where NestJS Logger may not yet be initialized. Executor should evaluate whether a pre-Logger fallback is architecturally appropriate here (e.g., a raw `process.stderr.write` with JSON format) or if Logger can be initialized earlier.

## Atomic Commit Plan
```
security(sensor): replace console.log with Logger, mask credential in vault error

credential.transformer.ts: Replace console.error with NestJS Logger.
Remove partial credential value from error message (line 30) — log only
a non-reversible hash prefix or opaque error code. This is a secret
leak vector.

safe-error-logger.ts: Evaluate bootstrap timing — replace console.error
with process.stderr.write of structured JSON if Logger unavailable, or
inject Logger if bootstrap sequence allows.

create-service-app.ts: Replace console.error (ARCH-032) with Logger.

Plan: docs/plans/2026-04-09-full-remediation/packages/10-console-log-to-logger.md

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MEDIUM-005
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MEDIUM-007
```

[Dispatch: security-reviewer] (credential leak vector fix)

## Test Plan
- Verify compilation: `npx tsc --noEmit -p apps/sensor-service/tsconfig.json && npx tsc --noEmit -p libs/backend-common/tsconfig.json`
- Verify no `console.log|warn|error` remains in affected files (grep check)
- Confirm credential.transformer.ts error path no longer includes credential substring

## Verification Command
`npx tsc --noEmit -p apps/sensor-service/tsconfig.json && npx tsc --noEmit -p libs/backend-common/tsconfig.json`
[Dispatch: security-reviewer]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
