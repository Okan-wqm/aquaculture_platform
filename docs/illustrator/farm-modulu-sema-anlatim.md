# Farm Modülü — Frontend'den Veritabanına Veri Akışı (Detaylı Teknik Anlatım)

> **Tarihsel envanter:** Bu dosya 2026 ilkbaharındaki farm modülünü anlatır;
> güncel API veya runtime sözleşmesi değildir. Eski `MapViewPage`, tenant
> Sentinel credential formu, weather settings ve point/AOI/tile proxy
> anlatımları emekliye ayrılmıştır. Güncel çevresel izleme sözleşmesi için
> `apps/farm-service/schema.graphql`,
> `docs/api/openapi/farm-service.yaml` ve
> `docs/runbooks/monitoring/farm-environment-monitoring.md` kaynak alınır.

Bu doküman farm modülünün tamamını, ekrandan veritabanına kadar olan veri akışını her alan ve her tablo için açıklayan resmi bir teknik referanstır. Modülü hiç bilmeyen bir okuyucunun takip edebileceği şekilde yazılmıştır; hiçbir teknik terim varsayılmadan tanımlanır. Tablo-bazlı hızlı başvuru için bkz: [`farm-modulu-sema-gorsel.md`](./farm-modulu-sema-gorsel.md).

**Doküman kapsamı:**

- 70 veritabanı tablosu (69 `farm` şeması + 1 `public` şeması)
- 36 GraphQL resolver (~80 mutation, ~60 query)
- 3 REST controller, 1 ana event handler
- 21 frontend sayfa, 28+ form modal, 500+ form alanı

---

## İçindekiler

