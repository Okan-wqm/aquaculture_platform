# Enterprise backup and restore architecture

| Field              | Value                                                                                |
| ------------------ | ------------------------------------------------------------------------------------ |
| Plan date          | 2026-07-30                                                                           |
| Baseline           | `f723a488432eccb3c63bd15e9161026956df7c61` (`origin/main`)                           |
| Architecture owner | platform architecture                                                                |
| Execution owners   | infra-expert, data-expert, security-reviewer, service owners                         |
| Status             | Architecture plan; no runtime, deployment, App, secret, or evidence-journal mutation |
| Production claim   | **Not ready** until every exit gate in this plan has machine-verifiable evidence     |

## Outcome

Build one fail-closed Recovery Control Plane that protects and restores the complete platform, not
one database in isolation. The control plane owns policy, orchestration, evidence, and readiness.
PostgreSQL/WAL-G, object storage replication, key escrow, transport replay, and derived-state rebuild
remain specialized data-plane mechanisms beneath that authority.

The target is measurable:

- 3-2-1-1-0 protection: at least three copies, two failure domains, one geographically separate
  copy, one independently administered immutable copy, and zero unverified backup errors;
- a five-minute PostgreSQL and critical-object RPO;
- a one-hour PostgreSQL recovery RTO and a two-hour complete-service recovery RTO;
- deterministic whole-platform and single-tenant recovery;
- cryptographic binding between a recovery point, every protected asset, the exact release, the
  encryption-key epoch, and the restore result;
- scheduled destructive restore drills on separately trusted compute;
- no production-readiness claim derived from backup creation alone.

This document introduces no runtime behavior. App activation, production deployment, live secret
changes, and evidence-journal implementation require their own reviewed execution changes.

## Non-negotiable rules

1. **One policy authority.** A machine-readable Data Protection Catalog is the only source for
   asset coverage, RPO/RTO, retention, legal-hold behavior, recovery dependencies, and verification.
   Workflows, alerts, runbooks, and dashboards are validated projections of that catalog.
2. **One mutation authority.** Backup and restore state changes pass through the Recovery Control
   Plane. Application services may request an operation; they may not execute host-level backup or
   restore commands.
3. **Restore proves backup.** A copy is not qualifying evidence until an isolated restore verifies
   structure, data parity, application invariants, key recovery, cleanup, and the time budget.
4. **Fail closed.** Missing assets, stale attestations, mixed key epochs, incomplete replicas,
   unavailable notaries, unknown object versions, or reconciliation gaps block readiness.
5. **No shared blast radius.** Production writers cannot delete the immutable copy. The primary
   cloud account cannot administer its retention. Restore identities cannot write backup data.
6. **Payload and metadata recover together.** PostgreSQL rows that reference object bytes are
   restored against exact object version IDs and SHA-256 digests from the same recovery cut.
7. **Derived state stays derived.** Redis, JetStream delivery state, and MQTT session state may be
   reconstructed only after durable ownership is proven elsewhere. Any state that cannot be
   reconstructed is reclassified as protected durable data.
8. **Keys are part of recoverability.** Ciphertext with no independently tested key path is a
   failed backup. Plaintext secret archives are forbidden.
9. **Recovery never targets production first.** Every recovery point is exercised on isolated
   compute before it becomes eligible for cutover.
10. **A green control-plane verdict is conjunctive.** Every required asset, verifier, dependency,
    and independent authority must be green for the exact same recovery-cut ID.

## Current-state findings

The repository already contains a strong PostgreSQL recovery kernel. The defect is architectural
coverage and authority fragmentation around it.

| Surface                    | Repository evidence                                                                                                                             | Current conclusion                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| PostgreSQL physical backup | `.github/workflows/backup-production.yml`, `tools/scripts/database/walg-base-backup.sh`, continuous WAL archive in `docker-compose.droplet.yml` | Strong mechanism: encrypted WAL-G chain, bounded archive timing, signed evidence                            |
| PostgreSQL logical backup  | `tools/scripts/database/backup-databases.sh`, `restore-databases.sh`, generated `database-verification.sql`                                     | Strong companion proof: exported snapshot, encrypted dump and sidecar, exact restore parity                 |
| PostgreSQL PITR            | `.github/workflows/pitr-restore-production.yml`, `walg-pitr-restore.sh`, `evaluate-walg-evidence.mjs`                                           | Strong verifier: explicit base backup, timestamp sentinels, migration heads, tenant schemas, RPO/RTO        |
| Production backup closure  | `verify-backup-dr-closure.yml`, `verify-walg-github-evidence.sh`                                                                                | Useful but PostgreSQL-centric; unresolved independent-authority and isolation findings keep closure open    |
| Admin tenant backups       | `BackupRestoreService` schedules per-tenant dumps under `/backups/schemas`; runtime restore rejects execution                                   | Competing backup authority; local files and metadata do not participate in the WAL-G recovery chain         |
| Production admin storage   | `docker-compose.droplet.yml` has no `/backups` mount for admin-api; `docker-compose.prod.yml` has `backup_data`                                 | Deployment-dependent durability and no single storage contract                                              |
| Redis                      | `redis_data` uses AOF plus RDB; compose comments state it has no off-host backup                                                                | Host restart durability only; host loss has no verified recovery path                                       |
| NATS JetStream             | file storage at `nats_data`; platform comments declare outbox and event-store as durable ownership                                              | Transport state has no repository-owned snapshot/replay recovery proof                                      |
| MinIO                      | single `minio_data` volume; farm and messaging persist object references in PostgreSQL                                                          | Critical binary payloads are outside the PostgreSQL recovery cut and have no version-bound off-site restore |
| Mosquitto                  | persistent local volume, 60-second autosave                                                                                                     | Device session/retained-message recovery semantics are not classified                                       |
| Monitoring                 | local Prometheus and Alertmanager volumes                                                                                                       | Historical incident evidence can be lost with the production host                                           |
| Backup evidence            | GitHub artifacts plus a versioned content-addressed Spaces mirror                                                                               | Versioning exists, but independent WORM retention and provider separation are not established               |
| Key recovery               | WAL-G libsodium epoch and logical-backup GPG escrow are documented                                                                              | Platform-wide key/CA/secret recovery is not expressed through one inventory and one drill                   |
| Release recovery           | source in GitHub and images in GHCR                                                                                                             | A GitHub or registry control-plane loss can block rebuilding a restored data plane                          |

The active registry already records production stop-lines. This plan consumes them instead of
inventing competing IDs:

