"""ARIA-HIGH-374 — when may a PR head that is not the delivered commit still be ARIA's?

WHY. ``main`` is strict (up-to-date branches required, no merge queue), so an
ARIA PR is mergeable only after ``main`` has been merged into it
(ARIA-HIGH-372: ``pr_branch_update``). Every self-merge gate bound the PR head
to the commit the delivery verified, signed, gated and recorded
(``change_committed.commit_sha``): the triple gate
(``auto_merge._evaluate_triple_gate``), the native merge context
(``merge_authority._capture_pre_merge_context``) and the implementation join
(``merge_authority._join_pre_merge_implementation``). An updated PR was
therefore refused by all three, and an L1 ARIA PR self-merged only if ``main``
had not moved since its anchor — hourly, here.

WHAT. :func:`verify_branch_update_lineage` is the ONE answer all three gates,
the human-merge surface and both update requesters read. A head that differs
from the delivered commit is accepted only when walking its FIRST-parent chain
back to the delivered commit, every commit on the way is:

1. a two-parent merge that IS the result ARIA recorded for an update it asked
   for: a ``pr_branch_update`` intent ``(expected_head_sha, base_sha)`` whose
   confirmed receipt names this commit as ``result_head_sha``, read back from
   GitHub after the call (GSEC-MEDIUM-002 — "the head moved" is never taken
   as "our update landed");
2. merging a commit of ``main``: the second parent descends from the recorded
   base and is contained in the live base;
3. pure: its tree is exactly the tree ``git merge-tree --write-tree`` computes
   for its two parents, computed HERMETICALLY (GSEC-MEDIUM-001): in a
   throwaway bare repository that borrows the checkout's objects through
   ``alternates`` and carries no config of its own, with system and global
   config off, replace refs off, ``core.attributesFile=/dev/null`` and the
   attributes read from the EMPTY tree (``--attr-source``), renormalisation
   off and hooks pointed at ``/dev/null``. No ``.gitattributes`` of the PR,
   no merge driver the checkout registered (this repository registers
   ``findings-registry``, a relative ``./node_modules/.bin/ts-node``), and no
   replace ref can run code or make a conflicted merge look clean: only
   git's own text merge decides, the one GitHub's ``update-branch`` makes.

And (GSEC-MEDIUM-003) an updated head is refused when the merged change
touches a project the CI quarantine policy (``scripts/ci/affected-target-
policy.json`` as committed on the live base) runs as a warning: the
delivery's hygiene runs and the expert panel judged the DELIVERED tree, CI
is the only judge of the merged tree, and for those projects CI does not
gate (``updated_head_touches_quarantined_project``). A re-run of the
four-command suite on the merged head inside the merge lane would be the
whole implementation gate again on a hosted runner with no sandbox
(``implementation_delivery.validation_sandbox_for``); the refusal keeps
the lane a decision step and leaves such a PR to a person.

Anything else is refused by name (``BranchUpdateLineageRefused``); the walk is
bounded (``MAX_RECORDED_UPDATES``). CI on the CURRENT head stays the merge
authority's own requirement (``evaluate_auto_merge``).
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from contextlib import contextmanager

from .tool_registry import GovernanceError, ensure_tools_dir

# ~1 update per main commit while the PR waits: 64 is two days of hourly
# merges to main, past which a person is better placed to look anyway.
MAX_RECORDED_UPDATES = 64
_FULL_SHA = re.compile(r"[0-9a-f]{40}")
_GIT_TIMEOUT_SECONDS = 60
EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
QUARANTINE_POLICY_PATH = "scripts/ci/affected-target-policy.json"
# Every option git honours from configuration that could execute a program
# or change what a merge produces, neutralised on the command line as well
# as by the config-free repository (defence in depth for a future git).
_HERMETIC_OPTIONS: tuple[str, ...] = (
    "--no-replace-objects", f"--attr-source={EMPTY_TREE}",
    "-c", "core.attributesFile=/dev/null", "-c", "core.hooksPath=/dev/null",
    "-c", "merge.renormalize=false", "-c", "core.fsmonitor=false",
)


class BranchUpdateLineageRefused(GovernanceError):
    """The head is not the delivered commit plus ARIA's own pure updates."""

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(f"branch_update_lineage_refused:{reason}")


@dataclass(frozen=True)
class BranchUpdateLineage:
    """The verified chain: ``updates`` are ``(previous_head, merged_base, result)``, newest first."""

    head_sha: str
    delivered_sha: str
    updates: tuple[tuple[str, str, str], ...]


def _hermetic_env() -> dict[str, str]:
    from .main_anchor import scrubbed_git_env

    return {**scrubbed_git_env(), "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_ATTR_NOSYSTEM": "1",
            "GIT_CONFIG_NOSYSTEM": "1"}


