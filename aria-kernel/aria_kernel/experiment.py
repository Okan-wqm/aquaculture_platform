"""E21-a — the experiment bench: hypothesis, recipe, observation.

An experiment is three things and nothing else:

* a **hypothesis** — a sentence the operator or an agent wants tested;
* a **recipe_ref** — a pointer to a DECLARED deterministic command;
* an **observation_contract** — what the recipe's outcome must be
  compared against.

Running an experiment means: resolve its recipe, execute it through the
ONE unified validation-run path, and record the observation.

WHY THIS MODULE KNOWS NO DOMAIN
-------------------------------

The kernel must not learn aquaculture, TypeScript, or Rust. It cannot,
because the only domain-shaped value anywhere in the contract is the
recipe's ``command`` string, and that is DATA the registrant supplies.
The comparator vocabulary (``OBSERVATION_COMPARATORS``) is closed and
speaks only about a process outcome: exit code, run status, log content.
Point a recipe at a Rust test binary and every line below is unchanged —
which is the whole point, because this same bench is meant to run against
a Rust OS later. ``tests/test_experiment_bench.py`` asserts the absence
of domain vocabulary in this file, so the property is checked, not
promised.

RECORD-ONLY IN THIS PHASE
-------------------------

``run_experiment`` records what was expected, what was observed, and
whether they matched. It promotes nothing: no verdict, no belief, no
finding mutation. Promotion is E21-c, and a bench that promotes before
its evidence path is trusted is exactly the readiness-claim defect this
phase exists to end.

WHAT THIS FIXES
---------------

``validation_runs_ledger.record_validation_run`` had NO production
caller — only tests — while ``auto_merge`` and ``validation_matrix_gate``
both READ that ledger to decide whether a change may merge. The merge
requirement was therefore structurally unsatisfiable in production: a
reader with no writer. ``run_experiment`` is a real producer, so
executing an experiment leaves a real, provenance-carrying validation-run
row behind. It refuses to run rather than fabricate provenance.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now
from .validation import run_validation_commands
from .validation_runs_ledger import (
    VALIDATION_RUN_STATUSES,
    classify_validation_run_status,
    find_validation_run_by_id,
)


EXPERIMENTS_DIRNAME = "experiments"

# Closed comparator vocabulary. Each one speaks about a PROCESS OUTCOME,
# never about a domain: that is what keeps the bench portable across the
# repositories it will be pointed at.
OBSERVATION_COMPARATORS: tuple[str, ...] = (
    "exit_code_equals",
    "status_equals",
    "log_sha256_equals",
    "log_contains",
)

_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$")
_SHA256_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")

# Upper bound on a recipe's own timeout. A recipe that may run for an
# unbounded time is not a deterministic experiment, it is a hang.
MAX_RECIPE_TIMEOUT_MS = 3_600_000


def recipes_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / EXPERIMENTS_DIRNAME / "recipes.jsonl"


def experiments_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / EXPERIMENTS_DIRNAME / "experiments.jsonl"


def observations_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / EXPERIMENTS_DIRNAME / "observations.jsonl"


def register_recipe(
    *,
    recipe_id: str,
    command: str,
    timeout_ms: int,
    deterministic: bool,
    description: str | None = None,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    """Declare a recipe: a named, deterministic, executable command.

    The command is NOT validated for domain content here — it is opaque
    data. It IS validated against the execution lane's allowlist at run
    time by ``validation.run_validation_commands``, which is the only
    place that decides what may execute.
    """
    _assert_identifier("recipe_id", recipe_id)
    if not isinstance(command, str) or not command.strip():
        raise GovernanceError("experiment_recipe_command_required")
    if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, int) or timeout_ms <= 0:
        raise GovernanceError(
            f"experiment_recipe_timeout_invalid: expected a positive int, "
            f"got {timeout_ms!r}"
        )
    if timeout_ms > MAX_RECIPE_TIMEOUT_MS:
        raise GovernanceError(
            f"experiment_recipe_timeout_too_large: {timeout_ms} exceeds "
            f"{MAX_RECIPE_TIMEOUT_MS}"
        )
    if not isinstance(deterministic, bool):
        raise GovernanceError(
            f"experiment_recipe_deterministic_must_be_bool: got "
            f"{type(deterministic).__name__}"
        )
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "recipe_id": recipe_id,
        "command": command,
        "timeout_ms": timeout_ms,
        "deterministic": deterministic,
        "description": description,
    }
    return append_declared_jsonl(
        recipes_path(base_dir), row, expected_surface="experiment_recipes",
    )


def list_recipes(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_declared_jsonl(
        recipes_path(base_dir), expected_surface="experiment_recipes",
    )


def get_recipe(
    recipe_id: str, *, base_dir: str | Path | None = None,
) -> dict[str, Any]:
    for row in reversed(list_recipes(base_dir=base_dir)):
        if row.get("recipe_id") == recipe_id:
            return row
    raise GovernanceError(f"experiment_recipe_not_found: {recipe_id!r}")


def register_experiment(
    *,
    experiment_id: str,
    hypothesis: str,
    recipe_ref: str,
    observation_contract: dict[str, Any],
    finding_ref: str | None = None,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    """Declare an experiment against an ALREADY-declared recipe.

    ``recipe_ref`` is resolved at registration, not at run time: an
    experiment pointing at a recipe that does not exist is a hypothesis
    nobody can ever test, and discovering that only when the bench runs
    turns a typo into a mystery.

    E21-c (ORPHAN-693) — ``finding_ref`` binds the experiment to a
    finding AT REGISTRATION. The finding bridge
    (``finding.record_finding_reproduction`` / ``_fix_verification``)
    accepts only observations whose experiment declares this binding, so
    an arbitrary matched run can never be stapled to an arbitrary
    finding after the fact. The format is validated here; EXISTENCE is
    validated by the bridge, which owns the finding store.
    """
    _assert_identifier("experiment_id", experiment_id)
    if not isinstance(hypothesis, str) or not hypothesis.strip():
        raise GovernanceError("experiment_hypothesis_required")
    if finding_ref is not None:
        from .finding import FINDING_ID_RE

        if not isinstance(finding_ref, str) or not FINDING_ID_RE.match(finding_ref):
            raise GovernanceError(
                f"experiment_finding_ref_invalid: {finding_ref!r} must "
                f"match {FINDING_ID_RE.pattern}"
            )
    recipe = get_recipe(recipe_ref, base_dir=base_dir)
    contract = _validated_observation_contract(observation_contract)
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "experiment_id": experiment_id,
        "hypothesis": hypothesis,
        "recipe_ref": recipe["recipe_id"],
        "observation_contract": contract,
        "finding_ref": finding_ref,
    }
    return append_declared_jsonl(
        experiments_path(base_dir), row,
        expected_surface="experiment_definitions",
    )


def list_experiments(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_declared_jsonl(
        experiments_path(base_dir), expected_surface="experiment_definitions",
    )


def get_experiment(
    experiment_id: str, *, base_dir: str | Path | None = None,
) -> dict[str, Any]:
    for row in reversed(list_experiments(base_dir=base_dir)):
        if row.get("experiment_id") == experiment_id:
            return row
    raise GovernanceError(f"experiment_not_found: {experiment_id!r}")


def list_experiment_observations(
    *, base_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    return load_declared_jsonl(
        observations_path(base_dir),
        expected_surface="experiment_observations",
    )


def run_experiment(
    *,
    experiment_id: str,
    workspace_root: str | Path,
    change_id: str,
    commit_sha: str,
    runner_identity: str,
    change_author_identity: str | None = None,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    require_clean_worktree: bool = True,
) -> dict[str, Any]:
    """Resolve → execute through the unified path → record the observation.

    Provenance (``change_id``, ``commit_sha``, ``runner_identity``) is
    REQUIRED and unforgeable: it is forwarded to
    ``run_validation_commands``, which resolves the change against the
    change ledger and the commit against the workspace repository. A
    caller that cannot supply real provenance gets a
    ``GovernanceError`` — the bench never writes a placeholder, because
    a placeholder row is evidence the merge gate would honour.

    Record-only: the returned observation carries ``matched``, and
    nothing in this function promotes it to a verdict or mutates a
    finding.
    """
    experiment = get_experiment(experiment_id, base_dir=base_dir)
    recipe = get_recipe(str(experiment["recipe_ref"]), base_dir=base_dir)
    if not recipe.get("deterministic"):
        raise GovernanceError(
            f"experiment_recipe_not_deterministic: recipe "
            f"{recipe.get('recipe_id')!r} is declared non-deterministic; "
            f"comparing a non-reproducible outcome against an observation "
            f"contract measures noise, not the hypothesis"
        )
    if not isinstance(runner_identity, str) or not runner_identity.strip():
        raise GovernanceError("experiment_runner_identity_required")

    plan = run_validation_commands(
        commands=[str(recipe["command"])],
        workspace_root=workspace_root,
        change_id=change_id,
        commit_sha=commit_sha,
        runner_identity=runner_identity,
        change_author_identity=change_author_identity,
        base_dir=base_dir,
        cycle_id=cycle_id,
        validation_plan_id=experiment_id,
        timeout_ms=int(recipe["timeout_ms"]),
        require_clean_worktree=require_clean_worktree,
    )
    validation_run_ids = list(plan.get("validation_run_ids") or [])
    if len(validation_run_ids) != 1:
        raise GovernanceError(
            f"experiment_run_expected_single_validation_run: got "
            f"{len(validation_run_ids)} for experiment {experiment_id!r}"
        )
    run = find_validation_run_by_id(validation_run_ids[0], base_dir=base_dir)
    if run is None:
        raise GovernanceError(
            f"experiment_validation_run_missing: "
            f"{validation_run_ids[0]!r} was recorded but cannot be read back"
        )

    contract = dict(experiment["observation_contract"])
    observed = _observe(contract["comparator"], run)
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "experiment_id": experiment_id,
        "recipe_ref": recipe["recipe_id"],
        "hypothesis": experiment["hypothesis"],
        "change_id": change_id,
        "commit_sha": commit_sha,
        "runner_identity": runner_identity,
        "validation_run_id": run["validation_run_id"],
        "validation_plan_ref": plan.get("ledger_hash"),
        "comparator": contract["comparator"],
        "expected": contract["expected"],
        "observed": observed,
        "matched": _compare(contract["comparator"], contract["expected"], run),
        "run_status": classify_validation_run_status(run),
    }
    return append_declared_jsonl(
        observations_path(base_dir), row,
        expected_surface="experiment_observations",
    )


def _assert_identifier(field: str, value: str) -> None:
    if not isinstance(value, str) or not _ID_PATTERN.match(value):
        raise GovernanceError(
            f"experiment_{field}_invalid: {value!r} must match "
            f"{_ID_PATTERN.pattern}"
        )


def _validated_observation_contract(
    contract: dict[str, Any],
) -> dict[str, Any]:
    """Reject anything outside the closed comparator vocabulary.

    An open contract would be the seam through which domain knowledge
    (a language, a framework, a repository layout) leaks into the
    kernel, so the vocabulary is closed and each comparator's expected
    value is type-checked here rather than at comparison time.
    """
    if not isinstance(contract, dict):
        raise GovernanceError(
            f"experiment_observation_contract_must_be_object: got "
            f"{type(contract).__name__}"
        )
    comparator = contract.get("comparator")
    if comparator not in OBSERVATION_COMPARATORS:
        raise GovernanceError(
            f"experiment_observation_comparator_unknown: {comparator!r} is "
            f"not one of {OBSERVATION_COMPARATORS}"
        )
    if "expected" not in contract:
        raise GovernanceError("experiment_observation_expected_required")
    expected = contract["expected"]
    if comparator == "exit_code_equals":
        if isinstance(expected, bool) or not isinstance(expected, int):
            raise GovernanceError(
                f"experiment_observation_expected_must_be_int: got "
                f"{expected!r}"
            )
    elif comparator == "status_equals":
        if expected not in VALIDATION_RUN_STATUSES:
            raise GovernanceError(
                f"experiment_observation_expected_must_be_status: got "
                f"{expected!r}, allowed {VALIDATION_RUN_STATUSES}"
            )
    elif comparator == "log_sha256_equals":
        if not isinstance(expected, str) or not _SHA256_PATTERN.match(expected):
            raise GovernanceError(
                f"experiment_observation_expected_must_be_sha256: got "
                f"{expected!r}"
            )
    elif comparator == "log_contains":
        if not isinstance(expected, str) or not expected:
            raise GovernanceError(
                f"experiment_observation_expected_must_be_nonempty_str: got "
                f"{expected!r}"
            )
    unknown = sorted(set(contract) - {"comparator", "expected"})
    if unknown:
        raise GovernanceError(
            f"experiment_observation_contract_unknown_keys: {unknown}"
        )
    return {"comparator": comparator, "expected": expected}


def _observe(comparator: str, run: dict[str, Any]) -> Any:
    """The observed value recorded on the observation row.

    Always small and ledger-safe. ``log_contains`` observes the log's
    content-addressed identity rather than its text: a ledger row is not
    a place to inline a test log, and the hash names the exact bytes the
    substring check ran against.
    """
    if comparator == "exit_code_equals":
        return run.get("exit_code")
    if comparator == "status_equals":
        return classify_validation_run_status(run)
    if comparator in ("log_sha256_equals", "log_contains"):
        return run.get("log_hash")
    raise GovernanceError(
        f"experiment_observation_comparator_unknown: {comparator!r}"
    )


def _compare(comparator: str, expected: Any, run: dict[str, Any]) -> bool:
    if comparator == "log_contains":
        return expected in Path(str(run.get("log_path"))).read_text(
            encoding="utf-8",
        )
    return expected == _observe(comparator, run)


__all__ = [
    "MAX_RECIPE_TIMEOUT_MS",
    "OBSERVATION_COMPARATORS",
    "experiments_path",
    "get_experiment",
    "get_recipe",
    "list_experiment_observations",
    "list_experiments",
    "list_recipes",
    "observations_path",
    "recipes_path",
    "register_experiment",
    "register_recipe",
    "run_experiment",
]
