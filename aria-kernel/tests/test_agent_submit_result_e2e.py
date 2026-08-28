"""End-to-end test for the Plan 016 Faz C submit-result lifecycle.

Walks the full flow: create_agent_invocation_request -> claim_request ->
write a valid aria/agent-response/v1 envelope -> submit_claim_result ->
state transitions to ACCEPTED. Plus the reject paths: malformed envelope,
missing satisfaction matrix entries, evidence ref missing on disk.
"""
from __future__ import annotations

from contextlib import contextmanager, nullcontext
from datetime import datetime, timedelta
import json
import multiprocessing
import os
import shutil
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import agent_invocations, ledger
from aria_kernel.agent_invocations import (
    accepted_result_for_request,
    claim_request,
    create_agent_invocation_request,
    derive_request_state,
    heartbeat_claim,
    reap_stale_claims,
    release_claim,
    submit_claim_result,
)
from aria_kernel.ledger import load_jsonl
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests._helpers.declared_fixtures import sha256_file


def _seed_repo() -> Path:
    """Create a tempdir that looks like a repo root."""
    repo = Path(tempfile.mkdtemp(prefix="aria-e2e-"))
    (repo / "src.txt").write_text("alpha\nbeta\ngamma\n", encoding="utf-8")
    subprocess.run(
        ["git", "init", "-b", "main"],
        cwd=repo,
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    subprocess.run(["git", "config", "user.email", "aria-test@example.invalid"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "ARIA Test"], cwd=repo, check=True)
    subprocess.run(["git", "add", "src.txt"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "seed evidence"], cwd=repo, check=True, stdout=subprocess.DEVNULL)
    return repo


def _submit_and_exit_after_append_boundary(
    *,
    boundary: str,
    repo: str,
    tools: str,
    claim_id: str,
    agent_id: str,
    lease_token: str,
    output_path: str,
    binding_kwargs: dict[str, str],
) -> None:
    """Child-process fault injector for durable submission recovery tests."""
    from aria_kernel import agent_invocations as child_invocations
    from aria_kernel import ledger as child_ledger

    tools_path = Path(tools)
    real_append = child_ledger.StateTransaction.append_declared_jsonl

    def append_then_exit(transaction, path, record, **append_kwargs):
        stored = real_append(transaction, path, record, **append_kwargs)
        resolved = Path(path).resolve()
        label: str | None = None
        if (
            resolved
            == (tools_path / "agent-invocations" / "claims.jsonl").resolve()
            and record.get("event") == "result_submission_prepared"
            and record.get("claim_id") == claim_id
        ):
            label = "journal"
        elif (
            resolved
            == (tools_path / "agent-invocations" / "transcripts.jsonl").resolve()
            and record.get("claim_id") == claim_id
        ):
            label = "transcript"
        elif (
            resolved == (tools_path / "agent-compliance.jsonl").resolve()
            and record.get("claim_id") == claim_id
        ):
            label = "compliance"
        elif (
            resolved == (tools_path / "governance.jsonl").resolve()
            and record.get("kind") == "agent_result_accepted"
            and record.get("details", {}).get("claim_id") == claim_id
        ):
            label = "governance"
        elif (
            resolved
            == (tools_path / "agent-invocations" / "results.jsonl").resolve()
            and record.get("claim_id") == claim_id
        ):
            label = "result"
        if label == boundary:
            os._exit(86)
        return stored

    def submit() -> None:
        child_invocations.submit_claim_result(
            claim_id=claim_id,
            agent_id=agent_id,
            lease_token=lease_token,
            output_path=output_path,
            workspace_root=repo,
            base_dir=tools,
            **binding_kwargs,
        )

    with mock.patch.object(
        child_ledger.StateTransaction,
        "append_declared_jsonl",
        append_then_exit,
    ):
        if boundary == "response_seal":
            def write_prefix_then_exit(descriptor: int, content: bytes) -> None:
                prefix_size = max(1, len(content) // 2)
                os.write(descriptor, content[:prefix_size])
                os.fsync(descriptor)
                os._exit(86)

            with mock.patch.object(
                child_invocations,
                "_write_all",
                write_prefix_then_exit,
            ):
                submit()
        elif boundary == "post_seal":
            with mock.patch.object(
                child_invocations,
                "_persist_submission_side_effects",
                side_effect=lambda **_kwargs: os._exit(86),
            ):
                submit()
        else:
            submit()
    os._exit(87)


class SubmitResultE2ETests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = _seed_repo()
        self.target_sha = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=self.repo,
            text=True,
        ).strip()
        self.tools = self.repo / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self.repo, ignore_errors=True)

    def _claim(self, *, nonce: str = "") -> tuple[dict, dict]:
        # Plan 024 §B-2 — submit_claim_result E2E exercises the strict
        # path. allowed_scope=["**"] permits the canonical fixture
        # evidence path (src.txt at repo root from _seed_repo) without
        # bringing in real aria-kernel paths the temp repo doesn't carry.
        request = create_agent_invocation_request(
            target_agent="aria-evidence-judge",
            role="evidence_judgment",
            suggested_prompt=f"validate F-001 evidence{nonce}",
            must_satisfy=[
                {"id": "F-001-evidence", "criterion": "F-001 evidence is sufficient"},
            ],
            allowed_scope=["**"],
            convergence_id=f"conv-001{nonce}",
            target_sha=self.target_sha,
            base_dir=self.tools,
        )
        claim = claim_request(
            request_id=request["request_id"],
            agent_id="judge-worker-001",
            base_dir=self.tools,
        )
        return request, claim

    def _good_envelope(self, *, request: dict, claim: dict) -> Path:
        # Plan 024 §B-2 — request now carries must_satisfy=[F-001-evidence]
        # and allowed_scope=aria-kernel/** + aria-tools/**. The "good"
        # envelope must satisfy every criterion (or risk
        # response_schema rejection) and place evidence inside the
        # request's allowed_scope.
        envelope = {
            "$schema": "aria/agent-response/v1",
            "request_id": request["request_id"],
            "claim_id": claim["claim_id"],
            "agent_id": claim["agent_id"],
            "role": "evidence_judgment",
            "status": "submitted",
            "satisfaction_matrix": [
                {
                    "id": "F-001-evidence",
                    "verdict": "satisfied",
                    "evidence_refs": ["src.txt:1"],
                },
            ],
            "evidence_refs": ["src.txt:1"],
            "details": {"verdict": "true_positive", "confidence": 0.92},
        }
        # Plan 020 Phase 7.B — output_path_match compliance check requires
        # the response file to land at the request's expected_output_path
        # (kernel-canonical location). Pre-Plan-020 tests wrote to custom
        # paths because no gate enforced the contract; the new gate fires.
        out_path = Path(request["expected_output_path"])
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(envelope), encoding="utf-8")
        return out_path

    def _transcript_artifact(self, request: dict, claim: dict) -> Path:
        transcript = self.tools / "agent-invocations" / "transcripts" / f"{claim['claim_id']}.txt"
        transcript.parent.mkdir(parents=True, exist_ok=True)
        transcript.write_text(
            "\n".join(
                [
                    f"request_id={request['request_id']}",
                    f"claim_id={claim['claim_id']}",
                    "model_transcript=fixture transcript for accepted submit-result path",
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        return transcript

    def _binding_kwargs(self, request: dict, transcript_path: Path) -> dict[str, str]:
        return {
            "context_hash": str(request["context_hash"]),
            "prompt_hash": str(request["prompt_hash"]),
            "transcript_hash": sha256_file(transcript_path),
            "transcript_artifact_ref": transcript_path.resolve().as_posix(),
        }

    def _result_rows(self, claim_id: str) -> list[dict]:
        return [
            row
            for row in load_jsonl(
                self.tools / "agent-invocations" / "results.jsonl"
            )
            if row.get("claim_id") == claim_id
        ]

    def _submission_row_counts(self, claim_id: str) -> dict[str, int]:
        return {
            "journal": sum(
                1
                for row in load_jsonl(
                    self.tools / "agent-invocations" / "claims.jsonl"
                )
                if row.get("claim_id") == claim_id
                and row.get("event") == "result_submission_prepared"
            ),
            "transcript": sum(
                1
                for row in load_jsonl(
                    self.tools / "agent-invocations" / "transcripts.jsonl"
                )
                if row.get("claim_id") == claim_id
            ),
            "compliance": sum(
                1
                for row in load_jsonl(self.tools / "agent-compliance.jsonl")
                if row.get("claim_id") == claim_id
            ),
            "governance": sum(
                1
                for row in load_jsonl(self.tools / "governance.jsonl")
                if row.get("kind") == "agent_result_accepted"
                and row.get("details", {}).get("claim_id") == claim_id
            ),
            "result": len(self._result_rows(claim_id)),
        }

    def _crash_after_submission_seals(
        self,
        *,
        nonce: str,
    ) -> tuple[dict, dict, Path, Path, dict[str, str], Path, Path]:
        request, claim = self._claim(nonce=nonce)
        out = self._good_envelope(request=request, claim=claim)
        transcript = self._transcript_artifact(request, claim)
        kwargs = self._binding_kwargs(request, transcript)
        process = multiprocessing.get_context("spawn").Process(
            target=_submit_and_exit_after_append_boundary,
            kwargs={
                "boundary": "post_seal",
                "repo": self.repo.as_posix(),
                "tools": self.tools.as_posix(),
                "claim_id": claim["claim_id"],
                "agent_id": "judge-worker-001",
                "lease_token": claim["lease_token"],
                "output_path": out.as_posix(),
                "binding_kwargs": kwargs,
            },
        )
        process.start()
        process.join(timeout=30)
        if process.is_alive():
            process.kill()
            process.join(timeout=5)
            self.fail("submit child hung after artifact seals")
        self.assertEqual(process.exitcode, 86)
        process.close()
        self.assertEqual(
            self._submission_row_counts(claim["claim_id"]),
            {
                "journal": 1,
                "transcript": 0,
                "compliance": 0,
                "governance": 0,
                "result": 0,
            },
        )
        journal = next(
            row
            for row in load_jsonl(
                self.tools / "agent-invocations" / "claims.jsonl"
            )
            if row.get("claim_id") == claim["claim_id"]
            and row.get("event") == "result_submission_prepared"
        )
        prepared_result = journal["prepared"]["result_row"]
        sealed_output = agent_invocations.resolve_output_artifact_path(
            self.tools,
            prepared_result["output_path"],
        )
        sealed_transcript = agent_invocations.resolve_output_artifact_path(
            self.tools,
            prepared_result["transcript_artifact_ref"],
        )
        self.assertTrue(sealed_output.is_file())
        self.assertTrue(sealed_transcript.is_file())
        return (
            request,
            claim,
            out,
            transcript,
            kwargs,
            sealed_output,
            sealed_transcript,
        )

    @contextmanager
    def _non_reentrant_state_transactions(self):
        """Model a platform where reacquiring any held state lock times out."""
        real_state_transaction = ledger.state_transaction
        active = 0

        @contextmanager
        def reject_nested(*args, **kwargs):
            nonlocal active
            if active:
                raise TimeoutError("nested_state_transaction_would_deadlock")
            with real_state_transaction(*args, **kwargs) as transaction:
                active += 1
                try:
                    yield transaction
                finally:
                    active -= 1

        with mock.patch.object(
            agent_invocations,
            "state_transaction",
            reject_nested,
        ), mock.patch.object(
            ledger,
            "state_transaction",
            reject_nested,
        ):
            yield

    def test_full_claim_submit_accept_flow(self) -> None:
        request, claim = self._claim()
        out = self._good_envelope(request=request, claim=claim)
        transcript = self._transcript_artifact(request, claim)
        result = submit_claim_result(
            claim_id=claim["claim_id"],
            agent_id="judge-worker-001",
            lease_token=claim["lease_token"],
            output_path=out,
            workspace_root=self.repo,
            base_dir=self.tools,
            **self._binding_kwargs(request, transcript),
        )
        self.assertEqual(result["status"], "accepted", result)
        # ARIA-HIGH-003 — the accepted row stamps the trusted request's
        # immutable target SHA at acceptance; the submitted envelope never
        # supplies it, so a caller cannot substitute a convenient tree.
        self.assertEqual(result["row"]["target_sha"], self.target_sha)
        # Plan 026R §C.5 — derive_request_state is bridge-aware. For
        # BRIDGE_REQUIRED roles (this test uses evidence_judgment) the
        # state lifts to ACCEPTED_PENDING_BRIDGE when the bridge has
        # not yet succeeded; ACCEPTED when it has. This e2e test does
        # not drive a fully-bridgeable judgment envelope, so the
        # bridge may legitimately end in pending_retry. The assertion
        # preserves the test's original architectural intent (accept
        # != reject) without overspecifying the bridge sub-state —
        # bridge-specific assertions live in test_bridge_retry.py.
        state = derive_request_state(
            request_id=request["request_id"], base_dir=self.tools,
        )
        self.assertIn(state, {"ACCEPTED", "ACCEPTED_PENDING_BRIDGE"})

    def test_successful_submit_never_reacquires_the_state_transaction(self) -> None:
        request, claim = self._claim()
        out = self._good_envelope(request=request, claim=claim)
        transcript = self._transcript_artifact(request, claim)

        with self._non_reentrant_state_transactions():
            result = submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                output_path=out,
                workspace_root=self.repo,
                base_dir=self.tools,
                lock_timeout_seconds=0,
                **self._binding_kwargs(request, transcript),
            )

        self.assertEqual(result["status"], "accepted")

    def test_rejection_never_reacquires_the_state_transaction(self) -> None:
        _request, claim = self._claim()
        out = self.tools / "agent-invocations" / "outputs" / "junk.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text("not-json", encoding="utf-8")

        with self._non_reentrant_state_transactions():
            result = submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                output_path=out,
                workspace_root=self.repo,
                base_dir=self.tools,
                lock_timeout_seconds=0,
            )

        self.assertEqual(result["status"], "rejected")

    def test_idempotent_submit_never_reacquires_the_state_transaction(self) -> None:
        request, claim = self._claim()
        out = self._good_envelope(request=request, claim=claim)
        transcript = self._transcript_artifact(request, claim)
        kwargs = self._binding_kwargs(request, transcript)
        first = submit_claim_result(
            claim_id=claim["claim_id"],
            agent_id="judge-worker-001",
            lease_token=claim["lease_token"],
            output_path=out,
            workspace_root=self.repo,
            base_dir=self.tools,
            **kwargs,
        )
        self.assertEqual(first["status"], "accepted")

        with self._non_reentrant_state_transactions():
            replay = submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                output_path=out,
                workspace_root=self.repo,
                base_dir=self.tools,
                lock_timeout_seconds=0,
                **kwargs,
            )

        self.assertEqual(replay["status"], "idempotent")

    def test_compliance_rejection_never_reacquires_the_state_transaction(self) -> None:
        request, claim = self._claim()
        canonical = self._good_envelope(request=request, claim=claim)
        mismatched = canonical.with_name("compliance-path-mismatch.json")
        mismatched.write_bytes(canonical.read_bytes())

        with self._non_reentrant_state_transactions():
            result = submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                output_path=mismatched,
                workspace_root=self.repo,
                base_dir=self.tools,
                lock_timeout_seconds=0,
            )

        self.assertEqual(result["status"], "rejected")
        self.assertIn("compliance:", " ".join(result["reasons"]))

    def test_accepted_governance_failure_writes_no_terminal_result(self) -> None:
        request, claim = self._claim()
        out = self._good_envelope(request=request, claim=claim)
        transcript = self._transcript_artifact(request, claim)

        with mock.patch.object(
            agent_invocations,
            "append_tools_governance",
            side_effect=OSError("injected governance write failure"),
        ), self.assertRaisesRegex(OSError, "injected governance write failure"):
            submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                output_path=out,
                workspace_root=self.repo,
                base_dir=self.tools,
                **self._binding_kwargs(request, transcript),
            )

        self.assertEqual(self._result_rows(claim["claim_id"]), [])

    def test_retry_after_governance_append_is_exactly_once(self) -> None:
        """A crash after a real append must resume, not replay prior effects."""
        request, claim = self._claim()
        out = self._good_envelope(request=request, claim=claim)
        transcript = self._transcript_artifact(request, claim)
        kwargs = self._binding_kwargs(request, transcript)
        real_append = ledger.StateTransaction.append_declared_jsonl
        crashed = False

        def crash_after_governance(transaction, path, record, **append_kwargs):
            nonlocal crashed
            stored = real_append(
                transaction,
                path,
                record,
                **append_kwargs,
            )
            if (
                not crashed
                and record.get("kind") == "agent_result_accepted"
                and record.get("details", {}).get("claim_id") == claim["claim_id"]
            ):
                crashed = True
                raise OSError("injected crash after governance append")
            return stored

        with mock.patch.object(
            ledger.StateTransaction,
            "append_declared_jsonl",
            crash_after_governance,
        ), self.assertRaisesRegex(OSError, "after governance append"):
            submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                output_path=out,
                workspace_root=self.repo,
                base_dir=self.tools,
                **kwargs,
            )

        self.assertEqual(self._result_rows(claim["claim_id"]), [])
        self.assertEqual(
            derive_request_state(
                request_id=request["request_id"],
                base_dir=self.tools,
            ),
            "CLAIMED",
        )
        self.assertIsNone(
            accepted_result_for_request(
                request_id=request["request_id"],
                base_dir=self.tools,
            )
        )
        retry = submit_claim_result(
            claim_id=claim["claim_id"],
            agent_id="judge-worker-001",
            lease_token=claim["lease_token"],
            output_path=out,
            workspace_root=self.repo,
            base_dir=self.tools,
            **kwargs,
        )

        self.assertEqual(retry["status"], "accepted")
        self.assertEqual(
            self._submission_row_counts(claim["claim_id"]),
            {
                "journal": 1,
                "transcript": 1,
                "compliance": 1,
                "governance": 1,
                "result": 1,
            },
        )

    def test_retry_after_every_submission_append_boundary_is_exactly_once(self) -> None:
        """Journal-first/terminal-last recovery survives every crash boundary."""
        expected_boundaries = (
            "journal",
            "transcript",
            "compliance",
            "governance",
            "result",
        )
        real_append = ledger.StateTransaction.append_declared_jsonl

        for boundary in expected_boundaries:
            with self.subTest(boundary=boundary):
                request, claim = self._claim(nonce=f"-boundary-{boundary}")
                out = self._good_envelope(request=request, claim=claim)
                transcript = self._transcript_artifact(request, claim)
                kwargs = self._binding_kwargs(request, transcript)
                observed: list[str] = []

                def crash_at_boundary(transaction, path, record, **append_kwargs):
                    stored = real_append(
                        transaction,
                        path,
                        record,
                        **append_kwargs,
                    )
                    resolved = Path(path).resolve()
                    label: str | None = None
                    if (
                        resolved
                        == (self.tools / "agent-invocations" / "claims.jsonl").resolve()
                        and record.get("event") == "result_submission_prepared"
                        and record.get("claim_id") == claim["claim_id"]
                    ):
                        label = "journal"
                    elif (
                        resolved
                        == (self.tools / "agent-invocations" / "transcripts.jsonl").resolve()
                        and record.get("claim_id") == claim["claim_id"]
                    ):
                        label = "transcript"
                    elif (
                        resolved == (self.tools / "agent-compliance.jsonl").resolve()
                        and record.get("claim_id") == claim["claim_id"]
                    ):
                        label = "compliance"
                    elif (
                        resolved == (self.tools / "governance.jsonl").resolve()
                        and record.get("kind") == "agent_result_accepted"
                        and record.get("details", {}).get("claim_id")
                        == claim["claim_id"]
                    ):
                        label = "governance"
                    elif (
                        resolved
                        == (self.tools / "agent-invocations" / "results.jsonl").resolve()
                        and record.get("claim_id") == claim["claim_id"]
                    ):
                        label = "result"
                    if label is not None:
                        observed.append(label)
                        if label == boundary:
                            raise OSError(f"injected crash after {boundary} append")
                    return stored

                with mock.patch.object(
                    ledger.StateTransaction,
                    "append_declared_jsonl",
                    crash_at_boundary,
                ), self.assertRaisesRegex(OSError, f"after {boundary} append"):
                    submit_claim_result(
                        claim_id=claim["claim_id"],
                        agent_id="judge-worker-001",
                        lease_token=claim["lease_token"],
                        output_path=out,
                        workspace_root=self.repo,
                        base_dir=self.tools,
                        **kwargs,
                    )

                retry = submit_claim_result(
                    claim_id=claim["claim_id"],
                    agent_id="judge-worker-001",
                    lease_token=claim["lease_token"],
                    output_path=out,
                    workspace_root=self.repo,
                    base_dir=self.tools,
                    **kwargs,
                )
                self.assertEqual(
                    retry["status"],
                    "idempotent" if boundary == "result" else "accepted",
                )
                self.assertEqual(
                    self._submission_row_counts(claim["claim_id"]),
                    {
                        "journal": 1,
                        "transcript": 1,
                        "compliance": 1,
                        "governance": 1,
                        "result": 1,
                    },
                )
                journal = next(
                    row
                    for row in load_jsonl(
                        self.tools / "agent-invocations" / "claims.jsonl"
                    )
                    if row.get("claim_id") == claim["claim_id"]
                    and row.get("event") == "result_submission_prepared"
                )
                operation_id = journal["operation_id"]
                operation_effects = []
                for path in (
                    self.tools / "agent-invocations" / "transcripts.jsonl",
                    self.tools / "agent-compliance.jsonl",
                    self.tools / "governance.jsonl",
                    self.tools / "agent-invocations" / "results.jsonl",
                ):
                    operation_effects.extend(
                        row
                        for row in load_jsonl(path)
                        if row.get("submission_operation_id") == operation_id
                    )
                self.assertEqual(
                    [row.get("submission_effect") for row in operation_effects],
                    ["transcript", "compliance", "terminal_governance", "result"],
                )

    def test_process_death_after_every_append_boundary_recovers_exactly_once(
        self,
    ) -> None:
        """A fresh interpreter recovers after real process death per append."""
        spawn_context = multiprocessing.get_context("spawn")
        expected_boundaries = (
            "journal",
            "transcript",
            "compliance",
            "governance",
            "result",
        )

        for boundary in expected_boundaries:
            with self.subTest(boundary=boundary):
                request, claim = self._claim(nonce=f"-process-death-{boundary}")
                out = self._good_envelope(request=request, claim=claim)
                transcript = self._transcript_artifact(request, claim)
                kwargs = self._binding_kwargs(request, transcript)
                output_digest = sha256_file(out).removeprefix("sha256:")
                sealed_output = (
                    self.tools
                    / "agent-invocations"
                    / "outputs"
                    / "content-addressed"
                    / "responses"
                    / f"{output_digest}.md"
                )
                process = spawn_context.Process(
                    target=_submit_and_exit_after_append_boundary,
                    kwargs={
                        "boundary": boundary,
                        "repo": self.repo.as_posix(),
                        "tools": self.tools.as_posix(),
                        "claim_id": claim["claim_id"],
                        "agent_id": "judge-worker-001",
                        "lease_token": claim["lease_token"],
                        "output_path": out.as_posix(),
                        "binding_kwargs": kwargs,
                    },
                )
                process.start()
                process.join(timeout=30)
                if process.is_alive():
                    process.kill()
                    process.join(timeout=5)
                    self.fail(
                        f"submit child hung at append boundary {boundary}"
                    )
                self.assertEqual(process.exitcode, 86)
                process.close()

                if boundary == "journal":
                    self.assertFalse(sealed_output.exists())

                retry = submit_claim_result(
                    claim_id=claim["claim_id"],
                    agent_id="judge-worker-001",
                    lease_token=claim["lease_token"],
                    output_path=out,
                    workspace_root=self.repo,
                    base_dir=self.tools,
                    **kwargs,
                )
                self.assertEqual(
                    retry["status"],
                    "idempotent" if boundary == "result" else "accepted",
                )
                self.assertEqual(
                    self._submission_row_counts(claim["claim_id"]),
                    {
                        "journal": 1,
                        "transcript": 1,
                        "compliance": 1,
                        "governance": 1,
                        "result": 1,
                    },
                )
                self.assertTrue(sealed_output.is_file())

    def test_process_death_mid_response_seal_repairs_declared_artifact(
        self,
    ) -> None:
        """A journal-bound retry repairs a digest target left half-written."""
        request, claim = self._claim(nonce="-process-death-response-seal")
        out = self._good_envelope(request=request, claim=claim)
        transcript = self._transcript_artifact(request, claim)
        kwargs = self._binding_kwargs(request, transcript)
        output_digest = sha256_file(out).removeprefix("sha256:")
        sealed_output = (
            self.tools
            / "agent-invocations"
            / "outputs"
            / "content-addressed"
            / "responses"
            / f"{output_digest}.md"
        )
        process = multiprocessing.get_context("spawn").Process(
            target=_submit_and_exit_after_append_boundary,
            kwargs={
                "boundary": "response_seal",
                "repo": self.repo.as_posix(),
                "tools": self.tools.as_posix(),
                "claim_id": claim["claim_id"],
                "agent_id": "judge-worker-001",
                "lease_token": claim["lease_token"],
                "output_path": out.as_posix(),
                "binding_kwargs": kwargs,
            },
        )
        process.start()
        process.join(timeout=30)
        if process.is_alive():
            process.kill()
            process.join(timeout=5)
            self.fail("submit child hung during response seal")
        self.assertEqual(process.exitcode, 86)
        process.close()

        self.assertTrue(sealed_output.is_file())
        self.assertNotEqual(sealed_output.read_bytes(), out.read_bytes())
        self.assertEqual(
            self._submission_row_counts(claim["claim_id"]),
            {
                "journal": 1,
                "transcript": 0,
                "compliance": 0,
                "governance": 0,
                "result": 0,
            },
        )

        recovered = submit_claim_result(
            claim_id=claim["claim_id"],
            agent_id="judge-worker-001",
            lease_token=claim["lease_token"],
            output_path=out,
            workspace_root=self.repo,
            base_dir=self.tools,
            **kwargs,
        )

        self.assertEqual(recovered["status"], "accepted")
        self.assertEqual(sealed_output.read_bytes(), out.read_bytes())
        self.assertEqual(
            self._submission_row_counts(claim["claim_id"]),
            {
                "journal": 1,
                "transcript": 1,
                "compliance": 1,
                "governance": 1,
                "result": 1,
            },
        )

    def test_post_seal_process_death_recovers_without_raw_sources(self) -> None:
        """Sealed journal evidence remains recoverable after raw cleanup."""
        (
            _request,
            claim,
            out,
            transcript,
            kwargs,
            _sealed_output,
            _sealed_transcript,
        ) = self._crash_after_submission_seals(
            nonce="-process-death-post-seal"
        )

        out.unlink()
        transcript.unlink()
        recovered = submit_claim_result(
            claim_id=claim["claim_id"],
            agent_id="judge-worker-001",
            lease_token=claim["lease_token"],
            output_path=out,
            workspace_root=self.repo,
            base_dir=self.tools,
            **kwargs,
        )

        self.assertEqual(recovered["status"], "accepted")
        self.assertEqual(
            self._submission_row_counts(claim["claim_id"]),
            {
                "journal": 1,
                "transcript": 1,
                "compliance": 1,
                "governance": 1,
                "result": 1,
            },
        )

    def test_post_seal_recovery_allows_deleted_same_store_response(self) -> None:
        """The mutable expected-output file is not a recovery dependency."""
        (
            _request,
            claim,
            out,
            _transcript,
            kwargs,
            _sealed_output,
            _sealed_transcript,
        ) = self._crash_after_submission_seals(
            nonce="-post-seal-deleted-store-response"
        )
        out.unlink()

        recovered = submit_claim_result(
            claim_id=claim["claim_id"],
            agent_id="judge-worker-001",
            lease_token=claim["lease_token"],
            output_path=out,
            workspace_root=self.repo,
            base_dir=self.tools,
            **kwargs,
        )

        self.assertEqual(recovered["status"], "accepted")
        self.assertEqual(
            self._submission_row_counts(claim["claim_id"]),
            {
                "journal": 1,
                "transcript": 1,
                "compliance": 1,
                "governance": 1,
                "result": 1,
            },
        )

    def test_post_seal_recovery_rejects_raw_content_drift(self) -> None:
        """Existing mutable sources remain drift evidence, never replacements."""
        for source_kind in ("response", "transcript"):
            with self.subTest(source_kind=source_kind):
                (
                    _request,
                    claim,
                    out,
                    transcript,
                    kwargs,
                    _sealed_output,
                    _sealed_transcript,
                ) = self._crash_after_submission_seals(
                    nonce=f"-post-seal-{source_kind}-drift"
                )
                if source_kind == "response":
                    out.write_bytes(out.read_bytes() + b"\n")
                else:
                    transcript.write_bytes(
                        transcript.read_bytes() + b"mutated\n"
                    )

                with self.assertRaisesRegex(
                    GovernanceError,
                    "submit_claim_result_prepared_operation_drift",
                ):
                    submit_claim_result(
                        claim_id=claim["claim_id"],
                        agent_id="judge-worker-001",
                        lease_token=claim["lease_token"],
                        output_path=out,
                        workspace_root=self.repo,
                        base_dir=self.tools,
                        **kwargs,
                    )
                self.assertEqual(
                    self._submission_row_counts(claim["claim_id"]),
                    {
                        "journal": 1,
                        "transcript": 0,
                        "compliance": 0,
                        "governance": 0,
                        "result": 0,
                    },
                )

    def test_post_seal_recovery_rejects_path_and_argument_drift(self) -> None:
        for drift_kind in ("output_path", "context_hash"):
            with self.subTest(drift_kind=drift_kind):
                (
                    _request,
                    claim,
                    out,
                    transcript,
                    kwargs,
                    _sealed_output,
                    _sealed_transcript,
                ) = self._crash_after_submission_seals(
                    nonce=f"-post-seal-{drift_kind}-drift"
                )
                out.unlink()
                transcript.unlink()
                retry_output = out
                retry_kwargs = dict(kwargs)
                if drift_kind == "output_path":
                    retry_output = out.with_name(f"alternate-{out.name}")
                else:
                    retry_kwargs["context_hash"] = "sha256:" + ("0" * 64)

                with self.assertRaisesRegex(
                    GovernanceError,
                    "submit_claim_result_prepared_operation_drift",
                ):
                    submit_claim_result(
                        claim_id=claim["claim_id"],
                        agent_id="judge-worker-001",
                        lease_token=claim["lease_token"],
                        output_path=retry_output,
                        workspace_root=self.repo,
                        base_dir=self.tools,
                        **retry_kwargs,
                    )

    def test_post_seal_recovery_requires_raw_for_missing_or_corrupt_seal(
        self,
    ) -> None:
        for scenario in (
            "response_missing",
            "response_corrupt",
            "transcript_missing",
            "transcript_corrupt",
        ):
            with self.subTest(scenario=scenario):
                (
                    _request,
                    claim,
                    out,
                    transcript,
                    kwargs,
                    sealed_output,
                    sealed_transcript,
                ) = self._crash_after_submission_seals(
                    nonce=f"-post-seal-{scenario}"
                )
                out.unlink()
                transcript.unlink()
                damaged = (
                    sealed_output
                    if scenario.startswith("response")
                    else sealed_transcript
                )
                if scenario.endswith("missing"):
                    damaged.unlink()
                    expected_error = "artifact_missing"
                else:
                    damaged.chmod(0o644)
                    damaged.write_bytes(b"corrupt sealed bytes\n")
                    expected_error = "artifact_hash_mismatch"

                with self.assertRaisesRegex(GovernanceError, expected_error):
                    submit_claim_result(
                        claim_id=claim["claim_id"],
                        agent_id="judge-worker-001",
                        lease_token=claim["lease_token"],
                        output_path=out,
                        workspace_root=self.repo,
                        base_dir=self.tools,
                        **kwargs,
                    )
                self.assertEqual(
                    self._submission_row_counts(claim["claim_id"]),
                    {
                        "journal": 1,
                        "transcript": 0,
                        "compliance": 0,
                        "governance": 0,
                        "result": 0,
                    },
                )

    def test_prepared_operation_rejects_same_envelope_with_binding_drift(self) -> None:
        """A retry cannot replace a journal-bound transcript artifact."""
        request, claim = self._claim()
        out = self._good_envelope(request=request, claim=claim)
        transcript = self._transcript_artifact(request, claim)
        kwargs = self._binding_kwargs(request, transcript)
        real_append = ledger.StateTransaction.append_declared_jsonl

        def crash_after_journal(transaction, path, record, **append_kwargs):
            stored = real_append(transaction, path, record, **append_kwargs)
            if (
                record.get("event") == "result_submission_prepared"
                and record.get("claim_id") == claim["claim_id"]
            ):
                raise OSError("injected crash after journal append")
            return stored

        with mock.patch.object(
            ledger.StateTransaction,
            "append_declared_jsonl",
            crash_after_journal,
        ), self.assertRaisesRegex(OSError, "after journal append"):
            submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                output_path=out,
                workspace_root=self.repo,
                base_dir=self.tools,
                **kwargs,
            )

        alternate_transcript = transcript.with_name("alternate-transcript.txt")
        alternate_transcript.write_bytes(transcript.read_bytes())
        drifted_kwargs = {
            **kwargs,
            "transcript_artifact_ref": alternate_transcript.resolve().as_posix(),
        }
        with self.assertRaisesRegex(
            GovernanceError,
            "submit_claim_result_prepared_operation_drift",
        ):
            submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                output_path=out,
                workspace_root=self.repo,
                base_dir=self.tools,
                **drifted_kwargs,
            )

        self.assertEqual(
            self._submission_row_counts(claim["claim_id"]),
            {
                "journal": 1,
                "transcript": 0,
                "compliance": 0,
                "governance": 0,
                "result": 0,
            },
        )

    def test_prepared_operation_recovers_after_expiry_without_requeue(self) -> None:
        """An authenticated exact retry owns its prepared commit past expiry."""
        request, claim = self._claim(nonce="-prepared-expiry")
        out = self._good_envelope(request=request, claim=claim)
        transcript = self._transcript_artifact(request, claim)
        kwargs = self._binding_kwargs(request, transcript)
        real_append = ledger.StateTransaction.append_declared_jsonl

        def crash_after_journal(transaction, path, record, **append_kwargs):
            stored = real_append(transaction, path, record, **append_kwargs)
            if (
                record.get("event") == "result_submission_prepared"
                and record.get("claim_id") == claim["claim_id"]
            ):
                raise OSError("injected crash after journal append")
            return stored

        with mock.patch.object(
            ledger.StateTransaction,
            "append_declared_jsonl",
            crash_after_journal,
        ), self.assertRaisesRegex(OSError, "after journal append"):
            submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                output_path=out,
                workspace_root=self.repo,
                base_dir=self.tools,
                **kwargs,
            )

        expired_at = datetime.fromisoformat(
            claim["lease_expires_at"].replace("Z", "+00:00")
        ) + timedelta(seconds=1)
        reaped = reap_stale_claims(base_dir=self.tools, now=expired_at)
        self.assertEqual(reaped, {"stale": [], "requeued": [], "human_required": []})
        self.assertEqual(
            derive_request_state(
                request_id=request["request_id"],
                base_dir=self.tools,
                now=expired_at,
            ),
            "CLAIMED",
        )

        with mock.patch.object(
            agent_invocations,
            "_utc_now_dt",
            return_value=expired_at,
        ):
            with self.assertRaisesRegex(GovernanceError, "lease_token mismatch"):
                submit_claim_result(
                    claim_id=claim["claim_id"],
                    agent_id="judge-worker-001",
                    lease_token="not-the-prepared-owner-token",
                    output_path=out,
                    workspace_root=self.repo,
                    base_dir=self.tools,
                    **kwargs,
                )
            retry = submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                output_path=out,
                workspace_root=self.repo,
                base_dir=self.tools,
                **kwargs,
            )

        self.assertEqual(retry["status"], "accepted")
        self.assertEqual(
            self._submission_row_counts(claim["claim_id"]),
            {
                "journal": 1,
                "transcript": 1,
                "compliance": 1,
                "governance": 1,
                "result": 1,
            },
        )

    def test_prepared_operation_blocks_heartbeat_and_release(self) -> None:
        """Lifecycle writers cannot overtake a journal-only commit."""
        request, claim = self._claim(nonce="-prepared-lifecycle-block")
        out = self._good_envelope(request=request, claim=claim)
        transcript = self._transcript_artifact(request, claim)
        real_append = ledger.StateTransaction.append_declared_jsonl

        def crash_after_journal(transaction, path, record, **append_kwargs):
            stored = real_append(transaction, path, record, **append_kwargs)
            if (
                record.get("event") == "result_submission_prepared"
                and record.get("claim_id") == claim["claim_id"]
            ):
                raise OSError("injected crash after journal append")
            return stored

        with mock.patch.object(
            ledger.StateTransaction,
            "append_declared_jsonl",
            crash_after_journal,
        ), self.assertRaisesRegex(OSError, "after journal append"):
            submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                output_path=out,
                workspace_root=self.repo,
                base_dir=self.tools,
                **self._binding_kwargs(request, transcript),
            )

        with self.assertRaisesRegex(
            GovernanceError,
            "result submission commit pending",
        ):
            heartbeat_claim(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                base_dir=self.tools,
            )
        with self.assertRaisesRegex(
            GovernanceError,
            "result submission commit pending",
        ):
            release_claim(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                reason="submit_rejected",
                base_dir=self.tools,
            )

        events = [
            row.get("event")
            for row in load_jsonl(self.tools / "agent-invocations" / "claims.jsonl")
            if row.get("claim_id") == claim["claim_id"]
        ]
        self.assertEqual(events, ["claimed", "result_submission_prepared"])

    def test_prepared_operation_resumes_after_store_moves_roots(self) -> None:
        """Prepared bindings and artifact refs contain no checkout host paths."""
        request, claim = self._claim(nonce="-portable-prepared")
        out = self._good_envelope(request=request, claim=claim)
        transcript = self._transcript_artifact(request, claim)
        kwargs = self._binding_kwargs(request, transcript)
        real_append = ledger.StateTransaction.append_declared_jsonl

        def crash_after_journal(transaction, path, record, **append_kwargs):
            stored = real_append(transaction, path, record, **append_kwargs)
            if (
                record.get("event") == "result_submission_prepared"
                and record.get("claim_id") == claim["claim_id"]
            ):
                raise OSError("injected crash after journal append")
            return stored

        with mock.patch.object(
            ledger.StateTransaction,
            "append_declared_jsonl",
            crash_after_journal,
        ), self.assertRaisesRegex(OSError, "after journal append"):
            submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                output_path=out,
                workspace_root=self.repo,
                base_dir=self.tools,
                **kwargs,
            )

        copied_parent = Path(tempfile.mkdtemp(prefix="aria-portable-retry-"))
        self.addCleanup(shutil.rmtree, copied_parent, True)
        copied_repo = copied_parent / "repo-copy"
        shutil.copytree(self.repo, copied_repo)
        copied_tools = copied_repo / self.tools.relative_to(self.repo)
        copied_out = copied_repo / out.relative_to(self.repo)
        copied_transcript = copied_repo / transcript.relative_to(self.repo)
        copied_kwargs = self._binding_kwargs(request, copied_transcript)

        retry = submit_claim_result(
            claim_id=claim["claim_id"],
            agent_id="judge-worker-001",
            lease_token=claim["lease_token"],
            output_path=copied_out,
            workspace_root=copied_repo,
            base_dir=copied_tools,
            **copied_kwargs,
        )

        self.assertEqual(retry["status"], "accepted")
        journal = next(
            row
            for row in load_jsonl(
                copied_tools / "agent-invocations" / "claims.jsonl"
            )
            if row.get("claim_id") == claim["claim_id"]
            and row.get("event") == "result_submission_prepared"
        )
        serialized_journal = json.dumps(journal, sort_keys=True)
        self.assertNotIn(self.repo.resolve().as_posix(), serialized_journal)
        self.assertNotIn(copied_repo.resolve().as_posix(), serialized_journal)

    def test_submission_seals_one_immutable_output_snapshot(self) -> None:
        """Validation, hashes, and replay artifact all use the same bytes."""
        request, claim = self._claim(nonce="-immutable-output")
        out = self._good_envelope(request=request, claim=claim)
        transcript = self._transcript_artifact(request, claim)
        original_bytes = out.read_bytes()
        original_hash = sha256_file(out)
        real_snapshot_read = agent_invocations._read_stable_submission_artifact
        replaced = False

        def replace_after_snapshot(path: Path) -> bytes:
            nonlocal replaced
            content = real_snapshot_read(path)
            if not replaced and Path(path).absolute() == out.absolute():
                replaced = True
                replacement = json.loads(original_bytes.decode("utf-8"))
                replacement["details"]["confidence"] = 0.11
                replacement_path = out.with_name(f".{out.name}.replacement")
                replacement_path.write_text(
                    json.dumps(replacement),
                    encoding="utf-8",
                )
                os.replace(replacement_path, out)
            return content

        with mock.patch.object(
            agent_invocations,
            "_read_stable_submission_artifact",
            replace_after_snapshot,
        ):
            result = submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                output_path=out,
                workspace_root=self.repo,
                base_dir=self.tools,
                **self._binding_kwargs(request, transcript),
            )

        self.assertTrue(replaced, "source mutation hook did not execute")
        self.assertEqual(result["status"], "accepted")
        self.assertEqual(result["row"]["output_hash"], original_hash)
        sealed = agent_invocations.resolve_output_artifact_path(
            self.tools,
            result["row"]["output_path"],
        )
        self.assertNotEqual(sealed.resolve(), out.resolve())
        self.assertEqual(sealed.read_bytes(), original_bytes)

    def test_submission_rejects_output_leaf_symlink_without_ledger_effects(self) -> None:
        request, claim = self._claim(nonce="-output-symlink")
        out = self._good_envelope(request=request, claim=claim)
        target = out.with_name(f"real-{out.name}")
        out.replace(target)
        out.symlink_to(target.name)
        transcript = self._transcript_artifact(request, claim)

        with self.assertRaisesRegex(GovernanceError, "output_path_unreadable"):
            submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                output_path=out,
                workspace_root=self.repo,
                base_dir=self.tools,
                **self._binding_kwargs(request, transcript),
            )

        self.assertEqual(
            self._submission_row_counts(claim["claim_id"]),
            {
                "journal": 0,
                "transcript": 0,
                "compliance": 0,
                "governance": 0,
                "result": 0,
            },
        )

    def test_submission_rejects_transcript_leaf_symlink_without_ledger_effects(self) -> None:
        request, claim = self._claim(nonce="-transcript-symlink")
        out = self._good_envelope(request=request, claim=claim)
        transcript = self._transcript_artifact(request, claim)
        target = transcript.with_name(f"real-{transcript.name}")
        transcript.replace(target)
        transcript.symlink_to(target.name)
        kwargs = self._binding_kwargs(request, transcript)
        kwargs["transcript_artifact_ref"] = transcript.absolute().as_posix()

        with self.assertRaisesRegex(
            GovernanceError,
            "transcript_artifact_ref_unreadable",
        ):
            submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                output_path=out,
                workspace_root=self.repo,
                base_dir=self.tools,
                **kwargs,
            )

        self.assertEqual(
            self._submission_row_counts(claim["claim_id"]),
            {
                "journal": 0,
                "transcript": 0,
                "compliance": 0,
                "governance": 0,
                "result": 0,
            },
        )

    def test_submission_rejects_sealed_output_symlink_without_touching_target(
        self,
    ) -> None:
        """A preplanted digest-path symlink cannot redirect artifact writes."""
        request, claim = self._claim(nonce="-sealed-output-symlink")
        out = self._good_envelope(request=request, claim=claim)
        transcript = self._transcript_artifact(request, claim)
        digest = sha256_file(out).removeprefix("sha256:")
        sealed_output = (
            self.tools
            / "agent-invocations"
            / "outputs"
            / "content-addressed"
            / "responses"
            / f"{digest}.md"
        )
        sealed_output.parent.mkdir(parents=True, exist_ok=True)
        redirect_target = self.repo / "must-not-be-touched.txt"
        original_redirect_bytes = b"outside sealed artifact store\n"
        redirect_target.write_bytes(original_redirect_bytes)
        sealed_output.symlink_to(redirect_target)

        with self.assertRaisesRegex(
            GovernanceError,
            "submission_artifact_path_symlink",
        ):
            submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                output_path=out,
                workspace_root=self.repo,
                base_dir=self.tools,
                **self._binding_kwargs(request, transcript),
            )

        self.assertEqual(redirect_target.read_bytes(), original_redirect_bytes)
        self.assertTrue(sealed_output.is_symlink())
        self.assertEqual(
            self._submission_row_counts(claim["claim_id"]),
            {
                "journal": 0,
                "transcript": 0,
                "compliance": 0,
                "governance": 0,
                "result": 0,
            },
        )

    def test_unreadable_terminal_replay_rejects_different_raw_bytes(self) -> None:
        _request, claim = self._claim(nonce="-unreadable-raw-drift")
        out = self.tools / "agent-invocations" / "outputs" / "raw-drift.md"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"not-json-one")

        first = submit_claim_result(
            claim_id=claim["claim_id"],
            agent_id="judge-worker-001",
            lease_token=claim["lease_token"],
            output_path=out,
            workspace_root=self.repo,
            base_dir=self.tools,
        )
        self.assertEqual(first["status"], "rejected")

        out.write_bytes(b"not-json-two-DIFFERENT")
        with self.assertRaisesRegex(
            GovernanceError,
            "submit_claim_result_duplicate_with_drift",
        ):
            submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                output_path=out,
                workspace_root=self.repo,
                base_dir=self.tools,
            )
        self.assertEqual(len(self._result_rows(claim["claim_id"])), 1)

    def test_invalid_authority_leaves_no_content_addressed_artifact(self) -> None:
        response_dir = (
            self.tools
            / "agent-invocations"
            / "outputs"
            / "content-addressed"
            / "responses"
        )
        for scenario in ("expired", "released"):
            with self.subTest(scenario=scenario):
                request, claim = self._claim(nonce=f"-no-orphan-{scenario}")
                out = self._good_envelope(request=request, claim=claim)
                transcript = self._transcript_artifact(request, claim)
                kwargs = self._binding_kwargs(request, transcript)
                before = set(response_dir.glob("*.md"))
                if scenario == "released":
                    release_claim(
                        claim_id=claim["claim_id"],
                        agent_id="judge-worker-001",
                        lease_token=claim["lease_token"],
                        reason="submit_rejected",
                        base_dir=self.tools,
                    )
                    clock = nullcontext()
                    error = "already terminal"
                else:
                    expired_at = datetime.fromisoformat(
                        claim["lease_expires_at"].replace("Z", "+00:00")
                    ) + timedelta(seconds=1)
                    clock = mock.patch.object(
                        agent_invocations,
                        "_utc_now_dt",
                        return_value=expired_at,
                    )
                    error = "lease_expired"
                with clock, self.assertRaisesRegex(GovernanceError, error):
                    submit_claim_result(
                        claim_id=claim["claim_id"],
                        agent_id="judge-worker-001",
                        lease_token=claim["lease_token"],
                        output_path=out,
                        workspace_root=self.repo,
                        base_dir=self.tools,
                        **kwargs,
                    )
                self.assertEqual(set(response_dir.glob("*.md")), before)
                self.assertEqual(
                    self._submission_row_counts(claim["claim_id"])["journal"],
                    0,
                )

    def test_missing_sealed_transcript_after_transcript_append_fails_closed(self) -> None:
        request, claim = self._claim(nonce="-missing-sealed-transcript")
        out = self._good_envelope(request=request, claim=claim)
        transcript = self._transcript_artifact(request, claim)
        kwargs = self._binding_kwargs(request, transcript)
        real_append = ledger.StateTransaction.append_declared_jsonl

        def crash_after_transcript(transaction, path, record, **append_kwargs):
            stored = real_append(transaction, path, record, **append_kwargs)
            if (
                record.get("submission_effect") == "transcript"
                and record.get("claim_id") == claim["claim_id"]
            ):
                raise OSError("injected crash after transcript append")
            return stored

        with mock.patch.object(
            ledger.StateTransaction,
            "append_declared_jsonl",
            crash_after_transcript,
        ), self.assertRaisesRegex(OSError, "after transcript append"):
            submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                output_path=out,
                workspace_root=self.repo,
                base_dir=self.tools,
                **kwargs,
            )

        journal = next(
            row
            for row in load_jsonl(
                self.tools / "agent-invocations" / "claims.jsonl"
            )
            if row.get("claim_id") == claim["claim_id"]
            and row.get("event") == "result_submission_prepared"
        )
        sealed_ref = journal["prepared"]["result_row"][
            "transcript_artifact_ref"
        ]
        sealed = agent_invocations.resolve_output_artifact_path(
            self.tools,
            sealed_ref,
        )
        sealed.unlink()

        with self.assertRaisesRegex(
            GovernanceError,
            "submission_prepared_transcript_artifact_missing",
        ):
            submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                output_path=out,
                workspace_root=self.repo,
                base_dir=self.tools,
                **kwargs,
            )
        self.assertEqual(self._result_rows(claim["claim_id"]), [])

    def test_compliance_governance_crash_retries_without_duplicates(self) -> None:
        """A rejected grade and its audit event resume independently."""
        request, claim = self._claim(nonce="-compliance-governance-crash")
        canonical = self._good_envelope(request=request, claim=claim)
        mismatched = canonical.with_name("compliance-retry-path-mismatch.json")
        mismatched.write_bytes(canonical.read_bytes())
        real_append = ledger.StateTransaction.append_declared_jsonl

        def crash_after_compliance_event(transaction, path, record, **append_kwargs):
            stored = real_append(transaction, path, record, **append_kwargs)
            if (
                record.get("kind") == "agent_compliance_violation"
                and record.get("details", {}).get("claim_id") == claim["claim_id"]
            ):
                raise OSError("injected crash after compliance governance append")
            return stored

        with mock.patch.object(
            ledger.StateTransaction,
            "append_declared_jsonl",
            crash_after_compliance_event,
        ), self.assertRaisesRegex(OSError, "after compliance governance append"):
            submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                output_path=mismatched,
                workspace_root=self.repo,
                base_dir=self.tools,
            )

        self.assertEqual(self._result_rows(claim["claim_id"]), [])
        retry = submit_claim_result(
            claim_id=claim["claim_id"],
            agent_id="judge-worker-001",
            lease_token=claim["lease_token"],
            output_path=mismatched,
            workspace_root=self.repo,
            base_dir=self.tools,
        )
        self.assertEqual(retry["status"], "rejected")

        journal = next(
            row
            for row in load_jsonl(
                self.tools / "agent-invocations" / "claims.jsonl"
            )
            if row.get("claim_id") == claim["claim_id"]
            and row.get("event") == "result_submission_prepared"
        )
        operation_id = journal["operation_id"]
        operation_rows = []
        for path in (
            self.tools / "agent-compliance.jsonl",
            self.tools / "governance.jsonl",
            self.tools / "agent-invocations" / "results.jsonl",
        ):
            operation_rows.extend(
                row
                for row in load_jsonl(path)
                if row.get("submission_operation_id") == operation_id
            )
        self.assertEqual(
            [row.get("submission_effect") for row in operation_rows],
            [
                "compliance",
                "compliance_governance",
                "terminal_governance",
                "result",
            ],
        )

    def test_release_between_initial_check_and_transaction_blocks_submit(self) -> None:
        """The claims ledger CAS must reject an accepted-after-terminal race."""
        request, claim = self._claim()
        out = self._good_envelope(request=request, claim=claim)
        transcript = self._transcript_artifact(request, claim)
        kwargs = self._binding_kwargs(request, transcript)
        response_dir = (
            self.tools
            / "agent-invocations"
            / "outputs"
            / "content-addressed"
            / "responses"
        )
        artifacts_before = set(response_dir.glob("*.md"))
        real_state_transaction = agent_invocations.state_transaction
        submit_waiting = threading.Event()
        release_finished = threading.Event()
        submit_errors: list[BaseException] = []

        @contextmanager
        def pause_submit_before_transaction(paths, **transaction_kwargs):
            if (
                threading.current_thread().name == "submit-before-release-race"
                and Path(
                    self.tools / "agent-invocations" / "results.jsonl"
                ).resolve()
                in {Path(path).resolve() for path in paths}
            ):
                submit_waiting.set()
                if not release_finished.wait(timeout=5):
                    raise TimeoutError("release did not finish")
            with real_state_transaction(paths, **transaction_kwargs) as transaction:
                yield transaction

        def run_submit() -> None:
            try:
                submit_claim_result(
                    claim_id=claim["claim_id"],
                    agent_id="judge-worker-001",
                    lease_token=claim["lease_token"],
                    output_path=out,
                    workspace_root=self.repo,
                    base_dir=self.tools,
                    **kwargs,
                )
            except BaseException as exc:  # assertion inspects the worker failure
                submit_errors.append(exc)

        with mock.patch.object(
            agent_invocations,
            "state_transaction",
            pause_submit_before_transaction,
        ):
            submit_thread = threading.Thread(
                target=run_submit,
                name="submit-before-release-race",
            )
            submit_thread.start()
            self.assertTrue(submit_waiting.wait(timeout=5))
            release_claim(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                reason="submit_rejected",
                base_dir=self.tools,
            )
            release_finished.set()
            submit_thread.join(timeout=5)

        self.assertFalse(submit_thread.is_alive())
        self.assertEqual(len(submit_errors), 1, submit_errors)
        self.assertIsInstance(submit_errors[0], GovernanceError)
        self.assertIn("already terminal", str(submit_errors[0]))
        self.assertEqual(self._result_rows(claim["claim_id"]), [])
        self.assertEqual(
            self._submission_row_counts(claim["claim_id"]),
            {
                "journal": 0,
                "transcript": 0,
                "compliance": 0,
                "governance": 0,
                "result": 0,
            },
        )
        self.assertEqual(set(response_dir.glob("*.md")), artifacts_before)

    def _assert_submit_wins_inverse_lifecycle_race(self, operation: str) -> None:
        """Pause a lifecycle writer after its stale read but before mutation."""
        request, claim = self._claim(nonce=f"-inverse-{operation}")
        out = self._good_envelope(request=request, claim=claim)
        transcript = self._transcript_artifact(request, claim)
        kwargs = self._binding_kwargs(request, transcript)
        claims_path = (self.tools / "agent-invocations" / "claims.jsonl").resolve()
        results_path = (self.tools / "agent-invocations" / "results.jsonl").resolve()
        target_event = {
            "release": "released",
            "heartbeat": "heartbeat",
            "reaper": "stale",
        }[operation]
        lifecycle_waiting = threading.Event()
        submit_finished = threading.Event()
        lifecycle_errors: list[BaseException] = []
        lifecycle_results: list[dict] = []
        real_append = agent_invocations.append_declared_jsonl
        real_state_transaction = agent_invocations.state_transaction

        def pause_legacy_append(path, record, **append_kwargs):
            if (
                threading.current_thread().name == f"{operation}-race"
                and Path(path).resolve() == claims_path
                and record.get("event") == target_event
            ):
                lifecycle_waiting.set()
                if not submit_finished.wait(timeout=5):
                    raise TimeoutError("submit did not finish")
            return real_append(path, record, **append_kwargs)

        @contextmanager
        def pause_lifecycle_transaction(paths, **transaction_kwargs):
            resolved = {Path(path).resolve() for path in paths}
            if (
                threading.current_thread().name == f"{operation}-race"
                and {claims_path, results_path}.issubset(resolved)
            ):
                lifecycle_waiting.set()
                if not submit_finished.wait(timeout=5):
                    raise TimeoutError("submit did not finish")
            with real_state_transaction(paths, **transaction_kwargs) as transaction:
                yield transaction

        def run_lifecycle() -> None:
            try:
                if operation == "release":
                    lifecycle_results.append(
                        release_claim(
                            claim_id=claim["claim_id"],
                            agent_id="judge-worker-001",
                            lease_token=claim["lease_token"],
                            reason="submit_rejected",
                            base_dir=self.tools,
                        )
                    )
                elif operation == "heartbeat":
                    lifecycle_results.append(
                        heartbeat_claim(
                            claim_id=claim["claim_id"],
                            agent_id="judge-worker-001",
                            lease_token=claim["lease_token"],
                            base_dir=self.tools,
                        )
                    )
                else:
                    expiry = datetime.fromisoformat(
                        claim["lease_expires_at"].replace("Z", "+00:00")
                    ) + timedelta(seconds=1)
                    lifecycle_results.append(
                        reap_stale_claims(base_dir=self.tools, now=expiry)
                    )
            except BaseException as exc:  # assertion inspects worker failure
                lifecycle_errors.append(exc)

        with mock.patch.object(
            agent_invocations,
            "append_declared_jsonl",
            pause_legacy_append,
        ), mock.patch.object(
            agent_invocations,
            "state_transaction",
            pause_lifecycle_transaction,
        ):
            lifecycle_thread = threading.Thread(
                target=run_lifecycle,
                name=f"{operation}-race",
            )
            lifecycle_thread.start()
            self.assertTrue(lifecycle_waiting.wait(timeout=5))
            submitted = submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                output_path=out,
                workspace_root=self.repo,
                base_dir=self.tools,
                **kwargs,
            )
            submit_finished.set()
            lifecycle_thread.join(timeout=5)

        self.assertFalse(lifecycle_thread.is_alive())
        self.assertEqual(submitted["status"], "accepted")
        claim_events = [
            row.get("event")
            for row in load_jsonl(self.tools / "agent-invocations" / "claims.jsonl")
            if row.get("claim_id") == claim["claim_id"]
        ]
        self.assertNotIn(target_event, claim_events)
        if operation == "reaper":
            self.assertEqual(lifecycle_errors, [])
            self.assertEqual(
                lifecycle_results,
                [{"stale": [], "requeued": [], "human_required": []}],
            )
        else:
            self.assertEqual(len(lifecycle_errors), 1, lifecycle_errors)
            self.assertIsInstance(lifecycle_errors[0], GovernanceError)
            self.assertIn("result already terminal", str(lifecycle_errors[0]))

    def test_release_rechecks_result_after_submit_wins_lock(self) -> None:
        self._assert_submit_wins_inverse_lifecycle_race("release")

    def test_heartbeat_rechecks_result_after_submit_wins_lock(self) -> None:
        self._assert_submit_wins_inverse_lifecycle_race("heartbeat")

    def test_reaper_rechecks_result_after_submit_wins_lock(self) -> None:
        self._assert_submit_wins_inverse_lifecycle_race("reaper")

    def test_transcript_failure_writes_no_terminal_result(self) -> None:
        request, claim = self._claim()
        out = self._good_envelope(request=request, claim=claim)
        transcript = self._transcript_artifact(request, claim)
        transcripts_path = (
            self.tools / "agent-invocations" / "transcripts.jsonl"
        ).resolve()
        real_append = ledger.StateTransaction.append_declared_jsonl

        def fail_transcript_append(
            transaction: ledger.StateTransaction,
            path: str | Path,
            record: dict,
            *,
            expected_surface: str,
            bypass_profile_gate: bool = False,
        ) -> dict:
            if Path(path).resolve() == transcripts_path:
                raise OSError("injected transcript write failure")
            return real_append(
                transaction,
                path,
                record,
                expected_surface=expected_surface,
                bypass_profile_gate=bypass_profile_gate,
            )

        with mock.patch.object(
            ledger.StateTransaction,
            "append_declared_jsonl",
            fail_transcript_append,
        ), self.assertRaisesRegex(OSError, "injected transcript write failure"):
            submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                output_path=out,
                workspace_root=self.repo,
                base_dir=self.tools,
                **self._binding_kwargs(request, transcript),
            )

        self.assertEqual(self._result_rows(claim["claim_id"]), [])

    def test_rejection_governance_failure_writes_no_terminal_result(self) -> None:
        _request, claim = self._claim()
        out = self.tools / "agent-invocations" / "outputs" / "junk.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text("not-json", encoding="utf-8")

        with mock.patch.object(
            agent_invocations,
            "append_tools_governance",
            side_effect=OSError("injected governance write failure"),
        ), self.assertRaisesRegex(OSError, "injected governance write failure"):
            submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                output_path=out,
                workspace_root=self.repo,
                base_dir=self.tools,
            )

        self.assertEqual(self._result_rows(claim["claim_id"]), [])

    def test_accepted_result_requires_matching_transcript_artifact(self) -> None:
        request, claim = self._claim()
        out = self._good_envelope(request=request, claim=claim)
        bad_transcript = self.tools / "agent-invocations" / "outputs" / "transcript.txt"
        bad_transcript.parent.mkdir(parents=True, exist_ok=True)
        bad_transcript.write_text("different transcript\n", encoding="utf-8")
        from aria_kernel.tool_registry import GovernanceError

        with self.assertRaisesRegex(GovernanceError, "transcript_artifact_hash_mismatch"):
            submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                output_path=out,
                workspace_root=self.repo,
                base_dir=self.tools,
                context_hash=str(request["context_hash"]),
                prompt_hash=str(request["prompt_hash"]),
                transcript_hash=sha256_file(out),
                transcript_artifact_ref=bad_transcript.resolve().as_posix(),
            )

    def test_accepted_result_rejects_output_envelope_as_transcript(self) -> None:
        request, claim = self._claim()
        out = self._good_envelope(request=request, claim=claim)
        from aria_kernel.tool_registry import GovernanceError

        with self.assertRaisesRegex(GovernanceError, "transcript_artifact_must_not_be_output_envelope"):
            submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token=claim["lease_token"],
                output_path=out,
                workspace_root=self.repo,
                base_dir=self.tools,
                context_hash=str(request["context_hash"]),
                prompt_hash=str(request["prompt_hash"]),
                transcript_hash=sha256_file(out),
                transcript_artifact_ref=out.resolve().as_posix(),
            )

    def test_evidence_pointing_at_missing_file_rejected(self) -> None:
        request, claim = self._claim()
        # Plan 024 §B-2 — preserve the original missing-file rejection
        # intent: the satisfaction matrix is non-empty and matches the
        # criterion, evidence_refs path is inside allowed_scope but the
        # file genuinely doesn't exist on disk. The rejection should
        # surface from the file-existence check, not the matrix or
        # scope gates.
        envelope = {
            "$schema": "aria/agent-response/v1",
            "request_id": request["request_id"],
            "claim_id": claim["claim_id"],
            "agent_id": claim["agent_id"],
            "role": "evidence_judgment",
            "status": "submitted",
            "satisfaction_matrix": [
                {
                    "id": "F-001-evidence",
                    "verdict": "satisfied",
                    "evidence_refs": ["does/not/exist.ts:1"],
                },
            ],
            "evidence_refs": ["does/not/exist.ts:1"],
            "details": {"verdict": "true_positive", "confidence": 0.92},
        }
        out = self.tools / "agent-invocations" / "outputs" / "bad.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(envelope), encoding="utf-8")
        result = submit_claim_result(
            claim_id=claim["claim_id"],
            agent_id="judge-worker-001",
            lease_token=claim["lease_token"],
            output_path=out,
            workspace_root=self.repo,
            base_dir=self.tools,
        )
        self.assertEqual(result["status"], "rejected")
        joined = " ".join(result["reasons"])
        self.assertIn("evidence", joined)
        self.assertEqual(
            derive_request_state(request_id=request["request_id"], base_dir=self.tools),
            "REJECTED",
        )

    def test_lease_token_mismatch_raises(self) -> None:
        _, claim = self._claim()
        out = self.tools / "agent-invocations" / "outputs" / "x.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text("{}", encoding="utf-8")
        from aria_kernel.tool_registry import GovernanceError

        with self.assertRaisesRegex(GovernanceError, "lease_token mismatch"):
            submit_claim_result(
                claim_id=claim["claim_id"],
                agent_id="judge-worker-001",
                lease_token="00" * 24,
                output_path=out,
                workspace_root=self.repo,
                base_dir=self.tools,
            )

    def test_separation_of_duties_blocks_self_approval(self) -> None:
        # Build a request whose forbidden_agent_ids excludes the submitter.
        # Plan 024 §B-2 — strict path goes through claim_request, so
        # real must_satisfy + allowed_scope prevent _strict_request_view
        # from rejecting the legacy-shape conversion.
        request = create_agent_invocation_request(
            target_agent="aria-primary-planner",
            role="primary_plan",
            suggested_prompt="draft architecture-first plan",
            must_satisfy=[
                {"id": "sod-test", "criterion": "separation of duties enforced"},
            ],
            allowed_scope=["aria-kernel/**"],
            convergence_id="conv-002",
            base_dir=self.tools,
        )
        # Patch the request row so separation_of_duties forbids judge-worker-001.
        # (Direct edit is fine for the test; in production the planner sets it.)
        from aria_kernel.ledger import load_declared_jsonl, rewrite_declared_jsonl
        req_path = self.tools / "agent-invocations" / "requests.jsonl"
        rows = load_declared_jsonl(req_path, expected_surface="agent_invocation_requests")
        rows[-1]["separation_of_duties"] = {"forbidden_agent_ids": ["judge-worker-001"]}
        rewrite_declared_jsonl(
            req_path,
            rows,
            expected_surface="agent_invocation_requests",
            migration_id="test-fixture-separation-of-duties",
        )

        claim = claim_request(
            request_id=request["request_id"],
            agent_id="judge-worker-001",
            base_dir=self.tools,
        )
        envelope = {
            "$schema": "aria/agent-response/v1",
            "request_id": request["request_id"],
            "claim_id": claim["claim_id"],
            "agent_id": claim["agent_id"],
            "role": "primary_plan",
            "status": "submitted",
            "satisfaction_matrix": [],
            "evidence_refs": ["src.txt:1"],
        }
        out = self.tools / "agent-invocations" / "outputs" / "sod.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(envelope), encoding="utf-8")
        result = submit_claim_result(
            claim_id=claim["claim_id"],
            agent_id="judge-worker-001",
            lease_token=claim["lease_token"],
            output_path=out,
            workspace_root=self.repo,
            base_dir=self.tools,
        )
        self.assertEqual(result["status"], "rejected")
        joined = " ".join(result["reasons"])
        self.assertIn("separation_of_duties", joined)

    def test_unreadable_envelope_rejected_gracefully(self) -> None:
        request, claim = self._claim()
        out = self.tools / "agent-invocations" / "outputs" / "junk.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text("not-json", encoding="utf-8")
        result = submit_claim_result(
            claim_id=claim["claim_id"],
            agent_id="judge-worker-001",
            lease_token=claim["lease_token"],
            output_path=out,
            workspace_root=self.repo,
            base_dir=self.tools,
        )
        self.assertEqual(result["status"], "rejected")
        joined = " ".join(result["reasons"])
        self.assertIn("envelope_unreadable", joined)


if __name__ == "__main__":
    unittest.main()
