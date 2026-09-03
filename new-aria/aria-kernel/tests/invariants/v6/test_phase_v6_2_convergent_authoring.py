"""Plan ARIA-V6 §2d V6.2 Phase 6.2 — convergent_skill_authoring invariants.

Seven invariants pin the architectural contract between the convergent
authoring loop and its three Tier-1 constraints (100% validation
structural exit, evidence-grounded debate, mutual hallucination
guarantee):

  * I-V6.2-01 — loop terminates at 100% precision OR max_rounds
  * I-V6.2-02 — sandbox execution gates materialization (no materialize
                without a sandbox_result)
  * I-V6.2-03 — judge-consensus (BOTH evidence + adversarial say
                no_gaps) required for authored_validated verdict
  * I-V6.2-04 — max_rounds preserves drafts for operator review
  * I-V6.2-05 — Phase 0 InsufficientEvidence rejects seed at pre-
                authoring (< 10 observations)
  * I-V6.2-06 — _cross_verify_evidence_refs REJECTS draft citing
                file:line missing from evidence_pack (mutual
                hallucination guarantee structural enforcement)
  * I-V6.2-07 — source-substring invariant pins the literal
                ``Path.exists()`` AND ``git show`` cross-verification
                call site so a refactor cannot silently weaken the
                guarantee
"""

from __future__ import annotations

import inspect
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))


def _init_git_repo(root: Path) -> str:
    """Init a tiny git repo + return HEAD sha."""
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.email", "v6.2-test@example.com"],
                   cwd=root, check=True)
    subprocess.run(["git", "config", "user.name", "v6.2-test"],
                   cwd=root, check=True)
    # Seed a real file with multiple lines so observations resolve.
    (root / "apps").mkdir()
    (root / "apps" / "svc.ts").write_text(
        "\n".join([
            "// line 1",
            "export const TENANT_HEADER = 'x-tenant-id';",
            "// line 3",
            "if (!req.headers[TENANT_HEADER]) {",
            "  throw new Error('missing tenant');",
            "}",
            "// line 7",
            "// tenant_isolation",
            "// line 9",
            "// tenant_isolation",
            "// line 11",
            "// tenant_isolation",
            "// line 13",
            "// tenant_isolation",
            "// line 15",
            "// tenant_isolation",
            "// line 17",
            "// tenant_isolation",
            "// line 19",
            "// tenant_isolation",
            "// line 21",
            "// tenant_isolation",
            "// line 23",
            "// tenant_isolation",
            "// line 25",
            "// tenant_isolation",
        ]),
        encoding="utf-8",
    )
    subprocess.run(["git", "add", "."], cwd=root, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "seed"], cwd=root, check=True)
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=root,
        capture_output=True, text=True, check=True,
    ).stdout.strip()


def _make_seed(workspace_root: Path, calibration_corpus: Path):
    return {
        "seed_id": "tenant_isolation_adapter",
        "declared_scope": ["apps/"],
        "claim_types": ["tenant_isolation"],
        "must_satisfy": [{
            "id": "tenant-header-required",
            "description": "Every request handler requires tenant header.",
        }],
        "calibration_corpus_path": str(calibration_corpus),
    }


def _drafter_with_verified_refs(workspace_root: Path, *, role: str = "primary"):
    """Drafter that cites real refs MATCHING the seeded evidence_pack.

    The repo's `apps/svc.ts` has `// tenant_isolation` markers on
    lines 8, 10, 12, 14, ..., 26 (matching the regex token
    ``tenant_isolation``). Pick refs that fall within ±5 of those
    observations so they pass evidence_pack membership.

    ``role`` differentiates primary vs challenger so content_hashes
    differ (the default arbiter rejects identical drafts as a
    collusion signal — same machinery as plan_convergence.py:473).
    """
    def _fn(**kwargs):
        return {
            "draft_id": f"{role}-r{kwargs['round_number']}",
            "role": role,
            "rules": [{"claim_class": "tenant_isolation",
                       "summary": f"{role}-rule"}],
            "evidence_refs": [
                "apps/svc.ts:8",
                "apps/svc.ts:12",
                "apps/svc.ts:16",
            ],
            "peer_audit": [],
            "critiques": [],
        }
    return _fn


