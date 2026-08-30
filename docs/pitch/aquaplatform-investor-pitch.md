# AQUAPLATFORM: Endustriyel IoT & Operasyon Yonetim Platformu

## Yatirimci / Ortak Sunum Belgesi

> **Multi-tenant, modular, endustriden bagimsiz IoT & Operasyon Yonetim Platformu** - su urunleri ciftliklerinden baslayip herhangi bir canli uretim tesisine olceklenebilir.

---

## BOLUM 1: PROBLEM & FIRSAT

### Problem

Dunya nufusu 2050'ye kadar 10 milyar kisiye ulasacak. Gida uretiminin %70 artmasi gerekiyor. Ancak:

- **Su kaynaklari azaliyor** - Tarim su tuketiminin %70'ini olusturuyor
- **Ekilebilir arazi daraliyor** - Sehirlesme ve iklim degisikligi
- **Isgucu maliyeti yukseliyor** - Genclerin tarimdan uzaklasmasi
- **Verimlilik plato yapti** - Geleneksel yontemlerle daha fazla artis mumkun degil
- **Izlenebilirlik zorunlulugu** - AB, FDA ve ulusal regulasyonlar dijital kayit istiyor

### Firsat: $18+ Milyar IoT Tarim Pazari

| Pazar Segmenti                     | 2025            | 2030 Tahmini     | CAGR   |
| ---------------------------------- | --------------- | ---------------- | ------ |
| **Tarimda IoT**                    | $17.8B          | $37.4B           | ~9.7%  |
| **Hassas Tarim (Precision)**       | Pazarin %39.5'i | En buyuk segment | %13+   |
| **Dikey Tarim (Vertical Farming)** | $9.6B           | $107B (2035)     | %20-27 |
| **RAS Su Urunu Sistemleri**        | $5.4B           | $11.6B (2033)    | %8.9   |
| **Tarim SaaS**                     | $2.6B           | $12.3B (2031)    | %18.8  |

> Kaynak: MarketsandMarkets, Precedence Research, SkyQuest, Grand View Research

**Kritik Bulgu:** Yeni RAS kurulumlarinin %52'sinden fazlasi IoT tabanli su kalitesi izleme sistemi kullaniyor (2023). Pazar dijitallesme icin hazir.

---

## BOLUM 2: COZUMUMUZ - AQUAPLATFORM

### Tek Cumle

> **Multi-tenant, modular, endustriden bagimsiz IoT & Operasyon Yonetim Platformu** - su urunleri ciftliklerinden baslayip herhangi bir canli uretim tesisine olceklenebilir.

### Neden Farkliyiz?

| Ozellik              | Rakipler                     | AquaPlatform                                    |
| -------------------- | ---------------------------- | ----------------------------------------------- |
| **Mimari**           | Monolitik, tek sektor        | Mikroservis, modular, sektor-agnostik           |
| **Multi-Tenancy**    | Ortak DB veya uygulama bazli | PostgreSQL schema izolasyonu (enterprise-grade) |
| **IoT Entegrasyonu** | Temel sensor okuma           | VFD, PLC, Edge Device, MQTT, OPC-UA, Modbus     |
| **Mobil**            | Online-only                  | Offline-first PWA, IndexedDB kuyruk             |
| **Dikey Genisleme**  | Yeni urun gelistir           | Modul ekle, ayni altyapi                        |
| **Otomasyon**        | Basit kural motoru           | Gorsel workflow editoru, adim bazli program     |

---

## BOLUM 3: PLATFORM MIMARISI

### 3.1 Teknoloji Yigini

```
FRONTEND                          BACKEND                         ALTYAPI
------------------------------    ------------------------------  ------------------
React 18 + TypeScript             NestJS + GraphQL Federation     PostgreSQL 16
Vite + Module Federation          CQRS/Event Sourcing             TimescaleDB
shadcn/ui + Tailwind CSS          Apollo Server 4 (Federation)    Redis 7
TanStack Query + Zustand          TypeORM + Multi-tenant          NATS JetStream
Recharts + Leaflet (GIS)          JWT + RBAC                      MinIO (S3)
PWA (Offline-First)               OpenTelemetry                   Docker + K8s
```

