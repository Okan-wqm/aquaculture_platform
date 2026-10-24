"""ORPHAN-HIGH-766 — a closure must prove its mechanism is REACHED.

The closure ceremony verifies a ``Closes:`` line names an existing finding.
It never verifies the mechanism the closing commit ADDED is reachable:
ORPHAN-694 was closed by PR #1247 ("the merge lock becomes satisfiable")
by adding ``produce_readiness_claim`` — which no production code called,
so the lock stayed unsatisfiable while the ledger said RESOLVED. This is
the findings-analog of the closed-vocabulary direction: the question asked
was "was an existing finding named", never "is the closing thing called".

The gate scans RESOLVED ledger entries for kernel producer symbols they
name (backticked identifiers that resolve to real kernel functions), asks
``literal_provenance.ProductionIndex`` whether production code calls each
one, and fails on any UNREACHABLE closure that is not pinned in the
baseline.

The ratchet (ORPHAN-750 cricket template): the FIRST run pins the existing
unreachable set — owner, date, reason — instead of drowning the repo in
historical red. The gate fires only on NEW unreachable closures; the
baseline never ratchets up and an entry leaves it (via ``--write``) only
when its symbol genuinely became reachable, each shrink visible in its own
commit. ORPHAN-694's producer sits OUTSIDE the baseline today: after the
readiness-claim lane landed, production code calls it, which is exactly
the shrink this gate exists to make audible.
"""
from __future__ import annotations

import json
import re
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .literal_provenance import ProductionIndex

# The ratchet's pinned-unreachable baseline, relative to the repo root. It
# waives the closure gate, so it is test collection in the derived authority
# set (`self_improvement.derived_authority_set`, PLAN-v2 B1).
CLOSURE_BASELINE_RELPATH: tuple[str, ...] = ("aria-kernel", "closure-reachability-baseline.json")
# What a pinned entry waives, named where the baseline's other readers name a
# waiver's kind (`self_improvement.invariants_only_grow` compares every store).
CLOSURE_PIN_KIND = "closure_reachability_pin"
_LEDGER_HEADING = re.compile(r"^## (ORPHAN-[A-Z]+-\d+) ", re.MULTILINE)
_BACKTICKED = re.compile(r"`([a-z][a-z0-9_]{3,})`")
_RESOLVED = "RESOLVED"

# The gate's question is "did the closure's PRODUCER get reached" — a
# producer is a write-side mechanism (it mints rows, dispatches work,
# records evidence). A scanner or predicate the closure also touched is
# not a producer claim, and gating it would flag honest gate-type fixes
# whose enforcement IS a test (the gate's first catch was exactly this:
# ORPHAN-MEDIUM-773 named its scanner in backticks, and the scanner's
# only caller is the test that enforces it).
_PRODUCER_PREFIXES = (
    "produce_",
    "record_",
    "commit_",
    "generate_",
    "mint_",
    "dispatch_",
    "register_",
    "append_",
    "write_",
    "create_",
    "ensure_",
    "run_",
)


def _is_producer_symbol(token: str) -> bool:
    return token.startswith(_PRODUCER_PREFIXES)


@dataclass(frozen=True)
class ClosureSymbol:
    finding_id: str
    symbol: str


def _baseline_pins(baseline_file: Path) -> dict[str, dict[str, Any]]:
    """The baseline's `pinned` map, `<finding>:<symbol>` → owner, date and
    reason; empty when the file is absent (nothing is pinned)."""
    if not baseline_file.exists():
        return {}
    return json.loads(baseline_file.read_text(encoding="utf-8")).get("pinned", {})


def _pin_symbol(key: str) -> ClosureSymbol:
    finding_id, symbol = key.split(":", 1)
    return ClosureSymbol(finding_id=finding_id, symbol=symbol)


def iter_closure_pins(repo_root: str | Path) -> Iterator[tuple[ClosureSymbol, dict[str, Any]]]:
    """Every pinned (finding, symbol) of the checkout at `repo_root`, with its
    entry, in key order. The pins WAIVE this gate, so they are compared beside
    the dated waiver manifests by the invariants that only grow."""
    for key, entry in sorted(_baseline_pins(Path(repo_root).joinpath(*CLOSURE_BASELINE_RELPATH)).items()):
        yield _pin_symbol(key), entry


@dataclass(frozen=True)
class ReachabilityReport:
    unreachable: tuple[ClosureSymbol, ...]
    pinned: tuple[ClosureSymbol, ...]
    shrunk: tuple[ClosureSymbol, ...]
    violations: tuple[ClosureSymbol, ...]

    def as_dict(self) -> dict[str, Any]:
        def _pairs(items: tuple[ClosureSymbol, ...]) -> list[dict[str, str]]:
            return [{"finding_id": item.finding_id, "symbol": item.symbol} for item in items]

        return {
            "schema_version": 1,
            "unreachable": _pairs(self.unreachable),
            "pinned": _pairs(self.pinned),
            "shrunk": _pairs(self.shrunk),
            "violations": _pairs(self.violations),
        }


