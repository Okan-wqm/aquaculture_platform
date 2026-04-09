# Package 02: sensor-edge-code-quality

## Metadata
Status: PENDING
Estimated Tokens: 16K
Priority: LOW
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none

## Context
Four LOW findings across sensor-service (dead code, missing duplicate check, unused parameter) and the Rust edge agent (minor #[cold] optimization on pre-tracing eprintln). All are minor code hygiene items with no behavioral risk. The sensor-service findings touch the ingestion and registration domains; the edge finding is in Rust main.rs.

## Findings

**SENSOR-LOW-001: dead code formatUUID**
- Source agent: sensor-expert
- Severity: LOW
- Files: `apps/sensor-service/src/ingestion/data-ingestion.service.ts` (line 418), `apps/sensor-service/src/ingestion/mqtt-listener.service.ts` (line 1860)
- Description: `formatUUID()` private method is duplicated across two files. Verify whether both are actively called. If dead code, remove. If both are used, extract to a shared utility in sensor-service.

**SENSOR-LOW-002: createChannels no duplicate channelKey check**
- Source agent: sensor-expert
- Severity: LOW
- File: `apps/sensor-service/src/registration/services/channel-management.service.ts` (line 323, `createChannelsForSensor`)
- Description: `createChannelsForSensor()` does not check for duplicate `channelKey` values in the input array before saving. A duplicate channelKey would cause a database unique constraint violation at runtime rather than a clean validation error. Add a pre-save deduplication or validation check.

**SENSOR-LOW-003: discoverChannels _tenantId unused**
- Source agent: sensor-expert
- Severity: LOW
- File: `apps/sensor-service/src/registration/services/channel-discovery.service.ts` (line 134)
- Description: `discoverChannels()` method signature does not include a tenantId parameter, but the finding references `_tenantId` as unused. Verify the actual method signature; if there is an unused prefixed parameter, remove it or use it for scoped logging.

**EDGE-LOW-001: pre-tracing eprintln correct, minor #[cold] optimization**
- Source agent: edge-expert
- Severity: LOW
- File: `sens-api-gateway/src/main.rs` (lines 371, 399-400, 418, 430)
- Description: Five `eprintln!` calls in main.rs are in pre-tracing bootstrap paths (config generation errors, unknown CLI args, runtime build failure, fatal error). These are correct because tracing is not yet initialized at these call sites. Minor optimization: annotate the error branches with `#[cold]` to hint the compiler these are unlikely paths. Add `// WHY: pre-tracing bootstrap, tracing not yet initialized` comments for future reviewers.

Closing-Findings: [SENSOR-LOW-001, SENSOR-LOW-002, SENSOR-LOW-003, EDGE-LOW-001]
Source-Reviews:
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md

## Affected Files
- `/var/aqua-saas/apps/sensor-service/src/ingestion/data-ingestion.service.ts`
- `/var/aqua-saas/apps/sensor-service/src/ingestion/mqtt-listener.service.ts`
- `/var/aqua-saas/apps/sensor-service/src/registration/services/channel-management.service.ts`
- `/var/aqua-saas/apps/sensor-service/src/registration/services/channel-discovery.service.ts`
- `/var/aqua-saas/sens-api-gateway/src/main.rs`

## Dependencies
None. All findings are independent code quality fixes.

## Atomic Commit Plan
```
chore(sensor,edge): clean up 4 LOW code quality findings

Address minor code quality issues in sensor-service and edge agent:
- Remove or deduplicate dead formatUUID() across ingestion files
- Add channelKey duplicate validation in createChannelsForSensor()
- Remove unused _tenantId parameter in discoverChannels() if confirmed
- Add #[cold] annotations and WHY comments to pre-tracing eprintln! in main.rs

Plan: docs/plans/2026-04-09-low-fixes/packages/02-sensor-edge-code-quality.md

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#SENSOR-LOW-001
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#SENSOR-LOW-002
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#SENSOR-LOW-003
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#EDGE-LOW-001
```

## Test Plan
- Verify sensor-service compilation: `npx tsc --noEmit -p apps/sensor-service/tsconfig.json`
- Run sensor registration tests: `npx jest --testPathPattern="apps/sensor-service/src/registration"`
- Run sensor ingestion tests: `npx jest --testPathPattern="apps/sensor-service/src/ingestion"`
- Verify Rust edge compilation: `cd sens-api-gateway && cargo check`

## Verification Command
`npx tsc --noEmit -p apps/sensor-service/tsconfig.json && cd sens-api-gateway && cargo check`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
