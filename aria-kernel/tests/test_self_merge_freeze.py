"""ARIA-HIGH-200 — ARIA's own self-merge freeze, lifted only by an operator.

Pins the state machine (freeze → registered revert → operator unfreeze), the
single thing a frozen merge authority admits, and that the freeze is read by
the one real-merge authority. ARIA-CRITICAL-216: the operator's unfreeze is a
GitHub comment or review approving that freeze id, read from a fake GitHub.
"""

from __future__ import annotations

import inspect
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import cli, merge_authority
from aria_kernel.runtime_profile import set_profile
from aria_kernel.github_adapters import GhCliIssueWriter, RecordingGitHubAdapter, select_issue_writer
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.self_merge_freeze import (
    FREEZE_NOTICE_LABELS,
    FROZEN_EVENT,
    NOTICE_EVENT,
    REVERT_REGISTERED_EVENT,
    UNFROZEN_EVENT,
    active_freeze,
    assert_self_merge_not_frozen,
    close_freeze_notice,
    freeze_id_for,
    freeze_ledger_path,
    freeze_notice_title,
    freeze_self_merge,
    publish_freeze_notice,
    register_revert,
    unfreeze_self_merge,
)
from aria_kernel.tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir
from tests._helpers.installation_credential import LANE_CREDENTIAL_ENV
from tests._helpers.operator_acts import github_operator_acts

MERGE_SHA = "a" * 40
PURE = {"pure": True, "patch_id": "p" * 40}


class NoticeAdapter:
    """The merge adapter's issue read, answering from a fixed issue list."""

    def __init__(self, issues: list[dict] | None = None, *, readable: bool = True) -> None:
        self.issues = list(issues or [])
        self.readable = readable
        self.asked: list[list[str]] = []

    def get_open_issues(self, *, labels: list[str]) -> dict:
        self.asked.append(list(labels))
        if not self.readable:
            return {"readable": False, "reason": "HTTP 502", "issues": []}
        return {"readable": True, "issues": list(self.issues)}


NO_NOTICES = NoticeAdapter()


class SelfMergeFreezeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        acts = github_operator_acts()
        self.github = acts.__enter__()
        self.addCleanup(acts.__exit__, None, None, None)

    def _freeze(self) -> dict:
        return freeze_self_merge(
            merge_sha=MERGE_SHA,
            pr_number=41,
            trigger="merge_outcome_red",
            evidence={"red_jobs": ["build-status"]},
            base_dir=self.tools,
        )

    def _register(self, freeze_id: str, *, pr_number: int = 42, head_sha: str = "b" * 40) -> None:
        register_revert(
            freeze_id=freeze_id, pr_number=pr_number, head_sha=head_sha,
            purity=PURE, base_dir=self.tools,
        )

    def _operator_ref(self, freeze_id: str) -> str:
        return self.github.approve("self_merge_unfreeze", {"freeze_id": freeze_id})

    def test_no_freeze_admits_every_pr(self) -> None:
        self.assertIsNone(active_freeze(base_dir=self.tools))
        self.assertIsNone(assert_self_merge_not_frozen(pr_number=7, head_sha="c" * 40, adapter=NO_NOTICES, base_dir=self.tools))

    def test_a_freeze_refuses_an_ordinary_pr(self) -> None:
        self._freeze()
        with self.assertRaisesRegex(GovernanceError, "self_merge_frozen"):
            assert_self_merge_not_frozen(pr_number=7, head_sha="c" * 40, adapter=NO_NOTICES, base_dir=self.tools)

    def test_the_same_merge_freezes_once(self) -> None:
        first = self._freeze()
        second = self._freeze()
        self.assertEqual(first["freeze_id"], second["freeze_id"])
        self.assertEqual(first["freeze_id"], freeze_id_for(MERGE_SHA))
        text = freeze_ledger_path(self.tools).read_text(encoding="utf-8")
        self.assertEqual(text.count(FROZEN_EVENT), 1)

    def test_only_the_registered_revert_at_its_head_is_admitted(self) -> None:
        freeze_id = self._freeze()["freeze_id"]
        self._register(freeze_id)
        admitted = assert_self_merge_not_frozen(pr_number=42, head_sha="b" * 40, adapter=NO_NOTICES, base_dir=self.tools)
        self.assertEqual(admitted["freeze_id"], freeze_id)
        # A new push to the revert branch is not the proven revert.
        with self.assertRaisesRegex(GovernanceError, "self_merge_frozen"):
            assert_self_merge_not_frozen(pr_number=42, head_sha="d" * 40, adapter=NO_NOTICES, base_dir=self.tools)
        with self.assertRaisesRegex(GovernanceError, "self_merge_frozen"):
            assert_self_merge_not_frozen(pr_number=43, head_sha="b" * 40, adapter=NO_NOTICES, base_dir=self.tools)

    def test_registering_the_same_revert_twice_writes_one_row(self) -> None:
        # ARIA-MEDIUM-228 — a producer resumed after a crash between the
        # registration and its own record registers again; that is a no-op.
        freeze_id = self._freeze()["freeze_id"]
        first = register_revert(freeze_id=freeze_id, pr_number=42, head_sha="b" * 40, purity=PURE,
                                base_dir=self.tools)
        second = register_revert(freeze_id=freeze_id, pr_number=42, head_sha="b" * 40, purity=PURE,
                                 base_dir=self.tools)
        self.assertEqual(first, second)
        text = freeze_ledger_path(self.tools).read_text(encoding="utf-8")
        self.assertEqual(text.count(REVERT_REGISTERED_EVENT), 1)
        # A different head is a different revert: it is registered and admitted.
        self._register(freeze_id, head_sha="c" * 40)
        self.assertEqual(active_freeze(base_dir=self.tools)["revert"], {"pr_number": 42, "head_sha": "c" * 40})

    def test_register_revert_documents_the_gate_it_actually_has(self) -> None:
        # ARIA-MEDIUM-228 (9) — it checks the caller's purity flag and a known
        # freeze, and the surface write gate; it proves neither purity nor
        # validation, and `pr_merge` in the profile is not what it requires.
        doc = inspect.getdoc(register_revert) or ""
        self.assertIn("does not prove", doc)
        self.assertNotIn("whose purity was proven", doc)
        module_doc = " ".join((inspect.getdoc(sys.modules[register_revert.__module__]) or "").split())
        self.assertNotIn("only a profile that grants ``pr_merge`` may write it", module_doc)

    def test_an_impure_revert_is_never_registered(self) -> None:
        freeze_id = self._freeze()["freeze_id"]
        with self.assertRaisesRegex(GovernanceError, "self_merge_revert_not_pure"):
            register_revert(
                freeze_id=freeze_id, pr_number=42, head_sha="b" * 40,
                purity={"pure": False}, base_dir=self.tools,
            )

    def test_a_revert_for_an_unknown_freeze_is_refused(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "self_merge_revert_unknown_freeze"):
            self._register("freeze-unknown")

    def test_an_environment_acknowledgment_cannot_unfreeze(self) -> None:
        freeze_id = self._freeze()["freeze_id"]
        with mock.patch.dict("os.environ", {"ARIA_UNFREEZE_ACK": "yes"}):
            with self.assertRaisesRegex(GovernanceError, "self_merge_unfreeze_approval_unrecorded.*gh:<owner>"):
                unfreeze_self_merge(
                    freeze_id=freeze_id, operator_approval_ref="ack-env:ARIA_UNFREEZE_ACK",
                    base_dir=self.tools,
                )
        self.assertIsNotNone(active_freeze(base_dir=self.tools))

    def test_a_governance_event_cannot_unfreeze_even_when_recorded(self) -> None:
        # ARIA-CRITICAL-216: ARIA writes governance events, so one that
        # exists proves nothing about an operator.
        freeze_id = self._freeze()["freeze_id"]
        event = append_tools_governance(self.tools, "operator_unfreeze_decision", {"by": "operator"})
        for ref in (f"gov:{event['event_id']}", "gov:evt-never-recorded"):
            with self.subTest(ref=ref), self.assertRaisesRegex(
                GovernanceError, "self_merge_unfreeze_approval_unrecorded",
            ):
                unfreeze_self_merge(freeze_id=freeze_id, operator_approval_ref=ref, base_dir=self.tools)
        self.assertIsNotNone(active_freeze(base_dir=self.tools))

    def test_the_act_must_name_this_freeze(self) -> None:
        freeze_id = self._freeze()["freeze_id"]
        with self.assertRaisesRegex(GovernanceError, "self_merge_unfreeze_approval_unrecorded"):
            unfreeze_self_merge(
                freeze_id=freeze_id, operator_approval_ref=self._operator_ref("freeze-other"),
                base_dir=self.tools,
            )
        self.assertIsNotNone(active_freeze(base_dir=self.tools))

    def test_an_operator_github_act_lifts_the_freeze(self) -> None:
        freeze_id = self._freeze()["freeze_id"]
        row = unfreeze_self_merge(
            freeze_id=freeze_id, operator_approval_ref=self._operator_ref(freeze_id), base_dir=self.tools,
        )
        self.assertEqual(row["approval"]["kind"], "gh")
        self.assertEqual(row["approval"]["scope"], {"freeze_id": freeze_id})
        self.assertIsNone(active_freeze(base_dir=self.tools))
        self.assertIsNone(assert_self_merge_not_frozen(pr_number=7, head_sha="c" * 40, adapter=NO_NOTICES, base_dir=self.tools))

    def test_the_revert_merging_does_not_lift_the_freeze(self) -> None:
        freeze_id = self._freeze()["freeze_id"]
        self._register(freeze_id)
        assert_self_merge_not_frozen(pr_number=42, head_sha="b" * 40, adapter=NO_NOTICES, base_dir=self.tools)
        with self.assertRaisesRegex(GovernanceError, "self_merge_frozen"):
            assert_self_merge_not_frozen(pr_number=44, head_sha="e" * 40, adapter=NO_NOTICES, base_dir=self.tools)

    def test_unfreezing_an_inactive_freeze_is_refused(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "self_merge_unfreeze_unknown_or_inactive"):
            unfreeze_self_merge(
                freeze_id="freeze-none", operator_approval_ref=self._operator_ref("freeze-none"),
                base_dir=self.tools,
            )


    def test_a_freeze_lands_under_any_profile_but_a_revert_needs_pr_merge(self) -> None:
        # A restriction must never be blocked by the profile; admitting a
        # merge must be.
        set_profile("frozen", operator_approval_ref="op:freeze", base_dir=self.tools)
        freeze_id = self._freeze()["freeze_id"]
        self.assertIsNotNone(active_freeze(base_dir=self.tools))
        with self.assertRaisesRegex(GovernanceError, "profile_violation: surface 'pr_merge'"):
            self._register(freeze_id)


    def test_the_operator_cli_lifts_a_freeze_and_refuses_ack_env(self) -> None:
        freeze_id = self._freeze()["freeze_id"]
        base = ["--tools-dir", str(self.tools), "merge-lane", "unfreeze", "--freeze-id", freeze_id]
        with mock.patch.dict("os.environ", {"ARIA_UNFREEZE_ACK": "yes"}):
            with self.assertRaisesRegex(GovernanceError, "self_merge_unfreeze_approval_unrecorded"):
                cli.main(base + ["--operator-approval-ref", "ack-env:ARIA_UNFREEZE_ACK"])
        with mock.patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(cli.main(base + ["--operator-approval-ref", self._operator_ref(freeze_id)]), 0)
        self.assertIsNone(active_freeze(base_dir=self.tools))


