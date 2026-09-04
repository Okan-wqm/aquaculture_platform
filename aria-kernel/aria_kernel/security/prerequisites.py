"""Plan 033 Faz 033a — the security lane's fail-closed prerequisite gate.

WHY: 033 builds on Plan 032's execution envelope, recovery, delivery closure,
gateway and ops. Trusting a commit NAME that "032 merged" is not proof — a
branch can be renamed, rebased or reverted. So before ANY security campaign is
provisioned, this gate verifies each required v12 capability is actually
importable AND exposes its key symbol. A missing capability is fail-closed:
the report is unhealthy (exit 3) and names exactly what is absent, rather than
letting a half-built kernel run attacks.

WHAT: `REQUIRED_CAPABILITIES` is a CLOSED list of (capability, module, symbol).
`run_prerequisites` imports each and checks the symbol; `PrerequisiteReport`
carries the per-capability result and a single healthy/exit-code verdict.
"""
from __future__ import annotations

import importlib
from dataclasses import asdict, dataclass, field
from typing import Any

EXIT_READY = 0
EXIT_NOT_READY = 3

# (capability, module, symbol). Closed — a new 033 dependency adds a row here.
REQUIRED_CAPABILITIES: tuple[tuple[str, str, str], ...] = (
    # Execution envelope (032b)
    ("runtime_profiles", "aria_kernel.runtime_profiles", "load_runtime_profiles"),
    ("built_spawn_env", "aria_kernel.agent_env", "build_agent_env"),
    ("command_policy", "aria_kernel.command_policy", "classify_command"),
    ("hooks", "aria_kernel.hooks", "run_hook"),
    ("release_reason", "aria_kernel.release_reason", "parse_release_reason"),
    # Checkpoint / session / recovery (032c)
    ("checkpoint", "aria_kernel.checkpoint", "take_checkpoint"),
    ("session_continuity", "aria_kernel.session_continuity", "decide_session"),
    ("recovery", "aria_kernel.recovery", "classify_recovery"),
    ("search", "aria_kernel.search", "rebuild_index"),
    # Delivery closure (032d)
    ("delivery_closure", "aria_kernel.delivery_closure", "compute_delivery_closure"),
    ("delivery_credentials", "aria_kernel.delivery_credentials", "issue_delivery_credentials"),
    # Ops: control / progress / notify / doctor / telemetry (032e)
    ("control", "aria_kernel.control", "effective_control"),
    ("progress", "aria_kernel.progress", "tail_progress"),
    ("notify", "aria_kernel.notify", "notify"),
    ("doctor", "aria_kernel.doctor", "run_doctor"),
    ("telemetry", "aria_kernel.telemetry", "collect_metrics"),
    # Gateway (032f)
    ("gateway_server", "aria_kernel.gateway.server", "build_server"),
    ("gateway_router", "aria_kernel.gateway.router", "route_event"),
    ("gateway_scheduler", "aria_kernel.gateway.scheduler", "tick"),
    # MCP (032g)
    ("mcp_client", "aria_kernel.mcp_client", "mcp_config_for_profile"),
    ("mcp_server", "aria_kernel.mcp_server", "AriaMcpServer"),
    # Self-improvement / decision memory / token economy (032i)
    ("context_compiler", "aria_kernel.context_compiler", "compile_context"),
    ("token_economy", "aria_kernel.token_economy", "effective_effort"),
    ("self_improvement", "aria_kernel.self_improvement", "propose_self_change"),
    # Authorities 033 binds onto (must exist, never re-implemented)
    ("merge_authority", "aria_kernel.merge_authority", "merge_pr_if_ready"),
    ("tool_lifecycle", "aria_kernel.tool_registry", "transition_tool"),
    ("mission", "aria_kernel.mission", "open_mission"),
    ("finding_reproduction", "aria_kernel.finding", "record_finding_reproduction"),
    # 033a's own addition — CRITICAL severity is present.
    ("finding_critical_severity", "aria_kernel.finding", "SEVERITY_RANK"),
)


@dataclass(frozen=True)
class CapabilityResult:
    capability: str
    module: str
    symbol: str
    present: bool
    detail: str = ""


@dataclass(frozen=True)
class PrerequisiteReport:
    results: tuple[CapabilityResult, ...]
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def ready(self) -> bool:
        return all(r.present for r in self.results) and not self.extra.get("failures")

    @property
    def exit_code(self) -> int:
        return EXIT_READY if self.ready else EXIT_NOT_READY

    @property
    def missing(self) -> list[str]:
        return [r.capability for r in self.results if not r.present]

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "ready": self.ready,
            "exit_code": self.exit_code,
            "checked": len(self.results),
            "missing": self.missing,
            "results": [asdict(r) for r in self.results],
            **({"extra": self.extra} if self.extra else {}),
        }


def _check_one(capability: str, module_name: str, symbol: str) -> CapabilityResult:
    try:
        module = importlib.import_module(module_name)
    except Exception as exc:  # noqa: BLE001 — an unimportable dependency is the finding
        return CapabilityResult(capability, module_name, symbol, False, f"import_failed:{type(exc).__name__}:{str(exc)[:160]}")
    if not hasattr(module, symbol):
        return CapabilityResult(capability, module_name, symbol, False, "symbol_absent")
    # A special-case content check: CRITICAL must actually be in the rank map.
    if capability == "finding_critical_severity":
        rank = getattr(module, symbol)
        if not (isinstance(rank, dict) and "CRITICAL" in rank):
            return CapabilityResult(capability, module_name, symbol, False, "critical_not_in_rank")
    return CapabilityResult(capability, module_name, symbol, True)


def run_prerequisites(
    *,
    capabilities: tuple[tuple[str, str, str], ...] | None = None,
) -> PrerequisiteReport:
    """Verify every required v12 capability is importable and exposes its symbol.

    Read-only by construction. `capabilities` override exists for tests to inject
    an absent capability and prove the gate fails closed.
    """
    checks = capabilities if capabilities is not None else REQUIRED_CAPABILITIES
    results = tuple(_check_one(cap, mod, sym) for cap, mod, sym in checks)
    return PrerequisiteReport(results=results)


def render_prerequisites_text(report: PrerequisiteReport) -> str:
    lines = [f"security prerequisites: {'READY' if report.ready else 'NOT READY'} "
             f"({sum(1 for r in report.results if r.present)}/{len(report.results)} capabilities)"]
    for result in report.results:
        if not result.present:
            lines.append(f"  MISSING {result.capability} ({result.module}.{result.symbol}): {result.detail}")
    if report.ready:
        lines.append("  all Plan 032 capabilities present — 033 security lane may run")
    return "\n".join(lines)


__all__ = [
    "EXIT_NOT_READY", "EXIT_READY", "REQUIRED_CAPABILITIES", "CapabilityResult",
    "PrerequisiteReport", "render_prerequisites_text", "run_prerequisites",
]
