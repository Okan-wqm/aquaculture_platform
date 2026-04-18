# Package 08: web-shell-access-type-enforcement

## Metadata
Status: PENDING
Estimated Tokens: ~11K
Priority: HIGH
Security-Sensitive: no
Parallelizable: yes (with 07)
Prerequisites: 04-archive-channel-membership-fix, 05-edge-device-maintenance-terminal-guard, 06-task-event-integrity

## Source Reviews
- docs/test-audits/access-boundary-auditor/2026-04-11-full-platform-e2e.md
- docs/test-audits/context-manager/2026-04-11-full-platform-e2e.md

## Closing Findings
Closing-Findings: [access-boundary-auditor/HIGH-003]

## Context
The web shell's ProtectedRoute component checks authentication, roles, and module access, but never checks `accessType`. The `accessType` field is fetched in the `Me` query (AuthContext.tsx line 221-233) and stored in the auth context, but the web shell ProtectedRoute (App.tsx lines 72-106) never reads or enforces it. AquaMobil correctly blocks `PANEL_ONLY` users, but the web panel does not block `MOBILE_ONLY` users. This creates an asymmetric access boundary where mobile-only accounts can access the full web panel.

## Findings
access-boundary-auditor HIGH-003: Web shell never applies accessType so MOBILE_ONLY accounts can enter web panel.
- Files: `web/shared-ui/src/contexts/AuthContext.tsx` line 221, `web/shell/src/App.tsx` lines 72-100
- `accessType` is fetched and stored in auth context but web shell ProtectedRoute never checks it. AquaMobil correctly blocks `PANEL_ONLY` users but web does not block `MOBILE_ONLY` users.
- Severity: HIGH
- Gap class: access-gap

## Affected Files
- web/shell/src/App.tsx (primary -- modify ProtectedRoute component, lines 72-106)
- web/shared-ui/src/contexts/AuthContext.tsx (read-only reference -- accessType is already available in user object)

## Dependencies
Prerequisites: Tier 2 packages (04, 05, 06) must be committed first (tier ordering).
This package touches only the web shell. No backend changes needed -- the accessType field is already fetched and available.

## Atomic Commit Plan
```
fix(web-shell): enforce accessType in ProtectedRoute to block MOBILE_ONLY users

ProtectedRoute checks auth, roles, and modules but never checks
accessType. The field is already fetched and available in the auth
context (user.accessType). Add an accessType guard: if user.accessType
is MOBILE_ONLY, redirect to an "access restricted" page explaining that
this account is configured for mobile access only. This mirrors the
existing AquaMobil enforcement that blocks PANEL_ONLY users.

Addresses: access-boundary-auditor/HIGH-003

Plan: docs/plans/2026-04-13-e2e-audit-fixes/packages/08-web-shell-access-type-enforcement.md
Closes: docs/test-audits/access-boundary-auditor/2026-04-11-full-platform-e2e.md#HIGH-003
```

## Test Plan
- Unit test: render ProtectedRoute with a user whose accessType is MOBILE_ONLY. Assert redirect to /unauthorized or a restricted-access page.
- Unit test: render ProtectedRoute with a user whose accessType is BOTH (or undefined/null). Assert children are rendered.
- Unit test: render ProtectedRoute with a user whose accessType is PANEL_ONLY. Assert children are rendered (web panel access is correct).
- Existing auth/role/module checks must continue to work unchanged.

## Verification Command
`npx tsc --noEmit -p web/shell/tsconfig.json && npx vitest run web/shell/src`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
