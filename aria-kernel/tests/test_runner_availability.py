"""B8 — a self-hosted lane that cannot get its runner is red, not cancelled.

Measured 2026-09-08 → 2026-09-12: the one runner carrying
[self-hosted, linux, claude] was offline; every scheduled `aria-auto-cycle`
and `aria-agent-executor` run queued with zero jobs and was cancelled ~12h
later by the next schedule's turn in the shared concurrency group. Nothing
was red. These pin (1) the decision over GitHub's runner payload, (2) the
CLI's named exits and its in-process read-only App token, and (3) the
workflow shape, DISCOVERED across `.github/workflows/`: every job that runs
on a self-hosted runner `needs` a hosted preflight job that uses the one
composite action with exactly the labels that job runs on — except the
reasoned allowlist below.
"""
from __future__ import annotations

import io
import json
import os
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

import yaml

from aria_kernel import runner_availability as ra

_REPO_ROOT = Path(__file__).resolve().parents[2]
_WORKFLOWS = _REPO_ROOT / ".github" / "workflows"
_PREFLIGHT_JOB = "runner-preflight"
_PREFLIGHT_ACTION = ".github/actions/require-self-hosted-runner"

# Self-hosted lanes deliberately WITHOUT the preflight, each with the reason
# the silence it exists to end cannot happen there. The test also enforces
# the reason: an exempt lane must be manual-only (no `schedule:`), because
# the failure class is a SCHEDULED run nobody watches being cancelled by the
# next schedule; a human who dispatches a run sees it sit in "Queued".
_PREFLIGHT_EXEMPT_LANES: dict[str, str] = {
    "aria-runner-capability-probe.yml": (
        "workflow_dispatch-only diagnostic of the runner itself (RC-9 step 0): the "
        "operator dispatching it watches the queue, and a probe that needed the App "
        "to say 'runner offline' would tell them what the queue already shows"
    ),
}

# The live payload shape on 2026-09-12 (`gh api repos/.../actions/runners`):
# one runner, labels as the registration wrote them, status offline.
_LIVE_OFFLINE = {"id": 1, "name": "suderra-droplet-claude", "os": "Linux", "status": "offline", "busy": False,
                 "labels": [{"name": "self-hosted"}, {"name": "Linux"}, {"name": "X64"}, {"name": "claude"}]}
_REQUIRED = ["self-hosted", "linux", "claude"]


def _online(name: str = "droplet", *, busy: bool = False, labels: list[str] | None = None) -> dict:
    return {"id": 7, "name": name, "status": "online", "busy": busy,
            "labels": [{"name": label} for label in (labels or ["self-hosted", "Linux", "X64", "claude"])]}


class TheDecisionOverTheRunnerPayload(unittest.TestCase):
    def test_the_live_offline_runner_is_named_offline_not_missing(self) -> None:
        decision = ra.evaluate_runner_availability([_LIVE_OFFLINE], _REQUIRED)
        self.assertFalse(decision.available)
        self.assertEqual(decision.reason, ra.REQUIRED_RUNNER_OFFLINE)
        self.assertEqual(decision.offline, ("suderra-droplet-claude",))
        self.assertEqual(decision.online, ())

    def test_an_online_runner_with_every_label_is_available_even_when_busy(self) -> None:
        decision = ra.evaluate_runner_availability([_LIVE_OFFLINE, _online(busy=True)], _REQUIRED)
        self.assertTrue(decision.available)
        self.assertEqual(decision.reason, ra.RUNNER_ONLINE)
        self.assertEqual(decision.online, ("droplet",))

    def test_labels_match_the_way_github_matches_them_case_insensitively(self) -> None:
        # `Linux` on the runner satisfies `linux` in runs-on.
        decision = ra.evaluate_runner_availability([_online()], ["SELF-HOSTED", "Linux", "claude"])
        self.assertTrue(decision.available)
        self.assertEqual(decision.required_labels, ("claude", "linux", "self-hosted"))

    def test_no_registered_runner_is_its_own_reason(self) -> None:
        decision = ra.evaluate_runner_availability([], _REQUIRED)
        self.assertEqual((decision.available, decision.reason), (False, ra.NO_RUNNER_REGISTERED))

    def test_an_online_runner_missing_a_label_does_not_count(self) -> None:
        decision = ra.evaluate_runner_availability([_online(labels=["self-hosted", "Linux"])], _REQUIRED)
        self.assertEqual((decision.available, decision.reason), (False, ra.REQUIRED_LABELS_UNMATCHED))
        self.assertEqual(decision.unlabelled, ("droplet",))

    def test_required_labels_cannot_be_empty(self) -> None:
        with self.assertRaises(ValueError):
            ra.evaluate_runner_availability([_online()], [])


