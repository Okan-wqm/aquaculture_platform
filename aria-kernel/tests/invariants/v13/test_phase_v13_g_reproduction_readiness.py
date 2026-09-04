"""Plan 033 Faz 033g — dual-executor reproduction + SecurityReadinessProof.

Invariants:
  I-V13-REPRO-01   ACTIVE_DUAL confirmation needs two independent executors, two
                   separate labs, the SAME sealed recipe digest and both positive
                   controls passing; one-green / harness-error / shared principal / shared
                   lab / recipe mismatch never confirm. Static claims use a repo prover.
  I-V13-READINESS-01 the proof is recomputed from ledgers (a claimed closure counts only
                   if the reproduction ledger confirms the pre-fix red); it is not ready
                   with a coverage gap, an unclosed finding, an open CRITICAL/HIGH, or no
                   required cells; zero-tolerance controls are always required.
  I-V13-MERGE-01   the proof is source-bound: its digest changes with the head SHA and
                   the coverage/closure state.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from tests.invariants.v13 import _helpers  # noqa: F401 — sys.path

from aria_kernel.security import assurance as A
from aria_kernel.security import packs
from aria_kernel.security import readiness as RD
from aria_kernel.security import reproduction as R
from aria_kernel.security.profile import compile_profile
from aria_kernel.tool_registry import ensure_tools_dir

RD_DIGEST = "sha256:" + "r" * 64


def _run(eid, lease, digest=RD_DIGEST, verdict="VIOLATION_OBSERVED", pc=True):
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


class Reproduction(unittest.TestCase):
    def test_I_V13_REPRO_01_dual_and_static(self) -> None:
        self.assertEqual(R.proof_class_for("idor"), "ACTIVE_DUAL")
        self.assertEqual(R.proof_class_for("secret_exposure"), "STATIC_DETERMINISTIC")
        self.assertEqual(set(R.PROOF_CLASSES), {"STATIC_DETERMINISTIC", "ACTIVE_DUAL", "HUMAN_REQUIRED"})
        with tempfile.TemporaryDirectory() as t:
            tools = ensure_tools_dir(Path(t) / "tools")
            self.assertEqual(R.dual_reproduce(claim_type="idor", recipe_digest=RD_DIGEST, primary=_run("ex1", "l1"), replay=_run("ex2", "l2"), base_dir=tools)["outcome"], "CONFIRMED")
            self.assertTrue(R.is_confirmed("idor", RD_DIGEST, base_dir=tools))
            self.assertEqual(R.dual_reproduce(claim_type="authz_bypass", recipe_digest=RD_DIGEST, primary=_run("ex1", "l1"), replay=_run("ex2", "l2", verdict="NO_VIOLATION_OBSERVED"), base_dir=tools)["outcome"], "NOT_CONFIRMED")
            self.assertEqual(R.dual_reproduce(claim_type="authz_bypass", recipe_digest=RD_DIGEST, primary=_run("ex1", "l1", pc=False), replay=_run("ex2", "l2"), base_dir=tools)["outcome"], "HARNESS_ERROR")
            self.assertEqual(R.dual_reproduce(claim_type="idor", recipe_digest=RD_DIGEST, primary=_run("ex1", "l1"), replay=_run("ex2", "l2", verdict="TARGET_UNAVAILABLE"), base_dir=tools)["outcome"], "HARNESS_ERROR")
            for kw in (dict(primary=_run("ex1", "l1"), replay=_run("ex1", "l2")),
                       dict(primary=_run("ex1", "l1"), replay=_run("ex2", "l1")),
                       dict(primary=_run("ex1", "l1", digest="sha256:" + "9" * 64), replay=_run("ex2", "l2"))):
                with self.assertRaises(R.ReproductionError):
                    R.dual_reproduce(claim_type="idor", recipe_digest=RD_DIGEST, base_dir=tools, **kw)
            with self.assertRaises(R.ReproductionError):
                R.static_prove(claim_type="idor", prover_id="p", violated=True, evidence_digest="sha256:e", target_sha="s", base_dir=tools)
            R.static_prove(claim_type="secret_exposure", prover_id="p", violated=True, evidence_digest="sha256:" + "e" * 64, target_sha="sha1", base_dir=tools)
            self.assertTrue(R.is_confirmed("secret_exposure", "n/a", target_sha="sha1", base_dir=tools))
            self.assertFalse(R.is_confirmed("secret_exposure", "n/a", target_sha="other", base_dir=tools))


class Readiness(unittest.TestCase):
    def _covered(self, prof, man, tools, status="TESTED_NO_VIOLATION"):
        for cell in A.applicable_cells(profile_row=prof, pack_manifests=man):
            A.record_assurance(asset_id=cell.asset_id, control_id=cell.control_id, status=status,
                               profile_digest=prof["profile_digest"], pack_digest="d", base_dir=tools)

    def test_I_V13_READINESS_01_recomputed_and_gated(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            tools = ensure_tools_dir(Path(t) / "tools")
            prof = _repo(Path(t) / "repo")
            man = packs.select_packs(prof)
            empty = RD.compute_readiness(head_sha="sha1", impacted_controls=("api/public_write_guard",),
                                         profile_row=prof, pack_manifests=man, base_dir=tools)
            self.assertFalse(empty.ready)
            self.assertIn("multi_tenant/rls_coverage", empty.required_controls)
            self.assertTrue(empty.coverage_gaps)
            self._covered(prof, man, tools)
            # a claimed closure whose pre-fix red is NOT in the reproduction ledger is not counted closed
            claimed = RD.FindingClosure(finding_id="F1", claim_type="idor", recipe_digest=RD_DIGEST,
                                        pre_fix_confirmed=True, post_fix_clean=True, head_sha="sha1")
            not_repro = RD.compute_readiness(head_sha="sha1", impacted_controls=("api/public_write_guard",),
                                             profile_row=prof, pack_manifests=man, closures=(claimed,), base_dir=tools)
            self.assertIn("F1", not_repro.unclosed_findings)
            self.assertFalse(not_repro.ready)
            # now actually confirm the pre-fix red in the ledger
            R.dual_reproduce(claim_type="idor", recipe_digest=RD_DIGEST, primary=_run("ex1", "l1"), replay=_run("ex2", "l2"), base_dir=tools)
            ready = RD.compute_readiness(head_sha="sha1", impacted_controls=("api/public_write_guard",),
                                         profile_row=prof, pack_manifests=man, closures=(claimed,), base_dir=tools)
            self.assertEqual(ready.unclosed_findings, [])
            self.assertTrue(ready.ready, ready.to_row())
            # an open CRITICAL/HIGH blocks readiness even with full coverage
            blocked = RD.compute_readiness(head_sha="sha1", impacted_controls=("api/public_write_guard",),
                                           profile_row=prof, pack_manifests=man, closures=(claimed,),
                                           open_critical_or_high=1, base_dir=tools)
            self.assertFalse(blocked.ready)
            # a confirmed vulnerability in coverage blocks readiness
            self._covered(prof, man, tools, status="VULNERABILITY_CONFIRMED")
            vuln = RD.compute_readiness(head_sha="sha1", impacted_controls=("api/public_write_guard",),
                                        profile_row=prof, pack_manifests=man, base_dir=tools)
            self.assertFalse(vuln.ready)

    def test_I_V13_MERGE_01_source_bound_digest(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            tools = ensure_tools_dir(Path(t) / "tools")
            prof = _repo(Path(t) / "repo")
            man = packs.select_packs(prof)
            self._covered(prof, man, tools)
            a = RD.compute_readiness(head_sha="sha-A", impacted_controls=(), profile_row=prof, pack_manifests=man, base_dir=tools)
            b = RD.compute_readiness(head_sha="sha-B", impacted_controls=(), profile_row=prof, pack_manifests=man, base_dir=tools)
            self.assertNotEqual(a.digest(), b.digest(), "the proof digest must be bound to the head SHA")
            self.assertEqual(a.to_row()["head_sha"], "sha-A")


if __name__ == "__main__":
    unittest.main()
