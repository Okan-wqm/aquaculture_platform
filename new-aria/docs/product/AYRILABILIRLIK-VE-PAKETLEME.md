# new-aria — Ayrılabilirlik ve Ticari Paketleme Taslağı

Durum: **TASLAK v0**. `NEW-ARIA-URUN-TANIMI.md` mimari sınırı tanımlar; bu belge o
sınırın **ticari** karşılığını tanımlar: hangi parça ayrı bir varlıktır, kim neye sahip
olur, bir alan ürünü satıldığında geriye ne kalır. Kural kimlikleri `S-*` (ayrılabilirlik
yasası), `T-*` (satış senaryosu), `GS-*` (makine-denetlenebilir ayrılabilirlik kapısı).
Çalışma zamanı davranışında yine kod ve `CONTRACTS.md` kazanır.

---

## 0. Neden şimdi

Ayrılabilirlik sonradan eklenemez. Bir ürünü satılabilir kılan şey, satış anında yazılan
sözleşme değil, ondan önce **kodun ve geçmişin** o sınıra saygı duymuş olmasıdır. İki
alanı birden değiştiren tek bir commit, yıllar sonra temiz bir bölünmeyi imkânsız kılar.

Bugünkü ölçülmüş durum (2026-09-04, `aria-kernel` 306 modül):

| Gözlem | Değer | Ticari sonucu |
|---|---|---|
| Akuakültür servis adı geçiren üretim kernel modülü | 11 | Çekirdek üçüncü tarafa lisanslanamaz |
| Kernel'de sabit `tools/aria-adapters` yol bağı | 6 modül | Kas yeri çekirdeğe gömülü |
| Bellek isim-alanı (namespace) | yok | Müşteri verisi çekirdek hafızasına sızabilir |
| Yayımlanmış, sürümlü Core API | yok | Alıcı neye bağlandığını bilemez |

Bu dört satır, aşağıdaki `T-C` ve `T-D` senaryolarının bugün **yapılamaz** olmasının
tek sebebidir. Her biri bir ayrılabilirlik borcudur ve `NEW-ARIA-URUN-TANIMI.md` §3.1
içindeki `G-*` boşluklarına bağlanır.

---

## 1. Varlık haritası — kim neye sahip

Beş ayrı varlık vardır. Bunlar ayrı fiyatlanır, ayrı lisanslanır, ayrı satılabilir.

| Varlık | İçerik | Sahiplik varsayılanı |
|---|---|---|
| **ARIA Core** | `aria-kernel/**`, executor, defter, kanıt, güvenlik, planlama | Ana şirket. Satılmaz, **lisanslanır**. |
| **Domain Muscle** | `packs/<id>/**` — ontoloji, şema, adapter, ajan, politika, korpus | Alan başına ayrı varlık |
| **Product Surface** | `ui/**` ve alan ekranları, mobil, API | Ürün başına ayrı varlık |
| **Operatör Bilgisi** | çalıştırma disiplini, runbook, kalibrasyon geçmişi | Ana şirket |
| **Tenant/Case verisi** | dava dosyası, çiftlik telemetrisi | **Müşterinin**; bizde birleşmez |

Bir alan ürününü satmak, o alanın kasını ve yüzeyini satmak demektir. Çekirdek satılmaz;
alıcıya **kullanım hakkı** verilir. Böylece akuakültür tarafı etkilenmeden ayakta kalır.

---

## 2. Ayrılabilirlik yasaları (S-*)

- **S-1 Tek yönlü bağımlılık.** Kas çekirdeği bilir; çekirdek kası bilmez. Ne import,
  ne sabit yol, ne isim. Bugün ihlal ediliyor (yukarıdaki tablo).
- **S-2 Çapraz-kas bağımlılık yasak.** `packs/legal/**` hiçbir zaman `packs/aquaculture/**`
  referansı taşımaz. Ortak ihtiyaç çekirdeğe **yükselir**, yan yana kopyalanmaz.
- **S-3 Provenance temizliği.** Çekirdekte müşteri adı, müşteri verisi, alan fikstürü,
  alan sözlüğü bulunmaz. Her paket kendi lisans ve üçüncü-taraf kaydını taşır.
- **S-4 Veri asla birleşmez.** Alan başına ayrı çalışan örnek, ayrı defter kökü, ayrı
  kimlik bilgisi. Hukukta bu gizlilik duvarıdır; ticari olarak da alıcıya devredilen
  veri kümesinin sınırıdır.
- **S-5 Sürümlü Core API.** Kas yalnız yayımlanmış yüzeye bağlanır: kernel CLI, adapter
  stdin/stdout sözleşmesi, `aria/agent-request|response/v1` zarfı, pack manifesti.
  İç modüle bağlanan bir paket satılamaz hale gelir, çünkü alıcı çekirdeğin iç
  değişikliklerine esir olur.
- **S-6 Her paket kendi korpusuyla satılır.** Alıcı, aldığı şeyin çalıştığını bizden
  bağımsız ispatlayabilmeli: fikstür arşivi, altın küme, eşik değerleri paketin içinde.
- **S-7 Marka ayrımı.** Ürün adı çekirdek adı değildir. LegalTech ürünü kendi adıyla
  satılır; "ARIA" çekirdeğin adı olarak bizde kalır.
- **S-8 Tek-sınır commit kuralı.** Bir commit yalnız bir varlığın sınırına dokunur.
  Bu, geçmişi sonradan temiz bölünebilir kılan **tek** disiplindir; `GS-5` ile denetlenir.

---

## 3. Satış senaryoları (T-*) ve önkoşulları

| # | Senaryo | Alıcı ne alır | Çekirdeğe ne olur | Mimari önkoşul | Bugün mümkün mü |
|---|---|---|---|---|---|
| T-A | SaaS abonelik | kullanım hakkı | bizde kalır | S-4 örnek izolasyonu | Evet |
| T-B | Kurulum lisansı (on-prem) | imaj + lisans | bizde kalır, sürümlü | S-5 + uyum matrisi | Kısmen (S-5 yok) |
| T-C | Hukuk ürününün varlık satışı | `packs/legal/**` + ürün yüzeyi + çekirdek **kullanım lisansı** | bizde kalır | S-1, S-2, S-5, escrow | **Hayır** |
| T-D | Hukuk şirketinin bölünmesi | yukarıdakiler + çekirdeğin lisanslı kopyası | bizde de kalır (çift kullanım) | S-1..S-8 tamamı, temiz geçmiş | **Hayır** |
| T-E | Çekirdeğin kendisinin lisanslanması | ARIA Core | biz kas tarafında kalırız | aynı yasalar tersten | Hayır |

`T-C` ve `T-D`'yi bugün engelleyen tek şey teknik: çekirdek akuakültür adları taşıyor,
kas yeri çekirdeğe gömülü, bellek ayrılmamış, API yayımlanmamış.

### 3.1 En az fark edilen risk: hafıza kirlenmesi

Bellek isim-alanının olmaması yalnız bir gizlilik sorunu değil, doğrudan bir
**satılabilirlik** sorunudur. Dava verisinden türeyen bir inanç çekirdeğin genel öğrenme
defterine yazılırsa, çekirdek müvekkil-gizli malzeme taşımaya başlar. O andan sonra
çekirdek üçüncü tarafa lisanslanamaz, akuakültür müşterisine kurulamaz ve bir denetimde
ayrıştırılamaz. Bu yüzden isim-alanı kapısı `T-B`'den itibaren her senaryonun önkoşuludur
ve sözleşmeyle değil, reddeden bir kapıyla sağlanmalıdır.

---

## 4. Depo ve paket düzeni — aşamalar

- **Aşama 0 (bugün).** Tek depo: `aria-kernel/`, `packs/<id>/`, `ui/`, `docs/product/`.
  Sınırlar belge düzeyinde; kapılar henüz yok.
- **Aşama 1.** Akuakültür bilgisi çekirdekten `packs/aquaculture/**` altına taşınır.
  Çekirdekte alan sözlüğü sıfırlanır. `GS-2` yeşile döner.
- **Aşama 2.** Her paket kendi `pack.json` sürümünü, `LICENSE`, `CHANGELOG`, fikstür
  korpusunu ve `core_api_version` beyanını taşır. Depo hâlâ tek; sınır sözleşmeli ve
  test edilir. `GS-1`, `GS-3`, `GS-4`, `GS-6` yeşile döner.
- **Aşama 3 (satış tetiklendiğinde).** Paket `git filter-repo` ya da `git subtree split`
  ile kendi deposuna çıkarılır. `S-8` sayesinde çıkan geçmiş temizdir: hiçbir commit iki
  alanı birden değiştirmemiştir, dolayısıyla alıcıya giden tarihte başka bir müşterinin
  ya da başka bir alanın izi bulunmaz.

Monorepo'dan erken çıkmak gerekmiyor. Gereken şey, **çıkışın her an mümkün kalması**.

---

## 5. Makine-denetlenebilir kapılar (GS-*)

Yasalar ancak testi varsa yasadır. Bunların hepsi bugünkü invariant kalıbıyla yazılabilir.

| ID | Kapı | Ölçüt |
|---|---|---|
| GS-1 | Çapraz-kas temizliği | `packs/<a>/**` içinde `<b>` alan sözlüğü geçen satır sayısı sıfır |
| GS-2 | Çekirdek alan temizliği | `aria-kernel/**` içinde alan sözlüğü (servis adları, `matter`, `dava`, `tank`) sıfır |
| GS-3 | Uyum beyanı | Her `pack.json` bir `core_api_version` beyan eder ve o sürüm yayımlanmış yüzeyde vardır |
| GS-4 | API sınırı | Paket kodu yalnız yayımlanmış Core sembollerini/CLI'yı kullanır; iç modül importu reddedilir |
| GS-5 | Tek-sınır commit | Bir commit'in dokunduğu üst-sınır sayısı bir; ihlal için açık gerekçe şart |
| GS-6 | Korpus kendi içinde | Paketin fikstürleri kendi dizininde; dışarı referans vermez |
| GS-7 | Hafıza sınırı | Kas isim-alanı dışına yazma reddedilir; çekirdek defterinde alan verisi bulunmaz |
| GS-8 | Lisans envanteri | Her paket kendi üçüncü-taraf envanterini taşır; çekirdeğinkiyle karışmaz |

`GS-5` ve `GS-7` en yüksek değerli olanlar: birincisi geçmişi, ikincisi çekirdeğin
lisanslanabilirliğini korur.

---

## 6. Lisans ve IP taslağı

- **Çekirdek:** proprietary. Müşteriye kurulum lisansı; varlık satışında **kullanım
  lisansı + kaynak kod escrow** maddesi (alıcı bizim ayakta kalmamıza bağımlı olmasın).
- **Kas:** ayrı lisans, ayrı fiyat, ayrı SLA. Bir müşteri yalnız aldığı kası çalıştırır.
- **Model sağlayıcıları:** kasın model bağımlılığı manifestte açıkça yazılır; alıcı kendi
  sağlayıcı anahtarını takar. Çekirdek sağlayıcı-bağımsız kalır.
- **Provenance:** ARIA'nın kendi hash-zincirli defteri, "bu paket neyi ne zaman üretti"
  sorusunun kanıtıdır. Bu, satışta olağandışı bir avantajdır ve korunmalıdır.

---

## 7. Sıradaki adım

Bu taslak kabul edilirse sıra şu: `GS-2` ve `GS-7` için ölçüm yaz (bugünkü ihlal sayısını
sabitle), sonra Aşama 1'i o ölçümü sıfıra indirerek yürüt. Ölçüm önce gelir; ancak o zaman
"çekirdek temizlendi" cümlesi kanıtlanabilir olur.
