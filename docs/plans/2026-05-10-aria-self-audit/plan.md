# Plan — ARIA Self-Audit Sonrası Sıradaki Çalışma (v2 — extended)

**Tarih:** 2026-05-10
**Versiyon:** v2 (genişletilmiş)
**Branch:** `claude/aria-self-audit-F-006` (snowball + 4 commit ahead)
**Plan sahibi:** operatör (Okan-Wqm)
**Plan reviewer:** TBD (önerilen: independent agent — bkz. Phase F)
**Dokümanın amacı:** Yapılan iş + ortaya çıkan iş kalemlerini önceliklendirilmiş, ölçülebilir, geri alınabilir, owner'lı, audit-trailed bir akışa bağlamak.

---

## 0. TL;DR (Executive Summary)

| | |
|---|---|
| **Bitti** | F-006 (MEDIUM) açıldı + 3 commit'le kapatıldı; Tier V 1079/1079 green; ARIA cycle koştu (1086 raw finding); 8 örnek cross-check |
| **Bekleyen kritik** | Migration timestamp clash (1788300000000 — DATA CORRUPTION RISK) → platform team escalation şart |
| **Yeni iş** | F-007 (adapter promotion blockers, MEDIUM) açılması gerekiyor |
| **Operator-only** | F-005 Tier S sign-off, F-006 PR merge, Phase B production escalation onayı |
| **Toplam tahmini effort** | ~3-5 engineer-day (Phase A: 0.5, B: 1-2, C: 0.5, D: 0.5, F: 0.5-1) |
| **Branch policy hatırlatma** | `claude/*` prefix push edilebilir; `snowball` direkt push ağ katmanında 403 — PR akışı zorunlu |
| **Critical path** | A → (F) → C → re-run cycle → adapter promotion eligible. B paralel, D operator-only, E flexible. |
| **Token budget tahmini** | A: 5k, B: 15k (data-expert review), C: 8k (F-007 yazımı), D: operator manual, E: 3k, F: 12k (independent review). Toplam: ~45k Claude API tokens |

---

## 1. Context

Bu seansta üç katman iş yapıldı:

1. **ARIA self-audit** (susturma / banned-phrase / debt-tracking / open findings / test sağlığı). Sonuç: 2 anchor (`pressure.py:486` broad except + `cycle.py:54-56` untracked placeholder) → F-006 (MEDIUM) açıldı, 3 commit'le kapatıldı + invariant test eklendi (`test_architectural_debt_marker_invariant.py`).

2. **Snowball ARIA kernel cycle koşturuldu** (sandbox state: `/tmp/aria-sandbox/{ws,tools}`). 5 faz (discovery + tools + memory + pressure + reflection) + 16 learning hook + 13 SHADOW adapter çalıştı. **1086 raw finding** üretildi, hiçbiri operator-facing emit edilmedi (SHADOW status semantics).

3. **Raw finding'ler kod tabanıyla cross-check edildi** (8 örnek). True positive oranı yüksek (4/8); 1 noisy, 1 defensive nit, 1 partial FP, 1 adapter-bug. Cross-check **iki yeni iş türü** ortaya çıkardı:
   - **Production-impact bug** (ARIA scope dışı — platform team)
   - **Adapter promotion blockers** (F-007 olarak izlenecek)

Stop-hook tetiklendi → auto-commit `2c4aea24` egg-info'yu gitignore'a aldı; repo şu an clean. Bu auto-commit bir hook mekanizması, davranış kayıtlı değil — Phase E'de codify edilmeli.

---

## 2. Stakeholders + RACI

| Rol | Kişi/Agent | Sorumluluk |
|---|---|---|
| **Operator (Accountable)** | Okan-Wqm | F-006 PR merge, F-005 Tier S sign-off, Phase B platform escalation onayı, F-007 OPEN→IN_PROGRESS taşıma |
| **Implementer (Responsible)** | Claude (this session veya sonraki) | Phase A PR creation, Phase C F-007 dosyası, Phase F independent review dispatch |
| **Reviewer (Consulted)** | independent agent (Phase F) | F-006 fix commit'lerinin self-judged olmaması için ikinci göz |
| **Platform team (Responsible — Phase B)** | data-expert / database-reviewer agent | Migration timestamp clash + 75 unregistered migration triage |
| **Compliance owner (Consulted)** | compliance-expert | GDPR Art 30 audit-log impact (governance.jsonl + raw-findings.jsonl), retention policy |
| **Observability owner (Consulted)** | observability-expert | F-006 telemetry + F-007 telemetry ekleme |
| **Security owner (Consulted)** | security-reviewer | Phase F'in security review tarafı (broad except daraltma → security guarantee impact) |
| **Informed** | tüm ARIA çevresi | Daily report, governance events, _index.json güncellemeleri |

---

## 3. Self-Critique (kayıt için, tekrar etmemek için)

