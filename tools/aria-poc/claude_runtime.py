"""Claude Code CLI runtime contract for ARIA agent execution.

This module is the executor-side SSoT for ARIA's live LLM runtime: ARIA runs
its agents through the **Claude Code CLI** (the same `claude` binary a human
operator drives), NOT through a raw model API. It mirrors the small,
dependency-light shape of the previous Codex contract so both
``ci_executor.py`` and ``worker_executor.py`` consume one runtime:

* Managed Claude Code auth (a logged-in subscription session on a trusted /
  private runner) is the default. Raw ``ANTHROPIC_API_KEY`` billing is
  disallowed unless an operator explicitly opts in via a future policy —
  the same fail-closed posture the Codex contract held for ChatGPT-managed
  auth vs. API keys.
* The live invocation shape is ``claude -p --output-format stream-json
  --verbose --model <model>`` with the prompt on stdin and (on a trusted
  runner) ``--dangerously-skip-permissions`` so the agent can edit its
  assigned worktree autonomously, the way ``codex exec`` did.
* The per-agent model comes from the agent frontmatter (resolved by
  ``aria_kernel.agent_runtime_profile``); ARIA's fail-safe default is opus
  (operator decision 2026-09-12 — fable is selected by nothing).
* Raw stream-json stays in memory; callers persist only sanitized envelopes.
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from contextlib import ExitStack as _ExitStack
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence


CLAUDE_BINARY_ENV_VAR = "CLAUDE_CLI_BINARY"
CLAUDE_MOCK_ENV_VAR = "CLAUDE_CLI_MOCK"
# ARIA's default model tier. The Claude Code CLI accepts a model alias
# ("opus") or a full id; the alias resolves on the runner. Operator decision
# 2026-09-12 ("sadece opus"): every selection is opus — the K5-era fable
# default is gone, and `tests/invariants/test_fable_is_selected_by_nothing`
# pins this constant. Per-agent overrides flow in via
# build_claude_exec_argv(model=...).
CLAUDE_DEFAULT_MODEL = "opus"
# The Claude Code CLI selects capability by model alias AND, since CLI 2.1.x,
# by an explicit ``--effort`` flag (low|medium|high|xhigh|max). These are the
# model aliases and effort levels ARIA may target; the agent-runtime-profile
# maps each agent's frontmatter to one of them.
# ORPHAN-HIGH-763 — the second copy of the model vocabulary is DERIVED, not
# declared.
#
# CORRECTION TO MY OWN FIRST CUT: I deleted it outright, having concluded it
# was "read by nothing, not even a test". That conclusion was produced by my
# own `grep ... | head -8` — the listing was truncated at eight lines and
# `test_claude_runtime_contract.test_valid_models_includes_fable` sat below the
# cut. A truncated search is an observation, not evidence, and this file has
# now taught that lesson twice (a pipe eating an exit code was the first).
#
# The reader is real and the name must live here. What must NOT live here is a
# second literal: `agent_runtime_profile.VALID_MODELS` is the SSoT, and this
# module exposes it through PEP 562 so the kernel import stays LAZY — the same
# discipline `_assert_budget_before_spawn` follows, because the kernel package
# rides PYTHONPATH in the ARIA lanes and not necessarily anywhere else.
def __getattr__(name: str):  # noqa: ANN202 - PEP 562 module hook
    if name == "VALID_MODELS":
        from aria_kernel.agent_runtime_profile import VALID_MODELS as _kernel_models

        return tuple(sorted(_kernel_models))
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

VALID_EFFORTS: tuple[str, ...] = ("low", "medium", "high", "xhigh", "max")

# Operator decision 2026-09-12 ("sadece opus", and the same day's delegation):
# ARIA never downgrades a decision or an implementation to a weaker tier. A
# credit exhaustion is a PROVIDER-level fact, not a tier-level one, so the
# in-vendor credit rungs that used to live here (``fable -> opus``,
# ``opus -> sonnet``, retried at CREDIT_FALLBACK_EFFORT) are gone: every tier
# is a credit LEAF, and an exhausted run RAISES ClaudeCreditExhausted. What
# the executors do with that is a queue decision, not a model decision — the
# claim is released for retry (REQUEUED) and, on the native lane, the
# provider is cooled (aria_kernel.provider_cooldown) so the next admission
# skips it for `provider_cooldown_seconds` and admits the next vendor for the
# roles it can serve. Nothing here ever selects sonnet, haiku or fable.
#
# What survives is the cross-vendor AUTH failover (ARIA-HIGH-023): a dead
# credential is a fact about the vendor, so the first tier authenticating
# through a DIFFERENT vendor is a genuinely different attempt. Bidirectional
# on purpose — a dead Z.ai key falls glm-5.3 back to the Anthropic pool.
# The walk is role-conditioned IN CODE (see _cross_provider_auth_fallback):
# the fleet row says which providers admit writes, and a write-scope profile
# is never retried on a provider whose runtime is read-only.
AUTH_FAILOVER_TIER: dict[str, str] = {
    "opus": "glm-5.3",
    "glm-5.3": "opus",
}


def _model_provider(model: str | None) -> str:
    """The vendor a tier authenticates through (ARIA-HIGH-023).

    The fleet (aria_kernel.model_fleet) is the one place a model is bound to
    its provider; the runtime that serves the provider is the fleet row's
    business, not this module's. The provider, not the tier name, is what an
    auth failure is a fact ABOUT: a dead credential cannot be cured by any
    rung inside the same vendor, and can be by the first rung outside it.
    Unlisted models are the managed Anthropic session's — the fleet's
    `dispatching_provider_for_model` states that convention once.
    """
    from aria_kernel.model_fleet import dispatching_provider_for_model

    return dispatching_provider_for_model(model)


def _provider_admits_writes(provider: str) -> bool:
    """Whether a provider's runtime can host a write-scope spawn (fleet fact).

    Read from the fleet row rather than restated here: the managed Claude CLI
    runs under the write-containment sandbox, while the Codex read-only
    sandbox and the Z.ai HTTP transport cannot edit a workspace at all. An
    unlisted provider admits nothing — the fail-closed direction.
    """
    from aria_kernel.model_fleet import provider_admits_writes

    return provider_admits_writes(provider)


def _cross_provider_auth_fallback(model: str | None, *, write_capable: bool) -> str | None:
    """First ladder tier authenticating through a DIFFERENT vendor (ARIA-HIGH-023).

    Walks ``AUTH_FAILOVER_TIER`` from ``model``, skipping same-vendor rungs
    (they share the dead credential), and returns the first cross-vendor tier
    whose provider can serve THIS role: ``write_capable`` is the profile's
    own fact (``AgentRuntimeProfile.write_capable``), and a rung whose
    provider is a read-only runtime is skipped for a write-scope profile
    rather than handed a request it cannot execute. Cycle-bounded: the map
    is cyclic (``opus -> glm-5.3 -> opus``), so the walk tracks visited tiers
    and gives up at the first repeat. Returns ``None`` when no admissible
    cross-vendor tier is reachable — the caller then treats the auth failure
    as terminal.
    """
    origin_provider = _model_provider(model)
    visited: set[str] = set()
    current = AUTH_FAILOVER_TIER.get(str(model or ""))
    while current is not None and current not in visited:
        visited.add(current)
        provider = _model_provider(current)
        if provider != origin_provider and (not write_capable or _provider_admits_writes(provider)):
            return current
        current = AUTH_FAILOVER_TIER.get(current)
    return None


ALLOW_API_KEY_MODE_ENV_VAR = "ARIA_ALLOW_CLAUDE_API_KEY_MODE"
REQUIRE_USAGE_ENV_VAR = "ARIA_CLAUDE_REQUIRE_USAGE"
AUTH_PREFLIGHT_SKIP_ENV_VAR = "ARIA_CLAUDE_AUTH_PREFLIGHT_SKIP"
# Operator acknowledgement that the autonomous-write executor runs inside a
# real isolated sandbox/container. The Claude Code CLI refuses
# ``--dangerously-skip-permissions`` under root/sudo for security; a genuine
# sandboxed runner sets this so the runtime passes ``IS_SANDBOX=1`` through to
# the CLI. The recommended production path is a NON-ROOT runner (no env needed)
# — see ADR-040.
SANDBOX_ACK_ENV_VAR = "ARIA_CLAUDE_SANDBOX"
# Claude Code CLI permission modes the autonomous executor may select instead
# of the full ``--dangerously-skip-permissions`` bypass. ``acceptEdits`` /
# ``bypassPermissions`` enable autonomous worktree writes; ``plan`` / ``default``
# are read-only / human-gated.
VALID_PERMISSION_MODES: tuple[str, ...] = ("acceptEdits", "bypassPermissions", "plan", "default")

API_KEY_ENV_VARS = ("ANTHROPIC_API_KEY", "CLAUDE_API_KEY")
# Claude Code honours ANTHROPIC_AUTH_TOKEN / custom base URLs for proxy
# billing; those bypass the managed subscription session the same way an
# API key does, so they are gated under the same policy switch.
UNSAFE_BILLING_ENV_VARS = ("ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL")

# There is NO per-spawn provider redirect any more. ORPHAN-HIGH-764 had
# taught this module to point the claude binary at another vendor through
# ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN in a single spawn's environment;
# the operator policy of 2026-09-11 forbids handing any other vendor's
# credential to this CLI at all. A model that belongs to another provider is
# refused by name at the spawn seam (see run_claude_exec) and served by that
# provider's own runtime (tools/aria-poc/zai_runtime.py for Z.ai, codex_runtime
# for OpenAI); the fleet (aria_kernel.model_fleet) is the one binding.

class ClaudeCliUnavailable(RuntimeError):
    """Claude Code CLI is not installed or cannot satisfy ARIA's contract."""


class ClaudeAuthUnavailable(RuntimeError):
    """Claude Code CLI auth/session state could not be verified."""


class ClaudeUsageUnavailable(RuntimeError):
    """Claude stream-json did not include the required usage data."""


class ClaudeAuthFailure(RuntimeError):
    """The agent runtime could not authenticate, so no attempt ever ran.

    Raised rather than returned, for the reason ClaudeCreditExhausted is: a
    caller that reads only `returncode` would treat this as "the agent ran and
    failed", which is what let five nights of dispatches die without anyone
    learning that the session had expired. It is also NOT retried on another
    tier — every tier authenticates through the same credential.
    """


class ClaudeCreditExhausted(RuntimeError):
    """A quota/credit exhaustion of one PROVIDER — terminal for this attempt.

    ORPHAN-HIGH-473 — raised instead of returning the run result. Per
    extract_credit_exhaustion, the CLI delivers its usage-limit notice as
    ASSISTANT CONTENT on a clean exit (returncode 0), so an exhausted run is
    shaped exactly like a successful one. Neither executor inspected
    ``.credit_exhaustion`` on the returned result, so "You've reached your
    limit. Run /usage-credits..." was flowing downstream as the agent's answer
    and being persisted as a real envelope. A result that cannot be told apart
    from an answer must not be returned at all.

    Operator decision 2026-09-12: there is no weaker tier to retry on. The
    exception names the exhausted ``provider`` and ``model`` because the
    executor's release and the provider cooldown are keyed on the PROVIDER —
    a run that failed over to another vendor for auth and then hit that
    vendor's quota names that vendor, not the primary. ``detail`` is the
    detection record (which marker matched, on which stream), carried so the
    audit row is written once, at the release site, with the claim identity.
    """

    def __init__(self, message: str, *, provider: str, model: str, detail: dict[str, Any]) -> None:
        super().__init__(message)
        self.provider = provider
        self.model = model
        self.detail = detail


