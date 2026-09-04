"""Plan 032 Faz 032c — request-bound workspace checkpoints in a shadow git store.

WHY: ARIA had no restorable pre-implementer state. `rollback_bundle` and
`incident_ledger` attest PR-level rollbacks; `snapshot.build_repo_snapshot`
hashes files but keeps no blobs; the worktree lanes record `base_sha` as a
reference, not a checkpoint. A write-capable agent that goes wrong leaves
the operator with `git checkout -- .` — which also destroys the operator's
own uncommitted work in that tree.

WHAT: a bare git object store OUTSIDE the workspace
(``~/.aria/workspaces/<repo_hash>/checkpoints/store``) — the agent's
sandbox cannot see it, it is never published to ``aria/state`` (an
artifact, re-derivable), and it shares nothing with the project's ``.git``.
A checkpoint is a tree of the workspace's tracked files plus the files the
work journal says the agent created, committed under
``refs/aria/<request_id>/<seq>`` and indexed on the declared ledger
``checkpoints/index.jsonl``. Restore is per request and per file, and
PRESERVES HAND EDITS by default: only files the journal attributes to the
agent are put back unless the caller names files explicitly.

Taken by the PreToolUse hook before the first write of a turn (Faz 032b-2
wires the call), by the executor before a write-capable spawn, and restored
by the executor when a spawn ends blocked.
"""
from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now

CHECKPOINT_INDEX_SURFACE = "checkpoints_index"
CHECKPOINT_INDEX_RELPATH = ("checkpoints", "index.jsonl")
CHECKPOINT_REF_PREFIX = "refs/aria"
CHECKPOINT_STORE_DIRNAME = "checkpoints"
DEFAULT_MAX_SNAPSHOTS = 20
DEFAULT_MAX_TOTAL_MB = 500
DEFAULT_RETENTION_DAYS = 7
DEFAULT_MAX_FILE_MB = 10
# One checkpoint per turn: a second request inside this window is folded.
MIN_INTERVAL_SECONDS = 20


@dataclass(frozen=True)
class Checkpoint:
    request_id: str
    seq: int
    commit: str
    tree: str
    reason: str
    recorded_at: str
    file_count: int
    ref: str


def checkpoint_store(workspace_root: str | Path) -> Path:
    """The shadow store for this repository, outside the workspace."""
    from .workspace import workspace_paths

    paths = workspace_paths(Path(workspace_root).resolve())
    return paths.workspace_root / CHECKPOINT_STORE_DIRNAME / "store"


def _git(store: Path, workspace: Path, args: Sequence[str], *, env: dict[str, str] | None = None, check: bool = True) -> str:
    base_env = {**os.environ, "GIT_DIR": str(store), "GIT_WORK_TREE": str(workspace)}
    if env:
        base_env.update(env)
    completed = subprocess.run(
        ["git", *args], cwd=str(workspace), env=base_env, capture_output=True, text=True, check=False,
    )
    if check and completed.returncode != 0:
        raise GovernanceError(f"checkpoint_git_failed:{args[0]}:{completed.stderr.strip()[:200]}")
    return completed.stdout.strip()


def _ensure_store(store: Path, workspace: Path) -> None:
    if not (store / "HEAD").exists():
        store.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "init", "--bare", "-q", str(store)], check=True, capture_output=True)
    # The store is private to the runner user; never world-readable.
    try:
        os.chmod(store, 0o700)
    except OSError:
        pass


def _index_path(base_dir: str | Path | None) -> Path:
    return ensure_tools_dir(base_dir).joinpath(*CHECKPOINT_INDEX_RELPATH)


def list_checkpoints(request_id: str, *, base_dir: str | Path | None = None) -> list[Checkpoint]:
    path = _index_path(base_dir)
    if not path.exists():
        return []
    rows = load_declared_jsonl(path, expected_surface=CHECKPOINT_INDEX_SURFACE)
    out = [
        Checkpoint(
            request_id=str(r["request_id"]), seq=int(r["seq"]), commit=str(r["commit"]), tree=str(r["tree"]),
            reason=str(r.get("reason") or ""), recorded_at=str(r.get("recorded_at") or ""),
            file_count=int(r.get("file_count") or 0), ref=str(r["ref"]),
        )
        for r in rows if r.get("request_id") == request_id and r.get("event", "taken") == "taken"
    ]
    return sorted(out, key=lambda c: c.seq)


