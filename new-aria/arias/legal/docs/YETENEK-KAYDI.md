# Hukuk ARIA'sı — Yetenek Kaydı

Durum: ÖLÇÜM (2026-09-04). `docs/TANIM.md` kapsamı, `docs/YOL-HARITASI.md` sırayı tanımlar;
bu belge **bugün ne olduğunu** ve **ne eksik olduğunu** kanıtıyla sayar. Kod, bu belgede
adı ve kabul testi olmayan bir eksik için yazılmaz.

## 0. Yöntem ve durum sözlüğü

Ölçüm, çalışan koddan yapıldı; bir modülün var olması "çalışıyor" sayılmadı. Bu ayrım
ARIA'nın kendi en sık kusur sınıfıdır (mekanizma var, çağıran yok) ve bu kayıtta tekrar
etmesine izin verilmedi.

| Durum | Anlamı |
|---|---|
| `wired` | Üretim yolu buraya ulaşıyor; hukuk örneği bugün bunu alıyor |
| `partial` | Ulaşılıyor ama yeteneğin bir kısmını kapsıyor |
| `not_wired` | Modül var ve testli; üretim yolunda çağıran yok |
| `absent` | Yok |

"Üretim yolu" kanıtı şunlardan biridir: `cli.py` alt komutu (satırıyla), `cycle.py`
`CYCLE_PHASES` fazı (satırıyla), executor yolu, `ui/server/src/routes.ts` rotası, ya da
koşturulan ve çıktısı gösterilen bir komut. Grep gözlemdir, kanıt değildir. Yalnız
testlerden çağrılan kod `not_wired`'dır.

Her `wired` iddiası bağımsız ikinci bir ajan tarafından çürütülmeye çalışıldı: çağrı
zinciri yalnız testlerden geçiyorsa, hiçbir hukuk örneğinin açmayacağı bir profil
gerektiriyorsa (`arias/legal/aria.manifest.json`: `profile_ceiling: standard`,
`allow_actions: false`) veya bir git külliyatı gerektiriyorsa durum düşürüldü.

Ölçüm dört alanda yapıldı: A1 kanıt ve köken, A2 yargı ve doğrulama, A3 güvenlik ve
insan sınırı, A4 hukuk kası ve operatör yüzeyi. Kutu yeniden başladığı için A3 ve A4
ikinci turda ölçüldü; bu belgenin o iki bölümü o tur bitince dolar ve başlıkta işaretlidir.

## 0.1 Kimlik şeması ve düzeltilen çakışma

Çekirdek boşluğu kimlikleri (`G-*`) için tek kaynak
`docs/product/NEW-ARIA-URUN-TANIMI.md` §3.1 ve `docs/product/CORE-DELTAS.md`'dir
(G-1…G-13). `docs/YOL-HARITASI.md` §2 aynı harfleri **farklı anlamlarla** kullanıyordu
(orada G-1 "kanıt derecelendirmesi git blob'una bağlı", G-2 "bellek isim-alanı yok").
İki numaralandırma bir arada yaşayamaz; yol haritasındakiler bu kayıtla yeni kimlik aldı
ve yol haritası düzeltildi:

| Eski (yol haritası) | Yeni kimlik | Anlam |
|---|---|---|
| G-1 | **G-17** | `evidence_trust` derecelendirmesi git blob'una bağlı; belge arşivinde hiçbir kanıt `repo_verified` olamaz (G-1 FATES eşlemesinden ayrı ve ondan ağır) |
| G-2 | **G-16** | Bellek isim-alanı reddeden kapı değil; matter duvarı örnek yalıtımına dayanıyor |
| G-3 | G-3 | Ajan hedef/rol listeleri kapalı (aynı) |
| G-4 | G-4 | Claim/evidence sözlükleri kod-alanına sabit (aynı) |

Bu ölçümün eklediği yeni çekirdek boşlukları:

| Kimlik | Boşluk | Kanıt | Kapanış ölçütü |
|---|---|---|---|
| **G-14** | Kas adapter manifesti keşfedilmiyor: registry yalnız `tools/aria-adapters/*.tool.json` dizinini (özyinelemesiz) okur; `packs/legal/pack.json` ve `arias/legal/aria.manifest.json`'ı çekirdekte hiçbir şey okumaz | `cycle.py:2578` (`manifest_dir = workspace_root/'tools'/'aria-adapters'`), `registry_compiler.py:37`, `capability_gap.py:167` | Hukuk örneğinde `aria tools list` `legal-document-inventory`'yi gösterir; `tool_manifest_sync` fazı kas manifestlerini de okur |
| **G-15** | Yargı zarflarını tüketen tek yol `tools/aria-poc/ci_executor.py --drain` (GitHub Actions); konteyner/hukuk dağıtımında zarfı tüketen yok | `dispatcher_factory.py:12-30` ("the external consumer is ci_executor"); `CYCLE_PHASES`'te drain fazı yok; `routes.ts` autonomy/drain eylemi açmıyor; `arias/legal/docker/compose.profile.yml` executor servisi tanımlamıyor | Hukuk konteynerinde bir zarf açılır, tüketilir, sonucu `ai_judge` satırı olarak defterlere düşer; konsolda görünür |
| **G-16** | (yukarıda) bellek isim-alanı | `aria.manifest.json` `memory.enforced_by: instance_isolation` | İki karşıt matter'lı testte arama/indeks/cache/özet/log/export katmanlarında sızıntı sıfır |
| **G-17** | (yukarıda) kanıt derecelendirmesi git'e bağlı | `evidence_trust.classify_evidence_ref`: `target_sha=None` → `baseline_unavailable`; git içinde bile `<sha>:<path>` çözümü `worktree_candidate` verir | İçerik-adresli kanıt (`sha256` eşleşmesi) `repo_verified` ile aynı sınıfta kabul edilir; belge arşivinde bir yargıç atfı `repo_verified` derecesine ulaşır |

Kas-içi eksikler `L-*` kimliği taşır; her satır MVP maddesine, aşamaya (S0–S4) ve
engelleyen `G-*`'ye bağlıdır.

## 0.2 MVP kabul ölçütü (2026-09-04 teklif e-postası)

Gerçek dava (~NOK 5M) doğrulama vakasıdır, ticari ürün değil. Bir ay içinde şunlar
gösterilmelidir; bu liste **asgaridir** ve B bölümünün sırasını belirler:

| # | Gösterim |
|---|---|
| M1 | Büyük ve karmaşık veri setinin yapılandırılması |
| M2 | Olay ve belgelerin kronolojik bağlanması |
| M3 | Eksik veya tutarsız bilginin tespiti |
| M4 | Bilginin farklı sürümlerinin karşılaştırılması |
| M5 | Süreç ve sorumlulukların yeniden kurulması |
| M6 | Veri bütünlüğü ve usul sorunlarının işaretlenmesi |
| M7 | Aynı metodolojinin anonimleştirilmiş davalara uygulanması |
| M8 | Avukat, şirket ve kamu kurumu için destek yüzeyi |

---

## A. Bugün var olanlar (kanıtlı)

### A1. Kanıt ve köken — hukuk ürününün sattığı zemin

