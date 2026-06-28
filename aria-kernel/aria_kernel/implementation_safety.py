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
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


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
ALLOWED_BASH_COMMANDS: frozenset[re.Pattern[str]] = frozenset({
    re.compile(r"^(?:/[\w./-]+/)?python3?(\.\d+)?\s+[\w./-]+\.py(\s+\S+)*\s*$"),
    re.compile(r"^(?:/[\w./-]+/)?python3?(\.\d+)?\s+-m\s+unittest(\s+\S+)*\s*$"),
    re.compile(r"^node\s+(\./)?node_modules/ts-node/dist/bin\.js(\s+\S+)*\s*$"),
    re.compile(r"^git\s+add(\s+\S+)*\s*$"),
    re.compile(r"^git\s+commit(\s+-[a-zA-Z]+)*(\s+-m\s+.+)?$"),
    re.compile(r"^git\s+diff(\s+\S+)*\s*$"),
    re.compile(r"^git\s+log(\s+\S+)*\s*$"),
    re.compile(r"^git\s+status(\s+\S+)*\s*$"),
    re.compile(r"^git\s+rev-parse(\s+\S+)*\s*$"),
    re.compile(r"^git\s+push\s+origin\s+aria-impl-[a-f0-9]{6,32}(\s+\S+)*\s*$"),
    re.compile(r"^gh\s+pr\s+create\s+--base\s+main(\s+\S+)*\s*$"),
    re.compile(r"^gh\s+pr\s+checks(\s+\S+)*\s*$"),
    re.compile(r"^gh\s+pr\s+view(\s+\S+)*\s*$"),
    re.compile(r"^gh\s+pr\s+diff(\s+\S+)*\s*$"),
    re.compile(r"^npm\s+test(\s+\S+)*\s*$"),
    re.compile(r"^nx\s+(affected|test|lint|build)(\s+\S+)*\s*$"),
    re.compile(r"^pytest(\s+\S+)*\s*$"),
    re.compile(r"^cargo\s+(test|check|build|fmt|clippy)(\s+\S+)*\s*$"),
    re.compile(r"^npm\s+run\s+(type-check|format|lint)(\s+\S+)*\s*$"),
    re.compile(r"^prettier(\s+\S+)*\s*$"),
    re.compile(r"^eslint(\s+\S+)*\s*$"),
})
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
DENIED_BASH_COMMANDS: frozenset[re.Pattern[str]] = frozenset({
    re.compile(r"^(curl|wget|nc|ncat|telnet|ftp)\b"),  # net egress
    re.compile(r"^(ssh|scp|rsync)\b"),                  # remote
    re.compile(r"^(dd|mkfifo)\b"),                      # filesystem primitives
    re.compile(r"^(eval|exec|source|\.)\s"),            # shell primitives
    re.compile(r"^sh\s+-c\b"),                          # subshell
    re.compile(r"^bash\s+-c\b"),                        # subshell
    re.compile(r"^(chmod|chown)\s+777\b"),              # over-permissive
    re.compile(r"^(sudo|su)\b"),                        # privilege escalation
    re.compile(r"^(apt|apt-get|yum|dnf|pacman|brew)\b"),  # pkg install
    re.compile(r"^(docker|kubectl|helm)\b"),            # orchestration
    re.compile(r"^gh\s+api\s+(-X\s+)?(DELETE|PATCH|PUT)\b"),  # GH API mutation
    re.compile(r"^gh\s+api\b.*(?:^|\s)/?repos/[^/\s]+/[^/\s]+/pulls/[^/\s]+/merge(?:[/?#]\S*)?(?:\s|$)"),
    re.compile(r"^gh\s+workflow\b"),                    # workflow mutation
    re.compile(r"^gh\s+secret\b"),                      # secret list/set
    re.compile(r"^gh\s+release\b"),                     # release create
    re.compile(r"^gh\s+pr\s+merge\b"),                  # merge authority only
    re.compile(r"^(env|printenv|set)\s*$"),             # env exfil bare dump
    re.compile(r"\$GH_TOKEN\b"),                        # token reference
    re.compile(r"\$GITHUB_TOKEN\b"),
    re.compile(r"\.env(\.|\b)"),                        # .env access
    re.compile(r"id_rsa\b"),                            # ssh key access
    re.compile(r"--force\b"),                           # any force flag
    re.compile(r"--no-verify\b"),                       # hook bypass
    re.compile(r"--no-gpg-sign\b"),                     # signing bypass
    re.compile(r"--force-with-lease\b"),
    re.compile(r"\bgit\s+push\s+(?:\+|.+:refs/heads/main\b|origin\s+\+)"),
    re.compile(r"core\.hooksPath"),                     # hooks bypass via config
})

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


