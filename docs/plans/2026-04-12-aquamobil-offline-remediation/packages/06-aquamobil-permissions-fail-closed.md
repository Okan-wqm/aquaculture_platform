# Package 06: aquamobil-permissions-fail-closed

## Metadata
Status: PENDING
Estimated Tokens: 8K
Priority: MEDIUM
Security-Sensitive: yes
Parallelizable: yes (no prerequisites)
Prerequisites: none
Sprint: 0

## Closing-Findings
Closing-Findings: [orchestrator/MEDIUM-004, context-manager/MEDIUM-004]

## Source-Reviews
- /var/aqua-saas/docs/test-audits/orchestrator/2026-04-12-aquamobil-offline-sync.md
- /var/aqua-saas/docs/test-audits/context-manager/2026-04-12-aquamobil-offline-sync.md
- /var/aqua-saas/docs/recommendations/test-audits/orchestrator/2026-04-12-aquamobil-offline-sync.md

## Context
When the mobile permission query fails and no cached settings exist, AquaMobil currently enables every feature through `FALLBACK_SETTINGS`. Backend guards may still stop writes, but page-level and control-level visibility fail open exactly when the system is degraded. Enterprise behavior here must fail closed, or at minimum fall back to last-known-good permissions.

## Findings
- `MEDIUM-004`: degraded mode expands the visible mobile feature set beyond what the live permission source confirmed.
- `MEDIUM-004`: route-level guards and home-page affordances can drift apart during permission service failure.

## Affected Files
- /var/aqua-saas/web/apps/aquamobil/src/hooks/useMobilePermissions.ts
- /var/aqua-saas/web/apps/aquamobil/src/App.tsx
- /var/aqua-saas/web/apps/aquamobil/src/components/MultiFeatureRoute.tsx
- /var/aqua-saas/web/apps/aquamobil/src/pages/HomePage.tsx

## Dependencies
None.

## Atomic Commit Plan
```text
security(aquamobil): fail closed on mobile permission source errors

AquaMobil enables all mobile features when permission fetch fails and no
cache exists, creating an access-boundary drift during degraded mode.
Replace the permissive fallback with fail-closed or last-known-good
behavior so UI visibility never expands beyond confirmed access.

Plan: docs/plans/2026-04-12-aquamobil-offline-remediation/packages/06-aquamobil-permissions-fail-closed.md
Closes: docs/test-audits/orchestrator/2026-04-12-aquamobil-offline-sync.md#MEDIUM-004
```

## Test Plan
- Add hook tests to prove no-cache permission failures do not enable all features.
- Add route-guard tests to prove denied features remain denied during degraded mode.
- Add regression coverage for last-known-good permission cache behavior if that fallback is retained.

## Verification Command
```bash
npx tsc --noEmit -p web/apps/aquamobil/tsconfig.json && \
npx vitest run web/apps/aquamobil/src/hooks/useMobilePermissions.spec.ts web/apps/aquamobil/src/App.tsx
```

Dispatch: security-reviewer

## Rollback Plan
```bash
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes

