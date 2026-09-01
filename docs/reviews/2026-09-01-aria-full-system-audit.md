# ARIA tam sistem denetimi ve yeni ARIA sınır önerisi

Tarih: 2026-09-01
Denetlenen taban: `origin/main`, `d0afe46bd1aeea57e1c5eda63343cd24dfd925e4`
Çalışma dalı: `docs/aria-full-system-audit-2026-09-01`
Durum: Denetim tamamlandı; bu belgedeki açık bulgular henüz kapatılmış sayılmaz.

## Yönetici özeti

Mevcut ARIA, taşınabilir bir ürün mikroservisi değildir. GitHub Actions, Python komutları,
JSONL/Markdown durum dosyaları ve Claude CLI etrafında kurulmuş, bu repository'yi yöneten bir
otonomi kontrol düzlemidir. HTTP, GraphQL, WebSocket/SSE veya sohbet sunucusu yoktur.
`aria-kernel/aria_kernel/agent_question.py` yalnızca bir deftere soru yazar; soruyu kullanıcıya
taşıyan, yanıtı alan ve işi devam ettiren bir yönlendirici bulunmaz.

Sonuç olarak yeni ARIA'yı mevcut çekirdeğin içine eklemek doğru sınır değildir. Önerilen yön,
`apps/aria-service` altında kendi çekirdeği ve port/adaptörleri bulunan bağımsız bir NestJS
mikroservisi ile `web/modules/aria` altında bir mikro-frontend kurmak; eski ARIA'yı salt-okunur bir
geçiş kaynağı olarak kullanmaktır. Eski ve yeni sistem arasında çift yazım yapılmamalıdır.

Denetimde yıkıcı dosya silme, sahte onay/attestasyon kabulü, kriptografik güven kökü hataları,
başarısız çalışmaları yeşil gösteren kapılar, sessiz veri kaybı ve yarış koşulları dahil 88
doğrulanmış bulgu kaydedildi. Birincil checkout'ta denetim sırasında başka bir çalışmaya ait
commitlenmemiş değişiklikler ayrıca incelendi; sonra dışarıdan kaldırılan bu taslaklar yarım veya
kusurlu oldukları için hiçbir bulgu kapalı işaretlenmedi.

Dağılım: 24 P0, 43 P1, 16 P2 ve 5 P3.

## Kapsam ve yöntem

Denetim sekiz bağımsız okuma şeridine ayrıldı. Ortam en fazla üç eşzamanlı alt ajan çalıştırdığı
için şeritler dalgalar halinde yürütüldü. Orkestratör, her şeridin dosya manifestini, satır sayısını,
özetini ve bulgularını birleştirip çakışmaları tekilleştirdi.

| Şerit      | Ana konu                              |     Dosya |       Satır | Manifest özeti                                                     |
| ---------- | ------------------------------------- | --------: | ----------: | ------------------------------------------------------------------ |
| 1          | Mimari, giriş noktaları, sınırlar     |       137 |      43.470 | `82de41b9905b1d2178288e06d188417e2403fd47e6fc3c683fb9a7dad41485e0` |
| 2          | Çalıştırma, durum bakımı, CLI         |       137 |      42.862 | `eb3e54694a694cb8bbdeeb1f6df438745cdfccdc4a30428b9b4bf04715a06bf6` |
| 3          | Durum, bütünlük, kimlik               |       137 |      32.732 | `362d21fa681ed682cbfbd76fd736fc5e6878579fc3b8893b708ed5d1fb5cde2b` |
| 4          | Otonomi, işçi, imza, model filosu     |       137 |      35.132 | `faaf06c1e1b9fa5f36573bed18578fd0111d3190c2a689bf363b601eb4fd4214` |
| 5          | Yürütme güvenliği, kanıt, maliyet     |       137 |      40.072 | `d4cfa9696154274cc331b0a82414abc4f9c5c28c96e21cae22b5914335068643` |
| 6          | Araçlar, etki analizi, hook'lar       |       137 |      35.918 | `9a14da48f3e63c998086e2f23e4609780f4b727b36158ff08169e35abdfb8347` |
| 7          | Testler, CI ve kabul kapıları         |       145 |      42.248 | `07471cfb8c132e038a8ff9a08cf46bacc829f4b102bd408b56304b85022731de` |
| 8          | API/UI, gözlemlenebilirlik, operasyon |       150 |      50.428 | `5fe0f441341eeaf1627457c35ad0f9c16abcc4e4be634b21a56548196604e79b` |
| **Toplam** | **Etkin ARIA ve entegrasyon yüzeyi**  | **1.179** | **339.788** | **Eksik okunmuş dosya: 0**                                         |

İlk sabit manifest 1.095 dosya ve 321.329 satırdı. Etkin entegrasyon ekleri 22 dosya ve 1.533
satır; ikinci kapsama ekleri 62 dosya ve 16.926 satır ekledi. Son toplam 1.179 dosya ve 339.788
satırdır. Şerit 6, 7 ve 8 eklerinin özetleri sırasıyla
`704ed6373409ed3578793c1e5a99b5fa6b529d826a897d2f34f28369a6479e15`,
`4d343bc8745417507b00c2fbb9aec0d27e906fdbfd09283ebbe9dc1b6489eaab` ve
`5c52505e7a7d50cc62dbe1fa37f7717f1fe30c2ca29a372a27d21a024733b6a0` değerleridir.

Denetim sırasında ana dal `db31…/997…` çizgisinden `d0afe…` çizgisine ilerledi. Etkin ARIA
yüzeyindeki fark ayrıca tekrar okundu; değişiklikler
`.github/actions/restore-aria-state/action.yml` ve `docs/aria/CURRENT_STATE.md` ile sınırlıydı.
Bu rapordaki kaynak konumları, aksi açıkça belirtilmedikçe `d0afe…` tabanına aittir.

### Kapsam sınırları

- `web/**` altındaki 233 “aria” eşleşmesi, çoğunlukla WAI-ARIA erişilebilirlik öznitelikleridir ve
  bu otonomi sistemiyle ilgisiz oldukları için sistem kodu kapsamına alınmadı.
- `docs/reviews/**` geçmiş denetim kanıtıdır; etkin çalışma zamanı olarak yeniden
  sınıflandırılmadı.
- Ortak ve üretilmiş repository envanterlerinde yalnızca ARIA'ya bağlanan entegrasyon yüzeyleri
  okundu.
- `aria/state` anlık görüntüsü yaklaşık 681 dosya ve 881 MB'dir. Kaynak kod gibi “her satır”
  iddiasına dahil değildir; biçimi, hacmi ve sayaçları yapısal olarak incelendi. 2026-08-30'da
  alınmış yerel kopyada 661 araç, yaklaşık 62 döngü olayı, 158 run, 27.853 ham bulgu, 725 istek,
  1.902 claim ve 188 sonuç vardı. Bu sayılar güncel uzak durum iddiası değildir.
- Dinamik GitHub ayarları, branch-protection kuralları ve barındırılan runner kimlik bilgileri
  çevrimdışı kaynak denetimiyle doğrulanamaz.

## Mevcut sistem akışı

`GitHub Actions / CLI` → `aria/state geri yükleme` → `Python kernel cycle` →
`discovery / adapters / memory / pressure / missions / judges` → `Claude CLI executor` →
`validation / PR / merge` → `state yayınlama`.

Okuma modelleri JSONL defterlerini baştan tarar. Sonuçlar Markdown raporlar ve izlenen JSON
panolarla sunulur. İstemciye uygun sorgu deposu, canlı olay kanalı, tenant sınırı, konuşma oturumu
veya ürün API'si yoktur.

## Öncelik tanımı

- **P0:** Yıkıcı işlem, güven sınırı aşımı, sessiz veri kaybı veya başarısızlığın güvenilir biçimde
  başarı gösterilmesi.
- **P1:** Üretim doğruluğunu, bütünlüğünü veya otonomi kararını ciddi biçimde bozan hata.
- **P2:** Belirli koşullarda yanlış karar, operasyonel kilitlenme veya taşınabilirlik kaybı.
- **P3:** Mimari borç, gözlemlenebilirlik açığı ya da ürünleşme engeli.

## Doğrulanmış bulgular

Her maddeye bu denetim için kararlı bir `ARIA-AUDIT-*` kimliği verildi. Bunlar kalıcı bulgu
defteri kimliği değildir. Düzeltme başlamadan önce resmi registry kimliği tahsis edilmeli, commit
mesajındaki `Closes:` satırı ve regresyon testi bu yerel kimliğe eşlenmelidir.

### Durum, bütünlük ve eşzamanlılık

#### ARIA-AUDIT-001 — P0 — Scheduled compactor kanonik defteri bozabiliyor

`.github/workflows/aria-state-maintenance.yml:19-23,94-123,134-140,145-215` içindeki inline
compactor, kanonik `aria-kernel/aria_kernel/state_compact.py` davranışından ayrışıyor; bozuk
satırları atlıyor, satırları re-chain etmeden değiştirip/siliyor, böylece mevcut zinciri geçersiz
kılıyor ve içerik kaybını başarılı bakım gibi yayınlayabiliyor.

Kök neden iki ayrı compaction uygulamasının bulunmasıdır. Workflow yalnızca kanonik CLI'yı
çağırmalı; lossless multiset, sıra, zincir ve idempotency testleri aynı üretim yolunu
çalıştırmalıdır.

#### ARIA-AUDIT-002 — P0 — Kanonik compaction arşiv sınırında veri kaybediyor

`aria-kernel/aria_kernel/state_compact.py:28-29,103-190` arşive alınan satırları taşıma sırasında
değiştiriyor ve lossless koruma varsayımını ihlal ediyor. Mevcut test
`aria-kernel/tests/test_state_compact.py:175-188` yalnız arşiv varlığı ve yeniden kurulmuş zinciri
kontrol ediyor; içeriğin birebir korunmasını kanıtlamıyor.

Düzeltme ham baytları değişmeden arşivlemeli, yeni temsil gerekiyorsa ayrı bir indeks yazmalı ve
girdi/aktif/arşiv toplamının tam multiset eşitliğini test etmelidir.

#### ARIA-AUDIT-003 — P1 — Yerel governance okumaları zincir doğrulamasını atlıyor

