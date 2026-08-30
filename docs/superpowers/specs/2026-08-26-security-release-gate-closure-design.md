# Security Release Gate Closure Design

- **Date:** 2026-08-26
- **Status:** Approved for implementation
- **Branch:** `security/production-hardening-20260825`

## Context

The production security hardening branch already closes the MQTT fail-open path,
replay-window precision defects, unsafe administrative SQL sort interpolation, and
the currently actionable JavaScript dependency advisories. Independent pre-merge
reviews found five remaining release-control gaps that could still let a security
regression escape the evidence presented by the protected `main` gates:

1. The edge fuzz lock audit exists only in an optional workflow and is not bound
   to a required status-check chain.
2. The two production WebAssembly Cargo locks are neither Dependabot-owned nor
   audited by a required workflow.
3. An E2E-only dependency update enters CI through `has_changes`, but that same
   signal currently authorizes staging and production deployment on a push to
   `main`.
4. Root-workspace and AquaMobil dependency updates have separate ownership even
   though both locks resolve the same exact production manifest constraints.
5. The Hydroponics router regression test is present but has no jsdom/Vitest/Nx
   runner path, so the normal monorepo test graph cannot execute it.

The first full local suite also exposed two verification-environment conditions:
the checkout was created under umask `0077`, reducing a Git-tracked executable
script to mode `0700`, and unconstrained Nx/Jest concurrency exhausted the host's
memory and swap before `db-migrate` completed. Git already records the script as
executable (`100755`), so the mode failure is not a source change. The final local
suite will normalize the checkout mode and use controlled parallelism rather than
weakening either test.

## Goals

- Make every production-relevant standalone dependency lock visible to a required,
  fail-closed security gate.
- Separate “must run CI/audit” from “may deploy” without changing the repository's
  protected status-check names.
- Give root and AquaMobil dependency changes one atomic update authority.
- Make the Hydroponics router regression part of the ordinary Nx test graph.
- Make WebAssembly builds reproducible from committed lockfiles.
- Preserve existing branch protection, signed-commit, finding-traceability, and
  no-bypass policies.

## Non-goals

- This change does not add or rename a required GitHub status context.
- It does not introduce a privileged bot or a `pull_request_target` lock-sync
  workflow.
- It does not manually deploy or bypass the normal post-merge release chain.
- It does not enable GitHub automated security fixes before the dependency graph
  has re-indexed the merged locks.
- It does not rewrite or force-push the existing signed branch history.

## Design

### 1. Required Rust dependency-audit boundary

The existing `sens-api-gateway-rust` job remains the Rust release authority used
by `sens-enterprise-summary` and `merge-gate`. It will install a pinned
`cargo-audit` tool and audit all independently resolved Rust graphs involved in
this release:

- root `Cargo.lock`, using the repository's tracked `.cargo/audit.toml` policy;
- `sens-api-gateway/Cargo.lock`, using its explicit, reviewed advisory policy;
- `sens-api-gateway/fuzz/Cargo.lock`;
- `crates/alarm-core-wasm/Cargo.lock`; and
- `crates/protocol-codec-wasm/Cargo.lock`.

Active advisories return non-zero and block the existing required summaries. Any
exception must remain explicit, advisory-specific, justified in the repository,
and covered by an invariant; warnings are not converted into an unbounded success
path. The optional edge workflow may retain its audit for fast component feedback,
but it is no longer the only enforcement point.

This keeps status-check governance stable: branch protection continues to require
the current summary names, while the dependency work those summaries attest to
becomes complete.

### 2. CI intent and deploy authorization

`detect-changes` will publish two independent outputs:

- `has_changes`: source, build, workflow, dependency, or audit-owned changes that
  must execute the PR quality/security chain.
- `deploy_changes`: changes that are allowed to invoke staging and production after
  the push-to-`main` quality chain succeeds.

An explicit `audit_only` path class will own `e2e/**`. `audit_only` contributes to
`has_changes` so standalone E2E lock updates cannot skip security auditing, but it
does not contribute to `deploy_changes`. The `deploy-staging` and
`deploy-production` jobs will require `deploy_changes == 'true'`; CI jobs and
required summaries continue to use `has_changes`.

The classifier itself is treated as executable release-control code. Invariants
will prove that an E2E-only change requests audit but cannot request deployment,
while application or deploy-control changes request both. A skipped, cancelled,
or failed required dependency remains a merge-gate failure.

### 3. Atomic Dependabot ownership

The root npm update entry will use GitHub's multi-directory update model for both
`/` and `/web/apps/aquamobil`, with `versioning-strategy: increase` and a group
using `group-by: dependency-name`. The separate AquaMobil `lockfile-only` entry
will be removed. This produces one dependency update across both manifests/locks
when they share a dependency, while still allowing manifest constraints to move
when a security update cannot fit the old range.

The standalone E2E npm graph remains a separate updater because it is deliberately
outside the root workspace and has no production lockstep relationship.

