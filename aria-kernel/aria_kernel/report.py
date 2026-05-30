"""Plan ARIA-V2 §3.9 — daily report anchor generation.

The committed daily anchor file replaces git history as the audit-trust
source after Phase 5 gitignored per-clone runtime ledgers. Once a day,
the aria-bot CI workflow calls ``aria-kernel report daily --emit-anchor``
which writes a YAML-frontmatter markdown document at
``aria-tools/reports/daily/YYYY-MM-DD.md`` and commits it.

Anchor frontmatter (plan §3.9):

  ---
  date: YYYY-MM-DD
  chain_tip_ledger_hash: <tail row's ledger_hash from aria-tools/governance.jsonl>
  workspace_chain_tip_ledger_hash: <tail hash from workspace governance.jsonl>
  events_emitted_count: <N>
  cycle_ids_sealed:
    - <cycle-id-1>
    - <cycle-id-2>
  integrity_index_chain_root: <sha256 of sorted ledger_hashes map>
  ---

In CI (fresh-clone with most ledgers gitignored) most fields are null.
The invariant I-26 still holds because ``events_emitted_count == 0``
makes the ``chain_tip_ledger_hash`` field's null value consistent.

A pre-existing anchor for the same date is preserved unchanged so
re-running the workflow is idempotent (Tier-1: writing twice produces
the same on-disk content).
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


def _safe_read_lines(path: Path) -> list[str]:
    """Read a JSONL file, return list of non-blank lines. Missing → []."""
    if not path.exists() or not path.is_file():
        return []
    try:
        return [line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    except (OSError, UnicodeDecodeError):
        return []


def _tail_ledger_hash(path: Path) -> str | None:
    """Return the tail row's ``ledger_hash`` field, or None if absent/empty."""
    lines = _safe_read_lines(path)
    if not lines:
        return None
    for line in reversed(lines):
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            value = row.get("ledger_hash")
            if isinstance(value, str) and value:
                return value
    return None


def _count_events(path: Path) -> int:
    return len(_safe_read_lines(path))


def _read_sealed_cycle_ids(cycles_path: Path) -> list[str]:
    """Return cycle_ids whose latest row carries a terminal status."""
    terminal = {"completed", "failed", "stopped", "aborted"}
    state: dict[str, str] = {}
    for line in _safe_read_lines(cycles_path):
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(row, dict):
            continue
        cycle_id = row.get("cycle_id")
        if not isinstance(cycle_id, str) or not cycle_id:
            continue
        event = row.get("event") or row.get("status")
        if isinstance(event, str):
            state[cycle_id] = event
    return sorted(cid for cid, ev in state.items() if ev in terminal)


