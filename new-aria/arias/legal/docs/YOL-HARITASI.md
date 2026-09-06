# Hukuk ARIA'sı — MVP Yol Haritası

Güncelleme: 2026-09-06 kullanıcı açıklaması. [TANIM](TANIM.md) ürün amacını; bu belge
bir aylık gösterim hedefini ve gerekli girdileri tanımlar. Güncel uygulama durumu,
Faz 0–8 sırası ve açık kabul kapıları
[YETENEK-KAYDI §C](YETENEK-KAYDI.md#c-güncel-uygulama-sırası-2026-09-06) içindedir.

## 1. Hedef ve başlangıç noktası

Hedef, avukatın müvekkilini savunmasına yardımcı olan, dava bilgisini düzenleyen,
kaynaklarıyla cevap veren ve avukat düzeltmelerini kalıcı hafızasında koruyan asistandır.
Yaklaşık NOK 5 milyonluk dava doğrulama malzemesidir; aynı yöntem başka davalara da
uygulanmalıdır. Ürün yalnız sağlanan dava belgeleri ve hukuk kurallarını kullanır;
dış web araması yapmaz.

Bugün çalışan mekanik envanter ve imzalı alım/yayın altyapısı bu hedefin başlangıcıdır.
Anlamsal analiz, sağlanan kurallarla cevap ve kalıcı AI dava hafızası tamamlanmış değildir.
Aşağıdaki dört hafta bir **hedef sırasıdır**; teslim garantisi veya bütün R1 üretim
kapılarının kapanacağı beyanı değildir. Takvim, temsilî girdilerin erişilebilirliği ve
avukat değerlendirmesiyle netleşir; her haftanın sonucu kendi kanıtıyla kabul edilir.

## 2. Dört haftalık hedef sırası

| Hafta | Hedeflenen sonuç ve gösterim | Gereken girdi ve kabul kanıtı |
|---|---|---|
| 1 | **M1 — Büyük ve karmaşık veri setini yapılandırma; M6 — veri bütünlüğü kısmı.** Arşivi al, bütün dosyaları erişilebilir kıl, kopya/sürüm adaylarını ve okunamayanları göster. Kuralların kaynak/sürüm kaydını ve dava hafızasının kayıt modelini kur. | Kullanım kapsamı belirlenmiş temsilî arşiv, dosya/biçim/boyut dökümü, dışlamalar, sağlanan hukuk metinleri. Orijinal hash mutabakatı; yükleme → iş → yayın → arayüz boyunca tam sayfalama ve yeniden başlatma deneyi. |
| 2 | **M2 — belge–olay kronolojisi; M4 — sürüm karşılaştırması; M5 — süreç ve sorumlulukları yeniden kurma.** Tarihleri, olayları, kişileri ve sorumluluk ifadelerini kaynak yerleriyle bağla; değişen içeriği iki sürüm üzerinde göster. Dava hafızasına bu ilişkileri ve avukat düzeltmelerini kaydet. | Avukatın etiketlediği örnek olaylar, zamanların anlamı, bilinen sürüm aileleri ve rol/sorumluluk dayanakları. E-posta gövdeleri dâhil karma biçimlerde kaynak doğruluğu; eksik/yanlış bağlantı raporu; yeni oturumda düzeltmenin korunması. |
| 3 | **M3 — eksik/tutarsız bilgi; M6 — usul sorunları kısmı.** Sağlanan kuralları kaynak göstererek dava sorularını yanıtla; destek, karşı kanıt, bilgi boşluğu ve olası usul sorunlarını ayır. Yeni belge geldiğinde etkilenen hafıza ve cevapları güncelle. | Kullanıcının sağladığı mevzuat/kural paketinin sürüm ve zaman bilgisi; avukatın beklenen cevapları, karşı örnekleri ve cevapsız kalması gereken soruları. Bulma oranı, yanlış uyarı, atıf doğruluğu ve doğru çekinme ölçümü; hukukî değerlendirme avukat incelemesine gider. |
| 4 | **M7 — aynı yöntemi anonimleştirilmiş davada uygulama; M8 — avukat desteği ve şirket/kamuya uygulanabilirlik.** İkinci davada aynı akışı çalıştır; pilot avukatın görev tamamlamasını ve yöntemin diğer kurumlara taşınma koşullarını göster; M1–M6'yı uçtan uca yeniden değerlendir. | Büro tarafından kontrol edilmiş anonim ikinci arşiv, ayrı erişim kapsamı ve gerçekçi görev/soru listesi. Yöntem tekrarının, kaynak bağlarının, dava ayrımının ve görev tamamlamanın avukat incelemesiyle raporu; ilk davaya özgü başarı ayrı belirtilir. |

Kalıcı hafıza ve sağlanan kurallarla kaynaklı cevap verme, bu gösterimin zorunlu
parçalarıdır. Yalnız belge tabloları ve mekanik çıkarım sonuçlarıyla MVP kabul edilmez.
M7, otomatik anonimleştirme sistemi kurmayı gerektirmez; denetlenmiş anonim girdiyle
yöntemin yeniden uygulanması gösterilir. M8, bir ayda üç ayrı pazar ürünü geliştirmek
anlamına gelmez; avukat pilotunun somut yararı ve diğer kurumlara taşınma sınırları
ortaya konur.

## 3. Ortak kabul yöntemi

Gösterimden önce arşivin büyüklüğü ve biçimleri, görevler, beklenen cevaplar ve ölçüm
eşikleri kaydedilir. Değerlendirme, geliştirme sırasında kullanılan sentetik fikstürlere
ek olarak avukatın etiketlediği temsilî örnekleri içerir.

Her sonuçta kaynak/alıntı doğruluğu, beklenen bilgi ve sorunları bulma oranı, yanlış
uyarılar, belirsiz sorularda cevap vermeme ve tamamlanamayan kaynak kapsamı raporlanır.
Avukat düzeltmesinin sonraki oturumda kullanılması ve yeni belgenin önceki cevaba etkisi
ayrıca sınanır. Küçük korpustaki iyi bir skor gerçek davalara veya hatasızlığa genellenmez.

Orijinal kaynak bütünlüğü, dava erişimi ve kaydedilmiş avukat onayı kapıları korunur.
Kurulum/izolasyon, kaynak ve türev silme, şifreli yedek/geri dönüş gibi açık R1 kapıları
§C'deki bulgularla izlenir; MVP gösterimi bunları kendiliğinden kapatmaz.

## 4. Önceki yol haritasının durumu

2026-09-03 rakip kataloğu (LAW-01…23), 2026-09-04 çekirdek modülü/satır sayımları ve
önceki S0–S4 sıralaması **tarihsel değerlendirmelerdir**. Modülün varlığı hukuk akışının
çalıştığını, üretim kalitesini veya rakiplere üstünlüğü kanıtlamaz. Önceki tamamlanma ve
pazar karşılaştırması ifadeleri güncel durum olarak kullanılmaz; bugünkü kanıt §C'dedir.

Önceki S3'teki dış/lisanslı hukuk kaynağı bağlayıcısı ön koşulunun yerini **kullanıcının
sağladığı kuralları içeriden alma, sürümleme ve kaynak gösterme** akışı alır. Kullanıcı,
kullanım hakkı ve kapsamı kendisince belirlenmiş malzemeyi sağlar. Ürünün dışarıdan
mevzuat araması veya kaynak satın alması bu MVP'nin şartı değildir.

Büro muhasebesi ve otomatik mahkeme gönderimi sekiz MVP sonucu arasında değildir.
`aria.manifest.json` ile `config/approval-policy.json` mevcut çalışma zamanı sınırlarını
belirlemeye devam eder; bu belge manifesti veya onay kapılarını değiştirmez.
