# `.claude/` — Agent Orchestration Directory

Claude Code's project-scope configuration for this repository. This README is the
top-level map for the multi-agent review system; every subdirectory has its own
README for deeper detail.

## Directory map

| Path | Purpose | Dispatch-eligible? |
|---|---|---|
| `agents-enterprise-v2/` | Lane-A (code-quality) agent roster — 34 domain/cross-cutting experts + 7 shared template fragments + 2 runner wrappers | **Yes**, via the runner path (`npm run review` → `ts-node tools/scripts/orchestrator-runner.ts` → `claude-agent` CLI). NOT visible to Claude Code's built-in `Agent()` dispatcher. |
| `test-agents/` | Lane-B (product-quality) agent roster — 28 UI/E2E/tenant-surface auditors. Prefix `product-audit-*` on the three meta-agents (orchestrator / context-manager / arbiter). | **Yes**, via the same runner path. Lane-B was assigned distinct `name:` prefixes 2026-04-18 (`CLAUDE-CRITICAL-001`) to eliminate collision with Lane-A. |
| `agents.legacy/` | Archived pre-2026-04-16 agent set — 20 files. Retained for historical review traceability. | **No.** Loader explicitly skips this directory. Files retain their original `name:` frontmatter but are inert because the runner does not scan here. 30-day deletion window opens per entry's archival date. |
| `knowledge/` | 3-layer SSoT for tech anchors, patterns, and ADRs — `layer-1-{core,nestjs,typeorm,react,rust,timescaledb,ai}.md`, `layer-2-patterns.md`, `layer-3-adrs.md`. | n/a — reference files, not agents. |
| `skills/` | 7 procedural cascade files for cross-cutting architectural tasks (add-entity-field, change-event-contract, add-rls-policy, add-shared-table, provision-tenant, pre-migration-restore-test, run-migration-prod). Each carries a `handoff:` frontmatter block per `_shared/handoff-protocol.md`. | n/a — consumed by `implementation-planner` when composing work packages. |
| `allowlists/` | Boundary-allowlist YAML for legitimate Tier-4 escape hatches (MQTT wire, Stripe webhook, generated proto, etc.). CODEOWNERS-gated. | n/a. |
| `settings.json` | Project-scope permission rules (currently: deny reading `.env*`). | n/a. |
| `settings.local.json` | Per-session permission history (gitignored contents except staged entries). | n/a. |

## Runtime invocation paths

There are TWO dispatch paths into the agent system; they reach different subsets
of files and have different name-resolution contracts.

### Path 1 — Runner (canonical for review cycles)

```
npm run review                     # generic orchestrator cycle
npm run audit:gdpr                 # fixed-profile GDPR review
npm run audit:perf                 # fixed-profile performance sweep
npm run review:farm                # scoped to apps/farm-service/**
# ...see package.json "scripts" for the full matrix
```

Flow: `npm run …` → `ts-node --project tools/gates/tsconfig.json tools/scripts/orchestrator-runner.ts …` → the runner composes an invocation and calls `claude-agent run --agent <name> --topic <slug> --mode review`. The `claude-agent` CLI is the actual dispatcher.

The runner loads agent files from **both** `agents-enterprise-v2/` and
`test-agents/`. It delegates name resolution to `claude-agent` — which is why
globally unique `name:` frontmatter across those two directories is a hard
invariant (see `tests/invariants/agent-name-uniqueness.spec.ts`).

### Path 2 — Built-in `Agent()` tool (NOT the canonical path for this repo)

Claude Code's built-in `Agent()` tool scans only `.claude/agents/` (flat) per the
[sub-agents docs](https://code.claude.com/docs/en/sub-agents.md). Because this
repo uses `.claude/agents-enterprise-v2/` (and previously `.claude/agents/`
which was archived as `.claude/agents.legacy/` on 2026-04-16), **Claude Code's
built-in `Agent()` dispatcher cannot reach the enterprise-v2 roster**. Invoking
`Agent(subagent_type="farm-expert")` from an interactive session will not find
the farm-expert agent.

To run a review, use the runner path above. The enterprise-v2 roster is
explicitly designed for runner-driven review cycles, not interactive
`Agent()` dispatch.

## SSoT reading protocol

Every enterprise-v2 agent file carries a `## Canonical References (READ via the
Read tool before starting)` section listing `@.claude/knowledge/…` paths. **The
`@` prefix is a reader bookmark, not an auto-import.** Claude Code honors `@`
paths only inside `CLAUDE.md` (Memory docs); agent body content never gets
expanded. Agents must use the `Read` tool to load each listed SSoT file at the
start of every invocation.

Rationale: keeping SSoT discipline as an explicit Read contract (rather than a
silent import) makes the dependency visible in every agent execution trace and
lets the invariant suite assert that knowledge shards are version-anchored
against the real package.json / repo state (see `tests/invariants/knowledge-ssot.spec.ts`).

## Invariant gates

Every push to `main` runs `npx jest --config tests/invariants/jest.config.ts`.
The invariants relevant to this directory:

| Spec | Asserts |
|---|---|
| `agent-name-uniqueness.spec.ts` | Every `name:` in `agents-enterprise-v2/` + `test-agents/` is globally unique. |
| `agent-ownership-uniqueness.spec.ts` | No two agents claim primary ownership of the same glob without `secondary reviewer` / `delegated from` tags. |
| `orchestrator-routing-coverage.spec.ts` | Every top-level repo surface has a glob in the routing table; every routed-to agent exists in the runtime roster. |
| `skills-catalog.spec.ts` | Every skill has canonical frontmatter incl. `handoff:`, BLOCKER-gated skills name the BLOCKER, no dangling `use \`<name>\` skill` references. |
| `knowledge-ssot.spec.ts` | Knowledge-layer version anchors (SDK version, service counts, ADR counts) match the real repo state. |

## References

- `agents-enterprise-v2/README.md` — Lane-A intent + activation history
- `agents-enterprise-v2/_shared/` — operating modes, tier claims, handoff protocol, output format, orchestrator phases, routing table
- `test-agents/README.md` + `test-agents/INVOCATION-PACK.md` — Lane-B intent + runbook
- `agents.legacy/README.md` — archival rationale + dormancy declaration
- `knowledge/README.md` — SSoT layer model
- `skills/README.md` — skill file format + handoff contract
- `/root/.claude/plans/synthetic-dazzling-hippo.md` — 2026-04-18 reconciliation plan
- `docs/reviews/context-manager/2026-04-18-enterprise-v2-audit.md` — the audit that produced this reconciliation
