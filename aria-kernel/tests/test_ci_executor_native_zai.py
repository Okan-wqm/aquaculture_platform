"""The Z.ai transport on the executor's native lane — real claim, real submit, fake vendor.

Same shape as the native Codex verification in test_ci_executor_live_path_smoke:
the ACTUAL ci_executor entry runs as a child, the ACTUAL kernel CLI claims and
submits, and the only declared substitute is the vendor — a local
``http.server`` standing in for api.z.ai, reached through the module's real
``urllib`` transport. No CLI binary exists on PATH at all, so the only provider
the fleet can admit is Z.ai, through the kernel's own transport.

What this pins, one property per test:

* A named credential boundary (a 0600 key file) plus a vendor that answers
  the probe admits the Z.ai route; the request is claimed, the prompt the
  kernel rendered reaches the vendor as the user turn under Bearer auth, the
  vendor's JSON reply becomes the sealed ``aria/agent-response/v1`` result,
  the attempt/usage/finished rows carry the Z.ai identity, and the request is
  ACCEPTED.
* The secret appears NOWHERE the kernel writes: not in the tools root, not in
  the transcript, not in the sealed output, not in any governance row.
* A vendor that rejects the probe (401) leaves the request PENDING with a
  ``runtime_admission_unavailable`` row naming the Z.ai observation — no
  claim, no attempt, no fabricated result.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
_KERNEL_DIR = _REPO_ROOT / "aria-kernel"
for _path in (_POC_DIR, _KERNEL_DIR):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

# Module reference, not a class import: unittest would otherwise collect the
# fixture class's own tests a second time under this module.
from tests import test_ci_executor_live_path_smoke as _smoke  # noqa: E402

SECRET = "zai-fixture-secret-9f3c1e2a-not-a-real-key"


class _Vendor:
    def __init__(self) -> None:
        self.script: list[tuple[int, dict]] = []
        self.received: list[dict] = []
        self._server: ThreadingHTTPServer | None = None

    @property
    def base_url(self) -> str:
        assert self._server is not None
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    def start(self) -> "_Vendor":
        vendor = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                vendor.received.append({"path": self.path, "authorization": self.headers.get("Authorization"),
                                        "json": json.loads(body.decode("utf-8"))})
                status, payload = vendor.script.pop(0) if vendor.script else (500, {"error": {"code": "0", "message": "unscripted"}})
                raw = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *args: object) -> None:
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self._server.serve_forever, daemon=True).start()
        return self

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()


def _completion(content: str, *, prompt_tokens: int, completion_tokens: int) -> dict:
    return {"id": "chatcmpl-native-zai-fixture", "model": "glm-5.3",
            "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": content}}],
            "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens}}


class NativeZaiLane(unittest.TestCase):
    def setUp(self) -> None:
        _smoke.NativeAdaptiveAdmissionTests.setUp(self)  # the real mint/binding fixture, shared
        self.vendor = _Vendor().start()
        self.addCleanup(self.vendor.stop)
        key_file = self.root / "secrets" / "zai.key"
        key_file.parent.mkdir()
        key_file.write_text(SECRET + "\n", encoding="utf-8")
        key_file.chmod(0o600)
        self.key_file = key_file
        _smoke.NativeAdaptiveAdmissionTests._enable_adaptive_policy(self)
        policy_path = self.repo / "aria-config/genesis_policy.json"
        policy = json.loads(policy_path.read_text(encoding="utf-8"))
        policy["executor"]["adaptive_runtime"]["monetary_admission"] = "managed_subscription"
        policy_path.write_text(json.dumps(policy) + "\n", encoding="utf-8")
        # Real kernel CLI children import the same source (claim/submit are
        # not replaced); no claude/codex binary exists anywhere on PATH.
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
        # The child needs git (task binding) and python3; it must NOT find a
        # claude or codex binary — the fixture bin dir holds only python3 and
        # os.defpath carries neither CLI on a CI runner or this host's default path.
        self.environment = {
            **os.environ, "PATH": str(self.binary_dir) + os.pathsep + os.defpath,
            "ARIA_WORKSPACE_ROOT": str(self.repo),
            "MAX_TIMEOUT_SECONDS": "30",
            "ARIA_ZAI_API_KEY_FILE": str(key_file), "ARIA_ZAI_ENDPOINT": self.vendor.base_url,
        }
        self.environment.pop("ARIA_ZAI_API_KEY", None)

    def _run_executor(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-B", str(_POC_DIR / "ci_executor.py"), self.request["request_id"], "aria-evidence-judge"],
            cwd=self.repo, env=self.environment, capture_output=True, text=True, timeout=120,
        )

    def _assert_secret_nowhere(self) -> None:
        for root in (self.tools, self.repo / "aria-tools", Path(self.request["expected_output_path"]).parent):
            if not root.exists():
                continue
            for path in root.rglob("*"):
                if path.is_file():
                    self.assertNotIn(SECRET.encode("utf-8"), path.read_bytes(), f"secret leaked into {path}")

    def test_a_named_key_file_and_an_answering_vendor_admit_and_complete_the_request(self) -> None:
        from aria_kernel.budget import read_cost_attribution
        from aria_kernel.ledger import load_declared_jsonl

        response = {
            "satisfaction_matrix": [{"id": "provider-source", "verdict": "satisfied",
                                     "evidence_refs": ["src/model_fleet.py:1"],
                                     "evidence": "the module docstring names the fleet"}],
            "evidence_refs": ["src/model_fleet.py:1"],
            # The fixture request is an evidence_judgment; the judge contract
            # (judgment_bridge.judge_response_contract_errors) is enforced
            # before submit, so the reply carries a binary verdict, the run
            # identity it judges, and the judge's own identity.
            "details": {
                "ordinary_vendor_observation": "fixture",
                "verdict": {"verdict": "true_positive", "judge_id": "aria-evidence-judge",
                            "tool_id": "fixture-tool", "run_id": "fixture-run", "finding_id": "F-001",
                            "confidence": 0.9, "rationale": "the cited line declares the fleet"},
            },
        }
        self.vendor.script.append((200, _completion("OK", prompt_tokens=7, completion_tokens=1)))  # probe
        self.vendor.script.append((200, _completion(json.dumps(response), prompt_tokens=1200, completion_tokens=90)))
        completed = self._run_executor()
        governance = load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
        self.assertEqual(completed.returncode, 0, completed.stderr + json.dumps(
            [row for row in governance if row["kind"].startswith("runtime_")], sort_keys=True))
        self.assertEqual(self.ai.derive_request_state(request_id=self.request["request_id"], base_dir=self.tools), "ACCEPTED")

        # The wire: probe then the run, both Bearer-authenticated with the file's secret,
        # the run carrying the kernel-rendered prompt as the user turn.
        self.assertEqual([r["path"] for r in self.vendor.received], ["/chat/completions", "/chat/completions"])
        self.assertTrue(all(r["authorization"] == "Bearer " + SECRET for r in self.vendor.received))
        run = self.vendor.received[1]["json"]
        self.assertEqual(run["model"], "glm-5.3")
        self.assertEqual([m["role"] for m in run["messages"]], ["system", "user"])
        rows = self.ai.list_agent_invocation_requests(base_dir=self.tools)
        rendered = self.ai.render_invocation_prompt(self.ai.fuse_prompt_envelope(rows[0]))
        self.assertEqual(run["messages"][1]["content"], rendered)
        self.assertEqual("sha256:" + hashlib.sha256(rendered.encode("utf-8")).hexdigest(), self.request["prompt_hash"])

        # The sealed result and the evidence rows carry the Z.ai identity.
        output = json.loads(Path(self.request["expected_output_path"]).read_text(encoding="utf-8"))
        self.assertEqual(output["role"], "evidence_judgment")
        self.assertEqual(output["details"]["agent_dispatch_model"], "glm-5.3")
        self.assertEqual(output["satisfaction_matrix"][0]["verdict"], "satisfied")
        attempts = [row["details"] for row in governance if row["kind"] == "runtime_attempt_started"
                    and row["details"].get("request_id") == self.request["request_id"]]
        self.assertEqual(len(attempts), 1)
        self.assertEqual((attempts[0]["provider"], attempts[0]["runtime"], attempts[0]["model"]), ("zai", "zai", "glm-5.3"))
        self.assertEqual(attempts[0]["auth_method"], "subscription_api_key")
        self.assertEqual(attempts[0]["monetary_admission"], "managed_subscription")
        finished = [row["details"] for row in governance if row["kind"] == "runtime_attempt_finished"
                    and row["details"].get("request_id") == self.request["request_id"]]
        self.assertEqual(len(finished), 1)
        self.assertEqual(finished[0]["provider_session_provenance"], "http_response_id")
        self.assertEqual(finished[0]["provider_session_ids"], ["chatcmpl-native-zai-fixture"])
        self.assertEqual(finished[0]["exit_code"], 200)
        self.assertEqual(finished[0]["result_admission"], "pending_native_submit")
        usage = [row for row in read_cost_attribution(base_dir=self.tools) if row.get("cycle_id") == self.request["cycle_id"]]
        self.assertEqual(len(usage), 1)
        self.assertEqual((usage[0]["model"], usage[0]["input_tokens"], usage[0]["output_tokens"]), ("glm-5.3", 1200, 90))
        self.assertGreater(usage[0]["estimated_usd"], 0)
        admissions = [row["details"] for row in governance if row["kind"] == "runtime_admission_unavailable"]
        self.assertEqual(admissions, [])
        self._assert_secret_nowhere()

    def test_a_vendor_that_rejects_the_probe_keeps_the_request_pending(self) -> None:
        from aria_kernel.ledger import load_declared_jsonl

        self.vendor.script.append((401, {"error": {"code": "1002", "message": "invalid api key"}}))
        completed = self._run_executor()
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(self.ai.derive_request_state(request_id=self.request["request_id"], base_dir=self.tools), "PENDING")
        self.assertEqual(len(self.vendor.received), 1, "exactly the probe; no run without admission\n" + completed.stderr)
        governance = load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
        self.assertFalse(any(row["kind"] == "runtime_attempt_started" for row in governance))
        decisions = [row["details"] for row in governance if row["kind"] == "runtime_admission_unavailable"]
        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0]["eligible_routes"], [])
        zai = next(row for row in decisions[0]["candidate_observations"] if row["provider"] == "zai")
        self.assertEqual((zai["runtime"], zai["model"]), ("zai", "glm-5.3"))
        self.assertEqual(zai["auth_observation"], "unavailable")
        self.assertEqual(zai["status_reason"], "auth_rejected_http_401")
        self.assertEqual(zai["status_exit_code"], 401)
        self.assertEqual(zai["auth_method"], "subscription_api_key")
        self.assertEqual(zai["credential_source"], "file")
        self.assertEqual(zai["controls"]["status"], "available")
        self.assertFalse(Path(self.request["expected_output_path"]).exists())
        self._assert_secret_nowhere()

    def test_a_group_readable_key_file_is_refused_before_any_vendor_call(self) -> None:
        from aria_kernel.ledger import load_declared_jsonl

        self.key_file.chmod(0o640)
        completed = self._run_executor()
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(self.vendor.received, [], "no request may leave the host on a refused boundary")
        self.assertEqual(self.ai.derive_request_state(request_id=self.request["request_id"], base_dir=self.tools), "PENDING")
        governance = load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
        decisions = [row["details"] for row in governance if row["kind"] == "runtime_admission_unavailable"]
        self.assertEqual(len(decisions), 1)
        zai = next(row for row in decisions[0]["candidate_observations"] if row["provider"] == "zai")
        self.assertEqual(zai["auth_observation"], "unavailable")
        self.assertEqual(zai["status_reason"], "credential_file_permissions")
        self.assertEqual(zai["controls"]["status"], "unavailable")
        self._assert_secret_nowhere()


if __name__ == "__main__":
    unittest.main()
