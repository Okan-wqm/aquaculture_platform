<!-- markdownlint-disable MD013 MD033 -->
<!-- Historical review text preserves long evidence tokens and placeholders. -->

# Fresh D0 adversarial review — Panel B (platform)

## Verdict

`CHANGES_REQUIRED`

Reviewed exact committed target:

- base: `eeb401131260fe45f3f60be55fa25d023a082d18`
- prior head: `c6065d6dac97306f147de67ef58a96e3a67524ac`
- corrective head and remote: `c139f40f69f77c628f0794146a20cb51818bb03d`
- corrective diff SHA-256: `ea3c1ab64e89c977e7e660d3c9ba4b31521fa74f6e032eb7da1ca6fb0dac9bfa`
- full diff SHA-256: `7184bc32ce7e882dfd7d35a7ec853b1ef807c8dd7f3c4318a905b3104bba44d1`

The corrective head materially improves all assigned surfaces, but six P1 contract gaps still permit an unsafe
or non-implementable interpretation. A P2 verifier-concurrency defect also matters because the required
twelve-panel review is deliberately parallel. I made no tracked edit, commit, push, or legacy/product-path
change; this ignored scratch report is the only authored file.

## Findings

### B-P1-001 — Permit issuers are named as independent services but have no enforceable placement or workload boundary

- **Maps to:** `APP-P1-004`, and undermines `APP-P1-011` / `APP-P1-015`.
- **Evidence:**
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/authority/identity-authority-tcb.md:64-79` defines
  three issuer names and exclusive KMS/procedure capabilities, but only says the issuer services are outside
  the eight runtime roles. The enforceable host/UID/mount/secret/RPC/egress/ resource manifest and
  pairwise-collision gate at the same file's `81-102` enumerates only those eight roles. S28/S50/S58 call the
  issuers “external,” but do not bind an issuer host, canonical workload identity, UID, KMS mount, DB
  procedure socket, egress, or failure-domain rule.
- **Failure path:** a deployment may colocate `aria-low-permit-issuer` with `merge-authority`, or give both
  the same host/UID/socket boundary, while every currently specified eight-role pairwise test remains green. A
  single host or credential-boundary compromise can then issue and consume a low-risk permit. The same
  omission lets a medium assembler share a boundary with a quorum signer.
- **Narrowest correction:** add an operator-owned issuer topology manifest covering all three issuer services,
  the three medium voters, and their assembler. Bind canonical workload identity, distinct failure domain/UID,
  exclusive KMS handle and DB procedure, authenticated RPC, egress, resources, rotation and recovery epoch.
  Extend pairwise collision/compromise tests across issuers, voters, assembler, policy-attestor, publisher and
  merge-authority; make S28/S50/S58 depend on that manifest.

### B-P1-002 — Structural data isolation omits the repository dimension promised by APP-P1-008

- **Maps to:** `APP-P1-008`.
- **Evidence:** `docs/plans/2026-09-01-new-aria-autonomous-engineering/authority/data-privacy.md:12-23`
  declares tenant/workspace/code-base-head repository ownership, but mandates composite primary and foreign
  keys containing only `tenant_id + workspace_id`. It does not require child mission/job/
  attempt/effect/artifact/evidence/CAS references to carry or join through the immutable code/base/ head
  repository tuple. This conflicts with the corrective predicate's “tenant/workspace/repository scope” and the
  repository-swap negative named at `data-privacy.md:25-27`.
- **Failure path:** two missions for different base/head repository identities inside one workspace can
  exchange an effect, artifact, cursor or recovery reference while satisfying every stated tenant/workspace
  FK. A scoped port keyed only by that pair cannot make the repository swap structurally impossible; a later
  application check would be the sole boundary.
- **Narrowest correction:** either include the immutable repository-role tuple in every relevant composite
  parent/child key, or define and enforce a DB-level one-to-one workspace-to-code-repository binding plus
  mission-level composite base/head/snapshot keys that every descendant and CAS admission references. Make the
  schema invariant mutate each repository role independently, including same- tenant/same-workspace cases and
  background/reconcile/restore/delete paths.

### B-P1-003 — Full toolchain/build/signer admission is sequenced after the first broker sprints

- **Maps to:** `APP-P1-010`.
- **Evidence:**
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/authority/execution-supply-chain.md:69-89` says the
  full manifest exists before P03, but no pre-P03 sprint or operator prerequisite owns it.
  `phases/P03.md:42-64` allows Codex and Claude broker construction/live capability at S20/S21 with a partial
  image/CLI/plugin manifest. The exact source range, signer set, lock/registry/lifecycle/OS/
  dependency/artifact digests and two-clean-build witness are delivered only by S22 at `phases/P03.md:66-76`,
  whose dependencies are S20-S21. The OP table in `PLAN.md:74-88` has no supply-chain/build-authority
  prerequisite.
