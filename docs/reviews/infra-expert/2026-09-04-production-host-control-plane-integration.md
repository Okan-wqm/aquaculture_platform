# Production host control plane — integration of PR #1022 onto the integration head

| Field       | Value                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| Date        | 2026-09-04                                                                                                  |
| Reviewer    | infra-expert                                                                                                |
| Base        | `81a7286dd` (`claude/branch-evaluation-merge-s5grgw`)                                                       |
| Branch      | `claude/prod-host-control-plane-integration`                                                                |
| Sources     | `origin/fix/production-host-control-plane` (PR #1022), `origin/wip/codex-prod-host-node-authority-20260816` |
| Merge-base  | `bdaf00bf6` — both source branches share it                                                                 |
| Blob source | the codex rescue tip `e156e7839` for every file, per the integration brief                                  |

## What this document is for

PR #1022 has been an open draft since 2026-07-20 with red CI and is 614+ commits behind. It carries
92 files and 67 findings that exist nowhere on main. This integration recovers it by path slices
onto main's shape rather than merging it, and this document records the three things a
slice-by-slice recovery produces that the commits themselves cannot hold: the decisions that belong
to the owner rather than to the integrator, the parts that were found to be unportable, and the debt
that landing a partial recovery creates.

## Slices recovered

| Slice | Outcome  | Commit                                                               |
| ----- | -------- | -------------------------------------------------------------------- |
| 0     | landed   | `chore(reviews)` — 58 narrative sections + 58 registry rows          |
| 1     | landed   | `security(deploy)` — host control plane + exact-SHA producers        |
| 2     | landed   | `security(ci)` — platform-binary installer fails closed              |
| 3     | NOT DONE | see "Slice 3 — the WAL-G evidence chain" below                       |
| 4     | landed   | `security(infra)` — NATS broker cert exposure + atomic publication   |
| 5     | landed   | `fix(billing)` — persisted invoice amounts proven before a payment   |
| 6     | landed   | `fix(ci)` — NATS drift gate reads the commit instead of repairing it |

## Owner decisions recorded, not implemented

These were excluded by the integration brief or found to conflict with a contract main holds. Each
is written down with what would change, so the decision can be made on evidence rather than
rediscovered.

### 1. The `PRODUCTION_*` secret rename is not applied

PR #1022 renamed `DROPLET_*` to `PRODUCTION_DROPLET_*` and `PRODUCTION_BACKUP_DROPLET_*` across
eight workflows, added `.github/manifests/production-deploy-secrets.json`, and rewrote both
runbooks' secret tables to match. Main's names stand.

Consequences of the decision, for the record:

- `.github/manifests/production-deploy-secrets.json` is not carried. Main already owns that SSoT as
  `.github/provisioned-secrets.json`, which declares `DROPLET_HOST` / `DROPLET_USER` /
  `DROPLET_SSH_KEY` / `DROPLET_SSH_FINGERPRINT` and is enforced in both directions by
  `tests/invariants/workflow-secret-provisioning.spec.ts` (undeclared secret → red; orphaned
  declaration → red). Carrying a second manifest naming secrets that exist nowhere would be a
  duplicate SSoT declaring fiction.
- The branch's split between a production-deploy SSH principal and a production-backup SSH principal
  does not exist here. Both lanes use the same `DROPLET_*` credentials, so a compromise of the
  backup principal reaches the deploy host and vice versa. That is the substance behind
  `INFRA-CRITICAL-095`; it stays OPEN.
- The branch's dedicated package-read GHCR principal (`PRODUCTION_GHCR_READ_USERNAME` /
  `PRODUCTION_GHCR_READ_TOKEN`) is also not carried, so the production host still receives the
  workflow's `GITHUB_TOKEN` as `GHCR_TOKEN`. That is `INFRA-CRITICAL-081`; it stays OPEN. The
  control plane's credential-demotion machinery landed in slice 1 and is ready for the narrower
  credential when it exists.

### 2. `run-protected-ssh.sh` is extended, not replaced

Main's helper has its own contract in `tests/invariants/backup-production-secrets.spec.ts` and three
live workflow callers (`backup-production.yml`, `database-wal-archive-freshness.yml`,
`pitr-restore-production.yml`). The branch's rewrite changes three things that break that contract,
and each is an owner decision rather than an integration detail:

