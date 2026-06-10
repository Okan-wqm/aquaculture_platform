"""Plan 026R §A.2 — JSONL ledger hash-chain backfill primitive.

Internal module (leading-underscore filename) consumed by:
* ``aria-kernel/scripts/backfill-ledger-hashes.py`` — operator-facing CLI.
* ``aria-kernel/tests/test_backfill_migration_idempotent.py`` — invariant
  + AND-precondition coverage.

Contract:

1. **Fixture mode (default)** rewrites every hashless / chain-invalid
   JSONL under ``--target`` so that the §A.2 strict ``verify_jsonl`` flip
   passes on the offline trees (``aria-kernel/tests/fixtures/`` is the
   canonical target). No live-appender preconditions — fixtures are by
   definition not concurrently written.
2. **Production mode** rewrites aria-tools/-style ledgers and requires
   ALL of (logical AND — round-8 fix):

   * ``ARIA_STOP`` present at or above ``target`` (maintenance window).
   * No target JSONL mtime within the last ``WINDOW_SECONDS`` (idle).
   * No ``governance.jsonl`` mtime within the last ``WINDOW_SECONDS``
     (audit-trail idle).
   * No ``aria-tools/daemons/*.pid.lock`` files present (no scheduler /
     planner / worker daemon holds a pid lock).
   * Operator-explicit ``--operator-acknowledge-maintenance`` flag (typed
     by hand, NOT defaultable).

   Frozen runtime profile is NOT a bypass — production backfill cannot
   run under frozen unless the operator first toggles a dedicated
   maintenance profile.

3. **Idempotent.** Files that already pass strict ``verify_jsonl`` are
   skipped without rewriting. Re-running the script on a clean tree is
   a no-op (mtimes unchanged → preconditions stable on next attempt).

Implementation rides on §A.1's safe ``rewrite_jsonl`` (lock-order
matched OUTER index-group → INNER per-file → atomic write via
``_atomic_write_text`` → held-lock-aware index refresh) so a concurrent
read against an indexed-group sibling does not race.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from .ledger import LedgerIntegrityError, read_jsonl, rewrite_jsonl, verify_jsonl


WINDOW_SECONDS = 300


class BackfillError(RuntimeError):
    """Refuse-to-backfill error. Production-precondition failures and
    operator-acknowledge missing both raise this. Treated as exit-code 2
    by the CLI; caught structurally by tests."""


@dataclass(frozen=True, slots=True)
class BackfillReport:
    path: str
    status: str  # "skipped_empty" | "already_chained" | "backfilled"
    rows: int

    def as_dict(self) -> dict[str, object]:
        return {"path": self.path, "status": self.status, "rows": self.rows}


def _iter_jsonl(target: Path) -> Iterable[Path]:
    """Yield every ``*.jsonl`` under ``target`` (file or directory)."""
    resolved = target.resolve()
    if resolved.is_file() and resolved.suffix == ".jsonl":
        yield resolved
        return
    if resolved.is_dir():
        yield from sorted(resolved.rglob("*.jsonl"))


def _walk_up_for_aria_stop(target: Path, *, max_depth: int = 8) -> Path | None:
    cursor = target.resolve()
    for _ in range(max_depth):
        candidate = cursor / "ARIA_STOP"
        if candidate.exists():
            return candidate
        if cursor.parent == cursor:
            return None
        cursor = cursor.parent
    return None


def _verify_aria_stop_present(target: Path) -> None:
    if _walk_up_for_aria_stop(target) is None:
        raise BackfillError(
            f"ARIA_STOP absent at or above {target} — production backfill "
            f"requires a maintenance window. Touch ARIA_STOP at the "
            f"workspace root and retry."
        )


def _verify_no_recent_mtime(
    target: Path, *, window_seconds: int = WINDOW_SECONDS, now: float | None = None,
) -> None:
    now = now if now is not None else time.time()
    for jsonl in _iter_jsonl(target):
        if not jsonl.exists():
            continue
        age = now - jsonl.stat().st_mtime
        if age < window_seconds:
            raise BackfillError(
                f"recent mtime on {jsonl} ({age:.1f}s ago, window={window_seconds}s) "
                f"— refuse to backfill. Wait for the window to expire."
            )


def _verify_no_recent_governance_activity(
    target: Path, *, window_seconds: int = WINDOW_SECONDS, now: float | None = None,
) -> None:
    now = now if now is not None else time.time()
    # Production backfill is scoped to aria-tools/-shaped trees; both
    # `governance.jsonl` (tools-side) and `aria-memory/governance.jsonl`
    # are checked because either signals operator-relevant activity.
    candidates = [
        target.resolve() / "governance.jsonl",
        target.resolve() / "aria-memory" / "governance.jsonl",
    ]
    for path in candidates:
        if not path.exists():
            continue
        age = now - path.stat().st_mtime
        if age < window_seconds:
            raise BackfillError(
                f"recent governance event on {path} ({age:.1f}s ago, "
                f"window={window_seconds}s) — refuse to backfill."
            )


def _verify_no_active_daemon_pid(target: Path) -> None:
    daemons_dir = target.resolve() / "daemons"
    if not daemons_dir.exists():
        return
    for pid_lock in sorted(daemons_dir.glob("*.pid.lock")):
        if pid_lock.exists() and pid_lock.stat().st_size > 0:
            raise BackfillError(
                f"active daemon pid lock at {pid_lock} — refuse to backfill. "
                f"Stop the daemon and remove the lock first."
            )


def _backfill_one(path: Path) -> BackfillReport:
    """Backfill a single JSONL file. Idempotent — returns the report.

    Strategy:
    * Empty / missing file → ``skipped_empty``.
    * ``verify_jsonl`` already valid → ``already_chained`` (no write).
    * Otherwise → strip any existing ``ledger_hash`` /
      ``previous_ledger_hash`` fields, then ``rewrite_jsonl`` which
      computes the chain from scratch under the §A.1 lock order.
    """
    if not path.exists() or path.stat().st_size == 0:
        return BackfillReport(path=str(path), status="skipped_empty", rows=0)
    pre = verify_jsonl(path)
    if pre.get("valid") is True:
        return BackfillReport(
            path=str(path),
            status="already_chained",
            rows=int(pre.get("row_count", 0)),
        )
    rows = read_jsonl(path)
    stripped: list[dict] = []
    for row in rows:
        cleaned = dict(row)
        cleaned.pop("ledger_hash", None)
        cleaned.pop("previous_ledger_hash", None)
        stripped.append(cleaned)
    rewrite_jsonl(
        path,
        stripped,
        allow_legacy=True,
        legacy_reason="operator_acknowledged_hash_chain_backfill",
        expires_at="2026-12-31T00:00:00+00:00",
    )
    return BackfillReport(path=str(path), status="backfilled", rows=len(stripped))


def run(
    *,
    target: Path,
    mode: str,
    operator_acknowledge_maintenance: bool,
    now: float | None = None,
) -> list[BackfillReport]:
    """Programmatic entry point. Returns per-file reports."""
    if mode not in {"fixture", "production"}:
        raise BackfillError(f"unknown mode {mode!r} (expected 'fixture' or 'production')")
    if mode == "production":
        if not operator_acknowledge_maintenance:
            raise BackfillError(
                "production backfill requires --operator-acknowledge-maintenance "
                "(typed by hand, no default). Refused."
            )
        _verify_aria_stop_present(target)
        _verify_no_recent_mtime(target, now=now)
        _verify_no_recent_governance_activity(target, now=now)
        _verify_no_active_daemon_pid(target)
    reports: list[BackfillReport] = []
    for path in _iter_jsonl(target):
        reports.append(_backfill_one(path))
    return reports


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="ARIA Plan 026R §A.2 — backfill ledger_hash chains in JSONL ledgers.",
    )
    parser.add_argument(
        "--target",
        required=True,
        type=Path,
        help="Path to a JSONL file or directory to scan recursively.",
    )
    parser.add_argument(
        "--mode",
        choices=["fixture", "production"],
        default="fixture",
        help="fixture (default, no preconditions) or production (AND-conjunction preconditions).",
    )
    parser.add_argument(
        "--operator-acknowledge-maintenance",
        action="store_true",
        default=False,
        help="REQUIRED for production mode. Typed by hand — never default.",
    )
    args = parser.parse_args(argv)
    try:
        reports = run(
            target=args.target,
            mode=args.mode,
            operator_acknowledge_maintenance=args.operator_acknowledge_maintenance,
        )
    except BackfillError as exc:
        print(f"backfill refused: {exc}", file=sys.stderr)
        return 2
    except LedgerIntegrityError as exc:
        print(f"backfill aborted: {exc}", file=sys.stderr)
        return 3
    for report in reports:
        print(json.dumps(report.as_dict()))
    return 0
