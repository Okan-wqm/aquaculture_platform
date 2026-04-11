# Package 37: test-infra-ci-hardening

## Metadata
Status: PENDING
Estimated Tokens: 20K
Priority: MEDIUM
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none
Sprint: 2

## Closing-Findings
Closing-Findings: [test-runner/HIGH-001, test-runner/HIGH-002, test-runner/MEDIUM-003, infra-expert/MEDIUM-001, platform-services/MEDIUM-006, auth-security-expert/MEDIUM-001, multi-tenant-saas-expert/MEDIUM-003, platform-services/HIGH-002, platform-kernel-expert/HIGH-001, platform-kernel-expert/HIGH-002, platform-kernel-expert/HIGH-003, mcp-expert/MEDIUM-004]

## Source-Reviews
- /var/aqua-saas/docs/reviews/test-runner/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/infra-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/platform-services/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/auth-security-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/multi-tenant-saas-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/platform-kernel-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/mcp-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
Remaining MEDIUM and lower-impact HIGH findings across test infrastructure, CI configuration, platform kernel configs, observability, auth boundary, tenant quota enforcement, and MCP discovery. These are grouped because they represent infrastructure and configuration hardening that does not cross service boundaries in a dangerous way and can be addressed as a batch.

NOTE: This package exceeds the 10-finding limit. Per INVEST criteria, it should be split into sub-packages if the executor encounters context overflow. Recommended split points: (a) test-runner findings, (b) CI/infra findings, (c) platform-kernel config/CQRS findings, (d) remaining medium fixes.

## Findings
`HIGH-001` (test-runner): `tenant-admin` React tests run in wrong Vitest environment. Files: `web/modules/tenant-admin/vite.config.ts`, `web/modules/tenant-admin/src/pages/__tests__/TenantUsers.spec.tsx`.

`HIGH-002` (test-runner): Several backend services have empty test suites despite declared test targets. Files: `apps/config-service/project.json`, `apps/notification-service/project.json`, `apps/observability-service/project.json`.

`MEDIUM-003` (test-runner): `hydroponics-module` ships without a test harness. Files: `web/modules/hydroponics-module/package.json`, `web/modules/hydroponics-module/vite.config.ts`.

`MEDIUM-001` (infra-expert): CI and deploy workflows use `npm install` instead of `npm ci`. Files: `.github/workflows/ci-full.yml:60-61,111-112`, `.github/workflows/deploy-digitalocean.yml:288-289,433-434`.

`MEDIUM-006` (platform-services): Tracing is not W3C-compliant -- generates UUID IDs instead of hex. File: `apps/observability-service/src/tracing/tracing.service.ts:31-33,67-121`.

`MEDIUM-001` (auth-security-expert): `validateToken()` is a token oracle bypassing JWT verification contract. Files: `apps/auth-service/src/modules/authentication/services/authentication.service.ts:737`, `apps/auth-service/src/modules/authentication/resolvers/auth.resolver.ts:268`.

`MEDIUM-003` (multi-tenant-saas-expert): Most plan limits are advisory only. Files: `apps/admin-api-service/src/tenant/entities/tenant.entity.ts:149-196`, `apps/auth-service/src/modules/tenant/services/tenant-admin.service.ts:252-260`.

`HIGH-002` (platform-services): Billing notifications are effectively stubbed out. File: `apps/notification-service/src/notification/event-handlers/billing-event.handler.ts:36-117`.

`HIGH-001` (platform-kernel-expert): `platform/configs/*` is an inert shared contract layer. Files: 7 zero-byte config files in `platform/configs/`.

`HIGH-002` (platform-kernel-expert): CQRS dispatch is tied to runtime class names. Files: `platform/libs/cqrs/src/command/command-bus.ts`, `platform/libs/cqrs/src/query/query-bus.ts`.

`HIGH-003` (platform-kernel-expert): CQRS lacks a first-class request envelope. Files: `platform/libs/cqrs/src/command/command-bus.ts`, `platform/libs/cqrs/src/query/query-bus.ts`.

