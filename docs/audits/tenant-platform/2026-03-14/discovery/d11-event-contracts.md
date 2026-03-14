# D11 - Event-Driven Mimari ve NATS Event Contracts Audit Raporu

**Tarih:** 2026-03-14
**Auditor:** D11 - Event-Driven Mimari Uzmani
**Kapsam:** NATS JetStream event contract'lari, publisher/subscriber mapping, event butunlugu
**Durum:** KRITIK BULGULAR MEVCUT

---

## 1. Event Tanimi ve BaseEvent Yapisi

### 1.1 BaseEvent Interface

**Dosya:** `libs/event-contracts/src/base-event.ts`

Tum event'ler `BaseEvent` interface'ini extend eder:

| Alan | Tip | Zorunlu | Aciklama |
|------|-----|---------|----------|
| `eventId` | string | EVET | UUID, auto-generated |
| `eventType` | string | EVET | PascalCase routing key |
| `timestamp` | Date | EVET | Event olusma zamani |
| `tenantId` | string | EVET | Multi-tenant izolasyonu |
| `correlationId` | string | HAYIR | Dagitik tracing |
| `causationId` | string | HAYIR | Tetikleyici event ID |
| `userId` | string | HAYIR | Tetikleyen kullanici |
| `version` | number | EVET | Schema versiyonu (default: 1) |
| `retryCount` | number | HAYIR | Retry sayaci (DLQ icin) |

**Ortak Tipler:**
- `PlanTier`: `'starter' | 'professional' | 'enterprise'`
- `BillingCycle`: `'monthly' | 'quarterly' | 'semi_annual' | 'annual'`

### 1.2 Domain Event Kategorileri

Toplam **10 domain dosyasi**, **75+ event interface** tanimli:

| Kategori | Dosya | Event Sayisi |
|----------|-------|-------------|
| Tenant | `tenant-events.ts` | 11 |
| Farm | `farm-events.ts` | 25 |
| Sensor | `sensor-events.ts` | 18 |
| Alert | `alert-events.ts` | 6 |
| HR | `hr-events.ts` | 21 |
| Billing | `billing-events.ts` | 8 |
| Notification | `notification-events.ts` | 4 |
| AI | `ai-events.ts` | 4 |
| Task | `task-events.ts` | 5 |
| Edge Device | `edge-device-events.ts` | 6 |

`AnyPlatformEvent` union tipi tum domain event'lerini kapsar.

---

## 2. Publisher-Subscriber Mapping

### 2.1 Aktif Publisherlar

