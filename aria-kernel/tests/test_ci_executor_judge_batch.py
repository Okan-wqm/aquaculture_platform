"""Typed-judgment plan Phase 4b (ARIA-MEDIUM-163) — the batch judge child.

Same shape as test_ci_executor_native_zai: the ACTUAL `ci_executor.py
--judge-batch` entry runs as a child, the ACTUAL kernel CLI claims and
submits every member, and the only substitute is the vendor (a local
http.server standing in for api.z.ai). No CLI binary exists on PATH, so
the only provider the fleet can admit is Z.ai.

What this pins, one property per test:

* three minted judge requests (same role, agent, anchor) are served by ONE
  chat completion — the probe and the batch call are the only two POSTs,
  the batch call carries `response_format: json_object`, one fenced
  question per request — and the vendor's typed payload with one refused
  item yields two ACCEPTED requests and one released by name
  (`judge_batch_item_unanswered:value_not_in_options`, request-class), with
  three dispatch summaries, three attempt rows sharing the batch id, ONE
  cost row, and two folded `ai_judge` rows whose refs were materialized
  from indices (`evidence_selection: index`);
* the secret appears nowhere the kernel writes;
* a whole-call failure (the vendor answers 500) releases every member
  `judge_batch_call_failed:http_500` (harness-class) with three refusal
  summaries and no result row.
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

from tests import test_ci_executor_native_zai as _zai  # noqa: E402

SECRET = _zai.SECRET


class JudgeBatchLane(unittest.TestCase):
    def setUp(self) -> None:
        # The native Z.ai lane's fixture (vendor, key file, adaptive policy,
        # kernel copy, environment), called by name so its own tests are not
        # collected a second time under this module.
        _zai.NativeZaiLane.setUp(self)
        from tests._helpers.git_fixtures import _git

        policy_path = self.repo / "aria-config/genesis_policy.json"
        policy = json.loads(policy_path.read_text(encoding="utf-8"))
        policy["judgment_pipeline"] = {"judge_batch_size": 3, "judge_batch_runtimes": ["zai"],
                                       "judge_batch_max_input_tokens": 60000}
        policy_path.write_text(json.dumps(policy) + "\n", encoding="utf-8")
        target_sha = _git(["rev-parse", "HEAD"], cwd=self.repo).stdout.strip()
        self.requests = []
        for index in range(3):
            self.requests.append(self.ai.create_agent_invocation_request(
                target_agent="aria-evidence-judge", role="evidence_judgment",
                suggested_prompt="Judge whether the finding is a true_positive or false_positive.",
                must_satisfy=[{"id": "verdict", "description": "Return true_positive or false_positive with file:line evidence"}],
                allowed_scope=["src/**"], evidence_refs=["src/model_fleet.py:1"],
                convergence_id="s4-native-admission", cycle_id="s4-native-admission",
                target_sha=target_sha, context_repo_root=self.repo, base_dir=self.tools,
                tool_id="fixture-tool", run_id="fixture-run", finding_id=f"F-00{index}",
                judgment_group_id=f"judge:fixture-tool:fp{index}", finding_fingerprint=f"fp{index}",
            ))
        self.request_ids = [str(r["request_id"]) for r in self.requests]
        self.runner_temp = self.root / "runner-temp"
        self.runner_temp.mkdir()
        self.github_output = self.runner_temp / "github-output.txt"
        self.environment.update({"RUNNER_TEMP": str(self.runner_temp), "GITHUB_OUTPUT": str(self.github_output)})

    def _excerpt_quote(self) -> str:
        rows = {r["request_id"]: r for r in self.ai.list_agent_invocation_requests(base_dir=self.tools)}
        excerpts = rows[self.request_ids[0]].get("evidence_excerpts") or []
        content = str(excerpts[0]["content"]) if excerpts else ""
        return content.splitlines()[0][:60] if content else ""

    def _run_batch(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-B", str(_POC_DIR / "ci_executor.py"), "--judge-batch", "evidence_judgment",
             "aria-evidence-judge", *self.request_ids],
            cwd=self.repo, env=self.environment, capture_output=True, text=True, timeout=180,
        )

    def _payload(self, quote: str) -> str:
        from ci_executor_judge_batch import _batch_id

        answers = []
        for index, request_id in enumerate(self.request_ids):
            value = "maybe" if index == 1 else "true_positive"
            answers.append({
                "question_id": request_id, "primitive": "choice", "value": value,
                "probabilities": None if index == 1 else {"true_positive": 0.9, "false_positive": 0.1},
                "confidence": 0.9, "evidence": [{"index": 0, "quote": quote}],
                "rationale": "the cited line declares the fleet",
            })
        return json.dumps({"$schema": "aria/typed-judgment-batch/v1", "batch_id": _batch_id(self.request_ids),
                           "answers": answers})

    def _summaries(self) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for line in self.github_output.read_text(encoding="utf-8").splitlines():
            if line.startswith("dispatch_summary_path="):
                row = json.loads(Path(line.split("=", 1)[1]).read_text(encoding="utf-8"))
                out[row["request_id"]] = row
        return out

    def test_three_requests_one_call_two_accepted_one_refused_by_name(self) -> None:
        from aria_kernel.budget import read_cost_attribution
        from aria_kernel.feedback_store import load_feedback
        from aria_kernel.ledger import load_declared_jsonl

        quote = self._excerpt_quote()
        self.assertTrue(quote, "the mint pinned an excerpt for the cited line")
        self.vendor.script.append((200, _zai._completion("OK", prompt_tokens=7, completion_tokens=1)))  # probe
        self.vendor.script.append((200, _zai._completion(self._payload(quote), prompt_tokens=3000, completion_tokens=300)))
        completed = self._run_batch()
        governance = load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
        self.assertEqual(completed.returncode, 0, completed.stderr + json.dumps(
            [row for row in governance if str(row["kind"]).startswith("runtime_")], sort_keys=True)[:3000])

        states = {rid: self.ai.derive_request_state(request_id=rid, base_dir=self.tools) for rid in self.request_ids}
        self.assertEqual(states[self.request_ids[0]], "ACCEPTED")
        self.assertEqual(states[self.request_ids[2]], "ACCEPTED")
        self.assertIn(states[self.request_ids[1]], ("PENDING", "REQUEUED"))
        claims = load_declared_jsonl(self.tools / "agent-invocations/claims.jsonl", expected_surface="agent_invocation_claims")
        released = [row for row in claims if row.get("event") == "released" and row.get("request_id") == self.request_ids[1]]
        self.assertEqual(len(released), 1)
        self.assertEqual(released[0].get("reason"), "judge_batch_item_unanswered:value_not_in_options")

        # The wire: ONE probe and ONE batch call, json_object on, one fenced
        # question per request, the contract as the system turn.
        self.assertEqual([r["path"] for r in self.vendor.received], ["/chat/completions", "/chat/completions"])
        run = self.vendor.received[1]["json"]
        self.assertEqual(run.get("response_format"), {"type": "json_object"})
        user_turn = run["messages"][1]["content"]
        self.assertEqual(user_turn.count("<question id="), 3)
        for rid in self.request_ids:
            self.assertIn(f'<question id="{rid}"', user_turn)
        self.assertIn("Typed judgment response law", run["messages"][0]["content"])

        summaries = self._summaries()
        self.assertEqual(sorted(summaries), sorted(self.request_ids))
        self.assertEqual({summaries[r]["outcome"] for r in (self.request_ids[0], self.request_ids[2])}, {"succeeded"})
        self.assertEqual(summaries[self.request_ids[1]]["outcome"], "refused")
        self.assertEqual(summaries[self.request_ids[1]]["failure_detail_code"], "judge_batch_item_unanswered")

        started = [row for row in governance if row["kind"] == "runtime_attempt_started"]
        finished = [row for row in governance if row["kind"] == "runtime_attempt_finished"]
        self.assertEqual(len(started), 3)
        self.assertEqual(len(finished), 3)
        self.assertEqual(len({row["details"]["batch_id"] for row in finished}), 1)
        self.assertEqual({row["details"]["provider"] for row in started}, {"zai"})
        cost = read_cost_attribution(base_dir=self.tools)
        self.assertEqual(len(cost), 1)
        self.assertEqual((cost[0]["model"], cost[0]["input_tokens"], cost[0]["output_tokens"]), ("glm-5.3", 3000, 300))

        folded = [row for row in load_feedback(base_dir=self.tools) if row.get("source_type") == "ai_judge"]
        self.assertEqual(len(folded), 2)
        self.assertEqual({row["evidence_selection"] for row in folded}, {"index"})
        self.assertEqual({row["confidence_source"] for row in folded}, {"self_reported"})
        self.assertEqual({tuple(row["evidence_refs"]) for row in folded}, {("src/model_fleet.py:1",)})
        self.assertEqual({row["model"] for row in folded}, {"glm-5.3"})
        _zai.NativeZaiLane._assert_secret_nowhere(self)

    def test_a_whole_call_failure_releases_every_member_as_the_harness_fault(self) -> None:
        from aria_kernel.ledger import load_declared_jsonl

        self.vendor.script.append((200, _zai._completion("OK", prompt_tokens=7, completion_tokens=1)))  # probe
        self.vendor.script.append((500, {"error": {"code": "1300", "message": "upstream unavailable"}}))
        completed = self._run_batch()
        self.assertEqual(completed.returncode, 0, completed.stderr[-2000:])
        for rid in self.request_ids:
            self.assertIn(self.ai.derive_request_state(request_id=rid, base_dir=self.tools), ("PENDING", "REQUEUED"))
        claims = load_declared_jsonl(self.tools / "agent-invocations/claims.jsonl", expected_surface="agent_invocation_claims")
        reasons = sorted(row.get("reason") for row in claims if row.get("event") == "released")
        self.assertEqual(reasons, ["judge_batch_call_failed:http_500"] * 3)
        summaries = self._summaries()
        self.assertEqual({summaries[r]["outcome"] for r in self.request_ids}, {"refused"})
        self.assertEqual({summaries[r]["failure_class"] for r in self.request_ids}, {"harness_unavailable"})
        results = load_declared_jsonl(self.tools / "agent-invocations/results.jsonl", expected_surface="agent_invocation_results") \
            if (self.tools / "agent-invocations/results.jsonl").exists() else []
        self.assertEqual(results, [])
        _zai.NativeZaiLane._assert_secret_nowhere(self)


if __name__ == "__main__":
    unittest.main()
