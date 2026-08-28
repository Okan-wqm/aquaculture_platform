from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from typing import Any

from .implementation_safety import (
    CANONICAL_VALIDATION_COMMANDS_EXECUTABLE,
    CANONICAL_VALIDATION_TIMEOUT_MS,
    mint_unpredictable_feature_branch_name,
)
from .ledger import append_declared_jsonl, load_declared_jsonl
from .proposal import (
    PLAN_CONVERGED_APPROVAL_PREFIX,
    approval_source_of,
    plan_converged_approval_ref,
    get_proposal,
    record_machine_approval,
    record_proposal,
    require_operator_approval,
)
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now
from .validation import (
    compare_validation_groups,
    evaluate_validation_gate,
    list_validation_gates,
    parse_allowed_command,
    run_validation_commands,
)


APPROVED_STATUSES = ("approved_for_apply",)

# ORPHAN-CRITICAL-728 — apply-action statuses that mean "not finished yet",
# as opposed to "refused". `stage_converged_plan_for_pr` opens an action in
# `staged_for_implementation` and the implementer promotes it later, in a
# different run; `plan_apply_worktree` opens `planned` / `worktree_created`
# for the operator lane the same way. A reader that treats these as PR
# candidates gets a refusal it then has to interpret, which is how the
# nightly cycle came to mark itself failed for doing exactly what it was
# designed to do.
# The namespace a plan's own id takes when the plan IS the finding of record.
# A prefix rather than a bare id so a change-ledger reader can tell a plan
# pointer from a findings-registry id by inspection.
PLAN_FINDING_ID_PREFIX = "plan:"

IN_FLIGHT_APPLY_STATUSES: tuple[str, ...] = (
    "staged_for_implementation",
    "planned",
    "worktree_created",
)

# ORPHAN-CRITICAL-727/728 — the marker that tells a MACHINE approval apart
# from an operator's, RE-EXPORTED from `proposal` (which owns the approval
# columns) rather than defined twice.
#
# The staging path below approves its own proposal, because the approval it
# records is not "a human agreed to this change" — it is "the plan
# convergence machinery reached CONVERGED on this exact plan body". It is
# written through `record_machine_approval`, which lands it in
# `machine_approval_ref` with `approval_source="machine"`, so a reader that
# means "a human agreed" (`require_operator_approval`) can refuse it
# structurally instead of by string match. `verify_plan_converged_approval`
# below is what makes the ref itself falsifiable.
#
# The scope of this approval is PR-OPEN ONLY. Merge authority is untouched:
# auto_merge still requires its own gates, and `gh pr merge` remains denied to
# the implementer in every state (implementation_safety.DENIED_BASH_COMMANDS).

def plan_apply_worktree(
    *,
    proposal_id: str,
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    dry_run: bool = True,
) -> dict[str, Any]:
    proposal = get_proposal(proposal_id=proposal_id, base_dir=base_dir)
    if proposal.get("status") not in APPROVED_STATUSES:
        raise GovernanceError("proposal must be approved_for_apply before worktree planning")
    # ORPHAN-CRITICAL-728 — the separate-worktree lane is the OPERATOR's; the
    # convergence lane implements in the workspace and never comes here. Both
    # populations sat in `approved_for_apply`, so this entry point could not
    # tell them apart until the column existed.
    require_operator_approval(proposal, action="apply_worktree")
    if proposal.get("kind") == "self_change":
        raise GovernanceError("kernel self-change proposals require the dedicated kernel-change lane")
    root = Path(workspace_root).resolve()
    base_sha = _git(root, ["rev-parse", "HEAD"])
    worktree_path = root / "aria-worktrees" / f"A-{proposal_id}"
    branch = f"aria/{_slug(str(proposal.get('title') or proposal_id))}-{proposal_id[-8:]}"
    if not dry_run:
        worktree_path.parent.mkdir(parents=True, exist_ok=True)
        _git(root, ["worktree", "add", "-b", branch, worktree_path.as_posix(), base_sha])
    return _record_apply_action(
        proposal_id=proposal_id,
        workspace_root=root,
        base_sha=base_sha,
        branch=branch,
        validation_commands=list(proposal.get("validation_scope", {}).get("commands", [])),
        changed_files=list(proposal.get("evidence", [])),
        status="planned" if dry_run else "worktree_created",
        worktree_path=worktree_path,
        dry_run=dry_run,
        base_dir=base_dir,
    )


