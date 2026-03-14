# D06 - HR Service Audit (Enterprise HR Perspective)

**Auditor:** D6 - HR Management Specialist
**Date:** 2026-03-14
**Service:** hr-service (port 3005, Apollo Federation v2 subgraph)
**Scope:** Leave, Attendance, Training, Payroll, Aquaculture-specific HR, CQRS, Data Model, Tenant Isolation

---

## 1. Executive Summary

HR service is a well-structured, feature-rich CQRS-based microservice covering employee lifecycle, leave management, attendance tracking, training/certification, payroll, and aquaculture-specific HR (offshore rotations, safety training, sea-worthiness). The codebase demonstrates mature patterns: transactional integrity with QueryRunner, pessimistic locking for balance operations, proper event publishing, comprehensive validation, and multi-tenant schema isolation.

**Overall Maturity: 7.5/10** - Solid for an enterprise HR platform. Key gaps exist in: payroll floating-point precision, lack of automated certification enforcement blocking, and incomplete test coverage for scheduling and payroll modules.

### Critical Findings

| Severity | ID | Finding |
|----------|-----|---------|
| HIGH | H-1 | Payroll hesaplamalarda floating-point precision riski |
| HIGH | H-2 | Tenant schema isolation race condition (bilinen, dokumante edilmis) |
| HIGH | H-3 | Offshore rotasyon cakisma kontrolu yok |
| MEDIUM | M-1 | Suresi dolmus sertifika - offshore erisi engelleme mekanizmasi yok |
| MEDIUM | M-2 | Izin bakiyesi negatife dusebilir (non-accrued leave types) |
| MEDIUM | M-3 | Payroll self-approval engellemesi yok |
| MEDIUM | M-4 | Leave resolver'da userId/employeeId karisikligi (myLeaveBalances) |
| LOW | L-1 | Scheduling modulu testleri unit-level; integration test eksik |
| LOW | L-2 | SafetyTrainingRecord icin VersionColumn eksik |
| LOW | L-3 | Leave test suite DataSource mock eksik (handler refactor sonrasi) |

---

## 2. Module Analysis

### 2.1 Core HR Module (HRModule)

**Path:** `apps/hr-service/src/hr/`

#### Entity Model - Employee
- 356 satir, zengin profil: contact info, address, bank details (JSONB), aquaculture fields
- `@HideField()` ile hassas alanlar korunmus: `dateOfBirth`, `nationalId`, `baseSalary`, `bankDetails`
- `BankDetails` sinifi `@ObjectType()` dekoratorune sahip degil - bu GraphQL'den izole ediyor (dogru yaklasim)
- `@BeforeInsert()/@BeforeUpdate()` ile email/isim sanitizasyonu
- `VersionColumn` ile optimistic locking
- Soft delete pattern: `isDeleted` + `deletedAt`

**Guclu Yonler:**
- Aquaculture-specific alanlar: `personnelCategory` (OFFSHORE/ONSHORE/HYBRID), `seaWorthy`, `assignedWorkAreas`
- IANA timezone per employee (attendance hesaplamalari icin kritik)
- Kapsamli index stratejisi (9 index, composite ve single-column)
- `VersionColumn` ile concurrent update korunmasi

**Sorunlar:**
- `baseSalary` alani `decimal(12,2)` TypeORM column ama TypeScript'te `number` tipi - runtime'da floating-point olarak islenir (bkz. H-1)
- `certifications` ve `skills` alanlari `simple-array` - bu buyuk veri setlerinde performans sorunu olusturabilir

#### Entity Model - Department
- Ayri `DepartmentHR` entity'si ile department hiyerarsisi
- Employee'de hem enum `department` hem FK `departmentHrId` var - dual department sistemi karmasiklik yaratiyor

#### Payroll Entity & Handlers

**Path:** `apps/hr-service/src/hr/entities/payroll.entity.ts`

Payroll entity detayli ve iyi yapilandirilmis:
- `EarningsBreakdown`, `DeductionsBreakdown`, `WorkHours` JSONB olarak saklanir
- `PayrollStatus`: DRAFT -> PENDING_APPROVAL -> APPROVED -> PROCESSING -> PAID -> CANCELLED
- Unique index: `(tenantId, employeeId, payPeriodStart, payPeriodEnd)` - cakisan periyot engeli
- Unique index: `(tenantId, payrollNumber)` - tekrar engeli

**CreatePayrollHandler (create-payroll.handler.ts):**
- Transaction icinde calisir
- Cakisan periyot kontrolu (overlapping payroll period check)
- `deductions > grossPay` kontrolu
- `netPay < 0` kontrolu
- Payroll number: `PAY-YYYYMM-XXXXXXXX` (crypto random hex)

```
[H-1] FINDING: Payroll Floating-Point Precision
```

