"""CE-1 — judgement spent on an INSTANCE becomes a verdict on the CLASS.

WHY: every judgement this kernel buys is spent once. A fingerprint hashes
the path and the line, so the twentieth occurrence of one adapter rule is a
brand-new question to suppression and to promotion alike — five anchors can
say "this matcher is wrong" and the sixth instance still costs three judges,
still lands in the operator's queue, and still has to be refuted from
scratch. `rule_health` already measures rules and can silence a broken one,
but quarantine is a health verdict about the MATCHER; it says nothing about
the findings already produced and it cannot promote anything.

The missing record is the class itself: (tool_id, rule) with a lifecycle,
carried on its own append-only surface so a verdict about a class is as
durable and as auditable as a verdict about an instance.

WHAT IS AUTHORITY, AND WHAT IS HISTORY. The lifecycle is DERIVED at read
time (`class_states`) from the ledgers that already hold the outcomes —
`rule_health.rule_measurements` for the health numbers AND the
distinct-instance counts, `rule_health.quarantined_rules` for the matcher
verdict. Nothing here recomputes a statistic rule_health owns. `finding-classes.jsonl` is the TRANSITION log
of that derivation: `record_finding_classes` appends a row only when a
class's state actually changes, so the operator can read WHEN a class
flipped and on what evidence. Enforcement (suppression, sampling,
promotion) reads the derivation, never the ledger — a stale or unpublished
ledger must never be able to suppress a finding class.

THE DECISION RULE, and why it counts what it counts. Five DISTINCT
instances settled the same way by ANCHOR-grade ground truth (JJ-1: an
operator verdict, or a consensus a third judge was minted to refute and
failed to overturn) yields a class verdict. Distinct INSTANCES, not
judgements: re-judging one noisy line five times is depth on one line, and
a verdict that governs every future instance of a rule needs breadth
across the repository. Contradiction does not average out — a class with
five each way is `mixed` and keeps consuming judge budget, because that is
precisely the class nobody understands yet.

WHAT A VERDICT DOES. `confirmed_fp` adds a CLASS layer to the ONE
suppression decision point (`feedback_store.suppression_for`); instance
suppression is untouched and there is deliberately no second suppression
writer. `confirmed_tp` sends the class's remaining instances down the
EXISTING promotion path (`finding_promotion.promote_consensus_findings`),
marked `via_class` so the audit trail never loses which findings a human
(or an anchor) actually looked at. Either verdict stops the class being
sampled, which is the point: judge budget flows to the classes still
uncertain.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .feedback_store import (
    append_jsonl,
    evidence_refs_from_item,
    load_jsonl,
    raw_findings_path,
    suppression_for,
    suppression_layers,
)
from .rule_health import quarantined_rules, rule_instance_verdicts, rule_measurements
from .runtime_artifacts import resolve_finding_from_artifact
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now

# The closed lifecycle vocabulary of a finding class.
#
# `observing` — judged, but not yet enough distinct instances either way.
# `confirmed_tp` / `confirmed_fp` — the class verdict; the two states that
#   change what happens to future instances.
# `mixed` — enough distinct instances BOTH ways. Deliberately not a verdict
#   and deliberately not silence: a class the judges genuinely disagree
#   about is the one worth spending the next judgement on.
# `quarantined` — rule_health's matcher verdict (measured FP rate over the
#   quarantine floor) without the instance breadth a class verdict needs.
#   It already stops sampling via rule_health; it never suppresses, because
#   three judgements on two lines is not evidence about a class.
CLASS_LIFECYCLES = (
    "observing",
    "confirmed_tp",
    "confirmed_fp",
    "mixed",
    "quarantined",
)
# The two lifecycles that ARE a verdict — read by sampling (stop spending
# judges here) and by the suppression/promotion layers.
CLASS_VERDICT_LIFECYCLES = ("confirmed_tp", "confirmed_fp")
MIN_DISTINCT_INSTANCES_FOR_CLASS_VERDICT = 5


def finding_classes_path(base_dir: str | Path | None = None) -> Path:
    """CE-1 — the append-only (tool_id, rule) lifecycle transition ledger."""
    return ensure_tools_dir(base_dir) / "finding-classes.jsonl"


def _lifecycle(*, distinct_tp: int, distinct_fp: int, quarantined: bool) -> str:
    confirmed_tp = distinct_tp >= MIN_DISTINCT_INSTANCES_FOR_CLASS_VERDICT
    confirmed_fp = distinct_fp >= MIN_DISTINCT_INSTANCES_FOR_CLASS_VERDICT
    if confirmed_tp and confirmed_fp:
        return "mixed"
    if confirmed_fp:
        return "confirmed_fp"
    if confirmed_tp:
        return "confirmed_tp"
    return "quarantined" if quarantined else "observing"


def class_states(base_dir: str | Path | None = None) -> dict[tuple[str, str], dict[str, Any]]:
    """Every judged (tool_id, rule) with its lifecycle — the authority.

    The statistics are READ from rule_health, never recomputed here: one
    module owns per-rule measurement, and a second copy of that arithmetic
    is how a report and a gate end up disagreeing about the same rule.
    """
    stats, instances = rule_measurements(base_dir)
    quarantined = quarantined_rules(base_dir, stats=stats)
    states: dict[tuple[str, str], dict[str, Any]] = {}
    for key in sorted(set(stats) | set(instances)):
        tool_id, rule = key
        bucket = stats.get(key, {"true_positive": 0, "false_positive": 0, "judged": 0})
        seen = instances.get(key, {"true_positive": set(), "false_positive": set()})
        distinct_tp = len(seen["true_positive"])
        distinct_fp = len(seen["false_positive"])
        states[key] = {
            "tool_id": tool_id,
            "rule": rule,
            "lifecycle": _lifecycle(
                distinct_tp=distinct_tp,
                distinct_fp=distinct_fp,
                quarantined=key in quarantined,
            ),
            "judged": bucket["judged"],
            "true_positive": bucket["true_positive"],
            "false_positive": bucket["false_positive"],
            "distinct_true_positive_instances": distinct_tp,
            "distinct_false_positive_instances": distinct_fp,
            "min_distinct_instances": MIN_DISTINCT_INSTANCES_FOR_CLASS_VERDICT,
        }
    return states


def classes_with_lifecycle(
    lifecycle: str,
    base_dir: str | Path | None = None,
) -> dict[tuple[str, str], dict[str, Any]]:
    """Classes currently in one lifecycle state (closed vocabulary)."""
    if lifecycle not in CLASS_LIFECYCLES:
        raise GovernanceError(
            f"unknown finding-class lifecycle: {lifecycle!r}; "
            f"valid: {list(CLASS_LIFECYCLES)}"
        )
    return {
        key: state
        for key, state in class_states(base_dir).items()
        if state["lifecycle"] == lifecycle
    }


def confirmed_false_positive_classes(
    base_dir: str | Path | None = None,
) -> dict[tuple[str, str], dict[str, Any]]:
    """The CLASS layer of confirmed-false-positive memory."""
    return classes_with_lifecycle("confirmed_fp", base_dir)


def confirmed_true_positive_classes(
    base_dir: str | Path | None = None,
) -> dict[tuple[str, str], dict[str, Any]]:
    """Classes whose remaining instances promote instead of being re-judged."""
    return classes_with_lifecycle("confirmed_tp", base_dir)


def settled_class_keys(base_dir: str | Path | None = None) -> set[tuple[str, str]]:
    """Classes that carry a verdict — judgment sampling skips them."""
    return {
        key
        for key, state in class_states(base_dir).items()
        if state["lifecycle"] in CLASS_VERDICT_LIFECYCLES
    }


def recorded_class_states(
    base_dir: str | Path | None = None,
) -> dict[tuple[str, str], dict[str, Any]]:
    """The last RECORDED state per class — the ledger's own reader.

    History, not authority: what the transition log says the class was when
    it last changed, which is the question an operator reading the report
    asks ("when did this flip, and on what?").
    """
    latest: dict[tuple[str, str], dict[str, Any]] = {}
    path = finding_classes_path(base_dir)
    for row in load_jsonl(path) if path.exists() else []:
        tool_id = str(row.get("tool_id") or "")
        rule = str(row.get("rule") or "")
        if tool_id and rule:
            latest[(tool_id, rule)] = row
    return latest


_TRANSITION_FIELDS = (
    "lifecycle",
    "judged",
    "true_positive",
    "false_positive",
    "distinct_true_positive_instances",
    "distinct_false_positive_instances",
)


def record_finding_classes(base_dir: str | Path | None = None) -> dict[str, Any]:
    """Append every class whose state changed since it was last recorded.

    Change-only on purpose: an unconditional per-cycle append would grow one
    row per rule per cycle forever and bury the transitions — the only rows
    with information in them — under identical restatements.
    """
    root = ensure_tools_dir(base_dir)
    previous = recorded_class_states(root)
    recorded: list[dict[str, Any]] = []
    for key, state in sorted(class_states(root).items()):
        prior = previous.get(key)
        if prior is not None and all(
            prior.get(field) == state[field] for field in _TRANSITION_FIELDS
        ):
            continue
        row = {
            "schema_version": 1,
            "recorded_at": utc_now(),
            **state,
            "previous_lifecycle": (prior or {}).get("lifecycle"),
        }
        append_jsonl(finding_classes_path(root), row)
        recorded.append(row)
    return {
        "schema_version": 1,
        "recorded": recorded,
        "recorded_count": len(recorded),
    }


def _raw_instances(base_dir: str | Path | None) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    """(raw row, finding) for every raw finding that still carries evidence."""
    out: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for row in load_jsonl(raw_findings_path(base_dir)):
        if row.get("status") == "invalid_evidence":
            continue
        finding = row.get("finding") if isinstance(row.get("finding"), dict) else {}
        if not finding and row.get("artifact_ref"):
            finding = resolve_finding_from_artifact(row, base_dir=base_dir) or {}
        if not finding:
            continue
        out.append((row, finding))
    return out


def class_promotion_candidates(base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    """Remaining instances of every `confirmed_tp` class, in feedback-row shape.

    Shaped like the consensus rows `promote_consensus_findings` already
    walks — the same keys, read by the same code — so a class promotion goes
    through ONE promotion writer and meets the same evidence gate. It
    carries `via_class` and nothing else extra: the audit trail must be able
    to say which findings were promoted because a judge looked at THEM.

    REMAINING is literal: an instance the ground truth already settled —
    either way — is not here. Its own verdict is the more specific fact, and
    a finding a judge examined must never enter the record labelled
    "promoted because five of its siblings were examined".
    """
    root = ensure_tools_dir(base_dir)
    confirmed = confirmed_true_positive_classes(root)
    if not confirmed:
        return []
    judged = rule_instance_verdicts(root)
    layers = suppression_layers(root)
    seen: set[str] = set()
    candidates: list[dict[str, Any]] = []
    for row, finding in _raw_instances(root):
        tool_id = str(row.get("tool_id") or "")
        rule = str(finding.get("rule") or "").strip()
        state = confirmed.get((tool_id, rule))
        if state is None:
            continue
        fingerprint = str(row.get("finding_fingerprint") or "")
        if not fingerprint or fingerprint in seen:
            continue
        settled = judged.get((tool_id, rule), {})
        if fingerprint in settled.get("true_positive", set()) or fingerprint in settled.get(
            "false_positive", set()
        ):
            continue
        if suppression_for(
            tool_id=tool_id, rule=rule, fingerprint=fingerprint, layers=layers,
        ) is not None:
            continue
        seen.add(fingerprint)
        candidates.append(
            {
                "tool_id": tool_id,
                "run_id": str(row.get("run_id") or ""),
                "finding_id": str(row.get("finding_id") or finding.get("id") or ""),
                "judgment_group_id": None,
                "finding_fingerprint": fingerprint,
                "severity": str(finding.get("severity") or "medium"),
                "confidence": None,
                "evidence_refs": evidence_refs_from_item(finding),
                "via_class": {
                    "tool_id": tool_id,
                    "rule": rule,
                    "distinct_true_positive_instances": state[
                        "distinct_true_positive_instances"
                    ],
                },
            },
        )
    return candidates
