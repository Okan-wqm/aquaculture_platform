# D0 Architecture Corrective Round 3

Status: remediation authored in the D0 plan/verifier boundary; it is not an admission record and
does not close D0 before a fresh exact-head external review.

## D0-ARCH-P1-001

The target gate trusted an externally signed base/head declaration without cryptographically
verifying every introduced commit, and its path policy could omit a newly introduced plan artifact.
That allowed an unsigned commit and an unclassified `plan/rogue.ts` to avoid independent,
load-bearing denials.

The corrective predicate is now shared by target, provenance and readability verification:

- every tracked old/new plan-tree entry is classified, including deleted paths and same-path mode
  changes; only regular `100644` blobs in the closed extension set and the two exact
  `.gitattributes` paths are accepted;
- control/DEL/bidirectional path characters, unknown or disguised code/config extensions,
  executables, symlinks and other object modes fail closed;
- every accepted artifact except the self-referential verifier-input manifest participates in the
  provenance roster/digest, while every accepted authored `.mjs` participates in readability
  limits and dependency analysis;
- every commit in `base..head`, including merges, must have exactly one valid Ed25519 SSHSIG under
  the signed `git` namespace/hash policy. Raw commit bytes and raw parent headers determine the
  SHA-1-verified closure; shallow/graft/promisor/alternate metadata is denied, lazy fetch is disabled,
  and Git commit-graph acceleration is ignored;
- the declared signer set must equal the used set. Capability, repository, program, principal,
  active status, current revocation epoch and validity window are operator-signed; operator and
  committer keys/principals must differ, the observation must match the trusted clock within bounded
  skew, and every signed commit timestamp must be in-window and no later than observation;
- scope is evaluated on every relevant raw-parent edge, so a protected/product edit followed by an
  exact revert remains denied. A merge with a parent in the raw base closure compares against that
  safe parent, avoiding false positives from newer-main product bytes.

### TDD evidence

RED:

- `node verification/test-target-controls.mjs` failed because the signed unsigned-commit plus
  `rogue.ts` mutant did not produce both `D0_ARTIFACT_POLICY` and `COMMIT_SIGNATURE`.
- `node verification/test-target-artifacts.mjs` demonstrated acceptance of a C0 path and acceptance
  of a base-symlink to head-regular same-path type change before their respective fixes.
- `node verification/test-repository-integrity.mjs` showed a signed merge with an unsigned hidden
  parent was accepted after a shallow marker (`actual []`, expected `TARGET_SHALLOW`).
- `node verification/test-transient-scope.mjs` showed a signed workflow add+revert sequence was
  accepted (`actual []`, expected `PROTECTED_SCOPE`).

GREEN:

- `node verification/test-target-artifacts.mjs` ->
  `PASS target-artifacts paths=closed plan-tree=enumerated`.
- `node verification/test-commit-signatures.mjs` ->
  `PASS commit-signatures unsigned=denied forged=denied signer-set=exact`; isolated controls cover
  unsigned, forged, wrong-key, trailing/malformed SSHSIG, declared-but-unused signer, and
  operator/committer key reuse.
- `node verification/test-commit-policy.mjs` ->
  `PASS commit-policy identity=bound validity=bound revocation=bound`; controls include same
  principal/different key, wrong repository/program, expired/revoked/stale epoch, out-of-window
  commit and future observation.
- `node verification/test-repository-integrity.mjs` ->
  `PASS repository-integrity shallow=grafts=promisor=denied raw-commit-graph=verified`; controls
  include linked-worktree common-dir resolution and a valid-checksum tampered commit graph.
- `node verification/test-hermetic-git.mjs` ->
  `PASS hermetic-git path=digest-pinned env=scrubbed config=neutralized`; a missing promised blob
  cannot launch the poisoned upload-pack marker helper.
- `node verification/test-transient-scope.mjs` ->
  `PASS transient-scope reverted=denied newer-main-merge=accepted`.
- `node verification/test-readability-dependencies.mjs` -> `PASS readability-dependencies`; all
  authored verification modules remain at or below 250 lines.

## D0-ARCH-P1-002

Merging a newer protected `main` left the target manifest pinned to its previous base. The exact
fresh-clone command therefore treated imported main commits as D0-authored commits. Its test
fixture then decoded a GitHub PGP armor payload as SSHSIG without checking the armor, magic,
version or string bounds, producing an untyped `ERR_OUT_OF_RANGE` instead of a closed rejection.

The manifest is re-pinned to the merge's exact protected-main parent and its provenance is
regenerated. The fixture now rejects missing/non-SSH armor, invalid SSHSIG magic/version, truncated
strings and non-canonical Ed25519 key blobs deterministically. A PGP-armored mutant first reproduced
the range error and now proves the typed denial; imported main commits are outside `base..head`.