- `INFRA-CRITICAL-040`: independent notary authority;
- `INFRA-CRITICAL-044`: secret-bearing SSH crosses mutable login-shell startup;
- `INFRA-HIGH-033`, `034`, `035`: continuous archive, complete restore verification, and repeated
  scheduled backup failure;
- `INFRA-HIGH-042`, `043`: unrestricted backup egress and PITR on the source droplet;
- `INFRA-HIGH-051`: restored-target checksums have no independently captured source parity set;
- `INFRA-HIGH-054`, `062`, `063`: mixed epochs, unchanged prefixes, and interrupted key
  materialization;
- `INFRA-HIGH-073`, `INFRA-CRITICAL-077`, `INFRA-CRITICAL-078`: bootstrap/deploy/host-lock and
  transport authority cycles.

No production DR claim may ignore an open or in-progress stop-line.

## Provider constraints that shape the design

- DigitalOcean documents Spaces as a partially S3-compatible service. Versioning is supported, but
  cross-region/cross-cluster copies are not; Spaces also states that it has no built-in backups.
  Therefore a second Spaces bucket in the same account is not the independent immutable copy:
  <https://docs.digitalocean.com/products/spaces/reference/s3-compatibility/> and
  <https://docs.digitalocean.com/products/spaces/details/limits/>.
- Spaces versioning is disabled by default and permanent version deletion remains possible to a
  sufficiently privileged identity:
  <https://docs.digitalocean.com/products/spaces/how-to/enable-versioning/>.
- MinIO replication documentation distinguishes version-preserving replication from `mc mirror`,
  which copies current bytes but does not preserve version history:
  <https://docs.min.io/aistor/administration/replication/site-replication/> and
  <https://docs.min.io/aistor/operations/failure-and-recovery/recover-after-site-failure/>.
- NATS provides stream backup/restore that includes stream configuration, consumer state, and
  messages. This is useful as acceleration and forensic evidence, but it does not replace the
  application outbox/event-store source:
  <https://docs.nats.io/running-a-nats-service/nats_admin/jetstream_admin/disaster_recovery>.
- Redis recommends both RDB and AOF when durability matters and recommends transferring RDB copies
  outside the physical host:
  <https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/>.

The independent immutable tier is a security-owned AWS account with S3 Object Lock `COMPLIANCE`
buckets split by retention class. It is administered separately from production and DigitalOcean.
S3 Object Lock prevents deletion of a retained object version, including by the root user, and
prevents shortening an existing compliance retention period:
<https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html>. Fixed sequence keys use
`If-None-Match: *` conditional writes as the split-brain compare-and-swap primitive:
<https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html>. Both behaviors are
frozen by executable AWS contract tests rather than documentation assumptions.

## Target architecture

```text
                           +-------------------------------+
                           | Data Protection Catalog SSOT  |
                           | assets, SLOs, dependencies,   |
                           | retention, verifiers, epochs  |
                           +---------------+---------------+
                                           |
                                  compile + sign
                                           |
                           +---------------v---------------+
 Operator / scheduler ---> | Recovery Control Plane       |
 dual control + OIDC       | fenced state machine         |
 offline root available    | exact recovery_cut_id        |
                           +---+-----------+-----------+---+
                               |           |           |
                    +----------v--+   +----v-----+  +--v----------------+
                    | PostgreSQL |   | Object   |  | Derived transports |
                    | WAL-G +    |   | versions |  | NATS/Redis/MQTT    |
                    | logical    |   | + hashes |  | replay/rebuild      |
                    +------+-----+   +----+-----+  +----------+----------+
                           |              |                   |
                    +------v--------------v-------------------v----------+
                    | Encrypted operational replica, versioned          |
                    +--------------------------+-------------------------+
                                               |
                                     one-way copy / replication
                                               |
                    +--------------------------v-------------------------+
                    | AWS WORM vault, security-owned account/admins      |
                    | no production delete, retention + legal hold       |
                    +--------------------------+-------------------------+
                                               |
                                      read-only restore identity
                                               |
                    +--------------------------v-------------------------+
                    | Isolated DR cell: restore, reconcile, verify, wipe |
                    +----------------------------------------------------+
```

### 1. Non-overlapping authorities

The architecture uses hash-linked bounded authorities instead of one document that duplicates every
kind of truth:

| Authority                  | Solely owned truth                                                              |
| -------------------------- | ------------------------------------------------------------------------------- |
| Existing Service Catalog   | service identity and runtime/deployment coordinates                             |
| Data Protection Catalog    | asset scope, owner, RPO/RTO, retention, recovery dependencies, and verifier     |
| Recovery Cut Manifest      | exact data, release, key, and replica coordinates for one recovery point        |
| Recovery Operation Journal | typed workflow transitions, fencing generation, and the operation evidence root |
| Recovery Safety Journal    | post-cut erasure, legal hold, revocation, key, and device-decommission truth    |

Every authority has a distinct schema and signing policy. References cross authority boundaries by
stable ID plus content hash; copied fields are rejected by the catalog compiler.

### 2. Data Protection Catalog

Add one versioned catalog, proposed at
`infrastructure/data-protection/catalog.yaml`, with a strict JSON Schema and exact-key validation.
Every record contains:

- stable `asset_id`, Service Catalog reference, owner, data classification, tenant scope, and
  legal-hold class;
- authoritative system and whether the asset is durable or derived;
- backup mechanism, operational destination, immutable destination, and credential profile;
- RPO, component RTO, complete-service RTO contribution, retention schedule;
- encryption algorithm, key authority, key epoch coordinate, escrow authority;
- recovery dependencies as a directed acyclic graph;
- cut collector, backup producer, restore handler, reconciliation verifier;
- source-parity proof and restored-target proof;
- evidence freshness and drill cadence;
- destructive-test fixture and cleanup authority;
- GDPR erase/crypto-shred behavior across retained copies.

Each catalog revision is signed by the retention/compliance owner. Numeric retention, legal-hold,
and erasure policy are mandatory: there is no default policy. A missing, expired, or unauthorized
signature makes readiness `RED`. Discovery performs bidirectional set equality against repository,
Compose/IaC, live cloud/runtime, and edge-fleet inventories. Unknown assets, duplicated mutation
authority, dependency cycles, and durable relationships without a verifier prevent compilation.

The compiler emits canonical JSON and is byte-idempotent. Two compilations of the same Git SHA and
inventory snapshot must have identical byte hashes; generated projections cannot contain wall-clock
timestamps, filesystem ordering, locale ordering, or provider-list ordering.

Generated or validated projections include:

- GitHub Environment secret profiles;
- workflow schedule and concurrency groups;
- monitoring rules and paging thresholds;
- runbook asset tables;
- recovery bundle membership;
- evidence evaluator requirements;
- retention/lifecycle configuration;
- service readiness dependencies.

A CI gate rejects:

- a persistent volume, entity-held object reference, secret epoch, or release artifact with no
  catalog entry;
- two mutation authorities for one asset;
- a durable asset marked as derived without a proven replay source;
- a recovery dependency cycle;
- an SLO with no scheduled drill capable of measuring it;
- a retention class with no legal-hold and erasure behavior;
- a workflow/runtime path that is not catalog-owned.

### 3. Recovery Control Plane

The single mutation authority is an offline-capable Rust appliance independent of application
runtimes and the production droplet. Its binary is reproducible; its OCI image is digest-pinned and
ships with SBOM and provenance. A 2-of-3 offline-root-signed TUF bootstrap bundle contains the
appliance, policy, schemas, trusted clocks/notaries, IaC, and release artifacts needed to start
without GitHub, GHCR, or the production droplet. GitHub Actions may request a ceremony but is never
required to authorize or execute one.

Required authority split:

| Identity                   | Allowed                                           | Forbidden                                                    |
| -------------------------- | ------------------------------------------------- | ------------------------------------------------------------ |
| Production backup writer   | append new backup objects and evidence candidates | delete versions, shorten retention, restore, administer WORM |
| Immutable-vault replicator | one-way append into named prefixes                | read application plaintext, delete, restore                  |
| Evidence notary            | attest object inventory and restore result        | author host claims, mutate backups                           |
| Restore reader             | read an exact approved recovery cut               | write backup stores, read unrelated epochs                   |
| Recovery controller        | advance the operation state machine               | access application user APIs, bypass verifier failures       |
| Retention administrator    | manage policy under dual control                  | possess production write or restore credentials              |
| Break-glass operators      | authorize a signed recovery request with quorum   | directly run database/object deletion commands               |

The controller stores no long-lived cloud secret. It exchanges workload identity for
operation-scoped credentials, binds them to `recovery_cut_id`, asset IDs, epoch, object prefix, and
expiry, then destroys the credentials after the operation.

Controller state is rebuilt from the signed Recovery Operation Journal, never from a unique
controller database. Each canonical RFC 8785/JCS record includes domain separation, schema version,
workflow profile, signer and key epoch, nonce, verifier digest, trusted timestamp, and `prev_hash`.
The appliance claims the next fixed sequence key with `If-None-Match: *`; an existing key is a CAS
failure and fences the competing controller. Every transition also carries the global monotonic
`recovery_generation`.

Journal ciphertext is appended to retention-class buckets in the security-owned AWS account. The
production writer can write client-side-encrypted ciphertext only to a fixed prefix and has no
list, read, delete, retention-change, KMS-decrypt, or KMS-policy permission. A restore reader
receives short-lived read/decrypt permission for exact object versions in one approved cut. An
independent notary uses separate credentials to verify those versions, retention mode/date, legal
hold, digest, and restore results. The journal is evidence of a transition; it cannot substitute for
directly observed data-plane proof.

### 4. Typed recovery workflows

One linear state machine cannot express qualification, recovery, rotation, and device workflows
without unsafe skip paths. The journal therefore carries one of these closed profiles:

- `CUT_QUALIFICATION`
- `RESTORE_DRILL`
- `FULL_PLATFORM_RECOVERY`
- `TENANT_RECOVERY`
- `EDGE_DEVICE_RECOVERY`
- `KEY_RECOVERY`
- `KEY_ROTATION`

Each profile has a versioned transition graph and terminal `FAILED` state. A failed operation cannot
be made successful; retry creates a new operation ID. `CANCELLED` is permitted only before cutover
and requires cleanup proof. Full recovery has distinct transitions for a source that is available,
already lost, or previously fenced, so source fencing is never a fictional universal precondition.

Transition preconditions:

- expected current state and operation nonce;
- signed authorization quorum;
- exact recovery bundle digest and release digest;
- asset-complete evidence set for one recovery-cut ID;
- no stale or mixed key epoch;
- source and target identities;
- independent notary verdict;
- cleanup evidence for every disposable resource.

Direct host scripts become narrow handlers called by the controller. They cannot publish readiness
or skip a state.

Full recovery increments `recovery_generation` before any replacement writer is enabled. Database
credentials, DNS, network policy, and every writer lease bind to that generation. An old primary
cannot regain write authority after the new generation is active, even if it later reconnects.

Key rotation is its own workflow:

```text
PREPARED -> ESCROW_ATTESTED -> REPLICA_VERIFIED -> ACTIVE -> RETIRED
```

No first write under a new epoch is permitted before escrow and replica verification. `RETIRED`
means the signed catalog retention and safety conditions have been met; it never deletes retained
ciphertext or a key still required by a qualifying cut or legal hold.

### 5. Recovery-cut protocol

A whole-platform recovery point is a content-addressed manifest, not a timestamp label. The
manifest binds:

- `recovery_cut_id` and creation time;
- exact Git commit, deployment release ID, OCI image digests, migration-head contract;
- PostgreSQL system identifier, timeline, LSN, base backup, WAL range, exported snapshot ID, and
  verification digest;
- every object bucket, logical content ID, SHA-256, size, encryption metadata, replication
  watermark, and replica-specific provider coordinates;
- key/CA/secret epoch IDs and escrow attestations, never secret values;
- outbox/event-store high-watermarks and required replay ranges;
- JetStream stream/consumer configuration digest and optional snapshot digest;
- Redis keyspace classification digest and optional RDB digest;
- MQTT retained/session classification and optional persistence digest;
- source-side parity set;
- catalog version and verifier versions.

The manifest is canonical JSON, signed by the controller and independently attested after the
immutable vault confirms object presence and retention.

#### Cross-store consistency

The architecture avoids a distributed freeze across PostgreSQL and object storage:

1. Object writes produce immutable versions and SHA-256 digests.
2. PostgreSQL stores bucket, object key, version ID, digest, size, and key epoch in the same
   transaction that makes an object visible to the domain.
3. The backup collector exports one PostgreSQL snapshot and enumerates exactly the object versions
   reachable from it.
4. The immutable vault proves that every reachable version exists before the cut qualifies.
5. Objects created but not referenced by the snapshot are harmless orphans and are excluded.
6. A database reference with no matching object version fails the cut and pages the owner.

Mutable object keys without a version ID are incompatible with complete recovery. Their migration
is a prerequisite for object-recovery readiness.

Provider version IDs are coordinates, not portable identities. `DurableObjectRefV1` binds the
logical content ID and SHA-256; each `ReplicatedObjectProofV1` binds that identity to the exact
MinIO, Spaces, or AWS bucket/key/version coordinates observed by an independent verifier.

