# Deferred Farm-Module Items — Architectural Plans (2026-04-24)

Three parallel Plan-agent runs produced detailed implementation plans for the
big-ticket items that were kept out of the session-long blind-spot sweep
because each needs either:

- destructive DB operations with backup / rollback discipline, OR
- a cross-service coordination / infra decision (npm install, sidecar, federated
  schema), OR
- a distinct frontend scope with its own test harness.

Each plan is self-contained — the reader of the execution session can pick up
from any phase without re-discovering context. Every phase carries:

- explicit file paths (new / edit / delete)
- validation + audit + test requirements per the standing rules
- risk + rollback
- approximate LOC / PR count
- pre-registered findings (`FARM-*-NNN`, `INFRA-*-NNN`, `FE-*-NNN`) to close
- sequencing with hard and soft dependencies
- open questions framed as concrete A/B choices

The three plans are:

1. **[scope-a-legacy-migrations.md](./scope-a-legacy-migrations.md)** —
   Phase 4.3 legacy `farm.farms` / `farm.ponds` → `farm.sites` / `farm.tanks`
   migration, PLUS Phase 4.4 orphan-entity cleanup (`supplier_sites`,
   `site_contacts`). 7 phases, ~10 PRs, ~3800 LOC. Includes dry-run CLI,
   90-day retention window cutover, and an explicit WIRE-don't-drop decision
   for the orphan entities grounded in `docs/illustrator/farm-modulu-sema-gorsel.md`.

2. **[scope-b-infrastructure.md](./scope-b-infrastructure.md)** —
   Phase 7.4 sensor-service federation + Phase 7.1 backend i18n +
   Phase 6.2.2 ClamAV async virus scan. 25 PRs, ~7600 LOC, ~6 months work
   with a single implementer. Includes a critical prerequisite Phase V0
   (route existing upload call sites through `FileUploadSecurityService`
   before virus scanning matters) that was missing from the original brief.

3. **[scope-c-frontend.md](./scope-c-frontend.md)** —
   Phase 3 Tier 2/3 + Sub-Equipment CRUD + Admin-Only UI. 10 PRs,
   ~3300 LOC. Investigation surfaced 13 stack realities that invalidate
   the original brief — canonical farm-module pattern is React Query +
   `graphql-request` + `useState`/`useMemo` validation, NOT Apollo +
   RHF + zod. Plan also catches that all 4 Tier 1 modals are **orphaned**
   (implemented but never imported by any page) and the batch-detail
   route is a dead link — both are blockers for Tier 2 work.

# Execution order (proposed)

The user's standing directive is architectural-solution-first, no patches,
every PR validation+audit+test. Within that:

- **Scope A Phase 4.3.0** (event contracts + inventory CSV, zero-risk
  read-only) is the smallest first step. Lands the events in the contract
  library and the per-tenant row inventory as a committed artefact.

- **Scope C PR-0** (shared infra: `ConfirmDialog`, `useCanMutate` matrix,
  `useErrorMessage` map, `BatchDetailPage` route) unblocks 9 downstream
  frontend PRs. Also closes two pre-existing HIGH findings (orphaned Tier 1
  modals; dead-link navigation).

- **Scope B Phase V0** (route call sites through `FileUploadSecurityService`)
  is the prerequisite for every virus-scan phase.

Parallelism: Scope A 4.3.0, Scope C PR-0, and Scope B V0 are fully
independent and can land in any order / in parallel sessions.

# Change log

- 2026-04-24 — Initial plans landed. Three parallel Plan-agent runs.
