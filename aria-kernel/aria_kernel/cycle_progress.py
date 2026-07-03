"""Live cycle-progress emitter (``ARIA_CYCLE_PROGRESS`` / ``cycle run --progress``).

A cycle is otherwise a black box: it computes every phase in memory and writes
its ledgers atomically at the END, so an operator watching a long run sees
nothing (no governance rows, no stderr) until it finishes and dumps the final
JSON envelope on stdout. When progress is enabled, the kernel emits one
structured JSON line per phase boundary to STDERR, flushed immediately, so
``tail -f`` / a Monitor watch shows ARIA work live. Stdout still carries ONLY
the final envelope — operators can pipe ``2>`` to a log without corrupting the
machine-readable result.

Default OFF → zero behaviour change. The emitter NEVER raises: progress logging
must not be able to break a cycle.
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from typing import Any

PROGRESS_ENV_VAR = "ARIA_CYCLE_PROGRESS"

_TRUTHY = {"1", "true", "yes", "on"}


def progress_enabled() -> bool:
    return os.environ.get(PROGRESS_ENV_VAR, "").strip().lower() in _TRUTHY


def emit_progress(step: str, **fields: Any) -> None:
    """Write one ``{"aria_progress": <step>, ...}`` line to stderr (flushed) when
    progress is enabled. A no-op (and exception-proof) otherwise."""
    if not progress_enabled():
        return
    try:
        line: dict[str, Any] = {
            "aria_progress": step,
            "at": datetime.now(timezone.utc).isoformat(),
            "monotonic_ms": int(time.monotonic() * 1000),
        }
        line.update(fields)
        sys.stderr.write(json.dumps(line, sort_keys=True) + "\n")
        sys.stderr.flush()
    except Exception:
        # Progress logging is observability, never a failure surface.
        pass


__all__ = ["PROGRESS_ENV_VAR", "progress_enabled", "emit_progress"]
