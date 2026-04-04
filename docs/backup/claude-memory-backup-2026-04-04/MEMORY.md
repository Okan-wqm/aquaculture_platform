# Aquaculture Platform - Memory

## GitHub Auth
- GH_TOKEN: [REDACTED — set via environment variable, never commit to repo]

## Docker Registry
- GHCR login: `docker login ghcr.io -u Okan-wqm` with PAT (no expiry)
- Images: `ghcr.io/okan-wqm/aquaculture_platform/{service}:latest`

## Database
- Postgres user: `aquaculture`, DB: `aquaculture`
- Schemas: public, auth, admin, billing, sensor, farm, hr, hydroponics + tenant_* per tenant
- TypeORM camelCase convention: no `name:` override = camelCase in DB, raw SQL needs quoted camelCase
- `DATABASE_SYNC=true` → TypeORM synchronize, `DATABASE_SYNC=false` → migrations

## Key Patterns
- Module Federation: each MFE needs `base: '/remotes/{module}/'` in vite.config.ts
- SMTP port 587 = STARTTLS (`secure: false`), port 465 = SSL (`secure: true`)
- Frontend routes use path params (`:token`), not query params (`?token=`)
- User preference: all sub-agents must use Opus 4.6 model
- User preference: Turkish communication
- User preference: commit'lerde Co-Authored-By: Claude satırı KULLANMA, sadece Okan-wqm olarak commit et
- User preference: her zaman main branch'e commit et, feature branch kullanma
- User preference: her commit sonrası GitHub'a push et (main branch)

## Known Issues
- TypeORM duplicate @Index: entity-level `@Index(['col'])` + column-level `@Index()` on same property creates identical hash, crashes sync. Fixed in commit 837a84f.
- Sensor service SourceSchemaBootstrapService has `dropOrphanedIndexes()` but TypeORM's own sync runs BEFORE it (during DataSource.initialize)

## Feedback
- [Agent prompts](feedback_agent_prompts.md) — enterprise-grade detaylı prompt'lar gerekli, kısa task listeleri yeterli değil
- [Zero any policy](feedback_no_any_type.md) — any tipi ASLA kullanılmaz, test mock'larında bile proper typing zorunlu
- [Docs language](feedback_docs_language.md) — tüm kullanım kılavuzları İngilizce ve herkesin anlayacağı basitlikte olmalı
- [GitHub Actions build](feedback_github_actions_build.md) — local build YAPMA, her zaman GitHub Actions CI/CD üzerinden build doğrula
- [Architectural fixes](feedback_architectural_fixes.md) — tüm düzeltmeler mimari çözüm olmalı, yama/patch ASLA kabul edilmez
- [English code comments](feedback_english_code_comments.md) — tüm kod değişikliklerinde İngilizce JSDoc/comment zorunlu

## Project Notes
- [Sensor WQ integration](project_sensor_wq_integration.md) — WQ data entry must support 3 sources: manual, sensor (MQTT/NATS), lab. Architecture accordingly.
- [Dual messaging](project_dual_messaging.md) — İki ayrı mesajlaşma sistemi: (1) Admin→Tenant support (mevcut, admin-api) (2) Tenant-içi WhatsApp-like (ADR-012, yeni messaging-service)
- [AI MCP server](project_ai_mcp_server.md) — AI chat soruları mevcut ai-service MCP server'ına (port 3008) yönlendirilmeli, ayrı pipeline değil
- [AI persona channels](project_ai_persona_channels.md) — Her AI kanalı bir persona'ya bağlı (expert, operator, manager, null=genel). Gelecekte farklı AI MCP server'lar eklenebilmeli.

## Docker Container Names
- aqua-postgres, aqua-redis, aqua-nats, aqua-mosquitto
- aqua-admin-api, aqua-auth, aqua-gateway, aqua-nginx
- aqua-sensor, aqua-farm, aqua-hr, aqua-alert, aqua-billing, aqua-hydroponics, aqua-config
- aqua-shell, aqua-dashboard, aqua-sensor-module, aqua-farm-module, aqua-hr-module, aqua-hydroponics-module, aqua-admin-panel, aqua-tenant-admin
