# Professional E2E Review Methodology

## Topic

Enterprise-grade end-to-end review methodology for a multi-tenant web and mobile SaaS platform where every meaningful product action must be traced across UI, API, persistence, read-back, visibility, authorization, and tenant isolation.

## Sources

- Playwright Best Practices, accessed 2026-04-11: https://playwright.dev/docs/best-practices
- Playwright Locators, accessed 2026-04-11: https://playwright.dev/docs/locators
- Playwright Visual comparisons, accessed 2026-04-11: https://playwright.dev/docs/next/test-snapshots
- Cypress Best Practices, accessed 2026-04-11: https://docs.cypress.io/app/core-concepts/best-practices
- Cypress Testing Types, accessed 2026-04-11: https://docs.cypress.io/app/core-concepts/testing-types
- Testing Library Guiding Principles, accessed 2026-04-11: https://testing-library.com/docs/guiding-principles
- Testing Library About Queries, accessed 2026-04-11: https://testing-library.com/docs/queries/about
- OWASP Web Security Testing Guide Introduction / Balanced Approach, accessed 2026-04-11: https://owasp.org/www-project-web-security-testing-guide/stable/2-Introduction/README
- Pact Provider Verification / Consumer-Driven Contract Process, accessed 2026-04-11: https://docs.pact.io/implementation_guides/go/docs/provider
- Chrome Workbox Background Sync reference, accessed 2026-04-11: https://developer.chrome.com/docs/workbox/reference/workbox-background-sync
- OWASP MASTG Runtime Storage of Unencrypted Data in the App Sandbox, accessed 2026-04-11: https://mas.owasp.org/MASTG/tests/android/MASVS-STORAGE/MASTG-TEST-0207/
- OWASP MASTG Local Storage / trigger all possible functionality guidance, accessed 2026-04-11: https://mas.owasp.org/MASTG/tests/android/MASVS-STORAGE/MASTG-TEST-0001/

## Key Findings

1. Professional testing is a balanced program, not a single technique.
   OWASP explicitly frames effective testing as a balanced approach spanning manual reviews, source review, technical testing, and CI/CD-integrated checks. Pure penetration testing is too late and too incomplete on its own.

2. End-to-end review should validate user-visible behavior, not implementation trivia.
   Playwright and Testing Library both emphasize testing what users see and do. Professional review therefore starts from pages, dialogs, buttons, forms, tables, charts, search boxes, and mobile interaction surfaces.

3. Isolation and controlled state are mandatory.
   Playwright and Cypress both stress that tests should run independently and against controlled state. For this repo that means tenant-safe fixtures, deterministic records, and explicit control over database and cache state.

4. Selector strategy is part of review methodology.
   Playwright recommends resilient user-facing locators; Cypress recommends `data-*` contracts rather than brittle CSS selectors; Testing Library recommends semantic queries first. A professional audit should therefore review whether the UI even exposes stable, accessible selection contracts for automation.

5. Professional E2E coverage is broader than browser-click tests.
   Cypress explicitly distinguishes E2E from component/API/visual/accessibility testing and recommends a mix. For this repo, "every button works" requires complementary checks for contracts, visual surfaces, background jobs, and authorization.

6. Visual verification matters for charts, widgets, and dashboards.
   Playwright visual comparisons formalize screenshot baselines. For KPI cards, graphs, tables, and dashboards, professional review should verify both data correctness and rendered visibility, not only API success.

7. Offline and retry behavior must be treated as a first-class data path.
   Workbox Background Sync and OWASP MASTG both imply that failed requests, local storage, and replay queues require explicit inspection. For AquaMobil, offline drafts, replay queues, and cached views are part of the roundtrip, not a side note.

8. Contract testing belongs at service boundaries.
   Pact documents the consumer-driven contract flow: consumer expectation -> shared contract -> provider verification. Professional review must therefore verify not only UI against API, but also boundary agreements between consumers and providers.

9. Storage analysis requires exercising all workflows.
   OWASP MASTG explicitly advises triggering all possible functionality and then diffing storage. That directly supports adding dedicated auditors for mobile local state, offline queues, and hidden persisted data.

10. End-to-end confidence depends on two-way parity.
    In large SaaS systems, defects occur in both directions:
    - UI fields/actions with no durable backend or DB counterpart
    - database tables/columns/entities with no user-visible read path, edit path, or operational surfacing
    Professional review therefore needs a dedicated schema-to-surface parity pass.

## Security Concerns

- Cross-tenant data exposure can arise in browser cache, mobile offline storage, background sync queues, SSE/live streams, tables, charts, exports, and detail views.
- False-success UX is a security issue when destructive or privileged actions appear successful without backend confirmation.
- File import/export and attachment flows can leak sensitive data or bypass authorization if tenant, role, and object ownership are not traced end to end.
- Mobile local storage, IndexedDB, service worker queues, and app sandbox writes are security-relevant storage, not mere UX implementation details.

## Performance Concerns

- Professional E2E review should avoid arbitrary waits and instead require explicit readiness or retry-aware assertions.
- Realtime and polling surfaces need bounded refresh contracts; otherwise tests and product behavior both become flaky.
- Visual snapshot suites need controlled environments to avoid noise.
- Large-table and dashboard views require pagination, filtering, aggregation, and cache invalidation checks to avoid stale or misleading operator views.

## Architectural Implications

- The agent set must not collapse all E2E work into one generic form auditor.
- Separate ownership is needed for:
  - UI action inventory
  - button/action execution
  - form write path
  - DB/API read-back
  - schema-to-surface parity
  - access boundaries
  - list/table surfaces
  - chart/widget/dashboard surfaces
  - file transfer flows
  - realtime and sync flows
  - workflow state transitions
  - tenant isolation
  - mobile offline/reconnect behavior
- Every finding should be traceable as a full path:
  `surface -> interaction -> payload -> boundary -> persistence -> read model -> visible surface`
- Professional review should classify blind spots, not just broken happy paths:
  - orphan UI surfaces
  - orphan DB/data surfaces
  - invisible but persisted data
  - visible but non-persisted data
  - wrong-scope live updates

## Domain Rule Additions

- Add a dedicated auditor for UI-to-DB / DB-to-UI parity gaps.
- Add a dedicated auditor for table/grid behavior: columns, sorting, filtering, pagination, bulk actions, row actions, and export visibility.
- Add a dedicated auditor for charts/widgets/KPI surfaces to verify aggregation, labels, units, drill-down consistency, and visual truth.
- Add a dedicated auditor for file transfer paths: upload, import, export, attachment, preview, and download.
- Add a dedicated auditor for realtime paths: polling, SSE, websocket-like flows, sync status, notification refresh, and job progress.
- Add a dedicated auditor for access boundaries: guards, roles, permissions, impersonation, feature flags, and mobile permissions.
- Require mobile auditors to inspect offline queue and persisted storage as a formal review step.
- Require orchestrator output to explicitly classify each gap as one or more of:
  - write-gap
  - read-gap
  - visibility-gap
  - schema-gap
  - access-gap
  - sync-gap
  - tenant-gap
