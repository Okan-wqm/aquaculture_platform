# SCADA Uçtan Uca Yeniden Yapılandırma Planı

- **Tarih:** 2026-10-19
- **Sahip:** @Okan-wqm
- **Kanıt raporu:** [`docs/reviews/claude/2026-10-19-scada-e2e-audit.md`](../../reviews/claude/2026-10-19-scada-e2e-audit.md)
- **Bulgu kaydı:** `docs/reviews/_registry/findings.jsonl` (91 bulgu, durum `OPEN`, her biri bu plandaki fazının son tarihiyle)

## 0. Özet

Bugün bir edge cihazı, bir otomasyon programı ve bir SCADA paketi birleştirilip sahada çalışan bir prosese dönüştürülemiyor. İnceleme 258 ham bulgu çıkardı. Bunlar 91 tekil bulguya indirildi: 18 CRITICAL, 42 HIGH, 24 MEDIUM, 7 LOW. Doğrulayıcılar hiçbir ham bulguyu çürütemedi.

Zincir birbirinden bağımsız birçok noktada kopuk. Her biri tek başına akışı durduruyor:

1. **Program onaylanamıyor ve ST kodu cihaza hiç gitmiyor** ([SENSOR-CRITICAL-269](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-269), [SENSOR-CRITICAL-270](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-270)).
2. **Cihaz her deploy komutunu reddediyor.** Bulut, cihazın beklediği imzalı ve ikinci kişi onaylı komutu üretemiyor ([SENSOR-CRITICAL-276](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-276), [INFRA-CRITICAL-238](../../reviews/claude/2026-10-19-scada-e2e-audit.md#infra-critical-238), [SENSOR-CRITICAL-277](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-277)).
3. **Cihaz cevapları bulutta eşleşmiyor.** Ekran ise mesaj broker'a gider gitmez "başarılı" diyor ([SENSOR-CRITICAL-271](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-271), [SENSOR-HIGH-278](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-278)).
4. **Canlı değer de kontrol yazması da hiçbir yöne akmıyor.** Tag kimliği her katmanda farklı ([SENSOR-CRITICAL-285](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-285), [SENSOR-CRITICAL-286](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-286), [SENSOR-CRITICAL-287](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-287), [EDGE-CRITICAL-078](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-critical-078)).
5. **Edge, programın yazdığını donanıma hiç uygulamıyor.** Tag kataloğu her yeniden başlatmada boşalıyor ([EDGE-CRITICAL-072](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-critical-072), [EDGE-CRITICAL-079](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-critical-079)).
6. **Çalışma ekranları builder'da çizileni göstermiyor.** Bulut operatör ekranı "?" kutular çiziyor; borular hiçbir runtime'da yok; paletin %56'sı deploy'u bozuyor ([SENSOR-CRITICAL-290](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-290), [SENSOR-CRITICAL-291](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-291), [SENSOR-CRITICAL-292](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-292)).
7. **Simülasyon kullanıcının programını hiç çalıştırmıyor** ([SENSOR-CRITICAL-324](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-324)).
8. **Editörün temel mekanikleri bozuk.** Geri al/yinele hiç çalışmıyor; yan yana iki ekipmanın portları matematiksel olarak aynı hizaya gelemiyor ([SENSOR-HIGH-301](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-301), [SENSOR-HIGH-304](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-304)).
9. **Testler yeşil ama gerçek bağlantı noktalarını hiç geçmiyor** ([SENSOR-HIGH-337](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-337)).

Bu yüzden plan "tek tek yama" değil, mimari bir yeniden yapılandırma:

- Önce gerçekliği ölçen uçtan uca test kapısı kurulur.
- Sonra sırayla şunlar yapılır: veri ve kontrol omurgası; tek doküman şeması ve tek çizici; tek ST motoru; yeni editör; etkileşimli simülasyon; operasyon özellikleri; kullanım kılavuzu.
- Her faz kendi uçtan uca testleri yeşil olmadan kapanmaz.

## 1. Kabul senaryosu: "Altın yol"

Plan bitince aşağıdaki senaryo, CI'da gerçek bileşenlerle (mock'suz) baştan sona otomatik çalışmalı. Bileşenler: Postgres, NATS, Mosquitto, sensor-service, web arayüzü, release derlemesiyle edge ajanı ve Modbus simülatörü. Senaryodaki her adım ayrı bir test adımıdır.

**Örnek tesis:** bir RAS tankı.

- Seviye sensörü (analog giriş).
- VFD'li bir pompa P-01: çalış komutu, çalışıyor geri bildirimi, frekans ayar noktası ve frekans geri bildirimi.
- Bir giriş vanası V-01: aç/kapa komutu ve konum geri bildirimi.
- LL seviye alarmı.
- Program: seviye yükselince pompayı çalıştırır, düşünce durdurur.

1. **Cihazsız tasarım.** Kullanıcı hiç edge cihazı yokken pompa ve vana ekipman tiplerinden örnekler ve taslak tag'ler oluşturur.
2. **Program.** Seviye kontrol programını ST ile yazar. Program gerçek derleyiciyle derlenir ve hatalar editörde gösterilir.
3. **Ekran.** Tank, pompa ve vanayı yerleştirir; portları düz borularla bağlar; ekipmanı taşıyınca borular takip eder.
4. **Bağlama.** Ekipman ve widget'lar taslak tag'lere, program değişkenleri aynı tag'lere bağlanır.
5. **Etkileşimli simülasyon.** Kullanıcı vanaya tıklayıp kapatır ve tesis modelinde seviye değişir. Program, cihazda çalışacak derlenmiş dosyanın aynısıyla (içerik özeti eşit) çalışır ve pompayı başlatır. Pompanın durumu ve borudaki akış ekranda değişir. VFD frekansı düşürülünce debi azalır. LL alarmı tetiklenir ve onaylanır.
6. **Devreye alma.** Edge cihazı eklenir ve çevrimiçi olur. Taslak tag'ler, program ve ekran değişmeden, cihaz kanallarına eşlenir.
7. **Deploy.** Paket ve program tek bir imzalı paket olarak gönderilir. Cihaz imzayı ve politikayı doğrular, uygular ve onay (ack) döner. Arayüz "uygulandı" bilgisini yalnızca bu onaydan sonra gösterir.
8. **Canlı çalışma.** Modbus simülatöründeki seviye değeri hem edge HMI'da (internet yokken de) hem bulut operatör ekranında aynı çizimle görünür. Operatör pompaya "durdur" komutu verir, komut cihazdan geçip simülatöre yazılır ve geri bildirim ekrana döner. Program çıkışları gerçekten Modbus'a yazılır.
9. **Alarm.** LL alarmı iki runtime'da da aynı anlamla ve aynı anda tetiklenir; onaylama iki tarafta da görünür.

## 2. Mimari kararlar

Her karar, CLAUDE.md'deki çözüm hiyerarşisinde mümkün olan en üst seviyeyi hedefler: imkânsız kıl, otomatik kıl, tespit edilebilir kıl.

| #   | Karar                                                                                                                                                                                                                                                                                                                                                      | Seviye | Kapattığı ana bulgular                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K1  | **Tek tag kimliği.** Builder, bulut runtime, alarm motorları ve edge yalnızca `TagRef` (`libs/sensor-contracts/src/tag-ref.ts`) kullanır. `tag`, `tagName` ve `tagRef` gibi paralel anahtarlar kaldırılır; tipler markalı (branded) olur.                                                                                                                  | 1      | [SENSOR-CRITICAL-285](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-285), [EDGE-CRITICAL-078](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-critical-078), [SENSOR-HIGH-288](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-288), [SENSOR-HIGH-332](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-332)                                                                                                    |
| K2  | **Tek doküman şeması (v3), `libs/sensor-contracts` içinde sürümlü.** Editör, bulut ve edge aynı şemayı okur. Rust tarafı aynı JSON şemasından doğrulanır. v2 → v3 dönüştürücüsü mevcut paketleri otomatik taşır.                                                                                                                                           | 1      | [SENSOR-CRITICAL-291](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-291), [SENSOR-CRITICAL-292](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-292), [SENSOR-MEDIUM-296](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-296), [SENSOR-HIGH-299](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-299), [SENSOR-MEDIUM-282](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-282) |
| K3  | **Tek çizici paketi.** Builder canvas'ı, önizleme, simülasyon, bulut operatör ekranı, açılır pencereler ve edge HMI aynı paketi kullanır. Edge HMI bu paketi binary içinde, internetsiz taşır. İkinci bir çizici yazılmasını bir bağımlılık kuralı engeller.                                                                                               | 1 + 3  | [SENSOR-CRITICAL-290](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-290), [SENSOR-CRITICAL-291](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-291), [SENSOR-MEDIUM-293](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-293), [EDGE-HIGH-082](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-082)                                                                                                |
| K4  | **Tek ST motoru.** Edge'in Rust derleyicisi ve VM'i WASM'a derlenir. Tarayıcı simülasyonu ve bulut derlemesi aynı motoru kullanır. Tarayıcıdaki ikinci yorumlayıcı ve sahte derleyici silinir. Simülasyonda çalışan ile cihaza giden dosyanın içerik özeti eşit olmak zorundadır.                                                                          | 1      | [SENSOR-CRITICAL-270](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-270), [SENSOR-CRITICAL-324](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-324), [SENSOR-HIGH-326](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-326), [SENSOR-HIGH-327](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-327)                                                                                                |
| K5  | **Komut tabanlı editör.** Her değişiklik dokümana uygulanan, geri alınabilir bir komuttur. React Flow ya da canvas kütüphanesinin iç durumu hiçbir zaman doğruluk kaynağı olmaz.                                                                                                                                                                           | 1      | [SENSOR-HIGH-301](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-301), [SENSOR-HIGH-302](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-302), [SENSOR-HIGH-303](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-303)                                                                                                                                                                                                       |
| K6  | **Bağlantı topolojisi ve geometri tek kaynak.** Boru `{kaynak düğüm+port, hedef düğüm+port veya T-bağlantı}` olarak saklanır; çizgi bundan türetilir. Her sembol portlarını kendi koordinatında, yönüyle ve ızgara birimine oturtulmuş olarak bildirir. Döndürme ve aynalama portları da dönüştürür. Yakalama önceliği: port, T-bağlantı, kılavuz, ızgara. | 1      | [SENSOR-HIGH-304](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-304), [SENSOR-HIGH-305](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-305), [SENSOR-HIGH-306](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-306), [SENSOR-LOW-308](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-low-308)                                                                                                                  |
| K7  | **Ekipman tipleri (UDT).** Pompa, vana, blower, VFD, tank ve yemlik gibi tipler; üyeleri komut, geri bildirim, arıza, mod, ayar noktası ve ölçülen değer. Komut ile geri bildirimden türetilen bir durum makinesi (çalışıyor, başlıyor, arıza, uyuşmazlık), kontrol paneli (faceplate) ve tipe tanımlı alarmlar.                                           | 2      | [SENSOR-HIGH-295](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-295), [SENSOR-HIGH-329](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-329), [SENSOR-MEDIUM-307](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-307)                                                                                                                                                                                                   |
| K8  | **Deploy durumu yalnızca cihaz onayından türetilir.** Eşleştirme `commandId` ile yapılır. Revizyonlar değişmezdir ve içerik özetiyle tanımlanır. Runtime deploy edilen revizyonu çalıştırır, taslağı değil.                                                                                                                                                | 1      | [SENSOR-CRITICAL-271](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-271), [SENSOR-HIGH-278](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-278), [SENSOR-HIGH-279](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-279), [EDGE-HIGH-077](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-077)                                                                                                            |
| K9  | **Uçtan uca imzalı komut.** Bulut imzalayıcısı bağlanır. İmza, iç içe alanları olan deploy içeriğinin değil, bu içeriğin özetinin kanonik formu üzerinden atılır. Doğrulama anahtarları provisioning ile dağıtılır. İkinci kişi onayı politikası Karar D1'e göre uygulanır.                                                                                | 1      | [SENSOR-CRITICAL-276](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-276), [INFRA-CRITICAL-238](../../reviews/claude/2026-10-19-scada-e2e-audit.md#infra-critical-238), [SENSOR-CRITICAL-277](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-277), [SENSOR-HIGH-272](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-272)                                                                                          |
| K10 | **Gerçek bağlantı noktalarını geçen testler.** Uçtan uca test düzeneği CI'da zorunlu kapıdır. Kontrat fixture'ları elle yazılmaz; gerçek serileştiricinin çıktısından üretilir.                                                                                                                                                                            | 3      | [SENSOR-HIGH-337](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-337)                                                                                                                                                                                                                                                                                                                                                                                     |

## 3. Kararlar

**2026-10-20: D1–D6'nın tamamı, aşağıdaki "Öneri" sütunundaki seçenekle kabul edildi** (@Okan-wqm). Tablo karar gerekçesini ve seçenekleri korur. D1, ADR-018'in değişmesini gerektirir; taslak ve arbiter kararı F0'da üretilir ve F1'in 5. işi bunlara bağlıdır.

Ekip kuralları (aynı gün, kullanıcı talimatı), her faz için bağlayıcıdır:

1. **Tek doğruluk kaynağı, tekrar yok.** Var olan yapının yanına benzeri ya da paraleli eklenmez. Mevcut yapı yetersizse tek, daha iyi bir yapı kurulur; tüm çağıranlar ona taşınır ve eskisi aynı değişiklikte silinir.
2. **Ajanlar birbirleriyle konuşur.** Her ajanın bir gelen kutusu ve giden kutusu vardır; soru, itiraz ve devir mesajları kayıt altında taşınır.
3. **Kalite ve kanıt takıntısı.** Kanıtsız iddia kabul edilmez: çalıştırılan komut, çıkış kodu ve çıktı alıntısı ya da `dosya:satır` gerekir. Doğrulayıcılar komutları kendileri yeniden çalıştırır. Kanıt eksikse iş makine tarafından reddedilir.

| #   | Konu                                                                                                                                                                                                     | Seçenekler                                                                                                         | Öneri                                                                                                                                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **İkinci kişi onayı** ([SENSOR-CRITICAL-276](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-276)). Edge, program ve paket deploy'unda iki kişinin onayını zorunlu tutuyor (ADR-018). | (a) Zorunlu kalsın; uygulamaya ikinci onaylayıcı akışı eklensin. (b) Riske göre tenant veya saha bazında politika. | Firmware, safe-state ve force komutlarında (a). SCADA paketi ve program deploy'unda saha politikası, varsayılanı "onay gerekli". Bunun için ADR-018 güncellemesi ve architectural-arbiter onayı gerekir.                               |
| D2  | **Canvas teknolojisi** ([SENSOR-HIGH-306](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-306))                                                                                           | Kendi SVG sahne grafiği; JointJS core (MPL-2.0); GoJS (ticari, $3,995'ten başlıyor); React Flow'da kalmak          | **Kendi SVG sahne grafiği.** Tek çizici kararı (K3), ISA-101 tema token'ları ve edge HMI'da internetsiz çalışma ile en uyumlu seçenek. JointJS ikinci seçenek. React Flow düğüm-ok diyagramı içindir; port ve boru topolojisine uymaz. |
| D3  | **Edge HMI dağıtımı** ([EDGE-HIGH-082](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-082))                                                                                                | CDN'den yükleme; binary'ye gömme                                                                                   | **Binary'ye gömme.** Sahada internet garanti değil.                                                                                                                                                                                    |
| D4  | **Eski editörler** ([SENSOR-HIGH-318](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-318))                                                                                               | Builder, Unified Editor, Process Editor ve eski görüntüleyici yan yana kalsın; tek editör olsun                    | **Tek editör.** Unified Editor'ün ST ve PLC modları otomasyon sayfasına, P&ID çizimi yeni editöre katılır. Eski sayfalar, taşıma testleri geçince silinir.                                                                             |
| D5  | **Edge JSON script motoru** ([EDGE-HIGH-069](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-069))                                                                                          | Bakımına devam edilsin; bytecode VM lehine kaldırılsın                                                             | **Kaldırılsın.** İki program modeli, iki ayrı hata kaynağı demek.                                                                                                                                                                      |
| D6  | **Mevcut paketlerin taşınması**                                                                                                                                                                          | Otomatik v2 → v3 dönüştürücü; elle yeniden çizim                                                                   | **Otomatik dönüştürücü**, kendi test setiyle. Bugün sahada çalışan paket olmadığı için risk düşük.                                                                                                                                     |

## 4. Fazlar

Her fazın sonunda o fazın uçtan uca testleri CI'da yeşil olmak zorunda. Kırmızı testle commit atılmaz (CLAUDE.md). Her düzeltme commit'i kapattığı bulguyu `Closes: docs/reviews/claude/2026-10-19-scada-e2e-audit.md#<ID>` satırıyla bildirir.

### Faz 0: Gerçeklik kapısı (son tarih 2026-11-02)

**Kapanan bulgu:** [SENSOR-HIGH-337](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-337)

1. **Uçtan uca test düzeneği.** Docker compose test profili: Postgres, NATS, Mosquitto, sensor-service, gateway, web (shell ve sensor-module), release özellikleriyle derlenmiş edge ajanı ve Modbus TCP simülatörü. CI'da GPIO yerine Modbus kullanılır.
2. **Altın yol testi önce yazılır.** Bölüm 1'deki dokuz adım Playwright `test.step` olarak yazılır ve beklendiği gibi kırmızı olur. Hangi adımda kırıldığı rapora işlenir.
3. **Kontrat fixture'ları gerçek serileştiricilerden üretilir.** TS yayın dönüşümünün çıktısı Rust tarafında deserialize edilir; Rust `CommandResponse` çıktısı TS dinleyicisinde işlenir. İki yön de CI testi olur.
4. **Yeni test hedefi CI'dan erişilebilir olur** (`tests/invariants/test-target-ci-reachability.spec.ts`).

**Çıkış kapısı:** Düzenek CI'da çalışıyor. Altın yol testi, kırıldığı adımı raporlayarak kırmızı.

### Faz 1: Veri ve kontrol omurgası (son tarih 2026-11-30)

**Kapanan bulgular:** [SENSOR-CRITICAL-271](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-271), [EDGE-CRITICAL-072](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-critical-072), [SENSOR-CRITICAL-276](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-276), [INFRA-CRITICAL-238](../../reviews/claude/2026-10-19-scada-e2e-audit.md#infra-critical-238), [SENSOR-CRITICAL-277](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-277), [SENSOR-CRITICAL-285](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-285), [SENSOR-CRITICAL-286](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-286), [SENSOR-CRITICAL-287](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-287), [EDGE-CRITICAL-079](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-critical-079), [EDGE-CRITICAL-081](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-critical-081), [EDGE-HIGH-068](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-068), [SENSOR-HIGH-272](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-272), [EDGE-HIGH-073](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-073), [SENSOR-HIGH-278](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-278), [EDGE-HIGH-077](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-077), [SENSOR-HIGH-288](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-288), [EDGE-HIGH-080](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-080), [SENSOR-HIGH-298](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-298), [EDGE-MEDIUM-074](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-medium-074), [EDGE-MEDIUM-075](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-medium-075), [EDGE-MEDIUM-076](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-medium-076), [SENSOR-MEDIUM-282](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-282), [SENSOR-MEDIUM-283](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-283), [SENSOR-MEDIUM-284](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-284), [EDGE-MEDIUM-083](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-medium-083), [EDGE-LOW-084](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-low-084)

1. **TagRef her yerde (K1).** Builder yalnızca `tagRef` yazar; v2 dönüştürücü eski anahtarları çevirir. Fan-out ve tüm aboneler TagRef kullanır. Edge I/O değerleri TagRef olarak bulut canlı veri düzlemine girer ([SENSOR-CRITICAL-285](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-285), [SENSOR-CRITICAL-286](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-286), [SENSOR-HIGH-288](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-288)).
2. **Edge tag kataloğu ve sürücü yaşam döngüsü.** Ajan açılışta `io_config.yaml` dosyasını okur. Buluttaki `DeviceIoConfig` kayıtları GPIO, Modbus ve I2C sürücülerini oluşturur ya da günceller. Heartbeat uygulanan konfigürasyonun özetini taşır; uyuşmazlıkta bulut konfigürasyonu yeniden gönderir ([EDGE-CRITICAL-079](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-critical-079), [EDGE-HIGH-073](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-073)).
3. **Edge çıkış katmanı.** Tek bir yazma yolu kurulur: TagRef'ten sürücüye. VM çıkışları bu yoldan uygulanır ve geri okunur; "komut verildi" ile "doğrulandı" kalitesi ayrılır. Olay tabanlı görevler giriş değişince uyanır ([EDGE-CRITICAL-072](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-critical-072), [EDGE-MEDIUM-074](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-medium-074), [EDGE-MEDIUM-075](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-medium-075), [EDGE-MEDIUM-076](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-medium-076)).
4. **Kontrol yazmaları uçtan uca.** Akış: tarayıcı, gateway `TAG_WRITE`, tipli değerle `set_output`, edge yürütür, ack, arayüz. Edge HMI'ın onay, PIN ve alarm onayı protokolü düzeltilir; Modbus yazması doğru slave'e gider ([SENSOR-CRITICAL-287](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-287), [EDGE-HIGH-080](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-080), [EDGE-CRITICAL-081](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-critical-081)).
5. **İmzalı komut ve anahtar dağıtımı (K9).** İmzalayıcı bağlanır. İmza anahtarı gizli bilgi hattına, runbook'a ve compose dosyasına eklenir ve bir varlık kontrolüyle korunur. Provisioning doğrulama anahtarını ve lisansı dağıtır. Kurulum konfigürasyonu, ajanın doğruladığı şemadan üretilir. Karar D1 uygulanır ([SENSOR-CRITICAL-276](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-276), [INFRA-CRITICAL-238](../../reviews/claude/2026-10-19-scada-e2e-audit.md#infra-critical-238), [SENSOR-CRITICAL-277](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-277), [SENSOR-HIGH-272](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-272)).
6. **Ack ve durum doğruluğu (K8).**
   - Eşleştirme `commandId` ile yapılır.
   - Her deploy türü için zaman aşımlı bir durum makinesi kurulur.
   - Edge revizyonları içerik özetiyle saklanır; cloud sürüm numarası birincil anahtar olmaz.
   - Paket boyutu kontrol edilir ve gerekirse parçalanır.
   - Yeniden deneme kilitlenmesi kaldırılır.

   Kapanan bulgular: [SENSOR-CRITICAL-271](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-271), [SENSOR-HIGH-278](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-278), [EDGE-HIGH-077](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-077), [SENSOR-MEDIUM-283](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-283), [SENSOR-MEDIUM-284](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-284).

7. **Sayı kontratı.** Konum, gecikme ve trend alanları şemada tamsayı olarak tanımlanır; yayın sınırında reddedilir ([SENSOR-MEDIUM-282](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-282)).
8. **Acil stop güvenliği.** Süre birimi tek tanımlı olur. E-STOP tüm tanımlı çıkışları güvenli duruma alır. PIN sunucuda doğrulanır ([SENSOR-HIGH-298](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-298)).
9. **Edge HMI ve donanım.** GPIO'lu release varyantı derlenir; simüle GPIO release sürümünde sağlık durumunda görünür. HMI mesaj işleme düzeltilir. Yerel ağ güvenliği HMI'ı kilitlemez ([EDGE-HIGH-068](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-068), [EDGE-MEDIUM-083](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-medium-083), [EDGE-LOW-084](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-low-084)).

**Çıkış kapısı (E2E):**

- Modbus simülatöründe değişen bir değer TagRef ile bulut canlı veri düzleminde ve edge HMI WebSocket'inde görünür.
- Buluttan yazılan bir değer simülatöre ulaşır ve ack ile onaylanır.
- Asgari bir paketin imzalı deploy'u cihaz onayıyla "uygulandı" durumuna geçer.
- Cihaz yeniden başlatılınca tag kataloğu kaybolmaz.

### Faz 2: Tek doküman şeması ve tek çizici (son tarih 2026-12-21)

**Kapanan bulgular:** [EDGE-CRITICAL-078](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-critical-078), [SENSOR-CRITICAL-290](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-290), [SENSOR-CRITICAL-291](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-291), [SENSOR-CRITICAL-292](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-292), [EDGE-HIGH-082](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-082), [SENSOR-HIGH-299](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-299), [SENSOR-MEDIUM-293](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-293), [SENSOR-MEDIUM-296](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-296), [SENSOR-MEDIUM-297](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-297)

1. **Doküman şeması v3 (K2).** İçerik: ekranlar; portlu sembol örnekleri; bağlantı topolojisi; TagRef bağlamaları; ekipman örnekleri; runtime formatında olay ve animasyon tanımları; arka plan, katman sırası, görünürlük ve dönüşüm. JSON şeması, Rust doğrulaması ve v2 → v3 dönüştürücüsü ayrı testlerle gelir.
2. **Çizici paketi (K3).** Tüm sembol ve widget tipleri için tek SVG uygulaması. Düzenleme, önizleme, simülasyon ve canlı modlarını destekler; ISA-101 gri tema ve görünüm teması token tabanlıdır.
3. **Bulut operatör ekranı çizici paketine geçer.** Boş kayıt tablosu ve 40×40 ızgara kaldırılır ([SENSOR-CRITICAL-290](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-290)).
4. **Edge HMI çizici paketini binary içinde, internetsiz taşır.** CDN bağımlılığı kalkar. Sabit 12×8 ızgara yerine doküman geometrisi kullanılır ([EDGE-CRITICAL-078](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-critical-078), [EDGE-HIGH-082](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-082), [SENSOR-CRITICAL-291](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-291), [SENSOR-MEDIUM-293](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-293)).
5. **Palet çizici kataloğundan türetilir.** Çizilebilen her öğe deploy edilebilir; bunu kapsamlılık testi garanti eder ([SENSOR-CRITICAL-292](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-292), [SENSOR-MEDIUM-297](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-297)).
6. **Ayar paneli ile çizici aynı tipli config'i paylaşır.** Anahtar kayması derleme hatası olur. Olay, animasyon ve yetkiler runtime'da çalışır ([SENSOR-MEDIUM-296](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-296), [SENSOR-HIGH-299](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-299)).

**Çıkış kapısı (E2E):**

- 20 referans ekran editör önizlemesinde, bulut operatör ekranında ve edge HMI'da piksel farkı en fazla %0,1 olacak şekilde aynı çizilir.
- Paletteki her öğe deploy edilir ve iki runtime'da çizilir.
- Edge HMI internet bağlantısı kesikken açılır.

### Faz 3: Program yolu ve tek ST motoru (son tarih 2027-01-18)

**Kapanan bulgular:** [SENSOR-CRITICAL-269](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-269), [SENSOR-CRITICAL-270](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-270), [SENSOR-CRITICAL-280](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-280), [SENSOR-CRITICAL-324](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-324), [EDGE-HIGH-067](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-067), [EDGE-HIGH-069](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-069), [EDGE-HIGH-070](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-070), [EDGE-HIGH-071](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-071), [SENSOR-HIGH-274](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-274), [SENSOR-HIGH-275](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-275), [SENSOR-HIGH-326](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-326), [SENSOR-HIGH-327](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-327), [SENSOR-MEDIUM-273](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-273)

1. **Edge derleyicisinin eksikleri tamamlanır.** Karşılaştırma operatörleri, MOD ve XOR; IEC blokları (TON, TOF, TP, R_TRIG, F_TRIG, CTU, CTD); TIME ve STRING; diziler; başlangıç değerleri. Bir IEC 61131-3 uyum test seti eklenir ([EDGE-HIGH-070](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-070), [EDGE-HIGH-071](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-071)).
2. **Derleyici ve VM WASM'a derlenir (K4).** Tarayıcı simülasyonu ve bulut derlemesi bu motoru kullanır. `simulation/st-interpreter.ts` ve sahte `CompilerService` silinir ([SENSOR-CRITICAL-270](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-270), [SENSOR-CRITICAL-324](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-324), [SENSOR-HIGH-326](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-326), [SENSOR-HIGH-327](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-327)).
3. **ST programları için yaşam döngüsü.** Doğrulama derlemeyle yapılır, SFC adımı şartı kalkar. Onay akışı Karar D1'e göre işler ([SENSOR-CRITICAL-269](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-269)).
4. **ADR-017'ye uygun bytecode deploy.** İmzalı, ack'li, lisans kontrollü; tarama süresi arayüzde lisans sınırıyla gösterilir. JSON script motoru kaldırılır (Karar D5) ([EDGE-HIGH-067](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-067), [EDGE-HIGH-069](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-069), [SENSOR-MEDIUM-273](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-273)).
5. **Program değişkeni ile TagRef bağlaması cihaz kontrolüyle yapılır.** Modbus ve I2C çıkışları sürülebilir. Kanal değişikliği bağlamayı koparmaz ([SENSOR-HIGH-274](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-274), [SENSOR-HIGH-275](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-275)).
6. **Paket ile program tek imzalı pakette gönderilir.** Bağlama doğrulaması, builder'ın yazdığı gerçek şekli okur ([SENSOR-CRITICAL-280](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-280)).

**Çıkış kapısı (E2E):** Altın yolun 2., 5. (program kısmı) ve 7. adımları yeşil. Simülasyonda çalışan dosya ile cihaza giden dosyanın içerik özeti eşit. Uyum test seti tarayıcıda ve edge'de aynı sonuçları verir.

### Faz 4: Yeni SCADA editörü (son tarih 2027-03-01)

**Kapanan bulgular:** [SENSOR-HIGH-289](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-289), [SENSOR-HIGH-294](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-294), [SENSOR-HIGH-295](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-295), [SENSOR-HIGH-300](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-300), [SENSOR-HIGH-301](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-301), [SENSOR-HIGH-302](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-302), [SENSOR-HIGH-303](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-303), [SENSOR-HIGH-304](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-304), [SENSOR-HIGH-305](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-305), [SENSOR-HIGH-306](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-306), [SENSOR-HIGH-311](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-311), [SENSOR-HIGH-312](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-312), [SENSOR-HIGH-313](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-313), [SENSOR-HIGH-314](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-314), [SENSOR-HIGH-315](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-315), [SENSOR-HIGH-318](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-318), [SENSOR-MEDIUM-307](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-307), [SENSOR-MEDIUM-310](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-310), [SENSOR-MEDIUM-316](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-316), [SENSOR-MEDIUM-317](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-317), [SENSOR-MEDIUM-320](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-320), [SENSOR-LOW-308](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-low-308), [SENSOR-LOW-309](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-low-309), [SENSOR-LOW-319](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-low-319), [SENSOR-LOW-321](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-low-321), [SENSOR-LOW-322](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-low-322)

0. **Envanter.** Mevcut builder'ın her özelliği (widget'lar, ayarlar, kısayollar, sağ tık menüsü, paneller) "taşınacak" ya da "bilerek çıkarılacak" olarak işaretlenir ve gerekçesiyle commit'lenir. Hiçbir özellik fark edilmeden kaybolmaz.
1. **Canvas (Karar D2) doküman v3 üzerinde, komut yığınıyla çalışır (K5).** Geri al/yinele, seçim ve hizalama tek kaynaktan yönetilir ([SENSOR-HIGH-301](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-301), [SENSOR-HIGH-302](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-302), [SENSOR-HIGH-303](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-303)).
2. **Geometri tek kaynak (K6).** Sembol portları ızgara birimine oturur. Ekipman taşınırken karşı port ile aynı doğrultuya geldiğinde yakalanır ve boru düzleşir. Kaydedilen boyut ile çizilen boyut aynıdır ([SENSOR-HIGH-304](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-304)).
3. **Döndürme ve aynalama portları birlikte dönüştürür.** Bağlı borular aynı işlemde yeniden yönlenir ve tek geri alma adımı olur ([SENSOR-HIGH-305](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-305)).
4. **Boru topolojisi.**
   - Ekipmanı takip eden dik açılı rota.
   - Sürüklenebilir segmentler ve ara noktalar.
   - T-bağlantı.
   - Boru ucunu başka porta taşıma.
   - Akışkan uyumluluğu kontrolü ve sinyal portları.
   - Akış animasyonu pompa ve vana durumundan türetilir.

   Kapanan bulgular: [SENSOR-HIGH-306](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-306), [SENSOR-MEDIUM-307](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-307), [SENSOR-LOW-308](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-low-308).

5. **Yerleşim araçları.** Katman sırası, pan ve zoom'u dikkate alan kılavuz çizgileri ve cetvel, görünür alana ekleme ([SENSOR-LOW-309](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-low-309)).
6. **Güvenli düzenleme.** Ekran silmede bağlantıların temizlenmesi, onay pencereleri, kapsamlı kısayollar ([SENSOR-MEDIUM-310](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-310)).
7. **Tag tarayıcısı.** Taslak tag'ler (cihazsız tasarım) ve devreye almada taslak tag ile cihaz kanalı eşlemesi. Arama ve sayfalama; listeler kırpılmaz ([SENSOR-HIGH-289](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-289)).
8. **Ekipman tipleri (K7).** Pompa, vana, blower, VFD, tank, filtre, yemlik ve ışık tipleri; komut/geri bildirim durum makinesi; kontrol paneli. Demo veri ve sabit dolum kaldırılır; ProcessView gerçek veriye bağlanır ([SENSOR-HIGH-294](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-294), [SENSOR-HIGH-295](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-295), [SENSOR-HIGH-300](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-300)).
9. **Paket yaşam döngüsü.**
   - Shell data router'a taşınır ve kaydedilmemiş değişiklik varken uygulama içi gezinme engellenir.
   - Yükleme hatası için ayrı ekran olur.
   - ETag ile iyimser eşzamanlılık kontrolü yapılır.
   - Her kayıt değişmez bir revizyondur.
   - Resimler base64 yerine varlık deposunda tutulur.
   - Hata mesajları sunucunun sebebini gösterir.

   Kapanan bulgular: [SENSOR-HIGH-311](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-311), [SENSOR-HIGH-312](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-312), [SENSOR-HIGH-313](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-313), [SENSOR-HIGH-314](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-314), [SENSOR-HIGH-315](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-315), [SENSOR-MEDIUM-316](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-316), [SENSOR-MEDIUM-317](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-317), [SENSOR-LOW-322](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-low-322).

10. **Tek editör (Karar D4).** Unified Editor ve Process Editor birleşir, eski paketler taşınır. Liste, dışa/içe aktarma ve şablonlar kayıpsız çalışır. İşlevsiz özellikler ya çalıştırılır ya da kaldırılır ([SENSOR-HIGH-318](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-318), [SENSOR-LOW-319](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-low-319), [SENSOR-MEDIUM-320](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-320), [SENSOR-LOW-321](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-low-321)).

**Çıkış kapısı (E2E):**

- Yan yana konan iki ekipman düz bir boruyla bağlanır.
- Bağlı semboller üzerinde 1000 rastgele taşıma, döndürme, aynalama ve boyutlandırma işleminden sonra kopuk boru ucu 0, dik açılı olmayan segment 0 olur (özellik tabanlı test).
- Silme geri alınınca borular ve tag bağlamaları geri gelir.
- Kaydedip yeniden yüklenen doküman birebir aynıdır.
- Kaydedilmemiş çalışma varken uygulama içinde başka sayfaya gidilince uyarı çıkar.

### Faz 5: Etkileşimli simülasyon ve sanal devreye alma (son tarih 2027-03-29)

**Kapanan bulgular:** [SENSOR-HIGH-325](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-325), [SENSOR-HIGH-329](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-329), [SENSOR-HIGH-331](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-331), [SENSOR-MEDIUM-323](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-323), [SENSOR-MEDIUM-328](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-328), [SENSOR-LOW-330](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-low-330)

1. **Tesis modeli.** Ekran topolojisinden ve ekipman tiplerinden otomatik üretilir:
   - tank seviyesi giren ve çıkan debinin farkıyla değişir;
   - pompa debisi frekansa ve vana açıklığına bağlıdır;
   - vana hareket süresi ve geri bildirim gecikmeleri modellenir.
2. **Kapalı döngü.** Simülasyon aynı TagRef düzlemini kullanır. Döngü şöyle kapanır:
   1. Operatör ekipmana tıklar ya da VFD frekansını değiştirir; komut gerçek yazma yolundan geçer.
   2. VM (WASM) bu girişle çalışır.
   3. VM'in çıkışları tesis modelini sürer.
   4. Tesis modeli girişleri günceller ve döngü başa döner.

   Etkileşim isteğinin karşılığı bu döngü ([SENSOR-HIGH-329](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-329)).

3. **Tarama döngüsü arayüz olaylarından bağımsızdır.** Panel kapanınca program durmaz ([SENSOR-MEDIUM-328](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-328)).
4. **Simülasyonda alarmlar ortak `alarm-core` ile değerlendirilir.** Banner yalnızca aktif alarmları gösterir ([SENSOR-HIGH-325](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-325)).
5. **Senaryolar.**
   - Kayıt ve tekrar oynatma.
   - Rampa ve basamak değişimleri.
   - Arıza enjeksiyonu: pompa arızası, geri bildirim kaybı, sensör takılması.
   - Zaman hızlandırma.
   - Doğrulama ifadeleri, örneğin "yedek blower 30 saniye içinde devreye girmeli".

   Senaryo dosyası projeyle birlikte sürümlenir ([SENSOR-LOW-330](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-low-330)).

6. **Script'ler.** Tüm runtime'larda tek sandbox API'si; CSP ile uyumlu çalışma ([SENSOR-HIGH-331](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-331)).
7. **Simülasyon izolasyonu.** Sıfırlama ve paket değişiminde durum temizlenir ([SENSOR-MEDIUM-323](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-323)).

**Çıkış kapısı (E2E):**

- "Vana kapatılır, seviye yükselir, program N saniye içinde pompayı başlatır, borudaki akış animasyonu değişir" senaryosu otomatik geçer.
- VFD frekansı düşürülünce debi ve seviye eğimi değişir.
- Senaryo dosyası her oynatmada aynı sonucu verir.

### Faz 6: Operasyon: alarm, trend, güvenlik, değişiklik yönetimi (son tarih 2027-04-19)

**Kapanan bulgular:** [SENSOR-HIGH-279](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-279), [SENSOR-HIGH-332](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-332), [EDGE-HIGH-086](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-086), [SENSOR-HIGH-334](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-334), [SENSOR-MEDIUM-281](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-281), [EDGE-MEDIUM-085](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-medium-085), [SENSOR-MEDIUM-333](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-333), [SENSOR-MEDIUM-335](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-335), [EDGE-MEDIUM-087](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-medium-087)

1. **Alarmlar tek kaynaktan (ISA-18.2).**
   - Öncelik, gecikme, ölü bant, onay ve shelving ekipman tipine tanımlıdır.
   - İki runtime aynı `alarm-core` ile aynı anlamda değerlendirir.
   - Bulut değerlendirmesi sunucuda sürekli çalışır; operatör ekranının açık olmasına bağlı değildir.
   - Bildirimler çalışır.

   Kapanan bulgular: [SENSOR-HIGH-332](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-332), [SENSOR-MEDIUM-333](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-333).

2. **Trendler.** Zaman birimi tek tanımlı olur; trendConfig iki runtime'da da uygulanır ([EDGE-HIGH-086](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-086)).
3. **Sunucuda uygulanan kontrol güvenliği.** PIN, roller ve editör yetkileri ([SENSOR-HIGH-334](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-334)).
4. **Zamanlayıcı.** Edge'de, sahanın IANA saat dilimiyle ve yaz saatini dikkate alarak çalışır ([SENSOR-MEDIUM-335](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-335), [EDGE-MEDIUM-087](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-medium-087)).
5. **Revizyonlar ve geri alma.** İki revizyon arası anlamsal fark; deploy edilen sürümün taslaktan ayrı gösterilmesi; geri alma arayüzü ([SENSOR-HIGH-279](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-279), [SENSOR-MEDIUM-281](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-281)).
6. **Kalibrasyon akışı uçtan uca çalışır** ([EDGE-MEDIUM-085](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-medium-085)).
7. **Denetim kaydı.** Mühendislik ve operatör işlemleri kullanıcı, zaman, eski ve yeni değer ve revizyonla kaydedilir.

**Çıkış kapısı (E2E):** Altın yolun 9. adımı yeşil. Bir revizyon geri alınınca cihaz önceki revizyona ack ile döner. Saat dilimli bir zamanlama, yerel saatle doğru anda tetiklenir.

### Faz 7: Kullanım kılavuzu ve kullanıcı yolculuğu (son tarih 2027-05-03)

**Kapanan bulgular:** [SENSOR-MEDIUM-336](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-336)

1. **Uygulama içi kılavuz.** Elle işaretlenen bir yardım metni değil, gerçek veriden hesaplanan bir kontrol listesi olur. Her adımın yanında tamamlandı ya da eksik işareti ve eksikse nedeni ile ilgili sayfaya link bulunur. İki yol:
   - **A. Tasarım ve simülasyon (cihaz gerekmez):** taslak tag'ler ve ekipman tipleri; program; ekran; bağlama; simülasyon senaryoları.
   - **B. Devreye alma:** cihaz ekleme ve çevrimiçi; tag eşleme; deploy ve ack; canlı doğrulama.
2. **Menü ve gezinme sadeleşir.** `/sensor` girişi doğru sayfaya açılır. Operatör ekranına giriş noktası eklenir. Ölü linkler ve eski sayfalar kaldırılır.
3. **Kılavuz için E2E testi:** boş bir tenant, yalnızca kılavuzu izleyerek çalışan bir prosese ulaşır.

**Çıkış kapısı:** Altın yolun 9 adımının tamamı, kılavuz üzerinden CI'da yeşil.

## 5. Test stratejisi

| Katman           | Ne test edilir                                                                                                 | Nerede                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Birim            | Komut yığını, geometri ve port dönüşümleri, rota çizici, doküman dönüştürücüsü, ST uyum seti, alarm-core       | `web/modules/sensor-module`, `libs/sensor-contracts`, `sens-api-gateway` |
| Özellik tabanlı  | Rastgele editör işlemleri sonrası topoloji ve dik açı değişmezleri; v2 → v3 → kaydet → yükle eşitliği          | editör ve kontrat paketleri                                              |
| Kontrat          | Gerçek serileştirici çıktıları iki dilde: doküman, deploy paketi, CommandResponse, ack                         | `libs/sensor-contracts` + Rust testleri                                  |
| Görsel regresyon | 20 referans ekranın editör önizlemesi, bulut operatör ekranı ve edge HMI'daki çizim eşliği                     | Playwright                                                               |
| Uçtan uca        | Altın yol ve her fazın çıkış kapısı: gerçek sensor-service, Mosquitto, release edge ajanı ve Modbus simülatörü | `e2e/` (Faz 0'da kurulur)                                                |

## 6. Riskler ve bağımlılıklar

- **D1 kararı ADR-018'i değiştirebilir.** Faz 1'in 5. işi bu karara bağlı; karar Faz 0 içinde verilmeli.
- **WASM derlemesi (K4)** Rust derleyicisinin WASM hedefinde derlenebilmesini gerektirir. İşletim sistemine bağımlı kodun (SQLCipher, ağ erişimi) derleyici ve VM çekirdeğinden ayrılması gerekebilir.
- **Shell'in data router'a geçişi (Faz 4, 9. iş)** tüm federated modülleri etkiler; ayrı bir uyumluluk testi gerekir.
- **Edge'de mesaj boyutu ve parçalama (Faz 1, 6. iş)** büyük HMI paketleri için şart; Mosquitto ve rumqttc limitleri birlikte ele alınmalı.
- **Kapsam disiplini.** Her faz yalnızca kendi bulgularını kapatır. Yeni özellik eklemek, ilgili fazın çıkış kapısı yeşil olduktan sonra açılan ayrı bir plan maddesiyle olur.

## 7. İzlenebilirlik

- Her bulgunun kaydında sahip (`Okan-wqm`), fazın son tarihi ve bu plan bulunur.
- Her düzeltme commit'i `Closes: docs/reviews/claude/2026-10-19-scada-e2e-audit.md#<ID>` satırını taşır. Satır, `origin/main`'e birleşince bulguyu `RESOLVED` yapar.
- Bir fazın çıkış kapısı, o fazdaki tüm bulgular `RESOLVED` ve fazın E2E testleri yeşil olmadan kapanmaz.

## Ek A: Bulgu dizini

Bulguların kanıtları, doğrulama kararları ve birleştirilen ham bulgular kanıt raporunda kimlik başlığı altında yer alır.

| ID                                                                                            | Önem     | Faz | Son tarih  | Özet                                                                                                                        |
| --------------------------------------------------------------------------------------------- | -------- | --- | ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| [SENSOR-HIGH-337](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-337)         | HIGH     | F0  | 2026-11-02 | Testler SCADA yolunda yanlış güven veriyor; uçtan uca test yok.                                                             |
| [SENSOR-CRITICAL-271](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-271) | CRITICAL | F1  | 2026-11-30 | Cihaz cevapları eşleşmiyor: deploy kayıtları SENT/PENDING kalıyor, program "cevap yok" diye zaman aşımına düşüyor.          |
| [EDGE-CRITICAL-072](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-critical-072)     | CRITICAL | F1  | 2026-11-30 | Edge VM'in çıkış katmanı yok: program yazdıkları donanıma (GPIO/Modbus/I2C) hiç ulaşmıyor, çıkışlar geri okunmuyor.         |
| [SENSOR-CRITICAL-276](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-276) | CRITICAL | F1  | 2026-11-30 | Cihaz her deploy komutunu ikinci kişi onayı kapısında reddediyor; bulut imzalı komut üretemiyor.                            |
| [INFRA-CRITICAL-238](../../reviews/claude/2026-10-19-scada-e2e-audit.md#infra-critical-238)   | CRITICAL | F1  | 2026-11-30 | Paket imza anahtarı production'da tanımlı değil; birleşik deploy reddediliyor.                                              |
| [SENSOR-CRITICAL-277](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-277) | CRITICAL | F1  | 2026-11-30 | Cihaza paket imzasını doğrulayacak anahtar hiç ulaştırılmıyor.                                                              |
| [SENSOR-CRITICAL-285](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-285) | CRITICAL | F1  | 2026-11-30 | Bulut SCADA yerel tag adıyla abone oluyor, üretici FQN yayınlıyor; canlı değer hiç gelmiyor.                                |
| [SENSOR-CRITICAL-286](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-286) | CRITICAL | F1  | 2026-11-30 | Edge cihazının I/O değerleri bulut canlı veri düzlemine hiç girmiyor.                                                       |
| [SENSOR-CRITICAL-287](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-287) | CRITICAL | F1  | 2026-11-30 | Tarayıcıdan hiçbir kontrol yazması cihaza ulaşmıyor.                                                                        |
| [EDGE-CRITICAL-079](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-critical-079)     | CRITICAL | F1  | 2026-11-30 | Edge tag kataloğu her yeniden başlatmada boşalıyor; buluttan tanımlanan I/O sürücü oluşturmuyor.                            |
| [EDGE-CRITICAL-081](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-critical-081)     | CRITICAL | F1  | 2026-11-30 | Edge ajanı HMI'ın onay/PIN/alarm-onay mesajlarını reddediyor; cihaz ekranından komut çalışmıyor.                            |
| [EDGE-HIGH-068](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-068)             | HIGH     | F1  | 2026-11-30 | Yayın sürümünde GPIO yok ve buluttan tanımlanan GPIO tag'leri sürücüye ulaşmıyor; pin sürülemiyor.                          |
| [SENSOR-HIGH-272](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-272)         | HIGH     | F1  | 2026-11-30 | Kurulum betiğinin yazdığı ayarlarla release sürümü açılmıyor.                                                               |
| [EDGE-HIGH-073](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-073)             | HIGH     | F1  | 2026-11-30 | Edge VM tag tip haritası açılışta boş katalogdan kuruluyor; BOOL/INT yazmaları reddediliyor.                                |
| [SENSOR-HIGH-278](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-278)         | HIGH     | F1  | 2026-11-30 | Bütün deploy'lar cihaz onayı yerine broker'a gönderimde "başarılı" gösteriliyor.                                            |
| [EDGE-HIGH-077](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-077)             | HIGH     | F1  | 2026-11-30 | Edge paket sürüm numarasını birincil anahtar yapıyor; aynı sürümü yeniden gönderme ve geri alma başarısız.                  |
| [SENSOR-HIGH-288](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-288)         | HIGH     | F1  | 2026-11-30 | Widget bağlamasında tek doğruluk kaynağı yok; yeniden bağlama eski tagRef yüzünden işlemiyor.                               |
| [EDGE-HIGH-080](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-080)             | HIGH     | F1  | 2026-11-30 | Edge HMI Modbus yazmaları hep ilk Modbus cihazına gidiyor.                                                                  |
| [SENSOR-HIGH-298](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-298)         | HIGH     | F1  | 2026-11-30 | Acil stop (E-STOP) güvensiz: süre 1000 kat yanlış, çıkışları sıfırlamıyor, PIN kontrolü yok.                                |
| [EDGE-MEDIUM-074](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-medium-074)         | MEDIUM   | F1  | 2026-11-30 | Edge'de tag-donanım yazması için dört farklı ve tutarsız yol var.                                                           |
| [EDGE-MEDIUM-075](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-medium-075)         | MEDIUM   | F1  | 2026-11-30 | Hatalı program her taramada sonsuza kadar yeniden deneniyor.                                                                |
| [EDGE-MEDIUM-076](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-medium-076)         | MEDIUM   | F1  | 2026-11-30 | Olay tabanlı görevler saha girişi değişince uyanmıyor.                                                                      |
| [SENSOR-MEDIUM-282](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-282)     | MEDIUM   | F1  | 2026-11-30 | Bulutun kabul ettiği kesirli/negatif sayılar edge'de bütün paketi reddettiriyor.                                            |
| [SENSOR-MEDIUM-283](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-283)     | MEDIUM   | F1  | 2026-11-30 | Başarısız deploy denemesi 5 dakika boyunca yeniden denemeyi engelliyor.                                                     |
| [SENSOR-MEDIUM-284](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-284)     | MEDIUM   | F1  | 2026-11-30 | Paket tek MQTT mesajında gidiyor; edge'in 1 MiB sınırı kontrol edilmiyor.                                                   |
| [EDGE-MEDIUM-083](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-medium-083)         | MEDIUM   | F1  | 2026-11-30 | Edge HMI değerleri bir mesaj geç gösteriyor, yoğunlukta mesaj kaçırabiliyor.                                                |
| [EDGE-LOW-084](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-low-084)               | LOW      | F1  | 2026-11-30 | Edge HMI'ı yerel ağ için güvenli hale getirmek sayfayı kilitliyor.                                                          |
| [EDGE-CRITICAL-078](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-critical-078)     | CRITICAL | F2  | 2026-12-21 | Edge HMI config.tag okuyor, builder config.tagName yazıyor; cihaz ekranında hiçbir değer görünmüyor.                        |
| [SENSOR-CRITICAL-290](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-290) | CRITICAL | F2  | 2026-12-21 | Bulut operatör ekranı hiçbir widget çizmiyor ("?" kutular, yanlış ızgara).                                                  |
| [SENSOR-CRITICAL-291](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-291) | CRITICAL | F2  | 2026-12-21 | Borular, arka plan, gizlilik, katman sırası ve dönüşümler hiçbir çalışma ekranında yok.                                     |
| [SENSOR-CRITICAL-292](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-292) | CRITICAL | F2  | 2026-12-21 | Paletin %56'sı (bütün P&ID ekipmanları dahil) deploy'u başarısız yapıyor.                                                   |
| [EDGE-HIGH-082](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-082)             | HIGH     | F2  | 2026-12-21 | Edge HMI sadece internet varken açılıyor (CDN bağımlılığı).                                                                 |
| [SENSOR-HIGH-299](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-299)         | HIGH     | F2  | 2026-12-21 | Olay, animasyon ve yetki ayarları hiçbir runtime'ın okumadığı formatta kaydediliyor.                                        |
| [SENSOR-MEDIUM-293](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-293)     | MEDIUM   | F2  | 2026-12-21 | Edge HMI sabit 12x8 ızgara kullanıyor; yerleşim bozuluyor.                                                                  |
| [SENSOR-MEDIUM-296](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-296)     | MEDIUM   | F2  | 2026-12-21 | Widget ayar anahtarları ile çiziciler birbirini tutmuyor.                                                                   |
| [SENSOR-MEDIUM-297](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-297)     | MEDIUM   | F2  | 2026-12-21 | 50 FUXA widget'ı boş çiziliyor.                                                                                             |
| [SENSOR-CRITICAL-269](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-269) | CRITICAL | F3  | 2027-01-18 | Arayüzde yazılan program hiç onaylanamıyor: SFC adımı isteniyor ama adım ekleme sekmesi yok, Deploy hep pasif.              |
| [SENSOR-CRITICAL-270](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-270) | CRITICAL | F3  | 2027-01-18 | ST kodu derlenmiyor ve cihaza gönderilmiyor: derleyici sahte, cihaza "hiçbir şey yapma" programı gidiyor.                   |
| [SENSOR-CRITICAL-280](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-280) | CRITICAL | F3  | 2027-01-18 | Programı SCADA paketine bağlamak deploy'u bozuyor; bağlı program hiç gönderilmiyor.                                         |
| [SENSOR-CRITICAL-324](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-critical-324) | CRITICAL | F3  | 2027-01-18 | Simülasyonda "Çalıştır" program kaynağı yerine kod adını yüklüyor; hiçbir program çalışmıyor.                               |
| [EDGE-HIGH-067](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-067)             | HIGH     | F3  | 2027-01-18 | Edge lisansı en az 5000 ms tarama süresi istiyor ve lisans hiç dağıtılmıyor; 100 ms varsayılan reddediliyor.                |
| [EDGE-HIGH-069](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-069)             | HIGH     | F3  | 2027-01-18 | Edge JSON script motoru gönderilen programları neredeyse hiç çalıştırmıyor (FB, tetikleyici, mod).                          |
| [EDGE-HIGH-070](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-070)             | HIGH     | F3  | 2027-01-18 | Edge ST derleyicisi karşılaştırma operatörlerini, TON/TOF/R_TRIG bloklarını, TIME/STRING değerlerini derleyemiyor.          |
| [EDGE-HIGH-071](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-071)             | HIGH     | F3  | 2027-01-18 | Edge VM değişkenlerin başlangıç değerlerini yok sayıyor.                                                                    |
| [SENSOR-HIGH-274](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-274)         | HIGH     | F3  | 2027-01-18 | A cihazına bağlı program B cihazına deploy edilince A'nın çıkışlarını sürüyor.                                              |
| [SENSOR-HIGH-275](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-275)         | HIGH     | F3  | 2027-01-18 | Modbus/I2C kanalına bağlı program çıkışları sürülemiyor; kanal değiştirmek bağlamayı koparıyor.                             |
| [SENSOR-HIGH-326](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-326)         | HIGH     | F3  | 2027-01-18 | Tarayıcı ST yorumlayıcısı edge'den sessizce farklı: zamanlayıcılar çalışmıyor, aritmetik farklı.                            |
| [SENSOR-HIGH-327](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-327)         | HIGH     | F3  | 2027-01-18 | Simülasyon ile edge VM'in değişken-tag modeli zıt; aynı anda tek program çalışıyor.                                         |
| [SENSOR-MEDIUM-273](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-273)     | MEDIUM   | F3  | 2027-01-18 | PLC setpoint hedefi setpoint göndermiyor; cihaz reddediyor.                                                                 |
| [SENSOR-HIGH-289](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-289)         | HIGH     | F4  | 2027-03-01 | Tag kaynağı tasarımı engelliyor: sadece seçili cihazın kanalları var, taslak tag yok, listeler kırpılıyor.                  |
| [SENSOR-HIGH-294](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-294)         | HIGH     | F4  | 2027-03-01 | Bazı widget'lar gerçek değer gibi görünen sabit demo veri gösteriyor.                                                       |
| [SENSOR-HIGH-295](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-295)         | HIGH     | F4  | 2027-03-01 | Ekipman widget'ları durumu yanlış gösteriyor: demo durum canlı değeri eziyor, bazı vanalar hiç açık görünmüyor.             |
| [SENSOR-HIGH-300](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-300)         | HIGH     | F4  | 2027-03-01 | ProcessView widget'ı yer tutucu; prosesten paket oluşturma boş geliyor.                                                     |
| [SENSOR-HIGH-301](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-301)         | HIGH     | F4  | 2027-03-01 | Geri al/yinele hiçbir editörde çalışmıyor.                                                                                  |
| [SENSOR-HIGH-302](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-302)         | HIGH     | F4  | 2027-03-01 | Hizalama ve X/Y alanları ekipmanı ekranda taşımıyor.                                                                        |
| [SENSOR-HIGH-303](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-303)         | HIGH     | F4  | 2027-03-01 | Seçim iki ayrı yerde tutuluyor; çoklu seçim ve silme tutarsız.                                                              |
| [SENSOR-HIGH-304](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-304)         | HIGH     | F4  | 2027-03-01 | Ekipman geometrisi düz bağlantıyı imkansız kılıyor: yan yana iki ekipmanın portları asla aynı hizaya gelmiyor.              |
| [SENSOR-HIGH-305](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-305)         | HIGH     | F4  | 2027-03-01 | Döndürülen ekipmanın portları dönmüyor.                                                                                     |
| [SENSOR-HIGH-306](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-306)         | HIGH     | F4  | 2027-03-01 | Boru modeli geometrik: borular ekipmanı takip etmiyor, port yönü yok sayılıyor.                                             |
| [SENSOR-HIGH-311](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-311)         | HIGH     | F4  | 2027-03-01 | Kaydedilmemiş çalışma uygulama içi gezinmede uyarısız kayboluyor.                                                           |
| [SENSOR-HIGH-312](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-312)         | HIGH     | F4  | 2027-03-01 | Paket yüklenemezse önceki paket yeni kimlikle gösteriliyor; Kaydet üzerine yazıyor.                                         |
| [SENSOR-HIGH-313](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-313)         | HIGH     | F4  | 2027-03-01 | Deploy, kaydetme başarısızsa sunucudaki eski sürümü gönderiyor.                                                             |
| [SENSOR-HIGH-314](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-314)         | HIGH     | F4  | 2027-03-01 | Gömülü resimler paket kaydını başarısız yapıyor.                                                                            |
| [SENSOR-HIGH-315](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-315)         | HIGH     | F4  | 2027-03-01 | Kayıtlı paket açılınca boş "Screen 1" ekleniyor ve paket değişmiş sayılıyor.                                                |
| [SENSOR-HIGH-318](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-318)         | HIGH     | F4  | 2027-03-01 | Builder ve unified editor aynı tesis için birbirini okuyamayan paketler üretiyor.                                           |
| [SENSOR-MEDIUM-307](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-307)     | MEDIUM   | F4  | 2027-03-01 | Boru akış animasyonu pompa/vana durumuna bağlı değil.                                                                       |
| [SENSOR-MEDIUM-310](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-310)     | MEDIUM   | F4  | 2027-03-01 | Yıkıcı düzenlemeler güvensiz: ekran silme sarkan bağlantılar bırakıyor, kısayollar kapsamsız.                               |
| [SENSOR-MEDIUM-316](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-316)     | MEDIUM   | F4  | 2027-03-01 | Kaydet/sil hataları sunucunun sebebini gizliyor.                                                                            |
| [SENSOR-MEDIUM-317](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-317)     | MEDIUM   | F4  | 2027-03-01 | Eşzamanlılık kontrolü yok; son yazan kazanıyor.                                                                             |
| [SENSOR-MEDIUM-320](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-320)     | MEDIUM   | F4  | 2027-03-01 | Dışa/içe aktarma ve şablonlar veri kaybediyor.                                                                              |
| [SENSOR-LOW-308](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-low-308)           | LOW      | F4  | 2027-03-01 | Boru ucunu başka porta taşıma yok; sinyal hattı portu yok.                                                                  |
| [SENSOR-LOW-309](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-low-309)           | LOW      | F4  | 2027-03-01 | Katman sırası, kılavuz çizgiler, cetvel ve ekleme konumu bozuk.                                                             |
| [SENSOR-LOW-319](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-low-319)           | LOW      | F4  | 2027-03-01 | Paket listesi sadece son 20 paketi gösteriyor.                                                                              |
| [SENSOR-LOW-321](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-low-321)           | LOW      | F4  | 2027-03-01 | Erişilemeyen ya da hiçbir şey yapmayan özellikler çalışıyormuş gibi sunuluyor.                                              |
| [SENSOR-LOW-322](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-low-322)           | LOW      | F4  | 2027-03-01 | Kayıtlı hedef cihaz Deploy penceresinde yok sayılıyor.                                                                      |
| [SENSOR-HIGH-325](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-325)         | HIGH     | F5  | 2027-03-29 | Simülasyonda hiçbir alarm tetiklenemiyor; banner kural sayısını aktif alarm gibi gösteriyor.                                |
| [SENSOR-HIGH-329](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-329)         | HIGH     | F5  | 2027-03-29 | Etkileşimli kapalı döngü simülasyon imkansız: tesis modeli yok, komut/geri bildirim ayrımı yok, VFD simülasyonu dinlemiyor. |
| [SENSOR-HIGH-331](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-331)         | HIGH     | F5  | 2027-03-29 | Paket script'leri hiçbir runtime'da çalışmıyor.                                                                             |
| [SENSOR-MEDIUM-323](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-323)     | MEDIUM   | F5  | 2027-03-29 | Simülasyon durumu sıfırlamaya rağmen kalıyor ve sonraki pakete sızıyor.                                                     |
| [SENSOR-MEDIUM-328](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-328)     | MEDIUM   | F5  | 2027-03-29 | Simülasyonda operatör girişi tarama zamanlayıcısını sıfırlıyor; panel kapanınca program duruyor.                            |
| [SENSOR-LOW-330](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-low-330)           | LOW      | F5  | 2027-03-29 | Senaryo araçları statik: rampa, arıza enjeksiyonu, kayıt/oynatma yok.                                                       |
| [SENSOR-HIGH-279](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-279)         | HIGH     | F6  | 2027-04-19 | Bulut runtime ve paket durumu deploy edilen sürümü değil son kaydedilen taslağı izliyor.                                    |
| [SENSOR-HIGH-332](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-332)         | HIGH     | F6  | 2027-04-19 | Alarmlar runtime'lar arasında tutarsız: farklı depolar, farklı tag anahtarı, farklı mantık.                                 |
| [EDGE-HIGH-086](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-high-086)             | HIGH     | F6  | 2027-04-19 | Trendler hep boş.                                                                                                           |
| [SENSOR-HIGH-334](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-high-334)         | HIGH     | F6  | 2027-04-19 | Kontrol güvenliği uygulanmıyor: PIN ayarlanamıyor, roller sadece istemcide.                                                 |
| [SENSOR-MEDIUM-281](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-281)     | MEDIUM   | F6  | 2027-04-19 | Geri alma ve deploy geçmişi arayüzden erişilemiyor.                                                                         |
| [EDGE-MEDIUM-085](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-medium-085)         | MEDIUM   | F6  | 2027-04-19 | Edge kalibrasyonu uçtan uca çalışmıyor.                                                                                     |
| [SENSOR-MEDIUM-333](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-333)     | MEDIUM   | F6  | 2027-04-19 | Bulut alarm değerlendirmesi sadece operatör ekranı açıkken çalışıyor; bildirimler hiç gitmiyor.                             |
| [SENSOR-MEDIUM-335](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-335)     | MEDIUM   | F6  | 2027-04-19 | Zamanlayıcı widget kayıtları hiçbir yerde çalıştırılmıyor.                                                                  |
| [EDGE-MEDIUM-087](../../reviews/claude/2026-10-19-scada-e2e-audit.md#edge-medium-087)         | MEDIUM   | F6  | 2027-04-19 | Edge zamanlamaları UTC'ye göre çalışıyor; sahanın saat dilimi yok.                                                          |
| [SENSOR-MEDIUM-336](../../reviews/claude/2026-10-19-scada-e2e-audit.md#sensor-medium-336)     | MEDIUM   | F7  | 2027-05-03 | Tutarlı bir SCADA yolculuğu yok: eski sayfaya iniş, ölü linkler, operatör ekranına giriş yok.                               |