| Yetenek | Durum | Üretim yolu | Hukuk örneğine bugünkü değeri | Sınır |
|---|---|---|---|---|
| Hash-zincirli ekleme (`ledger.py`) | wired | Her yazan faz; `routes.ts` POST `/actions/cycle` → `aria-kernel cycle run` | Kernel defterine giren her satır `previous_ledger_hash`/`ledger_hash` taşır; üç sentetik satırla `verify_jsonl` `{valid: True}` ölçüldü | Hukuk kaydı bu deftere **girmiyor** (bkz. G-5, L-06) |
| Satır boyu tavanı | wired | Primitifte; her çağıran miras alır | 1 MiB üstü satır fd açılmadan reddedilir | — |
| Bütünlük indeksi doğrulaması | wired | `integrity verify` CLI → `actions.ts:97` → `routes.ts` POST `/actions/integrity-verify` (salt-okunur, `ARIA_UI_ALLOW_ACTIONS` gerekmez) | Operatör konsoldan "defterler bozulmamış" doğrulaması alır | Yalnız kernel defterleri; `packs/legal/cases/**` artifact'ları kapsam dışı |
| Bütünlük doğrulaması (tüm mağaza) | wired | aynı | aynı | aynı |
| Runtime artifact grafı ve hash bağlama | wired | `tool_runner.record_run` → `write_run_artifact`; `CYCLE_PHASES['artifact_integrity']` | Adapter koşumunun kendisi hash'lenir | Adapter kayıtlı değilse koşum yok (G-14) |
| Bilgi-grafı zinciri | wired | `CYCLE_PHASES['memory']` → `verify_chain_or_quarantine` | — | Hukuk belleği ayrı isim-alanında değil (G-16) |
| `state_manifest` deklare-yüzey reddi | wired | Her `append_declared_jsonl` çağrısı | Ad-hoc defter yazılamaz; bu iyi | Hukuk yüzeyleri deklare değil → hukuk kaydı yazılamaz (G-5) |
| Günlük rapor çapası | wired | `report daily --emit-anchor` → `aria-daily-report.yml` | — | GitHub Actions'a bağlı; konteynerde çapa üreten yok |
| Kanıt derecelendirmesi (`evidence_trust`) | partial | `finding.py:274`, `evidence_validator.py`, `feedback_store.py:724` | İçerik hash'i zarfta taşınıyor ve adapter'ın hash'iyle bayt-eş | Git yokken derece hep `baseline_unavailable` (**G-17**) |
| Ajan/araç çıktısı kanıt yeniden-doğrulaması | partial | `tool_runner.py:188` (her adapter koşumu) | "ARIA'nın çıktısı kanıt değildir" kuralı gerçek ve zorlanıyor | Döngüde tools fazı snapshot vermediği için `repo_verified` talebi sessizce kapalı |
| Snapshot ve dosya kaderi (`discovery`) | partial | `CYCLE_PHASES['discovery']`; `discovery run` | Git olmadan da her dosyaya sha256 + `COMPLETION_PROOF` | Kader sözlüğü `tracked/generated/unknown`; `excluded root` kavramı yok — `Ikke laste opp` altındaki dosya `tracked` olarak hash'lendi (**G-1**) |
| Bulgu kaydı ve kanıt tabanı (`finding.emit_finding`) | absent (hukuk için) | `finding emit` CLI | Hiç: hukuk örneği kernel bulgu defterine tek bulgu yazamaz | `CLAIM_TYPES` sabit (G-4), kanıt tabanı git (G-17), `ORIGINATING_SKILL_ALLOWLIST`'te hukuk kaynağı yok |
| Hukuk belge envanteri adapter'ı (`packs/legal`) | not_wired | **Yok.** Elle: `npx ts-node --project tools/gates/tsconfig.json packs/legal/adapters/legal-document-inventory.ts` | Deterministik, yeniden koşturulabilir alım tutanağı: dosya başına sha256, tam kader muhasebesi, sürüm grubu, `.eml` taraf/iletişim; 21 test | Kayıtlı değil (G-14), runner G-9, bulguları defterlere giremiyor (G-4/G-5); artifact'lar hash-zincirsiz düz JSON |
| Hukuk konsol projeksiyonu | wired | `ui/server/src/index.ts` → `routes.ts` (`/api/legal/cases…`) | Dava, belge, sürüm, kronoloji, taraf, matris, kapsama görünür | Sunucu defter yazmaz; matris boş (üretici yok) |
| Dava artifact bütünlüğü (belge düzeyi köken zinciri) | absent | — | Bugün dürüst cümle: "alımda bu dosyanın baytları X'e hash'lendi; adapter yeniden koşunca aynı X ve bayt-eş manifest çıkıyor" | Zincir, indeks, çapa yok (G-5); L-06 |
| **PDF/DOCX/XLSX/PPTX metin okuma** (`packs/legal/adapters/binary/*`) | not_wired | **Yok.** 2026-09-04 yazıldı; bağımlılıksız (`node:zlib`) | 9 fixture'da 9/9 doğru (7 metin; şifreli ve taranmış PDF doğru sebeple `no_text`); gerçek pdfTeX üretimi 15 sayfalık PDF'te 15/15 sayfa metni doğru | Adapter'a bağlanmadı (L-02); OCR yok (amaç-dışı); nadir dosyada kerning boşluğu sözcük içine boşluk düşürebilir |

### A2. Yargı ve doğrulama — bir iddianın hayatta kalıp kalmadığına karar veren hat

| Yetenek | Durum | Üretim yolu | Hukuk örneğine bugünkü değeri | Sınır |
|---|---|---|---|---|
| Yargı örneği basımı (`generate_judgment_sample`) | wired | `CYCLE_PHASES['judgment_pipeline']` (normal döngü, `standard`) | Konsolun çalıştırdığı döngü zarf basar | Hukuk aracı kayıtlı olmadığından **örnek yok** (G-14) |
| Yargıç fan-out (`dispatch_judges_for_sample`) | wired | aynı faz | `agent-invocations/requests.jsonl`'a satır yazar ve döner | Yalnız **basım**; tüketen yok (**G-15**) |
| Yargıç yürütme (drain) | partial | GitHub Actions → `ci_executor.py --drain` → claude CLI → `agent submit-result` | Hukuk dağıtımında **hiç**: kernel basar ve bekler | Zincirdeki tek kırık; aşağıdaki her şey bu satırlarla beslenir (**G-15**) |
| Konsensüs arbiter ve kapısı | wired | aynı faz; `CONSENSUS_MIN_CONFIDENCE` | — | `ai_judge` satırı olmadan boş |
| Konsensüs → HUMAN_REQUIRED yükseltme | wired | `CYCLE_PHASES['consensus_escalation']`; konsol GET `/human-required` | Anlaşmazlık insana düşer ve görünür | aynı |
| Bağımsızlık — principal ayrıklığı | wired | `CYCLE_PHASES['human_required_adjudication']` | — | — |
| Bağımsızlık — üç katmanlı yakınsama | not_wired | yalnız `aria autonomy run` (`cli.py:5721/5806`) | Hiç | Hukuk profili `standard`, otonomi hattı hedef değil |
| Yakınsayan plan kapısı (`plan_convergence`) | not_wired | aynı | Hiç; konusu git deposu üstünde PLAN, hukuk kaydı için temsili yok | Yol haritası S2'de "zaten var" sayıyordu; **kod var, yol yok** |
| Yargıç kalibrasyonu | wired | `CYCLE_PHASES['judge_calibration']` | — | Girdi yok |
| Goldset öneri/yeniden oynatma | partial | Normal döngü fazları; **terfi** yalnız `aria goldset promote --curator` | Her gece boş öneri | Bilerek operatör kapılı |
| Fixture koşumu | wired | `CYCLE_PHASES['fixture_refresh']` | — | Hukuk fixture'ı kayıtlı değil (G-14) |
| Adapter kalibrasyon raporu | not_wired | yalnız `aria autonomy run` | Hiç | — |
| SHADOW→ACTIVE merdiveni | wired | `CYCLE_PHASES['tool_manifest_sync']` → `adapter_active_readiness` | — | Hukuk adapter'ı merdivende değil (G-14) |
| Hukuk adapter'ının registry kaydı | absent | — | Hiç; "aç kalan" her satırın üst nedeni | **G-14**; compose profili arşivi `/workspace`'e salt-okunur bağlar, manifest imajda |
| Hukuk yargıç ajanları dispatch yüzeyinde | absent | — | Hiç; dört hukuk ajanı yapı gereği erişilemez | **G-3** (`agent_surface.allowed_targets_for_role`) |
| Konsensüs → kalıcı bulgu (`promote_consensus_findings`) | partial | `judgment_pipeline`; her döngüde operatör onay ref'i ister | Hukuk için doğru duruş: makine konsensüsü sessizce kayıt olmaz | Döngü başına toptan ret |
| Yargıç kararını kapılayan kanıt derecesi | partial | Her araç koşumu ve her ajan sonucu | Ölçüldü: `agent-harness-security-adapter` `evidence_error`, 16 bulgu → 0 | Belge arşivinde her atıf `baseline_unavailable` (**G-17**) |
| Ajan değerlendirme koşucusu (`agent_eval`) | not_wired | GitHub Actions veya operatör kabuğu | Hiç; hukuk fixture seti yok | Gerçek-mod ayrıca operatör onayı ister |
| Yargı kanıtı için konsol yüzeyi | partial | HTTP → `actions.ts:33 runKernel` → `aria` CLI | Avukat, iddianın ikinci okuyucuya kuyruklandığını ve anlaşmazlığın yükseltildiğini görür | Kalibrasyon/korpus durumu görünmez; `ARIA_UI_ALLOW_ACTIONS=0` iken control/cycle 403 |

### A3. Güvenlik, yetki ve insan sınırı — (ikinci tur ölçümü, bekleniyor)

Bu bölüm ikinci tur ölçümü bitince dolar. Ölçülecekler: profil merdiveni ve
yazma/eylem kapısı, kill switch, maliyet/hata kesicileri, HUMAN_REQUIRED ve SLA,
operatör-tek ground truth, politika onayı, merge/PR yetkisi, `READONLY_PATHS` ve sandbox,
gizli/PII disiplini, audit/governance olayları, incident defteri, rollback paketi,
retention/DLP kanıt yüzeyleri, profilden bağımsız kapılar; ve
`config/approval-policy.json`'daki beş kapının (statement_verification,
party_identity_merge, filed_version_declaration, redaction_and_production,
external_effect) çekirdekte **zorlanıp zorlanmadığı**.

### A4. Hukuk kası ve operatör yüzeyi — (ikinci tur ölçümü, bekleniyor)

Bu bölüm ikinci tur ölçümü bitince dolar: adapter'ın koşturulmuş çıktısı (hangi kayıt
türünü hangi alanlarla ürettiği; `legal-contract.ts`'teki hangi türlerin üreticisi yok),
dört ajanın sözleşmesi ve dispatch edilebilirliği, `routes.ts` uç noktaları ve hangi
görünümün arkasında bugün gerçek veri olduğu.

