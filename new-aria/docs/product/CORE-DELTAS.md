# Çekirdek deltaları (B-2)

`new-aria/aria-kernel/**`, `tools/aria-poc/**`, `tools/aria-adapters/**`,
`tools/aria-acceptance/**`, `.claude/agents/aria-*`, `docs/aria/**` ve `aria-*`
iş akışları, monorepo `origin/main` üzerindeki ARIA'nın bayt-eş kopyasıdır.
Bu dosya, kopya ile kaynak arasındaki **her** farkı satır satır listeler; boşsa
kopya bayt-eştir. Yeni bir delta eklemek, `NEW-ARIA-URUN-TANIMI.md` §3.1'de bir
`G-*` satırına bağlanmayı gerektirir.

Kaynak commit: `6810d2d79` (aquaculture `origin/main`, 2026-09-03,
"chore(aria): Plan 032 Faz 032b–032i").

## Kopyaya girmeyen kaynak dosyaları (bilerek)

| Yol | Neden |
|---|---|
| `aria-tools/reports/daily/*.md` | aquaculture ARIA durumunun zincir-ucu çapaları; kopyada kalsalar `state_continuity` yeni store'u "zincir kırık" sayıp cycle'ı iptal ediyor (konteyner sondasında ölçüldü). Referans çapa yokken çekirdek `GAP_GENESIS` ile başlar; kopyanın ilk çapası hedef repoda kendi ilk günlük raporuyla oluşur. Bilinen sonuç: `test_aria_tools_tracked_allowlist` içindeki "kullanılmayan desen" kontrolü ilk çapa yazılana kadar kırmızıdır. |
| `aria-debts/*.json` | aquaculture'a ait borç kayıtları. |
| `.github/workflows/{finding-state-sweep,rule-health-report,dataflow-integrity-watchdog}.yml`, `.github/manifests/main-required-status-checks.json`, `docs/runbooks/secret-rotation.md`, `.github/workflows/secret-rotation-reminder.yml`, `.mcp.json` | **kopyaya SONRADAN eklendi** (2. commit): `workflow_contract_registry` bu iki iş akışını ARIA-yönetimli sayar; z1 store-isolation, required-checks parity, v3 preflight ve v12 MCP invariant'ları bunları okur. |
| `tests/invariants/aria-*.spec.ts` | monorepo Jest kurulumuna bağlı ev-sahibi kontratları; kopyada koşturulamaz. `tests/invariants/agent-pedagogy.allowlist.json` alındı (kernel `pedagogy_lint` okur). |
| `CLAUDE.md`, `.gitignore` (kök), `tools/quality/format-scope.json`, `docs/reviews/_registry/**`, husky kancaları | monorepo yönetişimi; new-aria kendi `.gitignore`'unu taşır. |
| `.claude/settings.json`, `.claude/settings.local.json`, `.claude/shared/**`, `infrastructure/nginx/droplet.conf`, `nx.json`, aquaculture `apps/**`/`libs/**` | monorepo'nun Claude Code ayarları, Lane-A inceleme sözleşmesi, nginx ve nx çalışma alanı; kernel testlerinden bunları bekleyenler (v12 DLP/gateway, v4 shared-fragments, `test_project_discovery`, `test_enterprise_cycle` nx-belief'leri, `test_product_fitness_charter` `CI - Affected`) kopyada bilinen kırmızıdır — bkz. "Kernel suite sonucu". |

## Kod deltaları

| Dosya | Delta | G-ID | Monorepo'ya taşındı mı |
|---|---|---|---|
| `aria-kernel/aria_kernel/aria_watchdog.py` | `run_watchdog_sweep` sonucundaki `latest_governance_ts` artık ISO-8601 string (diğer defter zaman damgalarıyla aynı); daemon döngüsü `_parse_iso` ile geri çevirir | G-7 | hayır — önerilecek |
| `aria-kernel/tests/test_watchdog_sweep_json_serializable.py` | yeni regresyon testi: sweep sonucu `json.dumps` ile serileştirilir, string `_parse_iso` ile geri döner | G-7 | hayır — önerilecek |

## Bilinen çekirdek kusurları ve alan sızıntıları