`MEDIUM-004` (mcp-expert): Degraded mode is not reflected in capability discovery. Files: `mcp/farm-management/src/server.ts:111-157`, `mcp/farm-management/src/tools/index.ts:144-187`.

## Affected Files
- /var/aqua-saas/web/modules/tenant-admin/vite.config.ts
- /var/aqua-saas/apps/config-service/project.json
- /var/aqua-saas/apps/notification-service/project.json
- /var/aqua-saas/apps/observability-service/project.json
- /var/aqua-saas/web/modules/hydroponics-module/vite.config.ts
- /var/aqua-saas/.github/workflows/ci-full.yml
- /var/aqua-saas/.github/workflows/deploy-digitalocean.yml
- /var/aqua-saas/apps/observability-service/src/tracing/tracing.service.ts
- /var/aqua-saas/apps/auth-service/src/modules/authentication/services/authentication.service.ts
- /var/aqua-saas/apps/auth-service/src/modules/authentication/resolvers/auth.resolver.ts
- /var/aqua-saas/apps/admin-api-service/src/tenant/entities/tenant.entity.ts
- /var/aqua-saas/apps/auth-service/src/modules/tenant/services/tenant-admin.service.ts
- /var/aqua-saas/apps/notification-service/src/notification/event-handlers/billing-event.handler.ts
- /var/aqua-saas/platform/configs/*.ts (7 files)
- /var/aqua-saas/platform/libs/cqrs/src/command/command-bus.ts
- /var/aqua-saas/platform/libs/cqrs/src/query/query-bus.ts
- /var/aqua-saas/mcp/farm-management/src/server.ts
- /var/aqua-saas/mcp/farm-management/src/tools/index.ts

## Dependencies
None.

## Atomic Commit Plan
```
chore(platform): harden test infrastructure, CI config, CQRS identity, and remaining medium fixes

Batch of infrastructure and configuration hardening: fix tenant-admin
Vitest environment, add skeleton tests for empty backend services, add
hydroponics test harness, switch CI to npm ci, fix W3C trace IDs, move
validateToken to shared JWT contract, implement plan limit enforcement,
wire billing notifications, implement platform config contracts, add
CQRS stable identity and request envelope, and expose reduced MCP
catalog in degraded mode.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/37-test-infra-ci-hardening.md
Closes: docs/reviews/test-runner/2026-04-10-full-repo-audit.md#HIGH-001
Closes: docs/reviews/test-runner/2026-04-10-full-repo-audit.md#HIGH-002
Closes: docs/reviews/test-runner/2026-04-10-full-repo-audit.md#MEDIUM-003
Closes: docs/reviews/infra-expert/2026-04-10-full-repo-audit.md#MEDIUM-001
Closes: docs/reviews/platform-services/2026-04-10-full-repo-audit.md#MEDIUM-006
Closes: docs/reviews/auth-security-expert/2026-04-10-full-repo-audit.md#MEDIUM-001
Closes: docs/reviews/multi-tenant-saas-expert/2026-04-10-full-repo-audit.md#MEDIUM-003
Closes: docs/reviews/platform-services/2026-04-10-full-repo-audit.md#HIGH-002
Closes: docs/reviews/platform-kernel-expert/2026-04-10-full-repo-audit.md#HIGH-001
Closes: docs/reviews/platform-kernel-expert/2026-04-10-full-repo-audit.md#HIGH-002
Closes: docs/reviews/platform-kernel-expert/2026-04-10-full-repo-audit.md#HIGH-003
Closes: docs/reviews/mcp-expert/2026-04-10-full-repo-audit.md#MEDIUM-004
```

## Test Plan
- Verify tenant-admin vitest runs with jsdom environment.
- Verify config-service, notification-service, observability-service have at least one test file.
- Verify hydroponics-module has a Vitest configuration and smoke test.
- Verify CI workflows use `npm ci` not `npm install`.
- Verify trace/span IDs are 32-hex and 16-hex respectively.
- Verify validateToken uses shared JWT verification contract.
- Verify plan limit enforcement is wired for farms, sensors, storage.
- Verify CQRS uses stable identity tokens, not constructor.name.

## Verification Command
`npx tsc --noEmit && npm run lint`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

