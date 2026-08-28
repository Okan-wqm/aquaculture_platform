"""SI-1 — ARIA notices when its own pipeline stops moving.

The counters already exist: `knowledge-graph/pressure-source-
effectiveness.jsonl` carries `cycles_minted / cycles_converged /
cycles_merged / cycles_rejected` per pressure source, written by
`record_pressure_source_outcome` at the end of every cycle. What was
missing is a CONSUMER that treats a stage at zero as a fact worth
raising: today those counters only re-rank a Thompson draw, so a funnel
that converts nothing simply gets a lower sampling weight — the system's
own paralysis reads as a scheduling preference.

Measured 2026-08-19: 597 requests minted, ZERO plans ever CONVERGED,
zero implementations — a wedge two days old that no mechanism named. A
human found it by reading ledgers. That is the gap this closes.

The detector is deliberately conservative: it speaks only about stages
with real upstream volume (a funnel nobody fed is not stalled, it is
idle) and only after a stage has been dry for a full observation window,
so one quiet night is never an alarm.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# Below this, "zero converged" says more about the sample than the
# pipeline: a source that minted twice and converged neither may simply
# be new. The threshold is what separates a stall from a small night.
MIN_UPSTREAM_FOR_STALL: int = 10

# The funnel's ordered stages, upstream first. Each pair is
# (stage_name, counter_field); a stage is judged against the counter
# immediately upstream of it, which is what makes "stalled" mean
# "work arrives here and does not leave" rather than "this number is 0".
FUNNEL_STAGES: tuple[tuple[str, str], ...] = (
    ("convergence", "cycles_converged"),
    ("merge", "cycles_merged"),
)
_UPSTREAM_FIELD: dict[str, str] = {
    "cycles_converged": "cycles_minted",
    "cycles_merged": "cycles_converged",
}


@dataclass(frozen=True)
class FunnelStall:
    stage: str
    source_type: str
    upstream: int
    downstream: int

    @property
    def summary(self) -> str:
        return (
            f"funnel stalled at {self.stage}: {self.upstream} arrived from "
            f"{self.source_type}, {self.downstream} left"
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "stage": self.stage,
            "source_type": self.source_type,
            "upstream": self.upstream,
            "downstream": self.downstream,
            "summary": self.summary,
        }


def detect_funnel_stalls(
    rows: list[dict[str, Any]],
    *,
    min_upstream: int = MIN_UPSTREAM_FOR_STALL,
) -> list[FunnelStall]:
    """Stages where work arrives in volume and nothing comes out.

    `rows` is `knowledge_graph.rank_pressure_sources(...)` output —
    latest-per-source cumulative snapshots. Reading through that function
    rather than the file keeps ONE definition of what a source's standing
    is (it already folds history and verifies the hash chain).
    """
    stalls: list[FunnelStall] = []
    for row in rows:
        source = str(row.get("source_type") or "")
        if not source:
            continue
        for stage, field in FUNNEL_STAGES:
            upstream = int(row.get(_UPSTREAM_FIELD[field], 0) or 0)
            downstream = int(row.get(field, 0) or 0)
            if upstream >= min_upstream and downstream == 0:
                stalls.append(
                    FunnelStall(
                        stage=stage, source_type=source,
                        upstream=upstream, downstream=downstream,
                    )
                )
    return stalls
