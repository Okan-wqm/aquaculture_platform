# Farm Modülü — Kör Noktalar ve Doğrulama Kaydı

Bu doküman `farm-modulu-sema-gorsel.md` ve `farm-modulu-sema-anlatim.md` üzerinde yapılan eleştirel yorumların **kodla doğrulanmış** sonuçlarını tutar. Her girdi: (1) yorum metni, (2) kaynak koddan doğrulama, (3) sonuç (geçerli gap / kısmen geçerli / geçersiz), (4) dokümana ne eklenmeli.

Amaç: tespit edilen her kör nokta ve hata tek bir yerden takip edilsin. Doküman iteratif olarak büyütülür.

---

## Girdi 1 — Sayısal Tutarsızlıklar

**Yorum:**
- "70 tablo" / "69 farm + 1 public" sayımları tutarlı görünüyor ama §21.5'te `farms` ve `ponds` legacy tabloları sayılıyor — 69'a dahil mi belirsiz.
- "3 REST controller" deniyor ama §2'de yalnız `BatchController` "gerçek domain" sayılıyor — efektif domain controller 1.

**Kod doğrulaması:**

```bash
find apps/farm-service/src -name "*.controller.ts"
# → batch.controller.ts, health.controller.ts, sentinel-hub-proxy.controller.ts (3 adet)

ls apps/farm-service/src/farm/entities/
# → farm.entity.ts, pond.entity.ts (legacy entity dosyaları mevcut)
```

- **Legacy farms/ponds entity dosyaları var.** TypeORM `synchronize()` runtime'da bu entity'lerden tablo oluşturur. Yani `farm.farms` ve `farm.ponds` tabloları gerçekte **farm şemasında var** ve 70'e dahildir.
- REST controller'lar: 3 adet, ama:
  - `BatchController` — gerçek domain yazımı (`/api/batches`, `/api/tank-operations/*`)
  - `HealthController` — liveness/readiness, domain yazmaz
  - `SentinelHubProxyController` — uydu verisi proxy, yazmaz

**Sonuç:** ✅ Yorum geçerli. İki gap:

1. Legacy `farms` + `ponds` tabloları 70'e dahil ama §21.5'te "kullanılmıyor / yeni veri gelmiyor" deniyor. Sayımda vardır ama yaşam döngüsünde yoktur ayrımı net değil.
2. "3 REST controller" zorunlu olarak 3 domain yazımı demek değil. Efektif domain yazan 1 (BatchController).

**Dokümana eklenmeli:**
- Tablo sayımı "toplam 70 entity, bunların X'i legacy / unused" olarak parçalanmalı.
- REST: "3 controller (1 domain-writing: BatchController; 2 read/proxy-only)" olarak netleştirilmeli.

---

## Girdi 2 — Tank ve Equipment Çelişkisi (Büyük Hata)

**Yorum:**
- §4.5'te "TankResolver.createTank → farm.equipment (is_tank=true) ve farm.tanks alias'lı view olarak görülür" deniyor.
- §5.3'te ise "farm.tanks — her tankın current_biomass_kg sütunu UPDATE" deniyor.
- View UPDATE edilemez. Çelişki.

**Kod doğrulaması:**

```sql
-- database/migrations/modules/farm/V002__add_production_tables.sql
CREATE TABLE IF NOT EXISTS farm.tanks (
  id UUID PRIMARY KEY ...,
  site_id UUID REFERENCES farm.sites(id) ON DELETE SET NULL,
  department_id UUID REFERENCES farm.departments(id) ...,
  system_id UUID REFERENCES farm.systems(id) ...,
  name VARCHAR(255) NOT NULL,
  code VARCHAR(50),
  tank_type VARCHAR(50) NOT NULL DEFAULT 'circular',
  ...
);
```

```ts
// apps/farm-service/src/tank/entities/tank.entity.ts
@Entity('tanks', { schema: 'farm' })
export class Tank { ... }

// apps/farm-service/src/equipment/entities/equipment.entity.ts
@Entity('equipment', { schema: 'farm' })
@Index(['tenantId', 'isTank'])
export class Equipment {
  @Column({ default: false })
  isTank: boolean;
  ...
}
```

```ts
// apps/farm-service/src/batch/handlers/create-batch.handler.ts
// YORUMLAR:
// "Equipment table first — primary source of truth"
// "Tank fallback — ONLY the IDs not found in Equipment"
// "Legacy tank updates use an explicit queryBuilder UPDATE"
// "raw UPDATE because the adapted entity cannot be saved"

@InjectRepository(Equipment) private equipmentRepository: Repository<Equipment>,
// Tank repository da inject edilir, serial UPDATE ile çalışır.
```

**Sonuç:** 🔴 **Doğrulandı — büyük hata.** `farm.tanks` ve `farm.equipment` **iki ayrı gerçek tablo.** View değil, alias değil. Equipment tablosu yeni "source of truth", tanks tablosu legacy fallback. createBatch handler:
- Önce Equipment tablosuna ID'lerle bakar.
- Equipment'ta bulamadığı ID'ler için Tank tablosunda fallback arar.
- İki tabloyu da UPDATE eder (Equipment'i `save()`, Tank'ı raw `queryBuilder.update()` ile — `dört ayrı round-trip`).

**Dokümana eklenmeli:**
- `farm.tanks` ve `farm.equipment` iki ayrı gerçek tablo, ilişkileri açıklanmalı (çift-yazım, primary + fallback pattern).
- Tank entity için `§5.1` içindeki "= farm.equipment with is_tank=true" ifadesi YANLIŞ — düzeltilmeli.
- Bu yeni bir **legacy çiftli** (benzer şekilde farms↔sites, batches↔batches_v2, ponds↔tanks). Legacy tablo çiftleri listesine eklenmeli (§22.7).
- Denormalization riski: aynı tank iki yerde tutuluyor, senkron olmazsa tutarsızlık doğar.

---

## Girdi 3 — "Tek Mutation 8 Tablo" Pratik Boyutu Tartışılmamış

**Yorum:**
- §5.3'te createBatch'in 8 tabloya yazdığı söyleniyor ama lock contention, transaction süresi, rollback maliyeti, deadlock handling tartışılmamış.

**Kod doğrulaması:**

```ts
// create-batch.handler.ts:82-84
const queryRunner = this.dataSource.createQueryRunner();
await queryRunner.connect();
await queryRunner.startTransaction();
// → izolasyon seviyesi belirtilmemiş (PostgreSQL default: READ COMMITTED)
```

Handler içindeki kendi yorumları (satır 250-265, 342-347):

```
// 10 locations ~ 40-50 serial round-trips while the batch row and
// all downstream rows held write locks — 350 ms per call in
// production measurements (P-H3, comprehensive review).

// Legacy tank updates use an explicit queryBuilder UPDATE
// because Tank entity uses a flat schema ...
// raw UPDATE because the adapted entity cannot be saved
// ... keep them serial since bulk UPDATE with per-row values
// would require a CASE WHEN UPDATE
```

- **Ölçülmüş gerçek süre:** 350 ms transaction (10 lokasyon için)
- **Optimizasyon**: Bulk pre-fetch ile 350 ms → 80 ms indirilmiş
- **İzolasyon seviyesi**: default (READ COMMITTED)
- **Explicit deadlock handling yok**: try/catch var ama deadlock için özel retry yok
- **Retry stratejisi yok**: rollback olur, kullanıcıya hata döner; client tekrar çağırır
- **Tank tablosunun UPDATE'i serial queryBuilder ile** → büyük allocation array'lerinde sıcak nokta

**Sonuç:** ✅ Yorum geçerli. Kod içinde uyarı yorumları var ama üst-düzey dokümanlarda (gorsel/anlatim) tartışılmamış.

**Dokümana eklenmeli:**
- Transaction süresi (80–350 ms) ve izolasyon seviyesi (READ COMMITTED).
- Deadlock handling yok, retry client'a bırakılmış.
- Bulk allocation durumunda Tank tablosunun serial UPDATE'i bir scaling bottleneck'i. Code comment'ler bu bilinen bir yüktür diyor.
- PessimisticLock sadece CodeGenerator içinde (code_sequences tablosu); batch/tank yazımları standard DB lock kullanır.

---

## Girdi 4 — Outbox Pattern Eksik Anlatılmış

**Yorum:**
- Poll interval, retry/backoff, tablo büyümesi, NATS down davranışı, cleanup süreci belgelenmemiş.

**Kod doğrulaması:** `platform/libs/outbox/src/outbox-worker.service.ts` okundu.

```ts
@Cron(CronExpression.EVERY_5_SECONDS, { name: 'outbox-poll' })
async pollAndPublish(): Promise<void> { ... }

@Cron('0 3 * * *', { name: 'outbox-cleanup' })
async cleanupPublished(): Promise<void> {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  await this.repo.delete({ publishedAt: LessThan(sevenDaysAgo) });
}
```

