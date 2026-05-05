from __future__ import annotations

import argparse
import tempfile
import unittest
from pathlib import Path

from aria_kernel.feedback import add_feedback, build_feedback_event, capability_gap_key, list_feedback
from aria_kernel.ledger import LedgerIntegrityError, read_jsonl
from aria_kernel.workspace import ensure_workspace, workspace_paths


def args(**overrides):
    base = {
        "kind": "missed_signal",
        "summary": "dynamic options were not traced",
        "ref": "web/modules/hr-module/src/pages/example.tsx:10",
        "concept": "LeaveRequestStatus",
        "source": "operator",
        "surface": "frontend",
        "failure_mode": "dynamic_option_provider",
        "parser_kind": "typescript",
        "capability_gap_key": None,
    }
    base.update(overrides)
    return argparse.Namespace(**base)


class FeedbackLoopTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.repo = self.base / "repo"
        self.repo.mkdir()
        self.workspace_base = self.base / "workspaces"
        self.paths = workspace_paths(self.repo, self.workspace_base)
        ensure_workspace(self.paths)

    def tearDown(self):
        self.tmp.cleanup()

    def test_capability_gap_key_is_stable_slug(self):
        self.assertEqual(
            capability_gap_key("Frontend UI", "Dynamic Option Provider", "TypeScript/JSX"),
            "frontend_ui:dynamic_option_provider:typescript_jsx",
        )

    def test_missed_signal_is_untrusted_and_recorded(self):
        event = build_feedback_event(args())
        emitted = add_feedback(self.paths, event)

        self.assertEqual(emitted, [])
        records = read_jsonl(self.paths.ledgers["missed_signals"])
        self.assertEqual(len(records), 1)
        self.assertFalse(records[0]["trusted"])
        self.assertEqual(records[0]["kind"], "missed_signal")

    def test_one_missed_signal_does_not_create_pressure(self):
        add_feedback(self.paths, build_feedback_event(args(ref="web/modules/hr-module/src/a.tsx:1")))

        self.assertEqual(read_jsonl(self.paths.ledgers["pressure"]), [])

    def test_three_independent_missed_signals_create_repetition_pressure(self):
        for ref in ["web/modules/hr-module/src/a.tsx:1", "web/modules/hr-module/src/b.tsx:2", "web/apps/aquamobil/src/c.ts:3"]:
            add_feedback(self.paths, build_feedback_event(args(ref=ref)))

        pressure = read_jsonl(self.paths.ledgers["pressure"])
        self.assertEqual(len(pressure), 1)
        self.assertEqual(pressure[0]["primitive"], "REPETITION")
        self.assertEqual(pressure[0]["drives"], ["skill_birth"])

    def test_three_unknown_capabilities_create_unknown_pressure(self):
        for ref in ["web/modules/hr-module/src/a.tsx:1", "web/modules/hr-module/src/b.tsx:2", "web/apps/aquamobil/src/c.ts:3"]:
            add_feedback(self.paths, build_feedback_event(args(kind="unknown_capability", ref=ref)))

        pressure = read_jsonl(self.paths.ledgers["pressure"])
        self.assertEqual(len(pressure), 1)
        self.assertEqual(pressure[0]["primitive"], "UNKNOWN")
        self.assertEqual(pressure[0]["drives"], ["adapter_birth"])

    def test_external_contradiction_creates_investigation_pressure(self):
        event = build_feedback_event(
            args(
                kind="external_contradiction",
                source="external_scanner",
                summary="external scan found a drift ARIA suppressed",
            )
        )
        emitted = add_feedback(self.paths, event)

        self.assertEqual(len(emitted), 1)
        self.assertEqual(emitted[0]["primitive"], "CONTRADICTION")
        self.assertEqual(emitted[0]["drives"], ["investigation_task"])

    def test_false_positive_feedback_drives_calibration_not_skill_birth(self):
        for ref in ["apps/a.ts:1", "apps/b.ts:2", "apps/c.ts:3"]:
            add_feedback(
                self.paths,
                build_feedback_event(
                    args(
                        kind="false_positive",
                        summary="framework convention, not drift",
                        ref=ref,
                        surface="backend",
                        failure_mode="framework_convention_false_positive",
                    )
                ),
            )

        pressure = read_jsonl(self.paths.ledgers["pressure"])
        self.assertEqual(len(pressure), 1)
        self.assertEqual(pressure[0]["drives"], ["calibration"])
        self.assertNotIn("skill_birth", pressure[0]["drives"])

    def test_external_feedback_is_listed_by_kind(self):
        add_feedback(self.paths, build_feedback_event(args(kind="confirmed_signal", source="external_scanner")))

        listed = list_feedback(self.paths, "confirmed_signal")
        self.assertEqual(len(listed), 1)
        self.assertFalse(listed[0]["trusted"])

    def test_ledger_mutation_is_detected(self):
        add_feedback(self.paths, build_feedback_event(args()))
        self.paths.ledgers["missed_signals"].write_text("", encoding="utf-8")

        with self.assertRaises(LedgerIntegrityError):
            list_feedback(self.paths)


class CliShapeTests(unittest.TestCase):
    def test_feedback_event_schema_contains_required_fields(self):
        event = build_feedback_event(args())
        self.assertEqual(event["$schema"], "aria/feedback-event/v1")
        self.assertIn("capability_gap_key", event)
        self.assertIn("evidence_refs", event)
        self.assertEqual(event["schema_version"], 1)


if __name__ == "__main__":
    unittest.main()
