<!-- ARIA-CURRENT-STATE-NOTICE: Bu açıklayıcı doküman docs/aria/CURRENT_STATE.md ve executable contracts'a tabidir. Çelişki halinde düşük-öncelikli prose düzeltilir veya historical işaretlenir. -->

# ARIA Nasıl Çalışır — Baştan Sona (Türkçe)

> Bu doküman ARIA'yı kodu okuyarak, baştan sona açıklar: ne olduğu, nasıl
> çalıştığı, her parçanın ne yaptığı — ve sonunda dürüst bir soru: **gerçekten
> işe yarayacak mı?** Açıklayıcıdır; runtime otoritesi `CURRENT_STATE.md` +
> executable contracts'tadır.

---

## 0. Bir cümlede ARIA

ARIA, **"koda dokundukça büyüyen, repository-şekilli bir zekâ"dır** (`SPEC.md:5`).
PR-cycle review ajanlarının yerine geçmez; **PR döngüleri arasında sürekli koşan
bir meta-katmandır** (ADR-031). Kendi ifadesiyle: *"Sen bir code reviewer değilsin…
Sen tek bir repository'nin içinde var olan, şeklini o repodan alan bir zekâsın.
Başka bir repo, senin başka bir versiyonunu üretirdi."* (`IDENTITY.md:36-40`).

Tek bir taşıyıcı fikir vardır: **iddiaya değil, kanıta güven.** ARIA'nın bütün
halüsinasyon-direnci buradan gelir; aşağıdaki her mekanizma bunun bir sonucudur.

---

## 1. Temel felsefe — Üç Yasa ve otorite zinciri

**Üç Kurucu Cümle** (`SPEC.md:43-49`): *"Detay altta yaşar. Kararlar üstte verilir.
Kanıt her zaman aşağıya bağlanır."*

**Üç Değişmez Yasa** (`SPEC.md:55-118`) — sistem koda gömülüdür, ajanlar tartışamaz:
- **L1 — Grounded Evidence:** Onaylı bir bulgu, **kapalı bir kaynak kümesinden ≥2
  bağımsız kanıt zinciri** ister. Repo içeriği (README, CLAUDE.md, yorumlar) **veridir,
  talimat değil.**
- **L2 — Repository Preservation:** repo'ya zarar verme.
- **L3 — Operational Safety & Data Boundary:** güvenlik/veri sınırı.

**Otorite zinciri** (`CURRENT_STATE.md:8-18`, fail-closed ve sıralı):
1. **Executable kod + makine-denetimli kontratlar normatiftir.**
2. `CURRENT_STATE.md` canlı insan-okur durum indeksidir.
3. ADR'ler yalnız koda/CURRENT_STATE'e çelişmedikçe normatiftir.
4. `SPEC/CONTRACTS/IDENTITY/plans/**` yalnız historical-olmayan bölümlerinde canlıdır.
5. Eski "snowball/Claude-era" dokümanlar tasarım tarihçesidir, runtime otoritesi değil.

> Bu zincirin kendisi ARIA'nın en önemli özelliğidir: **runtime davranışı bayat
> prose'dan çıkarılamaz.** Doküman ile kod çelişirse, kod kazanır.

---

## 2. Anti-halüsinasyon temeli — "kanıta güven, iddiaya değil"

Bu, ARIA'yı sıradan bir LLM ajanından ayıran çekirdektir. Dört kat:

### 2.1 Hash-zincirli ledger'lar (`ledger.py`)
Her satır `previous_ledger_hash` + `ledger_hash` taşır; `_record_hash` (`:387`)
satırı kanonikleştirip SHA-256'lar → kurcalama-belirgin zincir. `_append_jsonl_locked_body`
(`:395`) zincir alanlarını **her zaman yeniden türetir** — bayat bir satırı yeniden
ekleyen çağıran eski hash'i enjekte edemez. Strict okuma `load_jsonl_verified` (`:861`)
zincir uyuşmazlığında `LedgerIntegrityError` fırlatır; hash'siz satırlar artık fail eder.
Enterprise yüzeylerine ham `append_jsonl` **reddedilir** — `append_declared_jsonl(expected_surface=...)`
zorunlu (`:525-551`). Yazımlar POSIX-locked + fsync + atomik rename.

