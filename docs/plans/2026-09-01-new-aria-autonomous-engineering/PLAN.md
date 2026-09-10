# Yeni ARIA Otonom Mühendislik Programı

- **Program ID:** `new-aria-autonomous-engineering`
- **Tarih:** 2026-09-01
- **Durum:** D0 `VERIFYING`; PR merge edilmedi
- **Program tabanı:** `origin/main@eeb401131260fe45f3f60be55fa25d023a082d18`
- **Design authority:**
  [`../../superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md`](../../superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md)
- **Finding authority:** [`FINDING-COVERAGE.md`](FINDING-COVERAGE.md)
- **Normative contracts:** [`authority/INDEX.md`](authority/INDEX.md)
- **Machine relationship authority:**
  [`verification/program-map.jsonl`](verification/program-map.jsonl)
- **Binding review:** [`reviews/INDEX.md`](reviews/INDEX.md) — `CHANGES_REQUIRED` at `c6065d6d...`
- **Corrective mappings:** [`round 1`](CORRECTIVE-NOTE.md) · [`round 2`](CORRECTIVE-ROUND-2.md)
- **İnsan görünümü:** [`PROGRESS.md`](PROGRESS.md)
- **Makine authority:** [`progress/events.jsonl`](progress/events.jsonl) ve
  [`progress/evidence/`](progress/evidence/)

## Program kararı ve hard constraints

D0 yalnız dokümantasyondur; product code D0 incelenip merge edilmeden başlayamaz. Yeni ARIA, legacy
ARIA'yı değiştirmez, import etmez veya runtime/data dependency yapmaz. Legacy path'ler yalnız frozen
audit/karşılaştırma girdisidir. Tek backend root `apps/aria-service`, core `src/kernel`; frontend
`web/modules/aria`, route `/aria`, federation `ariaModule`, port `5179` olacaktır.

Postgres ve object store bağımsızdır. NATS kullanılırsa cert-only identity geçerlidir; Kafka ve
token/user-password identity yasaktır. Provider'lar yalnız Codex CLI ve Claude Code CLI
subscription'dır; API fallback yoktur. TCB operator-owned'dır ve ARIA tarafından değiştirilemez.
İnsan release/deploy gate'i kalır. High-risk activation bu programda yasaktır.

Okunabilirlik acceptance'tır: cohesive single-responsibility modül hedefi `<=250` fiziksel satır,
`>400` hard gate; function/complexity/intra-project dependency ve governed generated exception'ın
numeric authority'si
[`verification/readability-policy.json`](verification/readability-policy.json)'dır. Migration
semantic/complexity review'den muaf değildir.

## Durum, kanıt ve kapanış sözleşmesi

Sprint state'i yalnız `PLANNED -> READY -> IN_PROGRESS -> VERIFYING -> DONE`; side state'ler
`BLOCKED`, `SUPERSEDED`. `events.jsonl` append-only, hash-chained authority'dir. Referenced evidence
manifest immutable'dır; her review/admission yeni versioned manifest + yeni event ekler. Hash
canonicalization, exact verifier provenance ve type-specific freshness
[`authority/verification-evidence.md`](authority/verification-evidence.md)'de normatiftir.
`PROGRESS.md` yalnız executable generator projection'ıdır.

Her sprint isolated branch/worktree kullanır. Red test uygulamadan önce yerelde gözlenir, commit'e
girmez. Her commit green iken push edilir. Final note: done, remaining, exact tests, reviewed
head/PR, findings, risks ve next action taşır. Commit kendi SHA'sını içeremediği için evidence
reviewed implementation SHA'yı bağlar. Merge sonrası ayrı operator repository dışında bir
`external signed operator readback` üretir; ikinci repository commit/PR veya reviewed source/head
mutasyonu yasaktır. Evidence yoksa `DONE` yoktur. Merged-only finding `VERIFYING`; yalnız exact
deployed SHA için current `live_proven` evidence varsa `SOLVED` olur.

Proof class'ları `code_proven`, `live_proven`, `operator_attested`. Her kayıt canonical authority
repository/ref reachability, immutable input/tool/verifier/report digests, exact argv/tool version,
UTC/result, typed freshness/invalidators, negatives ve findings içerir. `origin/main` yalnız bu D0
instance alias'ıdır. Producer kendi artifact/evidence/admission'ını onaylayamaz.

## Acceptance ID kataloğu

| ID                  | Program acceptance                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `ACC-D0-001`        | D0 yalnız izinli docs/manifest değişikliği içerir; legacy path diff'i sıfırdır ve state `VERIFYING` kalır.                     |
| `ACC-ISO-001`       | Legacy runtime/state/code bağımlılığı, shared write veya shared authority yoktur.                                              |
| `ACC-EVD-001`       | Claim exact SHA, authority digest, bağımsız reviewer/oracle ve gerekli negative control ile kabul edilir.                      |
| `ACC-TCB-001`       | ARIA operator-owned TCB'yi yazamaz, aktive edemez veya admission verifier'ını etkileyemez.                                     |
| `ACC-SEP-001`       | Producer/publisher/attestor/merge/release authority farklı identity ve capability'dir.                                         |
| `ACC-READ-001`      | Numeric file/function/complexity ve intra-project dependency policy; provenance/owner/expiry'li generated exception uygulanır. |
| `ACC-LIVE-001`      | `SOLVED` yalnız exact deployed SHA ve fresh `live_proven` evidence ile mümkündür.                                              |
| `ACC-REL-001`       | Human release/deploy gate'i korunur; Merge App bypass permission taşımaz.                                                      |
| `ACC-NOHR-001`      | High-risk execution/merge disabled kalır ve aktivasyon yeni onaylı program ister.                                              |
| `ACC-S01`–`ACC-S72` | İlgili sprint kartındaki bounded deliverable, test, evidence ve exit predicate birlikte sağlanır.                              |

Acceptance öğeleri phase kartlarına bölünse de kaybolamaz: `ACC-Snn` authority'si ilgili karttır; bu
indeks ID, objective, dependency ve acceptance bağını eksiksiz listeler.

## Operator prerequisite'leri

| ID      | Sahip / gerekli kanıt                                                                                                     | Gate                                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `OP-01` | Platform Security: exact App/install/repo/token permissions ve effective ruleset/bypass authority                         | S25, S31, S52                            |
| `OP-02` | Platform Ops: dedicated control + worker VM, per-role UID/network/resource isolation                                      | S18, S24, S41                            |
| `OP-03` | Security: complete issuer/voter/assembler topology, PKI/KMS/procedure bindings, collision oracle, rotation/recovery epoch | S04, S05, S18, S27, S28, S50, S58, S67   |
| `OP-04` | Data Ops: `aria` Postgres/CAS, envelope keys, cross-account/region backup ve recovery epoch                               | S03, S23, S41, S45, S61, S68             |
| `OP-05` | AI Ops: complete `ToolchainManifest`, clean-build/signer admission, CLI subscriptions ve live limits                      | S14, S20, S21                            |
| `OP-06` | Release/Incident Owner: paging/ack, human deploy/release, rollback ve on-call authority                                   | S39, S41, S43, S54, S55, S69             |
| `OP-07` | SRE: measured headroom/SLO/RPO/RTO, quotas, burn-in ve drill freshness manifest                                           | S39, S41, S44, S47-S48, S55-S56, S61-S64 |
| `OP-08` | Privacy/Legal: DLP, retention/capture, hold/delete authority ve proof surface manifest                                    | S14, S23, S39, S61                       |

Eksik prerequisite ilgili sprint'i `BLOCKED` yapar; scope küçülterek veya sahte evidence ile gate
geçilmez.

## Phase dependency ve promotion akışı

```text
D0 VERIFYING
  -> P01 READ_ONLY_SHELL
  -> P02 DISCOVERY_PLAN_ONLY
  -> P03 EXECUTE_NO_PUSH
  -> P04 PR_OPEN (merge disabled)
  -> P05 ADVERSARIAL_VALIDATED
  -> P06 SHADOW -> PR_ONLY
  -> P07 MERGE_CANARY (low-risk)
  -> P08 MEDIUM_BOUNDED
  -> P09 HIGH_RISK_READINESS_ONLY (activation disabled)
```

Her ok, önceki phase evidence seal'i ve sıfır unresolved load-bearing challenge ister. Side-state
bir promotion değildir.

## Trust/authority matrisi

| İşlem               | Üretici            | Deterministic/bağımsız kontrol        | Yetkili principal           | İnsan sınırı           |
| ------------------- | ------------------ | ------------------------------------- | --------------------------- | ---------------------- |
| Plan/artifact       | executor + broker  | test oracle + challenger              | policy-attestor admission   | high-risk plan onayı   |
| Branch/PR/check     | publisher          | exact SHA/read-after-write            | Publisher App               | branch protection      |
| Merge dossier       | control            | policy-attestor + quorum              | operator-owned policy       | risk taxonomy          |
| Human step-up issue | external issuer    | reauth + exact preview/policy         | `aria-human-grant-issuer`   | human subject          |
| Low permit issue    | external issuer    | admitted dossier/attestation          | `aria-low-permit-issuer`    | operator TCB           |
| Medium permit issue | external assembler | 3-of-3 security/release/domain quorum | `aria-medium-permit-issuer` | all three authorities  |
| Merge effect        | merge-authority    | permit consume + base lock + readback | Merge App, no bypass        | low/medium bounds      |
| Release/deploy      | yok                | exact merged/deployed SHA evidence    | release owner               | her zaman insan        |
| TCB/policy değişimi | ARIA değil         | protected review/check manifest       | operator/security           | ayrı onaylı değişiklik |

## 9 phase / 72 sprint authority index

### P01 — Trust boundary and read-only shell

Detay: [`phases/P01.md`](phases/P01.md)

| Sprint | Objective                                                                         | Dependency                    | Acceptance                               |
| ------ | --------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------- |
| S01    | Progress event/evidence schema, projection contract ve false-completion invariant | D0 merge ve reviewed baseline | `ACC-S01`, `ACC-EVD-001`                 |
| S02    | Inert Nx/NestJS `aria-service` scaffold ve kernel boundaries                      | S01                           | `ACC-S02`, `ACC-READ-001`, `ACC-ISO-001` |
| S03    | Bağımsız Postgres/object-store schema, migration ve repository contracts          | S02, `OP-04`                  | `ACC-S03`, `ACC-ISO-001`, `ACC-EVD-001`  |
| S04    | Immutable identities, access predicate ve workspace allowlist                     | S03, `OP-03`                  | `ACC-S04`, `ACC-TCB-001`                 |
| S05    | Protected TCB/policy registry, risk taxonomy, non-self-modification               | S04, `OP-03`                  | `ACC-S05`, `ACC-TCB-001`                 |
| S06    | Read-only GraphQL overview/status/timeline surfaces                               | S03-S05                       | `ACC-S06`, `ACC-ISO-001`                 |
| S07    | Federated read-only ARIA web shell/status/result views                            | S06                           | `ACC-S07`, `ACC-READ-001`, `ACC-ISO-001` |
| S08    | P01 adversarial review, restore/fail-closed gate ve evidence seal                 | S01-S07                       | `ACC-S08`, `ACC-EVD-001`, `ACC-ISO-001`  |

### P02 — Read-only discovery and planning

Detay: [`phases/P02.md`](phases/P02.md)

