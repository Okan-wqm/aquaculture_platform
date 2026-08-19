#!/usr/bin/env python3
"""SI-5 — the executor's last question: should the next cycle start now?

Prints one JSON line: {"dispatch": bool, "reason": str}. Exit status is
always 0 — a chain that cannot decide must not colour the drain that
earned its own verdict. The DECISION lives in
`aria_kernel.cycle_rhythm.evaluate_cycle_chain`; this file only gathers
the three facts that function needs and prints what it said.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_ROOT / "aria-kernel"))


def main() -> int:
    try:
        from aria_kernel.cycle_guard import _open_finding_count
        from aria_kernel.cycle_rhythm import evaluate_cycle_chain
        from aria_kernel.genesis_policy import rhythm_policy

        cap = int(rhythm_policy(_ROOT).get("backlog_cap") or 25)
        decision = evaluate_cycle_chain(
            last_cycle_started_at=os.environ.get("LAST_CYCLE_STARTED_AT") or None,
            now=datetime.now(timezone.utc),
            open_findings=_open_finding_count(_ROOT),
            backlog_cap=cap,
            drained=int(os.environ.get("DRAINED") or 0),
        )
        print(json.dumps(decision.as_dict()))
    except Exception as exc:  # noqa: BLE001 — a broken chain must not break the drain
        # Fail CLOSED and SAY SO: the cron still fires, so the cost of an
        # unreadable decision is one late cycle, never a stacked one.
        print(json.dumps({"dispatch": False, "reason": f"chain_undecidable:{type(exc).__name__}"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
