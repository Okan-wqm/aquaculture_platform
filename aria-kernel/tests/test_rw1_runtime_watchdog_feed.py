"""RW-1 — the runtime watchdog's production feed, least privilege.

State at the branch base (measured, not assumed):

* ``watchdog_pull.observability_base_url`` defaults to ``None``, so the
  production metric detectors never ran: every sweep took the
  ``source_unconfigured`` branch.
* The ONE puller, ``aria_watchdog.pull_observability_metrics``, GETs the
  observability-service ``/metrics`` with the platform's shared
  ``INTERNAL_API_KEY`` (copied into the runner ``.env`` as
  ``ARIA_OBSERVABILITY_API_KEY``, required present by
  ``scripts/aria/provision_runner.sh``) in an ``x-internal-api-key`` header,
  and dials whatever host the policy names.
* A skipped pull lands in the sweep payload's ``runtime`` dict and nowhere
  else: the cycle's watchdog digest copies only candidates/emitted/
  suppressed, so the report's "Watchdog Sweep" section is silent about it.
* A runtime candidate goes to ``finding.emit_finding`` as an OBSERVED
  ``operational_anomaly`` with one evidence; the claim type needs three, the
  emitter swallows the ``GovernanceError`` as ``aria_watchdog_emit_rejected``
  and counts it ``suppressed`` — telemetry claims never reached any gate.

The decisions this file pins (program lead, binding — build/RW-1/SPEC.md):

* no shared internal API key for ARIA: no credential header on the wire, no
  credential field in policy, the retired runner key checked for ABSENCE;
* the source is the droplet Prometheus's read-only HTTP API on loopback
  (the droplet stack scrapes every backend's public ``/metrics`` into
  Prometheus — infrastructure/monitoring/droplet/prometheus.yml — while the
  observability-service ``/metrics`` is the key-gated one), and the default
  policy points at it;
* a missing, unreachable or non-loopback source is a NAMED HOLD in the sweep
  result that reaches the cycle digest and the report — never silence; a
  non-loopback source is refused before any socket is opened;
* runtime detector output enters the EXISTING runtime-signal claim path
  (``runtime_signal_bridge.ingest_runtime_signal``: source ``telemetry``,
  ``trust_grade=runtime_unverified``) whose leads only become findings
  through repo evidence and ``finding.record_finding_reproduction`` — the
  watchdog never mints a telemetry finding itself and adds no second gate;
* one puller: the Prometheus API path lives only in
  ``pull_observability_metrics``.

Policy is configured the way the operator configures it — an
``aria-config/genesis_policy.json`` override in the workspace — so the tests
do not depend on where the sweep imports its accessor from.
"""
from __future__ import annotations

import ast
import inspect
import json
import os
import re
import shutil
import socket
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import yaml

