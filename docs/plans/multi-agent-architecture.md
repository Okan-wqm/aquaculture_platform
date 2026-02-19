# Multi-Agent Code Analysis & Optimization Architecture

## Genel Bakis

60k+ satirlik aquaculture platform icin hiyerarsik, birbirleriyle haberlesen agent sistemi.
Her agent max ~200k token context kullanir, toplam sistem 1M'i asmaz.

---

## Hiyerarsi Agaci

```
                          ┌──────────────────┐
                    L0    │ SYSTEM           │
                          │ ORCHESTRATOR     │
                          └──────┬───────────┘
                                 │
            ┌────────────┬───────┴────────┬──────────────┬─────────────┐
            │            │                │              │             │
      ┌─────▼─────┐ ┌───▼──────┐  ┌──────▼─────┐ ┌─────▼────┐ ┌─────▼─────┐
 L1   │ BACKEND   │ │ FRONTEND │  │ INFRA      │ │ EDGE/IoT │ │ CROSS-CUT │
      │ ORCH.     │ │ ORCH.    │  │ ORCH.      │ │ ORCH.    │ │ ORCH.     │
      └─────┬─────┘ └───┬──────┘  └──────┬─────┘ └─────┬────┘ └─────┬─────┘
            │            │                │              │             │
    ┌───────┤        ┌───┤          ┌─────┤         ┌────┤        ┌───┤
    │       │        │   │          │     │         │    │        │   │
  ┌─▼──┐ ┌─▼──┐  ┌──▼┐ ┌▼──┐   ┌──▼─┐ ┌▼──┐   ┌──▼┐ ┌▼──┐  ┌──▼┐ ┌▼──┐
L2│GW  │ │AUTH│  │SH │ │FM │   │DOC │ │K8S│   │S1 │ │S2 │  │LIB│ │EVT│
  │ORC │ │ORC │  │ORC│ │ORC│   │ORC │ │ORC│   │ORC│ │ORC│  │ORC│ │ORC│
  └─┬──┘ └─┬──┘  └┬──┘ └┬──┘   └─┬──┘ └┬──┘   └┬──┘ └┬──┘  └┬──┘ └┬──┘
    │       │      │     │        │     │       │     │      │     │
  ┌─┤─┐  ┌─┤─┐  ┌─┤─┐ ┌─┤─┐  ┌──┤─┐ ┌─┤─┐            ... (ayni desen)
  │ │ │  │ │ │  │ │ │ │ │ │  │  │ │ │ │ │
  S P B  S P B  S P B S P B  S  P B S P B
  E E U  E E U  E E U E E U  E  E U E E U
  C R G  C R G  C R G C R G  C  R G C R G
```

**S=Security, P=Performance, B=Bug/Quality**

---

## Seviyeler (Levels)

### L0 - System Orchestrator (1 agent)
**Rol**: Tum sistemi koordine eder, sonuclari sentezler, oncelik belirler
**Context Budget**: ~50k token (sadece L1 ozetlerini okur)
**Girdi**: L1 orchestrator raporlari
**Cikti**: `agent-workspace/final-report.md` + `action-plan.md`

### L1 - Domain Orchestrators (5 agent)

| Agent | Sorumluluk | Yonetir |
|-------|-----------|---------|
| **Backend Orch.** | 13 NestJS microservice | L2 service orchestrator'leri |
| **Frontend Orch.** | Shell + 7 microfrontend + mobile + shared-ui | L2 frontend orchestrator'leri |
| **Infra Orch.** | Docker, K8s, Terraform, Helm, CI/CD, Nginx | L2 infra orchestrator'leri |
| **Edge/IoT Orch.** | 2 Rust edge agent projesi | L2 edge orchestrator'leri |
| **Cross-Cutting Orch.** | Shared libs, event contracts, SDK | L2 lib orchestrator'leri |

### L2 - Service/Component Orchestrators (her birim icin 1)

**Backend (13 agent):**
- gateway-api-orch
- auth-service-orch
- farm-service-orch (en buyuk: ~200+ ts dosyasi)
- sensor-service-orch
- alert-engine-orch
- notification-service-orch
- hr-service-orch
- billing-service-orch
- admin-api-service-orch
- config-service-orch
- observability-service-orch
- event-store-service-orch
- hydroponics-service-orch

**Frontend (10 agent):**
- shell-orch
- dashboard-module-orch
- farm-module-orch
- admin-panel-orch
- tenant-admin-orch
- hr-module-orch
- sensor-module-orch
- hydroponics-module-orch
- aquamobil-orch
- shared-ui-orch

