"""WP-P — the role x provider matrix, generated from the production accessors.

Operator requirement (HANDOVER 2026-10-18 §7): with any single provider alive,
every role runs; no role is served by fewer than two providers unless the
operator pins it. The matrix is the artifact that makes the empty cells
VISIBLE (WP-P package §1.1): rows are the dispatchable roles, columns are the
fleet's providers, and every cell's verdict is computed by CALLING the owner
of the fact it states — never hand-maintained:

* routing: ``runtime_profiles.load_provider_routing().ladder_for`` (the table
  ``_validate_routing`` already refuses to load half-valid);
* write scope: the seat's resolved profile (``agent_runtime_profile``) and
  ``model_fleet.provider_admits_writes`` — the same two facts the native
  admission reads when it refuses a write-capable seat with
  ``provider_readonly_runtime``;
* the Codex runtime's profile-controls gate: ``codex_runtime`` itself, asked
  through its own refusal (see ``codex_controls_verdict``);
* the lanes: ``runtime_profiles.worker_ladder`` for the worker lane's seat and
  ``ci_executor._SPAWN_LANE_RUNTIMES`` for the spawn lane, loaded the one
  right way (``executor_module.load_ci_executor``).

The committed artifact ``docs/aria/generated/ROLE-PROVIDER-MATRIX.md`` is
byte-diffed against this renderer by ``tests/test_role_provider_matrix_ssot.py``
(the JUDGE-DIGEST pattern); the invariant lives in
``tests/test_provider_matrix_invariant.py``. Regen:

    cd aria-kernel && python3 -m tests._helpers.role_provider_matrix \
        > ../docs/aria/generated/ROLE-PROVIDER-MATRIX.md
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parents[3]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))

from aria_kernel.agent_runtime_profile import AgentRuntimeProfile, read_agent_runtime_profile  # noqa: E402
from aria_kernel.agent_surface import DISPATCHABLE_ROLES, ROLE_TARGET_PAIRING  # noqa: E402
from aria_kernel.model_fleet import _FLEET, provider_admits_writes  # noqa: E402
from aria_kernel.runtime_profiles import (  # noqa: E402
    WORKER_LANE_RUNTIMES, WORKER_ROUTE_SEAT, load_provider_routing, profile_by_id, worker_ladder,
)
from tests._helpers.executor_module import load_ci_executor  # noqa: E402
from tests._helpers.single_provider_host import claude_host, codex_host, zai_host  # noqa: E402

MATRIX_PATH = "docs/aria/generated/ROLE-PROVIDER-MATRIX.md"

# Seats for the dispatchable roles ROLE_TARGET_PAIRING does not pair (their
# routing entry is one ladder for the whole role). Named after the agent the
# kernel's minters address, so the profile the matrix resolves is the profile
# the seat runs: primary/challenger plan and cross-review name their agents at
# mint; the specialist touch-map routes to the two Lane-B experts.
_UNPAIRED_SEATS: dict[str, tuple[str, ...]] = {
    "primary_plan": ("aria-primary-planner",),
    "challenger_plan": ("aria-challenger-planner",),
    "cross_review": ("aria-cross-reviewer",),
    "specialist_domain_review": ("architectural-arbiter", "auth-security-expert"),
}

REASON_NOT_ROUTED = "not routed (absent from the seat's ladder)"
REASON_READONLY_RUNTIME = "refused: provider_readonly_runtime (admits_writes=False)"
REASON_CODEX_CONTROLS = "refused: codex_native_profile_controls_unavailable"


def seats_for(role: str) -> tuple[str, ...]:
    """The target agents a dispatchable role's seats run as."""
    return ROLE_TARGET_PAIRING.get(role) or _UNPAIRED_SEATS.get(role) or (f"<unpaired:{role}>",)


def codex_controls_verdict(profile: Any) -> str | None:
    """Ask the Codex runtime's own gate whether it can serve ``profile``.

    The gate lives inline in ``codex_runtime._prepare_managed_codex_context``
    as its FIRST check, so calling it with unusable paths answers the
    profile question before any filesystem fact is read:
    ``codex_native_profile_controls_unavailable`` is the gate refusing the
    profile; any other refusal (cli, auth directory) means the profile PASSED
    the controls gate. The owner is asked, never copied — and
    ``test_role_provider_matrix_ssot`` pins both answers against a reorder of
    those checks, which would otherwise silently invert this verdict.
    """
    from codex_runtime import ManagedCodexRouteUnavailable, _prepare_managed_codex_context

    nowhere = Path("/nonexistent-aria-matrix-probe")
    try:
        _prepare_managed_codex_context(
            workspace=nowhere, runtime_directory=nowhere, environment={"PATH": ""}, profile=profile,
        )
    except ManagedCodexRouteUnavailable as refusal:
        if refusal.reason == "codex_native_profile_controls_unavailable":
            return REASON_CODEX_CONTROLS
        return None  # the profile passed the controls gate; the host did not
    return None  # a context actually prepared: the profile passed every gate


@dataclass(frozen=True)
class Cell:
    provider: str
    runnable: bool
    reason: str

    def marker(self) -> str:
        return "yes" if self.runnable else "no"


@dataclass(frozen=True)
class SeatRow:
    role: str
    seat: str
    profile: AgentRuntimeProfile
    ladder_name: str
    cells: tuple[Cell, ...]

    @property
    def runnable_providers(self) -> tuple[str, ...]:
        return tuple(cell.provider for cell in self.cells if cell.runnable)


