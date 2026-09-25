# ARIA — the value chain's breaks, end to end (2026-09-25)

Context: the 2026-09-25 full read of ARIA (400/400 files, twelve agents) and its
adversarial re-verification (twelve agents, 1 105 claims; see
`docs/aria/reviews/2026-09-25-aria-dokuman-kod-karsilastirmasi.md` §8–§9 and
`docs/aria/reviews/2026-09-25-aria-tam-okuma/`) showed that ARIA perceives and judges but
has never closed its chain: on `origin/aria/state @ e6f462fb` there are 13 OPEN / 0
RESOLVED findings, 15 plans / 0 CONVERGED, 0 ARIA-authored pull requests and 8/8 blocked
merge decisions. The findings below are the code-level breaks between a finding and a
reversible self-merge in the narrow L1 lane. The implementation plan that closes them is
`docs/aria/plans/034-e2e-chain-closure.md`. The adjudication-panel defect is already
tracked as ARIA-HIGH-097 (`2026-09-12-aria-live-chain-blockers.md`) and is not re-filed.

Owner: claude (implementation), okan (review, operator steps). Deadlines follow the
plan's phases.

## Path normalization strips every leading dot

`auto_merge._normalize_path` (`aria-kernel/aria_kernel/auto_merge.py:1250`) is
`path.replace("\\", "/").lstrip("./")`. `str.lstrip` removes any leading `.` or `/`
character, not the `./` prefix: `.github/workflows/x.yml` becomes
`github/workflows/x.yml`, `.env.prod` becomes `env.prod`, `../x` becomes `x`. The
risk classifier therefore never matches `.github/workflows/**`, and
`.claude/agents/aria-implementer.md` falls to lane L1. The same idiom lives in
`pr_manager.py:965`, `service_dimension.py:108`, `architecture.py:450` and
`convergent_skill_authoring.py:926`, where it runs before the `..`/absolute check and
turns `../x` into an in-tree path. The idiom was already fixed twice locally
(`impact.py`, ORPHAN-HIGH-576; `feedback.py:116`) and keeps coming back because there
is no single normalizer.

## The L1 lane is broader than behaviour-neutral paths

`docs/aria/policy/risk-policy.json` puts `aria-kernel/tests/**` (the invariant suite)
and `tools/aria-adapters/*.tool.json` (adapter argv) in L1, and both matchers
(`risk_policy._matches_any`, `auto_merge._matches_any`) use `fnmatch`, whose `*`
crosses `/`: `*.md` matches `.claude/agents/*.md`, and `**/.env*` never matches a root
`.env`. `tool_health.matches_glob` already implements proper `**` semantics. L1 must be
the lane ARIA may merge unreviewed, so it must exclude every CODEOWNERS path by
construction.

## A native Claude exit 1 records no cause

On `origin/aria/state` 227 native Claude attempts ended `provider_nonzero` (exit 1)
against 100 successes, 209 of them on the arbiter role. `invoke_claude_cli`
(`tools/aria-poc/ci_executor.py:1805`) returns a bare int, the child's stderr goes to
`sys.stderr` only (`:2350-2361`), and the `runtime_attempt_finished` governance row
carries only `exit_code` and `result_admission` (`:3476-3483`). The classified
`DispatchFailure` (`tools/aria-poc/dispatch_failure.py:227`) never reaches a ledger.

## pr_tracking rewrites a declared ledger with the raw writer

`pr_tracking._mark_findings_for_revalidation` (`pr_tracking.py:388,394`) reads and
rewrites `findings.jsonl` with the raw `ledger.rewrite_jsonl`. The surface is declared
(`state_manifest.py:632`), so the call raises
`raw_jsonl_declared_surface_rewrite_rejected` the first time the ledger holds a row. It
has not fired only because no adapter is ACTIVE. `feedback_store` fixed the same shape
under ORPHAN-670.

## A display-only count blocks the cycle publish

`raw_findings` is a count surface of `finding_funnel`
(`autonomy_evidence.py:1027-1032`) solely to compute `raw_unique_fingerprints`, which
no unlock or live-proven decision reads. Being counted subjects it to the 64 MiB /
80 MiB publish budgets (`:593-596`, `:2541-2549`); at 57.5 MB it has kept the nightly
cycle from publishing since 2026-09-21. ARIA-HIGH-185 shrinks the file; this finding
removes the dependency.

## cycle_guard counts findings in the checkout

`cycle_guard._open_finding_count` / `_open_debt_count` (`cycle_guard.py:53-85`) read
`<repo>/aria-findings` and `<repo>/aria-debts`, while writers resolve through
`workspace.repo_state_root` (`finding.findings_dir`, `debt._debts_dir`). In CI the
count is structurally 0 (13 OPEN live), so the backlog cap and the empty-cycle guard
never fire.

## report_ingestion refuses a large registry before its cache

`report_ingestion.py:53-54` raises `ValueError` when the review registry exceeds 500
rows, before the cache/baseline logic and although per-cycle ingest is already capped
at `backfill_limit=100`. The learning hook passes no flags (`learning.py:96`); the
registry has 2 159 rows, so 42 of 44 live `learning_hook_failed` rows are this error
and no Lane-A/B finding has ever reached ARIA.

## Panel independence reads the GitHub run as the principal

