# ARIA Operational Proof Continuity Design

- **Date:** 2026-08-28
- **Status:** Approved in chat; awaiting written-spec review
- **Target:** PR #1332 (`fix/kernel-ci-timeouts`)
- **Priority:** P0 integration prerequisite for PR #1333

## Objective

Make `ARIA Operational Proof` prove the real published `aria/state` lineage
while keeping the proof read-only, isolated, and fail-closed. The change must
admit oversized ledger rows only when they are already part of a validated
published prefix, continue rejecting newly appended oversized rows, preserve
diagnostic evidence on failure, and leave the authoritative state branch
untouched.

This is an integration prerequisite rather than a performance optimization.
PR #1332 already fixes the hosted-suite coverage and timeout defects, but it
cannot merge safely until its exact head has a successful operational proof
against the repository's actual durable state.

## Observed Failure

Manual workflow run `33113524069` executed PR #1332's exact head. The full ARIA
suite succeeded, then all 30 observe burn-in attempts aborted on
`state_integrity_gap`. The workflow created a fresh ephemeral tools tree and
acknowledged it as a bootstrap instead of restoring `aria/state`. The committed
daily anchor therefore described a history the proof tree could not descend
from.

Restoring the state branch exposes a second defect. At the current observed
state tip, `tools/runs.jsonl` contains 158 rows, 51 of which exceed the 1 MiB
per-line limit; the largest is 1,488,466 bytes. These rows predate the
writer-side spill fix. They are immutable, hash-chained, published history.
`build_publishable_snapshot` already grandfathers that inherited prefix, but
`verify_state_store` and `_phase_state_continuity` rebuild the same tree without
the prefix counts and reject it as `snapshot_surface_line_too_large:runs.jsonl`.

Two diagnostic defects obscure the same failure path:

- `state compact` has a parser and handler but is omitted from the dispatch set,
  so it falls into snapshot-signature handling and crashes on missing snapshot
  arguments.
- Burn-in's aggregate cycle-ledger summary recognizes only completed and failed
  terminal rows even though the canonical cycle lifecycle also includes stopped
  and aborted rows.

## Safety Invariants

1. `aria/state` is never rewritten, compacted, rebased, force-pushed, or
   published by Operational Proof.
2. The proof job retains `permissions: contents: read` and
   `persist-credentials: false`.
3. Only row counts from the exact published snapshot may grandfather ledger
   lines.
4. Grandfathering applies only to the first `N` rows declared for a surface.
   Every row appended after that prefix remains subject to the 1 MiB limit.
5. Missing, unreadable, damaged, divergent, or unverifiable state fails the
   proof. Operational Proof does not accept bootstrap, genesis, an anchor-only
   reference, or unknown continuity.
6. Canonical restore may materialize the store plus its excluded host binding
   and writer attestation. After that step, burn-in activity writes only to
   deterministic runner-scoped scratch roots; published state surfaces remain
   a read-only reference.
7. A failed burn-in remains a failed job. Artifact preservation must never
   convert failure into success.
8. Uploaded evidence is a curated proof bundle. The restored state store,
   scratch tools tree, and scratch workspaces are never uploaded.
9. No duplicate restore, snapshot, or continuity definition is introduced.

## Decision

Use a shared published-prefix extractor, restore the canonical state store
before burn-in, and make state-branch continuity part of burn-in validity. This
keeps the append-only history intact and makes the existing safety controls
agree at all three call sites.

### Rejected: rewrite or compact the live state branch

Compaction changes hash-chained history and creates a new state lineage
precisely while the proof lane is trying to attest the old one. It introduces
data-loss, replay, and concurrency risk and does not solve the inconsistent
validation contract. The compactor remains an operator capability, but this work
will neither invoke it against the live store nor use it as a prerequisite.

### Rejected: bypass continuity in Operational Proof

Ignoring the committed anchor, fabricating a predecessor, accepting unknown
continuity, or removing `state_continuity` from the burn-in lane would make the
workflow green without proving memory continuity. That is a security-control
bypass, not a fix.

### Rejected: add a second prerequisite PR

The operational proof is the remaining acceptance gate for PR #1332. Splitting
its root fix into a new PR would leave #1332 dependent on code that does not
exist on its head and lengthen the critical ordering chain. The implementation
lands directly in #1332 and is reviewed as one coherent change.

## Architecture

### 1. One published-prefix contract

Extract the inline row-count logic currently owned by
`build_publishable_snapshot` into one helper in `state_store.py`. The helper
accepts a published snapshot and returns a surface-to-row-count map. It admits
only non-negative integers for declared surface entries; booleans, negative
values, and malformed entries are refused rather than coerced.

The helper does not create trust. Its callers establish the trust boundary:

- publication uses the exact predecessor captured from the publication anchor
  and retains the canonical immutable-commit verification before push;
- store verification reads the snapshot at the exact published commit and
  recomputes the bytes it claims;
- state continuity uses only the state-branch reference returned by the
  canonical reference resolver. Daily anchors and absent references receive no
  grandfather map.

The three consumers pass the resulting map to `build_snapshot`:

1. `build_publishable_snapshot` keeps its current inherited-prefix behavior
   through the helper;
