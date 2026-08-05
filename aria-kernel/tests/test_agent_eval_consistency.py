"""Regression: consistency_score operator-precedence fix (2026-08-05).

The original expression `(1.0 if passed else 0.0 - mean) ** 2` bound the
conditional over the whole subtraction, so every PASSING run contributed a
constant 1.0 to the variance and a perfectly consistent agent scored ~0.
Latent while runs.jsonl was empty; these tests are red against the buggy
expression and green against the parenthesised stdev form.
"""
from __future__ import annotations

import json
from pathlib import Path

from aria_kernel.agent_eval import aggregate_eval_metrics
from aria_kernel.tool_registry import ensure_tools_dir


def _seed_runs(tools: Path, agent: str, passes: list[bool]) -> Path:
    root = ensure_tools_dir(tools / "aria-tools")
    p = root / "agent-evals" / "runs.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    rows = [
        {
            "target_agent": agent,
            "passed": ok,
            "recorded_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
            "rounds": 1,
            "tokens": 10,
            "verdict_class_expected": "x",
            "verdict_class_actual": "x" if ok else "y",
        }
        for ok in passes
    ]
    p.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
    return root


def test_all_passing_agent_is_perfectly_consistent(tmp_path: Path) -> None:
    root = _seed_runs(tmp_path, "a1", [True] * 10)
    m = aggregate_eval_metrics(target_agent="a1", base_dir=root)
    assert m["pass_rate"] == 1.0
    # Buggy expression yielded consistency 0.0 here (variance == pass_rate).
    assert m["consistency_score"] == 1.0


def test_half_passing_agent_has_binary_stdev_consistency(tmp_path: Path) -> None:
    root = _seed_runs(tmp_path, "a2", [True] * 5 + [False] * 5)
    m = aggregate_eval_metrics(target_agent="a2", base_dir=root)
    # stdev of a fair binary series is 0.5 -> consistency 0.5.
    assert abs(m["consistency_score"] - 0.5) < 1e-9