| Branch change                                                           | Why it is not carried                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| private key arrives through `SSH_PRIVATE_KEY_FD`, not `DROPLET_SSH_KEY` | Changes the calling convention of all three live workflows and the spec's dynamic fixtures. A real improvement — the key is never an environment string — but it is a coordinated change across four files and a production backup path that cannot be exercised here.    |
| every system binary pinned by absolute path (`/usr/bin/ssh`, …)         | Main's dynamic fixtures shadow `ssh-keyscan`, `ssh-keygen` and `timeout` through `PATH`. Absolute pins make the helper untestable by that mechanism; the fixtures would need an entirely different isolation strategy.                                                    |
| stdout bounded through a `head -c` pipe                                 | The spec pins the literal `< "${SSH_PAYLOAD_PATH}" > "${SSH_STDOUT_PATH}"` redirect, which a pipe removes. The bound is worth having — a hostile host could otherwise stream unbounded bytes into the runner — but it changes the shape the invariant is written against. |

What IS carried is the ED25519 requirement (`INFRA-MEDIUM-088`), because the provisioning contract
is verifiable from this repository: the `INFRA-CRITICAL-078` narrative records that the host ED25519
fingerprint was provisioned into the production Environment on 2026-07-18. `ssh-keyscan -t ed25519`,
an algorithm check on the advertised line, and `-o HostKeyAlgorithms=ssh-ed25519` now make the
algorithm part of the accepted contract instead of an accident of scan order.

### 3. The branch's deploy-lane rewrites are excluded

`droplet-up.sh`, `droplet-capacity.sh`, `deploy-paths.sh`, `post-deploy-verify.sh`,
`deploy-digitalocean.yml`, `deploy-capacity-maintenance.yml` and `production-post-deploy-verify.yml`
keep main's shape. Main's development-deploy chain (`build-images.yml`, `deploy-development.yml`,
`scripts/deploy/lib/deployment-mode-policy.sh`, `scripts/deploy/lib/required-env-secrets.sh`), the
bounded capacity recovery of `0b23f3cda` and the current `ci-affected.yml` / `e2e-tests.yml` hunks
are kept.

The consequence is `INFRA-HIGH-141` below.

## Slice 3 — the WAL-G evidence chain was found unportable

The brief scoped slice 3 to "scripts and docs only, no workflow secret changes". That scope is not
satisfiable for this surface, and that is the finding rather than a reason to force it.

**What the branch's WAL-G work actually is.** Five new files (`walg-pitr-ceremony.sh`,
`verify-walg-evidence-mirror.sh`, `materialize-walg-signed-transfer.sh`, `read-bounded-line.mjs`,
`pitr-source-verification-locks.sql`) plus roughly 2,700 changed lines across
`evaluate-walg-evidence.mjs`, `walg-evidence-attestation.mjs`, `walg-pitr-restore.sh`,
`verify-walg-github-evidence.sh` and `generate-database-verification-sql.ts`. Main has not touched
any of those five existing files since the fork, so they would apply cleanly — which is exactly the
trap.

**Why cleanly-applying is not the same as portable.** The branch introduces subcommands
(`verify-local-run`, `verify-binding`), a `--check` mode, a sanitized `run_trusted_node` re-exec and
a `trusted-tools/` copy step that exist only inside its rewritten `backup-production.yml` (+1,629
lines) and `pitr-restore-production.yml` (+1,840 lines). Landing the scripts alone would give every
new subcommand no caller, while changing the behaviour of `create-run` and `create-evidence`, which
the live backup lane does call. That is an untestable change to the production evidence chain: there
is no Docker, no Spaces and no production here to exercise it against.

**The runbook text is unportable for a different reason.** The `database-restore-drill.md` diff is
the v2-to-v3 evidence description plus the `PRODUCTION_*` rename; the `secret-rotation.md` diff is
the rename alone. Carrying the v3 description without the v3 producer would document artifact names,
mirror keys and job names that do not exist — the runbook would be prose describing a system main
does not run.

### Reconciliation with #1255 and the 2026-07-30 recovery plan

Three descriptions of production recovery now exist and they do not conflict; they are at different
altitudes, and only one of them is a claim about the running system.

- **`docs/plans/2026-07-30-enterprise-backup-restore-architecture/PLAN.md`** is the architecture of
  record. It classifies main's current PostgreSQL PITR surface — `pitr-restore-production.yml`,
  `walg-pitr-restore.sh`, `evaluate-walg-evidence.mjs` — as a _strong verifier_, and names the gap
  as coverage and authority fragmentation around it (MinIO, Redis, JetStream, key recovery,
  independent WORM retention), not as a defect in the verifier. It explicitly consumes existing
  registry stop-lines rather than inventing new IDs. Nothing in PR #1022's evidence work contradicts
  it; the branch is operating one layer down, on the integrity of the PostgreSQL evidence artifact
  itself.
