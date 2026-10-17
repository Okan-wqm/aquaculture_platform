"""ARIA-HIGH-540 — a credential refusal on the implementation-delivery path withholds the refused bytes.

THE DEFECT. The delivery decides the envelope with the submit's own chain
(``agent_invocations.judge_claim_submission``, stage ``result_admissible``)
before it spends any authority, and a verdict carrying a credential code
(``secret_in_envelope``, one of ``agent_invocations.CREDENTIAL_REFUSAL_CODES``)
refused the delivery. The executor then recorded governance and HUMAN_REQUIRED
and released the claim, and never submitted. ``submit_claim_result`` is the
only caller of the withholding owner (``_build_rejection_row`` and
``_withhold_submission_sources``, ARIA-HIGH-515), so the refused envelope and
its transcript stayed at the request's ``expected_output_path`` on the
published outputs surface, no row recorded their digests, and the publish gate
(``runtime_artifacts._verify_withheld_outputs``) reported the store valid.

WHAT IS PINNED, through the real ``deliver_implementation`` and the
executor's own refusal terminal (``ci_executor._close_refused_delivery``,
whose submit is the real kernel CLI child):

* a credential refusal leaves no refused byte in the store: the kernel's one
  owner records the withheld row (``output_withheld``, both sources with
  their digests) and deletes the envelope and the transcript, the publish
  gate stays valid, and the refusal is still escalated for a person and
  settled, with no release attempted on the claim the row made terminal;
* the refusal names its verdict's codes (``rejection_codes``) and says
  whether they withhold (``withholds_output``), decided by the one closed set;
* a refusal that is not a credential verdict is released and escalated as
  before, nothing is submitted and nothing is withheld (no over-withholding:
  the submit would otherwise be asked to decide an envelope the delivery
  refused for another reason).

The envelope and the transcript are written with plain ``json.dumps``, not
through the executor's sanitized writers: the kernel's refusal is the last
line for any producer, and coupling this pin to the scrubber's coverage
would make it stop reproducing the refusal once the boundary improves.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest import mock

from aria_kernel.implementation_delivery import RESULT_ADMISSIBLE_STAGE, ImplementationDeliveryRefusal
from aria_kernel.ledger import load_jsonl
from aria_kernel.runtime_artifacts import verify_runtime_artifacts
from tests._helpers.operator_acts import operator_set_profile
from tests.test_implementation_delivery import _DeliveredBranch

_POC_DIR = Path(__file__).resolve().parents[2] / "tools" / "aria-poc"
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))

import ci_executor  # noqa: E402

# Synthetic credential shapes the kernel's refusal set matches, split so this
# file never carries a literal the repository's own secret scanners flag.
_KEY_HEADER = "-----BEGIN OPENSSH " + "PRIVATE KEY-----"
_DB_PASSWORD = "DATABASE_" + "PASSWORD=" + "Zq7" * 7
_MARKERS = (_KEY_HEADER.encode("utf-8"), ("Zq7" * 3).encode("utf-8"))


class _RefusedDeliveryFixture(_DeliveredBranch):
    """A production-minted implementation request, claimed, with a planned
    change that intends the file the signed tip touched: the scope verdict
    admits the diff, so the result's admissibility is the next decision."""

    def setUp(self) -> None:
        from aria_kernel.agent_invocations import claim_request
        from aria_kernel.change_ledger import emit_change_planned
        from aria_kernel.implementation_safety import sandbox_backend
        from tests._helpers.production_shaped import production_implementation_request

        if sandbox_backend() is None:
            self.skipTest("bwrap is not usable on this host")
        super().setUp()
        operator_set_profile("strict", base_dir=self.tools, scheduler_ceiling="strict")
        self.request = production_implementation_request(
            tools_dir=self.tools, workspace_root=self.repo, plan_id="plan-withheld",
            allowed_path="src/app.ts", base_sha=self.base,
        )
        self.request_id = self.request["request_id"]
        self.claim = claim_request(request_id=self.request_id, agent_id="aria-implementer", base_dir=self.tools)
        planned = emit_change_planned(
            plan_id="plan-withheld", finding_id="F-withheld", intended_affected_files=["src/app.ts"],
            intended_validation_refs=[], architectural_tier=1, base_dir=self.tools,
        )
        self.ids = {**self.ids, "change_id": planned["change_id"]}
        self.output = Path(self.request["expected_output_path"])
        self.transcript = self.output.with_suffix(".transcript.jsonl")
        self.runner_temp = self.root / "runner-temp"
        self.runner_temp.mkdir()

    def _envelope(self, *, evidence_ref: str = "src/app.ts:1", note: str | None = None) -> dict:
        matrix = [{"id": item["id"], "verdict": "satisfied", "evidence_refs": [evidence_ref]}
                  for item in self.request["must_satisfy"]]
        details: dict = {"implementation": {}}
        if note is not None:
            details["note"] = note
        return {
            "$schema": "aria/agent-response/v1", "request_id": self.request_id,
            "claim_id": self.claim["claim_id"], "agent_id": self.claim["agent_id"], "role": "implementation",
            "status": "submitted", "satisfaction_matrix": matrix, "evidence_refs": [evidence_ref],
            "details": details,
        }

    def _refuse(self, envelope: dict, *, transcript: str) -> ImplementationDeliveryRefusal:
        """The agent's files as a lane left them, then the real delivery,
        handed both as the executor hands them."""
        self.output.parent.mkdir(parents=True, exist_ok=True)
        self.output.write_text(json.dumps(envelope), encoding="utf-8")
        self.transcript.write_text(transcript, encoding="utf-8")
        return self._deliver(
            request_id=self.request_id, claim_id=self.claim["claim_id"], agent_id=self.claim["agent_id"],
            envelope=envelope, output_path=self.output, transcript_path=self.transcript,
        )

    def _close(self, refused: ImplementationDeliveryRefusal) -> tuple[int, str]:
        """The executor's refusal terminal, as ``_main`` calls it."""
        stderr = io.StringIO()
        with mock.patch.dict(os.environ, {"RUNNER_TEMP": str(self.runner_temp)}), contextlib.redirect_stderr(stderr):
            code = ci_executor._close_refused_delivery(
                exc=refused, tools_dir=self.tools, repo=self.repo, request=self.request, request_id=self.request_id,
                target_agent="aria-implementer", claim_id=self.claim["claim_id"], agent_id=self.claim["agent_id"],
                lease_token=self.claim["lease_token"], expected_output_path=self.output,
                transcript_output_path=self.transcript,
            )
        return code, stderr.getvalue()

    def _store_files_holding_the_credential(self) -> list[str]:
        return sorted(
            path.relative_to(self.tools).as_posix() for path in self.tools.rglob("*")
            if path.is_file() and not path.is_symlink() and any(marker in path.read_bytes() for marker in _MARKERS)
        )

    def _result_rows(self) -> list[dict]:
        path = self.tools / "agent-invocations" / "results.jsonl"
        return [row for row in load_jsonl(path) if row.get("claim_id") == self.claim["claim_id"]] if path.is_file() else []

    def _claim_events(self) -> list[str]:
        return [str(row.get("event")) for row in load_jsonl(self.tools / "agent-invocations" / "claims.jsonl")
                if row.get("claim_id") == self.claim["claim_id"]]

    def _human_required(self) -> dict:
        return json.loads((self.tools / "human-required" / f"{self.request_id}.json").read_text(encoding="utf-8"))

    def _summary(self) -> dict:
        return json.loads((self.runner_temp / f"dispatch-result-{self.request_id}.json").read_text(encoding="utf-8"))


class ACredentialRefusalOnTheDeliveryPathIsWithheldTests(_RefusedDeliveryFixture):
    def test_the_refused_envelope_and_transcript_leave_the_store_through_the_one_owner(self) -> None:
        refused = self._refuse(
            self._envelope(note=_KEY_HEADER + "\n" + _DB_PASSWORD),
            transcript='{"type":"tool_result","content":"' + _DB_PASSWORD + '"}\n',
        )
        self.assertEqual(refused.stage, RESULT_ADMISSIBLE_STAGE)
        self.assertTrue(refused.reason.startswith("result_rejected:secret_in_envelope"), refused.reason)
        self.assertIn("secret_in_envelope", refused.rejection_codes)
        self.assertTrue(self._store_files_holding_the_credential(), "the fixture must hold the refused bytes")

        code, stderr = self._close(refused)

        self.assertEqual(code, ci_executor.REFUSAL_EXIT_CODE, stderr)
        # The kernel's withholding owner ran: no refused byte anywhere in the
        # store, the raw envelope and transcript gone, the row withheld with
        # both digests for the publish gate.
        self.assertEqual(self._store_files_holding_the_credential(), [], stderr)
        self.assertFalse(self.output.exists())
        self.assertFalse(self.transcript.exists())
        rows = self._result_rows()
        self.assertEqual(len(rows), 1, rows)
        self.assertEqual(rows[0]["status"], "rejected")
        self.assertIn("secret_in_envelope", rows[0]["rejection_codes"])
        self.assertIsNone(rows[0]["output_path"])
        self.assertEqual(rows[0]["output_withheld"], "credential_refusal")
        self.assertEqual(
            sorted(source["path"] for source in rows[0]["withheld_sources"]),
            sorted(path.relative_to(self.tools).as_posix() for path in (self.output, self.transcript)),
        )
        self.assertTrue(verify_runtime_artifacts(base_dir=self.tools, workspace_root=self.repo)["valid"])
        # Escalated as before: a person decides; the refusal's text carries
        # counts, never a value.
        record = self._human_required()
        self.assertEqual(record["context"]["code"], f"implementation_delivery_refused:{RESULT_ADMISSIBLE_STAGE}")
        self.assertNotIn("Zq7Zq7", json.dumps(record))
        # The row made the claim terminal: no release was attempted, so no
        # refused release on stderr.
        self.assertNotIn("released", self._claim_events())
        self.assertNotIn("could not release", stderr)
        self.assertEqual(self._summary()["outcome"], "refused")
        # The plan is settled by the refusal's verified class.
        from aria_kernel.plan_convergence import fold_plan_state

        self.assertEqual(fold_plan_state(plan_id="plan-withheld", base_dir=self.tools)["state"], "IMPLEMENTATION_REJECTED")

    def test_the_refusal_names_its_verdict_codes_and_whether_they_withhold(self) -> None:
        refused = self._refuse(self._envelope(note=_KEY_HEADER), transcript='{"t":1}\n')
        self.assertIn("secret_in_envelope", refused.rejection_codes)
        self.assertTrue(refused.withholds_output)
        # A refusal raised without a verdict withholds nothing.
        self.assertFalse(ImplementationDeliveryRefusal("apply_gate", "gate_blocked:x").withholds_output)
        self.assertEqual(ImplementationDeliveryRefusal("apply_gate", "gate_blocked:x").rejection_codes, ())


