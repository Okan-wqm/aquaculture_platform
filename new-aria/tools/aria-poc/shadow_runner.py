"""Minimal SHADOW-phase adapter shim for ARIA end-to-end smoke runs.

Reads the cycle's input payload from stdin, then emits a tool-output JSON that
satisfies the registry's output_schema (observations / findings / read_paths /
evidence_sources). It does not mutate the workspace and produces zero findings,
so SHADOW runs leave the operator-facing surface untouched while still
exercising the runner contract end to end.
"""
from __future__ import annotations

import json
import sys


def main() -> int:
    adapter = sys.argv[1] if len(sys.argv) > 1 else "shadow-stub"
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        payload = {}
    cycle_id = payload.get("cycle_id", "unknown-cycle")
    body = {
        "observations": [
            {
                "observation_id": f"obs:{adapter}:noop:{cycle_id}",
                "summary": f"{adapter} executed in SHADOW with no findings",
                "severity": "info",
            }
        ],
        "findings": [],
        "read_paths": [],
        "evidence_sources": [],
        "cost_units": 1,
        "metadata": {"adapter": adapter, "phase": "shadow"},
    }
    sys.stdout.write(json.dumps(body))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
