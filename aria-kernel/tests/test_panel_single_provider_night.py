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


class WriteSeatLivenessFailsClosedTests(unittest.TestCase):
    """ARIA-HIGH-788 class, at the panel mint's write-seat liveness read.

    The read used to absorb ANY exception from the cooldown reader into
    "no provider is cooled" and kept a write-scope seat whose ladder the
    routing table refused. Both fail open: a corrupt cooldown ledger, or a
    reader defect, minted a reproduction seat onto a ladder whose every rung
    might be cooled, and an unroutable seat minted an envelope no executor
    can take. The read now names the store faults it may absorb (the
    cooldown reader's own ``cooldown_reader_faults``), drops the write seat
    on them with the fault recorded, drops a seat with no resolvable ladder,
    and lets every other exception propagate.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-wpj-failclosed-")
        self.tools = ensure_tools_dir(Path(self._tmp.name) / "aria-tools")
        register_contracted_tool(self.tools, "tool-x")
        # Every vendor present: absent a fault, the write rung is live and
        # the whole panel mints (the healthy-night case above).
        presence = patch(
            "aria_kernel.provider_outage.host_providers",
            return_value=frozenset({"anthropic", "zai", "openai"}),
        )
        presence.start()
        self.addCleanup(presence.stop)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _mint(self) -> dict:
        return dispatch_judges_for_sample(sample=_sample(), base_dir=self.tools, roles=PANEL)

    def _downgrade_rows(self) -> list[dict]:
        return [row for row in _governance_rows(self.tools)
                if row.get("kind") == "judge_panel_write_seat_downgrade"]

    def _assert_write_seat_dropped(
        self, result: dict, reason: str, *, minted=frozenset(agent for _role, agent in _READ_ONLY_SEATS),
    ) -> dict:
        minted_seats = {row.get("target_agent") for row in result.get("minted", [])}
        self.assertEqual(minted_seats, set(minted))
        self.assertEqual(
            [entry.get("reason") for entry in result.get("skipped", [])
             if entry.get("target_agent") == "aria-test-writer"],
            [reason],
        )
        rows = self._downgrade_rows()
        self.assertEqual(len(rows), 1, rows)
        details = rows[0].get("details") or {}
        self.assertEqual(details.get("downgraded_seats"), ["reproduction_test"])
        self.assertEqual(details.get("seat_reasons"), {"reproduction_test": reason})
        return details

    def test_a_defect_in_the_cooldown_reader_propagates(self) -> None:
        # Asked of the liveness read itself: through the whole mint, the
        # door's own cooldown read (request_admission._measure) would raise
        # the same TypeError later and hide whether THIS read absorbed it.
        from aria_kernel.judge_fanout import _drop_write_seats_without_a_live_rung

        with patch(
            "aria_kernel.provider_outage.cooled_providers",
            side_effect=TypeError("cooled_providers() got an unexpected keyword argument"),
        ):
            with self.assertRaises(TypeError):
                _drop_write_seats_without_a_live_rung(self.tools, PANEL)
        self.assertEqual(self._downgrade_rows(), [])

    def test_a_corrupt_cooldown_ledger_drops_the_write_seat_with_the_fault_recorded(self) -> None:
        from aria_kernel.provider_cooldown import PROVIDER_COOLDOWN_GOVERNANCE_KIND
        from aria_kernel.tool_registry import append_tools_governance

        append_tools_governance(self.tools, PROVIDER_COOLDOWN_GOVERNANCE_KIND, {
            "schema_version": 1, "provider": "anthropic", "until": "2999-01-01T00:00:00Z",
        })
        # The door reads the same ledger and holds the read-only seats WHOLE
        # (request_admission: provider status unreadable), so nothing mints
        # tonight; the write seat's own drop is still recorded with the fault.
        result = self._mint()
        details = self._assert_write_seat_dropped(result, "seat_write_cooldowns_unreadable", minted=())
        self.assertIn(
            {"reason": "request_admission_throttled:provider_status_unreadable", "whole_panel": True,
             "seats": [agent for _role, agent in _READ_ONLY_SEATS]},
            [{key: entry.get(key) for key in ("reason", "whole_panel", "seats")}
             for entry in result.get("skipped", [])],
        )
        self.assertIsNone(details.get("cooled_providers"), "an unreadable ledger is not an empty one")
        fault = str(details.get("cooldown_fault") or "")
        self.assertTrue(fault.startswith("ProviderCooldownRowMalformed: "), details)
        self.assertIn("provider_cooldown_row_malformed:", fault)

    def test_a_write_seat_without_a_resolvable_ladder_is_dropped(self) -> None:
        from aria_kernel.runtime_profiles import ProviderRouting
        from aria_kernel.tool_registry import GovernanceError

        resolve = ProviderRouting.ladder_for

        def ladder_for(routing, role, target_agent, **kwargs):
            if role == "reproduction_test":
                raise GovernanceError(f"provider_routing_target_unrouted:{role}:{target_agent}")
            return resolve(routing, role, target_agent, **kwargs)

        with patch.object(ProviderRouting, "ladder_for", ladder_for):
            details = self._assert_write_seat_dropped(self._mint(), "seat_write_ladder_unresolved")
        self.assertEqual(
            details.get("ladder_faults"),
            {"reproduction_test": "provider_routing_target_unrouted:reproduction_test:aria-test-writer"},
        )

    def test_a_write_seat_whose_every_rung_is_suspended_is_dropped(self) -> None:
        from aria_kernel.runtime_profiles import ProviderRouting

        resolve = ProviderRouting.ladder_for

        def ladder_for(routing, role, target_agent, **kwargs):
            if role == "reproduction_test":
                return ()
            return resolve(routing, role, target_agent, **kwargs)

        with patch.object(ProviderRouting, "ladder_for", ladder_for):
            self._assert_write_seat_dropped(self._mint(), "seat_write_rung_unavailable")


if __name__ == "__main__":
    unittest.main()