### 6. Storage topology: 3-2-1-1-0

| Copy                         | Failure domain                                      | Mutability                  | Purpose                                           |
| ---------------------------- | --------------------------------------------------- | --------------------------- | ------------------------------------------------- |
| Source data plane            | production MinIO and PostgreSQL                     | live                        | application operation                             |
| Operational recovery replica | versioned DigitalOcean Spaces, separate credentials | append/versioned            | fast WAL, logical, object, and transport recovery |
| Independent immutable vault  | security-owned AWS account and administrators       | S3 Object Lock `COMPLIANCE` | ransomware, account, region, and insider recovery |

Additional rules:

- the AWS account has separate administrators and requires security/compliance quorum;
- each retention class has a bucket whose default is Object Lock `COMPLIANCE`;
- production identities have no delete or retention-change capability on the immutable vault;
- vault credentials are unavailable on the production droplet;
- retention reduction applies only to future catalog policy and can never shorten existing object
  versions;
- replication lag is measured per asset and included in RPO;
- lifecycle expiry cannot precede the longest catalog retention or legal hold;
- delete markers and non-current versions are included in inventory checks;
- monthly sampling downloads from both replica classes and verifies plaintext after controlled
  decryption;
- annual restore assumes loss of the primary provider account, GitHub, GHCR, and the production
  host simultaneously.

Real-account policy tests attempt production-writer list/read/delete, retention shortening,
KMS-decrypt, and KMS-policy mutation and require explicit denial. Restore-reader tests prove it
cannot read versions or prefixes outside the authorized cut. The independent notary observes with
its own credentials; it never accepts producer-supplied inventory as proof of AWS state.

Spaces remains the fast operational replica. Its lack of built-in backup and cross-region or
cross-cluster copy means it can never qualify as immutable authority.

### 7. Encryption and recoverable key authority

Use envelope encryption:

- per asset class and epoch, random DEKs encrypt backup payloads;
- a KMS/HSM-held KEK wraps DEKs;
- the recovery-cut manifest records key IDs and algorithms;
- an offline escrow stores encrypted recovery shares under two-person control;
- WAL-G, logical backup, object payload, evidence, and secret escrow use distinct keys and
  principals;
- rotation creates a new immutable prefix and epoch; it never overwrites an existing epoch;
- old keys remain recoverable exactly as long as their retained ciphertext and legal obligations;
- crypto-shred creates a signed tombstone and makes future restores apply erasure before any
  service becomes readable.

Key drills must prove:

1. primary KMS unavailable;
2. quorum recovers the approved epoch in an isolated HSM/KMS boundary;
3. a qualifying backup decrypts;
4. a wrong epoch fails closed;
5. recovered key material is destroyed;
6. the operation leaves a non-secret attestation.

CA roots, service certificates, password peppers, JWT keys, object credentials, database
credentials, and application encryption keys each need catalog entries. The preferred restore path
mints new leaf credentials from an escrowed root/authority. Copying live private-key directories is
not an acceptable secret backup.

### 8. Versioned contracts and API boundary

The public contract consists of:

- `DataProtectionCatalogV1`;
- `RecoveryCutManifestV1`;
- `RecoveryTransitionV1`;
- `RecoveryEvidenceV1`;
- `DurableObjectRefV1`;
- `ReplicatedObjectProofV1`;
- `TenantRecoveryPackageV1`;
- `SafetyEventV1`;
- `EdgeProtectionAttestationV1`.

Schemas use exact keys, explicit version discriminators, bounded strings/collections, canonical
serialization, and content hashes. Unknown fields, unknown enum members, and schema downgrades are
rejected.

The controller exposes only:

- `POST /v1/recovery-operations`;
- `POST /v1/recovery-operations/{id}/authorizations`;
- `GET /v1/recovery-operations/{id}`;
- `GET /v1/recovery-operations/{id}/evidence`.

There is no force, skip, arbitrary state patch, or backup-delete endpoint. The admin API's local
`pg_dump`, cron, `/backups`, delete, and false PITR authority are removed in the same runtime change
that introduces typed operation requests. The admin UI becomes a typed idempotent request client
and read-only evidence projection; legacy frontend wrappers are deleted without a compatibility
shim. That runtime PR carries a `BREAKING CHANGE:` footer and is distinct from this architecture
plan.

## Asset recovery contracts

### PostgreSQL and TimescaleDB

Keep the current WAL-G plus snapshot-bound logical companion design and finish its registered
stop-lines.

Required additions:

- source parity is captured independently from the restore target;
- the backup object inventory is attested by an authority that cannot forge host claims;
- PITR executes on separately trusted DR compute with no route or writable mount to production;
- backup egress is restricted to exact storage, identity, time, and DNS/IP policy;
- the recovery-cut manifest includes TimescaleDB extension version, hypertables, continuous
  aggregates, jobs, compression policies, roles, grants, RLS policies, functions, triggers,
  sequences, partitions, large objects, and migration heads;
- logical verification moves from a fixed sentinel subset to catalog-declared critical relations
  plus structural coverage of every relation;
- whole-cluster recovery and tenant-selective recovery use the same verified source cut.

Every durable relation carries a schema fingerprint, row count, and ordered or deterministically
sharded Merkle proof. A relation without source and restored-target proof makes the cut
`UNQUALIFIED`; sampling alone cannot qualify a P0/P1 relation.

PostgreSQL remains the durable authority for:

- tenant identity and schema ownership;
- event store and transactional outboxes;
- durable command and idempotency state;
- object-version references;
- recovery cut and erasure tombstones.

### Object data

The current single-node MinIO volume cannot remain the only copy of tenant documents and media.

Target contract:

- all protected buckets have versioning and deny unversioned writes;
- every persisted database reference carries immutable version ID and SHA-256;
- object bytes replicate continuously to the operational replica and independent WORM vault;
- bucket configuration, policies, retention, legal holds, encryption metadata, tags, and version
  history are backed up with the data;
- the restore selects exact versions from the recovery cut and verifies every digest;
- an object-reference reconciliation query reports missing, extra, wrong-version, wrong-tenant,
  and wrong-digest objects;
- cross-tenant prefixes and credentials are verified before read enablement;
- orphan cleanup cannot delete a version protected by a qualifying cut or legal hold.

MinIO is the source payload authority, versioned Spaces is the operational replica, and the AWS
Object Lock vault is the immutable replica. This topology is locked; `mc mirror` is not a substitute
for version-preserving replication.

All direct MinIO/S3 SDK access outside the platform storage adapter is rejected in CI. The adapter
implements one object-write protocol:

```text
INTENT_CREATED -> BYTES_VERIFIED -> REFERENCE_COMMITTED
```

The reference transaction cannot commit before byte digest, version coordinate, and replica policy
are verified. Recovery and reconciliation understand interrupted intents and never expose orphan
bytes as domain objects.

### Redis

The end state makes Redis disposable:

- authentication, refresh-token, authorization, command, outbox, and idempotency truth lives in
  PostgreSQL;
- cache keys are regenerated;
- rate-limit counters restart under an explicit conservative policy;
- revocation/security state rebuilds before authentication traffic is admitted;
- services fail closed while required rebuild watermarks are incomplete.

Execution begins with a keyspace inventory generated from code and runtime sampling. Each prefix is
classified as `CACHE`, `SECURITY_DERIVED`, `QUEUE_DERIVED`, or `DURABLE_VIOLATION`. A
`DURABLE_VIOLATION` blocks readiness until ownership moves to PostgreSQL or another cataloged
durable system.

During ownership migration, encrypted RDB snapshots are copied off-host and restore-tested. They
are safety evidence, not the end-state source of truth. Redis AOF remains restart durability and is
validated with `redis-check-aof`; RDB is validated with `redis-check-rdb`.

### NATS JetStream

JetStream is delivery infrastructure; PostgreSQL outbox/event-store is durable event authority.

Recovery contract:

- stream and consumer configuration is generated by the Data Protection Catalog compiler and
  applied only by the Recovery Control Plane;
- every publisher has a transactional outbox or another cataloged durable source;
- every consumer has durable inbox/idempotency handling for replay;
- recovery creates empty streams/consumers, then replays the exact event range after the restored
  high-watermark;
- duplicate, reordered, and interrupted replay tests prove convergence;
- the controller verifies pending outbox count, event-store continuity, consumer lag, DLQ state,
  and projection checksums before write traffic resumes.

Services start in recovery mode with external traffic denied. Consumer activation remains fenced
until replay and projection parity match the selected cut and active `recovery_generation`.

Until every subject proves reconstructability, `nats stream backup` snapshots are encrypted,
copied off-host, and tested. A subject that exists only in JetStream is a durable-ownership defect
and blocks the derived-state classification.

### Mosquitto

Inventory retained messages, persistent sessions, queued QoS messages, and inflight device
commands.

The target makes device commands durable in PostgreSQL with command ID, expiry, intent hash,
acknowledgement, and replay state. Retained configuration is reconstructed from PostgreSQL. A
server ACK is returned only after the complete command envelope commits to the PostgreSQL inbox.
After that proof, Mosquitto may restart empty and devices reconnect through normal session
establishment.

Any broker-only state remains protected by an encrypted persistence snapshot and a tested restore
until its durable owner is established. The controller never restores an expired actuator command.

### Edge devices and Aquamobil

Every SQLCipher/SQLite store in the Rust edge gateway, sensor-ingestion sidecar, and Aquamobil PWA
is cataloged individually as durable, derived, or provisional. A directory-level label is
insufficient.

- Unique offline edge segments are encrypted and content-addressed, then replicated to Spaces and
  the AWS WORM vault. `EDGE_DEVICE_RECOVERY` proves replacement-device restore.
- Sensor-ingestion disk policy snapshots qualify as derived only when byte-equivalent policy can be
  regenerated from the authoritative catalog/source release.
- Aquamobil caches are derived. Offline command and media journal entries carry a `LOCAL_ONLY` or
  `CLOUD_DURABLE` receipt.
- The cloud receipt is issued only after the command envelope is durable in the PostgreSQL inbox
  and required object bytes are committed through the storage adapter.
- An unreachable device or pending `LOCAL_ONLY` entry makes fleet-complete recovery
  `UNKNOWN/RED`. The central five-minute RPO is never reported as an endpoint-data RPO.

`EdgeProtectionAttestationV1` binds device identity, device generation, store inventory, last cloud
receipt, local-only count, content roots, key epoch, and verifier version without exporting
plaintext device data.

### Secrets, PKI, and configuration

Create an independently recoverable authority inventory:

- Git repository and signed tags;
- IaC state and provider coordinates;
- OCI images, SBOMs, signatures, and attestations by digest;
- database and storage schemas;
- secret-manager metadata and key epochs;
- offline CA/KMS recovery material;
- NATS, Redis, PostgreSQL, MQTT, and service identity issuance policy;
- DNS, TLS, and routing configuration;
- monitoring and paging configuration.

Mirror the signed recovery appliance, release bundle, images, SBOMs, and IaC into the immutable
vault. A database restore that depends on unavailable GitHub or GHCR content does not meet the RTO.

### Observability and audit evidence

Classify observability by value:

- security audit, access, backup, restore, key, and incident evidence is immutable protected data;
- Prometheus time series is operational history with a lower recovery tier;
- dashboards, rules, and Alertmanager configuration are rebuilt from Git/IaC;
- loss of the production host cannot erase evidence needed to investigate that loss.

Stream critical logs to the independent archive before local retention expiry. The recovery drill
verifies that alerts fire when backups stop, replication lags, evidence expires, or a restore fails.

### Recovery Safety Journal

Erasure, legal-hold placement/release, credential or certificate revocation, key destruction, and
device decommission events created after a recovery cut are appended to the independently signed
Safety Journal before their initiating API returns success. Every event has a stable subject,
monotonic safety sequence, effective time, catalog rule, signer epoch, and evidence digest.

A restore selects the latest independently witnessed safety watermark after the chosen cut and
replays safety events over restored data before any user traffic is enabled. Missing sequence
numbers, stale watermarks, invalid signatures, or an event that cannot be applied fail closed.
Recovery Safety Journal is a bounded recovery authority and does not reuse or depend on the
finding-event ledger.

## Recovery products

### Whole-platform disaster recovery

1. Declare incident scope and classify the source as reachable, lost, or previously fenced.
2. If reachable, fence production writes and prove the fence; if lost or previously fenced, prove
   the corresponding condition without fabricating a source action.
3. Select a qualifying recovery cut within business-approved data-loss bounds.
4. Authorize with two-person control.
5. Provision the isolated DR cell from the signed recovery appliance and IaC mirror.
6. Recover KMS/CA authority for the selected epochs.
7. Restore PostgreSQL to the exact timestamp and verify source parity.
8. Restore exact object versions and reconcile every database reference.
9. Rebuild NATS, replay outbox/event-store, and verify projections.
10. Rebuild Redis and Mosquitto derived state; apply conservative security defaults.
11. Restore/reissue service identities and start services in dependency order with external traffic
    blocked.
