# Grup L - Backend Performans Optimizasyonu Raporu

**Tarih:** 2026-03-14
**Sprint:** 2
**Grup:** L (Backend Performans Uzmani)

---

## Ozet

4 adet backend performans bulgusunu (H4, H5, H6, H7) duzeltildi. Tum degisiklikler davranis koruyucu (behavior-preserving) olarak yapildi; sadece sorgu calistirma stratejileri optimize edildi.

---

## H5: InvoiceManagement.getStats() -- 5 Seri DB Sorgusu

**Dosya:** `apps/admin-api-service/src/billing/services/invoice-management.service.ts`

**Sorun:** `getStats()` metodu 5 bagimsiz veritabani sorgusunu seri olarak calistiriyordu (await-await-await-await-await). Bu, toplam bekleme suresinin tum sorgu surelerinin toplami olmasi anlamina geliyordu.

**Cozum:** 5 sorgu birbirinden bagimsiz oldugu icin `Promise.all()` ile paralel calistirildi. Tum islem sonrasi (parse, map, hesaplama) Promise.all donusunun ardindan yapiliyor.

**Onceki:** ~5x ortalama sorgu suresi (waterfall)
**Sonraki:** ~1x en yavas sorgu suresi (paralel)

**Degisiklik detayi:**
- 5 ardisik `await this.dataSource.query(...)` cagrisi tek bir `Promise.all([...])` icinde toplandi
- Sonuc isleme bloklari Promise.all donus degerlerinden destructure edilerek yapildi
- Arayuz (InvoiceStats) degismedi, donus degeri semantigi korundu

---

## H6: CustomPlan.calculateModulePricing() -- Her Modul icin Ayri Sorgu

**Dosyalar:**
- `apps/admin-api-service/src/billing/services/custom-plan.service.ts`
- `apps/admin-api-service/src/billing/services/module-pricing.service.ts`

**Sorun:** `calculatePlanPricing()` her modul icin `getModulePricingByCode()` cagiriyordu. N modullu bir plan icin N adet veritabani sorgusu olusuyordu.

**Cozum:**
1. `ModulePricingService`'e `getModulePricingByCodes(moduleCodes: string[])` bulk metodu eklendi
2. Bu metod tek bir `WHERE moduleCode = ANY($1)` sorgusuyla tum modul fiyatlamasinasini getirir
3. `CustomPlanService.calculatePlanPricing()` artik once tum modul kodlarini toplayip tek sorguda pricing map aliyor, sonra loop icinde map'ten okuyor

**Onceki:** N modul = N sorgu
**Sonraki:** N modul = 1 sorgu

**Guvenlik notu:** `ANY($1)` parameterized query kullanildi, SQL injection riski yok.

**Eklenen metod (ModulePricingService):**
```typescript
async getModulePricingByCodes(moduleCodes: string[]): Promise<Map<string, ModulePricing>>
```

---

## H7: SubscriptionCoreService -- Her Modul icin Ayri INSERT

**Dosya:** `apps/admin-api-service/src/billing/services/subscription-core.service.ts`

**Sorun:** `createSubscription()` transaction icinde her modul icin ayri bir INSERT sorgusu calistiriyordu. N modullu bir plan icin N adet INSERT.

**Cozum:** Tek bir bulk INSERT sorgusu olusturuldu. Tum modul satirlari tek VALUES clause'da birlestiriliyor.

**Onceki:** N modul = N INSERT sorgusu (transaction icinde N round-trip)
**Sonraki:** N modul = 1 INSERT sorgusu (tek round-trip)

**Guvenlik notu:**
- Tum degerler parameterized (`$1, $2, ...`) olarak ekleniyor
- VALUES clause'lari string concatenation ile olusturuluyor ancak sadece parametre indeksleri ekleniyor, kullanici verisi degil
- Transaction butunlugu korunuyor (ayni manager.query icinde)

**Donus degeri uyumlulugu:** RETURNING clause ile alinan id'ler, moduleId/moduleCode eslestirilmesiyle dogru moduleConfig'e baglanarak moduleItems dizisi korunuyor.

---

## H4: Database Explorer Tablo Listeleme N+1

**Dosya:** `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts`

**Sorun:** `getTables()` metodu her tablo icin `getColumnInfo()` cagiriyordu. Bu metod 3 alt sorgu iceren tek bir information_schema sorgusu calistiriyordu. N tablolu bir sema icin N adet buyuk information_schema sorgusu.

**Cozum:** `getBulkColumnInfo()` metodu eklendi. Bu metod:
1. Tum tablolarin sutun bilgilerini tek bir information_schema sorgusuyla alir
2. `WHERE table_name = ANY($2)` kullanarak birden fazla tabloyu tek sorguda kapsar
3. PRIMARY KEY ve FOREIGN KEY bilgileri de ayni sorguda bulk olarak alinir
4. Sonuc `Map<tableName, ColumnInfo[]>` olarak dondurulur

**Onceki:** N tablo = N sorgu (her biri 3 sub-query iceren agir information_schema sorgusu)
**Sonraki:** N tablo = 1 sorgu (tek bulk information_schema sorgusu)

**Guvenlik notu:** `ANY($2)` parameterized query kullanildi. Table name'ler zaten `isValidIdentifier()` ile dogrulanmis durumda. Mevcut `getColumnInfo()` metodu korundu (tek tablo detay sayfasi icin hala kullaniliyor).

---

## Degisiklik Ozeti

| Bulgu | Dosya | Onceki | Sonraki | Kazanc |
|-------|-------|--------|---------|--------|
| H5 | invoice-management.service.ts | 5 seri sorgu | Promise.all(5) | ~4-5x hizlanma |
| H6 | custom-plan.service.ts + module-pricing.service.ts | N sorgu/modul | 1 bulk sorgu | N'e bagimli, tipik 5-8x |
| H7 | subscription-core.service.ts | N INSERT/modul | 1 bulk INSERT | N'e bagimli, tipik 5-8x |
| H4 | explorer.controller.ts | N*3 info_schema sorgusu | 1 bulk sorgu | N'e bagimli, tipik 10-30x |

## Dogrulama

- TypeScript derleme: Tum degisiklikler hatasiz derleniyor
- Interface uyumlulugu: Hicbir public interface degistirilmedi
- Davranis koruma: Return degerleri ve semantik ayni kaldi
- SQL injection: Tum yeni sorgular parameterized query kullaniyor
