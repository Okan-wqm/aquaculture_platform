"""ARIA-HIGH-434 — an implementation runs on Z.ai while Claude is cooled, and is delivered the same way.

The production shape end to end: the ACTUAL executor child (`ci_executor.py`)
on the native lane under the managed-subscription policy production runs
(`aria-config/genesis_policy.json`: `adaptive_runtime.enabled`), in the
per-request worktree the drain adds, holding the implementer's signing
identity, under the REAL bwrap room, with the ACTUAL kernel claiming,
delivering (apply gate, push, PR) and bridging. The fixture is
`test_executor_implementation_identity`'s, borrowed whole; the declared
substitutes are the same (`npx`/`npm`/`node`/`gh` fixtures, a bare remote)
plus the vendor: a local HTTP server standing in for api.z.ai, reached by the
module's own urllib transport, scripting the turns a model would take.

Anthropic is cooled by the row the executor's own credit arm writes for a
spent window (ARIA-HIGH-425). The `claude` binary on PATH answers only the
pre-claim gate's `--version` / `auth status`; a model spawn of it would be
recorded and fail. One property per test:

* while Anthropic is cooled, the native admission admits the implementer on
  zai/glm-5.3 without probing Anthropic; the vendor's tool calls stand on the
  kernel-made branch, edit the plan's file and commit through the room's git
  containment; the commit verifies against the key the executor minted; the
  apply gate runs and records the suite at the tip; the branch is pushed and
  the PR opened; the request is ACCEPTED and the plan IMPLEMENTATION_RECORDED;
  the attempt, transcript, cost row and finished row carry the Z.ai identity;
  `claude` never ran a model; the key is in no file the kernel wrote and was
  sent only as the vendor's Authorization header;
* a denied command inside that run is refused by the hook's own verdict and
  the run still delivers;
* a host whose bwrap cannot build the room admits no writer on zai: the
  ladder halts as `provider_control_unavailable` (zai: `sandbox_unavailable`),
  exactly as the claude arm halts — no claim, no identity, only the probe
  reached the vendor.
"""
from __future__ import annotations

import json
import os
import shlex
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
for _path in (_POC_DIR, _REPO_ROOT / "aria-kernel"):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

# Module references, not class imports: unittest would otherwise collect the
# borrowed fixture's own tests a second time under this module.
from tests import test_executor_implementation_identity as _identity  # noqa: E402
from tests.test_ci_executor_native_zai import _Vendor  # noqa: E402

SECRET = "zai-e2e-secret-7b2e19c4-not-a-real-key"
_BORROWED = (
    "_start_egress_proxy", "_suite_fixture_body", "_install_fixture_executable", "_suite_calls", "_run_child",
    "_run_in_request_worktree", "_signing_config", "_governance_rows", "_governance", "_plan_state", "_plan_fold",
    "_change_committed", "_claim_id", "_apply_action", "_human_required", "_submitted_envelope", "_registered",
    "_verify_against_registry", "_diagnostic", "_gate_calls", "_gh_calls", "_push_calls", "_claim_rows",
)
_NATIVE_POLICY = {"adaptive_runtime": {
    "schema_version": 1, "enabled": True, "policy_id": "aria/adaptive-runtime/v1",
    "provider_cooldown_seconds": 900, "recheck_timeout_seconds": 20, "max_attempts_per_dispatch": 2,
    "scarcity_judgment_mode": "independent_sessions", "monetary_admission": "managed_subscription",
}}


def _turn(calls: list[tuple[str, str, dict]], *, rid: str) -> dict:
    return {"id": rid, "model": "glm-5.3", "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {
        "role": "assistant", "content": "",
        "tool_calls": [{"id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}
                       for call_id, name, args in calls]}}], "usage": {"prompt_tokens": 900, "completion_tokens": 60}}


def _final(content: str, *, rid: str) -> dict:
    return {"id": rid, "model": "glm-5.3", "choices": [{"index": 0, "finish_reason": "stop", "message": {
        "role": "assistant", "content": content}}], "usage": {"prompt_tokens": 1200, "completion_tokens": 300}}


class TheImplementerRunsOnZaiWhileClaudeIsCooled(unittest.TestCase):
    # The fixture's helpers, borrowed as written (staticmethods included);
    # the class itself is never bound here, so it is collected once.
    locals().update({name: vars(_identity.ExecutorImplementationIdentityTests)[name] for name in _BORROWED})

    def setUp(self) -> None:
        original = _identity.make_repo_with_initial_commit

        def with_the_production_policy(root: Path, files: dict[str, str], **kwargs: object) -> Path:
            # The fixture commits its operator policy with the tree; this one
            # adds the native lane production runs, in the same commit.
            files = dict(files)
            policy = json.loads(files["aria-config/genesis_policy.json"])
            policy["executor"] = _NATIVE_POLICY
            files["aria-config/genesis_policy.json"] = json.dumps(policy) + "\n"
            return original(root, files, **kwargs)

        with patch.object(_identity, "make_repo_with_initial_commit", with_the_production_policy):
            _identity.ExecutorImplementationIdentityTests.setUp(self)
        self.vendor = _Vendor().start()
        self.addCleanup(self.vendor.stop)
        secrets = self.root / "secrets"
        secrets.mkdir()
        self.key_file = secrets / "zai.key"
        self.key_file.write_text(SECRET + "\n", encoding="utf-8")
        self.key_file.chmod(0o600)
        self.environment.update({"ARIA_ZAI_API_KEY_FILE": str(self.key_file), "ARIA_ZAI_ENDPOINT": self.vendor.base_url})
        # The pre-claim gate's `claude --version` / `auth status`, answered;
        # anything else is a model spawn, recorded and failed.
        self.claude_log = self.root / "claude-spawns.jsonl"
        self._install_fixture_executable("claude", (
            "import json, sys\n"
            "argv = sys.argv[1:]\n"
            "if argv == ['--version']:\n"
            "    print('2.1.269 (Claude Code)'); raise SystemExit(0)\n"
            "if argv[:3] == ['auth', 'status', '--json']:\n"
            f"    print(json.dumps({_identity._STATUS!r})); raise SystemExit(0)\n"
            f"open({str(self.claude_log)!r}, 'a').write(json.dumps(argv) + '\\n')\n"
            "raise SystemExit(1)\n"
        ))
        self._cool_anthropic()

    def _cool_anthropic(self) -> None:
        """The row the executor's credit arm writes for a `rejected` reading
        (ARIA-HIGH-425), its reset a day ahead."""
        import claude_runtime
        from aria_kernel.provider_cooldown import record_provider_cooldown

        reset = int(datetime.now(timezone.utc).timestamp()) + 86400
        detection = claude_runtime.extract_rate_limit_exhaustion(({"type": "rate_limit_event", "rate_limit_info": {
            "status": "rejected", "resetsAt": reset, "rateLimitType": "seven_day", "utilization": 1.0,
            "isUsingOverage": False, "unifiedWindows": {"seven_day": {"utilization": 1.0, "resetsAt": reset}}}},))
        record_provider_cooldown(self.tools, provider="anthropic", model="opus", cooldown_seconds=900,
                                 request_id="AIR-prior", claim_id="CL-prior", detection=detection)

    def _script(self, *, extra_denied: bool = False) -> None:
        must_satisfy = [item["id"] for item in self.request["must_satisfy"]]
        source = _identity.SOURCE
        envelope = {"satisfaction_matrix": [{"id": item, "verdict": "satisfied", "evidence_refs": [f"{source}:1"]}
                                            for item in must_satisfy],
                    "evidence_refs": [f"{source}:1"], "details": {"implementation": {}}}
        self.vendor.script = [
            # The admission's probe: one token, the route is live.
            (200, {"id": "probe", "model": "glm-5.3", "choices": [{"index": 0, "finish_reason": "stop", "message": {
                "role": "assistant", "content": "OK"}}], "usage": {"prompt_tokens": 9, "completion_tokens": 1}}),
            (200, _turn([("t1", "Bash", {"command": "git branch --show-current"}),
                         ("t2", "Bash", {"command": "git rev-parse HEAD"})], rid="r1")),
            (200, _turn([("t3", "Write", {"file_path": source, "content": "export const sampleIntervalMs = 30000;\n"}),
                         *([("t4", "Bash", {"command": "git push origin HEAD"})] if extra_denied else []),
                         ("t5", "Bash", {"command": f"git add {source}"})], rid="r2")),
            (200, _turn([("t6", "Bash", {"command": "git commit -m " + shlex.quote(self.message)})], rid="r3")),
            (200, _final(json.dumps(envelope), rid="r4")),
        ]

    def _assert_delivered_on_zai(self, completed) -> dict:
        self.assertEqual(completed.returncode, 0, self._diagnostic(completed))
        self.assertEqual(self.ai.derive_request_state(request_id=self.request_id, base_dir=self.tools), "ACCEPTED")
        # Admitted on zai, Anthropic refused by its cooldown without a probe.
        from aria_kernel.native_admission import COOLDOWN_STATUS_REASON

        started = [row["details"] for row in self._governance("runtime_attempt_started")]
        self.assertEqual([(row["provider"], row["runtime"], row["model"]) for row in started],
                         [("zai", "zai", "glm-5.3")])
        candidates = {row["provider"]: row for row in started[0]["admission"]["candidate_observations"]}
        self.assertEqual(list(candidates), ["anthropic", "zai"], "the writer ladder, Claude first")
        self.assertEqual((candidates["anthropic"]["status_reason"], candidates["anthropic"]["probe"]["attempts"]),
                         (COOLDOWN_STATUS_REASON, 0))
        self.assertFalse(self.claude_log.exists(), "the claude CLI never ran a model")
        finished = [row["details"] for row in self._governance("runtime_attempt_finished")]
        self.assertEqual(len(finished), 1, finished)
        self.assertEqual((finished[0]["result_admission"], finished[0]["provider_session_ids"]),
                         ("pending_native_submit", ["r1", "r2", "r3", "r4"]))
        self.assertTrue(finished[0]["usage_ledger_hash"], "a cost row was written for the summed usage")
        # The commit is the kernel's: signed with the minted key, published
        # from the quarantine, gated, pushed, opened.
        envelope = self._submitted_envelope()
        implementation = envelope["details"]["implementation"]
        head = implementation["branch_tip_sha"]
        self.assertTrue(self._verify_against_registry(head, implementation["signer_key_fp"]))
        published = self._governance("implementation_quarantine_published")
        self.assertEqual([row["details"]["refs_published"] for row in published], [[self.ids["branch"]]])
        self.assertEqual(_identity._git(["rev-parse", f"refs/heads/{self.ids['branch']}"], cwd=self.remote).stdout.strip(), head)
        gh_calls = self._gh_calls()
        self.assertEqual([call["argv"][:2] for call in gh_calls], [["pr", "create"]])
        from aria_kernel.validation_suite import CANONICAL_VALIDATION_COMMANDS_EXECUTABLE

        self.assertEqual([(row["command"], row["exit_code"]) for row in implementation["validation_results"]],
                         [(command, 0) for command in CANONICAL_VALIDATION_COMMANDS_EXECUTABLE])
        self.assertEqual({call["head"] for call in self._gate_calls(implementation)}, {head},
                         "the apply gate ran the suite at the agent's tip")
        self.assertEqual(self._plan_state(), "IMPLEMENTATION_RECORDED")
        self.assertEqual(self._human_required(), [])
        # The transcript the executor published is the loop's stream-json.
        transcript = Path(self.request["expected_output_path"]).with_suffix(".transcript.jsonl")
        import claude_runtime

        events = claude_runtime.parse_claude_jsonl(transcript.read_text(encoding="utf-8"))
        self.assertEqual(events[0]["runtime"], "zai_tool_loop")
        self.assertEqual(claude_runtime.extract_usage(events), {"input_tokens": 3900, "output_tokens": 480})
        # The key: sent as the vendor's Authorization header, and nowhere else.
        self.assertTrue(all(request["authorization"] == "Bearer " + SECRET for request in self.vendor.received))
        for path in [*self.tools.rglob("*"), transcript, Path(self.request["expected_output_path"])]:
            if path.is_file():
                self.assertNotIn(SECRET.encode(), path.read_bytes(), path)
        self.assertNotIn(SECRET, completed.stderr + completed.stdout)
        return envelope

    def test_an_implementation_is_delivered_on_zai_while_anthropic_is_cooled(self) -> None:
        self._script()
        completed, _worktree = self._run_in_request_worktree()
        self._assert_delivered_on_zai(completed)
        tool_answers = {message["tool_call_id"]: message["content"] for request in self.vendor.received
                        for message in request["json"].get("messages", []) if message.get("role") == "tool"}
        self.assertEqual(tool_answers["t1"].strip(), self.ids["branch"], "the room stood on the kernel-made branch")
        self.assertEqual(tool_answers["t2"].strip(), self.base_sha)

    def test_a_denied_command_in_the_run_gets_the_hooks_verdict_and_the_run_still_delivers(self) -> None:
        from aria_kernel.hooks import HOOK_DECISIONS_RELPATH
        from aria_kernel.ledger import load_declared_jsonl

        self._script(extra_denied=True)
        completed, _worktree = self._run_in_request_worktree()
        self._assert_delivered_on_zai(completed)
        rows = [row for row in load_declared_jsonl(self.tools.joinpath(*HOOK_DECISIONS_RELPATH),
                                                   expected_surface="hook_decisions")
                if row["request_id"] == self.request_id and row["tool_use_id"] == "t4"]
        self.assertEqual([(row["decision"], row["reason"].split(":", 2)[:2]) for row in rows],
                         [("deny", ["command_policy_deny", "BashDenylistHit"])])

    def test_a_host_that_cannot_build_the_room_admits_no_writer_on_zai(self) -> None:
        """The zai arm of the admission asks what the claude arm asks: can
        this host contain the writer? A bwrap that cannot build its
        namespaces (the fixture's, first on PATH) says no."""
        self._install_fixture_executable("bwrap", "import sys\nsys.exit(1)\n")
        self._script()
        completed, _worktree = self._run_in_request_worktree()
        self.assertEqual(self.ai.derive_request_state(request_id=self.request_id, base_dir=self.tools), "PENDING",
                         self._diagnostic(completed))
        refused = [row["details"] for row in self._governance("runtime_admission_unavailable")]
        self.assertEqual([(row["reason"], row["halting_provider"]) for row in refused],
                         [("provider_control_unavailable", "zai")])
        zai = next(row for row in refused[0]["candidate_observations"] if row["provider"] == "zai")
        self.assertEqual((zai["decision"], zai["controls"]), ("available", {"status": "unavailable",
                                                                           "reason": "sandbox_unavailable"}))
        self.assertEqual((self._claim_rows(), self._registered()), ([], []), "no claim, no identity minted")
        self.assertEqual(len(self.vendor.received), 1, "only the admission's probe reached the vendor")


if __name__ == "__main__":
    unittest.main()
