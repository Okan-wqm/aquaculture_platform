# AquaPlatform — Mortalite Azaltma Mekanizmaları

> Yatırımcılar, ortaklar ve karar alıcılar için hazırlanmış teknik olmayan referans belgesidir. Sistemin balık ölümünü azaltma yönündeki kapasitesi, mevcut ve planlanan modüller üzerinden anlatılır.

---

## 1. Bağlam

Su ürünleri yetiştiriciliğinde mortalite, işletme kârlılığını belirleyen birincil değişkendir. Endüstri ortalaması yıllık %15–30 aralığındadır. Stok, yem, işçilik ve enerji maliyetleri, kayıp balıkla birlikte geri dönülemez biçimde silinir.

AquaPlatform, mortalite zincirini birden fazla noktadan kıran bir SaaS yazılımıdır. Aşağıdaki bölümler sistemin kapasitesini operasyonel terimlerle açıklar; teknik referanslar minimum tutulmuştur.

---

## 2. Temel Özellikler

### 2.1 Su Kimyası Reçete Motoru

Sistem; sıcaklık, pH, alkalinite, tuzluluk ve toplam amonyak gibi parametrelerden yola çıkarak amonyağın zehirli formunu (NH₃), karbondioksit ve hidrojen sülfür konsantrasyonlarını bilimsel literatürün referans denklemleriyle hesaplar. Sonuç, operatöre ham veri olarak değil, somut dozaj reçetesi olarak sunulur:

> *"Tank A için 12.4 kg sodyum bikarbonat eklenmesi gerekir. Sonuç: pH 7.2 → 7.4, NH₃ güvenli sınırda kalır, CO₂ kritik bölgenin dışına çıkar."*

Reçete motoru, su sıcaklığı, asit-baz dengesi ve tuzluluk birlikte değiştiğinde toksisite eşiklerini eş zamanlı yeniden hesaplar.

### 2.2 Birleşik Faz Diyagramı

NH₃, CO₂ ve H₂S zehirlilik bölgeleri, aynı tuvalde alkalinite-DIC eksenleri üzerinde birlikte çizilir:

- Yeşil bölge: güvenli işletme aralığı
- Kırmızı bölgeler: zehirlilik eşiklerinin aşıldığı alanlar
- Mavi nokta: tankın anlık durumu
- Hedef nokta: ulaşılması istenen su kimyası
- Yön okları: ilave edilecek kimyasalın tankı hangi yöne çekeceği

Operatör, beş ayrı parametre grafiğini zihninde birleştirmek yerine tankın güvenli bölgeye olan uzaklığını tek bir görselden okur.

### 2.3 Optimum Bölge Yönetimi

Sistem, tankı güvenli faz bölgesi içinde tutmayı hedefler. Sapma başladığı an çoklu kimyasal seçenekli geri-dönüş planı üretir; her seçenek için gram cinsinden miktar, uygulanabilirlik notu ve risk skoru verilir. Operatör en uygun yolu seçer.

Reçete tek seferde değil, adım adım uygulanır:

1. Sistem reçeteyi alt-adımlara böler ve her adımın tahmini sonucunu önceden gösterir.
2. Operatör birinci adımı uygular.
3. Yeni su örneği ölçülüp sisteme girilir.
4. Sistem tahminle gerçek sonucu karşılaştırır; sapma varsa kalan adımlar yeniden hesaplanır.
5. Döngü tamamlanana kadar devam eder.

Bu çalışma biçimi, tek seferde aşırı doz uygulanmasının doğurabileceği pH veya alkalinite şokunu yapısal olarak engeller.

### 2.4 Ekipman Atfı

Sistemin önerdiği her reçete, kullanılacak ekipmanın listesiyle birlikte gelir (CO₂ tüpü, dozlama hattı, degassing ünitesi, dozaj pompası vb.). Bunun yanında sapmaya yol açan ekipman (örn. devre dışı kalmış degassing ünitesi, durmuş aerator) operatöre bildirilir. Hatalı ekipman bulma süresi bu atıf sayesinde kısalır.

