"""Kapalı Döngü D4 — per-RULE health, quarantine, and the repair channel.

WHY: tool-level health existed (tool_health.py) but nothing could see that
ONE rule of a healthy adapter is broken. The first live night proved the
cost: seven false-positive verdicts all diagnosed the same mechanical
matcher defect (a composed decorator the token test cannot see), and those
diagnoses terminated in the feedback ledger — the rule kept firing, the
judges kept re-refuting it, and no repair work item ever existed.

Three read-time derivations (the ledger stores outcomes, never scores):

* `rule_stats` — per (tool_id, rule) TP/FP/judged counts from
  GROUND-TRUTH-BEARING feedback only (human / ai_consensus; a lone judge's
  unconfirmed opinion moves nothing here — the deliberate contrast with
  tool_health.compute_metrics is documented in ORPHAN-CRITICAL-643).
* `quarantined_rules` — rules whose measured FP rate crosses the threshold
  with enough evidence; the sampler stops judging their findings.
* `commit_rule_defect_findings` — a quarantined rule auto-commits ONE
  "adapter rule defect" finding citing the adapter source, so "the judges
  say this matcher is broken" finally becomes a repair work item.

Small on purpose — operator preference: files stay short.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .feedback_store import (
    append_jsonl,
    load_feedback,
    load_jsonl,
    promotions_path,
    raw_findings_path,
)
from .tool_registry import ensure_tools_dir, utc_now

GROUND_TRUTH_SOURCES = frozenset({"human", "ai_consensus"})
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


def rule_stats(base_dir: str | Path | None = None) -> dict[tuple[str, str], dict[str, int]]:
    """Per (tool_id, rule): {'true_positive', 'false_positive', 'judged'}."""
    rules_by_fingerprint = _fingerprint_rules(base_dir)
    stats: dict[tuple[str, str], dict[str, int]] = {}
    for row in load_feedback(base_dir=base_dir):
        if row.get("source_type") not in GROUND_TRUTH_SOURCES:
            continue
        verdict = row.get("verdict")
        if verdict not in ("true_positive", "false_positive"):
            continue
        rule = rules_by_fingerprint.get(str(row.get("finding_fingerprint") or ""))
        if not rule:
            continue
        key = (str(row.get("tool_id") or ""), rule)
        bucket = stats.setdefault(
            key, {"true_positive": 0, "false_positive": 0, "judged": 0}
        )
        bucket[verdict] += 1
        bucket["judged"] += 1
    return stats


def quarantined_rules(
    base_dir: str | Path | None = None,
    *,
    min_judged: int = MIN_JUDGED_FOR_QUARANTINE,
    max_fp_rate: float = MAX_FP_RATE,
) -> set[tuple[str, str]]:
    """Rules whose measured FP rate earns exclusion from judgment sampling."""
    quarantined: set[tuple[str, str]] = set()
    for key, bucket in rule_stats(base_dir).items():
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