from aria_kernel import aria_watchdog
from aria_kernel.aria_watchdog import (
    RUNTIME_METRIC_FAMILIES,
    RUNTIME_SOURCE_HOLDS,
    detect_http_5xx_share,
    pull_observability_metrics,
    run_watchdog_sweep,
)
from aria_kernel.genesis_policy import WATCHDOG_PULL_DEFAULTS, watchdog_pull_policy
from aria_kernel.runtime_signal_bridge import (
    fold_runtime_signals,
    resolve_runtime_signal,
    runtime_signal_events_path,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

_KERNEL_ROOT = Path(__file__).resolve().parents[1]
_PACKAGE_ROOT = _KERNEL_ROOT / "aria_kernel"
_REPO_ROOT = _KERNEL_ROOT.parent
_PROVISIONER = _REPO_ROOT / "scripts" / "aria" / "provision_runner.sh"

_SHARED_KEY_VALUE = "rw1-shared-internal-key-must-never-travel"
_CREDENTIAL_HEADERS = frozenset({"x-internal-api-key", "authorization", "proxy-authorization", "cookie", "x-api-key"})
# Read-only Prometheus HTTP API paths: the instant/range query API and the
# federation endpoint. The lifecycle/admin endpoints (/-/*, /api/v1/admin/*)
# are not reads and are not in the set.
_PROMETHEUS_READ_PATHS = ("/api/v1/query", "/federate")


_Sample = tuple[str, dict[str, str], float]

# What the read-not-held fixtures serve: one runtime-family series, labelled
# the way the droplet Prometheus labels a catalog target (`app`, `namespace`).
_ONE_HTTP_SAMPLE: list[_Sample] = [
    ("http_requests_total", {"app": "farm-service", "namespace": "aquaculture", "status_code": "200"}, 10.0),
]


def _exposition(samples: list[_Sample]) -> bytes:
    lines = []
    for name, labels, value in samples:
        rendered = ",".join(f'{key}="{val}"' for key, val in sorted(labels.items()))
        lines.append(f"{name}{{{rendered}}} {value:g} 1761240000000")
    return ("\n".join(lines) + "\n").encode("utf-8") if lines else b""


def _instant_vector(samples: list[_Sample], query: str) -> bytes:
    """Answer a `sum by (...) (...(<family>{...}...))` instant query the way
    Prometheus does: one result per group of the `by` labels, summed."""
    family = next((name for name in {s[0] for s in samples} if name in query), None)
    by = re.search(r"by \(([^)]*)\)", query)
    keep = [label.strip() for label in by.group(1).split(",")] if by else None
    groups: dict[tuple[tuple[str, str], ...], float] = {}
    for name, labels, value in samples:
        if name != family:
            continue
        metric = {k: v for k, v in labels.items() if keep is None or k in keep}
        key = tuple(sorted(metric.items()))
        groups[key] = groups.get(key, 0.0) + value
    result = [{"metric": dict(key), "value": [1761240000.0, f"{value:g}"]} for key, value in groups.items()]
    return json.dumps({"status": "success", "data": {"resultType": "vector", "result": result}}).encode("utf-8")


class _RecordingPrometheus:
    """A loopback stand-in for the droplet Prometheus that records every request.

    It answers the read-only API from one set of counters: ``lifetime`` (what
    /federate and /metrics serve — a counter's value since its process
    started) and ``window`` (what an ``increase(...[W])`` instant query on
    /api/v1/query answers — the counters' growth inside the window; it
    defaults to ``lifetime``). ``raw`` replaces every GET answer with a fixed
    (status, body, content type) — a listener on the port that is not, or
    not yet, a usable Prometheus. Anything else is 404; any method but GET
    is 405.
    """

    def __init__(
        self,
        *,
        lifetime: list[_Sample] | None = None,
        window: list[_Sample] | None = None,
        raw: tuple[int, bytes, str] | None = None,
    ) -> None:
        self.requests: list[dict[str, Any]] = []
        self.lifetime = list(_ONE_HTTP_SAMPLE if lifetime is None else lifetime)
        self.window = None if window is None else list(window)
        self.raw = raw
        recorder = self

        class Handler(BaseHTTPRequestHandler):
            def _record(self) -> str:
                parts = urlsplit(self.path)
                recorder.requests.append({
                    "method": self.command,
                    "path": parts.path,
                    "query": parse_qs(parts.query),
                    "headers": {k.lower(): v for k, v in self.headers.items()},
                })
                return parts.path

            def _send(self, status: int, body: bytes, content_type: str) -> None:
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self) -> None:  # noqa: N802 — http.server's hook name
                path = self._record()
                if recorder.raw is not None:
                    self._send(*recorder.raw)
                elif path.startswith("/api/v1/query"):
                    query = recorder.requests[-1]["query"].get("query", [""])[0]
                    counters = recorder.window if "increase(" in query and recorder.window is not None else recorder.lifetime
                    self._send(200, _instant_vector(counters, query), "application/json")
                elif path in ("/federate", "/metrics"):
                    self._send(200, _exposition(recorder.lifetime), "text/plain; version=0.0.4")
                else:
                    self._send(404, b"not found", "text/plain")

            def _refuse(self) -> None:
                self._record()
                self._send(405, b"method not allowed", "text/plain")

            do_POST = do_PUT = do_DELETE = do_HEAD = _refuse  # noqa: N815

            def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 — stdlib signature
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def __enter__(self) -> "_RecordingPrometheus":
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)


