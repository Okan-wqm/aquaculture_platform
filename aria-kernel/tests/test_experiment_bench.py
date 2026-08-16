"""E21-a — the experiment bench, and the reader-without-writer it closes.

``validation_runs_ledger.record_validation_run`` had no production caller
while ``auto_merge`` and ``validation_matrix_gate`` both READ that ledger
to decide whether a change may merge — a merge requirement that was
structurally unsatisfiable in production. ``run_experiment`` is the
production producer, so the first test here drives the bench and then
asserts the matrix gate's own read is satisfied by what it left behind.

The remaining tests are deliberate breaks: remove the guard, the test
goes red.
"""
from __future__ import annotations

import ast
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel import experiment
from aria_kernel.change_ledger import emit_change_committed, emit_change_planned
from aria_kernel.experiment import (
    get_recipe,
    list_experiment_observations,
    register_experiment,
    register_recipe,
    run_experiment,
)
from aria_kernel.implementation_safety import (
    BashDenylistHit,
    verify_bash_command_allowed,
)
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError
from aria_kernel.validation import (
    ALLOWED_CARGO_SUBCOMMANDS,
    parse_allowed_command,
)
from aria_kernel.validation_matrix_gate import enforce_validation_matrix
from aria_kernel.validation_runs_ledger import (
    list_validation_runs_for_change,
    verify_validation_run,
)

_KERNEL_DIR = Path(__file__).resolve().parents[1] / "aria_kernel"

# The kernel must not learn a domain. Every token below names a product
# domain, a language, or a toolchain — the moment one appears in the
# bench's EXECUTABLE surface (identifiers or non-docstring literals), the
# bench has stopped being portable and E21's "run this same bench against
# a Rust OS later" premise is dead.
_DOMAIN_VOCABULARY: tuple[str, ...] = (
    "aquaculture", "tenant", "farm", "pond", "sensor", "harvest", "batch",
    "typescript", "javascript", "python", "rust", "cargo", "npm", "npx",
    "nx", "jest", "vitest", "eslint", "tsc", "nest", "react",
)


def _git(root: Path, args: list[str]) -> str:
    return subprocess.run(
        ["git", *args], cwd=root, check=True, capture_output=True, text=True,
    ).stdout.strip()


def _executable_tokens(source: str) -> set[str]:
    """Identifiers + non-docstring string literals of a module.

    Docstrings are excluded on purpose: prose may EXPLAIN that the bench
    is meant to run against a Rust OS. Code may not know what Rust is.
    """
    tree = ast.parse(source)
    docstring_nodes: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", [])
            if (
                body
                and isinstance(body[0], ast.Expr)
                and isinstance(body[0].value, ast.Constant)
                and isinstance(body[0].value.value, str)
            ):
                docstring_nodes.add(id(body[0].value))
    tokens: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            tokens.add(node.id)
        elif isinstance(node, ast.Attribute):
            tokens.add(node.attr)
        elif isinstance(node, ast.arg):
            tokens.add(node.arg)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            tokens.add(node.name)
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            if id(node) not in docstring_nodes:
                tokens.add(node.value)
    return tokens


class ExperimentBenchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "workspace"
        self.root.mkdir()
        (self.root / "seed.txt").write_text("seed\n", encoding="utf-8")
        _git(self.root, ["init", "-q"])
        _git(self.root, ["config", "user.email", "aria@example.invalid"])
        _git(self.root, ["config", "user.name", "ARIA"])
        _git(self.root, ["add", "."])
        _git(self.root, ["commit", "-q", "-m", "init"])
        self.commit_sha = _git(self.root, ["rev-parse", "HEAD"])
        self.base = Path(self.tmp.name) / "aria-tools"
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)
        planned = emit_change_planned(
            plan_id="plan-e21-bench",
            finding_id="F-e21-bench",
            intended_affected_files=["seed.txt"],
            intended_validation_refs=["recipe"],
            architectural_tier=1,
            base_dir=self.base,
        )
        self.change_id = planned["change_id"]
        emit_change_committed(
            change_id=self.change_id,
            commit_sha=self.commit_sha,
            actual_affected_files=["seed.txt"],
            base_dir=self.base,
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _recipe(self, **overrides) -> dict:
        payload = dict(
            recipe_id="recipe-help",
            # Opaque DATA to the kernel; the execution lane's allowlist is
            # what decides whether it may run.
            command="python3 -m unittest --help",
            timeout_ms=60_000,
            deterministic=True,
            base_dir=self.base,
        )
        payload.update(overrides)
        return register_recipe(**payload)

    def _experiment(self, **overrides) -> dict:
        payload = dict(
            experiment_id="exp-help",
            hypothesis="the declared recipe exits zero on this tree",
            recipe_ref="recipe-help",
            observation_contract={"comparator": "exit_code_equals", "expected": 0},
            base_dir=self.base,
        )
        payload.update(overrides)
        return register_experiment(**payload)

    def _run(self, **overrides) -> dict:
        payload = dict(
            experiment_id="exp-help",
            workspace_root=self.root,
            change_id=self.change_id,
            commit_sha=self.commit_sha,
            runner_identity="ci-executor:bench",
            change_author_identity="agent:planner-bench",
            base_dir=self.base,
        )
        payload.update(overrides)
        return run_experiment(**payload)

    # ---- the production producer -------------------------------------

    def test_running_an_experiment_satisfies_the_merge_gate_read(self) -> None:
        self._recipe()
        self._experiment()
        observation = self._run()
        self.assertTrue(observation["matched"])
        self.assertEqual(observation["run_status"], "ok")

        # The exact reads auto_merge._evaluate_triple_gate performs.
        runs = list_validation_runs_for_change(self.change_id, base_dir=self.base)
        self.assertEqual(len(runs), 1)
        verify_validation_run(runs[0]["validation_run_id"], base_dir=self.base)

        # And the matrix gate's no-risk evidence requirement, which was
        # unsatisfiable in production because nothing wrote this ledger.
        with patch(
            "aria_kernel.validation_matrix_gate.detect_risk_types_for_change",
            return_value=[],
        ):
            result = enforce_validation_matrix(
                change_id=self.change_id,
                candidate_refs=[],
                base_dir=self.base,
                validation_mode="enforced",
            )
        self.assertTrue(result["passed"])
        self.assertEqual(
            result["verified_validation_run_ids"],
            [runs[0]["validation_run_id"]],
        )

    def test_mismatch_is_recorded_not_raised(self) -> None:
        """Record-only: a falsified hypothesis is evidence, not an error."""
        self._recipe()
        self._experiment(
            observation_contract={"comparator": "exit_code_equals", "expected": 42},
        )
        observation = self._run()
        self.assertFalse(observation["matched"])
        self.assertEqual(observation["expected"], 42)
        self.assertEqual(observation["observed"], 0)

    def test_log_contains_observes_the_hash_not_the_log_text(self) -> None:
        self._recipe()
        self._experiment(
            experiment_id="exp-log",
            observation_contract={"comparator": "log_contains", "expected": "stdout"},
        )
        observation = self._run(experiment_id="exp-log")
        self.assertTrue(observation["matched"])
        self.assertTrue(str(observation["observed"]).startswith("sha256:"))

    # ---- provenance cannot be fabricated -----------------------------

    def test_unknown_change_id_refuses_and_records_nothing(self) -> None:
        self._recipe()
        self._experiment()
        with self.assertRaises(GovernanceError) as ctx:
            self._run(change_id="chg_not_a_real_change")
        self.assertIn("validation_change_id_unknown", str(ctx.exception))
        self.assertEqual(list_experiment_observations(base_dir=self.base), [])

    def test_blank_runner_identity_refuses(self) -> None:
        self._recipe()
        self._experiment()
        with self.assertRaises(GovernanceError) as ctx:
            self._run(runner_identity="  ")
        self.assertIn("experiment_runner_identity_required", str(ctx.exception))

    # ---- the contract is closed ---------------------------------------

    def test_non_deterministic_recipe_cannot_be_run(self) -> None:
        self._recipe(recipe_id="recipe-flaky", deterministic=False)
        self._experiment(experiment_id="exp-flaky", recipe_ref="recipe-flaky")
        with self.assertRaises(GovernanceError) as ctx:
            self._run(experiment_id="exp-flaky")
        self.assertIn("experiment_recipe_not_deterministic", str(ctx.exception))

    def test_unknown_comparator_refused_at_registration(self) -> None:
        self._recipe()
        with self.assertRaises(GovernanceError) as ctx:
            self._experiment(
                observation_contract={"comparator": "looks_right", "expected": 0},
            )
        self.assertIn("experiment_observation_comparator_unknown", str(ctx.exception))

    def test_expected_value_type_is_checked_per_comparator(self) -> None:
        self._recipe()
        with self.assertRaises(GovernanceError) as ctx:
            self._experiment(
                observation_contract={"comparator": "status_equals", "expected": "green"},
            )
        self.assertIn("expected_must_be_status", str(ctx.exception))

    def test_contract_rejects_unknown_keys(self) -> None:
        self._recipe()
        with self.assertRaises(GovernanceError) as ctx:
            self._experiment(
                observation_contract={
                    "comparator": "exit_code_equals",
                    "expected": 0,
                    "unless": "friday",
                },
            )
        self.assertIn("unknown_keys", str(ctx.exception))

    def test_experiment_cannot_reference_an_undeclared_recipe(self) -> None:
        with self.assertRaises(GovernanceError) as ctx:
            self._experiment(recipe_ref="recipe-never-declared")
        self.assertIn("experiment_recipe_not_found", str(ctx.exception))

    def test_recipe_timeout_is_bounded(self) -> None:
        with self.assertRaises(GovernanceError):
            self._recipe(recipe_id="recipe-forever", timeout_ms=0)
        with self.assertRaises(GovernanceError):
            self._recipe(
                recipe_id="recipe-eternity",
                timeout_ms=experiment.MAX_RECIPE_TIMEOUT_MS + 1,
            )

    def test_a_docker_recipe_cannot_execute(self) -> None:
        """The bench adds no new execution authority.

        Production runs on this host and container names collide, so
        ``docker``/``docker compose`` must stay structurally impossible on
        every path. A recipe is opaque DATA — anyone may register one —
        but execution goes through ``run_validation_commands``, whose
        allowlist this change does NOT widen. Deliberate break: add a
        docker prefix to ``validation.ALLOWED_COMMANDS`` and this fails.
        """
        self._recipe(
            recipe_id="recipe-container",
            command="docker compose -f docker-compose.droplet.yml up -d",
        )
        self._experiment(
            experiment_id="exp-container", recipe_ref="recipe-container",
        )
        with self.assertRaises(GovernanceError) as ctx:
            self._run(experiment_id="exp-container")
        self.assertIn("approved allowlist", str(ctx.exception))
        self.assertEqual(
            list_validation_runs_for_change(self.change_id, base_dir=self.base), [],
        )
        # ...and the implementer lane's denylist still refuses it outright,
        # before any allowlist is consulted.
        with self.assertRaises(BashDenylistHit):
            verify_bash_command_allowed(["docker", "compose", "up", "-d"])

    @unittest.skipUnless(shutil.which("cargo"), "cargo is not installed on this host")
    def test_a_rust_recipe_runs_through_the_same_bench(self) -> None:
        """E21-b — the portability claim, executed rather than asserted.

        Before this phase the bench's domain-agnosticism rested on an AST
        check: the kernel names no language, but the execution lane knew
        only JavaScript and Python, so a Rust recipe could not run at all.
        Nothing in ``experiment.py`` changed to make this pass — the recipe
        is DATA and the lane learned one non-mutating verb.

        ``check --help`` is deliberately used here so the assertion is
        about the LANE, not about a compiler on a CI runner: it needs no
        manifest, compiles nothing, and produces no ``target/``.
        """
        self._recipe(recipe_id="recipe-rust", command="cargo check --help")
        self._experiment(experiment_id="exp-rust", recipe_ref="recipe-rust")
        observation = self._run(experiment_id="exp-rust")
        self.assertTrue(observation["matched"])
        self.assertEqual(observation["run_status"], "ok")
        runs = list_validation_runs_for_change(self.change_id, base_dir=self.base)
        self.assertEqual(len(runs), 1)
        verify_validation_run(runs[0]["validation_run_id"], base_dir=self.base)

    def test_latest_recipe_registration_wins(self) -> None:
        self._recipe(timeout_ms=1_000)
        self._recipe(timeout_ms=2_000)
        self.assertEqual(get_recipe("recipe-help", base_dir=self.base)["timeout_ms"], 2_000)

    # ---- the bench knows no domain, and promotes nothing --------------

    def test_bench_executable_surface_carries_no_domain_vocabulary(self) -> None:
        """Deliberate break: hardcode a language or a product noun into
        the bench's code and this fails."""
        tokens = _executable_tokens(
            (_KERNEL_DIR / "experiment.py").read_text(encoding="utf-8"),
        )
        hits = sorted(
            f"{word} in {token!r}"
            for token in tokens
            for word in _DOMAIN_VOCABULARY
            if re.search(rf"(?<![a-z]){word}(?![a-z])", token, re.IGNORECASE)
        )
        self.assertEqual(
            hits, [],
            "the experiment bench's executable surface named a domain; the "
            "domain belongs in recipe DATA, not in the kernel",
        )

    def test_bench_imports_no_promotion_surface(self) -> None:
        """E21-a is record-only. Promotion is E21-c; importing a finding
        or belief writer here is how 'record-only' quietly stops being
        true."""
        tree = ast.parse((_KERNEL_DIR / "experiment.py").read_text(encoding="utf-8"))
        imported: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module.lstrip("."))
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    imported.add(alias.name)
        forbidden = {
            "finding", "finding_promotion", "belief_escalation", "memory",
            "promotion", "verdict", "triage", "confidence",
        }
        self.assertEqual(imported & forbidden, set())


