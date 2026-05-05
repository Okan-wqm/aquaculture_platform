# Messaging Tenant Read Path Convergence

- Date: 2026-05-04
- Affected area: messaging-service channel, message, unread, GDPR, and media flows
- Status: fixed in this change set

## Observed issue

Messaging E2E continued to fail after tenant-local writes started succeeding. Channel member counts returned `0`, `removeChannelMember` and notification preference updates could not find tenant-local memberships, offline sync could not see messages after send, and feature paths such as pin/reaction looked up source-schema rows instead of tenant-schema rows.

## Root cause

Several read paths still used injected repositories or plain `DataSource.transaction()` after write paths had moved to `runInTenantTransaction()`. That split meant writes were physically tenant-local, but reads could still resolve through the source schema or an unpinned connection.

## Architectural fix

Channel list/member field resolvers, message pagination/offline sync/search, pin/reaction/delete prechecks, unread DB fallback, GDPR export/anonymization, and media attachment validation now use tenant-pinned transaction boundaries or explicit injectable storage ports. Test doubles were updated to model the same `DataSource`/`QueryRunner` contract instead of preserving old repository-only assumptions.

## Verification

- `npx tsc -p apps/messaging-service/tsconfig.app.json --noEmit`
- `npx tsc -p apps/messaging-service/tsconfig.spec.json --noEmit`
- `npm run gates:messaging-tenant-routing`
- `npx jest --config apps/messaging-service/jest.config.ts apps/messaging-service/src/message/queries/__tests__/get-messages.handler.spec.ts --runInBand`
- `npx jest --config apps/messaging-service/jest.config.ts apps/messaging-service/src/channel/resolvers/__tests__/channel.resolver.spec.ts --runInBand`
- `npx jest --config apps/messaging-service/jest.config.ts apps/messaging-service/src/gdpr/__tests__/gdpr.service.spec.ts --runInBand`

Full Messaging E2E and PR-wide build/lint/test gates remain GitHub Actions responsibilities because this server is not the heavy build machine.
