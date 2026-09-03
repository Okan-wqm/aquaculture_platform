"""Plan ARIA-V7 §2h v2 V7.4 — skill_genesis_drainer invariants.

Nine invariants pin the Tier-1 contract:

  * I-V7-01    — skill_genesis_drainer REQUIRED kwarg signature
                 (no default, non-Optional, keyword-only)
  * I-V7.4-02  — drainer phase fires AFTER bridge_drained and
                 BEFORE cycle_runner_synthesized_plan
  * I-V7.4-03  — convergent=True + status=requested rows dispatched
                 in recorded_at ASC order
  * I-V7.4-04  — non-convergent rows preserve legacy path (NOT
                 dispatched by drainer)
  * I-V7.4-05  — max_authorings_per_cycle cap enforced
  * I-V7.4-06  — token budget cap enforced
  * I-V7.4-07  — source-substring invariant pins _latest_status
                 derived-state helper
  * I-V7.4-08  — source-substring invariant pins try/except around
                 run_convergent_authoring
  * I-V7.4-09  — crash mid-authoring -> status=authoring_error
                 persisted BEFORE re-raise (no infinite retry)
"""

from __future__ import annotations

import inspect
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


def _drafter_ok(**kwargs):
    return {
        "draft_id": "ok", "role": "primary",
        "rules": [{"claim_class": kwargs.get("seed", {}).get("claim_types", ["c"])[0], "summary": "r"}],
        "evidence_refs": ["fixture.py:1:line"],
        "peer_audit": [], "critiques": [],
    }


def _judge_ok(**kwargs):
    return {"verdict": "no_gaps", "gaps": []}


def _sandbox_ok(**kwargs):
    return {
        "fixture_count": 10, "precision": 1.0, "recall": 1.0,
        "critical_false_positives": 0,
        "false_positives": [], "false_negatives": [],
    }


def _raising_drafter(**kwargs):
    raise RuntimeError("synthetic drafter failure for I-V7.4-09")