- **Failure path:** an implementer following the machine-backed sprint graph can spawn and attest a live
  provider CLI during S20 or S21 before S22 has admitted the source signer range, lock/registry lifecycle, or
  reproducible build. P03's final S24 seal is too late to protect that already executed process. “Before P03”
  prose has no commit owner or dependency edge.
- **Narrowest correction:** make the complete `ToolchainManifest` an explicit operator prerequisite delivered
  before S17, or move its complete admission into an earlier sprint and machine dependency. S20/S21 must have
  zero provider spawn until exact binary/image/plugin/MCP/hook/OS/runtime/lock/
  registry/lifecycle/SBOM/signer/build inputs and a clean-build admission are current. S22 may record TDD
  evidence, but must not be the first point at which execution provenance becomes enforceable.

### B-P1-004 — S52 contradicts the normative stack denial and uses a non-provider status vocabulary

- **Maps to:** `APP-P1-012`.
- **Evidence:** `docs/plans/2026-09-01-new-aria-autonomous-engineering/authority/github-delivery.md:41-45`
  prohibits every non-empty or unknown stack and prohibits `merge_action=default`. Yet `phases/P07.md:41-51`
  delivers “stack ordering” and tests only an “out-of-order stack,” which directs implementation toward
  supported stacks. The same card calls `queued|in_progress|succeeded|failed|cancelled|expired|unknown` the
  official reconciliation set. GitHub's current `2026-03-10` contract instead exposes provider discriminants
  including `pending`, `merged`, `enqueued`, and `failed`; the authoritative docs also state that submitting a
  stacked PR merges the preceding stack. See
  <https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request-asynchronously> and
  <https://github.github.com/gh-stack/reference/merge-api/>.
- **Failure path:** a developer implementing the phase card can accept a correctly ordered stack. One one-PR
  permit then causes GitHub to merge multiple preceding PRs. A parser built around the card's invented
  provider labels can also treat `enqueued`/`pending` as unknown or terminal incorrectly.
- **Narrowest correction:** make S52 match the authority: detect stack membership and deny any non-empty or
  unknown stack before permit consumption/call; remove stack ordering support. Define a closed provider
  response union for every documented immediate HTTP/body and poll body, then define a separate explicitly
  named local normalized state mapping. Add mutants for `pending`, `merged`, `enqueued`, `failed`, 200
  queue-vs-merged, 409 option mismatch, expiry 404, and every stack/default action; unknown provider
  fields/statuses must remain non-terminal denial.

### B-P1-005 — The dispatch horizon cannot prove a complete, region-independent post-cut effect set

- **Maps to:** `APP-P1-013`.
- **Evidence:**
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/authority/operations-reliability.md:52-71` makes each
  journal record immutable and stores a scalar `dispatchHorizon`, but defines no monotonic sequence,
  continuity/hash root, journal generation/inventory digest, retention floor, or signed high-water that proves
  the enumerated range has no omitted record. The journal is only “cross-account off-host” at `54-58`; the
  file itself says off-host is insufficient and requires a separate region/admin domain for the last
  recoverable copy at `73-78`, without explicitly placing the dispatch journal or its deletion/key authority
  in that protected set.
- **Failure path:** DB PITR restores before effect E, while a truncated or same-region-lost journal omits E.
  The restored DB cannot derive E because it is after the cut, and the remaining journal cannot prove its own
  missing member. Reconciliation can therefore freeze forever or, under a mistaken “complete” range
  implementation, redispatch an already accepted provider/GitHub effect. A primary-region loss can preserve
  DB/object backup but lose the only post-cut external-truth list.
- **Narrowest correction:** give `DispatchJournal` a signed monotonic sequence and hash/Merkle continuity
  root; bind journal generation, exact range root/count/high-water, retention floor and recovery epoch into
  `RecoveryManifest`. Require an immutable copy in a distinct region, administrative/delete and key failure
  domain, and test middle-record omission/truncation plus total primary account/region loss. No write/effect
  resume may occur unless journal continuity and all provider readbacks reconcile.

### B-P1-006 — The reservation state machine cannot represent an allowed physical retry

- **Maps to:** `APP-P1-014`.
- **Evidence:**
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/authority/operations-reliability.md:5-24` permits
  only `DISPATCHED -> SETTLED | HELD_UNKNOWN`, with one upper bound and one settlement. The retry scheduler at
  `26-36` preserves the original effect/reservation IDs and explicitly retries 429/5xx/outage classes, but
  defines neither a transition for a definitively uncharged dispatched call nor a child/per-dispatch
  reservation/debit. It also does not state that the original upper bound reserves the worst-case sum of all
  permitted physical calls.
- **Failure path:** after a known-uncharged 429/5xx, either the reservation is settled and terminal yet
  reused, or it remains `DISPATCHED` and a second call occurs without a new atomic pre-call debit. If a retry
  class can carry known charged usage, multiple calls exceed the single reserved upper bound or are collapsed
  into one settlement. Implementations can choose incompatible answers while all named states/tests remain
  present.
