# D0 adversarial review — GitHub delivery, merge, and release

## Verdict

`CHANGES_REQUIRED`

The reviewed D0 is documentation-only, remains `VERIFYING`, leaves protected legacy ARIA and
workflow paths untouched, and correctly pins the supported GitHub REST version `2026-03-10`.
It also preserves the human release/deploy boundary and refuses to call a merge complete without
provider readback. Those positive controls are not enough to authorize the future P04/P07 gates.
The plan does not yet define the effective GitHub ruleset authority, models only part of the async
merge protocol, leaves merge-permit issuance and binding incomplete, and allows the first live
canary merge before rollback readiness exists. Seven P1 issues and one P2 mapping issue therefore
block approval.

## Findings

### GH-P1-001 — Least privilege is a source manifest, not an exact live effective-authority proof

- **Evidence:** The runtime matrix grants `publisher` generic “branch/PR/check write” and
  `merge-authority` generic contents write while asserting both lack bypass
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:79-88`). `OP-01`
  asks only for separate App permissions and a branch-protection “export”
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/PLAN.md:67-78`). S25 names an App
  permission manifest and token mint/expiry/revoke but does not require the token request to narrow
  `repository_ids` and `permissions`, or bind the returned installation/App/repository identities
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P04.md:5-15`). S32's generic
  permission probe does not enumerate direct base push, settings/ruleset mutation, release,
  deployment, workflow, secret, or bypass-actor negatives
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P04.md:89-99`).
- **Severity:** P1 GitHub authorization/security.
- **Consequence:** GitHub installation tokens default to every repository and every permission
  granted to the installation when `repository_ids`/`permissions` are omitted. A source manifest
  can therefore look minimal while a minted token is broader. Moreover, “bypass permission” is not
  one scalar repository permission: repository/organization rulesets can name a GitHub App as a
  bypass actor. Contents write can also mutate a base directly if effective rules allow it. The
  stated probes can pass without proving that Publisher/Merge Apps cannot bypass, push the base,
  alter governance, or act in a sibling repository.
- **Smallest fix:** In S25/OP-01, define exact App IDs, installation account/ID, canonical provider
  repository ID, installation repository selection, and exact per-App permission allowlists. Every
  token mint must send one exact `repository_ids` entry and an explicit downgraded `permissions`
  object; persist only non-secret returned App/installation/repository/permission/`expires_at`
  claims. Require provider-side revoke followed by API denial. Add an operator-owned reader that
  resolves all effective repository, organization, and enterprise rulesets, enforcement states,
  and bypass actors. Live negatives must prove both Apps cannot directly update the protected base,
  edit rules/settings, release/deploy, access another repository, or bypass any effective rule.
- **Checks:** Compare the live token response and effective-ruleset digest with the protected
  manifest immediately before every write. Mutate one permission, repository selection, App ID,
  installation owner, enforcement state, or bypass list entry and require pre-dispatch `DENY` plus
  an actual provider denial probe.

### GH-P1-002 — Required checks, reviews, stale approvals, and base freshness are not a pre-merge invariant

