"""Tests for Plan 025 §B + Plan 026R §B.3 — CI executor live-path fix.

Plan 025 §B closed the original surface (use ``agent-invocations list
--request-id`` instead of the non-existent ``agent list-requests``)
plus three latent bugs. Plan 026R §B.3 supersedes that fix by FUSING
the request envelope into the ``agent claim`` return value, so the
executor no longer needs the second subprocess hop. Pre-§B.3 the
sequence was claim → envelope-list → submit (3 subprocesses); post-
§B.3 it is claim → submit (2 subprocesses). The §B.3 scenarios
covered here:

* Happy path: claim returns the fused envelope → submit succeeds.
* Schema check at consume: claim returns envelope missing
  ``expected_output_path`` or ``role`` → release + exit 1.

The pre-§B.3 ``request_envelope_load_failed`` / ``request_envelope_
not_found`` test cases are obsolete because the kernel's exclusive-
lock CAS path guarantees the claim either returns a valid envelope
or fails at claim time — there is no in-between window where the
envelope can disappear between claim and consume.

The Tier-3 negative invariant (``no captured argv contains 'agent
list-requests'``) remains because the legacy broken form should
NEVER be re-introduced. The constant ``REQUEST_ENVELOPE_LIST_ARGV``
is preserved in ci_executor.py as a migration audit trail and is
asserted not to be invoked from main().
"""
from __future__ import annotations

import json
import hashlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
_KERNEL_DIR = _REPO_ROOT / "aria-kernel"
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))
if str(_KERNEL_DIR) not in sys.path:
    sys.path.insert(0, str(_KERNEL_DIR))

import ci_executor  # noqa: E402
from aria_kernel.agent_invocations import render_invocation_prompt  # noqa: E402


def _make_fake_run_sequence(*responses):
    """Return a fake_run that returns each response in sequence,
    capturing argv per call so tests can assert exact subprocess
    shape. Falls back to a returncode=0 stub when more calls are
    made than responses (defensive — a test that hits the fallback
    is asserting it should NOT happen).
    """
    captured = []
    iterator = iter(responses)

    def fake_run(argv, *args, **kwargs):
        captured.append(tuple(argv))
        try:
            return next(iterator)
        except StopIteration:
            return MagicMock(returncode=0, stdout="", stderr="")

    fake_run.captured = captured
    return fake_run


def _bind_prompt_context(payload: dict) -> dict:
    bound = dict(payload)
    bound.setdefault("target_agent", "aria-evidence-judge")
    bound.setdefault("convergence_id", None)
    bound.setdefault("suggested_prompt", None)
    bound.setdefault("forbidden_scope", [])
    bound.setdefault("impact_graph_refs", [])
    bound.setdefault("validation_commands", [])
    rendered = render_invocation_prompt(bound)
    bound["prompt_hash"] = (
        "sha256:" + hashlib.sha256(rendered.encode("utf-8")).hexdigest()
    )
    bound.setdefault("context_hash", "sha256:" + "c" * 64)
    bound.setdefault("context_ledger_hash", "sha256:" + "d" * 64)
    bound.setdefault("prompt_ledger_hash", "sha256:" + "e" * 64)
    return bound


class LivePathFetchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-ci-live-"))
        self._old_cwd = os.getcwd()
        os.chdir(self.tmp)
        (self.tmp / "aria-tools").mkdir()
        (self.tmp / "aria-tools" / "agent-invocations" / "prompts").mkdir(parents=True)
        prompt_path = self.tmp / "aria-tools" / "agent-invocations" / "prompts" / "REQ-live-1.md"
        prompt_path.write_text("# test prompt", encoding="utf-8")

        self.request_id = "REQ-live-1"
        self.expected_output = self.tmp / "aria-tools" / "agent-invocations" / "outputs" / "REQ-live-1.json"
        self.lease_token = "lease-secret-aaaaaaaaaaaaaaaa"
        self.claim_id = "claim_live_1"
        # Plan 026R §B.3 — claim_response now carries the fused envelope.
        # The pre-§B.3 separate list_response_ok mock is consumed by the
        # claim_response shape itself; the executor no longer subprocesses
        # a second time for envelope load.
        claim_payload = _bind_prompt_context({
            "lease_token": self.lease_token,
            "claim_id": self.claim_id,
            "request_id": self.request_id,
            "agent_id": "ci-executor:gha-test",
            # §B.3 fused-envelope fields:
            "role": "evidence_judgment",
            "target_agent": "aria-evidence-judge",
            "expected_output_path": str(self.expected_output),
            "must_satisfy": [{"id": "S1", "description": "test"}],
            "evidence_refs": ["aria-kernel/src"],
            "allowed_scope": ["aria-kernel/**"],
            # §B.5 ledger-hash anchors (populated by §B.3):
            "claim_ledger_hash": "sha256:" + "a" * 64,
            "request_ledger_hash": "sha256:" + "b" * 64,
        })
        self.claim_response = MagicMock(
            returncode=0,
            stdout=json.dumps(claim_payload),
            stderr="",
        )
        self.submit_response_ok = MagicMock(
            returncode=0, stdout="{}", stderr="",
        )
        self.release_response_ok = MagicMock(
            returncode=0, stdout="", stderr="",
        )

    def tearDown(self) -> None:
        import shutil
        os.chdir(self._old_cwd)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run_main(self, fake_run):
        env_patch = {ci_executor.MOCK_MODE_ENV_VAR: "1", "GITHUB_RUN_ID": "test-run-1"}
        with patch.dict(os.environ, env_patch):
            with patch("ci_executor.subprocess.run", fake_run):
                return ci_executor.main([self.request_id, "aria-evidence-judge"])

    def test_live_path_consumes_fused_claim_envelope_and_submits(self) -> None:
        # Plan 026R §B.3 — happy path: claim returns the fused envelope
        # (no second subprocess), executor proceeds straight to submit.
        # Exactly TWO subprocess calls: claim + submit.
        fake_run = _make_fake_run_sequence(
            self.claim_response,
            self.submit_response_ok,
        )
        exit_code = self._run_main(fake_run)
        self.assertEqual(exit_code, 0)
        self.assertEqual(
            len(fake_run.captured), 2,
            f"§B.3 fused-envelope flow expects exactly 2 subprocess "
            f"calls (claim + submit); got {len(fake_run.captured)} — "
            f"argvs: {[list(c) for c in fake_run.captured]}",
        )
        # Mock envelope written to the SSoT path read from the claim row.
        self.assertTrue(self.expected_output.exists())
        envelope = json.loads(self.expected_output.read_text(encoding="utf-8"))
        self.assertEqual(envelope["claim_id"], self.claim_id)
        self.assertEqual(envelope["role"], "evidence_judgment")
        self.assertEqual(envelope["agent_id"], "ci-executor:gha-test-run-1")

    def test_no_argv_contains_legacy_agent_list_requests_form(self) -> None:
        # Plan 025 §B Tier-3 invariant preserved: no captured argv
        # contains the legacy broken ``agent list-requests`` form.
        fake_run = _make_fake_run_sequence(
            self.claim_response,
            self.submit_response_ok,
        )
        self._run_main(fake_run)
        for call_argv in fake_run.captured:
            for i in range(len(call_argv) - 1):
                if call_argv[i] == "agent" and call_argv[i + 1] == "list-requests":
                    self.fail(
                        f"banned argv shape detected (legacy 'agent "
                        f"list-requests'): {call_argv}"
                    )
        # Plan 026R §B.3 — no captured argv invokes the legacy
        # envelope-list subprocess (the constant exists as audit trail
        # only; production callsite is gone).
        legacy = ci_executor.REQUEST_ENVELOPE_LIST_ARGV
        for call_argv in fake_run.captured:
            # legacy is ("agent-invocations", "list", "--request-id")
            for i in range(len(call_argv) - len(legacy) + 1):
                if tuple(call_argv[i:i + len(legacy)]) == legacy:
                    self.fail(
                        f"§B.3 regression: captured argv still spawns "
                        f"the pre-§B.3 envelope-list subprocess: "
                        f"{call_argv}"
                    )

    def test_claim_response_missing_expected_output_path_releases_claim(self) -> None:
        # Plan 026R §B.3 — schema check at consume. If the kernel
        # returns a claim envelope missing expected_output_path (a
        # legacy request row authored before §B-2 strict fields),
        # the executor MUST release + exit 1.
        claim_no_path = MagicMock(
            returncode=0,
            stdout=json.dumps({
                "lease_token": self.lease_token,
                "claim_id": self.claim_id,
                "request_id": self.request_id,
                "agent_id": "ci-executor:gha-test",
                "role": "evidence_judgment",
                # expected_output_path intentionally absent.
                "must_satisfy": [{"id": "S1", "description": "test"}],
                "evidence_refs": ["aria-kernel/src"],
                "allowed_scope": ["aria-kernel/**"],
            }),
            stderr="",
        )
        fake_run = _make_fake_run_sequence(
            claim_no_path,
            self.release_response_ok,
        )
        exit_code = self._run_main(fake_run)
        self.assertEqual(exit_code, 1)
        # Second subprocess MUST be release with the precise reason.
        release_argv = fake_run.captured[1]
        self.assertIn("release", release_argv)
        self.assertIn("--reason", release_argv)
        reason_idx = release_argv.index("--reason")
        self.assertEqual(
            release_argv[reason_idx + 1],
            "request_envelope_missing_expected_output_path",
        )

    def test_claim_response_missing_role_releases_claim(self) -> None:
        # Plan 026R §B.3 — schema check at consume for missing role.
        claim_no_role = MagicMock(
            returncode=0,
            stdout=json.dumps({
                "lease_token": self.lease_token,
                "claim_id": self.claim_id,
                "request_id": self.request_id,
                "agent_id": "ci-executor:gha-test",
                # role intentionally absent.
                "expected_output_path": str(self.expected_output),
                "must_satisfy": [{"id": "S1", "description": "test"}],
                "evidence_refs": ["aria-kernel/src"],
                "allowed_scope": ["aria-kernel/**"],
            }),
            stderr="",
        )
        fake_run = _make_fake_run_sequence(
            claim_no_role,
            self.release_response_ok,
        )
        exit_code = self._run_main(fake_run)
        self.assertEqual(exit_code, 1)
        release_argv = fake_run.captured[1]
        reason_idx = release_argv.index("--reason")
        self.assertEqual(
            release_argv[reason_idx + 1],
            "request_envelope_missing_role",
        )

    def test_prompt_hash_mismatch_releases_claim_before_submit(self) -> None:
        # Snowball evidence showed prompt binding as a critical fail-closed
        # surface. Main owns the stronger contract: render through the kernel
        # prompt renderer, compare against the request row's prompt_hash, and
        # release the claim before any submit attempt when the hashes drift.
        bad_payload = json.loads(self.claim_response.stdout)
        bad_payload["prompt_hash"] = "sha256:" + "0" * 64
        claim_bad_prompt_hash = MagicMock(
            returncode=0,
            stdout=json.dumps(bad_payload),
            stderr="",
        )
        fake_run = _make_fake_run_sequence(
            claim_bad_prompt_hash,
            self.release_response_ok,
        )
        exit_code = self._run_main(fake_run)
        self.assertEqual(exit_code, 1)
        self.assertEqual(
            len(fake_run.captured), 2,
            "prompt hash mismatch must stop after claim + release",
        )
        self.assertFalse(
            self.expected_output.exists(),
            "executor must not write or submit an output envelope after "
            "prompt hash binding fails",
        )
        release_argv = fake_run.captured[1]
        self.assertIn("release", release_argv)
        self.assertIn("--reason", release_argv)
        reason_idx = release_argv.index("--reason")
        self.assertEqual(
            release_argv[reason_idx + 1],
            "prompt_hash_binding_mismatch",
        )

    def test_invoke_codex_cli_mock_empty_role_raises_no_string_mangle(self) -> None:
        # Plan 025 §B latent-bug-2 closure — invoke_codex_cli mock
        # branch refuses empty role. Pre-fix ``role or subagent_type
        # .replace("aria-", "").replace("-judge", "_judgment")``
        # silently fabricated "evidence_judgment" from "aria-evidence-
        # judge" when role was empty. Now ValueError surfaces.
        with patch.dict(os.environ, {ci_executor.MOCK_MODE_ENV_VAR: "1"}):
            prompt = self.tmp / "prompt.md"
            prompt.write_text("test", encoding="utf-8")
            with self.assertRaises(ValueError) as ctx:
                ci_executor.invoke_codex_cli(
                    request_id="REQ-bad",
                    subagent_type="aria-evidence-judge",
                    prompt_file=prompt,
                    output_path=self.tmp / "out.json",
                    timeout_seconds=300,
                    claim_id="claim_test_aaaaaaaa",
                    agent_id="ci-executor:gha-test",
                    role="",
                    must_satisfy=[],
                )
        self.assertIn("ci_executor_mock_missing_role", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