**Detay:** `CreatePayrollHandler` icinde earnings/deductions hesaplari JavaScript `+` operatoru ile yapilir:
```typescript
grossPay:
  input.earnings.baseSalary +
  (input.earnings.overtime || 0) +
  (input.earnings.bonus || 0) +
  ...
```
JavaScript floating-point aritmetigi: `0.1 + 0.2 = 0.30000000000000004`. Bordro hesaplamalarinda kuruslar onemlidir. Payroll entity'de `decimal(12,2)` tanimli ama TypeScript tarafinda `number` olarak isleniyor. Hesaplama sonuclari veritabanina yazilmadan once rounding yapilmiyor.

**Oneri:** Tum parasal hesaplamalar icin `Decimal.js` veya `big.js` kutuphanesi kullanilmali, ya da en azindan sonuclarda `Math.round(value * 100) / 100` uygulanmali.

**ApprovePayrollHandler (approve-payroll.handler.ts):**
- Transaction icinde calisir
- Status kontrolu: sadece DRAFT veya PENDING_APPROVAL onaylanabilir

```
[M-3] FINDING: Payroll Self-Approval Engeli Yok
```
`ApprovePayrollHandler` icinde bordroyu olusturan kisinin ayni bordroyu onaylamasini engelleyen bir kontrol yok. `createdBy === userId` kontrolu eksik. Enterprise HR'da bu segregation of duties ihlalidir.

---

### 2.2 Leave Module

**Path:** `apps/hr-service/src/leave/`

#### Entity Model

**LeaveType** - Zengin konfigurasyonu:
- `LeaveCategory`: ANNUAL, SICK, PARENTAL, SHORE_LEAVE, ROTATION_BREAK, EMERGENCY, UNPAID, vb.
- `defaultDaysPerYear`, `maxCarryOverDays`, `maxConsecutiveDays`, `minDaysNotice`
- `accrualRate`, `accrualStartAfterMonths` - birikim mekanizmasi
- `approvalLevels` - cok seviyeli onay destegi
- `isAquacultureSpecific`, `applicableForOffshore` - sektore ozel flags

**LeaveBalance** - Detayli bakiye takibi:
- `openingBalance`, `accrued`, `used`, `pending`, `adjustment`, `carriedOver`
- Computed property'ler: `currentBalance`, `availableBalance`
- `availableBalance = opening + accrued + carriedOver + adjustment - used - pending`
- Yillik bazda takip (year field + unique index)

**LeaveRequest** - Kapsamli is akisi:
- Status: DRAFT -> PENDING -> APPROVED/REJECTED -> CANCELLED/WITHDRAWN
- `approvalHistory` JSONB array - tam audit trail
- `requestNumber`: `LR-YYYY-XXXXX` (crypto random)
- Half-day destegi: `isHalfDayStart`, `isHalfDayEnd`, `halfDayPeriod`
- Attachments destegi (JSONB)

#### Leave Flow Analysis

**CreateLeaveRequestHandler:**
1. Employee dogrulama (tenant-scoped)
2. Leave type dogrulama (aktif ve tenant-scoped)
3. Tarih araligi dogrulama (start <= end)
4. Minimum bildirim gunleri kontrolu
5. **Transaction baslangici (READ COMMITTED)**
6. Cakisan izin kontrolu (pessimistic_read lock)
7. Bakiye kontrolu (accrued leave types icin)
8. **Pending bakiye artirimi DRAFT asamasinda** - TOCTOU race condition'i kapatir
9. Kayit olusturma ve commit

