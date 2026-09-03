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
  ``aria_kernel.agent_runtime_profile``); ARIA's fail-safe default is Fable.
* Raw stream-json stays in memory; callers persist only sanitized envelopes.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Callable, Sequence


CLAUDE_BINARY_ENV_VAR = "CLAUDE_CLI_BINARY"
CLAUDE_MOCK_ENV_VAR = "CLAUDE_CLI_MOCK"
# ARIA's default model tier. The Claude Code CLI accepts a model alias
# ("fable") or a full id; the alias resolves to Claude Fable 5 on the
# runner, keeping ARIA's fail-safe on the most capable tier (K5 tier
# flip, operator policy 2026-07-01). Per-agent overrides flow in via
# build_claude_exec_argv(model=...).
CLAUDE_DEFAULT_MODEL = "fable"
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

# ORPHAN-HIGH-473 — the fallback topology, as data rather than a literal string
# test. The policy was `if model != "fable": return completed`, so moving the
# primary tier off fable would have silently disabled the whole credit and
# refusal fallback with nothing failing. Expressed as a map, adding or moving a
# tier is an edit to the topology, not an invisible behaviour change.
#
# The value is the tier that owns a SEPARATE credit pool, which is the entire
# reason a credit fallback can work at all.
MODEL_FALLBACK_TIER: dict[str, str] = {
    # Planning tier: fable is the most capable and most expensive pool.
    "fable": "opus",
    # Implementation tier (operator decision): opus, falling back to sonnet.
    # Before this entry opus was a LEAF — an implementer that exhausted its
    # quota had nowhere to go, and since ORPHAN-HIGH-475 that raises terminally
    # rather than silently returning the usage-limit notice as an answer. The
    # ladder is what makes running the write tier on opus safe.
    "opus": "sonnet",
    # ARIA-HIGH-023 — cross-provider rungs. Every Anthropic tier's chain now
    # terminates at a DIFFERENT vendor: an absent subscription is a
    # credential-level failure no same-vendor rung can cure, so auth failures
    # walk the ladder to the first cross-provider tier (see
    # run_with_model_fallback). Bidirectional: a dead Z.ai key falls glm-5.3
    # back to the Anthropic pool at the strongest authoring tier.
    "sonnet": "glm-5.3",
    "glm-5.3": "opus",
}

# The effort a credit retry escalates to ("ultra code" retry).
CREDIT_FALLBACK_EFFORT: str = "max"


def _model_provider(model: str | None) -> str:
    """The vendor a tier authenticates through (ARIA-HIGH-023).

    Models listed in PROVIDER_REDIRECTS reach their vendor through that
    redirect's credential; everything else authenticates through the managed
    Anthropic session. The provider, not the tier name, is what an auth
    failure is a fact ABOUT: a dead credential cannot be cured by any rung
    inside the same vendor, and can be by the first rung outside it.
    """
    redirect = PROVIDER_REDIRECTS.get(str(model or ""))
    return redirect["provider"] if redirect is not None else "anthropic"


def _cross_provider_auth_fallback(model: str | None) -> str | None:
    """First ladder tier authenticating through a DIFFERENT vendor (ARIA-HIGH-023).

    Walks ``MODEL_FALLBACK_TIER`` from ``model``, skipping same-vendor rungs
    (they share the dead credential), and returns the first cross-vendor tier.
    Cycle-bounded: the cross-provider rungs make the ladder cyclic
    (``opus -> sonnet -> glm-5.3 -> opus``), so the walk tracks visited tiers
    and gives up at the first repeat. Returns ``None`` when no cross-vendor
    tier is reachable — the caller then treats the auth failure as terminal.
    """
    origin_provider = _model_provider(model)
    visited: set[str] = set()
    current = MODEL_FALLBACK_TIER.get(str(model or ""))
    while current is not None and current not in visited:
        visited.add(current)
        if _model_provider(current) != origin_provider:
            return current
        current = MODEL_FALLBACK_TIER.get(current)
    return None


# NOTE: a `has_fallback_tier(model)` predicate was added here alongside the
# ladder and removed in the same branch (ORPHAN-HIGH-481). It had zero
# production callers — run_with_model_fallback does its own
# `MODEL_FALLBACK_TIER.get(model)` because it needs the TARGET, not a boolean —
# so the predicate was speculative API in the one branch whose whole purpose is
# deleting controls that are written, tested and never called. The map is the
# SSoT; read it directly.
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