def _closed_loopback_url() -> str:
    """A loopback URL nothing listens on (bound, then released)."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    return f"http://127.0.0.1:{port}"


class _NetworkRecorder:
    """Records (and refuses) every name lookup and outbound connection."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []

    def getaddrinfo(self, host: Any, *args: Any, **kwargs: Any) -> Any:
        self.calls.append(("getaddrinfo", host))
        raise socket.gaierror("network refused by RW-1 test")

    def create_connection(self, address: Any, *args: Any, **kwargs: Any) -> Any:
        self.calls.append(("create_connection", address))
        raise OSError("network refused by RW-1 test")

    def patches(self) -> tuple[Any, Any]:
        return (
            patch.object(socket, "getaddrinfo", side_effect=self.getaddrinfo),
            patch.object(socket, "create_connection", side_effect=self.create_connection),
        )


class _Workspace(unittest.TestCase):
    """A throwaway workspace whose operator override sets the pull block."""

    def setUp(self) -> None:
        self.repo = Path(tempfile.mkdtemp(prefix="aria-rw1-"))
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        self.tools = ensure_tools_dir(self.repo / "aria-tools")

    def configure(self, base_url: str | None, **pull: Any) -> None:
        override = self.repo / "aria-config" / "genesis_policy.json"
        override.parent.mkdir(parents=True, exist_ok=True)
        override.write_text(
            json.dumps({"watchdog_pull": {"enabled": True, "observability_base_url": base_url, **pull}}),
            encoding="utf-8",
        )

    def sweep(self, *, suppress_emission: bool = True) -> dict[str, Any]:
        return run_watchdog_sweep(
            workspace_root=self.repo, tools_dir=self.tools, suppress_emission=suppress_emission,
        )

    def governance(self, kind: str) -> list[dict[str, Any]]:
        path = self.tools / "governance.jsonl"
        if not path.exists():
            return []
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        return [row for row in rows if row.get("kind") == kind]

    def report_lines(self, sweep_payload: dict[str, Any]) -> str:
        from aria_kernel import cycle as cycle_mod
        from aria_kernel.reflection import _render_watchdog_section

        context = cycle_mod.build_phase_context(
            cycle_id="cyc-rw1", workspace_root=self.repo, base_dir=self.tools,
        )
        context.results["watchdog_sweep"] = sweep_payload
        context.outcomes["watchdog_sweep"] = {"outcome": "ran"}
        with patch.object(cycle_mod, "record_cycle_metrics", side_effect=lambda **kw: kw) as record:
            cycle_mod._phase_metrics(context)
        digests = record.call_args.kwargs["phase_digests"] or {}
        return "\n".join(_render_watchdog_section({"phase_digest_summary": {"digests": digests}}))


    def runtime_signal_events(self) -> list[dict[str, Any]]:
        path = runtime_signal_events_path(self.tools)
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


# ─── Named holds: a source the sweep cannot read is said, never silent ──────


class AnUnreadableSourceIsANamedHold(_Workspace):
    def test_a_none_url_records_the_unconfigured_hold(self) -> None:
        self.configure(None)
        runtime = self.sweep()["runtime"]
        self.assertEqual(runtime.get("hold"), "source_unconfigured", runtime)

    def test_an_unreachable_loopback_source_records_the_unreachable_hold(self) -> None:
        self.configure(_closed_loopback_url())
        runtime = self.sweep()["runtime"]
        self.assertEqual(runtime.get("hold"), "source_unreachable", runtime)

    def test_a_non_loopback_source_is_a_hold_and_no_socket_is_opened(self) -> None:
        for url in (
            "http://aqua-prometheus:9090",          # the docker-network name
            "http://observability-service:3000",    # the key-gated base-state source
            "http://203.0.113.7:9090",              # a routable address
            "http://127.0.0.1.nip.io:9090",         # a name that merely LOOKS loopback
        ):
            with self.subTest(url=url):
                self.configure(url)
                network = _NetworkRecorder()
                lookup, connect = network.patches()
                with lookup, connect:
                    runtime = self.sweep()["runtime"]
                self.assertEqual(runtime.get("hold"), "source_not_loopback", runtime)
                self.assertEqual(network.calls, [], "a non-loopback source must be refused before any network act")


