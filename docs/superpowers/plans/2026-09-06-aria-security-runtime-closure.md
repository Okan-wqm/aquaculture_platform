# ARIA üretim odaklı mühendislik ve otonomi — kapsamlı tamamlama planı

> Uygulayıcı: `superpowers:subagent-driven-development` veya
> `superpowers:executing-plans` ile aşağıdaki bağımlılık sırasını izle.
> Bu belge bir uygulama planıdır; kutular uygulama veya canlı kabul tamamlandı anlamına gelmez.

**Tarih:** 2026-09-06.
**Durum:** Uygulama planı. Planın commit/PR/main üzerinden yayınlanması, aşağıdaki
runtime düzeltmelerinin uygulanmış veya hattın etkinleştirilmiş olduğu anlamına gelmez.
**Hedef:** ARIA'nın projenin amacını ve mimarisini anlayarak üretime uygun yazılım geliştirmesini,
kendi mimarisini tanımasını ve yeteneklerini kanıtla geliştirmesini sağlamak. Pasif güvenlik
kontrollerinden ve bütün repo workflow'larının izlenmesinden
kaynakta doğrulanmış bulguya,
düzeltme PR'ına, savunma amaçlı regresyon doğrulamasına ve izinli merge işlemine
uzanan hattını; kalıcı kayıt, bağımsız inceleme ve geri alma kanıtlarıyla tamamlamak.
P14, bu hattın her işte güncel mimari bilgi kullanmasını ve sonuçlardan ölçülebilir öğrenmesini
sağlar. P15, mevcut agent/skill ve öz-gelişim parçalarını doğrulanmış yaşam döngüsüne bağlar.
**Mimari:** Mevcut kernel, executor, state publisher ve tek merge authority korunur.
Güvenlik ölçümü kanıt üretir; bu kanıtı üreten iş kendi sonucuna merge yetkisi vermez.
**Teknoloji:** Python kernel, mevcut unittest/pytest ve Jest/Nx testleri, GitHub Actions,
özel runner, GitHub App kimlikleri ve hash zincirli JSONL kayıtları.
**Dayanaklar:** `docs/aria/CURRENT_STATE.md`, `docs/aria/ENTERPRISE_AUTONOMY_SSOT.md`,
`docs/aria/policy/`, Plan 033 ve
`docs/superpowers/plans/2026-08-22-aria-end-to-end-autonomy-closure.md`.

## 1. Kararlar, başlangıç kanıtı ve kapsam

### Otonominin sınırı

- Kullanıcının istediği üzere, uygun PR'larda son merge işlemini ARIA yapar.
  Bu, bağımsız gerekli review'ların veya yüksek riskli politika onaylarının kaldırılması değildir.
- Kendini onarma yalnız ARIA workflow'larıyla sınırlı değildir: repodaki bütün GitHub Actions
  workflow'ları, kimin açtığına bakılmaksızın PR'lar, main çalışmaları ve zamanlanmış işler
  P13 üzerinden aynı gözlem → kök neden → mimari düzeltme PR'ı → doğrulama hattına girer.
  Test silme/atlama, hata yutma, kontrolü gevşetme veya yalnız yeniden çalıştırma çözüm sayılmaz.
- İlk kernel/workflow/policy değişiklikleri mevcut, incelemeli normal PR sürecinden geçer.
  Henüz tamamlanmamış ARIA merge mekanizması kendi yetkisini açan değişikliği birleştirmez.
- Hedef yalnız doküman/test PR'ları değildir: L1 kabulünden sonra, kanıtlanmış L2 uygulama
  düzeltmelerinin de ARIA tarafından birleştirilmesi bu planın teslimatına dahildir.
  L3, iki ayrı insan politika onayını ve mevcut kabul eşiklerini korur.
- Otomasyon kaynak analizi, güvenli statik kontroller, mevcut savunma testleri ve düzeltme
  doğrulamasıyla sınırlıdır. Otonom saldırı yürütümü, exploit yeniden üretimi veya
  kendiliğinden saldırı senaryosu üretimi bu plan tarafından uygulanmaz ya da etkinleştirilmez.
  Böyle bir doğrulama gerektiren bulgu `HUMAN_REQUIRED` kalır; kapsamı azaltıp temiz gösterilmez.
- Üretime deployment, müşteri verisi işlemleri, secret rotation ve üretim migration'ı merge
  işleminden ayrıdır; bu plan bunları otomatikleştirmez.

### Sabit başlangıç

Kaynak incelemesi `origin/main@f4b1c50c158bb497da93cef6be70ce0a3272cace`;
kalıcı durum incelemesi `origin/aria/state@e5709b0877c3c9f687c09f428159e3ce32cab2ef`
üzerinde yapıldı. Çalışma klasörünün eski, kirli ve detached olması nedeniyle uygulama bu
klasörde başlamaz. Güncel main'den ayrı, temiz worktree kullanılır. Ref'ler ilerlerse uygulayıcı
yalnız değişen otorite alanlarını tekrar inceleyip gerçek uygulama SHA'sını kaydeder.

| İş  | Doğrulanmış durum                                                                             | Kapatılma kanıtı                                                     |
| --- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| P01 | Eski checkout, eski planlar ve canlı state birbirinden farklı                                 | Tek uygulama SHA'sı ve güncel bulgu/otorite eşlemesi                 |
| P02 | Son kalıcı döngü 4 Eylül'de `integrity_failed`; 176 artifact referansının 158'i yok           | Kurtarma/iptal makbuzları, tutarlı yeni state ve doğrulanmış publish |
| P02 | Maintenance kendi `git add/commit/push` yolunu kullanıyor                                     | Bütün state yazarları aynı doğrulamalı publisher'dan geçiyor         |
| P03 | Producer/executor başarısızlıkları; yayınlamada snapshot uyuşmazlığı                          | Sınıflandırılmış terminal durum ve art arda başarılı çalışma/publish |
| P04 | Assurance güncel pack digest'ini tam doğrulamıyor; readiness bazı iddiaları çağırandan alıyor | SHA/profile/pack ve gerçek kaynak kaydına bağlı doğrulama            |
| P05 | Güvenlik değerlendirmesi CLI'da; gece döngüsü ve PR kanıt akışı yok                           | Zamanlanmış pasif ölçüm ve PR-head'e bağlı required-check kanıtı     |
| P06 | Güvenlik bulgusundan doğrulanmış düzeltmeye bağlantı uçtan uca kanıtlanmamış                  | Gerçek bulgu, düzeltme, regresyon, PR ve kapanış zinciri             |
| P07 | Yedi merge öncesi kontrol bilinçli olarak uygulanmamış                                        | Her kontrolün gerçek kaynaktan hesaplanan olumlu/olumsuz sonucu      |
| P08 | Security readiness merge authority tarafından kullanılmıyor                                   | Son PR SHA'sında yeniden hesaplanan zorunlu güvenlik kararı          |
| P09 | Main'in imza/review/conversation/ruleset kanıtı readiness şartlarını karşılamıyor             | GitHub'dan yeniden okunmuş geçerli koruma kanıtı                     |
| P10 | Gerçek kabul sayaçları ve L2/L3 aday politikası aktivasyonu engelliyor                        | Kökeni doğrulanmış olaylar ve aşamalı, politika kontrollü kabul      |
| P11 | Durum dokümanı eski; firejail anlatımı bwrap koduyla çelişiyor                                | Kod/CLI/doküman otoritesi ve doğru durum raporu                      |
| P12 | Birim testlerinin geçmesi canlı hattın çalıştığını kanıtlamıyor                               | Main üzerinde gerçek pasif çalışma ve gerçek izinli merge makbuzu    |

P13, bütün repository workflow'larının ortak izleme ve mimari onarım işidir; mevcut
own-PR ve scheduled-watchdog gözlemleri bu uçtan uca hattı henüz sağlamaz.

P14, kaynak koduna ve yürütülmüş kanıta bağlı mimari bilgi/öğrenme işidir. Yeni bir ARIA
veya ikinci bellek sistemi kurulmaz; mevcut memory, twin, evidence ve worker bağları tamamlanır.

P15, projeye uyarlanma, ARIA'nın kendi mimarisini anlaması ve mevcut genesis/curation/self-change
sahiplerinin tamamlanmasıdır. Ürün geliştirme bu yeteneklerin amacıdır; üretilen agent/skill
sayısı başarı sayılmaz.

P01–P15 plan iş kimlikleridir; mevcut finding kimliklerinin yerine geçmez.
Uygulama başlamadan mevcut finding kayıtları yeniden kullanılır, yeni doğrulanmış boşluklar
merkezi kayıt aracından OPEN olarak kaydedilir. Her fix commit'i gerçek `Closes:` referansı taşır.
Kapanış, yalnız ilgili kod main'e ulaşıp gerekli canlı kanıt oluşunca yapılır.

6 Eylül yeniden kontrolünde watchdog sweep sonucunun JSON'a çevrilmesi için
`961eaf847` düzeltmesi main'dedir. Bu iş yeniden uygulanmaz; test ve çalışma kanıtı doğrulanır.
State, security ve merge sahipleri önceki incelemeden beri değişmemiştir. İkinci compaction da
158 eksik referansı gidermemiştir; eksiklerin neden korunduğu henüz kanıtlanmış kök neden
değildir.

### GitHub Actions başarısızlıkları ve kapanış eşlemesi

GitHub API kontrol zamanı: **2026-09-06 07:40 UTC**. Aşağıdaki sonuçlar bu anın
görüntüsüdür; başarısız adım adı tek başına kök neden kanıtı değildir. Bu plan yayınlanırken
workflow kodunda düzeltme yapılmadı ve bu başarısızlıklar kapatılmadı.

| Workflow                               | İncelenen çalışma                                                                                               | Gözlenen sonuç                                                             | Plan ve kapanış kanıtı                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| aria-auto-cycle                        | [33985796586 — 5 Eylül](https://github.com/Okan-wqm/aquaculture_platform/actions/runs/33985796586)              | Başarısız: `Publish ARIA state to the aria/state branch`                   | P02/P03/P12: doğrulanmış state snapshot'ı ve başarılı producer/publish                                        |
| aria-agent-executor                    | [34018611774 — 6 Eylül](https://github.com/Okan-wqm/aquaculture_platform/actions/runs/34018611774)              | Devam ediyor: `Run CI executor`                                            | P02/P03/P12: terminal sonuç ve başarılı publish ayrıca okunmalı                                               |
| aria-agent-executor, önceki tamamlanan | [34001646041 — 6 Eylül](https://github.com/Okan-wqm/aquaculture_platform/actions/runs/34001646041)              | Başarısız: `Run CI executor` ve state publish                              | P02/P03: executor hatası ile publish hatasının ayrı kök nedenleri ve regresyon kanıtı                         |
| aria-readiness-claim                   | [34019581923 — 6 Eylül](https://github.com/Okan-wqm/aquaculture_platform/actions/runs/34019581923)              | Başarısız: `Assemble the readiness claim`                                  | P04/P08/P09/P12: güncel koruma ve kanıtlar üzerinden başarılı claim                                           |
| ARIA External Watchdog                 | [33964977335 — 5 Eylül](https://github.com/Okan-wqm/aquaculture_platform/actions/runs/33964977335)              | Başarısız: `Judge ARIA's memory and report`                                | P03/P11/P12: gerçek producer/state sağlığı ve doğru incident sonucu; yalnız watchdog'un yeşile dönmesi yetmez |
| aria-daily-report                      | [33960475105 — 5 Eylül](https://github.com/Okan-wqm/aquaculture_platform/actions/runs/33960475105)              | Başarısız: `Persist enterprise workflow preflight`; rapor üretimi başarılı | P04/P09/P11/P12: preflight kaydı dahil başarılı rapor akışı                                                   |
| ARIA Operational Proof                 | [33113524069 — 27 Ağustos](https://github.com/Okan-wqm/aquaculture_platform/actions/runs/33113524069)           | Tarihsel başarısızlık: `Run observe burn-in proof`; daha yeni çalışma yok  | P02/P03/P10/P12: güncel main/state üzerinde gerçek burn-in ve süreklilik kanıtı                               |
| ARIA State Maintenance                 | [33980589106 — 5 Eylül](https://github.com/Okan-wqm/aquaculture_platform/actions/runs/33980589106)              | Başarılı                                                                   | P02/P12: 158 eksik referansın uzlaştırılması ve bütünlük kanıtı ayrıca gerekli                                |
| aria-kernel-fast                       | [34004104445 — 6 Eylül](https://github.com/Okan-wqm/aquaculture_platform/actions/runs/34004104445)              | Başarılı                                                                   | Uygulama PR'larında güncel head üzerinde tekrar doğrulanır                                                    |
| aria-kernel                            | [34007263205 — 6 Eylül](https://github.com/Okan-wqm/aquaculture_platform/actions/runs/34007263205)              | Başarılı                                                                   | Uygulama PR'larında güncel head üzerinde tekrar doğrulanır                                                    |
| aria-merge-authority                   | [34019499839 — 6 Eylül](https://github.com/Okan-wqm/aquaculture_platform/actions/runs/34019499839)              | Başarılı, başka PR head'i `e4951d`                                         | P07/P08: yedi gerçek kontrolün tamamlandığı veya canlı merge yapıldığı sonucu çıkarılmaz                      |
| aria-agent-eval                        | [33304001974 — 30 Ağustos](https://github.com/Okan-wqm/aquaculture_platform/actions/runs/33304001974)           | Tarihsel başarı                                                            | P03/P12: son runtime sürümünde yeniden doğrulama gerekli                                                      |
| ARIA runner capability probe           | [Workflow](https://github.com/Okan-wqm/aquaculture_platform/actions/workflows/aria-runner-capability-probe.yml) | Kayıtlı çalışma bulunamadı                                                 | P03/P09/P12: tetikleme koşulu, runner uygunluğu ve güvenli capability kanıtı incelenir                        |

Önceki log incelemesinde görülen `state_publish_commit_snapshot_mismatch`,
`state_snapshot_unclaimed_tree_entry` ve `branch_protection_proof_invalid` ilgili
P02/P09 araştırmalarının girdisidir. Aynı adımda oluşan her yeni başarısızlık için aynı
neden varsayılmaz. Uygulayıcı exact run/job/SHA ve hassas veri içermeyen hata kanıtıyla
nedeni doğrular; düzeltme PR'ını ve sonraki gerçek başarılı run'ı bu tabloya bağlar.

### ARIA dışındaki workflow'lar da aynı teslimatın parçasıdır

**2026-09-06 yaklaşık 07:50 UTC** GitHub envanteri: 59 workflow kaydı, 58 aktif,
1 elle devre dışı (`Deploy to DigitalOcean`). Sekiz aktif workflow'un run geçmişi yoktur.
`main@f4b1c50` altında 55 workflow YAML dosyası vardır; GitHub'daki 57 YAML kaydının
`messaging-enterprise-release.yml` ve `new-aria-legal.yml` yolları bu ağaçta yoktur.
Ayrıca iki GitHub-managed dynamic Dependabot workflow'u vardır. Bunlar P01/P13'te
kaynak/registry uzlaştırmasına girer; farkların nedeni veya devre dışı bırakmanın yanlışlığı
bu envanterden çıkarılmaz. Kapalı workflow kendiliğinden etkinleştirilmez.

İlk triage kuyruğuna alınan güncel örnekler; bunlar bütün kök nedenlerin teşhis edildiği anlamına
gelmez:

| Workflow ve çalışma                                                                                                     | Başarısız adım                                                                | P13 kök neden incelemesi                                                                                |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [CI - Affected 34019499973](https://github.com/Okan-wqm/aquaculture_platform/actions/runs/34019499973)                  | `Run tests (affected only)` ve aşağı akış merge/build kapıları                | Test hatası ile bağımlı kapıların sonuçlarını ayır; aynı head'de kaynak/test sözleşmesini doğrula       |
| [CI - Full 34018063733](https://github.com/Okan-wqm/aquaculture_platform/actions/runs/34018063733)                      | `Run linter (all projects)`, `Verify coverage evidence`, `Check build status` | Lint, coverage kanıtı ve bağımlı sonuçların sahiplerini ayrı incele                                     |
| [Security - Trivy 34019184836](https://github.com/Okan-wqm/aquaculture_platform/actions/runs/34019184836)               | `Run Trivy on pre-built image`                                                | Mevcut pasif kontrolün image/input/araç/artifact zincirini kaynakta doğrula                             |
| [Nightly Fuzz ST Parser 34016440594](https://github.com/Okan-wqm/aquaculture_platform/actions/runs/34016440594)         | `Install Rust toolchain (nightly — required by cargo-fuzz)`                   | Runner/toolchain kurulum sözleşmesini incele; bu plan aktif saldırı veya açık yeniden üretimi başlatmaz |
| [Scheduled Workflow Watchdog 34015221666](https://github.com/Okan-wqm/aquaculture_platform/actions/runs/34015221666)    | `Verify scheduled workflow freshness and persist incident`                    | İzlenen işlerin tetikleme ve gerçek kanıt sürekliliğini incele; watchdog alarmını susturma              |
| [Database WAL Archive Freshness 34013892692](https://github.com/Okan-wqm/aquaculture_platform/actions/runs/34013892692) | `Observe production WAL archive runtime`                                      | Gözlem/kimlik/kanıt gereksinimini teşhis et; üretime müdahale veya deploy başlatma                      |

Eski son başarısız çalışmaları bulunan `E2E Tests`, `Messaging Enterprise Release` ve
`Security - Snyk` de başlangıç kuyruğuna dahildir; güncel kaynak ve çalışma bağları ayrıca
incelenir.
Run geçmişi olmayan sekiz iş: Apollo Router Security, ARIA runner capability probe,
Build Selected Images, Deploy Development, PITR Restore – Production Postgres,
PostgreSQL DR Bootstrap Candidate, Backup DR – Verify Enterprise Closure ve Verify Backup SSH
Broker.
Bu durum tek başına hata değildir; beklenen tetikleme, etkinlik ve environment/onay şartlarıyla
sınıflandırılır.

## 2. Çalışma ve kanıt temeli — P01–P04

### P01 — Uygulama tabanı ve izlenebilirlik

- [ ] Güncel main'den `feat/aria-security-closure-p01` worktree'si aç; kullanıcı değişikliklerini
      koru.
- [ ] Root ve değiştirilecek alanların nested `CLAUDE.md` dosyalarını oku. 22 Ağustos planının
      ilgili görevlerini ve mevcut closure finding politikasını bu işlerle eşle;
      tamamlanmış kodu yeniden yazma.
- [ ] GitHub Actions tablosundaki bütün başarısız/tarihsel/çalışması olmayan workflow'ları
      güncel run/job/SHA üzerinden triage et. Aynı kök nedenin birden fazla workflow'u bozduğu
      durumları tek finding'e bağla; bağımsız nedenleri ayır. Devam eden run'ı başarı sayma.
- [ ] GitHub registry'si, main'deki workflow kaynakları ve dynamic workflow kayıtlarını
      uzlaştır; ARIA dışındaki işler de kapsamda olsun. Her workflow için aktif/devre dışı,
      hiç çalışmamış, bekleyen, devam eden ve tamamlanan sonuçları ayrı kaydet.
- [ ] Her iş için kod kanıtı ve canlı kanıtı ayrı kaydet: `code_proven`, `live_proven`,
      `blocked` ve gerekçesi. Raporu geçmiş bir dashboard'dan doldurma.
- [ ] Main/state SHA'ları, workflow run/job kimlikleri ve hash'leri içerikli bir başlangıç
      envanteri üret. Loglardan yalnız redakte kanıt al; gerçek sırları plana veya Git'e yazma.

**Çıkış:** Her gözlenen sorunun bir sahibi, finding kaydı, aşağıdaki görevi ve kabul koşulu var.

### P02 — Tek state yayınlama ve kayıpsız bakım

**Sahipler:** `state_store`, `state_snapshot`, `state_manifest`, `state_compact`,
`runtime_artifacts` ve mevcut restore/maintenance workflow'ları.

- [ ] Normal döngü, executor ve maintenance yayınlarını aynı
      materialize → manifest → snapshot → committed-tree doğrulama → CAS publish akışına bağla.
      Maintenance içindeki ayrı ham Git yayınlama yolu kaldırılır.
      Snapshot son yayımlanacak ağaçtan üretilir.
- [ ] Host-local binding, cache ve scratch çıktıları manifestte tanımlı kalıcı alan gibi
      stage edilmez. Tanımsız dosya sessizce allowlist'e alınmaz; açık hata ve karantina kanıtı
      üretir.
- [ ] Compaction işleminde canlı artifact referansları, dosyalar ve arşiv ilişkisi tek işlem
      sınırında hesaplanır. Silmeden önce arşiv dayanıklı ve hash'i doğrulanmış olmalıdır.
      Mevcut dosyanın hash uyuşmazlığı hiçbir zaman satırı silerek gizlenmez.
- [ ] Eski `aria/state` ağacını ayrı kurtarma worktree'sinde incele. 158 eksik dosya için
      hash-bound güvenilir yedek varsa geri yükle. Yoksa açık invalidation/tombstone makbuzu üret;
      bu kanıta dayanan approval, promotion, closure veya unlock artık geçerli sayılmaz.
      İndeksi küçültmek geçmiş kanıtı geri getirmiş sayılmaz.
- [ ] Kurtarma dry-run'ı dosya, index, arşiv ve bağlı geçerlilik değişimlerinin tam listesini
      verir. Gerçek kurtarma aynı girdilere ve hash'lere bağlı,
      tekrar çalıştırılabilir bir migration olur.
      State geçmişi force push veya sessiz yeniden yazımla değiştirilmez.
- [ ] Publish makbuzu kod SHA'sını, önceki/yeni state SHA'sını, snapshot hash'ini ve
      doğrulayıcı sürümünü taşır. Çakışan remote tipte doğrulamasız retry/push yapılmaz.

**Testler:** 158 eksik referanslık redakte fixture; korunması gereken canlı referans;
mevcut dosyada hash hatası; disk/yazıcı kesintisi; compaction'ın tekrar çalışması;
snapshot sonrasında dosya değişmesi; CAS yarışması; tanımsız staged dosya;
dry-run'ın byte-for-byte değişiklik yapmaması. Her hatada remote ref aynı kalır.

**Çıkış:** Yeni state doğrulanarak yayınlanır; kayıp tarihsel kanıtlar açıkça görünür ve hiçbir
yetki sayacına katkı yapmaz. Sonraki normal restore aynı sonucu yeniden doğrular.

### P03 — Runner, executor ve terminal durumlar

- [ ] Mevcut runner-habitat bellek sınırlarını etkin systemd değerleriyle karşılaştır;
      OOM olayları, CPU/disk baskısı, kalan süreçler ve job deadline'ı aynı çalışma kimliğinde
      ölçülsün.
      Sadece timeout veya bellek tavanını büyütmek çözüm kabul edilmez.
- [ ] Her döngü/claim tam bir terminal sonuç alır: başarılı, reddedildi, başarısız veya iptal.
      Executor çıkışı, deadline, kullanıcı iptali, kanıt hatası ve publish hatası ayrı
      nedenlerdir.
- [ ] Durum/lease kaydındaki `running` bir canlı süreç kanıtı sayılmaz. Eski claim kurtarması
      gerçek süreç/job durumunu ve lease süresini doğrular; aynı işi iki executor sahiplenemez.
- [ ] Retry yalnız aynı kararlı iş kimliğiyle, sınıflandırılmış geçici hata için ve mevcut
      bütçe içinde yapılır. Kanıt/policy/snapshot hatası retry ile temiz sonuca çevrilmez.
- [ ] Kuyrukta bekleyen, claim edilmiş, tamamlanan ve insan kararı bekleyen işler aynı
      reducer'dan raporlanır. Finding/debt sıfır olsa da bekleyen mission/request gizlenmez.
- [ ] Watchdog düzeltmesini koru; sinyalin JSON sözleşmesini ve gerçek tüketicisini test et.
      Alarm merge'i durdururken kanıt yayınlayarak iyileşme sağlayan pasif döngüyü engellemez.

**Testler:** İş ortasında süreç kaybı, stale lease, duplicate delivery, yeniden başlayan runner,
deadline, başarısız publish ve log serileştirme. Mevcut executor sınıflandırma/lease testleri
genişletilir.

**Çıkış:** Aynı main otoritesinden üç ardışık producer/executor çalışması sınıflandırılmış
terminal kayıt ve doğrulanmış publish üretir; eski belirsiz işler yeniden sayılmadan uzlaştırılır.

### P04 — Kaynağa bağlı güvenlik kanıtı

**Sahipler:** `aria-kernel/aria_kernel/security/` altındaki assurance/readiness/ops;
ortak artifact doğrulayıcısı ve state manifesti.

- [ ] Yeni `SecurityAssessmentEvidenceV2` sözleşmesinde şu bağlar zorunludur:
      repository kimliği, target SHA, assessment kimliği, asset/control kimliği, profile digest,
      ilgili güncel pack digest, scanner/çalıştırıcı digest'i, çalışma kimliği/zamanı,
      girdi kapsamı hash'i, artifact ref/hash ve doğrulanabilir producer kimliği.
- [ ] Producer kökü GitHub Actions attestation'ıdır: repository, workflow kimliği ve
      değişmez workflow SHA'sı, run/job kimlikleri, PR numarası/head SHA ve artifact digest'i
      birlikte doğrulanır. Artifact yalnız bu güvenilir GitHub kaydından çözülür; PR gövdesi,
      PR-yazılabilir state veya kendi beyan ettiği producer etiketi kaynak olamaz.
- [ ] `SecurityReadinessInputs` yalnız doğrulanmış değerlendirme referanslarını, gerçek PR
      değişen dosya listesini ve hash-bound kanonik finding snapshot'ını kabul eder.
      Çağırandan `ready=true`, `open_critical_or_high=0` veya `post_fix_clean=true` kabul edilmez.
- [ ] `SecurityClosureEvidenceV2`, finding kimliğini, kontrol sürümünü, önceki/sonraki kaynak
      SHA'sını, savunma testi sonucunu ve bağımsız doğrulayıcı kimliğini bağlar. Kapanış PR'ın
      güncel head SHA'sı üzerinde yeniden hesaplanır; farklı sürümdeki yeşil test taşınmaz.
- [ ] Kalıcı finding durumu ile aday PR head'inin düzeltme değerlendirmesini ayır.
      HIGH düzeltme PR'ı, kendi bulgusu merge sonrasına kadar açık tutulduğu için kendini
      kilitlememelidir. `remediated_at_candidate_head` yalnız aynı finding/kontrol için
      bağımsız, tam current-head ve kapsamlı düzeltme kanıtından türetilir; author beyanı veya
      allowlist değildir. Bu aday değerlendirmesi canonical kaydı RESOLVED yapmaz ve canlı
      sistemin açık bulgu sayısını sıfırlamaz. Merge kararı aynı risk/review politikasından
      geçer; ilgisiz açık, kanıtsız, eski SHA'lı veya `HUMAN_REQUIRED` bulgular bloklamayı
      sürdürür. Head/base/kanıt değişirse aday değerlendirmesi geçersizleşir.
- [ ] Required-control kümesi etkilenmiş kontroller ile zorunlu tenant/auth kontrollerinin
      birleşimidir ve gerçekten coverage hesabına girer. Bilinmeyen dosya/kontrol, eksik pack,
      boş kapsam, okunamayan finding deposu ve eksik kanıt sonucu bloke eder.
- [ ] Coverage tam SHA/profile/pack eşleşmesi arar. Mevcut staleness politikasından tek
      saat/TTL sahibi kullanılır; mevcut kodun zaman sınırı kopyalanıp ikinci sabit oluşturulmaz.
- [ ] Eski kayıtlar tarihsel okunabilir kalır, fakat eksik V2 bağları tahmin edilerek
      yükseltilmez.
      Yeni yetki için tekrar ölçüm gerekir. Yeni schema/surface/writer/reader aynı PR'da teslim
      edilir.
- [ ] Doctor, quarantine/cleanup/açık kritik bulgu bilgisini kanonik kayıt kaynaklarından okur;
      veri yokken sıfır kabul etmez. Kaynakta doğrulanamayan runtime iddiaları insan doğrulaması
      bekler.
- [ ] İnsan tarafından sağlanan mevcut değerlendirme kanıtı için yalnız doğrulayan bir
      import sınırı kullanılır: kaynağı, imzası, tam hedef SHA'sı, kapsamı ve süresi doğrulanır.
      Bu sınır test veya saldırı başlatmaz. Zorunlu runtime kontrolünün geçerli kanıtı yoksa,
      değişiklik düşük riskli olsa bile o kontrol atlanmaz ve merge bekler.

**Testler:** SHA, pack, profile ve scanner değişimi; replay/duplicate; eksik finding snapshot;
süresi geçmiş kanıt; boş required-control kümesi; sahte producer; kayıp artifact;
eski sürümün yanlışlıkla geçerli sayılması. Bunlar veri/sözleşme testleridir, saldırı çalıştırmaz.

## 3. Güvenlikten PR'a ve merge kararına — P05–P09

### P05 — Pasif ölçümün gerçek çağrı yolları

- [ ] Mevcut producer döngüsüne explicit main SHA üzerinde pasif güvenlik değerlendirmesi
      ekle; sonuç aynı bağlı tools-root'ta V2 kanıt olarak yayınlanır. Observe burn-in'in
      agent/tool/PR
      üretmeme sözleşmesi değiştirilmez; güvenlik ölçümü ayrı yetkilendirilmiş adımdır.
- [ ] PR değerlendirmesini ayrı, güvenilmeyen PR için güvenli job olarak ekle. Trusted scanner
      sürümü ile PR içeriğini veri olarak oku; PR'dan workflow veya script çalıştırma. Bu job
      state
      branch'i, merge veya workflow yazma kimliği almaz.
- [ ] PR artifact'i PR numarası ve tam head SHA'ya bağlıdır. Baseline sonucu PR kanıtının
      yerine geçmez. Eksik scanner, kesilen çıktı veya hata açık blocked sonucu üretir.
- [ ] Yeni güvenlik sonucu mevcut `aria-merge-authority` required-check içinde zorunlu
      tüketilir; mevcut dört required-check adı için ikinci bir SSoT oluşturulmaz.
- [ ] Aggregate required-check değerlendirme job'unu zorunlu bekler. Job'un hiç başlamaması,
      skipped/cancelled olması, eksik artifact veya boş kontrol eşlemesi başarıya dönüşmez.
      Aggregator bu durumları açık başarısız check olarak yayınlar.
- [ ] Çağrı erişilebilirliği testi hem scheduled producer'ın hem PR job'unun gerçek
      değerlendirme sahibini çağırdığını, üretilen artifact'in final gate tarafından okunduğunu
      kanıtlar.

### P06 — Doğrulanmış bulgunun düzeltme döngüsü

- [ ] Mevcut finding/triage/plan/worker/PR akışına yalnız kaynakta doğrulanmış pasif bulguyu
      bağla.
      Kararlı finding+kontrol+hedef kimliği tekrar taramada ikinci PR açmaz.
- [ ] Otomatik düzeltme/kapanış adayı mevcut `STATIC_DETERMINISTIC` sınıfıyla sınırlıdır.
      `ACTIVE_DUAL`, runtime-only ve sınıfı bilinmeyen bulgular `HUMAN_REQUIRED` kalır.
      L2 aday listesini açmak bu sınıflandırmayı değiştirmez; otomasyonu açmak için claim yeniden
      etiketlenmez.
- [ ] Düzeltme temiz worktree'de yapılır; doğrulayıcılar aynı PR SHA'sında mevcut statik kontrolü
      ve ilgili savunma regresyonlarını çalıştırır. Kanıt üreten ile kapanışa karar veren
      kimlikler ayrıdır.
- [ ] Düzeltme ve gerekli regresyon tek review edilebilir PR'da kalır. Runtime kodu ile onun
      testini farklı PR'lara ayırarak güvenlik kapısını geçme yolu oluşturulmaz.
- [ ] Karma risk sınıflandırması için sürümlü politika ekle: sadece hedef runtime değişikliğini
      doğrulayan testler onun risk sınıfını devralır; kontrol düzlemi/policy değişikliği en yüksek
      riskte
      kalır. Yasak veya tanımsız yol her durumda bloke edilir. Test dosyası olması risk düşürmez.
- [ ] Açık bulgu merge öncesinde RESOLVED olmaz. Final merge SHA'sında tekrar pasif doğrulama
      tamamlanınca kapanış kaydı oluşur; doğrulama bozulursa bulgu yeniden açılır ve incident
      yazılır.
- [ ] P04 aday-head değerlendirmesi ile post-merge kalıcı kapanışı aynı finding kimliğine
      bağla. Regresyonlar: kendi HIGH bulgusu bağımsız kanıtla düzelmiş uygun adayın politika
      incelemesine ilerlemesi; ilgisiz/açık bulgunun, eksik testin, sahte/başka-head kanıtın ve
      değişmiş head'in reddi. Merge veya post-merge doğrulama başarısızken kalıcı RESOLVED
      kaydı ve canlı temiz-sistem beyanı üretilemez.
- [ ] Bağımsız kanıtla doğrulanamayan bulgu otomatik kapanmaz veya otomatik merge adayı olmaz.

### P07 — Yedi gerçek merge öncesi kontrol

Mevcut `HardFailContext`, tek immutable `PreMergeEvidenceBundle` tüketir. Bundle'ı yalnız
merge authority kurar: canlı PR/head/base, implementation kökeni, doğrulanmış workflow/artifact
referansları, kilitler, bütçe, feedback, consensus, plan coverage ve security readiness içerir.
Her alanın kaynak hash'i vardır; diğer çağıranlardan bağımsız boolean eklenmez.
Kontrollerin sahipleri 22 Ağustos planının 8–12. görevleriyle ortak tutulur; ikinci gate sistemi
kurulmaz.

| Kontrol                     | Yetkili girdi ve zorunlu ret                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| Branch-tip lock/recheck     | Canlı PR/base SHA ve lease; sürüm değişmiş/lease kayıp ise ret                                 |
| Dosya karşılıklı dışlaması  | Atomik dosya claim kayıtları; başka sahibin claim'i varsa ret                                  |
| Operator-feedback signature | Kimliği, kapsamı, süreyi ve SHA'yı bağlayan imzalı kayıt; serbest `set_by` metni yeterli değil |
| Cycle/turn bütçesi          | Ayrılmış ve tüketilmiş bütçenin kanonik kaydı; eksik/aşılmış bütçede ret                       |
| Content-hash recheck        | Onaylanan plan/diff/artifact hash'leri; son içerikle uyuşmuyorsa ret                           |
| Expert consensus            | Bağımsız reviewer kimlikleri ve kaynak kanıtı; self-review veya açık itirazda ret              |
| Plan coverage witness       | Planın zorunlu çıktılarına bağlı test/inceleme kanıtı; tamamlanmamış gereksinimde ret          |

- [ ] Her `_not_implemented` ancak gerçek kaynak okuyucusu ile olumlu ve olumsuz testleri
      teslim edilince kaldırılır. Eksik bağlamı varsayılan başarıya çevirmek yasaktır.
- [ ] Profil/policy değiştirme aktörünün kimliği aynı imzalı approval altyapısından doğrulanır;
      process'in kendi yazdığı `operator` etiketi yetki vermez.
- [ ] Kilit, bütçe ve feedback kayıtlarının geçerliliği final head recheck anında tekrar ölçülür.

### P08 — Tek merge authority'de güvenlik kararı

- [ ] `SecurityReadinessVerifier`, güncel PR artifact'ini ve finding snapshot'ını doğrulayıp
      P04 kararını yeniden hesaplar. Merge authority'nin son head/diff kontrolünden sonra,
      merge adapter çağrısından önce zorunlu bir güvenlik kapısı olur.
- [ ] Enterprise readiness, runner attestation, rollback bundle, incident ön kaydı,
      risk/unlock, watchdog ve mevcut triple gate korunur. Bir yeşil check diğerlerinin yerine
      geçmez.
- [ ] API'ye yalnız doğrulanmış evidence referansı eklenir; token, URL veya JSON boolean'ı
      merge izni olarak kabul edilmez. PR head ilerlerse önceki bütün PR kanıtları geçersizdir.
- [ ] `expected_head_sha` ile tek squash merge yolu kullanılır. Başarı kaydı ancak GitHub'dan
      gerçek merge SHA'sı okunup branch erişilebilirliği doğrulanınca yazılır.
- [ ] Merge kabul edildiği halde bağlantı koptuğunda tekrar merge denemeden canlı PR durumu
      uzlaştırılır. Incident ve kabul kaydı aynı merge'i iki kez sayamaz.

### P09 — GitHub ve kimlik koşullarını gerçek ayarlarla sağlama

- [ ] Önce koruma değişikliğinin diff'ini ve etkisini PR üzerinde hazırla. Main için mevcut
      required-check kümesini koru; imzalı commit, en az bir bağımsız gerekli review,
      CODEOWNER review, çözülmüş konuşmalar ve main'e uygulanan aktif ruleset sağlansın.
      Admin bypass, force push ve branch silme kapalı kalır.
- [ ] Proof üreticisi branch protection ve rulesetlerin birleşik etkin ayarını GitHub'dan
      okur; gerçek enforcement yerine doküman veya var olan CODEOWNERS dosyasını kanıt saymaz.
- [ ] App-only mutation sözleşmesini uygula: scanner, state publisher ve merger kimlikleri
      ayrı, kısa ömürlü ve dar yetkilidir. Doğrulanmamış PAT fallback'i kaldırılır; yokluğu
      gizli credential oluşturularak giderilmez. Secret değerleri Git/log/plan içinde yer almaz.
- [ ] Mevcut managed Claude Code oturumu ve bwrap containment sözleşmesi korunur;
      runtime API-key yönlendirmesi veya prompt içinden kendi yetkisini yükseltme yolu açılmaz.
- [ ] Değişiklikten sonra `branch_protection_proof_invalid` dahil readiness nedenleri tekrar
      ölçülür. Eksik dış yetki/kimlik açık blocker'dır; kontrol kaldırılarak yeşil yapılmaz.

## 4. Bütün workflow'ların mimari onarımı

### P13 — Repo genelinde gözlem, kök neden ve doğrulanmış onarım

**Mevcut sahipler:** `aria-kernel/aria_kernel/ci.py`, `github_adapters.py`, `own_pr_ci.py`,
`cycle.py`, `pressure.py`, `finding.py`, `architecture.py`, `state_manifest.py`,
`gateway/server.py` ve `gateway/router.py`;
`.github/workflows/scheduled-workflow-watchdog.yml` ile
`.github/manifests/scheduled-workflows.json`.
Mevcut `ci/*` kayıtları genişletilir; ikinci bağımsız finding/merge sistemi kurulmaz.

**Koddan doğrulanmış boşluk:** `ci.inventory_workflows` kaynak YAML envanteri çıkarır;
`record_ci_report` kendisine verilen PR/run snapshot'ını kaydeder. `scan_own_prs` yalnız
`aria/*`/`automation/*` PR'larını bu kayıtlara bağlar. Repo PR health gözlemi sınırlı sayıda
açık PR'a bakar; scheduled watchdog manifestteki işleri izleyip issue üretir. Bunlar bütün
repo run'larını toplayan, teşhis edip düzeltmeye bağlayan tek bir producer değildir.

- [ ] `github_adapters.py` içine bütün repo workflow/run/job sayfalarını okuyan dar yetkili
      okuyucu ekle. Workflow adı veya PR yazarı için ARIA filtresi uygulanmaz. Kaynak YAML,
      GitHub registry ve dynamic workflow kimlikleri aynı envanterde, kökeni belirtilerek tutulur.
- [ ] `cycle.py` üzerinden düzenli repo-geneli uzlaştırma çalışsın. Kalıcı cursor/watermark,
      örtüşen yeniden okuma penceresi ve sayfalama tamamlama kanıtı ile kaçırılan/geciken run'lar
      tamamlanır. API hatası/rate limit/erişim yokluğu boş sağlıklı listeye dönüşmez. Bir tur
      bütçesi
      dolunca devam cursor'ı korunur; ilk sayfa bütün kapsam diye raporlanmaz.
- [ ] İmzalı event gateway'nin doğruladığı `workflow_run`/`check_suite` olayları aynı intake'e
      erken bildirim olabilir; scheduled uzlaştırma kaçan olayları tamamlar. Mevcut scheduled
      watchdog'a ikinci event-chain eklenmez; onun manifest/issue kanıtı ortak reducer'a bağlanır.
      Gateway router'ın mevcut ayrı runtime-signal yolu canonical CI olayına bağlanır; aynı
      teslimin ardından API taraması ikinci finding üretmez. Polling bütün kapsam için zorunludur.
      Canlı webhook erken bildirimi ancak subscription, imza kimliği ve gateway işletimi normal
      L3 bootstrap PR/operasyon makbuzuyla doğrulanınca aktif sayılır; yapılandırılmamışsa
      `inactive`
      raporlanır, yeni webhook deployment'ı polling kabulünün örtük önkoşulu yapılmaz.
- [ ] Immutable CI olayı; repo, workflow id/path ve kaynak SHA, run id+attempt, event,
      head/base SHA, varsa PR, job/step kimliği, status/conclusion, API okuma zamanı ve
      redakte log/artifact digest'lerini taşır. Aynı run+attempt tek kayıt etkisi yapar; yeni
      attempt ayrı kanıttır. PR'sız main/schedule/dispatch ve workflow zincirleri de aynı
      sözleşmededir.
- [ ] Log, annotation, PR metni ve artifact güvenilmeyen veridir. Teşhis talimatı, shell komutu,
      workflow veya çalıştırılabilir dosya olarak tüketilmez. Ayrıcalıklı intake güvenilmeyen
      head'i
      checkout edip çalıştırmaz; kaynak ve kanıt boyut/süre limitli, redakte ve kökeni doğrulanmış
      okunur.
- [ ] Failure reducer'ı gözlem kimliği ile kök neden kimliğini ayırır. Aynı run tekrarları ve
      aynı nedenden düşen bağımlı kapılar tek finding'e bağlanır; farklı branch/SHA'daki bağımsız
      nedenler yalnız benzer hata metni yüzünden birleştirilmez. Çözülen nedenin tekrarı bulguyu
      yeniden açar. Watchdog issue'su, finding ve remediation PR karşılıklı referans taşır.
- [ ] `failure`, `timed_out`, `action_required`, çalışan/bekleyen, cancelled, skipped, neutral,
      stale, disabled ve no-run ayrı durumlardır. Beklenen concurrency iptali kaynak kanıtıyla
      açıklanabilir; çalışmamış zorunlu iş başarı sayılmaz. Beklenen tetikleme/iş/artifact kapsamı
      kayıtlıdır; bütün anlamlı adımlar atlanmış yeşil run kapanış kanıtı değildir.
      Bilinmeyen/yeni status veya conclusion, eksik job/attempt kaydı ve teşhis için gerekli
      kanıtın okunamaması açık `unknown`/blocker üretir; varsayılan sağlıklı sonuca dönüşmez.
- [ ] Teşhis; exact workflow/job/step, ilgili source/test/lockfile/config sürümleri, ilk başarısız
      sınır, beklenen sözleşme ve onu bozan veri akışını kanıtlar. `ci.py` regex sınıfı yalnız
      yönlendirme ipucudur. Kök neden bağımsız review ve güvenli regresyon testiyle doğrulanmadan
      düzeltme adayı oluşmaz; belirsiz veya eksik dış altyapı kanıtı `HUMAN_REQUIRED` kalır.
- [ ] En yüksek uygulanabilir mimari çözümü seç: yanlış durumu sözleşme/tip/tek sahip üzerinden
      imkânsızlaştır, doğru yolu otomatik hale getir veya zorunlu invariant ile yakala. Sadece
      semptomu yakalayan catch/fallback, keyfî timeout büyütme, cache temizleme ve tekrar deneme
      kök neden düzeltmesi sayılmaz. Geçici çevre arızası toparlanırsa durum `recovered` olur;
      mimari düzeltme kanıtı bulunmadan finding `resolved` olmaz.
- [ ] Bağımsız review ve diff/test kapsamı denetimi; test silme/skip, assertion zayıflatma,
      coverage/lint/security eşiği düşürme, `continue-on-error`, `|| true`, workflow/path
      filtresiyle
      zorunlu işi devreden çıkarma veya sahte başarı çıktısını reddeder. Yalnız anahtar kelime
      listesi güvence sayılmaz. Yanlış test sözleşmesi değişecekse doğru kaynak sözleşmesi ve
      onun yerine geçen eşdeğer ya da daha güçlü doğrulama aynı PR'da kanıtlanır.
- [ ] Kaynakta doğrulanmış ve P06 otomasyon koşullarını sağlayan düzeltme, mevcut plan/worker
      yolunda aynı PR'da kod+regresyon üretir. L1/L2 için P07–P10 geçerlidir. Workflow, kernel,
      kontrol düzlemi veya yetki değişikliği L3/yasak-yol kararını devralır; başka bir dosya ya da
      test PR'ı gibi etiketlenmez. ARIA kendi merge yetkisini genişletemez; mevcut normal
      incelemeli
      bootstrap süreci ve aşama açıldıktan sonra gereken ayrı insan onayları korunur.
- [ ] Her onarım commit/push/PR/main zincirinden geçer. Kapanış için tam merge SHA'sında aynı
      kontrolün gerçekten çalıştığı doğrulanır; scheduled sorununda sonraki beklenen scheduled
      çalışma ayrıca görülür. Eski commit'in yeşil rerun'ı, başka PR'ın başarısı veya salt
      proposal
      kaydı onarım değildir. Tekrarlamada merge'ler durur, incident/reopen ve P12 rollback devreye
      girer.
- [ ] Deployment, üretim migration/restore, secret değişikliği veya aktif güvenlik yürütümü
      içeren workflow'ların durumu da izlenir. Onarım doğrulaması bu yan etkileri kendiliğinden
      dispatch/rerun ile başlatmaz; güvenli kaynak testi ve ilgili mevcut yetkili operasyon kanıtı
      kullanılır.
- [ ] Kapsam raporu her registry kaydını bir duruma eşler; yeni workflow otomatik envantere girer,
      silinen/yeniden adlandırılan ve dynamic kayıtların geçmişi kaybolmaz. İzleyici/producer'ın
      kendi heartbeat'i bağımsız watchdog tarafından ölçülür; izleyici sustuğunda sağlıklı rapor
      oluşmaz.

**Test sahipleri:** `aria-kernel/tests/test_enterprise_ci_loop.py`,
`test_own_pr_ci_feedback.py`, `test_ci_gh_pr_snapshot.py`,
`invariants/v12/test_phase_v12_f_gateway.py` ve
`tests/invariants/production-ops-proof-contract.spec.ts` genişletilir.
Sayfalama/backfill, tekrar event/attempt, PR'sız main ve schedule failure, geç gelen sonuç,
eksik kaynak kanıtı, güvenilmeyen log, yanlış birleştirme, yeniden açma ve kontrol zayıflatma
senaryoları gerçek çağrı yolunda olumlu/olumsuz testlerle doğrulanır.
Gateway testleri HMAC/replay doğrulamasını, fork payload'ının yalnız veri kalmasını, ayrıcalıklı
checkout/mutation olmamasını ve imzalı teslim ile API uzlaştırmasının ortak olay kimliğini
doğrular.

**Kabul:** Envanter kapsamı yüzde 100 muhasebeleştirilir; bu bütün workflow'ların çalıştırılması
veya bütününün yeşil olması demek değildir. En az bir ARIA dışı gerçek kaynak hatası,
ARIA'nın gözleminden mimari düzeltme PR'ına, izinli merge'e ve aynı kontrolün merge-sonrası
kanıtına kadar izlenir. Çözülemeyen işler sahibi, kanıt eksikliği ve blocker'ıyla açık kalır.
Bootstrap sırasında normal yetkili merge ile doğrulanan onarım, ARIA otonom merge başarısı
sayılmaz. Gerçek ARIA merge kabulü P10 eşikleri, incelenmiş policy ve ilgili güncel head
onaylarıyla
P12'de ayrıca tamamlanır; L3 için iki ayrı insan onayı korunur.

## 5. Kanıtlı mimari bilgi ve ölçülmüş öğrenme

### P14 — Her iddiası yanlışlanabilir, güncel ve işe etkisi ölçülen öğrenme

**Kod tabanı:** Aşağıdaki ek inceleme `main@411c86835d573b8ee0ffc706c5576ebae90daa6a`
üzerindeki gerçek çağrı yollarına dayanır. Tarihsel Markdown başarı beyanları kanıt olarak
kullanılmadı.

| Mevcut mekanizma                                  | Gerçek kod sahibi                                                                                 | Tamamlanacak boşluk                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Cycle öncesi/sonrası öğrenme hook'ları            | `aria-kernel/aria_kernel/cycle.py`, `learning.py`                                                 | Hook kısmi hatasının sonraki bilgi tüketicilerine açık capability kaybı olarak taşınması     |
| Git blob/SHA doğrulamalı belief ve yaş/head decay | `memory.py`, `evidence_trust.py`                                                                  | Tüm bağımlı claim/flow/context boyunca invalidation ve worker anında freshness               |
| Repo haritası ve bağımlılık etki analizi          | `twin.py`, `impact_graph.py`, `recursive_impact.py`                                               | Nx, NATS, event ve gerçek iş akışı ilişkilerinin aynı kanıtlı projeksiyonda uzlaştırılması   |
| Nx + NATS üzerinden plan kapsam tanığı            | `tools/gates/plan-coverage-witness.ts`                                                            | Static ilişki ile gerçekten yürütülmüş davranış kanıtının ayrılması; P07 consumer bağlantısı |
| Event sözleşmesi AST adapter'ı                    | `tools/aria-adapters/event-contracts-adapter.ts`, `adapter_portfolio.py`                          | Mevcut SHADOW kaydının çalışmış/güncel adapter sonucu sayılmaması                            |
| Göreve ilgili bellek ve kaynak alıntısı aktarımı  | `agent_invocations.py`, `planner_dispatch_hook.py`, `evidence_excerpts.py`                        | Alıntıyı working tree yerine tam hedef Git blob'una bağlama; stale context'i reddetme        |
| Convention promotion ve iş kaynağı önceliği       | `knowledge_graph.py`, `implementation_reconciler.py`, `change_outcome.py`, `mission_scheduler.py` | Merge/convergence oranını doğruluk veya fayda ödülü saymama; gerçek outcome doğrulaması      |

Bu öğrenme mevcut model ağırlıklarını eğitmek değildir: kalıcı gözlem, doğrulanmış bilgi,
bağlama uygun retrieval ve karar önceliklerinin geri bildirimidir. Model fine-tuning veya
embedding servisinin çalıştığı bu incelemede kanıtlanmadı; P14 bunları önkoşul yapmaz.

**Başkalarının değişiklikleri — mevcut sınır:** `cycle_diff.py` dosya/hash farkını yazarından
bağımsız görür; `memory.py` evidence dosyasına dokunan commit üzerinden eski belief'i yeniden
doğrulamaya gönderir. Ancak `pr_tracking.py` production merge ingestion'ı ARIA'nın
`pr-lifecycle.jsonl` kayıtlarını tüketir; `change_outcome.py` da kendi change-ledger zincirine
bağlıdır. Webhook girişi bütün merge geçmişini tamamlayan bir API reconciler değildir.
Dolayısıyla genel kod drift'ini fark etmek, herkesin değişiklik amacını ve sonucunu öğrenmekle
aynı şey değildir.

**Kalıcı öğrenme ölçümü:** Yukarıda sabitlenen `origin/aria/state@e5709b087` ağacında
8 belief, 2 observation, 11 uncertainty, 33 cycle-diff ve 16 learning-event kaydı vardır.
Son belief zamanı `2026-09-04T20:13:27Z`'dir. Twin haritası `2026-09-04T09:35:19Z` tarihinde
`563d106` SHA'sına bağlı, `local_import_scan_v1` kökenli 71 projelik bir görünüm üretmiştir;
güncel `main@411c868` haritası değildir. Bu state ağacında merge-events, evidence-impact,
PR lifecycle veya change-outcome makbuzu bulunmaması, kalıcı uçtan uca öğrenme kanıtının eksik
olduğunu gösterir. Kayıt sayıları doğruluk, kapsama oranı veya öğrenme başarısı değildir.

**Mimari karar:** Mevcut evidence/knowledge kayıtlarından deterministik, sürümlü bir
kanıt grafiği projeksiyonu çıkar. Kaynak kodu, yetki envanteri ve yürütülmüş kanıt asıl kaynaktır;
graf, embedding ve okunabilir dokümanlar yeniden üretilebilir görünümlerdir. Hash zinciri
kaydın değişmediğini gösterir; içindeki iddianın doğruluğunu ayrıca verifier sınar.

**Mühendislik çalışma sözleşmesi:** ARIA'nın işi yalnız tarama bulgusu üretmek değildir.
Operatörün amacı ve yetkili backlog/mission, yapılacak işin nedenidir; repo haritası bu amaca
ulaşacak doğru değişikliği tasarlamak için kullanılır. Haritayı ezberlemek veya belge sayısını
artırmak başarı değildir. Planlama → kodlama → doğrulama → sonuçtan öğrenme aynı iş kimliğine
bağlanır.

- [ ] Kodlamadan önce bir `TaskUnderstanding` kaydı oluştur: kullanıcı/mission amacı,
      mevcut ve istenen davranış, ilgili iş akışı, kaynak sahibi modüller, veri/tenant sınırı,
      dış sözleşmeler, etkilenen tüketiciler, korunacak invariant'lar ve açık sorular.
      Her teknik iddia current-SHA kanıtına bağlıdır. Amaç verilen işten gelir;
      ARIA kendi ürettiği tarama skorunu kullanıcı gereksiniminin yerine koymaz.
- [ ] İlgili bölümün current-SHA haritası kodlama başlamadan zorunlu olarak hazırlanır:
      girişler, iş akışı, veri sahipleri, çağıran/çağrılan modüller, event/API sözleşmeleri,
      ters bağımlılıklar ve koruyucu testler. `TaskUnderstanding` ve `ContextManifest` bu
      haritanın digest'ini taşır. Worker mint ve ilk yazma izni harita/kanıt tazeliğini denetler;
      eksik veya stale zorunlu sınırda yalnız kaynak okuma, testle doğrulama ve yeniden planlama
      ilerler. Yeni özellikte mevcut entegrasyon sınırları ile önerilen yeni ilişkiler ayrıdır;
      tasarım varsayımı mevcut sistem gerçeği gibi haritaya yazılmaz.
- [ ] Planner bu anlayıştan değişiklik tasarımını çıkarır: değişecek sözleşme ve sahip,
      producer/consumer/migration/test etkisi, makul seçenekler, seçimin gerekçesi,
      kabul ve geri alma koşulları. Mevcut mimariyi uygulayan bir değişiklikle mimariyi
      değiştiren kararın riskleri ayrı değerlendirilir. Bilinmeyen yük taşıyan sınır çözülmeden
      worker'a geniş ve tahmine dayalı kod değişikliği görevi verilmez.
- [ ] Worker yalnız bulgu başlığını veya dosya listesini almaz; doğrulanmış amaç/akış/tasarım
      ve gerekli test bağlamını alır. Yeni bilgi tasarım varsayımını çürütürse kodu semptomlara
      uydurmaz; aynı işte yeniden planlama ve ilgili review tetiklenir. Düzeltme sonrası öğrenme,
      hangi mimari varsayımın doğru/yanlış çıktığını ve başka akışlara etkisini kaydeder.
- [ ] Yeni özellik veya düzeltmede gereksinim → kaynak sahibi → uygulama/sözleşme → test →
      gerçek sonuç eşlemesi eksiksiz olsun. Gerektiği halde eksik kalan migration, event
      tüketicisi, yetkilendirme, tenant sınırı, kullanıcı akışı veya operasyonel bağ `incomplete`
      üretir. Yalnız değişen dosyanın testi yeterli değildir; etkilenen diğer akışların
      regresyon kanıtı ve bütün gereksinimlerin karşılığı görülmeden tamamlandı denmez.

- [ ] Bütün main değişikliklerini yazarından bağımsız uzlaştır: insan, ARIA, diğer agent ve
      dependency bot PR'ları ile doğrudan main commit'leri aynı ingestion sözleşmesine girer.
      GitHub webhook düşük gecikmeli bildirim sağlar; sayfalı API/Git uzlaştırması kalıcı cursor
      ve backfill ile kaçırılmış olayları tamamlar. PR adı, branch prefix'i veya ARIA trailer'ı
      öğrenmeye kabul koşulu değildir. Repo/PR/merge SHA/base/head/author türü ve kimliği,
      changed-file digest, review ve CI kökeni saklanır; author kimliği doğruluk veya yetki
      yaratmaz. Cursor ancak ilgili olay ve invalidation aynı doğrulanmış state'e kalıcı
      yazıldıktan sonra ilerler. Tekrarlı delivery aynı öğrenme etkisini iki kez üretmez.
- [ ] Her dış değişiklik aynı dependency invalidation ve outcome reducer'ından geçer.
      PR açıklaması, commit mesajı ve review gerekçesi kaynak gösterilen, güvenilmeyen intent
      hypothesis'idir; diff, sözleşme ve bağımsız sonuçla desteklenmeden verified bilgi olmaz.
      Dış PR'lar için ARIA change-ledger kaydı zorunlu tutulmaz: canonical merge olayı,
      beklenen davranış ve post-merge kanıt `verified/no_gain/regression/unknown` sonucuna
      bağlanır. Açık PR bilgisi aday head'e aittir; merge edilmiş gerçek gibi main belleğine
      geçirilmez. Eksik erişim, silinmiş kanıt ve Git geçmişi değişimi coverage boşluğu üretir.
- [ ] Öğrenme durumunu mevcut CLI/raporda somut göster: izlenen main SHA'sı, son kalıcı
      ingestion/graph doğrulaması, bilinen toplam değişiklik içinde işlenen/kaçırılan değişiklik,
      amacı doğrulanmamış ve sonucu beklenen PR'lar, stale/refuted/unsupported iddialar.
      Her bilgi için ne zaman hangi kaynakla edinildiği, hangi görev/kararda kullanıldığı,
      hangi test veya gerçek sonucun onu doğruladığı/çürüttüğü görülebilsin. Payda bilinmiyorsa
      yüzde uydurulmaz; kayıt sayısı, gözlem kapsamı, doğruluk ve işe katkı ayrı ölçülür.
      Ayrıca canonical proje/servis/akış gereksinim envanterinde kaynakla bağlı, yürütülmüş
      testle kanıtlı, güncel, stale ve unsupported kapsam ayrı raporlanır. Dört örnek akışın
      tamamlanması bütün reponun anlaşıldığı anlamına gelmez; bilinmeyen alan paydadan düşmez.
- [ ] Kurumsal hafıza kararın nedenini, alternatifini, kaynak sahibini ve supersession
      geçmişini korur; güncel serving görünümü ile tarihsel kayıt karışmaz. P02 publisher ve
      artifact bütünlüğü bu kayıtları da kapsar. Yeniden başlatma, kaçırılmış cycle, aynı olayın
      tekrarı ve doğrulanmış state'ten geri yüklemede bilgi/karar bağlantıları kaybolmaz.
      Silme ve redaction politikaları hassas veriyi korurken gerekli invalidation makbuzunu
      bırakır; sınırsız ham veri saklamak veya her şeyi bildiğini iddia etmek hedef değildir.
      Hâlâ geçerli ve göreve gerekli eski karar, `context_compiler.py` son 400 kayıt penceresi
      gibi bir recency sınırı yüzünden erişilemez olamaz; ilgili karar indeksi history'nin
      tamamından türetilir. Güncellik ve supersession kontrolü eski kararda da zorunludur.
- [ ] Belleğe yazma düzeni şemayla uygulanır: canonical repo/proje/servis kimliği altında
      akış, sözleşme/sembol, karar, claim ve kanıt stable kimliklerle bağlanır. Bir ilişki birden
      çok servisi bağlayabilir; aynı bilgi her servis için ayrı gerçek olarak kopyalanmaz.
      Gözlem, intent hypothesis'i, doğrulanmış bilgi, tasarım kararı ve outcome ayrı türlerdir.
      Kaynak SHA/digest, owner, zaman, validity ve supersedes alanları olmadan serving kaydı
      oluşmaz. Tek ingestion doğrulayıcısı dedup/supersession/invalidation kurallarını uygular;
      append-only olaylardan güncel görünüm ve erişim indeksleri yeniden üretilebilir.
- [ ] Kalıcı hafızayı genişletme depolama, indeks ve LLM bağlamı için ayrı bütçelerle yapılır.
      Önce gerçek kayıt/byte/artifact büyümesi ve sorgu süresi ölçülür; aktif geçerli bilginin
      erişimini bozan keyfi son-N sınırı yerine tüm geçmişe erişen sürümlü indeks kullanılır.
      Arşiv/compaction, kaynak ve karar kökenini korur; yeniden doğrulama gereken bilgi sıcak
      serving belleğinden ayrılır. Daha fazla geçmiş saklamak her prompt'a daha fazla metin
      ekleme gerekçesi değildir. Mevcut 1.200 token/12 karar sınırı tüm prompt'un sınırı değil,
      yalnız karar hafızası ekinin varsayılanıdır; zorunlu bilginin sığmadığı iş tekrar planlanır.

- [ ] P04/P13 köken sözleşmesini mevcut `evidence_refs` ve knowledge graph'a genişlet.
      `LearningAssertionV2` iddia kimliği, açık önerme, ilgili sembol/ilişkiler, source blob SHA,
      target/base/merge SHA, extractor sürümü, bağımlı claim kimlikleri, verification kind,
      kanıt referansları, gözlem zamanı ve validity durumunu taşır. Yürütülmüş iddia ayrıca
      immutable test/workflow/run/job/attempt ve artifact digest ister. Bir agent'ın kendi
      yazdığı özet veya Markdown cümlesi bağımsız doğrulama kanıtı olamaz.
- [ ] Kanıt türleri `static`, `executed_test`, `runtime_attested` olarak ayrı kalsın.
      Dosyanın varlığı, AST'nin gösterdiği ilişki, testin tanımı, testin gerçekten geçmesi ve
      canlı iş sonucunun gözlenmesi aynı iddia değildir. Eksik/çelişkili ilişki `unknown` veya
      `refuted` olur; güven puanı eksik kanıtı tamamlamaz. Her derived iddia kanıt zincirine
      açılır.
- [ ] Mevcut `twin`/impact sahipleri üzerinden typed graph düğümleri üret: proje, servis,
      sembol, tenant/schema sınırı, NATS kimliği/subject, event sözleşmesi, workflow/job/test ve
      business-flow adımı. `imports`, `calls`, `publishes`, `subscribes`, `request_reply`,
      `validates`, `persists`, `proves` kenarlarının her biri kaynak/ref/digest taşır. Statik
      çözümleyicinin bulamadığı dinamik çağrı, ilişki yokmuş gibi işaretlenmez.
- [ ] Nx graph'ın command/API kökeni, tam kaynak SHA'sı ve dependency/lockfile hash'leri
      kaydedilsin. Mevcut alias/import çıkarımı açık daha düşük coverage'lı yöntemdir;
      gerçek Nx grafı gibi sunulmaz. Cache yalnız aynı input digest ile kullanılabilir.
- [ ] `infrastructure/nats/services.yaml`, canonical NATS config üreticisi,
      `libs/event-contracts/src/platform-event-registry.ts`, event şemaları ve gerçek
      publisher/subscriber/request-handler kaynaklarını birlikte uzlaştır. Cert-CN kimliği,
      subject yetkisi ve producer/consumer sözleşmesi ayrı kenarlardır. Nx build bağımlılığı
      tek başına runtime mesajlaşma veya tenant izolasyonu kanıtı değildir.
- [ ] İlk dört akışı executable flow sözleşmesi olarak çıkar: tenant oluşturma, parola
      sıfırlama, sensör alımı ve billing. Her biri giriş → kimlik/tenant → command/handler →
      persistence/outbox → event/RPC → consumer → sonuç zincirini, kaynak sahibini, hata,
      idempotency ve tutarlılık beklentisini içerir. Her zorunlu kenar bir kaynak iddiasına ve
      onu gerçekten çalıştıran mevcut invariant/integration/contract testine bağlanır.
- [ ] Kaynakta gözlenen farkları graph'a doğru taşı: parola reset event'leri mevcut
      best-effort publisher allowlist'indedir, durable outbox diye etiketlenmez.
      `apps/sensor-ingestion/src/events.rs` ile Nest ingestion consumer'ındaki
      `telemetry.*.SensorMetricIngested`, `services.yaml` sidecar publish kaydında görünen
      `SensorReading` izinleriyle uzlaştırılmalıdır. Bu statik metadata/kod farkıdır;
      gerçek deploy/CN/ACL sonucu okunmadan canlı arıza denmez. Çelişki açık coverage/finding
      üretir.
- [ ] Test→CI erişilebilirliği de graph kenarıdır. Test dosyasının bulunması başarı değildir;
      hangi Nx/script/workflow job'unun onu çalıştırdığı ve hangi SHA'da sonucunun üretildiği
      gösterilir. Shared schema/NATS/event listeleri yeni sabit dizilere kopyalanmaz; mevcut
      canonical invariant/registry tüketilir. `architecture_spine_gate.py` içindeki paralel
      `_SHARED_SCHEMA_TABLES` listesi bu sahiplik ilkesiyle kaldırılır.
- [ ] Invalidation reducer önce supersession/refutation/iptal ve latest-row durumunu fold
      eder, sonra serving güven eşiğini uygular. `knowledge_graph.py` convention/pattern
      okuyucularındaki eşikten önce eski yüksek güvenli satıra dönme olasılığı regresyonla
      kapatılır. Yeni düşük güvenli ret kaydı eski doğrulanmış iddiayı canlandıramaz.
- [ ] Kod, event/NATS şeması, dependency, migration, test, workflow, extractor veya politika
      değişikliği bağlı claim/flow/plan/context/outcome'u `needs_revalidation` yapar. P02/P10
      kanıt iptalleri aynı zincirde uygulanır; history silinmez. Yalnız etkilenen altgraf yeniden
      hesaplanır; karşılıklı kaynak bağımlılıkları SCC/kapanış üzerinden sonlu işlenir,
      kendi kendini kanıtlayan claim döngüsü reddedilir. Değişmeyen inputtan aynı content digest
      çıkar.
- [ ] `evidence_excerpts.py` target SHA'yı zorunlu alır; alıntı doğru Git blob'undan çıkar,
      working tree içeriği onun yerine geçmez. Worker mint ve doğrulama anında source/graph/
      test/policy digest'leri tekrar eşleşir. Eski fakat iyi yazılmış bir özet güncel gerçek
      sayılmaz.
- [ ] Planın dosyaları, riskli sınırları ve ters bağımlılıkları için P07 coverage witness
      gerekli kontrol kümesini trusted controller'da üretir. `verification_gate.py` hem
      çalıştırılan komutların izinli olduğunu hem bütün gerekli testlerin gerçekten çalışıp
      geçtiğini kanıtlar; yalnız izinli komut listesinin bir altkümesini çalıştırmak yetmez.
      Belirsiz impact veya eksik zorunlu iş geçerli karar üretmez.
- [ ] Planner/worker context'i aynı current-SHA graph'tan, path/symbol/tenant/event ve
      doğrudan ters bağımlılık ilişkisine göre seçilir. Deterministik sıralama, hop/node/token
      bütçesi ve `ContextManifest` kullanılan claim/blob/test/policy hash'lerini taşır.
      Zorunlu bilgi bütçeye sığmıyorsa sessiz kesilmez; görev daha küçük kapsamla tekrar
      planlanır.
      Mevcut `derived_context` etiketi korunur; hypothesis açık sorudur, doğrulanmış bilgi
      değildir.
- [ ] Belirsizlik aktif bir plan girdisi olsun: ARIA hangi bağlantıyı veya sonucu bilmediğini
      kaydedip önce onu aydınlatan güvenli kaynak sorgusu, mevcut test veya bağımsız incelemeyi
      seçer. Bilgi kazanımı iş etkisi/risk/maliyetle önceliklenir; soru çözülmeden düzeltme
      uydurulmaz.
      Bu mekanizma aktif saldırı, exploit üretimi veya müşteri ortamında deney başlatmaz.
- [ ] Öğrenme adayları hypothesis olarak karantinaya alınır. Deterministik kaynak doğrulaması
      ve bağımsız evaluator/counterexample sonucu gelmeden supported/verified seviyesine
      yükselmez. Aynı kanıttan türeyen çok sayıda agent görüşü tek kökene sahiptir; bağımsız
      başarı gibi sayılmaz. Öğrenme hook'u çökerse o bilgiye dayalı otomasyon bloke olur;
      gözlem/teşhis ve normal insan çalışması sürdürülebilir, stale bilgi kullanılmaz.
- [ ] `implementation_reconciler.py` merge makbuzunu teslimat olarak kaydeder; tek başına
      convention'ı sabit `0.75` güvenle verified yapan promotion yerine `OutcomeProof` ister.
      Problem fingerprint'i, beklenen davranış, baseline, düzeltme SHA'sı, ilgili regresyon,
      merge sonrası doğrulama penceresi ve tekrar/rollback sonucu birlikte değerlendirilir.
      Eşzamanlı ilgisiz değişikliklerin etkisi ayrılamıyorsa nedensel sonuç `unknown` kalır.
- [ ] Scheduler/source-prior ödülü merge sayısı veya metin üretilmesinden gelmez. Doğrulanmış
      düzeltme etkisi ve kalıcılığı olumlu; yanlış bilgi, tekrar açılan kök neden ve gerileme
      olumsuz kanıttır. Run retry'ları/dedup eşdeğerleri bir kez sayılır. P10 otonomi sayaçları,
      öğrenme kalite puanı ve delivery sayısı ayrı anlamlarını korur; biri diğerini doldurmaz.
- [ ] Token ekonomisinin mevcut sahiplerini birleştir: `ci_executor`, `claude_runtime.py`,
      `usage_ledger.py`, `budget.py`, `context_budget_gate.py` ve `token_economy.py`.
      Sabit state'te Ağustos döneminden 365 usage kaydı ve yalnız iki cost-attribution satırı
      vardır; Eylül attribution shard'ı veya economy recommendation kaydı yoktur. Stream'in
      cache alanları, hash'li prompt kaydı ve tahmini USD gerçek tasarruf/fatura kanıtı değildir.
      Best-effort kayıt ve varsayılan enforce edilmeyen context denetimi ölçülmüş ekonomi
      iddiasını desteklemez; üretici/consumer bağlantısı acceptance testinde doğrulanır.
- [ ] Gerçek çağrının terminal usage'ından doğrulanmış receipt üret: input/output/cache-write/
      cache-read tokenları, model/profile/role, request/attempt, sağlayıcı maliyet alanı ve
      tahminin fiyat/sürüm kökeni ayrı saklanır. Subscription/API fatura türü ile karşılaştırma
      amaçlı liste fiyatı tahmini karışmaz. Kayıt başarısız veya usage eksikse bu çağrı maliyet
      bakımından `unknown` kalır; tasarruf/ROI başarısı yazılmaz ve bütçe rezervi serbest
      bırakılmaz. Gerçek receipt ile reserved/actual uzlaştırması idempotent olur.
- [ ] Her iş/cycle için çağrı öncesi toplam token/maliyet ve retry rezervasyonu uygula;
      planner, worker, reviewer, başarısız deneme ve model fallback aynı bütçeye dahildir.
      Yetersiz veya kaynağı belirsiz bütçede yeni çağrı başlatılmaz; durma nedeni ve kalan iş
      kaydedilir. Context bütçesi request mint'te zorunlu denetlenir. Bütçeye sığdırmak için
      gerekli invariant/review/kanıt atlanmaz; görev bölünür veya yeniden planlanır.
- [ ] Kaynak haritası, değişiklik uzlaştırma, geçerlilik, dedup ve test seçiminin deterministik
      kısmı LLM gerektirmez. Değişmeyen ilgili girdi ve yeni amaç/kanıt yokken aynı analize tekrar
      token harcanmaz. Yeniden kullanılabilir context/fact anahtarı target SHA, model/profile,
      role, kaynak/dependency/evidence/policy digest'lerini bağlar; değişiklik invalidation
      üretir. Prompt hash'i cache hit sayılmaz; sağlayıcı cache kullanımı gerçek usage'dan
      ölçülür. Yeniden kullanım zorunlu bağımsız inceleme veya final-head testinin yerine geçmez.
- [ ] Ekonomiyi doğrulanmış tamamlanmış iş başına ölç: bütün denemeler ve incelemeler dahil
      toplam token/maliyet, süre, yeniden açılan hata, çapraz akış regresyonu ve gereksinim
      tamlığı. Bellek açık/kapalı ve effort/model önerileri aynı güvenli holdout'ta karşılaştırılır;
      başarısız/başarılı ve cached/noncached kullanım ayrı görülür. Ucuz fakat eksik/yanlış sonuç
      iyileşme değildir. Daha düşük effort önerisi kalite ve required-check korumasını
      kanıtlamadan uygulanmaz; tasarruf hedefi merge/risk yetkisini genişletmez.
- [ ] Öğrenme sürümünü korunan değerlendirme setinde önce shadow olarak karşılaştır: aynı
      görevlerde bellek açık/kapalı baseline, kaynak alıntısı doğruluğu, doğru test seçimi,
      stale bilgi kullanımı, tekrar eden hata, çapraz servis gerilemesi, maliyet ve süre ölçülür.
      Geçmiş güvenli regresyonlardan sabit replay ve zaman/servis bakımından ayrılmış holdout
      kullanılır; adayın bu seti/puanlama kuralını değiştirmesi veya cevabını serving belleğine
      yazması engellenir. Zorunlu invariant gerilemesi ve stale/uydurulmuş kanıtla karar sıfır
      olmalı;
      iyileşme bağımsız sonuçlarla gösterilmeden otomasyon için promotion yapılmaz.
- [ ] Kaynak/log/embedding girdileri retrieval'dan önce secret/PII redaction, erişim kapsamı,
      saklama süresi ve egress politikasından geçer. `semantic_memory.py` operatörün embedding
      komutunu çağırabiliyor olması metni dışarı gönderme izni değildir. Embedding yalnız
      geçerli/erişilebilir claim'i bulur; kanıt veya yetki yaratmaz. Alıntılar talimat olarak
      çalışmaz.
- [ ] `.claude/knowledge/layer-*.md` için okunabilir görünüm gerekirse aynı claim'lerden
      kaynak SHA, dependency digest, kanıt türü, son doğrulama ve valid/stale/refuted durumuyla
      üretilir ve normal PR'dan geçer. `docs/aria/CONTRACTS.md`/CLAUDE/policy normatif kuralları
      öğrenme çıktısı tarafından değiştirilmez; bağlantı ve kanıt görünümü ile otorite ayrıdır.
- [ ] P14 güncel graph/kanıt/context sözleşmesini P06 düzeltme işçisine, P07 coverage'a,
      P08 final-head kararına ve P13 workflow onarımına gerçek production çağrılarıyla bağlar.
      Salt yeni CLI, adapter kaydı veya doküman üretimi teslimat değildir. L1/L2/L3 yetkileri,
      insan onayları ve no-suppression koşulları aynen korunur.

**Zorunlu regresyonlar:** Yanlış SHA'daki alıntı reddi; yeni refutation'ın eski yüksek güveni
iptal etmesi; yalnız merge ile verified oluşmaması; değişen event/test/workflow'un bağlı
flow/context'i stale yapması; Nx/NATS/registry/code çelişkisinin açık coverage boşluğu olması;
atlanan required testin reddi; gateway/API aynı olayın tek öğrenme etkisi; holdout sızıntısı ve
yetkisiz embedding egress reddi; bilgi producer'ından worker/final gate'e gerçek çağrı erişimi.
İnsan ve bot merge'leri ile doğrudan main commit'lerinin aynı invalidation'a ulaşması;
kaçırılan webhook'un backfill ile tamamlanması; publish başarısızken cursor ilerlememesi;
restart/restore sonrası karar kökeninin korunması ve bilinmeyen coverage'ın başarı sayılmaması.
400'den fazla ilgisiz yeni olaydan sonra eski ilgili kararın bulunması; superseded sürümün
uygulanmaması ve örnek akış coverage'ının bütün repo coverage'ı gibi raporlanmaması.
Haritasız/stale haritalı worker'ın yazma izni alamaması; yeni tasarım ilişkisinin mevcut gerçek
diye servis edilmemesi ve yanlış tür/kökenle belleğe yazmanın reddedilmesi.
Eksik usage receipt'in başarı sayılmaması; aynı receipt'in iki kez düşülmemesi; paralel çağrı,
retry ve fallback'in toplam rezervi aşamaması; daha büyük hafızada bağlam bütçesi korunurken
zorunlu eski kararın seçilmesi; düşük effort'un kalite gerilemesinde promotion alamaması.

**Kabul:** Dört örnek akış kaynak bağlantıları ve mevcut güvenli testlerin gerçekten çalışmış
kanıtlarıyla gösterilir; statik ve canlı iddialar ayrı kalır. En az bir ARIA dışı gerçek P13
onarımı,
doğru öğrenme/context kullanımından merge-sonrası outcome'a kadar izlenir. Bir kaynak değişikliği
eski bilgiyi otomatik geçersiz kılar; sonraki görev güncel kanıtı ister. Aynı sabit görev
kümesinde
önceki sürüme göre öğrenmenin katkısı raporlanır; başarısı kanıtlanmayan sürüm gözlemde kalır.

## 6. Projeye uyarlanma, öz-anlayış ve yetenek yaşam döngüsü

### P15 — Kendi mimarisini bilen ve yeteneklerini kanıtla geliştiren ARIA

**Kodla doğrulanmış başlangıç (`main@411c868`):** `snapshot.py` ve `discovery.py` ARIA'nın
takipli kendi dosyalarını dışlamaz; cycle twin'i yeniler. `twin.py`, kernel Python test/import
bağlarını çıkarır, fakat `tools/aria-poc` ve workflow trigger/izin/control bağımlılıklarını tam
modellemez. Sabit state haritasında 215 kernel kaynak dosyası için 1.351 test bağlantısı vardır;
bu tüm ARIA mimarisinin
güncel anlaşıldığını kanıtlamaz. `reflection.py` ve `self_improvement.py` gözlem/öneri üretir;
kalıcı yedi reflection kaydı 16–19 Ağustos tarihlerindedir.

`learning.py` genesis request üretimine bağlıdır. `agent_genesis.py` ve `skill_genesis.py`
sandbox, scope/model ve approval kapılarından sonra sınırlı Markdown hedeflerini materialize
edebilir; CLI girişleri vardır. Skill drainer orchestrator'a bağlanmıştır. Buna karşılık
agent materialization'ın otomatik workflow çağrısı, agent retirement/silme üretim yolu ve
operator curation'ı düzenli çalıştıran hat bulunmadı. Markdown skill üretimi executable
adapter üretimi değildir; ayrı teslimat kanıtı gerekir.

`self_improvement.py` kendi kaynak değişikliğini HIGH human-required öneriye çevirir;
authority alanlarını reddeder. `apply_engine.py` self-change için özel lane gerektiği için
uygulamayı reddeder. Genel implementer da kernel/agents/workflow/POC alanlarını readonly tutar.
Dolayısıyla mevcut kod, kendi kendini uçtan uca değiştirip yayınlayan bir ARIA kanıtı değildir.

**Sahipler:** P14 graph/context ve outcome; `runtime_profile.py`, `discovery.py`, `twin.py`,
`reflection.py`, `self_improvement.py`, `agent_genesis.py`, `skill_genesis.py`,
`skill_genesis_drainer.py`, `skill_curator.py`, `apply_engine.py`; mevcut sandbox,
state publisher, review ve merge authority. Paralel kernel/agent registry oluşturulmaz.

- [ ] Projeye uyarlanmayı kaynakla doğrulanmış `RepositoryProfile` projeksiyonuna bağla:
      canonical repository kimliği, framework/dil/build/test araçları, modül/veri sahipleri,
      ürün akışları ve mevcut release/operasyon sözleşmeleri. Operatörün ürün amacı ile
      keşfedilmiş mevcut gerçek ayrı tutulur. Nx/NATS/Aqua örnekleri bu repo profilidir;
      bütün projelerin bu teknolojilere sahip olduğu varsayılmaz. Desteklenmeyen extractor
      veya iş akışı `unknown/capability_gap` olur. Farklı repoların bellek, izin ve kanıtları
      repository kimliğiyle ayrılır; bir repoda doğrulanmış domain kuralı ötekine taşınmaz.
- [ ] P14 grafik kapsamına ARIA'nın kendisini birinci sınıf sistem olarak ekle:
      kernel phase/CLI çağrıları, POC executor, agent/skill/adapter registry, sandbox,
      state writer/reader, ledger/snapshot, workflow trigger/job ve izin bağımlılıkları.
      Python/shell/YAML/registry değişimi ilgili grafı geçersizleştirir; yalnız TS veya Nx
      proje değişimi tetikleyicisi yetmez. Secret değerleri graf girdisi değildir; erişim
      sınırı ve bağımlılık kimliği gösterilir. ARIA kendini değiştirmeden de önce bu haritayı
      çıkarır; kendi yazdığı mimari açıklama bağımsız kanıt yerine geçmez.
- [ ] Reflection ve self-improvement önerisini P14 `TaskUnderstanding`/outcome zincirine
      bağla: hangi gerçek görevde hangi capability eksik kaldı, neden mevcut agent/skill
      yetmedi, hangi kaynak ve sonuç bunu kanıtlıyor. Kendi teşhisinden üretilen aynı kökenli
      üç öneri üç bağımsız kanıt sayılmaz. Önce mevcut yeteneğin kullanımı/güncelliği ve
      mükerrerlik incelenir; yeni agent yaratmak varsayılan çözüm değildir.
- [ ] Agent, Markdown skill ve executable adapter yaşam döngülerinin farkını koru ve mevcut
      sahipler üzerinden tek iş kimliğiyle bağla: request → taslak → sandbox/fixture/eval →
      bağımsız review/policy kararı → PR → doğrulanmış main SHA → registry/discovery
      activation → gerçek görev outcome'u. Bir dosyanın yazılması veya adapter'ın SHADOW
      kaydı etkinleşme sayılmaz. Gereken executable adapter, test, registry ve consumer bağı
      aynı teslimatta tamamlanır; yalnız Markdown üretip çalışan yetenek beyanı yapılmaz.
- [ ] Güncelleme ve emekliye ayırma sürümlü olmalı. Her yetenek için owner, rol, kapsam,
      sürüm/digest, çağıranlar, kanıtlı katkı, maliyet, aktif request/lease ve rollback kaydı
      bulunur. Retirement önce proposal ve bağımlılık/etki incelemesiyle başlar; canlı
      request'e bağlı veya gerekli kontrolü sağlayan sürüm silinmez. Yeni sürüme geçiş ve
      tüketici bağlantıları doğrulanınca eski sürüm registry'den emekliye ayrılır; gerekiyorsa
      kaynak dosyası normal PR'da silinir, karar/provenance geçmişi korunur. Az kullanım tek
      başına silme gerekçesi değildir; nadir fakat zorunlu güvenlik/operasyon rolü korunur.
- [ ] Mevcut curation/shadow/rollback girişlerini gerçek zamanlama ve idempotent queue
      tüketimine bağla; sonucu P11 raporunda proposed/approved/materialized/merged/active/
      retired olarak ayrı göster. Herhangi bir aşamanın hatası sonraki başarıyı üretmez;
      tekrar işleme aynı dosyayı, lifecycle olayını veya maliyet ödülünü çoğaltmaz.
- [ ] Self-change için mevcut deny/readonly sınırını genel worker'da kaldırma. Ayrı,
      politika tarafından izin verilen ve insan onaylı bootstrap'a sahip kernel geliştirme
      lane'i, P14 güncel harita ve P07/P08 bağımsız verifier üzerinden normal PR'ı üretir.
      Kendi command policy, credential/env/sandbox/merge authority veya approval şartını
      gevşeten değişiklik otomatik self-change olamaz. P13 workflow onarımı da kontrol düzlemi
      riskine uygun incelemeli geliştirme yoluna gider; observation yetkisi write yetkisi
      yaratmaz. Eksik lane varmış gibi self-change mission'ı tamamlandı sayılmaz.
- [ ] Yetenek değişikliği P14 korunan değerlendirme setinde mevcut sürümle karşılaştırılır:
      gerçek gereksinim tamlığı, doğru mimari etki/test seçimi, gerileme/tekrar oranı,
      süre ve toplam token maliyeti. Evaluator/holdout/promotion otoritesi adayın yazabileceği
      yüzeyden ayrıdır. Kalite artışı kanıtlanmayan, yalnız daha çok metin veya bulgu üreten
      sürüm aktif standarda yükselmez. Başarısız değişikliğin rollback'i ve önceki sürümün
      yeniden kullanılabilirliği gerçek izole kabul çalışmasıyla gösterilir.
- [ ] Üretime uygun ürün geliştirme için P14 gereksinim eşlemesini mevcut release
      sözleşmesiyle tamamla: gerekiyorsa migration/geri uyum, veri ve tenant bütünlüğü,
      hata/idempotency davranışı, gözlemlenebilirlik, kapasite, deployment/rollback kanıtı.
      Yalnız build veya unit test sonucu ürünün hazır olduğunu göstermez. Her zorunlu koşul
      mevcut yetkili kontrolün gerçek sonucu ya da açık blocker olarak görünür.

**Zorunlu regresyonlar:** Aynı isimli iki repo yeteneğinin kimlik/bellek izolasyonu;
desteklenmeyen repo özelliğinin unknown olması; Python/YAML/POC değişiminin öz-haritayı stale
yapması; bir request'in iki kez materialize olmaması; gerekli tüketicisi olmayan taslağın
active olamaması; canlı lease'li/zorunlu rolün retirement reddi; adayın kendi evaluator veya
merge yetkisini gevşetememesi; düşük kalite önerisinin promotion reddi ve sürüm rollback'i.

**Kabul:** Kaynak haritası ARIA'nın kendi request → executor → verification → publish → merge
ve learning yollarını kanıtla gösterir. En az bir gerçek capability ihtiyacı mevcut sahipler
üzerinden doğrulanmış agent/skill değişikliğine, PR/main/activation ve gerçek görev sonucuna
ulaşır. Gereksiz bir sürümün emekliye ayrılması, bağlı işler ve history korunarak gösterilir.
İzinli bir self-change gerekli bağımsız inceleme ve insan onaylarıyla aynı zinciri tamamlar;
yasak otorite değişikliği reddedilir. Bu kabul olmadan öz-gelişim tamamlandı denmez.

## 7. Kabul sayaçları, doküman ve aktivasyon — P10–P12

### P10 — Gerçek kanıtla aşamalı otonomi

- [ ] Kabul olayı V2; stable olay kimliği, kaynak cycle/PR/merge SHA, evidence ref/hash,
      producer attestation ve gerçek sonuç türünü zorunlu kılar. Sayaçlar doğrulanmış kayıtların
      reducer'ından üretilir; çağıranın yazdığı başarı metni sayılmaz.
- [ ] Mock/dry-run kayıtları ayrı kalır. Aynı çalışma yeniden yayınlandığında bir kez sayılır.
      Bozuk zincir, okunamayan kayıt veya kanıt kaybı sonucu bloke eder.
- [ ] Pasif scanner sonucu ayrı assessment olayıdır, `observe_success` değildir.
      Shadow merge kararları, kontrol sistemi bootstrap PR'ları ve koruma yapılandırma
      PR'ları otonomi başarı sayaçlarını artırmaz.
- [ ] Observe burn-in hâlâ tam 30 deneme ve en az 20 geçerli cycle ister. Bu raporun kabulü
      otomatik olarak 30 başarı değildir: bridge yalnız hash'i doğrulanan gerçek geçerli
      cycle'ları
      birer kez sayar. L1 için toplam 30 gerçek observe başarısı ayrıca tamamlanır.
- [ ] Mevcut 72 saat süreklilik kuralı hem geçmiş aralıklara hem son kanıtın yaşına uygulanır.
      Gerçek saat doğrulayıcıya açıkça verilir. Eski/iptal edilmiş epoch başarıları yeni kabul
      penceresine taşınmaz; yeni epoch ancak nedeni ve operatör onayı kayıtlı olarak açılır.
- [ ] P02, `EvidenceInvalidationV1` kaydında geçersiz artifact digest'lerini, nedenini,
      kaynak state SHA'sını, aktör attestation'ını ve zamanı taşır. Reducer append sırasıyla
      ilerler; bu digest'lere doğrudan veya kanıt grafiği üzerinden bağlı approval/closure/
      acceptance makbuzlarını geçersiz sayar ve sayaçları yeniden hesaplar. Eski satır silinmez.
      Yeni epoch eski iptal edilmiş makbuzları taşımaz; ilgili politika/otorite hash'i değişmişse
      o makbuzun eski başarıları yeni politika için geçerli sayılmaz.

Sayılabilir olayların kanonik koşulları:

| Olay                    | Başarıyı kanıtlayan kaynak                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `observe_success`       | Kabul edilmiş gerçek cycle/burn-in raporundaki tekil geçerli cycle; doğrulanmış rapor/artifact ve kod SHA'sı                                                        |
| `l1_autonomous_success` | L1 policy kararı, final-gate makbuzu, ARIA merger kimliği, main'de erişilebilir tekil merge SHA'sı ve başarılı merge-sonrası doğrulama                              |
| `l2_supervised_success` | L2 kararı; implementer'dan ayrı insan reviewer ve gözetimli normal merge kaydı; tekil merge SHA'sı ve savunma doğrulaması                                           |
| `l2_autonomous_success` | L2 adaylığını açan geçerli policy hash'i, ARIA merger kimliği ve L1 ile aynı final-gate/merge/son doğrulama zinciri                                                 |
| `l3_approval_success`   | Aynı PR head ve policy hash'ine bağlı, süresi geçmemiş iki ayrı risk_owner/exception_owner onayı ve başarılı bağımsız doğrulama; henüz L3 merge yetkisi gerektirmez |
| `rollback_success`      | Tekil rollback denemesi, önceki/geri dönülen SHA veya state hash'i, gerçek restore/revert makbuzu ve sonrasında başarılı bütünlük/sağlık doğrulaması                |

Her olay epoch, policy hash ve doğrulanmış workflow/aktör kökeni taşır. Kararlı cycle/merge/
approval-pair/rollback kimliği ikinci kez sayılmaz; salt kayıt yazımı başarı kanıtı değildir.

| Aşama | Korunacak eşik ve aktivasyon kararı                                                                                                                                                                                                          |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1    | 30 gerçek observe başarısı, sıfır kritik ihlal, bütün merge kapıları ve izinli scheduler ceiling; gerekli review'lardan sonra merge'i ARIA yapar                                                                                             |
| L2    | L1 koşulları + 30 gerçek L1 ARIA merge'i + 30 gözetimli L2 başarı; bağımsız review edilmiş policy PR'ı L2 adaylığını açınca P06 kapsamındaki uygun runtime PR'larını ARIA merge eder                                                         |
| L3    | Öncekiler + 10 gerçek L2 ARIA merge'i + 5 iki-aşamalı L3 approval başarısı + 3 rollback başarısı; aday policy açıldıktan ve her PR güncel head'inde iki ayrı risk_owner/exception_owner onayı alındıktan sonra merge işlemini ARIA yapabilir |

- [ ] Mevcut `auto_merge_candidate_lanes: [L1]` başlangıçta korunur. L2/L3 adaylığının
      açılması runtime'ın kendi policy dosyasını değiştirmesiyle olmaz; ilgili aşama kanıtlarına
      bağlı, normal incelemeli policy PR'larıyla yapılır. Yasak yol listesi korunur.
- [ ] L2 supervised ve L3 approval/rollback kabulü ARIA'nın henüz sahip olmadığı merge
      yetkisini gerektirmez: normal yetkili PR/izole rollback töreninden gelen gerçek sonuçları
      bağımsız verifier kaydeder. Böylece sayaçlar ile yetki arasında bootstrap döngüsü kurulmaz.
- [ ] Gerekli uygun iş sayısı oluşmadıysa aşama bekler. Sayaç doldurmak için anlamsız PR,
      sentetik başarı veya mevcut eşikleri düşüren policy üretilmez.

### P11 — Gerçeği gösteren durum yüzeyi

- [ ] CURRENT_STATE, CLI status ve günlük rapor aynı otorite/kayıt okuyucularından türetilir.
      Code SHA, state SHA, son doğrulanmış publish, coverage, bekleyen işler, invalidated
      kanıtlar,
      risk aşaması ve merge'i engelleyen somut neden görünür.
- [ ] Firejail anlatımı bwrap uygulamasıyla hizalanır. Eski Codex/Claude ve Plan 033 faz
      anlatımları koddan ayrılır; `coded` veya eski test sayısı canlı kabul diye gösterilmez.
- [ ] Boş ağ envanteri ve ZAP pin'i doctor'da açık gereksinim olarak görünür; aktif kampanya
      kapıları kapalı kalır. ARIA-034 için otonom saldırı/mutation uygulaması bu planda teslim
      edilmiş sayılmaz.
      Mevcut `ARIA-033-D1` (aria-core, 2026-10-03) ve `ARIA-033-D2` (aria-core, 2026-10-19)
      kayıtları korunur; bu plan onları kapatmaz.
- [ ] Yetki stamp/hash değişiklikleri mevcut üreticiden oluşturulur. Bir planın yazılmış olması
      readiness veya çözülmüş finding üretmez.

### P12 — Main'e alma ve gerçekten çalıştığını kanıtlama

Uygulama sırası: **P01 → P02 → P03 → P04 → P14 kanıt/graf temeli → P05/P06/P13 → P07/P08 → P09 →
P14 outcome/kabul ve P15 yetenek/öz-gelişim kabulü → P10 → P11/P12**.
P04 ile bağımsız P07 altyapısı paralel geliştirilebilir; aynı dosyanın tek sahibi olur.
Birbirinin sözleşmesini değiştiren producer/reader/schema/test aynı PR'da iner.

- [ ] Her PR temiz güncel main'e dayanır, independent review alır ve required-check'leri
      güncel head'de geçer. Her commit aktif feature branch'e push edilir; bypass/force push
      yoktur.
- [ ] Planın kendisi de ayrı dokümantasyon commit'i, push ve `main` hedefli PR ile yayınlanır.
      Bu PR runtime finding'lerini kapatan `Closes:` iddiası taşımaz; aşağıdaki uygulama
      PR'larının yerini tutmaz. Plan PR'ının gerçek merge SHA'sı teslimat kaydına eklenir.
- [ ] Her uygulama dilimi için finding → commit → push → PR → güncel head kontrolleri ve
      bağımsız review → GitHub `main` merge SHA'sı → merge sonrası doğrulama zinciri tutulur.
      Yerel commit, açık PR veya auto-merge isteği tek başına main'e teslim sayılmaz.
      Dış ayar/state değişiklikleri de ilgili PR'daki incelenmiş değişiklik ve uygulama makbuzuyla
      bağlanır.
- [ ] İlk kontrol sistemi PR'ları normal yetkili merge yolundan iner; her merge sonrasında
      değişen capability hash'lerine ait kanıtlar yeniden üretilir.
- [ ] P02 kurtarması önce isolated state kopyasında doğrulanır; ardından trusted maintenance
      yolundan gerçek state'e uygulanır. Sonraki producer ve executor aynı state'i
      okuyabilmelidir.
- [ ] Pasif assessment, PR kanıtı ve salt karar veren shadow merge ilk canlı dilimdir.
      Shadow kararları gerçek merge başarısı sayılmaz. Hatalı kanıt içeren PR'ın bloklandığı
      görülür.
- [ ] P10 eşikleri oluşunca uygun gerçek L1 PR'ı ARIA merge eder. Sonra aynı prosedürle
      ilk gerçek L2 uygulama düzeltmesi doğrulanır; plan yalnız L1 demosuyla tamamlandı sayılmaz.
- [ ] Her gerçek merge öncesi rollback bundle vardır. Sonraki doğrulamada hata/ihlalde
      yeni merge'ler durur, incident açılır; review edilmiş revert/rollback süreci çalışır.
      State geçmişi silinmez, müşteri sistemlerine otomatik müdahale edilmez.

**Operasyonel kabul:** Son yetkili main sürümünde üç ardışık producer/executor çalışması ve
en az bir gerçek zamanlanmış tetikleme doğrulanır; snapshot/index uyumsuzluğu veya
sınıflandırılmamış
çıkış yoktur. Watchdog eski incident'i kanıtla kapatır. Sonuç raporu her kapı için
run/job/PR/commit
ve artifact referansını içerir. Gün sayısı değil, mevcut politikadaki gerçek kanıt eşikleri
belirleyicidir.

## 8. Test matrisi ve tamamlanma denetimi

| Grup            | Olumlu ve olumsuz kabul senaryoları                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State           | Restore/publish eşitliği; 158 kayıp kaydın açık uzlaştırılması; canlı artifact retention; CAS yarışı; interrupted compaction; tanımsız dosyada publish reddi  |
| Çalışma         | Süreç kaybı, lease devri, double claim, deadline, OOM sınıflandırması, serializer ve kuyruk/finding uzlaşması                                                 |
| Güvenlik kanıtı | Tam SHA/profile/pack bağları; eksik/güncel olmayan kontrol; sahte başarı/kimlik; bilinmeyen yol; canonical finding snapshot yokluğu                           |
| PR izolasyonu   | PR içeriğinin veri olarak okunması; PR job'unda state/merge yetkisi olmaması; baseline kanıtının PR kanıtı yerine geçememesi                                  |
| Merge           | Yedi mevcut kapı ve güvenlik kapısının her biri için ret; son anda değişen head; bağımsız review eksikliği; GitHub cevabı kaybolduğunda idempotent uzlaştırma |
| Sayaç/policy    | Aynı kanıtın iki kez sayılmaması; mock ayrımı; 30/20 burn-in ile 30 unlock farkı; 72 saat aralığı; gerçek L1/L2/L3 kabul geçişleri                            |
| Kapanış         | Statik bulgu → düzeltme → aynı kaynak sürümünde savunma testi → PR → ARIA merge → merge SHA'sında doğrulama → kapanış/incident                                |

Her kod işi için önce ilgili sözleşme testi yazılır, başarısızlık gözlenir, kök neden çözülür ve
ilgili komşu testler çalıştırılır. Mevcut state/store/compaction, executor, V13 security,
pre-merge, readiness ve workflow invariant testleri genişletilir; ikinci test koleksiyonu
kurulmaz.

Gerekli yerel doğrulama:

```bash
npm run aria:compile
npm run aria:test:unit
npm run aria:docs:ssot
npm run invariants:fast
npx nx affected --target=test
npx nx affected --target=lint
```

Yetki/snapshot/pre-merge değişikliklerinde ilgili tam invariant grubu da çalışır. PR'da
mevcut protected-main CI sonuçları ayrıca doğrulanır. Cache/test başarısı canlı çalışma kanıtı
değildir.
Bu planı yazarken önceki checkout'ta geçen 26 seçili test, yeni main veya bu teslimatın kabulü
değildir.

Tamamlanma denetimi tüm P01–P15 maddelerini kod, gerçek CI ve kalıcı kanıtla tek tek eşler.
Çözülemeyen dış yetki veya henüz oluşmamış kabul eşiği varsa teslimat `blocked` gerekçesiyle açık
kalır; yalnız doküman, yeşil unit test, manuel başarılı run veya açık bir feature flag ile
tamamlandı denmez.
