<!-- ARIA-HISTORICAL: Historical plan document.
Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 032 — Harness Superiority Program

> **Status:** Faz 032a delivered (PR #1401, 2026-09-03); Faz 032b-1/2/3 coded 2026-09-03 (tests written, NOT run — see "Çalıştırılmayan testler"); 032c+ coded in sequence on the same stacked branch. Faz sırası 2026-09-02 ikinci incelemeyle
> yeniden kesildi: tek-worker delivery closure 032d'ye çekildi, güvenlik zarfı 032b'ye toplandı.
> **Branch:** `feat/aria-032a-cycle-repair` (Faz 032a); her faz kendi branch'ini açar.

## Summary

Bu plan, repo-içi ARIA'yı Hermes-sınıfı harness ajanlarından **kendi alanında** — repo-şekilli,
kanıt-disiplinli otonom mühendislik — belirgin biçimde daha yetenekli hale getirir. Hermes yalnız
desen kaynağıdır; executor Claude Code CLI olarak kalır (operatör kararı, 2026-09-02; executor
sınırı `claude_runtime`/`codex_runtime` deseniyle pluggable kalır, bir `hermes_runtime` spike'ı
032d sonrası ölçülebilir).

Koddan doğrulanan başlangıç durumu (2026-09-02):

- Kontrol düzlemi güçlü: evidence trust, hash-chained ledger (POSIX lock + fsync + atomik
  append), profile gate, merge authority, model fleet + cross-provider fallback, adapter tool
  registry, `aria/state` store (fast-forward-only publish + `contention_replay`), skill sandbox.
- Gövde ince ya da yok: agent'ın kendi Bash'i için komut-anı enforcement (allowlist yalnız
  prose), `run_env = os.environ.copy()`, workspace checkpoint, Claude session resume, per-agent
  scope, event girişi (webhook/issue), MCP, bildirim, birleşik ops yüzeyi.
- Canlı funnel: 725 request, 0 `primary_plan`, 13 `challenger_plan` (hepsi
  `challenger_unavailable`), **0 CONVERGED**, 0 `aria/*` PR; 2026-08-31 state reset sonrası her
  nightly `cycle_failed`.

Beş yük taşıyan mekanizma (Faz 032a bunları kapatır):

1. `fixture-runs.jsonl` satırı 1 MiB okuma tavanını aşıyor (yazıcı sınırsız) → `fixture_refresh`
   failed → `cycle_failed` → publish `snapshot_surface_line_too_large` → her gece minted
   request'ler `aria/state`'e ulaşmıyor.
2. `plans/*.jsonl` (write-driving) 2026-08-31 elle compaction'da silinmiş → `fold_plan_state`=None
   → drainer her gece `start_plan` + 1 challenger (treadmill).
3. Cycle-içi dispatcher poll'u GHA lane'de yapısal olarak kaybediyor (executor cycle'dan SONRA
   koşar).
4. Anchor ömrü 3 gün, bir plan ≥3 executor→cycle turu ister; 528 `anchor_expired`; seçim yolu
   tek-request türetimle 29 dk tarıyor (batch form var, kullanılmıyor).
5. Parametreli release reason'lar (`submit_timeout_*`, `plan_content_invalid:*`, `agent_refused:*`)
   hiçbir tabloda yok → varsayılan kova.

## İlkeler (her fazda; Hermes'ten üstünlüğün tanımı)

1. Her karar hash-chained ledger'da; **tek ledger otoritesi = `aria/state`**: her producer (GHA
   lane, executor, gateway daemon) aynı store API'siyle yazar ve yalnız
   `state_store.publish_with_contention_replay` ile yayınlar; hiçbir producer özel bir chain head
   tutmaz (one-way door — `docs/aria/v3-one-way-door-decisions.md`).
2. Onay LLM yargısı değil deterministik politika (Claude `auto` classifier ve Hermes `smart` mod
   kopyalanmaz); dış yazma (`git push`, PR, yorum) intent/receipt olmadan yapılmaz.
3. Cron/scheduler = kapalı aksiyon sözlüğü; serbest prompt yok. GitHub/issue içeriği her zaman
   **untrusted task input**, asla sistem talimatı.
4. Skill/agent auto-promotion yok (panel + veto); curator yalnız öneri üretir.
5. Recovery = dış etki sınıflandırma + gerçek dış sistem sorgusu; "yeniden başlat" değil.
6. Her yeni yüzey `state_manifest`'te + reachability; runtime profil otoritesi kernel-owned veri
   (`aria-kernel/aria_kernel/data/runtime-profiles/*.json`, READONLY_PATHS + authority hash),
   frontmatter yalnız referans.
7. Önce tek worker ile uçtan uca zincir; paralellik ve yeni giriş kapıları ancak zincir SLO
   tutturunca.

Sıra: 032a → 032b → 032c → 032d → 032e → 032f → 032g → 032h. Her faz: ayrı PR seti, suite yeşil,
`CURRENT_STATE.md` anchor, authority hash, canlı lane'de kanıt.