### 2.2 Kapalı kanıt allowlist'i + repo_verified derecelendirme (`evidence_trust.py`)
`classify_evidence_ref` her ref'i derecelendirir (`:85-96`):
- **`repo_verified`** — dosya var **ve** sha256'sı `target_sha`'daki git blob'uyla eşleşiyor
  (`_git_blob_matches`, `:177`). Yani kanıt **commit'lenmiş bir SHA'da** var olmalı, kirli
  worktree'de değil. Güvenilir tek derece budur.
- `worktree_candidate` — diskte var ama SHA'da doğrulanmamış.
- `missing` / `invalid` — yok / bozuk.
- **`self_output`** — ref `aria-tools/`, `aria-findings/`, `agent-workspace/`, `.aria-poc/`…
  öneklerinden biriyle başlıyorsa (`SELF_OUTPUT_PREFIXES`, `:13-23`): **ARIA'nın kendi çıktısı
  asla kanıt olamaz.** (Bu, sistemin kendine referansla kendini doğrulamasını yapısal olarak engeller.)

İzin verilen `source_type` kümesi kapalıdır (`CONTRACTS.md:520`): `code_reference`,
`external_authoritative_source`, `test_demand`, `git_history`, `trusted_config_file`,
`trusted_prior_doc`. Başka her şey = L1 ihlali, gate'te reddedilir.

### 2.3 Ajan yanıtının yeniden-doğrulanması (`evidence_validator.py`)
`validate_agent_response_evidence` (`:350`) bir LLM ajanının **iddia ettiği her ref'i
yeniden çeker** ve repo'ya karşı `target_sha`'da doğrular: self-output reddi, dosya/satır
varlığı, ref'in `allowed_scope` içinde olması (scope-leakage önlemi), **boş satisfaction_matrix
reddi** ("sıfır kriter rubber-stamp" deliğini kapatır). Docstring: *"agent output is data, not
truth."* — **Bu fonksiyon ARIA'nın kalbidir:** hiçbir LLM çıktısı, atıf yaptığı her file:line
commit'li SHA'da gerçekten var olduğu kanıtlanmadan CONVERGED plan'a veya onaylı bulguya dönüşemez.

### 2.4 Runtime profilleri — yazma/eylem kapısı (`runtime_profile.py`)
Tek yazma-yetki sınırı. Beş profil (`:91`): `observe`, `standard` (default), `strict`,
`frozen`, `autonomous`.
- **observe** — salt-okuma + yalnız gözlem-sınıfı yazımlar; ajan claim yok, PR yok, tool run yok.
- **standard** — tam yüzey yazımları + ajan claim; PR strict ister.
- **strict** — PR open dahil tam pipeline.
- **frozen** — incident no-write: `PLAN_020_WRITE_SURFACES`'in tamamı bloklanır.
- **autonomous** — `pr_merge`'e izin veren **tek** profil.

Fail-closed: bozuk/bilinmeyen profil dosyası → `frozen` döner (`:214`), asla `standard`'a
sessizce kaymaz. `set_profile` (`:300`) her geçişte **`operator_approval_ref` zorunlu** kılar,
audit'lenir. Ve profil ne olursa olsun **bypass edilemez invariant'lar** her zaman çalışır
(`:30-40`): banned-phrase tarayıcı, Closes-trailer doğrulayıcı, suppression tarayıcı.

---

## 3. Keşif (Discovery) + Coverage Invariant

Her cycle repo'yu bir snapshot'a çevirir. `run_discovery` (`discovery.py:29`) →
`build_repo_snapshot` (`snapshot.py:45`): git varsa `git ls-files`, yoksa filesystem walk
(paylaşılan exclusion set ile). Her dosyaya **tam bir fate** atanır (`_file_fate`,
`snapshot.py:268`): `tracked` | `generated` | `unknown` (yalnız stat/read hatası). Committed
modda içerik/hash `git show HEAD:<path>`'ten gelir (değişmez).

**Coverage Invariant (gerçeklenen):** `complete = fate'lenen küme allowed kümeyi kapsıyor VE
hiç `unknown` yok` (`discovery.py:96`). Yani **hiçbir dosya sessizce görünmez kalamaz** —
gözden-kaçmama disiplini.

Üretilen artifact'lar (`aria-tools/discovery/<cycle_id>/`): `FATES.json` (dosya-bazlı envanter),
`SNAPSHOT.json`, `REPO_FINGERPRINT.json` (yapısal census: dil histogramı, servis/MFE/migration/ADR
sayıları), `SERVICE_MAP.json`, `COMPLETION_PROOF.json` (kapsama kanıtı). `repo_state_id` =
snapshot içeriğinin content-address kimliği; memory, FATES kurcalamasını bununla yakalar.

