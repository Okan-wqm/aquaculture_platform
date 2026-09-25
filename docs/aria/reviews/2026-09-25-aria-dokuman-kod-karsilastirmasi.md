<!-- ARIA-CURRENT-STATE-NOTICE: Bu inceleme kaydı docs/aria/CURRENT_STATE.md ve executable
contracts'a tabidir; bir tarih-damgalı denetim anlık görüntüsüdür, runtime otoritesi değildir. -->

# ARIA — Doküman ↔ Kod Karşılaştırması (2026-09-25)

> **Kapsam.** `ARIA-MIMARI-SEMALARI.md` (repo kökü, 22 şema, 2026-09-16/19) ve
> `docs/aria/ARIA-NASIL-CALISIR.md` (2026-09-19) ile `main @ 19efd07f` kodu ve canlı durum dalı
> `origin/aria/state @ e6f462fb` (2026-09-25) karşılaştırıldı. 6 bağımsız okuma ajanı paralel
> çalıştı (kanıt/ledger/profil · discovery/cycle/ memory/pressure · adaptör/yargıç/kalibrasyon ·
> ajan/dispatch/convergence · governance/orkestratör/PR · canlı durum/RAG). Her satır açılmış bir
> `file:line` ile kanıtlıdır. Sınıflar: **DOĞRU** · **KAYMA** (satır/isim/sayı eskimiş, davranış
> aynı) · **TUTARSIZ** (doküman X der, kod Y yapar) · **EKSİK-DOKÜMAN** (kodda olan önemli davranış
> dokümanda yok) · **EKSİK-KOD** (dokümanın iddiası kodda yok / bağlı değil).
>
> **Okuma kapsamı — iki tur.**
>
> 1. **İddia-güdümlü tur (6 ajan):** dokümanlardaki her somut iddianın geçtiği ~70–90 modül açıldı
>    (§2–§7).
> 2. **Tam okuma turu (12 ajan):** `aria-kernel/aria_kernel/**` (350 dosya), `tools/aria-poc`,
>    `tools/aria-adapters`, `tools/aria-acceptance`, `tools/aria` ve 11 `aria-*` workflow — **400
>    dosyanın 400'ü, ~198 000 satır** baştan sona okundu. Ham ajan raporları (dosya envanteri,
>    üretimde bağlı mı, tutarsızlıklar, ölü kod, riskler):
>    `docs/aria/reviews/2026-09-25-aria-tam-okuma/B01.md … B12.md`. Yeni bulgular ve ilk turun
>    düzeltmeleri §8.dedir. Tek istisna: B02 `autonomy_evidence.py:200-583` statik kapanış
>    tablosundaki SHA'ları tek tek doğrulamadı.
> 3. Testler (683 kernel testi) envanterlendi (B12), satır satır okunmadı.

---

## 0. Yönetici özeti

1. **"ARIA hiç koşmadı" artık yanlış.** Her iki doküman da canlı durumu repo-içi `aria-tools/`'tan
   okuyor (boş, gitignore'lu). Gerçek durum `origin/aria/state` dalında: **43 cycle başladı / 30
   tamamlandı / 13 başarısız** (2026-08-05 → 2026-09-20), **304 LLM ajan sonucu** (274 kabul / 30
   red), 108 adaptör koşusu, 34 500 ham bulgu. ARIA **algılama + yargı** katmanında gerçekten
   çalışıyor.
2. **Ama değer üretim zinciri kapanmadı:** kanonik bulgu deposunda (`findings/aria-findings/`) **13
   OPEN** bulgu var — 8'i LLM yargısını atlayan mekanik `seed:drift-scan` (Jaccard eşleşmesi
   doğrudan finding basar), 5'i consensus terfisi; hiçbiri RESOLVED'a gitmedi (otomatik RESOLVED
   üreticisi yok). Plan olayları 15 başladı / 12 terk (hepsi 72 **saat** durgunluk kuralı; 11'i
   2026-08-16'daki tek bir benimseme taramasında) / 2 değerlendirildi / **0 CONVERGED** — hiçbir
   plan 1. turu geçemedi. 8 auto-merge kararı (4 PR × 2) **8'i de `blocked`** (merge runner değil,
   CI-review dry-run yolu yazdı); 94 mission açıldı, **88'i DISCOVERED, 6'sı SUPERSEDED**;
   change-ledger 2 `change_planned`, 0 committed. Tüm cycle'lar `standard` profilde; **observe
   burn-in 0/30**. Kök nedenler §8.1'de.
3. **2026-09-21'den beri gece koşuları kırmızı.** Son başarılı cycle `cyc-20260920T212805Z-auto`.
   Publish reddi: `state_commit_surface_too_large:raw_findings` — ham bulguların **%87'si (29 939 /
   34 500) tek adaptörden, `doc-staleness-adapter`'dan** geliyor. Bu 29 939 satır 2 755 benzersiz
   parmak izinin ~12 koşuda tekrarı (tüm adaptörlerde 3 253 benzersiz). Publish kontrolü
   `raw_findings`'i bir teşhis sayımı için boyut/satır sınırına bağlıyor
   (`autonomy_evidence.py:593-596,2543-2554`); executor publish'leri hâlâ geçiyor. Compactor
   düzeltmesi (8028bbb0, main'de) parmak izi başına dedup ekler (34 500 → 3 254 satır); yeşil bir
   cycle ile henüz yayımlanmadı.
4. **Doküman yapısal olarak eskimiş yerler:** cycle 47 faz (NASIL-CALISIR 16 satır anlatıyor),
   `heartbeat_tick` silinmiş, model merdiveni `fable→opus→sonnet` 2026-09-12'de kaldırıldı, HMAC
   re-verify bağlı (doküman "değil" diyor), Brier/ECE kalibrasyonu + kalibre quorum + label queue +
   batch judge hiç yok.
5. **Abartılı güvenlik iddiaları:** L1'in "≥2 bağımsız kanıt zinciri" kodda yok (claim_type'a göre
   1–3, otomatik terfide 1, bağımsızlık denetlenmiyor); kapalı `source_type` allowlist'i hiçbir
   yerde uygulanmıyor; `set_by` kendi-beyan; maliyet kapısı `managed_subscription` modunda hiçbir
   şeyi reddetmiyor; L2/L3 kabul olaylarını yazan üretim kodu yok → merdiven yapısal olarak L1'de
   takılı.
6. **RAG değil.** Vektör DB yok, embedder yok (soket boş), arama SQLite FTS5/bm25. Doğruluk kaynağı
   git blob hash eşitliği; LLM üretici değil hakem.
7. **Tam okuma (400/400 dosya) zinciri koparan kod hataları buldu (§8.1).** En ağırları:
   HUMAN_REQUIRED paneli oyu okuyamıyor (968 `panel_incomplete`, 113 kayıt, 0 karar) ve oy okunsa
   bile paneller "bağımsız değil" düşer (principal = GitHub run); challenger zarfları yanıtlanmadığı
   için hiçbir plan 1. turu geçemiyor; `change_validated`'ı otomatik yazan kod yok; merge merdiveni
   profil/unlock/readiness kapılarında takılı. Ayrıca 12 güvenlik bulgusu (§8.2) — ör.
   `lstrip("./")` path normalizasyon hatası; LLM'in yazacağı adaptörü sandbox'sız koşturan (bugün
   erişilemez, latent) yol.
8. **İkinci tur doğrulaması (12 ajan, 1 105 iddia, §9):** %79 doğrulandı, %17 kısmen, %2 (24)
   çürütüldü. Bu kayıttaki tüm çürütme/kısmi düzeltmeler işlendi.

---

## 1. Canlı gerçek — `origin/aria/state @ e6f462fb` (2026-09-25)

