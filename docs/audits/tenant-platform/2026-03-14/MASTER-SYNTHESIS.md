# Enterprise Tenant Platform -- Master Synthesis & Implementation Plan

**Tarih:** 2026-03-14
**Kaynak:** 19 keşif raporu (D01-D20, D15 hariç)
**Kapsam:** 13 backend + 10 frontend + infra + edge + mobil

---

## 1. KRİTİK BULGULAR KONSOLİDASYONU

### 1.1 Güvenlik (CRITICAL + HIGH)

| ID | Bulgu | Kaynak | Etki |
|----|-------|--------|------|
| SEC-001 | Tenant permission matrix enforce edilmiyor | D01 | RBAC cosmetic |
| SEC-002 | Gateway PermissionGuard role name mismatch | D01 | Permission guard non-functional |
| D12-F01 | 5 servis TenantGuard APP_GUARD eksik (hr dahil) | D12 | Tenant isolation gap |
| D14-RB01 | ProtectedRoute role hierarchy yok | D14 | SUPER_ADMIN tenant paneline erişemez |
| D14-SC01 | SRI hash pinning yok | D14 | MF supply chain risk |
| D05-H1 | Farm schema fallback farm'a yazma | D05 | Cross-tenant data leak |
| D02-015 | SUPER_ADMIN null tenantId ile beklenmeyen davranış | D02 | Query hataları |
| D09-F01 | Client-side pricing manipülasyonu | D09 | Gelir kaybı |
| D09-F04 | Stripe ödeme doğrulaması yok | D09 | Sahte ödeme |
| D10-F1 | SMS/Push provider mock | D10 | CRITICAL alarm iletilmez |

### 1.2 Event Contract Kırıkları (CRITICAL)

| ID | Bulgu | Kaynak |
|----|-------|--------|
| D11-3.1 | billing flat/nested payload mismatch | D11 |
| D11-3.2 | gateway SensorReadingReceived vs SensorReading | D11 |
| D11-3.3 | gateway flat/nested NatsEvent mismatch | D11 |
| D11-3.4 | HR eventType snake_case vs PascalCase | D11 |
| D11-3.6 | 4 phantom event (publisher yok) | D11 |
| D11-14 | Duplicate subscriber TaskAssigned/TaskOverdue | D11 |

### 1.3 Operasyonel Eksiklikler (HIGH)

| ID | Bulgu | Kaynak |
|----|-------|--------|
| D09-F02 | Trial→Active otomatik geçiş yok | D09 |
| D09-F03 | Otomatik fatura üretimi yok | D09 |
| D10-F2 | Cooldown GET+SET race condition | D10 |
| D10-F5 | Dead letter queue yok | D10 |
| D18 | Dashboard %100 mock veri | D18 |
| D02-003 | Password reset flow eksik | D02 |
| D02-008 | Suspended tenant login engellenmiyor | D02 |
| D05-M1 | RecordMortality transaction yok | D05 |
| D06-H1 | Payroll floating-point precision | D06 |
| D06-H3 | Offshore rotasyon çakışma kontrolü yok | D06 |

### 1.4 Test Coverage Krizi

| Modül | Test | Kritik Eksik |
|-------|------|-------------|
| tenant-admin FE | 0 | User CRUD, role mgmt |
| AquaMobil | 0 | Offline queue, auth |
| shared-ui | 0 | AuthContext, api-client |
| dashboard | 1 | Mock widget'lar |
| farm-service | 14/725 | feeding, harvest, tank |
| sensor-service | 18 | MQTT auth, middleware |
| billing-service | 8 (mock) | Handler testleri |

---

## 2. FIX SIRASI (Bağımlılık Güvenli)

```
WAVE 1 -- Platform Temelleri
├── backend-common: Guard eksiklikleri (TenantGuard, RolesGuard)
├── event-contracts: NATS subject/payload mismatch
├── shared-ui: RestClient fix, placeholder cleanup
└── shell: ProtectedRoute hierarchy, module access guard

WAVE 2 -- Auth & RBAC
├── gateway: PermissionGuard role name fix
├── auth-service: Permission enforcement, password reset, suspended tenant
└── tenant-admin: Frontend route guards

WAVE 3 -- Veri Akışı & Operasyonel
├── sensor: Legacy topic deprecation, payload limit
├── farm: Schema fallback kaldır, mortality transaction
├── hr: Payroll decimal, offshore rotation, certification
├── billing: Server-side pricing, trial scheduler, NATS events
├── alert: Cooldown SET NX, auto-resolve, severity allowlist
└── notification: DLQ, SMS/Push provider, duplicate handler

WAVE 4 -- Frontend & Dashboard
├── dashboard: Mock → gerçek API
├── sensor-module: AlertsPage real API, calibration
├── tenant-admin: Enterprise pages (audit, billing, activity)
└── AquaMobil: Fail-closed defaults, cache encryption

WAVE 5 -- Kalite & Observability
├── Test coverage
├── OpenTelemetry activation
├── SRI hash, CSP, non-root containers
└── Prometheus instrumentation
```

