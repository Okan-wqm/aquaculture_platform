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

**Resolution (2026-07-06):** All nine suites reconciled to the current contracts — root-cause, no blanket weakening. Full `nx test sensor-service` is now **green** (40 suites / 784 tests, zero failures; up from the 9-suite baseline). `vfd-command` security triage cleared: validation still blocks every dangerous write (missing value, out-of-range/negative frequency all return `{ success: false }` with the frequency un-written) — the change was purely error-surfacing (throw → result object), plus a genuine gap fixed (the CiA402 `QUICK_STOP` command had no handler and is now routed to the quick-stop control word). Two other real service fixes landed alongside the spec updates: `validatePagination` clamps an explicit `0` to the minimum (`??` vs `||`), and `registerVfdDevice` now surfaces a failed connection-test's message in `result.error` instead of dropping it. Spec-only reconciliations: Siemens 9600-baud default, canonical Modbus CRC16 numeric value, TypeORM `save(array)`/`create(array)` mock shapes + `saveMany`'s extra `create` call, shared-`mockDevice` isolation, connection-pooling contract, and the `vfd-modbus-tcp` adapter spec rewritten onto the raw `net.Socket` layer (the adapter dropped modbus-serial). Closing commits: `5f08a884`, `8a412e59`, `759f21f3`, `69614b88`.

Follow-up (separate, non-blocking): add `sensor-service` to the CI required-green set now that it is reconciled, so drift cannot re-accumulate — tracked as infra work, not a correctness gap.

Cross-domain dependency:
- `sensor-expert`, `security-reviewer`, `test-runner`