class ClaudePolicyViolation(RuntimeError):
    """Environment or argv would violate ARIA's Claude runtime policy."""


@dataclass(frozen=True)
class ClaudeRunResult:
    returncode: int
    stdout: str
    stderr: str
    final_message: str
    usage: dict[str, Any] | None
    events: tuple[dict[str, Any], ...]
    # K2 (ORPHAN-HIGH-284) — model-safety refusal record extracted from the
    # stream-json events, or None. The runtime only detects and reports;
    # run_with_model_fallback returns it on the result and the executors
    # escalate it (`model_safety_refusal_unresolved`) — no tier retries it.
    refusal: dict[str, Any] | None = None
    # Credit/quota-exhaustion record (sibling of the K2 refusal detection), or
    # None. Detection only; run_with_model_fallback turns it into the terminal
    # ClaudeCreditExhausted — no tier retries it (operator decision 2026-09-12).
    credit_exhaustion: dict[str, Any] | None = None
    # Authentication failure record, or None. Detection only; executors own the
    # policy. Not recoverable by any SAME-vendor rung — ARIA-HIGH-023 lets
    # run_with_model_fallback cross vendors on auth failure; see
    # AUTH_FAILURE_MARKERS and _cross_provider_auth_fallback.
    auth_failure: dict[str, Any] | None = None
    # ARIA-HIGH-002 — typed terminal classification of THIS result (auth
    # failure / credit-exhaustion markers, process exit), stamped by the
    # runtime through dispatch_failure.classify_dispatch_failure before the
    # result is returned; None on a clean success. The exception-family half
    # of the contract is the executors' to classify at their boundary.
    failure_class: str | None = None
    retryable: bool | None = None
    failure_detail_code: str | None = None
    # ARIA-MEDIUM-171 — the model that ANSWERED, stamped by the runtime that
    # ran the attempt (``run_with_model_fallback`` after the primary or the
    # cross-vendor rung; the Z.ai adapter from its own call). The executor's
    # ``agent_dispatch_model`` stamp reads this, never the profile's
    # frontmatter: under an auth failover the two differ, and the anchor
    # grade's distinct-model count must name the rung that ran.
    model: str | None = None


def is_mock_mode() -> bool:
    return _parse_bool(os.environ.get(CLAUDE_MOCK_ENV_VAR, "0"), env_name=CLAUDE_MOCK_ENV_VAR)


def claude_binary() -> str:
    return os.environ.get(CLAUDE_BINARY_ENV_VAR, "claude")


def _resolve_claude_executable(environ: Mapping[str, str]) -> Path:
    """The real file behind the CLI name, found on the SPAWN environment's PATH.

    A name is resolved again by whoever executes it, and a sandbox that does
    not bind the operator's installation resolves it to another one: the
    managed route's first live attempt probed 2.1.269 under ``~/.local`` and
    ran 2.1.233 under ``/usr/local`` (ARIA-HIGH-077). Symlinks are followed
    so the attempt names the installation itself.
    """
    name = claude_binary()
    found = name if os.path.isabs(name) else shutil.which(name, path=environ.get("PATH", os.defpath))
    if found is None or not Path(found).is_file():
        raise ClaudeCliUnavailable(f"`{name}` binary not on the spawn environment's PATH")
    return Path(found).resolve(strict=True)


def assert_claude_policy_environment() -> None:
    """Fail closed on billing/auth modes that bypass managed Claude Code auth."""
    allow_api_key = _parse_bool(
        os.environ.get(ALLOW_API_KEY_MODE_ENV_VAR, "0"),
        env_name=ALLOW_API_KEY_MODE_ENV_VAR,
    )
    if not allow_api_key:
        leaked = [
            name
            for name in (*API_KEY_ENV_VARS, *UNSAFE_BILLING_ENV_VARS)
            if os.environ.get(name)
        ]
        if leaked:
            raise ClaudePolicyViolation(
                "claude_api_key_mode_disallowed: unset "
                + ", ".join(leaked)
                + " or set ARIA_ALLOW_CLAUDE_API_KEY_MODE=1 under a new policy"
            )


def _assert_budget_before_spawn() -> None:
    """F13/E8 — the cost-budget gate's first enforcement point.

    ``cost_budget.assert_within_budget`` documented itself as "call BEFORE
    spawning claude" and its only repo reference was a COMMENT in
    genesis_policy: every cap (per-run / daily / monthly) plus the breaker
    trip existed with no caller — a spawn could not be stopped by budget,
    ever. This is the single choke point every live ``claude`` spawn passes
    through, so the gate lives here.

    Scope is deliberate: the gate binds only when ``ARIA_TOOLS_DIR`` names
    the durable store (the autonomy lanes export it). Without a store there
    is no spend ledger to project against — local dev and unit tests run
    ungated, which is honest, not lenient. The estimate is a conservative
    env-tunable ceiling, not telemetry: the gate's job is to stop a night
    that would blow the cap, and an overestimate fails toward safety.
    """
    tools_dir = os.environ.get("ARIA_TOOLS_DIR")
    if not tools_dir:
        return
    # Same lazy-import pattern as the implementation_safety hooks below:
    # the kernel package rides PYTHONPATH in every ARIA lane.
    from aria_kernel.cost_budget import _load_caps, assert_within_budget

    # Executor smoke 31704817330 — the first live drain failed 30/30 at
    # THIS gate: the original default estimate ($1.50) sat ABOVE the
    # policy's own per_run cap ($0.50), so every spawn was refused before
    # it started and the breaker tripped on configuration, not on spend.
    # The default now DERIVES from the policy (80% of per_run): the gate
    # refuses only when the projected daily/monthly budget is actually
    # exhausted — which is its job — never because two constants
    # disagreed. The env override remains for operators who know a lane's
    # real per-run cost.
    raw = os.environ.get("ARIA_ESTIMATED_RUN_USD")
    if raw is not None:
        try:
            estimate = float(raw)
        except ValueError:
            estimate = _load_caps(tools_dir)["per_run"] * 0.8
    else:
        estimate = _load_caps(tools_dir)["per_run"] * 0.8

    assert_within_budget(tools_dir, estimated_run_usd=estimate)


