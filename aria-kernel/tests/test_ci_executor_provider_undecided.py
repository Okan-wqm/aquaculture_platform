"""ARIA-HIGH-107 on the executor's native lane — real claim, real release, scripted CLIs.

The trial-eleven shape (2026-09-12 20:42Z, dispatch 03 of chain A): the
managed Anthropic session is logged in, the ChatGPT-managed Codex session is
logged in, and `claude auth status --json` does not answer inside its 20 s
cap. Before this fix the fleet read the stalled row as a refusal and the
primary planner ran on openai/gpt-6-astra. Same fixture as the native Claude
lane (`test_ci_executor_native_claude`): the ACTUAL `ci_executor` entry runs
as a child, the ACTUAL kernel claims, releases and submits; the only declared
substitutes are the `claude` and `codex` binaries — scripts on the bound
fixture path — and no Z.ai credential exists.

What this pins, one property per test:

* A probe that stalls ONCE (a real 20 s `TimeoutExpired`) and then answers
  admits anthropic on the second attempt; the run completes on opus and the
  attempt row's admission carries the two attempts and the stall it survived.
* A probe that stays undecided throughout leaves the admission
  `provider_undecided` for anthropic: NO openai route although openai is
  up, the request stays PENDING with no claim and no attempt burned, the
  child's summary names the refusal, and the governance row names the
  undecided provider with its attempts and backoff.
* Through the real planner dispatch hook with a probe that stalls
  throughout (three real 20 s timeouts — the production bound, spent so the
  ledger shows it): the claim the hook took is released under
  `native_runtime_provider_undecided` (harness: budget intact), the request
  is REQUEUED, nothing ran on any vendor, and the hook reports
  `provider_undecided` so the daemon backs off instead of re-probing at once.
* The inverse (verifier, 2026-09-12): the installed CLI reports a
  logged-out session as `{"loggedIn": false}` AND exit 1. That is the
  vendor's DECIDED no — one attempt, no retry — and a read-only role fails
  over to openai on it (the one class the operator decision allows); the
  attempt row lands on openai/gpt-6-astra with anthropic's refusal beside it.
* A host whose containment is unusable (a `bwrap` that cannot build its
  namespaces) with the session logged in: the vendor said yes, THIS host
  cannot bind the route's controls. Not an auth reason: the ladder halts
  as `provider_control_unavailable` naming anthropic, admits nobody (the
  Codex context fails on the same broken sandbox and is recorded), burns
  nothing, and the summary says `harness_unavailable`, retryable.
"""
from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
_KERNEL_DIR = _REPO_ROOT / "aria-kernel"
for _path in (_POC_DIR, _KERNEL_DIR):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from tests import test_ci_executor_native_claude as _lane  # noqa: E402

_LOGGED_IN = {"loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty", "subscriptionType": "max"}
_LOGGED_OUT = {"loggedIn": False, "authMethod": "none", "apiProvider": "firstParty"}

# How the scripted `claude` treats each successive `auth status --json`:
# "stall" sleeps past the 20 s per-attempt cap (the probe's TimeoutExpired
# kills it — the trial-eleven shape), "unconfirmed" exits non-zero at once
# (undecided without the wait), "answer" reports the logged-in session.
_STALL_ONCE = ("stall", "answer")
_UNCONFIRMED_THROUGHOUT = ("unconfirmed",) * 3
_STALL_THROUGHOUT = ("stall",) * 3


def _scripted_claude(behaviour: tuple[str, ...], counter: Path, response: dict, host_login_dir: Path,
                     status: dict = _LOGGED_IN) -> str:
    answering = _lane._fake_claude(status, response, host_login_dir)
    head, _, tail = answering.partition("if argv[:3] == ['auth', 'status', '--json']:\n")
    # Replace the status arm: consult the counter, act per `behaviour`, then
    # fall through to the answering fixture's own status line.
    status_arm = (
        "if argv[:3] == ['auth', 'status', '--json']:\n"
        "    import time\n"
        f"    counter = Path({str(counter)!r})\n"
        "    seen = int(counter.read_text()) if counter.is_file() else 0\n"
        "    counter.write_text(str(seen + 1))\n"
        f"    behaviour = {list(behaviour)!r}\n"
        "    step = behaviour[min(seen, len(behaviour) - 1)]\n"
        "    if step == 'stall':\n"
        "        time.sleep(90)\n"
        "    if step == 'unconfirmed':\n"
        "        raise SystemExit(1)\n"
    )
    return head + status_arm + tail


