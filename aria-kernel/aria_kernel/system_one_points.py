"""System One at ARIA's decision points (ARIA-LOW-319): where the kernel asks, and why nothing changes.

SHADOW — answered, recorded on the System One call ledger, read by nothing:
the PR opener asks J0 for every finding a branch commit claims to close
(``Closes:``) once per changed file — J0 was validated on per-file diffs, a
finding's verdict being the maximum over its files — and R5 for the head
commit's message against each changed file's diff (R5 first, so a J0 fan-out
that spends the budget never starves a file's R5); the merge authority asks
J0 for every ``Closes:`` trailer of the PR's commits; the judge fan-out asks
each question registered for ``judge_fanout`` (J1, one per rule family) about
every finding it mints judges for. No caller reads a return value, every entry
point swallows its own failure, and each stops asking once SHADOW_BUDGET_SECONDS of
wall clock is spent (a slow Jev answers within the 5 s transport ceiling, so
without a budget a 40-file diff could hold the 15-minute merge lane): a reflex
never changes what the protocol does, nor how long it takes beyond the budget.

A decision point hands ``system_one.ask`` REFERENCES (``StateRef``), never
text: the finding id a ``Closes:`` trailer names or a fan-out item carries,
the PR/checkout head commit with the changed path (J0's diff, R5's message and
diff, J1's excerpt at the cited line), the resolved revision for R4's symbol
outline. ``system_one`` builds every state value from those references itself
— the finding title and rule as the public remote's registry holds them, the
diffs and excerpts from commits a public branch holds — and what a point
computes locally (the plan's title and summary that pick R4's candidates)
never leaves the host.

ORDER — R4 ranks deterministic candidate files (tracked files that name the
problem's identifiers) for planner and implementer envelopes ONLY when the
operator's registry declares R4 ``order``, its own model answered, and the
plan names the finding it addresses (``plan_content.finding_id`` — the one
reference R4's ``problem`` state can carry; a plan with no finding origin
names nothing R4 may send, so it ranks nothing). Under the seed (``enabled:
false``, R4 ``shadow``) nothing is asked and every envelope prompt, and so
every bound prompt hash, is byte-identical.
"""
from __future__ import annotations

import re
import subprocess
import time
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

from .system_one import Answer, Registry, StateRef, ask, load_registry
from .tool_registry import bound_workspace_root

FILE_DIFF_MAX_CHARS = 12_000  # J0 was validated on per-file diffs cut at 12k characters
MAX_FILES = 40
MAX_CANDIDATES = 12
GIT_TIMEOUT_SECONDS = 20
# Wall clock one entry point may spend asking; the call in flight at the deadline still
# finishes (<= 2 attempts x 5 s), so a point costs at most ~25 s whatever Jev does.
SHADOW_BUDGET_SECONDS = 15.0
_clock: Callable[[], float] = time.monotonic
_SKIP_PATH = re.compile(r"^(docs/|\.claude/)|\.md$|findings\.jsonl$|\.generated\.|/generated/|package-lock\.json$")
_CLOSES = re.compile(r"^Closes:\s*\S+?#([A-Z][A-Z0-9]*-[A-Z]+-\d+)\s*$", re.MULTILINE)
_COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
# The id shapes the ledger's subject law and the finding builder accept.
_FINDING_ID = re.compile(r"^[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-[0-9]{1,6}$")
_CITED_LINE = re.compile(r"^(.+?):(\d+)$")
_OUTLINE = re.compile(
    r"^\s*(export |@|class |interface |type |enum |async |function |public |private |protected |def "
    r"|const \w+ = (async )?\()"
)
_IDENTIFIER = re.compile(r"`([^`\s]{4,80})`|\b([A-Za-z_][A-Za-z0-9]*(?:_[A-Za-z0-9]+|[a-z][A-Z][A-Za-z0-9]*)+)\b")


class _Budget:
    def __init__(self) -> None:
        self._until = _clock() + SHADOW_BUDGET_SECONDS

    def left(self) -> bool:
        return _clock() < self._until


def _enabled(base_dir: str | Path | None) -> Registry | None:
    registry = load_registry(bound_workspace_root(base_dir))
    return registry if registry is not None and registry.enabled else None


def _git(root: str | Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", *args], cwd=root, capture_output=True, text=True, timeout=GIT_TIMEOUT_SECONDS, check=False,
    )
    return completed.stdout if completed.returncode == 0 else ""


def file_diffs(diff_text: str) -> dict[str, str]:
    """One diff per changed code file (docs, generated files and lockfiles skipped), each cut at 12k."""
    files: dict[str, str] = {}
    for chunk in re.split(r"(?m)^(?=diff --git )", diff_text or ""):
        match = re.match(r"diff --git a/\S+ b/(\S+)", chunk)
        if match and not _SKIP_PATH.search(match.group(1)) and len(files) < MAX_FILES:
            files[match.group(1)] = chunk[:FILE_DIFF_MAX_CHARS]
    return files


def closes_ids(messages: Iterable[str]) -> list[str]:
    return sorted({match.group(1) for text in messages for match in _CLOSES.finditer(text or "")})


def _messages(commits: Iterable[Mapping[str, Any]] | None) -> list[str]:
    return [f"{commit.get('subject') or ''}\n\n{commit.get('body') or ''}" for commit in commits or ()]


def shadow_pr_open(
    *, base_dir: str | Path | None, workspace_root: str | Path, diff_text: str | None,
    head_sha: str | None, commits: Sequence[Mapping[str, Any]] | None,
) -> None:
    """R5 for the head commit's message against each changed file's diff, then J0 per claimed
    finding × file — recorded, never read."""
    try:
        budget = _Budget()
        head = head_sha if isinstance(head_sha, str) and _COMMIT_RE.match(head_sha) else ""
        if _enabled(base_dir) is None or not diff_text or not head:
            return
        ids = closes_ids(_messages(commits))
        for path in file_diffs(diff_text):
            if not budget.left():
                return
            # R5 before this file's J0 fan-out, so a fan-out that spends the budget never starves it.
            ask("R5", {"message": StateRef(commit=head), "diff": StateRef(commit=head, path=path)},
                decision_point="pre_pr_open", base_dir=base_dir, subject=head)
            for finding_id in ids:
                if not budget.left():
                    return
                ask("J0", {"finding": StateRef(finding_id=finding_id), "diff": StateRef(commit=head, path=path)},
                    decision_point="pre_pr_open", base_dir=base_dir, subject=finding_id)
    except Exception:  # noqa: BLE001 — a shadow reflex never breaks the PR opener
        return


def shadow_merge(
    *, base_dir: str | Path | None, workspace_root: str | Path | None, pr: Mapping[str, Any], diff_text: str | None,
) -> None:
    """J0 per ``Closes:`` trailer of the PR's commits × changed file — recorded, never read."""
    try:
        budget = _Budget()
        head = str(pr.get("head_sha") or pr.get("headRefOid") or "")
        base = str(pr.get("base_sha") or pr.get("baseRefOid") or "")
        if _enabled(base_dir) is None or workspace_root is None or not (head and base and diff_text):
            return
        log = _git(workspace_root, "log", "--format=%B%x00", f"{base}..{head}")
        ids = closes_ids(log.split("\x00"))
        for path in file_diffs(diff_text):
            for finding_id in ids:
                if not budget.left():
                    return
                ask("J0", {"finding": StateRef(finding_id=finding_id), "diff": StateRef(commit=head, path=path)},
                    decision_point="merge_authority", base_dir=base_dir, subject=finding_id)
    except Exception:  # noqa: BLE001 — a shadow reflex never breaks the merge authority
        return


def _cited_line(item: Mapping[str, Any]) -> tuple[str, int] | None:
    """The item's first cited reference as ``(path, line)`` — refs naming a line first."""
    refs = sorted({str(ref) for ref in (item.get("path") or "", *(item.get("evidence") or ())) if str(ref)},
                  key=lambda ref: (not _CITED_LINE.match(ref), ref))
    if not refs:
        return None
    match = _CITED_LINE.match(refs[0])
    return (match.group(1), int(match.group(2))) if match else (refs[0], 1)


