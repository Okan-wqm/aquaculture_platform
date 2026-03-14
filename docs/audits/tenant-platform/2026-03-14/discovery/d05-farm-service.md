# D05 - Farm Service Audit Raporu

**Tarih:** 2026-03-14
**Auditor:** Tenant Platform Audit Ekibi - D5
**Servis:** farm-service (Port 4002)
**Toplam Dosya:** 725
**Durum:** Detayli Inceleme Tamamlandi

---

## 1. GENEL YAPI VE MODUL LISTESI

### 1.1 Dosya Yapisi Ozeti

```
apps/farm-service/src/
  app.module.ts              # Root module - 26 feature module import
  main.ts                    # Bootstrap (port 4002)
  middleware/                # TenantSchemaMiddleware
  filters/                  # GlobalExceptionFilter
  database/                 # CodeGenerator, AuditLog, migrations

  # Core Domain (6 modul)
  farm/                     # Farm + Pond entity
  tank/                     # Tank lifecycle
  batch/                    # Stocking batches (en buyuk modul)
  site/                     # Physical sites
  department/               # Organizational departments
  species/                  # Aquaculture species catalog

  # Operations (7 modul)
  feeding/                  # Feeding programs + daily execution
  feed/                     # Feed types + protocols
  growth/                   # Growth measurements + FCR
  water-quality/            # Water parameter records
  fish-health/              # Health events
  maintenance/              # Maintenance records
  harvest/                  # Harvest plans + records

  # Assets (6 modul)
  equipment/                # Equipment (tanks dahil)
  chemical/                 # Chemical inventory
  supplier/                 # Supplier management
  consumable/               # Consumable items
  storage/                  # Storage locations
  worker/                   # Farm workers

  # System (7 modul)
  system/                   # System/SubSystem entities
  sentinel-hub/             # Satellite imagery
  regulatory/               # Regulatory compliance
  weather/                  # Weather data
  scheduler/                # Cron jobs
  events/                   # NATS event listeners
  task/                     # Task management
```

### 1.2 Kayitli Moduller (app.module.ts - 26 modul)

| # | Modul | Kategori | Aciklama |
|---|-------|----------|----------|
| 1 | DatabaseModule | Core | Code generator, audit log |
| 2 | FarmModule | Core | Farm + Pond CRUD |
| 3 | TankModule | Core | Tank lifecycle |
| 4 | BatchModule | Core | Stocking batches |
| 5 | SiteModule | Core | Physical sites |
| 6 | DepartmentModule | Core | Departments |
| 7 | SpeciesModule | Core | Species catalog |
| 8 | FeedingModule | Operations | Feeding programs + execution |
| 9 | FeedModule | Operations | Feed types + protocols |
| 10 | GrowthModule | Operations | Growth measurements |
| 11 | WaterQualityModule | Operations | Water quality records |
| 12 | FishHealthModule | Operations | Health events |
| 13 | MaintenanceModule | Operations | Maintenance records |
| 14 | HarvestModule | Operations | Harvest plans + records |
| 15 | EquipmentModule | Assets | Equipment management |
| 16 | SupplierModule | Assets | Supplier CRUD |
| 17 | ChemicalModule | Assets | Chemical inventory |
| 18 | ConsumableModule | Assets | Consumable items |
| 19 | InventoryModule | Assets | Storage locations |
| 20 | WorkerModule | Assets | Farm workers |
| 21 | SystemModule | System | System/SubSystem |
| 22 | SentinelHubModule | System | Satellite imagery |
| 23 | RegulatoryModule | System | Regulatory compliance |
| 24 | WeatherModule | System | Weather data |
| 25 | SchedulerModule | System | Cron job scheduling |
| 26 | EventListenersModule | System | NATS event listeners |
| 27 | TaskModule | System | Task management |

---

## 2. CQRS KULLANIMI

### 2.1 CQRS Pattern Analizi

Tum moduller `@platform/cqrs` kullanarak CommandHandler ve QueryHandler pattern'i uyguluyor.
Her modul icin commands/, queries/, handlers/ dizinleri mevcut.