def preflight_claude_auth(*, timeout_seconds: int = 20) -> dict[str, Any]:
    """Verify the Claude Code CLI is present and managed-auth is usable
    without spending tokens.

    The Claude Code CLI does not expose a token-free ``login status --json``
    probe, so the preflight is: (1) policy-environment check (no API-key /
    proxy billing leak), (2) ``claude --version`` must succeed, (3) a
    managed-auth credential surface must exist on the runner (the logged-in
    session file). If the credential surface is absent, real mode fails
    closed. Local tests may set ``ARIA_CLAUDE_AUTH_PREFLIGHT_SKIP=1``.
    """
    assert_claude_policy_environment()
    binary = claude_binary()
    if shutil.which(binary) is None:
        raise ClaudeCliUnavailable(f"`{binary}` binary not on PATH")

    try:
        version_proc = subprocess.run(
            [binary, "--version"],
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ClaudeCliUnavailable(f"claude_version_probe_failed: {exc}") from exc
    if version_proc.returncode != 0:
        raise ClaudeCliUnavailable(
            f"claude_version_probe_failed: {version_proc.stderr.strip() or version_proc.stdout.strip()}"
        )
    version = version_proc.stdout.strip() or version_proc.stderr.strip()

    if _parse_bool(
        os.environ.get(AUTH_PREFLIGHT_SKIP_ENV_VAR, "0"),
        env_name=AUTH_PREFLIGHT_SKIP_ENV_VAR,
    ):
        return {"status": "skipped_by_env", "version": version}

    if not _managed_auth_present():
        raise ClaudeAuthUnavailable(
            "claude_managed_auth_absent: no logged-in Claude Code session found; "
            "run `claude` login on the runner or set "
            "ARIA_CLAUDE_AUTH_PREFLIGHT_SKIP=1 for a dry-run"
        )
    return {"status": "ok", "version": version}


# The managed session's own status command. `claude auth status --json` is a
# non-model call that reports the login state the CLI will actually use:
# authMethod "claude.ai" is the managed subscription; an API-key or console
# login is the billing bypass ARIA refuses. It is the Anthropic mirror of
# `codex login status` and, like it, proves the session at admission time —
# not remaining quota, and not the result of a later model turn. The
# document is classified by `status_answers` (the one reader of the
# vendor's answer for both CLIs; `MANAGED_AUTH_METHOD_CLAUDE_AI` lives
# there), imported where the probe runs like every other kernel-side
# import in this module.


@dataclass(frozen=True)
class ManagedClaudeContext:
    """What native admission holds for the managed Anthropic route.

    The spawn itself stays the existing `run_claude_exec` (agent_env build,
    containment, cancel polling); this records the identity the attempt row
    binds to and the status facts the fleet admission read.
    """

    auth_method: str
    subscription_type: str | None
    config_dir: str | None
    settings_hash: str


def _probe_claude_auth_status(
    *, environ: dict[str, str], timeout_seconds: float, binary: str | None = None,
) -> Any:
    """Observe `claude auth status --json`, retaining only its type.

    Returned as the fleet's `_RuntimeStatusObservation`, each row naming its
    `StatusDecision` at the site that saw the answer. This owner runs the
    spawn (the environment boundary, the per-attempt cap) and names what
    never produced an answer: no CLI on PATH → `cli_unavailable` (DECIDED —
    the host, not the vendor, said so); slow or unspawnable → UNDECIDED.
    The bytes the CLI wrote go to `status_answers.classify_claude_status_answer`,
    which reads the DOCUMENT before the exit code: the installed CLI exits
    1 on a logged-out session while still printing `{"loggedIn": false}`,
    and that is a DECIDED refusal, not a stall. Only when no document was
    read does the exit code name the undecided reason. Raw output never
    leaves this owner; the email/org fields are not recorded.
    """
    from status_answers import classify_claude_status_answer
    from aria_kernel.status_probe import StatusDecision, _RuntimeStatusObservation

    name = binary or environ.get(CLAUDE_BINARY_ENV_VAR, "claude")
    executable = name if os.path.isabs(name) else shutil.which(name, path=environ.get("PATH", os.defpath))
    command = (name, "auth", "status", "--json")
    if executable is None:
        return _RuntimeStatusObservation("unavailable", reason="cli_unavailable", command=command,
                                         decision=StatusDecision.UNAVAILABLE)
    if timeout_seconds <= 0:
        return _RuntimeStatusObservation("unknown", reason="status_deadline_elapsed", command=command,
                                         decision=StatusDecision.UNDECIDED)
    allowed = {"PATH", "HOME", "CLAUDE_CONFIG_DIR", "LANG", "LC_ALL", "TMPDIR", "XDG_CONFIG_HOME"}
    status_env = {name: value for name, value in environ.items() if name in allowed}
    try:
        completed = subprocess.run(
            [executable, "auth", "status", "--json"], capture_output=True, text=True,
            timeout=min(20.0, float(timeout_seconds)), env=status_env, check=False,
        )
    except subprocess.TimeoutExpired:
        return _RuntimeStatusObservation("unknown", reason="status_timeout", command=command,
                                         decision=StatusDecision.UNDECIDED)
    except OSError:
        return _RuntimeStatusObservation("unknown", reason="status_command_unavailable", command=command,
                                         decision=StatusDecision.UNDECIDED)
    return classify_claude_status_answer(completed.stdout, completed.returncode, command=command)


def _session_store_dir() -> Path | None:
    """ARIA-HIGH-179 — the durable session store the sandbox binds at the
    private config dir's `projects`; None only when the kernel is not
    importable (the sandbox then carries no store and no session resumes)."""
    try:
        from aria_kernel.session_continuity import session_store_dir
    except ImportError:  # pragma: no cover - kernel always importable here
        return None
    return session_store_dir()


def _managed_auth_present() -> bool:
    """True when a logged-in Claude Code session credential surface exists.

    Claude Code persists the managed session under ``$CLAUDE_CONFIG_DIR``
    (default ``~/.claude``). We probe for the credentials file or the
    config dir's auth record rather than invoking a billable turn.
    """
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR")
    candidates = []
    if config_dir:
        candidates.append(Path(config_dir))
    home = Path(os.path.expanduser("~"))
    candidates.append(home / ".claude")
    for base in candidates:
        if (base / ".credentials.json").is_file():
            return True
        if (base / "config.json").is_file():
            return True
    return False


def build_claude_exec_argv(
    *,
    model: str | None = None,
    effort: str | None = None,
    skip_permissions: bool = True,
    permission_mode: str | None = None,
    disallowed_tools: Sequence[str] = (),
    session_id: str | None = None,
    resume: bool = False,
    # Plan 032 Faz 032g — MCP: the kernel's config, strictly (repo .mcp.json never loads).
    mcp_config_path: str | Path | None = None,
    strict_mcp_config: bool = False,
    read_shape: bool = False,
    read_shape_tools: Sequence[str] = (),
) -> list[str]:
    """Build the live Claude Code CLI invocation argv.

    Autonomous worktree writes need one of two permission shapes:

    * ``permission_mode`` → ``--permission-mode <mode>``. Verified live: the
      Claude Code CLI allows ``acceptEdits`` under root (auto-accepts file edits
      — the root-COMPATIBLE autonomous-write lever, proven to write a real file
      as root in an isolated dir), but refuses ``bypassPermissions`` under root
      exactly like the full bypass.
    * ``skip_permissions`` (default, no ``permission_mode``) →
      ``--dangerously-skip-permissions`` (full bypass). Requires a NON-ROOT or
      acknowledged-sandbox runner (enforced by :func:`assert_write_runner_ok`).

    A read-only/preview turn passes ``skip_permissions=False`` with no
    ``permission_mode`` (the autonomy a judge/scout never needs).
    """
    resolved_model = model or CLAUDE_DEFAULT_MODEL
    argv = [
        claude_binary(),
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        resolved_model,
    ]
    if effort is not None:
        if effort not in VALID_EFFORTS:
            raise ClaudePolicyViolation(
                f"invalid effort {effort!r}; allowed: {VALID_EFFORTS}"
            )
        argv.extend(["--effort", effort])
    if permission_mode is not None:
        if permission_mode not in VALID_PERMISSION_MODES:
            raise ClaudePolicyViolation(
                f"invalid permission_mode {permission_mode!r}; allowed: {VALID_PERMISSION_MODES}"
            )
        argv.extend(["--permission-mode", permission_mode])
    elif skip_permissions:
        argv.append("--dangerously-skip-permissions")
    if read_shape:
        # ARIA-HIGH-162 — the read shape never carries the bypass flag; the
        # CLI's own restriction, a denied prompt target and the profile's
        # grant as the positive tool list are the three flags that make it.
        if skip_permissions or permission_mode is not None:
            raise ClaudePolicyViolation("claude_read_shape_with_write_permissions")
        argv.extend(["--restricted", "--permission-prompts", "none", "--tools", ",".join(read_shape_tools)])
    # Plan 032 Faz 032b — the profile's tool envelope, enforced by the CLI
    # itself. Bare names remove tools the profile does not grant; scoped
    # `Bash(...)` rules close the external-write channels. Deny rules bind in
    # every permission mode, bypassPermissions included, so this holds even
    # though the spawn skips prompts.
    if disallowed_tools:
        argv.append("--disallowedTools")
        argv.extend(str(rule) for rule in disallowed_tools)
    # Plan 032 Faz 032c — a bound session: fresh (`--session-id`) or resumed
    # (`--resume`) — the decision is the kernel's (session_continuity), the
    # flag is the CLI's.
    if session_id:
        argv.extend(["--resume" if resume else "--session-id", session_id])
    if strict_mcp_config:
        argv.append("--strict-mcp-config")
    if mcp_config_path is not None:
        argv.extend(["--mcp-config", str(mcp_config_path)])
    return argv


def _running_as_root() -> bool:
    """True when the current process is uid 0. ``os.geteuid`` is POSIX-only;
    on platforms without it ARIA is never root, so return False."""
    geteuid = getattr(os, "geteuid", None)
    return geteuid is not None and geteuid() == 0


def _sandbox_acknowledged() -> bool:
    """True when the operator has acknowledged a real isolated sandbox via
    ``ARIA_CLAUDE_SANDBOX`` (or the CLI's own ``IS_SANDBOX``)."""
    return _parse_bool(
        os.environ.get(SANDBOX_ACK_ENV_VAR, "0"), env_name=SANDBOX_ACK_ENV_VAR
    ) or _parse_bool(os.environ.get("IS_SANDBOX", "0"), env_name="IS_SANDBOX")


def assert_write_runner_ok(*, skip_permissions: bool, permission_mode: str | None) -> None:
    """Fail closed BEFORE the subprocess when the autonomous-write shape cannot
    run on this runner.

    The Claude Code CLI refuses BOTH ``--dangerously-skip-permissions`` AND
    ``--permission-mode bypassPermissions`` under root/sudo for security (verified
    live). Rather than surface that as a cryptic non-zero subprocess exit, ARIA
    detects it at preflight and raises with the operator-actionable fix: run the
    autonomous-write executor as a NON-ROOT user, OR select
    ``permission_mode='acceptEdits'`` (the root-compatible autonomous-write
    lever), OR acknowledge a genuine sandbox via ``ARIA_CLAUDE_SANDBOX=1``
    (ADR-040). ``acceptEdits`` / ``plan`` / ``default`` are NOT root-blocked.
    """
    root_blocked = (permission_mode is None and skip_permissions) or permission_mode == "bypassPermissions"
    if root_blocked and _running_as_root() and not _sandbox_acknowledged():
        raise ClaudePolicyViolation(
            "claude_autonomous_write_runner_is_root: the Claude Code CLI refuses "
            "--dangerously-skip-permissions / bypassPermissions under root. Run the "
            "autonomous-write executor as a non-root user, pass "
            "permission_mode='acceptEdits' (root-compatible), or set "
            "ARIA_CLAUDE_SANDBOX=1 inside a genuine isolated sandbox (ADR-040)."
        )


# ARIA-HIGH-162 — the READ shape. A profile that cannot write does not spawn
# with `--dangerously-skip-permissions` under the write containment; it spawns
# read-contained: the workspace bound read-only with no writable scope and no
# commit containment, the CLI in `--restricted` mode (the code-running tools
# removed, user/project/local settings ignored, file tools confined to the
# working directory), every prompt denied by name (`--permission-prompts
# none`), and the profile's grant as a POSITIVE allowlist (`--tools`) with the
# deny list kept as the belt. Measured 2026-09-19: an unconfined `-p` run
# inherits the host's real `~/.claude` (this host: `permissions.defaultMode:
# auto`, four plugins, session persistence under `~/.claude/projects/`), and
# `--disallowedTools` is a deny-list over a twelve-name universe that does not
# name `Skill`, `EnterWorktree`, `Artifact` or `SendMessage` — so the read
# shape keeps bwrap and adds the CLI's own restriction rather than dropping
# either. Eligibility is a pinned set, not a derivation: the planner profiles
# are read-only too but carry the `aria` MCP server and stay on the write
# containment path until that server is contained for a read spawn.
READ_CONTAINED_PROFILE_IDS: tuple[str, ...] = ("judge_opus", "judge_glm", "arbiter")
READ_CONTAINED_TOOLS: frozenset[str] = frozenset({"Read", "Grep", "Glob"})


def read_contained_profile(agent_profile: Any | None) -> bool:
    """True when this spawn takes the read shape (ARIA-HIGH-162).

    Every clause is a fact of the kernel profile, none of the agent file:
    the id is in the pinned set, the grant is inside the read tool set, no
    MCP server is named, and the profile cannot write.
    """
    kernel = _kernel_profile(agent_profile)
    if kernel is None:
        return False
    return (
        str(getattr(kernel, "profile_id", "")) in READ_CONTAINED_PROFILE_IDS
        and set(getattr(kernel, "tools", ())) <= READ_CONTAINED_TOOLS
        and not tuple(getattr(kernel, "mcp_servers", ()))
        and not bool(getattr(kernel, "write_capable", False))
    )


# ORPHAN-CRITICAL-427 — operator escape hatch for a host with no sandbox
# backend. Named explicitly rather than inferred, and audited in the refusal
# message, so running a write-capable agent unconfined is a recorded decision
# and never a silent default.
UNCONFINED_ACK_ENV_VAR = "ARIA_ALLOW_UNCONFINED_WRITE"


def _is_write_capable(*, skip_permissions: bool, permission_mode: str | None) -> bool:
    """True when this invocation can edit files without asking.

    Read-only turns (``skip_permissions=False`` with no permission_mode, and
    ``plan``) need no filesystem containment because they cannot write.
    """
    if permission_mode in {"bypassPermissions", "acceptEdits"}:
        return True
    if permission_mode in {"plan", "default"}:
        return False
    return skip_permissions


def _apply_write_containment(
    argv: list[str],
    *,
    skip_permissions: bool,
    permission_mode: str | None,
    workspace_root: str | Path | None,
    write_scope: Sequence[str] | None = None,
    executable: Path | None = None,
    spawn_files: Sequence[Path] = (),
    managed_login_dir: Path | None = None,
    git_containment: Any | None = None,
    hook_broker_socket: Path | None = None,
    mcp_broker_socket: Path | None = None,
    read_containment: bool = False,
    session_store_dir: Path | None = None,
) -> list[str]:
    """Wrap a write-capable spawn so READONLY_PATHS are enforced by the OS.

    ARIA-HIGH-162 — ``read_containment`` selects the READ shape for a
    read-only spawn: the same sandbox with the workspace bound read-only,
    no writable scope, git binds derived read-only, no MCP broker socket.
    Fail-closed like the write shape: no sandbox backend, no spawn — the
    read shape has no unconfined acknowledgement.

    ``executable`` is the CLI resolved outside the sandbox (run by absolute
    path inside it), ``spawn_files`` the documents this spawn wrote for the
    CLI, ``managed_login_dir`` the login directory whose one credential file
    is mounted into the private home — see the kernel's
    ``wrap_managed_claude_in_sandbox`` (ARIA-HIGH-077).

    ARIA-HIGH-123 — ``git_containment`` is the commit-capable git
    containment the executor derived when it held the implementer's
    identity (``implementation_identity``: the worktree's git dirs bound
    the way a commit needs, the private key masked, the kernel-held
    signing agent's socket bound in). Without one, the workspace's git
    binds are derived here READ-ONLY (``derive_git_containment(...,
    commit_capable=False)``): git reads work in a linked worktree and
    nothing under either git dir is writable. ``hook_broker_socket`` is the
    kernel-side hook broker's socket (``hook_broker.serve_hook_broker``),
    bound into the sandbox so the hooks decide and journal OUTSIDE it; the
    durable store is never mounted in the sandbox. ``mcp_broker_socket``
    is the kernel-side MCP broker's (ARIA-HIGH-124): the `aria` view is
    served outside and relayed in through it.

    Fail-closed: with no sandbox backend the spawn is REFUSED unless the
    operator has set ``ARIA_ALLOW_UNCONFINED_WRITE``. Pre-fix
    ``wrap_bash_in_sandbox`` had no caller at all, so a write-capable agent
    always ran unconfined and the containment existed only as text the
    agent could ignore.

    ``allow_network=True`` because the agent process must reach the Claude
    API. Network egress from the agent's own bash commands is a separate
    concern; the property bought here is that the kernel, workflows and
    agent definitions cannot be mutated regardless of what the agent
    decides to do.
    """
    if not _is_write_capable(
        skip_permissions=skip_permissions, permission_mode=permission_mode,
    ):
        if read_containment:
            return _apply_read_containment(
                argv, workspace_root=workspace_root, executable=executable, spawn_files=spawn_files,
                managed_login_dir=managed_login_dir, hook_broker_socket=hook_broker_socket,
                session_store_dir=session_store_dir,
            )
        return argv
    workspace = Path(workspace_root) if workspace_root is not None else Path.cwd()
    try:
        from aria_kernel.git_containment import GitContainmentRefusal, derive_git_containment
        from aria_kernel.implementation_safety import (
            SandboxUnavailable,
            wrap_bash_in_sandbox,
            wrap_managed_claude_in_sandbox,
        )
    except ImportError as exc:  # pragma: no cover - kernel always importable here
        raise ClaudePolicyViolation(
            f"claude_write_containment_unavailable: cannot import the sandbox "
            f"helper ({exc}); refusing to spawn a write-capable agent unconfined"
        ) from exc
    git = git_containment
    if git is None:
        try:
            git = derive_git_containment(workspace, commit_capable=False)
        except GitContainmentRefusal as exc:
            raise ClaudePolicyViolation(
                f"claude_write_containment_git_refused: {exc.reason}; refusing to spawn a "
                f"write-capable agent whose git binds cannot be derived from {workspace}"
            ) from exc
    try:
        if executable is None:
            return wrap_bash_in_sandbox(
                argv, workspace_root=workspace, allow_network=True, write_scope=write_scope,
                git=git, hook_broker_socket=hook_broker_socket, mcp_broker_socket=mcp_broker_socket,
            )
        return wrap_managed_claude_in_sandbox(
            argv, workspace_root=workspace, write_scope=write_scope, executable=executable,
            spawn_files=spawn_files, managed_login_dir=managed_login_dir, git=git,
            hook_broker_socket=hook_broker_socket, mcp_broker_socket=mcp_broker_socket,
            session_store_dir=session_store_dir,
        )
    except SandboxUnavailable as exc:
        if _parse_bool(
            os.environ.get(UNCONFINED_ACK_ENV_VAR, "0"),
            env_name=UNCONFINED_ACK_ENV_VAR,
        ):
            return argv
        # ORPHAN-CRITICAL-451 — this message used to say "install bwrap or
        # firejail". Following the second option satisfied the S0 exit
        # criterion with the kernel fully writable, because the firejail
        # branch applied none of the READONLY_PATHS. bwrap is now the only
        # accepted backend, so it is the only one suggested.
        raise ClaudePolicyViolation(
            f"claude_write_containment_required: {exc}. Install bwrap on the "
            f"runner AND give it unprivileged user namespaces, use a "
            f"read-only shape (skip_permissions=False), or set "
            f"{UNCONFINED_ACK_ENV_VAR}=1 to accept an unconfined "
            f"write-capable agent on this host."
        ) from exc


def _apply_read_containment(
    argv: list[str],
    *,
    workspace_root: str | Path | None,
    executable: Path | None,
    spawn_files: Sequence[Path] = (),
    managed_login_dir: Path | None = None,
    hook_broker_socket: Path | None = None,
    session_store_dir: Path | None = None,
) -> list[str]:
    """The READ shape's sandbox (ARIA-HIGH-162).

    ``wrap_managed_claude_in_sandbox`` with an EMPTY write scope binds the
    workspace read-only and nothing writable under it; the git binds are
    derived read-only; the private home carries only the managed login
    (writable for the OAuth refresh, ARIA-HIGH-157) and ``CLAUDE_CONFIG_DIR``
    points inside it, so the host's own settings, plugins and session store
    are out of reach; the hook broker keeps its socket so the turn budget
    and the journal stay outside. No MCP broker: no read profile names one.
    """
    workspace = Path(workspace_root) if workspace_root is not None else Path.cwd()
    if executable is None:
        raise ClaudePolicyViolation("claude_read_containment_without_executable")
    from aria_kernel.git_containment import GitContainmentRefusal, derive_git_containment
    from aria_kernel.implementation_safety import SandboxUnavailable, wrap_managed_claude_in_sandbox
    try:
        git = derive_git_containment(workspace, commit_capable=False)
    except GitContainmentRefusal as exc:
        raise ClaudePolicyViolation(
            f"claude_read_containment_git_refused: {exc.reason}; refusing to spawn a "
            f"read-contained agent whose git binds cannot be derived from {workspace}"
        ) from exc
    try:
        return wrap_managed_claude_in_sandbox(
            argv, workspace_root=workspace, write_scope=(), executable=executable,
            spawn_files=spawn_files, managed_login_dir=managed_login_dir, git=git,
            hook_broker_socket=hook_broker_socket, mcp_broker_socket=None,
            session_store_dir=session_store_dir,
        )
    except SandboxUnavailable as exc:
        raise ClaudePolicyViolation(
            f"claude_read_containment_required: {exc}. The read shape runs under bwrap "
            f"or not at all; install bwrap on the runner and give it unprivileged user namespaces."
        ) from exc


def _apply_resource_limits(
    argv: list[str], *, timeout_seconds: int, environ: dict[str, str] | None = None,
    control_source: Mapping[str, str] | None = None,
) -> list[str]:
    """Bound the spawned agent's memory, CPU, task count and wall clock.

    ``environ`` is the BUILT spawn environment the limited command launches
    with; ``control_source`` (normally ``os.environ``) is where the user-bus
    plumbing the limiter alone may use is read from, by name. The kernel
    helper probes the limiter in that launch environment and unsets the
    plumbing again before the agent starts (ARIA-HIGH-076: a limiter
    selected in the executor's environment and launched in the agent's
    failed with "Failed to connect to bus" on the managed Claude route's
    first live attempt).

    ORPHAN-MEDIUM-459 — the kernel half of this shipped with the sandbox
    work and had no production caller; the only instruction to run it was a
    line in `.claude/agents/aria-implementer.md`, which is prose addressed to
    the process being limited. `ORPHAN-CRITICAL-427` fixed exactly that
    mistake for containment and left it standing here.

    Lazy import mirroring `_apply_write_containment`, and it fails the same
    way: a kernel that cannot be imported means the perimeter cannot be
    applied, and a write-capable agent must not be spawned unbounded on the
    strength of an ImportError.

    ORPHAN-HIGH-470 follow-through — the kernel's `ResourceLimitsUnavailable`
    is translated into this module's policy vocabulary HERE, at the boundary,
    exactly as `_apply_write_containment` translates `SandboxUnavailable`.
    Pre-fix only the ImportError arm was translated, so the no-limiter tail
    added by ORPHAN-HIGH-470 raised a kernel exception type that no caller of
    `run_claude_exec` names: `ci_executor.invoke_claude_cli` and
    `worker_executor.main` each catch
    (ClaudeAuthUnavailable, ClaudeCliUnavailable, ClaudePolicyViolation,
    ClaudeUsageUnavailable) and nothing else, so a refused spawn escaped as an
    unhandled exception past every claim-release branch both files own.

    Translating rather than asking each executor to name a kernel type is the
    tier-2 shape: the kernel exception cannot cross this module, so a future
    executor gets the fail-closed handling by default instead of having to
    remember a fourth exception name. Fail CLOSED — there is deliberately no
    acknowledgement env var and no bare-argv return, because the operator's
    escape hatch for an unusable limiter would be an unbounded write-capable
    agent, which is the failure `apply_resource_limits` exists to prevent.
    """
    try:
        from aria_kernel.implementation_safety import (
            ResourceLimitsUnavailable,
            apply_resource_limits,
            limiter_control_environment,
        )
    except ImportError as exc:  # pragma: no cover - kernel always importable here
        raise ClaudePolicyViolation(
            f"claude_resource_limits_unavailable: cannot import the limit "
            f"helper ({exc}); refusing to spawn an unbounded agent"
        ) from exc
    control_environment = limiter_control_environment(control_source) if control_source is not None else None
    try:
        return apply_resource_limits(
            argv, timeout_seconds=timeout_seconds, environ=environ, control_environment=control_environment,
        )
    except ResourceLimitsUnavailable as exc:
        raise ClaudePolicyViolation(
            f"claude_resource_limits_required: {exc}. Install coreutils "
            f"`timeout` on the runner, or give it a working systemd user "
            f"session bus, so memory/CPU/task/wall-clock caps can be applied."
        ) from exc


# Smoke-run 31645296013 — the first live night died mid-spawn: adapters
# finished at 22:29, one claude spawn started with its full 1800s budget,
# and the JOB's 50-minute wall killed everything at 22:53. The half-night
# failed state verification and was quarantined (correctly), which means
# the failure mode is a PERMANENT loop: every night's last spawn is cut,
# every night quarantines, no night ever publishes. A spawn that cannot
# finish before the job dies must not start.
_DEADLINE_CLOSE_MARGIN_SECONDS = 60  # seal + handoff + publish need this
_DEADLINE_MIN_USEFUL_SECONDS = 120  # below this a spawn cannot do real work


def _clamp_timeout_to_job_deadline(timeout_seconds: int) -> int:
    """Clamp a spawn's timeout to the job's remaining wall-clock.

    Binds only when ``ARIA_JOB_DEADLINE_EPOCH`` is exported (the autonomy
    workflows set it from their own timeout-minutes); local dev and tests
    run unclamped. A malformed value is refused loudly — a deadline that
    silently stopped binding is exactly the class this fix exists to kill.
    """
    raw = os.environ.get("ARIA_JOB_DEADLINE_EPOCH")
    if not raw:
        return timeout_seconds
    try:
        deadline = float(raw)
    except ValueError as exc:
        raise ClaudePolicyViolation(
            f"invalid_job_deadline: ARIA_JOB_DEADLINE_EPOCH={raw!r} is not a "
            f"unix epoch; refusing to spawn under a deadline that cannot bind"
        ) from exc
    import time as _time

    remaining = int(deadline - _time.time())
    if remaining < _DEADLINE_MIN_USEFUL_SECONDS + _DEADLINE_CLOSE_MARGIN_SECONDS:
        raise ClaudePolicyViolation(
            f"insufficient_wallclock: {remaining}s remain before the job "
            f"deadline; refusing the spawn so the night can close cleanly "
            f"instead of dying mid-flight and quarantining its state"
        )
    return min(timeout_seconds, remaining - _DEADLINE_CLOSE_MARGIN_SECONDS)


# E17-d — per-spawn usage recording identity. The (request_id, role,
# target_agent) triple lives in the EXECUTORS (ci_executor.invoke_claude_cli
# owns request_id + envelope role + subagent_type; worker_executor.main owns
# assignment_id + target_agent), while the model actually spawned and the
# terminal usage payload only exist HERE, inside run_claude_exec, one closure
# below run_with_model_fallback. Threading the identity down as an explicit
# value object puts the recording at the single seam where BOTH halves are in
# scope — every attempt (including a fallback-tier retry) records under the
# model it really ran on, and a future executor gets recording by passing one
# argument instead of re-implementing the seam.
@dataclass(frozen=True)
class UsageRecording:
    request_id: str
    role: str
    target_agent: str
    base_dir: Path


def _record_usage_best_effort(
    *, recording: UsageRecording, model: str | None, usage: dict[str, Any] | None,
) -> None:
    """Record the spawn's usage; NEVER fail the spawn over accounting.

    Measurement must not become a new spawn-failure mode: a completed agent
    run is strictly more valuable than its usage row, so an unimportable
    kernel (ImportError), a refused governed append (GovernanceError) or a
    dying disk (OSError) each degrade to a structured stderr note. The
    ``usage=None`` case is NOT handled here — record_context_usage owns that
    structural-skip branch and returns without writing.
    """
    def _note(reason: str, error: str) -> None:
        sys.stderr.write(json.dumps({
            "event": "context_usage_record_skipped",
            "reason": reason,
            "error": error,
            "request_id": recording.request_id,
            "role": recording.role,
            "target_agent": recording.target_agent,
        }, sort_keys=True) + "\n")

    try:
        from aria_kernel.tool_registry import GovernanceError
        from aria_kernel.usage_ledger import record_context_usage
    except ImportError as exc:
        _note("aria_kernel_unimportable", str(exc))
        return
    try:
        record_context_usage(
            request_id=recording.request_id,
            role=recording.role,
            target_agent=recording.target_agent,
            model=model,
            usage=usage,
            base_dir=recording.base_dir,
        )
    except (GovernanceError, OSError) as exc:
        _note("record_failed", str(exc))



def _envelope_from_profile(agent_profile: Any | None) -> tuple[tuple[str, ...], Sequence[str] | None, tuple[str, ...]]:
    """(disallowed_tools, write_scope, env_passthrough) for a spawn.

    A caller with no kernel profile (legacy/operator paths) gets the EMPTY
    envelope: no tool grant to derive denies from, the legacy whole-workspace
    scope, no passthrough. The never-granted tools are still denied.
    """
    from aria_kernel.runtime_profiles import ALWAYS_DENIED_TOOLS, disallowed_tools_for

    profile_id = getattr(agent_profile, "profile_id", None)
    if agent_profile is None or not profile_id:
        return tuple(ALWAYS_DENIED_TOOLS), None, ()
    from aria_kernel.runtime_profiles import profile_by_id

    kernel = profile_by_id(str(profile_id))
    scope: Sequence[str] | None = tuple(kernel.write_scope) if kernel.write_capable else ()
    # Plan 032 Faz 032g — MCP servers the profile does not name are closed as
    # tools too (`mcp__<server>`), on top of the strict config below.
    from aria_kernel.mcp_client import mcp_tool_rules

    return (*disallowed_tools_for(kernel), *mcp_tool_rules(kernel)), scope, tuple(kernel.env_passthrough)




def spawn_settings_hash(*, agent_profile: Any | None, usage_recording: UsageRecording | None, workspace_root: str | Path | None) -> str | None:
    """The hash of the settings document a spawn WOULD carry — the policy half
    of the session fingerprint (Faz 032c). None for the profile-less shape."""
    profile_id = getattr(agent_profile, "profile_id", None)
    if not profile_id:
        return None
    from aria_kernel.claude_settings import build_settings, settings_hash
    from aria_kernel.runtime_profiles import profile_by_id

    hook_context = _hook_context(usage_recording=usage_recording, workspace_root=workspace_root)
    return settings_hash(build_settings(profile_by_id(str(profile_id)), hook_context=hook_context))

def _hook_context(*, usage_recording: UsageRecording | None, workspace_root: str | Path | None) -> dict[str, str] | None:
    """The kernel facts the spawn's hooks and MCP relay are served with, or
    None for a spawn without a ledger or a workspace.

    ARIA-HIGH-142 — ``kernel_root`` is the RUNNING kernel's ``aria-kernel/``
    (``claude_settings.kernel_code_root``), not ``<workspace>/aria-kernel``:
    the clients are the kernel's, and a workspace checked out at a commit
    without them (trial eleven's task source) gave every hook and the relay
    a path that did not exist inside the sandbox. Both clients are checked
    HERE, before a settings document names them, so a kernel tree that
    lacks one refuses by name instead of a hook dying silently by path.
    """
    if usage_recording is None or workspace_root is None:
        return None
    from aria_kernel.claude_settings import hook_client_path, kernel_code_root
    from aria_kernel.mcp_client import MCP_RELAY_RELPATH

    kernel_root = kernel_code_root()
    for client in (hook_client_path(kernel_root), kernel_root.joinpath(*MCP_RELAY_RELPATH)):
        if not client.is_file():
            raise ClaudePolicyViolation(f"kernel_client_missing:{client}")
    return {
        "python": _spawn_interpreter(),
        "kernel_root": str(kernel_root),
        "tools_dir": str(Path(usage_recording.base_dir).resolve()),
        "workspace_root": str(Path(workspace_root).resolve()),
        "request_id": usage_recording.request_id,
    }


def _spawn_interpreter() -> str:
    """The interpreter the in-sandbox hook client and MCP relay run under:
    this process's, by its REAL path. The sandbox binds the system tree,
    not the directory a symlink named on PATH (ARIA-HIGH-124: a symlinked
    ``python3`` outside the binds gave the relay no interpreter inside),
    so the resolved binary is what exists on both sides."""
    executable = sys.executable or "python3"
    try:
        return os.path.realpath(executable)
    except OSError:
        return executable


def _kernel_profile(agent_profile: Any | None) -> Any | None:
    """The kernel runtime profile behind a spawn's agent profile, or None
    for the profile-less legacy shape."""
    profile_id = getattr(agent_profile, "profile_id", None)
    if not profile_id:
        return None
    from aria_kernel.runtime_profiles import profile_by_id

    return profile_by_id(str(profile_id))


def _write_spawn_mcp_config(*, agent_profile: Any | None, base_dir: Any | None, relay: Any | None = None) -> Path:
    """Plan 032 Faz 032g — the `--mcp-config` document for this spawn.

    ARIA-HIGH-124 — ``relay`` (an ``mcp_client.McpRelayContext``) is how the
    document reaches the kernel's own `aria` server: served OUTSIDE by this
    process (``mcp_broker``), relayed in by ``mcp_relay.py`` run by path
    under the workspace's read-only kernel tree. A profile that names the
    kernel's server on a spawn that serves no broker is refused by the
    kernel (``mcp_kernel_socket_requires_relay``), never handed a server
    spawned inside against a store that is not there.
    """
    from aria_kernel.mcp_client import mcp_config_for_profile, write_mcp_config_file

    profile_id = getattr(agent_profile, "profile_id", None)
    if not profile_id:
        return write_mcp_config_file({"mcpServers": {}}, label="noprofile")
    from aria_kernel.runtime_profiles import profile_by_id

    kernel = profile_by_id(str(profile_id))
    config = mcp_config_for_profile(kernel, base_dir=base_dir, relay=relay)
    return write_mcp_config_file(config, label=str(profile_id))


@dataclass(frozen=True)
class SpawnSettings:
    """The `--settings` document of one spawn and the kernel facts its hooks
    are served with (ARIA-HIGH-123): ``hook_context`` is None for a document
    without hooks (then no broker is served), ``turn_budget`` is the cap the
    document records (``_aria.turn_budget``) and the broker admits turns
    against — one number, read from the document the CLI carries."""

    path: Path | None
    hook_context: dict[str, str] | None = None
    turn_budget: int | None = None


_NO_SPAWN_SETTINGS = SpawnSettings(path=None)


def _write_spawn_settings(
    *,
    agent_profile: Any | None,
    usage_recording: UsageRecording | None,
    workspace_root: str | Path | None,
    write_capable: bool,
) -> SpawnSettings:
    """The `--settings` document for this spawn (``path`` None for the
    profile-less legacy shape). Fail-closed: a write-capable spawn under a
    kernel profile without a settings file is refused rather than run on
    prose."""
    profile_id = getattr(agent_profile, "profile_id", None)
    if not profile_id:
        return _NO_SPAWN_SETTINGS
    try:
        from aria_kernel.claude_settings import build_settings, write_settings_file
        from aria_kernel.runtime_profiles import profile_by_id
    except ImportError as exc:  # pragma: no cover
        raise ClaudePolicyViolation(
            f"claude_settings_builder_unavailable: {exc}; refusing a profiled spawn without its settings"
        ) from exc
    kernel = profile_by_id(str(profile_id))
    hook_context = _hook_context(usage_recording=usage_recording, workspace_root=workspace_root)
    if hook_context is None and write_capable:
        raise ClaudePolicyViolation(
            "claude_write_spawn_without_hook_context: a write-capable spawn needs a "
            "ledger (usage_recording.base_dir) and a workspace so its hooks can decide and journal"
        )
    settings = build_settings(kernel, hook_context=hook_context)
    import tempfile

    directory = Path(os.environ.get("RUNNER_TEMP") or tempfile.gettempdir()) / "aria-spawn-settings"
    path = write_settings_file(
        settings, directory=directory,
        request_id=(usage_recording.request_id if usage_recording is not None else f"preview-{os.getpid()}"),
    )
    turn_budget = settings["_aria"]["turn_budget"]
    return SpawnSettings(
        path=path, hook_context=hook_context,
        turn_budget=int(turn_budget) if turn_budget is not None else None,
    )

def _build_spawn_env(*, passthrough: Sequence[str], extra: dict[str, str]) -> tuple[dict[str, str], Any | None]:
    """Build the agent environment through the kernel; fail CLOSED if the
    kernel is unimportable — a copied environment is the defect this closes."""
    try:
        from aria_kernel.agent_env import build_agent_env
    except ImportError as exc:  # pragma: no cover - kernel always importable in lanes
        raise ClaudePolicyViolation(
            f"claude_spawn_env_builder_unavailable: cannot import agent_env ({exc}); "
            "refusing to spawn with a copied environment"
        ) from exc
    built = build_agent_env(os.environ, profile_passthrough=passthrough, extra=extra)
    return built.env, built.report


def _cleanup_spawn_home(home: str) -> None:
    try:
        from aria_kernel.agent_env import cleanup_synthetic_home
    except ImportError:  # pragma: no cover
        return
    cleanup_synthetic_home(home)


def _record_env_report_best_effort(*, recording: UsageRecording, report: Any) -> None:
    """`claude_subprocess_env_filtered` — names only; never a spawn failure."""
    try:
        from aria_kernel.tool_registry import append_tools_governance, ensure_tools_dir

        append_tools_governance(
            ensure_tools_dir(recording.base_dir),
            "claude_subprocess_env_filtered",
            {
                "request_id": recording.request_id,
                "target_agent": recording.target_agent,
                **report.to_governance(),
            },
        )
    except Exception:  # noqa: BLE001 — accounting must not fail the spawn
        return

@dataclass
class SpawnControl:
    """Plan 032 Faz 032e — the executor's handle on a live spawn.

    `should_cancel` is polled every `poll_seconds`; when it answers True the
    whole process group (timeout wrapper, bwrap, claude) gets SIGTERM, then
    SIGKILL after `grace_seconds`, and `cancelled`/`cancel_signal` say what
    happened. `on_event` receives every parsed stream-json event as it
    lands (the sanitized progress writer); it must never raise — it is
    guarded here anyway. With no control the spawn runs exactly as before.
    """

    should_cancel: Callable[[], bool] | None = None
    on_event: Callable[[dict[str, Any]], Any] | None = None
    poll_seconds: float = 2.0
    grace_seconds: float = 15.0
    cancelled: bool = False
    cancel_signal: str | None = None
    events_seen: int = 0


def _signal_group(proc: "subprocess.Popen[str]", sig: int) -> None:
    try:
        os.killpg(proc.pid, sig)
    except ProcessLookupError:
        pass


def _run_spawn(
    argv: list[str],
    *,
    input_text: str,
    timeout_seconds: float,
    cwd: str | None,
    env: dict[str, str],
    control: SpawnControl | None,
) -> "subprocess.CompletedProcess[str]":
    """The one subprocess seam: buffered run without a control, streamed
    + cancellable run with one. Both return a CompletedProcess."""
    if control is None:
        return subprocess.run(
            argv, input=input_text, capture_output=True, text=True,
            timeout=timeout_seconds, check=False, cwd=cwd, env=env,
        )
    proc = subprocess.Popen(
        argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, cwd=cwd, env=env, start_new_session=True,
    )
    out_lines: list[str] = []
    err_chunks: list[str] = []

    def _pump_stdout() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            out_lines.append(line)
            if control.on_event is None:
                continue
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if isinstance(event, dict):
                control.events_seen += 1
                try:
                    control.on_event(event)
                except Exception:  # noqa: BLE001 — a progress observer never fails the spawn
                    pass

    def _pump_stderr() -> None:
        assert proc.stderr is not None
        err_chunks.append(proc.stderr.read())

    pumps = (threading.Thread(target=_pump_stdout, daemon=True), threading.Thread(target=_pump_stderr, daemon=True))
    for pump in pumps:
        pump.start()
    try:
        assert proc.stdin is not None
        proc.stdin.write(input_text)
        proc.stdin.close()
    except (BrokenPipeError, OSError):
        pass
    deadline = time.monotonic() + timeout_seconds
    while True:
        try:
            proc.wait(timeout=control.poll_seconds)
            break
        except subprocess.TimeoutExpired:
            pass
        if control.should_cancel is not None and control.should_cancel():
            _signal_group(proc, signal.SIGTERM)
            control.cancel_signal = "sigterm"
            try:
                proc.wait(timeout=control.grace_seconds)
            except subprocess.TimeoutExpired:
                _signal_group(proc, signal.SIGKILL)
                control.cancel_signal = "sigkill"
                proc.wait()
            control.cancelled = True
            break
        if time.monotonic() > deadline:
            _signal_group(proc, signal.SIGKILL)
            proc.wait()
            for pump in pumps:
                pump.join(timeout=5)
            raise subprocess.TimeoutExpired(argv, timeout_seconds, output="".join(out_lines), stderr="".join(err_chunks))
    for pump in pumps:
        pump.join(timeout=5)
    return subprocess.CompletedProcess(argv, proc.returncode, "".join(out_lines), "".join(err_chunks))


def assert_model_served_by_claude_runtime(model: str | None) -> None:
    """Refuse, by name, a model that belongs to another provider.

    Operator policy 2026-09-11: this runtime spawns the managed Anthropic
    session and nothing else. Before this check the fleet's Z.ai tier reached
    the claude binary through a per-spawn base-URL redirect carrying the Z.ai
    key; that route is gone, and a caller that still asks this runtime for a
    foreign tier gets a policy refusal here instead of a confusing vendor
    error (or, worse, a spend on the wrong account) later.
    """
    provider = _model_provider(model)
    if provider != "anthropic":
        raise ClaudePolicyViolation(
            f"model_not_served_by_claude_runtime: {model!r} belongs to provider "
            f"{provider!r}; dispatch it through that provider's runtime"
        )


def run_claude_exec(
    *,
    prompt_text: str,
    timeout_seconds: int,
    model: str | None = None,
    effort: str | None = None,
    require_usage: bool | None = None,
    cwd: str | Path | None = None,
    skip_permissions: bool = True,
    permission_mode: str | None = None,
    usage_recording: UsageRecording | None = None,
    agent_profile: Any | None = None,
    session_id: str | None = None,
    resume: bool = False,
    # Plan 032 Faz 032d — per-spawn additions the executor computed (scoped
    # delivery credential, ARIA_REQUEST_ID). Values are never logged; the env
    # report carries names only.
    extra_env: dict[str, str] | None = None,
    # Plan 032 Faz 032e — cancel polling + live progress observer.
    spawn_control: SpawnControl | None = None,
    # ARIA-HIGH-123 — the commit-capable git containment the executor
    # derived while holding the implementer's identity; None for every
    # spawn that holds no identity (its git binds are derived read-only).
    git_containment: Any | None = None,
    # ARIA-HIGH-162 — the read shape (`read_contained_profile`): no bypass
    # flag, `--restricted --permission-prompts none --tools <grant>`, and the
    # workspace bound read-only under the same sandbox the write shape uses.
    read_containment: bool = False,
) -> ClaudeRunResult:
    assert_model_served_by_claude_runtime(model)
    preflight_claude_auth()
    if read_containment and (skip_permissions or permission_mode is not None):
        raise ClaudePolicyViolation("claude_read_containment_with_write_permissions")
    assert_write_runner_ok(skip_permissions=skip_permissions, permission_mode=permission_mode)
    _assert_budget_before_spawn()
    timeout_seconds = _clamp_timeout_to_job_deadline(timeout_seconds)
    # Plan 032 Faz 032b — the envelope is the agent's KERNEL profile (or the
    # empty envelope when the caller has none): the tool deny list, the write
    # scope and the environment passthrough all derive from it here, at the
    # spawn, never from prose in the agent file.
    disallowed_tools, write_scope, passthrough = _envelope_from_profile(agent_profile)
    argv = build_claude_exec_argv(
        model=model,
        effort=effort,
        skip_permissions=skip_permissions,
        permission_mode=permission_mode,
        disallowed_tools=disallowed_tools,
        session_id=session_id,
        resume=resume,
        read_shape=read_containment,
        read_shape_tools=tuple(getattr(_kernel_profile(agent_profile), "tools", ()) or ()),
    )
    # Plan 032 Faz 032b-2 — the per-spawn settings file: permission rules
    # compiled from the command policy + the kernel hooks. A write-capable
    # spawn under a kernel profile MUST carry it (I-V12-HOOK-01); a spawn
    # with no profile or no ledger context carries permission rules only.
    spawn_settings = _write_spawn_settings(
        agent_profile=agent_profile,
        usage_recording=usage_recording,
        workspace_root=cwd,
        write_capable=_is_write_capable(skip_permissions=skip_permissions, permission_mode=permission_mode),
    )
    settings_path = spawn_settings.path
    if settings_path is not None:
        argv.extend(["--settings", str(settings_path)])
    # ORPHAN-CRITICAL-427 — containment is applied HERE, by the code that
    # spawns the process, not by prose in the agent's own instruction file.
    # A write-capable shape (full permission bypass or acceptEdits) gets
    # wrapped so READONLY_PATHS are ro-bind: a write under aria-kernel/ or
    # .github/ then fails with EROFS at the syscall level instead of
    # depending on the agent choosing to obey.
    # ARIA-HIGH-123 — the hooks the settings compile are served by a broker
    # in THIS process (`hook_broker`), on a socket the sandbox is handed:
    # the store, the workspace, the request id and the turn cap are the
    # broker's own facts, read from the document the CLI carries; nothing
    # of the store is mounted in the sandbox. One broker per spawn, alive
    # exactly as long as the spawn.
    from aria_kernel.hook_broker import HOOK_BROKER_SOCKET_ENV, serve_hook_broker
    from aria_kernel.mcp_broker import MCP_BROKER_SOCKET_ENV, serve_mcp_broker
    from aria_kernel.mcp_client import McpRelayContext, kernel_socket_servers

    with _ExitStack() as spawn_stack:
        broker = None
        mcp_broker = None
        if spawn_settings.hook_context is not None:
            broker = spawn_stack.enter_context(serve_hook_broker(
                base_dir=spawn_settings.hook_context["tools_dir"],
                workspace_root=spawn_settings.hook_context["workspace_root"],
                request_id=spawn_settings.hook_context["request_id"],
                turn_budget=spawn_settings.turn_budget,
            ))
            # ARIA-HIGH-124 — the kernel's own MCP server is served HERE,
            # outside the sandbox, against the store the hooks journal
            # into, for the spawn's life; the relay the document names is
            # its only way in. A profile that names no kernel server gets
            # no broker.
            if kernel_socket_servers(_kernel_profile(agent_profile)):
                mcp_broker = spawn_stack.enter_context(serve_mcp_broker(
                    base_dir=spawn_settings.hook_context["tools_dir"],
                    workspace_root=spawn_settings.hook_context["workspace_root"],
                    request_id=spawn_settings.hook_context["request_id"],
                ))
        # Plan 032 Faz 032g — MCP config per spawn, ALWAYS strict: only the
        # kernel registry servers the profile names (minus quarantined); a
        # profile-less spawn gets an empty document, i.e. no MCP server at
        # all. Written after the brokers exist, because the kernel's server
        # renders as the relay to this spawn's broker socket.
        mcp_config_path = _write_spawn_mcp_config(
            agent_profile=agent_profile, base_dir=getattr(usage_recording, "base_dir", None),
            relay=(McpRelayContext(
                python=_spawn_interpreter(),
                kernel_root=Path(spawn_settings.hook_context["kernel_root"]),
            ) if mcp_broker is not None else None),
        )
        argv.extend(["--strict-mcp-config", "--mcp-config", str(mcp_config_path)])
        # The spawn environment is BUILT (agent_env), never copied: baseline +
        # CLI auth + profile passthrough, secrets dropped by name. Built before
        # containment so the managed-login directory it derived can be ro-bound.
        spawn_env, env_report = _build_spawn_env(
            passthrough=passthrough,
            extra={**({"IS_SANDBOX": "1"} if _sandbox_acknowledged() else {}),
                   # PYTHONPATH names the workspace's kernel tree exactly as
                   # in the lanes, for the agent's own validation runs
                   # (`python3 -m unittest …` over kernel tests). No kernel
                   # CLI runs inside any more: `python3 -m aria_kernel …` is
                   # refused by the command policy (ARIA-HIGH-124), and the
                   # hook client and the MCP relay are run by path and
                   # import nothing from the package.
                   **({"PYTHONPATH": str(Path(cwd).resolve() / "aria-kernel")} if cwd is not None else {}),
                   # The broker's HOST socket: what an unconfined spawn's
                   # hooks connect to; the sandbox overrides the name with
                   # the bound path.
                   **({HOOK_BROKER_SOCKET_ENV: str(broker.socket_path)} if broker is not None else {}),
                   # ARIA-HIGH-124 — the MCP broker's HOST socket, the same
                   # way: the relay inherits it from the CLI; the sandbox
                   # overrides the name with the bound path.
                   **({MCP_BROKER_SOCKET_ENV: str(mcp_broker.socket_path)} if mcp_broker is not None else {}),
                   **(dict(extra_env) if extra_env else {})},
        )
        config_dir = env_report.claude_config_dir if env_report is not None else None
        # The binary the attempt names is the binary that runs: resolved ONCE,
        # here, in the built environment's PATH, and run by that absolute path
        # inside and outside the sandbox (ARIA-HIGH-077).
        executable = _resolve_claude_executable(spawn_env)
        argv[0] = str(executable)
        argv = _apply_write_containment(
            argv,
            skip_permissions=skip_permissions,
            permission_mode=permission_mode,
            workspace_root=cwd,
            write_scope=write_scope,
            executable=executable,
            spawn_files=tuple(path for path in (settings_path, mcp_config_path) if path is not None),
            managed_login_dir=Path(config_dir) if config_dir else None,
            git_containment=git_containment,
            hook_broker_socket=broker.socket_path if broker is not None else None,
            mcp_broker_socket=mcp_broker.socket_path if mcp_broker is not None else None,
            read_containment=read_containment,
            session_store_dir=_session_store_dir(),
        )
        # ORPHAN-MEDIUM-459 — resource limits, applied by the spawner for the same
        # reason containment is. `apply_resource_limits` shipped with the sandbox
        # work, was exported, was name-pinned by a test, and had ZERO production
        # callers: its only instruction to actually run it lived in
        # `.claude/agents/aria-implementer.md`, addressed to the process being
        # limited. A fork bomb or a runaway allocation in a write-capable agent
        # was bounded by nothing.
        #
        # OUTSIDE the sandbox wrapper on purpose: `timeout` and `systemd-run`
        # must own the whole process tree including bwrap, not run inside it.
        #
        # The caller's `timeout_seconds`, not the helper's 120s default — an
        # agent run is minutes, and a 120s cap would kill every real invocation.
        # The subprocess timeout below stays 30s looser so the cgroup/`timeout`
        # limit fires first and its exit status is what the caller sees.
        # Probed in the environment the agent launches with, plus the bus
        # plumbing only the limiter receives (it is unset again for the agent).
        argv = _apply_resource_limits(
            argv, timeout_seconds=timeout_seconds, environ=spawn_env, control_source=os.environ,
        )
        # IS_SANDBOX (root bypass acknowledgement) and the vendor redirect
        # (ORPHAN-HIGH-764, scoped to THIS spawn) were folded into the built
        # environment above; nothing else from the runner's environment reaches
        # the agent. Names only are recorded, best-effort, next to usage.
        if usage_recording is not None and env_report is not None:
            _record_env_report_best_effort(recording=usage_recording, report=env_report)
        run_env = spawn_env
        try:
            # Plan 032 Faz 032e — one seam: buffered without a control, streamed
            # and cancellable (process group) with one.
            proc = _run_spawn(
                argv,
                input_text=prompt_text,
                timeout_seconds=timeout_seconds + 30,
                cwd=str(cwd) if cwd is not None else None,
                env=run_env,
                control=spawn_control,
            )
        finally:
            if env_report is not None:
                _cleanup_spawn_home(env_report.home)
    events = parse_claude_jsonl(proc.stdout)
    final_message = extract_final_message(events)
    usage = extract_usage(events)
    # E17-d — record the terminal usage per role/agent the moment it is
    # extracted (cache_* fields included), BEFORE the require_usage gate:
    # a nonzero-exit run's tokens were still billed and must still be
    # accounted. A None usage records nothing (the ledger's explicit
    # structural-skip branch), so the require_usage refusal below stays the
    # only voice on that failure.
    if usage_recording is not None:
        _record_usage_best_effort(recording=usage_recording, model=model, usage=usage)
    if require_usage is None:
        require_usage = _parse_bool(
            os.environ.get(REQUIRE_USAGE_ENV_VAR, "1"),
            env_name=REQUIRE_USAGE_ENV_VAR,
        )
    if proc.returncode == 0 and require_usage and usage is None:
        raise ClaudeUsageUnavailable("claude_stream_json_missing_result_usage")
    result = ClaudeRunResult(
        returncode=proc.returncode,
        stdout=proc.stdout,
        stderr=proc.stderr,
        final_message=final_message,
        usage=usage,
        events=events,
        refusal=extract_refusal(events),
        auth_failure=extract_auth_failure(
            returncode=proc.returncode,
            stdout=proc.stdout,
            stderr=proc.stderr,
            final_message=final_message,
        ),
        credit_exhaustion=extract_credit_exhaustion(
            returncode=proc.returncode, stderr=proc.stderr, events=events,
            final_message=final_message,
        ),
    )
    # ARIA-HIGH-002 — stamp the typed classification on the result itself so
    # downstream consumers (drains, evidence surfaces) read one vocabulary
    # instead of re-deriving it from markers. Lazy import: dispatch_failure
    # imports this module, so the dependency direction resolves at call time.
    from dispatch_failure import classify_dispatch_failure

    failure = classify_dispatch_failure(result=result, phase="runtime")
    if failure is not None:
        result = replace(
            result,
            failure_class=failure.failure_class,
            retryable=failure.retryable,
            failure_detail_code=failure.detail_code,
        )
    return result


def parse_claude_jsonl(raw: str) -> tuple[dict[str, Any], ...]:
    events: list[dict[str, Any]] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            events.append(payload)
    return tuple(events)


def extract_final_message(events: tuple[dict[str, Any], ...]) -> str:
    """Return the agent's final text — the whole final turn, not its last frame.

    Claude Code stream-json terminates with a ``{"type":"result",...}`` event
    whose ``result`` field is the text of the LAST assistant message. A long
    answer is streamed as several consecutive ``assistant`` events: trial
    nine's challenger (2026-09-12, ARIA-HIGH-083) hit the CLI's output token
    limit; the CLI injected a synthetic user turn ("Output token limit hit.
    Resume directly …", ``isSynthetic: true``), the model resumed mid-JSON,
    and ``result`` carried only the resumed frame (3,795 of 42,661 chars) —
    the executor saw a JSON tail, found no ``plan_content`` and refused a
    complete, valid plan. The final turn is every assistant text frame after
    the last REAL user event (a tool result); a synthetic continuation joins
    the frames it separates. ``result`` is used when it is not a suffix of
    that turn (an error-typed result, a shape this reader does not know) and
    as the fallback when no frame was seen.
    """
    turn: list[str] = []
    result_text = ""
    for event in events:
        kind = event.get("type")
        if kind == "user":
            if event.get("isSynthetic") is True:
                continue
            turn = []
        elif kind == "assistant":
            text = _assistant_text(event.get("message"))
            if text:
                turn.append(text)
        elif kind == "result":
            value = event.get("result")
            if isinstance(value, str):
                result_text = value
    joined = "".join(turn)
    if joined and (not result_text or joined.endswith(result_text)):
        return joined
    return result_text or joined


def _assistant_text(message: Any) -> str:
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        ]
        return "".join(p for p in parts if isinstance(p, str))
    return ""