| Sprint | Objective                                                        | Dependency            | Acceptance                              |
| ------ | ---------------------------------------------------------------- | --------------------- | --------------------------------------- |
| S09    | Portable onboarding ve canonical repository/workspace IDs        | S08                   | `ACC-S09`, `ACC-ISO-001`                |
| S10    | Repository inventory ve immutable snapshot/digest discovery      | S09                   | `ACC-S10`, `ACC-EVD-001`                |
| S11    | Provenance/dedupe bağlı finding/candidate discovery              | S10                   | `ACC-S11`, `ACC-EVD-001`                |
| S12    | Dependency, recursive-impact ve affected-surface graph           | S10-S11               | `ACC-S12`, `ACC-EVD-001`                |
| S13    | Execution olmadan mission planı ve acceptance/test synthesis     | S11-S12               | `ACC-S13`, `ACC-EVD-001`, `ACC-TCB-001` |
| S14    | Pre-call cost reservation, retention/DLP ve provider feasibility | S13, `OP-05`, `OP-08` | `ACC-S14`, `ACC-EVD-001`                |
| S15    | Durable conversation, question/answer ve mission-draft workflow  | S13-S14               | `ACC-S15`, `ACC-ISO-001`                |
| S16    | P02 adversarial read-only/no-side-effect proof                   | S09-S15               | `ACC-S16`, `ACC-EVD-001`, `ACC-ISO-001` |

### P03 — Isolated coding and TDD, no push

Detay: [`phases/P03.md`](phases/P03.md)

| Sprint | Objective                                                    | Dependency                     | Acceptance                              |
| ------ | ------------------------------------------------------------ | ------------------------------ | --------------------------------------- |
| S17    | Durable job/attempt/lease/effect protocol                    | S16                            | `ACC-S17`, `ACC-EVD-001`                |
| S18    | Separate worker VM, mTLS identity ve confinement             | S17, `OP-02`, `OP-03`          | `ACC-S18`, `ACC-SEP-001`                |
| S19    | Worktree/path containment, cleanup safety ve escape tests    | S18                            | `ACC-S19`, `ACC-ISO-001`                |
| S20    | Codex CLI normalized broker, no API fallback                 | S17-S19, `OP-05`               | `ACC-S20`, `ACC-SEP-001`                |
| S21    | Claude Code CLI normalized broker, no API fallback           | S17-S20, `OP-05`               | `ACC-S21`, `ACC-SEP-001`                |
| S22    | Executable red-green-refactor evidence ve exact target SHA   | S20-S21                        | `ACC-S22`, `ACC-EVD-001`                |
| S23    | Artifact admission, secret/SSRF/exfiltration/budget controls | S14, S19-S22, `OP-04`, `OP-08` | `ACC-S23`, `ACC-EVD-001`                |
| S24    | `EXECUTE_NO_PUSH` adversarial pressure/recovery gate         | S17-S23, `OP-02`               | `ACC-S24`, `ACC-EVD-001`, `ACC-SEP-001` |

### P04 — PR delivery and separated authorities

Detay: [`phases/P04.md`](phases/P04.md)

| Sprint | Objective                                                      | Dependency   | Acceptance                              |
| ------ | -------------------------------------------------------------- | ------------ | --------------------------------------- |
| S25    | Least-privilege Publisher App ve durable token lease           | S24, `OP-01` | `ACC-S25`, `ACC-SEP-001`                |
| S26    | PR/check create/update/reconcile, merge rights yok             | S25          | `ACC-S26`, `ACC-REL-001`                |
| S27    | Typed independent attestations ve producer/reviewer separation | S26, `OP-03` | `ACC-S27`, `ACC-SEP-001`, `ACC-EVD-001` |
| S28    | Operation/workspace/SHA/payload/policy-bound step-up grants    | S27, `OP-03` | `ACC-S28`, `ACC-TCB-001`, `ACC-SEP-001` |
| S29    | Policy-attestor, deterministic admission ve fail-closed schema | S27-S28      | `ACC-S29`, `ACC-TCB-001`, `ACC-SEP-001` |
| S30    | Merge-evaluation dossier; merge execution yok                  | S26-S29      | `ACC-S30`, `ACC-REL-001`, `ACC-EVD-001` |
| S31    | Async merge effect protocol/readback, execution disabled       | S30, `OP-01` | `ACC-S31`, `ACC-EVD-001`, `ACC-REL-001` |
| S32    | `PR_OPEN` gate; merge disabled                                 | S25-S31      | `ACC-S32`, `ACC-SEP-001`, `ACC-REL-001` |