| G-ID | Gözlem | Kanıt |
|---|---|---|
| G-8 | `aria-config/product_fitness_charter.json` aquaculture operatör beyanı; misyon tohumu aquaculture servis adlarını arıyor (`service_mission_refused` ×4) | konteyner sondası governance.jsonl |
| G-9 | çalışma alanında repo-yerel `node_modules/ts-node` yokken 9/9 TS adapter `environment_unavailable` | konteyner sondası runs.jsonl; `scripts/docker/{seed,smoke}.sh` çalışma alanına imajın `node_modules`'ünü bağlar → 8/10 adapter `ok` |
| G-10 | `event-contracts-adapter` alan kökü yokken crash (`scan root does not exist: libs/event-contracts/src`) | konteyner sondası run-artifacts |
| G-11 | `agent-harness-security-adapter` bulguları `evidence` dizisi taşımıyor (`ref` var), 25 validator hatası → `evidence_error` | konteyner sondası run-artifacts; monorepo'da da geçerli olması muhtemel |
| G-12 | `tools/gates/narrative-prompt-lint.ts` düz 2000-token bütçesi kullanırken SSoT olan `aria_kernel/narrative_prompt_validator.py` tier-3 için 3500 kullanıyor; legal ajan prompt'ları (2796–3170 token) kernel validator'ından geçip TS lint'inden düşüyor | legal kası inşası, 2026-09-03; iki uygulama "mantıksal olarak eşdeğer" kalmalıydı |
| G-13 | `tests/invariants/v12/test_phase_v12_e_ops.py::NotificationsAreAudited` (`'deduped' != 'sent'`) monorepo çalışma ağacında da kırmızı — kopyadan bağımsız, Plan 032 ile gelen mevcut kusur | 2026-09-03 aynı test monorepo worktree'de koşturuldu |
| G-7 (düzeltildi, yukarıda) | `cycle run` sonucu `datetime` içerdiğinde `cli.py` `_main` içindeki `json.dumps` `TypeError: Object of type datetime is not JSON serializable` ile çöker; defterler yazılmış olsa da CLI çıkışı boş kalır ve süreç sıfır-dışı çıkar | 2026-09-03 konteyner sondası (`scripts/docker/smoke.sh` ile aynı imaj), `cycle-run.stderr.log` |

## Kopyalanan iş akışlarının hedef repoda beklediği ev-sahibi parçaları

`.github/workflows/aria-*.yml` bayt-eş kopyalandı; şu referanslar kopyada yok ve hedef
repo etkinleştirmeden önce sağlamalıdır (statik tarama, 2026-09-03):

| İş akışı | Referans | Not |
|---|---|---|
| `aria-kernel.yml`, `aria-merge-authority.yml`, `aria-operational-proof.yml` | `npm run aria:docs:ssot` | monorepo Jest invariant'ı (`tests/invariants/aria-doc-runtime-ssot.spec.ts`); new-aria `package.json` bu script'i taşımaz |
| `aria-merge-authority.yml` | `npm run gates:required-status-checks` | monorepo dal koruması kapısı |
| `aria-daily-report.yml` | `tools/scripts/automation/open-report-pr.sh` | monorepo PR açma yardımcı betiği |
| `aria-auto-cycle.yml` | `tools/gates/sens-enterprise-validation.ts` | aquaculture edge (sens) kurumsal doğrulaması — ARIA gece hattına sızmış alan bağı (G-8 sınıfı) |

Ayrıca runner etiketi `[self-hosted, linux, claude]`, repository variables
(`ARIA_STATE_BOOTSTRAP_ACK`, `ARIA_MOCK_KILL_SWITCH`, `ARIA_CONSENSUS_PROMOTION_ACK`) ve
`aria/state` dalı hedef repoda kurulmalıdır (`docs/runbooks/aria-state-branch-bootstrap.md`).

## Kernel suite sonucu (bağımsız `git init` simülasyonu, 2026-09-03)

Tam koşum (`scripts/ci/aria-suite-run.sh`, unittest bölümü; kutu yükü 11–32 / 4 CPU,
8 s): **5260 test, 62 fail + 25 error, 17 skip**. Kırmızı 29 modül güncel kopyada (çapasız,
G-7 düzeltmeli, sonradan eklenen dosyalarla) yeniden koşuldu: **279 test, 24 fail + 2 error**.
Aradaki 61 kırmızı yük/`job_deadline_reached`/eksik dosya kaynaklıydı ve kapandı.

