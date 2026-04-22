# Package 17: farm-service-as-any

## Metadata
Status: PENDING
Estimated Tokens: 18K
Priority: MEDIUM
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none

## Context
farm-service has 34 `as any` casts and 24 `as unknown as` casts in production code across 20+ files. CLAUDE.md forbids both patterns. Each cast is a potential tenant isolation bypass since the type system cannot verify tenant scoping through type-erased code paths. This is the largest concentration of type safety violations in a single service.

## Findings

**MEDIUM-004 [security-reviewer] (farm-service subset): 34 `as any` casts in farm-service production code**
- 20+ files affected (see Affected Files)
- Resolvers, handlers, and services across consumable, fish-health, feed, tank, batch, supplier, harvest, worker, feeding, growth, storage, species, maintenance, equipment domains

**MEDIUM-016 [multi-tenant-saas-expert] (farm-service subset): 24 `as unknown as` casts in farm-service**
- 17 files affected
- Concentrated in equipment, site, department, batch, feeding domains

Closing-Findings: [MEDIUM-004-farm, MEDIUM-016-farm]
Source-Reviews:
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md
- docs/reviews/context-manager/2026-04-09-tier1-compaction.md

## Affected Files (as any — production code only)
- `/var/aqua-saas/apps/farm-service/src/consumable/consumable.resolver.ts`
- `/var/aqua-saas/apps/farm-service/src/fish-health/resolvers/health-event.resolver.ts`
- `/var/aqua-saas/apps/farm-service/src/feed/feeding-protocol.resolver.ts`
- `/var/aqua-saas/apps/farm-service/src/feed/handlers/update-feed.handler.ts`
- `/var/aqua-saas/apps/farm-service/src/tank/handlers/list-tanks.handler.ts`
- `/var/aqua-saas/apps/farm-service/src/batch/query-handlers/list-batches.handler.ts`
- `/var/aqua-saas/apps/farm-service/src/supplier/handlers/update-supplier.handler.ts`
- `/var/aqua-saas/apps/farm-service/src/harvest/handlers/list-harvests.handler.ts`
- `/var/aqua-saas/apps/farm-service/src/system/system.resolver.ts`
- `/var/aqua-saas/apps/farm-service/src/worker/worker.resolver.ts`
- `/var/aqua-saas/apps/farm-service/src/feeding/query-handlers/get-feeding-records.handler.ts`
- `/var/aqua-saas/apps/farm-service/src/growth/query-handlers/get-growth-measurements.handler.ts`
- `/var/aqua-saas/apps/farm-service/src/storage/handlers/record-stock-movement.handler.ts`
- `/var/aqua-saas/apps/farm-service/src/storage/commands/update-storage-location.command.ts`
- `/var/aqua-saas/apps/farm-service/src/species/handlers/list-species.handler.ts`
- `/var/aqua-saas/apps/farm-service/src/maintenance/services/maintenance-schedule.service.ts`
- `/var/aqua-saas/apps/farm-service/src/maintenance/services/work-order.service.ts`
- `/var/aqua-saas/apps/farm-service/src/equipment/dataloaders/feed-selection.dataloader.ts`
- `/var/aqua-saas/apps/farm-service/src/equipment/handlers/list-equipment.handler.ts`
- `/var/aqua-saas/apps/farm-service/src/equipment/handlers/update-equipment.handler.ts`

## Affected Files (as unknown as — production code only)
- `/var/aqua-saas/apps/farm-service/src/water-quality/water-quality.service.ts`
- `/var/aqua-saas/apps/farm-service/src/feed/feeding-protocol.resolver.ts`
- `/var/aqua-saas/apps/farm-service/src/batch/utils/tank-lookup.util.ts`
- `/var/aqua-saas/apps/farm-service/src/system/handlers/get-system-delete-preview.handler.ts`
- `/var/aqua-saas/apps/farm-service/src/feeding/entities/feeding-program-tank.entity.ts`
- `/var/aqua-saas/apps/farm-service/src/site/handlers/get-site.handler.ts`
- `/var/aqua-saas/apps/farm-service/src/site/handlers/get-site-delete-preview.handler.ts`
- `/var/aqua-saas/apps/farm-service/src/site/handlers/delete-site.handler.ts`
- `/var/aqua-saas/apps/farm-service/src/equipment/handlers/update-sub-equipment.handler.ts`
- `/var/aqua-saas/apps/farm-service/src/equipment/handlers/create-equipment.handler.ts`
- `/var/aqua-saas/apps/farm-service/src/equipment/handlers/get-equipment-delete-preview.handler.ts`
- `/var/aqua-saas/apps/farm-service/src/equipment/handlers/update-equipment.handler.ts`
- `/var/aqua-saas/apps/farm-service/src/equipment/sub-equipment.resolver.ts`
- `/var/aqua-saas/apps/farm-service/src/equipment/equipment.resolver.ts`
- `/var/aqua-saas/apps/farm-service/src/department/handlers/get-department.handler.ts`
- `/var/aqua-saas/apps/farm-service/src/department/handlers/delete-department.handler.ts`
- `/var/aqua-saas/apps/farm-service/src/department/handlers/get-department-delete-preview.handler.ts`

## Dependencies
None. Type fixes are internal to farm-service.

Note: 58 total casts across 30+ files. Executor should process files by domain directory (equipment, site, department, feeding, etc.) in sequence. Each domain cluster is ~5-8 files. If the session runs long, split at a domain boundary.

## Atomic Commit Plan
```
refactor(farm): remove 34 as any and 24 as unknown as casts

Replace all type-unsafe casts with proper type definitions, generics,
or interface fixes. Each cast bypasses TypeScript's type system — the
first line of defense against tenant isolation bugs in a multi-tenant
aquaculture platform.

Approach per cast type:
- as any on TypeORM query results: add proper generic to repository call
- as any on GraphQL resolver args: type the @Args() decorator correctly
- as unknown as on handler return types: fix the handler interface
- as unknown as on entity relations: add proper relation typing

Plan: docs/plans/2026-04-09-full-remediation/packages/17-farm-service-as-any.md

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MEDIUM-004
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MEDIUM-016
```

## Test Plan
- Verify compilation: `npx tsc --noEmit -p apps/farm-service/tsconfig.json`
- Run farm-service tests: `npx jest --testPathPattern="apps/farm-service" --coverage=false`
- Grep to confirm zero `as any` and zero `as unknown as` in farm-service production code

## Verification Command
`npx tsc --noEmit -p apps/farm-service/tsconfig.json && npx jest --testPathPattern="apps/farm-service" --coverage=false`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