- **Evidence:** The design checks required-check results only in read-after-write step 5, after the
  merge request was dispatched (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:197-210`).
  S30 lists checks/evidence but no effective ruleset, required-review, check-source App, stale-review,
  merge-queue, or strict-base snapshot; its negatives mention only a missing check and stale head
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P04.md:65-75`). S31/S52 test a
  generic stale base/head, but do not say how the base SHA is enforced when the async API body only
  CAS-binds the head SHA (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P04.md:77-87`,
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P07.md:41-51`). The 037 mapping
  promises base/head/check readback but omits stale approvals and trusted check producers
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/FINDING-COVERAGE.md:63`).
- **Severity:** P1 merge correctness/separation of duty.
- **Consequence:** A producer-capable Publisher App can post a same-name green check, an approval
  can become stale after a head or merge-base change, or required checks can run against an old
  base while the base advances. If rulesets are disabled, loose, accept “any source,” or no longer
  dismiss stale reviews, the no-bypass Merge App still legitimately merges an unreviewed or
  differently tested change. Post-merge check readback only detects the violation after the effect.
- **Smallest fix:** Make the merge dossier and permit bind a canonical effective-ruleset snapshot:
  target base ref/SHA, strict/up-to-date or merge-queue policy, required check names plus trusted
  GitHub App IDs, check-suite/run IDs and conclusions at the exact head, required review identities,
  latest reviewed commit/diff, stale-dismiss/latest-push settings, open change requests, and
  provider mergeability. Re-read that complete snapshot under the per-base lock immediately before
  permit consumption/dispatch; any drift invalidates the permit. Publisher-created informational
  checks must never be accepted as admission checks.
- **Checks:** Head push, base advance, merge-base change, stale approval, approval by the last
  pusher, blocking review, check rerun on a different SHA, duplicate same-name check, wrong App
  source, `skipped`/`neutral`, ruleset disable/edit, and strict-to-loose mutations must all prevent
  dispatch. GitHub documents that stale-review behavior depends on merge-base/diff changes and that
  required checks can be source-pinned to an App: [ruleset rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets).

### GH-P1-003 — The async merge state machine omits provider UUID semantics and most terminal responses

- **Evidence:** The design says a request idempotency key is sent, records only `202` pending and
  `409` conflict, and reconciles by reading PR/commit state
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:203-207`). S31 repeats
  “UUID effect” and “202/409 states” without distinguishing the local durable effect UUID from
  GitHub's returned async-request UUID (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P04.md:77-87`).
  S52 repeats the same partial response model
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P07.md:41-51`). None of the tracked
  artifacts names `merge-async/{uuid}`, `merge_action`, stacked PR scope, or the provider-result
  retention/expiry behavior.
- **Severity:** P1 external-effect correctness.
- **Consequence:** The documented `2026-03-10` endpoint returns `200`, `202`, `400`, `403`, `404`,
  `409`, or `422`; a `409` returns the existing request UUID because its options may differ, and a
  `200` can mean already merged or already in a merge queue. The documented body has no caller
  idempotency-key field. GitHub supplies a provider UUID that must be polled, and the result expires
  after 24 hours. Treating local effect identity as provider idempotency or `409` as a generic
  conflict can attach the effect to different merge options, lose the only result cursor, or mark a
  queued/not-merged PR terminal. With `merge_action=default`, a stacked PR can merge every earlier
  PR in its stack, exceeding a one-PR permit.
- **Smallest fix:** Specify separate `effect_id` and `provider_merge_uuid` fields plus a canonical
  request-options digest (`repo_id`, PR, expected head SHA, method, action, title/message). Always
  send `sha`; explicitly choose/protect `merge_action`; prohibit stacked PRs unless one permit and
  dossier covers every exact member. Model all response codes. On `202`, persist the provider UUID
  before polling. On `409`, persist the returned UUID, fetch its request result, and accept it only
  if expected head/method/action match; otherwise terminal conflict. Reconcile through
  `GET .../merge-async/{uuid}` and independent PR/base/commit readback; an expired-result `404`
  remains `UNKNOWN` until independent evidence proves one terminal outcome. Never blind-retry.
- **Checks:** Exercise every response, crash before/after persisting the UUID, mismatched 409
  options, result expiry, already-merged versus already-queued 200, provider UUID swap, queue
  cancellation, stacked PR expansion, and method-specific merge/squash/rebase content verification.
  The authoritative behavior is documented in GitHub's [async merge endpoints](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request-asynchronously).

### GH-P1-004 — No authority is assigned to issue a merge permit, and the permit is under-bound

- **Evidence:** The role matrix lets `merge-authority` consume a permit but names no issuer
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:77-88`). The protocol
  says only that a single-use permit is consumed while the base lock is held
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:203-205`). S50 binds
  subject/base/head/payload/policy/nonce, but not issuer, audience, canonical repository,
  installation, PR, merge options, dossier/attestation/ruleset/check snapshot, or durable effect ID
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P07.md:17-27`). S58 calls for
  multi-authority quorum without naming the authority classes, threshold, or issuer that converts
  quorum into a permit (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P08.md:17-27`).
  The PLAN authority matrix has no grant/permit issuance row
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/PLAN.md:101-110`).
- **Severity:** P1 authorization/security.
- **Consequence:** A conforming implementation can let `control` or `merge-authority` mint the
  credential it consumes. Atomic single use then prevents replay but not self-authorization.
  Alternatively, a valid permit can be replayed across repositories, PR numbers, merge methods,
  effective rulesets, or dossiers while preserving the currently named base/head fields.
- **Smallest fix:** Assign distinct immutable issuer principal(s) for low- and medium-risk permits,
  with issuer/consumer and producer/approver separation. Bind issuer, audience, provider host,
  canonical repo ID, installation ID, workspace, PR number, base ref and SHA, head SHA, full diff
  digest, merge method/action, risk/policy version, dossier/attestation and ruleset/check/review
  snapshot digests, local effect UUID, nonce, issued/expiry timestamps. One DB transaction must
  verify issuer/quorum/freshness, consume the permit, and insert the exact `INTENDED` effect; no role
  may insert consumable permits directly.
