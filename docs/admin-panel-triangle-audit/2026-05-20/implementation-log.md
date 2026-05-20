# Implementation Log - 2026-05-20

## Fixed

- Added canonical admin route constants and replaced stale dashboard/report links.
- Changed sidebar active matching so leaf routes require exact matches and parent routes handle descendants.
- Added canonical analytics `range` and `granularity` response shape with `{ range, granularity, data, source, asOf }`.
- Wired tenant growth, revenue trend, and DAU to real backend time-series responses.
- Added partial analytics degraded-state display using backend `unavailable` sources.
- Added authenticated blob download support in the admin frontend HTTP client.
- Moved blob download into a typed admin-panel `blob-client` so JSON request handling and binary artifact handling stay separate.
- Reworked reports page to load persisted execution history, create executions through `POST /reports/executions`, and download artifacts through authenticated fetch.
- Removed Excel from report UI and report API format contracts until real XLSX generation exists.
- Added durable report artifact metadata on `admin.report_executions` and MinIO-backed artifact storage.
- Changed report downloads to read stored artifacts and verify SHA-256; no Redis regeneration fallback remains.
- Hardened CSV generation with full quoting and formula-injection prefixing.
- Added scheduled daily analytics snapshots and idempotent snapshot writes.
- Added migration for report artifact columns and unique daily snapshot identity.
- Restricted admin-api guard and role helper decorators to the platform admin actor. Code-level role remains `SUPER_ADMIN` because auth-service currently stores platform admins with that role.
- Enforced access-token type in admin-api guard before role checks.
- Updated request context from verified JWT claims before RLS bypass execution.
- Changed platform metrics table counts to schema-qualified allowlisted targets.
- Fixed the changed-file type-check CI wrapper so package-provided type libraries such as `vite/client` are still visible.
- Cleaned the touched admin-api/admin-panel files for strict typed lint: raw SQL rows are typed, async React handlers are bound with `void`, report values avoid `[object Object]`, and form labels are associated with controls.