## Faz 032a — Funnel recovery + state reconciliation + `doctor`

Amaç: canlı lane'de planlar tekrarlanabilir biçimde CONVERGED olana kadar zinciri açmak.

Operatör ön adımları (kod değil): `git tag aria-state/pre-032a origin/aria/state` (forensic
işaret); 032a merge edilene kadar `aria-auto-cycle` schedule'ı `ARIA_STOP`/disable ile duraklat
(cycle'lar publish'te öldüğü için branch'e bozuk request ulaşmıyor; duraklatma, onarım sırasında
runner'ı boşa yakmamak için).

1. **Ledger yazma/okuma tavanı paritesi** — `ledger._append_jsonl_locked_body` satırı yazmadan
   ÖNCE `LEDGER_ROW_MAX_BYTES` (= snapshot okuma tavanı) ile karşılaştırır; aşarsa
   `LedgerRowTooLargeError("ledger_row_too_large:...")` (ARIA-HIGH-034 ile geldi) (I-V12-LEDGER-01).
   Okuyucular sabiti
   ledger'dan import eder (I-V12-LEDGER-02). `fixture_runner` 512 KiB bütçesi (#1395) korunur;
   `_phase_fixture_refresh` limit hatalarını tool-bazlı `blocked` kaydeder (I-V12-LEDGER-03).
2. **Write-driving ledger koruması + audit'li sıfırlama** — `compact_state` sahip olmadığı
   write-driving ledger'lara dokunmaz (I-V12-STATE-01); `memory_gap.write_driving_lost` kaybı ayrı
   satırla adlandırır (I-V12-STATE-02); `doctor` `plan_ledger_missing_with_live_requests` raporlar.
   Temiz başlangıç audit'i kırmaz: `state acknowledge-surface-reset --surface <name>
--archived-sha256 <git blob sha> --reason ... --operator-approval-ref <gov:|review:|ack-env:>`
   governance'a `write_driving_surface_reset` olayı yazar (önceki yüzey hash'i + onay ref'i).
   Deferred D2: plan-events için arşiv-hash'li yüzeye özel compactor.
3. **Cycle-içi poll'u kapat** — GHA cycle lane'i `ARIA_DISPATCHER_POLL_TIMEOUT_SECONDS=0`;
   `rhythm.min_interval_hours` policy'ye (default 6, operatör override 2; I-V12-RHYTHM-01).
4. **Anchor politikası** — `agent_request_anchor.max_age_seconds` 7 gün; `next_pending_request`
   tek batch fold (I-V12-QUEUE-01).
5. **Release-reason sınıflandırması** — `classify_release_reason` → `harness | request |
unclassified`; prefix tabloları (I-V12-RELEASE-01/02). `unclassified` mevcut "insana doğru
   başarısız ol" kuralını korur (bütçe yakar → 2 requeue → HUMAN_REQUIRED; sonsuz retry yok) ve
   `unclassified_release_reason` governance olayı yazar (I-V12-RELEASE-03). Yapılandırılmış
   `{reason_code, reason_detail, fault_domain}` zarfı 032b "release reason v2" (ledger string'i
   one-way door).
6. **Küçük kırıklar** — `ARIA_MOCK_KILL_SWITCH` yalnız `true|false`; `cost_attribution_missing`
   kök nedeni ölçülür (D1).
7. **`aria-kernel doctor [--json]`** — `aria_kernel/doctor.py::run_doctor`: integrity, runtime
   artifacts, breaker + cost state, host lease, provider availability, sandbox backend, Claude CLI
   floor (workflow/provision literal'leriyle tek değer), habitat, funnel, plan ledger. Exit 0 / 3.
   Operatör komutu; lane preflight'ına bağlanması D3.
8. **Hijyen** — `.claude/settings.local.json` JWT-şekilli literal'ler silindi; kernel testi
   `.claude/settings*.json` dosyalarını `readiness_proofs.DLP_PATTERNS` ile tarar (I-V12-DLP-01).

Çıkış kriteri (canlı, operatör okur): ≥3 bağımsız plan `CONVERGED` (`tools/plans/*.jsonl`);
deterministic replay 10/10 (`bridge replay`/`judge replay`); yeni `ledger_row_too_large` 0; yeni
`challenger_drafted_poll_timeout` 0; `agent next-pending` p95 < 5 s; `aria/state` üzerinde manuel
düzenleme 0 (`state_compact` dışı); aynı request'in duplicate processing'i 0; `doctor` exit 0.

## Faz 032b — Minimum secure execution envelope

Yazma-yetkili agent'ın çalıştığı zarf, hooks'tan ÖNCE kapanır; dış yazma 032c'ye kadar kapalı.

Teslimat 032b-1 (2026-09-03, PR stacked on #1401): kernel-owned runtime profiles
(`aria_kernel/data/runtime_profiles.json` + `runtime_profiles.py`; 18 ajan `runtime_profile:`
referansı + mirror doğrulaması, I-V12-PROFILE-01..05); spawn ortamı `agent_env.build_agent_env` ile
KURULUR (baseline + CLI auth + profil passthrough; secret-şekilli isimler düşer; sentetik HOME/XDG;
`CLAUDE_CONFIG_DIR` açıkça türetilir ve sandbox'a ro-bind), governance
`claude_subprocess_env_filtered` (yalnız isimler); `--disallowedTools` profilden türetilir
(verilmeyen tool'lar + `external_writes: false` iken `Bash(git push*)`, `Bash(gh pr create*)`,
`Bash(gh api*)`… — her izin modunda bağlayıcı); `wrap_bash_in_sandbox(write_scope=)` workspace'i
ro, yalnız scope'u rw bağlar; `ci_executor` spawn'a açık `cwd` geçer (I-V12-ENV-01..05).
Teslimat 032b-2 (2026-09-03): `command_policy.py` — tek kanonik politika (kernel regex'leri
DERIVED, `ALLOWED/DENIED_BASH_COMMANDS` desen-eşit; Claude projeksiyonları; örnek doğrulaması
`verify_examples`), `claude_settings.py` — spawn başına `--settings` (permission allow/deny + 5 hook),
`hooks.py` — PreToolUse kararı (policy + READONLY_PATHS + path-escape; hata = deny), PostToolUse
sanitized journal (`agent-invocations/work-journal.jsonl`), session hook'ları → `handoff_ledger`;
`hooks/decisions.jsonl`; CLI `hook pre-tool|post-tool|session`; `tools/aria-poc/hook_probe.py` +
capability-probe adımı (I-V12-POLICY-01..04, I-V12-HOOK-01..06).
Teslimat 032b-3: `release_reason.py` — `{reason_code, reason_detail, fault_domain}` zarfı claim
release/requeue satırlarında (I-V12-REASON-01/02).

Çalıştırılmayan testler (operatör talimatı 2026-09-03 — commit başına sonra koşulacak):
`tests/invariants/v12/test_phase_v12_b_command_policy.py`, `test_phase_v12_b_hooks.py`,
`test_phase_v12_b_release_reason.py`; ayrıca 032b-1 için koşulanlar
(`test_phase_v12_b_runtime_profiles.py`, `test_phase_v12_b_agent_env.py`: yeşil) hariç tam suite ve
jest 032b üzerinde koşulmadı. Canlı probe (`hook_probe.py`) runner'da koşulmadı.

- **Runtime profiles (kernel-owned)** — `aria_kernel/data/runtime-profiles/<role>.json`:
  `model_tier`, `effort`, `tools`, `write_scope`, `env_passthrough`, `budget_usd_per_run`,
  `max_concurrent`, `external_writes: false`. Agent md `runtime_profile: <role>` referansı;
  `agent_runtime_profile` bu dosyayı okur; frontmatter yetki tanımlamaz (validator reddeder).
- **Environment izolasyonu** — `run_env` sıfırdan kurulur: `PATH LANG LC_ALL TERM TMPDIR` +
  sentetik `HOME`/`XDG_CONFIG_HOME`/`XDG_CACHE_HOME` (`/tmp` tmpfs altında request-özel), yalnız
  `CLAUDE_CONFIG_DIR` ro-bind (managed login), provider redirect env, profil `env_passthrough`;
  desen filtresi (`KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PASSWD|AUTH`) deklare edilmedikçe düşer;
  governance `claude_subprocess_env_filtered` (yalnız isimler). Runner kullanıcısının gerçek home'u
  görünmez.
- **Exact cwd + write scope** — `ci_executor` spawn'a `cwd=workspace`; `wrap_bash_in_sandbox(
write_scope=)` workspace ro, scope rw.
- **Canonical CommandPolicy** — NEW `aria_kernel/command_policy.py`: kural nesneleri →
  `to_regex()` (kernel), `to_claude_rule()` (`permissions.allow/deny`), `examples`
  (pozitif/negatif);
  invariant her kural için üç hedefin aynı örnek kümesinde aynı kararı verdiğini koşar.
  `ALLOWED_BASH_COMMANDS`/`DENIED_BASH_COMMANDS` bu modülden türetilir.
- **Hooks** — spawn başına `--settings` (permission rules + hooks); NEW `aria_kernel/hooks.py`:
  PreToolUse Bash/Edit/Write (policy + READONLY_PATHS + path-escape), PostToolUse journal,
  Session hook'ları → `handoff_ledger`. Canlı probe: hook deny'ın `bypassPermissions` altında
  bloklaması; aksi halde `acceptEdits` + allow rules.
- **Sanitized work journal** — `agent-invocations/work-journal.jsonl`: `{request_id, session_id,
seq, tool_name, command_family, argv_redacted (secret_scrub), command_hash, files_touched,
exit, duration_ms, external_effect}`; ham komut asla ledger'a girmez.
- **Release reason v2** — `{reason_code, reason_detail, fault_domain}` zarfı; string alanı
  uyumluluk için kalır.
- Kabul: env-leak testi (agent alt süreci `os.environ`'de token göremez), policy üçlü-eşdeğerlik
  testi, hook deny canlı probe, `git push`/`pr create` deny kanıtı.

## Faz 032c — Checkpoint, session continuity, recovery

Teslimat 032c (2026-09-03): `checkpoint.py` (shadow bare git store `~/.aria/workspaces/<repo_hash>/
checkpoints/store`, `refs/aria/<request>/<seq>`, take/diff/restore(hand-edit korumalı)/prune; PreToolUse
hook yazma öncesi tetikler; executor write-capable spawn öncesi alır, non-zero çıkışta yerel rollback +
`implementation_rolled_back`); `session_continuity.py` (claim'e bağlı Claude session id, fingerprint =
target_sha+profile+prompt_hash+settings_hash+model family+policy version; `--session-id`/`--resume`);
`recovery.py` (intent/receipt ledger, `gh` remote reader, `idempotent_replay|resume|external_effect_check|
human_required`; executor human_required'da `recovery_unresolved_external_effect` ile release eder;
`pr_manager` push/PR-create'i intent/receipt ile sarar); `search.py` (SQLite FTS5 türev indeks, workspace
dışı). CLI: `checkpoint`, `session`, `recovery classify`, `search`.
Çalıştırılmayan testler: `tests/invariants/v12/test_phase_v12_c_checkpoint.py`,
`test_phase_v12_c_session_recovery.py`, `test_phase_v12_c_search.py`.

- **Checkpoint** — NEW `aria_kernel/checkpoint.py`: shadow bare git store
  `~/.aria/workspaces/<repo_hash>/checkpoints/` (workspace dışı, publish edilmez, agent'a
  görünmez); ref `refs/aria/<request_id>/<n>`; turn başına bir; `list|diff|restore(files,
preserve_hand_edits)|prune`; index `checkpoints/index.jsonl` (declared). Otomatik rollback
  yalnız yerel dosyalar; dış etki reconciliation'a bırakılır.
- **Session** — claim satırına `claude_session_id`; `--session-id` / koşullu `--resume`; resume
  yalnız **session fingerprint** eşleşince: `{target_sha, profile_hash, prompt_hash,
tool_manifest_hash, settings_hash, model_family, policy_version, workspace_tree_hash}`.
- **Recovery** — NEW `aria_kernel/recovery.py`: dış etkiler intent/receipt çiftiyle
  (`external-effects.jsonl`: `operation_id, effect_kind, target, idempotency_key,
intended_postcondition, observed_receipt`); karar journal'dan değil GitHub sorgusundan
  (`own_pr_ci`, `pr_tracking`) → `idempotent_replay | resume | external_effect_check |
human_required`. Kill/restart testleri (mock executor SIGKILL → resume, duplicate push 0).
- **Arama** — NEW `aria_kernel/search.py`: ledger'lardan türev SQLite FTS5 indeksi (truth değil).

## Faz 032d — Tek-worker repository delivery closure

Teslimat 032d (2026-09-03): `delivery_credentials.py` — `external_writes: true` olan TEK profil
(implementer) için spawn anında `gh_token_factory` scoped lease mint edilir, yalnız o spawn'ın inşa
edilmiş env'ine `GH_TOKEN` + env-only git credential helper (`GIT_CONFIG_*` → `gh auth git-credential`)
olarak girer, `finally`'de revoke edilir; governance `delivery_credential_issued|revoked|refused` (isim +
mod + TTL, asla değer) ve PAT modunda `installation_token_fallback_active`. Mint başarısız → spawn koşmaz
(`DELIVERY_CREDENTIAL_EXIT=78`). Executor her spawn'a `ARIA_REQUEST_ID`/`ARIA_CLAIM_ID` verir; `pr_manager`
push/PR-create intent-receipt'lerini spawn içinde agent request'e (dışarıda `proposal:<id>`) anahtarlar
ve postcondition'a `proposal_id` yazar → recovery sınıflandırması ve closure raporu etkiyi görür.
`delivery_closure.py` — implementation request başına kapalı `DELIVERY_STATES`
(`dispatched … ci_green|merged|duplicate|human_required`) ve SLO özeti (verified ≥3, false-success 0,
duplicate 0) yalnız etki ledger'larından (external-effects, pr-lifecycle, own-pr-checks, merge-outcomes,
recovery decisions) türetilir; `doctor` organı `delivery_closure` (duplicate=fail, false-success=warn);
CLI `delivery status [--json]`. `aria-implementer.md` 200 satır tavanına geri çekildi (jest
`agent-size-limit`). Bağımsız doğrulayıcı = mevcut Gate B (`review_runner`) + own_pr_ci; auto-merge yok.
Çalıştırılmayan testler: `tests/invariants/v12/test_phase_v12_d_delivery.py`
(+ güncellenen `test_phase_v12_b_runtime_profiles.py` iki assertion). Canlı kabul (≥3 `aria-impl-*` PR)
operatör adımıdır; rapor `aria-kernel delivery status` ile ölçülür.

- `CONVERGED → stage_converged_plan_for_pr → implementer (032b zarfı + 032c checkpoint) → izole
worktree → testler → bağımsız validator (Gate B) → pr create (intent/receipt) → own_pr_ci canlı
CI reconciliation`. **Auto-merge yok**; dış yazma yalnız `aria-impl-*` branch push + PR.
- Görev kaynağı kontrollü: operatör `agent request` CLI / mevcut pressure kaynakları; issue/gateway
  yok.
- Kabul: ≥3 canlı `aria-impl-*` PR açılmış, CI durumu ledger'da GitHub'dan okunmuş, false-success 0,
  duplicate PR 0, kill sonrası recovery başarılı. Bu SLO tutmadan 032e+ başlamaz.
- Opsiyonel: `hermes_runtime.py` adapter spike'ı (1–2 gün) — aynı SLO tablosuyla ölçülür.

## Faz 032e — Operasyon yüzeyi (observability + control)

Teslimat 032e (2026-09-03): `control.py` — `control/commands.jsonl` (declared, her profilde yazılabilir)
`pause|resume|cancel`; fold = `effective_control` (pause/resume son satır kazanır, cancel yapışkan);
drain loop pause'da claim almaz (`operator_paused`), executor spawn öncesi cancel'ı `operator_cancelled`
ile release eder, spawn sırasında `claude_runtime.SpawnControl` control ledger'ı 2 s'de bir yoklar →
process group SIGTERM → grace sonrası SIGKILL; 032c checkpoint'i geri yüklenir; türetilmiş durum
`CANCELLED_BY_OPERATOR` (terminal; claim'den bağımsız, control ledger'ından), `operator_cancelled` =
OPERATOR fault domain (requeue bütçesi yanmaz). `progress.py` — stream-json olayları sanitize edilerek
(`secret_scrub`, journal argv redaksiyonu, 240 karakter önizleme) `run-artifacts/hot/<request>/progress.jsonl`'a
(declared, hash-chained) yazılır; CLI `tail <request_id> [--follow]`. `notify.py` — kapalı olay sözlüğü,
kanallar `stdout|github_issue|email|telegram` yalnız env ADLARIYLA konfigüre, imza bazlı 6 saat dedup,
`notifications/outbox.jsonl` her denemeyi (`sent|failed|deduped|dry_run|unconfigured`) kaydeder;
üreticiler: `human_required_recorded`, `circuit_breaker_tripped`, `cost_budget_breaker_tripped`, cycle
failed (orchestrator). `telemetry._store_metrics` — kuyruk/mission/breaker/control/delivery/bildirim/maliyet
serileri; `infrastructure/monitoring/prometheus/alerts/aria-alerts.yml` (7 kural), Grafana
`aria-kernel-dashboard.json`, `scripts/aria/aria-telemetry-textfile.sh` + `infrastructure/aria/
aria-telemetry.{service,timer}` (node-exporter textfile, 5 dk). `doctor` organları `queue|control|notifications`.
CLI: `control pause|resume|cancel|status`, `notify send|channels`, `tail`. Gateway sağlığı 032f'de eklenir.
Çalıştırılmayan testler: `tests/invariants/v12/test_phase_v12_e_ops.py`.

- `doctor` tam; Prometheus metrik seti + Alertmanager kuralları + Grafana; `tail <request_id>`;
  dead-letter/dedup.
- **Control** — `control pause|resume|cancel`: cancel → yeni tool dispatch durur → SIGTERM process
  group → grace → SIGKILL → checkpoint → external effect reconciliation → terminal
  `CANCELLED_BY_OPERATOR` (actor + reason; otomatik retry yok, bütçe fault üretmez).
- NEW `aria_kernel/notify.py`: kapalı kanal kümesi (`github_issue`, `email`, `telegram`), dedup.

## Faz 032f — Gateway, webhook, scheduler

Teslimat 032f (2026-09-03): paket `aria_kernel/gateway/` — `normalize.py` (kapalı `EVENT_KINDS`: 8 GitHub,
2 Alertmanager, `operator.command`; issue gövdesi asla inbox'a girmez, yalnız digest), `inbox.py`
(`gateway/inbox.jsonl` declared; delivery-id başına bir kabul, `routed|rejected` satırları yan yana,
`gateway_rejected` governance), `router.py` (deterministik, kapalı `ROUTE_ACTIONS`: `aria` etiketli issue →
`mission.open_mission(source_kind="github_issue")` (idempotent), PR → `pr_tracking.observe_pr_event`, CI/alert →
`runtime_signal_bridge.ingest_runtime_signal(telemetry|incident)`, operator verb → `control` ledger; istisna =
outcome satırı), `server.py` (stdlib HTTP 127.0.0.1:8787; GitHub HMAC `X-Hub-Signature-256`, Alertmanager/operator
bearer, actor allowlist, 1 MiB gövde, replay 409, dakikalık rate limit, `/aria/status` salt-okunur), `scheduler.py`
(`gateway/schedules.jsonl`; kapalı `SCHEDULE_ACTIONS = cycle|drain|daily_report|doctor|telemetry_export|deliver|
inbox_drain`, serbest prompt yok; 5 alanlı cron, dakikada bir; workflow aksiyonları `gh workflow run` ve operator
pause'da atlanır; heartbeat `gateway/heartbeat.json`), `daemon.py` (pid lock + `autonomous_host_lease` + HTTP
thread + tick; ARIA_STOP/SIGTERM). `PlanCandidateSource.GITHUB_ISSUE` (+ `scan_github_issue_missions`, öncelik =
FAILING_CI katmanı; I-V9-PRESSURE-01 güncellendi, one-way door 14). `doctor` organı `gateway`. Sistem:
`infrastructure/aria/aria-gateway.service`, nginx `/aria/webhook/` + `/aria/status` (rate limit zone),
`provision_runner.sh` unit + env-adı bölümü, runbook `docs/runbooks/aria-gateway.md`. CLI: `gateway serve|status`,
`schedule add|pause|resume|remove|list|run`, `event ingest|route`. Test turu (2026-09-03) sonrası eklendi:
`experiment_night` → `experiment_night.run_night_experiments` (gateway cycle id `gw-exp-*`), `adapter_run:<tool_id>` →
`tool_runner.run_tool` (id, ekleme ve tetikleme anında registry'de ACTIVE olmalı; `validate_action`). Sözlük yine
kapalıdır: tek parametreli biçim adapter id'dir, metin taşıyan aksiyon yoktur (one-way door 14 güncellendi).
Çalıştırılmayan testler: `tests/invariants/v12/test_phase_v12_f_gateway.py`
(+ güncellenen `tests/invariants/v9/test_phase_v9_0_a_plan_candidate_source.py` üye kümesi).

- NEW `aria_kernel/gateway/` (stdlib HTTP, 127.0.0.1 bind; HMAC + replay window + body limit +
  read timeout + content-type + actor/repo allowlist + `author_association` kontrolü + payload
  minimization/retention + key rotation); kapalı `EVENT_KINDS`; idempotent `events/inbox.jsonl`;
  router → `mission.open_mission` / `pr_tracking.observe_pr_event` / `runtime_signal_bridge`;
  scheduler = kapalı aksiyon sözlüğü; **tek store API'siyle publish** (ilke 1). GitHub içeriği
  `text_safety` sınırından untrusted task input olarak girer.
- systemd unit + nginx `/aria/webhook/` + runbook; `PlanCandidateSource.GITHUB_ISSUE`.

## Faz 032g — MCP client/server

Teslimat 032g (2026-09-03): `aria_kernel/data/mcp_registry.json` (kernel-owned, kapalı şema; env
passthrough yalnız AD, secret-şekilli adlar yükleme anında reddedilir; http yalnız https) + `mcp_client.py`
(`mcp_config_for_profile`: yalnız profilin `mcp_servers`'ı, karantinadakiler düşer, profilsiz spawn boş
doküman; `mcp_tool_rules`: adlandırılmayan sunucular `mcp__<server>` ile, hariç tutulan yazma araçları adıyla
`--disallowedTools`'a; `record_mcp_call` → `mcp/tool-calls.jsonl`; ≥10 çağrı ve hata oranı ≥0.5 → `mcp/quarantine.jsonl`

- CLI floor ≥ 2.1.221; `mcp/registry.json` + `mcp_client.py` (`--strict-mcp-config`,
  include/exclude,
  quarantine); `aria-kernel mcp serve` önce read-only; yazma araçları `ack_ledger` tek-kullanımlık
  token (actor, action, target, expiry, nonce, consumed) ile.

## Faz 032h — Skill lifecycle + paralellik

Teslimat 032h (2026-09-03): `skill_curator.py` — kürator yalnız OKUR (`.claude/skills`, ajan dosyalarındaki
referanslar, work journal'daki okumalar) ve `skill-genesis/curation-proposals.jsonl`'a kanıtlı
`PROPOSE_ARCHIVE|PROPOSE_MERGE` satırları yazar (imza dedup); karar `decide_curation` ile yalnız operatör
onay ref'iyle (`accepted|rejected`), dosyaya asla dokunmaz. `rollback_skill_materialization(draft_id,
operator_approval_ref)` — tracked dosya `git restore --source=HEAD`, untracked silinir; `status=rolled_back`
satırı + governance; ikinci rollback ve skill dışı hedef reddedilir. `shadow_compare(draft_id)` — sandbox
satırı (karar/fixture sayısı) ile mevcut dosyanın fixture blokları → kapalı `SHADOW_VERDICTS`. Paralellik:
`genesis_policy.executor_policy()` (`executor.max_concurrent` default 1, [1,8] clamp; `worktree_per_request`
default false); drain `_launch/_settle` ayrımıyla in-flight çocukları politika kadar sınırlar, request başına
`git worktree add --detach aria-worktrees/req-<id> <target_sha>` + iş sonu `remove --force`; executor
`ARIA_WORKSPACE_ROOT`'u workspace kökü olarak alır. Merge otoritesi/ladder değişmedi (auto-merge yok).
`harness_parity.py` — 25 satırlık yetenek → modül → CLI → test tablosu; `check_parity` her satırı import/CLI/
dosya ile doğrular; `docs/aria/generated/harness-parity.md` üretilir (`parity generate|check`). CLI: `skill
curate|proposals|decide|rollback|shadow-compare`, `parity generate|check`. `max_concurrent>1` açmak operatör
kararıdır (032d SLO ≥ 2 hafta). Parity raporunun 032i satırları 032i teslimiyle doğrulanır (rapor 032i'de yeniden
üretilir). Çalıştırılmayan testler: `tests/invariants/v12/test_phase_v12_h_skill_parallel.py`.

- `skill curate` yalnız `PROPOSE_ARCHIVE|PROPOSE_MERGE` üretir (panel/promotion authority onayı);
  `skill rollback` (eksik CLI); shadow karşılaştırma.
- Drain paralelliği: 032d SLO ≥ 2 hafta tutunca `executor.max_concurrent=2`, request başına
  worktree, merge-conflict reconciliation.
- Merge otoritesi: `autonomous` profil + ladder/unlock değişmez. Deploy/canary otomasyonu bu planın
  dışında (ROADMAP "Never: deploy to production"; ayrı operatör kararı).

## Faz 032i — Self-improvement lane + decision memory + token economy

Teslimat 032i (2026-09-03): `context_compiler.py` — karar belleği yalnız GEREKÇE taşıyan satırlardan
(recovery decisions, control komutları, kürasyon kararları, human-required kayıtları, plan/mission olayları,
`reason|rationale` taşıyan governance) toplanır; sıralama deterministik (request ile terim örtüşmesi, sonra
yenilik), token bütçesine kesilir, hash-adresli pack; `create_agent_invocation_request` MINT anında
`row["decision_memory"]` olarak ekler → prompt hash mühürler; renderer `<derived_context
section="decision_memory">` VERİ bloğu üretir; claim projeksiyon alan listesine `decision_memory` eklendi.
`token_economy.py` — `usage_per_accepted_result` (context-usage × accepted results, 14 gün penceresi),
`recommend_efforts` (≥5 spawn ve eşik üstü ya da hiç kabul yok → BİR basamak `downgrade`, taban `medium`,
`human_required_packet` hariç), `calibrate_role_caps` (gözlem), `economy/recommendations.jsonl` (declared),
`effective_effort` executor'da spawn öncesi (7 gün TTL; governance `effort_downgraded_by_economy`); telemetri
`aria_tokens_per_accepted_result`, doctor organı `economy`. `self_improvement.py` — sinyaller (capability gap,
funnel stall, delivery SLO gap, MCP karantina, doctor fail) → `source_kind=self_improvement` mission
(idempotent, çağrı başına ≤3) → `propose_self_change` = `self_change` proposal + HUMAN_REQUIRED
`self_change_adjudication`; kanıt yolları kernel kapsamında olmalı ve `AUTHORITY_SURFACES` (command_policy,
implementation_safety, runtime_profiles(+json), mcp_registry, hooks, claude_settings, agent_env,
delivery_credentials, gh_token_factory, control, self_improvement, runtime_profile, auto_action_gate,
merge_authority, human_required, workflows, genesis_policy.json) reddedilir (governance
`self_change_authority_surface_refused`); `apply_engine` self_change'i kernel-change lane dışında reddetmeye
devam eder. Scheduler aksiyonları `self_improve|economy` (one-way door 17). CLI: `context compile`,
`economy stats|recommend`, `self-improve scan|open|propose`. Parity raporu yeniden üretildi (25/25 doğrulandı).
D4 kapandı (2026-09-03): `semantic_memory._KNOWN_KINDS` `decision` türünü tanır; `context_compiler.embed_decisions`
karar başına bir embedding (ref id ile idempotent) yazar, `rank_decisions` embedder yapılandırılmışsa `nearest()`
benzerliğini birincil anahtar yapar, embedder hata verirse leksikal sıralamaya düşer (asla belleksiz kalmaz).
Testler (2026-09-03 turu): `test_phase_v12_i_self_improvement.py` koşuldu ve yeşil.

Operatör yönü (2026-09-02): ARIA token-ekonomik olmalı, neyi neden yaptığını hatırlamalı ve kendi
kodunu yazıp kendini geliştirebilmeli — ama kendi yetkisini kendisi genişletemeden.

- **Decision memory** — governance/plan/claim ledger'larındaki gerekçeli kararlar 032c `search.py`
  indeksi + `semantic_memory` embedder üzerinden her dispatch'e "önceki kararlar + nedenleri"
  paketi olarak girer; `decision_questioning` kapanmış kararları periyodik yeniden sorgular.
- **Context compiler** — dispatch başına minimal, hash-adresli bağlam paketi; `usage_ledger`
  üzerinden "kabul edilen sonuç başına token" metriği; eşik aşımında otomatik tier düşürme
  (scout-and-verify) ve `context_budget_gate` cap'lerinin ölçümle kalibrasyonu.
- **Self-improvement lane** — `capability_gap` + `funnel_health` + `product_fitness` →
  `aria-kernel/**` hedefli mission (`source_kind = self_improvement`) → `self_change` proposal →
  ayrı lane'de implementer → panel + operatör onayı (`human_required_adjudication` irreducible
  sınıfı korunur) → shadow burn-in → merge. `READONLY_PATHS` ve kernel-scope veto değişmez.

## 032 sonrası adaylar

1. Derin repo ikizi (sembol seviyesi call-graph) → implementasyon öncesi etki tahmini.
2. `change_outcome` → `plan_synthesizer`/`agent_priors` otomatik geri besleme.
3. Fail-first regression kanıtı (fix commit'inden önce kırmızı koşmuş `experiment` binding'i).
4. Tek kullanımlık doğrulama ortamı (`docker-compose.dev.yml`).
5. Vendor-disjoint yargı politikası.
6. İmzalı onay kanalı (MCP + Telegram).
7. Değer/maliyet önceliklendirme.
8. Credential broker.

## Üstünlük metrikleri (parity tablosu yerine; ledger'dan türetilir)

false-success oranı · duplicate external effect oranı · kill sonrası recovery başarı oranı ·
unsafe command escape oranı · verified PR başına maliyet ve süre · ledger divergence oranı · CI
sonucunu yanlış raporlama oranı · rollback başarı oranı · insan müdahalesiz tamamlanan iş oranı.
`product_fitness` charter'ı bu metriklerle genişler; `harness-parity` yalnız sahiplik envanteridir.

## Acceptance

```text
# Faz 032a — kernel
bash scripts/ci/aria-suite-run.sh \
  aria-kernel/tests/invariants/v12/test_phase_v12_a_ledger_write_cap.py \
  aria-kernel/tests/invariants/v12/test_phase_v12_a_queue_and_release.py \
  aria-kernel/tests/invariants/v12/test_phase_v12_a_state_guard.py \
  aria-kernel/tests/test_doctor.py \
  aria-kernel/tests/test_requeue_fault_ownership.py \
  aria-kernel/tests/test_workflow_kernel_cli_contract.py
npm run invariants:fast
npm run aria:authority-hash:write

# Faz 032a — canlı kanıt (operatör)
git tag aria-state/pre-032a origin/aria/state
gh workflow run aria-auto-cycle.yml --ref main -f mode=cycle          # completed + publish ok
PYTHONPATH=aria-kernel python3 -m aria_kernel doctor --tools-dir <store>/tools   # exit 0
# aria/state: plans/*.jsonl mevcut, challenger_plan accepted + bridge ok, sonra >=3 CONVERGED;
# governance: anchor_expired ~ 0, challenger_drafted_poll_timeout 0, ledger_row_too_large 0
```

## Assumptions & deferred — ARIA-032-D4 (owner: aria-core) — CLOSED 2026-09-03

- `semantic_memory` has the `decision` kind; `context_compiler.rank_decisions` uses `nearest()` when an
  embedder is configured (`ARIA_EMBEDDER_CMD`), lexical otherwise. Nothing deferred.

## Assumptions & deferred — ARIA-032-D1 (owner: aria-core, due 2026-10-15)

- D1: `cost_attribution_missing` sentinel'inin kök nedeni 032a'da yalnız ölçülür; kalıcı fix 032b
  per-agent bütçe ile.
- D2: `plans/*.jsonl` için arşiv-hash'li yüzeye özel compactor (write-driving ledger sonsuza kadar
  büyümez).
- D3: `doctor` workflow preflight adımı olarak bağlanmadı (ADR-036 step-order/required-steps
  kontratı değişikliği gerektirir); 032e ops fazında lane'lere girer. Bugün operatör komutudur.
- L1 ladder `observe 0/30`: `pr_open` için `strict` en erken 30 gece ya da operatör
  scheduler-ceiling yükseltmesi; 032d kabulü buna bağlı.
- Hook-deny'ın `bypassPermissions` altında davranışı 032b canlı probe ile.
- `mcp` Python paketi yeni bağımlılık; CLI floor yükseltmesi runner'da operatör işi.
- `aria/state` üzerinde `state_compact` dışı elle müdahale runbook'ta yasaklanır (operatör kalemi).
