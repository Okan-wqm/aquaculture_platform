<!-- ARIA-CURRENT-STATE-NOTICE: Bu inceleme kaydı docs/aria/CURRENT_STATE.md ve executable contracts'a tabidir; bir tarih-damgalı denetim anlık görüntüsüdür, runtime otoritesi değildir. -->

# ARIA — Doküman ↔ Kod Karşılaştırması (2026-09-25)

> **Kapsam.** `ARIA-MIMARI-SEMALARI.md` (repo kökü, 22 şema, 2026-09-16/19) ve
> `docs/aria/ARIA-NASIL-CALISIR.md` (2026-09-19) ile `main @ 19efd07f` kodu ve
> canlı durum dalı `origin/aria/state @ e6f462fb` (2026-09-25) karşılaştırıldı.
> 6 bağımsız okuma ajanı paralel çalıştı (kanıt/ledger/profil · discovery/cycle/
> memory/pressure · adaptör/yargıç/kalibrasyon · ajan/dispatch/convergence ·
> governance/orkestratör/PR · canlı durum/RAG). Her satır açılmış bir `file:line`
> ile kanıtlıdır. Sınıflar: **DOĞRU** · **KAYMA** (satır/isim/sayı eskimiş, davranış
> aynı) · **TUTARSIZ** (doküman X der, kod Y yapar) · **EKSİK-DOKÜMAN** (kodda olan
> önemli davranış dokümanda yok) · **EKSİK-KOD** (dokümanın iddiası kodda yok /
> bağlı değil).
>
> **Okuma kapsamı (dürüst sınır).** Kod tamamen okunmadı. `aria_kernel` 308 üst-düzey
> modül (alt paketlerle 350 dosya, ~166 000 satır) + `tools/aria-*` + 684 test
> dosyası içerir. Ajanlar **iddia-güdümlü** okudu: dokümanlardaki her somut iddianın
> geçtiği modüller (~70–90 modül; ledger, evidence*\*, runtime_profile, discovery,
> snapshot, cycle, memory, pressure, proactive_priority, runtime_signal_bridge,
> tool_registry/health, readiness, adapter_calibration, poc, feedback_store,
> judge*_, agent_surface, agent_invocations, agent_contract, plan_convergence,
> independence_check, implementation_safety, __genesis, capability__, state*manifest,
> cost_budget, autonomy*_, merge*authority, pr_manager, github_adapters, reflection,
> search, mcp_server, semantic*_, context*compiler, claude/codex/zai_runtime,
> ci_executor, worker_executor). İddia geçmeyen modüller (mission, experiment*_,
> twin, impact_graph, knowledge_graph ayrıntısı, workflow_contracts, upcasters,
> migration vb.) satır satır doğrulanmadı; "bulgu yok" ≠ "tutarlı".

---

## 0. Yönetici özeti

1. **"ARIA hiç koşmadı" artık yanlış.** Her iki doküman da canlı durumu repo-içi
   `aria-tools/`'tan okuyor (boş, gitignore'lu). Gerçek durum `origin/aria/state`
   dalında: **43 cycle başladı / 30 tamamlandı / 13 başarısız** (2026-08-05 →
   2026-09-20), **304 LLM ajan sonucu** (274 kabul / 30 red), 108 adaptör koşusu,
   34 500 ham bulgu. ARIA **algılama + yargı** katmanında gerçekten çalışıyor.
2. **Ama değer üretim zinciri kapanmadı:** kalıcı bulgu (`findings.jsonl`) **0**,
   plan olayları 15 başladı / 12 terk / 2 değerlendirildi / **0 CONVERGED**,
   8 auto-merge kararı **8'i de `blocked`**, mission olayı 0, change-ledger commit 0.
   Tüm cycle'lar `standard` profilde; **observe burn-in 0/30**.
3. **2026-09-21'den beri gece koşuları kırmızı.** Son başarılı cycle
   `cyc-20260920T212805Z-auto`. Publish reddi:
   `state_commit_surface_too_large:raw_findings` — ham bulguların **%87'si
   (29 939 / 34 500) tek adaptörden, `doc-staleness-adapter`'dan** geliyor.
   Compactor düzeltmesi (8028bbb0, ARIA-HIGH-185) main'de; etkisi henüz yeşil bir
   cycle ile kanıtlanmadı.
4. **Doküman yapısal olarak eskimiş yerler:** cycle 47 faz (NASIL-CALISIR 16
   satır anlatıyor), `heartbeat_tick` silinmiş, model merdiveni
   `fable→opus→sonnet` 2026-09-12'de kaldırıldı, HMAC re-verify bağlı (doküman
   "değil" diyor), Brier/ECE kalibrasyonu + kalibre quorum + label queue + batch
   judge hiç yok.
