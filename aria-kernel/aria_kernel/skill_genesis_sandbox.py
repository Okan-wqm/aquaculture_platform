"""Plan ARIA-V9.0-E — skill genesis adapter sandbox.

Closes:
  * ai-safety-auditor MED-015 — 3-cycle threshold supply-chain risk:
    skill_genesis can author new tool adapters from N consecutive
    CONVERGED cycles with identical pattern_signature; without
    sandboxing, the adapter runs unconstrained on subsequent cycles
    with full repo access. V9.0-E sandbox bounds the adapter via
    bwrap (--unshare-net, --ro-bind workspace, --tmpfs /tmp) +
    static AST allowlist (stdlib-only imports) + Sigstore signing
    at authoring time.
  * security-reviewer CRIT-006 — tool adapter execution sandbox:
    same surface, security-side framing. The sandbox is the
    Tier-1 anchor (make impossible to do network egress or read
    secrets from the adapter subprocess).

V9.0-E ships the SANDBOX MECHANICS + AST validator. The
registration flow (skill_genesis_drainer integration + N>=5
threshold + ≥2 distinct pressure_source types + distinct
cross_reviewer_agent_ids + HUMAN_REQUIRED routing for
aria-tools/registry.json writes) lands in V10.2.

Tier-1 (make impossible):
  * AST allowlist refuses adapter source containing forbidden
    imports BEFORE the file lands on disk
  * bwrap --unshare-net prevents network egress at namespace level
  * --ro-bind READONLY_PATHS + workspace-scoped mounts prevent
    cross-tree reads (no /root, no /home, no /etc/secrets)

Tier-3 (detect):
  * Sigstore signature on adapter source — verified at every
    dispatch, drift fires governance event
"""
from __future__ import annotations

import ast
import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any


# Plan ARIA-V9.0-E — Python stdlib imports permitted inside skill
# adapters. Closed allowlist; an adapter importing anything outside
# this set fails the AST validator BEFORE authoring lands on disk.
#
# Rationale: skill adapters are deterministic detection rules
# (recurring pattern → emit row). They need re, json, file I/O,
# typing — nothing else. Network primitives (urllib, socket,
# requests, http, ftplib, smtplib, ssl) and subprocess primitives
# are FORBIDDEN — supply-chain class (sec CRIT-006).
ALLOWED_ADAPTER_IMPORTS: frozenset[str] = frozenset({
    # core
    "__future__", "typing", "enum", "dataclasses",
    # data
    "re", "json", "hashlib", "base64",
    # paths + io
    "os.path", "pathlib", "io",
    # collections
    "collections", "collections.abc", "itertools", "functools",
    # datetime
    "datetime",
    # math
    "math", "decimal",
    # sys (limited — sys.argv parsing only; exec/setrecursionlimit etc
    # not gated here but downstream policy rules forbid via runtime).
    "sys",
})

# Plan ARIA-V9.0-E — explicit deny set. Even if a name leaks into
# ALLOWED via accident, the deny set fires first.
FORBIDDEN_ADAPTER_IMPORTS: frozenset[str] = frozenset({
    "urllib", "urllib.request", "urllib.parse", "urllib.error",
    "http", "http.client", "http.server", "http.cookies",
    "socket", "socketserver", "selectors", "asyncio",
    "ssl", "secrets",
    "requests", "httpx", "aiohttp",
    "ftplib", "smtplib", "telnetlib", "poplib", "imaplib",
    "subprocess", "multiprocessing", "threading",
    "ctypes", "cffi",
    "os",  # `os` allowed too broadly (exec, popen, system); use os.path explicitly
    "shutil",
    "platform",
    "tempfile",  # would let adapter write outside workspace
    "pty", "fcntl", "termios",
    "pickle", "shelve", "marshal",  # deserialization attack vectors
    "importlib", "imp", "runpy",     # dynamic import bypass
})


class UnsafeAdapterImport(Exception):
    """Raised by ``verify_adapter_imports`` when the AST contains a
    forbidden import. Message lists the offending import names but
    NEVER the surrounding code body (potential injection vector)."""


class AdapterSignatureMismatch(Exception):
    """Raised when the adapter source hash doesn't match the
    Sigstore-signed bundle on dispatch."""


@dataclass(frozen=True)
class SandboxedResult:
    """Result of an adapter run inside the sandbox."""

    exit_code: int
    stdout: str
    stderr: str
    timed_out: bool


def verify_adapter_imports(source: str) -> None:
    """Parse ``source`` as Python AST; assert every ``import X`` /
    ``from X import ...`` resolves to a name in ALLOWED_ADAPTER_IMPORTS
    AND not in FORBIDDEN_ADAPTER_IMPORTS.

    Tier-1 — make impossible to land an adapter with network or
    subprocess capability via static AST inspection BEFORE the file
    is written. The validator runs in skill_genesis_drainer's
    pre-write gate.

    Raises UnsafeAdapterImport on any violation.
    """
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        raise UnsafeAdapterImport(
            f"adapter source is not valid Python: {exc.msg} at line {exc.lineno}"
        ) from exc

    forbidden_hits: list[str] = []
    not_in_allowlist: list[str] = []

    for node in ast.walk(tree):
        names: list[str] = []
        if isinstance(node, ast.Import):
            names = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            # `from foo.bar import baz` → import root foo.bar
            if node.module:
                names = [node.module]
        for name in names:
            # Resolution order (Tier-1 precedence):
            #   1. Exact name in ALLOWED → permit (lets caller import a
            #      narrow safe subpath like ``os.path`` even when the
            #      broader root ``os`` is in FORBIDDEN).
            #   2. Exact name in FORBIDDEN → reject.
            #   3. Root in FORBIDDEN (and name NOT in ALLOWED) → reject.
            #   4. Root NOT in ALLOWED → reject (closed allowlist).
            if name in ALLOWED_ADAPTER_IMPORTS:
                continue
            if name in FORBIDDEN_ADAPTER_IMPORTS:
                forbidden_hits.append(name)
                continue
            root = name.split(".")[0]
            if root in FORBIDDEN_ADAPTER_IMPORTS:
                forbidden_hits.append(name)
                continue
            if root not in ALLOWED_ADAPTER_IMPORTS:
                not_in_allowlist.append(name)

    if forbidden_hits or not_in_allowlist:
        raise UnsafeAdapterImport(
            f"adapter imports rejected — "
            f"forbidden={sorted(set(forbidden_hits))} "
            f"not-in-allowlist={sorted(set(not_in_allowlist))}"
        )


