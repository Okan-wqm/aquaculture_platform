# Grup Y - Frontend-Backend Kontrat Test Altyapisi

**Bulgu:** H12/46 - Frontend-backend kontrat testi altyapisi
**Sorun:** 3 FIELD_MISMATCH production'da 400/404 uretiyordu ama CI/CD yakalayamiyordu
**Tarih:** 2026-03-14
**Durum:** TAMAMLANDI

## Ozet

Admin-panel frontend'inin cagirdigi API endpoint'leri ile admin-api-service backend'inin sundugu endpoint'ler arasindaki uyumu otomatik dogrulayan test altyapisi kuruldu.

## Dosya

```
apps/admin-api-service/src/__tests__/contract-validation.spec.ts
```

## Yaklasim

Statik analiz tabanli, CI/CD'de calisabilir, external dependency gerektirmeyen bir cozum secildi:

### 1. Frontend URL Extraction
- `web/modules/admin-panel/src/services/api/*.ts` dosyalari (14 adet) parse edilir
- `apiFetch<T>('/path')` ve `apiFetch<T>(\`/path/${var}\`)` cagrilarindaki URL pattern'leri cikarilir
- Template literal parametreleri (${variable}) `:param` formatina normalize edilir
- Query string'ler (?...) kaldirilir
- HTTP method: `{ method: 'POST' }` gibi options'dan cikarilir, varsayilan GET

### 2. Backend Endpoint Extraction
- `apps/admin-api-service/src/**/*.controller.ts` dosyalari recursive taranir
- `@Controller('prefix')` dekoratoru ile controller prefix cikarilir
- `@Get('sub')`, `@Post('sub')`, `@Put('sub')`, `@Patch('sub')`, `@Delete('sub')` dekoratorleri ile handler path'leri cikarilir
- Full path: `/prefix/sub` olarak birlestirilir

### 3. Eslesme Algoritmasi
- Path segment bazli karsilastirma yapilir
- `:param` (frontend) ve `:id` (backend) gibi parametre segmentleri birbiriyle eslestirilebilir
- PATCH/PUT uyumlulugu saglanir (frontend PUT, backend PATCH veya tersi)

## Test Yapisi

### Domain Bazli Kontrat Testleri
Her API domain'i icin ayri test:
- `/system/*` - System Metrics
- `/analytics/*` - Analytics
- `/tenants/*` - Tenants
- `/users/*` - Users
- `/modules/*` - Modules
- `/audit-logs/*` - Audit Logs
- `/billing/*` - Billing
- `/reports/*` - Reports
- `/support/*` - Support (Tickets, Messaging, Announcements, Onboarding)
- `/settings/*` - Settings (System, Email Templates, IP Access, Tenant Config)
- `/impersonation/*` - Impersonation
- `/debug/*` - Debug Tools
- `/security/*` - Security (Activities, Audit Trail, Compliance, Monitoring)
- `/health/*` - Health
- `/database/*` - Database Management

### H12 Kritik Path Testleri
Daha once FIELD_MISMATCH ureten 3 endpoint icin ozel testler:
1. `GET /settings/key/:key` - H19 fix'inden sonra dogru path
2. `POST /support/announcements/:id/cancel` - H18 fix'inden sonra unpublish -> cancel
3. `POST /impersonation/sessions/:id/terminate` - H21 fix'inden sonra revoke -> terminate

### Snapshot Testleri
- Backend endpoint sayisi 200-500 arasinda olmali
- Frontend endpoint sayisi 150-500 arasinda olmali
- Beklenmedik ekleme/silme durumlarini yakalar

### Method Mismatch Testi
- Ayni path'e sahip ama farkli HTTP method kullanan endpoint'leri tespit eder
- PATCH/PUT uyumlulugu otomatik saglanir

## Bilinen Istisnalar

Test'te `KNOWN_EXCEPTIONS` listesi var. Bu liste, frontend'de var ama backend controller'da dogrudan karsiligi olmayan endpoint'leri icerir:
- Performance monitoring, error tracking, job queue yonetimi (henuz controller'lari yok)
- Frontend alias'lari (ornegin /database/monitoring/stats -> /database/monitoring/health)
- Path farkli ama ayni islevi goren endpoint'ler

Her istisna icin neden aciklamasi mevcuttur.

## CI/CD Entegrasyonu

Test, mevcut Jest altyapisini kullanir. Ek dependency gerektirmez.

```bash
npx jest --testPathPattern="contract-validation"
```

Veya projenin mevcut test komutu ile:
```bash
npx nx test admin-api-service --testPathPattern="contract-validation"
```

## Bakim Kurallari

1. **Yeni endpoint eklendiginde:** Frontend'e yeni apiFetch cagrisi eklendiginde test otomatik yakalanir. Backend controller'a karsilik eklenmelidir.
2. **Endpoint path degistiginde:** Test kirilir. Her iki taraf (frontend + backend) guncellenmeli.
3. **Bilinen istisnalar:** Eger bir frontend endpoint'in backend karsiligi henuz yoksa veya farkli bir pattern kullaniyorsa, `KNOWN_EXCEPTIONS` listesine neden ile eklenir.
4. **Snapshot araliklari:** Endpoint sayisi belirgin sekilde artarsa veya azalirsa snapshot test sinirlari guncellenmeli.

## Tespit Edilen ve Daha Once Duzeltilmis Uyumsuzluklar

| Frontend Path | Eski Backend Path | Duzeltilmis Path | Fix |
|---|---|---|---|
| `/settings/key/:key` | `/settings/:key` | `/settings/key/:key` | H19 |
| `/support/announcements/:id/cancel` | `/support/announcements/:id/unpublish` | `/support/announcements/:id/cancel` | H18 |
| `/impersonation/sessions/:id/terminate` | `/impersonation/sessions/:id/revoke` | `/impersonation/sessions/:id/terminate` | H21 |
