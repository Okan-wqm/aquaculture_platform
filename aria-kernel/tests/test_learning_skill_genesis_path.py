"""Plan 026R §E.9 — learning router surfaces skill_gap to skill_genesis.

Plan 026R §H.1 — behavioral conversion. Pre-§H.1 these tests were
source-marker substring assertions on learning.py source; the
converted form exercises ``_skill_or_agent_genesis`` with mocked
dependencies and asserts the correct downstream function is called +
the correct governance event kind is emitted.

5 tests (1:1 conversion, plus H-3):

* gap_type="skill_gap" routes to request_skill_genesis (NOT
  request_agent_genesis); governance kind = skill_genesis_request_emitted.
* gap_type="unobserved_surface" (H-3) takes the same adapter-authoring
  surface: blindness needs a parser, not a reviewer.
* gap_type="capability_gap" (default fallthrough) routes to
  request_agent_genesis; governance kind = genesis_request_emitted.
* gap_type="existing_agent_extension" routes to
  record_extension_decision; governance kind = genesis_extension_recorded.
* Multiple gaps with mixed types route correctly per-gap.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.ledger import load_jsonl
from aria_kernel.learning import _skill_or_agent_genesis
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import ensure_tools_dir
from aria_kernel.workspace import WorkspacePaths


def _gap(*, gap_id: str, gap_type: str, capability_gap_key: str) -> dict:
    return {
        "schema_version": 1,
        "gap_id": gap_id,
        "gap_type": gap_type,
        "capability_gap_key": capability_gap_key,
        "title": f"title-{gap_id}",
        "summary": f"summary-{gap_id}",
    }


def _governance_kinds(base_dir: Path) -> list[str]:
    rows = load_jsonl(base_dir / "governance.jsonl")
    return [str(row.get("kind") or "") for row in rows]


def _stub_paths(repo_root: Path) -> WorkspacePaths:
    return WorkspacePaths(
        repo_root=repo_root,
        workspace_root=repo_root,
        memory_dir=repo_root / "aria-memory",
        state_dir=repo_root / "aria-state",
        cycle_dir=repo_root / "aria-state" / "cycles",
        feedback_index=repo_root / "aria-state" / "integrity_index.json",
        identity_file=repo_root / "aria-state" / "identity.json",
        lock_file=repo_root / "aria-state" / "lock",
        ledgers={},
    )


class LearningSkillGenesisPathTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-h1-e9-"))
        self.base = self.tmp / "aria-tools"
        set_profile(
            "standard", operator_approval_ref="h1-t",
            base_dir=self.base,
        )
        ensure_tools_dir(self.base)
        self.repo_root = self.tmp / "repo"
        self.repo_root.mkdir(parents=True, exist_ok=True)
        self.paths = _stub_paths(self.repo_root)

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _invoke(self, gaps: list[dict]) -> dict:
        # Mock the policy + capability_gap loaders + three downstream
        # genesis emitters; the function-under-test is purely the
        # routing branch.
        with patch(
            "aria_kernel.learning.load_genesis_policy",
            return_value={
                "enable_request_generation": True,
                "max_requests_per_cycle": 32,
            },
        ), patch(
            "aria_kernel.learning.latest_capability_gaps",
            return_value=gaps,
        ), patch(
            "aria_kernel.learning.existing_genesis_request_keys",
            return_value=set(),
        ), patch(
            "aria_kernel.learning.record_extension_decision",
        ) as ext, patch(
            "aria_kernel.skill_genesis.request_skill_genesis",
        ) as skill, patch(
            "aria_kernel.learning.request_agent_genesis",
        ) as agent:
            ext.return_value = {"row": "extension"}
            skill.return_value = {"row": "skill"}
            agent.return_value = {"row": "agent"}
            result = _skill_or_agent_genesis(
                cycle_id="cyc-h1",
                paths=self.paths,
                tools_root=self.base,
            )
        return {
            "result": result,
            "ext": ext,
            "skill": skill,
            "agent": agent,
        }

    def test_skill_gap_routes_to_request_skill_genesis(self) -> None:
        ctx = self._invoke([_gap(
            gap_id="g-1", gap_type="skill_gap",
            capability_gap_key="cgk-1",
        )])
        ctx["skill"].assert_called_once()
        ctx["agent"].assert_not_called()
        ctx["ext"].assert_not_called()
        self.assertIn(
            "skill_genesis_request_emitted",
            _governance_kinds(self.base),
        )

    def test_unobserved_surface_routes_to_adapter_authoring(self) -> None:
        # H-3. A root no adapter can parse needs a READER. Routing it to
        # request_agent_genesis would draft a review agent that still has no
        # tool able to open the files, so the next night measures the
        # identical blindness — a gap structurally incapable of closing.
        ctx = self._invoke([_gap(
            gap_id="g-4", gap_type="unobserved_surface",
            capability_gap_key="observation:sens-api-gateway",
        )])
        ctx["skill"].assert_called_once()
        ctx["agent"].assert_not_called()
        ctx["ext"].assert_not_called()
        self.assertIn(
            "skill_genesis_request_emitted",
            _governance_kinds(self.base),
        )

    def test_default_capability_gap_routes_to_agent_genesis(
        self,
    ) -> None:
        ctx = self._invoke([_gap(
            gap_id="g-2", gap_type="capability_gap",
            capability_gap_key="cgk-2",
        )])
        ctx["agent"].assert_called_once()
        ctx["skill"].assert_not_called()
        ctx["ext"].assert_not_called()
        self.assertIn(
            "genesis_request_emitted",
            _governance_kinds(self.base),
        )

    def test_existing_agent_extension_routes_to_record_extension(
        self,
    ) -> None:
        ctx = self._invoke([_gap(
            gap_id="g-3", gap_type="existing_agent_extension",
            capability_gap_key="cgk-3",
        )])
        ctx["ext"].assert_called_once()
        ctx["skill"].assert_not_called()
        ctx["agent"].assert_not_called()
        self.assertIn(
            "genesis_extension_recorded",
            _governance_kinds(self.base),
        )

    def test_mixed_gap_types_route_per_gap(self) -> None:
        gaps = [
            _gap(
                gap_id="g-mix-1", gap_type="skill_gap",
                capability_gap_key="cgk-m1",
            ),
            _gap(
                gap_id="g-mix-2", gap_type="capability_gap",
                capability_gap_key="cgk-m2",
            ),
            _gap(
                gap_id="g-mix-3", gap_type="existing_agent_extension",
                capability_gap_key="cgk-m3",
            ),
        ]
        ctx = self._invoke(gaps)
        self.assertEqual(ctx["skill"].call_count, 1)
        self.assertEqual(ctx["agent"].call_count, 1)
        self.assertEqual(ctx["ext"].call_count, 1)
        kinds = _governance_kinds(self.base)
        self.assertIn("skill_genesis_request_emitted", kinds)
        self.assertIn("genesis_request_emitted", kinds)
        self.assertIn("genesis_extension_recorded", kinds)


if __name__ == "__main__":
    unittest.main()