12. Apply the newest Safety Journal watermark after the cut.
13. Advance `recovery_generation` and bind database credentials, DNS, network, and writer leases.
14. Run schema, tenant, object, event, authorization, billing, telemetry, and audit invariants.
15. Obtain independent notary verdict and operator approval.
16. Enable read-only traffic, then bounded write traffic, then normal traffic.
17. Preserve incident evidence and prove disposable-resource cleanup.

### Single-tenant recovery

A tenant recovery never imports directly into production from an arbitrary dump.

1. Restore the complete source cut in an isolated cell.
2. Resolve the tenant closure from `auth.tenants`, `admin.tenant_schemas`, all tenant schemas,
   platform-owned cross-tenant rows, object versions, event streams, billing, audit, and legal holds.
3. Produce a signed tenant recovery package with row/object counts and checksums.
4. Verify no other tenant ID, object prefix, key, or event is present.
5. Import through typed db-migrate owner adapters into a new fenced namespace. Auth, billing,
   audit, event, object, and domain owners each emit their own closure proof.
6. Reconcile global references and object versions.
7. Run domain invariants and tenant isolation tests.
8. Switch the tenant mapping through one idempotent compare-and-swap only after approval; preserve
   the pre-CAS value and a tested rollback proof.
9. Keep the prior namespace read-only until the acceptance window closes, then apply catalog
   retention.

Point-in-time tenant recovery must explicitly address cross-tenant/global tables. A per-schema dump
alone is not a complete tenant recovery product.

### Edge-device recovery

An edge recovery package contains only the approved device's encrypted segments, policy/release
digests, key coordinates, cloud receipts, and Safety Journal watermark. Replacement hardware gets a
new device and `recovery_generation`; the retired device credential is revoked before the
replacement writer lease activates. Restore proves segment digests, command expiry rules, tenant
binding, duplicate replay safety, and absence of any other device's material.

## Recovery dependency order

The catalog compiles this graph and rejects cycles:

```text
offline trust roots
  -> recovery appliance + IaC + OCI artifacts
  -> network/DNS/private endpoints
  -> KMS/CA/secret authority
  -> PostgreSQL/TimescaleDB
  -> object payload versions
  -> migration and release verification
  -> NATS streams + outbox/event replay
  -> Redis/MQTT derived state
  -> auth/config/event-store
  -> domain services
  -> gateway and user traffic
  -> observability evidence closure
```

Services expose a recovery-readiness endpoint distinct from liveness/readiness. It returns green
only when the controller-provided cut ID matches the service's database, object, event, and key
watermarks.

## SLO and retention matrix

| Class                  | Examples                                                             |                                                    RPO |  Component RTO | Complete-service requirement     |
| ---------------------- | -------------------------------------------------------------------- | -----------------------------------------------------: | -------------: | -------------------------------- |
| P0 database authority  | tenant identity, billing, event store, outbox, audit, tenant schemas |                                                  5 min |         60 min | mandatory                        |
| P0 object payload      | farm documents, incident media, messaging attachments                |                                                  5 min |        120 min | mandatory                        |
| P0 key authority       | WAL-G/GPG/DEK epochs, CA roots, JWT/password encryption authorities  |               zero loss at committed rotation boundary |         60 min | mandatory                        |
| P1 telemetry           | sensor history and TimescaleDB aggregates                            |                                                  5 min |        120 min | mandatory for normal traffic     |
| P1 derived delivery    | NATS, Redis security state, MQTT command/session state               | zero durable loss relative to PostgreSQL replay source | 60 min rebuild | mandatory verifier               |
| P2 release/config      | Git, IaC, OCI, SBOM, signatures, DNS policy                          |                                  last approved release |         60 min | mandatory                        |
| P2 operational history | metrics and non-security logs                                        |                                                   24 h |            4 h | does not block read-only service |

Retention is data-class-driven, not tool-driven. The catalog maps each class to:

- operational restore window;
- immutable retention window;
- legal-hold override;
- non-current-version expiry;
- evidence retention;
- key-retention period;
- erasure/crypto-shred rule.

Every duration is numeric and owner-signed. The longest applicable signed legal or regulatory
requirement wins. A missing value, invalid signature, or lifecycle configuration shorter than the
catalog fails CI and runtime preflight; the compiler supplies no fallback.

## Verification architecture

### Source-side proof

Capture under one recovery cut:

- PostgreSQL schema inventory, migration heads, relation counts/checksums, Timescale metadata, and
  selected critical row Merkle roots;
- object inventory with version IDs and SHA-256;
- event-store and outbox high-watermarks;
- tenant registry/namespace bijection;
- key epoch and release identity;
- Redis/NATS/MQTT classification and rebuild watermarks.

Source proof must be signed by an authority separate from the restore target and compared by the
independent notary.

### Target-side proof

The isolated target recomputes the same proof, then adds:

- PostgreSQL recovery timeline and target-time proof;
- object-reference closure;
- no cross-tenant object or row leakage;
- successful event replay and projection parity;
- Redis/MQTT conservative startup state;
- application-level smoke tests using synthetic tenant identities;
- measured timings for every phase;
- cleanup result for networks, volumes, containers, credentials, and plaintext material.

### Negative and destructive tests

Every release of the recovery system tests rejection of:

- missing WAL segment or base backup;
- corrupted logical dump, object, RDB, stream snapshot, or evidence record;
- wrong system identifier, release, catalog, image, object version, checksum, or key epoch;
- mixed assets from two valid recovery cuts;
- deleted object version or retention downgrade;
- stale evidence;
- absent tenant schema or unregistered tenant namespace;
- source/target parity mismatch;
- NATS duplicate and interrupted replay;
- Redis durable key with no cataloged owner;
- expired MQTT command;
- cleanup identity race;
- operation-journal hash-chain break, duplicate sequence claim, or stale controller lease;
- catalog downgrade, expired owner signature, clock skew, or invalid trusted timestamp;
- stale `recovery_generation` writer, DNS, network, or database credential;
- unavailable primary provider, GitHub, GHCR, production host, or primary KMS;
- compromised production writer attempting to delete the immutable copy.

No verifier has a warning-only path for these conditions.

## Drill program

| Cadence         | Drill                                                                    | Required evidence                                             |
| --------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Every 5 minutes | machine qualification of WAL/object cut                                  | cut-bound lag, complete inventory, independent alert delivery |
| Daily           | full WAL-G backup plus logical companion and immutable copy confirmation | signed producer, vault, and notary records                    |
| Weekly          | isolated PostgreSQL PITR plus critical-object sample restore             | RPO/RTO, source parity, exact object versions                 |
| Monthly         | complete platform restore on independent compute                         | all assets, replay, reconciliation, service smoke, cleanup    |
| Quarterly       | provider/region loss and single-tenant recovery                          | primary provider unavailable, tenant closure proof            |
| Semiannual      | ransomware/credential-compromise exercise                                | production delete denied, clean-room recovery                 |
| Annual          | offline key/CA recovery and GitHub/GHCR loss                             | quorum, recovery appliance, image/IaC mirror, key destruction |