class MergeLaneReadsTheFreezeNoticeTests(unittest.TestCase):
    """ARIA-MEDIUM-227 (c) — the freeze reaches the merge lane at once.

    The cycle writes the freeze on its own host and publishes aria/state at
    its job's end, hours later; the merge lane restores that state. So the
    freeze's GitHub notice is itself a freeze: an open notice whose freeze
    this lane's state does not hold yet refuses every merge, and the ledger
    stays the authority for which revert is admitted and for the lift."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def _notice(self, freeze_id: str, number: int = 900) -> dict:
        return {"number": number, "title": freeze_notice_title(freeze_id)}

    def test_a_notice_for_a_freeze_this_state_has_not_received_refuses_every_merge(self) -> None:
        adapter = NoticeAdapter([self._notice(freeze_id_for(MERGE_SHA))])
        with self.assertRaisesRegex(GovernanceError, f"self_merge_frozen_by_notice:.*{freeze_id_for(MERGE_SHA)}"):
            assert_self_merge_not_frozen(pr_number=7, head_sha="c" * 40, adapter=adapter, base_dir=self.tools)
        self.assertEqual(adapter.asked, [list(FREEZE_NOTICE_LABELS)])

    def test_once_the_freeze_arrives_the_ledger_admits_its_registered_revert(self) -> None:
        freeze_id = freeze_self_merge(merge_sha=MERGE_SHA, pr_number=41, trigger="t", evidence={},
                                      base_dir=self.tools)["freeze_id"]
        register_revert(freeze_id=freeze_id, pr_number=42, head_sha="b" * 40, purity=PURE, base_dir=self.tools)
        adapter = NoticeAdapter([self._notice(freeze_id)])
        admitted = assert_self_merge_not_frozen(pr_number=42, head_sha="b" * 40, adapter=adapter,
                                                base_dir=self.tools)
        self.assertEqual(admitted["freeze_id"], freeze_id)
        with self.assertRaisesRegex(GovernanceError, "self_merge_frozen"):
            assert_self_merge_not_frozen(pr_number=7, head_sha="c" * 40, adapter=adapter, base_dir=self.tools)

    def test_a_notice_left_open_after_the_recorded_unfreeze_does_not_freeze(self) -> None:
        freeze_id = freeze_self_merge(merge_sha=MERGE_SHA, pr_number=41, trigger="t", evidence={},
                                      base_dir=self.tools)["freeze_id"]
        # The operator's recorded lift (how the act is proven is the
        # unfreeze's own contract, pinned above).
        append_declared_jsonl(
            freeze_ledger_path(self.tools),
            {"schema_version": 1, "recorded_at": "2026-09-26T00:00:00Z", "event": UNFROZEN_EVENT,
             "freeze_id": freeze_id, "merge_sha": MERGE_SHA, "operator_approval_ref": "fixture"},
            expected_surface="enterprise_self_merge_freeze", bypass_profile_gate=True,
        )
        adapter = NoticeAdapter([self._notice(freeze_id)])
        self.assertIsNone(assert_self_merge_not_frozen(pr_number=7, head_sha="c" * 40, adapter=adapter,
                                                       base_dir=self.tools))

    def test_an_unreadable_notice_list_refuses_rather_than_reading_as_none(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "self_merge_freeze_notices_unreadable"):
            assert_self_merge_not_frozen(pr_number=7, head_sha="c" * 40,
                                         adapter=NoticeAdapter(readable=False), base_dir=self.tools)

    def test_an_issue_without_the_notice_title_is_not_a_freeze(self) -> None:
        adapter = NoticeAdapter([{"number": 5, "title": "an unrelated aria issue"}])
        self.assertIsNone(assert_self_merge_not_frozen(pr_number=7, head_sha="c" * 40, adapter=adapter,
                                                       base_dir=self.tools))

    def test_a_malformed_notice_title_is_read_as_a_freeze(self) -> None:
        adapter = NoticeAdapter([{"number": 5, "title": freeze_notice_title("")}])
        with self.assertRaisesRegex(GovernanceError, "self_merge_frozen_by_notice"):
            assert_self_merge_not_frozen(pr_number=7, head_sha="c" * 40, adapter=adapter, base_dir=self.tools)


class FreezeNoticeTests(unittest.TestCase):
    """ARIA-MEDIUM-227 (b) — one issue per freeze, written only on change."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        self.freeze_id = freeze_self_merge(merge_sha=MERGE_SHA, pr_number=41, trigger="t", evidence={},
                                           base_dir=self.tools)["freeze_id"]
        self.writer = mock.Mock()
        self.writer.upsert_issue.return_value = {"outcome": "created", "number": 900, "url": "u/900"}
        self.writer.close_issue.return_value = {"outcome": "closed", "number": 900, "url": "u/900"}

    def _notice_rows(self) -> list[dict]:
        from aria_kernel.ledger import load_declared_jsonl

        return [row for row in load_declared_jsonl(freeze_ledger_path(self.tools),
                                                   expected_surface="enterprise_self_merge_freeze")
                if row.get("event") == NOTICE_EVENT]

    def test_an_unchanged_body_is_written_once(self) -> None:
        for _ in range(2):
            row = publish_freeze_notice(freeze_id=self.freeze_id, body="body", writer=self.writer,
                                        base_dir=self.tools)
        self.assertEqual(self.writer.upsert_issue.call_count, 1)
        self.assertEqual(self.writer.upsert_issue.call_args.kwargs["title"], freeze_notice_title(self.freeze_id))
        self.assertEqual(tuple(self.writer.upsert_issue.call_args.kwargs["labels"]), FREEZE_NOTICE_LABELS)
        self.assertEqual((row["status"], row["state"], row["issue_number"]), ("published", "open", 900))
        self.writer.upsert_issue.return_value = {"outcome": "updated", "number": 900, "url": "u/900"}
        publish_freeze_notice(freeze_id=self.freeze_id, body="body 2", writer=self.writer, base_dir=self.tools)
        self.assertEqual(self.writer.upsert_issue.call_count, 2)
        self.assertEqual(len(self._notice_rows()), 2)

    def test_a_failure_is_recorded_once_and_retried(self) -> None:
        self.writer.upsert_issue.return_value = {"outcome": "failed", "reason": "HTTP 403"}
        for _ in range(2):
            row = publish_freeze_notice(freeze_id=self.freeze_id, body="body", writer=self.writer,
                                        base_dir=self.tools)
        self.assertEqual(self.writer.upsert_issue.call_count, 2, "a failed notice is tried again")
        self.assertEqual((row["status"], row["reason"]), ("failed", "HTTP 403"))
        self.assertEqual(len(self._notice_rows()), 1, "an identical failure is recorded once")

    def test_a_recording_writer_writes_nothing_and_says_so(self) -> None:
        writer = RecordingGitHubAdapter(base_dir=self.tools, profile="observe")
        row = publish_freeze_notice(freeze_id=self.freeze_id, body="body", writer=writer, base_dir=self.tools)
        self.assertEqual(row["status"], "recorded_only")

    def test_a_notice_is_closed_once(self) -> None:
        publish_freeze_notice(freeze_id=self.freeze_id, body="body", writer=self.writer, base_dir=self.tools)
        for _ in range(2):
            close_freeze_notice(freeze_id=self.freeze_id, comment="lifted", writer=self.writer, base_dir=self.tools)
        self.assertEqual(self.writer.close_issue.call_count, 1)
        self.assertEqual(self._notice_rows()[-1]["state"], "closed")