`aria-kernel/aria_kernel/governance_reader.py` normal yerel satırları doğrudan okuyor; hash-chain
doğrulaması yalnızca replay/transport yolunda uygulanıyor. Yerel bozulmuş veya elle değiştirilmiş
bir kayıt, doğrulanmış governance gerçeği gibi karar akışına girebilir.

Tek bir doğrulanan reader portu kullanılmalı; native, replay ve restore yolları aynı fail-closed
zincir denetiminden geçmelidir.

#### ARIA-AUDIT-004 — P1 — Günlük rapor yalnızca tail hash ile bütünlük varsayıyor

`aria-kernel/aria_kernel/report.py:41-69` sondan geriye yürüyüp parse edilemeyen satırları atlıyor,
bulduğu daha eski ilk `ledger_hash` değerini tail seçiyor; fiziksel nonblank satır sayısını ise
ayrıca sayıyor. `.github/workflows/aria-daily-report.yml:142-165` bu çelişkili anchor'ı rapora
taşıyor. Test yalnızca temiz/uydurulmuş anchor davranışını
`aria-kernel/tests/test_daily_report_anchor_invariant.py:155-181` seviyesinde sabitliyor; bozuk son
satır ve kırık previous-hash vakası yok.

Rapor üretmeden önce tam zincir veya güvenilir checkpoint'ten artımlı zincir doğrulaması
zorunlu olmalıdır.

#### ARIA-AUDIT-005 — P1 — Pressure ağırlık override'ları sessizce modeli bozuyor

`aria-kernel/aria_kernel/pressure.py:70-92` malformed JSON'u `ValueError` ile sessizce atlıyor,
semantik olarak geçersiz satırları diagnostic/refusal üretmeden yok sayıyor. Writer bilinmeyen
source ve `[1, 100]` dışı değeri reddetse de `:120-134` declared ledger API yerine raw, hash'siz
append kullanıyor; elle/yarım yazılmış satırlarda reader ile writer doğrulaması ayrışıyor. Bu
politika `:217-245` içinde sıralama ve calibration exemption kararına ulaşıyor. Mevcut temiz
append/last-write-wins testleri corruption vakasını kapsamıyor.

Bu yüzey declared, strict-read ve hash-chained control-plane ledger olmalı; kapalı şema, sonlu
sayı/boolean ayrımı ve bozulmada açık governance refusal zorunlu olmalıdır.

#### ARIA-AUDIT-006 — P1 — Report ingestion exactly-once garantisi süreç içi cache'e bağlı

`aria-kernel/aria_kernel/report_ingestion.py` mutable süreç içi cache ile deduplication yapıyor.
Yeniden başlatma ve birden çok ledger/worker durumunda aynı rapor iki kez uygulanabilir veya
başka ledger'daki aynı anahtar yanlışlıkla bastırılabilir.

Kimlik `workspace + ledger + immutable report digest` olmalı ve atomik, kalıcı bir idempotency
kaydıyla yazılmalıdır.

#### ARIA-AUDIT-007 — P1 — Bozulma tanısı güvenli append yolunu atlıyor

Bozukluk algılandığında diagnostic kayıtlar doğrudan deftere eklenebiliyor; normal kilit, zincir,
şema ve atomik replace yolu uygulanmıyor. Bu durum bir bozulmayı raporlarken ikinci bir bozulma
üretebilir.

Tanı olayları da aynı tek-yazar append portunu kullanmalı; okuyucu hiçbir koşulda kaynak ledger'a
yan etkili yazmamalıdır.

#### ARIA-AUDIT-008 — P1 — Evidence collector mutable çalışma ağacını commit kanıtı gibi etiketliyor

`aria-kernel/aria_kernel/evidence_collector.py` dosyaları çalışma ağacından okurken kanıta HEAD SHA
ekliyor, yalnızca sınırlı örnek topluyor ve dar kimlik alanları nedeniyle çakışmaya açık kayıt
üretiyor. Kanıt, belirtilen commit'in içeriğini temsil etmeyebilir.

İçerik `git show <sha>:<path>` benzeri immutable kaynaktan okunmalı; tüm dosya digest'leri ve
repo/workspace kimliği kanıt kimliğine katılmalıdır.

#### ARIA-AUDIT-009 — P1 — Eksik veya bozuk girdiler temiz boş döngüye dönüşebiliyor

Discovery/state girişlerinin bulunmaması ya da parse edilememesi bazı yollarda “0 bulgu” olarak
yorumlanıyor. Bu, veri yokluğunu sağlıklı sistem kanıtına dönüştürüyor.

`missing`, `invalid`, `empty` ve `verified-empty` ayrı typed sonuçlar olmalı; ilk ikisi karar
kapılarını fail-closed durdurmalıdır.

#### ARIA-AUDIT-010 — P1 — State yazımlarında check-then-append yarışları var

Birçok ledger yazarı “var mı?” kontrolünden sonra ayrı bir append yapıyor. Paralel worker'lar aynı
kimliği iki kez yazabilir, sıra/hash başını kaybedebilir veya birbirinin güncellemesini ezebilir.

Tüm ledger'lar workspace başına tek-yazar/lock ve compare-and-swap head protokolüne taşınmalı;
eşzamanlılık regresyon testleri gerçek çoklu süreç kullanmalıdır.

#### ARIA-AUDIT-011 — P0 — Worktree prune persisted path üzerinden keyfi dizin silebiliyor

`aria-kernel/aria_kernel/worker_dispatch.py:412-429` absolute persisted path'i containment
uygulamadan kabul ediyor, `git worktree remove --force` sonucunu yok sayıyor ve recursive silmeye
geçiyor. `aria-kernel/aria_kernel/cli.py:1398-1401,3996-4004` operatör yoludur. Kaynak akışı repo
dışındaki mevcut dizine de ulaşabilir; kontrollü reprodüksiyonda ayrıca kayıtlı olmayan repo alt
dizini silindi. Mevcut testlerde dış path, symlink escape, kayıtlı olmayan descendant ve non-zero
`git` sonucu birlikte kapsamlı değildir.

Silme hedefi `git worktree list --porcelain` içindeki canonical bir kayıtla birebir eşleşmeli,
`git worktree remove` başarısızlığı fail-closed olmalı ve raw `rmtree` fallback kaldırılmalıdır.

### Kimlik, imza, onay ve güven sınırları

#### ARIA-AUDIT-012 — P0 — Panel approval token'ı yalnızca varlık kontrolüyle kabul ediliyor

`aria-kernel/aria_kernel/tool_registry.py:1318-1326,1402` panel token'ının kriptografik
geçerliliğini doğrulamadan “token var” durumunu yeterli sayıyor.
`aria-kernel/aria_kernel/promotion_veto.py:450-487` token'ı mint edip geçiriyor; yetki kararı
`transition_tool` consumer'ındadır. Kontrollü reprodüksiyonda uydurulmuş token onaylı statü
üretti; tracked tabanda forged/cross-tool/cross-workspace consume regresyonu yoktu.

En dar düzeltme, mevcut `verify_panel_approval_token` kontrolünü consumer'da tool id, workspace
identity ve güncel panel kararına karşı constant-time yeniden çalıştırmaktır. Presence hiçbir
zaman authority olmamalıdır.

#### ARIA-AUDIT-013 — P0 — Auto-promote HMAC anahtarı halka açık path'ten türetiliyor

`aria-kernel/aria_kernel/adapter_calibration.py:166-229` workspace'in mutlak yolundan deterministik
bir HMAC anahtarı türetiyor. Yol bilen saldırgan geçerli token üretebilir; bu bir secret değildir.

Anahtar dış secret/KMS kaynağından gelmeli, key id ile döndürülmeli ve token tam action payload'ına
bağlanmalıdır.

#### ARIA-AUDIT-014 — P0 — Snapshot imzası çağıranın sunduğu public key'e güveniyor

`aria-kernel/aria_kernel/state_snapshot.py:516,593,616` imzayı envelope içindeki çağıran-kontrollü
public key ile doğrulayabiliyor. Saldırgan kendi key pair'iyle hem içeriği hem güven kökünü
üretebilir.

Doğrulayıcı yalnızca önceden pinlenmiş trust store/key id kullanmalı; envelope public key taşısa
bile yetki kaynağı kabul edilmemelidir.

#### ARIA-AUDIT-015 — P0 — Operatör onayı ve imzalar typed, merkezi doğrulanmış yetki değil

`aria-kernel/aria_kernel/plan_synthesizer.py:739-830`,
`aria-kernel/aria_kernel/implementation_safety.py:1839`,
`aria-kernel/aria_kernel/runtime_artifacts.py:481-768`,
`aria-kernel/aria_kernel/finding_promotion.py:47-103` ve
`aria-kernel/aria_kernel/knowledge_graph.py:309-449` farklı string/boolean/uzunluk kontrollerini
“onay” veya “imza” kabul ediyor.

Tek bir typed approval envelope ve verifier kullanılmalı. İmza; workspace, actor, capability,
action, exact payload digest, nonce, issued-at, expiry ve key id alanlarına bağlı olmalıdır.

#### ARIA-AUDIT-016 — P0 — Runner attestasyonu self-asserted varsayılanlardan oluşuyor

`.github/actions/probe-runner-attestation/action.yml:35` ve
`aria-kernel/aria_kernel/runner_attestation.py:190-224` doğrulanmış platform claim'i yerine
workflow girdileri/varsayılanlarıyla attestasyon üretebiliyor. Üreticinin kendi söylediği runner
özelliği güven kanıtı oluyor.

OIDC veya pinlenmiş runner kimliği dış kaynaktan doğrulanmalı; beyan ile doğrulanmış claim ayrı
alanlar olmalıdır.

#### ARIA-AUDIT-017 — P0 — GitHub token lease TTL ve revoke yalnızca yerel iddia

`aria-kernel/aria_kernel/gh_token_factory.py:299-305,422,466-472,570-589` provider tarafında
gerçek süreli/iptal edilebilir credential üretildiğini kanıtlamadan TTL ve revoke semantiği
sunuyor. Uzun ömürlü token, yerel lease “iptal edildi” dense de geçerli kalabilir.

