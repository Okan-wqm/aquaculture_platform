# Operations, Reliability, DR ve Promotion Sözleşmesi

[Authority index](INDEX.md) · Owners: S14, S17, S31, S39-S48, S52-S56, S61-S69.

## Charged-unknown reservation

`ProviderReservation` authoritative state machine'i:

```text
RESERVED -> DISPATCHED -> SETTLED
                       -> HELD_UNKNOWN -> SETTLED | MANUAL_RECONCILIATION
RESERVED -> EXPIRED_UNUSED
```

Kayıt provider account/subscription/quota bucket, subject, workspace, risk class, mission/job/
attempt/effect/request/idempotency ID, quota window/unit, conservative upper bound, policy version ve
expiry taşır. Reserve transaction'ı workspace/provider/global available balance'ı atomik azaltır;
dispatch öncesi consume edilir. Started olup charge certainty belirsiz kalan call'ın tam upper
bound'ı `HELD_UNKNOWN` kalır; lease/timeout/cancel bunu release etmez ve retry başlatamaz. Settlement
provider-authoritative usage veya açık conservative upper bound ile bir kez yapılır; overage
incident/freeze üretir, negative balance üretemez.

Kill points reserve, dispatch, provider acceptance, response, usage write, settle ve release'te;
cancel/lease/retry races ise tek call/reservation/settlement ve unknown hold'u kanıtlar.

## Durable retry ve provider cooldown

Normalized result; provider account/quota bucket, limit/remaining/reset/TTL, `Retry-After`, terminal
veya retryable class, acceptance/charge certainty, usage source/confidence ve observed freshness
taşır. Retry scheduler state'i attempt cap, exponential backoff+jitter, next-attempt UTC, provider
account retry budget ve original effect/reservation IDs'yi durably saklar.

Tek half-open probe provider account başına lock'lanır; fairness workspace'ler arasında uygulanır.
429/5xx/outage sonrası reboot next-attempt/cooldown'u sıfırlayamaz. Missing/malformed `Retry-After`,
reset regression veya charged timeout conservative deny/hold'dur. Both-provider outage, fleet
restart ve half-open race bounded call rate ve thundering-herd yokluğuyla ölçülür.

## Aggregate durable capacity

Operator `CapacityManifest`; subject/workspace/repository/provider/risk/global boyutlarında count,
bytes, rate ve age hard limitleri tanımlar. Kapsam: queued jobs/age, attempts/effects/outbox/inbox,
DB/WAL/connection pool, CAS/quarantine/version/multipart/inodes, conversations/drafts, evidence/
incidents/holds/exports/backups ve telemetry ingest/label cardinality.

Admission DB/WAL/CAS/backup/telemetry headroom'u transactionally reserve eder. High/low watermark,
GC/backup lag ve safety factor production service reserve floor'una yaklaşmadan backpressure/freeze
üretir. Critical incident/outbox için ayrı emergency capacity vardır; noncritical telemetry bounded
aggregate/drop count ile azaltılabilir, critical silently drop olmaz. Legal hold capacity owner/no-go
sınırına sahiptir. Sub-limit flood, unique labels, retry history, GC outage, disk/inode/WAL/DB pool ve
concurrent workspace tests deterministic refusal ve unrelated product health'i kanıtlar.

## External dispatch horizon ve recovery cut

Her provider/GitHub external effect; DB intent+permit consumption'dan sonra fakat dispatch'ten önce
immutable cross-account off-host `DispatchJournal` horizon'una ulaşır. Journal record effect UUID,
repository/base/head/payload/options, permit/reservation, recovery epoch ve digest'i taşır; horizon
ack yoksa call yoktur. Restore `(recovery point, outage fence]` journal range'ini enumerate eder ve
GitHub/provider readback ile reconcile eder; complete expected set kanıtlanmazsa `FROZEN_MANUAL`.

Signed `RecoveryManifest` ortak cut alanları:

```text
sourceSystemId, postgresTimeline, LSN, recoveryTimestamp, dbBackupId,
objectBucketGeneration, exactObjectVersionInventoryDigest, retentionFloor,
dispatchHorizon, recoveryEpoch, signer, issuedAt
```

Expected object set restored DB'den türetilir ve immutable version inventory ile iki yönlü exact
karşılaştırılır. PITR window/hold/retention floor aşılmadan GC/delete physical version silmez.
Upload/admit/outbox/delete/purge/orphan/multipart kill-point'leri extra/missing/wrong-version veya
başka timeline manifestini fail-closed reddeder.

## Independent backup ve global failover

Son recoverable copy ayrı region ve administrative account'tadır; primary delete principal'ı onu
silemez. Immutable retention/object lock, independent backup-delete quorum, read-only restore
identity, separate escrowed/rotatable decrypt key ve measured replication lag/RPO zorunludur. Aynı
failure domain topology'si no-go'dur; “off-host” yeterli kanıt değildir.

Tek-active failover için operator-owned external monotonik `recoveryEpoch` gerekir. New region
write/effect ancak old epoch ingress/egress ve GitHub/provider/worker credentials provider-side
revoke edilip readback, routing cutover ve restore reconciliation doğrulandıktan sonra açılır. Lease,
permit, effect ve broker request epoch'a bağlıdır; stale region adapter/provider boundary'de deny
olur. Fencing authority/readback yoksa failover/resume yoktur.

## Out-of-band kill, paging ve readiness

Operator kill ARIA DB/control plane'inden bağımsızdır. Tek ceremony GitHub App installation
suspend/revoke, provider/broker egress deny, worker identity/firewall revoke ve merge-adapter deny
epoch'ini uygular; her hop provider readback ister. Her privileged effect kısa ömürlü external
allow epoch kontrol eder; kill authority unavailable/partial ise yeni effect yoktur. Incident DB'ye
sonradan reconcile edilir; kill DB write'a bağlı değildir.

Operational readiness manifest; availability/durability SLI'ları, numeric objective/window,
queue/reconcile/backup/evidence thresholds, error-budget burn/freeze rules, named 24x7 owner,
escalation/ack SLA ve independently tested receiver health taşır. Missing receiver/secret, monitor ile
same-host loss, unacked page veya stale manifest activation'ı bloklar.

## Zorunlu ordering ve freshness

- S39 out-of-band kill/paging ve required compromise/outage subsets'i kurar.
- S41'den önce clean-room deploy, exact per-role resource/DB pool budget, current OP-02/03/04/06/07,
  receiver ve headroom admission gerekir; hiçbir ARIA role production droplet'a yerleşmez.
- S43 yalnız dormant/disposable single canary'dir. S44 ceilings/cooldown/aggregate quota policy'sini
  atomik activate etmeden general PR/provider dispatch sıfırdır.
- S48 öncesi both-provider/worker loss ve single-role credential compromise drill'i current'tır.
- S52 disposable sandbox repository-only'dir; production target capability structurally disabled.
- S54 rollback/revert/freeze/page, current restore ve human owner drill'i tamamlar; S55 ilk production
  low-risk merge'dir. S56 öncesi region/failover ve merge-authority revoke drill'i current'tır.
- S64 öncesi medium quorum/authority compromise drill'i current'tır. S67/S68 bunları daha geniş
  pressure altında yeniler; daha geç drill önceki effect'i meşrulaştıramaz.

Live proof'ların max-age/invalidation anahtarları
[evidence contract](verification-evidence.md)'tadır. Image/config/policy/credential/topology/provider
quota/account veya stop-rule incident değişikliği gate'i `VERIFYING`/`BLOCKED` yapar.
