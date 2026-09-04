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
import json
import os
import signal
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from .file_lock import with_exclusive_lock
from .strict_jsonl_reader import read_strict_jsonl
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_binding


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


def pull_observability_metrics(
    *,
    base_url: str,
    api_key: str | None,
    timeout_seconds: int = 5,
) -> tuple[str | None, str | None]:
    """E24-a (ORPHAN-711) — one GET against the observability /metrics feed.

    Returns (text, None) on success, (None, reason) on any failure. Stdlib
    only, bounded timeout: the sweep runs inside the nightly cycle and an
    unreachable endpoint must cost one disclosure line, never the night
    (on_error is already record_and_continue at the phase).
    """
    import urllib.error
    import urllib.request

    request = urllib.request.Request(base_url.rstrip("/") + "/metrics")
    if api_key:
        request.add_header("x-internal-api-key", api_key)
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            if response.status != 200:
                return None, f"http_{response.status}"
            return response.read().decode("utf-8", errors="replace"), None
    except urllib.error.HTTPError as exc:
        return None, f"http_{exc.code}"
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return None, f"unreachable:{str(exc)[:120]}"


def parse_prometheus_text(text: str) -> list[tuple[str, dict[str, str], float]]:
    """Minimal prometheus exposition parser: (name, labels, value) samples.

    Deliberately narrow — counters and gauges with simple label sets are
    all the detectors below read. Unparseable lines are skipped, never
    fatal: telemetry is evidence, not a contract surface.
    """
    samples: list[tuple[str, dict[str, str], float]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            metric_part, value_part = line.rsplit(" ", 1)
            value = float(value_part)
        except ValueError:
            continue
        labels: dict[str, str] = {}
        name = metric_part
        if "{" in metric_part and metric_part.endswith("}"):
            name, raw_labels = metric_part.split("{", 1)
            for pair in raw_labels[:-1].split(","):
                if "=" not in pair:
                    continue
                key, raw_value = pair.split("=", 1)
                labels[key.strip()] = raw_value.strip().strip('"')
        samples.append((name, labels, value))
    return samples


def detect_http_5xx_share(
    samples: list[tuple[str, dict[str, str], float]],
    *,
    threshold: float,
    min_requests: int,
) -> list[WatchdogFinding]:
    """A 5xx share above threshold on a meaningful request volume."""
    total = 0.0
    errors_by_service: dict[str, float] = {}
    total_by_service: dict[str, float] = {}
    for name, labels, value in samples:
        if name != "http_requests_total":
            continue
        service = labels.get("service") or labels.get("job") or "observability-service"
        total += value
        total_by_service[service] = total_by_service.get(service, 0.0) + value
        status = str(labels.get("status_code") or labels.get("status") or "")
        if status.startswith("5"):
            errors_by_service[service] = errors_by_service.get(service, 0.0) + value
    findings: list[WatchdogFinding] = []
    for service, errors in sorted(errors_by_service.items()):
        service_total = total_by_service.get(service, 0.0)
        if service_total < min_requests:
            continue
        share = errors / service_total if service_total else 0.0
        if share < threshold:
            continue
        findings.append(WatchdogFinding(
            pattern="runtime_http_5xx",
            severity="MEDIUM",
            claim_summary=(
                f"Production service {service} is answering "
                f"{share:.1%} of requests with 5xx "
                f"({int(errors)}/{int(service_total)})."
            ),
            facts=[
                f"http_requests_total 5xx={int(errors)} total={int(service_total)}",
                f"threshold={threshold:.0%} min_requests={min_requests}",
            ],
            evidences=[{
                "ref": "observability-service:/metrics",
                "summary": f"http_requests_total{{service={service}}} 5xx share {share:.1%}",
            }],
            scope_files=[],
            pattern_signature_hash=_signature_hash("runtime_http_5xx", service),
            originating_skill="aria-watchdog:runtime_anomaly",
        ))
    return findings


def detect_security_critical_events(
    samples: list[tuple[str, dict[str, str], float]],
) -> list[WatchdogFinding]:
    """Any critical-severity security event counter above zero."""
    findings: list[WatchdogFinding] = []
    for name, labels, value in samples:
        if name != "security_events_total" or value <= 0:
            continue
        severity = str(labels.get("severity") or "").lower()
        if severity != "critical":
            continue
        event_type = labels.get("type") or labels.get("event_type") or "unknown"
        findings.append(WatchdogFinding(
            pattern="runtime_security_critical",
            severity="MEDIUM",
            claim_summary=(
                f"Production security telemetry reports {int(value)} "
                f"critical-severity event(s) of type {event_type}."
            ),
            facts=[f"security_events_total{{severity=critical,type={event_type}}}={int(value)}"],
            evidences=[{
                "ref": "observability-service:/metrics",
                "summary": f"security_events_total critical {event_type}={int(value)}",
            }],
            scope_files=[],
            pattern_signature_hash=_signature_hash("runtime_security_critical", event_type),
            originating_skill="aria-watchdog:runtime_anomaly",
        ))
    return findings


def detect_stall(
    governance_rows: list[dict[str, Any]],
    autonomy_rows: list[dict[str, Any]],
    *,
    now: datetime,
    threshold_seconds: int = STALL_THRESHOLD_SECONDS,
    skip_states: tuple[str, ...] = ("HUMAN_REQUIRED", "EXTERNAL_OUTAGE", "CONVERGED", "ABANDONED_BY_OPERATOR"),
    api_backoff_grace_seconds: int = 600,
) -> list[WatchdogFinding]:
    """Detect plan_ids with no state-machine event for >threshold_seconds.

    SKIPs:
    - Cycles in legitimate terminal states (HUMAN_REQUIRED, EXTERNAL_OUTAGE,
      CONVERGED) — these are not stalls (AISAFETY-HIGH-010 fix).
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

    for plan_id, last_event in plan_last_event.items():
        if plan_id in seen_plan_ids:
            continue
        seen_plan_ids.add(plan_id)
        last_ts = _parse_iso(last_event.get("ts") or last_event.get("occurred_at"))
        if last_ts is None:
            continue
        age = now - last_ts
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
    candidates.extend(detect_stall(governance_rows, autonomy_rows, now=now))
    candidates.extend(detect_repeated_bridge_warning(governance_rows, now=now))

    # E24-a (ORPHAN-711) — production telemetry joins the same sweep: pull
    # the observability /metrics feed and run the runtime detectors over
    # it. Every failure mode is a DISCLOSED skip in the payload
    # (disabled / source_unconfigured / source_unreachable), never a
    # silent absence and never a dead night.
    import os as _os

    from .genesis_policy import watchdog_pull_policy

    pull_policy = watchdog_pull_policy(workspace_path)
    runtime: dict[str, Any]
    if not pull_policy.get("enabled", True):
        runtime = {"skipped": "disabled"}
    elif not pull_policy.get("observability_base_url"):
        runtime = {"skipped": "source_unconfigured"}
    else:
        api_key = _os.environ.get(str(pull_policy.get("api_key_env") or ""))
        metrics_text, pull_error = pull_observability_metrics(
            base_url=str(pull_policy["observability_base_url"]),
            api_key=api_key,
        )
        if metrics_text is None:
            runtime = {"skipped": "source_unreachable", "error": pull_error}
        else:
            samples = parse_prometheus_text(metrics_text)
            runtime_candidates = detect_http_5xx_share(
                samples,
                threshold=float(pull_policy.get("http_5xx_share_threshold") or 0.05),
                min_requests=int(pull_policy.get("http_min_requests") or 50),
            )
            runtime_candidates.extend(detect_security_critical_events(samples))
            candidates.extend(runtime_candidates)
            runtime = {"samples": len(samples), "candidates": len(runtime_candidates)}

    emitted = 0
    suppressed = 0
    if not suppress_emission:
        for candidate in candidates:
            record = _emit_watchdog_finding(
                finding=candidate,
                tools_dir=tools_path,
                repo_root=workspace_path,
                daemon_agent_id=daemon_agent_id,
                interrupt_event=interrupt_event or threading.Event(),
                now=now,
            )
            if record is not None:
                emitted += 1
            else:
                suppressed += 1
    return {
        "candidates": len(candidates),
        "emitted": emitted,
        "suppressed": suppressed,
        # G-7 (new-aria CORE-DELTAS) — this dict is a JSON payload: the cycle
        # phase stores it in the cycle result that `cli.py` prints with
        # json.dumps, and a raw datetime here made every full `cycle run`
        # exit non-zero AFTER the ledgers were written. Every other ledger
        # timestamp is an ISO-8601 string; this one is too. The daemon loop
        # below parses it back with _parse_iso where it needs a datetime.
        "latest_governance_ts": (
            latest_governance_ts.isoformat() if latest_governance_ts is not None else None
        ),
        # E24-a — the runtime pull's honest account (additive; the X3
        # digest keys above are unchanged).
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
            if sweep["latest_governance_ts"] is not None:
                last_governance_ts = _parse_iso(sweep["latest_governance_ts"])
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
