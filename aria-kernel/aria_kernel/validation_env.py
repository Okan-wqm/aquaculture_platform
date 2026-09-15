"""ARIA-MEDIUM-066 — the environment a validation command is allowed to see.

WHY: ``validation._run_one`` spawned every allowlisted command with
``{**os.environ, **env_updates}`` — the whole runner job, plus the one
``PYTHONPATH=`` override ``parse_allowed_command`` admits. Inside a cycle the
job environment carries the durable state store's bindings: the
``restore-aria-state`` action exports ``ARIA_TOOLS_DIR`` /
``ARIA_WORKSPACE_BASE`` / ``ARIA_REPO_STATE_ROOT`` into every later step, so
an in-cycle self-validation that runs the kernel test suite ran that suite
INSIDE the store — every fixture that resolves a tools root or a workspace
base wrote into the operator's durable memory. The test package unbinds
``ARIA_REPO_STATE_ROOT`` for itself (ARIA-HIGH-065) and still honoured the
other two when inherited, and a validation child is not always the kernel
suite. The same copied environment carried ``GH_TOKEN``, a publish step's
``GIT_CONFIG_VALUE_n`` authorization header, a git hook's ``GIT_DIR`` and the
orchestrator's ``ARIA_JOB_DEADLINE_EPOCH`` (the deterministic "flake" of
ARIA-HIGH-038 when the kernel suite reads it) into a process whose purpose is
to execute repository code.

WHAT: the spawn environment is BUILT, never copied — the discipline of
``agent_env.build_agent_env``, applied at the validation lane's single spawn
seam. It starts from a closed baseline (process plumbing, locale, TLS and
proxy configuration, the real HOME the toolchains cache under), admits the
closed configuration namespaces of the toolchains the command allowlist pins
(``PYTHON*``, ``NODE_*``, ``NX_*``, ``CARGO_*``, ``RUST*``) minus anything
secret-shaped, and places on top exactly the variables the COMMAND ITSELF
declared — the ``NAME=value`` prefix ``parse_allowed_command`` admitted, which
is the only environment a recipe can declare. Nothing else crosses: no ARIA
store binding, no runtime fact, no credential. The decision is reported by
NAME, never by value, so the validation run's ledger row can say what the
child saw the way ``claude_subprocess_env_filtered`` says it for an agent.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

from .agent_env import BASELINE_ENV_NAMES, SECRET_SHAPED_ENV_NAME
from .state_store import STORE_ENVIRONMENT_NAMES

VALIDATION_ENV_REPORT_SCHEMA_VERSION = 1

# Names every validation child may see beyond ``agent_env``'s shared baseline
# (PATH, locale, TERM, TMPDIR, TZ, TLS and proxy configuration):
#
# * HOME / USER / LOGNAME — the REAL home, deliberately. The allowlisted verbs
#   are toolchain commands whose caches (~/.npm, ~/.cargo, ~/.cache/nx) live
#   there; an agent gets a synthetic home because it runs arbitrary programs,
#   a validation child runs the repository's own suite under a verb this lane
#   pinned. USER/LOGNAME are the identity strings tools fall back to
#   (``getpass.getuser``), not credentials.
# * XDG_* — where the same toolchains put config/cache/state when the operator
#   redirected them; plumbing of the same kind as TMPDIR.
# * CI / FORCE_COLOR / NO_COLOR — output-mode switches jest, nx and cargo read.
# * GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM / GIT_CONFIG_NOSYSTEM — the hermetic
#   git REDIRECTS (``tests/_helpers/hermetic_git.py``), so a child that runs
#   git stays as hermetic as its parent. NOT the ``GIT_CONFIG_COUNT`` /
#   ``GIT_CONFIG_KEY_n`` / ``GIT_CONFIG_VALUE_n`` triple — a CI publish step
#   carries an ``AUTHORIZATION: basic`` header in ``VALUE_0`` under a name the
#   secret shape cannot recognise — and NOT the ``GIT_DIR`` / ``GIT_WORK_TREE``
#   location family: a git hook exports ``GIT_DIR`` into its children, which
#   would point every git call the child makes at the hook's repository
#   instead of ``workspace_root``.
VALIDATION_BASELINE_ENV_NAMES: tuple[str, ...] = (
    *BASELINE_ENV_NAMES,
    "HOME", "USER", "LOGNAME",
    "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
    "CI", "FORCE_COLOR", "NO_COLOR",
    "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM",
)

# The configuration namespaces of the toolchains ``validation.ALLOWED_COMMANDS``
# pins: python3 (``PYTHON*``), node/npm/npx (``NODE_*``), nx (``NX_*``), cargo
# (``CARGO_*``, ``RUST*``). A member that is secret-shaped
# (``NX_CLOUD_ACCESS_TOKEN``, ``CARGO_REGISTRY_TOKEN``, ``NODE_AUTH_TOKEN``) is
# dropped even though its prefix is admitted. npm's own ``npm_config_*``
# namespace is deliberately absent: its credential spelling
# (``npm_config_//registry.npmjs.org/:_authToken``) does not match the secret
# shape, so admitting the prefix would admit the token.
VALIDATION_TOOLCHAIN_ENV_PREFIXES: tuple[str, ...] = ("PYTHON", "NODE_", "NX_", "CARGO_", "RUST")


@dataclass(frozen=True)
class ValidationEnvReport:
    """What the validation child's environment carries — names only, never values.

    ``passed`` is every name the child saw; ``declared`` the subset the command
    itself declared (and which therefore overrode any inherited value);
    ``dropped_store_bindings`` the durable-store bindings that WERE present in
    the runner and were withheld — the evidence this lane exists to produce.
    """

    passed: tuple[str, ...]
    declared: tuple[str, ...]
    dropped_count: int
    dropped_secret_shaped: tuple[str, ...]
    dropped_store_bindings: tuple[str, ...]

    def to_ledger(self) -> dict[str, Any]:
        """The ``spawn_environment`` column of a ``validation_runs`` row."""
        return {
            "schema_version": VALIDATION_ENV_REPORT_SCHEMA_VERSION,
            "passed": list(self.passed),
            "declared": list(self.declared),
            "dropped_count": self.dropped_count,
            "dropped_secret_shaped": list(self.dropped_secret_shaped),
            "dropped_store_bindings": list(self.dropped_store_bindings),
        }


@dataclass(frozen=True)
class ValidationEnv:
    env: dict[str, str]
    report: ValidationEnvReport


def _admitted_by_toolchain_prefix(name: str) -> bool:
    return any(name.startswith(prefix) for prefix in VALIDATION_TOOLCHAIN_ENV_PREFIXES)


def build_validation_env(
    base: Mapping[str, str], *, declared: Mapping[str, str] | None = None,
) -> ValidationEnv:
    """Build the spawn environment of one validation command from ``base``.

    ``base`` is normally ``os.environ``; it is a parameter so the policy is a
    pure function of a mapping and the tests can hand it a runner-shaped
    environment without mutating their own. ``declared`` carries the
    ``NAME=value`` prefix ``parse_allowed_command`` admitted for this command —
    added AFTER the filter and overriding an inherited value of the same name,
    because the recipe chose it deliberately and the runner did not.
    """
    allowed_exact = set(VALIDATION_BASELINE_ENV_NAMES)
    store_bindings = set(STORE_ENVIRONMENT_NAMES)
    env: dict[str, str] = {}
    passed: list[str] = []
    dropped_secret: list[str] = []
    dropped_store: list[str] = []
    dropped = 0
    for name, value in base.items():
        if name in allowed_exact or (
            _admitted_by_toolchain_prefix(name) and not SECRET_SHAPED_ENV_NAME.search(name)
        ):
            env[name] = value
            passed.append(name)
            continue
        dropped += 1
        if SECRET_SHAPED_ENV_NAME.search(name):
            dropped_secret.append(name)
        if name in store_bindings:
            dropped_store.append(name)

    declared_names: list[str] = []
    for name, value in (declared or {}).items():
        env[str(name)] = str(value)
        declared_names.append(str(name))
        passed.append(str(name))

    report = ValidationEnvReport(
        passed=tuple(sorted(set(passed))),
        declared=tuple(sorted(set(declared_names))),
        dropped_count=dropped,
        dropped_secret_shaped=tuple(sorted(set(dropped_secret))),
        dropped_store_bindings=tuple(sorted(set(dropped_store))),
    )
    return ValidationEnv(env=env, report=report)


__all__ = [
    "VALIDATION_BASELINE_ENV_NAMES",
    "VALIDATION_ENV_REPORT_SCHEMA_VERSION",
    "VALIDATION_TOOLCHAIN_ENV_PREFIXES",
    "ValidationEnv",
    "ValidationEnvReport",
    "build_validation_env",
]
