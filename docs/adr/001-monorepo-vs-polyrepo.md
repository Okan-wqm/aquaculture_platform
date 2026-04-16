# ADR-001: Nx Monorepo Over Polyrepo

**Status:** Accepted (retrodocumented 2026-04-16 during W1 audit of agent+skill+gate initiative)
**Supersedes:** none
**Context note:** this file was 0 bytes until W1 audit flagged it as a phantom canonical ADR. Content below reflects the repository's observable reality and crystallises the decisions already in force.

## Context

The aquaculture platform spans 16 NestJS backend services, 7 React microfrontends plus a shell + shared UI library, 3 platform libraries, 10 shared libraries, and a Rust edge gateway — a heterogeneous, polyglot surface. Choices exist:

1. **Polyrepo** — one git repository per service or per frontend module, linked by package registries and contract tests.
2. **Monorepo with workspace tooling** — Nx as the source-of-truth workspace graph + task runner, with transitive build/test affected detection.
3. **Hybrid** — a single app-repo plus independent library-repos.

The platform's cross-service concerns — event contracts (`libs/event-contracts`), tenant context (`libs/backend-common`), schema invariants (`e2e/tests/integration/*-invariants.spec.ts`), and multi-tenant RLS policies — are updated atomically across multiple services per change. Every such update under polyrepo requires a version-bump dance across N package registries with a corresponding window of contract drift. The cost-per-change of polyrepo grows quadratically with the number of services that must move in lockstep.

## Decision

Adopt an Nx monorepo as the single source of truth for all first-party code.

- `nx.json` declares project graph conventions; `@nx/workspace` 22.3.3 is the task runner.
- Per-project `project.json` files own their build/test/lint targets; root `package.json` owns shared deps.
- `nx affected --target=test --target=lint` is the only CI gate for partial-graph runs; full-graph runs exist for nightly invariant sweeps and release pipelines.
- Every cross-cutting concern (event contract, migration, schema-owning entity, CODEOWNERS path) lives in one file + one PR, reviewed and merged atomically.
- Polyglot boundaries (Rust edge gateway at `sens-api-gateway/`, Python generators at `scripts/nats/*.py`) are tolerated inside the same repo; Nx delegates those targets to their native build tools (`cargo`, `python -m`).

## Consequences

**Positive:**
- Cross-service contract changes ship in one atomic PR (e.g. adding a field to `BaseEvent` + its 12 consumers).
- `nx affected` scopes CI cost to changed subgraph while retaining full-graph invariants on demand.
- IDE "go to definition" works across services; no private registry hop.
- Ownership gates are expressible via a single `.github/CODEOWNERS` file (per BLOCKER-9 W0 work).

**Negative:**
- Repository size + clone time grow with tenure; partial-clone / sparse-checkout strategies are on the backlog for new contributors.
- Non-Nx tooling (terraform, helm, ad-hoc Python scripts) must be manually integrated with `nx affected` or skipped — drift risk.
- A faulty merge to `main` can cascade across multiple services at once; branch protection + CODEOWNERS must gate that risk (tracked in BLOCKER-9).
- W1 audit surfaced one specific gap: the Rust crate at `sens-api-gateway/` is not in the Nx graph, allowing commit-level drift (EDGE-CRITICAL-001 — HEAD does not compile) to escape `nx affected` gating. Fix scheduled W2 Day 1.

## References

- `nx.json` — workspace graph config
- `tsconfig.base.json` — monorepo-wide TS path map
- `.github/workflows/ci-affected.yml` — nx-affected-driven CI pipeline
- `/root/.claude/plans/declarative-riding-shamir.md` — agent+skill+gate initiative; W1 audit is how this ADR was recovered from 0 bytes
