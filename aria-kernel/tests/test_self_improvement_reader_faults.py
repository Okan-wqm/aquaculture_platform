"""ARIA-LOW-587 — `scan_signals` absorbs only a reader's declared faults and names them.

CONFIRMED at 62c9864ae: each of the six signal families sat in
``except Exception: pass``, so a TypeError in a reader, a corrupt ledger and
a crashed doctor run all read as "nothing to improve", and the
``self_improve`` action still reported a bare ``status=ran``.

These pins hold: a defect in any reader raises out of the scan; a fault the
reader DECLARES (a corrupt or unreadable ledger, a crashed doctor organ, an
undecided deadline source) is named by family and exception class on the
scan's result, on the opener's result, on the ``self_improve`` action's
detail and governance row, and in the ``self-improve scan`` CLI output — and
every other family is still read beside it.
"""
from __future__ import annotations

import dataclasses
import io
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from aria_kernel import deadlines, self_improvement as si
from aria_kernel import doctor as doctor_module
from aria_kernel.doctor import DoctorCheck, DoctorReport
from aria_kernel.mcp_client import QUARANTINE_RELPATH
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.hermetic_git import apply_hermetic_git_env
from tests._helpers.registry_projection import project_registry_as_stored

CORRUPT_ROW = "{not json\n"


def _git_env() -> dict[str, str]:
    """The fixture's git sees neither an inherited repository binding (an
    inherited GIT_DIR once committed into the developer's repository) nor the
    machine's git configuration."""
    env = dict(os.environ)
    apply_hermetic_git_env(env)
    return env


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        project_registry_as_stored(self)
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.ws = root / "repo"
        self.ws.mkdir()
        subprocess.run(["git", "init", "-q", str(self.ws)], check=True, env=_git_env())
        self.tools = ensure_tools_dir(root / "aria-tools")
        manifest = deadlines.surface_waivers.waiver_manifest_path(self.ws)
        manifest.parent.mkdir(parents=True, exist_ok=True)
        manifest.write_text("{}", encoding="utf-8")
        # Every deadline source decided: an absent registry is UNDECIDED
        # (`registry_finding:FileNotFoundError`), which one test below pins.
        registry = self.ws.joinpath(*deadlines.REGISTRY_FINDINGS_RELPATH)
        registry.parent.mkdir(parents=True, exist_ok=True)
        registry.write_text("", encoding="utf-8")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def reported(self, *checks: DoctorCheck):
        report = DoctorReport(checks=checks, tools_dir=str(self.tools), workspace_root=str(self.ws))
        return mock.patch.object(doctor_module, "run_doctor", lambda **_kwargs: report)

    def doctor_scoped_to(self, *organs: str):
        """The real doctor over the fixture store, reporting only `organs` —
        the host organs read the machine and would add signals this file does
        not reason about."""
        real = doctor_module.run_doctor

        def scoped(**kwargs):
            report = real(**kwargs)
            return dataclasses.replace(report, checks=tuple(check for check in report.checks if check.name in organs))

        return mock.patch.object(doctor_module, "run_doctor", scoped)

    def corrupt(self, *relpath: str) -> None:
        path = self.tools.joinpath(*relpath)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(CORRUPT_ROW, encoding="utf-8")

    def governance(self, event: str) -> list[dict]:
        from aria_kernel.ledger import load_jsonl

        return [row["details"] for row in load_jsonl(self.tools / "governance.jsonl") if row.get("kind") == event]


class ADefectRaises(_Store):
    """A programming error in a reader is a kernel defect: it raises out of the
    scan instead of reading as a family with nothing to improve."""

    READERS = {
        "capability_gap": "aria_kernel.capability_gap.latest_capability_gaps",
        "funnel_stall": "aria_kernel.knowledge_graph.rank_pressure_sources",
        "delivery_slo_gap": "aria_kernel.delivery_closure.compute_delivery_closure",
        "mcp_quarantine": "aria_kernel.mcp_client.quarantined_servers",
        "deadline_due": "aria_kernel.deadlines.read_deadlines",
    }

    def test_a_type_error_in_any_reader_propagates(self) -> None:
        for family, target in self.READERS.items():
            with self.subTest(family=family), self.doctor_scoped_to(), \
                    mock.patch(target, side_effect=TypeError(f"{family}_reader_defect")):
                with self.assertRaises(TypeError) as raised:
                    si.scan_signals(base_dir=self.tools, workspace_root=self.ws)
                self.assertEqual(str(raised.exception), f"{family}_reader_defect")

    def test_a_crashed_doctor_run_propagates(self) -> None:
        """The gateway daemon's slot and the CLI run the doctor inside the scan."""
        with mock.patch.object(doctor_module, "run_doctor", side_effect=RuntimeError("doctor_crashed")):
            with self.assertRaises(RuntimeError):
                si.scan_signals(base_dir=self.tools, workspace_root=self.ws)


class ADeclaredFaultIsNamed(_Store):
    QUEUE = DoctorCheck("queue", "fail", "human_required_open:3")

    def test_corrupt_ledgers_are_named_and_every_other_family_is_still_read(self) -> None:
        self.corrupt("capability-gaps", "gaps.jsonl")
        self.corrupt(*QUARANTINE_RELPATH)
        with self.reported(self.QUEUE):
            scan = si.scan_signals(base_dir=self.tools, workspace_root=self.ws)

        self.assertEqual([u.to_dict() for u in scan.unreadable], [
            {"family": "capability_gap", "fault": "LedgerIntegrityError"},
            {"family": "mcp_quarantine", "fault": "LedgerIntegrityError"},
        ])
        self.assertEqual([(s.kind, s.key) for s in scan.signals], [("doctor_fail", "queue")])

    def test_a_clean_store_has_nothing_unreadable(self) -> None:
        with self.reported(self.QUEUE):
            scan = si.scan_signals(base_dir=self.tools, workspace_root=self.ws)
        self.assertEqual(scan.unreadable, ())

    def test_a_crashed_doctor_organ_is_named_by_organ(self) -> None:
        """The real doctor guards each probe (`_guarded`): a probe that raised
        is a WARN, so its FAIL — the signal — could not be judged."""
        with self.doctor_scoped_to("queue", "breakers"), \
                mock.patch.object(doctor_module, "_check_queue", side_effect=RuntimeError("probe_crashed")):
            scan = si.scan_signals(base_dir=self.tools, workspace_root=self.ws)
        self.assertEqual([u.to_dict() for u in scan.unreadable], [{"family": "doctor_organ", "fault": "queue:RuntimeError"}])

    def test_an_undecided_deadline_source_is_named(self) -> None:
        self.ws.joinpath(*deadlines.REGISTRY_FINDINGS_RELPATH).unlink()
        with self.reported():
            scan = si.scan_signals(base_dir=self.tools, workspace_root=self.ws)
        self.assertEqual([u.to_dict() for u in scan.unreadable],
                         [{"family": "deadline_due", "fault": "registry_finding:FileNotFoundError"}])

    def test_a_family_outside_the_vocabulary_cannot_be_named(self) -> None:
        from aria_kernel.tool_registry import GovernanceError

        with self.assertRaises(GovernanceError) as refused:
            si.UnreadableSource("registry", "OSError")
        self.assertEqual(str(refused.exception), "scan_family_unknown:registry")


class TheFaultReachesTheOperatorSurfaces(_Store):
    def test_the_opener_carries_the_unreadable_families(self) -> None:
        self.corrupt("capability-gaps", "gaps.jsonl")
        with self.reported(ADeclaredFaultIsNamed.QUEUE):
            opening = si.open_self_improvement_missions(base_dir=self.tools, workspace_root=self.ws, max_new=3)
        self.assertEqual([(o["signal"], o["key"]) for o in opening.opened], [("doctor_fail", "queue")])
        self.assertEqual([u.to_dict() for u in opening.unreadable], [{"family": "capability_gap", "fault": "LedgerIntegrityError"}])

    def test_the_self_improve_action_names_the_family_on_its_detail_and_governance_row(self) -> None:
        from aria_kernel.gateway import scheduler

        self.corrupt(*QUARANTINE_RELPATH)
        with self.reported(ADeclaredFaultIsNamed.QUEUE):
            result = scheduler.run_action("self_improve", base_dir=self.tools, workspace_root=self.ws)

        self.assertEqual(result["detail"]["unreadable"], ["mcp_quarantine:LedgerIntegrityError"])
        [row] = self.governance("gateway_action_ran")
        self.assertEqual(row["unreadable"], ["mcp_quarantine:LedgerIntegrityError"])

    def test_the_scan_cli_prints_the_unreadable_families(self) -> None:
        from aria_kernel.cli import main

        self.corrupt("capability-gaps", "gaps.jsonl")
        with self.reported(ADeclaredFaultIsNamed.QUEUE), redirect_stdout(io.StringIO()) as stdout:
            rc = main(["--tools-dir", str(self.tools), "self-improve", "scan", "--workspace-root", str(self.ws)])
        self.assertEqual(rc, 0)
        printed = json.loads(stdout.getvalue())
        self.assertEqual(printed["unreadable"], [{"family": "capability_gap", "fault": "LedgerIntegrityError"}])
        self.assertEqual([(s["kind"], s["key"]) for s in printed["signals"]], [("doctor_fail", "queue")])


if __name__ == "__main__":
    unittest.main()
