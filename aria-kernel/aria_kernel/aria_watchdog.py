"""V10.5 Phase 1 — ARIA-Watchdog read-only daemon.

Per ADR-0002 (accepted): a long-running daemon that polls
governance.jsonl + autonomy_state.jsonl every 60s, detects 2 MVP
operational anomaly patterns (stall + repeated bridge_warning),
emits sanitized findings via finding.emit_finding through the
ORIGINATING_SKILL_ALLOWLIST gate.

Architecture:
- Pure-function detectors return list[WatchdogFinding] value objects
- Daemon owns side-effecting emission (atomic + dedup-capped)
- ARIA_STOP coordinates clean exit (per autonomous_planner_dispatcher pattern)
- SIGTERM-safe sleep via threading.Event.wait
- Dedup ledger at aria-tools/aria_watchdog_signatures.jsonl (10/24h cap)
- Bounded governance read via since_ts incremental polling

Reference: docs/recommendations/architectural-arbiter/2026-05-20-adr-0002-aria-watchdog.md
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import math
import os
import signal
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable
from urllib.parse import urlencode, urlsplit

from .file_lock import with_exclusive_lock
from .strict_jsonl_reader import read_strict_jsonl
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_binding

if TYPE_CHECKING:
    from .provider_clock import ProviderClock


# ─── Configuration constants (per ADR-0002) ──────────────────────────────
DEFAULT_WATCHDOG_POLL_INTERVAL_SECONDS: float = 60.0
DEFAULT_WATCHDOG_DAEMON_ID: str = "aria-watchdog"

STALL_THRESHOLD_SECONDS: int = 600
BRIDGE_WARNING_REPEAT_THRESHOLD: int = 3
BRIDGE_WARNING_WINDOW_SECONDS: int = 600

MAX_FINDINGS_PER_PATTERN_PER_24H: int = 10
MAX_FINDINGS_GLOBAL_PER_24H: int = 30
SUPPRESSION_STORM_THRESHOLD: int = 100  # per pattern signature

WATCHDOG_SIGNATURE_LEDGER_FILENAME: str = "aria_watchdog_signatures.jsonl"

# ─── Value objects ───────────────────────────────────────────────────────


@dataclass(frozen=True)
class WatchdogFinding:
    """Detector output — pure value object, no side effects.

    Converted to a finding.emit_finding call by the daemon loop wrapper.
    """
    pattern: str            # e.g. "stall", "bridge_warning_repeat"
    severity: str           # "MEDIUM" or "LOW"
    claim_summary: str      # one-sentence template
    facts: list[str]
    evidences: list[dict[str, str]]  # [{"ref": "governance.jsonl:line-N", "summary": "..."}]
    scope_files: list[str]
    pattern_signature_hash: str
    originating_skill: str  # MUST match ORIGINATING_SKILL_ALLOWLIST


# ─── Pure detectors (testable in isolation) ──────────────────────────────


def _parse_iso(value: str | None) -> datetime | None:
    if not value or not isinstance(value, str):
        return None
    try:
        if value.endswith("Z"):
            value = value[:-1] + "+00:00"
        return datetime.fromisoformat(value).astimezone(timezone.utc)
    except (ValueError, AttributeError):
        return None


def _signature_hash(*parts: str) -> str:
    """Deterministic signature for dedup ledger keying."""
    payload = "|".join(parts)
    return "wd-v1:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


# ─── Runtime metrics source (RW-1) ───────────────────────────────────────
#
# The source is the droplet Prometheus's read-only HTTP API, published on
# the host's loopback only (127.0.0.1:9090 in every tracked compose
# Prometheus that publishes a port). Prometheus already scrapes every
# backend's public /metrics through the catalog-generated file_sd, so ARIA
# reads them without holding any credential: the observability-service
# /metrics it used to read is gated by the platform's shared
# INTERNAL_API_KEY, and ARIA holds no such key.
#
# Counters are cumulative, so the detectors judge each family's INCREASE
# over the policy window (watchdog_pull.window_seconds, the sweep cadence),
# asked of Prometheus's instant-query API, never the lifetime totals.

# The metric families the runtime detectors read, each with the labels its
# windowed increase is summed by, and the scrape scope they are read from:
# the platform's own targets (the file_sd sets namespace="aquaculture" on
# every catalog service, and `app` to its service id).
RUNTIME_FAMILY_GROUPS: dict[str, tuple[str, ...]] = {
    "http_requests_total": ("app", "status_code"),
    "security_events_total": ("app", "severity", "type"),
}
RUNTIME_METRIC_FAMILIES: tuple[str, ...] = tuple(RUNTIME_FAMILY_GROUPS)
RUNTIME_SCRAPE_SCOPE: str = 'namespace="aquaculture"'
# The label naming the production service a sample came from: the target
# label the catalog file_sd sets (the scraper's word, which an exporter
# cannot override).
RUNTIME_SERVICE_LABEL: str = "app"
# The one producer of security_events_total
# (apps/observability-service/src/security-events/security-metrics.service.ts).
SECURITY_EVENTS_SERVICE: str = "observability-service"
SECURITY_EVENTS_CODE_AREA: str = "apps/observability-service/src/security-events"
MAX_RUNTIME_METRICS_BYTES: int = 8 * 1024 * 1024

# Every way the runtime feed can be left unread, by name. A sweep that does
# not read the source says which of these held it; it is never silent.
RUNTIME_SOURCE_HOLDS: frozenset[str] = frozenset({
    "source_disabled",       # watchdog_pull.enabled is false
    "source_unconfigured",   # watchdog_pull.observability_base_url is null/empty
    "source_invalid",        # not an http://<ip>:<port> origin (userinfo, path, query, no port)
    "source_not_loopback",   # the host is not a loopback IP literal — refused before any socket
    "source_unreachable",    # the connection failed or timed out
    "source_refused",        # the source answered, but not with a usable instant-query answer
                             # (a non-200, an HTML page, an error document, an oversized body)
    "source_empty",          # well-formed answers holding no series of any RUNTIME_METRIC_FAMILIES
                             # (label drift, every target down)
})


@dataclass(frozen=True)
class SourceHold:
    """Why the runtime source was not read: a RUNTIME_SOURCE_HOLDS name and its detail.

    The name is checked against the closed vocabulary when the hold is
    made, so the digest and the report can only ever carry a known hold.
    """

    name: str
    detail: str

    def __post_init__(self) -> None:
        if self.name not in RUNTIME_SOURCE_HOLDS:
            raise ValueError(f"unknown runtime source hold: {self.name!r}")


def _loopback_origin(base_url: object) -> tuple[str, int] | SourceHold:
    """``(host, port)`` of a loopback ``http://<ip>:<port>`` origin, else the hold it earns.

    Only an IP literal counts: a host NAME is refused without a lookup,
    because resolving it is already a network act and a name that reads
    like loopback (``127.0.0.1.nip.io``) can resolve anywhere.
    """
    if base_url is None or base_url == "":
        return SourceHold("source_unconfigured", "watchdog_pull.observability_base_url is not set")
    if not isinstance(base_url, str):
        return SourceHold("source_invalid", f"observability_base_url is a {type(base_url).__name__}")
    parts = urlsplit(base_url.strip())
    if parts.scheme != "http" or parts.username is not None or parts.password is not None:
        return SourceHold("source_invalid", "the source is a plain http origin with no userinfo")
    if parts.path not in ("", "/") or parts.query or parts.fragment:
        return SourceHold("source_invalid", "the source is an origin: no path, query or fragment")
    try:
        port = parts.port
    except ValueError as exc:
        return SourceHold("source_invalid", f"port: {exc}")
    if port is None:
        return SourceHold("source_invalid", "the source names its port")
    host = parts.hostname or ""
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return SourceHold("source_not_loopback", f"{host[:80]!r} is a name, not a loopback address")
    if not address.is_loopback:
        return SourceHold("source_not_loopback", f"{host} is not a loopback address")
    return host, port


def runtime_increase_query(family: str, window_seconds: int) -> str:
    """The PromQL the puller asks for one runtime family: its increase over the
    window, inside the platform's scrape scope, summed by the family's labels."""
    labels = ",".join(RUNTIME_FAMILY_GROUPS[family])
    return f"sum by ({labels}) (increase({family}{{{RUNTIME_SCRAPE_SCOPE}}}[{window_seconds}s]))"


RuntimeSample = tuple[str, dict[str, str], float]


def pull_observability_metrics(
    *,
    base_url: str | None,
    window_seconds: int,
    timeout_seconds: int = 5,
) -> tuple[list[RuntimeSample] | None, SourceHold | None]:
    """RW-1 — the ONE reader of the runtime metrics source.

    Credential-free GETs of the Prometheus instant-query API (read-only),
    one per RUNTIME_METRIC_FAMILIES member, each asking for the family's
    increase over ``window_seconds`` (runtime_increase_query), on a loopback
    origin only. Returns ``(samples, None)`` — ``(family, labels, increase)``
    per series — or ``(None, SourceHold)``.

    The loopback rule lives here, so no caller can bypass it: anything but a
    loopback IP literal is held before a socket is opened. http.client, not
    urllib: urllib follows redirects (a loopback answer could send the
    request anywhere) and honours ``*_proxy`` from the environment; a direct
    connection does neither and sends no User-Agent.
    """
    import http.client

    origin = _loopback_origin(base_url)
    if isinstance(origin, SourceHold):
        return None, origin
    host, port = origin
    connection = http.client.HTTPConnection(host, port, timeout=timeout_seconds)
    samples: list[RuntimeSample] = []
    try:
        for family in RUNTIME_METRIC_FAMILIES:
            path = "/api/v1/query?" + urlencode([("query", runtime_increase_query(family, window_seconds))])
            connection.request("GET", path, headers={"Accept": "application/json"})
            response = connection.getresponse()
            body = response.read(MAX_RUNTIME_METRICS_BYTES + 1)
            if response.status != 200:
                return None, SourceHold("source_refused", f"{family}: http_{response.status}")
            if len(body) > MAX_RUNTIME_METRICS_BYTES:
                return None, SourceHold("source_refused", f"{family}: answer exceeds {MAX_RUNTIME_METRICS_BYTES} bytes")
            family_samples = parse_instant_vector(family, body)
            if isinstance(family_samples, SourceHold):
                return None, family_samples
            samples.extend(family_samples)
    except http.client.HTTPException as exc:
        return None, SourceHold("source_refused", f"{type(exc).__name__}: {str(exc)[:120]}")
    except OSError as exc:
        return None, SourceHold("source_unreachable", f"{type(exc).__name__}: {str(exc)[:120]}")
    finally:
        connection.close()
    return samples, None


def parse_instant_vector(family: str, body: bytes) -> list[RuntimeSample] | SourceHold:
    """A Prometheus instant-query answer → ``(family, labels, value)`` samples.

    The answer is the API's success envelope around an instant vector:
    ``{"status": "success", "data": {"resultType": "vector", "result":
    [{"metric": {label: value}, "value": [ts, "<number>"]}]}}``. Anything
    else — an HTML page, an error document, a series whose labels or value
    are not that shape — is the source_refused hold, named with what was
    wrong: an answer is read whole or not at all.
    """
    def refused(why: str) -> SourceHold:
        return SourceHold("source_refused", f"{family}: {why}")

    try:
        document = json.loads(body)
    except ValueError:
        return refused("not a JSON query answer")
    if not isinstance(document, dict) or document.get("status") != "success":
        status = document.get("status") if isinstance(document, dict) else type(document).__name__
        return refused(f"query status {str(status)[:40]!r}")
    data = document.get("data")
    if not isinstance(data, dict) or data.get("resultType") != "vector" or not isinstance(data.get("result"), list):
        return refused("not an instant vector")
    samples: list[RuntimeSample] = []
    for series in data["result"]:
        metric = series.get("metric") if isinstance(series, dict) else None
        point = series.get("value") if isinstance(series, dict) else None
        if not isinstance(metric, dict) or not all(
            isinstance(key, str) and isinstance(value, str) for key, value in metric.items()
        ):
            return refused("a series whose labels are not strings")
        if not isinstance(point, list) or len(point) != 2 or not isinstance(point[1], str):
            return refused("a series whose value is not [timestamp, \"<number>\"]")
        try:
            value = float(point[1])
        except ValueError:
            return refused(f"a series value {point[1][:40]!r} that is not a number")
        if not math.isfinite(value):
            return refused(f"a series value {point[1][:40]!r} that is not finite")
        samples.append((family, dict(metric), value))
    return samples


@dataclass(frozen=True)
class RuntimeAnomaly:
    """A runtime detector's output: an UNVERIFIED telemetry lead, never a finding.

    It enters ARIA only through runtime_signal_bridge.ingest_runtime_signal
    (source ``telemetry``, ``trust_grade=runtime_unverified``): it points the
    repo-evidence machinery at ``code_refs``; a finding about it is minted
    only by that machinery, with its proof through
    finding.record_finding_reproduction, so it carries no originating_skill
    (finding.ORIGINATING_SKILL_ALLOWLIST has no watchdog runtime origin).
    The summary is stable for one (pattern, subject) — the bridge derives
    the signal id from it, so a
    repeat sighting counts on the open signal instead of opening another —
    and the measured values live in ``facts`` (the sweep payload).
    """

    pattern: str
    service: str
    severity: str            # runtime_signal_bridge.RUNTIME_SEVERITIES
    claim_summary: str
    facts: list[str]
    code_refs: list[str]


def detect_http_5xx_share(
    samples: list[RuntimeSample],
    *,
    threshold: float,
    min_requests: int,
    window_seconds: int,
) -> list[RuntimeAnomaly]:
    """A 5xx share above threshold on a meaningful request volume, per service,
    inside the window: ``samples`` are each series' increase over the last
    ``window_seconds`` (pull_observability_metrics), so a past storm a
    container still carries in its lifetime counters raises nothing, and a
    fresh one on a long-lived service is judged on its own volume.

    A sample that names no service (RUNTIME_SERVICE_LABEL) cannot point at
    a code area, so it counts toward no service; the sweep names how many
    such series it read (``unattributed_series``), so a feed whose targets
    lost the label is never recorded as clean.
    """
    errors_by_service: dict[str, float] = {}
    total_by_service: dict[str, float] = {}
    for name, labels, value in samples:
        if name != "http_requests_total":
            continue
        service = labels.get(RUNTIME_SERVICE_LABEL)
        if not service:
            continue
        total_by_service[service] = total_by_service.get(service, 0.0) + value
        if str(labels.get("status_code") or "").startswith("5"):
            errors_by_service[service] = errors_by_service.get(service, 0.0) + value
    anomalies: list[RuntimeAnomaly] = []
    for service, errors in sorted(errors_by_service.items()):
        service_total = total_by_service[service]
        if service_total < min_requests:
            continue
        share = errors / service_total
        if share < threshold:
            continue
        anomalies.append(RuntimeAnomaly(
            pattern="runtime_http_5xx",
            service=service,
            severity="medium",
            claim_summary=(
                f"Production service {service} answered at least {threshold:.0%} of its requests "
                f"in the last {window_seconds}s with 5xx (minimum volume {min_requests} requests)."
            ),
            facts=[
                f"increase(http_requests_total[{window_seconds}s]) 5xx={int(errors)} "
                f"total={int(service_total)} share={share:.1%}",
                f"threshold={threshold:.0%} min_requests={min_requests}",
            ],
            code_refs=[f"apps/{service}"],
        ))
    return anomalies


def detect_security_critical_events(
    samples: list[RuntimeSample],
    *,
    window_seconds: int,
) -> list[RuntimeAnomaly]:
    """Any critical-severity security event counted inside the window."""
    anomalies: list[RuntimeAnomaly] = []
    for name, labels, value in samples:
        if name != "security_events_total" or value <= 0:
            continue
        severity = str(labels.get("severity") or "").lower()
        if severity != "critical":
            continue
        event_type = labels.get("type") or "unknown"
        anomalies.append(RuntimeAnomaly(
            pattern="runtime_security_critical",
            service=SECURITY_EVENTS_SERVICE,
            severity="medium",
            claim_summary=(
                f"Production security telemetry counted critical-severity events of type {event_type} "
                f"in the last {window_seconds}s."
            ),
            facts=[
                f"increase(security_events_total{{severity=critical,type={event_type}}}[{window_seconds}s])"
                f"={int(value)}"
            ],
            code_refs=[SECURITY_EVENTS_CODE_AREA],
        ))
    return anomalies


def detect_stall(
    governance_rows: list[dict[str, Any]],
    autonomy_rows: list[dict[str, Any]],
    *,
    now: datetime,
    clock: "ProviderClock",
    threshold_seconds: int = STALL_THRESHOLD_SECONDS,
    skip_states: tuple[str, ...] = ("HUMAN_REQUIRED", "CONVERGED", "ABANDONED_BY_OPERATOR"),
    api_backoff_grace_seconds: int = 600,
) -> list[WatchdogFinding]:
    """Detect plan_ids with no state-machine event for >threshold_seconds.

    The age is PROVIDER-AVAILABLE time (ARIA-HIGH-366, ``clock``): a plan
    that stopped only because a provider was in an open outage is not a
    stall, and turning every such plan into a MEDIUM finding buried the one
    signal that matters (the outage's own HUMAN_REQUIRED item). An outage
    of ANY provider heading a planning role pauses it — a finding raised
    late is still raised, while a finding raised for an outage is noise.

    SKIPs:
    - Cycles in legitimate terminal states (HUMAN_REQUIRED, CONVERGED) —
      these are not stalls (AISAFETY-HIGH-010 fix).
    - Cycles in active api_backoff_engaged within 600s (cross-phase with F-023;
      legitimate backoff sleep, not stall — PERF-MEDIUM-009 fix).
    """
    findings: list[WatchdogFinding] = []
    seen_plan_ids: set[str] = set()

    # Build last-event map per plan_id from governance + autonomy.
    plan_last_event: dict[str, dict[str, Any]] = {}
    plan_in_backoff_until: dict[str, datetime] = {}
    plan_terminal_state: dict[str, str] = {}

    for row in governance_rows:
        # Extract plan_id from top-level OR nested details.plan_id.
        plan_id = row.get("plan_id")
        if not isinstance(plan_id, str):
            details = row.get("details")
            if isinstance(details, dict):
                nested = details.get("plan_id")
                plan_id = nested if isinstance(nested, str) else None
        if not isinstance(plan_id, str):
            continue
        ts = _parse_iso(row.get("ts") or row.get("occurred_at"))
        if ts is None:
            continue
        prior = plan_last_event.get(plan_id)
        if prior is None or _parse_iso(prior.get("ts") or prior.get("occurred_at")) < ts:
            plan_last_event[plan_id] = row
        # Track api_backoff windows
        kind = row.get("kind")
        if kind == "api_backoff_engaged":
            plan_in_backoff_until[plan_id] = ts + timedelta(seconds=api_backoff_grace_seconds)
        # Track terminal state markers
        if kind in {"convergence_resolved", "convergence_abandoned"}:
            plan_terminal_state[plan_id] = "CONVERGED"
        if kind == "human_required_recorded":
            plan_terminal_state[plan_id] = "HUMAN_REQUIRED"

    for autonomy in autonomy_rows:
        plan_id = autonomy.get("plan_id")
        if not isinstance(plan_id, str):
            continue
        state = autonomy.get("current_state") or autonomy.get("state")
        if isinstance(state, str):
            plan_terminal_state[plan_id] = state

    threshold_delta = timedelta(seconds=threshold_seconds)
    from .provider_clock import planning_heads

    heads = planning_heads()

    for plan_id, last_event in plan_last_event.items():
        if plan_id in seen_plan_ids:
            continue
        seen_plan_ids.add(plan_id)
        last_ts = _parse_iso(last_event.get("ts") or last_event.get("occurred_at"))
        if last_ts is None:
            continue
        if now - last_ts < threshold_delta:
            continue

        # Review HIGH-2: scoped to the providers heading the planning roles,
        # never "any provider": an outage of a provider no plan routes to
        # would otherwise silence every stall finding until it is restored.
        age = (now - last_ts) - clock.covered_any(last_ts, now, heads)
        if age < threshold_delta:
            continue
        # Skip terminal states
        terminal = plan_terminal_state.get(plan_id, "")
        if terminal in skip_states:
            continue
        # Skip active api_backoff_engaged
        backoff_deadline = plan_in_backoff_until.get(plan_id)
        if backoff_deadline is not None and now < backoff_deadline:
            continue
        # Emit
        sig = _signature_hash("stall", plan_id)
        findings.append(WatchdogFinding(
            pattern="stall",
            severity="MEDIUM",
            claim_summary=f"plan {plan_id} stalled at last state-machine event for {int(age.total_seconds())}s (threshold {threshold_seconds}s)",
            facts=[
                f"plan_id={plan_id}",
                f"last_event_at={last_ts.isoformat()}",
                f"age_seconds={int(age.total_seconds())}",
                f"last_event_kind={last_event.get('kind', '<unknown>')}",
            ],
            evidences=[
                {"ref": "aria-tools/governance.jsonl", "summary": f"latest event for {plan_id} at {last_ts.isoformat()}"},
                {"ref": "aria-tools/autonomy_state.jsonl", "summary": f"current_state={terminal or 'non-terminal'}"},
                {"ref": f"plan:{plan_id}", "summary": "no state-machine transition observed within threshold"},
            ],
            scope_files=["aria-tools/governance.jsonl", "aria-tools/autonomy_state.jsonl"],
            pattern_signature_hash=sig,
            originating_skill="aria-watchdog:stall",
        ))
    return findings


def detect_repeated_bridge_warning(
    governance_rows: list[dict[str, Any]],
    *,
    now: datetime,
    repeat_threshold: int = BRIDGE_WARNING_REPEAT_THRESHOLD,
    window_seconds: int = BRIDGE_WARNING_WINDOW_SECONDS,
) -> list[WatchdogFinding]:
    """Detect same error_class fired >=repeat_threshold times in window_seconds.

    Per AISAFETY-HIGH-005: signature input uses the categorical
    `details.error_class` field (when present) — NOT the freeform
    `details.error` string (which could be LLM-controlled).

    Falls back to details.error for compat with V10.4 governance rows
    that pre-date error_class.
    """
    window_delta = timedelta(seconds=window_seconds)
    window_start = now - window_delta

    # Group by error_class (preferred) or error (fallback).
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in governance_rows:
        if row.get("kind") != "agent_bridge_warning":
            continue
        ts = _parse_iso(row.get("ts") or row.get("occurred_at"))
        if ts is None or ts < window_start:
            continue
        details = row.get("details") or {}
        if not isinstance(details, dict):
            continue
        # Prefer categorical error_class; fall back to first 80 chars of error.
        error_class = details.get("error_class")
        if isinstance(error_class, str) and error_class:
            key = error_class
        else:
            error = details.get("error", "")
            if not isinstance(error, str) or not error:
                continue
            # Truncate freeform error to first whitespace-delimited token + 40 chars
            # for dedup stability. This is a compat shim until error_class is
            # universally populated (tracked in F-AUTO-V10.6-EXTRA-DETECTORS).
            key = (error.split()[0] if error.split() else "")[:80]
            if not key:
                continue
        grouped.setdefault(key, []).append(row)

    findings: list[WatchdogFinding] = []
    for error_key, rows in grouped.items():
        if len(rows) < repeat_threshold:
            continue
        sig = _signature_hash("bridge_warning_repeat", error_key)
        first_ts = _parse_iso(rows[0].get("ts") or rows[0].get("occurred_at"))
        last_ts = _parse_iso(rows[-1].get("ts") or rows[-1].get("occurred_at"))
        findings.append(WatchdogFinding(
            pattern="bridge_warning_repeat",
            severity="MEDIUM",
            claim_summary=f"agent_bridge_warning '{error_key}' fired {len(rows)}x in {window_seconds}s window",
            facts=[
                f"error_key={error_key}",
                f"occurrence_count={len(rows)}",
                f"window_seconds={window_seconds}",
                f"first_occurrence={first_ts.isoformat() if first_ts else '<unknown>'}",
                f"last_occurrence={last_ts.isoformat() if last_ts else '<unknown>'}",
            ],
            evidences=[
                {"ref": "aria-tools/governance.jsonl", "summary": f"agent_bridge_warning occurrence {i+1}/{len(rows)}"}
                for i in range(min(len(rows), 5))
            ],
            scope_files=["aria-tools/governance.jsonl"],
            pattern_signature_hash=sig,
            originating_skill="aria-watchdog:bridge_warning_repeat",
        ))
    return findings


# ─── Dedup ledger (signature cap enforcement) ────────────────────────────


def _read_signature_ledger(tools_dir: Path) -> list[dict[str, Any]]:
    """Read aria_watchdog_signatures.jsonl rows (24h-windowed, best-effort)."""
    ledger_path = tools_dir / WATCHDOG_SIGNATURE_LEDGER_FILENAME
    if not ledger_path.exists():
        return []
    rows: list[dict[str, Any]] = []
    try:
        with ledger_path.open("r", encoding="utf-8") as fh:
            for line in fh:
                if not line.strip():
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        return []
    return rows


def _emission_allowed(
    *,
    tools_dir: Path,
    signature_hash: str,
    pattern: str,
    now: datetime,
    per_pattern_cap: int = MAX_FINDINGS_PER_PATTERN_PER_24H,
    global_cap: int = MAX_FINDINGS_GLOBAL_PER_24H,
) -> tuple[bool, str]:
    """Returns (allowed, suppression_reason). Reads dedup ledger.

    Caps:
    - per (pattern, signature_hash): per_pattern_cap emissions per 24h
    - global: global_cap emissions per 24h regardless of pattern
    """
    rows = _read_signature_ledger(tools_dir)
    window_start = now - timedelta(hours=24)
    per_sig_count = 0
    global_count = 0
    for row in rows:
        emitted_at = _parse_iso(row.get("emitted_at"))
        if emitted_at is None or emitted_at < window_start:
            continue
        global_count += 1
        if row.get("signature_hash") == signature_hash and row.get("pattern") == pattern:
            per_sig_count += 1
    if per_sig_count >= per_pattern_cap:
        return False, "per_pattern_cap_reached"
    if global_count >= global_cap:
        return False, "global_cap_reached"
    return True, ""


def _append_signature(
    *,
    tools_dir: Path,
    pattern: str,
    signature_hash: str,
    finding_id: str,
    daemon_agent_id: str,
    now: datetime,
) -> None:
    """Append an emission row to the dedup ledger (fcntl-locked)."""
    ledger_path = tools_dir / WATCHDOG_SIGNATURE_LEDGER_FILENAME
    lock_path = tools_dir / (WATCHDOG_SIGNATURE_LEDGER_FILENAME + ".lock")
    row = {
        "pattern": pattern,
        "signature_hash": signature_hash,
        "finding_id": finding_id,
        "daemon_agent_id": daemon_agent_id,
        "emitted_at": now.isoformat(),
    }
    with with_exclusive_lock(lock_path, timeout_seconds=5.0):
        with ledger_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, sort_keys=True) + "\n")


# ─── Ledger reads (governance + autonomy) ────────────────────────────────


def _load_jsonl(path: Path, *, since_ts: datetime | None = None) -> list[dict[str, Any]]:
    """Load JSONL rows, optionally filtered by ts >= since_ts."""
    if not path.exists():
        return []
    try:
        rows = list(
            read_strict_jsonl(
                path,
                on_corruption="tolerant",
                base_dir=path.parent,
            )
        )
    except OSError:
        return []
    if since_ts is None:
        return rows
    return [
        row
        for row in rows
        if (
            (ts := _parse_iso(row.get("ts") or row.get("occurred_at")))
            is not None
            and ts >= since_ts
        )
    ]


# ─── Daemon loop ─────────────────────────────────────────────────────────


def _emit_watchdog_finding(
    *,
    finding: WatchdogFinding,
    tools_dir: Path,
    repo_root: Path,
    daemon_agent_id: str,
    interrupt_event: threading.Event,
    now: datetime,
) -> dict[str, Any] | None:
    """Emit a single WatchdogFinding via finding.emit_finding.

    Honors dedup cap. On cap-reached, emits aria_watchdog_finding_suppressed
    governance event + returns None. On success returns the finding record.
    """
    from . import finding as finding_module
    allowed, suppression_reason = _emission_allowed(
        tools_dir=tools_dir,
        signature_hash=finding.pattern_signature_hash,
        pattern=finding.pattern,
        now=now,
    )
    if not allowed:
        append_tools_governance(tools_dir, "aria_watchdog_finding_suppressed", {
            "pattern": finding.pattern,
            "signature_hash": finding.pattern_signature_hash,
            "reason": suppression_reason,
            "daemon_agent_id": daemon_agent_id,
        })
        return None
    if interrupt_event.is_set():
        # ARIA_STOP after detector ran but before emission — skip cleanly.
        return None
    try:
        record = finding_module.emit_finding(
            repo_root=repo_root,
            base_dir=tools_dir,
            claim_type="operational_anomaly",
            claim_summary=finding.claim_summary,
            severity=finding.severity,
            certainty="OBSERVED",
            evidences=finding.evidences,
            facts=finding.facts,
            scope_files=finding.scope_files,
            originating_skill=finding.originating_skill,
        )
    except GovernanceError:
        # Emission rejected by validator (banned-phrase or schema). Skip silently
        # to keep daemon loop alive; operator audit via append_tools_governance.
        append_tools_governance(tools_dir, "aria_watchdog_emit_rejected", {
            "pattern": finding.pattern,
            "signature_hash": finding.pattern_signature_hash,
            "daemon_agent_id": daemon_agent_id,
        })
        return None
    _append_signature(
        tools_dir=tools_dir,
        pattern=finding.pattern,
        signature_hash=finding.pattern_signature_hash,
        finding_id=record["finding_id"],
        daemon_agent_id=daemon_agent_id,
        now=now,
    )
    append_tools_governance(tools_dir, "aria_watchdog_finding_emitted", {
        "pattern": finding.pattern,
        "signature_hash": finding.pattern_signature_hash,
        "finding_id": record["finding_id"],
        "daemon_agent_id": daemon_agent_id,
    })
    return record


def run_aria_watchdog_daemon(
    *,
    workspace_root: str | Path,
    tools_dir: str | Path,
    max_iterations: int | None = None,
    poll_interval_seconds: float = DEFAULT_WATCHDOG_POLL_INTERVAL_SECONDS,
    daemon_id: str = DEFAULT_WATCHDOG_DAEMON_ID,
    interrupt_event: threading.Event | None = None,
    aria_stop_filename: str = "ARIA_STOP",
    now_provider: Callable[[], datetime] | None = None,
) -> dict[str, Any]:
    """Run the ARIA-Watchdog daemon loop.

    Returns termination dict: {exits_clean, exit_reason, iterations, findings_emitted, findings_suppressed}.

    Termination causes:
    - aria_stop_filename present in tools_dir → exits_clean=True, reason=aria_stop
    - max_iterations reached → exits_clean=True, reason=max_iterations
    - second instance detected via fcntl lock → exits_clean=False, reason=daemon_already_running
    - SIGTERM via interrupt_event → exits_clean=True, reason=interrupted
    """
    workspace_path = Path(workspace_root).resolve()
    tools_path = Path(tools_dir).resolve()
    tools_path.mkdir(parents=True, exist_ok=True)
    daemons_dir = tools_path / "daemons"
    daemons_dir.mkdir(parents=True, exist_ok=True)
    pid_lock_path = daemons_dir / f"{daemon_id}.pid.lock"

    if interrupt_event is None:
        interrupt_event = threading.Event()

    # Register SIGTERM handler that flips the interrupt event.
    original_sigterm_handler = signal.getsignal(signal.SIGTERM) if hasattr(signal, "SIGTERM") else None
    def _sigterm_handler(signum, frame):  # noqa: ARG001
        interrupt_event.set()
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _sigterm_handler)

    daemon_agent_id = f"{daemon_id}:{os.getpid()}"

    # Write daemon PID to a side-car file (NOT the fcntl lock body — that
    # is managed by the OS). The PID file lets operator run rollback recipe
    # `pkill -f 'scheduler watchdog run'` OR `kill $(cat pid)`.
    pid_info_path = daemons_dir / f"{daemon_id}.pid"
    try:
        pid_info_path.write_text(f"{os.getpid()}\n", encoding="utf-8")
    except OSError:
        pass

    try:
        with with_exclusive_lock(pid_lock_path, timeout_seconds=2.0):
            return _run_daemon_loop(
                workspace_path=workspace_path,
                tools_path=tools_path,
                daemon_id=daemon_id,
                daemon_agent_id=daemon_agent_id,
                max_iterations=max_iterations,
                poll_interval_seconds=poll_interval_seconds,
                interrupt_event=interrupt_event,
                aria_stop_filename=aria_stop_filename,
                now_provider=now_provider or (lambda: datetime.now(timezone.utc)),
            )
    except TimeoutError:
        # Second instance detected — clean refusal.
        return {
            "exits_clean": False,
            "exit_reason": "daemon_already_running",
            "iterations": 0,
            "findings_emitted": 0,
            "findings_suppressed": 0,
        }
    finally:
        if hasattr(signal, "SIGTERM") and original_sigterm_handler is not None:
            try:
                signal.signal(signal.SIGTERM, original_sigterm_handler)
            except (OSError, ValueError):
                pass


def _held(hold: SourceHold, *, missing_families: list[str] | None = None) -> dict[str, Any]:
    """The sweep's ``runtime`` account of a feed it did not read: the named hold,
    its detail and — when the source answered — the families it held no series for."""
    runtime: dict[str, Any] = {"hold": hold.name, "detail": hold.detail}
    if missing_families is not None:
        runtime["missing_families"] = missing_families
    return runtime


def _ingest_runtime_lead(
    anomaly: RuntimeAnomaly, *, tools_dir: Path, now: datetime,
) -> tuple[str, dict[str, Any]]:
    """Raise one runtime anomaly as a telemetry lead.

    Returns ``("leads", {signal_id, pattern, facts})``, or — when the
    bridge's door refuses it (a code ref or text that breaks the bridge
    law) — ``("refused_leads", {pattern, service, refused})``, so the sweep
    payload names it.
    """
    from .runtime_signal_bridge import ingest_runtime_signal

    try:
        record = ingest_runtime_signal(
            source="telemetry",
            service=anomaly.service,
            summary=anomaly.claim_summary,
            code_refs=list(anomaly.code_refs),
            severity=anomaly.severity,
            base_dir=tools_dir,
            now=now,
        )
    except GovernanceError as exc:
        return "refused_leads", {"pattern": anomaly.pattern, "service": anomaly.service[:128], "refused": str(exc)[:200]}
    return "leads", {"signal_id": record["signal_id"], "pattern": anomaly.pattern, "facts": list(anomaly.facts)}


def run_watchdog_sweep(
    *,
    workspace_root: str | Path,
    tools_dir: str | Path,
    now: datetime | None = None,
    since: datetime | None = None,
    daemon_agent_id: str = "aria-watchdog-cycle-phase",
    interrupt_event: threading.Event | None = None,
    suppress_emission: bool = False,
) -> dict[str, Any]:
    """M13/E12-c (ORPHAN-677) — ONE detector sweep, shared by both hosts.

    The detectors existed as pure functions and the daemon loop was the
    only body that loaded rows and emitted findings — and NOTHING ran
    the daemon in production, so both watchdogs were disconnected eyes.
    This extraction is the single sweep unit: the daemon loop calls it
    per iteration (unchanged behaviour) and the nightly cycle calls it
    once per cycle as a CyclePhase — one implementation, two hosts (İ1).
    """
    tools_path = Path(tools_dir).resolve()
    workspace_path = Path(workspace_root).resolve()
    now = now or datetime.now(timezone.utc)
    since = since if since is not None else (now - timedelta(hours=24))
    governance_rows = _load_jsonl(tools_path / "governance.jsonl", since_ts=since)
    autonomy_rows = _load_jsonl(tools_path / "autonomy_state.jsonl")
    latest_governance_ts = max(
        (_parse_iso(r.get("ts") or r.get("occurred_at")) for r in governance_rows),
        default=None,
    ) if governance_rows else None

    candidates: list[WatchdogFinding] = []
    from .provider_clock import provider_clock

    candidates.extend(detect_stall(governance_rows, autonomy_rows, now=now, clock=provider_clock(tools_path)))
    candidates.extend(detect_repeated_bridge_warning(governance_rows, now=now))

    # RW-1 — production telemetry joins the same sweep through the ONE
    # puller (a loopback, credential-free read of each runtime family's
    # increase over the policy window from the Prometheus query API). A
    # source the sweep cannot read is a NAMED hold in the payload
    # (RUNTIME_SOURCE_HOLDS), which the cycle digest and the report carry:
    # never silence, never a dead night.
    from .genesis_policy import watchdog_pull_policy

    pull_policy = watchdog_pull_policy(workspace_path)
    runtime: dict[str, Any]
    anomalies: list[RuntimeAnomaly] = []
    if not pull_policy["enabled"]:
        runtime = _held(SourceHold("source_disabled", "watchdog_pull.enabled is false"))
    else:
        window_seconds = pull_policy["window_seconds"]
        samples, hold = pull_observability_metrics(
            base_url=pull_policy["observability_base_url"], window_seconds=window_seconds,
        )
        if hold is not None:
            runtime = _held(hold)
        else:
            present = {name for name, _, _ in samples}
            missing = [family for family in RUNTIME_METRIC_FAMILIES if family not in present]
            if len(missing) == len(RUNTIME_METRIC_FAMILIES):
                # Well-formed answers with no runtime series are not a
                # healthy night (a quiet window still answers a series per
                # target, at 0): the scope's labels drifted or every target
                # is down — named, never read as clean.
                runtime = _held(
                    SourceHold("source_empty", f"no series of {', '.join(missing)} in the window"),
                    missing_families=missing,
                )
            else:
                anomalies = detect_http_5xx_share(
                    samples,
                    threshold=float(pull_policy["http_5xx_share_threshold"]),
                    min_requests=int(pull_policy["http_min_requests"]),
                    window_seconds=window_seconds,
                )
                anomalies.extend(detect_security_critical_events(samples, window_seconds=window_seconds))
                runtime = {
                    "window_seconds": window_seconds,
                    "samples": len(samples),
                    "missing_families": missing,
                    # RW-1 corrective R6 — series no detector can attribute
                    # (no RUNTIME_SERVICE_LABEL: the target lost its `app`
                    # label), counted and carried to the digest and the
                    # report instead of dropped.
                    "unattributed_series": sum(
                        1 for _, labels, _ in samples if not labels.get(RUNTIME_SERVICE_LABEL)
                    ),
                    "candidates": len(anomalies),
                    "leads": [],
                    "refused_leads": [],
                }

    interrupt = interrupt_event or threading.Event()
    emitted = 0
    suppressed = 0
    if not suppress_emission:
        for candidate in candidates:
            record = _emit_watchdog_finding(
                finding=candidate,
                tools_dir=tools_path,
                repo_root=workspace_path,
                daemon_agent_id=daemon_agent_id,
                interrupt_event=interrupt,
                now=now,
            )
            if record is not None:
                emitted += 1
            else:
                suppressed += 1
        # A runtime anomaly is an UNVERIFIED lead on the runtime-signal
        # claim path, never a finding the watchdog mints: repo evidence and
        # a red reproduction (finding.record_finding_reproduction) decide
        # what is true about it.
        for anomaly in anomalies:
            if interrupt.is_set():
                break
            outcome_key, outcome = _ingest_runtime_lead(anomaly, tools_dir=tools_path, now=now)
            runtime[outcome_key].append(outcome)
    return {
        "candidates": len(candidates) + len(anomalies),
        "emitted": emitted,
        "suppressed": suppressed,
        # E24-b: ISO string, not a datetime. Every consumer of this dict either
        # json.dumps it (cli.py prints the cycle result) or parses it back with
        # _parse_iso; a raw datetime made the first of those raise
        # "Object of type datetime is not JSON serializable" AFTER the ledgers
        # had been written, so the sweep's work landed and its report did not.
        # The kernel's own fixtures already spell this value as a string.
        "latest_governance_ts": (
            latest_governance_ts.isoformat() if latest_governance_ts is not None else None
        ),
        # RW-1 — the runtime feed's account: its named hold, or what was
        # read and which leads it raised (the X3 digest keys above count
        # the ledger detectors' findings).
        "runtime": runtime,
    }


def _run_daemon_loop(
    *,
    workspace_path: Path,
    tools_path: Path,
    daemon_id: str,
    daemon_agent_id: str,
    max_iterations: int | None,
    poll_interval_seconds: float,
    interrupt_event: threading.Event,
    aria_stop_filename: str,
    now_provider: Callable[[], datetime],
) -> dict[str, Any]:
    """Inner loop body — runs under fcntl lock from run_aria_watchdog_daemon."""
    iteration_count = 0
    findings_emitted = 0
    findings_suppressed = 0
    aria_stop_path = tools_path / aria_stop_filename

    append_tools_governance(tools_path, "aria_watchdog_daemon_started", {
        "daemon_id": daemon_id,
        "daemon_agent_id": daemon_agent_id,
        "poll_interval_seconds": poll_interval_seconds,
        "max_iterations": max_iterations,
    })

    last_governance_ts: datetime | None = None

    try:
        while True:
            if interrupt_event.is_set():
                exit_reason = "interrupted"
                break
            if aria_stop_path.exists():
                exit_reason = "aria_stop"
                break
            if max_iterations is not None and iteration_count >= max_iterations:
                exit_reason = "max_iterations"
                break

            iteration_count += 1
            now = now_provider()
            append_tools_governance(tools_path, "aria_watchdog_iteration_started", {
                "daemon_agent_id": daemon_agent_id,
                "iteration": iteration_count,
            })

            # Bounded read — last 24h on first iteration, since_ts after.
            since = last_governance_ts if last_governance_ts is not None else (now - timedelta(hours=24))
            sweep = run_watchdog_sweep(
                workspace_root=workspace_path,
                tools_dir=tools_path,
                now=now,
                since=since,
                daemon_agent_id=daemon_agent_id,
                interrupt_event=interrupt_event,
                suppress_emission=aria_stop_path.exists() or interrupt_event.is_set(),
            )
            # The sweep reports an ISO string; the loop needs the instant.
            swept_ts = _parse_iso(sweep["latest_governance_ts"])
            if swept_ts is not None:
                last_governance_ts = swept_ts
            findings_emitted += sweep["emitted"]
            findings_suppressed += sweep["suppressed"]

            # Sleep (SIGTERM-aware)
            if interrupt_event.wait(timeout=poll_interval_seconds):
                exit_reason = "interrupted"
                break
        else:
            exit_reason = "max_iterations"
    finally:
        append_tools_governance(tools_path, "aria_watchdog_daemon_exit", {
            "daemon_id": daemon_id,
            "daemon_agent_id": daemon_agent_id,
            "exit_reason": exit_reason if "exit_reason" in dir() else "unknown",
            "iterations": iteration_count,
            "findings_emitted": findings_emitted,
            "findings_suppressed": findings_suppressed,
        })

    return {
        "exits_clean": exit_reason in ("aria_stop", "max_iterations", "interrupted"),
        "exit_reason": exit_reason,
        "iterations": iteration_count,
        "findings_emitted": findings_emitted,
        "findings_suppressed": findings_suppressed,
    }
