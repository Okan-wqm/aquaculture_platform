"""Plan 032 Faz 032a — ``aria-kernel doctor``: one readout of ARIA's own health.

WHY: every fact below already existed behind its own verb (`integrity
verify`, `runtime verify-artifacts`, `breaker status`, `cost-breaker status`,
`autonomy status`, the habitat probe, the funnel detector) and nothing put
them side by side. On 2026-09-02 the operator learned that the nightly had
been dying on one oversized ledger row, that the plan ledger was missing from
the store, and that the executor's queue was all age-expired, by reading
three workflow logs and two ledgers by hand. A doctor is the report that
would have said so in one screen.

WHAT IT IS NOT: it decides nothing and writes nothing. Each check is a
pure read that returns ``ok`` | ``warn`` | ``fail`` with a reason; the exit
code is derived (0 healthy, 3 at least one ``fail``) the way the runtime
supervisor already reports (SuccessExitStatus=0 3). A check that cannot run
reports ``warn`` with the exception NAME, never a stack — an unreadable
organ is a finding, not a crash.
"""
from __future__ import annotations

import shutil
import subprocess
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable

from .tool_registry import ensure_tools_dir_readonly

# The floor both live lanes' preflight steps enforce (aria-auto-cycle.yml /
# aria-agent-executor.yml `REQUIRED_CLAUDE_VERSION`) and provision_runner.sh
# names as CLAUDE_FLOOR. Pinned here so the doctor and the lanes cannot drift;
# tests/test_doctor.py compares the three literals.
CLAUDE_CLI_VERSION_FLOOR = "2.1.221"

CHECK_STATUSES: tuple[str, ...] = ("ok", "warn", "fail")
DOCTOR_EXIT_HEALTHY = 0
DOCTOR_EXIT_UNHEALTHY = 3


@dataclass(frozen=True)
class DoctorCheck:
    name: str
    status: str
    reason: str = ""
    detail: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class DoctorReport:
    checks: tuple[DoctorCheck, ...]
    tools_dir: str
    workspace_root: str

    @property
    def healthy(self) -> bool:
        return all(check.status != "fail" for check in self.checks)

    @property
    def exit_code(self) -> int:
        return DOCTOR_EXIT_HEALTHY if self.healthy else DOCTOR_EXIT_UNHEALTHY

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "healthy": self.healthy,
            "exit_code": self.exit_code,
            "tools_dir": self.tools_dir,
            "workspace_root": self.workspace_root,
            "summary": {
                status: sum(1 for check in self.checks if check.status == status)
                for status in CHECK_STATUSES
            },
            "checks": [asdict(check) for check in self.checks],
        }


def _version_tuple(text: str) -> tuple[int, ...]:
    digits: list[int] = []
    for part in text.strip().split(".")[:3]:
        number = ""
        for char in part:
            if not char.isdigit():
                break
            number += char
        if not number:
            break
        digits.append(int(number))
    return tuple(digits)


def _guarded(name: str, probe: Callable[[], DoctorCheck]) -> DoctorCheck:
    """A check that raises is a WARN naming the exception — the doctor must
    finish every organ; one unreadable organ must not hide the rest."""
    try:
        return probe()
    except Exception as exc:  # noqa: BLE001 — the doctor reports, it does not crash
        return DoctorCheck(name, "warn", f"check_unreadable:{type(exc).__name__}")


def _check_integrity(tools_dir: Path, workspace_root: Path) -> DoctorCheck:
    from .integrity import verify_integrity

    result = verify_integrity(base_dir=tools_dir, workspace_root=workspace_root)
    issues = list(result.get("issues") or [])
    tools_issues = list((result.get("tools") or {}).get("issues") or [])
    total = len(issues) + len(tools_issues)
    if result.get("valid") is True:
        return DoctorCheck("integrity", "ok", detail={"ledger_count": result.get("ledger_count")})
    return DoctorCheck(
        "integrity", "fail", f"integrity_drift:{total}_issues",
        detail={"status": result.get("status"), "issue_count": total},
    )


def _check_runtime_artifacts(tools_dir: Path, workspace_root: Path) -> DoctorCheck:
    from .runtime_artifacts import verify_runtime_artifacts

    result = verify_runtime_artifacts(base_dir=tools_dir, workspace_root=workspace_root)
    if result.get("valid") is True:
        return DoctorCheck("runtime_artifacts", "ok", detail={"verified": result.get("verified_count")})
    return DoctorCheck(
        "runtime_artifacts", "fail", "runtime_artifacts_invalid",
        detail={"issue_count": len(result.get("issues") or [])},
    )


