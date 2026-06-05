"""Executable ARIA state/ledger surface manifest.

The manifest is the first implementation slice of the 2026-05-25 plan:
every ledger, runtime state file, index, and artifact surface that can
drive writes must be declared here before autonomous real mode can trust
it. Reducers can use this module to look up lock/index/strict-read
policy instead of duplicating path rules.
"""
from __future__ import annotations

from dataclasses import dataclass
from fnmatch import fnmatch
from pathlib import Path
from typing import Literal


StateClass = Literal["ledger", "index", "runtime_state", "artifact", "lock"]
DurabilityPolicy = Literal["append_fsync", "rewrite_fsync", "ephemeral"]


@dataclass(frozen=True)
class StateSurface:
    name: str
    path_pattern: str
    state_class: StateClass
    lock_group: str
    index_group: str | None
    strict_read: bool
    durability: DurabilityPolicy
    write_driving: bool


STATE_SURFACES: tuple[StateSurface, ...] = (
    StateSurface(
        name="agent_invocation_requests",
        path_pattern="agent-invocations/requests.jsonl",
        state_class="ledger",
        lock_group="agent_invocations",
        index_group="agent_invocations",
        strict_read=True,
        durability="append_fsync",
        write_driving=True,
    ),
    StateSurface(
        name="agent_invocation_claims",
        path_pattern="agent-invocations/claims.jsonl",
        state_class="ledger",
        lock_group="agent_invocations",
        index_group="agent_invocations",
        strict_read=True,
        durability="append_fsync",
        write_driving=True,
    ),
    StateSurface(
        name="agent_invocation_results",
        path_pattern="agent-invocations/results.jsonl",
        state_class="ledger",
        lock_group="agent_invocations",
        index_group="agent_invocations",
        strict_read=True,
        durability="append_fsync",
        write_driving=True,
    ),
    StateSurface(
        name="agent_invocation_contexts",
        path_pattern="agent-invocations/contexts.jsonl",
        state_class="ledger",
        lock_group="agent_invocations",
        index_group="agent_invocations",
        strict_read=True,
        durability="append_fsync",
        write_driving=True,
    ),
    StateSurface(
        name="agent_invocation_prompts",
        path_pattern="agent-invocations/prompts.jsonl",
        state_class="ledger",
        lock_group="agent_invocations",
        index_group="agent_invocations",
        strict_read=True,
        durability="append_fsync",
        write_driving=True,
    ),
    StateSurface(
        name="agent_invocation_transcripts",
        path_pattern="agent-invocations/transcripts.jsonl",
        state_class="ledger",
        lock_group="agent_invocations",
        index_group="agent_invocations",
        strict_read=True,
        durability="append_fsync",
        write_driving=True,
    ),
    StateSurface(
        name="agent_result_bridge_status",
        path_pattern="agent-invocations/agent-result-bridge-status.jsonl",
        state_class="ledger",
        lock_group="agent_invocations",
        index_group="agent_invocations",
        strict_read=True,
        durability="append_fsync",
        write_driving=True,
    ),
    StateSurface(
        name="ack_ledger",
        path_pattern="acks/acks.jsonl",
        state_class="ledger",
        lock_group="acks",
        index_group=None,
        strict_read=True,
        durability="append_fsync",
        write_driving=True,
    ),
    StateSurface(
        name="next_cycle_queue",
        path_pattern="queues/next_cycle_queue.jsonl",
        state_class="ledger",
        lock_group="queue",
        index_group=None,
        strict_read=True,
        durability="append_fsync",
        write_driving=True,
    ),
    StateSurface(
        name="worker_dispatch",
        path_pattern="dispatch/*.jsonl",
        state_class="ledger",
        lock_group="dispatch",
        index_group=None,
        strict_read=True,
        durability="append_fsync",
        write_driving=True,
    ),
    StateSurface(
        name="autonomous_host_local_lease",
        path_pattern="locks/autonomous-host.lock",
        state_class="lock",
        lock_group="autonomous_host",
        index_group=None,
        strict_read=True,
        durability="rewrite_fsync",
        write_driving=True,
    ),
    StateSurface(
        name="autonomous_host_remote_cas_lease",
        path_pattern="locks/autonomous-host.cas.json",
        state_class="lock",
        lock_group="autonomous_host",
        index_group=None,
        strict_read=True,
        durability="rewrite_fsync",
        write_driving=True,
    ),
    StateSurface(
        name="agent_output_artifacts",
        path_pattern="agent-invocations/outputs/*.json",
        state_class="artifact",
        lock_group="agent_invocations",
        index_group=None,
        strict_read=True,
        durability="rewrite_fsync",
        write_driving=False,
    ),
    StateSurface("runs", "runs.jsonl", "ledger", "runtime", "runtime", True, "append_fsync", True),
    StateSurface("runs_by_cycle", "runs/by-cycle/*.jsonl", "ledger", "runtime", "runtime", True, "append_fsync", True),
    StateSurface("health", "health.jsonl", "ledger", "runtime", "runtime", True, "append_fsync", True),
    StateSurface("cycles", "cycles.jsonl", "ledger", "runtime", "runtime", True, "append_fsync", True),
    StateSurface("context_audits", "context-audits.jsonl", "ledger", "governance", "tools", True, "append_fsync", True),
    StateSurface("tools_governance", "governance.jsonl", "ledger", "governance", "tools", True, "append_fsync", True),
    StateSurface("tool_registry", "registry.json", "index", "registry", "tools", True, "rewrite_fsync", True),
    StateSurface("raw_findings", "raw-findings.jsonl", "ledger", "runtime", "runtime", True, "append_fsync", True),
    StateSurface("runtime_artifact_index", "run-artifacts/artifact-index.jsonl", "ledger", "runtime_artifacts", "runtime", True, "append_fsync", True),
    StateSurface("runtime_artifact_manifest", "run-artifacts/manifest.jsonl", "ledger", "runtime_artifacts", "runtime", True, "append_fsync", True),
    StateSurface("runtime_artifact_inventory", "observability/artifact-inventory.jsonl", "ledger", "runtime_artifacts", "runtime", True, "append_fsync", True),
    StateSurface("runtime_artifact_hot", "run-artifacts/hot/**/*.json", "artifact", "runtime_artifacts", "runtime", True, "rewrite_fsync", True),
    StateSurface("retention_events", "retention/events.jsonl", "ledger", "runtime_artifacts", "runtime", True, "append_fsync", True),
    StateSurface("runtime_v2_promotions", "runtime/v2-promotions.jsonl", "ledger", "runtime", "runtime", True, "append_fsync", True),
    StateSurface("autonomy_state", "autonomy_state.jsonl", "ledger", "autonomy", "runtime", True, "append_fsync", True),
    StateSurface("plan_convergence_events", "plans/*.jsonl", "ledger", "planning", "runtime", True, "append_fsync", True),
    StateSurface("bridge_status", "agent-invocations/agent-result-bridge-status.jsonl", "ledger", "agent_invocations", "agent_invocations", True, "append_fsync", True),
    StateSurface("cost_budget", "budget/*.jsonl", "ledger", "budget", "runtime", True, "append_fsync", True),
    StateSurface("quarantine", "quarantine/*.jsonl", "ledger", "quarantine", "runtime", True, "append_fsync", True),
)


