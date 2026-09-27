"""The per-request worktree — the tree a request is served from.

Under ``managed_subscription`` the native admission binds
``request.target_sha`` to the checkout's HEAD (`_native_task_binding_refusal`):
a request can only be served from a tree at its own anchor, and the shared
checkout — main, advancing every hour on this repository — refuses every
request minted before its last advance as ``target_revision_mismatch``. The
drain learned this first (Plan 032 Faz 032h, ARIA-HIGH-095/124): it adds
``aria-worktrees/req-<id>`` at the request's anchor, runs the child there
with ``ARIA_WORKSPACE_ROOT`` pointing at it, and removes it after. The
planner dispatch hook did not (ARIA-HIGH-176): measured 2026-09-19, one
challenger-plan request minted at 09-18's main was refused forty times in a
day from the cycle's shared checkout, released harness-class each time, and
never ran — zero convergences, zero implementations behind it. These
helpers are the ONE spelling both callers use; each passes its own bounded
runner and logger.
"""
from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

REQUEST_WORKTREES_DIR = "aria-worktrees"

Runner = Callable[..., "subprocess.CompletedProcess[str]"]
Logger = Callable[[str], None]


@dataclass(frozen=True)
class RequestWorktree:
    """What `git worktree add` came back with: a tree, a refusal, or no answer.

    ``path`` is the worktree when git created it; ``None`` with no
    ``unanswered_reason`` means git ANSWERED that it could not (the shared
    checkout is used instead, as before); ``unanswered_reason`` names why
    git did not answer inside its bound — the harness's condition, on which
    the child is not started and the request stays PENDING.
    """

    path: Path | None
    unanswered_reason: str | None = None


def request_worktree_path(repo_root: Path, request_id: str) -> Path:
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in str(request_id))[:64]
    return Path(repo_root) / REQUEST_WORKTREES_DIR / f"req-{safe}"


def run_worktree_git(
    argv: list[str], *, cwd: Path, timeout_seconds: float, run: Runner = subprocess.run,
) -> tuple[subprocess.CompletedProcess[str] | None, str | None]:
    """One bounded worktree call: (answer, None) or (None, why it did not answer)."""
    try:
        done = run(argv, cwd=str(cwd), capture_output=True, text=True, check=False, timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        return None, "timeout"
    except OSError as exc:
        return None, f"spawn_failed:{type(exc).__name__}"
    return done, None


def add_request_worktree(
    repo_root: Path, request_id: str, target_sha: object, *, timeout_seconds: float,
    log: Logger, run: Runner = subprocess.run, stage_prefix: str = "drain",
) -> RequestWorktree:
    """`git worktree add --detach aria-worktrees/req-<id> <target_sha|HEAD>`, bounded;
    `path=None` = fall back to the shared checkout.

    A leftover registration is reconciled first: a run reaped mid-child
    leaves `.git/worktrees/req-<id>` registered — with its directory gone
    (the next checkout's clean) `git worktree add` refuses "missing but
    already registered" until pruned; with the directory still there it
    refuses "already exists" until removed. Both are git's own reconcile
    commands, run before the add, so the same request id can be served
    again tomorrow instead of falling back to the shared checkout and its
    target mismatch.
    """
    path = request_worktree_path(repo_root, request_id)
    ref = str(target_sha or "").strip() or "HEAD"
    path.parent.mkdir(parents=True, exist_ok=True)
    pruned, unanswered = run_worktree_git(["git", "worktree", "prune"], cwd=Path(repo_root),
                                          timeout_seconds=timeout_seconds, run=run)
    if pruned is None:
        log(f"{stage_prefix}_worktree_prune_unanswered request_id={request_id} reason={unanswered} "
            f"bound={timeout_seconds}s")
        return RequestWorktree(path=None, unanswered_reason=unanswered)
    if pruned.returncode != 0:
        log(f"{stage_prefix}_worktree_prune_failed rc={pruned.returncode} {(pruned.stderr or '').strip()[:120]}")
    if path.exists():
        log(f"{stage_prefix}_worktree_leftover_removed request_id={request_id} path={path}")
        leftover_unanswered = remove_request_worktree(repo_root, path, timeout_seconds=timeout_seconds, log=log,
                                                      run=run, stage_prefix=stage_prefix)
        if leftover_unanswered is not None:
            return RequestWorktree(path=None, unanswered_reason=leftover_unanswered)
    done, unanswered = run_worktree_git(["git", "worktree", "add", "--detach", str(path), ref], cwd=Path(repo_root),
                                        timeout_seconds=timeout_seconds, run=run)
    if done is None:
        log(f"{stage_prefix}_worktree_add_unanswered request_id={request_id} reason={unanswered} "
            f"bound={timeout_seconds}s")
        return RequestWorktree(path=None, unanswered_reason=unanswered)
    if done.returncode != 0:
        log(f"{stage_prefix}_worktree_add_failed request_id={request_id} rc={done.returncode} "
            f"{(done.stderr or '').strip()[:120]}")
        return RequestWorktree(path=None)
    return RequestWorktree(path=path)


def remove_request_worktree(
    repo_root: Path, path: Path, *, timeout_seconds: float, log: Logger, run: Runner = subprocess.run,
    stage_prefix: str = "drain",
) -> str | None:
    """`git worktree remove --force <path>`, bounded; returns why git did not answer, if it did not."""
    done, unanswered = run_worktree_git(["git", "worktree", "remove", "--force", str(path)], cwd=Path(repo_root),
                                        timeout_seconds=timeout_seconds, run=run)
    if done is None:
        log(f"{stage_prefix}_worktree_remove_unanswered path={path} reason={unanswered} bound={timeout_seconds}s")
        return unanswered
    if done.returncode != 0:
        log(f"{stage_prefix}_worktree_remove_failed path={path} rc={done.returncode}")
    return None


__all__ = ["REQUEST_WORKTREES_DIR", "RequestWorktree", "add_request_worktree", "remove_request_worktree",
           "request_worktree_path", "run_worktree_git"]