def _check_breakers(tools_dir: Path) -> DoctorCheck:
    from .circuit_breaker import current_state as failure_state
    from .cost_budget import current_state as cost_state

    failure = failure_state(tools_dir)
    cost = cost_state(tools_dir)
    detail = {"failure_breaker": failure, "cost_breaker": cost}
    if failure == "tripped" or cost == "tripped":
        tripped = [name for name, state in detail.items() if state == "tripped"]
        return DoctorCheck("breakers", "fail", "breaker_tripped:" + ",".join(tripped), detail)
    return DoctorCheck("breakers", "ok", detail=detail)


def _check_host_lease(tools_dir: Path) -> DoctorCheck:
    from .autonomous_host_lease import lease_state, remote_cas_lease_state

    local = lease_state(tools_dir)
    remote = remote_cas_lease_state(tools_dir)
    detail = {"local": local, "remote_cas": remote}
    # A fresh lease held by another host is exactly what the lanes refuse
    # on; it is information for the operator, not ill health of this store.
    return DoctorCheck("host_lease", "ok", detail=detail)


def _check_providers() -> DoctorCheck:
    from .model_fleet import available_providers

    providers = [provider.key for provider in available_providers()]
    if not providers:
        return DoctorCheck("providers", "fail", "no_provider_available", {"providers": []})
    status = "ok" if len(providers) >= 2 else "warn"
    reason = "" if status == "ok" else "single_provider_no_striping"
    return DoctorCheck("providers", status, reason, {"providers": providers})


def _check_sandbox() -> DoctorCheck:
    from .implementation_safety import sandbox_backend

    backend = sandbox_backend()
    if backend:
        return DoctorCheck("sandbox_backend", "ok", detail={"backend": backend})
    return DoctorCheck(
        "sandbox_backend", "fail", "no_sandbox_backend_write_capable_spawns_refused",
    )


def _check_claude_cli(*, floor: str = CLAUDE_CLI_VERSION_FLOOR) -> DoctorCheck:
    binary = shutil.which("claude")
    if binary is None:
        return DoctorCheck("claude_cli", "fail", "claude_binary_missing", {"floor": floor})
    proc = subprocess.run(
        [binary, "--version"], capture_output=True, text=True, timeout=20, check=False,
    )
    raw = (proc.stdout or proc.stderr or "").strip()
    token = raw.split()[0] if raw else ""
    version = _version_tuple(token)
    detail = {"binary": binary, "reported": raw[:80], "floor": floor}
    if proc.returncode != 0 or not version:
        return DoctorCheck("claude_cli", "warn", "claude_version_unreadable", detail)
    if version < _version_tuple(floor):
        return DoctorCheck("claude_cli", "fail", f"claude_below_floor:{token}<{floor}", detail)
    return DoctorCheck("claude_cli", "ok", detail=detail)


def _check_habitat(workspace_root: Path) -> DoctorCheck:
    from .habitat import HABITAT_DEGRADED_FREE_GB, probe_habitat

    facts = probe_habitat(workspace_root=workspace_root)
    if facts.get("degraded"):
        return DoctorCheck(
            "habitat", "warn",
            f"free_disk_below_{HABITAT_DEGRADED_FREE_GB:g}gb", facts,
        )
    return DoctorCheck("habitat", "ok", detail=facts)


def _check_funnel(workspace_root: Path) -> DoctorCheck:
    from .funnel_health import detect_funnel_stalls
    from .knowledge_graph import rank_pressure_sources

    rows = rank_pressure_sources(workspace_root=workspace_root)
    stalls = detect_funnel_stalls(rows)
    if stalls:
        return DoctorCheck(
            "funnel", "warn", f"funnel_stalled:{len(stalls)}",
            {"stalls": [asdict(stall) for stall in stalls]},
        )
    return DoctorCheck("funnel", "ok", detail={"sources": len(rows)})