class TheHoldReachesTheCycleDigestAndTheReport(_Workspace):
    """The sweep payload alone is not the record: the cycle keeps a digest of
    it and the report renders the digest. A hold that stops at the payload is
    the silence RW-1 removes."""

    def test_the_unconfigured_hold_is_named_in_the_report(self) -> None:
        self.configure(None)
        self.assertIn("source_unconfigured", self.report_lines(self.sweep()))

    def test_the_unreachable_hold_is_named_in_the_report(self) -> None:
        self.configure(_closed_loopback_url())
        self.assertIn("source_unreachable", self.report_lines(self.sweep()))


class AnAnswerWithNoRuntimeSeriesIsANamedHold(_Workspace):
    """RW-1 corrective R2. A 200 that carries no runtime-family series — an
    empty body (every target down, label drift), an HTML page or an error
    document (a foreign listener on the unprivileged port) — is not a healthy
    night. Recorded as a clean read it was the silence RW-1 forbids."""

    _ANSWERS: dict[str, tuple[int, bytes, str]] = {
        "empty body": (200, b"", "text/plain; version=0.0.4"),
        "html page": (200, b"<!doctype html><html><body><h1>It works</h1></body></html>", "text/html"),
        "error document": (200, b'{"status":"error","errorType":"bad_data","error":"parse error"}', "application/json"),
        "only a non-runtime family": (
            200, b'up{app="farm-service",namespace="aquaculture"} 1 1761240000000\n', "text/plain; version=0.0.4",
        ),
    }

    def test_each_unusable_answer_is_a_named_hold_in_the_payload_and_the_report(self) -> None:
        for label, answer in self._ANSWERS.items():
            with self.subTest(answer=label), _RecordingPrometheus(raw=answer) as prometheus:
                self.configure(prometheus.base_url)
                payload = self.sweep()
                hold = payload["runtime"].get("hold")
                self.assertIn(hold, RUNTIME_SOURCE_HOLDS, payload["runtime"])
                self.assertIn(hold, self.report_lines(payload))

    def test_a_well_formed_answer_with_no_runtime_series_names_the_missing_families(self) -> None:
        with _RecordingPrometheus(lifetime=[]) as prometheus:
            self.configure(prometheus.base_url)
            payload = self.sweep()
        runtime = payload["runtime"]
        self.assertEqual(runtime.get("hold"), "source_empty", runtime)
        self.assertEqual(runtime.get("missing_families"), list(RUNTIME_METRIC_FAMILIES), runtime)
        report = self.report_lines(payload)
        for family in RUNTIME_METRIC_FAMILIES:
            self.assertIn(family, report)

    def test_a_read_names_the_families_it_found_no_series_for(self) -> None:
        with _RecordingPrometheus() as prometheus:
            self.configure(prometheus.base_url)
            payload = self.sweep()
        runtime = payload["runtime"]
        self.assertNotIn("hold", runtime, runtime)
        self.assertEqual(runtime.get("missing_families"), ["security_events_total"], runtime)
        self.assertIn("security_events_total", self.report_lines(payload))

    def test_the_disabled_hold_is_a_named_hold_too(self) -> None:
        override = self.repo / "aria-config" / "genesis_policy.json"
        override.parent.mkdir(parents=True, exist_ok=True)
        override.write_text(json.dumps({"watchdog_pull": {"enabled": False}}), encoding="utf-8")
        payload = self.sweep()
        self.assertEqual(payload["runtime"].get("hold"), "source_disabled", payload["runtime"])
        self.assertIn("source_disabled", self.report_lines(payload))