Kısa ömürlü GitHub App installation token kullanılmalı; provider expiry doğrulanmalı ve revoke
sonrası canlı negatif kontrol yapılmalıdır.

#### ARIA-AUDIT-018 — P1 — Asenkron implementation imza kimliğini executor bitmeden iptal ediyor

`aria-kernel/aria_kernel/cycle_phases/implementer.py:178-269` işi asenkron başlatıp signing
identity'yi executor tamamlanmadan revoke edebiliyor. İş daha sonra commit/push aşamasında geçerli
kimlik bulamıyor.

Lease yaşam döngüsü job terminal durumuna bağlanmalı; `finally` cleanup işi await ettikten sonra
çalışmalıdır.

#### ARIA-AUDIT-019 — P1 — Linked worktree'de commit signing sessizce atlanıyor

`aria-kernel/aria_kernel/gh_token_factory.py:249-254` linked worktree algılandığında signing
kurulumunu atlıyor. Aynı politika ana checkout'ta imza isterken worker worktree'sinde imzasız
commit üretebilir.

Git common-dir ve worktree git-dir ayrımı doğru çözülmeli; signing policy çalışma dizini türünden
bağımsız uygulanmalıdır.

#### ARIA-AUDIT-020 — P1 — Custom merge adapter authority protokolünü atlayabiliyor

`aria-kernel/aria_kernel/merge_authority.py:244-255,296-298` `arm_merge_authority` metodunu
opsiyonel capability olarak algılıyor; metod yoksa adapter'a `authority_token` vermeden
`merge_pr` çağırıyor. `aria-kernel/tests/test_merge_authority_invariants.py:129-134` yalnız
`GhCliGitHubAdapter`'ın tokensız doğrudan merge'i reddettiğini kanıtlar; custom adapter sözleşmesini
kanıtlamaz.

Her merge adaptörü aynı zorunlu capability portunu almalı; token yoksa veya verifier başarısızsa
merge çağrısı yapılamamalıdır.

#### ARIA-AUDIT-021 — P0 — Maliyet hard-cap dış çağrıdan sonra hesaplanıyor ve fail-open

`aria-kernel/aria_kernel/cycle_phases/cost_telemetry.py:119-163`,
`tools/aria-poc/ci_executor.py:1569-1582` ve
`aria-kernel/aria_kernel/cost_budget.py:168-204` gerçek maliyeti çağrıdan sonra veya eksik
attribution ile değerlendiriyor. Bilinmeyen maliyet limiti aşsa da işlem yapılmış oluyor.

Çağrı öncesi rezervasyon, provider hard limit, terminal reconciliation ve `unknown-cost =
deny/manual approval` kuralı birlikte uygulanmalıdır.

#### ARIA-AUDIT-022 — P0 — DLP kanıtı çağıranın seçtiği/yeniden etiketlediği path'lere güveniyor

`aria-kernel/aria_kernel/cli.py:3132-3152` ve
`aria-kernel/aria_kernel/readiness_proofs.py:885-1001` kanıt kapsamını çağıranın sunduğu path ve
etiketlerden kuruyor. Hassas değişiklik kapsam dışı bırakılarak temiz DLP sonucu üretilebilir.

Tarama kapsamı immutable diff SHA'larından doğrulayıcı tarafından türetilmeli; kanıt tüm değişen
dosyaların digest'ine bağlanmalıdır.

#### ARIA-AUDIT-023 — P0 — Research fetch SSRF'ye açık

`aria-kernel/aria_kernel/research.py:48,124` URL policy, DNS/IP sınıfı, redirect zinciri ve özel
ağ engeli olmadan dış istek yapabiliyor. Metadata veya iç servis adreslerine erişim mümkün.

HTTPS allowlist, DNS rebinding koruması, private/link-local/loopback engeli, redirect başına tekrar
kontrol ve response boyut/zaman sınırı uygulanmalıdır.

#### ARIA-AUDIT-024 — P0 — Executor semantik `satisfied` kararını kendisi üretebiliyor

`tools/aria-poc/ci_executor.py:302,346,1664-1690,2464` implementer çıktısından sentetik
`satisfied` verdict üretiyor. Yetkisiz üretici kendi işini doğrulayan semantic judge'a dönüşüyor.

Executor yalnızca kanıt üretmeli; satisfied kararı bağımsız, pinlenmiş girdili judge/gate
tarafından verilmelidir.

### CI, test ve kapı doğruluğu

#### ARIA-AUDIT-025 — P0 — Acceptance harness başarısız döngüyü kabul edebiliyor

`tools/aria-acceptance/harness.py:161,194,257` cycle process sonucu başarısız olsa da beklenen
dosyalar/izler mevcutsa senaryoyu başarılı sayabiliyor.
`tools/aria-acceptance/test_harness.py:65` ayrımı eksik bırakmıyor; `completed|failed` ikisini de
başarı oracle'ı kabul ederek yanlış davranışı green-pinliyor.

Process exit, cycle terminal verdict ve artifact doğrulaması birlikte başarılı olmadan acceptance
yeşil olmamalıdır.

#### ARIA-AUDIT-026 — P0 — Operational-proof workflow başarısız verdict ile yeşil kalıyor

`.github/workflows/aria-operational-proof.yml:78,104,117` kanıt yükleme/raporlama adımlarını
tamamlanmış proof olarak yorumluyor; alttaki verdict başarısız olsa bile job success kalabiliyor.
`.github/workflows/aria-auto-cycle.yml:760` ise doğru karşı örnektir: `verdict != passed` durumunda
non-zero çıkar. Operational-proof yolunda aynı assertion yoktur.

Son adım, typed verdict'i okuyup başarısız/refused/unknown durumunda non-zero çıkmalıdır.

#### ARIA-AUDIT-027 — P0 — Watchdog FP Gate-B eksik kanıtta fail-open

`tools/aria-poc/measure_watchdog_fp_rate.py:72-86,94-107,120-136` absent, zero, malformed veya
timestamp'siz örnekleri yeterince reddetmiyor. Kanıt yokluğu düşük false-positive oranı gibi
görünebilir.

Minimum örnek, zaman penceresi, parse bütünlüğü ve kaynak digest'i yoksa kapı `unknown/failed`
olmalıdır.

#### ARIA-AUDIT-028 — P1 — Dataflow watchdog altyapı hatası workflow'u kırmıyor

`tools/watchdog/probe-runner.mjs:11-12,28-45,183` probe altyapı hatası için exit 1 üretiyor; ancak
`.github/workflows/dataflow-integrity-watchdog.yml:54-70,88-107` yalnız exit 3/CRITICAL kolunu
işleyip job'ı kırıyor. Exit 1, watchdog çalışmamış olsa bile yeşil job ile sonuçlanıyor.

Probe sonucu doğrudan job conclusion'a bağlanmalı ve negatif fixture ile CI'da kanıtlanmalıdır.

#### ARIA-AUDIT-029 — P1 — Kritik watchdog sinyali ephemeral kalıyor

`.github/workflows/dataflow-integrity-watchdog.yml:75-87` probe evidence'i artifact olarak
saklıyor; kusur kanıtın tamamının kaybolması değildir. `:88-102` kritik ARIA sinyalini ephemeral
checkout içindeki `aria-tools` yoluna yazıyor, durable state restore/publish yapmıyor ve hem ingest
hem cycle dispatch hatasını `|| true` ile yutuyor. Artifact kalırken otonomi tetikleme etkisi
sessizce kaybolabilir.

Önce dayanıklı olay/outbox yazılmalı, sonra workflow sonucu verilmelidir.

#### ARIA-AUDIT-030 — P1 — Dependency setup lock değiştiğinde stale `node_modules` kullanıyor

`.github/actions/ensure-node-deps/action.yml:24` cache/dizin varlığını yeterli kabul ediyor;
lockfile değişmiş olsa da kurulum atlanabiliyor. CI farklı dependency graph ile test çalıştırabilir.

Kurulum anahtarı lockfile digest'i ve Node/npm sürümüne bağlanmalı; uyuşmazlıkta `npm ci` zorunlu
olmalıdır.

#### ARIA-AUDIT-031 — P1 — Pre-push seçici nested invariant testlerini kaçırıyor

`scripts/ci/aria-suite-changed.mjs:113,145-165` eşleme kuralları nested/değişen bazı invariant
dosyalarını seçmiyor. Korunan yüzey değişirken ilgili test koşmadan push yapılabilir.

Seçim kaynak metni heuristiği yerine manifest/owner tabanlı olmalı ve “her korunan dosya en az bir
test seçer” kapsama testi bulunmalıdır.

#### ARIA-AUDIT-032 — P1 — Authority hash ve hook kapsamı etkin yüzeyleri eksik bırakıyor

`tools/gates/aria-authority-hash.ts:79-101`, `.husky/pre-commit:76-88`,
`scripts/ci/aria-suite-changed.mjs:45-54`, `.github/CODEOWNERS:19-40` ve
`tools/gates/aria-authority-hash.spec.ts:208-218` bazı aktif adapter, config ve acceptance
yüzeylerini authority kapsamına almıyor.

Tek bir canonical surface manifest hash, hook, CODEOWNERS ve test seçimini üretmelidir.

#### ARIA-AUDIT-033 — P0 — Banned-phrase adapter child exit 127'yi temiz sonuç yapıyor

`tools/aria-poc/banned_phrase_adapter.py:49-63,137-173` alt aracın bulunamaması/127 çıkışı halinde
sıfır bulgu üretebiliyor. Tarayıcı hiç çalışmadığı halde güvenlik kapısı temiz görünür.

Tool execution ile scan result ayrı typed durumlar olmalı; non-zero/parse hatası kapıyı
`unavailable/failed` yapmalıdır.

#### ARIA-AUDIT-034 — P0 — Outbox adapter okunamayan path'i görünmez yapıyor

`tools/aria-poc/outbox_adapter.py:172-194,211-221` erişilemeyen veya parse edilemeyen kaynakları
atlayıp kalan sonuçları temiz sayabiliyor. Eksik kapsam açıkça görünmüyor.

Beklenen kaynak manifesti ile okunan manifest eşleşmeli; tek bir unreadable kaynak bile
`incomplete` verdict üretmelidir.

