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

Ledgers are read at most once per instance (per tool for the feedback
ledger), so one sweep pays for each at most once.
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


class JudgeSubjectLiveness:
    """The judge lane's rules, applied to one expired judge request at a time."""

    def __init__(self, *, base_dir: str | Path | None, now: datetime) -> None:
        self._root = ensure_tools_dir(base_dir)
        self._now = now
        self._settled_fingerprints: set[str] | None = None
        self._quarantined: set[tuple[str, str]] | None = None
        self._judged: dict[str, set[tuple[str, str]]] = {}
        self._settled_groups: dict[str, dict[tuple[str, str, str], int]] = {}
        self._reported: tuple[dict[str, datetime], dict[tuple[str, str], datetime]] | None = None

    def closure_reason(self, request: Mapping[str, Any]) -> str | None:
        """Why the finding no longer needs this judge, or None when it does."""
        tool_id = str(request.get("tool_id") or "")
        fingerprint = str(request.get("finding_fingerprint") or "")
        finding_id = str(request.get("finding_id") or "")
        if fingerprint and fingerprint in self._settled():
            return CLOSED_FINDING_SETTLED
        rule = next(
            (str(item["rule"]) for item in request.get("must_satisfy") or []
             if isinstance(item, dict) and str(item.get("rule") or "").strip()),
            "",
        )
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
        last = self._last_reported(tool_id, fingerprint, finding_id)
        if last is None or self._now - last > self._window():
            return CLOSED_NOT_REPORTED_RECENTLY
        return None

    @staticmethod
    def _window() -> timedelta:
        from .feedback_store import SAMPLE_RECENCY_HOURS

        return timedelta(hours=SAMPLE_RECENCY_HOURS)

    def _settled(self) -> set[str]:
        if self._settled_fingerprints is None:
            from .feedback_store import _confirmed_false_positive_fingerprints, _promoted_fingerprints

            self._settled_fingerprints = (
                set(_confirmed_false_positive_fingerprints(self._root)) | _promoted_fingerprints(self._root)
            )
        return self._settled_fingerprints

    def _quarantine(self) -> set[tuple[str, str]]:
        if self._quarantined is None:
            from .rule_health import quarantined_rules

            self._quarantined = set(quarantined_rules(self._root))
        return self._quarantined

    def _judged_pairs(self, tool_id: str) -> set[tuple[str, str]]:
        if tool_id not in self._judged:
            from .judge_fanout import _judged_pairs

            self._judged[tool_id] = _judged_pairs(self._root, tool_id)
        return self._judged[tool_id]

    def _groups(self, tool_id: str) -> dict[tuple[str, str, str], int]:
        if tool_id not in self._settled_groups:
            from .judge_fanout import _judge_rows_by_group

            self._settled_groups[tool_id] = _judge_rows_by_group(tool_id, self._root)[1]
        return self._settled_groups[tool_id]

    def _last_reported(self, tool_id: str, fingerprint: str, finding_id: str) -> datetime | None:
        """The newest raw-finding row that reported this finding, by fingerprint first."""
        if self._reported is None:
            self._reported = self._index_raw_findings()
        by_fingerprint, by_finding_id = self._reported
        if fingerprint and fingerprint in by_fingerprint:
            return by_fingerprint[fingerprint]
        return by_finding_id.get((tool_id, finding_id)) if finding_id else None

    def _index_raw_findings(self) -> tuple[dict[str, datetime], dict[tuple[str, str], datetime]]:
        from .feedback_store import load_jsonl, raw_findings_path

        by_fingerprint: dict[str, datetime] = {}
        by_finding_id: dict[tuple[str, str], datetime] = {}
        path = raw_findings_path(self._root)
        for row in load_jsonl(path) if path.exists() else []:
            # The sampler never offers a finding of an invalid-evidence run.
            if row.get("status") == "invalid_evidence":
                continue
            recorded = _parse_recorded_at(row.get("recorded_at"))
            if recorded is None:
                continue
            fingerprint = str(row.get("finding_fingerprint") or "")
            if fingerprint and (fingerprint not in by_fingerprint or recorded > by_fingerprint[fingerprint]):
                by_fingerprint[fingerprint] = recorded
            key = (str(row.get("tool_id") or ""), str(row.get("finding_id") or ""))
            if key[1] and (key not in by_finding_id or recorded > by_finding_id[key]):
                by_finding_id[key] = recorded
        return by_fingerprint, by_finding_id


__all__ = [
    "CLOSED_ALREADY_JUDGED",
    "CLOSED_FINDING_SETTLED",
    "CLOSED_GROUP_SETTLED",
    "CLOSED_NOT_REPORTED_RECENTLY",
    "CLOSED_RULE_QUARANTINED",
    "JudgeSubjectLiveness",
]