Adapter'ın **beklenen** fixture çıktısından (`packs/legal/fixtures/expected/`) bugün
kesin olan: 9 belge (6 `text`, 2 `metadata_only` — PDF ve DOCX —, 1 `excluded`),
8 kronoloji olayı (`learnedAt` hepsinde `null`; 6'sı `ai_inference`, 2'si `.eml`'den
`party`), 3 taraf (hepsi `unknown`, rol yok, güven 0.5), 1 sürüm grubu (`name_suffix`),
**0 iddia**, kapsama `complete: true`.

### A5. Örnek türetme (metodoloji taşınabilirliği)

| Yetenek | Durum | Üretim yolu | Değeri |
|---|---|---|---|
| Şablondan örnek türetme (`arias/_template`, `derive.mjs`, `instance.schema.json`) | wired | `npm run aria:instances:derive`; `npm run aria:instances:test` (`aria:ci:all` içinde) | İkinci bir dava kümesi / anonimleştirilmiş vaka için ayrı örnek, aynı çekirdek ve kaslarla türetilir (M7'nin altyapısı) |

---

## B. Eksikler (sıralı)

Sıra: MVP maddesi (M1→M8), sonra aşama. Her satır: kimlik, MVP maddesi, aşama, bugünkü
durum, engelleyen çekirdek boşluğu, kabul testi. "Kas" = yalnız `packs/legal`/`ui`
değişikliği, çekirdek değişmez.

### B1. M1 — Veri setini yapılandırma (alım)

| ID | Eksik | Aşama | Bugün | Engel | Kabul testi |
|---|---|---|---|---|---|
| **L-01** | Dava dava dosya yükleme: konsolda dava oluşturma, belge yükleme, alım tetikleme | S0 | implemented_not_wired — konsol yolu var (13+5 test), ama dağıtılan profilde manifest `allow_actions:false` üç POST'u da 403 yapıyor ve hiçbir ortam değişkeni açamıyor; adapter kayıtsız (`tool not found`); `intake` geçilmiyor; artifact `case_<id>`, tutanak `<id>` (E.1) — **Faz 1** | kas (X-6) + G-9 (runner) + G-14 (kayıt) | Konsoldan `POST /api/legal/cases` ve `POST /api/legal/cases/:id/documents` ile yüklenen dosya, dava arşiv kökünde orijinal baytlarla durur (`sha256` eşit), alım defterine `received_at`+`sha256`+`bytes`+`fileName` satırı düşer, adapter koşumu sonrası dava listesinde görünür; `ARIA_UI_ALLOW_ACTIONS=0` iken yükleme 403 |
| **L-02** | PDF/DOCX/XLSX/PPTX metnini adapter'a bağlama (`extraction: text`) | S0 | wired, sınırlı — metin katmanı okunuyor; OCR yok; XLSX `text` sayılıp sıfır olgu veriyor; gerçek üretici (Word/Acrobat) PDF'i hiç test edilmedi — **Faz 3d** | kas | Fixture arşivinde `faktura_2024-001.pdf` ve `klage_utkast_v3.docx` `extraction: text`, `datesMentioned` dolu; taranmış PDF `metadata_only` + `pdf_no_text_layer`, şifreli PDF `pdf_encrypted`; `coverage.unreadable[].reason` bu sebepleri taşır; 21 mevcut test + yeni fixture testleri yeşil; iki koşum bayt-eş |
| **L-03** | Hukuk adapter'ının kernel registry'de görünmesi ve döngüde koşması | S0 | partial — elle `tool register` + `tool run` çalışıyor (ölçüldü); dağıtımda kayıt adımı yok; döngü yalnız `tools/aria-adapters` okur ve `default_input` fixture'a bakar — **Faz 1d** (kayıt); G-14 çekirdek | **G-14** + G-2 + G-9 | Hukuk örneğinde `aria tools list` adapter'ı listeler; `cycle run` sonrası `runs.jsonl`'da `legal-document-inventory` koşumu `ok`; `tool_manifest_sync` `packs/*/pack.json`'ı okur |
| **L-04** | Belge arşivi kaderlerinin çekirdek `discovery` kaderlerine eşlenmesi (`text/metadata_only/unreadable/excluded`), dışlanan kök kavramı | S0 | absent — kernel `excluded` kaderi bilmiyor; konsol `exclude_roots` göndermediği için dışlanan klasörün metni çıkarılıyor (ölçüldü) — **Faz 1c** (konsol yarısı); G-1 çekirdek | **G-1** | `discovery run` belge arşivinde `COMPLETION_PROOF.complete=true`; dışlanan kök altındaki dosya açılmaz ve `excluded` kaderi taşır |
| **L-05** | Alım tutanağı (evidence receipt): custodian, toplama zamanı, kaynak, imzalı manifest | S0 | partial — hash-zincirli tutanak var; imza/çapa/satır sayısı yok: yeniden zincirleme ve kuyruk kesme 'intact', boş defter 'intact'; eşzamanlı iki yükleme zinciri kalıcı kırıyor (ölçüldü); tutanak envantere geçmiyor — **Faz 2** | G-5 (deklare yüzey) + kas | Aynı arşiv iki kez alındığında bayt-eş manifest; tutanak `state_manifest`'te deklare bir yüzeye hash-zincirli yazılır; konsolda dava başlığında görünür |
| **L-06** | Dava artifact'larının bütünlük zincirine girmesi (belge düzeyi köken) | S0 | absent — artifact'lar düz JSON; okuma yolunda doğrulama yok, elle yazılmış `verified` satır olduğu gibi sunuluyor (ölçüldü) — **Faz 1e** (okuma sınırı), Faz 5 (karar defteri); G-5 çekirdek | **G-5** | `integrity verify` `packs/legal/cases/<id>/*.json`'ı kapsar; bir artifact elle değiştirildiğinde doğrulama kırmızı |

### B2. M2 — Kronoloji

| ID | Eksik | Aşama | Bugün | Engel | Kabul testi |
|---|---|---|---|---|---|
| **L-07** | Bütün okunabilir belgelerden (PDF/DOCX dâhil) kronoloji; `occurredAt`/`learnedAt` ayrımı dolu | S1 | partial — tüm okunabilir belgeler; ama satırdaki yalnız **en erken** tarih alınıyor, <3 kelimelik etiket satırları hiç girmiyor, üretimde `learnedAt` hep null — **Faz 1c + 3a** | L-02 + kas | Fixture'da PDF/DOCX tarihleri kronolojiye `ai_inference`+`humanReviewRequired: true` ile girer; `.eml` `Date` başlığı `learnedAt`'i doldurur; `datePrecision` `month/year` belirsiz tarihte doğru |
| **L-08** | `aria-legal-timeline-analyst` ajanının dispatch edilebilmesi | S1 | absent — G-3 + G-15 + G-17 — **Faz 8** | **G-3** + **G-15** | Hukuk konteynerinde ajan zarfı basılır, tüketilir, `timeline-event` kaydı `humanReviewRequired: true` ile artifact'a düşer |
| **L-09** | Bitemporal olgu kaydı (`valid_time`/`system_time`), "o tarihte ne biliniyordu" sorgusu | S1 | partial — `occurredAt`/`learnedAt` olaylarda ayrı; as-of sorgusu yok; ifade/taraf/sürüm kayıtlarında zaman yok — **Faz 5/6** | kas (şema) | Geriye dönük değiştirilmiş belge fixture'ında "o gün bilinen" ile "bugün bilinen" listeleri doğru ayrılır; her olgu ≥1 hash'li kaynağa bağlı |

### B3. M3 — Eksik ve tutarsız bilgi

| ID | Eksik | Aşama | Bugün | Engel | Kabul testi |
|---|---|---|---|---|---|
| **L-10** | İddia-kanıt matrisi taslağı (`aria-legal-claim-matrix-drafter`) | S2 | partial — mekanik yarısı gerçek (2 satır, kapıdan geçerek); okuma-anlama yarısı ajan, dispatch edilemiyor — **Faz 3d** (kapsam), **Faz 8** (ajan) | **G-3** + **G-15** | Fixture'da her iddia satırı `asserted/disputed`, ≥1 `supportingSources`, `missingEvidence[]` dolu; `verified` hiçbir satırda yok |
| **L-11** | Çelişki bulguları (`date_contradiction`, `amount_contradiction`) kernel bulgu defterine | S2 | partial — bulgular RAW deftere giriyor (5 satır ölçüldü); committed deftere G-17 yüzünden giremiyor; `finding emit` CLI yok — **Faz 8** | **G-4** + **G-17** | `finding emit --claim-type date_contradiction` hukuk kaynağından kabul edilir; kanıt `source_type=document_reference` L1 kapısından geçer |
| **L-12** | Eksik-kanıt motoru: her iddia için "hangi belge olsaydı test edilirdi" | S2 | partial — motor var ve bağlı; recall hiç ölçülmedi; yalnız açık belge atıfları — **Faz 3e** | kas (ajan) | Kontrollü boşluk korpusunda recall ölçülür ve raporlanır; her uyarı iki taraflı kaynak bağı taşır |
| **L-13** | Kapsama boşluklarının basınç kaynağı olması (okunamayan dosya → pressure) | S0 | absent — hukuk basınç kaynağı yok; `shadow_raw_delta` konsol koşumlarının cycle id'sini görmüyor — **Faz 8** | **G-6** | `run_pressure` skorunda `legal.unreadable_document` kaynağı görünür |

### B4. M4 — Sürüm karşılaştırma

| ID | Eksik | Aşama | Bugün | Engel | Kabul testi |
|---|---|---|---|---|---|
| **L-14** | Sürüm grupları arasında **içerik farkı** (ne değişti: tarih, tutar, cümle) | S1 | partial — tarih/tutar + satır sayısı; cümle düzeyi fark yok; taranmış üyede sessiz — **Faz 6** (görünürlük); cümle farkı kayıtlı sınır | L-02 + kas | `avtale_v1`↔`avtale_v2_signert` için değişen tutar/tarih listesi `versions.json`'da `humanReviewRequired: true` ile; `.docx` `w:ins/w:del` izleri ayrı raporlanır |
| **L-15** | "Sunulan sürüm" ilanı: avukat kapısı (`filed_version_declaration`) | S1/S4 | absent — `filedMember` hep null, yazan yok; kapı sorulmuyor; rol yok — **Faz 5** | A3 ölçümü (HUMAN_REQUIRED ground truth) | `filedMember` yalnız `lawyer` rolündeki kaydedilmiş bir kararla dolar; adapter/ajan yazamaz |

### B5. M5 — Süreç ve sorumluluklar

| ID | Eksik | Aşama | Bugün | Engel | Kabul testi |
|---|---|---|---|---|---|
| **L-16** | Tarafların PDF/DOCX metninden çıkarılması (bugün yalnız `.eml` başlıkları) | S1 | wired, sınırlı — metinden 6 taraf; konsolda `basis` yok, org.nr `aliases` sütununda 'birleştirilmiş yazım' diye gösteriliyor; belirsizlik davada görünmüyor — **Faz 3c/6** | L-02 + kas | Fixture'da `Nordlys Entreprenør AS`, `Bergen Eiendom ASA`, `Kari Nordmann` taraf olarak, `kind` tahmini ve güven ≤0.5, birleştirilmeden |
| **L-17** | Rol ve sorumluluk yeniden kurma: kim, ne zaman, hangi belgeyle (`PARTY_IN`, `WAS_SENT_BY`, `ROLE`) | S1/S2 | partial — `WAS_SENT_BY/RECEIVED_BY` yalnız .eml; `PARTY_IN` ve `ROLE` üreticisi yok, her taraf `roles: []` — **Faz 3c** | kas | Her `COMMUNICATION` olayının gönderen/alan bağı; `ROLE` kaydı (byggherre/entreprenør/advokat) belge kanıtıyla ve `humanReviewRequired` |
| **L-18** | Aynı isimli taraf belirsizliği bulgusu (`party_identity_ambiguity`), birleştirmeden | S2 | wired — 11 test; bulgu dava arayüzünde görünmüyor — **Faz 6** | **G-3** (ajan) veya kas (adapter kuralı) | "Part A" / "Part A AS" için tek bulgu, iki taraf ayrı kalır |

### B6. M6 — Veri bütünlüğü ve usul sorunları

| ID | Eksik | Aşama | Bugün | Engel | Kabul testi |
|---|---|---|---|---|---|
| **L-19** | Karşıt yargıç geçişi (`aria-legal-adversarial-judge`) ve konsensüs | S2 | partial — yargıç zarfları basılıyor (10 zarf ölçüldü); tüketen yok (G-15), verdict reddedilir (G-17) — **Faz 8** | **G-3** + **G-15** | Fixture'da `supported` bir satır için karşı-belge aranır; `contradicted` kararı karşı belgeyi `file:line`+hash ile adlandırır; iki yargıç anlaşamazsa HUMAN_REQUIRED |
| **L-20** | Usul adımı ve süre kayıtları (`PROCEDURAL_STEP`, `DEADLINE`) — bağlayıcı değil, avukat doğrulamalı | S2/S3 | absent — üretici yok; kabul testinin adlandırdığı cümle fixture'da da yok — **Faz 3b** | kas | Fixture'daki "Svarfrist: 18.03.2024" `DEADLINE` kaydı olarak `assertedBy: ai_inference`, `humanReviewRequired: true` |
| **L-21** | Avukat doğrulama akışı: `verified` yalnız insanla; konsoldan kernel CLI üzerinden | S2 | absent — hiçbir yol: rota/CLI/UI yok; `applyHumanVerification`'ın üretim çağıranı yok; elle eklenen karar bir koşumda siliniyor (ölçüldü) — **Faz 4 + 5** | A3 ölçümü (`resolve_human_required`) + kas (X-6) | `statement.status=verified` yalnız `verifiedBy`+`verifiedAt` dolu ve kayıt HUMAN_REQUIRED ground-truth yoluyla düşmüşse; adapter/ajan yazamaz (test) |

### B7. M7 — Metodolojinin anonimleştirilmiş davalara taşınması

| ID | Eksik | Aşama | Bugün | Engel | Kabul testi |
|---|---|---|---|---|---|
| **L-22** | Matter duvarı: ikinci dava geldiğinde reddeden kapı | S4 | absent — tek token, herkes her davayı görüyor; `x-aria-actor` doğrulanmadan tutanağa yazılıyor — **Faz 4** | **G-16** | İki karşıt matter'lı testte arama/indeks/cache/özet/log/export sızıntısı sıfır |
| **L-23** | Karartma ve üretim kapısı (`redaction_and_production`), geri alınamazlık **garantisiz** | S4 | absent — karartma, üretim ve belge indirme yolu yok — **Faz 6** (indirme); karartma Faz 5 sonrası, ORPHAN kayıtlı | A3 ölçümü + kas | Karartma yalnız `lawyer` onayıyla; anonimleştirme çıktısı orijinalin hash'ini taşır ve "geri döndürülemezlik garanti edilmez" ibaresi kayıtta |
| **L-24** | Anonimleştirilmiş vaka için örnek türetme reçetesi (`arias/_template`) ve PII disiplini | S4 | partial — türetme boş kabuk üretiyor (pack `enabled:false`, `corpus.kind: git_repository`); PII maskesi yok — **Faz 7** | kas | Türetilen örnekte `maskPii` benzeri disiplin loglarda; fixture korpusu gerçek kişi adı içermez (test) |

### B8. M8 — Avukat / şirket / kamu için yüzey

| ID | Eksik | Aşama | Bugün | Engel | Kabul testi |
|---|---|---|---|---|---|
| **L-25** | Konsolda dava dava çalışma: dava listesi, belge yükleme, kapsama, kronoloji, matris — profesyonel tasarım, İngilizce | S0–S2 | partial — okuma yarısı var; karar veren yarısı yok; dağıtılan profilde salt-okunur — **Faz 5/6** | L-01 | Konsol doğrulama: tsc + vitest + build yeşil; hukuk sekmelerinde Türkçe metin yok; iddia satırında durum, kaynak, insan-inceleme işareti görünür |
| **L-26** | Kalibrasyon ve korpus durumunun konsolda görünmesi | S2 | absent — kalibrasyon/goldset yüzeyleri listelenmiyor; `arias/legal/corpus` yok — **Faz 3e/6** | kas (X-6) | Konsolda yargıç kalibrasyon satırları ve goldset öneri durumu |
| **L-27** | `ui/**` ve `packs/legal/**` için CI kapsaması | S0 | implemented_not_wired — `aria-adapters-test.sh` paketleri koşuyor ama hiçbir workflow çağırmıyor; ui testleri hiçbir yerde — **Faz 7** | kas | `aria:ci:all` içinde `ui` testleri ve `packs/legal` adapter testleri; PR'da kırmızı görünür |

---

## C. Güncel uygulama sırası (2026-09-05)

Kullanıcının kod denetimi sonrası güncel planı önceki Faz 0–8 numaralarını
**değiştirmiştir**. D–F bölümleri tarihsel kanıttır; bugünkü üretim kapanışı değildir.
Özellikle otomatik tetikleme ve gerçek AI/hafıza R1'in zorunlu parçalarıdır.

| Faz | Güncel kapsam | Takip |
|---|---|---|
| 0 | Yarım karar sözleşmesi/politika/okuyucu uyumu, tek CI kapısı | LEGAL-HIGH-002 |
| 1 | Kimlik, tüm dava yüzeyleri, tek yazıcı, snapshot, boş dava | LEGAL-CRITICAL-003/002, LEGAL-HIGH-005 |
| 2 | Dayanıklı alım, defter, kalıcı işler, değişmez koşum, tam sayfalama | LEGAL-HIGH-004, LEGAL-CRITICAL-006 |
| 3 | Kaynak anlamı, biçimler, alıntı/konum, zaman ayrımı | LEGAL-CRITICAL-007 |
| 4 | Avukat kararları, günlük arayüz, kaynak ve türev silme | LEGAL-CRITICAL-008 |
| 5 | Yüklenen mevzuat, SQLite arama, onaylı ortak yöntem | LEGAL-HIGH-009 |
| 6 | Gerçek ARIA, kalıcı dava hafızası, geri bildirim, dar model geçidi | LEGAL-CRITICAL-010; ayrı çekirdek onayı |
| 7 | Kurulum, izolasyon, silme, şifreli yedek ve geri dönüş tatbikatı | LEGAL-CRITICAL-011 |
| 8 | R1 sonrası emsal ve strateji | LEGAL-HIGH-012 |

Kimliklerin durumu, sahipleri, hedef tarihleri ve kabul ölçütleri monorepo
`docs/reviews/codex/2026-09-05-legal-production.md` dosyasındadır.

Güncel başlangıç ölçümü: yarım değişikliklerle sunucu 87/97; beş sunucu tip
hatası. Karar projeksiyonu henüz karar yazma arayüzü değildir. `runKey=null`
düz artifact'ların geçmiş koşum üretmediğini açıkça belirtir. Kaldırma kararı
kaydı içerik erişimini kapatır; kaynak/türev/yedek imhasını tamamlanmış göstermez.

Tek yerel kapı: `new-aria/` içinde `npm run legal:check`; gerçek workflow:
`.github/workflows/new-aria-legal.yml`. Küçük korpustaki precision=1.0 şartı
korunur; bu korpus üretim kalitesi için istenen avukat etiketli korpusun yerine geçmez.

---

## D. Bu oturumda kapananlar (2026-09-04, kanıtlı)

> **Düzeltme (2026-09-04, akşam).** Bu bölümdeki "kapandı" satırları aynı gün yedi ajanlı
> bağımsız bir denetimle çürütülmeye çalışıldı ve **14 iddianın 13'ü düştü**. Düzeltilmiş
> durumlar ve eksikler **E bölümündedir**; E ile D çeliştiğinde E geçerlidir. D, ne
> iddia edildiğinin ve neden yetmediğinin kaydı olarak duruyor.

Ölçüm yapıldıktan sonra bu oturumda kapatılan satırlar. Her biri koşturulmuş testle
bağlıdır; hiçbiri "yapıldı" diye işaretlenmemiştir.

| ID | Ne kapandı | Kanıt |
|---|---|---|
| **L-02** | PDF / DOCX / XLSX / PPTX metin katmanı okunuyor; şifreli ve taranmış PDF sebebiyle reddediliyor | `packs/legal/adapters/binary/` — 16 çıkarıcı + 21 adapter testi yeşil, iki koşum bayt-eş; gerçek 15 sayfalık pdfTeX belgesinde 15/15 sayfa |
| **L-01** | Dava dava dosya yükleme: dava açma, belge yükleme, alım tutanağı, envanter tetikleme | `ui/server/src/legal-intake.ts` + `ui/web/src/features/legal/IntakeTab.tsx`; 13 sunucu + 5 arayüz testi yeşil |
| **L-05 (yarısı)** | Alım tutanağı: custodian, alım zamanı, sha256, yükleyen; satırlar **hash-zincirli** ve düzenleme tespit ediliyor | `verifyIntakeChain`; testte düzenlenen satır `row_hash_mismatch`, silinen satır `previous_row_hash_mismatch` veriyor |
| **L-03 (yarısı)** | Hukuk adapter'ı kernel registry'sine giriyor ve gerçek bir dava arşivi üzerinde koşuyor | Ölçüldü: `aria tool register` → `aria tool list` SHADOW; `aria tool run` → `status: ok`, 10 dosya okundu, sekiz artifact yazıldı, koşum `runs.jsonl`'a hash-zincirli düştü |
| **L-27 (yarısı)** | `packs/legal` testleri CI hattında | `scripts/ci/aria-adapters-test.sh` |

Faz 0 (uydurmayı imkânsız kılan kapılar):

| Kapı | Durum | Kanıt |
|---|---|---|
| `verified` yalnız insanla | **kapandı** | `packs/legal/adapters/records/statement-gate.ts`: tip düzeyinde `MachineStatementStatus` `verified`'ı içermiyor; çalışma zamanında `acceptMachineStatement` `status: 'verified'`, dolu `verifiedBy` veya `verifiedAt` taşıyan her gönderimi reddediyor. 12 test |
| Örnek manifesti uygulanıyor | **kapandı** | `ui/server/src/instance-policy.ts`: `runtime.allow_actions` yalnız **daraltabiliyor**; bozuk manifest/politika sunucuyu durduruyor. 9 test, biri gönderilen hukuk örneğinin beş avukat kapısını yüklüyor |
| Konsol profil anahtarı | **kapandı** | `readers/overview.ts` artık `active_profile` okuyor (kernel `runtime_profile.py:610` onu yazıyor); eski adlar geriye dönük yedek |
| Eksik banned-phrase CLI | **açık** | `runtime_profile.py:36-38` iki TS gate'i "non-bypassable" sayıyor, ikisi de bu ağaçta yok; `banned_phrase_adapter.py` exit 127. Python doğrulayıcı gerçek ve koşuyor |

Ölçülen ve kayda geçen yeni sınır: **kernel'in tool runner'ı, adapter'ın kodunun
gözlenen külliyatın içinde olduğunu varsayıyor** (`tool_runner.py:78` cwd çalışma alanı
kökünün altında olmalı; `:694` `<cwd>/node_modules/ts-node/dist/bin.js` şart). Bu yüzden
hukuk dağıtımında çalışma alanı kökü ARIA kurulumudur ve dava arşivleri onun altındaki
kalıcı bir birimde durur; konsol bu iki yol hizalanmadığında envanteri **reddediyor**
(`cases_dir_outside_workspace`), runner'ın içinde alakasız bir hatayla ölmesini
beklemiyor.

### D.2 — Kronoloji ve çelişki motoru (2026-09-04, ikinci tur)

| ID | Ne kapandı | Kanıt |
|---|---|---|
| **L-07** | Kronoloji tüm okunabilir belgelerden; PDF olayları **sayfa** konumuyla | Fixture: 10 olayın hepsi `mechanical_extraction`, PDF'ten gelenler `page:1`/`page:2` |
| **L-09 (yarısı)** | `learnedAt` alım tutanağından; tutanak yoksa **null kalır**, koşum saati uydurulmaz | Adapter `intake` girdisi; fixture koşumunda tutanak yok → hepsi `null` |
| **L-11 (kas yarısı)** | `date_contradiction` / `amount_contradiction` bulguları, **iki taraf da** locator ve hash'le | Fixture: fatura `page:1` "Fakturadato = 2024-03-12" ↔ klage `line:6` "2024-03-14" |
| **L-12** | `missing_evidence`: bir belge arşivde olmayan bir belgeye atıf yapıyor; mesaj **aranan kapsamı** söylüyor | Fixture: fatura "avtale datert 2024-01-15"e atıf yapıyor, 8 okunabilir dosyanın hiçbiri karşılamıyor |

**Uydurmama disiplini, ölçülmüş.** İlk sürüm dört yanlış-pozitif üretiyordu ve
üçü de daraltıldı, çünkü yanlış bir çelişki avukatın zamanını yakar:

1. E-posta başlıkları (`Date:`) taşıma verisidir, dava içeriği değil → `.eml`'de yalnız gövde taranıyor.
2. Aynı belgenin iki sürümü arasındaki fark çelişki değil, **revizyonun kendisidir** → aynı sürüm grubundaki çiftler atlanıyor; o fark sürüm karşılaştırmasına ait (L-14).
3. `Dato`, `Sted`, `Vår ref` gibi etiketler belgenin **kendisini** tarif eder; iki belgenin farklı tarihte yazılmış olması anlaşmazlık değildir → bu etiketler karşılaştırmadan çıkarıldı.
4. Belgenin kendi başlığı (`FAKTURA nr. 2024-001`) kendine atıftır, eksik belge değil → dosya adı tanımlayıcıyı içeriyorsa atıf sayılmıyor.

Ay hassasiyeti eklendi ve **gün uydurulmuyor**: "mars 2024" `datePrecision: 'month'`
ile giriyor, ve bir ay ile o ayın içindeki bir gün çelişki sayılmıyor — biri yalnızca
daha az kesin. Çıplak yıl hiç yakalanmıyor, çünkü `faktura_2024-001` gibi her referans
numarası tarihe dönüşürdü.

`ai_inference` etiketi mekanik çıkarımdan kaldırıldı: hiçbir model koşmuyor, dolayısıyla
o etiket yanlıştı. Yeni kaynak `mechanical_extraction` ve hâlâ `humanReviewRequired: true`.

### D.3 — Sürüm karşılaştırma (2026-09-04)

| ID | Ne kapandı | Kanıt |
|---|---|---|
| **L-14** | Sürüm grubu üyeleri arasında **ne değiştiği**: etiketli değerler (tarih/tutar) ve satır farkı | Fixture: `avtale_v1` → `avtale_v2_signert` adımında `Pris: nok 125000.00 → nok 120000.00`, +4/-4 satır, 1 satır aynı |

Tasarım kararı: aynı sürüm grubundaki fark **çelişki değildir**, revizyonun kendisidir.
Bu yüzden çelişki motoru o çiftleri atlıyor ve fark burada, doğru çerçevede görünüyor:
"bu iki taslak arasında fiyat şu kadar değişti". Aynı olguyu iki yerde iki farklı adla
raporlamak, okuyucuya iki sorun varmış gibi gösterirdi.

Modül hiçbir sürümü **yetkili ilan etmiyor**: bir test, farkın çıktısında
`authoritative/filed/final/current/signed` gibi bir hüküm bulunmadığını doğruluyor.
`filedMember` avukat kapısında (`filed_version_declaration`) kalıyor.

Sınır: satır farkı 4000 satırın üstündeki çiftlerde atlanıyor ve bunu `unchangedLines: -1`
ile **söylüyor**; uydurma bir sayı üretmiyor. Değer karşılaştırması doğrusal olduğu için
o çiftlerde de koşuyor.

### D.4 — Taraflar ve roller (2026-09-04)

| ID | Ne kapandı | Kanıt |
|---|---|---|
| **L-16** | Taraflar PDF/DOCX metninden de çıkıyor; **birleştirme yok** | Fixture'da 3 → 6 taraf: `Nordlys Entreprenør AS` (org.nr. alias'ıyla), `Bergen Eiendom ASA`, `Kari Nordmann` (v/ advokat kalıbı) eklendi |
| **L-18** | `party_identity_ambiguity`: benzeyen iki yazım **ayrı taraf kalıyor**, benzerlik soru olarak kaydediliyor | 11 test; `Nordlys Entreprenør AS` ↔ `ASA` iki aday olarak duruyor, bulgu "birleştirme avukatın kararı" diyor |

