"""ORPHAN-HIGH-422 / ORPHAN-HIGH-423 — a gate may only pass on evidence.

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
  * I-GATE-07b/c — a zero-finding review must ASSERT itself; unparseable
    output is non-delivery, and an asserted clean review still passes
  * I-GATE-08 — an unsatisfiable specialist gate blocks in every
    write-capable profile, not only strict
  * I-GATE-09 — the orchestrator delegates that decision to the extracted
    policy instead of carrying its own copy
"""

from __future__ import annotations

import ast
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
    ReviewResult,
    run_review_runner,
)
from aria_kernel.specialist_review_runner import (  # noqa: E402
    SpecialistReviewResult,
    run_specialist_review_runner,
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


def _run_review(tools: Path, **overrides: object) -> ReviewResult:
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
    return run_review_runner(**kwargs)


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
    # Since the audit's transport-acceptance fix, "passes" additionally
    # requires the judge's SEALED payload to carry an explicit
    # `VERDICT: no_gaps` line and to hash to the row's output_hash —
    # acceptance alone says the judge ran, never what it concluded.
    def test_i_gate_03_accepted_result_passes_and_is_attributable(self) -> None:
        import hashlib

        payload = "adversarial audit complete\n\nVERDICT: no_gaps\n"
        output_hash = "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()
        output_rel = "agent-invocations/outputs/content-addressed/responses/gate03.md"
        output_file = self.tools / output_rel
        output_file.parent.mkdir(parents=True, exist_ok=True)
        output_file.write_text(payload, encoding="utf-8")
        accepted = {
            "request_id": "ignored-by-patch",
            "role": _ADVERSARIAL_ROLE,
            "status": "accepted",
            "agent_id": "aria-adversarial-judge",
            "output_path": output_rel,
            "output_hash": output_hash,
            "transcript_hash": "sha256:" + "b" * 64,
        }
        with unittest.mock.patch(
            "aria_kernel.review_runner.accepted_result_for_request",
            return_value=accepted,
        ):
            result = _run_review(self.tools)
        self.assertEqual(result["review_verdict"], "no_gaps")
        ref = result["accepted_result_ref"]
        # A bare assert rather than assertIsNotNone: the latter is not a
        # TypeGuard, so every dereference below stays `dict | None` to the
        # checker. Same assertion, and the narrowing is real.
        assert ref is not None, "a passing review must carry its accepted_result_ref"
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

    # The audit's transport-acceptance reproduction: an accepted row whose
    # payload never said anything (or said gaps_open, or drifted from its
    # own hash) must NOT manufacture a no_gaps.
    def _accepted_without_verdict(self, payload: str | None, output_hash: str | None) -> dict:
        row = {
            "request_id": "ignored-by-patch",
            "role": _ADVERSARIAL_ROLE,
            "status": "accepted",
            "agent_id": "aria-adversarial-judge",
            "transcript_hash": "sha256:" + "b" * 64,
        }
        if payload is not None:
            import hashlib

            output_rel = "agent-invocations/outputs/content-addressed/responses/gate04.md"
            output_file = self.tools / output_rel
            output_file.parent.mkdir(parents=True, exist_ok=True)
            output_file.write_text(payload, encoding="utf-8")
            row["output_path"] = output_rel
            row["output_hash"] = output_hash or (
                "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()
            )
        return row

    def test_accepted_row_without_payload_stays_gaps_open(self) -> None:
        accepted = self._accepted_without_verdict(payload=None, output_hash=None)
        with unittest.mock.patch(
            "aria_kernel.review_runner.accepted_result_for_request",
            return_value=accepted,
        ):
            result = _run_review(self.tools)
        self.assertEqual(result["review_verdict"], "gaps_open")
        self.assertIsNone(result["accepted_result_ref"])

    def test_accepted_payload_without_verdict_line_stays_gaps_open(self) -> None:
        accepted = self._accepted_without_verdict(
            payload="looks fine to me, nothing to flag", output_hash=None,
        )
        with unittest.mock.patch(
            "aria_kernel.review_runner.accepted_result_for_request",
            return_value=accepted,
        ):
            result = _run_review(self.tools)
        self.assertEqual(result["review_verdict"], "gaps_open")

    def test_accepted_payload_saying_gaps_open_stays_gaps_open(self) -> None:
        accepted = self._accepted_without_verdict(
            payload="found a hole in the evidence chain\n\nVERDICT: gaps_open\n",
            output_hash=None,
        )
        with unittest.mock.patch(
            "aria_kernel.review_runner.accepted_result_for_request",
            return_value=accepted,
        ):
            result = _run_review(self.tools)
        self.assertEqual(result["review_verdict"], "gaps_open")

    def test_accepted_payload_hash_drift_stays_gaps_open(self) -> None:
        accepted = self._accepted_without_verdict(
            payload="VERDICT: no_gaps\n",
            output_hash="sha256:" + "c" * 64,  # not the payload's hash
        )
        with unittest.mock.patch(
            "aria_kernel.review_runner.accepted_result_for_request",
            return_value=accepted,
        ):
            result = _run_review(self.tools)
        self.assertEqual(result["review_verdict"], "gaps_open")


class SpecialistGateEvidenceBinding(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-specialist-binding-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _run(self, **overrides: object) -> SpecialistReviewResult:
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
        return run_specialist_review_runner(**kwargs)

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
        # NOT a skipTest. These two cases are the ones that pin ORPHAN-HIGH-423,
        # and the fixture pins the input: touched_services is
        # ["apps/auth-service/"], which _DOMAIN_TOUCH_MAP maps to two
        # specialists. If selection ever returns nothing, the gate under test
        # was never exercised — that has to be red, not green-with-an-asterisk.
        self.assertTrue(
            result["specialists_dispatched"],
            msg="selection produced no specialists, so this gate test asserted nothing",
        )
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
        # NOT a skipTest. These two cases are the ones that pin ORPHAN-HIGH-423,
        # and the fixture pins the input: touched_services is
        # ["apps/auth-service/"], which _DOMAIN_TOUCH_MAP maps to two
        # specialists. If selection ever returns nothing, the gate under test
        # was never exercised — that has to be red, not green-with-an-asterisk.
        self.assertTrue(
            result["specialists_dispatched"],
            msg="selection produced no specialists, so this gate test asserted nothing",
        )
        self.assertEqual(result["consolidated_verdict"], "specialists_unavailable")
        self.assertEqual(
            result["findings_by_specialist"], {},
            msg="an unreadable output must not register as zero findings",
        )
        self.assertTrue(result["specialists_timed_out"])

    # I-GATE-07b — a zero-finding review must be asserted, not inferred.
    def test_i_gate_07b_unparseable_output_is_not_a_clean_review(self) -> None:
        """ORPHAN-HIGH-462 — the perverse incentive this branch created.

        `transform_specialist_output` returns `[]` for anything it cannot
        parse, and `[]` was passed back as "reviewed, found nothing". So a
        specialist whose whole output was an apology was recorded as a clean
        domain review and the consolidated verdict came back
        `consolidated_no_gaps`.

        What makes it worse than a plain fail-open is the surrounding work:
        I-GATE-07 made non-delivery block and I-GATE-08b made an unrecognised
        verdict block, so submitting GARBAGE became strictly better for a
        degraded or hostile agent than submitting nothing. It was the last
        path that still cleared the gate.
        """
        from aria_kernel.specialist_review_runner import (
            _findings_from_accepted_result,
        )

        not_a_review = {
            "an apology": "I ran out of context and could not complete this review.\n",
            "empty": "",
            "unrelated prose": "Some notes.\n\nIt looks fine to me.\n",
            "the word verdict mid-sentence": "My verdict is that things are fine.\n",
        }
        for label, body in not_a_review.items():
            with self.subTest(case=label):
                output = Path(self._tmp.name) / "specialist-output.md"
                output.write_text(body, encoding="utf-8")
                self.assertIsNone(
                    _findings_from_accepted_result(
                        agent_name="auth-security-expert",
                        accepted={"output_path": output.as_posix()},
                        workspace_root=None,
                    ),
                    msg=f"{label!r} was accepted as a review",
                )

    def test_i_gate_07c_an_asserted_clean_review_is_accepted(self) -> None:
        """The other half: the gate must stay satisfiable.

        A gate a clean review cannot pass is not fail-closed, it is broken,
        and it gets disabled. These are the three forms
        `.claude/shared/output-format.md` sanctions.
        """
        from aria_kernel.specialist_review_runner import (
            _findings_from_accepted_result,
        )

        asserted = {
            "## Verdict heading": "## Findings\nNone.\n\n## Verdict\nPASS\n",
            "VERDICT: inline": "No issues found.\n\nVERDICT: PASS\n",
            "RULING: inline": "RULING: no architectural conflict\n",
        }
        for label, body in asserted.items():
            with self.subTest(case=label):
                output = Path(self._tmp.name) / "specialist-output.md"
                output.write_text(body, encoding="utf-8")
                self.assertEqual(
                    _findings_from_accepted_result(
                        agent_name="auth-security-expert",
                        accepted={"output_path": output.as_posix()},
                        workspace_root=None,
                    ),
                    [],
                    msg=f"{label!r} was rejected as non-delivery",
                )

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

    # I-GATE-08b — an unrecognised verdict is not a pass.
    def test_i_gate_08b_unknown_verdict_blocks_outside_observe(self) -> None:
        """ORPHAN-HIGH-443 — the policy is an allowlist, not a denylist.

        The pre-fix body named the blocking verdicts and returned False
        for everything else, so any string the module did not recognise
        was indistinguishable from ``consolidated_no_gaps`` and the cycle
        proceeded to worker_drainer on a domain nobody reviewed.

        This is reachable, not theoretical: ``specialist_review_runner``
        is an injected kwarg with a Protocol contract, and the
        orchestrator reads the verdict via ``dict.get()``, so nothing
        between a runner and this policy constrains the value to the four
        declared verdicts. A typo, a renamed verdict, or a row written by
        a newer build all arrive here as an arbitrary string.
        """
        from aria_kernel.specialist_review_runner import specialist_verdict_blocks_cycle

        unknown = (
            "",  # a missing field defaulted to empty
            "consolidated_no_gap",  # one character off the passing verdict
            "CONSOLIDATED_NO_GAPS",  # right value, wrong case
            "consolidated_pass",  # a verdict from some other schema
            "specialists_partially_available",  # a plausible future value
        )
        for verdict in unknown:
            for profile in ("standard", "strict", "autonomous"):
                with self.subTest(profile=profile, verdict=verdict):
                    self.assertTrue(
                        specialist_verdict_blocks_cycle(
                            verdict=verdict, profile=profile,
                        ),
                        msg=(
                            f"{profile} treats unrecognised verdict {verdict!r} "
                            "as a clean specialist review"
                        ),
                    )

    # I-GATE-09 — the orchestrator consumes the policy, not its own copy.
    def test_i_gate_09_the_orchestrator_callsite_is_covered_elsewhere(self) -> None:
        """ORPHAN-HIGH-455 — this test used to be a tautology.

        It saved `specialist_verdict_blocks_cycle`, patched the module
        attribute with a recording wrapper, then called the thing it had
        just patched and asserted the wrapper recorded the call. The
        orchestrator was never imported. Its docstring said "A behavioural
        check that the orchestrator honours the policy," and it checked no
        such thing — an adversarial audit later demonstrated that reverting
        `autonomy_orchestrator.py` wholesale left the entire 2805-test suite
        green, and this was the one test that claimed to prevent exactly
        that.

        Real coverage now lives in `test_autonomy_orchestrator.py`, which
        drives `run_autonomy_orchestrator` with an injected specialist
        runner and asserts the cycle blocks. Those tests were confirmed to
        fail against the base orchestrator. This one remains only to assert
        the delegation still exists at all — a claim it CAN honestly make,
        and which is cheap to keep here next to the policy it guards.
        """
        import aria_kernel.autonomy_orchestrator as orchestrator

        source = Path(orchestrator.__file__ or "").read_text(encoding="utf-8")
        tree = ast.parse(source)
        imported_names = {
            alias.name
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom)
            and (node.module or "").endswith("specialist_review_runner")
            for alias in node.names
        }
        self.assertIn(
            "specialist_verdict_blocks_cycle",
            imported_names,
            msg="the orchestrator no longer delegates to the extracted policy",
        )


if __name__ == "__main__":
    unittest.main()
