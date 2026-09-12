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

ARIA-HIGH-065 — importing this package also unbinds an inherited
ARIA_REPO_STATE_ROOT and defaults ARIA_WORKSPACE_BASE. The state root
redirects aria-findings/ and aria-debts/ for EVERY fixture repository into
ONE directory, so a finding one test emits becomes history the next test
replays: on 2026-09-11 a publication push that exported a fixed root for the
pre-push gate produced 41 errors of the shape "finding event ... references
'F-901' before its finding_emitted row" on code that was green in CI, and the
symptom was then patched in two fixtures out of the hundreds that emit
findings. With the variable unset each fixture's repo root IS its state root
(workspace.repo_state_root), which is the only configuration under which
fixtures cannot see each other; a fixture that needs the redirect binds it
itself, scoped to its own lifetime (test_experiment_night). Unbinding rather
than refusing, because the inherited value is not always aimed at the suite:
the restore-aria-state action exports the durable store's binding into the
whole job, and an operator's shell or a git hook that runs this suite carries
it the same way — refusing would fail every such run, and honouring it would
write fixture findings INTO the durable store. (An in-cycle self-validation
no longer hands it down at all: ``validation_env`` builds the child's
environment and withholds every store binding, ARIA-MEDIUM-066; this
unbinding is the suite's own guard for the routes that do not go through the
validation lane.) Not silently: one stderr line names the value that was
unbound and why.
The workspace base is the same ORPHAN-MEDIUM-767 class one level up: with it
unset, workspace_paths falls back to ~/.aria/workspaces/<repo-hash>, and 4,927
such directories — every one recording a /tmp fixture as its repo_root — had
accumulated under the operator's home by 2026-09-11.
"""

import os
import sys
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

REPO_STATE_ROOT_ENV = "ARIA_REPO_STATE_ROOT"
WORKSPACE_BASE_ENV = "ARIA_WORKSPACE_BASE"

_state_root_env = os.environ.pop(REPO_STATE_ROOT_ENV, None)
if _state_root_env:
    sys.stderr.write(
        f"tests: {REPO_STATE_ROOT_ENV}={_state_root_env} was inherited and has been "
        "unbound for the kernel test suite. A shared state root replays one "
        "fixture's findings as the next fixture's history (F-901 'references ... "
        "before its finding_emitted row'; 41 false errors on 2026-09-11, "
        "ARIA-HIGH-065). Each fixture's repo root is its own state root.\n"
    )
if not os.environ.get(WORKSPACE_BASE_ENV):
    os.environ[WORKSPACE_BASE_ENV] = tempfile.mkdtemp(prefix="aria-test-workspaces-")
