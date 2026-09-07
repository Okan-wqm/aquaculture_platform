# Executor terminal outcome source review

Date: 2026-09-06 Owner: aria-runtime-maintainer Deadline: 2026-09-13 Source baseline:
`2efee0eb4b5bb8f87e1222a25e82dff7f35ffb0e` Scope: P03 source contracts; registry findings remain
OPEN until actual main closure.

## ARIA-HIGH-042

The executor published `succeeded` immediately after the model process exited zero, before kernel
submission. The drain preferred that summary over a failing child exit and inferred success from a
zero exit when the summary was missing. Budget refusal and pre-spawn cancellation could therefore
appear successful. The two cost refusal producers also passed strings to an emitter expecting
`DispatchFailure`.

Baseline evidence: `tools/aria-poc/ci_executor.py:1459`, `:1472`, `:1630`, `:2425`, `:2491`,
`:2806`; `tools/aria-poc/ci_executor_drain.py:461`.

The candidate moves final receipt ownership to `main`, after the claimed lifecycle has submitted,
released, or reconciled acceptance. Process outcome is an in-memory signal. Final
`aria/dispatch-result/v2` receipts have request, claim, and unique attempt identities and use
exclusive file creation. The drain supplies the attempt identity, matches the separately published
claim identity, rejects invalid/stale or duplicate receipts and exit conflicts, and no longer infers
success from an exit. Existing worker v1 telemetry is not final-receipt evidence for this drain.

Successful submission means **local result acceptance**, recorded as `disposition=result_accepted`.
It does not mean the request bridge completed or state was published. A submit transport failure
reconciles the canonical accepted result for this claim before any release; known acceptance is
never released/re-executed. An unreadable reconciliation remains a classified, nonretryable
unresolved attempt. Budget refusal, recovery refusal, and cancellation do not increment successes. A
failed release cannot turn an otherwise benign refusal green.

The accepted-result reader is registered as an authorizing consumer in the existing capability
roster. An unusable kernel submit receipt is charged to the harness. An unresolved executor
exception retains bounded escalation and an explicitly unclassified fault owner; it does not gain
unlimited retries or falsely attribute the cause to the request. The canonical requeue owner
declares both cases.

Tests: `test_ci_executor_live_path_smoke.py` covers accepted and rejected submit, timeout, transport
errors, uncertain reconciliation, budget refusal, cancellation, usage failure cleanup, and failed
release. `test_executor_drain_breaker.py` covers missing, malformed, old-version, wrong-request,
wrong-claim, old-attempt, duplicate, and conflicting receipts with positive circuit and success
cases. `test_executor_failure_classification.py` verifies immutable receipt emission. Actual `main`
boundary tests preserve the kernel-rendered prompt hash with a repo map and absent optional fields,
and verify that authentication failure releases under its own reason without submission or success.
Structural guards follow the claimed lifecycle and retain the single kernel projection and release
owner. Initial RED: three failing regressions; reconciliation RED: two failing regressions.

## ARIA-HIGH-043

The cost reservation duplicated pricing lookup and searched runtime aliases such as `opus` directly
against tables containing `claude-opus-*`. A valid runtime profile was classified as unpriced before
spawn. The governed alias owner already exists at
`aria-kernel/aria_kernel/budget.py::alias_pricing_prefix`.

The candidate uses `price_tokens` for exact models first, then the canonical alias owner if unknown,
and keeps unknown-model denial and the budget assertion. It adds no prices and changes no limits.
`test_ci_executor.py` retains the explicit `opus` regression, a table-backed model, an actually
unknown model, and an allowed-budget positive that proves process success cannot publish a final
attempt receipt.

## Independent source review

The independent review found and reproduced two additional paths in ARIA-HIGH-042: recovery dropped
the release confirmation, and model-refusal exception translation overwrote the original process
signal. Both now have RED-to-GREEN regressions. Recovery requires the lifecycle release callback;
refused receipts require a confirmed release; the process recorder preserves its first terminal
signal. The expanded review run passed 80 tests. Independent review reported no remaining blocker
within this source slice. Lease fixtures now return the real kernel acceptance contract, and the
release-source guard follows the lifecycle recorder to the existing kernel release owner.

## Remaining P03 obligations

Owner: aria-runtime-maintainer. Deadline: 2026-09-13. Tracked phase: P03 in
`docs/superpowers/plans/2026-09-06-aria-security-runtime-closure.md` (coordinator's approved plan).
These source findings do not close the phase's lease/process-liveness, job-deadline, queue reducer,
state publication, crash-recovery journal, or three-run live proof requirements. This slice
preserves the existing kernel CAS and prepared journal owners and does not change workflows, live
state, production, or admission policy. Uncertain reconciliation is surfaced for those owners, not
repaired by replaying an LLM call. Publish failure is still owned by the existing separate state
publish gate, whose regression tests are retained.