| Yüzey                                          | Sayı                                                                                                   | Yorum                                                                                                                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools/cycles.jsonl`                           | 43 started · 30 completed · 13 failed                                                                  | ilk 2026-08-05, son başarılı `cyc-20260920T212805Z-auto`                                                                                                                                       |
| `tools/agent-invocations/results.jsonl`        | 304 (274 accepted · 30 rejected; 30 red satırında rol alanı yok)                                       | kabul edilenlerin rolleri: evidence_judgment 85 · adversarial_judgment 82 · human_required_adjudication 80 · maintenance_utility 24 · consensus_arbitration 2 · challenger_plan 1              |
| `tools/runs.jsonl`                             | 108                                                                                                    | adaptör koşuları                                                                                                                                                                               |
| `tools/raw-findings.jsonl`                     | 34 500                                                                                                 | 3 253 benzersiz parmak izi · doc-staleness 29 939 (2 755 benzersiz) · test-gap 3 459 · tenant-scoping 724 · security-boundary 156 · kernel-dead-wire 110 · bundle-budget 108 · fe-dto-parity 4 |
| `tools/findings.jsonl`                         | dosya yok                                                                                              | eski yüzey; kanonik depo aşağıda                                                                                                                                                               |
| `findings/aria-findings/` (+`_index.json`)     | 15 dosya, index'te **13 OPEN** (F-001…F-008 spine_drift seed · F-009…F-013 consensus)                  | RESOLVED yok; 2 deney (F-009, F-010) sahte çürütmeyle bitti                                                                                                                                    |
| `tools/registry.json` (canlı)                  | 10 araç: 7 CALIBRATE · 2 SHADOW · 1 QUARANTINED (agent-harness)                                        | `lint-rules` kayıtlı değil; manifestler SHADOW beyan eder; nightly `register_tool` canlı durumu korur (`registry_compiler` yalnız CLI, hiç koşmadı)                                            |
| `tools/judgment-samples.jsonl`                 | 220                                                                                                    | yargı örneklemesi çalışıyor                                                                                                                                                                    |
| `tools/feedback-consensus-uncertainties.jsonl` | 18                                                                                                     | consensus'a ulaşamayanlar                                                                                                                                                                      |
| `tools/human-required/`                        | 113 kayıt (hepsi `open`) + `adjudications.jsonl`                                                       | insan kuyruğu dolu                                                                                                                                                                             |
| `tools/plans/events.jsonl`                     | plan_started 15 · plan_abandoned 12 · plan_evaluated 2 · challenger_plan_drafted 1                     | **0 CONVERGED**                                                                                                                                                                                |
| `tools/auto-merge-decisions.jsonl`             | 8 — hepsi `blocked`: 4 PR (#1266, #1273, #1282, #1335) × 2 cycle; CI-review dry-run yolu (`ci.py:166`) |                                                                                                                                                                                                |
| `tools/missions/mission-events.jsonl`          | 117 (94 opened · 17 wake · 6 transition)                                                               | 94 mission: 88 DISCOVERED · 6 SUPERSEDED; seçim operatör `priority`'siyle (auth-service priority 0 → 28 kararın 27'si)                                                                         |
| `tools/change-ledger/*`                        | 2 `change_planned` (F-009, F-010) · 0 committed · 0 validated                                          | değişim zinciri hiç işlemedi                                                                                                                                                                   |
| `tools/governance.jsonl`                       | 968 × `panel_incomplete`                                                                               | HUMAN_REQUIRED paneli hiç karar vermedi (§8.1-A)                                                                                                                                               |
| `tools/memory/beliefs.jsonl`                   | 8                                                                                                      | bellek çok ince                                                                                                                                                                                |
| `autonomy_state.jsonl`                         | 403 satır, hepsi `profile: standard`, `auto_merges_delta` toplamı 0                                    |                                                                                                                                                                                                |

Kanıt komutu: `git show origin/aria/state:tools/<yüzey>` (salt-okuma). Dal bu kayıt yazılırken
`06b4ba4a`'ya ilerledi (ör. 324 sonuç / 294 kabul, native Claude başarısı 73 → 100,
operator-feedback 138 → 157); tablo `e6f462fb`'ye sabitlidir.

**Huni:** 34 500 ham bulgu (3 253 benzersiz) → 220 örnek → 167 yargıç yanıtı → 18 belirsizlik / 113
HUMAN_REQUIRED (**0 karar**) → 13 OPEN finding (0 RESOLVED) → 15 plan → **0 CONVERGED** → 94 mission
(88 DISCOVERED · 6 SUPERSEDED) → 0 merge. Kuyruk ayrıca: 1 171 ajan isteğinin 610'u `anchor_expired`
ile düştü; bunların **525'i (%44,8) hiç claim edilmemişti**, 85'i claim → requeue sonrası düştü.
528'i Ağustos'taki 3 günlük pencere döneminden; 2026-09-02'de pencere 7 güne çıkarıldıktan sonra 82
(B01, V01).

---

## 2. En kritik tutarsızlıklar (her iki doküman)

| #   | Doküman iddiası                                                                                                                                                            | Kod gerçeği                                                                                                                           | Kanıt                                                                                                 | Sınıf                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------- |
| K1  | Canlı Durum: "findings hiç koşmadı, dispatch/enterprise dizinleri yok, `aria/state` dalı yok" (MIMARI §Canlı Durum); "runs/cycles 0 byte, hiç otonom koşu yok" (NASIL §15) | Durum `origin/aria/state`'te: 43 cycle, 304 ajan sonucu                                                                               | `git show origin/aria/state:tools/cycles.jsonl`; `.gitignore:222-223`                                 | TUTARSIZ             |
| K2  | L1: onaylı bulgu **≥2 bağımsız kanıt zinciri** ister (NASIL §1)                                                                                                            | min kanıt claim_type'a göre 1–3; `finding_promotion` her şeyi `wrong_code` (min 1) basar; bağımsızlık/tekrar denetimi yok             | `finding.py:82-99,237-240`; `finding_promotion.py:42`                                                 | TUTARSIZ             |
| K3  | Kapalı `source_type` allowlist'i gate'te reddedilir (NASIL §2.2)                                                                                                           | Hiçbir .py bu allowlist'i uygulamıyor; fiili kapı blob derecelendirmesi                                                               | `CONTRACTS.md:755`; uygulayan kod yok, yalnız bir docstring'de geçer (`runtime_signal_bridge.py:3-5`) | EKSİK-KOD            |
| K4  | Cycle 16 faz (NASIL §4) / 46 faz (MIMARI Şema 0/16)                                                                                                                        | **47 faz**                                                                                                                            | `cycle.py:3109-3485` (`len(CYCLE_PHASES)==47`)                                                        | KAYMA                |
| K5  | `heartbeat_tick` cycle'lar arası nabız (NASIL §4)                                                                                                                          | Silinmiş; işler `fixture_refresh`/`judgment_pipeline` fazlarında                                                                      | `cycle.py:1685-1700,1955-1960`                                                                        | TUTARSIZ             |
| K6  | Model merdiveni `fable→opus→sonnet → glm-5.3` (MIMARI Şema 5)                                                                                                              | 2026-09-12 operatör kararı: in-vendor düşürme yok, `opus` yaprak; yalnız sağlayıcılar-arası **auth** failover (opus ↔ glm-5.3)       | `tools/aria-poc/claude_runtime.py:76-95,1845-1870`                                                    | TUTARSIZ             |
| K7  | Auto-promote HMAC tüketim anı re-verify "henüz wired değil" (NASIL §7.2)                                                                                                   | Bağlı: `transition_tool` → `verify_auto_promote_token` sabit-zamanlı karşılaştırma                                                    | `tool_registry.py:1437-1466`; `adapter_calibration.py:168-203`                                        | KAYMA (doküman eski) |
| K8  | Drift "Rust↔TS event-contract sınırını yakalar" (NASIL §7.3; MIMARI Şema 10 "TS↔SQL")                                                                                    | Rust enum'ları ts-tarafına eklenir, `find_drifts` yalnız ts-tarafı × SQL karşılaştırır → **Rust↔SQL**, Rust↔TS yok                  | `poc.py:1633,1640,914-946`                                                                            | TUTARSIZ             |
| K9  | Maliyet kapısı LLM spawn'dan ÖNCE tek boğaz (her iki doküman)                                                                                                              | `monetary_admission == "managed_subscription"` → reddetmeden `telemetry_only`; repo policy tam olarak bu                              | `cost_budget.py:139-156`; `aria-config/genesis_policy.json:28`                                        | TUTARSIZ             |
| K10 | Unlock merdiveni 30/30/30/10/5/3 sayaçları dolabilir (her iki doküman)                                                                                                     | Üretimde yalnız `observe_success` yazılıyor; `l1_autonomous/l2_*/l3_*/rollback_success` üreticisi yok → L2/L3 yapısal olarak açılamaz | `autonomy_ladder.py:84-90`; `autonomy_unlock.py:28-36,72-98`                                          | EKSİK-KOD            |
| K11 | "Makine kendi yetkisini genişletemez" (NASIL §2.4)                                                                                                                         | `set_by` kendi-beyan string, varsayılan `"operator"`; kod yalan beyanı değil yalnız drift'i durdurur                                  | `runtime_profile.py:545,575-583`; `cli.py:1229`                                                       | TUTARSIZ (abartılı)  |
| K12 | Runtime sinyali "Sentry · 85" girer (MIMARI Şema 9/20; NASIL §6)                                                                                                           | Sentry entegrasyonu yok; `sentry` yalnız izinli kaynak adı (testlerde); Alertmanager ARIA'ya yönlendirilmemiş                         | `tests/test_runtime_signal_bridge.py:58`; `infrastructure/monitoring/droplet/alertmanager.yml:69-70`  | EKSİK-KOD            |
| K13 | Pressure skoru `× tazelik_çürümesi`                                                                                                                                        | `recency_decay = 1.0` sabit → terim etkisiz                                                                                           | `pressure.py:979,997-1015`                                                                            | TUTARSIZ             |
| K14 | Coverage invariant "hiçbir dosya görünmez kalamaz"                                                                                                                         | `len(allowed) <= len(fates)` totoloji; gerçek kontrol yalnız "`unknown` yok"; kirli/untracked committed modda bilerek dışarıda        | `discovery.py:96,40-57`                                                                               | TUTARSIZ (zayıf)     |
| K15 | GATE_PRE_PR_OPEN "17 sert kontrol" (MIMARI Şema 16) / "15 hard-fail" (NASIL §9.3)                                                                                          | `HARD_FAIL_CHECKS` = **18**; kod yorumu hâlâ "15"; cycle.py yorumu "10-check perimeter"                                               | `implementation_safety.py:1810`; `cycle.py:3045`                                                      | KAYMA                |
| K16 | ADR-033 "snowball'da, main'e merge değil"; IDENTITY "ARIA does not exist yet" (NASIL §15)                                                                                  | Autonomous profil main'de; IDENTITY:29 "ARIA the system EXISTS and runs" (2026-08-20)                                                 | `runtime_profile.py:124,175`; `docs/aria/IDENTITY.md:29`                                              | TUTARSIZ             |

---

## 3. Bölüm bazlı bulgular

### 3.1 Kanıt / ledger / profil (NASIL §1–2, MIMARI Şema 6–7)

| Doküman                                                                           | Kod                                                                                                                                                                                                                                                                                                                                | Kanıt                                       | Sınıf                 |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------- |
| `_record_hash :387`, `_append_jsonl_locked_body :395`, `load_jsonl_verified :861` | Davranış aynı; 1241 / 1278 / 1911                                                                                                                                                                                                                                                                                                  | `ledger.py`                                 | KAYMA                 |
| Ham `append_jsonl` enterprise yüzeyde reddedilir                                  | Doğru ama iki kaçış: `test_fixture=True`, `allow_legacy`+reason+`expires_at` (üretimde: `agent_invocations.py:1796`, bitiş 2026-12-31)                                                                                                                                                                                             | `ledger.py:1455-1506`                       | EKSİK-DOKÜMAN         |
| Yazımlar lock + fsync + atomik rename                                             | Append: flock + O_APPEND + fsync (rename yok); rename yalnız `rewrite_jsonl`                                                                                                                                                                                                                                                       | `ledger.py:1313-1318,1649-1650`             | TUTARSIZ (küçük)      |
| (yok)                                                                             | `append_declared_jsonl(bypass_profile_gate=True)` kernelde 34 çağrı                                                                                                                                                                                                                                                                | `ledger.py:1428,1606-1614`                  | EKSİK-DOKÜMAN         |
| `repo_verified` "tek güvenilir derece"                                            | Dizin ref'i yalnız `cat-file -t == tree` ile `repo_verified`; ayrıca `repo_glob_verified`, `empty_glob`, `glob_too_large_to_verify` (500) dereceleri                                                                                                                                                                               | `evidence_trust.py:62-64,147-151,321-395`   | EKSİK-DOKÜMAN         |
| GitProbeSession 30 s × 3 + 1+2 s geri çekilme = 93 s, 300 s canlılık              | Birebir                                                                                                                                                                                                                                                                                                                            | `evidence_probe.py:37-58,220-282`           | DOĞRU                 |
| `validate_agent_response_evidence :350`                                           | 540; satır varlığı `1 ≤ line ≤ n`, satır içeriği/semantik doğrulanmaz; `human-required:` ref'leri ve ARBITRATION kernel artefaktları istisna                                                                                                                                                                                       | `evidence_validator.py:382-385,480-497,540` | KAYMA + EKSİK-DOKÜMAN |
| Beş profil; modül docstring                                                       | Docstring hâlâ "4-mode"                                                                                                                                                                                                                                                                                                            | `runtime_profile.py:1,123`                  | KAYMA                 |
| frozen "tüm yazımlar" / "tek yazma-yetki sınırı"                                  | _(tam okumada düzeltildi, B09)_ `PLAN_020_WRITE_SURFACES` artık manifestten türer (42 yüzey) ve 8 gözlem yüzeyinin tamamını kapsar (`OBSERVE ∖ PLAN_020 = ∅`); beyanlı yüzeylere giden her yazım frozen'da bloklanır — istisna yalnız `bypass_profile_gate` çağrıları (34) ve diagnostic; `runtime_profile.py` docstring'i eskimiş | `runtime_profile.py:24-31,308-322`          | EKSİK-DOKÜMAN         |
| Bozuk profil → frozen                                                             | Doğru; dosya yoksa `standard`                                                                                                                                                                                                                                                                                                      | `runtime_profile.py:401,428-466`            | KAYMA                 |

### 3.2 Discovery / cycle / memory / pressure (NASIL §3–6, MIMARI Şema 2, 9)

| Doküman                                                              | Kod                                                                                                               | Kanıt                                                | Sınıf         |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------- |
| `run_enterprise_cycle` `cycle.py:219` / `:528`; `CYCLE_PHASES :2939` | 541 / 3109                                                                                                        | `cycle.py`                                           | KAYMA         |
| "Bilinmeyen faz → ValueError"                                        | Faz listesi girdi değil; import anında `_assert_pipeline_is_well_formed`, bilinmeyen `mode` → `GovernanceError`   | `cycle.py:573-588,3488`                              | TUTARSIZ      |
| pre_tool = architecture_baseline / validation_matrix / pr_lifecycle  | pre_tool = tool_manifest_sync + architecture_baseline; diğer ikisi post_tool sonunda                              | `cycle.py:3199-3207,3475-3484`                       | TUTARSIZ      |
| "Post-tool hataları cycle'ı çökertmez"                               | Varsayılan `halt_sequence`: sonraki halt fazları `upstream_failure` ile atlanır; `artifact_integrity` `propagate` | `cycle.py:477,3452,3620-3646`                        | TUTARSIZ      |
| Memory FATES kurcalamasını `repo_state_id` ile yakalar               | `_verify_fates_integrity` her hash'i `git show` ile yeniden hesaplar; `repo_state_id` yalnız damga                | `memory.py:1449-1475,1560-1610`                      | TUTARSIZ      |
| Decay "iki yolla"                                                    | 4 yol: diff, yaş (90 g), head-distance, karantina kaynak + stuck contradiction eskalasyonu                        | `memory.py:882-948,1057,188`; `cycle.py:1398-1424`   | EKSİK-DOKÜMAN |
| Pressure 6 kaynak                                                    | `SOURCE_WEIGHTS` 14 kaynak                                                                                        | `pressure.py:16-57`                                  | EKSİK-DOKÜMAN |
| "Baskı yoksa cycle yalnız reflect eder"                              | Mission/proactive/judgment/experiment fazları baskıdan bağımsız koşar                                             | `cycle.py:3263-3434`                                 | TUTARSIZ      |
| proactive_priority kod alanı sıralar                                 | Sıralama **tool_id** üzerinden; `mission_ingest` ondan önce koştuğu için 1 cycle gecikmeli okur                   | `proactive_priority.py:46-126`; `cycle.py:3283,3434` | EKSİK-DOKÜMAN |
| consensus_escalation, judge_calibration, proactive_priority üretimde | Hepsi `CYCLE_PHASES`'te, `WRITES_PERMITTED`                                                                       | `cycle.py:3311-3314,3397-3400`                       | DOĞRU         |

### 3.3 Adaptör / yargıç / kalibrasyon (NASIL §7–8, MIMARI Şema 10–11, 21)

| Doküman                                              | Kod                                                                                                                                                                                                           | Kanıt                                                          | Sınıf                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------- |
| "10 TS manifest" (MIMARI Şema 21)                    | **11** manifest (lint-rules 2026-09-19'da eklendi); **11'i de SHADOW**, ACTIVE yok                                                                                                                            | `tools/aria-adapters/*.tool.json`                              | KAYMA                 |
| ACTIVE'e yetki: operatör **veya** auto-promote       | Üçüncü yetki: `panel_approval_token` (24 s veto)                                                                                                                                                              | `tool_registry.py:1356-1383`                                   | EKSİK-DOKÜMAN         |
| Auto-promote kullanılabilir                          | Varsayılan `enabled:false`, min_precision 0.95, yalnız autonomous                                                                                                                                             | `data/genesis_policy_default.json:7-15`                        | EKSİK-DOKÜMAN         |
| Readiness ≥5 SHADOW + fixture + precision            | Ek engeller: fixture_baseline, semantic_fixture, stale_run_evidence, ≥5 anchor-judged (≥3 yargıç)                                                                                                             | `readiness.py:88-130`                                          | EKSİK-DOKÜMAN         |
| Drift = Jaccard                                      | Drift = isim eşleşmesi + değer kümesi farkı; Jaccard ≥0.3 FP **filtresi**                                                                                                                                     | `poc.py:868-877,940-963`                                       | KAYMA                 |
| Consensus = ≥2 yargıç + oybirliği + ort. güven ≥0.80 | Üretimde `judge_weights` → ağırlıklı çoğunluk (>0.5+0.10); ortalama yalnız kazanan tarafta; `conformal_abstain`, `observer_identity_missing`                                                                  | `feedback_store.py:82,898-1000`; `cycle.py:1836-1853`          | KAYMA + EKSİK-DOKÜMAN |
| (yok) Kalibre quorum                                 | `calibration_gate` `measure_only` (varsayılan) / `enforce`: consensus'u yalnız farklı modellerden ≥2 **calibrated** yargıç kapatır                                                                            | `feedback_store.py:59-61,944-966`; `genesis_policy.py:113-151` | EKSİK-DOKÜMAN         |
| (yok) Brier / ECE                                    | Brier, Brier skill, 10-kutu ECE, bootstrap üst sınır, Wilson; `calibrated` ≥100 örnek + ECE_üst ≤0.10; yargıç kendi anchor'unda puanlanmaz (ARIA-HIGH-173); imzasız insan etiketi truth değil (ARIA-HIGH-169) | `judge_calibration.py:48-50,83-93,149-247`                     | EKSİK-DOKÜMAN         |
| Belirsizlik "artık jsonl'a değil" HUMAN_REQUIRED'a   | Hâlâ jsonl'a yazılır, ayrı sweep HUMAN_REQUIRED'a taşır                                                                                                                                                       | `feedback_store.py:1073-1098`; `human_required.py:632-646`     | KAYMA                 |
| (yok) Label queue, batch judge                       | Label queue (CLI + reflection, cycle fazı değil); batch judge varsayılan kapalı (`judge_batch_size=1`, yalnız zai)                                                                                            | `label_queue.py:1-25`; `genesis_policy.py:97-104`              | EKSİK-DOKÜMAN         |
| Gold-set + replay                                    | Kod bağlı; **repoda ve aria/state'te aktif gold-set verisi yok**                                                                                                                                              | `cycle.py:1928-1952`; `goldset.py:294`                         | DOĞRU (veri yok)      |

### 3.4 Governance / orkestratör / PR / rapor (NASIL §11–13, MIMARI Şema 1, 7, 15)

| Doküman                                               | Kod                                                                                                                                                                   | Kanıt                                        | Sınıf         |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------- |
| "~120 yüzey"                                          | **244** `STATE_SURFACES`                                                                                                                                              | `state_manifest.py:203-230`                  | KAYMA         |
| Maliyet $0.50/$5/$100 (NASIL)                         | Etkin override 0.5 / 25 / 300 (MIMARI doğru)                                                                                                                          | `aria-config/genesis_policy.json:5-9`        | KAYMA         |
| `reset_breaker` approval_ref olmadan açılmaz          | Zorunlu ama içerik doğrulanmıyor (boş string geçer)                                                                                                                   | `cost_budget.py:272-293`                     | KAYMA (zayıf) |
| Orkestratör zorunlu kwarg'lar (3)                     | 8 zorunlu + profile; `v9_implementation_runner` opsiyonel; CLI her zaman gerçek runner'ı geçer — NoOp olması standard profilde `pr_create` yetkisi olmamasından (V08) | `autonomy_orchestrator.py:913-963,1029-1031` | EKSİK-DOKÜMAN |
| `autonomy_orchestrator.py:726`                        | 913                                                                                                                                                                   |                                              | KAYMA         |
| Adım sırası ARIA_STOP→…→Gate B→auto-merge (`no_gaps`) | Birebir                                                                                                                                                               | `autonomy_orchestrator.py:1444-2680`         | DOĞRU         |
| PR base `main`, 7 bölüm                               | Doğru; bölüm adı "Baseline Comparison"                                                                                                                                | `pr_manager.py:48-56,213`                    | DOĞRU         |
| Merdiven tek eşik                                     | Lane'e göre: L1 = 30 observe; L2 = 30+30+30; tam liste yalnız L3; 72 s süreklilik                                                                                     | `autonomy_unlock.py:27,55-62,168-207`        | KAYMA         |
| Günlük rapor bölümleri                                | Sayılanlar + 16 bölüm daha (toplam 31) (Labels wanted, Experiment Night, Missions, Duel Ratings…)                                                                     | `reflection.py:617-1602`                     | EKSİK-DOKÜMAN |
| "12 aria-\* workflow" (MIMARI Şema 21)                | **11** (`aria-kernel-fast` yok)                                                                                                                                       | `.github/workflows/aria-*.yml`               | KAYMA         |
| "58 ajan (18 aria-\*)"                                | 52 üst-düzey ajan, 18 `aria-*`                                                                                                                                        | `.claude/agents/`                            | KAYMA         |

### 3.5 Ajan / dispatch / convergence (NASIL §9–10, MIMARI Şema 3–5)

| Doküman                                           | Kod                                                                                                                                                                                                      | Kanıt                                                               | Sınıf         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------- |
| Roster "13 ajan"                                  | 18 üst-düzey `aria-*.md` + 2 `_maintenance/` = 20 (completeness-critic, autonomy-planner, worker, 4 acceptance ajanı eksik)                                                                              | `.claude/agents/`                                                   | KAYMA         |
| `DISPATCHABLE_ROLES` (11)                         | **15** (E14: consensus_arbitration, change_intelligence, goldset_curation; E9-c: verification)                                                                                                           | `agent_surface.py:61-90`                                            | KAYMA         |
| `ROLE_TARGET_PAIRING` "yanlış eşleşme reddedilir" | primary_plan / challenger_plan / cross_review için eşleme **yok**; `primary_plan → aria-evidence-judge` mint'te kabul edildi (canlı probe); whitelist yalnız `implementation`                            | `agent_surface.py:144-168`; `agent_contract.py:120,210-215`         | TUTARSIZ      |
| Lease 30 dk                                       | Varsayılan 1800 s, ama `ci_executor` kendi hesapladığı lease ile ezer                                                                                                                                    | `ci_executor.py:4427-4439`                                          | KAYMA         |
| Submit: validate → SoD → evidence → compliance    | + `plan_contract` + `secret_in_envelope` adımları                                                                                                                                                        | `agent_invocations.py:5175-5244`                                    | EKSİK-DOKÜMAN |
| Convergence ≤5 tur                                | _(V07: çürütüldü)_ "round ≥3 + yeni risk → HUMAN_REQUIRED" yalnız ölü CRITIQUED yolunda (`_evaluate_state`); canlı V8 değerlendiricisinde (`:2757-2835`) yok. Spine `unavailable` → HUMAN_REQUIRED doğru | `plan_convergence.py:655-684,2742-2787`                             | EKSİK-DOKÜMAN |
| Bağımsızlık 3 katman + content_hash collusion     | 3 katman bağlı; **collusion kontrolü `_results_pair_hash_check` yalnız testten çağrılır** ve V8'de tek ajan tek zarf yazar, yön hash'lerini kernel sentezler (V07)                                       | `independence_check.py:67,170-228`; `plan_convergence.py:1570-1633` | DOĞRU         |
| Genesis: body'yi `aria-drafter` sentezler         | **Drafter'ı spawn eden kod yok**; `draft["body"]` yazan satır yok → materialize her zaman `materialize_requires_drafter_body` ile reddedilir                                                             | `agent_genesis.py:656-667`; `draft_intent.py:15`                    | EKSİK-KOD     |
| Sandbox ≥3 fixture, 3 olaylı audit                | Birebir                                                                                                                                                                                                  | `agent_genesis.py:251-300,564,648-654`                              | DOĞRU         |
| Bağımsız planlayıcılar                            | Primary ve challenger ikisi de `opus`/`max`; model çeşitliliği yalnız adversarial judge'da (glm-5.3) — echo-chamber ölçülür, önlenmez                                                                    | `.claude/agents/aria-*-planner.md`                                  | EKSİK-DOKÜMAN |

---

## 4. Neden "tam çalışmadı" — blokajlar

| #   | Blokaj                                                                                                                                                                                                                                                                                                         | Kanıt                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| B1  | **Gece cycle'ı 2026-09-21'den beri kırmızı** (run 179–183). Publish reddi `state_commit_surface_too_large:raw_findings`. Kök: `doc-staleness-adapter` 29 939 ham satır. Compactor fix (8028bbb0) main'de; yeşil cycle ile kanıtlanmadı. Cycle adımının kendi hata nedeni ayrıca çıkarılmalı (run 36055186584). | `autonomy_evidence.py:2543-2546`; `autonomy-closure-findings.json:425-432` (ARIA-HIGH-017)                                   |
| B2  | **Observe burn-in hiç tamamlanmadı**; tüm cycle'lar `standard`.                                                                                                                                                                                                                                                | `aria-auto-cycle.yml:824-825`; `CURRENT_STATE.md:192-195`                                                                    |
| B3  | **L1 = 30 observe başarısı**; scheduler tavanı `standard`.                                                                                                                                                                                                                                                     | `docs/aria/policy/autonomy-unlock.json:7-9`                                                                                  |
| B4  | **L2/L3 yapısal olarak açılamaz** — kabul olaylarının üreticisi yok (K10).                                                                                                                                                                                                                                     | `autonomy_ladder.py:84-90`                                                                                                   |
| B5  | **Değer zinciri kopuk:** 13 OPEN / 0 RESOLVED finding, 0 CONVERGED plan (12/15 terk), 94 mission (88 DISCOVERED), 8/8 merge blocked.                                                                                                                                                                           | aria/state §1                                                                                                                |
| B6  | 6 `task_commit_and_live` kapanış bulgusu canlı kanıt bekliyor (ARIA-CRITICAL-009, ARIA-CRITICAL-015 dahil).                                                                                                                                                                                                    | `docs/aria/policy/autonomy-closure-findings.json`                                                                            |
| B7  | 8 dormant kontrol (ORPHAN-HIGH-573; 2 tanesi 2026-10-09, 6'sı 2026-10-20'de dolar); 8 hiç-yazılmamış yüzey değeri (bitiş 2026-10-16); ORPHAN-CRITICAL-725 üreticisi ulaşılmamış.                                                                                                                               | `aria-kernel/control-reachability.dormant.json`; `surface-reachability.unwritten.json`; `closure-reachability-baseline.json` |
| B8  | Codex managed-auth + native dispatch açık; Z.ai credential runtime'a verilmemiş.                                                                                                                                                                                                                               | `CURRENT_STATE.md:94,98`                                                                                                     |
| B9  | Repo `.mcp.json` MCP'yi boş repo-içi `aria-tools`'a bağlıyor → yerel MCP gerçek durumu görmüyor; `search` `findings` türünü indekslemiyor.                                                                                                                                                                     | `.mcp.json:13-14`; `search.py:28,30-37`                                                                                      |

## 5. Kalan adımlar (sıralı)

Tam okuma turundan sonra (§8.1) sıra değişti: burn-in'den **önce** zinciri koparan kod hataları
kapanmalı, yoksa burn-in yalnız "algıla + yargıla" katmanını tekrar kanıtlar.

1. **Gece koşusunu yeşile döndür (§8.1-I):** `raw_findings`'i koşular arası dedup et ya da publish
   kontrolünden çıkar; run 36055186584'teki cycle hatasını çıkar.
2. **HUMAN_REQUIRED oy yolu (§8.1-A):** executor `verdict`'i zarfa taşısın ya da kernel
   `details.verdict`'i okusun **ve** panel principal kimliği (`ci-executor:gha-<RUN_ID>`) gerçek
   ajan kimliğine bağlansın — yalnız oy düzeltmesi hiçbir paneli kapatmaz (22/22 tam panel
   `panel_not_independent` düşerdi, V06).
3. **Planlama zinciri (§8.1-E, H):** challenger zarfının neden reddedildiğini/yanıtsız kaldığını
   çıkar (native Claude `provider_nonzero` kök nedenini governance'a yaz);
   `force_plan_human_required`'ın her durumda `max_rounds` etiketini düzelt; standard profilde V9
   implementer NoOp olduğundan uygulama için profil kararı gerekir.
4. **Merge ön-koşulları (§8.1-B, C):** `change_validated`'ı otomatik üret; attestation girdilerini
   workflow'lara geç (ephemeral runner ve `claude_auth` kontrolü ayrıca çözülmeli); readiness v3
   sözleşmesini tanımla ya da v2'ye bağla (§8.1-D, kapanış bulgusu ORPHAN-MEDIUM-789).
5. **Güvenlik (§8.2):** S1 (`lstrip`) ve S2 (sandbox'sız adaptör) — herhangi bir otonom merge
   açılmadan önce kapanmalı.
6. **Kurulum:** `aria-runner-capability-probe`; runner'da `claude auth status`;
   `vars.ARIA_MOCK_KILL_SWITCH`.
7. **İlk observe burn-in:** `aria-auto-cycle` → `mode=burn-in-observe, mock=false`; ≥20 geçerli
   cycle, eylem sıfır.
8. **Dormant/unwritten (B7):** 2026-10-09 / 10-16 / 10-20 son tarihlerinden önce bağla ya da sil.
9. **L1:** 30/30 observe kabulünden sonra operatör
   `aria-kernel profile set --profile standard --scheduler-ceiling strict --operator-approval-ref <ref>`.
10. **L2/L3 üreticileri + `critical_violation` üreticisi (K10, §8.3)**, ardından canlı-kanıt kapanış
    bulguları (B6).
11. **MCP (B9):** aria/state checkout'una yönlendir; `findings` kaynağını ekle.

---

## 6. Ajan / dispatch / LLM çağırma yolu

**Gerçek zincir** _(V11 düzeltmesi: CI yolunda workflow `ci_executor.py --drain`'i doğrudan çağırır
ve isteği kendisi claim eder, lease ~6 333 s; `planner_dispatch_hook` yalnız daemon yolundadır)_:
daemon ya da `aria-agent-executor.yml` (`[self-hosted, linux, claude]`, cron 02:29) →
`planner_dispatch_hook` claim (`ARIA_LEASE_TOKEN` yalnız env ile) → `tools/aria-poc/ci_executor.py`
alt süreci → `_adaptive_pre_claim_admission` sağlayıcı seçer (`ci_executor.py:4383-4411`) → native
`_invoke_native_{claude,codex,zai}` (`:4896-4907`) veya legacy `invoke_claude_cli` (`:1805`).

| Sağlayıcı | Çağrı                                                                                                                                                             | Auth                                                                                                                             | Kanıt                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Claude    | `claude -p --output-format stream-json --model opus --effort max` + okuma şekli `--tools Read,Grep,Glob` veya yazma şekli; **bwrap sandbox** içinde; prompt stdin | `claude auth status` → `authMethod == "claude.ai"` (managed abonelik); `ANTHROPIC_API_KEY/AUTH_TOKEN/BASE_URL` görülürse **red** | `claude_runtime.py:172-177,500-518,554-603,1287-1375`; `status_answers.py:43,88-92` |
| Codex     | `codex exec --json` (`gpt-5.2-codex`), salt-okuma                                                                                                                 | managed auth — **açık**                                                                                                          | `codex_runtime.py:46,93,259`; `CURRENT_STATE.md:94`                                 |
| Z.ai      | OpenAI-uyumlu HTTP (urllib), adversarial judge `glm-5.3`                                                                                                          | `ARIA_ZAI_API_KEY_FILE` (0600)                                                                                                   | `zai_runtime.py`                                                                    |
| Mock      | `CLAUDE_CLI_MOCK=1` → yer tutucu zarf; worker sahte commit                                                                                                        | `vars.ARIA_MOCK_KILL_SWITCH` önce okunur                                                                                         | `ci_executor.py:1861-1930`; `worker_executor.py:115-145`                            |

`hook_broker.py` ("broker socket") LLM API'si değil: Claude Code hook'larını sandbox dışında unix
socket ile yanıtlar (`hook_broker.py:1-40`). Model düşürme merdiveni yok (bkz. K6).
`ci_executor_contract_proven.md:152` hâlâ `verified_at_commit: PENDING-OPERATOR-LIVE-INVOCATION`.

**Canlı çalıştırma şartları:** self-hosted runner + claude.ai managed oturumu + bwrap + unprivileged
userns + root olmayan kullanıcı. (Bu analiz container'ında `ANTHROPIC_BASE_URL` set,
`authMethod: oauth_token`, `bwrap`/`codex` yok, uid 0 → preflight `claude_api_key_mode_disallowed`
ile fail-closed reddeder. Bu, runner'ın değil analiz ortamının durumudur; kapıların doğru
çalıştığını gösterir.)

**Ajana verilen bağlam** (`render_invocation_prompt`, `agent_invocations.py:899-1033`):
must_satisfy, **evidence_refs** (yalnız bunlar kanıt), allowed/forbidden scope, impact graph,
validation komutları, mint anında `target_sha`'dan birebir alıntılanan
`<untrusted_evidence_excerpt … content_hash>` blokları (`:434-520`), path'e göre filtrelenmiş
beliefs/conventions/anti-patterns/geçmiş başarısız denemeler (`:240-267,544,598`), repo haritası.
Yargıç/arbiter profilleri kısıtlı allowlist (Read/Grep/Glob) ile çalışır; planlayıcılar
Read/Grep/Glob'a ek olarak `aria` MCP'yi taşır ve deny-list + `--dangerously-skip-permissions` ile
koşar (V11).

---

## 7. ARIA ≠ RAG — kanıtlı fark

| Boyut                  | RAG                                     | ARIA                                                                                                                                                                                                                               | Kanıt                                                                                                  |
| ---------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Temel döngü            | sorgu → benzer chunk getir → LLM üretir | deterministik adaptör/çıkarıcı aday üretir → LLM **yargıç** doğrular → kanıt git blob'una karşı hash ile doğrulanır                                                                                                                | `poc.py:4` ("No LLM"); `evidence_trust.py:276-301`                                                     |
| Doğruluk kaynağı       | getirilen metin (varsayılan doğru)      | commit SHA'daki git blob hash eşitliği (`repo_verified`); ajan çıktısı **veri**, hakikat değil                                                                                                                                     | `evidence_validator.py:540`; `convergence_drainer.py:305-306`                                          |
| Kendi çıktısı          | tekrar indekslenip bağlam olabilir      | `self_output` önekleri **asla kanıt olamaz**                                                                                                                                                                                       | `evidence_trust.py:13-23`                                                                              |
| Bilgi deposu           | vektör indeksi (durumsuz)               | hash-zincirli append-only ledger'lar + belief state machine (durumlu)                                                                                                                                                              | `ledger.py:1241-1318`; `memory.py:22-23`                                                               |
| Bayatlık               | bayat chunk sessizce döner              | belief `supported → needs_revalidation → stale` (diff, 90 g TTL, head-distance, karantina) → pressure'a yükselir                                                                                                                   | `memory.py:756-990`                                                                                    |
| Tekrar                 | aynı chunk çok gelirse ağırlık artar    | _(V06: çürütüldü)_ destek artışı (`+0.005`) yalnız kanıt hash'i değişince gelir, **ama** feedback düzeltmesi (+0.05/TP) ve ceza terimleri her kayıtta önceki güvene yeniden eklenir → tekrar güveni dolaylı olarak değiştirir      | `memory.py:614-647,1374-1389`                                                                          |
| Benzerlik ölçüleri     | retrieval'ın kendisi                    | çoğunlukla **filtre/çeşitlilik**: echo-chamber tespiti (3-gram Jaccard >0.85), dedup (token-cosine ≥0.62). **İstisna (V12):** gece seed yolunda enum drift'i Jaccard ≥0.3 eşleşmesiyle doğrudan kanonik finding olur (F-001…F-008) | `poc.py:940-963` → `seed_drift_findings.py:225`; `independence_check.py:22-24`; `semantic_dedup.py:17` |
| Embedding              | çekirdek                                | **Yok.** `semantic_memory` soketi `ARIA_EMBEDDER_CMD` yoksa no-op; hiçbir workflow tanımlamıyor; aria/state'te `embeddings.jsonl` yok                                                                                              | `semantic_memory.py:1-22`                                                                              |
| Arama                  | vektör ANN                              | SQLite FTS5 + `bm25()`, 6 ledger üzerinde; "an index, not a truth source"; indeksi yalnız CLI ve MCP okur (`context_compiler`'ı beslemez)                                                                                          | `search.py:8-13,59,120-121`                                                                            |
| Bağlam enjeksiyonu     | chunk'lar prompt'a talimat gibi         | `context_compiler` geçmiş kararları sözcüksel sıralar, `<derived_context>` **veri** bloğu olarak hash'e bağlar; ajan repoyu kendisi Read/Grep ile okur                                                                             | `context_compiler.py:1-15,164-186`                                                                     |
| Halüsinasyon savunması | yok / prompt                            | yapısal: kanıtı doğrulanamayan yanıt reddedilir (aria/state'te reddedilen 30 sonucun 24'ünde `agent_evidence_not_repo_verified`)                                                                                                   | `autonomy_orchestrator.py:210-215`                                                                     |

**Tek cümle:** RAG "bulduğumu modele ver, modelin söylediğine güven"dir; ARIA "modelin söylediği her
`file:line`'ı commit'li blob'a karşı kanıtla, kanıtlanamayanı reddet, kendi çıktını asla kanıt
sayma, bilgiyi durumlu ve çürüyebilir tut"tur. RAG-benzeri parçalar (FTS5 arama, isteğe bağlı
embedding sıralaması) yalnız **bağlam/öncelik** için vardır. Tek istisna mekanik seed yoludur: enum
drift'i LLM yargısı olmadan finding'e dönüşür (bkz. §8.1 ve F-001…F-008) — bu, RAG değil ama "kanıt
yerine benzerlik" riskidir.

---

## 8. Tam okuma turu (12 ajan, 400/400 dosya) — yeni bulgular

Ham raporlar: `docs/aria/reviews/2026-09-25-aria-tam-okuma/B01.md … B12.md`. Aşağıdaki her madde
orada `file:line` ile kanıtlıdır. **✔** işaretliler bu kayıt yazılırken ayrıca elle yeniden
doğrulandı.

### 8.1 Değer zincirini fiilen tıkayan kök nedenler

"ARIA neden tam çalışmadı?" sorusunun kod düzeyindeki cevabı. İkinci tur (§9) sonrası: A, C,
E(challenger), G, H, K canlıda zinciri **fiilen** durduranlar; B ve D kodda gerçek ama canlıdaki
blokların nedeni değil (merge daha önceki kapılarda duruyor).

| #    | Kopukluk                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Etki (canlı)                                                                                                                                                                         | Kanıt                                                                                                                                                      | Rapor    |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| A ✔ | **HUMAN_REQUIRED paneli oyu okuyamıyor.** Kernel oyu artefaktın üst-düzey `verdict` alanından okur; executor zarfa yalnız `evidence_refs/details/notes/plan_content` taşır, ajanlar oyu `details` altına yazar (80 yanıtın 54'ü `details.verdict`, 12'si `details.adjudication`, 14'ü yalnız serbest metin). Testler yeşil, çünkü `test_y7_self_adjudication.py:119` artefaktı elle üst-düzey verdict ile yazar. **Oy okunsa bile** paneller düşer: 35 tam panelin hepsinde en az bir koltuk çifti, 24'ünde üçü de aynı principal (V06).                                                                                                                             | 968 `panel_incomplete`; 136 panel açıldı, 101'i `reopen_exhausted`; 113 kaydın hiçbiri kapanmadı; 2026-08-25'ten beri kabul edilen panel yanıtı yok                                  | `human_required_adjudication.py:434`; `ci_executor.py:2672`                                                                                                | B06      |
| B ✔ | **Runner attestation hiç yazılamıyor.** `probe-runner-attestation` 4 girdiyi `required` tanımlar; workflow'lar yalnız `tools-dir` geçer (composite action'da `required` zorlanmaz) → `ephemeral=false` → kayıt reddedilir. Girdiler geçilse de kalıcı self-hosted runner ephemeral değil ve `claude_auth` yalnız `CLAUDE_CODE_OAUTH_TOKEN` env'ine bakar (V01).                                                                                                                                                                                                                                                                                                      | Kodda merge'ü bloklar; **canlıdaki 8 blok bu nedenle değil** — merge profil/unlock/readiness kapılarında daha önce durur, `enterprise/readiness-claims.jsonl` canlıda yok (V01, V08) | `aria-auto-cycle.yml:558-559`; `aria-agent-executor.yml:563`; `.github/actions/probe-runner-attestation/action.yml:30-48`; `runner_attestation.py:209-249` | B08      |
| C    | **`change_validated` satırını otomatik yazan kod yok** (yalnız manuel `change validate` + backfill); auto-merge üçlü kapısı ve `change_outcome` bu satırı şart koşar.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Zincir "committed"da durur                                                                                                                                                           | `cli.py:5303`; `auto_merge.py:551-555`; `change_outcome.py:514-517`                                                                                        | B03      |
| D    | **`enterprise_readiness` kalıcı `operator_blocked`:** kontrol v3 readiness-claim sözleşmesi arar, yalnız v2 tanımlı, v3 üreticisi yok. 7 yeteneğin 4'ü yapısal olarak `live_proven` olamaz. _(V02)_ Bu durumu yalnız `autonomy status --evidence` CLI'ı okur; hiçbir merge kapısı okumaz.                                                                                                                                                                                                                                                                                                                                                                            | Kapanış bulgusu ORPHAN-MEDIUM-789 hiç karşılanamaz; evidence genel durumu hep `operator_blocked`                                                                                     | `autonomy_evidence.py:1165-1178,3626-3653`                                                                                                                 | B02      |
| E ✔ | **Hiçbir plan 1. turu geçemiyor:** challenger zarfları reddediliyor ya da yanıtsız kalıyor. Plan terklerinin 12/12'si 72 **saat** durgunluk kuralından (11'i 2026-08-16T20:11'deki tek benimseme taramasında, CL-1 öncesi yetim planlar); 2'si round 1'de `convergence_envelope_dead:challenger_plan` ile HUMAN_REQUIRED (yanıltıcı biçimde `max_rounds_reached:true` etiketiyle, `plan_convergence.py:1018-1023`); 1'i DRAFT'ta. Gece tavanı 2 tur (CLI varsayılanı) doğru ama canlıda hiç devreye girmedi; 300 s challenger timeout'u drainer'ca yok sayılır (`convergence_drainer.py:569`). Plan CONVERGED olsa bile standard profilde V9 implementer NoOp (V04). | 0 CONVERGED                                                                                                                                                                          | `plan_convergence.py:960-1001,1018-1023`; `cli.py:2377-2388`; `convergence_drainer.py:569`                                                                 | B04, B07 |
| F    | **CONVERGED → dispatch terfisi yalnız operatör CLI'ı ile** (`acknowledge=True`); varsayılan `allowed_scope` READONLY çekirdek, ürün kodu yasak. Operatör onay şeridi (`approve_proposal`) yalnız testte.                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Otomatik uygulama yolu yok                                                                                                                                                           | `promotion_controller.py:176-177`; B08 §5                                                                                                                  | B08      |
| G    | **Mission'ı DISCOVERED'dan ileri taşıyan üretim yolu fiilen yok** (tek otomatik yol — PR'daki `ARIA-Mission:` trailer'ı → merge'de MAIN_VERIFYING — ARIA PR'ı açılmadığı için hiç tetiklenmedi); seçim operatör `priority`'siyle, Thompson fiilen devre dışı (V07).                                                                                                                                                                                                                                                                                                                                                                                                  | 94 mission: 88 DISCOVERED · 6 SUPERSEDED                                                                                                                                             | B07 §1, §9                                                                                                                                                 | B07      |
| H    | **Kuyruk kaybı:** 1 171 isteğin 610'u `anchor_expired` (525'i hiç claim edilmeden; 528'i Ağustos'un 3 günlük pencere döneminde, 7 gün override'ı sonrası 82); native Claude rotası 227 `provider_nonzero` / 73 başarı; `native_runtime_execution_unavailable` 266 + `claude_cli_exit_1` 197 release — harness-sınıfı sayıldığından requeue bütçesi hiç yanmaz, kök neden governance'a değil yalnız stderr'e yazılır.                                                                                                                                                                                                                                                 | Planlama zarfları yanıtlanmıyor                                                                                                                                                      | `agent_invocations.py:2874,3129-3134`; `release_reason.py:125,151`                                                                                         | B01, B11 |
| I    | **Publish reddi** `raw_findings` boyutundan: ham ledger 34 500 satır / 3 253 benzersiz parmak izi; publish kontrolü teşhis amaçlı bir sayım için cycle yayınını bloklar (executor publish'leri geçer). Compactor dedup'ı (8028bbb0) main'de, henüz yayımlanmadı; kesin sınırın 64 MiB yüzey mi 80 MiB toplam mı olduğu run logu olmadan doğrulanamadı (V02).                                                                                                                                                                                                                                                                                                         | 2026-09-21'den beri gece koşuları kırmızı                                                                                                                                            | `autonomy_evidence.py:593-596,2543-2554`                                                                                                                   | B02, B11 |
| J    | **Backlog freni kör:** `cycle_guard` bulguları checkout'taki `aria-findings/`'ten sayar, yazım store'a gider → sayaç yapısal olarak 0 (canlıda 13 OPEN).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Cap 25 ve boş-cycle koruması hiç tetiklenmez                                                                                                                                         | `cycle_guard.py:56-62`; `finding.py:133-146`                                                                                                               | B04, B12 |
| K    | **Lane-A/B bulguları ARIA'ya hiç akmıyor:** `docs/reviews/_registry/findings.jsonl` 2 159 satır, eşik 500, onay bayrağı geçilmediği için hook `ValueError` atar; eşik cache okunmadan önce kontrol edildiği için operatörün `--confirm-large-backfill --acknowledge` bayrağı da cycle hook'unu açmaz (V08).                                                                                                                                                                                                                                                                                                                                                          | 42 kayıtlı hata                                                                                                                                                                      | `report_ingestion.py:53-54`; `learning.py:96`                                                                                                              | B08      |

### 8.2 Güvenlik bulguları

| #     | Bulgu                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Kanıt                                                               | Rapor         |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------- |
| S1 ✔ | `auto_merge._normalize_path` `lstrip("./")` baştaki tüm noktaları siler: `.github/workflows/x.yml` → `github/workflows/x.yml`, `.env.prod` → `env.prod`; yasak desenler eşleşmez, `.claude/agents/aria-implementer.md` L3 yerine **L1** lane'ine düşer (risk_class `*.md` glob'u yüzünden zaten low). Kök `.env*` `**/.env*` deseni yüzünden `lstrip`'ten bağımsız hiç eşleşmez; `.github/*.yml` yalnız "unknown" sınıfı sayesinde bloklanır. Aynı hata `pr_manager._normalize_path`, `service_dimension.py:108`, `architecture.py:450` ve `convergent_skill_authoring.py:926`'da (V02). | `auto_merge.py:1250-1251`                                           | B02, B08, B09 |
| S2 ✔ | LLM'in yazdığı adaptör **sandbox'sız** koşar (düz `subprocess.run`, workspace cwd, tam env); `skill_genesis_sandbox` (bwrap + AST) üretimde çağrılmıyor. Skill "≥3 fixture" kontrolü `## Fixture:` başlığı saymaktan ibaret. **Bugün erişilemez (latent):** LLM kaynağı runner'a hiç ulaşmaz (normalize taslakta `adapter_path` yok, `_base_dir` yazılmaz, canlıda 20/20 istek `convergent:false`); yol onarılırsa LLM'in verdiği `draft_id` çalıştırılan dosya olur — sandbox aynı düzeltmede eklenmeli. `skill_genesis_drainer.py:447-450` yorumu tersini söyler (V04, V09).           | `skill_genesis.py:389-408,567-574`; `dispatcher_factory.py:241-263` | B04, B09      |
| S3    | Native rotada egress kontrolü atlanır: `_pre_claim_environment_gate` çalışmaz, sandbox `allow_network=True`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `ci_executor.py:4423`; `claude_runtime.py:750`                      | B11           |
| S4    | `verification_gate` ajanın worktree'sinde komutları tam `os.environ` (GH_TOKEN dahil) ile, sandbox'sız, timeout'u hook'un geniş `except`'i yakalar ama claim'i bırakmaz ve doğrulama satırı yazmaz; `--allow-legacy-no-token` lease kontrolünü atlar. İşçi hangi zorunlu komutları koşacağını kendisi seçer (yalnız alt küme kontrolü). Worker dispatch yolu canlıda hiç koşmadı — latent (V10).                                                                                                                                                                                         | `verification_gate.py:303-309`                                      | B10           |
| S5    | Karantinadan kaçış: `tool promote --target-status SHADOW` kök neden/fixture/onay olmadan geçer; `promotion.py:106` `evidence_chains_valid=True` sabit geçirir.                                                                                                                                                                                                                                                                                                                                                                                                                           | `tool_registry.py:1388-1491`; `promotion.py:106`                    | B10           |
| S6    | Prompt sınırı: `<untrusted_evidence_excerpt>`, cross-review/primary-revizyon/critic plan metni kaçışsız gömülür (base64 yalnız implementation prompt'unda); twin intent `<derived_context>` + "DATA" uyarısıyla sarılı ama kaçışsız (V10).                                                                                                                                                                                                                                                                                                                                               | `agent_invocations.py:523,653-686`; `twin.py:938-1002`              | B01, B04, B10 |
| S7    | Görev ayrımı (uygulayıcı ≠ inceleyici) fiilen yok: `forbidden_agent_ids` yazan üretim kodu yok. Bağımsızlık "principal"i `ci-executor:gha-<RUN_ID>` — tam claim edilmiş 35 panelin 35'inde en az bir koltuk çifti, 24'ünde üç koltuk aynı principal (V06).                                                                                                                                                                                                                                                                                                                               | `ci_executor.py:4351`                                               | B01, B06      |
| S8    | Ack jetonu taslağa bağlı değil (`draft_id/target_path` denetlenmez); auto-promote token'ı süresiz ve tekrar kullanılabilir; "imzalı insan etiketi" kernel'in kendi anahtarıyla imzalanır.                                                                                                                                                                                                                                                                                                                                                                                                | B01 §4; B06 §5                                                      | B01, B06      |
| S9    | `gh_token_factory` `contents:write` tüm kurulum depoları/dallarında geçerli ("yalnız `aria-impl-*`" iddiası yanlış); Mode B'de teslim jetonu operatör PAT'i.                                                                                                                                                                                                                                                                                                                                                                                                                             | `gh_token_factory.py` (B05 risk listesi)                            | B05           |
| S10   | Gateway: `tick()` try dışında (daemon düşer), replay penceresi kullanılmıyor, hız sınırı auth'tan önce, "aria" etiketli her issue doğrulanmadan priority=1 mission açar (etiket için triage yetkisi gerekir). systemd `Restart=on-failure` çökmeyi iz bırakmayan döngüye çevirir. Ek: `/aria/status` nginx üzerinden kimliksiz açık (`droplet.conf:214-216`, V05).                                                                                                                                                                                                                       | `gateway/` (B05 risk listesi)                                       | B05           |
| S11   | Plan 033 güvenlik paketi (23 dosya) hiç koşmadı; RLS kontrolü yalnız 20 `.sql` okur, 468 TS migration'ı görmez; gerçek repoda farm-service ve db-migrate için 3 lead üretir, diğer her servise `TESTED_NO_VIOLATION` verir. Hiçbir workflow koşturmaz (V09).                                                                                                                                                                                                                                                                                                                             | B09 §4                                                              | B09           |
| S12   | `CREDIT_ERROR_MARKERS` "billing", `AUTH_FAILURE_MARKERS` "not authenticated" içerir; bu repoda billing/auth servisleri var → yanlış sağlayıcı soğutma / auth failover. Yanlış kredi eşleşmesi koşuyu `credit_exhausted` yapar ve drain'in kalıcı breaker'ı (anthropic, opus) rotasını tüm gece atlar; native Claude denemelerinin %67'si exit 1 olduğundan "nonzero exit" koruması az şey süzer. Codex'te aynı sorun (`CODEX_QUOTA_MARKERS` "billing") (V11, V12).                                                                                                                       | `claude_runtime.py:1780,1807,1992`                                  | B11           |

### 8.3 Ölü / bağlı olmayan kod (şemalarda çalışıyor gibi çizilen)

- `self_modification.request_kernel_change` (Şema 18 "tek yasal yol") — çağıranı yok; bağlı yol
  gateway → self_improvement mission → `record_self_change_result`, ama canlıda hiç tetiklenmedi;
  üretimde canlı koruma `implementation_safety._check_kernel_self_modification_at_mint` (`:2893`)
  (B09, V09).
- `execution_spine.py` (Şema 22 "birleşik aktör kimliği") — yalnız test; `ARIA_ACTOR` hiçbir yerde
  set edilmez, runner `{"kind":"human"}` kaydedilir (B05, B11).
- `external_outage_reaper.py` (Şema 5/20) — çağıranı ve `api_backoff_exhausted` üreticisi yok (B05).
- `plan_round_controller.advance_plan_rounds` (Şema 3 "tur sürücüsü") — yalnız CLI; açtığı
  cross-review turu köprüde kırılır; planner zarfları üretimde yeniden basılmaz (`remint_of` yalnız
  next-cycle-queue projeksiyonunda, `autonomy_orchestrator.py:237-283`) (B04, B07, V04).
- `_results_pair_hash_check` (collusion) — yalnız test (B07).
- `enforce_expert_consensus_gate` — çağrılmıyor; uzman kapısında 0-ref "satisfied" onay ve eksik
  `confidence` (1.0 sayılır) geçer (`worktree_candidate`/`self_output` ref'leri kabul anında zaten
  reddedilir, V05); Gate C seçim haritasında 27 uzman (roster 107 dosya) (B05, B09, V09).
- `recursive_impact` — hiçbir kapıya bağlı değil; `impact_graph` `.nx` grafiğini okumaz (B06, B08).
- `reserve_cycle_budget`, `ProfileGate.evaluate`, `CostTelemetryHook.record` — çağrılmıyor (B02,
  B04).
- `prune_worktrees` — reducer `completed/cancelled/expired` üretmez; `cancel_dispatch_request`
  etkisiz (B10).
- `worker_dispatch_hook` merge dalı `{"decision":"blocked"}` literali (B10).
- `agent_priors.map_agent_priors`, `model_fleet.assign_mixed_models` (modülün geri kalanı bağlı),
  `db_snapshot`, `instinct_candidate`, `lane_classifier`, `llm_bridge`, `impact.py` — üretimde
  çağrılmıyor (B01, B06, B07, B12).
- `cqrs`/`outbox`/`banned_phrase` adaptörleri (Şema 10 "gerçek adaptörler") — canlı registry'de yok,
  hiç koşmadı (B11, B12).
- Circuit breaker'ın 9 hata türünden 5'inin üreticisi yok; `breakers/` yayımlanmaz (B03).
- `critical_violation` üreticisi yok → "sıfır kritik ihlal" hep doğru (B02).
- Ajan değerlendirmesi: 25/25 koşu mock ve mock zarf beklenen verdict'i kopyalar (B01).

### 8.4 Yeni doküman kaymaları (seçme)

| Doküman                                          | Kod                                                                                                                                                         | Rapor    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Ritim 6 saat, günde ≤4 cycle (Şema 1)            | Etkin override **2 saat**, tavan 12/gün (`aria-config/genesis_policy.json:13-15`)                                                                           | B04, B12 |
| Gate A ≤5 tur (Şema 3)                           | Gece 2 tur (canlıda hiç devreye girmedi); yakınsama tek cycle'da değil cycle'lar arası adım adım                                                            | B02, B04 |
| PR açılışında 18 hard-fail                       | PR anında 11, merge öncesi 7; 11'in 4'ü üretimde boş geçer; `IMMUTABLE_AGENT_FILE_HASH_REGISTRY` boş                                                        | B06      |
| Watchdog merge'ü dondurur (Şema 7)               | Donduran dış watchdog'un GitHub issue'su (`watchdog_freeze.py`), `aria_watchdog` değil                                                                      | B02, B10 |
| CAS host kirası (Şema 15)                        | Orkestratör düz `autonomous-host.lock` kullanır; CAS kirası kilitsiz oku-yaz                                                                                | B02      |
| Bağlam bütçesi kapısı (Şema 22)                  | Üretimde `enforce_context_budget=False` — yalnız ölçer                                                                                                      | B01, B03 |
| Prompt v3 (Şema 5)                               | v6                                                                                                                                                          | B01      |
| Requeue ≤2 → STALE (Şema 5)                      | HUMAN_REQUIRED; harness-sınıfı release'ler bütçe yakmaz                                                                                                     | B01      |
| Lease 1800 s                                     | CI/drain yolunda ~6 333 s (implementation +13 410 s), executor job 510 dk; daemon yolunda hâlâ 1 800 s ve executor 1 680 s'de öldürülür (V11)               | B11      |
| Telemetri ~25 metrik; workflow sözleşmesi 9 lane | ~43 metrik; 10 workflow / 11 job                                                                                                                            | B10      |
| Deney masası iddiayı test eder (Şema 12)         | Proje genelinde `nx test`; herhangi bir kırmızı test CONFIRMED yapar; RESOLVED'a otomatik üretici yok                                                       | B05      |
| Pressure Beta-Binomial kalibrasyonu              | Sayaç `tool_id`'ye göre, `SOURCE_WEIGHTS` anahtarlarıyla eşleşmez → çarpan hep 1.0                                                                          | B03      |
| `closure_reachability` "asla büyümez"            | `--write` o anki tüm ihlalleri iğneler                                                                                                                      | B03      |
| Model: codex `gpt-5.2-codex`                     | Native admission openai rotasını `gpt-6-astra/ultra` ile kurar                                                                                              | B07      |
| Belief güveni "tekrar kanıt değildir"            | Feedback/ceza terimleri her kayıtta önceki güvene yeniden eklenir; diff-decay güveni düşürmez                                                               | B06      |
| Architecture spine her cycle                     | `PLAN_ID_PRESENT` koşulu, hiçbir üretim çağıranı `plan_id` geçmez → nightly'de hiç koşmaz; entity kontrolü ADR-011 per-tenant entity'leri (197) ihlal sayar | B02, B04 |

### 8.5 İlk turun (§0–§7) düzeltmeleri

- "Kalıcı finding 0" → yalnız `tools/findings.jsonl` için; kanonik depoda **13 OPEN** (B05, B08,
  B12).
- "Mission olayı 0" → **117** satır, 94 mission: 88 DISCOVERED · 6 SUPERSEDED (B07, V07).
- "11 adaptörün hepsi SHADOW" → manifestler öyle der; **canlı registry** 7 CALIBRATE · 2 SHADOW · 1
  QUARANTINED, lint-rules kayıtsız (B11). Nightly `register_tool` canlı durumu korur;
  `registry_compiler` yalnız CLI (V10, V11).
- §3.1 frozen kapsamı "yalnız Plan-020, eski yazıcılar dışarıda" → Plan-020 artık manifestten türer
  ve tüm gözlem yüzeylerini kapsar (B09).
- §3.5 "`maintenance_utility` dispatch edilemez" → gece drain'i dispatch eder, canlıda 24 kabul
  edilmiş sonuç var; genesis gövdesini yazan kod yine de yok (B02).
- §3.4 "ACTIVE'e 3 yetki" doğru, ama `promotion.py:106` `evidence_chains_valid=True` sabit geçirir
  (B10).
- §2 K15 "18 hard-fail" doğru, ama PR anında yalnız 11'i koşar (B06).

---

## 9. İkinci tur — adversarial doğrulama (12 ajan)

Birinci turun her iddiası kodda ve `origin/aria/state @ e6f462fb`'de yeniden sınandı (ajanlar
raporun alıntısına değil, kodun kendisine baktı; "ölü kod" iddialarında tüm repo dinamik çağrılar
dahil grep'lendi). Ham doğrulama raporları:
`docs/aria/reviews/2026-09-25-aria-tam-okuma/dogrulama/V01.md … V12.md`.

| Ajan    | İddia     | Doğrulandı    | Kısmen        | Çürütüldü   | Doğrulanamadı |
| ------- | --------- | ------------- | ------------- | ----------- | ------------- |
| V01     | 88        | 68            | 18            | 1           | 1             |
| V02     | 97        | 69            | 19            | 7           | 2             |
| V03     | 96        | 81            | 15            | 0           | 0             |
| V04     | 99        | 83            | 15            | 0           | 1             |
| V05     | 102       | 86            | 14            | 1           | 1             |
| V06     | 86        | 68            | 15            | 2           | 1             |
| V07     | 106       | 88            | 15            | 2           | 1             |
| V08     | 85        | 64            | 17            | 1           | 3             |
| V09     | 86        | 64            | 21            | 0           | 1             |
| V10     | 84        | 66            | 14            | 2           | 2             |
| V11     | 73        | 54            | 15            | 4           | 0             |
| V12     | 103       | 85            | 14            | 4           | 0             |
| **Top** | **1 105** | **876 (%79)** | **192 (%17)** | **24 (%2)** | **13 (%1)**   |

### 9.1 Çürütülen iddialar (bu kayıtta ve şema dokümanında düzeltildi)

| Kaynak                         | Çürütülen iddia                                                                                                                                             | Gerçek                                                                                 | Doğrulayan |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------- |
| Ana kayıt §3.5                 | "round ≥3 + yeni risk → HUMAN_REQUIRED"                                                                                                                     | yalnız ölü CRITIQUED yolunda                                                           | V07        |
| Ana kayıt §3.5                 | content_hash collusion "Birebir / DOĞRU"                                                                                                                    | `_results_pair_hash_check` yalnız testte                                               | V07        |
| Ana kayıt §1, §8.5; MIMARI Ş10 | "`registry_compiler` canlı durumu ezer"                                                                                                                     | yalnız CLI; nightly `register_tool` canlı durumu korur                                 | V10, V11   |
| Ana kayıt §7; MIMARI Ş25       | "güven yalnız kanıt hash'i değişince artar"                                                                                                                 | feedback/ceza terimleri her kayıtta yeniden eklenir                                    | V06        |
| Ana kayıt §7; MIMARI Ş25       | "44 × `agent_evidence_not_repo_verified`"                                                                                                                   | 44 bir kod yorumundan; canlıda 30 red sonucunun 24'ünde                                | V12        |
| Ana kayıt §7                   | "hiçbir benzerlik skoru bir bulguya karar vermez"                                                                                                           | seed yolunda Jaccard ≥0.3 doğrudan finding basar (F-001…F-008)                         | V12        |
| MIMARI Ş23                     | "11 adaptör · hepsi SHADOW"                                                                                                                                 | 9 adaptör × 12 koşu; canlı 7 CALIBRATE · 2 SHADOW · 1 QUARANTINED                      | V12        |
| Ana kayıt §4 B5; MIMARI Ş24    | "0 finding / 0 mission"                                                                                                                                     | 13 OPEN finding; 94 mission                                                            | V12        |
| Ana kayıt §8.1-D               | "merge ön-koşulu hiç sağlanamaz"                                                                                                                            | `operator_blocked`'ı yalnız CLI okur; hiçbir merge kapısı değil                        | V02        |
| Ana kayıt §1 huni              | "2 755 benzersiz" (tüm ham bulgu)                                                                                                                           | 2 755 yalnız doc-staleness; toplam 3 253                                               | V11, V12   |
| B01                            | `agent_network` "yalnız CLI"                                                                                                                                | her cycle learning hook'unda koşar                                                     | V01        |
| B02                            | `architecture.py` yalnız CLI; `parse_plan_converged_approval_ref` yalnız test; N16 maliyet karışımı; 8 auto-merge `enabled=False`; glm tier sırası belgesiz | hepsi yanlış — ayrıntı V02                                                             | V02        |
| B05                            | `path:line:<alıntı>` alıntısı doğrulanmaz                                                                                                                   | üçlü ref bütünüyle `missing` sayılıp reddedilir                                        | V05        |
| B06                            | (2 madde) ayrıntı V06                                                                                                                                       |                                                                                        | V06        |
| B08                            | `pr_tracking._impacted_adapters` hep boş                                                                                                                    | `{fixture_set}/**` deseni izlenen fixture yollarıyla eşleşir                           | V08        |
| B10                            | cross-review plan metni base64'lü                                                                                                                           | kaçışsız; base64 yalnız implementation prompt'unda                                     | V10        |
| B11                            | "canlıda kredi olayı yok"; batch judge yanlış sağlayıcı                                                                                                     | 21 `model_credit_fallback_attempted` (Ağu 19–21); batch yapısal olarak Z.ai'ye kilitli | V11        |
| B12                            | "7 modülün testi yok"                                                                                                                                       | gerçek liste 4: `db_snapshot`, `draft_pii_filter`, `incident_ledger`, `phase2_utils`   | V12        |

> **Ham B-raporları hakkında:** `B01…B12.md` birinci turun değiştirilmemiş çıktısıdır.
> Çürütülen/kısmi maddeler ve bazı uydurma satır referansları (ör. B04'te `cycle_guard.py:191-209`,
> dosya 166 satır; B08'de `registry_compiler.py`/`review_record.py` dosya sonunu aşan satırlar;
> B09'da `remediation.py:271`, dosya 154 satır) ilgili `V*.md`'de düzeltilmiştir. Çelişkide **V
> raporu ve bu kaydın güncel metni geçerlidir.**

### 9.2 İkinci turun yeni bulguları (birinci turun kaçırdıkları)

- **Skill genesis yapısal olarak adaptör üretemez:** taslak gövdesi hep `None`, drafter yanıtı hiç
  okunmaz; materialize hiçbir zaman olmaz (V04, V09).
- **`pr_tracking._mark_findings_for_revalidation`** (`pr_tracking.py:394`) beyanlı `findings.jsonl`
  üzerinde ham `rewrite_jsonl` kullanır →
  `LedgerIntegrityError: raw_jsonl_declared_surface_rewrite_rejected`; ledger boş olduğu için henüz
  patlamadı (aynı hata `feedback_store`'da ORPHAN-670 ile düzeltilmişti) (V08).
- **`plan_synthesizer.py:385`** hâlâ `path:line:snippet` üretir, ama bu biçim artık reddediliyor
  (`evidence_validator.py:37-47` kabulü fiilen geri alınmış) (V05).
- **AI consensus kanıt boşluğu:** `judgment_bridge.py:365` yargıç ref'lerini
  `details.verdict.evidence_refs`'ten alır; bu alan kabul anındaki doğrulamaya girmez (V05).
- **`record_and_continue` fazının hatası da halt zincirini tetikler:** `_first_phase_failure` her
  `failed` fazı sayar; ör. `mission_reconcile` hatası memory→reflection arasındaki tüm halt
  fazlarını atlatır (V03).
- **`checkpoint.restore_checkpoint(files=…)`** yolu resolve etmez → `../` ile workspace dışı dosya
  silinebilir (yalnız operatör CLI'ı) (V03).
- **Tool yaşam döngüsü geçişleri denetim izi bırakmaz;** ACTIVE'den çıkışta kontrol yok; nightly
  manifest sync `last_transition`'ı siler (V10).
- **Daemon yolunda** executor 1 680 s'de öldürülür, Claude CLI 1 800 s'ye kadar sürebilir → tam
  süreli koşu submit'e ulaşamaz (V11).
- **Planner hook worktree sızdırır:** claim metadata yazımı hata verirse worktree silinmez, claim
  bırakılmaz (V08).
- **Worker cooldown/submit yazımları checkout'a düşer**, hook store'dan okur → kota devri çalışmaz
  (worker yolu canlıda hiç koşmadı) (V12).
- **Executor chain dispatch'i** `actions: read` izinli `github.token` ile → 403 beklenir (canlı log
  okunmadan doğrulanamadı) (V01).
- `aria/state` bu kayıt yazılırken `06b4ba4a`'ya ilerledi; sayılar `e6f462fb`'ye sabitlendi.

---

## 10. Dokümanlara uygulanan düzeltmeler

- `ARIA-MIMARI-SEMALARI.md`:
  - Satır referansları ve sayılar güncellendi: 47 faz, 244 yüzey, 11 manifest, 11 workflow, 18
    hard-fail, model merdiveni.
  - Şema 11'e kalibrasyon kapısı eklendi.
  - "Canlı Durum" `aria/state` verisiyle yeniden yazıldı.
  - Şema 23 (canlı huni), Şema 24 (blokajlar ve kalan adımlar), Şema 25 (ARIA ≠ RAG) eklendi.
  - Tam okuma turunun şema bazlı düzeltme notları eklendi: Şema 1, 3, 4, 5, 7, 10, 11, 12, 13, 14,
    15, 17, 18, 20, 22.
  - İkinci turun (§9) çürütme ve kısmi düzeltmeleri işlendi (Canlı Durum, Şema
    3/4/5/7/10/13/23/24/25 notları, eskimiş düğümler).
- `ARIA-NASIL-CALISIR.md`: değiştirilmedi. Üstündeki notice gereği `CURRENT_STATE.md`'ye tabidir;
  tutarsızlıkları bu kaydın §2–§3 ve §8.4 bölümlerinde listelenmiştir.
