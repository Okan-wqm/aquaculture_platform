"""E21-d (ORPHAN-693) — the night runs the bench: a narrow, budgeted trigger.

WHY: E21-a built the bench, E21-b taught it a second language, E21-c taught
a red run to CONFIRM a finding and a green re-run to RESOLVE it — but every
one of those verbs still waited for an operator's hand. The organism's
epistemology ("certainty is earned by reproduction") only becomes a nightly
fact when the cycle itself picks up pending problem-experiments and re-runs
the recipes that once went green.

WHAT: two budgeted lanes, both riding mechanisms that already exist (İ1):

  * PROBLEM lane — finding-bound experiments whose finding is still open
    and never reproduced. The night ensures the finding's change-chain
    exists (``emit_change_planned`` is idempotent; the chain later carries
    the fix commit and its green re-run, so problem and solution join on
    ONE spine), runs the experiment, and on a matched RED run promotes the
    finding through ``record_finding_reproduction``. A run that does NOT
    match is recorded as a refutation in the phase payload — the honest
    FP signal — and NEVER auto-mints an anti-pattern (operator signature
    is a hard constraint; the report surface is the channel).

  * REGRESSION lane — every fix-verified binding IS the regression
    fixture (E21-c): re-run the verification experiment; a matched run
    means the fix still holds; an unmatched RED run means the defect is
    back, which emits an ``experiment_regression_detected`` governance
    event for the report/judgment lanes. Finding mint stays with those
    lanes — regression severity deserves judgment, not reflex.

Budgets are disclosed, never silent: the payload names how many
candidates each lane skipped. The phase is registered with the EXISTING
``WRITES_PERMITTED`` precondition (CYCLE_PRECONDITIONS is a closed
identity-compared set) and ``record_and_continue`` error policy — an
experiment crash records itself and the night moves on.
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any, Callable

from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir

# Budgets — small on purpose: the bench proves the wiring nightly without
# turning the cycle into a CI farm. Raising them is a data decision the
# operator makes with the phase payload in hand.
MAX_PROBLEM_RUNS_PER_NIGHT = 3
MAX_REGRESSION_RERUNS_PER_NIGHT = 3

# The change opened for a not-yet-fixed finding: the experiment makes the
# wrong behaviour DETECTABLE (tier 3); the eventual fix commit rides the
# same chain and carries its own tier claim in review.
_PROBLEM_CHANGE_TIER = 3

_SEVERITY_ORDER = {"HIGH": 0, "MEDIUM": 1, "LOW": 2, "INFORMATIONAL": 3}


def _expects_red(contract: dict[str, Any]) -> bool:
    """True when the observation contract can ONLY match on a failing run.

    The problem lane must not pick up a finding's SOLUTION experiment
    (green contract, same recipe): before the fix lands it would run
    nightly, mismatch, and flood the payload with refutations of a
    hypothesis nobody made. The discriminator is the contract itself —
    inspectable, no experiment naming convention:

      * status_equals "failed"          → red by definition
      * exit_code_equals N where N != 0 → red by definition
      * anything else (log_contains, log_sha256_equals, green
        expectations) → indeterminate; the night refuses to guess and
        leaves those to the CLI/PR lanes.
    """
    comparator = contract.get("comparator")
    expected = contract.get("expected")
    if comparator == "status_equals":
        return expected == "failed"
    if comparator == "exit_code_equals":
        return isinstance(expected, int) and expected != 0
    return False


def _head_sha(repo_root: Path) -> str:
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo_root, text=True, capture_output=True, check=False,
    )
    if completed.returncode != 0 or not completed.stdout.strip():
        raise GovernanceError("experiment_night_head_sha_unavailable")
    return completed.stdout.strip()


def plan_night_experiments(
    repo_root: str | Path,
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Pure planner: WHAT the night would run, budget-capped and disclosed.

    Separated from execution so the selection policy is testable without
    running a single command, and so the payload can always say what was
    skipped (no silent caps).
    """
    from .experiment import list_experiments
    from .finding import _replay_findings, list_fix_verified_bindings

    repo_path = Path(repo_root).resolve()
    docs = _replay_findings(repo_path)

    latest_experiments: dict[str, dict[str, Any]] = {}
    for row in list_experiments(base_dir=base_dir):
        latest_experiments[str(row.get("experiment_id"))] = row

    problem_candidates: list[dict[str, Any]] = []
    unresolvable_bindings: list[dict[str, Any]] = []
    for experiment in latest_experiments.values():
        finding_ref = experiment.get("finding_ref")
        if not finding_ref:
            continue
        doc = docs.get(str(finding_ref))
        if doc is None:
            # The bench stores finding_ref as opaque data (record-only
            # invariant); a ref no finding answers is DISCLOSED here, not
            # silently skipped — a typo must be visible, not a quiet no-op.
            unresolvable_bindings.append({
                "experiment_id": experiment.get("experiment_id"),
                "finding_ref": finding_ref,
            })
            continue
        if not _expects_red(dict(experiment.get("observation_contract") or {})):
            continue
        if doc.get("status") not in ("OPEN", "IN_PROGRESS"):
            continue
        if isinstance(doc.get("reproduction"), dict):
            continue
        problem_candidates.append({
            "experiment_id": experiment.get("experiment_id"),
            "finding_id": finding_ref,
            "recipe_ref": experiment.get("recipe_ref"),
            "severity": doc.get("severity"),
            "scope_files": list((doc.get("scope") or {}).get("files") or []),
        })
    problem_candidates.sort(
        key=lambda c: (
            _SEVERITY_ORDER.get(str(c.get("severity")), 9),
            str(c.get("finding_id")),
        )
    )

    regression_candidates = sorted(
        list_fix_verified_bindings(repo_path),
        key=lambda b: str(b.get("finding_id")),
    )

    return {
        "schema_version": 1,
        "problem": problem_candidates[:MAX_PROBLEM_RUNS_PER_NIGHT],
        "regression": regression_candidates[:MAX_REGRESSION_RERUNS_PER_NIGHT],
        "skipped_problem": max(0, len(problem_candidates) - MAX_PROBLEM_RUNS_PER_NIGHT),
        "skipped_regression": max(0, len(regression_candidates) - MAX_REGRESSION_RERUNS_PER_NIGHT),
        "unresolvable_bindings": unresolvable_bindings,
    }


