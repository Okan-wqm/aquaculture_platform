# Package 34: platform-services-audit-security

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 18K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Sprint: 2

## Closing-Findings
Closing-Findings: [platform-services/HIGH-003, platform-services/HIGH-004, platform-services/HIGH-005]

## Source-Reviews
- /var/aqua-saas/docs/reviews/platform-services/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
Three platform service defects sharing a common theme of missing security controls in production-critical paths: (1) billing mutations lack the required billing-specific audit trail; (2) event-store projection registration is keyed only by name, allowing tenant collision; (3) notification webhook encryption falls back to a deterministic dev key when the production key is missing.

## Findings
`HIGH-003` (platform-services): Billing plan mutations do not have the required billing-specific audit trail. Files: `apps/billing-service/src/billing/handlers/update-plan.handler.ts:13-100`, `apps/billing-service/src/billing/handlers/create-subscription.handler.ts:10`, `apps/billing-service/src/billing/handlers/record-payment.handler.ts:10`, `apps/billing-service/src/app.module.ts:141`.

`HIGH-004` (platform-services): Event-store projection registration is not tenant-safe. File: `apps/event-store-service/src/projections/projections.service.ts:22-107,272-329,515-575`. `registeredProjections` is keyed only by `name`, so the last tenant to register overwrites prior registrations.

`HIGH-005` (platform-services): Notification webhook URL encryption still has an insecure fallback path. File: `apps/notification-service/src/notification/services/notification-dispatcher.service.ts:40-49,167-199`.

## Affected Files
- /var/aqua-saas/apps/billing-service/src/billing/handlers/update-plan.handler.ts
- /var/aqua-saas/apps/billing-service/src/billing/handlers/create-subscription.handler.ts
- /var/aqua-saas/apps/billing-service/src/billing/handlers/record-payment.handler.ts
- /var/aqua-saas/apps/billing-service/src/app.module.ts
- /var/aqua-saas/apps/event-store-service/src/projections/projections.service.ts
- /var/aqua-saas/apps/notification-service/src/notification/services/notification-dispatcher.service.ts

## Dependencies
None.

## Atomic Commit Plan
```
security(platform): add billing audit trail, fix projection tenant key, remove encryption fallback

Three platform service security gaps: billing mutations had no
billing-specific audit trail, event-store projections were keyed by
name only allowing tenant collision, and webhook encryption fell back
to a deterministic dev key. This adds transaction-scoped billing audit
entries, keys projections by (tenantId, projectionName), and makes the
webhook encryption key mandatory in production with no fallback.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/34-platform-services-audit-security.md
Closes: docs/reviews/platform-services/2026-04-10-full-repo-audit.md#HIGH-003
Closes: docs/reviews/platform-services/2026-04-10-full-repo-audit.md#HIGH-004
Closes: docs/reviews/platform-services/2026-04-10-full-repo-audit.md#HIGH-005
```

## Test Plan
- Unit test: update-plan produces a billing audit entry in the same transaction.
- Unit test: projections are keyed by (tenantId, name) -- two tenants with same projection name coexist.
- Unit test: missing WEBHOOK_ENCRYPTION_KEY in production causes startup failure.
- Negative test: deterministic dev key fallback is removed.
- Integration test: billing audit entries are immutable after creation.

## Verification Command
`npx tsc --noEmit -p apps/billing-service/tsconfig.json && npx tsc --noEmit -p apps/event-store-service/tsconfig.json && npx tsc --noEmit -p apps/notification-service/tsconfig.json`

Dispatch: security-reviewer

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

