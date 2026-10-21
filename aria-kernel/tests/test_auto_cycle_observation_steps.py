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
  every step after it: the margin and its one unbounded term (the basis) are
  the job env's, no step without a timeout sits between the cycle and the
  publish outside the measured stretch, and every night measures that
  stretch against the basis (ARIA-LOW-551);
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
import time
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
_ANCHOR_STEP = "Anchor the unbounded close-out"
_MEASURE_STEP = "Measure the unbounded close-out"
_HANDOFF_STOP_STEP = "Handoff snapshot - session_stop"
_CLOSE_OUT_PUBLISH_STEP = "Publish ARIA state to the aria/state branch"
_CYCLE_ONLY_IF = (
    "always() && steps.lease_check.outputs.blocked != 'true' && (github.event.inputs.mode || 'cycle') == 'cycle'"
)


def _job() -> dict[str, Any]:
    return yaml.safe_load((_REPO_ROOT / _WORKFLOW).read_text(encoding="utf-8"))["jobs"]["cycle"]


def _steps() -> list[dict[str, Any]]:
    return _job()["steps"]


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
            # Least privilege: only the steps that write an issue hold the
            # token and the channel. Self-improve writes missions, and since
            # ARIA-LOW-559 it no longer runs the doctor whose notifications
            # organ judged the lane's channel, so it holds neither.
            expected = _NOTIFY_ENV if name != _OBSERVATION_STEPS[1] else None
            self.assertEqual(step.get("env"), expected, name)
            self.assertIn("schedule run --action", step["run"], name)

    def test_self_improve_reads_the_report_the_doctor_step_wrote(self) -> None:
        """ARIA-LOW-559 — one doctor run a night: the doctor step writes its
        action's output (which carries the report) and the self-improve step
        hands that same file to `--doctor-report` instead of running every
        organ again."""
        report = '"$RUNNER_TEMP/aria-doctor.json"'
        self.assertIn("--action doctor", _step(_OBSERVATION_STEPS[0])["run"])
        self.assertIn(f"> {report}", _step(_OBSERVATION_STEPS[0])["run"])
        self.assertIn(f"--doctor-report {report}", _step(_OBSERVATION_STEPS[1])["run"])

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
        # ARIA-LOW-551 — the margin and the basis (the one term no timeout
        # bounds) have one owner, the job env; the spawn deadline reads it.
        env = _job()["env"]
        margin = int(env["ARIA_CLOSE_OUT_MARGIN_SECONDS"])
        basis = int(env["ARIA_CLOSE_OUT_UNBOUNDED_BASIS_SECONDS"])
        run = _step(_WORK_STEP)["run"]
        self.assertIn("JOB_TIMEOUT_MINUTES * 60 - ARIA_CLOSE_OUT_MARGIN_SECONDS ))", run)
        self.assertIsNone(re.search(r"JOB_TIMEOUT_MINUTES \* 60 - \d", run), "the margin has one owner, the job env")
        names = _names()
        after = [step for step in _steps()[names.index(_WORK_STEP) + 1:] if step.get("name") != _BURN_IN_STEP]
        bounded = sum(int(step["timeout-minutes"]) * 60 for step in after if "timeout-minutes" in step)
        self.assertLessEqual(basis + bounded, margin, f"{basis} + {bounded} > {margin}")

    def test_the_close_out_margin_is_priced_from_the_kernel_publish_bounds(self) -> None:
        # ARIA-LOW-585 — one center for the publish pricing. The executor's
        # post-drain reserve derives from the kernel's own bounds (liveness
        # 2700 + publish preamble 4500 + a steps allowance); the producer's
        # whole close-out margin was a separate measured literal, 6000,
        # BELOW the kernel's priced worst case for the publish arc alone —
        # one publish priced two ways, and a night that hits the kernel's
        # worst case would seal past its own job cap. The margin now holds
        # the kernel's publish arc, the kernel's close-out steps allowance
        # and every bounded step after the cycle; and when the margin is
        # re-derived the CAP moves with it, so the spawn window — what the
        # night may spend, the operator's 2026-08-13 unbounded night — does
        # not change. (No live red exists: proving the 7200s publish worst
        # case takes a >2h drain on the real store; the nightly "Measure
        # the unbounded close-out" step keeps measuring the real stretch.)
        from aria_kernel.state_store_lifecycle_arcs import STATE_STORE_LIFECYCLE_LIVENESS_SECONDS
        from aria_kernel.state_writer_lease import PUBLISH_PREAMBLE_SECONDS

        env = _job()["env"]
        margin = int(env["ARIA_CLOSE_OUT_MARGIN_SECONDS"])
        self.assertGreaterEqual(
            margin,
            int(STATE_STORE_LIFECYCLE_LIVENESS_SECONDS) + PUBLISH_PREAMBLE_SECONDS,
            "the close-out margin is below the kernel's priced publish arc alone",
        )
        from aria_kernel.state_writer_lease import STATE_CLOSE_OUT_STEPS_ALLOWANCE_SECONDS

        names = _names()
        after = [step for step in _steps()[names.index(_WORK_STEP) + 1:] if step.get("name") != _BURN_IN_STEP]
        bounded = sum(int(step["timeout-minutes"]) * 60 for step in after if "timeout-minutes" in step)
        self.assertGreaterEqual(
            margin,
            int(STATE_STORE_LIFECYCLE_LIVENESS_SECONDS) + PUBLISH_PREAMBLE_SECONDS
            + STATE_CLOSE_OUT_STEPS_ALLOWANCE_SECONDS + bounded,
            "the close-out margin drops a term the kernel prices",
        )
        job = _job()
        run = _step(_WORK_STEP)["run"]
        self.assertIn("JOB_TIMEOUT_MINUTES * 60 - ARIA_CLOSE_OUT_MARGIN_SECONDS ))", run)
        self.assertIn(f"JOB_TIMEOUT_MINUTES={int(job['timeout-minutes'])}\n", run)
        # The spawn window is the operator's budget: 260 minutes. A
        # re-derived margin moves the cap with it, never the window.
        self.assertEqual(int(job["timeout-minutes"]) * 60 - margin, 260 * 60)

    def test_every_unbounded_step_before_the_publish_is_inside_the_measured_stretch(self) -> None:
        # The basis prices the stretch from the anchor to the end of the
        # publish; a step with no timeout added between the cycle and the
        # anchor would spend the margin unmeasured and unpriced.
        names = _names()
        between = _steps()[names.index(_WORK_STEP) + 1:names.index(_ANCHOR_STEP)]
        unbounded = [step.get("name") for step in between
                     if "timeout-minutes" not in step and step.get("name") != _BURN_IN_STEP]
        self.assertEqual(unbounded, [])
        self.assertLess(names.index(_OBSERVATION_STEPS[-1]), names.index(_ANCHOR_STEP))
        self.assertEqual(names.index(_HANDOFF_STOP_STEP), names.index(_ANCHOR_STEP) + 1)
        self.assertEqual(names.index(_MEASURE_STEP), names.index(_CLOSE_OUT_PUBLISH_STEP) + 1)
        self.assertEqual((_step(_ANCHOR_STEP)["if"], _step(_MEASURE_STEP)["if"]), (_CYCLE_ONLY_IF, _CYCLE_ONLY_IF))


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


