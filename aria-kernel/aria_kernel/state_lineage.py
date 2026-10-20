"""The pinned lineage of the state branch (ARIA-LOW-578).

WHY: a lane trusted whatever history the remote handed it. The checkout's
only lineage check compared the fetched tip with the HOST's own tracking ref
(``refs/remotes/origin/aria/state``), so a host that had none — every
GitHub-hosted runner, a fresh clone, ``aria-state-maintenance`` — adopted any
replacement tip, a brand-new root included: the ARIA-HIGH-572 purge
investigation measured a new-root tip adopted with exit 0. The only thing
standing between a replaced lineage and every fresh host was the remote's
push ruleset, which the store cannot see from where it reads.

WHAT: the lineage is pinned where the lane reads it — in the repository the
lane checks out, as committed policy data (``docs/aria/policy/``,
CODEOWNERS-protected, outside every ARIA write scope). The policy names, per
state branch, the ONE root commit its history must have. Every checkout of
an existing branch proves it against the fetched tip, whether or not the
host tracks the branch:

* the policy is missing, or names no root for the branch — refused, naming
  the root the remote's history actually has, so the operator can pin it
  after a genuine bootstrap;
* the tip's history has another root, or more than one — refused;
* the history the host holds is cut short (a shallow or grafted boundary
  that only LOOKS like a root) — refused: the pin cannot be proven, and an
  unprovable pin never passes;
* the branch is absent but pinned — the bootstrap is refused even with an
  acknowledgement: a pinned lineage's branch is gone, and a fresh genesis
  would replace it (the ORPHAN-CRITICAL-484 shape, now on every host).

Every later adoption of a remote tip (ambiguous-push reconciliation,
contention replay, accepted-loser recovery) fetches it through
``state_store._fetch_remote_branch_tip``, which proves the same pin. Descent
from the checked-out tip is not enough on its own: an intermediate merge
brings a second root into a history that still descends from it, and the
snapshot verifier reads only the tip's own parent (measured: both paths
adopted such a tip before they proved the pin).

A governed epoch reset or purge changes the pin in the same reviewed PR that
lifts the ruleset; nothing on a host can.
"""
from __future__ import annotations

import errno
import json
import os
import stat
from pathlib import Path
from typing import Any

from . import state_store as _store
from .git_object_id import ANY_OBJECT_FORMAT, is_object_id

STATE_LINEAGE_POLICY_PATH = "docs/aria/policy/state-lineage.json"
STATE_LINEAGE_SCHEMA = "aria/state-lineage/v1"
STATE_LINEAGE_POLICY_ID = "aria-state-lineage"

LINEAGE_POLICY_MISSING = "state_store_lineage_policy_missing"
LINEAGE_POLICY_MALFORMED = "state_store_lineage_policy_malformed"
LINEAGE_UNPINNED = "state_store_lineage_unpinned"
LINEAGE_ROOT_MISMATCH = "state_store_lineage_root_mismatch"
LINEAGE_HISTORY_TRUNCATED = "state_store_lineage_history_truncated"
LINEAGE_UNAVAILABLE = "state_store_lineage_unavailable"
LINEAGE_PINNED_BRANCH_ABSENT = "state_store_lineage_pinned_branch_absent"

_POLICY_KEYS = frozenset({"$schema", "$comment", "schema_version", "policy_id", "lineages"})
_REQUIRED_POLICY_KEYS = _POLICY_KEYS - {"$comment"}
_LINEAGE_KEYS = frozenset({"branch", "root"})
_MAX_POLICY_BYTES = 64 * 1024
# Two is enough to tell "exactly one root" from "more than one" without
# letting a history with thousands of roots size the output.
_ROOT_PROBE_LIMIT = 2
# Replacement objects (`git replace --graft`) can make a new root look like a
# descendant of the pinned one; the proof reads the objects as they are.
_NO_REPLACE = ("-c", "core.useReplaceRefs=false")


def _malformed(detail: str) -> _store.StateStoreRefusal:
    return _store.StateStoreRefusal(
        f"{LINEAGE_POLICY_MALFORMED}: {STATE_LINEAGE_POLICY_PATH}: {detail}"
    )


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _malformed(f"duplicate key {key!r}")
        result[key] = value
    return result