# ORPHAN-HIGH-764 — per-spawn provider redirect.
#
# WHY NOT A GLOBAL EXPORT. Z.ai serves GLM behind an Anthropic-shaped
# endpoint, so the documented setup is to export ANTHROPIC_BASE_URL +
# ANTHROPIC_AUTH_TOKEN. Doing that HERE would redirect every dispatch — judges,
# planners, implementer — to one vendor, silently, because this process
# dispatches many models. The redirect therefore binds to a single spawn's
# `run_env` and never to `os.environ`.
#
# WHY THIS IS NOT ROUTING AROUND THE GATE. `assert_claude_policy_environment`
# reads `os.environ`, so a run_env-only injection would never trip it — which
# is precisely why it must not be left implicit. A redirect is a NEW mode, so
# it gets its own named authorisation and its own named refusals, and it is
# recorded rather than inferred. The gate guards managed-auth BILLING bypass;
# this guards WHICH VENDOR a spawn reaches. Two questions, two gates.
PROVIDER_REDIRECT_POLICY_ENV_VAR = "ARIA_PROVIDER_REDIRECT_POLICY_REF"

# THE BASE URL IS CONFIGURABLE ON PURPOSE, and the reason is money.
#
# Z.ai documents THREE endpoints and they bill differently: the Coding-Plan
# route (`/api/coding/paas/v4`) draws the subscription quota, the general route
# (`/api/paas/v4`) draws the prepaid wallet, and the Anthropic-compatible route
# (`/api/anthropic`) is listed as a third protocol whose billing the docs do
# not settle — they warn only that the Anthropic base URL "does not apply to
# resource packages / prepaid balance" and that swapping Coding for general
# charges the wallet instead of the plan. A published bug in another harness is
# exactly this: a Coding-Plan key routed to the generic endpoint and billed
# against balance while the paid subscription sat unused.
#
# Which of those a given plan+key actually consumes is an EMPIRICAL question
# (make one call, read the vendor dashboard), so it must not be frozen into a
# constant. The default is the documented Anthropic-compatible route because
# that is the one Claude Code speaks; the operator overrides it in one env var
# once the billing side is measured, with no code change and no redeploy.
PROVIDER_REDIRECT_BASE_URL_ENV_TEMPLATE = "ARIA_{provider}_BASE_URL"
PROVIDER_REDIRECTS: dict[str, dict[str, str]] = {
    "glm-5.3": {
        "provider": "zai",
        "default_base_url": "https://api.z.ai/api/anthropic",
        "token_env_var": "ARIA_ZAI_API_KEY",
    },
}


class ProviderRedirectUnavailable(RuntimeError):
    """A model needs a vendor redirect that is not authorised or not configured."""


def provider_redirect_env(model: str | None) -> dict[str, str]:
    """The env a spawn on ``model`` needs to reach its vendor, or ``{}``.

    Fail-closed in both directions, and NAMED in both: an unauthorised
    redirect and a missing credential are different operator problems, and a
    single "it didn't work" would send the reader to the wrong one. Silence is
    the failure this repository keeps paying for — a missing key must not
    degrade into a dispatch that quietly reaches the wrong vendor, or none.
    """
    redirect = PROVIDER_REDIRECTS.get(str(model or ""))
    if redirect is None:
        return {}
    policy_ref = os.environ.get(PROVIDER_REDIRECT_POLICY_ENV_VAR, "").strip()
    if not policy_ref:
        raise ProviderRedirectUnavailable(
            f"provider_redirect_unauthorised: model {model!r} routes to "
            f"{redirect['provider']!r}; set {PROVIDER_REDIRECT_POLICY_ENV_VAR} "
            "to the operator policy reference that authorises it"
        )
    token = os.environ.get(redirect["token_env_var"], "").strip()
    if not token:
        raise ProviderRedirectUnavailable(
            f"provider_redirect_token_missing: model {model!r} needs "
            f"{redirect['token_env_var']} in the runner environment"
        )
    override_var = PROVIDER_REDIRECT_BASE_URL_ENV_TEMPLATE.format(
        provider=redirect["provider"].upper(),
    )
    base_url = os.environ.get(override_var, "").strip() or redirect["default_base_url"]
    return {
        "ANTHROPIC_BASE_URL": base_url,
        "ANTHROPIC_AUTH_TOKEN": token,
    }


