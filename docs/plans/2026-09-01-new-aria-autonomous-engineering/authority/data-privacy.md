# Data, Artifact ve Privacy Sözleşmesi

[Authority index](INDEX.md) · Owners: S03-S04, S14, S18, S23, S39, S41, S45, S61, S68.

## Schema ve structural workspace isolation

Yeni servis yalnız non-public `aria` Postgres schema'sına sahiptir. Bütün TypeORM persistence
entity'leri `schema: "aria"` bildirir; `public` veya unspecified schema yasaktır. Migration authority
`apps/aria-service/src/database/migrations`, standalone migration runner ve `SchemaDriftModule`
kaydıdır; runtime `synchronize`/DDL yoktur. Domain entity'lerinde ORM decorator yoktur.

Authoritative structural ilişki:

```text
WorkspaceRepositoryBinding(tenant_id, workspace_id, code_repository_id) UNIQUE
MissionRepositoryScope(tenant_id, workspace_id, mission_id,
  code_repository_id + base_repository_id + head_repository_id + snapshot_sha) UNIQUE
```

Workspace bir ve yalnız bir immutable code repository'ye DB unique/FK ile bağlıdır. Her mission
immutable base/head repository rolleri ve snapshot'ı yukarıdaki composite key'de taşır. Job,
attempt, effect, outbox/inbox, projection, artifact, evidence, cursor, CAS admission, reconcile,
restore ve delete parent/child anahtarları `tenant_id + workspace_id + mission_id +
code_repository_id + base_repository_id + head_repository_id + snapshot_sha` tuple'ının tamamına
FK verir. Ownership alanları immutable/non-null'dır; ID-only lookup veya application-only repository
check yoktur.

Foreground GraphQL yanında scheduler, lease, projection, reconciliation, restore, deletion ve CAS
adapter'ları bu exact tuple'ı isteyen scoped repository portu kullanır. `getRepository()` yasaktır;
structural context olmadan port çağrısı type error olur. Opaque artifact/cursor ID tek başına lookup
authority vermez.

S03/S04/S08 matrix'i aynı tenant ve aynı workspace içinde code/base/head repository ID'lerini ayrı
ayrı değiştirir; foreground, background, reconcile, CAS, restore ve delete yollarının tamamı DB/FK
ve port type boundary'sinde reddeder. İki-workspace swap matrix'i de korunur. Schema invariant
unspecified/`public` entity, unscoped port veya incomplete composite repository key'i fail eder.

## Pre-call DLP

S14 canonical provider payload builder şu exact byte setini normalize eder: system/user messages,
conversation context, repository excerpts, tool inputs, attachments ve metadata. Normalization
version, payload digest, workspace/snapshot, DLP rules/scanner digest, decision, redactions,
expiry ve issuer içeren closed `DlpAdmission` oluşturulur. S20/S21 exact digest'i process spawn ve
network dispatch öncesi doğrular; payload değişirse çağrı sayısı sıfırdır.

Scanner; quoting/multiline, env assignment, filename/metadata, URL userinfo/query, hex/base64,
Unicode normalization/confusables, high-entropy/opaque input, binary/archive expansion limitleri,
PII ve secret class'larını kapsar. Decode/scan belirsizliği deny'dır. Provider retention/telemetry
capability ayrıca verified olmalıdır; local raw-retention zero provider disclosure/retention
kanıtı değildir. 022/085 fixtures aynı production payload builder'ı kullanır.

## Quarantine ve immutable CAS

Tercih edilen yol durable upload öncesi bounded stream scan'dir. Durable quarantine gerekirse:

- job-scoped data key, hard TTL ve scanner-only identity;
- versioning/replication/backup/export kapalı; multipart/temp inventory dahil;
- deny/expiry/crash sonrası key destroy + bütün bytes/fragments purge;
- admitted bytes conditional-create/no-overwrite ile ayrı versioned CAS namespace'e copy/re-key.

