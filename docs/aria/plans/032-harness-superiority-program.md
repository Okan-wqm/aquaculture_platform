<!-- ARIA-HISTORICAL: Historical plan document.
Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 032 — Harness Superiority Program

> **Status:** Faz 032a in progress (2026-09-02). Faz sırası 2026-09-02 ikinci incelemeyle
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

- `CONVERGED → stage_converged_plan_for_pr → implementer (032b zarfı + 032c checkpoint) → izole
worktree → testler → bağımsız validator (Gate B) → pr create (intent/receipt) → own_pr_ci canlı
CI reconciliation`. **Auto-merge yok**; dış yazma yalnız `aria-impl-*` branch push + PR.
- Görev kaynağı kontrollü: operatör `agent request` CLI / mevcut pressure kaynakları; issue/gateway
  yok.
- Kabul: ≥3 canlı `aria-impl-*` PR açılmış, CI durumu ledger'da GitHub'dan okunmuş, false-success 0,
  duplicate PR 0, kill sonrası recovery başarılı. Bu SLO tutmadan 032e+ başlamaz.
- Opsiyonel: `hermes_runtime.py` adapter spike'ı (1–2 gün) — aynı SLO tablosuyla ölçülür.

## Faz 032e — Operasyon yüzeyi (observability + control)

- `doctor` tam; Prometheus metrik seti + Alertmanager kuralları + Grafana; `tail <request_id>`;
  dead-letter/dedup.
- **Control** — `control pause|resume|cancel`: cancel → yeni tool dispatch durur → SIGTERM process
  group → grace → SIGKILL → checkpoint → external effect reconciliation → terminal
  `CANCELLED_BY_OPERATOR` (actor + reason; otomatik retry yok, bütçe fault üretmez).
- NEW `aria_kernel/notify.py`: kapalı kanal kümesi (`github_issue`, `email`, `telegram`), dedup.

## Faz 032f — Gateway, webhook, scheduler

- NEW `aria_kernel/gateway/` (stdlib HTTP, 127.0.0.1 bind; HMAC + replay window + body limit +
  read timeout + content-type + actor/repo allowlist + `author_association` kontrolü + payload
  minimization/retention + key rotation); kapalı `EVENT_KINDS`; idempotent `events/inbox.jsonl`;
  router → `mission.open_mission` / `pr_tracking.observe_pr_event` / `runtime_signal_bridge`;
  scheduler = kapalı aksiyon sözlüğü; **tek store API'siyle publish** (ilke 1). GitHub içeriği
  `text_safety` sınırından untrusted task input olarak girer.
- systemd unit + nginx `/aria/webhook/` + runbook; `PlanCandidateSource.GITHUB_ISSUE`.

## Faz 032g — MCP client/server

- CLI floor ≥ 2.1.221; `mcp/registry.json` + `mcp_client.py` (`--strict-mcp-config`,
  include/exclude,
  quarantine); `aria-kernel mcp serve` önce read-only; yazma araçları `ack_ledger` tek-kullanımlık
  token (actor, action, target, expiry, nonce, consumed) ile.

## Faz 032h — Skill lifecycle + paralellik

- `skill curate` yalnız `PROPOSE_ARCHIVE|PROPOSE_MERGE` üretir (panel/promotion authority onayı);
  `skill rollback` (eksik CLI); shadow karşılaştırma.
- Drain paralelliği: 032d SLO ≥ 2 hafta tutunca `executor.max_concurrent=2`, request başına
  worktree, merge-conflict reconciliation.
- Merge otoritesi: `autonomous` profil + ladder/unlock değişmez. Deploy/canary otomasyonu bu planın
  dışında (ROADMAP "Never: deploy to production"; ayrı operatör kararı).

## Faz 032i — Self-improvement lane + decision memory + token economy

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
