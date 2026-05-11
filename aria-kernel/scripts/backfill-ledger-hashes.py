#!/usr/bin/env python3
"""ARIA Plan 026R §A.2 — JSONL ledger hash-chain backfill CLI.

Thin CLI wrapper over ``aria_kernel._backfill.main`` so the logic stays
unit-testable as a regular module while the script remains the operator
entry point per the §A.2 plan deliverable list.

USAGE — see ``aria_kernel._backfill`` docstring for the full contract.

Quick reference:

  # Offline fixture backfill (default — no preconditions).
  python3 aria-kernel/scripts/backfill-ledger-hashes.py \\
      --target aria-kernel/tests/fixtures

  # Production backfill (AND-conjunction preconditions — refuses unless
  # ALL of ARIA_STOP + no-recent-mtime + no-recent-governance +
  # no-daemon-pid + --operator-acknowledge-maintenance hold).
  python3 aria-kernel/scripts/backfill-ledger-hashes.py \\
      --target aria-tools \\
      --mode production \\
      --operator-acknowledge-maintenance
"""
from __future__ import annotations

import sys
from pathlib import Path


def _ensure_aria_kernel_importable() -> None:
    here = Path(__file__).resolve()
    aria_kernel_dir = here.parent.parent  # aria-kernel/
    if str(aria_kernel_dir) not in sys.path:
        sys.path.insert(0, str(aria_kernel_dir))


if __name__ == "__main__":
    _ensure_aria_kernel_importable()
    from aria_kernel._backfill import main

    sys.exit(main(sys.argv[1:]))
