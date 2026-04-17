# Agentic Branch Session Handoff — 2026-04-17

**Branch:** `agentic`
**Master plan:** `/root/.claude/plans/abstract-brewing-mochi.md` (1268 lines)
**Audit origin:** `docs/reviews/orchestrator/2026-04-16-v2-audit.md`
**Finding registry:** `docs/reviews/_registry/findings.jsonl` (9 seeded entries)

Bu session 11 commit ile Enterprise-grade v2 agent sisteminin **~%50-60'ını** tamamladı. Yarın kaldığı yerden devam için bu dosya authoritative rehber.

---

## 1. Yarın ilk komutlar (sanity + start)

```bash
cd /var/aqua-saas
git checkout agentic
git pull origin agentic         # parallel session commit'lerini al
git log --oneline -15           # son state'i gör
git status                      # temiz olmalı (parallel session'dan kalan M state olabilir)

# Invariant + gate sağlığı
npx jest --config tests/invariants/jest.config.ts    # hepsi GREEN olmalı (85+ assertion)
npx ts-node --project tools/gates/tsconfig.json \
  tools/gates/banned-phrase.ts --mode=range HEAD~11 HEAD   # banned-phrase gate testi

# Plan dosyası oku — Phase haritası için
cat /root/.claude/plans/abstract-brewing-mochi.md | head -100
```

---

## 2. Bugün landed olanlar (checkpoint)

11 commit pushed on `agentic`:

| SHA (short) | Phase | İçerik |
|---|---|---|
| `32839e24` | 0 | SSoT drift + routing extension + ownership grammar (Phase 0.2/3/4 bundle) |
| `f931f935` | 0.1 | `.claude/agents/` → `.claude/agents.legacy/` archive |
| `2dd09f99` | 4 | 3/5 invariants (orchestrator-routing-coverage, agent-ownership-uniqueness, knowledge-ssot) |
| `b907c235` | 5 | `root-cause-auditor.md` agent + Phase 4.5 activation |
| `7090c950` | 6 | Finding registry (jsonl + schema + closes-footer-check workflow + integrity invariant) |
| `4eb35921` | 7 (partial) | CODEOWNERS alignment (.claude/agents.legacy, .github/manifests, tools/scripts) |
| `47bea207` | 2 (start) | `banned-phrase.ts` gate + husky pre-commit + `quality-gates.yml` CI |
| `955c8caa` | 8.4 (start) | `no-bare-tenant-query-key` ESLint rule + `useHealthEvents.ts` first migration (33 call sites) |
| `88c441ff` | 9.1 | `compliance-expert.md` + MT-CRITICAL-003 → COMPLIANCE-CRITICAL-001 transfer |
| `973394b3` | 11 | platform-services split → billing-expert + alert-engine-expert + observability-expert + hydroponics→farm + routing redistribute |
| `3ef66e26` | 9.2-9.6 | gdpr-erasure-executor + ai-safety-auditor + legal-hold-auditor + audit-trail-completeness-auditor + tenant-cost-attribution-agent |
| `36a76cbe` | 10 | performance-expert + supply-chain-auditor + contract-parity-enforcer + circuit-breaker-auditor + memory-leak-auditor |

**Agent count:** 14 yeni agent file landed bu session + 1 platform-services deprecated. Runtime roster'da toplam ~28 agent.

---

## 3. Phase-by-phase kalan iş (plan referanslı)

### Phase 1 — W3 agent conversion (parallel session yapıyor)
**Plan ref:** `abstract-brewing-mochi.md#Phase-1`
**Durum:** 8 legacy-style agent hâlâ >200 satır cap ihlâli.

Kalan dosyalar:
- `security-reviewer.md` (317 lines) — **en büyük**, convert etmek ince iş
- `orchestrator.md` (308 lines) — Phase 0-11 süresince ben çok genişlettim; şimdi convert gerek
- `implementation-planner.md` (279 lines)
- `frontend-expert.md` (246 lines)
- `hr-expert.md` (197)
- `database-reviewer.md` (192)
- `context-manager.md` (184)
- `admin-expert.md` (177)
- `prompt-writer.md` (175)

Orchestrator şu an Phase 0-10 eklemeleri sonrası muhtemelen 350+ line. Convert edilmesi lazım — ya da routing table'ı ayrı bir _shared/orchestrator-routing-table.md dosyasına extract.