| Servis | Event | eventType |
|--------|-------|-----------|
| **admin-api-service** | TenantCreatedEvent | `TenantCreated` |
| **admin-api-service** | TenantProvisioningFailedEvent | `TenantProvisioningFailed` |
| **admin-api-service** | TenantSubscriptionRequestedEvent | `TenantSubscriptionRequested` |
| **admin-api-service** | TenantUpdatedEvent | `TenantUpdated` |
| **admin-api-service** | TenantSuspendedEvent | `TenantSuspended` |
| **admin-api-service** | TenantActivatedEvent | `TenantActivated` |
| **admin-api-service** | TenantStatusChangedEvent | `TenantStatusChanged` |
| **admin-api-service** | TenantArchivedEvent | `TenantArchived` |
| **admin-api-service** | TenantModulesAssignedEvent | `TenantModulesAssigned` |
| **admin-api-service** | ModuleRemovedFromTenantEvent | `ModuleRemovedFromTenant` |
| **auth-service** | TenantCreatedEvent | `TenantCreated` |
| **auth-service** | TenantUpdatedEvent | `TenantUpdated` |
| **auth-service** | UserInvitedEvent | `UserInvited` |
| **auth-service** | (non-contract) | `UserRegistered` |
| **auth-service** | (non-contract) | `UserLoggedIn` |
| **auth-service** | (non-contract) | `InvitationAccepted` |
| **farm-service** | FarmCreatedEvent | `FarmCreated` |
| **farm-service** | FarmUpdatedEvent | `FarmUpdated` |
| **farm-service** | PondCreatedEvent | `PondCreated` |
| **farm-service** | BatchCreatedEvent | `BatchCreated` |
| **farm-service** | BatchHarvestedEvent | `BatchHarvested` |
| **farm-service** | BatchStatusChangedEvent | `BatchStatusChanged` |
| **farm-service** | MortalityRecordedEvent | `MortalityRecorded` |
| **farm-service** | SiteCreatedEvent | `SiteCreated` |
| **farm-service** | TaskCreatedEvent | `TaskCreated` |
| **farm-service** | TaskAssignedEvent | `TaskAssigned` |
| **farm-service** | TaskCompletedEvent | `TaskCompleted` |
| **farm-service** | TaskStatusChangedEvent | `TaskStatusChanged` |
| **farm-service** | TaskOverdueEvent | `TaskOverdue` |
| **sensor-service** | SensorReadingEvent | `SensorReading` |
| **sensor-service** | ParentReadingRoutedEvent | `ParentReadingRouted` |
| **sensor-service** | EdgeDeviceHeartbeatEvent | `EdgeDeviceHeartbeat` |
| **sensor-service** | EdgeDeviceResponseEvent | `EdgeDeviceResponse` |
| **sensor-service** | EdgeDeviceIoDataEvent | `EdgeDeviceIoData` |
| **sensor-service** | EdgeDeviceAlarmEvent | `EdgeDeviceAlarm` |
| **sensor-service** | IoConfigPushResultEvent | `IoConfigPushResult` |
| **sensor-service** | LoRaDeviceEventEvent | `LoRaDeviceEvent` |
| **sensor-service** | (non-contract) | `AutomationProgramSaved` |
| **sensor-service** | (non-contract) | `AutomationProgramDeployed` |
| **sensor-service** | (non-contract) | `AutomationTagsUpdated` |
| **sensor-service** | (non-contract) | `AutomationFBDefinitionsChanged` |
| **alert-engine** | AlertTriggeredEvent | `AlertTriggered` |
| **hr-service** | LeaveRequestSubmittedEvent | `LeaveRequestSubmitted` |
| **hr-service** | LeaveApprovedEvent | `LeaveApproved` |
| **hr-service** | LeaveRejectedEvent | `LeaveRejected` |
| **hr-service** | LeaveCancelledEvent | `LeaveCancelled` |
| **hr-service** | CertificationAddedEvent | `certification.added` |
| **hr-service** | CertificationRevokedEvent | `certification.revoked` |
| **hr-service** | TrainingCompletedEvent | `training.completed` |
| **hr-service** | EmployeeClockedInEvent | `attendance.clocked_in` |
| **hr-service** | EmployeeClockedOutEvent | `attendance.clocked_out` |

### 2.2 Aktif Subscriberlar

| Servis | Dinledigi eventType | Handler |
|--------|-------------------|---------|
| **alert-engine** | `SensorReading` | `SensorReadingEventHandler` |
| **billing-service** | `TenantSubscriptionRequested` | `TenantSubscriptionRequestedHandler` |
| **notification-service** | `AlertTriggered` | `AlertTriggeredEventHandler` |
| **notification-service** | `TaskCreated` | `TaskEventHandler` |
| **notification-service** | `TaskAssigned` | `TaskEventHandler` + `TaskAssignedEventHandler` |
| **notification-service** | `TaskStatusChanged` | `TaskEventHandler` |
| **notification-service** | `TaskCompleted` | `TaskEventHandler` |
| **notification-service** | `TaskOverdue` | `TaskEventHandler` + `TaskAssignedEventHandler` |
| **gateway-api** | `SensorReadingReceived` | `NatsBridgeService` (WS bridge) |
| **gateway-api** | `EdgeDeviceIoData` | `NatsBridgeService` (WS bridge) |
| **gateway-api** | `EdgeDeviceAlarm` | `NatsBridgeService` (WS bridge) |
| **farm-service** | `inventory.lowStock` | `AutoRuleTriggerService` |
| **farm-service** | `maintenance.schedule.due` | `AutoRuleTriggerService` |
| **farm-service** | `alert.waterQuality` | `AutoRuleTriggerService` |
| **farm-service** | `feeding.expiryWarning` | `AutoRuleTriggerService` |

---

## 3. KRITIK BULGULAR

### 3.1 [KRITIK] Schema Mismatch - billing-service Nested Payload Beklentisi