**Infrastructure (6 agent):**
- docker-compose-orch
- kubernetes-orch
- terraform-orch
- helm-orch
- ci-cd-orch
- nginx-monitoring-orch

**Edge (2 agent):**
- sens-api-gateway-orch
- sens-repo-orch

**Cross-Cutting (3 agent):**
- backend-common-orch
- event-contracts-orch
- sdk-storage-orch

### L3 - Specialist Agents (her L2 altinda 3 agent)

Her L2 orchestrator 3 uzman agent calistirir:

| Agent | Odak | Kontrol Ettikleri |
|-------|------|-------------------|
| **Security** | Guvenlik | Auth bypass, injection, OWASP Top 10, secret leak, CORS, CSRF, rate limiting, input validation, SQL injection, XSS |
| **Performance** | Performans | N+1 queries, missing indexes, memory leaks, unnecessary re-renders, bundle size, caching strategy, DB query optimization |
| **BugQuality** | Bug & Kalite | Logic errors, race conditions, error handling, dead code, type safety, missing validations, incorrect state management |

---

## Iletisim Protokolu (Blackboard Pattern)

### Dosya Yapisi

```
agent-workspace/
├── blackboard.md                          # Ana durum tablosu
├── codebase-map.md                        # L0 kesfinden cikan harita
│
├── l1-reports/                            # L1 ozet raporlari
│   ├── backend.md
│   ├── frontend.md
│   ├── infrastructure.md
│   ├── edge.md
│   └── cross-cutting.md
│
├── l2-reports/                            # L2 servis raporlari
│   ├── backend/
│   │   ├── gateway-api.md
│   │   ├── auth-service.md
│   │   ├── farm-service.md
│   │   ├── sensor-service.md
│   │   ├── alert-engine.md
│   │   ├── notification-service.md
│   │   ├── hr-service.md
│   │   ├── billing-service.md
│   │   ├── admin-api-service.md
│   │   ├── config-service.md
│   │   ├── observability-service.md
│   │   ├── event-store-service.md
│   │   └── hydroponics-service.md
│   ├── frontend/
│   │   ├── shell.md
│   │   ├── dashboard-module.md
│   │   ├── farm-module.md
│   │   ├── admin-panel.md
│   │   ├── tenant-admin.md
│   │   ├── hr-module.md
│   │   ├── sensor-module.md
│   │   ├── hydroponics-module.md
│   │   ├── aquamobil.md
│   │   └── shared-ui.md
│   ├── infrastructure/
│   │   ├── docker-compose.md
│   │   ├── kubernetes.md
│   │   ├── terraform.md
│   │   ├── helm.md
│   │   ├── ci-cd.md
│   │   └── nginx-monitoring.md
│   ├── edge/
│   │   ├── sens-api-gateway.md
│   │   └── sens-repo.md
│   └── cross-cutting/
│       ├── backend-common.md
│       ├── event-contracts.md
│       └── sdk-storage.md
│
├── l3-findings/                           # L3 uzman bulgulari
│   ├── backend/
│   │   ├── gateway-api/
│   │   │   ├── security.md
│   │   │   ├── performance.md
│   │   │   └── bug-quality.md
│   │   ├── auth-service/
│   │   │   ├── security.md
│   │   │   ├── performance.md
│   │   │   └── bug-quality.md
│   │   └── ... (her servis icin ayni)
│   ├── frontend/
│   │   └── ... (ayni desen)
│   ├── infrastructure/
│   │   └── ...
│   └── edge/
│       └── ...
│
├── cross-references/                      # Servisler arasi iliskiler
│   ├── api-contract-issues.md            # Servisler arasi API uyumsuzluklari
│   ├── event-flow-issues.md              # NATS event akis sorunlari
│   ├── schema-sync-issues.md            # Tenant schema uyumsuzluklari
│   ├── dependency-conflicts.md           # Paket versiyon catismalari
│   └── security-chain-issues.md          # Auth zinciri boyunca guvenlik aciklari
│
└── action-plan/
    ├── critical.md                        # Hemen yapilmasi gereken (guvenlik aciklari)
    ├── high-priority.md                   # Onemli buglar ve performans sorunlari
    ├── medium-priority.md                 # Kalite iyilestirmeleri
    └── low-priority.md                    # Nice-to-have gelistirmeler
```

### Mesaj Formati (Agent-to-Agent)

Her agent bulgusunu su formatta yazar:

```markdown
## [SEVERITY: CRITICAL|HIGH|MEDIUM|LOW] Baslik

**Agent**: L3/backend/auth-service/security
**Tarih**: 2026-02-18
**Dosya**: apps/auth-service/src/modules/authentication/services/authentication.service.ts
**Satir**: 45-67

### Bulgu
Aciklama...

### Etki
Bu sorun ne yapabilir...

### Onerilen Cozum
```code
// fix suggestion
```

### Iliskili Agentlar
- @L3/backend/gateway-api/security - Gateway'deki auth guard'a da bakin
- @L3/cross-cutting/event-contracts/bug-quality - Event contract'ta eksik field
```

---

## Calisma Fazlari

### Faz 1: Kesif (1 agent, ~2 dakika)
- Codebase haritasini cikar
- `codebase-map.md` olustur
- Her servisi boyut/karmasiklik olarak siniflandir

### Faz 2: L3 Uzman Analizi (paralel, ~5-10 dakika)
**Dalga 2a** - Buyuk servisler (paralel):
- farm-service (3 agent: sec + perf + bug)
- sensor-service (3 agent)
- gateway-api (3 agent)
- auth-service (3 agent)
- admin-api-service (3 agent)

**Dalga 2b** - Orta servisler (paralel):
- hr-service, billing-service, alert-engine
- Shell, farm-module, admin-panel, sensor-module
- Docker, K8s, CI/CD

**Dalga 2c** - Kucuk servisler + edge (paralel):
- notification, config, observability, event-store, hydroponics
- aquamobil, dashboard, shared-ui
- Terraform, Helm, Nginx
- sens-api-gateway, sens-repo

### Faz 3: L2 Sentez (paralel, ~3 dakika)
- Her L2 orchestrator kendi L3 bulgularini okur
- Servis ici capraz referanslar cikarir
- L2 raporu yazar

### Faz 4: L1 Sentez (paralel, ~2 dakika)
- Her L1 orchestrator kendi L2 raporlarini okur
- Domain-ici capraz referanslar cikarir
- L1 raporu yazar

### Faz 5: Cross-Service Analiz (1 agent, ~2 dakika)
- Servisler arasi API contract uyumsuzluklari
- Event flow sorunlari (NATS)
- Tenant schema senkronizasyon sorunlari
- Dependency conflict'ler
- Auth zinciri boyunca guvenlik analizi

### Faz 6: L0 Final Sentez (1 agent, ~2 dakika)
- Tum L1 raporlarini + cross-service analizini okur
- Oncelikli aksiyon plani olusturur
- Critical/High/Medium/Low siniflandirmasi yapar

---

## Context Budget Hesaplama

| Seviye | Agent Sayisi | Context/Agent | Toplam |
|--------|-------------|---------------|--------|
| L3 Specialist | ~100 | ~50-150k | Her biri bagimsiz |
| L2 Orchestrator | ~34 | ~30-80k | Sadece L3 ozetleri |
| L1 Orchestrator | 5 | ~40-100k | Sadece L2 ozetleri |
| L0 Orchestrator | 1 | ~50-100k | Sadece L1 ozetleri |
| Cross-Service | 1 | ~80-150k | API contracts + events |

**Hicbir agent 200k token'i gecmez** (1M limitinin %20'si).

### Buyuk Servisler Icin Parca Stratejisi

farm-service 200+ dosya, tek agent'a sigmayabilir. Cozum:
- Her L3 agent, servisi modullere bolerek analiz eder
- Ornek: farm-service security agent → farm/, tank/, batch/, equipment/, feeding/ ayri ayri tarar
- Her modul icin sub-findings yazar, sonra birlestirir

---

## Pratik Claude Code Implementasyonu

Claude Code'da agent'lar `Task` tool ile calisir. Gercek implementasyon:

```
# Faz 2 ornegi - 5 paralel Task cagirisi
Task(subagent_type="general-purpose", prompt="""
Sen L3/backend/gateway-api/security agent'isin.

## Gorevin
apps/gateway-api/ altindaki tum kodu oku ve guvenlik acisi analiz et.

## Kontrol Listesi
- [ ] Auth guard bypass olasiliği
- [ ] Rate limiting config yeterliligi
- [ ] Input validation eksiklikleri
- [ ] CORS policy dogru mu
- [ ] Secret/credential hardcode var mi
- [ ] SQL/NoSQL injection riskleri
- [ ] Header injection riskleri
- [ ] WebSocket security
- [ ] OPA policy bypasslari
- [ ] Middleware sirasi dogru mu

## Onemli
- Sadece apps/gateway-api/ ve ilgili shared lib'lere bak
- Bulgularini agent-workspace/l3-findings/backend/gateway-api/security.md'ye yaz
- @mention formatinda diger agent'lari etiketle
""")
```

