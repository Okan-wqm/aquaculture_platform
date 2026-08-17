"""X2 (ORPHAN-701) — the night authors its own experiments.

WHY: E21-c gave the kernel a finding↔experiment binding and E21-d a
nightly bench, but `register_experiment(finding_ref=...)` had zero
production callers — the seeder's closed schema rejects the one field
the night planner requires, and both manifest experiments carry green
contracts the planner correctly refuses. The bench ran its first real
night against a structurally empty admissible set.

WHAT: a cycle phase that turns FALSIFIABLE open findings into
red-contract experiments. Falsifiable means a command can prove the
claim wrong: `test_disagreement`, `regression`, `wrong_code` — the
claim types whose truth IS a failing test run. The command derives
from the finding's own service dimension through the SSoT collector,
and the validation allowlist stays the single gate: a service whose
command the lane refuses is DISCLOSED as unauthorable, never worked
around. One experiment per finding, ever (deterministic id + existing
binding check); budgets small and disclosed, like every bench knob.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .tool_registry import GovernanceError, ensure_tools_dir

# Small on purpose: authoring more than the bench can run just builds a
# backlog the planner re-sorts nightly; raising it is a data decision.
MAX_AUTHORED_PER_NIGHT = 5

# The claim types a command can falsify — a red run IS the claim.
FALSIFIABLE_CLAIM_TYPES = frozenset({"test_disagreement", "regression", "wrong_code"})

_SEVERITY_ORDER = {"HIGH": 0, "MEDIUM": 1, "LOW": 2, "INFORMATIONAL": 3}

# The one command shape the validation lane admits for per-project tests
# (validation.py requires run-many/affected after `npx nx`).
_COMMAND_TEMPLATE = (
    "npx nx run-many --target=test --projects={project} "
    "--skip-nx-cache --output-style=stream"
)
_RECIPE_TIMEOUT_MS = 900_000


def author_night_experiments(
    repo_root: str | Path,
    *,
    cycle_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Mint red-contract experiments for falsifiable, unbound findings."""
    from .experiment import (
        get_recipe,
        list_experiments,
        register_experiment,
        register_recipe,
    )
    from .finding import _replay_findings
    from .service_dimension import finding_dimension_paths, service_for_path
    from .validation import parse_allowed_command

    repo_path = Path(repo_root).resolve()
    ensure_tools_dir(base_dir)

    bound_findings = {
        str(row.get("finding_ref"))
        for row in list_experiments(base_dir=base_dir)
        if row.get("finding_ref")
    }

    candidates: list[dict[str, Any]] = []
    unauthorable: list[dict[str, Any]] = []
    deduped: list[str] = []
    for finding_id, doc in _replay_findings(repo_path).items():
        if doc.get("claim_type") not in FALSIFIABLE_CLAIM_TYPES:
            continue
        if doc.get("status") not in ("OPEN", "IN_PROGRESS"):
            continue
        if isinstance(doc.get("reproduction"), dict):
            continue
        if finding_id in bound_findings:
            deduped.append(finding_id)
            continue
        services = sorted({
            service
            for service in (
                service_for_path(path) for path in finding_dimension_paths(doc)
            )
            if service and not service.startswith(("shared:", "web:"))
        })
        if not services:
            unauthorable.append({
                "finding_id": finding_id,
                "reason": "no_service_scoped_paths",
            })
            continue
        command = _COMMAND_TEMPLATE.format(project=services[0])
        try:
            parse_allowed_command(command)
        except GovernanceError as exc:
            # The allowlist is the single gate (İ1) — refusal is disclosed,
            # never worked around with a second command builder.
            unauthorable.append({
                "finding_id": finding_id,
                "reason": f"command_refused:{exc}",
            })
            continue
        candidates.append({
            "finding_id": finding_id,
            "severity": doc.get("severity"),
            "service": services[0],
            "command": command,
        })

    candidates.sort(
        key=lambda c: (_SEVERITY_ORDER.get(str(c.get("severity")), 9), str(c["finding_id"]))
    )
    capped = max(0, len(candidates) - MAX_AUTHORED_PER_NIGHT)
    authored: list[dict[str, Any]] = []
    for candidate in candidates[:MAX_AUTHORED_PER_NIGHT]:
        finding_id = candidate["finding_id"]
        recipe_id = f"recipe-auto-{candidate['service']}"
        try:
            get_recipe(recipe_id, base_dir=base_dir)
        except GovernanceError:
            register_recipe(
                recipe_id=recipe_id,
                command=candidate["command"],
                timeout_ms=_RECIPE_TIMEOUT_MS,
                deterministic=True,
                description=(
                    f"auto-authored per-service test recipe for "
                    f"{candidate['service']} (X2)"
                ),
                base_dir=base_dir,
            )
        experiment_id = f"exp-auto-{finding_id.lower()}"
        register_experiment(
            experiment_id=experiment_id,
            hypothesis=(
                f"finding {finding_id} manifests as a failing test run in "
                f"{candidate['service']}"
            ),
            recipe_ref=recipe_id,
            observation_contract={"comparator": "status_equals", "expected": "failed"},
            finding_ref=finding_id,
            cycle_id=cycle_id,
            base_dir=base_dir,
        )
        authored.append({
            "finding_id": finding_id,
            "experiment_id": experiment_id,
            "recipe_ref": recipe_id,
            "service": candidate["service"],
        })

    return {
        "schema_version": 1,
        "cycle_id": cycle_id,
        "authored": authored,
        "deduped": deduped,
        "unauthorable": unauthorable,
        "capped": capped,
    }