**Dosya:** `apps/billing-service/src/billing/event-handlers/tenant-subscription-requested.handler.ts`

Publisher (admin-api-service) **flat** event yapiyor:
```
{ eventType: 'TenantSubscriptionRequested', tenantId: '...', tenantName: '...', tier: '...', ... }
```

Subscriber (billing-service) ise **nested payload** bekliyor:
```typescript
interface TenantSubscriptionRequestedPayload {
  tenantId: string;       // <-- payload icinde tenantId
  tenantName: string;
  ...
}
class TenantSubscriptionRequestedEvent {
  eventType!: 'TenantSubscriptionRequested';
  payload!: TenantSubscriptionRequestedPayload;  // <-- nested
}
```

Handler `event.payload.tenantId`, `event.payload.tier` gibi alanlara erisiyor. Publisher ise
`event.tenantId`, `event.tier` olarak gonderir. Bu, billing-service'in `undefined` degerlerle
calismasina ve subscription olusturamamasina neden olur.

**Risk:** Yeni tenant'lar subscription olmadan kalir. Billing tamamiyla calismaz.
**Oneri:** billing-service handler'ini flat event yapisiyla uyumlu hale getir.

### 3.2 [KRITIK] Event Subject Mismatch - gateway-api SensorReadingReceived vs SensorReading

**Dosya:** `apps/gateway-api/src/websocket/nats-bridge.service.ts:128`

- **sensor-service** `eventType: 'SensorReading'` publish eder -> NATS subject: `events.SensorReading`
- **gateway-api** `events.SensorReadingReceived.>` subject'ine subscribe olur
- Ek olarak, gateway-api'deki handler `event.eventType !== 'SensorReadingReceived'` kontrolu yapar

Bu uyumsuzluk nedeniyle **gateway-api hicbir sensor okumasi almaz**. WebSocket uzerinden canli
sensor verisi frontend'e iletilmez.

**Risk:** Frontend'te real-time sensor goruntuleme calismaz.
**Oneri:** gateway-api subscription'ini `events.SensorReading` olarak degistir.

### 3.3 [KRITIK] gateway-api Nested Payload Beklentisi

**Dosya:** `apps/gateway-api/src/websocket/nats-bridge.service.ts`

gateway-api kendi `NatsEvent` interface'ini tanimliyor:
```typescript
interface NatsEvent {
  payload: { sensorId, sensorName, tenantId, readings, timestamp };
  metadata: { tenantId, source };
}
```

Oysa sensor-service `SensorReadingEvent` flat yapiyla publish eder:
```
{ eventType: 'SensorReading', tenantId: '...', sensorId: '...', readings: {...} }
```

`isValidNatsEvent()` method'u `event.payload?.sensorId` kontrol eder ki bu `undefined` olacaktir.
Event drop edilir.

**Risk:** Eger subject uyumsuzlugu cozulse bile, flat/nested payload farki yuzunden eventler yine drop edilir.

### 3.4 [YUKSEK] HR Service eventType Uyumsuzlugu

HR service kendi internal event siniflarinda farkli eventType degerleri kullaniyor:

| Event Contract (event-contracts) | HR Service Internal eventType |
|----------------------------------|-------------------------------|
| `EmployeeClockedIn` | `attendance.clocked_in` |
| `EmployeeClockedOut` | `attendance.clocked_out` |
| `CertificationAdded` | `certification.added` |
| `CertificationRevoked` | `certification.revoked` |
| `TrainingCompleted` | `training.completed` |

Bu eventler `eventBus.publish()` ile yayinlaniyor ancak NATS subject'leri
`events.attendance.clocked_in` olacaktir, `events.EmployeeClockedIn` degil.
Herhangi bir subscriber PascalCase eventType ile dinliyorsa bu eventleri kacirir.

**Not:** HR service'in leave event'leri (LeaveRequestSubmitted, LeaveApproved vb.)
**dogru** PascalCase convention'i kullanir (`createBaseEvent` ile).

### 3.5 [YUKSEK] Non-Contract Event'ler - Shadow Events

Asagidaki event'ler `eventBus.publish()` ile yayinlaniyor ancak `event-contracts` kutuphanesinde
**hicbir interface tanimlamalari yok**:

| Servis | eventType | Durum |
|--------|-----------|-------|
| auth-service | `UserRegistered` | Tanimsiz |
| auth-service | `UserLoggedIn` | Tanimsiz |
| auth-service | `InvitationAccepted` | Tanimsiz |
| sensor-service | `AutomationProgramSaved` | Tanimsiz |
| sensor-service | `AutomationProgramDeployed` | Tanimsiz |
| sensor-service | `AutomationTagsUpdated` | Tanimsiz |
| sensor-service | `AutomationFBDefinitionsChanged` | Tanimsiz |

Bu "shadow event"ler merkezi contract olmadan yayinlaniyor. Subscriber'lar kendi yerel
interface'lerini tanimlamak zorunda kaliyor ve schema drift riski olusturuyor.

### 3.6 [YUKSEK] AutoRuleTrigger Phantom Event Subscriptions

`apps/farm-service/src/task/services/auto-rule-trigger.service.ts` su eventlere subscribe olur:
- `inventory.lowStock`
- `maintenance.schedule.due`
- `alert.waterQuality`
- `feeding.expiryWarning`

Bu eventlerin **hicbiri** herhangi bir servis tarafindan publish edilmiyor.
Event contract'larinda da tanimlari yok. AutoRule trigger mekanizmasi
tamamen calismiyor durumda.

**Risk:** Otomatik gorev olusturma (stok dusuk, bakim zamani gelmis vb.) calismaz.

---

## 4. Orphan Events (Yayinlanan ama Dinlenmeyen)

Asagidaki event'ler publish edilir ancak **hicbir servis tarafindan subscribe edilmez**:

| eventType | Publisher | Durum |
|-----------|----------|-------|
| `TenantCreated` | admin-api, auth-service | Dinleyen yok |
| `TenantUpdated` | admin-api, auth-service | Dinleyen yok |
| `TenantProvisioningFailed` | admin-api | Dinleyen yok |
| `TenantSuspended` | admin-api | Dinleyen yok |
| `TenantActivated` | admin-api | Dinleyen yok |
| `TenantStatusChanged` | admin-api | Dinleyen yok |
| `TenantArchived` | admin-api | Dinleyen yok |
| `TenantModulesAssigned` | admin-api | Dinleyen yok |
| `ModuleRemovedFromTenant` | admin-api | Dinleyen yok |
| `UserInvited` | auth-service | Dinleyen yok |
| `UserRegistered` | auth-service | Dinleyen yok |
| `UserLoggedIn` | auth-service | Dinleyen yok |
| `InvitationAccepted` | auth-service | Dinleyen yok |
| `FarmCreated` | farm-service | Dinleyen yok |
| `FarmUpdated` | farm-service | Dinleyen yok |
| `PondCreated` | farm-service | Dinleyen yok |
| `BatchCreated` | farm-service | Dinleyen yok |
| `BatchHarvested` | farm-service | Dinleyen yok |
| `BatchStatusChanged` | farm-service | Dinleyen yok |
| `MortalityRecorded` | farm-service | Dinleyen yok |
| `SiteCreated` | farm-service | Dinleyen yok |
| `SensorReading` | sensor-service | alert-engine dinler (dogru) |
| `ParentReadingRouted` | sensor-service | Dinleyen yok |
| `EdgeDeviceHeartbeat` | sensor-service | Dinleyen yok |
| `EdgeDeviceResponse` | sensor-service | Dinleyen yok |
| `IoConfigPushResult` | sensor-service | Dinleyen yok |
| `LoRaDeviceEvent` | sensor-service | Dinleyen yok |
| `LeaveRequestSubmitted` | hr-service | Dinleyen yok |
| `LeaveApproved` | hr-service | Dinleyen yok |
| `LeaveRejected` | hr-service | Dinleyen yok |
| `LeaveCancelled` | hr-service | Dinleyen yok |
| `attendance.clocked_in` | hr-service | Dinleyen yok |
| `attendance.clocked_out` | hr-service | Dinleyen yok |
| `certification.added` | hr-service | Dinleyen yok |
| `certification.revoked` | hr-service | Dinleyen yok |
| `training.completed` | hr-service | Dinleyen yok |

