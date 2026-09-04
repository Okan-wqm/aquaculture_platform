"""Plan 032 Faz 032c — the search index is derived, rebuildable and outside the store.

Invariants:
  I-V12-SEARCH-01  the index lives under the ARIA workspace root (never in the
                   tools store, never published) and rebuild is idempotent.
  I-V12-SEARCH-02  hits point back at ledger rows (kind, ref, ledger_hash) and
                   a query over the journal/requests finds what was written.
  I-V12-SEARCH-03  an unknown kind or a malformed FTS query is a ValueError,
                   never a silent empty result.

NOT RUN at authoring time (operator instruction 2026-09-03).
"""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.invariants.v12 import _helpers  # noqa: F401 — sys.path

from aria_kernel import hooks, search
from aria_kernel.agent_invocations import create_agent_invocation_request
from aria_kernel.tool_registry import ensure_tools_dir


class DerivedIndex(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name).resolve()
        self.ws = root / "repo"
        self.ws.mkdir()
        os.system(f"git -C {self.ws} init -q")
        self.tools = root / "aria-tools"
        ensure_tools_dir(self.tools)
        self._env = mock.patch.dict(os.environ, {"ARIA_WORKSPACE_BASE": str(root / "aria-ws")})
        self._env.start()

    def tearDown(self) -> None:
        self._env.stop()
        self._tmp.cleanup()

    def test_I_V12_SEARCH_01_location_and_idempotent_rebuild(self) -> None:
        path = search.index_path(self.ws)
        self.assertNotIn(str(self.tools), str(path))
        self.assertIn("aria-ws", str(path))
        first = search.rebuild_index(workspace_root=self.ws, base_dir=self.tools)
        second = search.rebuild_index(workspace_root=self.ws, base_dir=self.tools)
        self.assertEqual(first, second)
        self.assertTrue(path.exists())

    def test_I_V12_SEARCH_02_hits_point_at_ledger_rows(self) -> None:
        req = create_agent_invocation_request(
            target_agent="aria-challenger-planner", role="challenger_plan",
            suggested_prompt="challenge the tenant isolation plan for farm-service",
            must_satisfy=[{"id": "x", "criterion": "y"}], allowed_scope=["apps/**"], convergence_id="conv-9",
            base_dir=self.tools,
        )
        hooks.record_journal({"tool_name": "Bash", "tool_input": {"command": "pytest apps/farm-service"}},
                             base_dir=self.tools, request_id=req["request_id"], session_id="s", tool_use_id="t")
        counts = search.rebuild_index(workspace_root=self.ws, base_dir=self.tools)
        self.assertGreaterEqual(counts["requests"], 1)
        self.assertGreaterEqual(counts["journal"], 1)
        hits = search.search("tenant isolation", workspace_root=self.ws, kinds=["requests"])
        self.assertEqual(hits[0].kind, "requests")
        self.assertEqual(hits[0].ref, req["request_id"])
        self.assertTrue(hits[0].ledger_hash.startswith("sha256:"))
        journal_hits = search.search("pytest", workspace_root=self.ws, kinds=["journal"])
        self.assertEqual(journal_hits[0].ref, req["request_id"])

    def test_I_V12_SEARCH_03_bad_kind_or_query_is_an_error(self) -> None:
        search.rebuild_index(workspace_root=self.ws, base_dir=self.tools)
        with self.assertRaises(ValueError):
            search.search("x", workspace_root=self.ws, kinds=["diary"])
        with self.assertRaises(ValueError):
            search.search('"unterminated', workspace_root=self.ws)


if __name__ == "__main__":
    unittest.main()
