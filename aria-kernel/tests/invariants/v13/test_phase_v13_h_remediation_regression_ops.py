"""Plan 033 Faz 033h — autonomous remediation, permanent regressions, doctor + fitness.

Invariants:
  I-V13-REGRESS-01  a regression recipe must be minimized+synthetic+deterministic with a
                    closed scope; a run with a failed positive control or an errored
                    verdict is HARNESS_ERROR (never a pass); a re-observed violation is
                    REGRESSED; all_passed is false on an empty set.
  I-V13-REMEDIATE-01 a remediation opens only on a ledger-confirmed finding; the flow is
                    ordered; fix verification needs the SAME recipe dual-GREEN with two
                    independent executors/labs and passing positive controls; regression
                    lock needs a recipe bound to the finding; READY_FOR_MERGE needs a
                    ready readiness proof; the fold replays the state.
  I-V13-OPS-01      doctor fails on quarantined packs / coverage gaps / unverified cleanup /
                    open CRITICAL-HIGH and is ok otherwise.
  I-V13-FITNESS-01  the fitness instrument is unknown with nothing to measure, red on any
                    gap or confirmed vulnerability, green only on full fresh coverage.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from tests.invariants.v13 import _helpers  # noqa: F401 — sys.path

from aria_kernel.security import assurance as A
from aria_kernel.security import ops
from aria_kernel.security import packs
from aria_kernel.security import readiness as RD
from aria_kernel.security import regression as REG
from aria_kernel.security import remediation as REM
from aria_kernel.security import reproduction as R
from aria_kernel.security.profile import compile_profile
from aria_kernel.tool_registry import ensure_tools_dir

RD_DIGEST = "sha256:" + "r" * 64


def _run(eid, lease, verdict, digest=RD_DIGEST, pc=True):
    return R.ExecutorRun(executor_id=eid, lease_id=lease, recipe_digest=digest, verdict=verdict,
                         positive_control_ok=pc, evidence_manifest_digest="sha256:" + "a" * 64)


def _repo(root: Path) -> dict:
    (root / "apps" / "farm-service" / "sql").mkdir(parents=True)
    (root / "apps" / "farm-service" / "src").mkdir(parents=True)
    (root / "package.json").write_text('{"dependencies":{"@nestjs/core":"1"}}', encoding="utf-8")
    (root / "apps" / "farm-service" / "sql" / "s.sql").write_text(
        "CREATE SCHEMA t;\nALTER TABLE x ENABLE ROW LEVEL SECURITY;\nCREATE POLICY p ON x USING (true);", encoding="utf-8")
    (root / "apps" / "farm-service" / "src" / "x.controller.ts").write_text("@Get()\nlist(){}", encoding="utf-8")
    return compile_profile(workspace_root=root, repo_sha="sha1").to_row()


def _cover(prof, man, tools, status="TESTED_NO_VIOLATION"):
    for cell in A.applicable_cells(profile_row=prof, pack_manifests=man):
        A.record_assurance(asset_id=cell.asset_id, control_id=cell.control_id, status=status,
                           profile_digest=prof["profile_digest"], pack_digest="d", base_dir=tools)


def _good_regression():
    return REG.RegressionRecipe(recipe_id="rg1", finding_id="F1", claim_type="idor", recipe_digest=RD_DIGEST,
                                minimized=True, synthetic=True, deterministic=True, scopes=("impacted_pr", "release"))


class Regression(unittest.TestCase):
    def test_I_V13_REGRESS_01_honest_runs(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            tools = ensure_tools_dir(Path(t) / "tools")
            for bad in (REG.RegressionRecipe("x", "F", "idor", RD_DIGEST, False, True, True, ("release",)),
                        REG.RegressionRecipe("x", "F", "idor", RD_DIGEST, True, True, True, ()),
                        REG.RegressionRecipe("x", "F", "idor", RD_DIGEST, True, True, True, ("nightly",)),
                        REG.RegressionRecipe("x", "F", "idor", "md5:x", True, True, True, ("release",)),
                        REG.RegressionRecipe("x", "F", "telepathy", RD_DIGEST, True, True, True, ("release",))):
                with self.assertRaises(REG.RegressionError):
                    REG.register_regression(bad, base_dir=tools)
            self.assertFalse(REG.all_passed([]))
            REG.register_regression(_good_regression(), base_dir=tools)
            self.assertEqual(len(REG.list_regressions(scope="release", base_dir=tools)), 1)
            self.assertEqual(len(REG.list_regressions(scope="impacted_pr", base_dir=tools)), 1)
            ok = REG.run_regressions(scope="release", runner=lambda r: {"verdict": "NO_VIOLATION_OBSERVED", "positive_control_ok": True}, base_dir=tools)
            self.assertTrue(REG.all_passed(ok))
            regressed = REG.run_regressions(scope="release", runner=lambda r: {"verdict": "VIOLATION_OBSERVED", "positive_control_ok": True}, base_dir=tools)
            self.assertEqual(regressed[0].result, "REGRESSED")
            for res in ({"verdict": "NO_VIOLATION_OBSERVED", "positive_control_ok": False},
                        {"verdict": "HARNESS_ERROR", "positive_control_ok": True},
                        {"verdict": "TARGET_UNAVAILABLE", "positive_control_ok": True}, {}):
                out = REG.run_regressions(scope="release", runner=lambda r, res=res: res, base_dir=tools)
                self.assertEqual(out[0].result, "HARNESS_ERROR", res)
                self.assertFalse(REG.all_passed(out))


class Remediation(unittest.TestCase):
    def test_I_V13_REMEDIATE_01_ordered_proven_flow(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            tools = ensure_tools_dir(Path(t) / "tools")
            prof = _repo(Path(t) / "repo")
            man = packs.select_packs(prof)
            with self.assertRaisesRegex(REM.RemediationError, "not confirmed"):
                REM.open_remediation(finding_id="F1", claim_type="idor", recipe_digest=RD_DIGEST, base_dir=tools)
            R.dual_reproduce(claim_type="idor", recipe_digest=RD_DIGEST, primary=_run("e1", "l1", "VIOLATION_OBSERVED"),
                             replay=_run("e2", "l2", "VIOLATION_OBSERVED"), base_dir=tools)
            rem = REM.open_remediation(finding_id="F1", claim_type="idor", recipe_digest=RD_DIGEST, base_dir=tools)
            with self.assertRaises(REM.RemediationError):
                REM.propose_fix(rem, fix_head_sha="x", base_dir=tools)  # must plan first
            REM.plan_hardening(rem, mission_id="m1", base_dir=tools)
            REM.propose_fix(rem, fix_head_sha="sha-fix", base_dir=tools)
            green = lambda e, l: _run(e, l, "NO_VIOLATION_OBSERVED")  # noqa: E731
            for kw in (dict(primary=_run("e1", "l1", "VIOLATION_OBSERVED"), replay=green("e2", "l2")),
                       dict(primary=green("e1", "l1"), replay=green("e1", "l2")),
                       dict(primary=green("e1", "l1"), replay=green("e2", "l1")),
                       dict(primary=_run("e1", "l1", "NO_VIOLATION_OBSERVED", digest="sha256:" + "9" * 64), replay=green("e2", "l2")),
                       dict(primary=_run("e1", "l1", "NO_VIOLATION_OBSERVED", pc=False), replay=green("e2", "l2"))):
                with self.assertRaises(REM.RemediationError):
                    REM.verify_fix_dual_green(rem, base_dir=tools, **kw)
            self.assertEqual(rem.state, "FIX_PROPOSED")
            REM.verify_fix_dual_green(rem, primary=green("e1", "l1"), replay=green("e2", "l2"), base_dir=tools)
            with self.assertRaises(REM.RemediationError):
                REM.lock_regression(rem, REG.RegressionRecipe("rg9", "F-other", "idor", RD_DIGEST, True, True, True, ("release",)), base_dir=tools)
            REM.lock_regression(rem, _good_regression(), base_dir=tools)
            not_ready = RD.compute_readiness(head_sha="sha-fix", impacted_controls=(), profile_row=prof, pack_manifests=man, base_dir=tools)
            with self.assertRaisesRegex(REM.RemediationError, "not ready"):
                REM.mark_ready(rem, not_ready, base_dir=tools)
            _cover(prof, man, tools)
            ready = RD.compute_readiness(head_sha="sha-fix", impacted_controls=(), profile_row=prof, pack_manifests=man, base_dir=tools)
            REM.mark_ready(rem, ready, base_dir=tools)
            self.assertEqual(rem.state, "READY_FOR_MERGE")
            folded = REM.fold("F1", base_dir=tools)
            self.assertEqual((folded.state, folded.fix_head_sha, folded.mission_id), ("READY_FOR_MERGE", "sha-fix", "m1"))
            self.assertEqual(REM.TRANSITIONS["READY_FOR_MERGE"], (), "the flow never merges; merge_authority does")

    def test_I_V13_REMEDIATE_02_harden_stops_at_first_refusing_gate(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            tools = ensure_tools_dir(Path(t) / "tools")
            prof = _repo(Path(t) / "repo")
            man = packs.select_packs(prof)
            R.dual_reproduce(claim_type="idor", recipe_digest=RD_DIGEST, primary=_run("e1", "l1", "VIOLATION_OBSERVED"),
                             replay=_run("e2", "l2", "VIOLATION_OBSERVED"), base_dir=tools)
            rem = REM.open_remediation(finding_id="F1", claim_type="idor", recipe_digest=RD_DIGEST, base_dir=tools)
            green = lambda e, l: _run(e, l, "NO_VIOLATION_OBSERVED")  # noqa: E731
            not_ready = RD.compute_readiness(head_sha="sha-fix", impacted_controls=(), profile_row=prof, pack_manifests=man, base_dir=tools)
            with self.assertRaises(REM.RemediationError):
                REM.harden(rem, fix_head_sha="sha-fix", primary=green("e1", "l1"), replay=green("e2", "l2"),
                           regression_recipe=_good_regression(), readiness_proof=not_ready, base_dir=tools)  # not planned yet
            REM.plan_hardening(rem, mission_id="m1", base_dir=tools)
            # fix that is NOT dual-green: harden stops at FIX_PROPOSED, nothing rounded up
            with self.assertRaises(REM.RemediationError):
                REM.harden(rem, fix_head_sha="sha-fix", primary=_run("e1", "l1", "VIOLATION_OBSERVED"), replay=green("e2", "l2"),
                           regression_recipe=_good_regression(), readiness_proof=not_ready, base_dir=tools)
            self.assertEqual(rem.state, "FIX_PROPOSED")
            # dual-green + locked regression but readiness not ready: stops at REGRESSION_LOCKED
            REM.verify_fix_dual_green(rem, primary=green("e1", "l1"), replay=green("e2", "l2"), base_dir=tools)
            REM.lock_regression(rem, _good_regression(), base_dir=tools)
            with self.assertRaises(REM.RemediationError):
                REM.mark_ready(rem, not_ready, base_dir=tools)
            self.assertEqual(rem.state, "REGRESSION_LOCKED")
            # a fresh remediation driven end-to-end by harden() with full coverage reaches READY_FOR_MERGE
            _cover(prof, man, tools)
            ready = RD.compute_readiness(head_sha="sha-fix", impacted_controls=(), profile_row=prof, pack_manifests=man, base_dir=tools)
            rem2 = REM.open_remediation(finding_id="F2", claim_type="idor", recipe_digest=RD_DIGEST, base_dir=tools)
            REM.plan_hardening(rem2, mission_id="m2", base_dir=tools)
            recipe2 = REG.RegressionRecipe(recipe_id="rg2", finding_id="F2", claim_type="idor", recipe_digest=RD_DIGEST,
                                           minimized=True, synthetic=True, deterministic=True, scopes=("release",))
            REM.harden(rem2, fix_head_sha="sha-fix", primary=green("e1", "l1"), replay=green("e2", "l2"),
                       regression_recipe=recipe2, readiness_proof=ready, base_dir=tools)
            self.assertEqual(rem2.state, "READY_FOR_MERGE")


class Ops(unittest.TestCase):
    def test_I_V13_OPS_01_doctor_and_I_V13_FITNESS_01_instrument(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            tools = ensure_tools_dir(Path(t) / "tools")
            prof = _repo(Path(t) / "repo")
            man = packs.select_packs(prof)
            gaps = {c.name: c.status for c in ops.security_doctor(profile_row=prof, pack_manifests=man, base_dir=tools)}
            self.assertEqual(gaps["security.coverage"], "fail")
            self.assertEqual(ops.security_fitness_verdict(profile_row=prof, pack_manifests=man, base_dir=tools)[0], "red")
            self.assertEqual(ops.security_fitness_verdict(profile_row={"claims": [], "profile_digest": "x"}, pack_manifests=[], base_dir=tools)[0], "unknown")
            _cover(prof, man, tools)
            ok = {c.name: c.status for c in ops.security_doctor(profile_row=prof, pack_manifests=man, base_dir=tools)}
            self.assertEqual(set(ok.values()), {"ok"})
            self.assertEqual(ops.security_fitness_verdict(profile_row=prof, pack_manifests=man, base_dir=tools)[0], "green")
            bad = {c.name: c.status for c in ops.security_doctor(profile_row=prof, pack_manifests=man, open_critical_or_high=1,
                                                                 quarantined_packs=("api",), unverified_cleanups=("scr-1",), base_dir=tools)}
            self.assertEqual(bad["security.packs_quarantined"], "fail")
            self.assertEqual(bad["security.cleanup"], "fail")
            self.assertEqual(bad["security.open_findings"], "fail")
            _cover(prof, man, tools, status="VULNERABILITY_CONFIRMED")
            self.assertEqual(ops.security_fitness_verdict(profile_row=prof, pack_manifests=man, base_dir=tools)[0], "red")


if __name__ == "__main__":
    unittest.main()