class EveryNightMeasuresTheUnboundedCloseOut(unittest.TestCase):
    """ARIA-LOW-551 — the margin's unbounded basis was one measurement (#1371)
    and no night that did real post-work had checked it. The anchor and the
    measurement run here as GitHub runs them (`bash -e`), the measurement
    after a stretch below and above the basis."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-low-551-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _bash(self, script: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        path = self.tmp / "step.sh"
        path.write_text(script, encoding="utf-8")
        return subprocess.run(["bash", "-e", str(path)], cwd=self.tmp, capture_output=True, text=True, timeout=60,
                              check=False, env={"PATH": os.environ.get("PATH", os.defpath), **env})

    def _measure(self, spent_seconds: int) -> tuple[subprocess.CompletedProcess[str], str]:
        job_env = _job()["env"]
        summary = self.tmp / "summary"
        summary.write_text("", encoding="utf-8")
        done = self._bash(_step(_MEASURE_STEP)["run"], {
            "ARIA_UNBOUNDED_CLOSE_OUT_START_EPOCH": str(int(time.time()) - spent_seconds),
            "ARIA_CLOSE_OUT_UNBOUNDED_BASIS_SECONDS": job_env["ARIA_CLOSE_OUT_UNBOUNDED_BASIS_SECONDS"],
            "ARIA_CLOSE_OUT_MARGIN_SECONDS": job_env["ARIA_CLOSE_OUT_MARGIN_SECONDS"],
            "GITHUB_STEP_SUMMARY": str(summary),
        })
        return done, summary.read_text(encoding="utf-8")

    def test_the_anchor_exports_the_start_to_the_later_steps(self) -> None:
        github_env = self.tmp / "github-env"
        github_env.write_text("", encoding="utf-8")
        before = int(time.time())
        done = self._bash(_step(_ANCHOR_STEP)["run"], {"GITHUB_ENV": str(github_env)})
        self.assertEqual(done.returncode, 0, done.stderr)
        name, value = github_env.read_text(encoding="utf-8").strip().split("=", 1)
        self.assertEqual(name, "ARIA_UNBOUNDED_CLOSE_OUT_START_EPOCH")
        self.assertGreaterEqual(int(value), before)

    def test_a_stretch_within_the_basis_is_recorded_without_a_warning(self) -> None:
        basis = int(_job()["env"]["ARIA_CLOSE_OUT_UNBOUNDED_BASIS_SECONDS"])
        done, summary = self._measure(basis - 600)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertNotIn("::warning", done.stdout)
        self.assertIn(f"of the {basis}s basis", summary)

    def test_a_stretch_over_the_basis_warns_by_name_and_does_not_fail_the_step(self) -> None:
        basis = int(_job()["env"]["ARIA_CLOSE_OUT_UNBOUNDED_BASIS_SECONDS"])
        done, summary = self._measure(basis + 600)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("::warning title=ARIA close-out margin::", done.stdout)
        self.assertIn(f"over the {basis}s basis", done.stdout)
        self.assertIn("unbounded close-out", summary)


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