| Modul | Commands | Queries | Handlers | Degerlendirme |
|-------|----------|---------|----------|---------------|
| batch | 14 | 6 | 15+ | Tam CQRS, en zengin modul |
| tank | 4 | 5 | 9 | Tam CQRS |
| farm | 3 | 4 | 5+ | Tam CQRS |
| feeding | 5+ | 4+ | 8+ | Tam CQRS |
| feed | 6 | 4 | 10 | Tam CQRS |
| harvest | 3 | 3 | 7 | Tam CQRS |
| growth | 3+ | 3+ | 5+ | CQRS + Service layer |
| equipment | 4+ | 3+ | 5+ | Tam CQRS |
| species | 3 | 3 | 5+ | Tam CQRS |
| chemical | 5 | 2 | 7 | Tam CQRS |
| supplier | 3 | 2 | 5 | Tam CQRS |
| consumable | 3 | 2 | 5 | Tam CQRS |
| system | 3 | 3 | 6 | Tam CQRS |
| department | 2 | 2 | 4 | Tam CQRS |
| site | 2 | 2 | 4 | Tam CQRS |
| worker | 3 | 1 | 4 | Tam CQRS |

**Degerlendirme:** CQRS kullanimi tutarli ve her module yayilmis durumda. Batch ve feeding
modulleri en karmasik handler'lara sahip. Ozellikle harvest ve batch handler'lari
transaction kullaniyor (QueryRunner pattern).

### 2.2 Onemli Handler'lar ve Transaction Yonetimi

- `CreateBatchHandler`: DataSource.createQueryRunner() ile explicit transaction
- `CreateHarvestRecordHandler`: QueryRunner ile transaction (rollback/commit)
- `RecordMortalityHandler`: Coklu entity guncelleme (Batch, TankBatch, TankOperation, Tank)
  **UYARI:** Transaction kullanmiyor - atomiklik riski var

### 2.3 Bulgu: RecordMortalityHandler Atomiklik Sorunu [ORTA RISK]

`RecordMortalityHandler` birden fazla entity'yi guncelliyor (MortalityRecord, TankOperation,
Batch, TankBatch, Tank/Equipment) fakat bu islemleri transaction icinde yapmIYOR.
`CreateBatchHandler` ve `CreateHarvestRecordHandler` ise dogru sekilde QueryRunner
transaction kullaniyor.

**Etkilenen dosya:** `apps/farm-service/src/batch/handlers/record-mortality.handler.ts`

Bu, bir mortality kaydinda hata olusursa partial update yaratabilir (ornegin Batch guncellendi
ama TankBatch guncellenmedi).

---

## 3. ENTITY ILISKILERI

### 3.1 Ana Iliskiler Zinciri

```
Site (1) --> (N) Department (1) --> (N) Tank
                                        |
Farm (1) --> (N) Pond                   |
                                        v
Species (1) <-- (N) Batch (1) --> (N) TankBatch --> Tank
                        |
                        +--> (N) MortalityRecord
                        +--> (N) GrowthMeasurement
                        +--> (N) FeedingRecord
                        +--> (N) HarvestRecord
                        +--> (N) HarvestPlan
                        +--> (N) BatchDocument
                        +--> (N) TankOperation
                        +--> (N) TankAllocation
                        +--> (N) BatchLocation
                        +--> (N) BatchFeedAssignment

FeedingProgram (1) --> (N) FeedingProgramTank --> Equipment
                 |
                 +--> (N) DailyFeedingExecution

Equipment (1) --> (N) SubEquipment
          +--> (N) EquipmentSystem --> System --> (N) SubSystem
```

### 3.2 Cascade Delete Analizi

| Parent | Child | onDelete | Risk |
|--------|-------|----------|------|
| Farm -> Pond | CASCADE | Farm silinince tum pond'lar silinir |
| Pond -> Batch (eski) | CASCADE | Pond silinince batch'ler silinir |
| Batch -> MortalityRecord | CASCADE | Batch silinince mortality kaybi |
| Batch -> GrowthMeasurement | CASCADE | Batch silinince olcum kaybi |
| Batch -> FeedingRecord | CASCADE | Batch silinince yemleme kaybi |
| Batch -> HarvestRecord | CASCADE | **KRITIK:** Hasat verileri kaybolur |
| Batch -> HarvestPlan | CASCADE | Hasat planlari kaybolur |
| Batch -> BatchDocument | CASCADE | Belgeler kaybolur |
| Batch -> TankOperation | CASCADE | Operasyon gecmisi kaybolur |
| Batch -> TankAllocation | CASCADE | Alokasyon kaybi |
| Department -> Equipment | CASCADE | **KRITIK:** Dept silinince ekipmanlar silinir |
| Department -> Tank | CASCADE | **KRITIK:** Dept silinince tanklar silinir |
| Tank -> WaterQuality | CASCADE | Su kalitesi verileri kaybolur |
| Tank -> TankBatch | CASCADE | Tank silinince batch-tank iliskisi kopar |
| Site -> System | CASCADE | Site silinince tum sistemler silinir |
| FeedingProgram -> DailyExecution | CASCADE | Program silinince gecmis kaybi |
| FeedingProgramTank -> Equipment | CASCADE | Ekipman silinince program kirilir |
| Species -> Batch | RESTRICT | **DOGRU:** Tur silinemez batch varken |
| Feed -> FeedInventory | RESTRICT | **DOGRU:** Yem silinemez stok varken |
| Supplier -> Chemical | SET NULL | Tedarikci silinince null olur |
| HarvestPlan -> HarvestRecord | SET NULL | Plan silinince kayit korunur |
| Batch -> TankBatch (primary) | SET NULL | Birincil batch silinince null |
| Department -> Site | SET NULL | Site silinince dept korunur |

