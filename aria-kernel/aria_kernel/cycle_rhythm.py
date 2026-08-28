"""SI-5 — ARIA owns its own rhythm; the cron becomes a safety net.

Measured over three nights: GitHub's scheduled trigger fires this repo
~60-75 minutes late and sometimes not at all (02:13, 02:19, 03:21 against
crons at 01:13/02:29), and the two ARIA lanes race each other inside one
concurrency group — on 2026-08-19 the cron cycle was evicted by a running
drain and two executor copies cancelled each other. ORPHAN-724 gave the
chain its forward edge (cycle → executor via `workflow_run`); the return
edge did not exist, so the pace of the whole loop was owned by a clock
ARIA cannot see.

This module is the DECISION, not the trigger: a pure function the
executor's last step consults. Keeping it here rather than in YAML is
what makes the rule testable and the refusals nameable — a chain that
decides in shell script is a chain nobody can prove terminates.

Termination is the load-bearing property. Three independent brakes, any
one of which stops the chain:

* a MINIMUM INTERVAL since the last cycle STARTED — the chain can never
  run cycles closer together than a human would schedule them, however
  fast the drain gets;
* the E25-a BACKLOG CEILING — the same counter the minting phases pause
  on, so a night that is already behind does not open more work;
* an EMPTY drain — if the executor found nothing to do, another cycle
  has nothing to feed it.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

# Four cycles a day is the ceiling this interval implies. It is not a
# performance number: it is the bound that makes a runaway chain
# impossible to write by accident. The nightly cron stays as the floor
# (it fires whether or not the chain ever decides to).
MIN_CYCLE_INTERVAL_HOURS: float = 6.0


@dataclass(frozen=True)
class ChainDecision:
    dispatch: bool
    reason: str

    def as_dict(self) -> dict[str, Any]:
        return {"dispatch": self.dispatch, "reason": self.reason}


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    text = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def evaluate_cycle_chain(
    *,
    last_cycle_started_at: str | None,
    now: datetime,
    open_findings: int,
    backlog_cap: int,
    drained: int,
    min_interval_hours: float = MIN_CYCLE_INTERVAL_HOURS,
) -> ChainDecision:
    """Decide whether a finished drain should start the next cycle.

    Every refusal is NAMED. A chain that declines silently is
    indistinguishable from a chain that is broken — the distinction this
    whole programme exists to preserve.
    """
    if drained <= 0:
        return ChainDecision(False, "drain_empty")
    if open_findings >= backlog_cap:
        return ChainDecision(False, "backlog_at_cap")
    started = _parse_ts(last_cycle_started_at)
    if started is None:
        # Unknown history fails CLOSED: the cron still runs, so refusing
        # here costs one delayed cycle, while dispatching on an unread
        # clock could stack cycles on top of each other.
        return ChainDecision(False, "last_cycle_time_unknown")
    age = now - started
    if age < timedelta(hours=min_interval_hours):
        return ChainDecision(
            False,
            f"min_interval_not_elapsed:{age.total_seconds() / 3600:.1f}h",
        )
    return ChainDecision(True, "chain_ready")