### P05 — Adversarial validation

Detay: [`phases/P05.md`](phases/P05.md)

| Sprint | Objective                                                          | Dependency                         | Acceptance                              |
| ------ | ------------------------------------------------------------------ | ---------------------------------- | --------------------------------------- |
| S33    | Twelve specialist roles/capabilities/conflict graph                | S32                                | `ACC-S33`, `ACC-SEP-001`                |
| S34    | Producer/challenger/judge/appellate separation ve quorum           | S33                                | `ACC-S34`, `ACC-SEP-001`, `ACC-EVD-001` |
| S35    | Deterministic oracle, typed verdict, NaN/bool/malformed reject     | S34                                | `ACC-S35`, `ACC-EVD-001`                |
| S36    | Mutation/fault/corruption/crash/replay campaign                    | S35                                | `ACC-S36`, `ACC-EVD-001`                |
| S37    | Evidence completeness ve semantic coverage witnesses               | S35-S36                            | `ACC-S37`, `ACC-EVD-001`                |
| S38    | 88 audit finding'i executable regression/evidence programına bağla | S37                                | `ACC-S38`, `ACC-EVD-001`                |
| S39    | Observability, incident capture, retention/redaction/kill switch   | S36-S38, `OP-06`, `OP-07`, `OP-08` | `ACC-S39`, `ACC-TCB-001`, `ACC-EVD-001` |
| S40    | Adversarial gate; unresolved load-bearing challenge sıfır          | S33-S39                            | `ACC-S40`, `ACC-EVD-001`, `ACC-SEP-001` |

### P06 — Shadow and PR_ONLY operation

Detay: [`phases/P06.md`](phases/P06.md)

| Sprint | Objective                                                          | Dependency                              | Acceptance                              |
| ------ | ------------------------------------------------------------------ | --------------------------------------- | --------------------------------------- |
| S41    | Independent-state shadow control plane, write yok                  | S40, `OP-02`, `OP-04`, `OP-06`, `OP-07` | `ACC-S41`, `ACC-ISO-001`                |
| S42    | Legacy outcome salt-okunur karşılaştırması, coupling yok           | S41                                     | `ACC-S42`, `ACC-ISO-001`                |
| S43    | `PR_ONLY`; PR create/update var, merge yok                         | S41-S42, `OP-06`                        | `ACC-S43`, `ACC-REL-001`, `ACC-TCB-001` |
| S44    | Quota/concurrency/reservation/circuit breaker/host protection      | S43, `OP-07`                            | `ACC-S44`, `ACC-EVD-001`                |
| S45    | Crash/replay/lease/reconcile/disaster restore                      | S41-S44, `OP-04`                        | `ACC-S45`, `ACC-EVD-001`                |
| S46    | Operator UI: mission/conversation/timeline/evidence/policy/control | S43-S45                                 | `ACC-S46`, `ACC-READ-001`               |
| S47    | Sustained shadow/PR_ONLY burn-in ve FP/FN review                   | S41-S46, `OP-07`                        | `ACC-S47`, `ACC-LIVE-001`               |
| S48    | Burn-in gate; current evidence olmadan merge promotion yok         | S47, `OP-07`                            | `ACC-S48`, `ACC-EVD-001`, `ACC-REL-001` |

### P07 — Low-risk autonomous merge

Detay: [`phases/P07.md`](phases/P07.md)

