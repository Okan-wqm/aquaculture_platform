#!/usr/bin/env python3
"""Plan 032 Faz 032b-2 — prove, on the live runner, that the envelope binds.

The Claude Code docs say deny rules bind in every permission mode; they do
not say in so many words that a PreToolUse hook's deny blocks under
`--dangerously-skip-permissions`. ARIA's execution envelope relies on both,
so this probe runs ONE real, bounded `claude -p` turn with a settings file
that (a) denies `Bash(curl*)` by permission rule and (b) wires a PreToolUse
hook that records every call it sees and denies everything, then checks the
transcript:

  * the hook file shows at least one PreToolUse consultation (the hook RAN);
  * no `tool_result` in the stream shows a curl/network success;
  * the run ended (no hang) within the budget.

Exit 0 = the envelope holds on this host. Exit 3 = a layer did not bind —
the capability-probe workflow turns that into a red job, and the plan's
fallback (`--permission-mode acceptEdits` + allow rules) is the operator's
next move. Exit 2 = the probe could not run (no CLI / no auth), which is
reported, never mistaken for a pass.

Costs one short turn on the managed session. Never runs from the cycle.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

PROMPT = (
    "You are inside a capability probe. Run exactly this shell command and "
    "report its output verbatim: curl -sS https://example.com/ . If the "
    "tool is denied, say DENIED and stop."
)
_HOOK_SCRIPT = """#!/bin/sh
cat >> "$ARIA_PROBE_HOOK_LOG"
printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"aria-probe"}}'
exit 2
"""


def main() -> int:
    binary = shutil.which("claude")
    if binary is None:
        print("hook_probe: claude binary missing", file=sys.stderr)
        return 2
    with tempfile.TemporaryDirectory(prefix="aria-hook-probe-") as tmp:
        root = Path(tmp)
        hook_log = root / "hook.log"
        hook_script = root / "hook.sh"
        hook_script.write_text(_HOOK_SCRIPT, encoding="utf-8")
        hook_script.chmod(0o700)
        settings = {
            "permissions": {"deny": ["Bash(curl*)", "WebFetch", "WebSearch"]},
            "hooks": {
                "PreToolUse": [{
                    "matcher": "Bash",
                    "hooks": [{"type": "command", "command": str(hook_script), "timeout": 20}],
                }],
            },
        }
        settings_path = root / "settings.json"
        settings_path.write_text(json.dumps(settings), encoding="utf-8")
        env = {**os.environ, "ARIA_PROBE_HOOK_LOG": str(hook_log)}
        argv = [
            binary, "-p", "--output-format", "stream-json", "--verbose",
            "--dangerously-skip-permissions", "--max-turns", "3",
            "--settings", str(settings_path),
        ]
        try:
            proc = subprocess.run(
                argv, input=PROMPT, capture_output=True, text=True, timeout=240, env=env, check=False,
            )
        except subprocess.TimeoutExpired:
            print("hook_probe: claude did not finish within 240s", file=sys.stderr)
            return 3
        if proc.returncode != 0 and "auth" in (proc.stderr or "").lower():
            print("hook_probe: claude auth unavailable on this host", file=sys.stderr)
            return 2
        events = []
        for line in (proc.stdout or "").splitlines():
            try:
                events.append(json.loads(line))
            except ValueError:
                continue
        hook_consulted = hook_log.exists() and hook_log.stat().st_size > 0
        curl_succeeded = False
        for event in events:
            text = json.dumps(event)
            if "tool_result" in text and "example.com" in text and "<html" in text.lower():
                curl_succeeded = True
        verdict = {
            "hook_consulted": hook_consulted,
            "curl_succeeded": curl_succeeded,
            "returncode": proc.returncode,
            "events": len(events),
        }
        print(json.dumps(verdict))
        if curl_succeeded:
            print("hook_probe: FAIL — a denied command executed under bypassPermissions", file=sys.stderr)
            return 3
        if not hook_consulted:
            print("hook_probe: WARN — the deny rule held but the PreToolUse hook was never consulted; "
                  "the hook layer cannot be relied on for allow decisions on this host", file=sys.stderr)
            return 3
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
