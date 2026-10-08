"""ARIA-HIGH-346 — a native submit of an unanchored request reconciles.

Measured on aria-agent-executor runs 37205463513 and 37221168808
(2026-10-04): every HUMAN_REQUIRED adjudication panel seat
(`AIR-aria-evidence-judge-86a41b2ac632`,
`AIR-aria-adversarial-judge-0ef27e14e5ef`) ran, passed pre-submit
validation and was ACCEPTED by the kernel, then the executor's
reconciliation refused it with
`native_runtime_result_request_evidence_unavailable` and the drain counted
`drain_child_without_summary rc=1` — harness_failed=1, every executor job
red.

The panel mint (`human_required_adjudication.open_adjudication`) names no
`target_sha`: an escalation is adjudicated on its record, not on a tree,
and an unanchored request is legitimate (ORPHAN-CRITICAL-495,
ARIA-HIGH-241). The kernel writes such a request's accepted row with
`target_sha == ""` (`str(request.get("target_sha") or "")`); the executor's
proof compared the row against the RAW request field, `None`, so
`"" != None` refused every unanchored request on the native route. HR
adjudication is the role that is ALWAYS minted unanchored, which is why it
was the role that turned every run red.

The fix is one projection, owned by the kernel
(`agent_invocations.accepted_result_request_binding`): the accepted-row
constructor writes it and the executor's proof compares against it, so the
two cannot disagree on the spelling of "no anchor". The proof is not
weakened: an unanchored request still needs a row bound to NO anchor, and
an anchored request still needs its exact SHA.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any

from aria_kernel import agent_invocations as ai
from aria_kernel import human_required_adjudication as hra
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.agent_surface import DISPATCHABLE_ROLES, ROLE_TARGET_PAIRING
from aria_kernel.runtime_profiles import load_provider_routing
from aria_kernel.tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir
from aria_kernel.request_admission import admit_request
from tests._helpers.adjudication import adjudicator_agent_text
from tests._helpers.declared_fixtures import sha256_file
from tests._helpers.executor_module import load_ci_executor

_EXECUTOR = load_ci_executor("ci_executor_native_reconcile_unanchored")

_SESSION_ID = "native-session-fixture"
_POLICY_DIGEST = "sha256:" + "ab" * 32

# A dispatchable role the native route cannot serve is declared HERE with
# the reason, never silently skipped. Empty: the provider routing table
# (`runtime_profiles._validate_routing`) refuses to load unless every
# dispatchable role is routed, so every dispatchable role is native.
NON_NATIVE_ROLES: dict[str, str] = {}


def _git_environment() -> dict[str, str]:
    """The caller's environment without any GIT_* the host leaked in."""
    return {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}


def _seed_repo(root: Path) -> tuple[Path, str]:
    repo = root / "repo"
    repo.mkdir()
    (repo / "src.txt").write_text("alpha\nbeta\n", encoding="utf-8")
    environment = _git_environment()
    for argv in (
        ["init", "-q"],
        ["config", "user.email", "aria-test@example.invalid"],
        ["config", "user.name", "ARIA Test"],
        ["add", "src.txt"],
        ["commit", "-q", "-m", "fixture: evidence"],
    ):
        subprocess.run(["git", *argv], cwd=repo, check=True, env=environment)
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, check=True, env=environment,
        capture_output=True, text=True,
    ).stdout.strip()
    return repo, head


