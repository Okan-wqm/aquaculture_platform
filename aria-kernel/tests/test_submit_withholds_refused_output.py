"""ARIA-HIGH-515 — bytes the kernel refused as a credential leak never outlive the submit that refused them.

THE DEFECT. ``judge_claim_submission`` refuses an envelope that carries a
credential (``secret_in_envelope``), and until this fix that verdict was not
linked to what the store keeps: the submit sealed the refused envelope into
``agent-invocations/outputs/content-addressed/responses/`` (the seal ran for
every status), pointed the rejection row at that seal, and left the
executor's raw file at ``expected_output_path`` and its raw transcript beside
it. Both ``.md`` files sit on the ``agent_output_artifacts`` surface that is
published to aria/state (permanent git history) and uploaded in the 30-day
``aria-state-cache-<run>`` Actions artifact. Bytes that were not JSON were
never scanned at all, and ``verify_runtime_artifacts`` (the publish gate)
said ``valid: True`` over a store holding refused credentials.

WHAT IS PINNED HERE, each through the real ``submit_claim_result``:
* a credential refusal leaves no file under ``outputs/**`` and no byte of
  the credential anywhere in the store, and its row says the output was
  withheld (``output_path`` null) while keeping the hashes the §A.1
  idempotency key needs;
* bytes outside the store are never touched, and sealed artifacts are never
  a deletion target;
* unreadable bytes are scanned with the same credential set;
* replay and a crash after the journal both complete without the bytes;
* bytes the verdict never judged are never deleted, a path is deleted only
  as it was named (never through a symlink), and only on the outputs
  surface;
* the verdict's own reasons carry no text derived from the refused bytes,
  for every consumer of the verdict;
* a non-credential rejection is still sealed (no over-withholding);
* the publish gate refuses a store where refused bytes remain, wherever on
  the outputs surface they sit.

The envelopes are written with plain ``json.dumps``, not through the
executor's ``write_sanitized_json``: the kernel's refusal is the last line for
any producer, and coupling this test to the scrubber's coverage (which
NEW-SECRETPUB-4 widens) would make it stop reproducing the refusal once the
boundary improves.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any, Callable
from unittest import mock

from aria_kernel import agent_invocations
from aria_kernel.agent_invocations import (
    claim_request,
    create_agent_invocation_request,
    submit_claim_result,
)
from aria_kernel.ledger import load_jsonl
from aria_kernel.request_admission import admit_request
from aria_kernel.runtime_artifacts import verify_runtime_artifacts
from aria_kernel.state_store import (
    StateStore,
    StateStoreRefusal,
    _refuse_unverified_runtime_artifacts,
    tools_root,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture, sha256_file

# Synthetic credential shapes the kernel's refusal set matches, split so this
# file never carries a literal the repository's own secret scanners flag.
_KEY_HEADER = "-----BEGIN OPENSSH " + "PRIVATE KEY-----"
_DB_PASSWORD = "DATABASE_" + "PASSWORD=" + "Zq7" * 7
_MARKERS = (_KEY_HEADER.encode("utf-8"), ("Zq7" * 3).encode("utf-8"))


def _seed_repo() -> Path:
    repo = Path(tempfile.mkdtemp(prefix="aria-high-515-"))
    (repo / "src.txt").write_text("alpha\nbeta\ngamma\n", encoding="utf-8")
    for argv in (
        ["init", "-q"],
        ["config", "user.email", "aria-test@example.invalid"],
        ["config", "user.name", "ARIA Test"],
        ["add", "src.txt"],
        ["commit", "-q", "-m", "fixture: evidence"],
    ):
        subprocess.run(["git", *argv], cwd=repo, check=True)
    return repo


def _sha256(content: bytes) -> str:
    return "sha256:" + hashlib.sha256(content).hexdigest()


class _RefusedSubmitFixture(unittest.TestCase):
    """A request and a claim in a store shaped like a checked-out aria/state
    tree (``<store>/tools``), so the publish gate can be asked about it."""

    def setUp(self) -> None:
        self.repo = _seed_repo()
        self.store_root = self.repo / "state"
        self.tools = self.store_root / "tools"
        ensure_tools_dir(self.tools)
        self.target_sha = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=self.repo, text=True,
        ).strip()
        self.request, self.claim = self._claim("conv-high-515")
        self.output = Path(self.request["expected_output_path"])
        self.transcript = self.output.with_suffix(".transcript.jsonl")

    def tearDown(self) -> None:
        shutil.rmtree(self.repo, ignore_errors=True)

    def _claim(self, convergence_id: str, *, allowed_scope: list[str] | None = None) -> tuple[dict, dict]:
        request = create_agent_invocation_request(
            target_agent="aria-evidence-judge",
            role="evidence_judgment",
            suggested_prompt=f"judge the fixture claim of {convergence_id}",
            must_satisfy=[{"id": "P-1", "description": "the fixture obligation"}],
            allowed_scope=allowed_scope or ["**"],
            convergence_id=convergence_id,
            target_sha=self.target_sha,
            base_dir=self.tools,
            admission=admit_request("operator_cli.request", "evidence_judgment", base_dir=self.tools),
        )
        claim = claim_request(request_id=request["request_id"], agent_id="judge-1", base_dir=self.tools)
        return request, claim

    def _envelope(self, *, note: str, evidence_ref: str = "src.txt:1", **extra: object) -> dict:
        return {
            "$schema": "aria/agent-response/v1",
            "request_id": self.request["request_id"],
            "claim_id": self.claim["claim_id"],
            "agent_id": self.claim["agent_id"],
            "role": "evidence_judgment",
            "status": "submitted",
            "satisfaction_matrix": [{"id": "P-1", "verdict": "satisfied", "evidence_refs": [evidence_ref]}],
            "evidence_refs": [evidence_ref],
            "details": {"verdict": "true_positive", "confidence": 0.9, "note": note},
            **extra,
        }

    def _write(self, path: Path, content: bytes) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    def _write_refused(self) -> None:
        self._write(self.output, json.dumps(self._envelope(note=_KEY_HEADER + "\n" + _DB_PASSWORD)).encode("utf-8"))
        self._write(self.transcript, ('{"type":"tool_result","content":"' + _DB_PASSWORD + '"}\n').encode("utf-8"))

    def _submit(
        self, *, output: Path | None = None, transcript: Path | None = None, transcript_ref: str | None = None,
    ) -> dict:
        """Submit as the executor does: the transcript named by its resolved
        path unless ``transcript_ref`` names it otherwise."""
        output = output or self.output
        transcript = transcript or self.transcript
        return submit_claim_result(
            claim_id=self.claim["claim_id"],
            agent_id=self.claim["agent_id"],
            lease_token=self.claim["lease_token"],
            output_path=output,
            workspace_root=self.repo,
            base_dir=self.tools,
            context_hash=str(self.request["context_hash"]),
            prompt_hash=str(self.request["prompt_hash"]),
            transcript_hash=sha256_file(transcript),
            transcript_artifact_ref=transcript_ref or transcript.resolve().as_posix(),
        )

    def _replay(self, transcript_hash: str) -> dict:
        """The executor's retry: the same arguments, the transcript hash it
        computed before the first attempt (its file may be gone)."""
        return submit_claim_result(
            claim_id=self.claim["claim_id"],
            agent_id=self.claim["agent_id"],
            lease_token=self.claim["lease_token"],
            output_path=self.output,
            workspace_root=self.repo,
            base_dir=self.tools,
            context_hash=str(self.request["context_hash"]),
            prompt_hash=str(self.request["prompt_hash"]),
            transcript_hash=transcript_hash,
            transcript_artifact_ref=self.transcript.resolve().as_posix(),
        )

    def _journals(self) -> list[dict]:
        return [
            row for row in load_jsonl(self.tools / "agent-invocations" / "claims.jsonl")
            if row.get("event") == "result_submission_prepared"
        ]

    def _outputs_files(self) -> list[str]:
        outputs = self.tools / "agent-invocations" / "outputs"
        if not outputs.exists():
            return []
        return sorted(p.relative_to(self.tools).as_posix() for p in outputs.rglob("*") if p.is_file())

    def _store_files_holding_the_credential(self) -> list[str]:
        holding = []
        for path in sorted(self.store_root.rglob("*")):
            if path.is_file() and not path.is_symlink():
                content = path.read_bytes()
                if any(marker in content for marker in _MARKERS):
                    holding.append(path.relative_to(self.store_root).as_posix())
        return holding

    def _result_rows(self) -> list[dict]:
        return [
            row for row in load_jsonl(self.tools / "agent-invocations" / "results.jsonl")
            if row.get("claim_id") == self.claim["claim_id"]
        ]

    def _governance(self, kind: str) -> list[dict]:
        return [row for row in load_jsonl(self.tools / "governance.jsonl") if row.get("kind") == kind]


class RefusedOutputIsWithheldTests(_RefusedSubmitFixture):
    def test_a_credential_refusal_leaves_no_refused_byte_in_the_store(self) -> None:
        self._write_refused()
        result = self._submit()

        self.assertEqual(result["status"], "rejected", result)
        # The fixture's transcript carries the password too (ARIA-HIGH-524).
        self.assertEqual(result["rejection_codes"], ["secret_in_envelope", "secret_in_transcript"])
        row = result["row"]
        self.assertIsNone(row["output_path"])
        self.assertEqual(row["output_withheld"], "credential_refusal")
        # The §A.1 idempotency key and the evidence of WHAT was refused stay.
        self.assertEqual(row["output_hash"], row["content_hash"])
        self.assertTrue(row["output_hash"].startswith("sha256:"))
        self.assertEqual(
            sorted(source["path"] for source in row["withheld_sources"]),
            sorted(p.relative_to(self.tools).as_posix() for p in (self.output, self.transcript)),
        )
        self.assertEqual(self._outputs_files(), [])
        self.assertEqual(self._store_files_holding_the_credential(), [])
        rejected = self._governance("agent_result_rejected")
        self.assertEqual(len(rejected), 1)
        self.assertIs(rejected[0]["details"]["output_withheld"], True)
        self.assertTrue(verify_runtime_artifacts(base_dir=self.tools, workspace_root=self.repo)["valid"])

    def test_an_output_outside_the_store_is_never_touched_and_never_sealed(self) -> None:
        outside = self.repo / "scratch" / "response.md"
        outside_transcript = outside.with_suffix(".transcript.jsonl")
        envelope = json.dumps(self._envelope(note=_KEY_HEADER)).encode("utf-8")
        self._write(outside, envelope)
        self._write(outside_transcript, b'{"t":1}\n')

        result = self._submit(output=outside, transcript=outside_transcript)

        self.assertEqual(result["status"], "rejected", result)
        self.assertEqual(result["row"]["output_withheld"], "credential_refusal")
        self.assertEqual(result["row"]["withheld_sources"], [])
        self.assertEqual(outside.read_bytes(), envelope)
        self.assertTrue(outside_transcript.exists())
        self.assertEqual(self._outputs_files(), [])

    def test_unreadable_bytes_carrying_a_credential_are_scanned_and_withheld(self) -> None:
        self._write(self.output, ("not json\n" + _KEY_HEADER + "\n").encode("utf-8"))
        self._write(self.transcript, b'{"t":1}\n')

        result = self._submit()

        self.assertEqual(result["status"], "rejected", result)
        self.assertEqual(result["rejection_codes"], ["envelope_unreadable", "secret_in_envelope"])
        self.assertIsNone(result["row"]["output_path"])
        self.assertEqual(self._outputs_files(), [])
        self.assertEqual(self._store_files_holding_the_credential(), [])

    def test_the_replay_of_a_withheld_submit_is_idempotent_without_the_bytes(self) -> None:
        self._write_refused()
        transcript_hash = sha256_file(self.transcript)
        first = self._submit()
        self.assertEqual(first["status"], "rejected", first)
        self.assertFalse(self.output.exists())

        replay = self._replay(transcript_hash)

        self.assertEqual(replay["status"], "idempotent", replay)
        self.assertEqual(replay["row"]["ledger_hash"], first["row"]["ledger_hash"])
        self.assertEqual(len(self._result_rows()), 1)
        self.assertEqual(self._outputs_files(), [])

    def test_a_replay_that_brings_the_refused_bytes_back_leaves_none(self) -> None:
        self._write_refused()
        refused_output, refused_transcript = self.output.read_bytes(), self.transcript.read_bytes()
        first = self._submit()
        self.assertEqual(first["status"], "rejected", first)

        self._write(self.output, refused_output)
        self._write(self.transcript, refused_transcript)
        replay = self._submit()

        self.assertEqual(replay["status"], "idempotent", replay)
        self.assertEqual(self._outputs_files(), [])
        self.assertEqual(self._store_files_holding_the_credential(), [])

    def test_a_crash_after_the_journal_completes_the_withheld_row_without_the_bytes(self) -> None:
        self._write_refused()
        transcript_hash = sha256_file(self.transcript)
        with mock.patch.object(
            agent_invocations,
            "_persist_submission_side_effects",
            side_effect=OSError("injected crash after the journal append"),
        ):
            with self.assertRaises(OSError):
                self._submit()
        self.assertEqual(self._result_rows(), [])
        self.assertEqual(self._outputs_files(), [])

        replay = self._replay(transcript_hash)

        self.assertEqual(replay["status"], "rejected", replay)
        self.assertEqual(replay["row"]["output_withheld"], "credential_refusal")
        self.assertEqual(len(self._result_rows()), 1)
        self.assertEqual(self._outputs_files(), [])
        self.assertEqual(self._store_files_holding_the_credential(), [])

    def test_a_journal_replay_that_brings_the_refused_bytes_back_leaves_none(self) -> None:
        # The journal is written, the first pass crashes, and the retry
        # rewrites the same refused bytes before it submits: the replay of
        # the journaled operation (not the idempotent branch, no row exists
        # yet) withholds them again.
        self._write_refused()
        refused_output, refused_transcript = self.output.read_bytes(), self.transcript.read_bytes()
        transcript_hash = sha256_file(self.transcript)
        with mock.patch.object(
            agent_invocations,
            "_persist_submission_side_effects",
            side_effect=OSError("injected crash after the journal append"),
        ):
            with self.assertRaises(OSError):
                self._submit()
        self.assertEqual(len(self._journals()), 1)
        self.assertEqual(self._result_rows(), [])

        self._write(self.output, refused_output)
        self._write(self.transcript, refused_transcript)
        replay = self._replay(transcript_hash)

        self.assertEqual(replay["status"], "rejected", replay)
        self.assertEqual(len(self._result_rows()), 1)
        self.assertEqual(self._outputs_files(), [])
        self.assertEqual(self._store_files_holding_the_credential(), [])

    def test_a_non_credential_rejection_is_still_sealed(self) -> None:
        self._write(self.output, json.dumps(self._envelope(note="clean", evidence_ref="missing.txt:1")).encode("utf-8"))
        self._write(self.transcript, b'{"t":1}\n')

        result = self._submit()

        self.assertEqual(result["status"], "rejected", result)
        self.assertNotIn("secret_in_envelope", result["rejection_codes"])
        row = result["row"]
        self.assertNotIn("output_withheld", row)
        self.assertIsInstance(row["output_path"], str)
        self.assertTrue((self.tools / row["output_path"]).is_file())
        self.assertTrue(self.output.exists())


class RefusedOutputTextNeverReachesALedgerTests(_RefusedSubmitFixture):
    """The refused bytes reach no ledger through the text derived from them."""

    def test_a_credential_inside_an_evidence_ref_is_not_echoed_by_the_reasons(self) -> None:
        leaking_ref = "notes/" + _DB_PASSWORD + ".txt:1"
        self._write(self.output, json.dumps(self._envelope(note=_KEY_HEADER, evidence_ref=leaking_ref)).encode("utf-8"))
        self._write(self.transcript, b'{"t":1}\n')

        result = self._submit()

        self.assertEqual(result["status"], "rejected", result)
        self.assertIn("secret_in_envelope", result["rejection_codes"])
        self.assertGreater(len(result["rejection_codes"]), 1, "the fixture must also draw an evidence rejection")
        self.assertFalse(any(marker.decode() in json.dumps(result) for marker in _MARKERS))
        self.assertEqual(self._store_files_holding_the_credential(), [])

    def test_the_verdict_itself_carries_no_text_derived_from_the_refused_bytes(self) -> None:
        # Every consumer reads the verdict: the submit's row, and the
        # executor's pre-push delivery, which renders `reasons[0]` into its
        # refusal, governance.jsonl and HUMAN_REQUIRED. The schema error is
        # ordered first and quotes the value it rejected.
        envelope = self._envelope(note=_KEY_HEADER)
        envelope["status"] = "<" + _DB_PASSWORD + ">"

        judgment = agent_invocations.judge_claim_submission(
            root=self.tools, claim_id=self.claim["claim_id"], agent_id=self.claim["agent_id"],
            request=agent_invocations.find_request(self.tools, self.request["request_id"]),
            envelope=envelope, output=self.output, workspace_root=self.repo,
        )

        self.assertEqual(judgment.rejection_codes[0], "response_schema")
        self.assertIn("secret_in_envelope", judgment.rejection_codes)
        self.assertEqual(judgment.reasons[0], "response_schema: detail withheld with the refused output")
        self.assertFalse(any(marker.decode() in reason for marker in _MARKERS for reason in judgment.reasons))

    def test_a_row_is_never_built_from_unredacted_credential_reasons(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "submit_claim_result_credential_reasons_unredacted"):
            agent_invocations._build_rejection_row(
                claim_id=self.claim["claim_id"], request_id=self.request["request_id"],
                agent_id=self.claim["agent_id"], output_path="unused", output_hash=_sha256(b"x"),
                reasons=["response_schema: status <" + _DB_PASSWORD + ">", "secret_in_envelope: counts only"],
                reason_codes=["response_schema", "secret_in_envelope"],
                envelope_evidence_hash=_sha256(b"x"), submission_sources=[],
            )

    def test_a_credential_refusal_captures_no_out_of_scope_observation(self) -> None:
        self.request, self.claim = self._claim("conv-high-515-scope", allowed_scope=["docs/**"])
        self.output = Path(self.request["expected_output_path"])
        self.transcript = self.output.with_suffix(".transcript.jsonl")
        envelope = self._envelope(note=_KEY_HEADER, declared_route="route " + _DB_PASSWORD)
        self._write(self.output, json.dumps(envelope).encode("utf-8"))
        self._write(self.transcript, b'{"t":1}\n')

        result = self._submit()

        self.assertEqual(result["status"], "rejected", result)
        self.assertIn("agent_evidence_outside_allowed_scope", result["rejection_codes"])
        self.assertIn("secret_in_envelope", result["rejection_codes"])
        self.assertEqual(self._store_files_holding_the_credential(), [])


class WithholdingDeletesOnlyJudgedSubmissionSourcesTests(_RefusedSubmitFixture):
    """The kernel's new power to delete is bounded: its own outputs surface,
    never a sealed artifact, and only the bytes its verdict judged."""

    def test_a_sealed_artifact_named_as_the_transcript_is_never_deleted(self) -> None:
        sealed_bytes = b'{"sealed":"another result"}\n'
        sealed = self._write(
            self.tools / "agent-invocations" / "outputs" / "content-addressed" / "transcripts"
            / f"{hashlib.sha256(sealed_bytes).hexdigest()}.md",
            sealed_bytes,
        )
        self._write(self.output, json.dumps(self._envelope(note=_KEY_HEADER)).encode("utf-8"))

        result = self._submit(transcript=sealed)

        self.assertEqual(result["status"], "rejected", result)
        self.assertEqual(
            [source["path"] for source in result["row"]["withheld_sources"]],
            [self.output.relative_to(self.tools).as_posix()],
        )
        self.assertEqual(sealed.read_bytes(), sealed_bytes)
        self.assertFalse(self.output.exists())

    def test_a_store_file_outside_outputs_named_as_the_transcript_is_neither_listed_nor_deleted(self) -> None:
        # The bound on the kernel's delete power: its own outputs surface.
        # A request ledger named as the transcript (with its true digest)
        # is the store's, not the submission's.
        ledger = next((self.tools / "agent-invocations" / "requests").glob("*.jsonl"))
        before = ledger.read_bytes()
        self._write(self.output, json.dumps(self._envelope(note=_KEY_HEADER)).encode("utf-8"))

        result = self._submit(transcript=ledger)

        self.assertEqual(result["status"], "rejected", result)
        self.assertEqual(
            [source["path"] for source in result["row"]["withheld_sources"]],
            [self.output.relative_to(self.tools).as_posix()],
        )
        self.assertEqual(ledger.read_bytes(), before)
        self.assertFalse(self.output.exists())

    def test_a_transcript_that_is_a_symlink_at_submit_is_refused_and_its_target_kept(self) -> None:
        # The submission names the LINK; the link points at another
        # request's raw output (the digest matches: it is hashed through the
        # link). A path is deleted only as it was named, never through a
        # link: the submit is refused before anything is deleted or
        # journaled.
        other_bytes = b'{"another request": "its raw envelope"}'
        other = self._write(
            self.tools / "agent-invocations" / "outputs" / "another-group" / "round-1-x-OTHER.md", other_bytes,
        )
        refused = json.dumps(self._envelope(note=_KEY_HEADER)).encode("utf-8")
        self._write(self.output, refused)
        os.symlink(other, self.transcript)

        with self.assertRaisesRegex(GovernanceError, "submission_artifact_path_symlink"):
            self._submit(transcript_ref=self.transcript.as_posix())

        self.assertEqual(other.read_bytes(), other_bytes)
        self.assertTrue(self.transcript.is_symlink())
        self.assertEqual(self.output.read_bytes(), refused)
        self.assertEqual(self._result_rows(), [])
        self.assertEqual(self._journals(), [])

    def _swap_source_before_the_locked_authority_check(self, swap: Callable[[], object]) -> Any:
        real = agent_invocations._validate_claim_submission_authority
        calls = {"n": 0}

        def wrapper(*args, **kwargs):
            calls["n"] += 1
            if calls["n"] == 2:  # the recheck under the lock, right before withholding
                swap()
            return real(*args, **kwargs)

        return mock.patch.object(agent_invocations, "_validate_claim_submission_authority", side_effect=wrapper)

    def test_bytes_the_verdict_never_judged_are_never_deleted(self) -> None:
        self._write_refused()
        unjudged = b'{"rewritten": "after the verdict"}'

        with self._swap_source_before_the_locked_authority_check(lambda: self.output.write_bytes(unjudged)):
            with self.assertRaisesRegex(GovernanceError, "submission_withheld_source_drift"):
                self._submit()

        self.assertEqual(self.output.read_bytes(), unjudged)
        self.assertEqual(self._result_rows(), [])
        self.assertEqual(self._journals(), [])

    def test_a_source_swapped_for_a_symlink_is_refused_and_its_target_kept(self) -> None:
        self._write_refused()
        target = self._write(self.repo / "elsewhere.md", self.output.read_bytes())

        def swap() -> None:
            self.output.unlink()
            os.symlink(target, self.output)

        with self._swap_source_before_the_locked_authority_check(swap):
            with self.assertRaisesRegex(GovernanceError, "submission_artifact_path_symlink"):
                self._submit()

        self.assertTrue(self.output.is_symlink())
        self.assertTrue(target.exists())
        self.assertEqual(self._result_rows(), [])

    def test_a_parent_directory_swapped_for_a_symlink_is_refused_and_the_outside_file_kept(self) -> None:
        # The leaf stays a regular file, so O_NOFOLLOW alone would not stop
        # this: only the component walk does. Without it the kernel would
        # delete a file outside the store.
        self._write_refused()
        parent = self.output.parent
        outside = self.repo / "outside-dir"

        def swap() -> None:
            shutil.move(str(parent), str(outside))
            os.symlink(outside, parent)

        with self._swap_source_before_the_locked_authority_check(swap):
            with self.assertRaisesRegex(GovernanceError, "submission_artifact_path_symlink"):
                self._submit()

        self.assertTrue((outside / self.output.name).is_file(), "a file outside the store was deleted")
        self.assertTrue((outside / self.transcript.name).is_file(), "a file outside the store was deleted")
        self.assertEqual(self._result_rows(), [])


class PublishGateRefusesRefusedBytesTests(_RefusedSubmitFixture):
    """Tier 3 behind the tier-1 withholding: rows written before it, or any
    path that leaves refused bytes behind, are caught before a publish."""

    def _legacy_refused_row(self, *, output_path: str | None, output_hash: str, **extra: object) -> None:
        row = {
            "$schema": "aria/agent-claim-result/v1",
            "schema_version": 1,
            "row_id": f"result:{self.claim['claim_id']}:rejected",
            "row_type": "result",
            "claim_id": self.claim["claim_id"],
            "request_id": self.request["request_id"],
            "agent_id": self.claim["agent_id"],
            "status": "rejected",
            "output_path": output_path,
            "output_hash": output_hash,
            "content_hash": output_hash,
            "rejection_reasons": ["secret_in_envelope: secret pattern hits (counts only, values REDACTED)"],
            "rejection_codes": ["secret_in_envelope"],
            "envelope_evidence_hash": "sha256:" + "e" * 64,
            "invocation_id": self.claim["claim_id"],
            "transcript_hash": None,
            "submitted_at": "2026-10-14T00:00:00Z",
            **extra,
        }
        append_declared_fixture(
            self.tools / "agent-invocations" / "results.jsonl", row, expected_surface="agent_invocation_results",
        )

    def _issues(self) -> list[dict]:
        verdict = verify_runtime_artifacts(base_dir=self.tools, workspace_root=self.repo)
        return [issue for issue in verdict["issues"] if issue.get("code") == "refused_output_present"]

    def _seal(self, content: bytes) -> Path:
        """A seal written by its one owner, never by a copy of its layout."""
        return agent_invocations._seal_submission_artifact(
            self.tools, artifact_kind="responses", content=content, content_hash=_sha256(content),
        )

    def test_a_legacy_refused_row_whose_bytes_remain_fails_verification_until_they_go(self) -> None:
        # The shape the pre-fix submit really wrote: the row names the SEAL,
        # and the executor's raw file stays at the request's
        # expected_output_path, which no row names.
        refused = json.dumps(self._envelope(note=_KEY_HEADER)).encode("utf-8")
        self._write(self.output, refused)
        seal = self._seal(refused)
        seal_relative = seal.relative_to(self.tools).as_posix()
        raw_relative = self.output.relative_to(self.tools).as_posix()
        self._legacy_refused_row(output_path=seal_relative, output_hash=_sha256(refused))

        verdict = verify_runtime_artifacts(base_dir=self.tools, workspace_root=self.repo)
        self.assertFalse(verdict["valid"])
        self.assertEqual(
            self._issues(),
            [{"code": "refused_output_present", "request_id": self.request["request_id"],
              "claim_id": self.claim["claim_id"], "path": path}
             for path in sorted([seal_relative, raw_relative])],
        )

        seal.unlink()
        self.assertEqual([issue["path"] for issue in self._issues()], [raw_relative])
        self.output.unlink()
        self.assertTrue(verify_runtime_artifacts(base_dir=self.tools, workspace_root=self.repo)["valid"])

    def test_a_seal_of_withheld_bytes_fails_verification(self) -> None:
        refused = json.dumps(self._envelope(note=_KEY_HEADER)).encode("utf-8")
        seal = self._seal(refused)
        self._legacy_refused_row(
            output_path=None, output_hash=_sha256(refused), output_withheld="credential_refusal", withheld_sources=[],
        )

        self.assertEqual([issue["path"] for issue in self._issues()], [seal.relative_to(self.tools).as_posix()])

    def test_a_withheld_source_is_judged_by_content_not_by_name(self) -> None:
        refused = json.dumps(self._envelope(note=_KEY_HEADER)).encode("utf-8")
        relative = self.output.relative_to(self.tools).as_posix()
        self._legacy_refused_row(
            output_path=None, output_hash=_sha256(refused), output_withheld="credential_refusal",
            withheld_sources=[{"path": relative, "sha256": _sha256(refused)}],
        )

        self._write(self.output, refused)
        self.assertEqual([issue["path"] for issue in self._issues()], [relative])

        # A later, legitimate file at the same path is not the refused bytes.
        self._write(self.output, b'{"a later": "submission"}')
        self.assertEqual(self._issues(), [])

    def test_the_publish_gate_refuses_a_store_holding_refused_bytes(self) -> None:
        refused = json.dumps(self._envelope(note=_KEY_HEADER)).encode("utf-8")
        self._write(self.output, refused)
        self._legacy_refused_row(output_path=self.output.relative_to(self.tools).as_posix(), output_hash=_sha256(refused))
        store = StateStore(
            root=self.store_root, branch="aria/state", repo_root=self.repo, remote="origin", bootstrapped=True,
        )
        self.assertEqual(tools_root(store), self.tools)

        with self.assertRaises(StateStoreRefusal) as caught:
            _refuse_unverified_runtime_artifacts(store)

        self.assertIn("state_publish_runtime_artifacts_unverified", str(caught.exception))
        self.assertIn("refused_output_present", str(caught.exception))


class ATranscriptCarryingACredentialIsWithheldTests(_RefusedSubmitFixture):
    """ARIA-HIGH-524 — the submit sealed a transcript after checking only its
    hash, onto the published outputs surface (``content-addressed/transcripts``).
    The executor scrubs every transcript at its one writer (ARIA-HIGH-448), but
    the kernel is the last line for any producer: the transcript's bytes are
    now scanned with the one refusal owner before anything is sealed, and a
    hit is a credential refusal (``secret_in_transcript``, in
    ``CREDENTIAL_REFUSAL_CODES``) withheld by the same owner as an envelope's."""

    def _sealed_transcripts(self) -> list[str]:
        sealed = self.tools / "agent-invocations" / "outputs" / "content-addressed" / "transcripts"
        return sorted(path.name for path in sealed.glob("*")) if sealed.exists() else []

    def test_a_clean_envelope_with_a_credential_in_its_transcript_is_withheld_and_never_sealed(self) -> None:
        self._write(self.output, json.dumps(self._envelope(note="clean")).encode("utf-8"))
        self._write(self.transcript, ('{"type":"tool_result","content":"' + _DB_PASSWORD + '"}\n').encode("utf-8"))

        result = self._submit()

        self.assertEqual(result["status"], "rejected", result)
        self.assertEqual(result["rejection_codes"], ["secret_in_transcript"])
        row = result["row"]
        self.assertIsNone(row["output_path"])
        self.assertEqual(row["output_withheld"], "credential_refusal")
        self.assertEqual(
            sorted(source["path"] for source in row["withheld_sources"]),
            sorted(p.relative_to(self.tools).as_posix() for p in (self.output, self.transcript)),
        )
        self.assertEqual(self._sealed_transcripts(), [])
        self.assertEqual(self._outputs_files(), [])
        self.assertEqual(self._store_files_holding_the_credential(), [])
        self.assertFalse(any(marker.decode() in json.dumps(result) for marker in _MARKERS))
        self.assertTrue(verify_runtime_artifacts(base_dir=self.tools, workspace_root=self.repo)["valid"])

    def test_a_rejected_envelope_with_a_credential_in_its_transcript_is_withheld_with_both_codes(self) -> None:
        self._write(self.output, json.dumps(self._envelope(note="clean", evidence_ref="missing.txt:1")).encode("utf-8"))
        self._write(self.transcript, ('{"content":"' + _KEY_HEADER + '"}\n').encode("utf-8"))

        result = self._submit()

        self.assertEqual(result["status"], "rejected", result)
        self.assertIn("secret_in_transcript", result["rejection_codes"])
        self.assertGreater(len(result["rejection_codes"]), 1)
        # Every other reason is reduced to its code, as for an envelope's leak.
        for reason, code in zip(result["reasons"], result["rejection_codes"]):
            if code != "secret_in_transcript":
                self.assertEqual(reason, f"{code}: detail withheld with the refused output")
        self.assertEqual(result["row"]["output_withheld"], "credential_refusal")
        self.assertEqual(self._outputs_files(), [])
        self.assertEqual(self._store_files_holding_the_credential(), [])

    def test_a_clean_transcript_is_still_sealed(self) -> None:
        self._write(self.output, json.dumps(self._envelope(note="clean")).encode("utf-8"))
        self._write(self.transcript, b'{"type":"tool_result","content":"no secret here"}\n')

        result = self._submit()

        self.assertEqual(result["status"], "accepted", result)
        self.assertEqual(len(self._sealed_transcripts()), 1)


if __name__ == "__main__":
    unittest.main()