| Sprint | Objective                                                 | Dependency                | Acceptance                              |
| ------ | --------------------------------------------------------- | ------------------------- | --------------------------------------- |
| S49    | Protected low-risk taxonomy ve classifier                 | S48                       | `ACC-S49`, `ACC-TCB-001`                |
| S50    | Single-use autonomous merge permit issue/consume          | S49, `OP-03`              | `ACC-S50`, `ACC-SEP-001`, `ACC-TCB-001` |
| S51    | Per-base serialization/idempotency/duplicate-effect proof | S50                       | `ACC-S51`, `ACC-EVD-001`                |
| S52    | Merge execution, 202/409 ve read-after-write reconcile    | S51, `OP-01`              | `ACC-S52`, `ACC-REL-001`, `ACC-EVD-001` |
| S53    | Exact merged/deployed SHA outcome ve `SOLVED` semantics   | S52                       | `ACC-S53`, `ACC-LIVE-001`               |
| S54    | Rollback/revert/stop/page ve human release boundary       | S52-S53, `OP-06`          | `ACC-S54`, `ACC-REL-001`                |
| S55    | Low-risk canary cohort ve supervised outcome evidence     | S49-S54, `OP-06`, `OP-07` | `ACC-S55`, `ACC-LIVE-001`               |
| S56    | `MERGE_CANARY` rollback/restore/capacity gate             | S55, `OP-07`              | `ACC-S56`, `ACC-EVD-001`, `ACC-REL-001` |

### P08 — Bounded medium risk and portability

Detay: [`phases/P08.md`](phases/P08.md)

| Sprint | Objective                                               | Dependency                     | Acceptance                               |
| ------ | ------------------------------------------------------- | ------------------------------ | ---------------------------------------- |
| S57    | Protected medium-risk taxonomy/prohibited boundary      | S56                            | `ACC-S57`, `ACC-TCB-001`, `ACC-NOHR-001` |
| S58    | Bounded multi-authority medium-risk authorization       | S57, `OP-03`                   | `ACC-S58`, `ACC-SEP-001`, `ACC-TCB-001`  |
| S59    | Multi-repository onboarding ve identity collision tests | S58                            | `ACC-S59`, `ACC-ISO-001`                 |
| S60    | Portable config/package/runtime deployment contract     | S59                            | `ACC-S60`, `ACC-READ-001`, `ACC-ISO-001` |
| S61    | Backup/PITR/object recovery/regional rebuild drills     | S60, `OP-04`, `OP-07`, `OP-08` | `ACC-S61`, `ACC-LIVE-001`                |
| S62    | Loaded capacity/queue/SLO/rate/cost envelopes           | S60-S61, `OP-07`               | `ACC-S62`, `ACC-LIVE-001`                |
| S63    | Supervised medium-risk burn-in ve outcome minimums      | S57-S62, `OP-07`               | `ACC-S63`, `ACC-LIVE-001`, `ACC-SEP-001` |
| S64    | Medium-risk promotion ve portability gate               | S63, `OP-07`                   | `ACC-S64`, `ACC-EVD-001`, `ACC-NOHR-001` |

### P09 — High-risk readiness only, activation prohibited

Detay: [`phases/P09.md`](phases/P09.md)

| Sprint | Objective                                                        | Dependency   | Acceptance                               |
| ------ | ---------------------------------------------------------------- | ------------ | ---------------------------------------- |
| S65    | High-risk surface discovery/classification, execution yok        | S64          | `ACC-S65`, `ACC-NOHR-001`                |
| S66    | Protected prohibited categories/non-bypass/policy ownership      | S65          | `ACC-S66`, `ACC-NOHR-001`, `ACC-TCB-001` |
| S67    | Threat model/abuse cases/authority-compromise drills             | S66, `OP-03` | `ACC-S67`, `ACC-EVD-001`, `ACC-SEP-001`  |
| S68    | Disaster/credential revoke/provider outage/recovery exercises    | S67, `OP-04` | `ACC-S68`, `ACC-LIVE-001`                |
| S69    | Human release gate ve exact deployed SHA proof under pressure    | S68, `OP-06` | `ACC-S69`, `ACC-REL-001`, `ACC-LIVE-001` |
| S70    | Fresh twelve-agent full-system audit ve appellate review         | S65-S69      | `ACC-S70`, `ACC-EVD-001`, `ACC-SEP-001`  |
| S71    | Signed go/no-go dossier, unresolved risks/operator prerequisites | S70          | `ACC-S71`, `ACC-NOHR-001`, `ACC-EVD-001` |
| S72    | Program closeout; low/medium bounds kayıtlı, high-risk disabled  | S71          | `ACC-S72`, `ACC-NOHR-001`, `ACC-REL-001` |

