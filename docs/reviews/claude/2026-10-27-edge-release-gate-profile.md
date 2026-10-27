# Edge release gate ignores the release profile's non-blocking classification

**Owner agent:** claude · **Cycle:** 2026-10-27-edge-release-gate-profile · **Branch:**
`claude/edge-release-gate-profile`

`edge-agent-release.yml` runs `npm run gates:sens-enterprise-validation -- --release
--release-profile=edge-agent-scada-display` before it builds anything. Tag
`agent-v2.0.0-rc.5` (`58f0c3be6`, the first agent version without rodbus) failed at that step,
so no binaries were built and no release was created.

## Findings

### PROC-HIGH-066 — the release gate stops a profile release on every blocked claim

- **Where:**
  - `tools/gates/sens-enterprise-validation.ts:1709` — `const blockedReleaseClaims = blockedClaims;`.
    Commit `42695736f` (2026-06-08) replaced the profile filter that `agent-v2.0.0-rc4`
    (`7ba7ca2cc`) applied, `blockedClaims.filter((claim) => releaseProfile.blocking_claims.includes(claim.id))`.
  - `tools/gates/sens-enterprise-claims.json:290` — profile `edge-agent-scada-display` classifies
    `runtime-io-safe-state-closure`, `cloud-edge-command-lifecycle-closure`,
    `opcua-s7-physical-write-closure` and `sx1302-vendor-hal-hil-closure` as `non_blocking_claims`,
    with a rationale: the profile publishes signed binaries and release evidence and does not claim
    those closures.
  - `package.json:168` — `gates:sens-enterprise-validation:self-test` was invoked by no workflow,
    so the gate's own tests could not catch the change.
- **Effect:** run 40555277480 exited 1 with `6 pass, 4 blocked, 0 fail`; `Build` and
  `Create GitHub Release` were skipped. No agent release could pass the gate after 2026-06-08.
- **Rule:** a release profile's `blocking_claims` and `non_blocking_claims` are the contract of that
  release artifact. The gate evaluates a profile release against that classification, and every
  gate self-test runs in CI.

## Fix

- **Make it automatic:** `releaseBlockingClaims()` selects the claims that stop a release: the
  blocked claims in the profile's `blocking_claims`, or every blocked claim when no profile is
  given. A blocked claim outside `blocking_claims` is still printed, as `NON-BLOCKING release
  claim …` with its blocker text, so the open closures stay visible in every release log.
- **Make it detectable:** the gate self-test covers the three cases (non-blocking claim under a
  profile, no profile, blocked claim listed in `blocking_claims`), and the
  `sens-enterprise-validation` job in `ci-affected.yml` runs the self-test before the gate.
- **Release path:** the version moves to `2.0.0-rc.6` (`Cargo.toml`, both lockfiles, the version
  pin in `sens-api-gateway-ci.yml`). The release workflow builds the commit a tag points at, and
  `agent-v2.0.0-rc.5` stays on `58f0c3be6`; release tags are never moved.

## Not changed

The four non-blocking claims stay `blocked` in the manifest. Closing them needs runtime work
(safe-state result semantics, durable command lifecycle, protocol-write audit, SX1302 hardware
evidence) and is tracked under their own claims (`RUNTIME-IO-SAFE-STATE`,
`CLOUD-EDGE-COMMAND-LIFECYCLE`, `OPCUA-S7-PHYSICAL-WRITE`, `SX1302-HIL`).