2. `verify_state_store` can recompute the already-published tree under the same
   historical policy;
3. `_phase_state_continuity` resolves the reference first, derives counts only
   for `reference_kind=state_branch`, then builds the current probe.

This changes no writer policy. The writer-side artifact spill remains the
prevention mechanism for new oversized rows, and the snapshot limit remains the
independent enforcement mechanism.

### 2. Read-only restore in Operational Proof

The workflow order becomes:

```text
checkout and setup
  -> full ARIA suite and docs/runtime invariant
  -> enterprise preflight
  -> canonical restore-aria-state action
  -> require restored=true and bootstrap absent
  -> verify exact restored store and remote tip
  -> isolated 30-cycle observe burn-in
  -> post-run source-tree check
  -> curated artifact upload (always)
```

The workflow reuses `.github/actions/restore-aria-state`; it does not copy its
checkout or binding logic. No bootstrap acknowledgement is supplied. Since this
repository already has published state, an absent branch, a genesis-only store,
or a restore refusal ends the job.

After restore, a read-only verification step proves all of the following before
burn-in:

- the checked-out store is a valid worktree for this repository;
- its published snapshot recomputes from the exact store bytes;
- its worktree `HEAD` equals the observed remote `aria/state` tip;
- the resolved continuity reference is `state_branch`, not an anchor or no
  reference.

The workflow retains `contents: read`. Its declared network policy adds
`github_git` for the state fetch alongside `github_artifact` for the final
upload. It never obtains write credentials and never calls state publish.

### 3. Isolated burn-in with real lineage

Operational Proof uses deterministic paths so the workflow contract can pin the
exact write surface:

- `$RUNNER_TEMP/aria-operational-proof` for curated proof output;
- `$RUNNER_TEMP/aria-operational-proof-tools` for burn-in scratch state;
- `$RUNNER_TEMP/aria-operational-proof-workspaces` for ephemeral worktrees.

The canonical restore binds `.aria-state-store` to the repository. The burn-in
receives the scratch tools and workspace paths explicitly. Normal observe phases
therefore mutate only scratch data, while `state_continuity` discovers the bound
store and probes its published tools, workspace, and repository roots through
`continuity_probe_roots`.

No copy of the durable state is placed into the scratch tools directory. This
separation proves the lineage without risking a write to the authority being
measured.

Burn-in mode does not invoke `restore_and_replay`. A proof must observe the
exact state it started against, not repair that state during measurement. If the
remote tip moves or continuity becomes critical after preflight, the cycle
records the gap and fails. Other enterprise-cycle modes retain their existing
recovery policy.

### 4. Continuity becomes burn-in acceptance evidence

Each burn-in cycle records the `state_continuity` phase result in its cycle
evidence. A cycle can be counted as valid only when all existing validity checks
pass and continuity has:

- `status == "ok"`;
- `reference_kind == "state_branch"`;
- no blocking result or unresolved recovery.

Unknown, genesis, daily-anchor-only, critical, missing, or malformed continuity
evidence makes that cycle invalid. The report schema and bundle verifier enforce
the new field, so a caller cannot mint a passing report by omitting it.

The general burn-in contract changes deliberately: a burn-in is enterprise
acceptance evidence, and acceptance evidence gathered without a published
state-branch reference must not advance the autonomy ladder. Unit fixtures that
intend to prove success must therefore provide a real validated state-store
reference. Negative fixtures prove that an unbound or anchor-only run cannot
pass.

### 5. Failure-preserving diagnostics

The burn-in shell step captures its exit status without `set -e` discarding the
remaining evidence copy. It copies only files already produced under the bound
burn-in output directory, writes a minimal failure summary when a full report
was not produced, then exits with the original non-zero status.

The artifact upload uses `if: always()` and uploads only
`$RUNNER_TEMP/aria-operational-proof`. DLP and workflow-contract checks continue
to govern that directory. Neither `.aria-state-store` nor either scratch root is
copied into the proof directory.

Success still requires a schema-valid burn-in bundle and proof summary.
Uploading a failure bundle is diagnostic evidence, not an acceptance verdict.

### 6. Reachable operator CLI and accurate lifecycle summary

Add `compact` to the existing state-store command dispatch set so the parser
routes to the existing handler. Test the routing with a scratch tools root and
`--dry-run`; do not invoke the command on the repository's live state.

Make burn-in's aggregate terminal-row recognition use the same canonical
terminal statuses as the cycle lifecycle: completed, failed, stopped, and
aborted. The change affects diagnostics only; stopped and aborted cycles remain
invalid acceptance cycles.

## Workflow Governance

`workflow_contract_registry.py` remains the single workflow-contract source. The
Operational Proof contract will pin:

- preflight before restore;
- restore before store verification and burn-in;
- burn-in before postflight and upload;
- `.aria-state-store` for canonical restore materialization and host binding;
- `.aria-state-store.writers.jsonl` for the canonical local-writer attestation;
- the deterministic proof, scratch-tools, and scratch-workspace directories
  under `RUNNER_TEMP`;
