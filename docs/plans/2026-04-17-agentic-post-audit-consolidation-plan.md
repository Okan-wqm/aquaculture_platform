# Enterprise-Grade Agent Sistemi Konsolidasyonu & Tamamlama Planı

## Context

Kullanıcı **eksiksiz, enterprise-grade** bir agent sistemi istiyor — "yazılımı her açıdan ileriye taşıyacak" kalitede.

Mevcut durum (2026-04-16 audit, 3-Explore-agent derin tarama sonrası):

- **Üç agent dizini paralel yaşıyor**: `.claude/agents/` (20 legacy, Apr 13), `.claude/agents-enterprise-v2/` (24 dosya, yarısı converted/yarısı legacy), `.claude/test-agents/` (28 auditor). `.claude/settings.json` hangisini seçeceğini belirtmiyor → `name: data-expert` üç yerde aynı frontmatter ile tanımlı, Claude Code dispatch'te undefined-behavior riski.
- **21 phantom artefakt**: agent prompt'ları ve knowledge SSoT'ları gerçekte inşa edilmemiş `tools/gates/*`, `.claude/skills/*`, `docs/reviews/_registry/findings.jsonl`, `root-cause-auditor` agent, 5 phantom invariant test, 2 phantom workflow referans veriyor. TEACHER mode'unda agent var olmayan skill'leri önerir; CATCHER raporları "W7 gate yakalar" diye kurgu Tier-3 claim üretir.
- **Routing kör noktaları**: `apps/db-migrate/` (16. servis), `libs/shared-contracts/`, `scripts/**`, `docs/**`, `nx.json`, `tsconfig.base.json`, `mcp/**` (roster'da eksik) orchestrator routing tablosunda yok. Orchestrator kendi kuralına göre her review'da PROCESS HIGH üretir.
- **3 ownership çakışması**: `platform/libs/outbox/**` (data-expert + messaging-expert primary), `libs/backend-common/src/database/**` (data-expert + multi-tenant partial), `libs/backend-common/src/redis/**` (auth-security + multi-tenant partial) — pair-review invariant kararsız kalır.
- **SSoT drift**: `createTenantQueryKey` imza tersine yazılmış (CRITICAL: TEACHER yanlış kod üretir), Vite versiyon anchor'ı W1 audit ile çelişir, ADR misfile sayısı 4↔5, SchemaDriftModule adoption "9+" → gerçek 12/13.
- **10 agent hâlâ convert edilmemiş** (>200 satır cap ihlâli + inline SSoT duplication): security-reviewer 317, orchestrator 308, implementation-planner 279, frontend-expert 246, platform-services 218, hr-expert 197, database-reviewer 192, context-manager 184, admin-expert 177, prompt-writer 175. W3 wave in-flight (son commit'ler W3-a/W3-b).

**Authoritative önceki plan**: `/root/.claude/plans/declarative-riding-shamir.md` (848 satır, W0-W14, Part A-F). W0-W1 tamamlandı, W3 wave in-flight; W4-W14 henüz inşa edilmedi — plan'daki skill/gate/registry/auditor bileşenleri **bu planın phantom bulguları**. Bu dosya o plan'ın üstüne **post-audit tamamlama & konsolidasyon katmanı** ekler; onu supersede etmez, devamıdır.

**Sonuç**: Agent'lar değerli içeriğe sahip ama operasyonel olarak %40 phantom altyapıya yaslanıyor. Bu plan (a) sistem-bozan parçaları bir hafta içinde kapatır, (b) phantom'ları gerçek implementasyona çevirir, (c) üç dizini tek canonical dizine konsolide eder, (d) CI gates'i devreye alır, (e) traceability loop'unu kapatır.

---

## Yapı

Plan iki ana bölümden oluşur:

- **Bölüm I — SİSTEM BOZAN (Phase 0)**: Bu hafta merge edilmeli. Mevcut agent dispatch'inin tutarsız davranmasına, TEACHER yanlış kod üretmesine, veya orchestrator'ın kendi kuralını ihlal etmesine neden olan kalemler.
- **Bölüm II — EKSİKLER (Phases 1-7)**: Master plan'in inşa edilmemiş W3-W10 dalgalarını enterprise-grade sırasıyla tamamlar. Her phase W-N numaralarıyla master plan'a bağlıdır; finding ID'leri ile Closes: footer disiplini kurulur.

Her phase için: **deliverable**, **değişecek/oluşacak dosyalar**, **mevcut utility'lerden reuse**, **verification**.

---

# BÖLÜM I — SİSTEM BOZAN (Phase 0, bu hafta)

Beş kalem, her biri kritik, hepsi birbirinden bağımsız paralelde ilerleyebilir. Review traceability: hepsi `Closes: docs/reviews/orchestrator/2026-04-16-v2-audit.md#P0-{N}` trailer'ı ile.

## Phase 0.1 — Agent dizin konsolidasyonu (canonical = v2)

**Deliverable**: Tek runtime agent dizini, disambiguation açık.

**Adımlar**:
1. `.claude/agents/` → `.claude/agents.legacy/` (dosya taşıma + `README.md` ekle: "FROZEN; new work → agents-enterprise-v2/"). Master plan AMENDMENT-C W8 diye planlamıştı; W3 mid-flight olduğu için şimdi taşıyoruz (duplikasyon kafa karışıklığını her gün büyütüyor).
2. `.claude/test-agents/` → `.claude/test-agents/` olarak **kalır** (product E2E auditor'lar ortogonal, dokunulmaz — master plan AMENDMENT-C doğrulaması).
3. `.claude/settings.json` veya `.claude/settings.local.json`'a agent dir selector ekle: Claude Code 2.x'te agent loading için ilgili ayar. (Yapılacak araştırma: settings schema'sında agent-path belirtimi var mı; yoksa symlink `.claude/agents → .claude/agents-enterprise-v2` yeterli.)
4. `.claude/agents-enterprise-v2/README.md`'yi güncelle: "Activation: DONE; runtime canonical" duyurusu.

**Reuse**: Master plan'in `AMENDMENT-C` sekansını aynen takip et.

**Critical files**:
- `.claude/agents/` → archive to `.claude/agents.legacy/` (20 file move)
- `.claude/agents.legacy/README.md` (new, 1 paragraph)
- `.claude/agents-enterprise-v2/README.md` (update "inert" claim)
- `.claude/settings.json` (agent-dir config if supported)

**Verification**: `grep -rn "^name: data-expert" .claude/agents*/ .claude/test-agents/` sadece tek match döndürmeli (agents-enterprise-v2'den). Dispatch smoke test: `Agent(data-expert, ...)` çağır ve log'da hangi dosyanın yüklendiğini doğrula.

## Phase 0.2 — Routing tablosu eksik path'leri kapatılması

**Deliverable**: `orchestrator.md` routing table satır 29-98 tüm gerçek repo yollarını kapsar; "unmatched path = PROCESS HIGH" kuralı asla kendi altyapısında tetiklenmez.

**Eklenecek satırlar**:
| Glob | Primary | Also Notify |
|---|---|---|
| `apps/db-migrate/**` | data-expert | infra-expert |
| `libs/shared-contracts/**` | data-expert | *all consumers* |
| `scripts/nats/**` | infra-expert | data-expert |
| `scripts/ci/**` | infra-expert | test-runner |
| `scripts/deploy*`, `scripts/*.sh`, `scripts/*.ts` | infra-expert | security-reviewer |
| `docs/adr/**` | architectural-arbiter | prompt-writer |
| `docs/runbooks/**` | infra-expert | security-reviewer |
| `docs/reviews/**` | context-manager | orchestrator |
| `docs/research/**` | prompt-writer | — |
| `nx.json`, `tsconfig.base.json`, `jest.config.*` | platform-kernel-expert | infra-expert |
| `.claude/knowledge/**`, `.claude/agents-enterprise-v2/_shared/**` | prompt-writer | architectural-arbiter |
| `.claude/allowlists/**` | security-reviewer | architectural-arbiter |
| `CLAUDE.md` | architectural-arbiter | prompt-writer, all experts |

**Runtime roster tablosu (orchestrator.md:259-279)**: `mcp-expert` satırı ekle (routing table'de var ama roster'da eksik — iç tutarsızlık).

**Critical files**:
- `.claude/agents-enterprise-v2/orchestrator.md` (satır 29-98 + 259-279)

**Reuse**: Hiçbir yeni agent yaratma; mevcut 24 agent'a atanabilen path'ler.

**Verification**: Yeni bir CI invariant test — `tests/invariants/orchestrator-routing-coverage.spec.ts`: repo'daki her top-level dizin için en az bir glob eşleşmesi olmalı. Phase 7 ile yazılacak; Phase 0'da manuel script ile doğrula.

## Phase 0.3 — Ownership çakışmalarını çöz

**Deliverable**: Her glob tek primary owner'a sahip; multi-tenant / security uzmanları "secondary reviewer for tenant/security contract" olarak netleşir.

**Kurallar**:
1. **`platform/libs/outbox/**`** → data-expert **primary** (entity base + migration-delta + worker transactional integrity). messaging-expert "consumer review" secondary. Her iki agent dosyasındaki Primary Ownership bloğunu düzelt; orchestrator routing tablosu zaten doğru (line 96 messaging primary — **bunu data-expert'e çevir**, çünkü outbox özünde persistance contract'ı).
2. **`libs/backend-common/src/database/**`** → data-expert **primary (full ownership)**. multi-tenant-saas-expert sadece `tenant-connection-bootstrap`, `tenant-aware.repository`, `watchdog/` — tenant-contract delegated review olarak kalır. multi-tenant-saas-expert.md:30-33'te bu alt-path'leri "delegated-from-data-expert" olarak etiketle.
3. **`libs/backend-common/src/redis/**`** → auth-security-expert **primary (session/rate-limit)**. multi-tenant-saas-expert'in `tenant-redis.service.ts` claim'i "delegated" olarak netleştirilir.

**Critical files**:
- `.claude/agents-enterprise-v2/data-expert.md` (Primary Ownership netleştir)
- `.claude/agents-enterprise-v2/messaging-expert.md` (outbox'ı secondary yap)
- `.claude/agents-enterprise-v2/multi-tenant-saas-expert.md` (database + redis delegation etiketle)
- `.claude/agents-enterprise-v2/orchestrator.md` (line 96 primary değiştir)
- `.claude/agents-enterprise-v2/_shared/handoff-protocol.md` (delegation grammar'ı ekle: "primary|secondary|delegated" ayrımı)

**Verification**: Phase 7 invariant test `tests/invariants/agent-ownership-uniqueness.spec.ts` — her glob için primary-count == 1.

## Phase 0.4 — SSoT drift'leri düzelt

**Deliverable**: Knowledge layer artık TEACHER output'larını yanlış yönlendirmez.

**Düzeltmeler**:
| Dosya | Satır | Yanlış | Doğru | Severity |
|---|---|---|---|---|
| `layer-1-react.md` | 36 | `createTenantQueryKey(queryKey, tenantId)` | `createTenantQueryKey(tenantId, ...segments)` | **CRITICAL** |
| `layer-1-react.md` | 4 | "Vite ^5.0.0" (isim) | "Vite ^5.0.0 (shell pin) / 7.3.1 (root — overridden)" | HIGH |
| `layer-1-typeorm.md` | 37 | "9+ services" | "12/13 services; event-store-service pending" | MEDIUM |
| `layer-3-adrs.md` | 31 | "4 misfiled ADR" | "5 misfiled ADR files under docs/architecture/" | LOW |
| `layer-1-typeorm.md` | 32 | "2 messaging migrations" | "Multiple migrations — see DATA-HIGH-003 for exact set" | MEDIUM |
| `CLAUDE.md` | 20 | "15 services" | "16 services (includes db-migrate)" | MEDIUM |

**Critical files**:
- `.claude/knowledge/layer-1-react.md`
- `.claude/knowledge/layer-1-typeorm.md`
- `.claude/knowledge/layer-3-adrs.md`
- `CLAUDE.md` (service count)

**Verification**: Phase 4'te `tests/invariants/knowledge-ssot.spec.ts` yazılınca retroaktif olarak bu iddiaları kod'a karşı doğrular. Phase 0'da manuel spot-check.

## Phase 0.5 — Phantom referansları "TODO işaretli" yap (geçici)

**Deliverable**: Agent prompt'ları YALANCILIK YAPMIYOR. Henüz inşa edilmemiş artefakt referansı "W-N planned, not yet built" şeklinde etiketlenir; agent CATCHER raporlarında hayali Tier-3 gate claim üretmez.

**Adım**:
- `_shared/tier-claim-syntax.md` satır 3, 44, 87-90, 108-109: "W7 deliverable" tag'i ekle + `[NOT YET BUILT — Phase 2/3/4]` uyarısı
- `_shared/handoff-protocol.md` satır 7, 15: skill catalog yokluğunu açıkça belirt
- `_shared/operating-modes.md` satır 9, 35: WRITER mode "requires skill catalog (Phase 3)" notu
- Her agent dosyasındaki "ESLint rule W7 enforces" türü satırlar — "Planned (Phase 2); currently review-only discipline" şeklinde netleştir

**Alternatif (daha iyi)**: Bu Phase'i atla ve Bölüm II'yi hızlı koş — phantom'lar gerçek olunca prompt'lar doğrudan doğru okunur. Eğer Bölüm II ≤4 hafta içinde tamamlanacaksa, Phase 0.5 gereksiz.

**Decision gate**: Bölüm II'yi ne kadar sürede bitirmeye karar verileceğini Okan onayından sonra belirle. Default öneri: **Phase 0.5'i atla**, doğrudan Bölüm II'ye geç.

---

# BÖLÜM II — EKSİKLER (Phases 1-7, enterprise-grade wave execution)

Master plan'in Parts B-F dalgalarını takip eder. Her phase ≤1-2 hafta; her deliverable Phase 0'da oluşan temel üzerinde çalışır.

## Phase 1 — W3 conversion wave'i tamamla (≤200 satır cap, SSoT reference)

**Master plan eşlemesi**: Part B, W3 (in-flight, son commit `adc383f7 refactor(agentic,w3-b/2)`).

**Deliverable**: 10 kalan agent `_shared/_conversion-template.md` pattern'ine converted. Inline SSoT duplikasyonu sıfır.

**Convert edilecekler** (line-count / current state):
1. security-reviewer (317) — **en büyük**, cross-cutting rules SSoT'a aktarılacak
2. orchestrator (308) — routing table kalır, phase anlatımı `_shared/orchestrator-phases.md`'a taşınabilir
3. implementation-planner (279)
4. frontend-expert (246) — React 18 stack inline claim layer-1-react'e delegated
5. platform-services (218)
6. hr-expert (197)
7. database-reviewer (192)
8. context-manager (184)
9. admin-expert (177)
10. prompt-writer (175)

**Sıra**: security-reviewer → orchestrator → implementation-planner (yüksek-impact) → rest (paralel).

**Critical files** (her agent için):
- `.claude/agents-enterprise-v2/<agent>.md` (rewrite per template)
- Shared extraction hedefi: `.claude/agents-enterprise-v2/_shared/orchestrator-phases.md` (yeni, orchestrator-specific phase descriptions)

**Reuse**: `_shared/_conversion-template.md`, zaten converted 14 agent örnek.

**Verification**: 
- Line count invariant: `wc -l .claude/agents-enterprise-v2/*.md` — hiçbiri > 200.
- Content hash invariant (Phase 4'te yazılacak): inline SSoT duplication yok.
- Dispatch smoke test: her agent `Agent(<name>, scope: small-change)` çağrılınca CATCHER output üretir.

## Phase 2 — `tools/gates/` infra inşaası

**Master plan eşlemesi**: Part D, W4-W5.

**Deliverable**: Pre-commit + CI gates gerçekten fonksiyonel; tier-claim/banned-phrase/commit-msg/migration-sql-lint prompts'da iddia edildiği gibi çalışır.

**Oluşturulacak** (TypeScript, `ts-morph` AST kullanarak — BLOCKER-5'e göre `npm install -D ts-morph@^23` önce):
1. `tools/gates/banned-phrase.ts` — CLAUDE.md banned phrases + `.eslintrc.json:97-111` no-restricted-syntax yansıması. Pre-commit + CI.
2. `tools/gates/tier-claim-lint.ts` — `// tier-N:` comment grammar validator + boundary-allowlist consult.
3. `tools/gates/commit-msg-validator.ts` — `Closes: docs/reviews/.../#FINDING-ID` trailer zorunlu (security CRITICAL fix için), format validator.
4. `tools/gates/migration-sql-lint.ts` — data-expert.md'nin detaylı SQL-lint kurallarını encode et (SET LOCAL, CONCURRENTLY, blue-green 3-step, destructive migration guard).
5. `tools/gates/finding-registry.ts` — CLI aracı: finding CRUD, state transitions (OPEN/IN-PROGRESS/RESOLVED/STALE/BLOCKED), hash-chain append.
6. `tools/eslint-rules/require-entity-schema.ts` — BLOCKER-8 için custom ESLint rule (`@Entity('name')` schema option zorunlu).
7. `tools/eslint-rules/no-bare-tenant-query-key.ts` — ADR-009 için.
8. `tools/eslint-rules/no-direct-event-publish.ts` — ADR-006 outbox-only için.

**Critical files** (create):
- `tools/gates/*.ts` (6 dosya)
- `tools/eslint-rules/*.ts` (3 dosya)
- `tools/gates/README.md` (kullanım, pre-commit vs CI matrix)
- `package.json` — `ts-morph` + `engines.node >= 22.6.0` (BLOCKER-5)
- `.husky/pre-commit` (v8 style) — çağrılan script zinciri
- `.github/workflows/quality-gates.yml` — CI karşılığı

**Reuse**:
- `.eslintrc.json`'da mevcut `no-restricted-syntax` kurallarının pattern'i
- `.claude/allowlists/boundary-files.yaml` — 19 legitimate boundary (mevcut, tier-claim-lint tüketir)
- Master plan Part D (satır 511-688) birebir recipe

**Verification**:
- `npm run pre-commit` staged bir banned-phrase'lik diff ile fail eder.
- CI workflow green patika: temiz branch.
- `tools/gates/finding-registry.ts add CRITICAL-001 ...` → `docs/reviews/_registry/findings.jsonl` oluşturur + hash-chain valid.

## Phase 3 — `.claude/skills/` katalogu

**Master plan eşlemesi**: Part C, W3-W4.

**Deliverable**: WRITER mode fonksiyonel; TEACHER mode "invoke skill X" önerisi gerçek hedefe yönlendirir; cascade enforcement çalışır.

**İlk batch (BLOCKER-15 + BLOCKER-14 ripple'ı kapsar)**:
1. `.claude/skills/README.md` — skill file format, `handoff:` frontmatter spec, lifecycle.
2. `.claude/skills/add-entity-field.md` — entity + DTO + migration (blue-green 3-step) + event contract + fixture + test + upcaster. Handoff: data-expert + database-reviewer CATCHER.
3. `.claude/skills/change-event-contract.md` — contract file + upcaster + consumer services enumeration (ripple-tracer). Handoff: data-expert + ALL consumer experts.
4. `.claude/skills/add-shared-table.md` — ADR + architectural-arbiter approval + `SHARED_SCHEMA_TABLES` update + CODEOWNERS gate. (BLOCKER-15 close)
5. `.claude/skills/add-rls-policy.md` — tenant-schema 5-layer isolation template. Handoff: multi-tenant-saas-expert + data-expert.
6. `.claude/skills/provision-tenant.md` — saga orchestration + 7 schema-per-tenant service + compensation. (BLOCKER-14 close)
7. `.claude/skills/pre-migration-restore-test.md` — destructive migration pg_dump verify + restore rehearsal. (D12 kapsamı)
8. `.claude/skills/run-migration-prod.md` — master plan infra-expert ground-truth (mevcut `tools/scripts/database/backup-databases.sh` tüketir).

**Ripple-tracer engineering**: Master plan AMENDMENT-A W7.5'te — `tools/ripple-tracer/services-yaml-parser.ts` + `ts-morph` AST entegrasyonu. Skills bunu tüketecek.

**Critical files**:
- `.claude/skills/*.md` (8 dosya)
- `tools/ripple-tracer/*.ts` (yeni, ≤3 dosya)
- `.claude/agents-enterprise-v2/implementation-planner.md` (skill-DAG composition update)

**Reuse**:
- `libs/event-contracts/src/upcasters/` — mevcut 2 upcaster örneği (add-entity-field skill'i aynı pattern'i generate eder)
- `apps/hr-service/src/database/migrations/` — blue-green migration örnekleri
- `tests/invariants/_constants.ts` — `SCHEMA_OWNING_SERVICES` + `PER_TENANT_SCHEMA_SERVICES` (skills bu listeden okur)
- Master plan Part C (satır 395-510) skill recipe'leri

**Verification**:
- Skill dry-run: `Agent(implementation-planner, "add priority field to farm-service Batch entity", mode=implement)` → skill DAG çıkar + cascade eksiksiz.
- CATCHER pair-review invariant çalışır: add-entity-field skill → data-expert CATCHER (değil skill'i öneren agent).

## Phase 4 — Phantom invariant testleri oluştur

**Master plan eşlemesi**: Part D test katmanı, BLOCKER-1 knowledge-ssot.

**Deliverable**: 5 eksik invariant test yazılı + CI'da green.

**Oluşturulacak**:
1. `tests/invariants/knowledge-ssot.spec.ts` — agent dosyaları inline SSoT duplikasyonu yapmasın (BLOCKER-1). hash-based content diff.
2. `tests/invariants/upcaster-chain.spec.ts` — her event version için matching upcaster var (ADR-006 W6 deliverable).
3. `tests/invariants/orchestrator-routing-coverage.spec.ts` — Phase 0.2'yi CI-locked invariant yapar.
4. `tests/invariants/agent-ownership-uniqueness.spec.ts` — Phase 0.3'ü CI-locked invariant yapar.
5. `tests/invariants/three-store-invariants.spec.ts` — BLOCKER-16, finding-registry + cycle-state + review-file hash üçlü tutarlılık.

**Critical files**:
- `tests/invariants/*.spec.ts` (5 yeni)
- `tests/invariants/project.json` (test target tanımı, mevcut)

**Reuse**:
- `tests/invariants/adoption-invariants.spec.ts` (mevcut, benzer pattern)
- `tests/invariants/_constants.ts` (SCHEMA_OWNING_SERVICES vb.)
- `e2e/tests/integration/schema-invariants.spec.ts` (SHARED_SCHEMA_TABLES pattern)

**Verification**: `nx run tests-invariants:test` green. CI `ci-affected.yml` bu target'ı kapsar.

## Phase 5 — `root-cause-auditor` agent + Orchestrator Phase 4.5 activation

**Master plan eşlemesi**: Part D/E, W9.

**Deliverable**: Tier-claim over-classification'ı structurally yakalanır; önceki-cycle arbiter ruling'leri doğrulanır.

**Adımlar**:
1. `.claude/agents-enterprise-v2/root-cause-auditor.md` — 200 satır altı, `_conversion-template.md`'e uyumlu.
2. `orchestrator.md` Phase 4.5 "reserved" → aktif: within-cycle `// tier-N:` claim verification, cross-cycle arbiter ruling implementation verification.
3. Handoff protocol güncellemesi: auditor CATCHER diğer agent'lar ÜZERİNE çalışır, kendi bulgu ID prefix'i `AUDIT-*`.

**Critical files**:
- `.claude/agents-enterprise-v2/root-cause-auditor.md` (new)
- `.claude/agents-enterprise-v2/orchestrator.md` (Phase 4.5 implementation)
- `.claude/agents-enterprise-v2/_shared/handoff-protocol.md` (auditor grammar)

**Reuse**: Phase 2'de yazılan `tools/gates/tier-claim-lint.ts` — auditor bunu invoke eder.

**Verification**: Test PR: `// tier-1: branded X enforced` claim'i fakat gerçek implementasyon Tier-3. Dispatch'te auditor `OVER_CLAIMED` AUDIT-NNN finding üretsin.

## Phase 6 — Finding registry + traceability loop

**Master plan eşlemesi**: Part D, W10.

**Deliverable**: CLAUDE.md'deki "Closes: ID" kuralı structural enforcement'a dönüşür. STALE/BLOCKED state'leri otomatik yönetilir.

**Adımlar**:
1. `docs/reviews/_registry/findings.jsonl` (empty → first seed with current OPEN findings from W1 audit)
2. `docs/reviews/_registry/findings.jsonl.schema.json` — JSON Schema for CI validation
3. `.github/workflows/finding-state-sweep.yml` — daily cron: past-deadline overrides → STALE escalation
4. `.github/workflows/closes-footer-check.yml` — PR check: her fix commit `Closes:` trailer taşır + registry'de karşılığı var
5. `tools/gates/commit-msg-validator.ts` — Phase 2'den, registry'yi consume eder

**Critical files**:
- `docs/reviews/_registry/` (new dir)
- `.github/workflows/*.yml` (2 yeni)
- `tools/gates/finding-registry.ts` (Phase 2'de yazıldı, burada CI'a bağlanır)

**Reuse**: Phase 2 `finding-registry.ts` CLI. Mevcut `docs/reviews/<agent>/` cycle dosyaları (reference).

**Verification**:
- Test PR: fix commit'i `Closes:` trailer'sız → CI fail.
- Cron simülasyon: 30 gün önce OPEN finding → STALE escalation.

## Phase 7 — CODEOWNERS & Dependabot & rule-health telemetry

**Master plan eşlemesi**: Part D/E, W10-W11, BLOCKER-9.

**Deliverable**: Control-plane değişikliği (`.claude/**`, `.github/**`, allowlist'ler) CODEOWNERS-gated; Dependabot github-actions ecosystem weekly; rule-health report.

**Adımlar**:
1. `.github/CODEOWNERS` — `.claude/**` → `@okan`; `.github/manifests/**` → `@okan`; `.claude/allowlists/**` → `@okan`; `docs/adr/**` → `@okan` + `architectural-arbiter` reviewer etiketi (automated add via Action).
2. `.github/dependabot.yml` — github-actions ecosystem weekly (BLOCKER-9).
3. `.github/workflows/rule-health-report.yml` — monthly: override count, STALE finding count, agent dispatch frequency, rule firing rate → `docs/reviews/_reports/rule-health-YYYY-MM.md`.

**Critical files**:
- `.github/CODEOWNERS`
- `.github/dependabot.yml`
- `.github/workflows/rule-health-report.yml`

**Reuse**: Phase 6 finding-registry, Phase 2 gates.

**Verification**: Test PR `.claude/allowlists/boundary-files.yaml`'a entry ekler → CODEOWNERS `@okan` review zorunlu.

---

## Critical files — aggregate view

### Modify (Phase 0 + 1 + 5)
- `.claude/agents-enterprise-v2/orchestrator.md` (P0.2, P0.3, P1, P5)
- `.claude/agents-enterprise-v2/data-expert.md` (P0.3)
- `.claude/agents-enterprise-v2/messaging-expert.md` (P0.3)
- `.claude/agents-enterprise-v2/multi-tenant-saas-expert.md` (P0.3)
- `.claude/agents-enterprise-v2/_shared/handoff-protocol.md` (P0.3, P5)
- `.claude/agents-enterprise-v2/_shared/operating-modes.md` (P0.5 if applied)
- `.claude/agents-enterprise-v2/_shared/tier-claim-syntax.md` (P0.5 if applied)
- `.claude/knowledge/layer-1-react.md` (P0.4 — **CRITICAL**)
- `.claude/knowledge/layer-1-typeorm.md` (P0.4)
- `.claude/knowledge/layer-3-adrs.md` (P0.4)
- `CLAUDE.md` (P0.4 — service count)
- 10 unconverted agents (P1): security-reviewer, orchestrator, implementation-planner, frontend-expert, platform-services, hr-expert, database-reviewer, context-manager, admin-expert, prompt-writer
- `.claude/settings.json` (P0.1)
- `package.json` (P2 — engines.node, ts-morph)
- `.eslintrc.json` (P2 — custom rule plugin wire-up)

### Create (Phase 1-7)
- `.claude/agents.legacy/` (P0.1 — archive move)
- `.claude/agents.legacy/README.md` (P0.1)
- `.claude/agents-enterprise-v2/_shared/orchestrator-phases.md` (P1, extraction)
- `.claude/agents-enterprise-v2/root-cause-auditor.md` (P5)
- `.claude/skills/*` (P3 — 8 skill files + README)
- `tools/gates/*.ts` (P2 — 5 gates)
- `tools/eslint-rules/*.ts` (P2 — 3 rules)
- `tools/ripple-tracer/*.ts` (P3)
- `tests/invariants/*.spec.ts` (P4 — 5 invariants)
- `docs/reviews/_registry/findings.jsonl` + schema (P6)
- `.github/workflows/quality-gates.yml` (P2)
- `.github/workflows/finding-state-sweep.yml` (P6)
- `.github/workflows/closes-footer-check.yml` (P6)
- `.github/workflows/rule-health-report.yml` (P7)
- `.github/CODEOWNERS` additions (P7)
- `.github/dependabot.yml` (P7)
- `.husky/pre-commit` (P2 — v8 style)

## Reused (DO NOT recreate — reference in place)

- `/root/.claude/plans/declarative-riding-shamir.md` (master plan — bu plan onun üstüne çalışır; W0-W14 sequencing, BLOCKER-1 through BLOCKER-20 ID'leri authoritative)
- `.claude/knowledge/layer-1-{core,nestjs,typeorm,react,rust}.md` + `layer-2-patterns.md` + `layer-3-adrs.md` (SSoT; sadece P0.4 düzeltmeleri)
- `.claude/agents-enterprise-v2/_shared/{operating-modes,tier-claim-syntax,handoff-protocol,output-format,_conversion-template}.md`
- `.claude/allowlists/boundary-files.yaml` (19 entry, doğru seviyede)
- `tests/invariants/_constants.ts` (`SCHEMA_OWNING_SERVICES`, `PER_TENANT_SCHEMA_SERVICES` — BLOCKER-8 landed)
- `tests/invariants/adoption-invariants.spec.ts` (pattern for P4)
- `e2e/tests/integration/{schema,nats}-invariants.spec.ts` (pattern for P4)
- `libs/backend-common/src/database/schema-manager.service.ts` (`MODULE_SCHEMAS` SSoT)
- `libs/event-contracts/src/{base-event,upcasters/}.ts` (skill P3 prototype)
- `tools/scripts/database/backup-databases.sh` (P3 run-migration-prod skill consumer)
- `.github/CODEOWNERS` (mevcut baseline; P7 ekleme)
- `.eslintrc.json` `no-restricted-syntax` kuralları (P2 pattern)

## Verification (end-to-end)

**Her phase sonunda koşacak gate dizini**:
1. `nx affected --target=test --target=lint` green.
2. `nx run tests-invariants:test` green (P4'ten sonra 5 yeni invariant + mevcut 3).
3. `.husky/pre-commit` test PR (banned phrase + missing Closes: footer + tier-4 claim on apps/**) → fail zinciri.
4. CI `quality-gates.yml` yeşil patika.
5. Agent dispatch smoke: `Agent(orchestrator, "Review current branch")` → Phase 1-5 (+4.5 P5'ten sonra) çalışır, unified report üretir, Closes: trailer'lar finding-registry'ye append edilir.
6. Full review drill: 1 deliberately-broken PR (SSoT drift + ownership ambiguity + phantom reference + missing schema:) → orchestrator tüm kategoriyi yakalamalı. Kıyas: Phase 0 öncesi bu PR %60'ı kaçırırdı.

**Tamamlanmış sistem için başarı kriterleri**:
- `grep -rn "W5\|W7\|W10 deliverable\|not yet built" .claude/agents-enterprise-v2/ .claude/knowledge/` → 0 match (tüm phantom referanslar gerçeğe bağlı)
- `wc -l .claude/agents-enterprise-v2/*.md` → hepsi ≤200
- `ls .claude/agents/` → NOT EXISTS (archived)
- `Agent(data-expert, mode=teacher, "how to add priority field")` → doğru parametre sıralı `createTenantQueryKey` örneği + `add-entity-field` skill recommendation
- Bir enterprise-grade PR review hatasız koşar, `Closes:` footer doğrulanır, finding registry state-transition'ı uygular, auditor Tier-claim'i verify eder
- 30 gün sonra: `rule-health-report.yml` output override count düşük, STALE finding yok, 22+ agent dispatch'de stabil latency

## Rollout tahmini

- Phase 0 (SİSTEM BOZAN): **1 hafta** (paralelde 5 sub-phase)
- Phase 1 (W3 conversion): 1-1.5 hafta (10 agent, 2-3/gün)
- Phase 2 (tools/gates): 1.5-2 hafta (6 gate + 3 eslint-rule + husky + CI wire)
- Phase 3 (skills): 2 hafta (8 skill + ripple-tracer)
- Phase 4 (invariants): 0.5-1 hafta (5 test)
- Phase 5 (root-cause-auditor): 0.5 hafta
- Phase 6 (registry): 1 hafta
- Phase 7 (CODEOWNERS + rule-health): 0.5 hafta

**Toplam**: ~8-9 hafta enterprise-grade execution. Phase 0 ilk haftada kritik, sonrası kabaca master plan W4-W10 ile örtüşür.

## Kararlar (onaylandı 2026-04-16)

1. **Dizin konsolidasyonu**: `.claude/agents/` → `.claude/agents.legacy/` archive + README tombstone. ✅ onaylandı
2. **Phantom yaklaşımı**: TAM İNŞA. Phase 0.5 atlanır; Phase 2-7 tüm altyapı (tools/gates, .claude/skills, finding registry, root-cause-auditor, invariant testleri) gerçekten inşa edilir. ~8-9 hafta. ✅ onaylandı

## Execution kararları (rollout sırasında)

3. **Node engine bump** (`>= 22.6.0`): BLOCKER-5'e göre zorunlu; prod deploy runtime'larını Phase 2 başında doğrula.
4. **Rollout sequencing**: Phase 1 (conversion) ↔ Phase 2 (gates) paralelde gider. Phase 1 daha lean context, Phase 2 daha mühendislik-yoğun — farklı session'larda ayrı ayrı koşabilir.
5. **Finding registry seed**: W1 audit bulgularını `docs/reviews/_audit/2026-04-W16-*.md` dosyalarından yükle (authoritative kaynak). Phase 6 ilk action'u.

---

# BÖLÜM III — KAPSAM GENİŞLETMESİ (Post-Audit Gap Realization)

## Context

Bölüm I-II enterprise-v2 agent sisteminin **operasyonel altyapısını** kurdu. 2026-04-16 post-audit review'da kullanıcı bunun yeterli olmadığını belirtti — gerçek endişe: **bug-hunting derinliği, stack-specific coverage, cross-cutting discipline, scale mimarisi, K8s-day-one hazırlığı**.

Üç paralel Explore agent taraması (2026-04-16 post-audit) somut boşlukları tespit etti:
- **Stack-depth**: 10 alan (TimescaleDB hypertable aggregate selection, GraphQL Federation 2 `@key`/`@extends` adoption, GraphQL codegen orphan file, TanStack bare queryKey epidemic, Redis Lua atomicity, Stripe webhook DB-side dedup, Claude SDK prompt caching + streaming backpressure, NATS JetStream consumer lag, Tokio CancellationToken migration, Prometheus metric cardinality)
- **Cross-cutting disciplines**: 15 yeni agent + 4 test-agents promotion gerekiyor (performance, observability, compliance GDPR/SOC2, supply-chain, AI-safety, chaos, contract-parity, cost-auditing)
- **Orchestration scale + K8s readiness**: registry multi-writer race, orchestrator leader-election yok, agent dispatch metrics + rate-limit yok, invariant suite performance, test-agents lane integration eksik, Docker image reproducibility yok

Bölüm III bu 3 boyutu 7 yeni phase'e organize eder (Phase 8-14). Toplam eklenen süre: **~11 hafta** (paralelleştirilebilir, 2 session'la ~7 hafta). Önceki tahminle (Bölüm II ~8-9 hafta) + bu bölüm = **~18-20 hafta** tek session; **~12-15 hafta** 2 paralel session ile.

## Yapı

- **Phase 8 — Stack-depth knowledge + targeted fixes** (HIGH/CRITICAL): 10 alana karşılık gelen layer-1 extension'ları, dedicated layer-1-timescaledb.md + layer-1-ai.md shard'ları, mass migration gerektirenlere (GraphQL codegen, TanStack queryKey) dokunan fix commit'leri.
- **Phase 9 — Critical cross-cutting agents (P0 CRITICAL)** — 6 agent: compliance-expert (GDPR/SOC2/KVKK SSoT), gdpr-erasure-executor, ai-safety-auditor, legal-hold-auditor, audit-trail-completeness-auditor, tenant-cost-attribution-agent. Test-agents'tan 4 promote.
- **Phase 10 — High cross-cutting agents (P0 HIGH)** — 7 agent: performance-expert, observability-expert, supply-chain-auditor, contract-parity-enforcer, circuit-breaker-auditor, memory-leak-auditor, claude-api-auditor.
- **Phase 11 — platform-services agent'ını split** — billing-expert, observability-expert (Phase 10'dan buraya), alert-engine-expert, hydroponics → farm-expert. 7 domain tek agent'tan 4 agent'a dağılır.
- **Phase 12 — K8s-day-one readiness** — registry PostgreSQL migration, orchestrator leader-election + Redis cycle-state, agent dispatch metrics + rate-limit, Claude API 429 backpressure, per-tenant cost attribution pipeline.
- **Phase 13 — test-agents lane integration** — Phase 3.5 parallel lanes (code quality lane-A + product quality lane-B). 4 test-agents promotion (gdpr, soc2, tenant-isolation, contract-parity) Phase 9-10 kapsamında zaten; kalan 24 test-agent'ın orchestrator dispatch'ini tanımla.
- **Phase 14 — Developer ergonomics + Docker tooling** — npm scripts (`review:*`, `audit:*`, `findings:*`), `Dockerfile.agent-tooling`, CLI runner scripts, invariant suite jest projects sharding (44s → <10s).

Her phase için: **motivation**, **deliverable**, **critical files create/modify**, **reuse pointers**, **verification**, **severity rationale**.

---

## Phase 8 — Stack-depth knowledge + targeted fixes

**Motivation**: agent sisteminin STACK'in gerçek derinliğini tanımaması mimari bug-hunting kalitesini sınırlıyor. 10 tespit edilen boşluk hem knowledge layer hem de domain agent invariant'larıyla kapatılır.

**Deliverable**: 2 yeni knowledge shard + 7 mevcut agent invariant genişletmesi + 2 mass migration fix PR + 3 yeni ESLint custom rule.

### 8.1 Yeni knowledge shard'lar

- `.claude/knowledge/layer-1-timescaledb.md` (yeni, ~80 satır): hypertable chunk_time_interval selection, continuous aggregate refresh policy, compression_after, retention chunk-boundary semantics, aggregate-selection rule (query time-range → preferred aggregate table), per-hypertable row-count + compression ratio SLO. Sensor-service + alert-engine + audit-log hypertable'lar için canonical referans.
- `.claude/knowledge/layer-1-ai.md` (yeni, ~90 satır): Anthropic SDK patterns — prompt caching (`cache_control` header semantics, 5min TTL, beta 24h TTL), streaming backpressure (64KB in-flight buffer cap), `usage` response field discipline (`input_tokens + cache_read_input_tokens + cache_creation_input_tokens` total calc), tool-use loops + tool whitelist + output PII scrub, per-tenant token budget reservation pattern, context window budgeting.

### 8.2 Mevcut knowledge shard extensions

- `layer-1-nestjs.md`: yeni section "GraphQL Federation 2 subgraph discipline" — `@key(fields: "id")` mandatory on every federated entity, `@extends` + reference resolver + DataLoader.load discipline, gateway depth/complexity gate logs, subgraph introspection validation invariant.
- `layer-1-nestjs.md`: yeni section "Redis usage patterns" — rate limit MUST use atomic Lua or SET NX EX; 3 pattern guide (rate-limit sorted-set ZCOUNT+ZADD, pub/sub atomic broadcast, queue LPUSH/BLPOP); fail-CLOSED on ping error mandatory.
- `layer-1-nestjs.md`: yeni section "NATS JetStream consumer config" — MaxDeliver=3, AckWait=30s, MaxAckPending=100 defaults; services.yaml override protocol; consumer lag Prometheus histogram mandatory; nack-rate alerting.
- `layer-1-rust.md`: CancellationToken migration timeline — `shutdown.rs` broadcast→`CancellationToken + TaskTracker` (EDGE-MEDIUM kapanış); `tokio::spawn` discipline: every spawn either child-token subscriber OR TaskTracker.register_task'a bağlı.
- `layer-1-react.md`: Apollo codegen orphan RESOLUTION section — `codegen.ts` + `typed-document-node` migration, `no-bare-graphql-query-string` ESLint rule, `web/shared-ui/src/generated/graphql-types.ts` CI invariant.
- `layer-1-react.md`: TanStack Query bare queryKey epidemic count — `createTenantQueryKey` adoption 13/265+ with path-level inventory.

### 8.3 Agent invariant extensions

- `data-expert.md`: yeni kural block "TimescaleDB hypertable discipline" — aggregate table selection rule (per query time-range), `time_bucket` discipline, retention policy invariant; `migration-sql-lint.ts` (Phase 2) bu invariant'ı enforce eder.
- `messaging-expert.md` (or new `ai-safety-expert`): yeni kural block "Anthropic SDK patterns" — cache_control adoption metric, streaming backpressure unbounded-buffer ban, tool-use output PII filter mandatory.
- `auth-security-expert.md`: yeni kural block "Redis fail-closed on ping error" — no in-memory Map fallback; MT-CRITICAL-002 regression guard reinforcement.
- `platform-kernel-expert.md` or new `observability-expert`: "Prometheus metric cardinality policy" — label budget per metric family, `tenant_id` label forbidden on HTTP/scrape metrics, histogram bucket standardization.
- `edge-expert.md`: "NATS consumer lag" not applicable (edge is producer); but Tokio cancellation migration timeline codified into active findings.

### 8.4 Mass migration fix PRs (cross-cutting discipline)

- **GraphQL codegen orphan resolution** (FE-CRITICAL level): single PR that (a) runs codegen, (b) generates `web/shared-ui/src/generated/graphql-types.ts`, (c) migrates top-10 highest-hit `any`/`as any` queries to typed-document-node, (d) adds `no-bare-graphql-query-string` ESLint rule, (e) adds CI gate asserting generated file exists + no drift. Closes **P0-critical phantom + FE-CRITICAL-001**.
- **TanStack Query bare queryKey migration** (FE-CRITICAL): mass migration across 265+ call sites → `createTenantQueryKey(tenantId, ...segments)`. ESLint rule `no-bare-tenant-query-key` (Phase 2 deliverable) CI-lock. farm-module önce, sonra sensor-module, hr-module, admin-panel, tenant-admin, hydroponics-module.
- **Stripe webhook DB-side dedup** (MEDIUM): migration adding `billing.stripe_webhook_events(event_id UUID PK, received_at, processed_at, status, result JSONB)` table + handler update to dedup post-Redis-TTL replays.

### 8.5 Custom ESLint rules (coordinate with Phase 2)

Phase 2 gate infrastructure `tools/eslint-rules/` altına eklenecek:
1. `no-bare-graphql-query-string.ts` — mandates typed-document-node
2. `no-bare-tenant-query-key.ts` — mandates `createTenantQueryKey`
3. `no-high-cardinality-metric-label.ts` — `tenant_id`/`user_id`/`request_id` as Prom label forbidden
4. `require-entity-schema.ts` (already in Phase 2 list, BLOCKER-8)
5. `no-direct-event-publish.ts` (already in Phase 2 list)
6. `no-claude-sdk-raw-call.ts` — Anthropic API calls must go through `anthropicClient` wrapper with token-budget check

**Critical files (modify)**:
- `.claude/knowledge/layer-1-timescaledb.md` (new)
- `.claude/knowledge/layer-1-ai.md` (new)
- `.claude/knowledge/layer-1-nestjs.md`, `layer-1-react.md`, `layer-1-rust.md` (extend)
- `.claude/agents-enterprise-v2/data-expert.md`, `messaging-expert.md`, `auth-security-expert.md`, `edge-expert.md`, `platform-kernel-expert.md` (extend — waits for Phase 1 conversion of un-converted agents)
- `codegen.ts` (activate)
- `web/shared-ui/src/generated/graphql-types.ts` (generate)
- `web/modules/**/*.ts` (mass migration — 265+ queryKey + 246 `any`/`as any`)
- `database/migrations/modules/billing/Vxxx__add_stripe_webhook_events.sql` (new)
- `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts` (add DB dedup)
- `tools/eslint-rules/*.ts` (6 custom rules, Phase 2 deliverable scope)

**Reuse**:
- `libs/event-contracts/src/upcasters/` — pattern for chain integrity
- `@tanstack/react-query` v5 invalidateQueries API
- Stripe `stripe_webhook_events` pattern (sample migration from multi-tenant-saas-expert reference)

**Verification**:
- `nx run web-shell:build` green after codegen
- `grep -r "queryKey: \[" web/modules/ | wc -l` → 0 after mass migration
- `grep -r "as any" web/modules/ | wc -l` → baseline 246 → target ≤20 (boundary-allowlist entries only)
- Stripe webhook integration test: replay event_id after 72h TTL → DB dedup catches

**Severity**: CRITICAL (FE-CRITICAL cross-tenant cache bleed active) + HIGH (codegen orphan, type safety erosion).

**Estimated duration**: 1-1.5 hafta (knowledge + invariant extensions paralel; mass migrations 2-3 gün heavy refactor).

---

## Phase 9 — Critical cross-cutting agents (P0 CRITICAL)

**Motivation**: GDPR Art 17/20 cascade, SOC 2 evidence, AI safety, audit trail completeness, cost attribution — hiçbirinin single-source agent sahibi yok. Compliance posture production için blocker.

**Deliverable**: 6 yeni / promote agent — `compliance-expert`, `gdpr-erasure-executor`, `ai-safety-auditor`, `legal-hold-auditor`, `audit-trail-completeness-auditor`, `tenant-cost-attribution-agent`.

### 9.1 `compliance-expert.md` (YENİ, CRITICAL)

Test-agents'tan `gdpr-compliance-auditor` + `soc2-readiness-auditor` içeriklerini ABSORBER ederek enterprise-v2 runtime roster'a katılır.

**Primary Ownership**:
- `libs/backend-common/src/gdpr/**` (yeni, erasure + portability handlers shell)
- Cross-service: `apps/*/src/gdpr/` erasure handlers (10 services: farm, sensor, hr, messaging, ai, billing, notification, admin-api, auth — optional event-store)
- `docs/compliance/**` (yeni dir, GDPR/KVKK/SOC2 evidence)

**Domain invariants**:
1. Every service in `PER_TENANT_SCHEMA_SERVICES + billing + notification + messaging` exposes `eraseTenantData(tenantId, { dryRun })` handler. Fan-out via `TenantErased` event. Missing any = CRITICAL (MT-CRITICAL-003 closer).
2. Export format: NDJSON + ZIP for bulk, JSON for small; proprietary binary = HIGH non-compliance.
3. Signed URL TTL ≤ 7 days (24h default sensitive); URLs NEVER logged plaintext; path derived from JWT claim only.
4. Crypto-shred for immutable stores (events): per-subject key + deletion removes capability.
5. Dual consent (AI use case): `TenantAiSetting.aiEnabled` AND `UserAiConsent.granted` checked before every AI callsite; cache TTL ≤ 60s + explicit invalidation on withdrawal.
6. SOC 2 control evidence auto-collected: access logs, change management trail, incident MTTR, backup restore rehearsal cadence, encryption-at-rest-and-transit evidence.

**Severity**: GDPR erasure cascade missing = CRITICAL; SOC 2 evidence absent = HIGH (production Q2 2026 audit gate).

### 9.2 `gdpr-erasure-executor.md` (YENİ, CRITICAL)

Sadece EXECUTION agent — compliance-expert REVIEW yapar, bu agent gerçek kod yazar (WRITER mode on demand, explicit `implement:` token).

**Primary Ownership**: per-service `erase-tenant-data.handler.ts` (10 services).

**Domain invariants**:
1. Legal-hold precedence check MANDATORY before any delete.
2. Deletion cascade order: transaction outbox drain → messaging anonymization → sensor/farm/hr row deletes → ai conversation shred → billing Stripe subscription void verification → schema DROP.
3. Proof-of-erasure hash-signed event `TenantErased { tenantIdHash, purgedAt, operatorId, schemaDropped, stripeSubscriptionVoided }`.
4. Idempotency: re-invocation on same tenantId returns current state without re-deletion.
5. Dry-run mode returns full effect plan without side effects; used by audit before real execution.

**Severity**: CRITICAL (GDPR Art 17 compliance deadline).

### 9.3 `ai-safety-auditor.md` (YENİ, promote `ai-tool-execution-auditor` from test-agents)

**Primary Ownership**:
- `apps/ai-service/src/**` (ownership shared with messaging-expert — delegated from)
- `libs/backend-common/src/ai/safety/**` (yeni, tool whitelist + output filter + prompt guard)
- `.claude/knowledge/layer-1-ai.md` (Phase 8.1 deliverable)

**Domain invariants**:
1. Prompt injection defense: jailbreak regex + RAG output sanitization + tool-output re-validation before next turn.
2. Tool whitelist per tenant + per agent persona; cross-tenant tool execution = CRITICAL.
3. Output PII scrub: NER model (integrated) + regex fallback; PII leakage to chat = CRITICAL.
4. Prompt caching adoption: `cache_control` header on system prompts + large RAG contexts; `cache_creation_input_tokens` response field tracked per conversation.
5. Streaming backpressure: 64KB in-flight buffer cap; slow consumer → pause stream, not buffer unbounded.
6. Context window budgeting: messages array token-count pre-computed via SDK token counter; `max_tokens` dynamic based on remaining.
7. Cost cap reservation: `max_tokens × model_price` deducted from `tenant.tokenBudget` BEFORE API call; post-call reconciliation with actual `usage` response.

**Severity**: CRITICAL (cost runaway vector + prompt injection data exfil).

### 9.4 `legal-hold-auditor.md` (YENİ, CRITICAL cross-service)

**Primary Ownership**: cross-cutting — hangi service'de delete/anonymize/retention-expiry action varsa hepsi.

**Domain invariants**:
1. `compliance_audit_log.legal_hold` precedence on EVERY destructive action (retention cleanup, manual delete, partition DROP, GDPR anonymize, outbox GC).
2. Legal hold = true blocks action; audit log row required even on block.
3. Hold state propagation via NATS event `LegalHoldApplied/Released` fan-out to all tenant-data services.
4. Hold TTL enforcement: indefinite holds allowed; scheduled holds auto-release on deadline + emit `LegalHoldExpired` event.
5. Hold override protocol: SUPER_ADMIN + MFA step-up + dual audit record.

**Severity**: CRITICAL (litigation risk, discovery compliance).

### 9.5 `audit-trail-completeness-auditor.md` (YENİ, CRITICAL)

**Primary Ownership**:
- `libs/backend-common/src/audit/**` (exists)
- Cross-service: every command handler, every destructive action

**Domain invariants**:
1. Every COMMAND handler emits audit log row (auto via `@AuditedOperation` decorator); unaudited command = HIGH.
2. Audit row required fields: actor_user_id, actor_home_tenant_id, acted_on_tenant_id (for impersonation), resource_{type,id}, action, method, ip, user_agent, request_id, mfa_verified, result, pre_state_hash, post_state_hash.
3. Dual-identity audit on impersonation MANDATORY (actor ≠ acted-on tenant).
4. `recordAwait()` is synchronous; fire-and-forget audit = CRITICAL (partial log loss).
5. Audit log immutable: append-only table, no UPDATE allowed (DB-level CHECK or trigger).
6. Retention: tier-4 storage (compressed, TimescaleDB hypertable) + 7-year minimum (SOC 2 alignment).

**Severity**: CRITICAL (SOC 2 CC4 + GDPR Art 30 records of processing compliance).

### 9.6 `tenant-cost-attribution-agent.md` (YENİ, CRITICAL — business)

**Primary Ownership**:
- Prometheus metric emission (cost-labeled metrics — `compute_cost_dollars_total`, `db_query_dollars_total`, `storage_bytes_tenant`, `claude_tokens_tenant_total`, `stripe_events_processed_tenant_total`)
- Per-tenant cost attribution pipeline (observability-service → cost-aggregator)

**Domain invariants**:
1. Every expensive resource usage (DB query p99, Claude API call, S3 egress, NATS message volume) attributed with `tenant_id` label via LOW-CARDINALITY bucket (plan tier, not tenantId itself).
2. Cost budget alerts per plan tier: Starter > $100/mo, Professional > $500/mo, Enterprise > $2000/mo trigger tenant-admin notification.
3. Plan-level margin monitoring: compute cost per tenant / plan revenue ratio < 0.3 SLO.
4. Cost explosion isolation: per-tenant circuit breaker on cost-exceeding operations (e.g., runaway AI conversation).
5. Monthly tenant cost reconciliation: Stripe invoice amount vs platform cost vs Claude spend.

**Severity**: CRITICAL (business — unaudited cost = margin death at scale).

**Critical files (create)**:
- `.claude/agents-enterprise-v2/compliance-expert.md` (new, ≤200 lines)
- `.claude/agents-enterprise-v2/gdpr-erasure-executor.md` (new)
- `.claude/agents-enterprise-v2/ai-safety-auditor.md` (new; promote test-agents content)
- `.claude/agents-enterprise-v2/legal-hold-auditor.md` (new)
- `.claude/agents-enterprise-v2/audit-trail-completeness-auditor.md` (new)
- `.claude/agents-enterprise-v2/tenant-cost-attribution-agent.md` (new)
- Orchestrator routing + runtime roster update (+6 entries)
- `docs/compliance/README.md` (new compliance evidence directory)

**Reuse**:
- `.claude/test-agents/gdpr-compliance-auditor.md` + `soc2-readiness-auditor.md` + `ai-tool-execution-auditor.md` — content promotion
- `libs/backend-common/src/audit/audit-log.interceptor.ts` (existing pattern)
- `multi-tenant-saas-expert.md` MT-CRITICAL-003 design (promote to executor spec)

**Verification**:
- Agent ownership uniqueness invariant (Phase 4) re-run → 0 conflicts after additions
- Orchestrator routing coverage (Phase 4) re-run → new agents in roster
- Dispatch smoke: `Agent(compliance-expert, "review tenant erasure fan-out across 10 services")` — expected finding set

**Estimated duration**: 2 hafta (6 agents; each ~1 day scaffold + research cycle).

---

## Phase 10 — High cross-cutting agents (P0 HIGH)

**Motivation**: Performance, observability, supply-chain, contract-parity, circuit-breaker, memory-leak, Claude API cost — bu disiplinler dağınık, single-authority agent yok. Agent sistemi bug-hunting derinliği için mandatory.

**Deliverable**: 7 yeni agent — `performance-expert`, `observability-expert`, `supply-chain-auditor`, `contract-parity-enforcer`, `circuit-breaker-auditor`, `memory-leak-auditor`, `claude-api-auditor`.

### 10.1 `performance-expert.md` (YENİ, HIGH)

**Primary Ownership**:
- All repositories + services (sahip-ekleme — read-only CATCHER)
- p99 latency SLO mapping: `infrastructure/monitoring/prometheus/slo-alerts.yml` consume
- Bundle size budget: `web/*/vite.config.ts` chunk size limits

**Domain invariants**:
1. Every new SQL query (migration + handler) ships with EXPLAIN plan evidence OR inline `// perf-ok: <justification>` comment + boundary-allowlist entry.
2. N+1 query detection: any `loop.forEach → repository.findOne` pattern = HIGH (use `In()` clause or DataLoader).
3. TimescaleDB hypertable queries: seq scan > 1M rows = HIGH; use continuous aggregate table per time-range rule (layer-1-timescaledb.md).
4. React bundle size budget: shell ≤ 500KB gzipped, each MFE ≤ 300KB; exceeded = HIGH (bundle analysis CI gate).
5. p99 latency budget per endpoint tier: tier-0 ≤ 100ms, tier-1 ≤ 500ms, tier-2 ≤ 2000ms; sustained violation = HIGH with runbook_url.
6. Memory footprint baseline: Node app heap after warmup ≤ 512MB; edge crate RSS ≤ 256MB. Growth > 20%/day = HIGH (memory-leak-auditor handoff).

**Severity**: HIGH (performance is a distributed bug class; this agent is the focal review point).

### 10.2 `observability-expert.md` (YENİ, HIGH — split from platform-services)

**Primary Ownership**:
- `apps/observability-service/**` (full)
- `infrastructure/monitoring/**` (prometheus, grafana, loki configs)
- Cross-service: every new metric/span/log pattern

**Domain invariants**:
1. Prometheus metric cardinality budget: HTTP family ≤ 10K series/service; business metrics ≤ 1K series; `tenant_id` label forbidden on HTTP/auth metrics, allowed on business-metric counters with WARN gate (>100 tenants → STALE cleanup).
2. OTEL span coverage: every HTTP handler + CQRS command handler + NATS consumer auto-instrumented; uninstrumented handler = HIGH (blind spot).
3. Loki label hygiene: `{app, namespace, container, level}` only; high-cardinality labels (`tenant_id`, `request_id`) forbidden.
4. Alert runbook_url MANDATORY on every alert rule; alert without runbook = HIGH (PagerDuty confusion).
5. RED metrics (Rate, Errors, Duration) per service + USE metrics (Utilization, Saturation, Errors) per resource. Missing = HIGH.
6. Dashboard ownership: every Grafana dashboard has `team:<name>` + `refresh:<cadence>` tags; orphan dashboard = MEDIUM.

**Severity**: HIGH (observability gaps mask production incidents).

### 10.3 `supply-chain-auditor.md` (YENİ, HIGH — split from infra-expert)

**Primary Ownership**:
- `package.json`, `package-lock.json` (root)
- `.github/dependabot.yml` + dependency update PRs
- Docker image base + layer scanning
- `Cargo.lock` (edge crate)

**Domain invariants**:
1. `npm audit --production --audit-level=high` green on every PR. CI gate blocks.
2. Transitive vulnerability triage SLA: HIGH severity CVE → 7-day fix; CRITICAL → 48h hotfix.
3. License compliance: no GPL-3.0/AGPL-3.0 in production paths (allowlist: `.claude/allowlists/license-allow.yaml`).
4. Docker base image CVE scan: Trivy/Grype HIGH or CRITICAL fails build; exceptions via allowlist with expiry.
5. SLSA provenance attestations: every CI-produced artifact signed + attestation uploaded (planned for W13 per master plan; pre-work here).
6. `--ignore-scripts` mandatory on every `npm ci` invocation (prevents install-hook supply chain attacks per ua-parser-js incident class).

**Severity**: HIGH (supply chain is the #1 attack vector in 2024/2025).

### 10.4 `contract-parity-enforcer.md` (YENİ, HIGH — promote from test-agents)

**Primary Ownership**:
- OpenAPI specs (create at `infra/openapi/` if missing)
- GraphQL subgraph schemas
- `sensorprotocols/*.md` ↔ Rust adapter contracts
- Event contract consumer drift

**Domain invariants**:
1. OpenAPI spec MUST match actual route topology — drift detector: introspect NestJS Router metadata + compare to `infra/openapi/<service>.yaml`.
2. GraphQL subgraph schema ↔ resolver coverage: every `@Resolver` method has corresponding schema entry; missing = HIGH (runtime 500).
3. sensorprotocols/*.md ↔ Rust adapter: protocol doc MUST be in sync with adapter behaviour (register map, frame structure). CI test reads doc + adapter + compares.
4. Event contract version bumps: consumer services MUST have upcaster or feature flag; producer-only bump = CRITICAL.
5. Pact/Schemathesis adoption (post-V1 per DATA-DEFERRED AUDIT-PACT-001): when reopened, this agent is the primary.

**Severity**: HIGH (contract drift = runtime 500 in production).

### 10.5 `circuit-breaker-auditor.md` (YENİ, HIGH)

**Primary Ownership**:
- `libs/backend-common/src/circuit-breaker/**` (new or existing — grep check)
- Cross-service: every external-dependency call (Stripe, SendGrid, Claude, MinIO, NATS if used as external)

**Domain invariants**:
1. Every external API call wrapped in circuit breaker with `(service, operation)` key; missing = HIGH.
2. Per-tenant circuit breaker for tenant-isolated expensive operations (e.g., AI, large-file upload); global-only = HIGH (one tenant trips all).
3. Breaker config: failure threshold 50%, reset timeout 30s, half-open probe 1/s. Config drift = MEDIUM.
4. Breaker open state emits structured event; no event = HIGH (incident blind spot).
5. Fallback discipline: fail-closed for billable/auth; fail-open-with-degraded-mode for non-critical (e.g., recommendation engine fallback to heuristic).

**Severity**: HIGH (cascading failures in microservice architecture without breakers).

### 10.6 `memory-leak-auditor.md` (YENİ, HIGH)

**Primary Ownership**:
- Cross-cutting — every long-running service + edge crate.

**Domain invariants**:
1. Heap growth > 20%/day post-warmup = HIGH; scheduled `node --inspect` + heapdump triage.
2. Event listener leaks: unbounded `.on()` registration + no `.off()` on unmount = HIGH.
3. Cache TTL discipline: unbounded Map/WeakMap as cache = HIGH unless WeakRef-based.
4. WebSocket connection leaks: orphan `ws.on('close', null)` = HIGH.
5. Rust edge: every `tokio::spawn` either TaskTracker-registered or CancellationToken-bound (duplicate of edge-expert invariant, enforced here cross-stack).

**Severity**: HIGH (leaks are silent production killers).

### 10.7 `claude-api-auditor.md` (YENİ, HIGH)

**Primary Ownership**:
- `apps/ai-service/**` (shared with ai-safety-auditor; delegated on cost concerns)

**Domain invariants**:
1. Token budget reservation BEFORE API call: `max_tokens × model_price` deducted from `tenant.tokenBudget`; post-call reconciliation.
2. Prompt caching adoption: `cache_control: { type: 'ephemeral' }` on system prompts ≥ 1024 tokens; adoption rate target ≥ 80%.
3. Streaming backpressure: consumer write rate < producer chunk rate → pause upstream; unbounded buffer = CRITICAL.
4. Model selection discipline: Haiku for classification, Sonnet for routine, Opus only for long-context complex reasoning; Opus on short prompt = waste.
5. Tool-use loop bound: max 10 tool calls per conversation turn; infinite loop = CRITICAL (cost explosion).

**Severity**: HIGH (cost + reliability).

**Critical files (create)**:
- `.claude/agents-enterprise-v2/performance-expert.md`
- `.claude/agents-enterprise-v2/observability-expert.md`
- `.claude/agents-enterprise-v2/supply-chain-auditor.md`
- `.claude/agents-enterprise-v2/contract-parity-enforcer.md`
- `.claude/agents-enterprise-v2/circuit-breaker-auditor.md`
- `.claude/agents-enterprise-v2/memory-leak-auditor.md`
- `.claude/agents-enterprise-v2/claude-api-auditor.md`
- Orchestrator routing + runtime roster update (+7 entries)

**Reuse**:
- `.claude/test-agents/contract-parity-auditor.md` — content promotion
- `infrastructure/monitoring/prometheus/slo-alerts.yml` — SLO data source
- `libs/backend-common/src/metrics/metrics.service.ts` — metric pattern

**Verification**: invariant test re-run; agent ownership uniqueness; dispatch smoke (`Agent(performance-expert, ...)`).

**Estimated duration**: 2 hafta (7 agents + integration).

---

## Phase 11 — platform-services agent split

**Motivation**: `platform-services.md` 7 farklı domain'i sırtlıyor (billing + notification + config + event-store + observability + alert-engine + hydroponics). Her biri ayrı uzmanlık. Split edilmeli.

**Deliverable**:
- `billing-expert.md` (yeni) — Stripe webhook, metered billing, subscription saga, invoice reconciliation, plan-tier enforcement delegate with multi-tenant-saas-expert.
- `observability-expert.md` (Phase 10.2'den taşınır; burada netleşir) — observability-service'in full sahibi.
- `alert-engine-expert.md` (yeni) — rule evaluation performance, per-tenant alert rate-limit, escalation ladder.
- `hydroponics → farm-expert` altına taşınır — aquaculture domain content'i zaten farm-expert'te, hydroponics ayrı değil ama integrate edilir.
- `platform-services.md` deprecate edilir (README tombstone + glob redirection).

**Critical files**:
- `.claude/agents-enterprise-v2/billing-expert.md` (new)
- `.claude/agents-enterprise-v2/alert-engine-expert.md` (new)
- `.claude/agents-enterprise-v2/farm-expert.md` (extend — hydroponics integration)
- `.claude/agents-enterprise-v2/platform-services.md` (DEPRECATED tombstone)
- Orchestrator routing — `apps/billing-service/**`, `apps/alert-engine/**`, `apps/hydroponics-service/**`, `apps/event-store-service/**`, `apps/notification-service/**`, `apps/config-service/**` yeni primary atamaları
- Runtime roster update

**Reuse**: mevcut `platform-services.md` content'i ayrıştırılır ve 3 yeni dosyaya dağıtılır.

**Verification**: orchestrator routing invariant re-run; agent ownership uniqueness; `platform-services.md` artık runtime dispatch almaz.

**Estimated duration**: 1 hafta (refactor + content redistribution).

---

## Phase 12 — K8s-day-one readiness (orchestration scale)

**Motivation**: Şu an Docker-only; K8s'e geçerken agent sistemi multi-pod-safe değil. Registry write race, orchestrator leader-election, metrics + rate-limit — P0 blockers.

**Deliverable**:
1. Registry PostgreSQL backend (jsonl → event-store schema table)
2. Orchestrator Redis cycle-state + leader-election
3. Agent dispatch Prometheus metrics endpoint
4. Claude API 429 backpressure + per-cycle budget
5. Per-tenant cost attribution pipeline (feed tenant-cost-attribution-agent — Phase 9.6)

### 12.1 Registry PostgreSQL migration

- Migration: `event-store` schema'sına `findings` table (immutable, append-only, hash-chained, advisory-lock write).
- `tools/gates/finding-registry.ts` CLI (Phase 2 deliverable tam burada lands): add / transition / sweep / verify / export-jsonl (backward compat).
- `docs/reviews/_registry/findings.jsonl` → tombstone + export-only path.
- Invariant: `tests/invariants/three-store-invariants.spec.ts` (Phase 4 kalan 1 invariant): registry table ↔ commit trailer ↔ review file 3-way hash consistency.

### 12.2 Orchestrator Redis cycle-state + leader-election

- Redis keys: `orchestrator:cycle:{cycle_id}:state` (hash), `orchestrator:leader-lease` (30s TTL), `orchestrator:dispatch-budget:{tenant_id}:{cycle_id}` (atomic INCR Lua).
- Leader election: Redis `SET key value NX EX 30` (Redlock-lite for single cluster; etcd if multi-cluster).
- Cycle-state log: append-only list `orchestrator:cycle:{cycle_id}:events` — every dispatch/finding/compaction event.
- Non-leader pods: observer mode (read cycle state, serve read APIs, do not emit new cycles).

### 12.3 Agent dispatch Prometheus metrics

- Counter: `agent_dispatch_total{agent, mode, cycle_id}`, `agent_finding_issued_total{severity, agent}`, `claude_api_call_total{model}`, `claude_api_rate_limit_hit_total`.
- Histogram: `review_cycle_duration_seconds`, `agent_dispatch_latency_seconds{agent}`.
- Gauge: `orchestrator_cycle_in_flight`, `orchestrator_leader_pod_id` (label).
- Endpoint: new microservice `apps/orchestrator-metrics-exporter/` scraped at `:9090/metrics`.

### 12.4 Claude API 429 backpressure

- Token bucket per-cycle: `budget.remaining -= estimated_cost_before_call`.
- On 429: exponential backoff + queue next cycle's dispatch; no retry-in-loop.
- Emergency stop: `claude_api_rate_limit_hit_total > threshold` → leader transitions cycle to FROZEN state, emits `ReviewCycleFrozen` event.

### 12.5 Per-tenant cost attribution pipeline

- observability-service aggregates per-tenant cost metrics hourly → `tenant_cost_rollup` TimescaleDB table.
- tenant-cost-attribution-agent (Phase 9.6) reads rollup + Stripe invoice to produce monthly reconciliation report.
- Cost explosion alert: per-tenant > plan-tier budget × 1.5 → auto-disable non-critical (AI, bulk ops) + notify tenant-admin.

**Critical files (create)**:
- `apps/event-store-service/src/database/migrations/Vxxx__add_findings_table.sql`
- `libs/backend-common/src/finding-registry/**` (new lib)
- `tools/gates/finding-registry.ts` (full CLI)
- `apps/orchestrator-metrics-exporter/**` (new service) OR integrate into `observability-service`
- `.github/workflows/finding-state-sweep.yml` (Phase 6 deferred deliverable)

**Reuse**:
- Phase 6 `docs/reviews/_registry/findings.jsonl` + schema.json — migration source
- Phase 6 `tools/scripts/validate-closes-footer.mjs` — CI gate extended to PG backend
- Redis pattern from auth-security-expert domain

**Verification**:
- Integration test: 3 concurrent orchestrator pods compete for leader-lease → exactly 1 leader at any time.
- Finding append concurrency test: 10 parallel finding inserts → hash chain remains valid.
- K8s smoke: deploy orchestrator + observability + postgres + redis → finding append + cycle dispatch works end-to-end.

**Severity**: BLOCKER for K8s day-one.

**Estimated duration**: 3 hafta (engineering-intensive — migration, PG schema, Redis primitives, metrics exporter, K8s integration test).

---

## Phase 13 — test-agents lane integration (parallel orchestrator lanes)

**Motivation**: `.claude/test-agents/` 28 product-E2E auditor runtime roster'a entegre değil. Enterprise-v2 code quality + test-agents product quality iki paralel akış olarak koşmalı.

**Deliverable**: orchestrator Phase 2 parallel lanes.

### 13.1 Orchestrator Phase 2 parallel lanes

- **Lane-A (code quality)**: mevcut enterprise-v2 dispatch — data-expert, security, compliance, performance, domain experts.
- **Lane-B (product quality)**: test-agents dispatch — ui-action-mapper, button-action-auditor, table-grid-auditor, chart-widget-auditor, form-write-auditor, list-visibility-auditor, realtime-sync-auditor, mobile-app-auditor, accessibility-auditor, webhook-ingress-auditor, workflow-state-auditor, job-queue-auditor, access-boundary-auditor, data-readback-auditor, file-transfer-auditor, billing-reconciliation-auditor, edge-industrial-auditor, gdpr-compliance-auditor (if not promoted to Phase 9.1).
- Phase 3.5 compaction CROSS-LANE: code finding + product finding on same surface → single root-cause consolidation.
- Phase 5 unified report: lane-A + lane-B bölünmüş bölüm.

### 13.2 test-agents'ın 4 kritik promotion'ı zaten tamamlandı

Phase 9'da:
- `gdpr-compliance-auditor` → `compliance-expert` içine absorbed
- `soc2-readiness-auditor` → `compliance-expert` içine absorbed
- `ai-tool-execution-auditor` → `ai-safety-auditor` olarak promote
- `contract-parity-auditor` → `contract-parity-enforcer` olarak promote (Phase 10.4)

Kalan 24 test-agent lane-B'de kalır.

### 13.3 tenant-isolation-auditor consolidation

- test-agents `tenant-isolation-auditor` + enterprise-v2 `multi-tenant-saas-expert` overlap var.
- Karar: `tenant-isolation-auditor` product-side (UI cross-tenant data leak visibility), `multi-tenant-saas-expert` code-side (tenant scoping, RLS, guard). Both keep, dispatch in respective lanes.

**Critical files (modify)**:
- `.claude/agents-enterprise-v2/orchestrator.md` — Phase 2 parallel lanes section
- `.claude/test-agents/INVOCATION-PACK.md` — reference orchestrator integration
- `.claude/test-agents/README.md` — runtime integration documentation

**Reuse**: `.claude/test-agents/` 28 agent mevcut ve kaliteli — sadece orchestration wiring eksik.

**Verification**: dispatch smoke — `Agent(orchestrator, "Review PR #X with full code + product lanes")` → both lanes fire + compaction merges.

**Severity**: HIGH (product quality gate missing without this).

**Estimated duration**: 1 hafta (wiring + test).

---

## Phase 14 — Developer ergonomics + Docker tooling + invariant perf

**Motivation**: developer experience agent sistemini day-to-day kullanılabilir kılar; Docker tooling reproducibility; invariant suite performance scale'ta mandatory.

**Deliverable**:
1. npm script shortcuts: `review:farm`, `audit:gdpr`, `audit:perf`, `findings:list`, `findings:close <id>`, `invariants:fast`.
2. `Dockerfile.agent-tooling` reproducible base.
3. Jest projects sharding (invariants 44s → <10s).
4. CLI runner `tools/scripts/orchestrator-runner.ts` (tsx-based).

### 14.1 npm script shortcuts

```json
"scripts": {
  "review": "tsx tools/scripts/orchestrator-runner.ts",
  "review:farm": "npm run review -- --scope apps/farm-service/**",
  "audit:gdpr": "tsx .claude/agents-enterprise-v2/runners/gdpr-audit.ts",
  "audit:perf": "tsx .claude/agents-enterprise-v2/runners/perf-audit.ts",
  "findings:list": "tsx tools/gates/finding-registry.ts list --state OPEN",
  "findings:close": "tsx tools/gates/finding-registry.ts close",
  "invariants:fast": "jest --config tests/invariants/jest.config.ts --projects layer-1 layer-3 registry"
}
```

### 14.2 Dockerfile.agent-tooling

- Base: `node:22.11.0-alpine`
- Pinned deps: ts-morph, ajv, jest, ts-jest, @tanstack/react-query (for codegen), ajv/dist/2020.
- Entrypoint: `tools/gates/orchestrator-runner.ts`.
- Used by: CI agents, local dev reproducible invariant runs.

### 14.3 Jest projects sharding

- `tests/invariants/jest.config.ts` → `projects:` array with 3 shards: `layer-1` (knowledge-ssot), `layer-3` (routing-coverage + ownership), `registry` (finding-registry-integrity).
- globalSetup: precompile Ajv schemas, preload `_constants.ts`.
- `--maxWorkers=3` → parallel → 44s → ~15s.
- `invariants:fast` for dev loop, `invariants:full` for CI.

### 14.4 CLI runner

- `tools/scripts/orchestrator-runner.ts` — tsx/TypeScript CLI wrapping Claude Code agent dispatch.
- Modes: `--topic <slug>`, `--scope <glob>`, `--agents <csv>`, `--mode review|teach|implement`, `--base <ref>`, `--head <ref>`.
- Output: streaming Progress → unified report → `docs/reviews/orchestrator/<date>-<slug>.md`.

**Critical files (create)**:
- `Dockerfile.agent-tooling`
- `tools/scripts/orchestrator-runner.ts`
- `tools/scripts/jest-global-setup.mjs`
- `package.json` (scripts section)
- `tests/invariants/jest.config.ts` (multi-project)

**Reuse**: Phase 2 gate CLIs + finding-registry CLI (Phase 12.1) + Claude Code Agent API.

**Verification**:
- `npm run invariants:fast` < 15s
- `npm run findings:list` shows registry content
- `docker build -f Dockerfile.agent-tooling .` + `docker run ... orchestrator-runner --topic smoke` produces unified report

**Severity**: MEDIUM (developer productivity; K8s reproducibility adds HIGH weight).

**Estimated duration**: 1 hafta.

---

## Bölüm III — Critical files aggregate

### Modify
- `.claude/agents-enterprise-v2/orchestrator.md` (Phase 11 split routing, Phase 13 parallel lanes)
- `.claude/agents-enterprise-v2/platform-services.md` (Phase 11 DEPRECATE tombstone)
- `.claude/agents-enterprise-v2/farm-expert.md` (Phase 11 hydroponics integration)
- `.claude/agents-enterprise-v2/data-expert.md`, `messaging-expert.md`, `auth-security-expert.md`, `edge-expert.md` (Phase 8 invariant extensions — **must wait for Phase 1 conversion to avoid cap exceed**)
- `.claude/knowledge/layer-1-nestjs.md`, `layer-1-react.md`, `layer-1-rust.md` (Phase 8 extensions)
- `codegen.ts` + `web/shared-ui/package.json` (Phase 8 codegen activation)
- `web/modules/**/*` (Phase 8 mass TanStack queryKey + `any` migration)
- `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts` (Phase 8 DB dedup)
- `.github/workflows/quality-gates.yml` (Phase 8 + 12 custom rule wiring)
- `package.json` (Phase 14 scripts section)
- `tests/invariants/jest.config.ts` (Phase 14 multi-project)

### Create
- `.claude/knowledge/layer-1-timescaledb.md` (Phase 8.1)
- `.claude/knowledge/layer-1-ai.md` (Phase 8.1)
- `.claude/agents-enterprise-v2/compliance-expert.md` (Phase 9.1)
- `.claude/agents-enterprise-v2/gdpr-erasure-executor.md` (Phase 9.2)
- `.claude/agents-enterprise-v2/ai-safety-auditor.md` (Phase 9.3)
- `.claude/agents-enterprise-v2/legal-hold-auditor.md` (Phase 9.4)
- `.claude/agents-enterprise-v2/audit-trail-completeness-auditor.md` (Phase 9.5)
- `.claude/agents-enterprise-v2/tenant-cost-attribution-agent.md` (Phase 9.6)
- `.claude/agents-enterprise-v2/performance-expert.md` (Phase 10.1)
- `.claude/agents-enterprise-v2/observability-expert.md` (Phase 10.2)
- `.claude/agents-enterprise-v2/supply-chain-auditor.md` (Phase 10.3)
- `.claude/agents-enterprise-v2/contract-parity-enforcer.md` (Phase 10.4)
- `.claude/agents-enterprise-v2/circuit-breaker-auditor.md` (Phase 10.5)
- `.claude/agents-enterprise-v2/memory-leak-auditor.md` (Phase 10.6)
- `.claude/agents-enterprise-v2/claude-api-auditor.md` (Phase 10.7)
- `.claude/agents-enterprise-v2/billing-expert.md` (Phase 11)
- `.claude/agents-enterprise-v2/alert-engine-expert.md` (Phase 11)
- `libs/backend-common/src/finding-registry/**` (Phase 12.1)
- `tools/gates/finding-registry.ts` (Phase 12.1 — full CLI)
- `apps/event-store-service/src/database/migrations/Vxxx__add_findings_table.sql` (Phase 12.1)
- `apps/orchestrator-metrics-exporter/**` OR integrate into observability-service (Phase 12.3)
- `.github/workflows/finding-state-sweep.yml` (Phase 12 — Phase 6 deferred)
- `Dockerfile.agent-tooling` (Phase 14.2)
- `tools/scripts/orchestrator-runner.ts` (Phase 14.4)
- `docs/compliance/README.md` (Phase 9 evidence dir)
- `tools/eslint-rules/{no-bare-graphql-query-string,no-bare-tenant-query-key,no-high-cardinality-metric-label,no-claude-sdk-raw-call}.ts` (Phase 8.5 — +Phase 2 integration)
- `database/migrations/modules/billing/Vxxx__add_stripe_webhook_events.sql` (Phase 8.4)

### Reused (DO NOT recreate)
- `.claude/test-agents/{gdpr-compliance,soc2-readiness,ai-tool-execution,contract-parity}-auditor.md` — content promotion sources
- `.claude/test-agents/` kalan 24 agent — lane-B dispatch
- `libs/backend-common/src/audit/audit-log.*` — existing pattern
- `infrastructure/monitoring/prometheus/slo-alerts.yml` — SLO data source
- `libs/event-contracts/src/upcasters/` — pattern for chain integrity

---

## Bölüm III Verification (end-to-end)

1. All 20+ agents (original + Phase 9-11) pass ownership uniqueness invariant.
2. `npm run invariants:fast` < 15s (Phase 14.3).
3. Full invariant suite including Phase 12.1 `three-store-invariants.spec.ts` green.
4. Multi-pod K8s smoke: 3 orchestrator pods, 1 leader, 0 registry race.
5. Cost attribution pipeline: produce 1 tenant's monthly cost breakdown from Prometheus metrics.
6. GDPR erasure dry-run: `Agent(gdpr-erasure-executor, tenantId=X, dryRun=true)` produces complete fan-out plan.
7. AI safety: adversarial prompt injection fixture → `ai-safety-auditor` flags + tool whitelist blocks.
8. Contract parity: kasten bozulan OpenAPI spec → `contract-parity-enforcer` fails CI.
9. Mass migration evidence: `grep -r "queryKey: \[" web/modules/` → 0; `grep -r "as any" web/modules/ | wc -l` ≤ 20 (boundary-only).
10. Developer smoke: `npm run audit:gdpr` works locally.

---

## Rollout tahmini — Bölüm I + II + III konsolide

| Bölüm | Phase | Description | Süre |
|---|---|---|---|
| I | 0.x | SİSTEM BOZAN | 1 hafta (büyük kısmı bitti) |
| II | 1 | W3 agent conversion | 1.5 hafta (paralel session devam ediyor) |
| II | 2 | tools/gates infrastructure | 2 hafta |
| II | 3 | .claude/skills/ | 2 hafta |
| II | 4 | Invariants (4/5 bitti; upcaster + three-store eksik) | 0.5 hafta |
| II | 5 | root-cause-auditor | 0.5 hafta (agent landed, full activation Phase 2 sonrası) |
| II | 6 | Finding registry (jsonl — PG migration Phase 12'de) | tamam |
| II | 7 | CODEOWNERS + Dependabot + rule-health | 0.5 hafta (rule-health Phase 12 sonrası) |
| **III** | **8** | **Stack-depth extensions + mass migrations** | **1.5 hafta** |
| **III** | **9** | **P0 CRITICAL cross-cutting agents (6)** | **2 hafta** |
| **III** | **10** | **P0 HIGH cross-cutting agents (7)** | **2 hafta** |
| **III** | **11** | **platform-services split** | **1 hafta** |
| **III** | **12** | **K8s-day-one readiness (registry PG + leader + metrics)** | **3 hafta** |
| **III** | **13** | **test-agents lane integration** | **1 hafta** |
| **III** | **14** | **Dev ergonomics + Docker + invariant perf** | **1 hafta** |

**Toplam (Bölüm III alone)**: ~11 hafta single-session, ~7 hafta 2 paralel session.
**Grand total (I+II+III)**: ~18-20 hafta single-session, ~12-15 hafta 2 paralel session.

**Priority gruplaması (iş başlatma sırası önerilen)**:
- **Immediate (hafta 1-3)**: Bölüm I/II finish (Phase 2 gates + Phase 1 conversion + Phase 4 kalan 2 invariant) + Phase 8 (mass migrations CRITICAL).
- **Short-term (hafta 4-7)**: Phase 9 CRITICAL agents (compliance + audit + cost) + Phase 11 platform-services split.
- **Medium-term (hafta 8-12)**: Phase 10 HIGH agents + Phase 13 test-agents lane + Phase 14 dev ergonomics.
- **K8s cutover gate (hafta 13-15)**: Phase 12 tamamen (registry PG, leader-election, metrics, rate-limit). K8s'e bu bitmeden geçilmez.

## Bölüm III — Açık kararlar

Aşağıdakileri Okan onayıyla netleştirmek istiyorum:

1. **Agent splitting aggressiveness**: Phase 11 platform-services split 3 yeni agent'a mı (billing, alert-engine, observability) yoksa daha granular mı (billing + billing-reconciliation + alert-engine + observability + event-store)? Öneri: 3 — her biri yeterli, daha fazlası agent-count explosion.
2. **test-agents promotion granularity**: Phase 9'da 4 promotion var; kalan 24 test-agent lane-B'de kalır. Bazı yüksek-değer olanlar (edge-industrial-auditor, access-boundary-auditor) daha early promotion ister mi? Öneri: 4 dondur; tip promotionları Phase 13 sonrası sinyal bakarak değerlendir.
3. **K8s geçiş tarihi**: Phase 12 bitmeden K8s'e geçilmez. Eğer mevcut Docker prod'da 4-6 ay daha kalınacaksa, Phase 12 zamana yayılabilir.
4. **Registry PostgreSQL nereye**: event-store-service schema mı, yeni `finding-store-service` mi? Öneri: event-store — finding registry immutable event ledger karakteri taşır, doğal fit.
5. **orchestrator-metrics-exporter ayrı microservice mi**: 1 daha service = 1 daha deploy complexity. observability-service'e plug önerisi. Öneri: observability-service embed.

---

# UYUM DENETİMİ — Bölüm III ↔ Mevcut sistem

Bölüm III eklenirken her yeni bileşenin (a) Bölüm I+II deliverable'larıyla, (b) mevcut repo state'iyle, (c) active invariant'larla, (d) CLAUDE.md disiplin kurallarıyla uyumluluğu aşağıda denetlendi. Önemli bağımlılık / çakışma / sıra zorunlulukları somut olarak not düşüldü.

## UC-1 — 200-satır cap vs Phase 8 knowledge extension + agent invariant additions

**Risk**: Phase 8.3 "mevcut data-expert.md, messaging-expert.md, auth-security-expert.md, edge-expert.md, platform-kernel-expert.md'ye invariant block ekle" der. Bu 5 agent zaten Phase 1 W3 conversion wave sonrasında ≤200 satır. Ekleme yaparsam cap aşılır — Phase 4 `orchestrator-routing-coverage` invariant fail eder.

**Uyum kararı**:
- Phase 8 knowledge extension'ları ÖNCE layer-1-*.md shard'larına gider (cap yok). Agent dosyaları layer'a referans verir.
- Agent invariant'ı AGENT DOMAIN-SPECIFIC olmak ZORUNDAYSA (layer'a taşınamıyorsa), agent dosyası 200 satır cap'ını korumak için başka invariant'ın compact'lanması gerek. Bu bir REFACTOR; Phase 8 bu trade-off'u açıkça ele almalı.
- **Execution sequencing**: Phase 1 conversion bir agent'ta BİTTİKTEN sonra Phase 8 o agent'a dokunabilir. Paralelde yapılmaz.

## UC-2 — Phase 8.4 mass migration (TanStack queryKey) vs Phase 2 ESLint rule dependency

**Risk**: Phase 8.4 "265+ call site migrate" der + Phase 8.5 `no-bare-tenant-query-key` ESLint rule önerir. Ama bu ESLint rule Phase 2'nin deliverable'ı (tools/eslint-rules/). Phase 2 hiç başlamamış (sadece banned-phrase.mjs başladı, TypeScript'e çevrilmedi, commit'lenmedi).

**Uyum kararı**:
- Phase 8.4 mass migration ÖNCE CI'da sessiz modda (warn-only) Phase 2 ESLint rule'ı aktif olmalı — 265 satır değişir, sonra rule error-level'e yükseltilir.
- Sıralama: Phase 2 ESLint rules (warn) → Phase 8.4 migration → Phase 2 ESLint rules (error) → Phase 4 invariant test (count = 0).
- Plan dosyasının Phase 8 metni bu dependency'yi açıkça belirtiyor ("Phase 8.5 Phase 2 integration") ama Phase 2 hâlâ açık; yani Phase 8 Phase 2'nin en azından ilgili rule'larını gerektirir — bunu takvimin "Immediate (hafta 1-3)" grubu doğru sırayla kapsar: Phase 2 start + Phase 8 start paralelde, Phase 2 ESLint rules ≤ Phase 8 migration merge.

## UC-3 — Phase 9 yeni agent ownership'leri vs Phase 0.3 `agent-ownership-uniqueness` invariant

**Risk**: Phase 9'da öneriyorum:
- `compliance-expert`: `libs/backend-common/src/gdpr/**` (yeni), cross-service `apps/*/src/gdpr/`
- `legal-hold-auditor`: cross-cutting on 10 services
- `audit-trail-completeness-auditor`: `libs/backend-common/src/audit/**` (EXISTS, mevcut sahibi auth-security-expert routing'de)
- `ai-safety-auditor`: `apps/ai-service/**` (mevcut sahibi messaging-expert)
- `tenant-cost-attribution-agent`: cross-cutting Prometheus emission

**Uyum kararı**:
- `libs/backend-common/src/audit/**` için: orchestrator routing Phase 0.2'de auth-security-expert'e atandı. **Çakışma**. Yeni audit-trail-completeness-auditor için iki opsiyon:
  - **(a) Secondary reviewer grammar** (önerilen): routing satırında `auth-security-expert` primary kalır, `audit-trail-completeness-auditor` "Also notify" kolonuna eklenir. Ownership grammar: "delegated from auth-security-expert" in audit-trail-completeness-auditor.md.
  - **(b) Primary swap**: audit-trail-completeness-auditor primary yapılır, auth-security-expert secondary. Riskli — auth flow audit log'u kritik birleşik bağlam.
- `apps/ai-service/**` için: messaging-expert primary; `ai-safety-auditor` secondary (cost + safety split concern). Delegation grammar zorunlu.
- `apps/*/src/gdpr/` yeni path → yeni primary (compliance-expert) — çakışma yok.
- Her yeni agent dosyası Primary Ownership bloğunda `primary / secondary reviewer / delegated from <agent>` grammar'ını MUTLAK kullanmalı (Phase 0.3 landed kural). Yoksa ownership-uniqueness invariant fail eder.

## UC-4 — Phase 10 performance-expert ownership'i "all repositories + services" aşırı geniş

**Risk**: `performance-expert` Primary Ownership olarak "All repositories + services" yazdım. Bu ownership-uniqueness invariant ile ÇAKIŞIR (her domain'in zaten primary'si var).

**Uyum kararı**:
- performance-expert HİÇ PRIMARY ownership claim ETMEMELİ. Onun yerine **cross-cutting secondary reviewer** rolü — her tenant-data-bearing service değişiminde paralel dispatch edilir (security-reviewer pattern'iyle aynı).
- Handoff-protocol Cross-domain handoff rules tablosuna yeni satır: `apps/**/src/**/repositories/**` + `apps/**/src/**/entities/*.entity.ts` (perf-related change) → performance-expert also-notify.
- Orchestrator routing'e `performance` bir "Also notify" satırıdır, primary değil. Bu şekilde `database-reviewer` + `security-reviewer` ile aynı conceptual slot'a oturur.
- Aynı mantık observability-expert (cross-cutting), supply-chain-auditor (cross-cutting), memory-leak-auditor (cross-cutting), contract-parity-enforcer (cross-cutting) için geçerli.

## UC-5 — Phase 11 platform-services split vs mevcut orchestrator routing satırları

**Risk**: Orchestrator routing'de `apps/billing-service/**`, `apps/notification-service/**`, `apps/config-service/**`, `apps/event-store-service/**`, `apps/observability-service/**`, `apps/alert-engine/**`, `apps/hydroponics-service/**` → platform-services. Phase 11 split → 7 satırın primary'si değişir + platform-services deprecate.

**Uyum kararı**:
- Routing tablosu satır satır migration:
  - `apps/billing-service/**` → `billing-expert` (primary), `multi-tenant-saas-expert` (notify — plan-gating)
  - `apps/alert-engine/**` → `alert-engine-expert` (primary), `multi-tenant-saas-expert` (notify — schema-per-tenant), `data-expert` (notify — rule performance)
  - `apps/hydroponics-service/**` → `farm-expert` (primary — hydroponics farm domain'ine integrate), `data-expert` (notify)
  - `apps/observability-service/**` → `observability-expert` (primary)
  - `apps/event-store-service/**` → `data-expert` (primary — event ledger, data-expert domain), `observability-expert` (notify — trace storage)
  - `apps/notification-service/**` → kalıcı sahibi BELİRSİZ — `platform-services` deprecate edilince kim alır? Öneri: `auth-security-expert` (notification içerik PII + template injection surface) OR yeni `notification-expert`. Plan açık karar madde-6'ya eklensin.
  - `apps/config-service/**` → `platform-kernel-expert` (primary — config is kernel concern, ADR-011 violation açık)
- `platform-services.md` deprecate: README tombstone + orchestrator.md:84-benzeri satırlara `.claude/agents-enterprise-v2/platform-services.md` → ARCHIVED rotasyon. Yeni glob mapping test'i Phase 4 invariant ile doğrulanır.

## UC-6 — Phase 12 registry PG migration vs Phase 6 jsonl + Phase 4 integrity invariant

**Risk**: Phase 6 `docs/reviews/_registry/findings.jsonl` + `finding-registry-integrity.spec.ts` (6 assertion, hash chain) landed. Phase 12.1 PG'ye migrate ediyor. jsonl file tombstone edilirse, mevcut integrity invariant ne yapar?

**Uyum kararı**:
- jsonl TOMBSTONE DEĞİL — export-only read mode'a geçer: PG → jsonl pipeline günlük cron'la jsonl'yi yeniden yazar (backward-compat + disaster recovery).
- Integrity invariant dualize edilir:
  - `finding-registry-integrity.spec.ts` (mevcut) — jsonl hash chain — kalır.
  - YENİ `finding-registry-postgres.spec.ts` — PG table hash chain + row count matches jsonl. Phase 4 kalan 1 invariant olarak `three-store-invariants.spec.ts` yerine bu daha somut test.
- `tools/gates/finding-registry.ts` CLI iki mode destekler: `--backend=jsonl` (legacy), `--backend=postgres` (new). `--backend` env/config-driven; rollout sırasında çift yazı (dual-write) period.
- `tools/scripts/seed-finding-registry.mjs` (Phase 6) tombstone + PG migration script'iyle değiştirilir. One-shot seed idempotent olmaya devam eder.

## UC-7 — Phase 12.2 Redis cycle-state vs mevcut Redis kullanımı

**Risk**: Redis şu an auth-security-expert primary (session + rate-limit). Phase 12 orchestrator için Redis kullanır (`orchestrator:*` namespace). Key namespace'i, persistence, eviction policy uyum sağlanmalı.

**Uyum kararı**:
- Redis topology uyum:
  - Namespace: `auth:*`, `rate-limit:*` (mevcut) + `orchestrator:*` (yeni). Net ayrım.
  - Persistence: auth/rate-limit RDB snapshot + AOF for durable rate limit counters. Orchestrator cycle-state ephemeral (30s lease), AOF gerekli değil — transient.
  - Deployment: aynı Redis cluster, aynı pool; orchestrator pod'ları auth-security-expert tarafından yönetilen `RedisService` wrapper'ı TÜKETMELİ — yeni Redis client istemez (multi-client = fragmented config drift).
- Yeni lib: `libs/backend-common/src/orchestration/redis-primitives.ts` (lease, cycle-state-list, budget-bucket). auth-security-expert review secondary (Redis fail-closed invariant hâlâ geçerli); orchestration-specific invariant'lar burada.

## UC-8 — Phase 13 test-agents lane-B vs mevcut INVOCATION-PACK.md namespace

**Risk**: `.claude/test-agents/INVOCATION-PACK.md` kendi output namespace'i `docs/test-audits/` tanımlamış (review'lardan ayrı). Phase 13 "orchestrator paralel lane" derken rapor birleşmesi nasıl?

**Uyum kararı**:
- Output namespace ayrı kalır:
  - Lane-A (enterprise-v2) raporları: `docs/reviews/<agent>/<date>-<topic>.md`
  - Lane-B (test-agents) raporları: `docs/test-audits/<agent>/<date>-<topic>.md`
- Orchestrator Phase 5 unified report cross-namespace:
  - `docs/reviews/orchestrator/<date>-<topic>.md` mevcut yapıda KALACAK
  - İçeriğe yeni "Lane-B (product quality)" bölümü eklenir, test-audits dosyalarına link.
- Finding registry namespace: `P0-*`, `DATA-*`, `SEC-*` (enterprise-v2) + `PRODUCT-*` (test-agents lane-B) prefix'i. `findings.jsonl.schema.json` pattern field'ı PRODUCT- prefix'i için genişletilmeli.
- Compaction (Phase 3.5 context-manager) CROSS-LANE: iki lane'den gelen findings tek raporda merge, same-surface findings root-cause consolidate edilir.

## UC-9 — Phase 14 jest projects sharding vs mevcut Phase 4 invariant tests

**Risk**: Phase 4'te 4 invariant spec landed (orchestrator-routing-coverage, agent-ownership-uniqueness, knowledge-ssot, finding-registry-integrity). Phase 14.3 sharding 3 shard önerir: layer-1, layer-3, registry. Hangi spec hangi shard'da?

**Uyum kararı**:
- Shard mapping:
  - `layer-1`: knowledge-ssot.spec.ts (tech/signature claims)
  - `layer-3`: orchestrator-routing-coverage.spec.ts + agent-ownership-uniqueness.spec.ts (ADR/discipline claims)
  - `registry`: finding-registry-integrity.spec.ts + Phase 12.1 `finding-registry-postgres.spec.ts` (store health)
  - `adoption` (yeni 4. shard): adoption-invariants.spec.ts (schema drift adoption — mevcut) + gelecek upcaster-chain.spec.ts
- globalSetup per shard: Ajv schema compile cache + `_constants.ts` preload + Phase 12.1 için PG test DB (testcontainers).
- Sequential mode fallback: `invariants:full` serial (CI), `invariants:fast` parallel (dev loop).

## UC-10 — Phase 9 compliance-expert MT-CRITICAL-003 takeover vs multi-tenant-saas-expert

**Risk**: `multi-tenant-saas-expert.md` MT-CRITICAL-003 (erasure cascade) kendi active findings bölümünde. Phase 9.1 compliance-expert bu finding'i devralacak. Duplicate ownership olmamalı.

**Uyum kararı**:
- MT-CRITICAL-003 REASSIGN: multi-tenant-saas-expert'ten compliance-expert'e. Finding registry'de notes field'ı güncellenir: "Ownership transferred to compliance-expert as of Phase 9.1; multi-tenant-saas-expert retains tenant-contract review responsibility."
- multi-tenant-saas-expert.md: erasure cascade bloğu "delegated to compliance-expert; tenant-contract scoping rules remain here" tagıyla güncellenir.
- compliance-expert.md: primary owner of erasure/portability execution; multi-tenant-saas-expert secondary reviewer for tenant-scoping compliance.

## UC-11 — CLAUDE.md'ye yansıtılması gereken değişimler

Bölüm III tamamlandığında CLAUDE.md'ye eklenmesi gerekenler:
1. "Agent+Skill+Gate System" section → "Bölüm III scope" ekle (cross-cutting agents + K8s readiness).
2. "Review Finding Traceability" section → PG backend migration note + dual-read jsonl/PG period.
3. "Commands" section → `npm run review:*`, `audit:*`, `findings:*` scripts (Phase 14.1).
4. "Architecture Map" section → `compliance-expert`, `performance-expert`, `observability-expert`, `billing-expert`, `alert-engine-expert`, `audit-trail-completeness-auditor`, vb. 14 yeni agent listelenir. 16 → ~38 agent.
5. "Multi-tenant SaaS expert" mention → compliance-expert'in erasure ownership'i devraldığı açıkça belirtilir.
6. "Architectural Approach 4-tier hierarchy" → Phase 2 gate'leri (tier-claim-lint, banned-phrase, commit-msg-validator) live olduğu belirtilir; şu an prose-only olduğu drift bırakılmaz.

## UC-12 — Phase 12 K8s readiness vs mevcut Docker Compose prod

**Risk**: Kullanıcı "K8s'ye henüz geçmedik, Docker kullanıyoruz" dedi. Phase 12 K8s-day-one için. Prod Docker Compose'da çalışırken Phase 12 deliverable'ları test edilebilir mi?

**Uyum kararı**:
- Phase 12 deliverable'ları Docker Compose'da TEST edilebilir (multi-container, paylaşımlı Redis/PG). K8s'e özgü olan tek şey: leader-election (Redis lease multi-container da çalışır), HPA-aware rate-limit bucket (Docker Compose'da replica sayısı sabit, test OK).
- Dockerfile.agent-tooling (Phase 14.2) hem Docker Compose hem K8s için reproducible image üretir.
- K8s'e fiili geçiş Phase 12 bittikten sonra. Phase 12 deliverable'ları paradoks değil — Docker Compose'da validate, K8s'e deploy.
- Master plan'a not: "K8s cutover Phase 12 + `deploy-digitalocean.yml`'nin K8s variant'ı (ArgoCD via `infra/argocd/`) hazırlığı ile eşzamanlı." Bu plan, infrastructure-side work (ArgoCD + K8s cluster standup) kapsamına alınmalı — agent sistem planı dışı.

## UC-13 — banned-phrase gate (Phase 2 partial, henüz commit'lenmemiş) vs CLAUDE.md banned phrases uyumu

**Risk**: Şu an working tree'de `tools/gates/banned-phrase.mjs` var, commit'lenmedi. Bir önceki Phase 2 başlatma girişiminde kendi commit'lerimde 5 "deferred" ihlali yakaladı. Plan'a bu bulgu yansıtılmalı + registry'ye ilgili finding açılmalı.

**Uyum kararı**:
- Plan'a "`banned-phrase.mjs` uncommitted state" notu eklensin. Şu sıralama:
  1. banned-phrase.mjs → .ts'e çevir + CLAUDE.md commit messages için allowIf genişletilsin (yapıldı working tree'de)
  2. Pre-commit hook'a bağla (Phase 2 deliverable — husky v8)
  3. CI workflow'a ekle (`quality-gates.yml`)
  4. Finding registry'ye `PROC-MEDIUM-001` kaydı: "Phase 0-7 commit messages using bare 'deferred' without strict owner+deadline+finding-ID format; retroactively exempted via plan-phase reference allowIf expansion; future commits MUST use extended format."
- Bu finding açık kalır, banned-phrase gate CI'a girene kadar STALE risk var.

## UC-14 — Active task list ve commit state

Şu anda açık task #14 "Phase 2 partial — banned-phrase gate" in-progress. Plan onayı sonrası:
- banned-phrase.mjs `.ts`'e çevrilir + commit'lenir (Phase 2 kapsamı; Phase 8 mass migration'ı etkiler)
- OR task #14 paused, kullanıcı plan Phase 9/10 agent creation'ına başlamamı söylerse başka iş.

**Bu addendum Bölüm III'ün EXECUTE edilebilirlik temelini kurar. Plan onayı aşamasından geçtikten sonra, her Phase başlatılırken ilgili UC (Uyum Case) maddesi tekrar okunarak execute edilir.**
