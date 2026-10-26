"""WP-D3 — an agent-backed tool is a kind of registry row, not a subprocess with a missing argv.

``change-review`` is the first tool whose run is an agent's accepted answer
(``tool_registry.AGENT_RUNNER_TYPE``), recorded by the supporting bridge. What the
registry gate, the dispatcher, the fixture door and the learning-funnel reader do with
such a row is pinned here, beside the pins of the bridge itself
(``test_change_review_defect_claims_bridge``):

  * the gate: a runner of this kind declares nothing a process would need, and a tool
    that owns one owns no fixture suite; every other tool still owns one. Its rules are
    a closed set (no ``*``): the agent names the rule in each claim;
  * the dispatcher: the row is not dispatchable, and the subprocess runner refuses it;
  * the fixture door asks no case of it (its evidence is checked per answer, at the
    answer's commit), and the learning-funnel reader reads no fixture verdict for it.
"""
from __future__ import annotations

import copy
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.adapter_fixture_contract import assert_fixture_backed
from aria_kernel.feedback_store import append_jsonl, promotions_path
from aria_kernel.funnel_health import load_learning_funnel_inputs
from aria_kernel.tool_registry import (
    AGENT_RUNNER_TYPE,
    GovernanceError,
    ensure_tools_binding,
    get_tool,
    is_agent_backed,
    is_dispatchable,
    register_tool,
    validate_runner_definition,
    validate_tool_definition,
)
from aria_kernel.tool_runner import run_tool
from tests._helpers.git_fixtures import make_local_git_repo

REPO_ROOT = Path(__file__).resolve().parents[2]
ADAPTERS = REPO_ROOT / "tools" / "aria-adapters"


def _manifest(name: str) -> dict:
    return json.loads((ADAPTERS / f"{name}.tool.json").read_text(encoding="utf-8"))


class TheGate(unittest.TestCase):
    def test_the_agent_runner_declares_nothing_a_process_would_need(self) -> None:
        self.assertEqual(validate_runner_definition({"type": AGENT_RUNNER_TYPE}), {"type": AGENT_RUNNER_TYPE})
        for extra in ({"argv": ["python3", "x.py"]}, {"cwd": "."}, {"timeout_ms": 1000}, {"role": "change_intelligence"}):
            with self.subTest(extra=extra), self.assertRaises(GovernanceError):
                validate_runner_definition({"type": AGENT_RUNNER_TYPE, **extra})
        with self.assertRaises(GovernanceError):
            validate_runner_definition({"type": "carrier-pigeon"})

    def test_an_agent_backed_tool_owns_no_fixture_suite_and_every_other_tool_does(self) -> None:
        agent_backed = validate_tool_definition(_manifest("change-review"))
        self.assertNotIn("fixture_set", agent_backed)
        self.assertTrue(is_agent_backed(agent_backed))
        subprocess_tool = _manifest("banned-phrase-adapter")
        del subprocess_tool["fixture_set"]
        with self.assertRaises(GovernanceError) as refused:
            validate_tool_definition(subprocess_tool)
        self.assertIn("fixture_set", str(refused.exception))
        subprocess_tool["fixture_set"] = ""
        with self.assertRaises(GovernanceError):
            validate_tool_definition(subprocess_tool)

    def test_the_claim_families_of_an_agent_backed_tool_are_closed(self) -> None:
        manifest = copy.deepcopy(_manifest("change-review"))
        manifest["rules"]["*"] = copy.deepcopy(manifest["rules"]["wrong_logic"])
        with self.assertRaises(GovernanceError) as refused:
            validate_tool_definition(manifest)
        self.assertIn("never '*'", str(refused.exception))


class TheDispatcherAndTheFixtureDoor(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-d3-kind-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.repo = make_local_git_repo(self.tmp, name="repo")
        self.tools = ensure_tools_binding(self.tmp / "store" / "aria-tools", workspace_root=self.repo)

    def test_an_agent_backed_row_is_not_dispatchable_and_a_subprocess_row_is(self) -> None:
        register_tool(_manifest("change-review"), base_dir=self.tools)
        register_tool(_manifest("banned-phrase-adapter"), base_dir=self.tools)

        self.assertFalse(is_dispatchable(get_tool("change-review", self.tools)))
        self.assertTrue(is_dispatchable(get_tool("banned-phrase-adapter", self.tools)))

    def test_the_subprocess_runner_refuses_an_agent_backed_row(self) -> None:
        register_tool(_manifest("change-review"), base_dir=self.tools)

        with self.assertRaises(GovernanceError) as refused:
            run_tool("change-review", {}, "cyc-d3-kind", workspace_root=self.repo, base_dir=self.tools)

        self.assertIn("unsupported runner type", str(refused.exception))

    def test_the_fixture_door_asks_no_case_of_an_agent_backed_manifest(self) -> None:
        self.assertEqual(assert_fixture_backed(_manifest("change-review"), self.repo), [])
        unbacked = _manifest("banned-phrase-adapter")
        with self.assertRaises(GovernanceError):
            assert_fixture_backed(unbacked, self.repo)

    def test_the_learning_funnel_reads_no_fixture_verdict_for_a_promoted_agent_backed_tool(self) -> None:
        register_tool(_manifest("change-review"), base_dir=self.tools)
        append_jsonl(promotions_path(self.tools), {"tool_id": "change-review", "finding_fingerprint": "finding:abc"})

        inputs = load_learning_funnel_inputs(self.tools)

        self.assertEqual(dict(inputs.fixture_status), {})
        self.assertEqual(dict(inputs.fixture_runs), {})
        self.assertIn("change-review", inputs.tools)


if __name__ == "__main__":
    unittest.main()
