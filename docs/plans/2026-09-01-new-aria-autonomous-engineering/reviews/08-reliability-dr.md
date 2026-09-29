# D0 adversarial review — reliability, DR, and operations

## Verdict

`CHANGES_REQUIRED`

D0 documentation-only kalıyor, `VERIFYING` durumunu koruyor ve legacy ARIA yüzeylerinde diff
yok. Tasarım ayrıca stale worker fencing, `UNKNOWN` effect, ayrı executor VM, fail-closed restore
admission, human release ve canary gate'leri için doğru temel primitive'leri kuruyor. Bununla
birlikte sekiz load-bearing P1 boşluğu vardır: PITR sonrasında kaybolan external effect'lerin nasıl
bulunacağı tanımlı değildir; Postgres/object store için ortak recovery cut yoktur; backup ve
regional failover failure domain'leri eksiktir; kill path kendi arızalı control plane'ine bağlıdır;
ve production droplet deployment/PR activation kapasite, paging ve outage drill'lerinden önce
gelir. Bu haliyle bütün yazılı phase gate'leri geçip duplicate external effect, split brain veya
sessiz production outage üretmek mümkündür.

## Findings

### REL-P1-001 — PITR, recovery point'ten sonra gerçekleşmiş external effect'leri keşfedemez

- **Evidence:** Postgres current state; `Effect`, permit ve `ReconciliationCursor` dahil durable
  truth'ün authority'sidir
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:127-137`). Effect
  intent DB transaction'ında yazılıp daha sonra external dispatcher tarafından gönderilir
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:157-164`). S45,
  PITR restore sırasında yine restore edilmiş DB'deki `replay cursor` ve effect readback'e dayanır
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P06.md:53-63`). Restore target'ından
  daha yeni effect/permit/cursor satırlarını kapsayan bağımsız dispatch horizon'u veya external
  effect inventory sözleşmesi hiçbir kartta yoktur.
- **Severity:** P1 reliability / duplicate side effect.
- **Consequence:** Bir transaction commit edildikten ve GitHub/provider effect'i gerçekleştikten,
  fakat ilgili WAL off-host recovery point'e ulaşmadan önce region kaybolursa restore edilmiş DB
  effect'in, consumed permit'in ve reconciliation cursor'un varlığını bilmez. Restored state ve
  object digest'leri kendi recovery point'i için exact görünürken aynı PR/merge/provider call yeniden
  dispatch edilebilir veya surviving external effect hiç outcome ledger'a alınmayabilir.
- **Smallest corrective action:** External dispatch için ayrı bir DR safety rule tanımlayın: effect
  intent/UUID/base-head/payload ve permit consumption, ya dispatch'ten önce RPO=0 olacak şekilde
  bağımsız off-host durable horizon'a ulaşmalı ya da restore manifestine bağlı immutable bir effect
  dispatch journal'ına yazılmalıdır. Restore admission, `(recovery point, outage fence]` aralığındaki
  bütün potential effects için GitHub/provider enumeration/readback yapmalı; complete expected set
  kanıtlanamıyorsa sistem frozen/manual-recovery kalmalıdır. Bunu S17, S31, S45, S52 ve S61 exit
  predicate'lerine bağlayın.
- **Checks:** Intent commit'inden sonra WAL archive'ı durdurup GitHub side effect'ini başarıyla
  tamamlayın, region'ı kaybedip daha eski PITR'a dönün. Oracle aynı durable UUID'nin ikinci kez
  dispatch edilmediğini, external effect'in recovered ledger'a alındığını ve discovery incomplete
  iken write/resume'ın reddedildiğini kanıtlamalıdır. Aynı testi lost permit consumption, `202`,
  `409`, timeout ve provider call için çalıştırın.

### REL-P1-002 — Postgres PITR ile versioned object store arasında normatif ortak recovery cut yok

- **Evidence:** Artifact önce quarantine/object store'a upload edilir, DB admission transaction'ı
  sonra CAS referansını görünür kılar; backup'ın PITR ile object version/digest manifestini
  “birlikte bağladığı” söylenir, fakat bağın alanları ve ordering semantiği verilmez
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:157-164`). S61 yalnız
  generic backup manifest, object digest reconciliation ve missing version/partial restore
  negatiflerini ister
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P08.md:53-63`). PostgreSQL system ID,
  timeline, LSN/recovery timestamp ile object generation/version inventory arasında ortak watermark,
  version-retention floor veya deletion/GC fence yoktur.
- **Severity:** P1 data durability / restore correctness.
- **Consequence:** Concurrent upload/admission, retention delete, legal-hold release veya orphan GC
  sırasında alınan iki bağımsız snapshot farklı zamanları temsil edebilir. Restore edilmiş DB
  silinmiş bir object version'a referans verebilir; daha yeni manifest ise PITR anında admitted
  olmayan bytes'ı kabul edilmiş gösterebilir. “Digest reconciliation” beklenen version set'i yanlış
  recovery cut'tan türetilirse bu hata tespit edilmeden gate geçebilir.
- **Smallest corrective action:** Restore manifest şemasını normatif yapın: source system ID,
  timeline, exact LSN/recovery timestamp, DB snapshot/backup ID, object-store immutable version IDs,
  bucket generation/inventory digest ve retention floor aynı signed recovery epoch'a bağlansın.
  Object version/GC/delete işlemleri PITR window'u ve legal hold'u aşmadan physical deletion yapamasın;
  restore expected-object set'ini restored DB'den türetip exact version inventory ile iki yönlü
  karşılaştırsın. S03/S45/S61'e boundary race testleri ekleyin.
- **Checks:** Recovery cut'ın iki yanında upload→admission, admission→outbox, delete/tombstone→purge,
  orphan GC ve multipart completion kill-point'leri üretin. Her fixture ya exact DB+object state'i
  restore etmeli ya da write admission'ı fail-closed reddetmelidir; extra/missing/wrong-version ve
  manifest-from-another-timeline durumları ayrı reddedilmelidir.

### REL-P1-003 — “Encrypted off-host” backup aynı hesap/region/control-plane failure domain'ini dışlamıyor

- **Evidence:** Design yalnız `versioned object store, encrypted off-host backup` der
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:249-258`). S61 key/config
  restore ve clean-region rebuild ister, fakat backup'ın ayrı provider/account/admin principal,
  immutable retention/object lock, deletion quorum veya independently escrowed decrypt key sahibi
  olmasını istemez
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P08.md:53-63`). “Off-host” aynı
  DigitalOcean account/region ve aynı compromised credential içinde kalabilir.
- **Severity:** P1 disaster recovery / correlated-loss exposure.
- **Consequence:** Region/account outage, ransomware veya broad operator credential compromise;
  primary DB/object state'i, version history'yi ve backup'ı birlikte silebilir ya da decrypt key'i
  erişilemez yapabilir. Clean-region automation mevcut backup endpoint'ine erişebildiği happy path'i
  kanıtlarken gerçek failure domain kaybında restore imkânsız kalır.
- **Smallest corrective action:** OP-04/S61'e ayrı administrative ve regional failure domain şartı
  ekleyin: primary delete principal'ından ayrılmış cross-account/cross-region immutable copy,
  retention lock, backup deletion için independent authority, ayrı read-only restore identity ve
  independently escrowed/rotatable encryption key. Kabul edilen topology ve replication lag/RPO
  manifestte yer alsın; tek provider kabul edilecekse bunun residual risk/no-go sınırı açık olsun.
- **Checks:** Primary account credentials compromised, primary region tamamen unavailable, backup
  writer revoked, malicious delete, key rotation/loss ve object-lock bypass denemeleriyle clean-room
  restore çalıştırın. Aynı principal'ın primary ve son recoverable copy'yi silebildiği topology gate'i
  geçememelidir.

### REL-P1-004 — Regional rebuild eski region'ı fence etmediği için split brain üretebilir

- **Evidence:** Scheduler/job safety yalnız lease heartbeat ve fencing token'a dayanır
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:145-155`); merge
  serialization da Postgres-local per-base lock'tır
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P07.md:29-39`). S61 clean region'da
  state/object digest restore edip reconciliation bitene kadar effect'i kapatır, fakat eski region'ın
  scheduler, ingress, GitHub App token ve provider egress'ini kapattığını kanıtlayan global epoch veya
  failover fence istemez
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P08.md:53-63`). Diff'teki authority
  belgelerinde `split-brain`, active/passive leader veya recovery epoch sözleşmesi yoktur.
- **Severity:** P1 distributed reliability / duplicate authority.
- **Consequence:** Network partition sonrası eski region yaşamaya devam eder veya geri dönerse iki
  bağımsız Postgres cluster aynı lease/lock değerlerini geçerli sayabilir. Her cluster kendi içinde
  “tek valid authority” oracle'ını geçerken ikisi de provider/GitHub effect'i dispatch eder; per-base
  DB lock failure domain'ler arasında serialization sağlamaz.
- **Smallest corrective action:** Tek-active topology ve operator-owned failover protocolü ekleyin.
  Yeni region write/effect admission'ı ancak monotonik external recovery epoch alındıktan, eski epoch
  ingress/egress ve credentials provider tarafında revoke edilip readback ile doğrulandıktan ve DNS/
  routing cutover kanıtlandıktan sonra açılmalıdır. Her lease, effect, permit ve broker request epoch'a
  bağlı olmalı; stale region çağrıları adapter ve provider boundary'de reddedilmelidir.
- **Checks:** Eski region'a partition uygulayıp yeni region'ı restore/activate edin, sonra eski
  region'ı geri getirin. Aynı base/job/effect üzerinde iki scheduler ve merge-authority yarışsın;
  yalnız yeni epoch effect üretmeli. Revoke/readback, DNS propagation ve fencing authority
  unavailable iken failover/resume reddedilmelidir.

### REL-P1-005 — Freeze/kill, durdurması gereken DB/control-plane outage'ından bağımsız değil

- **Evidence:** `freezeAriaAutonomy` durable reason/actor/policy yazar; DB/object corruption ve
  evidence-verifier loss otomatik freeze sebebidir
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:241-247`). S39
  correlated telemetry ve freeze/kill kurar, fakat out-of-band enforcement point, DB-unavailable
  path, credential/provider-side revoke veya network-deny teslimatı belirtmez
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P05.md:77-87`). Control plane'in
  production droplet'ta çalışmasına izin verilir
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:249-253`).
- **Severity:** P1 incident containment / fail-safe control.
- **Consequence:** DB corruption/outage, droplet loss veya control API failure aynı anda hem incident
  sebebi hem de durable freeze command'inin yazılmasını/dağıtılmasını engeller. Önceden mint edilmiş
  GitHub token, broker job veya partitioned worker çalışmaya devam edebilir; UI'daki kill mutation'ın
  başarısız olması “fail-closed kill” değildir.
- **Smallest corrective action:** Operator-owned kill'i ARIA DB/control plane'inden bağımsız bir
  enforcement path yapın: GitHub App installation suspension/token revoke, broker/provider egress
  deny, worker firewall/identity revoke ve merge-adapter deny policy tek ceremony'de uygulanıp
  provider readback ile doğrulansın. Runtime her privileged effect öncesi kısa ömürlü external
  allow epoch'i kontrol etsin; kill authority erişilemezse yeni effect yok. Incident record daha
  sonra DB'ye reconcile edilebilir, kill bunun yazılmasına bağlı olmamalıdır.
- **Checks:** DB hard-down/corrupt, control droplet unreachable, scheduler partitioned ve already-
  minted token/job senaryolarında out-of-band kill çalıştırın. Provider/GitHub/worker effect count'i
  kill'den sonra sıfır kalmalı; partial kill veya readback yokluğu resume'ı engellemelidir.

### REL-P1-006 — Shadow deployment, mevcut droplet için capacity admission'dan önce planlanmış

- **Evidence:** Mevcut production manifest 4 CPU/8 GB droplet ve yaklaşık 7 GB mevcut memory budget
  kaydeder (`docker-compose.droplet.yml:1-4`); mevcut Postgres budget'ı da 212/300 connection ile
  threshold'un üzerindedir (`docs/runbooks/database-capacity.md:23-34`). Yeni design control plane'in
  bu droplet'ta çalışmasına izin verir, fakat sekiz rolün executor dışındaki placement'ını ve role
  başına CPU/RAM/disk/DB-pool budget'ını tanımlamaz
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:77-93`, `:249-253`).
  S41 runtime'ı deploy eder; quota/headroom işi ancak S44'te, measured OP-07 gate'i ise S47'de gelir
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P06.md:5-15`, `:41-51`, `:77-87`).
- **Severity:** P1 production availability / phase-order defect.
- **Consequence:** Shadow'ın repository write yetkisi olmaması host safety sağlamaz. Control,
  scheduler, brokers, publisher, attestor, merge role, new Postgres/object traffic ve telemetry;
  S44 admission oluşmadan RAM/disk/CPU veya DB connections tüketip mevcut platformu OOM, I/O stall
  veya cascading connection rejection'a götürebilir. S44 sonradan ölçüldüğünde production etkisi
  zaten gerçekleşmiş olur.
- **Smallest corrective action:** S44'ün pre-deployment capacity-admission subset'ini S41'den önceye
  taşıyın ve S41'i OP-07'ye bağlayın. Runtime topology; her rolün host/VM placement'ını, hard CPU/RAM/
  disk/PID/network/DB-pool limitini, peak+failure headroom'unu ve monitoring overhead'ini açıkça
  bütçelesin. Mevcut droplet bu budget'ı sağlamıyorsa control plane de ayrı VM/failure domain'e
  taşınmalı; “resource limited olabilir” acceptance değildir.
- **Checks:** Gerçek compose/config render'ından toplam hard limit ve DB pool budget invariant'ı
  üretin; mevcut platform peak/burn-in, restart storm, log/object growth ve monitoring scrape yüküyle
  load test edin. Headroom altına inen veya 70% DB threshold'unu aşan manifest deploy admission'da
  reddedilmeli ve running product SLO'ları etkilenmemelidir.

### REL-P1-007 — Paging ownership ve SLO/error-budget stop policy PR_ONLY aktivasyonundan sonra geliyor

- **Evidence:** Design metric subject'lerini listeler, ancak objective, threshold, evaluation window,
  page owner, acknowledgement/escalation veya error-budget action tanımlamaz
  (`docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md:230-234`). S39
  telemetry/retention/freeze teslim eder ama page routing/ack sahibi yoktur
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P05.md:77-87`). Buna karşın S43
  production PR write'ını aktive eder; operator-approved SLO ölçümü S47'ye, stop/page/on-call
  authority ise S54/OP-06'ya bırakılır
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P06.md:29-39`, `:77-87`;
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/PLAN.md:69-78`). Mevcut droplet manifesti
  Alertmanager receiver'larının operator kararı/secrets olmadan gerçekten bildirim yapmadığını da
  açıkça kaydeder (`docker-compose.droplet.yml:1972-1985`).
- **Severity:** P1 operability / incident detection and ownership.
- **Consequence:** PR_ONLY external writes; queue/reconcile lag, lost lease, backup staleness veya
  resource exhaustion sırasında dashboard metric'i üretip kimseyi page etmeyebilir. Sahibi ve
  threshold'u olmayan SLO “current” sayılabilir; error budget tükenirken otomatik freeze/rollback
  koşulu yoktur. S47 burn-in sonunda sorun bulunması, S43-S46 arasındaki gözetimsiz etkiyi geri almaz.
- **Smallest corrective action:** S41 ve özellikle S43 öncesinde ayrı operational-readiness
  prerequisite ekleyin: availability/durability SLIs, numeric objectives/windows, queue/reconcile/
  backup/evidence freshness thresholds, error-budget burn alerts, automatic freeze/stop rules,
  named 24x7 owner/escalation/ack SLA ve bağımsız receiver health. S39 finding/acceptance'ı page
  delivery reconciliation'ı açıkça kapsasın; OP-06 yalnız release değil pre-production incident
  ownership da sağlasın.
- **Checks:** Receiver secret missing, route disabled, Alertmanager down, monitor aynı droplet ile
  birlikte lost, all-critical burst ve page unacknowledged fixture'larında gate fail etmeli. Queue
  age, reconcile lag, WAL/object backup staleness ve restore verification breach'leri canlı page,
  durable incident ve bounded-time freeze üretmelidir.

### REL-P1-008 — Full outage/authority-compromise drill'leri low/medium autonomy'den sonra yapılıyor

- **Evidence:** P07 S55 supervised low-risk autonomous merges yapar ve S56 bu bound'u seal eder
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P07.md:77-99`). P08 S63 medium-risk
  merge/deploy burn-in'i tamamlar ve S64 medium bound'u kabul eder
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P08.md:77-99`). Buna karşılık
  publisher/attestor/merge/executor compromise drill'i S67'de; combined region/worker/both-provider
  loss, credential revoke/rotate ve early-resume drill'i S68'de yapılır—ikisinin de dependency'si
  zaten tamamlanmış S64'tür
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P09.md:29-51`). Önceki kartlar bazı
  component-level provider/worker/restore testleri içerir, fakat bu production-faithful combined
  authority/outage kapsamını gate etmez.
- **Severity:** P1 rollout safety / phase-order defect.
- **Consequence:** Sistem low-risk, ardından medium-risk autonomous merge yaparken tek runtime
  authority compromise'ının sınırı, iki provider'ın birlikte kaybı, region+worker loss, credential
  revoke propagation ve early resume production topology'de hiç kanıtlanmamış olabilir. S68'in
  fail-closed sonucu ancak riskli effects gerçekleştikten sonra elde edilir.
- **Smallest corrective action:** S67/S68'i silmeden mandatory subset'lerini öne çekin: credential/
  single-role compromise ve both-provider/worker outage S48'den; regional failover/split-brain ve
  merge-authority revoke S56'dan; medium quorum/authority compromise ise S64'ten önce current
  `live_proven` gate olsun. P09 bunları daha geniş pressure altında tazeleyebilir. Her promotion
  dossier'ı exact deployed topology/credential/policy version ve drill freshness'ine bağlansın.
- **Checks:** P06/P07/P08 gate verifier'ında ilgili drill evidence'ını tek tek çıkarın veya eski
  deployment/credential/policy digest'iyle değiştirin; promotion reddedilmelidir. Both providers
  down, worker lost mid-job, publisher/merge token revoked mid-effect, attestor compromised,
  region partition ve early resume testleri outstanding effect set'i sıfırlanmadan geçmemelidir.

### REL-P2-009 — Evidence freshness alanı var, fakat yaş ve invalidation semantiği yok

- **Evidence:** Plan her proof record'da `freshness` ister
  (`docs/plans/2026-09-01-new-aria-autonomous-engineering/PLAN.md:44-47`) ve phase gates “current” veya
  “stale” ayrımı yapar (`docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P06.md:89-99`;
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/phases/P07.md:89-99`). Ancak proof type,
  deployment topology veya authority version bazında max age, trusted clock ve invalidation event'i
  tanımlı değildir.
- **Severity:** P2 evidence reliability / stale operational proof.
- **Consequence:** Restore, capacity veya outage evidence'ı takvim yaşı dolmamış olsa bile image,
  deployment topology, credential, provider limit, policy veya region değişikliğiyle anında geçersiz
  olabilir. “Current” boolean/string olarak uygulanırsa eski environment'ın başarılı drill'i yeni
  environment'ı promote edebilir.
- **Smallest corrective action:** S01 evidence schema ve operator-owned policy içinde proof türüne
  göre max age, trusted UTC source/clock-skew sınırı ve event-driven invalidation tanımlayın.
  `deployment/config/image/policy/credential/topology/provider-limit` digest değişiklikleri ilgili
  live proof'ları invalidate etmeli; S48/S56/S64 admission bunu fail-closed uygulamalıdır.
- **Checks:** Max-age boundary/clock skew testlerinin yanında her bağlı digest'i tek tek mutate edin;
  eski evidence promotion'ı karşılamamalıdır. Unrelated metadata değişikliği gereksiz invalidation
  üretmemeli, fakat changed provider quota/credential/backup topology fresh rerun istemelidir.

## Verified controls and checks

- Root `CLAUDE.md`, adversarial brief, complete task contract/implementer report, supplied 2,203-line
  diff package ve bütün changed authority/progress/evidence/phase artifacts okundu. Reliability ile
  ilgili mevcut production compose, database-capacity ve monitoring topology satırları ayrıca
  kontrol edildi.
- Recorded base/head exact `eeb401131260fe45f3f60be55fa25d023a082d18..c6065d6dac97306f147de67ef58a96e3a67524ac`.
  `git diff --check` geçti; protected legacy ARIA/workflow diff'i boştur.
- Programmatic roster/state check exact 72 sprint, 4 D0 event, tail `VERIFYING`,
  `admission.accepted=false` ve reviewer `pending` sonucunu verdi. D0 live/merge/legacy-replacement
  yetkisi iddia etmiyor.
- Targeted contract search; split-brain/recovery epoch, object-lock/cross-account backup ve
  error-budget sözleşmelerinin authority belgelerinde bulunmadığını doğruladı. Absence tek başına
  finding değildir; yukarıdaki reachable phase exits ve failure consequences ile birlikte
  değerlendirilmiştir.
- Pozitif reliability primitive'leri doğrulandı: stale worker fencing ve `UNKNOWN` effect
  (`design.md:145-155`), at-least-once outbox + durable inbox ve missing-object fail-close
  (`design.md:157-164`), separate executor VM (`design.md:90-93`), explicit freeze/resume
  reconciliation (`design.md:241-247`), rollback/page negative controls
  (`phases/P07.md:65-75`) ve P06/P07/P08 restore/capacity gates. Findings bu kontrolleri yok saymaz;
  onları phase/failure-domain sınırlarında tamamlar.