- **Checks:** Unauthorized/self issuer, below-quorum issuer, direct ledger insert, wrong audience,
  repo/PR/method/action/dossier swap, expiry/revoke, concurrent consume, and crash at each consume/
  effect boundary must produce no unjournaled GitHub call and at most one exact effect.

### GH-P1-005 — PR/check idempotency is not concrete enough to prevent provider duplicates

- **Evidence:** The domain model gives external effects generic UUID/idempotency fields
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:127-137`). S26 names
  UUID effects/idempotency and tests a timeout/retry duplicate PR, but has no durable PR natural key,
  provider marker/readback algorithm, provider ID uniqueness, check-run identity, check update
  contract, or duplicate-check negative (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P04.md:17-27`).
- **Severity:** P1 GitHub delivery correctness.
- **Consequence:** A timeout after GitHub accepts PR/check creation can cause a retry to create a
  second PR or same-name check run. A later name/head search can adopt the wrong provider object,
  especially across retries, forks, or concurrent missions. Duplicate check runs also make the
  required-check source/result ambiguous and can leave stale green checks visible.
- **Smallest fix:** Define DB uniqueness and reconciliation identities. PR identity must bind
  canonical base-repo ID/base ref, head-repo ID/head ref/SHA, mission/effect ID, and an immutable
  provider-visible marker. Persist PR node/number/URL and reject adoption unless every binding
  matches. Check effects must bind repository/head SHA, stable check name, trusted App ID,
  `external_id`/effect ID, and provider check-run ID; timeout reconciliation lists by exact ref and
  validates `external_id`, then updates the same ID rather than creating again. Prevent Publisher
  checks from satisfying attestor/CI-required checks.
- **Checks:** Crash before/after each response persistence, concurrent create, response loss,
  deleted/reopened PR, force-updated head, same branch in another fork, duplicate marker,
  duplicate/same-name check, stale check ID, and pagination/reordering must yield exactly one
  adopted provider object or fail closed.

### GH-P1-006 — The first live merge can precede rollback, paging, and human-boundary readiness

- **Evidence:** S52's objective is to run the merge protocol live, its evidence includes
  `live_proven`, and its note explicitly permits a “sandbox/canary” run; it depends only on S51
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P07.md:41-51`). S54 implements
  revert/rollback/freeze/page and the human release boundary only afterward and depends on S52-S53
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P07.md:65-75`). S55 is named the
  canary cohort and depends on S54, but nothing says S52 is sandbox-only or forbids it from being the
  first production merge (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P07.md:77-87`).
- **Severity:** P1 rollout/recovery safety.
- **Consequence:** The plan permits its first autonomous production merge before stop/page/revert,
  rollback evidence, and the human release boundary are implemented and drilled. A faulty first
  canary can therefore land without the very recovery controls later used to justify the P07 gate.
- **Smallest fix:** Make S52 live proof explicitly disposable-sandbox-only and incapable of
  targeting production repositories. Move/split rollback, freeze/page, no-release capability, and
  human-owner drills before any production merge. State normatively that S55 performs the first
  production autonomous merge only after those controls, current backup/restore, and stop
  thresholds pass; bind the first target/cohort manifest before enabling the Merge App installation.
- **Checks:** Before first-canary enablement, prove no previous production merge effect exists and
  exercise failed merge, bad merged outcome, page loss, freeze, human release refusal, and
  operator-authorized revert/rollback. A mutation that enables S52 against production must fail the
  promotion invariant.

### GH-P1-007 — Repository identity omits transfer/recreation and fork-head authority changes

- **Evidence:** S09 covers remote normalization, fork namespace, path variation, custom remote,
  absent `origin`, and fork collision, but not repository rename/transfer/deletion-recreation or
  installation suspension/removal (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P02.md:5-15`).
  S59 repeats namespace/fork identity and credential isolation without defining base-repository
  versus head-repository identity or lifecycle transitions
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P08.md:29-39`). The 050/051 rows
  test remote rename and fork collision but not provider ownership/installation changes
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/FINDING-COVERAGE.md:76-77`).
- **Severity:** P1 cross-repository authorization/security.
- **Consequence:** A transferred repository can retain a stable provider repository ID while its
  owner, installation, rulesets, secrets, or human authorities change; deletion/recreation can
  reuse a familiar owner/name with a new ID. A fork PR has distinct base/head repository IDs and
  may require head-repository write authority. Name/remote-derived routing can therefore send a
  branch, PR, permit, or token into the wrong authority domain after lifecycle changes.
