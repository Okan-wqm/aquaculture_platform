"""System One at ARIA's decision points (ARIA-LOW-319): where the kernel asks, and why nothing changes.

SHADOW — answered, recorded on the System One call ledger, read by nothing:
the PR opener asks J0 for every finding a branch commit claims to close
(``Closes:``) once per changed file — J0 was validated on per-file diffs, a
finding's verdict being the maximum over its files — and R5 for the PR's
title and body against its diff; the merge authority asks J0 for every
``Closes:`` trailer of the PR's commits; the judge fan-out asks each question
registered for ``judge_fanout`` (J1, one per rule family) about every finding
it mints judges for. No caller reads a return value, every entry point
swallows its own failure, and each stops asking once SHADOW_BUDGET_SECONDS of
wall clock is spent (a slow Jev answers within the 5 s transport ceiling, so
without a budget a 40-file diff could hold the 15-minute merge lane): a reflex
never changes what the protocol does, nor how long it takes beyond the budget.

ORDER — R4 ranks deterministic candidate files (tracked files that name the
problem's identifiers) for planner and implementer envelopes ONLY when the
operator's registry declares R4 ``order`` and its own model answered. Under
the seed (``enabled: false``, R4 ``shadow``) nothing is asked and every
envelope prompt, and so every bound prompt hash, is byte-identical.
"""
from __future__ import annotations

import json
import re
import subprocess
import time
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

from .system_one import Answer, Registry, ask, load_registry
from .tool_registry import bound_workspace_root

REGISTRY_FINDINGS = "docs/reviews/_registry/findings.jsonl"
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


def finding_claims(registry_text: str, finding_ids: Iterable[str]) -> dict[str, dict[str, str]]:
    """``{id: {finding: title, rule: rule_violated}}`` from registry rows — the text J0 was validated on."""
    wanted: set[str] = set(finding_ids)
    claims: dict[str, dict[str, str]] = {}
    for line in registry_text.splitlines() if wanted else ():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict) and row.get("id") in wanted:
            claims[str(row["id"])] = {"finding": str(row.get("title") or ""), "rule": str(row.get("rule_violated") or "")}
    return claims


def _ask_j0(claims: Mapping[str, Mapping[str, str]], diff_text: str, *, point: str,
            base_dir: str | Path | None, subject: str, budget: _Budget) -> None:
    diffs = file_diffs(diff_text)
    for finding_id, claim in claims.items():
        for path, diff in diffs.items():
            if not budget.left():
                return
            ask("J0", {"finding": dict(claim), "diff": diff}, decision_point=point, base_dir=base_dir,
                subject=f"{subject}:{finding_id}:{path}")


def _messages(commits: Iterable[Mapping[str, Any]] | None) -> list[str]:
    return [f"{commit.get('subject') or ''}\n\n{commit.get('body') or ''}" for commit in commits or ()]


def shadow_pr_open(
    *, base_dir: str | Path | None, workspace_root: str | Path, diff_text: str | None,
    commits: Sequence[Mapping[str, Any]] | None, title: str, body: str, subject: str,
) -> None:
    """J0 per claimed finding × file, R5 for the PR text — recorded, never read."""
    try:
        budget = _Budget()
        if _enabled(base_dir) is None or not diff_text:
            return
        # R5 first: one call, so a J0 fan-out that spends the budget never starves it.
        ask("R5", {"message": f"{title}\n\n{body}", "diff": diff_text[:FILE_DIFF_MAX_CHARS]},
            decision_point="pre_pr_open", base_dir=base_dir, subject=subject)
        ids = closes_ids(_messages(commits))
        registry_path = Path(workspace_root) / REGISTRY_FINDINGS
        claims = finding_claims(registry_path.read_text(encoding="utf-8"), ids) if ids and registry_path.is_file() else {}
        _ask_j0(claims, diff_text, point="pre_pr_open", base_dir=base_dir, subject=subject, budget=budget)
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
        claims = finding_claims(_git(workspace_root, "show", f"{head}:{REGISTRY_FINDINGS}"), ids) if ids else {}
        _ask_j0(claims, diff_text, point="merge_authority", base_dir=base_dir, subject=f"pr:{pr.get('number')}",
                budget=budget)
    except Exception:  # noqa: BLE001 — a shadow reflex never breaks the merge authority
        return


def _excerpt(item: Mapping[str, Any], repo_root: str | Path) -> str:
    from .evidence_excerpts import excerpts_for_refs

    refs = [str(item.get("path") or ""), *[str(ref) for ref in item.get("evidence") or ()]]
    refs = sorted({ref for ref in refs if ref}, key=lambda ref: (not re.search(r":\d+", ref), ref))
    for entry in excerpts_for_refs(refs, repo_root=repo_root, line_radius=6, per_ref_cap=4000, total_cap=8000):
        if entry.get("content"):
            start = int(entry.get("start_line") or 1)
            return "\n".join(f"{start + index:5d} {line}" for index, line in enumerate(str(entry["content"]).splitlines()))
    return ""


def shadow_judge_fanout(
    *, base_dir: str | Path | None, repo_root: str | Path | None, items: Sequence[Mapping[str, Any]],
) -> None:
    """Each question registered for ``judge_fanout`` and the item's tool, per minted finding — recorded."""
    try:
        budget = _Budget()
        registry = _enabled(base_dir)
        if registry is None or repo_root is None:
            return
        questions = [q for q in registry.questions.values() if "judge_fanout" in q.decision_points]
        for item in items:
            for question in (q for q in questions if str(item.get("tool_id") or "") in q.tool_ids):
                if not budget.left():
                    return
                excerpt = _excerpt(item, repo_root)
                if excerpt:
                    rule = f"{item.get('rule') or ''}: {item.get('message') or ''}"
                    ask(question.id, {"rule": rule, "file": str(item.get("path") or "").split(":")[0], "excerpt": excerpt},
                        decision_point="judge_fanout", base_dir=base_dir,
                        subject=f"finding:{item.get('finding_fingerprint') or item.get('finding_id')}")
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
    base_dir: str | Path | None, subject: str, rev: str = "HEAD",
) -> list[dict[str, Any]]:
    """R4's top-k candidate files for the plan's title and summary; ``[]`` unless R4 runs in order mode.

    ``plan`` is read (and the workspace resolved — the store's bound one when
    None) only after the flag says R4 runs, inside the guard: with R4 off the
    envelope builders do no extra work at all.
    """
    try:
        budget = _Budget()
        registry = _enabled(base_dir)
        question = registry.questions.get("R4") if registry is not None else None
        if question is None or question.mode != "order" or "envelope_candidate_files" not in question.decision_points:
            return []
        content = plan() or {}
        problem = f"{content.get('title') or ''}\n{content.get('summary') or ''}"
        root = workspace_root if workspace_root is not None else bound_workspace_root(base_dir)
        ranked: list[dict[str, Any]] = []
        for path in _candidates(problem, root, rev):
            if not budget.left():
                break
            source = _git(root, "show", f"{rev}:{path}").splitlines()
            picked = [f"{index + 1:5d} {line.strip()[:140]}" for index, line in enumerate(source) if _OUTLINE.match(line)][:60]
            answer = ask("R4", {"problem": problem, "file": path, "outline": "\n".join(picked)},
                         decision_point="envelope_candidate_files", base_dir=base_dir, subject=f"{subject}:{path}")
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