class RefusedLeadsReachTheDigestAndTheReport(_Workspace):
    """A lead the bridge refused is named in the sweep payload; it must not
    stop there (appellate R2 carried note: refused_leads never reached the
    digest or the report)."""

    def test_a_refused_lead_is_counted_in_the_report(self) -> None:
        refused = aria_watchdog.RuntimeAnomaly(
            pattern="runtime_http_5xx", service="farm-service", severity="medium",
            claim_summary="Production service farm-service answers 5xx.", facts=[],
            code_refs=["../outside-the-repo"],
        )
        with _RecordingPrometheus() as prometheus, patch.object(
            aria_watchdog, "detect_http_5xx_share", return_value=[refused],
        ), patch.object(aria_watchdog, "detect_security_critical_events", return_value=[]):
            self.configure(prometheus.base_url)
            payload = self.sweep(suppress_emission=False)
        self.assertEqual(len(payload["runtime"]["refused_leads"]), 1, payload["runtime"])
        self.assertIn("1 refused", self.report_lines(payload))


# ─── Least privilege on the wire ───────────────────────────────────────────


class ThePullerHoldsNoCredential(_Workspace):
    def test_the_puller_takes_no_credential_parameter(self) -> None:
        params = inspect.signature(pull_observability_metrics).parameters
        self.assertFalse(
            [name for name in params if re.search(r"key|token|secret|auth|password", name, re.I)],
            f"pull_observability_metrics{inspect.signature(pull_observability_metrics)} carries a credential channel",
        )

    def test_the_puller_itself_refuses_a_non_loopback_source(self) -> None:
        """The loopback rule lives in the ONE owner, so no caller can bypass it."""
        params = inspect.signature(pull_observability_metrics).parameters
        self.assertNotIn("api_key", params, "the shared-key parameter is the base-state puller")
        network = _NetworkRecorder()
        lookup, connect = network.patches()
        with lookup, connect:
            pull_observability_metrics(base_url="http://203.0.113.7:9090", window_seconds=86400)
        self.assertEqual(network.calls, [])

    def test_a_sweep_sends_only_credential_free_gets_to_the_prometheus_read_api(self) -> None:
        with _RecordingPrometheus() as prometheus, patch.dict(os.environ, {
            "ARIA_OBSERVABILITY_API_KEY": _SHARED_KEY_VALUE,
            "INTERNAL_API_KEY": _SHARED_KEY_VALUE,
        }):
            self.configure(prometheus.base_url)
            self.sweep()
        self.assertTrue(prometheus.requests, "a configured loopback source must be read")
        for request in prometheus.requests:
            self.assertFalse(_CREDENTIAL_HEADERS & set(request["headers"]), request["headers"])
            self.assertFalse(
                [v for v in request["headers"].values() if _SHARED_KEY_VALUE in v],
                "the shared internal key travelled in a header",
            )
            self.assertEqual(request["method"], "GET", request)
            self.assertTrue(
                request["path"].startswith(_PROMETHEUS_READ_PATHS),
                f"{request['path']!r} is not the Prometheus read-only API {_PROMETHEUS_READ_PATHS}",
            )

    def test_a_reachable_loopback_source_is_read_not_held(self) -> None:
        with _RecordingPrometheus() as prometheus:
            self.configure(prometheus.base_url)
            runtime = self.sweep()["runtime"]
        self.assertNotIn("hold", runtime, runtime)
        self.assertTrue(prometheus.requests)


# ─── The 5xx detector judges the present: a window, not a lifetime ─────────


def _farm_counters(ok: float, errors: float) -> list[_Sample]:
    scope = {"app": "farm-service", "namespace": "aquaculture", "method": "GET", "route": "/api"}
    return [
        ("http_requests_total", {**scope, "status_code": "200"}, ok),
        ("http_requests_total", {**scope, "status_code": "500"}, errors),
    ]