### 3.3 Bulgu: Cascade Delete Zincirleme Silme Riski [YUKSEK RISK]

**Department silindiginde zincirleme etki:**
1. Department silinir
2. CASCADE: Tum Equipment (tanklar dahil) silinir
3. CASCADE: TankBatch silinir
4. CASCADE: TankOperation silinir

**Ancak:** Batch'ler silinmez (batch'in departmentId iliskisi yok).
Bu durum orphaned batch'ler olusturur - tank'i silinmis ama batch hala aktif.

**Oneri:** Department silme islemi soft-delete olarak yapilmali, veya
silme oncesi tum iliskili entity'lerin kontrolu yapilmali.

### 3.4 Bulgu: Dual Tank Yapisi (Equipment vs Tank) [DUSUK RISK]

Sistemde iki ayri tank kavramI var:
- `tanks` tablosu: Dedicated tank entity (`tank/entities/tank.entity.ts`)
- `equipment` tablosu: `isTank=true` olan equipment kayitlari

`RecordMortalityHandler` ve `CreateBatchHandler` her ikisini de kontrol eden
`findTankOrEquipment()` utility fonksiyonu kullaniyor. Bu dual yapI tutarli
kullaniliyor fakat karmasiklik ekliyor.

---

## 4. FEEDING MODULU

### 4.1 Yem Takibi Yapisi

```
FeedingProgram (ana program)
  |
  +--> FeedAssignment[] (JSONB - agirlik araligina gore yem atamasi)
  +--> FCRTable (JSONB - Sicaklik x Agirlik FCR matrisi)
  +--> ProgramSettings (JSONB)
  |
  +--> FeedingProgramTank (M2M - programa bagli tanklar)
        |
        +--> DailyFeedingExecution (gunluk plan + gerceklesme)
              +--> ExecutionCalculation (JSONB - planlanan)
              +--> ExecutionResult (JSONB - gerceklesen)

FeedInventory (site/departman bazli yem stoku)
FeedingRecord (bireysel yemleme kayitlari)
```

### 4.2 Yem Stok Yonetimi

`FeedInventory` entity'si site/departman bazinda yem stoku takip eder:
- `quantityKg`: Mevcut stok miktari
- `minStockKg`: Minimum stok seviyesi
- `status`: AVAILABLE / LOW_STOCK / OUT_OF_STOCK / EXPIRED
- `lotNumber`: Parti numarasi
- `expiryDate`: Son kullanma tarihi

`AdjustFeedInventoryHandler` stok duzeltmesi yapar:
- INCREASE: Stok artirma
- DECREASE: Stok azaltma (negatif kontrol MEVCUT)
- SET_QUANTITY: Direkt miktar atama (negatif kontrol MEVCUT)

### 4.3 Bulgu: Stok Negatife Dusme Kontrolu [OLUMLU]

`AdjustFeedInventoryHandler` (satir 45-54) acikca negatif stok kontrolu yapiyor:
```typescript
if (newQuantity < 0) {
  throw new BadRequestException(
    `Stok negatif olamaz. Mevcut: ${currentQuantity} kg, Azaltma: ${payload.quantity} kg`
  );
}
```

Ancak bu kontrol sadece DECREASE isleminde var. Feeding execution sirasinda stoktan
otomatik dusme mekanizmasi gorulmuyor - stok dusumu muhtemelen manuel.

### 4.4 Maliyet Hesaplama

Batch entity'de maliyet takibi:
- `totalFeedConsumed`: decimal(15,2) - toplam yem tuketimi (kg)
- `totalFeedCost`: decimal(15,2) - toplam yem maliyeti
- `costPerKg`: decimal(10,2) - kg basina maliyet

FeedInventory'de fiyat:
- `unitPricePerKg`: decimal(15,2) - kg basina fiyat
- `totalValue`: decimal(15,2) - toplam deger

### 4.5 Bulgu: Floating Point Precision [OLUMLU]

Tum finansal alanlar `decimal` tipi kullaniyor (JavaScript `number` degil).
TypeORM `decimal` tipi PostgreSQL `NUMERIC` tipine donusuyor ve bu floating
point sorunlarini onluyor.

Ancak `DecimalTransformer` sadece `FeedingProgram.totalFeedConsumed` alaninda
tanimli. Diger decimal alanlarda transformer kullanilmiyor - bu alanlar
PostgreSQL'den string olarak donebilir ve JavaScript'te yanlis hesaplamalara
yol acabilir.

### 4.6 Bulgu: Decimal-to-Number Donusum Riski [ORTA RISK]

`RecordMortalityHandler` ve `CreateHarvestRecordHandler` icinde explicit
`Number()` cagrilari var (ornegin `Number(tankBatch.totalBiomassKg)`).
Bu, PostgreSQL'in decimal kolonlari string olarak dondugunu gosteriyor.
Tum handler'larda tutarli `Number()` donusumu yapilmis - iyi uygulama.

---

## 5. GROWTH TRACKING

### 5.1 Buyume Olcumu Yapisi

`GrowthMeasurement` entity'si detayli buyume takibi saglar:
- **Sample-based olcum:** `individualMeasurements` (JSONB) ile bireysel agirliklar
- **Istatistiksel ozet:** `statistics` (JSONB) - mean, median, stdDev, CV, 95% CI
- **Buyume karsilastirmasi:** `growthComparison` (JSONB) - teorik vs gercek
- **FCR analizi:** `fcrAnalysis` (JSONB) - periyodik ve kumulatif FCR
- **Onerilen aksiyonlar:** `suggestedActions` (JSONB) - otomatik oneriler

### 5.2 FCR Hesaplama Servisi

`FCRCalculationService` kapsamli FCR analizi yapar:
- **Periyodik FCR:** Belirli tarih araliginanin FCR'i
- **Kumulatif FCR:** Batch basindan itibaren toplam FCR
- **Trend analizi:** Lineer regresyon ile FCR trendi (improving/stable/declining)
- **Anomali tespiti:** Anormal FCR degerleri icin uyarilar
- **Endustri karsilastirmasi:** Tur bazli endustri ortalama FCR'ler

FCR formulleri:
```
FCR = Verilen Yem (kg) / Canli Agirlik Artisi (kg)
SGR = [(ln(Wf) - ln(Wi)) / t] * 100
```

### 5.3 SGR Calculator Service

`SGRCalculatorService` Specific Growth Rate hesaplar:
- Periyodik SGR hesaplama
- Trend analizi (son 3 vs ilk 3 olcum karsilastirmasi)
- Batch karsilastirmasi (birden fazla batch icin SGR ranking)
- Tur bazli hedef SGR degerleri (hardcoded tablo)

### 5.4 Biomass Calculator Service

`BiomassCalculatorService` biyokutle hesaplamalari:
- Temel biomass: `quantity * avgWeightG / 1000`
- Guven seviyesi: Son olcumun yasina gore (7 gun: high, 21 gun: medium, >21: low)
- Tank yogunluk analizi: `currentBiomassKg / volumeM3`
- Site toplam biyokutle raporu (N+1 query optimize edilmis)
- Biyokutle projeksiyonu (gunluk buyume + mortality orani ile)

### 5.5 Bulgu: Division-by-Zero Korumalari [OLUMLU]

Hesaplama servisleri division-by-zero'ya karsi korunmus:
- `DailyFeedingExecution.recordActualFeeding()`: `fcr === 0` ve `fishCount === 0` kontrolu
- `FCRCalculationService.linearRegression()`: Denominator kontrolu
- `GrowthMeasurement.calculateStatistics()`: `n-1 === 0` kontrolu (tekli orneklem)
- `FCRCalculationService.calculatePeriodFCR()`: `growthKg <= 0` kontrolu

### 5.6 Bulgu: getTargetFCR Stub Implementasyonu [DUSUK RISK]

`FCRCalculationService.getTargetFCR()` (satir 532-537) her zaman sabit 1.5
donduruyor. Batch veya Species'ten gercek hedef FCR'yi almIYOR.
Bu, FCR performans degerlendirmelerinin her zaman 1.5 bazli yapilmasina neden oluyor.

