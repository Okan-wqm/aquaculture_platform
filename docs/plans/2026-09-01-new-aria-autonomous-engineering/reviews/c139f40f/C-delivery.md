<!-- markdownlint-disable MD013 MD033 -->
<!-- Historical review text preserves long evidence tokens and placeholders. -->

# Fresh D0 adversarial review — Panel C

## Verdict

`CHANGES_REQUIRED`

Reviewed exact committed target:

- base `eeb401131260fe45f3f60be55fa25d023a082d18`
- prior head `c6065d6dac97306f147de67ef58a96e3a67524ac`
- corrective head `c139f40f69f77c628f0794146a20cb51818bb03d`
- corrective diff SHA-256 `ea3c1ab64e89c977e7e660d3c9ba4b31521fa74f6e032eb7da1ca6fb0dac9bfa`
- full diff SHA-256 `7184bc32ce7e882dfd7d35a7ec853b1ef807c8dd7f3c4318a905b3104bba44d1`

HEAD, upstream ref, and `git ls-remote` all resolved to the corrective head. The tracked worktree was clean.
The current full diff does not touch legacy ARIA, legacy workflows/state, `apps/aria-service`, or
`web/modules/aria`; D0 remains `VERIFYING`. Those current-byte facts pass. The verdict is blocked by eight
reachable false-admission or contract-divergence paths below.

## Findings

### C-P1-001 — Publisher's provider credential necessarily carries the merge permission it is claimed not to have

- **Roots:** `APP-P1-011`, overlap with `APP-P1-005` and the single-role compromise boundary.
- **Severity:** P1 authorization / GitHub delivery separation.
- **Evidence:** `authority/github-delivery.md:7-16` gives Publisher branch writes in the same exact repository
  while claiming it has no merge capability; `:18-22` requires an otherwise-eligible PR to be provider-denied.
  `authority/identity-authority-tcb.md:87-102` puts the installation token in Publisher's tmpfs and gives it
  repository egress. `phases/P04.md:8-16,20-28,90-100` repeats that Publisher both creates the mission branch
  and cannot reach merge.