#### ARIA-AUDIT-035 — P1 — Skill genesis artifact oluşmadan başarı verebiliyor

`aria-kernel/aria_kernel/convergent_skill_authoring.py:529,571` ve
`aria-kernel/aria_kernel/skill_genesis_drainer.py:281,299` materializer/artifact olmadan süreci
başarılı sonlandırabiliyor.

Başarı, content-addressed artifact'in varlığı, şeması, digest'i ve registry kaydı doğrulanınca
verilmelidir.

#### ARIA-AUDIT-036 — P2 — Yedi pre-merge kapısı uygulanmamışken kapasite tamamlanmış gösteriliyor

`aria-kernel/aria_kernel/implementation_safety.py:1824-1898` içindeki yedi kontrol
`_not_implemented` davranışında; `aria-kernel/aria_kernel/merge_authority.py:201-243` bunları
fail-closed blokluyor. Bu güvenlik bypass'ı değil, henüz olmayan kapasitenin bilinçli
containment'ıdır. Bulgu, `docs/aria/MISSION.md:212` ve
`docs/aria/runbooks/autonomy-unlock.md:60` ile readiness yüzeylerinin bunu tamamlanmış kapasite
gibi gösterebilmesidir.

Kapılar gerçek kanıt doğrulayıcılarıyla uygulanana kadar otomatik merge açıkça kapalı ve
gözlemlenebilir kalmalıdır.

#### ARIA-AUDIT-037 — P0 — PR gerçeği ve readiness kanıtı ayrışıyor

`aria-kernel/aria_kernel/ci.py:156-173,708-711,789-803`,
`aria-kernel/aria_kernel/auto_merge.py:241-245` ve
`aria-kernel/aria_kernel/readiness_proofs.py:1055-1072` diff/review/mergeable durumunu provider'dan
tam çekmeden readiness claim'i üretebiliyor.

Readiness yalnızca immutable PR head/base SHA, tam diff digest, required reviews/checks ve provider
mergeability snapshot'ına bağlı olmalıdır.

#### ARIA-AUDIT-038 — P1 — Causal bağlar ve merge sayıları güvenilir değil

`aria-kernel/aria_kernel/autonomy_orchestrator.py:1939,2127,2183` global queue/drain sonuçlarını
tekil implementation'a bağlamak yerine toplu tüketiyor ve gerçek provider sonucu olmadan merge
sayısı türetebiliyor. Testler bu sentetik sayımı
`aria-kernel/tests/test_autonomy_orchestrator.py:172,295` çevresinde sabitliyor.

Her olay cycle/mission/request/implementation/run/PR kimlik zincirini taşımalı; sayaç yalnız
provider-confirmed terminal olaydan projection ile üretilmelidir.

#### ARIA-AUDIT-039 — P2 — Legacy worker'ın `merged` durumu erişilemez

`aria-kernel/aria_kernel/autonomous_worker_scheduler.py:193` `merged` beklerken
`aria-kernel/aria_kernel/worker_dispatch_hook.py:327` bu durumu üretmiyor. İlgili completion yolu
ölü kalıyor.

Tek durum enum'u ve contract testi kullanılmalı; legacy yol kaldırılacaksa tüketici de
silinmelidir.

#### ARIA-AUDIT-040 — P1 — Yaşa dayalı reaper aktif işi reddedebiliyor

Implementation reaper yalnız elapsed age üzerinden karar veriyor; heartbeat/lease sahibi hâlâ
çalışırken işi terminal reject durumuna taşıyabilir. Otonomi testi yaklaşık
`aria-kernel/tests/test_autonomy_orchestrator.py:600` çevresinde bu davranışı
yeşil-pinliyor.

Fencing token, yenilenen lease ve provider job durumu olmadan reaping yapılamamalıdır.

#### ARIA-AUDIT-041 — P1 — External outage reaper üretim akışına bağlı değil

`aria-kernel/aria_kernel/external_outage_reaper.py:147` işlevi mevcut olsa da orchestrator
erişilebilirlik testi bu yolu çağıran üretim bağlantısını göstermiyor
(`aria-kernel/tests/test_external_outage_reaper.py:94-114` çevresi).

Dead feature ya bağlanıp uçtan uca test edilmeli ya kaldırılmalı; outage claim'i uygulanan state
transition olmadan yayınlanmamalıdır.

### Otonomi, karar ve yürütme semantiği

#### ARIA-AUDIT-042 — P2 — Agent-question protokolünde teslim/yanıt/devam mekanizması yok

`aria-kernel/aria_kernel/agent_question.py:163-220` yalnız kayıt yazıyor. Kullanıcıya teslim,
kimlik doğrulanmış yanıt, korelasyon, timeout ve bekleyen işi resume eden consumer yok.

Bu yapı sohbet değildir. Yeni serviste durable conversation/request state machine ve typed answer
command gerekir.

#### ARIA-AUDIT-043 — P1 — Model filosu beyanı gerçek executor kapasitesiyle uyuşmuyor

`aria-kernel/aria_kernel/model_fleet.py:53` birden çok provider/model tanımlıyor; gerçek yol
`tools/aria-poc/ci_executor.py:1178,2274` seviyesinde Claude CLI'ya bağlı. Fallback ve
çeşitlendirme claim'leri çalıştırılabilir kapasiteyi aşabilir.

Provider-neutral port, capability discovery ve her provider için canlı contract testi
zorunludur.

#### ARIA-AUDIT-044 — P0 — NaN ve boolean confidence kontrolleri aşabiliyor

`aria-kernel/aria_kernel/confidence.py:39`,
`aria-kernel/aria_kernel/judgment_bridge.py:244` ve
`aria-kernel/aria_kernel/feedback_store.py:519,838` Python sayı semantiği nedeniyle `NaN` ve
`bool` değerlerini geçerli confidence gibi işleyebiliyor.

`type(value) is float/int`, `math.isfinite` ve kapalı aralık kontrolü tek şema katmanında
uygulanmalıdır.

#### ARIA-AUDIT-045 — P1 — İki-judge precision settlement aynı modeli iki bağımsız rol sayıyor

`aria-kernel/aria_kernel/feedback_store.py:778-820,827-870` consensus'u `judge_id` ile tekilleştirip
model/provider çeşitliliğini precision settlement için aramıyor.
`aria-kernel/tests/test_feedback_ai_judge_consensus.py:122-134` evidence ve adversarial rollerini
aynı Claude modeliyle kurup iki-judge sonucunu precision settlement sayıyor. Bu sonuç ground-truth
ve kalıcı suppression yetkisi taşımaz; `aria-kernel/aria_kernel/feedback_store.py:164-192` anchor
için ayrı model çeşitliliğini doğru biçimde zorunlu kılar.

Precision/promotion oyu da model/provider trust domain'e göre tekilleştirilmeli; aynı modelin rol
tekrarları bir gözlem sayılmalıdır.

#### ARIA-AUDIT-046 — P1 — Phase-filter CLI kontrolü üretim döngüsüne bağlanmamış

`aria-kernel/aria_kernel/cli.py:2293-2298` seçeneği tanımlıyor ancak
`aria-kernel/aria_kernel/cli.py:5601` çağrısına aktarmıyor.
`aria-kernel/aria_kernel/autonomy_orchestrator.py:726-772,1278-1283` de alanı taşımıyor.
`aria-kernel/aria_kernel/cycle.py:634,682,709,735-740` bazı aşamaları filtrelerken `post_tool`
aşamasını atlıyor; observe/implement adları kayıtlarla da eşleşmiyor.

Tek enum ve uçtan uca plumbing testi olmalı; bilinmeyen veya uygulanmayan phase adı reddedilmelidir.

#### ARIA-AUDIT-047 — P1 — Mission closure çoğunlukla observe/logging, gerçek gate değil

Mission closure sonucu kaydediliyor fakat yürütme/merge kararını her üretim yolunda engellemiyor.
“Kapandı” kanıtı ile “kararı veto etti” davranışı ayrışıyor.

Closure verifier terminal transition'ın zorunlu precondition'ı olmalı; negatif uçtan uca test
merge çağrısının hiç yapılmadığını kanıtlamalıdır.

#### ARIA-AUDIT-048 — P1 — `implementation_ids` fused kimlik ve envelope dışında

`aria-kernel/aria_kernel/agent_invocations.py:1068-1088,1141,2777-2819` implementation
kimliklerini bazı olaylarda taşısa da fused identity/envelope digest'ine dahil etmiyor. Başka
implementation kanıtı yeniden bağlanabilir.

Cycle, request, implementation, attempt ve artifact kimlikleri imzalanan canonical envelope'un
zorunlu parçaları olmalıdır.

#### ARIA-AUDIT-049 — P1 — Architecture spine ve surface manifest farklı repository kökü buluyor

`aria-kernel/aria_kernel/architecture_spine_gate.py:245,451` ile
`aria-kernel/aria_kernel/surface_manifest_validator.py:381` repo/tools kökünü farklı kurallarla
çözüyor. Aynı çalışma alanı iki farklı korunan yüzey üretir.

Canonical workspace resolver tek shared port olmalı; tüm gate'ler resolved root id ve digest'i
kanıta koymalıdır.

#### ARIA-AUDIT-050 — P1 — Custom state remote desteklenirken repository identity `origin`'e sabit

`aria-kernel/aria_kernel/state_store.py:368-393,524,4524-4533` state remote'u
özelleştirebiliyor fakat repository kimliği ve bazı restore/publish bağları `origin` varsayıyor.
Yanlış repository/state eşleşmesi oluşabilir.

Code remote, state remote ve authority repository ayrı typed kimlikler olmalı; implicit `origin`
yasaklanmalıdır.

#### ARIA-AUDIT-051 — P1 — Workspace kimliği aynı repo için bölünebilir, forklar için çakışabilir

`aria-kernel/aria_kernel/workspace.py:28-66,92-131` URL case/biçim farklarıyla aynı GitHub
repository'sini farklı kimlik yapabiliyor; root-commit fallback ise forkları aynı kimliğe
indirgeme riski taşıyor. Test
`aria-kernel/tests/test_canonical_identity.py:64-72` dar bir canonical biçimi kapsıyor.

Provider repository id birincil kimlik olmalı; normalize URL yalnız görüntüleme/geri dönüş alanı
olmalıdır.

