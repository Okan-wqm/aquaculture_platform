# Farm Module 78 Bulgu Düzeltme Planı

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking. Agent'lar arası bağımlılıklar Phase numaralarıyla belirtilmiştir — bir Phase'deki tüm task'lar tamamlanmadan sonraki Phase başlamamalıdır.

**Goal:** Farm module review'da tespit edilen 78 bulgudan kod düzeyinde çözülebilir ~50 tanesini 6 fazda koordineli şekilde düzeltmek.

**Architecture:** Fazlar bağımlılık sırasına göre dizilmiştir: Foundation → Security → Data Integrity → Events → Frontend → Architecture. Her faz içindeki task'lar birbirinden bağımsızdır ve paralel çalıştırılabilir.

**Tech Stack:** NestJS, TypeORM, GraphQL (Apollo Federation v2), React, TanStack Query, NATS JetStream

**Spec:** `docs/farm-module-review-2026-03-16.md`

---

## Bağımlılık Haritası

```
Phase 1: Foundation (bağımsız)
    ├── Task 1: DATABASE_SYNC fix
    ├── Task 2: sortOrder utility
    └── Task 3: getTenantSchemaName utility

Phase 2: Security (Phase 1'e bağımlı)
    ├── Task 4: feeding.resolver.ts güvenlik fix (Task 3'e bağımlı)
    ├── Task 5: growth.resolver.ts güvenlik fix
    ├── Task 6: GqlAuthGuard → Global TenantGuard (bağımsız)
    ├── Task 7: RBAC @Roles ekleme Grup A (Task 6'ya bağımlı)
    └── Task 8: RBAC @Roles ekleme Grup B (Task 6'ya bağımlı)

Phase 3: Data Integrity (Phase 2'ye bağımlı)
    ├── Task 9: Transaction — cleaner fish handlers (5 handler)
    ├── Task 10: Transaction — diğer handlers (3 handler)
    ├── Task 11: Bug fix — storage overview + entity type fixes
    └── Task 12: Withdrawal period enforcement

Phase 4: Events (Phase 3'e bağımlı)
    ├── Task 13: NATS ↔ EventEmitter2 köprüsü
    ├── Task 14: Eksik event emission ekleme
    └── Task 15: Event payload standardizasyonu

Phase 5: Frontend (Phase 2'ye bağımlı — API imzaları değişiyor)
    ├── Task 16: Enum uyumsuzlukları fix
    ├── Task 17: Query key tenant tutarlılığı
    ├── Task 18: Routing bug fix + orphan cleanup
    └── Task 19: Error handling ekleme

Phase 6: Architecture (Phase 1-5 tamamlandıktan sonra)
    ├── Task 20: CqrsModule standardizasyonu
    ├── Task 21: EventEmitter duplicate fix + orphan code cleanup
    ├── Task 22: Performance — getManyAndCount + SQL aggregates
    └── Task 23: Lookup table schema fix
```

---

## Phase 1: Foundation

### Task 1: DATABASE_SYNC Production Fix

**Bulgu:** #2.5 (CRITICAL) — Production'da DATABASE_SYNC=true
**Files:**
- Modify: `infrastructure/docker/docker-compose.prod.yml`
- Modify: `docker-compose.droplet.yml`

- [ ] **Step 1:** Her iki dosyada `DATABASE_SYNC` değerini ara. Tüm servislerde (sadece farm değil) `true` olanları `false` yap.

```yaml
# ARCH-DB-001: Production'da TypeORM synchronize kapalı — migration kullanılmalı
DATABASE_SYNC: "false"
```

- [ ] **Step 2:** Değişiklikleri doğrula: `grep -n "DATABASE_SYNC" infrastructure/docker/docker-compose.prod.yml docker-compose.droplet.yml`
- [ ] **Step 3:** Commit: `git commit -m "fix(infra): disable DATABASE_SYNC in production compose files"`

---

### Task 2: sortOrder Validation Utility

**Bulgu:** #1.5 (HIGH) — sortOrder SQL injection riski
**Files:**
- Modify: `apps/farm-service/src/batch/query-handlers/list-batches.handler.ts`
- Modify: `apps/farm-service/src/tank/handlers/list-tanks.handler.ts`
- Modify: `apps/farm-service/src/species/handlers/list-species.handler.ts`
- Modify: `apps/farm-service/src/harvest/handlers/list-harvests.handler.ts`
- Modify: `apps/farm-service/src/feeding/query-handlers/get-feeding-records.handler.ts`
- Modify: `apps/farm-service/src/growth/query-handlers/get-growth-measurements.handler.ts`

