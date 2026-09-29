"""G-4 — the fourth event of the change chain: did the change WORK?

MEASURED (2026-08-20). ``change_ledger`` ends at planned → committed →
validated. All three events are about the ACT of changing: what was
intended, what landed, what ran against it. None is about the RESULT.
So ARIA could state, with a hash chain behind it, that a change landed
and was validated — and could never state whether the benefit that
change claimed ever materialised. The regression strip E21-d built has
fired zero times in production (zero ``finding_reproduced`` rows), so
the only organ that could have noticed a merged fix failing was also
the organ nobody was reading.

WHAT THIS ADDS. A FOURTH append-only event on the SAME chain, keyed by
the same ``change_id``, stored beside its three siblings as
``aria-tools/change-ledger/outcome.jsonl``, plus a nightly cycle phase
(``change_outcome_evaluation``) that emits it N nights after the change
MERGED. Sequence invariant, exactly like the three before it:
``change_outcome`` requires an existing ``change_validated``.

THE RULE THAT MAKES THE EVENT WORTH HAVING. The verdict is RECOMPUTED
FROM THE LEDGERS. Not one field of it comes from what the proposal, the
plan, or the commit message asserted about the benefit — a system that
graded its own homework from its own claim would produce a ledger of
confirmations and learn nothing. The metric registry below is the
enforcement point: a resolver declares WHICH ledger surfaces its reading
was computed from, and ``emit_change_outcome`` refuses any reading whose
sources are not in ``LEDGER_EVIDENCE_SOURCES`` — the four surfaces that
record an EXECUTION or an EVENT AFTER the fact. ``proposals`` is a
declared ledger too, and it is precisely what must never be admissible
here.

FOUR VERDICTS, and why ``unknown`` is a first-class one:

  * ``gain_confirmed`` — a ledger-backed metric says the benefit holds.
  * ``no_gain``        — the defect the change claimed to remove is
                         still being recorded after the merge.
  * ``regression``     — CONSUMED from the EXISTING
                         ``experiment_regression_detected`` governance
                         event. This module adds NO second detector:
                         one detector, one event, two readers.
  * ``unknown``        — no metric could be computed. Most changes land
                         here today, and that is the honest reading of a
                         repository whose bench has never re-run: a
                         score a system can improve by looking away is
                         worse than no score.

The aggregate lands in ``cycles_rejected`` — the column after
``cycles_merged`` in ``knowledge-graph/pressure-source-effectiveness
.jsonl`` — through the EXISTING writer ``record_pressure_source_outcome``.
A merged change that produced no gain retroactively becomes a rejected
cycle for its pressure source, so the Thompson bandit downstream stops
treating "it merged" as the terminal definition of success. Nothing is
written for ``gain_confirmed`` (the merge was already counted) and
nothing for ``unknown`` (absence of evidence is not evidence).
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from .budget import _parse_instant, read_cost_attribution
from .change_ledger import (
    CHANGE_RECORD_SCHEMA,
    _find_committed,
    _find_planned,
    _find_validated_for_change,
    _ledger_dir,
)
from .ledger import append_declared_jsonl, load_declared_jsonl
from .state_manifest import iter_surfaces
from .tool_registry import (
    GovernanceError,
    append_tools_governance,
    ensure_tools_dir,
    utc_now,
)

# The verdicts, in precedence order. A change with two readings that
# disagree resolves to the WORST one that any ledger supports: a green
# re-run does not cancel a recorded regression, and neither cancels the
# defect still being observed.
OUTCOME_VERDICTS: tuple[str, ...] = (
    "regression", "no_gain", "gain_confirmed", "unknown",
)

# What one metric can say. ``regression`` is reachable ONLY by reading
# the existing detector's event (see _metric_finding_recurrence).
METRIC_SIGNALS: tuple[str, ...] = ("regression", "no_gain", "gain", "unavailable")

_SIGNAL_VERDICT: dict[str, str] = {
    "regression": "regression",
    "no_gain": "no_gain",
    "gain": "gain_confirmed",
}

# How long after the merge the question is worth asking. The bench's
# regression lane re-runs at most MAX_REGRESSION_RERUNS_PER_NIGHT (3)
# bindings a night, so a binding in a backlog may sit out a night or
# two; asking on night one would grade the queue rather than the change.
OUTCOME_EVALUATION_NIGHTS: int = 3

# Per-night evaluation budget. Disclosed in the phase payload, never
# silent — the same discipline the experiment night uses for its lanes.
MAX_OUTCOME_EVALUATIONS_PER_NIGHT: int = 10

# The ONLY surfaces a benefit metric may be computed from: each records
# an execution or an event that happened AFTER the change landed.
# ``proposals``/plan content are declared ledgers as well and are
# deliberately absent — a claim about a benefit is not a measurement of
# it, which is the whole point of this module.
LEDGER_EVIDENCE_SOURCES: frozenset[str] = frozenset({
    "repo_finding_events",       # what the finding ledger recorded after the merge
    "tools_governance",          # the regression detector's own event
    "experiment_observations",   # executed re-runs of a bound recipe
    "validation_runs",           # executed commands with unforgeable provenance
})


def _assert_evidence_sources_are_declared_ledgers() -> None:
    """Import-time: every admissible source names a real ledger surface.

    Derived from the state manifest rather than written twice — an
    admissible source that does not exist would make the refusal above
    unfalsifiable (it would refuse a name nothing could ever produce).
    """
    ledgers = {s.name for s in iter_surfaces() if s.state_class == "ledger"}
    unknown = sorted(LEDGER_EVIDENCE_SOURCES - ledgers)
    if unknown:
        raise GovernanceError(
            f"change_outcome_evidence_source_not_a_declared_ledger: {unknown}"
        )


_assert_evidence_sources_are_declared_ledgers()


@dataclass(frozen=True)
class MetricReading:
    """One benefit metric, recomputed from ledgers.

    ``evidence_sources`` is the load-bearing field: it is what
    ``emit_change_outcome`` checks before it will write a verdict, so a
    metric that reads the change's own proposal cannot reach the ledger
    even if its arithmetic looks convincing.
    """

    metric_id: str
    signal: str
    evidence_sources: tuple[str, ...]
    evidence_refs: tuple[str, ...]
    observed: dict[str, Any]
    reason: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "metric_id": self.metric_id,
            "signal": self.signal,
            "evidence_sources": list(self.evidence_sources),
            "evidence_refs": list(self.evidence_refs),
            "observed": dict(self.observed),
            "reason": self.reason,
        }


@dataclass(frozen=True)
class EvaluationContext:
    """Everything a resolver may look at — all of it a ledger locator."""

    change_id: str
    finding_id: str
    plan_id: str
    commit_sha: str
    merged_at: datetime
    evaluated_at: datetime
    repo_root: Path
    tools_root: Path


_ASSESSMENT_SCHEMA = "aria/change-assessment/v1"
_ASSESSMENT_EVALUATOR_VERSION = 1
_ASSESSMENT_CAPTURE_BYTES = 16 * 1024 * 1024
_ASSESSMENT_CAPTURE_ROWS = 20_000


@dataclass(frozen=True)
class _AssessmentCapture(EvaluationContext):
    """An in-memory hot capture, never a claim of retained-prefix durability.

    Native bytes and verified row content are immutable. Metric evaluation
    decodes the latter without reopening source files or resolving old paths.
    """

    _native_sources: tuple[tuple[str, bytes | None], ...]
    _verified_sources: tuple[tuple[str, bytes], ...]
    _metadata: bytes

    def _rows(self, source: str) -> list[dict[str, Any]]:
        for name, content in self._verified_sources:
            if name == source:
                return json.loads(content)
        raise GovernanceError(f"change_assessment_source_not_captured: {source}")


def _classify_outcome_rows(
    rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Separate the two native event kinds without inventing legacy shapes."""
    outcomes: list[dict[str, Any]] = []
    assessments: list[dict[str, Any]] = []
    predecessors: dict[str, str] = {}
    for row in rows:
        if (type(row.get("schema_version")) is not int
                or row["schema_version"] != 1
                or row.get("verdict") not in OUTCOME_VERDICTS):
            raise GovernanceError("change_outcome_event_unavailable")
        if row.get("event") == "change_outcome" and row.get("$schema") == CHANGE_RECORD_SCHEMA:
            outcomes.append(row)
        elif row.get("event") == "change_assessment" and row.get("$schema") == _ASSESSMENT_SCHEMA:
            stream = row.get("stream_id")
            assessment_id = row.get("assessment_id")
            if (not isinstance(stream, str) or not stream
                    or not isinstance(assessment_id, str) or not assessment_id
                    or row.get("predecessor_assessment_id") != predecessors.get(stream)):
                raise GovernanceError("change_assessment_history_unavailable")
            predecessors[stream] = assessment_id
            assessments.append(row)
        else:
            raise GovernanceError("change_outcome_event_unavailable")
    return outcomes, assessments


