"""ARIA-HIGH-415 — the doctor, self-improvement and daily summary run in the live lane.

The gateway daemon that was meant to schedule `doctor`, `self_improve` and
`deliver` is not deployed on production, so the doctor's organs were read by
nobody and no self_improvement mission had ever opened. The nightly producer
now runs them after the cycle. Pinned here, against the live YAML:

* they sit after the cycle (and the burn-in) and BEFORE the integrity verify
  and the publish, so their rows are verified and published with the night;
* their `if:` runs them whatever the cycle's outcome, on a cycle run only,
  and only when the lease check positively cleared — and that guard satisfies
  the abort-gate contract (a mutation to bare `always()` is caught);
* they and the cycle step name the one channel (`github_issue` on this
  repository, the job token); the executor lane names none;
* each is bounded, and the close-out margin of the cycle step still covers
  every step after it;
* the dispatch-gated channel check reaches a verdict without failing its step,
  so a failed check no longer skips the night; the run turns red after the
  publish instead (ARIA-LOW-553).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any

import yaml  # type: ignore[import-untyped]

from aria_kernel.notify import NOTIFY_WORST_CASE_SECONDS
from aria_kernel.workflow_contracts import verify_workflow_contract

_REPO_ROOT = Path(__file__).resolve().parents[2]
_WORKFLOW = ".github/workflows/aria-auto-cycle.yml"
_WORK_STEP = "Run the nightly cycle under the resolved profile"
_BURN_IN_STEP = "Run REAL observe burn-in + L1 ladder bridge"
_OBSERVATION_STEPS = (
    "Doctor - record the failing organs",
    "Self-improve - open missions for failing organs",
    "Deliver - the daily summary with the human-required backlog",
)
_POST_IF = (
    "always() && steps.lease_check.outputs.blocked != 'true' && steps.lease_check.outputs.blocked == 'false'"
    " && (github.event.inputs.mode || 'cycle') == 'cycle'"
)
_NOTIFY_ENV = {
    "GH_TOKEN": "${{ github.token }}",
    "ARIA_NOTIFY_CHANNELS": "github_issue",
    "ARIA_NOTIFY_GITHUB_REPO": "${{ github.repository }}",
}
# The close-out steps that carry no timeout of their own, at their measured
# worst (#1371, 842 MB of state): handoff 5 + integrity verify 40 + mint 2 +
# publish 10 minutes.
_UNBOUNDED_CLOSE_OUT_MINUTES = 57


def _steps() -> list[dict[str, Any]]:
    jobs = yaml.safe_load((_REPO_ROOT / _WORKFLOW).read_text(encoding="utf-8"))["jobs"]
    return jobs["cycle"]["steps"]


def _names() -> list[str]:
    return [str(step.get("name") or step.get("uses")) for step in _steps()]


def _step(name: str) -> dict[str, Any]:
    return next(step for step in _steps() if step.get("name") == name)


class TheObservationStepsRunInTheLiveLane(unittest.TestCase):
    def test_they_follow_the_cycle_and_precede_the_verify_and_the_publish(self) -> None:
        names = _names()
        positions = [names.index(name) for name in _OBSERVATION_STEPS]
        self.assertEqual(positions, sorted(positions), "doctor, then self_improve, then deliver")
        self.assertGreater(positions[0], names.index(_BURN_IN_STEP))
        self.assertGreater(positions[0], names.index(_WORK_STEP))
        for later in ("Handoff snapshot - session_stop", "Verify ARIA state integrity",
                      "Publish ARIA state to the aria/state branch"):
            self.assertLess(positions[-1], names.index(later), later)

    def test_each_runs_after_any_cycle_outcome_on_a_cleared_lease_bounded_and_on_the_channel(self) -> None:
        for name in _OBSERVATION_STEPS:
            step = _step(name)
            self.assertEqual(step["if"], _POST_IF, name)
            self.assertIsInstance(step.get("timeout-minutes"), int, name)
            # Least privilege: only the steps that write an issue hold the token.
            expected = _NOTIFY_ENV if name != _OBSERVATION_STEPS[1] else {
                key: value for key, value in _NOTIFY_ENV.items() if key != "GH_TOKEN"
            }
            self.assertEqual(step["env"], expected, name)
            self.assertIn("schedule run --action", step["run"], name)

    def test_the_cycle_step_names_the_channel_and_the_executor_lane_names_none(self) -> None:
        env = _step(_WORK_STEP)["env"]
        self.assertEqual(env["ARIA_NOTIFY_CHANNELS"], "github_issue")
        self.assertEqual(env["ARIA_NOTIFY_GITHUB_REPO"], "${{ github.repository }}")
        # The executor's HUMAN_REQUIRED records reach the operator as counts in
        # the daily summary; that lane holds no channel and no issues: write.
        executor = (_REPO_ROOT / ".github/workflows/aria-agent-executor.yml").read_text(encoding="utf-8")
        self.assertNotIn("ARIA_NOTIFY_GITHUB_REPO", executor)

    def test_the_channel_check_is_dispatch_gated_and_proves_the_second_send_comments(self) -> None:
        workflow = yaml.safe_load((_REPO_ROOT / _WORKFLOW).read_text(encoding="utf-8"))
        inputs = workflow[True]["workflow_dispatch"]["inputs"]  # PyYAML reads the `on:` key as True
        self.assertEqual(inputs["channel_check"]["default"], "false")
        step = _step("Notification channel check (dispatch-gated)")
        self.assertIn("github.event.inputs.channel_check == 'true'", step["if"])
        self.assertEqual(step["env"], _NOTIFY_ENV)
        self.assertIn('actions[1] != "commented"', step["run"])
        self.assertLess(_names().index(step["name"]), _names().index(_WORK_STEP))

    def test_the_close_out_margin_covers_every_step_after_the_cycle(self) -> None:
        run = _step(_WORK_STEP)["run"]
        match = re.search(r"JOB_TIMEOUT_MINUTES \* 60 - (\d+) \)\)", run)
        self.assertIsNotNone(match, "the margin literal moved; re-derive this pin")
        margin_minutes = int(match.group(1)) // 60
        names = _names()
        after = [step for step in _steps()[names.index(_WORK_STEP) + 1:] if step.get("name") != _BURN_IN_STEP]
        bounded = sum(int(step["timeout-minutes"]) for step in after if "timeout-minutes" in step)
        self.assertLessEqual(_UNBOUNDED_CLOSE_OUT_MINUTES + bounded, margin_minutes,
                             f"{_UNBOUNDED_CLOSE_OUT_MINUTES} + {bounded} > {margin_minutes}")


_CHANNEL_CHECK_STEP = "Notification channel check (dispatch-gated)"
_CHANNEL_CHECK_FAIL_STEP = "Fail on a failed notification channel check"
_PUBLISH_STEP = "Publish ARIA state to the aria/state branch"
# Stands in for `python3 -m aria_kernel notify send`: answers the send named
# by the `--key` suffix (1 or 2) from the scenario in the environment.
_FAKE_NOTIFY_MAIN = """\
import json, os, sys
argv = sys.argv[1:]
send = argv[argv.index("--key") + 1].rsplit(":", 1)[1]
scenario = json.loads(os.environ["FAKE_NOTIFY_SCENARIO"])[send]
if scenario.get("hang"):
    import time
    time.sleep(60)
