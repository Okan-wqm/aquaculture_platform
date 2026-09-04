# Hukuk ARIA'sı — Tanım

Durum: TASLAK. `arias/_template/` şablonundan türetilmiştir. Çalışma zamanı otoritesi
`aria.manifest.json` ve çekirdek kontratlarıdır; bu dosya kapsamı ve sınırı tanımlar.

## 1. Bu ARIA nedir

Bir dava dosyası arşivini, kanıta bağlı ve insan-doğrulamalı bir çalışma setine çeviren
ARIA örneğidir. Çekirdek değişmez; hukuk bilgisi kaslardan gelir.

Ayırt edici özellik "belge özetleyen asistan" olması değil, **kanıtsız iddia
üretememesi**: her kayıt külliyattaki bir dosyaya ve onun içerik hash'ine bağlanır,
ARIA'nın kendi çıktısı asla kanıt sayılmaz.

## 2. Kapsam

- Arşivin tam envanteri: her dosyanın bir kaderi vardır (okundu, yalnız metadata,
  okunamadı, dışlandı). Sessizce atlanan dosya yoktur.
- İçerik hash'i ve sürüm soy ağacı: hangi belge hangisinin sürümü, hangisi imzalı.
- Kronoloji: olayın gerçekleştiği tarih ile öğrenildiği tarih ayrı alanlardır.
- Taraflar: yalnız belge kanıtından, düşük güven skoruyla, birleştirilmeden.
- İddia-kanıt matrisi: her iddianın destekleyen ve çelişen kaynakları, eksik kanıt listesi.
- Kapsama raporu: neyin görülmediği, açıkça.

## 3. Amaç-dışı

`aria.manifest.json` içindeki `non_goals` ile birebir aynıdır. Özeti: hukukî sonuç yok,
OCR uydurma yok, otomatik kimlik birleştirme yok, sunulan sürümü ilan etme yok,
anonimleştirme garantisi yok, usul hukuku uygulaması yok.

## 4. Külliyat

Külliyat türü `document_archive`. Bu, çekirdeğin bugünkü git-şekilli kanıt modeliyle
doğrudan uyuşmaz: `evidence_trust` bir kanıtı ancak dosyanın sha256'sı git blob'uyla
eşleşirse `repo_verified` sayar; dava arşivinde git yoktur. Çekirdek boşluğu **G-1**
kapanana kadar bu ARIA kanıtını adapter'ın kendi sha256 zinciriyle taşır ve bu sınır
burada yazılıdır, varsayılmaz.

Dışlanan kök (`Ikke laste opp`) raporlanır, atlanmaz.

## 5. Kaslar

Bir kasın ayrı paket olmayı hak etmesi için üçünü birden taşıması gerekir: kendi fikstür
korpusu, kendi sürüm ritmi, onu diğeri olmadan kuran bir tüketici.

| Kas | Durum | Neden ayrı |
|---|---|---|
| `legal-evidence` | etkin | Kendi korpusu ve testleri var; envanter tek başına değer üretir |
| `legal-case-analysis` | taslak | Farklı ritim: matris ve kronoloji, envanterden bağımsız gelişir |
| `legal-foundation` | taslak | Kimlik ve gizlilik duvarı; ikisinin de altına girer |

Sonraya bırakılanlar ve gerekçesi:

- `legal-research` ayrı olacak, çünkü **farklı güven modeli** taşır: dış otoriter kaynak,
  geçerlilik süresi, atıf doğrulama. Aynı pakete girmesi kanıt disiplinini bulanıklaştırır.
- `legal-work-product` (dilekçe, memo taslağı) kanıt katmanı oturmadan başlamaz.
- `legal-office-operations` (zaman, faturalama, trust accounting) bir **kas değildir**;
  kanıt-çıkarım karakteri olmayan işlemsel iş yazılımıdır. ARIA kası olarak paketlenmesi
  iki farklı ürünü karıştırır.

## 6. Onay ve insan sınırı

`verified` durumu yalnız insanın kaydettiği bir doğrulamayla oluşur; hiçbir adapter ve
hiçbir ajan üretemez. Dışarı çıkan her etki (production, redaction, dosyalama) avukat
onayı ister. Ayrıntı: `config/approval-policy.json`.

## 7. Kabul ölçütleri

- Sentetik fikstür arşivinde adapter iki koşumda bayt-eş sonuç verir.
- Kapsama `complete: true`, dışlanan kök kayıtlı, okunamayan dosyalar bulgu olarak açık.
- Konsolda dava görünür: envanter, sürüm grubu, kronoloji, taraflar, boş iddia matrisi.
- Gerçek dosya kümesiyle çalışma yalnız operatör kontrolünde, tek dava, harici AI kapalı.

Eşik değerleri `aria.manifest.json` içindeki `evaluations.release_thresholds` alanındadır.