class GhCliIssueWriterTests(unittest.TestCase):
    """The kernel's `gh` issue writer: exact title under the labels, one
    issue per title, and a transport failure is an outcome, never a raise."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.calls: list[list[str]] = []
        self.issues: list[dict] = []
        self.labels = ["aria"]
        self.fail_on: str | None = None
        # The lane writes on its installation token (ARIA-CRITICAL-246).
        credential = mock.patch.dict("os.environ", LANE_CREDENTIAL_ENV)
        credential.start()
        self.addCleanup(credential.stop)

    def _gh(self, argv: list[str], *args: object, **kwargs: object) -> object:
        import json
        import subprocess

        self.calls.append(list(argv))
        verb = " ".join(argv[1:3])
        if self.fail_on == verb:
            return subprocess.CompletedProcess(argv, 1, "", "HTTP 403: Resource not accessible")
        if verb == "issue list":
            return subprocess.CompletedProcess(argv, 0, json.dumps(
                [issue for issue in self.issues if issue["state"] == "OPEN"]), "")
        if verb == "label list":
            return subprocess.CompletedProcess(argv, 0, json.dumps([{"name": name} for name in self.labels]), "")
        if verb == "label create":
            self.labels.append(argv[3])
            return subprocess.CompletedProcess(argv, 0, "", "")
        if verb == "issue create":
            number = 900 + len(self.issues)
            self.issues.append({"number": number, "title": argv[argv.index("--title") + 1],
                                "url": f"https://github.com/o/r/issues/{number}", "state": "OPEN"})
            return subprocess.CompletedProcess(argv, 0, f"https://github.com/o/r/issues/{number}\n", "")
        if verb in {"issue edit", "issue close"}:
            if verb == "issue close":
                for issue in self.issues:
                    if issue["number"] == int(argv[3]):
                        issue["state"] = "CLOSED"
            return subprocess.CompletedProcess(argv, 0, "", "")
        raise AssertionError(f"unexpected gh call {argv}")

    def _writer(self) -> GhCliIssueWriter:
        return GhCliIssueWriter(cwd=self.tmp.name)

    def test_create_then_update_the_same_title(self) -> None:
        with mock.patch("aria_kernel.github_adapters.subprocess.run", side_effect=self._gh):
            created = self._writer().upsert_issue(title="T: freeze-1", body="one", labels=FREEZE_NOTICE_LABELS)
            updated = self._writer().upsert_issue(title="T: freeze-1", body="two", labels=FREEZE_NOTICE_LABELS)
        self.assertEqual((created["outcome"], created["number"]), ("created", 900))
        self.assertEqual((updated["outcome"], updated["number"]), ("updated", 900))
        self.assertEqual(len(self.issues), 1)
        self.assertIn("self-merge-freeze", self.labels, "a missing label is created before the issue")
        listed = [call for call in self.calls if call[1:3] == ["issue", "list"]][0]
        self.assertEqual([listed[i + 1] for i, arg in enumerate(listed) if arg == "--label"],
                         list(FREEZE_NOTICE_LABELS))

    def test_close_finds_the_title_and_an_absent_one_is_absent(self) -> None:
        with mock.patch("aria_kernel.github_adapters.subprocess.run", side_effect=self._gh):
            self._writer().upsert_issue(title="T: freeze-1", body="one", labels=FREEZE_NOTICE_LABELS)
            closed = self._writer().close_issue(title="T: freeze-1", labels=FREEZE_NOTICE_LABELS, comment="lifted")
            absent = self._writer().close_issue(title="T: freeze-1", labels=FREEZE_NOTICE_LABELS, comment="lifted")
        self.assertEqual((closed["outcome"], closed["number"]), ("closed", 900))
        self.assertEqual(absent["outcome"], "absent")

    def test_a_refused_write_is_a_failed_outcome(self) -> None:
        self.fail_on = "issue create"
        with mock.patch("aria_kernel.github_adapters.subprocess.run", side_effect=self._gh):
            result = self._writer().upsert_issue(title="T: freeze-1", body="one", labels=FREEZE_NOTICE_LABELS)
        self.assertEqual(result["outcome"], "failed")
        self.assertIn("HTTP 403", result["reason"])

    def test_a_write_on_a_user_credential_is_a_failed_outcome_and_never_runs(self) -> None:
        # ARIA-CRITICAL-246 — the operator's PAT would author the issue as the
        # operator. The writer reads (the list) but runs no write, and says why.
        with mock.patch.dict("os.environ", {"GH_TOKEN": "ghp_operator_pat"}), \
                mock.patch("aria_kernel.github_adapters.subprocess.run", side_effect=self._gh):
            result = self._writer().upsert_issue(title="T: freeze-1", body="one", labels=FREEZE_NOTICE_LABELS)
        self.assertEqual(result["outcome"], "failed")
        self.assertIn("github_write_requires_installation_token:personal_access_token", result["reason"])
        self.assertEqual([call[1:3] for call in self.calls if call[2] not in ("list", "view")], [])
        self.assertEqual(self.issues, [])

    def test_an_unreadable_issue_list_creates_nothing(self) -> None:
        self.fail_on = "issue list"
        with mock.patch("aria_kernel.github_adapters.subprocess.run", side_effect=self._gh):
            result = self._writer().upsert_issue(title="T: freeze-1", body="one", labels=FREEZE_NOTICE_LABELS)
        self.assertEqual(result["outcome"], "failed")
        self.assertEqual(self.issues, [])

    def test_the_writer_is_real_for_every_profile_that_can_merge_and_recording_otherwise(self) -> None:
        for profile in ("standard", "strict", "autonomous"):
            with mock.patch.dict("os.environ", {"ARIA_DRY_RUN": ""}):
                self.assertIsInstance(select_issue_writer(profile=profile, base_dir=self.tmp.name, cwd="."),
                                      GhCliIssueWriter)
        for profile in ("observe", "frozen"):
            self.assertIsInstance(select_issue_writer(profile=profile, base_dir=self.tmp.name, cwd="."),
                                  RecordingGitHubAdapter)
        with mock.patch.dict("os.environ", {"ARIA_DRY_RUN": "true"}):
            self.assertIsInstance(select_issue_writer(profile="strict", base_dir=self.tmp.name, cwd="."),
                                  RecordingGitHubAdapter)


class MergeAuthorityReadsTheFreezeTests(unittest.TestCase):
    def test_the_freeze_is_read_at_the_single_real_merge_authority_before_any_evidence(self) -> None:
        source = inspect.getsource(merge_authority.merge_pr_if_ready)
        freeze_at = source.index("assert_self_merge_not_frozen(")
        self.assertLess(source.index("head_sha = _head_sha(live_pr)"), freeze_at)
        self.assertLess(freeze_at, source.index("record_risk_decision_for_pr("))
        # ARIA-MEDIUM-227 — with the lane's adapter, so the freeze's GitHub
        # notice is read, not only the state this lane restored.
        call = source[freeze_at:source.index(")", freeze_at)]
        self.assertIn("adapter=adapter", call)


if __name__ == "__main__":
    unittest.main()