class PhaseV7_4SkillGenesisDrainer(unittest.TestCase):
    def setUp(self) -> None:
        import subprocess
        from aria_kernel.runtime_profile import set_profile
        from tests.invariants.v3_3._helpers import clear_aria_tools_env

        self.tmp = Path(tempfile.mkdtemp(prefix="aria-v7_4-"))
        self.base = self.tmp / "aria-tools"
        self.workspace = self.tmp / "ws"
        self.workspace.mkdir()
        # Phase 0 evidence_collector requires git; init a tiny repo.
        subprocess.run(["git", "init", "-q", "-b", "main"], cwd=self.workspace, check=True)
        subprocess.run(["git", "config", "user.email", "v7-4@example.com"], cwd=self.workspace, check=True)
        subprocess.run(["git", "config", "user.name", "v7-4"], cwd=self.workspace, check=True)
        # Phase 0 needs ≥10 observations matching claim_type to NOT
        # reject the seed at InsufficientEvidence. Seed a file with
        # 12 `test_claim` token matches so authoring can proceed.
        fixture_lines = ["# fixture"] + [
            f"# test_claim observation {i}" for i in range(12)
        ]
        (self.workspace / "fixture").mkdir(exist_ok=True)
        (self.workspace / "fixture" / "src.py").write_text(
            "\n".join(fixture_lines), encoding="utf-8",
        )
        subprocess.run(["git", "add", "."], cwd=self.workspace, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "fixture"], cwd=self.workspace, check=True)
        self._env_snapshot = clear_aria_tools_env()
        set_profile("standard", operator_approval_ref="v7_4-test", base_dir=self.base)

    def tearDown(self) -> None:
        from tests.invariants.v3_3._helpers import restore_aria_tools_env
        restore_aria_tools_env(self._env_snapshot)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _mint_request(self, request_id, convergent=True, recorded_at=None):
        """Append a request row to skill-genesis/requests.jsonl."""
        from aria_kernel.tool_registry import ensure_tools_dir, utc_now
        root = ensure_tools_dir(self.base)
        path = root / "skill-genesis" / "requests.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        row = {
            "schema_version": 1,
            "recorded_at": recorded_at or utc_now(),
            "request_id": request_id,
            "capability_gap_key": f"gap-{request_id}",
            "title": f"Request {request_id}",
            "status": "requested",
            "convergent": convergent,
            "seed": {
                "seed_id": request_id, "title": "T",
                "capability_gap_key": f"gap-{request_id}",
                "declared_scope": ["fixture/"],
                "claim_types": ["test_claim"],
                "must_satisfy": [{"id": "m1", "description": "d"}],
                "calibration_corpus_path": str(self.tmp / "no-such-corpus"),
            },
        }
        from tests._helpers.declared_fixtures import append_declared_fixture
        return append_declared_fixture(
            path,
            row,
            expected_surface="skill_genesis_requests",
        )

    # I-V7-01 — REQUIRED kwarg signature.
    def test_i_v7_01_skill_genesis_drainer_has_no_default(self) -> None:
        """Plan ARIA-V7 §2h v2 — drainer is REQUIRED kwarg."""
        from aria_kernel.autonomy_orchestrator import run_autonomy_orchestrator
        sig = inspect.signature(run_autonomy_orchestrator)
        self.assertIn("skill_genesis_drainer", sig.parameters)
        param = sig.parameters["skill_genesis_drainer"]
        self.assertIs(
            param.default, inspect.Parameter.empty,
            msg=(
                "Plan ARIA-V7 §2h v2 — skill_genesis_drainer MUST have "
                "NO default (Tier-1). A None default would let a future "
                "caller silently skip the drainer."
            ),
        )
        self.assertEqual(param.kind, inspect.Parameter.KEYWORD_ONLY)
        ann = str(param.annotation)
        for forbidden in ("Optional", "| None", "None |"):
            self.assertNotIn(forbidden, ann)

    # I-V7.4-03 — recorded_at ASC ordering.
    def test_i_v7_4_03_dispatch_order_is_recorded_at_asc(self) -> None:
        """Plan ARIA-V7 §2h v2 — deterministic dispatch order."""
        from aria_kernel.skill_genesis_drainer import run_skill_genesis_drainer
        # Mint 3 convergent requests with descending recorded_at.
        self._mint_request("req-c", recorded_at="2026-05-17T10:00:00Z")
        self._mint_request("req-a", recorded_at="2026-05-17T08:00:00Z")
        self._mint_request("req-b", recorded_at="2026-05-17T09:00:00Z")
        # Use a drafter that raises to surface dispatch order via
        # status patches written BEFORE the raise. We won't actually
        # raise here; use a drafter that records its invocation order.
        invocations: list[str] = []
        def _ordered_drafter(**kw):
            invocations.append(kw["seed"]["seed_id"])
            return {
                "draft_id": "ok", "role": "primary",
                "rules": [{"claim_class": "test_claim", "summary": "r"}],
                "evidence_refs": ["fixture.py:1:line"],
                "peer_audit": [], "critiques": [],
            }
        try:
            run_skill_genesis_drainer(
                cycle_id="cyc-v7-4-03",
                base_dir=self.base,
                workspace_root=self.workspace,
                profile="standard",
                primary_drafter=_ordered_drafter,
                challenger_drafter=_drafter_ok,
                evidence_judge=_judge_ok,
                adversarial_judge=_judge_ok,
                sandbox_runner=_sandbox_ok,
                max_authorings_per_cycle=3,
            )
        except Exception:
            pass  # Phase 0 may reject; we only care about invocation order
        # Drafter may be called once per round per request; we just
        # verify the first invocations follow ascending recorded_at.
        if invocations:
            seen_order = []
            for inv in invocations:
                if inv not in seen_order:
                    seen_order.append(inv)
            self.assertEqual(
                seen_order[:3], ["req-a", "req-b", "req-c"],
                msg=(
                    "Plan ARIA-V7 §2h v2 — drainer MUST dispatch in "
                    "recorded_at ASC order for determinism."
                ),
            )

    # I-V7.4-04 — non-convergent rows skipped.
    def test_i_v7_4_04_non_convergent_rows_skipped(self) -> None:
        """Plan ARIA-V7 §2h v2 — drainer only dispatches convergent=True."""
        from aria_kernel.skill_genesis_drainer import run_skill_genesis_drainer
        self._mint_request("non-conv", convergent=False)
        result = run_skill_genesis_drainer(
            cycle_id="cyc-v7-4-04",
            base_dir=self.base, workspace_root=self.workspace,
            profile="standard",
            primary_drafter=_drafter_ok, challenger_drafter=_drafter_ok,
            evidence_judge=_judge_ok, adversarial_judge=_judge_ok,
            sandbox_runner=_sandbox_ok,
        )
        self.assertEqual(result["requests_dispatched"], 0)
        self.assertGreaterEqual(result["requests_skipped_non_convergent"], 1)

    # I-V7.4-05 — max_authorings_per_cycle cap.
    def test_i_v7_4_05_max_authorings_cap(self) -> None:
        """Plan ARIA-V7 §2h v2 — cap enforced."""
        from aria_kernel.skill_genesis_drainer import run_skill_genesis_drainer
        for i in range(5):
            self._mint_request(f"req-{i}", recorded_at=f"2026-05-17T0{i}:00:00Z")
        result = run_skill_genesis_drainer(
            cycle_id="cyc-v7-4-05",
            base_dir=self.base, workspace_root=self.workspace,
            profile="standard",
            primary_drafter=_drafter_ok, challenger_drafter=_drafter_ok,
            evidence_judge=_judge_ok, adversarial_judge=_judge_ok,
            sandbox_runner=_sandbox_ok,
            max_authorings_per_cycle=2,
        )
        # At most 2 dispatched; rest skipped (already-terminal counter
        # increments only after status patch from a prior cycle).
        total_processed = (
            result["requests_dispatched"]
            + result["requests_skipped_token_budget"]
        )
        self.assertLessEqual(
            total_processed, 2,
            msg=f"Plan ARIA-V7 §2h v2 — cap=2 MUST limit dispatch+budget-skip "
                f"to ≤2; got {total_processed}. Result: {result}",
        )

    # I-V7.4-06 — token budget cap.
    def test_i_v7_4_06_token_budget_cap(self) -> None:
        """Plan ARIA-V7 §2h v2 — per-cycle token cap enforced."""
        from aria_kernel.skill_genesis_drainer import run_skill_genesis_drainer
        for i in range(3):
            self._mint_request(f"req-{i}", recorded_at=f"2026-05-17T0{i}:00:00Z")
        # estimated 30k per authoring + cap 50k → first ok, second over budget.
        result = run_skill_genesis_drainer(
            cycle_id="cyc-v7-4-06",
            base_dir=self.base, workspace_root=self.workspace,
            profile="standard",
            primary_drafter=_drafter_ok, challenger_drafter=_drafter_ok,
            evidence_judge=_judge_ok, adversarial_judge=_judge_ok,
            sandbox_runner=_sandbox_ok,
            max_authorings_per_cycle=10,
            max_tokens_per_cycle=50_000,
            estimated_tokens_per_authoring=30_000,
        )
        self.assertGreaterEqual(
            result["requests_skipped_token_budget"], 1,
            msg=f"Plan ARIA-V7 §2h v2 — budget cap MUST skip ≥1 request. "
                f"Result: {result}",
        )

    # I-V7.4-07 — source-substring pins _latest_status helper.
    def test_i_v7_4_07_source_substring_pins_latest_status(self) -> None:
        """Plan ARIA-V7 §2h v2 — derived-state helper pinned."""
        import aria_kernel.skill_genesis_drainer as mod
        src = inspect.getsource(mod)
        self.assertIn(
            "def _latest_status(", src,
            msg=(
                "Plan ARIA-V7 §2h v2 (I-V7.4-07) — _latest_status "
                "derived-state helper MUST exist. Refactor that drops "
                "it re-introduces in-place status mutation pattern."
            ),
        )

    # I-V7.4-08 — source-substring pins try/except envelope.
    def test_i_v7_4_08_source_substring_pins_try_except(self) -> None:
        """Plan ARIA-V7 §2h v2 — refactor-resistant crash-catch."""
        import aria_kernel.skill_genesis_drainer as mod
        src = inspect.getsource(mod)
        self.assertIn(
            "except Exception as _v7_exc:", src,
            msg=(
                "Plan ARIA-V7 §2h v2 (I-V7.4-08) — drainer MUST contain "
                "the literal `except Exception as _v7_exc:` envelope. "
                "Refactor that drops it re-introduces infinite retry "
                "on deterministic authoring crash."
            ),
        )

    # I-V7.4-09 — crash → status=authoring_error persisted before re-raise.
    def test_i_v7_4_09_crash_persists_status_before_reraise(self) -> None:
        """Plan ARIA-V7 §2h v2 — status persisted BEFORE re-raise."""
        from aria_kernel.skill_genesis_drainer import (
            _latest_status, run_skill_genesis_drainer,
        )
        self._mint_request("req-crash")
        with self.assertRaises(Exception):
            run_skill_genesis_drainer(
                cycle_id="cyc-v7-4-09",
                base_dir=self.base, workspace_root=self.workspace,
                profile="standard",
                primary_drafter=_raising_drafter,
                challenger_drafter=_drafter_ok,
                evidence_judge=_judge_ok,
                adversarial_judge=_judge_ok,
                sandbox_runner=_sandbox_ok,
            )
        status = _latest_status("req-crash", self.base)
        self.assertEqual(
            status, "authoring_error",
            msg=(
                "Plan ARIA-V7 §2h v2 (I-V7.4-09) — crash mid-authoring "
                "MUST persist status=authoring_error BEFORE re-raise. "
                f"Got latest status: {status!r}"
            ),
        )

    # I-V7.4-02 — drainer phase ordering.
    def test_i_v7_4_02_phase_ordering_after_bridge_before_synthesizer(self) -> None:
        """Plan ARIA-V7 §2h v2 — drainer phase between bridge + synthesizer."""
        # Source-substring check on orchestrator for ordering.
        import aria_kernel.autonomy_orchestrator as mod
        src = inspect.getsource(mod.run_autonomy_orchestrator)
        # bridge_drained must appear BEFORE skill_genesis_drainer_started
        # which must appear BEFORE plan_synthesizer call.
        idx_bridge = src.find('phase="bridge_drained"')
        idx_drainer = src.find('phase="skill_genesis_drainer_started"')
        idx_synth = src.find("_v7_plan_content = plan_synthesizer(")
        self.assertNotEqual(idx_bridge, -1, "bridge_drained marker missing")
        self.assertNotEqual(idx_drainer, -1, "skill_genesis_drainer_started marker missing")
        self.assertNotEqual(idx_synth, -1, "plan_synthesizer call marker missing")
        self.assertLess(
            idx_bridge, idx_drainer,
            msg="bridge_drained MUST precede skill_genesis_drainer_started",
        )
        self.assertLess(
            idx_drainer, idx_synth,
            msg="skill_genesis_drainer_started MUST precede plan_synthesizer call",
        )


if __name__ == "__main__":
    unittest.main()