**Önce yap**: `git pull` sonra `wc -l .claude/agents-enterprise-v2/*.md | sort -rn | head -10` — kim >200 gör.

### Phase 2 kalan — Gate infrastructure (ANA BLOKER, hemen yap)
**Plan ref:** `abstract-brewing-mochi.md#Phase-2`
**Durum:** `banned-phrase.ts` + `no-bare-tenant-query-key` ESLint rule (Phase 8.4 ile birlikte) landed. Kalan 5 gate + 4 ESLint rule:

- [ ] `tools/gates/tier-claim-lint.ts` — `// tier-N:` comment validator; **ts-morph gerektirir** (BLOCKER-5: `npm install -D ts-morph@^23`, `engines.node: >=22.6.0` bump).
- [ ] `tools/gates/commit-msg-validator.ts` — `Closes: ...#FINDING-ID` trailer format + registry lookup. Şu an `tools/scripts/validate-closes-footer.mjs` var, bunu TypeScript CLI'a yükselt.
- [ ] `tools/gates/migration-sql-lint.ts` — data-expert invariant'larını encode et (SET LOCAL, CONCURRENTLY, blue-green 3-step, destructive migration guard). ts-morph + regex hybrid.
- [ ] `tools/gates/finding-registry.ts` — Phase 6'nın seed script'ini tam CLI'a dönüştür (add/transition/sweep/verify/export-jsonl). `--backend=jsonl` (legacy) + `--backend=postgres` (Phase 12) dual-mode destekli.
- [ ] `tools/eslint-rules/rules/no-direct-event-publish.ts` — ADR-006 outbox-only (custom rule; data-expert sibling).
- [ ] `tools/eslint-rules/rules/no-high-cardinality-metric-label.ts` — observability-expert sibling.
- [ ] `tools/eslint-rules/rules/no-claude-sdk-raw-call.ts` — ai-safety-auditor sibling (Anthropic API through wrapper only).
- [ ] `tools/eslint-rules/rules/no-bare-graphql-query-string.ts` — contract-parity-enforcer sibling (typed-document-node mandate).

Her biri ~100-200 LoC. ts-morph tier-claim-lint için zorunlu. Node 22 bump PRE-requisite.

**Önce yap**: Node 22 + ts-morph kurulum çağrısı:
```bash
npm install -D ts-morph@^23.0.0
# package.json "engines" bloğunu "node": ">=22.6.0" yap
# prod deploy runtime'larının Node 22 uyumlu olduğunu doğrula (infra-expert'a sor)
```

### Phase 3 — Skills catalog (ayrı session önerilir — büyük iş)
**Plan ref:** `abstract-brewing-mochi.md#Phase-3`
**Durum:** `.claude/skills/` dizini yok; WRITER mode skill-based architecturally kapalı.

8 skill file yazılmalı:
- `.claude/skills/README.md` — skill format + handoff frontmatter spec
- `.claude/skills/add-entity-field.md`
- `.claude/skills/change-event-contract.md`
- `.claude/skills/add-shared-table.md` (BLOCKER-15)
- `.claude/skills/add-rls-policy.md`
- `.claude/skills/provision-tenant.md` (BLOCKER-14)
- `.claude/skills/pre-migration-restore-test.md`
- `.claude/skills/run-migration-prod.md`

Ve `tools/ripple-tracer/` (services.yaml parser + ts-morph AST) — ≤3 dosya.

**Bu faz büyük** — 2 haftalık iş. Phase 2 gate'ler bittikten sonra başlamak mantıklı.

### Phase 4 kalan — 2 eksik invariant
**Plan ref:** `abstract-brewing-mochi.md#Phase-4`

- [ ] `tests/invariants/upcaster-chain.spec.ts` — her event version için matching upcaster (W6 event wave).
- [ ] `tests/invariants/three-store-invariants.spec.ts` — finding-registry + cycle-state + review-file 3-way hash tutarlılığı (Phase 12'nin PG migration'ı bitince anlamlı).

### Phase 6 kalan — finding-state-sweep cron
**Plan ref:** `abstract-brewing-mochi.md#Phase-6`

- [ ] `.github/workflows/finding-state-sweep.yml` — daily cron, 30-day STALE escalation + past-deadline BLOCKED override → STALE transition.