Each drill has a named incident commander, recovery operator, security approver, data verifier, and
independent observer. A missed or failed drill changes recovery readiness to red and pages the
owners.

Each five-minute cut is labeled `MACHINE_QUALIFIED` only after all machine checks pass. A weekly
sample earns `SAMPLED_RESTORE_QUALIFIED`; only the monthly complete drill earns
`FULL_RESTORE_QUALIFIED`. Qualification levels are monotonic evidence about the exact catalog
generation and cut, not aliases for one another.

## Monitoring and stop-lines

Page on:

- WAL archive age approaching 225 seconds or exceeding 300 seconds;
- backup or immutable replication lag beyond asset RPO;
- newest qualifying recovery cut age;
- WORM retention/versioning drift;
- object inventory or source-parity mismatch;
- three-copy count falling below the catalog minimum;
- key escrow or recovery drill expiry;
- missing signed release/IaC/image artifact;
- failed cleanup or residual plaintext;
- restore duration budget burn;
- any backup workflow failure, including preflight;
- open critical/high stop-line past its approved deadline.

Dashboards display coverage by asset, not job count. “Backup job green” cannot make the platform DR
panel green when MinIO, Redis classification, transport replay, keys, or release artifacts are
unverified.

## Threat model

| Threat                                 | Architectural control                                                      |
| -------------------------------------- | -------------------------------------------------------------------------- |
| Production root compromise             | one-way replication; no vault delete/retention authority on host           |
| Primary cloud account compromise       | security-owned AWS account/admin immutable vault                           |
| Ransomware encrypts source and replica | versioned WORM copy and clean-room restore                                 |
| Malicious operator deletes history     | dual control, compliance retention, independent notary                     |
| Backup operator forges success         | source, object-store, restore-target, and notary authorities split         |
| Backup is valid but key is lost        | cataloged escrow plus scheduled offline key recovery                       |
| Restore mixes epochs/cuts              | content-addressed recovery manifest and exact transition guards            |
| PostgreSQL restores but objects do not | version-bound object references and closure reconciliation                 |
| JetStream/Redis becomes hidden SSOT    | prefix/subject ownership inventory and readiness blocker                   |
| Provider outage blocks tooling         | recovery appliance, IaC, images, and trust roots in independent vault      |
| Corrupt backup remains unnoticed       | destructive isolated restore and zero-error qualification                  |
| GDPR erase resurrects data             | erasure tombstones, key destruction, restore-time erasure replay           |
| Legal hold data expires                | catalog-to-lifecycle invariant and dual-control hold release               |
| Restore harms production               | no route/writable mount, target identity fencing, immutable cleanup labels |

## Rejected designs

- More cron scripts per volume: duplicates authority and cannot prove cross-store consistency.
- Host volume snapshots as the primary method: same-host and crash-consistency blast radius.
- Spaces versioning as the immutable tier: privileged version deletion and same-account/provider
  failure remain.
- MinIO `mc mirror` as complete recovery: current bytes alone omit version history and metadata.
- Backing up Redis/NATS without classifying ownership: preserves hidden SSOTs instead of removing
  them.
- Treating JetStream as the event authority: conflicts with transactional outbox/event-store
  ownership and makes replay semantics ambiguous.
- Direct admin-api restore: application runtime lacks host, migration, object, and cutover authority.
- One giant encrypted archive: destroys independent verification, selective recovery, streaming,
  and asset-specific retention.
- Backup success inferred from upload metadata: does not prove decryptability, restorability,
  source parity, or RTO.
- Restore on the production droplet: shares capacity, trust, storage, and failure domain with the
  source.
- Human-only runbook gates: cannot prevent unsafe transitions.

## Implementation program

Dates are exit targets. A missed target preserves the stop-line and creates or updates a registered
finding with owner and evidence; it does not weaken an acceptance gate.

| Phase                             | Exit target | Owners                                       | Machine exit gate                                                                   |
| --------------------------------- | ----------- | -------------------------------------------- | ----------------------------------------------------------------------------------- |
| BR-0 — Authority inventory        | 2026-08-04  | architecture, infra, data, edge              | repo/cloud/runtime/edge set equality; zero unknown asset or duplicate mutator       |
| BR-1 — Trust/vault foundation     | 2026-08-14  | security, infra                              | AWS Compliance vault, offline root, escrow, and destructive IAM deny tests green    |
| BR-2 — Catalog/Rust controller    | 2026-08-21  | architecture, security                       | byte-idempotent compiler; workflow, CAS, crash, and rebuild tests have no bypass    |
| BR-3 — PostgreSQL/object closure  | 2026-08-28  | data, storage, service owners                | every durable relation and object version has source/target parity                  |
| BR-4 — Derived/edge normalization | 2026-09-04  | event, auth, sensor, edge, frontend          | empty Redis/NATS/MQTT rebuild; edge/PWA durability is visible and verified          |
| BR-5 — Recovery products          | 2026-09-11  | db-migrate, incident commander, asset owners | full, tenant, and device recovery pass safety-forward and generation-fencing gates  |
| BR-6 — Adversarial drills         | 2026-09-18  | security, SRE, compliance                    | provider loss, split-brain, corruption, key loss, and offline bootstrap drills pass |
| BR-7 — Continuous assurance       | 2026-09-25  | SRE, compliance                              | full, provider-loss, and offline-key drills are fresh on one catalog generation     |

### BR-0 — Authority inventory

**Owner:** platform architecture + infra + data + edge

**Exit target:** 2026-08-04

- ratify authority boundaries, the strict catalog schema, and signed ownership;
- inventory repo, cloud, runtime, edge fleet, persistent volumes, objects, relations, Redis
  prefixes, NATS subjects/consumers, MQTT state, keys, devices, and release artifacts;
- designate the Recovery Control Plane as the sole mutation authority and require removal of the
  admin tenant scheduler, local dumps, `/backups`, delete, and false PITR endpoints in the BR-2 API
  migration;
- register or re-baseline every gap with owner, due date, and evidence requirement.

**Exit gate:** bidirectional repo/cloud/runtime/edge discovery reports zero unknown asset, zero
orphan catalog entry, and zero duplicate mutation authority.

### BR-1 — Trust and vault foundation

