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
import tempfile
import unittest
from pathlib import Path

from aria_kernel.tool_registry import GovernanceError
from aria_kernel.watchdog_freeze import (
    assert_merge_not_watchdog_frozen,
    load_incident_signature,
    open_watchdog_incidents,
)


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

    def test_the_freeze_is_called_from_the_single_real_merge_authority(self):
        import inspect

        from aria_kernel import merge_authority

        source = inspect.getsource(merge_authority.merge_pr_if_ready)
        self.assertIn("assert_merge_not_watchdog_frozen(", source)


if __name__ == "__main__":
    unittest.main()
