"""ARIA-HIGH-426 — the kernel never writes into a tree another account owns.

WHY. Every self-hosted ARIA lane starts by resetting one persistent workspace
(``git reset --hard; git clean -ffdx -e node_modules`` in
``aria-auto-cycle.yml`` and ``aria-agent-executor.yml``). On 2026-10-08 a
rescue publish ran the kernel AS ROOT in that workspace and left about 3,000
root-owned files under ``.aria-state-store`` and ``__pycache__``. ``git
clean``, running as the runner account, cannot remove an entry of a
root-owned directory, so every cycle and executor job failed at that first
step from 19:24Z until an operator chowned the tree 11 hours later. A
root-run state command does lasting harm even without the reset: the store's
lifecycle lock (``<git-common-dir>/aria-state-lifecycle``) is created 0644
and never unlinked (``file_lock.with_exclusive_lock``), so the runner could
no longer open it for any later checkout or publish.

WHAT. One rule, asked where a write root is resolved:

* the tools root, in ``tool_registry.tools_dir`` (``--tools-dir``,
  ``ARIA_TOOLS_DIR`` or the walk-up), before ``ensure_tools_dir`` creates it;
* the state store's repository, in ``state_store._state_store_lifecycle_lock``,
  before its lock file and before any git write of a checkout or publish.

A root whose nearest existing ancestor is owned by neither this process's
euid nor root is refused with ``GovernanceError`` naming the owner and the
remedy. A root-owned tree is left to the OS: root can always clean it, and a
non-root writer is either refused by its permissions or writes where root can
remove it (``/tmp``). There is no override. An operator runs kernel commands
on another account's tree as that account (``sudo -u <owner>``), or binds a
store of their own.

NOT COVERED. CPython writes ``aria_kernel/__init__``'s ``.pyc`` before any
kernel code runs, so a root python that imports the runner's checkout still
leaves a root-owned ``__pycache__``. The lanes' reset step names every
foreign-owned path instead of failing anonymously (tier 3, same finding).
"""
from __future__ import annotations

import os
import pwd
from pathlib import Path

FOREIGN_OWNER_TOKEN = "write_root_foreign_owner"

# (root, euid) pairs already judged writable. Ownership of a root does not
# change under a running process (a change is an operator's chown that fixes
# exactly this), and ``tools_dir`` is resolved on every ledger access.
_VERIFIED: set[tuple[str, int]] = set()


def _effective_uid() -> int:
    """This process's euid: one seam, so a test can be root without being root."""
    return os.geteuid()


def _account(uid: int) -> str:
    try:
        return pwd.getpwuid(uid).pw_name
    except KeyError:
        return str(uid)


def _nearest_existing(path: Path) -> tuple[Path, int] | None:
    """The first existing directory on ``path``'s ancestor chain and its owner uid.

    ``None`` when the OS refuses this account the walk: nothing it writes can
    land there, so there is nothing for this rule to add.
    """
    candidate = path
    while True:
        try:
            return candidate, os.stat(candidate).st_uid
        except (FileNotFoundError, NotADirectoryError):
            if candidate.parent == candidate:
                return None
            candidate = candidate.parent
        except PermissionError:
            return None


def refuse_foreign_owned_root(path: str | os.PathLike[str], *, role: str) -> None:
    """Raise unless this process may write ``path`` without leaving files its owner cannot remove."""
    root = Path(path).resolve()
    euid = _effective_uid()
    key = (root.as_posix(), euid)
    if key in _VERIFIED:
        return
    found = _nearest_existing(root)
    if found is not None:
        anchor, owner_uid = found
        if owner_uid not in (euid, 0):
            from .tool_registry import GovernanceError

            owner, me = _account(owner_uid), _account(euid)
            raise GovernanceError(
                f"{FOREIGN_OWNER_TOKEN}: the {role} {root.as_posix()} is in a tree owned by {owner} "
                f"({anchor.as_posix()}, uid {owner_uid}), and this process runs as {me} (uid {euid}). "
                f"Files it wrote there would belong to {me}, and {owner}'s own lanes could not remove "
                f"them: the runner's workspace reset fails on them (ARIA-HIGH-426). Run the command as "
                f"{owner} (sudo -u {owner} ...), or bind a store of your own."
            )
    _VERIFIED.add(key)


__all__ = ["FOREIGN_OWNER_TOKEN", "refuse_foreign_owned_root"]
