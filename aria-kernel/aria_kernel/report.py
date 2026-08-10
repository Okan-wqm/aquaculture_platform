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


def _roi_metrics(tools_root: Path, date: str) -> dict[str, Any]:
    """Plan S6 (ORPHAN-MEDIUM-299) — merged-value-per-dollar metrics.

    Joins the two ledgers the runtime already writes: cost-attribution
    monthly shards (per-LLM-invocation estimated_usd, V10.4) and
    pr-lifecycle.jsonl (event=="merged" rows, Plan 025 §E). Day scope =
    recorded_at prefix match on ``date``; month-to-date scope = the
    date's YYYY-MM shard / prefix. Read-only and fail-soft: missing
    ledgers yield zeros, matching the anchor's best-effort contract.
    """
    month = date[:7]
    shard = tools_root / "cost-attribution" / f"{month}.jsonl"
    day_cost = mtd_cost = 0.0
    day_calls = 0
    day_cycles: set[str] = set()
    for line in _safe_read_lines(shard):
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        recorded = str(row.get("recorded_at") or "")
        if not recorded.startswith(month):
            continue
        try:
            usd = float(row.get("estimated_usd") or 0.0)
        except (TypeError, ValueError):
            continue
        mtd_cost += usd
        if recorded.startswith(date):
            day_cost += usd
            day_calls += 1
            if row.get("cycle_id"):
                day_cycles.add(str(row["cycle_id"]))
    day_merged = mtd_merged = 0
    for line in _safe_read_lines(tools_root / "pr-lifecycle.jsonl"):
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("event") != "merged":
            continue
        recorded = str(row.get("recorded_at") or "")
        if recorded.startswith(month):
            mtd_merged += 1
        if recorded.startswith(date):
            day_merged += 1
    return {
        "day_cost_usd": round(day_cost, 4),
        "day_llm_calls": day_calls,
        "day_cycles_with_spend": len(day_cycles),
        "day_merged_prs": day_merged,
        "usd_per_merge": round(day_cost / day_merged, 4) if day_merged else None,
        "mtd_cost_usd": round(mtd_cost, 4),
        "mtd_merged_prs": mtd_merged,
    }


def _state_snapshot_anchor(path: Path | None) -> tuple[str | None, str | None]:
    """Wave 1 §2.2 — the snapshot's identity + tree-level continuity root.

    The anchor is the one audit record that lands in git on the daily
    report PR, so pinning ``manifest_root`` here is what carries
    tree-level continuity into a store nobody can rewrite in place:
    a later reader can take any snapshot claiming to precede today's
    state and check it against a root that was committed at the time.
    Best-effort like every other field — no snapshot yet reads as None,
    never as a zero that a consumer would sum.
    """
    if path is None or not path.is_file():
        return None, None
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None, None
    if not isinstance(manifest, dict):
        return None, None
    snapshot_id = manifest.get("snapshot_id")
    manifest_root = manifest.get("manifest_root")
    return (
        snapshot_id if isinstance(snapshot_id, str) else None,
        manifest_root if isinstance(manifest_root, str) else None,
    )


def build_daily_anchor(
    *,
    date: str,
    workspace_root: Path,
    tools_root: Path,
    state_snapshot_path: Path | None = None,
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
    snapshot_id, manifest_root = _state_snapshot_anchor(state_snapshot_path)

    return {
        "date": date,
        "chain_tip_ledger_hash": _tail_ledger_hash(governance_path),
        "workspace_chain_tip_ledger_hash": _workspace_governance_tail(workspace_root),
        "events_emitted_count": _count_events(governance_path),
        "cycle_ids_sealed": _read_sealed_cycle_ids(cycles_path),
        "integrity_index_chain_root": _integrity_index_chain_root(integrity_index_path),
        # Plan S6 (ORPHAN-MEDIUM-299) — additive key; the I-26 invariant
        # only constrains the pre-existing fields.
        "roi": _roi_metrics(tools_root, date),
        # Wave 1 §2.2 — additive, same contract: the state snapshot's id
        # and tree-level continuity root, committed with the anchor so
        # continuity has a witness outside the state store itself.
        "state_snapshot_id": snapshot_id,
        "state_manifest_root": manifest_root,
    }


def render_anchor_markdown(
    anchor: dict[str, Any], *, body_markdown: str | None = None
) -> str:
    """Render the anchor as YAML frontmatter + markdown body.

    FAZ 6a — when ``body_markdown`` is supplied (the reflection daily
    report from the durable store), the anchor becomes that report's
    FRONTMATTER instead of a competing document: one path, one artifact,
    the two-writers-one-filename class dies. Without a body the pre-FAZ-6
    minimal stub renders unchanged, so the I-26 parseability invariant
    (which only reads frontmatter) holds in both shapes.
    """
    import yaml  # type: ignore[import-untyped]

    front = yaml.safe_dump(
        anchor,
        sort_keys=True,
        default_flow_style=False,
        allow_unicode=True,
    )
    if body_markdown is not None:
        return "---\n" + front + "---\n\n" + body_markdown.strip() + "\n"
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
        + "## Merged value per dollar\n"
        + "\n"
        + "The `roi` frontmatter block joins the cost-attribution shard\n"
        + "with pr-lifecycle merged events for this date: cycle spend,\n"
        + "merged-PR count, and usd_per_merge (null until the first\n"
        + "merged PR of the day). Month-to-date fields accumulate over\n"
        + "the calendar month's shard.\n"
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
    state_snapshot_path: Path | None = None,
) -> dict[str, Any]:
    """Plan ARIA-V2 §3.9 CLI handler — assemble + write the anchor.

    Idempotent: if ``output_path`` already exists AND already has a
    parseable Plan ARIA-V2 frontmatter, leave it unchanged. New anchors
    (and pre-existing legacy stubs without frontmatter) get rewritten.

    ``state_snapshot_path`` reaches ``build_daily_anchor`` through here so
    the committed anchor pins the state store's ``manifest_root``. The
    parameter existed one level down with nothing forwarding to it — a
    capability with no caller, which is the same shape as the defect the
    anchor exists to catch.
    """
    anchor = build_daily_anchor(
        date=date,
        workspace_root=workspace_root,
        tools_root=tools_root,
        state_snapshot_path=state_snapshot_path,
    )
    if output_path.exists() and _has_v2_frontmatter(output_path):
        return {
            "status": "already_anchored",
            "path": output_path.as_posix(),
            "anchor": anchor,
        }
    # FAZ 6a — the anchor was a SECOND writer of the daily-report filename:
    # the lane committed this stub while reflection wrote the real report to
    # the durable store, so the published PR carried three empty lines and
    # the operator-facing report was never published anywhere. When the
    # store holds the reflection report for this date, the anchor becomes
    # its frontmatter and the published artifact IS the report.
    reflection_report = tools_root / "reports" / "daily" / f"{date}.md"
    body_markdown: str | None = None
    if reflection_report.is_file() and reflection_report.resolve() != output_path.resolve():
        try:
            body_markdown = reflection_report.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            body_markdown = None
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        render_anchor_markdown(anchor, body_markdown=body_markdown),
        encoding="utf-8",
    )
    return {
        "status": "written",
        "path": output_path.as_posix(),
        "anchor": anchor,
        "report_body": "reflection" if body_markdown is not None else "stub",
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
