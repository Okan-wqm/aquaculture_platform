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
import secrets
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, load_declared_jsonl
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now
from .validation import (
    PROOF_VERDICTS,
    _canonical_input_scope,
    _input_metadata_within_limit,
    admit_red_first,
    prove_red_first,
    run_validation_commands,
)
from .validation_runs_ledger import (
    VALIDATION_RUN_STATUSES,
    classify_validation_run_status,
    find_validation_run_by_id,
    verified_validation_run_output,
)
from .digest import is_sha256_digest


EXPERIMENTS_DIRNAME = "experiments"

# Closed comparator vocabulary. Each one speaks about a PROCESS OUTCOME,
# never about a domain: that is what keeps the bench portable across the
# repositories it will be pointed at. ``proof_verdict_equals`` speaks about a
# PAIR of runs — the red-first prover's verdict (``validation.PROOF_VERDICTS``)
# — so only ``prove_candidate_pin`` observes it; ``run_experiment`` runs one
# command and refuses it.
PROOF_VERDICT_COMPARATOR = "proof_verdict_equals"
OBSERVATION_COMPARATORS: tuple[str, ...] = (
    "exit_code_equals",
    "status_equals",
    "log_sha256_equals",
    "log_contains",
    PROOF_VERDICT_COMPARATOR,
)

# How long each side of a candidate's pin proof may run.
PIN_PROOF_TIMEOUT_MS = 120_000

_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$")

# Upper bound on a recipe's own timeout. A recipe that may run for an
# unbounded time is not a deterministic experiment, it is a hang.
MAX_RECIPE_TIMEOUT_MS = 3_600_000

# D6-R1-SEC-B1 — the recipe ``prove_candidate_pin`` registers for a
# reproduction seat's pin carries ``origin: "seat_pin"``: its command is
# seat-chosen text the kernel runs for that one proof, so it is never
# plan-declarable (``plan_contract.validation_command_catalog``) and never
# rendered into a prompt's trusted contract section. A recipe declared through
# ``register_recipe`` (the operator, the kernel's own authoring) keeps the row
# shape it always had, without the field (§12.12: an omitted option keeps the
# previous row shape). ``is_seat_pin_recipe`` is the one reader.
SEAT_PIN_RECIPE_ORIGIN = "seat_pin"


def recipes_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / EXPERIMENTS_DIRNAME / "recipes.jsonl"


def experiments_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / EXPERIMENTS_DIRNAME / "experiments.jsonl"


def observations_path(base_dir: str | Path | None = None) -> Path:
    return ensure_tools_dir(base_dir) / EXPERIMENTS_DIRNAME / "observations.jsonl"


def _validated_recipe_input_scope(scope: dict[str, Any]) -> dict[str, Any]:
    descriptor = _canonical_input_scope(scope)
    if not _input_metadata_within_limit(descriptor):
        raise GovernanceError("experiment_recipe_input_scope_metadata_limit")
    return descriptor