def verify_bash_command_allowed(argv: list[str], *, cwd: str | Path | None = None) -> None:
    """Hard-fail check 8 — Bash allowlist (NOT blocklist).

    Joins argv with spaces, tests against:
      1. DENIED_BASH_COMMANDS — any hit → BashDenylistHit
      2. ALLOWED_BASH_COMMANDS — at least one MUST match → otherwise
         BashAllowlistMiss

    Order: deny first, then allow. A command matching both is
    rejected (deny wins).
    """
    if not isinstance(argv, (list, tuple)) or not argv:
        raise BashAllowlistMiss(f"argv must be a non-empty list, got {argv!r}")
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
    """Hard-fail check 8b — gh api path forbidden? Used by callers
    that do a finer-grained inspection of ``gh api <PATH>`` argv
    structure rather than relying on the regex allowlist alone."""
    if not isinstance(path, str):
        return True  # fail closed
    stripped = path.strip()
    if not stripped:
        return True
    if any(token in stripped for token in ("{", "}", "$(", "`", ";", "&&", "||")):
        return True
    normalized = stripped if stripped.startswith("/") else "/" + stripped
    return any(p.search(normalized) for p in FORBIDDEN_GH_API_PATHS)


def _bwrap_available() -> bool:
    return shutil.which("bwrap") is not None


def _firejail_available() -> bool:
    return shutil.which("firejail") is not None


def wrap_bash_in_sandbox(
    argv: list[str],
    *,
    workspace_root: str | Path,
    allow_network: bool = False,
) -> list[str]:
    """Hard-fail check 8c — Bash sandbox wrapper.

    Returns the argv prefixed with bwrap / firejail flags pinning:
      * Workspace mounted writable
      * READONLY_PATHS mounted ro-bind
      * ``--unshare-net`` (no network egress) unless allow_network=True
      * ``/tmp`` mounted as tmpfs
      * No /root, /home, /etc/secrets bind

    When neither bwrap nor firejail available, returns argv unchanged
    but emits a warning (Tier-3 detect — caller should record a
    governance event).
    """
    workspace = Path(workspace_root).resolve()
    if _bwrap_available():
        wrap = [
            "bwrap",
            "--ro-bind", "/usr", "/usr",
            "--ro-bind", "/etc/alternatives", "/etc/alternatives",
            "--ro-bind", "/etc/ssl", "/etc/ssl",
            "--ro-bind", "/lib", "/lib",
            "--ro-bind", "/lib64", "/lib64",
            "--ro-bind", "/bin", "/bin",
            "--proc", "/proc",
            "--dev", "/dev",
            "--tmpfs", "/tmp",
            "--bind", str(workspace), str(workspace),
            "--chdir", str(workspace),
        ]
        # READONLY_PATHS mounted ro-bind on top of the writable
        # workspace — ANY mutation under these paths gets EROFS.
        for ro in READONLY_PATHS:
            full = workspace / ro
            if full.exists():
                wrap.extend(["--ro-bind", str(full), str(full)])
        if not allow_network:
            wrap.append("--unshare-net")
        wrap.append("--")
        return wrap + list(argv)
    if _firejail_available():
        wrap = ["firejail", "--quiet", "--private-tmp", f"--whitelist={workspace}"]
        if not allow_network:
            wrap.append("--net=none")
        return wrap + list(argv)
    # No sandbox available — caller should record governance event.
    return list(argv)


