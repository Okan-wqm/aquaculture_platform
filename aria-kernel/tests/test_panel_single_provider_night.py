"""WP-J review — a single-provider night still hands the panel a verdict.

The reproduction seat is the panel's one WRITE-scope role and rides the
``claude_writer`` ladder (anthropic, zai — openai admits no writes, so the
loader refuses it there). On a Codex-only night that seat has NO live rung,
yet the panel minted it whole (verified at HEAD: ``host_providers() ==
{'openai'}`` and the four-seat panel mints all four seats): an envelope
that can never execute, in a group that can therefore never settle — a
CRITICAL item gets no verdict at all, which the operator's continuity rule
(HANDOVER §7: with any single provider alive, every role runs) forbids.

The degradation law, at the panel mint (the owner of whole-or-not): a
write-scope seat with no live rung is DROPPED from tonight's panel — the
item routes a write-free panel and still gets its verdict — and the
downgrade is recorded by name (per-finding skip rows plus one governance
row), never silently.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.feedback_store import generate_ai_consensus, is_ground_truth_row
from aria_kernel.judge_fanout import dispatch_judges_for_sample
from aria_kernel.judgment_bridge import record_judge_verdict_from_response
from aria_kernel.tool_registry import ensure_tools_dir

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT / "aria-kernel") not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT / "aria-kernel"))

from tests._helpers.rule_contracts import register_contracted_tool  # noqa: E402

PANEL = (
    ("evidence_judgment", "aria-evidence-judge"),
    ("adversarial_judgment", "aria-adversarial-judge"),
    ("bug_hunt", "aria-bug-hunter"),
    ("reproduction_test", "aria-test-writer"),
)
_READ_ONLY_SEATS = PANEL[:3]

_RATIONALES = {
    "aria-evidence-judge": "the cited line performs the operation on the tenant context",
    "aria-adversarial-judge": "reading the same line from the guard's side confirms the claim",
    "aria-bug-hunter": "a failing input exercises the skipped predicate directly",
    "aria-test-writer": "the red recipe reproduces the defect at this commit",
}


def _sample() -> dict:
    return {
        "cycle_id": "c1",
        "items": [{
            "tool_id": "tool-x", "run_id": "r1", "cycle_id": "c1", "finding_id": "F1",
            "rule": "rule-a", "severity": "critical", "path": "src/f1.py:1",
            "message": "suspicious", "evidence": ["src/f1.py:1"],
            "finding_fingerprint": "fp1",
        }],
    }


def _governance_rows(base_dir: Path) -> list[dict]:
    path = base_dir / "governance.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


class SingleProviderPanelNightTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-wpj-codex-")
        self.tools = ensure_tools_dir(Path(self._tmp.name) / "aria-tools")
        register_contracted_tool(self.tools, "tool-x")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _mint(self, roles=PANEL) -> dict:
        return dispatch_judges_for_sample(
            sample=_sample(), base_dir=self.tools, roles=roles,
        )

    def test_a_codex_only_night_routes_the_write_free_panel(self) -> None:
        with patch(
            "aria_kernel.provider_outage.host_providers",
            return_value=frozenset({"openai"}),
        ):
            result = self._mint()
        minted_seats = {row.get("target_agent") for row in result.get("minted", [])}
        self.assertIn("aria-evidence-judge", minted_seats)
        self.assertIn("aria-bug-hunter", minted_seats)
        self.assertNotIn(
            "aria-test-writer", minted_seats,
            "the reproduction seat has no live rung on a Codex-only night; "
            "minting it whole creates a group that can never settle",
        )
        downgraded = [
            entry for entry in result.get("skipped", [])
            if entry.get("reason") == "seat_write_rung_unavailable"
        ]
        self.assertTrue(downgraded, result.get("skipped"))
        self.assertEqual(downgraded[0].get("target_agent"), "aria-test-writer")

    def test_the_downgrade_is_recorded_by_name(self) -> None:
        with patch(
            "aria_kernel.provider_outage.host_providers",
            return_value=frozenset({"openai"}),
        ):
            self._mint()
        rows = [
            row for row in _governance_rows(self.tools)
            if row.get("kind") == "judge_panel_write_seat_downgrade"
        ]
        self.assertEqual(len(rows), 1, rows)
        details = rows[0].get("details") or {}
        self.assertEqual(details.get("downgraded_seats"), ["reproduction_test"])
        self.assertEqual(details.get("live_providers"), ["openai"])

    def test_the_write_free_panel_still_settles_the_critical_item(self) -> None:
        """The point of the degradation: the tier-4 item GETS ITS VERDICT.

        Three read-only seats of distinct methods answer; the consensus
        engine settles the group at anchor grade — nothing waits on a seat
        that cannot run.
        """
        with patch(
            "aria_kernel.provider_outage.host_providers",
            return_value=frozenset({"openai"}),
        ):
            self._mint()
        from aria_kernel.agent_invocations import list_agent_invocation_requests

        for request in list_agent_invocation_requests(base_dir=self.tools):
            agent = str(request.get("target_agent") or "")
            if agent == "aria-test-writer":
                continue
            verdict_block = {
                "verdict": "true_positive", "confidence": 0.95, "severity": "critical",
                "rationale": _RATIONALES[agent], "evidence_refs": ["src/f1.py:1"],
            }
            if agent == "aria-bug-hunter":
                # The seat's method requires its artifact (the failing input
                # it hunted); the bridge refuses an answer without it.
                verdict_block["failing_input"] = "a batch request without a tenant scope"
            record_judge_verdict_from_response(
                request=request,
                response={
                    "role": request["role"], "request_id": request["request_id"],
                    "satisfaction_matrix": [
                        {"id": item["id"], "verdict": "satisfied", "evidence_refs": ["src/f1.py:1"]}
                        for item in request.get("must_satisfy") or [] if isinstance(item, dict)
                    ],
                    "details": {
                        "agent_subagent_type": agent,
                        "agent_dispatch_model": "gpt-5-codex",
                        "verdict": verdict_block,
                    },
                },
                base_dir=self.tools,
            )
        settled = generate_ai_consensus(tool_id="tool-x", base_dir=self.tools)
        self.assertEqual(settled["consensus_count"], 1, settled.get("uncertainties"))
        self.assertTrue(
            is_ground_truth_row(settled["consensus"][0]),
            "a write-free three-method panel is still an anchor-grade verdict",
        )

    def test_a_night_with_a_live_write_rung_mints_the_whole_panel(self) -> None:
        with patch(
            "aria_kernel.provider_outage.host_providers",
            return_value=frozenset({"anthropic", "zai", "openai"}),
        ):
            result = self._mint()
        minted_seats = {row.get("target_agent") for row in result.get("minted", [])}
        self.assertEqual(minted_seats, {agent for _role, agent in PANEL})
        self.assertNotIn(
            "judge_panel_write_seat_downgrade",
            {row.get("kind") for row in _governance_rows(self.tools)},
        )


if __name__ == "__main__":
    unittest.main()