- [ ] **Step 1:** Her handler dosyasında `queryBuilder.orderBy(` satırını bul.
- [ ] **Step 2:** `orderBy` çağrısından ÖNCE şu validasyonu ekle:

```typescript
const safeSortOrder: 'ASC' | 'DESC' =
  sortOrder?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
```

- [ ] **Step 3:** `orderBy` çağrısında `sortOrder` yerine `safeSortOrder` kullan.
- [ ] **Step 4:** Commit: `git commit -m "fix(farm): add sortOrder whitelist validation to prevent SQL injection"`

---

### Task 3: getTenantSchemaName Utility Kontrolü

**Bulgu:** #1.2 (CRITICAL) — schemaName client'tan alınıyor
**Files:**
- Read: `apps/farm-service/src/middleware/tenant-schema.middleware.ts`

- [ ] **Step 1:** `getTenantSchemaName` veya `sanitizeSchemaName` fonksiyonunu ara. Nasıl export edildiğini ve formülünü not et. Eğer utility yoksa Task 4'te inline hesaplama kullanılacak.

```bash
grep -rn "getTenantSchemaName\|sanitizeSchemaName" apps/farm-service/src/
```

- [ ] **Step 2:** Bu fonksiyonun import path'ini not et (Task 4 ve 5 bunu kullanacak).

---

## Phase 2: Security

### Task 4: Feeding Resolver Güvenlik Fix

**Bulgu:** #1.1, #1.2, #3.1 (CRITICAL) — tenantId/userId/schemaName client'tan, 1000 kayıt sorgusu
**Files:**
- Modify: `apps/farm-service/src/feeding/resolvers/feeding.resolver.ts`
**Depends on:** Task 3

- [ ] **Step 1:** Dosyanın başındaki import'lara `@CurrentTenant()` ve `@CurrentUser()` decorator'larını ekle. Referans: `apps/farm-service/src/storage/storage.resolver.ts` nasıl import ediyorsa aynı şekilde.

- [ ] **Step 2:** Tüm `@Args('tenantId', { type: () => ID }) tenantId: string` parametrelerini `@CurrentTenant() tenantId: string` ile değiştir. `grep -n "Args.*tenantId" feeding.resolver.ts` ile tüm yerleri bul.

- [ ] **Step 3:** Tüm `@Args('userId', { type: () => ID }) userId: string` parametrelerini `@CurrentUser('sub') userId: string` ile değiştir.

- [ ] **Step 4:** Tüm `@Args('schemaName') schemaName: string` parametrelerini kaldır. Yerine metot gövdesinin başına ekle:

```typescript
const schemaName = `tenant_${tenantId.replace(/-/g, '').substring(0, 16).toLowerCase()}`;
```

- [ ] **Step 5:** `feedingRecord` query'sini düzelt (~satır 791): 1000 kayıt çekip JS find yerine:

```typescript
const record = await this.feedingRecordRepository.findOne({
  where: { id, tenantId },
});
return record || null;
```

Eğer `feedingRecordRepository` inject edilmemişse, mevcut CQRS pattern'ine uygun alternatif kullan.

- [ ] **Step 6:** `growthMeasurement` query'si de aynı pattern'deyse düzelt.
- [ ] **Step 7:** Build kontrolü: `npx nx build farm-service --skip-nx-cache 2>&1 | tail -20`
- [ ] **Step 8:** Commit: `git commit -m "fix(farm/feeding): replace client-side tenantId/userId/schemaName with server-side decorators"`

---

### Task 5: Growth Resolver Güvenlik Fix

**Bulgu:** #1.1 (CRITICAL) — tenantId/userId client'tan
**Files:**
- Modify: `apps/farm-service/src/growth/resolvers/growth.resolver.ts`

- [ ] **Step 1-4:** Task 4'teki Step 1-4 ile aynı pattern: `@Args('tenantId')` → `@CurrentTenant()`, `@Args('userId')` → `@CurrentUser('sub')`.
- [ ] **Step 5:** growthMeasurement query'si 1000 kayıt çekiyorsa düzelt (Task 4 Step 5 pattern'i).
- [ ] **Step 6:** Build kontrolü + Commit: `git commit -m "fix(farm/growth): replace client-side tenantId/userId with server-side decorators"`

