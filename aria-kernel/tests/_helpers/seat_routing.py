"""SE-5 fixtures — a per-service agent in a workspace and the service chain repository.

Shared by ``test_se5_lifecycle_replay.py``, ``test_se5_role_agent_owner.py`` and
``test_se5_seat_routing.py``. NON-test code (the directory name keeps it out of
``unittest discover``); no model is called anywhere in it.

* LIFECYCLE STORE. ``lifecycle_chain.chain`` (the replayable chain of an entity, appended the way
  ``record_transition`` writes it) and ``lifecycle_chain.forged_row`` (one hand-appended line) are the
  fixtures of the ledger; this module adds the agent file the grant reads and the change repository.
* WORKSPACE AGENT. ``write_seat_agent`` writes ``<workspace>/.claude/agents/<name>.md``
  with the three keys SE-5 reads from a per-service agent: ``service``,
  ``replaces_role`` (frontmatter) and, on the ledger side, ``evidence.scope``.
* SERVICE CHAIN REPOSITORY. ``seat_repo`` is the import-edge chain of
  ``test_change_review_envelope_d2._service_repo`` made one project longer:
  ``libs/zz-core`` (layer 0) <- ``libs/mm-mid`` <- ``apps/aa-edge`` <- ``apps/bb-top``,
  plus ``web/modules/zz-web`` and ``docs/``. The alphabetical order of the project
  names (aa, bb, mm, zz) differs from the closure order (zz, mm, aa, bb) on purpose.
"""
from __future__ import annotations

import json
import subprocess
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from aria_kernel.tool_registry import GovernanceError

CORE = "libs/zz-core/src/i.ts"
MID = "libs/mm-mid/src/m.ts"
EDGE = "apps/aa-edge/src/e.ts"
TOP = "apps/bb-top/src/b.ts"
WEB = "web/modules/zz-web/src/w.ts"
DOCS = "docs/guide.md"
# The project names the layout gives them (no project.json name), alphabetical order of the services differs from this.
CLOSURE_ORDER = ("zz-core", "mm-mid", "aa-edge", "bb-top")
CLOSURE_ROOTS = ("libs/zz-core", "libs/mm-mid", "apps/aa-edge", "apps/bb-top")

GENERIC = "aria-change-intelligence"
ROLE = "change_intelligence"
SEAT_AGENT_X = "aria-svc-x-reviewer"
SEAT_AGENT_CORE = "aria-svc-zz-core-reviewer"


def write_seat_agent(
    workspace: Path, name: str, *, service: str | None, replaces_role: str | None = ROLE,
    frontmatter_name: str | None = None,
) -> Path:
    """``<workspace>/.claude/agents/<name>.md`` with the keys SE-5 reads (``service``, ``replaces_role``)."""
    lines = ["---", f"name: {frontmatter_name or name}", "description: reviews the changes of one service",
             "tools: Read, Grep, Glob"]
    if service is not None:
        lines.append(f"service: {service}")
    if replaces_role is not None:
        lines.append(f"replaces_role: {replaces_role}")
    path = workspace / ".claude" / "agents" / f"{name}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join([*lines, "---", "", "# A per-service reviewer", ""]), encoding="utf-8")
    return path


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()


def _touch(repo: Path, relative: str, marker: str) -> None:
    path = repo / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    path.write_text(existing + f"export const touched_{marker} = 1;\n", encoding="utf-8")


