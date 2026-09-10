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