class CargoLaneTests(unittest.TestCase):
    """E21-b — the Rust lane admits verbs that READ and nothing else.

    Every test below is a deliberate break. Widen
    ``validation.ALLOWED_CARGO_SUBCOMMANDS``, delete the ``cargo`` branch
    in ``_validate_command_details``, or drop the ``--config`` refusal, and
    the matching test goes red.

    These run the parser, not cargo: refusal must be provable on a host
    with no Rust toolchain, because a guard that can only be checked where
    the tool happens to exist is a guard that stops being checked.
    """

    def test_non_mutating_verbs_are_admitted(self) -> None:
        for command in ("cargo check -p alarm-core", "cargo test -p alarm-core"):
            with self.subTest(command=command):
                argv, env_updates = parse_allowed_command(command)
                self.assertEqual(argv[0], "cargo")
                self.assertIn(argv[1], ALLOWED_CARGO_SUBCOMMANDS)
                self.assertEqual(env_updates, {})

    def test_mutating_and_unknown_subcommands_are_refused(self) -> None:
        """``install``/``publish``/``run`` change the machine, the registry
        or the world; ``add``/``clean``/``fix`` change the tree; a bare
        ``cargo`` and a toolchain selector name no subcommand at all. None
        of them answers a hypothesis about this repository."""
        for command in (
            "cargo install cargo-audit",
            "cargo publish",
            "cargo run --release",
            "cargo add serde",
            "cargo clean",
            "cargo fix --allow-dirty",
            "cargo",
            "cargo +nightly check",
        ):
            with self.subTest(command=command):
                with self.assertRaises(GovernanceError) as ctx:
                    parse_allowed_command(command)
                self.assertIn(
                    "cargo validation subcommand is not approved",
                    str(ctx.exception),
                )

    def test_config_flag_is_refused_behind_an_allowed_verb(self) -> None:
        """``--config target.<triple>.runner=<argv>`` makes cargo launch a
        program of the caller's choosing, so allowlisting the verb without
        this refusal would allowlist the word and not the behaviour."""
        for command in (
            'cargo test --config target.x86_64-unknown-linux-gnu.runner="/bin/sh"',
            "cargo check --config=net.offline=false",
        ):
            with self.subTest(command=command):
                with self.assertRaises(GovernanceError) as ctx:
                    parse_allowed_command(command)
                self.assertIn(
                    "cargo validation flag is not approved", str(ctx.exception),
                )

    def test_the_lane_stays_narrow(self) -> None:
        """A roster assertion, so widening the lane is a deliberate edit to
        a test rather than an unnoticed line in a tuple."""
        self.assertEqual(ALLOWED_CARGO_SUBCOMMANDS, ("check", "test"))


if __name__ == "__main__":
    unittest.main()