def _outcome_path(tools_root: Path) -> Path:
    return _ledger_dir(tools_root) / "outcome.jsonl"


# ---------------------------- metrics ----------------------------


def _metric_finding_recurrence(ctx: EvaluationContext) -> MetricReading:
    """Did the defect the change named come back after the merge?

    Three ledger facts, none of them the change's own claim:

      * an ``experiment_regression_detected`` governance row naming the
        finding after the merge → ``regression``. The detector already
        exists (experiment_night's regression lane); this READS it. A
        second detector would be a second answer to one question.
      * a ``finding_reproduced`` event after the merge → ``no_gain``:
        the defect still runs red on its own recipe.
      * a ``finding_fix_verified`` event after the merge → ``gain``.
    """
    # The FULL forward read, not the bounded reverse one: a verdict that
    # depends on how many governance rows happened to be written since is
    # not reproducible, and reproducibility is the property this whole
    # event exists to have. The bounded reader is the right tool for a
    # "recent weather" question; this one asks about a fixed window.
    regressions: list[str] = []
    captured = isinstance(ctx, _AssessmentCapture)
    if captured:
        governance_rows = ctx._rows("tools_governance")
    else:
        from .governance_reader import read_governance_rows

        governance_rows = read_governance_rows(ctx.tools_root / "governance.jsonl")
    for row in governance_rows:
        if row.get("kind") != "experiment_regression_detected":
            continue
        details = row.get("details") or {}
        if str(details.get("finding_id") or "") != ctx.finding_id:
            continue
        ts = _parse_instant(str(row.get("ts") or ""))
        if ts is not None and ts > ctx.merged_at and (not captured or ts <= ctx.evaluated_at):
            regressions.append(str(row.get("event_id") or ""))

    reproduced: list[str] = []
    verified: list[str] = []
    if captured:
        finding_rows = ctx._rows("repo_finding_events")
    else:
        events_path = _finding_events_path(ctx.repo_root)
        finding_rows = (load_declared_jsonl(events_path, expected_surface="repo_finding_events")
                        if events_path.exists() else [])
    if finding_rows:
        for row in finding_rows:
            if str(row.get("finding_id") or "") != ctx.finding_id:
                continue
            ts = _parse_instant(str(row.get("recorded_at") or ""))
            if ts is None or ts <= ctx.merged_at or (captured and ts > ctx.evaluated_at):
                continue
            if row.get("event") == "finding_reproduced":
                reproduced.append(str(row.get("event_id") or ""))
            elif row.get("event") == "finding_fix_verified":
                verified.append(str(row.get("event_id") or ""))

    observed = {
        "regression_events": len(regressions),
        "reproduced_events": len(reproduced),
        "fix_verified_events": len(verified),
    }
    sources = ("tools_governance", "repo_finding_events")
    if regressions:
        return MetricReading(
            metric_id="finding_recurrence", signal="regression",
            evidence_sources=sources, evidence_refs=tuple(regressions),
            observed=observed,
            reason="experiment_regression_detected after the merge",
        )
    if reproduced:
        return MetricReading(
            metric_id="finding_recurrence", signal="no_gain",
            evidence_sources=sources, evidence_refs=tuple(reproduced),
            observed=observed,
            reason="the finding still reproduces after the merge",
        )
    if verified:
        return MetricReading(
            metric_id="finding_recurrence", signal="gain",
            evidence_sources=sources, evidence_refs=tuple(verified),
            observed=observed,
            reason="the finding's recipe verified green after the merge",
        )
    return MetricReading(
        metric_id="finding_recurrence", signal="unavailable",
        evidence_sources=sources, evidence_refs=(),
        observed=observed,
        reason="no post-merge finding event for this change's finding",
    )