## Phase gate'leri

Her satır ayrıca exact on iki independent report/principal, conflict graph, deterministic oracle,
dissent, reviewed SHA/authority digest, appellate disposition ve sıfır unresolved load-bearing
finding ister. S33 öncesi `external-adversarial-review-v1`; sonrası productized roster kullanılır.
Machine contract: [`verification/phase-gates.json`](verification/phase-gates.json).

| Gate | Domain minimum exit evidence                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------- |
| P01  | Access/TCB/schema isolation, migration restore, typed read-only API/UI ve clean-host seal             |
| P02  | Immutable snapshot-to-plan provenance, pre-call DLP/reservation ve zero side effect                   |
| P03  | Hermetic toolchain/separate-worker broker, TDD/CAS/cleanup ve `EXECUTE_NO_PUSH` recovery              |
| P04  | Effective GitHub authority, attestor/issuer separation, exact PR/check/async protocol; merge disabled |
| P05  | 88-row semantic coverage, deterministic oracles, kill/paging/privacy ve zero challenge                |
| P06  | Admitted capacity/paging/restore/outage drills; bounded PR_ONLY, merge disabled                       |
| P07  | S55 first production low-risk merge; permit/duplicate/rollback/restore/capacity proof                 |
| P08  | Medium 3-of-3 quorum, portability/DR/failover/capacity ve supervised outcomes                         |
| P09  | Fresh full-system reports + signed dossier; high-risk path disabled/non-bypass                        |

## Verification matrisi

| Claim              | Deterministic doğrulama                                 | Negative/live kontrol                                  | Proof                              |
| ------------------ | ------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------- |
| Progress doğruluğu | hash-chain, schema, transition ve projection invariant  | evidence silindiğinde false completion reddi           | `code_proven`                      |
| Identity/TCB       | capability graph, policy digest ve atomic grant consume | forged/replay/cross-workspace/self-modify              | `code_proven`, `operator_attested` |
| Durable effects    | crash/replay/fencing/idempotency model tests            | timeout/202/409/duplicate/reconcile                    | `code_proven`, `live_proven`       |
| Artifact güvenliği | immutable diff coverage, CAS digest, DLP/SSRF oracle    | env-secret, redirect/rebinding/private IP/exfiltration | `code_proven`                      |
| GitHub delivery    | exact SHA, API version, permission ve readback contract | bypass/merge-token yokluğu, stale base                 | `live_proven`                      |
| Finding closure    | deployed SHA + freshness + linked evidence verifier     | merged-only/stale/missing proof `VERIFYING`            | `live_proven`                      |
| Portability/DR     | clean-environment deploy ve restore manifest            | region/provider/worker loss                            | `live_proven`, `operator_attested` |
| High-risk kapalı   | protected taxonomy ve unreachable effect path           | forged policy/permit/role compromise                   | `code_proven`, `operator_attested` |

## Branch, commit, PR ve final-note protokolü