5. **Abartılı güvenlik iddiaları:** L1'in "≥2 bağımsız kanıt zinciri" kodda yok
   (claim_type'a göre 1–3, otomatik terfide 1, bağımsızlık denetlenmiyor); kapalı
   `source_type` allowlist'i hiçbir yerde uygulanmıyor; `set_by` kendi-beyan;
   maliyet kapısı `managed_subscription` modunda hiçbir şeyi reddetmiyor;
   L2/L3 kabul olaylarını yazan üretim kodu yok → merdiven yapısal olarak L1'de
   takılı.
6. **RAG değil.** Vektör DB yok, embedder yok (soket boş), arama SQLite FTS5/bm25.
   Doğruluk kaynağı git blob hash eşitliği; LLM üretici değil hakem.

---

## 1. Canlı gerçek — `origin/aria/state` (2026-09-25)

| Yüzey                                                          | Sayı                                                                               | Yorum                                                                                                                                                          |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools/cycles.jsonl`                                           | 43 started · 30 completed · 13 failed                                              | ilk 2026-08-05, son başarılı `cyc-20260920T212805Z-auto`                                                                                                       |
| `tools/agent-invocations/results.jsonl`                        | 304 (274 accepted · 30 rejected)                                                   | roller: evidence_judgment 85 · adversarial_judgment 82 · human_required_adjudication 80 · maintenance_utility 24 · consensus_arbitration 2 · challenger_plan 1 |
| `tools/runs.jsonl`                                             | 108                                                                                | adaptör koşuları                                                                                                                                               |
| `tools/raw-findings.jsonl`                                     | 34 500                                                                             | doc-staleness 29 939 · test-gap 3 459 · tenant-scoping 724 · security-boundary 156 · kernel-dead-wire 110 · bundle-budget 108 · fe-dto-parity 4                |
| `tools/findings.jsonl`                                         | **0**                                                                              | hiçbir bulgu kalıcı finding'e terfi etmedi                                                                                                                     |
| `tools/judgment-samples.jsonl`                                 | 220                                                                                | yargı örneklemesi çalışıyor                                                                                                                                    |
| `tools/feedback-consensus-uncertainties.jsonl`                 | 18                                                                                 | consensus'a ulaşamayanlar                                                                                                                                      |
| `tools/human-required/`                                        | 114 dosya                                                                          | insan kuyruğu dolu                                                                                                                                             |
| `tools/plans/events.jsonl`                                     | plan_started 15 · plan_abandoned 12 · plan_evaluated 2 · challenger_plan_drafted 1 | **0 CONVERGED**                                                                                                                                                |
| `tools/auto-merge-decisions.jsonl`                             | 8 — hepsi `blocked` (PR #1266, #1273, #1282, #1335 ×2)                             |                                                                                                                                                                |
| `tools/missions/mission-events.jsonl`, `tools/change-ledger/*` | 0                                                                                  | mission/değişim zinciri hiç işlemedi                                                                                                                           |
| `tools/memory/beliefs.jsonl`                                   | 8                                                                                  | bellek çok ince                                                                                                                                                |
| `autonomy_state.jsonl`                                         | 403 satır, hepsi `profile: standard`, `auto_merges_delta` toplamı 0                |                                                                                                                                                                |

Kanıt komutu: `git show origin/aria/state:tools/<yüzey>` (salt-okuma).

**Huni:** 34 500 ham bulgu → 220 örnek → 167 yargıç yanıtı → 18 belirsizlik /
114 HUMAN_REQUIRED → **0 finding** → 15 plan → **0 CONVERGED** → 0 merge.

---

## 2. En kritik tutarsızlıklar (her iki doküman)

| #   | Doküman iddiası                                                                                                                                                            | Kod gerçeği                                                                                                                           | Kanıt                                                                                                | Sınıf                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------- |
| K1  | Canlı Durum: "findings hiç koşmadı, dispatch/enterprise dizinleri yok, `aria/state` dalı yok" (MIMARI §Canlı Durum); "runs/cycles 0 byte, hiç otonom koşu yok" (NASIL §15) | Durum `origin/aria/state`'te: 43 cycle, 304 ajan sonucu                                                                               | `git show origin/aria/state:tools/cycles.jsonl`; `.gitignore:222-223`                                | TUTARSIZ             |
| K2  | L1: onaylı bulgu **≥2 bağımsız kanıt zinciri** ister (NASIL §1)                                                                                                            | min kanıt claim_type'a göre 1–3; `finding_promotion` her şeyi `wrong_code` (min 1) basar; bağımsızlık/tekrar denetimi yok             | `finding.py:82-99,237-240`; `finding_promotion.py:42`                                                | TUTARSIZ             |
| K3  | Kapalı `source_type` allowlist'i gate'te reddedilir (NASIL §2.2)                                                                                                           | Hiçbir .py bu allowlist'i uygulamıyor; fiili kapı blob derecelendirmesi                                                               | `CONTRACTS.md:755`; grep boş                                                                         | EKSİK-KOD            |
| K4  | Cycle 16 faz (NASIL §4) / 46 faz (MIMARI Şema 0/16)                                                                                                                        | **47 faz**                                                                                                                            | `cycle.py:3109-3485` (`len(CYCLE_PHASES)==47`)                                                       | KAYMA                |
| K5  | `heartbeat_tick` cycle'lar arası nabız (NASIL §4)                                                                                                                          | Silinmiş; işler `fixture_refresh`/`judgment_pipeline` fazlarında                                                                      | `cycle.py:1685-1700,1955-1960`                                                                       | TUTARSIZ             |
| K6  | Model merdiveni `fable→opus→sonnet → glm-5.3` (MIMARI Şema 5)                                                                                                              | 2026-09-12 operatör kararı: in-vendor düşürme yok, `opus` yaprak; yalnız sağlayıcılar-arası **auth** failover (opus ↔ glm-5.3)       | `tools/aria-poc/claude_runtime.py:76-95,1845-1870`                                                   | TUTARSIZ             |
| K7  | Auto-promote HMAC tüketim anı re-verify "henüz wired değil" (NASIL §7.2)                                                                                                   | Bağlı: `transition_tool` → `verify_auto_promote_token` sabit-zamanlı karşılaştırma                                                    | `tool_registry.py:1437-1466`; `adapter_calibration.py:168-203`                                       | KAYMA (doküman eski) |
| K8  | Drift "Rust↔TS event-contract sınırını yakalar" (NASIL §7.3; MIMARI Şema 10 "TS↔SQL")                                                                                    | Rust enum'ları ts-tarafına eklenir, `find_drifts` yalnız ts-tarafı × SQL karşılaştırır → **Rust↔SQL**, Rust↔TS yok                  | `poc.py:1633,1640,914-946`                                                                           | TUTARSIZ             |
| K9  | Maliyet kapısı LLM spawn'dan ÖNCE tek boğaz (her iki doküman)                                                                                                              | `monetary_admission == "managed_subscription"` → reddetmeden `telemetry_only`; repo policy tam olarak bu                              | `cost_budget.py:139-156`; `aria-config/genesis_policy.json:28`                                       | TUTARSIZ             |
| K10 | Unlock merdiveni 30/30/30/10/5/3 sayaçları dolabilir (her iki doküman)                                                                                                     | Üretimde yalnız `observe_success` yazılıyor; `l1_autonomous/l2_*/l3_*/rollback_success` üreticisi yok → L2/L3 yapısal olarak açılamaz | `autonomy_ladder.py:84-90`; `autonomy_unlock.py:28-36,72-98`                                         | EKSİK-KOD            |
| K11 | "Makine kendi yetkisini genişletemez" (NASIL §2.4)                                                                                                                         | `set_by` kendi-beyan string, varsayılan `"operator"`; kod yalan beyanı değil yalnız drift'i durdurur                                  | `runtime_profile.py:545,575-583`; `cli.py:1229`                                                      | TUTARSIZ (abartılı)  |
| K12 | Runtime sinyali "Sentry · 85" girer (MIMARI Şema 9/20; NASIL §6)                                                                                                           | Sentry entegrasyonu yok; `sentry` yalnız izinli kaynak adı (testlerde); Alertmanager ARIA'ya yönlendirilmemiş                         | `tests/test_runtime_signal_bridge.py:58`; `infrastructure/monitoring/droplet/alertmanager.yml:69-70` | EKSİK-KOD            |
| K13 | Pressure skoru `× tazelik_çürümesi`                                                                                                                                        | `recency_decay = 1.0` sabit → terim etkisiz                                                                                           | `pressure.py:979,997-1015`                                                                           | TUTARSIZ             |
| K14 | Coverage invariant "hiçbir dosya görünmez kalamaz"                                                                                                                         | `len(allowed) <= len(fates)` totoloji; gerçek kontrol yalnız "`unknown` yok"; kirli/untracked committed modda bilerek dışarıda        | `discovery.py:96,40-57`                                                                              | TUTARSIZ (zayıf)     |
| K15 | GATE_PRE_PR_OPEN "17 sert kontrol" (MIMARI Şema 16) / "15 hard-fail" (NASIL §9.3)                                                                                          | `HARD_FAIL_CHECKS` = **18**; kod yorumu hâlâ "15"; cycle.py yorumu "10-check perimeter"                                               | `implementation_safety.py:1810`; `cycle.py:3045`                                                     | KAYMA                |
| K16 | ADR-033 "snowball'da, main'e merge değil"; IDENTITY "ARIA does not exist yet" (NASIL §15)                                                                                  | Autonomous profil main'de; IDENTITY:29 "ARIA the system EXISTS and runs" (2026-08-20)                                                 | `runtime_profile.py:124,175`; `docs/aria/IDENTITY.md:29`                                             | TUTARSIZ             |

---

## 3. Bölüm bazlı bulgular

### 3.1 Kanıt / ledger / profil (NASIL §1–2, MIMARI Şema 6–7)

| Doküman                                                                           | Kod                                                                                                                                                  | Kanıt                                       | Sınıf                 |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------- |
| `_record_hash :387`, `_append_jsonl_locked_body :395`, `load_jsonl_verified :861` | Davranış aynı; 1241 / 1278 / 1911                                                                                                                    | `ledger.py`                                 | KAYMA                 |
| Ham `append_jsonl` enterprise yüzeyde reddedilir                                  | Doğru ama iki kaçış: `test_fixture=True`, `allow_legacy`+reason+`expires_at` (üretimde: `agent_invocations.py:1796`, bitiş 2026-12-31)               | `ledger.py:1455-1506`                       | EKSİK-DOKÜMAN         |
| Yazımlar lock + fsync + atomik rename                                             | Append: flock + O_APPEND + fsync (rename yok); rename yalnız `rewrite_jsonl`                                                                         | `ledger.py:1313-1318,1649-1650`             | TUTARSIZ (küçük)      |
| (yok)                                                                             | `append_declared_jsonl(bypass_profile_gate=True)` kernelde 34 çağrı                                                                                  | `ledger.py:1428,1606-1614`                  | EKSİK-DOKÜMAN         |
| `repo_verified` "tek güvenilir derece"                                            | Dizin ref'i yalnız `cat-file -t == tree` ile `repo_verified`; ayrıca `repo_glob_verified`, `empty_glob`, `glob_too_large_to_verify` (500) dereceleri | `evidence_trust.py:62-64,147-151,321-395`   | EKSİK-DOKÜMAN         |
| GitProbeSession 30 s × 3 + 1+2 s geri çekilme = 93 s, 300 s canlılık              | Birebir                                                                                                                                              | `evidence_probe.py:37-58,220-282`           | DOĞRU                 |
| `validate_agent_response_evidence :350`                                           | 540; satır varlığı `1 ≤ line ≤ n`, satır içeriği/semantik doğrulanmaz; `human-required:` ref'leri ve ARBITRATION kernel artefaktları istisna         | `evidence_validator.py:382-385,480-497,540` | KAYMA + EKSİK-DOKÜMAN |
| Beş profil; modül docstring                                                       | Docstring hâlâ "4-mode"                                                                                                                              | `runtime_profile.py:1,123`                  | KAYMA                 |
| frozen "tüm yazımlar" / "tek yazma-yetki sınırı"                                  | Yalnız Plan-020 yüzeyleri; eski yazıcılar + `DIAGNOSTIC_ALLOWLIST` kapsam dışı                                                                       | `runtime_profile.py:24-31,308-322`          | EKSİK-DOKÜMAN         |
| Bozuk profil → frozen                                                             | Doğru; dosya yoksa `standard`                                                                                                                        | `runtime_profile.py:401,428-466`            | KAYMA                 |

### 3.2 Discovery / cycle / memory / pressure (NASIL §3–6, MIMARI Şema 2, 9)

| Doküman                                                              | Kod                                                                                                               | Kanıt                                                | Sınıf         |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------- |
| `run_enterprise_cycle` `cycle.py:219` / `:528`; `CYCLE_PHASES :2939` | 541 / 3109                                                                                                        | `cycle.py`                                           | KAYMA         |
| "Bilinmeyen faz → ValueError"                                        | Faz listesi girdi değil; import anında `_assert_pipeline_is_well_formed`, bilinmeyen `mode` → `GovernanceError`   | `cycle.py:573-588,3488`                              | TUTARSIZ      |
| pre_tool = architecture_baseline / validation_matrix / pr_lifecycle  | pre_tool = tool_manifest_sync + architecture_baseline; diğer ikisi post_tool sonunda                              | `cycle.py:3199-3207,3475-3484`                       | TUTARSIZ      |
| "Post-tool hataları cycle'ı çökertmez"                               | Varsayılan `halt_sequence`: sonraki halt fazları `upstream_failure` ile atlanır; `artifact_integrity` `propagate` | `cycle.py:477,3452,3620-3646`                        | TUTARSIZ      |
| Memory FATES kurcalamasını `repo_state_id` ile yakalar               | `_verify_fates_integrity` her hash'i `git show` ile yeniden hesaplar; `repo_state_id` yalnız damga                | `memory.py:1449-1475,1560-1610`                      | TUTARSIZ      |
| Decay "iki yolla"                                                    | 4 yol: diff, yaş (90 g), head-distance, karantina kaynak + stuck contradiction eskalasyonu                        | `memory.py:882-948,1057,188`; `cycle.py:1398-1424`   | EKSİK-DOKÜMAN |
| Pressure 6 kaynak                                                    | `SOURCE_WEIGHTS` 15 kaynak                                                                                        | `pressure.py:16-57`                                  | EKSİK-DOKÜMAN |
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

| Doküman                                               | Kod                                                                                   | Kanıt                                        | Sınıf         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------- | ------------- |
| "~120 yüzey"                                          | **244** `STATE_SURFACES`                                                              | `state_manifest.py:203-230`                  | KAYMA         |
| Maliyet $0.50/$5/$100 (NASIL)                         | Etkin override 0.5 / 25 / 300 (MIMARI doğru)                                          | `aria-config/genesis_policy.json:5-9`        | KAYMA         |
| `reset_breaker` approval_ref olmadan açılmaz          | Zorunlu ama içerik doğrulanmıyor (boş string geçer)                                   | `cost_budget.py:272-293`                     | KAYMA (zayıf) |
| Orkestratör zorunlu kwarg'lar (3)                     | 8 zorunlu + profile; `v9_implementation_runner` opsiyonel → verilmezse sessizce NoOp  | `autonomy_orchestrator.py:913-963,1029-1031` | EKSİK-DOKÜMAN |
| `autonomy_orchestrator.py:726`                        | 913                                                                                   |                                              | KAYMA         |
| Adım sırası ARIA_STOP→…→Gate B→auto-merge (`no_gaps`) | Birebir                                                                               | `autonomy_orchestrator.py:1444-2680`         | DOĞRU         |
| PR base `main`, 7 bölüm                               | Doğru; bölüm adı "Baseline Comparison"                                                | `pr_manager.py:48-56,213`                    | DOĞRU         |
| Merdiven tek eşik                                     | Lane'e göre: L1 = 30 observe; L2 = 30+30+30; tam liste yalnız L3; 72 s süreklilik     | `autonomy_unlock.py:27,55-62,168-207`        | KAYMA         |
| Günlük rapor bölümleri                                | Sayılanlar + 17 bölüm daha (Labels wanted, Experiment Night, Missions, Duel Ratings…) | `reflection.py:617-1602`                     | EKSİK-DOKÜMAN |
| "12 aria-\* workflow" (MIMARI Şema 21)                | **11** (`aria-kernel-fast` yok)                                                       | `.github/workflows/aria-*.yml`               | KAYMA         |
| "58 ajan (18 aria-\*)"                                | 52 üst-düzey ajan, 18 `aria-*`                                                        | `.claude/agents/`                            | KAYMA         |

### 3.5 Ajan / dispatch / convergence (NASIL §9–10, MIMARI Şema 3–5)

| Doküman                                           | Kod                                                                                                                                                                                   | Kanıt                                                               | Sınıf         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------- |
| Roster "13 ajan"                                  | 18 üst-düzey `aria-*.md` + 2 `_maintenance/` = 20 (completeness-critic, autonomy-planner, worker, 4 acceptance ajanı eksik)                                                           | `.claude/agents/`                                                   | KAYMA         |
| `DISPATCHABLE_ROLES` (11)                         | **15** (E14: consensus_arbitration, change_intelligence, goldset_curation; E9-c: verification)                                                                                        | `agent_surface.py:61-90`                                            | KAYMA         |
| `ROLE_TARGET_PAIRING` "yanlış eşleşme reddedilir" | primary_plan / challenger_plan / cross_review için eşleme **yok**; `primary_plan → aria-evidence-judge` mint'te kabul edildi (canlı probe); whitelist yalnız `implementation`         | `agent_surface.py:144-168`; `agent_contract.py:120,210-215`         | TUTARSIZ      |
| Lease 30 dk                                       | Varsayılan 1800 s, ama `ci_executor` kendi hesapladığı lease ile ezer                                                                                                                 | `ci_executor.py:4427-4439`                                          | KAYMA         |
| Submit: validate → SoD → evidence → compliance    | + `plan_contract` + `secret_in_envelope` adımları                                                                                                                                     | `agent_invocations.py:5175-5244`                                    | EKSİK-DOKÜMAN |
| Convergence ≤5 tur                                | + round ≥3'te yeni risk kategorisi → HUMAN_REQUIRED; spine `unavailable` → HUMAN_REQUIRED                                                                                             | `plan_convergence.py:655-684,2742-2787`                             | EKSİK-DOKÜMAN |
| Bağımsızlık 3 katman + content_hash collusion     | Birebir                                                                                                                                                                               | `independence_check.py:67,170-228`; `plan_convergence.py:1570-1633` | DOĞRU         |
| Genesis: body'yi `aria-drafter` sentezler         | **Drafter'ı spawn eden kod yok**; `draft["body"]` yazan satır yok; `maintenance_utility` dispatch edilemez → materialize her zaman `materialize_requires_drafter_body` ile reddedilir | `agent_genesis.py:656-667`; `draft_intent.py:15`                    | EKSİK-KOD     |
| Sandbox ≥3 fixture, 3 olaylı audit                | Birebir                                                                                                                                                                               | `agent_genesis.py:251-300,564,648-654`                              | DOĞRU         |
| Bağımsız planlayıcılar                            | Primary ve challenger ikisi de `opus`/`max`; model çeşitliliği yalnız adversarial judge'da (glm-5.3) — echo-chamber ölçülür, önlenmez                                                 | `.claude/agents/aria-*-planner.md`                                  | EKSİK-DOKÜMAN |

---

## 4. Neden "tam çalışmadı" — blokajlar

| #   | Blokaj                                                                                                                                                                                                                                                                                                         | Kanıt                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| B1  | **Gece cycle'ı 2026-09-21'den beri kırmızı** (run 179–183). Publish reddi `state_commit_surface_too_large:raw_findings`. Kök: `doc-staleness-adapter` 29 939 ham satır. Compactor fix (8028bbb0) main'de; yeşil cycle ile kanıtlanmadı. Cycle adımının kendi hata nedeni ayrıca çıkarılmalı (run 36055186584). | `autonomy_evidence.py:2543-2546`; `autonomy-closure-findings.json:425-432` (ARIA-HIGH-017)                                   |
| B2  | **Observe burn-in hiç tamamlanmadı**; tüm cycle'lar `standard`.                                                                                                                                                                                                                                                | `aria-auto-cycle.yml:824-825`; `CURRENT_STATE.md:192-195`                                                                    |
| B3  | **L1 = 30 observe başarısı**; scheduler tavanı `standard`.                                                                                                                                                                                                                                                     | `docs/aria/policy/autonomy-unlock.json:7-9`                                                                                  |
| B4  | **L2/L3 yapısal olarak açılamaz** — kabul olaylarının üreticisi yok (K10).                                                                                                                                                                                                                                     | `autonomy_ladder.py:84-90`                                                                                                   |
| B5  | **Değer zinciri kopuk:** 0 finding, 0 CONVERGED plan (12/15 terk), 0 mission, 8/8 merge blocked.                                                                                                                                                                                                               | aria/state §1                                                                                                                |
| B6  | 6 `task_commit_and_live` kapanış bulgusu canlı kanıt bekliyor (ARIA-CRITICAL-009, ARIA-CRITICAL-015 dahil).                                                                                                                                                                                                    | `docs/aria/policy/autonomy-closure-findings.json`                                                                            |
| B7  | 8 dormant kontrol (ORPHAN-HIGH-573; 2 tanesi 2026-10-09, 6'sı 2026-10-20'de dolar); 8 hiç-yazılmamış yüzey değeri (bitiş 2026-10-16); ORPHAN-CRITICAL-725 üreticisi ulaşılmamış.                                                                                                                               | `aria-kernel/control-reachability.dormant.json`; `surface-reachability.unwritten.json`; `closure-reachability-baseline.json` |
| B8  | Codex managed-auth + native dispatch açık; Z.ai credential runtime'a verilmemiş.                                                                                                                                                                                                                               | `CURRENT_STATE.md:94,98`                                                                                                     |
| B9  | Repo `.mcp.json` MCP'yi boş repo-içi `aria-tools`'a bağlıyor → yerel MCP gerçek durumu görmüyor; `search` `findings` türünü indekslemiyor.                                                                                                                                                                     | `.mcp.json:13-14`; `search.py:28,30-37`                                                                                      |

## 5. Kalan adımlar (sıralı)

1. **B1:** `raw_findings` publish sınırını kökten çöz — `doc-staleness-adapter` gürültüsü (29 939 satır) adaptör düzeyinde düzeltilmeli (kural sağlığı / FP karantinası), compactor tek başına yetmez; run 36055186584'teki cycle hatasını çıkar. Hedef: `aria/state`'e yeşil `auto-cycle-*` commit'i.
2. **Kurulum:** `aria-runner-capability-probe` dispatch; runner'da `claude auth status`; `vars.ARIA_MOCK_KILL_SWITCH` doğrula.
3. **İlk observe burn-in:** `aria-auto-cycle` → `mode=burn-in-observe, mock=false`; ≥20 geçerli cycle, eylem sıfır; rapor aria/state'e yayınlansın.
4. **Değer zincirini kapat (B5):** neden 0 finding? — consensus → `promote_consensus_findings` operatör ACK'i şart; 114 HUMAN_REQUIRED kaydını triyaj et. Neden 12/15 plan terk? — plan terk nedenlerini `plans/events.jsonl`'dan çıkar.
5. **Dormant/unwritten (B7):** son tarihlerden önce bağla ya da sil.
6. **L1:** 30/30 observe kabulünden sonra operatör: `aria-kernel profile set --profile standard --scheduler-ceiling strict --operator-approval-ref <ref>`.
7. **L2/L3 üreticileri (B4):** `l1_autonomous_success` … `rollback_success` olaylarını yazan kodu ekle; aksi halde merdiven L1'de biter.
8. **MCP (B9):** MCP'yi aria/state checkout'una yönlendir; `findings` kaynağını `_SOURCES`'a ekle.

---

## 6. Ajan / dispatch / LLM çağırma yolu

**Gerçek zincir:** daemon ya da `aria-agent-executor.yml` (`[self-hosted, linux, claude]`, cron 02:29)
→ `planner_dispatch_hook` claim (`ARIA_LEASE_TOKEN` yalnız env ile) → `tools/aria-poc/ci_executor.py` alt süreci
→ `_adaptive_pre_claim_admission` sağlayıcı seçer (`ci_executor.py:4383-4411`)
→ native `_invoke_native_{claude,codex,zai}` (`:4896-4907`) veya legacy `invoke_claude_cli` (`:1805`).

| Sağlayıcı | Çağrı                                                                                                                                                             | Auth                                                                                                                             | Kanıt                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Claude    | `claude -p --output-format stream-json --model opus --effort max` + okuma şekli `--tools Read,Grep,Glob` veya yazma şekli; **bwrap sandbox** içinde; prompt stdin | `claude auth status` → `authMethod == "claude.ai"` (managed abonelik); `ANTHROPIC_API_KEY/AUTH_TOKEN/BASE_URL` görülürse **red** | `claude_runtime.py:172-177,500-518,554-603,1287-1375`; `status_answers.py:43,88-92` |
| Codex     | `codex exec --json` (`gpt-5.2-codex`), salt-okuma                                                                                                                 | managed auth — **açık**                                                                                                          | `codex_runtime.py:46,93,259`; `CURRENT_STATE.md:94`                                 |
| Z.ai      | OpenAI-uyumlu HTTP (urllib), adversarial judge `glm-5.3`                                                                                                          | `ARIA_ZAI_API_KEY_FILE` (0600)                                                                                                   | `zai_runtime.py`                                                                    |
| Mock      | `CLAUDE_CLI_MOCK=1` → yer tutucu zarf; worker sahte commit                                                                                                        | `vars.ARIA_MOCK_KILL_SWITCH` önce okunur                                                                                         | `ci_executor.py:1861-1930`; `worker_executor.py:115-145`                            |

`hook_broker.py` ("broker socket") LLM API'si değil: Claude Code hook'larını sandbox
dışında unix socket ile yanıtlar (`hook_broker.py:1-40`). Model düşürme merdiveni yok
(bkz. K6). `ci_executor_contract_proven.md:152` hâlâ
`verified_at_commit: PENDING-OPERATOR-LIVE-INVOCATION`.

**Canlı çalıştırma şartları:** self-hosted runner + claude.ai managed oturumu + bwrap +
unprivileged userns + root olmayan kullanıcı. (Bu analiz container'ında `ANTHROPIC_BASE_URL`
set, `authMethod: oauth_token`, `bwrap`/`codex` yok, uid 0 → preflight
`claude_api_key_mode_disallowed` ile fail-closed reddeder. Bu, runner'ın değil
analiz ortamının durumudur; kapıların doğru çalıştığını gösterir.)

**Ajana verilen bağlam** (`render_invocation_prompt`, `agent_invocations.py:899-1033`):
must_satisfy, **evidence_refs** (yalnız bunlar kanıt), allowed/forbidden scope, impact graph,
validation komutları, mint anında `target_sha`'dan birebir alıntılanan
`<untrusted_evidence_excerpt … content_hash>` blokları (`:434-520`), path'e göre
filtrelenmiş beliefs/conventions/anti-patterns/geçmiş başarısız denemeler (`:240-267,544,598`),
repo haritası. Planlayıcı/yargıç ajanları yalnız Read/Grep/Glob ile repoyu kendileri okur.

---

## 7. ARIA ≠ RAG — kanıtlı fark

| Boyut                  | RAG                                     | ARIA                                                                                                                                                   | Kanıt                                                                   |
| ---------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Temel döngü            | sorgu → benzer chunk getir → LLM üretir | deterministik adaptör/çıkarıcı aday üretir → LLM **yargıç** doğrular → kanıt git blob'una karşı hash ile doğrulanır                                    | `poc.py:4` ("No LLM"); `evidence_trust.py:276-301`                      |
| Doğruluk kaynağı       | getirilen metin (varsayılan doğru)      | commit SHA'daki git blob hash eşitliği (`repo_verified`); ajan çıktısı **veri**, hakikat değil                                                         | `evidence_validator.py:540`; `convergence_drainer.py:305-306`           |
| Kendi çıktısı          | tekrar indekslenip bağlam olabilir      | `self_output` önekleri **asla kanıt olamaz**                                                                                                           | `evidence_trust.py:13-23`                                               |
| Bilgi deposu           | vektör indeksi (durumsuz)               | hash-zincirli append-only ledger'lar + belief state machine (durumlu)                                                                                  | `ledger.py:1241-1318`; `memory.py:22-23`                                |
| Bayatlık               | bayat chunk sessizce döner              | belief `supported → needs_revalidation → stale` (diff, 90 g TTL, head-distance, karantina) → pressure'a yükselir                                       | `memory.py:756-990`                                                     |
| Tekrar                 | aynı chunk çok gelirse ağırlık artar    | "tekrar kanıt değildir": güven yalnız kanıt hash'i değişince artar                                                                                     | `memory.py:546-587`                                                     |
| Benzerlik ölçüleri     | retrieval'ın kendisi                    | yalnız **filtre/çeşitlilik**: enum-isim FP filtresi (Jaccard ≥0.3), echo-chamber tespiti (3-gram Jaccard >0.85), dedup (token-cosine ≥0.62)            | `poc.py:940-963`; `independence_check.py:22-24`; `semantic_dedup.py:17` |
| Embedding              | çekirdek                                | **Yok.** `semantic_memory` soketi `ARIA_EMBEDDER_CMD` yoksa no-op; hiçbir workflow tanımlamıyor; aria/state'te `embeddings.jsonl` yok                  | `semantic_memory.py:1-22`                                               |
| Arama                  | vektör ANN                              | SQLite FTS5 + `bm25()`, 6 ledger üzerinde; "an index, not a truth source"                                                                              | `search.py:8-13,59,120-121`                                             |
| Bağlam enjeksiyonu     | chunk'lar prompt'a talimat gibi         | `context_compiler` geçmiş kararları sözcüksel sıralar, `<derived_context>` **veri** bloğu olarak hash'e bağlar; ajan repoyu kendisi Read/Grep ile okur | `context_compiler.py:1-15,164-186`                                      |
| Halüsinasyon savunması | yok / prompt                            | yapısal: kanıtı doğrulanamayan yanıt reddedilir (aria/state'te 44 kez `agent_evidence_not_repo_verified`)                                              | `autonomy_orchestrator.py:210-215`                                      |

**Tek cümle:** RAG "bulduğumu modele ver, modelin söylediğine güven"dir; ARIA
"modelin söylediği her `file:line`'ı commit'li blob'a karşı kanıtla, kanıtlanamayanı
reddet, kendi çıktını asla kanıt sayma, bilgiyi durumlu ve çürüyebilir tut"tur.
RAG-benzeri parçalar (FTS5 arama, isteğe bağlı embedding sıralaması) yalnız
**bağlam/öncelik** için vardır; hiçbir benzerlik skoru bir bulgunun doğruluğuna
karar vermez.

---

## 8. Dokümanlara uygulanan düzeltmeler

- `ARIA-MIMARI-SEMALARI.md`: satır referansları ve sayılar güncellendi (47 faz,
  244 yüzey, 11 adaptör/workflow, 18 hard-fail, model merdiveni); Şema 11'e
  kalibrasyon kapısı eklendi; "Canlı Durum Denetimi" `aria/state` verisiyle
  yeniden yazıldı; yeni **Şema 23 (Canlı huni)**, **Şema 24 (Kalan adımlar)**,
  **Şema 25 (ARIA vs RAG)** eklendi.
- `ARIA-NASIL-CALISIR.md`: değiştirilmedi; üstündeki notice gereği
  `CURRENT_STATE.md`'ye tabidir. Tutarsızlıkları bu raporun §2–§3'ünde listelenmiştir.
