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
  PR is ``red`` AND the red is ATTRIBUTABLE: it names at least one red job,
  and for every red job the NEAREST first-parent ancestor of the merge on
  ``main`` that ran that workflow (walking from ``merge_sha^``, at most
  ``ATTRIBUTION_ANCESTOR_LIMIT`` commits, resolved by git in the workspace
  after fetching ``main``) concluded ``success`` on every run — read through
  the same checks reader (``runs_for_commit``) the post-merge scan used. The
  nearest ancestor, not the parent alone, because a path-filtered workflow
  has no run on a commit that did not touch its paths, and the parent of a
  merge usually is such a commit (ARIA-MEDIUM-228). A red that names no job,
  a job no ancestor inside the bound ran, or a nearest run that was not
  green makes the red NOT attributable: no freeze, no revert, and a
  ``not_attributable`` row naming the jobs, so the decision is visible. It
  is not terminal — runs may still complete — and it is recorded once per
  distinct evidence.
* ``change_outcome_regression`` — a ``change_outcome`` row with verdict
  ``regression`` for the change bound to the merged PR. The verdict is
  already an attribution (``change_outcome`` consumes the regression
  detector's event for the change's finding after its merge); the merge sha
  is read from the post-merge ledger's row for that PR. So the freeze is
  written FIRST, before the fetch that resolves the merge on ``main``: a
  remote that cannot be read never delays a freeze the evidence already
  earned.

IDEMPOTENCY. One key per merge, ``revert:<merge_sha>``, on the declared
ledger ``enterprise/self-reverts.jsonl`` (surface ``enterprise_self_reverts``).
Once a terminal decision is recorded for the key, every later trigger for
the same merge is a no-op. A non-terminal decision (``RETRIED_DECISIONS``) is
recorded once per distinct reason and the key is tried again next time. A red
on a merge that was itself one of these reverts (an ``aria/revert/*`` head, or
a PR this producer opened) never produces a revert of the revert: it freezes
self-merge for that merge too, records ``revert_of_revert_refused`` and asks a
human. Every decision a person has to act on opens its own HUMAN_REQUIRED
record (``self-revert-<sha12>-<decision>``), so a later question is never
swallowed by an earlier one's record.

ORDER. The freeze (``self_merge_freeze.freeze_self_merge``) is written
BEFORE any git or PR effect, and it always lands whatever the runtime
profile. Everything after it respects the profile: a profile without
``pr_create`` records ``revert_not_permitted_by_profile`` and asks a human.
A merge whose resolution on ``main`` fails (the fetch, or a merge sha that is
not on ``main``) is recorded ``revert_remote_unresolved`` — visible and asked
of a person, never skipped silently night after night.

MECHANISM. In a throwaway DETACHED worktree of the workspace (the checkout
the cycle runs in is never moved, and no local branch is ever created, so a
job killed before its cleanup leaves nothing that blocks the next attempt;
the worktrees a killed attempt at the same key left behind are removed
first): ``git revert --no-edit <merge_sha>`` on the base, then ``HEAD`` is
pushed to ``aria/revert/<sha12>``. The revert commit is a function of its
inputs — the producer's own identity and the merge's own dates, set in an
environment scrubbed of every ambient ``GIT_AUTHOR_*``/``GIT_COMMITTER_*``
and injected config, with ``revert.reference``, ``commit.gpgsign`` and the
hooks pinned — so the same base always makes the same commit. The base is
``origin/main``, unless the remote branch already holds a revert from an
earlier attempt: then the base is that commit's parent, and the rebuilt
commit must be exactly the pushed one (else ``revert_branch_diverged``: the
branch holds a commit this producer does not reproduce, and a person
decides; it is never overwritten). A conflict is aborted (``git revert
--abort``), recorded ``revert_conflict``, the freeze stays, a HUMAN_REQUIRED
record is opened and no PR is made. PURITY: the ``git patch-id --stable`` of
the revert commit's diff must equal that of ``git diff <merge_sha>
<merge_sha>^`` AND the two diffs must name the same files; an impure revert
(``main`` moved under the hunk) is recorded ``revert_impure``, with both
patch ids, and no PR is made.

VALIDATION — the chain the merge authority's triple gate reads. The revert
is a change of the change ledger's own kind: ``emit_change_planned`` (the
reverted files as its intended files, the reverted change's finding and
tier, ``rollback_ref`` = the merge sha; one chain per merge and REVERT
COMMIT, so a validation is reused only for the exact tip it ran at and any
other tip is validated afresh). Its suite is the one that validated the
reverted change — the commands of that change's own exit-0 validation runs
(``refs_for_change``), at the staged action's ceiling — re-run at the revert
tip through the apply gate's recorder (``validation.run_validation_commands``)
inside the apply gate's sandbox
(``implementation_delivery.validation_sandbox_for``, its room probed with
``probe_validation_room``). Green: ``emit_change_committed`` at the tip, then
``change_validated`` through the delivery's own ``_record_change_validated``
(``refs_for_change`` of the revert's runs, the validation matrix). Red, no
recorded suite to re-run, or a suite command the validation allowlist
refuses (``parse_allowed_command``): terminal ``revert_validation_failed``
naming the reason, the freeze stays, HUMAN_REQUIRED, and NO PR is opened —
a revert whose tip does not pass the suite that admitted the merge has not
shown that it restores anything, so it is a person's call. A sandbox this
host cannot build is the host's: ``revert_validation_unavailable``,
HUMAN_REQUIRED, retried next cycle.

DELIVERY — only for a validated chain, under the implementation lane's
authority. Inside ``delivery_credentials.hold_delivery_credentials``
(consumer ``self_revert_delivery``): the revert is pushed with an
intent/receipt pair (unless the remote branch already holds it), then the
open PRs for the branch are listed. An open PR at the revert's head is
ADOPTED — bound to the revert's change chain and its unresolved intents
answered — because a ``gh pr create`` that timed out may have made it, and a
second PR for one key is the duplicate effect recovery exists to prevent.
Otherwise the PR is opened through ``pr_manager.open_revert_pr`` — the
``pr_create`` gate, the full pre-PR-open perimeter, the change-id anchor and
the one intent/receipt-bracketed ``gh pr create`` that ``open_pr_for_action``
also uses. A branch on the remote without an adopted PR (an unreadable PR
list, a refused or timed-out create) is ``revert_pr_pending``: retried,
never terminal. Then ``register_revert`` (idempotent on freeze, PR and head)
names this PR at this head as the one PR the freeze admits; the merge lane
can merge it, since its chain is committed and validated at exactly that
head. A delivery whose credential could not be minted is retried later
against the chain it already validated.

MERGE AUTHORITY OVER THE REVERT (ARIA-MEDIUM-227). A frozen merge lane
merges only the registered revert, so a revert the lane may not merge is a
deadlock: every ARIA merge stops and nothing says why. When the PR opens,
its changed paths are classified (``risk_policy.classify_change``) and held
against the predicates the merge authority applies at merge time
(``revert_merge_authority``): a valid lane, no code-owned path, merge
authority at all (``assert_merge_authority_available``), authority over that
lane (``assert_merge_authorized``) and its autonomy unlock; L3 always needs
an operator's policy approval. A revert ARIA cannot merge is recorded
``revert_opened_awaiting_human_merge`` — terminal, and a HUMAN_REQUIRED
record names the freeze, the revert PR, the reason and the unfreeze
command. The verdict is re-read on every run while the freeze is in force,
so a grant that lapses later asks the same person the same question.

THE FREEZE NOTICE (ARIA-MEDIUM-227). Right after every freeze is written,
and on every run after, the freeze's GitHub issue is brought to its current
truth (``self_merge_freeze.publish_freeze_notice``, through the injected
``issue_writer``): the merge it reverts, the revert PR or where the
self-revert stopped, whether ARIA may merge the revert, and the way out —
the revert, then ``aria-kernel merge-lane unfreeze --freeze-id …
--operator-approval-ref …``. The merge lane reads that issue as a freeze
(``assert_self_merge_not_frozen``), so a freeze stops ARIA merging the
moment it is written, not when this cycle publishes its state at the job's
end. A notice GitHub refused is recorded, asked of a person and retried; a
lifted freeze's notice is closed once.

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
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from .change_paths import name_status_args, parse_name_status_z
from .git_containment import KERNEL_GIT_NO_HOOKS_ARGS
from .ledger import append_declared_jsonl, load_declared_jsonl
from .pr_manager import ARIA_PR_BASE, REVERT_BRANCH_PREFIX
from .self_merge_freeze import (
    FreezeNoticeWriter,
    close_freeze_notice,
    freeze_id_for,
    freeze_in_force,
    freeze_self_merge,
    list_freezes,
    publish_freeze_notice,
    register_revert,
    unfreeze_command,
)
from .state_store import GIT_TIMEOUT_SECONDS
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir, utc_now
from .validation import SpawnWrapper

SELF_REVERTS_SURFACE = "enterprise_self_reverts"
SELF_REVERTS_RELPATH = ("enterprise", "self-reverts.jsonl")

TRIGGER_POST_MERGE_CI = "post_merge_ci_red"
TRIGGER_CHANGE_OUTCOME = "change_outcome_regression"
TRIGGERS: tuple[str, ...] = (TRIGGER_POST_MERGE_CI, TRIGGER_CHANGE_OUTCOME)

# How far back along main's first-parent chain a red job's baseline run is
# looked for: far enough for a path-filtered workflow on a busy main, near
# enough that "green then" still says something about "green just before".
ATTRIBUTION_ANCESTOR_LIMIT = 50

DECISION_NOT_ATTRIBUTABLE = "not_attributable"
DECISION_REVERT_OF_REVERT = "revert_of_revert_refused"
DECISION_NOT_PERMITTED = "revert_not_permitted_by_profile"
DECISION_UNBOUND = "reverted_change_unbound"
DECISION_CONFLICT = "revert_conflict"
DECISION_FAILED = "revert_failed"
DECISION_IMPURE = "revert_impure"
DECISION_CREDENTIAL_UNAVAILABLE = "revert_credential_unavailable"
DECISION_VALIDATION_UNAVAILABLE = "revert_validation_unavailable"
DECISION_VALIDATION_FAILED = "revert_validation_failed"
DECISION_DELIVERY_FAILED = "revert_delivery_failed"
DECISION_REMOTE_UNRESOLVED = "revert_remote_unresolved"
DECISION_BRANCH_DIVERGED = "revert_branch_diverged"
DECISION_PR_PENDING = "revert_pr_pending"
DECISION_OPENED = "revert_opened"
DECISION_OPENED_AWAITING_HUMAN = "revert_opened_awaiting_human_merge"
DECISION_LANDED = "revert_landed"
# The revert PR exists and is registered with the freeze: ARIA's merge lane
# can merge it, or only a person can.
OPENED_DECISIONS: frozenset[str] = frozenset({DECISION_OPENED, DECISION_OPENED_AWAITING_HUMAN})
# A terminal decision closes the merge's key: no later trigger acts on it.
TERMINAL_DECISIONS: frozenset[str] = frozenset({
    DECISION_REVERT_OF_REVERT, DECISION_NOT_PERMITTED, DECISION_UNBOUND, DECISION_CONFLICT,
    DECISION_FAILED, DECISION_IMPURE, DECISION_VALIDATION_FAILED, DECISION_DELIVERY_FAILED,
    *OPENED_DECISIONS,
})
# The non-terminal decisions: each is recorded once per distinct reason and
# the key is tried again on the next trigger. A remote that could not be
# read, a revert branch holding a commit this producer does not make, a
# pushed revert with no adopted PR yet — each can leave a partial effect the
# next attempt must resume, so none may close the key.
RETRIED_DECISIONS: frozenset[str] = frozenset({
    DECISION_CREDENTIAL_UNAVAILABLE, DECISION_VALIDATION_UNAVAILABLE, DECISION_REMOTE_UNRESOLVED,
    DECISION_BRANCH_DIVERGED, DECISION_PR_PENDING,
})
# The decisions a person has to act on: each opens a HUMAN_REQUIRED record.
# A credential the lane cannot mint is the lane's configuration, already
# refused by name on the delivery-credential ledger; every other retried
# decision leaves the freeze in force with no PR to merge, so a person is
# told while it is retried. A revert ARIA's merge lane cannot merge is in
# the set: under a freeze it is the one PR that may merge, so without a
# person nothing ever does.
HUMAN_REQUIRED_DECISIONS: frozenset[str] = (
    (TERMINAL_DECISIONS - {DECISION_OPENED}) | (RETRIED_DECISIONS - {DECISION_CREDENTIAL_UNAVAILABLE})
)

# The producer's own commit identity: never the ambient one, which a CI
# runner does not configure, and never a person's.
REVERT_COMMITTER_NAME = "aria-self-revert"
REVERT_COMMITTER_EMAIL = "aria-self-revert@users.noreply.github.com"
# The configuration that changes the bytes of a `git revert --no-edit`
# commit, pinned: a signature makes a different commit, and
# `revert.reference` a different message.
_REVERT_CONFIG_ARGS: tuple[str, ...] = ("-c", "commit.gpgsign=false", "-c", "revert.reference=false")
# Ambient environment that sets a commit's identity, its dates or injected
# git config; none of it reaches the revert commit.
_AMBIENT_COMMIT_ENV_PREFIXES: tuple[str, ...] = (
    "GIT_AUTHOR_", "GIT_COMMITTER_", "GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_",
)
_AMBIENT_COMMIT_ENV_NAMES: frozenset[str] = frozenset({"GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"})
# The bound of the one `gh pr list` the delivery asks before it creates.
GH_PR_LOOKUP_TIMEOUT_SECONDS = 60
# Every worktree this producer makes lives in a holder named for its key, so
# the leftovers of a killed attempt at the same key are found by name.
_HOLDER_PREFIX = "aria-self-revert-"
# The HUMAN_REQUIRED suffix of a freeze whose GitHub notice was refused.
_NOTICE_UNPUBLISHED = "freeze_notice_unpublished"
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


@dataclass(frozen=True)
class _Attribution:
    """Whether a red is the merge's: the red jobs whose nearest ancestor run
    does not prove main green before the merge (each with the conclusions of
    that run, empty for none inside the bound), the baseline commit of every
    other job, and a reason when the red cannot be judged at all."""

    unattributable_jobs: dict[str, list[str]]
    baselines: dict[str, str]
    reason: str | None = None

    @property
    def attributable(self) -> bool:
        return self.reason is None and not self.unattributable_jobs


class _Terminal(Exception):
    """A terminal decision reached inside the revert mechanism."""

    def __init__(self, decision: str, detail: dict[str, Any]) -> None:
        super().__init__(decision)
        self.decision = decision
        self.detail = detail


class _Pending(Exception):
    """A non-terminal decision (``RETRIED_DECISIONS``): recorded once per
    distinct reason, and the key is tried again next time."""

    def __init__(self, decision: str, reason: str, detail: dict[str, Any] | None = None) -> None:
        super().__init__(f"{decision}:{reason}")
        self.decision = decision
        self.reason = reason
        self.detail = dict(detail or {})


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


def _human_required_id(merge_sha: str, decision: str) -> str:
    return f"self-revert-{merge_sha[:12]}-{decision}"


def _request_id(merge_sha: str) -> str:
    return f"self-revert:{merge_sha[:12]}"


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
        _ask_a_person(
            merge_sha=candidate.merge_sha, pr_number=candidate.pr_number, trigger=candidate.trigger,
            suffix=decision, what=f"the self-revert stopped at {decision}", reason=row.get("reason"),
            revert_pr=row.get("pr_number_opened"), base_dir=base_dir,
        )
    return persisted


def _ask_a_person(
    *,
    merge_sha: str,
    pr_number: Any,
    trigger: str,
    suffix: str,
    what: str,
    reason: Any,
    revert_pr: Any,
    base_dir: str | Path | None,
) -> dict[str, Any]:
    """One HUMAN_REQUIRED record per (merge, question), naming the freeze in
    force, the revert PR when there is one, and the way out."""
    from .human_required import record_human_required

    freeze_id = freeze_id_for(merge_sha)
    frozen = freeze_in_force(freeze_id, base_dir=base_dir) is not None
    parts = [
        f"ARIA merge {merge_sha[:12]} (PR #{pr_number}) went bad ({trigger})",
        f"self-merge is frozen ({freeze_id})" if frozen else "self-merge is not frozen",
        what + (f": {reason}" if reason else ""),
    ]
    if revert_pr is not None:
        parts.append(f"revert PR #{revert_pr}")
    if frozen:
        parts.append(f"only an operator lifts the freeze: {unfreeze_command(freeze_id)}")
    return record_human_required(
        request_id=_human_required_id(merge_sha, suffix),
        severity="HIGH",
        reason="; ".join(parts),
        context={"kind": "self_revert", "decision": suffix, "key": revert_key_for(merge_sha),
                 "pr_number": pr_number, "merge_sha": merge_sha, "freeze_id": freeze_id if frozen else None,
                 "reason": reason, "revert_pr": revert_pr},
        base_dir=base_dir,
    )


def _record_once(
    candidate: _Candidate,
    pending: _Pending,
    *,
    cycle_id: str,
    base_dir: str | Path | None,
) -> dict[str, Any] | None:
    """A retried decision, recorded the first time its reason is seen for
    the key; None (nothing new) on every repeat of the same reason."""
    key = revert_key_for(candidate.merge_sha)
    if any(row.get("key") == key and row.get("decision") == pending.decision and row.get("reason") == pending.reason
           for row in load_self_reverts(base_dir=base_dir)):
        return None
    return _record(candidate, pending.decision, cycle_id=cycle_id, base_dir=base_dir,
                   detail={**pending.detail, "reason": pending.reason})


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


def _first_parent_ancestors(workspace: Path, start_sha: str) -> list[str] | str:
    """``start_sha`` and its first-parent ancestors on main, nearest first,
    at most ``ATTRIBUTION_ANCESTOR_LIMIT``; or why they cannot be listed."""
    listed = _git(["rev-list", "--first-parent", f"--max-count={ATTRIBUTION_ANCESTOR_LIMIT}", start_sha],
                  cwd=workspace)
    if listed.returncode != 0:
        return f"ancestors_unresolvable:{_first_line(listed.stderr)}"
    return [line.strip() for line in listed.stdout.splitlines() if line.strip()]


def _remote_branch_head(workspace: Path, branch: str) -> str | None:
    """The commit the remote's ``branch`` points at, or None when it has no
    such branch. A remote that cannot answer is not an absent branch: the
    next push could collide with it and the next PR duplicate one."""
    listed = _git(["ls-remote", "--heads", _REMOTE, f"refs/heads/{branch}"], cwd=workspace)
    if listed.returncode != 0:
        raise _Pending(DECISION_REMOTE_UNRESOLVED, f"revert_branch_unreadable:{_first_line(listed.stderr)}")
    tokens = listed.stdout.split()
    return tokens[0] if tokens else None


def _pushed_revert_base(workspace: Path, branch: str, remote_head: str) -> str:
    """The parent of the commit an earlier attempt pushed to ``branch``: the
    base the deterministic revert is rebuilt on to meet it."""
    fetched = _git(["fetch", "--no-tags", _REMOTE, f"+refs/heads/{branch}:refs/remotes/{_REMOTE}/{branch}"],
                   cwd=workspace)
    if fetched.returncode != 0:
        raise _Pending(DECISION_REMOTE_UNRESOLVED, f"revert_branch_fetch_failed:{_first_line(fetched.stderr)}")
    parent = _git(["rev-parse", "--verify", f"{remote_head}^"], cwd=workspace)
    if parent.returncode != 0:
        raise _Pending(DECISION_BRANCH_DIVERGED, f"remote_branch_base_unresolvable:{remote_head}",
                       {"branch": branch, "remote_head": remote_head})
    return parent.stdout.strip()


def _clear_stale_worktrees(workspace: Path, merge_sha: str) -> list[str]:
    """Remove what a killed attempt at this key left in the workspace: the
    worktrees in this key's holders, any worktree that has the key's branch
    checked out (the shape before worktrees were detached), and that local
    branch. Returns the worktree paths removed."""
    branch = revert_branch_for(merge_sha)
    own_prefix = f"{_HOLDER_PREFIX}{merge_sha[:12]}-"
    listing = _git(["worktree", "list", "--porcelain"], cwd=workspace)
    removed: list[str] = []
    for block in listing.stdout.split("\n\n"):
        fields = dict(line.split(" ", 1) for line in block.splitlines() if " " in line)
        path = fields.get("worktree")
        if not path:
            continue
        holder = Path(path).parent
        if holder.name.startswith(own_prefix) or fields.get("branch") == f"refs/heads/{branch}":
            _git(["worktree", "remove", "--force", path], cwd=workspace)
            if holder.name.startswith(_HOLDER_PREFIX):
                shutil.rmtree(holder, ignore_errors=True)
            removed.append(path)
    _git(["worktree", "prune"], cwd=workspace)
    if _git(["rev-parse", "--verify", "--quiet", f"refs/heads/{branch}"], cwd=workspace).returncode == 0:
        _git(["branch", "-D", branch], cwd=workspace)
    return removed


def _revert_environment(date: str) -> dict[str, str]:
    """The environment the revert commit is made in: the ambient one without
    anything that sets a commit's identity, dates or injected config, plus
    the producer's identity and the merge's own date."""
    env = {
        name: value for name, value in os.environ.items()
        if not name.startswith(_AMBIENT_COMMIT_ENV_PREFIXES) and name not in _AMBIENT_COMMIT_ENV_NAMES
    }
    env.update({
        "GIT_AUTHOR_NAME": REVERT_COMMITTER_NAME, "GIT_AUTHOR_EMAIL": REVERT_COMMITTER_EMAIL, "GIT_AUTHOR_DATE": date,
        "GIT_COMMITTER_NAME": REVERT_COMMITTER_NAME, "GIT_COMMITTER_EMAIL": REVERT_COMMITTER_EMAIL,
        "GIT_COMMITTER_DATE": date,
    })
    return env


def _make_revert_commit(candidate: _Candidate, *, worktree: Path, workspace: Path, base_sha: str) -> str:
    """``git revert --no-edit <merge>`` at the worktree's base; the commit sha.

    The commit is a function of its inputs: fixed identity, dates taken from
    the merge it reverts, pinned config and the base it sits on. A later
    attempt on the same base therefore makes the SAME commit, which is what
    lets a retry meet the change chain, the pushed branch and the PR an
    earlier attempt left."""
    merge_date = _git(["show", "-s", "--format=%cI", candidate.merge_sha], cwd=workspace).stdout.strip()
    reverting = _git([*_REVERT_CONFIG_ARGS, "revert", "--no-edit", candidate.merge_sha],
                     cwd=worktree, env=_revert_environment(merge_date))
    if reverting.returncode != 0:
        unmerged = _git(["diff", "--name-only", "--diff-filter=U"], cwd=worktree)
        conflicted = sorted(line for line in unmerged.stdout.splitlines() if line.strip())
        aborted = _git(["revert", "--abort"], cwd=worktree)
        if conflicted:
            raise _Terminal(DECISION_CONFLICT, {"conflicted_files": conflicted,
                                                "aborted": aborted.returncode == 0, "base_sha": base_sha})
        raise _Terminal(DECISION_FAILED, {"reason": f"revert_failed:{_first_line(reverting.stderr)}"})
    return _git(["rev-parse", "HEAD"], cwd=worktree).stdout.strip()


def _patch_id(workspace: Path, old: str, new: str) -> tuple[str, list[tuple[str, str]]]:
    diff = _git(["diff", old, new], cwd=workspace)
    # Every path the diff touches, through the one change-path reader
    # (ARIA-CRITICAL-214): with rename detection a rename names only its
    # destination, and the source is a path the change removes — the revert's
    # merge authority is judged on both (ARIA-MEDIUM-227).
    names = _git(name_status_args(old, new), cwd=workspace)
    if diff.returncode != 0 or names.returncode != 0:
        raise _Terminal(DECISION_FAILED, {"reason": f"diff_unresolvable:{_first_line(diff.stderr or names.stderr)}"})
    try:
        # Each path keeps its git status: the risk lane admits a path only
        # under its status (a new test is L1, a changed one is not).
        changes = sorted(set(parse_name_status_z(names.stdout)))
    except GovernanceError as exc:
        raise _Terminal(DECISION_FAILED, {"reason": f"diff_unresolvable:{str(exc)[:160]}"}) from exc
    patch_id = ""
    if diff.stdout.strip():
        computed = _git(["patch-id", "--stable"], cwd=workspace, input_text=diff.stdout)
        patch_id = (computed.stdout.split() or [""])[0]
    return patch_id, changes


def prove_revert_purity(*, workspace: Path, merge_sha: str, revert_sha: str) -> dict[str, Any]:
    """The revert commit is exactly the inverse of the merge: equal stable
    patch ids and the same file set, both non-empty."""
    revert_patch_id, revert_changes = _patch_id(workspace, f"{revert_sha}^", revert_sha)
    inverse_patch_id, inverse_changes = _patch_id(workspace, merge_sha, f"{merge_sha}^")
    pure = bool(revert_patch_id) and revert_patch_id == inverse_patch_id and bool(revert_changes) \
        and revert_changes == inverse_changes
    return {
        "pure": pure,
        "revert_sha": revert_sha,
        "revert_patch_id": revert_patch_id,
        "inverse_patch_id": inverse_patch_id,
        "revert_files": sorted({path for _status, path in revert_changes}),
        "inverse_files": sorted({path for _status, path in inverse_changes}),
        "revert_changes": [[status, path] for status, path in revert_changes],
    }


# ---------------------------------------------------------------- triggers


# ARIA-HIGH-222 — decisions that name an ARIA merge ATTEMPT at an exact
# head. A ``merge_intent`` row is published before the merge call, so it
# survives a lane whose final ``merged`` row was lost with its runner; it
# counts as ARIA's merge once the post-merge reconciler (``own_pr_ci``) has
# recorded that PR merged AT THAT HEAD.
#
# ARIA-HIGH-221 — ``enqueued`` is the same kind of row: main merges through
# a merge queue, so the merge call usually enqueues and the queue merges the
# PR later. An enqueued PR the queue then merged at that head is ARIA's
# merge, whether or not the merge lane has settled it into ``merged`` yet.
_ATTEMPT_DECISIONS: frozenset[str] = frozenset({"merge_intent", "enqueued"})


def _aria_merged_prs(base_dir: str | Path | None) -> set[int]:
    path = ensure_tools_dir(base_dir) / "auto-merge-decisions.jsonl"
    if not path.exists():
        return set()
    merged: set[int] = set()
    attempts: set[tuple[int, str]] = set()
    for row in load_declared_jsonl(path, expected_surface="auto_merge_decisions"):
        if not isinstance(row.get("pr_number"), int):
            continue
        if row.get("decision") == "merged":
            merged.add(int(row["pr_number"]))
        elif row.get("decision") in _ATTEMPT_DECISIONS and isinstance(row.get("head_sha"), str):
            attempts.add((int(row["pr_number"]), str(row["head_sha"])))
    if attempts:
        merged_at_head = {
            (number, str(outcome.get("head_sha") or ""))
            for number, outcome in _merge_outcome_heads(base_dir)
        }
        merged.update(number for number, head_sha in attempts if (number, head_sha) in merged_at_head)
    return merged


def _merge_outcome_heads(base_dir: str | Path | None) -> list[tuple[int, dict[str, Any]]]:
    """Every merge-outcome row that names the head its PR merged at."""
    from .own_pr_ci import merge_outcomes_path

    path = merge_outcomes_path(base_dir)
    if not path.exists():
        return []
    return [
        (int(row["pr_number"]), row)
        for row in load_declared_jsonl(path, expected_surface="merge_outcomes")
        if isinstance(row.get("pr_number"), int) and row.get("head_sha")
    ]


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
    reader: Any, *, red_jobs: Sequence[str], ancestors: Sequence[str],
) -> _Attribution:
    """Judge each red job against the nearest of ``ancestors`` (main's
    first-parent chain from the merge's parent, nearest first) that has a
    run of it on main. A red naming no job cannot be judged at all."""
    if not red_jobs:
        return _Attribution({}, {}, reason="red_names_no_job")
    runs_by_sha: dict[str, list[dict[str, Any]]] = {}

    def main_runs(sha: str) -> list[dict[str, Any]]:
        if sha not in runs_by_sha:
            runs_by_sha[sha] = [
                run for run in reader.runs_for_commit(sha) if str(run.get("headBranch") or "") == _MAIN
            ]
        return runs_by_sha[sha]

    unattributable: dict[str, list[str]] = {}
    baselines: dict[str, str] = {}
    for job in red_jobs:
        nearest: tuple[str, list[str]] | None = None
        for sha in ancestors:
            conclusions = sorted(str(run.get("conclusion")) for run in main_runs(sha) if str(run.get("name")) == job)
            if conclusions:
                nearest = (sha, conclusions)
                break
        if nearest is None:
            unattributable[job] = []
        elif any(conclusion != _GREEN for conclusion in nearest[1]):
            unattributable[job] = nearest[1]
        else:
            baselines[job] = nearest[0]
    return _Attribution(unattributable, baselines)


# ---------------------------------------------------------------- the freeze's way out


def revert_merge_authority(changes: Sequence[Sequence[str]], *, base_dir: str | Path | None) -> dict[str, Any]:
    """Can ARIA's merge lane merge a revert whose ``(status, path)`` changes
    are ``changes`` (``prove_revert_purity``'s ``revert_changes``)?

    The predicates ``merge_authority.merge_pr_if_ready`` applies at merge
    time, read without writing: the changed paths' risk lane
    (``risk_policy.classify_change``) is valid and owns no code-owned path;
    some merge authority exists (``assert_merge_authority_available``: a
    profile holding ``pr_merge``, or a merge-lane grant in force); it covers
    that lane (``assert_merge_authorized``); the lane's autonomy unlock
    holds. L3 always needs an operator's policy approval. Returns the lane,
    the risk reason codes, ``mergeable_by_aria`` and, when not, the reason.
    """
    from .autonomy_unlock import evaluate_autonomy_unlock
    from .risk_policy import classify_change
    from .runtime_profile import assert_merge_authority_available, assert_merge_authorized

    verdict = classify_change([(str(status), str(path)) for status, path in changes])
    base = {"lane": verdict.lane, "reason_codes": list(verdict.reason_codes), "policy_hash": verdict.policy_hash}

    def refused(reason: str) -> dict[str, Any]:
        return {**base, "mergeable_by_aria": False, "reason": reason}

    if not verdict.valid:
        return refused("risk_policy_refuses:" + ",".join(verdict.reason_codes))
    if "risk_codeowners_path" in verdict.reason_codes:
        return refused("revert_touches_code_owned_paths")
    if verdict.lane == "L3":
        return refused("lane_L3_requires_operator_policy_approval")
    try:
        assert_merge_authority_available(base_dir=base_dir)
        assert_merge_authorized(lane=verdict.lane, base_dir=base_dir)
    except GovernanceError as exc:
        return refused(str(exc)[:300])
    unlock = evaluate_autonomy_unlock(lane=verdict.lane, base_dir=base_dir)
    if not unlock.valid:
        return refused(("autonomy_unlock_required: " + "; ".join(unlock.reasons))[:300])
    return {**base, "mergeable_by_aria": True, "reason": None}


def _freeze_notice_body(freeze: Mapping[str, Any], *, base_dir: str | Path | None) -> tuple[str, dict[str, Any] | None]:
    """The notice of a freeze in force, and the merge-authority verdict on its
    registered revert (None while no revert is recorded). Deterministic for
    unchanged ledgers, so an unchanged freeze is never written again."""
    freeze_id = str(freeze["freeze_id"])
    merge_sha = str(freeze["merge_sha"])
    rows = [row for row in load_self_reverts(base_dir=base_dir) if row.get("key") == revert_key_for(merge_sha)]
    opened = next((row for row in reversed(rows) if row.get("decision") in OPENED_DECISIONS), None)
    revert = freeze.get("revert")
    authority: dict[str, Any] | None = None
    lines = [
        "## ARIA self-merge is frozen",
        "",
        f"ARIA merged PR #{freeze.get('pr_number')} as `{merge_sha}` and the merge went bad "
        f"(`{freeze.get('trigger')}`). Until an operator lifts this freeze, ARIA's merge lane merges no "
        "pull request except the registered revert below.",
        "",
        f"- Freeze: `{freeze_id}` (recorded {freeze.get('recorded_at')}).",
    ]
    if revert and opened is not None:
        authority = revert_merge_authority(opened["purity"]["revert_changes"], base_dir=base_dir)
        url = f" — {opened['pr_url']}" if opened.get("pr_url") else ""
        lines.append(f"- Revert PR: #{revert['pr_number']} at `{revert['head_sha']}`{url}.")
        if authority["mergeable_by_aria"]:
            lines.append(f"- ARIA's merge lane can merge it (lane {authority['lane']}).")
            step = (f"Revert PR #{revert['pr_number']} merges: ARIA's merge lane merges it once its "
                    "required checks are green, or a person does.")
        else:
            lines.append(f"- ARIA's merge lane cannot merge it: {authority['reason']}.")
            step = f"A person reviews and merges revert PR #{revert['pr_number']}."
    elif revert:
        lines.append(f"- Revert PR: #{revert['pr_number']} at `{revert['head_sha']}` "
                     "(its self-revert decision is not recorded yet).")
        step = f"Revert PR #{revert['pr_number']} merges."
    else:
        latest = rows[-1] if rows else None
        where = "in progress"
        if latest is not None:
            where = f"`{latest.get('decision')}`" + (f": {latest['reason']}" if latest.get("reason") else "")
        lines.append(f"- No revert PR is registered: the self-revert is at {where}.")
        step = f"A person reverts `{merge_sha}`, or decides it stays; ARIA has opened no revert it may merge."
    lines += [
        "",
        "### Way out",
        "",
        f"1. {step}",
        "2. An operator lifts the freeze:",
        "",
        "```",
        unfreeze_command(freeze_id),
        "```",
        "",
        f"<!-- aria-self-merge-freeze:{freeze_id} -->",
        "",
    ]
    return "\n".join(lines), authority


def _publish_notice(
    freeze: Mapping[str, Any], *, issue_writer: FreezeNoticeWriter, base_dir: str | Path | None,
) -> dict[str, Any]:
    """Bring a freeze in force to its current truth on GitHub, and ask a
    person whatever the freeze now needs from one: a registered revert ARIA
    cannot merge, or a notice GitHub refused."""
    body, authority = _freeze_notice_body(freeze, base_dir=base_dir)
    merge_sha = str(freeze["merge_sha"])
    revert = freeze.get("revert") or {}
    if authority is not None and not authority["mergeable_by_aria"]:
        _ask_a_person(
            merge_sha=merge_sha, pr_number=freeze.get("pr_number"), trigger=str(freeze.get("trigger")),
            suffix=DECISION_OPENED_AWAITING_HUMAN,
            what=f"the self-revert stopped at {DECISION_OPENED_AWAITING_HUMAN}",
            reason=authority["reason"], revert_pr=revert.get("pr_number"), base_dir=base_dir,
        )
    row = publish_freeze_notice(freeze_id=str(freeze["freeze_id"]), body=body, writer=issue_writer,
                                base_dir=base_dir)
    if row.get("status") == "failed":
        _ask_a_person(
            merge_sha=merge_sha, pr_number=freeze.get("pr_number"), trigger=str(freeze.get("trigger")),
            suffix=_NOTICE_UNPUBLISHED,
            what=("the freeze's GitHub notice could not be published, so ARIA's merge lane sees the "
                  "freeze only once this cycle publishes its state"),
            reason=row.get("reason"), revert_pr=revert.get("pr_number"), base_dir=base_dir,
        )
    return row


def _notify_freeze(freeze_id: str, *, issue_writer: FreezeNoticeWriter, base_dir: str | Path | None) -> None:
    """The notice of a freeze just written, before anything that can fail."""
    freeze = freeze_in_force(freeze_id, base_dir=base_dir)
    if freeze is not None:
        _publish_notice(freeze, issue_writer=issue_writer, base_dir=base_dir)


def _reconcile_freeze_notices(
    *, issue_writer: FreezeNoticeWriter, base_dir: str | Path | None,
) -> list[dict[str, Any]]:
    """Every freeze's notice at its current truth: a freeze in force
    published (written only when its body changed), a lifted one closed."""
    results: list[dict[str, Any]] = []
    for freeze in list_freezes(base_dir=base_dir):
        freeze_id = str(freeze["freeze_id"])
        if freeze["lifted"]:
            row = close_freeze_notice(
                freeze_id=freeze_id, writer=issue_writer, base_dir=base_dir,
                comment=f"An operator lifted `{freeze_id}`; ARIA's merge lane may merge again.",
            )
        else:
            row = _publish_notice(freeze, issue_writer=issue_writer, base_dir=base_dir)
        results.append({"freeze_id": freeze_id, "state": row.get("state"), "status": row.get("status"),
                        "issue_number": row.get("issue_number")})
    return results


# ---------------------------------------------------------------- producer


def run_self_revert_producer(
    *,
    cycle_id: str,
    base_dir: str | Path | None,
    workspace_root: str | Path,
    reader: Any | None,
    triggers: Sequence[str],
    issue_writer: FreezeNoticeWriter,
    validation_sandbox: Callable[[Path], SpawnWrapper] | None = None,
) -> dict[str, Any]:
    """Act on every bad ARIA merge the named triggers see; see module doc.

    ``issue_writer`` writes every freeze's GitHub notice
    (``github_adapters.select_issue_writer``). ``validation_sandbox`` builds
    the containment the revert's suite runs in for a worktree; the default
    is the apply gate's own (``implementation_delivery.validation_sandbox_for``
    with this store).
    """
    if validation_sandbox is None:
        from .implementation_delivery import validation_sandbox_for

        def validation_sandbox(worktree: Path) -> SpawnWrapper:
            return validation_sandbox_for(worktree, store=base_dir)
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
                      reader=reader, skipped=skipped, issue_writer=issue_writer,
                      validation_sandbox=validation_sandbox)
        if row is not None:
            decisions.append(row)
    if TRIGGER_POST_MERGE_CI in triggers:
        decisions.extend(_record_landed_reverts(cycle_id=cycle_id, base_dir=base_dir, aria_merged=aria_merged))
    notices = _reconcile_freeze_notices(issue_writer=issue_writer, base_dir=base_dir)
    return {"status": "ran", "triggers": list(triggers), "decisions": decisions, "skipped": skipped,
            "freeze_notices": notices}


def _decide(
    candidate: _Candidate,
    *,
    cycle_id: str,
    base_dir: str | Path | None,
    workspace: Path,
    reader: Any | None,
    skipped: list[dict[str, Any]],
    issue_writer: FreezeNoticeWriter,
    validation_sandbox: Callable[[Path], SpawnWrapper],
) -> dict[str, Any] | None:
    key = revert_key_for(candidate.merge_sha)
    ledger = load_self_reverts(base_dir=base_dir)
    rows = [row for row in ledger if row.get("key") == key]
    if any(row.get("decision") in TERMINAL_DECISIONS for row in rows):
        return None
    opened_reverts = {row.get("pr_number_opened") for row in ledger if row.get("decision") in OPENED_DECISIONS}
    if candidate.head_ref.startswith(REVERT_BRANCH_PREFIX) or candidate.pr_number in opened_reverts:
        freeze = freeze_self_merge(merge_sha=candidate.merge_sha, pr_number=candidate.pr_number,
                                   trigger=candidate.trigger, evidence=candidate.evidence, base_dir=base_dir)
        _notify_freeze(str(freeze["freeze_id"]), issue_writer=issue_writer, base_dir=base_dir)
        return _record(candidate, DECISION_REVERT_OF_REVERT, cycle_id=cycle_id, base_dir=base_dir)

    if candidate.trigger == TRIGGER_POST_MERGE_CI:
        # Attribution needs the ancestors' runs; without a reader there is no
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
            return _record_once(candidate, _Pending(DECISION_REMOTE_UNRESOLVED, resolved),
                                cycle_id=cycle_id, base_dir=base_dir)
        parent_sha, origin_main = resolved
        ancestors = _first_parent_ancestors(workspace, parent_sha)
        if isinstance(ancestors, str):
            return _record_once(candidate, _Pending(DECISION_REMOTE_UNRESOLVED, ancestors),
                                cycle_id=cycle_id, base_dir=base_dir)
        attribution = _attribution(reader, red_jobs=candidate.evidence.get("red_jobs") or [], ancestors=ancestors)
        if not attribution.attributable:
            evidence = {**candidate.evidence, "parent_sha": parent_sha,
                        "unattributable_jobs": attribution.unattributable_jobs,
                        "attribution_baselines": attribution.baselines}
            if attribution.reason is not None:
                evidence["attribution_reason"] = attribution.reason
            digest = _digest(evidence)
            if any(row.get("decision") == DECISION_NOT_ATTRIBUTABLE and row.get("evidence_digest") == digest
                   for row in rows):
                return None
            return _record(
                replace(candidate, evidence=evidence),
                DECISION_NOT_ATTRIBUTABLE, cycle_id=cycle_id, base_dir=base_dir,
                detail={"evidence_digest": digest},
            )
        candidate = replace(candidate, evidence={
            **candidate.evidence, "parent_sha": parent_sha, "attribution_baselines": attribution.baselines,
        })
        # The freeze, before any git or PR effect; it lands under every
        # profile, and is on GitHub for the merge lane at once.
        freeze = freeze_self_merge(merge_sha=candidate.merge_sha, pr_number=candidate.pr_number,
                                   trigger=candidate.trigger, evidence=candidate.evidence, base_dir=base_dir)
        _notify_freeze(str(freeze["freeze_id"]), issue_writer=issue_writer, base_dir=base_dir)
    else:
        # The regression verdict is already the attribution: the freeze lands
        # before the fetch, so a remote that cannot be read never delays it.
        freeze = freeze_self_merge(merge_sha=candidate.merge_sha, pr_number=candidate.pr_number,
                                   trigger=candidate.trigger, evidence=candidate.evidence, base_dir=base_dir)
        _notify_freeze(str(freeze["freeze_id"]), issue_writer=issue_writer, base_dir=base_dir)
        resolved = _resolve_merge(workspace, candidate.merge_sha)
        if isinstance(resolved, str):
            return _record_once(candidate, _Pending(DECISION_REMOTE_UNRESOLVED, resolved),
                                cycle_id=cycle_id, base_dir=base_dir)
        parent_sha, origin_main = resolved
        candidate = replace(candidate, evidence={**candidate.evidence, "parent_sha": parent_sha})

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
            cycle_id=cycle_id, base_dir=base_dir, workspace=workspace, validation_sandbox=validation_sandbox,
        )
    except _Pending as pending:
        return _record_once(candidate, pending, cycle_id=cycle_id, base_dir=base_dir)
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
    validation_sandbox: Callable[[Path], SpawnWrapper],
) -> dict[str, Any]:
    branch = revert_branch_for(candidate.merge_sha)
    _clear_stale_worktrees(workspace, candidate.merge_sha)
    # What an earlier attempt left on the remote decides the base: a pushed
    # revert is met, never pushed over.
    remote_head = _remote_branch_head(workspace, branch)
    base_sha = origin_main if remote_head is None else _pushed_revert_base(workspace, branch, remote_head)
    holder = Path(tempfile.mkdtemp(prefix=f"{_HOLDER_PREFIX}{candidate.merge_sha[:12]}-"))
    worktree = holder / "worktree"
    added = False
    try:
        created = _git(["worktree", "add", "--detach", str(worktree), base_sha], cwd=workspace)
        if created.returncode != 0:
            raise _Terminal(DECISION_FAILED, {"reason": f"worktree_add_failed:{_first_line(created.stderr)}"})
        added = True
        try:
            revert_sha = _make_revert_commit(candidate, worktree=worktree, workspace=workspace, base_sha=base_sha)
        except _Terminal as terminal:
            if remote_head is None:
                raise
            # The remote branch exists and this producer cannot rebuild it:
            # never a terminal decision while a pushed branch has no PR.
            raise _Pending(DECISION_BRANCH_DIVERGED, f"remote_branch_not_reproducible:{terminal.decision}",
                           {"branch": branch, "remote_head": remote_head, "base_sha": base_sha,
                            **terminal.detail}) from terminal
        if remote_head is not None and revert_sha != remote_head:
            raise _Pending(DECISION_BRANCH_DIVERGED, f"remote_branch_holds:{remote_head}",
                           {"branch": branch, "remote_head": remote_head, "rebuilt_sha": revert_sha,
                            "base_sha": base_sha})
        purity = prove_revert_purity(workspace=worktree, merge_sha=candidate.merge_sha, revert_sha=revert_sha)
        if not purity["pure"]:
            if remote_head is not None:
                raise _Pending(DECISION_BRANCH_DIVERGED, "remote_branch_revert_impure",
                               {"branch": branch, "remote_head": remote_head, "purity": purity})
            raise _Terminal(DECISION_IMPURE, {"purity": purity, "base_sha": base_sha})
        validated = _validate_revert(
            candidate, worktree=worktree, revert_sha=revert_sha, purity=purity,
            reverted=reverted, cycle_id=cycle_id, base_dir=base_dir, validation_sandbox=validation_sandbox,
        )
        change_id = str(validated["change_id"])
        opened = _deliver(
            candidate, branch=branch, worktree=worktree, revert_sha=revert_sha, base_sha=base_sha,
            remote_head=remote_head, purity=purity, change_id=change_id, cycle_id=cycle_id,
            base_dir=base_dir, workspace=workspace,
        )
        register_revert(freeze_id=freeze_id, pr_number=int(opened["pr_number"]), head_sha=revert_sha,
                        purity=purity, base_dir=base_dir)
        # Under the freeze this PR is the only one that may merge: whether
        # ARIA's merge lane can merge it decides whether a person must.
        authority = revert_merge_authority(purity["revert_changes"], base_dir=base_dir)
        decision = DECISION_OPENED if authority["mergeable_by_aria"] else DECISION_OPENED_AWAITING_HUMAN
        return _record(candidate, decision, cycle_id=cycle_id, base_dir=base_dir, detail={
            "branch": branch, "base_sha": base_sha, "head_sha": revert_sha, "purity": purity,
            "change_id": change_id, "pr_number_opened": int(opened["pr_number"]),
            "pr_url": opened.get("url"), "freeze_id": freeze_id, "adopted": bool(opened["adopted"]),
            "validated": {"change_id": change_id, "ledger_hash": validated.get("ledger_hash")},
            "merge_authority": authority,
            **({} if authority["mergeable_by_aria"] else {"reason": authority["reason"]}),
        })
    finally:
        if added:
            # The worktree is scaffolding: the pushed branch lives on the
            # remote, and the worktree is detached, so nothing local remains
            # for a later attempt to collide with.
            _git(["worktree", "remove", "--force", str(worktree)], cwd=workspace)
        shutil.rmtree(holder, ignore_errors=True)


def _reverted_suite(reverted: dict[str, Any], *, pr_number: int, base_dir: str | Path | None) -> tuple[list[str], int]:
    """The suite that validated the reverted change, and its ceiling.

    The commands are the reverted change's own exit-0 validation runs
    (``refs_for_change``, the mapping its ``change_validated`` was written
    from), in the order they ran; the ceiling is the staged action's
    (``_staged_suite``) when the PR names its proposal."""
    from .implementation_delivery import _staged_suite
    from .implementation_safety import CANONICAL_VALIDATION_TIMEOUT_MS
    from .validation_runs_ledger import refs_for_change

    commands: list[str] = []
    for ref in refs_for_change(str(reverted.get("change_id") or ""), base_dir=base_dir):
        command = str(ref.get("cmd") or "")
        if command and command not in commands:
            commands.append(command)
    timeout_ms = CANONICAL_VALIDATION_TIMEOUT_MS
    lifecycle = ensure_tools_dir(base_dir) / "pr-lifecycle.jsonl"
    proposal_id = ""
    if lifecycle.exists():
        for row in load_declared_jsonl(lifecycle, expected_surface="pr_lifecycle"):
            if row.get("pr_number") == pr_number and row.get("proposal_id"):
                proposal_id = str(row["proposal_id"])
    if proposal_id:
        _commands, timeout_ms = _staged_suite(proposal_id=proposal_id, base_dir=base_dir)
    return commands, timeout_ms


def _validate_revert(
    candidate: _Candidate,
    *,
    worktree: Path,
    revert_sha: str,
    purity: dict[str, Any],
    reverted: dict[str, Any],
    cycle_id: str,
    base_dir: str | Path | None,
    validation_sandbox: Callable[[Path], SpawnWrapper],
) -> dict[str, Any]:
    """Open the revert's change chain and close it with the reverted
    change's own suite, re-run at the revert tip in the validation sandbox.

    Returns the ``change_validated`` row. Raises ``_Pending`` when the
    sandbox cannot be built here, and ``_Terminal`` when the suite is
    unknown, names a command the validation allowlist refuses, is red, or
    the validated row is refused.
    """
    from .change_ledger import (
        _find_committed,
        _find_validated_for_change,
        emit_change_committed,
        emit_change_planned,
        emit_change_validated,
    )
    from .implementation_delivery import ChangeValidatedRefused, _record_change_validated, probe_validation_room
    from .implementation_safety import CANONICAL_VALIDATION_COMMANDS, SandboxUnavailable
    from .validation import parse_allowed_command, run_validation_commands
    from .validation_env import build_validation_env

    commands, timeout_ms = _reverted_suite(reverted, pr_number=candidate.pr_number, base_dir=base_dir)
    if not commands:
        raise _Terminal(DECISION_VALIDATION_FAILED, {"reason": "reverted_change_has_no_recorded_suite",
                                                     "purity": purity})
    # A command the lane refuses to run is the suite's, not the host's: no
    # later attempt can run it either, so it is decided here, by name.
    parsed: list[tuple[list[str], dict[str, str]]] = []
    for command in commands:
        try:
            parsed.append(parse_allowed_command(command))
        except GovernanceError as exc:
            raise _Terminal(DECISION_VALIDATION_FAILED, {"reason": f"suite_command_refused:{command}:{str(exc)[:200]}",
                                                         "purity": purity}) from exc
    files = list(purity["revert_files"])
    try:
        # One chain per (merge, revert commit): a validation is only ever
        # reused for the exact tip it ran at, and a revert on a moved main —
        # or any other tip — gets its own chain rather than colliding with
        # the committed row of the first.
        planned = emit_change_planned(
            plan_id=f"self-revert:{candidate.merge_sha}:{revert_sha}",
            finding_id=str(reverted["finding_id"]),
            intended_affected_files=files,
            intended_validation_refs=list(CANONICAL_VALIDATION_COMMANDS),
            rollback_ref=candidate.merge_sha,
            architectural_tier=int(reverted["architectural_tier"]),
            intended_request_id=_request_id(candidate.merge_sha),
            base_dir=base_dir,
        )
    except GovernanceError as exc:
        raise _Terminal(DECISION_DELIVERY_FAILED, {"reason": f"change_ledger_refused:{str(exc)[:300]}",
                                                   "purity": purity}) from exc
    change_id = str(planned["change_id"])
    already = _find_validated_for_change(ensure_tools_dir(base_dir), change_id)
    if already is not None:
        # A retry after a delivery that did not complete: the same revert
        # commit, already validated — the chain's committed row names this
        # tip, so nothing re-runs.
        committed = _find_committed(ensure_tools_dir(base_dir), change_id)
        if committed is None or committed.get("commit_sha") != revert_sha:
            raise _Terminal(DECISION_FAILED, {"reason": "validated_chain_not_at_tip", "change_id": change_id,
                                              "committed_sha": (committed or {}).get("commit_sha")})
        return already

    try:
        wrap = validation_sandbox(worktree)
        for argv, declared in parsed:
            wrap(argv, build_validation_env(os.environ, declared=declared).env)
    except (SandboxUnavailable, GovernanceError) as exc:
        raise _Pending(DECISION_VALIDATION_UNAVAILABLE, f"sandbox_unavailable:{str(exc)[:300]}",
                       {"change_id": change_id}) from exc
    room = probe_validation_room(
        wrap, workspace_root=worktree, environment=build_validation_env(os.environ, declared={}).env,
    )
    plan = run_validation_commands(
        commands=commands, workspace_root=worktree, change_id=change_id, commit_sha=revert_sha,
        runner_identity=f"aria-kernel:self-revert:{candidate.merge_sha[:12]}",
        change_author_identity=REVERT_COMMITTER_NAME, base_dir=base_dir, cycle_id=cycle_id,
        timeout_ms=timeout_ms, spawn_wrapper=wrap, room=room,
    )
    if plan.get("status") != "ok":
        from .validation_runs_ledger import list_validation_runs_for_change

        failed = sorted(
            str(run.get("cmd")) for run in list_validation_runs_for_change(change_id, base_dir=base_dir)
            if run.get("commit_sha") == revert_sha and run.get("status") != "ok"
        )
        raise _Terminal(DECISION_VALIDATION_FAILED, {"change_id": change_id, "failed_commands": failed,
                                                     "validation_plan": plan.get("ledger_hash"),
                                                     "purity": purity})
    try:
        emit_change_committed(change_id=change_id, commit_sha=revert_sha, actual_affected_files=files,
                              base_dir=base_dir)
    except GovernanceError as exc:
        raise _Terminal(DECISION_DELIVERY_FAILED, {"reason": f"change_ledger_refused:{str(exc)[:300]}",
                                                   "change_id": change_id, "purity": purity}) from exc
    try:
        return _record_change_validated(
            change_id=change_id, base_dir=base_dir, workspace=worktree, emit=emit_change_validated,
            request_id=_request_id(candidate.merge_sha), cycle_id=cycle_id,
        )
    except ChangeValidatedRefused as exc:
        raise _Terminal(DECISION_VALIDATION_FAILED, {"change_id": change_id,
                                                     "reason": f"change_validated_refused:{exc.reason[:300]}",
                                                     "validation_plan": plan.get("ledger_hash"),
                                                     "purity": purity}) from exc


def _confirm_intents(
    request_id: str, *, effect_kind: str, matches: Callable[[Mapping[str, Any]], bool],
    observed: Mapping[str, Any], base_dir: str | Path | None,
) -> None:
    """Answer this key's unresolved intents of ``effect_kind`` that the remote
    now shows happened: a receipt, so recovery never asks about them again."""
    from .recovery import record_receipt, unresolved_intents

    for intent in unresolved_intents(request_id, base_dir=base_dir):
        if intent.get("effect_kind") == effect_kind and matches(intent.get("intended_postcondition") or {}):
            record_receipt(operation_id=str(intent["operation_id"]), request_id=request_id,
                           observed=dict(observed), status="confirmed", base_dir=base_dir)


def _push_revert(
    *,
    branch: str,
    worktree: Path,
    workspace: Path,
    revert_sha: str,
    change_id: str,
    purity: dict[str, Any],
    request_id: str,
    environment: Mapping[str, str],
    base_dir: str | Path | None,
) -> None:
    """Push the worktree's ``HEAD`` to the remote branch, bracketed by an
    intent and a receipt. A push that reports failure is checked against
    the remote before anything is decided: it is terminal only when the
    remote holds no branch, since a key may never close on a pushed branch
    that no PR was adopted for."""
    from .recovery import record_intent, record_receipt

    intent = record_intent(
        request_id=request_id, effect_kind="git_push", target=f"{_REMOTE}/{branch}",
        intended_postcondition={"branch": branch, "remote": _REMOTE, "head_sha": revert_sha, "change_id": change_id},
        base_dir=base_dir,
    )
    push = _git(["push", _REMOTE, f"HEAD:refs/heads/{branch}"], cwd=worktree, env=environment)
    if push.returncode != 0:
        landed = _remote_branch_head(workspace, branch)
        if landed != revert_sha:
            record_receipt(operation_id=str(intent["operation_id"]), request_id=request_id,
                           observed={"returncode": push.returncode, "stderr": (push.stderr or "")[:400],
                                     "remote_head": landed},
                           status="failed", base_dir=base_dir)
            if landed is None:
                raise _Terminal(DECISION_DELIVERY_FAILED, {"reason": f"push_failed:{_first_line(push.stderr)}",
                                                           "change_id": change_id, "purity": purity})
            raise _Pending(DECISION_BRANCH_DIVERGED, f"remote_branch_holds:{landed}",
                           {"branch": branch, "remote_head": landed, "rebuilt_sha": revert_sha})
    record_receipt(operation_id=str(intent["operation_id"]), request_id=request_id,
                   observed={"branch": branch, "remote": _REMOTE, "head_sha": revert_sha},
                   status="confirmed", base_dir=base_dir)


def _open_pr_for_branch(branch: str, *, workspace: Path, environment: Mapping[str, str]) -> dict[str, Any] | None:
    """The open PR whose head is ``branch``, or None when there is none. A
    list that cannot be read is not an empty one: creating then could open
    a second PR for the key."""
    try:
        listed = subprocess.run(
            ["gh", "pr", "list", "--head", branch, "--state", "open",
             "--json", "number,url,headRefOid", "--limit", "5"],
            cwd=str(workspace), env=dict(environment), capture_output=True, text=True, check=False,
            timeout=GH_PR_LOOKUP_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise _Pending(DECISION_PR_PENDING, f"pr_lookup_failed:{type(exc).__name__}", {"branch_pushed": branch}) from exc
    if listed.returncode != 0:
        raise _Pending(DECISION_PR_PENDING, f"pr_lookup_failed:{_first_line(listed.stderr)}", {"branch_pushed": branch})
    try:
        rows = json.loads(listed.stdout or "[]")
    except ValueError as exc:
        raise _Pending(DECISION_PR_PENDING, "pr_lookup_unparseable", {"branch_pushed": branch}) from exc
    prs = [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []
    if len(prs) > 1:
        raise _Pending(DECISION_PR_PENDING, f"pr_lookup_ambiguous:{sorted(pr.get('number') for pr in prs)}",
                       {"branch_pushed": branch})
    return prs[0] if prs else None


def _adopt_pr(
    existing: Mapping[str, Any],
    *,
    branch: str,
    revert_sha: str,
    base_sha: str,
    purity: dict[str, Any],
    change_id: str,
    request_id: str,
    base_dir: str | Path | None,
) -> dict[str, Any]:
    """Take an open PR at the revert's head as this key's PR: bind it to the
    revert's change chain (the anchor the merge authority's triple gate
    joins on) unless it already is, and answer the create intent an
    interrupted attempt left unresolved."""
    from .auto_merge import change_for_pr, record_pr_lifecycle

    number = int(existing["number"])
    if change_for_pr(number, base_dir=base_dir) != change_id:
        record_pr_lifecycle(
            {"number": number, "base_branch": ARIA_PR_BASE, "head_sha": revert_sha, "base_sha": base_sha,
             "branch": branch, "change_id": change_id, "changed_files": list(purity["revert_files"])},
            event="opened", base_dir=base_dir,
        )
    _confirm_intents(
        request_id, effect_kind="pr_create", matches=lambda intended: intended.get("head_ref") == branch,
        observed={"pr_number": number, "url": existing.get("url"), "head_sha": revert_sha, "adopted": True},
        base_dir=base_dir,
    )
    return {"pr_number": number, "url": existing.get("url"), "change_id": change_id, "adopted": True}


def _deliver(
    candidate: _Candidate,
    *,
    branch: str,
    worktree: Path,
    revert_sha: str,
    base_sha: str,
    remote_head: str | None,
    purity: dict[str, Any],
    change_id: str,
    cycle_id: str,
    base_dir: str | Path | None,
    workspace: Path,
) -> dict[str, Any]:
    """Push (unless the remote already holds the revert), then adopt the
    open PR at the revert's head or open one, inside one credential hold,
    for a validated chain. Returns the PR (``pr_number``, ``url``,
    ``adopted``). Raises ``_Pending`` when the credential could not be
    minted or no PR could be adopted or opened — retried, never terminal:
    the deterministic revert meets its validated chain, its pushed branch
    and its PR on the next attempt."""
    from .delivery_credentials import (
        DELIVERY_CREDENTIAL_CONSUMPTION_SECONDS,
        DELIVERY_CREDENTIAL_SELF_REVERT_CONSUMER,
        DeliveryCredentialError,
        hold_delivery_credentials,
    )
    from .implementation_safety import CANONICAL_VALIDATION_COMMANDS
    from .pr_manager import open_revert_pr

    request_id = _request_id(candidate.merge_sha)
    files = list(purity["revert_files"])
    with ExitStack() as credential_hold:
        try:
            credential = credential_hold.enter_context(hold_delivery_credentials(
                profile=SelfRevertDeliveryGrant(), request_id=request_id, cycle_id=cycle_id,
                workspace_root=workspace, base_dir=base_dir,
                covers_seconds=DELIVERY_CREDENTIAL_CONSUMPTION_SECONDS + GH_PR_LOOKUP_TIMEOUT_SECONDS,
                consumer=DELIVERY_CREDENTIAL_SELF_REVERT_CONSUMER,
            ))
        except DeliveryCredentialError as exc:
            raise _Pending(DECISION_CREDENTIAL_UNAVAILABLE, str(exc)[:300], {"change_id": change_id}) from exc
        credential_env: dict[str, str] = dict(credential.env) if credential is not None else {}
        environment = {**os.environ, **credential_env}
        if remote_head is None:
            _push_revert(branch=branch, worktree=worktree, workspace=workspace, revert_sha=revert_sha,
                         change_id=change_id, purity=purity, request_id=request_id,
                         environment=environment, base_dir=base_dir)
        else:
            _confirm_intents(
                request_id, effect_kind="git_push", matches=lambda intended: intended.get("head_sha") == revert_sha,
                observed={"branch": branch, "remote": _REMOTE, "head_sha": revert_sha, "resumed": True},
                base_dir=base_dir,
            )
        existing = _open_pr_for_branch(branch, workspace=workspace, environment=environment)
        if existing is not None:
            if existing.get("headRefOid") != revert_sha:
                raise _Pending(DECISION_PR_PENDING,
                               f"open_pr_head_mismatch:#{existing.get('number')}:{existing.get('headRefOid')}",
                               {"branch_pushed": branch, "head_sha": revert_sha})
            return _adopt_pr(existing, branch=branch, revert_sha=revert_sha, base_sha=base_sha, purity=purity,
                             change_id=change_id, request_id=request_id, base_dir=base_dir)
        try:
            opened = open_revert_pr(
                workspace_root=workspace, branch=branch, head_sha=revert_sha, base_sha=base_sha,
                title=f"Revert ARIA merge {candidate.merge_sha[:12]} (PR #{candidate.pr_number})",
                body=_pr_body(candidate, branch=branch, base_sha=base_sha, purity=purity, change_id=change_id),
                change_id=change_id, changed_files=files,
                validation_commands=list(CANONICAL_VALIDATION_COMMANDS), request_id=request_id,
                base_dir=base_dir, command_environment=credential_env or None,
            )
        except GovernanceError as exc:
            raise _Pending(DECISION_PR_PENDING, f"pr_open_refused:{str(exc)[:300]}",
                           {"change_id": change_id, "branch_pushed": branch}) from exc
    return {"pr_number": opened["pr_number"], "url": opened.get("url"), "change_id": change_id, "adopted": False}


def _pr_body(candidate: _Candidate, *, branch: str, base_sha: str, purity: dict[str, Any], change_id: str) -> str:
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
        f"`git revert --no-edit {candidate.merge_sha}` on `{branch}`, from `{base_sha}` on `main`. Files:",
        files,
        "",
        "## Validation",
        f"- Purity: revert patch-id `{purity['revert_patch_id']}` equals the inverse patch-id "
        f"`{purity['inverse_patch_id']}`; the file sets are identical.",
        "- The suite that validated the reverted change was re-run at this head and recorded for this change.",
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
        if row.get("decision") not in OPENED_DECISIONS or row.get("key") in landed:
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
    "ATTRIBUTION_ANCESTOR_LIMIT",
    "DECISION_BRANCH_DIVERGED",
    "DECISION_CONFLICT",
    "DECISION_CREDENTIAL_UNAVAILABLE",
    "DECISION_DELIVERY_FAILED",
    "DECISION_FAILED",
    "DECISION_IMPURE",
    "DECISION_LANDED",
    "DECISION_NOT_ATTRIBUTABLE",
    "DECISION_NOT_PERMITTED",
    "DECISION_OPENED",
    "DECISION_OPENED_AWAITING_HUMAN",
    "DECISION_PR_PENDING",
    "DECISION_REMOTE_UNRESOLVED",
    "DECISION_REVERT_OF_REVERT",
    "DECISION_UNBOUND",
    "DECISION_VALIDATION_FAILED",
    "DECISION_VALIDATION_UNAVAILABLE",
    "HUMAN_REQUIRED_DECISIONS",
    "OPENED_DECISIONS",
    "RETRIED_DECISIONS",
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
    "revert_merge_authority",
    "run_self_revert_producer",
    "self_reverts_path",
]