---

## 6. HARVEST MODULU

### 6.1 Hasat Plani ve Kayit

Iki entity ile hasat yonetimi:

**HarvestPlan** (hasat planlama):
- Status: DRAFT -> PLANNED -> APPROVED -> SCHEDULED -> IN_PROGRESS -> COMPLETED
- `criteria`: Hedef agirlik, miktar, kalite
- `estimates`: Tahmini miktar, biomass, agirlik
- `financialProjection`: Tahmini gelir, maliyet, kar
- `logistics`: Ekipman, personel, transport
- `customerOrder`: Musteri/siparis eslestirme

**HarvestRecord** (gerceklesen hasat):
- Status: IN_PROGRESS -> COMPLETED -> QUALITY_CHECK -> DISPATCHED -> DELIVERED
- `operation`: Hasat operasyon detaylari
- `sizeDistribution`: Boy dagilimi (XS/S/M/L/XL/XXL)
- `qualityControl`: Kalite kontrol sonuclari
- `lotInfo`: Lot/parti bilgileri (izlenebilirlik)
- `yieldCalculation`: Verim hesabi (brut -> net)
- `customerDeliveries`: Musteri sevkiyat
- `shipment`: Sevkiyat bilgileri

### 6.2 CreateHarvestRecordHandler Analizi

Handler transaction kullanarak asagidaki islemleri yapiyor:
1. HarvestRecord olusturma
2. TankOperation kaydI olusturma
3. Batch guncelleme (currentQuantity azaltma, harvestedQuantity artirma)
4. TankBatch guncelleme (quantity, biomass, density)
5. Tank guncelleme (currentBiomass, currentCount)

### 6.3 Bulgu: Harvest Transaction Kullanimi [OLUMLU]

`CreateHarvestRecordHandler` dogru sekilde `queryRunner.startTransaction()` ile
tum write islemlerini atomik yapiyor. Hata durumunda `rollbackTransaction()` cagriliyor.

### 6.4 Bulgu: Harvest Sonrasi Batch Status Guncellenmesi [ORTA RISK]

`CreateHarvestRecordHandler` batch'in `currentQuantity`'sini azaltiyor ve
`harvestedQuantity`'sini artiriyor, ancak batch status'unu otomatik olarak
HARVESTING veya HARVESTED'a gecirMIYOR. Bu ayri bir `UpdateBatchStatusCommand`
ile yapilmasi gerekiyor.

`currentQuantity === 0` durumunda (tam hasat) batch'in otomatik olarak
HARVESTED'a gecirilmemesi, batch'in surekli ACTIVE/GROWING'de kalmasi riskini
olusturuyor.

---

## 7. BATCH LIFECYCLE

### 7.1 Status Gecis Matrisi

```
QUARANTINE --> ACTIVE --> GROWING --> PRE_HARVEST --> HARVESTING --> HARVESTED --> CLOSED
     |           |          |                           |
     |           |          +--> TRANSFERRED ---------->+--> CLOSED
     |           |          |                           |
     +--> FAILED +--> FAILED +--> FAILED ---------> FAILED --> CLOSED
```

`canTransitionTo()` metodu entity'de tanimli ve tum gecerli gecisleri kontrol ediyor.

### 7.2 Status Gecis Validasyonu [OLUMLU]

`UpdateBatchStatusHandler`:
- `batch.canTransitionTo(newStatus)` ile gecerli gecis kontrolu
- Gecersiz gecislerde `BadRequestException`
- Status'a gore ek islemler (ornegin HARVESTED -> actualHarvestDate atama)
- Domain event yayinlama (`BatchStatusChanged`)

### 7.3 CloseBatchHandler Analizi

Batch kapama islemi detayli:
- Final metrikleri hesaplama (quantity, biomass, mortality rate, FCR, SGR)
- Close reason'a gore onceki status kontrolu
- Status'u CLOSED'a gecirme
- Hasat tamamlanmissa actualHarvestDate atama

### 7.4 Bulgu: Close Batch - isActive Flag Guncellenmiyor [DUSUK RISK]

`CloseBatchHandler` batch status'unu CLOSED yapiyor ama `isActive` flag'ini
`false` yapmIYOR (satir 66 yorum satiri: `// batch.isActive = false; // Istege bagli`).
Bu, kapali batch'lerin `isActive=true` filtresine takilmasina neden olabilir.

