# 2026-05-06 - Alert Engine Escalation Redis Mock Contract

## Affected Area
- `apps/alert-engine/src/escalation/__tests__/escalation-manager.service.spec.ts`
- `apps/alert-engine/src/escalation/escalation-manager.service.ts`
- GitHub Actions `CI - Affected / test`

## Observed Issue
The affected test run failed many escalation-manager tests with:

- `TypeError: this.redisService.sadd is not a function`

The production service uses Redis set operations to track active escalations:

- `sadd`
- `srem`
- `smembers`
- `setNx`
- `scan`

## Root Cause
The spec's in-memory Redis mock only modeled JSON key-value operations. After the escalation manager moved active escalation tracking onto Redis sets and distributed locks, the test double no longer represented the real `RedisService` port.

This is test harness drift. Weakening production code to avoid Redis set operations would reintroduce race-prone active escalation tracking.

## Architectural Fix
Extend the spec Redis double to model the RedisService contract used by the escalation manager:

- separate in-memory string and set stores
- atomic-ish `setNx` behavior for lock acquisition tests
- `sadd` / `srem` / `smembers` set behavior
- `scan` pattern behavior for cleanup/listing paths

This keeps tests aligned with the production port instead of stubbing only the old subset.

## Verification
- GitHub Actions `CI - Affected / test`
- Targeted local test was not run because this server checkout has no `node_modules`; heavy install belongs in GitHub Actions for this environment.

## Status
Fixed on 2026-05-06; pending CI confirmation.