Her work unit — D0 ve ayrı ayrı S01-S72 — tam bir ayrı PR'dır; bir PR iki sprint veya D0+sprint
taşıyamaz. Sprint branch'i `aria/<program-id>/sNN-<slug>`; worktree kayıtlı ve allowlisted root
altında olur. Başlangıç canonical `AuthorityRepositoryRef + configured base ref + exact SHA` note'a
yazılır; bu D0 instance'ında alias `origin/main`'dir fakat portable contract remote adına bağlı
değildir. TDD kırmızısı gözlenir; yalnız green commits repository formatında imzalanır ve her commit
sonrası normal push yapılır. Hook bypass, force push, credential içeren remote veya legacy ARIA
edit'i yasaktır. PR tek sprint scope'u taşır ve required checks/authority digest'i pinler. Required
GitHub Actions `SUCCESS` olmadan merge yasaktır. Hedef GitHub `main`; izinli tek yöntem merge
commit'tir, squash ve rebase merge yasaktır. Reviewer reviewed head SHA'yı aynı work-unit PR final
note'una bağlar; review sonrası reviewed source/head mutasyonu yasaktır. Tek izinli post-review
repository effect'i protected target base'e `MERGE_COMMIT` uygulanmasıdır. Merge sonrası farklı
operator repository dışında `external signed operator readback` üretir ve PR, reviewed head, merge
yöntemi, merge commit/parents, resulting main ve reachability'yi bağlar. İkinci repository PR/commit
yasaktır. Sonraki sprint yalnız bu readback kabul edilince merge commit'in ürettiği exact
`origin/main` SHA'dan başlar. Machine contract:
[`verification/delivery-policy.json`](verification/delivery-policy.json).

## Risk register

| ID     | Risk                                                 | Kontrol / owner / son gate                                     |
| ------ | ---------------------------------------------------- | -------------------------------------------------------------- |
| `R-01` | Tek principal sahte approval/evidence üretir         | identity separation + oracle; Security; S29                    |
| `R-02` | Crash duplicate dış etki veya yanlış başarı üretir   | effect journal/fencing/reconcile; Platform; S45/S51            |
| `R-03` | Executor production host'u tüketir/kaçar             | separate VM, containment, quotas; Ops; S18/S44                 |
| `R-04` | Provider secret/prompt/artifact sızar                | brokers, zero raw retention, DLP/SSRF; Security; S23/S39       |
| `R-05` | GitHub permission gerçeği kaynak claim'inden ayrışır | live permission/readback negative tests; Release; S31/S52      |
| `R-06` | Legacy coupling bağımsızlığı bozar                   | read-only frozen adapter + no shared writes; Architecture; S42 |
| `R-07` | False completion stale/missing evidence ile oluşur   | progress verifier + freshness; QA; S01/S53                     |
| `R-08` | Büyük/god modüller denetlenemez                      | file/complexity/dependency gates; Architecture; her sprint     |
| `R-09` | Medium-risk sınırından high-risk'e kayma             | protected taxonomy/non-bypass; Security; S57/S66               |
| `R-10` | RPO/RTO ve capacity bilinmeden promotion             | OP-07 ölçüm/onay; S61-S64                                      |

## Finding coverage ve audit disposition

[`FINDING-COVERAGE.md`](FINDING-COVERAGE.md), frozen `85787e610` raporundaki `ARIA-AUDIT-001`–`088`
satırlarını birebir kapsar. Matrix legacy kusur kapanışı değildir; yeni sistemin failure mode'u
miras almasını engelleyen control/test programıdır. P0 panel sonucu 20 confirmed, 015/017/044
partially confirmed, 026 refuted olarak korunur. Non-P0 için yalnız source report verification kaydı
vardır; ikinci panel uydurulmaz.

## Rollout/cutover ve high-risk kararı

P01-P05 hiçbir production autonomy vermez. P06 S41 shadow öncesi clean-host/capacity/paging gate'i,
S43'te yalnız disposable bootstrap canary ve S44 sonrası bounded general `PR_ONLY` sağlar. P07 S52
yalnız disposable sandbox merge; S54 rollback/stop hazır olduktan sonra S55 ilk production low-risk
canary'dir. P08 yalnız bounded 3-of-3 medium-risk yetki sağlar. Her aşama current evidence,
capacity/restore/rollback ve required compromise/outage drill'ine bağlıdır. Legacy aktif ve
bağımsızdır.

S65-S72 high-risk readiness evidence ve go/no-go dossier üretir. S72 sonunda high-risk disabled
kalır. Aktivasyon ancak yeni threat model, operator prerequisites, independent audit ve açık insan
onayı içeren ayrı programla ele alınabilir.