def _record_apply_action(
    *,
    proposal_id: str,
    workspace_root: Path,
    base_sha: str,
    branch: str,
    validation_commands: list[str],
    changed_files: list[str],
    status: str,
    worktree_path: Path | None = None,
    dry_run: bool | None = None,
    plan_id: str | None = None,
    change_id: str | None = None,
    baseline_validation_ref: str | None = None,
    validation_timeout_ms: int | None = None,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """The ONE OPENER of the ``apply_actions`` surface.

    ORPHAN-CRITICAL-728 — this docstring used to say "the ONE writer", which
    was false when it was written: ``gate_apply_action`` appends to the same
    declared surface, and the pin that was supposed to protect the claim
    grepped the source of two hand-named functions and so could never see a
    third. The surface has exactly two writers with different jobs — this
    one OPENS an action (``planned`` / ``worktree_created`` /
    ``staged_for_implementation``) and ``gate_apply_action`` PROMOTES it
    (``ready_for_pr`` / ``blocked``) — and
    ``test_the_apply_actions_surface_keeps_one_opener`` now enforces that
    module-wide by AST rather than by name.

    ORPHAN-CRITICAL-727 — two entry points open an apply action now
    (``plan_apply_worktree`` for the operator's separate-worktree lane,
    ``stage_converged_plan_for_pr`` for the in-workspace convergence lane) and
    both must produce a row the SAME readers can consume: ``gate_apply_action``
    copies the row wholesale, ``_read_diff_from_action`` needs branch +
    base_sha (+ an absent worktree_path meaning "the workspace itself"), and
    ``pr_manager.open_pr_for_action`` reads branch, base_sha, changed_files and
    validation_commands off it. A second row shape would have desynchronised
    those readers from one of the two producers, which is the defect class
    E21-a closed on the validation_runs surface.
    """
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "proposal_id": proposal_id,
        "workspace_root": Path(workspace_root).as_posix(),
        "base_sha": base_sha,
        # None means "the change lives in workspace_root itself" —
        # `_read_diff_from_action` reads that as its git cwd. A path to a
        # worktree that was never created would make every git call fail and
        # the suppression scan refuse for the wrong reason.
        "worktree_path": worktree_path.as_posix() if worktree_path is not None else None,
        "branch": branch,
        "dry_run": dry_run,
        "status": status,
        "validation_commands": list(validation_commands),
        "changed_files": list(changed_files),
        "plan_id": plan_id,
        "change_id": change_id,
        "baseline_validation_ref": baseline_validation_ref,
        "validation_timeout_ms": validation_timeout_ms,
    }
    return append_declared_jsonl(
        ensure_tools_dir(base_dir) / "apply" / "actions.jsonl",
        row,
        expected_surface="apply_actions",
    )


def gate_apply_action(
    *,
    proposal_id: str,
    validation_comparison_ref: str,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    diff_text: str | None = None,
    workspace_root: str | Path | None = None,
) -> dict[str, Any]:
    """Promote an apply action to `ready_for_pr` after validation gate passes.

    The PROMOTER half of the ``apply_actions`` surface — the second of its
    two writers (``_record_apply_action`` is the opener). It copies the
    latest row wholesale and overwrites only the gate verdict, so an action
    keeps the branch, base_sha and change_id the opener minted.

    Plan 017 Phase 3 adds the optional `diff_text` kwarg. When provided,
    the apply gate runs the suppression scanner over the unified diff and
    rejects the action when any banned suppression pattern (test skip,
    CI masking, TS escape, runtime swallow, ARIA suppression honor)
    appears in changed lines. Backward compatible: `diff_text=None`
    preserves the original validation-gate-only behavior.
    """
    action = _latest_action_for_proposal(proposal_id, base_dir)
    if action is None:
        raise GovernanceError("no apply action exists for proposal")
    gate = evaluate_validation_gate(
        comparison_ref=validation_comparison_ref,
        base_dir=base_dir,
        cycle_id=cycle_id,
    )
    # Plan 022 §H-1 — suppression scan fail-closed when diff_text=None.
    # Pre-fix: caller could omit diff_text and the suppression scan
    # silently skipped entirely. Post-fix: try to fetch diff via
    # `git diff base_sha..branch` from the action; if unavailable
    # (no branch/base in action, or git command fails), raise so the
    # gate cannot pass without diff coverage.
    if diff_text is None:
        # ORPHAN-CRITICAL-728 — the diff is read from the tree the gate
        # actually ran in. `run_apply_gate` now takes a --workspace-root
        # override; without threading it here the suppression and secret
        # scans would judge the checkout the STAGING happened in while the
        # validation measured a different one.
        diff_text = _read_diff_from_action(action, workspace_root=workspace_root)
        if diff_text is None:
            raise GovernanceError(
                "suppression_scan_requires_diff_content: gate_apply_action "
                "diff_text=None and the action does not carry branch+base_sha "
                "to recover diff via git. Suppression scanner cannot run on "
                "an empty diff; pass diff_text explicitly or ensure the "
                "action has branch + base_sha set."
            )
    # Plan 026R §D.6 — empty / whitespace-only diff reject. Pre-§D.6
    # the None check above passed an empty string through (caller
    # could pass diff_text="" or "\n" + whitespace and the suppression
    # scan would walk an empty stream, returning zero matches and a
    # falsely-clean ready_for_pr verdict). The gate is structurally
    # impossible to pass on a no-content diff post-§D.6.
    if not diff_text.strip():
        raise GovernanceError(
            "suppression_scan_requires_diff_content: gate_apply_action "
            "received an empty or whitespace-only diff. An empty diff "
            "is NOT a clean diff; pass the actual unified diff content "
            "or recover it via the action's branch+base_sha."
        )
    suppression_matches: list[dict[str, Any]] = []
    from .suppression_scanner import scan_unified_diff_text

    for match in scan_unified_diff_text(diff_text):
        suppression_matches.append(
            {
                "category": match.category,
                "detector": match.detector,
                "file": match.file,
                "line": match.line,
                "text": match.text,
            }
        )
    blocked_by = list(gate["blocked_by"] or [])
    if suppression_matches:
        blocked_by.append("suppression_pattern")
    final_status = (
        "ready_for_pr"
        if gate["status"] == "ready_for_pr" and not suppression_matches
        else "blocked"
    )
    row = dict(action)
    row.update(
        {
            "schema_version": 1,
            "recorded_at": utc_now(),
            "cycle_id": cycle_id,
            "validation_comparison_ref": validation_comparison_ref,
            "validation_gate_ref": gate["ledger_hash"],
            "validation_gate_status": gate["status"],
            "validation_gate_blocked_by": gate["blocked_by"],
            "suppression_matches": suppression_matches,
            "status": final_status,
            "blocked_by": blocked_by,
        },
    )
    return append_declared_jsonl(
        ensure_tools_dir(base_dir) / "apply" / "actions.jsonl",
        row,
        expected_surface="apply_actions",
    )


