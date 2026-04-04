# SCADA Builder -- Ileri Seviye Kilavuz

**Platform:** Aquaculture SaaS
**Surumu:** v2.x (Mart 2026)
**Hedef Kitle:** SCADA operatorleri, proses muhendisleri, sistem entegratorleri

---

## Icindekiler

1. [FUXA Widget Entegrasyonu](#1-fuxa-widget-entegrasyonu)
2. [Proses Akis Diyagramlari (P&ID)](#2-proses-akis-diyagramlari-pid)
3. [Ornek SCADA Ekranlari (Aquaculture)](#3-ornek-scada-ekranlari-aquaculture)
4. [Gelismis Animasyon Teknikleri](#4-gelismis-animasyon-teknikleri)
5. [Multi-Screen Proje Yonetimi](#5-multi-screen-proje-yonetimi)
6. [Performans Optimizasyonu](#6-performans-optimizasyonu)
7. [Entegrasyon](#7-entegrasyon)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. FUXA Widget Entegrasyonu

### 1.1 FUXA Nedir?

FUXA, acik kaynak kodlu bir SCADA/HMI projesidir. Topluluk tarafindan gelistirilen 1.450'den fazla SVG widget icerir. Bu widget'lar endustriyel kalitede animasyonlu bilesenlerdir: pompalar doner, valfler acilir/kapanir, tanklar dolar/bosalir.

SCADA Builder, FUXA topluluk widget'larini dogrudan icerir cunku:

- Endustriyel standartlarda animasyonlu goruntuler sunarlar
- 6 durumlu (state) animasyon sistemi ile donanimlarin gercek zamanli durumunu yansitirlar
- Degisken baglama (variable binding) ile canli sensor verisiyle surulebilirler
- Her widget kendi icinde calisir, ekstra gelistirme gerektirmez

**Katalog Kategorileri:**

| Kategori | Alt Kategoriler | Widget Sayisi |
|----------|-----------------|---------------|
| Process Engineering | Pumps, Valves, Tanks, Heat Exchangers, Compressors | ~25 |
| Electrical | Logic, Instruments | ~10 |
| Dynamic SVG | Indicators, Controls, Meters | ~12 |
| Basic | Shapes, Flowchart | ~10 |

**Tier Siniflandirmasi:**

- **Tier 1 (Standart):** 18 veya daha az degisken, 6 state. Senkron yuklenir. Ornek: Centrifugal Pump, Gate Valve, Vertical Tank.
- **Tier 2 (Karmasik):** 18'den fazla degisken, ozel JavaScript, gelismis animasyonlar. Lazy yuklenir. Ornek: Control Valve (22 var), VFD (24 var), Mixing Tank (22 var).

### 1.2 FUXA SVG Widget Yukleme

**Adim 1: SVG dosyasi hazirlayin veya indirin**

FUXA widget SVG dosyalari, gommulu `<script>` bloklari icerir. Bu script'ler widget'in animasyon motorunu calistirir. Dosya formati:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <script>
    //!export-start
    var _pn_setState = 0;
    var _pc_color0 = '#808080';
    var _pc_color1 = '#00ff00';
    var _pb_visible = true;
    var _ps_label = 'Pump 1';
    //!export-end

    function putValue(id, value) {
      // FUXA standart degisken guncelleme fonksiyonu
    }
    function postValue(id, value) {
      // FUXA standart kullanici etkilesimi geri bildirim fonksiyonu
    }
  </script>
  <!-- SVG gorsel elemanlari -->
  <circle id="body" cx="100" cy="100" r="80" fill="#808080"/>
  <path id="impeller" d="..." fill="#fff"/>
</svg>
```

Onemli: `//!export-start` ve `//!export-end` isaretcileri arasindaki degiskenler otomatik algilanir.

**Adim 2: Widget Config panelinden yukleyin**

1. SCADA Builder'da sol panelden "FUXA Widget" tipini secin ve canvas'a surukleyin
2. Sag taraftaki Properties panelinde "FUXA SVG File" bolumundeki "Upload FUXA SVG" butonuna tiklayin
3. `.svg` uzantili dosyanizi secin
4. Sistem dosyayi dogrular ve degiskenleri otomatik ayiklar

**Adim 3: Dosya boyutu limiti (1 MB)**

FUXA SVG widget'lari icin maksimum dosya boyutu 1 MB'dir (1.048.576 byte). Tipik FUXA widget'lari 50-300 KB arasindadir. Limit asildigi durumda sistem hata mesaji gosterir:

```
File too large (1250KB). Maximum: 1024KB
```

Buyuk dosyalar icin SVG'yi optimize edin (gereksiz path'leri temizleyin, bkz. Bolum 6.3).

**Adim 4: Script guvenligi -- Sandbox iframe**

FUXA widget'lari icerdikleri `<script>` bloklari nedeniyle guvenlik riski tasiyabilir. Sistem bu riski sunun gibi yonetir:

- SVG dosyasi DOMPurify ile **temizlenmez** (script'ler korunur, cunku widget calismasi icin gereklidir)
- Widget, sandbox niteligi olan bir `<iframe>` icinde renderlanir
- iframe sandbox ayarlari: `allow-scripts` (JavaScript calisir) + **allow-same-origin YOK** (ebeveyn pencereye erisim engellenir)
- Bu sayede FUXA JavaScript'i cookie'lere, localStorage'a veya ana uygulamaya eriselez

### 1.3 FUXA Variable Binding

SVG yuklendikten sonra, dosyanin icindeki `//!export-start` ... `//!export-end` blokunda tanimlanan degiskenler otomatik algilanir ve config panelinde listelenir.

**Degisken Tipleri:**

FUXA, degisken adindaki on-ek ile tip belirler:

| On-ek | Tip | Ornek | Aciklama |
|-------|-----|-------|----------|
| `_pn_` | number | `_pn_setState` | Sayisal deger (sicaklik, hiz, seviye) |
| `_ps_` | string | `_ps_label` | Metin degeri (etiket, isim) |
| `_pb_` | boolean | `_pb_visible` | Mantiksal deger (acik/kapali, gorunur/gizli) |
| `_pc_` | color | `_pc_color0` | Renk degeri (HEX formati: #FF0000) |

**Degisken Gruplari:**

Sistem, degisken adlarindaki anahtar sozcuklere gore otomatik gruplandirma yapar:

| Grup | Anahtar Sozcukler | Amac |
|------|-------------------|------|
| stateColor | `state`, `color` | Durum renkleri ve state index |
| appearance | `opacity`, `visible`, `font` | Gorsel ayarlar |
| transform | `rotate`, `scale`, `translate` | Geometrik donusumler |
| custom | Diger tum degiskenler | Ozel degiskenler |

**Her degiskene sensor tag'i baglama:**

Config panelinde her degiskenin altinda "Bind to tag..." alani bulunur. Buraya sensor tag adi yazarak canli veriyi degiskene baglarsiniz:

1. `_pn_setState` degiskeni icin tag: `pump1.status` (sayi: 0-5 arasi state index)
2. `_pc_color2` degiskeni icin tag: (genellikle tag baglanmaz, sabit renk atanir)
3. `_pn_speed` degiskeni icin tag: `pump1.frequency` (pompa hizi)
4. `_pb_visible` degiskeni icin tag: `pump1.enabled` (true/false)

**Tip uyumlulugu:**

| Degisken Tipi | Uyumlu Tag Veri Tipi | Donusum |
|---------------|----------------------|---------|
| number | FLOAT32, INT16, UINT16 | Dogrudan |
| boolean | BOOL, DI/DO | Dogrudan |
| string | Herhangi | toString() |
| color | - | Genellikle sabit deger, tag baglanmaz |

### 1.4 FUXA State Machine (6 Durumlu Animasyon)

FUXA widget'lari 6 gorsel durum (state 0-5) destekler. Her state, widget'in renk, animasyon ve gorunurluk ozelliklerini kontrol eder.

| State | Anlam | Tipik Renk | Animasyon |
|-------|-------|------------|-----------|
| **State 0** | Kapali / Durdu | Gri (#808080) | Hareketsiz |
| **State 1** | Aciliyor / Basliyor | Sari (#FFD700) | Yavas donme/acilma |
| **State 2** | Calisiyor / Normal | Yesil (#00FF00) | Surekli donme/akis |
| **State 3** | Uyari | Turuncu (#FFA500) | Hizli donme + yanip sonme |
| **State 4** | Alarm / Ariza | Kirmizi (#FF0000) | Yanip sonme (hizli) |
| **State 5** | Bakim / Devre Disi | Mavi (#0000FF) | Hareketsiz, yari saydam |

**Ornek: Pompa widget'i state gecisleri**

```
Motor kapaliyken     -> State 0  (gri, hareketsiz)
Start komutu geldi   -> State 1  (sari, yavas basliyor)
Nominal hiza ulasti  -> State 2  (yesil, surekli donuyor)
Sicaklik yuksek      -> State 3  (turuncu, uyari)
Asiri akim           -> State 4  (kirmizi, alarm)
Bakim modunda        -> State 5  (mavi, devre disi)
```

### 1.5 State Mapping Kurallari

State mapping, sensor tag degerini FUXA state index'ine (0-5) donusturmek icin kural tabanli bir sistem kullanir.

**Kural olusturma arayuzu:**

Config panelinde "State Machine" bolumunde:

1. "Tag Name" alanina state'i surecek tag'i yazin (ornek: `pump1.temperature`)
2. "Add Rule" butonuyla kural ekleyin
3. Her kural icin: kosula, esik degerini ve hedef state'i belirleyin

**Kullanilabilir kosullar:**

| Kosul | Sembol | Aciklama | Ornek |
|-------|--------|----------|-------|
| Less than | `<` | Kucuktur | tag < 10 |
| Less or equal | `<=` | Kucuk veya esit | tag <= 15 |
| Equal | `=` | Esittir | tag = 0 |
| Greater or equal | `>=` | Buyuk veya esit | tag >= 80 |
| Greater than | `>` | Buyuktur | tag > 90 |
| Between | `aralik` | Aralik | 20 <= tag <= 60 |

**Ornek kural seti -- Pompa sicaklik izleme:**

```
Kural 1: tag_value = 0          -> State 0 (Kapali)
Kural 2: tag_value between 1,2  -> State 1 (Basliyor)
Kural 3: tag_value between 3,79 -> State 2 (Normal calisma)
Kural 4: tag_value >= 80        -> State 3 (Uyari)
Kural 5: tag_value >= 95        -> State 4 (Alarm)
Kural 6: tag_value = -1         -> State 5 (Bakim)
```

**Oncelik siralamasi:**

Kurallar yukaridan asagiya sirayla degerlendirilir. Ilk eslesen kural gecerli olur. Bu nedenle:

- **Daha spesifik kurallari uste koyun** (ornek: `= 0` kurali, `>= 0` kuralinin ustunde olmali)
- **Alarm/ariza kurallarini uyari kurallarindan once koyun** (ornek: `>= 95` kurali, `>= 80` kuralinin ustunde olmali)
- Hicbir kural eslesmezse varsayilan state: **0 (Kapali)**

**Coklu kosul (AND/OR):**

Tek bir tag uzerinde birden fazla kural tanimlanabilir. Kurallar sirali olarak degerlendirildigindan, AND mantigi icin "between" kosulunu, OR mantigi icin birden fazla ayri kural kullanin:

```
AND ornegi: tag between 20,60 -> State 2
  (tag >= 20 VE tag <= 60 ise State 2)

OR ornegi:
  Kural A: tag = 0   -> State 0
  Kural B: tag = -1  -> State 0
  (tag = 0 VEYA tag = -1 ise State 0)
```

### 1.6 FUXA Widget Ornekleri

#### Pompa Widget'i

**Katalog ID:** `pe-pump-centrifugal`
**Degisken Sayisi:** 18
**Tier:** 1

Ozellikler:
- 3D golgelendirmeli govde
- Cark (impeller) donme animasyonu
- 6 state icin farkli renkler
- Hiz degiskenine gore donme hizi degisir

Konfigrasyon adimi:
1. FUXA Browser'dan "Centrifugal Pump" secin
2. Tag baglama: `_pn_setState` -> `pump1.status`
3. Tag baglama: `_pn_speed` -> `pump1.frequency`
4. State kurallari ayarlayin (bkz. 1.5)

#### Valf Widget'i

**Katalog ID:** `pe-valve-butterfly`
**Degisken Sayisi:** 18
**Tier:** 1

Ozellikler:
- Disk acisi animasyonu (0-90 derece)
- Acik/kapali pozisyon gostergesi
- Modulating (kademeli) kontrol destegi (Control Valve, Tier 2)

Konfigrasyon:
1. `_pn_setState` -> `valve1.position` (0=kapali, 100=tam acik)
2. State kurali: `= 0` -> State 0, `between 1,99` -> State 2, `= 100` -> State 2

#### Motor Widget'i

**Katalog ID:** `el-inst-motor-starter`
**Degisken Sayisi:** 18
**Tier:** 1

Ozellikler:
- Asiri yuk gostergesi
- Start/stop durumu
- 6 state animasyon

#### Tank Widget'i

**Katalog ID:** `pe-tank-vertical`
**Degisken Sayisi:** 18
**Tier:** 1

Ozellikler:
- Seviye animasyonu (0-100% arasi doluluk)
- Renk degisimi (suyun turune gore)
- Tasma uyarisi

Konfigrasyon:
1. `_pn_setState` -> (genel durum)
2. Seviye degiskeni -> `tank1.level` (0-100 arasi yuzde)

#### Isitici / Sogutucu Widget'i

**Katalog ID:** `pe-hx-shell-tube` veya `pe-hx-plate`
**Degisken Sayisi:** 18
**Tier:** 1

Ozellikler:
- Sicak/soguk akis gostergesi
- Sicaklik degisimi renk gradyani

---

## 2. Proses Akis Diyagramlari (P&ID)

### 2.1 Proses Tasarim Prensipleri

SCADA Builder, ISA-5.1 (Instrumentation Symbols and Identification) standardina uygun proses diyagramlari olusturmanizi saglar.

**Temel kurallar:**

1. **Akis yonu:** Soldan saga, yukaridan asagiya (standart okuma yonu)
2. **Ekipman yerlestirme:** Proses sirasina gore soldan saga dizin
3. **Boru hatlari:** Yatay ve dikey cizgiler kullanin (carpraz cizgilerden kacinin)
4. **Enstrumantasyon:** Olcum noktalari boru hatti uzerinde veya yaninda gosterin
5. **Sinyal hatlari:** Farkli cizgi stilleri ile proses borularindan ayristi

**ISA-5.1 Sembol Referansi:**

```
Pompa:              (O)>     (daire + ok)
Valf:               >|<      (kelebek)
Tank:               [___]    (dikdortgen)
Isitici:            <<<      (zigzag)
Filtre:             |//|     (capraz cizgili)
UV Sistemi:         |UV|     (etiketli kutu)
Sensor/Transmitter:  (TT)    (daire icinde harf ciftleri)
```

### 2.2 Boru Hatti Cizimi

SCADA Builder'da uc edge (baglanti) tipi mevcuttur:

| Tip | Aciklama | Kullanim Alani |
|-----|----------|----------------|
| **Orthogonal** | 90 derece acili yonlendirme | P&ID standart boru hatlari |
| **MultiHandle** | Cok noktali serbest bezier | Karmasik rotalar |
| **Draggable** | Tek/cift kontrol noktali bezier | Estetik egri hatlar |

**Endustriyel P&ID diyagramlarinda Orthogonal Edge tercih edilmelidir** cunku ISA-5.1 standardi boru hatlarinin yatay ve dikey cizgilerle gosterilmesini oner.

**Boru renk kodlamasi (connectionType):**

| Baglanti Tipi | Renk | Kalinlik | Cizgi Stili | Kullanim |
|---------------|------|----------|-------------|----------|
| `process-pipe` | Gri-siyah (#1f2937) | 3px | Duz | Ana proses borusu (su, hava) |
| `electrical` | Kirmizi (#dc2626) | 2px | Kesikli (8,4) | Elektrik sinyali (4-20mA) |
| `pneumatic` | Mavi (#2563eb) | 2px | Cift isaretli (12,3,3,3) | Pnomatik/hava sinyali |
| `hydraulic` | Yesil (#16a34a) | 2px | Uzun-kisa kesikli | Hidrolik hatti |
| `instrument` | Turuncu (#ea580c) | 2px | Cizgi-nokta (8,3,2,3) | Sensor/kontrol sinyali |
| `data-link` | Mor (#7c3aed) | 2px | Noktali (2,4) | Dijital veri/haberlesme |
| `capillary` | Gri (#6b7280) | 1px | Duz (ince) | Kapiler baglanti |
| `steam` | Turuncu (#f97316) | 3px | Kisa kesikli (6,2) | Buhar hatti |
| `drain-vent` | Camgobegi (#0891b2) | 2px | Nokta-kesik (4,4,1,4) | Drenaj/havalandirma |

**Aquaculture icin onerilen renk kodlari:**

| Hatti Tipi | Onerilen connectionType | Aciklama |
|------------|------------------------|----------|
| Temiz su (giris) | `process-pipe` | Siyah, 3px, duz |
| Kirli su (cikis) | `drain-vent` | Camgobegi, 2px |
| Islenms su (dongusel) | `hydraulic` | Yesil, 2px |
| Acil hat | `steam` | Turuncu, 3px |
| Kimyasal dozajlama | `capillary` | Gri, 1px |
| Hava/oksijenasyon | `pneumatic` | Mavi, 2px |

**Boru kalinligi genel kurali:**
- Ana hat: 3px (`process-pipe`, `steam`)
- Tali hat: 2px (`electrical`, `instrument`, `hydraulic`)
- Bypass / ince hat: 1px (`capillary`)

### 2.3 Akis Animasyonu Detaylari

SCADA Builder, boru hatlarindaki sivi/gaz akisini canli animasyonlarla gosterir. Bu animasyon `useEdgeFlowState` hook'u tarafindan yonetilir.

**Mimari:**

```
Tag Value Bus                useEdgeFlowState              Edge Renderer
(canli sensor verisi)  --->  (kosul degerlendirme)  --->  (animasyon kontrolu)
                               |                            |
                               v                            v
                          { isFlowing,                CSS animation:
                            speed,                   edge-flow Xs linear
                            direction }              infinite [normal|reverse]
```

**EdgeFlowConfig yapisi:**

```typescript
interface EdgeFlowConfig {
  tagName?: string;           // Animasyonu suren tag adi
  flowCondition: 'nonZero'    // val > 0 ise akis var
                | 'boolean'   // truthy ise akis var (1, true, "on")
                | 'always';   // her zaman animate (geriye uyumluluk)
  flowSpeed?: number;         // Animasyon suresi (saniye, dusuk = hizli)
  reverseOnNegative?: boolean; // Negatif degerde akis yonu ters
}
```

**Akis hizini sensor verisine baglama:**

1. Edge'i secin (boru hatti)
2. Properties panelinde "Flow Config" bolumunu acin
3. "Tag Name" alanina akisi kontrol eden tag'i yazin: `pump1.running`
4. "Flow Condition" secin:
   - `boolean`: Pompa calisiyorsa akis goster (DI tag'lari icin ideal)
   - `nonZero`: Debi > 0 ise akis goster (AI tag'lari icin ideal)
   - `always`: Her zaman animate (test/demo icin)
5. "Flow Speed" ayarlayin: 0.5s (hizli) ... 5s (yavas)

**Akis yonunu kontrol etme:**

- **Normal (forward):** Source'tan target'a dogru akis animasyonu
- **Ters (reverse):** `reverseOnNegative: true` ayarlandiginda, tag degeri negatif olursa akis yonu tersine doner
- Ornek: cift yonlu pompa -- pozitif degerde ileri, negatif degerde geri akis

**Animasyon performansi optimizasyonu:**

- Her edge bagimsiz CSS animasyonu kullanir (`animation: edge-flow Xs linear infinite`)
- Animasyon yalnizca `isFlowing = true` oldugunda aktiftir
- Tag bus aboneligi `useEffect` ile yonetilir, component unmount'ta otomatik temizlenir
- Gorunmeyen edge'ler icin animasyon otomatik olarak duraklatilir

**Kesikli akis (pulsed flow) -- Dozajlama sistemleri icin:**

Dozajlama hatlari surekli degil, aralikli akis gostermelidir. Bunu saglamak icin:

1. `flowSpeed` degerini yuksek tutun (4-5 saniye)
2. `strokeDasharray` olarak buyuk aralikli desen secin
3. Veya dozajlama pompasinin on/off tag'ini `boolean` kosulu ile baglayin -- pompa caslisirken akis gosterilir, durgunken durur

### 2.4 Proses Ekipman Konfigurasyonu

**Equipment widget detayli konfigurasyonu:**

Her equipment widget'i su ozelliklere sahiptir:

| Ozellik | Aciklama | Varsayilan |
|---------|----------|------------|
| `equipmentId` | Gercek ekipman baglantisi (UUID) | null (sablion) |
| `equipmentName` | Ekipman adi | - |
| `equipmentCode` | Ekipman kodu | - |
| `icon` | Gorsel ikon adi | Kategoriye gore |
| `connectionPoints` | Baglanti noktalari (top/right/bottom/left) | top:input, right:output |
| `edgeDeviceId` | Edge device baglantisi | null |
| `ioBindings` | I/O tag baglantilari | [] |
| `sensorMappings` | Sensor eslemeleri | [] |

**Ikon kutuphanesi:**

SCADA Builder, 50'den fazla endustriyel ikon icerir:
- Pompalar: santrifuj, dislili, diyafram, dalgicc
- Valfler: kelebek, kure, gate, kontrol, cekme
- Tanklar: dikey, yatay, konik, mikser
- Filtreler: drum, bio, kum, UV
- Isiticilar: shell-tube, plate, hava sogutucu
- Elektrik: motor, VFD, sigorta, kontaktor

**Ozel ikon yukleme:**

Standart kutuphanede bulunmayan ekipmanlar icin ozel SVG ikon yuklenebilir. Ikon SVG'si 64x64 viewport boyutunda olmali ve basit path'lerden olusmalidir.

**Durum renk eslestirmesi:**

Equipment widget'larinin durum renkleri:

| Durum | Kenar Rengi | Arka Plan |
|-------|-------------|-----------|
| Normal / Active | Yesil | Acik yesil |
| Uyari | Turuncu | Acik turuncu |
| Alarm | Kirmizi | Acik kirmizi |
| Bakim | Mavi | Acik mavi |
| Devre Disi | Gri | Acik gri |

---

## 3. Ornek SCADA Ekranlari (Aquaculture)

### 3.1 RAS (Recirculating Aquaculture System) Ana Ekran

```
+====================================================================+
|  [!] ALARM BANNER -- Aktif alarmlar burada gosterilir              |
+====================================================================+
|                                                                     |
|  [BALIK       ]                                                     |
|  [TANKI 1     ] ---(O)>--- [POMPA 1] ---> [DRUM FILTER]            |
|  [Seviye: 85% ]                                |                    |
|       |                                        |                    |
|       |    [AERATOR] <------- [BIO FILTER (MBBR)]                   |
|       |       |                    |                                |
|       |       v                    |                                |
|       +--- [UV SYSTEM] <--- (O)>- [POMPA 2]                        |
|                                                                     |
|  +------------------+  +------------------+  +-----------------+    |
|  | Sicaklik         |  | Cozunmus Oksijen |  | pH              |    |
|  |     22.5 C       |  |     7.8 mg/L     |  |     7.2         |    |
|  | [====>    ] 0-40  |  | [======>  ] 0-15 |  | [=====>  ] 4-10 |    |
|  +------------------+  +------------------+  +-----------------+    |
|                                                                     |
|  +--------------------------------------------------------------+  |
|  | TREND CHART -- Son 24 saat                                    |  |
|  |  ^                                                            |  |
|  |  |  ___/\___    Sicaklik (mavi)                               |  |
|  |  | /        \_  DO (yesil)                                    |  |
|  |  |/    ____   \ pH (turuncu)                                  |  |
|  |  +----+----+----+----+----+----+-> t                          |  |
|  |  00:00  04:00  08:00  12:00  16:00  20:00                    |  |
|  +--------------------------------------------------------------+  |
+====================================================================+
```

**Bu ekrani adim adim olusturma:**

1. **Canvas boyutu:** 1920x1080 piksel (Full HD). Ayarlar > Canvas Size > 1920x1080

2. **Alarm Banner widget'i ekleyin:** Canvas'in en ustune, tam genislikte bir Alarm Banner widget'i yerleystirin. Yukseklik: 40px. Tag: `system.activeAlarms`

3. **Tank Level widget'lari ekleyin:**
   - Widget: Vertical Tank (FUXA `pe-tank-vertical` veya yerlesik tank widget'i)
   - Konum: Sol ust kose (x:50, y:80)
   - Tag baglama: `tank1.level` -> seviye degiskeni
   - Boyut: 120x160px
   - Label: "Balik Tanki 1"

4. **Equipment widget'lari ekleyin:**
   - Pompa 1: Equipment widget (ikon: centrifugal-pump), konum: (250, 120)
   - Drum Filter: Equipment widget (ikon: drum-filter), konum: (500, 120)
   - Bio Filter: Equipment widget (ikon: bio-reactor), konum: (500, 280)
   - Aerator: Equipment widget (ikon: blower), konum: (250, 280)
   - UV System: Equipment widget (ikon: uv-unit), konum: (250, 400)
   - Pompa 2: Equipment widget (ikon: centrifugal-pump), konum: (500, 400)

5. **Orthogonal Edge ile boru hatlari cizin:**
   - Tank 1 (output) -> Pompa 1 (input): connectionType = `process-pipe`
   - Pompa 1 (output) -> Drum Filter (input): connectionType = `process-pipe`
   - Drum Filter (output) -> Bio Filter (input): connectionType = `process-pipe`
   - Bio Filter (output) -> Aerator (input): connectionType = `pneumatic`
   - Bio Filter (output-2) -> Pompa 2 (input): connectionType = `process-pipe`
   - Pompa 2 (output) -> UV System (input): connectionType = `process-pipe`
   - UV System (output) -> Tank 1 (input): connectionType = `process-pipe`

6. **Akis animasyonu ayarlayin:**
   - Her boru hatti icin `flowConfig` tanimlayin:
     ```
     Pompa 1 cikisi:  tagName: "pump1.running",  flowCondition: "boolean"
     Pompa 2 cikisi:  tagName: "pump2.running",  flowCondition: "boolean"
     Aerator hatti:   tagName: "aerator.running", flowCondition: "boolean"
     ```
   - Speed: 2s (normal akis), 1s (yuksek debi)

7. **Gauge widget'lari ekleyin (alt kisim):**
   - Sicaklik Gauge: tag = `sensor.temperature`, min=0, max=40, unit="C"
   - DO Gauge: tag = `sensor.dissolvedOxygen`, min=0, max=15, unit="mg/L"
   - pH Gauge: tag = `sensor.pH`, min=4, max=10, unit=""

8. **Trend Chart widget'i ekleyin:**
   - Konum: Alt kisim, tam genislik
   - Veri kaynaklari: 3 tag (sicaklik, DO, pH)
   - Zaman araligi: 24 saat
   - Renk kodlari: Sicaklik=mavi, DO=yesil, pH=turuncu

9. **Tag binding'leri tamamlayin:**
   - Her equipment widget'ina ilgili edge device ve I/O tag'larini baglayin
   - Her gauge'a ilgili sensor tag'ini baglayin
   - Alarm Banner'a aktif alarm tag'ini baglayin

10. **Alarm esikleri ayarlayin:**
    - Sicaklik: uyari > 28C, alarm > 32C, dusuk uyari < 18C
    - DO: uyari < 5 mg/L, alarm < 3 mg/L
    - pH: uyari < 6.5 veya > 8.5, alarm < 6.0 veya > 9.0

### 3.2 Pompa Istasyonu Detay Ekrani

```
+====================================================================+
|  POMPA ISTASYONU -- Pompa #1 (Danfoss FC302)                        |
+====================================================================+
|                                                                     |
|  +---VFD KONTROL PANELI-----------+  +--CANLI DEGERLER-----------+ |
|  |                                 |  |                           | |
|  |  Frekans        Akim           |  |  Frekans:   42.5 Hz       | |
|  |  [=====>  ]     [===>   ]      |  |  Akim:      12.3 A        | |
|  |   42.5 Hz        12.3 A       |  |  Tork:      85.2 %        | |
|  |                                 |  |  Guc:       4.2 kW        | |
|  |  Tork           Guc            |  |  Devir:     1425 RPM      | |
|  |  [======> ]     [====>  ]      |  |  Sicaklik:  45.3 C        | |
|  |   85.2 %         4.2 kW       |  |  DC Bus:    562 V          | |
|  |                                 |  |                           | |
|  +---------------------------------+  +---------------------------+ |
|                                                                     |
|  +---KONTROL---------------------+  +--SAYACLAR-----------------+ |
|  |                                |  |                           | |
|  |  [START]  [STOP]  [RESET]     |  |  Calisma Suresi:          | |
|  |                                |  |    12,456 saat            | |
|  |  Frekans Ayari:               |  |                           | |
|  |  0 |=====[|||]=====>| 50 Hz   |  |  Enerji Tuketimi:         | |
|  |          37.5 Hz               |  |    45,230 kWh             | |
|  |                                |  |                           | |
|  |  Hiz Modu:  [Sabit Hiz v]     |  |  Start Sayisi: 1,234      | |
|  |                                |  |                           | |
|  +---------------------------------+  +---------------------------+ |
|                                                                     |
|  +---VFD PROGRAMMER WIDGET---------------------------------------+ |
|  |  Parametre Gruplari: Ramp | Freq | Motor | PID | Koruma       | |
|  |                                                                | |
|  |  Accel T1:  10.00s  ->  [5.0 ]   Risk: MEDIUM                | |
|  |  Decel T1:  10.00s  ->  [8.0 ]   Risk: MEDIUM                | |
|  |  Max Freq:  50.0Hz  ->  -----    Risk: CRITICAL              | |
|  |                                                                | |
|  |  [2 parametre degisti]  [Onay icin Gonder]  [Taslak Kaydet]   | |
|  +----------------------------------------------------------------+ |
|                                                                     |
|  +---ARIZA GECMISI----------------------------------------------+  |
|  |  Tarih       | Kod  | Aciklama        | Sure   | Durum       |  |
|  |  2026-03-25  | F03  | Asiri akim      | 2.3s   | Cozuldu     |  |
|  |  2026-03-20  | F05  | Asiri sicaklik  | 5.1s   | Cozuldu     |  |
|  |  2026-03-15  | F01  | Dusuk gerilim   | 0.8s   | Cozuldu     |  |
|  +---------------------------------------------------------------+  |
+====================================================================+
```

**VFD Kontrol Paneli Icerigi:**

- 4 adet dairesel gauge: Frekans (0-50Hz), Akim (0-25A), Tork (0-100%), Guc (0-11kW)
- Her gauge'da uyari ve alarm bolgesi (sari/kirmizi)
- Start/Stop butonlari: `DO` tag'i uzerinden VFD kontrol komutu gonderir
- Frekans slider'i: `AO` tag'i uzerinden frekans referansi ayarlar

**VFD Programmer Widget Entegrasyonu** (bkz. Bolum 7.1)

### 3.3 Su Kalitesi Izleme Ekrani

```
+====================================================================+
|  SU KALITESI IZLEME -- Tank Grubu A                                 |
+====================================================================+
|                                                                     |
|  +------+  +------+  +------+  +------+  +------+                  |
|  |  pH  |  |  DO  |  | Sic. |  | Tuz  |  | Turb |                  |
|  |      |  |      |  |      |  |      |  |      |                  |
|  | 7.2  |  | 7.8  |  | 22.5 |  | 18.3 |  | 2.1  |                  |
|  |      |  |mg/L  |  |  C   |  | ppt  |  | NTU  |                  |
|  | [OK] |  | [OK] |  | [OK] |  | [OK] |  |[WARN]|                  |
|  +------+  +------+  +------+  +------+  +------+                  |
|                                                                     |
|  +---TREND CHART (7 GUN)----------------------------------------+  |
|  |  ^                                                            |  |
|  |  |     ___                                                    |  |
|  |  |    /   \___/\___     pH                                    |  |
|  |  |  _/              \   DO                                    |  |
|  |  | /   ____    ___    \ Sicaklik                              |  |
|  |  |/   /    \__/   \    \                                      |  |
|  |  +----+----+----+----+----+----+-----> gun                    |  |
|  |  Pzt   Sal   Car   Per   Cum   Cts   Paz                     |  |
|  +---------------------------------------------------------------+  |
|                                                                     |
|  +---ALARM ESIKLERI---------+  +--DOZAJLAMA KONTROLLERI---------+  |
|  |                           |  |                                |  |
|  |  pH:   6.5-8.5 (warn)    |  |  Kirecc Dozajlama:             |  |
|  |        6.0-9.0 (alarm)   |  |  [OTOMATIK v]  pH > 8.0        |  |
|  |  DO:   > 5.0   (warn)    |  |  Doz: 2.5 mL/L                 |  |
|  |        > 3.0   (alarm)   |  |                                |  |
|  |  Sic:  18-28   (warn)    |  |  Klor Dozajlama:               |  |
|  |        15-32   (alarm)   |  |  [MANUEL v]  Durum: DURDU      |  |
|  |  Turb: < 5.0   (warn)    |  |  Doz: 0.5 mg/L                 |  |
|  |        < 10.0  (alarm)   |  |                                |  |
|  +---------------------------+  +--------------------------------+  |
+====================================================================+
```

**Olusturma adimlari:**

1. 5 adet radial gauge widget'i ekleyin (ust satir)
2. Her gauge'a ilgili sensor tag'ini baglayin
3. Alarm bolgelerini ayarlayin (warn: sari, alarm: kirmizi)
4. Trend Chart widget'i: 7 gunluk veri, 3 veya 5 parametre
5. Alarm esikleri tablosu: statik metin widget'i veya tablo widget'i
6. Dozajlama kontrolleri: toggle switch + numerik input + durum LED'i

### 3.4 Besleme (Feeding) Sistemi Ekrani

```
+====================================================================+
|  BESLEME SISTEMI -- Otomatik Yem Dagitim                            |
+====================================================================+
|                                                                     |
|  +--SILO 1---+  +--SILO 2---+  +--SILO 3---+                      |
|  |  ########  |  |  ######   |  |  ####     |                      |
|  |  ########  |  |  ######   |  |  ####     |                      |
|  |  ########  |  |  ######   |  |           |                      |
|  |  ########  |  |           |  |           |                      |
|  |  85%       |  |  62%      |  |  35%      |                      |
|  |  2mm Pellet|  |  3mm Pellet|  |  5mm Pellet|                     |
|  +------|-----+  +------|-----+  +------|-----+                     |
|         |               |               |                           |
|         v               v               v                           |
|  +--DAGITIM HATTI (konveyor)---->---->---->-+                       |
|  |  ====>====>====>====>====>====>====>===> |                       |
|  +-----|---------|---------|---------|-------+                       |
|        v         v         v         v                              |
|  [Tank A1]  [Tank A2]  [Tank B1]  [Tank B2]                        |
|                                                                     |
|  +---BESLEME PROGRAMI-------------------------------------------+  |
|  |  Saat  | Tank | Miktar | Silo | Durum                        |  |
|  |  06:00 | A1   | 2.5 kg | S1   | Tamamlandi                  |  |
|  |  06:30 | A2   | 3.0 kg | S1   | Tamamlandi                  |  |
|  |  12:00 | A1   | 2.5 kg | S2   | Bekliyor                    |  |
|  |  12:30 | B1   | 4.0 kg | S3   | Bekliyor                    |  |
|  +---------------------------------------------------------------+  |
|                                                                     |
|  +---ISTATISTIKLER---+  +---GUNLUK TUKETIM---------+               |
|  | Bugun:   12.5 kg   |  |  A1: 5.0 kg  [====     ]|               |
|  | Haftalik: 87.3 kg  |  |  A2: 6.0 kg  [=====>   ]|               |
|  | Stok:     450 kg   |  |  B1: 4.0 kg  [===>     ]|               |
|  +--------------------+  |  B2: 3.5 kg  [==>      ]|               |
|                           +-------------------------+               |
+====================================================================+
```

### 3.5 Enerji Izleme Ekrani

```
+====================================================================+
|  ENERJI IZLEME -- Tesis Genel                                      |
+====================================================================+
|                                                                     |
|  +---VFD ENERJI TUKETIMI (bar chart)-----------------------------+ |
|  |  kWh                                                          | |
|  |  ^                                                            | |
|  |  |  ###                                                       | |
|  | 8|  ###  ###                                                  | |
|  | 6|  ###  ###  ###                                             | |
|  | 4|  ###  ###  ###  ###        ###                             | |
|  | 2|  ###  ###  ###  ###  ###  ###  ###                         | |
|  |  +----+----+----+----+----+----+-----> Ekipman                | |
|  |  P1    P2   P3   Aer  UV   Fil  Doz                          | |
|  +---------------------------------------------------------------+ |
|                                                                     |
|  +--TOPLAM kWh--------+  +--GUC FAKTORU---+  +--MALIYET--------+ |
|  |                     |  |                |  |                  | |
|  |  Bugun:   245 kWh   |  |  PF: 0.92      |  |  Bugun:  245 TL | |
|  |  Hafta: 1,680 kWh   |  |  [=======> ]   |  |  Ay:   7,450 TL | |
|  |  Ay:    7,450 kWh   |  |  Hedef: 0.95   |  |  TL/kWh: 1.00   | |
|  |                     |  |                |  |                  | |
|  +---------------------+  +----------------+  +------------------+ |
|                                                                     |
|  +---SAAT BAZLI TUKETIM TRENDI----------------------------------+  |
|  |  kW  ^                                                       |  |
|  |      |    ___                                                |  |
|  | 15   |   /   \          ___                                  |  |
|  | 10   |  /     \___/\  /   \___                               |  |
|  |  5   | /              \/       \___                          |  |
|  |      +----+----+----+----+----+-----> saat                   |  |
|  |       00   04   08   12   16   20                            |  |
|  +--------------------------------------------------------------+  |
+====================================================================+
```

---

## 4. Gelismis Animasyon Teknikleri

### 4.1 Kosullu Animasyon

FUXA widget'larinda kosullu animasyon, state rule'lar ve degisken baglama kombinasyonu ile gerceklestirilir.

**if-then-else mantigi:**

State rule'larin sirali degerlendirme mekanizmasi, pratik olarak if-then-else mantigi saglar:

```
Kural 1 (if):   tag >= 95   -> State 4 (Alarm)
Kural 2 (elif): tag >= 80   -> State 3 (Uyari)
Kural 3 (elif): tag >= 1    -> State 2 (Normal)
Kural 4 (else): tag = 0     -> State 0 (Kapali)
```

Ilk eslesen kural gecerli oldugu icin siralama onemlidir. Yukaridaki ornekte `tag = 90` degeri Kural 2'ye duser (State 3), cunku Kural 1'e uymaz ama Kural 2'ye uyar.

**Coklu kosul zincirleme:**

Birden fazla sensor degerine dayanarak state belirlemek icin, backend'de hesaplanan bir bilesik tag kullanin:

```
Backend tarafinda:
  composite_status = if (temp > 30 AND pressure > 3) then 4
                     elif (temp > 25 OR pressure > 2.5) then 3
                     else 2

SCADA tarafinda:
  tagName: "device.composite_status"
  Kural: tag = 4 -> State 4, tag = 3 -> State 3, tag = 2 -> State 2
```

### 4.2 Matematiksel Donusumler

**Lineer olcekleme:**

Sensor degerini gorsel ozellige donusturme:

```
Deger: 0-100% -> Dondurme: 0-360 derece

Formul: rotation = (value / 100) * 360

FUXA'da:
  _pn_rotate degiskenine sensor tag'i bagla
  SVG icindeki script, scale faktorunu uygular
```

**Renk gradyani (sicaklik -> mavi-kirmizi):**

```
FUXA degiskenleri:
  _pc_color0 = '#0000FF'   (soguk - mavi, State 0)
  _pc_color1 = '#00FF00'   (normal - yesil, State 2)
  _pc_color2 = '#FFFF00'   (ilik - sari, State 3)
  _pc_color3 = '#FF0000'   (sicak - kirmizi, State 4)

State kurallari:
  temp < 15   -> State 0 (mavi)
  temp 15-25  -> State 2 (yesil)
  temp 25-30  -> State 3 (sari)
  temp > 30   -> State 4 (kirmizi)
```

**Logaritmik olcekleme:**

Genis aralikli degerler (ornek: basinc 0.1 - 100 bar) icin logaritmik olcekleme daha iyi gorsel sonuc verir. Bu donusum genellikle backend'deki tag isleme katmaninda uygulanir.

### 4.3 Yanip Sonme ve Titresim

**Alarm durumunda yanip sonme:**

FUXA widget'lari State 4 (Alarm) gecisinde otomatik yanip sonme animasyonu icerirler. Ek olarak, SVG ici `<animate>` elemanlarini yapildandirabilirsiniz:

```xml
<!-- Hizli yanip sonme (0.5 saniye aralikli) -->
<animate attributeName="opacity"
         values="1;0.2;1"
         dur="0.5s"
         repeatCount="indefinite"/>

<!-- Yavas yanip sonme (1.5 saniye aralikli) -->
<animate attributeName="opacity"
         values="1;0.3;1"
         dur="1.5s"
         repeatCount="indefinite"/>
```

**Frekans ayari:**

| Durum | Yanip Sonme Suresi | Kullanim |
|-------|-------------------|----------|
| Kritik Alarm | 0.3s | Acil mudahale gereken durumlar |
| Alarm | 0.5s | Hizli dikkat cekme |
| Uyari | 1.0s | Orta oncelik |
| Bilgi | 2.0s | Dusuk oncelik |

**Renk degisimi ile yanip sonme:**

```xml
<!-- Kirmizi-sari arasi gecis (yangin alarm efekti) -->
<animate attributeName="fill"
         values="#FF0000;#FFAA00;#FF0000"
         dur="0.8s"
         repeatCount="indefinite"/>
```

### 4.4 SVG Path Animasyonu

**SVG yolu uzerinde hareket:**

Edge (boru hatti) uzerindeki akis gostergesi, `getPointOnPolyline` fonksiyonu ile hesaplanir. Bu fonksiyon, polyline uzerinde verilen bir kesirde (0-1) konum ve teget acisini dondurur:

```
Giris: points = [{x:0,y:0}, {x:100,y:0}, {x:100,y:100}], fraction = 0.5
Cikis: {x:100, y:0, angle:0}  (ortogonal kenarlar icin 50% noktasi)
```

**Akis gostergesi (chevron):**

OrthogonalEdge ve DraggableEdge, akis aktif oldugunda borunun %50 noktasinda animasyonlu bir ok (chevron) gosterir:

```xml
<polygon points="-7,-5 0,0 -7,5"
         fill="#374151"
         transform="translate(midX,midY) rotate(angle)">
  <animate attributeName="opacity"
           values="1;0.2;1"
           dur="1.5s"
           repeatCount="indefinite"/>
</polygon>
```

Bu ok, akisin yonunu gosterir ve solarak yanip soner.

### 4.5 Tooltip ve Popup

**Widget uzerine gelince detay gosterme:**

Equipment widget'larinda fare uzerine geldiginde tooltip gosterilir:

```
+----------------------------+
| Pompa #1                   |
| Durum: Calisiyor           |
| Frekans: 42.5 Hz           |
| Akim: 12.3 A               |
| Son Guncelleme: 14:32:05   |
+----------------------------+
```

**Click ile popup acma:**

Equipment widget'ina tiklandiginda Properties paneli acilir. Bu panel, detayli konfigrasyon secenekleri sunar:

1. Ekipman bilgileri (ad, kod, tip)
2. Edge device baglantisi
3. I/O tag baglantilari (DI, DO, AI, AO)
4. Sensor eslemeleri
5. Alarm esikleri

**Popup icinde alt widget'lar:**

SCADA ekraninda bir ekipmana tiklandiginda ayri bir detay ekranina gecis saglanabilir (bkz. Bolum 5 -- Screen Link).

---

## 5. Multi-Screen Proje Yonetimi

### 5.1 Ekran Hiyerarsisi

Buyuk tesisler birden fazla SCADA ekrani gerektirir. Onerilen hiyerarsi:

```
Seviye 0: Tesis Genel Gorunum (Overview)
  |
  +-- Seviye 1: Bolum Ekranlari
  |     +-- RAS Ana Ekran
  |     +-- Su Kalitesi
  |     +-- Enerji Izleme
  |     +-- Besleme Sistemi
  |
  +-- Seviye 2: Detay Ekranlari
        +-- Pompa Istasyonu #1 Detay
        +-- Pompa Istasyonu #2 Detay
        +-- Filtre Detay
        +-- VFD Programlama
```

**Navigasyon haritasi:**

Ana ekranda (Seviye 0) her bolum icin tiklanabilir alanlar tanimllanir. Tiklandiginda ilgili Seviye 1 ekranina gecis saglanir.

### 5.2 Screen Link Stratejileri

**Ana ekrandan detay ekranina gecis:**

1. Equipment widget'ina tikladiginizda "Detay Ekranina Git" butonu gosterilir
2. Bu buton, ilgili detay ekraninin ID'sine link eder
3. Gecis animasyonlu (fade-in) gerceklesir

**Geri donus butonu:**

Her detay ekraninin sol ust kosesinde "< Geri" butonu bulunur. Bu buton, bir onceki ekrana doner.

**Favori ekranlar:**

Operatorler sik kullandiklari ekranlari favori olarak isaretleyebilir. Favoriler, ust navigasyon cubugunda hizli erisim butonlari olarak gosterilir.

### 5.3 SCADA Paket Disa / Ice Aktarma

**JSON formati:**

SCADA projeleri, tum ekranlar, widget konfigurasyonlari ve edge baglantilariyla birlikte JSON formatinda disari aktarilabilir:

```json
{
  "version": "2.0",
  "screens": [
    {
      "id": "screen-001",
      "name": "RAS Ana Ekran",
      "canvasSize": { "width": 1920, "height": 1080 },
      "nodes": [ ... ],
      "edges": [ ... ]
    }
  ],
  "metadata": {
    "exportedAt": "2026-03-26T14:30:00Z",
    "exportedBy": "okan@aqua.com",
    "platform": "aquaculture-platform"
  }
}
```

**Versiyon uyumlulugu:**

- v1.x paketleri v2.x'e otomatik donusturulur (connectionType normalizasyonu)
- Eski `pipe` -> yeni `process-pipe`, eski `cable` -> yeni `electrical`
- FUXA widget'lari icin SVG content paketin icinde saklanir

**Farkli tesislere deploy:**

1. Kaynak tesiste "Disa Aktar" ile JSON dosyasi olusturun
2. Hedef tesiste "Ice Aktar" ile JSON dosyasini yukleyin
3. Tag baglantilari bos gelir -- hedef tesisin tag'larini yeniden baglayin
4. Equipment link'leri kopmus olur -- hedef tesisin ekipmanlarini yeniden baglayin

---

## 6. Performans Optimizasyonu

### 6.1 Widget Sayisi Limitleri

| Ekran Basina Widget | Performans | Oneri |
|---------------------|------------|-------|
| 1-30 | Mukemmel | Ideal aralik |
| 31-50 | Iyi | Onerilen maksimum |
| 51-80 | Orta | Yavaslamalar baslayabilir |
| 80+ | Dusuk | Ekrani bolun |

**Buyuk ekranlari bolme stratejisi:**

Eger bir ekranda 50'den fazla widget gerekiyorsa:

1. Ekrani mantiksal bolgelere ayirin (ornek: sol yari + sag yari)
2. Her bolge icin ayri bir ekran olusturun
3. Ana ekranda (overview) bolgeleri temsil eden tiklanabilir alanlar ekleyin
4. Detay ekranlarina gecis icin link tanimlayin

### 6.2 Polling Optimizasyonu

Farkli widget tipleri farkli guncelleme sikliklarina ihtiyac duyar:

| Widget Tipi | Onerilen Polling Araligi | Gerekce |
|-------------|-------------------------|---------|
| Alarm Banner | 500ms | Kritik -- aninda fark edilmeli |
| Pompa / Valf durumu | 1s | Operasyonel -- hizli tepki |
| Gauge (sicaklik, pH) | 2-3s | Olcum -- anlik degisim yok |
| Trend Chart | 5-10s | Gorselestirme -- parca parca yuklenir |
| Enerji sayaclari | 30-60s | Toplam -- yavas degisir |
| Stok seviyeleri | 60s | Envanter -- nadiren degisir |

**Gorunmeyen widget'lari duraklatma:**

SCADA Builder, ekranda goruntulenmeen (scroll disinda kalan veya baska ekrandaki) widget'lar icin tag aboneliklerini otomatik duraklatir. Bu, gereksiz ag trafigini onler.

### 6.3 SVG Optimizasyonu

**Dosya boyutu kucultme:**

1. Gereksiz metadata'yi kaldirin (Adobe/Inkscape eklentileri)
2. Ondalik hassasiyeti azaltin (6 basamak yerine 2)
3. Kullanilmayan gradient ve filter tanimlarini silin
4. Path'leri birlestirin (SVGO araci ile)

**SVGO ile optimize etme:**

```bash
npx svgo widget.svg -o widget-optimized.svg --config='{"plugins":["removeDoctype","removeComments","removeMetadata","removeEditorsNSData","cleanupEnableBackground"]}'
```

Onemli: FUXA widget'larinda `<script>` bloklarini korumak icin `removeScriptElement` eklentisini **devre disi birakin**.

**FUXA widget boyut limiti:** 1 MB (1.048.576 byte)

Tipik boyutlar:
- Basit widget (LED, buton): 10-30 KB
- Orta widget (pompa, valf): 50-150 KB
- Karmasik widget (VFD, mikser): 150-300 KB
- Asinlan limit: 300+ KB (optimize etmeyi deneyin)

---

## 7. Entegrasyon

### 7.1 VFD Programmer Widget Entegrasyonu

VFD Programmer widget'i, SCADA ekranindan dogrudan VFD parametre programlamasina olanak tanir.

**SCADA ekranina VFD programlama ekleme:**

1. Widget paletinden "VFD Programmer" widget'ini secin
2. Canvas'a surukleyin (onerilen boyut: 600x400px)
3. Properties panelinde:
   - VFD Device: listeden ilgili VFD cihazini secin
   - Visible Groups: gorunecek parametre gruplarini isaretleyin (Ramp, Freq, Motor, PID, Koruma)
   - Compact Mode: acik ise yalnizca sik kullanilan parametreler gosterilir
   - Allow Create Change Set: operatorun degisiklik yapmasina izin ver

**Compact kart vs tam panel:**

| Mod | Boyut | Icerik |
|-----|-------|--------|
| Compact | 300x200px | VFD adi + durum + anahtar parametreler (salt okunur) |
| Tam Panel | 600x400px | Parametre tablosu + degisiklik seti + audit log |

- Compact modda kart uzerine tiklandiginda tam panel slide-over olarak acilir

**Parametre goruntuyleme:**

Widget, bagli VFD cihazindan canli parametre degerlerini okur ve gosterir:

```
+--VFD Programmer (Compact)--+
| Pompa #1 -- FC302          |
| Durum: CALISIYOR           |
|                            |
| Accel T1:  10.00s          |
| Decel T1:  10.00s          |
| Max Freq:  50.00Hz         |
|                            |
| [Bekleyen: 1] [Detay ->]  |
+----------------------------+
```

**Change set olusturma akisi:**

1. Parametreyi degistirmek icin "New Value" sutununa yeni degeri girin
2. Degisiklik aciklamasini yazin
3. "Onay icin Gonder" butonuna tiklayin
4. Sistem, change set'i `pending_approval` durumuna gecirerek yetkili kisinin onayini bekler
5. Yetkili kisi (checker), change set'i inceler ve onaylar/reddeder
6. Onaylanan change set, VFD'ye otomatik olarak uygulanir
7. Uygulama sonrasi read-back ile dogrulama yapilir

**Pending approval badge:**

VFD Programmer widget'inda bekleyen onay varsa, sag ust kosede kirmizi badge gosterilir: `[1]`

### 7.2 Alarm Engine Entegrasyonu

**Alarm Banner konfigurasyonu:**

Alarm Banner widget'i, ekranin ust kisminda tam genislikte yer alir ve aktif alarmlari gosterir:

```
+==================================================================+
| [!] ALARM | 14:32:05 | Pompa #1 Asiri Akim | F03 | [KABUL ET]   |
+==================================================================+
```

**Alarm oncelikleri ve renkleri:**

| Oncelik | Renk | Ses | Ornek |
|---------|------|-----|-------|
| Kritik (1) | Kirmizi yanip sonen | Surekli bip | Asiri akim, dusuk DO |
| Yuksek (2) | Kirmizi sabit | Aralikli bip | Sicaklik alarm |
| Orta (3) | Turuncu | Tek bip | Sicaklik uyari |
| Dusuk (4) | Sari | Sessiz | Bakim hatirlatma |
| Bilgi (5) | Mavi | Sessiz | Sistem bilgisi |

**Alarm kabul etme:**

Operatorler, aktif alarmlari "Kabul Et" butonuyla onaylar. Kabul edilen alarm:
- Ses susar
- Yanip sonme durur
- Renk sabit kalir (hala aktif)
- Kosul ortadan kalktigiginda alarm otomatik kapanir

**Alarm gecmisi:**

Tum alarmlar veritabaninda kayit altina alinir:
- Alarm baslangic zamani
- Alarm kabul zamani
- Alarm bitis zamani
- Alarmi kabul eden operatorun kimiligi

### 7.3 Mobil Erisim (AquaMobil PWA)

**Responsive ekran tasarimi:**

SCADA ekranlari, mobil cihazlarda goruntulenmek uzere otomatik olceklenir. Ancak en iyi sonuc icin:

1. **Mobil-uyumlu ekranlar ayri tasarlayin** -- 375x812px (iPhone) veya 390x844px
2. **Buyuk butonlar kullanin** -- minimum 44x44px dokunma alani
3. **Gauge'lari buyuk tutun** -- minimum 120x120px
4. **Trend chart'lari yatay kaydirmali yapin**

**Touch kontrolleri:**

| Hareket | Islem |
|---------|-------|
| Tek dokunma | Widget sec / buton tiklama |
| Uzun basma | Kontekst menusu (detay, alarm gecmisi) |
| Pinch zoom | Ekrani buyut/kucult |
| Iki parmak surukleme | Ekrani kaydir (pan) |

**Mobil-spesifik widget davranislari:**

- Slider widget'lari mobilde daha genis renderlanir
- Trend chart'lar yatay kaydirmali olur
- Alarm Banner sabit kalir (sticky header)
- VFD Programmer widget'i tam ekran modunda acilir

---

## 8. Troubleshooting

### 8.1 Widget Gorunmuyor

**Belirti:** Canvas'a widget eklediniz ama goruntulenmeoiyor.

**Olasi nedenler ve cozumleri:**

1. **Widget boyutu 0x0:** Properties panelinde Width ve Height degerlerini kontrol edin. Minimum 20x20px olmalidir.
2. **Widget canvas disinda:** Widget'in x/y koordinatlarinin canvas sinirlari icinde oldugundan emin olun.
3. **FUXA SVG bos:** SVG dosyasinin icerigini kontrol edin. `<svg>` root elemaninin `viewBox` niteligi olmalidir.
4. **Z-index sorunu:** Widget baska bir widget'in altinda olabilir. Sag tik > "One Getir" secenegini kullanin.

### 8.2 Tag Binding Calismiyorr

**Belirti:** Tag bagladiniz ama widget canli veri gostermiyor.

**Kontrol listesi:**

1. **Tag adi dogru mu?** Tag adinin tam olarak backend'deki ada uygun oldugundan emin olun. Ornek: `pump1.frequency` (buyuk/kucuk harf duyarli)
2. **Edge device bagli mi?** Equipment widget'inin bir edge device'a baglanmis oldugundan emin olun.
3. **I/O config aktif mi?** Backend'de ilgili DeviceIoConfig kaydinin `isActive: true` oldugundan emin olun.
4. **Veri tipi uyumlu mu?** number tipindeki degiskene string tag baglamak beklenmedik sonuclar uretir.
5. **MQTT baglantisi var mi?** Edge device'in MQTT broker'a baglanmis oldugundan emin olun.
6. **ScadaRuntimeContext mevcut mu?** Widget, ScadaRuntime context'i icinde renderlanmalidir (Preview veya Simulation modunda).

### 8.3 Animasyon Takiliyor

**Belirti:** Akis animasyonlari kasarak ilerliyor veya takiliyoir.

**Cozum adimlari:**

1. **Widget sayisini azaltin:** 50'den fazla widget varsa ekrani bolun (bkz. 6.1).
2. **FUXA widget'larini kontrol edin:** Tier 2 widget'lar daha fazla kaynak tuketir. Gereksiz Tier 2 widget'larini Tier 1 alternatifleriyle degistirin.
3. **Polling araligini artirin:** Kritik olmayan widget'lar icin guncelleme sikligini 5s veya 10s'ye cikin.
4. **Tarayici performansini kontrol edin:** Chrome DevTools > Performance sekmesinde FPS degerini izleyin. 30 FPS altinda sorun var demektir.
5. **CSS animasyon cakismalari:** Ayni edge uzerinde hem `animated: true` hem `flowConfig` tanimlanmissa, `flowConfig` oncelik alir. Eskl `animated` bayraginii kaldirin.

### 8.4 FUXA Widget Yuklenmiyor

**Belirti:** SVG dosyasi yuklemeye calistiginizdaa hata aliuyorsunuz.

**Hata mesajlari ve cozumleri:**

| Hata | Neden | Cozum |
|------|-------|-------|
| "Only .svg files are accepted" | Yanlis dosya uzantisi | Dosyanin `.svg` uzantili oldugundan emin olun |
| "File too large (XKB)" | 1MB limitini asiyor | SVG'yi optimize edin (bkz. 6.3) |
| "Invalid SVG file" | Dosya `<svg>` veya `<?xml>` ile baslamiyor | Gecerli bir SVG dosyasi kullanin |
| Widget render edilmiyor | Script hatasi | Tarayici konsolunda iframe hatalarini kontrol edin |
| Degiskenler algilanmiyor | Export blogu eksik | SVG icinde `//!export-start` ve `//!export-end` isaretlerini kontrol edin |

### 8.5 Edge Baglantisi Kopuyor

**Belirti:** Iki widget arasindaki boru hatti baglantisi kayboluyor veya yanlis konumda gosteriliyor.

**Cozum adimlari:**

1. **Baglanti noktalarini kontrol edin:** Her widget'in connection point'lerinin dogru tipte (input/output) oldugundan emin olun. Source widget'ta output, target widget'ta input olmalidir.
2. **Bend point'leri sifirlayin:** OrthogonalEdge'de bend point'ler bozulmussa, edge'i secin ve sag tik > "Reset Path" ile varsayilana dondurun.
3. **Widget tasindiginda edge guncellenmiyorsa:** Bu bilinen bir sorun olabilir -- edge'i silip yeniden cizin.
4. **Orthogonal edge "zigzag" yapiyorsa:** Routing mode'u degistirin: `auto` -> `horizontal-first` veya `vertical-first`.

**Bend point yonetimi (OrthogonalEdge):**

| Islem | Nasil |
|-------|-------|
| Bend point ekle | Boru hatti uzerine cift tikla |
| Bend point tasi | Bend point karesini surukle |
| Bend point sil | Bend point uzerine sag tikla |
| Path sifirla | Edge'i sil ve yeniden ciz |

**Bend point yonetimi (DraggableEdge):**

| Islem | Nasil |
|-------|-------|
| Kontrol noktasini goster | Edge'i sec (tikla) |
| Egriyi ayarla | Turuncu kontrol noktasini surukle |
| Cubic bezier | curveType: 'cubic' -- iki kontrol noktasi |

---

## Ek A: Hizli Referans -- connectionType ve Edge Tipi Eslesmesi

| Senaryo | Edge Tipi | connectionType | flowCondition |
|---------|-----------|----------------|---------------|
| Ana su borusu | orthogonal | process-pipe | boolean (pompa tag) |
| Kimyasal dozajlama | orthogonal | capillary | boolean (doz pompa) |
| Hava hatti | orthogonal | pneumatic | boolean (blower tag) |
| Sensor kablosu | orthogonal | instrument | - (statik) |
| VFD guc kablosu | orthogonal | electrical | - (statik) |
| SCADA haberlesme | draggable | data-link | - (statik) |
| Drenaj | orthogonal | drain-vent | nonZero (debi tag) |

## Ek B: Hizli Referans -- FUXA Degisken On-ekleri

| On-ek | Tip | TypeScript Karsiligi | Config Paneli Kontrolu |
|-------|-----|---------------------|------------------------|
| `_pn_` | number | `number` | Sayi giris kutusu |
| `_ps_` | string | `string` | Metin giris kutusu |
| `_pb_` | boolean | `boolean` | Checkbox (True/False) |
| `_pc_` | color | `string` (HEX) | Renk secici + metin |

## Ek C: Hizli Referans -- State Indeksleri

| State | Anlam | Varsayilan Renk | Tipik Trigger |
|-------|-------|-----------------|---------------|
| 0 | Kapali / Durdu | Gri | `status = 0` |
| 1 | Aciliyor / Basliyor | Sari | `status = 1` |
| 2 | Calisiyor / Normal | Yesil | `status = 2` |
| 3 | Uyari | Turuncu | Esik asildi (uyari) |
| 4 | Alarm / Ariza | Kirmizi | Esik asildi (alarm) |
| 5 | Bakim / Devre Disi | Mavi | Manuel ayar |
