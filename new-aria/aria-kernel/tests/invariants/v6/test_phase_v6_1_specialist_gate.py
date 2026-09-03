"""Plan ARIA-V6 §2c V6.1 Phase 6.1 — Gate C specialist-gate invariants.

Five invariants pin the architectural contract between the autonomy
orchestrator and the new ``specialist_review_runner``:

  * I-V6-01   — ``specialist_review_runner`` REQUIRED kwarg (no
                default, non-Optional annotation, keyword-only).
                Mirrors V5 §A1 (auto_merge_runner / convergence_runner
                / review_runner) precedent.
  * I-V6.1-02 — Dispatch ordering: ``specialist_review_started`` +
                ``specialist_review_resolved`` rows land in
                autonomy_state.jsonl AFTER ``convergence_resolved``
                and BEFORE ``worker_dispatch_drained``.
  * I-V6.1-03 — Selection determinism: same (touched, pressures,
                profile) → same ordered specialist list.
  * I-V6.1-04 — Markdown→findings transform: severity-prefixed lines
                produce structured findings; missing evidence_refs
                downgrade severity to MEDIUM (Plan §2c B-V9-1
                hallucination guard at the verdict-aggregation surface).
  * I-V6.1-05 — Cost cap enforcement: ``max_specialists_per_cycle``
                truncates the selected list deterministically.

Operator anchor (Plan ARIA-V6 §1, verbatim):
  "agentlar plan yapıyor ya yanı planları sureklı en bastan revıew
   ederek ıkı agent bırbırıne atarak valıde sekılde sonlanrmalı"

V5 wired Gate A + Gate B at meta-plan / post-impl tiers. V6.1 wires
Gate C at the SPECIALIST-DOMAIN tier (60+ Lane-A experts under
.claude/agents/). These invariants are the SSoT for the Tier-1
contract — any future caller that adds ``specialist_review_runner=
None`` default OR drops the autonomy_state ordering will fail here.
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


# Shared cycle-runner fakes (mirror v5 helpers).
def _fake_cycle_runner(**kwargs):
    return {
        "schema_version": 2,
        "cycle_id": kwargs["cycle_id"],
        "status": "completed",
    }


def _fake_planner_drainer(**kwargs):
    return {
        "iterations": 1,
        "claims_dispatched": 0,
        "exits_clean": True,
        "exit_reason": "max_iterations",
    }


def _fake_bridge_drainer(**kwargs):
    return {"status": "ok", "iterations": 0, "pending_after": 0}


def _fake_worker_drainer(**kwargs):
    return {
        "iterations": 1,
        "assignments_dispatched": 0,
        "merges_completed": 0,
        "retries_attempted": 0,
        "exits_clean": True,
        "exit_reason": "max_iterations",
    }


class _FakeAutoMergeRunner:
    profile = "standard"

    def __call__(self, *, base_dir, workspace_root):
        return {
            "schema_version": 1,
            "status": "skipped",
            "merges_completed": 0,
            "candidates_evaluated": 0,
            "profile": self.profile,
        }


class _FakeGitHubAdapter:
    pass


def _converged_fake(**kwargs):
    return {
        "plan_id": kwargs.get("plan_id", "plan-test"),
        "converged_plan": {},
        "rounds_count": 1,
        "arbiter_verdict": "converged",
        "unsatisfied_items": [],
        "request_ids": [],
        "transcript_path": "",
        "resumed_from_persistence": False,
        "convergence_id": kwargs.get("plan_id", "plan-test"),
    }


def _review_no_gaps_fake(**kwargs):
    return {
        "plan_id": kwargs.get("plan_id", "plan-test"),
        "impl_artifacts_ref": kwargs.get("impl_artifacts_ref", ""),
        "review_verdict": "no_gaps",
        "rounds_count": 1,
        "gaps_found": [],
        "request_ids": [],
        "convergence_id": kwargs.get("convergence_id", "plan-test"),
    }


class PhaseV6_1RequiredInjection(unittest.TestCase):
    """I-V6-01 — Tier-1 required-kwarg signature gate."""

    def test_i_v6_01_specialist_review_runner_has_no_default(self) -> None:
        """Plan ARIA-V6 §2c v2 — ``specialist_review_runner`` MUST be a
        keyword-only parameter with NO default value.

        Why no default: a ``None`` default (Tier-2 pattern) would let
        a future caller silently skip Gate C, breaking the operator
        vision that domain specialists must review plans before
        worker_drainer fires. Mirrors V5.1 + V5.2 precedent.
        """
        from aria_kernel.autonomy_orchestrator import (
            run_autonomy_orchestrator,
        )
        sig = inspect.signature(run_autonomy_orchestrator)
        self.assertIn(
            "specialist_review_runner",
            sig.parameters,
            msg=(
                "Plan ARIA-V6 §2c v2 — run_autonomy_orchestrator MUST "
                "accept specialist_review_runner kwarg. V6.1 Phase 6.1 "
                "(commit C1) wires Gate C through this kwarg."
            ),
        )
        param = sig.parameters["specialist_review_runner"]
        self.assertIs(
            param.default,
            inspect.Parameter.empty,
            msg=(
                "Plan ARIA-V6 §2c v2 — specialist_review_runner MUST "
                "have NO default (Tier-1 'Make impossible'). A None "
                "default would let a future caller silently skip the "
                "specialist gate. Found default: "
                f"{param.default!r}"
            ),
        )
        self.assertEqual(
            param.kind,
            inspect.Parameter.KEYWORD_ONLY,
            msg=(
                "specialist_review_runner must be keyword-only for "
                "clarity at callsites (mirrors V5 §A1 precedent)."
            ),
        )

    def test_i_v6_01_specialist_review_runner_annotation_is_not_optional(
        self,
    ) -> None:
        """Plan ARIA-V6 §2c v2 — annotation must not permit None."""
        from aria_kernel.autonomy_orchestrator import (
            run_autonomy_orchestrator,
        )
        sig = inspect.signature(run_autonomy_orchestrator)
        param = sig.parameters["specialist_review_runner"]
        annotation_str = str(param.annotation)
        for forbidden in ("Optional", "| None", "None |", "NoneType"):
            self.assertNotIn(
                forbidden,
                annotation_str,
                msg=(
                    f"Plan ARIA-V6 §2c v2 — specialist_review_runner "
                    f"annotation must not be Optional. Found "
                    f"{forbidden!r} in {annotation_str!r}."
                ),
            )


class PhaseV6_1SpecialistGate(unittest.TestCase):
    """I-V6.1-02..05 — Gate C wiring + transform + cost-cap invariants."""

    def setUp(self) -> None:
        from aria_kernel.runtime_profile import set_profile
        from tests.invariants.v3_3._helpers import clear_aria_tools_env

        self.tmp = Path(tempfile.mkdtemp(prefix="aria-v6_1-"))
        self.base = self.tmp / "aria-tools"
        self._env_snapshot = clear_aria_tools_env()
        set_profile(
            "standard",
            operator_approval_ref="v6_1-test",
            base_dir=self.base,
        )

    def tearDown(self) -> None:
        from tests.invariants.v3_3._helpers import restore_aria_tools_env
        restore_aria_tools_env(self._env_snapshot)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run(self, **overrides):
        from aria_kernel.autonomy_orchestrator import (
            run_autonomy_orchestrator,
        )
        from tests.invariants.v6._helpers import (
            _plan_synthesizer_fake_runner,
            _skill_genesis_drainer_fake_runner,
            _specialists_no_gaps_fake_runner,
        )
        kwargs = dict(
            base_dir=self.base,
            workspace_root=str(self.tmp),
            max_cycles=1,
            max_iterations_per_phase=3,
            cycle_runner=_fake_cycle_runner,
            planner_drainer=_fake_planner_drainer,
            worker_drainer=_fake_worker_drainer,
            bridge_drainer=_fake_bridge_drainer,
            auto_merge_runner=_FakeAutoMergeRunner(),
            github_adapter=_FakeGitHubAdapter(),
            convergence_runner=_converged_fake,
            review_runner=_review_no_gaps_fake,
            specialist_review_runner=_specialists_no_gaps_fake_runner,
            # Plan ARIA-V7 §2i v2 — V7.1 makes plan_synthesizer REQUIRED;
            # V6.1 tests pass happy-path fake so cycle proceeds through Gate A.
            plan_synthesizer=_plan_synthesizer_fake_runner,
            # Plan ARIA-V7 §2h v2 — V7.4 skill_genesis_drainer REQUIRED.
            skill_genesis_drainer=_skill_genesis_drainer_fake_runner,
            # Plan ARIA-V3.1-E — REQUIRED profile kwarg; standard
            # default for the V6.1 specialist gate; individual tests
            # that need profile="strict" override via overrides.
            profile="standard",
        )
        kwargs.update(overrides)
        return run_autonomy_orchestrator(**kwargs)

    def _read_autonomy_state(self) -> list[dict]:
        from aria_kernel.autonomy_state import autonomy_state_path
        path = autonomy_state_path(self.base)
        if not path.exists():
            return []
        return [
            json.loads(line)
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    # I-V6.1-02 — Gate C lands between Gate A and worker_drainer.
    def test_i_v6_1_02_specialist_review_runs_between_convergence_and_worker(
        self,
    ) -> None:
        """Plan ARIA-V6 §2c v2 — phase ordering invariant.

        ``specialist_review_started`` + ``specialist_review_resolved``
        MUST land AFTER ``convergence_resolved`` and BEFORE
        ``worker_dispatch_drained``. Pre-V6 the orchestrator went
        convergence → worker directly; V6.1 inserts Gate C between
        them.
        """
        self._run()
        rows = self._read_autonomy_state()
        phases = [r.get("phase") for r in rows]
        self.assertIn(
            "specialist_review_started", phases,
            msg="V6.1 must emit specialist_review_started",
        )
        self.assertIn(
            "specialist_review_resolved", phases,
            msg="V6.1 must emit specialist_review_resolved",
        )
        self.assertIn(
            "convergence_resolved", phases,
            msg="V5.1 convergence_resolved must still fire",
        )
        self.assertIn(
            "worker_dispatch_drained", phases,
            msg="worker_dispatch_drained must fire after Gate C",
        )
        idx_conv = phases.index("convergence_resolved")
        idx_started = phases.index("specialist_review_started")
        idx_resolved = phases.index("specialist_review_resolved")
        idx_worker = phases.index("worker_dispatch_drained")
        self.assertLess(
            idx_conv, idx_started,
            msg=(
                "Gate C started must follow convergence_resolved. "
                f"Got phases: {phases}"
            ),
        )
        self.assertLess(
            idx_started, idx_resolved,
            msg=(
                "Gate C resolved must follow Gate C started. "
                f"Got phases: {phases}"
            ),
        )
        self.assertLess(
            idx_resolved, idx_worker,
            msg=(
                "worker_dispatch_drained must follow Gate C resolved. "
                f"Got phases: {phases}"
            ),
        )

    # I-V6.1-03 — Selection determinism.
    def test_i_v6_1_03_selection_is_deterministic(self) -> None:
        """Plan ARIA-V6 §2c v2 — same inputs → same ordered list.

        Reproducibility unlocks debug-from-seed: any operator can
        replay a cycle's specialist set from (touched, pressures,
        profile). Without determinism, debugging requires inspecting
        transient invocation envelopes.
        """
        from aria_kernel.specialist_review_runner import (
            select_specialist_agents,
        )
        touched = [
            "apps/auth-service/src/auth.module.ts",
            "apps/farm-service/src/farm.module.ts",
            "libs/backend-common/src/guards/jwt.guard.ts",
        ]
        pressures = [
            {
                "severity": "HIGH",
                "affected_files": [
                    "apps/auth-service/src/foo.ts",
                    "apps/farm-service/src/bar.ts",
                ],
            },
        ]
        out_a = select_specialist_agents(
            touched_services=touched,
            pressures=pressures,
            profile="standard",
            max_specialists_per_cycle=10,
        )
        out_b = select_specialist_agents(
            touched_services=touched,
            pressures=pressures,
            profile="standard",
            max_specialists_per_cycle=10,
        )
        self.assertEqual(
            out_a, out_b,
            msg=(
                "Selection MUST be deterministic. "
                f"Run-A: {out_a} Run-B: {out_b}"
            ),
        )
        # And ordering must be stable + non-empty for this input.
        self.assertGreater(
            len(out_a), 0,
            msg="Touched apps/auth-service must produce ≥ 1 specialist",
        )
        self.assertIn("auth-security-expert", out_a)

    # I-V6.1-04 — Markdown→findings transform + hallucination guard.
    def test_i_v6_1_04_transform_severity_and_evidence_hallucination(
        self,
    ) -> None:
        """Plan ARIA-V6 §2c v2 (B-V9-1) — verdict-aggregation guard.

        The markdown→findings transform MUST:
          * Extract severity-prefixed lines into structured findings.
          * Verify each evidence_ref via Path.exists() against
            workspace_root.
          * Downgrade severity to MEDIUM when ALL refs are
            unverified (hallucinated). Refs that DO resolve keep
            their declared severity.
        """
        from aria_kernel.specialist_review_runner import (
            transform_specialist_output,
        )
        # Create a real file so verified-ref path is exercised.
        real_file = self.tmp / "real-file.txt"
        real_file.write_text("dummy\n", encoding="utf-8")

        markdown_real = (
            "CRITICAL: real risk in module\n"
            f"Evidence:\n- {real_file.name}:1\n"
        )
        findings_real = transform_specialist_output(
            agent_name="auth-security-expert",
            raw_markdown=markdown_real,
            workspace_root=self.tmp,
        )
        self.assertEqual(
            len(findings_real), 1,
            msg=f"Expected 1 finding from real ref, got {findings_real}",
        )
        self.assertEqual(
            findings_real[0]["severity"], "CRITICAL",
            msg=(
                "Verified evidence_ref must KEEP declared severity. "
                f"Got: {findings_real}"
            ),
        )

        markdown_hallu = (
            "CRITICAL: hallucinated risk\n"
            "Evidence:\n- nonexistent-path/fake.ts:99\n"
        )
        findings_hallu = transform_specialist_output(
            agent_name="auth-security-expert",
            raw_markdown=markdown_hallu,
            workspace_root=self.tmp,
        )
        self.assertEqual(
            len(findings_hallu), 1,
            msg=f"Expected 1 finding from hallu ref, got {findings_hallu}",
        )
        self.assertEqual(
            findings_hallu[0]["severity"], "MEDIUM",
            msg=(
                "Plan ARIA-V6 §2c v2 (B-V9-1) — hallucinated evidence "
                "must DOWNGRADE severity to MEDIUM. The transform is "
                "the verdict-aggregation seam where mutual-hallucination-"
                "guarantee discipline is enforced. "
                f"Got: {findings_hallu}"
            ),
        )
        self.assertIn(
            "nonexistent-path/fake.ts:99",
            findings_hallu[0].get("unverified_evidence_refs", []),
            msg=(
                "Unverified refs MUST be preserved under "
                "unverified_evidence_refs for operator inspection."
            ),
        )

    # I-V6.1-05 — Cost cap enforcement.
    def test_i_v6_1_05_max_specialists_per_cycle_is_honored(self) -> None:
        """Plan ARIA-V6 §2c v2 — token budget invariant.

        ``max_specialists_per_cycle`` MUST truncate the selected list.
        Without this gate, a cycle that touches every domain could
        dispatch 30+ specialists, blowing the token budget.
        """
        from aria_kernel.specialist_review_runner import (
            select_specialist_agents,
        )
        # Touch every mapped service to maximise candidate set.
        touched_all = [
            "apps/auth-service/x.ts",
            "apps/farm-service/x.ts",
            "apps/sensor-service/x.ts",
            "apps/alert-engine/x.ts",
            "apps/billing-service/x.ts",
            "apps/messaging-service/x.ts",
            "apps/hr-service/x.ts",
            "apps/ai-service/x.ts",
            "apps/admin-api-service/x.ts",
            "apps/gateway-api/x.ts",
            "web/x.tsx",
            "sens-api-gateway/x.rs",
        ]
        cap = 3
        result = select_specialist_agents(
            touched_services=touched_all,
            pressures=[],
            profile="standard",
            max_specialists_per_cycle=cap,
        )
        self.assertLessEqual(
            len(result), cap,
            msg=(
                f"max_specialists_per_cycle={cap} MUST truncate. "
                f"Got {len(result)}: {result}"
            ),
        )
        # And truncation must be deterministic (sorted, lowest tier first).
        result_again = select_specialist_agents(
            touched_services=touched_all,
            pressures=[],
            profile="standard",
            max_specialists_per_cycle=cap,
        )
        self.assertEqual(
            result, result_again,
            msg="Truncation MUST be deterministic across calls",
        )


if __name__ == "__main__":
    unittest.main()