def _read_diff_from_action(
    action: dict[str, Any], *, workspace_root: str | Path | None = None,
) -> str | None:
    """Plan 023 v3 §P-1 — worktree-aware 3-diff union.

    Pre-Plan-023 the diff fetcher ran a single `git diff base..branch`
    in the workspace_root cwd. Two layered bugs:
      1. Branch-only diff missed worktree drift — a caller could write
         a banned-phrase patch into the working tree (staged or
         unstaged) and pass through gate_apply_action because the
         committed branch diff didn't reflect it.
      2. cwd = workspace_root, not the action's worktree_path. Plan
         016's plan_apply_worktree creates a separate worktree at
         action.worktree_path; the branch only resolves there.

    Plan 023 v3 fix:
      * Three diffs run and unioned:
          git diff base_sha..branch     (committed branch history)
          git diff branch..HEAD         (worktree drift vs. the branch)
          git diff --staged             (staged uncommitted)
        The union is concatenated as bytes-equivalent text so the
        suppression scanner downstream sees every line that could
        appear in the actual change.
      * cwd = action.worktree_path or workspace_root (worktree-aware).
      * Fail-closed dirty-worktree gate: if the worktree has dirty
        paths AND action.allow_dirty_worktree is not True, raise
        GovernanceError. Operators who want to scan the dirty content
        opt in explicitly; the default refuses to scan a tree whose
        commit graph and working state disagree.

    Returns the unioned diff string or None when prerequisites
    (workspace_root + branch + base_sha) are missing or every git
    invocation fails.
    """
    recorded_root = action.get("workspace_root")
    branch = action.get("branch")
    base_sha = action.get("base_sha")
    root = workspace_root if workspace_root is not None else recorded_root
    if not (root and branch and base_sha):
        return None
    # Plan 023 v3 §P-1 — worktree-aware cwd. action.worktree_path is
    # populated by plan_apply_worktree when the worktree was created;
    # fall back to the workspace root for legacy actions. An explicit
    # override wins over both: it names the tree the caller validated.
    cwd_path = Path(
        root if workspace_root is not None
        else (action.get("worktree_path") or recorded_root),
    ).resolve()

    # Plan 023 v3 §P-1 — fail-closed dirty-worktree gate.
    if not action.get("allow_dirty_worktree"):
        try:
            status = subprocess.run(
                ["git", "status", "--porcelain"],
                cwd=cwd_path, capture_output=True, text=True, check=False,
            )
        except (FileNotFoundError, OSError):
            status = None
        if status is not None and status.returncode == 0 and status.stdout.strip():
            raise GovernanceError(
                "apply_engine_worktree_dirty_without_explicit_allow: "
                f"worktree at {cwd_path} has uncommitted changes; pass "
                "action.allow_dirty_worktree=True to scan dirty content "
                "or commit / stash before invoking gate_apply_action"
            )

    diff_pieces: list[str] = []
    # Plan 023 v3 §P-1 — three sources unioned:
    #   git diff base..branch  : committed branch history.
    #   git diff --staged      : staged uncommitted in the worktree.
    #   git diff               : unstaged uncommitted (working tree vs index).
    # The union covers every line that could appear in the actual
    # change-set being applied, regardless of whether it sits in a
    # commit, the staging area, or the working tree.
    diff_invocations = (
        ["git", "diff", f"{base_sha}..{branch}"],   # committed branch history
        ["git", "diff", "--staged"],                # staged uncommitted
        ["git", "diff"],                            # unstaged worktree
    )
    any_succeeded = False
    for argv in diff_invocations:
        try:
            completed = subprocess.run(
                argv, cwd=cwd_path, capture_output=True, text=True, check=False,
            )
        except (FileNotFoundError, OSError):
            continue
        if completed.returncode != 0:
            continue
        any_succeeded = True
        if completed.stdout:
            diff_pieces.append(completed.stdout)
    if not any_succeeded:
        return None
    return "\n".join(diff_pieces) if diff_pieces else ""


