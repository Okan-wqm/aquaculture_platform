"""Plan 033 Faz 033f — typed attack recipes and probe verdicts.

WHY: the LLM never gets network bash. A recipe is a CLOSED list of typed steps
(HTTP, GraphQL, auth-token mutation, MQTT, assertion, positive control, cleanup);
any step carrying shell/script/python/command material is refused at validation.
A recipe must contain a positive control (proves the harness can see a violation)
and an assertion; a failed positive control is HARNESS_ERROR, never a clean result.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

from .scope_policy import RISK_CLASSES

STEP_KINDS = ("http_request", "graphql_operation", "auth_token_mutation", "mqtt_publish", "assertion", "positive_control", "cleanup")
MUTATING_STEPS = ("auth_token_mutation", "mqtt_publish")
MUTATING_METHODS = ("POST", "PUT", "PATCH", "DELETE")
FORBIDDEN_STEP_KEYS = ("shell", "script", "python", "command", "exec", "bash", "eval")
PROBE_VERDICTS = ("VIOLATION_OBSERVED", "NO_VIOLATION_OBSERVED", "INCONCLUSIVE", "HARNESS_ERROR", "TARGET_UNAVAILABLE")
CLAIM_TYPES = ("tenant_isolation_break", "authz_bypass", "idor", "secret_exposure", "rls_gap", "api_input_boundary_break",
               "rate_limit_bypass", "broker_namespace_break", "graphql_effect_bypass")


class RecipeError(ValueError):
    pass


@dataclass(frozen=True)
class Step:
    kind: str
    params: dict[str, Any] = field(default_factory=dict)

    def is_mutation(self) -> bool:
        if self.kind in MUTATING_STEPS:
            return True
        if self.kind == "http_request":
            return str(self.params.get("method", "GET")).upper() in MUTATING_METHODS
        if self.kind == "graphql_operation":
            return str(self.params.get("operation_type", "query")).lower() == "mutation"
        return False


@dataclass(frozen=True)
class AttackRecipe:
    recipe_id: str
    claim_type: str
    risk_class: str
    steps: tuple[Step, ...]

    def validate(self) -> None:
        if self.claim_type not in CLAIM_TYPES:
            raise RecipeError(f"unknown claim type {self.claim_type!r}")
        if self.risk_class not in RISK_CLASSES or self.risk_class == "R4_FORBIDDEN":
            raise RecipeError(f"recipe risk class {self.risk_class!r} not allowed")
        kinds = [s.kind for s in self.steps]
        for step in self.steps:
            if step.kind not in STEP_KINDS:
                raise RecipeError(f"unknown step kind {step.kind!r}")
            for key in step.params:
                if key.lower() in FORBIDDEN_STEP_KEYS:
                    raise RecipeError(f"step {step.kind} carries forbidden material {key!r}")
            if step.is_mutation() and self.risk_class in ("R0_PASSIVE", "R1_BOUNDED_READ"):
                raise RecipeError("a mutating step needs at least R2_SYNTHETIC_MUTATION")
            if step.kind in ("http_request", "graphql_operation") and not step.params.get("host"):
                raise RecipeError(f"{step.kind} must name an explicit host")
        if "positive_control" not in kinds or "assertion" not in kinds:
            raise RecipeError("a recipe needs a positive_control and an assertion")
        if any(s.is_mutation() for s in self.steps) and "cleanup" not in kinds:
            raise RecipeError("a mutating recipe needs a cleanup step")

    @property
    def digest(self) -> str:
        payload = {"recipe_id": self.recipe_id, "claim_type": self.claim_type, "risk_class": self.risk_class,
                   "steps": [{"kind": s.kind, "params": s.params} for s in self.steps]}
        return "sha256:" + hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()

    def hosts(self) -> tuple[str, ...]:
        return tuple(sorted({str(s.params["host"]) for s in self.steps if s.params.get("host")}))


@dataclass(frozen=True)
class StepResult:
    kind: str
    ok: bool
    observed_violation: bool = False
    truncated: bool = False
    target_unavailable: bool = False
    detail: str = ""


def evaluate(results: list[StepResult]) -> tuple[str, str]:
    """Fold step results into a closed verdict. Order of precedence is deliberate:
    a broken harness or an unreachable target can never be read as clean."""
    if any(r.target_unavailable for r in results):
        return "TARGET_UNAVAILABLE", "a step could not reach the target"
    controls = [r for r in results if r.kind == "positive_control"]
    if not controls or any(not (c.ok and c.observed_violation) for c in controls):
        return "HARNESS_ERROR", "positive control missing or did not observe its planted violation"
    if any(r.truncated for r in results):
        return "INCONCLUSIVE", "evidence truncated"
    if any(not r.ok for r in results if r.kind not in ("assertion",)):
        return "INCONCLUSIVE", "a step failed"
    assertions = [r for r in results if r.kind == "assertion"]
    if not assertions:
        return "INCONCLUSIVE", "no assertion evaluated"
    if any(a.observed_violation for a in assertions):
        return "VIOLATION_OBSERVED", "assertion observed a violation"
    return "NO_VIOLATION_OBSERVED", "no violation observed within grant"


__all__ = ["CLAIM_TYPES", "FORBIDDEN_STEP_KEYS", "MUTATING_METHODS", "MUTATING_STEPS", "PROBE_VERDICTS", "STEP_KINDS",
           "AttackRecipe", "RecipeError", "Step", "StepResult", "evaluate"]