class TheCliExitsByName(unittest.TestCase):
    def _run(self, runners: list[dict] | Exception) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with patch.object(ra, "fetch_repository_runners", side_effect=runners if isinstance(runners, Exception) else None,
                          return_value=None if isinstance(runners, Exception) else runners):
            with patch.dict("os.environ", {"GH_TOKEN": "fixture"}), redirect_stdout(out), redirect_stderr(err):
                code = ra.main(["--repository", "o/r", "--required-labels", "self-hosted,linux,claude"])
        return code, out.getvalue(), err.getvalue()

    def test_an_offline_runner_fails_the_step_with_the_reason_on_stderr(self) -> None:
        code, out, err = self._run([_LIVE_OFFLINE])
        self.assertEqual(code, 1)
        self.assertIn(f"::error::{ra.REQUIRED_RUNNER_OFFLINE}", err)
        self.assertIn("suderra-droplet-claude", err)
        self.assertEqual(json.loads(out)["reason"], ra.REQUIRED_RUNNER_OFFLINE)

    def test_an_online_runner_passes_and_prints_the_decision(self) -> None:
        code, out, err = self._run([_online()])
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(json.loads(out)["online"], ["droplet"])

    def test_an_unreadable_status_is_a_named_failure_never_a_pass(self) -> None:
        code, _out, err = self._run(ra.RunnerStatusUnreadable("http_403"))
        self.assertEqual(code, 1)
        self.assertIn(f"::error::{ra.RUNNER_STATUS_UNREADABLE}: http_403", err)


class _Response:
    def __init__(self, payload: dict) -> None:
        self._body = json.dumps(payload).encode("utf-8")

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *_: object) -> bool:
        return False


class TheFetchNamesWhatGithubSaid(unittest.TestCase):
    def test_a_forbidden_token_surfaces_as_http_403(self) -> None:
        def forbidden(request, timeout):  # noqa: ANN001 — urlopen's shape
            raise urllib.error.HTTPError(request.full_url, 403, "Forbidden", {}, None)

        with patch.object(ra.urllib.request, "urlopen", forbidden):
            with self.assertRaisesRegex(ra.RunnerStatusUnreadable, "http_403"):
                ra.fetch_repository_runners("o/r", "token")

    def test_pages_are_walked_and_the_bearer_token_rides_the_header(self) -> None:
        seen: list[tuple[str, str]] = []
        first = [dict(_online(f"r{i}"), id=i) for i in range(ra._PAGE_SIZE)]

        def paged(request, timeout):  # noqa: ANN001
            seen.append((request.full_url, request.get_header("Authorization")))
            page = int(request.full_url.rsplit("page=", 1)[1])
            return _Response({"total_count": ra._PAGE_SIZE + 1,
                              "runners": first if page == 1 else [_LIVE_OFFLINE]})

        with patch.object(ra.urllib.request, "urlopen", paged):
            runners = ra.fetch_repository_runners("o/r", "token")
        self.assertEqual(len(runners), ra._PAGE_SIZE + 1)
        self.assertEqual([auth for _, auth in seen], ["Bearer token", "Bearer token"])
        self.assertTrue(all("/repos/o/r/actions/runners" in url for url, _ in seen))

    def test_an_absent_token_is_refused_before_any_request(self) -> None:
        with self.assertRaisesRegex(ra.RunnerStatusUnreadable, "token_absent"):
            ra.fetch_repository_runners("o/r", "")


