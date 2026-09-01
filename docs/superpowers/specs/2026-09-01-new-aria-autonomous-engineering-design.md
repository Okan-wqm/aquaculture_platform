# Yeni ARIA Otonom Mühendislik Tasarımı

- **Program ID:** `new-aria-autonomous-engineering`
- **Tarih:** 2026-09-01
- **Durum:** D0 tasarım kaydı; bağımsız inceleme ve merge bekliyor
- **Taban:** `origin/main@eeb401131260fe45f3f60be55fa25d023a082d18`
- **Uygulama planı:**
  [`../../plans/2026-09-01-new-aria-autonomous-engineering/PLAN.md`](../../plans/2026-09-01-new-aria-autonomous-engineering/PLAN.md)
- **Audit girdisi:** `85787e610` commit'indeki 88 bulgu; iddiaların kaynak tabanı `d0afe46bd`

## Bağlam ve karar

Mevcut ARIA aktif kullanımdadır; repository biçimli Python/GitHub Actions çalışma zamanı, durumu ve
operator süreçleri değişmeden kalır. Yeni ARIA, `apps/aria-service` ve `web/modules/aria` altında
bağımsız ürün sınırı olarak kurulacaktır. Yeni sistemin kendi Postgres ve object-store gerçeği,
kimlikleri, policy kökleri ve yaşam döngüsü vardır. Legacy çıktılar yalnız immutable audit ve
karşılaştırma girdisidir; runtime veya veri bağımlılığı değildir.

D0 yalnız tasarım ve programı kaydeder. Ürün kodu D0 PR'ı incelenip merge edilmeden başlayamaz.
Bu belge yeni ARIA'nın canlı, merge yetkili veya mevcut sistemin yerine geçmiş olduğunu iddia etmez.

## Hedefler ve hedef olmayanlar

Hedefler:

- Salt-okunur keşiften kanıtlı düşük/orta risk merge'e kadar kademeli, fail-closed otonomi.
- Her komut, deneme, effect, approval, artifact ve karar için kalıcı ve yeniden uzlaştırılabilir gerçek.
- Producer, reviewer, attestor, publisher ve merge authority arasında bağımsız kimlik ve yetki.
- Exact SHA, deterministic oracle, negatif kontrol ve güncel canlı kanıtla kapanan bulgular.
- Tek kaynak kökü ve küçük, cohesive modüller: hedef `<=250` fiziksel satır; `>400` hard review gate.
- Repository/provider taşınabilirliği; ürün GraphQL ve federated web deneyimi.

Hedef olmayanlar:

- Legacy ARIA kodu, state'i, workflow'u veya authority modelini değiştirmek ya da import etmek.
- D0 sırasında uygulama kodu, deployment veya otonomi aktivasyonu üretmek.
- İnsan release/deploy kapısını kaldırmak.
- High-risk kategorileri bu programda aktive etmek.
- Kafka, API-key provider fallback veya NATS token/user-password kimliği kullanmak.

## Hard legacy isolation boundary

`aria-kernel/**`, `tools/aria-poc/**`, `docs/aria/**`, `.claude/agents/aria-*`, legacy workflow'lar
ve legacy state immutable reference alanıdır. Yeni servis bu path'lere yazmaz, bunlardan kod import
etmez ve sağlıklı çalışmak için bunları okumaz. S42 karşılaştırması frozen artifact/SHA üzerinden
tek yönlü, salt-okunur bir adapter ile yapılır; failure yeni sistemin durable truth'ünü değiştirmez.
Çift yazım, shared ledger, shared credential ve shared authority yasaktır. Legacy kaldırma yalnız
ayrı onaylı program, kanıtlı coexistence ve operator kararıyla ele alınabilir.

## Tehdit modeli ve trust zone'lar

Korunan varlıklar policy/TCB, repository içeriği, credentials, approval/permit, Postgres gerçeği,
artifact'lar, merge/release etkileri ve kişisel veridir. Saldırgan girdileri repository metni,
prompt injection, kötü URL/DNS/redirect, sahte attestasyon, replay, forged payload, bozuk artifact,
stale SHA, yarış, process/VM kaybı ve ele geçirilmiş tek runtime rolünü kapsar.

```text
Zone U: operator/browser + untrusted repository/prompt
       | authenticated GraphQL; typed mutation; step-up
Zone C: control + scheduler -------------------- Postgres authority
       | durable job/effect/outbox                   |
Zone P: broker-codex / broker-claude          object store (CAS)
       | normalized capability, no API fallback     |
Zone W: separate worker VM -> executor -> isolated worktree
       | artifact only; no merge credential
Zone G: publisher -> PR/checks    policy-attestor -> dossier
       |                                  |
       +---------------- merge-authority --+ -> GitHub merge effect
                                                   |
                                            human release/deploy
```

Zone geçişlerinde immutable subject, workspace, operation, target SHA, payload digest, policy
version ve correlation kimliği doğrulanır. Model çeşitliliği trust boundary değildir. Tek rol kendi
artifact'ını onaylayamaz; deterministic oracle ve bağımsız authority identity gerekir.

## Runtime image ve authority matrisi

| Image/rol         | Kimlik ve UID               | Secret                             | Egress / capability                | Açıkça yasak                               |
| ----------------- | --------------------------- | ---------------------------------- | ---------------------------------- | ------------------------------------------ |
| `control`         | ayrı mTLS CN, non-root UID  | DB scoped credential               | GraphQL, command/state             | provider, git write, policy yazımı         |
| `scheduler`       | ayrı mTLS CN, non-root UID  | lease DB credential                | due-job claim                      | GraphQL admin, git/provider                |
| `broker-codex`    | provider-bound identity     | Codex CLI subscription             | Codex endpoint, normalized broker  | DB authority, git, merge                   |
| `broker-claude`   | provider-bound identity     | Claude Code CLI subscription       | Claude endpoint, normalized broker | DB authority, git, merge                   |
| `executor`        | worker mTLS CN, ayrı VM UID | single-job capability              | sandbox/worktree, broker           | production droplet, provider secret, merge |
| `publisher`       | GitHub App identity         | short-lived installation token     | branch/PR/check write              | merge/bypass, policy/TCB write             |
| `policy-attestor` | pinned attestor identity    | signing key handle                 | policy read, attestation write     | artifact üretimi, publish/merge            |
| `merge-authority` | Merge App identity          | short-lived token + permit consume | guarded merge endpoint             | bypass, release/deploy, policy write       |

Her image ayrı filesystem, UID, secret mount, NetworkPolicy ve Linux capability set'i alır.
`executor` ayrı worker VM'dedir; production droplet ile CPU, bellek, disk veya failure domain
paylaşmaz. NATS kullanılırsa kimlik yalnız sertifika CN'dir; CONNECT user/password/token yoktur.
NATS servis içi durable command/effect gerçeğinin önkoşulu değildir.

## Erişim, TCB ve step-up

Temel erişim predicate'i tam olarak
`SUPER_ADMIN AND ModuleCode.ARIA AND immutable-subject workspace allowlist` değeridir. Tenant veya
workspace header'ı kimlik kaynağı değildir. Step-up grant; operation, workspace, target SHA,
payload digest, policy ID/version, subject, audience, nonce, issued-at ve expiry'ye bağlıdır;
kısa ömürlü ve single-use'dur, effect oluşturma transaction'ında atomik tüketilir.

Operator-owned TCB şunları içerir: policy roots, required-check manifest, risk taxonomy, identity
bindings, key material, step-up policy, deployment/release policy, evidence admission logic ve
progress verifier. ARIA bunları değiştiremez veya aktive edemez. Policy-attestor yalnız pinlenmiş
TCB sürümünü okuyup typed verdict üretir; unknown/malformed/expired girdi `DENY` olur.

## Bileşen ve kaynak yapısı

Tek backend root `apps/aria-service`, core ise `src/kernel` altındadır. Ayrı kernel package ve
legacy import yoktur. Önerilen dependency direction:

```text
domain/value objects <- kernel state machines <- application use cases
        ^                      ^                         ^
        |                      |                         |
 repository ports       policy/evidence ports      GraphQL/workers
        ^                                                ^
 Postgres/object adapters                         runtime composition
```

Modüller tek sorumluluklu olmalıdır; god service/controller yasaktır. CI dependency direction,
cyclomatic complexity, function size ve file-size kontrolü uygular. `<=250` satır hedefi aşımı
gerekçe ve split incelemesi ister; `>400` generated/declarative migration istisnası dışında gate'i
durdurur.

## Domain ve state modeli

Başlıca aggregate'lar: `Repository`, `Workspace`, `Mission`, `Conversation`, `Finding`, `Plan`,
`ExecutionJob`, `Attempt`, `Lease`, `Effect`, `Artifact`, `Evidence`, `Attestation`, `Permit`,
`Decision`, `ProviderReservation`, `ReconciliationCursor` ve `Incident`.

Postgres current-state tabloları authority'dir. Audit ve outbox satırları aynı transaction'ın
companion kayıtlarıdır; sistem event-sourced rebuild sözleşmesi kurmaz. Her externally visible
effect durable UUID, idempotency key, expected version, fencing token, attempt, terminal result ve
reconciliation cursor taşır. Büyük immutable içerik content-addressed object store'a gider;
Postgres digest, media type, size, tenant/workspace, DLP ve retention metadata'sını tutar.

## Durable protokoller

Sprint/program durumu yalnız:
`PLANNED -> READY -> IN_PROGRESS -> VERIFYING -> DONE`; side state'ler `BLOCKED`, `SUPERSEDED`.
Kanıtsız geçiş ve yüzde/partial status yoktur.

```text
Mission: DRAFT -> SUBMITTED -> PLANNED -> EXECUTING -> VERIFYING -> TERMINAL
Job:     QUEUED -> LEASED -> RUNNING -> VERIFYING -> SUCCEEDED | FAILED | CANCELLED
Effect:  INTENDED -> DISPATCHED -> UNKNOWN -> RECONCILED_SUCCEEDED | RECONCILED_FAILED
Permit:  ISSUED -> CONSUMED | EXPIRED | REVOKED
Freeze:  ACTIVE -> FREEZING -> FROZEN -> RESUMING -> ACTIVE
```

Lease fencing ve heartbeat stale worker yazımını reddeder. Cancel yeni effect'i keser, başlamış
effect'i reconcile eder. Crash sonrası scheduler current-state ve effect journal'dan devam eder;
replay idempotency anahtarını değiştiremez. `UNKNOWN` başarı sayılmaz.

## Postgres, outbox ve object-store tutarlılığı

Command state, idempotency, effect intent, audit ve outbox aynı DB transaction'ında yazılır.
Dispatcher outbox'ı at-least-once taşır; consumer durable inbox ile tekilleştirir. Object upload
önce quarantine namespace'e yapılır, digest/size/DLP doğrulanır, ardından DB admission transaction'ı
CAS referansını görünür kılar. Yetim upload garbage collection'a, eksik object ise incident ve
fail-closed verdict'e gider. Backup Postgres PITR ile object version/digest manifestini birlikte
bağlar; restore reconciliation tamamlama gate'idir.

## Provider broker sözleşmesi

Yalnız Codex CLI ve Claude Code CLI subscription kullanılır; API fallback yoktur. Broker request:
`requestId`, `workspaceId`, `snapshotSha`, normalized capability, budget reservation, timeout,
retention class ve permitted tool set taşır. Response provider/model provenance, CLI version,
started/ended UTC, exit, usage, sanitized artifact digest ve typed transport result döndürür.
Broker semantic satisfaction, approval veya policy verdict üretemez. Credential control ve
executor rolüne geçmez. Capability eksikliği veya cost belirsizliği çağrı öncesi `DENY` üretir.

## Execution ve artifact admission

Her sprint/mission isolated branch ve registered worktree kullanır. Canonical containment,
symlink/realpath, `git worktree list --porcelain`, allowlisted command, network egress, resource
quota ve cleanup gate'i birlikte uygulanır. Executor yalnız immutable input snapshot'tan çalışır;
artifact exact target SHA ve diff'e bağlanır. Secret/DLP taraması env-assignment dahil içerik,
filename, metadata ve diff kapsamını doğrular. Fetch katmanı DNS çözümü, IP sınıfı, private/
loopback/link-local aralık, redirect zinciri, rebinding, boyut ve süreyi her hop'ta denetler.

## Evidence ve adversarial supervision

Proof class'ları `code_proven`, `live_proven`, `operator_attested` değerleridir. Her evidence:
claim, target SHA, `origin/main` reachability, authority path/digest, producer, gerekli reviewer,
exact command/workflow run, UTC başlangıç/bitiş, exit/verdict, artifact URI/digest, freshness,
gerekli negative control ve linked finding taşır. Producer kendi kaydını kabul edemez.

On iki rol — integrity, identity, authorization, execution containment, supply chain, data/privacy,
cost/capacity, reliability/DR, GitHub delivery, API/UI, portability ve appellate reviewer — her
phase gate'ine ve S70'e saldırır. Producer/challenger/judge/appellate kimlikleri ayrıdır. Typed
verdict ve deterministic oracle olmadan quorum oluşmaz; NaN, bool, malformed veya missing veri
reddedilir. Transport acceptance `no_gaps` üretemez.

## GitHub publish ve merge protokolü

Publisher least-privilege GitHub App ile branch/PR/check oluşturup reconcile eder; merge yetkisi
yoktur. Merge App contents yazabilir fakat bypass permission taşımaz. Merge evaluation ayrı
policy-attestor dossier'ıdır. Merge effect:

1. REST API version `2026-03-10`, durable UUID effect identity ve exact base/head SHA kaydedilir.
2. Per-base lock alınır; single-use permit aynı transaction'da tüketilir.
3. Request idempotency key ile gönderilir; `202` pending, `409` conflict olarak kaydedilir.
4. Timeout/unknown sonucu retry ile körlemesine tekrarlanmaz; PR/commit durumu okunarak reconcile edilir.
5. Read-after-write exact merged SHA, base reachability ve required check sonuçlarını doğrular.

Merge release değildir. Human release/deploy gate kalır. Finding yalnız exact deployed SHA için
güncel `live_proven` evidence varsa `SOLVED` olabilir; merged-only durum `VERIFYING` kalır.

## GraphQL ve web bilgi mimarisi

Public query listesi tam olarak: `ariaOverview`, `ariaMissions`, `ariaMission`, `ariaTimeline`,
`ariaProviderStatus`, `ariaPolicyStatus`, `ariaProgramProgress`.

Public mutation listesi tam olarak: `createAriaMissionDraft`, `postAriaConversationMessage`,
`submitAriaMission`, `cancelAriaMission`, `retryAriaMission`, `freezeAriaAutonomy`,
`resumeAriaAutonomy`, `requestAriaMergeEvaluation`, `acknowledgeAriaDecision`.

Başka public operation eklemek schema/contract review gerektirir. `web/modules/aria`, federation
adı `ariaModule`, route `/aria`, development port `5179` kullanır. Sayfalar Overview, Missions,
Mission Detail/Conversation, Timeline/Evidence, Providers, Policy ve Program Progress'tir.
Read model her cevapta `asOf`, cursor ve authority version taşır; stale/corrupt/missing ayrı görünür.

Conversation mesajı doğrudan effect doğurmaz. Draft; soru, yanıt, acceptance, risk, budget ve
immutable snapshot'ı birleştirir. `submitAriaMission` typed özeti kilitler; etkili adım policy ve
gerekirse step-up ister. Cancel/retry önceki attempt ve artifact'ı silmez.

## Observability, privacy ve retention

Trace/log/metric; mission, job, attempt, effect, provider call ve GitHub request correlation ID'leri
ile bağlanır. SLO'lar queue age, lease loss, reconcile lag, provider error, artifact admission,
policy denial, cost reservation ve restore doğruluğunu kapsar. PII/secret structured log'a girmez.

Raw prompt retention varsayılanı sıfırdır. Incident raw capture açık operator kararıyla en fazla
7 gün; sanitized operational data 180 gün; decision, permit, merge ve outcome 3 yıl tutulur.
Legal hold silmeyi durdurur fakat erişimi genişletmez. Silme; DB tombstone, object version purge,
backup expiry ve digest-bound deletion proof ile kanıtlanır.

## Freeze, kill, resume ve incident davranışı

`freezeAriaAutonomy` yeni provider/git/merge effect intent'lerini keser; yürüyen effect'leri iptal
veya reconcile eder, durable reason/actor/policy version yazar. Kill switch operator-owned TCB'dir
ve ARIA tarafından açılamaz. Resume; aynı access predicate, step-up, incident closure, queue/effect
reconciliation ve current policy attestasyonu ister. Provider outage, identity revoke, DB/object
corruption veya evidence verifier kaybı otomatik fail-closed freeze sebebidir.

## Deployment, kapasite, DR ve taşınabilirlik

Control plane production droplet'ta kaynak limitli çalışabilir; executor mutlaka ayrı worker VM'de
olur. Quota workspace/provider/risk sınıfı bazında; admission pre-call reservation ve global host
headroom ile yapılır. Queue fairness, circuit breaker ve backpressure ölçülür.

PITR, versioned object store, encrypted off-host backup ve restore manifesti birlikte kullanılır.
DR tatbikatı boş ortamda kimlikleri yeniden bağlar, Postgres'i point-in-time restore eder, object
digest'lerini doğrular ve effect reconciliation tamamlanmadan yazımı açmaz. Config repository/
provider/region kimliğini runtime code'dan ayırır; Nx/TypeScript varsayımı port dışına sızmaz.

## Rollout, coexistence ve removal ölçütü

Rollout sırası read-only, isolated no-push, PR delivery, adversarial validation, shadow,
`PR_ONLY`, low-risk canary ve bounded medium-risk'tir. Legacy karşılaştırması salt-okunur evidence
olarak kalır; çift yazım ve runtime fallback yoktur. High-risk S65-S72 boyunca yalnız keşfedilir,
sınıflandırılır ve readiness dossier'ına girer; aktivasyon yasaktır ve yeni onaylı program ister.

Legacy removal bu programın kararı değildir. İlerideki ayrı karar; operator sahipliği, archive
integrity, legal retention, rollback ihtiyacı, yeni sistemin bağımsız burn-in'i ve aktif consumer
envanterinin sıfır olduğunu kanıtlamalıdır.

## Varsayımlar ve bilinmeyenler

- GitHub App permission/branch-protection gerçekliği D0'da kaynak üzerinden doğrulanamaz; S25/S31
  live contract testleri gerekir.
- Provider subscription concurrency, CLI session semantics ve rate limitleri S14/S20/S21'de
  ölçülecektir; bilinmeyen kapasite otonomi izni vermez.
- Worker VM kapasitesi, RPO/RTO ve burn-in örneklem alt sınırı operator prerequisite olarak
  planlanmıştır; sayısal değerler ölçüm ve operator onayı olmadan varsayılmaz.
- Audit bulguları legacy kusurlarını bu programla kapatmaz; yalnız yeni sistemin bunları miras
  almamasına yönelik test/control girdisidir.

## Reddedilen alternatifler

- **Legacy üzerinde genişletme:** aktif runtime'ı riske atar ve güven/kimlik/state kusurlarını miras alır.
- **Legacy kod veya state import'u:** bağımsız ürün ve authority sınırını bozar.
- **Ayrı kernel package:** tek source root ve yerel anlaşılabilirliği parçalar.
- **Event-sourced rebuild:** current-state/effect gerçeğine gereksiz ikinci authority ekler.
- **Shared credential veya model self-review:** principal ayrımını ve non-forgeable onayı yok eder.
- **API fallback:** subscription-only provider policy ve credential containment'ı ihlal eder.
- **NATS'i durable truth yapmak:** broker kaybını command/effect kaybına dönüştürür.
- **Çift yazım veya big-bang replacement:** uzlaştırılamayan authority ve rollback belirsizliği yaratır.
- **High-risk aktivasyonu:** bu programın kanıt kapsamını aşar; S72 sonunda kapalı kalır.