def list_apply_actions(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_declared_jsonl(
        ensure_tools_dir(base_dir) / "apply" / "actions.jsonl",
        expected_surface="apply_actions",
    )


def latest_ready_apply_action(*, proposal_id: str, base_dir: str | Path | None = None) -> dict[str, Any] | None:
    action = _latest_action_for_proposal(proposal_id, base_dir)
    if not action or action.get("status") != "ready_for_pr":
        return None
    gate_ref = action.get("validation_gate_ref")
    if not isinstance(gate_ref, str) or not gate_ref:
        return None
    gates = list_validation_gates(base_dir=base_dir)
    for gate in reversed(gates):
        if gate.get("ledger_hash") == gate_ref and gate.get("status") == "ready_for_pr":
            return action
    return None


# The ref grammar, as a pattern rather than a string split: plan ids may
# contain ``:`` (plan_convergence._validate_id admits it) while the content
# hash is a fixed-width ``sha256:<64 hex>`` tail, so anchoring the tail is the
# only unambiguous way to recover the two halves.
_PLAN_CONVERGED_REF_RE = re.compile(
    r"^" + re.escape(PLAN_CONVERGED_APPROVAL_PREFIX)
    + r"(?P<plan_id>.+):(?P<content_hash>sha256:[0-9a-f]{64})$"
)


def parse_plan_converged_approval_ref(ref: str) -> tuple[str, str] | None:
    """``(plan_id, content_hash)`` for a machine approval ref, else None.

    Public so the audit pin reads refs through the SAME grammar that writes
    them — a second regex in the test would keep passing while the writer
    drifted away from it.
    """
    match = _PLAN_CONVERGED_REF_RE.match(ref or "")
    if match is None:
        return None
    return match.group("plan_id"), match.group("content_hash")


def lane_runner_identity(*, fallback: str) -> str:
    """Who executed a validation run, as the ledger requires it be named.

    ``record_validation_run`` refuses an empty ``runner_identity`` because a
    run nobody executed is not evidence. On the executor lane the honest
    answer is the workflow run; off it, the calling kernel entry point.
    """
    run_id = os.environ.get("GITHUB_RUN_ID")
    return f"ci-executor:gha-{run_id}" if run_id else fallback


def _executable_spelling(command: str) -> str:
    """The canonical suite's spelling of a declared command.

    ``plan_synthesizer`` emits ``nx affected --target=test`` and
    ``parse_allowed_command`` pins argv-0, so the same suite arrives under two
    spellings. Normalising here is what lets a plan declare the perimeter's
    form without that form being treated as a second, unknown command.
    """
    collapsed = " ".join(str(command).split())
    return f"npx {collapsed}" if collapsed.startswith("nx ") else collapsed


def _staged_validation_commands(
    converged_plan: dict[str, Any], *, base_dir: str | Path | None,
) -> tuple[list[str], int]:
    """``(commands, timeout_ms)`` — what the staged change is validated with.

    The canonical suite comes FIRST and always: ``open_pr_for_action``'s
    perimeter (``test_gate_canonical_suite``) refuses a PR whose action does
    not declare all three, so a plan-declared suite alone could stage a change
    that could never be opened.

    ORPHAN-CRITICAL-728 — WHAT A PLAN MAY ADD TO IT, and why the rule is not
    "whatever the allowlist happens to pass". These commands are executed by
    ``run_validation_commands``, which runs OUTSIDE the implementer's bwrap
    sandbox, and ``validation_commands`` is plan content: written by one LLM,
    reviewed by others, with no human in the loop. The previous body appended
    any string the allowlist admitted, and the allowlist admits
    ``python3 -m unittest <anything>`` with no target restriction and permits
    a ``PYTHONPATH=`` override — so
    ``PYTHONPATH=/tmp/evil python3 -m unittest payload`` was a plan-authored
    path to an unsandboxed kernel subprocess.

    A plan-declared entry is therefore executed only when it is one of:

      * the canonical suite in either spelling (absorbed, never duplicated);
      * an operator-DECLARED recipe, named by ``recipe_id`` or matched
        byte-for-byte against a registered recipe's command
        (``experiment.register_recipe`` — the same registry the bench runs
        from, which is where a new executable belongs).

    Anything else REFUSES the staging by name. Silently dropping it would be
    the worse failure: the plan would carry a validation claim nothing ever
    ran, and the change ledger would record commands as intended that the
    lane had already decided to ignore.

    ``timeout_ms`` is the ceiling any single command gets, taken as the max of
    the canonical suite's own budget and every declared/recipe budget, so the
    baseline and the candidate are measured under identical conditions.

    Every entry is proven executable HERE, through ``parse_allowed_command`` —
    the function the runner itself calls — before a single ledger row is
    written.
    """
    from .experiment import list_recipes

    recipes = list_recipes(base_dir=base_dir)
    by_id = {str(row.get("recipe_id")): row for row in recipes}
    by_command = {str(row.get("command")): row for row in recipes}

    commands: list[str] = list(CANONICAL_VALIDATION_COMMANDS_EXECUTABLE)
    canonical = set(commands)
    timeout_ms = CANONICAL_VALIDATION_TIMEOUT_MS

    for declared in converged_plan.get("validation_commands") or []:
        if isinstance(declared, dict):
            raw = declared.get("cmd")
            recipe_id = declared.get("recipe_id")
            declared_timeout = declared.get("timeout_ms")
        else:
            raw, recipe_id, declared_timeout = declared, None, None
        if isinstance(declared_timeout, int) and declared_timeout > 0:
            timeout_ms = max(timeout_ms, declared_timeout)

        if isinstance(recipe_id, str) and recipe_id.strip():
            recipe = by_id.get(recipe_id.strip())
            if recipe is None:
                raise GovernanceError(
                    f"stage_validation_recipe_unknown: plan declares "
                    f"recipe_id={recipe_id!r}, which is not a registered "
                    f"experiment recipe; register it with "
                    f"`experiment.register_recipe` (operator-declared) before "
                    f"a plan may have this lane execute it"
                )
            command = str(recipe["command"])
            timeout_ms = max(timeout_ms, int(recipe["timeout_ms"]))
        elif isinstance(raw, str) and raw.strip():
            command = _executable_spelling(raw)
            if command not in canonical:
                recipe = by_command.get(command) or by_command.get(raw.strip())
                if recipe is None:
                    raise GovernanceError(
                        f"stage_validation_command_not_declared: plan-authored "
                        f"command {raw!r} is neither the canonical suite nor a "
                        f"registered experiment recipe. This lane executes it "
                        f"outside the implementer sandbox, so the command set "
                        f"is operator-declared, not plan-declared; register it "
                        f"with `experiment.register_recipe` and name it by "
                        f"recipe_id"
                    )
                timeout_ms = max(timeout_ms, int(recipe["timeout_ms"]))
        else:
            continue
        if command not in commands:
            commands.append(command)

    for command in commands:
        parse_allowed_command(command)
    return commands, timeout_ms


def _intended_files_from_plan(converged_plan: dict[str, Any]) -> list[str]:
    """The change's ``intended_affected_files``, from the plan's own claims.

    Both spellings the repository actually produces are read: ``key_changes``
    entries carry ``paths`` (plan_synthesizer._cluster_changes) or ``file``
    (the aria-implementer contract's shape), and ``affected_surfaces`` is read
    through plan_convergence's own reader so the ledger's file list cannot
    disagree with the list the plan validator accepted.
    """
    from .plan_convergence import affected_surface_paths

    files: set[str] = set(affected_surface_paths(converged_plan.get("affected_surfaces") or []))
    for change in converged_plan.get("key_changes") or []:
        if not isinstance(change, dict):
            continue
        single = change.get("file")
        if isinstance(single, str) and single.strip():
            files.add(single.strip())
        for path in change.get("paths") or []:
            if isinstance(path, str) and path.strip():
                files.add(path.strip())
    if not files:
        raise GovernanceError(
            "stage_plan_declares_no_files: the CONVERGED plan carries neither "
            "affected_surfaces paths nor key_changes paths, so the change "
            "ledger cannot state what this change intends to touch"
        )
    return sorted(files)


def stage_converged_plan_for_pr(
    *,
    plan_id: str,
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Mint the ids a CONVERGED plan needs before it can become a PR.

    ORPHAN-CRITICAL-727 — ``pr_manager.open_pr_for_action`` demands a proposal
    in ``approved_for_apply``, an apply action in ``ready_for_pr`` and a
    ``validation_gate_ref``. The only promoter to ``ready_for_pr`` is
    ``gate_apply_action``, whose callers were CLI-only, and nothing autonomous
    ever recorded a proposal for a converged plan. So the implementer contract
    told the agent to run ``pr create --proposal-id <id> --change-id <id>``
    with ids no producer minted: the last step of the autonomous pipeline was
    unreachable by construction, and every CONVERGED plan died at it.

    This is the missing producer. It records, in one transaction of intent:

      * a proposal, authored by ``plan_convergence`` rather than an operator,
        approved with the machine ref documented at
        ``PLAN_CONVERGED_APPROVAL_PREFIX`` (PR-OPEN scope only — merge
        authority is untouched);
      * a change-chain row whose ``intended_affected_files`` come from the
        plan's own claims, so the ORPHAN-721 completeness gate can later hold
        the implementer to them;
      * the implementation branch name, minted by the single naming authority
        (``mint_unpredictable_feature_branch_name``) — the same grammar the
        push allowlist and the force-push refspec check are written against,
        which the operator lane's ``aria/<slug>`` names do not satisfy;
      * a BASELINE validation run at the current HEAD, recorded through the
        ordinary ``run_validation_commands`` path, so the later gate has a
        left-hand side. Without it ``compare_validation_groups`` has nothing
        to compare and the gate cannot tell "green" from "green because this
        was already red before ARIA touched it".

    ORPHAN-CRITICAL-728 — the plan BODY is no longer a parameter. It came
    from ``ConvergenceResult.converged_plan``, which
    ``convergence_drainer`` sets to ``eval_result.get("plan_content", {})``,
    and ``evaluate_plan`` returns no ``plan_content`` key at all — so in
    production this function was handed ``{}`` and staged a plan with no
    surfaces, no commands and no evidence. It now reads the body from the
    same fold it already takes for the CONVERGED precondition, hash-verified
    against the revision the approval ref names.

    Returns ``{proposal_id, change_id, branch, baseline_ref, base_sha}`` — the
    fields the implementation envelope carries to the agent.
    """
    from .change_ledger import ARCHITECTURAL_TIERS, emit_change_planned
    from .plan_convergence import fold_plan_state, plan_body_from_state
    from .runtime_profile import enforce_profile_for_action

    # ORPHAN-CRITICAL-728 — staging is a governed action: it mints an
    # approval and opens a change chain. It called no profile gate, so it ran
    # identically under `observe`, under `frozen` and with the failure breaker
    # tripped.
    enforce_profile_for_action("plan_stage", base_dir=base_dir)

    state = fold_plan_state(plan_id=plan_id, base_dir=base_dir)
    current_state = state.get("state")
    if current_state != "CONVERGED":
        raise GovernanceError(
            f"stage_requires_converged_plan: plan_id={plan_id!r} is in state "
            f"{current_state!r}; staging mints an approval that CLAIMS "
            f"convergence, so it may only be minted while the claim is true"
        )
    body = plan_body_from_state(state)
    converged_plan = body["plan_content"]
    converged_content_hash = str(body["content_hash"])

    root = Path(workspace_root).resolve()
    commands, timeout_ms = _staged_validation_commands(
        converged_plan, base_dir=base_dir,
    )
    intended_files = _intended_files_from_plan(converged_plan)
    # ORPHAN-CRITICAL-728 — no default tier. The previous body silently
    # substituted 3 whenever the plan did not claim one, and no plan ever
    # claims one by accident: the result was that EVERY autonomous change
    # entered the change ledger as Tier 3 forever, reducing this
    # repository's Tier-1..4 vocabulary to a constant an auditor could not
    # tell from a real claim. A tier the plan did not make is not a tier.
    tier = converged_plan.get("architectural_tier")
    if tier not in ARCHITECTURAL_TIERS:
        raise GovernanceError(
            f"stage_requires_architectural_tier: plan {plan_id!r} claims "
            f"architectural_tier={tier!r}; it must be one of "
            f"{ARCHITECTURAL_TIERS}. The change ledger records the tier as a "
            f"claim about the fix, and staging will not author that claim on "
            f"the plan's behalf — declare it in the plan body, where the "
            f"convergence gate reviews it"
        )

    # ORDER: the change chain and the BASELINE run come before the proposal
    # and its approval. The baseline executes the validation suite, which is
    # the step most likely to refuse (dirty worktree, red repository, a
    # command this lane cannot run) — and an approval minted before it would
    # be an authorisation standing on evidence that never arrived. Both rows
    # written here are inert on their own: a change chain nothing implements
    # and no apply action means `open_pr_for_action` refuses, and
    # `emit_change_planned` is idempotent on (plan_id, finding_id, files).
    planned = emit_change_planned(
        plan_id=plan_id,
        # The plan is its own finding of record unless it names one. Derived
        # rather than defaulted: the `plan:` namespace makes the value a
        # POINTER, and `plan_id` was just folded three lines above, so the id
        # provably resolves to a plan whose state is CONVERGED
        # (pinned by test_the_change_rows_finding_id_resolves_to_the_plan).
        # That is the difference between this and the tier default deleted
        # below — a tier of 3 asserted a property of the change that nobody
        # measured; this asserts an identity that can be looked up.
        finding_id=str(converged_plan.get("finding_id") or PLAN_FINDING_ID_PREFIX + plan_id),
        intended_affected_files=intended_files,
        intended_validation_refs=list(commands),
        architectural_tier=int(tier),
        base_dir=base_dir,
    )
    change_id = str(planned["change_id"])

    branch = mint_unpredictable_feature_branch_name(plan_id)
    base_sha = _git(root, ["rev-parse", "HEAD"])
    baseline = run_validation_commands(
        commands=commands,
        workspace_root=root,
        change_id=change_id,
        commit_sha=base_sha,
        runner_identity=lane_runner_identity(fallback=f"aria-kernel:stage:{plan_id}"),
        base_dir=base_dir,
        timeout_ms=timeout_ms,
    )

    proposal = record_proposal(
        # A converged plan is an architectural change of record. ``self_change``
        # is deliberately NOT derivable from plan content: the kernel-change
        # lane is operator-gated, and READONLY_PATHS refuses kernel writes at
        # envelope mint and again at PR open.
        kind="architecture",
        title=str(converged_plan.get("title") or f"CONVERGED plan {plan_id}"),
        problem=str(converged_plan.get("summary") or f"CONVERGED plan {plan_id}"),
        evidence=[str(ref) for ref in converged_plan.get("evidence_refs") or []],
        validation_command=commands[0],
        validation_commands=commands,
        source_authority="plan_convergence",
        # "unknown" is the CONSERVATIVE class, not a filler: `impact.py`
        # treats it (with "forbidden") as the one that adds
        # `operator_scope_decision_required` to a packet's blocked_by. A plan
        # that has not claimed its risk should read as unclassified
        # downstream, which is exactly what this value means there.
        risk_class=str(converged_plan.get("risk_class") or "unknown"),
        task_id=plan_id,
        proposed_change=str(
            converged_plan.get("summary") or converged_plan.get("title") or plan_id
        ),
        base_dir=base_dir,
    )
    proposal_id = str(proposal["proposal_id"])
    record_machine_approval(
        proposal_id=proposal_id,
        plan_id=plan_id,
        content_hash=converged_content_hash,
        base_dir=base_dir,
    )
    _record_apply_action(
        proposal_id=proposal_id,
        workspace_root=root,
        base_sha=base_sha,
        branch=branch,
        validation_commands=commands,
        changed_files=intended_files,
        # Not ``planned``/``worktree_created``: no worktree was created and no
        # gate has run. ``open_pr_for_action`` refuses anything that is not
        # ``ready_for_pr``, so the staged row is inert until `apply gate` runs.
        status="staged_for_implementation",
        plan_id=plan_id,
        change_id=change_id,
        baseline_validation_ref=str(baseline["ledger_hash"]),
        # The candidate run has to be measured under the same ceiling as the
        # baseline; a gate that timed one side out and not the other would
        # compare two different experiments.
        validation_timeout_ms=timeout_ms,
        base_dir=base_dir,
    )
    return {
        "proposal_id": proposal_id,
        "change_id": change_id,
        "branch": branch,
        "baseline_ref": str(baseline["ledger_hash"]),
        "base_sha": base_sha,
    }


def verify_plan_converged_approval(
    *,
    proposal: dict[str, Any],
    base_dir: str | Path | None = None,
) -> str | None:
    """Join a machine approval back to the convergence event it claims.

    Returns a violation reason, or None when the approval is traceable (or is
    not a machine approval at all — an operator's ref is a different
    population and this function does not judge it).

    ORPHAN-CRITICAL-727/728 — ``record_machine_approval`` is the only writer
    of the machine column and ``approve_proposal`` refuses the reserved
    prefix, so the SOURCE of an approval is now structural. What the prefix
    still cannot prove on its own is that the convergence it names happened:
    the ref's own text is authored, not witnessed. This is the reader that
    makes THAT falsifiable, and ``pr_manager.open_pr_for_action`` calls it so
    an untraceable machine approval cannot buy a PR. Two things must hold:

      * a ``plan_evaluated`` event for that plan_id with terminal_state
        CONVERGED — the approval means "the convergence gate granted this",
        and nothing else may mint it;
      * the ref's content hash among that plan's recorded revision hashes —
        an approval must not name a converged plan while pointing at a body
        that plan never carried.
    """
    if approval_source_of(proposal) != "machine":
        return None
    ref = proposal.get("machine_approval_ref") or proposal.get("operator_approval_ref")
    if not isinstance(ref, str) or not ref.startswith(PLAN_CONVERGED_APPROVAL_PREFIX):
        # approval_source says machine and no machine ref is present: the row
        # claims a grant it cannot name. Fail closed rather than return "not a
        # machine approval" and let it through as an operator's.
        return "machine_approval_ref_absent"
    parsed = parse_plan_converged_approval_ref(ref)
    if parsed is None:
        return "approval_ref_unparseable"
    plan_id, claimed_hash = parsed

    from .plan_convergence import fold_plan_state

    state = fold_plan_state(plan_id=plan_id, base_dir=base_dir)
    events = [event for event in (state.get("events") or []) if isinstance(event, dict)]
    converged = any(
        event.get("event_type") == "plan_evaluated"
        and (event.get("payload") or {}).get("terminal_state") == "CONVERGED"
        for event in events
    )
    if not converged:
        return "no_converged_plan_evaluated_event"
    known_hashes = {
        str((event.get("payload") or {}).get("content_hash")) for event in events
    }
    latest = state.get("latest_revision") or {}
    if latest.get("content_hash"):
        known_hashes.add(str(latest["content_hash"]))
    if claimed_hash not in known_hashes:
        return "content_hash_not_a_recorded_revision"
    return None


def run_apply_gate(
    *,
    proposal_id: str,
    change_id: str,
    base_dir: str | Path | None = None,
    runner_identity: str | None = None,
    cycle_id: str | None = None,
    workspace_root: str | Path | None = None,
) -> dict[str, Any]:
    """Run the candidate validation and promote the action to ``ready_for_pr``.

    ORPHAN-CRITICAL-727 — the reachable half of the gate. The chain is
    candidate validation -> ``compare_validation_groups`` (against the baseline
    the staging recorded) -> ``gate_apply_action``, which is where
    ``evaluate_validation_gate`` runs and where the ``validation_gate_ref``
    that ``open_pr_for_action`` demands is produced. The gate is invoked
    THROUGH ``gate_apply_action`` rather than beside it so exactly one
    validation_gates row exists per gate run; two rows would leave the action
    pointing at one of them and an auditor reading the other.

    ``workspace_root`` overrides the path the staging recorded
    (ORPHAN-CRITICAL-728). Its sibling ``pr create`` already takes one; this
    arm read the ledger row and nothing else, so the gate could only ever run
    on the machine and at the path where staging happened. That is true of
    both GHA jobs today and of nothing else.
    """
    from .runtime_profile import enforce_profile_for_action

    # ORPHAN-CRITICAL-728 — the gate is the promoter to `ready_for_pr`, which
    # is the state `open_pr_for_action` requires. It enforced no profile, so
    # the implementer's Bash allowlist admitted `apply gate` under `observe`,
    # under `frozen` and with the breaker tripped.
    enforce_profile_for_action("apply_gate", base_dir=base_dir)

    action = _latest_action_for_proposal(proposal_id, base_dir)
    if action is None:
        raise GovernanceError(f"apply_gate_no_action: no apply action for {proposal_id!r}")
    staged_change_id = action.get("change_id")
    if staged_change_id and change_id != staged_change_id:
        raise GovernanceError(
            f"apply_gate_change_id_mismatch: action was staged for "
            f"{staged_change_id!r} but the gate was asked to validate "
            f"{change_id!r}; the gate must measure the change the staging opened"
        )
    baseline_ref = action.get("baseline_validation_ref")
    if not baseline_ref:
        raise GovernanceError(
            "apply_gate_no_baseline: the apply action carries no "
            "baseline_validation_ref, so the comparison would have nothing to "
            "compare against and the gate could not tell a fix from a "
            "pre-existing red"
        )
    recorded_root = action.get("workspace_root")
    branch = action.get("branch")
    resolved_root = workspace_root if workspace_root is not None else recorded_root
    if not resolved_root or not branch:
        raise GovernanceError(
            "apply_gate_action_incomplete: workspace_root and branch are "
            "required to resolve the commit the candidate validation ran against"
        )
    root = Path(str(resolved_root)).resolve()
    # ORPHAN-CRITICAL-728 — the gate must run WHERE the implementation is.
    #
    # The previous body passed `commit_sha=rev-parse <branch>` while the
    # commands executed in `root` at whatever HEAD happened to be checked
    # out. With HEAD on main and the implementation committed on the
    # kernel-minted branch, the suite ran against main, passed, and the
    # validation-runs ledger — the ledger the merge gate joins on — recorded
    # every run against the branch tip. The gate then promoted to
    # `ready_for_pr` with a validation_gate_ref for a change nothing had
    # validated. `gate_apply_action`'s non-empty-diff check cannot catch it:
    # `git diff base..branch` is still non-empty.
    #
    # Refusing is the fix rather than silently recording HEAD, because the
    # caller's intent — validate the branch — would otherwise be answered
    # with an honest measurement of the wrong tree.
    head_sha = _git(root, ["rev-parse", "HEAD"])
    branch_sha = _git(root, ["rev-parse", str(branch)])
    if head_sha != branch_sha:
        raise GovernanceError(
            f"apply_gate_head_is_not_the_branch: HEAD is {head_sha} but "
            f"{branch!r} is {branch_sha}; the candidate validation executes in "
            f"the workspace at HEAD, so evidence recorded here would name a "
            f"commit it never ran. Check the branch out "
            f"(`git switch {branch}`) before running the gate"
        )
    candidate = run_validation_commands(
        commands=list(action.get("validation_commands") or []),
        workspace_root=root,
        change_id=change_id,
        commit_sha=branch_sha,
        runner_identity=runner_identity or lane_runner_identity(
            fallback=f"aria-kernel:apply-gate:{proposal_id}",
        ),
        base_dir=base_dir,
        cycle_id=cycle_id,
        # The ceiling the BASELINE was measured under, off the staged row.
        # Two sides measured under different timeouts are not a comparison.
        timeout_ms=int(
            action.get("validation_timeout_ms") or CANONICAL_VALIDATION_TIMEOUT_MS,
        ),
    )
    comparison = compare_validation_groups(
        baseline_ref=str(baseline_ref),
        worktree_ref=str(candidate["ledger_hash"]),
        base_dir=base_dir,
        cycle_id=cycle_id,
    )
    return gate_apply_action(
        proposal_id=proposal_id,
        validation_comparison_ref=str(comparison["ledger_hash"]),
        base_dir=base_dir,
        cycle_id=cycle_id,
        # The OVERRIDE, not the resolved root: with no override the diff
        # reader keeps its existing worktree_path-first fallback, which the
        # operator's separate-worktree lane depends on.
        workspace_root=workspace_root,
    )


def latest_apply_action(
    *, proposal_id: str, base_dir: str | Path | None = None,
) -> dict[str, Any] | None:
    """The most recent apply action for a proposal, whatever its status.

    Public because `cycle.py`'s PR-lifecycle phase has to ask "is this
    proposal's work still in flight" BEFORE it tries to open a PR, and the
    answer lives on the action row. Reading `apply_actions.jsonl` a second
    way in cycle.py would be the parallel path this module exists to avoid.
    """
    return _latest_action_for_proposal(proposal_id, base_dir)


def _latest_action_for_proposal(proposal_id: str, base_dir: str | Path | None) -> dict[str, Any] | None:
    for action in reversed(list_apply_actions(base_dir=base_dir)):
        if action.get("proposal_id") == proposal_id:
            return action
    return None


def _git(cwd: Path, args: list[str]) -> str:
    completed = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise GovernanceError(completed.stderr.strip() or completed.stdout.strip() or "git command failed")
    return completed.stdout.strip()


def _slug(value: str) -> str:
    slug = "".join(ch.lower() if ch.isalnum() else "-" for ch in value).strip("-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug[:48] or "proposal"