### Phase 7 kalan — rule-health-report
**Plan ref:** `abstract-brewing-mochi.md#Phase-7`

- [ ] `.github/workflows/rule-health-report.yml` — monthly; override count, STALE count, agent dispatch frequency, rule firing rate. Phase 2 gate'ler populate etmezse anlamsız — **Phase 2 bittikten sonra yaz**.

### Phase 8 kalan — knowledge extensions + mass migrations
**Plan ref:** `abstract-brewing-mochi.md#Phase-8`

Knowledge layer:
- [ ] `.claude/knowledge/layer-1-timescaledb.md` (new, ~80 lines) — hypertable + continuous aggregate + compression + retention
- [ ] `.claude/knowledge/layer-1-ai.md` (new, ~90 lines) — Anthropic SDK patterns (prompt caching, streaming, tool-use)
- [ ] `layer-1-nestjs.md` extensions — GraphQL Federation 2 deep section, Redis patterns, NATS JetStream consumer config
- [ ] `layer-1-react.md` extensions — codegen orphan resolution, TanStack Query bare-key adoption count

Mass migrations (EN KRİTİK — FE-CRITICAL-001 canlı):
- [ ] **TanStack bare queryKey** — 419 kalan call site (farm-module 39 daha, sensor-module 10, hr-module 9, tenant-admin 12, admin-panel 2, dashboard 2, hydroponics-module 1). `useHealthEvents.ts` pattern'i dökümante edildi 955c8caa commit'inde.
- [ ] **GraphQL codegen activation** — `codegen.ts` çalıştır, `web/shared-ui/src/generated/graphql-types.ts` üret, 246+ `any`/`as any` migrate.
- [ ] **Stripe webhook DB-side dedup** — `billing.stripe_webhook_events` migration + handler update.

### Phase 11 kalan — notification-service ownership
**Plan ref:** `abstract-brewing-mochi.md#Phase-11` (UC-5)

Şu an routing `apps/notification-service/**` → auth-security-expert (default per plan UC-5). Okan'a confirm et:
- Option A: auth-security-expert kalsın (PII content + email/SMS template injection — security concern)
- Option B: Yeni `notification-expert` agent yaz (dedicated focus)

### Phase 12 — K8s-day-one readiness (EN BÜYÜK — 3 hafta)
**Plan ref:** `abstract-brewing-mochi.md#Phase-12`

- [ ] Registry PostgreSQL migration — `event-store` schema altında `findings` table + advisory lock write + dual-read jsonl/PG period
- [ ] `tools/gates/finding-registry.ts` full CLI (Phase 2 sibling)
- [ ] Orchestrator Redis cycle-state + leader-election (Redis `SET NX EX 30s` lease, etcd/PG advisory lock seçeneği)
- [ ] Agent dispatch Prometheus metrics — `agent_dispatch_total`, `agent_finding_issued_total`, `review_cycle_duration_seconds` — endpoint `observability-service`'e embed OR yeni `orchestrator-metrics-exporter` microservice
- [ ] Claude API 429 backpressure — per-cycle budget + token-bucket + FROZEN cycle state transition
- [ ] Per-tenant cost attribution pipeline activation (tenant-cost-attribution-agent sibling)

**Bu faz bitmeden K8s'e geçilmez** — plan explicit. Docker Compose'da geçici olarak doğrulanabilir.

### Phase 13 — test-agents lane integration
**Plan ref:** `abstract-brewing-mochi.md#Phase-13`

- [ ] Orchestrator Phase 2 parallel lanes tanımı (lane-A code-quality + lane-B product-quality)
- [ ] Phase 3.5 cross-lane compaction logic
- [ ] Finding registry `PRODUCT-*` prefix kabul (pattern zaten eklenmiş schema'da)
- [ ] Test-agents output namespace `docs/test-audits/` preserve (enterprise-v2 `docs/reviews/` ayrı kalır)
- [ ] 24 kalan test-agent'ın dispatch integrasyonu (`INVOCATION-PACK.md` pattern'i)

### Phase 14 — Developer ergonomics + Docker tooling
**Plan ref:** `abstract-brewing-mochi.md#Phase-14`

