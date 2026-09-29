# D0 adversarial review — supply chain, artifacts, and Git engineering

## Verdict

`CHANGES_REQUIRED`

D0 is documentation-only, remains `VERIFYING`, has no protected legacy-path diff, and the reviewed
commit is signed and present at the advertised remote ref. The frozen 88-row mapping is exact. The
program nevertheless permits execution and PR production before it establishes an immutable,
trusted toolchain/dependency environment, and several Git/artifact controls are assertions without
an acceptance path strong enough to prevent substitution. Five P1 issues therefore block approval.

## Findings

### SC-P1-001 — Provider CLIs and their plugin/tool surfaces are observed, not pinned or admitted

- **Evidence:** The broker response merely records `CLI version`
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:168-173`). S20 asks
  for capability/version discovery and records the observed version, but has no allowed-version,
  binary-digest, signer, installer-source, or upgrade-policy check
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P03.md:41-51`). S21 is weaker still:
  its deliverables do not mention version pinning at all
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P03.md:53-63`). The first package/
  runtime manifest appears in S60, after low-risk autonomous merge has already been enabled in P07
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P08.md:41-51`). No card governs
  Codex/Claude plugins, MCP configuration, repository-local hooks/settings, or auxiliary tool
  versions.
- **Severity:** P1 supply-chain security.
- **Consequence:** An auto-updated CLI, substituted binary, newly loaded plugin/MCP server, or
  repository-controlled hook can change commands, tool authority, network behavior, or produced
  bytes while all documented P03 checks still pass because the evidence reports the changed
  version instead of rejecting it. A malicious repository can therefore influence the privileged
  broker/tool surface outside the admitted diff contract.
- **Smallest fix:** Make S20/S21 depend on an operator-owned toolchain manifest that pins broker
  image digest, CLI binary digest/signature and allowed version, installer/source provenance, and
  every enabled plugin/MCP/hook/tool digest. Disable repository-local extension/hook discovery by
  default; permit only explicit TCB entries. Add substituted binary, auto-upgrade, unlisted plugin,
  repository hook/settings, and manifest-downgrade negatives, and bind the manifest digest into
  every broker request/evidence record and the P03 gate.

### SC-P1-002 — Dependency trust and reproducible builds are not a pre-execution/PR gate