print(json.dumps(scenario["rows"]))
sys.exit(scenario["rc"])
"""


def _send(status: str, action: str | None = None) -> dict[str, Any]:
    detail = {"action": action} if action else {"error": "issue_list_failed:rc=1: HTTP 401"}
    return {"rc": 0 if status == "sent" else 1, "rows": [{"channel": "github_issue", "status": status, "detail": detail}]}


class TheChannelCheckProvesTheChannelWithoutSkippingTheNight(unittest.TestCase):
    """ARIA-LOW-553 — a failed channel check used to fail its step, and every
    provisioning and cycle step after it carries a plain `if:` (an implied
    `success()`), so the dispatch that asked for the proof lost its night.
    The step's own script runs here as GitHub runs it (`bash -e`), against a
    stand-in `notify send`."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-low-553-"))
        package = self.tmp / "aria-kernel" / "aria_kernel"
        package.mkdir(parents=True)
        (package / "__init__.py").write_text("", encoding="utf-8")
        (package / "__main__.py").write_text(_FAKE_NOTIFY_MAIN, encoding="utf-8")
        (self.tmp / "runner-temp").mkdir()

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run(self, first: dict[str, Any], second: dict[str, Any], *,
             bound: str | None = None) -> tuple[int, dict[str, str]]:
        run = _step(_CHANNEL_CHECK_STEP)["run"]
        if bound is not None:
            # The step's own bound, shortened so a hung send is cut in a test.
            run = re.sub(r"timeout --kill-after=\d+s \d+s ", f"timeout --kill-after=1s {bound} ", run)
        script = self.tmp / "step.sh"
        script.write_text(run, encoding="utf-8")
        output = self.tmp / "github-output"
        output.write_text("", encoding="utf-8")
        env = {
            "PATH": os.environ.get("PATH", os.defpath),
            "RUNNER_TEMP": str(self.tmp / "runner-temp"),
            "GITHUB_RUN_ID": "77",
            "GITHUB_OUTPUT": str(output),
            "ARIA_TOOLS_DIR": str(self.tmp / "tools"),
            "FAKE_NOTIFY_SCENARIO": json.dumps({"1": first, "2": second}),
        }
        done = subprocess.run(["bash", "-e", str(script)], cwd=self.tmp, env=env, capture_output=True, text=True,
                              timeout=120, check=False)
        outputs = dict(line.split("=", 1) for line in output.read_text(encoding="utf-8").splitlines() if "=" in line)
        return done.returncode, outputs

    def test_a_failed_send_is_a_false_verdict_on_a_step_that_succeeds(self) -> None:
        self.assertEqual(self._run(_send("failed"), _send("failed")), (0, {"verified": "false"}))

    def test_a_second_notice_that_opened_another_issue_is_a_false_verdict(self) -> None:
        self.assertEqual(self._run(_send("sent", "created"), _send("sent", "created")), (0, {"verified": "false"}))

    def test_a_send_cut_at_its_bound_is_a_false_verdict_on_a_step_that_succeeds(self) -> None:
        hung = {**_send("sent", "created"), "hang": True}
        self.assertEqual(self._run(hung, _send("sent", "commented"), bound="1s"), (0, {"verified": "false"}))

    def test_sent_then_commented_is_a_true_verdict(self) -> None:
        self.assertEqual(self._run(_send("sent", "created"), _send("sent", "commented")), (0, {"verified": "true"}))

    def test_each_send_is_bounded_at_notifys_price_and_below_the_step_timeout(self) -> None:
        # The platform's step timeout is a failed step too, which would skip
        # the night just the same; the step must reach its verdict first. A
        # send is not cut before the worst case notify prices for itself.
        step = _step(_CHANNEL_CHECK_STEP)
        bounds = re.findall(r"timeout --kill-after=(\d+)s (\d+)s python3 -m aria_kernel notify send", step["run"])
        self.assertEqual(len(bounds), 1, "one bounded send inside the two-send loop")
        kill_after, limit = (int(value) for value in bounds[0])
        self.assertIn("for n in 1 2; do", step["run"])
        self.assertGreaterEqual(limit, NOTIFY_WORST_CASE_SECONDS)
        self.assertLess(2 * (limit + kill_after), int(step["timeout-minutes"]) * 60)

    def test_a_false_verdict_turns_the_run_red_after_the_publish(self) -> None:
        self.assertEqual(_step(_CHANNEL_CHECK_STEP).get("id"), "channel_check")
        step = _step(_CHANNEL_CHECK_FAIL_STEP)
        self.assertEqual(
            step["if"],
            "always() && steps.lease_check.outputs.blocked != 'true' && steps.channel_check.outputs.verified == 'false'",
        )
        self.assertIn("exit 1", step["run"])
        self.assertGreater(_names().index(_CHANNEL_CHECK_FAIL_STEP), _names().index(_PUBLISH_STEP))