def _metric_experiment_rerun_hold(ctx: EvaluationContext) -> MetricReading:
    """Does the change's own experiment still run the way it did?

    Only ONE signal is reachable from here: ``gain``, on a matched green
    re-run bound to this change_id after the merge. A red re-run is NOT
    read as a regression by this metric — that verdict belongs to the
    detector that already emits ``experiment_regression_detected``, and
    a red run this metric could not tie to that event is recorded as
    ``unavailable`` with the reason, never rounded to a verdict.
    """
    green: list[str] = []
    not_green: list[str] = []
    captured = isinstance(ctx, _AssessmentCapture)
    if captured:
        observations = ctx._rows("experiment_observations")
    else:
        from .experiment import list_experiment_observations

        observations = list_experiment_observations(base_dir=ctx.tools_root)
    for row in observations:
        if str(row.get("change_id") or "") != ctx.change_id:
            continue
        ts = _parse_instant(str(row.get("recorded_at") or ""))
        if ts is None or ts <= ctx.merged_at or (captured and ts > ctx.evaluated_at):
            continue
        run_id = str(row.get("validation_run_id") or "")
        if row.get("matched") is True and row.get("run_status") == "ok":
            green.append(run_id)
        else:
            not_green.append(run_id)

    observed = {"post_merge_green_reruns": len(green),
                "post_merge_other_reruns": len(not_green)}
    sources = ("experiment_observations",)
    if not_green:
        return MetricReading(
            metric_id="experiment_rerun_hold", signal="unavailable",
            evidence_sources=sources, evidence_refs=tuple(not_green),
            observed=observed,
            reason=(
                "a post-merge re-run was not green; the regression "
                "detector owns that verdict, this metric does not guess"
            ),
        )
    if green:
        return MetricReading(
            metric_id="experiment_rerun_hold", signal="gain",
            evidence_sources=sources, evidence_refs=tuple(green),
            observed=observed,
            reason="the change's experiment re-ran green after the merge",
        )
    return MetricReading(
        metric_id="experiment_rerun_hold", signal="unavailable",
        evidence_sources=sources, evidence_refs=(),
        observed=observed,
        reason="no post-merge re-run bound to this change",
    )


# The registry. Adding a metric is adding a resolver here — and the
# emit-time evidence check is what stops the next one from being the
# proposal's own claim wearing a metric's name.
BENEFIT_METRICS: dict[str, Callable[[EvaluationContext], MetricReading]] = {
    "finding_recurrence": _metric_finding_recurrence,
    "experiment_rerun_hold": _metric_experiment_rerun_hold,
}


def fold_outcome_verdict(readings: list[MetricReading]) -> str:
    """Worst supported verdict wins; nothing supported → ``unknown``."""
    verdicts = {
        _SIGNAL_VERDICT[r.signal] for r in readings if r.signal in _SIGNAL_VERDICT
    }
    for verdict in OUTCOME_VERDICTS:
        if verdict in verdicts:
            return verdict
    return "unknown"


def _metric_readings(ctx: EvaluationContext) -> list[MetricReading]:
    """The existing signal/source checks, shared by original and later results."""
    readings = [resolver(ctx) for _, resolver in sorted(BENEFIT_METRICS.items())]
    for reading in readings:
        if reading.signal not in METRIC_SIGNALS:
            raise GovernanceError(
                f"change_outcome_unknown_metric_signal: metric "
                f"{reading.metric_id!r} returned {reading.signal!r}; the "
                f"vocabulary {METRIC_SIGNALS} is closed"
            )
        illegitimate = sorted(set(reading.evidence_sources) - LEDGER_EVIDENCE_SOURCES)
        if illegitimate or not reading.evidence_sources:
            raise GovernanceError(
                f"outcome_from_proposal_claim_refused: metric "
                f"{reading.metric_id!r} declares evidence sources "
                f"{illegitimate or list(reading.evidence_sources)} — an "
                f"outcome may only be computed from a ledger that recorded "
                f"what HAPPENED after the merge "
                f"({sorted(LEDGER_EVIDENCE_SOURCES)}), never from what the "
                f"proposal claimed the change would do"
            )
    return readings


# ---------------------------- recompute ----------------------------


def _finding_events_path(repo_root: Path) -> Path:
    from .finding import findings_dir

    return findings_dir(repo_root) / "finding-events.jsonl"


