"""Plan 032 Faz 032e — operations surface: control, cancel, progress, notify, telemetry, doctor.

Invariants:
  I-V12-CTRL-01   the control ledger folds deterministically: pause/resume (all or
                  per request, later row wins), cancel is sticky, verbs are closed,
                  cancel needs a request id, every command is a governance row.
  I-V12-CTRL-02   a cancelled request derives CANCELLED_BY_OPERATOR (terminal, even
                  before any claim); `operator_cancelled` is the OPERATOR fault
                  domain and never burns the requeue budget.
  I-V12-CTRL-03   the streamed spawn stops the whole process group on cancel
                  (SIGTERM, then SIGKILL after grace), reports it on the control,
                  feeds every stream-json event to the observer, and still raises
                  TimeoutExpired on the deadline; without a control it is the old
                  buffered run.
  I-V12-CTRL-04   the executor honours a cancel before the spawn, passes the control
                  into the spawn, releases with `operator_cancelled` after a
                  cancelled spawn; the drain stops claiming under `pause`.
  I-V12-PROG-01   progress rows are sanitized (secrets scrubbed, argv redacted, no
                  transcript text beyond the preview), hash-chained under
                  run-artifacts/hot/<request>/progress.jsonl, and a failing writer
                  never raises into the spawn.
  I-V12-NOTIFY-01 kinds and channels are closed; channels configure by env NAMES;
                  every attempt is an outbox row (sent/failed/deduped/dry_run/
                  unconfigured); dedup binds inside the window; a channel failure is
                  a row, never an exception; producers (human_required, breakers,
                  orchestrator) call the best-effort entry point.
  I-V12-TELEM-01  the store metrics carry the organ series; every metric an alert
                  rule or dashboard panel references is one the exporter emits.
  I-V12-OPS-01    doctor carries queue/control/notifications organs; the CLI exposes
                  control/notify/tail; the systemd timer exports the textfile.

NOT RUN at authoring time (operator instruction 2026-09-03).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from tests.invariants.v12 import _helpers  # noqa: F401 — sys.path

from aria_kernel import control, notify, progress, telemetry
from aria_kernel.agent_invocations import (
    _request_fault_requeue_count,
    classify_release_reason,
    create_agent_invocation_request,
    derive_request_state,
)
from aria_kernel.doctor import run_doctor
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.tool_registry import ensure_tools_dir

_REPO_ROOT = Path(__file__).resolve().parents[4]
_POC = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC) not in sys.path:
    sys.path.insert(0, str(_POC))


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.tools = ensure_tools_dir(self.root / "aria-tools")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def governance(self) -> str:
        path = self.tools / "governance.jsonl"
        return path.read_text(encoding="utf-8") if path.exists() else ""


class ControlFolds(_Store):
    def test_I_V12_CTRL_01_fold_and_vocabulary(self) -> None:
        self.assertFalse(control.effective_control(self.tools).is_paused())
        control.record_control("pause", base_dir=self.tools, operator_ref="op-1")
        self.assertTrue(control.effective_control(self.tools).is_paused("AIR-1"))
        control.record_control("resume", base_dir=self.tools)
        self.assertFalse(control.effective_control(self.tools).is_paused("AIR-1"))
        control.record_control("pause", base_dir=self.tools, request_id="AIR-2")
        state = control.effective_control(self.tools)
        self.assertTrue(state.is_paused("AIR-2"))
        self.assertFalse(state.is_paused("AIR-3"))
        self.assertFalse(state.paused_all)
        control.record_control("cancel", base_dir=self.tools, request_id="AIR-9", reason="wrong plan")
        control.record_control("resume", base_dir=self.tools)
        state = control.effective_control(self.tools)
        self.assertTrue(state.is_cancelled("AIR-9"), "cancel is sticky across resume")
        self.assertEqual(state.commands, 5)
        with self.assertRaises(ValueError):
            control.record_control("stop", base_dir=self.tools)
        with self.assertRaises(ValueError):
            control.record_control("cancel", base_dir=self.tools)
        rows = load_declared_jsonl(self.tools.joinpath(*control.CONTROL_COMMANDS_RELPATH), expected_surface=control.CONTROL_COMMANDS_SURFACE)
        self.assertEqual([r["verb"] for r in rows], ["pause", "resume", "pause", "cancel", "resume"])
        self.assertEqual(self.governance().count(control.CONTROL_RECORDED_EVENT), 5)
        with self.assertRaises(ValueError):
            control.record_cancel_outcome("AIR-9", outcome="vanished", base_dir=self.tools)

    def test_I_V12_CTRL_02_cancelled_state_and_operator_domain(self) -> None:
        req = create_agent_invocation_request(
            target_agent="aria-challenger-planner", role="challenger_plan", suggested_prompt="p",
            must_satisfy=[{"id": "x", "criterion": "y"}], allowed_scope=["apps/**"], convergence_id="conv-1",
            base_dir=self.tools,
        )
        self.assertEqual(derive_request_state(req["request_id"], base_dir=self.tools), "PENDING")
        control.record_control("cancel", base_dir=self.tools, request_id=req["request_id"])
        self.assertEqual(derive_request_state(req["request_id"], base_dir=self.tools), control.CANCELLED_BY_OPERATOR_STATE)
        self.assertEqual(classify_release_reason(control.OPERATOR_CANCELLED_RELEASE_REASON), "operator")
        rows = [
            {"request_id": "AIR-1", "event": "requeued", "reason": "operator_cancelled"},
            {"request_id": "AIR-1", "event": "requeued", "reason": "submit_rejected"},
        ]
        self.assertEqual(_request_fault_requeue_count(rows, "AIR-1"), 1, "a cancel is not the request's fault")


class SpawnIsCancellable(unittest.TestCase):
    def test_I_V12_CTRL_03_process_group_stops_and_events_stream(self) -> None:
        import claude_runtime

        script = ("import time,sys,json\n"
                  "print(json.dumps({'type':'system','subtype':'init','model':'m'}), flush=True)\n"
                  "print('not json', flush=True)\n"
                  "time.sleep(60)\n")
        argv = [sys.executable, "-c", script]
        seen: list[dict] = []
        ctl = claude_runtime.SpawnControl(
            should_cancel=lambda: bool(seen), on_event=seen.append, poll_seconds=0.2, grace_seconds=3.0,
        )
        started = time.monotonic()
        done = claude_runtime._run_spawn(argv, input_text="", timeout_seconds=30, cwd=None, env=dict(os.environ), control=ctl)
        self.assertLess(time.monotonic() - started, 15)
        self.assertTrue(ctl.cancelled)
        self.assertEqual(ctl.cancel_signal, "sigterm")
        self.assertEqual(ctl.events_seen, 1)
        self.assertEqual(seen[0]["subtype"], "init")
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("init", done.stdout)
        # a process that ignores SIGTERM is killed after the grace period
        stubborn = ("import signal,time,json\n"
                    "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
                    "print(json.dumps({'type':'system'}), flush=True)\n"
                    "time.sleep(60)\n")
        seen2: list[dict] = []
        ctl2 = claude_runtime.SpawnControl(should_cancel=lambda: bool(seen2), on_event=seen2.append, poll_seconds=0.2, grace_seconds=1.0)
        claude_runtime._run_spawn([sys.executable, "-c", stubborn], input_text="", timeout_seconds=30, cwd=None, env=dict(os.environ), control=ctl2)
        self.assertEqual(ctl2.cancel_signal, "sigkill")
        # the deadline still binds under a control
        ctl3 = claude_runtime.SpawnControl(should_cancel=lambda: False, poll_seconds=0.2)
        with self.assertRaises(subprocess.TimeoutExpired):
            claude_runtime._run_spawn([sys.executable, "-c", "import time; time.sleep(30)"], input_text="", timeout_seconds=1, cwd=None, env=dict(os.environ), control=ctl3)
        plain = claude_runtime._run_spawn([sys.executable, "-c", "import sys; print(sys.stdin.read().upper())"], input_text="abc", timeout_seconds=10, cwd=None, env=dict(os.environ), control=None)
        self.assertEqual((plain.returncode, plain.stdout.strip()), (0, "ABC"))

    def test_I_V12_CTRL_04_executor_and_drain_source_pins(self) -> None:
        executor = (_POC / "ci_executor.py").read_text(encoding="utf-8")
        pre = executor.index("if is_cancelled(request_id, tools_dir):")
        spawn = executor.index("spawn_control=_spawn_control,")
        post = executor.index("OPERATOR_CANCELLED_RELEASE_REASON if _spawn_control.cancelled")
        self.assertLess(pre, spawn)
        self.assertLess(spawn, post)
        self.assertIn('outcome="before_spawn"', executor)
        self.assertIn("ProgressWriter(request_id, base_dir=tools_dir, claim_id=claim_id).write", executor)
        drain = (_POC / "ci_executor_drain.py").read_text(encoding="utf-8")
        self.assertIn('stop_reason = "operator_paused"', drain)
        self.assertLess(drain.index("if _operator_paused(tools_dir):"), drain.index("_next_pending_for_role(\n"))


class ProgressIsSanitized(_Store):
    def test_I_V12_PROG_01_rows_and_writer(self) -> None:
        token = "ghp_" + "A" * 40
        event = {"type": "assistant", "message": {"content": [
            {"type": "text", "text": f"pushing with {token} now"},
            {"type": "tool_use", "name": "Bash", "input": {"command": f"git push origin aria-impl-1 # {token}"}},
            {"type": "tool_use", "name": "Edit", "input": {"file_path": "/w/apps/x.py"}},
        ]}}
        row = progress.sanitize_stream_event(event)
        assert row is not None
        self.assertNotIn(token, json.dumps(row))
        self.assertIn("github_pat", row["redaction_types"])
        self.assertEqual([t["tool_name"] for t in row["tool_uses"]], ["Bash", "Edit"])
        self.assertEqual(row["tool_uses"][0]["command_family"], "git_push")
        self.assertTrue(row["tool_uses"][0]["external_effect"])
        self.assertEqual(row["tool_uses"][1]["files_touched"], ["/w/apps/x.py"])
        self.assertLessEqual(len(row["text_preview"]), progress.TEXT_PREVIEW_CHARS)
        result = progress.sanitize_stream_event({"type": "result", "subtype": "success", "total_cost_usd": 0.42, "num_turns": 7, "duration_ms": 1200, "result": "long transcript text"})
        self.assertEqual(result, {"type": "result", "subtype": "success", "is_error": False, "total_cost_usd": 0.42, "duration_ms": 1200, "num_turns": 7})
        tool_result = progress.sanitize_stream_event({"type": "user", "message": {"content": [{"type": "tool_result", "content": "x" * 100, "is_error": True}]}})
        self.assertEqual(tool_result, {"type": "tool_result", "count": 1, "bytes": 102, "errors": 1})
        self.assertIsNone(progress.sanitize_stream_event({"type": "user", "message": {"content": [{"type": "text", "text": "hi"}]}}))
        self.assertEqual(progress.sanitize_stream_event({"type": "weird"}), {"type": "other", "raw_type": "weird"})

        writer = progress.ProgressWriter("AIR-1", base_dir=self.tools, claim_id="c1")
        writer.write({"type": "system", "subtype": "init"})
        writer.write(event)
        writer.write({"type": "result", "subtype": "success"})
        path = progress.progress_path("AIR-1", self.tools)
        self.assertEqual(path, self.tools / "run-artifacts" / "hot" / "AIR-1" / "progress.jsonl")
        rows = load_declared_jsonl(path, expected_surface=progress.PROGRESS_SURFACE)
        self.assertEqual([r["seq"] for r in rows], [1, 2, 3])
        self.assertEqual(progress.read_progress("AIR-1", base_dir=self.tools, last=1)[0]["type"], "result")
        tail = list(progress.tail_progress("AIR-1", base_dir=self.tools, last=2, follow=True, max_wait_seconds=0.1))
        self.assertEqual([r["type"] for r in tail], ["assistant", "result"])
        self.assertIn("#3 result success", progress.render_progress_row(rows[2]))
        with mock.patch.object(progress, "append_declared_jsonl", side_effect=OSError("disk")):
            self.assertIsNone(writer.write({"type": "system"}))
        self.assertEqual(writer.failures, 1)


class NotificationsAreAudited(_Store):
    def test_I_V12_NOTIFY_01_outbox_rows_dedup_and_failures(self) -> None:
        with self.assertRaises(ValueError):
            notify.notify(kind="rumour", title="t", body="b", base_dir=self.tools, environ={})
        rows = notify.notify(kind="test", title="t", body="b", base_dir=self.tools, environ={})
        self.assertEqual([r["status"] for r in rows], ["unconfigured"])
        env = {"ARIA_TELEGRAM_BOT_TOKEN": "x", "ARIA_TELEGRAM_CHAT_ID": "1", "ARIA_NOTIFY_GITHUB_REPO": "o/r"}
        self.assertEqual(notify.configured_channels(env), ("github_issue", "telegram"))
        self.assertEqual(notify.configured_channels({**env, notify.CHANNEL_SELECTOR_ENV: "telegram"}), ("telegram",))
        sent: list[str] = []
        senders = {"telegram": lambda t, b, e: sent.append(t) or {"ok": True},
                   "github_issue": lambda t, b, e: (_ for _ in ()).throw(RuntimeError("gh down"))}
        now = datetime(2026, 9, 3, 12, tzinfo=timezone.utc)
        rows = notify.notify(kind="cycle_failed", title="cycle X", body="boom", key="cyc-x", base_dir=self.tools,
                             environ=env, senders=senders, now=now)
        self.assertEqual({r["channel"]: r["status"] for r in rows}, {"github_issue": "failed", "telegram": "sent"})
        self.assertEqual(rows[0]["detail"]["error_class"], "RuntimeError")
        again = notify.notify(kind="cycle_failed", title="cycle X", body="boom", key="cyc-x", base_dir=self.tools,
                              environ=env, senders=senders, channels=["telegram"], now=now + timedelta(hours=1))
        self.assertEqual(again[0]["status"], "deduped")
        later = notify.notify(kind="cycle_failed", title="cycle X", body="boom", key="cyc-x", base_dir=self.tools,
                              environ=env, senders=senders, channels=["telegram"], now=now + timedelta(hours=7))
        self.assertEqual(later[0]["status"], "sent")
        self.assertEqual(sent, ["cycle X", "cycle X"])
        dry = notify.notify(kind="test", title="dry", body="", base_dir=self.tools, environ=env, channels=["telegram"], dry_run=True)
        self.assertEqual(dry[0]["status"], "dry_run")
        outbox = notify.read_outbox(self.tools)
        self.assertEqual(len(outbox), 6)
        for row in outbox:
            self.assertIn(row["status"], notify.NOTIFY_STATUSES)
        self.assertNotIn("x", json.dumps([r["detail"] for r in outbox]).replace("ok", ""), "token values never land in the outbox")
        self.assertEqual(notify.notify_best_effort(kind="nope", title="t", body="b", base_dir=self.tools), [])
        self.assertEqual(notify.signature_for("a", "k", "t"), notify.signature_for("a", "k", "other title"))

    def test_I_V12_NOTIFY_01_producers_are_wired(self) -> None:
        kernel = _REPO_ROOT / "aria-kernel" / "aria_kernel"
        for module, kind in (("human_required.py", "human_required_opened"), ("circuit_breaker.py", "breaker_tripped"),
                             ("cost_budget.py", "breaker_tripped"), ("autonomy_orchestrator.py", "cycle_failed")):
            source = (kernel / module).read_text(encoding="utf-8")
            self.assertIn("notify_best_effort(", source, module)
            self.assertIn(f'kind="{kind}"', source, module)
            self.assertIn(kind, notify.NOTIFY_EVENT_KINDS)


class TelemetryAndAssets(_Store):
    def _emitted_names(self) -> set[str]:
        return {m["name"] for m in telemetry._store_metrics(self.tools)}

    def test_I_V12_TELEM_01_series_and_asset_references(self) -> None:
        names = self._emitted_names()
        for expected in ("aria_agent_requests", "aria_human_required_open", "aria_breaker_tripped", "aria_executor_paused",
                         "aria_cancelled_requests", "aria_delivery_verified_prs", "aria_delivery_slo_met", "aria_cost_usd_total"):
            self.assertIn(expected, names)
        text = telemetry._prometheus(telemetry._store_metrics(self.tools))
        self.assertIn("aria_executor_paused 0", text.replace("{}", ""))
        # conditional series: only with rows — assert the exporter names them
        source = (_REPO_ROOT / "aria-kernel" / "aria_kernel" / "telemetry.py").read_text(encoding="utf-8")
        declared = set(re.findall(r'_metric\("(aria_[a-z_]+)"', source))
        import yaml

        alerts = yaml.safe_load((_REPO_ROOT / "infrastructure/monitoring/prometheus/alerts/aria-alerts.yml").read_text(encoding="utf-8"))
        rules = [r for g in alerts["spec"]["groups"] for r in g["rules"]]
        self.assertGreaterEqual(len(rules), 6)
        for rule in rules:
            for metric in re.findall(r"\baria_[a-z_]+\b", rule["expr"]):
                self.assertIn(metric, declared, rule["alert"])
            self.assertIn(rule["labels"]["severity"], {"critical", "warning", "info"})
        dashboard = json.loads((_REPO_ROOT / "infrastructure/monitoring/grafana/dashboards/aria-kernel-dashboard.json").read_text(encoding="utf-8"))
        exprs = [t["expr"] for p in dashboard["panels"] for t in p.get("targets", [])]
        self.assertGreaterEqual(len(exprs), 6)
        for expr in exprs:
            for metric in re.findall(r"\baria_[a-z_]+\b", expr):
                self.assertIn(metric, declared, expr)

    def test_I_V12_OPS_01_doctor_cli_and_timer(self) -> None:
        report = run_doctor(base_dir=self.tools, workspace_root=self.root)
        organs = {c.name: c for c in report.checks}
        for name in ("queue", "control", "notifications", "delivery_closure"):
            self.assertIn(name, organs)
        control.record_control("pause", base_dir=self.tools)
        organs = {c.name: c for c in run_doctor(base_dir=self.tools, workspace_root=self.root).checks}
        self.assertEqual((organs["control"].status, organs["control"].reason), ("warn", "executor_paused"))
        from aria_kernel.cli import build_parser

        parser = build_parser()
        self.assertEqual(parser.parse_args(["control", "cancel", "--request-id", "AIR-1"]).control_command, "cancel")
        self.assertTrue(parser.parse_args(["tail", "AIR-1", "--follow", "-n", "5"]).follow)
        self.assertTrue(parser.parse_args(["notify", "send", "--kind", "test", "--title", "t", "--dry-run"]).dry_run)
        service = (_REPO_ROOT / "infrastructure/aria/aria-telemetry.service").read_text(encoding="utf-8")
        timer = (_REPO_ROOT / "infrastructure/aria/aria-telemetry.timer").read_text(encoding="utf-8")
        script = (_REPO_ROOT / "scripts/aria/aria-telemetry-textfile.sh").read_text(encoding="utf-8")
        self.assertIn("aria-telemetry-textfile.sh", service)
        self.assertIn("OnUnitActiveSec=", timer)
        self.assertIn("telemetry export --format prometheus", script)
        self.assertIn(".prom", script)


if __name__ == "__main__":
    unittest.main()
