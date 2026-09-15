"""ARIA-MEDIUM-066 — a validation child's environment is built, not copied.

Every test here fails on the pre-fix ``{**os.environ, **env_updates}`` spawn:

* the durable store's bindings (``ARIA_TOOLS_DIR`` / ``ARIA_WORKSPACE_BASE`` /
  ``ARIA_REPO_STATE_ROOT`` / ``ARIA_STATE_STORE_ROOT``) never reach the child
  and are reported by name as withheld;
* a secret-shaped inherited name never reaches the child, even under an
  admitted toolchain prefix, and is reported by name;
* names that are dangerous without being secret-shaped (a publish step's
  ``GIT_CONFIG_VALUE_0`` header, a hook's ``GIT_DIR``, the orchestrator's
  ``ARIA_JOB_DEADLINE_EPOCH``, npm's ``_authToken`` spelling) are dropped by
  the closed allowlist;
* PATH / HOME / PYTHONPATH, the toolchain knobs and the variable the command
  itself declared DO reach the child, and the declared one wins;
* the report carries names only;
* the withheld set IS the set ``state_store.store_environment`` exports;
* ``validation.py`` references ``os.environ`` exactly once — as the base the
  builder filters — so a copied-env spawn cannot come back unnoticed.
"""
from __future__ import annotations

import ast
import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel import validation
from aria_kernel.agent_env import BASELINE_ENV_NAMES
from aria_kernel.state_store import STORE_ENVIRONMENT_NAMES, StateStore, store_environment
from aria_kernel.tool_registry import GovernanceError
from aria_kernel.validation_env import (
    VALIDATION_BASELINE_ENV_NAMES,
    VALIDATION_TOOLCHAIN_ENV_PREFIXES,
    build_validation_env,
)
from aria_kernel.validation_runs_ledger import _validated_spawn_environment

# A runner-job-shaped environment: what a cycle step actually carries after
# restore-aria-state, the publish credential, a git hook and the operator's
# shell have all had their say. Values are tagged so a leak is greppable.
_RUNNER_ENV = {
    "PATH": "/usr/bin:/bin", "HOME": "/home/runner", "USER": "runner", "LANG": "C.UTF-8",
    "TMPDIR": "/tmp/runner", "TZ": "UTC", "CI": "true",
    "PYTHONPATH": "aria-kernel", "PYTHONHASHSEED": "0", "PYTHONDONTWRITEBYTECODE": "1",
    "NODE_OPTIONS": "--max-old-space-size=4096", "NX_DAEMON": "false", "NX_NO_CLOUD": "true",
    "CARGO_HOME": "/home/runner/.cargo", "RUSTFLAGS": "-D warnings", "RUST_BACKTRACE": "1",
    "GIT_CONFIG_GLOBAL": "/tmp/hermetic.gitconfig", "GIT_CONFIG_SYSTEM": "/dev/null",
    # The durable store's bindings — the finding's leak.
    "ARIA_TOOLS_DIR": "/store/tools-LEAKVALUE01", "ARIA_WORKSPACE_BASE": "/store/workspace-LEAKVALUE02",
    "ARIA_REPO_STATE_ROOT": "/store/findings-LEAKVALUE03", "ARIA_STATE_STORE_ROOT": "/store-LEAKVALUE04",
    # Runtime facts and other ARIA knobs a validation child must not read.
    "ARIA_JOB_DEADLINE_EPOCH": "1700000000", "ARIA_DRY_RUN": "1", "IS_SANDBOX": "1",
    # Secret-shaped, including under admitted toolchain prefixes.
    "GH_TOKEN": "ghp_LEAKVALUE05", "ANTHROPIC_API_KEY": "sk-LEAKVALUE06", "ARIA_LEASE_TOKEN": "LEAKVALUE07",
    "NX_CLOUD_ACCESS_TOKEN": "nx-LEAKVALUE08", "CARGO_REGISTRY_TOKEN": "cargo-LEAKVALUE09",
    "NODE_AUTH_TOKEN": "node-LEAKVALUE10", "SOME_PASSWORD": "pw-LEAKVALUE11",
    # Dangerous without being secret-shaped.
    "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
    "GIT_CONFIG_VALUE_0": "AUTHORIZATION: basic LEAKVALUE12",
    "GIT_DIR": "/hook/repo/.git-LEAKVALUE13", "GIT_WORK_TREE": "/hook/repo-LEAKVALUE14",
    "npm_config_//registry.npmjs.org/:_authToken": "npm-LEAKVALUE15",
    "GITHUB_ACTIONS": "true", "RUNNER_TEMP": "/tmp/runner-work", "OPERATOR_NOTE": "plain",
}
_STORE_BINDINGS = ("ARIA_REPO_STATE_ROOT", "ARIA_STATE_STORE_ROOT", "ARIA_TOOLS_DIR", "ARIA_WORKSPACE_BASE")