1. [Modül Nedir, Ne İşe Yarar](#1-modül-nedir-ne-işe-yarar)
2. [Katman Mimarisi — Veri Hangi Yollardan Geçer](#2-katman-mimarisi--veri-hangi-yollardan-geçer)
3. [Tekrar Eden Kavramlar — Önce Bunları Anla](#3-tekrar-eden-kavramlar--önce-bunları-anla)
4. [Setup / Core — Tesisten Ekipmana Hiyerarşi](#4-setup--core--tesisten-ekipmana-hiyerarşi)
5. [Batch — Balık Partisinin Yaşam Döngüsü](#5-batch--balık-partisinin-yaşam-döngüsü)
6. [Feeding — Yemleme Süreçleri](#6-feeding--yemleme-süreçleri)
7. [Growth — Büyüme Ölçümleri](#7-growth--büyüme-ölçümleri)
8. [Water Chemistry — Su Kimyası](#8-water-chemistry--su-kimyası)
9. [Storage & Inventory — Depo ve Stok](#9-storage--inventory--depo-ve-stok)
10. [Maintenance — Bakım Yönetimi](#10-maintenance--bakım-yönetimi)
11. [Health — Sağlık Olayları](#11-health--sağlık-olayları)
12. [Tasks — Görevler ve Otomasyon](#12-tasks--görevler-ve-otomasyon)
13. [Harvest — Hasat](#13-harvest--hasat)
14. [Reports / Regulatory — Resmi Raporlar](#14-reports--regulatory--resmi-raporlar)
15. [Weather, Marine, Sentinel Hub — Çevresel Veriler](#15-weather-marine-sentinel-hub--çevresel-veriler)
16. [Cleaner Fish — Temizleyici Balık İşlemleri](#16-cleaner-fish--temizleyici-balık-işlemleri)
17. [Worker, Company, Site Contacts](#17-worker-company-site-contacts)
18. [AI Insights](#18-ai-insights)
19. [Sensör Paneli, Analitik, Harita](#19-sensör-paneli-analitik-harita)
20. [Audit Log ve Outbox — Görünmez Yan Etkiler](#20-audit-log-ve-outbox--görünmez-yan-etkiler)
21. [Stub ve Ölü Ekranlar — Veri Kaybı Noktaları](#21-stub-ve-ölü-ekranlar--veri-kaybı-noktaları)
22. [Güvenlik ve Tasarım Uyarıları](#22-güvenlik-ve-tasarım-uyarıları)

---

## 1. Modül Nedir, Ne İşe Yarar

Farm modülü, su ürünleri çiftliği (aquaculture) operasyonlarının tamamını yönetir. Bir çiftlik, çok sayıda fiziksel **tesis** (site), her tesiste **departmanlar**, her departmanda **sistemler** (örneğin RAS — Recirculating Aquaculture System), her sistemde **tanklar / kafesler / havuzlar** içerir. Bu yapıya **balık partileri** (batch) yerleştirilir, **yemlenir**, **ölçülür**, zaman zaman **ilaç verilir**, hastalandıkça **sağlık olayı** açılır, **hasat edilir** ve satılır.

Modül bu operasyonların her birini kayıt altına alır. Bir kullanıcı frontend üzerinden bir form doldurup "Kaydet" dediğinde, veri katmandan katmana geçerek PostgreSQL tablolarına düşer. Bu dokümanın amacı **hangi form alanının, hangi tabloya, hangi sütun olarak** kaydedildiğini tam olarak göstermektir.

---

## 2. Katman Mimarisi — Veri Hangi Yollardan Geçer

Sistem beş ayrı katmandan oluşur. Bir form verisi "Kaydet" butonundan PostgreSQL'e ulaşana kadar bu beş katmanın hepsinden geçer.

### Katman 1 — Frontend

- Konum: `web/modules/farm-module/src/`
- Teknoloji: React, Apollo GraphQL client, bazı yerlerde `fetch` (REST)
- İçerik: 21 sayfa, 28'den fazla modal, 500'den fazla form alanı
- Görev: Kullanıcıdan veri toplamak, doğrulamak, API'ye göndermek

### Katman 2 — API

İki alt katman:

**GraphQL**

- 36 resolver dosyası
- Yaklaşık 80 mutation (yazma işlemleri), 60 query (okuma)
- Her resolver'ın karşılığı bir veya birden fazla tablodur
- Tenant bilgisi JWT'den çıkartılır (`@CurrentTenant()` dekoratörü)

**REST**

- Sadece 3 controller: `BatchController` (gerçek domain), `HealthController` (liveness/readiness), `SentinelHubProxyController` (uydu proxy)
- BatchController, GraphQL ile aynı komut handler'ları çağırır — iki kanal da aynı yere yazar. Kullanımı: harici sistem entegrasyonu, SCADA, toplu veri aktarımı.

### Katman 3 — CQRS Handler

- Command Handler: yazma işlemleri (~150 dosya), `apps/farm-service/src/**/handlers/`
- Query Handler: okuma işlemleri (~90 dosya), `apps/farm-service/src/**/query-handlers/`
- Tasarım ilkesi: Yazma ile okuma ayrıdır. Bir komut handler'ı asla okumaz, bir sorgu handler'ı asla yazmaz.
- Her command handler bir transaction içinde çalışır — ya tüm yazımlar başarılı olur ya da hiçbiri olmaz.

### Katman 4 — Event Bus (NATS) ve Outbox

- Command handler transaction'ının son adımı: `farm.farm_outbox` tablosuna olay (event) satırı yazmak.
- Arka plandaki bir worker (`OutboxWorkerService`) yayınlanmamış satırları okuyup NATS mesaj kuyruğuna basar.
- Subject formatı: `events.{tenantId}.{EventType}`
- 7 listener bu event'leri dinler. Bunlardan **bir tanesi** gerçekten veritabanına yazar: `FeedingStorageEventHandler` — yemleme yapıldığında stoktan otomatik düşüm kaydı atar.
- Diğer listener'lar sadece loglar veya downstream event üretir.

### Katman 5 — PostgreSQL

- Şema: `farm` (69 tablo) ve `public` (1 tablo: `feeder_calibrations`)
- Yapı: Migration dosyaları çekirdek 11 tabloyu tanımlar; diğer 59 tablo TypeORM'un `synchronize()` mekanizması ile runtime'da entity decorator'larından otomatik oluşur (`apps/farm-service/src/app.module.ts:87,182`).
- Her satır `tenant_id UUID` ile etiketlenir. Her sorgu `WHERE tenant_id = ?` filtresi içerir.

### Tipik Akış Özeti

```
Form doldurulur → Kaydet butonu → GraphQL mutation (veya POST /api)
→ Resolver doğrular → Command dispatch → CommandHandler transaction açar
→ INSERT/UPDATE ana tablo(lar)a → INSERT farm_outbox
→ COMMIT → response frontend'e döner
→ (asenkron) OutboxWorker NATS'e publish
→ (asenkron) Listener'lar işler → bazıları ek tabloya yazar
```

---

## 3. Tekrar Eden Kavramlar — Önce Bunları Anla

Dokümanın kalanında bu terimler sürekli geçer; her birini burada açıklıyoruz.

### Multi-Tenant (Çok Kiracılı)

Sistem aynı veritabanını birden çok müşteri (kiracı / tenant) için kullanır. Her kayıt bir `tenant_id` değeri taşır. Bir kiracının sorguları diğerinin verisine erişemez. `tenant_id` istemciden **kabul edilmez** — her zaman JWT token'dan çıkarılır.

### Soft Delete

Kritik tablolarda (`batches_v2`, `feeds`, `feeding_programs`, `consumables`, `chemicals` vb.) "silme" işlemi satırı DELETE etmez; `is_deleted = true`, `deleted_at = NOW()`, `deleted_by = userId` yazar. Geriye dönüş (`undelete`) mutation'ı expose edilmemiştir; veri kaybolmaz ama liste sorgularında görünmez.

### Optimistik Kilitleme

Birden fazla kullanıcı aynı kaydı aynı anda güncellemeye çalışırsa çakışmayı önlemek için `version` sütunu kullanılır. Kullanıcı eski versiyonu okuyup kaydetmeye çalışırsa mutation başarısız olur; kullanıcı yeniden yüklemek zorunda kalır.

### JSONB

PostgreSQL'in yapılandırılmış JSON tipi. Bazı form alanları ayrı sütun yerine tek JSONB sütununa gömülür. Avantajı: esnek şema, yeni alan eklemek migration istemez. Dezavantajı: standart indexle filtreleme ve sıralama zor; sorgu biraz daha karmaşık (`metadata->>'siteManager'`).

### CQRS

Command Query Responsibility Segregation. Yazma işlemleri "command" (emir), okuma işlemleri "query" (sorgu) diye iki ayrı akışta işlenir. Bir command handler, ilgili tablolara yazıp bir event yayınlar; bir query handler sadece okur ve DTO döner.

### Outbox Pattern

Microservice mimarisinde iki farklı kaynağa (DB + message queue) atomik yazım sorunu vardır. Çözüm: transaction içinde hem ana tabloya hem `farm_outbox`'a yaz. Daha sonra bir worker outbox'ı tarayıp NATS'e basar. Mesaj teslimi garanti edilir, transaction bütünlüğü korunur.

### FEFO

First Expiry First Out. Stokta birden fazla parti (lot) olduğunda, önce son kullanma tarihi yakın olan tüketilir. `FeedingStorageEventHandler` otomatik stok düşümünde bu kuralı uygular.

### Denormalize / Runtime Sync

TypeORM `synchronize()` — entity sınıfındaki decorator'lara bakıp tabloyu ve sütunları otomatik oluşturur/günceller. Migration dosyası yazmaya gerek kalmaz, ama production'da açık olması tehlikelidir. Bu proje bunu kontrollü şekilde `SourceSchemaBootstrapService` ile uygular.

### Idempotency

Aynı işlemin iki kez yapılması zarar vermez. `FeedingStorageEventHandler` her stok düşümüne `idempotencyKey = "feeding-deduct-{eventId}"` verir. Aynı event tekrar teslim edilirse (NATS at-least-once garanti verir) `stock_movements.idempotency_key UNIQUE` kısıtı ikinci yazımı engeller.

---

## 4. Setup / Core — Tesisten Ekipmana Hiyerarşi

### 4.1 Ne İşe Yarar

Farm modülünün kök hiyerarşisi: **Tesis → Departman → Sistem → Alt Sistem → Tank / Ekipman**. Bu ağacı kurmadan hiçbir batch, feeding veya water quality işlemi yapılamaz. Ayrıca burada **tür kataloğu** (species), **yem kataloğu** (feeds), **kimyasal kataloğu** (chemicals), **tedarikçi kataloğu** (suppliers) oluşturulur.

### 4.2 Kullanıcı Yolculuğu

Ana ekran: `web/modules/farm-module/src/pages/setup/SetupPage.tsx`

SetupPage sekmeli bir arayüzdür. Her sekme bir alt sisteme karşılık gelir:

| Sekme       | Dosya                           | Yazdığı Tablolar                                                     |
| ----------- | ------------------------------- | -------------------------------------------------------------------- |
| Sites       | `setup/tabs/SitesTab.tsx`       | `farm.sites`                                                         |
| Departments | `setup/tabs/DepartmentsTab.tsx` | `farm.departments`                                                   |
| Systems     | `setup/tabs/SystemsTab.tsx`     | `farm.systems`, `farm.sub_systems`                                   |
| Equipment   | `setup/tabs/EquipmentTab.tsx`   | `farm.equipment`, `farm.sub_equipment`, `public.feeder_calibrations` |
| Species     | `setup/tabs/SpeciesTab.tsx`     | `farm.species`                                                       |
| Feeds       | `setup/tabs/FeedsTab.tsx`       | `farm.feeds`, `farm.feed_type_species`, `farm.feed_sites`            |
| Chemicals   | `setup/tabs/ChemicalsTab.tsx`   | `farm.chemicals`, `farm.chemical_sites`                              |
| Suppliers   | `setup/tabs/SuppliersTab.tsx`   | `farm.suppliers`, `farm.supplier_sites`                              |

### 4.3 Site Oluşturma — Adım Adım

**Açılan modal:** `SiteFormModal.tsx`. Sekmeli bir form (Temel / Konum / İletişim).

**Kullanıcı girişi:**

1. "Site Adı" alanına örneğin `"Ege Deniz Tesisi 1"` yazılır.
2. "Site Kodu" alanına örneğin `"EDT-01"` yazılır. Form `toUpperCase()` uygular.
3. "Durum" açılır menüsünden ACTIVE / MAINTENANCE / INACTIVE / CLOSED seçilir.
4. Konum sekmesinde ülke, bölge, sokak, şehir, posta kodu doldurulur.
5. Enlem ve boylam doğrudan sayısal olarak veya harita widget'ı üzerinden seçilir.
6. Zaman dilimi IANA formatında (`Europe/Istanbul`) girilir.
7. Toplam alan m² cinsinden, tesis yöneticisi adı, iletişim e-postası ve telefonu eklenir.

**"Kaydet" basıldığında:**

`useMutation(createSite, ...)` çalışır. GraphQL mutation payload'u `CreateSiteInput` şemasına göre doğrulanır:

- `name`: min 1 karakter, zorunlu
- `code`: min 2 karakter, alfanümerik, zorunlu
- `contactEmail`: `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` regex

**Backend'de:**

1. `SiteResolver.createSite` (dosya: `site/site.resolver.ts`) tetiklenir.
2. `CreateSiteCommand` dispatch edilir.
3. Command handler bir transaction açar.
4. `farm.sites` tablosuna tek INSERT yapılır.
5. `farm.farm_outbox`'a `SiteCreatedEvent` yazılır.
6. Transaction commit edilir.
7. Response frontend'e döner.

**Alan → sütun haritası:**

| Form alanı       | `sites` sütunu                | Not                                                  |
| ---------------- | ----------------------------- | ---------------------------------------------------- |
| Site Adı         | `name` (varchar 255)          | UNIQUE per tenant                                    |
| Site Kodu        | `code` (varchar 50)           | UNIQUE per tenant, uppercase                         |
| Durum            | `status` (enum)               | ACTIVE/MAINTENANCE/INACTIVE/CLOSED                   |
| Açıklama         | `description` (text)          | —                                                    |
| Ülke             | `country` (varchar)           | —                                                    |
| Bölge / State    | —                             | ⚠ `metadata` JSONB içine gömülür (ayrı sütun değil) |
| Sokak Adresi     | `address` (text)              | —                                                    |
| Şehir            | `city` (varchar)              | —                                                    |
| Posta Kodu       | —                             | ⚠ `metadata` JSONB içine gömülür                    |
| Zaman Dilimi     | `timezone` (varchar)          | IANA zone                                            |
| Toplam Alan (m²) | `total_area_m2` (decimal)     | —                                                    |
| Enlem            | `latitude` (decimal)          | —                                                    |
| Boylam           | `longitude` (decimal)         | —                                                    |
| Site Yöneticisi  | —                             | ⚠ `metadata` JSONB içine gömülür                    |
| İletişim E-posta | `contact_email` (varchar 150) | ✅ ayrı sütun                                        |
| İletişim Telefon | `contact_phone` (varchar 50)  | ✅ ayrı sütun                                        |

> **Önemli not:** Bazı kaynaklarda "contact_email metadata'ya gömülür" iddiası vardı. Entity incelendiğinde (`site.entity.ts:225,229`) iki alanın da ayrı sütun olduğu doğrulandı. JSONB'ye gömülen yalnızca `region`, `postalCode` ve `siteManager`'dır.

### 4.4 Department, System, SubSystem

Aynı desenle çalışırlar. Her biri bir sekmede listelenir, modal ile eklenir, `create/update/delete` mutation'ları ile `farm.departments`, `farm.systems`, `farm.sub_systems` tablolarına yazılır. Her biri bir üst seviye entity'yi foreign key olarak referanslar:

- `departments.site_id` → `sites.id`
- `systems.site_id` → `sites.id`, `systems.department_id` → `departments.id` (opsiyonel)
- `sub_systems.system_id` → `systems.id`

**Cascade Delete:** Department silinirken `cascade: boolean` parametresi alınır. Önceden `getDepartmentDeletePreview` ile silinecek alt kayıtlar gösterilir. Cascade true ise alt departmanlar, sistemler, ekipmanlar soft-delete edilir. Yetki: TENANT_ADMIN.

### 4.5 Tank ve Ekipman — Aynı Tabloda

Farm modülünün özel bir tasarım kararı: **tanklar ayrı bir tablo değildir**. Tanklar `farm.equipment` tablosunda `is_tank = true` bayrağı ile işaretlenir. Bunun sebebi, tankın diğer ekipmanlarla (pompa, ısıtıcı, oksijenmetre) aynı özelliklere sahip olmasıdır (üretici, seri no, kurulum tarihi, bakım, vs.). Tank'a özgü alanlar (`volume_m3`, `diameter_m`, `max_biomass_kg` gibi) `specifications` JSONB sütununa `TankSpecifications` yapısıyla gömülür.

**Sonuç:**

- `TankResolver.createTank` → `farm.equipment` (is_tank=true) ve `farm.tanks` alias'lı view olarak görülür.
- `EquipmentResolver.createEquipment` → aynı tabloya `is_tank=false` ile yazar.
- Tank özel sorguları `WHERE is_tank = true` filtresi uygular.

### 4.6 SubEquipment — İç İçe Ekipman

Bir ekipmanın alt bileşenleri olabilir (örneğin bir otomatik yemleyicinin motor, silo, sensör). Bunlar `farm.sub_equipment` tablosunda tutulur ve `parent_equipment_id` ile ana ekipmana bağlanır. UNIQUE kısıt: `(tenant_id, parent_equipment_id, code)`.

### 4.7 Feeder Calibration — Public Şemada

Bir yemleyici her farklı pellet boyutu için farklı kalibrasyon değerlerine sahiptir (örneğin 3 mm pellet için dönüş başına 12.5 g, 6 mm pellet için 28 g). Bu veriler `public.feeder_calibrations` tablosunda saklanır.

**Dikkat:** Bu tablo `farm` şemasında değil `public` şemasındadır (bkz `database/migrations/modules/farm/V005__add_feeder_calibrations.sql:5`). Diğer 69 tablo `farm` şemasında. Sebebi muhtemelen cross-service paylaşımdır — başka servisler de kalibrasyona erişiyor olabilir. Bu bir tasarım tutarsızlığıdır; RLS (Row-Level Security) politikaları farklı uygulanabilir.

### 4.8 Tür Kataloğu (Species)

`farm.species` tablosunda yetiştirilen balık türleri tutulur. Alanlar: ortak ad, bilimsel ad, kategori, su tipi (tatlı / tuzlu / brakish), optimum sıcaklık aralığı, optimum pH, optimum DO (çözünmüş oksijen), tuzluluk aralığı, büyüme hızı verisi (JSONB).

Tür oluşturulduktan sonra her batch `species_id` ile buna bağlanır.

### 4.9 Yem Kataloğu (Feeds)

`farm.feeds` master kataloğudur. Bir yem:

- Kodu, adı, markası, üreticisi
- Tedarikçi referansı (`supplier_id`)
- Türü (PELLET / GRANULE / LARVAL / BROODSTOCK / OTHER)
- Besinsel içeriği (`nutritional_content` JSONB: protein, yağ, kül, karbonhidrat, lif)
- Yemleme tablosu (`feeding_table` JSONB: yaşa/ağırlığa göre rasyon oranı)
- Stok yönetimi: mevcut miktar, minimum stok uyarı eşiği, birim
- Saklama gereksinimleri: min/max sıcaklık ve nem, raf ömrü ay
- Birim fiyatı ve para birimi
- Çevresel etki skoru (`environmental_impact` JSONB)
- Yemleme eğrisi / 2D matrisi (`feeding_curve`, `feeding_matrix_2d` JSONB — sıcaklık × ağırlık → rasyon %)

Ek iki junction tablo:

- `farm.feed_type_species` — hangi yem hangi türe, hangi büyüme aşamasında uygun
- `farm.feed_sites` — hangi yem hangi tesiste onaylı

Tüm bu tabloları tek bir `useFeedsApi()` custom hook'u REST (fetch) ile yönetir. GraphQL mutation'ları da mevcuttur (`createFeed`, `updateFeed`, `deleteFeed`).

### 4.10 Kimyasal Kataloğu (Chemicals)

`farm.chemicals` — ilaç, dezenfektan, pH ayarlayıcı gibi kimyasalları tutar. Alanlar yem kataloğuna benzer ancak:

- `requires_approval` (boolean) — bazı kimyasallar onay gerektirir
- `withdrawal_period_days` — ilaç verildikten sonra hasat yapılamayacak gün sayısı
- `usage_protocol` JSONB — dozaj, uygulama yöntemi
- `safety_info` JSONB — güvenlik bilgi föyü referansı

Dosya eki pattern'i: `addChemicalDocument(chemicalId, documentId, name, type, url, uploadedAt)` — dosya önce MinIO'ya yüklenir, mutation sadece metadata yazar.

### 4.11 Tedarikçi Kataloğu (Suppliers)

`farm.suppliers` — tedarikçi master kayıt. Alanlar: kod, ad, tür (feed / chemical / equipment / consumable), iletişim kişisi / e-posta / telefon, adres, şehir, ülke, ödeme koşulları.

`farm.supplier_sites` junction — bir tedarikçinin hangi tesiste onaylı olduğunu belirtir (`is_preferred`, `notes`).

`farm.supplier_types` — referans tablo, sistem-yönetimli.

---

## 5. Batch — Balık Partisinin Yaşam Döngüsü

### 5.1 Ne İşe Yarar

Bir **batch** (parti), aynı zamanda aynı tür ve aşamada gelen balıkların bir grubudur. Örneğin "1 Nisan 2026'da gelen 50.000 adet 25 g somon yavrusu". Partinin yaşam döngüsü: stoklama → büyüme → yemleme → ölçümler → (gerekirse ilaç) → hasat → kapatma. Her adımda birden fazla tabloya veri düşer.

### 5.2 Batch Oluşturma — En Karmaşık Form

**Ekran:** `production/components/BatchFormModal.tsx` (4 sekmeli form)

Kullanıcı "Yeni Parti" butonuna bastığında açılan bu modal, temel bilgiler / belgeler / tank atamaları / notlar diye dört sekme içerir. Formun tamamı "Kaydet" basıldığında tek bir `createBatch` GraphQL mutation'ında gönderilir.

**Sekme 1 — Temel Bilgiler (11 alan):**

| Alan                  | Açıklama                                                                                |
| --------------------- | --------------------------------------------------------------------------------------- |
| Parti Adı             | İsteğe bağlı, kullanıcı tanımlı etiket                                                  |
| Tür                   | Select; `farm.species` tablosundan gelir                                                |
| Tedarikçi             | Select; `farm.suppliers` tablosundan                                                    |
| Tedarikçi Parti No    | Tedarikçinin kendi iç referans numarası                                                 |
| Irk / Strain          | Tür içindeki ırk varyantı                                                               |
| Giriş Tipi            | Enum: EGGS / LARVAE / POST_LARVAE / FRY / FINGERLINGS / JUVENILES / ADULTS / BROODSTOCK |
| Başlangıç Adedi       | Pozitif tam sayı                                                                        |
| Ortalama Ağırlık (g)  | Min 0.001 g, virgül sonrası 3 basamak                                                   |
| Stoklama Tarihi       | Zorunlu, tarih                                                                          |
| Beklenen Hasat Tarihi | Opsiyonel, tarih                                                                        |
| Hedef FCR             | Feed Conversion Ratio; 0.5–5.0 aralığında                                               |
| Geliş Yöntemi         | Enum: AIR_CARGO / TRUCK / BOAT / RAIL / LOCAL_PICKUP / OTHER                            |

**Sekme 2 — Belgeler (dosya yükleme dizileri):**

İki dizi: `healthCertificates[]` (zorunlu, en az 1, en fazla 5) ve `importDocuments[]` (opsiyonel, en fazla 5). Her belge için:

- Dosya seçilir → `useUploadBatchDocument()` MinIO'ya yükler → `{storagePath, storageUrl, documentId}` döner
- Ek meta veriler girilir: belge adı, belge numarası, düzenleme tarihi, son geçerlilik tarihi, düzenleyen kurum

**Sekme 3 — Tank Atamaları (dizi, en az 1):**

Her satırda: tank seçilir, miktar girilir. Biyokütle (kg) otomatik hesaplanır: `quantity × avgWeightG / 1000`. Form kuralı: tüm atama miktarlarının toplamı `initialQuantity`'ye eşit olmak zorundadır.

**Sekme 4 — Notlar:**

Serbest metin, maksimum 5000 karakter.

### 5.3 "Kaydet" Basıldığında Ne Olur

Frontend bir tek mutation çağrısı gönderir. Backend bu mutation'ı alır ve **tek bir transaction içinde 8 tabloya kadar yazım** yapar:

1. `farm.batches_v2` — ana parti kaydı (1 INSERT)
2. `farm.batch_documents` × N — her health certificate için 1 INSERT
3. `farm.batch_documents` × M — her import document için 1 INSERT
4. `farm.tank_batches` × K — her tank ataması için 1 INSERT/UPDATE (denormalize tank durumu)
5. `farm.tank_allocations` × K — her tank ataması için 1 INSERT (atama tarihçesi)
6. `farm.tanks` × K — her tankın `current_biomass_kg` sütunu UPDATE
7. `farm.feeder_calibrations` — tank yeni bir yemleyici ile geldiyse opsiyonel
8. `farm.farm_outbox` — `BatchCreatedEvent` satırı (asenkron işleme için)

Bu işlemlerin hepsi aynı transaction içinde. Herhangi biri başarısız olursa hepsi geri alınır. Commit başarıyla tamamlanınca frontend'e yanıt döner ve kullanıcı başarı bildirimi görür.

**Asenkron yan etkiler:**

Transaction commit'ten birkaç saniye sonra `OutboxWorkerService` `BatchCreatedEvent`'i NATS'e publish eder. `BatchCreatedListener` bu event'i alır ve farm istatistiklerini hesaplar, gerekirse büyük batch (> 100.000 adet veya > 10.000 kg biyokütle) için özel event yayınlar.

### 5.4 Batch Operasyonları

Partinin yaşamı boyunca uygulanan işlemler. Her biri ayrı bir modal açar, ayrı bir mutation çalıştırır, ama hepsi aynı `farm.tank_operations` tablosuna bir satır yazar.

#### MortalityModal — Ölüm Kaydı

**Dosya:** `production/components/MortalityModal.tsx`. Kullanım: bir tankta ölü balık bulunduğunda açılır.

**Alanlar:**

- Miktar: kaç adet ölü balık bulundu
- Ortalama Ağırlık (g): display için (batch'in son bilinen ağırlığı önerilir, düzenlenebilir)
- Sebep: enum — DISEASE (hastalık), STARVATION (açlık), WATER_QUALITY (su kalitesi), PREDATION (yırtıcı saldırısı), UNKNOWN (bilinmiyor)
- Detay: serbest metin
- Gözlem Tarihi: gelecek tarih değil
- Notlar: zorunlu

**`recordMortality` mutation'ı çalıştığında:**

1. `farm.mortality_records` — yeni satır (detay kayıt)
2. `farm.tank_operations` — yeni satır (operation_type=MORTALITY)
3. `farm.batches_v2` — UPDATE: `current_quantity -= quantity`, `total_mortality += quantity`
4. `farm.tank_batches` — UPDATE: `current_quantity -= quantity`, `total_biomass_kg -= (quantity × avgWeightG / 1000)`
5. `farm.farm_outbox` — `MortalityRecordedEvent`

Yan etki: `MortalityRecordedListener` bu event'i dinler ve şiddet seviyesine göre sağlık uyarısı tetikleyebilir.

#### CullModal — Eleme

Mortality ile benzer ama "sebep" farklıdır. Cull, balıkların kasıtlı olarak elenmesidir (zayıf, hastalıklı, yasal olmayan boy). Sebep enum'u CullReason: SIZE / DISEASE / GENETIC / OTHER. `recordCull` mutation'ı, `farm.tank_operations` + `farm.batches_v2` tablolarına yazar.

#### TransferModal — Tanktan Tanka Transfer

Bir partinin belirli bir miktarı bir tanktan başka bir tanka taşındığında kullanılır. `transferBatch` mutation'ı:

1. `farm.tank_batches` (kaynak tank) — decrement
2. `farm.tank_batches` (hedef tank) — increment (veya yeni kayıt)
3. `farm.tank_operations` × 2 — TRANSFER_OUT + TRANSFER_IN (iki ayrı satır)
4. `farm.farm_outbox` — `BatchTransferredEvent`

Batch kaydının kendisi değişmez — sadece lokasyon tablolarında hareket olur.

#### Batch Kapama — Close

Parti hasat edilip satıldığında ve kapatıldığında kullanılır. `closeBatch` mutation'ı `farm.batches_v2.status = CLOSED` yapar ve kapatma sebebini `closure_reason` sütununa yazar. Yetki: TENANT_ADMIN, MODULE_MANAGER, MODULE_USER.

#### Feed Assignment — Yem Ataması

Batch detay sayfasındaki bir sekme. `assignFeedsToBatch` mutation'ı, bir parti için **ağırlık aralığı bazlı** yem tercihi tanımlar. Yani "balıklar 0–50 g iken FEED_A, 50–200 g iken FEED_B, 200 g+ iken FEED_C kullanılır" kuralı. Yazdığı tablo: `farm.batch_feed_assignments`. JSONB array'inde `[{feedId, feedCode, feedName, minWeightG, maxWeightG, priority}]` tutulur.

### 5.5 REST Üzerinden Batch Yönetimi

`BatchController` (`apps/farm-service/src/batch/controllers/batch.controller.ts:141`) batch CRUD işlemlerini REST üzerinden de expose eder. Harici entegrasyonlar (SCADA, üçüncü parti yazılımlar, toplu veri aktarımı) bu kanalı kullanabilir.

Endpoint'ler:

- `POST /api/batches` — batch oluştur
- `GET/PUT/DELETE /api/batches/:id` — CRUD
- `POST /api/batches/:id/allocate` — tanka tahsis
- `GET /api/batches/:id/metrics` — hesaplanan metrikler (FCR, SGR, survival rate, cost/kg)
- `POST /api/tank-operations/mortality` — ölüm
- `POST /api/tank-operations/cull` — eleme
- `POST /api/tank-operations/transfer` — transfer
- `POST /api/tank-operations/harvest` — hasat

Header: `x-tenant-id` (zorunlu), `x-user-id` (opsiyonel). Guard: `JwtAuthGuard`.

Her iki kanal (GraphQL + REST) aynı command handler'ları çağırır. Aynı iş kuralları ve aynı outbox event'leri.

---

## 6. Feeding — Yemleme Süreçleri

### 6.1 Ne İşe Yarar

Su ürünlerinde en kritik operasyon yemlemedir. Yemleme miktarı, zamanlaması ve kalitesi balıkların büyüme hızını, FCR'ını (Feed Conversion Ratio) ve dolayısıyla üretim maliyetini doğrudan etkiler. Bu modül dört ana akışı kapsar:

1. **Günlük yemleme kaydı** — tankta kaç kg yem verildi, balıklar nasıl tepki verdi
2. **Yemleme programı** — bir tesiste hangi tanklara hangi yemlerle, hangi sıklıkla yemleme yapılacak plan
3. **Yemleme protokolü** — tür/aşama bazlı genel kural (sıcaklığa göre rasyon vb.)
4. **Yemleyici kalibrasyonu** — otomatik yemleyicinin her pellet boyutu için kaç g dağıttığı

### 6.2 Günlük Yemleme Kaydı

**Ekran:** `feeding/components/RecordFeedingModal.tsx`

Operasyon personeli her yemleme sonrası bu modalı açar. `createFeedingRecord` mutation'ı yazar. 27 civarı form alanı içerir; en önemlileri:

- Parti, tank, yem seçimi
- Yemleme tarihi, saati (HH:MM), günün kaçıncı öğünü
- Planlanan miktar (kg) vs fiili miktar (kg) — varyans hesaplanır
- Fire miktarı (kg)
- Ortam koşulları: su sıcaklığı, DO, hava durumu, rüzgar, görüş (hepsi `environment` JSONB içinde)
- Balık davranışı: iştah (POOR/NORMAL/GOOD/EXCELLENT), yemleme şiddeti (1–5), yüzey hareketi, sürü davranışı, anormal davranış (hepsi `fish_behavior` JSONB içinde)
- Yemleme yöntemi (MANUAL/AUTOMATIC), kullanılan ekipman (yemleyici seçimi)
- Süre (dk), yem maliyeti, para birimi
- Yemleyen kişi, doğrulayan kişi (iki katmanlı onay)
- Notlar, atlandıysa sebep

"Kaydet" basıldığında:

1. `farm.feeding_records` — yeni satır (1 INSERT)
2. `farm.farm_outbox` — `FeedingRecordedEvent` yazılır

Transaction commit edilir, response döner.

**Asenkron yan etki:**

Saniyeler sonra `OutboxWorkerService` event'i NATS'e basar. `FeedingStorageEventHandler` event'i dinler ve:

1. FEFO kuralı ile uygun `farm.feed_inventory` satırını bulur (en erken tarihli)
2. `RecordStockMovementCommand` dispatch eder
3. Komut handler:
   - `farm.stock_movements` — yeni OUT hareketi
   - `farm.storage_inventory` / `farm.feed_inventory` — miktar düşümü
   - `idempotencyKey = "feeding-deduct-{eventId}"` ile tekrarları engeller

Bu otomatik düşüm **başarısız olursa feeding record kaydı bozulmaz**. Handler WARN log atar ve devam eder. Sebep: yem verme operasyonel açıdan kritiktir, stok senkronu asenkron düzeltilir. Tutarsızlıklar periyodik stok sayımı (`approveInventoryCount`) ile telafi edilir.

### 6.3 Yemleme Programı

**Ekran:** `feeding/FeedingProgramForm.tsx`

Bir program, belirli bir tesisteki tanklar için uzun vadeli yemleme planıdır. `createFeedingProgram` mutation'ı yazar.

Alanlar:

- `siteId` — hangi tesis
- `code` — program kodu (UNIQUE per tenant)
- `feedAssignments` — JSONB array, ağırlık aralığı bazlı yem zinciri
- `fcrTable` — JSONB, ağırlık/zaman bazlı FCR hedefleri
- `startDate`, `endDate` — program süresi
- `settings` — default parametreler (öğün sayısı, rasyon hesaplama yöntemi vb.)

**Tablolar:**

- `farm.feeding_programs` — ana kayıt
- `farm.feeding_program_tanks` — programa dahil tanklar (junction)
- `farm.daily_feeding_executions` — programın günlük planlanan/gerçekleşen değerleri

Program aktive edildiğinde scheduled job her gün `daily_feeding_executions`'a `PLANNED` durumunda yeni satırlar ekler. Gerçek yemleme yapıldığında status `COMPLETED`, `IN_PROGRESS`, `SKIPPED`, `PARTIAL` olarak güncellenir ve `actual_results` JSONB'si doldurulur.

### 6.4 Yemleme Protokolü

Tür ve aşamaya göre genel kurallardır. `farm.feeding_protocols` tablosunda:

- Tür ve aşama (EGG/LARVAE/FRY/JUVENILE/ADULT)
- Sıcaklık aralıkları (JSONB)
- Büyüme aşaması protokolleri (JSONB)
- Varsayılan program (JSONB)
- Hedef FCR, minimum DO, optimum sıcaklık

`createFeedingProtocol` mutation'ı SetupPage > FeedsTab içinden çalışır.

### 6.5 Yemleyici Kalibrasyonu

Her otomatik yemleyici her pellet boyutu için farklı miktarda yem dağıtır. Örneğin 3 mm pellet için dönüş başına 12.5 g, 6 mm pellet için 28 g.

**Ekran:** EquipmentTab içindeki `FeederCalibrationSection`. `saveFeederCalibrations` mutation'ı her pellet boyutu için bir satır yazar.

**Tablo:** `public.feeder_calibrations` (farm şemasında değil, dikkat).

Alanlar: `equipment_id`, `feed_size_mm`, `feed_size_label`, `grams_per_dispensing`, `silo_capacity_kg`. UNIQUE `(tenant_id, equipment_id, feed_size_mm)`.

---

## 7. Growth — Büyüme Ölçümleri

### 7.1 Ne İşe Yarar

Balıkların büyüme hızını izlemek kritiktir. Beklenenden yavaş büyüme bir probleme işaret eder (yem kalitesi, hastalık, su kalitesi vb.). Operasyon personeli periyodik olarak tanktan örneklem alır, tartar ve sisteme girer. Sistem bu ölçümleri önceki ölçümlerle karşılaştırarak SGR (Specific Growth Rate) ve FCR analizini hesaplar.

### 7.2 Ölçüm Kaydı

**Ekran:** Batch detay sayfasında Growth sekmesi, veya dedicated form. GraphQL operasyonları: `web/modules/farm-module/src/graphql/growth.operations.ts`

`recordGrowthSample` mutation'ı yazar. Hedef tablo: `farm.growth_measurements`.

Alanlar:

- Ölçüm tarihi, tipi (SAMPLE / FULL_COUNT / ESTIMATION), yöntemi (INDIVIDUAL_WEIGHING / GROUP_WEIGHING / LENGTH_MEASUREMENT)
- Örneklem büyüklüğü (kaç balık tartıldı), populasyon büyüklüğü, örneklem yüzdesi
- Bireysel ölçümler — her balığın ağırlığı (JSONB array)
- İstatistikler — min, max, median, std dev (JSONB)
- Ortalama ağırlık, ortalama boy, ağırlık varyasyon katsayısı, koşul faktörü (hesaplanan)
- Önceki biyokütle, biyokütle artışı, tahmini biyokütle
- Büyüme karşılaştırması (beklenen vs gerçek), performans değerlendirmesi
- FCR analizi (JSONB)
- Koşullar snapshot (su sıcaklığı, DO — ölçüm anında)
- Öneriler (JSONB array — sistem tarafından üretilebilir)
- Notlar, ekler
- `update_batch_weight` bayrağı — true ise `batches_v2.weight_actual_*` de güncellenir

**Mutation adımları:**

1. `farm.growth_measurements` — yeni satır
2. Opsiyonel: `farm.batches_v2` — UPDATE `weight_actual_avg_g`, `weight_actual_total_kg`, `sgr`
3. `farm.farm_outbox` — `GrowthSampleRecordedEvent`

### 7.3 Doğrulama

`verifyMeasurement` mutation'ı ölçümü doğrular — sadece yetkili bir kullanıcı (supervisor) ölçümü onaylayabilir. `farm.growth_measurements.is_verified = true`, `verified_by`, `verified_at` yazılır.

---

## 8. Water Chemistry — Su Kimyası

### 8.1 Ne İşe Yarar

Balıkların yaşayacağı su parametreleri (sıcaklık, pH, çözünmüş oksijen, amonyak, nitrit, nitrat, tuzluluk, bulanıklık ve 25+ diğer parametre) belirli aralıklarda tutulmalıdır. Bu parametreler düzenli ölçülür, sınır değer aşıldığında alarm üretilir.

### 8.2 Parametre Yapılandırması

**Ekran:** `water-chemistry/components/ConfigFormModal.tsx`

Kullanıcı hangi parametreleri izleyeceğini, her birinin birimini, optimum / uyarı / kritik aralıklarını tanımlar.

Tablo: `farm.water_quality_parameter_configs`.

Alanlar:

- Kod, ad, birim, veri tipi (NUMBER/TEXT/BOOLEAN)
- Grup (BASIC/ADVANCED/CUSTOM)
- Hassasiyet (ondalık basamak)
- Optimum / Uyarı / Kritik min-max değerler
- Grafik rengi, eksen grubu (dual-axis için LEFT/RIGHT)
- Görünürlük, zorunluluk bayrakları

`createParameterConfig`, `updateParameterConfig`, `deleteParameterConfig`, `bulkCreateFromTemplate`, `reorderParameterConfigs` mutation'ları.

**Ekipman eşleme:** `bulkMapParamsEquipment` mutation'ı her parametrenin hangi ekipman tarafından ölçüldüğünü `farm.water_quality_param_equipment` junction'ına yazar. Ekipman kalibrasyon tarihleri burada tutulur.

### 8.3 Ölçüm Kaydı

**Ekran:** `water-chemistry/components/RecordTab.tsx`

Form dinamiktir — sistemde tanımlı her parametre için bir input gelir. `recordReading` / `createWaterQualityMeasurement` mutation'ı yazar.

Tablo: `farm.water_quality_measurements`.

Alanlar:

- Tank, sistem, batch referansları (opsiyonel)
- Ölçüm tarihi, ölçen kişi, kullanılan ekipman
- **Tüm parametre değerleri** → `parameter_values` JSONB sütunu

**Kritik tasarım kararı:** 25+ parametre ayrı sütun değil, tek JSONB içinde. Yapı: `{"pH": 7.2, "DO_mg_L": 6.8, "NH3_mg_L": 0.05, "temp_C": 22.5, ...}`.

Avantaj: Yeni parametre eklemek migration gerektirmez.

Dezavantaj: Filtreleme ve indexleme zor. "pH > 8.0 olan ölçümleri göster" sorgusu için:

```sql
WHERE (parameter_values->>'pH')::numeric > 8.0
```

Normal sütun indexine göre daha yavaştır.

---

## 9. Storage & Inventory — Depo ve Stok

### 9.1 Ne İşe Yarar

Yem, kimyasal, sarf malzeme ve yedek parça stoklarının yönetimi. Satın alma siparişi oluşturmak, teslim almak, hareketleri (giriş, çıkış, transfer, düzeltme) kayıt etmek, periyodik sayım yapmak ve varyansları yönetmek.

### 9.2 Satın Alma Siparişi

**Ekran:** `storage/components/CreatePurchaseOrderModal.tsx`

`createPurchaseOrder` mutation'ı. İki tabloya yazar: `farm.purchase_orders` (ana sipariş) ve `farm.purchase_order_items` (sipariş kalemleri).

Kalemler için her satırda: kategoriye uygun ürün (feed/chemical/consumable), miktar, birim, birim fiyatı. Toplam tutar hesaplanır.

Sipariş durumları: DRAFT → PENDING → RECEIVED → (veya CANCELLED). Durum değişimleri `updatePurchaseOrderStatus` ile yapılır.

### 9.3 Teslim Alma

**Ekran:** `storage/components/ReceiveDeliveryModal.tsx`

`receiveDelivery` mutation'ı. Bir PO teslim alındığında dört tabloya birden yazar:

1. `farm.purchase_orders` — status = DELIVERED, delivery_date dolar
2. `farm.storage_inventory` — yeni lot ise INSERT, mevcut lot ise quantity UPDATE
3. `farm.stock_movements` — IN hareketi (lot tracking ile: lot_number, manufacturing_date, expiry_date, reference="PO: {purchaseOrderId}")
4. `farm.farm_outbox` — `DeliveryReceivedEvent`

### 9.4 Stok Hareketleri

**Ekran:** `storage/components/RecordStockMovementModal.tsx`

`recordStockMovement` mutation'ı. Dört hareket tipi:

- INBOUND — manuel giriş (PO dışı teslim vb.)
- OUTBOUND — manuel çıkış
- TRANSFER — iki depo arası transfer (iki `stock_movements` satırı: OUT + IN)
- ADJUSTMENT — sayım sonrası düzeltme (zorunlu `reason`)

Yazdığı tablolar: `farm.stock_movements`, `farm.storage_inventory` (miktar güncellemesi).

Transfer için özel mutation: `transferStock` — iki hareket satırı atomik yazar.

### 9.5 Sayım ve Onay

**Ekranlar:** `storage/components/StartInventoryCountModal.tsx`, `InventoryCountDetailModal.tsx`

Sayım süreci:

1. `createInventoryCount` → `farm.inventory_counts` (status=DRAFT), `farm.inventory_count_items` (her kalem için bir satır, beklenen miktar doldurulur)
2. Kullanıcı fiziksel sayım yapar, her kalem için gerçek miktarı girer. `updateInventoryCountItems` → `farm.inventory_count_items` UPDATE (recorded_quantity, variance).
3. `submitInventoryCount` → status=SUBMITTED, onay bekler
4. `approveInventoryCount` (TENANT_ADMIN) → status=APPROVED + kritik yan etki:
   - Her varyans (eşiğin üzerinde) için `farm.stock_movements`'a VARIANCE hareket satırı
   - `farm.storage_inventory`'de miktarlar gerçek sayıma göre UPDATE edilir

Bu mekanizma `FeedingStorageEventHandler`'ın otomatik düşümlerindeki küçük hataları periyodik olarak düzeltir.

### 9.6 Traceability

`traceLot(lotNumber)` query — bir lot numarasının tüm hareketlerini getirir. Gıda güvenliği takibi için kritik.

---

## 10. Maintenance — Bakım Yönetimi

### 10.1 Ne İşe Yarar

Tesisteki ekipmanlar düzenli bakım gerektirir. Pompaların yağ değişimi, sensörlerin kalibrasyonu, filtrelerin temizliği vb. Modül üç ana öge içerir:

1. **Maintenance Schedule** — tekrarlayan bakım planı (ayda bir, 6 ayda bir vb.)
2. **Work Order** — spesifik bakım iş emri (hem plandan hem de spontan)
3. **Spare Part** — yedek parça envanteri

### 10.2 Bakım Programı

**Ekran:** `maintenance/MaintenanceSchedulesPage.tsx`

`createSchedule` mutation'ı. Tablo: `farm.maintenance_schedules`.

Alanlar: kod, ad, kategori (PREVENTIVE/CORRECTIVE/PREDICTIVE/INSPECTION), hedef varlık (tank, pompa vb.), tekrar kuralı (JSONB — RFC 5545 RRULE benzeri), süre, maliyet tahmini, kontrol listesi şablonu (JSONB), gerekli malzemeler listesi (JSONB), varsayılan sorumlu, uyarı ayarları.

Özel bayrak: `auto_generate_work_order` — program tarihinde otomatik iş emri üretir mi. `generate_days_before` — kaç gün öncesinden.

### 10.3 İş Emri

**Ekran:** `maintenance/WorkOrdersPage.tsx`

`createWorkOrder`, `updateWorkOrder`, `completeWorkOrder`, `cancelWorkOrder` mutation'ları. Tablo: `farm.work_orders`.

Alanlar: kod, başlık, açıklama, tip, durum (OPEN/IN_PROGRESS/COMPLETED/CANCELLED), öncelik (LOW/MEDIUM/HIGH/URGENT), hedef varlık, planlanan başlangıç, bitiş tarihi, süre, maliyet, atanan kişi/takım, kontrol listesi (JSONB, tamamlanma yüzdesiyle), kullanılan malzemeler (JSONB, yedek parça tüketimi), iş gücü kayıtları (JSONB).

İlgili sağlık olayı veya alarm olayıyla bağlantı kurulabilir (`related_health_event_id`, `related_alert_incident_id`).

### 10.4 Yedek Parça

**Ekran:** `maintenance/SparePartsPage.tsx`

`createSparepart`, `updateSparepart`, `deleteSparepart` mutation'ları. Tablo: `farm.spare_parts`. Basit envanter: kod, ad, tedarikçi, miktar, min stok, birim fiyatı.

Work order'lar yedek parça tüketimini bu tablo üzerinden izler.

---

## 11. Health — Sağlık Olayları

### 11.1 Ne İşe Yarar

Balık sağlığıyla ilgili her tür olayın kaydı: hastalık, yaralanma, parazit, çevresel anormallik. Olay kaydedildikten sonra tedavi uygulanır, gerekiyorsa karantina başlar, veteriner bilgilendirilir, lab örneği alınır.

### 11.2 Olay Kaydı

**Ekran:** `health/HealthEventsPage.tsx`

36 form alanı içerir. `createHealthEvent` mutation'ı. Tablo: `farm.health_events`.

Alanlar temel kategorilere ayrılır:

**Tanımlayıcı bilgiler:**

- Başlık, açıklama, olay tipi (DISEASE/INJURY/PARASITE/ENVIRONMENTAL/OTHER), tarih, saat
- İlişkili parti, tank (opsiyonel)

**Hastalık spesifik:**

- Hastalık kategorisi, hastalık adı, şiddet (MINOR/MODERATE/SEVERE/CRITICAL)
- Semptomlar (JSONB array)
- Etkilenen populasyon (JSONB — sayı, yüzde, ağırlık tahmini)

**Tedavi:**

- Tedavi bilgisi (JSONB — ilaç, dozaj, uygulama yöntemi)
- Tedavi altında mı, tedavi bitiş tarihi
- İlaç arınma süresi (gün), bu süre geçmeden hasat yapılamaz (`earliest_harvest_date` hesaplanır)

**Karantina:**

- Karantina altında mı, başlangıç, bitiş, karantina tankı

**Lab ve Veteriner:**

- Lab sonuçları (JSONB), lab_confirmed bayrağı
- Veteriner danışma bilgisi (JSONB), vet_notified bayrağı

**Bağlantılar:**

- Su kalitesi snapshot (JSONB — olay anındaki değerler)
- İlişkili `water_quality_measurement_id`
- Parent olay (follow-up olaylar için)
- Alarm olayı referansı (SCADA entegrasyonundan)

**Durum ve takip:**

- Durum (ACTIVE/RESOLVED/MONITORING), çözülme tarihi, çözüm notu
- Takip gerekli mi, sonraki takip tarihi
- Tahmini maliyet, para birimi
- Raporlayan kişi, notlar, ekler

### 11.3 Tedavi ve Karantina Başlatma / Bitirme

Olay içindeki alanları güncellemek için özel mutation'lar:

- `recordTreatment` — tedavi bilgisini günceller
- `startQuarantine` / `endQuarantine` — karantina bayraklarını ve tarihlerini günceller

Tüm yazımlar aynı `farm.health_events` satırını günceller.

---

## 12. Tasks — Görevler ve Otomasyon

### 12.1 Ne İşe Yarar

Operasyonel görevlerin yönetimi. Üç ana konsept:

1. **Task** — tek seferlik görev (örn "Tank 5'i temizle")
2. **Auto Rule** — otomatik kural (örn "pH < 6.5 olursa su kalitesi kontrolü görevi oluştur")
3. **Recurring Template** — tekrarlayan görev şablonu (örn "her Pazartesi filtre kontrolü")

### 12.2 Task

**Ekran:** `tasks/components/TaskFormModal.tsx`

`createTask` mutation'ı. Yazdığı tablolar: `farm.tasks`, `farm.task_assignments` (junction).

Alanlar:

- Başlık (zorunlu), açıklama
- Kategori (GENERAL/CLEANING/FEEDING/HEALTH/MAINTENANCE)
- Öncelik (LOW/MEDIUM/HIGH/URGENT)
- Atanan kişi (zorunlu)
- Son tarih, son saat
- Lokasyon, tahmini süre (dk)
- Kontrol listesi öğeleri (dinamik add/remove, JSONB array)
- Etiketler (dinamik add/remove, simple-array)

### 12.3 Auto Rule

**Ekran:** `tasks/components/AutoRuleFormModal.tsx`

`createAutoRule` mutation'ı. Tablo: `farm.auto_task_rules`.

Alanlar:

- Ad, koşul (örn `"water.ph < 6.5"` — text veya JSONB)
- Aksiyon (CREATE_TASK / SEND_ALERT / LOG_EVENT)
- Görev kategorisi, öncelik, atama (aksiyon CREATE_TASK ise)
- Etkin mi bayrağı
- Test koşulu butonu — mevcut veriye karşı koşulu değerlendirir

Kural etkinken sistem koşulu sürekli değerlendirir (sensor readings, batch metrics vb.) ve tetiklendiğinde belirtilen aksiyonu alır.

### 12.4 Recurring Template

**Ekran:** `tasks/components/RecurringTemplateFormModal.tsx`

`createTemplate` mutation'ı. Tablo: `farm.recurring_task_templates`.

Alanlar:

- Şablon adı, görev başlığı, görev açıklaması
- Kategori, öncelik, atama
- Sıklık (DAILY/WEEKLY/MONTHLY/CUSTOM)
- Haftanın günleri (haftalık ise), ayın günü (aylık ise)
- Başlangıç, bitiş tarihi

Scheduled job bu şablonlara göre günlük task üretir.

---

## 13. Harvest — Hasat

### 13.1 Ne İşe Yarar

Hasat iki aşamadır: önce **plan** yapılır (tahmini miktar, biyokütle, tarih, alıcı), sonra **kayıt** atılır (gerçek hasat verisi, kalite kontrolü, sevkiyat).

### 13.2 Hasat Planı

**Ekran:** `harvest/HarvestPlansPage.tsx`

`createHarvestPlan` mutation'ı. Tablo: `farm.harvest_plans`.

Alanlar (48 civarı — yoğun bir form):

- Plan kodu (UNIQUE), ad, açıklama
- İlişkili parti
- Durum (DRAFT/PLANNED/APPROVED/SCHEDULED/IN_PROGRESS/COMPLETED/CANCELLED/POSTPONED)
- Hasat tipi, yöntemi (NET/PUMP/SEINE)
- Planlanan tarih, onaylanan tarih, pencere başlangıç-bitiş
- Kriterler (JSONB — minimum ağırlık, maksimum yaş, kalite standardı)
- Tahminler (JSONB — miktar, biyokütle, kalite dağılımı)
- Finansal projeksiyon (JSONB — gelir, maliyet, marj)
- Lojistik (JSONB — araç, depolama, sevkiyat)
- Müşteri siparişi (JSONB)
- Kalite gereksinimleri (JSONB — grade A/B/C yüzde hedefleri)
- Gerçek değerler (plan tamamlandıkça doldurulur): hasat edilen miktar, biyokütle, ortalama ağırlık
- Onaylayan, onay tarihi, oluşturan kullanıcı

### 13.3 Hasat Kaydı

**Ekran:** Plan detay sayfasından veya doğrudan batch'ten `createHarvestRecord` çağrılır. Ayrıca REST endpoint'i `POST /api/tank-operations/harvest` da aynı mutation'ı tetikler.

Tablo: `farm.harvest_records`. Bağlantılı: `farm.batches_v2` (harvest_date ve harvested_quantity güncellemesi), `farm.tank_batches` (currentQuantity azaltımı), `farm.tank_operations` (HARVEST operation satırı).

Alanlar:

- Kayıt kodu (UNIQUE), lot numarası (UNIQUE — izlenebilirlik için)
- Parti, plan, tank referansları
- Hasat tarihi, yöntemi
- Operasyon detayı (JSONB)
- Hasat edilen miktar, toplam biyokütle, ortalama/min/max ağırlık
- Boy dağılımı (JSONB)
- Ürün formu (WHOLE/GUTTED/FILLETED/SMOKED)
- Kalite notu, kalite kontrol detayı (JSONB), kalite onaylı mı
- Lot bilgisi (JSONB)
- Verim hesaplaması (JSONB)
- Sevkiyat bilgisi (JSONB), müşteri teslimatları (JSONB array)
- Toplam gelir, hasat maliyeti, para birimi
- Hasat esnasında ölüm, reddedilen miktar, ret sebebi
- Sorumlu, onaylayan, notlar, ekler

---

## 14. Reports / Regulatory — Resmi Raporlar

### 14.1 Ne İşe Yarar

Aquaculture endüstrisi sıkı regüle edilir. Norveç örneğinde **FDIR** (Fiskeridirektoratet — Balıkçılık Dairesi) belirli olayların 24 saat içinde raporlanmasını zorunlu kılar. Bu modül bu raporların form yönetimini yapar.

### 14.2 Rapor Tipleri

**Ekran:** `reports/ReportsPage.tsx` (sekmeli)

| Rapor                               | Modal/Tab                  | Zorunluluk                       |
| ----------------------------------- | -------------------------- | -------------------------------- |
| Disease Outbreak (Hastalık Salgını) | `DiseaseOutbreakModal.tsx` | Kategori A/C: anında, F: 24 saat |
| Escape Report (Kaçış)               | `EscapeReportModal.tsx`    | 24 saat                          |
| Welfare Event (Refah İhlali)        | `WelfareEventModal.tsx`    | FDIR                             |
| Biomass Report                      | `BiomassReportTab.tsx`     | ⚠ şu an stub                    |
| Slaughter Report                    | `SlaughterReportTab.tsx`   | Gıda güvenliği                   |
| Sea Lice Report                     | `SeaLiceReportTab.tsx`     | FDIR                             |
| Smolt Report                        | `SmoltReportTab.tsx`       | Migration tracking               |
| Cleaner Fish Report                 | `CleanerFishReportTab.tsx` | Sağlık takibi                    |

### 14.3 Disease Outbreak — Detaylı Örnek

`createDiseaseOutbreak` mutation'ı. İki tabloya yazar: `farm.health_events` (detay kayıt) ve ~~`farm.regulatory_events`~~ _(⚠ 2026-04-22 düzeltmesi: bu tablo yok. Regulatory rapor modal'ları aslında `health_events`'e yazar ve — Mattilsynet API entegrasyonu olan 5 rapor tipi için — otomatik olarak Mattilsynet'e submit eder)_ (yasal bildirim).

Alanlar:

- Hastalık kategorisi: A (egzotik), C (yerli), F (diğer)
- Hastalık kodu — kategoriye göre filtrelenmiş enum
- Şüpheli mi, laboratuvar doğrulamalı mı
- Şiddet (minor/moderate/severe/critical)
- Etkilenen tahmini balık sayısı, etkilenen yüzde
- Etkilenen tanklar (çoklu seçim)
- Klinik belirtiler listesi (dinamik add/remove)
- Acil aksiyonlar listesi (dinamik)
- Karantina önlemleri listesi (dinamik)
- Veteriner bilgilendirildi mi, veteriner adı ve iletişimi
- Lab sonuçları listesi — her biri: numune tipi, numune tarihi, lab adı, test tipi, sonuç, sonuç yorumu

Regülatör iletişim: `varsling.akva@mattilsynet.no`. Sistem otomatik e-posta göndermez; form sadece kayıt tutar, raporlamayı kullanıcı yapar.

### 14.4 Regulatory Events

~~`farm.regulatory_events`~~ _(⚠ 2026-04-22 düzeltmesi: bu tablo yok. Regulatory rapor modal'ları aslında `health_events`'e yazar ve — Mattilsynet API entegrasyonu olan 5 rapor tipi için — otomatik olarak Mattilsynet'e submit eder)_ — genel yasal bildirim kayıtları (`recordComplianceEvent` mutation). Alanlar: tip, otorite, bildirilen tarih, durum, doküman referansı.

`farm.inspections` — otorite denetim kayıtları (`recordInspection`).

---

## 15. Weather, Marine, Sentinel Hub — Çevresel Veriler

### 15.1 Otomatik Besleme

Bu üç veri kaynağı **frontend tarafından doğrudan yazılmaz**. Scheduled worker'lar ve dış API entegrasyonları tablolara düzenli aralıklarla veri basar:

- `farm.weather_observations` — hava istasyonu API'sinden
- `farm.marine_observations` — deniz koşulları API'sinden
- `farm.sentinel_hub_settings` — Copernicus Sentinel-2 uydu görüntüleri için yapılandırma

### 15.2 Ayar Formları

Kullanıcı yalnızca entegrasyon ayarlarını yönetir:

**WeatherSettingsPage** — hava API kaynağı, API anahtarı, alarm eşikleri (JSONB). Yazdığı tablo: `farm.weather_settings`.

**SentinelHubSettingsPage** (`settings/SentinelHubSettingsPage.tsx`) — uydu görüntüleri için:

- API anahtarı (masked input, şifrelenmiş saklanır)
- İlgi alanı geometrisi (GeoJSON polygon, harita widget'ı ile çizilir)
- Bulut örtüsü maksimum eşiği (%)
- Tarih aralığı
- OAuth yapılandırma

**RegulatorySettings** — compliance framework, sertifikalar listesi, otorite iletişim bilgileri, raporlama programı.

---

## 16. Cleaner Fish — Temizleyici Balık İşlemleri

### 16.1 Ne İşe Yarar

Somon yetiştiriciliğinde **sea lice** (deniz biti) parazitiyle mücadele için temizleyici balıklar (lumpfish, wrasse) kafeslere yerleştirilir. Bu balıklar somonun üzerindeki parazitleri yer. Sistemdeki batch'lerden ayrı yönetilirler çünkü farklı tür, farklı yaşam döngüsü, farklı maliyet yapısı.

### 16.2 Özel Resolver

`CleanerFishResolver` (`batch/resolvers/cleaner-fish.resolver.ts`) — ayrı mutation seti ama aynı tabloları kullanır. Cleaner fish batch'leri `farm.batches_v2.batch_type = CLEANER_FISH` ile etiketlenir.

### 16.3 Operasyonlar

| Mutation                 | Ekran                              | Yazdığı Tablolar                                                            |
| ------------------------ | ---------------------------------- | --------------------------------------------------------------------------- |
| `createCleanerFishBatch` | CleanerFishPage > CreateBatchModal | `batches_v2` (cleaner), `tank_batches`                                      |
| `deployCleanerFish`      | DeployModal                        | `tank_batches` (cleanerFishQuantity ++), `tank_operations` (CLEANER_DEPLOY) |
| `recordCleanerMortality` | MortalityModal                     | `batches_v2`, `tank_operations` (CLEANER_MORTALITY)                         |
| `transferCleanerFish`    | TransferModal                      | `tank_batches` × 2, `tank_operations` × 2                                   |
| `removeCleanerFish`      | RemoveModal                        | `tank_batches` (cleanerFishQuantity --)                                     |

`tank_batches` tablosunda `cleaner_fish_quantity`, `cleaner_fish_biomass_kg`, `cleaner_fish_details` (JSONB) ayrı sütunlar tutulur — böylece bir tankta hem somon batch'i hem cleaner fish aynı anda var olabilir.

---

## 17. Worker, Company, Site Contacts

### 17.1 Worker

`WorkerResolver` — çalışan yönetimi. Tablo: `farm.workers`. Alanlar: kullanıcı ID (dış ref), ad, rol, departman, e-posta, telefon.

Task atamaları, feeding kayıtları vb. burada tutulan çalışan ID'sini referanslar.

### 17.2 CompanyPage

Şirket profili — çoğunlukla company / tenant modülünde tutulur, farm modülüyle hafif entegrasyon var. 6 alan: şirket adı, vergi / tescil numarası, adres, telefon, e-posta, web sitesi.

### 17.3 Site Contacts

`farm.site_contacts` — bir tesiste birden fazla iletişim kişisi tutabilmek için. Site detayından yönetilir.

---

## 18. AI Insights

`AIInsightsResolver` — sadece **query**. Mutation yok. MCP (Model Context Protocol) entegrasyonu ile sensor dataset özeti, büyüme anomalileri, FCR optimizasyon önerileri dönderir. Veritabanına yazmaz.

---

## 19. Sensör Paneli, Analitik, Harita

### 19.1 SensorDashboardPage

Real-time izleme. Sensör okumalarını (iot modülünden) gösterir. Farm modülüne yazmaz, sadece okur. Recharts ile grafik çizer.

Parametreler: sıcaklık, pH, oksijen, tuzluluk, bulanıklık, amonyak. Zaman aralıkları: canlı, 24 saat, 7 gün, 30 gün.

### 19.2 AnalyticsPage

Agregat raporlar. Batch performansı, tank doluluk oranı, yem tüketim grafiği vb. Yazmaz.

### 19.3 TanksPage

Tankların filtrelenmiş listesi. Filtre alanları: sistem, tür, durum, arama, zaman aralığı. Okuma-ağırlıklı ekran.

### 19.4 MapViewPage

Tesis haritası. Gerçek implementasyon: **Leaflet tabanı + Sentinel Hub uydu tile'ları + CMEMS deniz tile'ları + AOI (Area of Interest) çizim desteği + hava durumu paneli + point-data popup'ları**. `pages/MapViewPage.tsx`.

> **Not (doküman düzeltmesi):** Önceki revizyon bu sayfayı "stub" olarak işaretliyordu — bu yanlıştı. Kod incelendiğinde hook'lar (`useSentinelTiles`, `useMapPointQuery`, `useAOIDrawing`) ve component'ler (`SentinelTileLayer`, `CMEMSTileLayer`, `SatelliteLayerControl`, `PointDataPopup`) gerçek entegrasyonu gösterdi. Düzeltme `kor-noktalar-dogrulama.md` implementasyon log'una kaydedildi.

---

## 20. Audit Log ve Outbox — Görünmez Yan Etkiler

### 20.1 farm_audit_logs

Her kritik yazma işlemi `farm.farm_audit_logs` tablosuna bir satır düşürür. Alanlar:

- `entity_type` (Batch, Tank, Site vb.)
- `entity_id`
- `action` (CREATE/UPDATE/DELETE/SOFT_DELETE/RESTORE)
- `user_id`, `user_name`
- `changes` (JSONB — önceki ve yeni değerler)
- `metadata` (JSONB — IP, user agent vb.)
- `entity_version`
- `summary` (okunabilir özet)

90 gün retention. Düzenleyici denetimler için gerekli.

### 20.2 farm_outbox

Her command handler transaction'ında ana yazımın yanı sıra `farm.farm_outbox`'a bir event satırı ekler. Alanlar:

- `event_type` (FarmCreated, BatchCreated, FeedingRecorded vb.)
- `aggregate_id`, `aggregate_type`
- `payload` (JSONB — event detayı)
- `published` (boolean), `published_at`

`OutboxWorkerService` `published = false` olanları düzenli aralıkta okuyup NATS'e basar, sonra `published = true, published_at = NOW()` işaretler.

INDEX: `idx_farm_outbox_poll_entity (created_at) WHERE published_at IS NULL` — worker'ın yayınlanmamışları hızlı bulması için partial index.

### 20.3 code_sequences

Otomatik kod üretimi (`B-2024-00001` gibi batch number'lar). `farm.code_sequences` tablosu her (tenant, entity_type, year) kombinasyonu için son sequence numarasını tutar. Mutation içinde advisory lock alınır, increment edilir.

---

## 21. Stub ve Ölü Ekranlar — Veri Kaybı Noktaları

### 21.0 Bu Bölümün Güncel Durumu

> **Düzeltme (2026-04-22):** Aşağıdaki 21.1, 21.2 ve 21.4 girdileri `docs/farm-illustrator` branch'indeki commit'ler ile **kod düzeyinde düzeltildi**. `FarmFormPage`, `FarmListPage` ve `FarmDetailPage` silindi; kırık rotalar redirect'e çevrildi. Metin tarihsel değer için bırakıldı. 21.3 (MapViewPage) **hatalı bir iddiaydı** — MapViewPage gerçek bir implementasyon (bkz §19.4).

### 21.1 FarmFormPage — Kayıt Yapmıyor (düzeltildi)

**Dosya:** `web/modules/farm-module/src/pages/FarmFormPage.tsx:100-110`

Form 8 alan içerir (isim, tip, lokasyon, enlem, boylam, kapasite, tür, açıklama). "Kaydet" butonuna basıldığında:

```typescript
const handleSubmit = async (e: React.FormEvent) => {
  e.preventDefault();
  if (!validateForm()) return;
  setIsSubmitting(true);
  try {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    console.log('Form gönderildi:', formData);
    navigate('/sites');
  } catch (error) {
    setSubmitError('...');
  } finally {
    setIsSubmitting(false);
  }
};
```

Gerçekte **hiçbir API çağrısı yok.** 1 saniye bekler, console'a loglar, `/sites` rotasına yönlendirir. Kullanıcı "çiftlik oluşturdum" zanneder ama veritabanında hiçbir satır yoktur.

Bu bir **geçiş artığı**dır — sistemde `farms` (legacy) tablosundan `sites` (yeni) tablosuna geçiş yapılmış, ama eski form ekranı hala duruyor ve kullanıcı buraya tıklarsa girdisi kaybolur. Gerçek site oluşturma `SetupPage > SitesTab > SiteFormModal` üzerindendir.

### 21.2 FarmListPage Silme — Stub

**Dosya:** `pages/FarmListPage.tsx:295`

Silme onay butonunda `console.log('Çiftlik silindi:', selectedFarm?.id);` — gerçek mutation yok. Liste mock veriyle dolar.

### 21.3 MapViewPage — Mock iddiası YANLIŞ (kaldırıldı)

~~Tesis haritası çizimi mock data ile simülasyon. Gerçek coğrafi veri entegrasyonu yapılmamış.~~

**Düzeltme:** Bu iddia önceki bir envanter taraması tarafından yanlış üretilmişti. `pages/MapViewPage.tsx` gerçekte Leaflet + Sentinel Hub + CMEMS ile tam implementasyona sahip. Bkz §19.4.

### 21.4 BiomassReportTab — Kısmi Stub

Raporu "kaydet" butonu `setTimeout` ile sahte başarı döner. Gerçek persistence yok.

### 21.5 Tablolar için Yazar Bulunmayanlar

| Tablo                                                                        | Sebep                                               |
| ---------------------------------------------------------------------------- | --------------------------------------------------- |
| `weather_observations`, `marine_observations`                                | Dış API worker besler, UI yazmaz                    |
| `sentinel_hub_settings`                                                      | Ayar formu var ama mutation seyrek kullanılır       |
| `water_quality_parameter_configs` (system entries)                           | Seed verisi, admin-only                             |
| `equipment_types`, `sub_equipment_types`, `supplier_types`, `chemical_types` | Referans tablolar, sistem-yönetimli seed            |
| `farms` (legacy)                                                             | FarmFormPage stub olduğu için veri gelmiyor         |
| `ponds` (legacy)                                                             | `createPond` mutation var ama UI çağrısı görünmüyor |
| `farm_outbox`                                                                | Handler'lar implicit yazar, API'den erişim yok      |

---

## 22. Güvenlik ve Tasarım Uyarıları

### 22.1 Tenant İzolasyonu — Güvenli

Her resolver `@CurrentTenant()` dekoratörü ile JWT'den `tenant_id` çıkarır. İstemciden kabul edilmez. Dinamik şema ismi gerekirse `getTenantSchemaName(tenantId)` ile güvenli türetilir.

Önceki bir audit (2026-03-16) `schemaName` parametresinin istemciden geldiği SQL injection/tenant bypass şüphesi işaretlemişti; **mevcut kodda bu riskin olmadığı doğrulandı**.

### 22.2 Cross-Tenant Event Handler Güvenliği

`FeedingStorageEventHandler` wildcard subject ile tüm kiracıların event'lerini dinler (`events.*.FeedingRecorded`). Bu sebeple her event işlenirken explicit tenant doğrulaması yapar:

```typescript
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (!event.tenantId || !UUID_REGEX.test(event.tenantId)) {
  this.logger.error('FeedingRecordedEvent has invalid or missing tenantId. Skipping...');
  return;
}
```

Bu kontrol kritik — aksi takdirde kötü niyetli bir event tenantlar arası veri karışmasına yol açabilir.

### 22.3 JSONB'ye Gömülü Alanlar — Filtreleme Kısıtı

Aşağıdaki tablolarda bazı alanlar ayrı sütun değil, JSONB içinde:

| Tablo                        | Sütun                                                                     | Gömülü alanlar                   | Etki                                                      |
| ---------------------------- | ------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------- |
| `sites`                      | `metadata`                                                                | region, postalCode, siteManager  | Bu alanlara göre filtreleme JSONB path query gerektirir   |
| `water_quality_measurements` | `parameter_values`                                                        | 25+ su parametresi               | Her parametre için index yok; büyük veri setlerinde yavaş |
| `feeding_records`            | `environment`, `fish_behavior`                                            | waterTemp, weather, appetite vb. | Davranış trendi analizi JSONB aggregation ister           |
| `batches_v2`                 | `weight`, `fcr`, `feeding_summary`, `growth_metrics`, `mortality_summary` | çok boyutlu özetler              | Normalize edilmediği için raporlama karmaşık              |
| `health_events`              | `symptoms`, `treatment`, `lab_results`, `water_quality_snapshot`          | semptom listesi vb.              | Tutarlı vocabulary yok; serbest metinler karışabilir      |

### 22.4 Foreign Key Constraint Durumu

Entity decorator'ları `@ManyToOne`, `@JoinColumn` ilişkilerini tanımlar. Ancak TypeORM `synchronize()` ile oluşan tablolarda fiziksel FK constraint'lerinin eksik olabileceği not edildi. Migration dosyalarıyla oluşan çekirdek tablolar FK'lara sahip; runtime sync ile oluşanlar kontrol edilmeli.

Silme davranışları:

- CASCADE: batch → batch_documents, batch → batch_locations, batch → mortality_records
- SET NULL: opsiyonel bağlar (örneğin `mortality_records.tank_id`)
- RESTRICT: kritik referanslar (species, feed)

### 22.5 Soft Delete ve Undelete Eksikliği

Kritik entity'ler soft delete uygular ama `restore` / `undelete` mutation'ı expose edilmemiştir. Yanlışlıkla silinen bir kayıt doğrudan SQL ile geri alınmak zorunda. UI'dan restore desteği yok.

### 22.6 Rate Limiting Eksikliği

Mutation'larda `@RateLimit` decorator'ı kullanılmamış. Yüksek etkili mutation'lar için potansiyel risk:

- `createBatch` — büyük allocation array'leri ile yoğun yazım tetikleyebilir
- `recordMortality` — spam edilirse büyüme modellerini ve alarm sistemlerini bozabilir
- `receiveDelivery` — toplu stok değişikliği

Öneri: `@RateLimit({ windowMs: 60000, max: 10 })` tipinde dekoratör eklemek.

### 22.7 Legacy Tablo Çiftleri

| Eski      | Yeni                             | Durum                                                                                              |
| --------- | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `farms`   | `sites`                          | Yeni akışlar `sites` kullanır. `farms` tablosu duruyor ama yeni veri gelmiyor (FarmFormPage stub). |
| `batches` | `batches_v2`                     | Yeni akışlar `batches_v2` kullanır. `batches` tablosu duruyor.                                     |
| `ponds`   | `tanks` (equipment with is_tank) | Yeni akışlar `tanks` kullanır. `ponds` tablosu ve `createPond` mutation'ı legacy.                  |

### 22.8 Public Şema Anomalisi

`public.feeder_calibrations` — tek `public` şema tablosudur. Diğer 69 tablo `farm` şemasında. RLS (Row-Level Security) politikaları farklı uygulanabilir; tenant izolasyonu `tenant_id` WHERE filtresine bağlıdır. Cross-service paylaşım amaçlı bu şekilde tasarlandığı düşünülüyor ama tasarım tutarsızlığı sayılır.

### 22.9 Dosya Yükleme Güvenliği

`batch_documents` ve `chemical_documents` için dosya yükleme iki adımlı:

1. İstemci MinIO'ya multipart upload → signed URL + documentId
2. GraphQL mutation metadata yazar (`storage_path`, `storage_url`, `mime_type`, `file_size`)

Bu ayrım arbitrary upload ve SQL injection risklerini ayrıştırır. Ancak:

- MinIO URL TTL doğru yapılandırılmalı (örneğin 1 saat)
- Tenant prefix bucket yolu zorunlu olmalı (cross-tenant file access engellenmeli)
- Mime type whitelist uygulanmalı

### 22.10 Cascade Delete Onayı

`deleteDepartment(id, cascade: boolean)` — `cascade` varsayılanı `false`. Kullanıcı explicit olarak `true` vermezse cascade delete olmaz. Preview query (`GetDepartmentDeletePreviewQuery`) silinecek alt kayıtları listeler, kullanıcı onaylayıp gönderir. Yetki: TENANT_ADMIN.

### 22.11 Optimistik Kilitleme

`@VersionColumn()` şu entity'lerde var: Batch, FeedingProgram, Equipment, Feed, Consumable, Chemical vb. İki kullanıcı aynı kaydı paralel güncellerse ikinci kaydetme başarısız olur, kullanıcı yeniden yüklemek zorunda. Bu tutarsızlığı önler ama kullanıcı deneyimi tarafında toast ile açıklama gerekir.

---

## Referanslar

- Görsel şema + sütun bazlı tablolar: [`farm-modulu-sema-gorsel.md`](./farm-modulu-sema-gorsel.md)
- Önceki modül audit'i: [`../farm-module-review-2026-03-16.md`](../farm-module-review-2026-03-16.md)
- Frontend kaynak kodu: `web/modules/farm-module/`
- Backend kaynak kodu: `apps/farm-service/`
- Migration dosyaları: `database/migrations/modules/farm/V001-V005*.sql`
- Init script: `infrastructure/docker/init-scripts/03-farm-tables-and-seed.sql`
- TypeORM synchronize konfigürasyonu: `apps/farm-service/src/app.module.ts:87, 182`
- Outbox entity tanımı: `apps/farm-service/src/outbox/farm-outbox.entity.ts:19`
- Event handler örneği: `apps/farm-service/src/storage/event-handlers/feeding-storage-event.handler.ts:42`
