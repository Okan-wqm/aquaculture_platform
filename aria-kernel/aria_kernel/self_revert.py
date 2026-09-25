"""ARIA-HIGH-199 — ARIA reverts a merge of its own that went bad.

WHY. A red post-merge CI (``own_pr_ci.load_post_merge_reds``) or a
``change_outcome`` verdict of ``regression`` only raised pressure. Nothing
opened a revert, and nothing told a red the merge caused apart from a lane
that was already red on ``main`` before it.

TRIGGERS — both only for a merge ARIA ITSELF performed, i.e. one the merge
authority recorded as ``decision == "merged"`` on
``auto-merge-decisions.jsonl``. A PR a person merged (an ARIA branch included)
is the person's; this producer does nothing about it.

* ``post_merge_ci_red`` — the latest ``ci/merge-outcomes.jsonl`` row for the
  PR is ``red`` AND the red is ATTRIBUTABLE: every red job had a run on the
  merge's first parent (``merge_sha^``, resolved by git in the workspace
  after fetching ``main``) on ``main``, and every such run concluded
  ``success`` — read through the same checks reader
  (``runs_for_commit``) the post-merge scan used. A job with no parent run,
  or with a parent run that was not green, makes the red NOT attributable:
  no freeze, no revert, and a ``not_attributable`` row naming the jobs, so
  the decision is visible. It is not terminal — the parent's runs may still
  complete — and it is recorded once per distinct evidence.
* ``change_outcome_regression`` — a ``change_outcome`` row with verdict
  ``regression`` for the change bound to the merged PR. The verdict is
  already an attribution (``change_outcome`` consumes the regression
  detector's event for the change's finding after its merge); the merge sha
  is read from the post-merge ledger's row for that PR.

IDEMPOTENCY. One key per merge, ``revert:<merge_sha>``, on the declared
ledger ``enterprise/self-reverts.jsonl`` (surface ``enterprise_self_reverts``).
Once a terminal decision is recorded for the key, every later trigger for
the same merge is a no-op. A red on a merge that was itself one of these
reverts (an ``aria/revert/*`` head, or a PR this producer opened) never
produces a revert of the revert: it freezes self-merge for that merge too,
records ``revert_of_revert_refused`` and asks a human.

ORDER. The freeze (``self_merge_freeze.freeze_self_merge``) is written
BEFORE any git or PR effect, and it always lands whatever the runtime
profile. Everything after it respects the profile: a profile without
``pr_create`` records ``revert_not_permitted_by_profile`` and asks a human.

MECHANISM. In a throwaway worktree of the workspace (the checkout the cycle
runs in is never moved): branch ``aria/revert/<sha12>`` from ``origin/main``,
``git revert --no-edit <merge_sha>`` under the producer's own committer
identity with hooks off. A conflict is aborted (``git revert --abort``),
recorded ``revert_conflict``, the freeze stays, a HUMAN_REQUIRED record is
opened and no PR is made. PURITY: the ``git patch-id --stable`` of the
revert commit's diff must equal that of ``git diff <merge_sha> <merge_sha>^``
AND the two diffs must name the same files; an impure revert (``main`` moved
under the hunk) is recorded ``revert_impure``, with both patch ids, and no
PR is made.

DELIVERY — the same authority an implementation is delivered under. Inside
``delivery_credentials.hold_delivery_credentials`` (consumer
``self_revert_delivery``): the revert is opened as a change of the change
ledger's own kind (``emit_change_planned`` with the reverted files as its
intended files, the reverted change's finding and tier, ``rollback_ref`` =
the merge sha; ``emit_change_committed`` at the revert tip), the branch is
pushed with an intent/receipt pair, and the PR is opened through
``pr_manager.open_revert_pr`` — the ``pr_create`` gate, the full pre-PR-open
perimeter, the change-id anchor and the one intent/receipt-bracketed
``gh pr create`` that ``open_pr_for_action`` also uses. Then
``register_revert`` names this PR at this head as the one PR the freeze
admits.

WHAT THIS PRODUCER DOES NOT SUPPLY. The merge authority's triple gate also
needs a ``change_validated`` row and verified ``validation_runs`` for the
revert's change_id. Those are recorded from validation RUNS, and this
producer runs no suite: a revert restores ``merge_sha^``, whose own runs
the attribution just read green, but the triple gate asks for runs bound to
THIS change and none exist yet. It does not fake them. The revert PR
therefore waits in the ordinary merge lane — which refuses it
``triple_gate_change_validated_missing`` until that evidence exists — and
an operator can merge it on GitHub at once (the freeze binds only ARIA's
merges). No producer records validation runs for a proposal-less change:
ARIA-HIGH-196 writes ``change_validated`` from
``validation_runs_ledger.refs_for_change`` inside
``implementation_delivery`` only, after the apply gate ran the suite for a
staged proposal. Until a producer binds the revert PR's own canonical-suite
runs to its change_id, ARIA cannot merge its own revert; that producer is
the open remainder of ARIA-HIGH-199.

LANDING. When a revert this producer opened is merged by ARIA and its own
post-merge outcome is green, a ``revert_landed`` row and one
``rollback_success`` acceptance event are recorded. The freeze stays: only
an operator lifts it (``merge-lane unfreeze``).
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

from .git_containment import KERNEL_GIT_NO_HOOKS_ARGS
from .ledger import append_declared_jsonl, load_declared_jsonl
from .pr_manager import REVERT_BRANCH_PREFIX
from .self_merge_freeze import freeze_self_merge, register_revert
from .state_store import GIT_TIMEOUT_SECONDS
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir, utc_now

SELF_REVERTS_SURFACE = "enterprise_self_reverts"
SELF_REVERTS_RELPATH = ("enterprise", "self-reverts.jsonl")

TRIGGER_POST_MERGE_CI = "post_merge_ci_red"
TRIGGER_CHANGE_OUTCOME = "change_outcome_regression"
TRIGGERS: tuple[str, ...] = (TRIGGER_POST_MERGE_CI, TRIGGER_CHANGE_OUTCOME)

DECISION_NOT_ATTRIBUTABLE = "not_attributable"
DECISION_REVERT_OF_REVERT = "revert_of_revert_refused"
DECISION_NOT_PERMITTED = "revert_not_permitted_by_profile"
DECISION_UNBOUND = "reverted_change_unbound"
DECISION_CONFLICT = "revert_conflict"
DECISION_FAILED = "revert_failed"
DECISION_IMPURE = "revert_impure"
DECISION_CREDENTIAL_UNAVAILABLE = "revert_credential_unavailable"
DECISION_DELIVERY_FAILED = "revert_delivery_failed"
DECISION_OPENED = "revert_opened"
DECISION_LANDED = "revert_landed"
# A terminal decision closes the merge's key: no later trigger acts on it.
TERMINAL_DECISIONS: frozenset[str] = frozenset({
    DECISION_REVERT_OF_REVERT, DECISION_NOT_PERMITTED, DECISION_UNBOUND, DECISION_CONFLICT,
    DECISION_FAILED, DECISION_IMPURE, DECISION_DELIVERY_FAILED, DECISION_OPENED,
})
# The decisions a person has to act on: each opens a HUMAN_REQUIRED record.
HUMAN_REQUIRED_DECISIONS: frozenset[str] = TERMINAL_DECISIONS - {DECISION_OPENED}

# The producer's own commit identity: never the ambient one, which a CI
# runner does not configure, and never a person's.
REVERT_COMMITTER_NAME = "aria-self-revert"
REVERT_COMMITTER_EMAIL = "aria-self-revert@users.noreply.github.com"
_REMOTE = "origin"
_MAIN = "main"
_GREEN = "success"


@dataclass(frozen=True)
class SelfRevertDeliveryGrant:
    """Who holds the delivery credential for a revert: the kernel's revert
    producer, whose external write is exactly one push and one PR. The
    ``pr_create`` profile gate has already passed when this is presented."""

    profile_id: str = "kernel_self_revert"
    external_writes: bool = True


@dataclass(frozen=True)
class _Candidate:
    trigger: str
    pr_number: int
    merge_sha: str
    head_ref: str
    evidence: dict[str, Any]


class _Terminal(Exception):
    """A terminal decision reached inside the revert mechanism."""

    def __init__(self, decision: str, detail: dict[str, Any]) -> None:
        super().__init__(decision)
        self.decision = decision
        self.detail = detail


# ---------------------------------------------------------------- ledger


def self_reverts_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir).joinpath(*SELF_REVERTS_RELPATH)


def load_self_reverts(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    path = self_reverts_path(base_dir)
    if not path.exists():
        return []
    return load_declared_jsonl(path, expected_surface=SELF_REVERTS_SURFACE)


def revert_key_for(merge_sha: str) -> str:
    return f"revert:{merge_sha}"


def revert_branch_for(merge_sha: str) -> str:
    return f"{REVERT_BRANCH_PREFIX}{merge_sha[:12]}"


def _human_required_id(merge_sha: str) -> str:
    return f"self-revert-{merge_sha[:12]}"


def _digest(payload: Any) -> str:
    text = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def _record(
    candidate: _Candidate,
    decision: str,
    *,
    cycle_id: str,
    base_dir: str | Path | None,
    detail: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "key": revert_key_for(candidate.merge_sha),
        "decision": decision,
        "terminal": decision in TERMINAL_DECISIONS,
        "trigger": candidate.trigger,
        "pr_number": candidate.pr_number,
        "merge_sha": candidate.merge_sha,
        "head_ref": candidate.head_ref,
        "evidence": dict(candidate.evidence),
        **dict(detail or {}),
    }
    persisted = append_declared_jsonl(self_reverts_path(base_dir), row, expected_surface=SELF_REVERTS_SURFACE)
    append_tools_governance(
        ensure_tools_dir(base_dir),
        "self_revert_decided",
        {"key": row["key"], "decision": decision, "trigger": candidate.trigger,
         "pr_number": candidate.pr_number, "merge_sha": candidate.merge_sha},
    )
    if decision in HUMAN_REQUIRED_DECISIONS:
        from .human_required import record_human_required

        record_human_required(
            request_id=_human_required_id(candidate.merge_sha),
            severity="HIGH",
            reason=(
                f"ARIA merge {candidate.merge_sha[:12]} (PR #{candidate.pr_number}) went bad "
                f"({candidate.trigger}); self-merge is frozen and the self-revert stopped at {decision}"
            ),
            context={"kind": "self_revert", "decision": decision, "key": row["key"],
                     "pr_number": candidate.pr_number, "merge_sha": candidate.merge_sha},
            base_dir=base_dir,
        )
    return persisted


# ---------------------------------------------------------------- git


def _git(
    args: list[str],
    *,
    cwd: Path,
    env: Mapping[str, str] | None = None,
    input_text: str | None = None,
) -> subprocess.CompletedProcess[str]:
    """One git subprocess of the producer, hooks off, bounded."""
    return subprocess.run(
        ["git", *KERNEL_GIT_NO_HOOKS_ARGS, *args], cwd=str(cwd), env=dict(env) if env is not None else None,
        input=input_text, capture_output=True, text=True, check=False, timeout=GIT_TIMEOUT_SECONDS,
    )


def _first_line(text: str | None) -> str:
    return ((text or "").strip().splitlines() or ["?"])[0][:200]


def _resolve_merge(workspace: Path, merge_sha: str) -> tuple[str, str] | str:
    """``(first_parent, origin_main)`` for a merge on main, or why not."""
    fetched = _git(["fetch", "--no-tags", _REMOTE, f"+refs/heads/{_MAIN}:refs/remotes/{_REMOTE}/{_MAIN}"], cwd=workspace)
    if fetched.returncode != 0:
        return f"fetch_failed:{_first_line(fetched.stderr)}"
    main = _git(["rev-parse", "--verify", f"refs/remotes/{_REMOTE}/{_MAIN}^{{commit}}"], cwd=workspace)
    if main.returncode != 0:
        return f"origin_main_unresolvable:{_first_line(main.stderr)}"
    on_main = _git(["merge-base", "--is-ancestor", merge_sha, f"refs/remotes/{_REMOTE}/{_MAIN}"], cwd=workspace)
    if on_main.returncode != 0:
        return "merge_sha_not_on_main"
    parents = _git(["rev-list", "--parents", "-n", "1", merge_sha], cwd=workspace)
    tokens = parents.stdout.split()
    if parents.returncode != 0 or len(tokens) < 2:
        return "merge_parent_unresolvable"
    return tokens[1], main.stdout.strip()


def _patch_id(workspace: Path, old: str, new: str) -> tuple[str, list[str]]:
    diff = _git(["diff", old, new], cwd=workspace)
    names = _git(["diff", "--name-only", old, new], cwd=workspace)
    if diff.returncode != 0 or names.returncode != 0:
        raise _Terminal(DECISION_FAILED, {"reason": f"diff_unresolvable:{_first_line(diff.stderr or names.stderr)}"})
    patch_id = ""
    if diff.stdout.strip():
        computed = _git(["patch-id", "--stable"], cwd=workspace, input_text=diff.stdout)
        patch_id = (computed.stdout.split() or [""])[0]
    return patch_id, sorted(line for line in names.stdout.splitlines() if line.strip())


def prove_revert_purity(*, workspace: Path, merge_sha: str, revert_sha: str) -> dict[str, Any]:
    """The revert commit is exactly the inverse of the merge: equal stable
    patch ids and the same file set, both non-empty."""
    revert_patch_id, revert_files = _patch_id(workspace, f"{revert_sha}^", revert_sha)
    inverse_patch_id, inverse_files = _patch_id(workspace, merge_sha, f"{merge_sha}^")
    pure = bool(revert_patch_id) and revert_patch_id == inverse_patch_id and bool(revert_files) \
        and revert_files == inverse_files
    return {
        "pure": pure,
        "revert_sha": revert_sha,
        "revert_patch_id": revert_patch_id,
        "inverse_patch_id": inverse_patch_id,
        "revert_files": revert_files,
        "inverse_files": inverse_files,
    }


# ---------------------------------------------------------------- triggers


def _aria_merged_prs(base_dir: str | Path | None) -> set[int]:
    path = ensure_tools_dir(base_dir) / "auto-merge-decisions.jsonl"
    if not path.exists():
        return set()
    return {
        int(row["pr_number"])
        for row in load_declared_jsonl(path, expected_surface="auto_merge_decisions")
        if row.get("decision") == "merged" and isinstance(row.get("pr_number"), int)
    }


def _latest_merge_outcomes(base_dir: str | Path | None) -> dict[int, dict[str, Any]]:
    from .own_pr_ci import merge_outcomes_path

    path = merge_outcomes_path(base_dir)
    if not path.exists():
        return {}
    latest: dict[int, dict[str, Any]] = {}
    for row in load_declared_jsonl(path, expected_surface="merge_outcomes"):
        if isinstance(row.get("pr_number"), int):
            latest[int(row["pr_number"])] = row
    return latest


def _post_merge_candidates(base_dir: str | Path | None) -> list[_Candidate]:
    from .own_pr_ci import load_post_merge_reds

    return [
        _Candidate(
            trigger=TRIGGER_POST_MERGE_CI,
            pr_number=int(row["pr_number"]),
            merge_sha=str(row.get("merge_sha") or ""),
            head_ref=str(row.get("head_ref") or ""),
            evidence={"red_jobs": list(row.get("red_jobs") or []), "merge_outcome_hash": row.get("ledger_hash")},
        )
        for row in load_post_merge_reds(base_dir=base_dir)
        if row.get("merge_sha")
    ]


def _regression_candidates(
    base_dir: str | Path | None, skipped: list[dict[str, Any]],
) -> list[_Candidate]:
    from .change_outcome import list_change_outcomes

    outcomes = _latest_merge_outcomes(base_dir)
    candidates: list[_Candidate] = []
    for row in list_change_outcomes(base_dir=base_dir):
        if row.get("verdict") != "regression":
            continue
        pr_number = row.get("merged_pr_number")
        if not isinstance(pr_number, int):
            skipped.append({"change_id": row.get("change_id"), "reason": "regression_without_merged_pr"})
            continue
        merge_row = outcomes.get(pr_number)
        if merge_row is None or not merge_row.get("merge_sha"):
            skipped.append({"pr_number": pr_number, "reason": "merge_sha_unresolved"})
            continue
        candidates.append(_Candidate(
            trigger=TRIGGER_CHANGE_OUTCOME,
            pr_number=pr_number,
            merge_sha=str(merge_row["merge_sha"]),
            head_ref=str(merge_row.get("head_ref") or ""),
            evidence={"change_id": row.get("change_id"), "change_outcome_hash": row.get("ledger_hash")},
        ))
    return candidates


def _attribution(
    reader: Any, *, red_jobs: Sequence[str], parent_sha: str,
) -> dict[str, list[str]]:
    """Red jobs whose parent runs do not prove main was green before the
    merge, each with the parent conclusions seen (empty: no run at all)."""
    parent_runs = [
        run for run in reader.runs_for_commit(parent_sha)
        if str(run.get("headBranch") or "") == _MAIN
    ]
    unattributable: dict[str, list[str]] = {}
    for job in red_jobs:
        conclusions = sorted(str(run.get("conclusion")) for run in parent_runs if str(run.get("name")) == job)
        if not conclusions or any(conclusion != _GREEN for conclusion in conclusions):
            unattributable[job] = conclusions
    return unattributable


# ---------------------------------------------------------------- producer


def run_self_revert_producer(
    *,
    cycle_id: str,
    base_dir: str | Path | None,
    workspace_root: str | Path,
    reader: Any | None,
    triggers: Sequence[str],
) -> dict[str, Any]:
    """Act on every bad ARIA merge the named triggers see; see module doc."""
    unknown = sorted(set(triggers) - set(TRIGGERS))
    if unknown:
        raise GovernanceError(f"self_revert_unknown_triggers:{unknown}")
    workspace = Path(workspace_root).resolve()
    skipped: list[dict[str, Any]] = []
    decisions: list[dict[str, Any]] = []
    candidates: list[_Candidate] = []
    if TRIGGER_POST_MERGE_CI in triggers:
        candidates.extend(_post_merge_candidates(base_dir))
    if TRIGGER_CHANGE_OUTCOME in triggers:
        candidates.extend(_regression_candidates(base_dir, skipped))
    aria_merged = _aria_merged_prs(base_dir)
    for candidate in candidates:
        if candidate.pr_number not in aria_merged:
            skipped.append({"pr_number": candidate.pr_number, "reason": "not_an_aria_merge"})
            continue
        row = _decide(candidate, cycle_id=cycle_id, base_dir=base_dir, workspace=workspace,
                      reader=reader, skipped=skipped)
        if row is not None:
            decisions.append(row)
    if TRIGGER_POST_MERGE_CI in triggers:
        decisions.extend(_record_landed_reverts(cycle_id=cycle_id, base_dir=base_dir, aria_merged=aria_merged))
    return {"status": "ran", "triggers": list(triggers), "decisions": decisions, "skipped": skipped}


def _decide(
    candidate: _Candidate,
    *,
    cycle_id: str,
    base_dir: str | Path | None,
    workspace: Path,
    reader: Any | None,
    skipped: list[dict[str, Any]],
) -> dict[str, Any] | None:
    key = revert_key_for(candidate.merge_sha)
    ledger = load_self_reverts(base_dir=base_dir)
    rows = [row for row in ledger if row.get("key") == key]
    if any(row.get("decision") in TERMINAL_DECISIONS for row in rows):
        return None
    opened_reverts = {row.get("pr_number_opened") for row in ledger if row.get("decision") == DECISION_OPENED}
    if candidate.head_ref.startswith(REVERT_BRANCH_PREFIX) or candidate.pr_number in opened_reverts:
        freeze_self_merge(merge_sha=candidate.merge_sha, pr_number=candidate.pr_number,
                          trigger=candidate.trigger, evidence=candidate.evidence, base_dir=base_dir)
        return _record(candidate, DECISION_REVERT_OF_REVERT, cycle_id=cycle_id, base_dir=base_dir)

    if candidate.trigger == TRIGGER_POST_MERGE_CI:
        # Attribution needs the parent's runs; without a reader there is no
        # attribution and therefore nothing to act on.
        if reader is None:
            skipped.append({"pr_number": candidate.pr_number, "reason": "reader_absent"})
            return None
        readable, why = reader.readable()
        if not readable:
            skipped.append({"pr_number": candidate.pr_number, "reason": f"reader_unreadable:{why}"})
            return None
    resolved = _resolve_merge(workspace, candidate.merge_sha)
    if isinstance(resolved, str):
        skipped.append({"pr_number": candidate.pr_number, "reason": resolved})
        return None
    parent_sha, origin_main = resolved

    if candidate.trigger == TRIGGER_POST_MERGE_CI:
        unattributable = _attribution(reader, red_jobs=candidate.evidence.get("red_jobs") or [], parent_sha=parent_sha)
        if unattributable:
            evidence = {**candidate.evidence, "parent_sha": parent_sha, "unattributable_jobs": unattributable}
            digest = _digest(evidence)
            if any(row.get("decision") == DECISION_NOT_ATTRIBUTABLE and row.get("evidence_digest") == digest
                   for row in rows):
                return None
            return _record(
                _Candidate(candidate.trigger, candidate.pr_number, candidate.merge_sha, candidate.head_ref, evidence),
                DECISION_NOT_ATTRIBUTABLE, cycle_id=cycle_id, base_dir=base_dir,
                detail={"evidence_digest": digest},
            )
    candidate = _Candidate(
        candidate.trigger, candidate.pr_number, candidate.merge_sha, candidate.head_ref,
        {**candidate.evidence, "parent_sha": parent_sha},
    )

    # The freeze, before any git or PR effect; it lands under every profile.
    freeze = freeze_self_merge(merge_sha=candidate.merge_sha, pr_number=candidate.pr_number,
                               trigger=candidate.trigger, evidence=candidate.evidence, base_dir=base_dir)
    from .runtime_profile import enforce_profile_for_action

    try:
        enforce_profile_for_action("pr_create", base_dir=base_dir)
    except GovernanceError as exc:
        return _record(candidate, DECISION_NOT_PERMITTED, cycle_id=cycle_id, base_dir=base_dir,
                       detail={"reason": str(exc)[:300]})
    reverted = _reverted_change(candidate.pr_number, base_dir=base_dir)
    if reverted is None:
        return _record(candidate, DECISION_UNBOUND, cycle_id=cycle_id, base_dir=base_dir)
    try:
        return _revert_and_deliver(
            candidate, freeze_id=str(freeze["freeze_id"]), origin_main=origin_main, reverted=reverted,
            cycle_id=cycle_id, base_dir=base_dir, workspace=workspace,
        )
    except _Terminal as terminal:
        return _record(candidate, terminal.decision, cycle_id=cycle_id, base_dir=base_dir, detail=terminal.detail)


def _reverted_change(pr_number: int, *, base_dir: str | Path | None) -> dict[str, Any] | None:
    from .auto_merge import change_for_pr
    from .change_ledger import _find_planned

    change_id = change_for_pr(pr_number, base_dir=base_dir)
    if not change_id:
        return None
    return _find_planned(ensure_tools_dir(base_dir), change_id)


def _revert_and_deliver(
    candidate: _Candidate,
    *,
    freeze_id: str,
    origin_main: str,
    reverted: dict[str, Any],
    cycle_id: str,
    base_dir: str | Path | None,
    workspace: Path,
) -> dict[str, Any] | None:
    branch = revert_branch_for(candidate.merge_sha)
    holder = Path(tempfile.mkdtemp(prefix="aria-self-revert-"))
    worktree = holder / "worktree"
    added = False
    try:
        created = _git(["worktree", "add", "-b", branch, str(worktree), origin_main], cwd=workspace)
        if created.returncode != 0:
            raise _Terminal(DECISION_FAILED, {"reason": f"worktree_add_failed:{_first_line(created.stderr)}"})
        added = True
        reverting = _git(
            ["-c", f"user.name={REVERT_COMMITTER_NAME}", "-c", f"user.email={REVERT_COMMITTER_EMAIL}",
             "-c", "commit.gpgsign=false", "revert", "--no-edit", candidate.merge_sha],
            cwd=worktree,
        )
        if reverting.returncode != 0:
            unmerged = _git(["diff", "--name-only", "--diff-filter=U"], cwd=worktree)
            conflicted = sorted(line for line in unmerged.stdout.splitlines() if line.strip())
            aborted = _git(["revert", "--abort"], cwd=worktree)
            if conflicted:
                raise _Terminal(DECISION_CONFLICT, {"conflicted_files": conflicted,
                                                    "aborted": aborted.returncode == 0, "base_sha": origin_main})
            raise _Terminal(DECISION_FAILED, {"reason": f"revert_failed:{_first_line(reverting.stderr)}"})
        revert_sha = _git(["rev-parse", "HEAD"], cwd=worktree).stdout.strip()
        purity = prove_revert_purity(workspace=worktree, merge_sha=candidate.merge_sha, revert_sha=revert_sha)
        if not purity["pure"]:
            raise _Terminal(DECISION_IMPURE, {"purity": purity, "base_sha": origin_main})
        opened = _deliver(
            candidate, branch=branch, revert_sha=revert_sha, origin_main=origin_main, purity=purity,
            reverted=reverted, cycle_id=cycle_id, base_dir=base_dir, workspace=workspace,
        )
        if opened is None:
            return None
        register_revert(freeze_id=freeze_id, pr_number=int(opened["pr_number"]), head_sha=revert_sha,
                        purity=purity, base_dir=base_dir)
        return _record(candidate, DECISION_OPENED, cycle_id=cycle_id, base_dir=base_dir, detail={
            "branch": branch, "base_sha": origin_main, "head_sha": revert_sha, "purity": purity,
            "change_id": opened["change_id"], "pr_number_opened": int(opened["pr_number"]),
            "pr_url": opened.get("url"), "freeze_id": freeze_id,
        })
    finally:
        if added:
            # The worktree and the local branch are scaffolding: the pushed
            # branch lives on the remote, and a refusal before the push
            # leaves nothing for a later attempt to collide with.
            _git(["worktree", "remove", "--force", str(worktree)], cwd=workspace)
            _git(["branch", "-D", branch], cwd=workspace)
        shutil.rmtree(holder, ignore_errors=True)


def _deliver(
    candidate: _Candidate,
    *,
    branch: str,
    revert_sha: str,
    origin_main: str,
    purity: dict[str, Any],
    reverted: dict[str, Any],
    cycle_id: str,
    base_dir: str | Path | None,
    workspace: Path,
) -> dict[str, Any] | None:
    """Change ledger, push and PR inside one credential hold. Returns the
    opened lifecycle row (with ``change_id``), or None when the credential
    could not be minted — recorded, not terminal: nothing reached the
    change ledger or the remote, so a later cycle can try again."""
    from .change_ledger import emit_change_committed, emit_change_planned
    from .delivery_credentials import (
        DELIVERY_CREDENTIAL_CONSUMPTION_SECONDS,
        DELIVERY_CREDENTIAL_SELF_REVERT_CONSUMER,
        DeliveryCredentialError,
        hold_delivery_credentials,
    )
    from .implementation_safety import CANONICAL_VALIDATION_COMMANDS
    from .pr_manager import open_revert_pr
    from .recovery import record_intent, record_receipt

    request_id = f"self-revert:{candidate.merge_sha[:12]}"
    files = list(purity["revert_files"])
    with ExitStack() as credential_hold:
        try:
            credential = credential_hold.enter_context(hold_delivery_credentials(
                profile=SelfRevertDeliveryGrant(), request_id=request_id, cycle_id=cycle_id,
                workspace_root=workspace, base_dir=base_dir, covers_seconds=DELIVERY_CREDENTIAL_CONSUMPTION_SECONDS,
                consumer=DELIVERY_CREDENTIAL_SELF_REVERT_CONSUMER,
            ))
        except DeliveryCredentialError as exc:
            reason = str(exc)[:300]
            already = any(
                row.get("key") == revert_key_for(candidate.merge_sha)
                and row.get("decision") == DECISION_CREDENTIAL_UNAVAILABLE and row.get("reason") == reason
                for row in load_self_reverts(base_dir=base_dir)
            )
            if not already:
                _record(candidate, DECISION_CREDENTIAL_UNAVAILABLE, cycle_id=cycle_id, base_dir=base_dir,
                        detail={"reason": reason})
            return None
        credential_env: dict[str, str] = dict(credential.env) if credential is not None else {}
        try:
            planned = emit_change_planned(
                plan_id=f"self-revert:{candidate.merge_sha}",
                finding_id=str(reverted["finding_id"]),
                intended_affected_files=files,
                intended_validation_refs=list(CANONICAL_VALIDATION_COMMANDS),
                rollback_ref=candidate.merge_sha,
                architectural_tier=int(reverted["architectural_tier"]),
                intended_request_id=request_id,
                base_dir=base_dir,
            )
            change_id = str(planned["change_id"])
            emit_change_committed(change_id=change_id, commit_sha=revert_sha, actual_affected_files=files,
                                  base_dir=base_dir)
        except GovernanceError as exc:
            raise _Terminal(DECISION_DELIVERY_FAILED, {"reason": f"change_ledger_refused:{str(exc)[:300]}",
                                                       "purity": purity}) from exc
        intent = record_intent(
            request_id=request_id, effect_kind="git_push", target=f"{_REMOTE}/{branch}",
            intended_postcondition={"branch": branch, "remote": _REMOTE, "head_sha": revert_sha, "change_id": change_id},
            base_dir=base_dir,
        )
        push = _git(["push", _REMOTE, f"refs/heads/{branch}:refs/heads/{branch}"], cwd=workspace,
                    env={**os.environ, **credential_env})
        if push.returncode != 0:
            record_receipt(operation_id=str(intent["operation_id"]), request_id=request_id,
                           observed={"returncode": push.returncode, "stderr": (push.stderr or "")[:400]},
                           status="failed", base_dir=base_dir)
            raise _Terminal(DECISION_DELIVERY_FAILED, {"reason": f"push_failed:{_first_line(push.stderr)}",
                                                       "change_id": change_id, "purity": purity})
        record_receipt(operation_id=str(intent["operation_id"]), request_id=request_id,
                       observed={"branch": branch, "remote": _REMOTE, "head_sha": revert_sha},
                       status="confirmed", base_dir=base_dir)
        try:
            opened = open_revert_pr(
                workspace_root=workspace, branch=branch, base_sha=origin_main,
                title=f"Revert ARIA merge {candidate.merge_sha[:12]} (PR #{candidate.pr_number})",
                body=_pr_body(candidate, branch=branch, purity=purity, change_id=change_id),
                change_id=change_id, changed_files=files,
                validation_commands=list(CANONICAL_VALIDATION_COMMANDS), request_id=request_id,
                base_dir=base_dir, command_environment=credential_env or None,
            )
        except GovernanceError as exc:
            raise _Terminal(DECISION_DELIVERY_FAILED, {"reason": f"pr_open_refused:{str(exc)[:300]}",
                                                       "change_id": change_id, "purity": purity,
                                                       "branch_pushed": branch}) from exc
    return {**opened, "change_id": change_id}


def _pr_body(candidate: _Candidate, *, branch: str, purity: dict[str, Any], change_id: str) -> str:
    evidence = "\n".join(f"- `{key}`: `{value}`" for key, value in sorted(candidate.evidence.items()))
    files = "\n".join(f"- `{path}`" for path in purity["revert_files"])
    return "\n".join([
        "## Problem",
        f"ARIA merged PR #{candidate.pr_number} as `{candidate.merge_sha}` and the merge went bad "
        f"(`{candidate.trigger}`). Self-merge is frozen until an operator lifts it.",
        "",
        "## Evidence",
        evidence or "- none recorded",
        "",
        "## Solution",
        f"`git revert --no-edit {candidate.merge_sha}` on `{branch}`, from `origin/main`. Files:",
        files,
        "",
        "## Validation",
        f"- Purity: revert patch-id `{purity['revert_patch_id']}` equals the inverse patch-id "
        f"`{purity['inverse_patch_id']}`; the file sets are identical.",
        "- CI on this PR runs the canonical suite.",
        "",
        "## Baseline Comparison",
        f"- The merge's first parent `{candidate.evidence.get('parent_sha')}` is the state this restores.",
        "",
        "## Rollback",
        f"- Re-apply `{candidate.merge_sha}` (a revert of this revert is never produced automatically).",
        "",
        "## Provenance",
        f"- Producer: `aria_kernel.self_revert`; change `{change_id}`; key `{revert_key_for(candidate.merge_sha)}`.",
        "",
    ])


def _record_landed_reverts(
    *, cycle_id: str, base_dir: str | Path | None, aria_merged: set[int],
) -> list[dict[str, Any]]:
    """A revert ARIA merged whose own post-merge outcome is green landed:
    one ``revert_landed`` row and one ``rollback_success`` event."""
    from .autonomy_unlock import record_acceptance_event

    rows = load_self_reverts(base_dir=base_dir)
    landed = {row.get("key") for row in rows if row.get("decision") == DECISION_LANDED}
    outcomes = _latest_merge_outcomes(base_dir)
    recorded: list[dict[str, Any]] = []
    for row in rows:
        if row.get("decision") != DECISION_OPENED or row.get("key") in landed:
            continue
        revert_pr = row.get("pr_number_opened")
        outcome = outcomes.get(revert_pr) if isinstance(revert_pr, int) else None
        if revert_pr not in aria_merged or outcome is None or outcome.get("status") != "green":
            continue
        candidate = _Candidate(
            trigger=str(row.get("trigger") or ""), pr_number=int(row["pr_number"]),
            merge_sha=str(row["merge_sha"]), head_ref=str(row.get("head_ref") or ""),
            evidence=dict(row.get("evidence") or {}),
        )
        recorded.append(_record(candidate, DECISION_LANDED, cycle_id=cycle_id, base_dir=base_dir, detail={
            "pr_number_opened": revert_pr, "revert_merge_sha": outcome.get("merge_sha"),
            "head_sha": row.get("head_sha"),
        }))
        record_acceptance_event(event_type="rollback_success", base_dir=base_dir, pr_number=revert_pr,
                                head_sha=str(row.get("head_sha") or ""), reason=str(row.get("key")))
    return recorded


__all__ = [
    "DECISION_CONFLICT",
    "DECISION_CREDENTIAL_UNAVAILABLE",
    "DECISION_DELIVERY_FAILED",
    "DECISION_FAILED",
    "DECISION_IMPURE",
    "DECISION_LANDED",
    "DECISION_NOT_ATTRIBUTABLE",
    "DECISION_NOT_PERMITTED",
    "DECISION_OPENED",
    "DECISION_REVERT_OF_REVERT",
    "DECISION_UNBOUND",
    "SELF_REVERTS_SURFACE",
    "SelfRevertDeliveryGrant",
    "TERMINAL_DECISIONS",
    "TRIGGERS",
    "TRIGGER_CHANGE_OUTCOME",
    "TRIGGER_POST_MERGE_CI",
    "load_self_reverts",
    "prove_revert_purity",
    "revert_branch_for",
    "revert_key_for",
    "run_self_revert_producer",
    "self_reverts_path",
]
