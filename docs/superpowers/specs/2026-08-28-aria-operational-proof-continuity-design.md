# ARIA Operational Proof Continuity Design

- **Date:** 2026-08-28
- **Status:** Approved in chat; implementation authorized
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
6. Canonical restore may materialize the store plus its excluded writer
   attestation. Operational Proof selects the action's read-only mode, which
   neither binds the restored tools root to the host nor exports it as the
   runtime tools root. Burn-in activity writes only to deterministic
   runner-scoped scratch roots; published state surfaces remain a read-only
   reference.
7. A failed burn-in remains a failed job. Artifact preservation must never
   convert failure into success.
8. Uploaded evidence is a curated proof bundle. The restored state store,
   scratch tools tree, and scratch workspaces are never uploaded.
9. No duplicate restore, snapshot, or continuity definition is introduced.
10. A passing artifact is accepted only by one canonical outer verifier with a
    closed file set, a final DLP scan, and exact SHA/run ID/run
    attempt/continuity/immutability bindings. Human inspection is supplementary
    evidence, not the gate.

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
`build_publishable_snapshot` into one helper beside
`validate_snapshot_manifest` in `state_snapshot.py`. The helper validates the
complete manifest before reading any claim, then returns a
surface-to-row-count map. It preserves each already-validated string key
exactly and admits only non-negative integer row counts for declared ledger
surfaces. Booleans, negatives, missing counts, unknown surfaces, malformed
claims, and top-level drift retain the validator's canonical `SnapshotError`
semantics rather than being converted into a publication-only refusal class.

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
Persist enterprise workflow preflight
  -> Restore ARIA state from the aria/state branch
  -> Require published ARIA state restore
  -> Verify restored ARIA state reference
  -> Run observe burn-in proof
  -> Verify post-run source and state immutability (always)
  -> Write ARIA operational proof manifest (always)
  -> Scan staged ARIA operational proof for secrets (always)
  -> Verify complete ARIA operational proof (always)
  -> Upload ARIA operational proof (always)
