# Sites Setup SSOT Remediation Review

## FARM-HIGH-003

The `/sites/setup*` surface is tenant-routed in several places, but it is not yet a single-source-of-truth implementation. Current code still exposes duplicate authorities and write paths that bypass the desired tenant transaction, audit, outbox, and typed frontend contract.

Validated evidence:

- `apps/farm-service/src/site/handlers/create-site.handler.ts:67` writes through a raw repository.
- `apps/farm-service/src/site/handlers/create-site.handler.ts:84` publishes directly through `eventBus.publish`.
- `apps/farm-service/src/equipment/handlers/create-equipment.handler.ts:382` saves tank-like equipment through the tank repository branch instead of a canonical Tank command.
- `apps/farm-service/src/worker/entities/worker.entity.ts:17` keeps `farm_workers` as an independent write model while HR `employees` already models farm workers.
- `web/modules/farm-module/src/pages/setup/tabs/FishHealthChemicalsTab.tsx:3` documents mock/local fish-health setup data.
- `apps/gateway-api/src/upload/upload.controller.ts:647` exposes path-based presign.
- `apps/farm-service/src/chemical/handlers/add-document.handler.ts:45` stores arbitrary document URLs into chemical JSONB.
- `web/modules/farm-module/src/hooks/useSites.ts:74` keeps raw setup GraphQL in hooks instead of generated operations.
- `libs/backend-common/src/database/schema-manager.service.ts:1951` still exposes tenant schema sync behavior that can create missing tenant tables.

Required remediation:

- Persist and follow `docs/plans/sites-setup-remediation/README.md`.
- Keep the Phase 1 owner/successor/runtime baseline inventory in `docs/plans/sites-setup-remediation/INVENTORY.md`.
- Keep Phase 2 schema authority anchored in `farm_documents`, `MODULE_SCHEMAS`, migration manifest parity, and fail-closed existing-tenant DDL repair.
- Convert setup business writes to tenant-pinned transactions with `tenantManagerRepo`, transaction-bound audit, and transactional outbox.
- Introduce canonical `farm_documents` and remove writable chemical/feed JSONB document authority.
- Cut workers to HR `employees`, fish-health substances to Chemical master, and tank-like writes to Tank commands.
- Replace raw frontend GraphQL and unsafe DTO casts with generated operations and typed mappers.
- Build dry-run/execute backfill tooling and removal gates before destructive legacy cleanup.

Closure criteria:

- All phase exit gates in the plan pass.
- `npm run findings:verify`, schema gates, codegen, targeted frontend/backend tests, and final core gates are recorded in the implementation PR.
- The closing commit carries `Closes: docs/reviews/farm-expert/2026-06-01-sites-setup-ssot-remediation.md#FARM-HIGH-003`.
