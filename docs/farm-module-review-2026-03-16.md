# Farm Modulu Kapsamli Inceleme Raporu

**Tarih:** 2026-03-16
**Kapsam:** Backend (farm-service), Frontend (farm-module), Veritabani, Entegrasyonlar
**Inceleme Ekibi:** 24 Uzman Agent
**Olcek:** 715 TypeScript dosyasi, ~106.000 satir kod, 29 modul, 65 entity, 34 resolver, ~97 command handler

---

## Yonetici Ozeti

### Bulgu Dagilimi

| Seviye | Sayi |
|--------|------|
| **Critical** | 7 |
| **High** | 18 |
| **Medium** | 32 |
| **Low** | 21 |
| **Toplam** | **78** |

### En Kritik 5 Bulgu

1. **Feeding/Growth resolver'larinda tenantId ve userId istemciden @Args ile aliniyor** -- herhangi bir tenant'in verisine tam erisim (Security)
2. **schemaName parametresi istemciden aliniyor ve raw SQL'e interpolasyon yapiliyor** -- SQL injection + cross-tenant bypass (Security)
3. **11 command handler'da transaction olmadan coklu tablo yaziliyor** -- veri tutarsizligi riski (CQRS Commands)
4. **NATS ve EventEmitter2 katmanlari birbirinden kopuk** -- 6 event listener hicbir zaman tetiklenmiyor (Event Architecture)
5. **Production ortaminda DATABASE_SYNC=true** -- deploy sirasinda kontrolsuz schema degisikligi ve veri kaybi riski (Migration)

---

## 1. KRITIK GUVENLIK ACIKLARI

### 1.1 TenantId Istemciden Args Olarak Aliniyor [CRITICAL]

**Dosyalar:**
- `/var/aqua-saas/apps/farm-service/src/feeding/resolvers/feeding.resolver.ts` (satir 789+)
- `/var/aqua-saas/apps/farm-service/src/growth/resolvers/growth.resolver.ts` (satir 413+)

FeedingResolver ve GrowthResolver, `tenantId`'yi `@Tenant()` veya `@CurrentTenant()` decorator'u yerine dogrudan `@Args('tenantId')` ile aliyor. Bu, istemcinin herhangi bir tenant'in verilerine okuma/yazma erisimi saglayacagi anlamina gelir. Ayni resolver'larda `userId` de `@Args('userId')` ile aliniyor -- bu da kimlik taklidi (impersonation) saglar.

**Etkilenen endpoint sayisi:** ~22 query/mutation

**Onerilen cozum:** Tum `@Args('tenantId')` kullanimlarini `@CurrentTenant()` ile, `@Args('userId')` kullanimlarini `@CurrentUser('sub')` ile degistirin.

### 1.2 SchemaName Istemciden Aliniyor -- SQL Injection [CRITICAL]

**Dosya:** `/var/aqua-saas/apps/farm-service/src/feeding/resolvers/feeding.resolver.ts` (satir 889+)

`growthSimulation`, `feedConsumptionForecast` ve `activeTanks` query'lerinde `@Args('schemaName')` parametresi dogrudan raw SQL'e interpolasyon yapiliyor:
```sql
SELECT * FROM "${schemaName}".batch_feed_assignments ...
```

**Onerilen cozum:** `@Args('schemaName')` parametresini kaldirin; `getTenantSchemaName(tenantId)` ile sunucu tarafinda hesaplayin.

### 1.3 Guard Tutarsizligi -- GqlAuthGuard vs TenantGuard [HIGH]

**Dosya:** `/var/aqua-saas/apps/farm-service/src/farm/resolvers/farm.resolver.ts` ve 12 diger resolver

13 resolver `GqlAuthGuard` (sadece JWT dogrulama) kullaniyor, 21 resolver `TenantGuard` (JWT + tenant izolasyonu) kullaniyor. GqlAuthGuard kullanan resolver'lar tenant izolasyonunu garanti etmiyor.

**Onerilen cozum:** Tum resolver'lari `TenantGuard`'a migrate edin veya iki guard'u birlestirin.

### 1.4 RBAC Eksikligi -- 15+ Resolver'da @Roles Yok [HIGH]

