"""ARIA must not merge while the watchdog says its memory is stalled.

`ORPHAN-MEDIUM-562`: the external watchdog files an incident issue and fails its
own run, and nothing reads that alarm. These tests pin the alarm being read at
the single real-merge authority, and — just as load-bearing — pin the two things
that must NOT be frozen, because both would deadlock:

* the cycle, which is what advances the state branch the watchdog watches;
* human pull requests, which include the one repairing the stall.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.tool_registry import GovernanceError
from aria_kernel.watchdog_freeze import (
    assert_merge_not_watchdog_frozen,
    load_incident_signature,
    open_watchdog_incidents,
)
from tests._helpers.operator_acts import operator_set_profile
from tests._helpers.operator_stop import operator_stop_clear


class _Adapter:
    """Returns exactly what a real adapter's `get_open_issues` returns."""

    def __init__(self, payload):
        self.payload = payload
        self.labels_asked = None

    def get_open_issues(self, *, labels):
        self.labels_asked = list(labels)
        if isinstance(self.payload, Exception):
            raise self.payload
        return self.payload


class _GuardedAdapter(_Adapter):
    """The watchdog read answers; every other adapter call is recorded, so a
    test sees the merge authority go past the freeze."""

    def __init__(self, payload):
        super().__init__(payload)
        self.other_calls = []

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)

        def record(*_args, **_kwargs):
            self.other_calls.append(name)
            return {}

        return record


_OPEN_INCIDENT = {
    "readable": True,
    "issues": [{"number": 42, "title": "ARIA external watchdog: memory is NOT advancing"}],
}


def _repo_with_manifest(tmp: Path, incident=None) -> Path:
    manifest = {
        "stateBranch": {"ref": "aria/state", "maxTipAgeHours": 50},
        "lanes": [],
        "incidentIssue": incident
        if incident is not None
        else {"titlePrefix": "ARIA external watchdog:", "labels": ["aria", "watchdog"]},
    }
    path = tmp / ".github" / "manifests"
    path.mkdir(parents=True, exist_ok=True)
    (path / "aria-state-watchdog.json").write_text(json.dumps(manifest), encoding="utf-8")
    return tmp


class IncidentSignatureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = _repo_with_manifest(Path(self.tmp.name))

    def tearDown(self):
        self.tmp.cleanup()

    def test_the_signature_comes_from_the_watchdog_manifest(self):
        # Not a second copy of the labels: the watchdog and the freeze must
        # agree about what an incident looks like by construction.
        signature = load_incident_signature(self.repo)
        self.assertEqual(signature["title_prefix"], "ARIA external watchdog:")
        self.assertEqual(signature["labels"], ["aria", "watchdog"])

    def test_the_repositorys_real_manifest_satisfies_the_reader(self):
        # Guards the wiring rather than the fixture: if someone renames the
        # manifest keys, the freeze must fail loudly here and not at 01:00.
        signature = load_incident_signature()
        self.assertTrue(signature["title_prefix"].strip())
        self.assertTrue(signature["labels"])

    def test_a_manifest_without_an_incident_section_is_refused(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / ".github" / "manifests"
        path.mkdir(parents=True)
        (path / "aria-state-watchdog.json").write_text("{}", encoding="utf-8")
        with self.assertRaises(GovernanceError):
            load_incident_signature(Path(tmp.name))

    def test_a_missing_manifest_is_refused_rather_than_defaulted(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        with self.assertRaises(GovernanceError):
            load_incident_signature(Path(tmp.name))


class FreezeVerdictTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = _repo_with_manifest(Path(self.tmp.name))

    def tearDown(self):
        self.tmp.cleanup()

    def test_no_open_incident_permits_the_merge(self):
        adapter = _Adapter({"readable": True, "issues": []})
        verdict = assert_merge_not_watchdog_frozen(adapter=adapter, repo_root=self.repo)
        self.assertEqual(verdict["incidents"], [])
        self.assertEqual(adapter.labels_asked, ["aria", "watchdog"])

    def test_an_open_incident_refuses_the_merge(self):
        adapter = _Adapter({
            "readable": True,
            "issues": [{"number": 42, "title": "ARIA external watchdog: memory is NOT advancing"}],
        })
        with self.assertRaises(GovernanceError) as caught:
            assert_merge_not_watchdog_frozen(adapter=adapter, repo_root=self.repo)
        self.assertIn("merge_frozen_watchdog_incident_open", str(caught.exception))
        self.assertIn("#42", str(caught.exception))

    def test_an_unreadable_issue_list_refuses_the_merge(self):
        # Fail-closed. A transient API error must not read as "no incident" —
        # that is the single wrong answer this control exists to prevent.
        for payload in (
            {"readable": False, "issues": []},
            {"issues": []},
            {"readable": True},
            RuntimeError("gh exploded"),
        ):
            with self.subTest(payload=type(payload).__name__):
                with self.assertRaises(GovernanceError) as caught:
                    assert_merge_not_watchdog_frozen(adapter=_Adapter(payload), repo_root=self.repo)
                self.assertIn("merge_frozen_watchdog_unreadable", str(caught.exception))

    def test_an_unrelated_issue_carrying_the_labels_does_not_freeze(self):
        """A freeze that fires on the wrong issue is a freeze someone turns off.

        The label filter is all the API can do; the title prefix is what makes
        the match the watchdog's own incident rather than any issue a human
        happened to tag `aria` and `watchdog`.
        """
        adapter = _Adapter({
            "readable": True,
            "issues": [{"number": 7, "title": "aria: please add a dashboard"}],
        })
        verdict = assert_merge_not_watchdog_frozen(adapter=adapter, repo_root=self.repo)
        self.assertEqual(verdict["incidents"], [])

    def test_the_verdict_reports_every_matching_incident(self):
        adapter = _Adapter({
            "readable": True,
            "issues": [
                {"number": 1, "title": "ARIA external watchdog: memory is NOT advancing"},
                {"number": 2, "title": "unrelated"},
                {"number": 3, "title": "ARIA external watchdog: lane stalled"},
            ],
        })
        verdict = open_watchdog_incidents(adapter=adapter, repo_root=self.repo)
        self.assertEqual([i["number"] for i in verdict["incidents"]], [1, 3])


class AdapterContractTests(unittest.TestCase):
    """Every adapter implements the method, and the stub one fails closed."""

    def test_recording_adapter_cannot_claim_there_is_no_incident(self):
        from aria_kernel.github_adapters import RecordingGitHubAdapter

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        adapter = RecordingGitHubAdapter(base_dir=Path(tmp.name), profile="observe")
        payload = adapter.get_open_issues(labels=["aria"])
        self.assertIs(payload["readable"], False, "a profile that never fetched must not report health")

    def test_every_adapter_implements_the_protocol_method(self):
        from aria_kernel.auto_merge import GhCliGitHubAdapter, SnapshotGitHubAdapter
        from aria_kernel.github_adapters import RecordingGitHubAdapter

        for cls in (GhCliGitHubAdapter, SnapshotGitHubAdapter, RecordingGitHubAdapter):
            with self.subTest(adapter=cls.__name__):
                self.assertTrue(callable(getattr(cls, "get_open_issues", None)))


# ARIA-MEDIUM-582 — a fake `gh` on PATH holding the repository's open issues,
# newest first, and answering the two reads GitHub offers: `issue list
# --limit N` (the N newest) and the REST list (`api [--paginate --slurp]
# repos/<o>/<r>/issues?...`, 100 a page). Both filter by every label asked.
# Every call is logged.
_FAKE_ISSUES_GH = """#!{python}
import json, os, sys
from urllib.parse import parse_qs, urlsplit
argv = sys.argv[1:]
with open(os.environ["ARIA_FAKE_GH_LOG"], "a", encoding="utf-8") as log:
    log.write(json.dumps(argv) + "\\n")
with open(os.environ["ARIA_FAKE_GH_FIXTURE"], encoding="utf-8") as handle:
    fixture = json.load(handle)
if argv[:2] == ["repo", "view"]:
    print(json.dumps({{"owner": {{"login": "okan"}}, "name": "aqua"}}))
    sys.exit(0)
if fixture.get("fail"):
    sys.stderr.write(fixture["fail"] + "\\n")
    sys.exit(1)
def labelled(wanted):
    return [row for row in fixture["issues"] if set(wanted) <= set(row["labels"])]
if argv[:2] == ["issue", "list"]:
    wanted = [argv[i + 1] for i, arg in enumerate(argv) if arg == "--label"]
    limit = int(argv[argv.index("--limit") + 1]) if "--limit" in argv else 30
    print(json.dumps([{{"number": r["number"], "title": r["title"], "labels": []}} for r in labelled(wanted)[:limit]]))
    sys.exit(0)
if argv and argv[0] == "api":
    path = [a for a in argv[1:] if not a.startswith("--")][0]
    query = parse_qs(urlsplit(path).query)
    if urlsplit(path).path != "repos/okan/aqua/issues" or query.get("state") != ["open"]:
        sys.stderr.write("gh: Not Found (HTTP 404)\\n")
        sys.exit(1)
    rows = [{{"number": r["number"], "title": r["title"], "html_url": "https://github.com/okan/aqua/issues/%d" % r["number"],
             **({{"pull_request": {{}}}} if r.get("pull_request") else {{}})}}
            for r in labelled(query["labels"][0].split(","))]
    size = int(query.get("per_page", ["30"])[0])
    pages = [rows[i:i + size] for i in range(0, len(rows), size)] or [[]]
    if fixture.get("garbled"):
        print("{{not json")
    elif "--slurp" in argv:
        print(json.dumps(pages))
    else:
        print(json.dumps(pages[0]))
    sys.exit(0)
sys.stderr.write("fake gh: unexpected call\\n")
sys.exit(2)
"""


class TheMergeLanesIssueReadIsTheWholeOpenSet(unittest.TestCase):
    """ARIA-MEDIUM-582 — the freeze gates read every open issue, or say they
    could not.

    The merge lane's adapter read ``gh issue list --limit 50`` and reported
    the window readable, and both gates filter that window by title. With
    more than 50 open issues carrying a gate's labels, a freeze notice or a
    watchdog incident older than the 50 newest was an absent freeze, and the
    merge proceeded. The read is now the one complete REST read
    (``github_issue_reads.read_open_issues``, the ARIA-LOW-554 contract as
    the single owner both the adapter and the issue writer call): every
    page, or unreadable by name.
    """

    def setUp(self):
        from aria_kernel.auto_merge import GhCliGitHubAdapter
        from aria_kernel.self_merge_freeze import FREEZE_NOTICE_LABELS, freeze_id_for, freeze_notice_title

        directory = tempfile.TemporaryDirectory(prefix="aria-582-gh-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        gh = bin_dir / "gh"
        gh.write_text(_FAKE_ISSUES_GH.format(python=sys.executable), encoding="utf-8")
        gh.chmod(0o755)
        self.fixture = self.root / "fixture.json"
        self.log = self.root / "gh.log"
        self.log.write_text("", encoding="utf-8")
        environment = patch.dict(os.environ, {
            "PATH": f"{bin_dir}:{os.defpath}",
            "ARIA_FAKE_GH_FIXTURE": str(self.fixture),
            "ARIA_FAKE_GH_LOG": str(self.log),
        })
        environment.start()
        self.addCleanup(environment.stop)
        self.tools = self.root / "aria-tools"
        from aria_kernel.tool_registry import ensure_tools_dir

        ensure_tools_dir(self.tools)
        self.freeze_id = freeze_id_for("d" * 40)
        signature = load_incident_signature()
        # 150 newer open issues carry both gates' labels (finding issues, a
        # pull request among them); the freeze notice and the watchdog
        # incident are the 151st and 152nd, outside a 50-row window.
        both = sorted({*FREEZE_NOTICE_LABELS, *signature["labels"]})
        rows = [{"number": 2000 - n, "title": f"aria finding {n}", "labels": both} for n in range(150)]
        rows[7]["pull_request"] = True
        rows.append({"number": 1500, "title": freeze_notice_title(self.freeze_id), "labels": both})
        rows.append({"number": 1499, "title": f"{signature['title_prefix']} memory stalled", "labels": both})
        self.issues = rows
        self._serve()
        self.adapter = GhCliGitHubAdapter(cwd=self.root)

    def _serve(self, **extra):
        self.fixture.write_text(json.dumps({"issues": self.issues, **extra}), encoding="utf-8")

    def test_a_freeze_notice_past_the_newest_fifty_is_read(self):
        from aria_kernel.self_merge_freeze import open_freeze_notices

        read = open_freeze_notices(adapter=self.adapter)
        self.assertIs(read["readable"], True)
        self.assertEqual([notice["freeze_id"] for notice in read["notices"]], [self.freeze_id])

    def test_the_merge_is_refused_on_that_notice(self):
        from aria_kernel.self_merge_freeze import assert_self_merge_not_frozen

        with self.assertRaisesRegex(GovernanceError, f"self_merge_frozen_by_notice:.*{self.freeze_id}"):
            assert_self_merge_not_frozen(pr_number=7, head_sha="c" * 40, adapter=self.adapter, base_dir=self.tools)

    def test_a_watchdog_incident_past_the_newest_fifty_freezes_the_merge(self):
        read = open_watchdog_incidents(adapter=self.adapter)
        self.assertIs(read["readable"], True)
        self.assertEqual([incident["number"] for incident in read["incidents"]], [1499])
        with self.assertRaises(GovernanceError):
            assert_merge_not_watchdog_frozen(adapter=self.adapter)

    def test_the_read_is_the_rest_list_every_page_and_never_a_capped_window(self):
        payload = self.adapter.get_open_issues(labels=["aria", "watchdog"])
        self.assertIs(payload["readable"], True)
        self.assertEqual(len(payload["issues"]), 151, "152 labelled rows, one a pull request")
        calls = [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()]
        reads = [call for call in calls if call[:2] != ["repo", "view"]]
        self.assertEqual(len(reads), 1)
        self.assertEqual(reads[0][:3], ["api", "--paginate", "--slurp"])
        self.assertNotIn("--limit", reads[0])

    def test_a_refused_or_garbled_read_is_unreadable_by_name(self):
        self._serve(fail="HTTP 403: Resource not accessible by integration")
        refused = self.adapter.get_open_issues(labels=["aria", "watchdog"])
        self.assertEqual((refused["readable"], refused["issues"]), (False, []))
        self.assertIn("issue_list_failed", refused["reason"])
        self.assertIn("HTTP 403", refused["reason"])
        self._serve(garbled=True)
        garbled = self.adapter.get_open_issues(labels=["aria", "watchdog"])
        self.assertEqual(garbled, {"readable": False, "reason": "issue_list_unparseable", "issues": []})
        with self.assertRaisesRegex(GovernanceError, "watchdog"):
            assert_merge_not_watchdog_frozen(adapter=self.adapter)

    def test_the_merge_lane_and_the_issue_writer_share_one_reader(self):
        from aria_kernel import github_adapters, github_issue_reads

        seen = []

        def reader(gh_read, *, repo, labels):
            seen.append((repo, tuple(labels)))
            return True, [], ""

        # One patch point on the reader's own module intercepts both
        # callers — the adapter (repo resolved) and the issue writer (repo
        # left to gh's cwd), so neither can grow a second, capped copy.
        with patch.object(github_issue_reads, "read_open_issues", side_effect=reader):
            self.adapter.get_open_issues(labels=["aria", "watchdog"])
            github_adapters.GhCliIssueWriter(cwd=self.root)._open_issues(["aria", "watchdog"])
        self.assertEqual(seen, [("okan/aqua", ("aria", "watchdog")), (None, ("aria", "watchdog"))])

    def test_no_capped_issue_list_window_remains_in_the_freeze_reads(self):
        # The pin: the modules the merge lane's freeze gates read never go
        # back to a newest-first `gh issue list --limit N` window — a freeze
        # this gate must see can be older than any window. The complete
        # read lives in github_issue_reads; neither adapter module may name
        # the capped subcommand again.
        from aria_kernel import auto_merge, github_adapters

        for module in (auto_merge, github_adapters):
            source = Path(module.__file__).read_text(encoding="utf-8")
            self.assertNotIn(
                '"issue", "list"', source,
                f"{module.__name__} reads open issues through a capped `gh issue list` again",
            )


class FreezeScopeTests(unittest.TestCase):
    """What must NOT be frozen — each of these would deadlock."""

    def test_the_cycle_is_not_frozen_by_a_watchdog_incident(self):
        """The watchdog fires when the state branch stops advancing, and the
        CYCLE is what advances it. A cycle-level freeze would mean the branch
        never moves, the incident never closes, and the freeze never lifts.
        """
        from aria_kernel import circuit_breaker

        self.assertNotIn(
            "watchdog_incident_open",
            circuit_breaker.FAILURE_KINDS,
            "a breaker kind would stop the cycle at preflight and deadlock the recovery",
        )

    def test_the_required_status_check_does_not_read_the_incident(self):
        """`aria-merge-authority` is required on main and runs on every pull
        request, so refusing there would block every human PR — including the
        one repairing the stall. ORPHAN-MEDIUM-562's own recorded shape proposed
        exactly that, and is corrected rather than followed.
        """
        repo_root = Path(__file__).resolve().parents[2]
        workflow = (repo_root / ".github" / "workflows" / "aria-merge-authority.yml").read_text(
            encoding="utf-8",
        )
        self.assertNotIn("issue list", workflow)
        self.assertNotIn("watchdog", workflow.lower())

    def test_a_direct_call_with_an_open_incident_refuses_before_any_merge_work(self):
        # ARIA-LOW-506 — the single real-merge authority refuses on its own,
        # driven without the merge runner whose loop asks the alarm first. A
        # source-text check passed with the call kept under `if False:`.
        from aria_kernel.merge_authority import merge_pr_if_ready

        adapter = _GuardedAdapter(_OPEN_INCIDENT)
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            # Merge authority exists, so the freeze is the gate that refuses.
            operator_set_profile("autonomous", base_dir=base, scheduler_ceiling="autonomous")
            with self.assertRaises(GovernanceError) as caught:
                merge_pr_if_ready(adapter=adapter, pr_number=11, base_dir=base,
                                  readiness_claim_id="claim-1", workspace_root=base,
                                  operator_stop=operator_stop_clear())
        self.assertIn("merge_frozen_watchdog_incident_open", str(caught.exception))
        self.assertIn("#42", str(caught.exception))
        self.assertEqual(adapter.labels_asked, ["aria", "watchdog"])
        self.assertEqual(adapter.other_calls, [], "nothing past the freeze ran, the merge least of all")


class TheFreezeMustNotStopTheRun(unittest.TestCase):
    """The claim this whole control rests on, finally driven.

    `watchdog_freeze`'s docstring promises the cycle keeps running so the lanes
    can publish the state that closes the incident. An end-to-end audit found
    that promise was false: `merge_pr_if_ready` raises, and its one production
    caller invokes it bare inside `for pr_number in candidate_prs` — the only
    `try` there covers the readiness claim. So the first candidate would have
    aborted `run_autonomy_orchestrator` outright.

    Nothing tested the promise, because every test drove the freeze at the
    function that raises rather than at the loop that had to survive it.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)

    def _runner(self, payload):
        from aria_kernel.auto_merge_runners import select_auto_merge_runner


        # The runner reads merge authority from the control plane it runs
        # against (ARIA-HIGH-205), so the store must hold what the runner is
        # told it runs as.
        operator_set_profile("autonomous", base_dir=self.base, scheduler_ceiling="autonomous")
        # ARIA-HIGH-220 — the freeze guards a run that executes merges, and
        # a run executes only inside the merge-lane job.
        from tests._helpers.actions_oidc import merge_lane_job

        self.enterContext(merge_lane_job())
        adapter = _Adapter(payload)
        return select_auto_merge_runner(
            profile="autonomous",
            executes_merges=True,
            adapter_factory=lambda: adapter,
            pr_enumerator=lambda _a: [11, 22, 33],
            readiness_claim_resolver=lambda _a, _pr, _b: "claim-1",
            operator_stop=operator_stop_clear(),
        )

    def test_an_open_incident_blocks_every_candidate_without_raising(self):
        runner = self._runner({
            "readable": True,
            "issues": [{"number": 42, "title": "ARIA external watchdog: memory is NOT advancing"}],
        })
        result = runner(base_dir=self.base, workspace_root=self.base)

        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["merges_completed"], 0)
        # Every candidate is accounted for. k+1..n silently skipped is the
        # partial-state defect this repository already paid for once.
        self.assertEqual([d["pr_number"] for d in result["decisions"]], [11, 22, 33])
        for decision in result["decisions"]:
            self.assertEqual(decision["decision"], "blocked")
            self.assertIn("merge_frozen_watchdog_incident_open", decision["reasons"][0])

    def test_the_run_refuses_before_an_authority_that_would_merge_is_asked(self):
        # ARIA-LOW-506 — the run's own layer, behind a merge authority that
        # does not refuse: an open incident blocks every candidate and the
        # authority is never called. Without this, either layer alone could go
        # and the other would keep every assertion above green.
        from unittest import mock

        asked = []

        def would_merge(**kwargs):
            asked.append(kwargs["pr_number"])
            return {"decision": "merged", "eligible": True, "pr_number": kwargs["pr_number"]}

        runner = self._runner(_OPEN_INCIDENT)
        with mock.patch("aria_kernel.auto_merge_runners._merge_candidate", side_effect=would_merge):
            result = runner(base_dir=self.base, workspace_root=self.base)

        self.assertEqual(asked, [])
        self.assertEqual(result["reason"], "watchdog_merge_frozen")
        self.assertEqual(result["merges_completed"], 0)
        self.assertEqual([d["pr_number"] for d in result["decisions"]], [11, 22, 33])

    def test_an_unreadable_alarm_blocks_the_run_rather_than_ending_it(self):
        """Fail-closed must not mean fail-fatal. A transient `gh issue list`
        error is exactly what the adapter turns into readable=False, and that
        must cost a merge, not the whole autonomy run."""
        runner = self._runner(RuntimeError("gh exploded"))
        result = runner(base_dir=self.base, workspace_root=self.base)

        self.assertEqual(result["status"], "blocked")
        self.assertIn("merge_frozen_watchdog_unreadable", result["decisions"][0]["reasons"][0])

    def test_the_refusal_answers_in_the_same_shape_as_a_normal_run(self):
        """A refusal with a different key set is a refusal every consumer has
        to special-case, which is how one of them comes to miss it."""
        blocked = self._runner({"readable": True, "issues": [
            {"number": 42, "title": "ARIA external watchdog: stalled"},
        ]})(base_dir=self.base, workspace_root=self.base)
        clear = self._runner({"readable": True, "issues": []})(
            base_dir=self.base, workspace_root=self.base
        )
        for key in ("schema_version", "status", "merges_completed",
                    "candidates_evaluated", "decisions", "dry_run", "profile"):
            self.assertIn(key, blocked, key)
            self.assertIn(key, clear, key)

    def test_a_clear_alarm_does_not_short_circuit_the_loop(self):
        """The positive control. Without it, every assertion above would pass
        just as well if the runner refused unconditionally."""
        result = self._runner({"readable": True, "issues": []})(
            base_dir=self.base, workspace_root=self.base
        )
        self.assertNotEqual(result.get("reason"), "watchdog_merge_frozen")
        self.assertEqual(result["candidates_evaluated"], 3)

    def test_the_observing_profile_never_asks_the_watchdog(self):
        """Strict observes with dry_run=True and must not be frozen — it does
        not merge, so freezing it would stop observation for no safety gain."""
        from aria_kernel.auto_merge_runners import select_auto_merge_runner

        adapter = _Adapter(RuntimeError("must not be asked"))
        runner = select_auto_merge_runner(
            profile="strict",
            executes_merges=True,
            adapter_factory=lambda: adapter,
            pr_enumerator=lambda _a: [11],
            readiness_claim_resolver=lambda _a, _pr, _b: "claim-1",
            operator_stop=operator_stop_clear(),
        )
        runner(base_dir=self.base, workspace_root=self.base)
        self.assertIsNone(adapter.labels_asked, "strict asked the watchdog it must not need")


if __name__ == "__main__":
    unittest.main()
