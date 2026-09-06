# Hukuk ARIA'sı — Tanım

Durum: hedef ürün tanımı, 2026-09-06 kullanıcı açıklamasıyla güncellendi. Bu belge
MVP'nin amacını tanımlar; çalışan yeteneklerin kanıtı
[YETENEK-KAYDI §C](YETENEK-KAYDI.md#c-güncel-uygulama-sırası-2026-09-06) içindedir.
Çalışma zamanı otoritesi `aria.manifest.json` ve çekirdek sözleşmeleridir.

## 1. Bu ARIA nedir

Hukuk ARIA'sının birincil amacı, avukatın müvekkilini savunmasına yardımcı olmaktır.
Davanın belgelerini, olaylarını, tarihlerini, kişilerini ve sorumluluklarını kaynaklarıyla
düzenler; avukatın sorularını bu çalışma seti ve kullanıcının sağladığı hukuk kuralları
üzerinden yanıtlamayı hedefler. Şirketler ve kamu kurumları da kendi yetkili dava
çalışmalarında aynı yöntemden yararlanabilir.

Kalıcı dava hafızası; kaynak bağlarını, önceki çalışmaları, avukat düzeltmelerini ve
onaylarını oturumlar arasında korumalıdır. Yeni belge veya düzeltme geldiğinde etkilenen
bilgi ve cevaplar izlenebilir biçimde güncellenmelidir.

Kaynağa bağlamak, yorumun doğru olduğunu tek başına kanıtlamaz. Her olgusal ve hukukî
iddia dayanağını göstermeli; çıkarım, karşı kanıt, belirsizlik ve bilinmeyenler görünür
olmalıdır. Kaynaklar cevap vermeye yetmiyorsa sistem bunu söylemeli ve sonuç çıkarmaktan
kaçınmalıdır. ARIA'nın kendi çıktısı bağımsız kanıt sayılmaz.

## 2. MVP'nin sekiz sonucu

| # | Avukata gösterilecek sonuç |
|---|---|
| M1 | Büyük ve karmaşık veri setinin yapılandırılması |
| M2 | Olay ve belgelerin kronolojik bağlanması |
| M3 | Eksik veya tutarsız bilginin tespiti |
| M4 | Bilginin farklı sürümlerinin karşılaştırılması |
| M5 | Süreç ve sorumlulukların yeniden kurulması |
| M6 | Veri bütünlüğü ve usul sorunlarının işaretlenmesi |
| M7 | Aynı metodolojinin anonimleştirilmiş davalara uygulanması |
| M8 | Avukat, şirket ve kamu kurumu için destek yüzeyi |

Yaklaşık NOK 5 milyonluk gerçek dava, bu sonuçları sınamak için doğrulama malzemesidir;
ürünün kendisi değildir. Bir aylık hedef sırası ve gerekli girdiler
[YOL-HARITASI](YOL-HARITASI.md) içindedir.

## 3. Kaynak ve bilgi sınırı

- Dava bilgisi kullanıcının sağladığı arşivden gelir. Orijinal bayt, içerik hash'i,
  alım zamanı, belge sürümü ve alıntı konumu birlikte izlenmelidir.
- Hukukî dayanak yalnız kullanıcının sağladığı mevzuat ve kurallardır. Ürün dış web
  araması yapmaz; dış hukuk kaynağı bağlayıcısı MVP'nin ön koşulu değildir. Kullanıcı,
  kullanım kapsamını belirlediği malzemeyi sürümü ve uygulanacağı zaman bilgisiyle sağlar.
- Olay zamanı, ilgili kişinin öğrenme zamanı ve sisteme alım zamanı ayrı tutulmalıdır;
  bilinmeyen bir zaman başka bir tarihten varsayılmaz.
- Okunamayan, dışlanan veya yalnız bir bölümü işlenen kaynaklar ve etkiledikleri
  cevaplar belirtilmelidir. `coverage.complete`, bütün dosyaların anlaşıldığı veya
  hukukî analizin tamamlandığı anlamına gelmez.

## 4. Bugün çalışan kapsam

Mevcut hukuk çalışma zamanı; dava erişimi, belge alımı, imzalı tutanak, yalıtılmış
envanter koşumu ve mekanik belge/kronoloji/matris/sürüm görünümlerini içerir. Büyük
karma arşivin tamamı, anlamsal dava analizi, yüklenen kurallarla cevap verme ve kalıcı
AI dava hafızası için kabul kapıları açıktır. Küçük sentetik korpus ve altyapı testleri
bu ürün kabulünün yerine geçmez; güncel kanıt ve açık işler §C'de izlenir.

Manifestin mevcut `non_goals` ve onay kapıları çalışan derlemenin sınırlarıdır. Bu hedef
tanımı onları açmaz. Yeni analiz ve hafıza akışları, ilgili uygulama ve kabul çalışmasıyla
devreye alınmalıdır; mekanik çıktı hukukî hüküm veya doğrulanmış olay olarak sunulmaz.

## 5. Avukatın kararı ve ölçülebilir kabul

`verified` durumu yalnız kaydedilmiş insan doğrulamasıyla oluşur. Taraf birleştirme,
sunulan sürüm ilanı, karartma ve dışarıya dosyalama gibi kararlar
`config/approval-policy.json` kapılarına bağlıdır. Avukat, ARIA'nın önerisinin dayanağını
inceleyip kabul edebilmeli, düzeltebilmeli veya reddedebilmelidir.

Kabul, avukatın etiketlediği temsilî arşiv ve sorular üzerinde ölçülür: kaynak/alıntı
doğruluğu, beklenen olay ve sorunları bulma oranı, yanlış uyarılar, belirsiz sorularda
cevap vermeme, kaynak kapsamı ve oturumlar arası düzeltme sürekliliği raporlanır.
Girdiler ve başarı eşikleri değerlendirmeden önce kaydedilir. Bulgular avukatça
incelenir; ölçüm, hatasızlık veya sıfır halüsinasyon garantisi olarak genellenmez.
