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

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any

# Below this, "zero converged" says more about the sample than the
# pipeline: a source that minted twice and converged neither may simply
# be new. The threshold is what separates a stall from a small night.
MIN_UPSTREAM_FOR_STALL: int = 10

# The funnel's ordered stages, upstream first. Each entry is
# (stage_name, counter_field, owner_paths); a stage is judged against the
# counter immediately upstream of it, which is what makes "stalled" mean
# "work arrives here and does not leave" rather than "this number is 0".
#
# ARIA-HIGH-384 — `owner_paths` is the repository code that moves work
# through the stage, and it is the stall's EVIDENCE: the only refs a planner
# asked "why does this stage convert nothing" can read and cite back at the
# envelope's target_sha. The effectiveness ledger the counters live in is the
# stall's provenance — a tools-root state record no agent can cite, which is
# what made every pipeline_stalled request unanswerable.
FUNNEL_STAGES: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("convergence", "cycles_converged", (
        "aria-kernel/aria_kernel/convergence_drainer.py",
        "aria-kernel/aria_kernel/plan_convergence.py",
    )),
    ("merge", "cycles_merged", (
        "aria-kernel/aria_kernel/converged_delivery.py",
        "aria-kernel/aria_kernel/auto_merge.py",
    )),
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
    owner_paths: tuple[str, ...]

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
            "owner_paths": list(self.owner_paths),
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
        for stage, field, owner_paths in FUNNEL_STAGES:
            upstream = int(row.get(_UPSTREAM_FIELD[field], 0) or 0)
            downstream = int(row.get(field, 0) or 0)
            if upstream >= min_upstream and downstream == 0:
                stalls.append(
                    FunnelStall(
                        stage=stage, source_type=source,
                        upstream=upstream, downstream=downstream,
                        owner_paths=owner_paths,
                    )
                )
    return stalls


# ---------------------------------------------------------------------------
# ARIA-HIGH-004 — the LEARNING funnel, joined end to end.
#
# The delivery funnel above measures plans. The learning funnel is the path a
# finding takes to change what ARIA trusts: an adapter's raw finding is put to
# judges, their agreement survives a third judge (an ANCHOR, the only
# consensus that is ground truth), the finding is promoted, the adapter's
# fixture suite passes, the judges are calibrated against truth they did not
# form, the adapter's calibration report reads green, and the adapter is
# promoted to ACTIVE on that report. Each stage had a producer and a ledger;
# nothing joined them, so "24,788 raw findings promoted to zero" was found by
# a person reading ledgers, and no row could say which judgment a promotion
# stood on.
#
# The join keys are the identities the producers stamp from their input
# envelope (never inferred from the newest row): the raw finding's tool,
# run and fingerprint; the judge request's id and commit; the consensus's
# request ids and commit; the promotion's fingerprint and commit; the fixture
# run's execution id, tool version, manifest and commit; the calibration
# reports' ids and commits; and the ACTIVE transition's bound evidence
# (adapter_calibration.ACTIVE_EVIDENCE_FIELDS). A row lacking a key cannot
# advance a later stage.
#
# ``counts`` are bound to one target commit: from the judge request on,
# every row must name that commit. Raw findings name none (an adapter run is
# not minted at a commit), so ``raw`` is the pool the target's requests draw
# from. ``historical_counts`` read every row through a display-only
# upcaster (a row without a commit reads as ``target_sha=None`` and the
# commit is not required): legacy rows count as history and never prove
# anything about a target.
# ---------------------------------------------------------------------------

LEARNING_FUNNEL_STAGES: tuple[str, ...] = (
    "raw", "judge_request", "consensus", "promoted", "fixture_pass",
    "judge_calibrated", "adapter_calibrated", "adapter_active",
)
LEARNING_STALL_PREFIX: str = "learning_funnel_stalled"
LEARNING_STAGE_EMPTY_PREFIX: str = "learning_funnel_stage_empty"


@dataclass(frozen=True, slots=True)
class LearningFunnelHealth:
    target_sha: str
    counts: Mapping[str, int]
    historical_counts: Mapping[str, int]
    stalled_at: str | None
    blockers: tuple[str, ...]
    evidence_refs: tuple[str, ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "target_sha": self.target_sha,
            "counts": dict(self.counts),
            "historical_counts": dict(self.historical_counts),
            "stalled_at": self.stalled_at,
            "blockers": list(self.blockers),
            "evidence_refs": list(self.evidence_refs),
        }