- **PR #1255 (`78a63d8eb`)** landed on main from the same 2026-08-16 codex worktree as this branch's
  rescue tip. It produces a signed, digest-pinned PostgreSQL DR image candidate with a fsync-backed
  phase journal and a shared control-plane lock, without touching production — the deadlock-breaker
  for `INFRA-HIGH-073`. Its notes record two corrections to its source worktree that this
  integration hit again independently: a required-check list pinned as a literal array had already
  gone stale, and its `jest.config.ts` hunk targeted an enumerated spec list main no longer has
  because layer-1 became a glob. The same two corrections apply here, which is evidence about the
  whole rescue line rather than about either branch.
- **PR #1022's evidence rewrite** is the third, and it is the one that has no landing path today. It
  changes the evidence SCHEMA (v2 → v3: a compact attestation binding a canonical source-JSON digest
  and byte count to an immutable source artifact), the ceremony (run-scoped, nonce-labelled Docker
  resources with attestation on every handle) and the mirror (a credential-minimal `env -i` child,
  content-addressed at `wal-g-evidence/v3/sha256/…`). Producer and consumer must move together, and
  the workflow half is the producer.

**The decision this needs.** Either an execution plan that lands the v3 chain whole — reconciled
with #1255's control plane, and with the recovery plan's conjunctive-verdict rule that a green
closure requires every required asset and authority green for the same recovery-cut ID — or an
explicit owner decision that main's v2 chain stands and the branch's evidence work is abandoned.
Tracked as `INFRA-HIGH-144`. Until that decision, `INFRA-CRITICAL-090`, `INFRA-HIGH-102`, `103`,
`104`, `108`–`120` and `INFRA-MEDIUM-110`, `116`, `117`, `128`, `129`, `131` stay exactly as
PR #1022 left them.

## Gaps created or left by this integration

### INFRA-HIGH-141 — the control plane has no caller

**Owner:** infra-expert. **Deadline:** 2026-09-18.

`scripts/deploy/production-host-control-plane.sh`,
`tools/scripts/ci/prepare-production-host-runtime-bundle.sh` and
`tools/scripts/ci/prepare-production-host-ssh-payload.sh` are committed and covered by 26 invariant
tests, and nothing invokes them. `deploy-digitalocean.yml` still reaches the droplet through
`appleboy/ssh-action` and runs main's `droplet-up.sh` directly; `droplet-up.sh` and
`post-deploy-verify.sh` still resolve `node` from `PATH` and take no host lock.

This is deliberate — the alternative was importing the branch's wholesale rewrite of five scripts
and three workflows, which the brief excludes — but it means the capability is present and the
property is not. A control that exists, is tested, and is not wired where it matters enforces
nothing.

**Closure criterion.** The production deploy, capacity maintenance and post-deploy verification
paths each enter through `production-host-control-plane.sh` (`lock-exec` / `hydrate-exec` /
`shared-exec`); every bundled runtime is invoked through `${AQUA_PRODUCTION_NODE_BIN}`; and
`deploy-isolated-checkout-ssot.spec.ts` pins the ordering — Node authority before the lock, the lock
before any release, Docker, database or secret mutation — against main's files rather than the
branch's.

### INFRA-HIGH-142 — NATS private keys are still world-readable on the host

**Owner:** security-reviewer. **Deadline:** 2026-09-18.

Slice 4 removed the broker's wholesale `./certs/nats` bind, so the NATS container no longer holds
every service's key. The keys themselves are still written mode `0644`, and the generator validates
that mode as canonical. Both PR #1022 and main write them that way, so this half of
`INFRA-CRITICAL-101` was never repaired by either line. The identity-store directories are now
`0700`, which stops a listing, but any process that can name a key path still reads it.

The mode cannot simply be tightened to `0600`: the compose bind-mounts the file into the container
and the in-container reader is the service process, not root, so the correct mode depends on each
consumer's runtime UID.

**Closure criterion.** Each per-service key is readable only by the UID of the container that mounts
it — or delivered by a mechanism that does not place it on a shared host path — the generator
validates that exact mode, and `production-cert-identity-store.spec.ts` asserts it.

### INFRA-HIGH-144 — the WAL-G v3 evidence chain has no landing path

**Owner:** infra-expert. **Deadline:** 2026-09-25. Described in full under "Slice 3" above.

### INFRA-MEDIUM-143 — closed by slice 6