---

### Task 6: GqlAuthGuard Kaldırma

**Bulgu:** #1.3 (HIGH) — Guard tutarsızlığı
**Files (13 resolver):**
- `apps/farm-service/src/feeding/resolvers/feeding.resolver.ts` (Task 4 zaten değiştirecek — sadece guard satırı)
- `apps/farm-service/src/feeding/resolvers/feeding-program.resolver.ts`
- `apps/farm-service/src/growth/resolvers/growth.resolver.ts` (Task 5 zaten değiştirecek)
- `apps/farm-service/src/farm/resolvers/farm.resolver.ts`
- `apps/farm-service/src/batch/resolvers/batch.resolver.ts`
- `apps/farm-service/src/batch/resolvers/cleaner-fish.resolver.ts`
- `apps/farm-service/src/task/resolvers/task.resolver.ts`
- `apps/farm-service/src/task/resolvers/auto-rule.resolver.ts`
- `apps/farm-service/src/task/resolvers/recurring-template.resolver.ts`
- `apps/farm-service/src/regulatory/regulatory.resolver.ts`
- `apps/farm-service/src/maintenance/resolvers/work-order.resolver.ts`
- `apps/farm-service/src/maintenance/resolvers/maintenance-schedule.resolver.ts`
- `apps/farm-service/src/maintenance/resolvers/spare-part.resolver.ts`

**NOT:** Task 4 ve Task 5 feeding.resolver.ts ve growth.resolver.ts'i zaten değiştiriyor. Bu task o dosyalardaki SADECE `@UseGuards(GqlAuthGuard)` satırını kaldırmalı. Task 4/5 tamamlandıktan SONRA çalışmalı.

- [ ] **Step 1:** `app.module.ts`'de global TenantGuard'ın APP_GUARD olarak kayıtlı olduğunu doğrula:

```bash
grep -A2 "APP_GUARD" apps/farm-service/src/app.module.ts
```

- [ ] **Step 2:** Global guard varsa, 13 resolver'daki `@UseGuards(GqlAuthGuard)` satırlarını kaldır. GqlAuthGuard import'unu da temizle.

**ÖNEMLİ:** `@UseGuards(GqlAuthGuard)` → tamamen kaldır (global TenantGuard zaten koruyuyor). `@UseGuards(TenantGuard)` olan resolver'lara DOKUNMA.

- [ ] **Step 3:** GqlAuthGuard'ın başka yerde kullanılıp kullanılmadığını kontrol et. Kullanılmıyorsa guard dosyasını da silebilirsin.
- [ ] **Step 4:** Build kontrolü + Commit: `git commit -m "fix(farm): remove redundant GqlAuthGuard from 13 resolvers — global TenantGuard covers all"`

---

### Task 7: RBAC @Roles Ekleme — Grup A

**Bulgu:** #1.4 (HIGH) — 15+ resolver'da @Roles yok
**Files:**
- `apps/farm-service/src/department/department.resolver.ts`
- `apps/farm-service/src/chemical/chemical.resolver.ts`
- `apps/farm-service/src/supplier/supplier.resolver.ts`
- `apps/farm-service/src/feed/feed.resolver.ts`
- `apps/farm-service/src/consumable/consumable.resolver.ts`
- `apps/farm-service/src/storage/storage.resolver.ts`
- `apps/farm-service/src/worker/worker.resolver.ts`

- [ ] **Step 1:** Her resolver'da mevcut `@Roles` kullanımına bak (species.resolver.ts veya tank.resolver.ts referans). Pattern'i kopyala.
- [ ] **Step 2:** Her resolver'daki CREATE/UPDATE/DELETE mutation'larına `@Roles('TENANT_ADMIN', 'MODULE_MANAGER')` ekle. Query'lere ekleme.
- [ ] **Step 3:** `Roles` decorator import'unu ekle (henüz yoksa).
- [ ] **Step 4:** Build kontrolü + Commit: `git commit -m "fix(farm): add @Roles to department/chemical/supplier/feed/consumable/storage/worker mutations"`

---

### Task 8: RBAC @Roles Ekleme — Grup B

