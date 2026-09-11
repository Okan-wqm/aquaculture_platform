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

    def test_refused_spawn_releases_the_claim(self) -> None:
        """ORPHAN-HIGH-470 follow-through — a refused spawn must not hold the
        claim.

        `invoke_claude_cli` re-raises the whole perimeter family (auth / CLI /
        policy / usage — policy now including the `ResourceLimitsUnavailable`
        translated at the `claude_runtime._apply_resource_limits` boundary) as
        ClaudeCliUnavailable. Its handler in `main()` used to `sys.stderr.write`
        + `return 1` with the request still CLAIMED, so a runner missing
        `timeout` or bwrap blocked that request for the whole lease window and
        the next cycle found nothing to do. Every other fail-fast branch in
        `main()` releases; this one skipped it, and the branch it skipped is
        the one a fail-closed perimeter reaches first.
        """
        fake_run = _make_fake_run_sequence(
            self.claim_response,
            self.release_response_ok,
        )
        refusal = ci_executor.ClaudeCliUnavailable(
            "claude_resource_limits_required: resource_limits_unavailable"
        )
        with patch.object(ci_executor, "invoke_claude_cli", side_effect=refusal):
            exit_code = self._run_main(fake_run)
        self.assertEqual(exit_code, 1)
        self.assertEqual(
            len(fake_run.captured), 2,
            "a refused spawn must stop after claim + release; argvs: "
            f"{[list(c) for c in fake_run.captured]}",
        )
        release_argv = fake_run.captured[1]
        self.assertIn("release", release_argv)
        self.assertIn("--claim-id", release_argv)
        self.assertEqual(
            release_argv[release_argv.index("--claim-id") + 1], self.claim_id,
        )
        self.assertEqual(
            release_argv[release_argv.index("--reason") + 1],
            "claude_spawn_refused",
        )
        # The lease token never reaches argv — release carries it by env name.
        self.assertNotIn(self.lease_token, release_argv)
        self.assertIn("--lease-token-from-env", release_argv)

    def test_invoke_claude_cli_mock_empty_role_raises_no_string_mangle(self) -> None:
        # Plan 025 §B latent-bug-2 closure — invoke_claude_cli mock
        # branch refuses empty role. Pre-fix ``role or subagent_type
        # .replace("aria-", "").replace("-judge", "_judgment")``
        # silently fabricated "evidence_judgment" from "aria-evidence-
        # judge" when role was empty. Now ValueError surfaces.
        with patch.dict(os.environ, {ci_executor.MOCK_MODE_ENV_VAR: "1"}):
            prompt = self.tmp / "prompt.md"
            prompt.write_text("test", encoding="utf-8")
            with self.assertRaises(ValueError) as ctx:
                ci_executor.invoke_claude_cli(
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


class NativeAdaptiveAdmissionTests(unittest.TestCase):
    """Real mint and targeted executor; only the public status CLI is simulated."""

    def setUp(self) -> None:
        from tests._helpers.git_fixtures import _git, make_repo_with_initial_commit
        from aria_kernel import agent_invocations as ai
        from aria_kernel.agent_runtime_profile import read_agent_runtime_profile
        from aria_kernel.tool_registry import ensure_tools_binding

        scratch = tempfile.TemporaryDirectory(prefix="aria-s4-native-admission-")
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.home = self.root / "home"
        self.binary_dir = self.root / "bin"
        self.repo_state = self.root / "repo-state"
        for path in (self.home, self.binary_dir, self.repo_state):
            path.mkdir()
        environment = patch.dict(os.environ, {
            "PATH": os.defpath, "HOME": str(self.home),
            "CODEX_HOME": str(self.home / ".codex"),
            "CLAUDE_CONFIG_DIR": str(self.home / ".claude"),
            "ARIA_REPO_STATE_ROOT": str(self.repo_state),
            "ARIA_WORKSPACE_BASE": str(self.root / "workspaces"),
            "PYTHONDONTWRITEBYTECODE": "1", "PYTHONPATH": str(_KERNEL_DIR),
            "GITHUB_RUN_ID": "s4-native-admission",
            ci_executor.MOCK_MODE_ENV_VAR: "0",
        }, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        self.ai = ai
        source = _REPO_ROOT / "aria-kernel/aria_kernel/model_fleet.py"
        agent = _REPO_ROOT / ".claude/agents/aria-evidence-judge.md"
        self.repo = make_repo_with_initial_commit(self.root, {
            ".gitignore": "aria-tools/\n__pycache__/\n",
            "src/model_fleet.py": source.read_text(encoding="utf-8"),
            ".claude/agents/aria-evidence-judge.md": agent.read_text(encoding="utf-8"),
        })
        self.assertEqual((self.repo / "src/model_fleet.py").read_bytes(), source.read_bytes())
        self.assertEqual((self.repo / ".claude/agents/aria-evidence-judge.md").read_bytes(), agent.read_bytes())
        self.tools = ensure_tools_binding(self.repo / "aria-tools", workspace_root=self.repo)
        os.environ["ARIA_TOOLS_DIR"] = str(self.tools)
        self.profile = read_agent_runtime_profile("aria-evidence-judge", repo_root=self.repo)
        self.assertEqual((self.profile.profile_id, self.profile.source), ("judge_opus", "kernel_profile"))
        self.assertEqual(self.profile.tools, ("Read", "Grep", "Glob"))
        self.assertEqual(self.profile.write_scope, ())
        self.assertFalse(self.profile.external_writes)
        self.assertEqual(self.profile.budget_usd_per_run, 0.5)
        target_sha = _git(["rev-parse", "HEAD"], cwd=self.repo).stdout.strip()
        self.request = ai.create_agent_invocation_request(
            target_agent="aria-evidence-judge", role="evidence_judgment",
            suggested_prompt="Inspect the provider declaration at the supplied source line.",
            must_satisfy=[{"id": "provider-source", "criterion": "cite the provider declaration"}],
            allowed_scope=["src/**"], evidence_refs=["src/model_fleet.py:1"],
            convergence_id="s4-native-admission", cycle_id="s4-native-admission",
            target_sha=target_sha, context_repo_root=self.repo, base_dir=self.tools,
        )
        rows = ai.list_agent_invocation_requests(base_dir=self.tools)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["request_id"], self.request["request_id"])
        self.assertEqual(rows[0]["ledger_hash"], self.request["ledger_hash"])
        binding = ai.verify_invocation_context_binding(
            request_id=self.request["request_id"], context_hash=self.request["context_hash"],
            prompt_hash=self.request["prompt_hash"], base_dir=self.tools,
        )
        rendered = ai.render_invocation_prompt(ai.fuse_prompt_envelope(rows[0]))
        self.assertEqual(binding["prompt"]["prompt_text"], rendered)
        self.assertEqual(self.request["prompt_hash"], "sha256:" + hashlib.sha256(rendered.encode("utf-8")).hexdigest())
        self.assertEqual(binding["context"]["ledger_hash"], self.request["context_ledger_hash"])
        self.assertEqual(binding["prompt"]["ledger_hash"], self.request["prompt_ledger_hash"])
        self.native_bytes = {
            name: (self.tools / "agent-invocations" / name).read_bytes()
            for name in ("requests.jsonl", "contexts.jsonl", "prompts.jsonl")
        }
        self.governance_before = (self.tools / "governance.jsonl").read_bytes()
        self.assertEqual(ai.derive_request_state(request_id=self.request["request_id"], base_dir=self.tools), "PENDING")

    def _enable_adaptive_policy(self) -> None:
        # Explicit disposable operator configuration; no shipped grants or caps change.
        policy = self.repo / "aria-config/genesis_policy.json"
        policy.parent.mkdir()
        policy.write_text(json.dumps({"executor": {"adaptive_runtime": {
            "schema_version": 1, "enabled": True, "policy_id": "aria/adaptive-runtime/v1",
            "provider_cooldown_seconds": 900, "recheck_timeout_seconds": 20,
            "max_attempts_per_dispatch": 2, "scarcity_judgment_mode": "independent_sessions",
        }}}) + "\n", encoding="utf-8")

    def _run_native_entry(self) -> int:
        from contextlib import chdir

        # The caller and kernel are the reviewed source checkout; the bound
        # workspace supplies real request evidence/configuration. These cases
        # must stop before claim, kernel child dispatch, or model transport.
        with patch.dict(os.environ, {"PATH": str(self.binary_dir)}), chdir(self.repo):
            return ci_executor.main([self.request["request_id"], "aria-evidence-judge"])

    def _assert_native_request_untouched(self) -> list[dict]:
        from aria_kernel.ledger import load_declared_jsonl

        self.assertEqual(self.ai.derive_request_state(request_id=self.request["request_id"], base_dir=self.tools), "PENDING")
        for name, original in self.native_bytes.items():
            self.assertEqual((self.tools / "agent-invocations" / name).read_bytes(), original)
        for name, surface in (("claims.jsonl", "agent_invocation_claims"),
                              ("results.jsonl", "agent_invocation_results")):
            self.assertEqual(load_declared_jsonl(self.tools / "agent-invocations" / name,
                                               expected_surface=surface), [])
        self.assertFalse(Path(self.request["expected_output_path"]).exists())
        governance_path = self.tools / "governance.jsonl"
        self.assertTrue(governance_path.read_bytes().startswith(self.governance_before))
        rows = load_declared_jsonl(governance_path, expected_surface="tools_governance")
        self.assertFalse(any(row["kind"] == "runtime_attempt_started" for row in rows))
        return rows

    def test_native_runtime_reservation_requires_current_live_lease_owner(self) -> None:
        from datetime import datetime, timedelta
        from aria_kernel.budget import _reserve_native_runtime_attempt, price_tokens
        from aria_kernel.genesis_policy import _adaptive_runtime_policy
        from aria_kernel.tool_registry import GovernanceError

        self._enable_adaptive_policy()
        policy_path = self.repo / "aria-config/genesis_policy.json"
        configured = json.loads(policy_path.read_text())
        configured["executor"]["adaptive_runtime"]["monetary_admission"] = "managed_subscription"
        policy_path.write_text(json.dumps(configured) + "\n")
        policy = _adaptive_runtime_policy(self.repo)
        self.assertEqual(policy.monetary_admission, "managed_subscription")
        claim = self.ai.claim_request(request_id=self.request["request_id"],
                                      agent_id="native-reservation-owner", base_dir=self.tools)
        self.assertEqual(claim["request_ledger_hash"], self.request["ledger_hash"])
        price = price_tokens(model="gpt-6-astra", input_tokens=400000, output_tokens=64000)
        self.assertGreater(price.usd, self.profile.budget_usd_per_run)

        def reserve(agent_id: str, lease_token: str) -> dict:
            return _reserve_native_runtime_attempt(
                repo_root=self.repo, base_dir=self.tools, request_id=self.request["request_id"],
                request_ledger_hash=self.request["ledger_hash"], claim_id=claim["claim_id"],
                claim_ledger_hash=claim["claim_ledger_hash"], agent_id=agent_id, lease_token=lease_token,
                session_id="declared-offline-session", attempt_id="declared-offline-attempt",
                provider="openai", runtime="codex", model="gpt-6-astra", requested_effort="ultra",
                auth_method="chatgpt", expected_policy_digest=policy.policy_digest,
                settings_hash="declared-offline-settings", pricing={"status": "known", "estimated_usd": price.usd},
            )

        governance = self.tools / "governance.jsonl"
        before = governance.read_bytes()
        for owner, token in (("another-worker", claim["lease_token"]),
                             (claim["agent_id"], "inert-wrong-lease")):
            with self.subTest(case="agent" if owner != claim["agent_id"] else "lease"):
                with self.assertRaises(GovernanceError):
                    reserve(owner, token)
                self.assertEqual(governance.read_bytes(), before)
        expired = datetime.fromisoformat(claim["lease_expires_at"].replace("Z", "+00:00")) + timedelta(seconds=1)
        with patch.object(self.ai, "_utc_now_dt", return_value=expired):
            with self.assertRaises(GovernanceError):
                reserve(claim["agent_id"], claim["lease_token"])
        self.assertEqual(governance.read_bytes(), before)
        self.ai.release_claim(claim_id=claim["claim_id"], agent_id=claim["agent_id"],
                              lease_token=claim["lease_token"], reason="ordinary owner turnover", base_dir=self.tools)
        replacement = self.ai.claim_request(request_id=self.request["request_id"],
                                            agent_id="replacement-worker", base_dir=self.tools)
        self.assertNotEqual(replacement["claim_id"], claim["claim_id"])
        before = governance.read_bytes()
        with self.assertRaises(GovernanceError):
            reserve(claim["agent_id"], claim["lease_token"])
        self.assertEqual(governance.read_bytes(), before)
        for name, original in self.native_bytes.items():
            self.assertEqual((self.tools / "agent-invocations" / name).read_bytes(), original)

    def test_native_runtime_reservation_accepts_heartbeat_owner_without_nominal_cap(self) -> None:
        from aria_kernel.budget import _reserve_native_runtime_attempt, price_tokens
        from aria_kernel.genesis_policy import _adaptive_runtime_policy
        from aria_kernel.ledger import load_declared_jsonl

        self._enable_adaptive_policy()
        policy_path = self.repo / "aria-config/genesis_policy.json"
        configured = json.loads(policy_path.read_text())
        configured["executor"]["adaptive_runtime"]["monetary_admission"] = "managed_subscription"
        policy_path.write_text(json.dumps(configured) + "\n")
        policy = _adaptive_runtime_policy(self.repo)
        claim = self.ai.claim_request(request_id=self.request["request_id"],
                                      agent_id="native-heartbeat-owner", base_dir=self.tools)
        self.ai.heartbeat_claim(claim_id=claim["claim_id"], agent_id=claim["agent_id"],
                                lease_token=claim["lease_token"], base_dir=self.tools)
        self.assertEqual(self.ai.derive_request_state(request_id=self.request["request_id"], base_dir=self.tools), "RUNNING")
        price = price_tokens(model="gpt-6-astra", input_tokens=400000, output_tokens=64000)
        self.assertGreater(price.usd, self.profile.budget_usd_per_run)
        row = _reserve_native_runtime_attempt(
            repo_root=self.repo, base_dir=self.tools, request_id=self.request["request_id"],
            request_ledger_hash=self.request["ledger_hash"], claim_id=claim["claim_id"],
            claim_ledger_hash=claim["claim_ledger_hash"], agent_id=claim["agent_id"], lease_token=claim["lease_token"],
            session_id="declared-offline-session", attempt_id="declared-offline-attempt",
            provider="openai", runtime="codex", model="gpt-6-astra", requested_effort="ultra",
            auth_method="chatgpt", expected_policy_digest=policy.policy_digest,
            settings_hash="declared-offline-settings", pricing={"status": "known", "estimated_usd": price.usd},
        )
        self.assertEqual(row["kind"], "runtime_attempt_started")
        details = row["details"]
        self.assertEqual(details["request_ledger_hash"], self.request["ledger_hash"])
        self.assertEqual(details["claim_ledger_hash"], claim["claim_ledger_hash"])
        self.assertEqual(details["agent_id"], claim["agent_id"])
        self.assertEqual(details["policy_digest"], policy.policy_digest)
        self.assertEqual(details["monetary_admission"], "managed_subscription")
        self.assertEqual(details["pricing"]["estimated_usd"], price.usd)
        rows = load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
        self.assertEqual([item for item in rows if item["kind"] == "runtime_attempt_started"], [row])
        self.assertNotIn(claim["lease_token"], (self.tools / "governance.jsonl").read_text())
        self.assertEqual(self.ai.derive_request_state(request_id=self.request["request_id"], base_dir=self.tools), "RUNNING")
        self.assertEqual(load_declared_jsonl(self.tools / "agent-invocations/results.jsonl",
                                            expected_surface="agent_invocation_results"), [])
        for name, original in self.native_bytes.items():
            self.assertEqual((self.tools / "agent-invocations" / name).read_bytes(), original)

    def test_native_planner_hook_uses_bound_task_root_and_exact_prompt_projection(self) -> None:
        import subprocess
        from types import SimpleNamespace
        from tests._helpers.git_fixtures import _git
        from aria_kernel import planner_dispatch_hook as hook
        from aria_kernel.ledger import load_declared_jsonl

        agent_name = "aria-challenger-planner"
        agent_file = Path(".claude/agents") / (agent_name + ".md")
        (self.repo / agent_file).write_bytes((_REPO_ROOT / agent_file).read_bytes())
        _git(["add", str(agent_file)], cwd=self.repo)
        _git(["commit", "-m", "test: bind canonical challenger profile"], cwd=self.repo)
        target_sha = _git(["rev-parse", "HEAD"], cwd=self.repo).stdout.strip()
        request = self.ai.create_agent_invocation_request(
            target_agent=agent_name, role="challenger_plan",
            suggested_prompt="Challenge the supplied source claim using its actual first line.",
            must_satisfy=[{"id": "source-line", "criterion": "cite the supplied source"}],
            allowed_scope=["src/**"], evidence_refs=["src/model_fleet.py:1"],
            convergence_id="s4-hook-root", cycle_id="s4-hook-root", target_sha=target_sha,
            context_repo_root=self.repo, context_source_paths=["src/model_fleet.py"], base_dir=self.tools,
        )
        binding = self.ai.verify_invocation_context_binding(
            request_id=request["request_id"], context_hash=request["context_hash"],
            prompt_hash=request["prompt_hash"], base_dir=self.tools,
        )
        self.assertEqual(binding["prompt"]["ledger_hash"], request["prompt_ledger_hash"])
        self.assertEqual(request["context_source_paths"], ["src/model_fleet.py"])
        captured = []

        def receive_dispatch(argv, **kwargs):
            # Only the final executor transport is a declared observation
            # seam. Native request selection, claim and projection stay real.
            captured.append((argv, kwargs))
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

        with patch.object(hook, "subprocess", SimpleNamespace(
            run=receive_dispatch, TimeoutExpired=subprocess.TimeoutExpired,
        )):
            result = hook.dispatch_one_pending_planner_request(
                base_dir=self.tools, agent_id="native-hook-owner",
            )
        self.assertEqual(result["status"], "dispatched")
        self.assertEqual(result["request_id"], request["request_id"])
        self.assertEqual(len(captured), 1)
        argv, options = captured[0]
        self.assertEqual(argv, ["python3", str(_POC_DIR / "ci_executor.py"), request["request_id"], agent_name])
        claims = load_declared_jsonl(self.tools / "agent-invocations/claims.jsonl",
                                     expected_surface="agent_invocation_claims")
        self.assertEqual(len(claims), 1)
        self.assertEqual(claims[0]["request_id"], request["request_id"])
        self.assertEqual(claims[0]["claim_id"], result["claim_id"])
        self.assertEqual(options["cwd"], str(self.repo))
        self.assertEqual(options["env"]["ARIA_TOOLS_DIR"], str(self.tools))
        self.assertEqual(options["env"]["ARIA_WORKSPACE_ROOT"], str(self.repo))
        self.assertEqual(options["env"]["PYTHONPATH"].split(os.pathsep), [str(_REPO_ROOT), str(_KERNEL_DIR)])
        metadata = json.loads(options["env"][hook.CLAIM_METADATA_ENV_VAR])
        self.assertEqual(metadata["claim_ledger_hash"], claims[0]["ledger_hash"])
        self.assertEqual(metadata["request_ledger_hash"], request["ledger_hash"])
        self.assertEqual(self.ai.fuse_prompt_envelope(metadata), self.ai.fuse_prompt_envelope(request))
        rendered = self.ai.render_invocation_prompt(self.ai.fuse_prompt_envelope(metadata))
        self.assertEqual("sha256:" + hashlib.sha256(rendered.encode()).hexdigest(), request["prompt_hash"])
        self.assertNotIn("lease_token", metadata)
        self.assertNotIn("lease_token_hash", metadata)
        self.assertEqual(load_declared_jsonl(self.tools / "agent-invocations/results.jsonl",
                                            expected_surface="agent_invocation_results"), [])

    def test_inherited_adaptive_unavailability_requeues_without_request_fault(self) -> None:
        import subprocess
        import shutil
        from aria_kernel.planner_dispatch_hook import _serialise_claim_metadata_for_env, CLAIM_METADATA_FORBIDDEN_KEYS
        from aria_kernel.ledger import load_declared_jsonl

        self._enable_adaptive_policy()
        policy_path = self.repo / "aria-config/genesis_policy.json"
        configured = json.loads(policy_path.read_text())
        configured["executor"]["adaptive_runtime"]["monetary_admission"] = "managed_subscription"
        policy_path.write_text(json.dumps(configured) + "\n")
        git_binary = shutil.which("git")
        self.assertIsNotNone(git_binary)
        (self.binary_dir / "git").symlink_to(git_binary)
        claim = self.ai.claim_request(request_id=self.request["request_id"],
                                      agent_id="inherited-native-owner", base_dir=self.tools)
        metadata = _serialise_claim_metadata_for_env(
            {key: value for key, value in claim.items() if key not in CLAIM_METADATA_FORBIDDEN_KEYS},
            claim["agent_id"],
        )
        self.assertEqual(json.loads(metadata)["request_ledger_hash"], self.request["ledger_hash"])
        (self.binary_dir / "python3").symlink_to(sys.executable)
        environment = {**os.environ, "PATH": str(self.binary_dir),
                       "PYTHONPATH": os.pathsep.join((str(_REPO_ROOT), str(_KERNEL_DIR))),
                       "ARIA_WORKSPACE_ROOT": str(self.repo), "ARIA_TOOLS_DIR": str(self.tools),
                       ci_executor.CLAIM_METADATA_ENV_VAR: metadata,
                       ci_executor.LEASE_TOKEN_ENV_VAR: claim["lease_token"]}
        completed = subprocess.run(
            [sys.executable, "-B", str(_POC_DIR / "ci_executor.py"), self.request["request_id"], "aria-evidence-judge"],
            cwd=self.repo, env=environment, capture_output=True, text=True, timeout=60,
        )
        rows = load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
        entries = [row["details"] for row in rows if row["kind"] == "claude_mock_mode_resolved"]
        self.assertEqual(len(entries), 1, "The actual CI main entry must run before admission is assessed.")
        self.assertEqual(entries[0]["effective_mock"], "0")
        decisions = [row["details"] for row in rows if row["kind"] == "runtime_admission_unavailable"]
        self.assertEqual(len(decisions), 1, "Inherited claims must reach the same actual adaptive admission.")
        self.assertEqual(decisions[0]["request_ledger_hash"], self.request["ledger_hash"])
        self.assertEqual(decisions[0]["eligible_routes"], [])
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(self.ai.derive_request_state(request_id=self.request["request_id"], base_dir=self.tools), "REQUEUED")
        claims = load_declared_jsonl(self.tools / "agent-invocations/claims.jsonl",
                                     expected_surface="agent_invocation_claims")
        self.assertEqual(len([row for row in claims if row.get("event") == "claimed"]), 1)
        released = [row for row in claims if row.get("event") == "released"]
        self.assertEqual(len(released), 1)
        self.assertEqual(released[0]["claim_id"], claim["claim_id"])
        self.assertEqual(released[0]["reason"], "native_runtime_admission_unavailable")
        self.assertEqual(self.ai.classify_release_reason(released[0]["reason"]), "harness")
        self.assertEqual(self.ai._request_fault_requeue_count(claims, self.request["request_id"]), 0)
        self.assertFalse(any(row["kind"] == "runtime_attempt_started" for row in rows))
        self.assertEqual(load_declared_jsonl(self.tools / "agent-invocations/results.jsonl",
                                            expected_surface="agent_invocation_results"), [])
        for name, original in self.native_bytes.items():
            self.assertEqual((self.tools / "agent-invocations" / name).read_bytes(), original)

    def test_adaptive_native_entry_refuses_changed_task_target_before_admission(self) -> None:
        import shutil
        from tests._helpers.git_fixtures import _git
        from aria_kernel.ledger import load_declared_jsonl

        self._enable_adaptive_policy()
        policy_path = self.repo / "aria-config/genesis_policy.json"
        configured = json.loads(policy_path.read_text())
        configured["executor"]["adaptive_runtime"]["monetary_admission"] = "managed_subscription"
        policy_path.write_text(json.dumps(configured) + "\n")
        git_binary = shutil.which("git")
        self.assertIsNotNone(git_binary)
        (self.binary_dir / "git").symlink_to(git_binary)
        source = self.repo / "src/model_fleet.py"
        source.write_text(source.read_text() + "\n# ordinary new source revision\n")
        _git(["add", "src/model_fleet.py"], cwd=self.repo)
        _git(["commit", "-m", "test: move task source after sealed request"], cwd=self.repo)
        current_sha = _git(["rev-parse", "HEAD"], cwd=self.repo).stdout.strip()
        self.assertNotEqual(current_sha, self.request["target_sha"])
        exit_code = self._run_native_entry()
        rows = self._assert_native_request_untouched()
        refused = [row["details"] for row in rows if row["kind"] == "runtime_task_binding_unavailable"]
        self.assertEqual(len(refused), 1)
        self.assertEqual(refused[0]["reason"], "target_revision_mismatch")
        self.assertEqual(refused[0]["request_ledger_hash"], self.request["ledger_hash"])
        self.assertEqual(refused[0]["target_sha"], self.request["target_sha"])
        self.assertEqual(refused[0]["observed_head_sha"], current_sha)
        self.assertEqual(exit_code, 0)
        self.assertFalse(any(row["kind"] == "runtime_admission_unavailable" for row in rows))

    def test_adaptive_zero_eligible_keeps_native_request_pending(self) -> None:
        self._enable_adaptive_policy()
        exit_code = self._run_native_entry()
        rows = self._assert_native_request_untouched()
        self.assertEqual(exit_code, 0, "Ordinary zero-provider scarcity must remain resumable without a failed dispatch.")
        decisions = [row for row in rows if row["kind"] == "runtime_admission_unavailable"]
        self.assertEqual(len(decisions), 1)
        details = decisions[0]["details"]
        self.assertEqual(details["request_id"], self.request["request_id"])
        self.assertEqual(details["request_ledger_hash"], self.request["ledger_hash"])
        self.assertEqual(details["policy_id"], "aria/adaptive-runtime/v1")
        self.assertEqual(details["eligible_routes"], [])
        self.assertEqual(details["reason"], "no_eligible_provider")

    def test_native_codex_status_without_auth_file_preserves_price_admission(self) -> None:
        self._enable_adaptive_policy()
        calls = self.root / "status-command-argv.jsonl"
        executable = self.binary_dir / "codex"
        executable.write_text(
            f"#!{sys.executable}\n"
            "import json, sys\n"
            f"with open({str(calls)!r}, 'a', encoding='utf-8') as stream:\n"
            "    stream.write(json.dumps(sys.argv[1:]) + '\\n')\n"
            "if sys.argv[1:] == ['login', 'status']:\n"
            "    print('Logged in using ChatGPT', file=sys.stderr)\n"
            "    raise SystemExit(0)\n"
            "raise SystemExit(97)\n", encoding="utf-8",
        )
        executable.chmod(0o755)
        self.assertFalse((self.home / ".codex/auth.json").exists())
        self.assertNotIn("OPENAI_API_KEY", os.environ)
        exit_code = self._run_native_entry()
        rows = self._assert_native_request_untouched()
        self.assertTrue(calls.is_file(), "The real native entry must perform supported Codex status despite no file marker.")
        self.assertEqual([json.loads(line) for line in calls.read_text().splitlines()], [["login", "status"]])
        self.assertEqual(exit_code, 0)
        decisions = [row for row in rows if row["kind"] == "runtime_admission_unavailable"]
        self.assertEqual(len(decisions), 1)
        details = decisions[0]["details"]
        self.assertEqual(details["request_id"], self.request["request_id"])
        self.assertEqual(details["request_ledger_hash"], self.request["ledger_hash"])
        self.assertEqual(details["eligible_routes"], [])
        candidate = next(row for row in details["candidate_observations"] if row["provider"] == "openai")
        self.assertEqual(candidate["runtime"], "codex")
        self.assertEqual((candidate["model"], candidate["effort"]), ("gpt-6-astra", "ultra"))
        self.assertEqual(candidate["auth_observation"], "available")
        self.assertEqual(candidate["quota_observation"], "unknown")
        # gpt-6-astra carries a published rate in budget.py since the runtime
        # lane's export; the admission prices the notional 400k/64k probe with
        # it. What this case pins is that the price is ADMISSION TELEMETRY:
        # under the default metered policy the price is "available" and the
        # route is STILL ineligible, because no native control binding was
        # established for a bare status probe — not because of any dollar figure.
        self.assertEqual(candidate["pricing"]["status"], "available")
        self.assertEqual(candidate["pricing"]["basis"], "published_api_notional")
        self.assertGreater(candidate["pricing"]["estimated_usd"], 0)
        self.assertEqual(candidate["monetary_reason"], "metered")
        self.assertEqual(candidate["controls"]["status"], "unknown")
        self.assertFalse((self.home / ".codex/auth.json").exists())

    def test_omitted_adaptive_policy_preserves_legacy_native_preflight(self) -> None:
        self.assertFalse((self.repo / "aria-config/genesis_policy.json").exists())
        exit_code = self._run_native_entry()
        rows = self._assert_native_request_untouched()
        self.assertEqual(exit_code, 1)
        self.assertEqual(len([row for row in rows if row["kind"] == "claude_auth_unavailable"]), 1)
        self.assertFalse(any(row["kind"] == "runtime_admission_unavailable" for row in rows))

    def _assert_legacy_policy_reaches_native_preflight(self) -> None:
        exit_code = self._run_native_entry()
        rows = self._assert_native_request_untouched()
        self.assertEqual(exit_code, 1)
        gates = [row for row in rows if row["kind"] == "claude_auth_unavailable"]
        self.assertEqual(len(gates), 1, "A nonadaptive override must still reach the real legacy environment gate.")
        self.assertEqual(gates[0]["details"]["source"], "ci_executor_pre_claim_gate")
        self.assertFalse(any(row["kind"] == "runtime_admission_unavailable" for row in rows))

    def test_legacy_invalid_json_override_reaches_native_preflight(self) -> None:
        from aria_kernel.genesis_policy import default_policy, load_policy

        policy = self.repo / "aria-config/genesis_policy.json"
        policy.parent.mkdir()
        original = b'{"operator_note":\n'
        policy.write_bytes(original)
        self.assertEqual(load_policy(self.repo), default_policy())
        self._assert_legacy_policy_reaches_native_preflight()
        self.assertEqual(policy.read_bytes(), original)

    def test_legacy_nonobject_override_reaches_native_preflight(self) -> None:
        from aria_kernel.genesis_policy import default_policy, load_policy

        policy = self.repo / "aria-config/genesis_policy.json"
        policy.parent.mkdir()
        original = b'[]\n'
        policy.write_bytes(original)
        self.assertEqual(load_policy(self.repo), default_policy())
        self._assert_legacy_policy_reaches_native_preflight()
        self.assertEqual(policy.read_bytes(), original)

    def test_legacy_unreadable_override_reaches_native_preflight(self) -> None:
        from aria_kernel.genesis_policy import default_policy, load_policy

        policy = self.repo / "aria-config/genesis_policy.json"
        # A directory at the optional config path gives a real OS read error
        # even when tests run as root; no global I/O collaborator is patched.
        policy.mkdir(parents=True)
        self.assertTrue(policy.is_dir())
        self.assertEqual(load_policy(self.repo), default_policy())
        self._assert_legacy_policy_reaches_native_preflight()
        self.assertTrue(policy.is_dir())

    def test_legacy_large_valid_override_reaches_native_preflight(self) -> None:
        from aria_kernel.genesis_policy import load_policy

        policy = self.repo / "aria-config/genesis_policy.json"
        policy.parent.mkdir()
        original = (json.dumps({"max_requests_per_cycle": 1,
                                "operator_note": "x" * 65_536}) + "\n").encode("utf-8")
        policy.write_bytes(original)
        self.assertGreater(len(original), 65_536)
        self.assertEqual(load_policy(self.repo)["max_requests_per_cycle"], 1)
        self._assert_legacy_policy_reaches_native_preflight()
        self.assertEqual(policy.read_bytes(), original)

    def test_enabled_unsupported_policy_version_remains_strictly_refused(self) -> None:
        from contextlib import redirect_stderr
        from io import StringIO

        self._enable_adaptive_policy()
        policy = self.repo / "aria-config/genesis_policy.json"
        document = json.loads(policy.read_text(encoding="utf-8"))
        document["executor"]["adaptive_runtime"]["schema_version"] = 2
        original = (json.dumps(document) + "\n").encode("utf-8")
        policy.write_bytes(original)
        stderr = StringIO()
        with redirect_stderr(stderr):
            exit_code = self._run_native_entry()
        rows = self._assert_native_request_untouched()
        self.assertEqual(exit_code, 1)
        self.assertIn("adaptive_runtime_policy_invalid", stderr.getvalue())
        self.assertFalse(any(row["kind"] in ("claude_auth_unavailable", "runtime_admission_unavailable")
                             for row in rows))
        self.assertEqual(policy.read_bytes(), original)


    def _install_public_codex_status_fixture(self, status_text: str) -> Path:
        calls = self.root / "managed-status-child.jsonl"
        names = ("OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY",
                 "CLAUDE_API_KEY", "ARIA_ZAI_API_KEY", "ANTHROPIC_AUTH_TOKEN")
        executable = self.binary_dir / "codex"
        executable.write_text(
            f"#!{sys.executable}\n"
            "import json, os, sys\n"
            f"forbidden_names = {names!r}\n"
            "observation = {'argv': sys.argv[1:], 'provider_key_names': "
            "sorted(name for name in forbidden_names if name in os.environ)}\n"
            f"with open({str(calls)!r}, 'a', encoding='utf-8') as stream:\n"
            "    stream.write(json.dumps(observation) + '\\n')\n"
            "if sys.argv[1:] != ['login', 'status']:\n"
            "    raise SystemExit(97)\n"
            f"print({status_text!r}, file=sys.stderr)\n"
            "raise SystemExit(0)\n", encoding="utf-8",
        )
        executable.chmod(0o755)
        return calls

    def test_native_managed_status_child_excludes_provider_api_key_environment(self) -> None:
        self._enable_adaptive_policy()
        calls = self._install_public_codex_status_fixture("Logged in using ChatGPT")
        names = ("OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY",
                 "CLAUDE_API_KEY", "ARIA_ZAI_API_KEY", "ANTHROPIC_AUTH_TOKEN")
        # These are inert public fixture strings, not credentials. No provider
        # binary or model is invoked; the child records variable names only.
        with patch.dict(os.environ, {name: "ordinary-fixture-placeholder" for name in names}):
            exit_code = self._run_native_entry()
        rows = self._assert_native_request_untouched()
        self.assertEqual(exit_code, 0)
        observations = [json.loads(line) for line in calls.read_text().splitlines()]
        self.assertEqual(observations, [{"argv": ["login", "status"], "provider_key_names": []}])
        decisions = [row for row in rows if row["kind"] == "runtime_admission_unavailable"]
        self.assertEqual(len(decisions), 1)
        details = decisions[0]["details"]
        self.assertEqual(details["request_ledger_hash"], self.request["ledger_hash"])
        candidate = next(row for row in details["candidate_observations"] if row["provider"] == "openai")
        self.assertEqual(candidate["auth_method"], "chatgpt")
        self.assertEqual(candidate["auth_observation"], "available")
        self.assertEqual(candidate["quota_observation"], "unknown")
        self.assertEqual(details["eligible_routes"], [])

    def test_native_codex_api_key_status_is_not_managed_eligibility(self) -> None:
        self._enable_adaptive_policy()
        calls = self._install_public_codex_status_fixture("Logged in using an API key - ***")
        exit_code = self._run_native_entry()
        rows = self._assert_native_request_untouched()
        self.assertEqual(exit_code, 0)
        self.assertEqual([json.loads(line) for line in calls.read_text().splitlines()],
                         [{"argv": ["login", "status"], "provider_key_names": []}])
        decisions = [row for row in rows if row["kind"] == "runtime_admission_unavailable"]
        self.assertEqual(len(decisions), 1)
        details = decisions[0]["details"]
        self.assertEqual(details["request_ledger_hash"], self.request["ledger_hash"])
        candidate = next(row for row in details["candidate_observations"] if row["provider"] == "openai")
        self.assertEqual(candidate["auth_observation"], "unavailable")
        self.assertEqual(candidate["auth_method"], "api_key")
        self.assertEqual(candidate["status_reason"], "managed_login_required")
        self.assertEqual(candidate["quota_observation"], "unknown")
        self.assertEqual(details["eligible_routes"], [])


    def test_native_unrecognized_codex_status_remains_unknown_and_pending(self) -> None:
        self._enable_adaptive_policy()
        calls = self._install_public_codex_status_fixture("Ordinary status format not yet supported")
        exit_code = self._run_native_entry()
        rows = self._assert_native_request_untouched()
        self.assertEqual(exit_code, 0)
        self.assertEqual([json.loads(line) for line in calls.read_text().splitlines()],
                         [{"argv": ["login", "status"], "provider_key_names": []}])
        decisions = [row for row in rows if row["kind"] == "runtime_admission_unavailable"]
        self.assertEqual(len(decisions), 1)
        details = decisions[0]["details"]
        self.assertEqual(details["request_ledger_hash"], self.request["ledger_hash"])
        candidate = next(row for row in details["candidate_observations"] if row["provider"] == "openai")
        self.assertEqual((candidate["auth_observation"], candidate["auth_method"],
                          candidate["quota_observation"], candidate["status_reason"]),
                         ("unknown", "unknown", "unknown", "status_output_unrecognized"))
        self.assertEqual(details["eligible_routes"], [])

    def test_native_codex_status_read_limit_reaps_its_child(self) -> None:
        import codex_runtime
        import subprocess
        from types import SimpleNamespace

        self._enable_adaptive_policy()
        calls = self._install_public_codex_status_fixture("Ordinary status detail. " * 256)
        original_popen = subprocess.Popen
        original_read = os.read
        status_processes = []
        status_fds = set()
        reads = []

        def observe_popen(argv, *args, **kwargs):
            process = original_popen(argv, *args, **kwargs)
            if list(argv) == ["codex", "login", "status"]:
                self.assertIsNotNone(process.stdout)
                status_processes.append(process)
                status_fds.add(process.stdout.fileno())
            return process

        def observe_read(fd, count):
            result = original_read(fd, count)
            if fd in status_fds:
                reads.append((count, len(result)))
            return result

        # Only this module's os namespace changes. Popen's internal errpipe
        # and other consumers continue to use the unmodified real os.read.
        observed_os = SimpleNamespace(**{**vars(os), "read": observe_read})
        with patch.object(codex_runtime, "os", observed_os), \
                patch.object(codex_runtime.subprocess, "Popen", side_effect=observe_popen):
            exit_code = self._run_native_entry()
        rows = self._assert_native_request_untouched()
        self.assertEqual(exit_code, 0)
        self.assertEqual([json.loads(line) for line in calls.read_text().splitlines()],
                         [{"argv": ["login", "status"], "provider_key_names": []}])
        self.assertEqual(len(status_processes), 1)
        self.assertIsNotNone(status_processes[0].returncode)
        self.assertTrue(status_processes[0].stdout.closed)
        self.assertEqual(sum(received for _, received in reads), 4096)
        consumed = 0
        for requested, received in reads:
            self.assertLessEqual(requested, 4096 - consumed)
            consumed += received
        decisions = [row for row in rows if row["kind"] == "runtime_admission_unavailable"]
        self.assertEqual(len(decisions), 1)
        details = decisions[0]["details"]
        self.assertEqual(details["request_ledger_hash"], self.request["ledger_hash"])
        candidate = next(row for row in details["candidate_observations"] if row["provider"] == "openai")
        self.assertEqual((candidate["auth_observation"], candidate["auth_method"],
                          candidate["quota_observation"], candidate["status_reason"]),
                         ("unknown", "unknown", "unknown", "status_output_limit"))
        self.assertEqual(details["eligible_routes"], [])

    def test_codex_status_deadline_reaps_the_real_started_child(self) -> None:
        import codex_runtime
        import subprocess

        started = self.root / "ordinary-status-started.txt"
        executable = self.binary_dir / "codex"
        executable.write_text(
            f"#!{sys.executable}\n"
            "import os, sys, time\n"
            "if sys.argv[1:] != ['login', 'status']: raise SystemExit(97)\n"
            f"with open({str(started)!r}, 'w', encoding='utf-8') as stream:\n"
            "    stream.write(str(os.getpid()))\n"
            "time.sleep(10)\n", encoding="utf-8",
        )
        executable.chmod(0o755)
        processes = []
        original_popen = subprocess.Popen

        def observe_popen(argv, *args, **kwargs):
            process = original_popen(argv, *args, **kwargs)
            processes.append(process)
            return process

        environment = dict(os.environ)
        environment["PATH"] = str(self.binary_dir)
        # Exercise the existing status observer's per-call deadline only;
        # do not change any shipped or fixture genesis-policy allowance.
        with patch.object(codex_runtime.subprocess, "Popen", side_effect=observe_popen):
            status = codex_runtime._probe_codex_auth_status(
                environ=environment, timeout_seconds=2.0,
            )
        self.assertEqual(len(processes), 1)
        self.assertTrue(started.is_file(), "The ordinary child must actually start before this is deadline evidence.")
        self.assertEqual(started.read_text(), str(processes[0].pid))
        self.assertIsNotNone(processes[0].returncode)
        self.assertTrue(processes[0].stdout.closed)
        self.assertEqual((status.auth_observation, status.auth_method, status.quota_observation,
                          status.reason, status.command),
                         ("unknown", "unknown", "unknown", "status_timeout", ("codex", "login", "status")))
        rows = self._assert_native_request_untouched()
        self.assertFalse(any(row["kind"] == "runtime_admission_unavailable" for row in rows))

    def test_managed_subscription_native_codex_verification_records_bound_result(self) -> None:
        from contextlib import chdir
        from tests._helpers.git_fixtures import _git
        from aria_kernel.agent_runtime_profile import read_agent_runtime_profile
        from aria_kernel.ledger import load_declared_jsonl
        from aria_kernel.budget import read_cost_attribution
        import subprocess

        # Canonical non-judge verification needs no invented finding identity.
        # The original admission-only judge request remains untouched/pending.
        agent_name = "aria-adversarial-judge"
        agent_file = Path(".claude/agents") / (agent_name + ".md")
        (self.repo / agent_file).write_bytes((_REPO_ROOT / agent_file).read_bytes())
        shared_sources = (
            "tools/__init__.py", "tools/shared/__init__.py", "tools/shared/excluded_paths.py",
        )
        for relative in shared_sources:
            destination = self.repo / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes((_REPO_ROOT / relative).read_bytes())
            self.assertEqual(destination.read_bytes(), (_REPO_ROOT / relative).read_bytes())
        _git(["add", str(agent_file), *shared_sources], cwd=self.repo)
        _git(["commit", "-m", "test: add canonical verification profile"], cwd=self.repo)
        target_sha = _git(["rev-parse", "HEAD"], cwd=self.repo).stdout.strip()
        profile = read_agent_runtime_profile(agent_name, repo_root=self.repo)
        self.assertEqual(profile.tools, ("Read", "Grep", "Glob"))
        self.assertEqual(profile.write_scope, ())
        self.assertFalse(profile.external_writes)
        self.assertEqual(profile.budget_usd_per_run, 0.5)
        request = self.ai.create_agent_invocation_request(
            target_agent=agent_name, role="verification",
            suggested_prompt="Verify the supplied first source line and cite it. No file changes are required.",
            must_satisfy=[{"id": "source-line", "criterion": "verify the supplied first source line"}],
            allowed_scope=["src/**"], evidence_refs=["src/model_fleet.py:1"],
            convergence_id="s4-native-verification", cycle_id="s4-native-verification",
            target_sha=target_sha, context_repo_root=self.repo, base_dir=self.tools,
        )
        native_before = {
            name: (self.tools / "agent-invocations" / name).read_bytes()
            for name in ("requests.jsonl", "contexts.jsonl", "prompts.jsonl")
        }
        binding = self.ai.verify_invocation_context_binding(
            request_id=request["request_id"], context_hash=request["context_hash"],
            prompt_hash=request["prompt_hash"], base_dir=self.tools,
        )
        self.assertEqual(binding["context"]["ledger_hash"], request["context_ledger_hash"])
        self.assertEqual(binding["prompt"]["ledger_hash"], request["prompt_ledger_hash"])
        self._enable_adaptive_policy()
        policy_path = self.repo / "aria-config/genesis_policy.json"
        policy = json.loads(policy_path.read_text(encoding="utf-8"))
        policy["executor"]["adaptive_runtime"]["monetary_admission"] = "managed_subscription"
        policy_path.write_text(json.dumps(policy) + "\n", encoding="utf-8")
        policy_bytes = policy_path.read_bytes()

        # Real kernel CLI children import the same source; no claim/result
        # method or kernel subprocess is replaced. The provider is the only
        # declared substitute, and never reads real account material.
        kernel_directory = self.repo / "aria-kernel"
        kernel_directory.mkdir()
        # A COPY, not a symlink: the write-containment sandbox ro-binds
        # aria-kernel/aria_kernel under the workspace, and bwrap cannot bind
        # onto a symlink whose target lies outside the sandbox — the wrapped
        # status child died with "Can't bind mount ... No such file or
        # directory" and the observation read status_not_confirmed. That was
        # the whole of the "context-specific discrepancy" the Codex runtime
        # lane left pending; the production owners were right.
        import shutil as _shutil
        _shutil.copytree(_KERNEL_DIR / "aria_kernel", kernel_directory / "aria_kernel",
                         ignore=_shutil.ignore_patterns("__pycache__"))
        (self.binary_dir / "python3").symlink_to(sys.executable)
        managed_home = self.home / ".codex"
        managed_home.mkdir()
        session_marker = managed_home / "ordinary-session-sentinel.txt"
        session_marker.write_bytes(b"public fixture session state\n")
        original_session_bytes = session_marker.read_bytes()
        (managed_home / "auth.json").write_text('{"fixture":"native-managed-session"}\n', encoding="utf-8")
        executable = self.binary_dir / "codex"
        executable.write_text(
            f"#!{sys.executable}\n"
            "import hashlib,json,os,sqlite3,sys,tomllib\n"
            "from pathlib import Path\n"
            "if sys.argv[-2:] == ['login','status']:\n"
            " status_options={}\n"
            " for i,arg in enumerate(sys.argv[:-1]):\n"
            "  if arg=='-c': status_options.update(tomllib.loads(sys.argv[i+1]))\n"
            " assert status_options['cli_auth_credentials_store']=='file', status_options\n"
            " assert status_options['forced_login_method']=='chatgpt', status_options\n"
            " print('Logged in using ChatGPT',file=sys.stderr); raise SystemExit(0)\n"
            "assert sys.argv[1]=='exec', sys.argv[1:]\n"
            "options={}\n"
            "for i,arg in enumerate(sys.argv[:-1]):\n"
            " if arg=='-c': options.update(tomllib.loads(sys.argv[i+1]))\n"
            "state=Path(options['sqlite_home']); state.mkdir(parents=True,exist_ok=True)\n"
            "db=state/'ordinary-child.sqlite'; connection=sqlite3.connect(db)\n"
            "connection.execute('create table observation (value text)')\n"
            "connection.execute('insert into observation values (?)',('child-owned',))\n"
            "connection.commit(); connection.close()\n"
            "source=Path.cwd()/'src/model_fleet.py'\n"
            "diagnostic={'pid':os.getpid(),'cwd':str(Path.cwd()),'codex_home':os.environ.get('CODEX_HOME'),\n"
            " 'sqlite_home':str(state),'sqlite_sha256':hashlib.sha256(db.read_bytes()).hexdigest(),\n"
            " 'argv':sys.argv[1:-1],'prompt_head':sys.argv[-1][:48],'provider_key_names':[key for key in os.environ if key in\n"
            " ('OPENAI_API_KEY','CODEX_API_KEY','ANTHROPIC_API_KEY','ARIA_ZAI_API_KEY')],\n"
            " 'source_sha256':hashlib.sha256(source.read_bytes()).hexdigest()}\n"
            "response={'satisfaction_matrix':[{'id':'source-line','verdict':'satisfied',\n"
            " 'evidence_refs':['src/model_fleet.py:1'],'evidence':source.read_text().splitlines()[0]}],\n"
            " 'evidence_refs':['src/model_fleet.py:1'],'details':{'ordinary_child_observation':diagnostic}}\n"
            "message=json.dumps(response)\n"
            "Path(sys.argv[sys.argv.index('--output-last-message')+1]).write_text(message)\n"
            "print(json.dumps({'type':'thread.started','thread_id':'simulated-native-codex-thread'}))\n"
            "print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':message}}))\n"
            "print(json.dumps({'type':'turn.completed','usage':{'input_tokens':160,'cached_input_tokens':0,'output_tokens':80}}))\n",
            encoding="utf-8",
        )
        executable.chmod(0o755)
        environment = {**os.environ, "PATH": str(self.binary_dir) + os.pathsep + os.defpath,
                       "ARIA_WORKSPACE_ROOT": str(self.repo), "MAX_TIMEOUT_SECONDS": "30"}
        # Actual native entry, actual child, actual kernel claim and submit.
        completed = subprocess.run(
            [sys.executable, "-B", str(_POC_DIR / "ci_executor.py"), request["request_id"], agent_name],
            cwd=self.repo, env=environment, capture_output=True, text=True, timeout=90,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(
            self.ai.derive_request_state(request_id=request["request_id"], base_dir=self.tools), "ACCEPTED",
            json.dumps({"stdout": completed.stdout, "stderr": completed.stderr,
                        "runtime_rows": [row for row in load_declared_jsonl(
                            self.tools / "governance.jsonl", expected_surface="tools_governance")
                            if row["kind"].startswith("runtime_")]}, sort_keys=True),
        )
        output = json.loads(Path(request["expected_output_path"]).read_text(encoding="utf-8"))
        self.assertEqual(output["request_id"], request["request_id"])
        self.assertEqual(output["role"], "verification")
        self.assertEqual(output["details"]["agent_dispatch_model"], "gpt-6-astra")
        diagnostic = output["details"]["ordinary_child_observation"]
        self.assertNotEqual(diagnostic["pid"], os.getpid())
        self.assertEqual(diagnostic["cwd"], str(self.repo))
        self.assertNotEqual(diagnostic["codex_home"], str(managed_home))
        self.assertEqual(Path(diagnostic["codex_home"]).parent, Path(diagnostic["sqlite_home"]).parent)
        self.assertNotEqual(Path(diagnostic["sqlite_home"]), managed_home)
        self.assertFalse(Path(diagnostic["sqlite_home"]).is_relative_to(managed_home))
        self.assertEqual(len(diagnostic["sqlite_sha256"]), 64)
        self.assertEqual(diagnostic["source_sha256"], hashlib.sha256((self.repo / "src/model_fleet.py").read_bytes()).hexdigest())
        self.assertEqual(diagnostic["provider_key_names"], [])
        self.assertIn('--ephemeral', diagnostic["argv"])
        self.assertIn('model_reasoning_effort="ultra"', diagnostic["argv"])
        # ARIA-HIGH-073 — the prompt the model receives opens with its own
        # contract; the request that follows is still the prompt_hash-bound one.
        self.assertTrue(diagnostic["prompt_head"].startswith("# Agent contract: aria-adversarial-judge\n"), diagnostic["prompt_head"])
        self.assertTrue(output["details"]["agent_contract_hash"].startswith("sha256:"))
        self.assertEqual(session_marker.read_bytes(), original_session_bytes)
        self.assertEqual(sorted(p.name for p in managed_home.iterdir()), ["auth.json", session_marker.name])
        self.assertEqual(policy_path.read_bytes(), policy_bytes)
        for name, original in native_before.items():
            self.assertEqual((self.tools / "agent-invocations" / name).read_bytes(), original)
        claims = [row for row in load_declared_jsonl(self.tools / "agent-invocations/claims.jsonl", expected_surface="agent_invocation_claims")
                  if row.get("request_id") == request["request_id"] and row.get("event") == "claimed"]
        results = [row for row in load_declared_jsonl(self.tools / "agent-invocations/results.jsonl", expected_surface="agent_invocation_results")
                   if row.get("request_id") == request["request_id"]]
        self.assertEqual(len(claims), 1)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["claim_id"], claims[0]["claim_id"])
        self.assertEqual(output["claim_id"], claims[0]["claim_id"])
        attempts = [row["details"] for row in load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
                    if row.get("kind") == "runtime_attempt_started" and row["details"].get("request_id") == request["request_id"]]
        self.assertEqual(len(attempts), 1)
        self.assertEqual(attempts[0]["claim_id"], claims[0]["claim_id"])
        self.assertEqual(attempts[0]["request_ledger_hash"], request["ledger_hash"])
        self.assertEqual(attempts[0]["monetary_admission"], "managed_subscription")
        self.assertGreater(attempts[0]["pricing"]["estimated_usd"], profile.budget_usd_per_run)
        self.assertEqual(attempts[0]["pricing"]["basis"], "published_api_notional")
        self.assertEqual(attempts[0]["requested_effort"], "ultra")
        self.assertIsNone(attempts[0]["observed_effort"])
        usage = [row for row in read_cost_attribution(base_dir=self.tools) if row.get("cycle_id") == request["cycle_id"]]
        self.assertEqual(len(usage), 1)
        self.assertEqual((usage[0]["model"], usage[0]["input_tokens"], usage[0]["output_tokens"]), ("gpt-6-astra", 160, 80))
        self.assertGreater(usage[0]["estimated_usd"], 0)
        # Join the accepted native result to its immutable sealed output,
        # original attempt and reconciliation; mutable submission is not authority.
        accepted = self.ai.accepted_result_for_request(
            request_id=request["request_id"], role="verification", base_dir=self.tools,
        )
        self.assertEqual(accepted, results[0])
        sealed_path = self.ai.resolve_output_artifact_path(self.tools, accepted["output_path"])
        mutable_path = Path(request["expected_output_path"])
        self.assertNotEqual(sealed_path.resolve(), mutable_path.resolve())
        sealed_bytes = sealed_path.read_bytes()
        self.assertEqual("sha256:" + hashlib.sha256(sealed_bytes).hexdigest(), accepted["output_hash"])
        self.assertEqual(accepted["output_hash"], accepted["content_hash"])
        sealed = json.loads(sealed_bytes)
        governance = load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
        attempt_rows = [row for row in governance if row["kind"] == "runtime_attempt_started"
                        and row["details"].get("request_id") == request["request_id"]]
        self.assertEqual(len(attempt_rows), 1)
        attempt = attempt_rows[0]
        self.assertEqual(sealed["details"]["runtime_attempt_ledger_hash"], attempt["ledger_hash"])
        reconciled = [row["details"] for row in governance if row["kind"] == "runtime_attempt_reconciled"
                      and row["details"].get("request_id") == request["request_id"]]
        self.assertEqual(len(reconciled), 1)
        self.assertEqual(reconciled[0]["result_ledger_hash"], accepted["ledger_hash"])
        self.assertEqual(reconciled[0]["attempt_ledger_hash"], attempt["ledger_hash"])
        self.assertEqual(reconciled[0]["claim_ledger_hash"], claims[0]["ledger_hash"])
        self.assertEqual(reconciled[0]["request_ledger_hash"], request["ledger_hash"])
        self.assertEqual(reconciled[0]["agent_id"], accepted["agent_id"])
        results_path = self.tools / "agent-invocations/results.jsonl"
        result_bytes = results_path.read_bytes()
        governance_bytes = (self.tools / "governance.jsonl").read_bytes()
        mutable_path.write_text('{"details":{"runtime_attempt_ledger_hash":"inert-replaced-output"}}\n')
        arguments = dict(tools_dir=self.tools, request_id=request["request_id"],
                         claim_id=accepted["claim_id"], agent_id=accepted["agent_id"],
                         session_id=attempt["details"]["session_id"], policy_digest=attempt["details"]["policy_digest"])
        resolved_result, resolved_attempt = ci_executor._accepted_native_runtime_result(**arguments)
        self.assertEqual(resolved_result, accepted)
        self.assertEqual(resolved_attempt, attempt)
        self.assertEqual(sealed_path.read_bytes(), sealed_bytes)
        self.assertEqual(results_path.read_bytes(), result_bytes)
        self.assertEqual((self.tools / "governance.jsonl").read_bytes(), governance_bytes)


if __name__ == "__main__":
    unittest.main()