**Yorum:** 35+ orphan event. Bunlarin cogu "event store" veya "audit log" servisleri tarafindan
tuketilmek icin tasarlanmis olabilir, ancak event-store-service aktif bir NATS subscriber degil
(REST API uzerinden calisir). Gercek zamanli event tuketimi yok.

## 5. Missing Events (Dinlenen ama Yayinlanmayan)

| eventType | Subscriber | Publisher Durumu |
|-----------|-----------|-----------------|
| `inventory.lowStock` | farm-service AutoRuleTrigger | Yayinlayan yok |
| `maintenance.schedule.due` | farm-service AutoRuleTrigger | Yayinlayan yok |
| `alert.waterQuality` | farm-service AutoRuleTrigger | Yayinlayan yok |
| `feeding.expiryWarning` | farm-service AutoRuleTrigger | Yayinlayan yok |
| `SensorReadingReceived` | gateway-api NatsBridge | Yayinlayan yok (mismatch) |

---

## 6. Event Schema Versioning

### 6.1 Mevcut Durum

- `BaseEvent.version` alani mevcut (zorunlu, default: 1)
- `createBaseEvent()` factory'si `version: 1` set eder
- **Hicbir event farkli bir version kullanmiyor** - tumu version=1

### 6.2 Eksiklikler

| Eksik | Aciklama |
|-------|----------|
| Schema registry yok | Event'lerin schema'lari merkezi olarak kaydedilmiyor |
| Version migration yok | Eski format event -> yeni format donusumu yok |
| Backward compatibility testi yok | Yeni field eklendiginde eski consumer'lar test edilmiyor |
| Forward compatibility testi yok | Consumer, bilinmeyen field'lari nasil handle eder belirsiz |

**Risk:** Herhangi bir event interface degistigi anda, tum publisher ve subscriber'larin
**ayni anda** deploy edilmesi gerekiyor. Rolling update yapilamaz.

---

## 7. Dead Letter Handling

### 7.1 Mevcut Durum: YOK

Dead letter queue (DLQ) implementasyonu **mevcut degil**.

- `BaseEvent.retryCount` field'i tanimli ama **hicbir yerde increment edilmiyor**
- NATS JetStream consumer config: `max_deliver: 3` (default) - 3 basarisiz denemeden sonra mesaj
  duser ancak bu sessizce olur
- `nats-event-bus.ts` handler hatalarini loglar ve `msg.nak()` cagirir, ancak nak edilen mesajlar
  `max_deliver` asildiktan sonra sessizce kaybedilir

### 7.2 Spesifik Riskler

| Senaryo | Sonuc |
|---------|-------|
| billing-service subscription olusturma basan | Tenant subscriptionsiz kalir, hata sadece log'a yazilir |
| notification-service e-posta gonderimi basarisiz | `NotificationFailedEvent` event-contracts'ta tanimli ama publish eden yok |
| alert-engine evaluation hatasi | Hata loglanir, alert tetiklenmez |

**Oneri:** DLQ mekanizmasi eklenmeli. `max_deliver` asildiginda event'ler dead letter stream'e
yonlendirilmeli. Monitoring ve retry dashboardu olusturulmali.

---

## 8. Event Ordering Garantisi

### 8.1 JetStream Konfigurasyonu

```typescript
// nats-event-bus.ts - setupStream()
{
  name: 'AQUACULTURE_EVENTS',
  subjects: ['events.>', 'commands.>', 'queries.>'],
  retention: RetentionPolicy.Limits,
  storage: StorageType.File,
  max_age: 7 * 24 * 60 * 60 * 1000000000, // 7 gun
  max_bytes: 10 * 1024 * 1024 * 1024,      // 10 GB
  max_msg_size: 1024 * 1024,                // 1 MB
  discard: DiscardPolicy.Old,
  duplicate_window: 2 * 60 * 1000000000,    // 2 dakika dedup
  num_replicas: 1,
}
```

### 8.2 Ordering Analizi