def register_recipe(
    *,
    recipe_id: str,
    command: str,
    timeout_ms: int,
    deterministic: bool,
    description: str | None = None,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    input_scope: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Declare a recipe: a named, deterministic, executable command.

    The command is NOT validated for domain content here — it is opaque
    data. It IS validated against the execution lane's allowlist at run
    time by ``validation.run_validation_commands``, which is the only
    place that decides what may execute.
    """
    return _append_recipe(
        seat_pin=False, recipe_id=recipe_id, command=command, timeout_ms=timeout_ms,
        deterministic=deterministic, description=description, base_dir=base_dir,
        cycle_id=cycle_id, input_scope=input_scope,
    )


def is_seat_pin_recipe(row: dict[str, Any]) -> bool:
    """Whether the recipe row is a seat pin's (``SEAT_PIN_RECIPE_ORIGIN``);
    a row carrying any other ``origin`` is a named refusal."""
    if "origin" not in row:
        return False
    if row["origin"] != SEAT_PIN_RECIPE_ORIGIN:
        raise GovernanceError(f"experiment_recipe_origin_invalid: {row.get('recipe_id')!r} origin={row['origin']!r}")
    return True


def _append_recipe(
    *,
    seat_pin: bool,
    recipe_id: str,
    command: str,
    timeout_ms: int,
    deterministic: bool,
    description: str | None,
    base_dir: str | Path | None,
    cycle_id: str | None,
    input_scope: dict[str, Any] | None,
) -> dict[str, Any]:
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
    if input_scope is not None:
        row["input_scope"] = _validated_recipe_input_scope(input_scope)
    if seat_pin:
        row["origin"] = SEAT_PIN_RECIPE_ORIGIN
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


def _unknown_input_selection(reason: str, plan_content_hash: str | None) -> dict[str, Any]:
    return {"schema_version": 1, "status": "unknown", "input_scope": None,
            "recipe_sources": [], "plan_content_hash": plan_content_hash, "reason": reason}


def _recipe_input_source(recipe: dict[str, Any], command: str) -> tuple[dict[str, str] | None, str | None]:
    recipe_id, ledger_hash = recipe.get("recipe_id"), recipe.get("ledger_hash")
    try:
        if (not isinstance(recipe_id, str) or len(recipe_id) > 256 or len(recipe_id.encode("utf-8")) > 256
                or len(command) > 4096 or len(command.encode("utf-8")) > 4096):
            return None, "selection_metadata_limit"
    except UnicodeError:
        return None, "selection_metadata_limit"
    if not is_sha256_digest(ledger_hash):
        return None, "selection_source_unavailable"
    return {"recipe_id": recipe_id, "ledger_hash": ledger_hash, "command": command}, None


def _add_recipe_input(
    selection: dict[str, Any] | None, *, recipe: dict[str, Any] | None,
    command: str, plan_content_hash: str | None = None,
) -> dict[str, Any] | None:
    """Accumulate optional inputs from the exact rows command resolution used.

    This bounds the retained selection, not the existing recipe-ledger read.
    Unknown drops every contributor; it never serves a selected prefix.
    """
    if recipe is None or recipe.get("input_scope") is None:
        return selection
    if selection is not None and selection["status"] == "unknown":
        return selection

    def unknown(reason: str) -> dict[str, Any]:
        return _unknown_input_selection(reason, plan_content_hash)

    source, reason = _recipe_input_source(recipe, command)
    if reason is not None:
        return unknown(reason)
    sources = selection["recipe_sources"] if selection is not None else []
    if source in sources:
        return selection
    row_ids = {(row["recipe_id"], row["ledger_hash"]) for row in sources}
    if (source["recipe_id"], source["ledger_hash"]) not in row_ids and len(row_ids) >= 8:
        return unknown("selection_input_limit")
    try:
        scope = _canonical_input_scope(recipe["input_scope"])
    except GovernanceError:
        return unknown("selection_input_unavailable")
    old = selection["input_scope"] if selection is not None else None
    if old is not None:
        if (scope["schema_version"] != old["schema_version"]
                or scope.get("execution_profile", {}).get("kind") != old.get("execution_profile", {}).get("kind")):
            return unknown("selection_incompatible_scope")
        paths = {path for values in old["files"].values() for path in values}
        for role, values in scope["files"].items():
            merged = set(old["files"][role])
            for path in values:
                if path not in paths and len(paths) >= 256:
                    return unknown("selection_input_limit")
                paths.add(path)
                merged.add(path)
            scope["files"][role] = sorted(merged)
        if "execution_profile" in scope:
            modules = set(old["execution_profile"]["modules"])
            for module in scope["execution_profile"]["modules"]:
                if module not in modules and len(modules) >= 8:
                    return unknown("selection_input_limit")
                modules.add(module)
            scope["execution_profile"]["modules"] = sorted(modules)
    result = {"schema_version": 1, "status": "selected", "input_scope": scope,
              "recipe_sources": [*sources, source], "plan_content_hash": plan_content_hash, "reason": None}
    if not _input_metadata_within_limit(result):
        return unknown("selection_metadata_limit")
    return result


def register_experiment(
    *,
    experiment_id: str,
    hypothesis: str,
    recipe_ref: str,
    observation_contract: dict[str, Any],
    finding_ref: str | None = None,
    candidate_ref: str | None = None,
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
    finding after the fact. The ref is OPAQUE DATA here — the bench is
    record-only and must not import the promotion surface (its own
    domain-blindness invariant pins that), so binding validity is owned
    entirely by the bridge and the night planner DISCLOSES refs that
    resolve to no finding instead of silently skipping them.

    D6 — ``candidate_ref`` binds the experiment, the same way and at the
    same moment, to the candidate claim a seat judged (opaque data here
    too): the observation ``prove_candidate_pin`` records answers for that
    candidate and is never stapled to another after the fact.
    """
    _assert_identifier("experiment_id", experiment_id)
    if not isinstance(hypothesis, str) or not hypothesis.strip():
        raise GovernanceError("experiment_hypothesis_required")
    for name, ref in (("finding_ref", finding_ref), ("candidate_ref", candidate_ref)):
        if ref is not None and (not isinstance(ref, str) or not ref.strip()):
            raise GovernanceError(f"experiment_{name}_must_be_nonempty_string")
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
        "candidate_ref": candidate_ref,
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
    input_scope: dict[str, Any] | None = None,
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
    if experiment["observation_contract"]["comparator"] == PROOF_VERDICT_COMPARATOR:
        raise GovernanceError(
            f"experiment_pin_proof_not_a_single_run: experiment {experiment_id!r} "
            f"observes a red-first verdict over two runs; prove_candidate_pin owns it"
        )
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

    selection = None
    selected_scope = input_scope
    if input_scope is None:
        selection = _add_recipe_input(None, recipe=recipe, command=str(recipe["command"]))
        if selection is not None:
            selected_scope = selection["input_scope"]
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
        **({"input_scope": selected_scope} if selected_scope is not None else {}),
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
        "matched": _compare(contract["comparator"], contract["expected"], run, base_dir=base_dir),
        "run_status": classify_validation_run_status(run),
    }
    if selection is not None:
        row["validation_input_selection"] = selection
    return append_declared_jsonl(
        observations_path(base_dir), row,
        expected_surface="experiment_observations",
    )