def _merge_index(tools_root: Path) -> dict[str, dict[str, Any]]:
    """change_id → its latest ``merged`` row, from ``pr-lifecycle.jsonl``.

    The ``merged`` row carries the PR number; the ``change_id`` anchor
    lands on the row the PR OPEN wrote (pr_manager §D.3). So the join is
    change → pr_number → merged row, which is the same ledger
    ``auto_merge.change_for_pr`` reads in the opposite direction.

    Built as an INDEX in one pass because the nightly selection asks the
    question once per validated chain: a per-change scan would re-read
    the whole PR ledger for every chain ARIA has ever validated.
    """
    path = tools_root / "pr-lifecycle.jsonl"
    if not path.exists():
        return {}
    rows = load_declared_jsonl(path, expected_surface="pr_lifecycle")
    changes_by_pr: dict[Any, set[str]] = {}
    for row in rows:
        change_id = row.get("change_id")
        pr_number = row.get("pr_number")
        if isinstance(change_id, str) and change_id and pr_number is not None:
            changes_by_pr.setdefault(pr_number, set()).add(change_id)
    index: dict[str, dict[str, Any]] = {}
    for row in rows:
        if row.get("event") != "merged":
            continue
        for change_id in changes_by_pr.get(row.get("pr_number"), set()):
            index[change_id] = row  # later merged row wins
    return index


def _merge_record_for_change(
    tools_root: Path, change_id: str,
) -> dict[str, Any] | None:
    """The merge anchor for ONE change — the index, keyed."""
    return _merge_index(tools_root).get(change_id)