- [ ] `package.json` scripts: `review:*`, `audit:*`, `findings:*`, `invariants:fast`
- [ ] `tools/scripts/orchestrator-runner.ts` — tsx CLI wrapping agent dispatch
- [ ] `Dockerfile.agent-tooling` — reproducible gate execution
- [ ] Jest projects sharding (`tests/invariants/jest.config.ts` multi-project) — 44s → <15s target
- [ ] `docs/runbooks/memory-leak-triage.md` (memory-leak-auditor Phase 10.6 referansı)

---

## 4. Registry state

`docs/reviews/_registry/findings.jsonl` — 9 entries:

| ID | Severity | State | Owner | Notes |
|---|---|---|---|---|
| P0-CRITICAL-001 | CRITICAL | RESOLVED | orchestrator | createTenantQueryKey signature — 32839e24 |
| P0-HIGH-002 | HIGH | RESOLVED | orchestrator | Routing coverage — 32839e24 + 2dd09f99 |
| P0-HIGH-003 | HIGH | RESOLVED | orchestrator | Ownership conflicts — 32839e24 + 2dd09f99 |
| P0-MEDIUM-004 | MEDIUM | RESOLVED | orchestrator | Service count + ADR misfile — 32839e24 |
| P0-HIGH-005 | HIGH | IN-PROGRESS | orchestrator | Phantom infra (21 artefakt) — kısmen kapandı (root-cause-auditor, registry, compliance-expert vb.); Phase 2/3/12 tamamlanınca RESOLVED |
| P0-HIGH-006 | HIGH | RESOLVED | orchestrator | 3 agent dir collision — f931f935 |
| P0-HIGH-007 | HIGH | OPEN | prompt-writer | 8 agent >200 satır cap (W3 conversion in-flight) |
| COMPLIANCE-CRITICAL-001 | CRITICAL | OPEN | compliance-expert | GDPR Art 17 cascade absent — Phase 9.2 gdpr-erasure-executor closer |
| PROC-MEDIUM-001 | MEDIUM | RESOLVED | orchestrator | Banned-phrase self-discovered — 47bea207 |

**Açık (OPEN/IN-PROGRESS):** 3 entry — P0-HIGH-005, P0-HIGH-007, COMPLIANCE-CRITICAL-001.

Registry nasıl güncellenir:
```bash
# Yeni finding eklemek için seed script'in kendisini genişlet + rerun:
vim tools/scripts/seed-finding-registry.mjs   # append new entry to seedEntries array
rm docs/reviews/_registry/findings.jsonl
node tools/scripts/seed-finding-registry.mjs
# Hash chain yeniden hesaplanır; integrity invariant re-run ile doğrulanır
```

---

## 5. Active invariant tests (CI-lock'lu 85 assertion)

`nx run tests-invariants:test` veya direkt jest:

```bash
npx jest --config tests/invariants/jest.config.ts
```

Test dosyaları:
- `tests/invariants/orchestrator-routing-coverage.spec.ts` — 72 assertion (repo surface ↔ routing)
- `tests/invariants/agent-ownership-uniqueness.spec.ts` — 2 assertion (primary uniqueness + ownership grammar)
- `tests/invariants/knowledge-ssot.spec.ts` — 5 assertion (signature + count claims vs real)
- `tests/invariants/finding-registry-integrity.spec.ts` — 6 assertion (schema + hash chain)
- `tests/invariants/adoption-invariants.spec.ts` — SchemaDriftModule adoption (pre-existing; 4 failures are real code debt W2-scope, not my regressions)

Yeni agent eklediğinde routing + ownership testi re-run zorunlu. Yakalanan conflict'ler inline fixed — pattern: "delegated from <agent>" tagı ekle.

---

## 6. Aktif gate'ler

- **Pre-commit hook** (`.husky/pre-commit`): banned-phrase gate'i staged files + commit body üzerinde çalıştırır. FAIL olduğunda commit yapmaz. Kendi 2 commit'imi yakaladı session sırasında — architectural fix uygulandı (regex allowIf genişletildi + exempt paths).
- **CI workflow** (`.github/workflows/quality-gates.yml`): PR + push'ta banned-phrase gate + registry hash-chain re-compute.
- **Closes-footer-check** (`.github/workflows/closes-footer-check.yml`): her fix/security/refactor commit `Closes:` trailer + registry finding ID varlığı doğrular.

