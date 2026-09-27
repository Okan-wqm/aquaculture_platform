"""Plan 032 Faz 032f — event gateway: hardened ingress, closed vocabularies, deterministic routing.

Invariants:
  I-V12-GW-01  GitHub deliveries are accepted only with a valid X-Hub-Signature-256;
               a replayed delivery id is 409; bodies over the cap are 413; the
               operator ingress needs the bearer AND an allowlisted actor; every
               rejection is an inbox `rejected` row + `gateway_rejected` governance.
  I-V12-GW-02  normalizers map onto the closed EVENT_KINDS (unknown → ignored, never
               a new kind); the inbox accepts once per delivery id.
  I-V12-GW-03  routing is deterministic and closed: `aria`-labelled issue → mission
               (source_kind github_issue, idempotent on replay); PR → pr-events row;
               failed CI / firing alert → runtime signal; operator verb → control
               ledger; unlabelled issue → ignored; a routing exception is an outcome
               row, never a crash.
  I-V12-GW-04  the schedule vocabulary is closed (a free prompt is a ValueError),
               cron parsing is strict, `due_schedules` fires once per minute, workflow
               actions are skipped under operator pause and otherwise dispatch via
               `gh workflow run <repo workflow>`.
  I-V12-GW-05  the daemon holds the pid lock + host lease, writes the heartbeat on
               every tick, exits on ARIA_STOP, and a second instance refuses.
  I-V12-GW-06  PlanCandidateSource gains exactly GITHUB_ISSUE (one-way door 14) and
               the synthesizer scans gateway missions; doctor carries the `gateway`
               organ; the unit, nginx location, provisioning and runbook exist.

NOT RUN at authoring time (operator instruction 2026-09-03).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import subprocess
import tempfile
import threading
import unittest
from unittest import mock
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from tests.invariants.v12 import _helpers  # noqa: F401 — sys.path

from aria_kernel.control import effective_control
from aria_kernel.doctor import run_doctor
from aria_kernel.gateway import daemon as gd
from aria_kernel.gateway import inbox as gi
from aria_kernel.gateway import normalize as gn
from aria_kernel.gateway import router as gr
from aria_kernel.gateway import scheduler as gs
from aria_kernel.gateway import server as gsrv
from aria_kernel.mission import list_open_missions
from aria_kernel.plan_candidate_source import PlanCandidateSource
from aria_kernel.tool_registry import ensure_tools_dir

_REPO_ROOT = Path(__file__).resolve().parents[4]
_ENV = {"ARIA_GITHUB_WEBHOOK_SECRET": "s3cret", "ARIA_ALERTMANAGER_BEARER": "am-bearer", "ARIA_OPERATOR_BEARER": "op-bearer",
        "ARIA_GATEWAY_ACTOR_ALLOWLIST": "okan,ops-bot"}


def _issue_payload(number: int, labels: list[str], action: str = "labeled") -> dict:
    return {"action": action, "issue": {"number": number, "title": f"Issue {number}", "labels": [{"name": l} for l in labels],
                                        "html_url": f"https://github.com/o/r/issues/{number}", "body": "details"},
            "sender": {"login": "okan"}, "repository": {"full_name": "o/r"}}


def _sign(body: bytes) -> str:
    return "sha256=" + hmac.new(b"s3cret", body, hashlib.sha256).hexdigest()


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.ws = self.root / "repo"
        self.ws.mkdir()
        subprocess.run(["git", "init", "-q", str(self.ws)], check=True)
        self.tools = ensure_tools_dir(self.root / "aria-tools")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def governance(self) -> str:
        path = self.tools / "governance.jsonl"
        return path.read_text(encoding="utf-8") if path.exists() else ""


class Ingress(_Store):
    def _serve(self) -> tuple[int, object]:
        cfg = gsrv.GatewayConfig(port=0, environ=_ENV, max_body_bytes=4096)
        server, state = gsrv.build_server(config=cfg, base_dir=self.tools, workspace_root=self.ws)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.2}, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server.server_address[1], state

    @staticmethod
    def _post(port: int, path: str, body: bytes, headers: dict) -> tuple[int, dict]:
        request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=body, method="POST", headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:  # allowlist-external-network: loopback gateway under test (127.0.0.1, ephemeral port)
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read())

    def test_I_V12_GW_01_signature_replay_size_bearer_actor(self) -> None:
        port, state = self._serve()
        body = json.dumps(_issue_payload(7, ["aria"])).encode("utf-8")
        gh = {"X-GitHub-Event": "issues", "X-GitHub-Delivery": "d-1", "Content-Type": "application/json"}
        self.assertEqual(self._post(port, "/aria/webhook/github", body, {**gh, "X-Hub-Signature-256": "sha256=" + "0" * 64})[0], 401)
        self.assertEqual(self._post(port, "/aria/webhook/github", body, gh)[0], 401, "missing signature")
        code, out = self._post(port, "/aria/webhook/github", body, {**gh, "X-Hub-Signature-256": _sign(body)})
        self.assertEqual((code, out["accepted"]), (202, ["d-1"]))
        self.assertEqual(self._post(port, "/aria/webhook/github", body, {**gh, "X-Hub-Signature-256": _sign(body)})[0], 409, "replayed delivery")
        big = json.dumps({"pad": "x" * 5000}).encode("utf-8")
        self.assertEqual(self._post(port, "/aria/webhook/github", big, {**gh, "X-GitHub-Delivery": "d-2", "X-Hub-Signature-256": _sign(big)})[0], 413)
        op = json.dumps({"verb": "pause", "reason": "deploy"}).encode("utf-8")
        self.assertEqual(self._post(port, "/aria/webhook/operator", op, {"X-Aria-Actor": "okan"})[0], 401)
        self.assertEqual(self._post(port, "/aria/webhook/operator", op, {"Authorization": "Bearer op-bearer", "X-Aria-Actor": "mallory"})[0], 403)
        self.assertEqual(self._post(port, "/aria/webhook/operator", op, {"Authorization": "Bearer op-bearer", "X-Aria-Actor": "okan"})[0], 202)
        am = json.dumps({"receiver": "aria", "alerts": [{"status": "firing", "labels": {"alertname": "A", "severity": "critical"}, "annotations": {}, "fingerprint": "f"}]}).encode("utf-8")
        self.assertEqual(self._post(port, "/aria/webhook/alertmanager", am, {"Authorization": "Bearer wrong"})[0], 401)
        self.assertEqual(self._post(port, "/aria/webhook/alertmanager", am, {"Authorization": "Bearer am-bearer"})[0], 202)
        self.assertEqual(self._post(port, "/aria/webhook/nope", body, gh)[0], 404)
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/aria/status", timeout=60) as response:  # allowlist-external-network: loopback gateway under test
            status = json.loads(response.read())
        self.assertEqual(status["inbox"]["accepted"], 3)
        self.assertGreaterEqual(status["rejected"], 5)
        self.assertNotIn("s3cret", json.dumps(status))
        rows = gi.read_inbox(self.tools)
        self.assertEqual(sum(1 for r in rows if r["event"] == "rejected"), status["rejected"])
        self.assertIn(gi.GATEWAY_REJECTED_EVENT, self.governance())
        self.assertTrue(gsrv.verify_github_signature(secret="s3cret", body=body, signature_header=_sign(body)))
        self.assertFalse(gsrv.verify_github_signature(secret=None, body=body, signature_header=_sign(body)))
        self.assertFalse(gsrv.verify_bearer(expected="x", authorization_header="Basic x"))


class NormalizeAndInbox(_Store):
    def test_I_V12_GW_02_closed_kinds_and_idempotent_inbox(self) -> None:
        self.assertIsNone(gn.normalize_github("issues", "d", _issue_payload(1, ["aria"], action="closed")))
        self.assertIsNone(gn.normalize_github("star", "d", {"action": "created"}))
        event = gn.normalize_github("issues", "d-1", _issue_payload(1, ["aria", "bug"]))
        assert event is not None
        self.assertEqual((event.kind, event.subject["labels"], event.actor), ("github.issue_labeled", ["aria", "bug"], "okan"))
        self.assertNotIn("details", json.dumps(event.to_dict()), "issue bodies never enter the inbox")
        pr = gn.normalize_github("pull_request", "d-2", {"action": "closed", "pull_request": {"number": 4, "merged": True, "merged_at": "t", "head": {"sha": "a" * 40, "ref": "x"}, "base": {"sha": "b" * 40}, "user": {"login": "u"}, "labels": []}, "sender": {"login": "u"}, "repository": {"full_name": "o/r"}})
        assert pr is not None
        self.assertEqual((pr.kind, pr.subject["merged"]), ("github.pr_closed", True))
        ci = gn.normalize_github("workflow_run", "d-3", {"action": "completed", "workflow_run": {"id": 1, "name": "aria-kernel", "conclusion": "success"}})
        self.assertIsNone(ci, "green runs are not events")
        alerts = gn.normalize_alertmanager("am", {"alerts": [{"status": "firing", "labels": {"alertname": "A"}}, {"status": "resolved", "labels": {"alertname": "A"}}]})
        self.assertEqual([a.kind for a in alerts], ["alertmanager.firing", "alertmanager.resolved"])
        for kind in {e.kind for e in (event, pr, *alerts)}:
            self.assertIn(kind, gn.EVENT_KINDS)
        with self.assertRaises(ValueError):
            gn._event("github.star", "d", "github", occurred_at=None, actor=None, subject={}, payload={})
        self.assertIsNotNone(gi.record_event(event, base_dir=self.tools))
        self.assertIsNone(gi.record_event(event, base_dir=self.tools), "second accept of the same delivery writes nothing")
        self.assertEqual([e.delivery_id for e in gi.pending_events(self.tools)], ["d-1"])
        self.assertEqual(gi.inbox_summary(self.tools)["pending"], 1)


class Routing(_Store):
    def _ingest(self, event) -> None:
        self.assertIsNotNone(gi.record_event(event, base_dir=self.tools))

    def _assert_mission_attempts(self, event, expected_count: int, *, tools: Path | None = None) -> list[dict]:
        from aria_kernel.mission import mission_id_for
        from aria_kernel.workspace import canonical_identity

        root = tools if tools is not None else self.tools
        history = gi.read_inbox(root)
        accepted = [row for row in history if row["event"] == "accepted" and row["delivery_id"] == event.delivery_id]
        self.assertEqual(len(accepted), 1)
        attempts = [row for row in history if row["event"] == "mission_route_attempt" and row["delivery_id"] == event.delivery_id]
        self.assertEqual(len(attempts), expected_count)
        repo_hash = canonical_identity(self.ws)
        source_id = f"issue-{event.subject['number']}"
        for index, row in enumerate(attempts, start=1):
            binding = row["mission_route"]
            self.assertEqual(row["action"], "mission_open")
            self.assertEqual(
                (binding["schema_version"], binding["owner"], binding["accepted_ledger_hash"],
                 binding["payload_digest"], binding["event_kind"], binding["source_kind"],
                 binding["source_id"], binding["repo_hash"], binding["mission_id"], binding["attempt"]),
                (1, "gateway.github_issue_mission.v1", accepted[0]["ledger_hash"],
                 event.payload_digest, event.kind, "github_issue", source_id, repo_hash,
                 mission_id_for("github_issue", source_id, repo_hash), index),
            )
        return attempts

    def test_issue_mission_recovers_on_later_tick_after_pre_effect_io_failure(self) -> None:
        event = gn.normalize_github("issues", "issue-47-delivery", _issue_payload(47, ["aria"]))
        assert event is not None
        self._ingest(event)
        self.assertEqual(gs.fold_schedules(self.tools), {})

        # The first mission call fails before it writes anything. Later ticks
        # use the real mission owner, with the original accepted delivery.
        with mock.patch("aria_kernel.mission.open_mission", side_effect=OSError("mission storage temporarily unavailable")) as first_open:
            first = gs.tick(base_dir=self.tools, workspace_root=self.ws,
                            now=datetime(2026, 9, 11, 1, 0, tzinfo=timezone.utc))
        first_open.assert_called_once()
        self.assertEqual(first_open.call_args.kwargs["base_dir"], self.tools)
        self.assertEqual((first_open.call_args.kwargs["source_kind"], first_open.call_args.kwargs["source_id"]),
                         ("github_issue", "issue-47"))
        self.assertEqual(first["ran"], [])
        self.assertEqual([row["delivery_id"] for row in first["routed"]], ["issue-47-delivery"])
        self.assertEqual(first["routed"][0]["error"], "OSError: mission storage temporarily unavailable")
        self.assertEqual(list_open_missions(base_dir=self.tools), [])
        first_history = gi.read_inbox(self.tools)
        self.assertEqual([row["event"] for row in first_history], ["accepted", "mission_route_attempt", "routed"])
        self.assertEqual(first_history[-1]["error"], first["routed"][0]["error"])
        attempts = self._assert_mission_attempts(event, 1)
        self.assertEqual(first_history[-1]["refs"]["mission_route"]["attempt_ledger_hash"], attempts[0]["ledger_hash"])
        self.assertEqual(first_history[-1]["refs"]["mission_route"]["status"], "retryable_error")
        self.assertEqual(gi.inbox_summary(self.tools)["pending"], 1)
        before_due = gs.tick(base_dir=self.tools, workspace_root=self.ws,
                             now=datetime(2026, 9, 11, 1, 0, 59, tzinfo=timezone.utc))
        self.assertEqual(before_due["routed"], [])
        self.assertEqual(gi.read_inbox(self.tools), first_history)

        second = gs.tick(base_dir=self.tools, workspace_root=self.ws,
                         now=datetime(2026, 9, 11, 1, 1, tzinfo=timezone.utc))
        self.assertEqual(
            [(row["delivery_id"], row["action"], row["error"]) for row in second["routed"]],
            [("issue-47-delivery", "mission_open", None)],
        )
        missions = list_open_missions(base_dir=self.tools)
        self.assertEqual(len(missions), 1)
        self.assertEqual(
            (missions[0]["source_kind"], missions[0]["source_id"], missions[0]["title"],
             missions[0]["next_action"], missions[0]["wake_condition"]),
            ("github_issue", "issue-47", "GitHub issue #47: Issue 47", "triage_github_issue",
             {"kind": "timer", "key": "github_issue:47"}),
        )
        self.assertEqual(second["routed"][0]["refs"]["mission_id"], missions[0]["mission_id"])
        history = gi.read_inbox(self.tools)
        self.assertEqual(sum(row["event"] == "accepted" for row in history), 1)
        successful = [row for row in history if row["event"] == "routed" and row.get("error") is None]
        self.assertEqual([(row["delivery_id"], row["refs"]["mission_id"]) for row in successful],
                         [("issue-47-delivery", missions[0]["mission_id"])])

        third = gs.tick(base_dir=self.tools, workspace_root=self.ws,
                        now=datetime(2026, 9, 11, 1, 2, tzinfo=timezone.utc))
        self.assertEqual(third["routed"], [])
        self.assertEqual(list_open_missions(base_dir=self.tools), missions)
        self.assertEqual(gi.read_inbox(self.tools), history)
        self.assertEqual(gi.pending_events(self.tools), [])

    def test_issue_mission_backoff_exhausts_three_durable_attempts(self) -> None:
        event = gn.normalize_github("issues", "issue-48-delivery", _issue_payload(48, ["aria"]))
        assert event is not None
        self._ingest(event)
        start = datetime(2026, 9, 11, 2, 0, tzinfo=timezone.utc)
        with mock.patch("aria_kernel.mission.open_mission", side_effect=OSError("mission storage temporarily unavailable")) as opening:
            for seconds, expected_calls in ((0, 1), (59, 1), (60, 2), (179, 2), (180, 3), (240, 3), (420, 3)):
                outcome = gs.tick(base_dir=self.tools, workspace_root=self.ws, now=start + timedelta(seconds=seconds))
                self.assertEqual(opening.call_count, expected_calls, f"tick at +{seconds}s")
                if seconds in (59, 179, 420):
                    self.assertEqual(outcome["routed"], [])
        attempts = self._assert_mission_attempts(event, 3)
        self.assertEqual([row["mission_route"]["attempted_at"] for row in attempts],
                         [(start + timedelta(seconds=offset)).isoformat() for offset in (0, 60, 180)])
        self.assertEqual([row["mission_route"]["next_attempt_not_before"] for row in attempts],
                         [(start + timedelta(seconds=60)).isoformat(), (start + timedelta(seconds=180)).isoformat(), None])
        final = gi.read_inbox(self.tools)[-1]
        self.assertEqual(final["refs"]["mission_route"]["status"], "exhausted")
        self.assertEqual(final["refs"]["mission_route"]["attempt_ledger_hash"], attempts[-1]["ledger_hash"])
        self.assertEqual(list_open_missions(base_dir=self.tools), [])
        self.assertEqual(gi.pending_events(self.tools), [])
        self.assertEqual(gi.inbox_summary(self.tools)["pending"], 0)

    def test_issue_mission_permanent_failure_is_not_retried(self) -> None:
        event = gn.normalize_github("issues", "issue-49-delivery", _issue_payload(49, ["aria"]))
        assert event is not None
        self._ingest(event)
        start = datetime(2026, 9, 11, 3, 0, tzinfo=timezone.utc)
        with mock.patch("aria_kernel.mission.open_mission", side_effect=ValueError("invalid mission input")) as opening:
            first = gs.tick(base_dir=self.tools, workspace_root=self.ws, now=start)
            self.assertEqual(first["routed"][0]["error"], "ValueError: invalid mission input")
            history = gi.read_inbox(self.tools)
            later = gs.tick(base_dir=self.tools, workspace_root=self.ws, now=start + timedelta(hours=1))
        opening.assert_called_once()
        self.assertEqual(later["routed"], [])
        self.assertEqual(gi.read_inbox(self.tools), history)
        attempts = self._assert_mission_attempts(event, 1)
        self.assertEqual(history[-1]["refs"]["mission_route"]["status"], "permanent_error")
        self.assertEqual(history[-1]["refs"]["mission_route"]["attempt_ledger_hash"], attempts[0]["ledger_hash"])
        self.assertEqual(list_open_missions(base_dir=self.tools), [])
        self.assertEqual(gi.inbox_summary(self.tools)["pending"], 0)

    def test_issue_mission_does_not_dispatch_without_durable_reservation(self) -> None:
        from aria_kernel import mission

        event = gn.normalize_github("issues", "issue-50-delivery", _issue_payload(50, ["aria"]))
        assert event is not None
        self._ingest(event)
        accepted_bytes = gi.inbox_path(self.tools).read_bytes()
        append = gi._append
        rejected_attempts: list[dict] = []

        def unavailable_reservation(base_dir, row):
            if row.get("event") == "mission_route_attempt":
                rejected_attempts.append(row)
                raise OSError("inbox reservation storage temporarily unavailable")
            return append(base_dir, row)

        start = datetime(2026, 9, 11, 4, 0, tzinfo=timezone.utc)
        with mock.patch.object(gi, "_append", side_effect=unavailable_reservation), \
                mock.patch.object(mission, "open_mission", wraps=mission.open_mission) as opening:
            with self.assertRaisesRegex(OSError, "inbox reservation storage temporarily unavailable"):
                gs.tick(base_dir=self.tools, workspace_root=self.ws, now=start)
        self.assertEqual(len(rejected_attempts), 1)
        opening.assert_not_called()
        self.assertEqual(gi.inbox_path(self.tools).read_bytes(), accepted_bytes)
        self.assertEqual(list_open_missions(base_dir=self.tools), [])
        recovered = gs.tick(base_dir=self.tools, workspace_root=self.ws, now=start + timedelta(minutes=1))
        self.assertEqual([(row["action"], row["error"]) for row in recovered["routed"]], [("mission_open", None)])
        attempts = self._assert_mission_attempts(event, 1)
        self.assertEqual(list_open_missions(base_dir=self.tools)[0]["mission_id"], attempts[0]["mission_route"]["mission_id"])

    def test_issue_mission_dispatch_stays_bounded_when_outcome_writes_fail(self) -> None:
        from aria_kernel import mission

        event = gn.normalize_github("issues", "issue-51-delivery", _issue_payload(51, ["aria"]))
        assert event is not None
        self._ingest(event)
        start = datetime(2026, 9, 11, 5, 0, tzinfo=timezone.utc)
        with mock.patch("aria_kernel.mission.open_mission", side_effect=OSError("mission storage temporarily unavailable")) as opening, \
                mock.patch.object(gr, "mark_routed", side_effect=OSError("inbox outcome storage temporarily unavailable")) as recording:
            for seconds in (0, 60, 180, 240, 420):
                with self.assertRaisesRegex(OSError, "inbox outcome storage temporarily unavailable"):
                    gs.tick(base_dir=self.tools, workspace_root=self.ws, now=start + timedelta(seconds=seconds))
            self.assertEqual(recording.call_count, 5)
            self.assertEqual(opening.call_count, 3, "A lost outcome cannot authorize an unreserved fourth mission call.")
        attempts = self._assert_mission_attempts(event, 3)
        self.assertEqual([row["event"] for row in gi.read_inbox(self.tools)],
                         ["accepted", "mission_route_attempt", "mission_route_attempt", "mission_route_attempt"])
        self.assertEqual(list_open_missions(base_dir=self.tools), [])
        with mock.patch.object(mission, "open_mission", wraps=mission.open_mission) as fourth:
            recovered = gs.tick(base_dir=self.tools, workspace_root=self.ws, now=start + timedelta(minutes=10))
        fourth.assert_not_called()
        self.assertEqual(len(recovered["routed"]), 1)
        final = gi.read_inbox(self.tools)[-1]
        self.assertEqual(final["refs"]["mission_route"]["status"], "exhausted")
        self.assertEqual(final["refs"]["mission_route"]["attempt_ledger_hash"], attempts[-1]["ledger_hash"])
        self.assertEqual(gi.inbox_summary(self.tools)["pending"], 0)

    def test_issue_mission_reconciles_created_state_without_another_dispatch(self) -> None:
        from aria_kernel import mission

        start = datetime(2026, 9, 11, 6, 0, tzinfo=timezone.utc)
        for number, state in enumerate(("DISCOVERED", "HUMAN_REQUIRED", "CANCELLED_BY_CONSTITUTION"), start=52):
            with self.subTest(state=state):
                tools = ensure_tools_dir(self.root / f"case-{state}" / "aria-tools")
                event = gn.normalize_github("issues", f"issue-{number}-delivery", _issue_payload(number, ["aria"]))
                assert event is not None
                self.assertIsNotNone(gi.record_event(event, base_dir=tools))
                with mock.patch.object(mission, "open_mission", wraps=mission.open_mission) as opening, \
                        mock.patch.object(gr, "mark_routed", side_effect=OSError("inbox outcome storage temporarily unavailable")) as recording:
                    with self.assertRaisesRegex(OSError, "inbox outcome storage temporarily unavailable"):
                        gs.tick(base_dir=tools, workspace_root=self.ws, now=start)
                opening.assert_called_once()
                recording.assert_called_once()
                self.assertEqual(len(list_open_missions(base_dir=tools)), 1)
                mission_id = list_open_missions(base_dir=tools)[0]["mission_id"]
                if state != "DISCOVERED":
                    mission.transition_mission(
                        mission_id=mission_id, to_state=state, reason_code="ordinary_lifecycle_before_inbox_recovery",
                        step_id=f"gateway-recovery-{state}",
                        next_action="await_operator" if state == "HUMAN_REQUIRED" else None,
                        wake_condition={"kind": "evidence", "key": "operator-issue-review"} if state == "HUMAN_REQUIRED" else None,
                        base_dir=tools,
                    )
                before_state = mission.fold_mission(mission_id=mission_id, base_dir=tools)
                self.assertEqual(before_state["state"], state)
                before_mission_bytes = mission.events_path(tools).read_bytes()
                with mock.patch.object(mission, "open_mission", wraps=mission.open_mission) as replay:
                    recovered = gs.tick(base_dir=tools, workspace_root=self.ws, now=start + timedelta(minutes=1))
                replay.assert_not_called()
                self.assertEqual([(row["action"], row["error"]) for row in recovered["routed"]], [("mission_open", None)])
                self.assertEqual(recovered["routed"][0]["refs"]["mission_id"], mission_id)
                self.assertEqual(recovered["routed"][0]["refs"]["mission_route"]["status"], "reconciled")
                attempts = self._assert_mission_attempts(event, 1, tools=tools)
                self.assertEqual(recovered["routed"][0]["refs"]["mission_route"]["attempt_ledger_hash"], attempts[0]["ledger_hash"])
                self.assertEqual(mission.fold_mission(mission_id=mission_id, base_dir=tools), before_state)
                self.assertEqual(mission.events_path(tools).read_bytes(), before_mission_bytes)
                history = gi.read_inbox(tools)
                self.assertEqual(gs.tick(base_dir=tools, workspace_root=self.ws,
                                         now=start + timedelta(minutes=2))["routed"], [])
                self.assertEqual(gi.read_inbox(tools), history)
                self.assertEqual(mission.events_path(tools).read_bytes(), before_mission_bytes)
                self.assertEqual(gi.inbox_summary(tools)["pending"], 0)

    def test_scheduled_inbox_action_uses_tick_clock_for_mission_retry(self) -> None:
        from aria_kernel import mission

        event = gn.normalize_github("issues", "issue-54-scheduled", _issue_payload(54, ["aria"]))
        assert event is not None
        self._ingest(event)
        gs.add_schedule(name="mission-inbox", action="inbox_drain", cron="* * * * *", base_dir=self.tools)
        start = datetime(2026, 9, 11, 2, 0, 30, tzinfo=timezone.utc)
        external_runner = mock.Mock(side_effect=AssertionError("local inbox schedule must not invoke a workflow"))

        with mock.patch("aria_kernel.mission.open_mission", side_effect=OSError("scheduled mission storage unavailable")) as first_open:
            first = gs.tick(base_dir=self.tools, workspace_root=self.ws, now=start,
                            runner=external_runner, drain_inbox_first=False)
        self.assertEqual(first["routed"], [])
        self.assertEqual([(row["action"], row["status"], row["detail"]) for row in first["ran"]],
                         [("inbox_drain", "ran", {"routed": 1, "errors": 1})])
        first_attempt = self._assert_mission_attempts(event, 1)[0]
        first_open.assert_called_once_with(
            source_kind="github_issue", source_id="issue-54", repo_hash=first_attempt["mission_route"]["repo_hash"],
            title="GitHub issue #54: Issue 54", next_action="triage_github_issue",
            wake_condition={"kind": "timer", "key": "github_issue:54"}, priority=1, base_dir=self.tools,
        )
        self.assertEqual(first_attempt["mission_route"]["attempted_at"], start.isoformat())
        self.assertEqual(first_attempt["mission_route"]["next_attempt_not_before"], (start + timedelta(seconds=60)).isoformat())
        self.assertEqual(gs.fold_schedules(self.tools)["mission-inbox"].last_ran_at, start.isoformat())
        self.assertEqual(list_open_missions(base_dir=self.tools), [])
        first_history = gi.read_inbox(self.tools)
        self.assertEqual(first_history[-1]["error"], "OSError: scheduled mission storage unavailable")

        with mock.patch("aria_kernel.mission.open_mission", wraps=mission.open_mission) as subsequent_open:
            # The next cron minute is only30s later, before the retry is due.
            early = gs.tick(base_dir=self.tools, workspace_root=self.ws, now=start + timedelta(seconds=30),
                            runner=external_runner, drain_inbox_first=False)
            self.assertEqual(early["routed"], [])
            self.assertEqual([row["detail"] for row in early["ran"]], [{"routed": 0, "errors": 0}])
            subsequent_open.assert_not_called()
            self.assertEqual(gi.read_inbox(self.tools), first_history)

            due = start + timedelta(seconds=90)
            recovered = gs.tick(base_dir=self.tools, workspace_root=self.ws, now=due,
                                runner=external_runner, drain_inbox_first=False)
            self.assertEqual(recovered["routed"], [])
            self.assertEqual([row["detail"] for row in recovered["ran"]], [{"routed": 1, "errors": 0}])
            subsequent_open.assert_called_once_with(**first_open.call_args.kwargs)
            attempts = self._assert_mission_attempts(event, 2)
            self.assertEqual(attempts[1]["mission_route"]["attempted_at"], due.isoformat())
            self.assertEqual(gs.fold_schedules(self.tools)["mission-inbox"].last_ran_at, due.isoformat())
            history = gi.read_inbox(self.tools)
            missions = list_open_missions(base_dir=self.tools)
            self.assertEqual(len(missions), 1)
            self.assertEqual(history[-1]["refs"]["mission_id"], missions[0]["mission_id"])
            self.assertEqual(history[-1]["refs"]["mission_route"]["status"], "succeeded")
            self.assertEqual(history[-1]["refs"]["mission_route"]["attempt_ledger_hash"], attempts[1]["ledger_hash"])
            mission_bytes = mission.events_path(self.tools).read_bytes()

            same_minute = gs.tick(base_dir=self.tools, workspace_root=self.ws, now=due + timedelta(seconds=1),
                                  runner=external_runner, drain_inbox_first=False)
            self.assertEqual((same_minute["routed"], same_minute["ran"]), ([], []))
            later = gs.tick(base_dir=self.tools, workspace_root=self.ws, now=due + timedelta(seconds=60),
                            runner=external_runner, drain_inbox_first=False)
            self.assertEqual(later["routed"], [])
            self.assertEqual([row["detail"] for row in later["ran"]], [{"routed": 0, "errors": 0}])
            subsequent_open.assert_called_once()
            self.assertEqual(gi.read_inbox(self.tools), history)
            self.assertEqual(mission.events_path(self.tools).read_bytes(), mission_bytes)
        external_runner.assert_not_called()
        self.assertEqual(gi.inbox_summary(self.tools)["pending"], 0)

    def test_I_V12_GW_03_deterministic_closed_routes(self) -> None:
        self._ingest(gn.normalize_github("issues", "i-7", _issue_payload(7, ["aria"])))
        self._ingest(gn.normalize_github("issues", "i-8", _issue_payload(8, ["bug"])))
        self._ingest(gn.normalize_github("pull_request", "pr-3", {"action": "opened", "pull_request": {"number": 3, "head": {"sha": "a" * 40, "ref": "aria-impl-1"}, "base": {"sha": "b" * 40}, "user": {"login": "x"}, "labels": []}, "sender": {"login": "x"}, "repository": {"full_name": "o/r"}}))
        self._ingest(gn.normalize_github("workflow_run", "wr-9", {"action": "completed", "workflow_run": {"id": 9, "name": "aria-kernel", "conclusion": "failure", "head_sha": "c" * 40, "head_branch": "main"}, "sender": {"login": "x"}, "repository": {"full_name": "o/r"}}))
        for alert in gn.normalize_alertmanager("am", {"receiver": "aria", "alerts": [{"status": "firing", "labels": {"alertname": "AriaBreakerTripped", "severity": "critical", "service": "aria"}, "annotations": {"summary": "s"}, "fingerprint": "f1"}]}):
            self._ingest(alert)
        self._ingest(gn.normalize_operator("op-1", {"verb": "pause", "reason": "x"}, actor="okan"))
        self._ingest(gn.normalize_operator("op-2", {"verb": "explode"}, actor="okan"))
        routed = gr.drain_inbox(base_dir=self.tools, workspace_root=self.ws)
        by_id = {r["delivery_id"]: r for r in routed}
        self.assertEqual(by_id["i-7"]["action"], "mission_open")
        self.assertEqual(by_id["i-8"], {**by_id["i-8"], "action": "ignored", "refs": {"reason": "label_missing"}})
        self.assertEqual(by_id["pr-3"]["action"], "pr_event")
        self.assertEqual(by_id["wr-9"]["action"], "runtime_signal")
        self.assertEqual(by_id["am:0"]["action"], "runtime_signal")
        self.assertEqual(by_id["op-1"]["action"], "operator_control")
        self.assertEqual(by_id["op-2"]["refs"]["reason"], "unknown_verb")
        for row in routed:
            self.assertIn(row["action"], gr.ROUTE_ACTIONS)
            self.assertIsNone(row["error"], row)
        missions = list_open_missions(base_dir=self.tools)
        self.assertEqual([(m["source_kind"], m["source_id"]) for m in missions], [("github_issue", "issue-7")])
        self.assertTrue(effective_control(self.tools).paused_all)
        self.assertTrue((self.tools / "pr-events.jsonl").exists())
        self.assertEqual(gi.pending_events(self.tools), [])
        # replaying the same issue (new delivery id) is idempotent on the mission
        self._ingest(gn.normalize_github("issues", "i-7b", _issue_payload(7, ["aria"])))
        again = gr.drain_inbox(base_dir=self.tools, workspace_root=self.ws)
        self.assertTrue(again[0]["refs"]["idempotent"])
        self.assertEqual(len(list_open_missions(base_dir=self.tools)), 1)
        # an exception inside a route is an outcome, never a crash
        broken = gn.NormalizedEvent(kind="github.pr_opened", delivery_id="pr-bad", source="github", occurred_at=None, actor=None, subject={"number": "not-a-number"})
        self._ingest(broken)
        outcome = gr.route_event(broken, base_dir=self.tools, workspace_root=self.ws)
        self.assertIn(outcome.action, gr.ROUTE_ACTIONS)


class Schedules(_Store):
    def test_I_V12_GW_04_closed_actions_strict_cron_pause_gating(self) -> None:
        with self.assertRaises(ValueError):
            gs.add_schedule(name="free", action="run: summarize the repo", cron="* * * * *", base_dir=self.tools)
        with self.assertRaises(ValueError):
            gs.add_schedule(name="badcron", action="doctor", cron="61 * * * *", base_dir=self.tools)
        with self.assertRaises(ValueError):
            gs.add_schedule(name="Bad Name", action="doctor", cron="* * * * *", base_dir=self.tools)
        gs.add_schedule(name="cycle", action="cycle", cron="0 2 * * *", base_dir=self.tools)
        gs.add_schedule(name="doctor", action="doctor", cron="7 * * * *", base_dir=self.tools)
        self.assertTrue(gs.cron_matches("*/15 * * * *", datetime(2026, 9, 3, 1, 45, tzinfo=timezone.utc)))
        self.assertFalse(gs.cron_matches("*/15 * * * *", datetime(2026, 9, 3, 1, 50, tzinfo=timezone.utc)))
        self.assertTrue(gs.cron_matches("0 2 * * 1-5", datetime(2026, 9, 3, 2, 0, tzinfo=timezone.utc)), "Thursday")
        self.assertFalse(gs.cron_matches("0 2 * * 0,6", datetime(2026, 9, 3, 2, 0, tzinfo=timezone.utc)))
        at_two = datetime(2026, 9, 3, 2, 0, tzinfo=timezone.utc)
        self.assertEqual(sorted(s.name for s in gs.due_schedules(now=at_two, base_dir=self.tools)), ["cycle"])
        calls: list[list[str]] = []

        def runner(argv: list[str]) -> subprocess.CompletedProcess[str]:
            calls.append(argv)
            return subprocess.CompletedProcess(argv, 0, "", "")

        result = gs.tick(base_dir=self.tools, workspace_root=self.ws, now=at_two, runner=runner)
        self.assertEqual(result["heartbeat"]["ran"], ["cycle:ran"])
        self.assertEqual(calls[0][:4], ["gh", "workflow", "run", "aria-auto-cycle.yml"])
        self.assertIn("mode=cycle", calls[0])
        self.assertEqual(gs.due_schedules(now=at_two, base_dir=self.tools), [], "fires once per minute")
        from aria_kernel.control import record_control

        record_control("pause", base_dir=self.tools)
        later = datetime(2026, 9, 4, 2, 0, tzinfo=timezone.utc)
        result = gs.tick(base_dir=self.tools, workspace_root=self.ws, now=later, runner=runner)
        self.assertEqual(result["heartbeat"]["ran"], ["cycle:skipped"])
        self.assertEqual(len(calls), 1, "no dispatch under operator pause")
        gs.change_schedule("pause", name="cycle", base_dir=self.tools)
        self.assertTrue(gs.fold_schedules(self.tools)["cycle"].paused)
        gs.change_schedule("remove", name="cycle", base_dir=self.tools)
        self.assertNotIn("cycle", gs.fold_schedules(self.tools))
        with self.assertRaises(ValueError):
            gs.change_schedule("resume", name="cycle", base_dir=self.tools)
        local = gs.run_action("doctor", base_dir=self.tools, workspace_root=self.ws, runner=runner)
        self.assertIn("healthy", local["detail"])
        for action in gs.SCHEDULE_ACTIONS:
            self.assertTrue(action in gs.ACTION_WORKFLOWS or action in {"doctor", "telemetry_export", "deliver", "inbox_drain", "self_improve", "economy", "experiment_night"}, action)
        # the one parameterised action: an adapter id must be registered ACTIVE
        with self.assertRaises(ValueError):
            gs.add_schedule(name="adapter", action="adapter_run:ghost-tool", cron="0 3 * * *", base_dir=self.tools)
        with self.assertRaises(ValueError):
            gs.validate_action("adapter_run:bad id", base_dir=self.tools)
        with mock.patch("aria_kernel.tool_registry.list_tools", return_value=[{"tool_id": "sec-scan", "status": "ACTIVE"}]):
            self.assertEqual(gs.validate_action("adapter_run:sec-scan", base_dir=self.tools), "adapter_run:sec-scan")
        # experiment_night runs the kernel's night lane with a gateway cycle id
        with mock.patch("aria_kernel.experiment_night.run_night_experiments", return_value={"status": "planned_nothing", "planned": 0, "ran": 0}) as night:
            outcome = gs.run_action("experiment_night", base_dir=self.tools, workspace_root=self.ws, runner=runner)
        self.assertEqual(outcome["status"], "ran")
        self.assertTrue(night.call_args.kwargs["cycle_id"].startswith("gw-exp-"))
        self.assertIn("gateway_action_ran", self.governance())
        self.assertTrue((self.tools / "gateway" / "heartbeat.json").exists())


class Daemon(_Store):
    def test_I_V12_GW_05_lease_lock_heartbeat_stop(self) -> None:
        result = gd.run_gateway_daemon(base_dir=self.tools, workspace_root=self.ws, max_iterations=2, poll_interval_seconds=0.05, serve_http=False,
                                       runner=lambda argv: subprocess.CompletedProcess(argv, 0, "", ""))
        self.assertEqual((result["exits_clean"], result["exit_reason"], result["iterations"]), (True, "max_iterations", 2))
        self.assertTrue((self.tools / "daemons" / f"{gd.DAEMON_ID}.pid").exists())
        self.assertTrue((self.tools / "gateway" / "heartbeat.json").exists())
        self.assertIn("gateway_daemon_started", self.governance())
        (self.tools / "ARIA_STOP").write_text("stop\n", encoding="utf-8")
        result = gd.run_gateway_daemon(base_dir=self.tools, workspace_root=self.ws, max_iterations=5, poll_interval_seconds=0.05, serve_http=False)
        self.assertEqual((result["exit_reason"], result["iterations"]), ("aria_stop", 0))
        (self.tools / "ARIA_STOP").unlink()
        from aria_kernel.file_lock import with_exclusive_lock

        with with_exclusive_lock(self.tools / "daemons" / f"{gd.DAEMON_ID}.pid.lock", timeout_seconds=1.0):
            second = gd.run_gateway_daemon(base_dir=self.tools, workspace_root=self.ws, max_iterations=1, poll_interval_seconds=0.05, serve_http=False)
        self.assertEqual(second["exit_reason"], "daemon_already_running")
        organ = next(c for c in run_doctor(base_dir=self.tools, workspace_root=self.ws).checks if c.name == "gateway")
        self.assertEqual(organ.status, "ok")
        self.assertIn("heartbeat_age_seconds", organ.detail)


class SourceEnumAndAssets(_Store):
    def test_I_V12_GW_06_enum_scanner_doctor_and_files(self) -> None:
        self.assertEqual({m.name for m in PlanCandidateSource} - {"OPERATOR_FEEDBACK", "FAILING_CI", "ORPHAN_FINDING", "F_FINDING", "GIT_DIFF"}, {"GITHUB_ISSUE"})
        from aria_kernel import plan_synthesizer as ps

        self.assertEqual(ps._SOURCE_PRIORITY[PlanCandidateSource.GITHUB_ISSUE.value], ps._SOURCE_PRIORITY[PlanCandidateSource.FAILING_CI.value])
        self.assertEqual(ps.scan_github_issue_missions(self.root), [])
        gi.record_event(gn.normalize_github("issues", "i-1", _issue_payload(1, ["aria"])), base_dir=self.tools)
        gr.drain_inbox(base_dir=self.tools, workspace_root=self.ws)
        found = ps.scan_github_issue_missions(self.root)
        self.assertEqual([c["source_type"] for c in found], ["github_issue"])
        self.assertIn("github_issue", (_REPO_ROOT / "aria-kernel" / "aria_kernel" / "plan_synthesizer.py").read_text(encoding="utf-8"))
        organ = next(c for c in run_doctor(base_dir=self.tools, workspace_root=self.ws).checks if c.name == "gateway")
        self.assertEqual(organ.reason, "gateway_not_running_here")
        unit = (_REPO_ROOT / "infrastructure/aria/aria-gateway.service").read_text(encoding="utf-8")
        self.assertIn("gateway serve", unit)
        self.assertIn("--host 127.0.0.1", unit)
        nginx = (_REPO_ROOT / "infrastructure/nginx/droplet.conf").read_text(encoding="utf-8")
        self.assertIn("location /aria/webhook/", nginx)
        self.assertIn("proxy_pass http://127.0.0.1:8787", nginx)
        self.assertIn("zone=aria_webhook", nginx)
        self.assertIn("aria-gateway.service", (_REPO_ROOT / "scripts/aria/provision_runner.sh").read_text(encoding="utf-8"))
        runbook = (_REPO_ROOT / "docs/runbooks/aria-gateway.md").read_text(encoding="utf-8")
        for name in (gsrv.GITHUB_SECRET_ENV, gsrv.ALERTMANAGER_BEARER_ENV, gsrv.OPERATOR_BEARER_ENV, gsrv.ACTOR_ALLOWLIST_ENV):
            self.assertIn(name, runbook)
        from aria_kernel.cli import build_parser

        parser = build_parser()
        self.assertEqual(parser.parse_args(["gateway", "serve", "--no-http", "--max-iterations", "1"]).max_iterations, 1)
        self.assertEqual(parser.parse_args(["schedule", "add", "--name", "n", "--action", "doctor", "--cron", "0 * * * *"]).action, "doctor")
        self.assertTrue(parser.parse_args(["event", "ingest", "--source", "github", "--payload-file", "p", "--github-event", "issues", "--route"]).route)


if __name__ == "__main__":
    unittest.main()
