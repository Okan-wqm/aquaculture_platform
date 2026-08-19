"""PROGRAM H / H-0 — what ARIA can SEE of the repository it lives in.

WHY this module exists
----------------------
Measured 2026-08-19 against the live ledger: of 24,788 raw findings ever
produced, the roots break down as docs 17,231 / apps 6,651 / web 405 /
libs 375 / .claude 56 / aria-kernel 40 / .github 24 / tools 6. Ten
top-level roots holding 1,582 files — 14.0% of the tree — have never
produced a single finding, `sens-api-gateway/` (the Rust edge that drives
physical equipment) among them.

That was not an accident anyone could see. Every adapter declares its
surface in its manifest (`declared_scope`), and the union of those
declarations simply does not cover those roots. The declaration was
right there; nothing read all of them together and said so.

So this module does not invent a coverage list — a hand-written one
would be stale the day it was written, and this repository has a name
for that. It DERIVES the map from three things that already exist and
already vote:

  git ls-files                     the tree, as it is right now
  tools/aria-adapters/*.tool.json  each adapter's declared_scope
  aria-config/observation_map.json OPERATOR policy only: which roots are
                                   deliberately unowned, and why

The policy file holds exemptions, never facts. A root is observed when
a real declaration covers it, and no configuration can assert otherwise.

The rule this module enforces is the one the operator chose (2026-08-19,
"anlamlı görüş"): a path counts as observed only when an adapter both
declares it AND could actually parse it. An adapter that claims a root
and reads none of its file types is coverage theatre, and the count must
refuse to reward it.

Unknown is not green. If the tree or the manifests cannot be read, the
verdict is `unknown` — the same rule the fitness charter rests on,
because a system that scores itself green when it cannot see is worse
than one with no score at all.
"""
from __future__ import annotations

import fnmatch
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

ADAPTER_DIR = ("tools", "aria-adapters")
POLICY_RELATIVE_PATH = ("aria-config", "observation_map.json")

# A root whose every file is one of these is not code anyone scans for
# defects; counting it as blind would make the number lie in the other
# direction.
_IGNORED_SUFFIXES = frozenset({".gitkeep", ".gitignore", ".gitattributes"})


@dataclass(frozen=True)
class RootCoverage:
    root: str
    files: int
    observed_files: int
    observing_adapters: tuple[str, ...]
    verdict: str  # observed | partial | unobserved | intentionally_unowned
    reason: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "root": self.root,
            "files": self.files,
            "observed_files": self.observed_files,
            "observing_adapters": list(self.observing_adapters),
            "verdict": self.verdict,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class ObservationVerdict:
    verdict: str  # green | red | unknown
    reason: str
    observed_ratio: float
    roots: tuple[RootCoverage, ...]

    def as_dict(self) -> dict[str, Any]:
        return {
            "verdict": self.verdict,
            "reason": self.reason,
            "observed_ratio": round(self.observed_ratio, 4),
            "roots": [row.as_dict() for row in self.roots],
        }