Department, Feed, Chemical, Supplier, Consumable, Storage, Worker, WaterQuality, HealthEvent, System, SentinelHub, WorkOrder, MaintenanceSchedule, Task, AutoRule, RecurringTemplate, Regulatory resolver'larinda mutation'lar `@Roles` decorator'u olmadan tanimli. Herhangi bir authenticated kullanici CREATE/UPDATE/DELETE yapabilir.

### 1.5 sortOrder Parametresi Validasyonsuz [HIGH]

**Dosyalar:** `list-batches.handler.ts`, `list-tanks.handler.ts`

`sortField` whitelist ile korunuyor (iyi) ama `sortOrder` dogrudan TypeORM `orderBy`'a aktariliyor. SQL injection riski.

**Onerilen cozum:** `['ASC', 'DESC']` whitelist kontrolu ekleyin.

---

## 2. VERITABANI ve SEMA SORUNLARI

### 2.1 Ikili Tablo Problemi: batches vs batches_v2 [HIGH]

**Dosyalar:**
- `/var/aqua-saas/apps/farm-service/src/farm/entities/batch.entity.ts` (tablo: `batches`, sinif: `PondBatch`)
- `/var/aqua-saas/apps/farm-service/src/batch/entities/batch.entity.ts` (tablo: `batches_v2`, sinif: `Batch`)

Ayni konsept icin iki tablo. Legacy `batches` hala Pond entity'sinden referans aliniyor. Aralarinda senkronizasyon yok.

### 2.2 Ikili Tank Temsili: tanks vs equipment (isTank=true) [HIGH]

Tank kavrami `tanks` tablosu ve `equipment` tablosunda (`isTank=true`) temsil ediliyor. Batch islemleri `equipment` tablosunu, su kalitesi olcumleri `tanks` tablosunu kullaniyor. `ListAvailableTanksHandler` her iki tabloyu sorguluyor.

### 2.3 30+ Eksik Foreign Key Constraint [HIGH]

`WaterQualityMeasurement.batchId`, `GrowthMeasurement.tankId`, `HarvestRecord.pondId`, `WorkOrder.assetId`, `Task.siteId` ve 25+ diger UUID sutunu FK constraint olmadan duruyor. Var olmayan bir ID yazilabilir.

### 2.4 Shared Lookup Tablolarinda Schema Belirsizligi [MEDIUM]

`sub_equipment_types`, `chemical_types`, `supplier_types`, `feed_types` tablolarinda ne `{ schema: 'farm' }` belirtilmis ne de `tenantId` var. `equipment_types` dogru sekilde `{ schema: 'farm' }` kullaniyor -- diger lookup tablolari da ayni sekilde olmali.

### 2.5 Production'da DATABASE_SYNC=true [CRITICAL]

**Dosyalar:**
- `/var/aqua-saas/infrastructure/docker/docker-compose.prod.yml` (satir 173-180)
- `/var/aqua-saas/docker-compose.droplet.yml` (satir 320-329)

Her iki production compose dosyasinda da `DATABASE_SYNC: 'true'`. Entity'den kolon kaldirildiginda TypeORM otomatik DROP yapar, veri kaybi olusur.

### 2.6 Migration'larda Tenant Propagation Eksik [HIGH]

13 TypeORM migration dosyasindan sadece 4'u tenant schema propagation yapiyor. Diger 9'u sadece `farm` schema'da calisir -- mevcut tenant'larin schema'lari guncellenmez.

---

## 3. PERFORMANS SORUNLARI

### 3.1 Felaket Sorgusu: 1000 Kayit Cekip JS'te Find [CRITICAL]

**Dosya:** `/var/aqua-saas/apps/farm-service/src/feeding/resolvers/feeding.resolver.ts` (satir 791)

Tek bir feeding record bulmak icin 1000 kayit cekilip JavaScript `find()` ile araniyor. Ayni pattern `growth.resolver.ts`'de de var.

**Onerilen cozum:** `findOne({ where: { id, tenantId } })` kullanilmali.

### 3.2 N+1 Sorunu -- DataLoader Hic Kullanilmiyor [HIGH]