Kural: bir isim ancak belge onu **etiketlemişse** rol alıyor. Organizasyon eki (`AS`,
`ASA`) bir tarafın ne **olduğunu** söyler, bu davada ne **yaptığını** değil; ikisini
karıştırmak, kanıtı olmayan bir rol iddiası üretirdi. Metinden okunan hiçbir adayın güveni
e-posta başlığı tabanını (0.5) geçmiyor.

### D.5 — İddia matrisi mekanik olarak doluyor (2026-09-04)

| ID | Ne kapandı | Kanıt |
|---|---|---|
| **L-10 (mekanik yarısı)** | `statements.json` artık boş değil: arşivin **kendi desteklediği** satırlar yazılıyor | Fixture'da 2 satır: bir `disputed` (fatura ↔ klage tarih farkı, iki taraf da ekli), bir `unverifiable` (atıf yapılan sözleşme arşivde yok, eksik kanıt adlandırılmış) |

Yazılan satırlar **yargı gerektirmeyenler**: iki belgenin farklı söylediği bir değer
`disputed`, arşivin karşılayamadığı bir atıf `unverifiable`. `contradicted` **kullanılmıyor**,
çünkü o "kanıt iddiayı çürütüyor" demektir ve bu bir hükümdür; burada hüküm verilmiyor.
Okuma-anlama gerektiren satırlar (bir tarafın ne iddia ettiği) ajanın işi olarak duruyor ve
yokluğu görünür kalıyor.

Önemli olan yol: bu satırlar **doğrulama kapısından geçerek** yazılıyor
(`acceptMachineStatement`). Yani adapter, ajanlara kapalı olan bir kestirmeyi kendisi de
kullanamıyor. Testi bunu doğruluyor: hiçbir makine satırı `verified` değil, `verifiedBy`
boş, `humanReviewRequired` her satırda açık.

### D.6 — Konsol yüzeyi (2026-09-04)

| ID | Ne kapandı | Kanıt |
|---|---|---|
| **L-25 (alım + sürüm kısmı)** | Dava başına **Intake** sekmesi: custody bandı, zincir hükmü, her varış satırı hash'iyle; dava açma formu; sürüm grubunda **ne değişti** listesi | 5 alım testi + 5 sürüm paneli testi; `IntakeReceipt` ve `VersionGroupPanel` saf bileşen olarak ayrıldı ve doğrudan test ediliyor |

Konsol tarafında korunan iki dürüstlük kuralı test edilerek pinlendi: sürüm paneli hiçbir
üyeyi **yetkili ilan etmiyor** ("signed candidate" dosya adının söylediğidir, hüküm değil),
ve yalnız bir sürümde geçen bir değer "yoktan değişti" gibi değil, `not stated` olarak
gösteriliyor. Atlanan satır karşılaştırması da "atlandı" diyor, uydurma sayı basmıyor.

