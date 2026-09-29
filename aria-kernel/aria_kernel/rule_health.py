"""Kapalı Döngü D4 — per-RULE health, quarantine, and the repair channel.

WHY: tool-level health existed (tool_health.py) but nothing could see that
ONE rule of a healthy adapter is broken. The first live night proved the
cost: seven false-positive verdicts all diagnosed the same mechanical
matcher defect (a composed decorator the token test cannot see), and those
diagnoses terminated in the feedback ledger — the rule kept firing, the
judges kept re-refuting it, and no repair work item ever existed.

Five read-time derivations (the ledger stores outcomes, never scores):

* `rule_stats` — per (tool_id, rule) TP/FP/judged counts from
  GROUND-TRUTH-BEARING feedback only (operator verdicts and ANCHOR
  consensus — JJ-1; a lone judge's unconfirmed opinion, and now an
  unexamined 2-judge pair, move nothing here — the deliberate contrast
  with tool_health.compute_metrics is documented in ORPHAN-CRITICAL-643).
* `rule_instance_verdicts` — the same ground truth counted by INSTANCE
  instead of by judgment: which distinct fingerprints each rule was
  settled on, each way. `rule_stats` counts JUDGMENTS (an anchor upgrade
  re-judging one fingerprint moves it twice, by design — that is what a
  health rate measures), and CE-1's class verdict must not be reachable
  by re-judging one noisy instance five times. Both derivations walk ONE
  reader (`_ground_truth_rule_rows`) so the two counts can never disagree
  about which rows are ground truth.
* `quarantined_rules` — rules whose measured FP rate crosses the threshold
  with enough evidence; the sampler stops judging their findings.
* `commit_rule_defect_findings` — a quarantined rule auto-commits ONE
  "adapter rule defect" finding citing the adapter source, so "the judges
  say this matcher is broken" finally becomes a repair work item.

Small on purpose — operator preference: files stay short.
"""
from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

from .feedback_store import (
    append_jsonl,
    is_ground_truth_row,
    load_feedback,
    load_jsonl,
    promotions_path,
    raw_findings_path,
)
from .tool_registry import ensure_tools_dir, utc_now

# JJ-1 (ORPHAN-HIGH-731) — the local GROUND_TRUTH_SOURCES frozenset is gone.
# It said "source_type in {human, ai_consensus}", which blessed every 2-judge
# consensus as ground truth, and it was one of FIVE copies of that decision
# scattered across the readers. The predicate now lives once, in
# feedback_store.is_ground_truth_row, so tightening it (as JJ-1 does) reaches
# every reader in one edit instead of four that get forgotten.
MIN_JUDGED_FOR_QUARANTINE = 3
MAX_FP_RATE = 0.75


def _fingerprint_rules(base_dir: str | Path | None) -> dict[str, str]:
    """fingerprint → rule, from the raw ledger (feedback rows carry no rule)."""
    mapping: dict[str, str] = {}
    path = raw_findings_path(base_dir)
    for row in load_jsonl(path) if path.exists() else []:
        fingerprint = str(row.get("finding_fingerprint") or "")
        finding = row.get("finding") if isinstance(row.get("finding"), dict) else {}
        rule = str(finding.get("rule") or "").strip()
        if fingerprint and rule and fingerprint not in mapping:
            mapping[fingerprint] = rule
    return mapping


def _ground_truth_rule_rows(
    base_dir: str | Path | None,
) -> Iterator[tuple[tuple[str, str], str, str]]:
    """((tool_id, rule), verdict, fingerprint) for every ground-truth verdict.

    The single ground-truth reader behind BOTH derivations below. Written
    once for the JJ-1 reason: the eligibility predicate had five copies and
    tightening it reached four of them; a second copy of the "which rows
    count" loop would re-open exactly that seam between the health rate and
    the class verdict computed from it.
    """
    rules_by_fingerprint = _fingerprint_rules(base_dir)
    for row in load_feedback(base_dir=base_dir):
        if not is_ground_truth_row(row):
            continue
        verdict = row.get("verdict")
        if verdict not in ("true_positive", "false_positive"):
            continue
        fingerprint = str(row.get("finding_fingerprint") or "")
        rule = rules_by_fingerprint.get(fingerprint)
        if not rule:
            continue
        yield (str(row.get("tool_id") or ""), rule), str(verdict), fingerprint


