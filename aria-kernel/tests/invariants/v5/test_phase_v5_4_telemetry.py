"""Plan ARIA-V5 §3f V5.4 Phase 5.3 — reflection telemetry v2 invariants.

Three invariants lock the architectural contract between
``run_reflection`` schema v2 and the autonomy orchestrator's Gate A
+ Gate B verdicts:

  * I-V5.4-01 — reflection v2 row carries ``schema_version: 2`` AND
    the ``convergence`` + ``pedagogy`` sub-objects with correct
    types AND well-formed pre_impl + post_impl structure when
    orchestrator supplies verdicts
  * I-V5.4-02 — direct CLI path (``aria-kernel cycle run`` →
    ``run_enterprise_cycle`` → ``run_reflection`` with no
    convergence/review kwargs) emits ``convergence: null`` AND
    ``pedagogy: null`` — legitimately-skipped sentinel preserved
  * I-V5.4-03 — daily report renders the "## Convergence" + (when
    pedagogy supplied) "## Pedagogy" sections; gated on
    ``schema_version >= 2`` AND non-null sub-objects

Operator anchor (Plan ARIA-V5 §3f):
  The daily report must cover the full cycle — Gate A convergence +
  Gate B review + auto-merge outcome — so operators see WHY a cycle
  did or did not merge in ONE place.
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))


def _seed_minimal_cycle_state(tools_root: Path, cycle_id: str) -> None:
    """Same minimum-viable cycle state seed used by V3.2/V3.3 helpers."""
    (tools_root / "memory").mkdir(parents=True, exist_ok=True)
    (tools_root / "memory" / "beliefs.jsonl").touch()
    (tools_root / "auto-merge-decisions.jsonl").touch()
    discovery_dir = tools_root / "discovery" / cycle_id
    discovery_dir.mkdir(parents=True, exist_ok=True)
    (discovery_dir / "COMPLETION_PROOF.json").write_text(
        json.dumps({
            "schema_version": 1, "cycle_id": cycle_id, "complete": True,
            "file_counts": {
                "allowed": 0, "fated": 0, "generated": 0,
                "git_tracked": 0, "unknown": 0, "working_tree": 0,
            },
            "tracked_file_count": 0, "fated_file_count": 0,
            "unknown_count": 0, "missing_fates": [],
            "snapshot_hash": "sha256:" + ("0" * 64),
            "base_commit_sha": "0" * 40,
            "snapshot_mode": "committed",
            "dirty_snapshot": False, "dirty_path_count": 0,
        }),
        encoding="utf-8",
    )


class PhaseV5_4Telemetry(unittest.TestCase):
    def setUp(self) -> None:
        from aria_kernel.runtime_profile import set_profile
        from tests.invariants.v3_3._helpers import clear_aria_tools_env

        self.tmp = Path(tempfile.mkdtemp(prefix="aria-v5_4-"))
        self.base = self.tmp / "aria-tools"
        self._env_snapshot = clear_aria_tools_env()
        set_profile(
            "standard", operator_approval_ref="v5_4-test", base_dir=self.base,
        )
        _seed_minimal_cycle_state(self.base, "cycle-v5_4")

    def tearDown(self) -> None:
        from tests.invariants.v3_3._helpers import restore_aria_tools_env
        restore_aria_tools_env(self._env_snapshot)
        shutil.rmtree(self.tmp, ignore_errors=True)

    # I-V5.4-01 — reflection v2 row carries convergence + pedagogy.
    def test_i_v5_4_01_reflection_v2_carries_convergence_and_pedagogy(
        self,
    ) -> None:
        """Plan ARIA-V5 §3f v2 — orchestrator-path reflection MUST
        emit schema_version=2 with well-formed convergence (both
        pre_impl + post_impl) and pedagogy sub-objects.
        """
        from aria_kernel.reflection import run_reflection

        convergence_result = {
            "plan_id": "plan-v5_4-01",
            "converged_plan": {},
            "rounds_count": 2,
            "arbiter_verdict": "converged",
            "unsatisfied_items": [],
            "request_ids": ["r1", "r2"],
            "transcript_path": "convergence/cycle-v5_4.jsonl",
            "resumed_from_persistence": False,
            "convergence_id": "plan-v5_4-01",
            "token_cost_estimate": 12345,
        }
        review_result = {
            "plan_id": "plan-v5_4-01",
            "impl_artifacts_ref": "pr-42@abc",
            "review_verdict": "no_gaps",
            "rounds_count": 1,
            "gaps_found": [],
            "request_ids": ["r3"],
            "convergence_id": "plan-v5_4-01",
        }
        pedagogy_lint_result = {
            "lint_pass_rate": 1.0,
            "violation_count": 0,
            "agents_scanned": 84,
        }

        reflection = run_reflection(
            cycle_id="cycle-v5_4",
            base_dir=self.base,
            convergence_result=convergence_result,
            review_result=review_result,
            pedagogy_lint_result=pedagogy_lint_result,
        )

        # Plan ARIA-V7 §3 Phase 7.7 — forward-compat: V7.7 bumps
        # schema 2 → 3 (additive). Use assertGreaterEqual so this
        # V5.4 invariant remains green across schema bumps.
        self.assertGreaterEqual(
            reflection.get("schema_version"), 2,
            msg=(
                "Plan ARIA-V5 §3f v2 — reflection MUST emit "
                "schema_version>=2 once V5.4 lands. Operator daily "
                "report renders Convergence + Pedagogy sections "
                "gated on schema_version>=2; v1 readers tolerate "
                "the bump via .get(key, default) access."
            ),
        )
        convergence = reflection.get("convergence")
        self.assertIsNotNone(
            convergence,
            msg="V5.4 — convergence sub-object MUST be present when orchestrator supplies verdicts",
        )
        pre_impl = convergence["pre_impl"]
        for k, v_type in [
            ("rounds_count", int), ("arbiter_verdict", str),
            ("gaps_found_count", int), ("plan_id", str),
            ("token_cost_estimate", int),
            ("resumed_from_persistence", bool),
            ("convergence_id", str),
        ]:
            self.assertIn(k, pre_impl, msg=f"V5.4 — convergence.pre_impl missing {k}")
            self.assertIsInstance(pre_impl[k], v_type)
        post_impl = convergence["post_impl"]
        for k, v_type in [
            ("rounds_count", int), ("review_verdict", str),
            ("gaps_found_count", int), ("impl_artifacts_ref", str),
        ]:
            self.assertIn(k, post_impl, msg=f"V5.4 — convergence.post_impl missing {k}")
            self.assertIsInstance(post_impl[k], v_type)
        self.assertEqual(pre_impl["arbiter_verdict"], "converged")
        self.assertEqual(post_impl["review_verdict"], "no_gaps")
        self.assertIsNone(
            post_impl["auto_merge_blocked_by"],
            msg="V5.4 — review_verdict=no_gaps MUST mean auto_merge_blocked_by is null",
        )

        pedagogy = reflection.get("pedagogy")
        self.assertIsNotNone(pedagogy)
        self.assertEqual(pedagogy["lint_pass_rate"], 1.0)
        self.assertEqual(pedagogy["violation_count"], 0)
        self.assertEqual(pedagogy["agents_scanned"], 84)

    # I-V5.4-02 — direct CLI path emits null sub-objects.
    def test_i_v5_4_02_direct_cli_emits_null_convergence_and_pedagogy(
        self,
    ) -> None:
        """Plan ARIA-V5 §3f v2 — when run_reflection is invoked
        WITHOUT convergence/review/pedagogy kwargs (direct CLI path),
        the v2 row MUST carry ``convergence: null`` AND
        ``pedagogy: null`` — the legitimately-skipped sentinel.
        """
        from aria_kernel.reflection import run_reflection

        reflection = run_reflection(
            cycle_id="cycle-v5_4-02",
            base_dir=self.base,
        )
        self.assertGreaterEqual(reflection.get("schema_version"), 2)
        self.assertIsNone(
            reflection.get("convergence"),
            msg=(
                "Plan ARIA-V5 §3f v2 — direct CLI path (no "
                "convergence_result kwarg) MUST emit "
                "convergence: null. v1 readers ignore the field; v2 "
                "readers distinguish 'cycle skipped Gate A' from "
                "'cycle ran Gate A with verdict X'."
            ),
        )
        self.assertIsNone(reflection.get("pedagogy"))

    # I-V5.4-03 — daily report renders Convergence section.
    def test_i_v5_4_03_daily_report_renders_convergence_section(
        self,
    ) -> None:
        """Plan ARIA-V5 §3f v2 — the daily report MUST render
        ``## Convergence`` + ``## Pedagogy`` sections when the
        orchestrator path supplied verdicts. Direct CLI path
        rows (convergence=null) MUST NOT render the sections.
        """
        from aria_kernel.reflection import run_reflection

        # Orchestrator-path reflection
        convergence_result = {
            "plan_id": "plan-v5_4-03",
            "converged_plan": {},
            "rounds_count": 3,
            "arbiter_verdict": "max_rounds",
            "unsatisfied_items": [{"id": "u1"}, {"id": "u2"}],
            "request_ids": [],
            "transcript_path": "",
            "resumed_from_persistence": False,
            "convergence_id": "plan-v5_4-03",
        }
        reflection = run_reflection(
            cycle_id="cycle-v5_4-03-orch",
            base_dir=self.base,
            convergence_result=convergence_result,
            # No review_result — convergence-blocked cycle.
            review_result=None,
        )
        day = str(reflection["recorded_at"])[:10]
        report_path = self.base / "reports" / "daily" / f"{day}.md"
        self.assertTrue(report_path.exists())
        report_text = report_path.read_text(encoding="utf-8")
        self.assertIn(
            "## Convergence", report_text,
            msg=(
                "Plan ARIA-V5 §3f v2 — daily report MUST render the "
                "## Convergence section when reflection has a non-"
                "null convergence sub-object."
            ),
        )
        self.assertIn(
            "Arbiter verdict: max_rounds", report_text,
            msg="V5.4 — Convergence section MUST render the arbiter_verdict value",
        )
        self.assertIn(
            "Pre-impl gaps: 2", report_text,
            msg="V5.4 — Convergence section MUST render unsatisfied_items count",
        )


if __name__ == "__main__":
    unittest.main()