### 2.5 Uydudan Çevresel İzleme (Deniz Kafes Çiftlikleri)

Sistemde iki ayrı uydu kaynağı entegredir:

- **Sentinel-2 / Copernicus Data Space Ecosystem (optik):** Çiftlik koordinatlarındaki kıyı suyunun gerçek görüntüsü; klorofil yoğunluğu, alg patlaması belirtileri, su rengi anomalileri.
- **Copernicus Marine CMEMS (model):** Deniz Yüzey Sıcaklığı (SST), tuzluluk ve akıntı tahmini.

Optik kaynak mevcut durumu, model kaynak yaklaşan durumu sağlar. Yaklaşan zararlı alg patlaması veya sıcaklık anomalisi 48–72 saat öncesinden öngörülür; kafes operasyonu (ağ derinliği, hasat zamanı) buna göre ayarlanabilir.

### 2.6 Lot Bazlı İzlenebilirlik

Yem ve kimyasal lotları girişten tüketime kadar dakika hassasiyetinde izlenir. İki lotun bir siloda karışması "MIX-LOT1-LOT2" olarak işaretlenir. Bir mortalite olayı sonrası kaynağa, AB gıda güvenliği kapsamındaki 2 saatlik geri-izlenebilirlik standardına uygun şekilde ulaşılır. Bozuk veya süresi geçmiş lotun çiftlik genelindeki etki alanı sınırlanır.

### 2.7 Bilimsel Bilgi Tabanlı Hastalık Erken Uyarısı

Balık hastalıkları büyük ölçüde çevresel tetikleyicilere bağlıdır. Örneğin:

- Su sıcaklığının uzun süre düşük seyretmesi, somonlarda Soğuk Su Hastalığı (BCWD) ve IPN riskini artırır.
- Sıcaklığın 18°C üzerine çıkması, levrek/çipurada Vibriozis riskini artırır.
- Düşük oksijen ve yüksek amonyak birlikteliği bağışıklık sistemini zayıflatır.
- Tuzluluk şokları mantar enfeksiyonlarına zemin hazırlayabilir.

AquaPlatform, çevresel parametrelerin bu tür risk paternlerine girdiği durumlarda yöneticiye bilimsel kaynaklı uyarı sunmayı hedefler:

> *"Tank 7'de su sıcaklığı 5 gündür 8°C altındadır. Yetiştirilen tür Atlantik somonudur. Mevcut literatür (Holt 1972, Starliper 2011) bu koşullarda BCWD riskinin yükseldiğini belgeler."*

Uyarı, dayanak kaynak referansıyla birlikte sunulur; bu sayede aktarılan bilgi izlenebilir bir bilimsel temele oturur.

**Tedavi Paketi:**

Sistem, hastalık riskini bildirmenin yanında ilgili tedavi bilgisini de tek ekranda toplamayı hedefler:

- Önerilen ilaçlar ve dozlar (tür, ağırlık, hastalık özelinde)
- İlaç çekilme süresi (withdrawal period — gıda güvenliği kapsamında zorunlu)
- İlaç-ilaç ve ilaç-su kalitesi etkileşim uyarıları
- Yetkili balık veterineri dizini ve doğrudan iletişim
- Tedarikçi entegrasyonu üzerinden ilaç tedariki
- Tedavi takvimi (doz aralıkları, kontrol gözlemleri)

**Bilgi Tabanı Yapısı:**

Sistem, bilimsel makale yüklenebilir bilgi tabanı mimarisi üzerine kuruludur. Tür-spesifik hastalık-koşul ilişkileri, çevresel tetikleyici eşikleri, büyüme eğrileri ve tedavi protokolleri zaman içinde sisteme eklenir. Yeni bir araştırmanın yüklenmesi, tüm tenant'ların korumasını eş zamanlı günceller.

**Mevcut ve Planlanan Modüller:**

