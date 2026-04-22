# Legacy Agents — ARCHIVED

> ## ⛔ DO NOT READ
>
> **This directory is archive-only.** Every file inside is a STALE
> pre-2026-04-16 agent prompt. The loader does not scan this directory.
> Reading these files to derive current behaviour, rules, or
> architectural intent will surface drifted guidance — the opposite of
> what an operator needs. If you need agent context, read
> `.claude/agents/**/*.md` and `.claude/agents/product-audit/**/*.md`
> (the canonical roster) and `.claude/README.md` (the directory map).
>
> Files are retained strictly for finding-ID traceability in
> historical review outputs under `docs/reviews/{agent}/`. If your PR
> references a finding raised against a legacy agent, cite the
> archived file path via `@.claude/agents.legacy/{agent}.md:{line}`
> so the provenance chain stays intact — but do not apply rules from
> it to current code.
>
> 30-day deletion window began 2026-04-16 (per `abstract-brewing-mochi.md`
> Phase 0); `platform-services.md` added 2026-04-18 restarts that timer
> for its own file.

**Status:** ARCHIVED (moved from `.claude/agents/` → `.claude/agents.legacy/` on 2026-04-16)
**Reason:** `name:` frontmatter collision with `.claude/agents/` caused undefined dispatch behavior. Canonical agent set is now `.claude/agents/` (see that directory's README).

## What this means

- **No new work lands here.** PRs modifying these files require `@Okan-wqm` review (CODEOWNERS gate, Phase 7 deliverable).
- **Dispatch is disabled.** Orchestrator routing table no longer references `.claude/agents/**`; `name:` frontmatter of archived agents is inert because this directory is outside the runtime agent loader path.
- **Retained for evidence.** Historical review outputs in `docs/reviews/<agent>/*.md` cite these prompt versions; deleting them would break finding-ID traceability.

## Original intent

This directory was the production agent roster from 2026-02 through 2026-04-15. Plan v4 AMENDMENT-C scheduled the archival for W14 of the agent+skill+gate initiative. Archive brought forward to 2026-04-16 as part of Phase 0 of `/root/.claude/plans/abstract-brewing-mochi.md` because live dispatch collisions were actively causing undefined behavior during W3 conversion wave.

## Where new work goes

```
.claude/agents/                   ← canonical review agents
.claude/shared/           ← shared template fragments (operating-modes, tier-claim-syntax, handoff-protocol, output-format)
.claude/knowledge/                              ← 3-layer knowledge SSoT (layer-1-{core,nestjs,typeorm,react,rust}, layer-2-patterns, layer-3-adrs)
.claude/skills/                                 ← procedural recipes (Phase 3 deliverable)
.claude/allowlists/                             ← boundary allowlist (19 entries)
```

## 30-day grace + deletion plan

This directory may be removed after 2026-05-16 (30 days from archive) if:
- No historical review file cites a legacy-only finding ID.
- Enterprise-v2 has completed ≥2 successful review cycles.

## 2026-04-18 addition — DEPRECATED Lane-B files archived early

Four Lane-B files whose Lane-A promotion targets are live were moved here:
- `product-audit/gdpr-compliance-auditor.md`  → Lane-A: compliance-expert
- `product-audit/soc2-readiness-auditor.md`    → Lane-A: compliance-expert
- `product-audit/ai-tool-execution-auditor.md` → Lane-A: ai-safety-auditor
- `product-audit/contract-parity-auditor.md`   → Lane-A: contract-parity-enforcer

Original deprecation 2026-04-16. Moved to legacy early (2026-04-18) during the
razing-zebra-flat plan's Phase 4d — their active-directory presence was blocking
the agent-size-limit invariant expansion with explicit exemption entries.
Same 30-day grace window applies; eligible for deletion ≥ 2026-05-18.
- Phase 4 `tests/invariants/agent-ownership-uniqueness.spec.ts` has passed on 5+ consecutive PRs.

Until then: retained, read-only, not in dispatch path.

## References

- `/root/.claude/plans/abstract-brewing-mochi.md` Phase 0.1 — archival rationale and execution
- `/root/.claude/plans/declarative-riding-shamir.md` AMENDMENT-C — original lifecycle plan (W14)
- `.claude/agents/README.md` — canonical agent set
- `docs/reviews/orchestrator/2026-04-16-v2-audit.md#P0-6` — tracked finding closing this archival