**Files:**
- `apps/farm-service/src/water-quality/water-quality.resolver.ts`
- `apps/farm-service/src/fish-health/resolvers/health-event.resolver.ts`
- `apps/farm-service/src/system/system.resolver.ts`
- `apps/farm-service/src/sentinel-hub/sentinel-hub.resolver.ts`
- `apps/farm-service/src/maintenance/resolvers/work-order.resolver.ts`
- `apps/farm-service/src/maintenance/resolvers/maintenance-schedule.resolver.ts`
- `apps/farm-service/src/maintenance/resolvers/spare-part.resolver.ts`
- `apps/farm-service/src/task/resolvers/task.resolver.ts`
- `apps/farm-service/src/task/resolvers/auto-rule.resolver.ts`
- `apps/farm-service/src/task/resolvers/recurring-template.resolver.ts`

- [ ] **Step 1-4:** Task 7 ile aynı pattern. Her mutation'a `@Roles('TENANT_ADMIN', 'MODULE_MANAGER')` ekle. Task modülündeki mutation'larda MODULE_USER'a da izin verilebilir (createTask, updateTask gibi operasyonel işlemler).
- [ ] **Step 5:** Commit: `git commit -m "fix(farm): add @Roles to water-quality/health/system/maintenance/task mutations"`

---

## Phase 3: Data Integrity

### Task 9: Transaction — Cleaner Fish Handlers

**Bulgu:** #4.1 (CRITICAL) — 5 handler'da transaction yok
**Files:**
- `apps/farm-service/src/batch/handlers/record-cull.handler.ts`
- `apps/farm-service/src/batch/handlers/deploy-cleaner-fish.handler.ts`
- `apps/farm-service/src/batch/handlers/record-cleaner-mortality.handler.ts`
- `apps/farm-service/src/batch/handlers/remove-cleaner-fish.handler.ts`
- `apps/farm-service/src/batch/handlers/transfer-cleaner-fish.handler.ts`

**Gold standard referans:** `apps/farm-service/src/batch/handlers/allocate-to-tank.handler.ts` — bu handler SERIALIZABLE isolation + pessimistic_write lock kullanıyor.

- [ ] **Step 1:** `allocate-to-tank.handler.ts`'i oku. Transaction pattern'ini anla:

```typescript
const queryRunner = this.dataSource.createQueryRunner();
await queryRunner.connect();
await queryRunner.startTransaction('SERIALIZABLE');
try {
  // ... pessimistic lock ile entity fetch
  const batch = await queryRunner.manager.findOne(Batch, {
    where: { id: batchId },
    lock: { mode: 'pessimistic_write' },
  });
  // ... iş mantığı
  await queryRunner.commitTransaction();
} catch (error) {
  await queryRunner.rollbackTransaction();
  throw error;
} finally {
  await queryRunner.release();
}
```