def rule_measurements(
    base_dir: str | Path | None = None,
) -> tuple[dict[tuple[str, str], dict[str, int]], dict[tuple[str, str], dict[str, set[str]]]]:
    """(judgment counts, distinct instances) from ONE pass over the ground truth.

    Both per-rule derivations in one walk because the class layer put them
    on the per-RUN path: `record_raw_findings_for_run` resolves suppression
    for every finding a run produces, and each walk parses the whole raw and
    feedback ledgers. The aggregation lives here once; `rule_stats` and
    `rule_instance_verdicts` are the two views of it.
    """
    stats: dict[tuple[str, str], dict[str, int]] = {}
    instances: dict[tuple[str, str], dict[str, set[str]]] = {}
    for key, verdict, fingerprint in _ground_truth_rule_rows(base_dir):
        bucket = stats.setdefault(
            key, {"true_positive": 0, "false_positive": 0, "judged": 0}
        )
        bucket[verdict] += 1
        bucket["judged"] += 1
        seen = instances.setdefault(
            key, {"true_positive": set(), "false_positive": set()}
        )
        seen[verdict].add(fingerprint)
    return stats, instances


def rule_stats(base_dir: str | Path | None = None) -> dict[tuple[str, str], dict[str, int]]:
    """Per (tool_id, rule): {'true_positive', 'false_positive', 'judged'}."""
    return rule_measurements(base_dir)[0]


def rule_instance_verdicts(
    base_dir: str | Path | None = None,
) -> dict[tuple[str, str], dict[str, set[str]]]:
    """Per (tool_id, rule): the DISTINCT instance fingerprints settled each way.

    An INSTANCE is a fingerprint — path and line are hashed into it, so five
    fingerprints are five places in the repository, not one place judged five
    times. CE-1's class verdict is spent against this count and never against
    `rule_stats`' judgment count, because a class verdict suppresses (or
    promotes) every FUTURE instance of the rule and the evidence for that has
    to be breadth across the repo, not depth on one line.
    """
    return rule_measurements(base_dir)[1]


def quarantined_rules(
    base_dir: str | Path | None = None,
    *,
    min_judged: int = MIN_JUDGED_FOR_QUARANTINE,
    max_fp_rate: float = MAX_FP_RATE,
    stats: dict[tuple[str, str], dict[str, int]] | None = None,
) -> set[tuple[str, str]]:
    """Rules whose measured FP rate earns exclusion from judgment sampling.

    `stats` lets a caller that ALREADY measured pass its own table in rather
    than pay for a second walk; the threshold logic stays here, so there is
    still exactly one definition of what quarantine means.
    """
    quarantined: set[tuple[str, str]] = set()
    measured = rule_stats(base_dir) if stats is None else stats
    for key, bucket in measured.items():
        judged = bucket["judged"]
        if judged < min_judged:
            continue
        if bucket["false_positive"] / judged >= max_fp_rate:
            quarantined.add(key)
    return quarantined


def _adapter_source_for(tool_id: str, repo_root: Path) -> str | None:
    """Best-effort repo path of the adapter implementing tool_id."""
    for candidate in (
        f"tools/aria-adapters/{tool_id}.ts",
        f"tools/aria-poc/{tool_id.replace('-', '_')}.py",
    ):
        if (repo_root / candidate).is_file():
            return candidate
    return None


def commit_rule_defect_findings(
    *,
    repo_root: str | Path,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """One committed finding per quarantined rule — the repair work item."""
    from .finding import emit_finding
    from .finding_promotion import promoted_fingerprints

    repo_path = Path(repo_root).resolve()
    root = ensure_tools_dir(base_dir)
    already = promoted_fingerprints(root)
    committed: list[dict[str, Any]] = []
    for tool_id, rule in sorted(quarantined_rules(root)):
        synthetic_fingerprint = f"rule-defect:{tool_id}:{rule}"
        if synthetic_fingerprint in already:
            continue
        adapter_path = _adapter_source_for(tool_id, repo_path)
        if adapter_path is None:
            continue
        bucket = rule_stats(root).get((tool_id, rule), {})
        finding = emit_finding(
            repo_root=repo_path,
            base_dir=root,
            claim_type="wrong_code",
            claim_summary=(
                f"Adapter rule '{rule}' of {tool_id} is quarantined: "
                f"{bucket.get('false_positive', 0)}/{bucket.get('judged', 0)} "
                f"ground-truth verdicts are false positives — the matcher, "
                f"not the code it flags, is the defect"
            ),
            severity="MEDIUM",
            evidences=[{"ref": adapter_path}],
            facts=[
                f"finding_fingerprint={synthetic_fingerprint}",
                f"judged={bucket.get('judged', 0)}",
                f"false_positive={bucket.get('false_positive', 0)}",
            ],
            scope_files=[adapter_path],
            originating_skill="ai_consensus:judgment_pipeline",
        )
        already.add(synthetic_fingerprint)
        append_jsonl(
            promotions_path(root),
            {
                "schema_version": 1,
                "recorded_at": utc_now(),
                "finding_fingerprint": synthetic_fingerprint,
                "finding_id": finding.get("finding_id"),
                "tool_id": tool_id,
                "judgment_group_id": None,
            },
        )
        committed.append({"tool_id": tool_id, "rule": rule, "finding_id": finding.get("finding_id")})
    return {"schema_version": 1, "committed": committed, "committed_count": len(committed)}
