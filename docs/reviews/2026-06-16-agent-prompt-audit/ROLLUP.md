# Agent-prompt audit — ROLLUP (code-verified)

**Cycle:** `2026-06-16-agent-prompt-audit`
**Scope:** all 86 review sub-agent prompts under `.claude/agents/**/*.md`.
**Mandate:** are they best-practice, correctly wired, and 100% code-aligned (verified by reading the
CODE, not the `.md`)? Make each code-review agent an obsessive expert at the REAL defects
(bugs/typos/dup/security) in its domain. Rationalize the roster to the codebase (remove/merge the
unnecessary). Add a CI guard against re-drift.

**Method:** 6 obsessive Opus expert lenses (prompt-architecture, code-alignment, security-defect,
bug-&-typo, duplication/DRY+contract, domain-truth) validated every claim against source. **Agents
are LEADS — the lead confirmed every consequential finding firsthand** (`file:line` below). Evidence
trail is markdown-only (like `orphan-findings.md`).

---

## Roster rationalization (code-base-driven verdicts)

| Agent | Verdict | Evidence (lead-verified) |
|---|---|---|
| `tenant-cost-attribution-expert` | **REMOVE** | Domain contradicted by code: `tenant_id` is **explicitly BANNED as a metric label** (`libs/backend-common/src/metrics/orchestrator-metrics.ts:35`); the only cost-rollup migration is **archive-only** (`apps/observability-service/.../.archive/.../1805000000000-AddTenantCostRollup.ts`); no live `cost-attribution`/`cost-reconciliation`/margin-SLO/cost-breaker code. Residual concerns already owned by `billing-expert` + `observability-expert`. |
| `audit-trail-completeness-auditor` | **KEEP + UPGRADE** (verdict revised from MERGE after wave-4d firsthand verification) | NOT redundant — a distinct, intentionally-split lens: auth-security owns audit *infrastructure* (`audit/**`), compliance owns SOC2/GDPR *evidence-mapping* and **explicitly hands audit-completeness off to this agent** (`compliance-expert.md:73` "CC4 → handoff to audit-trail-completeness-auditor"; `:33` names it owner of "completeness on every regulated action"). It owns the cross-cutting *coverage* slot (`routing-table:100` "every CQRS COMMAND handler audit capture") and is cross-referenced by 5 agents. Its cited mechanisms are REAL (`@AuditedOperation` decorator + `audit-log.interceptor.ts` + `audited-operation.interceptor.ts` all exist; "16 services" accurate). Merging would orphan the routing slot + dangle 5 cross-refs. |
| `mcp-expert` | **DEEPEN** (keep) | Real surface (`mcp/farm-management/src/...` exists) but wrong template: no Canonical-References `@`-block, no Primary-Ownership glob section, no `file:line`, generic prose. |
| `gdpr-erasure-executor` | **DEEPEN** (keep) | Real WRITER agent, but prompt overstates "10 services" + cites a non-existent `eraseTenantData` method; real cascade is ~4 services with non-uniform names (`farm-service/.../tenant-erasure.service.ts`, `observability-service/.../erase-observability-tenant-data.handler.ts`). |
| `database-reviewer` ⇄ `data-expert` | **KEEP + clarify** | Soft-merge candidate (same migration/entity corpus) but the delta-vs-state split is intentional + documented; make the boundary explicit in both Primary-Ownership sections rather than merge. |
| `memory-leak-auditor` ⇄ `performance-expert` | **KEEP + clarify** | Sibling lens (own desc: "handoff on heap-growth"); intentional; clarify, don't merge. |
| ~80 others | **KEEP** | Real, significant, accurately-described surfaces (ARIA agents all bound to `aria_kernel/agent_surface.py:83-101`; edge-docs writers each own a real `sens-api-gateway/docs/<subtree>/`; Lane-B auditors map to real product flows). |

---

## Findings

- **AGENT-PROMPT-001 (HIGH) — RESOLVED (this PR).** Injected boilerplate corruption: the verbatim
  lines `**Consequence**: Ignoring this guard…` (215×) and `**Example**: …approve plausible output…`
  (30×) appeared **245× across 42 files**, mid-content and even inside `@`-reference lists (e.g.
  `audit-trail-completeness-auditor.md:18`). Not in any SSoT; pure DRY/structure corruption. Stripped
  all 245; agents near the 200-line cap regained headroom (admin 198→183, database-reviewer 197→181).
- **AGENT-PROMPT-002 (HIGH).** REMOVE `tenant-cost-attribution-expert` (control-plane change: delete
  file + routing-table/orchestrator-roster rows + reassign surface (none needed; covered by
  billing/observability) + `.claude/README.md` cardinality + CODEOWNERS; keep all agent invariants green).
- **AGENT-PROMPT-003 (MED) — verdict REVISED to KEEP+UPGRADE (wave 4d, lead firsthand verification).** The
  original MERGE recommendation was WRONG. The agent is a distinct, intentionally-split lens (audit
  *coverage-completeness* across every regulated action), NOT redundant with auth-security (audit
  *infrastructure* `audit/**`) or compliance (SOC2/GDPR *evidence-mapping*). `compliance-expert.md:73`
  explicitly hands CC4 audit-completeness off to it ("Phase 9.5 sibling"); `routing-table:100` gives it
  the cross-cutting "every CQRS COMMAND handler audit capture" slot; 5 agents cross-reference it; its
  cited mechanisms (`@AuditedOperation`, `audit-log.interceptor.ts`) are real and "16 services" is
  accurate. UPGRADE applied instead: `layer-2-defect-catalog` wired + count drift-proofed. No file deleted.