- **Evidence:** The 88 mapping promises an “immutable runtime image/package lock digest” and a
  clean-install/cache-key contract for `ARIA-AUDIT-030`
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/FINDING-COVERAGE.md:56`). Its only owners
  are S20/S21, but their cards do not require a lockfile digest, Node/npm version binding, `npm ci`,
  registry/package integrity, lifecycle-script policy, SBOM, or clean image build
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P03.md:41-63`). S22 binds test
  records to source SHA and commands, not to the dependency, image, OS, or toolchain digest
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P03.md:65-75`), and P03 may exit
  immediately afterward
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P03.md:89-99`). The clean-environment/
  package-digest work is deferred to S60, after PR delivery and low-risk merge
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P08.md:41-51`).
- **Severity:** P1 build/supply-chain correctness and security.
- **Consequence:** The same exact source SHA can test and build against stale, poisoned, or simply
  different dependency graphs; package lifecycle code can execute before admission; and a green
  artifact cannot be independently rebuilt. This recreates the inherited stale-dependency failure
  and lets P04/P07 trust evidence whose environment is not part of the claim.
- **Smallest fix:** Before S20/S21 can run, require a hermetic dependency/build manifest containing
  lockfile and workspace-manifest digests, Node/npm and OS/base-image digests, registry/source and
  package-integrity policy, lifecycle-script allowlist, SBOM plus vulnerability/license admission,
  and cache keys derived from all of them. Require clean offline/controlled-network installation
  and two clean rebuilds of the same source to produce the same normalized artifact digest (or a
  documented nondeterminism witness). Add those environment digests to S22 evidence and P03/P04
  gates; make the `ARIA-AUDIT-030` owner cards state the promised control explicitly.

### SC-P1-003 — “Signed commit” has no trusted-signer or mission-binding acceptance contract

- **Evidence:** The branch protocol requires every future commit to be signed
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/PLAN.md:276-283`). S19/S25 attack the
  linked-worktree signing bypass, and the 019 mapping asks only for identical signing behavior plus
  failure when a key is absent
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/FINDING-COVERAGE.md:45`,
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P04.md:5-15`). No sprint requires
  verification of every commit in the exact base..head range against an operator-owned signer
  allowlist, binds the signing key to the mission producer/workspace, or defines key revocation and
  rebase/cherry-pick behavior. S27's pinned attestation envelope is separate from Git commit
  signature verification
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P04.md:29-39`).
- **Severity:** P1 Git provenance/security.
- **Consequence:** A worker can generate its own key, create a cryptographically valid signature,
  and satisfy “signed” without proving an authorized producer made the commit. Mixed signed/
  unsigned ranges, revoked keys, or rewritten commits can reach Publisher admission while the
  independent attestation refers only to the payload/SHA, not the Git signer chain.
- **Smallest fix:** Put the Git signer allowlist, key IDs/fingerprints, subject/workspace binding,
  validity/revocation policy, and permitted signature formats in operator-owned TCB. At S22/S26,
  resolve the exact immutable base..head range without shell interpolation and verify every commit;
  reject unsigned, unknown, expired/revoked, wrong-workspace, mixed-author, and rewritten ranges.
  Bind the verified signer-set digest into the artifact attestation and PR readback evidence.

### SC-P1-004 — CAS admission does not prove post-scan immutability or consume-time integrity

- **Evidence:** The design uploads to quarantine, checks digest/size/DLP, then makes the CAS
  reference visible in a DB transaction (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:157-164`).
  S03 tests orphan/missing objects and restore digest, but not same-key overwrite or post-admission
  mutation (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P01.md:29-39`). S23 records
  the admitted digest and says the artifact becomes visible/effect-ready after admission, but has
  no object-version/object-lock, conditional-create, scanner-policy provenance, or consumer rehash
  requirement (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P03.md:77-87`).
- **Severity:** P1 artifact integrity/security.
- **Consequence:** If the object-store credential, adapter, or bucket policy allows overwrite, bytes
  can change after DLP/policy scanning while Postgres and attestations retain the approved digest.
  A publisher or later oracle can then consume different bytes from those independently admitted;
  the content-addressed key name alone does not prove the fetched content.
- **Smallest fix:** Require conditional create/no-overwrite CAS writes, version ID plus immutable
  retention/object lock (or an equivalently enforced store), and bind object version, byte length,
  media type, digest, scanner binary/rules digest, policy version, and source snapshot into one
  admission record. Every trust-boundary consumer must stream-rehash before use. Add quarantine→
  admission TOCTOU, same-key overwrite, changed object version, corrupt ranged read, scanner update,
  and post-admission mutation tests to S03/S23 and the P03 gate.

### SC-P1-005 — Workspace authorization is built before canonical repository/workspace identity