@dataclass(frozen=True, slots=True)
class LearningFunnelInputs:
    """The rows the learning funnel joins, as their owners' readers return them."""

    raw_findings: tuple[Mapping[str, Any], ...]
    requests: tuple[Mapping[str, Any], ...]
    feedback: tuple[Mapping[str, Any], ...]
    promotions: tuple[Mapping[str, Any], ...]
    judge_calibrations: tuple[Mapping[str, Any], ...]
    adapter_calibrations: tuple[Mapping[str, Any], ...]
    tools: Mapping[str, Mapping[str, Any]]
    # tool_id -> the tool's fixture suite rows (fixture_runner.load_fixture_runs).
    fixture_runs: Mapping[str, tuple[Mapping[str, Any], ...]]
    # tool_id -> fixture_runner.latest_fixture_status(tool_id): the one owner
    # of the tool's CURRENT fixture corpus hash.
    fixture_status: Mapping[str, Mapping[str, Any]]


def learning_funnel_stalls(
    counts: Mapping[str, int],
    *,
    min_upstream: int = MIN_UPSTREAM_FOR_STALL,
) -> tuple[str, ...]:
    """``learning_funnel_stalled:<up>-><down>`` for every stage that holds at
    least ``min_upstream`` and whose immediate successor holds none — the same
    conservatism as ``detect_funnel_stalls``: a stage nobody fed is idle,
    not stalled."""
    return tuple(
        f"{LEARNING_STALL_PREFIX}:{upstream}->{downstream}"
        for upstream, downstream in zip(LEARNING_FUNNEL_STAGES, LEARNING_FUNNEL_STAGES[1:])
        if int(counts.get(upstream, 0)) >= min_upstream and int(counts.get(downstream, 0)) == 0
    )


def learning_stage_blockers(stage_counts: Mapping[str, int]) -> tuple[str, ...]:
    """``learning_funnel_stage_empty:<stage>`` for every named stage that holds
    nothing, in the order given. The autonomy-evidence status refuses
    live_proven on any of them (``autonomy_evidence._LEARNING_STAGE_COUNTS``):
    an empty downstream stage means the funnel it proves does not run end to
    end, however many rows its upstream holds."""
    return tuple(
        f"{LEARNING_STAGE_EMPTY_PREFIX}:{stage}" for stage, count in stage_counts.items() if int(count) <= 0
    )


def derive_learning_funnel_health(
    *,
    base_dir: str | Path,
    target_sha: str,
) -> LearningFunnelHealth:
    """The learning funnel of the store at ``base_dir``, bound to ``target_sha``."""
    from .git_object_id import ANY_OBJECT_FORMAT, is_object_id

    if not is_object_id(target_sha, formats=ANY_OBJECT_FORMAT):
        raise ValueError("learning funnel target_sha must be a full git object id")
    return fold_learning_funnel(load_learning_funnel_inputs(base_dir), target_sha=target_sha)


def load_learning_funnel_inputs(base_dir: str | Path) -> LearningFunnelInputs:
    """Every ledger the join reads, through its owner's verified reader.

    A reader: the tools root is resolved read-only, so measuring a root that
    was never bound refuses instead of bootstrapping one."""
    from .adapter_calibration import list_adapter_calibration_reports
    from .agent_invocations import list_agent_invocation_requests
    from .feedback_store import load_feedback, load_jsonl, promotions_path, raw_findings_path
    from .fixture_runner import latest_fixture_status, load_fixture_runs
    from .judge_calibration import calibration_path
    from .tool_registry import FIXTURE_SET_FIELD, GovernanceError, ensure_tools_dir_readonly, list_tools

    root = ensure_tools_dir_readonly(base_dir)
    if root is None:
        raise GovernanceError(f"learning_funnel_tools_root_unbound: {base_dir}")

    def ledger(path: Path) -> tuple[Mapping[str, Any], ...]:
        return tuple(load_jsonl(path)) if path.exists() else ()

    tools = {str(tool["tool_id"]): tool for tool in list_tools(base_dir=root) if tool.get("tool_id")}
    promotions = ledger(promotions_path(root))
    # Fixture evidence is read for the tools that own a suite: an agent-backed tool (change-review) has none,
    # its evidence being checked per answer at the answer's commit, so there is no verdict to read for it.
    promoted_tools = {str(row.get("tool_id") or "") for row in promotions} & {
        tool_id for tool_id, tool in tools.items() if FIXTURE_SET_FIELD in tool
    }
    return LearningFunnelInputs(
        raw_findings=ledger(raw_findings_path(root)),
        requests=tuple(list_agent_invocation_requests(base_dir=root)),
        feedback=tuple(load_feedback(base_dir=root)),
        promotions=promotions,
        judge_calibrations=ledger(calibration_path(root)),
        adapter_calibrations=tuple(list_adapter_calibration_reports(base_dir=root)),
        tools=tools,
        fixture_runs={
            tool_id: tuple(load_fixture_runs(tool_id, base_dir=root))
            for tool_id in sorted(promoted_tools)
        },
        fixture_status={
            tool_id: latest_fixture_status(tool_id, base_dir=root)
            for tool_id in sorted(promoted_tools)
        },
    )