- exact `contents: read` permissions;
- exact `github_artifact` and `github_git` network policy;
- the canonical shared restore action as the sole restore implementation;
- no publish step or write credential;
- an always-running artifact upload whose path is only the curated proof
  directory.

`aria-single-restore-path.spec.ts` will model Operational Proof as a read-only
state consumer. It must use the shared restore action but is not added to the
state-carrying publisher set and is not required to have a publish gate.

## Failure Matrix

- Missing or genesis-only state branch: restore/proof fails; bootstrap is not
  accepted.
- Missing, malformed, or tree-drifted store snapshot: verification fails before
  burn-in.
- Store `HEAD` differs from the remote tip: proof fails and reports both SHAs.
- Remote tip moves during burn-in: the cycle fails; proof does not recover or
  change its reference.
- Published prefix contains an old oversized row: verify and continuity accept
  that prefix.
- A row after the published prefix exceeds 1 MiB: snapshot construction fails
  closed.
- Continuity is unknown or anchor-only: the cycle is invalid and burn-in cannot
  pass.
- Continuity is critical: the cycle aborts and burn-in cannot pass.
- Burn-in fails before a full report: curated failure evidence uploads and the
  job remains red.
- Artifact upload fails: the job remains red.
- A stopped or aborted cycle has a canonical terminal row: diagnostics do not
  report a false missing-terminal defect.

## Test Strategy

Implementation follows London-school TDD and starts with failing tests.

### Published-prefix tests

Extend the real-git fixtures in `test_snapshot_line_grandfather.py` to prove:

1. publish accepts an inherited oversized line;
2. `verify_state_store` accepts the same exact published tree;
3. `_phase_state_continuity` reports `ok` for that restored tree;
4. every consumer rejects an oversized line appended after the published prefix;
5. malformed or untrusted prefix counts do not grant an exemption.

### Burn-in tests

Extend burn-in and CLI tests to prove:

1. a cycle with `ok/state_branch` continuity can count as valid;
2. unknown, genesis, daily-anchor, critical, missing, and malformed evidence
   cannot count;
3. a real restored-state fixture can produce a passing burn-in report;
4. aborted and stopped terminal rows are recognized but never counted as valid;
5. burn-in mode never invokes state recovery when continuity blocks;
6. `state compact --dry-run` reaches the compact handler.

### Workflow tests

Extend the Python workflow-preflight and TypeScript invariant suites to prove:

1. the canonical restore is present exactly once and ordered after preflight;
2. verification precedes burn-in;
3. no bootstrap acknowledgement, publish step, or write permission exists;
4. permissions, network access, paths, and step order equal the registry
   contract;
5. a burn-in failure still reaches artifact upload and preserves the failing
   exit code;
6. only the curated proof directory is uploaded;
7. the workflow's exact 90-minute job budget remains enforced.

### Verification layers

Run, in order:

1. targeted Python and TypeScript tests for each RED/GREEN slice;
2. the complete ARIA package suite;
3. ARIA docs/runtime SSoT invariants;
4. `nx affected --target=test`;
5. `nx affected --target=lint`;
6. independent code review and correction loop;
7. exact-head GitHub Actions;
8. exact-head manual `ARIA Operational Proof` with an accepted artifact bundle.

## Finding Traceability

Before implementation commits, register `ARIA-HIGH-023` for the Operational
Proof bootstrap/continuity defect and `ARIA-MEDIUM-024` for the terminal-summary
mismatch. The existing `ARIA-HIGH-017` finding remains the traceability anchor
for the inconsistent published-prefix handling, and `ORPHAN-HIGH-798` remains
the anchor for the unreachable compact command. Each fix commit closes only the
finding its change resolves.

## Integration Sequence

1. Implement and verify this design on PR #1332's isolated worktree.
2. Commit and push each coherent change to the existing PR branch without
   force-push.
3. Require all checks for the exact PR head to finish green.
4. Dispatch Operational Proof for that exact SHA and require a passing,
   hash-verified artifact.
5. Merge #1332 through protected GitHub controls.
6. Merge the resulting `main` normally into PR #1333; do not rebase, transplant,
   or cherry-pick.
7. Require #1333's exact-head checks and protected merge.
8. Continue the Aquamobil integration plan from the now-valid main baseline.

## Non-goals

- Sharding the ARIA suite or adding a new performance workflow.
- Rewriting, pruning, or compacting live `aria/state` history.
- Weakening the snapshot line cap.
- Publishing state from Operational Proof.
- Adding another restore implementation.
- Bypassing branch protection or merging on partial/cancelled checks.

## Acceptance Criteria

The design is complete only when all of the following are true:

- old oversized rows in the validated published prefix pass publish,
  verify-store, and continuity;
- a newly appended oversized row fails every applicable path;
- Operational Proof restores the exact state tip with read-only authority;
- burn-in cannot pass without `ok/state_branch` continuity evidence;
- burn-in cannot repair or advance the durable store during proof;
- failed proofs upload curated diagnostics and remain red;
- no state or scratch data is uploaded or published;
- compact dispatch and lifecycle summaries are behaviorally correct;
- local, hosted, and manual exact-head proof gates all pass;
- #1332 and then #1333 merge through protected `main` in that order.