- **AGENT-PROMPT-004 (MED).** Ghost `platform-services`: file absent, **11 agents reference it** as a
  handoff/finding-prefix sibling → repoint to `platform-kernel-expert` (kernel) / `billing-expert`.
- **AGENT-PROMPT-005 (MED).** Stale quantitative counts (verified): sensor "~357 files/18 events/40
  entities" → 410/21-22/48; farm "28 modules" → ~40; admin "232 files" → 289; billing
  `database/migrations/modules/billing/` **does not exist**; edge Cargo features `dev-insecure`/
  `debug-endpoints` **do not exist**; compliance `apps/*/src/gdpr/**` resolves **2 of 10**;
  ADR "16/001-016" → 36+; multi-tenant `SCHEMA_OWNING_SERVICES` 13 → 15; data `MODULE_SCHEMAS` 8 → 9.
  Fix per-agent AND prefer "~N"/SSoT-pointer over brittle exact counts.
- **AGENT-PROMPT-006 (HIGH).** No shared defect-catalog SSoT. The raw catalog already exists
  (`docs/reviews/_audit/2026-04-W16-anti-patterns.md`, 15 classes + `file:line`) but **no agent
  references it**, so generic security/bug classes are re-derived ad hoc (symptom: the v1-vs-v2 HMAC
  divergence between `security-reviewer` and `auth-security-expert`). Promote/distill to
  `.claude/knowledge/layer-2-defect-catalog.md`; fix its stale floating-promise claim ("globally off"
  — actually `error` globally, `off` only in test overrides per `eslint.config.mjs:312`); wire every
  code-review agent to `@`-reference it.
- **AGENT-PROMPT-007 (MED).** DEEPEN `mcp-expert` (9-section template + `mcp/**` ownership glob +
  `file:line`) and `gdpr-erasure-executor` (real per-service method names + true count).
- **AGENT-PROMPT-008 (MED).** Contract inconsistency: `mcp-expert`, `test-runner`,
  `architectural-arbiter` use bespoke "Operating Mode" prose, don't reference
  `@.claude/shared/operating-modes.md` (architectural-arbiter via the documented override block).
- **AGENT-PROMPT-009 (HIGH).** Per-agent security-defect gaps (code-grounded): `auth-security-expert`
  HMAC section describes **v1** canonical, real is **v2** with 7 extra bound fields
  (`service-identity.util.ts:197-228`) + misses caller-allowlist fail-open class; `sensor-expert` names
  the SCADA script-executor but NOT the `dangerouslySetInnerHTML`/expression-engine XSS defect
  (`web/modules/sensor-module/.../CustomSvgRenderer.tsx:33`); `frontend-expert` excellent but scoped
  away from that sensor-module SCADA XSS surface; `file-transfer-auditor` omits the real
  `file-upload-security.service.ts` magic-byte/MIME/path-traversal/SSRF-preview defenses; `ai-safety`
  cites wrong paths (`…/ai/safety/**` → real `…/ai-safety/`).
- **AGENT-PROMPT-010 (MED).** Per-agent bug/typo grounding gaps: `alert-engine-expert` +
  `platform-kernel-expert` have placeholder "Active findings"/no `file:line` despite live defects in
  their own trees (`alert-engine/.../channel-router.service.ts` bare catches); `mcp-expert` no generic
  bug classes. Domain agents otherwise genuinely obsessive about their own invariants.
- **AGENT-PROMPT-011 (LOW).** Cardinality: "45 Lane-A" conflates 11 ARIA + 34 true reviewers; fix the
  `.claude/README.md` `<!-- cardinality:lane-a-agents -->` marker after the roster change (doc-cardinality spec).
- **AGENT-PROMPT-012 (planned).** Add `tests/invariants/agent-prompt-accuracy.spec.ts` (path
  existence; 9-section completeness; defect-catalog reference; ban brittle exact counts) so this class
  of drift is detectable on every PR.

---

## Phased delivery

1. **PR-1 (this) — foundation cleanup:** strip the 245 corruption lines (AGENT-PROMPT-001) + this ROLLUP.
2. **PR-2 — shared defect-catalog SSoT** (AGENT-PROMPT-006) + wire references.
3. **PR-3 — roster rationalization** (AGENT-PROMPT-002/003/004/011): remove tenant-cost-attribution,
   merge audit-trail, fix ghost refs, fix cardinality — control-plane, all invariants green.
4. **PR-4+ — per-agent upgrades** by category (AGENT-PROMPT-005/007/008/009/010): code-aligned counts,
   defect-catalogs, security/bug grounding, contract consistency, deepen mcp/gdpr-erasure.
5. **PR-N — CI guard** (AGENT-PROMPT-012).

Each PR: isolated worktree off `origin/main`; `npm run invariants:fast` + `python3 -m pytest
aria-kernel/tests/invariants` green; no Co-Authored-By; merge after CI.