---

## 3. WAVE DETAYLARI

### WAVE 1: Platform Temelleri (8 paralel ajan)

**1A. Guard Düzeltmeleri**
- hr-service app.module.ts: TenantGuard APP_GUARD ekle
- farm-service: RolesGuard APP_GUARD ekle
- billing-service: RolesGuard APP_GUARD ekle
- alert-engine: RolesGuard APP_GUARD ekle
- Health endpoint'lerin @Public() olduğunu doğrula

**1B. Event Contract: billing flat/nested**
- `tenant-subscription-requested.handler.ts`: `event.payload.tenantId` → `event.tenantId`

**1C. Event Contract: gateway sensor**
- `nats-bridge.service.ts`: `events.SensorReadingReceived` → `events.SensorReading`
- `NatsEvent` interface'i flat yapıya uyumlu hale getir

**1D. Event Contract: HR eventType**
- attendance events: `attendance.clocked_in` → `EmployeeClockedIn`
- training events: `certification.added` → `CertificationAdded`

**1E. Notification duplicate handler**
- `TaskAssignedEventHandler` deprecated et, `TaskEventHandler` tek handler

**1F. shared-ui fixes**
- RestClient satır 477: `accessToken` → `getAccessToken()`
- Placeholder hooks kaldır veya implement et
- `graphql` paketini dependencies'e ekle