def seat_rows(repo_root: Path) -> list[SeatRow]:
    """Every dispatchable role's every seat, with its per-provider verdicts."""
    routing = load_provider_routing()
    rows: list[SeatRow] = []
    for role in sorted(DISPATCHABLE_ROLES):
        for seat in seats_for(role):
            profile = read_agent_runtime_profile(seat, repo_root=repo_root)
            ladder = routing.ladder_for(role, seat)
            entry = routing.roles[role]
            ladder_name = entry if isinstance(entry, str) else str(entry.get(seat))
            cells = []
            for provider in _FLEET:
                cells.append(_verdict(provider, ladder, profile))
            rows.append(SeatRow(role, seat, profile, ladder_name, tuple(cells)))
    return rows


def _verdict(provider: Any, ladder: tuple[str, ...], profile: AgentRuntimeProfile) -> Cell:
    # A write-capable seat's refusal names the fleet fact FIRST: the ladder's
    # omission is itself a consequence of `admits_writes` (the routing loader
    # refuses a write-scope ladder naming a provider that cannot write), so
    # the cell states the root, not the shadow.
    if profile.write_capable and not provider_admits_writes(provider.key):
        return Cell(provider.key, False, REASON_READONLY_RUNTIME)
    if provider.key not in ladder:
        return Cell(provider.key, False, REASON_NOT_ROUTED)
    if provider.runtime_hint == "codex" and codex_controls_verdict(profile) is not None:
        return Cell(provider.key, False, REASON_CODEX_CONTROLS)
    return Cell(provider.key, True, f"ladder rung {ladder.index(provider.key) + 1} of {len(ladder)}")


def _profile_label(profile: AgentRuntimeProfile) -> str:
    identity = profile.profile_id or profile.source
    write = ", write" if profile.write_capable else ""
    return f"{identity}{write}"


def _host_probe_line() -> str:
    """The columns are the providers a host can present alone (the shared WP-P hosts)."""
    parts = []
    for build, provider in ((claude_host, "anthropic"), (zai_host, "zai"), (codex_host, "openai")):
        host = build()
        try:
            keys = [p.key for p in host.available()]
        finally:
            host.close()
        assert keys == [provider], f"host probe: {keys} != ['{provider}']"
        parts.append(f"{provider}: `{keys[0]}`")
    return ", ".join(parts)


def render_role_provider_matrix(repo_root: Path = _REPO_ROOT) -> str:
    """The committed artifact's exact bytes (deterministic; no host state crosses the render)."""
    rows = seat_rows(repo_root)
    providers = [provider.key for provider in _FLEET]
    lines: list[str] = []
    lines.append("<!-- GENERATED ARTIFACT — see the footer for the regen command. DO NOT EDIT. -->")
    lines.append("")
    lines.append("# Role x provider matrix (WP-P provider continuity)")
    lines.append("")
    lines.append(
        "Operator requirement (HANDOVER 2026-10-18 §7): with any ONE provider alive —"
        " Claude, Z.ai or Codex — every role runs; no dispatchable role is served by"
        " fewer than two providers unless the operator pins the exception"
        " (aria-kernel/tests/fixtures/role_provider_matrix_pins.json). Every cell is"
        " computed from the production accessors by"
        " `aria-kernel/tests/_helpers/role_provider_matrix.py` and pinned"
        " byte-for-byte by `aria-kernel/tests/test_role_provider_matrix_ssot.py`."
    )
    lines.append("")
    lines.append(f"Columns are the fleet's providers, in fleet order: {', '.join(providers)}.")
    lines.append(f"Each column is a host the shared WP-P builders present alone ({_host_probe_line()}).")
    lines.append("")
    lines.append("## Dispatchable roles")
    lines.append("")
    header = "| role | seat | profile | ladder | " + " | ".join(providers) + " | runnable |"
    lines.append(header)
    lines.append("|" + "---|" * (4 + len(providers) + 1))
    for row in rows:
        cells = " | ".join(cell.marker() for cell in row.cells)
        lines.append(
            f"| {row.role} | {row.seat} | {_profile_label(row.profile)} | {row.ladder_name} "
            f"| {cells} | {len(row.runnable_providers)} |"
        )
    lines.append("")
    lines.append("### Refused cells and their owner-named reasons")
    lines.append("")
    refused = [(row, cell) for row in rows for cell in row.cells if not cell.runnable]
    if refused:
        lines.append("| role | seat | provider | reason |")
        lines.append("|---|---|---|---|")
        for row, cell in refused:
            lines.append(f"| {row.role} | {row.seat} | {cell.provider} | {cell.reason} |")
    else:
        lines.append("Every dispatchable role runs on every provider.")
    lines.append("")
    lines.append("## Lanes")
    lines.append("")
    worker = profile_by_id("worker")
    lines.append(
        f"- worker lane (write targets ride the write seat {WORKER_ROUTE_SEAT[0]} as"
        f" {WORKER_ROUTE_SEAT[1]}): runtimes `{'`, `'.join(WORKER_LANE_RUNTIMES)}`, ladder"
        f" `{', '.join(worker_ladder(worker))}`."
    )
    executor = load_ci_executor()
    spawn_runtimes = executor._SPAWN_LANE_RUNTIMES
    lines.append(
        f"- spawn lane (`ci_executor._dispatch_attempt`): runtimes `{'`, `'.join(spawn_runtimes)}` —"
        " a routing rung on any other runtime is skipped by `routed_models` there."
    )
    lines.append("")
    lines.append("<!-- Regen: cd aria-kernel && python3 -m tests._helpers.role_provider_matrix")
    lines.append("     > ../docs/aria/generated/ROLE-PROVIDER-MATRIX.md")
    lines.append("     Pinned by: aria-kernel/tests/test_role_provider_matrix_ssot.py (byte-for-byte),")
    lines.append("     aria-kernel/tests/test_provider_matrix_invariant.py (>= runnable floor). -->")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    print(render_role_provider_matrix(_REPO_ROOT), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