class ProviderUndecidedLane(unittest.TestCase):
    """The native Claude lane's fixture, composed rather than inherited so the
    lane's own cases do not re-run under a fleet that also has Codex."""

    def setUp(self) -> None:
        _lane.NativeClaudeLane.setUp(self)
        self.counter = self.home / "claude-status-attempts.txt"
        # The ChatGPT-managed Codex session: on the bound fixture path so the
        # managed context can wrap it, with the session file the cheap
        # availability signal and the managed context both require.
        codex = self.fixture_bin / "codex"
        codex.write_text(
            f"#!{sys.executable}\n"
            "import sys\n"
            "if sys.argv[-2:] == ['login', 'status']:\n"
            "    print('Logged in using ChatGPT', file=sys.stderr); raise SystemExit(0)\n"
            "raise SystemExit(97)\n",
            encoding="utf-8",
        )
        codex.chmod(0o755)
        managed_home = self.home / ".codex"
        managed_home.mkdir(parents=True, exist_ok=True)
        (managed_home / "auth.json").write_text('{"fixture":"native-managed-session"}\n', encoding="utf-8")
        self.runner_temp = self.root / "runner-temp"
        self.runner_temp.mkdir(exist_ok=True)
        self.environment["RUNNER_TEMP"] = str(self.runner_temp)
        self.environment["CODEX_HOME"] = str(managed_home)

    def _install_scripted_claude(self, behaviour: tuple[str, ...]) -> None:
        executable = self.fixture_bin / "claude"
        executable.write_text(_scripted_claude(behaviour, self.counter, self.response, self.host_login_dir),
                              encoding="utf-8")
        executable.chmod(0o755)

    def _install_logged_out_claude(self) -> None:
        # The lane fixture's status arm mirrors the installed CLI: the
        # logged-out document is printed and the process exits 1.
        executable = self.fixture_bin / "claude"
        executable.write_text(_scripted_claude(("answer",), self.counter, self.response, self.host_login_dir,
                                               status=_LOGGED_OUT), encoding="utf-8")
        executable.chmod(0o755)

    def _install_unusable_bwrap(self) -> None:
        # bwrap is on PATH but cannot build the namespaces the probe asks
        # for (the shape of a host with user namespaces disabled): the
        # kernel's sandbox probe fails and `sandbox_backend()` is None.
        executable = self.fixture_bin / "bwrap"
        executable.write_text(f"#!{sys.executable}\nraise SystemExit(1)\n", encoding="utf-8")
        executable.chmod(0o755)

    def _run_executor(self):
        return _lane.NativeClaudeLane._run_executor(self)

    def _status_attempts(self) -> int:
        return int(self.counter.read_text()) if self.counter.is_file() else 0

    def _governance(self) -> list[dict]:
        from aria_kernel.ledger import load_declared_jsonl

        return load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")

    def _claims(self) -> list[dict]:
        from aria_kernel.ledger import load_declared_jsonl

        return load_declared_jsonl(self.tools / "agent-invocations/claims.jsonl",
                                   expected_surface="agent_invocation_claims")

    def test_a_probe_that_stalls_once_then_answers_admits_anthropic(self) -> None:
        self._install_scripted_claude(_STALL_ONCE)
        completed = self._run_executor()
        governance = self._governance()
        # The defect, first: on the pre-fix fleet one stall is a refusal and
        # this attempt ran on openai/gpt-6-astra instead of opus.
        attempts = [row["details"] for row in governance if row["kind"] == "runtime_attempt_started"]
        self.assertEqual([(row["provider"], row["model"]) for row in attempts], [("anthropic", "opus")],
                         "one stalled probe is retried, not failed over")
        self.assertEqual(completed.returncode, 0, completed.stderr[-3000:] + json.dumps(
            [row for row in governance if row["kind"].startswith("runtime_")], sort_keys=True)[:4000])
        self.assertEqual(self.ai.derive_request_state(request_id=self.request["request_id"], base_dir=self.tools), "ACCEPTED")
        self.assertEqual(self._status_attempts(), 2, "the stalled attempt was retried once and answered")
        from aria_kernel.status_probe import STATUS_PROBE_BACKOFF_SECONDS

        admission = attempts[0]["admission"]
        self.assertEqual(admission["outcome"], "admitted")
        self.assertIsNone(admission["halting_provider"])
        self.assertEqual([route["provider"] for route in admission["eligible_routes"]], ["anthropic", "openai"])
        anthropic = next(row for row in admission["candidate_observations"] if row["provider"] == "anthropic")
        self.assertEqual((anthropic["decision"], anthropic["status_reason"]), ("available", "managed_session_logged_in"))
        self.assertEqual(anthropic["probe"], {"attempts": 2, "undecided_reasons": ["status_timeout"],
                                              "backoff_seconds": STATUS_PROBE_BACKOFF_SECONDS[0]})
        openai = next(row for row in admission["candidate_observations"] if row["provider"] == "openai")
        self.assertEqual((openai["decision"], openai["probe"]["attempts"]), ("available", 1))

    def test_a_probe_that_stays_undecided_admits_nobody_and_burns_nothing(self) -> None:
        self._install_scripted_claude(_UNCONFIRMED_THROUGHOUT)
        completed = self._run_executor()
        governance = self._governance()
        # The defect, first: on the pre-fix fleet this row exists with
        # provider openai / gpt-6-astra — the dispatch trial eleven burned.
        attempts = [row["details"] for row in governance if row["kind"] == "runtime_attempt_started"]
        self.assertEqual([(row["provider"], row["model"]) for row in attempts], [],
                         "an undecided anthropic must not fail over: no attempt on any vendor")
        self.assertEqual(completed.returncode, 0, completed.stderr[-3000:])
        request_id = self.request["request_id"]
        self.assertEqual(self.ai.derive_request_state(request_id=request_id, base_dir=self.tools), "PENDING")
        self.assertFalse((self.tools / "agent-invocations/claims.jsonl").exists() and self._claims(),
                         "no claim is taken for an admission the fleet could not decide")
        self.assertFalse(Path(self.request["expected_output_path"]).exists())
        from aria_kernel.status_probe import STATUS_PROBE_ATTEMPTS, STATUS_PROBE_BACKOFF_SECONDS

        self.assertEqual(self._status_attempts(), STATUS_PROBE_ATTEMPTS)
        decisions = [row["details"] for row in governance if row["kind"] == "runtime_admission_unavailable"]
        self.assertEqual(len(decisions), 1)
        self.assertEqual((decisions[0]["reason"], decisions[0]["halting_provider"]), ("provider_undecided", "anthropic"))
        self.assertEqual(decisions[0]["eligible_routes"], [], "openai is up and is NOT a route for this dispatch")
        rows = {row["provider"]: row for row in decisions[0]["candidate_observations"]}
        # Exit 1 with NO status document: the exit code is the only fact and
        # names the undecided reason (a logged-out document with exit 1 is
        # the decided case, pinned below).
        self.assertEqual((rows["anthropic"]["decision"], rows["anthropic"]["status_reason"], rows["anthropic"]["status_exit_code"]),
                         ("undecided", "status_not_confirmed", 1))
        self.assertEqual(rows["anthropic"]["probe"],
                         {"attempts": STATUS_PROBE_ATTEMPTS,
                          "undecided_reasons": ["status_not_confirmed"] * STATUS_PROBE_ATTEMPTS,
                          "backoff_seconds": sum(STATUS_PROBE_BACKOFF_SECONDS)})
        self.assertEqual((rows["openai"]["decision"], rows["openai"]["auth_method"], rows["openai"]["controls"]["status"]),
                         ("available", "chatgpt", "available"))
        self.assertEqual(rows["zai"]["decision"], "unavailable")
        summary = json.loads((self.runner_temp / f"dispatch-result-{request_id}.json").read_text(encoding="utf-8"))
        # The summary agrees with the release (harness) and the hook's
        # back-off: a stalled host is not a policy the dispatch violated,
        # and the daemon retries it.
        self.assertEqual((summary["outcome"], summary["failure_class"], summary["retryable"], summary["failure_detail_code"]),
                         ("refused", "harness_unavailable", True, "provider_undecided"))

    def test_a_logged_out_document_with_exit_one_is_decided_and_fails_over(self) -> None:
        self._install_logged_out_claude()
        completed = self._run_executor()
        governance = self._governance()
        # The inverse defect, first: exit-code-first classification read the
        # vendor's "no" as a stall, retried it and halted with openai up.
        attempts = [row["details"] for row in governance if row["kind"] == "runtime_attempt_started"]
        self.assertEqual([(row["provider"], row["model"]) for row in attempts], [("openai", "gpt-6-astra")],
                         "a logged-out session is an AUTH fact: a read-only role fails over on it")
        self.assertEqual(self._status_attempts(), 1, "a decided refusal is never retried")
        admission = attempts[0]["admission"]
        anthropic = next(row for row in admission["candidate_observations"] if row["provider"] == "anthropic")
        # The row says WHY openai ran: the vendor's own "no", decided by its
        # document with the exit code as evidence — not a probe that failed
        # to confirm (the pre-fix row: "unknown" / "status_not_confirmed").
        self.assertEqual((anthropic["auth_observation"], anthropic["status_reason"], anthropic["status_exit_code"]),
                         ("unavailable", "managed_session_logged_out", 1))
        self.assertEqual([row["details"] for row in governance if row["kind"] == "runtime_admission_unavailable"], [])
        self.assertEqual((admission["outcome"], admission["halting_provider"]), ("admitted", None))
        self.assertEqual([route["provider"] for route in admission["eligible_routes"]], ["openai"])
        self.assertEqual((anthropic["decision"], anthropic["probe"]),
                         ("unavailable", {"attempts": 1, "undecided_reasons": [], "backoff_seconds": 0.0}))
        # The scripted codex answers only `login status`; what its `exec`
        # does with the dispatch is the native Codex lane's concern. This
        # case is about the admission, and the child said what it did.
        self.assertIn("runtime_attempt_finished", [row["kind"] for row in governance], completed.stderr[-2000:])

    def test_a_zai_transport_that_does_not_answer_is_undecided_not_a_control_gap(self) -> None:
        """Anthropic decided-unavailable (logged out) puts Z.ai first in
        contention; a Z.ai transport error (connection refused on a closed
        local port) is the stall class: UNDECIDED, retried within the bound,
        and the ladder halts as provider_undecided(zai) — never
        provider_control_unavailable (a host that could not bind its
        controls) and never a fail-over to openai on a vendor nobody heard."""
        import socket

        self._install_logged_out_claude()
        key = self.root / "zai.key"
        key.write_text("fixture-credential-never-sent\n", encoding="utf-8")
        key.chmod(0o600)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            closed_port = probe.getsockname()[1]
        self.environment["ARIA_ZAI_API_KEY_FILE"] = str(key)
        self.environment["ARIA_ZAI_ENDPOINT"] = f"http://127.0.0.1:{closed_port}"
        completed = self._run_executor()
        governance = self._governance()
        attempts = [row["details"] for row in governance if row["kind"] == "runtime_attempt_started"]
        self.assertEqual(attempts, [], "a transport nobody heard must not fail over to openai")
        self.assertEqual(completed.returncode, 0, completed.stderr[-3000:])
        self.assertEqual(self.ai.derive_request_state(request_id=self.request["request_id"], base_dir=self.tools), "PENDING")
        decisions = [row["details"] for row in governance if row["kind"] == "runtime_admission_unavailable"]
        self.assertEqual(len(decisions), 1, completed.stderr[-2000:])
        self.assertEqual((decisions[0]["reason"], decisions[0]["halting_provider"]), ("provider_undecided", "zai"))
        rows = {row["provider"]: row for row in decisions[0]["candidate_observations"]}
        from aria_kernel.status_probe import STATUS_PROBE_ATTEMPTS

        self.assertEqual((rows["anthropic"]["decision"], rows["anthropic"]["status_reason"]),
                         ("unavailable", "managed_session_logged_out"))
        self.assertEqual(rows["zai"]["decision"], "undecided")
        # A transport nobody heard establishes nothing about the vendor and
        # is never a control-binding failure: whichever arm observed it (the
        # probe's own transport verdict, or the exception the transport
        # raises before a request is made), the controls are not
        # "unavailable" — that word halts the ladder as a host gap.
        self.assertNotEqual(rows["zai"]["controls"]["status"], "unavailable", rows["zai"]["controls"])
        self.assertEqual(rows["zai"]["probe"]["attempts"], STATUS_PROBE_ATTEMPTS)
        self.assertTrue(all("transport" in reason or "refused" in reason.lower() or "connect" in reason.lower()
                            for reason in rows["zai"]["probe"]["undecided_reasons"]),
                        rows["zai"]["probe"])

    def test_an_unusable_sandbox_halts_the_ladder_by_name(self) -> None:
        self._install_scripted_claude(("answer",))
        self._install_unusable_bwrap()
        completed = self._run_executor()
        governance = self._governance()
        # The defect, first: a decided-available auth with unbindable
        # controls was neither eligible nor undecided, so the ladder moved
        # past anthropic on a host fact that is not an auth reason.
        attempts = [row["details"] for row in governance if row["kind"] == "runtime_attempt_started"]
        self.assertEqual([(row["provider"], row["model"]) for row in attempts], [],
                         "a missing sandbox is the host's fault, never a reason to run another vendor")
        decisions = [row["details"] for row in governance if row["kind"] == "runtime_admission_unavailable"]
        self.assertEqual(len(decisions), 1)
        # The defect's other face: with the Codex context failing on the
        # same broken sandbox, the pre-fix ladder passed anthropic and the
        # fleet read as `no_eligible_provider` — a decided fleet, when the
        # truth is a host that cannot bind anthropic's controls.
        self.assertEqual(decisions[0]["reason"], "provider_control_unavailable")
        self.assertEqual(decisions[0]["halting_provider"], "anthropic")
        self.assertEqual(completed.returncode, 0, completed.stderr[-3000:])
        request_id = self.request["request_id"]
        self.assertEqual(self.ai.derive_request_state(request_id=request_id, base_dir=self.tools), "PENDING")
        self.assertFalse((self.tools / "agent-invocations/claims.jsonl").exists() and self._claims())
        from aria_kernel.status_probe import STATUS_PROBE_ATTEMPTS

        self.assertEqual(decisions[0]["eligible_routes"], [])
        rows = {row["provider"]: row for row in decisions[0]["candidate_observations"]}
        self.assertEqual((rows["anthropic"]["decision"], rows["anthropic"]["status_reason"], rows["anthropic"]["controls"],
                          rows["anthropic"]["probe"]["attempts"]),
                         ("available", "managed_session_logged_in",
                          {"status": "unavailable", "reason": "sandbox_unavailable"}, 1))
        # The Codex context fails on the same broken sandbox before its
        # probe: undecided (the vendor was never asked), controls
        # unavailable, retried within the bound, recorded — never the one
        # that decides an admission anthropic already halted.
        self.assertEqual((rows["openai"]["decision"], rows["openai"]["controls"]["status"],
                          rows["openai"]["status_reason"], rows["openai"]["probe"]["attempts"]),
                         ("undecided", "unavailable", "SandboxUnavailable", STATUS_PROBE_ATTEMPTS))
        summary = json.loads((self.runner_temp / f"dispatch-result-{request_id}.json").read_text(encoding="utf-8"))
        self.assertEqual((summary["outcome"], summary["failure_class"], summary["retryable"], summary["failure_detail_code"]),
                         ("refused", "harness_unavailable", True, "provider_control_unavailable"))

    def test_the_planner_hook_releases_an_undecided_admission_and_backs_off(self) -> None:
        from aria_kernel import planner_dispatch_hook as hook

        self._install_scripted_claude(_STALL_THROUGHOUT)
        request_id = self.request["request_id"]
        with patch.dict(os.environ, self.environment, clear=True):
            result = hook.dispatch_one_pending_planner_request(
                base_dir=self.tools, agent_id="planner-hook:trial-eleven",
                planner_roles=("evidence_judgment",),
            )
        governance = self._governance()
        # The defect, first: on the pre-fix fleet the stalled anthropic row
        # was read as a refusal and this attempt ran on openai/gpt-6-astra.
        attempts = [row["details"] for row in governance if row["kind"] == "runtime_attempt_started"]
        self.assertEqual([(row["provider"], row["model"]) for row in attempts], [],
                         "nothing may run on any vendor behind a probe that did not answer")
        from aria_kernel.release_reason import NATIVE_RUNTIME_PROVIDER_UNDECIDED
        from aria_kernel.status_probe import STATUS_PROBE_ATTEMPTS, STATUS_PROBE_BACKOFF_SECONDS

        self.assertEqual(result["status"], hook.PROVIDER_UNDECIDED_STATUS, result)
        self.assertEqual(result["exit_code"], 0, result["stderr_redacted"][-3000:])
        self.assertEqual(result["request_id"], request_id)
        self.assertEqual(self._status_attempts(), STATUS_PROBE_ATTEMPTS, "three real stalls, each cut at the cap")
        self.assertEqual(self.ai.derive_request_state(request_id=request_id, base_dir=self.tools), "REQUEUED")
        claims = self._claims()
        self.assertEqual(len([row for row in claims if row.get("event") == "claimed"]), 1)
        released = [row for row in claims if row.get("event") == "released"]
        self.assertEqual([row["reason"] for row in released], [NATIVE_RUNTIME_PROVIDER_UNDECIDED])
        self.assertEqual((released[0]["reason_code"], released[0]["fault_domain"]),
                         ("NATIVE_RUNTIME_PROVIDER_UNDECIDED", "harness"))
        self.assertEqual(self.ai._request_fault_requeue_count(claims, request_id), 0, "a stalled host is not the request's fault")
        self.assertIn("planner_dispatch_provider_undecided", [row["kind"] for row in governance])
        decisions = [row["details"] for row in governance if row["kind"] == "runtime_admission_unavailable"]
        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0]["halting_provider"], "anthropic")
        anthropic = next(row for row in decisions[0]["candidate_observations"] if row["provider"] == "anthropic")
        self.assertEqual((anthropic["decision"], anthropic["status_reason"], anthropic["status_exit_code"]),
                         ("undecided", "status_timeout", None))
        self.assertEqual(anthropic["status_command"], ["claude", "auth", "status", "--json"])
        self.assertEqual(anthropic["probe"], {"attempts": STATUS_PROBE_ATTEMPTS,
                                              "undecided_reasons": ["status_timeout"] * STATUS_PROBE_ATTEMPTS,
                                              "backoff_seconds": sum(STATUS_PROBE_BACKOFF_SECONDS)})
        openai = next(row for row in decisions[0]["candidate_observations"] if row["provider"] == "openai")
        self.assertEqual(openai["decision"], "available")
        self.assertEqual(decisions[0]["eligible_routes"], [])


if __name__ == "__main__":
    unittest.main()