class BuildValidationEnvTests(unittest.TestCase):
    def test_store_bindings_never_reach_the_child_and_are_reported_by_name(self) -> None:
        built = build_validation_env(_RUNNER_ENV)
        for name in _STORE_BINDINGS:
            self.assertNotIn(name, built.env, name)
        self.assertEqual(built.report.dropped_store_bindings, _STORE_BINDINGS)
        # Nothing else ARIA-flavoured crosses either: the job deadline that
        # made the kernel suite "flake" (ARIA-HIGH-038), dry-run, sandbox facts.
        self.assertFalse([name for name in built.env if name.startswith("ARIA_")])
        self.assertNotIn("IS_SANDBOX", built.env)

    def test_secret_shaped_names_never_reach_the_child_even_under_an_admitted_prefix(self) -> None:
        built = build_validation_env(_RUNNER_ENV)
        # GIT_CONFIG_KEY_0 is the shared regex's honest verdict (a ``_KEY_``
        # segment); its VALUE_0 sibling is the one the shape cannot see.
        secrets = ("ANTHROPIC_API_KEY", "ARIA_LEASE_TOKEN", "CARGO_REGISTRY_TOKEN", "GH_TOKEN",
                   "GIT_CONFIG_KEY_0", "NODE_AUTH_TOKEN", "NX_CLOUD_ACCESS_TOKEN", "SOME_PASSWORD")
        for name in secrets:
            self.assertNotIn(name, built.env, name)
        self.assertEqual(built.report.dropped_secret_shaped, secrets)

    def test_dangerous_names_without_a_secret_shape_are_dropped_by_the_closed_allowlist(self) -> None:
        built = build_validation_env(_RUNNER_ENV)
        for name in ("GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_DIR", "GIT_WORK_TREE",
                     "npm_config_//registry.npmjs.org/:_authToken", "GITHUB_ACTIONS", "RUNNER_TEMP", "OPERATOR_NOTE"):
            self.assertNotIn(name, built.env, name)
        self.assertFalse(any("LEAKVALUE" in value for value in built.env.values()), built.env)

    def test_plumbing_toolchain_knobs_and_the_declared_variable_reach_the_child(self) -> None:
        built = build_validation_env(_RUNNER_ENV, declared={"PYTHONPATH": "/recipe/declared"})
        for name in ("PATH", "HOME", "USER", "LANG", "TMPDIR", "TZ", "CI",
                     "PYTHONHASHSEED", "PYTHONDONTWRITEBYTECODE", "NODE_OPTIONS", "NX_DAEMON", "NX_NO_CLOUD",
                     "CARGO_HOME", "RUSTFLAGS", "RUST_BACKTRACE", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"):
            self.assertEqual(built.env[name], _RUNNER_ENV[name], name)
        # The recipe's declaration wins over the inherited value of the same name.
        self.assertEqual(built.env["PYTHONPATH"], "/recipe/declared")
        self.assertEqual(built.report.declared, ("PYTHONPATH",))
        self.assertIn("PYTHONPATH", built.report.passed)
        self.assertEqual(set(built.report.passed), set(built.env))
        # Without a declaration the inherited PYTHONPATH is what the child sees.
        self.assertEqual(build_validation_env(_RUNNER_ENV).env["PYTHONPATH"], "aria-kernel")
        self.assertEqual(build_validation_env(_RUNNER_ENV).report.declared, ())

    def test_report_carries_names_only_and_counts_every_drop(self) -> None:
        built = build_validation_env(_RUNNER_ENV, declared={"PYTHONPATH": "/recipe/declared-LEAKVALUE16"})
        ledger = built.report.to_ledger()
        encoded = json.dumps(ledger)
        self.assertNotIn("LEAKVALUE", encoded)
        self.assertNotIn("/", encoded)
        self.assertEqual(ledger["schema_version"], 1)
        self.assertEqual(ledger["dropped_count"], sum(1 for name in _RUNNER_ENV if name not in built.env))
        self.assertGreater(ledger["dropped_count"], len(_STORE_BINDINGS))
        self.assertEqual(ledger["dropped_store_bindings"], list(_STORE_BINDINGS))
        self.assertEqual(ledger["declared"], ["PYTHONPATH"])
        self.assertEqual(ledger["passed"], sorted(built.env))
        # The ledger writer admits exactly this shape.
        self.assertEqual(_validated_spawn_environment(ledger), ledger)

    def test_policy_is_closed_and_agent_baseline_is_a_subset(self) -> None:
        self.assertTrue(set(BASELINE_ENV_NAMES) <= set(VALIDATION_BASELINE_ENV_NAMES))
        self.assertNotIn("ARIA_JOB_DEADLINE_EPOCH", VALIDATION_BASELINE_ENV_NAMES)
        self.assertFalse(any(prefix.startswith("ARIA") for prefix in VALIDATION_TOOLCHAIN_ENV_PREFIXES))
        # An empty runner yields an empty child, not a default.
        self.assertEqual(build_validation_env({}).env, {})
        self.assertEqual(build_validation_env({}).report.dropped_count, 0)


class LedgerColumnShapeTests(unittest.TestCase):
    def _report(self, **overrides: object) -> dict:
        report = build_validation_env(_RUNNER_ENV, declared={"PYTHONPATH": "x"}).report.to_ledger()
        report.update(overrides)
        return report

    def test_writer_refuses_a_value_disguised_as_a_name(self) -> None:
        for bad in (["PATH=/usr/bin"], ["not ascii é"], [""], ["x" * 257], ["B", "A"], ["A", "A"], "PATH", [1]):
            with self.subTest(bad=bad), self.assertRaises(GovernanceError) as ctx:
                _validated_spawn_environment(self._report(passed=bad))
            self.assertIn("validation_spawn_environment_invalid:passed", str(ctx.exception))

    def test_writer_refuses_a_foreign_or_missing_key(self) -> None:
        with self.assertRaises(GovernanceError):
            _validated_spawn_environment(self._report(values={"PATH": "/usr/bin"}))
        report = self._report()
        del report["dropped_store_bindings"]
        with self.assertRaises(GovernanceError):
            _validated_spawn_environment(report)
        with self.assertRaises(GovernanceError):
            _validated_spawn_environment(self._report(dropped_count=-1))
        with self.assertRaises(GovernanceError):
            _validated_spawn_environment(self._report(schema_version=2))


class StoreBindingSingleSourceTests(unittest.TestCase):
    def test_withheld_names_are_exactly_what_the_store_exports(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = StateStore(root=Path(tmp) / "store", branch="aria/state", repo_root=Path(tmp) / "repo",
                               remote="origin", bootstrapped=True)
            exported = store_environment(store, "0" * 16)
        self.assertEqual(set(exported), set(STORE_ENVIRONMENT_NAMES))
        self.assertEqual(sorted(STORE_ENVIRONMENT_NAMES), list(_STORE_BINDINGS))


class AuthoritySurfaceTests(unittest.TestCase):
    def test_the_validation_envelope_is_an_authority_surface(self) -> None:
        """A self-change may not widen what its own validation children see —
        the same rule ``self_improvement`` already applies to ``agent_env``."""
        from aria_kernel.self_improvement import AUTHORITY_SURFACES, authority_surface_violations

        self.assertIn("aria-kernel/aria_kernel/validation_env.py", AUTHORITY_SURFACES)
        self.assertEqual(authority_surface_violations(["aria-kernel/aria_kernel/validation_env.py"]),
                         ["authority_surface:aria-kernel/aria_kernel/validation_env.py"])


class SpawnSeamInvariantTests(unittest.TestCase):
    def test_validation_module_reads_os_environ_only_as_the_builder_base(self) -> None:
        """A copied environment cannot come back: the one ``os.environ`` in
        ``validation.py`` is the mapping ``build_validation_env`` filters."""
        tree = ast.parse(Path(validation.__file__).read_text(encoding="utf-8"))
        parents = {child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}
        reads = [node for node in ast.walk(tree)
                 if isinstance(node, ast.Attribute) and node.attr == "environ"
                 and isinstance(node.value, ast.Name) and node.value.id == "os"]
        self.assertEqual(len(reads), 1, [ast.dump(node) for node in reads])
        call = parents[reads[0]]
        self.assertIsInstance(call, ast.Call)
        self.assertEqual(getattr(call.func, "id", None), "build_validation_env")
        # The spawn hands subprocess the BUILT mapping, never a literal.
        spawns = [node for node in ast.walk(tree) if isinstance(node, ast.Call)
                  and isinstance(node.func, ast.Attribute) and node.func.attr == "run"
                  and isinstance(node.func.value, ast.Name) and node.func.value.id == "subprocess"
                  and any(kw.arg == "env" for kw in node.keywords)]
        self.assertEqual(len(spawns), 1)
        env_kw = next(kw for kw in spawns[0].keywords if kw.arg == "env")
        self.assertIsInstance(env_kw.value, ast.Attribute)
        self.assertEqual(env_kw.value.attr, "env")
        self.assertEqual(getattr(env_kw.value.value, "id", None), "spawn_env")


if __name__ == "__main__":
    unittest.main()
