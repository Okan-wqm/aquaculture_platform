# Hukuk ARIA'sı — Rakip Kataloğunun Değerlendirmesi ve Yol Haritası

Durum: TASLAK. `docs/TANIM.md` kapsamı, bu belge **sırayı** tanımlar. Girdi: 2026-09-03
tarihli "ARIA Legal — Rakip Yetenek Araştırması ve Hukuk Kasları Kataloğu" (LAW-01..23).

---

## 0. Karar

**Katalog iyi bir alan haritası, kötü bir yol haritasıdır.** Alan modeli, kayıt türleri,
kapılar ve kabul ölçütleri büyük ölçüde doğru ve kullanılabilir. Sıralama ise inşa
edilebilir bir plan değil, dört ayrı pazarın özellik listelerinin birleşimidir.

Üç somut sorun:

1. **Ölçek.** Yirmi üç kas, her biri altı ila dokuz işlev: yaklaşık yüz seksen yetenek.
   Bu bir ürün planı değil, bir sektör haritasıdır.
2. **Hiçbir aşama tek başına değer üretmiyor.** Katalogun "Seviye 0"ı (LAW-01, 03, 18, 19,
   23) tamamlanmadan kullanıcıya hiçbir şey gösterilmiyor; o seviye tek başına aylarca iş.
   Bir avukatın ödeyeceği ilk sonuç en erken "Seviye 1" sonunda çıkıyor.
3. **Bizde ne olduğunu saymıyor.** Aşağıdaki ölçüm, katalogun en ağır iki maddesinin
   ARIA çekirdeğinde zaten var olduğunu gösteriyor. Bunları yeniden yazmak, yapılabilecek
   en pahalı hata olurdu.

Ayrıca dikkat: rakip yetenekleri üreticilerin kendi sayfalarından türetilmiş. Bunlar bir
alan haritası için yeterli, bir **farklılaşma** analizi için değildir. Farklılaşma özellik
listesi karşılaştırmasından değil, avukatın başka yerden alamadığı sonuçtan çıkar.

---

## 1. Ölçüm — katalogun Seviye 0'ı bizde ne kadar hazır

2026-09-04, `new-aria/aria-kernel` üzerinde sayıldı.

| Katalog maddesi | Çekirdekteki karşılığı | Durum |
|---|---|---|
| **LAW-19** güvenlik, audit, AI yönetişimi | `ledger` (hash zinciri), `evidence_validator`, `evidence_trust`, `runtime_profile`, `implementation_safety`, `incident_ledger`, `runner_attestation`, `rollback_bundle`, `budget`, `cost_budget`, `circuit_breaker`, `tool_registry`, `agent_runtime_profile`, `artifact_safety` — 14 modül, ~10.000 satır | **Büyük ölçüde var** |
| **LAW-23** AI doğruluk laboratuvarı | `judge_fanout`, `judge_calibration`, `independence_check`, `feedback_store`, `goldset`, `fixture_runner`, `agent_eval`, `calibration`, `adapter_calibration`, `burn_in`, `plan_convergence` — 11 modül, ~9.500 satır | **Büyük ölçüde var** |
| **LAW-03** forensic ingest, chain of custody | Hash-zincirli defter, artifact hash'i, `legal-document-inventory` adapter'ı (envanter, sha256, kapsama) | **Yarısı var**: custodian, collection, evidence receipt eksik |
| **LAW-18** GDPR, records, legal hold | `enterprise/retention-proofs`, `enterprise/dlp-proofs`, `dlp-scan-snapshots` yüzeyleri | **Kısmi** |
| **LAW-01** matter sınırı, etik duvar | Matter varlığı yok, ABAC yok, bellek isim-alanı yok | **Yok** |

Sonuç: katalogun "önce bunları yapın" dediği beş maddeden ikisi ARIA'nın hâlihazırdaki en
olgun tarafı. Yol haritası bunları **kullanmak** üzerine kurulmalı, yeniden yazmak üzerine
değil.

---

## 2. Gerçek kritik yol katalogda yazılan değil

Katalog, ön koşulu Plan 032'ye bağlıyor. Ölçtüğümüz engeller başka:

| Engel | Neden hukuk için bağlayıcı | Kimlik |
|---|---|---|
| Kanıt derecelendirmesi git blob'una bağlı | Dava arşivinde git yok; kanıt hiçbir zaman `repo_verified` olamaz | **G-1** |
| Bellek isim-alanı yok | İkinci bir dava geldiğinde duvar yok; ayrıca çekirdek müvekkil-gizli malzeme taşırsa lisanslanamaz | **G-2** |
| Ajan hedef listesi kapalı | Hukuk ajanları kernel kuyruğundan dispatch edilemez | **G-3** |
| İddia türleri kod-alanına sabit | Hukuk bulguları çekirdek bulgu defterine giremez | **G-4** |

Plan 032'nin kasları (hook, checkpoint, session continuity, event gateway) faydalı ama
hukuk ürününün önündeki dört engelden hiçbiri değil. Bu düzeltme, katalogun 5. bölümünün
yerine geçer.

---

## 3. Yol haritası — her aşama tek cümlelik kanıtlanabilir sonuç

Kural: bir aşama, tek başına bir avukata gösterilebilir bir sonuç üretmiyorsa aşama
değildir. Her aşamanın çıktısı, testi ve gerektirdiği çekirdek boşluğu yazılıdır.

### S0 — "Arşivi bozmadan aldım ve hiçbir şey kaybolmadı"

Teslim: salt-okunur alım, her dosyaya bir kader, sha256, custodian ve toplama kaydı,
kapsama raporu, imzalı **evidence receipt**.
Kanıt: orijinal bayt değişimi sıfır; kapsama `complete: true`; aynı arşiv iki kez
alındığında bayt-eş manifest; dışlanan kök raporlu; okunamayan dosya bulgu.
Gerektirdiği: **G-1**.
Karşılığı: LAW-03 ve LAW-04'ün bir kısmı.
Neden tek başına değerli: elinde üç bin dosya olan avukat, karşı tarafa ve mahkemeye
gösterebileceği bir teslim tutanağı alır. Bugünkü adapter bunun yarısını zaten yapıyor.

### S1 — "O tarihte ne biliniyordu?"

Teslim: sürümlü olgu kaydı (`valid_time` / `system_time` ayrı), belge ailesi ve sürüm soy
ağacı, sayfa/span düzeyinde kaynak, kronoloji görünümü, belirsiz tarih temsili.
Kanıt: geriye dönük değiştirilmiş belge fikstüründe "o gün bilinen" ile "bugün bilinen"
doğru ayrılır; her olgu en az bir içerik-hash'li kaynağa bağlı.
Gerektirdiği: S0.
Karşılığı: LAW-06, LAW-07, LAW-05'in bir kısmı.
Neden burası ayrım noktası: olgu-kaynak bağı piyasada var; **bitemporal ayrım** ve
"o tarihte hangi sürüm geçerliydi" sorusu nadir.

### S2 — "Bu iddianın arkasında ne var, ne çelişiyor, ne eksik — bir de karşı taraf gözüyle"

Teslim: iddia-unsur-olgu-kanıt matrisi, çelişki ve eksik-bilgi motoru, karşıt ajan
geçişi, avukat doğrulama akışı.
Kanıt: kontrollü çelişki/boşluk korpusunda ölçülen recall; avukat onayı olmadan hiçbir
kayıt `verified` olmaz; her uyarı iki taraflı kaynak bağı taşır.
Gerektirdiği: **G-3**, **G-4**.
Karşılığı: LAW-08, LAW-09 ve LAW-23'ün uygulanmış hâli.
Neden ucuz: `judge_fanout`, `independence_check`, konsensüs arbiter ve kalibrasyon zaten
var. Yapılacak iş, hukuk kayıtlarını bu hatta bağlamak.

### S3 — "Her cümlenin kaynağı var"

Teslim: kronoloji, matris ve memo çıktıları; her olgusal cümle kanıt atfına bağlı;
kaynaksız cümle üretilemez.
Kanıt: taslaktaki her iddia için provenance kapsaması; uydurma atıf sıfır.
Sınır: **hukukî önerme** taslağı ancak lisanslı hukuk kaynağı bağlayıcısı varken açılır.
O bir mühendislik değil, lisans ve ticaret meselesidir. Bağlayıcı yokken çıktı, külliyattan
gelen olgusal iddialarla sınırlı kalır ve bu açıkça yazılır.
Karşılığı: LAW-11, ve yalnız lisans varsa LAW-10.

### S4 — "İkinci dava geldiğinde duvar var"

Teslim: matter ve taraf modeli, etik duvar, çıkar çatışması adayları, saklama ve legal
hold.
Kanıt: iki karşıt matter'la kurulan testte arama, indeks, cache, özet, log ve export
katmanlarının hiçbirinde sızıntı yok.
Gerektirdiği: **G-2** (isim-alanı, reddeden kapı olarak).
Karşılığı: LAW-01, LAW-18, LAW-20 ve LAW-02'nin conflict kısmı.
O güne kadar duvar nedir: **dava kümesi başına ayrı örnek**. Bu bir eksiklik değil,
bilinçli bir sınır ve `aria.manifest.json` içinde `enforced_by: instance_isolation`
olarak yazılıdır.

---

## 4. Yapmayacaklarımız ve nedeni

| Katalog maddesi | Karar | Gerekçe |
|---|---|---|
| LAW-17 zaman, fatura, **trust accounting** | Yapılmaz, entegre edilir | Müvekkil parası düzenlenmiş finansal yazılımdır. Yapay zekâ yeteneği değil; ayrı bir uyum ve sorumluluk işidir. Clio ve Smokeball bunu yıllardır yapıyor. |
| LAW-14 mahkeme portalına **gönderim** | Yapılmaz | İmza ve gönderim avukatın yetkisidir. Bizim üreteceğimiz şey gönderime hazır paket ve kontrol listesidir; makbuzu avukat geri getirir. |
| LAW-02 **AML/KYC programı** | Yapılmaz | Kapsam belirleme hukukî bir karardır; yanlış kapsam gereksiz kişisel veri toplamaya yol açar. |
| LAW-12 e-discovery **ölçeği** | Yapılmaz, entegre edilir | Milyon belgeli production Everlaw ve Relativity'nin işidir. Bizim ölçeğimiz tek dava kümesidir. |
| LAW-16, LAW-22 büro ve DMS platformu | Aşamanın ihtiyacı kadar bağlayıcı | Clio/iManage yeniden yazılmaz; yalnız o aşamanın gerektirdiği bağlayıcı yazılır. |

Bu liste ürünü zayıflatmaz. Neyi yapmadığını söyleyemeyen bir hukuk ürünü satılamaz.

---

## 5. Korunan kısımlar

Katalogun iki bölümü olduğu gibi alınır:

- **Sıfır-tolerans kabul ölçütleri** (10. bölüm): orijinal delil değişimi sıfır, yetkisiz
  cross-matter erişim sıfır, kaynaksız atıf sıfır, avukat onayı olmadan dış etki sıfır.
  Bunlar `aria.manifest.json` içindeki `release_thresholds` ile aynı dili konuşur.
- **Asla otonomlaştırılmayacak kararlar** (8. bölüm): `config/approval-policy.json`
  içindeki kapıların kaynağıdır ve orada avukat rolüne bağlanmıştır.
- **Özellik sözleşmesi** (7. bölüm): her LAW maddesi bu sözleşmeyle açılır. Tek ekleme:
  sözleşme, hangi kasın (`packs/<id>`) ve hangi örneğin (`arias/<id>`) altında yaşayacağını
  ve hangi `G-*` boşluğuna bağlı olduğunu da beyan eder.

---

## 6. Konumlandırma

Katalogun kapanış cümlesi doğru yönü gösteriyor; şu şekilde keskinleştiriyorum:

> Hukuk ARIA'sı, avukatın yerine karar veren bir asistan değil; **kanıtsız tek bir cümle
> üretemeyen** bir dava çalışma sistemidir. Delili bozmadan alır, neyin ne zaman
> bilindiğini ayırır, her iddiayı içerik hash'li kaynağa bağlar, kendi bulgusuna karşı
> argüman arar ve dışarıya çıkan hiçbir etkiyi avukat onayı olmadan üretmez.

Rakiplerin hiçbirinde bu dördü birden yok: içerik-hash'li kanıt zinciri, bitemporal olgu
ayrımı, karşıt ajan doğrulaması ve yeniden oynatılabilir karar defteri. Üçü ayrı ayrı
piyasada var; birleşimi ARIA'nın çekirdeğinden geliyor ve o çekirdek bizde zaten çalışıyor.

---

## 7. Sıradaki tek adım

**G-1'i kapat.** Kanıt derecelendirmesini git blob'undan içerik-adreslemeye taşı. S0'ın ve
dolayısıyla bütün hukuk hattının ön koşulu budur; kapanana kadar hukuk kası kendi hash
zincirini taşımak zorunda ve bu, çekirdeğin kanıt yasasının dışında bir yol demektir.
