# GitHub Publish, Async Merge ve Reconciliation Sözleşmesi

[Authority index](INDEX.md) · API version: `2026-03-10` · Owners: S25-S32, S50-S55.

## Effective principal ve token authority

Operator-owned `GitHubAuthorityManifest` ayrı Publisher/Merge App için exact App ID, installation
account/ID, provider host, immutable repository ID/selection, allowed API endpoints, explicit
permission allowlist ve token max TTL taşır. Token mint request'i tek exact `repository_ids` girdisi
ve explicit downgraded `permissions` object'i gönderir; omitted/default breadth deny'dır. Persisted
provenance yalnız non-secret returned App/installation/repository/permissions/`expires_at` claim'idir.

Publisher yalnız mission branch/PR/informational check write; Merge App yalnız guarded async merge
endpoint capability'sidir. İkisi de direct protected-base update, rules/settings, secret, workflow,
release/deploy veya bypass capability alamaz. Token revoke provider-side denial readback ile
kanıtlanır. PAT yoktur.

Operator reader repository, organization ve enterprise effective ruleset'lerini; enforcement
state, bypass actors, base rules, required reviews/checks ve trusted source App'lerle birlikte
resolve edip digest'ler. App/installation/repository/permission/rules/bypass değişimi bütün current
token/dossier/permit'i invalidate eder. Publisher denial probe otherwise merge-eligible exact PR
üzerinde provider-denial olmalıdır; incomplete checks nedeniyle denial separation kanıtı değildir.

## Pre-merge snapshot ve permit binding

`MergeSnapshot` şu immutable seti içerir:

- provider/repository/installation, PR number ve base/head repository IDs;
- base ref/SHA, head SHA, merge-base/diff digest ve provider mergeability;
- strict-up-to-date veya queue policy ve effective ruleset/bypass digest;
- required check name + trusted App ID + suite/run ID + exact head + terminal conclusion;
- required reviewer immutable identity, latest reviewed commit/diff, stale-dismiss/latest-push
  settings, last pusher ve unresolved/request-changes state;
- runtime policy/risk, dossier/attestation, capacity/restore/drill ve authority digests.

Publisher informational check'i required admission check olamaz. Duplicate same-name wrong-App,
`skipped`/`neutral`, old SHA, stale approval, approval by forbidden pusher, base/merge-base advance,
ruleset drift veya loose policy deny'dır. `merge-authority` per-base lock altında snapshot'ı provider'dan
yeniden okur; exact digest değişirse permit tüketilmez ve call count sıfırdır.

Permit'in issuer/quorum sözleşmesi [identity authority](identity-authority-tcb.md)'dadır. Permit
ayrıca PR, method, protected explicit `merge_action`, full options digest ve local effect ID'yi
bağlar. Stacked PR tamamen yasaktır; stack membership non-empty/unknown ise tek-PR permit dispatch
edemez. Daha sonraki ayrı program exact stack üyelerini tek dossier/permit altında tanımlamadıkça
`merge_action=default` kullanılmaz.

## PR/check natural identity ve reconciliation

PR DB uniqueness:

```text
baseRepositoryId + baseRef + headRepositoryId + headRef + headSha + missionId + effectId
```

Provider-visible immutable marker effect ID/digest'ini taşır. Response PR node/number/URL ile
persist edilir. Timeout reconciliation exact base/head ref'i paginate eder ve marker, both repo IDs,
SHA, mission/effect'in tümü eşleşmeden object adopt etmez. Delete/reopen/force-update/fork swap yeni
object yaratmak yerine `UNKNOWN`/terminal conflict üretir.

Check identity; repository, head SHA, stable check name, trusted Publisher App ID, `external_id`
effect ID ve provider check-run ID'dir. Timeout exact ref + `external_id` ile aynı run'ı bulup update
eder; same-name başka run adopt edilmez. DB unique constraint ve readback concurrent/response-loss
durumunda exactly one matched provider object veya fail-closed sağlar.

## Async merge effect state

Local `effect_id` ile provider `provider_merge_uuid` farklı alanlardır. Request option digest:

```text
repositoryId, prNumber, expectedHeadSha, method, explicitMergeAction,
title/message digest, baseRef/baseSha, snapshotDigest, permitId
```

REST request exact API version'ı ve `sha=expectedHeadSha` taşır; caller idempotency field varmış gibi
davranılmaz. Response state machine bütün documented status'leri kapsar:

| HTTP  | Davranış                                                                                |
| ----- | --------------------------------------------------------------------------------------- |
| `200` | already merged/queue sonucu ayrıştır; independent readback olmadan terminal success yok |
| `202` | returned provider UUID'yi durable persist et, sonra poll/reconcile et                   |
| `400` | terminal invalid request; no retry                                                      |
| `403` | permission/rules denial + freeze/incident; no retry                                     |
| `404` | request/PR/result ayrımı; expired result ise `UNKNOWN`                                  |
| `409` | returned existing UUID'yi persist/read; options exact değilse terminal conflict         |
| `422` | validation/state denial; no blind retry                                                 |

Crash provider UUID response'undan önce/sonra ayrı kill point'tir. `202`/`409` UUID persist edilmeden
poll/adopt yoktur. `GET .../merge-async/{uuid}` sonucu provider'ın 24 saatlik result lifetime'ı
içinde izlenir; expiry `404` başarı/başarısızlık mint etmez. Independent PR/base/commit/check readback
tek terminal outcome kanıtlayamazsa `UNKNOWN` + manual reconciliation kalır. Queue cancellation,
UUID swap, mismatched 409 options ve response loss blind retry üretemez.

## Atomic dispatch ve outcome

Tek serializable transaction current snapshot/permit/issuer/quorum/freshness'i doğrular, permit'i
tüketir ve exact `INTENDED` effect + dispatch-journal record'ını yazar. Off-host horizon ack olmadan
external call yoktur. Provider call sonrası exact method-specific commit/tree/parents, merged SHA,
base reachability ve required-check/review snapshot readback yapılır. Merge release değildir;
release/deploy capability hiçbir ARIA rolünde yoktur.

S31 protocolü sandbox ve disabled-dispatch contract'ıyla doğrular. S52 yalnız disposable sandbox
repository'de bütün status/crash/expiry/stack/reconcile fixture'larını çalıştırır; production repo
selection structurally unreachable'dır. S54 rollback/freeze/page/restore/human-owner drill'inden
sonra S55 ilk production low-risk merge olabilir. Exact deployed SHA fresh evidence olmadan finding
`SOLVED` olmaz.
