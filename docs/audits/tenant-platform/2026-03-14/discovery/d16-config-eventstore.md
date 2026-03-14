# D16 -- Config Service & Event Store Service Audit

**Auditor:** D16 -- Konfiguerasyon ve Event Sourcing Uzmani
**Tarih:** 2026-03-14
**Kapsam:** config-service, event-store-service
**Durum:** TAMAMLANDI

---

## BOLUM 1: CONFIG SERVICE

### 1.1 Genel Bakis

Config service, tum platform servisleri icin merkezi anahtar-deger (key-value) konfiguerasyon deposudur. Apollo Federation v2 subgraph olarak GraphQL API sunar. Port 3007 (main.ts) uzerinden calisir, production docker-compose'da port 3000 olarak override edilir.

| Ozellik | Deger |
|---------|-------|
| Port | 3007 (default), 3000 (production) |
| Protokol | GraphQL (Apollo Federation v2) |
| Veritabani | PostgreSQL (paylasilir: `aquaculture` DB) |
| Schema Izolasyonu | `tenantId` kolon filtreleme (schema-per-tenant DEGIL) |
| Sifreleme | AES-256-GCM (EncryptionService) |
| Cache | In-memory LRU, 1000 entry, 60s TTL |
| CQRS | NestJS @nestjs/cqrs |
| Event Bus | YOK -- kasitli olarak event yayinlamaz |

### 1.2 Entity Yapisi

#### Configuration (configurations tablosu)

```
id (uuid, PK)
tenantId (varchar 100, indexed) -- 'global' icin system-wide config
service (varchar 100, indexed) -- ornegin 'auth-service', 'farm-service'
key (varchar 255)              -- ornegin 'max_login_attempts'
value (text)                   -- duz metin veya sifreli (ENC_V1:...)
valueType (enum)               -- string | number | boolean | json | secret
environment (enum)             -- development | staging | production | all
description (varchar 500, nullable)
isSecret (boolean)             -- true ise deger sifreli saklanir
isActive (boolean)             -- soft delete mekanizmasi
defaultValue (varchar 255, nullable)
validationRules (jsonb, nullable) -- {min, max, pattern, allowedValues}
category (varchar 50, nullable)
tags (text[], nullable)
createdAt, updatedAt (timestamp)
createdBy, updatedBy (varchar 100)
version (int, @VersionColumn)  -- optimistic locking
```

**Unique Constraint:** `[tenantId, service, key, environment]`

#### ConfigurationHistory (configuration_history tablosu)

```
id (uuid, PK)
configurationId (uuid, indexed)
tenantId (varchar 100)
service, key (varchar)
previousValue, newValue (text) -- secret'ler icin [REDACTED]
changedBy (varchar 100)
changedAt (timestamp)
changeReason (varchar 255, nullable)
```

**Indexler:**
- `[configurationId, changedAt]`
- `[tenantId, changedAt]`

### 1.3 CQRS Pattern Kullanimi

#### Komutlar (Write Path)

| Command | Handler | Islem |
|---------|---------|-------|
| `CreateConfigurationCommand` | `CreateConfigurationHandler` | Yeni config olusturma, conflict kontrolu, sifreleme |
| `UpdateConfigurationCommand` | `UpdateConfigurationHandler` | Mevcut config guncelleme, history kaydedici |
| `DeleteConfigurationCommand` | `DeleteConfigurationHandler` | Soft delete (isActive=false) veya hard delete |
| `UpsertConfigurationCommand` | `UpsertConfigurationHandler` | INSERT ON CONFLICT DO UPDATE (atomik) |

**Transaction Yonetimi:**
- Tum command handler'lar `READ COMMITTED` izolasyon seviyesinde transaction kullanir
- `queryRunner.connect()` -> `startTransaction()` -> islem -> `commitTransaction()` / `rollbackTransaction()` -> `release()`
- UpsertConfigurationHandler istisna: QueryBuilder ile atomik upsert, explicit transaction yok

**BULGU [OLUMLU]:** Transaction yonetimi tutarli ve dogru uygulanmis. `finally` bloklarinda `queryRunner.release()` garanti ediliyor.

**BULGU [UYARI]:** UpsertConfigurationHandler'da history kaydedilmiyor. Diger handler'lar (ozellikle Update) ConfigurationHistory olusturur, ama upsert'de degisiklik gecmisi kaybolur.

#### Sorgular (Read Path)

| Query | Handler | Islem |
|-------|---------|-------|
| `GetConfigurationQuery` | `GetConfigurationHandler` | Tek config by service+key, global fallback |
| `GetConfigurationByIdQuery` | `GetConfigurationByIdHandler` | Tek config by UUID |
| `GetConfigurationsQuery` | `GetConfigurationsHandler` | Filtreleme ile listeleme (service, key, env, category, tags) |
| `GetConfigurationsByServiceQuery` | `GetConfigurationsByServiceHandler` | Servis bazli listeleme, tenant+global merge |
| `GetConfigurationHistoryQuery` | `GetConfigurationHistoryHandler` | Degisiklik gecmisi, limit ile (max 500) |