| Ozellik | Durum |
|---------|-------|
| Stream-level ordering | EVET - Tek stream icinde global siralama |
| Per-subject ordering | KISMI - Ayni subject'e publish edilen mesajlar sirali |
| Cross-subject ordering | HAYIR - Farkli subject'ler arasi siralama garantisi yok |
| Consumer-level ordering | EVET - Pull-based consumer sirali teslim |
| Multi-instance ordering | HAYIR - Ayni servisin birden fazla instance'i varsa, consumer ismi PID icerir (`aquaculture-${process.pid}`) bu da her instance'in ayri consumer olmasi anlamina gelir |

### 8.3 Risk: Consumer Name PID-Based

```typescript
this.clientId = this.configService.get<string>('NATS_CLIENT_ID', `aquaculture-${process.pid}`);
```

Her servis instance'i farkli PID ile baska consumer yaratir. Bu durumda:
- Ayni event **birden fazla instance'a** teslim edilir (fan-out)
- Istenmeyen duplicate processing olur
- Durable consumer'lar restart'ta kaybolabilir (yeni PID = yeni consumer)

**Oneri:** `NATS_CLIENT_ID` env degiskeni ile servis bazli sabit isim verilmeli
(ornegin `farm-service`, `billing-service`).

---

## 9. Idempotency Analizi

### 9.1 Mevcut Mekanizmalar

| Mekanizma | Durum |
|-----------|-------|
| `eventId` ile dedup | NATS'ta `msgID: event.eventId` set ediliyor, `duplicate_window: 2dk` |
| Handler-level idempotency | YOK - Hicbir handler duplicate check yapmiyor |
| Upsert kullanimi | billing-service `moduleItemRepo.upsert()` kullanir (kismi koruma) |

### 9.2 NATS Dedup Kisitlamalari

- `duplicate_window: 2 dakika` - ayni `eventId` ile 2 dakika icinde tekrar publish engellenir
- 2 dakikadan sonra ayni event tekrar publish edilebilir
- Consumer tarafinda hicbir dedup yok

### 9.3 Duplicate Processing Riskleri

| Senaryo | Sonuc |
|---------|-------|
| AlertTriggered 2 kez gelirse | 2 ayri notification gonderilir |
| TaskAssigned 2 kez gelirse | 2 ayri in-app notification olusturulur |
| BatchCreated 2 kez gelirse | Gorsel etkisi yok (orphan event) |
| TenantSubscriptionRequested 2 kez | Upsert sayesinde kismi koruma var |

**Oneri:** Kritik handler'lara `eventId` bazli idempotency guard eklenmeli.
Processed event ID'leri Redis'te veya DB'de kisa sureli tutulmali.

---

## 10. Tenant Context ve Multi-Tenant Izolasyon

### 10.1 Event-Level Izolasyon

- `BaseEvent.tenantId` **zorunlu** alan
- `createBaseEvent()` factory'si tenantId parametresi alir
- Tum event contract'lari `tenantId` icerir

### 10.2 Subscriber-Level Validasyon

| Servis | tenantId Validasyonu | UUID Format Kontrolu |
|--------|---------------------|---------------------|
| alert-engine | EVET - empty check | HAYIR |
| notification-service (AlertTriggered) | EVET | EVET - UUID regex |
| notification-service (TaskEvent) | EVET | EVET - UUID regex |
| notification-service (TaskAssigned) | EVET (payload.tenantId) | EVET - UUID regex |
| billing-service | EVET (payload.tenantId) | EVET - UUID regex |
| gateway-api | EVET (metadata.tenantId) | EVET - UUID regex |

### 10.3 Riskler

1. **alert-engine** tenantId format validasyonu yapmaz - bos string gecerse
   cross-tenant alert evaluation riski var
2. **gateway-api** `metadata.tenantId` ile `payload.tenantId` karsilastirir
   ama flat event'lerde `metadata` field'i yok

### 10.4 NATS Subject'lerde Tenant Izolasyonu

NATS subject'ler `events.{eventType}` formatinda - **tenantId subject'te yok**.
Tum tenant'larin eventleri ayni subject'e gider. Izolasyon tamamen handler
icerisinde `tenantId` filtrelemesi ile saglanir.

**Oneri:** Yuksek hacimli event'ler icin (ornegin SensorReading) subject'e tenantId
eklenmesi dusunulmeli: `events.SensorReading.{tenantId}`.

---

## 11. Replay Capability