def fold_learning_funnel(inputs: LearningFunnelInputs, *, target_sha: str) -> LearningFunnelHealth:
    counts, refs = _join_learning_funnel(inputs, target_sha=target_sha)
    historical, _refs = _join_learning_funnel(inputs, target_sha=None)
    blockers = learning_funnel_stalls(counts)
    stalled_at = blockers[0].rsplit("->", 1)[1] if blockers else None
    return LearningFunnelHealth(
        target_sha=target_sha,
        counts=MappingProxyType(counts),
        historical_counts=MappingProxyType(historical),
        stalled_at=stalled_at,
        blockers=blockers,
        evidence_refs=tuple(sorted(refs)),
    )


def _join_learning_funnel(
    inputs: LearningFunnelInputs,
    *,
    target_sha: str | None,
) -> tuple[dict[str, int], set[str]]:
    """Joined entity counts per stage; ``target_sha=None`` is the display-only
    upcast (no row is required to name a commit)."""
    from .agent_invocations import request_anchor_sha
    from .agent_surface import JUDGE_ROLES
    from .feedback_store import is_ground_truth_row
    from .readiness import readiness_verdict_hash

    def bound(sha: Any) -> bool:
        return target_sha is None or sha == target_sha

    refs: set[str] = set()
    FindingKey = tuple[str, str]

    # raw — the pool: every adapter finding with a fingerprint whose run's
    # evidence held, keyed by (tool, fingerprint) with the runs that emitted it.
    raw_runs: dict[FindingKey, set[str]] = {}
    for row in inputs.raw_findings:
        tool_id = str(row.get("tool_id") or "")
        fingerprint = str(row.get("finding_fingerprint") or "")
        if tool_id and fingerprint and row.get("status") != "invalid_evidence":
            raw_runs.setdefault((tool_id, fingerprint), set()).add(str(row.get("run_id") or ""))

    # judge_request — a judge-role request minted for that finding of that
    # run, at the target.
    request_keys: dict[str, FindingKey] = {}
    for request in inputs.requests:
        key = (str(request.get("tool_id") or ""), str(request.get("finding_fingerprint") or ""))
        request_id = str(request.get("request_id") or "")
        if (
            request_id
            and request.get("role") in JUDGE_ROLES
            and str(request.get("run_id") or "") in raw_runs.get(key, ())
            and bound(request_anchor_sha(request))
        ):
            request_keys[request_id] = key
    judged = set(request_keys.values())

    # consensus — an ANCHOR true_positive whose every closing judge's request
    # joined above, at the target. The observers are kept for calibration.
    anchor_observers: dict[FindingKey, list[frozenset[str]]] = {}
    for row in inputs.feedback:
        if row.get("source_type") != "ai_consensus" or row.get("verdict") != "true_positive":
            continue
        key = (str(row.get("tool_id") or ""), str(row.get("finding_fingerprint") or ""))
        request_ids = [str(item) for item in row.get("request_ids") or [] if item]
        if (
            key in judged
            and is_ground_truth_row(dict(row))
            and request_ids
            and all(request_keys.get(request_id) == key for request_id in request_ids)
            and bound(row.get("target_sha"))
        ):
            anchor_observers.setdefault(key, []).append(frozenset(
                str(observer.get("judge_id") or "")
                for observer in row.get("observers") or []
                if isinstance(observer, Mapping)
            ))

    # promoted — the finding committed exactly once, at the target.
    promoted: set[FindingKey] = set()
    for row in inputs.promotions:
        key = (str(row.get("tool_id") or ""), str(row.get("finding_fingerprint") or ""))
        if key in anchor_observers and row.get("finding_id") and bound(row.get("target_sha")):
            promoted.add(key)
            refs.add(f"promotions:{key[1]}")

    # fixture_pass — a passing suite of the promoting tool's registered
    # version over its CURRENT corpus (a suite of a corpus that has since
    # changed is stale), run at the target. Whether that suite was still
    # the tool's current verdict when the tool was calibrated is the
    # calibration report's to say (adapter_calibrated, below); the tool's
    # status is part of its manifest hash, so an ACTIVE tool's SHADOW-time
    # suite can only be judged by the report that read it.
    fixture_runs: dict[str, set[str]] = {}
    for tool_id in sorted({key[0] for key in promoted}):
        tool = inputs.tools.get(tool_id) or {}
        corpus = (inputs.fixture_status.get(tool_id) or {}).get("current_fixture_set_hash")
        for row in inputs.fixture_runs.get(tool_id, ()):
            run_ref = str(row.get("execution_run_id") or "")
            if (
                run_ref
                and row.get("row_type") == "fixture_run_suite"
                and row.get("passed") is True
                and row.get("actual_status") == "pass"
                and row.get("tool_version") == tool.get("version")
                and corpus is not None
                and row.get("fixture_set_hash") == corpus
                and bound(row.get("workspace_commit_sha"))
            ):
                fixture_runs.setdefault(tool_id, set()).add(run_ref)

    # judge_calibrated — an organic judge calibration report at the target
    # that scored every judge of one of the tool's anchors against truth
    # that judge did not form (samples > 0).
    judge_reports: dict[str, str] = {}
    for tool_id in sorted(fixture_runs):
        anchors = [observers for key, groups in anchor_observers.items() if key[0] == tool_id
                   and key in promoted for observers in groups]
        for report in reversed(inputs.judge_calibrations):
            if report.get("judgment_group_prefix") is not None or not bound(report.get("target_sha")):
                continue
            scored = {
                str(judge.get("judge_id") or "")
                for judge in report.get("judges") or []
                if isinstance(judge, Mapping) and int(judge.get("samples") or 0) > 0
            }
            if any(observers and observers <= scored for observers in anchors):
                report_ref = str(report.get("calibration_report_id") or f"recorded_at:{report.get('recorded_at')}")
                judge_reports[tool_id] = report_ref
                refs.add(f"judge-calibration:{report_ref}")
                break

    # adapter_calibrated — an adapter calibration report at the target whose
    # green verdict for the tool read exactly the joined fixture run and
    # describes the registered version.
    adapter_reports: dict[str, list[tuple[Mapping[str, Any], Mapping[str, Any]]]] = {}
    for tool_id in sorted(judge_reports):
        tool = inputs.tools.get(tool_id) or {}
        for row in inputs.adapter_calibrations:
            if not row.get("report_id") or not bound(row.get("target_sha")):
                continue
            for report in row.get("reports") or []:
                if not isinstance(report, Mapping) or report.get("tool_id") != tool_id:
                    continue
                latest = (report.get("fixture_status") or {}).get("latest") or {}
                if (
                    report.get("active_ready") is True
                    and report.get("verdict_hash") == readiness_verdict_hash(dict(report))
                    and report.get("tool_version") == tool.get("version")
                    and (report.get("fixture_status") or {}).get("current_tool_passed") is True
                    and latest.get("execution_run_id") in fixture_runs[tool_id]
                ):
                    adapter_reports.setdefault(tool_id, []).append((row, report))
                    refs.add(f"adapter-calibration:{row['report_id']}")
                    refs.add(f"fixture-runs:{latest['execution_run_id']}")

    # adapter_active — ACTIVE on one of those reports: the transition's bound
    # evidence names the report (id and hash), its verdict, the fixture run,
    # the version and the target.
    active: set[str] = set()
    for tool_id, joined in sorted(adapter_reports.items()):
        tool = inputs.tools.get(tool_id) or {}
        transition = tool.get("last_transition") or {}
        evidence = transition.get("active_evidence") or {}
        if tool.get("status") != "ACTIVE" or transition.get("to") != "ACTIVE" or not bound(evidence.get("target_sha")):
            continue
        if any(
            evidence.get("calibration_report_ref") == row.get("report_id")
            and evidence.get("calibration_report_hash") == row.get("ledger_hash")
            and evidence.get("readiness_verdict_hash") == report.get("verdict_hash")
            and evidence.get("fixture_run_refs")
            == [((report.get("fixture_status") or {}).get("latest") or {}).get("execution_run_id")]
            and evidence.get("tool_version") == tool.get("version")
            and evidence.get("target_sha") == row.get("target_sha")
            for row, report in joined
        ):
            active.add(tool_id)
            refs.add(f"registry:{tool_id}@{tool.get('version')}")

    counts = {
        "raw": len(raw_runs),
        "judge_request": len(judged),
        "consensus": len(anchor_observers),
        "promoted": len(promoted),
        "fixture_pass": len(fixture_runs),
        "judge_calibrated": len(judge_reports),
        "adapter_calibrated": len(adapter_reports),
        "adapter_active": len(active),
    }
    return counts, refs