#### ARIA-AUDIT-052 — P1 — Promotion malformed/yanlış CWD validation ref'ini sıfır teste düşürüyor

`aria-kernel/aria_kernel/promotion_controller.py:222-234` doğrulama ref/path'lerini açık workspace
kökü yerine ambient CWD'den çözüyor; malformed dosyada da boş liste döndürüyor.
`aria-kernel/aria_kernel/verification_gate.py:176-182,287-297` boş command listesini güvenli kabul
edip `passed` üretebiliyor. Terminal auto-merge'e doğrudan erişim bu denetimde kanıtlanmadığı için
bulgu P1'dir, P0 değil.

Workspace root zorunlu immutable girdi olmalı; beklenen validator sayısı sıfırsa fail-closed
olmalıdır.

#### ARIA-AUDIT-053 — P2 — Autonomy status kanıtı foreign ambient CWD'ye bağlı

`aria-kernel/aria_kernel/cli.py:2438-2451,5774-5784` evaluator'a `Path.cwd()` geçiriyor.
`--tools-dir` repo A'ya bağlıyken CWD repo B veya non-repo ise yanlış repository değerlendirilip
yanlış `unavailable/mismatch` blocker üretilebilir. Aynı repository'nin alt dizini git top-level'e
çözüldüğü için tek başına bu vaka kusur değildir; mevcut
`aria-kernel/tests/test_cli_autonomy_subcommand.py:157-209` yalnız o dar yolu kapsıyor.

Tüm CLI girişleri canonical workspace context'i bir kez çözmeli ve alt katmanlara açıkça
iletmelidir.

#### ARIA-AUDIT-054 — P1 — Recursive-impact “known” sonucu heuristic ve stale cache'ten çıkıyor

`aria-kernel/aria_kernel/recursive_impact.py:106-130,180-263,441-505` eksik/stale cache ve metin
heuristic'leriyle etkiyi “known” sınıfına yükseltebiliyor. Test
`aria-kernel/tests/test_recursive_impact.py:325-340` bu dar olumlu yolu sabitliyor.

Cache, exact input graph digest'ine bağlanmalı; eksik düğüm veya parser belirsizliği
`unknown/incomplete` üretmelidir.

#### ARIA-AUDIT-055 — P0 — Glob kanıtında yalnız ilk beş dosya doğrulanıyor

`aria-kernel/aria_kernel/evidence_trust.py:245-293` glob kapsamındaki ilk beş eşleşmeyi inceleyip
sonucu tüm kümeye genelleyebiliyor. Test
`aria-kernel/tests/test_evidence_trust.py:44-57` küçük kümeyi kapsıyor.

Her eşleşme doğrulanmalı veya açıkça örneklenmiş, kapı için yetersiz kanıt olarak
sınıflandırılmalıdır.

#### ARIA-AUDIT-056 — P0 — Plan coverage witness ilgisiz dosyalarla sözleşmeyi kapalı gösteriyor

Plan witness üretimi `tools/gates/plan-coverage-witness.ts:291,360,416` çevresinde yeni
contract'ı gerçekten uygulamayan dosya/migration eşleşmelerini coverage kabul edebiliyor.
`tools/gates/plan-coverage-witness.spec.ts:151` semantik bağı kanıtlamıyor.

Coverage exact requirement → symbol/schema/test witness bağı içermeli; yalnız path veya token
eşleşmesi yeterli olmamalıdır.

#### ARIA-AUDIT-057 — P2 — Plan dokümanı invariant'ı `022` numarasında donmuş

`tests/invariants/aria-plan-doc-presence.spec.ts:38-74` belirli eski plan numarası/desenine bağlı.
Yeni planlar aynı yönetişim kuralını karşılasa da görünmeyebilir veya eski dosya sonsuza kadar
yeşil tutabilir.

Invariant güncel plan manifestinden türetilmeli; hard-coded sayı kaldırılmalıdır.

#### ARIA-AUDIT-058 — P1 — Readiness v2 üreticisi ile v3 tüketicisi kapanış boşluğu yaratıyor

`aria-kernel/aria_kernel/autonomy_evidence.py:1141-1150,3598-3625,3974-3979` ile
`aria-kernel/aria_kernel/readiness_proofs.py:1183-1208` farklı contract sürümleri bekliyor. Bir
producer'ın kabul ettiği kanıt diğer gate'te eksik veya yanlış yorumlanabilir.

Upcaster + tek canonical v3 şeması kullanılmalı; eski sürüm açık migration olmadan terminal
yetki üretmemelidir.

### Operasyon, gözlemlenebilirlik ve taşınabilirlik

#### ARIA-AUDIT-059 — P1 — Günlük rapor credential provenance'ı GitHub App diye hard-code ediyor

`.github/workflows/aria-daily-report.yml:247` provenance alanını App olarak sabitliyor;
`:270-283` gerçek token'ı App, Actions veya self-hosted runner PAT yolundan seçebiliyor. Denetim
kaydı gerçeği yanlış temsil ediyor; bu eşitliği çalışan bir workflow testi doğrulamıyor.

Credential-resolution tek bir non-secret `token_source` çıktısı üretmeli; hem preflight hem
mutating adım bunu tüketmelidir. Kaynak doğrulanamıyorsa mutating iş fail-closed durmalıdır.

#### ARIA-AUDIT-060 — P1 — İzlenen repository identity host `/tmp` yolunu sızdırıyor

`aria-tools/repo_identity.json:5` makineye özgü mutlak geçici dizini repository'de tutuyor.
`aria-kernel/aria_kernel/state_manifest.py:371-380` ve
`aria-kernel/tests/test_aria_tools_tracked_allowlist.py:64-80` bu sınıf alanı yeterince
engellemiyor.

Repository kimliği taşınabilir provider id/URL olmalı; runtime path hiçbir izlenen artifact'e
girmemelidir.

#### ARIA-AUDIT-061 — P2 — Executor auth preflight declared perimeter dışında hard-coded `/tmp` yazıyor

`.github/workflows/aria-agent-executor.yml:147-179` preflight'ta `RUNNER_TEMP` dış root olarak
açıkça allowlist ediliyor; bu bölüm doğrudur. Ancak `:349-355` Claude auth/version stdout ve
stderr'ini sabit `/tmp/aria-claude-auth.*` dosyalarına yazıyor. Bu küçük ama gerçek path,
job-scoped declared write-perimeter ve çakışmasız cleanup sözleşmesinin dışındadır.

`RUNNER_TEMP` altında job-id ile oluşturulmuş güvenli dizin kullanılmalı; artifact manifesti ve
cleanup açık olmalıdır.

#### ARIA-AUDIT-062 — P2 — Projection'lar tam ledger tarıyor, izlenen dashboard'lar stale

`aria-kernel/aria_kernel/observability.py:65-71,113-118`,
`aria-kernel/aria_kernel/finding.py:303-346` ve
`aria-kernel/aria_kernel/reflection.py:1080-1086` büyüyen JSONL defterlerini baştan tarıyor.
Repository'de izlenen rapor/panolar çalışma anındaki gerçeğin gerisinde kalabiliyor.

Dayanıklı offset/checkpoint projection store ve `as_of`/source digest zorunlu olmalıdır. İzlenen
snapshot canlı durum diye sunulmamalıdır.

#### ARIA-AUDIT-063 — P2 — `--challenger-timeout-seconds` CLI bayrağı ölü

`aria-kernel/aria_kernel/cli.py:2307-2316,5593-5617` değeri alıp
`aria-kernel/aria_kernel/autonomy_orchestrator.py:1691-1710` üzerinden
`aria-kernel/aria_kernel/convergence_drainer.py:481-508` yoluna taşıyor; drainer wait-free modele
geçtiği için değeri açıkça discard ediyor. Mevcut invariant testleri yalnız flag presence ve
forwarding'i doğruluyor, değer değişiminin davranış etkisini ölçmüyor.

Bayrak ve Protocol argümanı kaldırılmalı ya da açıkça deprecated/refused compatibility yüzeyi
yapılmalıdır; CLI etkisiz davranış seçeneği sunmamalıdır.

#### ARIA-AUDIT-064 — P1 — Retention kaynağı eksikken sessizce kısmi başarı veriyor

`aria-kernel/aria_kernel/runtime_artifacts.py:620-627` kaynak bulunamadığında atlayabiliyor.
`docs/aria/runbooks/runtime-retention.md:22-24` ve
`aria-kernel/tests/test_runtime_artifacts.py:167-190` arşiv-önce davranışını anlatsa da
eksik kaynak için fail-closed toplamlık kanıtı yok.

Beklenen artifact manifesti eksiksiz doğrulanmalı; `missing` terminal olmayan açık hata olmalıdır.

#### ARIA-AUDIT-065 — P1 — Approval şemaları bilinmeyen alanları kabul ediyor

Onay/provenance envelope şemalarının bazıları `additionalProperties` benzeri açık davranış
gösteriyor. Yanlış yazılmış veya saldırgan kontrollü alanlar imzalanan/yorumlanan payload ile
tüketicinin kullandığı payload'ın ayrışmasına yol açabilir.

Canonical serialization ve `extra = forbid` uygulanmalı; tüm tüketiciler aynı şema sürümünü
kullanmalıdır.

#### ARIA-AUDIT-066 — P2 — Agent surface durum sözlüğü drift etmiş

Üretici ve tüketiciler `EXPIRED` ile farklı lowercase/terminal state sözlükleri kullanıyor.
Timeout/expiry olayları bazı projection veya gate'lerde görünmez ya da yanlış terminal kabul
edilebilir.

Tek enum/JSON Schema ve contract testleri kullanılmalıdır.

#### ARIA-AUDIT-067 — P2 — ARIA debt kayıtları stale ve kapanış gerçeğini yansıtmıyor

İzlenen debt/plan/checklist kayıtlarında uygulanmış, terk edilmiş ve hâlâ açık maddeler aynı
görünürlükte kalıyor. Bu durum hem insan hem otomatik planlayıcı için yanlış öncelik sinyali
üretiyor.

Debt kayıtları owner, source digest, last-verified-at ve typed lifecycle ile düzenli reconcile
edilmelidir.

