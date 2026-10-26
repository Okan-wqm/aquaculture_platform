"""Plan 023 §B, re-pinned by F0.7 (ARIA-MEDIUM-730) — a consensus
uncertainty never becomes HUMAN_REQUIRED.

Plan 023 drained the uncertainty ledger into operator triage; F0.7 routes
judgment uncertainty to the arbiter instead (test_f07_uncertainty_to_arbiter
pins the arbiter side). These tests pin the registry side: the sweep creates
nothing, reports each uncertainty's lane, and stays a no-op on reruns.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.feedback_store import UNVERIFIABLE_RATE_CEILING, _consensus_uncertainty
from aria_kernel.human_required import (
    CONSENSUS_ESCALATION_KIND,
    list_human_required,
    record_human_required,
    sweep_consensus_uncertainties_for_human_required,
)
from aria_kernel.tool_registry import ensure_tools_dir, utc_now


class ConsensusEscalationTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _write_uncertainties(self, *uncertainties: dict) -> None:
        line = {
            "schema_version": 1,
            "recorded_at": utc_now(),
            "tool_id": "tool-x",
            "cycle_id": "cycle-1",
            "uncertainties": list(uncertainties),
        }
        path = self.tools / "feedback-consensus-uncertainties.jsonl"
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(line, sort_keys=True) + "\n")

    def _governance_rows(self, kind: str | None = None) -> list[dict]:
        path = self.tools / "governance.jsonl"
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        return [row for row in rows if kind is None or row.get("kind") == kind]

    def _unverifiable_groups(self, start: int, stop: int) -> None:
        self._write_uncertainties(*(
            _consensus_uncertainty("tool-x", f"run-{i}", f"F-{i}", f"g{i}", "unverifiable")
            for i in range(start, stop)
        ))

    def test_no_file_is_a_noop(self) -> None:
        result = sweep_consensus_uncertainties_for_human_required(base_dir=self.tools)
        self.assertEqual(result["created"], [])

    def test_no_reason_escalates_and_each_is_reported_in_its_lane(self) -> None:
        self._write_uncertainties(
            _consensus_uncertainty("tool-x", "run-1", "F-1", "g1", "judge_disagreement"),
            _consensus_uncertainty("tool-x", "run-2", "F-2", "g2", "low_confidence"),
            _consensus_uncertainty("tool-x", "run-3", "F-3", "g3", "single_judge"),
            _consensus_uncertainty("tool-x", "run-4", "F-4", "g4", "unverifiable"),
        )
        result = sweep_consensus_uncertainties_for_human_required(base_dir=self.tools)
        self.assertEqual(result["created"], [])
        self.assertEqual(result["routed"], {"arbiter": 2, "terminal": 1, "not_arbitrated": 1})
        self.assertEqual(list_human_required(base_dir=self.tools).rows, [])

    def test_the_unverifiable_rate_is_reported_against_its_ceiling(self) -> None:
        self._write_uncertainties(
            _consensus_uncertainty("tool-x", "run-4", "F-4", "g4", "unverifiable"),
        )
        [rate] = sweep_consensus_uncertainties_for_human_required(base_dir=self.tools)["unverifiable_rate"]
        self.assertEqual((rate["tool_id"], rate["unverifiable"], rate["settled"], rate["rate"]), ("tool-x", 1, 0, 1.0))
        self.assertEqual(rate["ceiling"], UNVERIFIABLE_RATE_CEILING)

    def test_idempotent_across_reruns(self) -> None:
        self._write_uncertainties(
            _consensus_uncertainty("tool-x", "run-1", "F-1", "g1", "judge_disagreement"),
        )
        first = sweep_consensus_uncertainties_for_human_required(base_dir=self.tools)
        second = sweep_consensus_uncertainties_for_human_required(base_dir=self.tools)
        self.assertEqual(first, second)
        self.assertEqual(list_human_required(base_dir=self.tools).rows, [])

    def test_a_rerun_adds_nothing_to_the_governance_ledger(self) -> None:
        # The sweep's only writes are its two disclosures: a legacy record it
        # routes to the arbiter, and a tool's unverifiable rate over its
        # ceiling (six distinct groups: Wilson lower bound 0.6097 > 0.25). A
        # re-run over the same state must add neither.
        self._unverifiable_groups(1, 7)
        record_human_required(
            request_id="HR-consensus-legacy", severity="high", reason="pre-F0.7 consensus escalation",
            context={"kind": CONSENSUS_ESCALATION_KIND, "tool_id": "tool-x", "run_id": "run-1",
                     "finding_id": "F-1", "judgment_group_id": "g1"},
            base_dir=self.tools)

        first = sweep_consensus_uncertainties_for_human_required(base_dir=self.tools)
        self.assertEqual(first["routed_records"], ["HR-consensus-legacy"])
        [breach] = first["unverifiable_rate_ceiling"]
        self.assertEqual((breach["tool_id"], breach["unverifiable"]), ("tool-x", 6))
        ledger = self._governance_rows()
        self.assertEqual([row["kind"] for row in ledger
                          if row["kind"] in ("consensus_escalation_routed_to_arbiter", "unverifiable_rate_ceiling")],
                         ["consensus_escalation_routed_to_arbiter", "unverifiable_rate_ceiling"])

        second = sweep_consensus_uncertainties_for_human_required(base_dir=self.tools)

        self.assertEqual(second["routed_records"], [])
        self.assertEqual(second["unverifiable_rate_ceiling"], first["unverifiable_rate_ceiling"])  # still reported
        self.assertEqual(self._governance_rows(), ledger)  # and not said again

    def test_a_changed_unverifiable_count_is_a_new_disclosure_and_a_standing_one_is_not(self) -> None:
        self._unverifiable_groups(1, 7)
        sweep_consensus_uncertainties_for_human_required(base_dir=self.tools)
        sweep_consensus_uncertainties_for_human_required(base_dir=self.tools)
        self.assertEqual([row["details"]["unverifiable"] for row in self._governance_rows("unverifiable_rate_ceiling")], [6])

        self._unverifiable_groups(7, 8)  # a seventh group: a changed count is a new fact
        sweep_consensus_uncertainties_for_human_required(base_dir=self.tools)
        sweep_consensus_uncertainties_for_human_required(base_dir=self.tools)
        self.assertEqual([row["details"]["unverifiable"] for row in self._governance_rows("unverifiable_rate_ceiling")], [6, 7])


if __name__ == "__main__":
    unittest.main()