def _kernel_function_names(index: ProductionIndex) -> dict[str, Path]:
    import ast

    names: dict[str, Path] = {}
    for path, tree in index.modules.items():
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                names.setdefault(node.name, path)
    return names


def closure_symbols_in_ledger(ledger_text: str, known_functions: dict[str, Path]) -> set[ClosureSymbol]:
    """(finding, symbol) pairs a RESOLVED entry names as kernel producers.

    Deliberately narrow: only backticked identifiers that resolve to REAL
    kernel functions AND carry a write-side producer verb count. Prose that
    names no producer makes no closure-reachability claim, so it makes no
    claim to verify.
    """
    sections = _LEDGER_HEADING.split(ledger_text)
    # split yields [pre, id1, body1, id2, body2, ...]
    pairs: set[ClosureSymbol] = set()
    for idx in range(1, len(sections) - 1, 2):
        finding_id, body = sections[idx], sections[idx + 1]
        if _RESOLVED not in body.split("\n## ")[0]:
            continue
        for match in _BACKTICKED.finditer(body):
            token = match.group(1)
            if token in known_functions and _is_producer_symbol(token):
                pairs.add(ClosureSymbol(finding_id=finding_id, symbol=token))
    return pairs


def _is_reachable(index: ProductionIndex, symbol: str, defining_path: Path) -> bool:
    import ast

    for path, call in index.calls_to(symbol):
        chain = index.enclosing_functions(path, call)
        innermost = chain[0] if chain else None
        innermost_name = getattr(innermost, "name", None)
        if innermost_name == symbol:
            continue  # self-recursion is not reachability
        if path.resolve() == defining_path.resolve() and innermost is not None:
            # A call from another function in the defining module is real
            # production reachability (the kernel's helper style); only a
            # call from the symbol itself, handled above, is not.
            return True
        return True
    return False


def scan_closure_reachability(
    repo_root: str | Path,
    *,
    baseline_path: str | Path | None = None,
) -> ReachabilityReport:
    repo = Path(repo_root).resolve()
    ledger_path = repo / "docs" / "reviews" / "orphan-findings.md"
    baseline_file = Path(baseline_path) if baseline_path else repo.joinpath(*CLOSURE_BASELINE_RELPATH)

    # ProductionIndex expects the REPO root: its roster walks
    # aria-kernel/, tools/ and scripts/ from there.
    index = ProductionIndex(repo)
    known = _kernel_function_names(index)
    pairs = closure_symbols_in_ledger(
        ledger_path.read_text(encoding="utf-8") if ledger_path.exists() else "",
        known,
    )

    unreachable: list[ClosureSymbol] = []
    reachable: list[ClosureSymbol] = []
    for pair in sorted(pairs, key=lambda p: (p.finding_id, p.symbol)):
        defining_path = known.get(pair.symbol)
        if defining_path is None:  # pragma: no cover — extraction guarantees existence
            continue
        if _is_reachable(index, pair.symbol, defining_path):
            reachable.append(pair)
        else:
            unreachable.append(pair)

    pinned_symbols = {_pin_symbol(key) for key in _baseline_pins(baseline_file)}
    pinned = [pair for pair in unreachable if pair in pinned_symbols]
    shrunk = [pin for pin in sorted(pinned_symbols, key=lambda p: (p.finding_id, p.symbol)) if pin in reachable]
    violations = [pair for pair in unreachable if pair not in pinned_symbols]
    return ReachabilityReport(
        unreachable=tuple(unreachable),
        pinned=tuple(pinned),
        shrunk=tuple(shrunk),
        violations=tuple(violations),
    )


def write_baseline(repo_root: str | Path, *, owner: str, reason: str) -> dict[str, Any]:
    """Pin the CURRENT unreachable set (first run), or shrink it (later runs).

    Never grows: a key absent from the current unreachable set is removed —
    that is the ratchet. Every pinned key carries owner, date, reason.
    """
    from datetime import datetime, timezone

    repo = Path(repo_root).resolve()
    baseline_file = repo.joinpath(*CLOSURE_BASELINE_RELPATH)
    report = scan_closure_reachability(repo, baseline_path=baseline_file)
    existing = _baseline_pins(baseline_file)
    now = datetime.now(timezone.utc).date().isoformat()
    pinned: dict[str, Any] = {}
    for pair in report.unreachable:
        key = f"{pair.finding_id}:{pair.symbol}"
        pinned[key] = existing.get(key) or {
            "owner": owner,
            "pinned_at": now,
            "reason": reason,
        }
    payload = {"schema_version": 1, "pinned": pinned}
    baseline_file.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return payload


__all__ = [
    "CLOSURE_BASELINE_RELPATH",
    "CLOSURE_PIN_KIND",
    "ClosureSymbol",
    "ReachabilityReport",
    "closure_symbols_in_ledger",
    "iter_closure_pins",
    "scan_closure_reachability",
    "write_baseline",
]