### 11.1 JetStream Replay

- **Stream retention:** 7 gun (`max_age`)
- **Consumer deliver policy:** `DeliverPolicy.New` (default) veya `DeliverPolicy.All`
- **SubscriptionOptions.startFrom:** `'beginning' | 'latest'` desteklenir
- Bu, 7 gunluk pencere icinde replay yapilabilir demektir

### 11.2 Event Store Service

`apps/event-store-service/` ayri bir event sourcing servisi olarak mevcut:

| Ozellik | Durum |
|---------|-------|
| Persistent event storage | EVET - PostgreSQL'de `stored_events` tablosu |
| Optimistic concurrency | EVET - stream version kontrolu |
| Snapshot support | EVET - aggregate snapshot olusturma |
| Read/replay API | EVET - REST endpoint'ler ile |
| NATS entegrasyonu | HAYIR - Dogrudan NATS'tan event tuketmiyor |

### 11.3 Kisitlamalar

- Event-store-service NATS'a subscribe **olmuyor** - event'leri dogrudan almiyor
- Servisler event-store-service'e event append etmiyor (REST API var ama kullanilmiyor)
- 7 gunluk NATS retention dolunca eski event'ler kaybolur
- Tam replay icin her servisin kendi state'ini rebuild etmesi gerekir ama bunu
  saglayacak mekanizma yok

**Oneri:** event-store-service'in NATS JetStream'den `events.>` subject'ine subscribe
olup gelen tum event'leri kalici olarak saklamasi gerekir.

---

## 12. Event Storm Riski

### 12.1 Cascade Analizi

Mevcut event zinciri:

```
admin-api: TenantCreated
  -> (hicbir subscriber)

admin-api: TenantSubscriptionRequested
  -> billing-service: subscription olusturur (ancak schema mismatch nedeniyle calismaz)

sensor-service: SensorReading
  -> alert-engine: evaluateSensorReading()
    -> alert-engine: AlertTriggered (esik asilirsa)
      -> notification-service: dispatchAlertNotification()
```

Bu zincir 3 seviye derinliginde ve kontrol altinda.

### 12.2 Potansiyel Storm Senaryolari

| Senaryo | Risk | Mevcut Koruma |
|---------|------|--------------|
| Sensor ariza - surekli anormal okuma | AlertTriggered event'leri cig gibi buyur | alert-engine cooldown suresi olabilir (incelenmedi) |
| Batch operation - 100 tank icin ayri event | 100 event ayni anda yayinlanir | Backpressure yok |
| NATS reconnect sonrasi birikme | Tum birikmiis eventler ayni anda teslim edilir | notification-service Semaphore(5) limiti var |

### 12.3 Backpressure Mekanizmalari

| Servis | Mekanizma |
|--------|-----------|
| notification-service AlertTriggered | `Semaphore(5)` - max 5 concurrent processing |
| notification-service TaskEvent | `Semaphore(5)` - max 5 concurrent processing |
| NATS consumer | `max_deliver: 3` - failed mesajlar icin |
| NATS stream | `DiscardPolicy.Old` + `max_bytes: 10GB` |

---

## 13. Commented-Out Event Publishing

Farm-service'te birden fazla handler'da event publishing **yorum satiri** yapilmis:

| Dosya | Event |
|-------|-------|
| `delete-department.handler.ts:148` | `DepartmentDeletedEvent` |
| `create-department.handler.ts:78` | `DepartmentCreatedEvent` |
| `update-department.handler.ts:69` | `DepartmentUpdatedEvent` |
| `update-equipment.handler.ts:249` | `EquipmentUpdatedEvent` |
| `delete-equipment.handler.ts:137` | `EquipmentDeletedEvent` |
| `create-equipment.handler.ts:222` | `EquipmentCreatedEvent` |
| `delete-site.handler.ts:172` | `SiteDeletedEvent` |
| `update-site.handler.ts:69` | `SiteUpdatedEvent` |
| `create-system.handler.ts:116` | `SystemCreatedEvent` |
| `update-system.handler.ts:93` | `SystemUpdatedEvent` |
| `delete-system.handler.ts:116` | `SystemDeletedEvent` |
| `consume-feed-inventory.handler.ts:71` | `FeedInventoryLowEvent` |