PRE_GATE_SHAS allowlist (banned-phrase.ts):
```ts
const PRE_GATE_SHAS = new Set<string>([
  '32839e24', 'f931f935', '2dd09f99', 'b907c235', '7090c950', '4eb35921',
]);
```
Sonraki commit'ler gate'e tabi.

---

## 7. Öncelik sırası (yarın için)

1. **Phase 2 gates (3-4 gün)** — tier-claim-lint, commit-msg-validator, migration-sql-lint, finding-registry CLI, 4 ESLint rule. Bunlar olmadan agent prompt'larındaki "W7 gate yakalar" iddiaları hâlâ havada.
2. **Phase 8.4 mass migration (3-5 gün)** — FE-CRITICAL-001 canlı bug. 419 call site + codegen activation + Stripe webhook DB dedup migration. Kademeli PR'lar (farm → sensor → hr → tenant-admin → admin-panel → dashboard → hydroponics).
3. **Phase 1 W3 conversion finish (2-3 gün)** — 8 agent >200 satır. orchestrator.md özellikle — Phase 0-10 eklemeleriyle şimdi çok büyümüş olabilir.
4. **Phase 4 kalan 2 invariant (1 gün)** — upcaster-chain + three-store (three-store Phase 12 bağımlı).
5. **Phase 12 (3 hafta) — K8s readiness** — registry PG + leader-election + metrics + 429 backpressure. K8s'e geçiş öncesi zorunlu.

---

## 8. Bilinen riskler / devam ederken dikkat

- **Parallel session data-expert.md + infra-expert.md'de çalışıyor** — W3 conversion. Bu dosyalara dokunursan git pull ile çakışır. Commit öncesi `git status --short` ile görünür olmayı koru.
- **orchestrator.md Phase 0-10 sonrası muhtemelen 400+ satır.** Eklemeler Phase 11-14 için routing + roster ekliyor. Convert gerektiğinde routing table'ı `_shared/orchestrator-routing-table.md` dosyasına ayır; phase descriptions `_shared/orchestrator-phases.md`'e git. Agent file salt CATCHER/TEACHER/WRITER + finding-id prefix kalsın.
- **banned-phrase gate kendi commit'lerinde yakalanabilir.** Her commit mesajında `deferred` kelimesi kullanırsan yanında `Phase <N>`, `W<N>`, `abstract-brewing-mochi`, veya `#FINDING-ID` referansı koy.
- **Invariant test 44s süre alıyor.** Phase 14 jest sharding'e kadar bu kalıcı. Yeni agent eklediğinde her defasında çalıştırman gerek.

---

## 9. Master plan + referanslar

- `/root/.claude/plans/abstract-brewing-mochi.md` — 14 phase detaylı (1268 satır)
  - Bölüm I: SİSTEM BOZAN (Phase 0.x) — %100 done
  - Bölüm II: EKSİKLER (Phase 1-7) — Phase 4 %80, Phase 5-6 %100, Phase 7 %60, Phase 2 %20, Phase 3 %0, Phase 1 %0 (parallel session)
  - Bölüm III: KAPSAM GENİŞLETMESİ (Phase 8-14) — Phase 8 %20, Phase 9 %100, Phase 10 %100, Phase 11 %90, Phase 12-14 %0
- `/root/.claude/plans/declarative-riding-shamir.md` — master plan W0-W14 (beyin dökümanı, referans)
- `docs/reviews/orchestrator/2026-04-16-v2-audit.md` — orijinal audit bulguları (P0-1 .. P0-7)
- `docs/reviews/_registry/README.md` — registry yönetim rehberi

---

## 10. Yaklaşık tamamlanma

- **Agent dosyaları side**: 14 yeni + mevcut ~14 = ~28 agent. Planda hedef 38+ (14 yeni Phase 9+10+11, 1 root-cause-auditor bu session'da landed). **%100 tamam Phase 9-11 kapsamında.**
- **Infrastructure side**: registry %100, invariant %80 (4/5), gates %15 (1/6 + 1/8 ESLint), skills %0, K8s readiness %0, test-agents lane %0, dev ergonomics %0. **~%25 overall.**
- **Gerçek production-ready enterprise grade'e mesafe**: ~10-12 hafta (Phase 2 + 3 + 12 eklenirse). Tek session'la ~5-6 hafta paralelleştirilirse.
