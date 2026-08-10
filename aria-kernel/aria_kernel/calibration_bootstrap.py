"""Plan ARIA-V6 §3 V6.2.5 Phase 6.2.5 B-V5-1 — calibration corpus bootstrap.

V6.2's convergent_skill_authoring loop demands an operator-labeled
calibration corpus (≥10 fixtures, TP/FP balanced) to validate the
authored adapter at 100% precision. Today the kernel has 6 SHADOW
adapters but ZERO operator-labeled corpus
(``aria-tools/operator-feedback.jsonl`` is empty). Without corpus,
V6.2 cannot validate ANY adapter — every authoring loop dead-ends at
sandbox_systematic_failure.

This module bootstraps the corpus BEFORE V6.3 seeds fire:

  1. Operator runs each existing SHADOW adapter LIVE on snowball repo
  2. ``record_seeding_findings(tool_id, raw_findings)`` persists the
     raw findings to
     ``aria-tools/operator-feedback-seeding/<tool_id>/raw-findings.jsonl``
  3. Operator walks each raw finding via the CLI helper +
     ``label_finding(tool_id, finding_fingerprint, label, severity,
     evidence)`` for ≥10 entries per adapter
  4. ``finalize_corpus(tool_id)`` migrates labeled rows from the
     seeding ledger to ``aria-tools/operator-feedback.jsonl`` (the
     SSoT corpus consumed by V6.2's sandbox)

Estimated operator effort per V5 audit: 27-38 hours total
(4-8 hours per adapter for domain expert review). The 6 existing
SHADOW adapters under ``tools/aria-adapters/`` are the starting set.

3 V6.2.5 invariants pin the bootstrap contract:

  * I-V6.2.5-01 — corpus presence per existing SHADOW adapter
  * I-V6.2.5-02 — ≥10 labeled fixtures per adapter
  * I-V6.2.5-03 — label freshness ≤ 90 days (forcing function for
                  periodic operator re-review)
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any, TypedDict

from .ledger import append_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


__all__ = [
    "LabelInput",
    "record_seeding_finding",
    "label_finding",
    "finalize_corpus",
    "list_corpus_status",
    "seeding_path",
    "corpus_path",
    "main",
]


_LABEL_VOCAB: frozenset[str] = frozenset({
    "tp", "fp", "true_positive", "false_positive",
})

_SEVERITY_VOCAB: frozenset[str] = frozenset({
    "CRITICAL", "HIGH", "MEDIUM", "LOW",
})


class LabelInput(TypedDict, total=False):
    """Plan ARIA-V6 §3 V6.2.5 — single label entry."""

    finding_fingerprint: str
    label: str
    severity: str
    evidence: str
    note: str


def seeding_path(base_dir: str | Path | None, tool_id: str) -> Path:
    """Path to a tool's raw-findings seeding ledger."""
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", tool_id)[:120] or "tool"
    root = ensure_tools_dir(base_dir)
    out = root / "operator-feedback-seeding" / safe / "raw-findings.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    return out


def corpus_path(base_dir: str | Path | None) -> Path:
    """Canonical operator-labeled corpus path."""
    return ensure_tools_dir(base_dir) / "operator-feedback.jsonl"