def _check_plan_ledger(tools_dir: Path) -> DoctorCheck:
    """The mechanism-2 finding of 2026-09-02: requests existed, the plan
    ledger did not, and the drainer re-started the same plan every night.
    A write-driving ledger that vanished while its producers kept writing
    is a FAIL, not a bootstrap."""
    requests = tools_dir / "agent-invocations" / "requests.jsonl"
    plans_dir = tools_dir / "plans"
    plan_ledgers = sorted(plans_dir.glob("*.jsonl")) if plans_dir.is_dir() else []
    detail = {
        "requests_ledger_present": requests.is_file(),
        "plan_ledgers": [path.name for path in plan_ledgers],
    }
    if requests.is_file() and requests.stat().st_size > 0 and not plan_ledgers:
        return DoctorCheck("plan_ledger", "fail", "plan_ledger_missing_with_live_requests", detail)
    return DoctorCheck("plan_ledger", "ok", detail=detail)


def _check_delivery(tools_dir: Path) -> DoctorCheck:
    """Plan 032 Faz 032d — the last mile has a reader. Duplicate PRs are a
    fault (fail); an accepted result with no PR is a false success (warn —
    the request may still be mid-flight); the SLO itself is detail."""
    from .delivery_closure import compute_delivery_closure

    summary = compute_delivery_closure(base_dir=tools_dir).summary
    if summary["duplicate_prs"]:
        return DoctorCheck("delivery_closure", "fail", "duplicate_prs", summary)
    if summary["false_success"] or summary["unresolved_intents"]:
        return DoctorCheck("delivery_closure", "warn", "false_success_or_unresolved_intents", summary)
    if not summary["implementation_requests"]:
        return DoctorCheck("delivery_closure", "ok", "no_implementation_requests", summary)
    return DoctorCheck("delivery_closure", "ok", "", summary)


def _check_queue(tools_dir: Path) -> DoctorCheck:
    """Plan 032 Faz 032e — queue depth by derived state + open HUMAN_REQUIRED."""
    from collections import Counter

    from .agent_invocations import derive_request_states
    from .human_required import list_human_required
    from .mission import list_open_missions

    states = Counter(derive_request_states(base_dir=tools_dir).values())
    open_hr = list_human_required(base_dir=tools_dir)
    missions = Counter(str(m.get("state") or "") for m in list_open_missions(base_dir=tools_dir))
    detail = {"requests_by_state": dict(sorted(states.items())), "human_required_open": len(open_hr),
              "missions_open_by_state": dict(sorted(missions.items()))}
    if open_hr:
        return DoctorCheck("queue", "warn", f"human_required_open:{len(open_hr)}", detail)
    return DoctorCheck("queue", "ok", "", detail)


def _check_control(tools_dir: Path) -> DoctorCheck:
    """Plan 032 Faz 032e — an operator pause is health information, not illness."""
    from .control import effective_control

    state = effective_control(tools_dir)
    if state.paused_all:
        return DoctorCheck("control", "warn", "executor_paused", state.to_dict())
    return DoctorCheck("control", "ok", "", state.to_dict())


def _check_notifications(tools_dir: Path) -> DoctorCheck:
    """Plan 032 Faz 032e — a channel that keeps failing means nobody hears."""
    from .notify import configured_channels, read_outbox

    rows = read_outbox(tools_dir)
    recent = rows[-50:]
    failed = [r for r in recent if r.get("status") == "failed"]
    detail = {"configured_channels": list(configured_channels()), "recent_rows": len(recent), "recent_failed": len(failed)}
    if failed:
        return DoctorCheck("notifications", "warn", f"recent_failures:{len(failed)}", detail)
    return DoctorCheck("notifications", "ok", "" if detail["configured_channels"] else "no_channel_configured", detail)


def _check_gateway(tools_dir: Path, *, stale_after_seconds: float = 300.0) -> DoctorCheck:
    """Plan 032 Faz 032f — the droplet daemon's heartbeat. Absent = not
    deployed on this host (ok, informational); stale = it died quietly."""
    import json
    from datetime import datetime, timezone

    from .gateway.inbox import inbox_summary
    from .gateway.server import HEARTBEAT_RELPATH

    path = tools_dir.joinpath(*HEARTBEAT_RELPATH)
    inbox = inbox_summary(tools_dir)
    if not path.exists():
        return DoctorCheck("gateway", "ok", "gateway_not_running_here", {"inbox": inbox})
    try:
        beat = json.loads(path.read_text(encoding="utf-8"))
        stamp = datetime.fromisoformat(str(beat.get("recorded_at")).replace("Z", "+00:00"))
    except (OSError, ValueError):
        return DoctorCheck("gateway", "warn", "heartbeat_unreadable", {"inbox": inbox})
    age = (datetime.now(timezone.utc) - stamp).total_seconds()
    detail = {"heartbeat_age_seconds": int(age), "inbox": inbox, "last_ran": beat.get("ran")}
    if age > stale_after_seconds:
        return DoctorCheck("gateway", "warn", "gateway_heartbeat_stale", detail)
    if inbox["pending"] > 50:
        return DoctorCheck("gateway", "warn", f"inbox_backlog:{inbox['pending']}", detail)
    return DoctorCheck("gateway", "ok", "", detail)


