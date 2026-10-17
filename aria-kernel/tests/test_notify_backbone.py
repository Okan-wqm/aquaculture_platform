"""ARIA-HIGH-415 — the notification backbone reaches a person, once per fact.

On aria/state f5c5c86a1 the outbox held 268 rows, every one ``unconfigured``:
no lane named a channel, so 19 failed cycles produced one notification and it
reached nobody. Turning the GitHub-issue channel on is what this PR does, and
it is only safe with these properties pinned:

* issue identity is the exact title, found through the issue LIST (the
  search index lags a just-created issue and opened a second one), so every
  producer's title is FIXED and what varies rides the body;
* one failed cycle is one notification, from one call site, whichever way the
  cycle failed (returned failed, raised, or left the bridge un-replayed);
* the per-record HUMAN_REQUIRED notice is for CRITICAL only; the backlog is
  counted in the one daily delivery summary;
* the doctor's failing organs are named on the result and on the governance
  row (gate g1);
* ``ARIA_NOTIFY_CHANNELS=none`` is an operator's explicit "nobody", and
  ``none`` combined with a channel is refused by name, never swallowed.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock
from urllib.parse import parse_qs, urlsplit

from aria_kernel import notify
from aria_kernel.doctor import DoctorCheck, DoctorReport
from aria_kernel.gateway import scheduler
from aria_kernel.github_adapters import ISSUE_WRITE_TIMEOUT_SECONDS, GhCliIssueWriter
from aria_kernel.human_required import record_human_required
from aria_kernel.ledger import load_jsonl
from aria_kernel.runtime_profile import set_profile
from aria_kernel.self_merge_freeze import FREEZE_NOTICE_LABELS
from aria_kernel.tool_registry import ensure_tools_dir
from tests import test_autonomy_orchestrator as orchestrator_fixtures
from tests._helpers.installation_credential import LANE_CREDENTIAL_ENV
from tests._helpers.operator_acts import operator_set_profile


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-high-415-"))
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="high-415", base_dir=self.base)
        self.tools = ensure_tools_dir(self.base)
        self.sent: list[tuple[str, str]] = []

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def capture(self) -> Any:
        """Route every notice to a recording `stdout` sender, so the BODY is observable."""
        def record(title: str, body: str, environ: Any) -> dict[str, Any]:
            self.sent.append((title, body))
            return {"transport": "test"}

        env = mock.patch.dict("os.environ", {notify.CHANNEL_SELECTOR_ENV: "stdout"})
        senders = mock.patch.dict(notify.SENDERS, {"stdout": record})
        env.start()
        senders.start()
        self.addCleanup(env.stop)
        self.addCleanup(senders.stop)

    def outbox(self, kind: str) -> list[dict[str, Any]]:
        return [row for row in notify.read_outbox(self.tools) if row["kind"] == kind]

    def governance(self, event: str) -> list[dict[str, Any]]:
        rows = load_jsonl(self.tools / "governance.jsonl")
        return [row["details"] for row in rows if row.get("kind") == event]


class TheChannelSelector(unittest.TestCase):
    _CONFIGURED = {"ARIA_NOTIFY_GITHUB_REPO": "o/r"}

    def test_none_is_an_explicit_nobody_and_never_a_channel(self) -> None:
        env = {**self._CONFIGURED, notify.CHANNEL_SELECTOR_ENV: "none"}
        self.assertEqual(notify.configured_channels(env), ())
        self.assertTrue(notify.notifications_disabled(env))
        # The sentinel is not a channel: NOTIFY_CHANNELS prices the notifier's
        # worst case (and the executor's 2280 s record wait) by its length.
        self.assertNotIn(notify.CHANNELS_DISABLED_SENTINEL, notify.NOTIFY_CHANNELS)

    def test_an_absent_selector_is_not_an_operator_choice(self) -> None:
        self.assertFalse(notify.notifications_disabled({}))
        self.assertEqual(notify.configured_channels({}), ())
        self.assertFalse(notify.notifications_disabled(self._CONFIGURED))
        self.assertEqual(notify.configured_channels(self._CONFIGURED), ("github_issue",))

    def test_none_with_a_channel_is_refused_by_name(self) -> None:
        env = {**self._CONFIGURED, notify.CHANNEL_SELECTOR_ENV: "none,github_issue"}
        with self.assertRaisesRegex(notify.ChannelSelectorInvalid, "notify_channel_selector_invalid:none_combined"):
            notify.configured_channels(env)
        with self.assertRaises(notify.ChannelSelectorInvalid):
            notify.notifications_disabled(env)


class TheOutboxRecordsTheSelector(_Store):
    def test_an_invalid_selector_is_a_failed_row_not_silence(self) -> None:
        rows = notify.notify_best_effort(kind="test", title="t", body="b", base_dir=self.tools,
                                         environ={notify.CHANNEL_SELECTOR_ENV: "none,github_issue"})
        self.assertEqual([(r["channel"], r["status"]) for r in rows], [("unconfigured", "failed")])
        self.assertIn("notify_channel_selector_invalid:none_combined", rows[0]["detail"]["error"])
        self.assertEqual(len(notify.read_outbox(self.tools)), 1)

    def test_none_is_recorded_as_the_operators_choice(self) -> None:
        rows = notify.notify(kind="test", title="t", body="b", base_dir=self.tools,
                             environ={notify.CHANNEL_SELECTOR_ENV: "none"})
        self.assertEqual([(r["channel"], r["status"]) for r in rows], [("unconfigured", "unconfigured")])
        self.assertEqual(rows[0]["detail"], {"disabled_by": "ARIA_NOTIFY_CHANNELS=none"})


class _FakeGh:
    """A repository's issues behind `gh`, answering as `gh` does.

    Both list surfaces are consistent (search is never used). `issue list`
    returns the newest `--limit` open issues and no pull requests; `api
    --paginate --slurp` on the REST issues list returns every page of it,
    newest first, with pull requests among the rows (the REST list carries
    them, marked `pull_request`) and the browser link as `html_url`.
    """

    def __init__(self, labels: list[str]) -> None:
        self.calls: list[tuple[list[str], dict[str, Any]]] = []
        self.issues: list[dict[str, Any]] = []
        self.pull_requests: list[dict[str, Any]] = []
        self.comments: list[tuple[int, str]] = []
        self.labels = list(labels)
        self._next_number = 100

    def _add(self, into: list[dict[str, Any]], kind: str, title: str, labels: list[str]) -> int:
        number = self._next_number
        self._next_number += 1
        into.append({"number": number, "title": title, "labels": list(labels),
                     "url": f"https://github.com/o/r/{kind}/{number}", "state": "OPEN"})
        return number

    def add_issue(self, title: str, labels: list[str]) -> int:
        return self._add(self.issues, "issues", title, labels)

    def add_pull_request(self, title: str, labels: list[str]) -> int:
        return self._add(self.pull_requests, "pull", title, labels)

    def _rest_issue_pages(self, argv: list[str]) -> subprocess.CompletedProcess[str]:
        if "--paginate" not in argv or "--slurp" not in argv:
            raise AssertionError(f"a REST list read without every page: {argv}")
        endpoint = urlsplit(argv[-1])
        query = parse_qs(endpoint.query)
        # `{owner}/{repo}` is what `gh` resolves from the working directory;
        # this fake's working directory is the repository `o/r`.
        if endpoint.path not in ("repos/o/r/issues", "repos/{owner}/{repo}/issues") or query.get("state") != ["open"]:
            raise AssertionError(f"unexpected REST endpoint {argv[-1]}")
        wanted = set(query["labels"][0].split(","))
        per_page = int(query["per_page"][0])
        rows = [
            {"number": item["number"], "title": item["title"], "html_url": item["url"],
             "url": f"https://api.github.com/repos/o/r/issues/{item['number']}",
             "labels": [{"name": name} for name in item["labels"]], "state": "open",
             **({"pull_request": {"url": item["url"]}} if item in self.pull_requests else {})}
            for item in sorted([*self.issues, *self.pull_requests], key=lambda item: -item["number"])
            if item["state"] == "OPEN" and wanted <= set(item["labels"])
        ]
        pages = [rows[start:start + per_page] for start in range(0, len(rows), per_page)] or [[]]
        return subprocess.CompletedProcess(argv, 0, json.dumps(pages), "")

    def __call__(self, argv: list[str], *args: Any, **kwargs: Any) -> subprocess.CompletedProcess[str]:
        self.calls.append((list(argv), {k: kwargs.get(k) for k in ("cwd", "timeout")}))
        if argv[1] == "api":
            return self._rest_issue_pages(argv)
        verb = " ".join(argv[1:3])
        if verb == "issue list":
            if "--search" in argv:
                raise AssertionError("the issue lookup must not go through the search index")
            wanted = [argv[i + 1] for i, arg in enumerate(argv) if arg == "--label"]
            limit = int(argv[argv.index("--limit") + 1])
            rows = [i for i in sorted(self.issues, key=lambda item: -item["number"])
                    if i["state"] == "OPEN" and set(wanted) <= set(i["labels"])][:limit]
            return subprocess.CompletedProcess(argv, 0, json.dumps(rows), "")
        if verb == "label list":
            return subprocess.CompletedProcess(argv, 0, json.dumps([{"name": n} for n in self.labels]), "")
        if verb == "label create":
            self.labels.append(argv[3])
            return subprocess.CompletedProcess(argv, 0, "", "")
        if verb == "issue create":
            labels = [argv[i + 1] for i, arg in enumerate(argv) if arg == "--label"]
            number = self.add_issue(argv[argv.index("--title") + 1], labels)
            return subprocess.CompletedProcess(argv, 0, f"https://github.com/o/r/issues/{number}\n", "")
        if verb == "issue comment":
            self.comments.append((int(argv[3]), argv[argv.index("--body") + 1]))
            return subprocess.CompletedProcess(argv, 0, f"https://github.com/o/r/issues/{argv[3]}#c\n", "")
        if verb == "issue edit":
            return subprocess.CompletedProcess(argv, 0, "", "")
        raise AssertionError(f"unexpected gh call {argv}")


class OneIssuePerFixedTitle(_Store):
    def setUp(self) -> None:
        super().setUp()
        credential = mock.patch.dict("os.environ", LANE_CREDENTIAL_ENV)
        credential.start()
        self.addCleanup(credential.stop)

    def test_two_sends_of_one_fixed_title_open_one_issue_and_comment_once(self) -> None:
        gh = _FakeGh(labels=[])
        env = {"ARIA_NOTIFY_GITHUB_REPO": "o/r", notify.CHANNEL_SELECTOR_ENV: "github_issue"}
        with mock.patch("aria_kernel.github_adapters.subprocess.run", side_effect=gh):
            first = notify.notify(kind="test", title="ARIA channel check", body="one", key="k1", base_dir=self.tools, environ=env)
            second = notify.notify(kind="test", title="ARIA channel check", body="two", key="k2", base_dir=self.tools, environ=env)
        self.assertEqual([r["status"] for r in (*first, *second)], ["sent", "sent"])
        self.assertEqual((first[0]["detail"]["action"], second[0]["detail"]["action"]), ("created", "commented"))
        self.assertEqual(len(gh.issues), 1, "the second send found the first issue: one issue per title")
        self.assertEqual(gh.comments, [(100, "two")])
        self.assertEqual(gh.issues[0]["labels"], ["aria"])
        self.assertIn("aria", gh.labels, "a missing label is created before the issue")
        # Every call names the configured repository (`gh api` takes no
        # `--repo`: its endpoint carries it) and runs at the notifier's
        # per-call bound.
        for argv, kwargs in gh.calls:
            if argv[1] == "api":
                self.assertTrue(argv[-1].startswith("repos/o/r/issues?"), argv)
            else:
                self.assertEqual(argv[-2:], ["--repo", "o/r"], argv)
            self.assertEqual(kwargs["timeout"], notify._GH_CALL_TIMEOUT_SECONDS, argv)

    def test_a_fixed_title_behind_more_than_a_hundred_newer_open_issues_is_found(self) -> None:
        # ARIA-LOW-554 — the lookup read the 100 newest open `aria` issues, so
        # the fixed-title issue opened first fell outside it once 100 newer
        # ones were open, and a second issue was opened for the title. An
        # open PR with the same title and a lower number is not the issue.
        gh = _FakeGh(labels=["aria"])
        gh.add_pull_request("ARIA cycle failed", labels=["aria"])
        oldest = gh.add_issue("ARIA cycle failed", labels=["aria"])
        for n in range(150):
            gh.add_issue(f"ARIA HUMAN_REQUIRED [CRITICAL] AIR-{n}", labels=["aria"])
        env = {"ARIA_NOTIFY_GITHUB_REPO": "o/r", notify.CHANNEL_SELECTOR_ENV: "github_issue"}
        with mock.patch("aria_kernel.github_adapters.subprocess.run", side_effect=gh):
            rows = notify.notify(kind="test", title="ARIA cycle failed", body="again", key="k", base_dir=self.tools,
                                 environ=env)
        self.assertEqual((rows[0]["status"], rows[0]["detail"]["action"]), ("sent", "commented"))
        self.assertEqual(gh.comments, [(oldest, "again")])
        self.assertEqual(len(gh.issues), 151, "no second issue for the title")

    def test_a_failed_lookup_creates_nothing_and_is_a_failed_row(self) -> None:
        gh = _FakeGh(labels=["aria"])

        def failing(argv: list[str], *args: Any, **kwargs: Any) -> subprocess.CompletedProcess[str]:
            if argv[1] == "api":
                return subprocess.CompletedProcess(argv, 1, "", "HTTP 502")
            return gh(argv, *args, **kwargs)

        env = {"ARIA_NOTIFY_GITHUB_REPO": "o/r", notify.CHANNEL_SELECTOR_ENV: "github_issue"}
        with mock.patch("aria_kernel.github_adapters.subprocess.run", side_effect=failing):
            rows = notify.notify(kind="test", title="ARIA channel check", body="b", base_dir=self.tools, environ=env)
        self.assertEqual(rows[0]["status"], "failed")
        self.assertIn("issue_list_failed", rows[0]["detail"]["error"])
        self.assertEqual(gh.issues, [])

    def test_the_wall_clock_is_the_longest_sequence_and_the_record_wait_is_unchanged(self) -> None:
        # list, label list, label create, create — four calls at the per-call
        # bound is still the 120 s the executor's 2280 s record wait was priced
        # from: 900 (governance transaction) + 4 channels x 120 + 900 (outbox).
        self.assertEqual(notify.SENDER_WALL_CLOCK_SECONDS, 4 * notify._GH_CALL_TIMEOUT_SECONDS)
        self.assertEqual(notify.SENDER_WALL_CLOCK_SECONDS, 120.0)
        from aria_kernel.human_required import HUMAN_REQUIRED_RECORD_WAIT_SECONDS

        self.assertEqual(HUMAN_REQUIRED_RECORD_WAIT_SECONDS, 2280.0)

    def test_the_freeze_notice_argv_names_no_repository(self) -> None:
        # The freeze path shares the writer; its cwd and timeout are the ones
        # it sent before the notifier joined (no repository named, 60 s): the
        # lookup's `{owner}/{repo}` is resolved by `gh` from the working
        # directory, as `gh issue list` without `--repo` was. The lookup is
        # the whole open set (ARIA-LOW-554), not the 100 newest.
        gh = _FakeGh(labels=["aria"])
        writer = GhCliIssueWriter(cwd=self.tmp)
        with mock.patch("aria_kernel.github_adapters.subprocess.run", side_effect=gh):
            writer.upsert_issue(title="T: freeze-1", body="one", labels=FREEZE_NOTICE_LABELS)
            writer.upsert_issue(title="T: freeze-1", body="two", labels=FREEZE_NOTICE_LABELS)
        lookup = ["gh", "api", "--paginate", "--slurp",
                  "repos/{owner}/{repo}/issues?state=open&labels=aria,self-merge-freeze&per_page=100"]
        expected = [
            lookup,
            ["gh", "label", "list", "--limit", "500", "--json", "name"],
            ["gh", "label", "create", "self-merge-freeze", "--description", "Written by the ARIA kernel"],
            ["gh", "issue", "create", "--title", "T: freeze-1", "--body", "one", "--label", "aria",
             "--label", "self-merge-freeze"],
            lookup,
            ["gh", "issue", "edit", "100", "--body", "two"],
        ]
        self.assertEqual([argv for argv, _ in gh.calls], expected)
        self.assertEqual({(str(kw["cwd"]), kw["timeout"]) for _, kw in gh.calls},
                         {(str(self.tmp), ISSUE_WRITE_TIMEOUT_SECONDS)})


class HumanRequiredVolume(_Store):
    def test_only_a_critical_record_notifies_on_its_own(self) -> None:
        self.capture()
        for request_id, severity in (("AIR-high", "HIGH"), ("AIR-medium", "MEDIUM"), ("AIR-crit", "CRITICAL")):
            record_human_required(request_id=request_id, severity=severity, reason="r", base_dir=self.tools)
        self.assertEqual([title for title, _ in self.sent], ["ARIA HUMAN_REQUIRED [CRITICAL] AIR-crit"])
        self.assertEqual(len(self.outbox("human_required_opened")), 1)

    def test_the_daily_delivery_summary_counts_the_backlog(self) -> None:
        for request_id, severity in (("AIR-high", "HIGH"), ("AIR-medium", "MEDIUM")):
            record_human_required(request_id=request_id, severity=severity, reason="r", base_dir=self.tools)
        self.capture()
        result = scheduler.run_action("deliver", base_dir=self.tools, workspace_root=self.tmp)
        self.assertEqual([title for title, _ in self.sent], [scheduler.DAILY_DELIVERY_TITLE])
        body = json.loads(self.sent[0][1])
        self.assertEqual(body["human_required"], {"open": 2, "breaching_sla": 0, "tiers": {}})
        self.assertIn("verified_prs", body["delivery"])
        self.assertEqual(result["detail"]["human_required_open"], 2)


class DoctorNamesItsFailingOrgans(_Store):
    def _report(self, *checks: DoctorCheck) -> DoctorReport:
        return DoctorReport(checks=checks, tools_dir=str(self.tools), workspace_root=str(self.tmp))

    def test_failing_organs_ride_the_result_the_governance_row_and_one_fixed_title(self) -> None:
        self.capture()
        long_reason = "deadlines_lapsed:223:" + ",".join(f"AIR-{n:04d}(-60d)" for n in range(200))
        report = self._report(
            DoctorCheck("deadlines", "fail", long_reason, {"path": "/host/path"}),
            DoctorCheck("integrity", "ok"),
            DoctorCheck("orchestrator", "fail", "orchestrator_exits_all_cycle_failed:4"),
            DoctorCheck("gateway", "warn", "inbox_backlog"),
        )
        with mock.patch("aria_kernel.doctor.run_doctor", return_value=report):
            result = scheduler.run_action("doctor", base_dir=self.tools, workspace_root=self.tmp)
        failing = result["detail"]["failing"]
        self.assertEqual([organ["name"] for organ in failing], ["deadlines", "orchestrator"])
        self.assertEqual(len(failing[0]["reason"]), scheduler.DOCTOR_FAILING_REASON_MAX_CHARS)
        self.assertEqual(result["status"], "ran", "an unhealthy doctor is a reading, not a failed action")
        rows = self.governance("gateway_action_ran")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["failing"], ["deadlines", "orchestrator"])
        self.assertEqual([title for title, _ in self.sent], [scheduler.DOCTOR_UNHEALTHY_TITLE])
        body = self.sent[0][1]
        self.assertIn("orchestrator: orchestrator_exits_all_cycle_failed:4", body)
        self.assertNotIn("/host/path", body, "organ details carry host paths; the issue is public")

    def test_a_healthy_doctor_notifies_nobody_and_names_no_organ(self) -> None:
        self.capture()
        with mock.patch("aria_kernel.doctor.run_doctor", return_value=self._report(DoctorCheck("integrity", "ok"))):
            result = scheduler.run_action("doctor", base_dir=self.tools, workspace_root=self.tmp)
        self.assertEqual(result["detail"]["failing"], [])
        self.assertEqual(self.sent, [])
        self.assertEqual(self.governance("gateway_action_ran")[0]["failing"], [])


def _payload_failed_cycle(*, workspace_root: Any, cycle_id: str, base_dir: Path,
                          defer_reflection: bool = False) -> dict[str, Any]:
    return {"schema_version": 2, "cycle_id": cycle_id, "status": "failed", "runtime_status": "failed",
            "failed_phases": [{"phase": "pr_lifecycle", "status": "failed", "error": "open_pr_head_sha_unresolvable"}]}


def _crashing_cycle(*, workspace_root: Any, cycle_id: str, base_dir: Path, defer_reflection: bool = False) -> dict[str, Any]:
    raise RuntimeError("simulated cycle crash")


def _completed_cycle(*, workspace_root: Any, cycle_id: str, base_dir: Path, defer_reflection: bool = False) -> dict[str, Any]:
    return {"schema_version": 2, "cycle_id": cycle_id, "status": "completed"}


def _stuck_bridge(*, base_dir: Path, max_iterations: int) -> dict[str, Any]:
    return {"status": "ok", "iterations": 1, "pending_after": 2}


class OneFailedCycleIsOneNotification(_Store):
    _run = orchestrator_fixtures.AutonomyOrchestratorTests._run

    def _cycle_notices(self) -> list[tuple[str, str]]:
        return [(title, body) for title, body in self.sent if title == "ARIA cycle failing"]

    def test_a_cycle_that_returned_failed_notifies_with_its_phase_reason(self) -> None:
        # The five production failures of 2026-10-09/10 had this shape and
        # notified nobody: only the exception branch called the notifier.
        self.capture()
        result = self._run(cycle_runner=_payload_failed_cycle)
        self.assertEqual(result["exit_reason"], "cycle_failed")
        notices = self._cycle_notices()
        self.assertEqual(len(notices), 1)
        body = notices[0][1]
        self.assertIn(f"cycle: {result['per_cycle'][0]['cycle_id']}", body)
        self.assertIn("exit: cycle_failed", body)
        self.assertIn("pr_lifecycle: open_pr_head_sha_unresolvable", body)
        self.assertEqual(len(self.outbox("cycle_failed")), 1)

    def test_a_crashed_cycle_notifies_exactly_once(self) -> None:
        self.capture()
        result = self._run(cycle_runner=_crashing_cycle)
        self.assertEqual(result["exit_reason"], "cycle_failed")
        notices = self._cycle_notices()
        self.assertEqual(len(notices), 1, "the exception path and the verdict path share one call site")
        self.assertIn("simulated cycle crash", notices[0][1])

    def test_a_failed_cycle_the_run_continues_past_still_notifies(self) -> None:
        self.capture()
        self._run(cycle_runner=_payload_failed_cycle, fail_closed_on_cycle_failure=False)
        self.assertEqual(len(self._cycle_notices()), 1)

    def test_a_bridge_left_unreplayed_notifies_with_its_exit(self) -> None:
        operator_set_profile("strict", base_dir=self.base, scheduler_ceiling="strict")
        self.capture()
        result = self._run(profile="strict", cycle_runner=_completed_cycle, bridge_drainer=_stuck_bridge)
        self.assertEqual(result["exit_reason"], "bridge_replay_required")
        notices = self._cycle_notices()
        self.assertEqual(len(notices), 1)
        self.assertIn("exit: bridge_replay_required", notices[0][1])
        self.assertIn("pending_after=2", notices[0][1])

    def test_a_completed_cycle_notifies_nobody(self) -> None:
        self.capture()
        self._run(cycle_runner=_completed_cycle)
        self.assertEqual(self._cycle_notices(), [])


if __name__ == "__main__":
    unittest.main()