class ACredentialInTheTranscriptIsRefusedByTheDeliveryTests(_RefusedDeliveryFixture):
    """ARIA-HIGH-524 — the delivery judges the transcript the executor will
    submit with the same chain as the submit (``judge_claim_submission``), so
    a clean envelope whose transcript carries a credential is refused before
    the suite, the push and the PR, and withheld like an envelope's leak."""

    def test_the_transcript_is_judged_before_any_authority_and_withheld(self) -> None:
        refused = self._refuse(self._envelope(), transcript='{"type":"tool_result","content":"' + _DB_PASSWORD + '"}\n')
        self.assertEqual(refused.stage, RESULT_ADMISSIBLE_STAGE)
        self.assertEqual(refused.rejection_codes, ("secret_in_transcript",))
        self.assertTrue(refused.withholds_output)
        self.assertFalse((self.tools / "apply").exists(), "the suite ran for a refused transcript")

        code, stderr = self._close(refused)

        self.assertEqual(code, ci_executor.REFUSAL_EXIT_CODE, stderr)
        self.assertEqual(self._store_files_holding_the_credential(), [], stderr)
        rows = self._result_rows()
        self.assertEqual([(row["rejection_codes"], row["output_withheld"]) for row in rows],
                         [(["secret_in_transcript"], "credential_refusal")])
        self.assertTrue(verify_runtime_artifacts(base_dir=self.tools, workspace_root=self.repo)["valid"])


