# Legacy Agents — ARCHIVED

**Status:** ARCHIVED (moved from `.claude/agents/` → `.claude/agents.legacy/` on 2026-04-16)
**Reason:** `name:` frontmatter collision with `.claude/agents-enterprise-v2/` caused undefined dispatch behavior. Canonical agent set is now `.claude/agents-enterprise-v2/` (see that directory's README).

## What this means

- **No new work lands here.** PRs modifying these files require `@Okan-wqm` review (CODEOWNERS gate, Phase 7 deliverable).
- **Dispatch is disabled.** Orchestrator routing table no longer references `.claude/agents/**`; `name:` frontmatter of archived agents is inert because this directory is outside the runtime agent loader path.
- **Retained for evidence.** Historical review outputs in `docs/reviews/<agent>/*.md` cite these prompt versions; deleting them would break finding-ID traceability.

## Original intent

This directory was the production agent roster from 2026-02 through 2026-04-15. Plan v4 AMENDMENT-C scheduled the archival for W14 of the agent+skill+gate initiative. Archive brought forward to 2026-04-16 as part of Phase 0 of `/root/.claude/plans/abstract-brewing-mochi.md` because live dispatch collisions were actively causing undefined behavior during W3 conversion wave.

## Where new work goes

```
.claude/agents-enterprise-v2/                   ← canonical review agents
.claude/agents-enterprise-v2/_shared/           ← shared template fragments (operating-modes, tier-claim-syntax, handoff-protocol, output-format)
.claude/knowledge/                              ← 3-layer knowledge SSoT (layer-1-{core,nestjs,typeorm,react,rust}, layer-2-patterns, layer-3-adrs)
.claude/skills/                                 ← procedural recipes (Phase 3 deliverable)
.claude/allowlists/                             ← boundary allowlist (19 entries)
```

## 30-day grace + deletion plan

This directory may be removed after 2026-05-16 (30 days from archive) if:
- No historical review file cites a legacy-only finding ID.
- Enterprise-v2 has completed ≥2 successful review cycles.
- Phase 4 `tests/invariants/agent-ownership-uniqueness.spec.ts` has passed on 5+ consecutive PRs.

Until then: retained, read-only, not in dispatch path.

## References

- `/root/.claude/plans/abstract-brewing-mochi.md` Phase 0.1 — archival rationale and execution
- `/root/.claude/plans/declarative-riding-shamir.md` AMENDMENT-C — original lifecycle plan (W14)
- `.claude/agents-enterprise-v2/README.md` — canonical agent set
- `docs/reviews/orchestrator/2026-04-16-v2-audit.md#P0-6` — tracked finding closing this archival
