"""The vendor's status ANSWER, classified before its exit code.

WHY. Both managed CLIs report a logged-out session as an answer AND a
non-zero exit: Claude Code 2.1.269 prints `{"loggedIn": false, ...}` and then
`process.exit(loggedIn ? 0 : 1)` (read from the installed binary, reproduced
offline with an empty config dir); Codex 0.154.0 prints `Not logged in` and
exits 1 (`codex-rs/cli/src/login.rs`, reproduced offline with an empty
CODEX_HOME). A probe that tests the exit code first launders that DECIDED
"no" into UNDECIDED `status_not_confirmed` — retried three times with
backoff, then a `provider_undecided` halt with no failover — which is the
exact inverse of ARIA-HIGH-107's defect: an auth-unavailable fact, the one
class the operator decision (2026-09-12) lets a read-only role fail over on,
turned into a stall. The lane's own fixture exited 0 on a logged-out
document, so the executor tests passed a shape the real CLI never produces
(verifier, 2026-09-12).

WHAT. Two pure classifiers, one per CLI, with the same contract: the
document or line the vendor wrote is the answer, and the exit code rides the
row as evidence (`exit_code`) — it is consulted ONLY when no answer was
read, to tell a non-zero exit (`status_not_confirmed`) from an unreadable
zero exit (`status_output_unrecognized`), both UNDECIDED. The probes in
`claude_runtime` and `codex_runtime` own the spawn (environment boundary,
pipes, byte cap, reaping) and hand the bytes here; nothing in this module
runs a process. Raw output never leaves the classifier: the returned
observation carries only the closed reason vocabulary.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

_POC_DIR = Path(__file__).resolve().parent
_KERNEL_DIR = _POC_DIR.parents[1] / "aria-kernel"
if str(_KERNEL_DIR) not in sys.path:
    sys.path.insert(0, str(_KERNEL_DIR))

from aria_kernel.status_probe import StatusDecision, _RuntimeStatusObservation  # noqa: E402

# `claude auth status --json`: authMethod "claude.ai" is the managed
# subscription; an API-key or console login is the billing bypass ARIA
# refuses. Defined here because the classifier is the only reader.
MANAGED_AUTH_METHOD_CLAUDE_AI = "claude.ai"

# `codex login status` lines, as the CLI prints them (stderr, merged by the
# probe). The supported CLI can prefix one PATH-alias write warning while
# successfully reading the read-only credential store; that exact complete
# diagnostic is tolerated and nothing else, so no convenient substring can
# be selected out of conflicting output.
CODEX_LOGGED_IN_CHATGPT = "Logged in using ChatGPT"
CODEX_LOGGED_IN_API_KEY_PREFIX = "Logged in using an API key - "
CODEX_NOT_LOGGED_IN = "Not logged in"
CODEX_READONLY_ALIAS_WARNING = (
    "WARNING: proceeding, even though we could not create PATH aliases: Read-only file system (os error 30)"
)


def _no_answer(returncode: int, command: tuple[str, ...]) -> _RuntimeStatusObservation:
    """No status answer was read: the vendor was not heard. The exit code is
    the only fact and names the undecided reason; nothing is decided."""
    reason = "status_not_confirmed" if returncode != 0 else "status_output_unrecognized"
    return _RuntimeStatusObservation("unknown", reason=reason, command=command, exit_code=returncode,
                                     decision=StatusDecision.UNDECIDED)


def classify_claude_status_answer(
    stdout: str, returncode: int, *, command: tuple[str, ...],
) -> _RuntimeStatusObservation:
    """`claude auth status --json`: the document decides; the exit code is evidence.

    A JSON object with a boolean `loggedIn` is the vendor's answer whatever
    the exit code: logged out → `managed_session_logged_out` (DECIDED
    unavailable — the real CLI exits 1 here); logged in on claude.ai →
    available with auth_method `subscription`; logged in another way →
    `api_key_auth_not_managed` (DECIDED unavailable: the binding table
    admits only the subscription). Anything else is no answer.
    """
    try:
        payload = json.loads(stdout.strip() or "null")
    except ValueError:
        payload = None
    if not isinstance(payload, dict) or not isinstance(payload.get("loggedIn"), bool):
        return _no_answer(returncode, command)
    if not payload["loggedIn"]:
        return _RuntimeStatusObservation("unavailable", reason="managed_session_logged_out", command=command,
                                         exit_code=returncode, credential_source="managed_session",
                                         decision=StatusDecision.UNAVAILABLE)
    method = str(payload.get("authMethod") or "")
    if method != MANAGED_AUTH_METHOD_CLAUDE_AI:
        return _RuntimeStatusObservation("unavailable", reason="api_key_auth_not_managed", command=command,
                                         exit_code=returncode, auth_method="api_key",
                                         credential_source="managed_session", decision=StatusDecision.UNAVAILABLE)
    return _RuntimeStatusObservation(
        "available", quota_observation="unknown", reason="managed_session_logged_in", command=command,
        exit_code=returncode, auth_method="subscription", credential_source="managed_session",
        decision=StatusDecision.AVAILABLE,
    )


def classify_codex_status_answer(
    output: bytes, returncode: int, *, command: tuple[str, ...],
) -> _RuntimeStatusObservation:
    """`codex login status`: the line decides; the exit code is evidence.

    `Logged in using ChatGPT` → available (auth_method `chatgpt`);
    `Logged in using an API key - …` → `managed_login_required` (DECIDED
    unavailable: only the managed login is admitted); `Not logged in` →
    `cli_reported_not_logged_in` (DECIDED unavailable — the real CLI exits
    1 here). Each tolerates the one read-only PATH-alias warning line ahead
    of it (`…_with_readonly_path_alias_warning`). Anything else is no answer.
    """
    try:
        status = output.decode("utf-8").strip()
    except UnicodeDecodeError:
        status = ""
    lines = status.splitlines()
    readonly_alias_warning = len(lines) == 2 and lines[0] == CODEX_READONLY_ALIAS_WARNING
    if readonly_alias_warning:
        status = lines[1]
    elif len(lines) != 1:
        status = ""
    suffix = "_with_readonly_path_alias_warning" if readonly_alias_warning else ""
    if status == CODEX_LOGGED_IN_CHATGPT:
        return _RuntimeStatusObservation(
            "available", reason="cli_reported_managed_login" + suffix, command=command,
            exit_code=returncode, auth_method="chatgpt", decision=StatusDecision.AVAILABLE,
        )
    if status.startswith(CODEX_LOGGED_IN_API_KEY_PREFIX):
        return _RuntimeStatusObservation(
            "unavailable", reason="managed_login_required" + suffix, command=command,
            exit_code=returncode, auth_method="api_key", decision=StatusDecision.UNAVAILABLE,
        )
    if status == CODEX_NOT_LOGGED_IN:
        return _RuntimeStatusObservation(
            "unavailable", reason="cli_reported_not_logged_in" + suffix, command=command,
            exit_code=returncode, decision=StatusDecision.UNAVAILABLE,
        )
    return _no_answer(returncode, command)


__all__ = [
    "CODEX_LOGGED_IN_API_KEY_PREFIX",
    "CODEX_LOGGED_IN_CHATGPT",
    "CODEX_NOT_LOGGED_IN",
    "CODEX_READONLY_ALIAS_WARNING",
    "MANAGED_AUTH_METHOD_CLAUDE_AI",
    "classify_claude_status_answer",
    "classify_codex_status_answer",
]