**Etkilenen resolver'lar:** BatchResolver (3 ResolveField), TankResolver (2), EquipmentResolver (2), DepartmentResolver (1), SystemResolver (4)

100 tank listesinde `batchMetrics` resolve edildiginde 100+ ayri DB sorgusu olusur.

### 3.3 Tum Kayitlari Bellege Alma (5 Yer) [HIGH]

| Handler | Dosya | Sorun |
|---------|-------|-------|
| GetFeedingSummaryHandler | `get-feeding-summary.handler.ts:79` | Pagination yok, reduce JS'te |
| GetHarvestStatisticsHandler | `get-harvest-statistics.handler.ts:66` | GROUP BY SQL'de yapilmali |
| HealthEventService.getStats | `health-event.service.ts:220` | Tum event'leri tarayan sorgu |
| GetGrowthAnalysisHandler | `get-growth-analysis.handler.ts:69` | Tum batch olcumleri |
| GetStorageOverviewHandler | `get-storage-overview.handler.ts:154` | BUG: tarih filtresi hesaplaniyor ama WHERE'da kullanilmiyor |

### 3.4 Count + Data Icin 2 Ayri Sorgu (6 Handler) [MEDIUM]

`ListBatchesHandler`, `GetGrowthMeasurementsHandler`, `GetFeedingRecordsHandler` ve 3 diger handler ayri `getCount()` + `getMany()` cagirisi yapiyor. `getManyAndCount()` kullanilmali.

---

## 4. CQRS ve COMMAND HANDLER SORUNLARI

### 4.1 Transaction Eksikligi -- 11 Handler [CRITICAL]

| Handler | Yazilan Tablo Sayisi |
|---------|---------------------|
| RecordCullHandler | 3 (Batch, TankBatch, Equipment) |
| DeployCleanerFishHandler | 3 |
| RecordCleanerMortalityHandler | 4 |
| RemoveCleanerFishHandler | 3 |
| TransferCleanerFishHandler | 5 |
| DeleteHarvestRecordHandler | 4 |
| UpdateFeedingRecordHandler | 2 |
| RecordGrowthSampleHandler | 2 |

Karsilastirma: `CreateBatchHandler`, `TransferBatchHandler`, `AllocateToTankHandler` dogru sekilde `DataSource.createQueryRunner()` ile transaction kullaniyor -- gold standard.

### 4.2 Race Condition -- Pessimistic Lock Eksikligi [HIGH]

RecordCull, DeployCleanerFish, RemoveCleanerFish, TransferCleanerFish handler'larinda lock yok. Concurrent islemlerde miktar kontrolleri basarisiz olur. `AllocateToTankHandler` SERIALIZABLE isolation + pessimistic_write lock kullaniyor -- ornek bu.

### 4.3 Event Emission Tutarsizligi [HIGH]

TransferBatch, RecordCull, ClosesBatch, tum CleanerFish handler'lari, Tank/Species/Equipment/Chemical/Supplier/Worker/Feed handler'lari -- hicbirinde NATS event publish edilmiyor. Sadece CreateBatch, RecordMortality, CreateFarm, UpdateFarm NATS event yayin yapiyor.

### 4.4 Audit Log Sadece 2 Modulde [MEDIUM]

Sadece Tank ve Species modulleri `AuditLogService` kullaniyor. Batch, Chemical, Supplier, Storage, Feeding, Worker ve diger tum modullerde audit logging yok.

---

## 5. EVENT-DRIVEN ARCHITECTURE SORUNLARI

### 5.1 NATS ve EventEmitter2 Kopuklugu [CRITICAL]

Farm service iki katmanli event sistemi kullaniyor: NATS JetStream (servisler arasi) ve NestJS EventEmitter2 (servis ici). Bu iki katman birbirinden tamamen bagimsiz.

Handler'lar NATS'a publish ediyor, ancak `BatchCreatedListener`, `MortalityRecordedListener`, `HarvestCompletedListener`, `FeedingCompletedListener`, `LowStockAlertListener`, `MaintenanceScheduleDueListener` EventEmitter2 dinliyor. **Hicbiri tetiklenmiyor.**

### 5.2 8 Event Contract Tanimli Ama Hic Emit Edilmiyor [HIGH]

