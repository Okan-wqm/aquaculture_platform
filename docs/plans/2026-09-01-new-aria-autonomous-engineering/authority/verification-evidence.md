# Verification, Evidence, Hash ve Freshness Sözleşmesi

[Authority index](INDEX.md) · Owners: S01, every phase gate, S37-S40, S53, S70-S72.

## Immutable append model

Evidence manifest once referenced immutable'dır. Reviewer/admission/freshness sonucu aynı URI'de
update edilmez; predecessor evidence digest, reviewed SHA ve prior event tail taşıyan yeni versioned
manifest eklenir, sonra yalnız bu yeni digest'e referans veren event append edilir. Event kendi hash
veya onu referanslayan evidence digest'ini manifest içine koymaz; graph acyclic kalır.

Historical `progress/evidence/D0-plan-materialization.json` raw digest'i
`0dfd4363797a067ce7ccdfa0a7efbe28b2ee69b2daf2cdcfe2cf2321a3df8558` ve ilk dört event raw bytes'ı
değişmez. Eski document digest'leri current path bytes yerine exact historical source commit
`c6065d6dac97306f147de67ef58a96e3a67524ac` üzerinden `git show <sha>:<path>` ile doğrulanır.
Correction/review yeni authority byte'larını ayrı manifestte hash'ler.

## Event canonicalization `aria-event-cjson-v1`

Her JSONL satırı tek JSON object ve newline'dır. Hash input'u:

1. JSON duplicate key, non-object root, float, negative zero, unsafe integer, non-finite veya invalid
   Unicode scalar içerirse reddet.
2. Top-level `event_hash` alanını çıkar; diğer bütün alanlar, özellikle `previous_hash`, dahildir.
3. Object key'lerini recursive olarak Unicode code-point lexicographic sırala; array sırası korunur.
4. String'leri JSON escaping ile, booleans/null'u lower-case literal, integer'ı canonical base-10
   olarak yaz; insignificant whitespace yoktur.
5. Canonical string'i UTF-8 encode et; SHA-256 lower-case hex digest `event_hash` olur.

Genesis `previous_hash` 64 zero; diğer satır exact önceki `event_hash`'i taşır. Event ID monotonik,
from/to transition legal ve D0 tail `VERIFYING` olmalıdır. Key insertion order aynı hash'i;
key/string/tamper değişimi farklı hash'i üretir. Unicode normalization otomatik yapılmaz: exact code
points authority'dir; NFC/NFD substitution tamper'dır.

## Evidence record provenance

Her proof record closed/versioned schema ile en az şunları bağlar:

- evidence ID/version, immutable predecessor digest, claim/type, program/sprint/state;
- target repository/workspace, base/head/deployed SHA ve canonical reachability ref;
- authority/input/report/tool/verifier/artifact paths + raw SHA-256 ve ordered bundle algorithm;
- producer workload/human principal, independent reviewer ve conflicts;
- exact argv array (placeholder/metavariable yok), CWD contract, tool/runtime version+digest;
- started/ended trusted UTC, exit/result/verdict, stdout artifact digest;
- negative-control IDs/results, linked findings/acceptance ve unresolved risk;
- freshness type, observed/valid-until, invalidation keys/epochs;
- admission `accepted`, admission reason ve appellate identity.

Command fields redacted argv/env-name contract'ına uyar; secret-bearing raw output proof olamaz.
Workflow evidence exact provider run ID/attempt/repository/SHA/artifact digest taşır. Producer kendi
artifact/evidence/admission'ını approve edemez. Transport success semantic verdict veya `no_gaps`
mint edemez.

## Executable D0 verifier

Fresh clone canonical argv:

```text
node docs/plans/2026-09-01-new-aria-autonomous-engineering/verification/verify-d0.mjs --repo-root . --mode full
node docs/plans/2026-09-01-new-aria-autonomous-engineering/verification/test-negative-controls.mjs --repo-root .
node docs/plans/2026-09-01-new-aria-autonomous-engineering/verification/render-projections.mjs --repo-root . --check
```

Minimum runtime Node `20.11.0`; evidence exact observed `node --version`, executable path ve script
digest'lerini kaydeder. Verifier input manifest'i frozen audit snapshot, PLAN/cards/program map,
finding authority/projections, phase-gate/readability policy, reports, evidence ve events'i exact
digest'lerle enumerate eder. Relative link, protected legacy diff ve D0 allowed-scope kontrolü aynı
command içindedir. Verifier runtime service veya promotion authority değildir.

