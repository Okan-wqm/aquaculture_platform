"""The plan contract: what a plan body must carry before it may CONVERGE.

WHY. The first plan the native planning chain ever drove to CONVERGED
(trial ten, 2026-09-12, plan ``flow-85199a4b5051d7b27f16``) could not be
staged: ``apply_engine.stage_converged_plan_for_pr`` refused it for a
plan-authored validation command no operator had declared, and would then
have refused it for carrying no ``architectural_tier``. Both rules were
enforced by the STAGING gate and stated by NO planning contract — not the
planner agent files, not the canonical-envelope knowledge file, not the
envelopes the drainer mints, not the validator prose the model reads back.
By the time the rule fired, the plan was CONVERGED and immutable; the only
outlet was a dead plan. Same class as ARIA-HIGH-078: a gate demanding what
the contract never named.

WHAT. This module is the ONE owner of both rules, rendered from the
constants and the store that enforce them — never retyped:

* :func:`plan_contract_violations` — the check, in the validator vocabulary
  the agent reads back (``PLAN_CONTRACT_REASONS``). ``submit_claim_result``
  refuses a planner envelope on it before acceptance; ``plan_convergence``
  refuses a challenger draft or a structured primary revision on it before
  the event is appended; ``evaluate_plan`` records it as the
  ``plan_contract_complete`` gate row so no writer can reach CONVERGED
  around it; staging keeps its own refusal as the last line.
* :func:`render_plan_contract` — the machine block every planning envelope
  carries (``request.plan_contract``): the tier vocabulary with the
  CLAUDE.md meaning of each tier, and the admissible validation commands for
  THIS store (the canonical executable suite plus every registered recipe).
* :func:`render_plan_contract_rules` — the same rules as prose, appended to
  every delivered agent contract by ``agent_contract``.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .change_ledger import ARCHITECTURAL_TIERS
from .implementation_safety import CANONICAL_VALIDATION_COMMANDS_EXECUTABLE, executable_spelling
from .tool_registry import GovernanceError

PLAN_CONTRACT_SCHEMA_VERSION = 1
PLAN_CONTRACT_GATE = "plan_contract_complete"
# The roles whose response carries a plan body the contract binds. The
# cross-reviewer verifies the claim; it authors none.
PLAN_AUTHORING_ROLES: frozenset[str] = frozenset({"primary_plan", "challenger_plan"})

# CLAUDE.md "Architectural-solution hierarchy", one line per tier, in tier
# order. ``strict=True`` makes a tier added to ARCHITECTURAL_TIERS without a
# meaning here an import-time error rather than a contract that names a tier
# it cannot explain.
_TIER_MEANINGS: tuple[str, ...] = (
    "Make it impossible: the type system, compiler or runtime structurally prevents the wrong behaviour",
    "Make it automatic: the correct behaviour becomes the zero-effort default",
    "Make it detectable: the wrong behaviour is caught at build or test time",
    "Document it: last resort, only when tiers 1-3 are genuinely impossible",
)
ARCHITECTURAL_TIER_MEANINGS: dict[int, str] = dict(zip(ARCHITECTURAL_TIERS, _TIER_MEANINGS, strict=True))

REASON_TIER_MISSING = "plan_architectural_tier_missing"
REASON_TIER_INVALID = "plan_architectural_tier_invalid"
REASON_COMMAND_NOT_DECLARED = "plan_validation_command_not_declared"
REASON_RECIPE_UNKNOWN = "plan_validation_recipe_unknown"
PLAN_CONTRACT_REASONS: tuple[str, ...] = (
    REASON_TIER_MISSING, REASON_TIER_INVALID, REASON_COMMAND_NOT_DECLARED, REASON_RECIPE_UNKNOWN,
)


@dataclass(frozen=True)
class ValidationCommandCatalog:
    """What a plan may declare under ``validation_commands`` on one store."""

    canonical: tuple[str, ...]
    recipes: tuple[dict[str, Any], ...]

    @property
    def by_id(self) -> dict[str, dict[str, Any]]:
        return {str(row["recipe_id"]): row for row in self.recipes}

    @property
    def by_command(self) -> dict[str, dict[str, Any]]:
        return {str(row["command"]): row for row in self.recipes}


def validation_command_catalog(base_dir: str | Path | None) -> ValidationCommandCatalog:
    """The canonical suite plus the store's registered recipes (latest row per id).

    A READ: the store is resolved, never bootstrapped, so judging a plan on a
    store that does not exist yet reads as "no recipes" rather than minting a
    tools root as a side effect of a validation.
    """
    from .experiment import EXPERIMENTS_DIRNAME, list_recipes
    from .tool_registry import tools_dir

    latest: dict[str, dict[str, Any]] = {}
    recipes_file = tools_dir(base_dir) / EXPERIMENTS_DIRNAME / "recipes.jsonl"
    for row in list_recipes(base_dir=base_dir) if recipes_file.is_file() else []:
        latest[str(row.get("recipe_id"))] = row
    return ValidationCommandCatalog(
        canonical=tuple(CANONICAL_VALIDATION_COMMANDS_EXECUTABLE),
        recipes=tuple(latest[key] for key in sorted(latest)),
    )


def resolve_declared_validation_command(
    declared: Any, catalog: ValidationCommandCatalog,
) -> tuple[str | None, dict[str, Any] | None, str | None]:
    """``(command, recipe, violation)`` for one ``validation_commands`` entry.

    The ONE matching rule: a ``recipe_id`` names a registered recipe; a
    ``cmd`` is the canonical suite in either spelling, or a registered
    recipe's command byte-for-byte. Anything else is a violation named in the
    contract vocabulary. An entry with neither resolves to nothing (the plan
    validator already refuses an empty ``cmd``).
    """
    if isinstance(declared, dict):
        raw, recipe_id = declared.get("cmd"), declared.get("recipe_id")
    else:
        raw, recipe_id = declared, None
    if isinstance(recipe_id, str) and recipe_id.strip():
        recipe = catalog.by_id.get(recipe_id.strip())
        if recipe is None:
            return None, None, f"{REASON_RECIPE_UNKNOWN}:{recipe_id.strip()}"
        return str(recipe["command"]), recipe, None
    if isinstance(raw, str) and raw.strip():
        command = executable_spelling(raw)
        if command in catalog.canonical:
            return command, None, None
        recipe = catalog.by_command.get(command) or catalog.by_command.get(raw.strip())
        if recipe is None:
            return None, None, f"{REASON_COMMAND_NOT_DECLARED}:{raw.strip()}"
        return command, recipe, None
    return None, None, None


def architectural_tier_violation(tier: Any, *, required: bool) -> str | None:
    """The tier rule in its one wording — read by the contract check and by
    ``plan_convergence._validate_plan_content`` (which validates a claim that
    IS made on every fold), so a wrong tier is refused in the same words
    wherever it is caught."""
    allowed = ", ".join(str(item) for item in ARCHITECTURAL_TIERS)
    if tier is None:
        return f"{REASON_TIER_MISSING}: plan_content.architectural_tier is required, one of {allowed}" if required else None
    if isinstance(tier, bool) or tier not in ARCHITECTURAL_TIERS:
        return f"{REASON_TIER_INVALID}:{tier!r} is not one of {allowed}"
    return None


def plan_contract_violations(
    plan_content: Any, *, base_dir: str | Path | None, require_tier: bool = True,
) -> list[str]:
    """Every contract rule the body breaks, each in the reason vocabulary.

    ``require_tier=False`` is for a body that is not an architectural claim
    yet (the kernel-synthesized round-1 seed); the tier it DOES carry must
    still be a tier, and its commands must still be declared.
    """
    if not isinstance(plan_content, dict):
        return ["plan_content_absent_or_not_object"]
    violations: list[str] = []
    tier_violation = architectural_tier_violation(plan_content.get("architectural_tier"), required=require_tier)
    if tier_violation is not None:
        violations.append(tier_violation)
    catalog = validation_command_catalog(base_dir)
    declared = plan_content.get("validation_commands")
    for entry in declared if isinstance(declared, list) else []:
        _command, _recipe, violation = resolve_declared_validation_command(entry, catalog)
        if violation is not None:
            violations.append(violation)
    return violations


def require_plan_contract(
    plan_content: Any, *, base_dir: str | Path | None, require_tier: bool = True,
) -> None:
    """Refuse a body that breaks the contract, naming every rule it breaks."""
    violations = plan_contract_violations(plan_content, base_dir=base_dir, require_tier=require_tier)
    if violations:
        raise GovernanceError("plan_contract_violation: " + "; ".join(violations))


def plan_contract_gate(state: dict[str, Any], *, base_dir: str | Path | None) -> dict[str, Any]:
    """The ``plan_contract_complete`` gate row ``evaluate_plan`` records.

    Judges the body that WOULD converge — the hash-verified latest revision —
    so a seed no agent revised, or a prose revision no body reproduces, cannot
    reach CONVERGED: neither could be staged, and a CONVERGED plan that cannot
    be staged is a dead plan the ledger calls done.
    """
    from .plan_convergence import plan_body_from_state

    try:
        body = plan_body_from_state(state)["plan_content"]
    except GovernanceError as exc:
        reasons = ["plan_body_unavailable:" + str(exc).split(":", 1)[0]]
    else:
        reasons = plan_contract_violations(body, base_dir=base_dir)
    return {"gate": PLAN_CONTRACT_GATE, "passed": not reasons, "reasons": reasons}


def render_plan_contract(base_dir: str | Path | None) -> dict[str, Any]:
    """The machine block a planning envelope carries, rendered from the store."""
    return _contract_block(validation_command_catalog(base_dir))


def _contract_block(catalog: ValidationCommandCatalog) -> dict[str, Any]:
    return {
        "schema_version": PLAN_CONTRACT_SCHEMA_VERSION,
        "architectural_tier": {
            "field": "plan_content.architectural_tier",
            "required": True,
            "allowed": list(ARCHITECTURAL_TIERS),
            "meaning": {str(tier): text for tier, text in ARCHITECTURAL_TIER_MEANINGS.items()},
        },
        "validation_commands": {
            "field": "plan_content.validation_commands[]",
            "canonical": list(catalog.canonical),
            "recipes": [
                {"recipe_id": str(row["recipe_id"]), "command": str(row["command"]),
                 "timeout_ms": int(row["timeout_ms"])}
                for row in catalog.recipes
            ],
        },
        "refusal_reasons": list(PLAN_CONTRACT_REASONS),
    }


def render_plan_contract_rules(plan_contract: dict[str, Any] | None = None) -> list[str]:
    """The two rules as prose, in the words the refusal reasons use.

    Store-independent when called without a block (the delivered agent
    contract); with the envelope's block, the store's recipes are listed.
    """
    contract = plan_contract or _contract_block(
        ValidationCommandCatalog(canonical=tuple(CANONICAL_VALIDATION_COMMANDS_EXECUTABLE), recipes=()),
    )
    tiers = contract["architectural_tier"]
    commands = contract["validation_commands"]
    lines = [
        "- `plan_content.architectural_tier` is REQUIRED and must be one of "
        + " | ".join(str(tier) for tier in tiers["allowed"]) + ":",
    ]
    lines.extend(f"  - {tier}: {meaning}" for tier, meaning in tiers["meaning"].items())
    lines.append(
        "- Every `plan_content.validation_commands[]` entry is either `{cmd}` naming one of the admissible"
        " commands below (matched after whitespace is collapsed; the bare `nx ...` form of a canonical"
        " command is read as its `npx nx ...` spelling), or `{recipe_id}` naming a registered recipe."
        " Any other command is refused: the lane runs these outside the implementer sandbox, so the set"
        " is operator-declared."
    )
    lines.append("  - canonical suite (always run; may be declared): "
                 + ", ".join(f"`{command}`" for command in commands["canonical"]))
    recipes = commands.get("recipes") or []
    if plan_contract is None:
        lines.append("  - registered recipes: listed per store in the request envelope's `plan_contract` block")
    elif recipes:
        lines.append("  - registered recipes for this store (`recipe_id` -> command):")
        lines.extend(f"    - `{row['recipe_id']}` -> `{row['command']}`" for row in recipes)
    else:
        lines.append("  - registered recipes for this store: none; only the canonical suite is admissible")
    lines.append("- A plan breaking either rule is refused before acceptance and cannot CONVERGE"
                 f" (gate `{PLAN_CONTRACT_GATE}`); refusal reasons: "
                 + ", ".join(f"`{reason}`" for reason in contract["refusal_reasons"]) + ".")
    return lines


def render_plan_contract_section(plan_contract: Any) -> str:
    """The prompt section for an envelope carrying a ``plan_contract`` block."""
    if not isinstance(plan_contract, dict) or not plan_contract:
        return ""
    return "\n".join([
        "## Plan contract (rendered from aria_kernel.plan_contract; enforced at submit and at CONVERGED)",
        "",
        *render_plan_contract_rules(plan_contract),
    ]) + "\n\n"


__all__ = [
    "ARCHITECTURAL_TIER_MEANINGS",
    "PLAN_AUTHORING_ROLES",
    "PLAN_CONTRACT_GATE",
    "PLAN_CONTRACT_REASONS",
    "PLAN_CONTRACT_SCHEMA_VERSION",
    "REASON_COMMAND_NOT_DECLARED",
    "REASON_RECIPE_UNKNOWN",
    "REASON_TIER_INVALID",
    "REASON_TIER_MISSING",
    "ValidationCommandCatalog",
    "architectural_tier_violation",
    "plan_contract_gate",
    "plan_contract_violations",
    "render_plan_contract",
    "render_plan_contract_rules",
    "render_plan_contract_section",
    "require_plan_contract",
    "resolve_declared_validation_command",
    "validation_command_catalog",
]