def _tracked_and_journaled_files(store: Path, workspace: Path, journal_files: Sequence[str]) -> list[str]:
    tracked = subprocess.run(
        ["git", "ls-files", "-z"], cwd=str(workspace), capture_output=True, text=True, check=False,
    ).stdout.split("\0")
    files = [f for f in tracked if f]
    for candidate in journal_files:
        try:
            rel = Path(candidate).resolve().relative_to(workspace).as_posix()
        except ValueError:
            continue
        if rel not in files and (workspace / rel).is_file():
            files.append(rel)
    return files


def take_checkpoint(
    *,
    workspace_root: str | Path,
    request_id: str,
    reason: str,
    base_dir: str | Path | None = None,
    journal_files: Sequence[str] = (),
    max_file_bytes: int = DEFAULT_MAX_FILE_MB * 1024 * 1024,
    min_interval_seconds: int = MIN_INTERVAL_SECONDS,
) -> Checkpoint | None:
    """Snapshot the workspace for ``request_id``. Returns None when folded into
    the previous checkpoint (taken less than ``min_interval_seconds`` ago)."""
    workspace = Path(workspace_root).resolve()
    if not (workspace / ".git").exists():
        raise GovernanceError("checkpoint_workspace_not_a_repo")
    previous = list_checkpoints(request_id, base_dir=base_dir)
    if previous and min_interval_seconds > 0:
        from datetime import datetime, timezone

        last = previous[-1].recorded_at.replace("Z", "+00:00")
        try:
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(last)).total_seconds()
        except ValueError:
            age = min_interval_seconds + 1
        if age < min_interval_seconds:
            return None
    store = checkpoint_store(workspace)
    _ensure_store(store, workspace)
    files = _tracked_and_journaled_files(store, workspace, journal_files)
    files = [f for f in files if (workspace / f).is_file() and (workspace / f).stat().st_size <= max_file_bytes]
    index_file = store / f"index-{request_id}.tmp"
    env = {"GIT_INDEX_FILE": str(index_file)}
    try:
        if files:
            proc = subprocess.run(
                ["git", "update-index", "--add", "--replace", "-z", "--stdin"],
                cwd=str(workspace), env={**os.environ, "GIT_DIR": str(store), "GIT_WORK_TREE": str(workspace), **env},
                input="\0".join(files) + "\0", capture_output=True, text=True, check=False,
            )
            if proc.returncode != 0:
                raise GovernanceError(f"checkpoint_update_index_failed:{proc.stderr.strip()[:200]}")
        tree = _git(store, workspace, ["write-tree"], env=env)
    finally:
        if index_file.exists():
            index_file.unlink()
    seq = (previous[-1].seq + 1) if previous else 1
    parent = previous[-1].commit if previous else None
    commit_args = ["commit-tree", tree, "-m", f"aria checkpoint {request_id} #{seq}: {reason}"]
    if parent:
        commit_args.extend(["-p", parent])
    commit = _git(store, workspace, commit_args, env={
        "GIT_AUTHOR_NAME": "aria-checkpoint", "GIT_AUTHOR_EMAIL": "aria@localhost",
        "GIT_COMMITTER_NAME": "aria-checkpoint", "GIT_COMMITTER_EMAIL": "aria@localhost",
    })
    ref = f"{CHECKPOINT_REF_PREFIX}/{request_id}/{seq}"
    _git(store, workspace, ["update-ref", ref, commit])
    row = append_declared_jsonl(
        _index_path(base_dir),
        {
            "schema_version": 1, "event": "taken", "recorded_at": utc_now(), "request_id": request_id,
            "seq": seq, "commit": commit, "tree": tree, "ref": ref, "reason": reason[:200],
            "file_count": len(files), "store": str(store),
        },
        expected_surface=CHECKPOINT_INDEX_SURFACE,
    )
    return Checkpoint(request_id, seq, commit, tree, reason, str(row["recorded_at"]), len(files), ref)


def diff_checkpoint(*, workspace_root: str | Path, request_id: str, seq: int, base_dir: str | Path | None = None) -> str:
    """`git diff` between the checkpoint tree and the live workspace (names + status)."""
    workspace = Path(workspace_root).resolve()
    target = _find(request_id, seq, base_dir)
    store = checkpoint_store(workspace)
    return _git(store, workspace, ["diff", "--name-status", target.tree, "--"], check=False)


def _find(request_id: str, seq: int | None, base_dir: str | Path | None) -> Checkpoint:
    checkpoints = list_checkpoints(request_id, base_dir=base_dir)
    if not checkpoints:
        raise GovernanceError(f"checkpoint_none_for_request:{request_id}")
    if seq is None:
        return checkpoints[-1]
    for cp in checkpoints:
        if cp.seq == seq:
            return cp
    raise GovernanceError(f"checkpoint_seq_unknown:{request_id}:{seq}")