- **Smallest fix:** Canonical identity must include provider host plus immutable provider repository
  ID; owner/name/remotes are mutable aliases, fork lineage is explicit, and every effect separately
  binds base and head repository IDs. Repository rename, transfer, visibility/fork-lineage change,
  deletion/recreation, App installation suspend/remove/reinstall, or owner change must freeze
  effects and require re-onboarding plus fresh policy/ruleset/installation bindings. Either prohibit
  fork-head writes or model a second exact installation/token without ever extending merge authority
  to the head repository.
- **Checks:** Rename, organization/user transfer, transfer back, same-name recreation with new ID,
  fork detach, cross-host remote, changed default branch, installation suspension/removal, and a
  fork head outside the installation must not reuse old grants, permits, tokens, locks, or evidence.

### GH-P2-008 — GitHub-relevant 88-row ownership is not machine-consistent

- **Evidence:** The exact 88 rows and titles are present, but `ARIA-AUDIT-015` assigns
  `S27-S29, S50, S58, S66-S69`, thereby including S68, while omitting `ACC-S68`
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/FINDING-COVERAGE.md:41`); S68 does not list
  finding 015 (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P09.md:41-51`).
  `ARIA-AUDIT-023` names S67 as an owner
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/FINDING-COVERAGE.md:49`), but S67 omits it
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P09.md:29-39`). Finally, the live
  authority-preflight finding 076 is owned by S04/S29/S54/S66/S69, not the GitHub token/merge
  boundaries S25/S31/S52 that must prove the permission claim
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/FINDING-COVERAGE.md:102`).
- **Severity:** P2 evidence-program correctness.
- **Consequence:** S38's future generator can derive contradictory required work from matrix,
  acceptance IDs, and sprint cards, while finding 076 can close without live Publisher/Merge App
  permission proof at the mutating boundary.
- **Smallest fix:** Change 015 to `S66-S67, S69` or add S68 and `ACC-S68` consistently; add 023 to
  S67 or remove S67 from that row; add S25/S52 and matching acceptance IDs to 076 (plus S31 if its
  sandbox proof is independently required). Make S38 expand every range and compare row owners,
  `ACC-Snn`, and card finding lists bidirectionally.
- **Checks:** The 88-row validator must report zero owner/acceptance/card mismatches and prove every
  `CR-LIVE` GitHub authority claim reaches a live mutating-boundary negative control.

## Verified controls and review checks

- GitHub currently lists `2026-03-10` as a supported REST API version, so the pinned version itself
  is correct: [GitHub API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions).
- S25 explicitly rejects PAT mode and asks for provider expiry/revoke plus post-revoke denial; the
  missing part is exact per-token scope/effective authority, not the intent to use installation
  tokens. GitHub confirms installation tokens expire and can be narrowed by repository and
  permissions: [installation token endpoint](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app).
- Exact head/base recording, no blind retry after unknown, per-base fencing, provider merged-SHA
  readback, no Merge App bypass intent, merged-only `VERIFYING`, exact deployed-SHA `SOLVED`, human
  release/deploy, rollback/freeze/page, and high-risk-disabled controls are all explicitly present.
- I read the root rules, common brief, task contract, implementer report, packaged diff, complete
  design/PLAN, all nine phase cards, all 88 finding rows, progress/evidence records, and generated
  format-manifest diff. A programmatic source comparison found exactly 88 unique IDs `001..088`, no
  gaps, and no severity/title drift from frozen audit commit `85787e610`.
- `git diff --check eeb401131260fe45f3f60be55fa25d023a082d18..c6065d6dac97306f147de67ef58a96e3a67524ac`
  passed. The changed-file set is the documented D0 artifacts plus mechanically generated
  `tools/quality/format-scope.json`; protected legacy ARIA and `.github/workflows/**` have zero diff.
  Reviewed commit `c6065d6dac97306f147de67ef58a96e3a67524ac` verifies with a valid local SSH
  signature and matches the advertised remote branch head.
- The D0 documents meet their stated line-count readability budgets. No product tests were rerun:
  this specialist review was read-only and used structural mapping checks, immutable Git/diff
  checks, and current official GitHub contract verification.
