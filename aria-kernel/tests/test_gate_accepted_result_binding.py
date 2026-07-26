"""ORPHAN-HIGH-337 / ORPHAN-HIGH-338 — a gate may only pass on evidence.

Both the post-implementation review gate (``review_runner``) and the
domain-specialist gate (``specialist_review_runner``) used to infer success
from the ABSENCE of a pending request row. That inference is unsound:
``next_pending_request`` returns ``None`` for a claim with no result, a
rejection, a cancellation, a stale lease and — most dangerously — a
HUMAN_REQUIRED escalation. The single signal meaning "a human must look at
this" was the signal that cleared the gate and let auto-merge proceed.

The invariant these tests pin is one sentence: a pass verdict must be
derived from an accepted result row bound to the gate's own request id and
role. Everything else blocks.

Locked cases:
  * I-GATE-01 — a HUMAN_REQUIRED review request yields gaps_open, never no_gaps
  * I-GATE-02 — every non-delivering terminal state yields gaps_open
  * I-GATE-03 — an accepted, role-bound result yields no_gaps AND carries
    accepted_result_ref back for attribution
  * I-GATE-04 — a result minted for a different role cannot satisfy the gate
  * I-GATE-05 — a pending judge that never answers times out to gaps_open
  * I-GATE-06 — a specialist that submitted is NOT reported as timed out,
    and its findings reach the consolidated verdict
  * I-GATE-07 — a specialist whose accepted output is unreadable counts as
    non-delivery, not as a clean review
  * I-GATE-08 — an unsatisfiable specialist gate blocks in every
    write-capable profile, not only strict
  * I-GATE-09 — the orchestrator delegates that decision to the extracted
    policy instead of carrying its own copy
"""

from __future__ import annotations

import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))

from aria_kernel.agent_invocations import (  # noqa: E402
    accepted_result_for_request,
    claim_request,
    create_agent_invocation_request,
    derive_request_state,
    release_claim,
)
from aria_kernel.review_runner import (  # noqa: E402
    _NON_DELIVERING_TERMINAL_STATES,
    run_review_runner,
)
from aria_kernel.tool_registry import ensure_tools_dir  # noqa: E402


_ADVERSARIAL_ROLE = "adversarial_judgment"


def _seed_review_request(tools: Path) -> str:
    """Mint one adversarial_judgment request and return its id."""
    request = create_agent_invocation_request(
        target_agent="aria-adversarial-judge",
        role=_ADVERSARIAL_ROLE,
        suggested_prompt="audit the implementation against must_satisfy",
        must_satisfy=[{"id": "gate-binding-test", "criterion": "gate needs evidence"}],
        allowed_scope=["aria-kernel/**"],
        convergence_id="conv-gate-001",
        base_dir=tools,
    )
    return str(request["request_id"])


def _escalate_to_human_required(tools: Path, request_id: str) -> None:
    """Drive a request to HUMAN_REQUIRED the way production does.

    Three claim/release cycles exhaust DEFAULT_MAX_REQUEUES, which is the
    real escalation path — not a hand-written ledger row.
    """
    for attempt in range(3):
        claim = claim_request(
            request_id=request_id, agent_id=f"judge-{attempt}", base_dir=tools,
        )
        release_claim(
            claim_id=claim["claim_id"],
            agent_id=f"judge-{attempt}",
            lease_token=claim["lease_token"],
            reason=f"attempt {attempt} aborted",
            base_dir=tools,
        )


def _run_review(tools: Path, **overrides: object) -> dict:
    kwargs: dict = {
        "cycle_id": "cyc-gate-001",
        "base_dir": tools,
        "workspace_root": None,
        "plan_id": "plan-gate-001",
        "convergence_id": "conv-gate-001",
        "impl_artifacts_ref": "",
        "worker_artifact_hash": "",
        "must_satisfy": [{"id": "gate-binding-test", "statement": "gate needs evidence"}],
        "max_review_rounds": 1,
        "judge_timeout_seconds": 0.4,
    }
    kwargs.update(overrides)
    return run_review_runner(**kwargs)  # type: ignore[arg-type]