`BatchTransferredEvent`, `BatchAllocatedToTankEvent`, `GrowthSampleRecordedEvent`, `FeedingRecordedEvent`, `TankDensityAlertEvent`, `FCRAlertEvent`, `BatchClosedEvent` -- contract dosyasinda tanimli ama hicbir handler'da emit edilmiyor.

### 5.3 Hicbir Diger Servis Farm Event'lerini Dinlemiyor [MEDIUM]

alert-engine, notification-service, sensor-service, billing-service -- hicbirinde farm event consumer'i bulunamadi. NATS'a publish edilen tum farm event'leri bosta.

### 5.4 Payload Uyumsuzluklari [MEDIUM]

Eski handler'lar (`farm/handlers/`) `payload` + `metadata` wrapper yapisi kullanirken, yeni handler'lar (`batch/handlers/`) flat BaseEvent yapisi kullaniyor. Ayni `BatchCreated` event'i iki farkli formatta yayinlaniyor.

---

## 6. MIMARI ve KOD KALITESI

### 6.1 CqrsModule Import Tutarsizligi [HIGH]

11 modul `@platform/cqrs`, 10 modul `@nestjs/cqrs` kullaniyor. Iki farkli CommandBus/QueryBus instance olusabilir. Platform wrapper'i ek ozellikler (event bus, tenant context) sagliyorsa, dogrudan `@nestjs/cqrs` kullananlar bu ozellikleri atlar.

### 6.2 God Service'ler [MEDIUM]

| Servis | Satir | Sorumluluk Sayisi |
|--------|-------|-------------------|
| FeedingProgramResolver | 2.298 | Resolver + inline type tanimlama + is logigi |
| DailyFeedingExecutionService | 1.325 | Plan + kayit + hesaplama + yem gecis |
| FeedingProgramService | 1.170 | CRUD + tank yonetimi + interpolasyon |
| BatchService | 878 | CRUD + allocation + transfer + metrics |

### 6.3 SOLID Ihlalleri [MEDIUM]

- **ISP/DIP Skoru: 1.5/5** -- Neredeyse hic interface/abstraction yok. Tum dependency injection concrete class'lar uzerinden.
- **OCP Skoru: 2/5** -- Switch-case pattern'ler yaygin (CronJobsService, BatchService), strategy/plugin pattern kullanilmiyor.

### 6.4 Orphan Kod [MEDIUM]

- 4 command/query handler dispatch edilmiyor (UpdateFarmCommand, GetTankCapacityQuery, GetTankBatchesQuery, GetTankOperationsQuery)
- 1 dispatch edilen query'nin handler'i yok: `GetDailyFeedingPlanQuery` -- **runtime exception**
- 6 frontend sayfa route'lardan erisilemez (FarmListPage, DailyFeedingDashboard, 3 Maintenance sayfasi, BatchInputTab)
- 9 bos placeholder dosya (`modules/system-optimizer/`, `modules/tank-telemetry/`, `cache/farm-cache.service.ts`)

---

## 7. FRONTEND SORUNLARI

### 7.1 FarmFormPage -- Tamamen Sahte Form [HIGH]

**Dosya:** `/var/aqua-saas/web/modules/farm-module/src/pages/FarmFormPage.tsx`

`handleSubmit` icinde gercek API cagrisi yok. `setTimeout` ile simulasyon yapiliyor. Kullanici ciftlik olusturdugunu sanir ama veri kaydedilmez.

### 7.2 Report Modal'lari -- Backend Baglantisi Yok [MEDIUM]

`EscapeReportModal`, `DiseaseOutbreakModal`, `WelfareEventModal` -- `onSubmit` prop ile calisiyor, backend'de karsilik gelen mutation/resolver yok. Formlar veri kaydetmiyor.

### 7.3 Enum Uyumsuzluklari (Frontend-Backend) [HIGH]

| Enum | Frontend Eksik Deger |
|------|---------------------|
| MortalityReason | `predation`, `cannibalism` |
| CullReason | `quality` |
| BatchFilterInput | `siteId`, `departmentId` filtreleri backend'de yok -- sessizce ignore ediliyor |

### 7.4 GraphQL Mutation Imza Farkliliklari [HIGH]