### 7.5 Bulgu: QUARANTINE -> ACTIVE Gecisinde Islem Eksikligi [DUSUK RISK]

`UpdateBatchStatusHandler` satir 70-73'te QUARANTINE -> ACTIVE gecisi icin
"ilk operasyonel gun baslangici" yorumu var ama hicbir islem yapilmiyor.
Bu, uretim gunlerinin dogru hesaplanmasini etkileyebilir.

---

## 8. EQUIPMENT / CHEMICAL / SUPPLIER

### 8.1 Equipment

`Equipment` entity'si tum fiziksel ekipmanlari (tanklar dahil) yonetiyor:
- Self-referencing hierarchy: `parentEquipmentId`
- Equipment-System M2M: `EquipmentSystem` junction table
- Tank-specific: `isTank` flag, `specifications` JSONB icinde `TankSpecifications`
- Soft delete: `isDeleted`, `deletedAt`, `deletedBy`
- Optimistic locking: `@VersionColumn()`

Status'lar: OPERATIONAL, MAINTENANCE, REPAIR, OUT_OF_SERVICE, DECOMMISSIONED, STANDBY
+ Tank-specific: ACTIVE, PREPARING, CLEANING, HARVESTING, FALLOW, QUARANTINE

### 8.2 Chemical

`Chemical` entity'si kimyasal envanter yonetimi:
- Tip bazli siniflandirma (12 tip: disinfectant, antibiotic, vitamin, vb.)
- Stok takibi: `quantity`, `minStock`, `unit`
- Guvenlik bilgileri: `safetyInfo` (JSONB), `usageProtocol` (JSONB)
- Arinma suresi: `withdrawalPeriodDays` (hasat oncesi bekleme)
- Belge yonetimi: `documents` (JSONB)
- Depolama kosullari: sicaklik/nem araliklari
- Son kullanma tarihi kontrolu
- Soft delete destegi

### 8.3 Supplier

`Supplier` entity'si tedarikci yonetimi:
- Site bazli onay: `SupplierSite` junction table
- Tur bazli siniflandirma: `SupplierType` entity
- Seed data: Onceden tanimli tedarikci turleri
- Soft delete destegi

### 8.4 Bulgu: Kimyasal Stok Negatif Kontrolu [OLUMLU]

`Chemical.updateStockStatus()` metodu `quantity <= 0` kontrolu yapiyor.
Ancak kimyasal tuketim isleminde negatif kontrol yapilip yapilmadigi
incelenmeli (handler kodu mevcut dosyalarda bulunamadi).

---

## 9. TENANT SCHEMA ISOLATION

### 9.1 Middleware Zinciri

```
CorrelationIdMiddleware -> UserContextMiddleware -> TenantContextMiddleware -> TenantSchemaMiddleware
```

### 9.2 TenantSchemaMiddleware Analizi

**Ozellikler:**
- UUID format validasyonu (SQL injection onleme)
- LRU cache ile schema varlik kontrolu (1000 entry, 5 dk TTL)
- `search_path = "tenant_xxx", farm, public` siralamasi
- Response `finish` event'inde `RESET search_path` (connection pool temizligi)
- Schema yoksa `farm` schema'ya fallback

**Schema adlandirma:** `tenant_` + ilk 16 karakter (tire olmadan)
Ornek: `4b529829-ea79-...` -> `tenant_4b529829ea7948da`

### 9.3 Bulgu: Schema Fallback Riski [YUKSEK RISK]

Schema bulunamazsa `farm` schema'ya fallback yapiyor (satir 107-110).
Bu durumda tenant-specific veriler shared `farm` schema'ya yazilir ve
diger tenant'lar tarafindan gorulebilir.

Log'da uyari mesaji var ama islem engellenmIYOR:
```
this.logger.warn(`Tenant ${tenantId}: schema "${tenantSchema}" not found, using fallback`);
```

**Oneri:** Fallback yerine `UnauthorizedException` firlatilmali.

### 9.4 Bulgu: Entity'lerde Schema Tanimlanmamis [OLUMLU]

Tum entity decorator'lerinde `{ schema: 'xxx' }` KULLANILMIYOR.
Bu dogru yaklasim - schema izolasyonu tamamen search_path ile saglaniyor.

### 9.5 Bulgu: tenantId Filtreleme Tutarliligi [OLUMLU]

Incelenen tum handler'larda `where: { id: xxx, tenantId }` pattern'i tutarli
kullaniliyor. Tenant veri sizintisi riski dusuk.

