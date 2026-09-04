# new-aria — Ürün Tanımı ve Teknik Sınırlar

Durum: NORMATİF (ürün kapsamı ve sınırlar için). Çalışma zamanı davranışında
`aria-kernel` kodu ve `docs/aria/CONTRACTS.md` kazanır; bu belge **neyin çekirdek,
neyin kas olduğunu** ve **kasların çekirdeğe nasıl takıldığını** tanımlar.
Anahtar sözcükler (ZORUNLU, YASAK, GEREKİR, MAY) RFC-2119 anlamındadır. Her kural bir
kimlik taşır (`P-*` ürün, `B-*` sınır, `X-*` uzatma noktası, `G-*` çekirdek boşluğu)
ki plan, test ve bulgu metinleri ona atıf yapabilsin.

---

## 0. Tek cümle

**new-aria = değişmeyen bir ARIA çekirdeği + üstüne takılan bağımsız alan kasları.**

Çekirdek, alan bilmez: kanıt disiplini, hash-zincirli hafıza, basınç, yargı/konsensüs,
yakınsayan plan, insan-gerekli eskalasyon, profil/kesici güvenliği. Kas (`pack`),
bir alanın gözlerini ve dilini getirir: hangi külliyat (corpus) okunur, hangi kayıt
türleri vardır, hangi mekanik adapter'lar kanıt üretir, hangi ajanlar hangi rollerde
yargılar, arayüz hangi projeksiyonları gösterir.

| Kas | Külliyat | Nerede çalışır | Durum |
|---|---|---|---|
| `aquaculture` (kod) | aquaculture monorepo'su | monorepo'daki mevcut ARIA (`aria-kernel/`) | canlı; **bu repoda kalır**, taşınmaz |
| `legal` (hukuk) | dava dosyası arşivi | new-aria (`packs/legal/`) | **ilk hedef** (bu belgenin §5'i) |
| kod-yazma / iyileştirme | herhangi bir git deposu | new-aria | sonra; monorepo ARIA'sının kod kasları buradan genelleştirilecek |

---

## 1. Ürün ilkeleri (P-*)

- **P-1 Kanıt, iddia değil.** Her kayıt, külliyatta içerik hash'iyle sabitlenmiş bir
  kanıta bağlanır. ARIA'nın kendi çıktısı asla kanıt olamaz (SPEC L1). Kas bunu
  değiştiremez; sadece hangi kaynak türlerinin kanıt sayıldığını **daraltabilir**.
- **P-2 İnsan doğrulaması kazanılır.** `verified` benzeri bir durum yalnız insanın
  kayıt ettiği bir doğrulama olayıyla oluşur. Hiçbir adapter ve hiçbir ajan bunu
  üretemez (legal-contract `StatementStatus`).
- **P-3 Görmediğini söyle.** Külliyattaki her dosyanın bir kaderi (fate) vardır:
  okundu / yalnız metadata / okunamadı / dışlandı. Okunamayan dosya sessizce
  atlanmaz; **Unknown** basıncına dönüşür (SPEC §3).
- **P-4 Alan bilgisi yorumdur, olgu değil.** `kindGuess`, kimlik eşleştirme, tarih
  çıkarımı gibi çıkarımlar güven skoru ve `humanReviewRequired` ile taşınır. Aynı
  isimli iki kişi asla otomatik birleştirilmez.
- **P-5 Çekirdek, kasın alanını öğrenmez.** Çekirdek koduna alan sözcüğü girmez
  (`FarmStatus`, `dava`, `tenant` vb.). Alan sözcüğü yalnız `packs/<kas>/` altında
  ve o kasın manifestinde yaşar.
- **P-6 Her şey `new-aria/` içinde.** Kas, arayüz, Docker, testler, belgeler: hepsi bu
  klasörde. Aquaculture klasörlerine new-aria'ya ait tek dosya girmez; monorepo'ya
  yapılan tek dokunuş, kendi kapılarının bu klasörü *görmezden gelmesi* içindir.

---

## 2. Çekirdek (değişmeyen ARIA) — B-* sınırları

Çekirdek = `aria-kernel/aria_kernel/**` + `tools/aria-poc/**` (executor) +
`docs/aria/{SPEC,CONTRACTS,IDENTITY}.md` yasaları. Kaynağı monorepo `origin/main`
üzerindeki ARIA'dır; new-aria bunun bayt-eş kopyasıyla başlar.

- **B-1 Çekirdek alan-bağımsız kalır.** Çekirdeğe yapılan her değişiklik ya (a) bir
  kasın ihtiyaç duyduğu **genel** uzatma noktasını açar (§3), ya da (b) monorepo
  ARIA'sında da geçerli bir kusuru düzeltir. Alan-özel mantık çekirdeğe giremez.
- **B-2 Çekirdek deltaları izlenir.** Kopya ile monorepo ARIA'sı arasındaki her fark
  `docs/product/CORE-DELTAS.md` dosyasında satır satır listelenir (dosya, gerekçe,
  monorepo'ya geri taşındı mı). Liste boşsa kopya bayt-eştir.
- **B-3 Üç yasa kasla pazarlık edilmez.** L1 kanıt, L2 külliyatı koruma (kas külliyatı
  asla değiştirmez; hukukta bu, dava dosyasına yazmamak demektir), L3 operasyonel
  güvenlik (gizli veri/PII sızmaz; kill-switch her adımda). Kas manifesti bu yasaları
  yalnız **daraltabilir**.
- **B-4 Durum yalnız deklare yüzeylere yazılır.** Her defter `state_manifest`'te
  deklare edilir; deklare edilmemiş yüzey fail-closed reddedilir. Kas defterleri de
  bu kuraldan geçer (bkz. X-5).
- **B-5 Profil merdiveni ve kesiciler evrenseldir.** `observe/standard/strict/frozen/
  autonomous`, maliyet/başarısızlık kesicileri, `ARIA_STOP` — kas bunları
  gevşetemez; yalnız kendi eylem türlerini bu izinlere **bağlar**.
- **B-6 LLM çıktısı veridir.** Ajan yanıtı `aria/agent-response/v1` zarfıyla gelir,
  kanıt referansları snapshot hash'inde yeniden doğrulanır (`evidence_validator`).
  Kas ajanları da aynı zarftan geçer; kasa özel yanıt biçimi `details.records`
  içinde taşınır, zarfın dışında değil.

---

## 3. Kas (pack) sözleşmesi — X-* uzatma noktaları

Bir kas, `packs/<id>/pack.json` manifestiyle tanımlanır (`$schema: aria/pack/v1`).
Manifest **veridir**; çekirdek onu okur, kas kodu çekirdeğe import edilmez.

| Nokta | Kasın getirdiği | Çekirdeğin bugünkü durumu | Boşluk |
|---|---|---|---|
| **X-1 Külliyat kaynağı** | `corpus_source.kind` (`git_repository`, `document_archive`, …) ve kök dizin | Discovery yalnız git/dosya sistemi yürüyüşü bilir; dosya kaderleri genel | `document_archive` için kader sınıfları (`text/metadata_only/unreadable/excluded`) çekirdek FATES şemasına eşlenmeli → **G-1** |
| **X-2 Adapter'lar** | `*.tool.json` manifestli mekanik alt-süreçler (stdin JSON → stdout JSON) | Var ve genel (`tool_registry`, `tool_runner`) | manifest `runner.argv`'de `tools/gates/tsconfig.json` sabiti; kas kendi tsconfig yolunu verebilmeli → **G-2** |
| **X-3 Ajanlar ve roller** | `packs/<id>/agents/aria-<id>-*.md` + rol adları | `agent_surface.DEFAULT_TARGET_AGENT_WHITELIST` ve `REQUEST_ROLES` **kapalı** listeler | kas manifestinden hedef/rol yükleme → **G-3** |
| **X-4 Kayıt ve iddia sözlüğü** | `record_kinds`, `claim_types`, `evidence_source_types` | `finding.CLAIM_TYPES` ve kanıt `source_type` allowlist'i kod-alanına sabit | manifestten sözlük birleştirme (çekirdek sözlüğü + kas sözlüğü) → **G-4** |
| **X-5 Defterler / yüzeyler** | kasın yazacağı yüzeyler (ör. `packs/legal/cases/...`) | `state_manifest` kapalı, fail-closed | manifest `artifacts`/`surfaces` bloğunun `state_manifest`'e yüklenmesi → **G-5** |
| **X-6 Arayüz modülü** | `ui/web/src/features/<id>/` + `ui/shared/<id>-contract.ts` | Konsol (`ui/`) kas-farkında: çekirdek görünümleri + kas modülleri | yok (bu belgeyle kuruldu) |
| **X-7 Basınç kaynakları** | kasın basınç kaynağı adları ve ağırlıkları | `pressure.SOURCE_WEIGHTS` sabit; operatör override'ı var | manifest kaynağı → ağırlık tablosuna ekleme → **G-6** |

**Kural X-0:** Bir kas yalnız bu yedi noktayı kullanır. Başka bir yerden çekirdeğe
dokunma ihtiyacı doğarsa bu, yeni bir uzatma noktası (yeni `X-*`) demektir ve
önce bu belgeye, sonra `state_manifest`/ilgili SSoT'ye, sonra teste yazılır.

### 3.1 Çekirdek boşlukları (G-*) — sahip ve kapanış ölçütü

Bugünkü çekirdek yedi noktanın üçünü (X-2 adapter'lar, X-6 arayüz, kısmen X-1)
zaten sağlar; dördü kapalı listelerle kod-alanına kilitlidir. Her boşluk bir
sahiple ve makine-denetlenebilir kapanış ölçütüyle izlenir:

| ID | Boşluk | Kapanış ölçütü | Sahip |
|---|---|---|---|
| G-1 | `document_archive` külliyat kaderleri FATES'e eşlenmiyor | `discovery run` bir belge arşivinde `COMPLETION_PROOF.complete=true` üretir ve okunamayan dosyalar `unknown` yerine `metadata_only/unreadable` kaderi taşır | çekirdek |
| G-2 | adapter runner tsconfig yolu sabit | `pack.json.adapters[].runner` doğrudan kullanılır; kas adapter'ı `tools/gates/` olmadan koşar | çekirdek |
| G-3 | ajan hedef/rol listeleri kapalı | `agent_surface` manifestten yüklenen hedefi kabul eder; testi: `aria-legal-evidence-judge` hedefli istek reddedilmez | çekirdek |
| G-4 | claim/evidence sözlükleri kod-alanına sabit | `finding.emit_finding` kas `claim_types` ile kabul eder; `source_type=document_reference` L1 gate'inden geçer | çekirdek |
| G-5 | kas yüzeyleri `state_manifest`'e girmiyor | `append_declared_jsonl` kas yüzeyine yazar; deklare edilmemiş yüzey hâlâ reddedilir | çekirdek |
| G-6 | basınç kaynakları sabit | kas kaynağı `run_pressure` skorlamasına girer | çekirdek |
| G-7 | `cycle run` sonucu `datetime` içerdiğinde JSON serileştirme çöküyor (konteyner sondasında ölçüldü, `cli.py` `_main` json.dumps) | `cycle run` çıkışı her yolda geçerli JSON; regresyon testi | çekirdek (monorepo'ya geri taşınır) |
| G-8 | Misyon tohumu ve ürün uygunluk tüzüğü aquaculture'a özgü: `aria-config/product_fitness_charter.json` operatörün aquaculture beyanıdır; `service_mission_refused` olayları `auth/billing/farm/sensor-service` adlarını arar (konteyner sondasında ölçüldü) | tüzük ve misyon tohumu kas manifestinden gelir; aquaculture dışı bir külliyatta hiçbir aquaculture servis adı üretilmez | çekirdek + kas |
| G-9 | `tool_runner._runner_missing_node_deps` tasarım gereği yalnız **repo-yerel** `node_modules/ts-node` kabul eder; `node_modules` taşımayan çalışma alanında her TS adapter `environment_unavailable` (konteyner sondası; imajdaki global kurulum sayılmaz) | kas manifesti runner bağımlılığını bildirir ve runner onu çalışma alanından bağımsız çözer; Docker tohum/duman çalışma alanı imajın `node_modules`'ünü bağlar (kapatıldı: `scripts/docker/{seed,smoke}.sh`) | çekirdek + Docker |
| G-10 | Aquaculture adapter'ları alan kökü yokken çöküyor: `event-contracts-adapter` → `scan root does not exist: libs/event-contracts/src` (crash, cycle `integrity_failed`) | adapter, deklare kapsamı yoksa `scope_absent` ile temiz çıkar; aquaculture adapter'ları `packs/aquaculture/` altına taşınır ve yalnız o kas etkinken kaydedilir | kas (aquaculture) |
| G-11 | `agent-harness-security-adapter` bulguları `evidence` dizisi yerine `ref` taşıyor; validator `finding_evidence_missing` + `evidence_outside_declared_read_paths` + `evidence_outside_snapshot` ile `evidence_error` veriyor (25 hata, konteyner sondası) | adapter çıktısı CONTRACTS §6 kanıt şekline uyar; monorepo ARIA'sında da doğrulanmalı | çekirdek (monorepo'ya bildirilecek) |
| G-12 | `narrative-prompt-lint.ts` (2000 token) ile `narrative_prompt_validator.py` (tier-3: 3500) bütçeleri ayrışmış; TS ayna SSoT'den sapmış | tek bütçe kaynağı (kernel), TS lint onu okur; legal prompt'ları her iki yoldan da geçer | çekirdek (monorepo'ya bildirilecek) |
| G-13 | v12 ops `NotificationsAreAudited` (`'deduped' != 'sent'`) monorepo'da da kırmızı | testin ve `notify` dedup davranışının SSoT'si netleşir; monorepo'da düzeltilip kopyaya taşınır | çekirdek (monorepo'ya bildirilecek) |
| G-14 | Kas adapter manifesti keşfedilmiyor: registry yalnız `tools/aria-adapters/*.tool.json` okur (`cycle.py:2578`, `registry_compiler.py:37`, `capability_gap.py:167`); `packs/*/pack.json` ve `arias/*/aria.manifest.json`'ı çekirdekte hiçbir şey okumaz (hukuk envanteri, 2026-09-04) | `tool_manifest_sync` kas manifestlerini de okur; hukuk örneğinde `aria tools list` `legal-document-inventory`'yi gösterir ve `cycle run` onu koşturur | çekirdek |
| G-15 | Yargı zarfını tüketen tek yol `tools/aria-poc/ci_executor.py --drain` (GitHub Actions); `CYCLE_PHASES`'te drain fazı yok, konsol drain eylemi açmıyor, hukuk compose profili executor tanımlamıyor (`dispatcher_factory.py:12-30`) | Hukuk konteynerinde bir yargıç zarfı açılır, tüketilir ve `ai_judge` satırı defterlere düşer | çekirdek + dağıtım |
| G-16 | Bellek isim-alanı reddeden kapı değil; matter duvarı `enforced_by: instance_isolation` ile örnek yalıtımına dayanıyor | İki karşıt matter'lı testte arama/indeks/cache/özet/log/export sızıntısı sıfır | çekirdek |
| G-17 | `evidence_trust.classify_evidence_ref` git blob'una bağlı: `target_sha=None` → `baseline_unavailable`; belge arşivinde hiçbir kanıt `repo_verified` olamaz (G-1 FATES eşlemesinden ayrı ve ondan ağır) | İçerik-adresli kanıt (`sha256` eşleşmesi) `repo_verified` ile aynı sınıfta kabul edilir | çekirdek |

Boşluk kapanmadan kas, o noktayı **kullanamaz**; kas o noktayı taklit eden paralel
bir mekanizma da **yazamaz** (P-5, B-4). Legal kasının ilk sürümü bu yüzden yalnız
X-2 (adapter) ve X-6 (arayüz) üzerinden çalışır; kayıtlarını adapter artifact'ı
olarak üretir, çekirdek defterlerine G-5 kapanınca girer.

---

## 4. Konsol (ui/) sınırları

- Konsol **projeksiyondur**: defterleri okur, hash doğrulamasını çekirdeğe
  (`integrity verify`) bırakır, mutasyonları kernel CLI'ya delege eder
  (`ui/shared/api-contract.ts`).
- Kimlik: operatör token'ı (`ARIA_UI_TOKEN`), yalnız `Authorization` başlığında.
  Mutasyon uçları yalnız `ARIA_UI_ALLOW_ACTIONS=1` ile açılır.
- Kas modülü, kasın kontratını (`ui/shared/<kas>-contract.ts`) import eder; kontrat
  dışı alan göstermez.

---

## 5. İlk kas: Legal Case Intelligence (`packs/legal/`)

### 5.1 Amaç ve amaç-dışı

Amaç: bir dava dosyası arşivini **kanıt-bağlı, insan-doğrulamalı çalışma setine**
dönüştürmek: envanter, sürüm soy ağacı, kronoloji (olay tarihi ≠ öğrenilme tarihi),
taraflar, iddia–kanıt matrisi, kapsama.

Amaç-dışı (P-* ile bağlayıcı): hukuki sonuç üretmek; taranmış PDF'lere OCR uydurmak;
anonimleştirmenin geri döndürülemezliğini garanti etmek; mahkemeye gönderilen
sürümü otomatik ilan etmek; Norveç hukuku prosedürünü uygulamak. Bunlar
`humanReviewRequired` ve "avukat doğrulaması gerekir" ifadesiyle insana bırakılır.

### 5.2 Kayıt sözlüğü

`ui/shared/legal-contract.ts` normatiftir: `LEGAL_RECORD_KINDS` (CASE, PARTY, ROLE,
DOCUMENT, DOCUMENT_VERSION, COMMUNICATION, EVENT, CLAIM, COUNTERCLAIM, EVIDENCE,
PROCEDURAL_STEP, DEADLINE, DECISION, FINANCIAL_LOSS, ACCESS_PERMISSION),
`LEGAL_LINK_KINDS` (SUPPORTS, CONTRADICTS, SUPERSEDES, WAS_RECEIVED_BY, WAS_SENT_BY,
CAUSED, REFERS_TO, REQUIRES, PARTY_IN, VERSION_OF), `STATEMENT_STATUSES`
(asserted, disputed, supported, contradicted, unverifiable, verified),
`ASSERTION_SOURCES`, `EXTRACTION_STATUSES`. JSON şemaları `packs/legal/schemas/`.

### 5.3 Bileşenler

| Bileşen | Tür | Ne yapar | Ne yapmaz |
|---|---|---|---|
| `legal-document-inventory` | adapter (X-2) | arşivi deterministik yürür; hash, tür tahmini, metin çıkarımı (yalnız metin dosyaları), tarih/tutar yakalama, sürüm gruplama, `.eml` başlıklarından taraf ve iletişim olayı; `coverage.json` | OCR, kişi eşleştirme, hukuki iddia üretimi |
| `aria-legal-evidence-judge` | ajan | bir `LegalStatement`'ı belgelerin hash'inde doğrular | hukuki görüş |
| `aria-legal-adversarial-judge` | ajan | karşı-kanıt, tarih uyumsuzluğu, sürüm aşımı arar | — |
| `aria-legal-timeline-analyst` | ajan | olay/öğrenilme kronolojisi; her olay kanıtlı | tarih uydurma |
| `aria-legal-claim-matrix-drafter` | ajan | taraf dilekçelerinden `asserted/disputed` satırlar, `missingEvidence` | `verified` |
| Konsol `features/legal` | arayüz (X-6) | dava, belge, sürüm, kronoloji, taraf, matris, kapsama | veri yazımı |

### 5.4 Kabul ölçütleri (ilk sürüm)

- Sentetik fikstür arşivinde adapter deterministik (iki koşum bayt-eş), kapsama
  `complete=true`, dışlanan kök kayıtlı, okunamayan dosyalar `unreadable/
  metadata_only` ve birer `unreadable_document` bulgusu.
- Konsolda dava görünür: belge envanteri, sürüm grubu, `.eml` tabanlı kronoloji,
  taraflar, boş iddia matrisi ("henüz ajan/insan yazmadı" durumu açık).
- Gerçek dosya kümesiyle çalışma yalnız operatör kontrolünde, tek dava kümesi,
  `Ikke laste opp` klasörü dışlanmış, harici AI erişimi kapalı (kullanıcı kararı).

---

## 6. Örnek katmanı (`arias/`) — türetilebilir taslak

Kas kod düzeyinde paylaşılır; **beden** çalışma zamanında ayrılır. `arias/` bu ayrımın
somut hâlidir: her ARIA kendi klasöründe durur, kendi defter kökünü, kendi belleğini,
kendi portunu ve kendi onay politikasını taşır.

```text
arias/
  instance.schema.json     örnek manifestinin sözleşmesi (aria/instance/v1)
  derive.mjs               tek komutla türetme
  instances.test.mjs       her manifesti ve türetmeyi doğrulayan kapı
  _template/               sade taslak; yeni ARIA buradan çıkar
  legal/                   ilk türetilmiş ürün: Hukuk ARIA'sı
```

Şablon altı dosyadan oluşur: `aria.manifest.json`, `docs/TANIM.md`, `config/approval-policy.json`,
`config/budget.json`, `ui/branding.json`, `docker/compose.profile.yml`. Fazlası yok; alan
bilgisi türetildikten sonra insan tarafından doldurulur.

Türetme:

```bash
node arias/derive.mjs finance "Finans ARIA" --port 8482
```

Betik yalnız iki ARIA'nın **asla aynı olamayacağı** alanları yeniden yazar: kimlik, bellek
isim-alanı, defter kökü, port, compose servis ve volume adları. Var olan bir örneğin üstüne
yazmayı reddeder. Geri kalan her karar (kaslar, külliyat, amaç-dışı) insana bırakılır.

**Örnek klasörü aynı zamanda satılabilir birimdir.** `AYRILABILIRLIK-VE-PAKETLEME.md`
`T-C`/`T-D` senaryolarında `arias/<id>` alt ağacı, ürünün tamamını temiz geçmişle dışarı
çıkarır; çekirdek bizde kalır ve alıcıya lisanslanır.

Kapılar `instances.test.mjs` içinde: manifest şemaya uyar, isim-alanı kimlikle aynıdır,
çapraz isim-alanı erişimi kapalıdır, port ve defter kökü benzersizdir, etkin kasın
`pack.json`'ı vardır, hiçbir kas kendi örneğinin dışına çıkmaz, ve şablon geçerli bir
örneğe türer.

## 7. Sonraki kaslar için şablon

Yeni kas eklemek = `packs/<id>/pack.json` + şemalar + adapter'lar + ajanlar +
`ui/shared/<id>-contract.ts` + `ui/web/src/features/<id>/`. Çekirdeğe dokunuş
gerekiyorsa önce §3.1'de bir `G-*` satırı açılır. Aquaculture kasının new-aria'ya
taşınması da aynı şablondan geçer: monorepo ARIA'sındaki repo-şekilli parçalar
(`.claude/agents/aria-*`, `tools/aria-adapters/*`) `packs/aquaculture/` altına
taşınır, çekirdek değişmez.
