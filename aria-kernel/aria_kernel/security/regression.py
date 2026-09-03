"""Plan 033 Faz 033h — permanent security regressions.

WHY: a fixed vulnerability that can silently come back was never really fixed. Every
closed active finding earns a minimized, synthetic, deterministic regression recipe
that re-runs on the impacted PR and on release campaigns. A regression that cannot run
(lab problem, failed positive control) is NOT a pass — silence is never green.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from ..ledger import append_declared_jsonl, load_declared_jsonl
from ..tool_registry import ensure_tools_dir, utc_now
from .probe import CLAIM_TYPES

REGRESSION_SURFACE = "security_regressions"
REGRESSION_RELPATH: tuple[str, ...] = ("security", "regressions.jsonl")
REGRESSION_SCOPES = ("impacted_pr", "release")
REGRESSION_RESULTS = ("PASS", "REGRESSED", "HARNESS_ERROR")


class RegressionError(ValueError):
    pass


@dataclass(frozen=True)
class RegressionRecipe:
    recipe_id: str
    finding_id: str
    claim_type: str
    recipe_digest: str
    minimized: bool
    synthetic: bool
    deterministic: bool
    scopes: tuple[str, ...]

    def validate(self) -> None:
        if self.claim_type not in CLAIM_TYPES:
            raise RegressionError(f"unknown claim type {self.claim_type!r}")
        if not self.recipe_digest.startswith("sha256:"):
            raise RegressionError("a regression must bind a sealed recipe digest")
        if not (self.minimized and self.synthetic and self.deterministic):
            raise RegressionError("a regression recipe must be minimized, synthetic and deterministic")
        bad = [s for s in self.scopes if s not in REGRESSION_SCOPES]
        if bad or not self.scopes:
            raise RegressionError(f"regression scopes must be a non-empty subset of {REGRESSION_SCOPES}: {self.scopes}")


def register_regression(recipe: RegressionRecipe, *, base_dir: str | Path | None = None) -> dict[str, Any]:
    recipe.validate()
    path = ensure_tools_dir(base_dir).joinpath(*REGRESSION_RELPATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    return append_declared_jsonl(path, {"schema_version": 1, "recorded_at": utc_now(), "event": "registered", **recipe.__dict__},
                                 expected_surface=REGRESSION_SURFACE)


def list_regressions(*, scope: str | None = None, base_dir: str | Path | None = None) -> list[RegressionRecipe]:
    path = ensure_tools_dir(base_dir).joinpath(*REGRESSION_RELPATH)
    if not path.exists():
        return []
    latest: dict[str, RegressionRecipe] = {}
    for row in load_declared_jsonl(path, expected_surface=REGRESSION_SURFACE):
        if row.get("event") != "registered":
            continue
        rec = RegressionRecipe(**{k: (tuple(v) if k == "scopes" else v) for k, v in row.items() if k in RegressionRecipe.__dataclass_fields__})
        latest[rec.recipe_id] = rec
    recipes = list(latest.values())
    if scope is not None:
        recipes = [r for r in recipes if scope in r.scopes]
    return recipes


@dataclass(frozen=True)
class RegressionOutcome:
    recipe_id: str
    result: str
    detail: str


def run_regressions(*, scope: str, runner: Callable[[RegressionRecipe], dict[str, Any]],
                    base_dir: str | Path | None = None) -> list[RegressionOutcome]:
    """`runner` returns {verdict, positive_control_ok}. A missing/failed positive control
    or an errored verdict is HARNESS_ERROR (never a pass); a re-observed violation is REGRESSED."""
    outcomes: list[RegressionOutcome] = []
    path = ensure_tools_dir(base_dir).joinpath(*REGRESSION_RELPATH)
    for recipe in list_regressions(scope=scope, base_dir=base_dir):
        res = runner(recipe)
        verdict = str(res.get("verdict") or "")
        if not res.get("positive_control_ok") or verdict in ("HARNESS_ERROR", "TARGET_UNAVAILABLE", ""):
            outcome = RegressionOutcome(recipe.recipe_id, "HARNESS_ERROR", f"cannot trust run: {verdict or 'no verdict'}")
        elif verdict == "VIOLATION_OBSERVED":
            outcome = RegressionOutcome(recipe.recipe_id, "REGRESSED", "the fixed vulnerability re-appeared")
        else:
            outcome = RegressionOutcome(recipe.recipe_id, "PASS", "no violation observed")
        outcomes.append(outcome)
        append_declared_jsonl(path, {"schema_version": 1, "recorded_at": utc_now(), "event": "run", "scope": scope,
                                     "recipe_id": recipe.recipe_id, "result": outcome.result, "detail": outcome.detail},
                              expected_surface=REGRESSION_SURFACE)
    return outcomes


def all_passed(outcomes: list[RegressionOutcome]) -> bool:
    return bool(outcomes) and all(o.result == "PASS" for o in outcomes)


__all__ = ["REGRESSION_RELPATH", "REGRESSION_RESULTS", "REGRESSION_SCOPES", "REGRESSION_SURFACE", "RegressionError",
           "RegressionOutcome", "RegressionRecipe", "all_passed", "list_regressions", "register_regression", "run_regressions"]
