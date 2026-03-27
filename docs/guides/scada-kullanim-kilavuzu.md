# SCADA Builder -- Kullanim Kilavuzu

**Surum:** 1.0
**Son Guncelleme:** 2026-03-26
**Platform:** RuFlo Aquaculture v3

---

## Icindekiler

1. [Giris](#1-giris)
2. [Baslangic -- Ilk SCADA Ekraniniz](#2-baslangic--ilk-scada-ekraniniz)
3. [Widget'lar -- Gorsel Bilesenler](#3-widgetlar--gorsel-bilesenler)
4. [Baglantilar (Edges) -- Boru ve Kablo Cizimleri](#4-baglantilar-edges--boru-ve-kablo-cizimleri)
5. [Tag Binding -- Sensor Verisini Baglama](#5-tag-binding--sensor-verisini-baglama)
6. [Modlar](#6-modlar)
7. [Animasyon Olusturma -- Adim Adim](#7-animasyon-olusturma--adim-adim)
8. [Ekran Yonetimi](#8-ekran-yonetimi)
9. [Ipuclari ve En Iyi Uygulamalar](#9-ipuclari-ve-en-iyi-uygulamalar)
10. [Kisayol Tuslari](#10-kisayol-tuslari)

---

## 1. Giris

### 1.1 SCADA Builder Nedir?

SCADA Builder, su urunu yetistirme (aquaculture) tesislerinizin tam bir gorsel kontrol panelini olusturmanizi saglayan surukle-birak tabanli bir ekran tasarim aracidir. ReactFlow altyapisi uzerine insa edilmis olup, endustriyel duzeyde P&ID (Process and Instrumentation Diagram) diyagramlari, canli veri izleme panelleri ve uzaktan kumanda ekranlari olusturmaniza olanak tanir.

### 1.2 Ne Ise Yarar?

- **Canli Izleme:** Pompalarin, valflerein, tanklarin ve sensorlerin anlik durumunu gorsel olarak izleyin.
- **Uzaktan Kontrol:** Pompalari baslatip durdurun, valf pozisyonlarini ayarlayin, frekans donusturucu (VFD) parametrelerini degistirin.
- **Alarm Yonetimi:** Esik degerleri asildiginda aninda gorsel ve isitsel uyarilar alin.
- **Trend Analizi:** Sicaklik, pH, cozunmus oksijen gibi parametrelerin zaman icerisindeki degisimini grafik olarak izleyin.
- **Proses Akis Semalari:** Tam tesis akis diyagramlari cizerek su girisi, filtrasyon, biyolojik aritma ve depolama sureclerini goruntulenin.

### 1.3 Temel Kavramlar

| Kavram | Aciklama |
|--------|----------|
| **Screen (Ekran)** | Bir SCADA sayfasi. Birden fazla ekran olusturabilir ve aralarinda gezinebilirsiniz. |
| **Widget** | Ekrana yerlestirilen gorsel bilesen. Gosterge, buton, tank, grafik gibi 50'den fazla tur mevcuttur. |
| **Edge (Baglanti)** | Widget'lar arasindaki boru hatti veya kablo baglantisi. Akis animasyonu destekler. |
| **Tag** | Bir sensorun veri kanalini tanimlar. Ornegin `pump_1.status` veya `tank_1.level`. Widget'lari tag'lere baglayarak canli veri gosterimi saglarsiniz. |
| **Mode (Mod)** | Calisma kipi: Edit (duzenleme), Preview (onizleme) veya Simulation (simulasyon). |

### 1.4 Modlar

| Mod | Amaci | Neler Yapilabilir |
|-----|-------|-------------------|
| **Edit Mode** | Ekran tasarimi | Widget ekle/sil/tasi, baglanti ciz, ozellik duzenle |
| **Preview Mode** | Canli izleme | Gercek zamanli sensor verisi goruntuleme, kontrol komutlari gonderme |
| **Simulation Mode** | Test | Sahte veri ile tum animasyonlari ve alarmlari test etme |

---

## 2. Baslangic -- Ilk SCADA Ekraniniz

### 2.1 Yeni Ekran Olusturma

1. Sol menuden **Sensor Module** bolumune gidin.
2. **Process Editor** sayfasini acin.
3. Ust toolbar'daki **"Yeni Ekran"** butonuna tiklayin.
4. Ekran adi girin (ornegin: "Ana Proses Ekrani").
5. Ekran turunu secin:
   - `dashboard` -- genel ozet paneli
   - `process` -- proses akis diyagrami
   - `alarms` -- alarm izleme ekrani
   - `trends` -- trend grafikleri
   - `calibration` -- kalibrasyon ekrani
   - `control` -- kontrol paneli
6. **Olustur** butonuna basin.

### 2.2 Ekran Alani (Canvas)

Canvas, 12 sutun x 8 satir'lik bir izgara (grid) sistemine sahiptir. Her hucre 120x100 piksel boyutundadir.

**Temel Canvas Islemleri:**

| Islem | Nasil Yapilir |
|-------|---------------|
| **Yakinlastirma/Uzaklastirma** | Ctrl + fare tekerlegi |
| **Surdukle (Pan)** | Bos alana tikla ve surdukle |
| **Mini Harita** | Canvas'in sag alt kosesinde kucuk harita gorunumu |
| **Izgara Gorunurlugu** | Canvas Settings panelinden ac/kapat |
| **Snap-to-Grid** | Varsayilan olarak aktif; widget'lar otomatik olarak izgara hizasina yapistir |
| **Cetvel (Ruler)** | Canvas kenarlarina piksel cetvel gosterimi |
| **Akilli Kilavuzlar (Smart Guides)** | Widget suruklerken diger widget'larla hizalama cizgileri otomatik gorunur |

**Canvas Ayarlari:**

Canvas Settings panelinden su ayarlari degistirebilirsiniz:
- **Snap Enabled:** Izgaraya yapismay ac/kapat
- **Show Grid:** Arka plan izgarasini goster/gizle
- **Zoom Level:** Mevcut yakinlastirma seviyesi

---

## 3. Widget'lar -- Gorsel Bilesenler

Widget'lar, SCADA ekranlarinizin yapi taslaridir. Sol taraftaki **Widget Palette**'den istediginiz widget'i secip canvas'e surukleyerek ekleyebilirsiniz.

Sistemde toplam **52 widget turu** bulunmaktadir. Asagida kategorilere ayrilmis sekilde her birinin detayli aciklamasi yer almaktadir.

---

### 3.1 Izleme Widget'lari (Monitoring)

Bu widget'lar sensor verilerini gorsel olarak gostermek icin kullanilir. Veri yazmaz, sadece okur.

#### Gauge (Gosterge)

**Amac:** Sicaklik, basinc, pH, cozunmus oksijen (DO) gibi analog degerleri kadranli gosterge seklinde goruntuler.

**Konfigurasyon:**
- **Tag:** Baglenmak istenen sensor tag'i (ornegin: `temperature_1`)
- **Min / Max:** Gosterge skalasinin alt ve ust sinirlari (ornegin: 0 -- 100)
- **Unit (Birim):** Gosterilecek birim (ornegin: `degreeC`, `mg/L`, `bar`)
- **Decimals (Ondalik Basamak):** Gosterilen deger hassasiyeti (0-6 arasi)
- **Expression Binding:** Hesaplanmis deger formulu (ornegin birim donusumu, ortalama)
- **Zones (Bolgeler):** Deger araligina gore renk bantlari tanimlanir

**Zone (Renk Bantlari) Ornegi:**

| Min | Max | Renk | Anlam |
|-----|-----|------|-------|
| 0 | 15 | Mavi | Dusuk sicaklik |
| 15 | 25 | Yesil | Normal aralik |
| 25 | 100 | Kirmizi | Yuksek sicaklik alarmi |

**Adim Adim Ekleme:**
1. Widget Palette'den **Gauge** secin, canvas'e surukleyin.
2. Sag paneldeki Properties'te **Tag** alanina tiklayin.
3. Tag Browser acilir -- cihazinizi ve kanalini secin.
4. **Min** ve **Max** degerlerini ayarlayin.
5. **Unit** alanina birimi yazin (ornegin: `degreeC`).
6. **Zones** bolumunde `+ Add Zone` ile renk bantlari ekleyin.
7. Preview Mode'a gecip canli veriyi dogrulayin.

**Varsayilan Boyut:** 3x3 hucre (360x300 piksel)

---

#### Numeric Display (Sayisal Gosterge)

**Amac:** Hassas sayisal degeri buyuk ve net sekilde gosterir. Ondalik basamak ve birim destegi vardir.

**Konfigurasyon:**
- **Tag:** Sensor tag'i
- **Label:** Gosterge etiketi (ornegin: "Sicaklik", "pH Degeri")
- **Unit:** Birim (ornegin: `degreeC`, `NTU`)
- **Decimals:** Ondalik basamak sayisi (0-6)

**Kullanim Senaryosu:** Bir havuzun pH degerini 7.21 seklinde gostermek istediginizde ideal.

**Varsayilan Boyut:** 2x2 hucre (240x200 piksel)

---

#### Status Indicator (Durum Gostergesi)

**Amac:** ON/OFF, ACIK/KAPALI, CALISIYOR/DURDU gibi ikili (binary) veya coklu durumlari renk ile gosterir.

**Konfigurasyon:**
- **Tag:** Durum tag'i (ornegin: `pump_1.status`)
- **Label:** Etiket (ornegin: "Pompa Durumu")
- **Active Color:** Aktif durumda gosterilecek renk (Yesil, Kirmizi, Sari, Mavi, Turuncu)
- **Inactive Color:** Pasif durumda gosterilecek renk (Gri, Koyu Gri, Kirmizi)
- **ON Label:** Aktif durumda gosterilecek yazi (ornegin: "Calisiyor")
- **OFF Label:** Pasif durumda gosterilecek yazi (ornegin: "Durdu")
- **Color Ranges:** Analog degerler icin renk aralik eslemeleri (8 adede kadar)

**Color Range Ornegi (Analog Tag Icin):**

| Min | Max | Renk | Anlam |
|-----|-----|------|-------|
| 0 | 0 | Gri | Durdu |
| 1 | 1 | Yesil | Normal calisma |
| 2 | 2 | Kirmizi | Ariza |

**Varsayilan Boyut:** 2x2 hucre

---

#### Tank Level (Tank Seviye Gostergesi)

**Amac:** Su tanklarinin doluluk seviyesini animasyonlu olarak gosterir. Dalga efekti ile gercekci gorsel.

**Konfigurasyon:**
- **Tag:** Seviye sensor tag'i (ornegin: `tank_1.level`)
- **Label:** Etiket (ornegin: "Temiz Su Tanki")
- **Min / Max:** Minimum ve maksimum seviye degerleri
- **Unit:** Birim (ornegin: `L`, `m3`, `%`)

**Ozellikler:**
- Seviye degerine gore su animasyonu yukariya/asagiya hareket eder
- Dalga efekti gercekci gorunum saglar
- Minimum/maksimum alarm esikleri belirlenebilir

**Varsayilan Boyut:** 2x4 hucre (240x400 piksel) -- dikey format

---

#### Trend Chart (Trend Grafik)

**Amac:** Bir veya birden fazla sensor verisinin zaman icerisindeki degisimini cizgi grafik olarak gosterir.

**Konfigurasyon:**
- **Tags:** Bir veya birden fazla tag eklenebilir (`+ Add Tag` butonu ile)
- **Default Time Range:** Varsayilan zaman araligi secimi:
  - 1 Saat, 6 Saat, 24 Saat, 7 Gun, 30 Gun
- **Show Grid:** Grafik uzerinde izgara goster/gizle
- **Show Legend:** Grafik aciklamasi goster/gizle
- **Chart Height Mode:** `Auto` (otomatik) veya `Fixed` (sabit yukseklik)

**Coklu Tag Ornegi:**
Ayni grafikte su sicakligi, pH ve DO seviyesini ayni anda izleyebilirsiniz:
- Tag 1: `water_temp` (Mavi cizgi)
- Tag 2: `ph_sensor` (Yesil cizgi)
- Tag 3: `do_sensor` (Turuncu cizgi)

**Varsayilan Boyut:** 6x4 hucre (720x400 piksel)

---

#### Progress Bar (Ilerleme Cubusu)

**Amac:** Yuzde bazli ilerlemeyi yatay cubuk olarak gosterir. Renk zonlari ile alarm durumlarini gorsellestirir.

**Konfigurasyon:**
- **Tag:** Sensor tag'i
- **Expression Binding:** Hesaplanmis deger formulu
- **Label:** Etiket
- **Min / Max:** Deger araligi
- **Bar Height:** Cubuk yuksekligi (8-80 piksel)
- **Border Radius:** Kose yuvarlakligi (0-40)
- **Label Position:** Etiket konumu (`Inside`, `Above`, `Below`)
- **Show Label / Show Percentage:** Goster/gizle secenekleri
- **Background / Fill Color:** Arka plan ve dolgu renkleri
- **Color Zones:** Yuzde araligina gore renk degisimi

**Zone Ornegi:**

| Min % | Max % | Renk | Anlam |
|-------|-------|------|-------|
| 0 | 50 | Yesil | Normal |
| 50 | 80 | Sari | Uyari |
| 80 | 100 | Kirmizi | Kritik |

**Varsayilan Boyut:** 3x1 hucre (360x100 piksel)

---

#### Bar Chart (Cubuk Grafik)

**Amac:** Istatistiksel verileri dikey cubuk grafik olarak gosterir. Birden fazla veri kaynagi destekler.

**Varsayilan Boyut:** 4x3 hucre

---

#### Pie Chart (Pasta Grafik)

**Amac:** Veri dagilimini daire (pasta) grafik olarak gosterir.

**Varsayilan Boyut:** 3x3 hucre

---

#### Data Table (Veri Tablosu)

**Amac:** Sensor verilerini tablo formatinda gosterir. Sutun konfigurasyonu, siralama ve filtreleme destegi vardir.

**Varsayilan Boyut:** 6x4 hucre

---

### 3.2 Kontrol Widget'lari (Control)

Bu widget'lar cihazlara komut gondermek icin kullanilir. Tag'e deger yazar.

**Onemli:** Kontrol widget'lari yalnizca **Preview Mode**'da aktiftir. Edit Mode'da gorunur ancak islev gormez.

---

#### Toggle Switch (Anahtar)

**Amac:** ON/OFF kumanda gondermek icin kullanilir. Pompa baslatma/durdurma, valf acma/kapama gibi islemler icin ideal.

**Konfigurasyon:**
- **Tag:** Kontrol tag'i (ornegin: `pump_1.command`)
- **Label:** Etiket (ornegin: "Pompa Kontrolu")
- **ON Label:** Aktif konumda gosterilecek yazi (ornegin: "Ac")
- **OFF Label:** Pasif konumda gosterilecek yazi (ornegin: "Kapat")
- **Security Level:** Guvenlik seviyesi
  - `None` -- Dogrudan calistirir
  - `Confirmation Required` -- "Emin misiniz?" dialogu gosterir
  - `PIN Required` -- PIN girisi ister

**Adim Adim Kullanim:**
1. Widget Palette'den **Toggle Switch** secin, canvas'e surukleyin.
2. **Tag** alanina kontrol tag'ini secin.
3. **ON/OFF Label** yazilarini Turkce olarak duzenleyin.
4. **Security Level** olarak `Confirmation Required` secin (guvenlik icin onerilen).
5. Preview Mode'a gecin. Anahtari cevirdiginizde onay dialogu gorunur.
6. Onayladiginizda tag'e ilgili deger (1 veya 0) yazilir.

**Varsayilan Boyut:** 2x2 hucre

---

#### Slider (Kaydirici)

**Amac:** Belirli bir aralikta surekli deger ayarlamak icin kullanilir. VFD frekans ayari, valf pozisyonu, sicaklik setpoint'i gibi islemler icin ideal.

**Konfigurasyon:**
- **Tag:** Hedef tag (ornegin: `vfd_1.frequency`)
- **Label:** Etiket (ornegin: "Frekans Ayari")
- **Min / Max:** Deger araligi (ornegin: 0 -- 50 Hz)
- **Step:** Adim buyuklugu (ornegin: 0.5 Hz)
- **Unit:** Birim (ornegin: `Hz`, `%`, `RPM`)
- **Security Level:** `None`, `Confirmation Required` veya `PIN Required`

**Varsayilan Boyut:** 3x2 hucre (360x200 piksel)

---

#### Numeric Input (Sayisal Giris)

**Amac:** Klavyeden hassas sayisal deger girmek icin kullanilir. Setpoint degerleri icin ideal.

**Konfigurasyon:**
- **Tag:** Hedef tag (ornegin: `heater_1.setpoint`)
- **Label:** Etiket (ornegin: "Sicaklik Setpoint")
- **Unit:** Birim (ornegin: `degreeC`)
- **Min / Max:** Deger sinirlamalari
- **Step:** Artirma/azaltma adimi
- **Security Level:** `None`, `Confirmation Required` veya `PIN Required`

**Varsayilan Boyut:** 2x2 hucre

---

#### Push Button (Buton)

**Amac:** Tek seferlik komut gondermek icin kullanilir. Motor baslatma, reset komutu, kalibrasyon baslatma gibi islemler.

**Konfigurasyon:**
- **Tag:** Komut tag'i
- **Label:** Buton yazisi (ornegin: "Baslat", "Sifirla")
- **Button Mode:**
  - `Momentary` -- Basili tutulurken aktif, birakilinca pasif (puls komutu)
  - `Toggle` -- Her basista durumu degistirir (on/off)
- **Value to Send:** Tag'e gonderilecek deger (ornegin: `1`)
- **Security Level:** `None`, `Confirmation Required` veya `PIN Required`

**Varsayilan Boyut:** 2x2 hucre

---

#### Emergency Stop (Acil Durdurma)

**Amac:** Buyuk kirmizi acil stop butonu. Tum VFD'lere ve ekipman kontrollerine acil durdurma komutu gonderir.

**Onemli:** Acil durdurma butonu onay **gerektirmez** -- bu bir guvenlik gerekliligidir. Buton basili tutularak aktive edilir.

**Konfigurasyon:**
- **Hold Duration (ms):** Butonun basili tutulmasi gereken sure (varsayilan: 2000 ms = 2 saniye). Kazara basmay onlemek icin.
- **Label:** Buton uzerindeki yazi (varsayilan: "EMERGENCY STOP")

**Varsayilan Boyut:** 2x4 hucre -- buyuk ve dikkat cekici

---

#### Dropdown Select (Acilir Menu)

**Amac:** Onceden tanimlanmis secenekler listesinden deger secimi yapmak icin kullanilir. Calisma modu degistirme (Otomatik/Manuel/Bakim), ekipman tipi secimi gibi islemler icin ideal.

**Konfigurasyon:**
- **Tag:** Hedef tag
- **Label:** Etiket (ornegin: "Calisma Modu")
- **Placeholder:** Bos durumda gosterilecek yazi (ornegin: "Sec...")
- **Show Label:** Etiket goster/gizle
- **Font Size:** Yazi boyutu (8-24 piksel)
- **Border / Background Color:** Cerceve ve arka plan renkleri
- **Options (Secenekler):** Etiket-deger ciftleri listesi

**Secenek Tanimlama Ornegi:**

| Etiket | Deger |
|--------|-------|
| Otomatik | 0 |
| Manuel | 1 |
| Bakim | 2 |

Her secenek icin `+ Add Option` butonuna tiklarsiniz ve Label ile Value degerlerini girersiniz.

**Varsayilan Boyut:** 2x2 hucre

---

#### Knob (Doner Dugme)

**Amac:** Doner potansiyometre benzeri kontrol. Frekans, hiz veya seviye ayari icin gorsel olarak sezgisel bir kontrol saglar.

**Konfigurasyon:**
- **Tag:** Hedef tag (ornegin: `vfd_1.frequency`)
- **Label:** Etiket (ornegin: "Hiz Ayari")
- **Min / Max / Step:** Deger araligi ve adim buyuklugu
- **Start Angle / End Angle:** Dugmenin dondugu aci araligi (varsayilan: 30-330 derece)
- **Tick Count:** Isaretleme cizgisi sayisi (2-25 arasi)
- **Show Value:** Deger goster/gizle
- **Show Ticks:** Isaretleme cizgilerini goster/gizle
- **Colors:** Dugme, iz ve gosterge renkleri

**Varsayilan Boyut:** 2x2 hucre

---

### 3.3 Kalibrasyon Widget'lari

#### Calibration Wizard (Kalibrasyon Sihirbazi)

**Amac:** Sensor kalibrasyon islemini adim adim yonlendiren sihirbaz. pH, DO, iletkenlik sensorlerinin kalibrasyonu icin.

**Varsayilan Boyut:** 6x4 hucre

---

#### Calibration History (Kalibrasyon Gecmisi)

**Amac:** Gecmis kalibrasyon kayitlarini tablo formatinda gosterir. Tarih, sonuc ve kalibrasyon durumu bilgilerini icerir.

**Varsayilan Boyut:** 6x4 hucre

---

#### Calibration Status (Kalibrasyon Durumu)

**Amac:** Sensorlerin mevcut kalibrasyon durumunu ozetler. Son kalibrasyon tarihi, bir sonraki kalibrasyon zamani, kalibrasyon gecerliligi gibi bilgileri gosterir.

**Varsayilan Boyut:** 3x3 hucre

---

### 3.4 Alarm Widget'lari

#### Alarm Banner (Alarm Seridi)

**Amac:** Ekranin ust kismine yerlestirilen yatay alarm seridi. Aktif alarmlari kayar yazi seklinde gosterir.

**Kullanim:** Genellikle her SCADA ekraninin en ustune tam genislikte yerlestirilir.

**Varsayilan Boyut:** 12x2 hucre (1440x200 piksel) -- tam ekran genisligi

---

#### Alarm List (Alarm Listesi)

**Amac:** Aktif ve gecmis alarmlari detayli tablo formatinda listeler. Alarm zamani, kaynagi, seviyesi ve onay durumu bilgilerini icerir.

**Varsayilan Boyut:** 6x4 hucre

---

### 3.5 Ekipman Widget'lari (Process View)

Bu widget'lar, aquaculture tesislerindeki fiziksel ekipman ve su aritma birimlerini gorsel olarak temsil eder.

#### Equipment (Ekipman)

**Amac:** Pompa, valf, tank, isi degistirici gibi endustriyel ekipmanlari ISA-5.1 standart sembollerle gosterir.

**Desteklenen Ekipman Turleri:**

**Pompalar:**
- Santrifuj Pompa (Centrifugal Pump)
- Dizel Pompa (Gear Pump)
- Diyafram Pompa (Diaphragm Pump)
- Piston Pompa (Piston Pump)
- Dalgic Pompa (Submersible Pump)
- Vakum Pompa (Vacuum Pump)

**Valfler:**
- Surgulon Valf (Gate Valve)
- Kusereli Valf (Ball Valve)
- Kelebekli Valf (Butterfly Valve)
- Glop Valf (Globe Valve)
- Cek Valf (Check Valve)
- Emniyet Valfi (Relief Valve)
- Kontrol Valfi (Control Valve)
- Igne Valfi (Needle Valve)
- Solenoid Valf (Solenoid Valve)

**Tanklar:**
- Dikey Tank (Vertical Tank)
- Yatay Tank (Horizontal Tank)
- Konik Dipli Tank (Conical Bottom Tank)
- Basinc Kabi (Pressure Vessel)
- Silo
- Karistirmali Tank (Mixing Tank)

**Isi Degistiriciler:**
- Boru Demeti (Shell and Tube)
- Plakali Isi Degistirici (Plate Heat Exchanger)
- Hava Sogutucu (Air Cooler)
- Kondenser (Condenser)
- Evaporator (Evaporator)

**Konfigurasyon:**
- **Equipment Type:** Ekipman tipi (salt okunur -- paletten secildiginde belirlenir)
- **Tag:** Durum tag'i (ornegin: `pump_1.status`)
- **Label:** Etiket (ornegin: "Besleme Pompasi 1")
- **Rotation:** Sembolun donme acisi (0, 90, 180, 270 derece)
- **Demo Status:** Edit Mode'da test icin durum secimi (Running, Stopped, Open, Closed, Fault)

**Durum Renkleri (Otomatik):**
- **Running / Open:** Yesil
- **Stopped / Closed:** Gri
- **Fault:** Kirmizi

---

#### Feeder (Yem Makinesi)

**Amac:** Balik yem dagitim makinelerini gosterir.

**Varsayilan Boyut:** 2x3 hucre

---

#### Clean Water Tank (Temiz Su Tanki)

**Amac:** Aritilmis temiz su tankini gorsel olarak gosterir.

**Varsayilan Boyut:** 2x3 hucre

---

#### Dirty Water Tank (Kirli Su Tanki)

**Amac:** Aritma oncesi kirli su toplama tankini gosterir.

**Varsayilan Boyut:** 2x3 hucre

---

#### MBBR (Hareketli Yatakli Biyoreaktor)

**Amac:** Biyolojik filtrasyon birimini (Moving Bed Biofilm Reactor) gosterir. Aquaculture tesislerinde amonyak ve nitrit giderimi icin kullanilir.

**Varsayilan Boyut:** 3x2 hucre

---

#### Hepa Filter (HEPA Filtre)

**Amac:** Hava filtrasyon sistemlerini gosterir.

**Varsayilan Boyut:** 3x2 hucre

---

#### Radial Filter (Radyal Filtre)

**Amac:** Izgara tipi mekanik filtre birimlerini gosterir. Kati madde ayirma icin kullanilir.

**Varsayilan Boyut:** 2x3 hucre

---

#### Cornell Dual Drain (Cift Drenaj)

**Amac:** Cift drenaj sistemini gosterir. Baliklara zarar vermeden kati atik uzaklastirma icin kullanilir.

**Varsayilan Boyut:** 4x3 hucre

---

#### Process View (Proses Gorunumu)

**Amac:** Tam proses akis semasidir. Tum ekipmanlari ve baglantilari tek bir buyuk widget icerisinde gosterir.

**Varsayilan Boyut:** 12x6 hucre -- tam ekran gorunumu

---

### 3.6 Navigasyon ve Bilgi Widget'lari

#### Screen Link (Ekran Baglantisi)

**Amac:** Farkli SCADA ekranlari arasinda gecis butonu olusturur.

**Konfigurasyon:**
- **Target Screen:** Hedef ekran secimi (mevcut ekranlar listesinden)
- **Label:** Buton yazisi (ornegin: "Ana Ekrana Don")
- **Display Style:** Gorunum stili
  - `Card` -- Kart gorunumu (genis, bilgilendirici)
  - `Button` -- Buton gorunumu (kompakt)
  - `Minimal` -- Minimal gorunum (sadece yazi)
- **Color:** Buton rengi (renk secici ile)
- **Icon:** Ikon secimi (Arrow, External Link, Monitor)

**Varsayilan Boyut:** 2x2 hucre

---

#### Static Text (Sabit Yazi)

**Amac:** Ekrana sabit etiket veya aciklama yazisi ekler. Basliklar, aciklamalar, uyari notlari icin kullanilir.

**Varsayilan Boyut:** 3x1 hucre

---

#### Scheduler (Zamanlamaci)

**Amac:** Zamanlama takvimi. Pompa calisma programlari, yem dagitim zamanlari gibi periyodik islemleri gosterir ve yonetir.

**Varsayilan Boyut:** 4x3 hucre

---

#### Video Stream (Video Akisi)

**Amac:** IP kamera goruntulerini canli olarak gosterir. Tesis izleme ve guvenlik kamerlari icin.

**Varsayilan Boyut:** 3x2 hucre

---

#### Map View (Harita Gorunumu)

**Amac:** Tesis konumunu harita uzerinde gosterir. Birden fazla tesis lokasyonu icin genis alana yayilmis tesislerde kullanislidir.

**Varsayilan Boyut:** 3x3 hucre

---

#### IFrame (Harici Web Icerigi)

**Amac:** Harici web sayfalarini SCADA ekrani icerisine gomme. Uretici dokumantasyonu, hava durumu, dis sistemler icin.

**Varsayilan Boyut:** 4x3 hucre

---

### 3.7 SVG Sekil Widget'lari

Serbest cizim icin geometrik sekil widget'lari. Proses diyagramlarinda boru hatlari, tanklarin ozelllestirilmis gorselleri, ok isaretleri ve dekoratif elemanlar olusturmak icin kullanilir.

| Widget | Aciklama | Varsayilan Boyut |
|--------|----------|-----------------|
| **svgRect** | Dikdortgen | 2x2 |
| **svgCircle** | Daire | 2x2 |
| **svgEllipse** | Elips | 2x2 |
| **svgLine** | Cizgi | 3x1 |
| **svgPolygon** | Cokgen | 2x2 |
| **svgTriangle** | Ucgen | 2x2 |
| **svgDiamond** | Eskenar dortgen (elmas) | 2x2 |
| **svgArrow** | Ok isareti | 3x2 |
| **svgPath** | Serbest yol cizimi (SVG path) | 4x3 |
| **svgText** | SVG metin | 2x1 |

**Her Sekil Icin Ortak Ayarlar:**
- Dolgu rengi (fill)
- Cizgi rengi (stroke)
- Cizgi kalinligi (stroke-width)
- Saydamlik (opacity)
- Animasyon baglama (tag'e bagli renk degisimi)

---

#### Custom SVG (Ozel SVG)

**Amac:** Disaridan ozel SVG dosyasi yukleyerek canvas'e ekler. Firmaniza ozel ekipman sembolleri, logo veya ozel grafikler icin kullanilir.

**Varsayilan Boyut:** 2x2 hucre (boyutlandirma serbest)

---

#### Raster Image (Raster Gorsel)

**Amac:** PNG, JPG gibi bitmap gorselleri ekrana ekler. Tesis fotograflari, teknik cizimler icin.

**Varsayilan Boyut:** 3x3 hucre

---

### 3.8 FUXA Widget'lari (Gelismis SVG)

FUXA, acik kaynakli SCADA toplulugunun sundugusu script destekli SVG widget sistemidir. Standart SVG'den farki, icerisinde JavaScript script bloklari barindirmasi ve duruma bagli (state machine) animasyon destegine sahip olmasidir.

**Konfigurasyon:**

1. **Label:** Widget etiketi
2. **FUXA SVG File:** SVG dosyasi yukleme (maksimum 1 MB)
   - Script bloklari korunur (DOMPurify uygulanmaz)
   - Guvenlik: iframe sandbox ile izole edilir (allow-scripts, allow-same-origin yok)
3. **Variables:** SVG icerisindeki degiskenler otomatik olarak parse edilir
   - Her degisken icin tip uygun kontrol gosterilir (number, boolean, color, string)
   - Her degiskene ayrica bir tag baglanabilir (per-variable tag binding)
4. **State Machine:**
   - **Tag Name:** Durumu kontrol eden tag
   - **State Rules:** Tag degerine gore duruma (0-5) esleme kurallari

**State Rule Kosul Turleri:**

| Kosul | Aciklama | Ornek |
|-------|----------|-------|
| `<` | Kucuktur | Deger < 10 ise State 0 |
| `<=` | Kucuk esittir | Deger <= 25 ise State 1 |
| `=` | Esittir | Deger = 50 ise State 2 |
| `>=` | Buyuk esittir | Deger >= 75 ise State 3 |
| `>` | Buyuktur | Deger > 90 ise State 4 |
| `Between` | Aralikta | 20-80 arasi ise State 2 |

**6 Durumlu Animasyon Ornegi (Pompa):**

| State | Anlam | Gorsel |
|-------|-------|--------|
| 0 | Kapalsi | Gri, hareketsiz |
| 1 | Calisiyor (dusuk) | Yesil, yavas donme |
| 2 | Calisiyor (normal) | Yesil, normal donme |
| 3 | Calisiyor (yuksek) | Turuncu, hizli donme |
| 4 | Uyari | Sari, yanip sonen |
| 5 | Ariza | Kirmizi, durmus |

**Varsayilan Boyut:** 2x2 hucre (12x8'e kadar boyutlandirma serbest)

---

### 3.9 VFD Programmer Widget (YENI)

**Amac:** VFD (Variable Frequency Drive / Frekans Donusturucu) parametrelerini SCADA ekrani uzerinden uzaktan programlamak icin kullanilir. Maker-Checker (4-goz prensibi) onay is akisi ile endustriyel guvenlik standartlarina uygun calisir.

**Temel Ozellikler:**
- Kompakt kart gorunumunde VFD parametre listesi
- Change Set (Degisiklik Paketi) olusturma
- Onay bekleyen degisiklikler badge gostergesi
- IEC 61800-7-201 ve IEC 62443 SL-2 standartlarina uygunluk

**Is Akisi:**
1. SCADA ekranindaki VFD widget'ina tiklayin
2. Degistirmek istediginiz parametreleri secin (ornegin: hizlanma suresi, maksimum frekans)
3. Yeni degerleri girin
4. "Change Set Olustur" butonuna basin -- degisiklikler `draft` durumuna gecer
5. Onay icin gonderin (`pending_approval`)
6. Yetkili kullanici onaylon (Maker-Checker: onayclayan kisi farkli biri olmalidir)
7. Onaylanan degisiklikler VFD'ye yazilir

**Parametre Gruplari:**
- `ramp_times` -- Hizlanma/yavaslanma sureleri
- `freq_limits` -- Frekans sinirlari
- `motor_nameplate` -- Motor plaka bilgileri
- `protection` -- Koruma ayarlari
- `pid` -- PID kontrolor parametreleri
- `io` -- Giris/cikis konfigurasyonu
- `communication` -- Haberlesme ayarlari
- `jog` -- Yog calisma parametreleri
- `vf_control` -- V/f kontrol egrileri
- `current_limits` -- Akim sinirlamalari

---

## 4. Baglantilar (Edges) -- Boru ve Kablo Cizimleri

Baglantilar (edges), widget'lar arasindaki fiziksel baglantilari temsil eder: boru hatlari, kablo guzergahlari, sinyal yollari. ISA-5.1 P&ID standardina uygun stiller desteklenir.

### 4.1 Baglanti Tipleri

Sistemde 3 farkli edge render tipi bulunur:

#### Orthogonal Edge (Dik Acili Baglanti)

**En cok kullanilan tip.** Boru hatlari ve kablo kanallarinda 90 derecelik dik acili donusler yapar.

**Ozellikler:**
- Otomatik yonlendirme: Yatay-oncelikli, dikey-oncelikli veya otomatik
- Suruklenebilir donus noktalari (bend points) -- elle ayarlama
- Segmente cift tiklama ile yeni donus noktasi ekleme
- Donus noktasina sag tiklama ile silme
- 5 piksel snap hassasiyeti

**Yonlendirme Modlari:**
- `horizontal-first` -- Once yatay, sonra dikey ilerler
- `vertical-first` -- Once dikey, sonra yatay ilerler
- `auto` -- Mesafeye gore otomatik secer

---

#### Multi Handle Edge (Coklu Kontrol Noktali Egri)

**Ozellikler:**
- Birden fazla kontrol noktasi ile serbest egri cizimi
- Noktalar kilitlenebilir (`locked` ozelligi)
- Karmasik boru guzergahlari icin ideal

---

#### Draggable Edge (Serbest Suruklenebilir Baglanti)

**Ozellikler:**
- Kuadratik veya kubik Bezier egrisi destegi
- Kontrol noktalari suruklenebilir
- Estetik dekoratif baglantilar icin

---

### 4.2 Baglanti Tipleri (Connection Types) -- ISA-5.1

Her edge'e bir **Connection Type** atanir. Bu, edge'in gorsel stilini (renk, cizgi kalinligi, cizgi deseni) belirler:

| Tip | Etiket | Renk | Kalinlik | Cizgi Stili | Kullanim |
|-----|--------|------|----------|-------------|----------|
| `process-pipe` | Proses Boru | Siyah (#1f2937) | 3px | Duz cizgi | Ana su/hava hatlari |
| `electrical` | Elektrik Sinyal | Kirmizi (#dc2626) | 2px | Kesikli (8,4) | 4-20mA, voltaj sinyalleri |
| `pneumatic` | Pnomatik Sinyal | Mavi (#2563eb) | 2px | Cift isaretli (12,3,3,3) | Hava/gaz sinyal baglantilari |
| `hydraulic` | Hidrolik Hat | Yesil (#16a34a) | 2px | Uzun-kisa (12,4,4,4) | Hidrolik sivi baglantilari |
| `instrument` | Enstruman Sinyal | Turuncu (#ea580c) | 2px | Cizgi-nokta (8,3,2,3) | Sensor ve kontrol sinyalleri |
| `data-link` | Veri/Haberlesme | Mor (#7c3aed) | 2px | Noktali (2,4) | Dijital veri iletimi |
| `capillary` | Kapiler Tup | Gri (#6b7280) | 1px | Duz ince | Kapiler baglantilar |
| `steam` | Buhar Hatti | Turuncu (#f97316) | 3px | Kisa kesikli (6,2) | Buhar proses hatlari |
| `drain-vent` | Drenaj/Havalandirma | Cyan (#0891b2) | 2px | Cizgi-nokta-nokta (4,4,1,4) | Drenaj ve havalandirma |

### 4.3 Baglanti Olusturma

**Adim Adim:**

1. Edit Mode'da oldugunuzdan emin olun.
2. Kaynak widget'in kenarindaki **baglanti noktasina (handle)** farenizi getirin -- kucuk bir daire gorunur.
3. Baglanti noktasina tiklayin ve fareyi birakmadan hedef widget'a dogru surukleyin.
4. Hedef widget'in giris noktasina (inlet) biraktigninizda baglanti olusur.
5. Olusturulan baglantiyi tiklayin -- sag panelde ozelliklerini duzenleyebilirsiniz:
   - Edge tipi degistirme (Orthogonal, MultiHandle, Draggable)
   - Connection type degistirme (boru, elektrik, vb.)

**Baglanti Dogrulama Kurallari:**
- Bir widget kendisine baganlanamaz (self-connection engellenir)
- Ayni cikis-giris cifti arasinda tekrar baglanti yapilamaz (dublike engellenir)
- Cikis yonlu handle'dan giris yonlu handle'a baglanti kurulmalidir

### 4.4 Akis Animasyonu

SCADA ekranlarindaki boru hatlarinda akan sivi animasyonu gosterilebilir. Iki farkli animasyon mekanizmasi vardir:

#### Statik Animasyon (Eski Sistem)

Edge'in `animated` ozelligini `true` yaparak suyatik akis animasyonu aktive edilir. Animasyon surekli calisir.

#### Tag-Tabanli Akis Animasyonu (Onerilen)

**EdgeFlowConfig** ile bir tag'e baglanarak canli proses durumuna gore animasyon kontrolu saglar.

**FlowConfig Ayarlari:**

| Ayar | Aciklama | Degerler |
|------|----------|----------|
| **tagName** | Animasyonu kontrol eden tag | `pump1_running`, `flow_sensor_1` |
| **flowCondition** | Animasyonun ne zaman calisacagi | `nonZero`: deger > 0 ise, `boolean`: truthy ise, `always`: her zaman |
| **flowSpeed** | Animasyon hizi (saniye) | Varsayilan: 2 (dusuk = hizli) |
| **reverseOnNegative** | Negatif degerde yonu ters cevir | `true` / `false` |

**Ornek Senaryo -- Pompa Kaynakli Akis:**

Pompa calistiginda (`pump1_running = 1`) boru hattinda su akis animasyonu goster, pompa durdugundan (`pump1_running = 0`) animasyonu durdur:

- **tagName:** `pump1_running`
- **flowCondition:** `boolean`
- **flowSpeed:** `1.5` (hizli akis)
- **reverseOnNegative:** `false`

**Renk ile Birlesim:**
Farkli connection type'lar farkli renklerde gosterilir. Ornegin:
- Temiz su hatti: Siyah duz cizgi + akis animasyonu
- Sicak su hatti: Turuncu buhar cizgisi + akis animasyonu
- Kirli su hatti: Cyan drenaj cizgisi + akis animasyonu

---

## 5. Tag Binding -- Sensor Verisini Baglama

### 5.1 Tag Nedir?

Tag, bir sensorun veya cihazin belirli bir veri kanalini tanimlayan benzersiz kimliktir. SCADA sisteminde tum veri akisi tag'ler uzerinden gerceklesir.

**Tag Format Ornekleri:**

| Tag | Aciklama |
|-----|----------|
| `temperature_1` | 1 numarali sicaklik sensoru |
| `ph_sensor` | pH olcum sensoru |
| `pump_1.status` | 1 numarali pompanin calisma durumu |
| `pump_1.speed` | 1 numarali pompanin hizi |
| `tank_1.level` | 1 numarali tankin doluluk seviyesi |
| `vfd_1.frequency` | 1 numarali VFD'nin calisma frekansi |
| `do_sensor` | Cozunmus oksijen sensoru |

### 5.2 Widget'a Tag Baglama

**Adim Adim:**

1. Canvas'te tag baglamak istediginiz widget'a tiklayin.
2. Sag taraftaki **Properties Panel** acilir.
3. **Tag** alaninin yanindaki **Tag Browser** butonuna tiklayin.
4. Tag Browser acilir -- ust kisimda cihaz listesi gorunur.
5. Cihazinizi secin (ornegin: "Edge Device 001").
6. Cihazin altindaki kanallar listelenir -- istediginiz kanali secin.
7. Secilen tag otomatik olarak **Tag** alanina yazilir.
8. Widget artik o tag'den gelen canli veriylegosterim yapar.

**Tag Browser Ozellikleri:**
- Cihaza gore filtreleme
- Kanal adina gore arama
- Son kullanilan tag'ler listesi
- Tag tipi gosterimi (AI, AO, DI, DO)

### 5.3 Coklu Tag Binding

Bazi widget'lar birden fazla tag destekler:

- **Trend Chart:** Birden fazla tag ekleyerek coklu cizgi grafik olusturabilirsiniz.
- **FUXA Widget:** Her degiskene ayri tag baglanabilir (per-variable binding).

### 5.4 Expression Binding (Hesaplanmis Deger)

Gauge ve ProgressBar widget'larinda tag degerini dogrudan gostermek yerine bir formul ile hesaplanmis deger gosterebilirsiniz.

**Kullanim Alanlari:**
- Birim donusumu (Fahrenheit'tan Celsius'a)
- Birden fazla tag'in ortalamasi
- Esik tespiti
- Olcekleme (scaling)

### 5.5 Tag ile Animasyon

Widget'lar tag degerine bagli olarak cesiitli animasyonlar gosterebilir:

| Animasyon Tipi | Aciklama | Ornek |
|----------------|----------|-------|
| **Renk Degisimi** | Degere gore arka plan veya metin rengi degisir | pH < 6: Kirmizi, 6-8: Yesil, > 8: Mavi |
| **Dondurme** | Deger > 0 oldugunda sembol doner | Pompa calisirken fan donmesi |
| **Doluluk** | Deger yuzdesine gore doluluk degisir | Tank seviye animasyonu |
| **Kosullu Gorunurluk** | Belirli degerde widget gorunur/gizlenir | Ariza durumunda uyari ikonu gorunur |
| **Yanip Sonme** | Alarm durumunda yanip soner | Kritik alarm durumunda status gostergesi |

---

## 6. Modlar

### 6.1 Edit Mode (Duzenleme Modu)

Ekraninizi tasarladiginiz moddur. Tum duzenleme islemleri bu modda yapilir.

**Yapilabilecek Islemler:**

| Islem | Nasil |
|-------|-------|
| Widget Ekleme | Widget Palette'den surukle-birak |
| Widget Tasima | Widget'a tikla, surukle |
| Widget Boyutlandirma | Widget kenarlarindan surukle |
| Widget Silme | Widget'i sec, Delete tusu |
| Kopyala/Yapistir | Ctrl+C, Ctrl+V |
| Geri Al / Yinele | Ctrl+Z / Ctrl+Y |
| Coklu Secim | Shift+Tiklama ile birden fazla widget sec |
| Gruplama | Birden fazla widget secili iken Ctrl+G |
| Hizalama | Alignment Toolbar ile sola, ortaya, saga, uste, alta hizala |
| Widget Kilitleme | Sag-tik menusuunden "Kilitle" -- tasima ve boyutlandirmayi engeller |
| Baglanti Cizme | Widget handle'indan surukle |
| Ozellik Duzenleme | Widget tikla, sag panelde Properties duzenle |
| Context Menu | Sag tik: kopyala, sil, kilitle, grup islemleri |

**Grup Surekleme:**
Gruplu widget'lar birlikte tasiniir. Grubun bir elemanini suruklerseniz, tum grup uyeleleri ayni delta kadar hareket eder.

**Smart Guides (Akilli Kilavuzlar):**
Widget suruklerken, diger widget'larla hizalama noktlalarinda kilavuz cizgileri otomatik olarak gorunur. Bu, widget'lari duzgun hizalamaniza yardimci olur.

---

### 6.2 Preview Mode (Onizleme Modu)

Canli veri ile calisma modudur. Widget'lar gercek sensor verilerini gosterir ve kontrol widget'lari aktif hale gelir.

**Ozellikler:**
- Tum tag'lere bagli widget'lar canli veri gosterir
- Toggle Switch, Slider, Push Button gibi kontrol widget'lari aktiftir
- Duzenleme devre disidir -- widget tasima, silme yapilamaz
- Tam ekran gorunnumu destegi
- Akis animasyonlari tag degerlerine gore calisir

**Canli Veri Akisi:**
Widget'lar `ScadaDataProvider` uzerinden cihaz koduna ve tag adina gore canli deger okur:
```
deviceCode + tagName --> ScadaDataProvider.getTagValue() --> Widget goruntuleme
```

---

### 6.3 Simulation Mode (Simulasyon Modu)

Gercek cihazlara baglanmadan sahte veri ile tum sistemi test etmenizi saglar.

**Kullanim Alanlari:**
- Yeni ekran tasarimlarini gercek veriye ihtiyac duymadan test etme
- Alarm senaryolarini simule etme (esik degerleri asildiginda ne olur?)
- Animasyon davranislarini dogrulama
- Egitim amacli gosterimler

**Widget pozisyonlari modlar arasinda korunur** -- Edit Mode'dan Preview'e gectiginizde widget konumlari bozulmaz.

---

## 7. Animasyon Olusturma -- Adim Adim

Bu bolumde, aquaculture tesisleri icin tipik SCADA animasyonlarini adim adim olusturmayi ogreneceksiniz.

### 7.1 Pompa Animasyonu

Bir pompanin calisma durumuna gore donme animasyonu ve renk degisimi.

**Adim 1 -- Equipment Widget Ekle:**
1. Widget Palette'den **Equipment** kategorisini acin.
2. **Centrifugal Pump** (Santrifuj Pompa) secin.
3. Canvas'te istediginiz konuma surukleyin.

**Adim 2 -- Status Tag Baglaysin:**
1. Pompaya tiklayin, Properties Panel'de **Tag** alanini acin.
2. Tag Browser'dan `pump_1.status` tag'ini secin.

**Adim 3 -- Animasyon Kurallarini Belirleyin:**
- Tag degeri `1` (Running) --> Pompa sembolu yesillesir ve doner
- Tag degeri `0` (Stopped) --> Pompa sembolu grileseir ve durur
- Tag degeri `2` (Fault) --> Pompa sembolu kirmizilesir

**Adim 4 -- Boru Baglantisi Ekleyin:**
1. Pompa'nin cikis noktasindan (outlet) surukleyerek hedef widget'a (ornegin bir tanka) baglayin.
2. Baglanti tipini `process-pipe` olarak secin.
3. Edge'in **FlowConfig** ayarlarini yapin:
   - **tagName:** `pump_1.status`
   - **flowCondition:** `boolean`
   - **flowSpeed:** `1.5`

**Adim 5 -- Sonuc:**
- Pompa calistiginda: Pompa yesil, boru hattinda su akar
- Pompa durdugnda: Pompa gri, boru hattinda akis durur
- Pompa arizalandiginda: Pompa kirmizi

---

### 7.2 Tank Dolum Animasyonu

Bir su tankinin doluluk seviyesini animasyonlu olarak gosterme.

**Adim 1 -- Tank Level Widget Ekle:**
1. Widget Palette'den **Tank Level** secin.
2. Canvas'e surukleyin (2x4 hucre yer kaplar).

**Adim 2 -- Level Tag Bagla:**
1. Tank'a tiklayin.
2. **Tag** alaninda `tank_1.level` secin.

**Adim 3 -- Min/Max Ayarla:**
- **Min:** 0
- **Max:** 100
- **Unit:** `%`

**Adim 4 -- Label Ayarla:**
- **Label:** "Temiz Su Tanki"

**Adim 5 -- Sonuc:**
- Seviye %75 ise, tank gorseli %75 dolu goruntulenir
- Su animasyonu (dalga efekti) aktiftir
- Seviye degerinin azalmasi/artmasi gercek zamanli yansir

**Alarm Esiklerini Ekleyin (Opsiyonel):**
Status Indicator widget'i ekleyerek tank seviyesi alarmlarinii gorsellestirebilirsiniz:
- Seviye < %20: Sari uyari
- Seviye < %10: Kirmizi alarm
- Seviye > %95: Kirmizi tasma alarmi

---

### 7.3 Sicaklik Renk Haritasi

Gauge widget ile sicaklik degerine gore renk bandi gosterimi.

**Adim 1 -- Gauge Widget Ekle:**
1. Widget Palette'den **Gauge** secin, canvas'e surukleyin.

**Adim 2 -- Temperature Tag Bagla:**
1. **Tag:** `water_temp` secin.

**Adim 3 -- Renk Bantlari Ekle:**
1. **Min:** 0, **Max:** 40
2. **Unit:** `degreeC`, **Decimals:** 1
3. Zones bolumunde:
   - Zone 1: Min=0, Max=15, Renk=Mavi (dusuk sicaklik)
   - Zone 2: Min=15, Max=25, Renk=Yesil (ideal aralik)
   - Zone 3: Min=25, Max=40, Renk=Kirmizi (yuksek sicaklik)

**Adim 4 -- Sonuc:**
- Su sicakligi 12 derece ise gauge mavi bolgede gosterir
- 22 derece ise yesil bolgede
- 30 derece ise kirmizi bolgede -- operator hemen durumu gorur

---

### 7.4 VFD Kontrol Paneli Animasyonu

Bir frekans donusturucunun tam kontrol panelini olusturma.

**Adim 1 -- Numeric Display (Frekans Gostergesi):**
1. **Numeric Display** ekleyin.
2. **Tag:** `vfd_1.frequency`
3. **Label:** "Calisma Frekansi"
4. **Unit:** `Hz`
5. **Decimals:** 1

**Adim 2 -- Slider (Frekans Ayari):**
1. **Slider** ekleyin.
2. **Tag:** `vfd_1.frequency_setpoint`
3. **Label:** "Frekans Ayari"
4. **Min:** 0, **Max:** 50, **Step:** 0.5
5. **Unit:** `Hz`
6. **Security:** `Confirmation Required`

**Adim 3 -- Toggle Switch (Start/Stop):**
1. **Toggle Switch** ekleyin.
2. **Tag:** `vfd_1.command`
3. **Label:** "Motor Kontrolu"
4. **ON Label:** "CALISTIR"
5. **OFF Label:** "DURDUR"
6. **Security:** `Confirmation Required`

**Adim 4 -- Status Indicator (Durum):**
1. **Status Indicator** ekleyin.
2. **Tag:** `vfd_1.status`
3. **ON Label:** "CALISIYOR"
4. **OFF Label:** "DURDU"
5. **Active Color:** Yesil
6. **Color Ranges:**
   - 0: Gri (Durdu)
   - 1: Yesil (Calisiyor)
   - 2: Kirmizi (Ariza)

**Adim 5 -- Gauge (Motor Akimi):**
1. **Gauge** ekleyin.
2. **Tag:** `vfd_1.current`
3. **Label:** "Motor Akimi"
4. **Min:** 0, **Max:** 20
5. **Unit:** `A`
6. **Zones:** 0-10 Yesil, 10-15 Sari, 15-20 Kirmizi

**Adim 6 -- Duzenleme:**
1. Tum widget'lari yakin konumlara yerlestirin.
2. Shift+tiklama ile hepsini secin.
3. Ctrl+G ile gruplayin -- artik birlikte tasinirlar.

---

### 7.5 Tam Proses Ekrani Olusturma

Aquaculture tesisinin tam su aritma prosesini gorsel olarak olusturma.

**Tasarim Plani:**

```
[Alarm Banner -- tam genislik]
-----------------------------------------
[Su Giris]-->[Pompa 1]-->[Radyal Filtre]-->[MBBR]-->[Temiz Su Tanki]-->[Cikis]
                                                              |
                                                     [Kirli Su Tanki]
-----------------------------------------
[Trend Chart -- sicaklik, pH, DO]
```

**Adim 1 -- Alarm Banner (Ust Kisim):**
1. **Alarm Banner** ekleyin, ekranin en ustune tam genislikte yerlestirin (12x2).

**Adim 2 -- Ekipman Widget'lari Ekleyin:**
1. **Equipment > Submersible Pump** -- "Besleme Pompasi" olarak etiketleyin
2. **Radial Filter** -- "On Filtre" olarak etiketleyin
3. **MBBR** -- "Biyolojik Filtre" olarak etiketleyin
4. **Clean Water Tank** -- "Temiz Su Deposu"
5. **Dirty Water Tank** -- "Atik Su Deposu"
6. Her birine uygun tag'leri baglayin

**Adim 3 -- Boru Hatlari Cizin:**
1. Pompa cikisindan filtreye: `process-pipe`, orthogonal edge
2. Filtreden MBBR'ye: `process-pipe`
3. MBBR'den temiz su tankina: `process-pipe`
4. Filtreden kirli su tankina (geri devir): `drain-vent`
5. Her boru hattina FlowConfig ekleyin -- pompanin calisma durumuna bagli akis animasyonu

**Adim 4 -- Izleme Widget'lari Ekleyin:**
1. Pompa yaninda: **Status Indicator** + **Numeric Display** (akim)
2. Filtre yaninda: **Gauge** (basinc fark)
3. Tank yaninda: **Tank Level** (doluluk seviyesi)
4. Her birinde: **Numeric Display** (sicaklik)

**Adim 5 -- Kontrol Widget'lari Ekleyin:**
1. Pompa yaninda: **Toggle Switch** (start/stop)
2. Valf noktalarinda: **Toggle Switch** (ac/kapat)
3. Ekranin kosesinde: **Emergency Stop** butonu

**Adim 6 -- Trend Chart (Alt Kisim):**
1. **Trend Chart** ekleyin (6x4).
2. Tag'leri ekleyin: `water_temp`, `ph_sensor`, `do_sensor`
3. **Default Range:** 24 Saat
4. **Show Grid:** Acik
5. **Show Legend:** Acik

**Adim 7 -- Navigasyon:**
1. **Screen Link** widget'i ekleyerek "Detayli Pompa Ekrani", "Alarm Gecmisi" gibi alt ekranlara gecis butonlari olusturun.

---

## 8. Ekran Yonetimi

### 8.1 Ekranlar Arasi Gezinme

**Screen Link Widget'i ile:**
1. Kaynak ekrana **Screen Link** widget'i ekleyin.
2. **Target Screen** olarak hedef ekrani secin.
3. **Label** ile buton yazisini belirleyin.
4. Preview Mode'da butona tiklaymak sizi hedef ekrana goturur.

**Navigasyon Menusu ile:**
Sol taraftaki ekran listesinden herhangi bir ekrana tiklayarak gecis yapabilirsiniz.

**Viewport Hafizasi:**
Ekranlar arasinda gecis yaptiginizda, her ekranin zoom ve kaydirma konumu hatirlanir. Geri dondugguunuzde kaliginiz yere donersiniz.

### 8.2 Ekran Sablonlari

Sik kullanilan ekran duzenlelerini sablon olarak kaydedebilir ve yeni ekranlarda tekrar kullanabilirsiniz.

**Sablon Turlerio:**
- Dashboard sablonu -- genel ozet paneli
- Process sablonu -- standart proses akis diyagrami
- Alarm sablonu -- alarm izleme ekrani
- Control sablonu -- kontrol paneli

### 8.3 SCADA Paketi

SCADA ekranlarinn bir paket olarak yonetilir:
- **Disa Aktarma:** Tum ekranlari, widget'lari ve ayarlari JSON formatinda indirebilirsiniz.
- **Ice Aktarma:** Daha once kaydedilmis bir paketi yukleyebilirsiniz.
- **Versiyon Yonetimi:** Her degisiklik kaydedilir ve geri alinabilir.

---

## 9. Ipuclari ve En Iyi Uygulamalar

### 9.1 Widget Boyutlandirma Standartlari

| Widget Kategorisi | Onerilen Boyut | Aciklama |
|-------------------|----------------|----------|
| Sayisal gostergeler | 2x2 | Kompakt, cok sayida yerlestirilebilir |
| Gauge'ler | 3x3 | Okunabilirlik icin yeterli buyuklukte |
| Kontrol butonlari | 2x2 | Kolay erisim icin |
| Trend chartlar | 6x4 veya daha buyuk | Detayli grafik icin genis alan |
| Alarm banner | 12x2 | Tam genislik -- her zaman en ustte |
| Emergency stop | 2x4 | Buyuk, goze carpan |

### 9.2 Renk Paleti Onerileri

**Endiistriyel Standart Alarm Renkleri (ANSI/ISA-101.01):**

| Renk | Anlam | Hex Kodu |
|------|-------|----------|
| Kirmizi | Kritik alarm, acil durum | #ef4444 |
| Turuncu | Yuksek oncelikli uyari | #f97316 |
| Sari | Uyari (dusuk oncelik) | #eab308 |
| Yesil | Normal calisma | #22c55e |
| Mavi | Bilgilendirme | #3b82f6 |
| Gri | Devre disi, durmus | #9ca3af |
| Mor | Veri/haberlesme | #7c3aed |

### 9.3 Performans Tavsiyeleri

- **Widget Siniri:** Tek bir ekranda 50'den fazla widget eklemeyin. Cok fazla widget performansi dusurebilir.
- **Trend Chart Optimizasyonu:** Cok uzun zaman araiklari (30 gun) yerine 24 saat varsayilan kullanin.
- **Gorsel Basitlik:** Her ekranda tek bir proses bolumunu gosterin; tum tesisi tek ekrana sigdirmaya calismayin.
- **Ekran Bolumleme:** Karmasik tesislerde birden fazla ekran olusturun (Ana Proses, Pompalar, Valfler, Alarmlar) ve Screen Link ile birbirine baglayin.

### 9.4 Mobil Uyumluluk

- Widget'lari yeterince buyuk boyutlandirin (dokunmatik erisim icin en az 2x2).
- Kontrol widget'larinda **Security Level** kullanin -- kazara dokunmay onler.
- Tek sutun duzeni tercih edin (12 sutunluk grid'de 6'dan genis widget'lar kullanin).

### 9.5 Guvenlik En Iyi Uygulamalari

- Tum kontrol widget'larinda **Confirmation Required** veya **PIN Required** guvenlik seviyesi kullanin.
- **Emergency Stop** butonu her kontrol ekraninda bulunmalidir.
- VFD programlama islemleri icin **Maker-Checker** onay sureci zorunludur.
- FUXA widget'lari iframe sandbox icinde calisir -- script kodlari ana uygulamadan izoledir.
- FUXA SVG dosya boyutu 1 MB ile sinirlidir.

---

## 10. Kisayol Tuslari

| Kisayol | Islem |
|---------|-------|
| `Ctrl + Z` | Geri Al (Undo) |
| `Ctrl + Y` | Yinele (Redo) |
| `Ctrl + C` | Secili widget'i kopyala |
| `Ctrl + V` | Yapistir |
| `Delete` / `Backspace` | Secili widget'i veya baglantiyi sil |
| `Ctrl + A` | Tum widget'lari sec |
| `Ctrl + G` | Secili widget'lari grupla |
| `Shift + Tik` | Coklu secim (mevcut secime ekle/cikar) |
| `Ctrl + Scroll` | Yakinlastir / Uzaklastir (Zoom) |
| `Sag Tik` | Context menu (kopyala, sil, kilitle, grup islemleri) |
| `Cift Tik (Widget)` | Faceplate / detay paneli ac |
| `Cift Tik (Edge Segmenti)` | Donus noktasi ekle (orthogonal edge) |
| `Sag Tik (Edge Donus Noktasi)` | Donus noktasini sil |
| `Bos Alana Tik` | Secimi kaldir |

---

**Bu kilavuz, RuFlo Aquaculture Platform v3 SCADA Builder sistemi icin hazirlanmistir.**
**Teknik sorulariniz icin platform yoneticinize basvurun.**
