"""E17-a — generated judge contract digest.

WHY this module exists
----------------------
The four runtime-dispatched judge/worker agents (aria-evidence-judge,
aria-adversarial-judge, aria-cross-reviewer, aria-worker) used to cold-read
four full docs via their ``.md`` preambles on every spawn: SPEC.md (43,191 B)
+ CONTRACTS.md (70,488 B) + PIPELINES.md (5,937 B) + layer-1-aria.md (6,119 B)
= 125,735 bytes, replaced here by an 8.5KB digest. That cost was invisible to
the dispatch budget audit rather than reported by it: context_budget_gate's
``_KNOWLEDGE_REF_RE`` matches only ``@.claude/knowledge/...``, so ``@docs/aria``
preamble refs were never counted — teaching that gate to count them is E17-d's
own deliverable (plan E17 orders d before a), NOT something this module claims
to have done.

A runtime judge needs the laws, the evidence/claim vocabulary, and the
dispatch-surface facts; the verdict schema, satisfaction entries, and envelope
trust rules it needs stay in the layer-2 canonical-envelope knowledge file,
which all four preambles still read. So the judge-relevant passages are fenced
in the source docs with ``<!-- judge-digest:begin -->`` /
``<!-- judge-digest:end -->`` markers and EXTRACTED VERBATIM into
docs/aria/generated/JUDGE-DIGEST.md.

WHAT keeps it honest
--------------------
- The sources stay SSoT: the digest is a render, never hand-edited. The
  invariant test (aria-kernel/tests/test_judge_digest_ssot.py) pins the
  committed digest byte-for-byte to render_judge_digest output.
- ``source_hash`` in the digest header is sha256 over the concatenated marked
  sources, so any drift between sources and the committed digest is visible
  and mechanically checkable.
- MAX_DIGEST_BYTES (10KB) is a HARD CAP: render raises ValueError above it,
  so the digest cannot silently regrow toward the 125,735-byte preamble it
  replaces.
- CLI exposure lives in the existing docs_ssot renderer family (İ1 — one
  generated-docs entrypoint, no duplicate CLI).

Regenerate after editing a marked section:
  PYTHONPATH=aria-kernel python3 -m aria_kernel.docs_ssot judge-digest \
    > docs/aria/generated/JUDGE-DIGEST.md
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

BEGIN_MARKER = "<!-- judge-digest:begin -->"
END_MARKER = "<!-- judge-digest:end -->"

# Ordered: laws first (SPEC), then schemas/vocabulary (CONTRACTS), then
# dispatch topology (PIPELINES). The digest preserves this order.
JUDGE_DIGEST_SOURCES: tuple[str, ...] = (
    "docs/aria/SPEC.md",
    "docs/aria/CONTRACTS.md",
    "docs/aria/PIPELINES.md",
)

JUDGE_DIGEST_PATH = "docs/aria/generated/JUDGE-DIGEST.md"

# Hard cap. A digest that outgrows 10KB has stopped being a digest — fail the
# render loudly instead of shipping quiet context bloat to every judge spawn.
MAX_DIGEST_BYTES = 10 * 1024

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")


def _heading_anchor(heading_text: str) -> str:
    """GitHub-style heading slug: lowercase, punctuation dropped, spaces → '-'.

    Mirrors GitHub's algorithm closely enough for the heading styles used in
    docs/aria (em dashes drop, backticks drop, underscores survive).
    """
    slug_chars: list[str] = []
    for ch in heading_text.strip().lower():
        if ch.isalnum() or ch in "-_":
            slug_chars.append(ch)
        elif ch == " ":
            slug_chars.append("-")
        # every other character (—, `, (, ), :, .) is dropped, like GitHub
    return "".join(slug_chars)


def _nearest_heading_anchor(lines: list[str], block_start_index: int) -> str | None:
    """Anchor of the closest heading at-or-above the marked block.

    A block that starts with its own heading anchors to itself; otherwise the
    nearest preceding heading is the section the reader must open — exactly
    the "if the digest is insufficient, Read the anchor" pointer contract.
    """
    for index in range(block_start_index, -1, -1):
        match = _HEADING_RE.match(lines[index])
        if match:
            return _heading_anchor(match.group(2))
    return None


def _extract_marked_blocks(text: str, source_rel: str) -> list[tuple[str, str | None]]:
    """Return [(block_text, anchor)] for every marker pair, in file order.

    Fail-closed on marker damage: an unbalanced or nested pair means the
    extraction boundary is ambiguous, and rendering an ambiguous digest would
    silently drop or duplicate law text.
    """
    lines = text.splitlines()
    blocks: list[tuple[str, str | None]] = []
    open_index: int | None = None
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped == BEGIN_MARKER:
            if open_index is not None:
                raise ValueError(
                    f"{source_rel}: nested {BEGIN_MARKER} at line {index + 1} "
                    f"(previous begin at line {open_index + 1} never closed)"
                )
            open_index = index
        elif stripped == END_MARKER:
            if open_index is None:
                raise ValueError(
                    f"{source_rel}: {END_MARKER} at line {index + 1} without a begin marker"
                )
            block_lines = lines[open_index + 1 : index]
            block = "\n".join(block_lines).strip("\n")
            if not block.strip():
                raise ValueError(
                    f"{source_rel}: empty judge-digest block ending at line {index + 1}"
                )
            blocks.append((block, _nearest_heading_anchor(lines, open_index + 1)))
            open_index = None
    if open_index is not None:
        raise ValueError(
            f"{source_rel}: {BEGIN_MARKER} at line {open_index + 1} never closed"
        )
    if not blocks:
        raise ValueError(
            f"{source_rel}: no judge-digest marker pairs found — every digest "
            "source must contribute at least one marked section"
        )
    return blocks


def _source_blocks(repo_root: Path) -> dict[str, list[tuple[str, str | None]]]:
    result: dict[str, list[tuple[str, str | None]]] = {}
    for rel in JUDGE_DIGEST_SOURCES:
        path = repo_root / rel
        if not path.is_file():
            raise ValueError(f"judge-digest source missing: {rel} (repo_root={repo_root})")
        result[rel] = _extract_marked_blocks(path.read_text(encoding="utf-8"), rel)
    return result


def concatenated_marked_sources(repo_root: str | Path) -> str:
    """The exact byte stream source_hash covers: every marked block, in order,
    prefixed by its source path so a block moving between files changes the hash."""
    root = Path(repo_root).resolve()
    parts: list[str] = []
    for rel, blocks in _source_blocks(root).items():
        for block, _anchor in blocks:
            parts.append(f"{rel}\n{block}")
    return "\n".join(parts) + "\n"


def judge_digest_source_hash(repo_root: str | Path) -> str:
    return hashlib.sha256(
        concatenated_marked_sources(repo_root).encode("utf-8")
    ).hexdigest()


def render_judge_digest(repo_root: str | Path) -> str:
    """Compose docs/aria/generated/JUDGE-DIGEST.md content.

    Raises ValueError when the rendered digest exceeds MAX_DIGEST_BYTES —
    the cap is the architectural guarantee that judge preamble cost stays
    bounded no matter how the source docs grow.
    """
    root = Path(repo_root).resolve()
    per_source = _source_blocks(root)
    source_hash = judge_digest_source_hash(root)

    pointer_lines: list[str] = []
    seen_pointers: set[str] = set()
    for rel, blocks in per_source.items():
        for _block, anchor in blocks:
            pointer = f"`{rel}#{anchor}`" if anchor else f"`{rel}`"
            if pointer not in seen_pointers:
                seen_pointers.add(pointer)
                pointer_lines.append(f"- {pointer}")

    out: list[str] = [
        "<!-- GENERATED FILE — do not edit by hand.",
        "     Renderer: aria-kernel/aria_kernel/contract_digest.py::render_judge_digest",
        "     Regenerate: PYTHONPATH=aria-kernel python3 -m aria_kernel.docs_ssot judge-digest \\",
        f"       > {JUDGE_DIGEST_PATH}",
        "     Pinned byte-for-byte by aria-kernel/tests/test_judge_digest_ssot.py. -->",
        "",
        "# ARIA Judge Contract Digest",
        "",
        f"source_hash: sha256:{source_hash}",
        "",
        "Preamble digest for the four runtime-dispatched judge/worker agents. Every",
        "passage below is extracted VERBATIM from the `judge-digest` marked sections",
        "of the full contract docs — the sources stay SSoT, this file is a render.",
        "",
        "If the digest is insufficient for the question at hand, Read the full doc at",
        "the anchor you need — and cite the anchor you followed:",
        "",
        *pointer_lines,
        "",
    ]
    for rel, blocks in per_source.items():
        out.append("---")
        out.append("")
        for block, anchor in blocks:
            pointer = f"{rel}#{anchor}" if anchor else rel
            out.append(f"> Source: `{pointer}`")
            out.append("")
            out.append(block)
            out.append("")
    rendered = "\n".join(out)
    if not rendered.endswith("\n"):
        rendered += "\n"

    rendered_bytes = len(rendered.encode("utf-8"))
    if rendered_bytes > MAX_DIGEST_BYTES:
        raise ValueError(
            f"judge digest render is {rendered_bytes} bytes > hard cap "
            f"{MAX_DIGEST_BYTES} bytes — shrink the marked sections in "
            f"{', '.join(JUDGE_DIGEST_SOURCES)}; the digest must not bloat back "
            "toward the full-doc preamble cost it replaced"
        )
    return rendered


__all__ = [
    "BEGIN_MARKER",
    "END_MARKER",
    "JUDGE_DIGEST_SOURCES",
    "JUDGE_DIGEST_PATH",
    "MAX_DIGEST_BYTES",
    "concatenated_marked_sources",
    "judge_digest_source_hash",
    "render_judge_digest",
]