- **Narrowest correction:** define the logical-effect/physical-dispatch accounting model. Either pre-reserve
  `maxAttempts * perCallUpperBound` and atomically consume/release per-dispatch slices, or create immutable
  child reservations under one logical effect for each retry. Specify transitions for known-zero,
  known-charged, and unknown charge outcomes; unknown never retries, and every next call must pass a fresh
  aggregate-balance debit. Add multi-retry kill tests proving total reserved, held, settled and available
  balances exactly match every physical call across restart.

### B-P2-007 — Negative controls are not safe under the required parallel review model

- **Maps to:** review/reliability tooling; it can obscure all APP predicates during twelve-panel runs.
- **Evidence:** `verification/test-negative-controls.mjs:10-12,173-185` creates untracked `.d0-negative-*`
  copies directly under `docs/plans`. Concurrently, `verification/lib/verify.mjs:63-76,79-101` treats those
  other-panel scratch paths as product-scope violations. During this review, one full verifier run failed with
  78 `PRODUCT_SCOPE` errors solely because two other panels had active temporary copies. Another panel
  reported accidentally deleting a different panel's temporary fixture. Once all suites stopped, the
  exact-head verifier passed.
- **Failure path:** the mandated parallel agents race: a full verifier becomes false red, or one cleanup
  removes another suite's active fixture. Evidence can be lost or attributed to the wrong reviewer; reruns
  serialize a workflow intended to be mutually adversarial and parallel.
- **Narrowest correction:** run each suite in an OS-temp or agent-owned external clone and make review view
  transformation independent of absolute `--stdin-filepath`. Do not broadly ignore an in-repo scratch prefix.
  Add two concurrent negative-suite processes plus a concurrent full-verifier test; both suites and the clean
  verifier must finish deterministically without seeing or deleting the other's workspace.

## Assigned-root disposition

| Root         | Result                  | Basis                                                                                                                                                                                                                  |
| ------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP-P1-008` | FAIL                    | B-P1-002                                                                                                                                                                                                               |
| `APP-P1-009` | PASS                    | Full pre-call payload DLP, bounded non-versioned quarantine, immutable rehashed CAS, KMS separation, pre-persistence redaction and capture/hold/delete lifecycle are all assigned with fail-closed tests.              |
| `APP-P1-010` | FAIL                    | B-P1-003                                                                                                                                                                                                               |
| `APP-P1-011` | PASS with issuer caveat | Effective App/install/repo permissions, rules/bypass, base/head/review/trusted-check snapshot and under-lock reread are explicit; B-P1-001 still weakens who may issue the permit.                                     |
| `APP-P1-012` | FAIL                    | B-P1-004                                                                                                                                                                                                               |
| `APP-P1-013` | FAIL                    | B-P1-005                                                                                                                                                                                                               |
| `APP-P1-014` | FAIL                    | B-P1-006                                                                                                                                                                                                               |
| `APP-P1-015` | PASS with issuer caveat | S39 precedes deployment, S43 is single disposable canary, S44 precedes general dispatch, S52 is sandbox-only, S54 precedes S55, and S55 is first production merge; B-P1-001 leaves the compromise boundary incomplete. |

## Commands and independent evidence

- `git rev-parse HEAD` and remote branch both returned `c139f40f69f77c628f0794146a20cb51818bb03d`; tracked
  status was clean.
- Recomputed binary diffs returned exactly `ea3c1ab64e89c977e7e660d3c9ba4b31521fa74f6e032eb7da1ca6fb0dac9bfa`
  and `7184bc32ce7e882dfd7d35a7ec853b1ef807c8dd7f3c4318a905b3104bba44d1`.
- Historical materialization manifest diff was empty; byte comparison of the first four event rows against
  `c6065d6d...` was empty. Forbidden legacy/product-path diff search returned no path.
- `node .../verification/verify-d0.mjs --repo-root . --mode full`:
  `PASS ... findings=88 sprints=72 gates=9 events=5 state=VERIFYING`.
- `node .../verification/render-projections.mjs --repo-root . --check`: `PASS projections=11`.
- `node .../verification/test-negative-controls.mjs --repo-root .`: `PASS negative-controls=23` (single-owner
  run).
- Independent hostile recomputation: in an automatically removed scratch copy I changed the DR authority from
  separate-region backup to same-region backup, recomputed every `verifier-inputs.jsonl` digest and bundle,
  and called `verifyD0(..., changedPaths: [])`. Result: `errors=0`. This is not itself a new P1 because the
  manifest says it is not admission authority; it proves the verifier establishes byte self-consistency, not
  semantic source truth. The exact-head adversarial reports/appellate gate therefore remain load-bearing and
  must reject the six semantic gaps above.
