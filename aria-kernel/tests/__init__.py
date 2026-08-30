"""Tests for the ARIA governance kernel.

Importing this package installs the hermetic git environment before any
test module runs, so no fixture repository — factory-built or created
inline with a bare ``git init`` — can inherit the machine's global git
configuration. See ``tests/_helpers/hermetic_git.py`` for why.

ORPHAN-MEDIUM-767 — importing this package also isolates the tools dir.
The resolver (tool_registry.tools_dir) falls back to walking up from cwd
to the repo's REAL aria-tools/ when neither an explicit path nor
ARIA_TOOLS_DIR is set, so a test that forgets its fixture base_dir reads
and writes the operator's local state mirror — gitignored, invisible to
git status, and the exact surface whose writer could not be attributed on
2026-08-20. With no env set, the suite now resolves to a session temp dir
by default (Tier 2: isolation is the zero-effort default); a run that
DELIBERATELY targets the real mirror sets ARIA_TEST_ALLOW_REAL_TOOLS_DIR=1
and says why next to that line.
"""

import os
import tempfile
from pathlib import Path

from tests._helpers.hermetic_git import apply_hermetic_git_env

apply_hermetic_git_env()

_REPO_ROOT = Path(__file__).resolve().parents[2]
_REAL_TOOLS_DIR = (_REPO_ROOT / "aria-tools").resolve()
_ALLOW_REAL = os.environ.get("ARIA_TEST_ALLOW_REAL_TOOLS_DIR") == "1"

_tools_env = os.environ.get("ARIA_TOOLS_DIR")
if _tools_env:
    _effective = Path(_tools_env).resolve()
    if _effective == _REAL_TOOLS_DIR and not _ALLOW_REAL:
        raise RuntimeError(
            "ARIA_TOOLS_DIR points at the repository's real aria-tools/ mirror — "
            "the kernel test suite must not read or write operator state "
            "(ORPHAN-MEDIUM-767). Point it at a fixture store (the CI lanes use "
            "the restore action's store), or set ARIA_TEST_ALLOW_REAL_TOOLS_DIR=1 "
            "with a comment saying why this run needs the real mirror."
        )
else:
    os.environ["ARIA_TOOLS_DIR"] = tempfile.mkdtemp(prefix="aria-test-tools-")