---

## 10. GRAPHQL FEDERATION

### 10.1 Federation Konfigurasyonu

- Driver: `ApolloFederationDriver` (Federation v2)
- `autoSchemaFile: { federation: 2 }`
- Production'da playground ve introspection KAPALI
- Context'te gateway'den gelen `x-user-payload` header'i parse ediliyor

### 10.2 Security Onlemleri [OLUMLU]

- `ValidationPipe`: whitelist + forbidNonWhitelisted + transform
- Production'da validation error mesajlari gizli
- CORS: Wildcard (`*`) reddediliyor, explicit origin listesi zorunlu
- Helmet middleware: CSP, HSTS, X-Frame-Options
- SSL konfigurasyonu: Production'da certificate validation

---

## 11. TEST DURUMU

### 11.1 Test Dosyalari

| Dosya | Tip | Modul |
|-------|-----|-------|
| batch/handlers/create-batch.handler.spec.ts | Unit | Batch |
| batch/handlers/record-mortality.handler.spec.ts | Unit | Batch |
| batch/integration/batch-lifecycle.integration.spec.ts | Integration | Batch |
| batch/integration/tank-operations.integration.spec.ts | Integration | Batch |
| batch/services/batch.service.spec.ts | Unit | Batch |
| batch/services/biomass-calculator.service.spec.ts | Unit | Batch |
| batch/services/sgr-calculator.service.spec.ts | Unit | Batch |
| database/audit-log.service.spec.ts | Unit | Database |
| database/base.entity.spec.ts | Unit | Database |
| database/code-generator.service.spec.ts | Unit | Database |
| farm/create-farm.handler.spec.ts | Unit | Farm |
| farm/list-farms.handler.spec.ts | Unit | Farm |
| growth/services/fcr-calculation.service.spec.ts | Unit | Growth |
| health/health.controller.spec.ts | Unit | Health |

**Toplam:** 14 test dosyasi

### 11.2 Test Kapsam Analizi

| Modul | Unit Test | Integration Test | Durumu |
|-------|-----------|------------------|--------|
| batch | 5 | 2 | IYI |
| database | 3 | 0 | ORTA |
| farm | 2 | 0 | DUSUK |
| growth | 1 | 0 | DUSUK |
| health | 1 | 0 | DUSUK |
| feeding | 0 | 0 | YOK |
| harvest | 0 | 0 | YOK |
| tank | 0 | 0 | YOK |
| equipment | 0 | 0 | YOK |
| chemical | 0 | 0 | YOK |
| supplier | 0 | 0 | YOK |
| species | 0 | 0 | YOK |
| system | 0 | 0 | YOK |

### 11.3 Bulgu: Yetersiz Test Kapsami [YUKSEK RISK]

725 dosyalik serviste sadece 14 test dosyasi var.
26 modulden sadece 4'u (batch, database, farm, growth) test'e sahip.

**Kritik eksik testler:**
- Feeding modulu (yem stok negatif kontrolu, FCR hesaplama)
- Harvest modulu (hasat-batch iliskisi, transaction rollback)
- Tank modulu (status gecisleri, kapasite kontrolu)
- TenantSchemaMiddleware (schema izolasyonu)
- Species modulu (RESTRICT cascade davranisi)

---

## 12. VERI BUTUNLUGU ANALIZI

### 12.1 Batch Lifecycle: Active -> Harvest -> Closed

| Adim | Islem | Durum |
|------|-------|-------|
| Batch olusturma | CreateBatchHandler (transaction) | DOGRU |
| Status gecisi | canTransitionTo() validasyonu | DOGRU |
| Mortality kaydi | RecordMortalityHandler (NO transaction) | RISKLI |
| Hasat kaydi | CreateHarvestRecordHandler (transaction) | DOGRU |
| Batch kapama | CloseBatchHandler | DOGRU |
| Batch otomatik kapama | Manuel (otomatik degil) | EKSIK |

### 12.2 Stok Tutarliligi

| Kontrol | Durum |
|---------|-------|
| Yem stok negatif kontrolu (DECREASE) | MEVCUT |
| Yem stok negatif kontrolu (SET_QUANTITY) | MEVCUT |
| Mortality > currentQuantity kontrolu | MEVCUT |
| Harvest > currentQuantity kontrolu | MEVCUT |
| Harvest > tankBatch quantity kontrolu | MEVCUT |
| Feeding execution stok dusumu | OTOMATIK DEGIL |
| Kimyasal stok negatif kontrolu | Entity method'da mevcut, handler'da belirsiz |