- [ ] **Step 2:** Her 5 handler'da aynı pattern'i uygula:
  - `DataSource` inject et (henüz yoksa constructor'a ekle)
  - QueryRunner oluştur, bağlan, transaction başlat
  - Mevcut `this.xxxRepository.save()` çağrılarını `queryRunner.manager.save()` ile değiştir
  - Mevcut `this.xxxRepository.findOne()` çağrılarını `queryRunner.manager.findOne()` ile değiştir
  - Batch ve TankBatch fetch'lerinde `lock: { mode: 'pessimistic_write' }` ekle
  - try/catch/finally ile commit/rollback/release

- [ ] **Step 3:** Build kontrolü
- [ ] **Step 4:** Commit: `git commit -m "fix(farm/batch): add SERIALIZABLE transactions to 5 cleaner fish handlers"`

---

### Task 10: Transaction — Diğer Handlers

**Bulgu:** #4.1 (CRITICAL)
**Files:**
- `apps/farm-service/src/harvest/handlers/delete-harvest-record.handler.ts`
- `apps/farm-service/src/feeding/handlers/update-feeding-record.handler.ts`
- `apps/farm-service/src/growth/handlers/record-growth-sample.handler.ts`

- [ ] **Step 1-3:** Task 9 ile aynı pattern. Bu handler'lar daha basit (2-4 tablo), ama yine transaction gerekli. `READ COMMITTED` isolation yeterli (SERIALIZABLE gerekmez çünkü concurrent quantity race condition riski daha düşük).
- [ ] **Step 4:** Commit: `git commit -m "fix(farm): add transactions to delete-harvest, update-feeding, record-growth handlers"`

---

### Task 11: Bug Fix — Storage Overview + Entity Type Fixes

**Bulgu:** #3.3 (BUG) + #2.3 (Entity type mismatch)
**Files:**
- Modify: `apps/farm-service/src/storage/handlers/get-storage-overview.handler.ts`

- [ ] **Step 1:** `getRecentMovementsCount` metodunu bul (~satır 154). `sevenDaysAgo` hesaplanıyor ama WHERE'da kullanılmıyor.

- [ ] **Step 2:** WHERE koşuluna tarih filtresi ekle:

```typescript
return this.movementRepository.count({
  where: {
    tenantId,
    createdAt: MoreThanOrEqual(sevenDaysAgo),  // BUG FIX
  },
});
```

`MoreThanOrEqual`'i `typeorm`'dan import et.

- [ ] **Step 3:** Commit: `git commit -m "fix(farm/storage): add missing date filter to getRecentMovementsCount"`

---

### Task 12: Withdrawal Period Enforcement

**Bulgu:** #9.2 (CRITICAL) — isHarvestAllowed() boş implementasyon
**Files:**
- Modify: `apps/farm-service/src/harvest/entities/harvest-plan.entity.ts`

- [ ] **Step 1:** `isHarvestAllowed()` metodunu bul. Şu anda `return true` döndürüyor.

- [ ] **Step 2:** HealthEvent entity'sindeki `withdrawalPeriodDays` ve `earliestHarvestDate` alanlarını kontrol et. Batch'e bağlı aktif tedaviler varsa hasat engellenmelidir. Ancak bu entity cross-module erişim gerektirdiğinden, basit bir kontrol ekle:

```typescript
isHarvestAllowed(): boolean {
  // Withdrawal period kontrolü: plannedDate earliestSafeHarvestDate'den sonra mı?
  if (this.earliestSafeHarvestDate) {
    const plannedDate = this.harvestWindow?.startDate || this.plannedDate;
    if (plannedDate && new Date(plannedDate) < new Date(this.earliestSafeHarvestDate)) {
      return false;
    }
  }
  return true;
}
```

Eğer `earliestSafeHarvestDate` alanı entity'de yoksa, JSONB `harvestCriteria` veya başka bir alana bak. Mevcut alanlarla en iyi implementasyonu yap.

- [ ] **Step 3:** Commit: `git commit -m "fix(farm/harvest): implement withdrawal period check in isHarvestAllowed"`

---

## Phase 4: Events

### Task 13: NATS ↔ EventEmitter2 Köprüsü

**Bulgu:** #5.1 (CRITICAL) — İki event sistemi kopuk
**Files:**
- Modify: `apps/farm-service/src/events/event-listeners.module.ts`

- [ ] **Step 1:** `event-listeners.module.ts`'i oku. `EventEmitter2` listener'larının hangi event'leri dinlediğini not et.

- [ ] **Step 2:** Mevcut NATS event publish eden handler'ları bul (create-batch.handler.ts, record-mortality.handler.ts gibi). Bu handler'larda NATS publish'ten SONRA aynı event'i `EventEmitter2`'ye de emit etmek gerekiyor.

- [ ] **Step 3:** En pratik çözüm: NATS publish eden her handler'a EventEmitter2 inject edip, NATS publish sonrası emit eklemek. Ancak bu çok fazla dosya değişikliği. Alternatif: `event-listeners.module.ts`'e bir NATS subscriber ekleyip, NATS'tan gelen event'leri EventEmitter2'ye relay etmek.

İkinci yaklaşım daha temiz. Bir `NatsToEmitterBridge` service oluştur:

```typescript
@Injectable()
export class NatsToEmitterBridge implements OnModuleInit {
  constructor(
    private readonly eventEmitter: EventEmitter2,
    @Inject('NATS_EVENT_BUS') private readonly natsEventBus: any,
  ) {}

  onModuleInit() {
    // NATS'tan gelen farm event'lerini EventEmitter2'ye relay et
    this.natsEventBus.subscribe('events.BatchCreated', (event) => {
      this.eventEmitter.emit('batch.created', event);
    });
    // ... diğer event'ler için de aynısı
  }
}
```

NOT: Bu implementasyon mevcut NATS altyapısına bağlıdır. `@platform/event-bus` nasıl çalışıyorsa ona uygun olmalı.

- [ ] **Step 4:** Commit: `git commit -m "feat(farm/events): bridge NATS events to EventEmitter2 for internal listeners"`

---

### Task 14: Eksik Event Emission

**Bulgu:** #5.2, #4.3 (HIGH) — 8 contract var ama emit yok
**Files:**
- Modify: `apps/farm-service/src/batch/handlers/transfer-batch.handler.ts`
- Modify: `apps/farm-service/src/batch/handlers/close-batch.handler.ts`
- Modify: `apps/farm-service/src/batch/handlers/record-cull.handler.ts`
- Modify: `apps/farm-service/src/growth/handlers/record-growth-sample.handler.ts`

- [ ] **Step 1:** `libs/event-contracts/src/farm-events.ts`'den ilgili event interface'lerini import et.
- [ ] **Step 2:** Her handler'a `NatsEventBus` inject et (mevcut handler'larda nasıl yapıldığına bak — `create-batch.handler.ts` referans).
- [ ] **Step 3:** Transaction commit'ten SONRA event publish et (at-most-once pattern):