def shadow_judge_fanout(
    *, base_dir: str | Path | None, repo_root: str | Path | None, items: Sequence[Mapping[str, Any]],
) -> None:
    """Each question registered for ``judge_fanout`` and the item's tool, per minted finding — recorded."""
    try:
        budget = _Budget()
        registry = _enabled(base_dir)
        if registry is None or repo_root is None:
            return
        head = _git(repo_root, "rev-parse", "HEAD").strip()
        if not _COMMIT_RE.match(head):
            return
        questions = [q for q in registry.questions.values() if "judge_fanout" in q.decision_points]
        for item in items:
            for question in (q for q in questions if str(item.get("tool_id") or "") in q.tool_ids):
                if not budget.left():
                    return
                cited = _cited_line(item)
                if cited is None:
                    continue
                path, line = cited
                finding_id = str(item.get("finding_id") or "")
                ask(question.id, {"rule": StateRef(finding_id=finding_id), "file": StateRef(path=path),
                                 "excerpt": StateRef(commit=head, path=path, line=line)},
                    decision_point="judge_fanout", base_dir=base_dir,
                    subject=finding_id if _FINDING_ID.match(finding_id) else None)
    except Exception:  # noqa: BLE001 — a shadow reflex never breaks the fan-out
        return


def _candidates(problem: str, root: str | Path, rev: str) -> list[str]:
    """Tracked code files naming the problem's identifiers, most matching lines first."""
    words = sorted({backticked or name for backticked, name in _IDENTIFIER.findall(problem)})[:8]
    if not words:
        return []
    pattern_args = [arg for word in words for arg in ("-e", word)]
    output = _git(root, "grep", "-c", "-I", "-F", *pattern_args, rev, "--", ".",
                  ":(exclude)docs/*", ":(exclude)*.md", ":(exclude)*test*", ":(exclude)*spec*")
    counts: dict[str, int] = {}
    for line in output.splitlines():
        path, _, count = line.removeprefix(f"{rev}:").rpartition(":")
        if path and count.isdigit() and not _SKIP_PATH.search(path):
            counts[path] = int(count)
    return [path for path, _ in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:MAX_CANDIDATES]]


def rank_candidate_files(
    *, plan: Callable[[], Mapping[str, Any] | None], workspace_root: str | Path | None,
    base_dir: str | Path | None, rev: str = "HEAD",
) -> list[dict[str, Any]]:
    """R4's top-k candidate files for the finding the plan addresses; ``[]`` unless R4 runs in order mode.

    R4 runs only when the registry declares it ``order`` AND the plan names the
    finding it addresses (``plan_content.finding_id``): ``problem`` is a
    reference — a registered finding — and a plan with no finding origin names
    nothing R4 may send. The plan is read (and the workspace resolved — the
    store's bound one when None) only after both hold, inside the guard: with
    R4 off the envelope builders do no extra work at all. The title and
    summary that pick the candidates locally never leave the host.
    """
    try:
        budget = _Budget()
        registry = _enabled(base_dir)
        question = registry.questions.get("R4") if registry is not None else None
        if question is None or question.mode != "order" or "envelope_candidate_files" not in question.decision_points:
            return []
        content = plan() or {}
        finding_id = content.get("finding_id")
        if not isinstance(finding_id, str) or not _FINDING_ID.match(finding_id):
            return []
        problem = f"{content.get('title') or ''}\n{content.get('summary') or ''}"
        root = workspace_root if workspace_root is not None else bound_workspace_root(base_dir)
        sha = _git(root, "rev-parse", str(rev)).strip()
        if not _COMMIT_RE.match(sha):
            return []
        ranked: list[dict[str, Any]] = []
        for path in _candidates(problem, root, rev):
            if not budget.left():
                break
            answer = ask("R4", {"problem": StateRef(finding_id=finding_id), "file": StateRef(path=path),
                                "outline": StateRef(commit=sha, path=path)},
                         decision_point="envelope_candidate_files", base_dir=base_dir, subject=finding_id)
            if isinstance(answer, Answer) and answer.mode == "order":
                ranked.append({"path": path, "score": round(float(answer.value), 3)})
        top_k = max(0, min(int(question.thresholds.get("top_k", 3)), MAX_CANDIDATES))
        return sorted(ranked, key=lambda row: (-row["score"], row["path"]))[:top_k]
    except Exception:  # noqa: BLE001 — no ranking is an envelope without the section, never a failed mint
        return []


def render_candidate_files(ranked: Sequence[Mapping[str, Any]]) -> str:
    """The implementer prompt's section; empty for an empty ranking, so the prompt is unchanged."""
    if not ranked:
        return ""
    lines = [f"  - {row['path']} (relevance {row['score']})" for row in ranked]
    return ("\nCandidate files (System One R4, ranked; read these first — a reading order, never scope):\n"
            + "\n".join(lines) + "\n")
