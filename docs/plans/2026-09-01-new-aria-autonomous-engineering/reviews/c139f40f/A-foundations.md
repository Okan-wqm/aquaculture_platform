<!-- markdownlint-disable MD013 MD033 -->
<!-- Historical review text preserves long evidence tokens and placeholders. -->

# Fresh D0 adversarial review — Panel A / foundations

## Verdict

`CHANGES_REQUIRED`

Exact corrective bytes contain no legacy/product edit and the current 88/72/9 data is internally consistent,
but the committed verifier can still return green for several coordinated mutations that violate its normative
source, history, and twelve-role contracts. Those are false-admission paths under `APP-P1-001..003`; therefore
D0 cannot be admitted from this head.

## Immutable target confirmation

- Base: `eeb401131260fe45f3f60be55fa25d023a082d18`.
- Reviewed HEAD: `c139f40f69f77c628f0794146a20cb51818bb03d`.
- Local HEAD and `origin/docs/new-aria-autonomous-engineering-plan` both resolved to that SHA.
- Tracked worktree state was clean.
- Corrective diff package SHA-256: `ea3c1ab64e89c977e7e660d3c9ba4b31521fa74f6e032eb7da1ca6fb0dac9bfa`.
- Full diff package SHA-256: `7184bc32ce7e882dfd7d35a7ec853b1ef807c8dd7f3c4318a905b3104bba44d1`.
- Direct `base..head` path inspection found zero changes under legacy ARIA, legacy workflow/state,
  `apps/aria-service`, or `web/modules/aria`. The full diff contains 80 files, all in the authorized D0
  documentation/design/format-manifest surface.
- `D0-plan-materialization.json` has no `c6065d6d..c139f40f` diff. The first four event bytes remain 3,266
  bytes with SHA-256 `843c22890cf8527a1d486025acbb75c13e81ee3edd039bd1761fcc01661de594`; event 5 is a
  `CHANGES_REQUIRED`, `VERIFYING -> VERIFYING`, non-admission event.
- All 12 tracked `.raw` report digests matched their controller scratch originals. Reader-view provenance also
  passed the committed verifier.

## Binding-root disposition

