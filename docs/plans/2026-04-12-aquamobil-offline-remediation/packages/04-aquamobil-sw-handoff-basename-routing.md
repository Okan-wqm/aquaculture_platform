# Package 04: aquamobil-sw-handoff-basename-routing

## Metadata
Status: PENDING
Estimated Tokens: 14K
Priority: HIGH
Security-Sensitive: no
Parallelizable: no
Prerequisites: 03-aquamobil-messaging-authoritative-offline-queue
Sprint: 1

## Closing-Findings
Closing-Findings: [orchestrator/HIGH-003, context-manager/HIGH-003]

## Source-Reviews
- /var/aqua-saas/docs/test-audits/orchestrator/2026-04-12-aquamobil-offline-sync.md
- /var/aqua-saas/docs/test-audits/context-manager/2026-04-12-aquamobil-offline-sync.md
- /var/aqua-saas/docs/recommendations/test-audits/orchestrator/2026-04-12-aquamobil-offline-sync.md

## Context
The messaging service worker emits `SYNC_MESSAGES` and `NAVIGATE_TO_CHANNEL`, but the app only listens for `SYNC_COMPLETE`. When a new window is opened, the service worker also targets `/messages/...` even though AquaMobil is mounted under `/mobile`. This is a broken cross-process contract and must be fixed with one shared routing/handoff model.

## Findings
- `HIGH-003`: reconnect/background-sync path posts `SYNC_MESSAGES`, but no client handler consumes it.
- `HIGH-003`: notification-click focus path posts `NAVIGATE_TO_CHANNEL`, but no AquaMobil listener routes the user.
- `HIGH-003`: `openWindow('/messages/...')` ignores the router basename and manifest scope `/mobile`.

## Affected Files
- /var/aqua-saas/web/apps/aquamobil/src/pwa/messaging-sw.ts
- /var/aqua-saas/web/apps/aquamobil/src/hooks/useOfflineQueue.tsx
- /var/aqua-saas/web/apps/aquamobil/src/main.tsx
- /var/aqua-saas/web/apps/aquamobil/src/App.tsx
- /var/aqua-saas/web/apps/aquamobil/src

## Dependencies
- 03-aquamobil-messaging-authoritative-offline-queue

## Atomic Commit Plan
```text
fix(aquamobil): complete messaging service-worker handoff and /mobile routing

The messaging service worker emits handoff events that the app does not
consume and opens /messages routes that bypass AquaMobil's /mobile base.
Introduce one basename-aware routing contract and implement the missing
client-side service-worker message handlers.

Plan: docs/plans/2026-04-12-aquamobil-offline-remediation/packages/04-aquamobil-sw-handoff-basename-routing.md
Closes: docs/test-audits/orchestrator/2026-04-12-aquamobil-offline-sync.md#HIGH-003
```

## Test Plan
- Add service-worker tests to prove `SYNC_MESSAGES` and `NAVIGATE_TO_CHANNEL` are handled by the client side.
- Add route-builder tests to prove push-notification navigation produces `/mobile/messages` paths.
- Add notification-click tests for both cases: open messaging window already exists vs. no matching window exists.

## Verification Command
```bash
npx tsc --noEmit -p web/apps/aquamobil/tsconfig.json && \
npx vitest run web/apps/aquamobil/src/pwa web/apps/aquamobil/src/hooks
```

Dispatch: frontend-expert

## Rollback Plan
```bash
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes

