from __future__ import annotations

import re
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .apply_engine import list_apply_actions, verify_plan_converged_approval
from .auto_merge import record_pr_lifecycle
from .implementation_safety import (
    GATE_PRE_PR_OPEN,
    HardFailContext,
    observe_perimeter,
    run_hard_fail_checks,
)
from .ledger import append_declared_jsonl, load_jsonl
from .proposal import (
    approval_source_of,
    get_proposal,
    require_operator_approval,
)
from .runtime_profile import enforce_profile_for_action
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now
from .validation import list_validation_plans
from .worker_dispatch import mission_for_assignment


# ORPHAN-CRITICAL-420 — the marker cycle.py matches to tell a perimeter refusal
# apart from the other GovernanceErrors open_pr_for_action raises (missing
# change_id, wrong base, unresolvable branch). Exported as a constant rather than
# left as an inline literal so the observer and the raiser cannot drift: a
# renamed message would otherwise silently stop counting toward the breaker,
# which is the failure shape this whole wave exists to remove.
PERIMETER_REFUSED_PREFIX = "open_pr_hard_fail_perimeter_refused"

REQUIRED_PR_SECTIONS = (
    "Problem",
    "Evidence",
    "Solution",
    "Validation",
    "Baseline Comparison",
    "Rollback",
    "Provenance",
)


def _diff_text_for_action(
    *,
    workspace_path: Path,
    base_sha: Any,
    head_sha: str,
) -> str | None:
    """The diff the secret scan inspects, or None when it cannot be produced.

    ORPHAN-CRITICAL-428 — returning None on any failure is deliberate:
    ``_check_secret_scan_diff_clean`` treats an absent diff as UNVERIFIED and
    refuses, so a git error here blocks the PR rather than waving it through
    with an empty string. An empty string is a valid clean diff and would
    pass, which is why the two cases must not be conflated.
    """
    if not isinstance(base_sha, str) or not base_sha.strip():
        return None
    completed = subprocess.run(
        ["git", "diff", f"{base_sha.strip()}..{head_sha}"],
        cwd=workspace_path,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        return None
    return completed.stdout


def build_pr_body(
    *,
    proposal: dict[str, Any],
    action: dict[str, Any],
    mission_id: str | None = None,
) -> str:
    """Render the PR body, and — when the work belongs to a mission — the
    trailer `mission_reconcile` adopts on.

    PLAN Wave 2 PR 1.5. The trailer is appended as a BARE LINE after the
    provenance section rather than as a bullet inside it: the pattern is
    anchored with MULTILINE, so an indented trailer would never match, and
    `format_mission_trailer` refuses to produce a line the pattern misses.
    """
    from .mission_reconcile import format_mission_trailer

    evidence = "\n".join(f"- `{item}`" for item in proposal.get("evidence", []))
    validation = "\n".join(f"- `{item}`" for item in action.get("validation_commands", []))
    validation_refs = "\n".join(f"- `{item}`" for item in action.get("validation_run_refs", []))
    trailer = [format_mission_trailer(mission_id), ""] if mission_id else []
    return "\n".join(
        [
            "## Problem",
            str(proposal.get("problem", "")),
            "",
            "## Evidence",
            evidence or "- No evidence recorded",
            "",
            "## Solution",
            str(proposal.get("proposed_change", proposal.get("title", ""))),
            "",
            "## Validation",
            validation or "- No validation commands recorded",
            "",
            "### Validation Evidence",
            validation_refs or "- No validation run refs recorded",
            "",
            "## Baseline Comparison",
            f"- Base SHA: `{action.get('base_sha')}`",
            "- Result: pending CI / local validation",
            "",
            "## Rollback",
            "- Revert the ARIA branch commit or close this PR without merge.",
            "",
            "## Provenance",
            f"- Proposal: `{proposal.get('proposal_id')}`",
            f"- Worktree: `{action.get('worktree_path')}`",
            "",
            *trailer,
        ],
    )


ARIA_PR_BASE = "main"


def open_pr_for_action(
    *,
    proposal_id: str,
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    dry_run: bool = True,
    base: str = ARIA_PR_BASE,
    assignment_id: str | None = None,
    change_id: str | None = None,
) -> dict[str, Any]:
    # Plan 026R §D.3 — change_id binding. PR open is the strict-
    # pipeline tail; auto-merge §D.4 requires the PR to be bound
    # to a change-ledger row so the triple-gate (head_sha ==
    # change.commit_sha, change_validated row exists, validation_runs
    # verified) can fire. Pre-§D.3 the PR existed without a change_id
    # anchor, so merge_if_green had no way to assert the PR's commit
    # matched the planner's intended commit.
    #
    # Required for non-dry-run: real PR creation MUST carry change_id.
    # Optional for dry_run: the cycle pr_lifecycle preview path
    # (cycle.py:638) builds bodies without needing change_id; that
    # path's downstream consumer (the actual merge) will fail-closed
    # if change_id is absent at merge time.
    if not dry_run and (not change_id or not change_id.strip()):
        raise GovernanceError(
            "open_pr_change_id_required: non-dry-run PR creation "
            "requires change_id (auto-merge §D.4 triple-gate anchor)"
        )
    # Plan 018 Phase 6.2 (G7) — explicit base-branch guard.
    #
    # Why: previously the mainline base invariant was enforced
    # implicitly by the hardcoded `--base main` argv passed to
    # `gh pr create`. Convention-only enforcement at the subprocess
    # boundary leaves the function signature itself permissive — a
    # caller cannot tell from the function contract which base branch is
    # permitted, and a future `gh` argv refactor could silently drop
    # the constraint. The explicit `base` parameter + GovernanceError
    # surfaces the rule structurally; the subprocess argv keeps
    # `--base main` as defense-in-depth.
    if base != ARIA_PR_BASE:
        raise GovernanceError(
            f"ARIA PRs MUST target {ARIA_PR_BASE!r}; got base={base!r}"
        )
    # Plan 020 Phase 1.B — runtime profile dispatch gate.
    # Why: PR open is the strict-pipeline tail; standard profile must commit
    # but not auto-PR, observe must not PR at all, frozen must not PR at all.
    enforce_profile_for_action("pr_create", base_dir=base_dir)
    proposal = get_proposal(proposal_id=proposal_id, base_dir=base_dir)
    # ORPHAN-CRITICAL-727 — a MACHINE approval has to be traceable to the
    # convergence event it names. Staging approves its own proposal with an
    # `aria:plan-converged:<plan_id>:<content_hash>` ref, which is only an
    # authorisation because the plan ledger says the gate granted it; the ref
    # itself is a string, and `approve_proposal` writes whatever it is given.
    # Checked HERE because this is where an approval is spent: an audit that
    # only ran after the fact would find the untraceable approval attached to
    # a PR that already exists. Operator refs are a different population and
    # return None from the verifier untouched.
    # ORPHAN-CRITICAL-728 — the discrimination is on the COLUMN now, not on
    # a string convention. A machine approval must survive the traceability
    # join; an operator approval must actually carry an operator's ref.
    approval_source = approval_source_of(proposal)
    if approval_source is None:
        raise GovernanceError(
            f"open_pr_approval_source_unknown: proposal {proposal_id!r} is "
            f"approved_for_apply but names neither an operator nor a machine "
            f"grant; an approval nobody is recorded as having given is not one"
        )
    approval_violation = verify_plan_converged_approval(
        proposal=proposal, base_dir=base_dir,
    )
    if approval_violation is not None:
        raise GovernanceError(
            f"open_pr_machine_approval_untraceable:{approval_violation}: "
            f"proposal {proposal_id!r} carries a plan-converged approval ref "
            f"that does not resolve to a CONVERGED plan_evaluated event"
        )
    action = _latest_action_for_proposal(proposal_id, base_dir)
    if not action:
        raise GovernanceError("no apply action exists for proposal")
    if action.get("status") != "ready_for_pr":
        raise GovernanceError("apply action must pass validation gate before PR open")
    if not action.get("validation_gate_ref"):
        raise GovernanceError("PR open requires validation_gate_ref")
    action = dict(action)
    latest_validation = _latest_validation_plan_for_proposal(proposal_id, base_dir)
    if latest_validation:
        action["validation_plan_ref"] = latest_validation.get("ledger_hash")
        action["validation_plan_status"] = latest_validation.get("status")
        action["validation_run_refs"] = latest_validation.get("run_refs", [])
    # PLAN Wave 2 PR 1.5 — the mission is DERIVED from the assignment, never
    # supplied by the caller. `open_pr_for_action` takes no mission_id
    # parameter, so the PR's mission and the dispatch row's mission cannot
    # disagree: there is only one of them, and it is the one promotion wrote.
    body = build_pr_body(
        proposal=proposal,
        action=action,
        mission_id=mission_for_assignment(assignment_id=assignment_id, base_dir=base_dir),
    )
    _validate_pr_body(body)

    # Plan 022 §C-4 — head_sha is the proposal commit (action.branch HEAD),
    # not action.base_sha. Plan 023 v3 §P-3 — fail-hard on missing branch
    # or unresolvable rev. Pre-Plan-023 a missing action.branch resulted
    # in resolved_head_sha=None silently kept; auto-merge later compared
    # head_sha to latest_head_sha and a None-vs-None pass spuriously
    # cleared the gate.
    workspace_path = Path(workspace_root).resolve()
    branch = action.get("branch")
    if not branch or not isinstance(branch, str) or not branch.strip():
        raise GovernanceError(
            "open_pr_branch_missing: apply action does not carry "
            "action.branch; cannot resolve head_sha or pass --head to "
            "gh pr create"
        )
    rev_completed = subprocess.run(
        ["git", "rev-parse", str(branch)],
        cwd=workspace_path, capture_output=True, text=True, check=False,
    )
    if rev_completed.returncode != 0:
        raise GovernanceError(
            "open_pr_head_sha_unresolvable: "
            f"git rev-parse {branch!r} failed with returncode="
            f"{rev_completed.returncode}, stderr="
            f"{(rev_completed.stderr or '').strip()!r}"
        )
    resolved_head_sha = (rev_completed.stdout or "").strip() or None
    if not resolved_head_sha:
        raise GovernanceError(
            f"open_pr_head_sha_unresolvable: git rev-parse {branch!r} "
            f"produced empty stdout"
        )

    # ORPHAN-CRITICAL-428 / ORPHAN-HIGH-437 — the pre-PR-open half of the
    # hard-fail perimeter gets its production caller here.
    #
    # Until this call existed, run_hard_fail_checks had ZERO production
    # callers: ten implemented checks, an invariant test pinning their
    # count, and nothing on a live path that ran them. `grep -rn
    # 'run_hard_fail_checks(' aria-kernel` returned exactly one line — the
    # definition. That is the defect class this whole audit wave is about,
    # and a registry nobody iterates is documentation, not a gate.
    #
    # WHY HERE, and not one line earlier or later:
    #   * after every existing precondition, so a caller that was already
    #     going to be refused (missing change_id, wrong base, unresolvable
    #     branch) still fails with its own specific error rather than a
    #     generic perimeter refusal;
    #   * before the `dry_run` branch, so the gate runs on BOTH paths. Gating
    #     only the live-open path would have re-created the original defect in
    #     a new shape: an unreachable gate that looks wired.
    #
    #     CORRECTED (ORPHAN-CRITICAL-498). This comment used to state that the
    #     only production route here was "the cycle's pr_lifecycle phase with
    #     dry_run=True (cycle.py:_run_pr_lifecycle_phase ← _run_extended_phases
    #     ← run_enterprise_cycle ← autonomy orchestrator ← aria-auto-cycle.yml)".
    #     That chain does not execute: `_run_extended_phases` is entered only
    #     when a caller passes `run_phases` / `pre_tool_phases`, and no
    #     production caller passes either. The live route is `cli.py` `pr open`
    #     — an operator typing a command. The equivalent claim was corrected in
    #     test_pr_open_perimeter_callsite.py and missed here, which is the same
    #     defect one file over: a comment asserting a dead route as production
    #     fact is what let 498 survive review in the first place.
    #
    # A dry run is refused too. Its purpose is to answer "would this PR be
    # openable", so a preview reporting `ok` while the perimeter would
    # block is a false green — the exact failure mode this wave keeps
    # finding. The phase catches GovernanceError per proposal and
    # aggregates, so a refusal surfaces as that proposal's `fail` rather
    # than aborting the cycle.
    #
    # Every context field is populated from data already resolved above;
    # nothing is invented. The three that the checks fail closed on when
    # absent (envelope, validation_commands, diff_text) are exactly the
    # three worth stating provenance for:
    #   envelope.affected_surfaces — action.changed_files, the surfaces this
    #     action actually touches, which is what the mint-time
    #     self-modification check compares against READONLY_PATHS.
    #   validation_commands — action.validation_commands, the same field
    #     build_pr_body renders above, sourced from the proposal's
    #     validation_scope by apply_engine.
    #   diff_text — computed base_sha..head_sha below; None when base_sha is
    #     absent, which the secret scan treats as unverified and refuses.
    perimeter_context = HardFailContext(
        workspace_root=workspace_path,
        diff_text=_diff_text_for_action(
            workspace_path=workspace_path,
            base_sha=action.get("base_sha"),
            head_sha=resolved_head_sha,
        ),
        envelope={"affected_surfaces": list(action.get("changed_files", []))},
        affected_paths=tuple(action.get("changed_files", [])),
        validation_commands=tuple(action.get("validation_commands", [])),
        base_branch=base,
        pr_body=body,
    )

    # RC-2 — the two modes, chosen by whether this call MUTATES anything, and
    # returning two different types so the choice cannot be undone downstream.
    #
    # Both branches still refuse a genuine refusal. Two correct arguments were in
    # tension here and neither is discarded:
    #
    #   * the pre-RC-2 design ran the authorising gate before the `dry_run`
    #     branch so a preview could not report `ok` while the perimeter would
    #     block — a false green is the failure mode this wave keeps finding;
    #   * RC-2 requires that a dry run not be counted as a rejected
    #     implementation, because it has no changed_files, no base_sha and no
    #     diff, so checks needing those refuse on data that cannot exist yet.
    #
    # `PerimeterVerdict.evaluable` separates them: a preview is still REFUSED
    # when a check that could run refused (self-modification, secret in diff,
    # unsigned commit), and is NOT refused when the only refusals name inputs
    # this stage cannot supply. Those are reported as
    # `not_evaluable_at_this_stage` instead — visible, and not a refusal.
    if dry_run:
        observation = observe_perimeter(perimeter_context, gate=GATE_PRE_PR_OPEN)
        if observation.refused:
            raise GovernanceError(
                PERIMETER_REFUSED_PREFIX
                + ": "
                + "; ".join(
                    f"{verdict.name}:{verdict.reason}"
                    for verdict in observation.refused
                )
            )
        perimeter_summary: dict[str, Any] | None = observation.summary
    else:
        hard_fail_report = run_hard_fail_checks(perimeter_context, gate=GATE_PRE_PR_OPEN)
        if not hard_fail_report.passed:
            raise GovernanceError(
                PERIMETER_REFUSED_PREFIX
                + ": "
                + "; ".join(
                    f"{failure.name}:{failure.reason}"
                    for failure in hard_fail_report.failures
                )
            )
        perimeter_summary = None

    payload = {
        "number": None,
        "base_branch": ARIA_PR_BASE,
        "head_sha": resolved_head_sha,
        "base_sha": action.get("base_sha"),
        "branch": branch,
        "task_id": proposal.get("task_id"),
        "proposal_id": proposal_id,
        # Plan 025 §E — assignment_id bridge between worker dispatch
        # and the resulting PR. When the autonomous worker scheduler
        # calls open_pr_for_action with assignment_id, the lifecycle
        # row carries the bridge so worker_dispatch.pr_for_assignment
        # can later resolve the PR for merge_if_green. Optional kwarg
        # — proposal-only callers (the cycle pr_lifecycle phase) do
        # not pass it; legacy rows return None from pr_for_assignment
        # which fail-closes the merge path to verified_pending_merge.
        "assignment_id": assignment_id,
        # Plan 026R §D.3 — change_id anchor for auto-merge triple-gate.
        "change_id": change_id,
        "changed_files": action.get("changed_files", []),
        "title": proposal.get("title"),
        "body": body,
        "dry_run": dry_run,
        "perimeter_observation": perimeter_summary,
    }
    if dry_run:
        row = record_pr_lifecycle(
            payload, event="pr_dry_run", base_dir=base_dir,
            assignment_id=assignment_id,
        )
        row["body"] = body
        # Plan 022 §C-4 — surface base_sha alongside head_sha so callers
        # can verify provenance distinct-ness without re-reading the
        # source payload. record_pr_lifecycle persists pr_number /
        # head_sha / base_branch but drops base_sha.
        row["base_sha"] = payload.get("base_sha")
        return row
    # Plan 023 v3 §P-3 — `--head <branch>` always passed. Pre-fix gh
    # inferred the branch from the current checkout, which could be
    # wrong (the gate may have run on a different worktree than the
    # one being PR'd). Explicit --head ties the PR to action.branch.
    # Plan 032 Faz 032c — INTENT before the external write, RECEIPT after:
    # a runner that dies between the two leaves an unresolved intent the
    # recovery classifier asks GitHub about instead of opening a second PR.
    from .recovery import record_intent, record_receipt

    intent = record_intent(
        request_id=f"proposal:{proposal_id}", effect_kind="pr_create", target=f"{ARIA_PR_BASE}<-{branch}",
        intended_postcondition={"head_ref": branch, "base": ARIA_PR_BASE, "head_sha": payload.get("head_sha")},
        base_dir=base_dir,
    )
    completed = subprocess.run(
        [
            "gh", "pr", "create",
            "--base", ARIA_PR_BASE,
            "--head", branch,
            "--title", str(proposal.get("title")),
            "--body", body,
        ],
        cwd=workspace_path,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        record_receipt(
            operation_id=str(intent["operation_id"]), request_id=f"proposal:{proposal_id}",
            observed={"returncode": completed.returncode, "stderr": (completed.stderr or "")[:400]},
            status="failed", base_dir=base_dir,
        )
        raise GovernanceError(completed.stderr.strip() or completed.stdout.strip() or "gh pr create failed")
    stdout = completed.stdout or ""
    payload["url"] = stdout.strip()

    # Plan 022 §C-4 — robust PR number parse. Earlier `r"/pull/(\d+)$"`
    # pattern failed on stdout with trailing newline, leading diagnostic
    # lines, or mixed-content. The new regex tolerates whitespace or
    # end-of-string after the digits.
    pr_url_match = _PR_URL_RE.search(stdout)
    if pr_url_match is None:
        raise GovernanceError(
            f"pr_create_url_unparseable: gh pr create stdout does not contain a "
            f"GitHub /pull/<n> URL. stdout={stdout!r}"
        )
    payload["number"] = int(pr_url_match.group(1))
    payload["url"] = pr_url_match.group(0)
    record_receipt(
        operation_id=str(intent["operation_id"]), request_id=f"proposal:{proposal_id}",
        observed={"pr_number": payload["number"], "url": payload["url"], "head_sha": payload.get("head_sha")},
        status="confirmed", base_dir=base_dir,
    )
    return record_pr_lifecycle(
        payload, event="opened", base_dir=base_dir,
        assignment_id=assignment_id,
    )


# Plan 022 §C-4 — robust GitHub PR URL regex. Matches https://github.com/
# <owner>/<repo>/pull/<n> with permissive trailing context (whitespace or
# end-of-string), so a `gh pr create` stdout that adds a newline or
# diagnostic line still parses cleanly.
_PR_URL_RE = re.compile(r"https?://[^\s]+/pull/(\d+)(?:\s|$)")


def prepare_branch(
    *,
    proposal_id: str,
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    dry_run: bool = True,
) -> dict[str, Any]:
    proposal = get_proposal(proposal_id=proposal_id, base_dir=base_dir)
    if proposal.get("status") != "approved_for_apply":
        raise GovernanceError("proposal must be approved_for_apply before branch preparation")
    # ORPHAN-CRITICAL-728 — the manual branch lane acts on an operator's
    # decision; the convergence lane's agent does its own git and never
    # reaches here.
    require_operator_approval(proposal, action="prepare_branch")
    action = _latest_action_for_proposal(proposal_id, base_dir)
    if not action or action.get("status") != "ready_for_pr":
        raise GovernanceError("branch preparation requires a ready_for_pr apply action")
    root = Path(workspace_root).resolve()
    branch = str(action.get("branch") or f"aria/{proposal_id}")
    _validate_aria_branch(branch)
    current_branch = _git(root, ["branch", "--show-current"])
    if current_branch in ("snowball", "main", "master"):
        base_sha = str(action.get("base_sha") or _git(root, ["rev-parse", "HEAD"]))
    else:
        base_sha = _git(root, ["rev-parse", "HEAD"])
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "proposal_id": proposal_id,
        "workspace_root": root.as_posix(),
        "base_sha": base_sha,
        "branch": branch,
        "dry_run": dry_run,
        "status": "planned" if dry_run else "branch_ready",
    }
    if not dry_run:
        existing = _git(root, ["branch", "--list", branch])
        if existing.strip():
            _git(root, ["checkout", branch])
        else:
            _git(root, ["checkout", "-b", branch, base_sha])
    return append_declared_jsonl(
        ensure_tools_dir(base_dir) / "pr-actions.jsonl",
        {**row, "action": "prepare_branch"},
        expected_surface="pr_actions",
    )


def commit_prepared_branch(
    *,
    proposal_id: str,
    workspace_root: str | Path,
    message: str | None = None,
    base_dir: str | Path | None = None,
    dry_run: bool = True,
) -> dict[str, Any]:
    proposal = get_proposal(proposal_id=proposal_id, base_dir=base_dir)
    if proposal.get("status") != "approved_for_apply":
        raise GovernanceError("proposal must be approved_for_apply before commit")
    # ORPHAN-CRITICAL-728 — the manual branch lane acts on an operator's
    # decision; the convergence lane's agent does its own git and never
    # reaches here.
    require_operator_approval(proposal, action="commit_prepared_branch")
    branch_row = _latest_pr_action(proposal_id, "prepare_branch", base_dir)
    if not branch_row:
        raise GovernanceError("prepare-branch must run before commit")
    branch = str(branch_row.get("branch") or "")
    _validate_aria_branch(branch)
    root = Path(workspace_root).resolve()
    current_branch = _git(root, ["branch", "--show-current"])
    if current_branch != branch and not dry_run:
        raise GovernanceError(f"current branch must be {branch} before commit")
    changed_files = _changed_files(root)
    if not changed_files:
        raise GovernanceError("no changes to commit")
    commit_message = message or f"ARIA: {proposal.get('title') or proposal_id}"
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "proposal_id": proposal_id,
        "branch": branch,
        "changed_files": changed_files,
        "message": commit_message,
        "dry_run": dry_run,
        "status": "planned" if dry_run else "committed",
        "commit_sha": None,
    }
    if not dry_run:
        _git(root, ["add", *changed_files])
        _git(root, ["commit", "-m", commit_message])
        row["commit_sha"] = _git(root, ["rev-parse", "HEAD"])
    return append_declared_jsonl(
        ensure_tools_dir(base_dir) / "pr-actions.jsonl",
        {**row, "action": "commit"},
        expected_surface="pr_actions",
    )


def push_prepared_branch(
    *,
    proposal_id: str,
    workspace_root: str | Path,
    remote: str = "origin",
    base_dir: str | Path | None = None,
    dry_run: bool = True,
) -> dict[str, Any]:
    commit_row = _latest_pr_action(proposal_id, "commit", base_dir)
    if not commit_row:
        raise GovernanceError("commit must run before push")
    branch = str(commit_row.get("branch") or "")
    _validate_aria_branch(branch)
    if branch in ("snowball", "main", "master"):
        raise GovernanceError("base branch push is forbidden")
    root = Path(workspace_root).resolve()
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "proposal_id": proposal_id,
        "branch": branch,
        "remote": remote,
        "dry_run": dry_run,
        "status": "planned" if dry_run else "pushed",
    }
    if not dry_run:
        from .recovery import record_intent, record_receipt

        head_sha = _git(root, ["rev-parse", branch]) if True else None
        intent = record_intent(
            request_id=f"proposal:{proposal_id}", effect_kind="git_push", target=f"{remote}/{branch}",
            intended_postcondition={"branch": branch, "remote": remote, "head_sha": head_sha}, base_dir=base_dir,
        )
        try:
            _git(root, ["push", "-u", remote, branch])
        except Exception as exc:
            record_receipt(operation_id=str(intent["operation_id"]), request_id=f"proposal:{proposal_id}",
                           observed={"error": type(exc).__name__}, status="failed", base_dir=base_dir)
            raise
        record_receipt(operation_id=str(intent["operation_id"]), request_id=f"proposal:{proposal_id}",
                       observed={"branch": branch, "remote": remote, "head_sha": head_sha}, status="confirmed", base_dir=base_dir)
    return append_declared_jsonl(
        ensure_tools_dir(base_dir) / "pr-actions.jsonl",
        {**row, "action": "push"},
        expected_surface="pr_actions",
    )


def plan_pr_lifecycle(
    *,
    open_prs: list[dict[str, Any]],
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    stale_after_days: int = 7,
    close_after_days: int = 30,
) -> dict[str, Any]:
    if stale_after_days <= 0 or close_after_days <= stale_after_days:
        raise GovernanceError("PR lifecycle days must be positive and close_after_days must exceed stale_after_days")
    now = datetime.now(timezone.utc)
    actions = []
    for pr in open_prs:
        number = pr.get("number")
        if not isinstance(number, int):
            raise GovernanceError("open PR entries require numeric number")
        updated_at = _parse_time(str(pr.get("updated_at") or pr.get("updatedAt") or ""))
        if updated_at is None:
            raise GovernanceError("open PR entries require updated_at timestamp")
        age_days = (now - updated_at).days
        if age_days >= close_after_days:
            action = "recommend_close"
        elif age_days >= stale_after_days:
            action = "recommend_stale_comment"
        else:
            action = "observe"
        actions.append(
            {
                "pr_number": number,
                "age_days": age_days,
                "action": action,
                "title": pr.get("title"),
                "proposal_id": pr.get("proposal_id"),
            },
        )
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "stale_after_days": stale_after_days,
        "close_after_days": close_after_days,
        "actions": actions,
        "status": "recommendation_only",
    }
    return append_declared_jsonl(
        ensure_tools_dir(base_dir) / "pr-lifecycle-plans.jsonl",
        row,
        expected_surface="pr_lifecycle_plans",
    )


def plan_pr_split(
    *,
    proposal_id: str,
    changed_files: list[str],
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    max_files_per_pr: int = 12,
) -> dict[str, Any]:
    if max_files_per_pr <= 0:
        raise GovernanceError("max_files_per_pr must be positive")
    proposal = get_proposal(proposal_id=proposal_id, base_dir=base_dir)
    files = [_normalize_path(path) for path in changed_files if isinstance(path, str) and path.strip()]
    if not files:
        raise GovernanceError("PR split planning requires changed_files")
    grouped: dict[str, list[str]] = {}
    for path in sorted(set(files)):
        grouped.setdefault(_split_group(path), []).append(path)
    prs = []
    index = 1
    for group, group_files in sorted(grouped.items()):
        for chunk in _chunks(group_files, max_files_per_pr):
            prs.append(
                {
                    "sequence": index,
                    "group": group,
                    "files": chunk,
                    "depends_on": [index - 1] if index > 1 and group == "migration" else [],
                },
            )
            index += 1
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "proposal_id": proposal_id,
        "proposal_title": proposal.get("title"),
        "split_required": len(prs) > 1,
        "prs": prs,
        "status": "planned",
    }
    return append_declared_jsonl(
        ensure_tools_dir(base_dir) / "pr-split-plans.jsonl",
        row,
        expected_surface="pr_split_plans",
    )


def list_pr_lifecycle_plans(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "pr-lifecycle-plans.jsonl")


def list_pr_split_plans(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "pr-split-plans.jsonl")


def list_pr_actions(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "pr-actions.jsonl")


def _latest_action_for_proposal(proposal_id: str, base_dir: str | Path | None) -> dict[str, Any] | None:
    for action in reversed(list_apply_actions(base_dir=base_dir)):
        if action.get("proposal_id") == proposal_id:
            return action
    return None


def _latest_validation_plan_for_proposal(proposal_id: str, base_dir: str | Path | None) -> dict[str, Any] | None:
    for plan in reversed(list_validation_plans(base_dir=base_dir)):
        if plan.get("validation_plan_id") == proposal_id:
            return plan
    return None


def _latest_pr_action(proposal_id: str, action: str, base_dir: str | Path | None) -> dict[str, Any] | None:
    for row in reversed(list_pr_actions(base_dir=base_dir)):
        if row.get("proposal_id") == proposal_id and row.get("action") == action:
            return row
    return None


def _validate_pr_body(body: str) -> None:
    missing = [section for section in REQUIRED_PR_SECTIONS if f"## {section}" not in body]
    if missing:
        raise GovernanceError("PR body missing required sections: " + ", ".join(missing))


def _parse_time(value: str) -> datetime | None:
    if not value:
        return None
    candidate = value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _split_group(path: str) -> str:
    if "/migrations/" in path or path.endswith("Migration.ts"):
        return "migration"
    if path.startswith("apps/"):
        parts = path.split("/")
        return "/".join(parts[:2]) if len(parts) >= 2 else "apps"
    if path.startswith("web/"):
        parts = path.split("/")
        return "/".join(parts[:2]) if len(parts) >= 2 else "web"
    if path.startswith("libs/"):
        parts = path.split("/")
        return "/".join(parts[:2]) if len(parts) >= 2 else "libs"
    if path.startswith("platform/libs/"):
        parts = path.split("/")
        return "/".join(parts[:3]) if len(parts) >= 3 else "platform/libs"
    return path.split("/", 1)[0]


def _validate_aria_branch(branch: str) -> None:
    if not branch.startswith("aria/"):
        raise GovernanceError("ARIA may only operate on aria/... branches")
    if ".." in branch or branch.endswith("/") or branch.startswith("aria/../"):
        raise GovernanceError("invalid ARIA branch name")


def _changed_files(root: Path) -> list[str]:
    output = _git(root, ["status", "--porcelain"])
    files = []
    for line in output.splitlines():
        if not line:
            continue
        path = line[3:].strip()
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        files.append(path)
    return sorted(set(files))


def _git(cwd: Path, args: list[str]) -> str:
    completed = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise GovernanceError(completed.stderr.strip() or completed.stdout.strip() or "git command failed")
    return completed.stdout.strip()


def _chunks(values: list[str], size: int) -> list[list[str]]:
    return [values[index : index + size] for index in range(0, len(values), size)]


def _normalize_path(path: str) -> str:
    return path.replace("\\", "/").lstrip("./")
