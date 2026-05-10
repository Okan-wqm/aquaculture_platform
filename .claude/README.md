# `.claude/` — Agent Orchestration Directory

Claude Code's project-scope configuration for this repository. This README is the
top-level map for the multi-agent review system; every subdirectory has its own
README for deeper detail.

## Directory map

| Path | Purpose |
|---|---|
| `agents/` | Lane-A (code-quality) agent roster — <!-- cardinality:lane-a-agents -->39<!-- /cardinality --> domain + cross-cutting experts. Claude Code auto-discovers these. |
| `agents/_maintenance/` | Out-of-runtime maintenance tooling — <!-- cardinality:lane-a-maintenance -->3<!-- /cardinality --> agents (prompt-writer, implementation-planner, gdpr-erasure-executor). Auto-discovered by loader but excluded from runtime dispatch by the `maintenance-isolation` invariant. |
| `agents/product-audit/` | Lane-B (product-quality) roster — <!-- cardinality:lane-b-active-agents -->22<!-- /cardinality --> active UI/E2E/tenant-surface auditors. <!-- cardinality:lane-b-legacy -->4<!-- /cardinality --> deprecated files retired to `agents.legacy/product-audit/` on 2026-04-18. Meta-agents carry a `product-audit-*` name prefix to stay globally unique vs Lane-A. |
| `agents.legacy/` | Archived pre-2026-04-16 agent set — <!-- cardinality:lane-a-legacy -->20<!-- /cardinality --> Lane-A files (`platform-services.md` added 2026-04-18) + 4 Lane-B deprecated files under `product-audit/`. Retained for historical review traceability. Loader does NOT scan this directory. |
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

Claude Code auto-discovers `.claude/agents/**/*.md` (flat root + subdirectories per
[sub-agents docs](https://code.claude.com/docs/en/sub-agents.md)). Every agent in
`agents/` is reachable by its `name:` frontmatter value; `agents/product-audit/*.md`
agents are reachable by their `product-audit-*` names.

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
| `agent-name-uniqueness.spec.ts` | Every `name:` in `agents/` + `agents/product-audit/` is globally unique. |
| `agent-ownership-uniqueness.spec.ts` | No two agents claim primary ownership of the same glob without `secondary reviewer` / `delegated from` tags. |
| `orchestrator-routing-coverage.spec.ts` | Every top-level repo surface has a glob in the routing table; every routed-to agent exists in the runtime roster; old `.claude/agents-enterprise-v2/` paths do not resurface. |
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
- `docs/runbooks/product-audit-invocation.md` — Lane-B operational runbook (moved out of `.claude/agents/` dispatch surface 2026-04-18)
- `agents.legacy/README.md` — archival rationale + dormancy declaration
- `knowledge/README.md` — SSoT layer model
- `skills/README.md` — skill file format + reference-only status
- `/root/.claude/plans/razing-zebra-flat.md` — 2026-04-18 ratio-flip plan
- `/root/.claude/plans/synthetic-dazzling-hippo.md` — 2026-04-18 reconciliation plan (PR #11)
- `docs/reviews/context-manager/2026-04-18-enterprise-v2-audit.md` — the audit that triggered both plans
