"""Plan 025 §A.1 — Backfill envelope_evidence_hash on legacy results.jsonl rows.

Closes: aria-findings/F-006.json#F-006

Reads aria-tools/agent-invocations/results.jsonl. For each row lacking
envelope_evidence_hash:
  - If output_path still exists on disk, recompute envelope_hash from
    the on-disk envelope content (canonical-JSON SHA-256 via
    aria_kernel.agent_contract.envelope_hash).
  - Else, leave the field absent and emit governance.jsonl event
    {kind: "legacy_row_unhashable",
     details: {claim_id, results_jsonl_line_no, output_path}}.

Writes the rewritten ledger atomically via aria_kernel.ledger.rewrite_jsonl
which preserves the hash chain (each row carries a fresh ledger_hash
chained off the previous row).

Idempotent — re-running on an already-backfilled ledger is a no-op
(rows that already carry envelope_evidence_hash are passed through
unmodified, and rewrite_jsonl is content-deterministic).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

# Make aria_kernel importable when this script is invoked directly via
# `python tools/aria-poc/migrations/plan-025-A1-backfill-envelope-hash.py`
# from the repo root.
_REPO_ROOT = Path(__file__).resolve().parents[3]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))

from aria_kernel.agent_contract import envelope_hash  # noqa: E402
from aria_kernel.ledger import load_jsonl, rewrite_jsonl  # noqa: E402
from aria_kernel.tool_registry import append_tools_governance  # noqa: E402


def _row_has_hash(row: dict[str, Any]) -> bool:
    return "envelope_evidence_hash" in row and row["envelope_evidence_hash"] is not None


def _read_envelope(output_path: str | None) -> dict[str, Any] | None:
    """Read + parse the on-disk envelope. None on any IO/parse failure."""
    if not output_path:
        return None
    path = Path(output_path)
    if not path.exists() or not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def plan_backfill(
    *,
    tools_dir: Path,
) -> dict[str, Any]:
    """Compute the per-row backfill plan without mutating anything.

    Returns: {
        "results_path": str,
        "total_rows": int,
        "already_hashed": int,
        "to_backfill": [{"line_no": int, "claim_id": str, "submitted_hash": str}, ...],
        "unhashable": [{"line_no": int, "claim_id": str, "output_path": str}, ...],
    }
    """
    results_path = tools_dir / "agent-invocations" / "results.jsonl"
    rows = load_jsonl(results_path)
    plan: dict[str, Any] = {
        "results_path": str(results_path),
        "total_rows": len(rows),
        "already_hashed": 0,
        "to_backfill": [],
        "unhashable": [],
    }
    for line_no, row in enumerate(rows, start=1):
        if _row_has_hash(row):
            plan["already_hashed"] += 1
            continue
        envelope = _read_envelope(row.get("output_path"))
        claim_id = row.get("claim_id", "")
        if envelope is None:
            plan["unhashable"].append(
                {
                    "line_no": line_no,
                    "claim_id": claim_id,
                    "output_path": row.get("output_path", ""),
                }
            )
            continue
        plan["to_backfill"].append(
            {
                "line_no": line_no,
                "claim_id": claim_id,
                "submitted_hash": envelope_hash(envelope),
            }
        )
    return plan


def apply_backfill(
    *,
    tools_dir: Path,
) -> dict[str, Any]:
    """Apply the backfill plan in-place.

    Atomicity: load all rows, mutate the in-memory list, then call
    rewrite_jsonl which writes atomically (Path.write_text overwrites
    the whole file, no partial state).

    Idempotent — rows already carrying envelope_evidence_hash are
    passed through unchanged.
    """
    results_path = tools_dir / "agent-invocations" / "results.jsonl"
    rows = load_jsonl(results_path)
    summary: dict[str, Any] = {
        "results_path": str(results_path),
        "total_rows": len(rows),
        "already_hashed": 0,
        "backfilled": 0,
        "unhashable": 0,
    }
    rewritten: list[dict[str, Any]] = []
    for line_no, original in enumerate(rows, start=1):
        # rewrite_jsonl recomputes ledger_hash + previous_ledger_hash for
        # every row, so we strip those and let rewrite_jsonl rebuild the
        # chain from scratch off the new content.
        row = {k: v for k, v in original.items()
               if k not in ("ledger_hash", "previous_ledger_hash")}

        if _row_has_hash(row):
            summary["already_hashed"] += 1
            rewritten.append(row)
            continue

        envelope = _read_envelope(row.get("output_path"))
        claim_id = row.get("claim_id", "")
        if envelope is None:
            # Cannot recompute the hash. Leave the row untouched (the
            # field stays absent) and emit a governance event so an
            # operator can decide whether to delete the orphan row or
            # restore the missing output file.
            append_tools_governance(
                tools_dir,
                "legacy_row_unhashable",
                {
                    "claim_id": claim_id,
                    "results_jsonl_line_no": line_no,
                    "output_path": row.get("output_path", ""),
                },
            )
            summary["unhashable"] += 1
            rewritten.append(row)
            continue

        row["envelope_evidence_hash"] = envelope_hash(envelope)
        summary["backfilled"] += 1
        rewritten.append(row)

    rewrite_jsonl(results_path, rewritten)
    append_tools_governance(
        tools_dir,
        "plan_025_a1_backfill_applied",
        {
            "results_path": str(results_path),
            "total_rows": summary["total_rows"],
            "already_hashed": summary["already_hashed"],
            "backfilled": summary["backfilled"],
            "unhashable": summary["unhashable"],
        },
    )
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Plan 025 §A.1 — backfill envelope_evidence_hash on legacy "
            "results.jsonl rows."
        ),
    )
    parser.add_argument(
        "--tools-dir",
        type=Path,
        required=True,
        help="Path to the aria-tools directory (contains agent-invocations/).",
    )
    mutex = parser.add_mutually_exclusive_group(required=True)
    mutex.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the per-row backfill plan without modifying the ledger.",
    )
    mutex.add_argument(
        "--apply",
        action="store_true",
        help=(
            "Apply the backfill: rewrite results.jsonl with computed "
            "envelope_evidence_hash on every legacy row whose output_path "
            "is still readable. Emit legacy_row_unhashable governance event "
            "for every row whose output_path is absent or unreadable."
        ),
    )
    args = parser.parse_args(argv)

    tools_dir: Path = args.tools_dir.resolve()
    if not tools_dir.exists():
        parser.error(f"--tools-dir does not exist: {tools_dir}")
    if not tools_dir.is_dir():
        parser.error(f"--tools-dir is not a directory: {tools_dir}")

    if args.dry_run:
        plan = plan_backfill(tools_dir=tools_dir)
        print(json.dumps(plan, indent=2, sort_keys=True))
        return 0

    summary = apply_backfill(tools_dir=tools_dir)
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
