# Package 05: aquamobil-truthful-queued-state-ui

## Metadata
Status: PENDING
Estimated Tokens: 18K
Priority: HIGH
Security-Sensitive: no
Parallelizable: no
Prerequisites: 02-aquamobil-leave-readback-convergence, 03-aquamobil-messaging-authoritative-offline-queue
Sprint: 2

## Closing-Findings
Closing-Findings: [orchestrator/MEDIUM-005, context-manager/MEDIUM-005]

## Source-Reviews
- /var/aqua-saas/docs/test-audits/orchestrator/2026-04-12-aquamobil-offline-sync.md
- /var/aqua-saas/docs/test-audits/context-manager/2026-04-12-aquamobil-offline-sync.md
- /var/aqua-saas/docs/recommendations/test-audits/orchestrator/2026-04-12-aquamobil-offline-sync.md

## Context
Several AquaMobil screens currently overstate durable completion. Leave can show "Request Submitted" before convergence, task actions show definitive success when only queued, and AI chat starts post-send thinking even though the user message may only be stored locally. Once the underlying queue ownership is fixed, the UI must speak truthfully about `queued`, `syncing`, `confirmed`, and `failed`.

## Findings
- `MEDIUM-005`: task start/complete can queue offline while the UI says "Task started!" or "Task completed!" as if durable.
- `MEDIUM-005`: checklist and note actions have no equivalent degraded-mode semantics.
- `HIGH-001` and `HIGH-002`: leave and messaging success copy currently overstate proof of completion.

## Affected Files
- /var/aqua-saas/web/apps/aquamobil/src/pages/leave/LeaveRequestPage.tsx
- /var/aqua-saas/web/apps/aquamobil/src/hooks/useTaskActions.ts
- /var/aqua-saas/web/apps/aquamobil/src/pages/tasks/TaskDetailPage.tsx
- /var/aqua-saas/web/apps/aquamobil/src/pages/messaging/ChatRoomPage.tsx
- /var/aqua-saas/web/apps/aquamobil/src/pages/messaging/AiChatPage.tsx
- /var/aqua-saas/web/apps/aquamobil/src/components/messaging/MessageInput.tsx

## Dependencies
- 02-aquamobil-leave-readback-convergence
- 03-aquamobil-messaging-authoritative-offline-queue

## Atomic Commit Plan
```text
refactor(aquamobil): distinguish queued work from confirmed completion

AquaMobil currently labels queued or degraded-mode work as if it were
already durable. Replace definitive success copy with truthful queued,
syncing, confirmed, and failed semantics across leave, tasks, and
messaging flows, and stop AI chat from reacting as if a queued send
were already server-accepted.

Plan: docs/plans/2026-04-12-aquamobil-offline-remediation/packages/05-aquamobil-truthful-queued-state-ui.md
Closes: docs/test-audits/orchestrator/2026-04-12-aquamobil-offline-sync.md#MEDIUM-005
```

## Test Plan
- Add task-page tests to prove queued actions render queued-state copy instead of definitive completion.
- Add leave-page tests to prove success copy distinguishes queued vs confirmed outcomes.
- Add chat-page tests to prove pending sends render as pending and AI assistant thinking does not start on a merely queued user message.
- Add regression tests to ensure failed actions surface explicit failure state instead of silently disappearing.

## Verification Command
```bash
npx tsc --noEmit -p web/apps/aquamobil/tsconfig.json && \
npx vitest run web/apps/aquamobil/src/pages/tasks web/apps/aquamobil/src/pages/leave web/apps/aquamobil/src/pages/messaging
```

Dispatch: frontend-expert

## Rollback Plan
```bash
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes

