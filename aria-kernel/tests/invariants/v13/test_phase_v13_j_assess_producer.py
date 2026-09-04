"""Plan 033 followup — the assurance PRODUCER, and the honesty of its mapping.

WHY: Plan 033 shipped every read side of the security lane and no write side.
`assurance.record_assurance` had zero non-test callers, so `security coverage`
folded 34 applicable cells against an empty ledger and reported all 34
NOT_TESTED forever — a lane that could describe itself but never measure itself.

Invariants:
  I-V13-ASSESS-01  a passive rule can only clear a control whose proof class is
                   STATIC_DETERMINISTIC; an ACTIVE_DUAL control is INCONCLUSIVE
                   whether the rule is clean or not, because a static check
                   cannot prove a runtime property.
  I-V13-ASSESS-02  a lead on a STATIC_DETERMINISTIC control confirms and writes
                   a matching static-proof row; the ledger and the proof agree.
  I-V13-ASSESS-03  the producer actually moves cells off NOT_TESTED, and
                   --dry-run writes nothing.
  I-V13-ASSESS-04  every control the packs produce has a declared claim type;
                   an unmapped control can never be silently cleared.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from tests.invariants.v13 import _helpers  # noqa: F401 — sys.path

from aria_kernel.security import assurance as A
from aria_kernel.security import packs as P
from aria_kernel.security import reproduction as R
from aria_kernel.security.assess import CONTROL_CLAIM_TYPES, assess
from aria_kernel.security.profile import compile_profile
from aria_kernel.tool_registry import ensure_tools_dir


def _repo(root: Path, *, rls: bool, guard: bool) -> dict:
    (root / "apps" / "farm-service" / "sql").mkdir(parents=True)
    (root / "apps" / "farm-service" / "src").mkdir(parents=True)
    (root / "package.json").write_text('{"dependencies":{"@nestjs/core":"1"}}', encoding="utf-8")
    sql = "CREATE SCHEMA t;\nCREATE TABLE farms (id int, tenant_id uuid);\n"
    if rls:
        sql += "ALTER TABLE farms ENABLE ROW LEVEL SECURITY;\nCREATE POLICY p ON farms USING (true);\n"
    (root / "apps" / "farm-service" / "sql" / "s.sql").write_text(sql, encoding="utf-8")
    ctrl = "@UseGuards(JwtGuard)\n@Post()\ncreate(){}" if guard else "@Post()\ncreate(){}"
    (root / "apps" / "farm-service" / "src" / "x.controller.ts").write_text(ctrl, encoding="utf-8")
    return compile_profile(workspace_root=root, repo_sha="sha-assess").to_row()


class AssessProducer(unittest.TestCase):
    def _run(self, *, rls: bool, guard: bool, record: bool = True):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        tools = ensure_tools_dir(root / "tools")
        repo = root / "repo"
        prof = _repo(repo, rls=rls, guard=guard)
        return assess(workspace_root=repo, profile_row=prof, base_dir=tools, record=record), tools, prof

    def _cell(self, out, control):
        return next(c for c in out["cells"] if c["control_id"] == control)

    def test_I_V13_ASSESS_01_static_clears_active_never_does(self) -> None:
        out, _tools, _prof = self._run(rls=True, guard=True)
        static_cell = self._cell(out, "multi_tenant/rls_coverage")
        active_cell = self._cell(out, "api/public_write_guard")
        self.assertEqual(static_cell["proof_class"], "STATIC_DETERMINISTIC")
        self.assertEqual(static_cell["status"], "TESTED_NO_VIOLATION")
        self.assertEqual(active_cell["proof_class"], "ACTIVE_DUAL")
        self.assertEqual(active_cell["status"], "INCONCLUSIVE",
                         "a clean passive rule must never clear a runtime claim")
        # and a lead on the active control is still only INCONCLUSIVE
        out2, _t2, _p2 = self._run(rls=True, guard=False)
        self.assertEqual(self._cell(out2, "api/public_write_guard")["status"], "INCONCLUSIVE")
        self.assertGreater(self._cell(out2, "api/public_write_guard")["lead_count"], 0)

    def test_I_V13_ASSESS_02_static_lead_confirms_with_a_proof_row(self) -> None:
        out, tools, _prof = self._run(rls=False, guard=True)
        cell = self._cell(out, "multi_tenant/rls_coverage")
        self.assertEqual(cell["status"], "VULNERABILITY_CONFIRMED")
        self.assertGreater(cell["lead_count"], 0)
        self.assertTrue(R.is_confirmed("rls_gap", "n/a", target_sha="sha-assess", base_dir=tools),
                        "a confirmed static cell must leave a matching static-proof row")
        clean, clean_tools, _p = self._run(rls=True, guard=True)
        self.assertEqual(self._cell(clean, "multi_tenant/rls_coverage")["status"], "TESTED_NO_VIOLATION")
        self.assertFalse(R.is_confirmed("rls_gap", "n/a", target_sha="sha-assess", base_dir=clean_tools))

    def test_I_V13_ASSESS_03_moves_cells_off_not_tested_and_dry_run_writes_nothing(self) -> None:
        out, tools, prof = self._run(rls=True, guard=True)
        cov = A.compute_coverage(profile_row=prof, pack_manifests=P.select_packs(prof), base_dir=tools)
        self.assertGreater(cov["total_cells"], 0)
        self.assertEqual(cov["not_tested"], 0, "the producer must leave no cell untested")
        self.assertGreater(cov["clean_required_coverage"], 0.0)
        dry, dry_tools, dry_prof = self._run(rls=True, guard=True, record=False)
        self.assertFalse(dry["recorded"])
        dry_cov = A.compute_coverage(profile_row=dry_prof, pack_manifests=P.select_packs(dry_prof), base_dir=dry_tools)
        self.assertEqual(dry_cov["not_tested"], dry_cov["total_cells"], "--dry-run must write nothing")

    def test_I_V13_ASSESS_04_every_control_has_a_declared_claim(self) -> None:
        controls = {f"{pack}/{rule.rule_id}" for pack, rules in P.PACK_RULES.items() for rule in rules}
        self.assertTrue(controls)
        missing = sorted(controls - set(CONTROL_CLAIM_TYPES))
        self.assertEqual(missing, [], f"controls with no declared claim type: {missing}")
        for control, claim in CONTROL_CLAIM_TYPES.items():
            self.assertIn(claim, R.CLAIM_TYPES, control)


if __name__ == "__main__":
    unittest.main()