### Remaining risk

The new SSHSIG implementation intentionally accepts only canonical Ed25519/`git`/SHA-512 policy.
The final projection/provenance regeneration and full canonical D0 command must pass on the exact
remediation tree; a fresh external review must still re-evaluate that exact committed head.

## D0-ARCH-P1-003

Historical event rows and the evidence/report bytes they reference were checked only against the
current checkout. A later commit could therefore rewrite or delete already-published review history
and make the mutable replacement look canonical.

The verifier now finds each event's introducing commit in the reviewed head's Git history and
compares the exact event row, evidence manifest, report and source-report bytes with that anchor.
Missing rows, paths, non-regular blobs, duplicate event identities and bounded-roster violations
fail closed.

### TDD evidence

RED: `node verification/test-event-controls.mjs` accepted Git fixtures that rewrote an introduced
event, evidence manifest, rendered report or source report, or deleted an introduced event.

GREEN: `node verification/test-event-controls.mjs` -> `PASS event-controls`; the clean fixture is
accepted and all five historical mutants are rejected by the production history verifier.

### Remaining risk

The history walk is deliberately bounded to 64 event-file revisions, 512 events and 64 reports per
manifest. Exceeding a bound fails closed and requires a versioned policy change; a fresh external
review must still authorize the exact candidate head.

## D0-ARCH-P1-004

The historical `prettier-markdown-v1` review evidence was replayed with the current v2 preamble and
arguments. That rewrote the meaning of an already-published transform and caused valid historical
evidence to fail after formatter-policy evolution.

Transform IDs now select exact, closed v1 or v2 profiles. Each profile binds its own schema,
arguments, preamble and runtime inputs; unknown and prototype-chain IDs, mixed fields and path drift
are rejected before execution.

### TDD evidence

RED: `node verification/test-review-evidence-controls.mjs` rejected the unmodified historical v1
package because it was forced through the v2 transform profile.

GREEN: `node verification/test-review-evidence-controls.mjs` ->
`PASS review-evidence-controls=12`; current v1/v2 evidence passes while unsupported-generation,
prototype-ID, config-path and schema mutants fail closed.

### Remaining risk

Only the two enumerated transform generations are supported. A future formatter generation must use
a new transform ID and explicit profile; silently changing either historical profile remains denied.

## D0-ARCH-P1-005

The signed commit-policy observation allowed 900 seconds of local-clock skew. That window was wider
than required for D0 admission and unnecessarily extended replay of otherwise valid authority.

The closed boundary is now 30 seconds in either direction. Exactly minus/plus 30 seconds is accepted;
minus/plus 31 seconds and 600 seconds is rejected.

### TDD evidence

RED: `node verification/test-commit-policy.mjs` accepted the 31-second and 600-second past/future
observation controls under the former 900-second allowance.

GREEN: `node verification/test-commit-policy.mjs` ->
`PASS commit-policy identity=bound validity=bound revocation=bound`; all four out-of-window controls
are denied and both exact-boundary controls pass.

### Remaining risk

Freshness still depends on the verifier host's trusted clock. Slow verification intentionally fails
closed once authority ages past the boundary and requires a fresh signed observation; test fixtures
freeze their clock so host contention cannot select a different assertion path.

## D0-TEST-P1-006

Tightening the production observation skew exposed two wall-clock-dependent integration fixtures.
They minted a target authority and then performed many real cryptographic/Git checks. On a contended
host the authority aged past 30 seconds before a later mutant, so the test observed a valid
fail-closed freshness error instead of exercising the mutant's intended rejection branch.

The readback fixture now fixes the clock independently for each case, and the target-control test
fixes it for its single authority lifecycle. Both restore the real `Date.now` function in `finally`;
production code and the 30-second policy are unchanged.

### TDD evidence

RED: the first full `node verification/run-d0-suite.mjs` run stopped at
`test-delivery-readback-races.mjs:70`: expected `changed during verification`, received
`commit signer operator observation is not current`. After fixing that fixture, the next full run
stopped at `test-target-controls.mjs:237`: expected `TARGET_BASE_TREE`, received the same freshness
error.

GREEN:

- `node verification/test-delivery-readback-races.mjs` ->
  `PASS delivery-readback-races mutants=6`;
- `node verification/test-target-controls.mjs` ->
  `PASS target-controls external-signature=required empty-range=denied`.

### Remaining risk

The full suite remains CPU- and scheduler-intensive on the shared host. Deterministic fixture clocks
prevent favorable assertion-path selection; they do not make the suite faster and do not authorize
stale production observations.