Admission record; workspace/snapshot/source, object key+immutable version ID, byte length, media
type, digest, scanner binary/rules digest, DLP/policy version ve retention class'ı bağlar. Object
lock/immutable retention veya eşdeğer store policy overwrite/delete'i engeller. Her consumer full
stream rehash, expected version/length/media type ve workspace binding doğrular. Same-key overwrite,
changed version, corrupt range, scanner update ve post-scan mutation deny olur.

Crash matrix upload/scan/promote/DB-visible/outbox sınırlarında current objects, versions,
multipart, replica ve backup manifestlerini enumerate eder. Reddedilmiş plaintext veya decryptable
ciphertext kalamaz; admitted bytes digest'i exact reconcile olur.

## Encryption ve key custody

TLS/mTLS in transit zorunludur. Operator KMS/HSM; signing, provider ve mTLS keys'den ayrı envelope
data-key hierarchy sağlar. Keys en az environment + workspace + data class'a scoped'dur:
Postgres sensitive columns/tablespaces, CAS version, quarantine job, export, telemetry capture ve
backup için ayrı derivation/context vardır.

Role decrypt allowlist'i least-privilege'dir; key use audit/outbox'a gider. Rotation/revocation,
old-backup decrypt, lost-key response, independent backup-key escrow ve crypto-erasure prosedürü
operator TCB'dir. Tek runtime rolü başka workspace veya backup key'ini alamaz. Wrong-workspace key,
ciphertext substitution, KMS outage, revoked/rotated/lost key ve restored-old-backup testleri effect
admission'ı reconciliation bitene kadar kapatır.

## Admitted evidence redaction

Evidence schema raw argv/env/output kaydetmez. Saklanan alanlar command ID + allowlisted/redacted
argv, env **names** only, sanitized CAS URI/ID, bounded stdout/stderr summary, typed result ve
redacted reviewer/incident reference'ıdır. URI userinfo/query, filename, stack trace, patch/provider
transcript ve report text DLP/redaction'dan imza/hash/persistence/export/log öncesi geçer; redactor
failure admission'ı bloklar. Raw incident material evidence'a bağlanır fakat içine gömülmez.

Secret/PII fixture'ları argv, env, URI, filename, output, source patch, report, DB/object/event,
export, backup ve UI response byte-scan'iyle doğrulanır. Immutable proof secret içeriyorsa kanıt
admit edilmez; sonradan maskelenmiş sayılmaz.

## Capture, legal hold ve deletion

Raw capture default `DISABLED`, en çok 7 gündür. `CaptureGrant`; independent privacy issuer,
human subject/workspace, incident/case ID, purpose, data classes, consent veya legal basis, exact
scope, audience, policy version, step-up, issued/expiry ve atomic single-use activation taşır.
Reader capability ayrı, kısa ömürlü ve audit'lidir. Revoke/TTL yeni capture'ı anında keser.

Hold create/release ayrı independent legal authority ve expected version ister. Delete effect:

```text
REQUESTED -> BLOCKED_BY_HOLD | IN_PROGRESS -> VERIFYING -> PROVEN | FAILED
```

Expected-surface manifest DB rows/projections, CAS versions/fragments, exports, logs, provider
retention/deletion attestations, replicas ve backup-expiry manifests'i listeler. Outbox/reconcile
her surface'i idempotent siler; active hold yarışı atomik bloklar. Her expected surface deleted veya
active hold altında açıklanmadıkça `PROVEN` yoktur. Restore-after-delete tombstone/crypto-erasure
durumunu yeniden uygular; provider refusal/backup age `VERIFYING` veya `FAILED` bırakır.

Raw prompt default zero, incident raw max 7d, sanitized operational 180d ve decision/permit/merge/
outcome 3y süreleri korunur. Legal hold erişimi genişletmez ve silently expiry'yi kaldırmaz.
