"""Tests for Plan 025 §B — CI executor live-path fix + 3 latent bugs.

Covers the surface fix (use ``agent-invocations list --request-id``
instead of the non-existent ``agent list-requests``) plus the three
latent bugs Planner-B identified in the same audit:

1. Silent swallow of ``returncode != 0`` falling through to
   ``request_envelope = {}`` — masked every CI failure as a
   successful no-op. Now release + return 1.
2. ``role`` string-mangle fallback in mock branch
   (``role or subagent_type.replace(…)``) re-introduced the
   synthesized identity that §B-8 explicitly removed for hard-coded
   literals. Now ``role: str`` is required at the function signature
   and an empty role is a ValueError, not a fabricated string.
3. ``Path("")`` from ``claim.get("expected_output_path") or ""`` —
   the field doesn't exist on claim rows (claim_request:633-655
   returns a minimal lease-event dict). Now sourced from the request
   row via SSoT + validated non-empty before use.

The Tier-3 invariant test pins the canonical argv shape at module
load time so a future regression that re-introduces the broken
``agent list-requests`` form fails the assertion before it leaves
the test runner.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))

import ci_executor  # noqa: E402


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
        self.claim_response = MagicMock(
            returncode=0,
            stdout=json.dumps({
                "lease_token": self.lease_token,
                "claim_id": self.claim_id,
                "request_id": self.request_id,
                "agent_id": "ci-executor:gha-test",
            }),
            stderr="",
        )
        self.request_envelope = {
            "$schema": "aria/agent-invocation-request/v1",
            "request_id": self.request_id,
            "role": "evidence_judgment",
            "expected_output_path": str(self.expected_output),
            "must_satisfy": [{"id": "S1", "description": "test"}],
            "evidence_refs": ["aria-kernel/src"],
            "allowed_scope": ["aria-kernel/**"],
        }
        self.list_response_ok = MagicMock(
            returncode=0,
            stdout=json.dumps([self.request_envelope]),
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

    def test_live_path_fetches_request_row_via_agent_invocations_list_and_submits(self) -> None:
        # Plan 025 §B happy path: claim → agent-invocations list
        # --request-id (NOT agent list-requests) → invoke mock → submit.
        fake_run = _make_fake_run_sequence(
            self.claim_response,
            self.list_response_ok,
            self.submit_response_ok,
        )
        exit_code = self._run_main(fake_run)
        self.assertEqual(exit_code, 0)
        self.assertEqual(len(fake_run.captured), 3)
        step2_argv = fake_run.captured[1]
        self.assertIn("agent-invocations", step2_argv)
        self.assertIn("list", step2_argv)
        self.assertIn("--request-id", step2_argv)
        self.assertNotIn("list-requests", step2_argv)
        # Mock envelope written to the SSoT path read from the request row.
        self.assertTrue(self.expected_output.exists())
        envelope = json.loads(self.expected_output.read_text(encoding="utf-8"))
        self.assertEqual(envelope["claim_id"], self.claim_id)
        self.assertEqual(envelope["role"], "evidence_judgment")
        # Plan 024 §B-8 binding preserved — agent_id from real
        # subprocess output, not synthesized literal.
        self.assertEqual(envelope["agent_id"], "ci-executor:gha-test-run-1")

    def test_argv_shape_pins_REQUEST_ENVELOPE_LIST_ARGV_constant(self) -> None:
        # Plan 025 §B Tier-3 invariant: the constant pinned at module
        # load time + no captured argv contains the legacy broken form.
        self.assertEqual(
            ci_executor.REQUEST_ENVELOPE_LIST_ARGV,
            ("agent-invocations", "list", "--request-id"),
        )
        fake_run = _make_fake_run_sequence(
            self.claim_response,
            self.list_response_ok,
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

    def test_request_envelope_not_found_releases_claim_and_errors(self) -> None:
        # Plan 025 §B — empty list result must release claim + return 1.
        list_empty = MagicMock(returncode=0, stdout=json.dumps([]), stderr="")
        fake_run = _make_fake_run_sequence(
            self.claim_response,
            list_empty,
            self.release_response_ok,
        )
        exit_code = self._run_main(fake_run)
        self.assertEqual(exit_code, 1)
        # Third subprocess call MUST be release with the precise reason.
        release_argv = fake_run.captured[2]
        self.assertIn("release", release_argv)
        self.assertIn("--reason", release_argv)
        reason_idx = release_argv.index("--reason")
        self.assertEqual(
            release_argv[reason_idx + 1],
            "request_envelope_not_found",
        )

    def test_request_envelope_subprocess_nonzero_fails_fast(self) -> None:
        # Plan 025 §B latent-bug-1 closure — pre-fix returncode != 0
        # silently became request_envelope = {}; cost-cap then passed
        # on an empty envelope and the run proceeded with bogus state.
        # Now: release + return 1 with structured reason.
        list_failure = MagicMock(
            returncode=2,
            stdout="",
            stderr="invalid choice: 'list-requests'",
        )
        fake_run = _make_fake_run_sequence(
            self.claim_response,
            list_failure,
            self.release_response_ok,
        )
        exit_code = self._run_main(fake_run)
        self.assertEqual(exit_code, 1)
        release_argv = fake_run.captured[2]
        reason_idx = release_argv.index("--reason")
        self.assertEqual(
            release_argv[reason_idx + 1],
            "request_envelope_load_failed",
        )

    def test_request_envelope_missing_expected_output_path_releases_claim(self) -> None:
        # Plan 025 §B latent-bug-3 closure — missing field on the
        # request row MUST release + return 1, NOT proceed with Path("").
        envelope_no_path = {**self.request_envelope}
        envelope_no_path.pop("expected_output_path")
        list_no_path = MagicMock(
            returncode=0,
            stdout=json.dumps([envelope_no_path]),
            stderr="",
        )
        fake_run = _make_fake_run_sequence(
            self.claim_response,
            list_no_path,
            self.release_response_ok,
        )
        exit_code = self._run_main(fake_run)
        self.assertEqual(exit_code, 1)
        release_argv = fake_run.captured[2]
        reason_idx = release_argv.index("--reason")
        self.assertEqual(
            release_argv[reason_idx + 1],
            "request_envelope_missing_expected_output_path",
        )

    def test_invoke_claude_code_mock_empty_role_raises_no_string_mangle(self) -> None:
        # Plan 025 §B latent-bug-2 closure — invoke_claude_code mock
        # branch refuses empty role. Pre-fix ``role or subagent_type
        # .replace("aria-", "").replace("-judge", "_judgment")``
        # silently fabricated "evidence_judgment" from "aria-evidence-
        # judge" when role was empty. Now ValueError surfaces.
        with patch.dict(os.environ, {ci_executor.MOCK_MODE_ENV_VAR: "1"}):
            prompt = self.tmp / "prompt.md"
            prompt.write_text("test", encoding="utf-8")
            with self.assertRaises(ValueError) as ctx:
                ci_executor.invoke_claude_code(
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
