"""Plan 032 Faz 032h — the harness-parity table, machine-verified.

Every capability the Hermes comparison named maps to the ARIA module that
owns it, the CLI verb an operator uses, and the invariant test that pins it.
`check_parity` imports each symbol, parses each CLI verb and stats each test
file; `render_parity_report` writes docs/aria/generated/harness-parity.md.
A row that cannot be verified is a red check, not a footnote.
"""
from __future__ import annotations

import contextlib
import importlib
import io
from dataclasses import dataclass
from pathlib import Path
from typing import Any

PARITY_STATUSES: tuple[str, ...] = ("superior", "parity", "partial")


@dataclass(frozen=True)
class ParityRow:
    capability: str
    hermes: str
    module: str
    symbol: str
    cli: tuple[str, ...]
    test: str
    status: str
    note: str


PARITY_TABLE: tuple[ParityRow, ...] = (
    ParityRow("Command-time approval", "smart|manual|off approvals (LLM-judged)", "aria_kernel.hooks", "decide_pre_tool", ("hook", "pre-tool"), "aria-kernel/tests/invariants/v12/test_phase_v12_b_hooks.py", "superior", "deterministic CommandPolicy + Claude deny rules + bwrap; every decision ledgered"),
    ParityRow("Command policy", "allow/deny lists in config", "aria_kernel.command_policy", "classify_command", ("hook", "pre-tool"), "aria-kernel/tests/invariants/v12/test_phase_v12_b_command_policy.py", "superior", "one canonical policy compiled to regex + permission rules + verified examples"),
    ParityRow("Sandboxed execution", "docker/none", "aria_kernel.implementation_safety", "wrap_bash_in_sandbox", ("doctor",), "aria-kernel/tests/invariants/v12/test_phase_v12_b_runtime_profiles.py", "superior", "bwrap, READONLY_PATHS, write_scope binds, unshare-net for tools"),
    ParityRow("Runtime profiles / tool grants", "per-agent tool list", "aria_kernel.runtime_profiles", "disallowed_tools_for", ("mcp", "config"), "aria-kernel/tests/invariants/v12/test_phase_v12_b_runtime_profiles.py", "superior", "kernel-owned, mirror-verified, projected to --disallowedTools"),
    ParityRow("Environment isolation", "inherits shell env", "aria_kernel.agent_env", "build_agent_env", ("doctor",), "aria-kernel/tests/invariants/v12/test_phase_v12_b_agent_env.py", "superior", "built env, secret-shaped names dropped, synthetic HOME"),
    ParityRow("Work journal", "transcript", "aria_kernel.hooks", "record_journal", ("hook", "post-tool"), "aria-kernel/tests/invariants/v12/test_phase_v12_b_hooks.py", "superior", "sanitized, hash-chained, argv redacted"),
    ParityRow("Checkpoints / rollback", "shadow git", "aria_kernel.checkpoint", "restore_checkpoint", ("checkpoint", "restore"), "aria-kernel/tests/invariants/v12/test_phase_v12_c_checkpoint.py", "parity", "store outside the workspace, hand edits preserved"),
    ParityRow("Session continuity", "resume by id", "aria_kernel.session_continuity", "decide_session", ("session", "list"), "aria-kernel/tests/invariants/v12/test_phase_v12_c_session_recovery.py", "superior", "fingerprint-bound resume"),
    ParityRow("Crash recovery", "restart", "aria_kernel.recovery", "classify_recovery", ("recovery", "classify"), "aria-kernel/tests/invariants/v12/test_phase_v12_c_session_recovery.py", "superior", "intent/receipt + remote check → replay|resume|check|human"),
    ParityRow("History search", "grep transcripts", "aria_kernel.search", "search", ("search",), "aria-kernel/tests/invariants/v12/test_phase_v12_c_search.py", "parity", "derived FTS5 index over ledgers"),
    ParityRow("Delivery closure", "agent says done", "aria_kernel.delivery_closure", "compute_delivery_closure", ("delivery", "status"), "aria-kernel/tests/invariants/v12/test_phase_v12_d_delivery.py", "superior", "verified only by effect ledgers; SLO"),
    ParityRow("Scoped credentials", "ambient tokens", "aria_kernel.delivery_credentials", "issue_delivery_credentials", ("delivery", "status"), "aria-kernel/tests/invariants/v12/test_phase_v12_d_delivery.py", "superior", "per-spawn lease, revoked, names-only governance"),
    ParityRow("Operator control / cancel", "Ctrl-C", "aria_kernel.control", "effective_control", ("control", "status"), "aria-kernel/tests/invariants/v12/test_phase_v12_e_ops.py", "superior", "ledgered pause/resume/cancel; process-group stop; terminal state"),
    ParityRow("Live progress", "terminal stream", "aria_kernel.progress", "tail_progress", ("tail",), "aria-kernel/tests/invariants/v12/test_phase_v12_e_ops.py", "superior", "sanitized hash-chained progress per request"),
    ParityRow("Notifications", "none", "aria_kernel.notify", "notify", ("notify", "channels"), "aria-kernel/tests/invariants/v12/test_phase_v12_e_ops.py", "superior", "closed kinds, dedup outbox, env-name channels"),
    ParityRow("Telemetry / alerts", "none", "aria_kernel.telemetry", "collect_metrics", ("telemetry", "export"), "aria-kernel/tests/invariants/v12/test_phase_v12_e_ops.py", "superior", "Prometheus series + rules + dashboard"),
    ParityRow("Health check", "none", "aria_kernel.doctor", "run_doctor", ("doctor",), "aria-kernel/tests/test_doctor.py", "superior", "organ probes with exit codes"),
    ParityRow("Event gateway (webhooks)", "none", "aria_kernel.gateway.server", "build_server", ("gateway", "status"), "aria-kernel/tests/invariants/v12/test_phase_v12_f_gateway.py", "superior", "HMAC/bearer/replay/allowlist; inbox ledger"),
    ParityRow("Scheduler / cron", "cron with prompts", "aria_kernel.gateway.scheduler", "tick", ("schedule", "list"), "aria-kernel/tests/invariants/v12/test_phase_v12_f_gateway.py", "superior", "closed action vocabulary, never a prompt"),
    ParityRow("MCP client", "config file", "aria_kernel.mcp_client", "mcp_config_for_profile", ("mcp", "config"), "aria-kernel/tests/invariants/v12/test_phase_v12_g_mcp.py", "superior", "kernel registry, strict per-spawn config, quarantine"),
    ParityRow("MCP server", "none", "aria_kernel.mcp_server", "AriaMcpServer", ("mcp", "serve"), "aria-kernel/tests/invariants/v12/test_phase_v12_g_mcp.py", "superior", "read-only store tools; operator-gated writes"),
    ParityRow("Skill lifecycle", "auto-created skills", "aria_kernel.skill_curator", "propose_curation", ("skill", "curate"), "aria-kernel/tests/invariants/v12/test_phase_v12_h_skill_parallel.py", "superior", "proposals only; rollback; shadow compare; panel + veto stay"),
    ParityRow("Parallel delegation", "subagents", "aria_kernel.genesis_policy", "executor_policy", ("doctor",), "aria-kernel/tests/invariants/v12/test_phase_v12_h_skill_parallel.py", "partial", "policy-bounded drain concurrency with per-request worktrees; default 1 until the 032d SLO holds"),
    ParityRow("Decision memory / context economy", "memory file", "aria_kernel.context_compiler", "compile_context", ("context", "compile"), "aria-kernel/tests/invariants/v12/test_phase_v12_i_self_improvement.py", "superior", "hash-addressed context pack from ledgers; tokens per accepted result"),
    ParityRow("Self-improvement", "none", "aria_kernel.self_improvement", "open_self_improvement_missions", ("self-improve", "scan"), "aria-kernel/tests/invariants/v12/test_phase_v12_i_self_improvement.py", "superior", "kernel-scoped missions → self_change proposals; authority never widened"),
)


def check_parity(*, repo_root: str | Path) -> list[dict[str, Any]]:
    """One verified record per row: import, symbol, CLI verb, test file."""
    from .cli import build_parser

    root = Path(repo_root).resolve()
    parser = build_parser()
    out: list[dict[str, Any]] = []
    for row in PARITY_TABLE:
        problems: list[str] = []
        try:
            module = importlib.import_module(row.module)
            if not hasattr(module, row.symbol):
                problems.append(f"symbol_missing:{row.module}.{row.symbol}")
        except Exception as exc:  # noqa: BLE001 — an unimportable owner is the finding
            problems.append(f"import_failed:{row.module}:{type(exc).__name__}")
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            try:
                parser.parse_args([*row.cli, "--help"])
            except SystemExit as exc:
                if exc.code not in (0, None):
                    problems.append(f"cli_unknown:{' '.join(row.cli)}")
        if not (root / row.test).exists():
            problems.append(f"test_missing:{row.test}")
        if row.status not in PARITY_STATUSES:
            problems.append(f"status_unknown:{row.status}")
        out.append({"capability": row.capability, "status": row.status, "module": row.module, "symbol": row.symbol,
                    "cli": " ".join(row.cli), "test": row.test, "problems": problems})
    return out


def render_parity_report(*, repo_root: str | Path) -> str:
    records = check_parity(repo_root=repo_root)
    lines = [
        "<!-- GENERATED by aria_kernel.harness_parity — do not edit; `aria-kernel parity generate` rewrites it. -->",
        "",
        "# ARIA vs harness agents — parity table (machine-verified)",
        "",
        f"Rows: {len(records)} · verified: {sum(1 for r in records if not r['problems'])} · "
        f"superior: {sum(1 for r in records if r['status'] == 'superior')} · parity: {sum(1 for r in records if r['status'] == 'parity')} · "
        f"partial: {sum(1 for r in records if r['status'] == 'partial')}",
        "",
        "| Capability | Hermes-style harness | ARIA owner | CLI | Test | Status | Verified |",
        "|---|---|---|---|---|---|---|",
    ]
    for row, rec in zip(PARITY_TABLE, records):
        verified = "yes" if not rec["problems"] else "NO: " + "; ".join(rec["problems"])
        lines.append(f"| {row.capability} | {row.hermes} | `{row.module}.{row.symbol}` | `aria-kernel {' '.join(row.cli)}` | `{row.test}` | {row.status} | {verified} |")
    lines += ["", "Notes:", ""]
    lines += [f"- **{row.capability}** — {row.note}" for row in PARITY_TABLE]
    return "\n".join(lines) + "\n"


__all__ = ["PARITY_STATUSES", "PARITY_TABLE", "ParityRow", "check_parity", "render_parity_report"]
