"""Production-shaped constructors for kernel test inputs.

WHY THIS EXISTS (RC-3 of the ARIA closeout plan). Four defects in one session
survived a fully green suite for one reason: the fixture constructed an input
production never produces.

    ORPHAN-CRITICAL-494  fixture: full clone          production: depth-1 shallow
    ORPHAN-CRITICAL-495  fixture: request + target_sha  production: 11 of 17 mint
                                                        paths omit it
    ORPHAN-CRITICAL-495  fixture: request + cycle_id    production: 15 of 17 omit it
    ORPHAN-CRITICAL-497  fixture: timeout=600         production: 1800

Every one of those tests passed WITH the bug present. The lens that caught
them executed the code; the lenses that missed them read it.

So the rule this module enforces by construction: a value that production
derives must be derived here too, by CALLING the production accessor — never
by copying its current number into a literal. A test then cannot drift from
production without the accessor changing under it.

HONEST LABELLING, because overclaiming is how the above survived:

* ``production_*`` functions derive their value from the real production path
  and carry no literal of their own.
* :func:`cycle_workspace` is a plain single-sourced fixture, NOT a derived
  value. It exists so the workspace shape lives in one place instead of being
  re-typed per test file; it does not claim to be what production sees.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from aria_kernel.agent_invocations import create_agent_invocation_request
from aria_kernel.tool_registry import ensure_tools_dir
from aria_kernel.workflow_contract_registry import cycle_wall_clock_cap_seconds

from .git_fixtures import make_local_git_repo

_ARIA_POC = Path(__file__).resolve().parents[2].parent / "tools" / "aria-poc"

# Production REFUSES a request without these two fields
# (`create_agent_invocation_request_strict_fields_required`), and the refusal is
# deliberate: a request with no acceptance criteria and no scope bound is a
# blank cheque. Discovered by writing this module — the first draft omitted them
# and production rejected it, which is the whole argument for minting through
# the real path instead of hand-building a dict that would have silently
# omitted them forever.
_DEFAULT_MUST_SATISFY: list[dict[str, Any]] = [
    {"id": "MS-1", "description": "the fixture request states one falsifiable obligation"},
]
_DEFAULT_ALLOWED_SCOPE: list[str] = ["aria-kernel/aria_kernel/"]


@dataclass(frozen=True)
class CycleFixture:
    """The two paths every ``run_enterprise_cycle`` call needs."""

    workspace_root: Path
    tools_dir: Path


def cycle_workspace(tmp: Path, *, git: bool = False) -> CycleFixture:
    """A workspace + tools dir shaped like the one a cycle discovers.

    Single-sourced, not production-derived — see the module docstring. The
    contents are the minimum ``run_discovery`` needs to produce a non-empty
    FATES set: one source file, a package manifest and an nx manifest.

    ``git=True`` initialises a real repository through
    :func:`git_fixtures.make_local_git_repo`, which also disables auto-gc so
    teardown cannot race a detached ``git gc`` (ORPHAN-LOW-301). Reused rather
    than re-implemented, because a second git-init helper is exactly the
    duplication this module exists to remove.
    """
    if git:
        workspace = make_local_git_repo(tmp, name="workspace")
    else:
        workspace = tmp / "workspace"
        workspace.mkdir(parents=True, exist_ok=True)

    (workspace / "src").mkdir(parents=True, exist_ok=True)
    (workspace / "src" / "app.ts").write_text("export const app = true;\n", encoding="utf-8")
    (workspace / "package.json").write_text('{"name":"fixture"}\n', encoding="utf-8")
    (workspace / "nx.json").write_text('{"affected":{}}\n', encoding="utf-8")

    return CycleFixture(
        workspace_root=workspace,
        tools_dir=ensure_tools_dir(tmp / "aria-tools"),
    )


def production_request_without_anchor(
    *,
    target_agent: str = "aria-evidence-judge",
    role: str = "evidence_judgment",
    suggested_prompt: str = "fixture request",
    base_dir: str | Path | None = None,
    **extra: Any,
) -> dict[str, Any]:
    """Mint a request the way the ELEVEN paths that omit ``target_sha`` do.

    This is the majority production shape and therefore the default: of the 17
    mint paths, 11 pass no ``target_sha`` and 15 pass no ``cycle_id``. A test
    that hand-builds a dict carrying either field is testing an input that
    most of production never emits, which is what ORPHAN-CRITICAL-495 was.

    Minted through :func:`create_agent_invocation_request` so the row's shape
    is whatever production currently produces, not a snapshot of it.
    """
    extra.setdefault("must_satisfy", _DEFAULT_MUST_SATISFY)
    extra.setdefault("allowed_scope", _DEFAULT_ALLOWED_SCOPE)
    return create_agent_invocation_request(
        target_agent=target_agent,
        role=role,
        suggested_prompt=suggested_prompt,
        base_dir=base_dir,
        **extra,
    )


def production_request_with_anchor(
    *,
    target_sha: str,
    cycle_id: str | None = None,
    target_agent: str = "aria-evidence-judge",
    role: str = "evidence_judgment",
    suggested_prompt: str = "fixture request",
    base_dir: str | Path | None = None,
    **extra: Any,
) -> dict[str, Any]:
    """Mint a request the way the SIX anchored paths do.

    Named explicitly rather than reached by passing a kwarg to the default,
    so a reader can tell which of the two production shapes a test asserts on.
    """
    extra.setdefault("must_satisfy", _DEFAULT_MUST_SATISFY)
    extra.setdefault("allowed_scope", _DEFAULT_ALLOWED_SCOPE)
    return create_agent_invocation_request(
        target_agent=target_agent,
        role=role,
        suggested_prompt=suggested_prompt,
        base_dir=base_dir,
        target_sha=target_sha,
        cycle_id=cycle_id,
        **extra,
    )


def production_max_timeout_seconds() -> int:
    """The per-run timeout the executor actually emits.

    Derived by calling ``ci_executor._max_timeout_seconds()``. ORPHAN-CRITICAL-497
    was a test asserting against ``timeout=600`` while production emitted 1800,
    which made the wall-clock exhaustion case unreachable in the test and
    universal in production. A literal here would reintroduce exactly that gap.
    """
    if str(_ARIA_POC) not in sys.path:
        sys.path.insert(0, str(_ARIA_POC))
    import ci_executor  # noqa: PLC0415 — path-injected module, not import-time safe

    return ci_executor._max_timeout_seconds()


def production_wall_clock_cap_seconds(workflow_id: str, *, job_id: str | None = None) -> int | None:
    """The per-cycle wall-clock cap, derived from the pinned workflow contract.

    Returns ``None`` when the contract declares no cap for that workflow/job —
    propagated rather than defaulted, because "no cap declared" and "cap of
    zero" are different states and collapsing them is how a gate starts
    refusing every dispatch.
    """
    return cycle_wall_clock_cap_seconds(workflow_id, job_id=job_id)