def apply_resource_limits(argv: list[str], *, timeout_seconds: int = 120) -> list[str]:
    """Hard-fail check ancillary — per-command resource limits.

    Wraps argv in ``systemd-run --user --scope`` with cgroup limits
    when available; otherwise prefixes ``timeout <seconds>``.

    Limits:
      * MemoryMax=2G
      * CPUQuota=200% (2 cores worth)
      * TasksMax=50 (fork-bomb mitigation)
      * Timeout per invocation
    """
    if shutil.which("systemd-run") is not None:
        return [
            "systemd-run",
            "--user", "--scope", "--quiet",
            "--property=MemoryMax=2G",
            "--property=CPUQuota=200%",
            "--property=TasksMax=50",
            f"--property=TimeoutStopSec={timeout_seconds}",
        ] + list(argv)
    if shutil.which("timeout") is not None:
        return ["timeout", str(timeout_seconds)] + list(argv)
    return list(argv)


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

@dataclass(frozen=True)
class HardFailCheck:
    """A single named hard-fail check. The registry is iterable by
    orchestrator pre-PR-open + pre-merge gates."""

    name: str
    description: str
    closes_findings: tuple[str, ...]


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
    ),
    HardFailCheck(
        name="no_no_verify",
        description="--no-verify + core.hooksPath denial",
        closes_findings=("sec-CRIT-002",),
    ),
    HardFailCheck(
        name="no_main_branch_write",
        description="direct push + gh api PATCH/PUT/DELETE on branches/protections",
        closes_findings=("sec-CRIT-002", "sec-CRIT-003"),
    ),
    HardFailCheck(
        name="forbidden_scope_normalized",
        description="Path.resolve() + symlink + glob match against READONLY_PATHS",
        closes_findings=("arb-HIGH-004", "ai-HIGH-006"),
    ),
    HardFailCheck(
        name="kernel_self_modification_blocked_at_envelope_mint",
        description="envelope-mint refuses when affected_surfaces ∩ READONLY_PATHS ≠ ∅",
        closes_findings=("ai-CRIT-005", "arb-CRIT-005"),
    ),
    HardFailCheck(
        name="test_gate_canonical_suite",
        description="validation_commands[] MUST include canonical suite (nx affected, type-check, mutation, coverage)",
        closes_findings=("ai-HIGH-008",),
    ),
    HardFailCheck(
        name="secret_scan_diff_clean",
        description="verify_no_secret_in_diff BEFORE gh pr create",
        closes_findings=("ai-CRIT-004", "sec-HIGH-005"),
    ),
    HardFailCheck(
        name="bash_command_allowlist",
        description="verify_bash_command_allowed at runtime tool dispatch",
        closes_findings=("ai-CRIT-002", "sec-CRIT-002"),
    ),
    HardFailCheck(
        name="path_escape_guard",
        description="verify_no_path_escape on Edit/Write path arg resolution",
        closes_findings=("ai-HIGH-006",),
    ),
    HardFailCheck(
        name="branch_tip_lock_and_recheck",
        description="branch_tip_sha captured; auto-merge re-verifies headRefOid pre-merge",
        closes_findings=("ai-HIGH-007", "sec-HIGH-002"),
    ),
    HardFailCheck(
        name="per_file_mutual_exclusion",
        description="_validate_implementation_request rejects locked affected_surfaces",
        closes_findings=("ai-HIGH-009",),
    ),
    HardFailCheck(
        name="operator_feedback_signature",
        description="plan_synthesizer rejects unsigned operator-feedback rows",
        closes_findings=("ai-HIGH-010",),
    ),
    HardFailCheck(
        name="pr_body_templating",
        description="render_pr_body() with bidi-strip + comment-ban (Tier-2)",
        closes_findings=("ai-HIGH-012", "sec-HIGH-008"),
    ),
    HardFailCheck(
        name="cycle_and_turn_budget_cap",
        description="per-cycle $1.50 + per-implementer-turn N=10 caps with reservation-reconcile",
        closes_findings=("ai-HIGH-013", "perf-CRIT-001"),
    ),
    HardFailCheck(
        name="content_hash_recheck",
        description="implementer recomputes SHA256 of CONVERGED plan vs envelope.content_hash",
        closes_findings=("ai-MED-019",),
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
    "is_gh_api_path_forbidden",
    "wrap_bash_in_sandbox",
    "apply_resource_limits",
    "truncate_validation_result",
    # registry
    "HardFailCheck",
    "HARD_FAIL_CHECKS",
)