class TheDetectorJudgesTheWindowNotTheLifetime(_Workspace):
    """RW-1 corrective R4. Counters are cumulative: a detector that divides a
    container's lifetime 5xx by its lifetime requests describes the
    container's whole life. A resolved lead reopened every sweep with no new
    5xx, and a fresh storm on a long-lived service raised nothing. The
    detector judges the counters' increase inside ``watchdog_pull.window_seconds``,
    the sweep cadence."""

    def test_a_resolved_lead_stays_resolved_when_the_next_window_has_no_new_5xx(self) -> None:
        with _RecordingPrometheus(lifetime=_farm_counters(90, 10), window=_farm_counters(90, 10)) as prometheus:
            self.configure(prometheus.base_url)
            first = self.sweep(suppress_emission=False)["runtime"]
            (lead,) = first["leads"]
            resolve_runtime_signal(
                signal_id=lead["signal_id"], resolution_note="investigated after window 1", base_dir=self.tools,
            )
            # Window 2: 90 more requests, not one 5xx. The lifetime share is
            # still 10/190 = 5.3%, above the 5% threshold.
            prometheus.lifetime = _farm_counters(180, 10)
            prometheus.window = _farm_counters(90, 0)
            second = self.sweep(suppress_emission=False)["runtime"]
        self.assertEqual(second.get("leads"), [], second)
        record = fold_runtime_signals(self.runtime_signal_events())[lead["signal_id"]]
        self.assertEqual(record["status"], "resolved", record)

    def test_a_fresh_storm_on_a_long_lived_service_raises_exactly_one_lead(self) -> None:
        # 1e6 lifetime requests with 0.1% 5xx; the last window is 1000 of 1000.
        with _RecordingPrometheus(
            lifetime=_farm_counters(999_000, 1_000), window=_farm_counters(0, 1_000),
        ) as prometheus:
            self.configure(prometheus.base_url)
            runtime = self.sweep(suppress_emission=False)["runtime"]
        self.assertEqual(len(runtime.get("leads", [])), 1, runtime)
        observed = [e for e in self.runtime_signal_events() if e.get("event") == "observed"]
        self.assertEqual([e["service"] for e in observed], ["farm-service"])

    def test_the_window_the_source_is_asked_for_is_the_policy_field(self) -> None:
        with _RecordingPrometheus() as prometheus:
            self.configure(prometheus.base_url, window_seconds=7200)
            self.sweep()
        queries = [q for r in prometheus.requests for q in r["query"].get("query", [])]
        self.assertIn(
            'sum by (app,status_code) (increase(http_requests_total{namespace="aquaculture"}[7200s]))', queries,
        )


class TheWindowIsTheSweepCadence(unittest.TestCase):
    """The sweep runs once per scheduled cycle, so the default window is that
    cadence: consecutive sweeps judge consecutive windows, with no gap and no
    double count."""

    def test_the_default_window_is_the_scheduled_cycle_period(self) -> None:
        workflow = yaml.safe_load(
            (_REPO_ROOT / ".github" / "workflows" / "aria-auto-cycle.yml").read_text(encoding="utf-8")
        )
        triggers = workflow.get("on", workflow.get(True))
        (schedule,) = triggers["schedule"]
        minute, hour, day_of_month, month, day_of_week = schedule["cron"].split()
        self.assertTrue(minute.isdigit() and hour.isdigit(), schedule)
        self.assertEqual((day_of_month, month, day_of_week), ("*", "*", "*"), "a once-a-day cycle")
        self.assertEqual(WATCHDOG_PULL_DEFAULTS["window_seconds"], 24 * 3600)

    def test_a_window_outside_its_bounds_or_not_an_integer_is_refused_by_name(self) -> None:
        repo = Path(tempfile.mkdtemp(prefix="aria-rw1-window-"))
        self.addCleanup(shutil.rmtree, repo, ignore_errors=True)
        override = repo / "aria-config" / "genesis_policy.json"
        override.parent.mkdir(parents=True)
        for value in (0, 59, 15 * 24 * 3600, True, 3600.5, "3600s]) or vector(1", None):
            with self.subTest(window_seconds=value):
                override.write_text(json.dumps({"watchdog_pull": {"window_seconds": value}}), encoding="utf-8")
                with self.assertRaisesRegex(GovernanceError, "watchdog_pull.window_seconds"):
                    watchdog_pull_policy(repo)