class _NativeSubmitFixture(unittest.TestCase):
    """A real mint, claim and kernel submit; the native attempt row is the
    executor's one input that is written here, in the executor's shape."""

    def setUp(self) -> None:
        scratch = tempfile.TemporaryDirectory(prefix="aria-native-reconcile-")
        self.addCleanup(scratch.cleanup)
        self.repo, self.head = _seed_repo(Path(scratch.name))
        self.tools = ensure_tools_dir(self.repo / "aria-tools")
        self.agent_id = "ci-executor:gha-native-reconcile"

    def _mint_seat(self, target_agent: str) -> dict[str, Any]:
        # The panel mint's own arguments (open_adjudication): no target_sha.
        escalation = "consensus-d0b717b37a33ee24"
        return ai.create_agent_invocation_request(
            target_agent=target_agent, role=hra.ADJUDICATION_ROLE,
            suggested_prompt=f"Adjudicate HUMAN_REQUIRED escalation {escalation}.",
            must_satisfy=[{"id": f"adjudicate-{escalation}",
                           "description": "verdict is one of resolve/refuse/insufficient_evidence"}],
            allowed_scope=[f"human-required:{escalation}"],
            evidence_refs=[f"human-required:{escalation}"],
            base_dir=self.tools,
            admission=admit_request("operator_cli.request", hra.ADJUDICATION_ROLE, base_dir=self.tools),
        )

    def _seat_text(self, request: dict[str, Any]) -> str:
        """A panel seat's final message, in the live envelope's shape: the
        matrix row the mint asked for and the verdict under
        details.adjudication (the live sealed output of
        AIR-aria-adversarial-judge-0ef27e14e5ef carries exactly these)."""
        ref = request["evidence_refs"][0]
        return json.dumps({
            "status": "submitted",
            "satisfaction_matrix": [{"id": request["must_satisfy"][0]["id"], "verdict": "satisfied",
                                     "evidence_refs": [ref]}],
            "evidence_refs": [ref],
            "details": json.loads(adjudicator_agent_text(
                verdict="insufficient_evidence", rationale=f"{ref} carries no clearing evidence",
            ))["details"],
        })

    def _mint_judge(self, *, target_sha: str | None) -> dict[str, Any]:
        return ai.create_agent_invocation_request(
            target_agent="aria-evidence-judge", role="evidence_judgment",
            suggested_prompt="Validate the supplied source line.",
            must_satisfy=[{"id": "src-line", "description": "cite the first source line"}],
            allowed_scope=["**"], evidence_refs=["src.txt:1"],
            convergence_id="native-reconcile", target_sha=target_sha, base_dir=self.tools,
            admission=admit_request("operator_cli.request", "evidence_judgment", base_dir=self.tools),
        )

    def _judge_text(self) -> str:
        return json.dumps({
            "status": "submitted",
            "satisfaction_matrix": [{"id": "src-line", "verdict": "satisfied",
                                     "evidence_refs": ["src.txt:1"], "evidence": "alpha"}],
            "evidence_refs": ["src.txt:1"],
            "details": {"verdict": "true_positive", "confidence": 0.9},
        })

    def _submit_native(self, request: dict[str, Any], *, agent_text: str) -> dict[str, Any]:
        """Claim, record the native attempt, seal the executor's envelope and
        submit it through the kernel — the order the native path runs in."""
        claim = ai.claim_request(
            request_id=request["request_id"], agent_id=self.agent_id, base_dir=self.tools,
        )
        claims = [row for row in load_declared_jsonl(
            self.tools / "agent-invocations/claims.jsonl", expected_surface="agent_invocation_claims",
        ) if row.get("claim_id") == claim["claim_id"] and row.get("event") == "claimed"]
        attempt = append_tools_governance(self.tools, "runtime_attempt_started", {
            "schema_version": 1, "request_id": request["request_id"],
            "request_ledger_hash": request["ledger_hash"], "claim_id": claim["claim_id"],
            "claim_ledger_hash": claims[0]["ledger_hash"], "agent_id": self.agent_id,
            "session_id": _SESSION_ID, "policy_digest": _POLICY_DIGEST,
        })
        envelope = _EXECUTOR._build_envelope_from_claude_output(
            raw_stdout=agent_text, request_id=request["request_id"], claim_id=claim["claim_id"],
            agent_id=self.agent_id, role=request["role"], subagent_type=request["target_agent"],
            must_satisfy=request.get("must_satisfy") or [], dispatch_model=None,
        )
        envelope["details"]["runtime_attempt_ledger_hash"] = attempt["ledger_hash"]
        output = Path(request["expected_output_path"])
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(envelope), encoding="utf-8")
        transcript = output.with_suffix(".transcript.txt")
        transcript.write_text(f"fixture transcript for {claim['claim_id']}\n", encoding="utf-8")
        submitted = ai.submit_claim_result(
            claim_id=claim["claim_id"], agent_id=self.agent_id, lease_token=claim["lease_token"],
            output_path=output, workspace_root=self.repo, base_dir=self.tools,
            context_hash=str(request["context_hash"]), prompt_hash=str(request["prompt_hash"]),
            transcript_hash=sha256_file(transcript),
            transcript_artifact_ref=transcript.resolve().as_posix(),
        )
        self.assertEqual(submitted["status"], "accepted", submitted)
        return {"claim": claim, "attempt": attempt, "row": submitted["row"]}

    def _reconcile(self, request: dict[str, Any], claim_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
        return _EXECUTOR._accepted_native_runtime_result(
            tools_dir=self.tools, request_id=request["request_id"], claim_id=claim_id,
            agent_id=self.agent_id, session_id=_SESSION_ID, policy_digest=_POLICY_DIGEST,
        )


class HumanRequiredAdjudicationSeatReconcilesTests(_NativeSubmitFixture):
    """The measured defect, on the measured role and seat."""

    def test_every_panel_seat_native_submit_reconciles(self) -> None:
        seats = ROLE_TARGET_PAIRING[hra.ADJUDICATION_ROLE]
        self.assertIn("aria-adversarial-judge", seats)
        self.assertIn("aria-evidence-judge", seats)
        for seat in seats:
            with self.subTest(seat=seat):
                request = self._mint_seat(seat)
                self.assertIsNone(request.get("target_sha"))
                native = self._submit_native(request, agent_text=self._seat_text(request))
                accepted, attempt = self._reconcile(request, native["claim"]["claim_id"])
                self.assertEqual(accepted["ledger_hash"], native["row"]["ledger_hash"])
                self.assertEqual(attempt["ledger_hash"], native["attempt"]["ledger_hash"])


class RequestEvidenceProofStaysExactTests(_NativeSubmitFixture):
    """The projection is the kernel's spelling of the request, not a looser
    comparison: a row bound to the wrong anchor is still refused."""

    def test_an_anchored_request_reconciles_at_its_exact_sha(self) -> None:
        request = self._mint_judge(target_sha=self.head)
        native = self._submit_native(request, agent_text=self._judge_text())
        self.assertEqual(native["row"]["target_sha"], self.head)
        accepted, _ = self._reconcile(request, native["claim"]["claim_id"])
        self.assertEqual(accepted["target_sha"], self.head)

    def test_a_row_bound_to_another_anchor_is_refused(self) -> None:
        request = self._mint_seat("aria-adversarial-judge")
        native = self._submit_native(request, agent_text=self._seat_text(request))
        forged = dict(native["row"], target_sha=self.head)
        real = ai.accepted_result_for_request
        try:
            ai.accepted_result_for_request = lambda **_: forged
            with self.assertRaisesRegex(GovernanceError, "native_runtime_result_request_evidence_unavailable"):
                self._reconcile(request, native["claim"]["claim_id"])
        finally:
            ai.accepted_result_for_request = real

    def test_the_accepted_row_carries_the_kernel_projection(self) -> None:
        unanchored = self._mint_seat("aria-evidence-judge")
        anchored = self._mint_judge(target_sha=self.head)
        for request, text in ((unanchored, self._seat_text(unanchored)), (anchored, self._judge_text())):
            with self.subTest(target_sha=request.get("target_sha")):
                native = self._submit_native(request, agent_text=text)
                binding = ai.accepted_result_request_binding(request)
                self.assertEqual(
                    {name: native["row"][name] for name in binding}, binding,
                )


class EveryDispatchableRoleIsNativeReconcilableTests(unittest.TestCase):
    """Invariant: every dispatchable role either reaches the native route —
    and then its accepted row, for an anchored AND an unanchored request,
    satisfies the executor's request-evidence proof — or is declared in
    NON_NATIVE_ROLES with the reason."""

    def test_every_dispatchable_role_is_routed_or_declared_non_native(self) -> None:
        routed = set(load_provider_routing().roles)
        for role in sorted(DISPATCHABLE_ROLES):
            with self.subTest(role=role):
                self.assertTrue(
                    role in routed or role in NON_NATIVE_ROLES,
                    f"{role} is dispatchable but neither natively routed nor declared non-native",
                )
                self.assertFalse(role in routed and role in NON_NATIVE_ROLES,
                                 f"{role} is routed natively and declared non-native")
        for role, reason in NON_NATIVE_ROLES.items():
            self.assertIn(role, DISPATCHABLE_ROLES)
            self.assertTrue(reason.strip(), f"{role} declared non-native without a reason")

    def test_every_native_role_accepted_row_satisfies_the_executor_proof(self) -> None:
        routed = set(load_provider_routing().roles)
        anchor = "a" * 40
        for role in sorted(DISPATCHABLE_ROLES & routed):
            for target_sha in (None, "", anchor):
                with self.subTest(role=role, target_sha=target_sha):
                    request = {"request_id": f"AIR-{role}", "role": role, "target_sha": target_sha,
                               "context_hash": "sha256:" + "1" * 64,
                               "prompt_hash": "sha256:" + "2" * 64}
                    row = ai._build_accepted_row(
                        claim_id="claim-1", request_id=request["request_id"], agent_id="agent",
                        role=role, output_path="out.md", output_hash="sha256:" + "3" * 64,
                        envelope_evidence_hash="sha256:" + "4" * 64,
                        **ai.accepted_result_request_binding(request),
                        transcript_hash="sha256:" + "5" * 64, transcript_artifact_ref="t.txt",
                        checked_evidence_count=1,
                    )
                    self.assertIsNone(_EXECUTOR._native_request_evidence_refusal(request, row))
                    # Absent key and explicit None are the same request.
                    if target_sha is None:
                        without = {k: v for k, v in request.items() if k != "target_sha"}
                        self.assertIsNone(_EXECUTOR._native_request_evidence_refusal(without, row))


if __name__ == "__main__":
    unittest.main()
