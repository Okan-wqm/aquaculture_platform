# VFD Referans Kilavuzu -- Marka Konfigurasyonlari ve API

> Aquaculture Platform VFD (Variable Frequency Drive) sistemi icin eksiksiz teknik referans.
> 8 marka, 8 protokol, 30+ risk kurali ve tam GraphQL API dokumantasyonu.

---

## Icindekiler

1. [GraphQL API Referansi](#1-graphql-api-referansi)
   - 1.1 VFD Cihaz Yonetimi
   - 1.2 VFD Komut API
   - 1.3 VFD Okuma API
   - 1.4 VFD Programlama API
   - 1.5 VFD Otomasyon API
2. [Marka Konfigurasyon Referansi](#2-marka-konfigurasyon-referansi)
   - 2.1 Danfoss FC Series
   - 2.2 ABB ACS Series
   - 2.3 Siemens SINAMICS G120
   - 2.4 Schneider Altivar
   - 2.5 Yaskawa
   - 2.6 Delta VFD
   - 2.7 Mitsubishi FR
   - 2.8 Rockwell PowerFlex
3. [Protokol Referansi](#3-protokol-referansi)
4. [Risk Kurallari Referansi](#4-risk-kurallari-referansi)
5. [Veri Tipleri ve Olcekleme](#5-veri-tipleri-ve-olcekleme)
6. [Hata Kodlari](#6-hata-kodlari)

---

## 1. GraphQL API Referansi

### 1.1 VFD Cihaz Yonetimi

#### `registerVfdDevice` Mutation

Yeni bir VFD cihazini sisteme kaydeder. Istege bagli olarak kayit sirasinda baglanti testi yapar.

```graphql
mutation RegisterVfd($input: RegisterVfdInput!) {
  registerVfdDevice(input: $input) {
    success
    error
    connectionTestPassed
    latencyMs
    vfdDevice {
      id
      name
      brand
      modelSeries
      protocol
      status
      createdAt
    }
  }
}
```

**Input Parametreleri:**

| Parametre | Tip | Zorunlu | Aciklama |
|-----------|-----|---------|----------|
| name | String | Evet | Cihaz adi |
| brand | VfdBrand | Evet | Marka (danfoss, abb, siemens, ...) |
| modelSeries | String | Evet | Model serisi (FC302, ACS580, ...) |
| protocol | VfdProtocol | Evet | Iletisim protokolu |
| configuration | JSON | Evet | Protokole ozgu baglanti ayarlari |
| farmId | ID | Hayir | Bagli oldugu ciftlik |
| tankId | ID | Hayir | Bagli oldugu tank |
| skipConnectionTest | Boolean | Hayir | true ise kayit sirasinda baglanti testi atlanir |

**Yetki:** `TENANT_ADMIN`, `MODULE_MANAGER`

**Donus Tipi:** `VfdRegistrationResult`

| Alan | Tip | Aciklama |
|------|-----|----------|
| success | Boolean | Kayit basarili mi |
| vfdDevice | VfdDevice | Olusturulan cihaz nesnesi |
| error | String | Hata mesaji (basarisiz ise) |
| connectionTestPassed | Boolean | Baglanti testi sonucu |
| latencyMs | Float | Baglanti gecikme suresi (ms) |

---

#### `updateVfdDevice` Mutation

Mevcut bir VFD cihazinin bilgilerini gunceller.

```graphql
mutation UpdateVfd($id: ID!, $input: UpdateVfdInput!) {
  updateVfdDevice(id: $id, input: $input) {
    id
    name
    brand
    modelSeries
    protocol
    status
    updatedAt
  }
}
```

**Yetki:** `TENANT_ADMIN`, `MODULE_MANAGER`

---

#### `deleteVfdDevice` Mutation

Bir VFD cihazini kalici olarak siler.

```graphql
mutation DeleteVfd($id: ID!) {
  deleteVfdDevice(id: $id)
}
```

**Yetki:** `TENANT_ADMIN` (yalnizca)

---

#### `activateVfdDevice` / `deactivateVfdDevice` Mutation

Cihazi aktif/pasif duruma getirir.

```graphql
mutation ActivateVfd($id: ID!) {
  activateVfdDevice(id: $id) {
    id
    status
  }
}
```

**Yetki:** `TENANT_ADMIN`, `MODULE_MANAGER`

---

#### `testVfdConnection` Mutation

Kayit oncesi baglanti testi yapar.

```graphql
mutation TestConnection($input: TestVfdConnectionInput!) {
  testVfdConnection(input: $input) {
    success
    latencyMs
    error
    sampleData
    firmwareVersion
    deviceInfo
    testedAt
  }
}
```

**Yetki:** `TENANT_ADMIN`, `MODULE_MANAGER`

---

#### `vfdDevices` Query

Tum VFD cihazlarini filtreleme ve sayfalama ile listeler.

```graphql
query ListVfdDevices($filter: VfdDeviceFilter, $pagination: VfdPagination) {
  vfdDevices(filter: $filter, pagination: $pagination) {
    items {
      id
      name
      brand
      modelSeries
      protocol
      status
      latestReading {
        outputFrequency
        motorCurrent
        motorVoltage
        timestamp
      }
    }
    total
    page
    limit
    totalPages
  }
}
```

**Filtre Parametreleri:**

| Parametre | Tip | Aciklama |
|-----------|-----|----------|
| brand | VfdBrand | Markaya gore filtrele |
| status | VfdDeviceStatus | Duruma gore filtrele |
| farmId | ID | Ciftlige gore filtrele |
| tankId | ID | Tanka gore filtrele |
| search | String | Isim ile arama |

---

#### `vfdDevice` Query

Tekil cihaz sorgulama.

```graphql
query GetVfdDevice($id: ID!) {
  vfdDevice(id: $id) {
    id
    name
    brand
    modelSeries
    protocol
    status
    configuration
    latestReading {
      outputFrequency
      motorCurrent
      motorVoltage
      outputPower
      dcBusVoltage
      heatsinkTemp
      motorThermal
      faultCode
      statusWord
      timestamp
    }
  }
}
```

---

#### `vfdStats` Query

VFD filo istatistiklerini dondurur.

```graphql
query VfdFleetStats {
  vfdStats {
    total
    active
    inactive
    faulted
    maintenance
    byBrand
    byProtocol
    byStatus
  }
}
```

---

### 1.2 VFD Komut API

Tum komut mutation'lari `VfdCommandResult` dondurur:

| Alan | Tip | Aciklama |
|------|-----|----------|
| success | Boolean | Komut basarili mi |
| message | String | Sonuc mesaji |
| executedAt | DateTime | Yurutme zamani |
| latencyMs | Float | Gecikme (ms) |

#### `sendVfdCommand` Mutation

Genel amacli komut gonderme.

```graphql
mutation SendCommand($vfdDeviceId: ID!, $command: VfdCommandInput!) {
  sendVfdCommand(vfdDeviceId: $vfdDeviceId, command: $command) {
    success
    message
    latencyMs
  }
}
```

**VfdCommandInput Parametreleri:**

| Parametre | Tip | Aciklama |
|-----------|-----|----------|
| command | VfdCommandType | Komut tipi |
| value | Float | Deger (frekans/hiz icin) |

**VfdCommandType Enum Degerleri:**

| Deger | Aciklama |
|-------|----------|
| `start` | Motoru calistir |
| `stop` | Motoru durdur (rampa ile) |
| `reverse` | Yon degistir |
| `set_frequency` | Frekans ayarla (Hz) |
| `set_speed` | Hiz ayarla (%) |
| `fault_reset` | Ariza sifirla |
| `quick_stop` | Hizli durus |
| `emergency_stop` | Acil durus |
| `jog_forward` | Ileri jog |
| `jog_reverse` | Geri jog |
| `coast_stop` | Serbest durus |

**Yetki:** `TENANT_ADMIN`, `MODULE_MANAGER`

---

#### `startVfd` Mutation (Kisayol)

```graphql
mutation StartVfd($vfdDeviceId: ID!) {
  startVfd(vfdDeviceId: $vfdDeviceId) {
    success
    message
  }
}
```

**Yetki:** `TENANT_ADMIN`, `MODULE_MANAGER`

---

#### `stopVfd` Mutation (Kisayol)

```graphql
mutation StopVfd($vfdDeviceId: ID!) {
  stopVfd(vfdDeviceId: $vfdDeviceId) {
    success
    message
  }
}
```

**Yetki:** `TENANT_ADMIN`, `MODULE_MANAGER`

---

#### `setVfdFrequency` Mutation (Kisayol)

```graphql
mutation SetFreq($vfdDeviceId: ID!, $frequencyHz: Float!) {
  setVfdFrequency(vfdDeviceId: $vfdDeviceId, frequencyHz: $frequencyHz) {
    success
    message
  }
}
```

**Yetki:** `TENANT_ADMIN`, `MODULE_MANAGER`

---

#### `setVfdSpeed` Mutation (Kisayol)

```graphql
mutation SetSpeed($vfdDeviceId: ID!, $speedPercent: Float!) {
  setVfdSpeed(vfdDeviceId: $vfdDeviceId, speedPercent: $speedPercent) {
    success
    message
  }
}
```

**Yetki:** `TENANT_ADMIN`, `MODULE_MANAGER`

---

#### `emergencyStopVfd` Mutation

Acil durus -- **tum kimlik dogrulanmis kullanicilar** tarafindan cagrilabilir. Guvenlik nedeniyle rol kisitlamasi yoktur.

```graphql
mutation EmergencyStop($vfdDeviceId: ID!) {
  emergencyStopVfd(vfdDeviceId: $vfdDeviceId) {
    success
    message
  }
}
```

**Yetki:** Tum kimlik dogrulanmis kullanicilar (rol kisitlamasi yok)

---

#### `resetVfdFault` Mutation

```graphql
mutation ResetFault($vfdDeviceId: ID!) {
  resetVfdFault(vfdDeviceId: $vfdDeviceId) {
    success
    message
  }
}
```

**Yetki:** `TENANT_ADMIN`, `MODULE_MANAGER`

---

### 1.3 VFD Okuma API

#### `vfdReadings` Query

TimescaleDB'den gecmis okumalari getirir.

```graphql
query GetReadings(
  $vfdDeviceId: ID!
  $from: DateTime
  $to: DateTime
  $limit: Int
) {
  vfdReadings(
    vfdDeviceId: $vfdDeviceId
    from: $from
    to: $to
    limit: $limit
  ) {
    outputFrequency
    motorCurrent
    motorVoltage
    motorSpeed
    outputPower
    motorTorque
    dcBusVoltage
    heatsinkTemp
    motorThermal
    energyConsumption
    runningHours
    faultCode
    statusWord
    controlWord
    timestamp
  }
}
```

---

#### `vfdLatestReading` Query

Bir cihazin son okuma degerini dondurur.

```graphql
query LatestReading($vfdDeviceId: ID!) {
  vfdLatestReading(vfdDeviceId: $vfdDeviceId) {
    outputFrequency
    motorCurrent
    motorVoltage
    outputPower
    faultCode
    timestamp
  }
}
```

---

#### `vfdReadingStats` Query

Belirli bir donem veya tarih araligi icin istatistikler.

```graphql
query ReadingStats($vfdDeviceId: ID!, $period: String) {
  vfdReadingStats(vfdDeviceId: $vfdDeviceId, period: $period) {
    vfdDeviceId
    period
    avgFrequency
    avgCurrent
    avgPower
    maxFrequency
    maxCurrent
    maxPower
    totalEnergy
    runningTime
    faultCount
  }
}
```

**Period Degerleri:** `hour`, `day`, `week`, `month`, `custom`

---

#### `readVfdParameters` Mutation

Cihazdan canli parametre okuma yapar.

```graphql
mutation ReadParams($vfdDeviceId: ID!, $parameters: [String!]) {
  readVfdParameters(vfdDeviceId: $vfdDeviceId, parameters: $parameters) {
    success
    data
    error
    readAt
  }
}
```

---

#### `readVfdCriticalParameters` Mutation

Yalnizca kritik parametreleri okur (daha hizli).

```graphql
mutation ReadCritical($vfdDeviceId: ID!) {
  readVfdCriticalParameters(vfdDeviceId: $vfdDeviceId) {
    success
    data
    readAt
  }
}
```

---

### 1.4 VFD Programlama API (Maker-Checker Is Akisi)

#### `vfdParameterDefinitions` Query

Bir cihaz icin tum parametre tanimlarini getirir.

```graphql
query ParamDefs($vfdDeviceId: ID!, $group: String) {
  vfdParameterDefinitions(vfdDeviceId: $vfdDeviceId, group: $group) {
    parameterName
    displayName
    description
    group
    registerAddress
    dataType
    scalingFactor
    unit
    minValue
    maxValue
    defaultValue
    riskLevel
    requiresMotorStop
  }
}
```

**Grup Degerleri:** `ramp_times`, `frequency_limits`, `motor_nameplate`, `current_limits`, `vf_control`, `pid_controller`, `digital_io`, `communication`, `protection`, `jog`, `advanced`

---

#### `createVfdChangeSet` Mutation

Yeni bir degisiklik seti olusturur (DRAFT durumunda).

```graphql
mutation CreateChangeSet($input: CreateChangeSetInput!) {
  createVfdChangeSet(input: $input) {
    id
    status
    description
    items {
      parameterName
      currentValue
      newValue
      riskLevel
    }
    createdAt
    createdBy
  }
}
```

**Yetki:** `MODULE_MANAGER`, `TENANT_ADMIN` (Maker rolu)

---

#### `addVfdChangeSetItems` Mutation

DRAFT durumdaki bir degisiklik setine ogeler ekler.

```graphql
mutation AddItems($changeSetId: ID!, $items: [ChangeSetItemInput!]!) {
  addVfdChangeSetItems(changeSetId: $changeSetId, items: $items) {
    id
    status
    items {
      id
      parameterName
      newValue
      riskLevel
    }
  }
}
```

**Yetki:** `MODULE_MANAGER`, `TENANT_ADMIN`

---

#### `submitVfdChangeSetForApproval` Mutation

DRAFT degisiklik setini onay icin gonderir.

```graphql
mutation SubmitForApproval($changeSetId: ID!) {
  submitVfdChangeSetForApproval(changeSetId: $changeSetId) {
    id
    status
    submittedAt
  }
}
```

**Yetki:** `MODULE_MANAGER`, `TENANT_ADMIN`

---

#### `approveVfdChangeSet` Mutation

PENDING_APPROVAL degisiklik setini onaylar. 4-goz prensibi: olusturan kisi onaylayamaz.

```graphql
mutation Approve($changeSetId: ID!) {
  approveVfdChangeSet(changeSetId: $changeSetId) {
    id
    status
    approvedAt
    approvedBy
  }
}
```

**Yetki:** `TENANT_ADMIN` (yalnizca Checker rolu)

---

#### `rejectVfdChangeSet` Mutation

PENDING_APPROVAL degisiklik setini reddeder.

```graphql
mutation Reject($input: RejectChangeSetInput!) {
  rejectVfdChangeSet(input: $input) {
    id
    status
    rejectedAt
    rejectionReason
  }
}
```

**Yetki:** `TENANT_ADMIN` (yalnizca)

---

#### `rollbackVfdChangeSet` Mutation

APPLIED veya VERIFIED degisiklik setini geri alir. Ters bir degisiklik seti olusturur.

```graphql
mutation Rollback($input: RollbackChangeSetInput!) {
  rollbackVfdChangeSet(input: $input) {
    id
    status
    rolledBackAt
  }
}
```

**Yetki:** `MODULE_MANAGER`, `TENANT_ADMIN`

---

#### `vfdChangeSets` Query

Degisiklik setlerini listeler.

```graphql
query ChangeSets(
  $vfdDeviceId: ID!
  $status: VfdChangeSetStatus
  $limit: Int
  $offset: Int
) {
  vfdChangeSets(
    vfdDeviceId: $vfdDeviceId
    status: $status
    limit: $limit
    offset: $offset
  ) {
    id
    status
    description
    riskLevel
    items {
      parameterName
      currentValue
      newValue
      status
    }
    createdAt
    createdBy
    approvedAt
    approvedBy
  }
}
```

**VfdChangeSetStatus Enum Degerleri:**

| Deger | Aciklama |
|-------|----------|
| `draft` | Taslak -- duzenleme yapilabilir |
| `pending_approval` | Onay bekliyor |
| `approved` | Onaylandi -- uygulanmaya hazir |
| `applying` | Uygulanmakta |
| `applied` | Uygulanmis |
| `verified` | Dogrulandi (readback basarili) |
| `rejected` | Reddedildi |
| `failed` | Uygulama basarisiz |
| `rolled_back` | Geri alindi |

---

#### `vfdParameterAuditLog` Query

Parametre degisiklik denetim izi.

```graphql
query AuditLog(
  $vfdDeviceId: ID!
  $parameterName: String
  $limit: Int
) {
  vfdParameterAuditLog(
    vfdDeviceId: $vfdDeviceId
    parameterName: $parameterName
    limit: $limit
  ) {
    parameterName
    oldValue
    newValue
    action
    userId
    timestamp
    changeSetId
  }
}
```

---

#### `vfdPendingApprovalCount` Query

Tenant bazinda bekleyen onay sayisi.

```graphql
query PendingCount {
  vfdPendingApprovalCount
}
```

---

#### `vfdCurrentParameterValues` Query

Cihazdan canli parametre degerleri okur.

```graphql
query CurrentValues($vfdDeviceId: ID!, $parameterNames: [String!]!) {
  vfdCurrentParameterValues(
    vfdDeviceId: $vfdDeviceId
    parameterNames: $parameterNames
  )
}
```

**Yetki:** `MODULE_MANAGER`, `TENANT_ADMIN`

---

### 1.5 VFD Otomasyon API

#### `vfdAutomationRules` Query

Tenant icin tum otomasyon kurallarini listeler.

```graphql
query AutomationRules {
  vfdAutomationRules {
    id
    name
    description
    triggerCondition
    targetVfdDeviceIds
    parameterChanges
    requiresApproval
    priority
    isActive
    lastTriggeredAt
    triggerCount
  }
}
```

---

#### `createVfdAutomationRule` Mutation

Yeni bir otomasyon kurali olusturur.

```graphql
mutation CreateRule($input: CreateVfdAutomationRuleInput!) {
  createVfdAutomationRule(input: $input) {
    id
    name
    isActive
    triggerCondition
    parameterChanges
  }
}
```

**Input Parametreleri:**

| Parametre | Tip | Zorunlu | Varsayilan | Aciklama |
|-----------|-----|---------|------------|----------|
| name | String | Evet | -- | Kural adi |
| description | String | Hayir | -- | Aciklama |
| triggerCondition | JSON | Evet | -- | Tetikleme kosulu |
| targetVfdDeviceIds | [String] | Evet | -- | Hedef cihaz ID'leri |
| parameterChanges | JSON | Evet | -- | Parametre degisiklikleri |
| requiresApproval | Boolean | Hayir | true | Onay gerektirsin mi |
| priority | Int | Hayir | 100 | Oncelik (dusuk=yuksek) |

**Yetki:** `TENANT_ADMIN` (yalnizca)

---

#### `updateVfdAutomationRule` Mutation

```graphql
mutation UpdateRule($id: ID!, $input: UpdateVfdAutomationRuleInput!) {
  updateVfdAutomationRule(id: $id, input: $input) {
    id
    name
    isActive
  }
}
```

**Yetki:** `TENANT_ADMIN`

---

#### `toggleVfdAutomationRule` Mutation

Kurali aktif/pasif yapar.

```graphql
mutation ToggleRule($id: ID!, $isActive: Boolean!) {
  toggleVfdAutomationRule(id: $id, isActive: $isActive) {
    id
    isActive
  }
}
```

**Yetki:** `MODULE_MANAGER`, `TENANT_ADMIN`

---

#### `deleteVfdAutomationRule` Mutation

Kurali siler (soft-delete).

```graphql
mutation DeleteRule($id: ID!) {
  deleteVfdAutomationRule(id: $id)
}
```

**Yetki:** `TENANT_ADMIN`

---

### 1.6 Konfigurasyon Sorgulari

#### `vfdBrands` Query

Desteklenen tum VFD markalari.

```graphql
query Brands {
  vfdBrands
}
```

#### `vfdProtocols` Query

Desteklenen iletisim protokolleri.

```graphql
query Protocols {
  vfdProtocols
}
```

#### `vfdRegisterMappings` Query

Belirli bir marka ve model icin register haritasi.

```graphql
query Registers($brand: VfdBrand!, $modelSeries: String!) {
  vfdRegisterMappings(brand: $brand, modelSeries: $modelSeries) {
    parameterName
    displayName
    registerAddress
    dataType
    scalingFactor
    unit
    isCritical
    isBitField
    bitDefinitions
  }
}
```

#### `vfdBrandCommands` Query

Bir marka icin kontrol komutlarini dondurur.

```graphql
query BrandCommands($brand: VfdBrand!) {
  vfdBrandCommands(brand: $brand)
}
```

---

## 2. Marka Konfigurasyon Referansi

### 2.1 Danfoss FC Series

**Desteklenen Modeller:** FC102, FC302, FC51, VLT 2800, VLT 5000, VLT 6000, VLT HVAC

**Desteklenen Protokoller:** Modbus RTU, Modbus TCP, Profibus DP, Profinet, EtherNet/IP, CANopen, BACnet/IP

**Register Hesaplama Formulu:**
```
Register = (Parametre No x 10) - 1
Ornek: Parametre 16-13 (Output Frequency) = (1613 x 10) - 1 = 16129
```

**Seri Port Varsayilan Ayarlar:**

| Parametre | Deger |
|-----------|-------|
| Baud Rate | 9600 |
| Data Bits | 8 |
| Parity | None |
| Stop Bits | 1 |
| Timeout | 1000 ms |
| Retry | 3 |

#### Izleme Register Tablosu

| Parametre | Danfoss Param | Register | Veri Tipi | Olcek | Birim | Kritik | Poll (ms) |
|-----------|--------------|----------|-----------|-------|-------|--------|-----------|
| Status Word | 16-03 | 16029 | STATUS_WORD | -- | -- | Evet | 200 |
| Output Frequency | 16-13 | 16129 | UINT16 | x0.1 | Hz | Evet | 500 |
| Motor Current | 16-14 | 16139 | UINT32 (2 reg) | x0.01 | A | Evet | 500 |
| Motor Voltage | 16-12 | 16119 | UINT16 | x0.1 | V | Hayir | 1000 |
| Motor Speed | 16-17 | 16169 | INT32 (2 reg) | x1 | RPM | Evet | 500 |
| Motor Torque | 16-16 | 16159 | INT16 | x0.1 | % | Hayir | 500 |
| Output Power | 16-10 | 16099 | INT32 (2 reg) | x0.1 | kW | Evet | 1000 |
| DC Bus Voltage | 16-30 | 16299 | UINT16 | x0.1 | V | Hayir | 1000 |
| Power Factor | 16-11 | 16109 | INT16 | x0.01 | -- | Hayir | 2000 |
| Speed Reference | 16-02 | 16019 | INT16 | x0.1 | Hz | Hayir | 500 |
| Heatsink Temp | 16-34 | 16339 | INT16 | x0.1 | C | Evet | 5000 |
| Control Card Temp | 16-35 | 16349 | INT16 | x0.1 | C | Hayir | 5000 |
| Motor Thermal | 16-33 | 16329 | UINT16 | x1 | % | Hayir | 5000 |
| Running Hours | 15-00 | 14999 | UINT32 (2 reg) | x1 | h | Hayir | 60000 |
| Power On Hours | 15-01 | 15009 | UINT32 (2 reg) | x1 | h | Hayir | 60000 |
| Energy Consumption | 15-02 | 15019 | UINT32 (2 reg) | x1 | kWh | Hayir | 60000 |
| Start Count | 15-03 | 15029 | UINT32 (2 reg) | x1 | -- | Hayir | 60000 |
| Alarm Word | 16-90 | 16899 | UINT16 | -- | -- | Evet | 500 |
| Warning Word | 16-92 | 16919 | UINT16 | -- | -- | Evet | 500 |
| Fault Code | 15-94 | 15939 | UINT16 | -- | -- | Evet | 500 |

#### Konfigurasyon Register Tablosu

| Parametre | Danfoss Param | Register | Veri Tipi | Olcek | Birim | Min | Max | Varsayilan | Risk | Motor Durmali |
|-----------|--------------|----------|-----------|-------|-------|-----|-----|------------|------|---------------|
| Acceleration Time 1 | 3-41 | 3409 | UINT16 | x0.01 | s | 0.05 | 3600 | 10 | MEDIUM | Hayir |
| Deceleration Time 1 | 3-42 | 3419 | UINT16 | x0.01 | s | 0.05 | 3600 | 10 | MEDIUM | Hayir |
| Min Frequency | 4-11 | 4109 | UINT16 | x0.1 | Hz | 0 | 400 | 0 | MEDIUM | Hayir |
| Max Frequency | 4-13 | 4129 | UINT16 | x0.1 | Hz | 0.1 | 400 | 50 | HIGH | Hayir |
| Motor Nom. Power | 1-20 | 1199 | UINT16 | x0.01 | kW | 0.01 | 1000 | -- | HIGH | Evet |
| Motor Nom. Voltage | 1-22 | 1219 | UINT16 | x0.1 | V | 50 | 1000 | 400 | HIGH | Evet |
| Motor Nom. Current | 1-24 | 1239 | UINT16 | x0.01 | A | 0.01 | 10000 | -- | HIGH | Evet |
| Motor Nom. Speed | 1-25 | 1249 | UINT16 | x1 | RPM | 100 | 60000 | -- | HIGH | Evet |
| Current Limit % | 4-16 | 4159 | UINT16 | x0.1 | % | 0 | 400 | 160 | MEDIUM | Hayir |
| PID P Gain | 7-03 | 7029 | UINT16 | x0.01 | -- | 0 | 10 | 1 | MEDIUM | Hayir |
| PID I Time | 7-04 | 7039 | UINT16 | x0.01 | s | 0.01 | 9999 | 10 | MEDIUM | Hayir |
| Jog Frequency | 3-19 | 3189 | UINT16 | x0.1 | Hz | 0 | 400 | 5 | LOW | Hayir |
| Thermal Protection | 1-90 | 1899 | UINT16 | x1 | -- | 0 | 4 | 2 | CRITICAL | Hayir |
| Modbus Address | 8-31 | 8309 | UINT16 | x1 | -- | 1 | 247 | 1 | LOW | Hayir |

#### Control Word Bit Tanimlari (Register 49999 / 50-00)

| Bit | Isim | Aciklama |
|-----|------|----------|
| 0 | Reference Select 0 | Referans secimi bit 0 |
| 1 | Reference Select 1 | Referans secimi bit 1 |
| 2 | DC Brake | DC fren komutu |
| 3 | Coasting | Serbest durus |
| 4 | Quick Stop | Hizli durus komutu |
| 5 | Freeze Frequency | Cikis frekansini dondur |
| 6 | Ramp Stop | Rampa ile durus |
| 7 | Reset | Ariza sifirlama |
| 8 | Jog | Jog modu |
| 9 | Ramp | Rampa secimi |
| 10 | Data Valid | Veri gecerli |
| 11 | Relay | Role cikis kontrolu |
| 15 | Reverse | Ters yon |

#### Kontrol Komut Degerleri

| Komut | Hex Degeri | Aciklama |
|-------|-----------|----------|
| START | 0x047F | Rampa ile calistir |
| STOP | 0x043C | Rampa ile durdur |
| COAST | 0x0437 | Serbest durus |
| QUICK_STOP | 0x042F | Hizli durus |
| RESET | 0x04FF | Ariza sifirlama |
| JOG | 0x057F | Jog modu |

#### Status Word Bit Tanimlari (Register 16029 / 16-03)

| Bit | Isim | Aciklama |
|-----|------|----------|
| 0 | Control Ready | Surucu kontrole hazir |
| 1 | Drive Ready | Surucu calismaya hazir |
| 2 | Coasting | Serbest durus aktif |
| 3 | Trip | Surucu ariza ile durdu |
| 4 | Trip Lock | Ariza kilidi aktif |
| 7 | Warning | Uyari aktif |
| 8 | At Reference | Hiz referansta |
| 9 | Auto Mode | Otomatik mod |
| 10 | Out of Freq Range | Cikis frekansi aralik disinda |
| 11 | Running | Motor calisiyor |
| 12 | Voltage Warning | DC bara gerilim uyarisi |
| 13 | Current Limit | Akim siniri aktif |
| 14 | Thermal Warning | Termal uyari |

#### FC Protocol Aktivasyon Adimlari

1. Parametre 8-01'i `FC Protocol` olarak ayarlayin
2. Parametre 8-30'u `MODBUS` olarak ayarlayin
3. Parametre 8-31'de slave adresini belirleyin (1-247)
4. Parametre 8-32'de baud rate'i secin (9600 varsayilan)
5. Surucuyu yeniden baslatin

---

### 2.2 ABB ACS Series

**Desteklenen Modeller:** ACS580, ACS880, ACS355, ACS310, ACS550, ACS800, ACS1000

**Desteklenen Protokoller:** Modbus RTU, Modbus TCP, Profibus DP, Profinet, EtherNet/IP, CANopen, BACnet/IP

**Register Hesaplama Formulu:**
```
16-bit Register: Register = 40000 + (100 x Grup) + Index
32-bit Register: Register = 420000 + (200 x Grup) + (2 x Index)
```

**Seri Port Varsayilan Ayarlar:**

| Parametre | Deger |
|-----------|-------|
| Baud Rate | 9600 |
| Data Bits | 8 |
| Parity | None |
| Stop Bits | 1 |
| Timeout | 1000 ms |
| Retry | 3 |

#### Izleme Register Tablosu

| Parametre | ABB Param | Register | Veri Tipi | Olcek | Birim | Kritik | Poll (ms) |
|-----------|----------|----------|-----------|-------|-------|--------|-----------|
| Status Word (ZSW) | -- | 400051 | STATUS_WORD | -- | -- | Evet | 200 |
| Actual Speed | -- | 400052 | INT16 | x0.005 | % | Evet | 500 |
| Output Frequency | 01.06 | 40106 | INT16 | x0.01 | Hz | Evet | 500 |
| Motor Current | 01.07 | 40107 | INT16 | x0.01 | A | Evet | 500 |
| Motor Torque | 01.10 | 40110 | INT16 | x0.01 | % | Hayir | 500 |
| DC Bus Voltage | 01.11 | 40111 | UINT16 | x0.01 | V | Hayir | 1000 |
| Motor Voltage | 01.13 | 40113 | UINT16 | x1 | V | Hayir | 1000 |
| Output Power | 01.14 | 40114 | INT16 | x0.01 | kW | Evet | 1000 |
| Motor Speed | 01.02 | 40102 | INT16 | x1 | RPM | Evet | 500 |
| Drive Temp | 05.11 | 40511 | INT16 | x1 | % | Evet | 5000 |
| Motor Thermal | 09.01 | 40901 | INT16 | x1 | % | Hayir | 5000 |
| Energy Consumption | 01.20 | 40120 | UINT32 (2 reg) | x0.1 | kWh | Hayir | 60000 |
| Running Hours | 05.03 | 40503 | UINT32 (2 reg) | x1 | h | Hayir | 60000 |
| Power On Hours | 05.01 | 40501 | UINT32 (2 reg) | x1 | h | Hayir | 60000 |
| Fault Code | 04.11 | 40411 | UINT16 | -- | -- | Evet | 500 |
| Warning Word | 04.21 | 40421 | UINT16 | -- | -- | Evet | 500 |

#### Konfigurasyon Register Tablosu

| Parametre | ABB Param | Register | Veri Tipi | Olcek | Birim | Min | Max | Varsayilan | Risk | Motor Durmali |
|-----------|----------|----------|-----------|-------|-------|-----|-----|------------|------|---------------|
| Accel Time 1 | 22.01 | 42201 | UINT16 | x0.1 | s | 0 | 1800 | 5 | MEDIUM | Hayir |
| Decel Time 1 | 22.02 | 42202 | UINT16 | x0.1 | s | 0 | 1800 | 5 | MEDIUM | Hayir |
| Min Frequency | 20.01 | 42001 | UINT16 | x0.1 | Hz | 0 | 500 | 0 | MEDIUM | Hayir |
| Max Frequency | 20.02 | 42002 | UINT16 | x0.1 | Hz | 0.1 | 500 | 50 | HIGH | Hayir |
| Motor Nom. Power | 99.04 | 49904 | UINT16 | x0.01 | kW | 0.12 | 2000 | -- | HIGH | Evet |
| Motor Nom. Voltage | 99.05 | 49905 | UINT16 | x1 | V | 100 | 1000 | 400 | HIGH | Evet |
| Motor Nom. Current | 99.06 | 49906 | UINT16 | x0.1 | A | 0.1 | 5000 | -- | HIGH | Evet |
| Motor Nom. Speed | 99.07 | 49907 | UINT16 | x1 | RPM | 100 | 30000 | -- | HIGH | Evet |
| Current Limit | 20.07 | 42007 | UINT16 | x0.1 | % | 0 | 300 | 150 | MEDIUM | Hayir |
| PID Gain | 40.01 | 44001 | UINT16 | x0.01 | -- | 0 | 1000 | 100 | MEDIUM | Hayir |
| PID Integration Time | 40.02 | 44002 | UINT16 | x0.1 | s | 0 | 3200 | 10 | MEDIUM | Hayir |
| Jog Frequency | 21.10 | 42110 | UINT16 | x0.1 | Hz | 0 | 500 | 5 | LOW | Hayir |
| Motor Thermal Protection | 30.01 | 43001 | UINT16 | x1 | -- | 0 | 3 | 1 | CRITICAL | Hayir |
| Modbus Address | 53.01 | 45301 | UINT16 | x1 | -- | 1 | 247 | 1 | LOW | Hayir |

#### Control Word Bit Tanimlari (Register 400001)

| Bit | Isim | Aciklama |
|-----|------|----------|
| 0 | Switch On | Acma komutu |
| 1 | Enable Voltage | Gerilim aktif et |
| 2 | Quick Stop | Hizli durus (ters mantik) |
| 3 | Enable Operation | Calismayi aktif et |
| 4 | Ramp Out Zero | Rampa cikisi sifirla |
| 5 | Ramp Hold | Rampa tut |
| 6 | Ramp In Zero | Rampa girisi sifirla |
| 7 | Reset | Ariza sifirlama |
| 10 | Control Bit 0 | Kontrol bit 0 |
| 11 | Direction | Yon (0=Ileri, 1=Geri) |

#### Kontrol Komut Degerleri

| Komut | Hex Degeri | Aciklama |
|-------|-----------|----------|
| SHUTDOWN | 0x0006 | Kapatma |
| SWITCH_ON | 0x0007 | Acma |
| ENABLE_OPERATION | 0x000F | Calismayi aktif et |
| RUN_FORWARD | 0x000F | Ileri calistir |
| RUN_REVERSE | 0x080F | Geri calistir |
| QUICK_STOP | 0x0002 | Hizli durus |
| DISABLE_VOLTAGE | 0x0000 | Gerilim kapat |
| FAULT_RESET | 0x0080 | Ariza sifirlama |

#### Status Word Bit Tanimlari (Register 400051)

| Bit | Isim | Aciklama |
|-----|------|----------|
| 0 | Ready to Switch On | Acilmaya hazir |
| 1 | Switched On | Ana kontak kapali |
| 2 | Operation Enabled | Calisma aktif |
| 3 | Fault | Ariza aktif |
| 4 | Voltage Enabled | DC bara gerilimi aktif |
| 5 | Quick Stop | Hizli durus aktif degil |
| 6 | Switch On Disabled | Acma engellendi |
| 7 | Warning | Uyari aktif |
| 8 | At Setpoint | Hiz referansta |
| 9 | Remote | Uzaktan kontrol aktif |
| 10 | Target Reached | Hedef hiza ulasildi |
| 11 | Internal Limit | Dahili sinir aktif |

---

### 2.3 Siemens SINAMICS G120

**Desteklenen Modeller:** G120, G120C, G120D, G120P, G130, S120, MICROMASTER 440

**Desteklenen Protokoller:** Modbus RTU, Modbus TCP, Profibus DP, Profinet, CANopen, BACnet/IP

**Parametre Yapisi:**
```
P0xxx: Okuma/Yazma parametreleri
r0xxx: Yalniz okuma parametreleri
Register = Parametre numarasi (dogrudan esleme)
```

**Seri Port Varsayilan Ayarlar:**

| Parametre | Deger |
|-----------|-------|
| Baud Rate | 9600 |
| Data Bits | 8 |
| Parity | **Even** |
| Stop Bits | 1 |
| Timeout | 1000 ms |
| Retry | 3 |

#### Izleme Register Tablosu

| Parametre | Siemens Param | Register | Veri Tipi | Olcek | Birim | Kritik | Poll (ms) |
|-----------|--------------|----------|-----------|-------|-------|--------|-----------|
| Status Word 1 (ZSW1) | r0052 | 52 | STATUS_WORD | -- | -- | Evet | 200 |
| Status Word 2 (ZSW2) | r0053 | 53 | STATUS_WORD | -- | -- | Hayir | 500 |
| Output Frequency | r0024 | 24 | UINT16 | x0.01 | Hz | Evet | 500 |
| Motor Speed | r0021 | 21 | INT16 | x1 | RPM | Evet | 500 |
| Motor Current | r0027 | 27 | UINT16 | x0.01 | A | Evet | 500 |
| Motor Torque | r0026 | 26 | INT16 | x0.1 | % | Hayir | 500 |
| Motor Voltage | r0025 | 25 | UINT16 | x0.1 | V | Hayir | 1000 |
| Output Power | r0032 | 32 | INT16 | x0.1 | kW | Evet | 1000 |
| Power Factor | r0033 | 33 | INT16 | x0.001 | -- | Hayir | 2000 |
| Speed Setpoint | r0022 | 22 | INT16 | x1 | RPM | Hayir | 500 |
| Drive Temp | r0035 | 35 | INT16 | x0.1 | C | Evet | 5000 |
| Motor Thermal Load | r0034 | 34 | UINT16 | x0.1 | % | Hayir | 5000 |
| Motor Temp | r0036 | 36 | INT16 | x0.1 | C | Hayir | 5000 |
| Energy Consumption | r0039 | 39 | UINT32 (2 reg) | x0.1 | kWh | Hayir | 60000 |
| Running Hours | r0080 | 80 | UINT32 (2 reg) | x1 | h | Hayir | 60000 |
| Power On Hours | r0078 | 78 | UINT32 (2 reg) | x1 | h | Hayir | 60000 |
| Fault Code | r0947 | 947 | UINT16 | -- | -- | Evet | 500 |
| Warning Code | r0952 | 952 | UINT16 | -- | -- | Evet | 500 |
| Last Fault Code | r0948 | 948 | UINT16 | -- | -- | Hayir | 5000 |

#### Konfigurasyon Register Tablosu

| Parametre | Siemens Param | Register | Veri Tipi | Olcek | Birim | Min | Max | Varsayilan | Risk | Motor Durmali |
|-----------|--------------|----------|-----------|-------|-------|-----|-----|------------|------|---------------|
| Accel Time | P1120 | 1120 | UINT16 | x0.01 | s | 0 | 6500 | 10 | MEDIUM | Hayir |
| Decel Time | P1121 | 1121 | UINT16 | x0.01 | s | 0 | 6500 | 10 | MEDIUM | Hayir |
| Min Frequency | P1080 | 1080 | UINT16 | x0.01 | Hz | 0 | 650 | 0 | MEDIUM | Hayir |
| Max Frequency | P1082 | 1082 | UINT16 | x0.01 | Hz | 0.01 | 650 | 50 | HIGH | Hayir |
| Motor Rated Voltage | P0304 | 304 | UINT16 | x0.1 | V | 10 | 2000 | 400 | HIGH | Evet |
| Motor Rated Current | P0305 | 305 | UINT16 | x0.01 | A | 0.01 | 10000 | -- | HIGH | Evet |
| Motor Rated Power | P0307 | 307 | UINT16 | x0.01 | kW | 0.01 | 2000 | -- | HIGH | Evet |
| Motor Rated Speed | P0311 | 311 | UINT16 | x1 | RPM | 1 | 40000 | -- | HIGH | Evet |
| Current Limit | P0640 | 640 | UINT16 | x0.1 | % | 10 | 400 | 150 | MEDIUM | Hayir |
| JOG Setpoint | P1058 | 1058 | UINT16 | x0.01 | Hz | 0 | 650 | 5 | LOW | Hayir |
| Motor OL Protection | P0610 | 610 | UINT16 | x1 | -- | 0 | 3 | 1 | CRITICAL | Hayir |
| Modbus Address | P2011 | 2011 | UINT16 | x1 | -- | 0 | 247 | 1 | LOW | Hayir |

#### Kontrol Komut Degerleri (PROFIdrive)

| Komut | Hex Degeri | Aciklama |
|-------|-----------|----------|
| OFF1 | 0x047E | Rampa ile durus |
| OFF2 | 0x047D | Serbest durus |
| OFF3 | 0x047B | Hizli durus |
| READY | 0x047E | Hazir durumu |
| RUN_FORWARD | 0x047F | Ileri calistir |
| RUN_REVERSE | 0x0C7F | Geri calistir |
| ACKNOWLEDGE | 0x04FE | Ariza onayla |
| JOG_FORWARD | 0x057F | Ileri jog |
| JOG_REVERSE | 0x0D7F | Geri jog |

---

### 2.4 Schneider Altivar

**Desteklenen Modeller:** Altivar 12, Altivar 312, Altivar 320, Altivar 340, Altivar 600, Altivar 900, Altivar Process

**Desteklenen Protokoller:** Modbus RTU, Modbus TCP, Profibus DP, Profinet, EtherNet/IP, CANopen, BACnet/IP

**Seri Port Varsayilan Ayarlar:**

| Parametre | Deger |
|-----------|-------|
| Baud Rate | **19200** |
| Data Bits | 8 |
| Parity | **Even** |
| Stop Bits | 1 |
| Timeout | 1000 ms |
| Retry | 3 |

#### Izleme Register Tablosu

| Parametre | Schneider Kodu | Register | Veri Tipi | Olcek | Birim | Kritik | Poll (ms) |
|-----------|---------------|----------|-----------|-------|-------|--------|-----------|
| Status Word (ETA) | ETA | 3201 | STATUS_WORD | -- | -- | Evet | 200 |
| Drive State (HMIS) | HMIS | 3202 | UINT16 | -- | -- | Evet | 200 |
| Output Frequency | RFR | 8602 | INT16 | x0.1 | Hz | Evet | 500 |
| Motor Speed | SPD | 8604 | INT16 | x1 | RPM | Evet | 500 |
| Motor Current | LCR | 3204 | UINT16 | x0.1 | A | Evet | 500 |
| Motor Voltage | UOP | 3208 | UINT16 | x0.1 | V | Hayir | 1000 |
| Motor Torque | OTR | 3205 | INT16 | x0.1 | % | Hayir | 500 |
| DC Bus Voltage | UDC | 3209 | UINT16 | x1 | V | Hayir | 1000 |
| Output Power | OPR | 3206 | INT16 | x0.1 | kW | Evet | 1000 |
| Mains Voltage | ULN | 3210 | UINT16 | x1 | V | Hayir | 2000 |
| Frequency Reference | FRH | 8603 | INT16 | x0.1 | Hz | Hayir | 500 |
| Drive Thermal | THD | 3207 | UINT16 | x1 | % | Evet | 5000 |
| Motor Thermal | THR | 3211 | UINT16 | x1 | % | Hayir | 5000 |
| DB Resistor Thermal | THBD | 3212 | UINT16 | x1 | % | Hayir | 5000 |
| Energy Consumption | -- | 7133 | UINT32 (2 reg) | x0.1 | kWh | Hayir | 60000 |
| Running Hours | RTH | 7135 | UINT32 (2 reg) | x0.1 | h | Hayir | 60000 |
| Power On Hours | PTH | 7137 | UINT32 (2 reg) | x0.1 | h | Hayir | 60000 |
| Start Count | -- | 7139 | UINT32 (2 reg) | x1 | -- | Hayir | 60000 |
| Last Fault | LFT | 7121 | UINT16 | -- | -- | Evet | 500 |
| Current Fault | CFP | 7125 | UINT16 | -- | -- | Evet | 500 |
| Alarm Group 1 | ALG1 | 7130 | UINT16 | -- | -- | Evet | 500 |

#### Konfigurasyon Register Tablosu

| Parametre | Schneider Kodu | Register | Olcek | Birim | Min | Max | Varsayilan | Risk | Motor Durmali |
|-----------|---------------|----------|-------|-------|-----|-----|------------|------|---------------|
| Accel Time | ACC | 9001 | x0.1 | s | 0.1 | 6000 | 3 | MEDIUM | Hayir |
| Decel Time | dEC | 9002 | x0.1 | s | 0.1 | 6000 | 3 | MEDIUM | Hayir |
| Low Speed (Min Freq) | LSP | 9003 | x0.1 | Hz | 0 | 500 | 0 | MEDIUM | Hayir |
| High Speed (Max Freq) | HSP | 9004 | x0.1 | Hz | 0.1 | 500 | 50 | HIGH | Hayir |
| Motor Nom. Voltage | UnS | 9201 | x1 | V | 100 | 1000 | 400 | HIGH | Evet |
| Motor Nom. Current | nCr | 9202 | x0.1 | A | 0.1 | 5000 | -- | HIGH | Evet |
| Motor Nom. Frequency | FrS | 9203 | x0.1 | Hz | 10 | 500 | 50 | HIGH | Evet |
| Motor Nom. Speed | nSP | 9204 | x1 | RPM | 100 | 30000 | -- | HIGH | Evet |
| Current Limit | CLI | 9207 | x0.1 | A | 0.1 | 5000 | -- | MEDIUM | Hayir |
| JOG Frequency | JGF | 9006 | x0.1 | Hz | 0 | 500 | 10 | LOW | Hayir |
| Motor Thermal Protection | tHP | 9301 | x1 | -- | 0 | 2 | 1 | CRITICAL | Hayir |
| Modbus Address | Add | 8601 | x1 | -- | 1 | 247 | 1 | LOW | Hayir |

#### Kontrol Komut Degerleri (CiA402)

| Komut | Hex Degeri | Aciklama |
|-------|-----------|----------|
| SHUTDOWN | 0x0006 | Acilmaya hazir |
| SWITCH_ON | 0x0007 | Acildi |
| ENABLE_OPERATION | 0x000F | Calisma aktif |
| DISABLE_VOLTAGE | 0x0000 | Gerilim kapat |
| QUICK_STOP | 0x0002 | Hizli durus |
| FAULT_RESET | 0x0080 | Ariza sifirlama |
| RUN_FORWARD | 0x000F | Ileri calistir |
| RUN_REVERSE | 0x080F | Geri calistir |

---

### 2.5 Yaskawa

**Desteklenen Modeller:** A1000, V1000, J1000, GA500, GA700, U1000, Z1000

**Desteklenen Protokoller:** Modbus RTU, Modbus TCP, Profibus DP, Profinet, EtherNet/IP, CANopen

**Register Yapisi:**
```
Monitor parametreleri: 0x2100+ (U1-xx serisi)
Konfigurasyon: MEMOBUS parametreleri
```

**Seri Port Varsayilan Ayarlar:**

| Parametre | Deger |
|-----------|-------|
| Baud Rate | 9600 |
| Data Bits | 8 |
| Parity | None |
| Stop Bits | **2** |
| Timeout | 1000 ms |
| Retry | 3 |

#### Izleme Register Tablosu

| Parametre | Yaskawa Param | Register (Hex) | Register (Dec) | Veri Tipi | Olcek | Birim | Kritik | Poll (ms) |
|-----------|--------------|----------------|----------------|-----------|-------|-------|--------|-----------|
| Status Word | -- | 0x2100 | 8448 | STATUS_WORD | -- | -- | Evet | 200 |
| Frequency Reference | U1-01 | 0x2101 | 8449 | INT16 | x0.01 | Hz | Hayir | 500 |
| Output Frequency | U1-02 | 0x2102 | 8450 | UINT16 | x0.01 | Hz | Evet | 500 |
| Motor Current | U1-03 | 0x2103 | 8451 | UINT16 | x0.01 | A | Evet | 500 |
| Output Voltage | U1-04 | 0x2104 | 8452 | UINT16 | x0.1 | V | Hayir | 1000 |
| Motor Speed | U1-05 | 0x2105 | 8453 | INT16 | x1 | RPM | Evet | 500 |
| DC Bus Voltage | U1-07 | 0x2107 | 8455 | UINT16 | x0.1 | V | Hayir | 1000 |
| Output Power | U1-08 | 0x2108 | 8456 | INT16 | x0.1 | kW | Evet | 1000 |
| Motor Torque | U1-09 | 0x2109 | 8457 | INT16 | x0.1 | % | Hayir | 500 |
| Torque Reference | U1-10 | 0x210A | 8458 | INT16 | x0.1 | % | Hayir | 500 |
| IGBT Temp | U1-21 | 0x2115 | 8469 | INT16 | x0.1 | C | Evet | 5000 |
| Motor Thermal Load | U1-22 | 0x2116 | 8470 | UINT16 | x0.1 | % | Hayir | 5000 |
| Drive Thermal Load | U1-23 | 0x2117 | 8471 | UINT16 | x0.1 | % | Hayir | 5000 |
| kWh Counter | U4-01/02 | 0x2401 | 9217 | UINT32 (2 reg) | x0.1 | kWh | Hayir | 60000 |
| Running Hours | U4-03/04 | 0x2403 | 9219 | UINT32 (2 reg) | x0.1 | h | Hayir | 60000 |
| Power On Hours | U4-05/06 | 0x2405 | 9221 | UINT32 (2 reg) | x0.1 | h | Hayir | 60000 |
| Start Count | U4-07/08 | 0x2407 | 9223 | UINT32 (2 reg) | x1 | -- | Hayir | 60000 |
| Fault Code | U2-01 | 0x2201 | 8705 | UINT16 | -- | -- | Evet | 500 |
| Fault Trace 1 | U2-02 | 0x2202 | 8706 | UINT16 | -- | -- | Hayir | 5000 |
| Minor Alarm | U2-10 | 0x220A | 8714 | UINT16 | -- | -- | Evet | 500 |

#### Konfigurasyon Register Tablosu

| Parametre | Yaskawa Param | Register (Hex) | Olcek | Birim | Min | Max | Varsayilan | Risk | Motor Durmali |
|-----------|--------------|----------------|-------|-------|-----|-----|------------|------|---------------|
| Accel Time 1 | C1-01 | 0x0108 | x0.1 | s | 0 | 6000 | 10 | MEDIUM | Hayir |
| Decel Time 1 | C1-02 | 0x0109 | x0.1 | s | 0 | 6000 | 10 | MEDIUM | Hayir |
| Min Frequency | d1-01 | 0x0110 | x0.01 | Hz | 0 | 400 | 0 | MEDIUM | Hayir |
| Max Frequency | d1-02 | 0x0111 | x0.01 | Hz | 0.01 | 400 | 50 | HIGH | Hayir |
| Motor Rated Power | E1-06 | 0x0145 | x0.01 | kW | 0.01 | 2000 | -- | HIGH | Evet |
| Motor Rated Voltage | E1-05 | 0x0144 | x0.1 | V | 100 | 1000 | 400 | HIGH | Evet |
| Motor Rated Current | E1-04 | 0x0143 | x0.01 | A | 0.01 | 5000 | -- | HIGH | Evet |
| Motor Rated Speed | E1-09 | 0x0148 | x1 | RPM | 1 | 30000 | -- | HIGH | Evet |
| Current Limit | L1-01 | 0x0200 | x0.1 | % | 0 | 200 | 150 | MEDIUM | Hayir |
| JOG Frequency | d1-17 | 0x011F | x0.01 | Hz | 0 | 400 | 6 | LOW | Hayir |
| Motor OL Protection | L1-02 | 0x0201 | x1 | -- | 0 | 5 | 1 | CRITICAL | Hayir |
| MEMOBUS Address | H5-01 | 0x0300 | x1 | -- | 1 | 247 | 1 | LOW | Hayir |

#### Kontrol Komut Degerleri

| Komut | Hex Degeri | Aciklama |
|-------|-----------|----------|
| STOP | 0x0000 | Durdur |
| RUN_FORWARD | 0x0001 | Ileri calistir |
| RUN_REVERSE | 0x0003 | Geri calistir |
| FAULT_RESET | 0x0008 | Ariza sifirlama |
| JOG_FORWARD | 0x0101 | Ileri jog |
| JOG_REVERSE | 0x0103 | Geri jog |
| BASE_BLOCK | 0x0800 | Base block |
| DC_BRAKING | 0x0401 | DC frenleme |

---

### 2.6 Delta VFD

**Desteklenen Modeller:** VFD-E, VFD-EL, VFD-C, VFD-CP, VFD-M, VFD-MS300, VFD-C2000

**Desteklenen Protokoller:** Modbus RTU, Modbus TCP, CANopen

**Register Yapisi:**
```
Parametre grubu x 256 + parametre numarasi
Ornek: Pr.01-00 = 0x0100, Pr.02-01 = 0x0201
```

**Seri Port Varsayilan Ayarlar:**

| Parametre | Deger |
|-----------|-------|
| Baud Rate | 9600 |
| Data Bits | 8 |
| Parity | None |
| Stop Bits | 1 |
| Timeout | 500 ms |
| Retry | 3 |

#### Izleme Register Tablosu

| Parametre | Register (Hex) | Register (Dec) | Veri Tipi | Olcek | Birim | Kritik | Poll (ms) |
|-----------|----------------|----------------|-----------|-------|-------|--------|-----------|
| Status Word | 0x2100 | 8448 | STATUS_WORD | -- | -- | Evet | 200 |
| Frequency Command | 0x2101 | 8449 | UINT16 | x0.01 | Hz | Hayir | 500 |
| Fault Code | 0x2102 | 8450 | UINT16 | -- | -- | Evet | 500 |
| Output Frequency | 0x2103 | 8451 | UINT16 | x0.01 | Hz | Evet | 500 |
| Motor Current | 0x2104 | 8452 | UINT16 | x0.01 | A | Evet | 500 |
| DC Bus Voltage | 0x2105 | 8453 | UINT16 | x0.1 | V | Hayir | 1000 |
| Output Voltage | 0x2106 | 8454 | UINT16 | x0.1 | V | Hayir | 1000 |
| Power Factor | 0x2107 | 8455 | INT16 | x0.001 | -- | Hayir | 2000 |
| IGBT Temp | 0x2108 | 8456 | INT16 | x0.1 | C | Evet | 5000 |
| Motor Thermal | 0x2109 | 8457 | UINT16 | x0.1 | % | Hayir | 5000 |
| Drive Thermal | 0x210A | 8458 | UINT16 | x0.1 | % | Hayir | 5000 |
| Warning Code | 0x210B | 8459 | UINT16 | -- | -- | Evet | 500 |
| Motor Speed | 0x210C | 8460 | INT16 | x1 | RPM | Evet | 500 |
| Output Power | 0x210D | 8461 | INT16 | x0.1 | kW | Evet | 1000 |
| Motor Torque | 0x210E | 8462 | INT16 | x0.1 | % | Hayir | 500 |
| Power On Hours | 0x2116 | 8470 | UINT32 (2 reg) | x0.1 | h | Hayir | 60000 |
| Running Hours | 0x2118 | 8472 | UINT32 (2 reg) | x0.1 | h | Hayir | 60000 |
| kWh Counter Low | 0x211A | 8474 | UINT16 | x1 | kWh | Hayir | 60000 |
| kWh Counter High | 0x211B | 8475 | UINT16 | x65536 | kWh | Hayir | 60000 |

#### Konfigurasyon Register Tablosu

| Parametre | Delta Param | Register (Hex) | Olcek | Birim | Min | Max | Varsayilan | Risk | Motor Durmali |
|-----------|------------|----------------|-------|-------|-----|-----|------------|------|---------------|
| Max Frequency | Pr.01-00 | 0x0100 | x0.01 | Hz | 0.01 | 600 | 60 | HIGH | Hayir |
| JOG Frequency | Pr.01-03 | 0x0103 | x0.01 | Hz | 0 | 600 | 6 | LOW | Hayir |
| Min Frequency | Pr.01-07 | 0x0107 | x0.01 | Hz | 0 | 600 | 0 | MEDIUM | Hayir |
| Accel Time 1 | Pr.01-09 | 0x0109 | x0.1 | s | 0.1 | 6000 | 10 | MEDIUM | Hayir |
| Decel Time 1 | Pr.01-10 | 0x010A | x0.1 | s | 0.1 | 6000 | 10 | MEDIUM | Hayir |
| Thermal OL Relay | Pr.06-01 | 0x0601 | x1 | % | 30 | 110 | 100 | CRITICAL | Hayir |
| OC Stall Prevention | Pr.06-03 | 0x0603 | x1 | % | 20 | 200 | 150 | MEDIUM | Hayir |
| Motor Rated Power | Pr.07-01 | 0x0701 | x0.01 | kW | 0.01 | 1000 | -- | HIGH | Evet |
| Motor Rated Voltage | Pr.07-02 | 0x0702 | x0.1 | V | 100 | 1000 | 400 | HIGH | Evet |
| Motor Rated Current | Pr.07-03 | 0x0703 | x0.01 | A | 0.01 | 5000 | -- | HIGH | Evet |
| Motor Rated Speed | Pr.07-04 | 0x0704 | x1 | RPM | 1 | 30000 | -- | HIGH | Evet |
| Comm Address | Pr.09-00 | 0x0900 | x1 | -- | 1 | 254 | 1 | LOW | Hayir |

#### Kontrol Komut Degerleri

| Komut | Hex Degeri | Aciklama |
|-------|-----------|----------|
| STOP | 0x0000 | Durdur |
| RUN_FORWARD | 0x0001 | Ileri calistir |
| RUN_REVERSE | 0x0003 | Geri calistir |
| JOG_FORWARD | 0x0005 | Ileri jog |
| JOG_REVERSE | 0x0007 | Geri jog |
| FAULT_RESET | 0x0008 | Ariza sifirlama |

---

### 2.7 Mitsubishi FR

**Desteklenen Modeller:** FR-A800, FR-E800, FR-F800, FR-D700, FR-A700, FR-E700

**Desteklenen Protokoller:** Modbus RTU, Modbus TCP, Profinet, EtherNet/IP, BACnet/IP

**Register Yapisi:**
```
Parametreler: Pr.xxx
Modbus register = Parametre numarasi (dogrudan esleme)
Monitor register'lari: 200-212
```

**Seri Port Varsayilan Ayarlar:**

| Parametre | Deger |
|-----------|-------|
| Baud Rate | 9600 |
| Data Bits | 8 |
| Parity | None |
| Stop Bits | 1 |
| Timeout | 500 ms |
| Retry | 3 |

#### Izleme Register Tablosu

| Parametre | Register | Veri Tipi | Olcek | Birim | Kritik | Poll (ms) |
|-----------|----------|-----------|-------|-------|--------|-----------|
| Status Word | 200 | STATUS_WORD | -- | -- | Evet | 200 |
| Output Frequency | 201 | UINT16 | x0.01 | Hz | Evet | 500 |
| Motor Current | 202 | UINT16 | x0.01 | A | Evet | 500 |
| Output Voltage | 203 | UINT16 | x0.1 | V | Hayir | 1000 |
| Frequency Setting | 204 | UINT16 | x0.01 | Hz | Hayir | 500 |
| DC Bus Voltage | 205 | UINT16 | x0.1 | V | Hayir | 1000 |
| Motor Speed | 206 | INT16 | x1 | RPM | Evet | 500 |
| Output Power | 207 | INT16 | x0.01 | kW | Evet | 1000 |
| Motor Torque | 208 | INT16 | x0.1 | % | Hayir | 500 |
| Heatsink Temp | 209 | INT16 | x0.1 | C | Evet | 5000 |
| Motor Thermal | 210 | UINT16 | x0.1 | % | Hayir | 5000 |
| Inverter Thermal | 211 | UINT16 | x0.1 | % | Hayir | 5000 |
| Alarm Code | 212 | UINT16 | -- | -- | Evet | 500 |
| Current Fault | 100 | UINT16 | -- | -- | Evet | 500 |
| Fault History 1 | 990 | UINT16 | -- | -- | Hayir | 5000 |
| Fault History 2 | 991 | UINT16 | -- | -- | Hayir | 5000 |
| Accumulated Power | 558 | UINT32 (2 reg) | x0.1 | kWh | Hayir | 60000 |
| Running Time | 559 | UINT32 (2 reg) | x1 | h | Hayir | 60000 |
| Power On Time | 560 | UINT32 (2 reg) | x1 | h | Hayir | 60000 |
| Start Count | 561 | UINT32 (2 reg) | x1 | -- | Hayir | 60000 |

#### Konfigurasyon Register Tablosu

| Parametre | Mitsubishi Param | Register | Olcek | Birim | Min | Max | Varsayilan | Risk | Motor Durmali |
|-----------|-----------------|----------|-------|-------|-----|-----|------------|------|---------------|
| Max Frequency | Pr.1 | 1 | x0.01 | Hz | 0.01 | 400 | 50 | HIGH | Hayir |
| Min Frequency | Pr.2 | 2 | x0.01 | Hz | 0 | 400 | 0 | MEDIUM | Hayir |
| Base Frequency | Pr.3 | 3 | x0.01 | Hz | 0.01 | 400 | 50 | HIGH | Evet |
| Accel Time | Pr.7 | 7 | x0.1 | s | 0 | 3600 | 5 | MEDIUM | Hayir |
| Decel Time | Pr.8 | 8 | x0.1 | s | 0 | 3600 | 5 | MEDIUM | Hayir |
| Motor Rated Current | Pr.9 | 9 | x0.01 | A | 0.01 | 5000 | -- | HIGH | Evet |
| JOG Frequency | Pr.15 | 15 | x0.01 | Hz | 0 | 400 | 5 | LOW | Hayir |
| Current Limit | Pr.22 | 22 | x1 | % | 0 | 200 | 150 | MEDIUM | Hayir |
| Motor Capacity | Pr.80 | 80 | x0.01 | kW | 0.01 | 1000 | -- | HIGH | Evet |
| Motor Poles | Pr.81 | 81 | x1 | -- | 2 | 12 | 4 | HIGH | Evet |
| Thermal Relay | Pr.9 | 9 | x0.01 | A | 0 | 500 | -- | CRITICAL | Hayir |
| Station Number | Pr.117 | 117 | x1 | -- | 0 | 247 | 0 | LOW | Hayir |

#### Kontrol Komut Degerleri

| Komut | Hex Degeri | Aciklama |
|-------|-----------|----------|
| STOP | 0x0000 | Durdur |
| RUN_FORWARD | 0x0001 | Ileri calistir (STF) |
| RUN_REVERSE | 0x0003 | Geri calistir (STR) |
| JOG_FORWARD | 0x0021 | Ileri jog |
| JOG_REVERSE | 0x0023 | Geri jog |
| FAULT_RESET | 0x0080 | Ariza sifirlama (RES) |
| COAST_STOP | 0x0200 | Serbest durus (MRS) |

---

### 2.8 Rockwell PowerFlex

**Desteklenen Modeller:** PowerFlex 523, PowerFlex 525, PowerFlex 527, PowerFlex 700, PowerFlex 753, PowerFlex 755

**Desteklenen Protokoller:** Modbus RTU, Modbus TCP, Profinet, EtherNet/IP

**Model Protokol Destegi:**

| Model | Max Guc (kW) | Protokoller |
|-------|-------------|-------------|
| PowerFlex 4 | 3.7 | Modbus RTU |
| PowerFlex 40 | 11 | Modbus RTU, DeviceNet |
| PowerFlex 525 | 22 | Modbus RTU, Modbus TCP, EtherNet/IP |
| PowerFlex 527 | 22 | EtherNet/IP |
| PowerFlex 755 | 2300 | Modbus TCP, EtherNet/IP, ControlNet, DeviceNet |

**Seri Port Varsayilan Ayarlar:**

| Parametre | Deger |
|-----------|-------|
| Baud Rate | **19200** |
| Data Bits | 8 |
| Parity | None |
| Stop Bits | 1 |
| Timeout | 1000 ms |
| Retry | 3 |

#### Izleme Register Tablosu

| Parametre | Register | Veri Tipi | Olcek | Birim | Kritik | Poll (ms) |
|-----------|----------|-----------|-------|-------|--------|-----------|
| Status Word | 40100 | STATUS_WORD | -- | -- | Evet | 200 |
| Drive Status | 40101 | UINT16 | -- | -- | Evet | 200 |
| Output Frequency | 40001 | UINT16 | x0.01 | Hz | Evet | 500 |
| Motor Speed | 40002 | INT16 | x1 | RPM | Evet | 500 |
| Motor Current | 40003 | UINT16 | x0.01 | A | Evet | 500 |
| Output Voltage | 40004 | UINT16 | x0.1 | V | Hayir | 1000 |
| DC Bus Voltage | 40005 | UINT16 | x0.1 | V | Hayir | 1000 |
| Output Power | 40006 | INT16 | x0.1 | kW | Evet | 1000 |
| Motor Torque | 40007 | INT16 | x0.1 | % | Hayir | 500 |
| Commanded Freq | 40008 | UINT16 | x0.01 | Hz | Hayir | 500 |
| Analog Input | 40009 | INT16 | x0.1 | % | Hayir | 1000 |
| Heatsink Temp | 40010 | INT16 | x0.1 | C | Evet | 5000 |
| Drive Thermal | 40011 | UINT16 | x0.1 | % | Hayir | 5000 |
| Motor Thermal | 40012 | UINT16 | x0.1 | % | Hayir | 5000 |
| Control Board Temp | 40013 | INT16 | x0.1 | C | Hayir | 5000 |
| Energy Accumulated | 40400 | UINT32 (2 reg) | x0.1 | kWh | Hayir | 60000 |
| Run Time | 40402 | UINT32 (2 reg) | x0.1 | h | Hayir | 60000 |
| Power Up Time | 40404 | UINT32 (2 reg) | x0.1 | h | Hayir | 60000 |
| Start Count | 40406 | UINT32 (2 reg) | x1 | -- | Hayir | 60000 |
| Fault Code 1 | 40201 | UINT16 | -- | -- | Evet | 500 |
| Fault Code 2 | 40202 | UINT16 | -- | -- | Evet | 500 |
| Alarm Code 1 | 40203 | UINT16 | -- | -- | Evet | 500 |
| Fault History 1 | 40204 | UINT16 | -- | -- | Hayir | 5000 |

#### Konfigurasyon Register Tablosu

| Parametre | Rockwell Param | Register | Olcek | Birim | Min | Max | Varsayilan | Risk | Motor Durmali |
|-----------|---------------|----------|-------|-------|-----|-----|------------|------|---------------|
| Min Speed | P033 | 40033 | x0.01 | Hz | 0 | 500 | 0 | MEDIUM | Hayir |
| Max Speed | P034 | 40034 | x0.01 | Hz | 0.01 | 500 | 60 | HIGH | Hayir |
| Motor NP Volts | P035 | 40035 | x0.1 | V | 100 | 1000 | 460 | HIGH | Evet |
| Motor NP Amps | P036 | 40036 | x0.01 | A | 0.01 | 5000 | -- | HIGH | Evet |
| Motor NP Hertz | P037 | 40037 | x0.1 | Hz | 10 | 500 | 60 | HIGH | Evet |
| Motor NP RPM | P038 | 40038 | x1 | RPM | 1 | 30000 | -- | HIGH | Evet |
| Motor OL Current | P039 | 40039 | x0.01 | A | 0 | 5000 | -- | MEDIUM | Hayir |
| Motor OL Mode | P040 | 40040 | x1 | -- | 0 | 2 | 1 | CRITICAL | Hayir |
| Accel Time 1 | P041 | 40041 | x0.1 | s | 0 | 3600 | 10 | MEDIUM | Hayir |
| Decel Time 1 | P042 | 40042 | x0.1 | s | 0 | 3600 | 10 | MEDIUM | Hayir |
| Comm Node Addr | P044 | 40044 | x1 | -- | 1 | 247 | 1 | LOW | Hayir |
| Jog Speed | P050 | 40050 | x0.01 | Hz | 0 | 500 | 5 | LOW | Hayir |

#### Kontrol Komut Degerleri

| Komut | Hex Degeri | Aciklama |
|-------|-----------|----------|
| STOP | 0x0000 | Durdur |
| START_FORWARD | 0x0002 | Ileri calistir |
| START_REVERSE | 0x0042 | Geri calistir |
| JOG_FORWARD | 0x0006 | Ileri jog |
| JOG_REVERSE | 0x0046 | Geri jog |
| CLEAR_FAULTS | 0x0008 | Ariza temizle |
| MOP_INCREMENT | 0x0102 | Motor pot artir |
| MOP_DECREMENT | 0x0202 | Motor pot azalt |

---

## 3. Protokol Referansi

### 3.1 Modbus RTU

**Fiziksel Katman:**
- Elektriksel standart: RS-485 (diferansiyel sinyal)
- Kablo: Ekranli bukulmus cift (STP), 120 ohm empedans
- Maksimum kablo uzunlugu: 1200 m (9600 baud), 500 m (19200 baud)
- Terminasyon: Hatin her iki ucuna 120 ohm direnc baglenmalidir
- Maksimum cihaz sayisi: 32 (tekrarlayici ile 247)

**Frame Yapisi:**

```
[Slave Adresi (1 byte)] [Function Code (1 byte)] [Veri (N byte)] [CRC16 (2 byte)]
```

**CRC16 Hesaplama:** Polinomun 0xA001 ile XOR tabanli hesaplama

**Function Code Referansi:**

| FC | Isim | Aciklama |
|----|------|----------|
| 03 | Read Holding Registers | Holding register okuma |
| 04 | Read Input Registers | Input register okuma |
| 06 | Write Single Register | Tekil register yazma |
| 16 | Write Multiple Registers | Coklu register yazma |

**Tipik Konfigurasyon:**

| Marka | Baud Rate | Data | Parity | Stop |
|-------|-----------|------|--------|------|
| Danfoss | 9600 | 8 | None | 1 |
| ABB | 9600 | 8 | None | 1 |
| Siemens | 9600 | 8 | Even | 1 |
| Schneider | 19200 | 8 | Even | 1 |
| Yaskawa | 9600 | 8 | None | 2 |
| Delta | 9600 | 8 | None | 1 |
| Mitsubishi | 9600 | 8 | None | 1 |
| Rockwell | 19200 | 8 | None | 1 |

### 3.2 Modbus TCP

- TCP/IP uzerinden Modbus iletisimi
- Varsayilan port: **502**
- MBAP (Modbus Application Protocol) header:
  - Transaction ID: 2 byte
  - Protocol ID: 2 byte (0x0000 = Modbus)
  - Length: 2 byte
  - Unit ID: 1 byte
- CRC hesaplanmaz (TCP/IP checksum kullanilir)
- Baglanti yonetimi: Keep-alive onerilir
- Soket sayisi: Bircok sunucu maks. 5-10 es zamanli baglanti destekler

### 3.3 Profibus DP

- Fiziksel katman: RS-485, 9.6 kbit/s - 12 Mbit/s
- Kablo uzunlugu: 100 m (12 Mbit/s) - 1200 m (1.5 Mbit/s)
- Master-Slave mimarisi
- Veri degisimi: Siklik (DP-V0), Asiklik (DP-V1)
- GSD dosyasi: Her VFD modeli icin ureticiden temin edilir
- **Destekleyen Markalar:** Danfoss, ABB, Siemens, Schneider, Yaskawa

### 3.4 Profinet

- Ethernet tabanli endustriyel iletisim (IEEE 802.3)
- Gercek zamanli veri degisimi: RT (yazilim), IRT (donanim tabanli)
- GSDML dosyasi: Cihaz tanimlamasi icin gerekli
- IP adresi ve cihaz adi konfigurasyonu gerekir
- Varsayilan port: UDP 34962-34964
- **Destekleyen Markalar:** Danfoss, ABB, Siemens, Schneider, Yaskawa, Mitsubishi, Rockwell

### 3.5 EtherNet/IP

- CIP (Common Industrial Protocol) uzerinde Ethernet
- TCP port 44818 (acik mesajlasma)
- UDP port 2222 (I/O mesajlasma)
- EDS dosyasi: Cihaz tanimlamasi
- Explicit Messaging: Konfigurasyon ve tanimsal veri
- Implicit Messaging: Siklik I/O verisi
- **Destekleyen Markalar:** Danfoss, ABB, Schneider, Yaskawa, Mitsubishi, Rockwell

### 3.6 CANopen

- CAN 2.0A/B fiziksel katman
- Baud rate: 10 kbit/s - 1 Mbit/s
- Object Dictionary (OD) yaklasimi
- PDO (Process Data Object): Siklik veri
- SDO (Service Data Object): Konfigurasyon
- NMT (Network Management): Agirlik yonetimi
- **Destekleyen Markalar:** Danfoss, ABB, Siemens, Schneider, Yaskawa, Delta

### 3.7 BACnet IP / BACnet MS/TP

- Bina otomasyon standardi (ASHRAE 135)
- BACnet/IP: UDP port 47808 (0xBAC0)
- BACnet MS/TP: RS-485, EIA-485
- Nesne modeli: Analog Input/Output, Binary Input/Output
- HVAC uygulamalarinda yaygin
- **Destekleyen Markalar:** Danfoss, ABB, Siemens, Schneider, Mitsubishi

---

## 4. Risk Kurallari Referansi

### Risk Seviyeleri

| Seviye | Puan | Aciklama |
|--------|------|----------|
| LOW | 10 | Kozmetik/kritik olmayan parametreler (jog frekans, iletisim ayarlari) |
| MEDIUM | 40 | Calisma sirasinda degistirilebilir operasyonel parametreler (rampa sureleri, PID) |
| HIGH | 70 | Performans-kritik, motor durdurmasi gerekebilir (motor etiketi, V/f egrisi) |
| CRITICAL | 100 | Guvenlik etkili, ekipman hasari yapabilir (asiri ivmelenme, koruma devre disi) |

### Tam Risk Kurallari Tablosu

| Parametre Pattern | Temel Risk | Yukseltme Kosulu | Yukseltilmis Risk | Motor Durmali | Neden |
|-------------------|-----------|------------------|-------------------|---------------|-------|
| `accel_time_*` | MEDIUM | Deger < 1.0 s | CRITICAL | Hayir | Ivmelenme suresi <1s mekanik sok, kaplin hasari ve asiri akim tripine yol acabilir |
| `decel_time_*` | MEDIUM | Deger < 0.5 s | CRITICAL | Hayir | Yavaslatma suresi <0.5s DC bara asiri gerilim ve rejeneratif arizaya neden olabilir |
| `max_frequency` | HIGH | Deger > 60 Hz | CRITICAL | Hayir | 60Hz etiket frekansini asmak motor rulmanlari, sarimlari veya bagli ekipmani hasar edebilir |
| `thermal_protection_mode` | HIGH | Deger = 0 (Kapali) | CRITICAL | Hayir | Termal korumayi devre disi birakmak asiri akim ve asiri isinma guvenligini kaldirir -- motor hasar gorebilir |
| `current_limit_percent` | MEDIUM | Deger > 200% | HIGH | Hayir | Akim siniri nominalin %200'unu asmak surekli calismada motor termal kapasitesini asar |
| `motor_voltage_nom` | HIGH | -- | -- | Evet | Motor etiket gerilimi degisikligi motor durdurma ve auto-tune yeniden calistirma gerektirir |
| `motor_current_nom` | HIGH | -- | -- | Evet | Motor etiket akimi degisikligi motor durdurma ve auto-tune yeniden calistirma gerektirir |
| `motor_power_nom` | HIGH | -- | -- | Evet | Motor etiket gucu degisikligi motor durdurma ve auto-tune yeniden calistirma gerektirir |
| `motor_speed_nom` | HIGH | -- | -- | Evet | Motor etiket hizi degisikligi motor durdurma ve auto-tune yeniden calistirma gerektirir |
| `motor_cos_phi` | HIGH | -- | -- | Evet | Motor guc faktoru degisikligi motor durdurma ve auto-tune yeniden calistirma gerektirir |
| `vf_curve_mode` | HIGH | -- | -- | Evet | V/f egrisi degisikligi motor kontrol yontemini etkiler -- motor durdurma gerektirir |
| `voltage_boost` | HIGH | -- | -- | Evet | Voltaj artirma degisikligi dusuk hiz torkunu etkiler -- motor durdurma gerektirir |
| `slip_compensation` | HIGH | -- | -- | Evet | Kayma kompanzasyonu degisikligi hiz regülasyonunu etkiler -- motor durdurma gerektirir |
| `min_frequency` | MEDIUM | -- | -- | Hayir | Minimum frekans dusuk hiz calisma araligini etkiler |
| `torque_limit_*` | MEDIUM | -- | -- | Hayir | Tork siniri motor yukleme davranisini etkiler |
| `pid_*` | MEDIUM | -- | -- | Hayir | PID kontrolor parametreleri proses kontrol kararliligi etkiler |
| `s_curve_*` | MEDIUM | -- | -- | Hayir | S-egrisi ayarlari rampa puruzsuslugunu etkiler |
| `skip_freq_*` | MEDIUM | -- | -- | Hayir | Atlama frekansi mekanik rezonans onler -- yanlis degerler titresime neden olabilir |
| `skip_band` | MEDIUM | -- | -- | Hayir | Atlama frekans bantlari genisligi |
| `stall_detection` | MEDIUM | -- | -- | Hayir | Duraklatma algilama motor koruma yanitini etkiler |
| `jog_*` | LOW | -- | -- | Hayir | Jog parametreleri yalnizca manuel jog calistirmasini etkiler |
| `modbus_address` | LOW | -- | -- | Hayir | Iletisim adresi -- kritik olmayan operasyonel parametre |
| `baudrate_*` | LOW | -- | -- | Hayir | Iletisim baud rate -- kritik olmayan operasyonel parametre |
| `response_delay` | LOW | -- | -- | Hayir | Iletisim yanit gecikmesi -- kritik olmayan operasyonel parametre |
| `di_*_function` | LOW | -- | -- | Hayir | Dijital giris fonksiyon atamasi |
| `do_*_function` | LOW | -- | -- | Hayir | Dijital cikis fonksiyon atamasi |
| `relay_*_function` | LOW | -- | -- | Hayir | Role cikis fonksiyon atamasi |

---

## 5. Veri Tipleri ve Olcekleme

### 5.1 Register Veri Tipleri

| Tip | Boyut | Aralik | Register Sayisi | Aciklama |
|-----|-------|--------|-----------------|----------|
| UINT16 | 16 bit | 0 - 65535 | 1 | Isaretiz tam sayi |
| INT16 | 16 bit | -32768 ~ 32767 | 1 | Isaretli tam sayi |
| UINT32 | 32 bit | 0 - 4294967295 | 2 | Isaretiz buyuk tam sayi |
| INT32 | 32 bit | -2147483648 ~ 2147483647 | 2 | Isaretli buyuk tam sayi |
| FLOAT32 | 32 bit | IEEE 754 | 2 | Kayan noktali sayi |
| CONTROL_WORD | 16 bit | Bit alani | 1 | Kontrol komutu bit alani |
| STATUS_WORD | 16 bit | Bit alani | 1 | Durum bilgisi bit alani |

### 5.2 Olcekleme (Scaling)

**Ham Degerden Muhendislik Degerine:**
```
Muhendislik Degeri = Ham Deger x Olcek Faktoru + Offset
```

**Muhendislik Degerinden Ham Degere:**
```
Ham Deger = (Muhendislik Degeri - Offset) / Olcek Faktoru
```

**Ornek Hesaplamalar:**

| Parametre | Ham Deger | Olcek | Sonuc |
|-----------|-----------|-------|-------|
| Output Frequency (Danfoss) | 500 | x0.1 | 50.0 Hz |
| Motor Current (ABB) | 1250 | x0.01 | 12.50 A |
| Output Frequency (Siemens) | 5000 | x0.01 | 50.00 Hz |
| Motor Current (Delta) | 850 | x0.01 | 8.50 A |
| Heatsink Temp (Mitsubishi) | 453 | x0.1 | 45.3 C |
| Output Power (Schneider) | 75 | x0.1 | 7.5 kW |

**Yazma Ornegi:**
```
Hedef: 35.5 Hz frekans ayarla (Danfoss, olcek x0.1)
Ham Deger = 35.5 / 0.1 = 355
Register'a 355 (0x0163) yazilir
```

### 5.3 Byte Order (Siralama)

**Big Endian (Standart Modbus):**
- En anlamli byte (MSB) once gelir
- Ornek: 0x1234 -> [0x12, 0x34]
- Tum standart Modbus cihazlarinda varsayilan

**Little Endian:**
- En az anlamli byte (LSB) once gelir
- Bazi markalar bu sirayi kullanir
- Ornek: 0x1234 -> [0x34, 0x12]

**Word Order (32-bit degerler icin):**
- UINT32/INT32 degerleri 2 register isgal eder
- Standart: Yuksek word once (AB CD)
- Bazi markalar: Dusuk word once (CD AB)
- Delta kWh sayaci: Ayri low/high word register kullanir

---

## 6. Hata Kodlari

### 6.1 Platform Hata Kodlari

| Kod | Aciklama | Muhtemel Neden | Cozum |
|-----|----------|----------------|-------|
| CONNECTION_TIMEOUT | Baglanti zaman asimi | Kablo baglantisi, yanlis adres, surucu kapali | Kablolama ve adresi kontrol edin |
| CRC_ERROR | CRC hatasi | Elektriksel gurultu, yanlis baud rate/parity | Kablolama, terminasyon ve seri ayarlari kontrol edin |
| NO_RESPONSE | Yanit yok | Yanlis slave adresi, surucu mesgul | Slave adresi ve iletisim protokolunu kontrol edin |
| REGISTER_NOT_WRITABLE | Register yazilamaz | Salt okunur parametre | Parametre tanimini kontrol edin |
| READBACK_MISMATCH | Geri okuma uyumsuzlugu | Deger sinir disinda, surucu reddetmis | Min/max sinirlari kontrol edin |
| MAKER_CHECKER_VIOLATION | Maker-Checker ihlali | Ayni kullanici hem olusturup hem onayladi | Farkli kullanici ile onay istegi gonderin |
| CONCURRENT_CHANGESET | Es zamanli degisiklik seti | Ayni cihaz icin baska bir degisiklik seti islemde | Mevcut degisiklik setinin tamamlanmasini bekleyin |

### 6.2 ABB Ariza Kodlari

| Kod | Aciklama |
|-----|----------|
| 0 | Ariza yok |
| 1 | Asiri akim (Overcurrent) |
| 2 | DC asiri gerilim (DC Overvoltage) |
| 3 | Cihaz asiri sicaklik (Device Overtemperature) |
| 4 | Kisa devre (Short Circuit) |
| 5 | Motor asiri sicaklik (Motor Overtemperature) |
| 6 | Analog giris kaybi (Analog Input Loss) |
| 7 | Harici ariza (External Fault) |
| 8 | Cikis faz kaybi (Output Phase Loss) |
| 9 | Dusuk gerilim (Undervoltage) |
| 10 | AI1 dusuk ariza (AI1 Low Fault) |
| 11 | AI2 dusuk ariza (AI2 Low Fault) |
| 16 | Toprak arizasi (Earth Fault) |
| 22 | IGBT asiri sicaklik (IGBT Overtemperature) |
| 23 | Sarj arizasi (Charging Fault) |
| 25 | Motor duraklatma (Motor Stall) |
| 31 | PPCC baglanti arizasi (PPCC Link Fault) |
| 32 | Besleme faz kaybi (Supply Phase Loss) |
| 34 | ID Run arizasi (ID Run Fault) |
| 51 | Parametre geri yukleme arizasi (Parameter Restore Fault) |
| 52 | Fieldbus iletisim kaybi (Fieldbus Communication Loss) |
| 53 | Fieldbus arizasi (Fieldbus Fault) |
| 64 | Encoder arizasi (Encoder Fault) |

### 6.3 Siemens Ariza Kodlari (Fxxxx)

| Kod | Aciklama |
|-----|----------|
| 0 | Ariza yok |
| 1 | Asiri akim (Overcurrent) |
| 2 | DC bara asiri gerilim (DC Bus Overvoltage) |
| 3 | Invertor I2t |
| 4 | Motor I2t |
| 5 | DC bara dusuk gerilim (DC Bus Undervoltage) |
| 7 | Motor asiri sicaklik (Motor Overtemperature) |
| 8 | Sogutma gocugu asiri sicaklik (Heatsink Overtemperature) |
| 11 | Motor duraklatma (Motor Stall) |
| 12 | Faz arizasi (Phase Failure) |
| 13 | Dahili ariza (Internal Fault) |
| 14 | Toprak arizasi (Ground Fault) |
| 15 | Harici ariza 1 (External Fault 1) |
| 18 | Guc katmani (Power Stack) |
| 25 | EEPROM arizasi (EEPROM Fault) |
| 30 | Fieldbus arizasi (Fieldbus Fault) |
| 35 | Giris faz kaybi (Input Phase Loss) |
| 40 | Motor sicaklik sensoru arizasi |
| 51 | Parametre checksum hatasi |
| 52 | Safe Torque Off |
| 60 | Teknoloji kontrolor arizasi |
| 72 | Motor faz kaybi |
| 80 | Eksik motor parametresi |

### 6.4 Delta Ariza Kodlari

| Kod | Kisa Kod | Aciklama |
|-----|----------|----------|
| 0 | -- | Ariza yok |
| 1 | ocA | Ivmelenme sirasinda asiri akim |
| 2 | ocd | Yavaslatma sirasinda asiri akim |
| 3 | ocn | Sabit hizda asiri akim |
| 4 | GFF | Toprak arizasi |
| 5 | ov | Asiri gerilim |
| 6 | Lv | Dusuk gerilim |
| 7 | oL1 | Motor asiri yuk |
| 8 | oL2 | Invertor asiri yuk |
| 9 | oH1 | Asiri sicaklik 1 |
| 10 | oH2 | Asiri sicaklik 2 |
| 11 | AFE | PID geri besleme kaybi |
| 12 | EF | Harici ariza |
| 13 | CE | Iletisim hatasi |
| 14 | cF3 | Oto ayarlama hatasi |
| 15 | SoC | IGBT kisa devre |
| 16 | STo | Baslangic asiri yuku |
| 17 | cod | Yazilim hatasi |
| 18 | cF1 | EEPROM hatasi |
| 19 | cF2 | Donanim hatasi |
| 20 | HPF | Cikis faz kaybi |
| 21 | OPL | Frenleme transistoru arizasi |
| 22 | ot1 | Asiri tork 1 |
| 23 | ot2 | Asiri tork 2 |
| 24 | UC | Dusuk akim |

### 6.5 Mitsubishi Ariza Kodlari

| Kod | Kisa Kod | Aciklama |
|-----|----------|----------|
| 0 | -- | Ariza yok |
| 1 | OC1 | Ivmelenme sirasinda asiri akim |
| 2 | OC2 | Yavaslatma sirasinda asiri akim |
| 3 | OC3 | Sabit hizda asiri akim |
| 4 | OV1 | Ivmelenmede rejeneratif asiri gerilim |
| 5 | OV2 | Yavaslalmada rejeneratif asiri gerilim |
| 6 | OV3 | Sabit hizda rejeneratif asiri gerilim |
| 7 | THM | Motor elektronik termal role tripi |
| 8 | THT | Transistor elektronik termal trip |
| 9 | FIN | Sogutma kanadi asiri sicaklik |
| 10 | CPU | CPU hatasi |
| 11 | ILF | Giris faz kaybi |
| 12 | OLT | Duraklatma onleme (asiri tork) |
| 13 | BE | Fren transistoru hatasi |
| 14 | GF | Cikis toprak arizasi |
| 15 | LF | Cikis faz kaybi |
| 16 | OHT | Harici termal trip |
| 17 | PTC | PTC termistor tripi |
| 18 | PR | Parametre hatasi |
| 19 | PUE | PU baglanti kesintisi |
| 20 | RET | Yeniden deneme sayisi asildi |
| 21 | PE | Parametre yazma hatasi |
| 22 | PE2 | EEPROM hatasi |
| 23 | UV | Dusuk gerilim tripi |
| 24 | RFS | Bellek hatasi |
| 25 | OS | Asiri hiz |
| 26 | OD | Asiri sapma |
| 27 | POF | Guc kesintisi |
| 28 | USF | Dusuk frekans |
| 29 | OSF | Yuksek frekans |
| 30 | FAN | Sogutma fani hatasi |

### 6.6 Rockwell PowerFlex Ariza Kodlari

| Kod | Aciklama |
|-----|----------|
| 0 | Ariza yok |
| 2 | Yardimci giris (Auxiliary Input) |
| 3 | Guc kaybi (Power Loss) |
| 4 | Dusuk gerilim (UnderVoltage) |
| 5 | Asiri gerilim (OverVoltage) |
| 6 | Motor duraklatma (Motor Stall) |
| 7 | Motor asiri yuk (Motor Overload) |
| 8 | Sogutma gocugu asiri sicaklik (Heatsink OvrTmp) |
| 12 | Donanim asiri akimi (HW OverCurrent) |
| 13 | Toprak arizasi (Ground Fault) |
| 29 | Analog giris kaybi (Analog In Loss) |
| 33 | Oto yeniden baslama denemeleri (Auto Rstrt Tries) |
| 38 | Faz U toprak (Phase U to Gnd) |
| 39 | Faz V toprak (Phase V to Gnd) |
| 40 | Faz W toprak (Phase W to Gnd) |
| 41 | Faz UV kisa (Phase UV Short) |
| 42 | Faz UW kisa (Phase UW Short) |
| 43 | Faz VW kisa (Phase VW Short) |
| 48 | Parametreler sifirlandi (Params Defaulted) |
| 63 | Yazilim asiri akimi (SW OverCurrent) |
| 64 | Surucu asiri yuk (Drive Overload) |
| 70 | Guc unitesi (Power Unit) |
| 80 | Ag kaybi (Net Loss) |
| 81 | Port 5 DPI kaybi |
| 82 | Port 6 DSI kaybi |
| 100 | Parametre checksum (Parameter Checksum) |
| 122 | I/O kart arizasi (I/O Board Fail) |
| 125 | Slot1 iletisim kaybi (Slot1 Comm Loss) |
| 126 | Slot2 iletisim kaybi (Slot2 Comm Loss) |

---

## Ek: Hizli Basvuru

### Marka Karsilastirma Tablosu

| Ozellik | Danfoss | ABB | Siemens | Schneider | Yaskawa | Delta | Mitsubishi | Rockwell |
|---------|---------|-----|---------|-----------|---------|-------|------------|----------|
| Baud Rate | 9600 | 9600 | 9600 | 19200 | 9600 | 9600 | 9600 | 19200 |
| Parity | None | None | Even | Even | None | None | None | None |
| Stop Bits | 1 | 1 | 1 | 1 | 2 | 1 | 1 | 1 |
| Vars. Max Freq | 50 Hz | 50 Hz | 50 Hz | 50 Hz | 50 Hz | 60 Hz | 50 Hz | 60 Hz |
| Vars. Accel | 10 s | 5 s | 10 s | 3 s | 10 s | 10 s | 5 s | 10 s |
| Vars. Current Lim | 160% | 150% | 150% | -- | 150% | 150% | 150% | -- |

### Enum Referansi

**VfdBrand:** `danfoss`, `abb`, `siemens`, `schneider`, `yaskawa`, `delta`, `mitsubishi`, `rockwell`

**VfdProtocol:** `modbus_rtu`, `modbus_tcp`, `profibus_dp`, `profinet`, `ethernet_ip`, `canopen`, `bacnet_ip`, `bacnet_mstp`

**VfdParameterCategory:** `status`, `motor`, `energy`, `thermal`, `fault`, `control`, `configuration`

**VfdParameterGroup:** `ramp_times`, `frequency_limits`, `motor_nameplate`, `current_limits`, `vf_control`, `pid_controller`, `digital_io`, `communication`, `protection`, `jog`, `advanced`

**VfdDeviceStatus:** `draft`, `pending_test`, `testing`, `test_failed`, `active`, `suspended`, `offline`

**RiskLevel:** `low` (10), `medium` (40), `high` (70), `critical` (100)

**VfdDataType:** `uint16`, `int16`, `uint32`, `int32`, `float32`, `control_word`, `status_word`

---

> Bu belge `apps/sensor-service/src/vfd/` kaynak kodundan otomatik olarak olusturulmustur.
> Son guncelleme: 2026-03-26