class ThePolicyNamesTheLoopbackSourceAndNoCredential(unittest.TestCase):
    def test_no_policy_field_names_a_credential(self) -> None:
        offenders = [k for k in WATCHDOG_PULL_DEFAULTS if re.search(r"key|token|secret|auth|password", k, re.I)]
        self.assertEqual(offenders, [], "ARIA holds no shared internal API key — not even its env-var name")

    def test_the_default_source_is_the_loopback_prometheus(self) -> None:
        url = WATCHDOG_PULL_DEFAULTS["observability_base_url"]
        self.assertIsInstance(url, str, "a null default is why the production detectors never ran")
        parts = urlsplit(url)
        self.assertEqual((parts.scheme, parts.hostname), ("http", "127.0.0.1"), url)
        self.assertIsNotNone(parts.port, url)

    def test_the_tracked_default_and_the_typed_default_agree(self) -> None:
        """Guard (green at base): the package JSON and WATCHDOG_PULL_DEFAULTS
        are the same block, so the accessor never reads a second truth."""
        self.assertEqual(watchdog_pull_policy(), WATCHDOG_PULL_DEFAULTS)


class TheRunnerHoldsNoObservabilityKey(unittest.TestCase):
    """The provisioner required the shared key PRESENT in the runner `.env`.
    It is retired the ARIA_GH_TOKEN way (ARIA-CRITICAL-246): checked ABSENT."""

    def _loops(self) -> list[tuple[list[str], str]]:
        text = _PROVISIONER.read_text(encoding="utf-8")
        start = text.index('env_file="${RUNNER_ROOT}/.env"')
        end = text.find("\nsection ", start)
        section = text[start:] if end == -1 else text[start:end]
        return [
            (names.split(), body)
            for names, body in re.findall(r"^for key in ([A-Z0-9_ ]+); do$(.*?)^done$", section, re.M | re.S)
        ]

    def test_the_key_is_not_required_present(self) -> None:
        required = [name for names, body in self._loops() if "missing from" in body for name in names]
        self.assertNotIn("ARIA_OBSERVABILITY_API_KEY", required)

    def test_the_key_is_checked_absent(self) -> None:
        absent = [name for names, body in self._loops() if "absent from" in body for name in names]
        self.assertIn("ARIA_OBSERVABILITY_API_KEY", absent)


# ─── Runtime claims go through the existing proof gate ─────────────────────


class RuntimeCandidatesEnterTheRuntimeSignalClaimPath(_Workspace):
    """A telemetry anomaly is an UNVERIFIED lead (runtime_signal_bridge), not a
    finding: it decides where ARIA looks; repo evidence and a red reproduction
    (finding.record_finding_reproduction) decide what is true."""

    def _farm_5xx(self) -> Any:
        (finding,) = detect_http_5xx_share(
            _farm_counters(90, 10), threshold=0.05, min_requests=50, window_seconds=86400,
        )
        return finding

    def _sweep_with_a_farm_5xx_candidate(self, *, suppress_emission: bool) -> dict[str, Any]:
        candidate = self._farm_5xx()
        with _RecordingPrometheus() as prometheus, patch.object(
            aria_watchdog, "detect_http_5xx_share", return_value=[candidate],
        ), patch.object(aria_watchdog, "detect_security_critical_events", return_value=[]):
            self.configure(prometheus.base_url)
            return self.sweep(suppress_emission=suppress_emission)

    def test_a_runtime_candidate_is_ingested_as_an_unverified_telemetry_lead(self) -> None:
        self._sweep_with_a_farm_5xx_candidate(suppress_emission=False)
        observed = [e for e in self.runtime_signal_events() if e.get("event") == "observed"]
        self.assertEqual(len(observed), 1, observed)
        (event,) = observed
        self.assertEqual(
            (event["source"], event["service"], event["trust_grade"]),
            ("telemetry", "farm-service", "runtime_unverified"),
        )
        self.assertTrue(event["code_refs"])
        self.assertTrue(all(ref.startswith("apps/farm-service") for ref in event["code_refs"]), event["code_refs"])

    def test_the_watchdog_mints_no_telemetry_finding_and_rejects_nothing_silently(self) -> None:
        self._sweep_with_a_farm_5xx_candidate(suppress_emission=False)
        self.assertEqual(self.governance("aria_watchdog_emit_rejected"), [])
        minted = [
            row for row in self.governance("aria_watchdog_finding_emitted")
            if str(row["details"].get("pattern", "")).startswith("runtime_")
        ]
        self.assertEqual(minted, [], "a telemetry claim became a finding without reproduction")

    def test_aria_stop_suppression_ingests_nothing(self) -> None:
        """Guard (green at base): suppress_emission (ARIA_STOP / SIGTERM) writes no lead."""
        self._sweep_with_a_farm_5xx_candidate(suppress_emission=True)
        self.assertEqual(self.runtime_signal_events(), [])