`skipDailyFeeding` ve `dailyFeedingExecutions` icin iki farkli dosyada (`feedingProgram.mutations.ts` vs `useDailyFeedingExecution.ts`) tamamen farkli imzalar tanimli. Birinin runtime'da hata vermesi kacinilmaz.

### 7.5 Query Key Tutarsizligi -- Tenant Cache Sorunu [HIGH]

**Dosya:** `/var/aqua-saas/web/modules/farm-module/src/hooks/`

Bazi hook'lar query key'e `tenantId` ekliyor, bazilari eklemiyor. Tenant degistiginde `useSiteList` eski tenant'in cache'lenmis verisini gosterir.

### 7.6 Lazy Loading Eksik [MEDIUM]

Farm module icindeki 15+ sayfanin hicbiri lazy load edilmiyor. MapViewPage (Leaflet, Sentinel Hub), FeedingProgramForm (2000+ satir) gibi agir sayfalar eagerly import ediliyor.

### 7.7 Eksik Frontend Formlari [MEDIUM]

17 backend mutation'i icin frontend formu bulunamadi: createHarvestRecord, createHealthEvent, createGrowthMeasurement, createWorker, createEquipment, createDepartment, createSystem, createFeed, createChemical, createConsumable, createStorageLocation, createMaintenanceSchedule, createWorkOrder, createSparePart, createWaterQualityRecord, createSupplier, createSpecies.

---

## 8. TEST KAPSAMI

### 8.1 Genel Durum: KRITIK SEVIYEDE DUSUK

| Metrik | Deger |
|--------|-------|
| Toplam test dosyasi | 14 |
| Test edilen modul | 4 / 29 (%14) |
| Command handler coverage | ~3 / ~97 (%3) |
| Resolver coverage | 0 / 34 (**%0**) |
| E2E test | **0** |
| Authorization test | **0** |

### 8.2 Test Olan Moduller

- **Batch** (7 dosya) -- En iyi: `batch-lifecycle.integration.spec.ts` (full lifecycle + multi-tenant isolation)
- **Database** (3 dosya) -- code-generator, audit-log, base.entity
- **Farm** (2 dosya) -- create-farm, list-farms
- **Growth** (1 dosya) -- fcr-calculation.service

### 8.3 Test Olmayan Kritik Alanlar

- Tum feeding handler/service'ler (8 service + 5 handler)
- Tum tank handler'lar (6 handler)
- Tum equipment handler'lar (11 handler)
- Tum storage handler'lar (14 handler)
- TenantSchemaMiddleware (search_path testi yok)
- Authorization/Guard kontrolleri (sifir)
- Optimistic locking (version conflict senaryolari)
- Dis servis entegrasyonlari (Sentinel Hub, Open Meteo, Maskinporten)

---

## 9. DOMAIN ANALIZI ve EKSIK OZELLIKLER

### 9.1 Eksik Moduller [HIGH]

| Modul | Aciklama | Oncelik |
|-------|----------|---------|
| Biosecurity | Ziyaretci/arac giris-cikis, dezenfeksiyon, biyoguvenlik bolgeleri | P0 |
| Grading | Boy siniflandirma operasyonu (homojen buyume icin kritik) | P1 |
| Broodstock | Anac stok, genetik takip, ciftlestirme planlari | P1 |
| Vaccination | Asi kayitlari, asi takvimi, lot takibi | P1 |
| Chemical Application | Kimyasal uygulama kaydi (izlenebilirlik icin zorunlu) | P0 |

### 9.2 Withdrawal Period Enforcement Yok [CRITICAL]

`HarvestPlan.isHarvestAllowed()` metodu sadece `return true` donduruyor -- implementasyon yapilmamis. Ilacli batch hasat edilebilir ve bu gida guvenligi ihlalidir. Chemical entity'sindeki `withdrawalPeriodDays` alani kullanilmiyor.

### 9.3 Farm <-> Site Iliskisi Kopuk [HIGH]

Farm entity'sinde `siteId` FK'si yok. `Tenant > Site > Department > Tank` zinciri Farm'i icermiyor. Farm izole bir legacy yapi olarak duruyor.

### 9.4 Soft Delete Tutarsizligi [HIGH]