def extract_refusal(events: tuple[dict[str, Any], ...]) -> dict[str, Any] | None:
    """Detect a model-safety refusal in Claude stream-json events (K2).

    Two candidate shapes are matched, per the 2026-07-01 live probe of the
    stream-json surface (assistant events embed the API message with
    ``stop_reason`` + ``stop_details``; the terminal ``result`` event carries
    ``subtype``):

    * an ``assistant`` event whose ``message.stop_reason == "refusal"`` —
      the API-level classifier decline (Fable safety classifiers; category
      commonly ``cyber``/``bio``);
    * a ``result`` event whose ``subtype`` names a refusal.

    Returns a record naming which shape fired (``source``) plus the
    ``category``/``explanation`` from ``stop_details`` when present, or
    ``None`` when no refusal marker exists. Detection only — what happens
    next is fixed by the operator decision of 2026-09-12: a refusal is never
    retried on another tier. ``run_with_model_fallback`` returns it on the
    result and each executor escalates it to HUMAN_REQUIRED under
    ``model_safety_refusal_unresolved`` (ci_executor writes the
    unresolved-result row; worker_executor exits non-zero with that line on
    stderr).
    """
    for event in events:
        if event.get("type") == "assistant":
            message = event.get("message") or {}
            if message.get("stop_reason") == "refusal":
                details = message.get("stop_details") or {}
                return {
                    "source": "assistant_stop_reason",
                    "category": details.get("category"),
                    "explanation": details.get("explanation"),
                    "model": message.get("model"),
                }
        if event.get("type") == "result":
            subtype = str(event.get("subtype") or "")
            if "refusal" in subtype:
                return {
                    "source": "result_subtype",
                    "category": None,
                    "explanation": str(event.get("result") or "")[:300],
                    "model": None,
                }
    return None