def seat_repo(
    repo: Path, *, touch: Sequence[str] = (), project_names: Mapping[str, str] | None = None,
) -> tuple[Path, str, str]:
    """The service chain repository at ``repo``; its head commit touches ``touch``. Returns ``(repo, base, head)``.

    ``project_names`` maps a project root to the ``name`` its ``project.json`` declares (nx's identity for the
    directory); a root without one is named by its layout (``libs/zz-core`` -> ``zz-core``).
    """
    files = {
        "libs/zz-core/package.json": "{}",
        CORE: "export const x = 1;\n",
        "libs/mm-mid/package.json": "{}",
        MID: "import { x } from '@platform/zz-core';\nexport const y = x;\n",
        "apps/aa-edge/package.json": "{}",
        EDGE: "import { y } from '@platform/mm-mid';\nexport const z = y;\n",
        "apps/bb-top/package.json": "{}",
        TOP: "import { z } from '@platform/aa-edge';\nexport const w = z;\n",
        "web/modules/zz-web/package.json": "{}",
        WEB: "export const v = 1;\n",
        DOCS: "# guide\n",
        "tsconfig.base.json": json.dumps({"compilerOptions": {"paths": {
            "@platform/zz-core": [CORE], "@platform/mm-mid": [MID], "@platform/aa-edge": [EDGE]}}}),
    }
    for root, name in (project_names or {}).items():
        files[f"{root}/project.json"] = json.dumps({"name": name})
    for relative, body in files.items():
        (repo / relative).parent.mkdir(parents=True, exist_ok=True)
        (repo / relative).write_text(body, encoding="utf-8")
    git(repo, "init", "-q", "--initial-branch=main")
    git(repo, "config", "user.email", "fixture@aria.test")
    git(repo, "config", "user.name", "Aria Fixture")
    git(repo, "config", "gc.auto", "0")
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "base: the service chain")
    base = git(repo, "rev-parse", "HEAD")
    return repo, base, add_commit(repo, touch)


def add_commit(repo: Path, touch: Sequence[str]) -> str:
    """One more commit on top of HEAD touching ``touch``; its id."""
    marker = git(repo, "rev-parse", "--short", "HEAD")
    for relative in touch:
        _touch(repo, relative, marker)
    # The store lives inside the workspace (its parent is the workspace the resolver reads agents from);
    # a commit takes only what the fixture names.
    if touch:
        git(repo, "add", "--", *touch)
    git(repo, "commit", "-q", "--allow-empty", "-m", f"head: touches {', '.join(touch) or 'nothing'}")
    return git(repo, "rev-parse", "HEAD")


def request_rows(store: Path, subject_ref: str | None = None) -> list[dict[str, Any]]:
    """The change-intelligence requests on the ledger, in ledger order; those of ``subject_ref`` when given."""
    from aria_kernel.agent_invocations import list_agent_invocation_requests

    rows = list_agent_invocation_requests(base_dir=store, role=ROLE)
    return rows if subject_ref is None else [row for row in rows if row.get("subject_ref") == subject_ref]


def seat_of(row: Mapping[str, Any]) -> Any:
    """The seat a request row carries in its ``change_context`` (None for a row without one)."""
    context = row.get("change_context")
    return context.get("seat") if isinstance(context, Mapping) else None


def governance_details(store: Path, kind: str) -> list[dict[str, Any]]:
    """The ``details`` of every governance row of ``kind``, in ledger order."""
    path = store / "governance.jsonl"
    if not path.exists():
        return []
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    return [row["details"] for row in rows if row.get("kind") == kind]


DEFAULT_SUBJECT = f"change:{'a' * 40}..{'b' * 40}"


def mint_request(
    store: Path, *, target: str = GENERIC, subject: str = DEFAULT_SUBJECT, change_context: Mapping[str, Any] | None = None,
    cycle_id: str = "cyc-se5",
) -> dict[str, Any]:
    """The claim path's mint for one change-intelligence request, under a door decision made FOR that change."""
    from aria_kernel.agent_invocations import create_agent_invocation_request
    from aria_kernel.request_admission import admit_request

    admission = admit_request("operator_cli.request", ROLE, base_dir=store, cycle_id=cycle_id, subject_ref=subject)
    return create_agent_invocation_request(
        target_agent=target, role=ROLE, suggested_prompt=f"Plan the revalidation impact of {subject} ({target})",
        must_satisfy=[{"id": "impact-map", "description": "details.impact_map"}], allowed_scope=["**"],
        evidence_refs=["libs/x/src/a.ts"], subject_ref=subject, cycle_id=cycle_id, target_sha="b" * 40, base_dir=store,
        admission=admission,
        **({"change_context": dict(change_context)} if change_context is not None else {}),
    )


def try_mint(store: Path, **kwargs: Any) -> tuple[dict[str, Any] | None, str | None]:
    """``mint_request`` as ``(row, None)`` or ``(None, refusal text)``: a refusal is an observation, not an error."""
    try:
        return mint_request(store, **kwargs), None
    except GovernanceError as refused:
        return None, str(refused)