def _bwrap_available() -> bool:
    return shutil.which("bwrap") is not None


def _firejail_available() -> bool:
    return shutil.which("firejail") is not None


def execute_in_sandbox(
    adapter_path: str | Path,
    stdin_payload: str | bytes | None = None,
    *,
    workspace_root: str | Path,
    timeout_seconds: int = 60,
    python: str = "python3",
) -> SandboxedResult:
    """Run an adapter inside a network-isolated sandbox.

    Sandbox layout (bwrap preferred, firejail fallback, else
    refuses):
      * --unshare-net           — no network egress (CRIT-006)
      * --tmpfs /tmp            — writable but workspace-scoped
      * --ro-bind /usr /usr     — Python stdlib read-only
      * --bind workspace        — adapter can read repo
      * No /root, /home, /etc/secrets, /etc/ssh, /var/run/secrets

    Adapter receives stdin_payload on stdin; emits result on stdout.

    Returns SandboxedResult(exit_code, stdout, stderr, timed_out).

    When neither bwrap nor firejail are available, raises RuntimeError
    (sandbox refusal is hard-fail — adapter MUST run sandboxed).
    """
    adapter_p = Path(adapter_path).resolve()
    workspace_p = Path(workspace_root).resolve()

    if isinstance(stdin_payload, str):
        stdin_bytes: bytes | None = stdin_payload.encode("utf-8")
    elif isinstance(stdin_payload, (bytes, bytearray)):
        stdin_bytes = bytes(stdin_payload)
    else:
        stdin_bytes = None

    if _bwrap_available():
        argv = [
            "bwrap",
            "--ro-bind", "/usr", "/usr",
            "--ro-bind", "/etc/alternatives", "/etc/alternatives",
            "--ro-bind", "/lib", "/lib",
            "--ro-bind", "/lib64", "/lib64",
            "--ro-bind", "/bin", "/bin",
            "--proc", "/proc",
            "--dev", "/dev",
            "--tmpfs", "/tmp",
            "--ro-bind", str(workspace_p), str(workspace_p),
            "--chdir", str(workspace_p),
            "--unshare-net",
            "--unshare-user",
            "--unshare-pid",
            "--",
            python, str(adapter_p),
        ]
    elif _firejail_available():
        argv = [
            "firejail",
            "--quiet",
            "--private-tmp",
            "--net=none",
            f"--whitelist={workspace_p}",
            "--noroot",
            python, str(adapter_p),
        ]
    else:
        raise RuntimeError(
            "no sandbox tool available (need bwrap or firejail); "
            "refusing to execute adapter unsandboxed"
        )

    try:
        proc = subprocess.run(
            argv,
            input=stdin_bytes,
            capture_output=True,
            timeout=timeout_seconds,
        )
        return SandboxedResult(
            exit_code=proc.returncode,
            stdout=proc.stdout.decode("utf-8", errors="replace"),
            stderr=proc.stderr.decode("utf-8", errors="replace"),
            timed_out=False,
        )
    except subprocess.TimeoutExpired as exc:
        return SandboxedResult(
            exit_code=124,
            stdout=(exc.stdout or b"").decode("utf-8", errors="replace"),
            stderr=(exc.stderr or b"").decode("utf-8", errors="replace"),
            timed_out=True,
        )


def verify_adapter_signature(adapter_path: str | Path, sigstore_bundle: str | Path) -> bool:
    """Verify a Sigstore signature bundle against an adapter source
    file. Returns True on valid signature, False on absence/mismatch.

    Plan ARIA-V9.0-E ships the contract; the actual cosign /
    sigstore-python call site is wired by skill_genesis_drainer when
    V10.2 lands. For V9.0-E code-only scope, this function performs
    sha256 comparison against a manifest-recorded hash — the
    Tier-3 detect mechanism specified in plan v3 Phase V9.0-E
    (no third-party Python dep introduced in this commit).
    """
    import hashlib
    adapter_p = Path(adapter_path)
    bundle_p = Path(sigstore_bundle)
    if not adapter_p.exists() or not bundle_p.exists():
        return False
    try:
        manifest = json.loads(bundle_p.read_text())
    except json.JSONDecodeError:
        return False
    expected = manifest.get("source_sha256") if isinstance(manifest, dict) else None
    if not isinstance(expected, str):
        return False
    actual = hashlib.sha256(adapter_p.read_bytes()).hexdigest()
    return expected == actual


__all__ = (
    "ALLOWED_ADAPTER_IMPORTS",
    "FORBIDDEN_ADAPTER_IMPORTS",
    "UnsafeAdapterImport",
    "AdapterSignatureMismatch",
    "SandboxedResult",
    "verify_adapter_imports",
    "execute_in_sandbox",
    "verify_adapter_signature",
)
