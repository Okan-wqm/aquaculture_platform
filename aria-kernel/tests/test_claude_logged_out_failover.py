"""ARIA-HIGH-441 — a Claude login that is gone holds only the work Claude must do.

Operator decision 2026-10-10/11: while Claude is out, every area moves to Z.ai.
"Out" is a spent quota (ARIA-HIGH-425) or a login that is gone — since
ARIA-MEDIUM-563, the kernel's own Claude token (the gateway's credential) that
is absent. The native lane already asked its route: the admission reads the
kernel's credential boundary and the seam cools anthropic (`claude_logged_out`). Three places asked Claude for
every request whatever its route:

* the executor workflow exited the job on a missing managed-auth file (pinned in
  `invariants/v3/test_phase_b1_argv_proven_workflow_hygiene.py`);
* the spawn lane's pre-claim gate refused every request on Claude's preflight;
* the worker child met the preflight's refusal in an arm that cooled nothing, so
  the hook released `worker_executor_failed` and the scheduler — which does not
  back off on that status — re-claimed and re-spawned it at once, without end.

What this pins, with the real preflight (a claude CLI on PATH, no kernel token),
the real routing table, the real cooldown and outage ledgers and the real hook:

* the preflight's refusal is `ProviderCredentialAbsent` for anthropic
  (`claude_logged_out`), still a `ClaudeAuthUnavailable`;
* the spawn-lane gate asks Claude only for a request whose first rung is
  anthropic; a logged-out Claude is cooled and the request goes on when a rung
  past it remains, and is refused only when none does;
* across N worker ticks with the login gone: one claim and one spawn per
  back-off window, every tick `provider_cooldown` (the scheduler backs off), the
  release harness-class (`provider_quota_unavailable:anthropic`), the retry
  budget untouched and `max_retries_exceeded` never reached; with the Z.ai key on
  the host the next tick runs the worker on glm-5.3.
"""
from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
for _path in (str(_POC_DIR), str(_REPO_ROOT / "aria-kernel")):
    if _path not in sys.path:
        sys.path.insert(0, _path)

import claude_runtime  # noqa: E402
from aria_kernel.ledger import append_jsonl, load_declared_jsonl  # noqa: E402
from aria_kernel.provider_cooldown import PROVIDER_COOLDOWN_GOVERNANCE_KIND, active_provider_cooldowns  # noqa: E402
from aria_kernel.provider_outage_ledger import open_outages  # noqa: E402
from aria_kernel.tool_registry import ensure_tools_dir  # noqa: E402

# The hook's `subprocess.run` is the process-wide one: every other call made
# while a tick runs (the preflight's `claude --version`) goes to the real one.
_REAL_RUN = subprocess.run


