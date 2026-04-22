# Package 05: fe-integrity-guard-bypass

## Metadata
Status: PENDING
Estimated Tokens: 10K
Priority: CRITICAL
Security-Sensitive: yes
Parallelizable: yes (Sprint 0, no prerequisites)
Prerequisites: none
Sprint: 0 (hotfix)
Closing-Findings: [FE-CRITICAL-001, FE-CRITICAL-002, FE-CRITICAL-003]
Source-Reviews: [user-provided finding list 2026-04-09]

## Context
The frontend remote module integrity guard has three compounding bypass vectors: (1) it patches `createElement` on the document instance instead of `Document.prototype`, so any code obtaining a fresh document reference bypasses the guard; (2) `setAttribute('src')` calls are not intercepted, allowing script injection via attribute manipulation; (3) the integrity guard file loads AFTER React/ReactDOM imports, meaning those libraries (the largest attack surface) execute without integrity verification. Together these render the SRI guard ineffective.

## Findings
- **FE-CRITICAL-001**: createElement patch on document instance, not Document.prototype -- bypassable
  - File: `web/shell/src/utils/remoteIntegrity.ts` (~8.6K chars)
  - Patch applied to `document.createElement` (instance method) not `Document.prototype.createElement`
  - Any iframe or new document context gets an unpatched createElement

- **FE-CRITICAL-002**: setAttribute('src') not intercepted by integrity guard
  - File: `web/shell/src/utils/remoteIntegrity.ts`
  - Scripts can be loaded by creating a script element then calling `el.setAttribute('src', url)` bypassing the createElement hook entirely

- **FE-CRITICAL-003**: remoteIntegrity.ts loaded AFTER React/ReactDOM imports
  - Files: `web/shell/src/main.tsx` (~290 chars), `web/shell/src/bootstrap.tsx` (~4K chars)
  - Import order: main.tsx imports bootstrap.tsx which imports React before remoteIntegrity.ts executes
  - Root cause: remoteIntegrity.ts is a regular module import, not a preload script

## Affected Files
- `/var/aqua-saas/web/shell/src/utils/remoteIntegrity.ts` (~8.6K chars)
- `/var/aqua-saas/web/shell/src/main.tsx` (~290 chars)
- `/var/aqua-saas/web/shell/src/bootstrap.tsx` (~4.0K chars)

## Dependencies
None.

## Atomic Commit Plan
```
security(frontend): fix integrity guard bypass vectors

1. Patch Document.prototype.createElement instead of document.createElement
   to cover all document contexts (iframes, sandboxed contexts).
2. Add Element.prototype.setAttribute interception for 'src' attribute
   on script/link elements to prevent setAttribute-based bypass.
3. Move remoteIntegrity.ts to be the FIRST import in main.tsx, before
   bootstrap.tsx or any React imports, ensuring the guard is active
   before any library code executes.

Closes: docs/reviews/2026-04-09-critical-fixes#FE-CRITICAL-001
Closes: docs/reviews/2026-04-09-critical-fixes#FE-CRITICAL-002
Closes: docs/reviews/2026-04-09-critical-fixes#FE-CRITICAL-003
Plan: docs/plans/2026-04-09-critical-fixes/packages/05-fe-integrity-guard-bypass.md
```

## Test Plan
- Unit test: createElement via Document.prototype -- intercepted
- Unit test: setAttribute('src', maliciousUrl) on script element -- intercepted
- Unit test: import order verification -- remoteIntegrity.ts initializes before React
- E2E test: attempt to inject unauthorized remote module -- blocked

## Verification Command
```bash
cd /var/aqua-saas && npx tsc --noEmit -p web/shell/tsconfig.json && npx vitest run web/shell/src/utils/remoteIntegrity
```
Dispatch: security-reviewer

## Rollback Plan
```
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes
