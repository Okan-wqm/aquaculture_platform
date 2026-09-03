"""Plan ARIA-V2 §Phase 1 MEDIUM-015 — shared git-repo factory helpers.

Pre-Phase-1: 11+ existing tests duplicated ``subprocess.run(["git", "init"])``
patterns inline. This module consolidates the pattern so canonical-
identity tests (I-1..I-4) can construct fixture git repos with
specific ``remote.origin.url`` values without each test reinventing
~20 lines of subprocess plumbing.

The directory ``aria-kernel/tests/_helpers/`` is deliberately named so
it does NOT match the ``unittest discover -p '*test*.py'`` glob. Files
here are imported by tests, not executed AS tests.
"""

from __future__ import annotations

import subprocess
from pathlib import Path


def _git(args: list[str], *, cwd: Path, check: bool = True) -> subprocess.CompletedProcess:
    """Thin git wrapper that always passes ``cwd`` and silences stdout."""
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        text=True,
        capture_output=True,
        check=check,
    )


def make_local_git_repo(
    tmp_path: Path,
    *,
    name: str = "repo",
    remote_url: str | None = None,
    initial_commit: bool = True,
) -> Path:
    """Initialize a local git repository at ``tmp_path / name``.

    * ``remote_url`` is set via ``git config --add remote.origin.url <url>``
      so :func:`aria_kernel.workspace.canonical_identity` can pick it up.
    * ``initial_commit`` controls whether an empty initial commit lands
      (required for :func:`aria_kernel.workspace._git_root_commit_sha`
      offline-fallback tests).
    """
    repo = tmp_path / name
    repo.mkdir(parents=True, exist_ok=True)
    _git(["init", "-q"], cwd=repo)
    _git(["config", "user.email", "fixture@aria.test"], cwd=repo)
    _git(["config", "user.name", "Aria Fixture"], cwd=repo)
    # ORPHAN-LOW-301 — fixture repos must never spawn background git
    # maintenance: a detached `git gc --auto` kept writing
    # .git/objects/pack while TemporaryDirectory.cleanup() ran rmtree,
    # producing a flaky "Directory not empty" teardown error in CI
    # (burn-in suite, run 28558877068). Disabling auto-gc and the
    # detached maintenance worker makes the race structurally
    # impossible for every fixture consumer.
    _git(["config", "gc.auto", "0"], cwd=repo)
    _git(["config", "gc.autoDetach", "false"], cwd=repo)
    _git(["config", "maintenance.auto", "false"], cwd=repo)
    if remote_url is not None:
        _git(["config", "remote.origin.url", remote_url], cwd=repo)
    if initial_commit:
        (repo / ".gitkeep").write_text("", encoding="utf-8")
        _git(["add", ".gitkeep"], cwd=repo)
        _git(["commit", "-q", "-m", "fixture: initial commit", "--allow-empty"], cwd=repo)
    return repo


def make_git_worktree(canonical_repo: Path, worktree_path: Path, *, branch: str = "fixture-wt") -> Path:
    """Create a git worktree of ``canonical_repo`` at ``worktree_path``.

    The new worktree shares the canonical repo's ``--git-common-dir``,
    so :func:`aria_kernel.workspace.canonical_repo_root` resolves it
    back to ``canonical_repo``. Used by ``test_canonical_identity_worktree_independent``
    (Plan ARIA-V2 I-4) to assert worktrees of the same repo hash
    identically to the canonical root.
    """
    worktree_path.parent.mkdir(parents=True, exist_ok=True)
    _git(["worktree", "add", "-q", "-b", branch, str(worktree_path)], cwd=canonical_repo)
    return worktree_path


def make_repo_with_initial_commit(
    tmp_path: Path,
    files: dict[str, str],
    *,
    name: str = "repo",
    remote_url: str | None = None,
) -> Path:
    """Initialize a git repo with ``files`` (path → content) committed.

    Used by tests that need a non-trivial tree (e.g. fates fixtures,
    discovery fixture trees with ``project.json`` markers).
    """
    repo = make_local_git_repo(tmp_path, name=name, remote_url=remote_url, initial_commit=False)
    for rel, content in files.items():
        path = repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        _git(["add", str(rel)], cwd=repo)
    _git(["commit", "-q", "-m", f"fixture: seed {len(files)} files"], cwd=repo)
    return repo