class _LoggedOutHost(unittest.TestCase):
    """A claude CLI on PATH and no kernel token (ARIA_CLAUDE_OAUTH_TOKEN_FILE unset)."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-441-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        binaries = self.tmp / "bin"
        binaries.mkdir()
        (binaries / "claude").write_text("#!/bin/sh\necho '2.1.278 (Claude Code)'\n", encoding="utf-8")
        (binaries / "claude").chmod(0o755)
        (self.tmp / "home").mkdir()
        (self.tmp / "claude-config").mkdir()
        environment = {"PATH": os.pathsep.join([str(binaries), os.environ.get("PATH", "")]),
                       "HOME": str(self.tmp / "home"), "CLAUDE_CONFIG_DIR": str(self.tmp / "claude-config")}
        patcher = patch.dict(os.environ, environment)
        patcher.start()
        self.addCleanup(patcher.stop)
        for name in ("ARIA_CLAUDE_AUTH_PREFLIGHT_SKIP", "ARIA_CLAUDE_OAUTH_TOKEN_FILE", "ARIA_ZAI_API_KEY_FILE", "ARIA_ZAI_API_KEY",
                     "ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"):
            os.environ.pop(name, None)

    def _cooldowns(self, tools: Path) -> list[dict[str, Any]]:
        return [row["details"] for row in load_declared_jsonl(tools / "governance.jsonl",
                                                               expected_surface="tools_governance")
                if row["kind"] == PROVIDER_COOLDOWN_GOVERNANCE_KIND]


class ThePreflightNamesAProviderFact(_LoggedOutHost):
    def test_a_missing_login_is_anthropics_logged_out_credential(self) -> None:
        with self.assertRaises(claude_runtime.ProviderCredentialAbsent) as refused:
            claude_runtime.preflight_claude_auth()
        self.assertIsInstance(refused.exception, claude_runtime.ClaudeAuthUnavailable)
        self.assertEqual((refused.exception.provider, refused.exception.detail["signature"]),
                         ("anthropic", "claude_logged_out"))


class TheSpawnLaneGateAsksTheRoute(_LoggedOutHost):
    def setUp(self) -> None:
        super().setUp()
        from aria_kernel.agent_invocations import create_agent_invocation_request
        from aria_kernel.request_admission import admit_request

        self.tools = ensure_tools_dir(self.tmp / "aria-tools")
        self.ids = {
            role: create_agent_invocation_request(
                target_agent=target, role=role, suggested_prompt="{}",
                must_satisfy=[{"id": "MS-1", "description": "answer"}], allowed_scope=["aria-kernel/aria_kernel/"],
                evidence_refs=["docs/aria/SPEC.md"], base_dir=self.tools,
                admission=admit_request("operator_cli.request", role, base_dir=self.tools),
            )["request_id"]
            for role, target in (("evidence_judgment", "aria-evidence-judge"),
                                 ("adversarial_judgment", "aria-adversarial-judge"))
        }

    def _refusal(self, role: str, target: str) -> str | None:
        import ci_executor

        return ci_executor._claude_preflight_refusal(tools_dir=self.tools, request_id=self.ids[role],
                                                     target_agent=target)

    def _zai_key(self) -> None:
        os.environ["ARIA_ZAI_API_KEY_FILE"] = str(self.tmp / "zai.key")

    def test_a_claude_headed_request_cools_anthropic_and_goes_on_past_it(self) -> None:
        self._zai_key()
        import ci_executor
        from aria_kernel.runtime_profiles import routed_models

        self.assertIsNone(self._refusal("evidence_judgment", "aria-evidence-judge"))
        rows = self._cooldowns(self.tools)
        self.assertEqual([(row["provider"], row["detection"]["signature"], row["detection"]["seam"], row["claim_id"])
                          for row in rows],
                         [("anthropic", "claude_logged_out", "spawn_preflight",
                           f"preflight:{self.ids['evidence_judgment']}")])
        self.assertEqual([(i.provider, i.kind) for i in open_outages(self.tools)], [("anthropic", "logged_out")])
        self.assertEqual(routed_models("evidence_judgment", "aria-evidence-judge", profile_model="opus",
                                       write_capable=False, environ=os.environ, runtimes=ci_executor._SPAWN_LANE_RUNTIMES,
                                       cooled=active_provider_cooldowns(self.tools))[0], "glm-5.3",
                         "the spawn tries the zai rung first")

    def test_a_zai_headed_request_never_asks_claude(self) -> None:
        import ci_executor

        self._zai_key()
        with patch.object(ci_executor, "preflight_claude_auth", side_effect=AssertionError("asked Claude")):
            self.assertIsNone(self._refusal("adversarial_judgment", "aria-adversarial-judge"))
        self.assertEqual(self._cooldowns(self.tools), [])

    def test_a_request_only_claude_can_run_is_refused_by_name_and_cools_nothing(self) -> None:
        import copy

        from aria_kernel import runtime_profiles

        document = copy.deepcopy(json.loads(runtime_profiles.profiles_path().read_text(encoding="utf-8")))
        document["provider_routing"]["suspended_providers"] = ["zai", "openai"]
        table = self.tmp / "runtime_profiles.json"
        table.write_text(json.dumps(document), encoding="utf-8")
        with patch.object(runtime_profiles, "profiles_path", return_value=table):
            refusal = self._refusal("evidence_judgment", "aria-evidence-judge")
        self.assertTrue(str(refusal).startswith("claude_gateway_credential_absent"), refusal)
        self.assertEqual([row["provider"] for row in self._cooldowns(self.tools)], ["anthropic"],
                         "refused, and the operator is told: Anthropic's outage is open")

    def test_no_login_and_no_zai_key_is_refused_before_the_claim_loudly(self) -> None:
        """Main's question for ARIA-HIGH-441: with the job's step only warning,
        a night with no usable provider must not run quietly. The gate refuses
        before the claim with its `::error::` and its governance row, and
        Anthropic's logged-out outage opens its HUMAN_REQUIRED item."""
        import contextlib

        import ci_executor
        from aria_kernel.agent_invocations import derive_request_state
        from aria_kernel.human_required import list_human_required

        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            kind = ci_executor._pre_claim_environment_gate(
                tools_dir=self.tools, request_id=self.ids["evidence_judgment"], target_agent="aria-evidence-judge")
        self.assertEqual(kind, "claude_auth_unavailable")
        self.assertIn("::error::pre_claim_environment_gate: claude_auth_unavailable", stderr.getvalue())
        self.assertEqual(derive_request_state(request_id=self.ids["evidence_judgment"], base_dir=self.tools), "PENDING")
        self.assertEqual([(i.provider, i.kind) for i in open_outages(self.tools)], [("anthropic", "logged_out")])
        items = [item for item in list_human_required(base_dir=self.tools).rows
                 if (item.get("context") or {}).get("kind") == "provider_outage"]
        self.assertEqual([(item["context"]["provider"], item["context"]["outage_kind"]) for item in items],
                         [("anthropic", "logged_out")])