def _read_policy_bytes(path: Path) -> bytes | None:
    """The policy file's bytes; ``None`` when there is no file at all."""
    try:
        descriptor = os.open(
            path, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NONBLOCK", 0),
        )
    except FileNotFoundError:
        return None
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            raise _malformed("is a symbolic link") from exc
        raise _store.StateStoreError(
            f"{LINEAGE_UNAVAILABLE}: {STATE_LINEAGE_POLICY_PATH} could not be read ({exc})"
        ) from exc
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise _malformed("is not a regular file")
        content = bytearray()
        while len(content) <= _MAX_POLICY_BYTES:
            chunk = os.read(descriptor, _MAX_POLICY_BYTES + 1 - len(content))
            if not chunk:
                break
            content.extend(chunk)
    finally:
        os.close(descriptor)
    if len(content) > _MAX_POLICY_BYTES:
        raise _malformed(f"is larger than {_MAX_POLICY_BYTES} bytes")
    return bytes(content)


def read_lineage_pins(repo_root: str | Path) -> dict[str, str] | None:
    """Branch -> pinned root commit; ``None`` when the repository has no policy.

    Strict: unknown keys, a duplicate key or branch, a root that is not a
    full object id — each refuses, because a pin read loosely is a pin an
    edit can quietly widen.
    """
    content = _read_policy_bytes(Path(repo_root) / STATE_LINEAGE_POLICY_PATH)
    if content is None:
        return None
    try:
        policy = json.loads(content.decode("utf-8"), object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, ValueError) as exc:
        raise _malformed(f"is not JSON ({exc})") from exc
    if not isinstance(policy, dict):
        raise _malformed("is not a JSON object")
    keys = set(policy)
    if not _REQUIRED_POLICY_KEYS <= keys or not keys <= _POLICY_KEYS:
        raise _malformed(f"keys {sorted(keys)} are not {sorted(_POLICY_KEYS)}")
    version = policy["schema_version"]
    if policy["$schema"] != STATE_LINEAGE_SCHEMA or isinstance(version, bool) or version != 1:
        raise _malformed(f"schema is not {STATE_LINEAGE_SCHEMA} version 1")
    if policy["policy_id"] != STATE_LINEAGE_POLICY_ID:
        raise _malformed(f"policy_id is not {STATE_LINEAGE_POLICY_ID!r}")
    lineages = policy["lineages"]
    if not isinstance(lineages, list):
        raise _malformed("lineages is not a list")
    pins: dict[str, str] = {}
    for entry in lineages:
        if not isinstance(entry, dict) or set(entry) != _LINEAGE_KEYS:
            raise _malformed(f"a lineage entry is not exactly {sorted(_LINEAGE_KEYS)}")
        branch, root = entry["branch"], entry["root"]
        if not isinstance(branch, str) or not branch:
            raise _malformed("a lineage branch is not a non-empty string")
        if not is_object_id(root, formats=ANY_OBJECT_FORMAT) or set(root) == {"0"}:
            raise _malformed(f"the root pinned for {branch!r} is not a full commit id")
        if branch in pins:
            raise _malformed(f"branch {branch!r} is pinned twice")
        pins[branch] = root
    return pins


def _observed_roots(cwd: Path, tip: str) -> tuple[str, ...]:
    proc = _store._run_git(
        cwd,
        (*_NO_REPLACE, "rev-list", "--max-parents=0", f"--max-count={_ROOT_PROBE_LIMIT}", tip),
    )
    roots = tuple(line for line in proc.stdout.split("\n") if line)
    if proc.returncode != 0 or not roots or not all(_store._full_git_sha(r) for r in roots):
        raise _store.StateStoreError(
            f"{LINEAGE_UNAVAILABLE}: the history of {tip} could not be walked "
            f"({proc.stderr.strip()[:300]})"
        )
    return roots