class TheGuardSatisfiesTheAbortGate(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-high-415-wf-"))
        (self.tmp / ".github/workflows").mkdir(parents=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _verify(self, text: str) -> tuple[bool, tuple[str, ...]]:
        (self.tmp / _WORKFLOW).write_text(text, encoding="utf-8")
        verdict = verify_workflow_contract(workflow_id="aria-auto-cycle", workspace_root=self.tmp)
        return verdict.valid, verdict.reasons

    def test_the_live_yaml_passes_and_bare_always_is_caught(self) -> None:
        live = (_REPO_ROOT / _WORKFLOW).read_text(encoding="utf-8")
        valid, reasons = self._verify(live)
        self.assertTrue(valid, reasons)
        self.assertEqual(live.count(f"if: {_POST_IF}"), len(_OBSERVATION_STEPS))
        mutated = live.replace(f"if: {_POST_IF}", "if: always()")
        valid, reasons = self._verify(mutated)
        self.assertFalse(valid)
        for name in _OBSERVATION_STEPS:
            self.assertIn(f"workflow_abort_gate_unguarded_step:cycle:{name}", reasons)

    def test_a_deleted_observation_step_is_a_contract_failure(self) -> None:
        live = (_REPO_ROOT / _WORKFLOW).read_text(encoding="utf-8")
        mutated = live.replace(f"- name: {_OBSERVATION_STEPS[0]}", "- name: Doctor (renamed)")
        valid, reasons = self._verify(mutated)
        self.assertFalse(valid)
        self.assertIn(f"workflow_required_step_missing:cycle:{_OBSERVATION_STEPS[0]}", reasons)


if __name__ == "__main__":
    unittest.main()