Core entity'ler (Farm, Pond, Tank, Batch) ve operasyonel kayit tablolari (FeedingRecord, GrowthMeasurement, WaterQualityMeasurement, HealthEvent, HarvestRecord, MortalityRecord, WorkOrder) soft delete desteklemiyor. Silinen veri geri alinamaz.

### 9.5 Feed Management -- Iyi Yonler

FCR hesaplama 3 katmanli ve dogru. Bilinear interpolasyon servisi, yem stok takibi (FIFO), otomatik stok dusumu, maliyet hesaplama mevcut ve iyi tasarlanmis. Division by zero korumalari var.

### 9.6 Species & Growth -- Iyi Yonler

Species entity 25+ su kalitesi parametresi, buyume asamalari, pazar bilgileri, ureme bilgileri ile son derece kapsamli. `checkWaterQuality()` metodu tum parametreleri kontrol edip ok/warning/critical sonucu donduruyor.

### 9.7 Su Kalitesi -- Sensor Entegrasyonu Eksik [MEDIUM]

25+ parametre destegi ve 5 farkli olcum kaynagi tanimli. Ancak sensor-service ile dogrudan kopru (bridge) yok -- sensor bilgisi sadece metadata olarak saklaniyor.

---

## 10. SERVISLER ARASI ENTEGRASYON

### 10.1 Federation @key Directive Eksik [HIGH]

Tum codebase'de `@Directive('@key')` sifir sonuc. Sadece Farm entity'si icin `@ResolveReference()` var -- implicit davranis. Diger servisler Tank veya Batch'e referans veremez.

### 10.2 Cross-Service Referans Butunlugu Yok [MEDIUM]

Sensor-service, alert-engine, billing-service farm entity UUID'lerini tasiyor ama FK constraint yok (farkli schemalar). Tank silindiginde sensor'lerin `tankId` referansi gecersiz kalir ve temizlik mekanizmasi yok.

### 10.3 Billing Service Sayim Mekanizmasi Eksik [MEDIUM]

Billing service `farms`, `ponds`, `sensors`, `alerts` sayilarini takip ediyor ama farm-service ile bu sayilari senkronize eden bir mekanizma (event veya API) bulunamadi.

### 10.4 Cron Job'larda Distributed Lock Yok [HIGH]

`CronJobsService` in-memory state tutuyor. Birden fazla instance calistiginda her instance tum tenant'larin cron job'larini calistirir (duplicate execution). Redis-based distributed lock gerekli.

---

## 11. ONCELIKLI AKSIYON PLANI

### P0 -- Acil (Bu Hafta)

| # | Bulgu | Dosya | Aksiyon |
|---|-------|-------|---------|
| 1 | tenantId/userId istemciden aliniyor | feeding.resolver.ts, growth.resolver.ts | `@CurrentTenant()` ve `@CurrentUser()` decorator'larina gecis |
| 2 | schemaName istemciden aliniyor | feeding.resolver.ts (satir 889) | `@Args('schemaName')` kaldir, sunucu tarafinda hesapla |
| 3 | Production'da DATABASE_SYNC=true | docker-compose.prod.yml, docker-compose.droplet.yml | `false` yap, migration pipeline kur |
| 4 | Withdrawal period bos implementasyon | harvest-plan entity | `isHarvestAllowed()` metodunu implement et |
| 5 | sortOrder validasyonu yok | list-batches.handler.ts, list-tanks.handler.ts | `['ASC', 'DESC']` whitelist ekle |

### P1 -- Kisa Vade (1-2 Sprint)

| # | Bulgu | Aksiyon |
|---|-------|---------|
| 6 | 11 handler'da transaction eksik | `DataSource.createQueryRunner()` ile transaction ekle |
| 7 | Guard tutarsizligi (GqlAuthGuard vs TenantGuard) | Tum resolver'lari TenantGuard'a migrate et |
| 8 | RBAC eksikligi | 15+ resolver'daki mutation'lara @Roles ekle |
| 9 | NATS-EventEmitter2 kopuklugu | Handler'lar NATS publish sonrasi EventEmitter2'ye de emit etmeli |
| 10 | Felaket sorgusu (1000 kayit cekme) | feeding.resolver.ts:791 -- `findOne` kullan |
| 11 | N+1 sorunu | DataLoader implement et (batch documents, tank department, equipment batchMetrics) |
| 12 | Eksik event emission | TransferBatch, RecordCull, CloseBatch, GrowthSample handler'larina NATS event ekle |
| 13 | Race condition | Cull, Deploy, Mortality, Remove handler'larina pessimistic lock ekle |
| 14 | Enum uyumsuzluklari | Frontend MortalityReason/CullReason enum'larina eksik degerleri ekle |
| 15 | Query key tutarsizligi | Tum hook'larda tenantId'yi query key'e ekle |

