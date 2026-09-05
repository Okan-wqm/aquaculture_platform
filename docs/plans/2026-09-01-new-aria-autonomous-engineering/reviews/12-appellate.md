<!-- markdownlint-disable MD013 MD033 -->
<!-- Historical review text preserves long evidence tokens and placeholders. -->

# D0 binding appellate review

## Verdict

`CHANGES_REQUIRED`

The numerical roster is intact and the current bootstrap hashes are internally correct, but D0 is not yet safe
to merge or admit as implementation authority. The accepted findings below are the smallest load-bearing set
after independent whole-diff review, evidence reproduction, specialist deduplication, conflict resolution, and
rejection of speculative or merely preference-level claims.

## Reviewed identity and scope

- **Base:** `eeb401131260fe45f3f60be55fa25d023a082d18`
- **Head:** `c6065d6dac97306f147de67ef58a96e3a67524ac`
- **Package:** `.superpowers/sdd/BOOTSTRAP/review-eeb401131..c6065d6da.diff`; its payload is byte-equal to
  `git diff -U10` for the recorded base/head.
- **Inputs:** root `CLAUDE.md`, task/review briefs, implementer report, all 16 tracked D0 changes, frozen
  audit reports at `85787e610e26c192c898ffebd4e51ded856cd880`, and complete specialist reports 01 through 11.
- **Scope result:** 15 documentation artifacts plus mechanically generated `tools/quality/format-scope.json`;
  no product/runtime code and no protected legacy/workflow diff.