```typescript
try {
  await this.eventBus.publish(event);
} catch (err) {
  this.logger.warn(`Event publish failed: ${err.message}`);
  // Transaction'ı geri sarma — event kaybı kabul edilebilir
}
```

- [ ] **Step 4:** Commit: `git commit -m "feat(farm): add NATS event emission to transfer/close/cull/growth handlers"`

---

### Task 15: Event Payload Standardizasyonu

**Bulgu:** #5.4 (MEDIUM) — Eski handler'lar wrapper, yeniler flat
**Files:**
- Modify: `apps/farm-service/src/farm/handlers/update-farm.handler.ts`
- Modify: `apps/farm-service/src/farm/handlers/create-pond.handler.ts`
- Modify: `apps/farm-service/src/farm/handlers/create-batch.handler.ts` (farm/ altındaki eski versiyon)
- Modify: `apps/farm-service/src/farm/handlers/harvest-batch.handler.ts`

- [ ] **Step 1:** Her handler'daki `payload` + `metadata` wrapper yapısını kaldır. Flat BaseEvent yapısına dönüştür:

```typescript
// ESKİ (yanlış):
{ eventId, eventType, timestamp, payload: { farmId, tenantId }, metadata: { userId } }

// YENİ (doğru — batch/handlers/ pattern'i):
{ eventId, eventType, timestamp, tenantId, farmId, userId, version: 1 }
```

- [ ] **Step 2:** `libs/event-contracts/src/farm-events.ts`'deki interface'e uygun olduğunu doğrula.
- [ ] **Step 3:** Commit: `git commit -m "fix(farm): standardize event payloads to flat BaseEvent format"`

---

## Phase 5: Frontend

### Task 16: Enum Uyumsuzlukları Fix

**Bulgu:** #7.3 (HIGH)
**Files:**
- Modify: `web/modules/farm-module/src/hooks/useBatches.ts`

- [ ] **Step 1:** `MortalityReason` type/enum tanımını bul. `predation` ve `cannibalism` değerlerini ekle.
- [ ] **Step 2:** `CullReason` type/enum tanımını bul. `quality` değerini ekle.
- [ ] **Step 3:** Commit: `git commit -m "fix(farm-module): add missing enum values for MortalityReason and CullReason"`

---

### Task 17: Query Key Tenant Tutarlılığı

**Bulgu:** #7.5 (HIGH)
**Files:**
- Modify: `web/modules/farm-module/src/hooks/useSites.ts`
- Modify: `web/modules/farm-module/src/hooks/useEquipment.ts` (varsa)
- Modify: `web/modules/farm-module/src/hooks/useFeeds.ts`
- Modify: `web/modules/farm-module/src/hooks/useSuppliers.ts`
- Modify: `web/modules/farm-module/src/hooks/useChemicals.ts`
- Modify: `web/modules/farm-module/src/hooks/useDepartments.ts` (varsa)
- Modify: `web/modules/farm-module/src/hooks/useSpecies.ts`
- Modify: `web/modules/farm-module/src/hooks/useHealthEvents.ts`
- Modify: `web/modules/farm-module/src/hooks/useMaintenance.ts`