### 1.4 Tenant Schema Izolasyonu

Config service, schema-per-tenant yerine **tenantId kolon filtreleme** yaklasimini kullanir. Bu platformun diger servisleri icin (auth, farm, sensor vb.) `TenantSchemaMiddleware` kullanilirken, config service bundan bagimsiz calisir.

**Izolasyon Mekanizmasi:**
1. Resolver seviyesinde `getTenantId()` JWT'den tenantId ceker -- header'lardan ALINMAZ
2. Tum query handler'lar `where: { tenantId }` filtresi uygular
3. Tum command handler'lar tenantId'yi komut parametresinden alir
4. Unique constraint `[tenantId, service, key, environment]` veritabani seviyesinde izolasyon saglar

**BULGU [OLUMLU]:** Resolver'daki `getTenantId()` ve `getUserId()` metodlari SADECE JWT payload'dan deger alir. Header fallback yok, 'system' literal fallback yok. Guevenlik acisidan dogru.

**BULGU [OLUMLU]:** Mutation'lar admin erisimi gerektirir (`checkAdminAccess`), roller `admin`, `platform_admin`, `SUPER_ADMIN` kontrol edilir.

**BULGU [UYARI]:** `GetConfigurationsHandler`'da global fallback YOK. Sadece `config.tenantId = :tenantId` filtresi uygulanir. Bu diger query handler'lardan farkli (GetConfiguration ve GetConfigurationsByService global fallback yapar). Tutarsizlik var.

### 1.5 Default Degerler ve Override Mekanizmasi

Config service iki katmanli bir deger hiyerarsisi uygular:

```
1. Tenant-specific config (tenantId = 'abc-123')
2. Global config (tenantId = 'global')
```

**Calisma Mantigi:**
- `ConfigurationService.get()`: Once tenant-specific config aranir, bulunamazsa `tenantId='global'` ile global config yedek olarak doenuer
- Her iki kosulu tek sorguda coezer (OR kosuluyla iki where clause, `take: 2`)
- Tenant-specific deger bulunursa o tercih edilir

**seedDefaults() Metodu:**
- `INSERT ... ON CONFLICT DO NOTHING` ile toplu varsayilan deger yuekelme
- Sadece `tenantId='global'` icin calisir
- Mevcut degerleri ezmez (ON CONFLICT DO NOTHING)

**BULGU [OLUMLU]:** Override mekanizmasi temiz ve dogru: tenant degeri varsa o kullanilir, yoksa global fallback calisir.

**BULGU [EKSIK]:** `seedDefaults()` sadece hizmet icinden cagirilabilir ama hicbir yerden cagrilmiyor (onModuleInit bos). Default degerler icin bir bootstrap mekanizmasi eksik. Admin-api-service uzerinden veya migration ile seed yapilmasi gerekir.

**BULGU [EKSIK]:** `defaultValue` alani entity'de mevcut ama service katmaninda kullanilmiyor. `get()` metodu config bulunamazsa exception atar veya parametre olarak verilen defaultValue'yu dondurur -- ama entity uzerindeki `defaultValue` alanini hic kontrol etmez.

### 1.6 Cache Mekanizmasi

```typescript
// In-memory LRU cache
MAX_CACHE_SIZE = 1000
CACHE_TTL_MS = 60_000 (1 dakika)
```

**Cache Key Formati:** `${tenantId}:${service}:${key}`

**Invalidasyon Stratejisi:**
- Create/Update/Delete/Upsert handler'lari basarili islem sonrasi `invalidateCache()` cagirir
- Global config guncellendiginde, ilgili tum tenant cache entry'leri de temizlenir (suffix taramasi)
- Tenant config guncellendiginde, ayni key icin global entry de temizlenir

**BULGU [UYARI]:** In-memory cache, birden fazla config-service instance'i calistiginda tutarsiz olur. Instance A'daki guncelleme, Instance B'nin cache'ini gecersiz kilmaz. Distributed cache (Redis) kullanilmiyor. Single-instance deployment'da sorun olmaz, ama horizontal scaling'de stale read riski var.

**BULGU [OLUMLU]:** LRU eviction mantigi dogru: `lastAccessed` timestamp ile en eski entry cikarilir. Cache boyutu 1000'i gecemez.

### 1.7 Sifreleme (EncryptionService)

| Ozellik | Deger |
|---------|-------|
| Algoritma | AES-256-GCM (authenticated encryption) |
| Anahtar | `CONFIG_ENCRYPTION_KEY` env degiskeni |
| Format | `ENC_V1:{base64_payload}` -- payload icinde iv, authTag, data |
| IV | Her sifreleme icin rastgele 16 byte |
| Anahtar turetme | 64 hex char ise dogrudan, degilse scrypt ile turetim |

**Guvenlik Kontrolleri:**
- Production'da `CONFIG_ENCRYPTION_KEY` zorunlu (yoksa exception atar)
- Resolver'da `@ResolveField` ile secret degerler `[ENCRYPTED]` olarak maskelenir
- History'de secret degisiklikler `[REDACTED]` olarak kaydedilir
- Sifre cozme sadece `ConfigurationService.get()` icinden yapilir

**BULGU [OLUMLU]:** AES-256-GCM kullanimi, IV randomness ve ENC_V1 prefix versiyonlama dogru. Auth tag ile tampered ciphertext algilanir.

**BULGU [UYARI]:** Scrypt ile anahtar turetmede salt, master key'in SHA256 hash'inin ilk 16 byte'i olarak hesaplaniyor. Salt'in deterministic olmasi key derivation'in guvenligini dusurur. Ancak dokumanda 64 hex char (dogrudankullanim) onerilir.

### 1.8 GraphQL API

#### Queries
| Islem | Arguemanlar | Aciklama |
|-------|------------|----------|
| `configuration` | service, key, environment? | Tek config okuma |
| `configurationById` | id | UUID ile okuma |
| `configurations` | filter? | Filtreli listeleme |
| `configurationsByService` | service, environment? | Servis bazli listeleme |
| `configurationHistory` | configurationId, limit? | Degisiklik gecmisi (admin only) |

#### Mutations
| Islem | Arguemanlar | Aciklama |
|-------|------------|----------|
| `createConfiguration` | CreateConfigurationInput | Yeni config (admin) |
| `updateConfiguration` | UpdateConfigurationInput | Config guncelleme (admin) |
| `deleteConfiguration` | id, hardDelete? | Silme (admin) |
| `setConfiguration` | service, key, value, env?, isSecret? | Atomik upsert (admin) |

**Input Validasyonu:**
- Service name: `^[a-z][a-z0-9-]*[a-z0-9]$` (lowercase, hyphens)
- Key: `^[a-z][a-z0-9_.]*[a-z0-9]$` (lowercase, underscores, dots)
- Value: max 10000 karakter
- ConfigurationValidationService ile tip bazli validasyon (number range, boolean format, JSON parse, pattern, allowedValues)

**BULGU [OLUMLU]:** Input validasyonu kapsamli. Regex pattern'lar injection'a karsi koruma saglar. `forbidNonWhitelisted: true` ile beklenmeyen alanlar reddedilir.

### 1.9 Config Service'i Tuketen Servisler

Kaynak kod ve docker-compose analizine gore:

| Servis | Kullanim Sekli | Dogrudan Baglanti |
|--------|---------------|-------------------|
| gateway-api | Federation subgraph olarak entegre | CONFIG_SERVICE_URL ile GraphQL introspection |
| admin-api-service | TenantConfigurationService (AYRI entity -- TenantConfiguration) | config-service'e BAGLANMIYOR, kendi DB entity'si |
| ai-service | TenantAgentConfig entity (kendi DB'sinde) | config-service'e BAGLANMIYOR |
| observability-service | metrics-aggregator'da referans | Dolaylı referans |

**BULGU [KRITIK]:** Admin-api-service'deki `TenantConfigurationService` ve config-service birbirinden TAMAMEN BAGIMSIZ iki ayri konfiguerasyon sistemi. Admin-api-service kendi `TenantConfiguration` entity'sini kullanir (user limits, storage, API keys, webhooks, feature flags, branding, domain, security). Config-service ise service-level key-value store olarak calisir. Bu iki sistem arasinda senkronizasyon veya entegrasyon YOK.

**BULGU [UYARI]:** Config service GraphQL Federation subgraph olarak gateway'e baglanir, ancak diger servislerin config-service'i programatik olarak cagirdigi (SDK/client) bir mekanizma gorulmuyor. Servisler genellikle environment degiskenlerinden konfiguerasyon okur, config-service'i kullanmaz.

### 1.10 Docker Compose Deployment

```yaml
config-service:
  image: ghcr.io/okan-wqm/aquaculture_platform/config-service:latest
  container_name: aqua-config
  environment:
    PORT: 3000
    DATABASE_NAME: ${POSTGRES_DB:-aquaculture}  # Paylasilir DB
    DATABASE_SYNC: "true"                        # Tehlikeli!
    CONFIG_ENCRYPTION_KEY: ${ENCRYPTION_KEY}
    JWT_SECRET: ${JWT_SECRET}
  networks:
    - aqua-internal  # Sadece internal network
```

**BULGU [UYARI]:** `DATABASE_SYNC: "true"` production'da tehlikeli. TypeORM synchronize, schema degisikliklerini otomatik uygular ve veri kaybi riski tasir. Migration kullanilmali.

**BULGU [UYARI]:** Config service, `aquaculture` paylasilan veritabaninda calisir ama `configurations` ve `configuration_history` tablolari icin ayri bir schema yok. Tablo isimleri diger servislerle cakisma potansiyeli tasir (her ne kadar unique isimler secilmis olsa da).

---

## BOLUM 2: EVENT STORE SERVICE

### 2.1 Genel Bakis

Event store service, platformun event sourcing alt yapisini saglar. REST API uzerinden event stream yonetimi, snapshot'lar ve projection'lar sunar. Service-to-service iletisim icin tasarlanmistir.

| Ozellik | Deger |
|---------|-------|
| Port | 3010 (default) |
| Protokol | REST (HTTP) |
| Veritabani | PostgreSQL (ayri: `aquaculture_events`) |
| Guvenlik | InternalApiKeyGuard (X-Internal-Api-Key header) |
| Tenant Izolasyonu | `tenantId` kolon + UUID v4 validasyonu |
| CQRS Module | Import edilir ama CQRS pattern KULLANILMIYOR |
| Concurrency | Optimistic concurrency control + pessimistic_write lock |

### 2.2 Entity Yapisi

#### StoredEvent (stored_events tablosu)

```
id (uuid, PK)
streamName (varchar 255)      -- "{AggregateType}-{AggregateId}"
globalPosition (bigint, unique) -- Global event log sirasi
streamPosition (bigint)         -- Stream icindeki sira
aggregateType (varchar 255)     -- 'Farm', 'Sensor', 'Alert'
aggregateId (uuid)
version (int)                   -- Optimistic concurrency
eventType (varchar 255)         -- 'FarmCreated', 'SensorReadingRecorded'
payload (jsonb)                 -- Domain event verisi
metadata (jsonb, nullable)      -- Tracing, user info
tenantId (uuid)
correlationId (uuid, nullable)  -- Request tracing
causationId (uuid, nullable)    -- Nedensellik zincirleme
userId (uuid, nullable)
occurredAt (timestamptz)        -- Domain olay zamani
storedAt (timestamptz)          -- Depolama zamani (auto)
schemaVersion (int, default 1)  -- Event schema versiyonu
```

**Unique Constraints:**
- `[aggregateType, aggregateId, version]` -- concurrency control
- `[globalPosition]` -- global ordering

**Indexler (10 adet):**
- `[streamName]`, `[eventType]`, `[tenantId]`, `[occurredAt]`, `[correlationId]`
- `[tenantId, streamName, version]`, `[tenantId, globalPosition]`, `[tenantId, eventType]`, `[tenantId, storedAt]`

**BULGU [UYARI]:** 10 index cok fazla. Her INSERT isleminde tum index'ler guncellenmek zorunda. Yuksek event hacminde yazma performansini dusurur. `[streamName]` ve `[tenantId, streamName, version]` gibi overlapping index'ler var -- `[tenantId, streamName, version]` zaten `streamName` aramalarini kapsayabilir.

#### EventStream (event_streams tablosu)

```
id (uuid, PK)
streamName (varchar 255)       -- Unique per tenant
aggregateType (varchar 255)
aggregateId (uuid)
currentVersion (int)
eventCount (bigint)
tenantId (uuid)
isDeleted (boolean)            -- Soft delete
createdAt, updatedAt (timestamptz)
lastEventAt (timestamptz, nullable)
```

**Unique Constraint:** `[tenantId, streamName]`

#### Snapshot (snapshots tablosu)

```
id (uuid, PK)
aggregateType (varchar 255)
aggregateId (uuid)
version (int)                  -- Hangi versiyonda alindigini gosterir
state (jsonb)                  -- Aggregate'in serialize edilmis durumu
tenantId (uuid)
createdAt (timestamptz)
schemaVersion (int, default 1)
```

**Unique Constraint:** `[aggregateType, aggregateId, tenantId]`
(aggregate basina tek snapshot -- upsert ile guncellenir)

#### ProjectionCheckpoint (projection_checkpoints tablosu)

```
id (uuid, PK)
projectionName (varchar 255)
description (varchar 500, nullable)
position (bigint)              -- Global event log'daki pozisyon
status (enum)                  -- running | paused | stopped | faulted
tenantId (uuid)
consumerGroup (varchar 100, nullable)
eventTypes (jsonb, default [])
aggregateTypes (jsonb, default [])
eventsProcessed (bigint)
eventsFailed (bigint)
lastError (text, nullable)
lastErrorAt (timestamptz, nullable)
avgProcessingTimeMs (float)    -- EMA ile hesaplanir
createdAt, updatedAt (timestamptz)
lastProcessedAt (timestamptz, nullable)
```

**Unique Constraint:** `[tenantId, projectionName]`

### 2.3 Event Sourcing Persistence

#### Append Operasyonu

`appendToStream()` metodu atomik event yazma islemini yonetir:

1. **Stream Lock:** `pessimistic_write` lock ile stream entity'si alinir
2. **Soft-delete Check:** Silinmis stream'e ekleme reddedilir (ConflictException)
3. **Concurrency Check:** `expectedVersion !== -1` ise mevcut version ile karsilastirilir
4. **Global Position:** PostgreSQL sequence (`stored_events_global_position_seq`) ile atomik pozisyon atanir
5. **Bulk Insert:** Tum event'ler tek `INSERT` ile yazilir
6. **Stream Update:** `currentVersion`, `eventCount`, `lastEventAt` guncellenir
7. **Commit:** Transaction tamamlanir

**BULGU [OLUMLU]:** Pessimistic write lock + optimistic concurrency versioning kombinasyonu saglamdir. Global position icin PostgreSQL sequence kullanilmasi ordering garantisi saglar.

**BULGU [OLUMLU]:** `generate_series` ile toplu sequence allocation verimlidir -- her event icin ayri sequence call yerine tek call yapilir.

**BULGU [UYARI]:** Transaction izolasyon seviyesi `READ COMMITTED`. Iki farkli stream'e paralel append'lerde sorun olmaz, ama ayni stream'e paralel append'lerde pessimistic lock bu sorunu cozuyor. Serialization failure (40001) yakalanip ConflictException olarak donduruluyor -- dogru.

#### Read Operasyonu

`readStream()` metodu:
- Stream varligini ve `isDeleted` durumunu kontrol eder
- Version bazli filtreleme (`fromVersion` sonrasi)
- Forward/backward direction destegi
- Max count ile sinirlandirma (default 100, max 1000)
- `isEndOfStream` flagi ile stream sonunu belirler

`readAllEvents()` metodu:
- Cross-stream okuma, tenant-scoped
- globalPosition bazli filtreleme
- eventType, aggregateType, tarih araligi filtreleri
- Pagination: position-based (offset yok)

### 2.4 Projections

Projection sistemi event stream'leri isleme mekanizmasi saglar:

#### Lifecycle

```
STOPPED -> registerProjection() -> RUNNING
RUNNING -> pauseProjection()   -> PAUSED
PAUSED  -> resumeProjection()  -> RUNNING
RUNNING -> stopProjection()    -> STOPPED
RUNNING -> (hata)              -> FAULTED
FAULTED -> resetProjection()   -> (pozisyon sifirlanir)
```

#### Processing Loop

```
1. In-memory kayit (registerProjection)
2. Checkpoint DB'den okunur (veya cache'den)
3. globalPosition > checkpoint.position olan event'ler sorgulanir
4. Her event handler'a teslim edilir (retry policy ile)
5. Checkpoint pozisyonu guncellenir
6. Adaptive back-off: event yoksa delay artar (100ms -> 5s), event varsa 100ms'ye dusuerueluer
```

**Retry Policy:**
- Default: 3 retry, 1s initial delay, 30s max delay, 2x backoff
- Bir event retry sonrasi basarisiz olursa: projection FAULTED durumuna gecer, interval temizlenir

**BULGU [OLUMLU]:** Adaptive back-off idle doenguelerde CPU ve DB yukunu azaltir. Jitter (%+-20) thundering herd sorununu onler.

**BULGU [OLUMLU]:** Checkpoint caching ile idle doenguelerde DB round-trip azaltilir (IDLE_STATUS_RECHECK_BATCHES=10). Sadece her 10 bos batch'te bir DB okunur.

**BULGU [UYARI]:** Projection handler'lar in-memory `registeredProjections` Map'inde tutulur. Servis yeniden basladiginda tum kayitlar kaybolur ve disaridan tekrar `registerProjection()` cagirilmasi gerekir. Kalici projection tanimlamasi yok.

**BULGU [KRITIK]:** `processBatch()` icerisinde lock key `${name}:${tenantId}` formunda. Ama `lockKey` degiskeni `try` blogu icinde ve `finally` blogu icinde yeniden tanimlanir -- bu yerel kapsam dogrudan ayni degeri uretir, sorun yok. Ancak `getProjectionTenantId()` registration'dan tenantId cekerken, `processBatch` parametresi olarak gelen tenantId KULLANILMIYOR -- registration'daki tenantId kullaniliyor. Eger farkli bir tenantId ile cagirilirsa, yanlis tenant'in event'leri islenebilir. Controller'da ise tenantId header'dan gelir.

**BULGU [UYARI]:** Processing loop'da `schedulerRegistry.addInterval()` ile timeout nesnesi interval olarak kaydedilir (`timeout as unknown as ReturnType<typeof setInterval>`). Bu type assertion teknik olarak dogru calissa da interval-timeout karistirmasi sorunlara yol acabilir.

### 2.5 Snapshots

Snapshot mekanizmasi aggregate state'lerin periyodik olarak kaydedilmesini saglar:

**Olusturma:**
- `createSnapshot()`: Atomik upsert (`UPSERT ... ON CONFLICT`)
- Version validasyonu: Snapshot version'u stream'in current version'unu asamaz
- Aggregate basina tek snapshot (unique constraint: `[aggregateType, aggregateId, tenantId]`)
- schemaVersion ile snapshot format evrimi desteklenir

**Kullanim:**
- `loadAggregate()`: Once snapshot yuekelenir, sonra snapshot version'undan sonraki event'ler okunur
- `MAX_LOAD_AGGREGATE_EVENTS = 1000` limiti -- asilirsa uyari loglenir

**BULGU [OLUMLU]:** Snapshot + delta event replay pattern'i dogru uygulanmis. 1000 event limiti ile replay boyutu kontrol altinda.

**BULGU [EKSIK]:** Otomatik snapshot alma mekanizmasi YOK. Snapshot'lar sadece API uzerinden manuel olarak olusturulur. Bir aggregate'in event sayisi belirli bir esigi astiginda otomatik snapshot alinmasi onerilir.

**BULGU [UYARI]:** Aggregate basina tek snapshot tutulur (upsert). Eski snapshot state'leri kaybolur. Point-in-time aggregate state reconstruction icin snapshot gecmisi gerekebilir.

### 2.6 Event Stream Management

**Stream Olusturma:**
- Otomatik: Ilk `appendToStream()` cagrisinda stream olusturulur
- Stream name formati: `{AggregateType}-{AggregateId}`
- Aggregate type validasyonu: `^[A-Za-z][A-Za-z0-9]{0,63}$` (path traversal, injection korunmasi)

**Stream Silme:**
- Soft delete: `isDeleted = true` olarak isaretlenir
- Cascade: Iliskili snapshot da silinir (hard delete)
- Silinmis stream'e event ekleme reddedilir
- Silinmis stream okunursa bos slice doner

**Stream Bilgisi:**
- `getStreamInfo()`: Stream metadata'si (currentVersion, eventCount, lastEventAt)
- Snapshot durumu da dahil edilir (hasSnapshot, snapshotVersion)

**Concurrency Check:**
- `checkConcurrency()`: Beklenen version ile mevcut version karsilastirilir
- Cakisma varsa cakisan event'lerin listesi donduruluor

**BULGU [OLUMLU]:** Aggregate type validasyonu ile stream name injection onlenir.

**BULGU [UYARI]:** Stream name `{AggregateType}-{AggregateId}` formatinda, ancak AggregateType icinde hyphen yasaklansa da AggregateId bir UUID (icinde hyphen var). Bu sorun olusturmaz cunku AggregateType pattern'i hyphen'i yasaklar, ama parse etme gerektiginde (type ve id'yi ayirma) ilk hyphen'e gore split yapilmasi gerekir -- bu islem kodda yapilmiyor cunku stream name zaten bilesimleriyle birlikte saklanir.

### 2.7 Replay Capability

Event replay birden fazla mekanizma ile desteklenir:

1. **Stream Replay:** `readStream(fromVersion=0)` ile bir aggregate'in tum event'leri okunabilir
2. **Global Replay:** `readAllEvents(fromPosition=0)` ile tum event log yeniden okunabilir
3. **Projection Reset:** `resetProjection(position=0)` ile bir projection sifirlanir ve event'ler yeniden islenir
4. **Aggregate Load:** `loadAggregate()` snapshot + delta event'leri birlestirir
5. **Search:** `searchEvents()` ile tarih araligi, eventType, correlationId bazli arama

**BULGU [OLUMLU]:** readAllEvents position-based pagination ile buyuek event log'lari verimli taranabilir.

**BULGU [EKSIK]:** Bulk replay (tum aggregate'leri yeniden olusturma) icin dedicated bir endpoint yok. readAllEvents event-by-event okuma yapar, ama aggregate bazli toplu replay gerektiginde verimli degil.

**BULGU [EKSIK]:** Event schema evolution/upcasting mekanizmasi yok. `schemaVersion` alani var ama eski versiyondaki event'leri yeni formata donusturme mantigi implementasyonda gorulmuyor.

### 2.8 Guvenlik

#### Tenant Izolasyonu

- Tum endpoint'ler `X-Tenant-Id` header'i gerektirir
- TenantId UUID v4 formatinda validate edilir (`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
- Tum DB sorgulari `tenantId` filtresi uygular

**BULGU [KRITIK]:** TenantId header'dan (`X-Tenant-Id`) alinir, JWT'den DEGIL. Bu, gateway seviyesinde header'in dogru set edildigine guevenmek zorunda kalir. Config service ise tenantId'yi JWT'den alir -- iki servis arasinda tenant kimlik dogrulama stratejisi farkli.

#### API Key Guard

```typescript
// InternalApiKeyGuard
- Production'da INTERNAL_API_KEY env zorunlu -- yoksa request reddedilir
- Development'ta anahtar yoksa uyari loglanir, request izin verilir
- X-Internal-Api-Key header'i ile dogrulama
- Health endpoint'ler muaf
```

**BULGU [OLUMLU]:** Production'da API key zorunlulugu saglanmis. Development'ta rahat calismaya izin verilir.

**BULGU [UYARI]:** API key karsilastirmasi `requestKey !== apiKey` seklinde string esitlik kontrolu. Timing-safe karsilastirma (`crypto.timingSafeEqual`) kullanilmiyor -- side-channel saldiri riski (dusuk seviye ama best-practice degil).

#### DTO Validasyonu

- `occurredAt` timestamp'i icin custom validator: 30 gun geri, 5 dakika ileri siniri
- Aggregate type allowlist pattern'i
- Tum numerik degerler icin min/max sinirlar
- `forbidNonWhitelisted: true` ile beklenmeyen alanlar reddedilir

### 2.9 Deployment Durumu

**BULGU [KRITIK]:** Event store service docker-compose.droplet.yml'de TANIMLI DEGIL. Servis kodu var ama production deployment'a dahil edilmemis. Bu, servisin henuz production'da kullanilmadigini gosterir.

---

## BOLUM 3: KARSILASTIRMA VE CROSS-CUTTING BULGULAR

### 3.1 Iki Servis Karsilastirmasi

| Ozellik | Config Service | Event Store Service |
|---------|---------------|---------------------|
| API Tipi | GraphQL (Federation v2) | REST (HTTP) |
| Port | 3007 / 3000 (prod) | 3010 |
| DB | Paylasilan (`aquaculture`) | Ayri (`aquaculture_events`) |
| Tenant ID Kaynagi | JWT payload | X-Tenant-Id header |
| Auth | JWT + Admin role check | Internal API Key |
| CQRS | Aktif kullaniliyor | Import edilmis ama kullanilmiyor |
| Cache | In-memory LRU | Stats cache (60s TTL) |
| History/Audit | ConfigurationHistory entity | Event'ler kendisi audit trail |
| Production Deploy | Evet | HAYIR |
| Test | Yok | 1 spec dosyasi (controller) |

### 3.2 Config Fragmentasyonu Sorunu

Platform genelinde UC FARKLI konfiguerasyon sistemi tespit edilmistir:

1. **Config Service** (`apps/config-service`): Merkezi key-value store, GraphQL API. Service-level generic config.
2. **Admin-API TenantConfiguration** (`apps/admin-api-service/src/settings`): Tenant-specific yapilandirma (user limits, storage, API keys, webhooks, feature flags, branding, domain, security). REST API. Kendi entity ve tablosu.
3. **Environment Variables**: Tum servisler temel konfiguerasyonu env degiskenlerinden okur (DB baglanti, JWT secret, port, vb.).

**BULGU [KRITIK]:** Bu uc sistem arasinda HICBIR ENTEGRASYON yok. Admin-API'deki tenant konfiguerasyonu config-service'e yazilmiyor. Config-service'deki degerler diger servislere push edilmiyor. Her servis kendi env degiskenlerini kullaniyor. Merkezi konfiguerasyon vaadi karsilanmiyor.

### 3.3 Event Store Kullanim Durumu

**BULGU [KRITIK]:** Event store service kodda mevcut ama:
- Docker-compose'da tanimli degil
- Hicbir servis event-store-service'e baglanmiyor (referans yok)
- Servisler kendi event'lerini NATS uzerinden yayinliyor, event store'a yazmiyor
- Production'da deploy edilmemis

Bu, event store'un platform mimarisine entegre edilmemis bir altyapi bileseni oldugunu gosterir.

---

## BOLUM 4: BULGULAR OZETI

### Kritik (Acil Aksiyon)

| # | Bulgu | Servis | Dosya |
|---|-------|--------|-------|
| K1 | Config fragmentasyonu: 3 bagimsiz config sistemi, entegrasyon yok | Platform | - |
| K2 | Event store production'da deploy edilmemis, hicbir servis kullanmiyor | Event Store | docker-compose.droplet.yml |
| K3 | TenantId header'dan alinir (JWT degil) -- gateway guvenine bagli | Event Store | event-store.controller.ts |
| K4 | Admin-API TenantConfiguration ile Config Service arasinda senkronizasyon yok | Platform | - |

### Uyarilar (Planlanan Iyilestirme)

| # | Bulgu | Servis | Dosya |
|---|-------|--------|-------|
| U1 | UpsertConfigurationHandler history kaydedmiyor | Config | upsert-configuration.handler.ts |
| U2 | In-memory cache multi-instance'da stale read riski | Config | configuration.service.ts |
| U3 | DATABASE_SYNC="true" production'da tehlikeli | Config | docker-compose.droplet.yml |
| U4 | GetConfigurationsHandler global fallback yapmiyor (tutarsizlik) | Config | get-configurations.handler.ts |
| U5 | 10 index yazma performansini dusurur | Event Store | stored-event.entity.ts |
| U6 | Projection handler'lar in-memory -- restart'ta kaybolur | Event Store | projections.service.ts |
| U7 | API key karsilastirmasi timing-safe degil | Event Store | internal-api-key.guard.ts |
| U8 | Scrypt salt'i deterministic (dusuk risk) | Config | encryption.service.ts |
| U9 | scheduler timeout/interval type casting | Event Store | projections.service.ts |

### Eksikler (Gelistirme Onerisi)

| # | Bulgu | Servis | Dosya |
|---|-------|--------|-------|
| E1 | seedDefaults() hicbir yerden cagrilmiyor | Config | configuration.service.ts |
| E2 | Entity'deki defaultValue alani kullanilmiyor | Config | configuration.entity.ts |
| E3 | Otomatik snapshot alma mekanizmasi yok | Event Store | event-store.service.ts |
| E4 | Event schema upcasting/evolution yok | Event Store | - |
| E5 | Bulk aggregate replay endpoint'i yok | Event Store | - |
| E6 | Config service icin birim testleri yok | Config | - |

### Olumlu Bulgular

| # | Bulgu | Servis |
|---|-------|--------|
| O1 | JWT-only tenant identity (header fallback yok) | Config |
| O2 | AES-256-GCM authenticated encryption | Config |
| O3 | Secret masking (GraphQL + history) | Config |
| O4 | Transaction yonetimi tutarli | Config |
| O5 | Pessimistic lock + optimistic concurrency | Event Store |
| O6 | PostgreSQL sequence ile global ordering | Event Store |
| O7 | Adaptive back-off ile projection processing | Event Store |
| O8 | occurredAt timestamp bounds validation | Event Store |
| O9 | Aggregate type injection korunmasi | Event Store |
| O10 | Input validasyonu kapsamli (her iki servis) | Her ikisi |

---

## BOLUM 5: ONERILER

### Oncelik 1: Config Birlestirme Stratejisi
Admin-API TenantConfiguration ve Config Service arasinda bir karar verilmeli:
- **Secenek A:** TenantConfiguration verilerini config-service'e migrate edin
- **Secenek B:** Config service'i kaldir, admin-api TenantConfiguration'i merkezi yap
- **Secenek C:** Ikisini farkli katmanlarda tut (platform-level vs service-level) ama senkronizasyon ekle

### Oncelik 2: Event Store Entegrasyonu
Event store'u ya production'a deploy edin ve NATS event handler'larindan event store'a yazma ekleyin, ya da projeyi kapatip kaynagi temizleyin.

### Oncelik 3: Config Service Iyilestirmeleri
- Redis-based distributed cache ekleyin
- seedDefaults() icin bootstrap mekanizmasi olusturun
- DATABASE_SYNC="false" yapip migration'a gecin
- Birim testleri yazin

### Oncelik 4: Event Store Iyilestirmeleri (deploy edilecekse)
- Otomatik snapshot mekanizmasi (ornegin her 100 event'te bir)
- Event schema upcasting framework'u
- TenantId'yi JWT'den almaya gecis
- `crypto.timingSafeEqual` ile API key karsilastirmasi
- Index optimizasyonu (overlapping index'leri kaldir)

---

**Dosya Referanslari:**

Config Service:
- `/var/aqua-saas/apps/config-service/src/app.module.ts`
- `/var/aqua-saas/apps/config-service/src/main.ts`
- `/var/aqua-saas/apps/config-service/src/configuration/configuration.resolver.ts`
- `/var/aqua-saas/apps/config-service/src/configuration/entities/configuration.entity.ts`
- `/var/aqua-saas/apps/config-service/src/configuration/services/configuration.service.ts`
- `/var/aqua-saas/apps/config-service/src/configuration/services/encryption.service.ts`
- `/var/aqua-saas/apps/config-service/src/configuration/handlers/upsert-configuration.handler.ts`

Event Store Service:
- `/var/aqua-saas/apps/event-store-service/src/app.module.ts`
- `/var/aqua-saas/apps/event-store-service/src/main.ts`
- `/var/aqua-saas/apps/event-store-service/src/event-store/event-store.controller.ts`
- `/var/aqua-saas/apps/event-store-service/src/event-store/services/event-store.service.ts`
- `/var/aqua-saas/apps/event-store-service/src/event-store/entities/stored-event.entity.ts`
- `/var/aqua-saas/apps/event-store-service/src/event-store/entities/snapshot.entity.ts`
- `/var/aqua-saas/apps/event-store-service/src/projections/projections.service.ts`
- `/var/aqua-saas/apps/event-store-service/src/guards/internal-api-key.guard.ts`

Cross-Service:
- `/var/aqua-saas/apps/admin-api-service/src/settings/services/tenant-configuration.service.ts`
- `/var/aqua-saas/docker-compose.droplet.yml`
