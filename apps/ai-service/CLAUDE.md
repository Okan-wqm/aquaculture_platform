# ai-service — CLAUDE.md (domain context)

> Root rules in `/CLAUDE.md` already apply (always loaded). This file adds ONLY the ai-domain facts that CONTRADICT a correct reading of those rules.

AI agents, conversation, cost tracking, guardrails, tool execution. Schema: `ai` (tenant-scoped). Federated GraphQL subgraph (ADR-025 era pivot); the REST `ai.routes` surface was deleted.

## `strictOwnership: true` — an unregistered table is DROPPED at boot

`MODULE_SCHEMAS`'s `ai` entry sets `strictOwnership: true`, so `SourceSchemaBootstrapService` issues `DROP TABLE … CASCADE` for any table in the `ai` schema not declared as owned by this module — on **every startup**, not once.

Adding an entity without adding its table to the registry does not produce a drift warning. It produces a table that silently disappears on the next boot. Register first.

## "Ledger implies cross-tenant" is FALSE here

- `apps/ai-service/src/audit/tool-execution-audit.entity.ts` → `@Entity('tool_execution_audit', { schema: 'ai' })` — cross-tenant, because the audit stream spans tenants for operator analytics by design.
- `apps/ai-service/src/cost/conversation-turn.entity.ts` → `@Entity('conversation_turns')` — **per-tenant**, despite being an append-only cost ledger.

<!-- infra-tables:ai -->`migrations`, `ai_outbox`, `tool_execution_audit`, `tenant_erasure_target_proofs`<!-- /infra-tables -->

Proven against `MODULE_SCHEMAS` by `tests/invariants/nested-steering-parity.spec.ts` — edit the registry, never this copy.

## Rules that look like bugs and are not

- `conversation_turns.conversationId` is deliberately NOT a foreign key. The cost ledger must outlive GDPR deletion of the conversation it refers to; an FK would cascade the billing record away.
- The action-confirm path re-executes the STORED `ai_proposed_actions` row and ignores client-supplied parameters. That is tamper-proofing, not a dropped-parameter bug. The status transition is claimed atomically with `UPDATE … WHERE status='proposed'`.

## Enforcement

Boot: `SchemaDriftValidator`, `SourceSchemaBootstrapService` (strict ownership). CI: `tests/invariants/tenant-fanout-entity-parity.spec.ts`, `entity-schema-declaration.spec.ts`, `tenant-erasure-ssot.spec.ts`, `authoritative-runtime-ddl-contract.spec.ts`; `e2e/tests/integration/schema-invariants.spec.ts`.