| Modül | Durum |
|---|---|
| Hastalık olay kaydı (semptom kategorileri) | Üretimde |
| Tedavi kaydı, ilaç adı, başlangıç-bitiş tarihi | Üretimde |
| İlaç çekilme süresi takibi | Üretimde |
| Hasta tankın hasat ve transfer blokları | Üretimde |
| Çevresel parametre takibi | Üretimde |
| Çapraz-domain korelasyon motoru | Üretimde |
| Bilimsel kaynaklı hastalık-koşul kütüphanesi | Planlanan |
| Otomatik tahmine dayalı hastalık uyarısı | Planlanan |
| Tür-spesifik hastalık risk skorlaması | Planlanan |
| İlaç ve doz öneri kütüphanesi | Planlanan |
| İlaç-ilaç + ilaç-su kalitesi etkileşimi | Planlanan |
| Yetkili veteriner dizini | Planlanan |
| Tedarikçi entegrasyonu | Planlanan |
| Tedavi takvimi otomasyonu | Planlanan |

---

## 3. Yapay Zekâ Mimarisi

Sistemde yapay zekâ, kimya hesaplarını veya doz miktarlarını kendisi üretmez. Tüm sayısal hesaplamalar; bisection algoritmaları, Millero (1995, 2010) dissosiasyon sabitleri ve karbonat sistem denklemlerinden oluşan deterministik araçlar tarafından yapılır. Yapay zekâ bu araçları çağırır ve sonucu olduğu gibi aktarır.

Bu mimari iki sonucu doğurur:

1. Üretilen sayılar, aynı girdi için her zaman aynıdır; kanıtlanabilir ve tekrarlanabilirdir.
2. Dil modelinin halüsinasyon riski, mortalite-kritik dozaj kararlarına taşınmaz.

Yapay zekâ; günlük operasyon brifingi, kök-neden analizi, anomali tespiti ve operatör asistanı rollerinde kullanılır. Bu rollerde de altta her zaman deterministik araçlar çalışır.

---

## 4. Operatör ve Saha Bileşenleri

### 4.1 Mobil Uygulama (AquaMobil)

- Kritik alarmlar, push bildirim altyapısı üzerinden operatörün cihazına saniyeler içinde ulaşır.
- Saha su kalitesi ölçümleri tank başında girilir; sistem değerleri anında doğrular ve sınır dışı değerleri işaretler.
- Mortalite kayıtları 13 hazır kategori üzerinden alınır; serbest metin yerine yapısal veri toplanır.
- Yem kayıtlarında plandan ±%20 sapma otomatik uyarı üretir.
- İnternet bağlantısı yoksa veriler cihazda tutulur, bağlantı yeniden kurulduğunda senkronize olur.
- Sahada operatör, ilgili AI asistanından somut talimat isteyebilir.
- Mobil iş emirleri fotoğraf kanıtıyla kapatılır.

### 4.2 İK ve Yetkilendirme

- Sertifikası dolmuş personel, kritik göreve sistemsel olarak atanmaz.
- Vardiya yönetimi, eskalasyon ladderı ile birlikte çalışır: alarm operatör tarafından zamanında ele alınmazsa yöneticiye yönlendirilir.
- Personel kompetansı, eğitim-sertifika izleme servisi üzerinden takip edilir.

### 4.3 Ekipman Bakımı

- Pompa, havalandırıcı ve filtre için tekrarlı bakım takvimleri otomatik iş emri üretir.
- Bakım çıktısı fotoğraf kanıtı ile dokümante edilir.

---

## 5. Mortaliteye Doğrudan Etki Eden 19 Mekanizma

Aşağıdaki maddeler, sistemin balık ölümünü doğrudan azaltma yönündeki kapasitesini operasyonel dilde özetler.

1. Sistem tankın suyunu kesintisiz ölçer ve değerlerin bozulmaya başladığı anda uyarı üretir.
2. Sistem suyun içindeki zehirli maddeleri sıcaklık, asit-baz seviyesi ve tuzluluk değerleriyle birlikte değerlendirir.
3. Sistem hangi kimyasaldan ne kadar eklenmesi gerektiğini gram cinsinden hesaplar.
4. Sistem aynı problem için birden fazla kimyasal seçeneği sunar ve en güvenli olanı işaretler.
5. Sistem reçeteyi tek seferde değil, kontrollü alt-adımlara böler.
6. Sistem her adımın tahmini sonucunu önceden gösterir.
7. Sistem doz sonrası gerçek ölçümle tahmini karşılaştırır ve sapma durumunda reçeteyi yeniden hesaplar.
8. Sistem tüm zehirli maddelerin durumunu tek bir grafikte birleştirir.
9. Sistem güvenli işletme bölgesini çizer ve tank bu bölgeden çıkmaya başladığında uyarır.
10. Sistem sapmaya yol açan ekipmanı operatöre bildirir.
11. Sistem yetiştirilen türe göre limitleri otomatik uygular.
12. Sistem tank kapasitesinin üstünde stoklamaya izin vermez.
13. Sistem havalandırıcının açılıp kapanmasını uzaktan tetikleyebilir.
14. Sistem kritik alarmları kayıp riskine karşı kalıcı kuyrukta saklar.
15. Sistem hasta tanktan başka tanka balık geçişini engeller.
16. Sistem kritik alarmı operatörün cihazına saniyeler içinde iletir.
17. Sistem sahada girilen ölçüm değerini anında doğrular.
18. Sistem internet bağlantısı yokken de kayıt almaya devam eder.
19. Sistem aşırı yemleme sapmasını otomatik uyarıyla işaretler.

---

## 6. Mortaliteye Dolaylı Etki Eden 16 Mekanizma

Aşağıdaki maddeler, operatör hatasını veya gecikmeli kararı azaltarak mortaliteyi engelleyen mekanizmalardır.

20. Sistem mortalite olayının nedenini geriye dönük olarak analiz eder.
21. Sistem her sabah çiftlik geneli risk-anomali raporunu yöneticiye iletir.
22. Sistem operatöre, sahada uzman seviyesinde aksiyon önerisi sunar.
23. Sistem yapay zekâ kaynaklı sayısal hata üretmez; tüm hesaplar deterministik araçlardan gelir.
24. Sistem yem stok seviyesini izler ve stoğun bitmesinden önce sipariş uyarısı verir.
25. Sistem süresi geçmiş veya bozulmuş yem lotunu tüketim akışından izole edebilir.
26. Sistem ekipman bakım takvimini otomatik yönetir.
27. Sistem sertifikası dolmuş personeli kritik göreve atamaz.
28. Sistem alarmların hiç sahipsiz kalmaması için eskalasyon kuralları işletir.
29. Sistem deniz kafes çiftliklerinde uydu üzerinden çevresel risk takibi yapar.
30. Sistem hava durumu verisini operasyon planına entegre eder.
31. Sistem mortalite kayıtlarını 13 hazır kategori üzerinden alır; veri kalitesini korur.
32. Sistem bakım iş emirlerini fotoğraf kanıtıyla kapatır.
33. Sistem küçük çevresel sapmaları anomali tespiti üzerinden erkenden işaretler.
34. Sistem her tank için 48 saatlik risk skoru üretir.
35. Sistem yöneticinin operasyonel veri toplama yükünü tek pano üzerinden azaltır.

---

## 7. Şeffaflık Notu

Bu belge, sistemin mevcut kapasitesini ve roadmap'teki modülleri ayrı tutar. "Üretimde" başlığı altındaki modüller şu an çalışmaktadır; "Planlanan" başlığı altındakiler aktif geliştirme içindedir.

Mortalite azaltmaya ilişkin niceliksel etki (yüzde olarak azalma, geri ödeme süresi vb.) çiftliğe özel pilot ölçümlerle belirlenir; bu belgede genel rakam taahhüdü verilmemiştir. Ölçüm metodolojisi ve pilot süreç ayrıca belgelenmektedir.

Sistemin balık ölümünü hangi mekanizmalarla azalttığı ve hangi alanlarda hâlâ gelişim aşamasında olduğu yukarıda nesnel biçimde özetlenmiştir. Operasyonel kullanıcı, dilediği modülün çalışma şekline ait ayrıntılı teknik dokümantasyona ürün ekibinden ulaşabilir.
