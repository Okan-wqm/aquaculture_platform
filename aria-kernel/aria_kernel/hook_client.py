"""ARIA-HIGH-123 — the Claude Code hook command that runs INSIDE the sandbox.

WHY this module exists
----------------------
The hook commands compiled into a spawn's settings (``claude_settings``)
used to run the whole kernel hook inside the agent's sandbox: ``python3 -m
aria_kernel hook pre-tool --tools-dir <store> …`` decided AND journaled
there, which meant the durable state store had to be reachable — and
writable — from inside the sandbox. Bound writable, the store handed the
agent every kernel surface: the request queue, claims, governance, the
signer registry, operator control, adjudications, the cost ledgers and the
very turn count the same hook gates it by. Unbound, the hooks journaled into
a phantom on bwrap's root tmpfs and every row was lost.

WHAT this module does
---------------------
It is the thinnest possible client: it ships the hook verb and the CLI's
payload (stdin) to the kernel-side broker (``hook_broker``) over the unix
socket named by ``ARIA_HOOK_BROKER_SOCKET`` — bound into the sandbox by the
wrapper at a fixed path — and prints the verdict the broker returns. It
imports nothing but the standard library and is run BY PATH
(``<python> <kernel_root>/aria_kernel/hook_client.py <verb>``), so the
kernel package is never imported inside the sandbox for a hook, and nothing
in this file can reach a ledger: the decision, the turn count, the journal,
the checkpoint and the handoff all happen outside, with the kernel's
authority, against the real store.

Fail-closed: a broker that cannot be reached (no socket in the environment,
a connect or protocol failure, a timeout) is a DENY for ``pre-tool`` (exit
2, the CLI's block code, with the reason in the protocol JSON) and an
"unrecorded" note for the verbs that cannot block. The client's own timeout
is below the hook timeout the settings compile (``claude_settings
.HOOK_TIMEOUT_SECONDS``), so the CLI sees an explicit refusal rather than a
killed hook.
"""
from __future__ import annotations

import json
import os
import socket
import sys

HOOK_BROKER_SOCKET_ENV = "ARIA_HOOK_BROKER_SOCKET"
HOOK_VERBS: tuple[str, ...] = ("pre-tool", "post-tool", "session")
# The CLI's hook protocol: exit 2 blocks a PreToolUse.
EXIT_ALLOW = 0
EXIT_BLOCK = 2
# Below claude_settings.HOOK_TIMEOUT_SECONDS (60): the client refuses by
# name before the CLI gives up on it.
CLIENT_TIMEOUT_SECONDS = 50.0
_MAX_REPLY_BYTES = 1 << 20


def _deny_stdout(reason: str) -> str:
    # The same shape hooks.HookVerdict.to_stdout prints (pinned by the
    # broker tests): this module cannot import it.
    return json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    })


def _unreachable(verb: str, reason: str) -> tuple[int, str]:
    if verb == "pre-tool":
        return EXIT_BLOCK, _deny_stdout(reason)
    if verb == "post-tool":
        return EXIT_ALLOW, json.dumps({"aria_journal": f"unrecorded:{reason}"})
    return EXIT_ALLOW, json.dumps({"aria_session": {"status": f"unrecorded:{reason}"}})


def call_hook(
    socket_path: str, verb: str, payload: dict, *, timeout: float = CLIENT_TIMEOUT_SECONDS,
) -> tuple[int, str]:
    """Ship one hook to the broker; ``(exit_code, stdout)`` as the broker
    decided. Raises ``OSError`` / ``ValueError`` when the broker cannot be
    reached or does not answer in the protocol's shape."""
    request = json.dumps({"verb": verb, "payload": payload}).encode("utf-8") + b"\n"
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        client.settimeout(timeout)
        client.connect(socket_path)
        client.sendall(request)
        client.shutdown(socket.SHUT_WR)
        chunks: list[bytes] = []
        received = 0
        while True:
            chunk = client.recv(65536)
            if not chunk:
                break
            received += len(chunk)
            if received > _MAX_REPLY_BYTES:
                raise ValueError("hook_broker_reply_too_large")
            chunks.append(chunk)
    finally:
        client.close()
    reply = json.loads(b"".join(chunks).decode("utf-8"))
    if not isinstance(reply, dict) or not isinstance(reply.get("exit_code"), int) or not isinstance(reply.get("stdout"), str):
        raise ValueError("hook_broker_reply_malformed")
    return int(reply["exit_code"]), str(reply["stdout"])


def main(argv: list[str], *, stdin=None, stdout=None, environ=None) -> int:
    inp = sys.stdin if stdin is None else stdin
    out = sys.stdout if stdout is None else stdout
    env = os.environ if environ is None else environ
    verb = argv[0] if argv else ""
    if verb not in HOOK_VERBS:
        out.write(json.dumps({"error": f"unknown hook verb {verb!r}"}) + "\n")
        return EXIT_BLOCK
    try:
        payload = json.loads(inp.read() or "{}")
    except ValueError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    socket_path = env.get(HOOK_BROKER_SOCKET_ENV) or ""
    if not socket_path:
        exit_code, text = _unreachable(verb, "hook_broker_unreachable:no_socket_in_environment")
    else:
        try:
            exit_code, text = call_hook(socket_path, verb, payload)
        except (OSError, ValueError) as exc:
            exit_code, text = _unreachable(verb, f"hook_broker_unreachable:{type(exc).__name__}")
    if text:
        out.write(text + "\n")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