# Credit/quota exhaustion has TWO distinct wire shapes under managed-session
# auth — proven live 2026-07-03 when ARIA's Fable pool ran dry:
#
# (1) CLI USAGE-LIMIT MESSAGE — the Claude Code CLI returns its OWN limit
#     notice as ASSISTANT CONTENT on a CLEAN run (returncode 0, zero output
#     tokens, terminal_reason=completed):
#       "You've reached your Fable 5 limit. Run /usage-credits to continue or
#        switch models with /model."
#     It is NOT a stderr error and NOT a nonzero exit, so it MUST be matched on
#     the response TEXT regardless of returncode. These markers are specific
#     enough that content-matching is false-positive-safe (an agent plan does
#     not naturally contain "/usage-credits" or "switch models with /model").
USAGE_LIMIT_MARKERS: tuple[str, ...] = (
    "usage-credits",              # the /usage-credits purchase command
    "switch models with /model",  # the model-switch hint in the limit notice
)
# (2) API CREDIT/QUOTA ERROR — an actual failure (returncode != 0) whose text
#     names a credit/quota/billing problem.
#
# Transient signals ("overloaded", a bare per-minute rate limit / HTTP 429,
# network/timeout) are in NEITHER set — they stay on the EXTERNAL_OUTAGE
# requeue path (retry on the SAME model clears them), whereas credit exhaustion
# is deterministic and provider-wide: it clears only when the provider's
# quota comes back, which is why the executors requeue the request under a
# provider cooldown instead of retrying it on any tier.
CREDIT_ERROR_MARKERS: tuple[str, ...] = (
    "credit balance",          # "Your credit balance is too low"
    "insufficient credit",
    "insufficient_quota",
    "insufficient funds",
    "quota exceeded",
    "quota_exceeded",
    "out of credits",
    "purchase more credits",
    "billing",
    "payment required",        # HTTP 402 reason phrase (avoids a bare "402" match)
    "usage limit reached",
)
# Union kept under the original name for external/test references. The operator
# tunes these from production evidence: every exhaustion is audited with the
# real matched marker — the executor's `model_credit_exhausted` row (ci) or
# stderr line (worker) at detection, and the `provider_quota_cooldown`
# governance row (`aria_kernel.provider_cooldown`), whose `detection` field
# carries the same record, when the provider is cooled.
CREDIT_EXHAUSTION_MARKERS: tuple[str, ...] = USAGE_LIMIT_MARKERS + CREDIT_ERROR_MARKERS

