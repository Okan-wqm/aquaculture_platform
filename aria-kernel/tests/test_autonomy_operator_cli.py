"""Operator CLI for the autonomy ladder + L3 approval (ORPHAN-MEDIUM-263, slice 6b).

Wires the burn-in→ladder bridge (slice 6a), the unlock-ladder status view, and
the L3 two-stage policy approval to operator-invocable CLI commands.
"""
from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

_KERNEL = Path(__file__).resolve().parents[1]
if str(_KERNEL) not in sys.path:
    sys.path.insert(0, str(_KERNEL))

from aria_kernel import cli  # noqa: E402
from tests._helpers.operator_acts import github_operator_acts  # noqa: E402

_SHA = "a" * 40
_PH = "sha256:" + "b" * 64
_FUTURE = "2030-01-01T00:00:00Z"


def _run(argv: list[str]) -> tuple[int, dict]:
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = cli.main(argv)
    out = buf.getvalue().strip()
    return rc, (json.loads(out) if out else {})


class BurnInAcceptCliTests(unittest.TestCase):
    def test_accept_passed_report_then_status_reflects_it(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            tools = str(Path(td) / "tools")
            report = Path(td) / "report.json"
            report.write_text(json.dumps({
                "acceptance_verdict": "passed",
                "cycles": [{"cycle_id": f"obs-{i}", "valid_cycle": True} for i in range(3)],
            }), encoding="utf-8")
            rc, out = _run(["--tools-dir", tools, "autonomy", "burn-in", "accept",
                            "--report", str(report), "--mode", "real"])
            self.assertEqual(rc, 0)
            self.assertEqual(out["recorded"], 3)
            rc2, status = _run(["--tools-dir", tools, "autonomy", "unlock", "status"])
            self.assertEqual(rc2, 0)
            # status reports the whole ladder (no operator-chosen lane)
            self.assertEqual(status["lanes"]["L1"]["counts"]["observe_successes"], 3)
            self.assertFalse(status["lanes"]["L1"]["unlocked"])  # 3 < 30
            self.assertIn("L3", status["lanes"])

    def test_accept_failed_report_records_nothing_nonzero(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            tools = str(Path(td) / "tools")
            report = Path(td) / "report.json"
            report.write_text(json.dumps({"acceptance_verdict": "failed", "cycles": []}), encoding="utf-8")
            rc, out = _run(["--tools-dir", tools, "autonomy", "burn-in", "accept", "--report", str(report)])
            self.assertEqual(rc, 2)  # fail-closed signal
            self.assertEqual(out["recorded"], 0)


class PolicyApprovalCliTests(unittest.TestCase):
    """Each stage is an operator's GitHub act (ARIA-CRITICAL-216); the actor
    is the login that posted it, so two stages need two operator accounts."""

    def setUp(self) -> None:
        acts = github_operator_acts(operators=("Okan-wqm", "second-operator"))
        self.github = acts.__enter__()
        self.addCleanup(acts.__exit__, None, None, None)

    def _record(self, tools, stage, login, pr="700"):
        ref = self.github.approve(
            "l3_policy_approval", {"pr": pr, "head_sha": _SHA, "stage": stage}, login=login,
        )
        return _run(["--tools-dir", tools, "policy-approval", "record",
                     "--approval-id", "A1", "--stage", stage, "--operator-approval-ref", ref,
                     "--pr-number", pr, "--head-sha", _SHA, "--policy-hash", _PH,
                     "--expires-at", _FUTURE])

    def test_two_distinct_operators_verify_valid(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            tools = str(Path(td) / "tools")
            self.assertEqual(self._record(tools, "risk_owner", "Okan-wqm")[0], 0)
            self.assertEqual(self._record(tools, "exception_owner", "second-operator")[0], 0)
            rc, out = _run(["--tools-dir", tools, "policy-approval", "verify",
                            "--pr-number", "700", "--head-sha", _SHA, "--policy-hash", _PH])
            self.assertEqual(rc, 0)
            self.assertTrue(out["valid"])

    def test_same_operator_both_stages_fails_separation_of_duties(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            tools = str(Path(td) / "tools")
            self._record(tools, "risk_owner", "Okan-wqm")
            self._record(tools, "exception_owner", "Okan-wqm")
            rc, out = _run(["--tools-dir", tools, "policy-approval", "verify",
                            "--pr-number", "700", "--head-sha", _SHA, "--policy-hash", _PH])
            self.assertEqual(rc, 2)
            self.assertFalse(out["valid"])
            self.assertIn("separation_of_duties", out["error"])

    def test_single_stage_verify_fails(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            tools = str(Path(td) / "tools")
            self._record(tools, "risk_owner", "Okan-wqm")
            rc, out = _run(["--tools-dir", tools, "policy-approval", "verify",
                            "--pr-number", "700", "--head-sha", _SHA, "--policy-hash", _PH])
            self.assertEqual(rc, 2)
            self.assertFalse(out["valid"])

    def test_a_recorded_reference_is_not_a_stage(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            tools = str(Path(td) / "tools")
            rc, out = _run(["--tools-dir", tools, "policy-approval", "record",
                            "--approval-id", "A1", "--stage", "risk_owner",
                            "--operator-approval-ref", "gov:anything",
                            "--pr-number", "700", "--head-sha", _SHA, "--policy-hash", _PH,
                            "--expires-at", _FUTURE])
            self.assertEqual(rc, 2)
            self.assertFalse(out["recorded"])
            self.assertIn("gh:<owner>/<repo>#<number>", out["error"])

    def test_invalid_head_sha_clean_error(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            tools = str(Path(td) / "tools")
            rc, out = _run(["--tools-dir", tools, "policy-approval", "record",
                            "--approval-id", "A1", "--stage", "risk_owner",
                            "--operator-approval-ref", "gh:Okan-wqm/aquaculture_platform#1/comment/1",
                            "--pr-number", "1", "--head-sha", "short", "--policy-hash", _PH,
                            "--expires-at", _FUTURE])
            self.assertEqual(rc, 2)
            self.assertFalse(out["recorded"])
            self.assertIn("head_sha", out["error"])


if __name__ == "__main__":
    unittest.main()