Detaylar (koddan):
- **Çift yakma-uyanma modeli**: PostgreSQL `LISTEN/NOTIFY` ~5 ms medyan latency (primary) + 5 saniyede bir cron (safety net)
- **Row lease mekanizması**: `FOR UPDATE SKIP LOCKED`, `leasedAt` + `leasedBy`, 5 dakikalık lease süresi (OUTBOX_LEASE_DURATION_MS default)
- **Multi-replica concurrency**: N replica ≈ N× throughput, linearly sharded
- **Bounded publish concurrency**: `OUTBOX_PUBLISH_CONCURRENCY` default 20, tek NATS TCP connection'ı üzerinde multiplex
- **Batched commit**: Başarılı publish'lar tek UPDATE IN (...) ile mark edilir
- **Exponential backoff**: `2000 * 2^retryCount + jitter(0–1000)ms`
- **Retry limiti**: `OUTBOX_MAX_RETRIES`, aşılırsa `isDeadLettered = true` (tablo'da kalır, forensic inceleme için)
- **NATS down davranışı**: `onApplicationBootstrap` içinde connect denemesi başarısız olsa **service crash olmaz** — sonraki poll döngüsünde tekrar denenir
- **Cleanup**: Her gece 03:00'te `publishedAt < 7 gün` olan satırlar DELETE edilir. Dead-letter satırları silinmez.
- **NATS JetStream backstop**: `duplicate_window` 2 dk — lease pattern'i bypass eden yarış durumlarını yakalar
- **Metrics**: `outbox_pending`, `outbox_dead_letter_count` Prometheus gauge'ları her cycle'da güncellenir

**Sonuç:** ✅ Yorum tam geçerli. Mevcut dokümanda HİÇBİRİ yok, sadece "outbox → worker → NATS" şeklinde bir-iki cümle var.

**Dokümana eklenmeli:**
- Poll: 5 sn cron + LISTEN/NOTIFY (~5 ms median)
- Retry: exponential backoff 2s * 2^n + jitter, max retries aşılırsa dead-letter
- Cleanup: 7 gün retention, 03:00 nightly
- NATS down: bootstrap failure service'i crash etmez
- Multi-replica: SKIP LOCKED ile otomatik paylaşım
- Dead-letter: `isDeadLettered=true`, `outbox_dead_letter_count` metric ile izlenir

---

## Girdi 5 — FEFO Kuralı Uygulama Boşlukları

**Yorum:**
- Tiebreaker (iki lot aynı expiry)
- Expired lot handling
- Backdating ile FEFO zaman mismatch'i

**Kod doğrulaması:** `apps/farm-service/src/storage/handlers/record-stock-movement.handler.ts:370-419` + `apps/farm-service/src/storage/event-handlers/feeding-storage-event.handler.ts:117-127`

İki farklı yerde aynı desen:

```ts
inventory = await repo
  .createQueryBuilder('inv')
  .where('inv.tenantId = :tenantId', { tenantId })
  .andWhere('inv.itemType = :itemType', { itemType })
  .andWhere('inv.itemId = :itemId', { itemId })
  .andWhere('inv.quantity > 0')
  .orderBy('inv.expiryDate', 'ASC', 'NULLS LAST')
  .setLock('pessimistic_write')
  .getOne();
```

**Bulgular:**

1. **Tiebreaker yok**: `ORDER BY expiryDate ASC NULLS LAST` — iki lot aynı `expiryDate` değerine sahipse PostgreSQL implementation-defined sıra seçer (genellikle fiziksel satır sırası). Deterministik değil. Aynı kod iki kez koşarsa farklı lot seçilebilir.

2. **Expired lot filtrelenmiyor**: `WHERE expiryDate > NOW()` gibi bir kısıt **yok**. Kullanım süresi dolmuş bir lot `expiryDate ASC` sırasında en başta yer alır, dolayısıyla **otomatik olarak önce tüketilmeye çalışılır**. Bu:
   - Balık sağlığı riski (feed)
   - Etkinlik kaybı (chemical)
   - Yasal ihlal (healthcare)
   
   Kodda yorumla "prevents fish from receiving expired feed" denmiş ama implementation bunu zorlayamıyor.

3. **Backdating ile mismatch**: Event handler `getOne()` çağrıldığında "şu anki" inventory durumunu sorgular. Eğer `feedingDate` dünün tarihi ise, bugünün inventory durumu dünün gerçeğini yansıtmayabilir (örneğin dün mevcut olan bir lot bugün tükenmiş olabilir). FEFO seçimi **"olayın gerçekleştiği tarih"** yerine **"komutun çalıştığı tarih"** üzerinden yapılır.

**Sonuç:** ✅ Yorum tam geçerli, üç ayrı somut bug/gap var. İkincisi (expired lot) potansiyel güvenlik sorunu.

**Dokümana eklenmeli:**
- FEFO sorgusu deterministik değil (tiebreaker yok).
- Expired lot filtrelenmiyor → süresi geçmiş lot otomatik kullanıma girer.
- Backdating senaryosu ele alınmamış → olay tarihi vs komut tarihi ayrımı yok.

---

## Girdi 6 — Soft Delete ve FK Çelişkisi

**Yorum:**
- Soft delete (is_deleted=true) + FK constraint (RESTRICT/CASCADE) birlikte çalışır mı?

**Kod doğrulaması:**

```ts
// species.entity.ts:544
isDeleted: boolean;

// species.entity.ts:741-752
softDelete(deletedBy?: string): void { this.isDeleted = true; ... }
restore(): void { this.isDeleted = false; ... }
```

```ts
// create-batch.handler.ts
const species = await this.speciesRepository.findOne({
  where: { id: payload.speciesId, tenantId, isActive: true, isDeleted: false },
});
if (!species) {
  throw new BadRequestException(`Species ... bulunamadı veya aktif değil`);
}
```

```sql
-- V002__add_production_tables.sql
species_id UUID REFERENCES farm.species(id) ON DELETE SET NULL,
```

**Bulgular:**

- **Application-level kontrol**: createBatch handler `isDeleted: false` filtresi uygular → soft-deleted species'a yeni batch oluşturulamaz ✓
- **DB-level FK**: `ON DELETE SET NULL` — ama soft delete fiziksel DELETE yapmadığı için bu kısıt asla tetiklenmez
- **Gap**: Admin aracı veya direct SQL ile `species.is_deleted = true` yapılırsa (tipik restore edilebilir soft delete), mevcut batch kayıtları hâlâ bu species ID'yi referanslar. UI'da species listede görünmez ama batch detay sayfası "kaybolan" veya "inactive" bir species gösterir.
- **Çift yönlü tutarlılık yok**: query handler'lar `isDeleted=false` filtresi uygular, write handler'lar da öyle. Ama ilişkili entity'lerin ne yapacağı (örneğin species soft-delete edilince aktif batch'ler) belgelenmemiş.

**Sonuç:** ✅ Kısmen geçerli. Create tarafında korunuyor, ama "kaldırma sonrası referans" durumu ele alınmamış.

**Dokümana eklenmeli:**
- Soft delete + FK etkileşimi: DB-level FK `ON DELETE SET NULL` / `CASCADE` soft delete'i yakalamaz, sadece fiziksel DELETE'ı.
- Create handler'ları `isDeleted=false` filtresi uygular (yeni referans engellenir).
- Mevcut referanslar için ne olur: belirsiz, "yarı-silinmiş ama referanslanmış" durum için bir politika yok.
- Restore desteği: `species.restore()` entity metodu var ama GraphQL mutation olarak expose edilmemiş.

---

## Girdi 7 — JSONB Tasarım Kararı Eleştirisi Eksik

**Yorum:**
- `parameter_values` 25+ parametre içinde bazıları hot (pH, DO, temp) — ayrı sütun olmalı, geri kalanı JSONB
- `sites.metadata` içine region/postalCode/siteManager koymak zayıf tasarım

**Kod doğrulaması:**

```ts
// apps/farm-service/src/water-quality/entities/water-quality-measurement.entity.ts (indirekt okuma)
@Column('jsonb')
parameterValues: Record<string, number>;
```

Site entity (daha önce okundu):
```ts
// site.entity.ts:225-229
@Column({ length: 50, nullable: true }) contactPhone?: string;
@Column({ length: 150, nullable: true }) contactEmail?: string;
// Ayrı sütun olan alanlar: name, code, site_type, status, description,
// address, city, country, latitude, longitude, altitude, timezone,
// total_area_m2, water_source, license_number, license_expiry,
// contact_email, contact_phone, settings (JSONB), metadata (JSONB)
```

**Bulgular:**

- **Water quality**: pH, DO, temp gibi ölçüm parametrelerinin HER tankta, HER ölçümde var olduğu kesin. Hot column olarak ayrılabilir. Şu anki tasarım her parametre için `(parameter_values->>'pH')::numeric` gerektiriyor — JSONB path + cast = index gerektirir, performansı düşüktür.
- **Sites**: `address` TEXT sütunu zaten var. Ama `region`, `postalCode`, `siteManager` JSONB'de. Bu üç alanın klasik adres/iletişim alanları olduğu doğru; JSONB gerekmez. Muhtemelen migration sadeleştirmesi için geçici yapılmış.

**Sonuç:** ✅ Eleştiri haklı — ama bu bir tasarım eleştirisi, bir "bug" değil. Dokümanın bu kararı tartışması faydalı olur.

**Dokümana eklenmeli:**
- JSONB ne zaman doğru karardır: (a) şema sık değişir, (b) düz filtre kullanılmıyor, (c) tüm payload birlikte okunur.
- Hybrid yaklaşım önerisi: hot parametreler (pH, DO, temp, salinity) ayrı sütun + diğerleri JSONB.
- `sites.metadata`'daki region/postalCode/siteManager muhtemelen schema refactor borcu.

---

## Girdi 8 — Backdating (Geriye Dönük Veri Girişi)

**Yorum:**
- Operasyon personeli dün unutulmuş bir yemlemeyi bugün kaydederse ne olur? FCR/SGR zaman sırasına duyarlı, sıra bozulursa hesaplar yanlış olur.

**Kod doğrulaması:**

```ts
// feeding-storage-event.handler.ts - şu anki inventory sorgulanır, feedingDate dikkate alınmaz
const inventory = await this.inventoryRepository
  .createQueryBuilder('inv')
  .where(...)  // feedingDate parametresi YOK
```

```ts
// CreateFeedingRecordInput — feedingDate zorunlu, validation olarak max tarih kısıtı yok
feedingDate: string;  // @IsDate
```

```ts
// growth.operations.ts — SGR hesabı previousBiomass ve measurementDate üzerinden
```

**Bulgular:**

1. **Backdating engellenmemiş**: `feedingDate` validation'ı `@IsDate` — geçmiş veya gelecek tarih kısıtı yok. Kullanıcı dün tarihli yemleme kaydı girebilir.
2. **Stok düşümü bugün yapılır**: Event handler `feedingDate` yerine "şu an"ın inventory'sini sorgular → **zaman tutarsızlığı**
3. **FCR/SGR etkilenir mi?**: Büyüme hesapları `measurement_date ASC` sırasıyla yapılıyor. Geriye dönük bir yemleme kaydı önceki SGR hesaplarını **geriye dönük olarak** değiştirmez (cached/persisted SGR zaten yazılmış), ama yeni hesaplar için order bozulur. Explicit "eski kaydı yeniden hesapla" triggerı yok.
4. **Büyüme ölçümleri**: Aynı sorun: `measurementDate` validation'ı da geriye dönük tarihi engellemiyor. Ancak büyüme kayıtları sırasının bozulması FCR trendlerini etkiler.

**Sonuç:** ✅ Geçerli. Kod explicit backdating politikası içermiyor, türev hesapların yeniden tetiklenmesi yok.

**Dokümana eklenmeli:**
- Backdating kuralsız: kullanıcı herhangi bir geçmiş tarihi girebilir.
- Stok düşümü olayın tarihine değil komutun tarihine bağlı → inventory-olay mismatch.
- FCR/SGR recalculation yok → backdated yemleme önceki metrikleri bozmaz ama yeni hesapları bozar.
- Politika eksikliği: (a) N güne kadar backdate izni, (b) backdate sonrası hangi türev hesapların yeniden çalışacağı, (c) audit log'ta backdate flag'i.

---

## Girdi 9 — Regulatory Reporting Ciddi Boşluk

**Yorum:**
- "Sistem sadece kayıt tutar" iddiası → SLA takibi yok, submit confirmation yok, escalation yok.

**Kod doğrulaması:** `apps/farm-service/src/regulatory/` okundu.

**Önemli düzeltme:** Mevcut dokümanın "sistem otomatik e-posta göndermez" iddiası **kısmen yanlış**.

```ts
// mattilsynet-api.service.ts
// Client for submitting regulatory reports to the Norwegian Food Safety Authority
// (Mattilsynet) aquaculture reporting API.
//
// Endpoints:
// - POST /api/lakselus/v1/lakselus     - Sea lice reports
// - POST /api/rensefisk/v1/rensefisk   - Cleaner fish reports
// - POST /api/settefisk/v1/settefisk   - Smolt reports
// - POST /api/slakt/v1/planlagt        - Planned slaughter reports
// - POST /api/slakt/v1/utfort          - Executed slaughter reports
```

```ts
// regulatory.resolver.ts — 5 mutation
@Mutation(() => ReportSubmissionResult) submitSeaLiceReport(...)
@Mutation(() => ReportSubmissionResult) submitCleanerFishReport(...)
@Mutation(() => ReportSubmissionResult) submitSmoltReport(...)
@Mutation(() => ReportSubmissionResult) submitPlannedSlaughterReport(...)
@Mutation(() => ReportSubmissionResult) submitExecutedSlaughterReport(...)
```

**Bulgular:**

1. **5 tip rapor Mattilsynet API'sine otomatik submit edilir**: Sea Lice, Cleaner Fish, Smolt, Planned Slaughter, Executed Slaughter. Maskinporten OAuth2 ile authentication, UUID `klientReferanse` ile tracking.

2. **Disease Outbreak / Escape / Welfare otomatik submit edilmez**: Sadece `health_events` + `regulatory_events` kaydı tutulur — manuel raporlama kalır.

3. **SLA / deadline takibi yok**:
   - Hiç bir entity'de `deadline`, `dueAt`, `reportedAt` alanı bulunmadı
   - 24 saatlik geri sayım mekanizması yok
   - Otomatik uyarı / escalation yok
   - Cron'da "aşılan SLA" kontrolü yok

4. **Submit audit trail**: `ReportSubmissionResult` dönüş tipi var, `klientReferanse` UUID kayıtları var ama hangi kaydın hangi otoriteye gönderildiğinin tutulduğu dedicated bir tablo görünmüyor. Muhtemelen log-only.

5. **Entity doğrulama notu**: `regulatory_settings.entity.ts` içindeki yorum "stored in tenant schemas: tenant_4b529829.regulatory_settings" diyor ama `@Entity('regulatory_settings', { schema: 'farm' })` `farm` şeması kullanıyor. Bu tutarsızlık: entity dosyası `farm`'ı söylüyor, yorum farklı bir şema söylüyor. Runtime'da `getTenantSchemaName()` kullanılıyorsa yorum doğru olabilir — ek doğrulama gerekiyor.

**Sonuç:** ✅ Yorum büyük ölçüde geçerli + ek bulgu:

- **Önceki dokümandaki iddia (`sistem otomatik göndermez`) yanlış** — 5 rapor tipi otomatik gönderilir.
- **Disease Outbreak/Escape/Welfare için manuel raporlama yine geçerli**.
- **SLA takibi yok** — user correct.
- **Tracking**: submit log var ama dedicated table yok.

**Dokümana eklenmeli:**
- Mattilsynet API entegrasyonu mevcut (5 rapor tipi) — anlatim §14.3'teki iddia düzeltilmeli.
- Disease Outbreak / Escape / Welfare için otomatik gönderim yok.
- SLA / deadline takibi genel olarak yok.
- `regulatory_settings.entity.ts` şema anomalisi (yorum vs decorator).

---

## Girdi 10 — Optimistik Kilitleme UX

**Yorum:** Version conflict'te kullanıcı tüm form verisini kaybeder; diff/merge/clipboard UX'i yok.

**Kod doğrulaması:**

```bash
grep "VersionColumn" apps/farm-service/src/**/*.entity.ts | wc -l  # → 10+
```

Entity'lerde `@VersionColumn()` mevcut: consumable, feed, feed_type_species, feeding_protocol, tank, farm_type, batch, batch_feed_assignment, feeding_program, feeding_program_tank, feeding_table, equipment, sub_equipment, chemical vb.

Backend `OptimisticLockVersionMismatchError` fırlatır. Frontend (React) tarafında bu hatayı yakalayıp field-level diff/merge gösteren kod **bulunamadı** (önceki frontend envanteri de bunu gösterdi: sadece basit error toast pattern). Form state clipboard'a da alınmıyor; kullanıcı sayfayı reload edince tüm girdiği veri kaybolur.

**Sonuç:** ✅ Geçerli. Version conflict'te veri kaybı riski somut.

**Dokümana eklenmeli:**
- Yazılmış olan mevcut `@VersionColumn` koruma mekanizması ne yapar (çakışma engeller) ve ne yapmaz (UX kurtarmaz).
- Öneri: form state'i client-side draft olarak sessionStorage'a yazmak; conflict durumunda yeni değerle yan yana göstermek.

---

## Girdi 11 — Ölçü Birimi ve Timezone

**Yorum:** Ağırlıklar g/kg, sıcaklık °C/°F, feeding_time timezone — belgelenmemiş.

**Kod doğrulaması:**

```ts
// apps/farm-service/src/feeding/entities/feeding-record.entity.ts:171
// WHY VARCHAR(10) instead of PostgreSQL TIME: ... TIME type would require
// timezone handling that adds complexity without benefit for meal
// scheduling.
@Column({ length: 10 })
feedingTime: string;
```

— timezone bilinçli olarak eklenmemiş. `feedingTime` "08:00" gibi naked string.

```ts
// apps/farm-service/src/batch/entities/batch.entity.ts:188
totalFeedConsumed: number;       // Toplam yem tüketimi (kg)
// :204
costPerKg?: number;              // kg başına maliyet
// :292
arrivalMethod?: ArrivalMethod;
// avgWeightG alanları birim suffix'iyle açık
```

— ağırlık/biyokütle/feed convention tutarlı (g, kg, kg) ama **tek bir yerde dokümante edilmemiş**.

```ts
// apps/farm-service/src/water-quality/entities/water-quality-parameter-config.entity.ts:124-126
@Field({ description: 'Measurement unit, e.g. °C, mg/L, NTU' })
unit: string;
```

— parametre config'te `unit` sütun var; measurement tablosu JSONB'de yalnız **değer** tutar. Unit'i görmek için config'e join gerekir.

`toISOString()` her yerde kullanılıyor — UTC saklama tutarlı.

**Sonuç:** ✅ 3 alt-gap:
1. `feedingTime` timezone context'siz — çift-site'lı (farklı zaman dilimli) tenant'ta yanılgı riski
2. Measurement tablosunda unit yok, config'e join gerekir — cache yok ise N+1 sorgu
3. g/kg convention dokümante edilmemiş

**Dokümana eklenmeli:**
- Bir alt başlık "Birim ve Zaman Dilimi Politikası" (§3 altında): weight=g, biomass=kg, feed=kg, temp=°C, UTC saklama, timezone sadece `sites.timezone`'da bilgilendirme amaçlı.
- `feedingTime` naked string kararı ve limitasyonu dokümante edilmeli.

---

## Girdi 12 — Stub Ekranlar Route Guard Eksikliği 🔴 KRİTİK

**Yorum:** FarmFormPage stub; feature flag / route guard / uyarı banner'ı var mı?

**Kod doğrulaması:**

```tsx
// web/modules/farm-module/src/Module.tsx:55,58
<Route path="new" element={<FarmFormPage />} />
<Route path=":siteId/edit" element={<FarmFormPage />} />
```

- Feature flag yok
- Route guard yok
- Banner / uyarı yok
- Stub'ın kendisi:
```tsx
// web/modules/farm-module/src/pages/FarmFormPage.tsx:100-110
const handleSubmit = async (e: React.FormEvent) => {
  ...
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log('Form gönderildi:', formData);
  navigate('/sites');
};
```

Kullanıcı `/farms/new` veya `/farms/:siteId/edit` URL'sine giderse stub form açılır, "Kaydet" basar, 1 saniye sonra `/sites`'a yönlendirilir. "Başarıyla kaydedildi" ekranı gibi görünür ama **veri atılır**.

**Sonuç:** 🔴 Yorum %100 doğru. Somut veri kaybı bug'ı.

**Dokümana eklenmeli:**
- §21.1'deki stub tanımı yetersiz; aktif route olduğu ve guard olmadığı net yazılmalı.
- Acil öneri: `Module.tsx:55,58` iki satır `<Navigate to="/sites" replace />` ile değiştirilmeli.
- Diğer stub'lar (`FarmListPage` silme, `MapViewPage`, `BiomassReportTab`) için de guard/banner önerileri.

---

## Girdi 13 — AI Insights Güvenlik Boşluğu

**Yorum:** Veri scope, prompt injection, hallucination guard, auto-apply?

**Kod doğrulaması:**

```ts
// apps/farm-service/src/ai-insights/ai-insights.resolver.ts
@Resolver()
export class AiInsightsResolver {
  @Query(() => TankRiskAssessment, { nullable: true })
  async tankRiskAssessment(
    @Args('tankId', { type: () => ID }) tankId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<TankRiskAssessment | null> { ... }
  // 4 query daha, hepsi aynı pattern — mutation YOK
}
```