def iter_surfaces() -> tuple[StateSurface, ...]:
    return STATE_SURFACES


def surface_by_name(name: str) -> StateSurface:
    for surface in STATE_SURFACES:
        if surface.name == name:
            return surface
    raise KeyError(f"unknown ARIA state surface: {name}")


def surfaces_for_lock_group(lock_group: str) -> tuple[StateSurface, ...]:
    return tuple(surface for surface in STATE_SURFACES if surface.lock_group == lock_group)


def surface_for_relative_path(relative_path: str | Path) -> StateSurface | None:
    rel = Path(relative_path).as_posix().lstrip("/")
    for surface in STATE_SURFACES:
        if fnmatch(rel, surface.path_pattern):
            return surface
    return None


def surface_for_path(path: str | Path) -> tuple[StateSurface, Path] | None:
    """Return ``(surface, base_dir)`` for a concrete path when declared.

    ``base_dir`` is the prefix before the manifest's relative pattern.
    Pattern surfaces (for example ``dispatch/*.jsonl``) return the path
    prefix before the wildcard's first concrete component.
    """
    concrete = Path(path).resolve()
    parts = concrete.parts
    for surface in STATE_SURFACES:
        pattern_parts = Path(surface.path_pattern).parts
        fixed_parts: list[str] = []
        for part in pattern_parts:
            if "*" in part:
                break
            fixed_parts.append(part)
        if not fixed_parts or len(parts) < len(fixed_parts):
            continue
        for idx in range(0, len(parts) - len(fixed_parts) + 1):
            if list(parts[idx:idx + len(fixed_parts)]) != fixed_parts:
                continue
            rel = Path(*parts[idx:]).as_posix()
            if fnmatch(rel, surface.path_pattern):
                base = Path(*parts[:idx]) if idx > 0 else Path(concrete.anchor)
                return surface, base
    return None


def resolve_surface_path(base_dir: str | Path, surface: StateSurface) -> Path:
    if "*" in surface.path_pattern:
        raise ValueError(f"surface {surface.name} is a pattern, not a single path")
    return Path(base_dir) / surface.path_pattern


__all__ = [
    "STATE_SURFACES",
    "StateSurface",
    "iter_surfaces",
    "resolve_surface_path",
    "surface_by_name",
    "surface_for_path",
    "surface_for_relative_path",
    "surfaces_for_lock_group",
]