class TheWorkerLaneBacksOffALoggedOutClaude(_LoggedOutHost):
    """N hook ticks with the real worker child run in-process."""

    def setUp(self) -> None:
        super().setUp()
        self.tools = ensure_tools_dir(self.tmp / "aria-tools")
        self.worktree = self.tmp / "worktrees" / "A-W-1"
        self.worktree.mkdir(parents=True)
        path = self.tools / "dispatch" / "requests.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        append_jsonl(path, {
            "$schema": "aria/dispatch-request/v1", "schema_version": 1,
            "assignment_id": "A-W-1", "pressure_event_id": "P-A-W-1",
            "target_agent": "aria-worker", "triage_tier": "auto_fix_safe",
            "worktree_path": str(self.worktree), "base_sha": "deadbeef",
            "required_tests": [], "expected_trailer": "Closes-Pressure: P-A-W-1",
            "state": "pending", "created_at": "2026-05-10T00:00:00Z",
        }, test_fixture=True)
        self.spawned: list[list[str]] = []
        self.loops: list[dict[str, Any]] = []

    def _child(self, argv: list[str], *args: Any, **kwargs: Any) -> subprocess.CompletedProcess:
        """The hook's child, run in-process: the real worker_executor.main."""
        import worker_executor

        if len(argv) < 2 or Path(str(argv[1])).name != "worker_executor.py":
            return _REAL_RUN(argv, *args, **kwargs)
        import zai_tool_loop
        from aria_kernel.agent_runtime_profile import read_agent_runtime_profile

        self.spawned.append(list(argv))
        assignment = {"assignment_id": "A-W-1", "target_agent": "aria-worker", "worktree_path": str(self.worktree),
                      "required_tests": [], "expected_trailer": "Closes-Pressure: P-A-W-1", "timeout_seconds": 60}
        worker = read_agent_runtime_profile("aria-worker", repo_root=_REPO_ROOT)

        def loop(**kwargs: Any) -> claude_runtime.ClaudeRunResult:
            self.loops.append(kwargs)
            return claude_runtime.ClaudeRunResult(returncode=0, stdout="", stderr="", final_message="done",
                                                   usage={}, events=(), model=kwargs["model"])

        cwd = os.getcwd()
        os.chdir(self.tmp)  # the child's repo is its cwd; its store is <cwd>/aria-tools
        try:
            with patch.object(worker_executor, "_resolve_assignment", return_value=assignment), \
                    patch("aria_kernel.agent_runtime_profile.read_agent_runtime_profile", lambda *a, **k: worker), \
                    patch.object(zai_tool_loop, "run_zai_writer", loop), \
                    patch.object(worker_executor, "_submit_worker_result", return_value=0), \
                    patch.object(sys, "stderr", io.StringIO()):
                code = worker_executor.main(argv[2:])
        finally:
            os.chdir(cwd)
        return subprocess.CompletedProcess(argv, code, "", "")

    def _tick(self) -> dict[str, Any]:
        from aria_kernel.worker_dispatch_hook import dispatch_one_pending_worker_assignment

        with patch("aria_kernel.worker_dispatch_hook.subprocess.run", self._child), \
                patch("aria_kernel.verification_gate.verify_worker_result",
                      return_value={"status": "passed"}):
            return dispatch_one_pending_worker_assignment(base_dir=self.tools, agent_id="daemon:441",
                                                          github_adapter=MagicMock())

    def test_n_logged_out_ticks_back_off_and_never_spend_the_budget(self) -> None:
        from aria_kernel.worker_dispatch import assignment_retry_count

        ticks = [self._tick() for _ in range(5)]
        self.assertEqual([tick["status"] for tick in ticks], ["provider_cooldown"] * 5,
                         "every tick tells the scheduler to back off; none is executor_failed")
        self.assertEqual(len(self.spawned), 1, "one claim and one spawn per back-off window")
        self.assertEqual([(tick["claim_id"] is None) for tick in ticks], [False, True, True, True, True])
        self.assertEqual([tick["provider_cooldown"]["provider"] for tick in ticks], ["anthropic"] * 5)
        self.assertEqual(assignment_retry_count(assignment_id="A-W-1", base_dir=self.tools), 0)
        self.assertNotIn("max_retries_exceeded", [tick["status"] for tick in ticks])
        governance = load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
        released = [row["details"]["reason"] for row in governance if row["kind"] == "dispatch_claim_released"]
        self.assertEqual(released, ["provider_quota_unavailable:anthropic"], "released harness-class, once")
        self.assertEqual([(row["provider"], row["detection"]["signature"]) for row in self._cooldowns(self.tools)],
                         [("anthropic", "claude_logged_out")])

    def test_with_the_zai_key_on_the_host_the_next_tick_runs_the_worker_on_glm(self) -> None:
        first = self._tick()
        self.assertEqual(first["status"], "provider_cooldown")
        with patch.dict(os.environ, {"ARIA_ZAI_API_KEY_FILE": str(self.tmp / "zai.key")}):
            second = self._tick()
        self.assertEqual(self.spawned[1][self.spawned[1].index("--model") + 1], "glm-5.3")
        self.assertEqual([loop["model"] for loop in self.loops], ["glm-5.3"])
        self.assertNotEqual(second["status"], "provider_cooldown")


if __name__ == "__main__":
    unittest.main()