# ─── One puller ────────────────────────────────────────────────────────────


def _string_constants_by_function(path: Path) -> list[tuple[str | None, str]]:
    """(enclosing top-level function name or None, string constant) for a module."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    found: list[tuple[str | None, str]] = []

    def walk(node: ast.AST, owner: str | None) -> None:
        for child in ast.iter_child_nodes(node):
            child_owner = owner
            if owner is None and isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                child_owner = child.name
            if isinstance(child, ast.Constant) and isinstance(child.value, str):
                found.append((child_owner, child.value))
            walk(child, child_owner)

    walk(tree, None)
    return found


class OnePullerOfTheMetricsSource(unittest.TestCase):
    def test_only_pull_observability_metrics_speaks_the_prometheus_api(self) -> None:
        owners: list[tuple[str, str | None]] = []
        for path in sorted(_PACKAGE_ROOT.rglob("*.py")):
            for owner, value in _string_constants_by_function(path):
                if any(api in value for api in _PROMETHEUS_READ_PATHS):
                    owners.append((path.relative_to(_PACKAGE_ROOT).as_posix(), owner))
        self.assertTrue(owners, "no kernel code reads the Prometheus read-only API")
        self.assertEqual(
            sorted(set(owners)), [("aria_watchdog.py", "pull_observability_metrics")],
            "the metrics source has exactly one puller",
        )

    def test_no_kernel_code_names_the_shared_internal_key_header(self) -> None:
        offenders = [
            path.relative_to(_PACKAGE_ROOT).as_posix()
            for path in sorted(_PACKAGE_ROOT.rglob("*.py"))
            for _, value in _string_constants_by_function(path)
            if "x-internal-api-key" in value.lower()
        ]
        self.assertEqual(offenders, [])

    def test_the_watchdog_opens_http_only_in_the_puller(self) -> None:
        """Guard (green at base): no second request site inside aria_watchdog."""
        tree = ast.parse(inspect.getsource(aria_watchdog))
        sites: list[str] = []
        for function in (n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))):
            for node in ast.walk(function):
                if isinstance(node, ast.Attribute) and node.attr in {"urlopen", "HTTPConnection", "HTTPSConnection"}:
                    sites.append(function.name)
        self.assertEqual(set(sites), {"pull_observability_metrics"})


# ─── The source the repo publishes stays on loopback ───────────────────────


class EveryPublishedPrometheusPortIsLoopback(unittest.TestCase):
    """Guard (green at base): a Prometheus port published by any tracked
    compose file binds 127.0.0.1 — the source is loopback on the host side
    too, not only in ARIA's policy."""

    def test_prometheus_ports_bind_loopback(self) -> None:
        offenders: list[str] = []
        compose_files = sorted(_REPO_ROOT.glob("docker-compose*.yml")) + sorted(
            (_REPO_ROOT / "infrastructure").rglob("*compose*.y*ml")
        )
        for path in compose_files:
            document = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
            for name, service in (document.get("services") or {}).items():
                if "prometheus" not in str(service.get("image", "")):
                    continue
                for port in service.get("ports") or []:
                    if not str(port).startswith("127.0.0.1:"):
                        offenders.append(f"{path.relative_to(_REPO_ROOT)}:{name}:{port}")
        self.assertEqual(offenders, [])


if __name__ == "__main__":
    unittest.main()