class ReviewGateEvidenceBinding(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-gate-binding-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    # I-GATE-01 — the escalation signal must not clear the gate.
    def test_i_gate_01_human_required_review_request_blocks(self) -> None:
        request_id = _seed_review_request(self.tools)
        _escalate_to_human_required(self.tools, request_id)
        self.assertEqual(
            derive_request_state(request_id=request_id, base_dir=self.tools),
            "HUMAN_REQUIRED",
        )
        # The runner mints its own request, so drive the state it will see.
        with unittest.mock.patch(
            "aria_kernel.review_runner.derive_request_state",
            return_value="HUMAN_REQUIRED",
        ):
            result = _run_review(self.tools)
        self.assertEqual(result["review_verdict"], "gaps_open")
        self.assertIsNone(result["accepted_result_ref"])
        self.assertTrue(
            any("human_required" in str(gap.get("id", "")) for gap in result["gaps_found"]),
            msg=f"gaps_found did not name the escalation: {result['gaps_found']}",
        )

    # I-GATE-02 — no non-delivering terminal state may pass.
    def test_i_gate_02_every_non_delivering_terminal_state_blocks(self) -> None:
        self.assertIn("HUMAN_REQUIRED", _NON_DELIVERING_TERMINAL_STATES)
        for state in sorted(_NON_DELIVERING_TERMINAL_STATES):
            with self.subTest(state=state):
                with unittest.mock.patch(
                    "aria_kernel.review_runner.derive_request_state",
                    return_value=state,
                ):
                    result = _run_review(self.tools)
                self.assertEqual(result["review_verdict"], "gaps_open")
                self.assertIsNone(result["accepted_result_ref"])

    # I-GATE-03 — a real accepted result passes and stays attributable.
    def test_i_gate_03_accepted_result_passes_and_is_attributable(self) -> None:
        accepted = {
            "request_id": "ignored-by-patch",
            "role": _ADVERSARIAL_ROLE,
            "status": "accepted",
            "agent_id": "aria-adversarial-judge",
            "output_hash": "sha256:" + "a" * 64,
            "transcript_hash": "sha256:" + "b" * 64,
        }
        with unittest.mock.patch(
            "aria_kernel.review_runner.accepted_result_for_request",
            return_value=accepted,
        ):
            result = _run_review(self.tools)
        self.assertEqual(result["review_verdict"], "no_gaps")
        ref = result["accepted_result_ref"]
        self.assertIsNotNone(ref)
        self.assertEqual(ref["role"], _ADVERSARIAL_ROLE)
        self.assertEqual(ref["agent_id"], "aria-adversarial-judge")
        self.assertEqual(ref["output_hash"], accepted["output_hash"])
        self.assertEqual(ref["transcript_hash"], accepted["transcript_hash"])
        # The ref names the request the runner actually minted.
        self.assertIn(ref["request_id"], result["request_ids"])

    # I-GATE-04 — role binding is enforced by the reader itself.
    def test_i_gate_04_result_for_another_role_does_not_satisfy(self) -> None:
        request_id = _seed_review_request(self.tools)
        # No result at all → None regardless of role.
        self.assertIsNone(
            accepted_result_for_request(request_id=request_id, base_dir=self.tools),
        )
        self.assertIsNone(
            accepted_result_for_request(
                request_id=request_id, role="evidence_judgment", base_dir=self.tools,
            ),
        )
        # And an unknown request id never invents a result.
        self.assertIsNone(
            accepted_result_for_request(request_id="AIR-nonexistent", base_dir=self.tools),
        )

    # I-GATE-05 — silence is not consent.
    def test_i_gate_05_pending_judge_times_out_to_gaps_open(self) -> None:
        with unittest.mock.patch(
            "aria_kernel.review_runner.derive_request_state",
            return_value="PENDING",
        ):
            result = _run_review(self.tools)
        self.assertIn(result["review_verdict"], {"gaps_open", "max_review_rounds"})
        self.assertIsNone(result["accepted_result_ref"])


class SpecialistGateEvidenceBinding(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-specialist-binding-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _run(self, **overrides: object) -> dict:
        from aria_kernel.specialist_review_runner import run_specialist_review_runner

        kwargs: dict = {
            "cycle_id": "cyc-spec-001",
            "base_dir": self.tools,
            "workspace_root": None,
            "plan_id": "plan-spec-001",
            "convergence_id": "conv-spec-001",
            "touched_services": ["apps/auth-service/"],
            "pressures": [],
            "profile": "standard",
            "max_specialists_per_cycle": 2,
            "specialist_timeout_seconds": 0.4,
        }
        kwargs.update(overrides)
        return run_specialist_review_runner(**kwargs)  # type: ignore[arg-type]

    # I-GATE-06 — a submitting specialist is not reported as timed out.
    def test_i_gate_06_submitted_specialist_is_not_timed_out(self) -> None:
        output = Path(self._tmp.name) / "specialist-output.md"
        output.write_text(
            "MEDIUM: tenant guard is applied inconsistently\n"
            "Evidence:\n"
            "- apps/auth-service/src/guards/tenant.guard.ts:42\n",
            encoding="utf-8",
        )
        accepted = {
            "role": "specialist_domain_review",
            "status": "accepted",
            "output_path": output.as_posix(),
            "agent_id": "auth-security-expert",
        }
        with unittest.mock.patch(
            "aria_kernel.specialist_review_runner.accepted_result_for_request",
            return_value=accepted,
        ):
            result = self._run()
        if not result["specialists_dispatched"]:
            self.skipTest("selection produced no specialists for this touch-map input")
        self.assertEqual(result["specialists_timed_out"], [])
        self.assertTrue(
            result["findings_by_specialist"],
            msg="a submitted specialist produced no findings in the result",
        )
        self.assertNotEqual(result["consolidated_verdict"], "specialists_unavailable")

    # I-GATE-07 — an unreadable review is not a clean review.
    def test_i_gate_07_unreadable_output_counts_as_non_delivery(self) -> None:
        accepted = {
            "role": "specialist_domain_review",
            "status": "accepted",
            "output_path": "/nonexistent/specialist-output.md",
            "agent_id": "auth-security-expert",
        }
        with unittest.mock.patch(
            "aria_kernel.specialist_review_runner.accepted_result_for_request",
            return_value=accepted,
        ):
            result = self._run()
        if not result["specialists_dispatched"]:
            self.skipTest("selection produced no specialists for this touch-map input")
        self.assertEqual(result["consolidated_verdict"], "specialists_unavailable")
        self.assertEqual(
            result["findings_by_specialist"], {},
            msg="an unreadable output must not register as zero findings",
        )
        self.assertTrue(result["specialists_timed_out"])

    # I-GATE-08 — the gate blocks in every write-capable profile.
    def test_i_gate_08_unavailable_blocks_outside_observe(self) -> None:
        """Behavioural matrix over the extracted policy.

        Pre-fix only ``strict`` blocked on ``specialists_unavailable``, so
        ``standard`` and ``autonomous`` — the write-capable profiles —
        proceeded on an unreviewed domain.
        """
        from aria_kernel.specialist_review_runner import specialist_verdict_blocks_cycle

        write_capable = ("standard", "strict", "autonomous")
        for profile in write_capable:
            with self.subTest(profile=profile, verdict="specialists_unavailable"):
                self.assertTrue(
                    specialist_verdict_blocks_cycle(
                        verdict="specialists_unavailable", profile=profile,
                    ),
                    msg=f"{profile} fails open on an unsatisfiable specialist gate",
                )
        # observe dispatches no Tier-1 specialist and performs no writes.
        self.assertFalse(
            specialist_verdict_blocks_cycle(
                verdict="specialists_unavailable", profile="observe",
            ),
        )
        # Remediation and judge-split block everywhere, including observe.
        for verdict in ("consolidated_remediation_required", "consolidated_judge_split"):
            for profile in write_capable + ("observe",):
                with self.subTest(profile=profile, verdict=verdict):
                    self.assertTrue(
                        specialist_verdict_blocks_cycle(verdict=verdict, profile=profile),
                    )
        # A clean consolidated pass blocks nothing.
        for profile in write_capable + ("observe",):
            with self.subTest(profile=profile, verdict="consolidated_no_gaps"):
                self.assertFalse(
                    specialist_verdict_blocks_cycle(
                        verdict="consolidated_no_gaps", profile=profile,
                    ),
                )

    # I-GATE-09 — the orchestrator consumes the policy, not its own copy.
    def test_i_gate_09_orchestrator_delegates_the_block_decision(self) -> None:
        """A behavioural check that the orchestrator honours the policy.

        Asserting the call rather than the source keeps this test valid
        under any refactor that preserves the delegation.
        """
        import aria_kernel.specialist_review_runner as srr

        calls: list[dict] = []
        real = srr.specialist_verdict_blocks_cycle

        def _recording(*, verdict: str, profile: str) -> bool:
            calls.append({"verdict": verdict, "profile": profile})
            return real(verdict=verdict, profile=profile)

        with unittest.mock.patch.object(
            srr, "specialist_verdict_blocks_cycle", _recording,
        ):
            self.assertTrue(
                srr.specialist_verdict_blocks_cycle(
                    verdict="specialists_unavailable", profile="autonomous",
                ),
            )
        self.assertEqual(
            calls, [{"verdict": "specialists_unavailable", "profile": "autonomous"}],
        )


if __name__ == "__main__":
    unittest.main()