### P2 -- Orta Vade (3-4 Sprint)

| # | Bulgu | Aksiyon |
|---|-------|---------|
| 16 | Tank ikili temsil | `tanks` ve `equipment(isTank=true)` tek tabloda birlestir |
| 17 | Batch ikili tablo | `batches` (legacy) -> `batches_v2` migrasyonu tamamla |
| 18 | 30+ eksik FK constraint | Kritik iliskiler icin FK ekle (WQ.batchId, Growth.tankId vb.) |
| 19 | Soft delete tutarsizligi | Farm, Tank, Batch ve operasyonel tablolara soft delete ekle |
| 20 | CqrsModule tutarsizligi | Tum modulleri `@platform/cqrs`'e migrate et |
| 21 | Test coverage | Tank, Feeding, Harvest handler testleri + en az 1 resolver testi |
| 22 | God service'leri bol | BatchService, DailyFeedingExecutionService, FeedingProgramService |
| 23 | FarmFormPage sahte | Gercek API entegrasyonu yap veya sayfayi kaldir |
| 24 | Frontend lazy loading | Sayfalari React.lazy() ile yukle |
| 25 | Distributed lock | Cron job'lar icin Redis-based lock ekle |
| 26 | Kimyasal uygulama kaydi | ChemicalApplicationRecord entity olustur |
| 27 | Migration tenant propagation | Tum migration'lara tenant schema propagation ekle |

### P3 -- Roadmap

| # | Bulgu | Aksiyon |
|---|-------|---------|
| 28 | Biosecurity modulu | BiosecurityZone, BiosecurityLog entity'leri olustur |
| 29 | Grading operasyonu | GradingEvent, GradingResult entity'leri olustur |
| 30 | Vaccination yonetimi | VaccinationRecord entity olustur |
| 31 | Dead-Letter Queue | NATS JetStream DLQ stratejisi implement et |
| 32 | Naming convention tutarliligi | snake_case vs camelCase sutun isimleri standartlastir |
| 33 | Idempotency | Critical command'lara requestId/idempotency key ekle |
| 34 | Data archiving/partitioning | WaterQuality, FeedingRecord gibi hizli buyuyen tablolar icin strateji |
| 35 | Federation @key directive | Tank, Batch, Site entity'lerine @key ekle |
| 36 | E2E test altyapisi | En az temel CRUD akislari icin e2e test kur |

---

## EK A: Etkilenen Dosya Listesi

### Backend -- Kritik Dosyalar

| Dosya | Sorun Kategorisi |
|-------|------------------|
| `apps/farm-service/src/feeding/resolvers/feeding.resolver.ts` | Guvenlik (tenantId, schemaName, 1000-kayit sorgusu) |
| `apps/farm-service/src/growth/resolvers/growth.resolver.ts` | Guvenlik (tenantId, userId) |
| `apps/farm-service/src/batch/handlers/record-cull.handler.ts` | Transaction + Lock eksik |
| `apps/farm-service/src/batch/handlers/deploy-cleaner-fish.handler.ts` | Transaction + Lock eksik |
| `apps/farm-service/src/batch/handlers/record-cleaner-mortality.handler.ts` | Transaction + Lock eksik |
| `apps/farm-service/src/batch/handlers/remove-cleaner-fish.handler.ts` | Transaction + Lock eksik |
| `apps/farm-service/src/batch/handlers/transfer-cleaner-fish.handler.ts` | Transaction + Lock eksik |
| `apps/farm-service/src/harvest/handlers/delete-harvest-record.handler.ts` | Transaction eksik |
| `apps/farm-service/src/batch/handlers/transfer-batch.handler.ts` | Event emission + TOCTOU |
| `apps/farm-service/src/batch/handlers/close-batch.handler.ts` | Event emission eksik |
| `apps/farm-service/src/storage/handlers/get-storage-overview.handler.ts` | Bug: tarih filtresi kullanilmiyor |
| `apps/farm-service/src/batch/resolvers/batch.resolver.ts` | N+1, tenantId filtresi eksik |
| `apps/farm-service/src/tank/resolvers/tank.resolver.ts` | N+1, tenantId filtresi eksik |
| `apps/farm-service/src/equipment/equipment.resolver.ts` | N+1 |
| `apps/farm-service/src/middleware/tenant-schema.middleware.ts` | Fallback riski |
| `apps/farm-service/src/events/event-listeners.module.ts` | NATS-EventEmitter kopuklugu |
| `infrastructure/docker/docker-compose.prod.yml` | DATABASE_SYNC=true |
| `docker-compose.droplet.yml` | DATABASE_SYNC=true |