def _change_id_for_observation(
    validation_run_id: str, *, base_dir: str | Path | None,
) -> str | None:
    from .experiment import list_experiment_observations

    change_id: str | None = None
    for row in list_experiment_observations(base_dir=base_dir):
        if row.get("validation_run_id") == validation_run_id:
            change_id = str(row.get("change_id") or "") or None
    return change_id


def run_night_experiments(
    repo_root: str | Path,
    *,
    cycle_id: str,
    base_dir: str | Path | None = None,
    runner: Callable[..., dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Execute the plan and fold results into finding truth.

    ``runner`` defaults to ``experiment.run_experiment`` — injectable so
    the fold semantics are testable without spawning subprocesses, while
    the integration test drives the REAL runner with an allowlisted
    command.
    """
    from .change_ledger import emit_change_planned
    from .experiment import run_experiment
    from .finding import record_finding_reproduction

    run = runner or run_experiment
    repo_path = Path(repo_root).resolve()
    tools_root = ensure_tools_dir(base_dir)
    head = _head_sha(repo_path)
    plan = plan_night_experiments(repo_path, base_dir=base_dir)
    runner_identity = f"aria-cycle:{cycle_id}"

    reproduced: list[dict[str, Any]] = []
    refuted: list[dict[str, Any]] = []
    regressions: list[dict[str, Any]] = []
    still_fixed: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []

    for item in plan["problem"]:
        finding_id = str(item["finding_id"])
        try:
            scope_files = [f for f in item.get("scope_files") or [] if isinstance(f, str) and f]
            planned = emit_change_planned(
                plan_id=f"experiment-night:{finding_id}",
                finding_id=finding_id,
                intended_affected_files=scope_files or [f"aria-findings/{finding_id}.json"],
                intended_validation_refs=[f"experiment:{item['experiment_id']}"],
                architectural_tier=_PROBLEM_CHANGE_TIER,
                base_dir=base_dir,
            )
            observation = run(
                experiment_id=str(item["experiment_id"]),
                workspace_root=repo_path,
                change_id=str(planned["change_id"]),
                commit_sha=head,
                runner_identity=runner_identity,
                cycle_id=cycle_id,
                base_dir=base_dir,
            )
            if observation.get("matched") is True and observation.get("run_status") == "failed":
                event = record_finding_reproduction(
                    repo_path,
                    finding_id=finding_id,
                    validation_run_id=str(observation.get("validation_run_id")),
                    base_dir=base_dir,
                )
                reproduced.append({
                    "finding_id": finding_id,
                    "experiment_id": item["experiment_id"],
                    "validation_run_id": observation.get("validation_run_id"),
                    "event_id": event.get("event_id"),
                })
            else:
                # The hypothesis did not survive its own experiment — the
                # honest FP signal. Payload + report only; anti-pattern
                # mint requires an operator signature by design.
                refuted.append({
                    "finding_id": finding_id,
                    "experiment_id": item["experiment_id"],
                    "validation_run_id": observation.get("validation_run_id"),
                    "matched": observation.get("matched"),
                    "run_status": observation.get("run_status"),
                })
        except GovernanceError as exc:
            errors.append({"lane": "problem", "finding_id": finding_id, "error": str(exc)})

    for binding in plan["regression"]:
        finding_id = str(binding.get("finding_id"))
        try:
            original_run_id = str(binding.get("validation_run_id") or "")
            change_id = _change_id_for_observation(original_run_id, base_dir=base_dir)
            if not change_id:
                raise GovernanceError(
                    f"experiment_night_regression_change_unresolvable: "
                    f"binding for {finding_id} cites run {original_run_id!r} "
                    f"whose observation row carries no change_id"
                )
            observation = run(
                experiment_id=str(binding["experiment_id"]),
                workspace_root=repo_path,
                change_id=change_id,
                commit_sha=head,
                runner_identity=runner_identity,
                cycle_id=cycle_id,
                base_dir=base_dir,
            )
            if observation.get("matched") is True:
                still_fixed.append({
                    "finding_id": finding_id,
                    "experiment_id": binding["experiment_id"],
                    "validation_run_id": observation.get("validation_run_id"),
                })
            elif observation.get("run_status") == "failed":
                # The defect is back. Judgment lanes decide severity; the
                # night's duty is a loud, structured signal — not a reflex
                # finding mint.
                append_tools_governance(tools_root, "experiment_regression_detected", {
                    "finding_id": finding_id,
                    "experiment_id": binding.get("experiment_id"),
                    "recipe_ref": binding.get("recipe_ref"),
                    "validation_run_id": observation.get("validation_run_id"),
                    "original_fix_commit": binding.get("commit_sha"),
                })
                regressions.append({
                    "finding_id": finding_id,
                    "experiment_id": binding["experiment_id"],
                    "validation_run_id": observation.get("validation_run_id"),
                })
            else:
                errors.append({
                    "lane": "regression", "finding_id": finding_id,
                    "error": f"unmatched non-red rerun: run_status={observation.get('run_status')!r}",
                })
        except GovernanceError as exc:
            errors.append({"lane": "regression", "finding_id": finding_id, "error": str(exc)})

    return {
        "schema_version": 1,
        "cycle_id": cycle_id,
        "planned_problem": len(plan["problem"]),
        "planned_regression": len(plan["regression"]),
        "skipped_problem": plan["skipped_problem"],
        "skipped_regression": plan["skipped_regression"],
        "reproduced": reproduced,
        "refuted": refuted,
        "regressions": regressions,
        "still_fixed": still_fixed,
        "errors": errors,
    }
