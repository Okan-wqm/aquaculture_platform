"""ARIA-CRITICAL-399 — an adapter that tries to reach what an adapter must not.

Run by ``tests/test_adapter_room.py`` through the real runners
(``tool_runner.run_tool``, ``fixture_runner.run_fixture_suite``). It reports
every reach as a fact in its one observation and exits 3 when ANY secret was
reachable, so a fixture case that expects an ``ok`` run passes only inside a
room that held. ``--touch`` writes a marker first: a run that should never
have started is caught by the marker existing afterwards.

Reaches attempted: the job credential names in its own environment, the App
key file at the path the nightly lane writes it to (``--pem``), any
``/proc/<pid>/environ`` carrying ``GH_TOKEN=`` (the kernel's own process
included), the durable store directory (``--store``), a write into the
workspace, an off-host connection, and every ``--secret`` file (a gitignored
``.env``, key or deploy secret in the checkout, ARIA-MEDIUM-432).
``--visible`` files are only reported: what a scanner must still read. Both
take the path hex-encoded: the argv policy refuses a command that spells
``.env`` (``dotenv_access``), before any room exists.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import socket
import sys

FORBIDDEN_ENV_NAMES = (
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "GITHUB_ENV",
    "RUNNER_TEMP",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_VALUE_0",
    "ARIA_TOOLS_DIR",
)


def _attempt(action) -> str:
    try:
        action()
    except OSError as exc:
        return f"refused:{type(exc).__name__}"
    return "reached"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pem", required=True)
    parser.add_argument("--store", required=True)
    parser.add_argument("--touch")
    parser.add_argument("--secret", action="append", default=[])
    parser.add_argument("--visible", action="append", default=[])
    args = parser.parse_args(argv)
    if args.touch:
        with open(args.touch, "w", encoding="utf-8") as marker:
            marker.write("ran\n")

    def read_pem() -> None:
        with open(args.pem, encoding="utf-8") as handle:
            handle.read()

    leaking = []
    for path in glob.glob("/proc/[0-9]*/environ"):
        try:
            with open(path, "rb") as handle:
                if b"GH_TOKEN=" in handle.read():
                    leaking.append(path)
        except OSError:
            continue
    try:
        store_entries = sorted(os.listdir(args.store))
    except OSError:
        store_entries = []

    def write_workspace() -> None:
        with open(os.path.join(os.environ.get("ARIA_REPO_ROOT", "."), "adapter-wrote-here"), "w") as handle:
            handle.write("x")

    def connect_off_host() -> None:
        # TEST-NET-3 (RFC 5737): never routable, so "reached" is impossible
        # anywhere and the attempt only distinguishes "no route" from a wait.
        socket.create_connection(("203.0.113.1", 443), timeout=1).close()

    def reader(path: str):
        def read() -> None:
            with open(path, "rb") as handle:
                if not handle.read():
                    raise FileNotFoundError(path)  # an empty cover is not the file
        return read

    facts = {
        "secrets": {bytes.fromhex(raw).decode(): _attempt(reader(bytes.fromhex(raw).decode())) for raw in args.secret},
        "visible": {bytes.fromhex(raw).decode(): _attempt(reader(bytes.fromhex(raw).decode())) for raw in args.visible},
        "forbidden_env": sorted(name for name in FORBIDDEN_ENV_NAMES if name in os.environ),
        "env_names": sorted(os.environ),
        "pem": _attempt(read_pem),
        "proc_environ_leaks": leaking,
        "visible_pids": len(glob.glob("/proc/[0-9]*")),
        "store_entries": store_entries,
        "workspace_write": _attempt(write_workspace),
        "network": _attempt(connect_off_host),
        "repo_root": os.environ.get("ARIA_REPO_ROOT"),
        "node_options": os.environ.get("NODE_OPTIONS"),
        "cwd": os.getcwd(),
    }
    print(json.dumps({
        "observations": [{"id": "room-probe", "type": "fixture", "details": facts}],
        "findings": [],
        "read_paths": [],
        "evidence_sources": [],
        "cost_units": 1,
    }))
    reached = (
        facts["forbidden_env"] or facts["pem"] == "reached" or facts["proc_environ_leaks"]
        or facts["store_entries"] or facts["workspace_write"] == "reached"
        or "reached" in facts["secrets"].values()
    )
    return 3 if reached else 0


if __name__ == "__main__":
    sys.exit(main())