**Yorum:** 12 event contract'ta tanimli ama **hicbir zaman publish edilmiyor**.
Event-contracts kutuphanesi bu event'ler icin interface tanimladi ama uygulama
tarafinda event yayini etkinlestirilmemis.

**Risk:** Bu event'lere bagli potansiyel subscriber'lar (gelecekte) calismaz.
FeedInventoryLowEvent publish edilmezse, stok uyarisi sistemi calismaz.

---

## 14. Duplicate Subscriber Riski

`notification-service` icerisinde iki ayri handler ayni event'lere subscribe olur:

- `TaskAssignedEventHandler` -> `TaskAssigned`, `TaskOverdue`
- `TaskEventHandler` -> `TaskCreated`, `TaskAssigned`, `TaskStatusChanged`, `TaskCompleted`, `TaskOverdue`

`TaskAssigned` ve `TaskOverdue` event'leri icin **iki handler birden** calisir.
Bu, ayni event icin **2 in-app notification** olusmasina yol acar.

**Risk:** Kullaniciya ayni gorev icin duplike bildirim gider.
**Oneri:** `TaskAssignedEventHandler` deprecated edilmeli, `TaskEventHandler` tek handler olmali.

---

## 15. Sonuc ve Onceliklendirme

### Kritik (Hemen Ciziilmeli)

| # | Bulgu | Dosya |
|---|-------|-------|
| 1 | billing-service flat/nested payload mismatch | `tenant-subscription-requested.handler.ts` |
| 2 | gateway-api SensorReading/SensorReadingReceived subject mismatch | `nats-bridge.service.ts` |
| 3 | gateway-api flat/nested NatsEvent mismatch | `nats-bridge.service.ts` |

### Yuksek (Kisa Vadede Ciziilmeli)

| # | Bulgu | Dosya |
|---|-------|-------|
| 4 | HR service eventType convention mismatch (snake_case vs PascalCase) | `attendance.events.ts`, `training.events.ts` |
| 5 | 7 shadow event contract'siz publish ediliyor | auth-service, sensor-service |
| 6 | 4 phantom event dinleniyor ama publish edilmiyor | `auto-rule-trigger.service.ts` |
| 7 | PID-based consumer name = duplicate processing riski | `nats-event-bus.ts` |
| 8 | Duplicate handler: TaskAssigned/TaskOverdue 2x islem gorur | notification-service |

### Orta (Planlanmali)

| # | Bulgu |
|---|-------|
| 9 | DLQ/dead-letter mekanizmasi yok |
| 10 | Handler-level idempotency kontrolu yok |
| 11 | 12 farm-service event publish'i commented-out |
| 12 | Event-store-service NATS'a baglanmiyor |
| 13 | Schema versioning/migration stratejisi yok |
| 14 | 35+ orphan event (publish edilen ama dinlenmeyen) |

### Dusuk (Iyilestirme)

| # | Bulgu |
|---|-------|
| 15 | NATS subject'lerde tenantId yok (handler-level filtreleme) |
| 16 | alert-engine tenantId UUID format validasyonu eksik |
| 17 | 7 gunluk retention suresi uzatilmali veya event-store entegrasyonu yapilmali |

---

## Ilgili Dosyalar

- `libs/event-contracts/src/*.ts` - Tum event contract tanimlari
- `platform/libs/event-bus/src/nats/nats-event-bus.ts` - NATS JetStream implementasyonu
- `apps/billing-service/src/billing/event-handlers/tenant-subscription-requested.handler.ts`
- `apps/gateway-api/src/websocket/nats-bridge.service.ts`
- `apps/alert-engine/src/alert/event-handlers/sensor-reading.handler.ts`
- `apps/notification-service/src/notification/event-handlers/*.ts`
- `apps/farm-service/src/task/services/auto-rule-trigger.service.ts`
- `apps/hr-service/src/attendance/events/attendance.events.ts`
- `apps/hr-service/src/training/events/training.events.ts`
- `apps/hr-service/src/leave/events/leave.events.ts`
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts`
- `apps/sensor-service/src/automation/events/automation-events.publisher.ts`
- `apps/event-store-service/src/event-store/services/event-store.service.ts`
