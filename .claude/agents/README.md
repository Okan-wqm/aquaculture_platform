# Active Agent Dispatch Surface

This directory is the active Claude Code prompt-discovery root. Claude Code discovers `.claude/agents/**/*.md` by frontmatter `name:`.

## Active Lanes

| Lane | Paths | Entry point | Scope |
|---|---|---|---|
| Lane-A | `.claude/agents/*.md` except `aria-*.md` | `orchestrator` | Code-quality, architecture, security, domain review |
| Lane-B | `.claude/agents/product-audit/*.md` | `product-audit-orchestrator` | Product-truth, UI/E2E, tenant-surface audit |
| Lane-C | `.claude/agents/edge-docs/*.md` | `edge-docs-orchestrator` | `sens-api-gateway/docs/**` documentation production |
| ARIA | `.claude/agents/aria-*.md`, `.claude/agents/_maintenance/aria-*.md` | ARIA operator/kernel flow | Continuous-mode evidence, planning, judging, and controlled implementation |

## Non-Runtime Tools

`_maintenance/*.md` agents are loadable by exact name but are not part of normal Lane-A/Lane-B/Lane-C runtime review rosters. They exist for explicit maintenance workflows such as prompt generation, implementation planning, GDPR erasure execution, and ARIA-controlled prompt/draft work.

Retired prompt directories outside `.claude/agents/**` should be deleted after useful guidance is migrated into the active owner. Keeping stale rosters creates duplicate ownership, wrong finding-ID prefixes, and invalid output-path contracts.