- [ ] **Step 1:** `useBatches.ts`'i referans al — query key'e `tenantId` nasıl ekleniyor bak.
- [ ] **Step 2:** Yukarıdaki hook'larda query key'e `tenantId` ekle:

```typescript
// ESKİ:
queryKey: ['sites', 'list', filter]
// YENİ:
queryKey: ['sites', 'list', tenantId, filter]
```

- [ ] **Step 3:** `useHealthEvents.ts` ve `useMaintenance.ts`'de `useAuth()` import edip `enabled: !!token && !!tenantId` kontrolü ekle.
- [ ] **Step 4:** Commit: `git commit -m "fix(farm-module): add tenantId to all query keys for correct cache isolation"`

---

### Task 18: Routing Bug Fix + Orphan Cleanup

**Bulgu:** #6.4, Frontend routing bugs
**Files:**
- Modify: `web/modules/farm-module/src/pages/FarmDetailPage.tsx`
- Modify: `web/modules/farm-module/src/pages/FarmFormPage.tsx`
- Delete (veya comment-out): orphan page dosyaları

- [ ] **Step 1:** `FarmDetailPage.tsx`'de `useParams<{ farmId }>` → `useParams<{ siteId }>` olarak düzelt. Tüm `farmId` referanslarını `siteId` ile değiştir.
- [ ] **Step 2:** `FarmFormPage.tsx`'de aynı düzeltmeyi yap.
- [ ] **Step 3:** Orphan dosyaları listele ve sil (veya deprecated olarak işaretle):
  - `pages/FarmListPage.tsx`
  - `pages/feeding/DailyFeedingDashboard.tsx`
  - `pages/feeding/FeedingProgramsPage.tsx`
  - `pages/production/tabs/BatchInputTab.tsx`
- [ ] **Step 4:** Commit: `git commit -m "fix(farm-module): fix farmId→siteId route params, remove orphan pages"`

---

### Task 19: Error Handling Ekleme

**Bulgu:** Frontend form error handling eksiklikleri
**Files:**
- Modify: `web/modules/farm-module/src/pages/storage/components/CreatePurchaseOrderModal.tsx`
- Modify: `web/modules/farm-module/src/pages/storage/components/ReceiveDeliveryModal.tsx`

- [ ] **Step 1:** Her iki modal'da `catch` bloğundaki `console.error` yerine toast notification ekle:

```typescript
import { toast } from 'react-hot-toast'; // veya mevcut toast utility

// catch bloğunda:
} catch (error) {
  const message = error instanceof Error ? error.message : 'İşlem başarısız oldu';
  toast.error(message);
}
```

