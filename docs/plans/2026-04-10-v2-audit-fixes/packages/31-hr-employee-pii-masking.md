# Package 31: hr-employee-pii-masking

## Metadata
Status: PENDING
Estimated Tokens: 14K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Sprint: 2

## Closing-Findings
Closing-Findings: [hr-expert/HIGH-003]

## Source-Reviews
- /var/aqua-saas/docs/reviews/hr-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
The employee detail view renders `employee.email` and `employee.contactInfo.phone` in full, and the GraphQL fragment fetches address and emergency-contact fields unconditionally. The HR module already has `maskEmail()` and `maskPhone()` utilities that are not used. Low-privilege HR users receive more PII than the UI needs.

## Findings
`HIGH-003` (hr-expert): Employee detail view exposes unmasked contact PII. Files: `apps/hr-service/src/hr/hr.resolver.ts:74-83`, `web/modules/hr-module/src/graphql/fragments.ts:52-91`, `web/modules/hr-module/src/pages/EmployeeDetailPage.tsx:111-120`, `web/modules/hr-module/src/utils/pii-mask.ts:20-51`.

## Affected Files
- /var/aqua-saas/apps/hr-service/src/hr/hr.resolver.ts
- /var/aqua-saas/web/modules/hr-module/src/graphql/fragments.ts
- /var/aqua-saas/web/modules/hr-module/src/pages/EmployeeDetailPage.tsx
- /var/aqua-saas/web/modules/hr-module/src/utils/pii-mask.ts

## Dependencies
None.

## Atomic Commit Plan
```
security(hr): mask employee PII in default detail view

The employee detail page rendered full email, phone, address, and
emergency contact for all HR users including MODULE_USER. The existing
maskEmail() and maskPhone() utilities were not applied. This splits the
employee detail fragment into a masked default variant and a privileged
full-PII variant, applies masking in the default view, and gates full
PII behind a stricter role check.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/31-hr-employee-pii-masking.md
Closes: docs/reviews/hr-expert/2026-04-10-full-repo-audit.md#HIGH-003
```

## Test Plan
- Unit test: default detail view shows masked email (a***@example.com).
- Unit test: default detail view shows masked phone (***-1234).
- Unit test: privileged role sees full PII.
- Unit test: GraphQL fragment for MODULE_USER does not include address/emergency fields.
- Negative test: MODULE_USER cannot access full-PII fragment.

## Verification Command
`npx tsc --noEmit -p apps/hr-service/tsconfig.json && npx vitest run web/modules/hr-module`

Dispatch: security-reviewer

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