def _check_economy(tools_dir: Path) -> DoctorCheck:
    """Plan 032 Faz 032i — a standing effort downgrade is information; no accepted
    result across a busy agent is a warning."""
    from .token_economy import read_recommendations, usage_per_accepted_result

    stats = usage_per_accepted_result(base_dir=tools_dir)
    downgrades = [f"{r['target_agent']}/{r['role']}" for r in read_recommendations(tools_dir) if r.get("kind") == "effort" and r.get("action") == "downgrade"]
    starved = [f"{s.target_agent}/{s.role}" for s in stats if s.spawns >= 5 and s.accepted == 0]
    detail = {"stats": [s.to_dict() for s in stats][:20], "downgrades": downgrades[-5:], "starved": starved}
    if starved:
        return DoctorCheck("economy", "warn", f"spawns_without_accepted_result:{len(starved)}", detail)
    return DoctorCheck("economy", "ok", "" if stats else "no_usage_rows", detail)


def run_doctor(
    *,
    base_dir: str | Path | None = None,
    workspace_root: str | Path | None = None,
    claude_version_floor: str = CLAUDE_CLI_VERSION_FLOOR,
) -> DoctorReport:
    """Run every organ probe and return the report. Read-only by construction:
    every probe is a reader, and the tools root is resolved read-only — an
    unbound root is itself a finding, never a directory the doctor creates."""
    tools_dir = ensure_tools_dir_readonly(base_dir)
    workspace = Path(workspace_root).resolve() if workspace_root else Path.cwd().resolve()
    host_checks = (
        _guarded("providers", _check_providers),
        _guarded("sandbox_backend", _check_sandbox),
        _guarded("claude_cli", lambda: _check_claude_cli(floor=claude_version_floor)),
        _guarded("habitat", lambda: _check_habitat(workspace)),
        _guarded("funnel", lambda: _check_funnel(workspace)),
    )
    if tools_dir is None:
        checks = (
            DoctorCheck(
                "tools_root", "fail", "tools_root_unbound",
                {"base_dir": str(base_dir) if base_dir else None},
            ),
            *host_checks,
        )
        return DoctorReport(checks=checks, tools_dir="", workspace_root=str(workspace))
    store_checks = (
        _guarded("integrity", lambda: _check_integrity(tools_dir, workspace)),
        _guarded("runtime_artifacts", lambda: _check_runtime_artifacts(tools_dir, workspace)),
        _guarded("breakers", lambda: _check_breakers(tools_dir)),
        _guarded("host_lease", lambda: _check_host_lease(tools_dir)),
        _guarded("plan_ledger", lambda: _check_plan_ledger(tools_dir)),
        _guarded("delivery_closure", lambda: _check_delivery(tools_dir)),
        _guarded("queue", lambda: _check_queue(tools_dir)),
        _guarded("control", lambda: _check_control(tools_dir)),
        _guarded("notifications", lambda: _check_notifications(tools_dir)),
        _guarded("gateway", lambda: _check_gateway(tools_dir)),
        _guarded("economy", lambda: _check_economy(tools_dir)),
    )
    return DoctorReport(
        checks=(*store_checks, *host_checks),
        tools_dir=str(tools_dir),
        workspace_root=str(workspace),
    )


def render_doctor_text(report: DoctorReport) -> str:
    marks = {"ok": "ok  ", "warn": "WARN", "fail": "FAIL"}
    lines = [f"aria doctor — {'healthy' if report.healthy else 'UNHEALTHY'} (exit {report.exit_code})"]
    for check in report.checks:
        suffix = f" — {check.reason}" if check.reason else ""
        lines.append(f"  [{marks[check.status]}] {check.name}{suffix}")
    return "\n".join(lines)


__all__ = [
    "CLAUDE_CLI_VERSION_FLOOR",
    "DOCTOR_EXIT_HEALTHY",
    "DOCTOR_EXIT_UNHEALTHY",
    "DoctorCheck",
    "DoctorReport",
    "render_doctor_text",
    "run_doctor",
]