- [ ] **Step 2:** Success durumunda da toast ekle (onSuccess callback'inde).
- [ ] **Step 3:** Commit: `git commit -m "fix(farm-module): add toast error handling to PurchaseOrder and ReceiveDelivery modals"`

---

## Phase 6: Architecture

### Task 20: CqrsModule Standardizasyonu

**Bulgu:** #6.1 (HIGH) — 10 modül yanlış CqrsModule kullanıyor
**Files (module dosyaları):**
- `apps/farm-service/src/site/site.module.ts`
- `apps/farm-service/src/department/department.module.ts`
- `apps/farm-service/src/equipment/equipment.module.ts`
- `apps/farm-service/src/supplier/supplier.module.ts`
- `apps/farm-service/src/chemical/chemical.module.ts`
- `apps/farm-service/src/consumable/consumable.module.ts`
- `apps/farm-service/src/feed/feed.module.ts`
- `apps/farm-service/src/storage/storage.module.ts`
- `apps/farm-service/src/system/system.module.ts`
- `apps/farm-service/src/worker/worker.module.ts`

- [ ] **Step 1:** Her dosyada `import { CqrsModule } from '@nestjs/cqrs'` → `import { CqrsModule } from '@platform/cqrs'` olarak değiştir.
- [ ] **Step 2:** `imports:` array'inde `CqrsModule` referansı aynı kalır (sadece import kaynağı değişiyor).
- [ ] **Step 3:** Build kontrolü — `@platform/cqrs`'in `CqrsModule` export edip etmediğini doğrula.
- [ ] **Step 4:** Commit: `git commit -m "fix(farm): standardize CqrsModule imports to @platform/cqrs across 10 modules"`

---

### Task 21: EventEmitter Duplicate + Orphan Cleanup

**Bulgu:** #6.4 (MEDIUM) — Orphan kod, duplicate EventEmitterModule
**Files:**
- Modify: `apps/farm-service/src/scheduler/scheduler.module.ts`

- [ ] **Step 1:** `scheduler.module.ts`'de `EventEmitterModule.forRoot({ maxListeners: 10 })` satırını kaldır. `event-listeners.module.ts`'deki `forRoot({ maxListeners: 20 })` yeterli.
- [ ] **Step 2:** Orphan handler'ları temizle veya `@deprecated` olarak işaretle. `GetDailyFeedingPlanQuery` handler'ı YOKSA ve dispatch ediliyorsa (runtime exception), resolver'daki dispatch çağrısını kaldır veya basit bir handler oluştur.
- [ ] **Step 3:** Commit: `git commit -m "fix(farm): remove duplicate EventEmitterModule.forRoot, fix orphan query dispatch"`

---

### Task 22: Performance — SQL Aggregates

**Bulgu:** #3.3, #3.4 (HIGH) — JS'te aggregate, ayrı count sorguları
**Files:**
- Modify: `apps/farm-service/src/fish-health/services/health-event.service.ts`

- [ ] **Step 1:** `getStats` metodunu bul (~satır 220). Tüm event'leri çekip JS'te sayma yerine SQL COUNT + CASE WHEN kullan:

```typescript
const stats = await this.healthEventRepository
  .createQueryBuilder('he')
  .select('he.status', 'status')
  .addSelect('COUNT(*)', 'count')
  .where('he.tenantId = :tenantId', { tenantId })
  .groupBy('he.status')
  .getRawMany();
```

- [ ] **Step 2:** Commit: `git commit -m "perf(farm/health): convert JS aggregate to SQL GROUP BY in getStats"`

---

### Task 23: Lookup Table Schema Fix

**Bulgu:** #2.4 (MEDIUM) — Schema belirsizliği
**Files:**
- Modify: `apps/farm-service/src/chemical/entities/chemical-type.entity.ts`
- Modify: `apps/farm-service/src/supplier/entities/supplier-type.entity.ts`
- Modify: `apps/farm-service/src/feed/entities/feed-type.entity.ts`
- Modify: `apps/farm-service/src/equipment/entities/sub-equipment-type.entity.ts`

- [ ] **Step 1:** Her entity'de `@Entity('tablo_adi')` → `@Entity('tablo_adi', { schema: 'farm' })` olarak güncelle. Referans: `equipment-type.entity.ts` nasıl yapıyorsa aynı.
- [ ] **Step 2:** Commit: `git commit -m "fix(farm): add explicit schema:'farm' to shared lookup table entities"`

---

## Kapsam Dışı — Roadmap (P2/P3)

Aşağıdaki bulgular bu planda kod düzeyinde çözülmez. Ayrı spec + plan gerektirir:

| # | Bulgu | Neden Kapsam Dışı |
|---|-------|-------------------|
| 2.1 | batches vs batches_v2 ikili tablo | Migration planı + veri taşıma gerektirir |
| 2.2 | tanks vs equipment ikili temsil | Tüm batch/feeding/growth handler'ları etkiler |
| 2.3 | 30+ eksik FK constraint | Migration dosyaları + tenant propagation gerektirir |
| 3.2 | DataLoader (N+1) | Her resolver için DataLoader factory pattern gerektirir |
| 6.2 | God service'leri bölme | 4 büyük servisin refactor'ı |
| 7.1 | FarmFormPage sahte form | Yeni API endpoint veya sayfa kaldırma kararı |
| 7.6 | Lazy loading | Module.tsx refactor + test |
| 8.x | Test coverage | Ayrı test planı gerektirir |
| 9.1 | Biosecurity/Grading/Vaccination | Yeni entity + module + frontend |
| 9.3 | Farm-Site ilişki kopukluğu | Entity migration |
| 9.4 | Soft delete tutarsızlığı | 15+ entity migration |
| 10.x | Cross-service entegrasyon | Çoklu servis koordinasyonu |

---

## Execution Checklist

Tüm task'lar tamamlandığında doğrulama:

```bash
# Build kontrolü
npx nx build farm-service --skip-nx-cache

# Mevcut testlerin geçtiğini doğrula
npx nx test farm-service --skip-nx-cache

# Frontend build
npm run build --workspace=web/modules/farm-module

# Git status temiz mi
git status
```