- **Evidence:** S04 promises canonical repository/workspace subject binding and makes that binding
  part of access control (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P01.md:41-51`).
  The canonical repository/workspace identity is not defined until S09, whose deliverables are
  remote normalization, fork/namespace identity and the workspace registry
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P02.md:5-15`). S04 depends only on
  S03/OP-03, while S09 depends on the entire sealed P01, so the dependency graph cannot implement
  S04 using the later canonical resolver. The coverage authority itself assigns immutable provider
  repository ID/fork namespace/workspace registry to both S04 and S09
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/FINDING-COVERAGE.md:77`).
- **Severity:** P1 repository-identity/authorization correctness.
- **Consequence:** P01 can be sealed with a provisional path/remote-derived workspace identity,
  then S09 can introduce a different canonical identity. Existing allowlists, evidence, artifacts,
  and grants may split or collide across the migration even though each sprint independently
  satisfies its card.
- **Smallest fix:** Move the canonical repository/workspace identity value object and resolver
  contract into S04 (provider/host + immutable provider repository ID as identity; remotes/paths as
  metadata; explicit fork lineage), leaving S09 only onboarding adapters, or move S04 after S09.
  Add one cross-phase invariant proving S04, S09, S10, S19, S26 and S59 consume the exact same
  resolver/schema/version with no compatibility identity or migration fallback.

### SC-P2-006 — Readability/dependency gates have an unauditable generated-file exception

- **Evidence:** The design and PLAN impose `<=250` target and `>400` hard gate, but exempt
  generated files/declarative migrations with only a rationale/split review
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:108-125`,
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/PLAN.md:26-28`). S02 asks for generic
  dependency/file-size rules and a `>400` source fixture, without an exception schema, deterministic
  regeneration check, or a concrete intra-project import-boundary mechanism
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P01.md:17-27`). Because the backend
  is one Nx project, the Nx project graph alone cannot enforce the pictured domain/kernel/
  application/adapter direction inside `apps/aria-service`.
- **Severity:** P2 maintainability and review integrity.
- **Consequence:** A large hand-written or partially generated file can be labeled generated and
  bypass review; a declarative migration can become an unreadable policy/code container; and
  intra-project reverse imports can remain invisible to an Nx project-graph check while still
  satisfying the prose acceptance.
- **Smallest fix:** Define a machine-readable exception manifest with owner, reason, expiry, source
  inputs, generator command/version/digest and deterministic regeneration/drift proof; do not exempt
  migrations from semantic/complexity review. In S02, name and test an AST/import-boundary rule for
  intra-project layers in addition to Nx tags/project edges. Add fake-generated markers, changed
  generator/output, expired exception, oversized migration, barrel/re-export bypass, dynamic import,
  and path-alias reverse-edge fixtures.

## Verified controls and checks

- Frozen audit worktree HEAD is exact `85787e610e26c192c898ffebd4e51ded856cd880` and its commit
  signature verifies locally. A programmatic comparison found exactly 88 unique matrix rows,
  `001..088` without gaps/duplicates, with severity/title byte-for-byte equal to the frozen full
  report. The required P0 dispositions and highlighted 001/013/021/023/056/079/085 controls are
  preserved. The separate owner/acceptance inconsistency for 015 is outside this report's unique
  supply-chain findings but remains present.
- All 12 authority SHA-256 values, the authority-bundle digest
  `38ea8cd82baf3a1479d962c6a6142428c29e878f5799231325cbd11b2fbd6f08`, the evidence-file digest,
  and all four sorted-key canonical event hashes recompute. D0 remains `VERIFYING`; reviewer and
  admission are pending/false and no sprint is falsely `DONE`.
- Reviewed commit `c6065d6dac97306f147de67ef58a96e3a67524ac` has a valid local SSH signature,
  and `git ls-remote` reports the same SHA for
  `refs/heads/docs/new-aria-autonomous-engineering-plan`. This validates this D0 transport event; it
  does not supply the missing future signer/toolchain contracts above.
- The complete changed-file roster is documentation plus generated `tools/quality/format-scope.json`.
  `git diff --check` passes, the protected legacy ARIA/workflow diff is empty, and the generated
  formatter manifest contains the new managed narrative/evidence files. No dependency or product
  file changed in D0.
- Positive plan controls were also checked: immutable tree/diff digests and dirty-worktree
  substitution tests (S10/S22), registered-worktree containment and ref/trailer injection negatives
  (S19/S26), full-scope DLP plus env-assignment/SSRF controls (S23), typed independent attestations
  (S27/S29), exact GitHub base/head readback (S26/S31/S52), and planned file-size/dependency tests
  (S02). The findings above are the load-bearing gaps those controls do not cover.
