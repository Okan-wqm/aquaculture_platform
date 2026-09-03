"""Plan 032 Faz 032a — the store keeps what it needs to resume, and the repo
keeps no secret-shaped literals in its Claude settings.

Invariants:
  I-V12-STATE-01   `compact_state` never removes a write-driving ledger:
                   the ledgers it does not own are untouched, byte for byte.
  I-V12-STATE-02   `write_driving_lost` names exactly the write-driving
                   ledger losses among a lost-surface set.
  I-V12-DLP-01     `.claude/settings*.json` carry no DLP-pattern hits
                   (90 JWT-shaped `permissions.allow` literals were found
                   on 2026-09-02).
"""
from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

from tests.invariants.v12 import _helpers  # noqa: F401 — sys.path

from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.memory_gap import write_driving_lost
from aria_kernel.readiness_proofs import scan_paths_for_secrets
from aria_kernel.state_compact import compact_state
from aria_kernel.state_manifest import iter_surfaces
from aria_kernel.tool_registry import ensure_tools_dir

_REPO_ROOT = Path(__file__).resolve().parents[4]


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class CompactKeepsWriteDrivingLedgers(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_I_V12_STATE_01_unowned_write_driving_ledgers_survive_compaction(self) -> None:
        plans = self.tools / "plans" / "events.jsonl"
        requests = self.tools / "agent-invocations" / "requests.jsonl"
        append_declared_jsonl(
            plans, {"plan_id": "plan-1", "event": "plan_started"},
            expected_surface="plan_convergence_events",
        )
        append_declared_jsonl(
            requests, {"request_id": "AIR-1", "role": "challenger_plan", "created_at": "2026-09-02T00:00:00+00:00"},
            expected_surface="agent_invocation_requests",
        )
        before = {plans: _sha(plans), requests: _sha(requests)}

        summary = compact_state(base_dir=self.tools, retain_days=0, dry_run=False)

        self.assertFalse(summary["dry_run"])
        for path, digest in before.items():
            self.assertTrue(path.is_file(), f"{path.name} must survive compaction")
            self.assertEqual(_sha(path), digest, f"{path.name} must be byte-identical")

    def test_I_V12_STATE_01_the_compactor_only_names_ledger_surfaces_it_rewrites(self) -> None:
        from aria_kernel import state_compact

        owned = {"runs", "raw_findings", "beliefs", "learning_events"}
        for name in owned:
            path = state_compact._surface_path(self.tools, name)
            self.assertTrue(path.as_posix().endswith(".jsonl"), name)
        # The mapping is closed: a fifth surface cannot be compacted by name.
        with self.assertRaises(KeyError):
            state_compact._surface_path(self.tools, "plan_convergence_events")


class WriteDrivingLossIsNamed(unittest.TestCase):
    def test_I_V12_STATE_02_only_write_driving_ledgers_are_named(self) -> None:
        driving = [s.name for s in iter_surfaces() if s.write_driving and s.state_class == "ledger"]
        passive = [s.name for s in iter_surfaces() if not s.write_driving]
        self.assertIn("plan_convergence_events", driving)
        self.assertTrue(passive, "the manifest declares at least one passive surface")

        lost = (driving[0], f"{driving[0]}:plans/events.jsonl", passive[0], "not-a-surface")

        self.assertEqual(
            write_driving_lost(lost),
            (driving[0], f"{driving[0]}:plans/events.jsonl"),
        )
        self.assertEqual(write_driving_lost(()), ())


class SurfaceResetIsRecorded(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_I_V12_STATE_03_a_clean_start_lands_on_the_governance_ledger(self) -> None:
        import os
        from unittest import mock

        from aria_kernel.governance_reader import read_governance_rows
        from aria_kernel.memory_gap import SURFACE_RESET_EVENT, record_surface_reset
        from aria_kernel.tool_registry import GovernanceError

        digest = "a" * 64
        with mock.patch.dict(os.environ, {"ARIA_SURFACE_RESET_ACK": "operator-2026-09-02"}):
            row = record_surface_reset(
                surface="plan_convergence_events", archived_sha256=digest,
                reason="source ledger lost during 2026-08-31 compaction",
                operator_approval_ref="ack-env:ARIA_SURFACE_RESET_ACK",
                base_dir=self.tools,
            )
        self.assertEqual(row["kind"], SURFACE_RESET_EVENT)
        self.assertEqual(row["details"]["archived_sha256"], f"sha256:{digest}")
        self.assertEqual(row["details"]["operator_approval"]["kind"], "ack-env")
        kinds = [r["kind"] for r in read_governance_rows(self.tools / "governance.jsonl")]
        self.assertIn(SURFACE_RESET_EVENT, kinds)

        # A passive surface needs no ceremony and gets none; a bare string
        # is not an approval; a malformed digest is refused.
        with self.assertRaises(GovernanceError):
            record_surface_reset(
                surface="tool_registry", archived_sha256=digest, reason="x",
                operator_approval_ref="ack-env:ARIA_SURFACE_RESET_ACK", base_dir=self.tools,
            )
        with self.assertRaises(Exception):
            record_surface_reset(
                surface="plan_convergence_events", archived_sha256=digest, reason="x",
                operator_approval_ref="i-approve", base_dir=self.tools,
            )
        with self.assertRaises(GovernanceError):
            record_surface_reset(
                surface="plan_convergence_events", archived_sha256="notahash", reason="x",
                operator_approval_ref="ack-env:ARIA_SURFACE_RESET_ACK", base_dir=self.tools,
            )

    def test_the_cli_exposes_the_ceremony_through_the_tools_dir_funnel(self) -> None:
        from aria_kernel.cli import build_parser

        args = build_parser().parse_args([
            "state", "acknowledge-surface-reset", "--surface", "plan_convergence_events",
            "--archived-sha256", "b" * 64, "--reason", "lost", "--operator-approval-ref",
            "ack-env:X", "--tools-dir", "/tmp/t",
        ])
        self.assertEqual(args.state_command, "acknowledge-surface-reset")
        self.assertEqual(args.tools_dir, "/tmp/t")


class ClaudeSettingsCarryNoSecrets(unittest.TestCase):
    def test_I_V12_DLP_01_settings_files_have_no_dlp_hits(self) -> None:
        paths = [p for p in (_REPO_ROOT / ".claude").glob("settings*.json") if p.is_file()]
        self.assertTrue(paths, ".claude/settings*.json must exist")

        findings = scan_paths_for_secrets(paths)

        self.assertEqual(
            [(f["pattern"], Path(f["path"]).name, f["line"]) for f in findings],
            [],
            "secret-shaped literals in Claude settings — remove them, never allowlist them",
        )


if __name__ == "__main__":
    unittest.main()