**1G. Shell ProtectedRoute hierarchy**
- `requiredRoles.some(role => user?.role === role)` → `hasRoleOrHigher()` kullan
- SUPER_ADMIN /tenant/* erişimi aç

**1H. Shell module access guard**
- ProtectedRoute'a `requiredModule` prop ekle
- `hasModuleAccess(moduleCode)` ile kontrol

### WAVE 2: Auth & RBAC (6 paralel ajan)

**2A. Gateway PermissionGuard**
- ROLE_PERMISSIONS key'leri: `system_admin` → `SUPER_ADMIN` enum
- ROLE_HIERARCHY aynı şekilde düzelt

**2B. Panel Permission Enforcement**
- TenantPermissionGuard oluştur (backend-common)
- Redis cache ile role permissions (60s TTL)
- `@RequireTenantPermission('farm.tanks.create')` decorator

**2C. Password Reset Flow**
- `forgotPassword(email)` mutation
- `resetPassword(token, newPassword)` mutation
- Token SHA-256 hash ile sakla

**2D. Auth Security Fixes**
- Login: Tenant status kontrolü (SUSPENDED/CANCELLED → reject)
- Self-deletion: `userId !== targetUserId` check
- Invitation token: Plaintext → SHA-256 hash
- JwtAuthGuard: APP_GUARD olarak tanımla

**2E. Tenant-Admin Route Guards**
- /tenant/* route'larında role check component
- Permission-based UI filtering

**2F. Audit Log Genişletme**
- Deactivate, role change, invitation accept logla
- Tenant create, password reset logla

### WAVE 3: Veri Akışı (12 paralel ajan)

**3A. Sensor Service**
- `LEGACY_EDGE_TOPICS_ENABLED` config flag
- MQTT payload size limit: 256KB
- search_path: SET → SET LOCAL (transaction-scoped)

**3B. Farm Schema & Mortality**
- TenantSchemaMiddleware: Fallback kaldır → UnauthorizedException
- RecordMortalityHandler: QueryRunner transaction ekle

**3C. Farm Batch Lifecycle**
- CloseBatchHandler: `isActive = false`
- CreateHarvestRecordHandler: `currentQuantity === 0` → status güncelle
- Department cascade: Soft delete veya pre-delete kontrol

**3D. HR Payroll & Offshore**
- Payroll: `Math.round(value * 100) / 100` veya Decimal.js
- Offshore rotation: Tarih çakışma kontrolü
- SafetyTrainingRecord: @VersionColumn() ekle

**3E. HR Certification-Offshore**
- CertificationExpiredEvent → employee.seaWorthy = false
- Clock-in: Offshore mandatory sertifika kontrolü
- Leave resolver: userId → employeeId mapping fix

**3F. Billing Pricing & Trial**
- Server-side pricing: Plan tier minimum fiyat validasyonu
- Trial scheduler: @Cron ile trialEndDate kontrolü
- PAST_DUE/SUSPENDED status geçişleri

**3G. Billing NATS & Invoice**
- EventEmitter2 → @platform/event-bus (NATS)
- Auto-invoice: currentPeriodEnd cron
- Overdue detection cron

**3H. Alert Cooldown & Resolve**
- Cooldown: GET+SET → SET NX EX ttl
- Severity allowlist: 3 → 6 severity
- Auto-resolve: Normal aralık → incident resolve

**3I. Alert Ack Redis**
- AcknowledgmentTracker: In-memory Map → Redis Hash
- Audit log: In-memory → PostgreSQL

**3J. Notification DLQ & Provider**
- NATS JetStream dead letter subject tanımla
- SMS: Twilio veya AWS SNS implement et
- Push: Firebase implement et (config mevcut)

**3K. Config Upsert History**
- UpsertConfigurationHandler: History kaydı ekle

**3L. Farm Cascade Protection**
- Department: onDelete CASCADE → pre-delete check
- Soft delete pattern uygula

### WAVE 4: Frontend & Dashboard (6 paralel ajan)

**4A. Dashboard KPI & Widgets**
- Mock veri → GraphQL query (tenant stats, sensor count, alert count)
- OverviewWidgets: farm/sensor/alert API bağlantısı

**4B. Dashboard Real-time**
- LiveSensorWidget: WebSocket entegrasyonu
- ProductionChart: farm-service batch/harvest verileri

**4C. Sensor Module Pages**
- AlertsPage: Mock → alert-engine GraphQL
- CalibrationPage: Backend calibration modülüne bağla

**4D. Tenant-Admin Enterprise**
- Audit log görüntüleme sayfası
- Billing/subscription durum sayfası
- User activity log
- Edge device yönetim (tenant-scoped)

**4E. AquaMobil Security**
- Default permissions: true → false (fail-closed)
- Cache store: AES-GCM encryption uygula
- Queue metadata encryption

**4F. AquaMobil UX**
- Password validation: 6 → 8 tutarlılık
- Manifest scope tutarlılığı
- Firebase SW Türkçe → İngilizce

### WAVE 5: Kalite & Observability (8 paralel ajan)

**5A-5D. Test Coverage** (4 ajan)
- auth-service: TenantRoleService, UserManagement
- sensor-service: MqttAuth, TenantSchema, BatchProcessor
- shared-ui: api-client, AuthContext, validation
- billing-service: Handler unit testleri

**5E. Observability**
- ENABLE_TRACING=true
- MetricsAggregatorService: Stub → real
- Servis-side /metrics endpoint

**5F-5G. Infrastructure** (2 ajan)
- SRI hash: CI/CD remoteEntry.js hash
- CSP: unsafe-inline → nonce
- Non-root: Shell, MFE Dockerfile

**5H. Frontend Tests**
- tenant-admin, AquaMobil test coverage

---

## 4. CROSS-IMPACT SAFETY RULES

1. **backend-common değişikliği** → @Public() endpoint'leri kırmamalı
2. **Event format** → Publisher'a dokunma, subscriber'ı uyumla
3. **JWT payload** → EN SON değiştir (tüm servisler etkilenir)
4. **TypeORM entity** → MODULE_SCHEMAS + tenant schema sync
5. **shared-ui** → Singleton, breaking change = tüm MFE kırılır
6. **Guard ekleme** → Health endpoint'ler @Public() olmalı

---

## 5. TOPLAM: 40 AJAN, 5 WAVE

| Wave | Ajan | Bağımlılık |
|------|------|-----------|
| 1 | 8 | Yok (temel) |
| 2 | 6 | Wave 1 tamamlanmalı |
| 3 | 12 | Wave 2 tamamlanmalı |
| 4 | 6 | Wave 3 tamamlanmalı |
| 5 | 8 | Wave 4 tamamlanmalı |