def _integrity_index_chain_root(path: Path) -> str | None:
    """Plan ARIA-V2 §3.9 — sha256 of canonical-JSON ledger_hashes map.

    Reads ``integrity_index.json`` if present; extracts the
    ``ledger_hashes`` dict (sorted by ledger name); hashes the canonical
    JSON serialization. Returns None when the file is absent or
    malformed.
    """
    if not path.exists() or not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    ledger_hashes = data.get("ledger_hashes") or {}
    if not isinstance(ledger_hashes, dict):
        return None
    sorted_map = {k: ledger_hashes[k] for k in sorted(ledger_hashes)}
    payload = json.dumps(sorted_map, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def _workspace_governance_tail(workspace_root: Path) -> str | None:
    """Find a workspace-side governance ledger and return its tail hash.

    Operator workspaces live under ``<workspace_root>/.aria/workspaces/<id>/``
    OR ``<workspace_root>/aria-tools/workspaces/<id>/`` per Plan ARIA-V2
    §3.2. We try the conventional locations; absent files return None.
    """
    candidates = [
        workspace_root / "aria-tools" / "workspaces",
        workspace_root / ".aria" / "workspaces",
    ]
    for base in candidates:
        if not base.exists() or not base.is_dir():
            continue
        for ws_dir in sorted(base.iterdir()):
            if not ws_dir.is_dir():
                continue
            for gov in (
                ws_dir / "aria-memory" / "governance.jsonl",
                ws_dir / "governance.jsonl",
            ):
                tail = _tail_ledger_hash(gov)
                if tail:
                    return tail
    return None


def build_daily_anchor(
    *,
    date: str,
    workspace_root: Path,
    tools_root: Path,
) -> dict[str, Any]:
    """Plan ARIA-V2 §3.9 + I-26 — assemble the daily anchor payload.

    Reads the kernel's local state at ``tools_root`` and the workspace
    state at ``workspace_root`` (best-effort; gitignored files in fresh
    CI checkouts return None for their fields). Returns a dict ready
    to render as YAML frontmatter.

    Idempotency note: the function is read-only; caller decides whether
    to overwrite an existing anchor file. The CLI handler refuses to
    overwrite a non-stub file (preserves manual edits + replay safety).
    """
    governance_path = tools_root / "governance.jsonl"
    cycles_path = tools_root / "cycles.jsonl"
    integrity_index_path = tools_root / "integrity_index.json"

    return {
        "date": date,
        "chain_tip_ledger_hash": _tail_ledger_hash(governance_path),
        "workspace_chain_tip_ledger_hash": _workspace_governance_tail(workspace_root),
        "events_emitted_count": _count_events(governance_path),
        "cycle_ids_sealed": _read_sealed_cycle_ids(cycles_path),
        "integrity_index_chain_root": _integrity_index_chain_root(integrity_index_path),
    }


def render_anchor_markdown(anchor: dict[str, Any]) -> str:
    """Render the anchor as YAML frontmatter + markdown body.

    The body is intentionally minimal — the load-bearing payload is the
    frontmatter. Operators or downstream tooling can extend the body in
    follow-up commits without breaking the I-26 parseability invariant
    (which only reads frontmatter).
    """
    import yaml  # type: ignore[import-untyped]

    front = yaml.safe_dump(
        anchor,
        sort_keys=True,
        default_flow_style=False,
        allow_unicode=True,
    )
    return (
        "---\n"
        + front
        + "---\n"
        + f"\n# ARIA Daily Anchor {anchor['date']}\n"
        + "\n"
        + "Auto-generated by `aria-kernel report daily --emit-anchor`.\n"
        + "Plan ARIA-V2 §3.9 — committed daily chain-tip anchor replacing\n"
        + "git history as the audit-trust source for per-clone runtime\n"
        + "ledgers (gitignored per §3.4).\n"
        + "\n"
        + "## Governance ledger\n"
        + "\n"
        + "See `aria-tools/governance.jsonl` (operator-local) for the\n"
        + "full event chain. The `chain_tip_ledger_hash` above pins the\n"
        + "tail row's content hash at this anchor's emission time.\n"
    )


def emit_anchor_to_path(
    *,
    date: str,
    workspace_root: Path,
    tools_root: Path,
    output_path: Path,
) -> dict[str, Any]:
    """Plan ARIA-V2 §3.9 CLI handler — assemble + write the anchor.

    Idempotent: if ``output_path`` already exists AND already has a
    parseable Plan ARIA-V2 frontmatter, leave it unchanged. New anchors
    (and pre-existing legacy stubs without frontmatter) get rewritten.
    """
    anchor = build_daily_anchor(
        date=date,
        workspace_root=workspace_root,
        tools_root=tools_root,
    )
    if output_path.exists() and _has_v2_frontmatter(output_path):
        return {
            "status": "already_anchored",
            "path": output_path.as_posix(),
            "anchor": anchor,
        }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(render_anchor_markdown(anchor), encoding="utf-8")
    return {
        "status": "written",
        "path": output_path.as_posix(),
        "anchor": anchor,
    }


def _has_v2_frontmatter(path: Path) -> bool:
    """Best-effort check: does the file open with a YAML frontmatter
    block containing the canonical ``chain_tip_ledger_hash`` key?
    """
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return False
    if not text.startswith("---\n"):
        return False
    end = text.find("\n---\n", 4)
    if end == -1:
        return False
    return "chain_tip_ledger_hash" in text[4:end]


def parse_anchor_frontmatter(path: Path) -> dict[str, Any] | None:
    """Plan ARIA-V2 I-26 — parse the YAML frontmatter from an anchor.

    Returns the dict on success; None if the file has no frontmatter or
    the frontmatter is unparseable. Used by the invariant test to walk
    every committed daily anchor and verify shape.
    """
    import yaml  # type: ignore[import-untyped]

    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---\n", 4)
    if end == -1:
        return None
    block = text[4:end]
    try:
        parsed = yaml.safe_load(block)
    except yaml.YAMLError:
        return None
    return parsed if isinstance(parsed, dict) else None