Cargo update ownership will explicitly include the independently resolved WASM
directories alongside the root workspace. The existing edge/fuzz exception remains
separate because that tree has an independent deny/advisory policy and release
cadence, but its required audit coverage is enforced as described above.

Offline invariants will reject overlapping npm ownership, a return to
`lockfile-only` for AquaMobil, an uncovered tracked lock, or a missing required
audit command.

### 4. Hydroponics regression runner

The Hydroponics module will receive the same test contract used by the other React
microfrontends:

- a package `test` script and the shared pinned Vitest/jsdom test dependencies;
- a Vitest configuration with a browser-like `jsdom` environment and repository
  setup conventions; and
- an Nx `test` target whose inputs include the module tests/configuration.

The existing `SolutionPage.router.spec.tsx` test will then run through both the
module command and `nx test hydroponics-module`. An invariant will keep the module
in the repository-wide Vitest consumer set so the runner cannot silently become
orphaned again.

### 5. Locked WebAssembly builds

Both `build-wasm` Nx targets will include their crate's `Cargo.lock` in cache
inputs, and both build scripts will call `cargo build --locked`. The pinned
`wasm-bindgen` manifest, lockfile, and CLI expectation will move together to a
currently resolvable compatible version. Generated outputs are regenerated and
diff-checked under the existing repository convention.

This makes the lockfile an enforced build input rather than documentation: a
manifest/lock mismatch fails the build, and a lock change invalidates the Nx cache.

### 6. Finding traceability

Implementation commits will use allowed conventional types and carry `Closes:`
trailers for the findings they actually remediate. The production security audit
and finding registry will be updated only after fresh evidence demonstrates the
corresponding closure. Existing history will not be rewritten merely to repair a
non-conforming older subject; the final PR/merge title will use an allowed type.

## Failure behavior

- A vulnerable or unresolvable Rust lock makes `cargo audit` fail, which makes
  `sens-api-gateway-rust` fail, which makes the existing required summaries fail.
- A missing standalone audit command, uncovered lock, overlapping updater, or
  weakened path classifier fails invariant tests before merge.
- An E2E-only push to `main` may run validation but cannot satisfy the deployment
  authorization predicate.
- A WebAssembly manifest/lock mismatch fails `cargo build --locked` instead of
  silently resolving a different tree.
- A missing Hydroponics jsdom runner fails both its targeted runner contract and
  the dependency-security-floor invariant.
- No `continue-on-error`, permissive fallback, administrator bypass, or status
  name substitution is introduced.

## Test strategy

Implementation follows red-green-refactor:

1. Extend the dependency and workflow invariants first and demonstrate that they
   fail against the current configuration.
2. Demonstrate the current Hydroponics test fails under its default runner path,
   then add its Vitest/Nx contract until the same test passes normally.
3. Add locked-build/cache-input assertions before changing the WASM build paths.
4. Run focused invariant, Hydroponics, WASM build, Cargo audit, npm audit, admin,
   replay, MQTT, and frontend regression suites.
5. Normalize local executable modes from the Git index and rerun the full Nx test,
   lint, type-check, build, format, finding-registry, and security-audit gates with
   memory-safe controlled parallelism.
6. Request a fresh independent security/governance review of the final diff.
7. Push signed commits without bypassing hooks, open the PR, and wait for every
   required protected check to report success on the exact head SHA.

No earlier red or interrupted run is counted as passing evidence. Completion is
based only on fresh command output from the final implementation state.

## Rollout and merge

The branch is pushed normally, with no force push. A PR targets `main` and uses an
allowed security-oriented conventional title. Merge occurs only when:

- the branch is current with `origin/main`;
- all relevant local gates are green on the final tree;
- the independent re-review has no unresolved Important or Critical finding;
- commit signatures and finding trailers validate; and
- `sens-enterprise-summary`, `merge-gate`, `aria-merge-authority`, and
  `build-status` are successful for the PR head.

After merge, the exact `main` SHA and post-merge workflows are verified. Dependency
graph/Dependabot state is re-checked after GitHub re-indexing, and production health
is observed read-only through the repository's normal release evidence. A failed
post-merge deploy or health check is reported as a blocker; it is not hidden by a
manual deployment.

## Acceptance criteria

- Every tracked production or CI-executed lockfile is Dependabot-owned or has an
  explicit, enforced exception and a required audit path.
- Fuzz and both WASM locks are audited inside the current required summary chain.
- E2E-only changes set `has_changes=true` and `deploy_changes=false`.
- Root and AquaMobil updates use one non-overlapping multi-directory authority.
- `nx test hydroponics-module` executes the router regression in jsdom.
- Both WASM builds use committed locks with `--locked` and lock-aware Nx caching.
- Targeted and controlled full verification are green on the final tree.
- The final PR has no unresolved Important/Critical review item and all protected
  checks succeed without bypass.