# (3) AUTHENTICATION FAILURE — the runtime cannot start at all.
#
# Distinct from both sets above, and the distinction is not cosmetic. A credit
# exhaustion is a quota fact about one provider and clears with time (the
# request waits it out under the provider cooldown); a refusal is content
# specific and is escalated to a human. An expired session is a CREDENTIAL
# fact: every tier of the same vendor shares it, so the only honest retry is
# on another vendor (ARIA-HIGH-023), and only for a role that vendor's
# read-only runtime can serve.
#
# This class cost five silent nights of autonomy (2026-08-04 → 08): the CI
# executor claimed a request, the CLI exited 1 with
# "OAuth session expired and could not be refreshed", the claim was released as
# a generic `claude_cli_exit_1`, and the whole judgment → consensus →
# calibration → gold-corpus chain stayed empty because nothing named the cause.
AUTH_FAILURE_MARKERS: tuple[str, ...] = (
    "oauth session expired",
    "could not be refreshed",
    "failed to authenticate",
    "not authenticated",
    "authentication_error",
    "invalid api key",
    "please run /login",
    "please log in",
)


def extract_auth_failure(
    *, returncode: int, stdout: str, stderr: str, final_message: str
) -> dict[str, Any] | None:
    """Name an authentication failure, or return None.

    Matched on the union of the streams because the CLI reports this on stderr
    with a nonzero exit, while some paths surface it as content. Requires a
    NONZERO returncode: the phrase appearing inside an agent's answer about
    authentication code must not be read as the runtime failing to start.
    """
    if returncode == 0:
        return None
    blob = f"{stdout}\n{stderr}\n{final_message}".lower()
    marker = next((m for m in AUTH_FAILURE_MARKERS if m in blob), None)
    if marker is None:
        return None
    return {
        "kind": "auth_failure",
        "marker": marker,
        "returncode": returncode,
        # The remedy is a human act on the runner host, so it travels with the
        # detection rather than living only in a runbook nobody opens at 03:00.
        "remedy": "re-authenticate the Claude CLI on the runner host (`claude` login as the runner user)",
    }