Kalan 26 kırmızının sınıflandırması:

| Sınıf | Modül / test | Sebep |
|---|---|---|
| aquaculture nx çalışma alanı | `test_project_discovery` (13) | `apps/farm-service`, `libs/backend-common`, `sens-api-gateway`… bekler (G-8 sınıfı) |
| aquaculture adapter kökleri | `test_007c_adapters_integration` (3), `test_event_contracts_adapter_integration`, `test_typeorm_adapter_integration` | alan kökü yok → crash / 0 bulgu (G-10) |
| monorepo dosyaları | `test_enterprise_cycle::test_output_contract_compat_finding_is_registered` (`docs/reviews/_registry/findings.jsonl`), v12 DLP (`.claude/settings*.json`), v12 gateway (`infrastructure/nginx/droplet.conf`), v4 shared-fragments (`.claude/shared/`), v5 pedagogy (≥80 ajan korpusu) | bilerek kopyalanmadı (yukarıdaki tablo) |
| aquaculture tüzüğü | `test_product_fitness_charter` (`CI - Affected` iş akışı adı) | G-8 |
| ana daldaki mevcut kusur | v12 ops `NotificationsAreAudited` | G-13 — monorepo'da da kırmızı |
| kapandı (2. commit) | v3 preflight `secret_rotation_workflow…` | `secret-rotation-reminder.yml` kopyaya eklendi |

Pytest-yerli bölüm (`-p aria_kernel.pytest_native_only`) unittest kırmızısı yüzünden ilk
koşumda çalışmadı; hedef repoda `npm run aria:test:unit` her iki bölümü de koşturur.

## Ölçülen çekirdek sınırları (2026-09-04, hukuk kası inşası)

| G-ID | Gözlem | Kanıt |
|---|---|---|
| G-14 | Kas adapter manifesti keşfedilmiyor: `_phase_tool_manifest_sync` yalnız `<workspace_root>/tools/aria-adapters/*.tool.json` gloluyor (`cycle.py:2578`, `:2596`); `packs/*/pack.json` ve `arias/*/aria.manifest.json`'ı çekirdekte hiçbir Python dosyası okumuyor. **Engel değil:** `aria tool register --file <manifest>` (`cli.py:976`) eklemeli çalışır ve hukuk adapter'ı bu yolla kayıt olup koştu. **Tuzak:** `registry compile --adapters-dir X` tüm listeyi tek dizinden yeniden yazar (`registry_compiler.py:52`), yani kas dizini için koşturmak çekirdek adapter'larını siler | 2026-09-04 ölçümü: `tool register` → `tool list` SHADOW; `tool run` → `status: ok` |
| G-15 | Yargı zarfını tüketen tek yol `tools/aria-poc/ci_executor.py --drain` (GitHub Actions) ve `planner-dispatch` daemon'ı (`planner_dispatch_hook.py:295`, yalnız planner rolleri). `CYCLE_PHASES`'te drain fazı yok, konsol drain eylemi açmıyor | `dispatcher_factory.py:12-30`; grep: `next-pending` çağıranları `ci_executor_drain.py:229` ve `aria-agent-executor.yml:402` |
| G-17 | `finding.emit_finding` her kanıt için tam `repo_verified` ister (`finding.py:285-290`) ve `_target_sha` git HEAD çözülemezse `finding_evidence_target_sha_unavailable` ile **patlar** (`finding.py:260`). Belge arşivinde git yoktur → hukuk bulgusu kernel defterine hiç giremez | Ölçülen koşumda dava dosyalarının kanıt derecesi `worktree_candidate` |
| G-18 | **Tool runner, adapter'ın kodunun gözlenen külliyatın içinde olduğunu varsayıyor:** `cwd` çalışma alanı kökünün altında olmalı (`tool_runner.py:78-84`) ve ts-node adapter'ı için `<cwd>/node_modules/ts-node/dist/bin.js` şart (`tool_runner.py:694`). Dış bir külliyatı gözleyen bir kas için bu yanlış; hukuk dağıtımı bu yüzden çalışma alanı kökünü ARIA kurulumu yapar ve dava arşivlerini onun altına koyar | 2026-09-04: cases dizini çalışma alanı kökü olduğunda `environment_unavailable`; ARIA kurulumu kök olduğunda `ok` |
| G-19 | `PLAN_020_WRITE_SURFACES` sayısı `test_frozen_profile_global_no_write.py:222` içinde **42 olarak sabit**; yeni bir `state_manifest` yüzeyi bu sayıyı kasıtlı olarak kırar (tasarlanmış kapı). Hukuk yüzeylerinin deklarasyonu (G-5) bu yüzden bilinçli bir çekirdek kararıdır | `state_manifest.STATE_SURFACES` Python literal'i; `validate_state_surface_patterns()` import anında koşuyor |
| G-20 | **Bir git deposunda, işlenmemesi gereken bir külliyat adapter tarafından okunamıyor.** `evidence_validator` her `read_path`'in anlık görüntünün izin verdiği yollar içinde olmasını ister; `snapshot.py` git varken `git ls-files [--others --exclude-standard]` kullanır, yani `.gitignore`'lı bir dizin görünmez. Dava arşivi commit edilmemelidir (müvekkil belgesi), dolayısıyla her koşum `read_path_outside_snapshot` → `evidence_error`, ve iki koşumdan sonra adapter **karantinaya** giriyor | 2026-09-04 ölçümü: aynı arşiv, git çalışma ağacında `evidence_error` + `quarantine` (`health.jsonl`: "self-output evidence or invalid evidence chain"); git olmayan çalışma alanında (`_filesystem_paths` yolu, konteynerdeki `/opt/new-aria` ile aynı şekil) `run status: ok`, `evidence valid: None`, 2 iddia + 6 taraf + 12 olay üretti. **Dağıtım bu yüzden geçerli, geliştirici worktree'si değil**; sondalama yaparken çalışma alanı kökü git olmayan bir kopya olmalı |