The executor claims and submits every request as `ci-executor:gha-<GITHUB_RUN_ID>`
(`ci_executor.py:4351`); `independence_check.verify_principal_disjointness`
(`:136-200`) reads that id from `claims.jsonl`. Every seat of a panel answered in one
run shares a principal: 35/35 fully claimed panels have at least one shared pair, 24
share all three. `judgment_bridge` (`:333-352`) already refuses that identity and uses
the executor-stamped `details.agent_subagent_type`; `plan_convergence_bridge`
(`:634,735`) has the same flaw as the panel. Fixing ARIA-HIGH-097 alone would close no
panel.

## A challenger's refusal is lost to text truncation

Both live round-1 challengers wrote a correct `aria/agent-refusal/v1` envelope (their
only evidence was a self-output `aria-findings/F-*.json` path, fixed upstream by
ARIA-HIGH-181/183). `_safe_agent_text_excerpt` cuts agent text at 4 000 characters
(`ci_executor.py:819-826`); both texts are 4 003 characters and the refusal JSON is
past the cut. The detector reads only that excerpt (`:5150-5158`), misses the refusal,
and the request-class release burns the budget to HUMAN_REQUIRED; the drainer then
forces the plan to HUMAN_REQUIRED with `gate:"max_rounds"` and
`max_rounds_reached:true` at round 1 (`plan_convergence.py:1004-1023`).
`_build_envelope_from_claude_output` had parsed the full refusal (`:2626`) and dropped
it. `--challenger-timeout-seconds` is discarded (`convergence_drainer.py:569`).

## plan_synthesizer emits a reference grammar evidence_trust rejects

`plan_synthesizer.py:368` and the hunk parser (~`:424`) emit `path:line:snippet`.
`evidence_validator._AGENT_REF_RE` (`:47`) admits it, but `evidence_trust._split_ref`
uses `rpartition(":")`, so the snippet becomes part of the path and the reference is
graded `missing` — a synthesized plan's own evidence is rejected as
`agent_evidence_not_repo_verified`.

## Nothing writes change_validated automatically

`emit_change_validated` is called only by `cli.py:5303` and
`tools/aria-poc/backfill_validated_chains.py:79`. The auto-merge triple gate
(`auto_merge.py:551-555`) and `change_outcome` (`:514-517`) require the row, so an
autonomous change stops after `change_committed`. The natural producer is
`implementation_delivery` right after `emit_change_committed` (`:788-797`), where the
apply gate's validation runs are already recorded under the change id.

## A converged plan reaches dispatch only through an operator command

`promotion_controller.promote_converged_plan_to_dispatch` is called only from the CLI
with `acknowledge=True`, and its default `allowed_scope` is the read-only kernel
(`:176-177`). There is no autonomous path from CONVERGED to dispatch, even for a plan
whose every path is L1.

## Runner attestation cannot be true for the runner that merges

`.github/actions/probe-runner-attestation` requires `tools-dir`, `runner-group`,
`ephemeral` and `group-approved`; `aria-auto-cycle.yml:557-559` and
`aria-agent-executor.yml:562-564` pass only `tools-dir`, so the record is refused. The
runner is a persistent self-hosted host, so an honest `ephemeral` is false and the
merge verifier must keep refusing it; `claude_auth` reads only
`CLAUDE_CODE_OAUTH_TOKEN`. The merge step needs a runner whose ephemerality is a
measured fact.

## No producer reverts an ARIA merge

A red post-merge CI (`own_pr_ci.load_post_merge_reds`, pressure source `post_merge_ci`)
or a `change_outcome` regression only raises pressure. Nothing opens a revert, and
nothing attributes a red to the merge rather than to a lane that was already red on
`main`.

## Self-merge has no freeze

After a bad merge nothing stops the next self-merge: `merge_authority` checks the
watchdog freeze (external issue) but has no ARIA-owned self-merge freeze that admits
only the revert, and no operator-signed unfreeze.

## The branch-protection proof does not measure review requirements

`readiness_proofs._measured_protection_fields` (`:274-300`) records
`reviews_required` as "a `required_pull_request_reviews` block exists"; it records
neither `required_approving_review_count` nor `require_code_owner_reviews`, so the
proof cannot show that an unreviewed L1 merge is permitted and that owned paths still
require their owner.

## doc-staleness is mostly archive noise

`doc-staleness-adapter` produced 29 939 of 34 500 raw rows (2 755 distinct
fingerprints); about half come from `docs/reviews/**` and dated archives, which are
records, not living documents, and the adapter's archive filter is unused. At that
noise level the adapter cannot pass the precision gate that makes its findings
canonical, and it is the first candidate for the end-to-end chain.

## The auto-merge master switch has no operator-controlled source

Found while implementing ARIA-HIGH-187 (filed as ARIA-HIGH-203).
`auto_merge.DEFAULT_POLICY["enabled"]` is `False` and `evaluate_auto_merge`
refuses when it is not `True` (`auto_merge.py:280`). `RealAutoMergeRunner` calls
`merge_pr_if_ready(...)` without a `policy` argument, so every evaluation reads the
code constant: no autonomous merge can be eligible, whatever the profile, ladder
and readiness say, and nothing short of a code edit can change it. The switch
belongs in an operator-controlled, audited source read by the runner.

## Decision questioning asks, and nothing reads the answer

Found while implementing ARIA-HIGH-097 (filed as ARIA-HIGH-204).
`cycle._phase_decision_questioning` runs `open_decision_questioning` every cycle: it
samples converged decisions and mints `verification` envelopes asking for
`upheld` / `overturned` / `insufficient_evidence`. No module reads an accepted result
of those requests; `already_questioned` only stops a re-ask. An `overturned` verdict
neither reopens nor flags the decision, so the phase spends agent calls without an
effect. It is not on plan 034's L1 chain.