def run_with_model_fallback(
    *,
    run: Callable[[str, str], ClaudeRunResult],
    model: str,
    effort: str,
    write_capable: bool,
    on_credit: Callable[[str, dict[str, Any]], None] | None = None,
) -> ClaudeRunResult:
    """Run one dispatch and apply the cross-vendor auth failover.

    ``run(model, effort)`` executes a single attempt. This is the SSoT for the
    failover behaviour both executors share (extracted so it is unit-testable
    without a full lease/dispatch environment). ``write_capable`` is the
    profile's own fact (``AgentRuntimeProfile.write_capable``) and is what
    conditions the failover on the role, in code rather than prose.

    Operator decision 2026-09-12 — what this helper does and does NOT do:

    * A CREDIT/QUOTA exhaustion is terminal for the attempt on EVERY tier:
      ``on_credit(model, record)`` fires with the tier that ran out and the
      detection record (the executor's audit — the tier is passed because
      it may be the failover rung, not the primary), then
      :class:`ClaudeCreditExhausted` is raised naming the exhausted provider
      and model. There is no in-vendor downgrade rung any more —
      ``opus`` is a leaf, and sonnet/haiku/fable are selected by nothing.
      The executor releases the claim as REQUEUED and, on the native lane,
      cools the provider so the next admission skips it; the request is
      retried when the provider is back, never on a weaker tier.
    * A REFUSAL is returned on the result (``.refusal``), not retried: the
      executors escalate it to HUMAN_REQUIRED (``model_safety_refusal_unresolved``).
    * ARIA-HIGH-023 — an AUTH failure walks ``AUTH_FAILOVER_TIER`` (same-vendor
      rungs skipped, cycle-bounded) to the first CROSS-provider tier whose
      runtime can serve this role and retries there at the original effort:
      a dead credential is a vendor-level fact, and the other vendor's
      credential is genuinely different. A write-scope profile has no such
      rung — the other vendors' runtimes are read-only — so its auth failure
      is terminal at once. Both vendors failing auth raises
      :class:`ClaudeAuthFailure`; no mock verdict is ever produced here. The
      failover attempt's own credit exhaustion is the same terminal raise,
      naming the vendor that ran out.
    * Exactly ONE retry per call, never chained.
    """
    completed = run(model, effort)
    if completed.auth_failure is not None:
        cross = _cross_provider_auth_fallback(model, write_capable=write_capable)
        if cross is not None:
            try:
                retried = run(cross, effort)
            except ClaudeAuthUnavailable as exc:
                # ARIA-HIGH-157 — a rung whose credential is not even
                # configured must not replace the PRIMARY's verdict with its
                # own: the first production drain released every claim as
                # "zai credential not configured" while the cause was the
                # managed login's refresh. Terminal, naming both, with the
                # primary's remedy first.
                raise ClaudeAuthFailure(
                    f"claude_auth_failure: {completed.auth_failure.get('marker')} on "
                    f"{model!r}, and the cross-provider rung {cross!r} is unavailable "
                    f"({exc}); remedy: {completed.auth_failure.get('remedy')}"
                ) from exc
            if retried.auth_failure is not None:
                raise ClaudeAuthFailure(
                    f"claude_auth_failure: {completed.auth_failure.get('marker')} on "
                    f"{model!r}, and the cross-provider rung {cross!r} failed auth "
                    f"too ({retried.auth_failure.get('marker')}) — both providers "
                    f"are unavailable; remedy: {completed.auth_failure.get('remedy')}"
                )
            return _stamp_model(_raise_if_exhausted(retried, model=cross, on_credit=on_credit), cross)
        raise ClaudeAuthFailure(
            f"claude_auth_failure: {completed.auth_failure.get('marker')} on {model!r}"
            + (" — a write-scope profile has no cross-vendor rung (the other "
               "runtimes are read-only)" if write_capable else " — no cross-vendor rung")
            + f"; {completed.auth_failure.get('remedy')}"
        )
    return _stamp_model(_raise_if_exhausted(completed, model=model, on_credit=on_credit), model)


