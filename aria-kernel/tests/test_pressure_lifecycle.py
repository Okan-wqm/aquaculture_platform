from __future__ import annotations

import argparse
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from io import StringIO
from pathlib import Path

from aria_kernel.cli import main
from aria_kernel.feedback import add_feedback, build_feedback_event
from aria_kernel.integrity import verify_integrity
from aria_kernel.ledger import append_jsonl as _append_jsonl
from aria_kernel.pressure import (
    append_pressure_state_event,
    curate_workspace_pressures,
    effective_workspace_pressures,
    list_workspace_pressures,
)
from aria_kernel.workspace import ensure_workspace, workspace_paths


def append_jsonl(path, record):
    return _append_jsonl(path, record, test_fixture=True)


class PressureLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / "repo"
        self.repo.mkdir()
        self.workspace_base = Path(self.tmp.name) / "workspaces"
        self.tools_dir = Path(self.tmp.name) / "aria-tools"
        self.paths = workspace_paths(self.repo, self.workspace_base)
        ensure_workspace(self.paths)

    def tearDown(self):
        self.tmp.cleanup()

    def test_closed_signal_requires_evidence_ref(self):
        with self.assertRaisesRegex(ValueError, "closed_signal_evidence_required"):
            build_feedback_event(
                self._args(
                    kind="closed_signal",
                    ref="docs/reviews/finding.md",
                    summary="External closure exists",
                    evidence_ref=[],
                ),
            )

    def test_closed_signal_rejects_invalid_evidence_prefix(self):
        with self.assertRaisesRegex(ValueError, "closed_signal_evidence_invalid"):
            build_feedback_event(
                self._args(
                    kind="closed_signal",
                    ref="docs/reviews/finding.md",
                    summary="External closure exists",
                    evidence_ref=["random-string"],
                ),
            )

    def test_closed_signal_threshold_closes_matching_pressure(self):
        gap = "backend:schema_drift:ts"
        for index in range(3):
            event = build_feedback_event(
                self._args(
                    kind="unknown_capability",
                    ref=f"apps/api/src/entity-{index}.ts",
                    summary=f"Repeated unknown capability {index}",
                    capability_gap_key=gap,
                ),
            )
            add_feedback(self.paths, event)

        active = list_workspace_pressures(self.paths)
        self.assertEqual(len(active), 1)
        pressure_id = active[0]["event_id"]

        evidence_refs = ["git:commit:abc123", "github:PR:42", "git:commit:abc123"]
        for index in range(3):
            event = build_feedback_event(
                self._args(
                    kind="closed_signal",
                    ref=f"manual:closure-{index}",
                    summary=f"Closure signal {index}",
                    capability_gap_key=gap,
                    evidence_ref=[evidence_refs[index]],
                ),
            )
            add_feedback(self.paths, event)

        self.assertEqual(list_workspace_pressures(self.paths), [])
        closed = list_workspace_pressures(self.paths, include_states={"closed"})
        self.assertEqual([row["event_id"] for row in closed], [pressure_id])
        self.assertEqual(closed[0]["effective_state"], "closed")
        self.assertEqual(closed[0]["state_history"][-1]["reason"], "closed_signal_threshold_met")

    def test_decay_buckets_and_terminal_state_are_deterministic(self):
        now = datetime(2026, 5, 5, tzinfo=timezone.utc)
        cases = {
            "PE-age-89": (89, "active"),
            "PE-age-90": (90, "faded"),
            "PE-age-180": (180, "sleeping"),
            "PE-age-365": (365, "archived"),
        }
        for event_id, (age_days, _state) in cases.items():
            append_jsonl(self.paths.ledgers["pressure"], self._pressure(event_id, now - timedelta(days=age_days)))
        missing_ts = self._pressure("PE-missing-ts", now)
        missing_ts.pop("detected_at")
        append_jsonl(self.paths.ledgers["pressure"], missing_ts)

        by_id = {row["event_id"]: row for row in effective_workspace_pressures(self.paths, now=now)}
        for event_id, (_age_days, state) in cases.items():
            self.assertEqual(by_id[event_id]["effective_state"], state)
        self.assertEqual(by_id["PE-missing-ts"]["last_evidence_at"], "1970-01-01T00:00:00Z")
        self.assertTrue(by_id["PE-missing-ts"]["state_details"]["timestamp_missing"])

        append_pressure_state_event(
            self.paths,
            pressure=by_id["PE-age-365"],
            to_state="closed",
            reason="operator verified closure",
            evidence_refs=["manual:verified"],
            now=now,
        )
        by_id = {row["event_id"]: row for row in effective_workspace_pressures(self.paths, now=now + timedelta(days=30))}
        self.assertEqual(by_id["PE-age-365"]["effective_state"], "closed")

    def test_curate_dry_run_and_apply_append_state_only(self):
        now = datetime(2026, 5, 5, tzinfo=timezone.utc)
        pressure = self._pressure("PE-curate", now - timedelta(days=120))
        append_jsonl(self.paths.ledgers["pressure"], pressure)

        dry_run = curate_workspace_pressures(self.paths, since_days=90, now=now)
        self.assertEqual(dry_run["mode"], "dry_run")
        self.assertEqual(dry_run["candidate_count"], 1)
        self.assertEqual(self.paths.ledgers["pressure_state"].read_text(encoding="utf-8"), "")

        applied = curate_workspace_pressures(
            self.paths,
            since_days=90,
            apply=True,
            acknowledge=True,
            reason="operator archived stale pressure",
            now=now,
        )
        self.assertEqual(applied["state_events_written"][0]["to_state"], "archived")
        self.assertEqual(len(effective_workspace_pressures(self.paths, now=now)), 1)
        self.assertEqual(effective_workspace_pressures(self.paths, now=now)[0]["effective_state"], "archived")

    def test_cli_pressure_list_defaults_to_active_and_explain_shows_history(self):
        # Anchored to the wall clock, NOT a literal date: the CLI reads with
        # the real clock (there is no --now), so a fixed detected_at is a
        # calendar bomb — it decays past the 90-day "faded" threshold and
        # the default active filter silently drops the fixture (this fired
        # on 2026-08-03, exactly 90 days after the old literal).
        now = datetime.now(timezone.utc)
        active = self._pressure("PE-cli-active", now)
        closed = self._pressure("PE-cli-closed", now)
        append_jsonl(self.paths.ledgers["pressure"], active)
        append_jsonl(self.paths.ledgers["pressure"], closed)
        append_pressure_state_event(
            self.paths,
            pressure=closed,
            to_state="closed",
            reason="manual closure",
            evidence_refs=["manual:closed"],
            now=now,
        )

        listed = self._main_json(
            [
                "pressure",
                "list",
                "--workspace-root",
                str(self.repo),
                "--workspace-base",
                str(self.workspace_base),
            ],
        )
        self.assertEqual([row["event_id"] for row in listed], ["PE-cli-active"])

        with_closed = self._main_json(
            [
                "pressure",
                "list",
                "--workspace-root",
                str(self.repo),
                "--workspace-base",
                str(self.workspace_base),
                "--include-closed",
            ],
        )
        self.assertEqual({row["event_id"] for row in with_closed}, {"PE-cli-active", "PE-cli-closed"})

        buckets = self._main_json(
            [
                "pressure",
                "list",
                "--workspace-root",
                str(self.repo),
                "--workspace-base",
                str(self.workspace_base),
                "--include-closed",
                "--age-buckets",
            ],
        )
        self.assertEqual(buckets["age_buckets"]["active"], 1)
        self.assertEqual(buckets["age_buckets"]["closed"], 1)

        explained = self._main_json(
            [
                "pressure",
                "explain",
                "PE-cli-closed",
                "--workspace-root",
                str(self.repo),
                "--workspace-base",
                str(self.workspace_base),
            ],
        )
        self.assertEqual(explained["effective_state"], "closed")
        self.assertEqual(explained["state_history"][0]["reason"], "manual closure")

    def test_integrity_verify_covers_pressure_state_ledger(self):
        now = datetime(2026, 5, 5, tzinfo=timezone.utc)
        pressure = self._pressure("PE-integrity", now)
        append_jsonl(self.paths.ledgers["pressure"], pressure)
        append_pressure_state_event(
            self.paths,
            pressure=pressure,
            to_state="closed",
            reason="manual closure",
            evidence_refs=["manual:closed"],
            now=now,
        )
        self.assertTrue(
            verify_integrity(
                workspace_root=self.repo,
                workspace_base=self.workspace_base,
                tools_dir=self.tools_dir,
            )["valid"],
        )

        payload = self.paths.ledgers["pressure_state"].read_text(encoding="utf-8")
        self.paths.ledgers["pressure_state"].write_text(payload.replace("manual closure", "tampered closure"), encoding="utf-8")
        self.assertFalse(
            verify_integrity(
                workspace_root=self.repo,
                workspace_base=self.workspace_base,
                tools_dir=self.tools_dir,
            )["valid"],
        )

    def _args(self, **overrides):
        defaults = {
            "kind": "unknown_capability",
            "summary": "summary",
            "ref": "apps/api/src/app.ts",
            "concept": "concept",
            "source": "operator",
            "surface": None,
            "failure_mode": None,
            "parser_kind": None,
            "capability_gap_key": None,
            "evidence_ref": [],
        }
        defaults.update(overrides)
        return argparse.Namespace(**defaults)

    def _main_json(self, argv: list[str]):
        output = StringIO()
        with redirect_stdout(output):
            self.assertEqual(main(argv), 0)
        return json.loads(output.getvalue())

    def _pressure(self, event_id: str, detected_at: datetime) -> dict[str, object]:
        return {
            "$schema": "aria/pressure-event/v2",
            "event_id": event_id,
            "cycle_id": None,
            "primitive": "UNKNOWN",
            "subtype": "fixture",
            "capability_gap_key": "backend:schema_drift:ts",
            "magnitude": 3,
            "threshold": 3,
            "exceeds_threshold": True,
            "evidence_refs": [],
            "feedback_event_ids": [],
            "legacy_feedback_event_ids": [],
            "legacy_event_ids": [],
            "evidence_fingerprint": f"sha256:{event_id}",
            "detected_at": detected_at.isoformat().replace("+00:00", "Z"),
            "drives": ["adapter_birth"],
            "schema_version": 2,
        }


if __name__ == "__main__":
    unittest.main()
