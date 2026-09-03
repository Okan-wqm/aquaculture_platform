"""Plan 020 Phase 9.A — backfill validated chains for Plan 019 historical commits.

WHY this script exists
----------------------
Plan 019 phases 0-10 produced ~14 change_planned + change_committed events
without matching change_validated rows. Plan 020 introduces a hard rule that
every committed chain must close with change_validated; legacy chains
otherwise inflate the change_chain_stale counter forever.

Backfill strategy
-----------------
For every change_committed row that has NO matching change_validated row,
emit change_validated with validation_mode='historical_attestation'. The
mode signals to Phase 9's aria_change_chain_validation_pct metric that the
row is audit-trail-only — it does NOT count toward the validated/committed
ratio numerator. The validation_run_refs payload gets a synthetic string
ref ('historical-attestation:plan-019-backfill') so the legacy refs surface
in audit logs without claiming run-pass-layer evidence the matrix gate
would have demanded under enforced mode.

Idempotence
-----------
The script reads existing validated.jsonl rows; skips any change_id already
validated. Re-running is safe + cheap.

Operator workflow
-----------------
  PYTHONPATH=aria-kernel python3 tools/aria-poc/backfill_validated_chains.py \
      --tools-dir aria-tools [--dry-run]

Run AFTER landing Plan 020 Phase 9 (this script + the change_chain_stale
governance event). Without the matrix gate, the script would ship
historical commits as if they had passed enforced validation — that is
exactly the audit confusion Phase 9's validation_mode field prevents.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "aria-kernel"))

from aria_kernel.change_ledger import emit_change_validated
from aria_kernel.ledger import load_jsonl
from aria_kernel.tool_registry import GovernanceError


def _committed_path(tools_dir: Path) -> Path:
    return tools_dir / "change-ledger" / "committed.jsonl"


def _validated_path(tools_dir: Path) -> Path:
    return tools_dir / "change-ledger" / "validated.jsonl"


def find_unvalidated_chains(tools_dir: Path) -> list[dict]:
    committed = load_jsonl(_committed_path(tools_dir))
    validated = load_jsonl(_validated_path(tools_dir))
    validated_ids = {row.get("change_id") for row in validated if row.get("change_id")}
    return [
        row for row in committed
        if row.get("change_id") and row["change_id"] not in validated_ids
    ]


def backfill(tools_dir: Path, *, dry_run: bool) -> dict:
    unvalidated = find_unvalidated_chains(tools_dir)
    backfilled: list[dict] = []
    failed: list[dict] = []
    for committed_row in unvalidated:
        change_id = committed_row["change_id"]
        if dry_run:
            backfilled.append({"change_id": change_id, "dry_run": True})
            continue
        try:
            row = emit_change_validated(
                change_id=change_id,
                validation_run_refs=["historical-attestation:plan-019-backfill"],
                base_dir=tools_dir,
                validation_mode="historical_attestation",
                enforce_validation_matrix=True,  # historical_attestation bypasses the gate
            )
            backfilled.append({"change_id": change_id, "validated_at": row.get("recorded_at")})
        except GovernanceError as exc:
            failed.append({"change_id": change_id, "error": str(exc)})
    return {
        "tools_dir": str(tools_dir),
        "unvalidated_count": len(unvalidated),
        "backfilled_count": len(backfilled),
        "failed_count": len(failed),
        "backfilled": backfilled,
        "failed": failed,
        "dry_run": dry_run,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="backfill-validated-chains")
    parser.add_argument("--tools-dir", default="aria-tools",
                        help="Path to aria-tools directory.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Report what would be backfilled without writing.")
    args = parser.parse_args(argv)
    summary = backfill(Path(args.tools_dir), dry_run=args.dry_run)
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0 if summary["failed_count"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