- Tüm entry noktaları `@Query` ✓ (auto-apply yok — user yorumu doğruladı)
- Global `TenantGuard` var (AppModule'de `APP_GUARD`)
- `@CurrentTenant()` JWT'den çıkar
- Redis cache tenant-scoped: `ai-insights:risk:tank:{tenantId}:{tankId}`

```ts
// apps/farm-service/src/ai-insights/services/ai-insights.service.ts
const raw = await this.mcpClient.callTool<{...}>('assess_risk', {
  scope: 'tank',
  entityId: tankId,
  includeProjection: false,
  includeOpportunities: false,
});
```

- MCP client'e **structured parameter**'lar iletilir — kullanıcı serbest metni prompt'a geçmiyor
- Prompt injection yüzeyi dar (user input sadece UUID seçimleri olarak geçer)
- Yanıt `TankRiskAssessment` gibi tipik — serbest metin değil, typed structure
- Hallucination için explicit filter yok ama structured output azaltır

**Sonuç:** ✅ Kısmen geçerli:
- Auto-apply yok ✓ — sadece öneri
- Prompt injection riski düşük — input structured
- Veri scope: tenant-scoped (resolver seviyesinde garanti edilir)
- Hallucination: structured response; explicit guard yok
- **Sınır:** MCP server farm verilerine hangi SQL/query ile eriştiği farm-service repo'sunda değil — ayrıca doğrulanmalı

**Dokümana eklenmeli:**
- §18'in genişletilmesi: query-only + tenant-scoped + structured input notu.
- "MCP server'ın veri erişim scope'u ayrıca doğrulanmalı" kayıt düşülsün.
- Explicit: auto-apply yok, tüm çıktılar öneri niteliğinde.

---

## Girdi 14 — Eklenmesi Gereken Yeni Başlıklar

### 14a — Performance ve Pagination

**Kod doğrulaması:**

- `batch.resolver.ts` list query: `page, limit` (offset-based)
- Storage, harvest, feeding liste query'leri: aynı pattern (offset-based)
- Cursor-based pagination kullanılmıyor
- JSONB filtreleri `water_quality_measurements.parameter_values` üzerinde: `(parameter_values->>'pH')::numeric > 8.0` şeklinde yazılır, **partial index yok**

**Sonuç:** ✅ Geçerli. Büyük offset'lerde yavaş (milyon satırda `OFFSET 100000` yavaş); JSONB sorgular indeks olmadan seq scan riski.

### 14b — Data Retention ve Archival

**Kod doğrulaması:**

- `audit_logs`: SQL function `cleanup_old_audit_logs(p_retention_days int DEFAULT 90)` tanımlı (`database/migrations/003_create_audit_logs_table.sql:45`)
  - ⚠ **Fonksiyon var ama scheduled olarak çağıran `@Cron` farm-service içinde bulunamadı** — manuel çalıştırılmalı
- `farm_outbox`: published 7 gün sonra DELETE (outbox-worker `@Cron('0 3 * * *')`)
- Dead-letter outbox satırları: kalıcı
- **Operasyonel tablolar** (`batches_v2`, `feeding_records`, `growth_measurements`, `water_quality_measurements`, `harvest_records`, `tank_operations`) — retention/archival **yok**. Sonsuz büyür.
- Soft-delete'lenen satırlar fiziksel silinmez.

**Sonuç:** ✅ Önemli gap. Audit cleanup fonksiyonu çağırılmıyor; domain tablolar retention yok.

### 14c — Disaster Recovery

**Kod doğrulaması:** Farm-service repo'su içinde RPO/RTO/PITR kodu yok — infrastructure katmanı. Outbox layer NATS JetStream `duplicate_window` kullanır, ama backup/restore stratejisi burada tanımlanmaz.

**Sonuç:** ⚠ Scope dışı (infrastructure repo'sunda). Farm modülü dokümanında "DR stratejisi infra katmanında" notu yeterli.

### 14d — Observability

**Kod doğrulaması:**

- Outbox: `OutboxMetricsService` → Prometheus (`outbox_pending`, `outbox_dead_letter_count`, publish latency histogram) ✓
- Domain mutation'larda rate/latency metric'i **bulunamadı** — ne decorator ne manual histogram
- Logger her handler'da var ama structured metric export yok

**Sonuç:** ✅ Outbox monitoring var, domain-level yok.

### 14e — Testing Strategy

**Kod doğrulaması:**

- 24 `.spec.ts` dosyası bulundu (`find apps/farm-service/src -name "*.spec.ts" | wc -l` → 24)
- Batch handler'ları iyi test kapsamı: createBatch, updateBatch, recordMortality, recordCull, transferBatch, closeBatch, allocateToTank, updateBatchStatus tümü test edilmiş
- Ama ~150 command handler için 24 test → düşük oran
- Feeding, storage, harvest, maintenance, health command handler'ları için test dosyası sayısı sınırlı

**Sonuç:** ✅ Kısıtlı kapsam. Rollback / error-path senaryoları eksik.

### 14f — Legacy Migration Path

**Kod doğrulaması:** `find -name "*migration*batches*" -o -name "*legacy*"` sonuç döndürmedi. Legacy (`farms`, `batches`, `ponds`) tablolardan yeniye (`sites`, `batches_v2`, `tanks`) veri taşıyan script/job yok.

**Sonuç:** ✅ Geçerli. Legacy tablolar paralel varlığını sürdürür; geçiş yol haritası belgelenmemiş.

### 14g — Concurrent Harvest ⚠ Yorum Kısmen Yanlış

**Kod doğrulaması:**

```ts
// apps/farm-service/src/harvest/handlers/create-harvest-record.handler.ts:77,87,103
const batch = await queryRunner.manager.findOne(Batch, {
  where: { id: input.batchId, tenantId, isActive: true },
  lock: { mode: 'pessimistic_write' },
});
const tank = await queryRunner.manager.findOne(Tank, {
  ...
  lock: { mode: 'pessimistic_write' },
});
const tankBatch = await queryRunner.manager.findOne(TankBatch, {
  ...
  lock: { mode: 'pessimistic_write' },
});
```

Batch, tank, tank_batch üzerinde pessimistic_write. İki concurrent harvest → ikinci transaction ilki commit olana kadar bekler. Distributed lock (Redis) **gereksiz** — PostgreSQL transaction seviyesi yeterli.

**Sonuç:** ⚠ Yorum kısmen yanlış. Korunma mekanizması var; dokümanda belirtilmemiş.

### 14h — Chemical Withdrawal Period Enforcement 🔴 KRİTİK

**Kod doğrulaması:**

```bash
grep "earliest_harvest_date\|earliestHarvestDate\|withdrawal" apps/farm-service/src/harvest/
# → 0 hit
grep "HealthEvent" apps/farm-service/src/harvest/handlers/create-harvest-record.handler.ts
# → 0 hit
```

- `health_events.entity.ts` içinde `earliest_harvest_date` hesaplanıyor (olay + `withdrawal_period_days`)
- Ama harvest handler'da (`create-harvest-record.handler.ts`) bu tarihe dair **hiçbir kontrol yok**
- HealthEvent repository'si injection edilmemiş
- Kullanıcı ilaç verir → withdrawal period geçmeden hasat yapar → **sistem uyarı bile vermez**

**Sonuç:** 🔴 Somut compliance/gıda güvenliği bug'ı. Mattilsynet, EU Reg 37/2010 doğrudan ihlal edilir.

**Dokümana eklenmeli:**
- §22 altında "Withdrawal Period Enforcement" başlığı — yasal risk notu.
- Öneri: createHarvestRecord içinde aktif HealthEvent kontrolü + `earliest_harvest_date > harvestDate` ise reddet.

---

## Girdi 15 — Detaylı İnceleme (A-E Kategorileri) — Kod ile Doğrulama

Bu girdi, kullanıcının A–E kategorileri altında sunduğu detaylı incelemeyi işler. Çok sayıda alt madde bulunduğundan her biri:
- **⧗ Duplicate**: önceden doğrulanan girdilere referanslanır
- **✅ Yeni geçerli**: kod ile doğrulandı, eklenmeli
- **⚠ Kısmen**: kısmen geçerli
- **❌ Yanlış**: kod ile çürütüldü
olarak işaretlenir.

### A. İç Çelişkiler (Dokümanın Kendi İçinde Tutarsızlık)

| # | Başlık | Durum | Not |
|---|--------|-------|-----|
| A1 | Tank — table/view/alias? | ⧗ Girdi 2 | farm.tanks ayrı gerçek tablo doğrulandı |
| A2 | contact_email column vs JSONB | ⧗ Girdi 2 | ayrı sütun doğrulandı; doküman revision note taşınmalı |
| A3 | Harvest vs tank_operations | ✅ Yeni | Harvest handler `tank_operations`'a HARVEST satırı yazar (`create-harvest-record.handler.ts` TankOperation repo'su inject edilmiş). Ancak §5.3'te "harvest operasyonları `tank_operations`'a yazılır" diyen batch operasyonları listesi Harvest'i içermiyor. Kategori belirsizliği. |
| A4 | Soft delete kapsam listesi | ✅ Yeni | Entity'lerde `isDeleted` alanı olanların tam listesi çıkarılmalı. Grep ile: consumable, chemical, feed, feeding_program, feeding_table, batch, batch_feed_assignment, tank, equipment, site_contact, harvest_record, tank_allocation, feed_type_species — en az 14 entity. Department ve Site entity'lerinde explicit `isDeleted` **yok** (sadece `isActive`). Cascade preview var ama soft-delete'in kendisi department'ta uygulanmıyor — iddia kısmen tutarsız. |
| A5 | regulatory_events — 2 mutation aynı tabloya mı? | ✅ Yeni | `recordComplianceEvent` mutation bulundu; `createDiseaseOutbreak` mutation ise anlatim §14.3'te belirtildi ama regulatory.resolver.ts'te BULUNAMADI — disease outbreak muhtemelen yalnızca `health_events` tablosuna yazar. Dokümandaki "regulatory_events'e yazar" iddiası **yanlış** olabilir, `regulatory_events` entity dosyası da yok (sadece `regulatory-settings.entity.ts` var). |
| A6 | REST controller sayısı | ⧗ Girdi 1 + ✅ Yeni alt madde | A6 alt iddia (`/api/tank-operations` için ayrı controller): doğrulama — `batch.controller.ts:141` içinde `@Controller(...)` incelendiğinde iki path prefix muhtemelen aynı controller'da two decorator ile değil, method-level path'lerle yönetiliyor. Ayrı controller **yok**. |
| A7 | Outbox index isim anomalisi | ✅ Yeni | `idx_farm_outbox_poll_entity` ismi yanıltıcı ama index gerçekten sadece `createdAt WHERE publishedAt IS NULL` üzerinde. User yorumu doğru. |
| A8 | published boolean + published_at | ✅ Yeni | `outbox-entity.base.ts` incelenmeli — two-field pattern varsa tutarsızlık kaynağı. Tipik olarak sadece `publishedAt IS NULL` yeterli; ikinci boolean redundant. |

### B. Mantıksal Boşluklar (Senaryo Çelişkileri)

| # | Başlık | Durum | Not |
|---|--------|-------|-----|
| B1 | Transaction boundary, 8 tablo | ⧗ Girdi 3 | — |
| B2 | FeedingStorageEventHandler failure silent | ⧗ Girdi 5 + ✅ alert eksikliği | Alert yok, sadece WARN log. Stok negatife düşme durumu kodda kontrol edilmiyor (`if (Number(inventory.quantity) < quantity)` throw eder, yani NEGATIVE olmaz ama feeding kaydı zaten atılmış olur — **inventory zaten eksiydi** durumunda feeding yazılır, deduction fail olur, sessizce log'lanır). User alert eksikliği haklı. |
| B3 | Optimistic lock + JSONB çakışma | ✅ Yeni | `batches_v2.feeding_summary`, `growth_metrics`, `mortality_summary` JSONB sütunları var. İki command farklı JSONB alanını güncellerse optimistic lock her ikisini birden fail'e götürür (row version artar). Field-level merge semantiği yok. Önemli UX problemi. |
| B4 | feeder_calibrations public şema motivasyonu | ⧗ Girdi 2 + ✅ hangi servis? | Hangi servisin bu tabloyu okuduğu farm-service repo'sunda cevaplanamaz. Cross-service paylaşım iddiası belgesiz. |
| B5 | Water quality key typo | ⚠ Kısmen | `water-quality-validation.service.ts` tenant config'teki key'lere karşı **doğrular**. Config'te tanımlı olmayan key reject edilir. AMA: "No configs - skip validation (backward compat)" → config olmayan tenant'ta typo'lu key'ler geçer. **Kısmen korunmuş.** |
| B6 | Stock movement enum tutarsızlığı | ✅ Yeni — KÖTÜ DOKÜMANTASYON | Gerçek enum: `IN, OUT, TRANSFER, WASTE, ADJUSTMENT, RETURN` (6 tip). Anlatim §9.4 sadece 4 tip listeler (INBOUND/OUTBOUND/TRANSFER/ADJUSTMENT). **Doküman WASTE ve RETURN'u atlıyor** + isim tutarsızlığı (IN/INBOUND karıştırılmış). Düzeltilmeli. |
| B7 | Batch status enumeration dağınık | ✅ Yeni | `batch.types.ts:27` içinde `export enum BatchStatus` var (gerçek yer). Doküman bu enum'un tam değer listesini bir yerde sunmuyor, farklı bölümlerde parça parça geçiyor. Single-source-of-truth tablosu eklenmeli. |
| B8 | cost_per_kg hesap kaynakları | ✅ Yeni — VERİ KUSURU | `get-batch-performance.handler.ts:112`: `totalCost = purchaseCost + totalFeedCost`. **Sadece iki kalem.** İş gücü maliyeti, ilaç/kimyasal maliyeti, ekipman amortismanı DAHİL DEĞİL. Ancak pazarlanan metric "cost per kg" gerçek maliyeti yansıtmıyor. User haklı. |
| B9 | Cascade delete + soft delete | ⧗ Girdi 6 + ✅ preview derinliği | Department preview query derinliği sınırı dokümante edilmemiş. Teorik olarak tüm alt hiyerarşi tarar. Büyük tesis/departman'da pahalı. |
| B10 | Harvest plan opsiyonel — shortcut path | ✅ Yeni | `create-harvest-record.handler.ts` input'unda `harvestPlanId` optional. Plan olmadan harvest kaydı mümkün. Pre-harvest kalite kontrol, finansal projeksiyon karşılaştırması, approval workflow atlanır. Compliance riski var ama kod kısıtlamıyor. |
| B11 | Withdrawal period enforcement | ⧗ Girdi 14h | 🔴 Kritik compliance bug — aynı. |
| B12 | Growth populationSize kaynak | ❌ Yanlış | Kod `populationSize: payload.populationSize || batch.currentQuantity` şeklinde default veriyor. Kullanıcı boş bıraktığında batch'in current_quantity'si otomatik kullanılır. User'ın "elle girilirse yanlış girebilir" endişesi geçerli ama default mekanizma var. |
| B13 | Recurring task timezone | ✅ Yeni | `recurring-task.service.ts:150` `@Cron('0 */15 * * * *')` sunucu saatiyle çalışır. Site timezone'unu dikkate alan kod yok. Multi-site/multi-tz tenant'ta task üretimi her yer için aynı saatte tetiklenir. DST handling'i de özel mantık değil, node-cron'un default davranışı. |
| B14 | Auto rule — parser ve cooldown | ❌ Yanlış (user'ın korku varsayımı) | `AutoRuleTrigger` enum sabit: SCHEDULE, EXPIRY_NEAR, MAINTENANCE_DUE, LICENSE_EXPIRY, WATER_PARAM_ALERT. **Serbest expression parser yok** — `water.ph < 6.5` gibi bir şey desteklenmiyor. Benim gorsel.md §4.10 örneği **fabrikasyon**, düzeltilmeli. Cooldown SCHEDULE tipi için `lastTriggered` + intervalHours ile uygulanıyor. `eval()` / `new Function()` **kullanılmıyor** — güvenlik riski yok. User'ın endişesi yanlış anlaşılan doküman örneğinden kaynaklanıyor. |
| B15 | Cleaner fish tank capacity check | ✅ Yeni — KRİTİK | `deploy-cleaner-fish.handler.ts` biomass hesabı yapar (`biomassKg = quantity * avgWeightG / 1000`) ama tank'ın `max_biomass_kg` değerine karşı **doğrulama yok**. Aşırı yoğunluk fiziksel olarak engellenmez. Balık refahı ve yasal standart riski (Mattilsynet welfare) — bir başka compliance boşluğu. |
| B16 | Lot traceability karışım senaryoları | ✅ Yeni | `traceLot` query lot numarasını izler ama aynı fiziksel konteynırda (silo, tank) birden fazla lot karışırsa sistem bunu "iki ayrı lot" olarak tutmaya devam eder — fiziksel karışım modellenmez. Gıda güvenliği/izlenebilirlik için teorik vs fiziksel fark. |
| B17 | Audit log içerik kontrolü | ✅ Yeni | `AuditChanges` interface: `{before, after, changedFields}`. Büyük JSONB alanları (batch.weight, growth.individualMeasurements) değişirse full before/after kopyası audit'e gider — **audit tablosu şişer**. Redaction/filter yok. `AuditMetadata` içinde `ipAddress`, `userAgent` var → GDPR PII; 90 gün retention bu veriyi tutar. Right-to-erasure çakışması. |
| B18 | 90 gün retention — compliance uyumsuz | ✅ Yeni | `cleanup_old_audit_logs(DEFAULT 90)` SQL function var ama **scheduled call yok** (farm-service'te `@Cron` referansı yok). Yani: (a) fonksiyon default 90 gün diyor, (b) çağrılmıyor → manuel çalıştırılmazsa SINIRSIZ tutulur. Aquaculture compliance için 90 gün genelde yetersiz; ancak mevcut durumda cleanup fonksiyonu çağrılmadığı için **pratikte tablolar sonsuz büyür** — farklı bir problem. |

### C. Hiç Girilmemiş Başlıklar

Bu grubun çoğu dokümantasyon eksikliği / kapsam sınırı — kod doğrulaması değil, doküman kararı.

| # | Başlık | Durum | Eklenmeli mi? |
|---|--------|-------|---------------|
| C1 | Error handling semantikleri | ✅ Gerçek gap | Evet — GraphQL error extensions kodu var, ama doküman yok. |
| C2 | Auth & Authz — rol matrisi | ✅ Gerçek gap | Evet — `@Roles('TENANT_ADMIN', 'MODULE_MANAGER', 'MODULE_USER')` decorator'ları mutation bazlı; doküman tam matris sunmuyor. |
| C3 | Caching | ⚠ Kısmen var | AI insights ve parameter config'te Redis cache var; dokümanda parça parça. Tek bölüm altında toplanmalı. |
| C4 | File upload detayları | ⚠ Kısmen var | §22.9 başladı ama eksik (max size, AV scan, EXIF cleanup, orphan cleanup sessiz). Genişletilmeli. |
| C5 | i18n | ✅ Gerçek gap | `sites.timezone` var, locale/dil için explicit kod görülmedi. |
| C6 | Sensor (iot) entegrasyonu | ✅ Gerçek gap | Farm modülünde iot'a yönelik çapraz sorgu kodu görülmedi — sensor dashboard ayrı servis çağrısı. Entegrasyon mekanizması belgelenmemiş. |
| C7 | Deployment & environment | ✅ Gerçek gap | Tenant onboarding seed'i nasıl? `SourceSchemaBootstrapService` var ama seed data rehberi yok. |
| C8 | Rate limiting | ⧗ §22.6 | Gerçekten yok; risk olarak daha kuvvetli ifade edilmeli. |
| C9 | GraphQL özel konuları | ✅ Gerçek gap | Query depth/complexity limit, DataLoader kullanımı (batch.resolver'da DataLoader var), subscription (görünmüyor), persisted queries (görünmüyor). |
| C10 | Backup & DR | ⧗ 14c | Scope dışı. |
| C11 | Data export (GDPR) | ✅ Gerçek gap | Tenant data export endpoint'i görünmüyor. GDPR portability için ciddi risk. |
| C12 | Analytics data pipeline | ✅ Gerçek gap | AnalyticsPage aggregate okur ama ETL/OLAP hakkında kod yok. |
| C13 | Testing | ⧗ 14e | — |
| C14 | Observability | ⧗ 14d | — |
| C15 | Dokümantasyon meta | ⧗ E-serisi | — |

### D. Mevcut Bölüm Geliştirmeleri

Hepsi dokümantasyon kalite önerileri — kod doğrulaması gereksiz. Kabul edilmeli, gelecekteki revizyonlarda uygulanmalı:

- D1: Form tablosu sütunları standardize edilsin (required, validation, default, role visibility, index)
- D2: Batch biomass tutarlılık kuralı belgelensin
- D3: Feeding 27 alan tam listelensin (kısmi liste yetersiz)
- D4: Water quality alarm mekanizması belgelenmeli
- D5: Spare part consumption atomicity
- D6: Health event 36 alan tam listesi
- D7: Regulatory raporların 8 tipi için dengeli detay
- D8: Weather/Marine/Sentinel detaylandırılsın
- D9: AI Insights detaylandırılsın
- D10: Stub severity sınıflandırması
- D11: FK eksikliği tablo bazında enumere edilsin
- D12: File upload mevcut/hedef durum ayrımı

### E. Meta Dokümantasyon Önerileri

Hepsi kabul edilmeli:
- E1: Versiyon/tarih/author alanları eklensin
- E2: Capacity planning
- E3: Glossary (FCR, SGR, DO, RAS, FEFO, PITR, RLS, NATS, CQRS, MCP)
- E4: Daha çok kod snippet
- E5: Diyagram eksikliği — gorsel.md referansı yeterli mi?
- E6: End-to-end örnek senaryolar
- E7: Non-goals listesi
- E8: Frontend component library referansı
- E9: Performance benchmarks (SLA hedefi yok)
- E10: Numaralandırma tutarlılığı

---

## Özet — Geçerlilik Tablosu

| # | Yorum | Sonuç | Etki |
|---|-------|-------|------|
| 1 | Tablo sayımı / legacy, REST controller ayrımı | ✅ Geçerli | Yazım netliği |
| 2 | Tank/Equipment view iddiası | 🔴 **Büyük hata doğrulandı** | farm.tanks ayrı gerçek tablo, docs düzeltilmeli |
| 3 | Transaction lock/retry tartışılmamış | ✅ Geçerli | Performans ve operasyon notu eksik |
| 4 | Outbox detayları eksik | ✅ Geçerli | Poll/retry/cleanup/metrics hepsi atlanmış |
| 5 | FEFO tiebreaker/expired/backdate | ✅ **3 somut gap** | Güvenlik + deterministik davranış riski |
| 6 | Soft delete + FK | ✅ Kısmen geçerli | Create-tarafı korunmuş, restore/referans gri alan |
| 7 | JSONB eleştirisi eksik | ✅ Tasarım notu | Hibrit yaklaşım önerilmeli |
| 8 | Backdating politikası yok | ✅ Geçerli | FCR/SGR hesap sırası riski |
| 9 | Regulatory SLA yok | ✅ + **önceki iddia yanlış** | Mattilsynet entegrasyonu var, SLA yok |
| 10 | Optimistik kilit UX veri kaybı | ✅ Geçerli | Frontend diff/merge yok |
| 11 | Unit ve timezone dokümantasyonu | ✅ 3 alt-gap | feedingTime timezone-naked, unit join gerekir, convention belgelenmemiş |
| 12 | Stub ekran route guard eksik | 🔴 **KRİTİK veri kaybı** | FarmFormPage aktif route'ta, guard yok |
| 13 | AI Insights güvenliği | ✅ Kısmen (endişenin üzerinde) | Query-only + tenant-scoped + structured — düşük risk |
| 14a | Pagination offset-based | ✅ | Büyük dataset'te yavaş |
| 14b | Domain retention yok | ✅ + audit cleanup scheduled değil | — |
| 14c | Disaster recovery | ⚠ Scope dışı | Infra repo'su |
| 14d | Domain-level metric yok | ✅ | — |
| 14e | Test kapsamı düşük | ✅ | 24 test / ~150 handler |
| 14f | Legacy migration path yok | ✅ | — |
| 14g | Concurrent harvest lock | ❌ Yorum yanlış | pessimistic_write zaten var |
| 14h | Withdrawal period enforcement | 🔴 **KRİTİK compliance** | Harvest handler hiç check etmiyor |
| 15-A1 | Tank çelişkisi | ⧗ Girdi 2 | — |
| 15-A2 | contact_email çelişkisi | ⧗ Girdi 2 | — |
| 15-A3 | Harvest vs tank_operations taksonomi | ✅ | Kategori belirsizliği |
| 15-A4 | Soft delete kapsamı | ✅ | Tam liste yok |
| 15-A5 | regulatory_events tablosu şüpheli | ✅ | Muhtemelen dokümandaki iddia yanlış, tablo yok olabilir |
| 15-A6 | REST controller sayısı | ⧗ Girdi 1 | — |
| 15-A7 | Outbox index naming | ✅ | Yanıltıcı isim |
| 15-A8 | published vs publishedAt redundancy | ✅ | Tek alan yeterli |
| 15-B3 | Optimistic lock + JSONB | ✅ RESOLVED (Faz 5.7) | JsonbPatchService + whitelist registry — concurrent patches to different JSONB paths no longer 409 each other |
| 15-B5 | Water quality key validation | ✅ RESOLVED (Faz 6.5) | strict mode default; zero-config tenant + non-empty submission → NO_ACTIVE_PARAMETER_CONFIGS 400; WQ_STRICT_VALIDATION env opt-out |
| 15-B6 | Stock movement enum eksik | ✅ | **Doküman 4 tip, kod 6 tip** (WASTE, RETURN atlanmış) |
| 15-B7 | Batch status tek tablo yok | ✅ | Single source of truth |
| 15-B8 | cost_per_kg eksik kalemler | ✅ **VERİ KUSURU** | İş gücü/kimyasal/amortisman DAHİL DEĞİL |
| 15-B10 | Harvest plan shortcut path | ✅ | Compliance riski |
| 15-B12 | Growth populationSize | ❌ Yanlış | Default `batch.currentQuantity` |
| 15-B13 | Recurring task timezone | ✅ RESOLVED (Faz 5.5) | luxon-based timezone-aware calculateDueDate + calculateNextGeneration, `timezone` column on RecurringTemplate, DST edge case covered |
| 15-B14 | Auto rule parser riski | ❌ Yanlış | Enum-bazlı, eval yok |
| 15-B15 | Cleaner fish capacity | 🔴 **KRİTİK** | max_biomass_kg kontrolü yok |
| 15-B16 | Lot mixing teorik vs fiziksel | ✅ RESOLVED (Faz 2.4) | Gıda güvenliği izlenebilirlik — `StorageLotMix` + `LotMixService` |
| 15-B17 | Audit log PII + şişme | ✅ RESOLVED (Faz 2.5) | `AuditRedactionService` — partial-mask PII + secret full-redact + oversize collapse |
| 15-B18 | Audit retention çalışmıyor | ✅ | Fonksiyon var, cron yok |
| 15-C1…C15 | Hiç girilmemiş başlıklar | ✅ çoğu geçerli | Dokümana yeni bölümler eklenmeli |
| 15-D1…D12 | Mevcut bölüm iyileştirmeleri | ✅ format önerileri | Kabul edilmeli |
| 15-E1…E10 | Meta öneriler | ✅ | Kabul edilmeli |

### Kritik (🔴) Bulgular Özeti

1. **Girdi 12**: FarmFormPage stub route aktif, guard yok → veri kaybı
2. **Girdi 14h / B11**: Chemical withdrawal period harvest'te check edilmiyor → gıda güvenliği ihlali
3. **Girdi 15-B15**: Tank capacity check deploy'da yok → aşırı yoğunluk welfare ihlali
4. **Girdi 2**: Tank tablosu kafa karışıklığı → doküman hatası + potansiyel senkron riski

### Yanlış Çıkan Yorumlar

- **14g** (distributed lock) — pessimistic_write zaten var
- **15-B12** (population elle girilir) — default mekanizma var
- **15-B14** (eval güvenlik riski) — enum-bazlı, eval yok

---

## Çalışma Sırasında Bulunanlar (İmplementasyon Log'u)

Kod düzeltmeleri uygulanırken karşılaşılan yan problemler. "İlgili / ilgisiz" ayrımı yapılmadan burada tutulur.

### 2026-04-22 — Kritik Düzeltme Oturumu

#### Düzeltmeler uygulandı

Aşağıdaki commit'ler `docs/farm-illustrator` branch'ine eklendi:

1. **`refactor(farm): remove legacy farm concept from frontend`** — FarmFormPage, FarmListPage, FarmDetailPage silindi. Mocked FarmDetailPage (`mockFarm = {...}` hardcoded) + stub FarmFormPage (`console.log + setTimeout`) artık yok. Üç `/sites/...` rotası `<Navigate to="/sites/setup/sites" />` redirect'e çevrildi. Kullanıcı kaydı Site/Department/System hiyerarşisine yönlendirildi. (Girdi 12 + Ek-1 + Ek-2)
2. **`refactor(farm): deprecate createFarm and createPond mutations`** — Backend mutation'ları `@deprecated` + `BadRequestException` throw. Query'ler legacy read için kaldı. (Mimari netleştirme — "farm kaydı yapmıyoruz, yapmamalıyız")
3. **`feat(fish-health): enforce medicine withdrawal period on harvest`** — Yeni `BatchHarvestEligibilityService` + `batchHarvestEligibility` query + `createHarvestRecord` handler entegrasyonu + unit test. Gıda güvenliği compliance bug'ı (Girdi 14h / B11) kapatıldı.
4. **`feat(tank): centralize density/capacity check and enforce on cleaner-fish deploy`** — Yeni `TankCapacityService` + `deployCleanerFish` hard enforce + unit test. Welfare bug'ı (Girdi 15-B15) kapatıldı.
5. **`feat(scheduler): wire nightly audit-log cleanup via cleanup_old_audit_logs()`** — Boş `cleanupOldData` stub'ı dolduruldu. Per-tenant iterasyonu + `AUDIT_RETENTION_DAYS` env var. (Girdi 14b / 15-B18)

#### Eklenen ek bulgular

Fix'ler sırasında karşılaşılan yan problemler (docs'a eklenmesi gerektiği halde önceki turda atlanmış veya yeni ortaya çıkmış):

- **Ek-1 (doğrulandı): FarmDetailPage mock data.** `web/modules/farm-module/src/pages/FarmDetailPage.tsx:33-48` içinde `const mockFarm = { id: '1', name: 'Çiftlik A - Tank Sistemi', ... }` hardcoded. `/sites/:siteId` rotası bu sayfayı kullanıyordu — kullanıcı her site tıkladığında aynı sahte veri görüyordu. **Düzeltildi** (dosya silindi).
- **Ek-2 (doğrulandı): Module.tsx'te üç kırık rota.** `/sites/new`, `/sites/:siteId`, `/sites/:siteId/edit` — üçü de stub/mock sayfaya bağlıydı. **Düzeltildi** (redirect'e çevrildi).
- **Düzeltme (önceki iddia yanlıştı): MapViewPage stub DEĞİL.** `MapViewPage.tsx` gerçek Leaflet + Sentinel Hub + CMEMS + AOI drawing implementasyonu içeriyor. Önceki frontend envanter agent'ı bunu yanlış "mock" olarak işaretlemiş. §21'deki stub listesinden kaldırılmalı (aşağıdaki güncellemeler listesinde).
- **Düzeltme: FarmFormPage URL.** Önceki dokümanda "`/farms/new`" yazılmıştı; gerçek URL `/sites/new`. Ayrıca `/sites/:siteId/edit` de aynı sayfaya gidiyordu (site edit flow). Yani veri kaybı iki giriş noktası üzerinden mümkündü — tek değil.
- **Ek bulgu: 16 backend mutation'ın frontend karşılığı yok.** Fix A sırasında yapılan cross-reference tarama sonucu (Explore agent raporu):
  - Tier 1 (kritik iş akışı): `updateBatchStatus`, `closeBatch`, `allocateBatchToTank`, `createSubEquipment`, `assignFeedsToBatch`
  - Tier 2 (destek ops): `updateBatch`, `deleteBatchFeedAssignment`, `updateBatchFeedAssignment`, `generateWorkOrderFromSchedule`, `completeMaintenance`
  - Tier 3 (bulk/advanced): `createBatchWaterQualityMeasurements`, `processAutoGenerateWorkOrders`, `updateMeterReading`
  - Sub-equipment CRUD (3): `createSubEquipment`, `updateSubEquipment`, `deleteSubEquipment`
  - Admin-only (meşru): `updateSentinelHubInstanceId`
  
  **Scope dışı:** Bu oturumda UI eklenmedi. Yeni iş kalemleri olarak takip edilmeli.
- **Ek bulgu: allocate-to-tank, transfer-batch, create-batch halen `TankCapacityService` kullanmıyor.** Mevcut inline density logic (create-batch.handler:395-425) servise migrate edilmedi — sadece en kritik handler (`deploy-cleaner-fish`) düzeltildi. Diğer handler'larda capacity check var ama ayrık implementasyonlar. Follow-up refactor commit'i gerek.
- **Ek bulgu: `createFarm` / `createPond` handler dosyaları (`create-farm.handler.ts`, `create-pond.handler.ts`) mevcut.** Resolver'dan çağırma kaldırıldı ama handler sınıfları hala FarmModule'de kayıtlı. Dead code. Silinebilir ama CQRS registration temizliği şu an yapmadım (modül DI ağını değiştirmek riskli). Follow-up.
- **Ek bulgu: `regulatory_events` entity dosyası aslında yok.** Önceki doküman iddiası yanlış — `apps/farm-service/src/regulatory/entities/` sadece `regulatory-settings.entity.ts` içeriyor. `createDiseaseOutbreak` (gorsel §14.3 iddiası) muhtemelen yalnız `health_events`'e yazıyor. Gorsel/anlatim güncellenmeli. (Girdi 15-A5 ile uyumlu ama daha kesin.)
- **Ek bulgu: auto_rule trigger tipi enum-bazlı.** `AutoRuleTrigger` enum: `SCHEDULE`, `EXPIRY_NEAR`, `MAINTENANCE_DUE`, `LICENSE_EXPIRY`, `WATER_PARAM_ALERT`. Gorsel §4.10'daki "koşul örneği: `water.ph < 6.5`" yanlış — serbest expression parser yok. Docs düzeltilmeli (Girdi 15-B14 ile uyumlu).
- **Ek bulgu: Backend `farm/` modülünde hala `CreateFarmHandler` ve `CreatePondHandler` registered.** Bu handler'lar artık çağrılamaz (resolver'dan throw) ama DI'da duruyor. Module.ts'te kayıt silinmeli — ama bu gereksiz risk (modül wiring'i değiştirmek). Handler dosyaları follow-up'ta silinmeli.

#### Uygulanmayan (Follow-up olarak açık)

Bu oturumda uygulanmayıp takip listesine alınanlar:

- `allocate-to-tank.handler.ts`, `transfer-batch.handler.ts`, `create-batch.handler.ts` için `TankCapacityService` migration'u (mevcut inline logic serviste consolidate)
- Backend farm modülü handler'ları (`create-farm.handler.ts`, `create-pond.handler.ts`) silme
- 16 eksik frontend UI (yukarıdaki tier listesi)
- BiomassReportTab partial stub (setTimeout save) tam düzeltme
- Gorsel/anlatim dokümanlarında §21 (stub listesi) düzeltmesi — MapViewPage çıkarılsın, FarmDetailPage girsin
- Gorsel §4.10 auto_rule örnekleri (`water.ph < 6.5`) düzeltilsin — enum-bazlı trigger olduğu yazılsın
- Gorsel/anlatim §14.3 regulatory_events iddiası kaldırılsın

---

## Dokümandaki Acil Eylem Listesi (Kod Değişikliği Gerektirenler)

🔴 **Kritik compliance / veri kaybı bug'ları — PR ile düzeltilmeli:**

1. **Module.tsx:55,58** — FarmFormPage route'larını `<Navigate to="/sites" replace />` ile değiştir (veri kaybını durdur)
2. **create-harvest-record.handler.ts** — HealthEvent repo inject et, batch'in aktif olay'ları için `earliest_harvest_date > harvestDate` kontrolü ekle ve erken hasadı blokla
3. **deploy-cleaner-fish.handler.ts** — tank'ın `max_biomass_kg` vs toplam biomass (salmon + cleaner) kontrolü ekle
4. **Outbox cleanup** — `cleanup_old_audit_logs()` için scheduler (`@Cron('0 4 * * *')`) eklenmeli
5. **Stub sayfalar** — `FarmListPage` delete, `MapViewPage`, `BiomassReportTab` için ya implementasyon ya kaldırma

## Dokümandaki Düzeltme Listesi (Bu Doküman Tamamlandığında Uygulanacak)

1. **§4.5 / §5.1** — `farm.tanks` "equipment alias" iddiası yerine "ayrı legacy tablo + equipment yeni source of truth" açıklaması.
2. **§5.3** — createBatch'te Tank tablosu legacy fallback olarak UPDATE edildiği, batch handler içinde "serial queryBuilder UPDATE" olduğu not edilmeli.
3. **§8 (Outbox)** — Cron interval, LISTEN/NOTIFY, lease, retry/backoff, dead-letter, cleanup, metrics bilgisi eklenmeli.
4. **§6 (Feeding)** — FEFO sorgusu: tiebreaker yok, expired filtrelenmiyor, backdating mismatch'i.
5. **§14.3 (Regulatory)** — "Sistem otomatik gönderir (5 rapor tipi)" + "Disease/Escape/Welfare manuel kalıyor" + "SLA takibi yok" şeklinde düzeltilmeli.
6. **§22 (Güvenlik)** — Soft delete + FK etkileşimi, backdating politikası, JSONB hybrid önerisi yeni alt başlıklar.
7. **§1 (Kapsam)** — 70 tablo: "X'i legacy + Y'si aktif" ayrımı. REST: 1 domain + 2 read/proxy.

---

## Plan Fazında Tespit Edilen Orphan Bulgular

Kalan kör noktaları planlarken (bkz `/root/.claude/plans/` 7-faz planı) kod okunurken ortaya çıkan ve mevcut herhangi bir fazla *doğrudan* ilişkili olmayan bulgular. Her biri bağımsız takip edilir — implementasyon sırasında ilgili fazla birleştirilir veya ayrı PR olur.

### Orphan 1 — PR #21 Regresyonu: `vite.config.ts` Silinmiş Dosyaları Expose Ediyor 🔴 **DÜZELTİLDİ**

**Bulgu:** Önceki oturumda `FarmListPage` ve `FarmDetailPage` silindi (commit `67c9c472`), ama `web/modules/farm-module/vite.config.ts:21-22` module federation `exposes` block'unda hala `'./FarmList'` ve `'./FarmDetail'` kayıtlıydı. Aynı şekilde `web/shell/src/types/remote-modules.d.ts:33-43` bu iki export için TypeScript `declare module` tanımları tutuyordu.

**Etki:** Farm-module vite build kırılırdı (kaynak dosya yok, expose path resolution fail). Shell type-check'te dangling declaration uyarısı.

**Düzeltildi:** Bu PR'da (`docs/farm-orphans` branch'inde):
- `vite.config.ts` `exposes` block'undan iki satır silindi
- `remote-modules.d.ts` karşılığı declaration'lar silindi
- İki dosyada yorum bırakıldı ("removed together with FarmListPage/FarmDetailPage in 67c9c472")

**Ders:** Frontend microfrontend federation değişikliklerinde her zaman:
1. `exposes` block kontrolü
2. Shell tarafındaki `remote-modules.d.ts` declaration kontrolü
3. Consumer import'ları (şimdiki durumda yok ama olabilirdi)

### Orphan 2 — `allocate-to-tank` Zaten Hard-Enforce Yapıyor — Plan Faz 1.1 Güncellendi

**Bulgu:** `apps/farm-service/src/batch/handlers/allocate-to-tank.handler.ts:131-165` "LIFE-SAFETY: Hard capacity enforcement" başlığıyla zaten capacity check yapıyor — ama `TankCapacityService` değil `equipment.hasCapacityFor()` entity metodu üzerinden.

**Etki:** Aynı invariant iki yerde (entity method + service). Plan Faz 1.1 "migration" yerine "central consolidation" olarak güncellendi.

**Aksiyon (Faz 1.1 sırasında):** `Equipment.hasCapacityFor()` deprecate edilir, `TankCapacityService.enforce()` çağrısına delegate edilir.

### Orphan 3 — `Equipment.hasCapacityFor()` Competing API

**Bulgu:** Equipment entity'si (allocate-to-tank'ten referans) muhtemelen inline `hasCapacityFor()` method'una sahip. `TankCapacityService` ile rakip pattern.

**Aksiyon (Faz 1.1):** Entity metod silinmez (backward compat için), ama `@deprecated` JSDoc + gövdesi `TankCapacityService.enforce()` çağrısına yönlendirilir.

### Orphan 4 — Legacy `farm.farms` Cross-Service Sorgulanıyor 🔴

**Bulgu:** `apps/observability-service/src/metrics/metrics-aggregator.service.ts:186`:
```ts
`SELECT count(*)::text as count FROM farm.farms WHERE "tenantId" = $1`
```

**Etki:** Farm modülü `farms` tablosunu deprecate ettik (backend mutation'lar throw ediyor) ama observability-service hâlâ bu tablodan tenant istatistiği okuyor. Legacy migration (Plan Faz 4.3) sırasında observability-service güncellenmedikçe bu sorgu 0 döndürmeye başlar.

**Aksiyon (Faz 4.3 pre-migration):** Observability-service sorgusu `farm.sites` veya yeni tenant-count kaynağına yönlendirilmeli. Ayrı bir commit/PR içinde.

### Orphan 5 — `admin-api-service` SQL Security Test `farm.ponds` Referansı

**Bulgu:** `apps/admin-api-service/src/database-management/controllers/__tests__/explorer-sql-security.spec.ts:264`:
```ts
const res = await postQuery('SELECT * FROM farm.ponds');
```

**Etki:** Ponds tablosu kaldırılırsa (Plan Faz 4.3) test failing olur.

**Aksiyon (Faz 4.3 pre-migration):** Test hedefi başka legacy tabloya (`farm.farms` veya `farm.batches`) veya generic negative-security target'a güncellenmeli.

### Orphan 6 — `farm.entity.ts:81` Pond Sirkülarity Yorumu

**Bulgu:** Farm entity'sinde Pond ilişkisi relation decorator yerine resolver-tarafında query ile yönetiliyor:
```ts
// Use farm.ponds query in resolver instead to avoid circular type issues
```

**Etki:** Farm/Pond legacy kaldırılırken bu yorum güncellensin. Okuma akışı kalıyorsa dokümante edilsin.

**Aksiyon (Faz 1.2):** Yorum "READ-ONLY LEGACY" olarak güncellenir.

### Orphan 7 — 6+ Entity'de `restore()` Var Ama Hiçbiri GraphQL Mutation Değil

**Bulgu:** `feed-type-species.entity.ts`, `feed.entity.ts`, `batch-feed-assignment.entity.ts`, `supplier.entity.ts`, `sub-system.entity.ts`, `species.entity.ts` — hepsinde `restore(): void { this.isDeleted = false; ... }` method'u tanımlı ama hiçbiri GraphQL mutation olarak expose edilmemiş.

**Aksiyon (Plan Faz 4.2):** Generic `RestorableResolver<T>` mixin yazılır, 6+ resolver bunu extend eder. UI kullanıcıya restore butonu sunar.

### Orphan 8 — `libs/storage` MinIO Client Zaten Mevcut (Plan Güncellendi)

**Bulgu:** `libs/storage/src/minio-client.service.ts` — tam MinIO S3-compatible client zaten var. Plan Faz 6.2 "yeni yaz" iddiası yanlıştı.

**Düzeltildi:** Plan Faz 6.2 "wrap, don't recreate" olarak güncellendi. `FileUploadSecurityService` `MinioClientService`'i sarar — pre-upload mime/size/EXIF, post-upload ClamAV async scan.

### Orphan 9 — `graphql-query-complexity` Paketi package.json'da Yok

**Bulgu:** `grep "graphql-query-complexity" package.json` → 0 hit. Plan Faz 5.4 `npm install` adımı gerektirir.

**Aksiyon (Faz 5.4 başlangıçta):** `npm add graphql-query-complexity@^5.0.0` root monorepo'da.

### Orphan 10 — `TenantProvisionedEvent` Contract Mevcut Değil

**Bulgu:** `grep "TenantProvisioned|TenantCreated" libs/shared-contracts/` → 0 hit.

**Aksiyon (Faz 7.5):** Yeni event contract `libs/shared-contracts/src/events/tenant-provisioned.event.ts` oluşturulur. Publisher tarafı (admin-api-service veya tenant-service) ayrı PR'da sarmalanır.

### Orphan 11 — Sensor Modülünde TimescaleDB Continuous Aggregate Pattern Mevcut

**Bulgu:** `database/migrations/modules/sensor/V003__create_continuous_aggregates.sql` — `sensor.metrics_1min`, `sensor.metrics_1hour`, `sensor.metrics_1day` continuous aggregates kullanıyor.

**Plan güncellemesi:** Faz 7.2 analytics pipeline için aynı pattern — `CREATE MATERIALIZED VIEW` yerine `create_continuous_aggregate()` + `add_continuous_aggregate_policy()`. Automatic refresh, manuel cron gerekmez.

### Orphan 12 — `AllExceptionsFilter` Farm-Service'te Yok

**Bulgu:** `find . -name "*exceptions.filter.ts"` farm-service'te hit yok. Gateway-api veya backend-common'da shared filter var mı kontrol edilmedi.

**Aksiyon (Faz 6.4 hazırlık):** İlk adım `gateway-api/` ve `libs/backend-common/` taraması. Var ise reuse; yoksa `libs/backend-common/src/errors/` içinde yeni.

### Orphan 13 — `FarmRepository` Hâlâ Aktif ve Registered

**Bulgu:** FarmModule `app.module.ts:45, 336` registered; `FarmRepository` query handler'lar tarafından kullanılıyor. Handler'ları silmek FarmRepository'yi kaldırmaz — read-only legacy olarak kalmalı.

**Aksiyon (Faz 1.2):** Sadece `CreateFarmHandler`/`CreatePondHandler` silinir. Query handler'lar + FarmRepository kalır. `farm.entity.ts:81` yorumu "READ-ONLY LEGACY" olarak güncellenir.

### Orphan 14 — `batch_feed_assignments` UNIQUE Kısıt + Restore Çakışması

**Bulgu:** `batch_feed_assignments` tablosu `(tenant_id, batch_id)` UNIQUE kısıtı var (resolver:37 batch başına tek assignment varsayımı). Restore edilmiş (is_deleted=true) bir satır restore edilirken aktif aynı batch'te zaten başka satır varsa UNIQUE çakışması.

**Aksiyon (Faz 4.2):** `RestoreService.restore()` pre-check: UNIQUE kısıtı kırılacak senaryoda 409 döner, kullanıcıya "existing active record must be soft-deleted first" mesajı.

### Orphan 15 — Deploy Cleaner Fish Frontend Pre-Check Query Yapmıyor

**Bulgu:** `web/modules/farm-module/src/pages/cleaner-fish/components/DeployModal.tsx:42,85` `deployCleanerFish` mutation doğrudan çağırıyor. Capacity check pre-submit query yok — kullanıcı sadece 400 hatasıyla bloke olur.

**Aksiyon (Faz 3 içinde genişletilmiş):** Frontend form submit butonu disabled önce `TankCapacityService.check` query'si çağrılır (yeni query: Faz 1.1 ile birlikte expose edilebilir). Hata önizlemesi gösterilir.

### Orphan 16 — Method İsim Duplikasyonu: `cleanupOldData`

**Bulgu:** Farklı modüllerde aynı method adı:
- `apps/farm-service/src/scheduler/cron-jobs.service.ts:709` — farm cleanup
- `apps/farm-service/src/weather/services/weather-cron.service.ts:111` — weather cleanup
- `apps/admin-api-service/src/impersonation/services/*.ts` — 3 farklı

**Etki:** `@Cron` registration isimlerı farklı (`cleanupOldData` vs `weatherCleanup`) — gerçek çakışma yok. Sadece okuyucu karışıklığı.

**Aksiyon:** Düşük öncelik. Gelecek refactor'da her method adı modül-prefix alabilir (`auditCleanup`, `weatherCleanup`). Koda dokunulmasın.

### Orphan 17 — `StorageInventory.receivedDate` Sütunu Kodda Referans Var Ama Entity'de Yok

**Bulgu:** Faz 1.3 FEFO hardening iki noktada `inv.receivedDate` sütununu sorguluyor:
- `apps/farm-service/src/storage/handlers/record-stock-movement.handler.ts:456,460`
- `apps/farm-service/src/storage/event-handlers/feeding-storage-event.handler.ts:146,148`

`apps/farm-service/src/storage/entities/storage-inventory.entity.ts` dosyasında `receivedDate` / `received_date` sütunu tanımlı değil. TypeORM query builder `inv.receivedDate` ifadesini entity metadata'ya göre SQL'e çevirdiği için sütun bulunamadığında çalıştırma zamanında `ColumnMetadataNotFoundError` fırlatır. Hem query hem order-by ifadeleri aynı sütuna güveniyor.

**Etki:** Deterministik FEFO tiebreak ve as-of scoping runtime'da çalışmaz — bir movement kaydı FEFO yolu tetiklendiğinde (yani `lotNumber` verilmemişse) 500 hatası döner. Aktif kullanımda henüz fark edilmemiş olabilir çünkü çoğu movement `lotNumber` explicit taşır (operator deliveries lot number girer) — o durumda `if (lotNumber)` dalı alınır, FEFO sorgusuna düşmez.

**Aksiyon:** Faz 1.3 PR'ının eksik parçası olarak
- `storage_inventory` tablosuna `received_date TIMESTAMPTZ` sütunu eklenir (migration: `alter table farm.storage_inventory add column received_date timestamptz default now()`)
- `StorageInventory` entity'sine `@Column({ type: 'timestamptz', nullable: true, name: 'received_date' }) receivedDate?: Date;` property eklenir
- `increaseInventory` yeni row oluştururken `receivedDate: new Date()` yazar, update path'inde dokunmaz (orijinal receipt tarihi korunur)

Bu orphan'ı Faz 1.3 hot-fix olarak **ayrı PR** ile kapatmak gerekir — Faz 2.4 (lot-mixing) scope'una dahil değil. Kendi Girdi kimliği alır.

---

## Orphan Takip Tablosu

| # | Başlık | Durum | İlgili Faz |
|---|--------|-------|-----------|
| 1 | vite.config.ts FarmList/FarmDetail exposes regresyonu | ✅ Düzeltildi (bu PR) | — |
| 2 | allocate-to-tank zaten hard-enforce | 📋 Faz 1.1 plan güncel | Faz 1.1 |
| 3 | Equipment.hasCapacityFor() duplicate | 📋 Faz 1.1 plan güncel | Faz 1.1 |
| 4 | observability-service farm.farms | ✅ RESOLVED (Faz 4.3 pre) | Switched to `farm.sites` + isDeleted filter |
| 5 | admin-api test farm.ponds | ✅ RESOLVED (Faz 4.3 pre) | Test updated to `farm.sites` |
| 6 | farm.entity.ts pond comment | 📋 Faz 1.2 | Faz 1.2 |
| 7 | restore() 6+ entity'de expose edilmemiş | 📋 Faz 4.2 mixin | Faz 4.2 |
| 8 | libs/storage MinIO mevcut | 📋 Faz 6.2 güncel | Faz 6.2 |
| 9 | graphql-query-complexity paketi yok | 📋 npm install | Faz 5.4 |
| 10 | TenantProvisionedEvent contract yok | 📋 Greenfield | Faz 7.5 |
| 11 | TimescaleDB continuous aggregate pattern | 📋 Pattern reuse | Faz 7.2 |
| 12 | AllExceptionsFilter yok | 📋 Greenfield | Faz 6.4 |
| 13 | FarmRepository read-only legacy | 📋 Comment update | Faz 1.2 |
| 14 | batch_feed_assignments UNIQUE + restore | 📋 Pre-check | Faz 4.2 |
| 15 | Cleaner fish deploy pre-check query yok | 📋 UI genişlet | Faz 3 + 1.1 |
| 16 | cleanupOldData method isim duplikasyonu | ⚠ Düşük öncelik | cosmetic |
| 17 | StorageInventory.receivedDate entity'de yok | ✅ RESOLVED (Faz 1.3 hot-fix) | 1787100000000 migration + entity + handler insert |
| 18 | Faz 3 Tier 1 — updateBatchStatus UI | ✅ RESOLVED (Faz 3 partial) | Phase 3 Tier 1 |
| 19 | Faz 3 Tier 1 — closeBatch UI (acknowledgeActiveTreatments) | ✅ RESOLVED (Faz 3 partial) | Phase 3 Tier 1 |
| 20 | Faz 3 Tier 1 — allocateBatchToTank UI | ✅ RESOLVED (Faz 3 partial) | Phase 3 Tier 1 |
| 21 | Faz 3 Tier 1 — createSubEquipment UI + update/delete (Tier 3) | ✅ RESOLVED (Faz 3 partial) | Phase 3 Tier 1 part 2 |
| 22 | Faz 3 Tier 1 — assignFeedsToBatch UI + update/delete (Tier 2) | ✅ RESOLVED (Faz 3 partial) | Phase 3 Tier 1 part 2 |
| 23 | Faz 4.2 — Generic RestoreService + restore mutations | ✅ RESOLVED (Faz 4.2) | Girdi 6 — Feed/Species/Supplier/Chemical/Consumable surfaces |
| 24 | Faz 4.1 — Domain retention functions + cron wiring | ✅ RESOLVED (Faz 4.1) | Girdi 14b — feeding/growth/wq/tank_op/harvest retention |
| 25 | Faz 5.4 — GraphQL query complexity limit | ✅ RESOLVED (Faz 5.4) | Girdi 15-C9 + Orphan 7 — default 1000 with env override |
| 26 | Faz 5.2 — JSONB GIN index (narrowed to real workload) | ✅ RESOLVED (Faz 5.2 narrowed) | `storage_lot_mixes.contributingLots` — traceLot path; WQ + batch-weight indexes skipped as speculative |
| 27 | Faz 5.3 — Prometheus domain metrics | ✅ RESOLVED (Faz 5.3) | Girdi 14d — FarmDomainMetricsService + APP_INTERCEPTOR + backdate wiring |
| 28 | Faz 5.5 — Timezone-aware recurring tasks | ✅ RESOLVED (Faz 5.5) | Girdi 15-B13 — luxon + `timezone` column + DST-safe DAILY/MONTHLY |
| 29 | Faz 6.4 — Structured error conventions | ✅ RESOLVED (Faz 6.4) | Girdi 15-C1 + Orphan 10 — FarmAppError base + 5 concrete classes + filter |
| 30 | Faz 6.4.1 — Migration of throw sites | ✅ RESOLVED (Faz 6.4.1) | TankCapacity / Backdate / Restore / HarvestPolicy migrated; HarvestEligibility throws via HttpException chain already structured |
| 31 | Faz 6.4.2 — Withdrawal throw-site migration + 5.3.1 tenantId metrics wiring | ✅ RESOLVED (Faz 6.4.2 + 5.3.1) | close-batch + create-harvest-record call sites emit BatchWithdrawalBlockedError + incWithdrawalBlock; TankCapacityService emits incCapacityBlock |
| 32 | Faz 6.1 — Permission matrix SSoT + invariant + surfaced recordStockMovement duplicate | ✅ RESOLVED (Faz 6.1) | Girdi 15-C2 — 198 mutations / 193 queries classified; 227 ungated ops whitelisted for phase 6.1.1; spare-part `recordStockMovement` renamed to `recordSparePartStockMovement` to break the federation name collision |
| 33 | Faz 6.5 — WQ strict validation + zero-config gate | ✅ RESOLVED (Faz 6.5) | Girdi 15-B5 — strict default; opt-out via env |
| 34 | Faz 7.5 partial — WQ parameter config seeder | ✅ RESOLVED (Faz 7.5 partial) | Girdi 15-C7 partial — seedDefaultWaterQualityParameterConfigs mutation; closes phase 6.5 onboarding gap |
| 35 | Orphans 3 + 5 — cross-service `farm.farms`/`farm.ponds` refs | ✅ RESOLVED (Faz 4.3 pre) | observability + admin-api swap onto `farm.sites` — unblocks Faz 4.3 legacy migration |
| 36 | Faz 7.3 — Systematic @Cacheable interceptor | ✅ RESOLVED (Faz 7.3) | Girdi 15-C3 — decorator + interceptor + module + parameterTemplates wiring |
| 37 | Faz 5.7 — JSONB patch service | ✅ RESOLVED (Faz 5.7) | Girdi 15-B3 — jsonb_set() UPDATE with whitelist + tenant/id guard — sibling handlers on different JSONB keys commit concurrently |
| 38 | Faz 6.1.2 — Runtime fail-closed permission matrix guard | ✅ RESOLVED (Faz 6.1.2) | Unknown operations 403 at runtime; grandfathered + introspection pass |
| 39 | Faz 7.2 — Daily batch feeding materialized view + nightly refresh | ✅ RESOLVED (Faz 7.2) | Girdi 15-C12 — `farm.mv_daily_batch_feeding` + CONCURRENTLY refresh at 03:00; Timescale upgrade path documented |
| 40 | Faz 7.3.2 — @CacheEvict decorator + APP_INTERCEPTOR | ✅ RESOLVED (Faz 7.3.2) | Declarative cache invalidation completes the Phase 7.3 caching contract |
| 41 | Faz 7.5 full — Tenant onboarding event handler | ✅ RESOLVED (Faz 7.5) | Girdi 15-C7 — TenantCreated wildcard subscription auto-seeds WQ parameter catalogue on provisioning |
| 42 | Faz 6.2 partial — File upload size + mime whitelist | ✅ RESOLVED (Faz 6.2 partial) | Girdi 15-C4 — FileUploadSecurityService with per-document-type policies + magic-byte sniff; EXIF strip (6.2.1) + ClamAV (6.2.2) + orphan cleanup (6.2.3) deferred to follow-ups |
| 43 | Faz 7.3.1 partial — batch-performance + growth-analysis migrated to @Cacheable | ✅ RESOLVED (Faz 7.3.1 partial) | Ad-hoc Redis blocks stripped from handlers; @Cacheable at the resolver boundary; AI-insights keeps its stale-fallback pattern |
| 44 | Faz 7.2.2 — WQ daily materialized view | ✅ RESOLVED (Faz 7.2.2) | `farm.mv_daily_tank_water_quality` — avg/min/max per (tenant, tank, day); nightly CONCURRENTLY refresh |
| 45 | Faz 6.2.1 — EXIF / metadata strip for image uploads | ✅ RESOLVED (Faz 6.2.1) | sharp-based strip on JPEG/PNG/WEBP; PDFs pass through; fail-safe on corrupt files |
| 46 | Faz 6.1.1 (task module) — Thread @Roles on 13 ungated ops | ✅ RESOLVED (Faz 6.1.1 task-module) | Task + recurring-template + auto-rule mutations annotated; UNGATED_OPERATIONS whitelist shrinks from 227 → 214 |
| 47 | Faz 6.1.1 (work-order + maintenance) — Thread @Roles on 20 ungated ops | ✅ RESOLVED (Faz 6.1.1 maintenance-module) | Work-order + maintenance-schedule resolvers annotated; UNGATED_OPERATIONS whitelist shrinks from 214 → 194 |
| 48 | Faz 6.1.1 (health + system + feed) — ALL MUTATIONS CLASSIFIED | ✅ RESOLVED (Faz 6.1.1 complete for mutations) | Every @Mutation now carries @Roles; UNGATED_OPERATIONS contains queries only |
