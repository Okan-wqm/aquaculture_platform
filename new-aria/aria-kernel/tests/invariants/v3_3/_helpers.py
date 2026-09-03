"""Plan ARIA-V3.3 shared test helpers.

Hermetic fixtures for the V3.3 invariant suite. The helpers route
through the kernel's own writer surfaces so the ledger integrity hash
chain stays valid — hand-crafted JSON would silently break the
integrity-index group invariant.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))


def seed_initialized_tools_root(
    workspace: Path,
    *,
    bound_repo_root: str | None = None,
    bound_repo_hash: str | None = None,
) -> Path:
    """Plan ARIA-V3.3 §2a — seed a minimum-viable initialized aria-tools.

    The walk-up resolver looks for ``<ancestor>/aria-tools/
    repo_identity.json``. This helper writes exactly that file so the
    walk-up succeeds without going through ``ensure_tools_dir`` (which
    would write a governance event we don't want polluting the test
    ledger). Returns the absolute aria-tools path.
    """
    aria_tools = (workspace / "aria-tools").resolve()
    aria_tools.mkdir(parents=True, exist_ok=True)
    identity = {
        "aria_tools_contract_version": 3,
        "bound_repo_hash": bound_repo_hash,
        "bound_canonical_identity": bound_repo_hash,
        "bound_repo_root": bound_repo_root or str(workspace),
        "schema_version": 3,
    }
    (aria_tools / "repo_identity.json").write_text(
        json.dumps(identity, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return aria_tools


def clear_aria_tools_env() -> dict[str, str]:
    """Plan ARIA-V3.3 §2a / R-A4 — clear ARIA_TOOLS_DIR + return the
    pre-clear snapshot for tearDown restore.

    Why: tests inherit operator env when run locally. A stale
    ARIA_TOOLS_DIR pointing at the operator's aria-tools would mask the
    walk-up behavior the V3.3 invariants pin. Tests call this in
    setUp; the returned dict is used in tearDown to restore.
    """
    snapshot: dict[str, str] = {}
    if "ARIA_TOOLS_DIR" in os.environ:
        snapshot["ARIA_TOOLS_DIR"] = os.environ.pop("ARIA_TOOLS_DIR")
    return snapshot


def restore_aria_tools_env(snapshot: dict[str, str]) -> None:
    """Restore env snapshot saved by ``clear_aria_tools_env``."""
    for key, value in snapshot.items():
        os.environ[key] = value


def detached_tmp_dir(prefix: str) -> Path:
    """Create a tmp dir with NO ``aria-tools`` ancestor.

    Returns a path under ``/tmp/<prefix>-<rand>`` so walk-up will
    terminate at filesystem root without finding any initialized
    aria-tools — the "detached cwd" scenario for I-V3.3-03.
    """
    import tempfile
    return Path(tempfile.mkdtemp(prefix=prefix))