- **Provider fact:** GitHub's official REST contract requires `Contents: write` both to
  [create a Git reference](https://docs.github.com/en/rest/git/refs?apiVersion=2026-03-10#create-a-reference)
  and to
  [merge a pull request asynchronously](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2026-03-10#merge-a-pull-request-asynchronously).
  An `allowed API endpoints` field in ARIA configuration is not a provider-side token restriction.
- **Failure path:** Publisher needs base-repository `contents:write` to create/update its branch. A
  compromised Publisher process or exfiltrated still-live token can call `merge-async` on an eligible PR.
  GitHub cannot return the promised permission-based denial because the same permission admits both endpoints.
  Local route filtering does not establish the claimed provider denial or survive token exfiltration.
- **Narrowest correction:** make branch publication provider-separated from the base repository: use a
  dedicated head/staging repository and a branch-writer App installed only there; give the base-repository
  PR/check App only `pull_requests:write` and `checks:write`, with no base `contents:write`; keep Merge App's
  base `contents:write` separate. Bind both repository/install IDs and prove the Publisher token receives
  provider `403` on base sync/async merge. If another provider-enforced construction is chosen, the plan must
  identify the exact GitHub rule that makes this denial possible and test token exfiltration outside the local
  L7 filter.

### C-P1-002 — The 88/72 verifier proves coordinated self-consistency, not frozen source truth or closed references

- **Roots:** `APP-P1-001`, `APP-P1-002`.
- **Severity:** P1 evidence integrity / false admission.
- **Evidence:** `verification/lib/verify-mapping.mjs:25-50` compares the writable matrix only with the
  co-located writable `frozen-audit.jsonl`; it never reads the declared `85787e610...` source object. `:53-79`
  binds cards to program-map bytes, while `:82-96` silently ignores unknown owner IDs through
  `mapped.get(findingId)?.push(...)` and never validates card coverage IDs against the exact 88-ID domain.
  This is weaker than the claim in `authority/verification-evidence.md:64-78`.
- **Hostile proof:** in a temporary copy I changed the 001 title in both matrix and frozen snapshot,
  regenerated projections/provenance, and received `COORDINATED_SOURCE_TRUTH_DRIFT errors=0`. I also changed
  S02 card/program coverage from `ARIA-AUDIT-069` to nonexistent `ARIA-AUDIT-999`, refreshed provenance, and
  received `UNKNOWN_FINDING_RELATION errors=0`.
- **Failure path:** a coordinated edit can rewrite audit source meaning or introduce a nonexistent coverage
  relation while the advertised full verifier prints PASS and an admission manifest can cite it.
- **Narrowest correction:** pin source commit, path, and raw object digest; have the verifier execute
  `git show <pinned-sha>:<pinned-path>`, parse the exact 88 headings, and compare IDs/severity/titles.
  Validate every `finding_ids` and `owned_finding_ids` member against that closed set; likewise close
  sprint/OP dependency domains and DAG validity. Add coordinated matrix+snapshot+projection and unknown-ID
  negatives, not only one-sided drift.

### C-P1-003 — Verifier runtime, reviewed commit range, and committed scope are self-asserted or omitted

- **Root:** `APP-P1-001`.
- **Severity:** P1 provenance / protected-scope false admission.
- **Evidence:** `verification/lib/verify-provenance.mjs:37-42` checks only that a claimed Node version matches
  a broad regex and a claimed digest looks like 64 hex characters; `:53-70` never compares them with
  `process.version`, `process.execPath`, or its digest. `verification/lib/verify.mjs:63-76` obtains scope
  solely from `git status`; `:119-131` therefore inspects uncommitted paths, not `base..HEAD`. The CLI has no
  pinned base/head arguments.
- **Hostile proof:** setting runtime metadata to `v99.99.99`, `/does/not/exist/node`, and 64 zeroes yielded
  `FAKE_RUNTIME_PROVENANCE errors=0`. Code inspection establishes that a committed protected edit disappears
  from `git status` and is therefore invisible to the default full command.
- **Current-byte distinction:** the independently computed real base-to-head diff is clean for every
  protected/legacy/product prefix. The defect is that the admission command cannot prove that fact.
- **Narrowest correction:** require exact immutable `--base` and `--head` (or equivalent evidence fields),
  assert checkout HEAD and advertised remote ref, and scope-check `git diff --name-status
  <base>..<head>` including renames. Bind and compare the executing Node version/binary digest, OS,
  and architecture to a pinned hermetic runtime identity. Add a real committed protected-path mutant
  and false runtime metadata control.

### C-P1-004 — The twelve-role gate validates labels and counts, not the required evidence

- **Root:** `APP-P1-003`.
- **Severity:** P1 independent-review gate / false quorum.
- **Evidence:** `verification/lib/verify-mapping.mjs:110-150` hard-codes twelve role labels and nine gate
  sprint IDs, but checks `required_artifacts` only by `length === 9`. It does not validate a gate dossier's
  distinct principals, reports, capability matches, conflict graph, oracle, dissent, appellate verdict,
  reviewed target, or unresolved findings. `verification/lib/verify-history.mjs:100-127` checks the historical
  non-admission package has 12 reports but does not validate its role roster or principal independence.
- **Hostile proof:** replacing all nine artifact names with `junk-0` through `junk-8`, refreshing provenance,
  yielded `NINE_JUNK_GATE_ARTIFACTS errors=0`.
- **Failure path:** a future phase/admission dossier can retain twelve role strings while omitting or
  duplicating the actual reviewers/oracles/dissent evidence and still satisfy the machine gate.
- **Narrowest correction:** add a closed phase-review evidence schema and verifier that requires one immutable
  entry for every exact role, unique immutable principal/session identity, capability match, report/oracle
  digest, conflict/dissent disposition, exact reviewed target, freshness, and zero unresolved load-bearing
  findings. Exercise removal, duplication, principal reuse, junk-field, stale-target, and producer-as-reviewer
  mutants before admitting the fresh D0 review.

### C-P1-005 — ARIA-AUDIT-082 still has two contradictory projection state contracts

- **Root:** `APP-P1-016`, overlap with exact finding/card semantics in `APP-P1-002`.
- **Severity:** P1 API/UI fail-closed correctness.
- **Evidence:** frozen source commit `85787e610...`, report lines 895-906, requires typed
  `ok|empty|missing|corrupt|unavailable`. `authority/api-ui.md:54-65` correctly preserves
  `OK|EMPTY|MISSING|CORRUPT|UNAVAILABLE` with orthogonal `CURRENT|STALE` freshness. But
  `FINDING-COVERAGE.md:114` and `phases/P06.md:65-75` instead require `absent|pending|current|stale|corrupt`,
  omitting verified empty, missing, and unavailable semantics.
- **Failure path:** the row/card acceptance can pass with a UI that collapses dependency outage into a
  lifecycle label and never exposes `UNAVAILABLE`; alternatively, an implementation following the authority
  fails its own sprint exit. This recreates the exact dirty-as-clean ambiguity finding 082 was meant to
  remove.
- **Narrowest correction:** make the row, S06/S39/S46 cards, projections, and UI snapshots use the exact five
  status values plus the separate two-value freshness dimension. Add a semantic invariant that compares these
  literal closed enums across the authority, mapping, and cards.

### C-P1-006 — The advertised exact GraphQL contract is not a closed schema and cannot recover a lost response

- **Root:** `APP-P1-016`.
- **Severity:** P1 API correctness / stranded or duplicate command outcome.
- **Evidence:** `authority/api-ui.md:5-44` declares only root field signatures; referenced input, filter,
  connection, result, and data types are not defined. `:67-80` describes common fields and a result union in
  prose, while `:84-101` gives operation-specific concepts rather than exact field names/types/nullability. At
  `:79-82`, `requestStatusLookupId` is returned only in an `UNAVAILABLE` result, then is claimed to recover a
  lost response. The fixed seven queries expose no command-status lookup, and a truly lost response cannot
  deliver the server-created lookup ID.
- **Failure path:** two implementations can satisfy the seven/nine root names with incompatible or unbounded
  nested types. If transport dies after command commit but before the response, the browser has neither the
  claimed lookup ID nor an authorized recovery operation; blind retry is explicitly forbidden, so the operator
  cannot distinguish accepted from lost.
- **Narrowest correction:** add small canonical SDL fragments for every referenced input/result/data type and
  generate the client snapshot from them. Preserve the seven-query/nine-mutation root. Make recovery
  client-known: either define same-`requestId`/same-payload replay as a safe stored-result lookup, or bind a
  client-generated lookup ID to a specified existing query/filter. Test response loss before/after commit from
  a clean generated client.

### C-P2-007 — Readability enforcement is regex-bypassable and does not calculate its claimed metric

- **Root:** `APP-P2-018`.
- **Severity:** P2 readability/enforceability.
- **Evidence:** `verification/lib/verify-readability.mjs:37-49` recognizes only function declarations and
  parenthesized arrow functions, missing single-argument arrows, object/class methods, and other function
  forms. `:52-70` compares the same cyclomatic count with both cyclomatic and cognitive limits; cognitive
  complexity is never calculated. `:73-93` sees only static `import` forms, not re-exports or dynamic imports.
- **Hostile proof:** appending a 61-line `const oversizedArrow = value => { ... }` function, refreshing
  provenance, yielded `UNPARSED_61_LINE_ARROW errors=0` despite the 60-line policy.
- **Failure path:** future new-ARIA files can exceed function/complexity or reverse-dependency limits while
  `ACC-READ-001` remains green, defeating the user's explicit small/readable-file constraint.
- **Narrowest correction:** replace source regexes with a pinned JS/TS AST walk (or repository ESLint AST
  rules) covering every function/method/import/export/dynamic edge and a real cognitive-complexity algorithm.
  Add single-arg arrow, method, re-export, dynamic import, and deeply nested fixtures.

### C-P2-008 — The corrective commit has no mandatory review-finding trailers

- **Severity:** P2 process/traceability (`PROCESS MEDIUM` under repository rules).
- **Evidence:** `CLAUDE.md:154-168` requires one `Closes:` trailer per fixed finding. Commit
  `c139f40f69f77c628f0794146a20cb51818bb03d` says it remediates the D0 appellate gaps but its complete message
  has no `Closes:` trailer for any `APP-P1-001..017` or `APP-P2-018` item.
- **Failure path:** the immutable review ledger cannot machine-resolve which binding findings the corrective
  commit claims to close; using `chore` does not remove its remediation semantics.
- **Narrowest correction:** the next non-rewritten corrective commit must carry explicit traceability for
  every finding it actually closes and a resolution map tying the earlier corrective SHA to the carried
  changes. Do not force-push or rewrite the published commit.

## Verified controls and command evidence

- `git rev-parse HEAD`, `git rev-parse @{u}`, and remote `ls-remote`: all exact `c139f40f...`.
- Both supplied binary diff recomputations matched their advertised SHA-256 digests.
- Full base-to-head protected path scan: zero changes under legacy ARIA/workflows/state and zero changes under
  the future product roots.
- Historical materialization manifest digest is unchanged at `0dfd4363...`; first four event bytes remain
  `843c2289...`; event 5 is a valid `CHANGES_REQUIRED`, `admission:false`, `VERIFYING -> VERIFYING` tail.
- `node .../verify-d0.mjs --repo-root . --mode full`:
  `PASS ... findings=88 sprints=72 gates=9 events=5 state=VERIFYING`.
- `node .../render-projections.mjs --repo-root . --check`: `PASS projections=11`.
- `node .../test-negative-controls.mjs`: `PASS negative-controls=23` (the script resolves the repository root
  from its own path; it does not parse CLI arguments).
- Independent frozen-source comparison: 88 source headings, 88 snapshot rows, 88 matrix rows, zero title
  drift; P0 disposition is 20 confirmed, partial 015/017/044, refuted 026.
- Independent relation recomputation: 72 PLAN rows, 72 cards, 72 program-map rows, 88 finding rows, eight OP
  reverse rows, zero current-byte mismatch; nine gates and twelve roles are present.
- All 12 committed raw review artifacts are byte-identical to the controller scratch originals; view and raw
  digests reproduce. No new-ARIA file exceeds 400 lines; authority/phase/verifier modules are below the
  authored target. Generated finding projections currently pass field/digest parity.
- The official GitHub async protocol itself is otherwise represented accurately: API version `2026-03-10`,
  separate local/provider UUIDs, `200/202/400/403/404/409/422`, 24-hour result lifetime, stack handling, and
  readback semantics match the provider documentation.

The green stock verifier results establish current self-consistency, not approval: the independent hostile
recomputations above demonstrate reachable false greens in the exact corrective code.