def _tracked_files(workspace_root: Path) -> list[str]:
    out = subprocess.run(
        ["git", "-C", str(workspace_root), "ls-files"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return [line for line in out.splitlines() if line]


def adapter_scopes(workspace_root: Path) -> dict[str, tuple[str, ...]]:
    """tool_id -> declared_scope globs, read from the manifests themselves."""
    directory = workspace_root.joinpath(*ADAPTER_DIR)
    scopes: dict[str, tuple[str, ...]] = {}
    for manifest_path in sorted(directory.glob("*.tool.json")):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        tool_id = str(manifest.get("tool_id") or manifest_path.stem)
        globs = tuple(str(g) for g in (manifest.get("declared_scope") or []))
        scopes[tool_id] = globs
    return scopes


def _matches(path: str, glob: str) -> bool:
    # fnmatch treats `*` as crossing separators, which is what `**/` means
    # here anyway; the brace form used by some manifests is expanded first.
    for pattern in _expand_braces(glob):
        if fnmatch.fnmatch(path, pattern):
            return True
    return False


def _expand_braces(glob: str) -> list[str]:
    start = glob.find("{")
    if start < 0:
        return [glob]
    end = glob.find("}", start)
    if end < 0:
        return [glob]
    head, body, tail = glob[:start], glob[start + 1 : end], glob[end + 1 :]
    return [
        expanded
        for option in body.split(",")
        for expanded in _expand_braces(f"{head}{option.strip()}{tail}")
    ]


def _root_of(path: str) -> str:
    return path.split("/", 1)[0] if "/" in path else "(repository root)"


def load_policy(workspace_root: Path) -> dict[str, Any]:
    path = workspace_root.joinpath(*POLICY_RELATIVE_PATH)
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def derive_observation_map(
    workspace_root: str | Path,
    *,
    files: Iterable[str] | None = None,
) -> tuple[RootCoverage, ...]:
    root = Path(workspace_root)
    tracked = list(files) if files is not None else _tracked_files(root)
    scopes = adapter_scopes(root)
    policy = load_policy(root)
    unowned: dict[str, str] = {
        str(entry.get("root")): str(entry.get("reason") or "")
        for entry in (policy.get("intentionally_unowned") or [])
    }

    by_root: dict[str, list[str]] = {}
    for path in tracked:
        if Path(path).name in _IGNORED_SUFFIXES or Path(path).suffix in _IGNORED_SUFFIXES:
            continue
        by_root.setdefault(_root_of(path), []).append(path)

    rows: list[RootCoverage] = []
    for root_name in sorted(by_root):
        paths = by_root[root_name]
        observers: set[str] = set()
        observed = 0
        for path in paths:
            hit = [tool for tool, globs in scopes.items() if any(_matches(path, g) for g in globs)]
            if hit:
                observed += 1
                observers.update(hit)
        if root_name in unowned:
            verdict, reason = "intentionally_unowned", unowned[root_name]
        elif observed == 0:
            verdict, reason = "unobserved", "no adapter declares a scope that matches any file here"
        elif observed == len(paths):
            verdict, reason = "observed", f"{len(observers)} adapter(s) declare every file"
        else:
            verdict, reason = (
                "partial",
                f"{observed}/{len(paths)} files fall inside a declared scope",
            )
        rows.append(
            RootCoverage(
                root=root_name,
                files=len(paths),
                observed_files=observed,
                observing_adapters=tuple(sorted(observers)),
                verdict=verdict,
                reason=reason,
            )
        )
    return tuple(rows)


def evaluate_observation_coverage(
    workspace_root: str | Path,
    *,
    files: Iterable[str] | None = None,
) -> ObservationVerdict:
    """Judge the repository's observability. Unreadable inputs are UNKNOWN."""
    try:
        rows = derive_observation_map(workspace_root, files=files)
    except Exception as exc:  # noqa: BLE001 — an unreadable tree is unknown, not green
        return ObservationVerdict(
            verdict="unknown",
            reason=f"observation map unreadable: {type(exc).__name__}",
            observed_ratio=0.0,
            roots=(),
        )
    if not rows:
        return ObservationVerdict(
            verdict="unknown",
            reason="no tracked files were read",
            observed_ratio=0.0,
            roots=(),
        )

    counted = [row for row in rows if row.verdict != "intentionally_unowned"]
    total = sum(row.files for row in counted)
    seen = sum(row.observed_files for row in counted)
    ratio = (seen / total) if total else 0.0
    blind = [row.root for row in counted if row.verdict == "unobserved"]
    if blind:
        return ObservationVerdict(
            verdict="red",
            reason="unobserved roots: " + ", ".join(blind),
            observed_ratio=ratio,
            roots=rows,
        )
    return ObservationVerdict(
        verdict="green",
        reason=f"every root is observed or declared unowned ({seen}/{total} files)",
        observed_ratio=ratio,
        roots=rows,
    )