`program-map.jsonl` tek machine relation authority'sidir: `finding_ids` kartın explicit prevention
coverage'ını, `finding_scope` phase/program aggregate challenge'ını, `owned_finding_ids` ise canonical
matrix'in exact reverse owner relation'ını taşır. Bu üç ilişki birbirine dönüştürülmez; verifier her
birini kendi PLAN/card/matrix projection'ına bidirectional ve missing/extra olmadan bağlar.

Negative suite missing/duplicate finding/sprint/role, title/disposition drift, owner/acceptance/card/
OP mismatch, report/script/document/evidence/event tamper, key order, Unicode/numeric invalid input,
stale proof, projection drift, forbidden product/legacy path ve false `DONE` mutantlarını in-memory/
temporary copies üzerinde kırmızı görür. Real authority full command green olmadan evidence üretmez.

## Type-specific freshness

Trusted clock operator UTC'dir; max skew 30 saniye, monotonic observation ID gerekir. Earlier of
`valid_until` ve event-driven invalidation geçerlidir:

| Proof type                           |                      Maximum age | Mandatory invalidators                                                    |
| ------------------------------------ | -------------------------------: | ------------------------------------------------------------------------- |
| source/code/oracle                   |                           30 gün | source/head, authority, verifier, toolchain/dependency/policy digest      |
| identity/key/issuer                  |                          24 saat | cert/key/subject/UID/attestation/credential epoch, revoke/rotation        |
| provider capability/quota            |                         5 dakika | account/subscription, model/CLI, quota epoch/limit, outage                |
| GitHub permission/rules/check/review | 5 dakika; dispatch öncesi reread | App/installation/repo/token/ruleset/bypass/base/head/review/check         |
| host/capacity/headroom               |                          24 saat | topology/image/config/workload/competing load/queue/limit/incident        |
| backup/restore/recovery cut          |                           30 gün | timeline/LSN, object generation, key, region/account, recovery epoch      |
| burn-in/outcome                      |                            7 gün | deployed SHA, cohort/sample policy, provider/host topology, stop incident |
| compromise/outage/rollback drill     |                           30 gün | credential/policy/image/topology/provider/recovery epoch                  |
| operator attestation                 |                           90 gün | owner/role/key/policy/prerequisite change veya revoke                     |

Unknown timestamp/clock, missing invalidation key veya material change gate'i `VERIFYING`/`BLOCKED`
yapar. Unrelated display metadata gereksiz invalidation üretmez. OP-07 sample manifest population,
denominator, strata, duration, exclusions, minimum success/failure/incident bounds, workload digest,
safety factor, SLO/headroom ve max age taşır; cherry-pick/changed quota/topology invalid olur.

## Twelve-role phase gate

Required immutable role set:

```text
integrity, identity, authorization, execution-containment,
supply-chain, data-privacy, cost-capacity, reliability-dr,
github-delivery, api-ui, portability-readability, appellate
```

P01-P09'un **her** promotion gate'i tam on iki ayrı report/principal, role capability match,
conflict-of-interest graph, deterministic oracle result, dissent ve appellate disposition, exact
reviewed head/deployment/authority digest ve sıfır unresolved load-bearing finding ister. Duplicate
principal/model/session oy sayılmaz; bir role/report/oracle/dissent/appellate çıkarılırsa gate deny.

S33 öncesinde runtime rol roster'ı henüz yoktur; P01-P04 gates operator-authorized
`external-adversarial-review-v1` mechanism'iyle aynı bağımsız identity/report sözleşmesini uygular.
S33 sonrası productized reviewer orchestration kullanılabilir fakat protected external appellate
identity ve deterministic oracle sınırı korunur. P05-P09 aynı exact role setini tekrar çalıştırır.
[`phase-gates.json`](../verification/phase-gates.json) dokuz gate'in machine authority'sidir.

Bu round'daki [review package](../reviews/INDEX.md) `c6065d6d...` için `CHANGES_REQUIRED`
non-admission evidence'dır. Corrective head ancak farklı immutable evidence/event ile fresh on iki-
role review `ACCEPTED` verdiğinde admission adayı olabilir; D0 merge edilene kadar yine `VERIFYING`.
