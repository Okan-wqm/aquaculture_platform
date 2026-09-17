"""Deliver an agent's contract to the model that is asked to honour it.

WHY. The kernel-rendered request prompt ends with "Write your
aria/agent-response/v1 JSON envelope per your agent contract" — and never
carried the contract. The agent's `.claude/agents/<name>.md` body (its
canonical envelope shape, its refusal discipline, the knowledge files it
cites with `@.claude/knowledge/...`) reached the model on no route: the
Claude route sends the rendered prompt on stdin without `--agent`, and the
Codex and Z.ai routes have no file reader at all. The first completed native
planner attempt (2026-09-11, Codex gpt-6-astra, 297 s, 69,945 input tokens)
returned a plan under `plan`/`findings`, reported "the exposed tools provide
no text-file reader", and was refused at pre-submit with
`plan_content:absent_or_not_object` — a contract the model was told to obey
and never shown.

WHAT. `render_agent_contract` reads the agent file, strips its YAML
frontmatter, inlines every knowledge file the body cites (bounded, in
citation order, each under a fence that names its path), and returns the
text with a content hash. The executor prepends it to what the model
receives on every route and records the hash next to the request's
`prompt_hash`: the request prompt stays bound to the mint, and the contract
the model saw is bound to this attempt. Omitted citations are listed, never
silently dropped, so a budget overflow reads as a fact and not as "the
model ignored the file".
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path

AGENTS_DIR = Path(".claude") / "agents"
FRONTMATTER_RX = re.compile(r"\A---\r?\n.*?\r?\n---\r?\n", re.S)
# `@.claude/knowledge/layer-2-aria-canonical-envelope.md`, with or without
# backticks, as agent bodies spell their reader bookmarks.
CITATION_RX = re.compile(r"@(\.claude/knowledge/[A-Za-z0-9_./-]+\.md)")
DEFAULT_INLINE_BUDGET_BYTES = 96_000


class AgentContractUnavailable(RuntimeError):
    """The agent file could not be read; the model must not run without its contract."""


@dataclass(frozen=True)
class AgentContractDelivery:
    agent_name: str
    agent_path: str
    contract_hash: str
    text: str = field(repr=False)
    inlined_refs: tuple[str, ...] = ()
    omitted_refs: tuple[str, ...] = ()

    def as_row(self) -> dict[str, object]:
        return {
            "agent_name": self.agent_name, "agent_path": self.agent_path,
            "agent_contract_hash": self.contract_hash,
            "inlined_refs": list(self.inlined_refs), "omitted_refs": list(self.omitted_refs),
            "bytes": len(self.text.encode("utf-8")),
        }


def _find_agent_file(agent_name: str, repo_root: Path) -> Path | None:
    base = repo_root / AGENTS_DIR
    direct = base / f"{agent_name}.md"
    if direct.is_file():
        return direct
    matches = sorted(base.glob(f"**/{agent_name}.md")) if base.is_dir() else []
    return matches[0] if matches else None


def render_agent_contract(
    agent_name: str, *, repo_root: str | Path, inline_budget_bytes: int = DEFAULT_INLINE_BUDGET_BYTES,
) -> AgentContractDelivery:
    root = Path(repo_root).resolve()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", agent_name or ""):
        raise AgentContractUnavailable(f"agent_name_invalid: {agent_name!r}")
    path = _find_agent_file(agent_name, root)
    if path is None:
        raise AgentContractUnavailable(f"agent_file_unavailable: {agent_name!r} under {AGENTS_DIR}")
    try:
        body = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise AgentContractUnavailable(f"agent_file_unreadable: {type(exc).__name__}") from exc
    body = FRONTMATTER_RX.sub("", body, count=1).strip()

    citations: list[str] = []
    for match in CITATION_RX.finditer(body):
        relative = match.group(1)
        if relative not in citations:
            citations.append(relative)
    parts = [
        f"# Agent contract: {agent_name}",
        "",
        "Runtime note: this route may provide no file tools. Every knowledge file the "
        "contract cites is inlined below, and the request that follows carries its own "
        "evidence excerpts; use only what is in this message. The response is the single "
        "JSON `aria/agent-response/v1` envelope the contract specifies.",
        "",
        body,
    ]
    inlined: list[str] = []
    omitted: list[str] = []
    remaining = int(inline_budget_bytes)
    for relative in citations:
        target = (root / relative).resolve()
        try:
            target.relative_to(root)
            content = target.read_text(encoding="utf-8")
        except (OSError, UnicodeError, ValueError):
            omitted.append(relative)
            continue
        size = len(content.encode("utf-8"))
        if size > remaining:
            omitted.append(relative)
            continue
        remaining -= size
        inlined.append(relative)
        parts.extend(["", f"## Inlined knowledge file: `{relative}`", "", "<inlined_knowledge_file>",
                      content.strip(), "</inlined_knowledge_file>"])
    if omitted:
        parts.extend(["", "## Cited knowledge files NOT inlined (budget or unreadable)", ""])
        parts.extend(f"- `{relative}`" for relative in omitted)
    # The validator's own rules close the contract, rendered from the code
    # that enforces them, so no prose above can promise what submit refuses.
    from .agent_contract import render_response_validator_contract

    parts.extend(["", render_response_validator_contract().rstrip()])
    text = "\n".join(parts).rstrip() + "\n"
    digest = "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()
    return AgentContractDelivery(
        agent_name=agent_name, agent_path=str(path.relative_to(root)), contract_hash=digest,
        text=text, inlined_refs=tuple(inlined), omitted_refs=tuple(omitted),
    )


__all__ = ["AgentContractDelivery", "AgentContractUnavailable", "CITATION_RX", "render_agent_contract"]