def _records_a_parent(cwd: Path, commit: str) -> bool:
    """Does the commit OBJECT name a parent the walk did not follow?

    A shallow boundary (or a graft) is reported by ``rev-list`` as a root;
    the object itself still carries its ``parent`` lines. That is the
    difference between a root and a history cut short.
    """
    proc = _store._run_git(cwd, (*_NO_REPLACE, "cat-file", "commit", commit))
    if proc.returncode != 0:
        raise _store.StateStoreError(
            f"{LINEAGE_UNAVAILABLE}: commit {commit} could not be read "
            f"({proc.stderr.strip()[:300]})"
        )
    header = proc.stdout.split("\n\n", 1)[0]
    return any(line.startswith("parent ") for line in header.split("\n"))


def require_pinned_lineage(repo_root: str | Path, *, branch: str, tip: str) -> str:
    """Prove ``tip``'s history has exactly the root the policy pins; return it.

    Runs against the objects ``repo_root`` holds, so it must run after the
    fetch that brought ``tip`` in and before anything adopts it.
    """
    root_dir = Path(repo_root)
    pins = read_lineage_pins(root_dir)
    observed = _observed_roots(root_dir, tip)
    truncated = [root for root in observed if _records_a_parent(root_dir, root)]
    if truncated:
        raise _store.StateStoreRefusal(
            f"{LINEAGE_HISTORY_TRUNCATED}: the history of {branch!r} held here ends at "
            f"{truncated[0]}, a commit that names a parent this host does not have "
            "(a shallow or grafted fetch); its root cannot be proven, so it is not adopted"
        )
    observed_text = ", ".join(observed) + (
        " (two or more roots)" if len(observed) >= _ROOT_PROBE_LIMIT else ""
    )
    if pins is None:
        raise _store.StateStoreRefusal(
            f"{LINEAGE_POLICY_MISSING}: {STATE_LINEAGE_POLICY_PATH} does not exist, so no "
            f"lineage of {branch!r} can be trusted; its remote history roots at "
            f"{observed_text}. Pin the root after verifying it (docs/runbooks/aria-state-branch-bootstrap.md)"
        )
    pinned = pins.get(branch)
    if pinned is None:
        raise _store.StateStoreRefusal(
            f"{LINEAGE_UNPINNED}: {STATE_LINEAGE_POLICY_PATH} pins no root for {branch!r}; "
            f"its remote history roots at {observed_text}. Pin the root after verifying "
            "it (docs/runbooks/aria-state-branch-bootstrap.md)"
        )
    if observed != (pinned,):
        raise _store.StateStoreRefusal(
            f"{LINEAGE_ROOT_MISMATCH}: the remote history of {branch!r} roots at "
            f"{observed_text}, not at the pinned {pinned}; a replaced lineage is never adopted"
        )
    return pinned


def refuse_bootstrap_over_pinned_lineage(repo_root: str | Path, *, branch: str) -> None:
    """A branch the policy pins is never re-created: its absence is a loss, not a start."""
    pins = read_lineage_pins(Path(repo_root))
    if pins is not None and branch in pins:
        raise _store.StateStoreRefusal(
            f"{LINEAGE_PINNED_BRANCH_ABSENT}: {branch!r} is pinned to root {pins[branch]} "
            f"in {STATE_LINEAGE_POLICY_PATH} but does not exist on the remote; a new "
            "genesis would replace that lineage. Recover the branch; a governed reset "
            "changes the pin first (docs/runbooks/aria-state-branch-bootstrap.md)"
        )


__all__ = [
    "LINEAGE_HISTORY_TRUNCATED",
    "LINEAGE_PINNED_BRANCH_ABSENT",
    "LINEAGE_POLICY_MALFORMED",
    "LINEAGE_POLICY_MISSING",
    "LINEAGE_ROOT_MISMATCH",
    "LINEAGE_UNAVAILABLE",
    "LINEAGE_UNPINNED",
    "STATE_LINEAGE_POLICY_ID",
    "STATE_LINEAGE_POLICY_PATH",
    "STATE_LINEAGE_SCHEMA",
    "read_lineage_pins",
    "refuse_bootstrap_over_pinned_lineage",
    "require_pinned_lineage",
]
