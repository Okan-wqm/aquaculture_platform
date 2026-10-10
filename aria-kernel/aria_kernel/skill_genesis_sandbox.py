"""Plan ARIA-V9.0-E — the drafted adapter's import allowlist.

Closes:
  * ai-safety-auditor MED-015 — 3-cycle threshold supply-chain risk:
    skill_genesis can author new tool adapters from N consecutive
    CONVERGED cycles with identical pattern_signature; without
    containment, the adapter runs unconstrained with full repo access.
  * security-reviewer CRIT-006 — tool adapter execution sandbox:
    same surface, security-side framing.

ARIA-HIGH-414 — where the allowlist is ENFORCED. This module owns the
allowlist (``ALLOWED_ADAPTER_IMPORTS``) and its static pre-check
(``verify_adapter_imports``). The pre-check is NOT the boundary: Python
reaches a module by spellings no AST walk can enumerate (``import
os.path`` binds ``os``; ``pathlib.os``; a generator's
``gi_frame.f_builtins['__import__']``; ``functools.singledispatch``
evaluating a string annotation). The allowlist holds at runtime: every
drafted adapter runs only through the kernel launcher
(``tools/aria-poc/genesis_adapter_launcher.py``, started by
``genesis_adapter_custody``) inside the adapter room. The launcher loads this
allowlist, then refuses every further module load and every process,
thread, tracing and write-open event before the adapter's first byte
compiles. The pre-check refuses the obvious spellings by name, early, so a
drafter's critique says what was wrong.

The room (``adapter_room``) is the OS boundary: no network, read-only
workspace, no secrets, private PID namespace. ``execute_in_sandbox`` (a
drafted adapter run by file path) and ``verify_adapter_signature`` (a
sha256 the writer had just written itself) were removed: drafted bytes run
only from kernel custody, re-hashed by the kernel at each step.
"""
from __future__ import annotations

import ast


# Plan ARIA-V9.0-E — Python stdlib imports permitted inside skill
# adapters. Closed allowlist; an adapter importing anything outside
# this set fails the pre-check before calibration, and cannot load it
# at runtime (the launcher loads exactly this set, then no more).
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
    # sys — stdin/stdout/argv; its import and process levers
    # (sys.modules, settrace, addaudithook) are refused by the launcher.
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


# ARIA-HIGH-414 — names that reach a module or run a string as code. The
# launcher refuses whatever they would load at runtime; naming them here
# refuses the obvious drafts before a room is built. Not `compile`: `from re
# import compile` binds that name to a regex constructor.
DYNAMIC_IMPORT_PRIMITIVES: frozenset[str] = frozenset({
    "__import__", "exec", "eval", "__builtins__", "breakpoint",
})


def verify_adapter_imports(source: str) -> None:
    """Parse ``source`` as Python AST; refuse any ``import X`` /
    ``from X import ...`` outside ALLOWED_ADAPTER_IMPORTS (or inside
    FORBIDDEN_ADAPTER_IMPORTS), any name a plain ``import a.b`` BINDS outside
    the allowlist (``import os.path`` binds ``os``), any call of a
    DYNAMIC_IMPORT_PRIMITIVES name, and ``sys.modules``.

    The pre-check of the launcher's runtime allowlist (module docstring):
    it refuses the obvious drafts by name before a room is built, and it is
    not the boundary. Run by ``genesis_adapter_custody.stage_accepted_draft``
    on every drafted adapter before calibration.

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
    dynamic_hits: list[str] = []

    for node in ast.walk(tree):
        names: list[str] = []
        if isinstance(node, ast.Import):
            names = [alias.name for alias in node.names]
            # `import a.b` without `as` binds `a`, the whole package: the
            # allowed `import os.path` handed the adapter `os.system`.
            names += [alias.name.split(".")[0] for alias in node.names if alias.asname is None and "." in alias.name]
        elif isinstance(node, ast.ImportFrom):
            # `from foo.bar import baz` → import root foo.bar
            if node.module:
                names = [node.module]
        elif isinstance(node, ast.Name) and node.id in DYNAMIC_IMPORT_PRIMITIVES:
            dynamic_hits.append(node.id)
        elif (
            isinstance(node, ast.Attribute) and node.attr == "modules"
            and isinstance(node.value, ast.Name) and node.value.id == "sys"
        ):
            dynamic_hits.append("sys.modules")
        for name in names:
            # Resolution order (Tier-1 precedence):
            #   1. Exact name in ALLOWED → permit (lets caller import a
            #      narrow safe subpath like ``os.path`` AS a name, e.g.
            #      ``import os.path as osp``, even though root ``os`` is
            #      FORBIDDEN).
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

    if forbidden_hits or not_in_allowlist or dynamic_hits:
        raise UnsafeAdapterImport(
            f"adapter imports rejected — "
            f"forbidden={sorted(set(forbidden_hits))} "
            f"not-in-allowlist={sorted(set(not_in_allowlist))} "
            f"dynamic={sorted(set(dynamic_hits))}"
        )


__all__ = (
    "ALLOWED_ADAPTER_IMPORTS",
    "DYNAMIC_IMPORT_PRIMITIVES",
    "FORBIDDEN_ADAPTER_IMPORTS",
    "UnsafeAdapterImport",
    "verify_adapter_imports",
)
