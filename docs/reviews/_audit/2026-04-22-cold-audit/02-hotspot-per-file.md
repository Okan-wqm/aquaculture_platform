# Hotspot per file — top 30

Cycle: `2026-04-22-cold-audit`  •  Source: deterministic aggregation of `01-signals/*`  •  Formula: see `tools/audit/aggregate-hotspots.ts` header.

Scored files total: **537**.

| # | Score | File | Signals |
|---|---|---|---|
| 1 | 134 | `docker-compose.droplet.yml` | 1·churn(104)=104 + 5·openFind(6)=30 |
| 2 | 88 | `.github/workflows/deploy-digitalocean.yml` | 1·churn(88)=88 |
| 3 | 54 | `docs/reviews/_registry/findings.jsonl` | 1·churn(54)=54 |
| 4 | 52 | `apps/farm-service/src/app.module.ts` | 1·churn(52)=52 |
| 5 | 51 | `libs/backend-common/src/database/schema-manager.service.ts` | 1·churn(31)=31 + 5·openFind(4)=20 |
| 6 | 49 | `apps/sensor-service/src/ingestion/mqtt-listener.service.ts` | 3·getRepo(4)=12 + 1·churn(37)=37 |
| 7 | 46 | `apps/auth-service/src/modules/authentication/services/authentication.service.ts` | 3·getRepo(8)=24 + 1·churn(22)=22 |
| 8 | 45 | `package.json` | 1·churn(45)=45 |
| 9 | 45 | `apps/sensor-service/src/app.module.ts` | 1·churn(45)=45 |
| 10 | 43 | `package-lock.json` | 1·churn(43)=43 |
| 11 | 42 | `libs/backend-common/src/database/index.ts` | 1·churn(42)=42 |
| 12 | 42 | `apps/hr-service/src/app.module.ts` | 2·dupBlk(1)=2 + 1·churn(40)=40 |
| 13 | 39 | `apps/farm-service/src/storage/handlers/record-stock-movement.handler.ts` | 3·asAny(1)=3 + 3·getRepo(12)=36 |
| 14 | 38 | `apps/sensor-service/src/automation/automation.service.ts` | 3·getRepo(6)=18 + 1·churn(20)=20 |
| 15 | 37 | `apps/sensor-service/src/edge-device/edge-device.service.ts` | 3·getRepo(1)=3 + 1·churn(34)=34 |
| 16 | 36 | `apps/admin-api-service/src/app.module.ts` | 1·churn(36)=36 |
| 17 | 35 | `apps/gateway-api/src/app.module.ts` | 1·churn(35)=35 |
| 18 | 34 | `sens-api-gateway/src/main.rs` | 1·churn(34)=34 |
| 19 | 33 | `apps/auth-service/src/app.module.ts` | 1·churn(33)=33 |
| 20 | 33 | `.github/workflows/ci-affected.yml` | 1·churn(33)=33 |
| 21 | 32 | `libs/backend-common/src/index.ts` | 1·churn(32)=32 |
| 22 | 31 | `apps/alert-engine/src/app.module.ts` | 1·churn(31)=31 |
| 23 | 31 | `apps/messaging-service/src/channel/entities/channel-member.entity.ts` | 5·openFind(6)=30 + 1·circ(1)=1 |
| 24 | 30 | `apps/messaging-service/src/app.module.ts` | 1·churn(30)=30 |
| 25 | 30 | `apps/billing-service/src/app.module.ts` | 1·churn(30)=30 |
| 26 | 28 | `sens-api-gateway/Cargo.toml` | 1·churn(28)=28 |
| 27 | 28 | `apps/config-service/src/app.module.ts` | 1·churn(28)=28 |
| 28 | 28 | `apps/hydroponics-service/src/app.module.ts` | 2·dupBlk(1)=2 + 1·churn(26)=26 |
| 29 | 27 | `apps/farm-service/src/scheduler/feeding-scheduler.service.ts` | 3·getRepo(9)=27 |
| 30 | 27 | `apps/notification-service/src/app.module.ts` | 2·dupBlk(1)=2 + 1·churn(25)=25 |