def provider_redirect_disclosure(model: str | None) -> dict[str, str]:
    """What a spawn on ``model`` should RECORD about where it was sent.

    Never the token. The endpoint is the fact that answers "did this night
    consume the subscription we paid for, or the wallet?" — and today that
    question cannot be answered from ARIA's own ledgers at all, which is how a
    paid plan sits unused while a balance drains.
    """
    redirect = PROVIDER_REDIRECTS.get(str(model or ""))
    if redirect is None:
        return {}
    override_var = PROVIDER_REDIRECT_BASE_URL_ENV_TEMPLATE.format(
        provider=redirect["provider"].upper(),
    )
    return {
        "provider": redirect["provider"],
        "base_url": os.environ.get(override_var, "").strip() or redirect["default_base_url"],
        "base_url_source": "operator_override" if os.environ.get(override_var, "").strip() else "default",
    }


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
    """A quota/credit exhaustion that no fallback tier can recover.

    ORPHAN-HIGH-473 — raised instead of returning the run result. Per
    extract_credit_exhaustion, the CLI delivers its usage-limit notice as
    ASSISTANT CONTENT on a clean exit (returncode 0), so an exhausted run is
    shaped exactly like a successful one. Neither executor inspected
    ``.credit_exhaustion`` on the returned result, so "You've reached your
    limit. Run /usage-credits..." was flowing downstream as the agent's answer
    and being persisted as a real envelope. A result that cannot be told apart
    from an answer must not be returned at all.
    """


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
    # stream-json events, or None. Callers own the fallback policy; the
    # runtime only detects and reports.
    refusal: dict[str, Any] | None = None
    # Credit/quota-exhaustion record (fable primary → opus fallback sibling of
    # the K2 refusal path), or None. Detection only; executors own the policy.
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


def is_mock_mode() -> bool:
    return _parse_bool(os.environ.get(CLAUDE_MOCK_ENV_VAR, "0"), env_name=CLAUDE_MOCK_ENV_VAR)


def claude_binary() -> str:
    return os.environ.get(CLAUDE_BINARY_ENV_VAR, "claude")


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
    extra_ro_binds: Sequence[str] = (),
) -> list[str]:
    """Wrap a write-capable spawn so READONLY_PATHS are enforced by the OS.

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
        return argv
    workspace = Path(workspace_root) if workspace_root is not None else Path.cwd()
    try:
        from aria_kernel.implementation_safety import (
            SandboxUnavailable,
            wrap_bash_in_sandbox,
        )
    except ImportError as exc:  # pragma: no cover - kernel always importable here
        raise ClaudePolicyViolation(
            f"claude_write_containment_unavailable: cannot import the sandbox "
            f"helper ({exc}); refusing to spawn a write-capable agent unconfined"
        ) from exc
    try:
        return wrap_bash_in_sandbox(
            argv, workspace_root=workspace, allow_network=True,
            write_scope=write_scope, extra_ro_binds=extra_ro_binds,
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


def _apply_resource_limits(argv: list[str], *, timeout_seconds: int) -> list[str]:
    """Bound the spawned agent's memory, CPU, task count and wall clock.

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
        )
    except ImportError as exc:  # pragma: no cover - kernel always importable here
        raise ClaudePolicyViolation(
            f"claude_resource_limits_unavailable: cannot import the limit "
            f"helper ({exc}); refusing to spawn an unbounded agent"
        ) from exc
    try:
        return apply_resource_limits(argv, timeout_seconds=timeout_seconds)
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
    return disallowed_tools_for(kernel), scope, tuple(kernel.env_passthrough)