def _drafter_with_hallucinated_refs(workspace_root: Path):
    """Drafter that cites refs NOT in evidence_pack — must be REJECTED."""
    def _fn(**kwargs):
        return {
            "draft_id": "hallu",
            "rules": [{"claim_class": "tenant_isolation", "summary": "h"}],
            "evidence_refs": [
                "apps/nonexistent.ts:99",
                "fake/path.ts:1",
            ],
            "peer_audit": [],
            "critiques": [],
        }
    return _fn


def _sandbox_perfect(**kwargs):
    return {
        "fixture_count": 10,
        "precision": 1.0,
        "recall": 1.0,
        "critical_false_positives": 0,
        "false_positives": [],
        "false_negatives": [],
    }


def _sandbox_imperfect(**kwargs):
    return {
        "fixture_count": 10,
        "precision": 0.7,
        "recall": 0.6,
        "critical_false_positives": 0,
        "false_positives": ["fixture-3"],
        "false_negatives": ["fixture-7"],
    }


def _sandbox_too_small_corpus(**kwargs):
    return {
        "fixture_count": 3,
        "precision": 1.0,
        "recall": 1.0,
        "critical_false_positives": 0,
        "false_positives": [],
        "false_negatives": [],
    }


def _judge_no_gaps(**kwargs):
    return {"verdict": "no_gaps", "gaps": []}


def _judge_finds_gaps(**kwargs):
    return {"verdict": "gaps_open",
            "gaps": [{"severity": "HIGH", "summary": "missing case", "evidence_refs": []}]}


