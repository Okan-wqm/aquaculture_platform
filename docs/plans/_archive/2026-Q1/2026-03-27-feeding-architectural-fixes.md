# Feeding Page Architectural Fixes

**Goal:** Fix 3 architectural issues in feeding module with enterprise-grade solutions (not patches).

**Issues:**
1. `UpdateFeedingRecordHandler` — no transaction wrapping (data integrity risk)
2. Currency default hardcoded `TRY` in backend vs `NOK` in frontend
3. `isBelowPlan`/`isVarianceAcceptable` entity methods not exposed via GraphQL `@Field`

---

## Task 1: Transaction Safety — UpdateFeedingRecordHandler

**Problem:** `CreateFeedingRecordHandler` uses QueryRunner + transaction (correct), but `UpdateFeedingRecordHandler` does `feedingRecordRepository.save()` + `batchRepository.save()` as two separate operations without a transaction. If the batch update fails, the feeding record is already saved with inconsistent batch totals.

**Solution:** Add QueryRunner-based transaction to UpdateFeedingRecordHandler, matching the pattern from CreateFeedingRecordHandler.

**Files:**
- Modify: `apps/farm-service/src/feeding/handlers/update-feeding-record.handler.ts`

## Task 2: Computed GraphQL Fields — isBelowPlan / isVarianceAcceptable

**Problem:** `FeedingRecord` entity has `isBelowPlan()` and `isVarianceAcceptable()` as class methods, but these have no `@Field()` decorator. The frontend GraphQL fragment requests these as fields, but they come back as undefined/null because NestJS GraphQL only serializes `@Field`-decorated properties.

**Solution:** Add `@ResolveField()` methods to `FeedingResolver` that call the entity methods. This is the proper NestJS/GraphQL pattern — entity business logic stays in entity, GraphQL exposure stays in resolver.

**Files:**
- Modify: `apps/farm-service/src/feeding/resolvers/feeding.resolver.ts`

## Task 3: Currency Default Unification

**Problem:** `CreateFeedingRecordHandler` defaults currency to `'TRY'` (line 105). Frontend form defaults to `'NOK'`. This creates inconsistency when currency is not explicitly set.

**Solution:** Use `'NOK'` as the platform default (Norwegian aquaculture platform). Both backend and frontend should agree. Ideally this would come from tenant config, but for now unify the hardcoded default.

**Files:**
- Modify: `apps/farm-service/src/feeding/handlers/create-feeding-record.handler.ts` (line 105: change `'TRY'` → `'NOK'`)
