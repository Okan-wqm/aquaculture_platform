# Package 03: aquamobil-messaging-authoritative-offline-queue

## Metadata
Status: PENDING
Estimated Tokens: 22K
Priority: HIGH
Security-Sensitive: no
Parallelizable: yes (no prerequisites)
Prerequisites: none
Sprint: 0

## Closing-Findings
Closing-Findings: [orchestrator/HIGH-002, context-manager/HIGH-002]

## Source-Reviews
- /var/aqua-saas/docs/test-audits/orchestrator/2026-04-12-aquamobil-offline-sync.md
- /var/aqua-saas/docs/test-audits/context-manager/2026-04-12-aquamobil-offline-sync.md
- /var/aqua-saas/docs/recommendations/test-audits/orchestrator/2026-04-12-aquamobil-offline-sync.md

## Context
Offline chat sends currently persist into a separate IndexedDB queue (`messaging_offline_sends`) that no authoritative replay owner consumes. The app's visible sync surfaces only reflect the general offline operation queue, so users can be shown zero pending work while chat messages are stranded locally. Offline messaging needs one authoritative owner.

## Findings
- `HIGH-002`: offline messaging uses a side queue that has no proved replay consumer or reconnect flusher.
- `HIGH-002`: `registerMessagingSync()` exists but has no call site, so background sync registration is also orphaned.
- `HIGH-002`: home, account, and sync-status surfaces do not include pending chat sends because they only read `useOfflineQueue()`.

## Affected Files
- /var/aqua-saas/web/apps/aquamobil/src/hooks/useSendMessage.ts
- /var/aqua-saas/web/apps/aquamobil/src/hooks/useOfflineQueue.tsx
- /var/aqua-saas/web/apps/aquamobil/src/pwa/offline-queue.ts
- /var/aqua-saas/web/apps/aquamobil/src/types/index.ts
- /var/aqua-saas/web/apps/aquamobil/src/pages/sync/SyncStatusPage.tsx
- /var/aqua-saas/web/apps/aquamobil/src/pages/HomePage.tsx
- /var/aqua-saas/web/apps/aquamobil/src/pages/account/AccountPage.tsx

## Dependencies
None.

## Atomic Commit Plan
```text
refactor(aquamobil): make offline messaging use the authoritative queue

Offline chat sends were stored in a separate IndexedDB queue with no
authoritative replay owner and no integration with the sync surfaces
users rely on. Collapse messaging onto the authoritative offline queue
so persistence, retry, replay, and pending counts share one owner.

Plan: docs/plans/2026-04-12-aquamobil-offline-remediation/packages/03-aquamobil-messaging-authoritative-offline-queue.md
Closes: docs/test-audits/orchestrator/2026-04-12-aquamobil-offline-sync.md#HIGH-002
```

## Test Plan
- Add queue tests to prove offline `sendMessage` writes enter the authoritative queue instead of a separate cache key.
- Add replay tests to prove reconnect/manual sync processes queued chat sends through the same sync engine as other operations.
- Add UI tests to prove home, account, and sync-status pending counts include queued chat sends.
- Add failure-path tests to prove failed messaging operations remain inspectable/removable from the canonical sync surface.

## Verification Command
```bash
npx tsc --noEmit -p web/apps/aquamobil/tsconfig.json && \
npx vitest run web/apps/aquamobil/src/pwa web/apps/aquamobil/src/hooks web/apps/aquamobil/src/pages/sync
```

Dispatch: messaging-expert

## Rollback Plan
```bash
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes

