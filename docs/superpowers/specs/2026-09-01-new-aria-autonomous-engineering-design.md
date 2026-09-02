# Yeni ARIA Otonom Mühendislik Tasarımı

- **Program ID:** `new-aria-autonomous-engineering`
- **Tarih:** 2026-09-01
- **Durum:** D0 tasarım kaydı; bağımsız inceleme ve merge bekliyor
- **Taban:** `origin/main@eeb401131260fe45f3f60be55fa25d023a082d18`
- **Uygulama planı:**
  [`../../plans/2026-09-01-new-aria-autonomous-engineering/PLAN.md`](../../plans/2026-09-01-new-aria-autonomous-engineering/PLAN.md)
- **Audit girdisi:** `85787e610` commit'indeki 88 bulgu; iddiaların kaynak tabanı `d0afe46bd`

## Normatif contract split

Bu design overview'dır; load-bearing closed contracts
[`../../plans/2026-09-01-new-aria-autonomous-engineering/authority/INDEX.md`](../../plans/2026-09-01-new-aria-autonomous-engineering/authority/INDEX.md)
altındaki küçük authority sayfalarındadır. Identity/issuer/TCB, execution/toolchain, data/privacy,
operations/DR, GitHub, API/browser ve evidence sözleşmeleri bu belgeyle birlikte normatiftir;
belirsizlik veya özet farkı effect yetkisi vermez.

## Bağlam ve karar

Mevcut ARIA aktif kullanımdadır; repository biçimli Python/GitHub Actions çalışma zamanı, durumu ve
operator süreçleri değişmeden kalır. Yeni ARIA, `apps/aria-service` ve `web/modules/aria` altında
bağımsız ürün sınırı olarak kurulacaktır. Yeni sistemin kendi Postgres ve object-store gerçeği,
kimlikleri, policy kökleri ve yaşam döngüsü vardır. Legacy çıktılar yalnız immutable audit ve
karşılaştırma girdisidir; runtime veya veri bağımlılığı değildir.

D0 yalnız tasarım ve programı kaydeder. Ürün kodu D0 PR'ı incelenip merge edilmeden başlayamaz. Bu
belge yeni ARIA'nın canlı, merge yetkili veya mevcut sistemin yerine geçmiş olduğunu iddia etmez.

## Hedefler ve hedef olmayanlar

Hedefler:

- Salt-okunur keşiften kanıtlı düşük/orta risk merge'e kadar kademeli, fail-closed otonomi.
- Her komut, deneme, effect, approval, artifact ve karar için kalıcı ve yeniden uzlaştırılabilir
  gerçek.
- Producer, reviewer, attestor, publisher ve merge authority arasında bağımsız kimlik ve yetki.
- Exact SHA, deterministic oracle, negatif kontrol ve güncel canlı kanıtla kapanan bulgular.
- Tek kaynak kökü ve küçük, cohesive modüller: hedef `<=250` fiziksel satır; `>400` hard review
  gate.
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

Her image ayrı filesystem, UID, secret mount, NetworkPolicy ve Linux capability set'i alır. Sekiz
rolün tamamı production droplet dışında, pinlenmiş numeric UID/resource sınırlarıyla çalışır;
provider CLI/child tool'lar ayrı worker VM'dedir. Exact host/mount/RPC/secret/egress/capability
manifesti
[identity](../../plans/2026-09-01-new-aria-autonomous-engineering/authority/identity-authority-tcb.md)
ve
[execution](../../plans/2026-09-01-new-aria-autonomous-engineering/authority/execution-supply-chain.md)
authority'sindedir. NATS kullanılırsa kimlik yalnız sertifika CN'dir; CONNECT user/password/token
yoktur ve durable command/effect gerçeğinin önkoşulu değildir.

## Erişim, TCB ve step-up

Temel erişim predicate'i tam olarak
`SUPER_ADMIN AND ModuleCode.ARIA AND immutable-subject workspace allowlist` değeridir. Tenant veya
workspace header'ı kimlik kaynağı değildir. Human/repository/workload tuple'ları ve human/low/medium
grant-permit issuer principal'ları
[identity authority](../../plans/2026-09-01-new-aria-autonomous-engineering/authority/identity-authority-tcb.md)
ile canonical'dır. Step-up/permit exact issuer, audience,
repository/workspace/PR/effect/SHA/payload, policy/dossier/ruleset, nonce ve expiry'ye bağlı;
short-lived/single-use ve exact effect transaction'ında atomik tüketilir. Issuer consumer/producer
olamaz.

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
cyclomatic/cognitive complexity, function/file size ve exception provenance kontrolü uygular.
Numeric limitler ve intra-project layer edges
[`readability-policy.json`](../../plans/2026-09-01-new-aria-autonomous-engineering/verification/readability-policy.json)
authority'sindedir. Migration semantic/complexity review'den muaf değildir; generated exception
yalnız source/generator/digest/owner/expiry ve deterministic regeneration proof'uyla mümkündür.

## Domain ve state modeli

Başlıca aggregate'lar: `Repository`, `Workspace`, `Mission`, `Conversation`, `Finding`, `Plan`,
`ExecutionJob`, `Attempt`, `Lease`, `Effect`, `Artifact`, `Evidence`, `Attestation`, `Permit`,
`Decision`, `ProviderReservation`, `ReconciliationCursor` ve `Incident`.

Postgres `aria` schema current-state tabloları authority'dir; `public`/unspecified schema yoktur.
Audit ve outbox aynı transaction'ın companion kayıtlarıdır; event-sourced rebuild yoktur. Immutable
tenant/workspace/repository composite ownership bütün foreground/background/CAS path'lerinde
structural'dır. Her externally visible effect durable UUID, idempotency, expected version, fence,
cancel/recovery epoch, attempt, reservation, terminal result ve reconciliation cursor taşır. Exact
schema/key/encryption/CAS contract'ı
[data authority](../../plans/2026-09-01-new-aria-autonomous-engineering/authority/data-privacy.md)'ndedir.

## Durable protokoller

Sprint/program durumu yalnız: `PLANNED -> READY -> IN_PROGRESS -> VERIFYING -> DONE`; side state'ler
`BLOCKED`, `SUPERSEDED`. Kanıtsız geçiş ve yüzde/partial status yoktur.

```text
Mission: DRAFT -> SUBMITTED -> PLANNED -> EXECUTING -> VERIFYING -> TERMINAL
Job:     QUEUED -> LEASED -> RUNNING -> VERIFYING -> SUCCEEDED | FAILED | CANCELLED
Effect:  INTENDED -> DISPATCHED -> UNKNOWN -> RECONCILED_SUCCEEDED | RECONCILED_FAILED
Permit:  ISSUED -> CONSUMED | EXPIRED | REVOKED
Reservation: RESERVED -> DISPATCHED -> SETTLED | HELD_UNKNOWN | EXPIRED_UNUSED
Freeze:  ACTIVE -> FREEZING -> FROZEN -> RESUMING -> ACTIVE
```

Lease fencing ve heartbeat stale worker yazımını reddeder. Cancel yeni effect'i keser, başlamış
effect'i reconcile eder. Crash sonrası scheduler current-state ve effect journal'dan devam eder;
replay idempotency anahtarını değiştiremez. `UNKNOWN` başarı sayılmaz.

## Postgres, outbox ve object-store tutarlılığı

Command state, idempotency, effect intent, audit ve outbox aynı DB transaction'ında yazılır.
Dispatcher outbox'ı at-least-once taşır; consumer durable inbox ile tekilleştirir. Object byte'ları
durable upload öncesi taranır veya bounded/non-versioned/non-replicated quarantine key'iyle tutulur;
admitted CAS conditional-create, immutable version ve consume-time rehash ister. Backup signed DB
timeline/LSN + exact object-version recovery cut, off-host dispatch horizon, independent failure
domain ve global recovery epoch'a bağlıdır. Ayrıntı
[data](../../plans/2026-09-01-new-aria-autonomous-engineering/authority/data-privacy.md) ve
[operations](../../plans/2026-09-01-new-aria-autonomous-engineering/authority/operations-reliability.md)
authority'sindedir.

## Provider broker sözleşmesi

Yalnız Codex CLI ve Claude Code CLI subscription kullanılır; API fallback yoktur. Broker request
canonical job/attempt/effect/idempotency, lease/fence/cancel/recovery epoch, immutable snapshot,
reservation, DLP ve toolchain manifest envelope'unu taşır. Response provider/account/model/CLI,
quota/charge certainty, UTC/exit/usage, sanitized digest ve typed transport result döndürür. Broker
semantic satisfaction/approval/policy verdict üretmez; credential executor/control'a geçmez. Exact
process/RPC/envelope contract'ı
[execution authority](../../plans/2026-09-01-new-aria-autonomous-engineering/authority/execution-supply-chain.md)'ndedir.

## Execution ve artifact admission

Her sprint/mission isolated branch ve registered worktree kullanır. Supervisor-owned opaque
ephemeral VM/volume cleanup; handle-relative no-symlink traversal, mount/inode revalidation, active
lease/child fencing ve no-recursive-fallback ile path replacement race'ini kaldırır. Executor yalnız
immutable input snapshot'tan çalışır; artifact exact target SHA ve diff'e bağlanır. Secret/DLP
taraması env-assignment dahil içerik, filename, metadata ve diff kapsamını doğrular. Fetch katmanı
DNS çözümü, IP sınıfı, private/ loopback/link-local aralık, redirect zinciri, rebinding, boyut ve
süreyi her hop'ta denetler.

## Evidence ve adversarial supervision

Proof class'ları `code_proven`, `live_proven`, `operator_attested` değerleridir. Manifestler
immutable ve versioned'dır; her yeni verdict yeni evidence+event'tir. Evidence canonical authority
repository ref reachability, exact executable argv/tool/script/input digest, reviewer,
UTC/result/artifact, type-specific freshness/invalidators, negatives ve findings taşır. Event hash
canonicalization ve historical verification
[evidence authority](../../plans/2026-09-01-new-aria-autonomous-engineering/authority/verification-evidence.md)'ndedir.

On iki rol — integrity, identity, authorization, execution containment, supply chain, data/privacy,
cost/capacity, reliability/DR, GitHub delivery, API/UI, portability ve appellate reviewer — her
phase gate'ine ve S70'e saldırır. S33 öncesi operator-authorized external mechanism tam seti sağlar;
“subset” yoktur. Producer/challenger/judge/appellate ayrıdır. Exact role/report/oracle/dissent veya
appellate eksikliği promotion'ı bloklar; transport acceptance `no_gaps` üretemez.

## GitHub publish ve merge protokolü

Publisher narrowed GitHub App token ile branch/PR/check oluşturup provider-visible natural key'le
reconcile eder; merge yetkisi yoktur. Merge App contents yazabilir fakat effective ruleset bypass
actor/capability taşımaz. REST `2026-03-10` protocolü local effect ID ile provider merge UUID'yi
ayırır; exact `sha`, protected `merge_action` ve options digest taşır;
`200/202/400/403/404/409/422`, 24-hour result expiry, stack prohibition, crash ve readback
semantics'ini kapatır. Caller idempotency field varsayılmaz ve unknown blind retry edilmez. Exact
authority:
[`github-delivery.md`](../../plans/2026-09-01-new-aria-autonomous-engineering/authority/github-delivery.md).

Merge release değildir. Human release/deploy gate kalır. Finding yalnız exact deployed SHA için
güncel `live_proven` evidence varsa `SOLVED` olabilir; merged-only durum `VERIFYING` kalır.

## GraphQL ve web bilgi mimarisi

Public query listesi tam olarak: `ariaOverview`, `ariaMissions`, `ariaMission`, `ariaTimeline`,
`ariaProviderStatus`, `ariaPolicyStatus`, `ariaProgramProgress`.

Public mutation listesi tam olarak: `createAriaMissionDraft`, `postAriaConversationMessage`,
`submitAriaMission`, `cancelAriaMission`, `retryAriaMission`, `freezeAriaAutonomy`,
`resumeAriaAutonomy`, `requestAriaMergeEvaluation`, `acknowledgeAriaDecision`.

Başka public operation eklemek schema/contract review gerektirir. `web/modules/aria`, federation adı
`ariaModule`, route `/aria`, development port `5179` kullanır. Sayfalar Overview, Missions, Mission
Detail/Conversation, Timeline/Evidence, Providers, Policy ve Program Progress'tir. Exact
args/nullability/cursor/idempotency/expected-version/result union, resumable SSE, five-state
`OK|EMPTY|MISSING|CORRUPT|UNAVAILABLE`, mutation policy, same-origin security ve clean-host
integration
[API/UI authority](../../plans/2026-09-01-new-aria-autonomous-engineering/authority/api-ui.md)'ndedir.

Conversation mesajı doğrudan effect doğurmaz. Draft; soru, yanıt, acceptance, risk, budget ve
immutable snapshot'ı birleştirir. `submitAriaMission` typed özeti kilitler; etkili adım policy ve
gerekirse step-up ister. Cancel/retry önceki attempt ve artifact'ı silmez.

## Observability, privacy ve retention

Trace/log/metric; mission, job, attempt, effect, provider call ve GitHub request correlation ID'leri
ile bağlanır. SLO'lar queue age, lease loss, reconcile lag, provider error, artifact admission,
policy denial, cost reservation ve restore doğruluğunu kapsar. PII/secret structured log'a girmez.

Raw prompt retention varsayılanı sıfırdır. Incident raw capture typed privacy grant ile en fazla 7
gün; sanitized operational data 180 gün; decision, permit, merge ve outcome 3 yıl tutulur. Evidence
field-level pre-hash redact edilir. Hold/delete independent authority ve durable
`REQUESTED -> ... -> PROVEN|FAILED` reconciliation ister; bütün expected surfaces bitmeden proof
yoktur.

## Freeze, kill, resume ve incident davranışı

`freezeAriaAutonomy` yeni provider/git/merge effect intent'lerini keser; yürüyen effect'leri iptal
veya reconcile eder, durable reason/actor/policy version yazar. Operator kill DB/control plane'den
bağımsız provider/GitHub/identity/network revoke + readback ceremony'sidir. Resume; partial kill,
outstanding effect, stale recovery epoch veya receiver/readiness gap'i varken yoktur.

## Deployment, kapasite, DR ve taşınabilirlik

Hiçbir yeni ARIA rolü production droplet'ta çalışmaz; dedicated control VM ile ayrı worker VM exact
resource/DB-pool/headroom admission'ından geçer. Charged-unknown reservation, durable cooldown,
aggregate storage/queue/telemetry quotas, out-of-band kill/paging, dispatch horizon, signed
DB/object recovery cut, cross-account/region backup ve global failover epoch
[operations authority](../../plans/2026-09-01-new-aria-autonomous-engineering/authority/operations-reliability.md)'ndedir.

## Rollout, coexistence ve removal ölçütü

Rollout sırası read-only, isolated no-push, PR delivery, adversarial validation, shadow, `PR_ONLY`,
low-risk canary ve bounded medium-risk'tir. Legacy karşılaştırması salt-okunur evidence olarak
kalır; çift yazım ve runtime fallback yoktur. High-risk S65-S72 boyunca yalnız keşfedilir,
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

- **Legacy üzerinde genişletme:** aktif runtime'ı riske atar ve güven/kimlik/state kusurlarını miras
  alır.
- **Legacy kod veya state import'u:** bağımsız ürün ve authority sınırını bozar.
- **Ayrı kernel package:** tek source root ve yerel anlaşılabilirliği parçalar.
- **Event-sourced rebuild:** current-state/effect gerçeğine gereksiz ikinci authority ekler.
- **Shared credential veya model self-review:** principal ayrımını ve non-forgeable onayı yok eder.
- **API fallback:** subscription-only provider policy ve credential containment'ı ihlal eder.
- **NATS'i durable truth yapmak:** broker kaybını command/effect kaybına dönüştürür.
- **Çift yazım veya big-bang replacement:** uzlaştırılamayan authority ve rollback belirsizliği
  yaratır.
- **High-risk aktivasyonu:** bu programın kanıt kapsamını aşar; S72 sonunda kapalı kalır.
