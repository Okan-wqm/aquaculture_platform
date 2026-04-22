# Package 04: archive-channel-membership-fix

## Metadata
Status: PENDING
Estimated Tokens: ~5K
Priority: HIGH
Security-Sensitive: no
Parallelizable: yes (with 05, 06)
Prerequisites: 01-nats-edge-device-tenant-scoped-routing, 02-user-deleted-tenant-verification, 03-mobile-settings-role-enforcement

## Source Reviews
- docs/test-audits/workflow-state-auditor/2026-04-11-full-platform-e2e.md
- docs/test-audits/context-manager/2026-04-11-full-platform-e2e.md

## Closing Findings
Closing-Findings: [workflow-state-auditor/HIGH-004]

## Context
The archive-channel handler checks membership with `leftAt: undefined`. In TypeORM, passing `undefined` as a where-clause value is silently ignored -- the condition is dropped from the query entirely, causing it to match ALL members including those who have left. All other handlers in the messaging-service correctly use `leftAt: IsNull()`. This means a former admin/owner who already left the channel can still archive it.

## Findings
workflow-state-auditor HIGH-004: Channel archival authorized against historical membership, not active membership.
- File: `apps/messaging-service/src/channel/commands/archive-channel.handler.ts` line 53
- Uses `leftAt: undefined` -- in TypeORM this IGNORES the condition entirely (matches all members including those who left). All other handlers correctly use `leftAt: IsNull()`. A former admin/owner who already left can archive the channel.
- Severity: HIGH
- Gap class: access-gap, tenant-gap

## Affected Files
- apps/messaging-service/src/channel/commands/archive-channel.handler.ts (primary -- line 53, change `leftAt: undefined` to `leftAt: IsNull()`)

## Dependencies
Prerequisites: Tier 1 packages (01, 02, 03) must be committed first (security-first ordering).
This package touches only the messaging-service. No shared lib changes.

## Atomic Commit Plan
```
fix(messaging): use IsNull() for leftAt check in archive-channel handler

The archive-channel handler uses `leftAt: undefined` in the TypeORM
where clause, which silently drops the condition entirely -- matching
ALL channel members, including those who have already left. This allows
former admins/owners to archive channels after departure. Change to
`leftAt: IsNull()` to match only active members, consistent with every
other membership check in the messaging-service.

Addresses: workflow-state-auditor/HIGH-004

Plan: docs/plans/2026-04-13-e2e-audit-fixes/packages/04-archive-channel-membership-fix.md
Closes: docs/test-audits/workflow-state-auditor/2026-04-11-full-platform-e2e.md#HIGH-004
```

## Test Plan
- Unit test: attempt to archive a channel as a user who has left (leftAt is set). Assert ForbiddenException ("You are not a member of this channel").
- Unit test: attempt to archive a channel as an active OWNER. Assert success.
- Unit test: attempt to archive a channel as an active ADMIN. Assert success.
- Unit test: attempt to archive a channel as an active MEMBER (not admin/owner). Assert ForbiddenException ("Only ADMIN or OWNER can archive").

## Verification Command
`npx tsc --noEmit -p apps/messaging-service/tsconfig.json && npx jest --testPathPattern="apps/messaging-service/src/channel/commands" --coverage=false`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