def _stamp_model(result: ClaudeRunResult, model: str) -> ClaudeRunResult:
    """The result carries the model that answered (ARIA-MEDIUM-171).

    A runtime that already named its model (the Z.ai adapter names the tier
    it dispatched) keeps its own word; a CLI result is stamped with the tier
    this rung dispatched.
    """
    if result.model:
        return result
    return replace(result, model=model)


def _raise_if_exhausted(
    result: ClaudeRunResult, *, model: str, on_credit: Callable[[str, dict[str, Any]], None] | None,
) -> ClaudeRunResult:
    """A credit-exhausted result is never returned (ORPHAN-HIGH-473/475).

    The audit hook fires BEFORE the raise so the exhaustion is recorded even
    though the attempt ends here. The exception carries the provider the
    fleet binds the model to: that is the key the executor's release reason
    and the native cooldown are written under.
    """
    if result.credit_exhaustion is None:
        return result
    if on_credit is not None:
        on_credit(model, result.credit_exhaustion)
    provider = _model_provider(model)
    raise ClaudeCreditExhausted(
        f"claude_credit_exhausted: provider={provider!r} model={model!r} — no tier "
        f"retries a quota exhaustion; the request is requeued for when the provider "
        f"is back ({result.credit_exhaustion})",
        provider=provider, model=model, detail=dict(result.credit_exhaustion),
    )


def extract_credit_exhaustion(
    *,
    returncode: int,
    stderr: str,
    events: tuple[dict[str, Any], ...],
    final_message: str = "",
) -> dict[str, Any] | None:
    """Detect a credit/quota-exhaustion failure (detection only — sibling of
    :func:`extract_refusal`; what happens next is run_with_model_fallback's
    terminal raise and the executors' requeue-under-cooldown).

    Two shapes are matched over the FULL response text (stderr + final message
    + assistant content + the terminal ``result`` event):

    * A CLI **usage-limit message** (``USAGE_LIMIT_MARKERS`` or the
      "reached your … limit" co-occurrence) fires REGARDLESS of returncode —
      the CLI returns its limit notice as assistant content on a clean exit,
      so a ``returncode != 0`` gate would miss it (the 2026-07-03 live case).
    * An API **credit/quota error** (``CREDIT_ERROR_MARKERS``) fires only on a
      real failure (``returncode != 0``), so a plan that merely mentions
      "billing" on a clean run is never misread.

    Returns a record naming the matched marker, or ``None``.
    """
    haystacks: list[str] = [stderr or "", final_message or ""]
    for event in events:
        if event.get("type") == "assistant":
            haystacks.append(_assistant_text(event.get("message")))
        if event.get("type") == "result":
            haystacks.append(str(event.get("result") or ""))
            haystacks.append(str(event.get("error") or ""))
            haystacks.append(str(event.get("subtype") or ""))
    blob = "\n".join(haystacks).lower()
    # (1) CLI usage-limit MESSAGE — content-based, returncode-independent.
    limit_marker = next((m for m in USAGE_LIMIT_MARKERS if m in blob), None)
    if limit_marker is None and "reached your" in blob and "limit" in blob:
        limit_marker = "reached_your_limit"
    if limit_marker is not None:
        return {
            "source": "cli_usage_limit_message",
            "matched_marker": limit_marker,
            "returncode": returncode,
        }
    # (2) API credit/quota ERROR — gated on a real (nonzero-exit) failure.
    if returncode != 0:
        for marker in CREDIT_ERROR_MARKERS:
            if marker in blob:
                return {
                    "source": "cli_error_text",
                    "matched_marker": marker,
                    "returncode": returncode,
                }
    return None


def extract_usage(events: tuple[dict[str, Any], ...]) -> dict[str, Any] | None:
    """Return the token usage from the terminal ``result`` event.

    Claude Code attaches ``usage`` (input/output/cache tokens) to the final
    ``result`` event. We scan from the end so the terminal turn wins.
    """
    for event in reversed(events):
        if event.get("type") == "result":
            usage = event.get("usage")
            if isinstance(usage, dict):
                return dict(usage)
        usage = event.get("usage")
        if isinstance(usage, dict):
            return dict(usage)
    return None


def _parse_bool(raw: str, *, env_name: str) -> bool:
    value = raw.strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off", ""}:
        return False
    raise ClaudePolicyViolation(f"{env_name}={raw!r} is not a valid boolean")
