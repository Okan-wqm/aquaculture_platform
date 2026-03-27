# VFD Yonetim Sistemi — Kullanim Kilavuzu

**Platform:** Aquaculture SaaS
**Versiyon:** 1.0
**Tarih:** 2026-03-26
**Hedef Kitle:** Muhendisler, Operatorler, Tesis Yoneticileri
**Standartlar:** IEC 61800-7-201, IEC 62443 SL-2, ISA-95 Level 2-3

---

## Icindekiler

1. [Giris](#1-giris)
2. [VFD Cihaz Kaydi (Registration Wizard)](#2-vfd-cihaz-kaydi-registration-wizard)
3. [Gercek Zamanli Izleme (Monitoring)](#3-gercek-zamanli-izleme-monitoring)
4. [Komut Gonderme (Runtime Control)](#4-komut-gonderme-runtime-control)
5. [Uzaktan Programlama (Remote Programming)](#5-uzaktan-programlama-remote-programming)
6. [Otomasyon Kurallari](#6-otomasyon-kurallari)
7. [Sorun Giderme (Troubleshooting)](#7-sorun-giderme-troubleshooting)
8. [Guvenlik ve Uyumluluk](#8-guvenlik-ve-uyumluluk)
9. [Terimler Sozlugu](#9-terimler-sozlugu)

---

## 1. Giris

### 1.1 VFD (Variable Frequency Drive) Nedir?

VFD (Degisken Frekansl Surucu), bir elektrik motorunun hizini, torkunu ve donme yonunu kontrol etmek icin kullanilan bir guc elektronigi cihazdir. Alternatif akim (AC) motorlarin besleme frekansini ve gerilimini degistirerek motor hizini hassas bicimde ayarlar.

Aquaculture tesislerinde VFD'ler su uygulamalarda kritik oneme sahiptir:

- **Su pompalari:** Havuz dolum, tahliye ve sirkülasyon pompalari
- **Aeratorler:** Cozunmus oksijen (DO) seviyesini kontrol eden havalandirma sistemleri
- **Filtrasyon pompalari:** Mekanik ve biyolojik filtrelerin beslenme hizi
- **Besleme sistemleri:** Otomatik yem dagitim konveyorleri
- **Isitma/sogutma sirkülasyon pompalari:** Su sicakligi kontrolu

### 1.2 Platformdaki VFD Modulunun Kapsami

Aquaculture platformunun VFD modulu su yetenekleri saglar:

| Yetenek | Aciklama |
|---------|----------|
| Cihaz Kaydi | 8 farkli marka VFD'yi destekleyen wizard tabanli kayit |
| Gercek Zamanli Izleme | Motor frekansi, akim, gerilim, hiz, tork, sicaklik izleme |
| Komut Gonderme | Calistir, durdur, frekans ayarla, acil durus gibi runtime komutlari |
| Uzaktan Programlama | Maker-Checker onay sureci ile guvenli parametre degisikligi |
| Otomasyon Kurallari | Sensor verilerine dayali otomatik VFD parametre ayarlama |
| Denetim Kaydlari | Tum degisikliklerin kalici audit trail kaydi |

### 1.3 Desteklenen Markalar ve Protokoller

| Marka | Model Serileri | Desteklenen Protokoller |
|-------|---------------|----------------------|
| **Danfoss** | FC102, FC302, FC51, VLT 2800, VLT 5000, VLT 6000, VLT HVAC | Modbus RTU, Modbus TCP, Profibus DP, Profinet, EtherNet/IP, CANopen, BACnet/IP |
| **ABB** | ACS580, ACS880, ACS355, ACS310, ACS550, ACS800, ACS1000 | Modbus RTU, Modbus TCP, Profibus DP, Profinet, EtherNet/IP, CANopen, BACnet/IP |
| **Siemens** | G120, G120C, G120D, G120P, G130, S120, MICROMASTER 440 | Modbus RTU, Modbus TCP, Profibus DP, Profinet, CANopen, BACnet/IP |
| **Schneider Electric** | Altivar 12, 312, 320, 340, 600, 900, Process | Modbus RTU, Modbus TCP, Profibus DP, Profinet, EtherNet/IP, CANopen, BACnet/IP |
| **Yaskawa** | A1000, V1000, J1000, GA500, GA700, U1000, Z1000 | Modbus RTU, Modbus TCP, Profibus DP, Profinet, EtherNet/IP, CANopen |
| **Delta Electronics** | VFD-E, VFD-EL, VFD-C, VFD-CP, VFD-M, VFD-MS300, VFD-C2000 | Modbus RTU, Modbus TCP, CANopen |
| **Mitsubishi Electric** | FR-A800, FR-E800, FR-F800, FR-D700, FR-A700, FR-E700 | Modbus RTU, Modbus TCP, Profinet, EtherNet/IP, BACnet/IP |
| **Rockwell Automation** | PowerFlex 523, 525, 527, 700, 753, 755 | Modbus RTU, Modbus TCP, Profinet, EtherNet/IP |

### 1.4 Kullanici Rolleri ve Yetkileri

| Islem | VIEWER | OPERATOR | MODULE_MANAGER | TENANT_ADMIN |
|-------|--------|----------|----------------|--------------|
| Parametreleri goruntule | Evet | Evet | Evet | Evet |
| Degisiklik setlerini goruntule | Evet | Evet | Evet | Evet |
| Denetim kayitlarini goruntule | Evet | Evet | Evet | Evet |
| Runtime komut gonder (Start/Stop) | Hayir | Evet | Evet | Evet |
| Degisiklik seti olustur (Maker) | Hayir | Hayir | Evet | Evet |
| Degisiklik setini onayla (Checker) | Hayir | Hayir | Hayir | Evet |
| Degisiklik setini reddet | Hayir | Hayir | Hayir | Evet |
| Acil geri alma (Emergency Rollback) | Hayir | Hayir | Evet | Evet |
| Otomasyon kurali olustur | Hayir | Hayir | Hayir | Evet |
| Otomasyon kuralini ac/kapat | Hayir | Hayir | Evet | Evet |
| Otomatik uygula ayari (requiresApproval=false) | Hayir | Hayir | Hayir | Evet |

---

## 2. VFD Cihaz Kaydi (Registration Wizard)

### 2.1 Yeni VFD Ekleme

Yeni bir VFD cihazi sisteme eklemek icin 6 adimlik bir kayit sihirbazi (wizard) kullanilir. Wizard'a **Sensorler > VFD Yonetimi** sayfasindan "Yeni VFD Ekle" butonuyla erisilebilir.

#### Adim 1: Marka Secimi

Ilk adimda VFD cihaznizin markasini secin. Markalar iki gruba ayrilmistir:

**Populer Markalar** (en sik kullanilan):
- Danfoss
- ABB
- Siemens
- Schneider Electric

**Diger Markalar:**
- Yaskawa
- Delta Electronics
- Mitsubishi Electric
- Rockwell Automation

Marka secimi yapildiginda, o markaya ait desteklenen protokoller, model serileri ve varsayilan iletisim ayarlari otomatik olarak yuklenir.

> **Ipucu:** Marka secimi yapmadan once VFD cihazinizin etiket bilgilerini (nameplate) kontrol edin. Marka ve model bilgisi etiketin uzerinde yazmaktadir.

#### Adim 2: Protokol Secimi

VFD ile platform arasindaki iletisim protokolunu secin. Desteklenen protokoller markaya gore degisir:

| Protokol | Fiziksel Ortam | Varsayilan Port | Aciklama |
|----------|---------------|----------------|----------|
| **Modbus RTU** | RS-485 seri hat | - | En yaygin, tum markalarda mevcut, kablolu 2-telli baglanti |
| **Modbus TCP** | Ethernet | 502 | IP tabanli Modbus, uzak erisim icin ideal |
| **Profibus DP** | RS-485 ozel | - | Siemens ekosistemleri icin yaygin, yuksek hiz |
| **Profinet** | Ethernet | - | Gercek zamanli Ethernet, Siemens ve diger markalarla |
| **EtherNet/IP** | Ethernet | 44818 | Rockwell/Allen-Bradley ekosistemleri icin standart |
| **CANopen** | CAN bus | - | Kompakt cihazlar icin, dusuk maliyet |
| **BACnet/IP** | Ethernet | 47808 | Bina otomasyon entegrasyonu icin |
| **BACnet MS/TP** | RS-485 seri hat | - | BACnet'in seri hat versiyonu |

> **Ipucu:** Aquaculture tesislerinde en yaygin kullanilan protokoller **Modbus RTU** (mevcut RS-485 altyapisi icin) ve **Modbus TCP** (yeni Ethernet tabanli kurulumlar icin) protokolleridir.

#### Adim 3: Model Secimi ve Temel Bilgiler

Bu adimda asagidaki bilgileri girin:

- **Model Serisi:** VFD cihazinizin model serisini secin (ornegin: Danfoss icin FC302)
- **Cihaz Adi:** Tesisinizde kolay tanimlanabilir bir ad verin (ornegin: "Giris Pompa VFD #1")
- **Konum:** Cihazin fiziksel konumu (ornegin: "B Blok, Panel-3")
- **Aciklama:** Opsiyonel not alani

#### Adim 4: Baglanti Konfigurasyonu

Sectiginiz protokole gore baglanti parametrelerini yapilandirin:

**Modbus RTU Baglantisi:**

| Parametre | Aciklama | Varsayilan Deger |
|-----------|----------|-----------------|
| Seri Port | Fiziksel port adi | COM1 veya /dev/ttyUSB0 |
| Slave ID | VFD'nin Modbus adresi (1-247) | 1 |
| Baud Rate | Iletisim hizi | Markaya gore degisir (asagidaki tabloya bakin) |
| Data Bits | Veri bit sayisi | 8 |
| Parity | Eslik kontrolu | Markaya gore degisir |
| Stop Bits | Durus bit sayisi | Markaya gore degisir |
| Timeout | Yanit bekleme suresi | 1000 ms |
| Retry Count | Tekrar deneme sayisi | 3 |

**Markalara Gore Varsayilan Seri Iletisim Ayarlari:**

| Marka | Baud Rate | Data Bits | Parity | Stop Bits |
|-------|-----------|-----------|--------|-----------|
| Danfoss | 9600 | 8 | None | 1 |
| ABB | 9600 | 8 | None | 1 |
| Siemens | 9600 | 8 | Even | 1 |
| Schneider | 19200 | 8 | Even | 1 |
| Yaskawa | 9600 | 8 | None | 2 |
| Delta | 9600 | 8 | None | 1 |
| Mitsubishi | 9600 | 8 | None | 1 |
| Rockwell | 19200 | 8 | None | 1 |

> **UYARI:** VFD uzerindeki iletisim ayarlari ile burada girdiginiz ayarlar **birebir eslesmelidir**. Aksi halde baglanti kurulamaz. VFD'nin kendi panelinden veya mevcut yapilandirma yazilimindanbu ayarlari dogrulayin.

**Modbus TCP Baglantisi:**

| Parametre | Aciklama | Varsayilan Deger |
|-----------|----------|-----------------|
| IP Adresi | VFD'nin IP adresi | - (zorunlu) |
| Port | TCP port numarasi | 502 |
| Unit ID | Modbus birim adresi | 1 |
| Baglanti Timeout | Baglanti kurma suresi | 5000 ms |
| Yanit Timeout | Yanit bekleme suresi | 3000 ms |
| Baglantiyi Canli Tut | Keep-alive ozelligi | Evet |

**Profinet Baglantisi:**

| Parametre | Aciklama | Varsayilan Deger |
|-----------|----------|-----------------|
| Device Name | PROFINET cihaz adi | - (zorunlu) |
| IP Adresi | Cihaz IP adresi | - (zorunlu) |
| Subnet Mask | Alt ag maskesi | 255.255.255.0 |
| Update Rate | Guncelleme periyodu | 32 ms |

**EtherNet/IP Baglantisi:**

| Parametre | Aciklama | Varsayilan Deger |
|-----------|----------|-----------------|
| IP Adresi | Cihaz IP adresi | - (zorunlu) |
| Port | TCP port numarasi | 44818 |
| RPI | Requested Packet Interval | 10 ms |
| Connection Type | Baglanti tipi | Exclusive Owner |

#### Adim 5: Baglanti Testi

Bu adimda platform, VFD cihaziyla deneme iletisimi kurar. Test sirasinda:

1. Fiziksel baglanti kontrol edilir
2. Protokol el sikismasi (handshake) yapilir
3. Status word okunur (cihazin durumu)
4. Temel motor parametreleri okunarak dogrulanir (frekans, akim, gerilim)
5. Iletisim istatistikleri hesaplanir (gecikme, hata sayisi)

**Basarili test sonucu:**
- Cihaz bilgileri goruntulenir (uretici, model, firmware versiyonu)
- Anlik parametreler gosterilir (frekans, hiz, akim, gerilim)
- Durum bilgileri listelenir (Hazir, Calisiyor, Ariza, vb.)
- Iletisim istatistikleri goruntulenir (gonderilen/alinan paket, ortalama gecikme)

**Basarisiz test sonucu:**
- Hata mesaji ve hata kodu goruntulenir
- Kontrol edilecek maddeler listesi sunulur

> **Ipucu:** Baglanti testi opsiyoneldir ve "Test Atla" butonuyla gecebilirsiniz. Ancak cihazin dogru calistigini dogrulamak icin test yapmaniz siddette onerilir.

#### Adim 6: Inceleme ve Kayit

Son adimda tum yapilandirma ozet olarak goruntulenir:

- Secilen marka ve model
- Protokol ve baglanti ayarlari
- Baglanti testi sonucu (yapildiysa)
- Cihaz bilgileri

"VFD Kaydet" butonuna tikladiginizda cihaz sisteme kaydedilir ve `DRAFT` durumunda baslatilir.

### 2.2 VFD Cihaz Durumlari

Bir VFD cihazi asagidaki durum gecislerini izler:

```
DRAFT --> PENDING_TEST --> TESTING --> ACTIVE
                                  --> TEST_FAILED
```

| Durum | Aciklama | Yapilabilecek Islemler |
|-------|----------|----------------------|
| **DRAFT** | Cihaz kaydedildi ancak henuz test edilmedi | Duzenle, sil, teste gonder |
| **PENDING_TEST** | Test kuyrugunda bekliyor | Iptal et |
| **TESTING** | Baglanti testi yapiliyor | Bekle |
| **ACTIVE** | Cihaz aktif ve kullanima hazir | Komut gonder, izle, programla, askiya al |
| **TEST_FAILED** | Baglanti testi basarisiz oldu | Yeniden test et, yapilandirmayi duzenle, sil |
| **SUSPENDED** | Cihaz gecici olarak askiya alindi | Aktif et, sil |
| **OFFLINE** | Cihaz cevrimdisi (iletisim kesik) | Yeniden baglanti dene |

> **UYARI:** Yalnizca `ACTIVE` durumundaki cihazlara komut gonderilebilir ve parametre programlanabilir.

### 2.3 VFD Cihaz Listesi

VFD Yonetimi sayfasinda tum kayitli cihazlar tablo halinde listelenir. Filtreleme secenekleri:

- **Marka:** Danfoss, ABB, Siemens, vb.
- **Durum:** Active, Draft, Test Failed, vb.
- **Protokol:** Modbus RTU, Modbus TCP, vb.
- **Konum:** Tesis icindeki fiziksel konum

Her cihaz icin hizli islem butonlari:
- Detay goruntulemek icin cihaz adina tiklayin
- Cihazi silmek icin cop kutusu ikonuna tiklayin (yalnizca `DRAFT` veya `TEST_FAILED` durumundaki cihazlar silinebilir)
- Aktif cihazi askiya almak icin duraklat ikonuna tiklayin

---

## 3. Gercek Zamanli Izleme (Monitoring)

### 3.1 Okunan Parametreler

VFD cihaz detay sayfasinda asagidaki parametreler gercek zamanli olarak izlenir:

#### Motor Parametreleri

| Parametre | Aciklama | Birim | Ornek Deger |
|-----------|----------|-------|------------|
| Cikis Frekansi | Motorun anlik calisma frekansi | Hz | 42.5 |
| Motor Akimi | Motordan cekilen anlik akim | A | 12.34 |
| Motor Gerilimi | Motor uclarindaki gerilim | V | 380.2 |
| Motor Hizi | Motorun donme hizi | RPM | 1425 |
| Motor Torku | Nominal torka orani | % | 78.5 |
| Cikis Gucu | Motor cikis gucu | kW | 5.5 |
| DC Bus Gerilimi | Arac baga gerilim | V | 540.0 |
| Guc Faktoru | Anlik guc faktoru | - | 0.85 |
| Hiz Referansi | Aktif hiz referans degeri | Hz | 45.0 |

*Danfoss FC serisi icin register adresleri: Cikis Frekansi = 16129 (P16-13), Motor Akimi = 16139 (P16-14), Motor Gerilimi = 16119 (P16-12), Motor Hizi = 16169 (P16-17)*

#### Termal Parametreler

| Parametre | Aciklama | Birim | Ornek Deger |
|-----------|----------|-------|------------|
| Sogutma Sicakligi | Surucu sogutucu yuzey sicakligi | degC | 45.2 |
| Kontrol Karti Sicakligi | Elektronik kart sicakligi | degC | 38.7 |
| Motor Termal Yuku | Hesaplanan motor termal durumu | % | 62 |

#### Enerji Parametreleri

| Parametre | Aciklama | Birim | Ornek Deger |
|-----------|----------|-------|------------|
| Calisma Saati | Toplam motor calisma suresi | saat | 12,450 |
| Guc Acik Saati | Toplam surucu acik kalma suresi | saat | 15,200 |
| Enerji Tuketimi | Toplam elektrik tuketimi | kWh | 85,600 |
| Baslatma Sayisi | Toplam motor baslatma adedi | adet | 3,241 |

#### Ariza Parametreleri

| Parametre | Aciklama | Birim |
|-----------|----------|-------|
| Alarm Word | Aktif alarmlarin bit haritas | bitmap |
| Warning Word | Aktif uyarilarin bit haritasi | bitmap |
| Fault Code | Son ariza kodu | kod |

### 3.2 Durum Gostergeleri

VFD'nin Status Word register'i (Danfoss: Register 16029, P16-03) asagidaki durum bitlerini icerir:

| Bit | Gosterge | Aciklama |
|-----|----------|----------|
| 0 | Control Ready | Surucu kontrol icin hazir |
| 1 | Drive Ready | Surucu calistirmaya hazir |
| 2 | Coasting | Surucu serbest kosuda |
| 3 | Trip | Surucu ariza ile durmus |
| 4 | Trip Lock | Ariza kilidi aktif |
| 7 | Warning | Uyari durumu aktif |
| 8 | At Reference | Hiz referans degerine ulasmis |
| 9 | Auto Mode | Otomatik modda calisiyor |
| 11 | Running | Motor calisiyor |
| 13 | Current Limit | Akim sinirinda calisiyor |
| 14 | Thermal Warning | Termal uyari aktif |

Durum gostergeleri arayuzde renkli etiketler (badge) olarak gosterilir:
- **Yesil:** Hazir, Calisiyor, Referansta
- **Sari:** Uyari, Termal Uyari, Akim Siniri
- **Kirmizi:** Ariza, Ariza Kilidi

### 3.3 Polling Araliklari

Sistem, parametre onemliligine gore farkli yoklama araliklari kullanir:

| Oncelik | Parametreler | Polling Araligi | Aciklama |
|---------|-------------|----------------|----------|
| **Kritik** | Status word, control word, alarm word, warning word | 200 ms | Ariza ve durum degisiklikleri aninda algilanmali |
| **Motor** | Frekans, akim, hiz, tork, guc | 500 ms | Motor calisma parametreleri yakin zamanli izlenmeli |
| **Gerilim** | Motor gerilimi, DC bus gerilimi, guc faktoru | 1000 ms | Gerilim degerleri yavascar degisir |
| **Termal** | Sogutma sicakligi, kontrol karti sicakligi, motor termal | 5000 ms | Sicaklik degerleri cok yavas degisir |
| **Enerji** | Calisma saati, enerji tuketimi, baslatma sayisi | 60000 ms | Sayac degerleri nadiren degisir |

> **Ipucu:** Polling araliklari cihaz detay sayfasindan ozellestirilebilir. Ancak cok kisa aralilar (ornegin tum parametreler icin 100ms) iletisim hatti uzerinde asiri yuk olusturabilir ve timeout hatarina neden olabilir.

---

## 4. Komut Gonderme (Runtime Control)

### 4.1 Temel Komutlar

VFD cihazina gonderebileceginiz runtime komutlari asagida aciklanmistir. Tum komutlar Control Word register'i (Danfoss: Register 49999, P50-00) uzerinden gonderilir.

| Komut | Aciklama | Control Word Degeri (Danfoss) | Onay Gerekli |
|-------|----------|------------------------------|-------------|
| **START** | Motoru rampa ile calistirir | 0x047F | Evet |
| **STOP** | Motoru rampa ile durdurur (ramp-down) | 0x043C | Hayir |
| **REVERSE** | Motor donme yonunu degistirir | 0x080F | Evet |
| **FAULT RESET** | Ariza durumunu sifirlar | 0x04FF | Hayir |
| **QUICK STOP** | Hizli durus (kisa ramp-down) | 0x042F | Hayir |
| **COAST STOP** | Serbest kos durumu (aninda besleme kesilir) | 0x0437 | Hayir |
| **EMERGENCY STOP** | Acil durus — motoru aninda durdurur | Ozel | Hayir |

> **UYARI:** EMERGENCY STOP komutu **herkes** tarafindan (OPERATOR dahil) gonderilebilir ve onay gerektirmez. Bu komut, motorun aninda durdurulmasi gereken tehlikeli durumlarda kullanilir. Mekanik hasara neden olabilir — yalnizca acil durumlarda kullanin.

**Komut Gonderme Sureci:**

1. Cihaz detay sayfasinda "Komut Paneli" bolumunu acin
2. Gondermek istediginiz komutu secin
3. Onay gerektiren komutlarda bir dogrulama diyalogu goruntulenir
4. Komutu onaylayin
5. Komut sonucu (basarili/basarisiz) aninda goruntulenir
6. Tum gonderilen komutlar komut gecmisine kaydedilir (son 50 komut)

### 4.2 Hiz/Frekans Kontrolu

#### SET_FREQUENCY — Frekans Ayarlama

Motorun calisma frekansini Hz cinsinden ayarlar. Deger, Frequency Reference register'ina (Danfoss: Register 50009, P50-01) yazilir.

- **Birim:** Hz
- **Aralik:** 0 — 400 Hz
- **Adim:** 0.1 Hz
- **Onay Gerekli:** Evet

**Ornek kullanim:**
Bir havuz sirkülasyon pompasini 35.0 Hz'de calistirmak istiyorsaniz, SET_FREQUENCY komutunu 35.0 degeriyle gonderin.

#### SET_SPEED — Yuzdeli Hiz Ayarlama

Motorun hizini yuzde olarak ayarlar. 0% motoru durdurur, 100% maksimum frekansa karsilik gelir.

- **Birim:** %
- **Aralik:** 0 — 100%
- **Adim:** 1%
- **Onay Gerekli:** Evet

**Frekans Limitleri:**
Gercek frekans degeri, VFD'de tanimli min/max frekans limitleri ile sinirlandirilir. Ornegin:
- Min Frekans: 5 Hz (altina dusemez)
- Max Frekans: 50 Hz (ustune cikamaz)
- SET_FREQUENCY ile 55 Hz gonderirseniz, VFD 50 Hz'de sinirlar

### 4.3 Jog Kontrolu

Jog modu, motoru dusuk hizda ve yalnizca buton basili tutuldugu surece calistirmak icin kullanilir. Genellikle devreye alma (commissioning) ve bakim sirasinda kullanilir.

| Komut | Aciklama |
|-------|----------|
| **JOG_FORWARD** | Ileri yonde dusuk hizda calistirma |
| **JOG_REVERSE** | Geri yonde dusuk hizda calistirma |

Jog frekansi, VFD'nin konfigürasyon parametrelerinden ayarlanabilir (Danfoss: P3-19, varsayilan 5.0 Hz).

> **Ipucu:** Jog modu, bir pompanin dogru yonde donup donmedigini kontrol etmek icin idealdir.

### 4.4 Toplu Komut (Batch)

Birden fazla VFD cihazina ayni anda komut gondermek icin toplu komut ozelligi kullanilir.

**Kullanim senaryolari:**
- Tum havuz pompalarini ayni anda calistirma
- Tum aeratorleri belirli bir frekansa ayarlama
- Acil durumda tum cihazlari durdurma

**Calisme modlari:**

| Mod | Aciklama | Kullanim Alani |
|-----|----------|---------------|
| **Sequential** | Komutlar sirayla gonderilir, her biri onaylandiktan sonra siradaki | Guvenli islemler, bir cihazin arizasi digerlerini etkilediginde |
| **Parallel** | Komutlar ayni anda tum cihazlara gonderilir | Hizli islemler, bagimisiz cihazlar |

---

## 5. Uzaktan Programlama (Remote Programming)

### 5.1 Programlama Nedir?

Uzaktan programlama, VFD'nin konfigürasyon parametrelerini platform uzerinden degistirmeyi saglar. Bu, runtime komutlarindan (Start/Stop/Frekans) farklidir:

| Ozellik | Runtime Kontrol | Konfigürasyon Programlama |
|---------|----------------|--------------------------|
| **Kapsam** | Anlık calisma komutlari | Kalici parametre degisiklikleri |
| **Ornekler** | Start, Stop, Frekans ayarla | Rampa suresi, max frekans, PID kazanci |
| **Onay** | Basit dogrulama | Maker-Checker (4 goz ilkesi) |
| **Kayit** | Komut gecmisi | Tam denetim izi (audit trail) |
| **Risk** | Dusuk | Dusukten kritike degisir |
| **Kalicilik** | Anlık | VFD hafizasina yazilir |

**Programlanabilir Parametre Gruplari (10 grup):**

| Grup | Aciklama | Ornek Parametreler |
|------|----------|-------------------|
| Ramp Times | Hizlanma/yavaslanma sureleri | Accel Time 1, Decel Time 1 |
| Frequency Limits | Frekans sinir degerleri | Min Frequency, Max Frequency |
| Motor Nameplate | Motor etiket degerleri | Nominal Guc, Gerilim, Akim, Hiz |
| Current/Torque Limits | Akim ve tork sinirlamalari | Current Limit % |
| V/f Control | Gerilim/frekans egrisi | V/f Curve Mode, Voltage Boost |
| PID Controller | PID kontrolor parametreleri | P Kazanci, I Zamani, D Zamani |
| Digital I/O | Dijital giris/cikis atamalari | DI Function, DO Function |
| Communication | Iletisim parametreleri | Modbus Adresi, Baud Rate |
| Protection | Koruma parametreleri | Termal Koruma Modu |
| Jog | Jog calisma parametreleri | Jog Frekansi |

**Risk Seviyeleri:**

| Seviye | Renk | Aciklama | Ornek |
|--------|------|----------|-------|
| **LOW** | Yesil | Kritik olmayan, operasyonel etkisi dusuk | Jog frekansi, Modbus adresi |
| **MEDIUM** | Sari | Operasyonel etki, runtime'da degistirilebilir | Rampa sureleri, PID parametreleri |
| **HIGH** | Turuncu | Performans-kritik, motor durdurma gerekebilir | Motor etiket degerleri, V/f egrisi |
| **CRITICAL** | Kirmizi | Guvenlik etkili, ekipman hasari riski | Termal korumayi kapatma, asiri kisa rampa |

### 5.2 Change Set (Degisiklik Seti) Olusturma

Uzaktan programlama icin **Change Set** (degisiklik seti) mekanizmasi kullanilir. Bu, bir veya daha fazla parametre degisikligini tek bir paket halinde yonetmeyi saglar.

**Adim Adim Surec:**

**1. Parametre grubunu secin:**
Programlama sayfasinda sol paneldeki gruplardan birini secin (ornegin: "Ramp Times").

**2. Mevcut degerleri gorun:**
Secilen gruptaki tum parametreler tablo halinde goruntulenir. Her parametre icin:
- Parametre adi ve aciklamasi
- Mevcut deger (cihazdan canli okunur)
- Birim (s, Hz, A, %, V, RPM, vb.)
- Risk seviyesi

**3. Yeni deger girin:**
Degistirmek istediginiz parametrenin "Yeni Deger" sutunundaki alana yeni degeri girin. Sistem otomatik olarak:
- Min/max aralik kontrolu yapar
- Risk seviyesini degerlendirir
- Motor durdurma gerekliligi varsa uyari gosterir

**4. Aciklama yazin:**
Change Set icin zorunlu bir aciklama yazin. Bu aciklama:
- Degisikligin nedenini belirtmelidir
- Checker (onaylayan) tarafindan degerlendirilir
- Audit log'da kalici olarak saklanir

*Ornek aciklama: "Pompa ramp suresi optimizasyonu — havuz dolum hizini artirmak icin acceleration time 10s'den 5s'ye dusuruldu"*

**5. Gonderim:**
- **Taslak Kaydet (Save Draft):** Degisiklik setini kaydedin ancak onaya gondermeyin. Daha sonra uzerinde calisabilirsiniz.
- **Onaya Gonder (Submit for Approval):** Degisiklik setini checker onayina gonderin. Sistem tum parametrelerin gecerliliginizini dogrular.
- **Sifirla (Reset):** Tum degisiklikleri iptal edin.

**Zamanlanmis Degisiklik (Scheduled Change):**

Degisiklik setini hemen uygulamak yerine gelecekte belirli bir zamanda uygulanmak uzere zamanlayabilirsiniz. Ornegin:
- Gece 02:00'de, uretim disinda
- Hafta sonu bakim penceresinde

Zamanlama ayarini, degisiklik setini onaya gondermeden once "Zamanlama" alaninda belirtin.

**Risk Uyarilari:**

Degisiklik seti olusturulurken sistem dinamik risk degerlendirmesi yapar. Asagidaki durumlarda uyari goruntulenir:

| Durum | Risk Yukselmesi | Uyari Mesaji |
|-------|----------------|-------------|
| Accel Time < 1s | MEDIUM --> CRITICAL | "Hizlanma suresi <1s mekanik sok, kaplin hasari ve asiri akim trip'ine neden olabilir" |
| Decel Time < 0.5s | MEDIUM --> CRITICAL | "Yavaslanma suresi <0.5s DC bus asiri gerilim ve rejeneratif arizaya neden olabilir" |
| Max Frequency > 60Hz | HIGH --> CRITICAL | "60Hz uzerinde calisma motor yatak, sargı veya bagli ekipmanda hasara neden olabilir" |
| Thermal Protection = Off | HIGH --> CRITICAL | "Termal korumayi kapatmak asiri akim ve asiri isinma guvenligini kaldirir — motor hasar gorebilir" |
| Current Limit > 200% | MEDIUM --> HIGH | "Akim siniri nominal degerinin >%200'u sureklicalisma icin motor termal kapasitesini asar" |

### 5.3 Maker-Checker Onay Sureci

#### Nedir ve Neden Gereklidir?

Maker-Checker (4 goz ilkesi), IEC 62443 SL-2 guvenlik standardinin gerektirdigi bir onay mekanizmasidir. Endüstriyel otomasyon sistemlerinde bir kisinin yaptigi degisikligin baska bir kisi tarafindan onaylanmasini zorunlu kilar.

**Temel kurallar:**
- **Maker** (degisikligi talep eden) ve **Checker** (degisikligi onaylayan) **farkli kisiler olmalidir**
- Ayni kisi hem degisikligi olusturup hem onaylayamaz
- Bu kural, hatali veya kotu niyetli degisiklikleri onler

#### Roller

| Rol | Kim | Yapabilecekleri |
|-----|-----|----------------|
| **Maker** | MODULE_MANAGER veya TENANT_ADMIN | Degisiklik seti olustur, parametreleri duzenle, onaya gonder |
| **Checker** | TENANT_ADMIN | Degisiklik setini incele, onayla veya reddet |

#### Durum Gecis Diyagrami

```
DRAFT --> PENDING_APPROVAL --> APPROVED --> APPLYING --> APPLIED --> VERIFIED
                           \-> REJECTED                          \-> ROLLED_BACK
                                                     \-> FAILED --> ROLLED_BACK
```

| Durum | Aciklama | Kim Yapabilir |
|-------|----------|--------------|
| **DRAFT** | Taslak — parametreler ekleniyor/duzenleniyor | Maker |
| **PENDING_APPROVAL** | Onay bekliyor — checker'in incelemesi bekleniyor | Maker gonderir |
| **APPROVED** | Onaylandi — uygulanmaya hazir | Checker onaylar |
| **APPLYING** | Uygulanıyor — VFD'ye register yazimi devam ediyor | Sistem otomatik |
| **APPLIED** | Uygulandi — tum parametreler VFD'ye yazildi | Sistem otomatik |
| **VERIFIED** | Dogrulandi — read-back ile degerler teyit edildi | Sistem otomatik |
| **REJECTED** | Reddedildi — checker tarafindan ret (neden belirtilir) | Checker reddeder |
| **FAILED** | Basarisiz — yazim veya dogrulama hatasi | Sistem otomatik |
| **ROLLED_BACK** | Geri alindi — onceki degerler restore edildi | Sistem veya yetkili kisi |

#### Ret (Reject) Durumu

Checker bir degisiklik setini reddederse:
- Ret nedeni zorunlu olarak belirtilir
- Maker'a bildirim gonderilir
- Maker, degisiklik setini duzenleyerek tekrar onaya gonderebilir veya silebilir

#### Bildirimler

| Olay | Kime | Kanal |
|------|------|-------|
| Degisiklik seti onaya gonderildi | Tum Checker'lar (TENANT_ADMIN) | Platform bildirimi + e-posta |
| Degisiklik seti onaylandi | Maker | Platform bildirimi |
| Degisiklik seti reddedildi | Maker | Platform bildirimi + e-posta |
| Degisiklik seti uygulandi | Maker + Checker | Platform bildirimi |
| Degisiklik seti basarisiz oldu | Maker + Checker + Sistem Yoneticisi | Platform bildirimi + e-posta + alarm |
| Geri alma yapildi | Maker + Checker | Platform bildirimi |

### 5.4 Parametre Gruplari Detayi

Asagida her parametre grubu icin detayli bilgiler verilmistir. Register adresleri ve varsayilan degerler Danfoss FC serisi icin gosterilmistir. Diger markalar icin register adresleri farklilik gosterir ancak parametre isimleri ve islevleri aynidir.

#### 5.4.1 Ramp Times (Rampa Sureleri)

Rampa sureleri, motorun ne kadar surede hizlanacagini (acceleration) ve yavasslayacagini (deceleration) belirler.

**Soft Start (Yumusak Baslatma) Nedir?**
Motor dogrudan tam hizda calistirildiginda cok yuksek baslatma akimi cekilir (nominal akimin 6-8 kati). VFD'nin rampa ozelligi, motoru kademeli olarak hizlandirarak baslatma akimini sinirlar ve mekanik stresi azaltir.

| Parametre | Register | Birim | Min | Max | Varsayilan | Risk | Motor Dur. |
|-----------|----------|-------|-----|-----|-----------|------|-----------|
| Acceleration Time 1 | 3409 (P3-41) | s | 0.05 | 3600 | 10 | MEDIUM | Hayir |
| Deceleration Time 1 | 3419 (P3-42) | s | 0.05 | 3600 | 10 | MEDIUM | Hayir |

> **UYARI:** Acceleration Time degeri 1 saniyenin altina ayarlandiginda risk seviyesi **CRITICAL**'e yükselir. Cok kisa hizlanma suresi mekanik sok olusturabilir, kaplin hasarina ve asiri akim trip'ine neden olabilir.

> **UYARI:** Deceleration Time degeri 0.5 saniyenin altina ayarlandiginda risk seviyesi **CRITICAL**'e yukselir. Cok kisa yavasslama DC bus'ta asiri gerilime ve rejeneratif arizaya yol acar.

**Aquaculture Ornegi:** Havuz sirkülasyon pompasi icin tipik rampa sureleri 5-15 saniye araligindadir. Cok kisa rampa suresi boru hattinda su darbesi (water hammer) olusturabilir.

#### 5.4.2 Frequency Limits (Frekans Sinir Degerleri)

Motor calisma frekans araligini belirler. Bu sinirlar, SET_FREQUENCY komutunun gercek etkisini sinirlar.

| Parametre | Register | Birim | Min | Max | Varsayilan | Risk | Motor Dur. |
|-----------|----------|-------|-----|-----|-----------|------|-----------|
| Minimum Frequency | 4109 (P4-11) | Hz | 0 | 400 | 0 | MEDIUM | Hayir |
| Maximum Frequency | 4129 (P4-13) | Hz | 0.1 | 400 | 50 | HIGH | Hayir |

> **UYARI:** Maximum Frequency degeri 60 Hz'in uzerine ayarlandiginda risk seviyesi **CRITICAL**'e yukselir. Motorun nominal frekansinin uzerinde calistirmak yatak, sargi veya bagli ekipmanda hasara neden olabilir.

**Skip Frequency (Rezonans Kacinma):**
Bazi motorlar belirli frekanslarda mekanik rezonansa girer ve titresim olusturur. Skip frequency parametresi, VFD'nin bu frekanstan gecerken duraklamadan atlamasini saglar.

**Aquaculture Ornegi:** Bir pompa 27 Hz civarinda titresim yapiyorsa, skip frequency olarak 27 Hz, skip band olarak 2 Hz tanimlayin. VFD 25-29 Hz araligini hizla gecer.

#### 5.4.3 Motor Nameplate (Motor Etiket Degerleri)

Motor etiketindeki (nameplate) degerlerin VFD'ye tanitilmasi. Bu parametreler motorun dogru kontrolu ve korunmasi icin kritiktir.

| Parametre | Register | Birim | Min | Max | Varsayilan | Risk | Motor Dur. |
|-----------|----------|-------|-----|-----|-----------|------|-----------|
| Motor Nominal Power | 1199 (P1-20) | kW | 0.01 | 1000 | - | HIGH | **Evet** |
| Motor Nominal Voltage | 1219 (P1-22) | V | 50 | 1000 | 400 | HIGH | **Evet** |
| Motor Nominal Current | 1239 (P1-24) | A | 0.01 | 10000 | - | HIGH | **Evet** |
| Motor Nominal Speed | 1249 (P1-25) | RPM | 100 | 60000 | - | HIGH | **Evet** |

> **UYARI:** Motor etiket degerleri **yalnizca motor duruyorken** degistirilebilir! Bu parametrelerin degistirilmesi VFD'nin motor modelini yeniden hesaplamasini gerektirir (auto-tune). Motor calisirken degistirilirse VFD ariza verebilir.

**Aquaculture Ornegi:** Bir tesis pompasinin motoru degistirildiginde, yeni motorun etiket bilgilerinin VFD'ye girilmesi gerekir. Islem sirasinda motor durdurulmalidir.

#### 5.4.4 Current/Torque Limits (Akim ve Tork Sinirlamalari)

Motor akim sinirlarini belirler. Asiri yuklenmelere karsi koruma saglar.

| Parametre | Register | Birim | Min | Max | Varsayilan | Risk | Motor Dur. |
|-----------|----------|-------|-----|-----|-----------|------|-----------|
| Current Limit | 4159 (P4-16) | % | 0 | 400 | 160 | MEDIUM | Hayir |

Akim siniri, nominal motor akimina gore yuzde olarak belirlenir. Ornegin %160 degeri, nominal akimin 1.6 katina kadar cekime izin verir.

> **UYARI:** Akim siniri %200'un uzerine ayarlandiginda risk seviyesi **HIGH**'a yukselir. Surekli calisma icin motorun termal kapasitesini asar.

**Aquaculture Ornegi:** Filtre pompasi tikali bir filtrede calisirken akim yukselir. %160 siniri pumpanin tikali durumda zarar gormesini onler.

#### 5.4.5 V/f Control (Gerilim/Frekans Kontrolu)

V/f egrisi, motorun farkli frekanslarda alacagi gerilimi belirler. Iki temel mod vardir:

| Mod | Aciklama | Kullanim Alani |
|-----|----------|---------------|
| **Linear** | Gerilim, frekansla dogrusal orantili artar | Sabit torklu yukler (konveyor, vinc) |
| **Square (Karesel)** | Gerilim, frekans karesine orantili artar | Degisken torklu yukler (pompa, fan) |

> **Ipucu:** Aquaculture tesislerinde pompalar ve fanlar icin **Square (karesel)** V/f egrisi secilmelidir. Bu mod dusuk hizlarda enerji tasarrufu saglar.

> **UYARI:** V/f egrisi degisikligi motor durdurularak yapilmalidir.

**Voltage Boost (Gerilim Takviyesi):**
Dusuk hizlarda motorun yeterli torku uretebilmesi icin ek gerilim saglanir. Agir baslangic yukleri olan uygulamalarda kullanilir.

#### 5.4.6 PID Controller (PID Kontrolor)

VFD'nin dahili PID kontroloru, bir proses degiskenini (sicaklik, basinc, debi) ayar degerinde tutmak icin motor hizini otomatik ayarlar.

| Parametre | Register | Birim | Min | Max | Varsayilan | Risk | Motor Dur. |
|-----------|----------|-------|-----|-----|-----------|------|-----------|
| PID P Gain | 7029 (P7-03) | - | 0 | 10 | 1.00 | MEDIUM | Hayir |
| PID I Time | 7039 (P7-04) | s | 0.01 | 9999 | 10.00 | MEDIUM | Hayir |

**PID Parametreleri:**
- **P (Proportional) Kazanci:** Hataya anlik tepki. Yuksek P degerinde sistem hizli tepki verir ancak sallanabilir.
- **I (Integral) Zamani:** Kararli durum hatasini giderir. Dusuk I zamani daha agresif duzeltme yapar.
- **D (Derivative) Zamani:** Degisim hizina tepki verir. Genellikle pompa uygulamalarinda 0'da birakilir.

**Aquaculture'da PID Kullanim Ornekleri:**

| Uygulama | Proses Degiskeni | Setpoint Ornegi | Aciklama |
|----------|-----------------|----------------|----------|
| Aerasyon pompasi | Cozunmus Oksijen (DO) | 6.5 mg/L | DO sensoru geribildirimli, hedef DO seviyesini korur |
| Isitma sirkülasyon pompasi | Su sicakligi | 24.0 degC | Sicaklik sensorunden geribildirim alir |
| Basinc pompasi | Hat basinci | 2.5 bar | Basinc transmitteri geribildirimli |
| Debi pompasi | Debi | 100 L/dk | Debi metre geribildirimli |

> **Ipucu:** PID parametrelerini ayarlarken kucuk adimlarla ilerleyin. Ornegin P kazancini 0.5'ten 1.0'a artirin, sistemi gozleyin, gerekirse 0.1 artislarla fine-tune yapin.

#### 5.4.7 Protection (Koruma)

Motor ve surucu koruma parametreleri. Bu parametreler ekipmanin guvenligini dogrudan etkiler.

| Parametre | Register | Birim | Min | Max | Varsayilan | Risk | Motor Dur. |
|-----------|----------|-------|-----|-----|-----------|------|-----------|
| Motor Thermal Protection | 1899 (P1-90) | - | 0 | 4 | 2 | CRITICAL | Hayir |

**Termal Koruma Modlari:**

| Deger | Mod | Aciklama |
|-------|-----|----------|
| 0 | Off | Termal koruma kapali |
| 1 | Warning | Asiri sicaklikta yalnizca uyari verir |
| 2 | Trip | Asiri sicaklikta motoru durdurur (varsayilan) |
| 3 | Warning + External | Uyari + harici koruma sinyali |
| 4 | Trip + External | Trip + harici koruma sinyali |

> **UYARI:** Termal koruma modu **ASLA** kapatilmamalidir (deger 0). Risk seviyesi **CRITICAL**'dir. Termal korumasi olmayan bir motor asiri isinabilir, sargilar yanabilir ve yangin riski olusabilir. Bu deger yalnizca gecici test amacli kullanilabilir ve derhal geri alinmalidir.

### 5.5 Risk Yonetimi

Sistem, her parametre degisikligi icin dinamik risk degerlendirmesi yapar. Risk, iki faktore dayanir:

1. **Temel Risk (Base Risk):** Parametrenin dogasindan kaynaklanan sabit risk seviyesi
2. **Deger Bazli Yukseltme (Escalation):** Girilen degerin tehlikeli bir araliga dusmesi durumunda risk seviyesinin yukseltilinesi

**Dinamik Risk Degerlendirme Tablosu:**

| Parametre | Temel Risk | Yukseltme Kosulu | Yukselme Sonrasi | Neden |
|-----------|-----------|------------------|-----------------|-------|
| accel_time_* | MEDIUM | Deger < 1.0 s | CRITICAL | Mekanik sok, kaplin hasari, asiri akim |
| decel_time_* | MEDIUM | Deger < 0.5 s | CRITICAL | DC bus asiri gerilim, rejeneratif ariza |
| max_frequency | HIGH | Deger > 60 Hz | CRITICAL | Motor yatak, sargi hasari |
| thermal_protection_mode | HIGH | Deger = 0 (Off) | CRITICAL | Asiri akim ve asiri isinma guvenligini kaldirir |
| current_limit_percent | MEDIUM | Deger > 200% | HIGH | Motor termal kapasitesini asar |
| motor_voltage_nom | HIGH | - | - | Motor durdurma + auto-tune gerekir |
| motor_current_nom | HIGH | - | - | Motor durdurma + auto-tune gerekir |
| motor_power_nom | HIGH | - | - | Motor durdurma + auto-tune gerekir |
| motor_speed_nom | HIGH | - | - | Motor durdurma + auto-tune gerekir |
| vf_curve_mode | HIGH | - | - | Motor kontrol yontemi degisir |
| voltage_boost | HIGH | - | - | Dusuk hiz tork davranisi degisir |
| pid_* | MEDIUM | - | - | Proses kontrol stabilite etkisi |
| jog_* | LOW | - | - | Yalnizca manuel jog islemini etkiler |
| modbus_address | LOW | - | - | Kritik olmayan iletisim parametresi |

**Motor Durdurma Gereklilikleri:**

Asagidaki parametrelerin degistirilmesi icin motor durmus olmalidir (`requiresMotorStop: true`):

- Motor Nominal Guc (motor_power_nom)
- Motor Nominal Gerilim (motor_voltage_nom)
- Motor Nominal Akim (motor_current_nom)
- Motor Nominal Hiz (motor_speed_nom)
- Motor Guc Faktoru (motor_cos_phi)
- V/f Egri Modu (vf_curve_mode)
- Gerilim Takviyesi (voltage_boost)
- Kayma Kompanzasyonu (slip_compensation)

Motor calisirken bu parametreleri iceren bir degisiklik seti uygulanmaya calisilirsa, sistem tum degisiklik setini reddeder ve hic bir parametre yazilmaz.

### 5.6 Rollback (Geri Alma)

Uygulanan bir degisiklik setini geri almak (onceki degerlere dondurmek) icin iki yontem vardir:

#### Standart Rollback

- Yalnizca `APPLIED` veya `VERIFIED` durumundaki degisiklik setleri geri alinabilir
- Yeni bir degisiklik seti olusturulur (rollbackOfId alaninda orijinal degisiklik seti referans edilir)
- Normal Maker-Checker onay sureci uygulanir
- Onceki degerler otomatik olarak yeni degisiklik setine yazilir

**Adimlar:**
1. Degisiklik seti gecmisinden geri almak istediginiz seti secin
2. "Geri Al" butonuna tiklayin
3. Geri alma nedenini yazin
4. Sistem onceki degerleri iceren yeni bir degisiklik seti olusturur
5. Normal onay surecinden gecirin

#### Emergency Rollback (Acil Geri Alma)

Acil durumlarda Maker-Checker sureci atlanarak degisiklik seti dogrudan geri alinabilir.

- MODULE_MANAGER veya TENANT_ADMIN yetkisi gereklidir
- Onay sureci bypass edilir
- `emergency_override` olarak audit log'a kaydedilir
- Nedeni zorunlu olarak belirtilmelidir

> **UYARI:** Emergency Rollback yalnizca acil durumlar icindir. Normal kosullarda standart rollback sureci kullanin. Tum acil geri alma islemleri ayrintili olarak loglanir ve denetlenir.

### 5.7 Audit Log (Denetim Kaydi)

Her parametre degisikligi kalici (immutable) denetim kaydi olusturur. Bu kayitlar silinemez veya degistirilemez.

**Kaydedilen Bilgiler:**

| Alan | Aciklama | Ornek |
|------|----------|-------|
| Zaman Damgasi | Degisikligin uygulandigi tarih/saat | 2026-03-26 14:32:15 |
| Degisiklik Seti ID | Ilgili change set referansi | CS-043 |
| Parametre Adi | Degistirilen parametre | accel_time_1 |
| Onceki Deger | Degisiklik oncesi deger | 10.00 |
| Yeni Deger | Degisiklik sonrasi deger | 5.00 |
| Islem | Islem turu | apply / rollback / auto_apply / emergency_override |
| Yapan Kisi | Islemi gerceklestiren kullanici | okan@aqua.com |
| IP Adresi | Istemci IP adresi | 192.168.1.50 |
| Otomasyon Kurali | Otomasyonla tetiklendiyse kural ID | rule-001 (veya bos) |

**Filtreleme ve Arama:**
- Tarih araligina gore filtrele
- Parametre adina gore ara
- Kullaniciya gore filtrele
- Degisiklik seti ID'sine gore ara
- Islem turune gore filtrele (apply, rollback, emergency_override)

**Saklama Politikasi:**
Denetim kayitlari **hicbir zaman silinmez**. Performans icin aylik partisyon kullanilir.

---

## 6. Otomasyon Kurallari

### 6.1 Kural Olusturma

Otomasyon kurallari, sensor verilerine dayali olarak VFD parametrelerini otomatik degistirmeyi saglar. NATS mesaj sistemi uzerinden sensor okumalari dinlenir ve kosuller saglandiginda degisiklik seti olusturulur.

**Bir otomasyon kurali su bilesenleri icerir:**

| Bilesen | Aciklama | Zorunlu |
|---------|----------|---------|
| Kural Adi | Kurali tanimlayan bir ad | Evet |
| Aciklama | Kuralın ne yaptigini aciklayan metin | Evet |
| Tetikleme Kosulu | Sensor verisi kosullari (AND/OR birlestirilmis) | Evet |
| Hedef VFD Cihazlari | Parametre degisikliginin uygulanacagi cihazlar | Evet |
| Parametre Degisiklikleri | Hangi parametrelerin hangi degerlere ayarlanacagi | Evet |
| Onay Gerekliligi | Otomatik uygulama mi yoksa onay beklesin mi | Evet |
| Oncelik | Cakisan kurallar icin oncelik sirasi (dusuk sayi = yuksek oncelik) | Evet |
| Cooldown Suresi | Kuralinin tekrar tetiklenmesi icin beklenmesi gereken sure | Evet |

**Tetikleme Kosulu Yapisi:**

```
Kosul = { sensorTag, operator, value }
Operatorler: >, <, >=, <=, ==, !=
Mantiksal Birlesim: AND veya OR
```

**Ornek kosul:** Su sicakligi 15 derecenin altina dustugunde VE pH 7.5'in ustunde oldugunda

### 6.2 Kural Ornekleri (Aquaculture)

#### Ornek 1: Su Sicakligi Dusme — Pompa Rampa Suresi Artirma

**Senaryo:** Su sicakligi dustugunde motorlarin daha yavas hizlanmasi istenir (boru hattindaki termal sok etkisini azaltmak icin).

| Alan | Deger |
|------|-------|
| Kural Adi | Su sicakligi dusme — rampa koruma |
| Kosul | su_sicakligi < 15.0 (degC) |
| Hedef VFD | Giris Pompa #1, Giris Pompa #2 |
| Parametre Degisikligi | accel_time_1 = 15.0 (10s'den 15s'ye artir) |
| Onay Gerekli | Evet |
| Cooldown | 3600 saniye (1 saat) |
| Oncelik | 5 |

#### Ornek 2: Basinc Yukselmesi — Max Frekans Dusurme

**Senaryo:** Hat basinci yukseldiyse pumpanin max frekansini dusutur (boru hatti guvenligini korumak icin).

| Alan | Deger |
|------|-------|
| Kural Adi | Yuksek basinc — frekans sinirla |
| Kosul | hat_basinci > 3.0 (bar) |
| Hedef VFD | Ana Sirkülasyon Pompasi |
| Parametre Degisikligi | max_frequency = 40.0 (50Hz'den 40Hz'e dusur) |
| Onay Gerekli | Evet |
| Cooldown | 1800 saniye (30 dakika) |
| Oncelik | 3 |

#### Ornek 3: Dusuk DO — Aerator Hizlandirma

**Senaryo:** Cozunmus oksijen seviyesi dustugunde aerator motorunu hizlandirir (balik sagligini korumak icin).

| Alan | Deger |
|------|-------|
| Kural Adi | Dusuk DO — aerator hizlandir |
| Kosul | do_seviyesi < 5.0 (mg/L) |
| Hedef VFD | Aerator VFD #1, Aerator VFD #2 |
| Parametre Degisikligi | accel_time_1 = 3.0 (hizli rampa), max_frequency = 55.0 |
| Onay Gerekli | Hayir (otomatik uygula) |
| Cooldown | 900 saniye (15 dakika) |
| Oncelik | 1 (en yuksek oncelik) |

> **UYARI:** `requiresApproval: false` ayari yalnizca TENANT_ADMIN tarafindan yapilandibilir. Otomatik uygulama, degisikligin dogrudan VFD'ye yazilmasini saglar — Maker-Checker sureci atlanir. Yalnizca acil ve iyi test edilmis senaryolar icin kullanin.

### 6.3 Kural Yonetimi

#### Aktif/Pasif Yapma

Her kural aktif veya pasif duruma getirilebilir. Pasif kurallar sensor verilerini degerlendirmez.

#### Calisma Gecmisi

Her kural icin su bilgiler izlenir:
- Son tetiklenme zamani
- Toplam tetiklenme sayisi
- Olusturulan degisiklik seti referanslari
- Basarili/basarisiz uygulama istatistikleri

#### Cakisma Cozumu (Priority)

Birden fazla kural ayni VFD icin ayni anda tetiklendiginde:
- **Dusuk oncelik numarasina sahip kural kazanir** (priority 1, priority 5'ten once islenir)
- Kaybeden kural atlanir ve bu durum loglanir
- Cakisan kurallar olursa yoneticiye bildirim gonderilir

#### Otomatik Deaktivisyon

Bir kural art arda 3 kez basarisiz olursa:
- Kural otomatik olarak deaktif edilir
- Yoneticiye alarm gonderilir
- Manuel olarak yeniden aktif edilmesi gerekir

---

## 7. Sorun Giderme (Troubleshooting)

### 7.1 Baglanti Sorunlari

| Hata Mesaji | Olasi Neden | Cozum |
|-------------|-------------|-------|
| **"Connection timeout"** | Kablo baglantisi kopuk, IP adresi yanlis, port kapali | 1. Fiziksel kablo baglantilarini kontrol edin. 2. IP adresi ve port numarasini dogrulayin. 3. Firewall kurallarini kontrol edin. |
| **"CRC error"** | Baud rate, parity veya stop bits uyumsuzlugu | VFD panelindeki iletisim ayarlarini kontrol edin. Platformdaki ayarlarla birebir eslesmeli. |
| **"No response"** | Yanlis slave address, VFD kapali, kablo terminasyonu eksik | 1. Slave ID/Unit ID'yi VFD panelinden dogrulayin. 2. VFD'nin guc altinda oldugunu kontrol edin. 3. RS-485 hat terminasyonunu kontrol edin (120 ohm). |
| **"Connection refused"** | Port kapali veya baska bir uygulama kullaniyor | 1. Port numarasini dogrulayin (Modbus TCP: 502). 2. Baska bir yazilimin portu kullanip kullanmadigini kontrol edin. |
| **"Network unreachable"** | IP adresi erisebilir degil | 1. Ping testi yapin. 2. IP adreslerinin ayni subnet'te oldugundan emin olun. 3. Switch ve kablo baglantilarini kontrol edin. |

### 7.2 Yazma Sorunlari

| Hata Mesaji | Olasi Neden | Cozum |
|-------------|-------------|-------|
| **"Register not writable"** | VFD'de uzaktan yazma izni kapatilmis | VFD'nin uzaktan kontrol modunu aktif edin (markaya gore — asagidaki bolume bakin). |
| **"Read-back mismatch"** | Register settle time yetersiz, parametre kilitli | 1. Yazim sonrasi bekleme suresini artirin. 2. VFD'de parametrenin kilitli olup olmadigini kontrol edin. 3. Parametrenin yazilabilir oldugunu dogrulayin. |
| **"Motor running"** | requiresMotorStop parametresi, motor calisirken yazim denendi | Oncelikle motoru durdurun (STOP komutu), sonra parametre degisikligini uygulayın. |
| **"Value out of range"** | Girilen deger min/max araliginin disinda | Parametrenin gecerli araligini kontrol edin ve aralik icinde bir deger girin. |
| **"Device offline"** | Cihaz iletisimi kopuk | Baglanti sorunlari bolumune bakin. |

### 7.3 Onay Sorunlari

| Hata Mesaji | Olasi Neden | Cozum |
|-------------|-------------|-------|
| **"Maker-Checker violation"** | Ayni kisi hem olusturma hem onaylama yapmaya calisiyor | Degisiklik setini farkli bir TENANT_ADMIN kullanicisina onaylatın. Maker ve Checker ayni kisi olamaz. |
| **"Active change set exists"** | Ayni cihaz icin baska bir degisiklik seti islemde | Onceki degisiklik setini tamamlayin, iptal edin veya reddedin. Bir cihaz icin ayni anda yalnizca bir aktif (draft olmayan) degisiklik seti olabilir. |
| **"Insufficient permissions"** | Kullanici yetki seviyesi yetersiz | Degisiklik seti olusturma icin MODULE_MANAGER, onaylama icin TENANT_ADMIN yetkisi gereklidir. |

### 7.4 Marka-Spesifik Sorunlar

Her VFD markasinda uzaktan erisim icin belirli ayarlarin aktif edilmesi gerekir. Asagida her marka icin gerekli adimlar belirtilmistir:

#### Danfoss FC Serisi

**Uzaktan Erisim Aktivasyonu:**
1. VFD panelinden P8-01 parametresine gidin
2. FC Protocol modunu aktif edin (deger: 2 = Bus kontrol)
3. P8-02'de control word kaynagini "RS485" veya "FC Port" olarak ayarlayin
4. P8-30'da baudrate ayarini kontrol edin (varsayilan 9600)
5. P8-31'de Modbus adresini dogrulayin (varsayilan 1)
6. P8-32'de parity ayarini kontrol edin

> **Ipucu:** Danfoss VFD'lerde register hesaplamasi: Register = (Parametre No x 10) - 1. Ornegin P16-13 (cikis frekansi) = (1613 x 10) - 1 = 16129

#### ABB ACS Serisi

**Uzaktan Erisim Aktivasyonu:**
1. Parametre Grubu 10: Control source secimini yapin
2. External 1 veya External 2 kontrol yeri olarak fieldbus'i secin
3. Parametre Grubu 51-53: Fieldbus iletisim ayarlarini yapilandirin
4. Modbus adresi ve iletisim parametrelerini ayarlayin
5. Parametre Grubu 99: Motor data parametrelerini girin

#### Siemens G120 Serisi

**Uzaktan Erisim Aktivasyonu:**
1. P0700: Komut kaynagi secin (deger: 5 = USS / 6 = Modbus)
2. P1000: Frekans setpoint kaynagini ayarlayin (deger: 5 = USS / 6 = Modbus)
3. P2010-P2014: Modbus iletisim parametrelerini yapilandirin
4. P2010: Modbus adresini ayarlayin
5. P2011: Baudrate secin
6. P2012: Parity ayarini yapin

#### Schneider Altivar Serisi

**Uzaktan Erisim Aktivasyonu:**
1. Iletisim modulunun takili oldugunu dogrulayin
2. Cmd/Ref kanalini fieldbus olarak ayarlayin
3. Modbus adresini ve iletisim parametrelerini yapilandirin
4. Standard Modbus profil modunu etkinlestirin

#### Yaskawa Serisi

**Uzaktan Erisim Aktivasyonu:**
1. b1-01: Referans kaynagini MEMOBUS/Modbus olarak ayarlayin
2. b1-02: Calistirma komutu kaynagini MEMOBUS/Modbus olarak ayarlayin
3. H5-01: Modbus slave adresini girin
4. H5-02: Iletisim hizini secin
5. H5-03: Parity ayarini yapin

#### Delta VFD Serisi

**Uzaktan Erisim Aktivasyonu:**
1. Pr.09-00: Modbus iletisim adresini ayarlayin
2. Pr.09-01: Iletisim hizini secin
3. Pr.09-04: Iletisim protokolunu ayarlayin
4. Pr.00-21: Kontrol kaynagini RS-485 olarak secin

#### Mitsubishi FR Serisi

**Uzaktan Erisim Aktivasyonu:**
1. Pr.117: RS-485 istasyonunu numarasini ayarlayin
2. Pr.118: Iletisim hizini secin
3. Pr.119: Stop bits ve parity ayarini yapin
4. Pr.120: Iletisim bekleme suresini ayarlayin
5. Pr.338: Komut kaynagini RS-485 olarak secin
6. Pr.339: Hiz komut kaynagini RS-485 olarak secin

#### Rockwell PowerFlex Serisi

**Uzaktan Erisim Aktivasyonu:**
1. P046: Speed Reference secimini Communication olarak ayarlayin
2. P047: Start Source secimini Communication olarak ayarlayin
3. CIP (Common Industrial Protocol) uzerinden erisim icin EtherNet/IP modulunu yapilandirin
4. Modbus icin: P033 ve P034 parametrelerini ayarlayin

---

## 8. Guvenlik ve Uyumluluk

### 8.1 IEC 62443 SL-2 Uyumlulugu

Platform, endüstriyel otomasyon guvenlik standardi IEC 62443 Security Level 2'ye uygundur. Bu seviye su gereksinimleri kapsar:

- **Kimlik Dogrulama:** Tum kullanicilar kimlik dogrulamasindan gecmeli
- **Yetkilendirme:** Rol tabanli erisim kontrolu (RBAC)
- **Denetim Izi:** Tum degisikliklerin kayit altina alinmasi
- **Maker-Checker:** Kritik degisikliklerde cift onay
- **Butunluk:** Verilerin degistirilmemis oldugunun garanti edilmesi

### 8.2 IEC 61800-7-201 Uyumlulugu

VFD iletisim profilleri IEC 61800-7-201 standardina uygundur. Bu standart:

- Control word ve status word formatlarini tanimlar
- CiA402 / PROFIdrive profilleri ile uyumluluk saglar
- Register mapping yapilarini standartlastirir

### 8.3 ISA-95 Level 2-3 Konumlandirma

Platform, ISA-95 otomasyon piramidinde Level 2 (Control Systems) ve Level 3 (Manufacturing Operations) arasinda konumlanir:

- **Level 2:** VFD cihazlariyla dogrudan iletisim (register okuma/yazma)
- **Level 3:** Degisiklik yonetimi, onay surecleri, raporlama

### 8.4 Rol Tabanli Erisim Kontrol Matrisi

| Islem | VIEWER | OPERATOR | MODULE_MANAGER | TENANT_ADMIN |
|-------|--------|----------|----------------|--------------|
| Parametre goruntuleme | Evet | Evet | Evet | Evet |
| Degisiklik seti goruntuleme | Evet | Evet | Evet | Evet |
| Audit log goruntuleme | Evet | Evet | Evet | Evet |
| Degisiklik seti olusturma (Maker) | Hayir | Hayir | Evet | Evet |
| Degisiklik seti onaylama (Checker) | Hayir | Hayir | Hayir | Evet |
| Degisiklik seti reddetme | Hayir | Hayir | Hayir | Evet |
| Acil geri alma | Hayir | Hayir | Evet | Evet |
| Otomasyon kurali olusturma | Hayir | Hayir | Hayir | Evet |
| Otomasyon kuralini ac/kapat | Hayir | Hayir | Evet | Evet |
| requiresApproval=false ayarlama | Hayir | Hayir | Hayir | Evet |

### 8.5 Audit Log Saklama Politikasi

- Denetim kayitlari **hicbir zaman silinmez**
- Veritabaninda aylik partisyon kullanilir (performans optimizasyonu)
- Her kayit degistirilemez (immutable) — UPDATE veya DELETE yapilmaz
- IP adresi ve user-agent bilgisi her islemde kaydedilir
- Otomasyon tarafindan tetiklenen degisiklikler kural ID ve tetikleme kosulu ile birlikte loglanir

---

## 9. Terimler Sozlugu

| Terim | Aciklama |
|-------|----------|
| **VFD (Variable Frequency Drive)** | Degisken Frekansl Surucu. AC motor hizini kontrol eden guc elektronigi cihazi. "Inverter", "Drive", "Frekans Konvertor" olarak da bilinir. |
| **Inverter** | VFD ile ayni anlama gelir. DC gucü AC'ye ceviren devre. |
| **Drive** | VFD'nin kisa kullanimi. |
| **Control Word** | VFD'ye komut gondermek icin kullanilan 16-bit register. Her bit farkli bir komutu temsil eder. |
| **Status Word** | VFD'nin durumunu bildiren 16-bit register. Her bit farkli bir durumu temsil eder. |
| **Register** | VFD hafizasindaki adreslenebilir veri alani. Parametreler register adresleri uzerinden okunur/yazilir. |
| **Modbus** | Endüstriyel iletisim protokolu. RTU (seri hat) ve TCP (Ethernet) varyantlari vardir. |
| **Slave ID / Unit ID** | Modbus agindaki cihazin benzersiz adresi (1-247). |
| **Baud Rate** | Seri iletisim hizi (bit/saniye). Yaygin degerler: 9600, 19200, 38400. |
| **Parity** | Seri iletisimde hata tespit yontemi. None, Even veya Odd. |
| **Soft Start** | Motorun kademeli olarak hizlandirilmasi. Baslatma akimini sinirlar. |
| **Ramp** | Motorun belirli bir sure icinde hiz degistirmesi. Ramp-up (hizlanma) ve ramp-down (yavasslama). |
| **PID** | Proportional-Integral-Derivative kontrolor. Bir proses degiskenini hedef degerina tutmak icin motor hizini otomatik ayarlar. |
| **V/f (Volts/Frequency)** | Gerilim/frekans orani. Motorun farkli frekanslarda gerilim ihtiyacini tanimlar. |
| **Nameplate** | Motor etiketi. Nominal guc, gerilim, akim, hiz ve guc faktoru bilgilerini icerir. |
| **Maker-Checker** | Dort goz ilkesi. Bir kisi degisikligi yapar (Maker), farkli bir kisi onaylar (Checker). Guvenlik standardi gereksinimi. |
| **Change Set** | Degisiklik Seti. Bir veya daha fazla parametre degisikligini tek bir paket halinde yoneten yapi. |
| **Rollback** | Geri Alma. Uygulanan degisikligi iptal ederek onceki degerlere donme. |
| **Risk Level** | Risk seviyesi. LOW (dusuk), MEDIUM (orta), HIGH (yuksek), CRITICAL (kritik). |
| **Audit Trail** | Denetim izi. Tum degisikliklerin kim, ne zaman, ne degistirdi kaydi. Silinemez. |
| **Polling** | Yoklama. Parametrelerin periyodik olarak okunmasi. |
| **Trip** | VFD'nin ariza nedeniyle motoru durdurmasi. |
| **Cooldown** | Soguma suresi. Bir otomasyon kuralinin tekrar tetiklenmesi icin beklemesi gereken minimum sure. |
| **Bus** | Iletisim hatti. RS-485, Ethernet, CAN gibi fiziksel baglantilar. |
| **Auto-Tune** | VFD'nin motor parametrelerini otomatik olarak olcmesi ve optimal kontrol degerlerini hesaplamasi. |
| **Regenerative** | Rejeneratif. Motorun jenerator olarak calisarak enerjiyi DC bus'a geri gondermesi. Hizli yavaslamada olusur. |
| **Water Hammer** | Su darbesi. Pompa hizla durduruldigunda boru hattinda olusan basinc dalgasi. Boru ve vanalara zarar verebilir. |

---

*Bu kilavuz Aquaculture SaaS platformu V1.0 icin hazirlanmistir. Sorulariniz icin teknik destek ekibine basvurun.*