Raised and closed in the same cycle: both NATS drift gates ran the generator and then asked git
whether the tree had become dirty, repairing the checkout before judging it. Recorded rather than
fixed silently because the defect class — a gate that mutates what it measures — is worth having in
the ledger.

## Nine finding IDs need renumbering before the registry rows can be carried

Main allocated nine of PR #1022's IDs to DIFFERENT findings after the fork. Their branch rows are
preserved in full at `scratchpad/r1022/branch-findings.jsonl` and are NOT written into the ledger
under those IDs, because a `Closes:` trailer naming one of them would be ambiguous between two
unrelated findings.

| ID                  | Main's finding (kept)                                               | PR #1022's finding (needs a new ID)                                          |
| ------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `INFRA-HIGH-084`    | CI Full skips PRs and protected-main pushes                         | current-release marker published before fallible image cleanup completes     |
| `INFRA-HIGH-086`    | CI Full starts Rust lint before the pinned toolchain installs       | interrupted source publication leaves a permanently blocking stage           |
| `INFRA-HIGH-087`    | CI Full turns repo-wide Prettier debt into a required-check failure | promoted release ledger records image identities from mutable local tags     |
| `INFRA-HIGH-089`    | CI Full inherited impossible dormant Jest coverage floors           | bootstrap rejects the root-owned 0755 legacy directory it must migrate       |
| `INFRA-HIGH-094`    | unprovisioned Codecov omitted non-root JS coverage evidence         | first hardened deployment cannot run image GC with no current-release marker |
| `INFRA-HIGH-104`    | four HIGH advisories block every merge (RESOLVED)                   | tenant-scale PITR evidence exceeds the signed attestation envelope           |
| `INFRA-HIGH-105`    | js-yaml CVE-2026-59870 blocks every merge (RESOLVED)                | migration-crossed failed release journal cannot be superseded                |
| `SENSOR-MEDIUM-058` | Modbus 32-bit word-order decoding is wrong                          | ScadaPackageService test modules omit the lifecycle event emitter            |
| `SUPPLY-HIGH-001`   | four high-severity advisories block the security-audit check        | locked brace-expansion versions remain vulnerable                            |

`INFRA-CRITICAL-099` is absent from PR #1022's sequence (it runs 095–098 then 100); no action,
recorded so the gap is not read as a loss.

## Registry state handed to the integrator

The debt-closure plan mirrors are deliberately NOT repinned on this branch, per the brief.
`tests/invariants/enterprise-grade-debt-plan-contract.spec.ts` is therefore red here by
construction, in exactly one test — "keeps manifest counts and active criticals pinned to the
finding registry SSoT". Repin
`docs/plans/2026-06-18-enterprise-grade-debt-closure/{manifest.json,README.md,finding-truth-table.md}`
against the tip the merge actually produces, not against these numbers; they are recorded only so
the delta is legible.

| Field                        | Value at this branch's tip                                         |
| ---------------------------- | ------------------------------------------------------------------ |
| `registry_entries`           | 1672 (1613 at the base + 58 carried + `INFRA-MEDIUM-143`)          |
| `registry_tip_hash`          | `9e5def44ecdf234ec5a7c08baadc615f6f70a57441eb98c7cf0af7a4e6f6b6bf` |
| `open_findings_count`        | 737                                                                |
| `in_progress_findings_count` | 163                                                                |
| `active_critical_count`      | 75                                                                 |

The twelve IDs the carried rows add to `active_critical_ids`, appended in this order after
`SENSOR-CRITICAL-104`: `INFRA-CRITICAL-080`, `081`, `082`, `083`, `085`, `090`, `093`, `095`, `097`,
`098`, `100`, `101`. `082` and `101` are closed by slices 2 and 4 and leave the active set once the
integrator runs `finding-registry close` against the merged SHAs.

`finding-registry.ts rechain-from` refuses to run on this branch: `origin/main` has advanced past
the base (`SENSOR-HIGH-103` was closed on main at entry 1449), so the CLI's canonical-prefix guard
sees a divergence it is right to refuse. The appended rows were chained with the CLI's own algorithm
— same canonical JSON, same `sha256(entry minus content_hash)` — and `finding-registry.ts verify`
passes on the result. The integrator restitches against the merge tip regardless.

New finding stubs, in the shape of a registry row minus `prev_hash` and `content_hash`, are at
`scratchpad/r1022/stubs/`: `INFRA-HIGH-141.json`, `INFRA-HIGH-142.json`, `INFRA-HIGH-144.json`, and
`INFRA-MEDIUM-143.json` (already appended and closed by slice 6).