**SubmitLeaveRequestHandler:**
- DRAFT -> PENDING gecisi
- Sahiplik kontrolu (createdBy === userId VEYA employeeId eslesmesi)
- **Pending bakiye TEKRAR arttirilmaz** (zaten DRAFT'ta arttirildi) - dogru yaklasim

**ApproveLeaveRequestHandler:**
- Transaction icinde calisir
- Self-approval engeli: `approverEmployee.id === leaveRequest.employeeId` kontrolu (auth userId'den employee'ye cevrim yapilir)
- Sadece PENDING durumdaki istekler onaylanabilir
- Bakiye guncelleme: `pending -= totalDays`, `used += totalDays`
- Event yayinlama: `LeaveApprovedEvent`

**RejectLeaveRequestHandler:**
- Self-rejection engeli
- Pending bakiye geri yukleme
- Event yayinlama: `LeaveRejectedEvent`

**CancelLeaveRequestHandler:**
- Sahiplik kontrolu (auth userId -> employee cevrim ile)
- Status-based bakiye geri yukleme:
  - DRAFT/PENDING: `pending -= totalDays`
  - APPROVED: `used -= totalDays`
- Baslayan izinler iptal edilemez kontrolu
- Event yayinlama: `LeaveCancelledEvent`

```
[M-2] FINDING: Izin Bakiyesi Negatife Dusebilir
```
**Detay:** `CreateLeaveRequestHandler` sadece `isAccrued` leave types icin bakiye kontrolu yapar. Non-accrued leave types (ornegin UNPAID, EMERGENCY) icin bakiye kontrolu atlanir. Bu tasarim kararidir ama sorunlu durumlar olusturabilir:
- Ayni gun icin birden fazla UNPAID izin talebi yapilabilir (cakisma kontrolu var ama bakiye kisitlamasi yok)
- `carriedOver` veya `adjustment` negatif deger alabilir (entity'de constraint yok)

**Ayrica:** `LeaveBalance` entity'sinde `availableBalance` computed property'si negatif deger donebilir - UI tarafinda bu kontrol edilmeli.

```
[M-4] FINDING: Leave Resolver userId/employeeId Karisikligi
```
**Detay:** `LeaveResolver.getMyLeaveBalances()` icinde:
```typescript
const userId = this.getUserId(context); // auth-service user UUID
return this.queryBus.execute(
  new GetLeaveBalancesQuery(tenantId, userId, year), // userId employeeId olarak gonderiliyor
);
```
`GetLeaveBalancesQuery`'nin ikinci parametresi `employeeId` bekliyorsa, `userId` (auth UUID) gonderilmesi yanlis sonuc doner. Ancak bu handler'in implementasyonunu goremedigim icin, handler icinde `employeeId` parametresini userId olarak yorumlayabilir. Potansiyel veri tutarsizligi.

#### Leave Resolver Security
- `GqlAuthGuard` tum resolver'a uygulanmis
- `RolesGuard` + `@Roles()` dekoratoru ile rol bazli erisim
- tenantId ve userId sadece JWT'den alinir (`context.req.user`)
- `createLeaveRequest` icinde self-service kontrolu: baskasi icin izin olusturma engeli

---

### 2.3 Attendance Module

**Path:** `apps/hr-service/src/attendance/`

#### Entity Model

**Shift** - Esnek vardiya tanimlari:
- `ShiftType`: REGULAR, OFFSHORE, NIGHT, ROTATION, FLEXIBLE
- `startTime`/`endTime` (HH:mm format), `totalMinutes`, `breakMinutes`
- `crossesMidnight` flag - gece vardiyasi destegi
- `graceMinutes` - gec gelme toleransi
- `earlyClockInMinutes` / `lateClockOutMinutes` - clock-in/out penceresi
- `workDays` array - haftalik calisma gunleri
- `breakPeriods` JSONB - detayli mola tanimlari

**AttendanceRecord** - Zengin yoklama kaydi:
- `ClockMethod`: BIOMETRIC, CARD, MOBILE, WEB, MANUAL, GPS
- `ApprovalStatus`: AUTO_APPROVED, PENDING_REVIEW, MANAGER_APPROVED, HR_APPROVED, REJECTED
- GPS konum (JSONB): `clockInLocation`, `clockOutLocation`
- IANA timezone per record
- Break tracking: `breakStartTime`, `breakEndTime`, computed `totalBreakMinutes`
- Offshore tracking: `workAreaId`, `isOffshore`
- Minute-based metriks: `workedMinutes`, `overtimeMinutes`, `lateMinutes`, `earlyLeaveMinutes`

#### Clock-In Handler Analysis

`ClockInHandler` iyi yapilandirilmis:
1. Employee dogrulama + status kontrolu (TERMINATED/SUSPENDED engeli)
2. Timezone belirleme: command > employee > UTC fallback
3. Lokal tarih hesaplama (timezone-aware)
4. **Transaction icinde duplicate check** (TOCTOU race kapatilmis)
5. Shift-based validasyonlar:
   - Time window kontrolu (earlyClockIn/lateClockOut)
   - Grace period ile gec gelme tespiti
   - Late minutes hesaplama
6. Unscheduled clock-in destegi (PENDING_REVIEW ile)
7. Offshore flag belirleme (workAreaId veya personnelCategory)
8. Event yayinlama

**Guclu Yonler:**
- Pre-transaction parallel read optimizasyonu (`Promise.all` ile 3 okuma)
- `safeParseTime()` ile guvenli saat parse'lama
- Overnight shift destegi (findActiveAttendanceRecord icinde dun kontrolu)

#### Clock-Out Handler Analysis

`ClockOutHandler` benzer sekilde saglamdir:
1. `findActiveAttendanceRecord` ile hem bugun hem dun kontrolu
2. Shift relation eager loading (ek query yok)
3. Break time hesaplama
4. `calculateWorkedMinutes` static metodu
5. Overtime ve early leave hesaplama (UTC bazli)
6. Status guncelleme (LATE, EARLY_LEAVE)
7. Irregularity durumunda PENDING_REVIEW

**Timezone Handling:**
- `convertLocalToUtc()` ve `convertUtcToLocal()` helper'lari
- `getTimezoneOffset()` - `Intl.DateTimeFormat` API kullanir (dogru yaklasim)
- `isValidTimezone()` - IANA timezone dogrulama
- Tum saatler UTC olarak saklanir, timezone field ile lokal gosterim destegi

**Fazla Mesai Hesaplama:**
- `OvertimeCalculatorService`: Planlanan ve gerceklesen overtime hesaplama
- Haftalik ve aylik limit kontrolu
- `SchedulingSettings`'ten standart/max overtime dakika degerleri
- `ConflictDetectionService`: 6 farkli conflict tipi (leave overlap, holiday, max hours, consecutive days, insufficient rest, double booking)

---

### 2.4 Training Module

**Path:** `apps/hr-service/src/training/`

#### Entity Model

**CertificationType** - Sertifika turu tanimlari:
- `CertificationCategory`: DIVING, SAFETY, VESSEL, EQUIPMENT, FIRST_AID, FOOD_HANDLING, ENVIRONMENTAL, etc.
- `CertificationRequirement`: MANDATORY, RECOMMENDED, OPTIONAL
- `validityMonths` - gecerlilik suresi
- `renewalReminderDays` - yenileme hatirlatma suresi
- `isOffshoreRequired`, `isDivingRequired` - offshore/diving zorunluluk flags
- `applicableWorkAreas` - hangi work area'larda zorunlu
- `prerequisiteCertifications` - on kosul sertifikalari

**EmployeeCertification** - Calisanin sertifikalari:
- `CertificationStatus`: PENDING, ACTIVE, EXPIRED, EXPIRING_SOON, REVOKED, SUSPENDED
- `VerificationStatus`: UNVERIFIED, PENDING_VERIFICATION, VERIFIED, VERIFICATION_FAILED
- Dogrulama detaylari: `verifiedBy`, `verifiedAt`, `issuingAuthority`
- Revocation tracking: `revokedBy`, `revokedAt`, `revocationReason`
- Renewal tracking: `previousCertificationId`, `isRenewal`
- Reminder tracking: `reminderSent`, `reminderSentAt`

**TrainingCourse** ve **TrainingEnrollment**:
- Kurs katalogu ve kayit takibi
- Assessment destegi: `requiresAssessment`, `passingScore`, `maxAttempts`
- `EnrollmentStatus`: ENROLLED, IN_PROGRESS, COMPLETED, PASSED, FAILED, CANCELLED

#### Certification Lifecycle

**AddEmployeeCertificationHandler:**
1. Employee ve CertificationType dogrulama
2. Mevcut aktif sertifika kontrolu (duplicate engeli)
3. Status belirleme: expiryDate'e gore ACTIVE/EXPIRED/EXPIRING_SOON
4. `VerificationStatus.PENDING_VERIFICATION` ile baslatma
5. Event: `CertificationAddedEvent`

**GetExpiringCertificationsHandler:**
- Belirli gun icinde suresi dolacak sertifikalari listeler
- Department filtreleme destegi
- REVOKED ve EXPIRED statuleri haric tutar

```
[M-1] FINDING: Suresi Dolmus Sertifika - Offshore Erisim Engelleme Mekanizmasi Yok
```
**Detay:** `CertificationType` entity'sinde `isOffshoreRequired: true` ve `CertificationRequirement.MANDATORY` tanimlanabiliyor. Ancak sertifika suresi doldiginda veya revoke edildiginde:
1. Calisanin `seaWorthy` flag'i otomatik olarak `false` yapilmiyor
2. Clock-in handler'da `isOffshore` calisanlar icin mandatory sertifika kontrolu yok
3. `WorkRotation` olusturulurken calisanin required sertifikalari kontrol edilmiyor
4. `GetCurrentlyOffshoreHandler` expired sertifika kontrolu yapmiyor

Bu, STCW/HUET gibi hayati guvenlik sertifikalari suresi dolmus bir calisanin offshore'a gonderilmesine izin verir. Aquaculture sektorunde bu ciddi bir compliance riski ve guvenlik tehlikesidir.

**Oneri:**
- Sertifika suresi doldiginda `CertificationExpiredEvent` yayinla
- Event handler'da: ilgili employee'nin `seaWorthy = false` yap
- Clock-in handler'a: offshore clock-in icin mandatory sertifika kontrolu ekle
- Rotasyon olusturmada: required certifications'i zorunlu kil

---

### 2.5 Aquaculture Module

**Path:** `apps/hr-service/src/aquaculture/`

#### Entity Model

**WorkArea:**
- `WorkAreaType` enum (ortak, common/enums.ts'de)
- `WorkAreaRiskLevel`: LOW, MEDIUM, HIGH, CRITICAL
- `GeoCoordinates` (latitude/longitude) JSONB
- `maxCapacity` - max personel
- `requiredCertifications` - zorunlu sertifika listesi
- `requiredPPE` - zorunlu kisisel koruyucu ekipman
- `requiresDivingCertification`, `requiresVesselCertification`, `requiresSeaWorthy`

**WorkRotation:**
- `RotationType`: OFFSHORE, ONSHORE, FIELD, VESSEL, MIXED
- `RotationStatus`: SCHEDULED, IN_PROGRESS, COMPLETED, CANCELLED, EXTENDED
- `daysOn`, `daysOff` - rotasyon sikligi
- `TransportInfo` JSONB - ulasim detaylari
- Extension tracking: `isExtended`, `extensionDays`, `extensionReason`
- Safety check-in: `lastCheckInTime`, `checkInHistory` JSONB
- `reliefEmployeeId` - yedek personel

**SafetyTrainingRecord:**
- `SafetyTrainingType`: INDUCTION, FIRE_SAFETY, SEA_SURVIVAL, FIRST_AID, HELICOPTER_SAFETY, VESSEL_SAFETY, DIVING_SAFETY, CHEMICAL_HANDLING, FALL_PROTECTION, CONFINED_SPACE, EMERGENCY_RESPONSE, BIOSECURITY
- `SafetyTrainingStatus`: NOT_STARTED, IN_PROGRESS, COMPLETED, EXPIRED, OVERDUE
- `isMandatoryForOffshore` flag
- `nextDueDate`, `expiryDate` - surec takibi

```
[H-3] FINDING: Offshore Rotasyon Cakisma Kontrolu Yok
```
**Detay:** `WorkRotation` entity'sinde `(tenantId, employeeId, startDate)` index'i var ama **unique degil**. Ayni calisan icin ayni tarih araliginda birden fazla rotasyon olusturulabilir:
- Rotasyon olusturma handler'i bulunamadi (sadece query handler'lar mevcut: `GetWorkAreasHandler`, `GetWorkRotationsHandler`, `GetCurrentlyOffshoreHandler`)
- Rotasyon CRUD islemleri muhtemelen henuz implement edilmemis veya resolver uzerinden dogrudan yapiliyordur
- `GetCurrentlyOffshoreHandler` cakisan rotasyonlari filtrelemez - ayni calisan birden fazla "currently offshore" olarak gorunebilir

**Oneri:**
- `(tenantId, employeeId, startDate, endDate)` icin cakisma kontrolu eklenmeli
- Rotasyon olusturma handler'inda date overlap check yapilmali
- `maxCapacity` kontrolu: work area kapasitesi asilmasin

---

### 2.6 Scheduling Module

**Path:** `apps/hr-service/src/scheduling/`

#### Entity Model

**SchedulingSettings** - Tenant bazli ayarlar:
- `standardWeeklyMinutes`: 2700 (45 saat)
- `maxOvertimeMinutesPerWeek`: 720 (12 saat)
- `maxOvertimeMinutesPerMonth`: 2880 (48 saat)
- `maxConsecutiveWorkDays`: 6
- `minRestMinutesBetweenShifts`: 660 (11 saat)
- `workWeekStartDay`, `defaultShiftId`

**WeeklyPlan** ve **WeeklyPlanEntry** - Haftalik planlama
**Holiday** - Resmi tatil yonetimi

#### Services

**OvertimeCalculatorService:**
- Planlanan overtime: entries'den toplam dakika - standart dakika
- Gerceklesen overtime: attendance records'dan
- Aylik limit kontrolu

**ConflictDetectionService:**
- Leave overlap: onaylanmis izinlerle cakisma
- Holiday overlap: resmi tatillerle cakisma
- Max hours exceeded: haftalik limit asimi
- Max consecutive days: ardisik calisma gunu asimi
- Insufficient rest: vardiyalar arasi minimum dinlenme
- Double booking: ayni gun cift plan

**Guclu Yonler:**
- 6 farkli conflict tipi ile kapsamli dogrulama
- Severity levels: ERROR, WARNING, INFO
- Leave ve holiday ile entegrasyon

---

## 3. CQRS Pattern Analysis

### Implementasyon

HR service `@nestjs/cqrs` ile CQRS pattern'ini tam uyguluyor:

**Commands (Write Side):**
- Her command ayri bir dosyada, tek sorumluluk
- CommandHandler'lar transaction yonetimi yapiyor
- EventBus ile domain event yayinlama

**Queries (Read Side):**
- QueryHandler'lar dogrudan repository okuma
- Filtreleme ve pagination destegi
- `createQueryBuilder` ile optimize sorgular

**Event Publishing:**
- `@platform/event-contracts` ile tip-safe event tanimlari
- `createBaseEvent()` helper ile standart event yapisi
- Fire-and-forget: `.catch()` ile event yayinlama hatalari loglanir ama islem engellenmez

**Dogru Uygulamalar:**
- Transaction icinde command execution
- Separate read/write paths
- Event-driven notification
- Pessimistic locking (leave balance)

**Eksiklikler:**
- Event handler'lar (Saga pattern) gorulmuyor - eventler sadece NATS'a yayinlaniyor
- Compensating transaction mekanizmasi yok
- Event replay/sourcing yok (pure CQRS, event sourcing degil)

---

## 4. Tenant Schema Isolation

**Path:** `apps/hr-service/src/middleware/tenant-schema.middleware.ts`

### Implementasyon

- `TenantSchemaMiddleware`: request basina PostgreSQL `search_path` ayari
- Schema naming: `tenant_{first16chars_uuid_no_hyphens}`
- SQL injection korunmasi: UUID format dogrulama + schema name regex (`/^[a-z0-9_]+$/`)
- LRU cache (1000 entry, 5 dakika TTL) ile schema existence check
- Fallback: tenant schema yoksa `hr` shared schema

```
[H-2] FINDING: Tenant Schema Isolation Race Condition (Bilinen)
```
**Detay:** Middleware'in kendisinde (satir 128-143) dokumante edilmis:
```
// SECURITY (MED-06): The RESET search_path calls below use the shared DataSource pool
// and may land on a different pooled connection than the one used for this request.
// Under high concurrency this can cause cross-tenant reads.
```

`SET search_path` isleminde middleware pool'dan bir connection alir, ama sonraki handler islemleri farkli bir pool connection kullanabilir. Yuksek concurrency'de bu cross-tenant veri okumaya yol acabilir.

**Mevcut Mitigation:** `res.on('finish')` ve `res.on('close')` event'lerinde `RESET search_path` cagrisi.

**Tam Cozum (dokumante edilmis):** Per-request QueryRunner kullanimi - tum handler'larin `req.queryRunner.manager` uzerinden calismasini gerektirir. Bu buyuk bir refactor.

**Not:** Bu sorun tum service'lerde ayni pattern'de var (sensor-service, farm-service vb.) ve platform-wide bir refactor gerektirir.

### Connection Pool Configuration
- `max: 20` (configurable)
- `idleTimeoutMillis: 30000`
- `connectionTimeoutMillis: 10000`
- Default search_path: `hr,public` (TypeORM sync icin)

---

## 5. Is Kurali Analizi

### 5.1 Izin Bakiyesi Negatife Dusebilir mi?

**Cevap: Evet, belirli kosullarda.**

- **Accrued leave types icin:** `CreateLeaveRequestHandler` bakiye kontrolu yapar (`availableBalance < totalDays` -> BadRequestException). Negatife dusmez.
- **Non-accrued leave types icin:** Bakiye kontrolu atlanir (`if (leaveType.isAccrued)` condition'i). UNPAID veya EMERGENCY izin tipleri icin sinir yok.
- **Concurrent requests:** Pessimistic read lock ile korunuyor - ayni anda iki istek bakiye yarisi olusturamaz.
- **`carriedOver` ve `adjustment` alanlari:** Negatif deger alabilir (entity'de constraint yok). Ornegin, -5 adjustment negatif bakiyeye yol acar.

### 5.2 Offshore Rotasyon Cakismasi Kontrolu

**Cevap: Kontrol yok.**

- Rotasyon olusturma handler'i bulunamadi (muhtemelen eksik veya resolver uzerinden)
- `WorkRotation` entity'sinde tarih araligi icin unique constraint yok
- `GetCurrentlyOffshoreHandler` cakisma kontrolu yapmiyor
- Bir calisan teorik olarak ayni anda iki farkli work area'da offshore olarak gorunebilir

### 5.3 Zorunlu Guvenlik Egitimi Suresi Asiminda Ne Olur?

**Cevap: Hicbir sey - sistem sadece sorgulama yapiyor.**

- `GetExpiringCertificationsHandler`: Suresi dolmak uzere olan sertifikalari listeler (proaktif uyari)
- `SafetyTrainingRecord` entity'sinde `EXPIRED` ve `OVERDUE` statusleri tanimli
- Ama **otomatik status gecisi yok** - bir cron job veya scheduled task gorulmedi
- **Erisim engelleme yok** - suresi dolmus sertifikasi olan calisan clock-in yapabilir, rotasyona atanabilir
- `reminderSent` flag'i var ama reminder gonderme mekanizmasi gorulmuyor

### 5.4 Maas Hesaplamada Floating Point Precision

**Cevap: Risk var.**

- Entity'de `decimal(12,2)` kullaniliyor (PostgreSQL tarafinda hassas)
- TypeScript/JavaScript tarafinda `number` tipi (IEEE 754 double-precision)
- Hesaplamalar: `baseSalary + overtime + bonus + commission + allowances = grossPay`
- JavaScript'te: `0.1 + 0.2 = 0.30000000000000004`
- **Risk:** Kucuk kusuratlar PostgreSQL'e yazilirken yuvarlanir ama hesaplama sirasinda tutarsizliklar olusabilir
- `netPay` hesabi: `grossPay - totalDeductions` - bu iki buyuk sayinin farki kucuk bir hata biriktirebilir

---

## 6. Data Model ve Entity Iliskileri

### Iliskiler Diagrami

```
Employee (1) ----< (N) Payroll
Employee (1) ----< (N) LeaveRequest
Employee (1) ----< (N) LeaveBalance (per year, per leave type)
Employee (1) ----< (N) AttendanceRecord
Employee (1) ----< (N) EmployeeCertification
Employee (1) ----< (N) TrainingEnrollment
Employee (1) ----< (N) WorkRotation
Employee (1) ----< (N) SafetyTrainingRecord
Employee (1) ----< (N) WeeklyPlanEntry
Employee (N) ----> (1) DepartmentHR

LeaveRequest (N) ----> (1) LeaveType
LeaveBalance (N) ----> (1) LeaveType
AttendanceRecord (N) ----> (1) Shift
EmployeeCertification (N) ----> (1) CertificationType
TrainingEnrollment (N) ----> (1) TrainingCourse
WorkRotation (N) ----> (1) WorkArea

Schedule (N) ----> (1) Shift
Schedule (N) ----> (1) Employee
WeeklyPlanEntry (N) ----> (1) WeeklyPlan
WeeklyPlanEntry (N) ----> (1) Shift
```

### Cross-Service Links
- `Employee.farmId` -> farm-service (FK yok, loose coupling)
- `Employee.userId` -> auth-service (FK yok, loose coupling)
- `Employee.supervisorId` -> self-referencing (Employee tablosu)

### Soft Delete Pattern
Tum entity'ler `isDeleted` + `deletedAt` + `deletedBy` kullanir. Sorgularda `isDeleted: false` filtresi uygulanir. **Tutarlilik:** SafetyTrainingRecord haric tum entity'lerde `isDeleted` var.

### Versioning
Tum entity'ler `@VersionColumn()` kullanir (optimistic locking). **Istisna:** `SafetyTrainingRecord` entity'sinde `VersionColumn` yok.

```
[L-2] FINDING: SafetyTrainingRecord icin VersionColumn Eksik
```
Bu entity concurrent update senaryolarinda veri kaybina neden olabilir. Diger tum entity'lerde VersionColumn mevcut.

---

## 7. Security Analysis

### Authentication & Authorization
- `GqlAuthGuard` tum resolver'lara uygulanmis
- `RolesGuard` global olarak APP_GUARD ile kayitli
- Roller: TENANT_ADMIN, MODULE_MANAGER, MODULE_USER
- tenantId/userId sadece JWT'den alinir (header'lardan degil)

### Sensitive Data Protection
- `@HideField()`: dateOfBirth, nationalId, baseSalary, bankDetails, emergencyInfo
- `BankDetails` sinifi `@ObjectType()` degil - GraphQL schema'sinda gorunmez
- Production'da stacktrace temizligi
- GraphQL depth limit (10), complexity limit (1000)
- Introspection/playground production'da kapali

### Input Validation
- UUID format dogrulama (SQL injection onlemi)
- Schema name regex dogrulama
- Date range dogrulama
- Email normalization (lowercase + trim)
- `safeParseTime()` ile HH:mm format dogrulama

### ID Security
- Record number'lar `crypto.randomBytes()` ile uretilir (MED-01 fix)
- Payroll number: 4 byte random hex
- Leave request/attendance/certification: 3 byte random

---

## 8. Test Coverage Analysis

### Mevcut Test Dosyalari

| Test File | Line Count | Coverage |
|-----------|-----------|----------|
| `leave/__tests__/leave.integration.spec.ts` | 789 | Leave workflow (submit, approve, reject, cancel, E2E, events) |
| `training/__tests__/training.integration.spec.ts` | 952 | Training enrollment, completion, certification lifecycle |
| `attendance/__tests__/attendance.integration.spec.ts` | 840 | Clock-in, employee validation, time window, late detection, overview |
| `hr/__tests__/payroll.integration.spec.ts` | Var (okunmadi) | Payroll operations |
| `hr/__tests__/department.integration.spec.ts` | Var (okunmadi) | Department operations |
| `scheduling/__tests__/conflict-detection.service.spec.ts` | Var | Conflict detection unit tests |
| `scheduling/__tests__/overtime-calculator.service.spec.ts` | Var | Overtime calculator unit tests |
| `scheduling/__tests__/schedule-notification.service.spec.ts` | Var | Notification unit tests |
| `scheduling/__tests__/update-plan-entry.handler.spec.ts` | Var | Plan entry update tests |

### Test Kalitesi

**Leave Tests (Iyi):**
- Submit, approve, reject, cancel flow'lari
- Self-approval/rejection engeli testleri
- Balance restore testleri
- E2E workflow (draft -> submit -> approve, draft -> submit -> reject)
- Event publishing dogrulama
- Edge cases (not found, missing balance, concurrent modifications)

**Training Tests (Iyi):**
- Enrollment lifecycle
- Assessment-based completion (pass/fail/max attempts)
- Certification CRUD ve revocation
- Multi-tenant isolation
- Event publishing

**Attendance Tests (Iyi):**
- Basic clock-in (scheduled/unscheduled)
- Employee validation (terminated, suspended)
- Double clock-in prevention
- GPS location tracking
- Offshore flag detection
- Transaction safety (rollback, release)
- Daily overview query

```
[L-3] FINDING: Leave Test Suite DataSource Mock Eksik
```
**Detay:** Leave test dosyasi handler'lari dogrudan repository mock'lari ile test eder ama gercek handler'lar `DataSource` ve `QueryRunner` kullaniyor. Test setup'inda `DataSource` provider'i yok - bu testlerin guncel handler implementasyonu ile uyumsuz olabilecegini gosterir. Testler muhtemelen handler refactor'u oncesinde yazilmis ve guncellenmemis.

```
[L-1] FINDING: Scheduling Modulu Integration Testleri Eksik
```
Scheduling modulu icin sadece service-level unit testleri var. Handler-level integration testleri (create weekly plan, publish, copy, bulk assign) eksik.

---

## 9. GraphQL API Design

### Federation v2
- `ApolloFederationDriver` ile subgraph
- `autoSchemaFile` ile schema generation
- `orphanedTypes` ile nested ObjectType'lar kayitli

### Query Design
- Pagination: `limit`/`offset` pattern (cursor-based degil)
- Filtreleme: inline `@Args` ile (InputType kullanimi sinirli)
- Self-service queries: `myLeaveBalances`, `myLeaveRequests` (her kullanici kendi verisi)
- Admin queries: `leaveRequests`, `employees` (TENANT_ADMIN/MODULE_MANAGER)

### Mutation Design
- CQRS CommandBus uzerinden
- Input validation DTO'larla
- Error handling: NestJS exception hierarchy (NotFoundException, BadRequestException, ForbiddenException)

### Security Controls
- Depth limit: 10
- Complexity limit: 1000
- Production'da introspection kapali
- Stacktrace temizligi

---

## 10. Event-Driven Architecture

### Published Events
| Event | Module | Trigger |
|-------|--------|---------|
| `LeaveRequestSubmitted` | Leave | Submit mutation |
| `LeaveApproved` | Leave | Approve mutation |
| `LeaveRejected` | Leave | Reject mutation |
| `LeaveCancelled` | Leave | Cancel mutation |
| `EmployeeClockedIn` | Attendance | Clock-in |
| `EmployeeClockedOut` | Attendance | Clock-out |
| `CertificationAdded` | Training | Add certification |
| `CertificationRevoked` | Training | Revoke certification |
| `TrainingCompleted` | Training | Complete training |

### Event Contract
- `@platform/event-contracts` ile tip-safe
- `createBaseEvent()` helper: eventId, eventType, tenantId, timestamp
- PascalCase event type convention

### Eksik Event'ler
- `EmployeeCreated`, `EmployeeUpdated`, `EmployeeTerminated` (knowledge base'de listelenmis ama handler'larda gorulmuyor)
- `CertificationExpiringSoon` (knowledge base'de listelenmis ama handler'da gorulmuyor)
- `PayrollApproved`, `PayrollCreated` - bordro event'leri yok

---

## 11. Recommendations

### Kritik (Hemen)

1. **[H-1] Payroll Floating-Point Fix:**
   - `Decimal.js` veya `big.js` kutuphanesi ekle
   - Tum parasal hesaplamalari decimal arithmetic ile yap
   - Veya en azindan: `Math.round(value * 100) / 100` uygula

2. **[H-3] Rotasyon Cakisma Kontrolu:**
   - Rotasyon olusturma handler'i implement et
   - Tarih cakisma kontrolu ekle
   - Work area capacity kontrolu ekle

3. **[M-1] Sertifika-Offshore Entegrasyonu:**
   - `CertificationExpiredEvent` handler'i: employee.seaWorthy = false
   - Clock-in handler'da offshore mandatory sertifika kontrolu
   - Cron job ile expired certification otomatik status gecisi

### Orta Vadeli

4. **[M-3] Payroll Self-Approval Engeli:**
   - `ApprovePayrollHandler`'a `createdBy !== userId` kontrolu ekle

5. **[M-4] Leave Resolver userId Fix:**
   - `myLeaveBalances` ve `myLeaveRequests` icin userId -> employeeId mapping
   - Veya handler'da userId ile employee lookup

6. **[L-2] SafetyTrainingRecord VersionColumn:**
   - Entity'ye `@VersionColumn()` ekle

7. **[H-2] Tenant Isolation:**
   - Per-request QueryRunner refactor'u planlama (platform-wide)

### Uzun Vadeli

8. **Test Coverage:**
   - Leave test suite'ini DataSource/QueryRunner mock'lari ile guncelle
   - Scheduling module integration testleri ekle
   - Payroll edge case testleri (floating-point, concurrent approval)

9. **Certification Enforcement Engine:**
   - Rule engine: work area'ya girmeden once tum required certifications kontrol et
   - Dashboard: compliance rate gosterimi
   - Alert sistemi: expiring certifications icin otomatik bildirim

10. **Leave Accrual Engine:**
    - Otomatik birikim (accrualRate * months since accrualStartAfterMonths)
    - Carry-over limit enforcement (maxCarryOverDays)
    - Year-end rollover batch process

---

## 12. Positive Observations

1. **Transaction Safety:** Tum write handler'lar QueryRunner transaction kullanir. Rollback ve release pattern'i tutarli.
2. **TOCTOU Prevention:** Leave balance check'inde pessimistic lock + DRAFT asamasinda pending artirimi.
3. **Timezone Handling:** IANA timezone per employee/record, UTC storage, lokal gosterim - dogru yaklasim.
4. **Aquaculture Domain Fit:** Offshore/onshore classification, safety training, work rotations, sea-worthiness - sektore ozel ihtiyaclar iyi modellenmmis.
5. **Security:** Sensitive field hiding, JWT-only auth, depth/complexity limits, SQL injection prevention.
6. **Audit Trail:** VersionColumn, createdBy/updatedBy, approval history JSONB, event publishing.
7. **Overnight Shift Support:** Clock-out handler'da dun kontrolu ve crossesMidnight flag.
8. **Conflict Detection:** Scheduling modulunde 6 farkli conflict tipi ile kapsamli dogrulama.
9. **Code Quality:** BeforeInsert hooks, sanitize methods, safe parsing, proper error handling.
10. **Index Strategy:** Composite indexes for common query patterns, unique constraints for business rules.