## Aday deltalar (Faz 8, karar kapısı — uygulanmadı)

2026-09-04 bağımsız denetimi (`wf_915de46a-042`) hukuk kasının **model hattının** üç çekirdek
kapanışıyla bloke olduğunu ölçtü. Üçü de kernel değişikliğidir; B-1/B-2 sözü gereği bu
oturumun Faz 0–7'sinde yapılmaz. Aşağıdakiler **aday**dır: uygulanmamış, operatörün Faz 8
kapısındaki kararına bağlı. Her biri eklemeli olacak ve pinleyen testleri silmeden yeniden
yazacaktır.

| ID | Kapattığı | Aday şekil | Kanıt |
|---|---|---|---|
| G-21 | G-3 | `agent_surface.py` rol sözlüğü, hedef beyaz listesi, `ROLE_TARGET_PAIRING` ve `agent_resolver` pack manifestindeki `agents[]` bildirimini okur; `packs/legal/pack.json` roller ve dosya yollarını bildirir; `test_role_hygiene_e14.py`, `test_agent_surface_ssot.py`, `test_agent_contract.py`, `test_surface_manifest_validator.py`, `test_x1_drain_topology.py` pack kaynağını kapsayacak şekilde yeniden yazılır | Dört kapalı literal + çözücü (`agent_surface.py:14,56,61,118,144`; `agent_resolver.py:36-40`); `legal_timeline_analysis` vb. roller kernel'e yabancı |
| G-22 | G-15 | `aria agent drain` alt komutu `ci_executor_drain.drain_pending(tools_dir, repo_root)`'u GitHub'sız çağırır (`GITHUB_RUN_ID` zaten "local" varsayıyor); hukuk compose'unda drain hizmeti | Tek çağıran `.github/workflows/aria-agent-executor.yml:517`; `./bin/aria agent --help` 6 alt komut, drain yok; `CYCLE_PHASES`'da drain fazı yok |
| G-23 | G-17 | `evidence_trust`'a içerik adresli derece `archive_verified` (dosyanın sha256'sı alım tutanağı / anlık görüntü hash'iyle eşleşiyor); `EvidencePolicy.require_repo_verified` git'siz kökte bunu kabul eder; `finding._target_sha` HEAD'siz çalışır | `finding.py:252-261,285-291`; `evidence_trust.py:106-137` (sha256'yı zaten hesaplıyor, `baseline_unavailable` veriyor); `evidence_validator.py:553,601`; ölçüldü: git'siz kökte verdict reddediliyor |