class TheAppTokenNeverLeavesTheProcess(unittest.TestCase):
    """`--app-token`: the roster is read with a token minted in-process with
    administration:read and nothing else, and the lease is revoked before
    the CLI returns — a GitHub-hosted job never holds a write scope on the
    repository, and nothing it exports could leak one."""

    def _run_app_token(self, mint_side_effect=None) -> tuple[int, str, str, dict]:
        from types import SimpleNamespace

        from aria_kernel import gh_token_factory as tf

        seen: dict = {"mint_kwargs": None, "fetched_token": None, "revoked": []}
        token_file = Path(tempfile.mkdtemp(prefix="aria-preflight-lease-")) / "runner-preflight.token"
        token_file.write_text("ghs_read_only_fixture\n", encoding="utf-8")
        lease = SimpleNamespace(token_file=token_file, gh_app_installation_id="12345")

        def mint(**kwargs):
            seen["mint_kwargs"] = kwargs
            if mint_side_effect is not None:
                raise mint_side_effect
            return lease

        def fetch(repository, token, *, timeout_seconds):  # noqa: ANN001
            seen["fetched_token"] = token
            return [_online()]

        def revoke(*, lease):  # noqa: ANN001
            seen["revoked"].append(lease)
            lease.token_file.unlink()

        out, err = io.StringIO(), io.StringIO()
        with patch.object(tf, "mint_installation_token", mint), patch.object(tf, "revoke_installation_token", revoke), \
                patch.object(ra, "fetch_repository_runners", fetch), patch.dict("os.environ", {}, clear=False), \
                redirect_stdout(out), redirect_stderr(err):
            os.environ.pop("GH_TOKEN", None)
            code = ra.main(["--repository", "o/r", "--required-labels", "self-hosted,linux,claude",
                            "--app-token", "--workspace-root", str(token_file.parent), "--cycle-id", "runner-preflight-42"])
        return code, out.getvalue(), err.getvalue(), seen

    def test_the_mint_asks_for_administration_read_only_and_the_lease_is_revoked(self) -> None:
        from aria_kernel.gh_token_factory import RUNNER_STATUS_PERMISSIONS

        code, out, _err, seen = self._run_app_token()
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["reason"], ra.RUNNER_ONLINE)
        self.assertEqual(seen["mint_kwargs"]["permissions"], RUNNER_STATUS_PERMISSIONS)
        self.assertEqual(dict(seen["mint_kwargs"]["permissions"]), {"administration": "read"})
        self.assertEqual(seen["mint_kwargs"]["cycle_id"], "runner-preflight-42")
        self.assertEqual(seen["fetched_token"], "ghs_read_only_fixture")
        self.assertEqual(len(seen["revoked"]), 1, "the lease lives exactly as long as the read")
        self.assertFalse(seen["revoked"][0].token_file.exists())
        self.assertNotIn("GH_TOKEN", os.environ, "the token is never exported")

    def test_a_refused_mint_is_a_named_unreadable_status_never_a_pass(self) -> None:
        code, _out, err, seen = self._run_app_token(RuntimeError("ARIA_REQUIRE_MODE_A=true but ARIA_GH_APP_INSTALLATION_ID is unset"))
        self.assertEqual(code, 1)
        self.assertIn(f"::error::{ra.RUNNER_STATUS_UNREADABLE}: app_token_mint_refused:", err)
        self.assertIsNone(seen["fetched_token"])


