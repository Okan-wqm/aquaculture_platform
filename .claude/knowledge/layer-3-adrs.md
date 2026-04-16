# Layer-3 — ADR Index

**Audience:** every enterprise-v2 agent.
**Scope:** one-line summary of every canonical ADR (`docs/adr/001-016.md`), with current enforcement tier and location of the authority.

Agents reference this index instead of loading full ADR text. When an agent cites ADR-N, the citation format is `ADR-N (<tier>) — see layer-3-adrs.md`; the full text lives in `docs/adr/NNN-*.md`.

## Canonical ADRs (001-016)

| # | Title | Invariant (1-line) | Current tier | Enforcement mechanism |
|---|-------|---------------------|--------------|-----------------------|
| 001 | Nx Monorepo Over Polyrepo | All first-party code in one Nx workspace; cross-service changes ship atomically | Tier 4 (doc) | Organizational — `nx.json` config; no automated drift detection |
| 002 | Single Gateway-API Edge Service | `gateway-api` is the sole internet-reachable backend; internal services verify inbound HMAC | Tier 4 (doc) | Deployment topology; HMAC verification partially wired (SEC-HIGH-002/003 hardening W5) |
| 003 | Sensor-Service Separation from Edge Gateway | Cloud `sensor-service` (NestJS) and edge `sens-api-gateway` (Rust) are independent; shared contract via `libs/event-contracts` | Tier 4 (doc) | Deployment topology; CI gating on Rust crate is a known gap (EDGE-CRITICAL-001) |
| 004 | Temporal Workflow Adoption — SUPERSEDED | Original intent rejected; current: sagas + outbox + NATS JetStream cover workflow needs | n/a (tombstone) | File tombstone references current-reality orchestration primitives |
| 005 | OpenSearch Centralised Logging — SUPERSEDED | Original intent deferred; current: `StructuredLoggerService` + Prometheus + stdout JSON | n/a (tombstone) | File tombstone references current logging stack |
| 006 | Event Contracts Flat Pattern | Events extend `BaseEvent` with typed fields at top level; no nested payload wrappers; `createBaseEvent()` factory + branded `EventId` | Tier 1 (partial) | Branded EventId compile-enforces construction; `EventBus.publish` generic bound missing — promote to full Tier-1 in W7 |
| 007 | CQRS Usage Strategy | Controller → Service → Bus → Handler → Repository; no layer skipping | Tier 4 (doc) | Review discipline; no automated detection |
| 008 | Guard Strategy Defense-in-Depth | JWT + Tenant + Role/Feature guards stacked on authenticated endpoints; OPA at the policy tier | Tier 3 (partial) | ESLint + runtime guards; OPA has zero adoption (SEC-HIGH-004) — W4 decision |
| 009 | Frontend Data-Fetch Pattern | React Query as the canonical server-state manager; tenant-scoped `queryKey` factory | Tier 3 (partial) | `createTenantQueryKey()` exists, 4/~30 adoption; W6 ESLint rule `no-bare-tenant-query-key` |
| 010 | Frontend Styling Strategy | Design-token-based styling; arbitrary inline `style={{}}` banned where tokens exist | Tier 4 (doc) | Review discipline; W7 ESLint rule planned |
| 011 | Schema Ownership Model | Every `@Entity()` declares `schema:` option; `public` forbidden for new tables | Tier 3 (detectable) | `SchemaDriftValidator` at boot + `schema-invariants.spec.ts` CI test; 157 violations pending W2-W3 fix (BLOCKER-8 scope) |
| 012 | Schema Drift Prevention | Runtime validator + CI invariant on entity↔DB mapping drift; `SCHEMA_DRIFT_FATAL=true` in production | Tier 3 (detectable) | `SchemaDriftModule.forRoot` in 9+ services; `adoption-invariants.spec.ts` W2 closes adoption loop (BLOCKER-19) |
| 013 | Messaging Isolation Convergence | messaging-service tenant schema convergent with farm/sensor model; outbox + NATS isolation | Tier 3 (detectable) | Per-service schema validated by 011 + 012 mechanisms |
| 014 | NATS mTLS-Only Auth | NATS identity is mTLS cert only; user/pass forbidden in CONNECT frame | Tier 1 (impossible) | `nats.conf` `verify_and_map: true`; invariant test asserts zero `password:` fields |
| 015 | NATS Cert-is-Identity SSoT | `infrastructure/nats/services.yaml` is SSoT; `nats.conf` generated between sentinels; cert CN list in lockstep | Tier 2 (automatic) + Tier 3 (detectable) | `scripts/nats/generate-nats-conf.py` generator + `nats-invariants.spec.ts` triple-lockstep check |
| 016 | Deploy Resilience Architecture | Deploy pipeline phases (health-check wait, pool recycle, smoke tests) + RS256 JWT rollout | Tier 3 (Phase A) / Tier 4 (Phases C-F) | CI pipeline for Phase A shipped; later phases are roadmap |

## Drift note

Four files under `docs/architecture/ADR-01{0,1,2,3}-*.md` use ADR numbering but live outside `docs/adr/`. They pre-date the canonical set and duplicate numbers. CLAUDE.md: *"Treat `docs/adr/` as authoritative. Moving or renumbering the misfiled files is tracked work, not done here."* Agents must never cite ADR-0-series numbers without the `docs/adr/` path prefix.

## Tier semantics

- **Tier 1 (make impossible)** — the wrong code does not compile / does not parse / cannot be represented in the type system or schema. Best tier. Minimum enforcement cost after the initial mechanism.
- **Tier 2 (make automatic)** — the correct behaviour is the zero-effort default; deviation requires explicit override (and override is visible).
- **Tier 3 (make detectable)** — CI / lint / runtime validator catches the wrong behaviour at commit / boot time. Reviewer can rely on the gate.
- **Tier 4 (documented)** — ADR exists; enforcement relies on reviewer attention. Acceptable only when Tiers 1-3 are genuinely impossible.

Distribution across 16 canonical ADRs as of W1 audit: Tier-1 = 2, Tier-2 = 1, Tier-3 = 5, Tier-4 = 8. Half of the canonical set is doc-only — largest systemic gap the agent+skill+gate initiative closes.

## References

- Audit: `/var/aqua-saas/docs/reviews/_audit/2026-04-W16-adr-drift-matrix.md` — full per-ADR enforcement analysis
- Plan: `/root/.claude/plans/declarative-riding-shamir.md` — BLOCKER-18 filled 5 phantom ADRs in W1.5
- CLAUDE.md — tier hierarchy definition + agent discipline