### 3.2 Mikroservis Mimarisi (13 Bagimsiz Servis)

```
                    +------------------+
                    |   API Gateway    |  GraphQL Federation
                    | (Apollo Server)  |  Schema Stitching
                    +--------+---------+
                             |
        +--------------------+--------------------+
        |          |         |         |          |
   +----+----+ +--+---+ +---+---+ +---+---+ +---+---+
   |  Auth   | | Farm | |Sensor | |  HR   | |Alert  |
   | Service | |Service| |Service| |Service| |Engine |
   +---------+ +------+ +-------+ +-------+ +-------+
        |          |         |         |          |
   +----+----+ +--+---+ +---+---+ +---+---+ +---+----+
   |Billing  | |Hydro | |Config | |Notif. | |Event   |
   | Service | |ponics| |Service| |Service| |Store   |
   +---------+ +------+ +-------+ +-------+ +--------+
                                                  |
                                            +-----+------+
                                            |Observability|
                                            |  Service    |
                                            +-------------+
```

### 3.3 Multi-Tenant Izolasyon (Kurumsal Guvenlik)

```
PostgreSQL Veritabani
|
+-- public           (paylasilan: users, tenants, sessions)
+-- auth             (kimlik bilgileri, roller)
+-- farm             (referans veri: ekipman turleri, tur bilgileri)
+-- sensor           (referans: protokoller, sablonlar)
+-- hr               (referans: izin turleri, egitim)
|
+-- tenant_abc123... (Ciftlik A - TUM veri izole)
+-- tenant_def456... (Ciftlik B - TUM veri izole)
+-- tenant_ghi789... (Ciftlik C - TUM veri izole)
```

Her kiracinin verileri **kriptografik olarak ayrilmis** PostgreSQL schema'larinda tutuluyor. Bir kiracinin verisine baskasi erisemez.

---

## BOLUM 4: SENSOR MODULU - EVRENSEL IoT OMURGASI

### Bu Platformun Kalbi

Sensor modulu **endustriden bagimsiz** tasarlanmistir. Herhangi bir fiziksel sensoru, kontrol cihazini veya edge cihazi baglanabilir.

### 4.1 Desteklenen Protokoller & Cihazlar

| Kategori                      | Detay                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------- |
| **Iletisim**                  | MQTT, Modbus TCP/RTU, OPC-UA, HTTP REST                                          |
| **VFD (Frekans Donusturucu)** | ABB, Danfoss, Delta, Mitsubishi, Rockwell, Schneider, Siemens, Yaskawa (8 marka) |
| **PLC Kontrol**               | Siemens S7, Modbus, OPC-UA - alarm izleme, telemetri                             |
| **Edge Cihazlar**             | Self-registration, tenant provisioning keys, uzaktan yonetim                     |
| **Sensor Turleri**            | Sicaklik, pH, DO, iletkenlik, amonyak, nem, CO2, basinc, debi, seviye...         |

### 4.2 Otomasyon Motoru (Visual Workflow)

```
+----------+     +----------+     +----------+
| TRIGGER  | --> | KOSUL    | --> | AKSIYON  |
| pH < 6.5 |     | Saat>08  |     | Pompa AC |
+----------+     +----------+     +----------+
                      |
                      v  (Hayir)
                 +----------+
                 | ALARM    |
                 | SMS/Mail |
                 +----------+
```

- **Gorsel workflow editoru** - surukle-birak ile otomasyon programi olusturma
- **Adim bazli yurutme** - her adim kaydedilir, izlenebilir
- **Kosul mantigi** - if/else, zamanlama, esik degeri
- **Edge'e deploy** - program edge cihaza gonderilir, internet kesilse bile calisir

### 4.3 Gercek Zamanli Veri Akisi

```
Sensor --> MQTT Broker --> MQTT Listener Service --> TimescaleDB
                                    |
                                    +--> Alert Engine (esik kontrolu)
                                    +--> WebSocket (canli dashboard)
                                    +--> Event Store (audit log)
```

- **TimescaleDB**: Zaman serisi veriler icin optimize edilmis hypertable'lar
- **Continuous Aggregates**: Otomatik 1dk, 5dk, 1saat, 1gun ozet hesaplama
- **Retention Policy**: Eski ham veri otomatik silme, ozetler kalici