- **Path key for exact line citations below:** `design.md` or
  `2026-09-01-new-aria-autonomous-engineering-design.md` means
  `docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md`; `PLAN.md`,
  `FINDING-COVERAGE.md`, `PROGRESS.md`, `phases/**`, and `progress/**` mean paths under
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/`.

## Approved controls

- Legacy isolation passes at this head: `aria-kernel/**`, `tools/aria-poc/**`, `docs/aria/**`,
  `.claude/agents/aria-*`, and `.github/workflows/**` have zero diff. The new design explicitly forbids legacy
  imports, shared state, shared credentials, shared authority, and runtime fallback.
- D0 truth is not overstated: the ledger ends at `VERIFYING`, all S01-S72 sprints are `PLANNED`,
  reviewer/admission are pending/false, merge is pending, and high-risk activation remains prohibited.
- The audit roster has exactly 88 unique ordered IDs and byte-exact source severity/title pairs. P0
  disposition is exactly 20 confirmed, 015/017/044 partially confirmed, and 026 refuted. Controls 001, 013,
  021, 023, 056, 079, and 085 preserve the task's required substance.
- The sprint roster has exactly nine phases and 72 unique ordered IDs. Every card contains objective,
  deliverables, tests/negative controls, evidence class, acceptance, dependencies, findings, commit/note, and
  exit predicate.
- At the reviewed bytes, all 12 authority file digests, the bundle digest
  `38ea8cd82baf3a1479d962c6a6142428c29e878f5799231325cbd11b2fbd6f08`, the raw evidence digest, and all four
  event hashes recompute. The event chain is linked and acyclic in its current form.
- The fixed access predicate, eight named roles, separate executor VM, Postgres current-state model,
  transactional outbox/inbox, exact GraphQL root names (seven queries and nine mutations), `/aria`,
  `ariaModule`, port `5179`, human release boundary, and exact-deployed-SHA `SOLVED` rule are present.

## Binding accepted findings

### APP-P1-001 — Evidence history is neither immutable nor normatively reproducible

- **Sources:** `01/INT-P1-001`, `01/INT-P1-002`, `01/INT-P1-003`, `07/COST-P2-006`, `08/REL-P2-009`.
- **Evidence:** `PLAN.md:32-47`; `progress/events.jsonl:1-4`;
  `progress/evidence/D0-plan-materialization.json:78-100,166-176,268-271`.
- **Defect:** event 4 pins the pending manifest's raw digest, while the controller contract intends to update
  that same URI for review admission. That would either rewrite history or leave the old event pointing at
  changed bytes. Event hashes match only an undocumented sorted-key serialization, and the principal
  88/72/hash checks are recorded as non-executable `node <<'NODE' (...)` placeholders. Freshness has no
  type-specific expiry or environment-change invalidation rule.
- **Minimal remediation:** keep the current manifest immutable; write review/admission as a new
  versioned/content-addressed evidence record and append a new event. Normatively specify hash
  canonicalization/version, UTF-8 bytes, field inclusion/exclusion and SHA-256. Track or digest-bind the
  actual verifier and record exact immutable argv, tool version, inputs, start/end and result. Define max-age
  and digest/event invalidators for each live proof class.
- **Verification predicate:** old event URI+digest continues to resolve after admission; a fresh clone can
  execute the recorded verifier and reproduce every document/bundle/evidence/event hash; key order,
  Unicode/numeric edge cases, tamper, stale proof, and bound environment mutation all produce deterministic
  fail-closed results.

### APP-P1-002 — The 88/72 authority projections are numerically complete but referentially inconsistent

- **Sources:** `01/INT-P2-004`, `02/P2-007`, `03/P2-01`, `03/P2-02`, `06/DATA-P2-007`, `09/GH-P2-008`, plus
  independent appellate comparison.
- **Evidence:** `PLAN.md:64-78,118-247`; `FINDING-COVERAGE.md:41,49,102`; `phases/P09.md:29-51`. The PLAN
  index omits card acceptance IDs for 32 sprints and omits card dependencies for S18, S23, S27, S61, and S67.
  Row 015 expands through S68 without `ACC-S68` or an S68 card entry; row 023 names S67 although S67 omits it;
  row 076 omits the actual S25/S31/S52 GitHub permission boundaries.
- **Defect:** automation can derive different required work from PLAN, cards, prerequisite reverse index, and
  finding coverage. Exact counts therefore do not establish the promised 88/72 integrity.
- **Minimal remediation:** select one canonical machine-readable mapping and synchronize every projection.
  Correct 015 and 023 semantically, map 076 to its live mutating boundaries, and make all PLAN
  acceptance/dependency cells exact expansions of their cards and OP reverse index.
- **Verification predicate:** one range-aware bidirectional verifier reports zero missing/extra sprint IDs,
  acceptance IDs, dependencies, prerequisites, finding owners, card finding IDs, or closure paths across all
  88 rows and 72 cards.

### APP-P1-003 — The mandatory twelve-role attack is not an enforceable gate for every phase

- **Sources:** independent appellate finding; related supervision evidence in `01`, `03`, and `09`.
- **Evidence:** the design promises all twelve roles at every phase gate
  (`2026-09-01-new-aria-autonomous-engineering-design.md:191-195`), but S08 specifies a “12-role subset
  challenge” (`phases/P01.md:89-99`), S16/S24/S32/S48/S56/S64 do not require twelve reports, and the role
  manifests are not created until S33 (`phases/P05.md:5-15`).
- **Defect:** phases can promote without the mutually supervised review mandated by the task.
- **Minimal remediation:** distinguish external program reviewers from the later productized role runtime,
  then require all twelve named independent reports, conflict checks, oracle results, appellate disposition,
  exact reviewed SHA and zero unresolved load-bearing findings at each gate.
- **Verification predicate:** deleting or duplicating any role, principal, report, oracle, dissent, or
  appellate decision blocks every P01-P09 promotion; pre-S33 gates use an explicitly authorized external
  mechanism rather than a nonexistent runtime.

### APP-P1-004 — Grant and permit issuance has no immutable authority principal

- **Sources:** `03/P1-01`, `09/GH-P1-004`.
- **Evidence:** `2026-09-01-new-aria-autonomous-engineering-design.md:79-106,203-205`; `PLAN.md:101-110`;
  `phases/P04.md:41-51`; `phases/P07.md:17-27`; `phases/P08.md:17-27`.
- **Defect:** consumers are named, but no principal is assigned to issue human step-up grants, low-risk
  permits, or medium-risk quorum permits. A conforming implementation can self-authorize.
- **Minimal remediation:** name distinct immutable issuers and exact quorum categories; assign their exclusive
  KMS/DB capabilities; bind issuer, audience, repository/workspace/PR, effect, payload, policy/dossier/ruleset
  digests, nonce and expiry; prohibit issuer/consumer and producer/approver overlap and direct permit-ledger
  inserts.
- **Verification predicate:** every `ISSUED` edge resolves to an allowed independent principal/quorum;
  self/unknown/below-quorum issuers, direct inserts, audience/payload swaps, replay and concurrent consumption
  produce no consumable grant and no external call.

### APP-P1-005 — Human, repository, and workload identities do not have one canonical binding model

- **Sources:** `02/P1-001`, `02/P1-002`, `02/P1-003`, `05/SC-P1-005`, `09/GH-P1-007`, `11/PORT-HIGH-001`.
- **Evidence:** `2026-09-01-new-aria-autonomous-engineering-design.md:73-75,95-101,184-189`;
  `PLAN.md:276-283`; `phases/P01.md:41-51`; `phases/P02.md:5-15`; `phases/P08.md:29-51`;
  `FINDING-COVERAGE.md:75-77`.
- **Defect:** immutable human subject lacks issuer/audience canonicalization; S04 needs workspace identity
  before S09 defines it; provider repository ID, normalized remote, fork namespace and literal `origin/main`
  coexist without one typed resolver; mTLS worker identity and external attestation are unbound.
  Rename/transfer/recreation or identity-channel substitution can reuse allowlists, evidence or permits.
- **Minimal remediation:** define canonical typed identity schemas now: trusted issuer+audience+sub for
  humans; provider host+immutable repository ID with separate mutable aliases, base/head/fork and configured
  authority ref roles for repositories; and certificate/key+VM attestation+UID+job nonce for workers. Move the
  shared resolver before S04 or reorder the dependency.
- **Verification predicate:** issuer collision, subject rebind/revoke, clone/rename/transfer/recreate,
  absent/renamed origin, fork/base-head swap, cert/attestation mismatch, stale VM and cross-job replay cannot
  preserve an old allowlist, grant, permit, artifact or evidence binding.

### APP-P1-006 — Eight-role separation and broker/executor confinement are not implementable end to end

- **Sources:** `02/P1-004`, `04/EXEC-P1-001`, `04/EXEC-P1-002`, `07/COST-P1-005`.
- **Evidence:** `2026-09-01-new-aria-autonomous-engineering-design.md:57-93,135,166-182`;
  `phases/P03.md:17-27,41-63`.
- **Defect:** only executor placement is closed. The design does not say where provider CLI child tools
  execute or how they see repository bytes without giving broker Git/worktree authority or executor provider
  credentials. The broker request also omits job/attempt/effect/fence/cancel and reservation identity despite
  the global effect rule. Pairwise UID, secret, mount, egress and capability uniqueness for all eight roles
  has no complete gate.
- **Minimal remediation:** add one process/data-flow and deployment manifest assigning host/VM, UID, mounts,
  RPC authentication, secrets, egress, capabilities and resource limits for every role and child process. Bind
  each provider/CAS/publisher request to current job/attempt/effect, lease epoch, cancel generation, immutable
  snapshot and reservation without exposing credentials.
- **Verification predicate:** pairwise-collision and malicious repository tests prove no role can read
  another's secret/mount or exercise another's capability; stale/cancelled attempts cannot start or admit
  provider work; CLI/process/resource placement never enters the production droplet failure domain.

### APP-P1-007 — Destructive cleanup remains vulnerable to path replacement races

- **Sources:** `04/EXEC-P1-003`.
- **Evidence:** `2026-09-01-new-aria-autonomous-engineering-design.md:175-182`; `phases/P03.md:29-39`.
- **Defect:** `realpath` plus registered-path checks are check-then-delete if repository code shares the
  parent/UID; the card does not bind cleanup to a supervisor-owned opaque volume/handle and fenced terminal
  attempt.
- **Minimal remediation:** make the supervisor own immutable job workspace parents and destroy an opaque
  ephemeral VM/volume where possible; otherwise require handle-relative no-symlink traversal, mount/device
  identity, immediate revalidation, active-lease fencing and no recursive fallback.
- **Verification predicate:** concurrent rename/symlink/bind-mount swaps, adjacent/active worktrees, reused
  paths and orphan children can remove only the exact disposable terminal job volume.

### APP-P1-008 — Schema, workspace ownership, and background/CAS isolation are unspecified

- **Sources:** `06/DATA-P1-001`.
- **Evidence:** `2026-09-01-new-aria-autonomous-engineering-design.md:127-137`; `phases/P01.md:29-51`;
  `FINDING-COVERAGE.md:98`.
- **Defect:** S03 does not name the required non-public `aria` schema, migration/drift registration, scoped
  repository rule, immutable tenant/workspace ownership, or composite authorization for
  scheduler/reconcile/restore/projection/CAS paths.
- **Minimal remediation:** assign explicit schema ownership and structural tenant/workspace/ repository keys
  to S03; require schema drift/migration runner, scoped ports/repositories and workspace-bound opaque artifact
  references on every foreground and background path.
- **Verification predicate:** schema invariants reject `public` or unspecified entities and unscoped
  repositories; two-workspace substitution tests deny swapped commands, jobs, effects, cursors, artifacts,
  reconciliation, deletion and restore references.

### APP-P1-009 — Data admission, encryption, and privacy lifecycle have pre-admission gaps

- **Sources:** `05/SC-P1-004`, `06/DATA-P1-002` through `06/DATA-P1-006`.
- **Evidence:** `2026-09-01-new-aria-autonomous-engineering-design.md:157-189,230-239,249-258`;
  `phases/P02.md:65-75`; `phases/P03.md:77-87`; `phases/P05.md:77-87`; `phases/P08.md:53-63`.
- **Defect:** S14 names DLP but does not deliver a payload-bound pre-call denial, so prompts can leave before
  S23 artifact scanning. Rejected quarantine bytes can enter version history/backup; CAS has no explicit
  no-overwrite/consume-time rehash. Primary data-key custody is absent. Long-lived evidence and raw incident
  capture lack field-level pre-hash redaction and typed capture/hold/delete authority.
- **Minimal remediation:** bind a canonical full provider payload to policy-versioned pre-call DLP; make
  quarantine bounded, non-versioned/non-replicated or scan before durable upload; enforce immutable CAS
  versions and consumer rehash; define separate operator-owned envelope encryption; and define redacted
  evidence plus authorized capture/hold/reconciled deletion state machines.
- **Verification predicate:** secret/PII and encoded variants produce zero provider spawn/network call;
  deny/crash tests leave no decryptable quarantine/version/backup fragment; post-scan mutation and
  wrong-workspace keys fail; byte scans find no secret in admitted evidence, exports, UI or backups; deletion
  cannot prove completion while any expected surface remains or a hold race is unresolved.

### APP-P1-010 — Toolchain, dependency, and Git provenance are not admitted before execution

- **Sources:** `05/SC-P1-001`, `05/SC-P1-002`, `05/SC-P1-003`.
- **Evidence:** `2026-09-01-new-aria-autonomous-engineering-design.md:166-173`; `phases/P03.md:41-75`;
  `FINDING-COVERAGE.md:45,56`; `PLAN.md:276-283`.
- **Defect:** observed CLI versions can replace allowed versions; plugin/MCP/hook surfaces, binary/
  image/lock/registry integrity and build environment are not in evidence; “signed commit” has no trusted
  signer/mission binding. S60's clean package work occurs after PR and low-risk merge phases.
- **Minimal remediation:** move an operator-owned hermetic toolchain/build/signer manifest before S20. Pin and
  bind image, CLI, plugin/tool, OS, Node/npm, lockfile, registry/integrity, lifecycle, SBOM and signer-set
  digests; disable unlisted repository extensions/hooks; verify the exact commit range and produce
  reproducible clean builds.
- **Verification predicate:** substituted/auto-updated binaries, unlisted plugins/hooks, lock or registry
  drift, lifecycle mutation, cache poisoning, unknown/revoked signer and mixed/rewritten ranges all block P03;
  two clean builds reproduce the admitted normalized artifact or emit a denied nondeterminism witness.

### APP-P1-011 — GitHub effective authority and pre-merge rules are not bound to the effect

- **Sources:** `02/P1-006`, `03/P2-02`, `09/GH-P1-001`, `09/GH-P1-002`.
- **Evidence:** `2026-09-01-new-aria-autonomous-engineering-design.md:79-88,197-210`; `PLAN.md:67-78`;
  `phases/P04.md:5-15,65-99`; `phases/P07.md:41-51`.
- **Defect:** source manifests and generic denial probes do not prove narrowed installation tokens or
  effective repository/org/enterprise rules and bypass actors. Required checks are explicitly read after
  dispatch, and the dossier does not bind trusted check producers, stale-review/base semantics or a
  pre-dispatch effective-ruleset snapshot.
- **Minimal remediation:** pin App/installation/repository IDs and explicit narrowed token permissions;
  resolve and digest all effective rules/bypass actors; bind exact base/head/merge-base, trusted check App/run
  IDs, review freshness and mergeability into dossier and permit; re-read under the base lock before atomic
  consume/dispatch.
- **Verification predicate:** an otherwise merge-eligible PR is provider-denied to Publisher; any token scope,
  App, repository, ruleset, bypass, head/base, review or trusted-check drift before dispatch invalidates the
  permit and produces no merge call.

### APP-P1-012 — The GitHub async merge and PR/check reconciliation model contradicts the provider contract

- **Sources:** `09/GH-P1-003`, `09/GH-P1-005`.
- **Evidence:** `2026-09-01-new-aria-autonomous-engineering-design.md:203-207`; `phases/P04.md:17-27,77-87`;
  `phases/P07.md:41-51`.
- **Defect:** the design treats a caller idempotency key and generic 202/409 as sufficient. The current
  official API instead returns a provider UUID, multiple immediate statuses, an existing UUID on 409, a
  24-hour result lifetime, and stacked-PR semantics. Local effect and provider UUID/options are not
  distinguished. PR/check creation also lacks a durable provider-visible natural key.
- **Minimal remediation:** model local effect ID separately from provider merge UUID; digest exact request
  options including `sha` and explicit `merge_action`; model every response and result expiry;
  persist/reconcile the UUID before terminal judgment and prohibit uncovered stacks. Define unique PR/check
  provider markers, IDs, trusted App and exact base/head identities.
- **Verification predicate:** all documented statuses, mismatched 409 options, crash around UUID persistence,
  expiry, queue/stack behavior, duplicate PR/check creation, pagination and response loss yield exactly one
  matched effect or `UNKNOWN`/terminal denial—never blind retry or wrong adoption.

### APP-P1-013 — DR cannot reconstruct external truth or enforce a single recovery authority

- **Sources:** `08/REL-P1-001` through `08/REL-P1-004`.
- **Evidence:** `2026-09-01-new-aria-autonomous-engineering-design.md:127-164,249-258`; `phases/P06.md:53-63`;
  `phases/P08.md:53-63`.
- **Defect:** PITR can lose already-dispatched effects after its recovery point; Postgres and object versions
  have no signed common recovery cut; “off-host” can share account/region/delete/key authority; regional
  rebuild lacks a global recovery epoch fencing the old region.
- **Minimal remediation:** establish an off-host dispatch horizon or immutable effect journal before external
  dispatch; define a signed DB timeline/LSN plus object-version recovery epoch and GC fence; separate the last
  recoverable backup/key/admin failure domain; require a monotonic operator-owned failover epoch and
  provider-side credential/egress fencing before new-region writes.
- **Verification predicate:** restore behind a completed external effect reconciles rather than redispatches;
  cross-cut object races fail closed; primary account/region loss still restores; old and new regions racing
  the same job/base allow effects only from the new verified epoch.

### APP-P1-014 — Cost, retry, and persistent-capacity state is not bounded before live use

- **Sources:** `07/COST-P1-001` through `07/COST-P1-004`.
- **Evidence:** `2026-09-01-new-aria-autonomous-engineering-design.md:127-173`; `phases/P02.md:65-75`;
  `phases/P03.md:5-15,41-63`; `phases/P06.md:29-51`.
- **Defect:** charged-unknown provider calls lack a durable held-reservation lifecycle and exact-once
  settlement; 429/timeout retry has no durable capped/backoff/budget contract; durable queues/CAS/
  evidence/incidents have no aggregate count/byte/age headroom; general `PR_ONLY` can activate in S43 before
  S44 installs those controls.
- **Minimal remediation:** define reservation and retry state machines bound to one logical effect,
  conservative unknown-charge holds, account-wide cooldown/fair retry, aggregate durable-surface quotas and
  emergency headroom. Restrict S43 to a dormant/disposable bootstrap canary; S44 must atomically admit current
  operator ceilings before general dispatch.
- **Verification predicate:** kill/retry/429/timeout fleets generate at most one logical charged effect and no
  released unknown reservation; restart preserves cooldown; sub-limit floods refuse before storage/host
  exhaustion; stale/missing S44 policy yields zero general PR/provider dispatch.

### APP-P1-015 — Kill, paging, capacity, rollback, and compromise proofs occur after the effects they protect

- **Sources:** `04/EXEC-P1-005`, `07/COST-P1-004`, `08/REL-P1-005` through `08/REL-P1-008`, `09/GH-P1-006`.
- **Evidence:** `2026-09-01-new-aria-autonomous-engineering-design.md:241-253`; `phases/P05.md:77-87`;
  `phases/P06.md:5-15,29-51,77-99`; `phases/P07.md:41-87`; `phases/P09.md:29-51`.
- **Defect:** control-plane/DB failure can also disable kill; S41 deploys before measured host/DB admission,
  S43 writes PRs before comprehensive limits/paging, S52 may merge before S54 rollback, and combined
  role/outage drills wait until after low/medium autonomy.
- **Minimal remediation:** create an out-of-band operator kill with provider/identity/network revoke and
  readback. Move the necessary capacity, paging, rollback and compromise/outage subsets before first
  deployment, PR write, and production merge respectively. Make S52 disposable-sandbox-only; S55 is the first
  production merge after S54 and current restore/stop ownership.
- **Verification predicate:** DB/control/droplet loss still stops new effects; missing receiver, headroom,
  rollback owner, restore or required pre-promotion drill blocks activation; no production merge exists before
  S55; stale topology/credential/policy drill evidence invalidates promotion.

### APP-P1-016 — The public API/operator surface is not an implementable, gap-safe contract

- **Sources:** `10/APIUI-P1-001`, `10/APIUI-P1-002`, `10/APIUI-P1-005`, `10/APIUI-P1-006`, `10/APIUI-P2-007`.
- **Evidence:** `2026-09-01-new-aria-autonomous-engineering-design.md:212-228`; `phases/P01.md:65-87`;
  `phases/P02.md:77-87`; `phases/P06.md:65-75`; `FINDING-COVERAGE.md:99-100,108`.
- **Defect:** only operation names are normative; arguments/types/nullability/pagination/idempotency/
  concurrency results are absent, and S46 incorrectly says ten mutations. Finding 073 promises reconnect
  without a live/resume/gap protocol. Finding 082 loses the source's closed
  `OK|EMPTY|MISSING|CORRUPT|UNAVAILABLE` distinction. Sensitive mutation state/step-up/preview rules and
  conversation duplicate/context/resume semantics are incomplete.
- **Minimal remediation:** add compact normative SDL/per-operation policy and a durable live protocol (SSE,
  subscription, or bounded polling) with snapshot/resume/gap recovery; define stable cursors, hard page
  limits, request ID/idempotency, expected version and closed typed results; preserve the five-state
  projection union and operation-specific preview/step-up rules; align S06/S15/S46 and the 073/074/082 rows.
- **Verification predicate:** full SDL/generated-type snapshot is exact at seven queries/nine mutations;
  duplicate/concurrent commands execute once or return typed conflict; reconnect across loss/reorder/expiry
  either reconstructs a gap-free view or visibly requires resync; corrupt or unavailable data never renders
  empty/green or enables sensitive actions.

### APP-P1-017 — Browser and repository integration can leave the product unsafe or unreachable

- **Sources:** `10/APIUI-P1-003`, `10/APIUI-P1-004`, `11/PORT-HIGH-002`.
- **Evidence:** `2026-09-01-new-aria-autonomous-engineering-design.md:57-75,212-228`;
  `phases/P01.md:17-27,65-87`; `phases/P06.md:5-15`; `phases/P08.md:41-51`.
- **Defect:** session/CSRF/CORS/live-channel revocation is unspecified, and no sprint owns all
  service-catalog/schema/subgraph/gateway/ModuleCode/shell/nginx/image/compose/generated-authority surfaces or
  proves a clean-host product. S60's clean environment work is after live phases.
- **Minimal remediation:** require same-origin gateway-only browser access and exact auth/CSRF/CORS/
  CSP/cache/revocation rules; add a clean-room registration/build/bootstrap/deploy matrix across existing
  repository SSoTs, all eight images, empty Postgres/object store, GraphQL composition and shell remote
  loading before S41. Keep multi-repository portability bounded until S60.
- **Verification predicate:** cross-origin/simple/expired/revoked sessions and direct subgraph access fail; a
  clean non-repository CWD can regenerate authorities, build and boot all roles, migrate empty state, compose
  the API, provision/revoke ARIA access and load `/aria`; omitted registration or generated drift fails the
  owning gate.

### APP-P2-018 — Readability controls are only partly satisfied

- **Sources:** `05/SC-P2-006`, `11/READ-MEDIUM-003`, `11/READ-MEDIUM-004`.
- **Evidence:** `2026-09-01-new-aria-autonomous-engineering-design.md:108-125`; `PLAN.md:26-28,300-306`;
  `phases/P01.md:17-27`; `FINDING-COVERAGE.md:25-114`.
- **Defect:** future source has numeric file limits, but no deterministic function/complexity limits,
  intra-project dependency rule, or auditable generated-file exception. The 88-row authority is only 114 lines
  but about 77 KB; all 90 table lines are about 833 characters, so it is not practically reviewable.
- **Minimal remediation:** make `ACC-READ-001` executable with dependency directions, function and complexity
  thresholds, and a provenance/owner/expiry exception schema. **Retain the canonical 88-row
  `FINDING-COVERAGE.md`** to preserve the exact-one-row contract, and generate indexed vertical reading
  projections by fixed ID ranges/domain with back-links and parity checks; do not shard the writable authority
  into competing sources.
- **Verification predicate:** god-function/reverse-import/forged-exception fixtures fail; the canonical matrix
  still has exactly 88 rows, while every generated vertical page is linked, readable without horizontal
  association, and field-for-field/digest-consistent with the canonical row set.

## Conflict resolution and rejected claims

- `02/P1-005` is not retained as a standalone blocker: NATS is conditional and the repository already has
  cert-only identity invariants. Its useful part is incorporated into APP-P1-017's clean-room
  absent-NATS/cert-only-NATS acceptance.
- `04/EXEC-P1-004` is rejected as a contract breach. The ordinary sprint implementation branch must be pushed;
  the runtime mission sandbox must not push. The current prose is terse, but the phase context separates those
  planes sufficiently. Clarification may be added without blocking D0.
- `10/APIUI-P2-008` and `10/APIUI-P2-009` are worthwhile product-quality additions, but canonical deep-link
  routes and a named WCAG version were not fixed D0 requirements and are not independently load-bearing for
  the trust architecture. They should be handled under S07/S46 without adding separate appellate blockers.
- Specialist implementation prescriptions were accepted only where a reachable phase exit otherwise preserves
  the stated failure mode. Exact field names/threshold values in this report are verification requirements,
  not a mandate to use a particular library or deployment product.

## Binding disposition

- **Legacy isolation:** PASS at the reviewed base/head.
- **88/72 integrity:** numeric/title/disposition integrity PASS; referential owner/acceptance/ dependency/gate
  integrity FAIL.
- **Evidence immutability/canonicalization/reproducibility:** FAIL despite correct current hashes.
- **User readability constraint:** future file-size intent PARTIAL; D0 narrative/card sizes PASS; 77 KB
  coverage-table practical readability FAIL. Retain canonical authority and add generated vertical projections
  rather than sharding the authority.
- **Can D0 proceed?** No. It must remain `VERIFYING`; do not admit review evidence into the mutable manifest,
  merge D0, start S01, or authorize any autonomy. Proceed only through a corrective documentation commit and a
  fresh independent review bound to the repaired head.