| # | Hata | Düzeltme | Going-forward kural (Phase E'de codify) |
|---|---|---|---|
| 1 | `runtime_profile.py:369` broad-except'i undocumented swallow olarak flag'ledim — docstring 9 satır üstte aynı swallow'u açıklıyordu | Geri çektim; F-006 scope'u 3'ten 2 anchor'a düştü | Bir broad-except ya da susturma flag'lerken ilgili fonksiyon/metodun TAMAMINI oku; sed-window ±5 yetmez |
| 2 | İlk 123 test error'unu tek cümleyle "ortam farkı" diye geçiştirdim | Operator "susturma var mı?" diye sordu, root cause'a indim (sandbox git-signing hook) | Test fail olunca "ortam" demeden önce somut sebebi izole et; **belirsizlik = root cause araştırması, asla dismiss değil** |
| 3 | İlk `aria-kernel integrity verify` çağrımı `--tools-dir` set etmediğim için repo'daki `aria-tools/governance.jsonl` + `integrity_index.json`'a yazdı | Revert ettim; sonraki tüm çağrılar explicit `--tools-dir /tmp/aria-sandbox/tools` + `--workspace-base /tmp/aria-sandbox/ws` aldı | ARIA komutları default'ta repo'ya state yazar; sandbox kullanırken her zaman parametreleri ver |
| 4 | Operator "snowball'a yaz" dedi → harness proxy 403 ile reject etti; cherry-pick claude/snowball-branch-visibility-TqEH1'e mismatch verdi | `claude/aria-self-audit-F-006` branch'i (claude/* prefix izinli) açıp PR akışına geçtim | Branch policy intent ≠ harness ağ katmanı yetkisi; çatışma görünce direkt MCP push'a değil, claude/* + PR akışına yönel |
| 5 | F-006 closure'ı kendi yaptığım fix'leri kendi verify ettim — independent review yok | Phase F bu açığı kapatıyor (önerilen, opsiyonel) | Self-implemented + self-verified findings için ikinci göz şart; ARIA spec 3-Explore-agent reproducer öneriyor |
| 6 | F-006.closes_in_commit null bıraktım (F-004 precedent'i ile haklı çıkardım ama traceability düşük) | Phase A PR description'da commit SHA'lar listelenir; yine de daha sonra null→6ed058a2 patch atılabilir | Convention'ı yeniden değerlendir: closes_in_commit null mı, set mi? Operator karar versin (Open Question 3) |
| 7 | İlk plan (v1) "concise but detailed" criterion'unu zorlamadım — risk register, acceptance criteria, ADR alignment, compliance mapping, ops handoff hep eksikti | v2 (bu dosya) genişletilmiş hali | Enterprise plan checklist'i göz önünde tut; v0 → v1 → v2 iteration'ı kabul et, bir defada perfect değil |

---

## 4. Workflow / Dependency Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│ Plan v2 onayı (operator)                                             │
└──────────────────────────────────────────────────────────────────────┘
                            │
              ┌─────────────┼──────────────┬─────────────────┐
              ↓             ↓              ↓                 ↓
        ┌──────────┐  ┌──────────┐  ┌────────────┐    ┌──────────┐
        │ Phase A  │  │ Phase B  │  │  Phase D   │    │ Phase E  │
        │ F-006 PR │  │ Prod B   │  │ F-005 TierS│    │ Discipl. │
        │ creation │  │ escalate │  │ operator   │    │ codify   │
        └────┬─────┘  └────┬─────┘  └─────┬──────┘    └─────┬────┘
             │             │              │                 │
             ↓             ↓              ↓                 │
        ┌──────────┐  ┌──────────┐  ┌────────────┐         │
        │ Phase F  │  │ data-    │  │ F-005      │         │
        │ Independ │  │ expert   │  │ RESOLVED   │         │
        │ review   │  │ triage + │  │ in _index  │         │
        │ (option) │  │ fix      │  │            │         │
        └────┬─────┘  └────┬─────┘  └────────────┘         │
             │             │                                │
             └──→ Phase A PR merge ←─────────────────────────┤
                            │                                │
                            ↓                                │
                       ┌──────────┐                          │
                       │ Phase C  │ ← (Phase A merged için   │
                       │ F-007    │   sandbox baseline reset │
                       │ create   │   gerekebilir)           │
                       └────┬─────┘                          │
                            │                                │
                            ↓                                │
                ┌─────────────────────────┐                  │
                │ ARIA cycle re-run       │ ←────────────────┘
                │ (G1-G4 verification)    │
                └─────────────────────────┘
                            │
                            ↓
                ┌─────────────────────────┐
                │ Adapter SHADOW→ACTIVE   │
                │ promotion (F-007 closure│
                │ + F-003 partial)        │
                └─────────────────────────┘

Critical path: Plan onay → A → F → A merge → C → cycle re-run → promotion
B is parallel, D is operator-only async, E is async low-priority
```

**Critical-path sequencing rationale:**
- A (PR oluşturma) F (review) ile koşar — review F-006 commit'leri üzerine yapılır, PR review surface'ı paralel olarak feedback toplar
- B (production escalation) tamamen paralel — ARIA scope dışı, blocker değil ama risk yüksek
- D (Tier S) operator manuel — async, ARIA cycle ile bağımsız
- E (codification) async, takım disiplini için ama immediate blocker değil
- C (F-007) A merge sonrası tercih edilir (snowball baseline reset için), ama theoretically A merge öncesi de yapılabilir

---

## 5. Plan — 6 Faz (each phase: pre-flight + acceptance + rollback + impact + tests)

### Phase A — F-006 PR aç ve merge

**Owner:** Operator (Accountable), Claude (Responsible — PR creation)
**Effort:** 0.5 day
**Token budget:** ~5k
**Dependencies:** none
**Blocks:** Phase E (verification baseline reset), G1-G4 (cycle re-run)
**Critical path:** YES

**Pre-flight gates (BEFORE phase starts):**
- [ ] `git status -sb` clean
- [ ] `git log --oneline -5` confirms 4 commits on claude/aria-self-audit-F-006
- [ ] `git push origin claude/aria-self-audit-F-006` already done (no pending push)
- [ ] Operator has GitHub MCP write permission to Okan-wqm/aquaculture_platform
- [ ] CI pipeline for snowball is green at HEAD 754acb46 (baseline confirmed)

**Steps:**
1. MCP `mcp__github__create_pull_request`:
   - owner: `Okan-wqm`
   - repo: `aquaculture_platform`
   - base: `snowball`
   - head: `claude/aria-self-audit-F-006`
   - title: `aria-self-audit-2026-05-10: F-006 closure (3 anchors + Tier V 1079/1079 verification)`
   - body: Section 17 (Communication Plan) PR template
2. Operator reviews PR
3. CI runs (gha pipeline + snowball-specific invariants)
4. (Optional) Phase F dispatch in parallel — review feedback inform PR
5. Operator approves + merges
6. Local fetch + reset (`git fetch origin && git checkout snowball && git reset --hard origin/snowball`)

**Acceptance criteria (measurable):**
- [ ] **A1**: PR URL operator'a verilmiş, link erişilebilir
- [ ] **A2**: PR CI yeşil (gha pipeline tüm checks)
- [ ] **A3**: PR merge sonrası `git fetch origin snowball && git log snowball -5 --oneline` 4 commit'i içeriyor
- [ ] **A4**: snowball'da `aria-findings/F-006.json` `"status": "RESOLVED"`
- [ ] **A5**: `aria-debts/DEBT-2026-05-10-001.json` `"status": "OPEN"` + due_date 2026-06-24
- [ ] **A6**: `_index.json` her ikisinde de tutarlı (F-006 RESOLVED row + DEBT-2026-05-10-001 row)
- [ ] **A7**: cycle.py:50-61'de `aria-debt:DEBT-2026-05-10-001` marker present
- [ ] **A8**: pressure.py:481-493 narrowed to ImportError (no broad except Exception)

**Rollback strategy:**
- **Pre-merge**: revize edilmesi istenirse, commit'lere yeni patch commits eklenir; force push gerekirse `git push --force-with-lease` (CLAUDE.md "force push FORBIDDEN" — bu kural review feedback için exception ister; operator karar)
- **Post-merge bug**: revert per commit (atomik, bağımsız):
  - `git revert 6ed058a2` → Tier V verification reverter, F-006 OPEN'e geri döner
  - `git revert cd08f99e` → cycle.py debt marker geri çekilir, DEBT-2026-05-10-001 ledger silinir
  - `git revert 8170a7c1` → pressure.py broad except geri gelir
  - Her revert için Closes line yeniden referans
- **Reversibility matrix per file**:
  | File | Reverse risk | Backup |
  |---|---|---|
  | `aria-kernel/aria_kernel/pressure.py` | Düşük (logic değişikliği fonksiyon-local) | git history |
  | `aria-kernel/aria_kernel/cycle.py` | Sıfır (sadece comment + marker eklendi) | git history |
  | `aria-findings/F-006.json` | Düşük (yeni dosya) | rm aria-findings/F-006.json |
  | `aria-findings/_index.json` | Düşük (1 row eklendi) | git history |
  | `aria-debts/DEBT-2026-05-10-001.json` | Düşük (yeni dosya) | rm |
  | `aria-debts/_index.json` | Düşük (1 row eklendi) | git history |
  | `aria-kernel/tests/*.py` (2 yeni dosya) | Düşük | rm |
  | `aria-kernel/.gitignore` (auto-commit) | Sıfır | git history |

**CLAUDE.md compliance audit (per-rule):**
- [x] `nx affected --target=test` (Python kısmı 1079/1079 green); TS/JS kısmı PR CI'ye bırakılır
- [x] `nx affected --target=lint` PR CI'de
- [x] Architectural root-cause fix (broad → narrow except — tier 3 detectable; aria-debt marker — tier 2 automatic)
- [x] Schema declaration: değişiklik yok (entity ekleme yok)
- [x] NATS identity: değişiklik yok
- [x] No `as any`, `// @ts-ignore`, `as unknown as X`
- [x] No `getRepository()` (sadece existing pressure.py edit)
- [x] No floating promises (Python, async pattern N/A)
- [x] No `console.*` (Python, N/A)
- [x] Banned-phrase free: commit message'larda "for now" / "interim" / "deferred" yok (verify edildi)
- [x] Closes: line her commit'te mevcut
- [x] Co-Authored-By yok ✓
- [x] Force push yok ✓ (rollback için exception olabilir)
- [x] Hook bypass yok ✓ (signing isolation env-var ile, `--no-verify` değil)

**Test matrix:**
- Unit: `tests/test_pressure_phase2_import_fallback.py` (3 case) — green
- Unit: `tests/test_architectural_debt_marker_invariant.py` (4 case) — green
- Regression: `tests/test_pressure_lifecycle.py` — 7/7 green (no drift)
- Full suite: `unittest discover` — 1079/1079 green
- TypeScript: PR CI Nx affected (`apps/`, `libs/`)
- E2E: skipped — no behavioral change to user-facing flow

**Telemetry / governance:**
- PR merge sonrası ARIA cycle yeni delta yakalar (`cycle_diff.changed_paths` 4 dosya gösterir)
- Pressure event olası: F-006 closure pressure-decay'i tetikleyebilir
- Governance event: `report_ingestion_scan` F-006'yı RESOLVED olarak pickup eder
- Yeni invariant test (`test_architectural_debt_marker_invariant.py`) gelecek aria-debt: marker eklemelerini gate'ler

**Change Impact Analysis:**
| Layer | Etki | Owner |
|---|---|---|
| Kernel kod | pressure.py 1 fonksiyon, cycle.py comment | aria-kernel maintainer |
| Tests | 2 yeni dosya, 7 yeni case | test-runner |
| Docs (state) | F-006 RESOLVED, F-006 schema, DEBT-2026-05-10-001, marker invariant | ARIA self |
| Docs (process) | None directly; Phase E will add behavioral rules | Operator |
| Build artifacts | egg-info gitignore | dev workflow |
| Production | Zero direct impact (kernel-internal change) | None |

---

### Phase B — Production-impact escalation (NON-ARIA, platform team)

**Owner:** Operator (Accountable), data-expert agent (Responsible)
**Effort:** 1-2 days (triage + fix + migration)
**Token budget:** ~15k (data-expert review + multi-file analysis)
**Dependencies:** none (parallel to Phase A)
**Blocks:** none (ARIA bağımsız çalışır; ama platform sağlığı için kritik)
**Critical path:** NO (parallel to A)
**Severity:** **CRITICAL** (data corruption risk)

**Pre-flight gates:**
- [ ] Phase B onayı operator tarafından verilmiş (kanal seçimi: OQ1)
- [ ] data-expert agent dispatch yetkisi operator'da
- [ ] Production deployment kayıtları erişilebilir (en az son 30 gün migration log)
- [ ] e2e test ortamı (DATABASE_MIGRATIONS_RUN=true) ayağa kalkabilir durumda

**Bulgu detayları (ARIA cycle yan-bulgu):**

| Severity | Konu | Konum | Kanıt | Risk |
|---|---|---|---|---|
| **CRITICAL** | Migration timestamp clash | `apps/farm-service/src/database/migrations/1788300000000-AddFarmAuditLogsImmutability.ts` ile `app.module.ts:237`'deki `AddBiomassReports1788300000000` | Aynı timestamp, iki farklı migration class | TypeORM migration order non-deterministic; aynı timestamp iki migration aynı pre-state'ten başlar; rollback tablosu bozulabilir |
| **HIGH** | Unregistered migrations | `apps/farm-service/src/database/migrations/*.ts` (75 dosya) | `app.module.ts:205-237` registry'de yok | Production cold-start'ta migration'lar çalışmaz; SchemaDriftValidator boot'ta fail (ADR-012) |
| **MEDIUM** | Aynı schema-drift bulgusunu iki adapter raporluyor | schema-drift-adapter + typeorm-entity-schema-adapter (her biri 75 finding) | F-003 (Plan 019 yarım) territory | Adapter konsolidasyonu gerekli |

**Steps:**
1. Operator kanal seçer (OQ1 — bkz. Section 8):
   - **(a)** Phase A PR'ında ek bir comment olarak raise et (review trail içinde kalır)
   - **(b)** Ayrı bir non-ARIA finding aç → `docs/reviews/data-expert/2026-05-10-migration-registry-drift.md`
   - **(c)** Direct dispatch: `data-expert` agent'ı çağırıp triage iste (operator manual)
   - **Önerilen:** (b) + (c) paralel — kayıt + paralel triage
2. data-expert tek tek 75 migration'ı incele:
   - production deployment log'unda hangileri çalıştırıldı? (`db-migrate` output check)
   - hangileri draft / abandoned?
   - hangileri test-only?
3. Timestamp clash için: ya bir migration timestamp'ı yeniden adlandırılır (semver bump), ya da ikisi konsolide edilir (data-expert kararı)
4. Migration registry düzeltildikten sonra `e2e/tests/integration/schema-invariants.spec.ts` re-run
5. Production deploy dry-run (DATABASE_MIGRATIONS_RUN=true ile e2e env)

**Acceptance criteria:**
- [ ] **B1**: data-expert triage raporu dosya olarak mevcut
- [ ] **B2**: Timestamp clash giderilmiş (`grep -c "1788300000000" app.module.ts` → 1, en fazla)
- [ ] **B3**: 75 migration ya registry'de ya da explicit "deprecated" işaretli
- [ ] **B4**: `schema-invariants.spec.ts` green
- [ ] **B5**: Production deploy dry-run yeşil (e2e env)
- [ ] **B6**: db-migrate CLI dry-run output mevcut
- [ ] **B7**: ADR-012 (Schema Drift Prevention) compliant — SchemaDriftValidator boot doğrulaması

**Rollback:**
- Registry değişiklikleri ek/değişiklik içerir; her migration class ekleme/çıkarma test'ten geçtikten sonra commit
- Timestamp rename: blue-green safe (eski class ismi kalır, sadece order'ı değişir; backfill gerekmez eğer migration zaten production'da çalıştıysa)
- ÖZEL DURUM: timestamp clash'in bir tarafı production'da çalıştıysa, o migration TypeORM `migrations` table'da kayıtlı olabilir; rename yaparsak TypeORM "yeni migration" sanır ve tekrar çalıştırır → duplicate constraint error veya data corruption. Bu durumda: rename yerine no-op stub migration ekle, gerçek logic'i yeni timestamp'lı migration'a taşı.

**CLAUDE.md compliance:**
- ⚠️ Schema migration discipline (ADR-011, ADR-012) — data-expert review zorunlu
- ⚠️ Blue-green safe migration kuralı: eklenecek herhangi bir migration nullable + backfill + NOT NULL pattern'ine uymalı
- ⚠️ `db-migrate` CLI'nin migration runner contract'ı bozulmamalı
- ⚠️ Production'da DATABASE_MIGRATIONS_RUN=false kuralı
- ⚠️ Hand-edit migration files yasak — yeni migration generate edilir

**Test matrix:**
- Unit: data-expert tarafından migration class'ları içindeki SQL doğrulanır
- Integration: `e2e/tests/integration/schema-invariants.spec.ts`
- E2E: full deploy dry-run with DATABASE_MIGRATIONS_RUN=true
- Production canary: opsiyonel (release engineer kararı)

**Telemetry:**
- Çözüldüğünde `pressure_closed_via_trailer` veya `pressure_satisfied_by_skill` governance event
- ARIA cycle re-run'da schema-drift-adapter raw_findings_count düşmeli (75 → ?)
- SchemaDriftValidator boot metrics: drift_count = 0

**Change Impact Analysis:**
| Layer | Etki | Owner |
|---|---|---|
| Database schema | farm schema, potansiyel olarak yeni migration class | data-expert |
| Migration runner | migrations[] array değişir | data-expert |
| Tests (e2e) | schema-invariants spec coverage | test-runner |
| Production deployment | Cold-start migration order değişir | release engineer |
| Multi-tenant | Per-tenant schema-per-tenant pattern korunur (farm schema-per-tenant) | multi-tenant-saas-expert |

---

### Phase C — F-007 finding: Adapter promotion blockers

**Owner:** Claude (Responsible), Operator (Accountable)
**Effort:** 0.5 day
**Token budget:** ~8k
**Dependencies:** Phase A merged (sandbox baseline reset için tercih)
**Blocks:** ARIA adapter SHADOW→ACTIVE promotion (F-003 closure'unun bir kısmı)
**Critical path:** ON

**Pre-flight gates:**
- [ ] Phase A merged (snowball'da F-006 RESOLVED)
- [ ] /tmp/aria-sandbox/tools/raw-findings.jsonl preserved veya repo'ya commit edilmiş (R8 mitigation, OQ6)
- [ ] aria-findings/_index.json son state operator tarafından görülmüş

**Steps:**
1. `aria-findings/F-007.json` oluştur — F-001 schema'sı baz
2. `aria-findings/_index.json` row ekle
3. (Opsiyonel) `aria-debts/DEBT-2026-05-10-002.json` test-gap heuristic için tracked debt
4. (Opsiyonel) `docs/aria/cycle-snapshots/cyc-20260510T0156Z/` altında raw-findings preservation
5. Commit + push to `claude/aria-self-audit-F-006` (PR'a ek commit) veya yeni branch `claude/aria-finding-F-007` (OQ5)
6. PR review + merge

**F-007 schema (concrete, full content per CONTRACTS § 6 finding schema):**
```json
{
  "$schema": "aria/finding/v1",
  "certainty": "OBSERVED",
  "claim_summary": "Operator-conducted ARIA cross-check (2026-05-10) of 1086 raw findings produced by 13 SHADOW adapters in cycle cyc-20260510T0156Z surfaced four classes of adapter calibration blockers preventing SHADOW→ACTIVE promotion: (1) cqrs-adapter + outbox-adapter + agent-harness-security-adapter all emit findings with status=invalid_evidence (evidence_validator chain still has SELF_OUTPUT or canonical-resolve gap; F-005 anchor #13 partially closed by commit c16ffc18 but not fully); (2) schema-drift-adapter and typeorm-entity-schema-adapter produce IDENTICAL 75-row findings, indicating shared parser or duplicate-pipeline architecture (F-003 sub-anchor); (3) test-gap-adapter heuristic only checks adjacent-or-importing test signal, missing behavior-equivalent integration tests in e2e/tests/integration/*; (4) security-boundary-adapter rejects @Public()+@ThrottlePasswordReset() decorator combination as insufficient explicit-allowlist marker, generating noise on legitimate public endpoints.",
  "claim_type": "adapter_promotion_blocker",
  "closes_in_commit": null,
  "created_at": "2026-05-10T02:00:00Z",
  "evidence_chain_id": "chain_F007_aria_cross_check",
  "evidences": [
    {"ref": "/tmp/aria-sandbox/tools/raw-findings.jsonl", "summary": "1086 raw finding ledger; cqrs+outbox+agent-harness rows have status:invalid_evidence; preserved at docs/aria/cycle-snapshots/cyc-20260510T0156Z/ if OQ6=yes"},
    {"ref": "aria-kernel/aria_kernel/evidence_validator.py", "summary": "validate_evidence_path / _check_agent_ref code path; F-005 anchor #13 partial closure"},
    {"ref": "aria-kernel/aria_kernel/tool_runner.py", "summary": "raw vs emitted findings split; SHADOW status semantics"},
    {"ref": "tools/aria-adapters/schema-drift-adapter.tool.json", "summary": "adapter manifest"},
    {"ref": "tools/aria-adapters/typeorm-entity-schema-adapter.tool.json", "summary": "second adapter producing identical 75-row migration_registry_missing_entry findings"},
    {"ref": "tools/aria-adapters/test-gap-adapter.ts", "summary": "adjacent/importing heuristic; e2e/integration test miss"},
    {"ref": "tools/aria-adapters/security-boundary-adapter.ts", "summary": "@Public() not accepted as allowlist"},
    {"ref": "apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts:108", "summary": "Cross-check ground-truth: cqrs-adapter correctly identifies @InjectRepository (real CQRS bypass) but its evidence layer rejects own finding"},
    {"ref": "e2e/tests/integration/audit-immutability.spec.ts", "summary": "Behavior test that test-gap-adapter heuristic missed"}
  ],
  "facts": [
    "8 cross-check sample: 4 TP, 1 noisy, 1 defensive nit, 1 partial FP, 1 adapter bug.",
    "schema-drift-adapter found real production bug: timestamp 1788300000000 clash between AddFarmAuditLogsImmutability and AddBiomassReports — escalated to Phase B as production-impact CRITICAL.",
    "cqrs-adapter sample at apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts:108 confirmed real CQRS bypass (@InjectRepository) but adapter rejected own evidence as invalid.",
    "tenant-scoping-adapter at invoice-management.service.ts:410 flagged raw query without tenantId predicate; preceded by tenant-scoped findOne — defensive nit, not live bug.",
    "test-gap-adapter at AuditLogImmutability migration: behavior test exists at e2e/tests/integration/audit-immutability.spec.ts but not adjacent or import-linked.",
    "security-boundary-adapter at password-reset.controller.ts: @Public() + @ThrottlePasswordReset() rejected as insufficient allowlist."
  ],
  "finding_id": "F-007",
  "interpretations": [
    {"text": "Anchors 1+2 block adapter promotion to ACTIVE. Anchors 3+4 are calibration concerns; can be deferred to next Plan iteration without blocking SHADOW→ACTIVE.", "verification_required": false},
    {"text": "Anchor 1 is a continuation of F-005 anchor #13; partial closure (commit c16ffc18) did not cover all evidence_validator paths.", "verification_required": true},
    {"text": "Anchor 2 may be intentional architectural redundancy (defense-in-depth) rather than duplicate work; data-expert review needed.", "verification_required": true}
  ],
  "originating_pressure_event_id": null,
  "originating_run_id": "cyc-20260510T0156Z",
  "originating_skill": "manual:operator-aria-cross-check-2026-05-10",
  "recommendation": "Anchors 1+2 must close before any adapter promotion. Recommended sequence: (a) extend F-005 anchor #13 fix to cover remaining evidence_validator paths; verify with a re-run that cqrs/outbox/agent-harness emit valid evidence. (b) Consolidate schema-drift + typeorm-entity-schema (one adapter as primary, the other deprecated; route via shared parser module). (c) For anchor 3, extend test-gap heuristic to scan e2e/integration test contents for migration class names + SQL DDL signatures. (d) For anchor 4, relax security-boundary rule to accept @Public() + rate-limit decorator combination, OR add explicit `// public-write-allowlist:` comment convention to repo (operator decision).",
  "related_specialized_agent_domains": ["data-expert", "auth-security-expert", "test-runner"],
  "schema_version": 1,
  "scope": {
    "files": [
      "aria-kernel/aria_kernel/evidence_validator.py",
      "tools/aria-adapters/schema-drift-adapter.tool.json",
      "tools/aria-adapters/typeorm-entity-schema-adapter.tool.json",
      "tools/aria-adapters/test-gap-adapter.ts",
      "tools/aria-adapters/security-boundary-adapter.ts"
    ]
  },
  "severity": "MEDIUM",
  "status": "OPEN"
}
```

**Acceptance criteria:**
- [ ] **C1**: `aria-findings/F-007.json` exists; `_index.json`'da F-007 row var
- [ ] **C2**: F-007.json schema-conformant (test_findings_schema_v1 invariant green eğer varsa)
- [ ] **C3**: Commit Closes: aria-findings/F-007.json#F-007 referans verir (kendi açılış commit'i için meta-self-reference)
- [ ] **C4**: aria-kernel test suite F-007 dahil 1080+/1080+ green
- [ ] **C5**: (opsiyonel) raw-findings.jsonl preserved at docs/aria/cycle-snapshots/...
- [ ] **C6**: PR (eğer ayrı branch — OQ5) merged

**Rollback:** Tek commit, atomik, revert mümkün (`git revert <SHA>`); F-007 dosyası silinir, _index.json row geri alınır

**CLAUDE.md compliance:**
- ✅ Root-cause architectural framing (4 anchor each tied to specific file/code)
- ✅ Banned-phrase free recommendation
- ✅ Owner specified per anchor (data-expert, auth-security-expert, test-runner agent domains)
- ✅ ADR alignment: F-005 (anchor #13 continuation), F-003 (sub-anchor)

**Test matrix:**
- Unit: F-007 JSON schema validation (eğer varsa) green
- Invariant: `test_architectural_debt_marker_invariant.py` (Phase A'dan) F-007'yi de tarar (extension önerisi: aria-finding F-XXX referansları reachable mi)
- Integration: ARIA cycle re-run'da F-007 OPEN olarak `report_ingestion_scan` tarafından pickup edilir

**Telemetry:**
- Yeni finding emission ARIA cycle'da `report_ingestion_scan` hook'u tarafından pickup edilir
- F-007 OPEN durumda iken adapter promotion otomatik blocked
- Daily report'ta F-007 görünür

**Change Impact Analysis:**
| Layer | Etki | Owner |
|---|---|---|
| ARIA findings | F-007 yeni (state) | ARIA self |
| Daily report | F-007 OPEN satırı | observability |
| Adapter promotion gate | Blocker active | aria-kernel |
| Production | None direct | None |

---

### Phase D — F-005 Tier S sign-off (operator-only)

**Owner:** Operator (Accountable + Responsible)
**Effort:** 0.5 day (operator manual review)
**Token budget:** operator-only (no Claude tokens)
**Dependencies:** F-005 Tier V partial satisfaction (this session) sufficient prerequisite
**Blocks:** F-005 RESOLVED status, Plan 024 v3 closure
**Critical path:** NO (async)

**Pre-flight gates:**
- [ ] Operator has access to all 8 Plan 024 v3 anchor closure commits (B-1..B-8 + H-0..H-7) on snowball
- [ ] Tier V mechanical pass (1079/1079) acknowledged
- [ ] (Opsiyonel) 3 Explore-agent reproducer dispatch için token budget ayrılmış

**Tier S concrete checklist (operator):**
- [ ] Plan 024 v3'ün 20/21 evidence anchor'ı için her bir kapanış commit'inin diff'ini gözden geçir (8 commit: B-1..B-8 + H-0..H-7)
- [ ] Plan 023 v3 ile uyum (regressions check) — `git log snowball ^plan-023-v3-tag --oneline` (eğer tag varsa)
- [ ] (Opsiyonel ama spec'te var) 3 Explore-agent reproducer dispatch — F-005 claim_summary'deki 15 mimari boşluğun her birini bağımsız olarak doğrula
- [ ] Tier V mekanik ayağı: this session 1079/1079 green (1072 baseline + 7 new); operator verifies count + new test coverage map matches commit messages
- [ ] F-005.status: OPEN → RESOLVED
- [ ] F-005.closes_in_commit: 754acb46 (B-8 son commit) veya null (F-004 precedent — OQ3 ile uyum)
- [ ] _index.json güncelle (generated_at advance + F-005 row update)
- [ ] Daily report'ta F-005 RESOLVED satırı görünür
- [ ] (Opsiyonel) Governance event: `operator_sign_off_F005` actor=operator, ts=now

**Acceptance criteria:**
- [ ] **D1**: F-005 status RESOLVED
- [ ] **D2**: _index.json güncellenmiş + generated_at advance edilmiş
- [ ] **D3**: Operator sign-off note (governance event veya commit message)
- [ ] **D4**: Daily report'ta F-005 closure surface

**Rollback:** F-005 yeniden OPEN'e çekilebilir; bypass route bulunursa supersedes mekanizmasıyla F-008 olarak yeniden açılır (CONTRACTS lifecycle: OPEN → RESOLVED → optionally re-OPEN via supersedes)

**CLAUDE.md compliance:** Operator-only action; CLAUDE.md kuralları uygulanır (Closes line, no force push vs.)

**Test matrix:** Operator manual review; no automated test

**Telemetry:**
- Governance event `operator_sign_off_F005`
- Daily report F-005 RESOLVED line
- Pressure decay path may trigger if F-005 originated pressures

---

### Phase E — Going-forward discipline (codified)

**Owner:** Operator (Accountable), Claude (Responsible — codification)
**Effort:** 0.5 day (CLAUDE.md veya IDENTITY.md edit)
**Token budget:** ~3k
**Dependencies:** none
**Blocks:** none (low-priority but high-value)
**Critical path:** NO

**Pre-flight gates:**
- [ ] Self-Critique tablosu (Section 3) operator tarafından review edilmiş
- [ ] CLAUDE.md edit yetkisi operator'da (or ADR yolu seçilirse compliance flow başlat)
- [ ] OQ4 (CLAUDE.md edit ADR gerektirir mi) yanıtlanmış

**Steps:**
1. Self-Critique tablosundaki 7 kuralı CLAUDE.md altındaki "Behavioral Rules" section'a ekle veya `docs/aria/IDENTITY.md §3.6` altına şu kuralları ekle:
   - Read full function before flagging swallow (sed-window banned)
   - No "environment" dismissal without root-cause isolation
   - Sandbox parameters always explicit for ARIA commands
   - Branch policy collision → claude/* + PR
   - Self-implemented + self-verified findings need independent review
   - closes_in_commit convention decision (Open Question 3)
   - Plan iteration acceptable: v0 → v1 → v2 (perfection in one shot is anti-pattern)
2. Stop-hook auto-commit davranışını codify et — egg-info gitignore commit'i gibi otomatik mekanizmalar `~/.claude/stop-hook-git-check.sh` davranışını dokümante etmeli
3. (Opsiyonel) `.claude/agents/`'a yeni bir agent ekle: `aria-self-audit-discipline-enforcer` — bu kuralları otomatik audit eder
4. (Opsiyonel) ADR oluştur eğer OQ4 = yes (örn. ADR-016 — Operator-Self-Audit Discipline)

**Acceptance criteria:**
- [ ] **E1**: 7 kural CLAUDE.md veya IDENTITY.md'de yazılı
- [ ] **E2**: Stop-hook davranışı dokümante (`docs/runbooks/stop-hook-behavior.md` veya benzer)
- [ ] **E3**: (opsiyonel) test (banned phrase scanner self-rule ihlallerini yakalıyor)
- [ ] **E4**: (opsiyonel ADR-016) PR'da operator approval

**Rollback:** Doc-only change, geri alınabilir

**CLAUDE.md compliance:** CLAUDE.md'nin kendisi modifiye olur — ADR çağrısı gerekebilir? (operator karar versin — Open Question 4)

**Test matrix:** None automated; review-based

**Telemetry:** Doc change; ARIA cycle değişiklik'i pickup eder ama açıklayıcı governance event yok (opsiyonel olarak `discipline_codification` kind eklenebilir)

---

### Phase F — Independent review of F-006 closure (önerilen, opsiyonel)

**Owner:** Operator (dispatcher), independent agent (Responsible)
**Effort:** 0.5-1 day
**Token budget:** ~12k (independent agent context + review)
**Dependencies:** Phase A PR opened (review surface mevcut)
**Blocks:** F-006 closure'un tam disiplin için son adımı (operator karar)
**Critical path:** ON (paralel A'ya, A'dan önce de tetiklenebilir)

**Pre-flight gates:**
- [ ] Phase A PR opened
- [ ] Operator Phase F yapacağına karar vermiş (OQ2 — yes/no)
- [ ] Independent agent türü seçilmiş (code-reviewer / 3 Explore reproducer / test-runner)

**Rationale:** F-006 ben açtım, ben fix'ledim, ben verify ettim. ARIA disiplini (`docs/aria/SPEC.md` §1 + Tier V 3-Explore-agent reproducer kuralı) bu pattern'i reddediyor. Operator self-judgment'a güvenebilir, ama enterprise-grade audit trail için ikinci göz şart.

**Steps:**
1. Operator dispatch: bir veya daha fazla agent
   - **Önerilen:** `code-reviewer` agent (genel architectural review)
   - **Veya:** 3 Explore-agent reproducer (ARIA spec'in tam disiplini)
   - **Veya:** `test-runner` agent (test coverage + invariant doğrulaması)
2. Agent prompt template:
   ```
   F-006'nın 3 anchor closure commit'ini (8170a7c1, cd08f99e, 6ed058a2) bağımsız review et.
   (a) pressure._phase2_effective_context broad except daraltma gerçekten doğru mu?
       - Circular import dışında ImportError trigger eden başka senaryo var mı?
       - patch.dict(sys.modules, {...: None}) ile mock'lanan ImportError gerçek runtime ile aynı semantik mi?
       - Trust functions'a giden data error path'inde existing test coverage yeterli mi?
   (b) cycle.pr_lifecycle aria-debt marker proper mi?
       - DEBT schema CONTRACTS §6.6 ile tam uyumlu mu (required fields, banned-phrase gate)?
       - aria-debts/_index.json sıralama / generated_at convention'a uyuyor mu?
       - DEBT-2026-05-10-001.permanent_fix_required gerçekten implement edilebilir bir spec mi?
   (c) test_architectural_debt_marker_invariant.py false-positive üretebilir mi?
       - Test fixture içinde "aria-debt:" substring geçen string var mı?
       - Test docstring veya regression test description'ı marker olarak yanlış parse edilebilir mi?
       - Glob pattern (.py + .ts + .tsx + .json + .yaml + .yml) yeterli mi?
   (d) Genel: F-006.json schema CONTRACTS'a tam uyumlu mu, evidences yeterli kanıt mı?
   ```
3. Review feedback'e göre opsiyonel ek commit (anchor düzeltmesi)

**Acceptance criteria:**
- [ ] **F1**: Independent review raporu mevcut (file veya PR comment)
- [ ] **F2**: Review feedback'e göre 0 veya N commit eklenmiş
- [ ] **F3**: F-006'nın closes_in_commit kararı (null vs SHA) operator tarafından konfirme

**Rollback:** Review-only, kod değişikliği gerekmez (opsiyonel ek commit'ler revert edilebilir)

**CLAUDE.md compliance:** Independent review CLAUDE.md "Architectural Approach" hierarchy'sinin Tier 4 (document) seviyesini Tier 3+ (detectable) seviyesine taşır

**Test matrix:** Review-based; opsiyonel ek commit varsa kendi test'leri

**Telemetry:** Review report dosya olarak ARIA cycle next-run'da `report_ingestion_scan` tarafından pickup

---

## 6. Risk Register

| ID | Risk | Olasılık | Etki | Mitigation | Owner |
|---|---|---|---|---|---|
| R1 | Phase A PR review'da pressure.py değişikliği reddedilir (örn. broad except'i bilinçli istiyoruz iddiası) | Düşük | Düşük | Phase F independent review öncesi PR aç; review feedback'e göre revert edilebilir | Operator |
| R2 | Phase B migration timestamp clash zaten production'da çalışmış olabilir → düzeltme blue-green safe değil | Orta | Yüksek | data-expert triage öncesi git log + production deployment kayıtları kontrol; eğer çalıştıysa "deprecated" mark + new timestamp + new migration pattern | data-expert |
| R3 | F-007 anchor 1 (evidence_validator) F-005 anchor #13 ile çakışıyor → double-tracking | Orta | Düşük | F-007 evidence chain'inde F-005 anchor #13 referansı var; supersedes vs continuation kararı operator | Operator |
| R4 | Phase C F-007 schema invariant test'i (mevcutsa) F-007 dosyasını reddedebilir (örn. claim_summary çok uzun) | Düşük | Düşük | F-007 yazarken `tests/test_finding_schema*.py` çalıştırılır | Claude |
| R5 | Phase D Tier S için 3 Explore-agent reproducer çalıştırmak token bütçesini patlatır | Yüksek | Düşük | Operator manuel review yeterli; reproducer opsiyonel | Operator |
| R6 | Phase E CLAUDE.md edit ADR gerektirir | Düşük | Orta | Open Question 4 — operator önce karar versin | Operator |
| R7 | Stop-hook auto-commit davranışı bu plan'ın commit hijack edebilir (örn. Phase C commit'imi başka bir auto-commit'le karıştırabilir) | Orta | Orta | Her commit öncesi `git status -sb` ile pollution kontrolü; auto-commit'ler ayrı SHA olarak görünür | Claude |
| R8 | Sandbox `/tmp/aria-sandbox/` cycle data'sı session sonunda kaybolur — F-007 evidence chain `cyc-20260510T0156Z` hash'leri reachable olmaz | Yüksek | Orta | F-007 yazarken evidence ledger hash'leri inline JSON snippet olarak kopyalanır; veya `/tmp/aria-sandbox/tools/raw-findings.jsonl` repo'ya commit edilir (`docs/aria/cycle-snapshots/cyc-20260510T0156Z/`) — OQ6 | Claude |
| R9 | claude/aria-self-audit-F-006 branch policy harness değişirse 403 dönmeye başlar | Düşük | Yüksek | Plan A daha implement edilmeden push akışı test edildi (3 commit zaten pushed); risk geriye dönük yok | — |
| R10 | data-expert agent dispatch için operator yetkisi yok (bu seansta agent dispatch denenmedi) | Orta | Düşük | Operator manuel data-expert review veya non-ARIA finding dosyası | Operator |
| R11 | Phase F independent review F-006 anchor 1'in yanlış olduğunu söyler (örn. broad except daraltma trust modülü loading edge case'inde regression yaratır) | Düşük | Yüksek | Acceptance test'i (`tests/test_pressure_phase2_import_fallback.py` — 3 case) edge'leri kapsıyor; ek edge case bulunursa case eklenir | Phase F reviewer |
| R12 | Phase B üzerine farm-service downtime gerektiren bir migration düzeltmesi gelirse production etkisi yüksek | Düşük | Yüksek | Blue-green deploy + migration runner contract korunur; release engineer sign-off | release engineer |
| R13 | F-007 OPEN durumda kalırsa adapter promotion sürekli bloke — F-007 closure deadline yok | Yüksek | Orta | F-007 için tracked debt eklenebilir veya resmi due date set edilir (önerilen: 2026-07-10, 60 gün) | Operator |
| R14 | npm install repo state'ini kirletti (package-lock.json değişti) — sonradan revert edildi ama her ARIA cycle bunu tekrar tetikler | Orta | Düşük | npm install --no-audit --no-fund + sonrasında package-lock revert; veya offline node_modules cache | Claude |
| R15 | Cross-check 8 sample yetersiz — başka 1078 finding içinde başka critical bug olabilir | Yüksek | Orta | F-007 sonrası operator full audit sprint'i planlayabilir; ARIA cycle re-run sürekli bunu tetikleyecek | Operator |
| R16 | Plan'ın v2 olması (genişletilmiş) implementation phase'inde "plan değişti, başa dön" reaction yaratabilir | Düşük | Düşük | Decision log + version'lama net; operator onayı her phase'in pre-flight gate'inde | Operator |

---

## 7. Out of Scope (explicit)

Bu plan **YAPMAYI REDDEDİYOR**:

- ❌ F-001 (LOW, OPEN — TypeORM migration boilerplate kozmetik) — kapatma platform team kararı, Phase B ile birlikte düşünülebilir
- ❌ F-003 (MEDIUM, OPEN — Plan 019 yarım, 8 SHADOW adapter) — multi-day work, ayrı plan gerektirir; bu plan'ın F-007'si F-003'ün bir alt-anchor'ını işaret ediyor sadece
- ❌ F-005 anchor #13 dışındaki herhangi bir Plan 024 anchor — closed kabul ediliyor, retroactive re-verify yok
- ❌ DEBT-2026-05-10-001'in permanent fix'i (proposal_id threading) — debt ledger ile track ediliyor, deadline 2026-06-24, ayrı iş
- ❌ ARIA adapter promotion (SHADOW → ACTIVE) — F-007 closure prerequisite, bu plan promotion'ı yapmıyor sadece blocker'ı listeliyor
- ❌ Diğer 1086-8 = 1078 raw finding'in bireysel cross-check'i — sample yeterli; full audit ayrı sprint
- ❌ Security-reviewer/tenant-isolation-auditor gibi specialized agent dispatch — operator'un kararı
- ❌ Production deploy actions (migration runner, blue-green switch vs.) — Phase B çıktısı sonrası release engineer
- ❌ ARIA kernel'in kendisinin major refactor'u (örn. evidence_validator yeniden yazımı) — F-005 anchor #13 partial closure ötesi iş
- ❌ Bu plan'ın v2'nin v3'e taşınması — perfection sonsuza kadar genişler; v2 implement edilebilir kabul edilir
- ❌ Multi-tenant ARIA workspace bootstrap (her tenant için ayrı `~/.aria/workspaces/<tenant_hash>/`) — gelecek iş
- ❌ Per-tenant cost attribution for ARIA cycle runs — gelecek iş (tenant-cost-attribution-expert ownership)
- ❌ ARIA snowball → main merge — operator-level decision after PoC gate; bu plan o kararı vermiyor
- ❌ Stop-hook script'inin kendi review'u — separate maintenance task
- ❌ Bu plan'ın Turkish ↔ English translation'ı — operator Turkish-only çalışıyor

---

## 8. Open Questions (operator karar versin)

| # | Soru | Default / Önerilen | Cevap için son tarih |
|---|---|---|---|
| OQ1 | Phase B için kanal seçimi: PR comment / non-ARIA finding dosyası / direct data-expert dispatch — hangisi? | (b) + (c) paralel — dosya + dispatch | Phase B başlamadan önce |
| OQ2 | Phase F independent review opsiyonel mi yoksa zorunlu mu? | Zorunlu (enterprise-grade için) | Phase A PR açılmadan önce |
| OQ3 | `closes_in_commit` convention'ı: null mı (F-004 precedent), SHA mi (audit-trail)? | SHA (Phase A için F-006'yı 6ed058a2 ile retroactive update — küçük commit) | Phase A PR review sırasında |
| OQ4 | Phase E CLAUDE.md edit ADR gerektiriyor mu? | Hayır (process-only, architecture değişmiyor) | Phase E başlamadan önce |
| OQ5 | F-007 PR'ı Phase A PR'ına ek mi (aynı branch, ek commit), yoksa ayrı `claude/aria-finding-F-007` branch mi? | Phase A'ya ek commit (audit'in tek paketi olarak gider) | Phase A merge öncesi |
| OQ6 | `/tmp/aria-sandbox/tools/raw-findings.jsonl` cycle snapshot'u repo'ya commit edilsin mi (R8 mitigation)? | Evet — `docs/aria/cycle-snapshots/cyc-20260510T0156Z/` altında | Phase C başlamadan önce |
| OQ7 | F-007 due date set edilsin mi (R13)? | Evet — 2026-07-10 (60 gün, MEDIUM range içinde) | F-007 yazılırken |
| OQ8 | Phase F için hangi independent agent kullanılacak (code-reviewer / 3-Explore reproducer / test-runner)? | code-reviewer (en geniş kapsam) | Phase F dispatch öncesi |
| OQ9 | Bu plan dosyası repo'ya commit edilsin mi (`docs/plans/2026-05-10-aria-self-audit-followups.md`)? | Evet (audit-trail için) | Plan onayı sonrası |
| OQ10 | Stop-hook auto-commit davranışı codify edilince geriye dönük "tüm auto-commit'ler approved" mu sayılacak? | Codify policy'de explicit operator approval gerekir; geriye dönük auto-approve değil | Phase E sırasında |

---

## 9. Decision Log (recorded choices)

| # | Karar | Rationale | Tarih |
|---|---|---|---|
| D1 | F-006 severity: MEDIUM | Audit-path masking risk, no live regression confirmed | 2026-05-10 |
| D2 | DEBT-2026-05-10-001 deadline: 2026-06-24 (45 gün) | MEDIUM ≤90d range; gerçekçi engineer-sprint | 2026-05-10 |
| D3 | Branch: claude/aria-self-audit-F-006 (not direct snowball push) | Harness 403 on snowball; claude/* prefix izinli | 2026-05-10 |
| D4 | F-006.closes_in_commit: null | F-004 precedent; ama OQ3 ile yeniden değerlendirilebilir | 2026-05-10 |
| D5 | runtime_profile.py:369 fix scope DIŞINDA bırakıldı | Docstring zaten swallow'u belgeliyor | 2026-05-10 |
| D6 | auto_merge.py:881 _safe_call DIŞINDA bırakıldı | readable=False architectural pattern fail-closed | 2026-05-10 |
| D7 | Sandbox: /tmp/aria-sandbox/{ws,tools} | Repo state korunsun | 2026-05-10 |
| D8 | npm install --ignore-scripts | CLAUDE.md supply-chain discipline | 2026-05-10 |
| D9 | Test signing isolation via GIT_CONFIG_GLOBAL env, not --no-verify | CLAUDE.md hook bypass forbidden | 2026-05-10 |
| D10 | Plan v0 (initial proposal) → v1 (concise) → v2 (extended) iteration | Operator "enterprise-grade" feedback'i v2'ye götürdü; v0 → v2 acceptable iteration | 2026-05-10 |
| D11 | F-007 anchor 1 = continuation of F-005 anchor #13 (not new bug) | F-005 anchor #13 partial closure (commit c16ffc18) cqrs/outbox/agent-harness path'lerini kapsamadı | 2026-05-10 |
| D12 | Independent review (Phase F) önerilen ama opsiyonel | OQ2 ile zorunluluğa çevrilebilir; default opsiyonel | 2026-05-10 |
| D13 | Phase B production escalation ARIA scope DIŞINDA | ARIA self-audit sadece visibility sağlar; fix sorumluluğu platform team | 2026-05-10 |

---

## 10. Alternatives Considered + Rejected

| Alternatif | Reddedilme nedeni |
|---|---|
| **F-006'yı tek mega-commit'le kapat** | Atomic rollback yok; her anchor + verification ayrı revert ihtiyacında problem |
| **Snowball'a direkt push (force veya MCP)** | Harness 403 (proxy); MCP ayrı commit SHA üretirdi (signing chain kopar); claude/* + PR profesyonel |
| **runtime_profile.py:369'u da fix kapsamına al** | Docstring zaten swallow'u gerekçelendiriyor — root cause yok, fix gereksiz |
| **auto_merge.py:881 _safe_call'ı sıkılaştır** | readable=False architectural fail-closed pattern; sıkılaştırma snapshot adapter contract'ını bozar |
| **F-006 closure'ı self-review ile yeterli say** | ARIA spec (3-Explore reproducer) reddetiyor; Phase F bu açığı kapatıyor |
| **Phase B'yi ARIA scope içinde gör (data-expert agent dispatch otomatik)** | Operator approval olmadan production-impact triage başlatmak yetkisiz; manual escalation doğru |
| **F-007 yerine 4 ayrı finding (anchor başına bir)** | F-006/F-005 pattern (multi-anchor finding) precedent; tek finding daha izlenebilir |
| **Plan'ı tek shot'da v2 olarak yaz** | İlk pass'ta enterprise-grade detay görülemez; v0 → v1 → v2 acceptable iteration |
| **Bu plan'ı `/root/.claude/plans/` yerine repo'ya commit et** | Plan mode kuralı sadece plans dir'ine yazma izinli; OQ9 ile repo'ya commit sonradan değerlendirilir |
| **Cross-check'i full 1086 finding üzerinde yap** | Token bütçesi + zaman; sample (8 finding) representative + F-007 ile track edilir |
| **F-005 Tier S'i bu seansta operator yerine ben yapayım** | Spec operator-only; bypass ARIA discipline ihlali |

---

## 11. ADR Alignment

Bu plan'ın etkilediği / referans verdiği ADR'ler:

| ADR | İlişki | Etki |
|---|---|---|
| **ADR-006** (event-contracts-flat-pattern) | Yansıma yok | F-006 event contract değiştirmiyor |
| **ADR-008** (guard-strategy-defense-in-depth) | F-007 anchor 4 (security-boundary @Public) | Adapter rule kalibrasyonu defense-in-depth ile çelişiyor görünüyor; reconciliation gerekiyor |
| **ADR-011** (schema-ownership-model) | Phase B doğrudan etkiler | Migration registry drift ADR-011'in core invariant'ını ihlal eder |
| **ADR-012** (schema-drift-prevention) | Phase B + schema-drift-adapter | SchemaDriftValidator boot fail riski; ADR-012 enforcement |
| **ADR-014/015** (NATS cert-is-identity) | Yansıma yok | F-006 NATS dokunmuyor |

Yeni ADR önerileri:
- **(opsiyonel) ADR-016 — Operator-Self-Audit Discipline** (Phase E + OQ4) — operator-conducted findings için review/closure protokolü
- **(opsiyonel) ADR-017 — ARIA Adapter Promotion Gates** (F-007 closure sonrası) — SHADOW → ACTIVE promotion criteria

---

## 12. Compliance / Security Mapping

| Kontrol | Etki | Phase |
|---|---|---|
| **SOC 2 CC4** (audit log completeness) | F-006/F-007/DEBT-2026-05-10-001 governance event'ler `governance.jsonl` immutable ledger'a yazılır | A, C |
| **SOC 2 CC7** (system monitoring) | ARIA cycle telemetry SOC 2 evidence olarak gösterilebilir | All |
| **GDPR Art 30** (records of processing) | Bu plan `aria-tools/governance.jsonl` + `aria-state/*.jsonl` retention'ını etkiler — retention policy var mı? | E (governance question) |
| **GDPR Art 17** (right to erasure) | Migration registry düzeltmesi (Phase B) tenant data path'ini etkilemez (schema-level, data-level değil) | B |
| **KVKK** alignment | Türkçe operator self-audit kayıtları KVKK Art 12 audit trail | All |
| **PCI** (billing service kapsam) | Phase B farm-service kapsamlı; PCI billing-service ayrı; etki yok | B |
| **Multi-tenant isolation** | F-006 fix tenant-isolation guarantee'sini değiştirmiyor (kernel-internal) | A |
| **Schema-drift prevention** (ADR-012) | Phase B doğrudan, F-007 anchor 2 (duplicate adapter) dolaylı | B, C |
| **Security review** (broad except daraltma → security guarantee) | Phase F security-reviewer dispatch optional | F |

**Yeni compliance findings (separate)**:
- ARIA `governance.jsonl` ve `raw-findings.jsonl` retention policy belgelenmemiş — gelecek iş; bu plan'ın scope'u dışı
- Per-tenant ARIA workspace isolation tasarlanmamış — tenant-isolation-auditor ownership

---

## 13. Capacity & Data Growth

| Veri | Growth rate | Etki |
|---|---|---|
| `aria-findings/F-XXX.json` | +1-2 per sprint | Düşük (~10KB each) |
| `aria-debts/DEBT-XXX.json` | +1-2 per quarter | Düşük (~5KB each) |
| `aria-tools/governance.jsonl` | +20-50 events per cycle | Orta (cycle başı ~50KB) |
| `aria-tools/raw-findings.jsonl` | +1086 per cycle (current state) | **Yüksek** (cycle başı ~5MB at this scale) |
| `aria-state/*.jsonl` (per workspace) | Cycle/feedback dependent | Orta |
| `cycles.jsonl` | +1 per cycle | Düşük |

**Recommendations:**
- F-007 closure raw-findings duplicate elimination yapacak (75-row duplicate kaldırılır → -5%)
- `artifact_prune` learning hook 365d TTL ile non-ledger artifacts'i archive'liyor (already enforced)
- Hash-covered ledger'lar (F-005-related) hiçbir zaman archive edilmez (immutability discipline)
- **Action item (gelecek iş)**: raw-findings.jsonl için retention policy + rotation (örn. 90 günlük rolling window, eski'ler `.archive/` altında)

---

## 14. Critical Files

| Faz | Dosya | İşlem | Owner |
|---|---|---|---|
| A | (PR — kod yok) | MCP `mcp__github__create_pull_request` `claude/aria-self-audit-F-006` → `snowball` | Claude |
| A | (opsiyonel, OQ3) `aria-findings/F-006.json` | closes_in_commit: 6ed058a2 patch | Claude |
| B | (NON-ARIA, OQ1) `docs/reviews/data-expert/2026-05-10-migration-registry-drift.md` | YENİ | data-expert agent |
| B | `apps/farm-service/src/app.module.ts` | Migration registry düzeltme | data-expert |
| B | `apps/farm-service/src/database/migrations/*.ts` | Timestamp clash giderme (rename veya konsolidasyon) | data-expert |
| C | `aria-findings/F-007.json` | YENİ (schema yukarıda) | Claude |
| C | `aria-findings/_index.json` | F-007 row eklenir | Claude |
| C (opsiyonel) | `aria-debts/DEBT-2026-05-10-002.json` | test-gap heuristic için tracked debt | Claude |
| C (opsiyonel, OQ6) | `docs/aria/cycle-snapshots/cyc-20260510T0156Z/raw-findings.jsonl` | F-007 evidence preservation (R8) | Claude |
| D | `aria-findings/F-005.json` + `_index.json` | status flip OPEN→RESOLVED | Operator |
| E | `CLAUDE.md` veya `docs/aria/IDENTITY.md` | 7 kuralı codify | Operator/Claude |
| E (opsiyonel) | `.claude/agents/aria-self-audit-discipline-enforcer.md` | YENİ agent definition | Operator/Claude |
| E (opsiyonel) | `docs/runbooks/stop-hook-behavior.md` | Stop-hook auto-commit davranışı dokümante | Operator/Claude |
| F | (review-only, opsiyonel ek commit'ler) | Independent review çıktısı | independent agent |
| Plan-self (OQ9) | `docs/plans/2026-05-10-aria-self-audit-followups.md` | Plan dosyası repo'ya commit | Operator |

---

## 15. Reusable Existing Code References

| Path | Ne için kullanılır |
|---|---|
| `aria-findings/F-001.json` | Finding schema şablonu (F-007 için) |
| `aria-debts/DEBT-2026-05-08-001.json` | Debt schema şablonu (Phase C opsiyonel debt için) |
| `aria-kernel/aria_kernel/cli.py` | Cycle CLI args + sandbox parameter pattern |
| `aria-kernel/tests/test_pressure_phase2_import_fallback.py` | Broad-except daraltma test pattern |
| `aria-kernel/tests/test_architectural_debt_marker_invariant.py` | Generic invariant pattern (her aria-debt: marker bu testle otomatik kapsanır; finding-marker invariant için extend edilebilir) |
| `aria-kernel/aria_kernel/evidence_validator.py` | Phase F anchor 1 inceleme noktası |
| `tools/aria-adapters/*.tool.json` + `*.ts` | Phase C anchor 2-3-4 düzenleme noktaları |
| `aria-kernel/aria_kernel/tool_runner.py` | F-007 evidence reference (raw vs emitted ayrımı) |
| `e2e/tests/integration/schema-invariants.spec.ts` | Phase B verification |
| `aria-kernel/aria_kernel/cycle.py` | run_enterprise_cycle entry, pre_tool_phases pattern |
| `aria-kernel/aria_kernel/auto_merge.py` | _safe_call pattern (architectural fail-closed) — Phase E codification ref |
| `docs/aria/SPEC.md §1` | "Three Founding Sentences" — Phase F discipline reference |
| `docs/aria/IDENTITY.md §3.6` | "Daily Rhythm + DEBT discipline" — Phase E codification base |
| `docs/aria/CONTRACTS.md §6.6` | DEBT schema (zaten DEBT-2026-05-10-001 yazımında kullanıldı) |

---

## 16. Verification (end-to-end, measurable)

### Phase-bazlı:
- [ ] **A1-A8** (Phase A — bkz. Phase A acceptance)
- [ ] **B1-B7** (Phase B — bkz. Phase B acceptance)
- [ ] **C1-C6** (Phase C — bkz. Phase C acceptance)
- [ ] **D1-D4** (Phase D — bkz. Phase D acceptance)
- [ ] **E1-E4** (Phase E — bkz. Phase E acceptance)
- [ ] **F1-F3** (Phase F — bkz. Phase F acceptance)

### Sistem-bazlı (post-plan ARIA cycle re-run):
- [ ] **G1**: `aria-kernel cycle run` (sandbox) `cycle_diff.changed_paths` Phase A merge sonrası pressure.py + cycle.py + 3 test + F-006 + F-007 + DEBT dosyalarını göstermeli
- [ ] **G2**: schema-drift-adapter raw_findings_count Phase B sonrası düşmeli (75 → ?)
- [ ] **G3**: cqrs/outbox/agent-harness adapter status `invalid_evidence` Phase C anchor 1 closure sonrası `ok`'e dönmeli
- [ ] **G4**: F-007 closure sonrası 1086 raw finding 1086-bias düşmüş olmalı (duplicate elimination + heuristic fix)

### One-shot verification script (post-implementation):

```bash
#!/bin/bash
# /tmp/verify-aria-self-audit-plan.sh
# Run after all phases implemented to verify state

set -e
cd /home/user/aquaculture_platform

echo "=== Phase A verification ==="
git fetch origin snowball
git log origin/snowball -5 --oneline | grep -E "(F-006|aria-debt:DEBT-2026-05-10-001|Tier V|gitignore)" \
  || { echo "FAIL: Phase A commits not on snowball"; exit 1; }

python3 -c "
import json
f = json.load(open('aria-findings/F-006.json'))
assert f['status'] == 'RESOLVED', f'F-006 status not RESOLVED: {f[\"status\"]}'
d = json.load(open('aria-debts/DEBT-2026-05-10-001.json'))
assert d['current_status'] == 'OPEN', f'DEBT not OPEN: {d[\"current_status\"]}'
assert d['due_date'].startswith('2026-06-24'), f'DEBT due_date wrong: {d[\"due_date\"]}'
print('Phase A: F-006 RESOLVED, DEBT-2026-05-10-001 OPEN due 2026-06-24 ✓')
"

echo "=== Phase B verification (if applicable) ==="
test -f docs/reviews/data-expert/2026-05-10-migration-registry-drift.md \
  && echo "Phase B: triage report present ✓" \
  || echo "Phase B: triage report MISSING (may be in PR comment)"

clash_count=$(grep -c "1788300000000" apps/farm-service/src/app.module.ts || echo 0)
test "$clash_count" -le 1 \
  && echo "Phase B: timestamp 1788300000000 referenced $clash_count times ✓" \
  || { echo "FAIL: timestamp 1788300000000 still clashes ($clash_count refs)"; exit 1; }

echo "=== Phase C verification ==="
test -f aria-findings/F-007.json && echo "Phase C: F-007 file exists ✓"
python3 -c "
import json
idx = json.load(open('aria-findings/_index.json'))
ids = [f['finding_id'] for f in idx['findings']]
assert 'F-007' in ids, 'F-007 not in _index.json'
print('Phase C: F-007 in _index.json ✓')
"

echo "=== Phase D verification ==="
python3 -c "
import json
f = json.load(open('aria-findings/F-005.json'))
print(f'Phase D: F-005 status = {f[\"status\"]}', '✓' if f['status'] == 'RESOLVED' else '(pending operator)')
"

echo "=== Phase E verification ==="
grep -q "Read full function before flagging swallow" CLAUDE.md docs/aria/IDENTITY.md 2>/dev/null \
  && echo "Phase E: discipline rule codified ✓" \
  || echo "Phase E: discipline rule NOT codified (pending)"

echo "=== Phase F verification ==="
echo "Phase F: independent review report — manual check"

echo "=== ARIA cycle re-run G1-G4 ==="
echo "Run: aria-kernel --tools-dir /tmp/aria-sandbox/tools cycle run \\"
echo "       --workspace-root . --workspace-base /tmp/aria-sandbox/ws \\"
echo "       --cycle-id verify-\$(date +%s) --shadow-only"
echo "Then check tool_run_summary for cqrs/outbox/agent-harness status"

echo "=== ALL VERIFICATION COMPLETE ==="
```

---

## 17. Communication Plan

### Phase A PR description template

```markdown
## Summary
Operator-conducted ARIA self-audit (2026-05-10) on snowball HEAD 754acb46
identified two kernel-internal silencing/tracking discipline gaps; F-006
(MEDIUM) opened and closed via three anchor commits + Tier V verification.

- 8170a7c1 — fix(aria-kernel): F-006 anchor 1 — pressure._phase2_effective_context narrows broad except to ImportError
- cd08f99e — chore(aria-kernel): F-006 anchor 2 — cycle.pr_lifecycle placeholder gets aria-debt:DEBT-2026-05-10-001 marker + ledger entry
- 6ed058a2 — verify(aria-kernel): F-006 closure — Tier V mechanical 1079/1079 green; F-006 OPEN -> RESOLVED
- 2c4aea24 — chore(gitignore): ignore Python *.egg-info build artifacts

## Verified
- 1079 / 1079 unittest discover green (1072 baseline + 7 new tests)
- ts-node 10.9.2 verified via npm install --ignore-scripts
- git config signing isolated via GIT_CONFIG_GLOBAL env (no --no-verify)
- npm-scoped supply-chain discipline (CLAUDE.md compliant)

## Outstanding (intentionally not done)
- DEBT-2026-05-10-001 stays OPEN; permanent fix (proposal_id threading
  through cycle CLI) due 2026-06-24, owner okan-platform-operator
- F-005 Tier S sign-off remains operator-only action; this PR's Tier V
  retroactively confirms the 1072/1072 baseline claim across snowball
  commits 754acb46/c16ffc18/559c2906/22c60810
- F-001/F-003/F-005 OPEN, unchanged — out of scope

## Test plan
- [ ] CI green (Nx affected build + lint + test)
- [ ] schema-invariants integration test green
- [ ] Operator review of 4 commit messages + Closes lines

## Linked findings + plan
- aria-findings/F-006.json (RESOLVED)
- aria-findings/F-005.json (OPEN, partial Tier V satisfaction)
- aria-debts/DEBT-2026-05-10-001.json (OPEN, due 2026-06-24)
- Followup plan: docs/plans/2026-05-10-aria-self-audit-followups.md (if OQ9=yes)

## Production-impact escalation (separate)
ARIA cycle yan-bulgu olarak farm-service migration registry'de:
- CRITICAL: timestamp 1788300000000 clash (AddFarmAuditLogsImmutability vs AddBiomassReports)
- HIGH: 75 unregistered migration

Bunlar bu PR scope'u dışı; data-expert tarafından ayrı kanal/PR ile triage edilecek (Phase B).
```

### Phase B escalation template (`docs/reviews/data-expert/...`)

```markdown
# Migration Registry Drift — 2026-05-10 (escalated from ARIA cycle cyc-20260510T0156Z)

## Severity: CRITICAL (data corruption risk)

## Summary
ARIA schema-drift-adapter cross-check surfaced two production-impact
issues in apps/farm-service/src/database/migrations/:
1. Timestamp clash: 1788300000000 used by both AddFarmAuditLogsImmutability
   and AddBiomassReports — TypeORM migration order non-deterministic.
2. 75 migration .ts files exist on disk but are NOT registered in
   apps/farm-service/src/app.module.ts:205-237.

## Evidence
- Cross-check verified at session 2026-05-10
- Raw finding ledger: /tmp/aria-sandbox/tools/raw-findings.jsonl
  (cycle cyc-20260510T0156Z; preserved at docs/aria/cycle-snapshots/...
  if OQ6 yes)

## Required action
data-expert / database-reviewer triage; see Phase B in plan
docs/plans/2026-05-10-aria-self-audit-followups.md (if OQ9=yes).

## Compliance
- ADR-011 (schema-ownership) ihlal riski
- ADR-012 (schema-drift-prevention) gate'leniyor
- Production cold-start migration runner (DATABASE_MIGRATIONS_RUN=false)
  ile aqua-db-migrate container migration sırası deterministic olmalı
```

### Internal session notes
- Bu plan dosyası `/root/.claude/plans/imdi-neler-oldu-unu-nas-l-abundant-sparrow.md` olarak yazıldı; opsiyonel olarak `docs/plans/2026-05-10-aria-self-audit-followups.md` olarak repo'ya commit edilebilir (audit-trail için — OQ9)
- Plan v2 (extended) operator approval gerektiriyor; v1'den v2'ye genişleme operator feedback ile

---

## 18. Follow-up Cadence

| Tarih | Owner | Aksiyon |
|---|---|---|
| 2026-05-10 (today) | Operator | Plan v2 onayı + Phase A PR creation |
| 2026-05-11 | Operator | Phase A PR review + merge |
| 2026-05-11 | Operator | Phase B kanal seçimi (OQ1) + data-expert dispatch |
| 2026-05-12 | Claude (next session) | Phase C F-007 dosyası |
| 2026-05-12 | Operator | Phase D F-005 Tier S |
| 2026-05-15 | Claude/Operator | Phase E going-forward codification |
| 2026-05-17 | independent agent | Phase F review (eğer OQ2=zorunlu) |
| 2026-06-09 | Operator | DEBT-2026-05-08-001 deadline (mevcut iş, plan dışı reminder) |
| 2026-06-24 | okan-platform-operator | DEBT-2026-05-10-001 permanent fix deadline |
| 2026-07-06 | Operator | DEBT-2026-05-07-001 deadline (LOW, plan dışı reminder) |
| 2026-07-10 | Operator (eğer OQ7=evet) | F-007 due date |

Daily check (otomatik, ARIA cycle):
- Her cycle run'unda OPEN debt'lerin due_date < 30 gün olanları daily report headline
- Her cycle run'unda OPEN finding count drift telemetry
- Stale ref check (90 gün) governance event

Weekly cadence:
- Pazartesi: ARIA daily report review (operator)
- Çarşamba: F-007 anchor closure progress (operator)
- Cuma: Plan v2 phase status update (Claude/operator)

---

## 19. Operator Handoff Package

Plan implement edildikten sonra operator'a teslim edilecek artifact paketi:

### Belgeler
- [x] Bu plan dosyası (v2)
- [ ] Phase A PR URL + diff özeti
- [ ] Phase B triage raporu (data-expert çıktısı)
- [ ] F-007.json + cycle snapshot (eğer OQ6=evet)
- [ ] Phase F independent review raporu (eğer OQ2=evet)
- [ ] (Opsiyonel) ADR-016/017 PR

### Kayıtlı kararlar (Decision Log + Open Questions çözümleri)
- [ ] OQ1-OQ10 hepsi yanıtlanmış
- [ ] Tier S sign-off note (governance event)

### Test sonuçları
- [ ] Pre-implementation baseline: 1079/1079 (this session)
- [ ] Post-Phase A: TBD
- [ ] Post-Phase B: schema-invariants green
- [ ] Post-Phase C: 1080+/1080+ green
- [ ] G1-G4 cycle re-run results

### Audit trail
- [ ] All commit SHAs on snowball
- [ ] All governance events emitted
- [ ] All ledger updates recorded
- [ ] All ARIA finding state transitions

### Backlog (gelecek iş)
- [ ] F-001 closure (LOW, deferred to next platform sprint)
- [ ] F-003 anchor 2-3-4 closure
- [ ] F-005 Tier S sign-off completion
- [ ] DEBT-2026-05-10-001 permanent fix (due 2026-06-24)
- [ ] F-007 anchor 1-4 closure (post Phase A merge)
- [ ] Adapter promotion (SHADOW → ACTIVE)
- [ ] ARIA workspace multi-tenant bootstrap (gelecek plan)
- [ ] raw-findings.jsonl retention/rotation policy

---

## 20. Glossary

| Terim | Tanım |
|---|---|
| **ARIA** | Aquaculture Repository Intelligence Agent — repository-shaped intelligence; bu repo'nun snowball branch'inde yaşar |
| **Cycle** | ARIA'nın run-once meta-loop'u: discovery + tools + memory + pressure + reflection + learning |
| **Adapter** | Repo'yu okuyup raw observations/findings emit eden TS/Python script. SHADOW (observe-only), ACTIVE (operator-facing), QUARANTINED (failure threshold) status |
| **Pressure** | ARIA'nın iç state'i: değişim baskısı (pressure event), kapasite gap'i (capability gap) gibi |
| **Finding** | Operator-facing audit kaydı; F-XXX schema'lı; aria-findings/ altında |
| **Debt** | CONTRACTS §6.6 architectural-debt; DEBT-XXX schema'lı; aria-debts/ altında; owner + deadline + tracked |
| **Tier V** | Plan 024 v3 verification mechanical (3-Explore-agent reproducer + npm run invariants:full + unittest discover) |
| **Tier S** | Plan 024 v3 sign-off (operator-only) |
| **Anchor** | Bir finding'in iç maddelerinden biri; her anchor ayrı commit'le kapatılabilir |
| **Snowball** | ARIA'nın canlı branch'i; Plan 016+ tüm iş burada |
| **Raw finding** | SHADOW adapter'ın emit ettiği henüz operator-facing olmayan ham bulgu |
| **Emitted finding** | ACTIVE adapter'ın operator-facing olarak yazdığı bulgu (currently 0; tüm adapter'lar SHADOW) |
| **CONTRACTS.md** | ARIA'nın data schema ve contract dokümanı (`docs/aria/CONTRACTS.md`) |
| **SPEC.md** | ARIA'nın laws + engines + boundaries dokümanı (`docs/aria/SPEC.md`) |
| **IDENTITY.md** | ARIA'nın behavior + daily rhythm + refusals dokümanı (`docs/aria/IDENTITY.md`) |
| **PoC** | `tools/aria-poc/poc.py` — pure-mechanical operator decision tool, no LLM |
| **Workspace root** | `~/.aria/workspaces/<repo_hash>/` veya `--workspace-base` ile override; per-repo state |
| **Tools root** | `aria-tools/` veya `--tools-dir` ile override; per-repo tool registry + runs |
| **Banned phrase gate** | CONTRACTS §6.6 + IDENTITY §3.6 — root_cause_summary "for now"/"interim"/"deferred" geçemez |

---

## 21. Definition of Done

Bu plan tamamen başarılı sayılır eğer **AŞAĞIDAKİ HEPSİ** doğru:

1. **Phase A**: PR merged, snowball'da F-006 RESOLVED + DEBT-2026-05-10-001 OPEN, all A1-A8 acceptance ✓
2. **Phase B**: Production-impact escalation kaydı mevcut, data-expert triage tamamlanmış, B1-B7 acceptance ✓
3. **Phase C**: F-007 dosyası snowball'da, _index.json güncel, C1-C6 acceptance ✓
4. **Phase D**: F-005 RESOLVED (operator sign-off), D1-D4 acceptance ✓
5. **Phase E**: Going-forward 7 kural codified, E1-E4 acceptance ✓
6. **Phase F** (eğer OQ2=zorunlu): Independent review raporu mevcut, F1-F3 acceptance ✓
7. **System-level**: ARIA cycle re-run G1-G4 ✓
8. **Open Questions**: OQ1-OQ10 hepsi yanıtlanmış, Decision Log güncel
9. **Audit trail**: Tüm governance event'ler ledger'da, tüm SHA referansları reachable
10. **Operator handoff package** (Section 19) tamamlanmış
11. **Backlog** (Section 19'daki gelecek iş listesi) kayıt altında, owner'lı

**Definition of NOT Done (failure modes)**:
- ❌ Phase A merged ama Phase F skip edildi (OQ2=opsiyonel olsa bile enterprise-grade için tehlikeli)
- ❌ Phase B production fix deploy edilmeden Phase C başladı (sıralama doğru ama Phase B'nin tamamlanmaması production risk'i)
- ❌ DEBT-2026-05-10-001 marker silindi ama permanent fix yapılmadı (silent debt — banned)
- ❌ F-006 status tekrar OPEN'a döndü ama supersedes mekanizması kullanılmadı

---

**Plan v2 sonu. Operator approval bekleniyor.**