class PhaseV6_2ConvergentAuthoring(unittest.TestCase):
    def setUp(self) -> None:
        from aria_kernel.runtime_profile import set_profile
        from tests.invariants.v3_3._helpers import clear_aria_tools_env

        self.tmp = Path(tempfile.mkdtemp(prefix="aria-v6_2-"))
        self.base = self.tmp / "aria-tools"
        self.workspace = self.tmp / "ws"
        self.workspace.mkdir()
        self._env_snapshot = clear_aria_tools_env()
        set_profile(
            "standard",
            operator_approval_ref="v6_2-test",
            base_dir=self.base,
        )
        self.sha = _init_git_repo(self.workspace)
        # Dummy calibration corpus dir (existence checked by some code paths).
        self.corpus = self.tmp / "corpus"
        self.corpus.mkdir()
        (self.corpus / "fixtures.jsonl").write_text("[]\n", encoding="utf-8")

    def tearDown(self) -> None:
        import shutil
        from tests.invariants.v3_3._helpers import restore_aria_tools_env
        restore_aria_tools_env(self._env_snapshot)
        shutil.rmtree(self.tmp, ignore_errors=True)

    # I-V6.2-01 — loop terminates at 100% precision OR max_rounds.
    def test_i_v6_2_01_loop_terminates_at_validation_or_max_rounds(self) -> None:
        """Plan ARIA-V6 §2d v2 — structural exit invariant."""
        from aria_kernel.convergent_skill_authoring import (
            run_convergent_authoring,
        )
        seed = _make_seed(self.workspace, self.corpus)
        materialize_calls: list[dict] = []
        def _materialize(**kw):
            materialize_calls.append(kw)
            return {"adapter_path": "/tmp/adapter.ts",
                    "manifest_path": "/tmp/adapter.tool.json"}

        result = run_convergent_authoring(
            request_id="req-v6-2-01",
            seed=seed,
            workspace_root=self.workspace,
            base_dir=self.base,
            primary_drafter=_drafter_with_verified_refs(self.workspace, role="primary"),
            challenger_drafter=_drafter_with_verified_refs(self.workspace, role="challenger"),
            evidence_judge=_judge_no_gaps,
            adversarial_judge=_judge_no_gaps,
            sandbox_runner=_sandbox_perfect,
            materialize_fn=_materialize,
            max_authoring_rounds=4,
        )
        self.assertEqual(result["authoring_verdict"], "authored_validated",
                         msg=f"Expected validated; got {result}")
        self.assertEqual(result["calibration_precision"], 1.0)
        self.assertEqual(result["critical_false_positives"], 0)
        self.assertEqual(len(materialize_calls), 1,
                         msg="materialize_fn must fire exactly once at validation")

    # I-V6.2-02 — sandbox execution gates materialization.
    def test_i_v6_2_02_sandbox_gates_materialization(self) -> None:
        """Plan ARIA-V6 §2d v2 — materialize CANNOT fire without sandbox.

        When sandbox reports imperfect precision, the loop MUST NOT
        call materialize_fn and MUST not return authored_validated.
        """
        from aria_kernel.convergent_skill_authoring import (
            run_convergent_authoring,
        )
        seed = _make_seed(self.workspace, self.corpus)
        materialize_calls: list[dict] = []
        def _materialize(**kw):
            materialize_calls.append(kw)
            return {"adapter_path": "/tmp/x.ts"}

        result = run_convergent_authoring(
            request_id="req-v6-2-02",
            seed=seed,
            workspace_root=self.workspace,
            base_dir=self.base,
            primary_drafter=_drafter_with_verified_refs(self.workspace, role="primary"),
            challenger_drafter=_drafter_with_verified_refs(self.workspace, role="challenger"),
            evidence_judge=_judge_no_gaps,
            adversarial_judge=_judge_no_gaps,
            sandbox_runner=_sandbox_imperfect,
            materialize_fn=_materialize,
            max_authoring_rounds=3,
        )
        self.assertNotEqual(
            result["authoring_verdict"], "authored_validated",
            msg="Imperfect sandbox must NOT yield authored_validated",
        )
        self.assertEqual(
            len(materialize_calls), 0,
            msg=(
                "materialize_fn MUST NOT fire when sandbox precision/"
                "recall fall below threshold. Got calls: "
                f"{materialize_calls}"
            ),
        )

    # I-V6.2-03 — judge-consensus required for authored_validated.
    def test_i_v6_2_03_judge_consensus_required_for_validated(self) -> None:
        """Plan ARIA-V6 §2d v2 — BOTH judges must say no_gaps."""
        from aria_kernel.convergent_skill_authoring import (
            run_convergent_authoring,
        )
        seed = _make_seed(self.workspace, self.corpus)
        # Adversarial says no_gaps, evidence judge finds gaps → no validate.
        result = run_convergent_authoring(
            request_id="req-v6-2-03",
            seed=seed,
            workspace_root=self.workspace,
            base_dir=self.base,
            primary_drafter=_drafter_with_verified_refs(self.workspace, role="primary"),
            challenger_drafter=_drafter_with_verified_refs(self.workspace, role="challenger"),
            evidence_judge=_judge_finds_gaps,
            adversarial_judge=_judge_no_gaps,
            sandbox_runner=_sandbox_perfect,
            max_authoring_rounds=2,
        )
        self.assertNotEqual(
            result["authoring_verdict"], "authored_validated",
            msg=(
                "Single-judge no_gaps MUST NOT yield validated. Both "
                "evidence + adversarial must agree. Got: "
                f"{result['authoring_verdict']}"
            ),
        )

    # I-V6.2-04 — max_rounds preserves drafts.
    def test_i_v6_2_04_max_rounds_preserves_drafts(self) -> None:
        """Plan ARIA-V6 §2d v2 — cap-hit MUST emit authored_max_rounds
        AND preserve drafts on disk for operator review."""
        from aria_kernel.convergent_skill_authoring import (
            run_convergent_authoring,
        )
        seed = _make_seed(self.workspace, self.corpus)
        result = run_convergent_authoring(
            request_id="req-v6-2-04",
            seed=seed,
            workspace_root=self.workspace,
            base_dir=self.base,
            primary_drafter=_drafter_with_verified_refs(self.workspace, role="primary"),
            challenger_drafter=_drafter_with_verified_refs(self.workspace, role="challenger"),
            evidence_judge=_judge_finds_gaps,
            adversarial_judge=_judge_finds_gaps,
            sandbox_runner=_sandbox_imperfect,
            max_authoring_rounds=2,
        )
        self.assertEqual(result["authoring_verdict"], "authored_max_rounds")
        self.assertEqual(result["rounds_count"], 2)
        # Drafts preserved on disk.
        plan_dir = self.base / "convergent-authoring" / result["plan_id"]
        self.assertTrue(
            plan_dir.exists() and any(plan_dir.iterdir()),
            msg=(
                "Max-rounds cap MUST preserve drafts under "
                f"{plan_dir} for operator review."
            ),
        )

    # I-V6.2-05 — Phase 0 InsufficientEvidence rejects seed.
    def test_i_v6_2_05_phase0_insufficient_evidence_rejects(self) -> None:
        """Plan ARIA-V6 §2d v2 — < 10 observations → seed REJECTED."""
        from aria_kernel.convergent_skill_authoring import (
            run_convergent_authoring,
        )
        # Use a claim_type that won't match the seeded repo at all.
        seed = {
            "seed_id": "no_match_adapter",
            "declared_scope": ["apps/"],
            "claim_types": ["nonexistent_pattern_xyz123"],
            "must_satisfy": [{"id": "x", "description": "x"}],
            "calibration_corpus_path": str(self.corpus),
        }
        result = run_convergent_authoring(
            request_id="req-v6-2-05",
            seed=seed,
            workspace_root=self.workspace,
            base_dir=self.base,
            primary_drafter=_drafter_with_verified_refs(self.workspace, role="primary"),
            challenger_drafter=_drafter_with_verified_refs(self.workspace, role="challenger"),
            evidence_judge=_judge_no_gaps,
            adversarial_judge=_judge_no_gaps,
            sandbox_runner=_sandbox_perfect,
            max_authoring_rounds=2,
        )
        self.assertEqual(
            result["authoring_verdict"], "authoring_insufficient_evidence",
            msg=(
                "Phase 0 floor (10 observations) MUST reject seeds that "
                "cannot meet it. Got: " + result["authoring_verdict"]
            ),
        )
        self.assertEqual(result["rounds_count"], 0,
                         msg="No rounds should fire under Phase 0 reject.")

    # I-V6.2-06 — CROSS-VERIFY rejects refs missing from evidence_pack.
    def test_i_v6_2_06_cross_verify_rejects_hallucinated_refs(self) -> None:
        """Plan ARIA-V6 §2d v2 — mutual hallucination guarantee.

        A drafter that cites refs NOT in evidence_pack MUST be REJECTED
        at CROSS-VERIFY #1 with verdict evidence_hallucination_detected.
        Drafts preserved on disk; hallucination_rejection_count > 0.
        """
        from aria_kernel.convergent_skill_authoring import (
            run_convergent_authoring,
        )
        seed = _make_seed(self.workspace, self.corpus)
        result = run_convergent_authoring(
            request_id="req-v6-2-06",
            seed=seed,
            workspace_root=self.workspace,
            base_dir=self.base,
            primary_drafter=_drafter_with_hallucinated_refs(self.workspace),
            challenger_drafter=_drafter_with_verified_refs(self.workspace, role="challenger"),
            evidence_judge=_judge_no_gaps,
            adversarial_judge=_judge_no_gaps,
            sandbox_runner=_sandbox_perfect,
            max_authoring_rounds=3,
        )
        self.assertEqual(
            result["authoring_verdict"], "evidence_hallucination_detected",
            msg=(
                "Hallucinated refs MUST be rejected at CROSS-VERIFY #1. "
                f"Got: {result['authoring_verdict']}"
            ),
        )
        self.assertGreaterEqual(
            result["hallucination_rejection_count"], 1,
            msg="hallucination_rejection_count must increment on rejection",
        )

    # I-V6.2-07 — source-substring invariant pins Path.exists + git show.
    def test_i_v6_2_07_source_substring_pins_cross_verify_call_site(
        self,
    ) -> None:
        """Plan ARIA-V6 §2d v2 — refactor-resistant guard.

        Reads the actual source of ``_cross_verify_evidence_refs`` and
        asserts the literal call to ``Path.exists()`` AND ``git show``
        appear. A refactor that drops either check breaks this
        invariant — fails CI before merge.
        """
        import aria_kernel.convergent_skill_authoring as mod
        src = inspect.getsource(mod)
        # Path.exists check
        self.assertIn(
            "abs_path.exists()", src,
            msg=(
                "Plan ARIA-V6 §2d v2 (I-V6.2-07) — _cross_verify_"
                "evidence_refs MUST contain a literal Path.exists() "
                "check on the resolved abs_path. A refactor that "
                "removes this check silently weakens the mutual-"
                "hallucination guarantee."
            ),
        )
        # git show check
        self.assertIn(
            "_git_show_line", src,
            msg=(
                "Plan ARIA-V6 §2d v2 (I-V6.2-07) — _cross_verify_"
                "evidence_refs MUST call _git_show_line so refs are "
                "validated against base_commit_sha (snippet-match)."
            ),
        )
        # And the helper itself must literally invoke 'git', 'show'.
        helper_src = inspect.getsource(mod._git_show_line)
        self.assertIn(
            "\"git\", \"show\"", helper_src,
            msg=(
                "Plan ARIA-V6 §2d v2 (I-V6.2-07) — _git_show_line MUST "
                "invoke literal `git show` (not a substitute) to bind "
                "the cross-verify to git's commit-aware view of the "
                "file at base_commit_sha."
            ),
        )


if __name__ == "__main__":
    unittest.main()