### D.7 — Uçtan uca doğrulama ve ölçülen dağıtım sınırı

Gerçek kernel üzerinde, konteynerdekiyle **aynı şekilde** (git olmayan çalışma alanı kökü,
dava arşivi onun altında) koşuldu:

```
aria tool register --file packs/legal/adapters/legal-document-inventory.tool.json
aria tool run --tool-id legal-document-inventory --workspace-root <ARIA kurulumu> \
  --input '{"archive_root":"data/legal-cases/<case>/archive", ..., "intake":[...]}'
→ run status: ok
```

Üretilen artifact'lar: kapsama tam (8 metin, 2 `metadata_only` — `pdf_encrypted` ve
`pdf_no_text_layer:1_pages` —, 1 dışlanmış), **2 iddia satırı** (bir `disputed` tarih
uyuşmazlığı, bir `unverifiable` eksik belge), **6 taraf**, **12 kronoloji olayı** (4'ünde
`learnedAt` alım tutanağından), **1 sürüm adımı** (`Pris` 125 000 → 120 000).

**Ölçülen sınır (G-20).** Aynı koşum bir **git çalışma ağacında** `evidence_error` veriyor
ve iki koşumdan sonra adapter karantinaya giriyor. Sebep: `evidence_validator` her okunan
yolun anlık görüntüde olmasını ister, `snapshot.py` git varken `--exclude-standard`
kullanır, dava arşivi ise `.gitignore`'lıdır — müvekkil belgesi commit edilmemelidir. İki
gereklilik git altında çelişiyor. Konteynerde çalışma alanı kökü git deposu **değildir**
(`_filesystem_paths` yolu), orada çelişki yok. Sonuç: dağıtım geçerli, geliştirici
worktree'sinde sonda alırken çalışma alanı kökü git olmayan bir kopya olmalı.

---

## E. Bağımsız denetim ve düzeltme (2026-09-04, `wf_915de46a-042`)

Yedi ajan: üçü D.1–D.7'nin her iddiasını çürütmeye çalıştı, üçü MVP alanı başına kalan
boşlukları ölçtü, biri yol haritasında hiç geçmeyen yetenekleri aradı. Hepsi salt-okunur,
hepsi komut koşturup çıktısını gösterdi. Bu bölüm o sonuçtur; yumuşatılmadı.

### E.1 — D'nin iddiaları, düzeltilmiş

| D iddiası | Düzeltilmiş durum | Neyin eksik olduğu (ölçülmüş) | Faz |
|---|---|---|---|
| D.1 "Dava dava yükleme çalışıyor" | **implemented_not_wired** | Dağıtılan profilde `runtime.allow_actions:false` + `effectiveAllowActions` = ortam VE manifest → üç POST her zaman 403, hiçbir ortam değişkeni açamıyor. Açılsa bile: adapter kayıtsız, `intake` geçilmiyor (`actions.ts:187-191`), artifact `case_<id>` / tutanak `<id>` → Intake sekmesi adapter'ın davasında boş, zincir yine 'intact' | 1 |
| D.1 "Tutanak hash-zincirli, düzenleme tespit ediliyor" | **partial** | Dış çapa, imza, satır sayısı yok: yeniden zincirlenmiş defter ve kesilmiş kuyruk 'intact'; boş defter 'intact'. Eşzamanlı iki yükleme aynı `previousRowHash`'i alıyor → zincir kalıcı kırık (ölçüldü: `brokenAt:1`) | 2 |
| D.1 "Makine `verified` yazamaz" | **partial** | Tek fonksiyon korunuyor, artifact değil: `readers/legal.ts:51-63` cast; elle yazılmış `verified` satır avukata sunuluyor. Meşru `verified` için hiçbir yol yok (L-21); karar bir koşumda siliniyor | 1e, 5 |
| D.1 "Manifest yükleniyor ve uygulanıyor" | **partial** | Beş bildirimden dördü hiçbir şey yapmıyor: `profile_ceiling` kernel'e geçmiyor, beş avukat kapısı okunup atılıyor (`requiredRoleFor`'un üretim çağıranı yok), `memory.namespace` uygulanmıyor, kernel manifesti hiç okumuyor. Uygulanan tek alan `allow_actions`, o da örneği çalışmaz kılıyor | 1a, 4 |
| D.1 "Profil göstergesi doğru anahtarı okuyor" | **wired** (ayakta) | Doğru ama gösterecek şeyi yok: `/data/legal/aria-tools` boş geliyor, `profile set` hiç koşmuyor; gösterge manifestin tavanına bağlı değil | 1d |
| D.2 "PDF/DOCX/XLSX/PPTX okunuyor, dürüst ret" | **partial** | Dağıtımda `tool not found`; OCR yok; XLSX `text` sayılıp sıfır tarih/tutar; gerçek üretici PDF'i test edilmedi | 1d, 3d |
| D.2 "Kronoloji `learnedAt` + ay hassasiyeti + sayfa" | **partial** | Üretimde `learnedAt` hep null. `legal-document-inventory.ts:717` yalnız `[0]`'ı alıyor, `legal-text.ts:214` **değere göre** sıralıyor → satırdaki en erken tarih, anlamdan bağımsız ("Milepæl 1 levert 05.02.2024, godkjent 08.02.2024" → tek olay). `:720` <3 kelimelik satırları atıyor → "Fakturadato 12.03.2024" kronolojiye hiç girmiyor | 1c, 3a |
| D.2 "Çelişki ve eksik atıf mekanik, iki taraflı" | **partial** | Yalnız `Label: value` akan-metin satırları; PDF/DOCX alan tabloları, XLSX (tab, iki nokta yok), rakamlı etiketler kör. `text===null` belgeler `targets`'ta yok → taranmış sözleşme 'eksik' raporlanıyor | 3d |
| D.2 "Dört yanlış-pozitif sınıfı kapatıldı" | **partial** | Ölçekte baskın sınıf kapatılmadı: **aynı etiket, farklı konu**. 400 alakasız belgede 237.880 sahte `disputed` (237.881'in 237.880'i), 171 MB stdout, 1.19 GB RSS; kernel 12 MiB'te koşumu atıyor (~108 belge). Fixture dışında kesinlik ölçümü yok | 3e |
| D.3 "Sürüm grupları ne değiştiğini söylüyor" | **partial** | Yalnız satır başı `Label:` tarih/tutar + satır sayısı; değişen kapsam/taraf/sorumluluk cümlesi görünmez; taranmış üyede sessiz; PDF yeniden akışında satır sayısı sinyal taşımaz | 6 |
| D.4 "Taraflar metinden, birleştirme yok" | **partial** | Konsol `basis`'i göstermiyor (`LegalParty`'de alan yok; 'party_label' `roles`'a sızıyor); org.nr `aliases`'a itilip "birleştirilmiş yazım" başlığı altında gösteriliyor — modülün asla yapmadığını söylediği şey. Belirsizlik davada görünmüyor; başlık-türevli tarafla metin adayı hiç karşılaştırılmıyor | 3c, 6 |
| D.5 "Matris arşivin desteklediği satırlarla dolu" | **partial** | Yalnız form şekilli satırlar; düz metindeki tutar/tarih ("Kontraktssummen er avtalt til NOK 4 950 000") görünmez; satır↔taraf bağı yok; okuma yolunda doğrulama yok | 3d, 1e |
| D.6 "Konsol tutanağı ve sürüm farkını gösteriyor" | **partial** | Dağıtılan profilde konsol uçtan uca salt-okunur; Intake sekmesine gezinme yok; zincir hükmü o sekme dışında hiçbir yerde yok | 1a, 6 |
| Tamlık: "Her kayıt türü konsolda görünüyor" | **partial** | `document_version_conflict` ve `party_identity_ambiguity` dava arayüzünde hiçbir yerde; adapter'ın insan için yazdığı mesaj hiçbir yerde gösterilmiyor; kernel Findings sayfası v2 satırını metinsiz, yolsuz, önemsiz basıyor (`reason_code` mesaj yerine) | 6 |

### E.2 — Yol haritasında olmayan boşluklar (denetim buldu)

| ID | Eksik | Bugün | Kanıt | Faz |
|---|---|---|---|---|
| **L-28** | Kullanıcı kimliği ve erişim denetimi | absent | Tek `ARIA_UI_TOKEN`, principal yok; `x-aria-actor` başlığı tutanağa `receivedBy` olarak yazılıyor (`routes.ts:79-82`); okuma denetim satırı yok | 4 |
| **L-29** | İnsan kararı için kalıcı katman | absent | `writeArtifacts` her koşumda sekiz dosyayı ezer; elle eklenen `verified` bir koşumda kayboldu (ölçüldü) | 5 |
| **L-30** | Kaynak belgeye erişim | absent | Baytları döndüren uç nokta yok; "iki tarafı da açabilmeli" diyen modülün konsolu açtırmıyor | 6 |
| **L-31** | Alım ↔ envanter mutabakatı | absent | Tutanaksız dosya delil sayılıyor, kaybolan dosya raporlanmıyor, `complete:true` (ölçüldü: b+c diskte, a+b tutanakta → bulgu yok). `rename` (`:319`) tutanaktan (`:339`) önce → çökme tutanaksız dosya bırakır | 2 |
| **L-32** | Eşzamanlı alımda zincir | partial | Kilit/sıralama yok; aynı turda biten iki yükleme aynı `previousRowHash`'i alıyor → kalıcı `previous_row_hash_mismatch`, konsol "değiştirildi" diyor | 2 |
| **L-33** | Çıktı hacmi sınırı | absent | O(N²) etiket eşleme; 400 belge → 200 MB `statements.json`; 12 MiB stdout tavanı ~108 belgede aşılıyor; 11 dosyadan büyük test yok | 3e |
| **L-34** | Kopya belge kimliği | absent | Bayt-eş iki dosya "sürüm çatışması" oluyor; `duplicateOf` yok; sayımlar şişiyor, inceleme işi üretiyor | 2 |
| **L-35** | Belgeler arası etiket çakışması (konu çapası) | partial | `contradictions()` `(kind,label)` ile tüm arşivi eşliyor; iki alakasız fatura 'dispute' | 3e |
| **L-36** | Silme, düzeltme, saklama/imha | absent | 13 uç noktanın hepsi GET/POST; yanlış davaya yüklenen belge çıkarılamıyor; dava yaşam döngüsü ve saklama tarihi yok | 5 |
| **L-37** | Artifact geçmişi ve şema sürümü | absent | Her koşum öncekini ezer; okuyucu `schemaVersion`/`adapterVersion` kontrol etmiyor | 1e, 5 |
| **L-38** | Yedek ve geri yükleme | absent | `legal-cases` volume'u yedeksiz; geri yüklemenin sha256 ve zinciri yeniden ürettiğinin kanıtı yok | 7 |

### E.3 — Çekirdek kapıları, denetimin düzelttiği şekliyle

| Kimlik | Düzeltme |
|---|---|
| G-15 | **implemented_not_wired**, kayıttan dar: `ci_executor_drain.drain_pending` GitHub'a bağlı değil ve imajda; eksik olan yalnız çağıran (`aria agent drain` yok, döngü fazı yok) |
| G-3 | Bir kapalı literal değil **dört + çözücü**: `REQUEST_ROLES`, `INVOCATION_ROLES`, `DISPATCHABLE_ROLES`, `ROLE_TARGET_PAIRING`, `DEFAULT_TARGET_AGENT_WHITELIST` ve `agent_resolver`; beş pinleyen test |
| G-17 | İki hattı ısırıyor: bulgu üretimi **ve** ajan sonucu kabulü (`validate_agent_response_evidence` her kanıtta `repo_verified` ister; git'siz kökte `baseline_unavailable`) |
| L-11 | Hukuk bulguları RAW deftere **giriyor** (5 satır ölçüldü); ulaşılamayan committed defter; `finding emit` CLI yok — kayıt yanlıştı |
| L-19 | Yargıç zarfları hukuk bulguları için **basılıyor** (10 zarf ölçüldü); eksik olan tüketim (G-15) ve kabul (G-17) |

---

## F. Plan uygulaması (2026-09-05'ten itibaren, kanıtlı)

Onaylı planın fazları; her satır koşturulmuş testle ve gerçek çekirdek duman testiyle
bağlıdır. E bölümündeki hangi eksiği kapattığı belirtilir.

### F.1 — Faz 1: dağıtılan profil çalışıyor

| Kapanan | Nasıl | Kanıt |
|---|---|---|
| E.1 "yükleme çalışıyor" → **wired** | Yetki eylem sınıfıyla: `ui/server/src/gates.ts` her dava yolunda onay politikasını soruyor; `runtime.allow_actions` yalnız çekirdek kontrolü; politikaya `case_intake` kapısı eklendi; hukuk konsolu adlandırılmamış bir sınıfla açılmayı reddediyor | `gates.test.ts` 5, `legal-routes.test.ts` uçtan uca HTTP: dağıtılan manifestle `POST cases` 201, `POST actions/cycle` 403 |
| Tek dava kimliği | `LEGAL_CASE_ID_PATTERN` tek kaynak; kas aynı metni restate ediyor ve testi eşitliği pinliyor; adapter'daki `case_` öneki kalktı | Adapter 22 test, golden yenilendi; duman: artifact `packs/legal/cases/sak-24-001` |
| Konsol adapter'a tam girdi | `startLegalInventory` tutanağı (`intake`), manifestin `exclude_roots`'unu ve `cycle_id`'yi geçiyor | Rota testi argv'yi pinliyor; duman: 5/5 olayda `learnedAt`, `Ikke laste opp` dışlanmış, `case.cycleId` dolu |
| Adapter kaydı otomatik | Konsol açılışta `aria tool register`; `/health.legal` registry'nin cevabı; kayıtsızken envanter 409 sebebiyle | `legal-readiness.test.ts` 6; duman: git'siz kökte sıfır operatör komutuyla `registered`, `tool list` SHADOW |
| Okuma sınırında doğrulama (E.1 "makine verified yazamaz" → artifact da korunuyor) | `ui/shared/legal-artifact-validate.ts` sekiz artifact'ı şemaya göre doğruluyor; `verified` taşıyan makine artifact'ı `statement_provenance_invalid`; bilinmeyen adapter sürümü `legal_artifact_version_unknown`; alım tutanağı satırları cast değil parse | `legal-artifact-validate.test.ts` 4 (golden'lar geçiyor, elle `verified` reddediliyor), `legal.test.ts` 6 |
| Tutanak kimliği | `x-aria-actor` başlığı kaldırıldı; `createdBy`/`receivedBy` = doğrulanmış principal | Duman: sahte başlıkla `createdBy: console-token-holder` |

Ölçülen ve kayda geçen: `integrity migrate-tools-bootstrap` git'siz çalışma alanını
reddediyor (`repo_resolution_failed`), `tool register` boş kökü kendisi kuruyor; bootstrap
adımı bu yüzden yok ve testi bunu pinliyor.

Faz 1'in **yapmadığı**: kimlik hâlâ tek token (operator rolü; Faz 4), karar defteri yok
(Faz 5), alım zinciri imzasız (Faz 2), kronoloji/çelişki kusurları duruyor (Faz 3).

### F.2 — Faz 2: alım tutanağı kanıt oldu

| Kapanan | Nasıl | Kanıt |
|---|---|---|
| L-05 (E.1 "zincir düzenlemeyi tespit ediyor" → **wired**) | `ui/server/src/ledger.ts`: her satır Ed25519 ile imzalı (anahtar volume'da, ilk açılışta 0600 ile üretiliyor, imajda değil); defter yanında imzalı **baş taahhüdü** (satır sayısı + son hash); ekleme dava başına sıralı; hüküm `empty/intact/broken` + `anchored`; açık anahtar `/health`'te | `ledger.test.ts` 6, `legal-intake.test.ts` 16; duman: 12 satır (8 eşzamanlı) `intact`+`anchored`; kuyruk kesme → `head_mismatch:truncated`; kusursuz hash'le yeniden zincirleme → `signature_invalid` satır 0; boş dava → `empty` |
| L-32 eşzamanlı alım | Ekleme kuyruğu defter başına; kuyruk kritik bölümün içinde okunuyor | Test: 12 eşzamanlı yükleme → 12 satır, intact; duman: 8 eşzamanlı |
| L-31 alım↔envanter mutabakatı | Tutanak satırı **rename'den önce** yazılıyor; tutanak koşuma sha256 ile gidiyor; adapter arşivi tutanakla birleştiriyor: `document_without_receipt` ve `intake_hash_mismatch` bulgu, kaybolan belge `coverage.reconciliation`'da; üçü de kapsamayı `complete:false` yapıyor | Adapter mutabakat testi (denetimin b+c/a+b senaryosu, hash sapması, temiz durum); duman: arşive kaçak konan dosya adlandırıldı, `complete: False`, kernel koşumu `ok` |
| L-34 kopya kimliği | Bayt-eş dosyalar tek belge; kopyada `duplicateOf`; sürüm çatışması yok; türetilen kayıt bir kez; `coverage.distinctDocuments` | Adapter testi (notat/kopi, brev/kopi_av_brev); duman: `kopi_av_avtale.txt → duplicateOf` |
| Tutanak şeması | `schemaVersion: 2` (+`keyId`, `signature`); eski satır okuma yolunda `intake_ledger_invalid` ile reddediliyor | `legal-intake.test.ts` |

Yapılmayan: anahtar rotasyonu (tek anahtar; farklı `keyId` taşıyan satır `key_unknown` ile reddedilir),
tutanağın çekirdek bütünlük indeksine girmesi (G-5, çekirdek), yedek/geri yükleme tatbikatı (Faz 7).

### F.3 — Faz 3: mekanik katman gerçek arşivi okuyor

| Kapanan | Nasıl | Kanıt |
|---|---|---|
| L-07 (E.1 kronoloji → **wired**) | Satırdaki **her** tarih metin sırasında kayıt (`datedMentionsInOrder`); etiket satırları giriyor; e-posta başlık satırları girmiyor | Golden: "Milepæl 1 levert 05.02.2024, godkjent 08.02.2024" → iki olay; "Fakturadato: 12.03.2024" `page:1` olay |
| L-20 | `records/deadlines.ts`: `DEADLINE` (etiket/ifade + ipucu), `PROCEDURAL_STEP` (belge + fiil + tarih); göreli süre **tarihsiz** DEADLINE, asla hesaplanmaz | 7 test; golden: 3 DEADLINE (biri "innen 14 dager" tarihsiz), 1 PROCEDURAL_STEP ("klage inngitt") |
| L-17 | `records/roles.ts`: rol yalnız belge etiketlediğinde (parantez, etiketli satır, "v/ advokat") satır kanıtıyla; gövde "Fra:/Til:" → `WAS_SENT_BY/RECEIVED_BY`; her taraf `PARTY_IN` | 6 test; golden: Kari Nordmann `advokat` rolü, klage DOCX gövdesinden 1 sent + 1 received bağı, 7 PARTY_IN |
| L-16 (E.1 taraflar) | `LegalParty.basis`, `organisationNumber`, `roleEvidence`; org.nr artık alias değil; Parties sekmesi basis/org.nr/rol sütunları ve doğru başlıklarla | Adapter testi; şema + doğrulayıcı (`roles[]` her satırı `roleEvidence` ile desteklenmeli) |
| L-10 (kapsam), E.1 "çelişki yalnız Label: value" | `fact-index.ts`: tab satırları (XLSX/DOCX tablo, para sütunu başlıktan), bölünmüş etiket/değer, rakamlı etiket, düz metin tutar (önündeki ad); okunamayan belge **adıyla** hedef | 26 test |
| L-35 konu çapası (E.1 "etiket çakışması") | Çelişki için paylaşılan referans anahtarı şart (atıf + dosya adından öz-anahtar); **konu arşivdeyse** yalnız konunun kendi beyanı ile ona atıf yapanlar arasında, konunun söylemediği etiket çelişki değil; konu yoksa atıf yapanlar arasında **değer başına bir satır** | Korpus: 30 alakasız fatura → 0; 300 mektup + sözleşme → 4 satır (eskiden 44.850 çift) |
| L-33 çıktı hacmi | Koşum başına tavanlar (`MAX_*_PER_RUN`) + `coverage.truncated` | Ölçek testi: 3.001 belge, 2,0 s, 1,5 MB stdout (tavan 12 MiB) |
| L-12, L-26 (korpus) | `arias/legal/corpus/` etiketli, üreteçten (`tools/make-corpus.mjs`), gerçek isim yok; `records/precision.test.ts` manifestin `precision_min`/`critical_false_positives_max` eşiğine karşı **ölçüyor**; `instances.test.mjs` korpusu arıyor | precision 1.000, recall 1.000 (4/4 planted); CI listesinde |

Yapılmayan: OCR (kapsam dışı), cümle düzeyi sürüm farkı (kayıtlı sınır), tarih için düz metin
etiketi (yalnız tutar), anahtar rotasyonu.

### F.4 — Faz 4: kimlik, avukat kapısı, matter duvarı, erişim defteri

| Kapanan | Nasıl | Kanıt |
|---|---|---|
| L-28 kimlik (E.1 "manifest uygulanıyor" → kapılar **soruluyor**) | `principals.ts`: volume'daki principals dosyası (id, ad, rol, token digest, dava ataması); ilk açılışta paylaşılan token'ın operatörüyle tohumlanır, başkası uydurulmaz; 0600; bozuk şekil fail-closed. `principals-cli.ts`: ekle (token **bir kez** basılır, yalnız digest saklanır), listele, iptal et. `auth.ts` token'ı sabit zamanda tek principal'a çözer; `x-aria-actor` kalktı | `principals.test.ts` 5, `auth.test.ts` 5; duman: 0600, CLI ile avukat, iptal → 401 |
| L-22 matter duvarı | Principal yalnız atanmış davaları görür; başka dava her rotada 404 (varlığı doğrulanmaz), listede yok; atanmamış dava açma 403 `case_not_assigned` | `legal-routes.test.ts`; duman: avukat listede bir dava, diğerine 404, üçüncüyü açma 403 |
| Avukat kapıları (NEW-approval-gates-unenforced) | Beş avukat sınıfı avukat principal'ında açık, operatörde kapalı (`/me.permissions`) | Duman: `statement_verification` avukat True / operatör False |
| Erişim defteri (L-28 "okuma denetimi yok") | Dava başına `access.jsonl`, tutanakla aynı imzalı/taahhütlü defter; her dava kapsamlı istek **cevaplanmadan önce** yazılır; reddedilen denemeler de (o davanın defterine, durum koduyla); anahtar yoksa okuma reddedilir | Route testi: defter `intact`+`anchored`; duman: zincir doğru, kari'nin 404 denemeleri diğer davanın defterinde |
| L-24 (PII maskesi) | `maskLegalPath`: stdout'ta `/cases/[case]/documents/[document]`; 5xx ayrıntısı loglanmaz | `log.test.ts` 3; route testi her hukuk yolunu sürüp dava id / dosya adı / başlık aramıyor; duman: 24 istek satırı temiz |
| Hukuk konsolu principals dosyasız açılmaz | `config.ts`: `surface.console.modules` legal içeriyorsa `ARIA_UI_PRINCIPALS_FILE` şart | `loadConfig` ConfigError; compose `/data/legal/principals.json` |

Yapılmayan: principals dosyası açılışta okunur (yeni kişi için yeniden başlatma; compose `restart` politikası); SPA'da yalnız
kimlik rozeti (Faz 6'da rol bazlı kontroller); anahtar/token rotasyonu; okuma denetiminin konsolda görünmesi (Faz 6).

