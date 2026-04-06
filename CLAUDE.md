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

## Architectural Approach (Root-Cause Only)

Her hata için test: "Upstream doğru olsaydı bu koda gerek olur muydu?"

- Interface/type uyumsuzluğu → interface'i veya implementasyonu düzelt
- Eksik entity field → entity'ye @Column ekle, DTO'ya field ekle
- Cross-service tutarsızlık → event contract'ı VE her iki service tarafını düzelt
- ASLA: defensif `?.` ile crash'i gizleme
- ASLA: JSON column'a kaçarak tip sistemini bypass etme
- ASLA: compat shim / adapter layer ekleme (tek seferlik workaround)

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
