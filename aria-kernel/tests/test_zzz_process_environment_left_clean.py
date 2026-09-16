"""ARIA-HIGH-065 — the LAST top-level module: did the suite leave its process clean?

Discovery runs ``tests/test_*.py`` in name order, so this module runs after
every other top-level test module (the ``invariants`` package sorts before
them). It asserts the process-wide state the bootstrap (``tests/__init__``)
established is still in place: a test that mutated ``os.environ`` and did not
restore it is invisible in its own module and only shows up as a different
module's failure hundreds of tests later — ``test_migrate_tools_v3``'s
tearDown popped ``ARIA_WORKSPACE_BASE`` and every fixture after it wrote its
workspace under the operator's home (4,927 directories by 2026-09-11), and the
first full run after the bootstrap gained its default failed
``test_suite_env_hermeticity`` for exactly that reason.

This cannot name the culprit — unittest offers no per-test hook without a
custom runner — so the message says how to find it: bisect by module order
with ``python3 -m unittest tests.<module> tests.test_zzz_process_environment_left_clean``.
Scope environment edits to the test (``patch.dict(os.environ)`` +
``addCleanup``) rather than popping in tearDown.
"""
from __future__ import annotations

import os
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_BISECT = (
    " — a module that ran before this one mutated the process environment and did not "
    "restore it; bisect by module order: python3 -m unittest tests.<module> "
    "tests.test_zzz_process_environment_left_clean"
)


class ProcessEnvironmentLeftClean(unittest.TestCase):
    def test_the_workspace_base_is_still_the_suite_owned_temp_dir(self) -> None:
        base = os.environ.get("ARIA_WORKSPACE_BASE")
        self.assertTrue(base, "ARIA_WORKSPACE_BASE is unset" + _BISECT)
        self.assertFalse(
            Path(base).resolve().is_relative_to((Path.home() / ".aria").resolve()),
            f"ARIA_WORKSPACE_BASE={base} points into the operator's home" + _BISECT,
        )

    def test_no_shared_repo_state_root_was_left_bound(self) -> None:
        self.assertIsNone(
            os.environ.get("ARIA_REPO_STATE_ROOT"),
            "ARIA_REPO_STATE_ROOT is bound; fixtures after the leak shared one finding history" + _BISECT,
        )

    def test_the_tools_dir_is_still_a_fixture_store(self) -> None:
        tools = os.environ.get("ARIA_TOOLS_DIR")
        self.assertTrue(tools, "ARIA_TOOLS_DIR is unset" + _BISECT)
        self.assertNotEqual(
            Path(tools).resolve(), (_REPO_ROOT / "aria-tools").resolve(),
            "ARIA_TOOLS_DIR points at the repository's real mirror (ORPHAN-MEDIUM-767)" + _BISECT,
        )

    def test_no_run_scoped_variable_outlived_its_run(self) -> None:
        for name in ("ARIA_JOB_DEADLINE_EPOCH", "MAX_BUDGET_USD_PER_RUN", "MAX_BUDGET_USD_PER_CYCLE"):
            with self.subTest(variable=name):
                self.assertIsNone(
                    os.environ.get(name),
                    f"{name} is set; a run-scoped variable leaked (ARIA-HIGH-064)" + _BISECT,
                )


if __name__ == "__main__":
    unittest.main()