| Root         | Result                    | Basis                                                                                                                                                       |
| ------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP-P1-001` | **FAIL**                  | A-HIGH-001 and A-HIGH-002                                                                                                                                   |
| `APP-P1-002` | **FAIL**                  | A-HIGH-003                                                                                                                                                  |
| `APP-P1-003` | **FAIL**                  | A-HIGH-002 and A-HIGH-003                                                                                                                                   |
| `APP-P1-004` | PASS at D0 contract level | Independent named issuers, exclusive KMS/procedure capabilities, exact 3-of-3 medium quorum, bound envelopes, direct-insert/self-issue denial are explicit. |
| `APP-P1-005` | PASS at D0 contract level | Human, repository/workspace, and workload identities have one typed binding and lifecycle invalidation model.                                               |
| `APP-P1-006` | PASS at D0 contract level | Eight roles and CLI children have host/UID/mount/secret/RPC/egress/capability/resource/fence requirements plus a complete request envelope.                 |
| `APP-P1-007` | PASS at D0 contract level | Cleanup is supervisor-owned opaque-volume destruction or handle-relative no-symlink teardown; raw recursive fallback is forbidden.                          |

## Findings

### A-HIGH-001 — Full verifier does not bind the committed target or committed scope

- **Mapped root:** `APP-P1-001`.
- **Severity:** HIGH — a clean commit containing a forbidden legacy/product edit is invisible to the command
  that claims to enforce the D0 scope.
- **Evidence:**
  - `verification/verify-d0.mjs:7-22` accepts only repo root and mode; it accepts no immutable base or head
    target and never asserts `HEAD`.
  - `verification/lib/verify.mjs:63-77` derives changed paths solely from `git status --porcelain`.
  - `verification/lib/verify.mjs:119-131` sends that working-tree list to `verifyScope`; it never computes
    `git diff <base>..<head>`.
  - `verification/lib/verify-provenance.mjs:22-29` inventories the plan tree plus design only. It does not
    bind `tools/quality/format-scope.json`, the base/head commit, tree, or reviewed diff.
  - `verification/record-verifier-inputs.mjs:25-47` records argv/runtime/input digests but no base/head/diff
    identity.
- **Observed failure path:** the exact clean corrective head has 80 committed `base..head` paths, while
  `git status --porcelain` is empty; nevertheless the full verifier prints PASS. If a forbidden path were
  committed alongside unchanged plan bytes, this scope check would see the same empty status and pass. The
  current head's forbidden-path diff was independently checked and is empty; this is an enforcement defect,
  not an allegation that legacy ARIA changed now.
- **Narrowest correction:** require exact `--base-sha` and `--head-sha`, assert `HEAD == head`, verify
  canonical ref/reachability, derive scope from `git diff --name-status base..head`, and bind the
  commit/tree/full-diff digest plus every allowed out-of-plan artifact (including format scope) in verifier
  provenance. Add a temporary-repository negative where a forbidden change is committed and the working tree
  is clean.

### A-HIGH-002 — History/review validation accepts semantically invalid but rehashed evidence

- **Mapped roots:** `APP-P1-001`, `APP-P1-003`.
- **Severity:** HIGH — hash self-consistency can be mistaken for a legal transition and a complete twelve-role
  review.
- **Evidence:**
  - `verification/lib/verify-history.mjs:130-167` checks event ID/hash/evidence digest and only a few tail
    fields; it never requires `event.from_state == previous.to_state`, applies a transition table, or
    validates a closed event schema.
  - `verification/lib/verify-history.mjs:100-128` checks `reports.length === 12`, but not the exact role
    roster, role uniqueness, principal uniqueness, report uniqueness, capability match, conflict graph,
    oracle, dissent, or appellate-role identity.
  - `verification/lib/canonical.mjs:27-33,94-100,120-127` accepts lexical float/exponent encodings when they
    parse to an integer. This contradicts the normative float rejection at
    `authority/verification-evidence.md:20-28`.
  - `verification/test-negative-controls.mjs:28-155,157-168` has no illegal-transition or duplicate
    review-role mutant and tests only non-integral `1.5`, not `1.0`/`1e0`.
- **Observed hostile controls:**
  1. In a temporary byte copy, event 5 `from_state` was changed from `VERIFYING` to `READY` and its event hash
     recomputed. `verifyHistory(...)` returned `[]`.
  2. In a separate temporary copy, the identity report's role was changed to a second `integrity`; the
     evidence and event digests were recomputed. `verifyHistory(...)` returned `[]`.
  3. `parseStrictJson('{"a":1.0}')` and `parseStrictJson('{"a":1e0}')` both returned `{a: 1}`; `1.5` alone was
     rejected.
- **Narrowest correction:** enforce a closed event schema and explicit legal state-machine continuity; reject
  decimal-point/exponent number tokens before `JSON.parse`; validate the exact 12-role set and distinct
  principals/report artifacts plus all nine required review fields in each review/gate dossier. Add
  independent negative controls for illegal continuity, duplicate role/principal/report, missing
  oracle/dissent/appellate, and `1.0`/`1e0`.

### A-HIGH-003 — Mapping/gate verification is mutable self-consistency, not exact source truth

- **Mapped roots:** `APP-P1-002`, `APP-P1-003`.
- **Severity:** HIGH — coordinated edits or unknown references can preserve a green 88/72/9 claim.
- **Evidence:**
  - `verification/lib/verify-mapping.mjs:38-50` compares the matrix only with the co-authored
    `frozen-audit.jsonl`; it never reads or blob-digest-binds the canonical audit at commit `85787e610`.
  - `verification/lib/verify-mapping.mjs:53-79` mirrors card finding IDs into `program-map`, but never
    requires those IDs to belong to the exact 001..088 set.
  - `verification/lib/verify-mapping.mjs:82-96` uses optional chaining for owner lookup, silently dropping
    unknown `owned_finding_ids`.
  - `verification/lib/verify-mapping.mjs:99-107` checks only expected `OP-01..08` reverse entries and does not
    reject extra/unknown prerequisite IDs.
  - `verification/lib/verify-mapping.mjs:110-150` validates the exact role array, but validates the nine
    `required_artifacts` by length only. Artifact replacement or duplication remains green.
  - `verification/test-negative-controls.mjs:28-45` mutates only one side of a title and removes one role; it
    does not exercise coordinated source drift, unknown references, or required-artifact substitution.
- **Observed hostile controls:**
  1. The title for `ARIA-AUDIT-001` was forged identically in both the matrix and frozen snapshot.
     `verifyMapping(...)` returned `[]`.
  2. An unknown `ARIA-AUDIT-999` owner was added; another `999` card reference was synchronized into
     program-map; and `distinct_principal` was replaced by `untrusted_placeholder` while preserving array
     length. Together, `verifyMapping(...)` returned `[]`.
- **Current source-truth check:** an independent
  `git show 85787e610:docs/reviews/2026-09-01-aria-full-system-audit.md` parser found 88 headings and zero
  ID/title drift against the committed snapshot. It also confirmed 24 P0 rows with 20 confirmed, partial
  `015/017/044`, and refuted `026`. Current mappings for `015`, `023`, and `076` are corrected. The defect is
  that the promised executable predicate does not preserve those facts against coordinated mutation.
- **Narrowest correction:** give the frozen snapshot immutable metadata containing source commit, path, blob
  SHA, and report digest; have the verifier independently parse that blob. Reject every
  finding/dependency/acceptance/operator reference outside exact closed rosters, reject extras as well as
  missing values, and compare the full ordered `required_artifacts` roster rather than its length. Add the
  hostile controls above.

## APP-P1-004..007 evidence checked

- Issuers and authorization: `authority/identity-authority-tcb.md:64-79`, P04 S28, P07 S50, and P08 S58 name
  separate human/low/medium issuers, exclusive KMS/DB issue paths, exact envelope bindings, atomic consume,
  and 3-of-3 medium quorum.
- Canonical identity: `authority/identity-authority-tcb.md:5-62` binds human issuer/audience/sub/epoch, typed
  provider repository roles and immutable IDs, workspace ownership, certificate/key/VM/UID/job identity,
  rotation, and lifecycle invalidation.
- Confinement: `authority/identity-authority-tcb.md:81-112` and `authority/execution-supply-chain.md:5-50`
  cover all eight roles, CLI children, separate control/worker VMs, credential-socket isolation, resource
  controls, canonical effect envelope, and repeated fence/cancel/recovery checks.
- Cleanup: `authority/execution-supply-chain.md:52-67` removes caller paths as authority, prefers opaque
  VM/volume destruction, and makes fallback handle-relative with mount/inode/lease/child revalidation and no
  recursive deletion.

No additional blocking defect was found in `APP-P1-004..007` at this documentation-contract stage. Their
implementation and live negative proofs remain future sprint gates; this report does not claim those future
controls exist yet.

## Commands and results

```text
git rev-parse HEAD
git rev-parse origin/docs/new-aria-autonomous-engineering-plan
  => both c139f40f69f77c628f0794146a20cb51818bb03d

sha256sum review-c6065d6da..c139f40f6.diff review-eeb401131..c139f40f6.diff
  => ea3c1ab... and 7184bc32... (exact brief values)

node .../verification/verify-d0.mjs --repo-root . --mode full
  => PASS findings=88 sprints=72 gates=9 events=5 state=VERIFYING

node .../verification/render-projections.mjs --repo-root . --check
  => PASS projections=11

node .../verification/test-negative-controls.mjs --repo-root .
  => PASS negative-controls=23

independent source-heading/P0 recomputation
  => headings=88, drift=[], P0=24, confirmed=20, partial=[015,017,044], refuted=[026]

independent hostile mutations (temporary copies, removed after each run)
  => illegal transition: verifyHistory errors=[]
  => duplicate review role with recomputed evidence/event digests: verifyHistory errors=[]
  => coordinated source-title forgery: verifyMapping errors=[]
  => unknown owner/card ID + required-artifact substitution: verifyMapping errors=[]
  => lexical 1.0 and 1e0: accepted
```

The committed green commands therefore establish current self-consistency, but not the exact-source and
false-admission resistance required for D0 approval.
