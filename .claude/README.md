# `.claude/` — Agent Orchestration Directory

Claude Code's project-scope configuration for this repository. This README is the
top-level map for the multi-agent review system; every subdirectory has its own
README for deeper detail.

## Directory map

| Path | Purpose |
|---|---|
| `agents/*.md` | Lane-A code-quality reviewers plus root-level ARIA agents. Lane-A runtime cycles enter through `orchestrator`; ARIA agents are invoked only by ARIA operator/kernel workflows so continuous-mode evidence loops do not mix with PR review findings. |
| `agents/_maintenance/` | Out-of-runtime maintenance tooling — <!-- cardinality:lane-a-maintenance -->5<!-- /cardinality --> agents (prompt-writer, implementation-planner, gdpr-erasure-executor, aria-drafter, aria-prompt-writer). Auto-discovered by loader but excluded from runtime dispatch by the `maintenance-isolation` invariant. |
| `agents/product-audit/` | Lane-B product-quality roster — <!-- cardinality:lane-b-active-agents -->22<!-- /cardinality --> active UI/E2E/tenant-surface auditors. Meta-agents carry a `product-audit-*` name prefix to stay globally unique vs Lane-A. |
| `agents/edge-docs/` | Lane-C documentation-production roster for `sens-api-gateway/docs/**`, entered through `edge-docs-orchestrator`. Keeping Lane-C separate prevents documentation writers from being mistaken for code reviewers. |
| `agents/db-audit/` | Lane-D database end-to-end audit roster — 8 partition auditors tracing column provenance, FE↔BE parity, and dead/orphan/duplicate durable surfaces. No lane orchestrator: the operator session dispatches partitions and owns synthesis. Method SSoT: `agents/_shared/db-audit-methodology.md`; reports land under `docs/reviews/db-audit/**`. |
| `shared/` | Shared fragments consumed by agents via `@`-reference: `operating-modes.md`, `tier-claim-syntax.md`, `handoff-protocol.md`, `output-format.md`, `orchestrator-phases.md`, `orchestrator-routing-table.md`, `_conversion-template.md`. |
| `knowledge/` | 3-layer SSoT for tech anchors, patterns, and ADRs — `layer-1-{core,nestjs,typeorm,react,rust,timescaledb,ai}.md`, `layer-2-patterns.md`, `layer-3-adrs.md`. |
| `skills/` | 7 procedural cascade files — `status: reference-only` per the 2026-04-18 flip; consulted as canonical recipes, not auto-invoked pipelines. |
| `allowlists/` | Boundary-allowlist YAML for legitimate Tier-4 escape hatches (MQTT wire, Stripe webhook, generated proto, etc.). CODEOWNERS-gated. |
| `settings.json` | Project-scope permission rules (currently: deny reading `.env*`). |
| `settings.local.json` | Per-session permission history (gitignored contents except staged entries). |

## Dispatch path

**One canonical path: Claude Code's built-in `Agent()` tool in a CLI session.**

```
Agent(subagent_type="farm-expert", description="...", prompt="...")
```

Claude Code auto-discovers active prompts under `.claude/agents/**/*.md` only. Active dispatch lanes are Lane-A root code review (`orchestrator`), Lane-B product audit (`agents/product-audit/`, `product-audit-orchestrator`), Lane-C edge documentation (`agents/edge-docs/`, `edge-docs-orchestrator`), Lane-D database audit (`agents/db-audit/`, operator-dispatched, no lane orchestrator), and ARIA (`aria-*.md` plus ARIA maintenance prompts, invoked only by ARIA operator/kernel workflows).

Retired prompt folders are deleted after useful guidance is migrated into the active owner. Keeping stale prompt copies causes duplicate agent names, conflicting ownership rules, wrong finding-ID prefixes, and invalid output paths.

**No background runner. No API-key dispatcher. No external CLI binary.** The
previous `tools/scripts/orchestrator-runner.ts` + `npm run review` path delegated
to a non-existent `claude-agent` CLI — deleted entirely in the 2026-04-18 flip.

## SSoT reading protocol

Every agent file carries a `## Canonical References (READ via the Read tool before
starting)` section listing `@.claude/knowledge/...` paths. **The `@` prefix is a
reader bookmark, not an auto-import.** Claude Code honors `@` paths only inside
`CLAUDE.md` (Memory docs); agent body content never gets expanded.

Agents use the `Read` tool to load each cited SSoT file at the start of every
invocation. Keeping SSoT discipline as an explicit Read contract (rather than a
silent include) makes the dependency visible in every agent execution trace and
lets invariants assert that knowledge shards are version-anchored against real
repo state (`tests/invariants/knowledge-ssot.spec.ts`).

## Invariant gates

Every push runs `npx jest --config tests/invariants/jest.config.ts`.

| Spec | Asserts |
|---|---|
| `agent-name-uniqueness.spec.ts` | Every active agent `name:` under `.claude/agents/**/*.md` is globally unique; retired prompt directories are absent. |
| `agent-ownership-uniqueness.spec.ts` | No two agents claim primary ownership of the same glob without `secondary reviewer` / `delegated from` tags. |
| `orchestrator-routing-coverage.spec.ts` | Every top-level repo surface has a glob in the routing table; every routed-to Lane-A agent exists in the runtime roster; retired dispatch paths do not resurface. |
| `skills-catalog.spec.ts` | Every skill has canonical frontmatter (incl. `handoff:`), BLOCKER-gated skills name the BLOCKER, no dangling `use \`<name>\` skill` references. |
| `knowledge-ssot.spec.ts` | Knowledge-layer version anchors (SDK version, service counts, ADR counts) match the real repo state. |
| `boundary-allowlist-invariants.spec.ts` | Every `expires: never` entry carries an ADR reference. |
| `agent-size-limit.spec.ts` | Every agent file ≤200 lines. |
| `agent-frontmatter-schema.spec.ts` | Every agent has required frontmatter (`name`, `description`, `model: opus`, `effort: xhigh`, `tools:`) with token-whitelisted `tools:` values. |
| `maintenance-isolation.spec.ts` | `.claude/agents/_maintenance/*.md` agent names never appear in orchestrator Runtime Review Roster table. |
| `settings-hook-coverage.spec.ts` | `.claude/settings.json` declares the `PreToolUse` Agent dispatch hook + gate script exists. |
| `three-store-invariants.spec.ts` | Registry ↔ commits ↔ review files cross-consistency. |
| `finding-registry-integrity.spec.ts` | JSONL schema conformance + hash chain integrity. |

## References

- `agents/README.md` — Lane-A intent + activation history
- `agents/product-audit/README.md` — Lane-B intent + roster
- `agents/edge-docs/README.md` — Lane-C documentation-production charter + roster
- `agents/db-audit/README.md` — Lane-D database-audit charter + roster
- `docs/aria/{SPEC,IDENTITY,CONTRACTS}.md` and `knowledge/layer-1-aria.md` — ARIA design, behavior, and contract anchors
- `docs/runbooks/product-audit-invocation.md` — Lane-B operational runbook (moved out of `.claude/agents/` dispatch surface 2026-04-18)
- `knowledge/README.md` — SSoT layer model
- `skills/README.md` — skill file format + reference-only status
- `/root/.claude/plans/razing-zebra-flat.md` — 2026-04-18 ratio-flip plan
- `/root/.claude/plans/synthetic-dazzling-hippo.md` — 2026-04-18 reconciliation plan (PR #11)
- `docs/reviews/context-manager/2026-04-18-enterprise-v2-audit.md` — the audit that triggered both plans