---

## Agent Tipleri ve Prompt Sablonlari

### L3 Security Agent Template
```
Sen {SERVICE_PATH} icin guvenlik analiz agentisin.
Kontrol et:
1. Authentication/Authorization bypass
2. Input validation & sanitization
3. Injection vulnerabilities (SQL, NoSQL, Command, LDAP)
4. Secrets management (hardcoded credentials, .env exposure)
5. CORS/CSRF/SSRF
6. Rate limiting & DoS protection
7. Data exposure (PII, logs, error messages)
8. Dependency vulnerabilities (package.json audit)
9. Multi-tenant isolation (search_path, schema leakage)
10. Cryptographic issues (weak algorithms, key management)
```

### L3 Performance Agent Template
```
Sen {SERVICE_PATH} icin performans analiz agentisin.
Kontrol et:
1. N+1 query problemleri (TypeORM relations eager loading)
2. Missing database indexes
3. Unnecessary data fetching (SELECT *)
4. Memory leaks (event listeners, subscriptions)
5. Caching strategy (Redis usage, cache invalidation)
6. Connection pooling configuration
7. Batch processing vs one-by-one
8. Async/await anti-patterns (sequential where parallel possible)
9. Bundle size (frontend - unused imports, tree shaking)
10. Re-render optimization (React memo, useMemo, useCallback)
```

### L3 Bug/Quality Agent Template
```
Sen {SERVICE_PATH} icin bug ve kod kalitesi analiz agentisin.
Kontrol et:
1. Logic errors & off-by-one bugs
2. Race conditions & concurrency issues
3. Error handling gaps (unhandled promises, missing try-catch)
4. Null/undefined safety (optional chaining, nullish coalescing)
5. Type safety issues (any types, incorrect casts)
6. Dead code & unused exports
7. Incorrect state management (stale closures, missing deps)
8. API contract mismatches (DTO vs entity fields)
9. Missing validations (class-validator decorators)
10. README/documentation accuracy
```

### L2 Orchestrator Template
```
Sen {SERVICE_NAME} orchestrator'usun.
L3 agent bulgularini oku:
- l3-findings/{domain}/{service}/security.md
- l3-findings/{domain}/{service}/performance.md
- l3-findings/{domain}/{service}/bug-quality.md

Gorevlerin:
1. Bulgulari birbirleriyle iliskilendir
2. Ayni root cause'tan kaynaklanan farkli semptomlari grupla
3. Oncelik sirasi belirle (Critical > High > Medium > Low)
4. Diger servisleri etkileyen sorunlari @mention ile isaretle
5. Ozet raporu l2-reports/{domain}/{service}.md'ye yaz
```

### L1 Domain Orchestrator Template
```
Sen {DOMAIN} domain orchestrator'usun.
Tum L2 raporlarini oku: l2-reports/{domain}/*.md

Gorevlerin:
1. Domain genelindeki ortak sorunlari tespit et
2. Servisler arasi bagimliliklardaki sorunlari isaretle
3. Domain-capinda guvenlik, performans, kalite skoru ver
4. En kritik 10 bulguyu listele
5. Raporu l1-reports/{domain}.md'ye yaz
```

---

## Toplam Agent Sayisi

| Seviye | Sayi | Detay |
|--------|------|-------|
| L0 System Orchestrator | 1 | |
| L1 Domain Orchestrators | 5 | Backend, Frontend, Infra, Edge, Cross-Cut |
| L2 Service Orchestrators | 34 | 13 backend + 10 frontend + 6 infra + 2 edge + 3 cross-cut |
| L3 Specialists | 102 | 34 x 3 (security + performance + bug) |
| Cross-Service Analyzer | 1 | |
| **TOPLAM** | **143** | |

Ama tek seferde max 5-10 paralel agent calisir (Claude Code limiti).
Dalga dalga calistirilir.

---

## Beklenen Ciktilar

1. **Final Report** - Tum sistemin saglik raporu
2. **Action Plan** - Oncelikli is listesi (Critical → Low)
3. **Security Audit** - Guvenlik aciklari raporu
4. **Performance Audit** - Performans iyilestirme onerileri
5. **Bug List** - Tespit edilen buglar ve fix onerileri
6. **Architecture Review** - Mimari iyilestirme onerileri
7. **Cross-Service Issues** - Servisler arasi entegrasyon sorunlari
8. **Dependency Report** - Paket versiyon/guvenlik durumu