### 4.4 Sensor Modulu Neden Evrensel?

Sensor modulundeki **HIC BIR entity** balik, su, veya akuakulture ozel degildir:

| Entity                | Tanim                                          | Evrensel mi? |
| --------------------- | ---------------------------------------------- | ------------ |
| `sensor_readings`     | Ham sensor okumasi (value, timestamp, channel) | EVET         |
| `sensor_metrics`      | Hesaplanmis metrikler                          | EVET         |
| `sensor_channels`     | Veri kanallari (sicaklik, pH, nem...)          | EVET         |
| `vfd_devices`         | Frekans donusturucu kaydi                      | EVET         |
| `plc_devices`         | PLC baglanti bilgisi                           | EVET         |
| `edge_devices`        | Saha cihazi kaydi                              | EVET         |
| `automation_programs` | Otomasyon is akislari                          | EVET         |
| `dashboard_layouts`   | Kullanici dashboard'lari                       | EVET         |
| `alert_rules`         | Alarm kurallari                                | EVET         |

> **Sonuc**: Sensor modulu `sensor_channel` olarak "su sicakligi" yerine "sicaklik" kaydeder. Ayni kanal bir tavuk kumesinde de, serada da, biyoreaktorde de calisir.

---

## BOLUM 5: MEVCUT DIKEY - SU URUNLERI (AQUACULTURE)

### Su Urunleri Modulu Ozellikleri

#### Uretim Yonetimi

- **Batch Yasam Dongusu**: Stocking -> Buyume -> Hasat
- **Tank/Kafes Yonetimi**: Kapasite, yogunluk, transfer
- **Mortalite Takibi**: Neden analizi (hastalik, su kalitesi, stres, sicaklik, oksijen)
- **Buyume Olcumu**: Ortalama agirlik, biyomas hesaplama
- **FCR Analizi**: Yem Donusum Orani trend grafikleri

#### Yemleme Sistemi (Feeding Intelligence)

- **Gunluk yemleme planlari** otomatik olusturma (biyomas x oran)
- **Planlanan vs Gerceklesen** karsilastirma (varyans analizi)
- **Renk kodlu sapma**: Yesil (+-5%), Sari (+-15%), Kirmizi (>15%)
- **Yemleme programlari**: Tur, asama, mevsime gore
- **Yem stok tahmini**: Kac gun yeterli, siparis noktasi uyarisi

#### Ekipman & Bakim

- **Hiyerarsik ekipman agaci**: Sistem > Alt-Sistem > Ekipman > Alt-Ekipman
- **Yemleyici kalibrasyon** yonetimi
- **Bakim is emirleri** ve yedek parca envanter
- **Planli bakim takvimi**

#### Su Kalitesi & Cevre

- **Gercek zamanli sensor verileri**: pH, DO, sicaklik, tuzluluk, amonyak
- **Su kimyasi hesaplayici**: Millero denklemleri, Deffeyes diagrami
- **Dozaj tarifleri**: Otomatik kimyasal dozaj hesaplama
- **Saha bazli cevre paneli**: MET Norway hava tahmini, Copernicus Marine model
  deniz sicakligi/dalga/akinti degerleri ve CDSE Sentinel-2 goruntuleri

#### Regulasyon & Uyumluluk

- **Maskinporten** entegrasyonu (Norvec regulasyonlari)
- **Uretim raporlari**: Biyomas, hastalik, mortalite, deniz biti, refah olaylari
- **Denetim izi**: Tum islemler kaydedilir

#### Depolama & Stok

- **Envanter lokasyonlari** ve stok hareketleri
- **Satin alma siparisleri** ve teslimat is akislari
- **Sarf malzeme takibi**: Kimyasal, yem, yedek parca

---

## BOLUM 6: IKINCI DIKEY - HIDROPONIK (MEVCUT)

### Zaten Gelistirilen Dikey Genisleme Ornegi

Hidroponik modulu, **sensor modulunu ayni altyapi uzerinde kullanarak** tamamen farkli bir sektore nasil uyarlanabilecegini **kanitlar**.

### Besin Cozeltisi Hesaplayici (8 Sekmeli Uzman Sistemi)

```
1. Genel Ayarlar     --> Tur, asama, mevsim, sistem tipi
2. Su Analizi        --> 18+ parametre (EC, pH, K+, Ca2+, Mg2+, NH4+...)
3. Kullanici Tercihi --> Hedef besin oranlari, tercih carpanlari
4. Drenaj Bilesimi   --> Kapali dongu sistemler icin
5. Onceki Drenaj     --> Tarihsel karsilastirma
6. Mevcut NS Formulu --> Uygulanan besin cozeltisi
7. Yeniden Ayarlama  --> Kapali dongu optimizasyonu
8. Sonuc             --> Nihai tavsiye ve dozajlar
```

### Desteklenen Turler & Profiller

- **9 tur**: Domates, salatalik, biber, marul, cilek, patlican, kavun, gul, gerbera
- **Buyume asamalari**: Fide, vejetatif, ciceklenme, meyve 1/2
- **3 mevsim**: Soguk kis, ilkbahar/sonbahar, sicak yaz
- **24+ on tanimli profil**: Tur x asama x mevsim kombinasyonlari

### Sistem Turleri

- **Acik sistem** (drain-to-waste): Sera, acik tarla
- **Kapali dongu** (recirculating): Dikey tarim, kontrolllu ortam
- **Alt katman turleri**: Tas yunu, perlit, hindistancevizi lifi, pomza

### Mimari Dersler

- Ayri backend servisi (`hydroponics-service`) - bagimsiz olcekleme
- Ayni multi-tenant altyapisi - `tenant_xxx, hydroponics, public`
- Ayni auth/guard/middleware - sifir kod tekrari
- Modul Federation ile ana shell'e takilir - kullanici farki anlamaz

---

## BOLUM 7: MOBIL UYGULAMA - AQUAMOBIL (PWA)

### Saha Operasyonlari Icin Offline-First Mobil

```
+-----------------------------------+
|         AQUAMOBIL PWA             |
|                                   |
|  +-----------------------------+  |
|  |     DASHBOARD (Ana Sayfa)   |  |
|  |  - Tank listesi & durumu    |  |
|  |  - Aktif batch bilgileri    |  |
|  |  - Senkron bekleyen islem   |  |
|  +-----------------------------+  |
|                                   |
|  +------+  +------+  +-------+   |
|  | Yem  |  |Olum  |  |Hasat  |   |
|  |Kaydi |  |Kaydi |  |Kaydi  |   |
|  +------+  +------+  +-------+   |
|                                   |
|  +------+  +------+  +-------+   |
|  |Ayikla|  |Vardiya| |Senk.  |   |
|  |Kaydi |  |Takvim| |Durumu |   |
|  +------+  +------+  +-------+   |
+-----------------------------------+
```

### Temel Ozellikler

**Offline-First Mimari:**

- Islemler IndexedDB'de kuyruge alinir
- Internet geldiginde otomatik senkronize
- Manuel senkron butonu
- Her islem icin retry mantigi (max 3 deneme)
- Cihaz offline olsa bile TUM islemler kaydedilebilir

**Ozellik Kapilama (Feature Gating):**

- Her kullanici icin hangi ozelliklerin erisilebildigi tenant admin tarafindan belirlenir
- Kod degisikligi gerektirmez - yayin yapilmadan acilir/kapanir
- Roller bazli: Operator sadece yemleme ve mortalite gorebilir

**Desteklenen Islemler:**

| Islem               | Detay                                                          |
| ------------------- | -------------------------------------------------------------- |
| **Yemleme Kaydi**   | Planlanan vs gerceklesen, varyans gostergesi, yemleyici secimi |
| **Mortalite Kaydi** | Adet, neden (8 kategori), emoji bazli secim, tank secimi       |
| **Ayiklama (Cull)** | Bocek/hastaliklilarin ayiklanmasi                              |
| **Hasat Kaydi**     | Miktar, ortalama agirlik, kalite notu, alici, fiyat            |
| **Vardiya Takvimi** | Haftalik gorunum, vardiya detaylari, mesai hesabi              |
| **Senkron Durumu**  | Bekleyen islemler, hata detaylari, tekrar deneme               |

### Mobil Mimari - Diger Sektorlere Uyarlanabilirlik

Mobil uygulama **generic bir operasyonel veri giris sistemi** olarak tasarlanmistir:

```
MEVCUT (Aquaculture)          TAVUK CIFTLIGI               SERA
-----------------------       -----------------------      -----------------------
Tank -> Kumes                 Tank -> Bolme                Tank -> Sera Blogu
Batch -> Suru                 Batch -> Donem               Batch -> Ekim Donemi
Mortalite -> Olum Kaydi       Mortalite -> Olum Kaydi      Hastalik -> Zararli Kaydi
Yemleme -> Yem Kaydi          Yemleme -> Yem Kaydi         Gubre -> Gubre Kaydi
Hasat -> Hasat                Hasat -> Kesim Kaydi         Hasat -> Hasat
```

---

## BOLUM 8: DIKEY GENISLEME PLANI - YENI SEKTORLER

### 8.1 TAVUKCULUK / KANATLI HAYVANCILIGI (Poultry)

**Pazar Buyuklugu**: Kuresel kanatli eti pazari $300B+ (2025)

**Ihtiyac Duyulan Sensorler** (hepsi mevcut sensor moduluyle uyumlu):

| Parametre     | Sensor Tipi   | Kritik Esik                            |
| ------------- | ------------- | -------------------------------------- |
| Sicaklik      | DHT22 / PT100 | 32.2-35°C (civciv), 18-24°C (yetiskin) |
| Nem           | DHT22         | %60-70                                 |
| Amonyak (NH3) | MQ-135        | <25 ppm (uyari), >80 ppm (tehlike)     |
| CO2           | MH-Z19        | <3000 ppm                              |
| Isik (Lux)    | BH1750        | Tur/yasam asamasina gore               |
| Hava Akisi    | Anemometre    | Minimum ventilasyon orani              |

**Farm Modulunden Uyarlanacak Ozellikler**:

- Batch -> Suru yonetimi (civciv girisi, buyume, kesim)
- Mortalite takibi -> Ayni mekanizma, farkli nedenler
- Yemleme sistemi -> Planlanan vs gerceklesen, FCR analizi
- Ekipman yonetimi -> Yemleyiciler, fanlar, isiticilar, aydinlatma
- Depolama -> Yem stok, ilac stok

**Ek Moduller (Yeni)**:

- Yumurta uretim takibi (yumurtaci kumesler icin)
- Canli agirlik olcum (platform tartim)
- Asilama & ilac takvimi
- Kumes cevre skoru (welfare index)
- Kesimhane entegrasyonu

### 8.2 BUYUKBAS HAYVANCILIGI (Cattle/Dairy)

**Pazar Buyuklugu**: Kuresel sut urunu pazari $900B+ (2025)

**Sensor Uygulamalari**:

- Vucut sicakligi (implant/kulaklik sensor) -> hastaligi erken tespit
- Ruminasyon izleme -> Sindirim sagligi gostergesi
- Adim sayaci / GPS -> Otlak yonetimi, topal tespit
- Sut akis sensoru -> Suru bazli verim analizi
- Tartim platformu -> Canli agirlik, gunluk kazanc
- Cevresel: Sicaklik, nem, CO2, metan

**Platform Uyumluluklari**:

- Batch -> Suru yonetimi
- Yemleme -> Rasyon yonetimi (TMR - Total Mix Ration)
- Mortalite -> Kayip kaydi
- Hasat -> Sut toplama / kesim kaydi
- HR -> Coban/isci vardiya yonetimi
- Bakim -> Sagim makinesi, traktor, silo bakimi

### 8.3 SERA / KONTROLLLU ORTAM TARIMI (CEA)

**Pazar Buyuklugu**: Dikey tarim $9.6B (2025) -> $107B (2035)

**Sensor Uygulamalari**:

- Sicaklik / Nem (ic & dis)
- Toprak nemi / EC / pH
- Isik yogunlugu (PAR sensoru)
- CO2 seviyesi
- Ruzgar hizi (sera havalandirma)
- Damla sulama debi sensoru
- Yaprak islaklik sensoru

**Platform Uyumluluklari**:

- Hidroponik modul zaten mevcut - toprak bazli tarima genisletilebilir
- Yemleme sistemi -> Gubleme/sulama plani (planlanan vs gerceklesen)
- Otomasyon -> Perde, fan, isitma, sulama otomasyonu
- Hasat -> Verim kaydi, kalite siniflandirma
- Stok -> Tohum, gubre, ilac envanter

### 8.4 ARICILIK (Apiculture - Beekeeping)

**Sensor Uygulamalari**:

- Kovan agirligi (tartim sensoru) -> Bal uretim trendi
- Ic sicaklik -> Koloni sagligi (35°C ideal)
- Ic nem -> %50-60 ideal
- Akustik analiz -> Ari sagligi, ana ari durumu
- GPS -> Gezici aricilik konum takibi

### 8.5 MANTAR YETISTIRICILIGI (Mushroom Cultivation)

**Sensor Uygulamalari**:

- Sicaklik (%20-24°C)
- Nem (%85-95 - kritik)
- CO2 (%800-1500 ppm)
- Isik (dusuk, kontrolllu)
- Hava akisi

**Platform Uyumluluklari**:

- Batch -> Ekim donemi, misel gelisimi, hasat
- Yemleme -> Substrat hazirlama, sulama kaydi
- Cevre -> 7/24 izleme, otomatik alarm

### 8.6 BALIK YETISTIRICILIGI - RAS (Recirculating Aquaculture)

**Pazar Buyuklugu**: $5.4B (2025) -> $11.6B (2033)

Mevcut platform zaten RAS icin ideal. Ek olarak:

- Biyofiltre izleme
- UV sterilizasyon durumu
- Oksijen jeneratoru kontrolu
- Drum filtre otomasyonu
- Su dengesi (giren/cikan/buhaslasan)

### 8.7 DIGER POTANSIYEL SEKTORLER

| Sektor                | Sensor Ihtiyaci                  | Uyumluluk                   |
| --------------------- | -------------------------------- | --------------------------- |
| **Bira Fabrikasi**    | Sicaklik, pH, yogunluk, basinc   | Batch yonetimi, tarif uyumu |
| **Biyoreaktor/Lab**   | pH, DO, sicaklik, karistirma     | Batch izleme, otomasyon     |
| **Depo/Soguk Zincir** | Sicaklik, nem, kapi durumu       | Alarm, uyumluluk kaydi      |
| **Atik Su Aritma**    | pH, iletkenlik, bulaniklik, klor | 7/24 izleme, regulasyon     |
| **Enerji Santrali**   | Voltaj, akim, sicaklik, titresim | VFD kontrolu, bakim         |

---

## BOLUM 9: IS MODELI & GELIR

### SaaS Katmanli Fiyatlandirma

Platform zaten **modul bazli abonelik** altyapisina sahiptir (Billing Service):

| Plan             | Icerik                               | Ornek Fiyat |
| ---------------- | ------------------------------------ | ----------- |
| **Starter**      | Farm modulu + 10 sensor              | $99/ay      |
| **Professional** | Farm + Sensor + HR + 50 sensor       | $299/ay     |
| **Enterprise**   | Tum moduller + sinirsiz sensor + API | $799/ay     |
| **White Label**  | Ozel markalama + ozel modul          | Gorusme ile |

### Ek Gelir Kanallari

- **Edge cihaz satisi** - Self-registration ozellikli IoT gateway
- **Kurulum & egitim** - Saha kurulumu ve personel egitimi
- **API erisimi** - 3. parti entegrasyon (ERP, muhasebe, pazaryeri)
- **Veri analitik** - Sektor benchmark raporlari (anonim veri)
- **Otomasyon program satisi** - Hazir otomasyon sablonlari

---

## BOLUM 10: REKABET ANALIZI

### Neden Mevcut Cozumler Yetersiz?

| Rakip Tipi                  | Zayif Noktasi                 | AquaPlatform Avantaji              |
| --------------------------- | ----------------------------- | ---------------------------------- |
| **AKVA Group, InnovaSea**   | Sadece aquaculture, monolitik | Multi-sektor, modular              |
| **Stellapps (Sut)**         | Sadece sut sektoru            | Herhangi bir sektore uyarlanabilir |
| **CropX, Arable**           | Sadece tarla tarimi           | IoT + operasyon birlikte           |
| **Genel IoT (ThingsBoard)** | Operasyon yonetimi yok        | Sektor bilgisi gomulu              |
| **ERP (SAP, Oracle)**       | IoT yok, pahali, yavas        | Gercek zamanli, uygun fiyat        |

### Rekabet Avantajlarimiz

1. **Tek platform, coklu sektor** - Ayni core, farkli domain moduller
2. **Sensor-agnostik** - Herhangi bir MQTT/Modbus/OPC-UA cihaz
3. **8 VFD markasi** - Endustrinin en genis VFD destegi
4. **Offline-first mobil** - Internet'in guvenilmez oldugu sahalarda calisir
5. **Multi-tenant SaaS** - Her musteri izole, tek deployment
6. **GraphQL Federation** - Her modul bagimsiz olceklenir
7. **Visual otomasyon** - Kod yazmadan is akisi olusturma
8. **Gercek zamanli + tarihsel** - TimescaleDB ile ikisi bir arada

---

## BOLUM 11: TEKNIK HAZIRLIK DURUMU

### Uretim Hazir Ozellikler (Production-Ready)

| Katman                     | Durum | Detay                                           |
| -------------------------- | ----- | ----------------------------------------------- |
| **Multi-Tenant Izolasyon** | HAZIR | Schema-per-tenant, binlerce kiraciya olceklenir |
| **GraphQL Federation**     | HAZIR | 13 mikroservis, schema stitching                |
| **Sensor Veri Toplama**    | HAZIR | MQTT, VFD (8 marka), PLC, Edge                  |
| **Otomasyon Motoru**       | HAZIR | Gorsel workflow, edge deploy                    |
| **Alarm Sistemi**          | HAZIR | Esik tabanli, coklu bildirim kanali             |
| **Mobil (PWA)**            | HAZIR | Offline kuyruk, feature gating                  |
| **HR & Vardiya**           | HAZIR | Isci yonetimi, devamlilik, izin                 |
| **Faturalama**             | HAZIR | Abonelik, fatura, odeme                         |
| **GDPR Uyumluluk**         | HAZIR | Veri silme, anonim, ihrac                       |
| **CI/CD**                  | HAZIR | GitHub Actions, Docker, K8s                     |
| **Hidroponik Modul**       | BETA  | 8 sekmeli hesaplayici, 24 profil                |

### Kod Istatistikleri

| Metrik                       | Deger                  |
| ---------------------------- | ---------------------- |
| Backend Mikroservisler       | 13                     |
| Frontend Moduller            | 7 + Shell              |
| Paylasilan Kutuphaneler      | 8                      |
| Farm Modulu Tablolari        | 160+                   |
| Sensor Modulu Tablolari      | 50+                    |
| HR Modulu Tablolari          | 30+                    |
| Desteklenen VFD Markalari    | 8                      |
| Desteklenen PLC Protokolleri | 3 (S7, Modbus, OPC-UA) |
| GraphQL Tipleri              | 1000+                  |

---

## BOLUM 12: YATIRIM / ORTAKLIK BEKLENTISI

### Yol Haritasi

```
S1 2026: Mevcut aquaculture platformu uretim lansmani
         |
S2 2026: Tavukculuk modulu gelistirme (ilk dikey genisleme)
         |
S3 2026: Sera/CEA modulu + Hidroponik tamamlama
         |
S4 2026: Buyukbas/sut modulu + Aricilik pilot
         |
2027:    API marketplace + 3. parti modul ekosistemi
         |
2028:    AI/ML tahmin modulleri + uydu/model destekli risk skorlama
```

### Neden Simdi?

1. **RAS kurulumlarinin %52'si IoT istiyor** - Pazar hazir
2. **Dikey tarim %20-27 CAGR** - En hizli buyuyen segment
3. **AB Green Deal** - Dijital tarim zorunlulugu getiriyor
4. **Teknik altyapi hazir** - 0'dan baslayan rakiplere 2+ yil avantaj
5. **Modul mimarisi sayesinde** - Her yeni sektor mevcut kodun %70'ini yeniden kullanir

---

## BOLUM 13: DEMO SENARYOLARI

### Demo 1: Su Urunleri Ciftligi (Mevcut)