```

The workflow reuses `.github/actions/restore-aria-state`; it does not copy its
checkout logic. The shared action gains a default-on `bind-tools-root` input so
the two publishing lanes retain their current binding behavior. Operational
Proof passes `bind-tools-root: 'false'`, which skips both host binding and the
durable-tools environment export. No bootstrap acknowledgement is supplied.
Since this repository already has published state, an absent branch, a
genesis-only store, or a restore refusal ends the job.

This read-only action mode is load-bearing. The existing host binding writes an
excluded `repo_identity.json`, appends `tools_root_bound_to_host` to published
`governance.jsonl`, and updates the tools integrity index. Running that binding
before verification would change the bytes being measured. The proof therefore
uses the canonical checkout transaction without making the restored tree a
writable runtime tools root; publishing lanes continue using the action's
default binding mode.

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
The action validates literal `true|false` binding mode before checkout, the
checkout step retains all five outputs without binding or `GITHUB_ENV`, and a
separate exact-condition step binds only for default-on writer consumers.
Operational Proof is the read-only consumer; invalid input cannot leave a
store, worktree registration, checkout verdict, or writer attestation.

### 3. Isolated burn-in with real lineage

Operational Proof uses deterministic paths so the workflow contract can pin the
exact write surface:

- `$RUNNER_TEMP/aria-operational-proof` for curated proof output;
- `$RUNNER_TEMP/aria-operational-proof-tools` for burn-in scratch state;
- `$RUNNER_TEMP/aria-operational-proof-workspaces` for ephemeral worktrees.

The canonical restore materializes `.aria-state-store` as a worktree of the
repository without binding its tools root to the host. The burn-in receives the
scratch tools and workspace paths explicitly. Normal observe phases therefore
mutate only scratch data, while `state_continuity` discovers the store by its
canonical repository-relative location and probes its published tools,
workspace, and repository roots through `continuity_probe_roots`.

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
- `blocks_action is False`;
- `recovery is None`.

Unknown, genesis, daily-anchor-only, critical, missing, or malformed continuity
evidence makes that cycle invalid. The report schema and bundle verifier enforce
the new field, so a caller cannot mint a passing report by omitting it.

Every cycle row initializes `state_continuity` to `None`, then a normal cycle
return records the curated continuity immediately before status
classification. This retains observations for completed, stopped, aborted, and
failed returns while an exception before return remains explicit `None`.

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

Success still requires a schema-valid burn-in bundle and the focused
`aria_kernel.operational_proof` module's strict
`aria/operational-proof-manifest/v1` outer manifest. The manifest is
`operational-proof-manifest.json`; it binds target SHA, workflow run ID and
attempt, hash and size of every other staged file, and direct hashes for the
initial state, postflight state, and burn-in report. The writer measurement
uses the public `state_writer_attestation_path(store)` helper, which the writer
also consumes.

The success file set is exactly:

```text
workflow-preflight.json
state-store-verification.json
cycles.json
cycle-ledger-summary.json
disallowed-actions.json
manifest-tail-hashes.json
candidate-detection.json
autonomy-burn-in-report.json
evidence-bundle.json
postflight-verification.json
operational-proof-manifest.json
```

Failed diagnostics may add only `proof-failure-summary.json`,
`failure-report.json`, and the bounded
`failures/burnin-observe-YYYYMMDDTHHMMSSZ-NNN.json` pattern, and can never
verify as success. Enumeration rejects symlinks, non-regular files, traversal,
missing success files, and unexpected paths regardless of manifest claims.
After manifest writing, a separate final DLP step scans every file including
the manifest; the verifier scans again and no writer follows DLP except upload.
It binds and compares initial/final state tip, store HEAD, snapshot ID/root,
writer-attestation hash and size, source/store cleanliness, and absent host
identity. The same verifier runs inside Actions and on the downloaded artifact.
Uploading a failure bundle is diagnostic evidence, not an acceptance verdict.

### 6. Reachable operator CLI and accurate lifecycle summary

Add `compact` to the existing state-store command dispatch set so the parser
routes to the existing handler. Test the routing with a scratch tools root and
`--dry-run`; snapshot every directory and file under that real scratch tools
tree before and after so an added archive or derivative is detected. Do not
invoke the command on the repository's live state. Append the dispatch proof to
the existing `ORPHAN-HIGH-798` narrative so closing the finding records both
its write-time compactor and its formerly unreachable CLI surface.

Make burn-in's aggregate terminal-row recognition use the same canonical
terminal statuses as the cycle lifecycle: completed, failed, stopped, and
aborted. The change affects diagnostics only; stopped and aborted cycles remain
invalid acceptance cycles.

## Workflow Governance

`workflow_contract_registry.py` remains the single workflow-contract source.
Replace the loose permission, step, action, and upload fields across every
registry entry with one typed representation:
`WorkflowPermissionRequirement`, `WorkflowStepRequirement`,
`WorkflowActionRequirement`, and `WorkflowUploadRequirement`.
`WorkflowJobContract` owns exactly one permission requirement, one optional
upload, and tuples of steps/actions while `step_order` remains the graph edge
list. `docs_ssot.py` consumes retention from the typed upload without changing
generated output. There is no additive duplicate representation.

Conditions compare after whitespace collapse and removal of one `${{ ... }}`
wrapper; run-marker scans ignore comment-only lines. Permissions are exact and
upload verification rejects missing, duplicated, extra, unpinned, wrongly
conditioned, wrongly named, or wrongly pathed uploads. The Operational Proof
contract will pin:

- preflight before restore;
- restore before store verification and burn-in;
- burn-in before postflight, manifest writing, final DLP, strict verification,
  and upload;
- postflight before final DLP/outer verification, and final verification before
  upload;
- `.aria-state-store` for canonical restore materialization;
- `.aria-state-store.writers.jsonl` for the canonical local-writer attestation;
- the deterministic proof, scratch-tools, and scratch-workspace directories
  under `RUNNER_TEMP`;
- exact `contents: read` permissions;
- exact `github_artifact` and `github_git` network policy;
- the canonical shared restore action as the sole restore implementation;
- `bind-tools-root: 'false'` for Operational Proof while publishing lanes retain
  the action's default-on binding;
- no restored-store environment export into the proof's runtime tools binding;
- no application `.git` allowlist, publish step, write credential, executable
  `state publish`, `publish_state(`, `bind-tools-root`, or `GITHUB_ENV` outside
  the canonical action; Git/worktree and runner command-file writes remain
  platform-controlled capabilities;
- always-running postflight, manifest writer, final DLP, strict verifier, and
  artifact upload whose path is only the curated proof directory;
- exactly one SHA-pinned upload, `if: always()`, artifact name bound to the
  target SHA, `if-no-files-found: error`, and 365-day retention;
- the closed Operational Proof success-file allowlist and canonical verifier;
- initial/final state tip, store HEAD, writer hash/size, source/store
  cleanliness, and absence of `tools/repo_identity.json`;
- a clean final DLP scan of every staged file before upload.

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
- An extra, missing, changed, unhashed, or DLP-positive proof file: the outer
  verifier refuses success.
- State tip, store HEAD, or writer-attestation hash/size changes during burn-in:
  postflight and the outer verifier refuse success.
- A host-bound `tools/repo_identity.json` appears in the restored store:
  postflight and the outer verifier refuse success.
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
7. postflight and final DLP/outer verification run on failed burn-in;
8. the success verifier rejects every mutation of its exact SHA, run ID, run
   attempt, continuity, cleanliness, writer, host-identity, file-set, hash, and
   DLP fields;
9. the workflow's exact 90-minute job budget remains enforced.

### Verification layers

Run, in order:

1. targeted Python and TypeScript tests for each RED/GREEN slice;
2. the complete ARIA package suite;
3. ARIA docs/runtime SSoT invariants;
4. `nx affected --target=test`;
5. `nx affected --target=lint`;
6. independent code review and correction loop;
7. exact-head GitHub Actions whose nonempty required set exactly equals the
   live app-bound protection contract and has exact `SUCCESS` state;
8. a wall-clock-bounded manual `ARIA Operational Proof` with exactly one new
   exact-head attempt, one immutable artifact ID whose GitHub digest matches
   the downloaded archive, and a bundle that passes the canonical verifier;
9. a full immediate pre-merge recheck and protected merge guarded by exact
   local/remote/PR equality, clean merge state, absent auto-merge, preserved
   remote branches, and `--match-head-commit`.

## Finding Traceability

Before implementation commits, register `ARIA-HIGH-024` for the Operational
Proof bootstrap/continuity defect and `ARIA-MEDIUM-025` for the terminal-summary
mismatch. The existing `ARIA-HIGH-017` finding remains the traceability anchor
for the inconsistent published-prefix handling, and `ORPHAN-HIGH-798` remains
the anchor for the unreachable compact command. Each fix commit closes only the
finding its change resolves.

## Integration Sequence

1. Implement and verify this design on PR #1332's isolated worktree.
2. Commit and push each coherent change to the existing PR branch without
   force-push.
3. Assert local, remote, and PR head equality; validate the live nonempty
   strict/admin/app-bound required-check contract; and accept only its exact
   names with exact `SUCCESS` state.
4. Snapshot run IDs, dispatch once, and under a wall-clock deadline require
   exactly one new exact-SHA attempt-1 run. Pin the attempt before and after the
   watch. Select exactly one current artifact by immutable ID, verify its
   GitHub-reported digest, then run the canonical outer verifier.
5. Immediately repeat every head/check/run/artifact/verifier gate, require PR
   state `OPEN/MERGEABLE/CLEAN`, no auto-merge, merge commits enabled, and
   automatic branch deletion disabled. Merge #1332 with
   `--match-head-commit`, accept only immediate `MERGED`, and prove main
   ancestry plus remote-branch preservation.
6. In the exact clean #1333 worktree, prove both PR topologies and #1332's
   ordinary merge parentage. Fetch `main` by exact refspec, bind it to the live
   remote, close local/remote/API race windows, and require a true divergent
   topology before `--no-commit` merge.
7. Inventory conflicts, route every path through root/nested guidance, and
   stage all authored resolutions before generators enumerate tracked paths.
   Preserve the semantic `CURRENT_STATE.md` body, regenerate format scope and
   authority hash, verify the latter with `--check`, and create an explicit
   ordinary two-parent merge commit.
8. Run affected test and lint against both exact merge parents, close the
   pre-push race, push without force, compare #1333's complete exact required
   set, close the `main` race, and protected-merge with
   `--match-head-commit`. Prove two-parent result topology, ancestry, clean
   retained worktree, and remote-branch preservation.
9. Stop and hand control to
   `docs/superpowers/plans/2026-08-26-aquamobil-v4-safe-integration-program.md`,
   Task 1 Step 0. Do not create evidence, a coordinator worktree, Order 0
   state, or a slice before that program's protected-bootstrap step passes.

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
- local and hosted gates pass against the exact nonempty app-bound required set;
- one unambiguous manual run attempt and one immutable artifact ID/digest pass
  the exact-head canonical proof verifier;
- #1332 and then #1333 merge through protected `main` in that order with both
  remote branches preserved;
- Task 7 stops at the verified #1333 result and hands off to the Aquamobil
  program's protected Task 1 Step 0.
