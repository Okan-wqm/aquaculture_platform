# S01 uygulama günlüğü — taslak

> Durum: `IN_PROGRESS`  
> Son güncelleme: 2026-09-03  
> Bu dosya completion authority veya merge kanıtı değildir. CLI/raw-Git entegrasyonu ve bağımsız
> inceleme tamamlanınca doğrulanmış sonuçlarla güncellenecektir.

## Sınır

- Yalnız yeni ARIA yüzeyi oluşturuldu: `tools/new-aria-admission/`.
- Legacy ARIA kaynaklarında değişiklik yapılmadı ve yeni kod legacy runtime'a bağlanmadı.
- Bu sprintte commit, push, main merge veya deployment yapılmadı.
- Yeni TypeScript ve test dosyaları 250 satır sınırının altında tutuluyor. 2026-09-03 taze
  ölçümünde (`find … -print0 | xargs -0 wc -l | sort -nr`) en uzun kaynak 248, test 245
  satırdı. 2026-09-03 son ara ölçümünde en uzun kaynak 247, test 249 satırdır; kapanışta yeniden
  ölçülecektir.

## Uygulanan kontroller

- Closed/versioned event, evidence, operator authority ve projection sözleşmeleri; strict JSON,
  canonical byte ve SHA-256 bağları.
- Event başına ayrı evidence manifesti; sıra/state/version/time/predecessor bağı ve yalnız final
  `DONE` manifestinde completion kanıtları.
- Signed verification planından execution-free baseline/dossier bağımsız yeniden hesaplanır. Actual
  completion'ın ilk üç event/manifest byte'ı ve digestleri bu dossier history'siyle birebir olmalı;
  `DONE.previous_manifest_sha256` exact üçüncü digest'e bağlanır.
- Caller tarafından üretilemeyen admission projection brand'i ve immutable snapshot; plain/copy
  projection reddi.
- Completion admission mutation-free `PREPARED` capability, exact staged historical proof ve son
  canlı revalidation sonrası CAS olmak üzere üçe ayrıldı. Kopya prepared/proof/committed capability
  kalıcı state üretemez; aynı prepared capability için eşzamanlı veya ikinci commit reddedilir.
- External Ed25519 execution trust root'u, possession kanıtlı ve tek-session yaşam döngülü signing
  capability; key/principal ayrımı ve terminal revoke.
- Runner'ın pending sonucuna bağlı, session/run/context/nonce ile repository/workspace/base/head/tree
  ve tüm input/output/process evidence'ını imzalayan receipt sözleşmesi.
- Baseline + kayıtlı dört negative-control için exact beş-receipt roster. Baseline'ın dört nesnesi
  `[baseline, operator envelope, operator root, epoch snapshot]`; her kontrolün altı nesnesi aynı
  dört güven girdisi ile `[mutant document, mutated baseline]` eklerini exact sırada taşır.
- Receipt ve witness; raw input rosterı, reference-list/envelope digestleri, run context, external
  epoch provider identity/snapshot/revision/read time ve stdout/stderr digest+uzunluklarını bağlar.
  Baseline raw input context'i ve her kontrolün canonical stderr failure nesnesi ayrıca karşılaştırılır.
- Historical receipt doğrulaması ile live admission freshness ayrımı. Receipt zamanları imzalı
  authority penceresinde olmalı; live doğrulama ayrıca güncel saate göre expiry'yi reddeder.
- Portable historical completion verifier; authority süresi dolduktan sonra dahi exact authority,
  target, dört manifest/event, signed dossier planı, beş receipt, epoch snapshot, attestation ve CAS
  closure'ı yeniden doğrular. Projection `valid_from` yalnız doğrulanmış/imzalı artifact zamanlarının
  deterministik maksimumudur; unsigned provider `read_at` yalnız canlı checkpoint lower-bound kapısında
  kalır.
- Candidate kopyasından önce sayı/nesne/toplam byte limitleri, `SharedArrayBuffer` reddi ve immutable
  byte map.
- Exact reachable CAS closure: eksik, fazla/gizli, rolü yanlış veya tekrar kullanılan receipt/object
  reddi.
- Admission başlangıcında ve durable CAS hemen öncesinde yeniden saat/freshness/authority/evidence/
  receipt/attestation kontrolü ve immutable Git target revalidation çağrısı.
- Full-chain final tip için compare-and-set checkpoint; exact replay idempotent, farklı/stale tip
  fail-closed.
- Operator-signed checkpoint store ID/identity digest'i; explicit genesis, process-lifetime
  directory/identity FD ve dev/inode/owner/mode/link doğrulaması.
- External operator-signed current-epoch snapshot/provider identity; aynı canonical provider kökünde
  process ve normal restart boyunca monotonic revision anti-rollback kontrolü.
- Checkpoint publication state machine'i: valid pencere içindeki exact pre-link temp devam eder;
  süresi geçmiş pre-link state final üretmez; zaten hard-link edilmiş exact final yalnız publication
  cleanup/replay yoluyla kurtarılır. Claim ve record temp'leri canonical ad/byte/inode/link sayısıyla
  doğrulanır ve tüm IO held directory descriptor üzerinden yapılır.
- Recovery ham byte döndürmez: trusted store tarafından WeakMap-branded sonuç, exact immutable
  authority/evidence/version/manifest/history/projection tipini taşır. Final record veya claim'in
  link sonrası crash'ten kalan `nlink=2` temp'i yalnız canonical claim aynı tipi bağlıyorsa temizlenir.

## RED → GREEN kanıtları

| Dilim                       | Gözlenen RED                                                                            | Son doğrulanmış GREEN                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Execution signer            | Eski açık stdout fixture'ı closed verifier-report parserında 4 testi kırdı              | Önceki 4/4 GREEN; son production-fixture koşumu source/dist skew nedeniyle 4/4 RED    |
| Signing lifecycle           | Kopya capability, failed preflight burn, duplicate session ve terminal reuse mutantları | `execution-trust-lifecycle.spec.ts`: 11/11                                            |
| Receipt admission           | Raw mutant rol ikamesi, report-body/stdout eşitliği ve raw stderr substitution          | `execution-receipt-admission.spec.ts`: 4/4; `execution-stderr-admission.spec.ts`: 1/1 |
| CAS closure                 | Yanlış raw mutant rolü için regression önce kırmızıydı                                  | `evidence-object-closure.spec.ts`: 4/4                                                |
| Historical evidence         | Final `DONE` evidence'ının ara eventlerde reuse'u ve mutable verified graph mutantları  | `historical-evidence-binding.spec.ts`: 7/7                                            |
| Signed-plan history         | Re-signed fakat alternatif ilk üç transition metadata/history zinciri                   | CLI sahibinin focused comparator kümesi: 5/5                                          |
| Candidate snapshot          | Limit öncesi Map materialization ve mutable Map sızıntısı mutantları                    | `completion-candidate.spec.ts`: 4/4                                                   |
| Checkpoint store            | Genesis/replace/delete/hardlink/concurrency/deadline mutantları                         | `file-evidence-checkpoint-store.spec.ts`: 8/8                                         |
| Checkpoint crash states     | Yanlış scope'lu orphan testi ve nlink=2 kalıcı kilitlenme                               | Recovery/FD kümesi: 3 suite, 8/8                                                      |
| Execution/evidence identity | Execution key'inin evidence identity alias'ı olarak kullanımı                           | `trusted-completion-identity.spec.ts`: 1/1                                            |
| Context/authority           | Fake store/target, signed binding ve identity mismatch mutantları                       | Odaklı context/authority kümesi: 34/34                                                |
| Admission transaction       | Eski tek-adım API ve checkpoint-before-CANDIDATE boşluğu                                | `progress-admission-transaction.spec.ts`: 1/1; pozitif admission: 1/1                 |
| Portable historical proof   | Expiry sonrası live API bağımlılığı ve caller-asserted `valid_from`                     | `historical-completion-proof.spec.ts`: 1/1                                            |
| Branded outbox recovery     | Ham recovery byte'ı ve final/claim `nlink=2` crash wedge'i                              | Expiry recovery: 1/1; linked-state odaklı: 2/2                                        |

En son yeniden çalıştırılan checkpoint crash/FD komutu:

```text
npx jest --config tools/new-aria-admission/jest.config.ts --runInBand \
  tools/new-aria-admission/test/file-evidence-checkpoint-recovery.spec.ts \
  tools/new-aria-admission/test/file-checkpoint-publication-state.spec.ts \
  tools/new-aria-admission/test/file-checkpoint-fd-race.spec.ts
PASS — 3 suite, 8 test, 43.933 s
```

`npx tsc -p tools/new-aria-admission/tsconfig.lib.json --noEmit` exit 0; checkpoint/identity
değişikliklerinin scoped ESLint çalışması da 0 error/0 warning verdi. Execution/evidence identity
regression'ı ayrıca 49.315 saniyede 1/1 GREEN tamamlandı.

Execution/session lane sahibi actual Git üzerinde finalized production beş-run testi için 1/1 GREEN
(484.32 s) bildirdi; baseline dört ve dört NC altı input nesnesi, exact process sonucu, signed receipts
ve terminal roster bu testte kapsandı.
Bu sonuç root tarafından yeniden çalıştırılana kadar sprint-wide kabul kanıtı sayılmaz.

Önceki signer yeniden doğrulaması 278.098 saniyede 4/4 GREEN tamamlandı. Ancak 2026-09-03 tarihli
son production-fixture koşumu 1.005,93 saniyede 4/4 RED oldu: dört test de imzalama öncesinde
`verifier process outcome differs from authenticated oracle result` hatası verdi. Çalıştırılan child
CJS 08:40 tarihliyken reviewed-ref/authority bağımlılıkları 10:15 sonrasında değişmişti; bu nedenle
güncel kaynaklarla temiz build ve frozen-tree tekrar koşumu kapanış kapısıdır. Bu RED imza doğrulama
veya one-shot assertion'a henüz ulaşmadı ve GREEN diye raporlanmayacaktır. Uygulama sırasında ayrıca
receipt validator'ın canonical report gövdesi digest'ini newline-delimited stdout digest'ine eşitleyen
yanlış varsayımı bulundu. Ayrık signed alanlar korunarak equality kaldırıldı; focused regression önce
`execution output digest mismatch` RED, ardından receipt admission kümesinde 4/4 GREEN oldu. Bu kayıt
yerel implementation finding'idir; canonical `ARIA-AUDIT-*` kimliği tahsis edildiği iddia edilmez.

Checkpoint recovery incelemesinde ilk orphan testi production scope'u kopyalamadığı için false-positive
çıktı. Production ve test aynı exported stable-scope helper'a geçirildi; exact claim filename/tek claim,
conflicting bytes ve gerçek orphan retry test edildi. Sonraki saldırıda temp→hard-link→crash'ın nlink=2
dosyayı kalıcı kilitlediği bulundu; yukarıdaki state-machine testleriyle kapatıldı.

Son düşmanca tur, claim adının evidence version'a bağlı olması nedeniyle aynı stable work-unit için
iki process'in farklı versionlarla iki ayrı final tip yazabildiğini gösterdi. Scope-wide tek claim,
claim sonrası current-tip reread ve birden fazla final record varsa fail-closed değişikliği yazıldı.
İki gerçek child process kullanan regression'ın ilk koşusu yanlış TS config, ikinci koşusu ise 15 saniyelik
cold-start bütçesi nedeniyle marker'a ulaşmadan test-harness timeout verdi; 60 saniyelik bounded harness
hazırdır fakat D0 tam kapısı bittikten sonra GREEN yeniden koşum henüz yapılmamıştır.

Checkpoint record'una exact LF-framed projection artifact byte'ları ve raw digest'i birlikte bağlayan
durable outbox kodu da yazıldı. Recovery yolu yalnız historically signature-verified authority, signed
checkpoint identity, stable work-unit ve unique exact stored tip kimliğiyle branded aynı byte'ları döndürür;
event/manifest/object/attestation kaynaklarına veya wall-clock freshness'a ihtiyaç duymaz, yeni admission
ya da CAS açmaz. CLI bu kontrolü tarihsel authority ve trusted store açıldıktan hemen sonra, target ile
canlı evidence kaynakları okunmadan önce çalıştıracak şekilde bağlandı; hit durumunda idempotent
exact-byte writer'a gider. Expiry recovery 1/1, linked claim/record cleanup 2/2 ve fresh lib typecheck
exit 0 ile doğrulandı.

Arşivlenmiş bundle incelemesi için live wall-clock currentness'tan ayrı pure historical verifier eklendi.
Bu API yeni admission/checkpoint açmaz ve bundled projection byte'ını bağımsız yeniden hesaplar. Focused
test authority expiry sonrası aynı exact artifact'i doğruladı; yalnız asserted `valid_from` değiştirilip
marker yeniden üretildiğinde reddetti.

Raw Git preflight incelemesinde iki ayrı CPU/IO büyütme yolu bulundu. Commit parser'ı her yeni parent
için `Array.includes` çağırarak 49.999-parent girdisinde karesel çalışabiliyordu; 256 parent üst sınırı
ve `Set` tabanlı linear uniqueness kontrolü eklendi, duplicate reddi korundu. `objects/info` tarayıcısı
ise 4.096 limitini her alt dizinde sıfırlayarak yaklaşık 4.096² entry ziyaretine izin veriyordu; root ve
tüm doğrudan alt dizinlerin paylaştığı tek 4.096-entry bütçesine geçirildi. 257-parent ve iki alt dizinde
toplam N+1 entry regression'ları önce yazıldı; ilgili iki suite 23/23 GREEN oldu. Bunlar yerel
implementation finding'leridir; canonical `ARIA-AUDIT-*` kimliği tahsis edildiği
iddia edilmez.

## Yerel implementation finding kayıtları

Bu kimlikler yalnız S01 çalışma günlüğüne aittir; canonical ARIA finding kimliği veya closure beyanı
değildir.

| Kimlik                           | Seviye | Kök neden / RED                                                                                                                                                                   | Uygulanan kontrol / GREEN durumu                                                                                                                                                                                                                                               | Residual / sahip                                                                                                                                                                                                                                                        |
| -------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `S01-LOCAL-REF-GRAMMAR`          | P2     | `reviewed_ref` regex'i trailing slash, `//`, hidden segment, `.lock`, `@{`, control ve Unicode değerleri Git/portable-ASCII sözleşmesine aykırı biçimde kabul ediyordu.           | Segment tabanlı closed Git-ref grammar ve geçerli nested-ref pozitifleri eklendi; güncel odaklı koşum 11/11 GREEN.                                                                                                                                                             | Yok; current ve historical aynı parserı kullanır.                                                                                                                                                                                                                       |
| `S01-LOCAL-DIR-BOUND`            | P1     | Checkpoint/current-epoch/bundle/snapshot rosterları `readdirSync` ile limiti kontrol etmeden önce tüm dizini belleğe alıyordu.                                                    | Tek incremental `BoundedDirectoryEntryBudget` SSoT'si ve recursive global bütçe bütün production roster çağrılarına bağlandı; `rg readdirSync tools/new-aria-admission/src` boş. Helper/current-window odaklı ara koşum 3/3; adapter N+1 mutantlarının frozen rerunu bekliyor. | Flat checkpoint kökü 4.096 toplam entry'de fail-closed capacity cliff üretir; sharding/index S03.                                                                                                                                                                       |
| `S01-LOCAL-REPO-ORDER`           | P1     | Completion recovery checkpoint store'u açıp crash temp'lerini değiştirebildikten sonra gerçek repository root overlap'ini denetliyordu.                                           | Authenticated target veya exact CANDIDATE/COMPLETE içinden repository root önce çözülüyor; lexical ve physical ayrım store construction/recovery/output reservation'dan önce çalışıyor. Recognized linked-temp no-effect dahil completion path matrisi 7/7 GREEN.              | Store/ref atomik fencing S03/S18.                                                                                                                                                                                                                                       |
| `S01-LOCAL-PATH-ALIAS`           | P1     | Lexical ayrım symlink/physical alias ile repository veya input altına output/bundle/checkpoint/epoch yazılmasını engellemiyordu.                                                  | Canonical mutation path, realpath ve dev/inode ancestor karşılaştırmalı ortak boundary eklendi; destination-destination ve destination-input fiziksel overlap fail-closed.                                                                                                     | Bind-mount aliasını salt path API'si tam gözleyemez; ayrı mount namespace S18.                                                                                                                                                                                          |
| `S01-LOCAL-MUTATION-ROOTS`       | P1     | `run-verifier` ve current readback komutları caller-selected bundle/current-epoch/checkpoint köklerini reviewed repository'den ayırmıyordu.                                       | Bütün mutating command rootları Git target açılmadan önce ortak symmetric physical separation kapısından geçiyor; geçerli execution bundle kullanan command matrix 4/4 GREEN.                                                                                                  | Yok; historical komutlar bundle üzerinde salt okunurdur.                                                                                                                                                                                                                |
| `S01-LOCAL-TMPDIR`               | P1     | Git doğrulaması için private executable/repository snapshot `os.tmpdir()` altında yazılıyor; `TMPDIR` protected root içine yöneltildiğinde proof/source rosterı bozulabiliyordu.  | `runtimeTemporaryRoot()` hem command preflight hem iki gerçek materializer tarafından kullanılır. Yönlü kural repo'nun `/tmp` altında olmasına izin verir, temp root'un protected root içinde/eşit olmasını reddeder. Publication 4/4 ve completion path 7/7 GREEN.            | Private executable spawn-path same-UID swap tehdidi S18.                                                                                                                                                                                                                |
| `S01-LOCAL-OUTPUT-PROVENANCE`    | P1     | Public output'taki yabancı empty/PENDING-prefix dosya crash reservation sanılıp tamamlanıyor ve abort sırasında siliniyordu.                                                      | Public EEXIST yalnız exact final byte için idempotenttir. Resume için deterministic hidden full reservation sidecar ile public path aynı dev/inode ve `nlink=2` olmalıdır; publish/abort yalnız bu pair'i tüketir. Odaklı 7/7 ve full-command kill 1/1 GREEN.                  | Sidecar/public aynı-principal yarışına karşı ayrı UID/mount izolasyonu S18.                                                                                                                                                                                             |
| `S01-LOCAL-BUNDLE-PROVENANCE`    | P1     | Yabancı empty bundle dir veya hand-built staging/payload prefix'i ARIA crash kalıntısı sanılarak silinip yeniden kurulabiliyordu.                                                 | Provenance'siz PARTIAL state artık fail-closed ve inode/byte olarak korunur; yalnız exact authenticated CANDIDATE restartta kabul edilir. Odaklı 11/11 GREEN.                                                                                                                  | Pre-CAS partial crash otomatik liveness'i durable publication journal ile S03'e aittir.                                                                                                                                                                                 |
| `S01-LOCAL-COMMAND-CRASH`        | P1     | Checkpoint CAS sonrası ve CANDIDATE→COMPLETE/output arasında kill kalıcı retry wedge'i oluşturuyordu.                                                                             | Branded recovered exact-tip, aynı staged historical proof, promotion revalidation ve durable output sidecar bağlandı. `completion-admission-crash.spec.ts` gerçek child `SIGKILL`, source silme, expiry ve no-new-CAS exact replayde 1/1 GREEN (199,265 s).                    | MEDIUM composition gap: `completion-admission-command.ts:199–220` pre-CAS CANDIDATE ve `:219–232` post-COMPLETE/pre-output kill pencereleri yalnız `completion-proof-bundle.spec.ts` ile `canonical-output-reservation.spec.ts` component testlerinde; transaction S03. |
| `S01-LOCAL-MATERIALIZED-ARGV`    | P1     | Signed `argv` mantıksal runtime/tool kimliklerini taşırken OS spawn gerçek executable path'lerini kullanıyordu; “exact argv” iddiası mislabeled idi.                              | Authority-bound logical `argv` korunurken aynı immutable process snapshot'ından exact `materialized_argv` ve canonical digest receipt/evidence/witness katmanlarına bağlandı. Runner ve path/token mutation testlerinin frozen rerunu bekliyor.                                | Absolute executable path arşivsel olarak portable değildir; logical kimlik portable, materialized alan tarihsel process gözlemidir.                                                                                                                                     |
| `S01-LOCAL-BUNDLE-CONSUMER`      | P1     | Execution bundle markerı self-declared digestleri taşıyor, fakat receipt ile evidence/input/stdout/stderr ve exact beş-run rosterını bağımsız bağlayan production consumer yoktu. | Current ve historical closed reader/verifier; receipt imzası, authority/target/epoch, 4/6 input object rolleri, full argv ve dört artifact byte bağı eklendi. Repinned artifact mutantları testte; fresh build sonrası public CLI rerunu bekliyor.                             | Historical sonuç yalnız `HISTORICALLY_VALID,current:false`; live current ayrı reread ister.                                                                                                                                                                             |
| `S01-LOCAL-PROJECTION-PARITY`    | P1     | External consumable projection başarı sonrası bundle içindeki admitted byte'lardan ayrışabiliyor ve public verifier bunu görmüyordu.                                              | Current/history completion CLI artık external projection yolunu alır, exact LF-framed admitted artifact ile byte parity doğrular ve identity-bearing closed sonuç üretir. Repinned forged projection mutantının fresh-build rerunu bekliyor.                                   | Portable `COMPLETE` offline CAS attestation değildir.                                                                                                                                                                                                                   |
| `S01-LOCAL-CHECKPOINT-LINK-RACE` | P1/S18 | Checkpoint temp FD doğrulandıktan sonra path-based `linkSync` öncesi aynı-principal temp inode swapı finali zehirleyebilir.                                                       | S01 freeze blocker değil; post-link inode/byte recheck defense-in-depth adayıdır.                                                                                                                                                                                              | Exact mutant ve izolasyon sahipliği S18; transactional writer S03.                                                                                                                                                                                                      |
| `S01-LOCAL-TEST-CLOCK`           | Test   | Boundary fixture parent clock'u 2026-09-02'ye sabitlerken child gerçek 2026-09-03 saatinde authority'yi expired görüp exit 2 ve 24-byte `VERIFIER_INPUT_REJECTED\n` üretti.       | Ürün kapısı gevşetilmedi; wall-clock kullanan process fixture'ında geçmiş fake clock kaldırıldı. Taze build ve değişmeyen hashlerle decisive command matrix 4/4 GREEN.                                                                                                         | Ürün finding'i değildir; ilk GREEN iddiasını geçersiz kılan harness finding'idir.                                                                                                                                                                                       |

Son fiziksel sınır matrisi, temp-root SSoT düzeltmesinden önce 6 suite/28 testte 24 PASS ve 4
FAIL verdi (948,543 s). Üç FAIL native `os.tmpdir()` ile Jest'in izole `process.env` görünümünün
ayrışmasıydı: run-verifier, completion admission ve historical completion readback temp sınırları.
Dördüncü FAIL, geçerli execution bundle oluşturmayan current/history readback fixture'ıydı. Aynı
runtime temp kökü artık guard ve gerçek materializer tarafından kullanılıyor; readback testi önce
güncel verifier ile gerçek `COMPLETE` bundle üretiyor. Taze build ve sabit source/test/dist hashleriyle
decisive tekrar 4/4 GREEN oldu (490,622 s); T4 hem current hem historical guard'a ulaştı.

## Finding ilişkisi

Canonical finding matrix S01'i şu kalıtsal risklerin ortak sahibi yapıyor:
`ARIA-AUDIT-001`, `002`, `003`, `004`, `007`, `009`, `026`, `066`, `067`, `081`.

- Chain'in tamamını doğrulama, strict missing/invalid ayrımı, typed state sözlüğü, admission-issued
  projection ve fail-closed checkpoint bu sprintte kod/test karşılığı alan önleme kontrolleridir.
- `ARIA-AUDIT-026` legacy için çürütülmüş iddiadır; yeni sistemde yalnız verdict/exit propagation
  pozitif invariant'ı korunacaktır.
- `001`, `002`, `003`, `004`, `007`, `067` ve `081` diğer owning sprintlerin kanıtlarını da ister;
  S01 tek başına canonical finding closure iddiası taşımaz.
- P01 sprint kartı `ARIA-AUDIT-001–010` aralığının tamamını yazarken canonical matrix `005`, `006`,
  `008` ve `010` için S01 ownership'i vermiyor. Completion öncesi bu metadata uyuşmazlığı canonical
  authority'de çözülmelidir.
- Bu worktree'de hiçbir finding `SOLVED` veya `CLOSED` olarak işaretlenmedi.

## Açık işler

- Taze verifier build'i sonrasında production runner → receipt → admission → checkpoint → portable
  bundle → external projection akışının güncel source/dist ile yeniden GREEN olması; signer 4-case ve
  executable-runner materialized-argv regressions bu kapıya dahildir.
- Scope-wide checkpoint fork regression'ının kapanış kapısında tekrar çalıştırılması.
- Aynı milisaniyede başlayıp biten gerçek run için receipt→mapper→witness zaman invariant'ının bütün
  katmanlarda `started_at <= completed_at` olarak tek regression ile doğrulanması.
- Execution bundle mutate+repin ve external projection parity CLI testlerinin taze build/frozen source
  üzerinde yeniden GREEN olması.
- Full project typecheck, lint, test, build ve repository Actions eşleniği; ardından bağımsız düşmanca
  review.
- Immutable reviewed head, commit/push, GitHub Actions ve main merge kanıtları henüz yoktur.

## Bilinen residual riskler

- Yerel signed genesis dosyası kopyalanabilir. Aynı UID'nin ayrı bir process/run içinde checkpoint
  kökünü silip yeniden yaratmasına karşı salt yerel public dosya kriptografik anti-reset sağlamaz.
- S01 yalnız aynı process yaşamında FD+inode+owner+mode bağını ve signed configured identity eşleşmesini
  kapatır. Processler arası durable anti-reset, S03 bağımsız transactional store/CAS authority'sine
  taşınacaktır.
- Aynı principal altında secret ve filesystem yetkisi birleşmesinin kalan tehdidi S18 ayrı worker VM,
  UID, mount, capability ve deadline izolasyonu olmadan kapalı sayılamaz.
- Execution signing one-shot yaşam döngüsü tek issued capability/session nesnesi içinde geçerlidir.
  Aynı authority envelope'un yeni capability instance/process'te yeniden authorize edilmesi ve flaky
  verifier sonuçlarından elverişli roster seçimi S01 tarafından processler arası engellenmez; durable
  execution claim S03, izole worker yürütmesi S18 sahibidir.
- Final Git ref/current-epoch reread'i bir `linearization observation`dır. Bu okuma ile ayrı filesystem
  checkpoint CAS'i arasında ref veya epoch ilerlemesini yerel kod atomik olarak engelleyemez; S03
  transactional/fencing provider ve S18 merge authority gerekir. Bu sprint “current at commit” iddiası
  taşımaz.
- Doğrulanmış private verifier executable halen görünür bir `/tmp` yolu üzerinden spawn edilir.
  Aynı UID bu yolu spawn sınırında rename/swap edip yan etkili başka child çalıştırabilir, ardından yolu
  restore ederek post-check'i geçirmeyi deneyebilir. S01 bu filesystem sınırını atomik kapattığını iddia
  etmez; ayrı UID/mount ve mümkünse FD tabanlı exec sahipliği S18 worker isolation sorumluluğudur.
- Portable bundle `COMPLETE` adı yalnız atomik artifact publication'ın tamamlandığını gösterir; offline
  checkpoint commit/non-fork attestation değildir. Historical verifier yalnız `HISTORICALLY_VALID`,
  `current:false`, marker ise `VALID_AT` iddiası taşır. Offline durable commit kanıtı ayrı imza yetkili
  S03 store/fencing servisi gerektirir.
- Public bundle yolunda provenance'siz empty/staging/payload/torn-marker state fail-closed korunur ve
  otomatik silinmez. Pre-CAS partial crash'in başka operator destination seçmeden aynı yolda otomatik
  devamı, authenticated hidden journal/transaction gerektirdiği için S03 publication protokolüne aittir.
- Flat checkpoint directory bütün güven sınırı taramalarında 4.096-entry hard limitinde fail-closed olur;
  yaklaşık 2.047 terminal scope sonrası kapasite için shard/index tasarımı S03 durable-store sahibidir.
- Checkpoint temp FD doğrulaması ile path-based final hard-link arasında aynı-principal inode değişimi
  yerel filesystem ile atomik kapatılamaz. Post-link recheck defense-in-depth olabilir; ayrı UID/mount
  ve transactional writer/fencing sırasıyla S18 ve S03 sahipliğindedir.
- S01 checkpoint'i stable work-unit başına tek immutable terminal tiptir. `DONE` sonrası yeni authority/
  evidence version ilerlemesi, açık signed supersession transactionı olmadan reddedilir; bu progression
  protokolü S03 sahibidir.
