# Claude Code Configuration

## Behavioral Rules (Always Enforced)

- Do what has been asked; nothing more, nothing less
- NEVER create files unless they're absolutely necessary for achieving your goal
- ALWAYS prefer editing an existing file to creating a new one
- NEVER proactively create documentation files (*.md) or README files unless explicitly requested
- NEVER save working files, text/mds, or tests to the root folder
- ALWAYS read a file before editing it
- NEVER commit secrets, credentials, or .env files

## Git & Deployment Rules

- Co-Authored-By satırı ASLA commit mesajına eklenmeyecek
- Commit sonrası her zaman `git push` yapılacak (aktif branch'e)
- Force push (`--force`, `--force-with-lease`) YASAK

## Review Finding Traceability (MANDATORY)

Her fix commit'i kapattığı review finding'lerine **formal olarak referans vermeli**. Aksi halde `docs/reviews/` klasörü infinite growing knowledge base olur, "audit theater" anti-pattern'i oluşur.

**Commit message format:**
```
{type}({scope}): {subject}

{body explaining the change}

Closes: docs/reviews/{agent}/{YYYY-MM-DD}-{topic}.md#{finding-id}
Closes: docs/reviews/{agent}/{YYYY-MM-DD}-{topic}.md#{finding-id}
```

**Kurallar:**
- Bir fix birden fazla finding kapatabilir — her biri ayrı `Closes:` satırı
- Finding ID format: `{severity}-{sequential}` (örn: `CRITICAL-001`, `HIGH-003`, `MEDIUM-012`)
- Reviewer agents HER finding'e unique ID vermek zorunda (prompt-writer rule §...)
- `Closes:` referansı olmadan fix commit'i = PROCESS MEDIUM (review traceability boşluğu)
- Security CRITICAL fix commit'leri `Closes:` olmadan = PROCESS HIGH

**State machine (context-manager tarafından track edilir):**
- `OPEN` → finding var, henüz commit yok
- `IN-PROGRESS` → implementation-planner package'ına dahil ama commit henüz yok
- `RESOLVED` → commit message'da `Closes:` referansı var, commit merge edildi
- `STALE` → 30 gün OPEN kaldı, weekly escalation
- `BLOCKED` → fix attempt fail etti veya architectural-arbiter'a escalate edildi

**implementation-planner package'ları için:**
Her package `NN-{slug}.md` dosyası `Closing-Findings: [list]` field'ı içermeli. Executor (main Claude veya CI) commit ederken bu field'ı kopyalayarak commit message'a `Closes:` satırları ekler.

## File Organization

- NEVER save to root folder — use the directories below
- Use `/src` for source code files
- Use `/tests` for test files
- Use `/docs` for documentation and markdown files
- Use `/config` for configuration files
- Use `/scripts` for utility scripts
- Use `/examples` for example code
- Her bounded context kendi dizininde: `apps/{service}/src/{domain}/`
- Handler, entity, DTO, event aynı domain dizininde olmalı

## Project Architecture

- Follow Domain-Driven Design with bounded contexts
- Keep files under 500 lines
- Use typed interfaces for all public APIs
- Prefer TDD London School (mock-first) for new code
- Use event sourcing for state changes
- Ensure input validation at system boundaries

## Code Quality Standards

- `as any` YASAK — doğru tipi bul veya generic yaz
- `// @ts-ignore` ve `// @ts-expect-error` YASAK — tip hatasını düzelt
- `as unknown as X` casting hack'leri YASAK — interface'i veya implementasyonu düzelt
- `getRepository()` YASAK → `getScopedRepository()` kullan (tenant isolation)
- Floating promise YASAK → her async çağrı `await` edilmeli
- `console.log` YASAK → NestJS `Logger` kullan
- Her public fonksiyonda explicit return type zorunlu
- Event objeleri `@platform/event-contracts` interface'lerine tam uyumlu olmalı
- Entity değişikliği gerekiyorsa entity'ye `@Column` ekle, cast yapma

## Architectural Approach (Root-Cause Only — ZAMAN MAZERET DEĞİLDİR)

**MUTLAK KURAL (2026-04-14 tarafından pekiştirildi):** Her fix, her zaman MIMARI çözüm olmalı. Yama YASAK. Basite kaçma YASAK. Arkadan dolanma YASAK. Görmezden gelme YASAK. **Mimari çözüm ne kadar uzun sürse, o kadar uzun sürer — yine de mimari çözüm yapılacak.**

Her hata için test: "Upstream doğru olsaydı bu koda gerek olur muydu?"

- Interface/type uyumsuzluğu → interface'i veya implementasyonu düzelt
- Eksik entity field → entity'ye @Column ekle, DTO'ya field ekle
- Cross-service tutarsızlık → event contract'ı VE her iki service tarafını düzelt
- ASLA: defensif `?.` ile crash'i gizleme
- ASLA: JSON column'a kaçarak tip sistemini bypass etme
- ASLA: compat shim / adapter layer ekleme (tek seferlik workaround)

**Mimari çözüm hiyerarşisi (her zaman en yükseği seç):**

1. **Imkânsız kıl** (en iyi): Tip sistemi / compiler / runtime yanlış davranışı yapısal olarak engeller
2. **Otomatik kıl** (harika): Doğru davranış sıfır geliştirici eforuyla varsayılan olur
3. **Tespit edilebilir kıl** (iyi): Yanlış davranış build/test zamanında yakalanır
4. **Belgelenmiş kıl** (son çare): Sadece 1-3 imkânsızsa

**Mazeret olarak KULLANILMAYACAK gating ifadeler:**

- "şimdilik" / "geçici çözüm" / "interim"
- "pragmatik" / "daha basit yaklaşım"
- "momentum için" / "bu commit için"
- "follow-up commit ele alır" — follow-up AYNI PR'da veya tracked plan phase olmalı, vague gelecek olmaz
- "deferred" — explicit owner + deadline + tracked finding ID olmadan deferred yasak
- "out of scope" — eğer ilgili bir endişe ortaya çıkarsa, scope'u genişlet veya işi reddet; sessizce ertelemek YASAK
- "good enough" / "şimdilik yeterli"

**Eğer mimari çözüm gerçekten bu session'da landing edemiyorsa:**

- CRITICAL/HIGH severity tracked finding aç
- ADR veya plan'ı güncelle: explicit owner + deadline + finding ID
- Partial fix'i tamammış gibi shipe etme — commit message'da NE YAPILMADIĞI ve NEDEN explicit yazılmalı
- PR description'da unresolved architectural debt açıkça listele

Hızlı düzeltmenin maliyeti sonsuza kadar ödenir; doğru düzeltmenin maliyeti bir kez ödenir.

## Code Documentation

- Kritik yerlerde marker yorumlar: `// SECURITY:`, `// LIFE-SAFETY:`, `// WHY:`, `// IMPORTANT:`
- Her public fonksiyona JSDoc (parametre açıklamaları dahil)
- 20+ satırlık fonksiyonlarda `// ── Section ──` başlıkları ile bölümleme
- Event, entity ve command'larda domain anlamını açıklayan doc block

## Event Contracts

- Tüm event'ler `BaseEvent` extend etmeli (`libs/event-contracts/src/base-event.ts`)
- `createBaseEvent()` ile oluştur — eventId, timestamp, version otomatik
- Flat-object pattern: iç içe `payload` veya `metadata` objesi YASAK
- Tüm zorunlu field'lar doldurulmalı — eksik field ile publish YASAK
- `eventType` PascalCase (örn: `TenantCreated`, `BatchHarvested`)

## Schema Ownership (ZORUNLU — ADR-011)

- Her `@Entity()` MUTLAKA `schema:` opsiyonu içermeli — `@Entity('table', { schema: 'farm' })`
- `public` schema'sına yeni table eklemek YASAK — owning service'in schema'sına git
- Cross-service shared tablolar `shared` schema'da (audit_logs, gdpr_data_requests, user_consents, user_permissions) — yenisi eklemek için PR review + `SHARED_SCHEMA_TABLES` (e2e/tests/integration/schema-invariants.spec.ts) güncelle
- CI invariant test her PR'da çalışır; runtime drift validator (`createSchemaDriftValidator`) her cold start'ta tetiklenir
- Migration runner her bootstrap-pattern service'te wired olmalı (createMigrationRunnerService factory). Runtime bootstrap-only schema pattern'leri DEPRECATED — yeni schema değişikliği migration olarak gönder, bootstrap olarak değil

## Migration Runners (ZORUNLU — ADR-011, ADR-012)

- Her backend service `apps/<svc>/src/database/migrations/` dizinine sahip olmalı
- Her service `apps/<svc>/src/database/data-source.ts` (TypeORM CLI için) içermeli
- Her service `app.module.ts`'inde `createMigrationRunnerService('<schema>')`'ı provider olarak kayıt etmeli
- TypeOrmModule config'inde `migrations: [...glob], migrationsRun: false` (runner çalıştırır, TypeORM değil)
- Production'da `DATABASE_MIGRATIONS_RUN=false` YASAK (runner hard-fail eder)

## NATS Authentication (ZORUNLU — ADR-014, ADR-015)

- NATS kimliği SADECE mTLS client cert CN'inden gelir (`verify_and_map: true`). Kullanıcı adı/parola auth YASAK — server CONNECT-frame user/pass'i ignore eder
- `infrastructure/nats/services.yaml` tek source of truth — yeni NATS servisi eklemek için: services.yaml + cert CN + `scripts/nats/generate-nats-conf.py` çalıştır (üçü aynı commit'te — CI invariant enforces)
- `infrastructure/docker/nats/nats.conf` authorization{} users[] bloğu **GENERATED** — `# BEGIN GENERATED` / `# END GENERATED` sentinels arası el-edit YASAK (invariant test fails)
- `nats.conf` authorization block'ta `password:` field YASAK (verify_and_map handles identity; passwords redundant drift vector)
- `nats.conf` authorization block'ta `$NATS_*_USER` / `$NATS_*_PASS` substitution YASAK (literal user names only, matching cert CNs)
- Client libraries (`libs/backend-common/src/nats/nats-connection.factory.ts`) mtls-cert mode'da user/pass/token alanları CONNECT frame'ine yazmaz — cert-only means cert ONLY
- Operator how-to: `docs/runbooks/nats-service-addition.md`
- CI invariant: `e2e/tests/integration/nats-invariants.spec.ts`

## Build & Test

```bash
# Build
npm run build

# Test
npm test

# Lint
npm run lint
```

- ALWAYS run tests after making code changes
- ALWAYS verify build succeeds before committing

## Security Rules

- NEVER hardcode API keys, secrets, or credentials in source files
- NEVER commit .env files or any file containing secrets
- Always validate user input at system boundaries
- Always sanitize file paths to prevent directory traversal
- Review security implications of all changes before committing
- PII (isim, email, telefon) log'larda maskelenmeli — hash veya `***` kullan
- Structured logging (JSON) kullan — string concatenation ile log YASAK

## Concurrency

- All operations MUST be concurrent/parallel in a single message
- ALWAYS batch ALL file reads/writes/edits in ONE message
- ALWAYS batch ALL Bash commands in ONE message