def _inputs_digest(payload: dict[str, Any] | list[Any]) -> str:
    serialized = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return "sha256:" + hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def recompute_change_outcome(
    *,
    change_id: str,
    repo_root: str | Path,
    base_dir: str | Path | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """The verdict, derived from ledgers and nothing else.

    Pure read: emits no row and mutates no counter, so an operator (or a
    test, or a second machine) can re-derive any recorded outcome from
    the same ledgers and compare digests. That property is what makes
    the stored verdict falsifiable rather than merely stored.
    """
    tools_root = ensure_tools_dir(base_dir)
    repo_path = Path(repo_root).resolve()
    evaluated_at = now or datetime.now(timezone.utc)

    planned = _find_planned(tools_root, change_id)
    committed = _find_committed(tools_root, change_id)
    validated = _find_validated_for_change(tools_root, change_id)
    if planned is None or committed is None:
        raise GovernanceError(
            f"change_outcome sequence violation: no change_committed for {change_id!r}"
        )
    if validated is None:
        raise GovernanceError(
            f"change_outcome sequence violation: no change_validated for {change_id!r}"
        )

    merge_row = _merge_record_for_change(tools_root, change_id)
    if merge_row is None:
        raise GovernanceError(
            f"change_outcome_requires_merged_change: {change_id!r} has no "
            f"merged pr-lifecycle row; an outcome is a statement about a "
            f"change that reached main, not about one that might"
        )
    merged_at = _parse_instant(str(merge_row.get("recorded_at") or ""))
    if merged_at is None:
        raise GovernanceError(
            f"change_outcome_merge_anchor_unreadable: merged row for "
            f"{change_id!r} carries no parseable recorded_at"
        )

    ctx = EvaluationContext(
        change_id=change_id,
        finding_id=str(planned.get("finding_id") or ""),
        plan_id=str(planned.get("plan_id") or ""),
        commit_sha=str(committed.get("commit_sha") or ""),
        merged_at=merged_at,
        evaluated_at=evaluated_at,
        repo_root=repo_path,
        tools_root=tools_root,
    )
    readings = _metric_readings(ctx)

    verdict = fold_outcome_verdict(readings)
    nights_since_merge = (evaluated_at - merged_at) / timedelta(days=1)
    inputs = {
        "change_id": change_id,
        "commit_sha": ctx.commit_sha,
        "finding_id": ctx.finding_id,
        "merged_at": merged_at.astimezone(timezone.utc).isoformat(),
        "readings": [r.as_dict() for r in readings],
    }
    return {
        "change_id": change_id,
        "verdict": verdict,
        "readings": [r.as_dict() for r in readings],
        "merged_at": inputs["merged_at"],
        "merged_pr_number": merge_row.get("pr_number"),
        "nights_since_merge": round(nights_since_merge, 3),
        "plan_id": ctx.plan_id,
        "finding_id": ctx.finding_id,
        "commit_sha": ctx.commit_sha,
        "inputs_digest": _inputs_digest(inputs),
    }


# ---------------------------- emit ----------------------------


def find_change_outcome(
    tools_root: Path, change_id: str,
) -> dict[str, Any] | None:
    path = _outcome_path(tools_root)
    if not path.exists():
        return None
    outcomes, _assessments = _classify_outcome_rows(
        load_declared_jsonl(path, expected_surface="change_outcome"),
    )
    for row in outcomes:
        if row.get("change_id") == change_id:
            return row
    return None


def list_change_outcomes(
    *, base_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    path = _outcome_path(ensure_tools_dir(base_dir))
    if not path.exists():
        return []
    outcomes, _assessments = _classify_outcome_rows(
        load_declared_jsonl(path, expected_surface="change_outcome"),
    )
    return outcomes


def _pressure_source_for_plan(
    plan_id: str, *, base_dir: str | Path | None,
) -> str | None:
    """Which pressure source paid for this plan — from the cost ledger.

    ``cost-attribution`` rows carry ``{plan_id, cycle_id,
    pressure_source_type}`` on every LLM invocation, which is the one
    place the plan and its source already meet in a ledger. When the
    join finds nothing the aggregate is SKIPPED and the row says so; a
    default source would file this change's outcome against a source
    that never produced it.
    """
    resolved: str | None = None
    for row in read_cost_attribution(base_dir=base_dir):
        if str(row.get("plan_id") or "") != plan_id:
            continue
        source = row.get("pressure_source_type")
        if isinstance(source, str) and source:
            resolved = source
    return resolved


def emit_change_outcome(
    *,
    change_id: str,
    repo_root: str | Path,
    base_dir: str | Path | None = None,
    nights: int = OUTCOME_EVALUATION_NIGHTS,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Close the chain with what the ledgers say the change achieved.

    Takes no verdict, no metric value and no benefit description from
    its caller: everything on the row is recomputed here. Idempotent on
    the recomputed inputs — a second evaluation of the same evidence
    returns the existing row; a second evaluation of DIFFERENT evidence
    is refused, because the row states what was true N nights after the
    merge and a later regression has its own loud channel.
    """
    if not change_id.strip():
        raise GovernanceError("change_id is required")
    tools_root = ensure_tools_dir(base_dir)
    computed = recompute_change_outcome(
        change_id=change_id, repo_root=repo_root, base_dir=tools_root, now=now,
    )
    if computed["nights_since_merge"] < nights:
        raise GovernanceError(
            f"change_outcome_premature: {change_id!r} merged "
            f"{computed['nights_since_merge']} nights ago; the benefit is "
            f"recomputed after {nights} nights so the bench has had a night "
            f"to re-run the recipe"
        )

    existing = find_change_outcome(tools_root, change_id)
    if existing is not None:
        if existing.get("inputs_digest") == computed["inputs_digest"]:
            return existing
        raise GovernanceError(
            f"change_outcome_content_drift: {change_id!r} already carries a "
            f"change_outcome row computed from different evidence "
            f"(existing={existing.get('inputs_digest')!r} != "
            f"recomputed={computed['inputs_digest']!r})"
        )

    _ledger_dir(tools_root).mkdir(parents=True, exist_ok=True)
    source_type = _pressure_source_for_plan(
        computed["plan_id"], base_dir=tools_root,
    )
    row = {
        "$schema": CHANGE_RECORD_SCHEMA,
        "schema_version": 1,
        "event": "change_outcome",
        "change_id": change_id,
        "plan_id": computed["plan_id"],
        "finding_id": computed["finding_id"],
        "commit_sha": computed["commit_sha"],
        "verdict": computed["verdict"],
        "readings": computed["readings"],
        "merged_at": computed["merged_at"],
        "merged_pr_number": computed["merged_pr_number"],
        "nights_since_merge": computed["nights_since_merge"],
        "evaluation_nights": nights,
        "inputs_digest": computed["inputs_digest"],
        "pressure_source_type": source_type,
        "recorded_at": utc_now(),
    }
    # ORDER: the outcome row lands BEFORE the counter it feeds. A crash
    # between the two costs at most a missed rejection increment (the row
    # exists, and the idempotent return keeps a re-run from writing it
    # twice); the opposite order would double-count a rejection on retry,
    # and a poisoned bandit is a worse failure than an under-counted one.
    persisted = append_declared_jsonl(
        _outcome_path(tools_root), row, expected_surface="change_outcome",
    )
    aggregate = _record_aggregate(
        verdict=computed["verdict"],
        source_type=source_type,
        base_dir=tools_root,
    )
    append_tools_governance(
        tools_root,
        "change_outcome_recorded",
        {
            "change_id": change_id,
            "verdict": computed["verdict"],
            "plan_id": computed["plan_id"],
            "commit_sha": computed["commit_sha"],
            "inputs_digest": computed["inputs_digest"],
            "aggregate": aggregate,
        },
    )
    return persisted


def _record_aggregate(
    *, verdict: str, source_type: str | None, base_dir: str | Path,
) -> dict[str, Any]:
    """Fold a negative outcome into ``cycles_rejected`` for its source.

    Through ``record_pressure_source_outcome`` — the effectiveness
    ledger's ONE writer. ``gain_confirmed`` writes nothing (the merge is
    already counted upstream) and ``unknown`` writes nothing (absence of
    evidence is not evidence of absence). The counter is a tools-root
    surface beside the outcome row it follows, so it is named by the same
    ``base_dir`` — a workspace-derived path would have put it in the
    checkout on the live lane, where the store is not under the workspace
    (B4, 2026-09-12).
    """
    if verdict not in {"no_gain", "regression"}:
        return {"applied": False, "reason": f"verdict_{verdict}_carries_no_rejection"}
    if not source_type:
        return {"applied": False, "reason": "pressure_source_unresolved"}
    from .knowledge_graph import record_pressure_source_outcome

    record_pressure_source_outcome(
        base_dir=base_dir, source_type=source_type, rejected=1,
    )
    return {"applied": True, "source_type": source_type, "rejected_delta": 1}


def _capture_assessment_inputs(
    *, change_id: str, pattern_id: str, repo_root: str | Path,
    base_dir: str | Path | None = None, now: datetime | None = None,
) -> _AssessmentCapture:
    """Capture existing hot evidence once, under its declared ordered locks.

    The byte/row limits admit the stored capture; existing owner verification
    has additional reads. This is not the sweep's eventual I/O/time budget or
    a retention implementation. Missing files are captured as absent, while
    unreadable/incomplete inputs prevent capture rather than imply success.
    """
    from os import fstat as _fstat
    from .knowledge_graph import _observation_rows as _kg_observation_rows
    from .ledger import load_jsonl_verified_text as _verified_text, state_transaction as _transaction
    from .snapshot import normalize_path as _normalize_path
    from .state_manifest import resolve_surface_path as _surface_path, surface_by_name as _surface
    from .state_store import (
        StateStoreError as _StateStoreError,
        _read_bounded_regular_file as _read_binding_file,
        _valid_host_identity,
    )
    from .tool_registry import ensure_tools_dir_readonly as _readonly_tools
    from .workspace import _canonical_identity_observation, repo_state_root as _repo_state_root

    tools = _readonly_tools(base_dir)
    if tools is None:
        raise GovernanceError("change_assessment_tools_unavailable")
    tools = tools.resolve()
    repo = Path(repo_root).resolve()
    repo_identity, identity_source = _canonical_identity_observation(repo)
    if identity_source["source"] == "basename":
        raise GovernanceError("change_assessment_repository_identity_unavailable")
    evaluated_at = now or datetime.now(timezone.utc)
    if evaluated_at.tzinfo is None:
        raise GovernanceError("change_assessment_cutoff_requires_timezone")
    evaluated_at = evaluated_at.astimezone(timezone.utc)
    names = (
        "change_planned", "change_committed", "change_validated", "change_outcome",
        "pr_lifecycle", "tools_governance", "experiment_observations",
        "experiment_definitions", "experiment_recipes", "validation_runs",
        "kg_conventions", "repo_finding_events",
    )
    paths: dict[str, Path] = {}
    for name in names:
        surface = _surface(name)
        root = _repo_state_root(repo) if surface.root_kind == "repo" else tools
        paths[name] = _surface_path(root, surface)
    identity_path = tools / "repo_identity.json"
    contract_path = tools / "tools_contract.json"
    remaining = _ASSESSMENT_CAPTURE_BYTES
    row_count = 0

    def read_bytes(path: Path) -> bytes | None:
        nonlocal remaining
        try:
            before = path.stat()
        except FileNotFoundError:
            return None
        if not path.is_file() or before.st_size > remaining:
            raise GovernanceError("change_assessment_source_unavailable_or_capture_limit")
        with path.open("rb") as stream:
            opened = _fstat(stream.fileno())
            if (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns) != (
                before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns,
            ):
                raise GovernanceError("change_assessment_source_changed")
            content = stream.read(before.st_size)
            after = _fstat(stream.fileno())
        remaining -= len(content)
        if (len(content) != before.st_size
                or (after.st_size, after.st_mtime_ns) != (before.st_size, before.st_mtime_ns)):
            raise GovernanceError("change_assessment_source_changed")
        return content

    native_sources: list[tuple[str, bytes | None]] = []
    source_rows: dict[str, list[dict[str, Any]]] = {}
    descriptors: list[dict[str, Any]] = []
    # The binding owner checks Git common-directory identity. Its commands
    # run before evidence locks; the exact validated metadata is rechecked
    # under those locks, without replacing authority with path equality.
    try:
        validated_identity = _read_binding_file(identity_path)[0]
        validated_contract = _read_binding_file(contract_path)[0]
    except _StateStoreError as exc:
        raise GovernanceError("change_assessment_tools_binding_unavailable") from exc
    if not _valid_host_identity(
        tools, repo_identity, repo, identity_payload=validated_identity,
        contract_payload=validated_contract,
    ):
        raise GovernanceError("change_assessment_tools_binding_unavailable")
    with _transaction([*paths.values(), identity_path, contract_path]):
        identity_bytes = read_bytes(identity_path)
        contract_bytes = read_bytes(contract_path)
        if identity_bytes != validated_identity or contract_bytes != validated_contract:
            raise GovernanceError("change_assessment_tools_binding_unavailable")
        for name, path in paths.items():
            content = read_bytes(path)
            native_sources.append((name, content))
            if content is None:
                rows: list[dict[str, Any]] = []
            elif name == "kg_conventions":
                # Preserve the existing native/outer/replay observation owner.
                rows = _kg_observation_rows(path)
            else:
                rows = _verified_text(content.decode("utf-8"), source=path, expected_surface=name)
            row_count += len(rows)
            if row_count > _ASSESSMENT_CAPTURE_ROWS:
                raise GovernanceError("change_assessment_capture_row_limit")
            source_rows[name] = rows
            stored_lines = (content or b"").splitlines()
            tail = json.loads(stored_lines[-1]).get("ledger_hash") if stored_lines else None
            surface = _surface(name)
            descriptors.append({
                "source_surface": name, "root_kind": surface.root_kind,
                "repo_identity": repo_identity, "relative_path": surface.path_pattern,
                "presence": "present" if content is not None else "absent",
                "prefix": {"byte_length": len(content or b""), "row_count": len(rows),
                           "sha256": "sha256:" + hashlib.sha256(content or b"").hexdigest(),
                           "tail_ledger_hash": tail},
                "retained_prefix_ref": None,
            })

    outcomes, assessments = _classify_outcome_rows(source_rows["change_outcome"])
    original = next((row for row in outcomes if row.get("change_id") == change_id), None)
    planned = next((row for row in source_rows["change_planned"] if row.get("change_id") == change_id), None)
    committed = next((row for row in source_rows["change_committed"] if row.get("change_id") == change_id), None)
    validated = next((row for row in source_rows["change_validated"] if row.get("change_id") == change_id), None)
    if original is None or planned is None or committed is None or validated is None:
        raise GovernanceError("change_assessment_original_chain_unavailable")
    if (original.get("plan_id") != planned.get("plan_id")
            or original.get("finding_id") != planned.get("finding_id")
            or original.get("commit_sha") != committed.get("commit_sha")
            or validated.get("commit_sha") != committed.get("commit_sha")):
        raise GovernanceError("change_assessment_original_chain_unavailable")
    # The immutable first outcome selects its own merge, not a later merge row.
    pr_number = original.get("merged_pr_number")
    pr_rows = source_rows["pr_lifecycle"]
    openings = [row for row in pr_rows if row.get("pr_number") == pr_number and row.get("change_id") == change_id]
    merged_at = _parse_instant(str(original.get("merged_at") or ""))
    merges = [row for row in pr_rows if row.get("event") == "merged"
              and row.get("pr_number") == pr_number
              and _parse_instant(str(row.get("recorded_at") or "")) == merged_at]
    if not openings or not merges or merged_at is None or evaluated_at < merged_at:
        raise GovernanceError("change_assessment_original_merge_unavailable")

    patterns = {row.get("pattern_id"): row for row in source_rows["kg_conventions"]}
    family: list[dict[str, Any]] = []
    seen: set[str] = set()
    current = pattern_id
    while current:
        pattern = patterns.get(current)
        if (current in seen or pattern is None
                or pattern.get("pattern_type") != "convention"
                or pattern.get("plan_id") != planned.get("plan_id")):
            raise GovernanceError("change_assessment_pattern_family_unavailable")
        seen.add(current)
        family.append(pattern)
        current = pattern.get("supersedes_pattern_id")
    if not family:
        raise GovernanceError("change_assessment_pattern_family_unavailable")
    scope = planned.get("intended_affected_files")
    if not isinstance(scope, list) or not scope or len(scope) > 256:
        raise GovernanceError("change_assessment_scope_unavailable")
    normalized: set[str] = set()
    for path in scope:
        if (not isinstance(path, str) or not path or Path(path).is_absolute()
                or ".." in Path(path.replace("\\", "/")).parts):
            raise GovernanceError("change_assessment_scope_unavailable")
        normalized_path = _normalize_path(path)
        if not normalized_path:
            raise GovernanceError("change_assessment_scope_unavailable")
        normalized.add(normalized_path)
    scope_paths = sorted(normalized)
    family_root = family[-1]["pattern_id"]
    stream_id = _inputs_digest([repo_identity, family_root, scope_paths])
    previous = next((row for row in reversed(assessments) if row["stream_id"] == stream_id), None)

    def ref(source: str, row: dict[str, Any]) -> dict[str, Any]:
        return {"source_surface": source, "ledger_hash": row.get("ledger_hash"),
                **{key: row[key] for key in ("event_id", "change_id", "pattern_id", "validation_run_id") if key in row}}

    for descriptor in descriptors:
        name = descriptor["source_surface"]
        relevant: list[dict[str, Any]] = []
        for row in source_rows[name]:
            details = row.get("details") if isinstance(row.get("details"), dict) else {}
            if (row.get("change_id") == change_id or row.get("plan_id") == planned["plan_id"]
                    or row.get("finding_id") == planned["finding_id"]
                    or row.get("finding_ref") == planned["finding_id"]
                    or row.get("pattern_id") in seen
                    or (name == "pr_lifecycle" and row.get("pr_number") == pr_number)
                    or details.get("finding_id") == planned["finding_id"]
                    or details.get("change_id") == change_id):
                relevant.append(ref(name, row))
        descriptor["selected_row_refs"] = relevant
    metadata = {
        "change_id": change_id, "plan_id": planned["plan_id"], "finding_id": planned["finding_id"],
        "commit_sha": committed["commit_sha"], "repo_identity": repo_identity,
        "repo_identity_source": identity_source["source"], "pattern_id": pattern_id,
        "family_root_pattern_id": family_root, "family_refs": [ref("kg_conventions", row) for row in family],
        "scope_paths": scope_paths, "scope_origin": "change_planned", "stream_id": stream_id,
        "original_outcome_ref": ref("change_outcome", original),
        "predecessor_assessment_id": previous["assessment_id"] if previous else None,
        "evidence_window": {"lower_exclusive": original["merged_at"], "upper_inclusive": evaluated_at.isoformat()},
        "source_snapshots": descriptors,
        "binding_observation": {"identity_sha256": "sha256:" + hashlib.sha256(identity_bytes).hexdigest(),
                                "contract_sha256": "sha256:" + hashlib.sha256(contract_bytes).hexdigest()},
    }
    return _AssessmentCapture(
        change_id=change_id, finding_id=planned["finding_id"], plan_id=planned["plan_id"],
        commit_sha=committed["commit_sha"], merged_at=merged_at, evaluated_at=evaluated_at,
        repo_root=repo, tools_root=tools, _native_sources=tuple(native_sources),
        _verified_sources=tuple((name, json.dumps(rows, sort_keys=True, separators=(",", ":")).encode("utf-8"))
                                for name, rows in source_rows.items()),
        _metadata=json.dumps(metadata, sort_keys=True, separators=(",", ":")).encode("utf-8"),
    )


def _compute_change_assessment(capture: _AssessmentCapture) -> dict[str, Any]:
    """Recompute from immutable hot input facts; no I/O or caller verdict."""
    if not isinstance(capture, _AssessmentCapture):
        raise GovernanceError("change_assessment_capture_required")
    metadata = json.loads(capture._metadata)
    readings = _metric_readings(capture)
    values = [reading.as_dict() for reading in readings]
    inputs_digest = _inputs_digest({"metadata": metadata, "readings": values,
                                    "evaluator_version": _ASSESSMENT_EVALUATOR_VERSION})
    material_digest = _inputs_digest({
        "original_outcome_ref": metadata["original_outcome_ref"],
        "stream_id": metadata["stream_id"], "readings": values,
        "evaluator_version": _ASSESSMENT_EVALUATOR_VERSION,
    })
    return {
        **metadata, "$schema": _ASSESSMENT_SCHEMA, "schema_version": 1,
        "event": "change_assessment", "evaluator_version": _ASSESSMENT_EVALUATOR_VERSION,
        "assessment_id": _inputs_digest({"schema": _ASSESSMENT_SCHEMA, "inputs_digest": inputs_digest}),
        "inputs_digest": inputs_digest, "material_evidence_trigger_digest": material_digest,
        "verdict": fold_outcome_verdict(readings), "readings": values,
        "availability": {
            "evidence": {"status": "available", "source_tier": "hot"},
            "durability": {"status": "unavailable", "reason": "retained_prefix_unavailable"},
            "qualification": {"status": "unknown", "reason": "corrective_reinstatement_not_evaluated"},
        },
    }


def _record_change_assessment(
    capture: _AssessmentCapture, *, cycle_id: str, base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Append once in its stream, or return an exact older retry unchanged."""
    from .ledger import state_transaction as _transaction
    from .state_store import (
        StateStoreError as _StateStoreError,
        _read_bounded_regular_file as _read_binding_file,
        _valid_host_identity,
    )
    from .tool_registry import ensure_tools_dir_readonly as _readonly_tools

    computed = _compute_change_assessment(capture)
    if not isinstance(cycle_id, str) or not cycle_id.strip():
        raise GovernanceError("change_assessment_cycle_id_required")
    tools = _readonly_tools(base_dir if base_dir is not None else capture.tools_root)
    if tools is None or tools.resolve() != capture.tools_root:
        raise GovernanceError("change_assessment_hot_root_unavailable")
    path = _outcome_path(tools)
    identity_path = tools / "repo_identity.json"
    contract_path = tools / "tools_contract.json"
    try:
        validated_identity = _read_binding_file(identity_path)[0]
        validated_contract = _read_binding_file(contract_path)[0]
    except _StateStoreError as exc:
        raise GovernanceError("change_assessment_tools_binding_unavailable") from exc
    if not _valid_host_identity(
        tools, computed["repo_identity"], capture.repo_root,
        identity_payload=validated_identity, contract_payload=validated_contract,
    ):
        raise GovernanceError("change_assessment_tools_binding_unavailable")
    with _transaction([path, identity_path, contract_path]) as transaction:
        try:
            identity_bytes = _read_binding_file(identity_path)[0]
            contract_bytes = _read_binding_file(contract_path)[0]
        except _StateStoreError as exc:
            raise GovernanceError("change_assessment_tools_binding_unavailable") from exc
        if identity_bytes != validated_identity or contract_bytes != validated_contract:
            raise GovernanceError("change_assessment_tools_binding_unavailable")
        originals, assessments = _classify_outcome_rows(
            transaction.load_declared_jsonl(path, expected_surface="change_outcome"),
        )
        if not any(row.get("ledger_hash") == computed["original_outcome_ref"]["ledger_hash"]
                   and row.get("change_id") == capture.change_id for row in originals):
            raise GovernanceError("change_assessment_original_outcome_unavailable")
        for row in assessments:
            if row["assessment_id"] == computed["assessment_id"]:
                if any(row.get(key) != value for key, value in computed.items()):
                    raise GovernanceError("change_assessment_content_drift")
                return row
        previous = next((row for row in reversed(assessments)
                         if row["stream_id"] == computed["stream_id"]), None)
        if computed["predecessor_assessment_id"] != (previous["assessment_id"] if previous else None):
            raise GovernanceError("change_assessment_stale_predecessor")
        return transaction.append_declared_jsonl(
            path, {**computed, "cycle_id": cycle_id, "recorded_at": utc_now()},
            expected_surface="change_outcome",
        )


# ---------------------------- nightly phase ----------------------------


def evaluate_change_outcomes(
    repo_root: str | Path,
    *,
    cycle_id: str | None = None,
    base_dir: str | Path | None = None,
    nights: int = OUTCOME_EVALUATION_NIGHTS,
    max_evaluations: int = MAX_OUTCOME_EVALUATIONS_PER_NIGHT,
    now: datetime | None = None,
) -> dict[str, Any]:
    """One night's worth of "did it work?", budgeted and disclosed.

    Selection is ledger-driven: every validated chain that MERGED at
    least ``nights`` nights ago and carries no outcome row yet, oldest
    merge first (the changes whose evidence window is widest). Skips are
    counted with their reason — a night that evaluated nothing says
    WHICH nothing.
    """
    tools_root = ensure_tools_dir(base_dir)
    evaluated_at = now or datetime.now(timezone.utc)
    seen = {
        str(row.get("change_id"))
        for row in list_change_outcomes(base_dir=tools_root)
    }
    merges = _merge_index(tools_root)

    candidates: list[tuple[datetime, str]] = []
    skipped: dict[str, int] = {}

    def _skip(reason: str) -> None:
        skipped[reason] = skipped.get(reason, 0) + 1

    validated_path = _ledger_dir(tools_root) / "validated.jsonl"
    if validated_path.exists():
        rows = load_declared_jsonl(
            validated_path, expected_surface="change_validated",
        )
    else:
        rows = []
    for row in rows:
        change_id = str(row.get("change_id") or "")
        if not change_id or change_id in seen:
            continue
        seen.add(change_id)  # one candidate per change, not per validated row
        merge_row = merges.get(change_id)
        if merge_row is None:
            _skip("not_merged")
            continue
        merged_at = _parse_instant(str(merge_row.get("recorded_at") or ""))
        if merged_at is None:
            _skip("merge_anchor_unreadable")
            continue
        if (evaluated_at - merged_at) < timedelta(days=nights):
            _skip("window_not_elapsed")
            continue
        candidates.append((merged_at, change_id))

    candidates.sort()
    recorded: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for _merged_at, change_id in candidates[:max_evaluations]:
        try:
            row = emit_change_outcome(
                change_id=change_id, repo_root=repo_root, base_dir=tools_root,
                nights=nights, now=evaluated_at,
            )
        except GovernanceError as exc:
            errors.append({"change_id": change_id, "error": str(exc)})
            continue
        recorded.append({
            "change_id": change_id,
            "verdict": row.get("verdict"),
            "pressure_source_type": row.get("pressure_source_type"),
        })
    if len(candidates) > max_evaluations:
        skipped["evaluation_budget_exhausted"] = len(candidates) - max_evaluations

    counts = {verdict: 0 for verdict in OUTCOME_VERDICTS}
    for item in recorded:
        counts[str(item["verdict"])] += 1
    return {
        "schema_version": 1,
        "cycle_id": cycle_id,
        "evaluation_nights": nights,
        "eligible": len(candidates),
        "evaluated": len(recorded),
        "verdicts": counts,
        "outcomes": recorded,
        "skipped": skipped,
        "errors": errors,
    }