> Canli sensor verileri, tank biyomas gorunumu, gunluk yemleme plani, mobil uzerinden mortalite kaydi, otomasyon programi ile pompa kontrolu

### Demo 2: Tavuk Kumesi (Konsept)

> Ayni sensor moduluyle: Kumes sicakligi/nem/NH3 izleme, alarm (>25ppm), fan otomasyon, suru mortalite kaydi, yem tuketim varyans analizi

### Demo 3: Sera (Hidroponik Mevcut)

> Besin cozeltisi hesaplayici, EC/pH izleme, sulama otomasyon, hasat kaydi, cevre sensor dashboard

### Demo 4: Mobil Saha Operasyonu

> Offline ortamda mortalite kaydi -> Internete baglandi -> Otomatik senkronizasyon -> Dashboard'da aninda gorulme

---

## BOLUM 14: EKIP & ILETISIM

_[Bu bolum sunuma ozel doldurulacak]_

---

## ANAHTAR MESAJ

> **"Bir balik ciftligi icin gelistirdigimiz platform, aslinda herhangi bir canli uretim tesisi icin evrensel bir operasyon sistemidir. Sensor modulu endustriden bagimsiz, yemleme sistemi her sektore uyarlanabilir, mobil uygulama herhangi bir saha operasyonunu destekler. Biz bir su urunleri yazilimi degil, bir URETIM ZEKASI PLATFORMU insa ediyoruz."**

---

## KAYNAKLAR

- [Agriculture IoT Market - MarketsandMarkets](https://www.marketsandmarkets.com/Market-Reports/iot-in-agriculture-market-199564903.html)
- [IoT in Agriculture Market - SkyQuest](https://www.skyquestt.com/report/internet-of-things-iot-in-agriculture-market)
- [Vertical Farming Market - Precedence Research](https://www.precedenceresearch.com/vertical-farming-market)
- [RAS Aquaculture Market - Market Growth Reports](https://www.marketgrowthreports.com/market-reports/integrated-recirculating-aquaculture-system-ras-market-103035)
- [AgriTech SaaS Opportunity - Medium](https://medium.com/@urano10/2026-agritech-explosion-why-your-first-saas-could-be-farming-software-unexplored-niche-80ced1160df0)
- [Agriculture SaaS Market - 360iResearch](https://www.360iresearch.com/library/intelligence/agriculture-saas)
- [Smart Poultry Monitoring - Nature](https://www.nature.com/articles/s41598-025-17074-2)
- [IoT Poultry Monitoring - ResearchGate](https://www.researchgate.net/publication/358048515_IoT_Based_Smart_Monitoring_System_for_Efficient_Poultry_Farming)
- [RAS IoT Integration - GM Insights](https://www.gminsights.com/industry-analysis/recirculating-aquaculture-system-market)
- [AgriTech Platform Market - Persistence](https://www.persistencemarketresearch.com/market-research/agritech-platform-market.asp)

# Aquaculture Platform - Production Environment Variables

# Copy this file to .env on your server and fill in the values

#

# cp .env.production.example .env

# nano .env

# =============================================================================

# --- Database ---

POSTGRES_USER=aquaculture
POSTGRES_PASSWORD=JFnkR8QuSnsuQklHyWqV45PX
POSTGRES_DB=aquaculture

# --- Redis ---

REDIS_PASSWORD=O5LWb1R9Ky10qUakWqi6xkB7

# --- JWT ---

JWT_SECRET=OponN9FQ6A45cflI1JxLWOEAyBnoQd1I6v5BLd8kPhZDsAtB
JWT_EXPIRES_IN=1h

# --- Encryption ---

ENCRYPTION_KEY=c24b93a2703ddd47f01378e5b2e85db0

# --- Email (optional) ---

# SMTP_HOST=smtp.gmail.com

# SMTP_PORT=587

# SMTP_USER=your-email@gmail.com

# SMTP_PASS=your-app-password

# sımdı gıthuba serverdan commıtler yaptım ıstersen buraya lokale cek token lazım olursa dıgıtal ocean ısın kullanıcı adı Okan-wqm

# SUPER_ADMIN_EMAIL=by-okan@live.com

# SUPER_ADMIN_PASSWORD=<provision-in-secret-store>