def prove_candidate_pin(
    *,
    candidate_ref: str,
    pin: dict[str, Any],
    red_at: str,
    green_at: str,
    workspace_root: str | Path,
    runner_identity: str,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    """D6 — the kernel proves a seat's pin and records it for its candidate.

    A reproduction seat never certifies its own red (DESIGN-discovery row
    D6). The kernel admits the proof first (``validation.admit_red_first``:
    test files only, an allowlisted command, two distinct commits it resolves
    itself — a refusal registers nothing), then registers a ``seat_pin``
    recipe for the pin's command (``SEAT_PIN_RECIPE_ORIGIN``: never
    plan-declarable, never in a prompt's contract section) and an
    experiment bound to ``candidate_ref`` AT REGISTRATION, runs
    ``validation.prove_red_first`` at those resolved commits, and appends one
    observation carrying ``candidate_ref``, the verdict, both SHAs and both
    run ids. The observation is ``matched`` only when the verdict is
    ``proven``, and its ``run_status`` and ``validation_run_id`` are the
    red side's: the shape every reader of the observation ledger already
    reads (``evidence_validator``'s R4 binding, the finding bridge, memory),
    so a seat's R4 row naming this recipe is backed by the kernel's run and
    by nothing the seat said.

    What D6 relies on, and what it does not (ARIA-MEDIUM-938 stands): the
    kernel ran the pin itself, in its own worktrees of ``red_at`` and
    ``green_at`` under the validation sandbox, with the pin's admission —
    so a seat cannot change the code under proof, choose the SHAs, pick an
    unlisted command, or report a run that did not happen. It does NOT rely
    on ``failure_reason``: that class is read from text the pin itself
    prints, so a hostile pin can print its way into ``assertion``.
    ``proven`` here catches honest mistakes (an import or collection red is
    ``wrong_reason``); it is not an adversarial boundary, and no promotion
    may treat a seat-written pin's ``proven`` as one on its own.
    """
    if not isinstance(candidate_ref, str) or not candidate_ref.strip():
        raise GovernanceError("experiment_candidate_ref_required")
    _files, command, _signature, shas = admit_red_first(red_at, green_at, pin, workspace_root=workspace_root)
    token = secrets.token_hex(8)
    recipe = _append_recipe(
        seat_pin=True, recipe_id=f"pin-{token}", command=command, timeout_ms=PIN_PROOF_TIMEOUT_MS,
        deterministic=True, description=f"red-first pin for candidate {candidate_ref}",
        base_dir=base_dir, cycle_id=cycle_id, input_scope=None,
    )
    contract = {"comparator": PROOF_VERDICT_COMPARATOR, "expected": "proven"}
    experiment = register_experiment(
        experiment_id=f"pin-proof-{token}",
        hypothesis=(f"the pin is red at {shas['red_at']} and green at {shas['green_at']},"
                    f" as {pin['expectation_ref']} expects"),
        recipe_ref=recipe["recipe_id"], observation_contract=contract,
        candidate_ref=candidate_ref, base_dir=base_dir, cycle_id=cycle_id,
    )
    proof = prove_red_first(
        shas["red_at"], shas["green_at"], pin, workspace_root=workspace_root, runner_identity=runner_identity,
        base_dir=base_dir, timeout_ms=PIN_PROOF_TIMEOUT_MS,
    )
    red = find_validation_run_by_id(proof["red_run_id"], base_dir=base_dir)
    if red is None:
        raise GovernanceError(f"experiment_validation_run_missing: {proof['red_run_id']!r}")
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "experiment_id": experiment["experiment_id"],
        "recipe_ref": recipe["recipe_id"],
        "hypothesis": experiment["hypothesis"],
        "candidate_ref": candidate_ref,
        "proof_id": proof["proof_id"],
        "commit_sha": proof["red_at"],
        "runner_identity": runner_identity,
        "validation_run_id": proof["red_run_id"],
        "comparator": contract["comparator"],
        "expected": contract["expected"],
        "verdict": proof["verdict"],
        "matched": proof["verdict"] == contract["expected"],
        "run_status": classify_validation_run_status(red),
        "red_at": proof["red_at"],
        "green_at": proof["green_at"],
        "red_run_id": proof["red_run_id"],
        "green_run_id": proof["green_run_id"],
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
        if not is_sha256_digest(expected):
            raise GovernanceError(
                f"experiment_observation_expected_must_be_sha256: got "
                f"{expected!r}"
            )
    elif comparator == PROOF_VERDICT_COMPARATOR:
        if expected not in PROOF_VERDICTS:
            raise GovernanceError(
                f"experiment_observation_expected_must_be_proof_verdict: got "
                f"{expected!r}, allowed {PROOF_VERDICTS}"
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


def _compare(comparator: str, expected: Any, run: dict[str, Any], *, base_dir: str | Path | None) -> bool:
    """ARIA-MEDIUM-936 — ``log_contains`` judges what the run PRINTED, read
    through the one reader the red-first prover's signature check uses
    (``validation_runs_ledger.verified_validation_run_output``): the
    runner's header is not output, and one red row is never a hit for the
    bench and ``wrong_reason`` for the prover."""
    if comparator == "log_contains":
        return expected in verified_validation_run_output(str(run["validation_run_id"]), base_dir=base_dir)
    return expected == _observe(comparator, run)


__all__ = [
    "MAX_RECIPE_TIMEOUT_MS",
    "OBSERVATION_COMPARATORS",
    "experiments_path",
    "get_experiment",
    "get_recipe",
    "is_seat_pin_recipe",
    "list_experiment_observations",
    "list_experiments",
    "list_recipes",
    "observations_path",
    "prove_candidate_pin",
    "recipes_path",
    "register_experiment",
    "register_recipe",
    "run_experiment",
]
