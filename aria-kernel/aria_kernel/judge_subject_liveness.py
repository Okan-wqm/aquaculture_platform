"""Does a judge request's finding still need THAT judge? The judge lane's own rules (ARIA-HIGH-360).

WHY this module exists. A dead judge envelope keeps its (judgment group,
agent) pair in ``judge_fanout._existing_judge_dispatches`` forever, so the
fan-out never asks that judge about that finding again. The anchor-stale
disposition (``anchor_stale``) is the one place an expired judge request is
asked again, and it asks only while every rule that decides whether the
kernel asks a judge about a finding still says yes. Each "no" is named:

* ``finding_settled``: a ground-truth false positive or a promoted finding,
  the sampler's settled fingerprints (``feedback_store``).
* ``rule_quarantined``: the sampler's quarantine (``rule_health``); the rule
  is the one the request's obligations name.
* ``already_judged``: this judge already answered for the finding
  (``judge_fanout._judged_pairs``), the fan-out's rule.
* ``group_settled``: the judgment group carries a consensus row
  (``judge_fanout._judge_rows_by_group``), the arbiter arms' rule.
* ``finding_not_reported_recently``: no tool run inside the sampler's
  recency window (``feedback_store.SAMPLE_RECENCY_HOURS``) reported the
  finding, so the sampler would not offer it to any judge today.

The recency rule reads the newest raw-finding row for the finding, not the
request's age. Measured 2026-10-07 on the runner store: the anchor window
(``genesis_policy.json`` ``agent_request_anchor.max_age_seconds``, 7 days)
equals the sampling window (168 h), so all 534 expired judge requests were
older than the window, and a rule keyed on the request's age would have
dropped every one. 304 of them name a finding a run reported inside the
last 168 h (49 by fingerprint, 255 by finding id on the 466 requests minted
before fingerprints were threaded): those subjects are live.

Each ledger (feedback, raw findings, promotions) is read at most once per
instance, and only when a request reaches a rule that needs it: review of
PR #1825 measured the first version reloading the feedback ledger four
times per tool and the 34 MB raw-findings ledger twice per sweep. The
newest raw-finding row per finding is kept, so a re-mint rebuilds the
envelope from what the sampler would offer today (``judge_remint``).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping

from .tool_registry import ensure_tools_dir

CLOSED_FINDING_SETTLED = "finding_settled"
CLOSED_RULE_QUARANTINED = "rule_quarantined"
CLOSED_ALREADY_JUDGED = "already_judged"
CLOSED_GROUP_SETTLED = "group_settled"
CLOSED_NOT_REPORTED_RECENTLY = "finding_not_reported_recently"


def _parse_recorded_at(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


class _Reports:
    """The newest valid raw-finding row per fingerprint and per (tool, finding id)."""

    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.by_fingerprint: dict[str, tuple[datetime, dict[str, Any]]] = {}
        self.by_finding_id: dict[tuple[str, str], tuple[datetime, dict[str, Any]]] = {}
        for row in rows:
            # The sampler never offers a finding of an invalid-evidence run.
            if row.get("status") == "invalid_evidence":
                continue
            recorded = _parse_recorded_at(row.get("recorded_at"))
            if recorded is None:
                continue
            fingerprint = str(row.get("finding_fingerprint") or "")
            if fingerprint and (fingerprint not in self.by_fingerprint
                                or recorded > self.by_fingerprint[fingerprint][0]):
                self.by_fingerprint[fingerprint] = (recorded, row)
            key = (str(row.get("tool_id") or ""), str(row.get("finding_id") or ""))
            if key[1] and (key not in self.by_finding_id or recorded > self.by_finding_id[key][0]):
                self.by_finding_id[key] = (recorded, row)

    def newest(self, request: Mapping[str, Any]) -> tuple[datetime, dict[str, Any]] | None:
        """Fingerprint first; finding id for requests minted before fingerprints were threaded."""
        fingerprint = str(request.get("finding_fingerprint") or "")
        if fingerprint and fingerprint in self.by_fingerprint:
            return self.by_fingerprint[fingerprint]
        key = (str(request.get("tool_id") or ""), str(request.get("finding_id") or ""))
        return self.by_finding_id.get(key) if key[1] else None


class JudgeSubjectLiveness:
    """The judge lane's rules, applied to one expired judge request at a time."""

    def __init__(self, *, base_dir: str | Path | None, now: datetime) -> None:
        self._root = ensure_tools_dir(base_dir)
        self._now = now
        self._feedback: list[dict[str, Any]] | None = None
        self._raw: list[dict[str, Any]] | None = None
        self._reports: _Reports | None = None
        self._settled_fingerprints: set[str] | None = None
        self._quarantined: set[tuple[str, str]] | None = None
        self._judged: dict[str, set[tuple[str, str]]] = {}
        self._settled_groups: dict[str, dict[tuple[str, str, str], int]] = {}
        self._findings: dict[str, dict[str, Any]] = {}

    @property
    def root(self) -> Path:
        return self._root

    def closure_reason(self, request: Mapping[str, Any]) -> str | None:
        """Why the finding no longer needs this judge, or None when it does."""
        tool_id = str(request.get("tool_id") or "")
        fingerprint = str(request.get("finding_fingerprint") or "")
        finding_id = str(request.get("finding_id") or "")
        if fingerprint and fingerprint in self._settled():
            return CLOSED_FINDING_SETTLED
        newest = self._report_index().newest(request)
        if newest is None or self._now - newest[0] > self._window():
            return CLOSED_NOT_REPORTED_RECENTLY
        rule = str(self.reported_finding(request).get("rule") or "").strip()
        if rule and (tool_id, rule) in self._quarantine():
            return CLOSED_RULE_QUARANTINED
        agent = str(request.get("target_agent") or "")
        # Fingerprint preferred, finding_id for rows recorded before
        # fingerprints were threaded: the same two keys `_judged_pairs` reads.
        judged = self._judged_pairs(tool_id)
        if any((key, agent) in judged for key in (fingerprint, finding_id) if key):
            return CLOSED_ALREADY_JUDGED
        group_key = (str(request.get("run_id") or ""), finding_id, str(request.get("judgment_group_id") or ""))
        if group_key in self._groups(tool_id):
            return CLOSED_GROUP_SETTLED
        return None

    def reported_finding(self, request: Mapping[str, Any]) -> dict[str, Any]:
        """The finding the newest report holds, resolved as the sampler resolves it ({} when none)."""
        newest = self._report_index().newest(request)
        if newest is None:
            return {}
        row = newest[1]
        cache_key = f"{row.get('run_id')}|{row.get('finding_id')}|{row.get('finding_fingerprint')}"
        if cache_key not in self._findings:
            from .feedback_store import resolve_raw_finding

            self._findings[cache_key] = resolve_raw_finding(row, base_dir=self._root)
        return self._findings[cache_key]

    @staticmethod
    def _window() -> timedelta:
        from .feedback_store import SAMPLE_RECENCY_HOURS

        return timedelta(hours=SAMPLE_RECENCY_HOURS)

    def _feedback_rows(self) -> list[dict[str, Any]]:
        if self._feedback is None:
            from .feedback_store import load_feedback

            self._feedback = load_feedback(base_dir=self._root)
        return self._feedback

    def _raw_rows(self) -> list[dict[str, Any]]:
        if self._raw is None:
            from .feedback_store import load_jsonl, raw_findings_path

            path = raw_findings_path(self._root)
            self._raw = load_jsonl(path) if path.exists() else []
        return self._raw

    def _report_index(self) -> _Reports:
        if self._reports is None:
            self._reports = _Reports(self._raw_rows())
        return self._reports

    def _settled(self) -> set[str]:
        if self._settled_fingerprints is None:
            from .feedback_store import _confirmed_false_positive_fingerprints, _promoted_fingerprints

            self._settled_fingerprints = (
                set(_confirmed_false_positive_fingerprints(self._root, feedback=self._feedback_rows()))
                | _promoted_fingerprints(self._root)
            )
        return self._settled_fingerprints

    def _quarantine(self) -> set[tuple[str, str]]:
        if self._quarantined is None:
            from .rule_health import quarantined_rules

            self._quarantined = set(quarantined_rules(
                self._root, feedback=self._feedback_rows(), raw_findings=self._raw_rows(),
            ))
        return self._quarantined

    def _judged_pairs(self, tool_id: str) -> set[tuple[str, str]]:
        if tool_id not in self._judged:
            from .judge_fanout import _judged_pairs

            self._judged[tool_id] = _judged_pairs(self._root, tool_id, feedback=self._feedback_rows())
        return self._judged[tool_id]

    def _groups(self, tool_id: str) -> dict[tuple[str, str, str], int]:
        if tool_id not in self._settled_groups:
            from .judge_fanout import _judge_rows_by_group

            self._settled_groups[tool_id] = _judge_rows_by_group(
                tool_id, self._root, feedback=self._feedback_rows(),
            )[1]
        return self._settled_groups[tool_id]


__all__ = [
    "CLOSED_ALREADY_JUDGED",
    "CLOSED_FINDING_SETTLED",
    "CLOSED_GROUP_SETTLED",
    "CLOSED_NOT_REPORTED_RECENTLY",
    "CLOSED_RULE_QUARANTINED",
    "JudgeSubjectLiveness",
]
