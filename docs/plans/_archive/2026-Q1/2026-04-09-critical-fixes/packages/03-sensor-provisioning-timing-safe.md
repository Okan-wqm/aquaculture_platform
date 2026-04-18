# Package 03: sensor-provisioning-timing-safe

## Metadata
Status: PENDING
Estimated Tokens: 12K
Priority: CRITICAL
Security-Sensitive: yes
Parallelizable: yes (Sprint 0, no prerequisites)
Prerequisites: none
Sprint: 0 (hotfix)
Closing-Findings: [SENSOR-CRITICAL-001]
Source-Reviews: [user-provided finding list 2026-04-09]

## Context
The sensor provisioning service compares provisioning tokens using standard string equality (`===`), which is vulnerable to timing side-channel attacks. An attacker can brute-force the token byte-by-byte by measuring response time differences. This has been flagged in 4 consecutive audits and remains unfixed -- it is an active exploit vector.

## Findings
- **SENSOR-CRITICAL-001**: Provisioning token non-timing-safe comparison (4th audit unfixed)
  - File: `apps/sensor-service/src/edge-device/provisioning.service.ts` (~30.7K chars)
  - The token comparison uses `===` instead of `crypto.timingSafeEqual()` or equivalent
  - Root cause: original implementation used naive comparison; repeated audit findings have not been addressed

## Affected Files
- `/var/aqua-saas/apps/sensor-service/src/edge-device/provisioning.service.ts` (~30.7K chars)

## Dependencies
None.

## Atomic Commit Plan
```
security(sensor): use timing-safe comparison for provisioning tokens

Replace string equality check with crypto.timingSafeEqual() for
provisioning token validation. Ensures constant-time comparison
regardless of how many leading bytes match, closing the timing
side-channel.

4th audit cycle flagging this finding -- must not regress.

Closes: docs/reviews/2026-04-09-critical-fixes#SENSOR-CRITICAL-001
Plan: docs/plans/2026-04-09-critical-fixes/packages/03-sensor-provisioning-timing-safe.md
```

## Test Plan
- Unit test: valid token -- provisioning succeeds
- Unit test: invalid token -- provisioning fails (verify timingSafeEqual is called, not ===)
- Unit test: tokens of different lengths -- handled gracefully (timingSafeEqual requires equal length buffers)

## Verification Command
```bash
cd /var/aqua-saas && npx jest --testPathPattern="apps/sensor-service/src/edge-device/provisioning" --coverage=false
```
Dispatch: security-reviewer

## Rollback Plan
```
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes
