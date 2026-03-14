# D10 - Alert Engine & Notification Service Audit

**Tarih:** 2026-03-14
**Auditor:** Tenant Platform Audit - Alarm ve Bildirim Uzmani (D10)
**Kapsam:** `apps/alert-engine/`, `apps/notification-service/`
**Durum:** TAMAMLANDI

---

## 1. Yonetici Ozeti

Alert engine, sensor okumalarini NATS uzerinden dinleyerek kurallara karsi degerlendiren, risk skoru
hesaplayan, incident olusturan, escalation zinciri calistiran ve bildirim dispatchi yapan kapsamli bir
sistemdir. Notification service ise `AlertTriggered` event'lerini alarak email, SMS, push ve webhook
kanallarina gonderim yapar.

**Genel Degerlendirme:** Mimari saglamdir -- multi-engine rules (JSON DSL + OPA + behavior tree),
Redis ile cooldown/deduplication, escalation state recovery ve retry mekanizmalari mevcut. Ancak
bazi kritik bosluklar production guvenilirligi acisindan risk olusturmaktadir.

### Kritik Bulgular
| # | Bulgu | Ciddiyet | Etki |
|---|-------|----------|------|
| F1 | SMS/Push provider'lar mock -- production'da calismaz | KRITIK | SMS/push bildirimleri sessizce basarisiz |
| F2 | Cooldown'da atomik SET NX degil GET+SET (race condition) | YUKSEK | Ayni kural icin ikiz alarm |
| F3 | RulesEngine ve RiskScoring AlertModule'a baglanmamis | ORTA | Dead code -- kullanilmiyor |
| F4 | AcknowledgmentTracker in-memory -- restart'ta kayip | YUKSEK | Ack durumu kaybolur |
| F5 | Dead letter queue yok | YUKSEK | Islenemeyen event'ler sessizce kaybolur |
| F6 | Notification-service severity allowlist eksik | ORTA | medium/high/low/warning atlanir |
| F7 | Auto-resolve mekanizmasi yok | ORTA | Duzelen durumlar icin incident acik kalir |

---

## 2. Rules Engine -- Nasil Calisiyor?

### 2.1 Mimari (3 Motor)

Alert engine uc farkli kural motoru destekler:

**a) Temel Condition Evaluator (AlertEvaluationService -- AKTIF)**
- `alert-evaluation.service.ts` icerisinde dogrudan calisir
- `AlertCondition[]` JSONB: parameter + operator (gt/gte/lt/lte/eq) + threshold + severity
- Her sensor okumasi geldiginde `findApplicableRules()` ile aktif kurallar bulunur
- Tum condition'lar degerlendirilir, en yuksek severity'li eslesme secilir
- Dosya: `/var/aqua-saas/apps/alert-engine/src/alert/services/alert-evaluation.service.ts`

**b) JSON Rules Engine (JsonRulesService -- KAYITLI AMA KULLANILMIYOR)**
- `json-rules-engine` patterninde deklaratif kural tanimlari
- `all/any/not` mantiksal gruplama
- Fact resolver'lar, custom operator'lar, action handler'lar
- 28 operator destegi (comparison, string, array, date, range)
- Dosya: `/var/aqua-saas/apps/alert-engine/src/rules-engine/json-rules.service.ts`

**c) OPA Rules (OpaRulesService -- KAYITLI AMA KULLANILMIYOR)**
- Open Policy Agent'a HTTP uzerinden Rego policy evaluation delegasyonu
- Retry (exponential backoff), health check (30s), decision logging
- Keep-alive TCP agent'lar, batch evaluation destegi
- Dosya: `/var/aqua-saas/apps/alert-engine/src/rules-engine/opa-rules.service.ts`

**d) Behavior Tree (BehaviorTreeService -- KAYITLI AMA KULLANILMIYOR)**
- Sequence, Selector, Parallel composite node'lar
- Inverter, Repeater, Retry, Timeout decorator'lar
- Action ve Condition leaf node'lar
- Dosya: `/var/aqua-saas/apps/alert-engine/src/rules-engine/behavior-tree.service.ts`

### 2.2 BULGU F3: Ileri Motorlar Baglanmamis

`AlertModule`'de sadece `AlertEvaluationService` ve `AlertRuleService` provider olarak kayitlidir.
`RulesEngineService`, `RuleEvaluatorService`, `JsonRulesService`, `OpaRulesService`,
`BehaviorTreeService` gibi siniflar hicbir module tarafindan import edilmemektedir.

```
// alert.module.ts -- sadece bunlar var:
providers: [
  AlertEvaluationService,
  AlertRuleService,
  EscalationPolicyService,
  EscalationManagerService,
  SensorReadingEventHandler,
  AlertResolver,
]
```

**Sonuc:** JSON Rules, OPA ve Behavior Tree motorlari dead code'dur. Sadece temel threshold-based
condition evaluation calismaktadir.

### 2.3 Kural Evaluation Akisi

```
SensorReading NATS event
  -> SensorReadingEventHandler.handle()
    -> AlertEvaluationService.evaluateSensorReading()
      -> findApplicableRules() [30s in-process cache]
      -> checkConditions() [en yuksek severity eslesme]
      -> atomicCheckCooldownAndTrigger() [Redis cooldown]
        -> AlertHistory kaydi olustur
        -> ensureIncident() [yeni veya mevcut incident guncelle]
        -> publishAlertEvent() [NATS: AlertTriggered]
        -> escalationManager.startEscalation() [non-blocking]
```

### 2.4 Kural Oncelleme ve Caching

- **In-process cache:** 30 saniye TTL, key: `tenantId:sensorId:farmId:pondId`
- **Cooldown:** Redis key `cooldown:{tenantId}:{ruleId}`, TTL = cooldownMinutes * 60 saniye
- **Duplicate rule name:** Ayni tenant icinde unique constraint (name, tenantId)

---

## 3. Risk Scoring

### 3.1 Algoritma

`RiskCalculatorService` 6 faktor uzerinden agirlikli skor hesaplar:

| Faktor | Agirlik | Kaynak |
|--------|---------|--------|
| Frequency | 0.15 | Onceki incident sayisi + recency |
| Severity | 0.25 | Rule severity + threshold sapma |
| Impact | 0.25 | ImpactAnalyzerService (7 kategori) |
| History | 0.15 | Z-score (tarihi degerlerden sapma) |
| Context | 0.10 | Cevre kosullari (firtina, sicaklik, sezon) |
| Trend | 0.10 | Lineer regresyon egim analizi |

**Skor hesabi:** `totalScore = SUM(factor.value * factor.weight) / SUM(weight)` (0-100 araligindan)

### 3.2 Threshold'lar

```typescript
DEFAULT_THRESHOLDS = {
  critical: 85,  // >= 85 -> CRITICAL
  high: 65,      // >= 65 -> HIGH
  medium: 40,    // >= 40 -> MEDIUM
  low: 20,       // >= 20 -> LOW
}                // < 20  -> INFO
```

### 3.3 Impact Analizi (ImpactAnalyzerService)

7 kategori agirlikli olarak degerlendirilir:

| Kategori | Agirlik |
|----------|---------|
| Business | 0.25 |
| Financial | 0.20 |
| Technical | 0.15 |
| Compliance | 0.15 |
| Operational | 0.10 |
| Environmental | 0.10 |
| Reputation | 0.05 |

Akvakultere ozgu: farm/pond/sensor scope'a gore ek etki puanlari eklenir.

### 3.4 BULGU: Risk Scoring AlertModule'a Baglanmamis

`RiskCalculatorService`, `ImpactAnalyzerService`, `SeverityClassifierService` hicbir module'de
provider olarak kayitli degildir. `AlertEvaluationService` risk skoru hesaplamaz -- incident'a
`riskScore: 0` olarak kaydeder.

---

## 4. Escalation

### 4.1 Escalation Policy Yapisi

```typescript
EscalationPolicy {
  levels: EscalationLevel[]  // Seviyeler (1, 2, 3...)
  severity: AlertSeverity[]  // Hangi severity'lere uygulanir
  onCallSchedule: OnCallSchedule[]
  suppressionWindows: SuppressionWindow[]
  maxRepeats: number  // default 3
  ruleIds?: string[]  // Spesifik kurallar
  farmIds?: string[]  // Spesifik ciftlikler
}

EscalationLevel {
  level: number
  name: string
  timeoutMinutes: number
  notifyUserIds: string[]
  notifyTeamIds?: string[]
  channels: NotificationChannel[]
  action: EscalationActionType  // NOTIFY, ASSIGN, ESCALATE_TO_MANAGER, etc.
  messageTemplate?: string
}
```

### 4.2 Seviye Atlama Mekanizmasi

1. Incident olusturuldiginda `escalationManager.startEscalation()` cagrilir
2. Matching policy bulunur (severity + ruleId + farmId match score'a gore)
3. Suppression window kontrolu yapilir
4. Level 1 execute edilir, timeout (setTimeout) ayarlanir
5. Timeout dolmadan acknowledge edilmezse `escalateToNextLevel()` cagirilir
6. Max level'a ulasilirsa `maxRepeats` kadar tekrar edilir
7. Max repeats tamamlaninca `completeEscalation()` ile sonlanir

### 4.3 State Recovery

- Escalation state Redis'te saklanir (`escalation:state:{incidentId}`)
- Aktif escalation ID'leri Redis Set'te (`escalation:active`)
- Timer bilgileri Redis'te (`escalation:timer:{incidentId}`)
- Restart'ta `restoreActiveTimers()` ile timer'lar geri yuklenir
- Her dakika `checkMissedEscalations()` ile kacirilmis escalation'lar kontrol edilir
- Acknowledge/resolve edilen incident'lar icin escalation atlanir

### 4.4 BULGU F7: Auto-Resolve Mekanizmasi Yok

Sensorden gelen deger tekrar normal araliga dondugunde incident otomatik olarak resolve edilmez.
`SeverityClassifierService.isAutoResolvable()` metodu var (INFO ve LOW icin true doner) ama
bu metod hicbir yerden cagrilmiyor. Incident'lar elle acknowledge/resolve edilmek zorundadir.

### 4.5 Acknowledgment Tracker

`AcknowledgmentTrackerService` in-memory Map'te calismaktadir:
- Timeout checker: 10 saniyede bir kontrol
- Max timeout: 3 deneme (default 5 dakika, exponential backoff x1.5)
- Auto-resolve on timeout: false (default)
- Escalate on timeout: true (default)

**BULGU F4:** In-memory storage -- container restart'ta tum ack durumu kaybolur. Redis'e tasinmali.

---

## 5. Notification Dispatch

### 5.1 Kanal Mimarisi

Alert engine icerisinde `ChannelRouterService` 7 kanal destekler:

| Kanal | Oncelik | Durum |
|-------|---------|-------|
| PagerDuty | 100 | Template var, handler yok |
| SMS | 90 | Mock provider |
| Push | 80 | Mock/Firebase |
| Slack | 70 | Template var, handler yok |
| Teams | 65 | Template var, handler yok |
| Email | 50 | nodemailer ile calisiyor |
| Webhook | 30 | fetch() ile calisiyor |

**Severity -> Kanal Mapping:**
- CRITICAL: PagerDuty + SMS + Push + Slack + Email
- HIGH: SMS + Push + Slack + Email
- MEDIUM: Push + Slack + Email
- WARNING: Push + Slack + Email
- LOW: Email + Slack
- INFO: Email

### 5.2 Notification Service (Ayri Mikro Servis)

Notification service `AlertTriggered` NATS event'ini dinler ve gercek gonderiminizi yapar:

```
AlertTriggered (NATS)
  -> AlertTriggeredEventHandler (semaphore: max 5 concurrent)
    -> NotificationDispatcherService.dispatchAlertNotification()
      -> Rate limit check (100/dakika/tenant)
      -> Deduplication (alertId bazli)
      -> pLimit(10) ile paralel gonderim
        -> sendEmail() via nodemailer
        -> sendSms() via mock/twilio/aws_sns
        -> sendPush() via mock/firebase
        -> sendWebhook() via fetch()
      -> NotificationLog kaydi (success/failure)
```

### 5.3 BULGU F1: SMS ve Push Provider'lar Mock

**SMS Service:**
- `SMS_ENABLED` default `false`
- `SMS_PROVIDER` default `mock`
- Twilio: `throw new Error('not yet implemented')`
- AWS SNS: `throw new Error('not yet implemented')`

**Push Service:**
- `PUSH_ENABLED` default `false`
- `PUSH_PROVIDER` default `mock`
- Firebase: Implementasyon var ama `FIREBASE_SERVICE_ACCOUNT` gerekli
- OneSignal: `throw new Error('not yet implemented')`
- APNS: `throw new Error('not yet implemented')`

**Etki:** Production'da SMS ve push bildirimleri calismaz. CRITICAL severity icin SMS/push
kritik kanallardır -- bu eksiklik ciddi bir guvenirlirlik riskidir.

### 5.4 BULGU F6: Severity Allowlist Eksik

`alert-triggered.handler.ts` icinde:
```typescript
const ALLOWED_SEVERITIES = ['info', 'warning', 'critical'];
```

Alert engine'in severity enum'u 6 deger icerir: `info, low, warning, medium, high, critical`.
Handler'da `low`, `medium`, `high` severity'ler allowlist'te yok. Bu severity'lerle gelen
alert'ler `info` olarak downgrade edilir.

### 5.5 Quiet Hours ve Rate Limiting

- **Quiet hours:** Kullanici timezone'una gore (Intl API), CRITICAL severity haric tum bildirimler bastiirlir
- **User rate limit:** Channel bazli maxPerHour/maxPerDay
- **Tenant rate limit:** 100 notification/dakika (in-memory, multi-instance'da yanlis calismaz)

---

## 6. Event-Driven Architecture

### 6.1 NATS Event'leri

**Consume edilen:**

| Event | Kaynak | Handler | Aciklama |
|-------|--------|---------|----------|
| `SensorReading` | sensor-service | `SensorReadingEventHandler` | Alert kural evaluation tetikler |
| `AlertTriggered` | alert-engine | `AlertTriggeredEventHandler` (notification-service) | Bildirim gonderimi |

**Publish edilen:**

| Event | Yayinlayan | Icerik |
|-------|-----------|--------|
| `AlertTriggered` | AlertEvaluationService | alertId, ruleId, severity, channels, recipients, triggeringData |

### 6.2 In-Process Event'ler (EventEmitter2)

Alert engine icerisinde EventEmitter2 ile dagitim:
- `escalation.escalated/acknowledged/completed/timeout/suppressed`
- `opa.policy.evaluated`, `opa.health.unhealthy`, `opa.decision.logged`
- `behavior-tree.executed`
- `json-rules.completed`
- `ack.created/acknowledged/expired/escalated/resolved/timeout`
- `notification.sent/delivered/failed/batch.completed`
- `audit.logged`
- `rule.created/updated/deleted/triggered`
- `incident.created/acknowledged/resolved`

### 6.3 BULGU F5: Dead Letter Queue Yok

NATS subscription'larda hata olursa event catch edilerek loglanir ama:
- Basarisiz event'ler icin retry mekanizmasi yok (NATS JetStream ack/nack)
- Dead letter queue tanimlanmamis
- Event kaybi sessizce yasanabilir

```typescript
// sensor-reading.handler.ts
try {
  await this.evaluationService.evaluateSensorReading({...});
} catch (error) {
  this.logger.error(...); // sadece loglama, retry yok
}
```

---

## 7. Tenant Isolation

### 7.1 Izolasyon Mekanizmalari

| Katman | Mekanizma | Degerlendirme |
|--------|-----------|---------------|
| DB Schema | `TenantSchemaMiddleware` (search_path: "tenant_xxx", alert, public) | SAGLAM |
| API Guard | `TenantGuard` (APP_GUARD) | SAGLAM |
| Event Handling | tenantId null kontrolu, reddedilir | SAGLAM |
| Alert Rules | `tenantId` ile filtreleme (WHERE tenant_id = :tenantId) | SAGLAM |
| Cooldown Redis | Key: `cooldown:{tenantId}:{ruleId}` | SAGLAM |
| Escalation Redis | State: `escalation:state:{incidentId}` | SORUNLU* |
| Notification Rate Limit | Tenant bazli in-memory Map | SAGLAM |
| GraphQL | `@Tenant()` decorator ile tenantId injection | SAGLAM |
| NATS Events | `AlertTriggeredHandler` UUID regex ile tenantId validasyonu | SAGLAM |

**\*Sorunlu:** Escalation state Redis key'leri incidentId bazli, tenantId icerik olarak saklanir
ama key'de yok. `getActiveEscalations()` tum tenant'larin escalation'larini dondurur.
Ancak bu metod yalnizca dahili izleme icin kullanildigi ve incident bilgisi zaten tenant-scoped
oldugu icin pratik risk dusuktur.

### 7.2 OPA Decision Log Tenant Izolasyonu

```typescript
getDecisionLog(tenantId: string, ...) {
  if (!tenantId) throw new Error('tenantId is required');
  let entries = this.decisionLog.filter(e => e.labels?.['tenantId'] === tenantId);
}
```

OPA decision log'u in-memory'de tutuluyor ama tenant bazli filtreleme zorunlu.
`logDecision()` yalnizca boolean outcome ve tenantId kaydeder -- full sensor payload degiil.

---

## 8. Guvenilirlik Analizi

### 8.1 Alert Storm Senaryosu

**Soru:** Cok sayida alarm ayni anda gelirse ne olur?

**Mevcut Korumalar:**
1. **Cooldown (Redis):** Kural bazli, `cooldownMinutes` suresi boyunca ayni kural tetiklenmez
2. **Incident deduplication:** Aktif incident varsa `occurrenceCount` arttirilir, yeni incident olusturulmaz
3. **In-process rule cache:** 30s TTL, DB yuku azaltir
4. **Backpressure (notification):** Semaphore ile max 5 concurrent event, her biri max 10 parallel dispatch
5. **Tenant rate limit:** 100 notification/dakika/tenant

**BULGU F2: Cooldown Race Condition**

```typescript
// alert-evaluation.service.ts
if (rule.cooldownMinutes > 0) {
  const existing = await this.redisService.get(cooldownKey);  // 1. GET
  if (existing !== null) { return; }
  await this.redisService.set(cooldownKey, '1', ...);          // 2. SET
}
```

Kodda SET NX (atomic) yerine GET + SET kullanilmaktadir. Iki concurrent sensor reading ayni
anda geldinde her ikisi de GET'ten null alir ve ikisi de alert tetikler. Yorum `PE-01` atomik
olmasi gerektigini belirtir ama implementasyon atomik degildir.

**Duzeltme:** `redisService.set()` yerine `SETNX` veya `SET key value NX EX ttl` kullanilmalidir.

### 8.2 False Positive Yonetimi

**Mevcut Mekanizmalar:**
- **Cooldown periyodu:** Ayni kural icin minimum tekrar suresi (varsayilan 5 dakika)
- **Threshold-based conditions:** Sadece belirli esik degerleri asildiginda tetiklenir
- **NaN/null korumasi:** Gecersiz degerler atlanir
- **Suppression windows:** Bakim pencerelerinde alarm bastirilabilir
- **Severity classifier:** Dusuk guven skoru icin severity downgrade onerisi

**Eksikler:**
- Rate-of-change analizi `AlertEvaluationService`'te yok (sadece `RuleEvaluatorService`'te -- kullanilmiyor)
- Consecutive occurrence sayimi yok (fonksiyon var ama baglanmamis)
- Anomaly detection (z-score based) yok (fonksiyon var ama baglanmamis)
- Hysteresis (bounce-back korumasi) yok

### 8.3 Notification Failure ve Retry

**Notification Service (Gercek Retry):**
1. Gonderim basarisiz olursa `NotificationLog` kaydedilir (status: FAILED, nextRetryAt hesaplanir)
2. `RetrySchedulerService` her 5 dakikada cron job calistirir
3. `retryFailedNotifications()` atomik `UPDATE ... RETURNING` ile record claim eder
4. Exponential backoff: 2^retryCount dakika (1, 2, 4, 8 dakika...)
5. Max retry: 3 (varsayilan)
6. Webhook retry icin URL redact edilmis -- retry yapilamaz (guvenlik karari)

**Alert Engine Icerisindeki Dispatcher (Ayri Retry):**
- `NotificationDispatcherService` kendi retry mekanizmasina sahip
- Max retry: 3, exponential backoff (1s, 2s, 4s... max 30s)
- Basarisiz kalirsa FAILED event emit edilir

### 8.4 Dead Letter Queue

**BULGU F5 Detay:**

NATS subscription handler'larda hata yakalanip loglanir ama:
- JetStream `ack()` / `nack()` mekanizmasi gorunmuyor
- Retry policy tanimli degil
- Dead letter subject/queue tanimli degil
- Event kaybinin olcumu/izlenmesi yok

Bu, sensor reading event'lerinin veya alert event'lerinin NATS tarafinda sessizce drop
edilebilecegi anlamina gelir.

### 8.5 Timing ve Latency

**Alert Gecikmesi Bilesenileri:**

| Adim | Tahmini Sure | Aciklama |
|------|-------------|----------|
| NATS event delivery | 1-5ms | JetStream push |
| Rule cache hit | 0ms | In-process Map |
| Rule cache miss (DB) | 5-20ms | PostgreSQL query |
| Condition evaluation | <1ms | CPU-bound, senkron |
| Redis cooldown check | 1-3ms | GET + SET |
| AlertHistory DB write | 5-15ms | PostgreSQL INSERT |
| Incident DB write | 5-15ms | PostgreSQL INSERT/UPDATE |
| NATS AlertTriggered publish | 1-5ms | JetStream publish |
| **Toplam alert-engine** | **~15-60ms** | |
| Notification service handler | 1-5ms | Event parse + validate |
| Email SMTP send | 200-2000ms | Harici SMTP sunucu |
| SMS send | 500-3000ms | Harici SMS API |
| **End-to-end (email)** | **~250-2100ms** | Near real-time |

**Sonuc:** Sistem near real-time'dir (tipik <500ms alert, <3s notification). Ancak SMTP/SMS
harici bagimliliklari nedeniyle end-to-end latency degiskendir.

---

## 9. Test Durumu

### 9.1 Mevcut Test Dosyalari

| Test Dosyasi | Kapsam |
|-------------|--------|
| `alert-engine.security.spec.ts` | Guvenlik testleri |
| `alert-engine.performance.spec.ts` | Performans testleri |
| `alert-engine.integration.spec.ts` | Entegrasyon testleri |
| `alert-incident.entity.spec.ts` | Incident entity unit testleri |
| `escalation-policy.service.spec.ts` | Escalation policy testleri |
| `escalation-manager.service.spec.ts` | Escalation manager testleri |
| `channel-router-rate-limit.spec.ts` | Rate limiting testleri |
| `notification-dispatcher.service.spec.ts` | Notification dispatcher testleri |
| `channel-router.service.spec.ts` | Channel router testleri |
| `template-renderer.service.spec.ts` | Template renderer testleri |
| `rules-engine.service.spec.ts` | Rules engine testleri |
| `rules-engine-caching.spec.ts` | Rules engine cache testleri |
| `rule-evaluator.service.spec.ts` | Rule evaluator testleri |
| `severity-classifier.service.spec.ts` | Severity classifier testleri |
| `risk-calculator.service.spec.ts` | Risk calculator testleri |
| `impact-analyzer.service.spec.ts` | Impact analyzer testleri |

**Toplam:** 16 test dosyasi

### 9.2 Eksik Test Alanlari

- `AlertEvaluationService` icin unit test yok (en kritik servis)
- `SensorReadingEventHandler` icin test yok
- `AlertRuleService` icin test yok
- `AlertResolver` icin test yok
- `AcknowledgmentTrackerService` icin test yok
- `AlertAuditService` icin test yok
- Notification service tarafinda `RetrySchedulerService` icin test yok
- End-to-end alert akisi testi yok

---

## 10. Guvenlik Bulgulari

### 10.1 Pozitif Guvenlik Onlemleri

| Onlem | Dosya | Aciklama |
|-------|-------|----------|
| Prototype pollution korumasi | `rule-evaluator.service.ts` | `__proto__`, `constructor`, `prototype` bloklandi |
| ReDoS korumasi | `safe-regex.util.ts` | Tehlikeli pattern tespiti, max uzunluk 200 |
| SSRF korumasi | `notification-dispatcher.service.ts` | Webhook URL validasyonu, blocked hosts/IPs |
| XSS korumasi | `email.service.ts`, `template-renderer.service.ts` | HTML escaping |
| SMTP header injection | `alert-triggered.handler.ts` | CRLF strip, severity allowlist |
| PII maskeleme | `notification-dispatcher.service.ts` | Email/SMS/push log'larinda maskeleme |
| Dot-notation depth limiti | `rule-evaluator.service.ts` | Max 3 seviye derinlik |
| Event bus poisoning korumasi | `json-rules.service.ts`, `behavior-tree.service.ts` | Allowed event prefix kontrolu |
| Webhook export allowlist | `template-renderer.service.ts` | Sadece belirli alanlar harici alicilara gonderilir |
| Audit stack trace gizleme | `alert-audit.service.ts` | Stack trace sadece server-side log'a yazilir |

### 10.2 Dikkat Gerektiren Noktalar

- OPA path sanitization mevcut ama OPA servisi kullanilmiyor
- Audit log in-memory (max 2000 entry) -- database'e tasinmali
- Tenant rate limiter in-memory -- multi-instance'da Redis'e tasinmali

---

## 11. Oneriler

### Kritik (Hemen Yapilmali)

1. **F1 - SMS/Push Implementasyonu:** Twilio ve Firebase (veya baska provider) entegrasyonlarini
   tamamlayin. CRITICAL severity icin SMS/push olmadan alarm sistemi guvenirligi dusuktur.

2. **F2 - Cooldown Atomik SET NX:** `redisService.get() + set()` yerine `SET key value NX EX ttl`
   kullanin. Redis client'ta `setnx()` veya `set(key, value, { NX: true, EX: ttl })` kullanilmali.

3. **F5 - NATS DLQ ve Retry:** JetStream consumer configuration'inda `max_deliver`, `ack_wait`
   ve dead letter subject tanimlayin. Handler'larda explicit `ack()`/`nack()` kullanin.

### Yuksek (1-2 Hafta Icinde)

4. **F4 - AcknowledgmentTracker Redis'e Tasinmali:** In-memory Map yerine Redis Hash/Set kullanin.
   Restart sonrasi ack durumu kaybini onleyin.

5. **F7 - Auto-Resolve Implementasyonu:** Sensor degeri normal araliga dondugunde incident'i
   otomatik resolve eden mekanizma ekleyin. `SeverityClassifierService.isAutoResolvable()` metodunu
   evaluation akisina entegre edin.

6. **F6 - Severity Allowlist Guncelleme:** `ALLOWED_SEVERITIES` listesine `'low'`, `'medium'`,
   `'high'` ekleyin. Aksi halde bu severity'lerdeki alarmlar `'info'` olarak downgrade edilir.

### Orta (Sprint Planlama)

7. **F3 - Rules Engine Entegrasyonu:** `JsonRulesService`, `RuleEvaluatorService`,
   `RiskCalculatorService` gibi servisleri `AlertModule`'e baglayin veya dead code olarak
   tanimlayin. Mevcut haliyle bakim yukunu artiran kullanilmayan kod.

8. **AlertEvaluationService Unit Testleri:** En kritik servis icin kapsamli testler yazin.
   Cooldown, deduplication, concurrent evaluation senaryolarini kapsamali.

9. **Audit Log Kaliciligi:** In-memory audit log'u (max 2000 entry) PostgreSQL'e tasiyin.
   Production'da 2000 entry dakikalar icinde dolabilir.

10. **Rate Limiter Redis Tasima:** Tenant notification rate limiter'i Redis INCRBY/EXPIRE
    ile degistirin (multi-instance scaling icin).

---

## 12. Dosya Referanslari

### Alert Engine
- `/var/aqua-saas/apps/alert-engine/src/app.module.ts`
- `/var/aqua-saas/apps/alert-engine/src/alert/alert.module.ts`
- `/var/aqua-saas/apps/alert-engine/src/alert/services/alert-evaluation.service.ts`
- `/var/aqua-saas/apps/alert-engine/src/alert/services/alert-rule.service.ts`
- `/var/aqua-saas/apps/alert-engine/src/alert/event-handlers/sensor-reading.handler.ts`
- `/var/aqua-saas/apps/alert-engine/src/alert/resolvers/alert.resolver.ts`
- `/var/aqua-saas/apps/alert-engine/src/rules-engine/rules-engine.service.ts`
- `/var/aqua-saas/apps/alert-engine/src/rules-engine/rule-evaluator.service.ts`
- `/var/aqua-saas/apps/alert-engine/src/rules-engine/json-rules.service.ts`
- `/var/aqua-saas/apps/alert-engine/src/rules-engine/opa-rules.service.ts`
- `/var/aqua-saas/apps/alert-engine/src/rules-engine/behavior-tree.service.ts`
- `/var/aqua-saas/apps/alert-engine/src/rules-engine/safe-regex.util.ts`
- `/var/aqua-saas/apps/alert-engine/src/risk-scoring/risk-calculator.service.ts`
- `/var/aqua-saas/apps/alert-engine/src/risk-scoring/impact-analyzer.service.ts`
- `/var/aqua-saas/apps/alert-engine/src/risk-scoring/severity-classifier.service.ts`
- `/var/aqua-saas/apps/alert-engine/src/escalation/escalation-manager.service.ts`
- `/var/aqua-saas/apps/alert-engine/src/escalation/escalation-policy.service.ts`
- `/var/aqua-saas/apps/alert-engine/src/escalation/acknowledgment-tracker.service.ts`
- `/var/aqua-saas/apps/alert-engine/src/notification/notification-dispatcher.service.ts`
- `/var/aqua-saas/apps/alert-engine/src/notification/channel-router.service.ts`
- `/var/aqua-saas/apps/alert-engine/src/notification/template-renderer.service.ts`
- `/var/aqua-saas/apps/alert-engine/src/audit/alert-audit.service.ts`
- `/var/aqua-saas/apps/alert-engine/src/database/entities/alert-rule.entity.ts`
- `/var/aqua-saas/apps/alert-engine/src/database/entities/alert-incident.entity.ts`
- `/var/aqua-saas/apps/alert-engine/src/database/entities/escalation-policy.entity.ts`
- `/var/aqua-saas/apps/alert-engine/src/alert/entities/alert-history.entity.ts`

### Notification Service
- `/var/aqua-saas/apps/notification-service/src/notification/event-handlers/alert-triggered.handler.ts`
- `/var/aqua-saas/apps/notification-service/src/notification/services/notification-dispatcher.service.ts`
- `/var/aqua-saas/apps/notification-service/src/notification/services/retry-scheduler.service.ts`
- `/var/aqua-saas/apps/notification-service/src/notification/services/email.service.ts`
- `/var/aqua-saas/apps/notification-service/src/notification/services/sms.service.ts`
- `/var/aqua-saas/apps/notification-service/src/notification/services/push.service.ts`
- `/var/aqua-saas/apps/notification-service/src/notification/services/in-app.service.ts`
- `/var/aqua-saas/apps/notification-service/src/notification/services/notification-retention.service.ts`