### 12.3 Maliyet Hesaplama

| Alan | Tip | Precision | Durum |
|------|-----|-----------|-------|
| totalFeedCost | decimal(15,2) | 2 basamak | DOGRU |
| costPerKg | decimal(10,2) | 2 basamak | DOGRU |
| purchaseCost | decimal(15,2) | 2 basamak | DOGRU |
| unitPricePerKg | decimal(15,2) | 2 basamak | DOGRU |
| totalRevenue | decimal(15,2) | 2 basamak | DOGRU |
| harvestCost | decimal(15,2) | 2 basamak | DOGRU |

**Deger:** Tum finansal alanlar PostgreSQL NUMERIC(15,2) kullaniyor - floating point
precision sorunu YOK.

### 12.4 Cascade Delete Ozeti

| Senaryo | Risk | Etki |
|---------|------|------|
| Farm silme | YUKSEK | Tum pond'lar CASCADE ile silinir |
| Department silme | YUKSEK | Tum tank ve equipment CASCADE ile silinir |
| Batch silme | YUKSEK | Tum hasat, buyume, yemleme verileri silinir |
| Species silme | DUSUK | RESTRICT ile engellenir (batch varken) |
| Feed silme | DUSUK | RESTRICT ile engellenir (inventory varken) |

---

## 13. BULGU OZETI VE ONCELIK

### Yuksek Risk (3)

| # | Bulgu | Etki | Dosya |
|---|-------|------|-------|
| H1 | Schema fallback farm'a yazma | Tenant veri sizintisi | tenant-schema.middleware.ts |
| H2 | Department cascade tank silme | Veri kaybi | department.entity.ts, equipment.entity.ts |
| H3 | Yetersiz test kapsami (14/725) | Regresyon riski | Tum servis |

### Orta Risk (3)

| # | Bulgu | Etki | Dosya |
|---|-------|------|-------|
| M1 | RecordMortality transaction yok | Partial update | record-mortality.handler.ts |
| M2 | Harvest sonrasi batch status guncellenmiyor | Yanlis durum | create-harvest-record.handler.ts |
| M3 | Decimal-to-string donusum | Hesaplama hatasi potansiyeli | Tum handler'lar |

### Dusuk Risk (4)

| # | Bulgu | Etki | Dosya |
|---|-------|------|-------|
| L1 | CloseBatch isActive=true kaliyor | Filtreleme hatasi | close-batch.handler.ts |
| L2 | QUARANTINE->ACTIVE gecisinde islem yok | Uretim gun sayisi | update-batch-status.handler.ts |
| L3 | getTargetFCR stub (sabit 1.5) | Yanlis performans degerlendirmesi | fcr-calculation.service.ts |
| L4 | Dual tank yapisi (Equipment vs Tank) | Bakım karmasikligi | batch/utils/tank-lookup.util.ts |

### Olumlu Bulgular (6)

| # | Bulgu | Dosya |
|---|-------|-------|
| P1 | CQRS pattern tutarli kullanim | Tum moduller |
| P2 | Stok negatif kontrolleri mevcut | adjust-feed-inventory.handler.ts |
| P3 | Decimal precision dogru | Tum entity'ler |
| P4 | Division-by-zero korumalari | Hesaplama servisleri |
| P5 | TenantId filtreleme tutarli | Tum handler'lar |
| P6 | Transaction kullanimi (batch, harvest) | create-batch, create-harvest-record |

---

## 14. ONERILERE GENEL BAKIS

1. **TenantSchemaMiddleware:** Fallback'i kaldir, schema bulunamazsa 403 don
2. **RecordMortalityHandler:** QueryRunner transaction ekle
3. **CloseBatchHandler:** `isActive = false` yap
4. **CreateHarvestRecordHandler:** `currentQuantity === 0` ise batch status guncelle
5. **FCRCalculationService:** `getTargetFCR()` gercek implementasyon yaz
6. **Cascade delete:** Department icin soft-delete veya pre-delete kontrol ekle
7. **Test:** Feeding, harvest, tank modulleri icin testler yaz
8. **DecimalTransformer:** Tum decimal alanlara uygulanmali

---

*Rapor Sonu - D05 Farm Service Audit*
*Toplam: 725 dosya, 26 modul, 14 test dosyasi*
*3 Yuksek, 3 Orta, 4 Dusuk risk bulgusu + 6 olumlu bulgu*