#### ARIA-AUDIT-068 — P2 — Kaynak metni invariant'ları davranış yerine ifadeyi green-pinliyor

Bazı invariant testleri belirli fonksiyon adı, yorum veya kaynak metni arıyor; semantik davranışı
çalıştırmıyor. Somut örnekler:

- `aria-kernel/tests/invariants/v10/test_phase_v10_5_phase_6_evaluate_plan_response_ssot.py:217`
  gerçek runtime kurulumu hata verirse source substring fallback ile yeşil kalabiliyor.
- `aria-kernel/tests/invariants/v7/test_phase_v7_4_skill_genesis_drainer.py:149` tüm exception'ları
  yutuyor; sıfır invocation da başarı olabiliyor.
- `aria-kernel/tests/test_agent_invocations_lease_expiry.py:134` “submit accepts” iddiasında lease
  dışındaki rejection'ları da kabul ediyor.

Kod aynı güvenlik açığını başka ifadeyle koruyabilir ya da doğru refactor sırf metin değişti diye
kırılabilir.

Güvenlik invariant'ları negatif davranış ve black-box sonuç testleri olmalıdır.

#### ARIA-AUDIT-069 — P3 — Nx/TypeScript/Rust varsayımları çekirdeğe gömülü

Discovery, etki ve plan kanıtı yolları bu repository'nin Nx, TypeScript ve Rust yapısını doğrudan
varsayıyor. ARIA başka repository'ye taşındığında çekirdek davranışı adaptör değişimiyle
sınırlandırılamıyor.

Dil/build-system bilgisi capability adaptörlerine taşınmalı; çekirdek yalnız normalize edilmiş
graph ve kanıt contract'ları görmelidir.

#### ARIA-AUDIT-070 — P3 — Mock agent eval yalnız harness sağlığını ölçüyor

`aria-kernel/aria_kernel/agent_eval.py:247-301` mock response'u fixture'daki beklenen verdict ve
evidence'i geri kopyalıyor; bu nedenle sonuç model kalitesi değil pipeline/schema sağlığıdır.
`:603-625` ve `.github/workflows/aria-agent-eval.yml:154-188` mock akışını `mock_mode=true` ile
gerçek akıştan doğru biçimde ayırır. Doğrulanmış bir stream karışması yoktur; bulgu, mevcut
scheduled eval'in gerçek kalite kanıtı üretmeyen açık kapasite sınırıdır.

Mock stream korunup yalnız harness health diye sunulmalı; model quality için pinlenmiş gerçek eval
seti, provider/model provenance ve `real_run_count > 0` gerekir.

#### ARIA-AUDIT-071 — P2 — Watchdog emission cap kritik kayıtları düşürebiliyor

Watchdog üretimi cap ve best-effort ham yazım kullanıyor. Limit aşıldığında hangi kritik olayların
düştüğü ve yeniden oynatılacağı güvenilir biçimde kayıtlı değil.

Öncelikli durable outbox, dropped-count ve replay cursor kullanılmalıdır.

#### ARIA-AUDIT-072 — P3 — Mevcut state biçimi taşınabilir servis deposu değil

Yaklaşık 881 MB yerel JSONL/Markdown state; path, git remote ve repository checkout bağlamına
sıkıca bağlıdır. Atomik sorgu, cursor, tenant izolasyonu, şema migration ve yatay worker
koordinasyonu sağlamaz.

Yeni servis PostgreSQL `aria` şeması, outbox ve content-addressed artifact store kullanmalı; eski
state yalnız doğrulanan importer ile okunmalıdır.

#### ARIA-AUDIT-073 — P3 — Ürün API'si, canlı sonuç kanalı ve web arayüzü yok

Etkin ARIA yüzeyinde HTTP/GraphQL/WebSocket/SSE sunucusu ya da kullanıcı arayüzü bulunmadı. CLI,
workflow summary, JSON ve Markdown çıktıları ürün etkileşimi yerine geçmiyor.

Bu bir regresyon değil, kullanıcının hedefi için eksik ürün yüzeyidir. Yeni servis ayrı API ve
mikro-frontend sağlamalıdır.

#### ARIA-AUDIT-074 — P3 — Soru defteri konuşma sistemi değil

`aria-kernel/aria_kernel/agent_question.py` soruyu durable bir kullanıcı oturumu, teslim durumu,
yanıt yetkisi ve resume token'ı olmadan kaydediyor. Serbest biçimli sohbetin mevcut ARIA'da
özellikle sınırlandığı yerler de vardır.

Yeni UI'da sohbet okuma/açıklama/öneri için kullanılmalı; etkili eylemler typed command ve exact
signed approval üzerinden yürümelidir.

#### ARIA-AUDIT-075 — P2 — Acceptance alt sistemi authority manifestinde eksik

`tools/aria-acceptance/**` gerçek release/operasyon kararına etki ettiği halde authority/surface
manifest ve hook seçicilerinin tamamında birinci sınıf korunan yüzey değil. Harness değişikliği
gerekli inceleme ve testleri tetiklemeyebilir.

Acceptance kodu canonical surface manifestine eklenmeli; owner/hash/test seçimi buradan
üretilmelidir.

#### ARIA-AUDIT-076 — P1 — Authority preflight gerçek yetkiyi kanıtlamıyor

Preflight kontrolleri çoğunlukla araç sürümü ve credential varlığına bakıyor; token'ın repository,
action, permission, expiry ve actor bağını provider'dan doğrulamıyor.

Her etkili işlem öncesi exact capability introspection yapılmalı ve sonucu immutable action
envelope'una bağlanmalıdır.

#### ARIA-AUDIT-077 — P2 — JSONL full-scan okuma modeli web sorguları için deterministik değil

Aynı defter farklı projection zamanlarında farklı gecikme ve kısmi görünüm üretebilir; cursor ve
`as_of` sözleşmesi yoktur. Bu yapı sonuç listesi, canlı run ekranı ve sohbet bağlamı için güvenilir
bir query API sağlayamaz.

Yeni sistem command store ile query projection'ı ayırmalı; her yanıtta projection offset'i ve
kaynak sürümü bulunmalıdır.

#### ARIA-AUDIT-078 — P1 — Production memory hook eksik argümanla her converged cycle'da düşüyor

**Kanıt/kök neden:** `aria-kernel/aria_kernel/cycle_phases/memory.py:50-69`
`MemoryHook.record` için `converged_plan` alanını zorunlu kılıyor.
`aria-kernel/aria_kernel/autonomy_orchestrator.py:1859-1871` production çağrısında bu alanı
vermiyor; oluşan `TypeError` `:1888-1899` içinde yakalanıp cycle devam ettiriliyor. Sonuç,
convention/learning ve skill-genesis memory kaydının sessizce çalışmamasıdır.

**Test boşluğu:** Kaynak-metni/injection testleri fonksiyonun varlığını sabitliyor; gerçek
production `MemoryHookImpl` ile converged orchestrator çağrısını çalıştıran uçtan uca negatif test
yok.

**En dar düzeltme/invariant:** Convergence'ın doğrulanmış plan payload'ı açıkça
`converged_plan=...` olarak geçirilmeli. Converged production cycle, memory sonucu
`recorded/refused` terminal durumuna ulaşmadan başarı sayılmamalı; signature drift contract testi
ile yakalanmalıdır.

#### ARIA-AUDIT-079 — P0 — Adversarial review kabul edilmiş herhangi bir sonucu koşulsuz `no_gaps` yapıyor

**Kanıt/kök neden:** `aria-kernel/aria_kernel/review_runner.py:268-355` doğru request/role'a bağlı
accepted sonucu bekliyor; ancak `:357-374` accepted payload'ın verdict, gaps, satisfaction veya
kanıt içeriğini parse etmeden doğrudan `verdict="no_gaps"` döndürüyor. Teslim kanıtı ile semantik
review kararı karıştırılmıştır.

**Test boşluğu:** Role/request binding testleri vardır; accepted fakat `gaps_open` diyen, malformed
veya boş payload'ın merge'i bloke ettiğini gösteren negatif oracle yoktur.

**En dar düzeltme/invariant:** Kapalı review-response şeması parse edilmeli; `no_gaps` yalnız
bağımsız judge'ın açık verdict'i ve doğrulanmış evidence refs ile üretilebilmelidir. Transport
acceptance hiçbir zaman semantic verdict yaratamaz.

#### ARIA-AUDIT-080 — P1 — Change outcome ve learning aggregate crash-atomic değil

**Kanıt/kök neden:** `aria-kernel/aria_kernel/change_outcome.py:606-618` outcome satırını önce,
öğrenme aggregate'ini sonra yazıyor. İki işlem arasındaki crash'ten sonra retry,
`:573-576` mevcut outcome'u bulup erken dönüyor; aggregate kalıcı olarak eksik kalıyor. Yorum
double-count yerine undercount'u bilinçli seçmiş olsa da reconcile yolu yoktur.

**Test boşluğu:** İdempotent tekrar testi vardır; iki append arasına enjekte edilen crash ve
sonraki retry/reconciliation testi yoktur.

**En dar düzeltme/invariant:** Outcome olayı tek authoritative yazım olmalı; aggregate idempotent
projection/cursor ile yeniden kurulmalıdır. Her outcome id, projection checkpoint'inde tam bir kez
hesaba katılmalıdır.

#### ARIA-AUDIT-081 — P1 — Critical-observation görüntüsü corruption ve yarışta fail-open

**Kanıt/kök neden:** `aria-kernel/aria_kernel/critical_observation.py:71-83` ID'yi
scan-then-write ile ayırdığı için paralel yazarlar aynı ID'yi seçebilir. `:197-212` bozuk dosyayı
sessizce atlıyor; `:282-298` parse edilemeyen tarihi `within_sla` kabul ediyor. Bozulma en düşük
aciliyet görünümüne dönüşür.

**Test boşluğu:** Atomik tek dosya yazımı test edilse de paralel ID allocation, corrupt record ve
malformed SLA tarihi için fail-closed listeleme/escalation testi yoktur.

**En dar düzeltme/invariant:** Kimlik çakışmasız UUID/ledger sequence olmalı; listeleme bozuk
kayıtta `incomplete` üretmeli; tarih parse edilemiyorsa en az `unknown/escalate` olmalıdır.

#### ARIA-AUDIT-082 — P1 — Operator dashboard corruption'ı boş/temiz bölüme çeviriyor

**Kanıt/kök neden:** `aria-kernel/aria_kernel/reflection.py:222-235` repository identity parse
hatasını “binding yok” durumuna indiriyor. `:1089-1097,1209-1218` dahil renderer'lar geniş
`except Exception` ile ilgili bölümü tamamen saklıyor. Operator, bozuk ledger ile gerçekten boş
ledger'ı ayırt edemiyor.

**Test boşluğu:** Missing-ledger'ın sessiz görünümü test ediliyor; corrupt-ledger'ın görünür
`unavailable/corrupt` banner ve non-green health üretmesi test edilmiyor.

**En dar düzeltme/invariant:** Her bölüm typed `ok|empty|missing|corrupt|unavailable` projection
sonucu döndürmeli. `corrupt/unavailable` UI ve daily report'ta gizlenemez.

#### ARIA-AUDIT-083 — P2 — Validation ledger host dosya yoluna bağlı

**Kanıt/kök neden:** `aria-kernel/aria_kernel/validation_runs_ledger.py:279-305` runner'ın doğrudan
`log_path` değerini deftere yazıyor; `:328-350` doğrulamada aynı host path'i yeniden açıyor.
State başka worktree/host'a taşınınca hash doğru olsa bile kanıt bulunamaz.

**Test boşluğu:** Aynı filesystem'de log re-hash testi vardır; state bundle'ı başka köke
restore edip doğrulayan taşınabilirlik testi yoktur.

**En dar düzeltme/invariant:** Log content-addressed artifact store'a kopyalanmalı; ledger yalnız
artifact id, digest, size ve media type taşımalıdır. Doğrulama mutlak üretici path'ine bağlı
olmamalıdır.

#### ARIA-AUDIT-084 — P1 — Runtime-signal store corruption ve crash altında güvenli değil

**Kanıt/kök neden:** `aria-kernel/aria_kernel/runtime_signal_bridge.py:79-83` bozuk mevcut kaydı
diagnostic/quarantine olmadan overwrite ediyor; `:101-107` atomic replace/fsync olmadan dosya
yazıp sonra governance event'i ekliyor. `:111-126` bozuk kayıtları sessizce atlıyor. Crash,
signal dosyası ile governance olayı arasında iki yönlü tutarsızlık yaratabilir.

**Test boşluğu:** Temiz idempotency kapsanıyor; truncated dosya, write/governance arası crash ve
concurrent ingest fault-injection testi yoktur.

**En dar düzeltme/invariant:** Signal authoritative append-only ledger/outbox içinde atomik
yazılmalı; projection dosyaları yeniden üretilebilir olmalıdır. Bozuk kayıt overwrite edilmeden
quarantine + visible refusal gerekir.

#### ARIA-AUDIT-085 — P0 — Artifact credential scrubber env-assignment secret'larını sızdırıyor

**Kanıt/kök neden:** `aria-kernel/aria_kernel/artifact_safety.py:10-15,26-30` raw regex içinde
`=\\S+` kullanıyor; bu desen whitespace olmayan değeri değil, literal backslash/`S` biçimini arıyor.
Kontrollü çağrıda `OPENAI_API_KEY=topsecret` ve `ARIA_LEASE_TOKEN=topsecret` değişmeden kaldı.
`aria-kernel/aria_kernel/secret_scrub.py:24-35` ayrı ve farklı bir secret politikası taşıdığı için
iki scrubber drift etmiştir.

**Test boşluğu:** `aria-kernel/tests/test_scrub_credentials_not_counters.py:43-49` yalnız `sk-`
değerini sınar; adlandırılmış env assignment sınıfları yoktur.

**En dar düzeltme/invariant:** Regex doğru `\S+` olmalı ve iki scrubber tek merkezi politikada
birleştirilmelidir. Sanitized artifact; API key, lease token, bearer ve provider credential
fixture'larının hiçbirini byte-for-byte içeremez.

#### ARIA-AUDIT-086 — P1 — Feedback batch sample'ı tamamlamıyor ve atomik değil

**Kanıt/kök neden:** `aria-kernel/aria_kernel/feedback_store.py:610-668` verdict'leri tek tek
append ediyor. `:669-672` `stored_sample["status"]="recorded"` yapıp bu nesneyi hiç
kalıcılaştırmıyor. `:977-1014,1331-1335` aynı sample'ı `pending` olarak bulmaya devam ediyor;
replay duplicate satır, orta-batch hata partial commit üretir.

**Test boşluğu:** `aria-kernel/tests/test_incremental_learning.py:353-381` sayı/fingerprint
sonucunu kapsıyor; sample terminal durumu, replay idempotency ve N'inci append fault injection
testi yoktur.

**En dar düzeltme/invariant:** Batch tek lock/transaction altında, `sample_id + item key`
idempotency ile yazılmalı ve sample için kalıcı terminal event üretilmelidir. Retry aynı sonucu
döndürmeli, yeni feedback satırı eklememelidir.

#### ARIA-AUDIT-087 — P1 — Test-gap alias keşfi bozuk/JSONC tsconfig'i `alias yok` sayıyor

**Kanıt/kök neden:** `tools/aria-adapters/test-gap-adapter.ts:386-405` `tsconfig.base.json`
içeriğini plain `JSON.parse` ile okuyor ve her parse hatasında `[]` döndürüyor. TypeScript'in
geçerli JSONC biçimi veya bozuk config, eksik alias etkisini verified-empty gibi gösterebilir.

**Test boşluğu:** Comment/trailing-comma içeren geçerli JSONC ve malformed config için typed
`incomplete` regresyonu yoktur.

**En dar düzeltme/invariant:** TypeScript'in canonical config parser'ı kullanılmalı; missing,
invalid ve empty ayrı sonuç olmalı. Parse edilemeyen dependency config hiçbir zaman “etki yok”
kanıtı olamaz.

#### ARIA-AUDIT-088 — P2 — Commit validator ref ve trailer path sınırını güvenli kurmuyor

**Kanıt/kök neden:** `tools/gates/commit-msg-validator.ts:329-338,416-418` base/head ref'lerini
`execSync` shell stringine gömüyor. `:488-497` non-ARIA trailer path'ini canonical repository
containment olmadan `resolve/exists` ile kontrol ediyor. Mevcut CI'nin SHA-derived girdileri
exploit olasılığını azaltır; yine de yardımcı port güvenli ve taşınabilir değildir.

**Test boşluğu:** `tools/gates/commit-msg-validator.spec.ts:33-44` Git entegrasyonunu açıkça kapsam
dışı bırakır; shell metacharacter/ref ve `../`/absolute trailer path fixture'ı yoktur.

**En dar düzeltme/invariant:** `execFileSync("git", argv)` kullanılmalı, refs
`git check-ref-format`/SHA politikasıyla doğrulanmalı ve trailer path canonical repo-relative,
registry kaydıyla birebir bağlı olmalıdır.

## Kontrollü reprodüksiyonlar ve temel test sonucu

2026-09-01'de `d0afe…` worktree'sinden
`PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=aria-kernel:aria-kernel/tests python3` ile, yalnız
`tempfile` dizinleri kullanan inline fixture üzerinde dört davranış tekrarlandı:

| Bulgu            | Fixture / çağrı                                                                                                                 | Gözlenen çıktı                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `ARIA-AUDIT-085` | `artifact_safety.scrub_text("OPENAI_API_KEY=topsecret ARIA_LEASE_TOKEN=lease-secret")`                                          | `openai_secret_survived=true`, `lease_secret_survived=true` |
| `ARIA-AUDIT-012` | `TransitionGateTests._shadow_tool()` ardından `transition_tool(..., panel_approval_token="forged-panel-token")`                 | `status="ACTIVE"`                                           |
| `ARIA-AUDIT-002` | `StateCompactTests` fixture'ı, `compact_state(..., retain_days=7)` ve `raw_findings` gzip arşivi                                | `old_rows=10`, `all_original_findings_preserved=false`      |
| `ARIA-AUDIT-011` | 30 günlük `completed` dispatch satırında repo dışı mutlak geçici victim path, ardından `prune_worktrees(..., acknowledge=True)` | `out_of_repo_victim_exists_after=false`, `pruned_count=1`   |

Geçici victim ve state dizinleri komut sonunda temizlendi; gerçek checkout/state hedeflenmedi.

Tabandaki şu hedefli testler birlikte çalıştırıldığında 22 test geçti:
`aria-kernel/tests/test_state_compact.py`,
`aria-kernel/tests/test_auto_promote_token_verification.py` ve
`aria-kernel/tests/test_worker_dispatch_primitives.py`. Geçen testler kusurları çürütmüyor;
tersine mevcut
regresyon kapsamının bu davranışları yakalamadığını gösteriyor.

`npm run findings:verify` tabanda başarılı oldu: registry 1.438 geçerli kayıt içeriyor ve zincir
ucu `cc492699…`. Bu yalnız mevcut bulgu defterinin biçim/zincir doğrulamasıdır; yukarıdaki çalışma
zamanı bulgularını kapatmaz.

## Birincil checkout'ta denetim sırasında gözlenen dış WIP

Denetimin ilk bölümünde ana checkout `fix/aria-kernel-security-defects` dalında ve bu denetimden
bağımsız, commitlenmemiş değişiklikler taşıyordu. Denetim worktree'si bu dosyalara yazmadı.
Denetim tamamlanmadan dış bir işlem ana checkout'u detached `d0afe…` durumuna döndürdü; aşağıdaki
diff'ler ve untracked test artık görünmüyor. Bu bölüm mixed-tree sırasında yapılan tarihsel
incelemeyi korur, güncel WIP varlığı iddia etmez. O sırada görülen ilgili dosyalar:

- `aria-kernel/aria_kernel/promotion_veto.py`
- `aria-kernel/aria_kernel/state_compact.py`
- `aria-kernel/aria_kernel/tool_registry.py`
- `aria-kernel/aria_kernel/worker_dispatch.py`
- ilgili iki izlenen test ve birincil checkout'taki untracked worktree-prune containment testi

Bu WIP şu nedenlerle çözülmüş kabul edilmedi:

- `aria-kernel/aria_kernel/state_compact.py` içindeki yeni
  `_archive_stripped(root, surface, stripped_rows)` imzasına ham
  findings çağrısı hâlâ dört argüman gönderiyor; yol çalıştığında `TypeError` üretir.
- Worker patch'i yolu repository içinde tutuyor fakat hedefin kayıtlı `git worktree` olduğunu
  doğrulamıyor, `git worktree remove` sonucunu fail-closed ele almıyor ve raw recursive silmeyi
  sürdürüyor. Yeni test yalnız `.worktrees/wt-1` adlı sıradan bir dizini meşru worktree varsayıyor.
- Panel token consume/verification değişikliği commitlenmediği ve tam regresyonu henüz
  doğrulanmadığı için `ARIA-AUDIT-012` kapalı değildir.
- Bundan bağımsız `ARIA-AUDIT-013` kusuru olan path'ten türetilen forgeable auto-promote HMAC
  güven kökü yerinde kalıyor.

Bu değişiklikler kullanıcıya aitti; denetim worktree'si bunları audit commit'ine katmadı.

## Bilinçli kısıtlar ve kusur olmayan gözlemler

- Nightly scheduler'ın otomatik yetki vermemesi bilinçli sıkılık olabilir.
- Auto-merge'in kapalı ve bazı merge gate'lerinin placeholder olması güvenli başlangıç olabilir;
  kusur, doküman/readiness claim'lerinin bunu tamamlanmış kapasite gibi göstermesidir.
- Mock eval'ın mock olması tek başına hata değildir ve akışlar mevcut kodda ayrıdır; kapasite
  sınırı, scheduled mock ölçümünün gerçek model kalitesi kanıtı üretememesidir.
- Malformed envelope'u `refused/partial` olarak kalıcılaştırıp sıfır exit ile raporlamak, üst
  workflow typed verdict'i zorunlu okuyorsa kabul edilebilir.
- Retention'ın archive-first ve delete-disabled olması bilinçli güvenlik tercihidir; eksik kaynakta
  sessiz başarı ayrı bulgudur.
- Mevcut sistemde sohbet bulunmaması eski tasarımın regresyonu değil, yeni ürün hedefinin
  gereksinimidir.

## Henüz doğrulanmamış riskler

Aşağıdakiler kaynak denetiminde şüpheli bulundu ancak canlı/dinamik kanıt olmadan doğrulanmış kusur
sayılmadı:

- GitHub branch-protection ve Actions permission'larının kaynak claim'leriyle gerçekten eşleşmesi.
- `target_agent` alanının dinamik/doğrudan çağrılarda yanlış aktöre yönelme ihtimali.
- Judgment/feedback bridge retry'larının dış yan etkileri iki kez üretme ihtimali.
- Retention işlemlerinin crash-retry altında tam idempotent olup olmadığı.
- Barındırılan runner credential'larının gerçek provider TTL ve permission kapsamı.
- Deklare edilen ikincil model provider'larının canlı ortamda ayrıca bağlanıp bağlanmadığı.

Bu riskler provider sandbox veya staging üzerinde fault-injection ve canlı contract testi
gerektirir.

## Düzeltme sırası

### Dalga 0 — Yıkıcı ve forgeable yolları kapat

`ARIA-AUDIT-011`, `012`, `013`, `014`, `015`, `017`, `023` ve `085`. Önce yetkiyi kapatan
fail-closed feature flag/guard; ardından gerçek kök neden düzeltmesi ve negatif regresyon testi.

### Dalga 1 — Sessiz veri kaybı ve sahte yeşil sonuçları kaldır

`ARIA-AUDIT-001`–`010`, `021`, `022`, `024`–`029`, `033`, `034`, `037`, `044`, `052`,
`055`, `056`, `079`, `081`, `082`, `084`, `086` ve `087`.

### Dalga 2 — Otonomi ve yaşam döngüsünü doğrula

`ARIA-AUDIT-016`, `018`, `019`, `030`–`032`, `035`, `036`, `038`–`051`, `053`–`058`,
`064`, `065`, `075`, `076`, `078`, `080` ve `088`.

### Dalga 3 — Operasyon ve ürünleşme

`ARIA-AUDIT-059`–`063`, `066`–`074`, `077` ve `083`.

Her düzeltmenin kapanış ölçütü:

1. Resmi bulgu registry kimliği ve `Closes:` izlenebilirliği.
2. Önce başarısız olan minimal regresyon testi.
3. Root-cause düzeltmesi; caller-side bypass veya yalnız mock düzeltmesi değil.
4. Negatif güvenlik testi ve mümkünse process/concurrency fault injection.
5. İlgili invariant, lint, type-check ve hedefli testlerin temiz sonucu.
6. Kod içi açıklama yalnız güven sınırı/invariant nedenini anlatmalı; bulgu listesini TODO olarak
   koda kopyalamamalıdır.

## Yeni taşınabilir ARIA için önerilen sınır

### Bileşenler

- `apps/aria-service`: NestJS uygulaması; domain çekirdeği framework'ten bağımsız saf TypeScript.
- `apps/aria-service/src/core`: run, task, finding, evidence, approval, conversation ve artifact
  state machine'leri.
- `apps/aria-service/src/ports`: model provider, git provider, sandbox executor, artifact store,
  event bus, clock ve identity portları.
- `apps/aria-service/src/adapters`: GitHub/Git, provider worker ve eski ARIA salt-okunur importer.
- PostgreSQL `aria` şeması: command/state ve projection tabloları; entity'lerde açık
  `schema: 'aria'`.
- Durable inbox/idempotency ledger, lease + fencing token, effect journal ve retry/reconciliation
  worker'ları. Transactional outbox tek başına uzun süren workflow'u crash-safe yapmaz.
- Transactional outbox ve `@platform/event-bus` üzerinden NATS; kimlik yalnız mTLS
  sertifikasından, payload tenant/actor alanından değil.
- MinIO/content-addressed store: log, diff, rapor ve büyük kanıtlar; tenant ACL, encryption,
  retention ve DLP metadata'sı zorunlu.
- `web/modules/aria`: shell'e federated remote; aynı API ile standalone geliştirme modu.
- OpenTelemetry trace/metric/log korelasyonu: run, attempt, provider call, token/maliyet, queue
  depth, stuck-job ve SLO ölçümleri aynı correlation chain'i taşır.

### Domain ve yetki invariant'ları

- Sonuç state machine'i en az `accepted`, `running`, `completed`, `failed`, `partial`, `refused`
  ve `unreadable` durumlarını; phase, attempt, provider ve evidence grade alanlarını ayırır.
- Executor yalnız artifact/effect sonucu üretir. Satisfaction, judge, policy ve approval farklı
  principal/port'lardır; transport normalizer semantic verdict üretemez.
- Tenant ve workspace her entity/query/command'da server-side scope edilir. Actor authn/authz,
  RBAC/capability ve PostgreSQL row-level sınırı birlikte test edilir.
- Signed approval; exact payload digest, subject, action, audience, workspace, nonce, issued-at,
  expiry ve key id taşır. Replay engeli, key rotation ve yüksek riskte dual-control uygulanır.
- Provider adaptörü capability discovery, timeout/cancel, quota, çağrı öncesi maliyet rezervasyonu
  ve provider/model provenance contract'ını uygular.

### API ve kullanıcı deneyimi

- GraphQL query/mutation: run'lar, görevler, bulgular, kanıtlar, planlar ve onaylar.
- WebSocket veya gateway üzerinden canlı run/event akışı.
- Her liste/stream cevabı `projection_offset`, `as_of` ve source version taşır; reconnect aynı
  cursor'dan idempotent devam eder.
- Sonuç ekranı: ARIA'nın neyi çözdüğü, hangi kanıtla karar verdiği, maliyet/süre, diff ve terminal
  verdict.
- Konuşma ekranı: geçmişe bağlı soru-cevap, açıklama ve öneri. Sohbet metni doğrudan etkili eylem
  çalıştırmaz.
- Etkili eylemler typed mutation, exact payload özeti ve ayrı signed approval ister.
- Repository içeriği untrusted prompt girdisidir. Tool allowlist, prompt-injection sınırı,
  action preview/confirm, cancel/resume ve konuşma retention/redaction politikası UI ile API'da
  aynı sözleşmeyle uygulanır.

### Geçiş

1. Eski ARIA state'i için yalnız salt-okunur importer yaz. Importer schema version/upcaster,
   tam chain verification, deterministic dedupe, quarantine ve checkpoint/resume uygular;
   approval, token veya authority grant hiçbir zaman import edilmez.
2. Yeni servisi kendi veri deposu ve event namespace'iyle ayağa kaldır; eski koda import bağı
   ekleme.
3. Aynı fixture/run girdilerinde shadow çalıştır; verdict, artifact, maliyet ve süre için sayısal
   kabul eşikleri ve abort ölçütleriyle parity raporla.
4. UI'ı yalnız yeni API'ya bağla.
5. PostgreSQL migration'larını disposable veritabanında up → schema assertion → down → up ve
   metadata/schema diff ile doğrula.
6. Kesim anında writer fence/epoch yayınla, eski writer'ları durdur, son doğrulanmış checkpoint'i
   içe al, count/digest reconciliation yap ve tek yazarı yeni servis yap.
7. Parity veya reconciliation eşiği bozulursa önceden tanımlı abort/rollback uygula.
8. Geri dönüş süresi ve arşiv doğrulaması tamamlandıktan sonra eski ARIA'yı ayrı bir değişiklikle
   kaldır.

Çift yazım önerilmez: iki farklı ledger ve kimlik modeli arasındaki kısmi başarısızlıklar
uzlaştırılamayan otorite yaratır.

## Uygulama kararı

Bu rapor eski ARIA'ya yeni UI veya API eklenmesini önermiyor. Güvenli yol, eski sistemi önce P0/P1
operasyonel riskler açısından emniyete almak; yeni ARIA'yı ayrı bounded context olarak kurmak ve
eski sistemi yalnız migration/reference kaynağı olarak kullanmaktır. Yeni servis tasarımı
onaylanmadan davranış kodu yazılmamalıdır.