def spawn_settings_hash(*, agent_profile: Any | None, usage_recording: UsageRecording | None, workspace_root: str | Path | None) -> str | None:
    """The hash of the settings document a spawn WOULD carry — the policy half
    of the session fingerprint (Faz 032c). None for the profile-less shape."""
    profile_id = getattr(agent_profile, "profile_id", None)
    if not profile_id:
        return None
    from aria_kernel.claude_settings import build_settings, settings_hash
    from aria_kernel.runtime_profiles import profile_by_id

    hook_context = None
    if usage_recording is not None and workspace_root is not None:
        hook_context = {
            "python": sys.executable or "python3",
            "kernel_root": str(Path(workspace_root).resolve() / "aria-kernel"),
            "tools_dir": str(Path(usage_recording.base_dir).resolve()),
            "workspace_root": str(Path(workspace_root).resolve()),
            "request_id": usage_recording.request_id,
        }
    return settings_hash(build_settings(profile_by_id(str(profile_id)), hook_context=hook_context))

def _write_spawn_settings(
    *,
    agent_profile: Any | None,
    usage_recording: UsageRecording | None,
    workspace_root: str | Path | None,
    write_capable: bool,
) -> Path | None:
    """The `--settings` document for this spawn, or None for the profile-less
    legacy shape. Fail-closed: a write-capable spawn under a kernel profile
    without a settings file is refused rather than run on prose."""
    profile_id = getattr(agent_profile, "profile_id", None)
    if not profile_id:
        return None
    try:
        from aria_kernel.claude_settings import build_settings, write_settings_file
        from aria_kernel.runtime_profiles import profile_by_id
    except ImportError as exc:  # pragma: no cover
        raise ClaudePolicyViolation(
            f"claude_settings_builder_unavailable: {exc}; refusing a profiled spawn without its settings"
        ) from exc
    kernel = profile_by_id(str(profile_id))
    hook_context = None
    if usage_recording is not None and workspace_root is not None:
        hook_context = {
            "python": sys.executable or "python3",
            "kernel_root": str(Path(workspace_root).resolve() / "aria-kernel"),
            "tools_dir": str(Path(usage_recording.base_dir).resolve()),
            "workspace_root": str(Path(workspace_root).resolve()),
            "request_id": usage_recording.request_id,
        }
    elif write_capable:
        raise ClaudePolicyViolation(
            "claude_write_spawn_without_hook_context: a write-capable spawn needs a "
            "ledger (usage_recording.base_dir) and a workspace so its hooks can decide and journal"
        )
    settings = build_settings(kernel, hook_context=hook_context)
    import tempfile

    directory = Path(os.environ.get("RUNNER_TEMP") or tempfile.gettempdir()) / "aria-spawn-settings"
    return write_settings_file(
        settings, directory=directory,
        request_id=(usage_recording.request_id if usage_recording is not None else f"preview-{os.getpid()}"),
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
) -> ClaudeRunResult:
    preflight_claude_auth()
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
    )
    # Plan 032 Faz 032b-2 — the per-spawn settings file: permission rules
    # compiled from the command policy + the kernel hooks. A write-capable
    # spawn under a kernel profile MUST carry it (I-V12-HOOK-01); a spawn
    # with no profile or no ledger context carries permission rules only.
    settings_path = _write_spawn_settings(
        agent_profile=agent_profile,
        usage_recording=usage_recording,
        workspace_root=cwd,
        write_capable=_is_write_capable(skip_permissions=skip_permissions, permission_mode=permission_mode),
    )
    if settings_path is not None:
        argv.extend(["--settings", str(settings_path)])
    # ORPHAN-CRITICAL-427 — containment is applied HERE, by the code that
    # spawns the process, not by prose in the agent's own instruction file.
    # A write-capable shape (full permission bypass or acceptEdits) gets
    # wrapped so READONLY_PATHS are ro-bind: a write under aria-kernel/ or
    # .github/ then fails with EROFS at the syscall level instead of
    # depending on the agent choosing to obey.
    # The spawn environment is BUILT (agent_env), never copied: baseline +
    # CLI auth + profile passthrough, secrets dropped by name. Built before
    # containment so the managed-login directory it derived can be ro-bound.
    spawn_env, env_report = _build_spawn_env(
        passthrough=passthrough,
        extra={**({"IS_SANDBOX": "1"} if _sandbox_acknowledged() else {}),
               **provider_redirect_env(model),
               # The hooks run `python3 -m aria_kernel` inside the sandbox;
               # the kernel rides PYTHONPATH there exactly as in the lanes.
               **({"PYTHONPATH": str(Path(cwd).resolve() / "aria-kernel")} if cwd is not None else {})},
    )
    config_dir = env_report.claude_config_dir if env_report is not None else None
    argv = _apply_write_containment(
        argv,
        skip_permissions=skip_permissions,
        permission_mode=permission_mode,
        workspace_root=cwd,
        write_scope=write_scope,
        extra_ro_binds=(config_dir,) if config_dir else (),
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
    argv = _apply_resource_limits(argv, timeout_seconds=timeout_seconds)
    # IS_SANDBOX (root bypass acknowledgement) and the vendor redirect
    # (ORPHAN-HIGH-764, scoped to THIS spawn) were folded into the built
    # environment above; nothing else from the runner's environment reaches
    # the agent. Names only are recorded, best-effort, next to usage.
    if usage_recording is not None and env_report is not None:
        _record_env_report_best_effort(recording=usage_recording, report=env_report)
    run_env = spawn_env
    try:
        proc = subprocess.run(
            argv,
            input=prompt_text,
            capture_output=True,
            text=True,
            timeout=timeout_seconds + 30,
            check=False,
            cwd=str(cwd) if cwd is not None else None,
            env=run_env,
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
    """Return the agent's final text.

    Claude Code stream-json terminates with a ``{"type":"result",...}`` event
    whose ``result`` field is the final assistant text. We prefer that; if it
    is absent (e.g. an error-typed result) we fall back to the last
    ``assistant`` message's concatenated text blocks.
    """
    final = ""
    for event in events:
        if event.get("type") == "result":
            result_text = event.get("result")
            if isinstance(result_text, str):
                final = result_text
        elif event.get("type") == "assistant":
            text = _assistant_text(event.get("message"))
            if text:
                final = text
    return final


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
    ``None`` when no refusal marker exists. Detection only — the fallback
    policy (single audited retry on the fallback tier, HUMAN_REQUIRED on a
    second refusal) lives in the executors.
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
# is deterministic and model-pool specific (only a different tier's pool
# resolves it), exactly like a refusal.
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
# tunes these from production: every credit fallback emits a governance row
# carrying the real matched marker.
CREDIT_EXHAUSTION_MARKERS: tuple[str, ...] = USAGE_LIMIT_MARKERS + CREDIT_ERROR_MARKERS

# (3) AUTHENTICATION FAILURE — the runtime cannot start at all.
#
# Distinct from both sets above, and the distinction is not cosmetic. A credit
# exhaustion is model-pool specific, so dropping a tier can clear it; a refusal
# is content specific, so a different model can clear it. An expired session
# clears on NEITHER — every tier authenticates through the same credential, so
# the fallback ladder just burns two attempts and reports the second failure.
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
    on_credit: Callable[[dict[str, Any]], None] | None = None,
    on_refusal: Callable[[dict[str, Any]], None] | None = None,
) -> ClaudeRunResult:
    """Run one dispatch and apply the model fallback ladder.

    ``run(model, effort)`` executes a single attempt. This is the SSoT for the
    fallback behaviour both executors share (extracted so it is unit-testable
    without a full lease/dispatch environment).

    ORPHAN-HIGH-480 — this docstring described the pre-ladder single-hop policy
    on five counts after the code had moved on, which is the same stale-prose
    defect as the jest tier comments (ORPHAN-MEDIUM-477). Corrected to match:

    * Fallback fires for any tier present in ``MODEL_FALLBACK_TIER`` — the
      in-vendor credit ladder (``fable -> opus``, ``opus -> sonnet``) plus the
      cross-provider rungs (``sonnet -> glm-5.3``, ``glm-5.3 -> opus``). It is
      NOT keyed to one model name.
    * A credit/quota exhaustion retries once on the mapped tier at
      ``CREDIT_FALLBACK_EFFORT`` — a separate credit pool at ultracode depth.
    * A refusal retries once on the mapped tier at the ORIGINAL effort (K2).
    * ARIA-HIGH-023 — an AUTH failure walks the ladder (same-vendor rungs
      skipped, cycle-bounded) to the first CROSS-provider tier and retries
      there at the original effort: a dead credential is a vendor-level fact,
      and the other vendor's credential is genuinely different. Both vendors
      failing auth raises :class:`ClaudeAuthFailure`; no mock verdict is ever
      produced on this path.
    * Credit and refusal retries are bounded to exactly ONE rung per call,
      never chained. Credit takes precedence over refusal.
    * A credit exhaustion that cannot be recovered — the tier has no mapped
      fallback, or the fallback tier is ALSO exhausted — RAISES
      :class:`ClaudeCreditExhausted`. It is not returned. The earlier claim that
      the caller escalates such a result was false: no caller inspects
      ``credit_exhaustion`` on the returned value, so returning it silently
      published a usage-limit notice as the agent's answer (ORPHAN-HIGH-475).

    The ``on_credit`` / ``on_refusal`` hooks receive the detection record so the
    caller can emit its own audit (ci_executor: governance rows; worker_executor:
    stderr). Hooks never alter control flow, and on_credit fires BEFORE a raise
    so an unrecoverable exhaustion is still recorded.
    """
    completed = run(model, effort)
    # Checked FIRST and never retried: a different tier authenticates through
    # the same credential, so the ladder would burn a second attempt to learn
    # the same thing, and then report the second failure as if it were the
    # cause.
    if completed.auth_failure is not None:
        # ARIA-HIGH-023 — an auth failure is a fact about the PROVIDER's
        # credential, not the tier: every same-vendor rung would burn a spawn
        # to relearn the same dead credential. Walk the ladder (cycle-bounded)
        # to the first CROSS-provider tier and retry there at the original
        # effort; only when that also fails auth — both vendors unavailable —
        # is the failure terminal. This is what lets the lane keep working
        # with real providers while one subscription is absent; there is no
        # mock verdict anywhere on this path.
        cross = _cross_provider_auth_fallback(model)
        if cross is not None:
            retried = run(cross, effort)
            if retried.auth_failure is None:
                return retried
            raise ClaudeAuthFailure(
                f"claude_auth_failure: {completed.auth_failure.get('marker')} on "
                f"{model!r}, and the cross-provider rung {cross!r} failed auth "
                f"too ({retried.auth_failure.get('marker')}) — both providers "
                f"are unavailable; remedy: {completed.auth_failure.get('remedy')}"
            )
        raise ClaudeAuthFailure(
            f"claude_auth_failure: {completed.auth_failure.get('marker')} — "
            f"{completed.auth_failure.get('remedy')}"
        )
    fallback_model = MODEL_FALLBACK_TIER.get(model)
    if fallback_model is None:
        # No alternate credit pool. A credit exhaustion here is TERMINAL, and
        # returning it would hand the caller a usage-limit notice shaped like
        # an answer — see ClaudeCreditExhausted. The hook still fires so the
        # audit records the exhaustion before we refuse.
        if completed.credit_exhaustion is not None:
            if on_credit is not None:
                on_credit(completed.credit_exhaustion)
            raise ClaudeCreditExhausted(
                f"claude_credit_exhausted: model={model!r} has no fallback tier "
                f"({completed.credit_exhaustion})"
            )
        return completed
    if completed.credit_exhaustion is not None:
        if on_credit is not None:
            on_credit(completed.credit_exhaustion)
        return _reject_exhausted(run(fallback_model, CREDIT_FALLBACK_EFFORT), fallback_model)
    if completed.refusal is not None:
        if on_refusal is not None:
            on_refusal(completed.refusal)
        return _reject_exhausted(run(fallback_model, effort), fallback_model)
    return completed


def _reject_exhausted(result: ClaudeRunResult, model: str) -> ClaudeRunResult:
    """ORPHAN-HIGH-473 — the retry's own exhaustion is terminal too.

    The single-retry budget is deliberate, but the pre-fix docstring claimed the
    caller escalates a credit signal on the retry result. It does not: neither
    executor reads ``.credit_exhaustion`` off the value it gets back. So an
    exhausted retry was the same silent-answer path as an exhausted primary,
    one call further down.
    """
    if result.credit_exhaustion is not None:
        raise ClaudeCreditExhausted(
            f"claude_credit_exhausted: fallback tier {model!r} is also exhausted "
            f"({result.credit_exhaustion})"
        )
    return result


def extract_credit_exhaustion(
    *,
    returncode: int,
    stderr: str,
    events: tuple[dict[str, Any], ...],
    final_message: str = "",
) -> dict[str, Any] | None:
    """Detect a credit/quota-exhaustion failure (detection only — sibling of
    :func:`extract_refusal`; the fable→opus fallback policy lives in the
    executors).

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
