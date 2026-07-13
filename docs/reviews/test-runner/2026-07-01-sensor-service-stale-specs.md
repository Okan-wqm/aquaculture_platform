# Test Runner Review — sensor-service stale spec debt
**Date:** 2026-07-01
**Scope:** `apps/sensor-service` unit-test health, discovered while validating the sensor-module architecture cleanup branch (`claude/sense-sensor-module-arch-oguq01`)

**Decision:** `TRACK` — pre-existing failures on `main`, independent of the cleanup diff (verified by running the identical suite on an `origin/main` worktree: same 10 failing suites before the branch, 9 after the branch fixed `provisioning-config.spec.ts`).

## Summary
| Area | CRITICAL | HIGH | MEDIUM | LOW |
|------|----------|------|--------|-----|
| Total | 0 | 1 | 0 | 0 |

## Findings

### HIGH-001 Nine sensor-service spec suites fail on `main` because specs lag behind evolved service behaviour
`nx test sensor-service` is red on `origin/main` (commit `cce2c95`). The failures are behavioural drift — the services were changed (often deliberately, e.g. security hardening) without updating their London-school specs. This makes the `nx affected --target=test` gate permanently red for every branch touching sensor-service, which trains contributors to ignore the gate.

Failing suites (verified 2026-07-01, clean `origin/main` worktree, `--skip-nx-cache`):
- `src/sensor-type/__tests__/channel-detection.service.spec.ts` — call-count expectations off by one (`approveProposal` now emits an extra repository call)
- `src/sensor-type/__tests__/sensor-type.service.spec.ts` — `createChannelsFromTypeDefinition` return shape changed (object vs array)
- `src/sensor/validation/__tests__/input-sanitizer.spec.ts`
- `src/vfd/adapters/__tests__/base-vfd.adapter.spec.ts`
- `src/vfd/adapters/__tests__/vfd-modbus-tcp.adapter.spec.ts`
- `src/vfd/entities/__tests__/vfd.enums.spec.ts`
- `src/vfd/resolvers/__tests__/vfd-device.resolver.spec.ts` — error propagation contract changed (`result.error` no longer populated)
- `src/vfd/services/__tests__/vfd-command.service.spec.ts` — command validation semantics changed (rejections now resolve)
- `src/vfd/services/__tests__/vfd-device.service.spec.ts` — `activate` no longer throws without successful connection test

`src/edge-device/__tests__/provisioning-config.spec.ts` was the tenth failing suite (missing `DataSource` provider + expectations predating the pinned-GitHub-repo supply-chain hardening); it was fixed to green on the cleanup branch.

Root-cause requirement: each suite must be reconciled against the CURRENT intended contract — where the service behaviour is the intended one (e.g. pinned repo), fix the spec; where the spec encodes the intended contract (e.g. VFD command validation rejecting out-of-range frequency), fix the service. Blanket spec-weakening is not acceptable, particularly for `vfd-command.service.spec.ts` where silently-resolving validation paths may be a real regression in an ICS-adjacent control path.

Evidence:
- `apps/sensor-service/src/vfd/services/vfd-command.service.ts`
- `apps/sensor-service/src/sensor-type/channel-detection.service.ts`
- Failing-suite parity proof: identical FAIL set on `origin/main` worktree vs branch (10 == 10 pre-fix)

Remediation:
- Per-suite reconciliation (spec vs service) with the domain owner; `vfd-command` validation paths triaged FIRST as a potential real regression.
- Add sensor-service to the CI required-green set once reconciled so drift cannot re-accumulate.

Owner: sensor-expert (backend) — escalate `vfd-command` triage to security-reviewer if validation regression confirmed.
Deadline: 2026-07-15
State: RESOLVED

Resolution (2026-07-13, verified against current `main`): the full `nx test sensor-service` suite is green — **61 suites / 890 tests, zero failures** (live run, exceeds the 40/784 the reconciliation originally targeted). Every remediated surface landed on `main` via later, equal-or-newer paths rather than the stale review branch (`claude/sense-sensor-module-arch-oguq01`, 350 commits behind, now superseded): the CiA402 `QUICK_STOP` handler and `vfd-command` error-surfacing are in `apps/sensor-service/src/vfd/services/vfd-command.service.ts` (which additionally gained the DB-SENSOR-HIGH-003 command-audit-log the branch never had); the `registerVfdDevice` connection-error surfacing is in `vfd-device.resolver.ts` (`connectionError`); and the `validatePagination` explicit-`0` clamp is in `input-sanitizer.ts` in a stricter undefined/null/NaN form. The `vfd-modbus-tcp` adapter spec on the raw `net.Socket` layer and all previously-stale suites pass. NOTE — scope boundary: this closes ONLY the stale-spec test-debt finding; the `SENSOR-HIGH-001..005` architectural SCADA/deploy findings that the retired branch's close-ceremony also touched remain **OPEN** on `main` and were deliberately NOT flipped here (they require their own code-level verification, not a spec-suite green signal). Follow-up still open: add `sensor-service` to the CI required-green set so drift cannot re-accumulate (infra work, non-blocking). Verified by: 2026-07-13 branch-triage program.

Cross-domain dependency:
- `sensor-expert`, `security-reviewer`, `test-runner`
