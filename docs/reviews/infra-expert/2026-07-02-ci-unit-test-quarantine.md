# CI unit-test quarantine hides failing specs (2026-07-02)

## CI-HIGH-020 — PR CI quarantines ~16 projects' unit tests; a red spec merged green
`scripts/ci/affected-target-policy.json` (targets.test.quarantine) strips farm-service, auth-service,
gateway-api, billing-service, hr-service, notification-service, observability-service, config-service,
alert-engine, sensor-service, messaging-service, shell, dashboard, farm-module, admin-panel and
eslint-plugin-aquaculture from the strict `nx run-many --target=test` list ("CI run 26116890061: existing
unit-test debt"), so their unit specs NEVER run in PR CI while the `test` job reports success.
PROOF: #794 merged green while apps/farm-service permission-matrix.spec.ts was RED at that commit
(reconcileTankCounts missing from the authz matrix — `every @Mutation is classified` fails when run locally
at 4aaa8837d); the runtime fail-closed guard caught it in production instead (#798). The parity invariant
itself works; the quarantine hid it. Un-quarantining is a per-project program: bring each suite green
(farm-service full suite currently exceeds 10min on the droplet — needs sharding/perf work first), then
remove the JSON entry. Interim mitigation: run the affected project's jest suite locally before merging
(now recorded in operator memory + this finding). Owner: infra-expert. Deadline: 2026-07-31.

## CI-HIGH-021 — eslint-plugin-aquaculture's Nx test target does not execute its RuleTester suite

The workspace package advertises `"test": "jest"`, but its RuleTester suite lives under
`tools/lint-gates/`, outside the package Jest discovery root. The Nx target therefore exits with
`No tests found`, which led to the project being quarantined from strict affected tests. The target's
default cache inputs also exclude the external suite, so merely pointing the script at that file would
allow stale green results after a RuleTester change.

Required remediation: make the package test script execute the RuleTester suite, declare that suite and
its runner tsconfig as Nx cache inputs, assert every exported rule has a suite, cover the seventh
`no-unpinned-ssrf-fetch` rule, and remove the project from both test and lint quarantine after its direct
targets pass. Owner: infra-expert. Deadline: 2026-07-31. Status: IN-PROGRESS.