**Owner:** security + infra

**Exit target:** 2026-08-14

- provision the separate security-owned AWS account and retention-class Object Lock `COMPLIANCE`
  buckets;
- implement one-way ciphertext writer, cut-scoped restore reader, independent notary, and quorum
  administration policies;
- create the 2-of-3 offline TUF root/bootstrap and independently held key/CA escrow;
- mirror signed appliance/release/IaC/OCI/SBOM/provenance material;
- execute real AWS denial tests for list/read/delete, retention shortening, KMS decrypt, and KMS
  policy mutation.

**Exit gate:** AWS Compliance retention, offline trust bootstrap, escrow recovery, and destructive
IAM deny tests are green.

### BR-2 — Catalog and Rust controller

**Owner:** platform architecture + security

**Exit target:** 2026-08-21

- implement signed `DataProtectionCatalogV1`, compiler, dependency graph, discovery equality, and
  canonical projections;
- build the reproducible Rust appliance and its typed workflow profiles;
- implement signed hash-chain journal rebuild, fixed sequence CAS, operation credentials, trusted
  timestamps, and global generation fencing;
- expose only the four versioned controller endpoints and remove legacy admin/UI backup authority
  in the same breaking API change;
- crash before and after every transition and property-test illegal transitions, duplicate
  requests, stale leases, split-brain, and state skips.

**Exit gate:** two compilations at one SHA are byte-identical; model, CAS, crash, and journal rebuild
tests find no path around an authorization, verifier, safety, or cutover guard.

### BR-3 — PostgreSQL and object closure

**Owner:** data + storage + service owners

**Exit target:** 2026-08-28

- bind WAL-G physical and snapshot logical backups to `RecoveryCutManifestV1`;
- record schema fingerprints, row counts, and ordered/sharded Merkle proofs for every relation;
- move PITR to isolated compute and close source/target parity, notary, egress, and cleanup gaps;
- enforce MinIO source, versioned Spaces replica, and AWS WORM replica;
- migrate object references and the three-state adapter protocol; reject direct SDK access in CI;
- integrate exact-version reconciliation, legal hold, and Safety Journal erasure.

**Exit gate:** every relation and reachable object has matching source/target proof; missing, extra,
wrong-version, wrong-tenant, wrong-digest, and unverified relations are zero.

### BR-4 — Derived and edge normalization

**Owner:** event + auth + sensor + edge + frontend

**Exit target:** 2026-09-04

- classify every Redis prefix, NATS subject/consumer, MQTT state, and SQLCipher/SQLite store;
- move durable violations into PostgreSQL-owned state;
- generate and controller-apply NATS configuration; enforce activation fences through replay parity;
- persist MQTT command intent/ACK/replay and enforce ACK-after-inbox-commit and expiry;
- replicate unique edge segments and implement device replacement recovery;
- expose Aquamobil `LOCAL_ONLY`/`CLOUD_DURABLE` receipts and fleet `UNKNOWN/RED` semantics.

**Exit gate:** empty Redis, NATS, and Mosquitto instances converge from the restored durable
authorities after duplicate, reordered, and interrupted replay; edge/PWA durability is complete and
independently verified or explicitly `UNKNOWN/RED`.

### BR-5 — Recovery products

**Owner:** db-migrate + incident commander + all asset owners

**Exit target:** 2026-09-11

- implement full-platform recovery for reachable, lost, and previously fenced sources;
- implement typed tenant owner adapters, signed packages, atomic mapping CAS, and rollback proof;
- implement edge-device recovery and decommission/replacement fencing;
- apply the newest Safety Journal watermark before traffic;
- prove old primary and device writers cannot write after generation advance.

**Exit gate:** full, tenant, and device products pass source/target parity, safety-forward replay,
isolation, cleanup, and generation-fencing tests.

### BR-6 — Adversarial drills

**Owner:** security + SRE + compliance

**Exit target:** 2026-09-18

- complete clean-room recovery with GitHub, GHCR, DigitalOcean source host, and primary KMS absent;
- inject split-brain controllers, stale generations, journal corruption, mixed cuts/epochs, clock
  skew, provider corruption, and key loss;
- exercise offline bootstrap, escrow quorum, production-writer compromise, and notary separation;
- verify cleanup and credential/plaintext destruction after every drill.

**Exit gate:** provider-loss, split-brain, corruption, key-loss, and offline-bootstrap drills pass;
central RPO is at most 300 seconds, PostgreSQL RTO at most 3,600 seconds, and complete-service RTO at
most 7,200 seconds.

### BR-7 — Continuous assurance

**Owner:** SRE + compliance

**Exit target:** 2026-09-25

- automate cut qualification and scheduled destructive drills;
- page on asset-level readiness, signature/evidence freshness, and stop-line age;
- publish a scorecard sourced only from catalog generation, cuts, journals, and direct verifier
  evidence;
- rotate named operators and exercise the offline ceremony.

**Exit gate:** full, provider-loss, and offline-key drills are green and fresh on the same catalog
generation; no P0/P1 asset lacks qualifying evidence.

## Definition of done

The program is complete only when all statements are true:

- the Data Protection Catalog covers every persistent or rebuild-critical asset;
- one Recovery Control Plane owns all backup/restore mutations;
- admin runtime backup/restore no longer competes with the control plane;
- catalog, cut, operation, and safety authorities are hash-linked without duplicated ownership;
- the Rust appliance bootstraps and rebuilds journal state without GitHub, GHCR, DigitalOcean, or
  the primary KMS;
- three copies across two failure domains exist for every P0/P1 protected asset;
- one copy is independently administered, immutable, geographically separate, and
  retention-enforced;
- PostgreSQL, object payload, keys, release artifacts, and critical evidence restore without the
  primary provider;
- Redis, NATS, and MQTT either rebuild from durable authorities or carry a cataloged, verified
  backup contract;
- whole-platform and tenant recovery both pass isolation and reconciliation;
- source parity and target parity match for the exact recovery cut;
- five-minute RPO, one-hour PostgreSQL RTO, and two-hour complete-service RTO are measured;
- legal holds survive recovery and erased tenant data is not resurrected;
- post-cut erasure, hold, revocation, key, and device-decommission events apply before traffic;
- a stale primary or edge device cannot write after `recovery_generation` advances;
- all disposable resources and plaintext material are positively proven removed;
- every backup/DR CRITICAL or HIGH stop-line is resolved with evidence;
- the latest scheduled drill is green and fresh;
- the readiness evaluator reports zero unknown assets, zero duplicate mutation authorities, zero
  unverified P0/P1 data, and zero unverified backup errors.

Anything less remains **not ready**.
