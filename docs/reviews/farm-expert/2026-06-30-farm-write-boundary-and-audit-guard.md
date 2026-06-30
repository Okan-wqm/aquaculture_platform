# Farm /sites/setup CRUD — write-boundary + audit-guard incident (2026-06-30)

Live investigation of "cannot add/edit records in /sites/setup". Reads were already fixed
(read-boundary migration); these are the WRITE-side root causes, found by probing the
production droplet (test tenant `7f6b08ab…`). Operator invariant confirmed: tenant modules
(farm/hr/sensor/hydroponics) write per-tenant data to the tenant schema, never the source
schema; cross-tenant infrastructure (outbox, audit ledger) lives in the source schema,
tenantId-stamped + RLS-protected.

## FARM-CRITICAL-061 — source-write guard wrongly installed on `farm.farm_audit_logs` (RESOLVED)
A `guard_source_write` BEFORE-trigger (function `farm.block_source_writes()`, ERRCODE P0999)
sat on `farm.farm_audit_logs` — a cross-tenant infrastructure ledger (like `farm.outbox_events`,
which is correctly unguarded). Every create/update command handler writes an audit row there,
so the guard rejected the INSERT and broke **all** farm mutations behind a masked "Bad Request".
The trigger is legacy drift (not created by any current migration).
**Fix:** live `DROP TRIGGER guard_source_write ON farm.farm_audit_logs` (operator-approved) +
durable forward migration `1801600000000-DropAuditLedgerSourceWriteGuard.ts` (idempotent).

## FARM-HIGH-089 — write-boundary: /sites/setup handlers wrote to the source schema (RESOLVED for setup domains)
43 of 92 farm command handlers wrote via pooled `@InjectRepository` connections whose
search_path defaulted to the source `farm` schema → guard-blocked (this is also why
suppliers/consumables/species read empty: writes were silently mis-routed pre-guard).
**Fix (this PR):** the 5 setup-tab domains — consumable, supplier, chemical, species, feed
(create/update/delete; chemical also add/remove-document), plus worker update/delete and the
fish-health `create` — now wrap their writes in `runInTenantTransaction` + `tenantManagerRepo`,
mirroring the gold `CreateSiteHandler`. (chemical-create's inner non-tenant `manager.transaction`
was collapsed into the boundary.)

## FARM-HIGH-090 — enum `defaultValue` breaks @nestjs/graphql coercion → createTank (RESOLVED for tank)
`@Field(() => Enum, { defaultValue: EnumMember })` on an INPUT field makes the raw uppercase
KEY reach `@IsEnum` (which validates the lowercase VALUE) → every client-supplied enum is
rejected at the ValidationPipe. **Fix (this PR):** `create-tank.dto.ts` tankType/material/
waterType/status drop `defaultValue`, become `@IsOptional`, and `CreateTankHandler` applies the
defaults server-side.

## FARM-HIGH-091 — createHealthEvent rejected by `reportedBy` @IsUUID (RESOLVED)
The frontend sends `reportedBy:'current-user'`; `CreateHealthEventInput.reportedBy` was a
required `@IsUUID`, rejected at the ValidationPipe before the service (which already overrides
`reportedBy` from the JWT subject) could run. **Fix (this PR):** field made optional + format
constraint dropped; server remains authoritative. Service `create` also moved into the tenant
write boundary.

## Deferred (tracked)
- **ORPHAN-HIGH-251** — write-boundary for the remaining ~30 handlers: storage (~13), batch,
  growth, water-quality, fish-health update/delete/treatment. Same `runInTenantTransaction`
  transform. Owner: farm-expert. Deadline: 2026-07-14.
- **ORPHAN-HIGH-090b** — enum `defaultValue` coercion also affects feeding + water-quality
  create-DTOs (create-feeding-protocol/table/record/program, create-feed-inventory,
  create-batch-water-quality); fix with their write-boundary work. Owner: farm-expert. Deadline: 2026-07-14.
- **ORPHAN-MEDIUM-255** — `EMPLOYEE_PII_BLIND_INDEX_KEY` (32-byte/64-hex HMAC) not set on the
  deployed farm-service → createWorker fails; set the secret in the droplet env. Owner: infra.
  Deadline: 2026-07-07.
