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

WHO READS THE VERDICT (H-3). `capability_gap._gaps_from_unobserved_surface`
turns a root that measures blind on `unobserved_nights_before_gap`
consecutive nights into an `unobserved_surface` capability gap, and the
learning router sends that gap to adapter authoring — because a root
nothing can parse needs a READER, and a review agent is not one. The
per-root `unparsed_file_types` is what makes the gap an assignment rather
than a complaint: it names the parser that has to exist.
"""
from __future__ import annotations

import fnmatch
import json
import subprocess
from collections import Counter
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
    # WHAT: the file types present in this root that NO adapter in the whole
    # toolbox can parse. WHY it is a separate number from `observed_files`:
    # "23 files unseen" is a complaint, while ".rs, .toml — nothing here can
    # read them" names the adapter somebody has to write. A root can be
    # unobserved with an empty tuple here — every one of its types IS parsed
    # somewhere, just not declared for this root, and that is a scope edit
    # rather than a new parser.
    unparsed_file_types: tuple[str, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {
            "root": self.root,
            "files": self.files,
            "observed_files": self.observed_files,
            "observing_adapters": list(self.observing_adapters),
            "verdict": self.verdict,
            "reason": self.reason,
            "unparsed_file_types": list(self.unparsed_file_types),
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
    """Does this path fall inside this declared scope?

    ORPHAN-HIGH-762 — this used to be a private `fnmatch` call with a comment
    asserting that `*` crossing separators is "what `**/` means here anyway".
    It is not. `**/` must also match ZERO directories, and `fnmatch` expands
    `**` to `.*` with the literal `/` still required — so
    `aria-kernel/aria_kernel/**/*.py` did not match
    `aria-kernel/aria_kernel/cycle.py`, and the instrument built to measure
    ARIA's blindness was blind in exactly the directory it was built to
    measure. The repository already had the correct matcher; this module
    shipped a second one.

    Brace expansion stays here because `matches_glob` does not do it and the
    manifests use the brace form; each expanded alternative is then answered
    by the ONE matcher.
    """
    from .tool_health import matches_glob

    return any(matches_glob(path, pattern) for pattern in _expand_braces(glob))


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


def file_type_of(path: str) -> str:
    """The token an adapter needs a parser for.

    The extension when there is one, otherwise the filename itself:
    ``Dockerfile`` and ``Makefile`` are file types a parser is written
    against exactly as ``.rs`` is, and reporting them as "" would hide the
    very roots most likely to be blind.
    """
    return Path(path).suffix.lower() or Path(path).name


def load_policy(workspace_root: Path) -> dict[str, Any]:
    path = workspace_root.joinpath(*POLICY_RELATIVE_PATH)
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


# How many consecutive nights a root must measure blind before the blindness
# is filed as a capability gap. ONE night is a snapshot, not a property: an
# adapter manifest can be mid-edit, a new root can land at 23:00, a scope typo
# can be fixed before breakfast. Three consecutive nights is a standing fact
# about the repository — the same count, for the same reason, that the
# oscillation guard uses to tell a loop from a revision.
DEFAULT_UNOBSERVED_NIGHTS_BEFORE_GAP: int = 3

# The floor exists so the policy file cannot turn this back into the snapshot
# the threshold was introduced to refuse. Policy may ask for MORE evidence;
# it may not ask for less than two nights.
MIN_UNOBSERVED_NIGHTS_BEFORE_GAP: int = 2


def unobserved_nights_before_gap(workspace_root: str | Path) -> int:
    """Operator-tunable blindness threshold, floored at two nights.

    Read from ``aria-config/observation_map.json`` — still policy, never
    fact: it says how much evidence the operator wants before ARIA files a
    gap against itself, and says nothing about what is observed.
    """
    try:
        policy = load_policy(Path(workspace_root))
        raw = policy.get("unobserved_nights_before_gap")
        value = DEFAULT_UNOBSERVED_NIGHTS_BEFORE_GAP if raw is None else int(raw)
    except (OSError, TypeError, ValueError):
        # An unreadable policy file is not permission to lower the bar; it
        # falls back to the declared default and stays there.
        return DEFAULT_UNOBSERVED_NIGHTS_BEFORE_GAP
    return max(MIN_UNOBSERVED_NIGHTS_BEFORE_GAP, value)


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

    # Match every tracked path ONCE, and remember which file types some
    # adapter somewhere already parses. The question "can anything in the
    # toolbox read a .rs file?" is about the toolbox, not about the root that
    # happens to hold the file, so it can only be answered tree-wide.
    hits_by_path: dict[str, list[str]] = {}
    parsable_types: set[str] = set()
    for paths in by_root.values():
        for path in paths:
            hit = [tool for tool, globs in scopes.items() if any(_matches(path, g) for g in globs)]
            if hit:
                hits_by_path[path] = hit
                parsable_types.add(file_type_of(path))

    rows: list[RootCoverage] = []
    for root_name in sorted(by_root):
        paths = by_root[root_name]
        observers: set[str] = set()
        observed = 0
        for path in paths:
            hit = hits_by_path.get(path)
            if hit:
                observed += 1
                observers.update(hit)
        # Ordered by how much of the root each type accounts for, not
        # alphabetically. Measured on this repository, alphabetical order put
        # `.aquamobil` (from `Dockerfile.aquamobil`) ahead of `.rs`, and with
        # a capped payload the reader would have been handed the noise and
        # not the 449 Rust files that are the actual assignment.
        unparsed = Counter(
            kind for path in paths if (kind := file_type_of(path)) not in parsable_types
        )
        ordered_types = tuple(
            kind for kind, _ in sorted(unparsed.items(), key=lambda kv: (-kv[1], kv[0]))
        )
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
                unparsed_file_types=ordered_types,
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