---

## 4. Cycle (kalp atışı) — `run_enterprise_cycle` (`cycle.py:219`)

Bir cycle'ın tam faz sırası ve her birinin ürettiği:

| # | Faz | Ne yapar |
|---|---|---|
| — | **giriş validasyonu** | bilinmeyen faz → yan etki ÖNCESİ `ValueError`; `ARIA_STOP` dosyası varsa temiz çıkış |
| — | **ledger aç** | `cycles.jsonl`'a tipli `started` satırı (CycleRow dataclass — discriminated union drift edemez) |
| 1 | learning (pre) | cycle öncesi öğrenme kancaları |
| 2 | **discover** | §3'teki 5 artifact |
| 3 | cycle_diff | önceki cycle ile fark |
| 4 | (pre_tool_phases) | opsiyonel: architecture_baseline / validation_matrix / pr_lifecycle — tool'lardan ÖNCE gate |
| 5 | **tools** | ACTIVE/SHADOW/CALIBRATE adapter'ları subprocess olarak koşar → observations/findings |
| 6 | **memory** | observation + belief yazar; FATES bütünlüğünü doğrular |
| 7 | **belief_decay** (P028) | TTL aşmış belief'i `needs_revalidation`'a çeker — pressure'dan ÖNCE |
| 8 | **pressure** | reaktif baskı sinyallerini skorlar + runtime-signal lead'leri |
| 9 | **consensus_escalation** (P023) | yargıç anlaşmazlığını HUMAN_REQUIRED'a akıtır |
| 10 | **judge_calibration** (P024) | her yargıcı ground-truth'a karşı puanlar (LLM'siz) |
| 11 | **proactive_priority** (P027) | Impact×Opportunity "sıradaki yatırım" sıralaması |
| 12 | **reflection** | operatör günlük raporu (§9) |
| 13 | learning (post) | kanıt-kapanışı sonrası öğrenme |
| 14 | metrics | süre, maliyet, artifact sayısı |
| 15 | observability_dashboard | cycle dashboard'u |
| 16 | (extended phases) | architecture_postcheck / validation_matrix / pr_lifecycle |

Cycle her zaman tipli bir terminal satırla kapanır: `completed` / `failed` / `aborted` /
`stopped` (`cycle.py:553-578`). Post-tool faz hataları cycle'ı çökertmez — `runtime_status`'u
`failed`'a düşürür ama ledger yine de kapanır. Çıktı: zengin bir `state` dict (tüm faz payload'ları).

**Heartbeat vs Cycle:** bir **tick** (`heartbeat_tick`) cycle'lar arası hafif, lock'lı bir
servis nabzıdır — discovery/memory/pressure koşmaz; yargıç sampling + fan-out + consensus,
fixture refresh, CI-review üretir. **cycle**, tam discovery→reflection pipeline'ıdır.

---

## 5. Bellek + Belief'ler — `memory.py`

ARIA gözlemlerini **belief**'lere (inançlara) dönüştürür. Belief state machine:
`supported → needs_revalidation → stale` (+ `contradicted` / `withdrawn`). Her belief
`evidence_refs`, `confidence`, `verified_at`, `needs_revalidation_cycles` taşır.

Decay iki yolla:
- **Değişiklik-bağlı** (`_apply_diff_to_existing_beliefs`): bir diff belief'in kanıtına
  dokununca → `needs_revalidation`/`stale`.
- **Yaş-bağlı** (P028, `decay_stale_beliefs_by_age`): `verified_at` TTL'i (90g) aşan `supported`
  belief → `needs_revalidation` (değişiklik olmasa bile). `run_pressure` bunu operatör baskısına çevirir.

`needs_revalidation`/`stale` belief'ler pressure'a, oradan reflection raporuna ve next-cycle
plan'a akar.

---

## 6. Pressure (reaktif) + Proaktif + Runtime sinyalleri — `pressure.py`

**Reaktif baskı** (`run_pressure`): discovery_incomplete, migration_surface_repeat, stale/
needs_revalidation belief'ler, açık contradiction'lar, tool_quarantine, shadow_raw_delta.
Her biri skorlanır: `score = source_weight × recency_decay × (1 + log10(occurrence))`.
Baskı yoksa cycle yalnız reflect eder.

