# Farm Modülü — Bilal'e Anlatır Gibi 🐟

Merhaba Bilal! Şimdi sana farm modülünü baştan sona, tane tane anlatacağım. Hangi ekrana ne yazdığında, arka planda **hangi tabloya** neyin kaydedildiğini göreceksin. Görsel şemaları görmek istersen [farm-modulu-sema-gorsel.md](./farm-modulu-sema-gorsel.md) dosyasına bak.

> **Önemli Not — Bilal dikkat:** İlk yazdığım şeylerde birkaç yanlış vardı. İkinci kontrolde düzelttim. Ama yazıyı yeniden baştan yazmak yerine, **§11 "Tekrar Kontrol — Nerede Yanıldım"** bölümünde net olarak düzeltmeleri ve eksikleri listeledim. Önce onu oku, sonra yukarıdaki bölümlere dön. Bazı iddialarımı özellikle düzeltmem gerek — mesela FarmFormPage aslında **hiçbir yere** kayıt yapmıyormuş! Detay §11'de.

---

## Önce Büyük Resim 🖼️

Sistemi anlamak için üç katman var, düşün ki bir restoranımız var:

1. **Frontend (Masa)** → Müşterinin (kullanıcının) sipariş yazdığı yer. Bizim için React ekranları.
2. **API (Garson)** → Siparişi mutfağa götüren. Bizim için GraphQL mutation'ları.
3. **Veritabanı (Mutfak)** → Siparişin gerçekten işlendiği yer. Bizim için PostgreSQL tabloları.

Kullanıcı bir forma bir şey yazdığında bu üç katmandan geçer. Bizim işimiz **hangi form alanı, hangi tabloya, hangi sütuna** düşüyor onu bilmek.

---

## 1. Farm (Çiftlik) Oluşturmak 🏡

Bilal, sistemde yeni bir çiftlik kaydetmek istersen **FarmFormPage** diye bir ekran açılır. Şu alanları doldurursun:

- Çiftlik adı
- Enlem–boylam (konum)
- Adres
- İletişim bilgileri
- Toplam alan

**Kaydet**e bastığında:

1. Frontend `createFarm` diye bir GraphQL mutation çağırır.
2. `apps/farm-service/src/farm/resolvers/farm.resolver.ts` dosyasındaki resolver bunu yakalar.
3. `CreateFarmCommand` komutu tetiklenir.
4. **`farm.farms`** tablosuna bir satır eklenir.

**Tablo ne alır?**

| Yazdığın | Tabloda nereye gider |
|----------|---------------------|
| Çiftlik adı | `farms.name` |
| Enlem + boylam | `farms.location` (JSONB — `{lat, lng}` olarak) |
| Adres | `farms.address` |
| İletişim kişisi | `farms.contact_person` |
| Telefon | `farms.contact_phone` |
| E-posta | `farms.contact_email` |
| Açıklama | `farms.description` |
| Toplam alan | `farms.total_area` |

> ⚠ **Önemli uyarı:** Ekranda bir "Farm Type" (tank / cage / pond) seçeneği var ama **`farms` tablosunda bu sütun yok.** Bu alan şu an kaybediliyor veya başka bir yere gömülüyor. Bu bir bug gibi duruyor.

> 🔴 **Dikkat:** Bu `farms` tablosu aslında **eski (legacy)**. Yeni mimari `sites` tablosu üzerine kurulu. Aşağıda anlatacağım.

---

## 2. Site (Tesis) Oluşturmak — Yeni Yöntem 🏭

Bilal, modern ekran **SiteFormModal**. "Site" aslında "üretim tesisi" demek — bir çiftliğin fiziksel konumu. Burada daha detaylı bilgi girersin:

- Site adı ve kodu (örn "MAIN-01")
- Durum (Aktif / Bakımda / Kapalı)
- Ülke, şehir, adres, posta kodu
- Zaman dilimi (`Europe/Istanbul` gibi)
- Enlem–boylam
- Toplam alan (m²)
- Site yöneticisi, iletişim bilgileri

**Kaydet**e bastığında `createSite` mutation'ı çalışır → **`farm.sites`** tablosuna yazılır.

**Ama dikkat et Bilal:** Ekranda topladığımız **her alan tabloda birebir sütun olarak yok.** Bak şöyle:

| Ekranda yazdığın | Tabloda nereye gider |
|------------------|---------------------|
| Site adı | `sites.name` ✅ |
| Kod | `sites.code` ✅ |
| Durum | `sites.status` ✅ |
| Ülke | `sites.country` ✅ |
| Şehir | `sites.city` ✅ |
| Zaman dilimi | `sites.timezone` ✅ |
| Toplam alan | `sites.total_area_m2` ✅ |
| Enlem | `sites.latitude` ✅ |
| Boylam | `sites.longitude` ✅ |
| Sokak adresi | `sites.address` ✅ |
| Bölge / State | ⚠ `sites.metadata` JSONB içine |
| Posta kodu | ⚠ `sites.metadata` JSONB içine |
| Site yöneticisi | ⚠ `sites.metadata` JSONB içine |
| İletişim e-posta | ⚠ `sites.metadata` JSONB içine |
| İletişim telefon | ⚠ `sites.metadata` JSONB içine |

> Gördün mü Bilal? Son 5 alan **ayrı sütun değil**, hepsi `metadata` diye tek bir JSONB sütununa gömülüyor. Bu raporlama ve filtreleme için dezavantaj — "bölgeye göre siteleri listele" demek kolay değil çünkü sütun değil JSON içinde.

---

## 3. Batch (Parti) Oluşturmak — En Karmaşık İşlem 🐠

Bilal, en çetrefilli yer burası. Bir balık partisi (batch) eklediğinde **üç farklı tabloya birden** yazılır. Ekran adı **BatchFormModal**.

### Adım Adım Ne Olur?

Bir parti eklediğinde şu bilgileri verirsin:
- Parti adı, tür, ırk/çeşit (strain)
- Giriş tipi (yumurta, larva, yavru, juvenile, yetişkin, damızlık)
- Başlangıç adedi, ortalama ağırlık
- Stoklama tarihi, beklenen hasat tarihi
- Hedef FCR (yem dönüşüm oranı)
- Tedarikçi, satın alma maliyeti, para birimi
- Sağlık sertifikası ve ithalat belgeleri (**dosya upload**)
- Hangi tank(lar)a ne kadar koyulacağı (**tank allocation**)

Şimdi dikkat: Sen "Kaydet"e bir kez basıyorsun ama arka planda **üç ayrı iş** oluyor:

#### İş 1: Parti kaydının kendisi → `batches_v2`

```
createBatch mutation → CreateBatchCommand → batches_v2 tablosu
```

| Yazdığın | Tabloya |
|----------|---------|
| Parti adı | `batches_v2.name` |
| Tür | `batches_v2.species_id` |
| Irk | `batches_v2.strain` |
| Giriş tipi | `batches_v2.input_type` |
| Başlangıç adet | `batches_v2.initial_quantity` |
| Ortalama ağırlık (g) | `batches_v2.weight_initial_avg_g` |
| Stoklama tarihi | `batches_v2.stocked_at` |
| Beklenen hasat tarihi | `batches_v2.expected_harvest_date` |
| Hedef FCR | `batches_v2.fcr_target` |
| Tedarikçi | `batches_v2.supplier_id` |
| Satın alma maliyeti | `batches_v2.purchase_cost` |
| Para birimi | `batches_v2.currency` |
| Tedarikçi parti no | `batches_v2.supplier_batch_number` |
| Notlar | `batches_v2.notes` |
| Arrival Method (AIR_CARGO vb.) | ⚠ `batches_v2.metadata` içine |

#### İş 2: Yüklediğin belgeler → `batch_documents`

Her dosya için ayrı bir satır:

| Dosya bilgisi | Tabloya |
|---------------|---------|
| Belge tipi (Sağlık / İthalat) | `batch_documents.document_type` |
| Dosya adı | `batch_documents.original_filename` |
| Dosyanın storage yolu | `batch_documents.storage_path` |
| MIME tipi | `batch_documents.mime_type` |
| Dosya boyutu | `batch_documents.file_size` |

#### İş 3: Tank atamaları → `batch_locations`

Bilal, bir parti aynı anda birden fazla tanka dağıtılabilir. Her tank için bir satır:

| Yazdığın | Tabloya |
|----------|---------|
| Tank seçimi | `batch_locations.tank_id` |
| Miktar | `batch_locations.quantity` |
| Atama tarihi | `batch_locations.allocation_date` |

> **Önemli:** Eğer partiyi 3 tanka dağıtırsan `batch_locations` tablosuna **3 satır** eklenir. Parti ilerde bir tanktan diğerine transfer edilirse yine buraya yeni satır yazılır.

> 🔴 **Eski tablo uyarısı:** `batches_v2`'nin yanında bir de eski `batches` tablosu var. Yeni kayıtlar artık `batches_v2`'ye gidiyor. Eski tablo kullanımdan kalkıyor ama hala veritabanında duruyor.

---

## 4. Yemleme Kaydı 🍽️

Bilal, günlük yemleme yaptığında **RecordFeedingModal**'ı açarsın. Şu bilgileri verirsin:
- Tarih ve saat
- Hangi parti, hangi tank
- Hangi yem, ne kadar planlandı, ne kadar verildi, ne kadar israf oldu
- Balıkların davranışı (aç mı, doyuyor mu)
- Yöntem (elle / otomatik)
- Hangi ekipman kullanıldı
- Süre, notlar

`createFeedingRecord` çalışır → **`farm.feeding_records`** tablosuna tek satır düşer.

| Ekrandan | Tabloya |
|----------|---------|
| Tarih | `feeding_records.feeding_date` |
| Saat | `feeding_records.feeding_time` |
| Parti | `feeding_records.batch_id` |
| Tank | `feeding_records.tank_id` |
| Yem | `feeding_records.feed_id` |
| Planlanan miktar | `feeding_records.planned_amount` |
| Fiili miktar | `feeding_records.actual_amount` |
| Fire miktarı | `feeding_records.waste_amount` |
| Balık davranışı | `feeding_records.fish_behavior` |
| Yöntem | `feeding_records.feeding_method` |
| Ekipman | `feeding_records.equipment_id` |
| Süre (dk) | `feeding_records.feeding_duration_minutes` |
| Notlar | `feeding_records.notes` |

> Bilal, sistem otomatik olarak **variance** (planlanan vs fiili fark) ve **variance_percent**'i hesaplayıp yazar. Bunları sen girmezsin, arka planda çıkar.

---

## 5. Büyüme Ölçümü 📏

Örneklem alıp balıkları tarttığında **Growth Form**'u açarsın. `recordGrowthSample` → **`farm.growth_measurements`** tablosuna yazar.

| Ekrandan | Tabloya |
|----------|---------|
| Ölçüm tarihi | `growth_measurements.measurement_date` |
| Parti | `growth_measurements.batch_id` |
| Tank | `growth_measurements.tank_id` |
| Örneklem büyüklüğü | `growth_measurements.sample_size` |
| Ortalama ağırlık | `growth_measurements.avg_weight_g` |
| Toplam biyokütle | `growth_measurements.total_biomass_kg` |
| FCR (opsiyonel) | `growth_measurements.fcr` |
| Notlar | `growth_measurements.notes` |

> **Not:** SGR (specific growth rate) bu kayıttan önceki ölçümle karşılaştırılarak sistem tarafından hesaplanır.

---

## 6. Su Kalitesi Ölçümleri 💧

Bu özel Bilal. Çünkü **25'ten fazla parametre** var (pH, çözünmüş oksijen, amonyak, nitrit, nitrat, sıcaklık, tuzluluk...). Ama bunların **hepsi tek bir JSONB sütununa** yazılıyor.

`recordWaterQuality` → **`farm.water_quality_measurements`** tablosu.

| Ekrandan | Tabloya |
|----------|---------|
| Ölçüm tarihi | `water_quality_measurements.measurement_date` |
| Tank | `water_quality_measurements.tank_id` |
| Sistem | `water_quality_measurements.system_id` |
| Ekipman | `water_quality_measurements.equipment_id` |
| Notlar | `water_quality_measurements.notes` |
| **Tüm parametre değerleri** | `water_quality_measurements.parameter_values` (JSONB) ⚠ |

> **Neden önemli Bilal?** Şöyle: "pH > 8.0 olan ölçümleri listele" demek istediğinde SQL'de `WHERE parameter_values->>'pH' > '8.0'` gibi JSONB sorgusu yazman gerekir. Eğer ayrı sütun olsaydı, indeks kurup çok daha hızlı sorgulayabilirdin. Bu bilinçli bir karar ama raporlama performansına fiyat ödetiyor.

---

## 7. Tabloların Birbirine Bağı 🔗

Bilal şunu aklında tut:

```
site (tesis)
  └─ department (departman)
      └─ system (RAS sistemi vb.)
          ├─ sub_system (alt bileşen)
          └─ tank (tank/kafes/havuz)
              ├─ batch_locations (hangi parti burada)
              ├─ feeding_records (yemleme geçmişi)
              ├─ water_quality_measurements (su kalitesi)
              └─ equipment (ekipmanlar)

batch (parti)
  ├─ batch_documents (belgeler)
  ├─ batch_locations (hangi tanklarda)
  ├─ growth_measurements (büyüme ölçümleri)
  ├─ mortality_records (ölüm kayıtları)
  ├─ harvest_records (hasat kayıtları)
  └─ feeding_records (yemleme geçmişi)

species (tür) → batches_v2 (o türe ait partiler)
feed_types (yem kataloğu) → feeding_records + feed_inventory
```

---

## 8. Karmaşık Konular — Daha İyi Bilmen İçin 🎓

### 8.1 Neden `farms` ve `sites` iki tablo?

Bilal, mimari değişmiş. Eskiden **farms** tablosu varmış. Sonra daha profesyonel bir model lazım olmuş — bir çiftliğin birden fazla fiziksel tesisi olabilir, her tesisin kendi lisansı, zaman dilimi, su kaynağı var. O yüzden **sites** tablosu eklenmiş.

- **Eski yol:** FarmFormPage → `farms`
- **Yeni yol:** SiteFormModal → `sites`

İkisi şu an paralel duruyor. Gelecekte eski olan kaldırılacak. Eğer bugün yeni iş yapıyorsan **sites** kullan.

### 8.2 Neden `batches` ve `batches_v2`?

Aynı sebepten. Parti yönetimi zenginleşmiş — FCR hesaplamaları, multi-tank atama, belge yönetimi, tedarikçi takibi eklenince yeni versiyona geçilmiş. Yeni kayıtlar hep `batches_v2`'ye.

### 8.3 "metadata" JSONB alanları ne demek?

Bazı alanlar düzenli sütun değil, esnek JSON olarak saklanıyor. Örneğin `sites.metadata` içinde ekstra iletişim bilgileri tutuluyor. Avantajı: şema değişikliği yapmadan yeni alan ekleyebilirsin. Dezavantajı: SQL sorguları yavaşlar, schema validation yok, tip güvenliği yok.

### 8.4 Güvenlik uyarısı 🔴

Bilal, önceki inceleme (`docs/farm-module-review-2026-03-16.md`) bir şey söylüyor: bazı GraphQL mutation'ları `schemaName` parametresini **frontend'den** kabul ediyor. Bu **SQL injection ve tenant isolation bypass** riski demek. Kritik, çünkü başka bir tenant'ın verisine erişmek teorik olarak mümkün. Yeni özellik yazarken asla tenant bilgisini client'tan alma, JWT/context'ten oku.

### 8.5 Eksik FK constraint'ler

Tablolarda `batch_id`, `tank_id` gibi referans alanlar var ama **foreign key constraint yok.** Yani veritabanı, olmayan bir batch'e referans vermeni engellemiyor. Bu "orphaned" (öksüz) kayıtlara yol açabilir. Production'da ciddi sorun.

---

## 9. Frontend'i Eksik Kalan Tablolar 👻

Bilal, backend'de mutation yazılmış ama UI'da form yok. Şu anda kullanıcı bunları sisteme ekleyemiyor:

- `createHarvestRecord` (hasat kaydı)
- `createHealthEvent` (sağlık olayı)
- `createMortalityRecord` (ölüm kaydı) — kısmen
- `createDepartment`, `createSystem`, `createSubSystem`
- `createWorker`, `createSupplier`
- `createChemical`, `createConsumable`, `createStorageLocation`
- `createMaintenanceSchedule`, `createWorkOrder`, `createSparePart`
- `createWaterQualityRecord` (direkt — var ama protokol eksik)

Bunların UI'ı yazıldıkça farm modülü tamamlanacak.

---

## 10. Özet — Aklında Kalsın 📝

1. **Frontend bir form gönderir → GraphQL mutation → Resolver → Command → Repository → PostgreSQL tablosu.** Beş aşama.
2. Bir form her zaman tek tabloya yazmaz. **BatchFormModal** üç tabloya yazar: `batches_v2`, `batch_documents`, `batch_locations`.
3. **`farms` eski, `sites` yeni.** **`batches` eski, `batches_v2` yeni.**
4. Ekranda gördüğün bazı alanlar şemada **sütun değil**, `metadata` JSONB içine gömülüyor.
5. **Su kalitesi 25+ parametre tek JSONB** içinde — hızlı rapor zor.
6. **FK constraint'ler eksik** — tutarsız veri riski.
7. **schemaName güvenlik açığı** kritik, mutlaka düzeltilmeli.

---

Sorun olursa bana geri dön Bilal, birlikte bakarız 🙂

**Referanslar:**
- Görsel şemalar: `farm-modulu-sema-gorsel.md`
- Detaylı audit: `../farm-module-review-2026-03-16.md`
- Frontend kodu: `web/modules/farm-module/`
- Backend kodu: `apps/farm-service/`
- Migrations: `database/migrations/modules/farm/`

---

## 11. Tekrar Kontrol — Nerede Yanıldım, Ne Atladım 🔍

Bilal, ilk yazdıklarımda birkaç şeyi yanlış söyledim ve modülün yarısından fazlasını atladım. İkinci kontrolde şunları buldum. **Önceki bölümlerden ziyade buraya güven** — bunlar kodda birebir doğrulandı.

### 11.1 Yanlış İddialarımın Düzeltilmesi

#### ❌ "FarmFormPage, `farms` tablosuna kayıt yapar"

**YANLIŞ!** Kodu açıp baktığımda `handleSubmit` fonksiyonu şöyle Bilal:

```typescript
// FarmFormPage.tsx:100-110
const handleSubmit = async (e: React.FormEvent) => {
  // API çağrısı simülasyonu
  await new Promise((resolve) => setTimeout(resolve, 1000));
  console.log('Form gönderildi:', formData);
  navigate('/sites');
};
```

Yani form **hiçbir yere kayıt yapmıyor.** Sadece 1 saniye bekliyor, console'a yazıyor, sonra `/sites` sayfasına yönlendiriyor. Bu ya eski bir stub, ya hiç bağlanmamış bir geliştirme artığı. Gerçek çiftlik oluşturma **SiteFormModal → sites tablosu** üzerinden oluyor.

**Çıkarım:** "FarmFormPage → farms" eşleşmesini tamamen sil aklından. Kullanıcı modern akışta `SiteFormModal`'ı kullanıyor.

#### ❌ "Site.contactEmail/contactPhone `metadata` JSONB'ye gömülüyor"

**YANLIŞ!** Bunları gerçek sütun olarak tanımlamışlar:

```typescript
// site.entity.ts:224-229
@Column({ length: 50, nullable: true })
contactPhone?: string;

@Column({ length: 150, nullable: true })
contactEmail?: string;
```

Yani `sites.contact_phone` ve `sites.contact_email` düzgün, indekslenebilir, filtrelenebilir sütunlar. Raporlamada sorun yok.

#### ❌ "Batch.arrivalMethod `metadata` JSONB'ye gömülüyor"

**YANLIŞ!** Gerçek bir enum sütun:

```typescript
// batch.entity.ts:289-292
@Column({
  type: 'enum',
  enum: ArrivalMethod,
  nullable: true,
})
arrivalMethod?: ArrivalMethod;
```

`batches_v2.arrival_method` enum sütunu olarak var. AIR_CARGO, TRUCK, BOAT gibi değerler direkt filtrelenebilir.

#### ⚠ "`feeder_calibrations` farm şemasında"

Kısmen yanlış — aslında **`public` şemasında** yaratılıyor, `farm` şemasında değil:

```sql
-- V005 migration
CREATE TABLE IF NOT EXISTS feeder_calibrations (...)  -- farm. prefix'i YOK
```

Bu bir tutarsızlık Bilal. Diğer farm tabloları `farm.` prefix'iyle başlıyor ama bu değil. İleride sorun çıkarabilir (isim çakışması, RLS politika eksiği).

### 11.2 En Büyük Atlamam — 71 Tablo Var, Ben 20 Demiştim!

Bilal bu utandırıcı ama dürüst söyleyeyim: `apps/farm-service/src/` altında **71 tane `*.entity.ts` dosyası** var. Migration dosyaları sadece 11 çekirdek tabloyu yaratıyor; gerisi TypeORM'un `synchronize()` mekanizmasıyla runtime'da ilk açılışta oluşuyor (`app.module.ts:87, 182`).

Yani modülde **5 ana bölge** var, ben sadece ilk ikisini iyi anlattım:

**✅ Anlattıklarım (yaklaşık %30):**
- Sites, Departments, Systems, Tanks, Species
- Batches, Growth, Mortality, Harvest (temel)
- Feeding (temel), Water Quality

**❌ Atladıklarım (yaklaşık %70):**

##### A) Depo & Stok Yönetimi 📦

Kocaman bir subsistem. StoragePage'in olduğunu mırıldanmıştım ama tablolarını vermedim:

| Tablo | Ne Tutar |
|-------|----------|
| `storage_locations` | Ambar / depo konumları |
| `storage_inventory` | Anlık stok seviyeleri |
| `stock_movements` | Her stok hareketi (giriş/çıkış/transfer) |
| `inventory_counts` + `inventory_count_items` | Sayım kayıtları |
| `purchase_orders` + `purchase_order_items` | Satın alma siparişleri |
| `consumables` | Sarf malzemeler |
| `chemicals` + `chemical_types` + `chemical_sites` | Kimyasal yönetimi |
| `suppliers` + `supplier_types` + `supplier_sites` | Tedarikçi katalog + site bağlantıları |

**Önemli:** Sen bir feeding_records girdiğinde, arka planda **event handler** çalışıyor ve otomatik `stock_movements` tablosuna düşüm kaydı atıyor. Yani tek formla çoklu tablo yazımı sadece Batch'te değil, Feeding'de de var.

##### B) Bakım Yönetimi 🔧

| Tablo | Ne Tutar |
|-------|----------|
| `maintenance_schedules` | Planlı bakım zamanları |
| `work_orders` | İş emirleri |
| `spare_parts` | Yedek parça envanteri |

Bu ekranlar var: `MaintenanceSchedulesPage.tsx`, `WorkOrdersPage.tsx`, `SparePartsPage.tsx`.

##### C) Sağlık & Düzenleyici Raporlar 🏥

| Tablo | Ne Tutar |
|-------|----------|
| `health_events` | Hastalık, ölü balık olayı, anormal durum |
| `regulatory_settings` | Düzenleyici kurum ayarları (Norveç, Türkiye vs.) |
| `sentinel_hub_settings` | Uydu görüntüleri ayarları |

`ReportsPage.tsx` → DiseaseOutbreak, EscapeReport, SeaLiceReport, SlaughterReport, WelfareEvent, SmoltReport gibi yasal raporları üretiyor.

##### D) Görevler & Otomasyon 📋

| Tablo | Ne Tutar |
|-------|----------|
| `tasks` | Günlük görevler |
| `auto_rules` | "Sıcaklık X°C üstüne çıkarsa bildir" gibi kurallar |
| `recurring_templates` | Tekrarlayan görev şablonları |

##### E) Ekipman Detay Sistemi ⚙️

Ben sadece "equipment" dedim ama aslında:

| Tablo | Ne Tutar |
|-------|----------|
| `equipment` | Ekipman kayıtları (anlattım) |
| `equipment_types` | Ekipman tipleri (pompa, ısıtıcı, oksijenmetre vb.) |
| `equipment_systems` | Hangi sistemde hangi ekipman |
| `sub_equipment` | Ekipmanın alt bileşenleri |
| `sub_equipment_types` | Alt bileşen tipleri |

##### F) Hava, Deniz ve Uydu 🌊☁️🛰️

| Tablo | Ne Tutar |
|-------|----------|
| `weather_observations` | Hava ölçümleri |
| `weather_settings` | Hava API ayarları |
| `marine_observations` | Deniz gözlemleri (akıntı, tuzluluk vb.) |
| `sentinel_hub_settings` | Copernicus Sentinel Hub uydu kanalları |

##### G) Yem Detay Alt Sistemi 🌾

| Tablo | Ne Tutar |
|-------|----------|
| `feed` | Ana yem kataloğu (vs `feed_types` eski) |
| `feed_sites` | Yemin hangi sitede stokta olduğu |
| `feed_type_species` | Yem-tür uyumluluk tablosu |
| `feeding_programs` | Yemleme programları (ana plan) |
| `feeding_program_tanks` | Hangi program hangi tanka uygulanıyor |
| `feeding_tables` | Lookup tablosu (yaşa/ağırlığa göre rasyon) |

##### H) Su Kalitesi Yapılandırma 💧

| Tablo | Ne Tutar |
|-------|----------|
| `water_quality_parameter_configs` | Her parametrenin alt/üst limiti, birimi |
| `water_quality_param_equipment` | Hangi ekipman hangi parametreyi ölçüyor |

##### I) Batch Alt Sistemi (daha detaylı)

Ben `batch_documents`, `batch_locations` dedim ama şunlar da var:

| Tablo | Ne Tutar |
|-------|----------|
| `batch_feed_assignments` | Bir parti için hangi yem tercih edilecek |
| `tank_allocations` | Tank atamaları (batch_locations ile benzer, detay farklı) |
| `tank_batches` | Tank ↔ parti junction |
| `tank_operations` | Tank üzerindeki her işlem (doldurma, boşaltma, transfer) |

##### J) Temizleyici Balık 🐟 (ayrı işlem hattı)

`CleanerFishPage.tsx` ve `cleaner-fish.resolver.ts` ayrı bir iş akışı — parazit kontrolü için kullanılan temizleyici balıklar. Kendi create/deploy/mortality/transfer mutation'ları var.

##### K) Çalışan, Şirket, Denetim

| Tablo | Ne Tutar |
|-------|----------|
| `workers` | Çalışan kayıtları |
| `site_contacts` | Bir siteye ait birden fazla irtibat |
| `audit_logs` | Her kritik yazma işleminin izi |
| `farm_outbox` | Event sourcing — başka modüllere haber uçurmak için kuyruk |
| `code_sequences` | Otomatik kod üretimi (batch number gibi) |

### 11.3 Verinin GraphQL Dışı Yolları Var!

Bilal dikkat et, veri sadece GraphQL'den gelmiyor:

1. **REST Controller — Batch Operasyonları**
   `apps/farm-service/src/batch/controllers/batch.controller.ts`
   - `POST /api/batches` → parti oluştur
   - `POST /api/tank-operations/mortality` → ölüm kaydı
   - `POST /api/tank-operations/cull` → eleme
   - `POST /api/tank-operations/transfer` → transfer
   - `POST /api/tank-operations/harvest` → hasat
   
   Yani batch kayıtları GraphQL'in yanında REST ile de yazılabiliyor. Entegrasyonlar (örn SCADA, otomatik sistemler) bu REST yolunu kullanıyor olabilir.

2. **Outbox Pattern — `farm_outbox` tablosu**
   Her kritik DB yazması aynı transaction'da `farm_outbox`'a event kaydediyor. Başka bir worker bunu okuyup Kafka/NATS'e basıyor. Böylece diğer modüller (billing, notification, analytics) haberdar oluyor.

3. **Event Handler'lar — Otomatik Yan Yazılar**
   Örnek: `feeding-storage-event.handler.ts` — bir feeding_records kaydı atıldığında, ilgili yemin stoğundan otomatik düşüm yapıyor. Sen formu doldururken bunu görmüyorsun ama iki tabloya birden yazım oluyor.

4. **Audit Log**
   `audit_logs` tablosu her kritik işlemi logluyor (kim, ne zaman, hangi tabloda ne değişti).

### 11.4 Çok Önemli Sayılar

| Kategori | Ben Ne Demiştim | Gerçek | Kapsam |
|----------|-----------------|--------|--------|
| Tablo sayısı | ~20 | 71 | %28 |
| Resolver dosyası | 8 | 36 | %22 |
| GraphQL mutation | ~25 | 75+ | %33 |
| Frontend sayfa | ~7 | 25+ | %28 |
| Yazma yolu | Sadece GraphQL | GraphQL + REST + Outbox + Event handler + Audit | — |

### 11.5 Özet — Bilal Aklında Kalsın

1. **FarmFormPage ölü bir ekran.** Kayıt yapmıyor. Gerçek akış `SiteFormModal`.
2. **Site'ın iletişim bilgileri gerçek sütunlar**, JSONB değil. Filtrele rahatça.
3. **Batch.arrival_method gerçek enum**, JSONB değil.
4. **Modülde 71 tablo var, 36 resolver var.** Benim anlattığım ana üçte biri.
5. **Depo, bakım, sağlık, görev, rapor, hava, uydu, temizleyici balık** — her biri ayrı subsistem.
6. **Veri GraphQL dışında REST controller ve event handler'lardan da yazılıyor.** Sadece mutation'ları izlerken yanılgıya düşme.
7. **`farm_outbox` + `audit_logs`** — her işlemin yan yazıları var. Görünmez ama kritik.

Bu sefer tam liste işte. Eksik hissedersen "bu sefer tam mı" diye sormaya devam et 😄
