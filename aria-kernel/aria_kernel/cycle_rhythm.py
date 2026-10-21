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
* the E25-a BACKLOG CEILING — the closable-backlog count the finding
  openers are throttled on (wall #7: ``cycle_guard.backlog_census``), so a
  night that is already behind does not open more work;
* an EMPTY drain — if the executor found nothing to do, another cycle
  has nothing to feed it.
"""
from __future__ import annotations

from collections.abc import Collection
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


def parse_iso_timestamp(value: str | None) -> datetime | None:
    """One ISO-8601 parser for the rhythm's own edges and the drain's
    mid-drain mint comparison (ARIA-MEDIUM-398): both read the queue's
    ``created_at``, so both must read it the same way."""
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
    started = parse_iso_timestamp(last_cycle_started_at)
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


def evaluate_drain_rechain(
    *,
    window_skipped_self_minted: Collection[str],
    already_rechained_request_ids: Collection[str],
    dispatched_as_rechain: bool,
) -> ChainDecision:
    """Decide whether a finished drain should chain ONE more drain run.

    ARIA-MEDIUM-398 — an implementation request minted DURING a drain and
    then window-skipped (its whole worst case does not fit the remaining
    window) used to wait for the next cycle's executor: the only outbound
    edge was ``chain-next-cycle``, so work the drain itself had just
    produced sat PENDING for a full cycle (AIR-aria-implementer-9f5893f12678:
    minted 07:41Z, skipped with 16659 s of window left, still waiting while
    the chained cycle ran at 09:07Z). The rule this enforces is the
    finding's own bound: such a request is taken by the next fresh executor
    run — ONE direct drain hop, one re-chain per minted request.

    Termination, in the order the brakes bind:

    * a run dispatched AS the re-chain never re-chains again — one drain
      hop before the cycle edge, so there is no drain→drain loop to write
      by accident (the re-chained run still takes the normal cycle edge);
    * no self-minted window skip means the ordinary cycle edge applies;
    * a request the re-chain ledger already names has had its one hop.
    """
    if dispatched_as_rechain:
        return ChainDecision(False, "rechain_depth_exhausted")
    if not window_skipped_self_minted:
        return ChainDecision(False, "no_self_minted_window_skip")
    rechained = set(already_rechained_request_ids)
    if not any(request_id not in rechained for request_id in window_skipped_self_minted):
        return ChainDecision(False, "already_rechained")
    return ChainDecision(True, "rechain_ready")