Bu oturumda eklenen iki eksen:
- **Proaktif önceliklendirme** (P027, `proactive_priority.py`): baskı olsun olmasın her cycle,
  `priority = impact × opportunity`. Impact = kritiklik (security/tenant/edge yüksek); Opportunity
  = boşluk (gold-set yok / az-yargılanmış / kalibrasyon-degraded). "Hiçbir şey yanmıyorken
  nereye yatırım yap" sorusunu yanıtlar.
- **Runtime sinyal köprüsü** (P029, `runtime_signal_bridge.py`): Sentry/incident/telemetri sinyali
  **repo_verified-olmayan ayrı bir güven sınıfı** (`runtime_unverified`) = *lead* olarak girer,
  asla kanıt değil. `run_pressure` her açık sinyali pressure'a çevirir, "repo kanıtıyla doğrula,
  lead UNVERIFIED" der. **Sinyal nereye bakılacağını, repo kanıtı neyin doğru olduğunu söyler.**

---

## 7. Adapter'lar (araçlar) + sağlık + kalibrasyon + drift tespiti

### 7.1 Adapter nedir, yaşam döngüsü (`tool_registry.py`)
Bir **adapter**, `registry.json`'daki bir manifest satırıdır; ARIA'nın repo'yu tarayıp
observation/finding ürettiği bir **subprocess runner**'dır. `output_schema.required` mutlaka
`read_paths` içerir (adapter'ın neyi incelediğine dair öz-raporu).

Yaşam döngüsü: `DRAFT → SANDBOX → SHADOW → ACTIVE → CALIBRATE → QUARANTINED → ARCHIVED`.
ACTIVE'e tek meşru yol **SHADOW→ACTIVE**'dir ve şart ister: `precision ≥ precision_min` (default
0.85), `critical_false_positives == 0`, ve operatör onayı **veya** auto-promote token (ama
`evidence_chains_valid` asla bypass edilemez).

### 7.2 Sağlık + kalibrasyon (`tool_health.py`, `readiness.py`, `adapter_calibration.py`)
`compute_metrics`: precision, judged_samples, critical FP, crash_rate. `evaluate_health`
otomatik quarantine (scope ihlali, şema hatası, self-output kanıt…) veya ACTIVE→CALIBRATE
düşürme (precision < min, FP eşiği, contradiction…) yapar. `readiness.py` SHADOW→ACTIVE
kapısını **sıfır-blocker** ile geçirir (≥5 kararlı SHADOW run, fixture geçmiş, precision eşiği).
Auto-promote token HMAC-imzalı; ama tüketim-anı HMAC re-verify'ı henüz wired değil (kod notu).

### 7.3 Drift tespiti — LLM'siz mekanik tarama (`tools/aria-poc/poc.py`)
"Pure-mechanical… No LLM, no network." Value-set çıkarıcılar: TS enum/union/const-array, zod,
graphql, sql, **rust enum (P026)**, UI option-group. **Drift** = `find_drifts`: diller-arası
value-set uyuşmazlığı (Jaccard benzerliği). Örn. bir Rust enum'u bir TS/SQL enum'unu yansıtıyorsa
drift adayı olur — bu, Rust↔TS event-contract sınırını yakalar. Coverage Invariant burada da:
her dosyaya bir fate. (Bu PoC, kernel'in adapter ağının sürekli kapsayacağı değer yüzeyinin
LLM'siz kanıtıdır; `/aria-poc` operatör aracı olarak koşar.)

---

## 8. Yargıçlar + Consensus + Kalibrasyon (güven katmanı)

ARIA'nın bulgu-güveni çok-yargıçlı bir hatta dayanır:

- **Sampling + fan-out** (P025): `generate_judgment_sample` belirsizliğe yatkın bulguları örnekler;
  `dispatch_judges_for_sample` her bulguya **iki ayrı yargıç** (evidence + adversarial, paylaşılan
  `judgment_group_id`, farklı `judge_id`) mint eder — consensus (≥2 yargıç gerekir) yapısal olarak
  ateşleyebilsin diye.
- **Consensus gate** (`generate_ai_consensus`): aynı bulguya ≥2 yargıç, **oybirliği**, ve ortalama
  güven ≥0.80 → consensus satırı. Aksi halde uncertainty.
- **Kanıt-kapılı arbiter** (P024c): consensus yazılmadan önce yargıçların `evidence_refs`'i repo'da
  doğrulanır; uydurma kanıt (`missing`/`invalid`) → consensus YAZILMAZ, HUMAN_REQUIRED'a eskale.
- **Eskalasyon** (P023): anlaşmazlık/düşük-güven `feedback-consensus-uncertainties.jsonl`'a değil,
  artık idempotent **HUMAN_REQUIRED** kaydına akar.
- **Kalibrasyon** (P024a): her yargıç, aynı bulgudaki `human`/`ai_consensus` ground-truth'a karşı
  puanlanır (precision/recall, LLM'siz). Eşik-altı yargıç → `degraded` sinyali.
- **Operatör geri beslemesi** (P024b): operatör bir consensus eskalasyonunu verdict'le çözünce,
  hüküm otomatik ground-truth havuzuna akar.
- **Gold-set + replay** (P025): onaylı TP/FP'lerden bir gold korpusu promote edilir; yargıçlar o
  gold bulgularda yeniden çağrılıp **gerçek recall** ölçülür.

> Önemli: kalibrasyon (organik) artık replay verdict'lerini dışlar; fan-out kısmi-mint'te kendini
> iyileştirir; replay seed idempotenttir (bu oturumun self-review düzeltmeleri).

---

## 9. Ajanlar + Dispatch + Convergent Planning (P+C+CR+Impl)

### 9.1 Roster (`.claude/agents/aria-*.md`)
13 ajan: planlama (primary/challenger-planner), cross-review, implementer; yargı (evidence/
adversarial-judge, consensus-arbiter); adapter-authoring (primary/challenger-drafter); destek
(change-intelligence, goldset-curator); maintenance (drafter, prompt-writer). Roller `agent_surface.py`'de
SSoT: `REQUEST_ROLES` (17), `JUDGE_ROLES`, `DISPATCHABLE_ROLES` (11), `ROLE_TARGET_PAIRING` (rol↔ajan
eşlemesi — yanlış eşleşme reddedilir). E14 rol hijyeni: üretici olmayan beş rol
(`implementation_review`, `architectural_arbitration`, `auth_security_review`,
`access_boundary_review`, `tenant_isolation_review`) yüzeyden kaldırıldı; alan incelemesi
`specialist_domain_review` üzerinden yürür.

### 9.2 Invocation lifecycle (`agent_invocations.py`)
**Create** → deterministik `request_id`, kanonik prompt, üç ledger atomik. **Claim** → lease modeli
(30dk, ham token bir kez döner, yalnız sha256 saklanır). **Submit** → token/sahiplik/expiry doğrulama,
idempotency+drift gate, `validate_response` → separation-of-duties → **evidence re-verify** →
compliance grade. Kabul edilen yanıt role göre **bridge**'lenir (yargıç→consensus, planner→plan_convergence).
Requeue 2'yi aşınca → sticky **HUMAN_REQUIRED**.

### 9.3 Convergent gate (`plan_convergence.py`) — ARIA'nın amiral pipeline'ı
Append-only event-sourced state machine. Akış: **primary plan → challenger plan → cross-review →
convergence → implementation**. Convergence kapısı: sıfır material risk, bekleyen task yok, round <
max(5). Geçerse `CONVERGED`; aşılırsa `HUMAN_REQUIRED`.

**Bağımsızlık denetimi** (`independence_check.py`) — echo-chamber önler, üç kat: (a) claim_id
disjointness (primary/challenger/cross-review ayrı claim'ler), (b) revision_id distinctness, (c)
**Jaccard** benzerliği > 0.85 → öz-anlaşma flag'i. Kernel ayrıca iki cross-review satırının
`content_hash`'lerinin farklı olduğunu doğrular (aynı = collusion).

**CONVERGED → gerçek kod (V9):** `request_implementation` tek meşru çıkış; `aria-implementer`
`key_changes`'i Edit/Write/sandboxed-Bash ile uygular, kernel-sahipli PR manager üzerinden PR açar
(15 hard-fail güvenlik kontrolü).

---

## 10. Genesis / öz-yenileme (`agent_genesis.py`, `skill_genesis.py`, `capability_gap.py`)

ARIA kendi araçlarını da üretebilir. **Capability gap** = kapsama eksikliği (stub/ghost adapter,
sahipsiz pressure, tekrarlayan unknown, düşük fitness). Gap → `resolve_capability` (reuse varsa
bloklar) → `DraftIntent` grammar (kernel markdown YAZMAZ; body'yi `aria-drafter` subagent sentezler)
→ sandbox (≥3 fixture, gerçek execution provenance) → onay → materialize (`.claude/agents/aria-*.md`'ye
kilitli, üç-event audit zinciri). Adapter-authoring yolu (P-V6): evidence-grounded primary↔challenger
drafting → corpus'ta precision 1.0 → registry tool → SHADOW→ACTIVE merdiveni.

---

## 11. Governance — surface'ler + maliyet

- **State surface registry** (`state_manifest.py`): yazabilen her ledger/state/artifact önceden
  burada **deklare edilmeli**; deklare edilmemiş governed path **fail-closed** (`declared_jsonl_unknown_surface`).
  ~120 yüzey, her biri profil-gate sınıfı + durability + lock-group taşır.
- **Maliyet cap'i** (`cost_budget.py`): LLM spawn'dan ÖNCE `assert_within_budget` — per-run/daily/monthly
  (default $0.50 / $5 / $100). Trip olunca state `tripped` (restart'a dayanır), operatör `reset_breaker`
  + approval_ref olmadan açılmaz. Failure breaker'dan ayrı, co-equal bir devre kesici.

---

## 12. Autonomy orchestrator + PR (`autonomy_orchestrator.py`, `pr_manager.py`)

Tam-zincir bağlayıcı: tek-instance (fcntl lock), `convergence_runner`+`auto_merge_runner`+`github_adapter`
**zorunlu** kwarg (sessiz gate-skip imkânsız). Cycle başına: ARIA_STOP → profil gate → cost/failure
breaker preflight → queue drain → enterprise cycle → planner/bridge/genesis drain → **Gate A** (P+C+CR
convergence) → V9 implementation (PR aç) → specialist review (Gate C) → worker drain → **Gate B**
(post-impl adversarial) → auto-merge (yalnız `review_verdict == no_gaps`).

**PR manager:** profil-gated, base branch yapısal olarak `main`'e sabit, 7-bölümlü PR şablonu
(Problem/Evidence/Solution/Validation/Baseline/Rollback/Provenance). Auto-merge yalnız `autonomous`
profilde + enterprise-readiness + risk policy + rollback bundle + runner attestation ile.

---

## 13. Operatör yüzeyi — reflection günlük raporu

Ana operatör çıktısı `aria-tools/reports/daily/<tarih>.md` (`reflection.py`). Bölümler:
Gate Activity, **HUMAN_REQUIRED** (triyaj kuyruğu, SLA), Coverage, Beliefs/Stale, Top Pressures,
Tool Health, Raw Adapter Runtime, Auto-Merge, **Convergence** (Gate A/B), Pedagogy, **Judge
Calibration** (degraded yargıçlar), **Proactive Priorities**, Committed Findings/Open Debts,
**Next Cycle Plan**. Karar-ilgili olanlar: human_required, convergence, calibration, proactive.

---

## 14. Bu oturumda eklenenler (Plan 023–029)

7 mimari boşluk kapatıldı (hepsi root-cause, full-suite yeşil, PR #680):
- **023** model/effort tiering (scout-and-verify) + consensus→human eskalasyonu
- **024** kapalı-döngü yargıç kalibrasyonu (ölçüm + geri besleme + kanıt kapısı)
- **025** ≥2-yargıç fan-out + gold-set activation + replay recall
- **026** Rust/edge drift ağına (gerçek repoda 352 enum)
- **027** proaktif Impact×Opportunity önceliklendirme
- **028** zaman-tabanlı belief decay
- **029** runtime sinyal köprüsü

Detaylar: `docs/aria/plans/023..029-*.md`. İzli follow-up'lar: ARIA-025/026/027/028/029-D1.

---

## 15. Gerçekten işe yarayacak mı? — Dürüst değerlendirme

Kısa cevap: **Temel (governance + güvenlik substratı) gerçek, sağlam ve iyi test edilmiş.
Otonom çalışma ise tasarlanmış ama henüz koşturulmamış — kabule kadar sürülmemiş bir yetenek.**

**Gerçek ve sağlam olan:**
- Büyük, gerçek bir kernel: **~192 Python modülü**, **~351 test dosyası** (v3–v10 invariant suite'leri
  dahil). Vaporware değil.
- Hash-zincirli ledger'lar, kapalı kanıt allowlist'i + git-blob doğrulamalı `repo_verified`,
  fail-closed profil gate'leri, per-run maliyet kesici — hepsi tam gerçeklenmiş ve testli.
- Anti-halüsinasyon tasarımı ciddi: ajan çıktısı veri, repo kanıtı hakikat; self-output asla kanıt
  olamaz; bağımsızlık denetimi echo-chamber'ı kapatır; her tehlikeli yetenek (tool run, PR, merge)
  operatörün açıkça set ettiği bir profilin arkasında.

**Henüz çalışmayan / iskele olan (dürüst kısım):**
- **Hiç otonom koşu olmamış.** Repo-içi `aria-tools/runs.jsonl` ve `cycles.jsonl` **0 byte / boş**;
  git-tracked yalnız ~10 dosya, onlar da agent-eval fixture'ları. CURRENT_STATE.md repo-içi
  `aria-tools/`'u zaten **geçersiz validasyon yüzeyi** ilan ediyor (temiz deneme izole worktree'den
  koşmalı). Yani repo içinde gerçek bir cycle koştuğunu kanıtlayan hiçbir şey yok.
- **Mainline'a auto-merge gated, canlı değil.** `pr_merge` yalnız `autonomous` profilde; unlock policy
  **30 observe + 30 L1 + 30 L2 supervised + 10 L2 autonomous + 5 L3 + 3 rollback** başarısı, **sıfır**
  kritik ihlal ister. Bu sayaçların karşılandığına dair kanıt yok.
- **LLM dispatch mock yolu destekler.** Real mode var ve Codex managed-auth olmadan fail-closed; ama
  canlı `/aria-poc` operatör aracı açıkça "pure-mechanical — no LLM."
- **Öz-kapanan döngü gap'leri yeni kapandı, yan branch'te.** ADR-033 (autonomous profile) "Accepted"
  ama **`snowball` branch, main'e merge DEĞİL.** ADR-035/036 hâlâ "Proposed."
- **Dokümanda hâlâ "henüz yok" itirafı var:** `IDENTITY.md:36` "Honesty floor: ARIA the system does
  not exist yet… a behavioral contract for a future implementation." CURRENT_STATE bunu geçersiz kılıyor
  ("artık kernel var") — gerçek ikisinin arasında: **kernel var, ama tarif ettiği otonom runtime kabule
  kadar egzersiz edilmemiş.**
- **frozen profil itirafen scoped, global değil** (Plan-021 sertleştirme boşluğu).

**Benim mühendislik kanaatim:**
ARIA'yı değerli kılan, "otonom kod yazan AI" vaadi değil — o kısmı kanıtlanmamış. Değerli kılan,
**LLM'in etrafına örülmüş alışılmadık derecede titiz bir güven/güvenlik iskelesi:** kurcalama-belirgin
ledger'lar, commit-SHA'da git-blob doğrulamalı kapalı kanıt modeli, fail-closed profil kapısı, maliyet
kesici, çok-yargıçlı + bağımsızlık-denetimli consensus. Bu iskele **bugün bile** tek başına kıymetli:
LLM çıktısının halüsinasyonunu yapısal olarak reddeden bir altyapı, çoğu üretim AI-ajan sisteminde yok.

Otonom döngü "işe yarayacak mı" sorusunun cevabı **operatöre bağlı ve henüz açık:** birinin izole bir
runner'da Codex managed-auth ile 30-cycle observe burn-in'i + çok-aşamalı unlock merdivenini koşması,
gerçek dünyada precision/recall'un eşikleri tutturması, ve sayaçların dolması gerekiyor. Tasarım buna
hazır; ama **"hazır" ile "kanıtlanmış" arasındaki mesafe henüz kat edilmedi.** Sistemin kendi otorite
zinciri ve "iddiaya değil kanıta güven" duruşu, tam da bu doküman dahil her şeyin abartılmasını engelleyen
şey — ve bu, paradoksal biçimde, ARIA'nın gerçekten ciddiye alınması gereken yönü.

**Tek cümlede:** Temel gerçek ve nadiren bu kadar titiz; otonomi gerçek-ama-kanıtlanmamış. ARIA bugün
bir "çalışan otonom ajan" değil, **üzerine güvenli bir otonom ajanın inşa edilebileceği, sağlam ve dürüst
bir temeldir** — ve o temelin değeri, otonomi hiç açılmasa bile durur.
