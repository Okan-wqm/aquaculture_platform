"""The managed Anthropic session on the executor's native lane — real claim, real submit, fake CLI.

Same shape as the native Codex and Z.ai lanes: the ACTUAL ci_executor entry
runs as a child, the ACTUAL kernel CLI claims and submits, and the only
declared substitute is the `claude` binary — a script that answers
`--version`, `auth status --json` (the managed session's own non-model
status) and the `-p` stream-json run. No codex binary and no Z.ai
credential exist, so the only route the fleet can admit is Anthropic.

What this pins, one property per test:

* A logged-in claude.ai session plus the containment backend admits the
  route with auth_method `subscription`; the agent runs through the
  existing spawn, the prompt it receives opens with its own contract, the
  result is sealed with the attempt's ledger hash, the finished row names
  the session and the usage row, and the request is ACCEPTED.
* A session logged in through an API key is refused by name
  (`api_key_auth_not_managed`) — the binding table admits the subscription
  only — and the request stays PENDING with no attempt burned.
* A logged-out session is `managed_session_logged_out`, PENDING, no attempt.
* ARIA-HIGH-076 — a limiter that needs the user bus (`systemd-run --user`)
  receives it, in the probe and in the run, while the agent it limits never
  sees it: the spawn environment is built, and the bus is not on it. The
  first live attempt on this route died with "Failed to connect to bus: No
  medium found" because the limiter was selected in the executor's
  environment and launched in the agent's.
* Operator decision 2026-09-12 — a session whose quota is exhausted (the CLI
  answers the usage-limit notice as assistant content on exit 0) spawns
  opus exactly ONCE (no sonnet retry), releases the claim as REQUEUED under
  `provider_quota_unavailable:anthropic` (harness fault: the requeue budget
  is untouched), records a `provider_quota_cooldown` row naming the provider
  and `quota_unavailable`, and the NEXT executor run refuses anthropic by
  name (`provider_quota_cooldown`) without spawning anything, leaving the
  request REQUEUED for when the provider is back.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
_KERNEL_DIR = _REPO_ROOT / "aria-kernel"
for _path in (_POC_DIR, _KERNEL_DIR):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from tests import test_ci_executor_live_path_smoke as _smoke  # noqa: E402


# The installed CLI's own status arm (Claude Code 2.1.269, read from the
# binary: `process.exit(loggedIn ? 0 : 1)`): the document is printed
# whatever the answer, and a logged-out session ALSO exits 1. A fixture
# that exited 0 on a logged-out document let the lane pass a shape the
# real CLI never produces (verifier, ARIA-HIGH-107).
_STATUS_ARM = "    print(json.dumps(status)); raise SystemExit(0 if status['loggedIn'] else 1)\n"


def _fake_claude(status: dict, response: dict, host_login_dir: Path) -> str:
    return (
        f"#!{sys.executable}\n"
        "import json, os, sys\n"
        "from pathlib import Path\n"
        "argv = sys.argv[1:]\n"
        "if argv == ['--version']:\n"
        "    print('2.1.269 (Claude Code)'); raise SystemExit(0)\n"
        "if argv[:3] == ['auth', 'status', '--json']:\n"
        f"    status = {status!r}\n"
        + _STATUS_ARM +
        "prompt = sys.stdin.read()\n"
        # The spawn may run inside the write-containment sandbox (private /tmp),
        # so the child's observation travels INSIDE its answer, as the native
        # Codex fixture does, rather than through a file it might not reach.
        f"response = {response!r}\n"
        # ARIA-HIGH-077: which binary ran, whether the documents the spawn
        # wrote are visible, and which config dir the CLI was handed.
        "flag = lambda name: argv[argv.index(name) + 1] if name in argv else None\n"
        "config_dir = os.environ.get('CLAUDE_CONFIG_DIR', '')\n"
        "response['details']['ordinary_child_observation'] = {'prompt_head': prompt[:48], 'argv': argv,\n"
        "    'executable': sys.argv[0], 'settings_visible': bool(flag('--settings')) and os.path.isfile(flag('--settings')),\n"
        "    'mcp_visible': bool(flag('--mcp-config')) and os.path.isfile(flag('--mcp-config')),\n"
        "    'config_dir': config_dir, 'credentials_visible': os.path.isfile(os.path.join(config_dir, '.credentials.json')),\n"
        f"    'host_login_visible': os.path.exists({str(host_login_dir)!r}),\n"
        "    'key_names': [k for k in os.environ if k in ('ANTHROPIC_API_KEY','ARIA_ZAI_API_KEY','ARIA_ZAI_API_KEY_FILE','OPENAI_API_KEY',\n"
        "                                                   'DBUS_SESSION_BUS_ADDRESS','XDG_RUNTIME_DIR')],\n"
        "    'cwd': os.getcwd()}\n"
        "message = json.dumps(response)\n"
        "print(json.dumps({'type': 'assistant', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': message}]}}))\n"
        "print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': message,\n"
        "                  'usage': {'input_tokens': 900, 'output_tokens': 120}, 'session_id': 'fixture-session'}))\n"
    )


# The production shape of a quota exhaustion (2026-07-03, measured live): the
# CLI exits 0 and delivers its limit notice as the assistant's answer, with a
# usage block, so an exhausted run is byte-shaped like a successful one.
_USAGE_LIMIT_NOTICE = "You've reached your limit. Run /usage-credits to continue or switch models with /model."


def _fake_exhausted_claude(status: dict) -> str:
    return (
        f"#!{sys.executable}\n"
        "import json, sys\n"
        "argv = sys.argv[1:]\n"
        "if argv == ['--version']:\n"
        "    print('2.1.269 (Claude Code)'); raise SystemExit(0)\n"
        "if argv[:3] == ['auth', 'status', '--json']:\n"
        f"    status = {status!r}\n"
        + _STATUS_ARM +
        "sys.stdin.read()\n"
        f"message = {_USAGE_LIMIT_NOTICE!r}\n"
        "print(json.dumps({'type': 'assistant', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': message}]}}))\n"
        "print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': message,\n"
        "                  'usage': {'input_tokens': 12, 'output_tokens': 0}, 'session_id': 'fixture-session'}))\n"
    )


class NativeClaudeLane(unittest.TestCase):
    def setUp(self) -> None:
        _smoke.NativeAdaptiveAdmissionTests.setUp(self)
        _smoke.NativeAdaptiveAdmissionTests._enable_adaptive_policy(self)
        policy_path = self.repo / "aria-config/genesis_policy.json"
        policy = json.loads(policy_path.read_text(encoding="utf-8"))
        policy["executor"]["adaptive_runtime"]["monetary_admission"] = "managed_subscription"
        policy_path.write_text(json.dumps(policy) + "\n", encoding="utf-8")
        kernel_directory = self.repo / "aria-kernel"
        kernel_directory.mkdir()
        import shutil as _shutil
        _shutil.copytree(_KERNEL_DIR / "aria_kernel", kernel_directory / "aria_kernel",
                         ignore=_shutil.ignore_patterns("__pycache__"))
        (self.binary_dir / "python3").symlink_to(sys.executable)
        # The write-containment sandbox mounts a private /tmp, so a fake CLI
        # under the /tmp fixture root would not exist inside it ("bwrap:
        # execvp claude: No such file or directory"). The workspace IS bound
        # read-only into the sandbox; its gitignored aria-tools/ tree hosts
        # the fixture binary, exactly as the real CLI lives on a bound path.
        self.fixture_bin = self.repo / "aria-tools" / "fixture-bin"
        self.fixture_bin.mkdir(parents=True, exist_ok=True)
        config_dir = self.home / ".claude"
        config_dir.mkdir(parents=True, exist_ok=True)
        (config_dir / ".credentials.json").write_text('{"fixture":"managed-session"}\n', encoding="utf-8")
        self.response = {
            "satisfaction_matrix": [{"id": "provider-source", "verdict": "satisfied",
                                     "evidence_refs": ["src/model_fleet.py:1"],
                                     "evidence": "the module docstring names the fleet"}],
            "evidence_refs": ["src/model_fleet.py:1"],
            "details": {"verdict": {"verdict": "true_positive", "judge_id": "aria-evidence-judge",
                                    "tool_id": "fixture-tool", "run_id": "fixture-run", "finding_id": "F-001",
                                    "confidence": 0.9, "rationale": "the cited line declares the fleet"}},
        }
        self.environment = {
            **os.environ, "PATH": str(self.fixture_bin) + os.pathsep + str(self.binary_dir) + os.pathsep + os.defpath,
            "ARIA_WORKSPACE_ROOT": str(self.repo), "MAX_TIMEOUT_SECONDS": "60",
            "CLAUDE_CONFIG_DIR": str(config_dir),
            # The suite runs as root on this host; the CLI refuses the
            # permission bypass under root unless the operator acknowledges a
            # genuine sandbox (ADR-040). The fixture binary is not the CLI, so
            # the acknowledgement here changes nothing about what runs.
            "ARIA_CLAUDE_SANDBOX": "1",
        }
        for name in ("ARIA_ZAI_API_KEY", "ARIA_ZAI_API_KEY_FILE", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"):
            self.environment.pop(name, None)
        self.host_login_dir = config_dir

    def _install_claude(self, status: dict, *, exhausted: bool = False) -> None:
        executable = self.fixture_bin / "claude"
        script = (_fake_exhausted_claude(status) if exhausted
                  else _fake_claude(status, self.response, self.host_login_dir))
        executable.write_text(script, encoding="utf-8")
        executable.chmod(0o755)

    def _run_executor(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-B", str(_POC_DIR / "ci_executor.py"), self.request["request_id"], "aria-evidence-judge"],
            cwd=self.repo, env=self.environment, capture_output=True, text=True, timeout=180,
        )

    def test_a_managed_session_admits_runs_and_accepts(self) -> None:
        from aria_kernel.ledger import load_declared_jsonl

        self._install_claude({"loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty",
                              "subscriptionType": "max"})
        completed = self._run_executor()
        governance = load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
        self.assertEqual(completed.returncode, 0, completed.stderr + json.dumps(
            [row for row in governance if row["kind"].startswith("runtime_")], sort_keys=True)[:4000])
        self.assertEqual(self.ai.derive_request_state(request_id=self.request["request_id"], base_dir=self.tools), "ACCEPTED")
        output = json.loads(Path(self.request["expected_output_path"]).read_text(encoding="utf-8"))
        diagnostic = output["details"]["ordinary_child_observation"]
        self.assertTrue(diagnostic["prompt_head"].startswith("# Agent contract: aria-evidence-judge\n"), diagnostic["prompt_head"])
        self.assertEqual(diagnostic["key_names"], [])
        self.assertIn("-p", diagnostic["argv"])
        # ARIA-HIGH-077 — inside the real sandbox: the executable the executor
        # resolved ran by absolute path, the settings and MCP documents it
        # wrote were visible, the CLI's config dir is the private home's and
        # holds the one credential file, and the host login dir is not there.
        self.assertEqual(diagnostic["executable"], str((self.fixture_bin / "claude").resolve()))
        self.assertTrue(diagnostic["settings_visible"], diagnostic)
        self.assertTrue(diagnostic["mcp_visible"], diagnostic)
        self.assertEqual(diagnostic["config_dir"], "/tmp/aria-agent-home/.claude")
        self.assertTrue(diagnostic["credentials_visible"], diagnostic)
        self.assertFalse(diagnostic["host_login_visible"], diagnostic)
        self.assertEqual(output["role"], "evidence_judgment")
        self.assertTrue(output["details"]["agent_contract_hash"].startswith("sha256:"))
        attempt_rows = [row for row in governance if row["kind"] == "runtime_attempt_started"
                        and row["details"].get("request_id") == self.request["request_id"]]
        self.assertEqual(len(attempt_rows), 1)
        attempts = [attempt_rows[0]["details"]]
        self.assertEqual((attempts[0]["provider"], attempts[0]["runtime"], attempts[0]["auth_method"]),
                         ("anthropic", "claude", "subscription"))
        self.assertEqual(attempts[0]["model"], self.profile.model)
        # The whole fleet decision rides the attempt row: every candidate's
        # observation, so a preferred route that was skipped is explained
        # even when another route ran.
        admission = attempts[0]["admission"]
        self.assertEqual([row["provider"] for row in admission["candidate_observations"]], ["anthropic", "zai", "openai"])
        self.assertEqual(admission["eligible_routes"][0]["provider"], "anthropic")
        self.assertEqual({row["provider"]: row["status_reason"] for row in admission["candidate_observations"]}["zai"],
                         "provider_not_configured")
        self.assertEqual(output["details"]["runtime_attempt_ledger_hash"], attempt_rows[0]["ledger_hash"])
        finished = [row["details"] for row in governance if row["kind"] == "runtime_attempt_finished"
                    and row["details"].get("request_id") == self.request["request_id"]]
        self.assertEqual(len(finished), 1)
        self.assertEqual(finished[0]["provider_session_provenance"], "claude_session_id")
        self.assertEqual(finished[0]["exit_code"], 0)
        self.assertEqual(finished[0]["result_admission"], "pending_native_submit")
        self.assertTrue(finished[0]["usage_ledger_hash"])
        self.assertEqual(finished[0]["agent_contract"]["agent_contract_hash"], output["details"]["agent_contract_hash"])
        admissions = [row for row in governance if row["kind"] == "runtime_admission_unavailable"]
        self.assertEqual(admissions, [])

    def test_the_limiter_receives_the_bus_and_the_agent_does_not(self) -> None:
        from aria_kernel.implementation_safety import LIMITER_CONTROL_ENV_NAMES
        from aria_kernel.ledger import load_declared_jsonl

        # A limiter that behaves like `systemd-run --user` on a host with a
        # user session bus: refuses without the plumbing, otherwise records
        # what it saw and runs the command it was given.
        observations = self.root / "limiter-observations.jsonl"
        bus = {LIMITER_CONTROL_ENV_NAMES[0]: "unix:path=/ordinary-fixture-bus",
               LIMITER_CONTROL_ENV_NAMES[1]: str(self.root / "user-runtime")}
        limiter = self.fixture_bin / "systemd-run"
        limiter.write_text(
            f"#!{sys.executable}\n"
            "import json, os, sys\n"
            f"expected = {bus!r}\n"
            "probe = sys.argv[-1] == '/bin/true'\n"
            f"with open({str(observations)!r}, 'a') as stream:\n"
            "    stream.write(json.dumps({'probe': probe, 'bus_present': [n for n in expected if os.environ.get(n) == expected[n]]}) + '\\n')\n"
            "if any(os.environ.get(n) != v for n, v in expected.items()):\n"
            "    print('Failed to connect to bus: No medium found', file=sys.stderr); raise SystemExit(1)\n"
            "if probe: raise SystemExit(0)\n"
            "index = 1\n"
            "while sys.argv[index].startswith('--'): index += 1\n"
            "os.execvp(sys.argv[index], sys.argv[index:])\n",
            encoding="utf-8",
        )
        limiter.chmod(0o755)
        self.environment.update(bus)
        self._install_claude({"loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty",
                              "subscriptionType": "max"})
        completed = self._run_executor()
        self.assertEqual(completed.returncode, 0, completed.stderr[-3000:])
        self.assertEqual(self.ai.derive_request_state(request_id=self.request["request_id"], base_dir=self.tools), "ACCEPTED")
        rows = [json.loads(line) for line in observations.read_text(encoding="utf-8").splitlines()]
        self.assertTrue(rows and rows[0]["probe"], rows)
        self.assertEqual(rows[0]["bus_present"], list(LIMITER_CONTROL_ENV_NAMES))
        runs = [row for row in rows if not row["probe"]]
        self.assertEqual([row["bus_present"] for row in runs], [list(LIMITER_CONTROL_ENV_NAMES)],
                         "the selected limiter must actually launch the agent, with the bus")
        output = json.loads(Path(self.request["expected_output_path"]).read_text(encoding="utf-8"))
        self.assertEqual(output["details"]["ordinary_child_observation"]["key_names"], [])
        governance = load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
        finished = [row["details"] for row in governance if row["kind"] == "runtime_attempt_finished"]
        self.assertEqual([row["exit_code"] for row in finished], [0])

    def test_an_api_key_login_is_refused_by_name(self) -> None:
        from aria_kernel.ledger import load_declared_jsonl

        self._install_claude({"loggedIn": True, "authMethod": "console", "apiProvider": "firstParty"})
        completed = self._run_executor()
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(self.ai.derive_request_state(request_id=self.request["request_id"], base_dir=self.tools), "PENDING")
        self.assertFalse(Path(self.request["expected_output_path"]).exists(), "no model run may follow a refused admission")
        governance = load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
        self.assertFalse(any(row["kind"] == "runtime_attempt_started" for row in governance))
        decisions = [row["details"] for row in governance if row["kind"] == "runtime_admission_unavailable"]
        self.assertEqual(len(decisions), 1)
        anthropic = next(row for row in decisions[0]["candidate_observations"] if row["provider"] == "anthropic")
        self.assertEqual((anthropic["auth_observation"], anthropic["status_reason"], anthropic["auth_method"]),
                         ("unavailable", "api_key_auth_not_managed", "api_key"))
        self.assertEqual(anthropic["credential_source"], "managed_session")

    def test_a_logged_out_session_keeps_the_request_pending(self) -> None:
        from aria_kernel.ledger import load_declared_jsonl

        # The real shape: `{"loggedIn": false, "authMethod": "none"}` AND
        # exit 1 (the fixture's status arm mirrors the installed CLI).
        self._install_claude({"loggedIn": False, "authMethod": "none", "apiProvider": "firstParty"})
        completed = self._run_executor()
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(self.ai.derive_request_state(request_id=self.request["request_id"], base_dir=self.tools), "PENDING")
        governance = load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
        decisions = [row["details"] for row in governance if row["kind"] == "runtime_admission_unavailable"]
        self.assertEqual(len(decisions), 1)
        anthropic = next(row for row in decisions[0]["candidate_observations"] if row["provider"] == "anthropic")
        # DECIDED by the document, with the exit code as evidence — the
        # defect, first: exit-code-first classification recorded
        # ("unknown", "status_not_confirmed") for the vendor's own "no".
        self.assertEqual((anthropic["auth_observation"], anthropic["status_reason"], anthropic["status_exit_code"]),
                         ("unavailable", "managed_session_logged_out", 1))
        # One attempt, no retry, `no_eligible_provider` — never a stall.
        self.assertEqual((anthropic["decision"], anthropic["probe"]["attempts"]), ("unavailable", 1))
        self.assertEqual((decisions[0]["reason"], decisions[0]["halting_provider"]), ("no_eligible_provider", None))

    def test_an_exhausted_session_requeues_under_a_provider_cooldown(self) -> None:
        from aria_kernel.ledger import load_declared_jsonl

        self._install_claude({"loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty",
                              "subscriptionType": "max"}, exhausted=True)
        completed = self._run_executor()
        self.assertEqual(completed.returncode, 1, completed.stderr[-3000:])
        self.assertIn("claude_credit_exhausted", completed.stderr)
        request_id = self.request["request_id"]
        self.assertEqual(self.ai.derive_request_state(request_id=request_id, base_dir=self.tools), "REQUEUED")
        self.assertFalse(Path(self.request["expected_output_path"]).exists(),
                         "a usage-limit notice is not an answer and must not be sealed")

        # Exactly one spawn, on the agent's own tier: the usage ledger records
        # one row per spawn with the model alias, so a sonnet retry would show
        # up here as a second row.
        usage = load_declared_jsonl(self.tools / "knowledge-graph/context-usage.jsonl", expected_surface="context_usage")
        self.assertEqual([row["model"] for row in usage if row["request_id"] == request_id], [self.profile.model])
        self.assertEqual(self.profile.model, "opus")

        claims = load_declared_jsonl(self.tools / "agent-invocations/claims.jsonl",
                                     expected_surface="agent_invocation_claims")
        released = [row for row in claims if row.get("event") == "released"]
        self.assertEqual([row["reason"] for row in released], ["provider_quota_unavailable:anthropic"])
        self.assertEqual((released[0]["reason_code"], released[0]["reason_detail"], released[0]["fault_domain"]),
                         ("PROVIDER_QUOTA_UNAVAILABLE", "anthropic", "harness"))
        self.assertEqual([row["event"] for row in claims if row.get("event") in ("requeued", "human_required")],
                         ["requeued"])
        # A billing event says nothing about the request: its budget is intact.
        self.assertEqual(self.ai._request_fault_requeue_count(claims, request_id), 0)

        governance = load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
        cooldowns = [row["details"] for row in governance if row["kind"] == "provider_quota_cooldown"]
        self.assertEqual(len(cooldowns), 1)
        self.assertEqual((cooldowns[0]["provider"], cooldowns[0]["model"], cooldowns[0]["reason"],
                          cooldowns[0]["cooldown_seconds"], cooldowns[0]["request_id"]),
                         ("anthropic", "opus", "quota_unavailable", 900, request_id))
        self.assertEqual(cooldowns[0]["detection"]["matched_marker"], "usage-credits")
        detections = [row["details"] for row in governance if row["kind"] == "model_credit_exhausted"]
        self.assertEqual([(row["model"], row["credit_exhaustion"]["matched_marker"]) for row in detections],
                         [("opus", "usage-credits")])
        finished = [row["details"] for row in governance if row["kind"] == "runtime_attempt_finished"]
        self.assertEqual([row["result_admission"] for row in finished], ["quota_unavailable"])
        attempts_before = [row for row in governance if row["kind"] == "runtime_attempt_started"]
        self.assertEqual(len(attempts_before), 1)

        # The next drain tick: the cooled provider is refused by name before
        # any claim or spawn, the other vendors are not configured here, and
        # the request stays REQUEUED for when opus is back.
        second = self._run_executor()
        self.assertEqual(second.returncode, 0, second.stderr[-3000:])
        self.assertEqual(self.ai.derive_request_state(request_id=request_id, base_dir=self.tools), "REQUEUED")
        governance = load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
        self.assertEqual(len([row for row in governance if row["kind"] == "runtime_attempt_started"]), 1,
                         "no second spawn while the provider is cooled")
        decisions = [row["details"] for row in governance if row["kind"] == "runtime_admission_unavailable"]
        self.assertEqual(len(decisions), 1)
        anthropic = next(row for row in decisions[0]["candidate_observations"] if row["provider"] == "anthropic")
        self.assertEqual((anthropic["status_reason"], anthropic["quota_observation"]),
                         ("provider_quota_cooldown", "unavailable"))
        self.assertEqual(anthropic["quota_cooldown"]["until"], cooldowns[0]["until"])
        self.assertEqual(anthropic["status_command"], [], "a cooled provider is not probed")
        usage = load_declared_jsonl(self.tools / "knowledge-graph/context-usage.jsonl", expected_surface="context_usage")
        self.assertEqual(len([row for row in usage if row["request_id"] == request_id]), 1)
        self.assertEqual(len([row for row in load_declared_jsonl(
            self.tools / "agent-invocations/claims.jsonl", expected_surface="agent_invocation_claims",
        ) if row.get("event") == "claimed"]), 1, "no second claim was taken")


if __name__ == "__main__":
    unittest.main()
