"""A fixture workspace's orchestrator routing table (SE-2).

The routing table is the one path -> Lane-A agent map
(``agent_routing.ROUTING_TABLE_REL``, read by ``load_routing_table``). Every
kernel path that picks reviewers reads it from the workspace under review,
so a fixture that exercises specialist selection writes one, in the table's
own markdown shape, rather than patching a selection seam.
"""
from __future__ import annotations

from pathlib import Path

from aria_kernel.agent_routing import ROUTING_TABLE_REL


def write_routing_table(workspace: Path, rows: dict[str, tuple[str, str]]) -> Path:
    """Write ``rows`` (``glob -> (primary cell, also-notify cell)``) as the
    workspace's routing table and return its path."""
    table = workspace / ROUTING_TABLE_REL
    table.parent.mkdir(parents=True, exist_ok=True)
    lines = ["| File Pattern | Primary Agent | Also Notify |", "|---|---|---|"]
    lines.extend(f"| `{glob}` | {primary} | {also} |" for glob, (primary, also) in rows.items())
    table.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return table
