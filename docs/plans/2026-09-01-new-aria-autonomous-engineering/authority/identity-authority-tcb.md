# Identity, Authority ve TCB Sözleşmesi

[Authority index](INDEX.md) · Owners: S03-S05, S18, S25, S27-S29, S50, S58, S67.

## Canonical human identity

`HumanSubjectId` kapalı tuple'dır:

```text
issuer_uri + audience + subject_id + credential_epoch
```

- `issuer_uri` operator TCB allowlist'indeki exact HTTPS issuer'dır; alias kabul edilmez.
- `audience` exact `aquaculture-platform` değeridir; farklı audience aynı `sub` olsa da farklıdır.
- `subject_id` issuer'ın değiştirilemez `sub` claim'idir. Login, e-mail, görünen ad ve tenant/header
  kimlik değildir.
- `credential_epoch` revoke/rebind'de monotonik artar. Eski epoch bütün session, allowlist, grant ve
  resume cursor'larını geçersiz kılar.
- `SUPER_ADMIN` auth-service'in server-side role authority'sinden, `ModuleCode.ARIA` yine server-side
  entitlement authority'sinden çözülür. Browser claim/header bu iki conjunct'i mint edemez.

Workspace allowlist anahtarı
`(HumanSubjectId, WorkspaceId, binding_version, valid_from, revoked_at)` değeridir. Her access,
step-up ve live-channel revalidation current binding version'ı okur. Issuer collision, login/e-mail
rename, subject rebind, revoke ve stale binding deny üretir.

## Canonical repository ve workspace identity

Üç repository rolü farklı type'dır; string/remote adıyla birbirine atanamaz:

| Type                     | Authority alanları                                                   | Metadata-only alanlar                    |
| ------------------------ | -------------------------------------------------------------------- | ---------------------------------------- |
| `CodeRepositoryRef`      | provider host, immutable provider repository ID, configured base ref | owner/name, URL, local path, remote name |
| `StateRepositoryRef`     | provider host, immutable state repository ID/ref                     | URL, remote alias                        |
| `AuthorityRepositoryRef` | provider host, immutable authority repository ID/ref                 | `origin/main` gibi instance alias'ı      |

`RepositoryIdentity` ayrıca immutable `base_repository_id`, ayrı `head_repository_id`, fork parent
ID/lineage ve provider installation ID taşır. `WorkspaceId` operator-issued UUID'dir ve
`(tenant_id, code_repository_id, workspace_id)` composite unique/foreign-key bağıyla tutulur.
Path/URL/`origin`/owner-name kimlik değildir. D0 instance'ının configured authority ref'i
`origin/main` olsa da evidence canonical authority repository ID + resolved ref + exact SHA taşır.

Rename metadata günceller; transfer, visibility/fork-lineage değişimi, delete/recreate, provider
host veya installation suspend/remove/reinstall bütün effect'leri `FROZEN` yapar ve re-onboarding,
fresh allowlist/ruleset/evidence ister. Same-name new repository ID eski grant, artifact, lock veya
permit'i devralamaz. S04 resolver/value object authority'sini kurar; S09 yalnız onboarding
adapter'larını, S59 aynı resolver ile multi-repository collision proof'unu ekler.

## Canonical workload identity

`WorkloadSubjectId` şu doğrulanmış zincirin digest'idir:

```text
operator-PKI issuer + certificate CN + public-key fingerprint
+ pinned VM/workload attestation digest + worker registry ID + runtime UID
+ boot nonce + job ID + capability audience + issued/expiry + recovery epoch
```

Certificate live mTLS session'a, attestation nonce'a ve worker registry kaydına bağlanır. Declared
VM/UID/input claims authority değildir. Channel substitution, cert/attestation mismatch, cloned VM,
stale boot, wrong UID, cross-job replay ve old recovery epoch deny olur. Rotation old fingerprint'i
atomik revoke eder; outstanding effects reconcile edilmeden yeni identity resume edemez.

## Immutable issuer principals

Issuer ve consumer capability'leri kesişmez:

| Envelope           | Immutable issuer / prerequisite                                                                                           | Exclusive capability                                                | Consumer                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------- |
| Human step-up      | `aria-human-grant-issuer` + current user reauthentication                                                                 | KMS `stepup-sign-v1`; yalnız `issue_human_grant` DB procedure       | named operation handler |
| Low-risk permit    | `aria-low-permit-issuer` + admitted independent dossier/attestation                                                       | KMS `low-permit-sign-v1`; yalnız `issue_low_permit`                 | `merge-authority`       |
| Medium-risk permit | `aria-medium-permit-issuer` + exact 3-of-3 `security-authority`, `release-authority`, `domain-owner-authority` signatures | KMS `medium-permit-sign-v1`; quorum doğrulayan tek insert procedure | `merge-authority`       |

Issuer services sekiz runtime rolünden ayrıdır ve operator-owned TCB içindedir. Assembler quorum oyu
veremez. Envelope; issuer, audience, human/workload subject, provider host, base/head repository IDs,
workspace, PR, base ref/SHA, head SHA, full diff, effect ID, payload/options, risk/policy,
dossier/attestation/ruleset/check-review digest'leri, nonce, issued/expiry ve recovery epoch taşır.
Issuer=consumer, producer=approver, unknown/below-quorum issuer ve direct ledger insert DB policy ile
imkânsızdır. Consume ve exact `INTENDED` effect insert tek serializable transaction'dır.

## Sekiz runtime rolünün immutable sınırı

Yeni ARIA production droplet'a schedule edilmez. `aria-control-vm` control-plane; ayrı
`aria-worker-vm` CLI/execution failure domain'idir. Sayısal UID'ler image ve deployment manifestte
pinlenir, pairwise unique'dir:

| Rol               | Host / UID         | Secret ve mount                      | Authenticated RPC / egress | Tek capability         |
| ----------------- | ------------------ | ------------------------------------ | -------------------------- | ---------------------- |
| `control`         | control VM / 21001 | scoped DB socket; no provider/GitHub | browser gateway, scheduler | command/current-state  |
| `scheduler`       | control VM / 21002 | lease-only DB socket                 | executor admission         | due-job claim/fence    |
| `broker-codex`    | worker VM / 22001  | Codex auth socket; job RO snapshot   | Codex allowlist            | normalized Codex call  |
| `broker-claude`   | worker VM / 22002  | Claude auth socket; job RO snapshot  | Claude allowlist           | normalized Claude call |
| `executor`        | worker VM / 22003  | job capability; RW ephemeral volume  | authenticated broker/CAS   | sandbox tool execution |
| `publisher`       | control VM / 21003 | narrowed installation token tmpfs    | exact GitHub repository    | branch/PR/check        |
| `policy-attestor` | control VM / 21004 | signing handle, policy RO            | evidence/CAS admission     | typed attestation      |
| `merge-authority` | control VM / 21005 | Merge App token + permit consume     | async merge endpoint only  | exact merge effect     |

Her rolün image digest'i, service account/mTLS CN, UID/GID, read-only rootfs, mount allowlist,
secret class, NetworkPolicy/firewall, seccomp/Linux capabilities, CPU/RAM/PID/disk/inode/I/O/DB-pool
limit'i ve rotation/revocation owner'ı operator manifestinde zorunludur. Pairwise eşitlik, ambient
credential, shared home/socket, writable sibling mount, wildcard egress veya extra Linux capability
gate'i durdurur. CLI child ayrıntısı [execution contract](execution-supply-chain.md)'tadır.

## Protected TCB ve tests

Policy roots, identity/issuer bindings, role/deployment manifests, risk taxonomy, required checks,
GitHub rules, KMS/data keys, step-up/permit policy, evidence verifier/admission, recovery epoch,
kill policy ve release policy operator-owned'dır. ARIA bunları yazamaz, activate edemez veya kendi
verdict'iyle değiştiremez.

S04/S08 identity negatives; S18/S27 workload mismatch; S28/S50/S58 issuer/direct-insert/concurrent
consume; S25/S31 repository lifecycle; S67 single-role compromise ve rotation testleri mandatory'dir.
Bir authority edge'i veya principal çıkarıldığında gate fail etmelidir.