def record_seeding_finding(
    *,
    tool_id: str,
    finding: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Persist a raw finding from a LIVE adapter run for later labeling.

    Operator workflow:
      ``aria-kernel adapter-run <tool_id>`` emits findings; this
      function persists each one to the seeding ledger. The operator
      then runs ``label_finding(...)`` on each entry.
    """
    if not tool_id or not isinstance(tool_id, str):
        raise GovernanceError("record_seeding_finding_requires_tool_id")
    fingerprint = str(finding.get("finding_fingerprint") or "")
    if not fingerprint:
        raise GovernanceError(
            "record_seeding_finding_requires_finding_fingerprint"
        )
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "tool_id": tool_id,
        "finding": finding,
        "labeled": False,
    }
    return append_jsonl(seeding_path(base_dir, tool_id), row)


def label_finding(
    *,
    tool_id: str,
    finding_fingerprint: str,
    label: str,
    severity: str,
    evidence: str = "",
    note: str = "",
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Plan ARIA-V6 §3 V6.2.5 — operator-side label entry.

    Append-only label row tied to a seeding-ledger finding by
    ``finding_fingerprint``. ``finalize_corpus(tool_id)`` consumes
    these to mint the canonical corpus.
    """
    if label.lower() not in _LABEL_VOCAB:
        raise GovernanceError(
            f"label_finding_invalid_label: {label!r} "
            f"(must be one of {sorted(_LABEL_VOCAB)})"
        )
    if severity.upper() not in _SEVERITY_VOCAB:
        raise GovernanceError(
            f"label_finding_invalid_severity: {severity!r} "
            f"(must be one of {sorted(_SEVERITY_VOCAB)})"
        )
    label_row = {
        "schema_version": 1,
        "labeled_at": utc_now(),
        "tool_id": tool_id,
        "finding_fingerprint": finding_fingerprint,
        "label": label.lower(),
        "severity": severity.upper(),
        "evidence": evidence,
        "note": note,
    }
    labels_path = seeding_path(base_dir, tool_id).with_name("labels.jsonl")
    return append_jsonl(labels_path, label_row)


def finalize_corpus(
    *,
    tool_id: str,
    base_dir: str | Path | None = None,
    min_labels: int = 10,
) -> dict[str, Any]:
    """Plan ARIA-V6 §3 V6.2.5 — migrate labels to operator-feedback.jsonl.

    Reads the per-tool labels ledger, asserts ≥``min_labels`` entries,
    and appends each label as a corpus fixture to the SSoT corpus
    ``aria-tools/operator-feedback.jsonl``. Returns a summary dict.
    """
    from .strict_jsonl_reader import read_strict_jsonl
    labels_path = seeding_path(base_dir, tool_id).with_name("labels.jsonl")
    if not labels_path.exists():
        raise GovernanceError(
            f"finalize_corpus_labels_not_found: tool_id={tool_id!r}"
        )
    label_rows = list(read_strict_jsonl(labels_path, on_corruption="tolerant"))
    if len(label_rows) < min_labels:
        raise GovernanceError(
            f"finalize_corpus_below_floor: tool_id={tool_id!r} "
            f"labels={len(label_rows)} required={min_labels}"
        )
    corpus = corpus_path(base_dir)
    migrated = 0
    for label_row in label_rows:
        # The corpus row is written in the ONE vocabulary every ground-truth
        # reader speaks. The previous shape carried `label`/`labeled_at` and
        # nothing else — judge_calibration skipped it (source_type not in
        # GROUND_TRUTH_SOURCES), goldset counted it as neither TP nor FP
        # (no `verdict`), FP-suppression never matched it. Every label an
        # operator ever finalized was invisible to every consumer. The
        # original spelling survives as `legacy_label` (append-only history
        # discipline, same as the result-status normalization).
        label_value = str(label_row.get("label") or "").lower()
        verdict = "true_positive" if label_value in ("tp", "true_positive") else "false_positive"
        fixture = {
            "schema_version": 1,
            "recorded_at": label_row.get("labeled_at"),
            "source_type": "human",
            "verdict": verdict,
            "tool_id": tool_id,
            "run_id": label_row.get("run_id") or f"bootstrap:{tool_id}",
            "finding_id": label_row.get("finding_id") or label_row.get("finding_fingerprint"),
            "finding_fingerprint": label_row.get("finding_fingerprint"),
            "severity": str(label_row.get("severity") or "medium").lower(),
            "note": label_row.get("note", ""),
            "evidence_refs": [label_row["evidence"]] if label_row.get("evidence") else [],
            "legacy_label": label_value,
            "labeled_at": label_row.get("labeled_at"),
        }
        append_jsonl(corpus, fixture)
        migrated += 1
    return {
        "tool_id": tool_id,
        "labels_consumed": len(label_rows),
        "fixtures_appended": migrated,
        "corpus_path": str(corpus),
        "status": "ok",
    }


def list_corpus_status(
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Plan ARIA-V6 §3 V6.2.5 — operator-visible corpus health.

    Walks ``operator-feedback.jsonl`` and reports per-tool fixture
    count + latest_label_age_days so the operator can see which
    adapters are below the V6.2.5 floor or about to expire under
    the 90-day freshness rule.
    """
    import datetime as _dt
    from .strict_jsonl_reader import read_strict_jsonl
    corpus = corpus_path(base_dir)
    if not corpus.exists():
        return {"corpus_path": str(corpus), "tools": {}, "status": "empty"}
    rows = list(read_strict_jsonl(corpus, on_corruption="tolerant"))
    per_tool: dict[str, dict[str, Any]] = {}
    now = _dt.datetime.now(_dt.timezone.utc)
    for row in rows:
        tid = str(row.get("tool_id") or "")
        if not tid:
            continue
        bucket = per_tool.setdefault(tid, {
            "fixture_count": 0, "tp_count": 0, "fp_count": 0,
            "latest_label_at": None,
            "latest_label_age_days": None,
        })
        bucket["fixture_count"] += 1
        # Canonical vocabulary first (verdict), legacy spellings as fallback —
        # the corpus now writes verdict/source_type and preserves the old
        # label as legacy_label; a status reader that only spoke the old
        # tongue reported tp_count=0 for every canonical row.
        label = str(row.get("verdict") or row.get("label") or row.get("legacy_label") or "").lower()
        if label in ("tp", "true_positive"):
            bucket["tp_count"] += 1
        elif label in ("fp", "false_positive"):
            bucket["fp_count"] += 1
        labeled_at = row.get("labeled_at")
        if isinstance(labeled_at, str):
            try:
                lt = _dt.datetime.fromisoformat(labeled_at.replace("Z", "+00:00"))
                prev_latest = bucket["latest_label_at"]
                if prev_latest is None or lt > _dt.datetime.fromisoformat(
                    prev_latest.replace("Z", "+00:00")
                ):
                    bucket["latest_label_at"] = labeled_at
                    bucket["latest_label_age_days"] = (now - lt).days
            except ValueError:
                continue
    return {"corpus_path": str(corpus), "tools": per_tool, "status": "ok"}


def main(argv: list[str] | None = None) -> int:
    """Plan ARIA-V6 §3 V6.2.5 — CLI entry point.

    Usage:
      python -m aria_kernel.calibration_bootstrap label \\
        --tool-id <X> --finding-fingerprint <F> \\
        --label tp|fp --severity CRITICAL|HIGH|MEDIUM|LOW \\
        [--evidence "..."] [--note "..."]

      python -m aria_kernel.calibration_bootstrap finalize \\
        --tool-id <X> [--min-labels 10]

      python -m aria_kernel.calibration_bootstrap status
    """
    import argparse
    parser = argparse.ArgumentParser(prog="aria_kernel.calibration_bootstrap")
    sub = parser.add_subparsers(dest="command", required=True)

    p_label = sub.add_parser("label", help="Label one finding")
    p_label.add_argument("--tool-id", required=True)
    p_label.add_argument("--finding-fingerprint", required=True)
    p_label.add_argument("--label", required=True,
                         choices=sorted(_LABEL_VOCAB))
    p_label.add_argument("--severity", required=True,
                         choices=sorted(_SEVERITY_VOCAB))
    p_label.add_argument("--evidence", default="")
    p_label.add_argument("--note", default="")
    p_label.add_argument("--tools-dir", default=None)

    p_final = sub.add_parser("finalize", help="Migrate labels to corpus")
    p_final.add_argument("--tool-id", required=True)
    p_final.add_argument("--min-labels", type=int, default=10)
    p_final.add_argument("--tools-dir", default=None)

    p_stat = sub.add_parser("status", help="Per-tool corpus health")
    p_stat.add_argument("--tools-dir", default=None)

    args = parser.parse_args(argv)

    if args.command == "label":
        result = label_finding(
            tool_id=args.tool_id,
            finding_fingerprint=args.finding_fingerprint,
            label=args.label,
            severity=args.severity,
            evidence=args.evidence,
            note=args.note,
            base_dir=args.tools_dir,
        )
    elif args.command == "finalize":
        result = finalize_corpus(
            tool_id=args.tool_id,
            min_labels=args.min_labels,
            base_dir=args.tools_dir,
        )
    elif args.command == "status":
        result = list_corpus_status(base_dir=args.tools_dir)
    else:
        parser.error("unknown calibration-bootstrap command")
        return 1

    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
