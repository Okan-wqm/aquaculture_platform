"""ARIA-HIGH-107 on the executor's native lane — real claim, real release, scripted CLIs.

The trial-eleven shape (2026-09-12 20:42Z, dispatch 03 of chain A): a
provider's status probe did not answer inside its cap and the fleet read the
stalled row as a refusal, so the primary planner ran on another vendor. Same
fixture as the native Claude lane (`test_ci_executor_native_claude`): the
ACTUAL `ci_executor` entry runs as a child, the ACTUAL kernel claims,
releases and submits; the only declared substitutes are the `claude` and
`codex` binaries — scripts on the bound fixture path.

ARIA-MEDIUM-563: the Anthropic route no longer probes a CLI. Its status is the
kernel's credential boundary (the gateway's token file), read locally and
always DECIDED — so the stall class is exercised here through the Z.ai
transport (a closed local port: nobody heard), the one live probe on this
lane that can go unanswered.

What this pins, one property per test:

* No kernel token for Claude is the boundary's DECIDED no — one attempt, no
  retry — and a read-only role fails over to openai on it (the one class
  the operator decision allows); the attempt row lands on
  openai/gpt-6-astra with anthropic's refusal beside it.
* A Z.ai transport nobody heard is UNDECIDED, retried within the bound, and
  halts the ladder as `provider_undecided(zai)`: NO openai route although
  openai is up, the request stays PENDING with no claim and no attempt
  burned, and the child's summary names the refusal, retryable.
* Through the real planner dispatch hook with that transport: the claim the
  hook took is released under `native_runtime_provider_undecided` (harness:
  budget intact), the request is REQUEUED, nothing ran on any vendor, and
  the hook reports `provider_undecided` so the daemon backs off.
* A host whose containment is unusable (a `bwrap` that cannot build its
  namespaces) with the kernel token present: the credential is there, THIS
  host cannot bind the route's controls. Not an auth reason: the ladder
  halts as `provider_control_unavailable` naming anthropic, admits nobody,
  burns nothing, and the summary says `harness_unavailable`, retryable.
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

class ProviderUndecidedLane(unittest.TestCase):
    """The native Claude lane's fixture, composed rather than inherited so the
    lane's own cases do not re-run under a fleet that also has Codex."""

    def setUp(self) -> None:
        _lane.NativeClaudeLane.setUp(self)
        _lane.NativeClaudeLane._install_claude(self)
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

    def _remove_kernel_token(self) -> None:
        # The host may still hold a login; the route asks the kernel's
        # boundary, which now names no token.
        self.environment.pop("ARIA_CLAUDE_OAUTH_TOKEN_FILE")

    def _unheard_zai(self) -> None:
        """A Z.ai key and an endpoint on a closed local port: nobody hears."""
        import socket

        key = self.root / "zai.key"
        key.write_text("fixture-credential-never-sent\n", encoding="utf-8")
        key.chmod(0o600)
        with socket.socket() as probe:  # allowlist-external-network: binds 127.0.0.1:0 only to learn a closed local port; nothing is sent anywhere
            probe.bind(("127.0.0.1", 0))
            closed_port = probe.getsockname()[1]
        self.environment["ARIA_ZAI_API_KEY_FILE"] = str(key)
        self.environment["ARIA_ZAI_ENDPOINT"] = f"http://127.0.0.1:{closed_port}"

    def _install_unusable_bwrap(self) -> None:
        # bwrap is on PATH but cannot build the namespaces the probe asks
        # for (the shape of a host with user namespaces disabled): the
        # kernel's sandbox probe fails and `sandbox_backend()` is None.
        executable = self.fixture_bin / "bwrap"
        executable.write_text(f"#!{sys.executable}\nraise SystemExit(1)\n", encoding="utf-8")
        executable.chmod(0o755)

    def _run_executor(self):
        return _lane.NativeClaudeLane._run_executor(self)

    def _governance(self) -> list[dict]:
        from aria_kernel.ledger import load_declared_jsonl

        return load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")

    def _claims(self) -> list[dict]:
        from aria_kernel.ledger import load_declared_jsonl

        return load_declared_jsonl(self.tools / "agent-invocations/claims.jsonl",
                                   expected_surface="agent_invocation_claims")

    def test_no_kernel_token_is_decided_and_fails_over(self) -> None:
        self._remove_kernel_token()
        completed = self._run_executor()
        governance = self._governance()
        attempts = [row["details"] for row in governance if row["kind"] == "runtime_attempt_started"]
        self.assertEqual([(row["provider"], row["model"]) for row in attempts], [("openai", "gpt-6-astra")],
                         "an absent Claude credential is an AUTH fact: a read-only role fails over on it")
        admission = attempts[0]["admission"]
        anthropic = next(row for row in admission["candidate_observations"] if row["provider"] == "anthropic")
        # The row says WHY openai ran: the kernel's boundary refused, by name,
        # in one decided attempt — no CLI was asked.
        self.assertEqual((anthropic["auth_observation"], anthropic["status_reason"], anthropic["status_command"]),
                         ("unavailable", "claude_gateway_credential_absent", []))
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
        """Anthropic decided-unavailable (no kernel token) puts Z.ai first in
        contention; a Z.ai transport error (connection refused on a closed
        local port) is the stall class: UNDECIDED, retried within the bound,
        and the ladder halts as provider_undecided(zai) — never
        provider_control_unavailable (a host that could not bind its
        controls) and never a fail-over to openai on a vendor nobody heard."""
        self._remove_kernel_token()
        self._unheard_zai()
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
                         ("unavailable", "claude_gateway_credential_absent"))
        self.assertEqual((rows["openai"]["decision"], rows["openai"]["auth_method"], rows["openai"]["controls"]["status"]),
                         ("available", "chatgpt", "available"))
        self.assertEqual(decisions[0]["eligible_routes"], [], "openai is up and is NOT a route for this dispatch")
        self.assertFalse((self.tools / "agent-invocations/claims.jsonl").exists() and self._claims(),
                         "no claim is taken for an admission the fleet could not decide")
        request_id = self.request["request_id"]
        summary = json.loads((self.runner_temp / f"dispatch-result-{request_id}.json").read_text(encoding="utf-8"))
        # The summary agrees with the release (harness) and the hook's
        # back-off: a stalled host is not a policy the dispatch violated.
        self.assertEqual((summary["outcome"], summary["failure_class"], summary["retryable"], summary["failure_detail_code"]),
                         ("refused", "harness_unavailable", True, "provider_undecided"))
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
                         ("available", "claude_gateway_credential_present",
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

        self._remove_kernel_token()
        self._unheard_zai()
        request_id = self.request["request_id"]
        with patch.dict(os.environ, self.environment, clear=True):
            result = hook.dispatch_one_pending_planner_request(
                base_dir=self.tools, agent_id="planner-hook:trial-eleven",
                planner_roles=("evidence_judgment",),
            )
        governance = self._governance()
        # The defect, first: on the pre-fix fleet a stalled row was read as a
        # refusal and this attempt ran on openai/gpt-6-astra.
        attempts = [row["details"] for row in governance if row["kind"] == "runtime_attempt_started"]
        self.assertEqual([(row["provider"], row["model"]) for row in attempts], [],
                         "nothing may run on any vendor behind a probe that did not answer")
        from aria_kernel.release_reason import NATIVE_RUNTIME_PROVIDER_UNDECIDED
        from aria_kernel.status_probe import STATUS_PROBE_ATTEMPTS, STATUS_PROBE_BACKOFF_SECONDS

        self.assertEqual(result["status"], hook.PROVIDER_UNDECIDED_STATUS, result)
        self.assertEqual(result["exit_code"], 0, result["stderr_redacted"][-3000:])
        self.assertEqual(result["request_id"], request_id)
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
        self.assertEqual(decisions[0]["halting_provider"], "zai")
        zai = next(row for row in decisions[0]["candidate_observations"] if row["provider"] == "zai")
        self.assertEqual(zai["decision"], "undecided")
        self.assertEqual((zai["probe"]["attempts"], zai["probe"]["backoff_seconds"]),
                         (STATUS_PROBE_ATTEMPTS, sum(STATUS_PROBE_BACKOFF_SECONDS)))
        openai = next(row for row in decisions[0]["candidate_observations"] if row["provider"] == "openai")
        self.assertEqual(openai["decision"], "available")
        self.assertEqual(decisions[0]["eligible_routes"], [])


if __name__ == "__main__":
    unittest.main()
