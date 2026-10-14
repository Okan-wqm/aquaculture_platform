"""incident_ledger through its REAL I/O path (ARIA-LOW-491).

Every prior tests/ reference to this module was a mock target
(test_merge_authority_pre_merge_perimeter patches
``aria_kernel.merge_authority.ensure_pre_merge_incident_row``), which
disables the very writer it names. These cases drive the ledger for real:
write rows to an incidents.jsonl under a TemporaryDirectory, read them
back with the loader production uses, and pin the idempotence and
fail-closed contracts.

ARIA-LOW-491 — the accepted event vocabulary is exactly what the producers write;
``incident_opened`` was accepted with no producer and no reader.
"""
from __future__ import annotations

import ast
import tempfile
import unittest
from pathlib import Path

from aria_kernel.incident_ledger import ensure_pre_merge_incident_row, record_incident_event
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.tool_registry import GovernanceError

_MODULE = Path(__file__).resolve().parents[1] / "aria_kernel" / "incident_ledger.py"


def _incidents_path(root: Path) -> Path:
    return root / "enterprise" / "incidents.jsonl"


def _event(incident_event: str) -> dict:
    return {
        "incident_event": incident_event,
        "repo": "acme/aqua",
        "pr_number": 1,
        "target_ref": "main",
        "head_ref": "aria/impl-1",
        "head_sha": "b" * 40,
        "readiness_claim_id": "claim-1",
    }


class RecordIncidentEventBehavior(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-incident-")
        self.root = Path(self._tmp.name) / "aria-tools"
        self.root.mkdir(parents=True)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_row_is_written_and_read_back(self) -> None:
        row = record_incident_event(
            {**_event("pre_merge_no_incident"), "pr_number": 4242, "head_sha": "a" * 40},
            base_dir=self.root,
        )
        self.assertEqual(row["schema_version"], 1)
        self.assertTrue(row["recorded_at"])
        rows = load_declared_jsonl(_incidents_path(self.root), expected_surface="enterprise_incidents")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["row_id"], row["row_id"])
        self.assertEqual(rows[0]["pr_number"], 4242)

    def test_unknown_event_is_refused(self) -> None:
        for incident_event in ("something_else", "incident_opened"):
            with self.subTest(incident_event=incident_event):
                with self.assertRaisesRegex(GovernanceError, "incident_event_unknown"):
                    record_incident_event(_event(incident_event), base_dir=self.root)

    def test_missing_common_fields_are_refused(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "incident_event_missing_fields"):
            record_incident_event({"incident_event": "merge_failed"}, base_dir=self.root)


class EnsurePreMergeIncidentRowBehavior(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-incident-idem-")
        self.root = Path(self._tmp.name) / "aria-tools"
        self.root.mkdir(parents=True)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_second_call_returns_existing_row_without_duplicate(self) -> None:
        pr = {
            "number": 777,
            "head_sha": "c" * 40,
            "repository": "acme/aqua",
            "base_branch": "main",
            "headRefName": "aria/impl-9",
        }
        first = ensure_pre_merge_incident_row(pr=pr, readiness_claim_id="claim-9", base_dir=self.root)
        second = ensure_pre_merge_incident_row(pr=pr, readiness_claim_id="claim-9", base_dir=self.root)
        self.assertEqual(first["row_id"], second["row_id"])
        rows = load_declared_jsonl(_incidents_path(self.root), expected_surface="enterprise_incidents")
        matching = [
            row for row in rows
            if row.get("pr_number") == 777 and row.get("readiness_claim_id") == "claim-9"
        ]
        self.assertEqual(len(matching), 1)


class IncidentEventVocabulary(unittest.TestCase):
    def test_accepted_events_are_exactly_the_produced_events(self) -> None:
        from aria_kernel.incident_ledger import INCIDENT_EVENTS

        produced = {
            value.value
            for node in ast.walk(ast.parse(_MODULE.read_text(encoding="utf-8")))
            if isinstance(node, ast.Dict)
            for key, value in zip(node.keys, node.values)
            if isinstance(key, ast.Constant) and key.value == "incident_event"
            and isinstance(value, ast.Constant)
        }
        self.assertEqual(produced, set(INCIDENT_EVENTS))


if __name__ == "__main__":
    unittest.main()