def _objects_dir(workspace: Path) -> Path:
    """The checkout's object store, found WITHOUT asking its git (whose config is not trusted)."""
    dot_git = workspace / ".git"
    if dot_git.is_dir():
        git_dir = dot_git
    elif dot_git.is_file():
        line = dot_git.read_text(encoding="utf-8").strip()
        if not line.startswith("gitdir:"):
            raise BranchUpdateLineageRefused("checkout_git_dir_unreadable")
        git_dir = (workspace / line.split(":", 1)[1].strip()).resolve()
        common = git_dir / "commondir"
        if common.is_file():
            git_dir = (git_dir / common.read_text(encoding="utf-8").strip()).resolve()
    elif (workspace / "objects").is_dir():
        git_dir = workspace
    else:
        raise BranchUpdateLineageRefused("checkout_git_dir_unreadable")
    objects = git_dir / "objects"
    if not objects.is_dir():
        raise BranchUpdateLineageRefused("checkout_objects_unreadable")
    return objects


class _HermeticGit:
    """git over the checkout's objects in a config-free throwaway bare repository."""

    def __init__(self, repo: Path) -> None:
        self.repo = repo
        self.env = _hermetic_env()

    def run(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", *_HERMETIC_OPTIONS, "-C", str(self.repo), *args],
            capture_output=True, text=True, check=False, timeout=_GIT_TIMEOUT_SECONDS, env=self.env,
            stdin=subprocess.DEVNULL,
        )


@contextmanager
def hermetic_git(workspace: str | Path) -> Iterator[_HermeticGit]:
    objects = _objects_dir(Path(workspace).resolve())
    holder = Path(tempfile.mkdtemp(prefix="aria-lineage-"))
    try:
        repo = holder / "repo.git"
        made = subprocess.run(["git", "init", "-q", "--bare", "--template=", str(repo)], capture_output=True,
                              text=True, check=False, timeout=_GIT_TIMEOUT_SECONDS, env=_hermetic_env(),
                              stdin=subprocess.DEVNULL)
        if made.returncode != 0:
            raise BranchUpdateLineageRefused("hermetic_repository_unavailable")
        (repo / "objects" / "info").mkdir(parents=True, exist_ok=True)
        (repo / "objects" / "info" / "alternates").write_text(f"{objects}\n", encoding="utf-8")
        yield _HermeticGit(repo)
    finally:
        shutil.rmtree(holder, ignore_errors=True)


def recorded_updates(*, base_dir: str | Path | None, pr_number: int) -> dict[tuple[str, str], tuple[str, ...]]:
    """``{(expected_head, result_head): (recorded bases...)}`` of this PR's confirmed updates.

    Only a receipt that names the head GitHub produced counts; an intent,
    a failed or absent receipt, or a confirmed one without a read-back
    result is not an update ARIA can vouch for.
    """
    from .ledger import load_declared_jsonl
    from .pr_branch_update import EFFECT_KIND, update_request_id
    from .recovery import EXTERNAL_EFFECTS_RELPATH, EXTERNAL_EFFECTS_SURFACE

    path = ensure_tools_dir(base_dir).joinpath(*EXTERNAL_EFFECTS_RELPATH)
    if not path.exists():
        return {}
    request_id = update_request_id(pr_number)
    latest: dict[str, dict[str, Any]] = {}
    for row in load_declared_jsonl(path, expected_surface=EXTERNAL_EFFECTS_SURFACE):
        if row.get("request_id") != request_id:
            continue
        operation_id = str(row.get("operation_id"))
        if row.get("event") == "intent":
            latest[operation_id] = {"intent": row, "receipt": None}
        elif row.get("event") == "receipt" and operation_id in latest:
            latest[operation_id]["receipt"] = row
    recorded: dict[tuple[str, str], list[str]] = {}
    for entry in latest.values():
        intent, receipt = entry["intent"], entry["receipt"]
        intended = intent.get("intended_postcondition") or {}
        result = str(((receipt or {}).get("observed_receipt") or {}).get("result_head_sha") or "")
        head, base = str(intended.get("expected_head_sha") or ""), str(intended.get("base_sha") or "")
        if (
            receipt is not None and receipt.get("status") == "confirmed"
            and intent.get("effect_kind") == EFFECT_KIND and intent.get("target") == f"pr#{pr_number}"
            and intended.get("pr_number") == pr_number
            and all(_FULL_SHA.fullmatch(value) for value in (head, base, result))
        ):
            recorded.setdefault((head, result), []).append(base)
    return {pair: tuple(bases) for pair, bases in recorded.items()}


def _verify_pure_update(
    git: _HermeticGit, commit: str, *, recorded: dict[tuple[str, str], tuple[str, ...]], live_base_sha: str,
) -> tuple[str, str]:
    """``(first_parent, merged_base)`` of one verified update commit, or refuse."""
    short = commit[:12]
    listed = git.run("rev-list", "--parents", "-n", "1", commit)
    if listed.returncode != 0:
        raise BranchUpdateLineageRefused(f"commit_unreadable:{short}")
    parents = listed.stdout.split()[1:]
    if len(parents) != 2:
        raise BranchUpdateLineageRefused(f"unrecorded_commit:{short}:parents={len(parents)}")
    previous, merged = parents
    bases = recorded.get((previous, commit))
    if not bases:
        raise BranchUpdateLineageRefused(f"unrecorded_commit:{short}:not_a_recorded_update_of:{previous[:12]}")
    if not any(git.run("merge-base", "--is-ancestor", base, merged).returncode == 0 for base in bases) \
            or git.run("merge-base", "--is-ancestor", merged, live_base_sha).returncode != 0:
        raise BranchUpdateLineageRefused(f"merged_base_not_main:{short}:{merged[:12]}")
    computed = git.run("merge-tree", "--write-tree", "--no-messages", previous, merged)
    tree = git.run("rev-parse", "--verify", f"{commit}^{{tree}}")
    expected = (computed.stdout.splitlines() or [""])[0].strip()
    if computed.returncode != 0 or tree.returncode != 0 or not _FULL_SHA.fullmatch(expected):
        raise BranchUpdateLineageRefused(f"merge_not_clean:{short}:rc={computed.returncode}")
    if tree.stdout.strip() != expected:
        raise BranchUpdateLineageRefused(f"tree_differs_from_pure_merge:{short}")
    return previous, merged


def _quarantined_projects_touched(git: _HermeticGit, *, head_sha: str, live_base_sha: str) -> list[str]:
    """Projects the merged change touches that CI runs as a warning, per main's policy."""
    from .impact_graph import project_for_path

    shown = git.run("show", f"{live_base_sha}:{QUARANTINE_POLICY_PATH}")
    if shown.returncode != 0:
        raise BranchUpdateLineageRefused("quarantine_policy_unreadable")
    try:
        targets = json.loads(shown.stdout).get("targets") or {}
        quarantined = {name for target in targets.values() if isinstance(target, dict)
                       for name in (target.get("knownUnstableProjects") or {})}
    except (ValueError, AttributeError) as exc:
        raise BranchUpdateLineageRefused("quarantine_policy_unreadable") from exc
    fork = git.run("merge-base", live_base_sha, head_sha)
    changed = git.run("diff", "--name-only", "--no-renames", "-z", fork.stdout.strip(), head_sha)
    listed = git.run("ls-tree", "-r", "--name-only", "-z", live_base_sha)
    if fork.returncode != 0 or changed.returncode != 0 or listed.returncode != 0:
        raise BranchUpdateLineageRefused("merged_change_unreadable")
    roots: dict[str, str] = {}
    for path in (entry for entry in listed.stdout.split("\0") if entry.endswith("project.json")):
        body = git.run("show", f"{live_base_sha}:{path}")
        root = path[: -len("project.json")].rstrip("/") or "."
        try:
            name = json.loads(body.stdout).get("name") if body.returncode == 0 else None
        except ValueError:
            name = None
        roots[str(name or Path(root).name)] = root
    owners = {project_for_path(path, roots) for path in changed.stdout.split("\0") if path}
    return sorted(owner for owner in owners if owner and owner in quarantined)


def verify_branch_update_lineage(
    *,
    workspace: str | Path,
    base_dir: str | Path | None,
    pr_number: int,
    head_sha: str,
    delivered_sha: str,
    live_base_sha: str,
) -> BranchUpdateLineage:
    """Accept ``head_sha`` as ``delivered_sha`` plus ARIA's own pure updates, or refuse.

    ``head_sha == delivered_sha`` is the zero-update lineage. A missing
    object, a missing ``git`` or an unreadable ledger is a refusal by name,
    never a pass and never an exception other than the refusal.
    """
    from .ledger import LedgerIntegrityError

    for label, value in (("head", head_sha), ("delivered", delivered_sha), ("live_base", live_base_sha)):
        if not isinstance(value, str) or not _FULL_SHA.fullmatch(value):
            raise BranchUpdateLineageRefused(f"{label}_sha_unreadable")
    if head_sha == delivered_sha:
        return BranchUpdateLineage(head_sha=head_sha, delivered_sha=delivered_sha, updates=())
    try:
        recorded = recorded_updates(base_dir=base_dir, pr_number=pr_number)
    except (LedgerIntegrityError, OSError, ValueError) as exc:
        raise BranchUpdateLineageRefused(f"update_ledger_unreadable:{type(exc).__name__}") from exc
    except BranchUpdateLineageRefused:
        raise
    except GovernanceError as exc:
        raise BranchUpdateLineageRefused(f"update_ledger_unreadable:{type(exc).__name__}") from exc
    if not recorded:
        raise BranchUpdateLineageRefused(f"unrecorded_commit:{head_sha[:12]}:no_update_recorded_for_pr")
    updates: list[tuple[str, str, str]] = []
    try:
        with hermetic_git(workspace) as git:
            current = head_sha
            while current != delivered_sha:
                if len(updates) >= MAX_RECORDED_UPDATES:
                    raise BranchUpdateLineageRefused(f"more_than_{MAX_RECORDED_UPDATES}_updates")
                previous, merged = _verify_pure_update(git, current, recorded=recorded, live_base_sha=live_base_sha)
                updates.append((previous, merged, current))
                current = previous
            touched = _quarantined_projects_touched(git, head_sha=head_sha, live_base_sha=live_base_sha)
    except (OSError, subprocess.SubprocessError) as exc:
        raise BranchUpdateLineageRefused(f"git_unavailable:{type(exc).__name__}") from exc
    if touched:
        raise BranchUpdateLineageRefused("updated_head_touches_quarantined_project:" + ",".join(touched))
    return BranchUpdateLineage(head_sha=head_sha, delivered_sha=delivered_sha, updates=tuple(updates))


def delivered_commit_for_pr(*, base_dir: str | Path | None, pr_number: int) -> str | None:
    """The change ledger's committed sha for the change bound to this PR, or None."""
    from .auto_merge import change_for_pr
    from .change_ledger import _find_committed

    change_id = change_for_pr(pr_number, base_dir=base_dir)
    committed = _find_committed(ensure_tools_dir(base_dir), change_id) if change_id else None
    sha = str((committed or {}).get("commit_sha") or "")
    return sha if _FULL_SHA.fullmatch(sha) else None


def update_request_refusal(
    *,
    workspace: str | Path,
    base_dir: str | Path | None,
    pr_number: int,
    head_sha: str,
    live_base_sha: str,
    branch: str,
    base_branch: str,
    checks_green: bool,
) -> str | None:
    """GSEC-MEDIUM-002 — why ARIA must NOT ask GitHub to update this head, or None.

    The ONE predicate both requesters (the cycle's batch and the merge
    lane) read: an ARIA implementation branch against ``main``, settled
    green, whose head is the delivered commit or passes the lineage — ARIA
    never merges main into a head it cannot vouch for.
    """
    from .command_policy import ARIA_IMPL_BRANCH_FRAGMENT

    if re.fullmatch(ARIA_IMPL_BRANCH_FRAGMENT, branch or "") is None:
        return "not_an_aria_implementation_branch"
    if base_branch != "main":
        return f"base_is_not_main:{base_branch or 'unknown'}"
    if not checks_green:
        return "head_checks_not_green"
    delivered = delivered_commit_for_pr(base_dir=base_dir, pr_number=pr_number)
    if delivered is None:
        return "delivered_commit_unrecorded"
    try:
        verify_branch_update_lineage(workspace=workspace, base_dir=base_dir, pr_number=pr_number,
                                     head_sha=head_sha, delivered_sha=delivered, live_base_sha=live_base_sha)
    except BranchUpdateLineageRefused as exc:
        return f"head_lineage_refused:{exc.reason}"
    return None


def fetch_pr_head(workspace: str | Path, pr_number: int) -> None:
    """Bring the PR's commits into the checkout by object id; no local ref is written."""
    from .main_anchor import scrubbed_git_env

    try:
        subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "fetch", "--no-tags", "--quiet", "origin",
                        f"refs/pull/{int(pr_number)}/head"], cwd=workspace, capture_output=True, text=True,
                       check=False, timeout=120, env=scrubbed_git_env(), stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return  # the walk names an object it cannot read; nothing passes on a failed fetch


def lineage_summary(lineage: BranchUpdateLineage) -> dict[str, Any]:
    return {"head_sha": lineage.head_sha, "delivered_sha": lineage.delivered_sha,
            "updates": [list(update) for update in lineage.updates]}


__all__ = [
    "BranchUpdateLineage",
    "BranchUpdateLineageRefused",
    "EMPTY_TREE",
    "MAX_RECORDED_UPDATES",
    "QUARANTINE_POLICY_PATH",
    "delivered_commit_for_pr",
    "fetch_pr_head",
    "hermetic_git",
    "lineage_summary",
    "recorded_updates",
    "update_request_refusal",
    "verify_branch_update_lineage",
]