class TheLanesNeedAProvenRunner(unittest.TestCase):
    """The workflow shape, discovered. Every job in `.github/workflows/`
    that runs on a self-hosted runner needs the hosted preflight, and the
    preflight uses the one composite action with exactly that job's labels.
    Enumerating two lanes by name is how aria-daily-report, the dataflow
    watchdog and the capability probe were missed the first time."""

    def _workflow(self, name: str) -> dict:
        return yaml.safe_load((_WORKFLOWS / name).read_text(encoding="utf-8"))

    @staticmethod
    def _self_hosted_jobs(workflow: dict) -> dict[str, dict]:
        return {job_id: job for job_id, job in workflow["jobs"].items()
                if "self-hosted" in [str(label).lower() for label in _as_list(job.get("runs-on"))]}

    def _self_hosted_lanes(self) -> dict[str, dict]:
        lanes = {}
        for path in sorted(_WORKFLOWS.glob("*.yml")):
            workflow = self._workflow(path.name)
            if self._self_hosted_jobs(workflow):
                lanes[path.name] = workflow
        return lanes

    def _preflight_step(self, job: dict) -> dict:
        for step in job["steps"]:
            if str(step.get("uses") or "").rstrip("/") == f"./{_PREFLIGHT_ACTION}":
                return step
        raise AssertionError(f"no step uses ./{_PREFLIGHT_ACTION}")

    def _lanes_needing_the_preflight(self) -> dict[str, dict]:
        lanes = self._self_hosted_lanes()
        self.assertGreaterEqual(len(lanes), 5, sorted(lanes))
        return {name: wf for name, wf in lanes.items() if name not in _PREFLIGHT_EXEMPT_LANES}

    def test_the_discovered_lanes_include_the_ones_missed_by_the_two_lane_list(self) -> None:
        needing = self._lanes_needing_the_preflight()
        for name in ("aria-agent-executor.yml", "aria-auto-cycle.yml", "aria-daily-report.yml",
                     "dataflow-integrity-watchdog.yml"):
            self.assertIn(name, needing)

    def test_every_exempt_lane_exists_is_self_hosted_and_is_manual_only(self) -> None:
        lanes = self._self_hosted_lanes()
        for name, reason in _PREFLIGHT_EXEMPT_LANES.items():
            with self.subTest(workflow=name):
                self.assertIn(name, lanes, "an exemption for a lane that is not self-hosted is stale")
                self.assertGreater(len(reason), 40, "an exemption carries its reason")
                triggers = lanes[name].get(True) or lanes[name].get("on") or {}
                self.assertNotIn("schedule", triggers, f"{name} is scheduled; nobody watches its queue — it needs the preflight")
                self.assertEqual(set(triggers), {"workflow_dispatch"}, f"{name}: exemption holds for manual-only lanes")

    def test_every_self_hosted_job_needs_the_hosted_preflight(self) -> None:
        for name, workflow in self._lanes_needing_the_preflight().items():
            with self.subTest(workflow=name):
                preflight = workflow["jobs"].get(_PREFLIGHT_JOB)
                self.assertIsNotNone(preflight, f"{name} has no {_PREFLIGHT_JOB} job")
                self.assertEqual(preflight["runs-on"], "ubuntu-latest", "the preflight must not need the runner it probes")
                self.assertIsInstance(preflight.get("timeout-minutes"), int)
                self.assertNotIn("needs", preflight)
                self.assertEqual(preflight["permissions"], {"contents": "read"})
                for job_id, job in self._self_hosted_jobs(workflow).items():
                    self.assertIn(_PREFLIGHT_JOB, _as_list(job.get("needs")), f"{name}:{job_id} does not need the preflight")
                    if "if" in job:
                        self.assertEqual(preflight.get("if"), job["if"],
                                         f"{name}: a run that never reaches {job_id} must not probe for its runner")

    def test_the_preflight_uses_the_one_action_with_the_labels_the_job_runs_on(self) -> None:
        for name, workflow in self._lanes_needing_the_preflight().items():
            with self.subTest(workflow=name):
                job = workflow["jobs"][_PREFLIGHT_JOB]
                step = self._preflight_step(job)
                inputs = step["with"]
                declared = {label.strip().lower() for label in str(inputs["required-labels"]).split(",")}
                for job_id, self_hosted in self._self_hosted_jobs(workflow).items():
                    self.assertEqual(declared, {str(label).lower() for label in _as_list(self_hosted["runs-on"])},
                                     f"{name}:{job_id} runs on labels the preflight does not check")
                for key, secret in (("app-id", "ARIA_GH_APP_ID"), ("app-installation-id", "ARIA_GH_APP_INSTALLATION_ID"),
                                    ("app-private-key", "ARIA_GH_APP_PRIVATE_KEY")):
                    self.assertEqual(inputs[key], "${{ secrets.%s }}" % secret)
                uses = [str(s.get("uses") or "") for s in job["steps"]]
                self.assertTrue(uses[0].startswith("actions/checkout@"), "the action is local; the job checks out first")
                self.assertFalse(any("mint_installation_token" in str(s.get("run") or "") for s in job["steps"]),
                                 "the mint lives in the action, never inline in a workflow")


class TheCompositeActionIsTheOneDefinition(unittest.TestCase):
    def test_the_action_provisions_the_kernel_then_probes_with_the_app_token(self) -> None:
        action = yaml.safe_load((_REPO_ROOT / _PREFLIGHT_ACTION / "action.yml").read_text(encoding="utf-8"))
        self.assertEqual(set(action["inputs"]), {"required-labels", "app-id", "app-installation-id", "app-private-key"})
        self.assertTrue(all(spec.get("required") is True for spec in action["inputs"].values()))
        steps = action["runs"]["steps"]
        self.assertEqual(action["runs"]["using"], "composite")
        self.assertTrue(str(steps[0].get("uses") or "").endswith(".github/actions/setup-aria-kernel"),
                        "the kernel is provisioned before any step imports it")
        probe = steps[1]
        self.assertEqual(probe["env"]["ARIA_REQUIRE_MODE_A"], "true")
        self.assertEqual(probe["env"]["REQUIRED_RUNNER_LABELS"], "${{ inputs.required-labels }}")
        for var, source in (("ARIA_GH_APP_ID", "app-id"), ("ARIA_GH_APP_INSTALLATION_ID", "app-installation-id"),
                            ("ARIA_GH_APP_PRIVATE_KEY", "app-private-key")):
            self.assertEqual(probe["env"][var], "${{ inputs.%s }}" % source)
        run = probe["run"]
        self.assertIn("set -euo pipefail", run)
        self.assertIn("umask 077", run)
        self.assertIn("python3 -m aria_kernel.runner_availability", run)
        self.assertIn("--app-token", run)
        self.assertIn('--required-labels "$REQUIRED_RUNNER_LABELS"', run)
        self.assertIn('--repository "$GITHUB_REPOSITORY"', run)
        self.assertNotIn("GH_TOKEN", run, "the token never enters the job environment")


def _as_list(value: object) -> list:
    if value is None:
        return []
    return list(value) if isinstance(value, (list, tuple)) else [value]


if __name__ == "__main__":
    unittest.main()
