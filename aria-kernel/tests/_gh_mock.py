"""Mock gh API factory for Plan 017 Phase 3 PR pipeline tests.

`pr_manager.open_pr_for_action` calls `subprocess.run(["gh", "pr",
"create", ...])` directly. Real gh integration is operator-driven;
unit tests mock the subprocess invocation through unittest.mock.patch
so the entire PR lifecycle is exercisable without network access or
live gh credentials.

Usage:

    from unittest.mock import patch
    from aria_kernel.tests._gh_mock import gh_create_success, gh_create_failure

    with patch("aria_kernel.pr_manager.subprocess.run", side_effect=gh_create_success):
        result = pr_manager.open_pr_for_action(...)

The factories assert that the gh argv contains `--base main` and
the title/body kwargs are passed through; they fail loudly on any
attempt to invoke gh with a different base.
"""
from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from typing import Any
from unittest.mock import MagicMock

# Plan 022 §C-4 — capture the unpatched subprocess.run before any test
# patches aria_kernel.pr_manager.subprocess.run. open_pr_for_action now
# calls `git rev-parse <branch>` to resolve the real head_sha; the mock
# defers those calls to the real subprocess so existing tests keep working.
_real_subprocess_run = subprocess.run


@dataclass
class _RecordedCall:
    argv: list[str]
    cwd: str | None = None
    capture_output: bool = False
    text: bool = False


_recorded_calls: list[_RecordedCall] = []


def reset_recorded() -> None:
    """Clear the in-memory call log between tests."""
    _recorded_calls.clear()


def recorded_calls() -> list[_RecordedCall]:
    return list(_recorded_calls)


def _record(args: tuple[Any, ...], kwargs: dict[str, Any]) -> _RecordedCall:
    argv = list(args[0]) if args else list(kwargs.get("args", []))
    call = _RecordedCall(
        argv=argv,
        cwd=str(kwargs.get("cwd", "")) or None,
        capture_output=bool(kwargs.get("capture_output", False)),
        text=bool(kwargs.get("text", False)),
    )
    _recorded_calls.append(call)
    return call


def _assert_pr_create_invariants(call: _RecordedCall) -> None:
    """Every gh pr create invocation MUST go to base=main and carry title + body."""
    if call.argv[:3] != ["gh", "pr", "create"]:
        raise AssertionError(f"unexpected gh argv: {call.argv!r}")
    if "--base" not in call.argv:
        raise AssertionError("gh pr create missing --base flag")
    base_idx = call.argv.index("--base")
    if call.argv[base_idx + 1] != "main":
        raise AssertionError(
            f"gh pr create --base must be 'main', got {call.argv[base_idx + 1]!r}"
        )
    if "--title" not in call.argv:
        raise AssertionError("gh pr create missing --title")
    if "--body" not in call.argv:
        raise AssertionError("gh pr create missing --body")


def gh_create_success(*args, **kwargs):
    """Returns CompletedProcess(returncode=0, stdout=<fake-pr-url>) for gh pr create.

    Asserts the invocation matches Plan 016 contract (--base main + title +
    body). Records the call so tests can inspect it.
    """
    call = _record(args, kwargs)
    if call.argv[:3] == ["gh", "pr", "create"]:
        _assert_pr_create_invariants(call)
        result = MagicMock()
        result.returncode = 0
        result.stdout = "https://github.com/test/repo/pull/123\n"
        result.stderr = ""
        return result
    # Plan 022 §C-4 — pr_manager.open_pr_for_action calls `git rev-parse
    # <branch>` to resolve head_sha; ORPHAN-CRITICAL-428 added `git diff
    # <base>..<head>` to feed the perimeter's secret scan. Defer ALL git to
    # the real subprocess rather than enumerating verbs: this mock exists to
    # intercept `gh`, and every added git call was previously a new
    # AssertionError in a test that had nothing to do with git. Matching on
    # argv[0] makes the next one work without touching this file.
    if call.argv[:1] == ["git"]:
        return _real_subprocess_run(*args, **kwargs)
    raise AssertionError(f"gh_create_success only handles gh pr create; got: {call.argv!r}")


def gh_create_failure(*args, **kwargs):
    """Returns CompletedProcess(returncode=1, stderr=<error>) for gh pr create."""
    call = _record(args, kwargs)
    if call.argv[:3] == ["gh", "pr", "create"]:
        result = MagicMock()
        result.returncode = 1
        result.stdout = ""
        result.stderr = "gh: insufficient permissions to create pull request\n"
        return result
    # See gh_create_success: all git defers to the real subprocess.
    if call.argv[:1] == ["git"]:
        return _real_subprocess_run(*args, **kwargs)
    raise AssertionError(f"gh_create_failure only handles gh pr create; got: {call.argv!r}")