def restore_checkpoint(
    *,
    workspace_root: str | Path,
    request_id: str,
    seq: int | None = None,
    files: Sequence[str] | None = None,
    preserve_hand_edits: bool = True,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Put files back as they were at the checkpoint.

    ``preserve_hand_edits`` restricts the restore to files the work journal
    attributes to the agent for this request (plus ``files`` when given);
    ``False`` restores every file the checkpoint holds. Files the checkpoint
    did not hold but the journal created are removed.
    """
    workspace = Path(workspace_root).resolve()
    target = _find(request_id, seq, base_dir)
    store = checkpoint_store(workspace)
    held = set(_git(store, workspace, ["ls-tree", "-r", "--name-only", target.tree]).splitlines())
    if files is not None:
        chosen = [f for f in files]
    elif preserve_hand_edits:
        from .hooks import journal_rows_for

        touched: list[str] = []
        for row in journal_rows_for(request_id, base_dir=base_dir):
            for path in row.get("files_touched") or []:
                try:
                    touched.append(Path(path).resolve().relative_to(workspace).as_posix())
                except ValueError:
                    continue
        chosen = list(dict.fromkeys(touched))
    else:
        chosen = sorted(held)
    restored: list[str] = []
    removed: list[str] = []
    for rel in chosen:
        if rel in held:
            _git(store, workspace, ["checkout", target.commit, "--", rel])
            restored.append(rel)
        else:
            candidate = workspace / rel
            if candidate.is_file():
                candidate.unlink()
                removed.append(rel)
    row = append_declared_jsonl(
        _index_path(base_dir),
        {
            "schema_version": 1, "event": "restored", "recorded_at": utc_now(), "request_id": request_id,
            "seq": target.seq, "commit": target.commit, "restored": restored, "removed": removed,
            "preserve_hand_edits": preserve_hand_edits,
        },
        expected_surface=CHECKPOINT_INDEX_SURFACE,
    )
    return {"request_id": request_id, "seq": target.seq, "restored": restored, "removed": removed, "recorded_at": row["recorded_at"]}


def prune_checkpoints(
    *,
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    max_snapshots: int = DEFAULT_MAX_SNAPSHOTS,
    retention_days: int = DEFAULT_RETENTION_DAYS,
    max_total_mb: int = DEFAULT_MAX_TOTAL_MB,
) -> dict[str, Any]:
    """Drop refs beyond the per-request cap / retention and gc the store."""
    from datetime import datetime, timedelta, timezone

    workspace = Path(workspace_root).resolve()
    store = checkpoint_store(workspace)
    if not (store / "HEAD").exists():
        return {"dropped": [], "store_present": False}
    path = _index_path(base_dir)
    rows = load_declared_jsonl(path, expected_surface=CHECKPOINT_INDEX_SURFACE) if path.exists() else []
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    by_request: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        if row.get("event", "taken") == "taken":
            by_request.setdefault(str(row["request_id"]), []).append(row)
    dropped: list[str] = []
    for request_id, taken in by_request.items():
        taken.sort(key=lambda r: int(r["seq"]))
        for row in taken[:-max_snapshots] if len(taken) > max_snapshots else []:
            dropped.append(str(row["ref"]))
        for row in taken:
            try:
                when = datetime.fromisoformat(str(row["recorded_at"]).replace("Z", "+00:00"))
            except ValueError:
                continue
            if when < cutoff and str(row["ref"]) not in dropped:
                dropped.append(str(row["ref"]))
    for ref in dropped:
        _git(store, workspace, ["update-ref", "-d", ref], check=False)
    _git(store, workspace, ["gc", "--prune=now", "-q"], check=False)
    size_mb = sum(f.stat().st_size for f in store.rglob("*") if f.is_file()) / (1024 * 1024)
    if dropped:
        append_declared_jsonl(
            path, {"schema_version": 1, "event": "pruned", "recorded_at": utc_now(), "request_id": "*",
                   "dropped": dropped, "store_mb": round(size_mb, 2)},
            expected_surface=CHECKPOINT_INDEX_SURFACE,
        )
    return {"dropped": dropped, "store_present": True, "store_mb": round(size_mb, 2),
            "over_budget": size_mb > max_total_mb}


__all__ = [
    "CHECKPOINT_INDEX_RELPATH", "CHECKPOINT_INDEX_SURFACE", "CHECKPOINT_REF_PREFIX", "Checkpoint",
    "checkpoint_store", "diff_checkpoint", "list_checkpoints", "prune_checkpoints",
    "restore_checkpoint", "take_checkpoint",
]
