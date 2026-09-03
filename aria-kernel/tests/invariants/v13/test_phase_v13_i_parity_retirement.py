"""Plan 033 Faz 033i — semantic parity corpus, qualifying shadow cycles, agent retirement gate.

Invariants:
  I-V13-PARITY-01  the kernel's own packs classify every paired secure/vulnerable corpus
                   case correctly (critical recall 1.0, zero false positives on secure).
  I-V13-SELF-01    only a qualifying cycle (non-mock, qualifying lease, ≥1 control, passing
                   positive control, sealed evidence, zero boundary violations) counts and
                   any non-qualifying cycle resets the streak.
  I-V13-RETIRE-01  retirement readiness is an honest report: not ready without the burn-in,
                   names every remaining kernel runtime dependency on a removable agent,
                   keeps database-reviewer retained, requires operator approval, performs
                   no deletion (agent files still exist after the call).
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from tests.invariants.v13 import _helpers  # noqa: F401 — sys.path

from aria_kernel.security import parity as PR
from aria_kernel.tool_registry import ensure_tools_dir

REPO = Path(__file__).resolve().parents[4]
KERNEL = REPO / "aria-kernel" / "aria_kernel"


class Parity(unittest.TestCase):
    def test_I_V13_PARITY_01_corpus(self) -> None:
        res = PR.run_corpus()
        self.assertTrue(res["all_correct"], [c for c in res["cases"] if not c["correct"]])
        self.assertEqual(res["critical_recall"], 1.0)
        self.assertEqual(res["secure_false_positive_rate"], 0.0)
        kinds = {(c.claim_type, c.vulnerable) for c in PR.SECURITY_CORPUS}
        self.assertIn(("rls_gap", True), kinds)
        self.assertIn(("rls_gap", False), kinds)


class SelfCycles(unittest.TestCase):
    def test_I_V13_SELF_01_qualifying_streak(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            tools = ensure_tools_dir(Path(t) / "tools")
            ok = dict(mock=False, lease_qualifying=True, applicable_controls=1, positive_control_ok=True, evidence_sealed=True)
            self.assertEqual(PR.consecutive_qualifying(base_dir=tools), 0)
            for i in range(5):
                PR.record_cycle(campaign_run_id=f"c{i}", base_dir=tools, **ok)
            self.assertEqual(PR.consecutive_qualifying(base_dir=tools), 5)
            for bad in ({"mock": True}, {"lease_qualifying": False}, {"applicable_controls": 0},
                        {"positive_control_ok": False}, {"evidence_sealed": False}, {"boundary_violations": 1}):
                for i in range(2):
                    PR.record_cycle(campaign_run_id="q", base_dir=tools, **ok)
                PR.record_cycle(campaign_run_id="bad", base_dir=tools, **{**ok, **bad})
                self.assertEqual(PR.consecutive_qualifying(base_dir=tools), 0, bad)
            self.assertEqual(PR.total_boundary_violations(base_dir=tools), 1)


class Retirement(unittest.TestCase):
    def test_I_V13_RETIRE_01_honest_gate_no_deletion(self) -> None:
        agents = REPO / ".claude" / "agents"
        before = {a: (agents / f"{a}.md").exists() for a in (*PR.REMOVABLE_SECURITY_AGENTS, *PR.RETAINED_AGENTS)}
        with tempfile.TemporaryDirectory() as t:
            tools = ensure_tools_dir(Path(t) / "tools")
            report = PR.retirement_readiness(kernel_root=KERNEL, base_dir=tools)
        self.assertFalse(report["ready"])
        self.assertTrue(report["operator_approval_required"])
        self.assertIn("database-reviewer", report["retained"])
        self.assertNotIn("database-reviewer", report["removable"])
        self.assertTrue(any("consecutive_qualifying_cycles" in r for r in report["reasons"]))
        deps = {(d["module"], d["agent"]) for d in report["remaining_runtime_dependencies"]}
        self.assertIn(("agent_surface.py", "auth-security-expert"), deps)
        self.assertIn(("expert_review_gate.py", "security-reviewer"), deps)
        self.assertTrue(any("runtime dependency" in r for r in report["reasons"]))
        after = {a: (agents / f"{a}.md").exists() for a in before}
        self.assertEqual(before, after, "readiness must never delete anything")
        self.assertEqual(PR.RETIREMENT_THRESHOLD["critical_recall"], 1.0)
        self.assertEqual(PR.RETIREMENT_THRESHOLD["consecutive_qualifying_cycles"], 30)


if __name__ == "__main__":
    unittest.main()