class ARefusalThatIsNotACredentialVerdictIsReleasedAsBeforeTests(_RefusedDeliveryFixture):
    def test_nothing_is_submitted_or_withheld_and_the_release_escalates(self) -> None:
        envelope = self._envelope(evidence_ref="src/app.ts:4000")
        refused = self._refuse(envelope, transcript='{"t":1}\n')
        self.assertTrue(refused.reason.startswith("result_rejected:agent_evidence_line_missing:"), refused.reason)
        self.assertFalse(refused.withholds_output)

        code, stderr = self._close(refused)

        self.assertEqual(code, ci_executor.REFUSAL_EXIT_CODE, stderr)
        self.assertEqual(self._result_rows(), [], "a non-credential refusal is never submitted")
        self.assertTrue(self.output.exists())
        self.assertTrue(self.transcript.exists())
        self.assertIn("human_required", self._claim_events())
        self.assertEqual(self._human_required()["context"]["code"], f"implementation_delivery_refused:{RESULT_ADMISSIBLE_STAGE}")
        self.assertEqual(self._summary()["outcome"], "refused")


class ADiffSecretRefusalStillWithholdsACredentialEnvelopeTests(_RefusedDeliveryFixture):
    """ARIA-LOW-575 — the patch's secret scan (stage 1a) refused first and by
    name, and never asked the result's verdict (1b): an envelope or
    transcript that ALSO carried a credential got a refusal without the
    verdict's codes, so the executor released without a submit and the
    refused bytes stayed under outputs/ with no withheld row. The diff's
    refusal keeps its name and its precedence, and carries the verdict's
    codes when the verdict refused the envelope too."""

    _LEAKED = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"

    def _commit_a_secret_shaped_diff(self) -> None:
        from tests._helpers.git_fixtures import _git
        from tests.test_implementation_delivery import _commit_signed_with

        _git(["reset", "-q", "--hard", self.base], cwd=self.repo)
        _commit_signed_with(self.repo, self.kernel_key, message="feat: leak", path="src/app.ts",
                            body=f"export const app = false; // {self._LEAKED}\n")

    def test_a_credential_envelope_behind_a_secret_shaped_diff_is_withheld(self) -> None:
        self._commit_a_secret_shaped_diff()
        refused = self._refuse(
            self._envelope(note=_KEY_HEADER + "\n" + _DB_PASSWORD),
            transcript='{"type":"tool_result","content":"' + _DB_PASSWORD + '"}\n',
        )
        self.assertEqual(refused.stage, RESULT_ADMISSIBLE_STAGE)
        self.assertTrue(refused.reason.startswith("diff_secret_shaped:"), refused.reason)
        self.assertNotIn(self._LEAKED, refused.reason)
        self.assertIn("secret_in_envelope", refused.rejection_codes)
        self.assertTrue(refused.withholds_output)

        code, stderr = self._close(refused)

        self.assertEqual(code, ci_executor.REFUSAL_EXIT_CODE, stderr)
        self.assertEqual(self._store_files_holding_the_credential(), [], stderr)
        self.assertFalse(self.output.exists())
        self.assertFalse(self.transcript.exists())
        self.assertEqual([row["output_withheld"] for row in self._result_rows()], ["credential_refusal"])
        self.assertTrue(verify_runtime_artifacts(base_dir=self.tools, workspace_root=self.repo)["valid"])

    def test_a_clean_envelope_behind_a_secret_shaped_diff_withholds_nothing(self) -> None:
        self._commit_a_secret_shaped_diff()
        refused = self._refuse(self._envelope(), transcript='{"t":1}\n')
        self.assertTrue(refused.reason.startswith("diff_secret_shaped:"), refused.reason)
        self.assertEqual(refused.rejection_codes, ())
        self.assertFalse(refused.withholds_output)