### Frontend -- Kritik Dosyalar

| Dosya | Sorun Kategorisi |
|-------|------------------|
| `web/modules/farm-module/src/pages/FarmFormPage.tsx` | Sahte form (API cagrisi yok) |
| `web/modules/farm-module/src/hooks/useBatches.ts` | Enum uyumsuzlugu, eksik filter field |
| `web/modules/farm-module/src/hooks/useDailyFeedingExecution.ts` | Mutation imza farkliligi |
| `web/modules/farm-module/src/graphql/feedingProgram.mutations.ts` | Mutation imza farkliligi |
| `web/modules/farm-module/src/hooks/useFeeding.ts` | schemaName hesaplama tutarsizligi |
| `web/modules/farm-module/src/pages/storage/components/CreatePurchaseOrderModal.tsx` | Hata gosterimi yok |
| `web/modules/farm-module/src/pages/storage/components/ReceiveDeliveryModal.tsx` | Hata gosterimi yok |
| `web/modules/farm-module/src/Module.tsx` | Lazy loading yok, catch-all 404 yok |

---

## EK B: Istatistikler

### Backend Olcekleri

| Metrik | Deger |
|--------|-------|
| Toplam TypeScript dosyasi | 715 |
| Toplam satir kod | ~106.000 |
| Modul sayisi | 29 |
| Entity sayisi | 65 (62 dosya, bazi shared) |
| Resolver sayisi | 34 |
| Command handler sayisi | ~97 |
| Query handler sayisi | ~16 |
| Service sayisi | ~39 |
| NATS event contract | 20 |
| Gercekte emit edilen event | 12 |
| Test dosyasi | 14 |

### Frontend Olcekleri

| Metrik | Deger |
|--------|-------|
| Hook dosyasi | 39 |
| GraphQL operation dosyasi | 8 |
| Sayfa component'i | 24 (6 orphan) |
| Form component'i | 21 (3 sahte) |
| React Query hook | ~100+ |
| Lazy loaded sayfa | 0 / 24 |

### Domain Kapsami

| Alan | Durum |
|------|-------|
| Batch lifecycle (QUARANTINE -> CLOSED) | Tam |
| Tank yonetimi | Iyi (ikili tablo sorunu haric) |
| Feeding (program, plan, kayit, stok) | Kapsamli |
| Growth (olcum, FCR, SGR, trend) | Iyi |
| Species (25+ parametre, buyume asamalari) | Cok Iyi |
| Equipment (16 kategori, 42 tip) | Iyi |
| Water Quality (25+ parametre) | Iyi (sensor bridge yok) |
| Harvest (plan, kayit, kalite) | Orta |
| Health (12 olay tipi, tedavi, karantina) | Iyi |
| Chemical (envanter, site onay) | Orta (uygulama kaydi yok) |
| Supplier (6 tip, rating) | Orta (otomatik degerlendirme yok) |
| Maintenance (work order, schedule, spare parts) | Iyi (frontend route yok) |
| Biosecurity | **Yok** |
| Grading | **Yok** |
| Broodstock/Genetics | **Yok** |
| Vaccination | **Yok** |
