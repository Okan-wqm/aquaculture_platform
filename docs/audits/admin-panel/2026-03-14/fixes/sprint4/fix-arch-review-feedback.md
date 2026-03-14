# Sprint 4 - Mimari Review Feedback Fixleri

**Tarih:** 2026-03-14
**Scope:** Admin Panel frontend + Admin API Service backend

---

## 1. settings.ts Decomposition (246 -> ~180 satir + 2 yeni dosya)

**Sorun:** `settings.ts` 11 domain iceriyordu (system settings, tenant config, email templates, IP access, feature toggles, maintenance, provisioning, performance, errors, jobs). Single Responsibility ilkesine aykiri.

**Fix:**
- `api/tenant-config.ts` olusturuldu -- `tenantConfigApi` (7 metod: getTenantConfig, updateTenantConfig, createTenantApiKey, revokeTenantApiKey, createWebhook, deleteWebhook, testWebhook)
- `api/email-templates.ts` olusturuldu -- `emailTemplatesApi` (8 metod: getEmailTemplates, getEmailTemplate, getEmailTemplateByCode, createEmailTemplate, updateEmailTemplate, deleteEmailTemplate, previewEmailTemplate, sendTestEmail)
- `settings.ts` icindeki ilgili metodlar cikarildi, yerine delegasyon konuldu (`tenantConfigApi.getTenantConfig` seklinde)
- **Geriye uyumluluk korundu:** `settingsApi.getTenantConfig(...)` ve `settingsApi.getEmailTemplates(...)` gibi mevcut cagrilar calismaya devam ediyor

**Degisen dosyalar:**
- `web/modules/admin-panel/src/services/api/settings.ts` -- import'lar azaltildi, delegasyon eklendi
- `web/modules/admin-panel/src/services/api/tenant-config.ts` -- YENI
- `web/modules/admin-panel/src/services/api/email-templates.ts` -- YENI
- `web/modules/admin-panel/src/services/adminApi.ts` -- barrel guncellendi

---

## 2. AnalyzeQueryDto Validation Dekoratorleri

**Sorun:** `AnalyzeQueryDto` class'inda `query` ve `schemaName` property'lerinde validation dekoratorleri eksikti. NestJS ValidationPipe aktif olsa bile bu DTO uzerinde tur ve bosluk kontrolu yapilmiyordu.

**Fix:**
- `query` property'sine `@IsString()` ve `@IsNotEmpty()` eklendi
- `schemaName` property'sine `@IsOptional()` ve `@IsString()` eklendi
- `class-validator` import'u guncellendi

**Degisen dosya:**
- `apps/admin-api-service/src/database-management/controllers/monitoring.controller.ts`

---

## 3. adminApi.ts Gereksiz Default Export Kaldirildi

**Sorun:** `adminApi.ts` barrel dosyasi hem named export'lar hem de ayni icerikle bir `export default {...}` sunuyordu. Codebase taramasi hicbir consumer'in default import kullanmadigini gosteriyor (tumu `import { settingsApi } from '../services/adminApi'` seklinde named import kullaniyor). Default export:
- Tree-shaking'i engeller (tum API modulleri tek nesneye baglanir)
- Ayni import'lari tekrar gerektirir (16 satir duplikasyon)
- Namespace-style kullanim icin gereksiz cunku zaten named export'lar var

**Fix:**
- `export default {...}` blogu ve ona ait 14 satir import tamamen kaldirildi
- Named export'lar aynen korundu
- `tenantConfigApi` ve `emailTemplatesApi` barrel'a eklendi

**Degisen dosya:**
- `web/modules/admin-panel/src/services/adminApi.ts`

---

## Etkilenen Consumer Dosyalari

Hicbir consumer dosyasina dokunulmadi. Asagidaki dosyalar geriye uyumluluk sayesinde degisiklik gerektirmez:

| Consumer | Import | Durum |
|---|---|---|
| `TenantConfigurationPage.tsx` | `settingsApi.getTenantConfig` | Delegasyon ile calisiyor |
| `EmailTemplatesPage.tsx` | `settingsApi.getEmailTemplates/updateEmailTemplate` | Delegasyon ile calisiyor |
| `IpAccessRulesPage.tsx` | `settingsApi.getIpAccessRules` | Dogrudan settings.ts'de kaldi |
| `SystemSettingsPage.tsx` | `settingsApi` | Dogrudan settings.ts'de kaldi |
| Tum diger consumer'lar | Named import | Default export kullanmiyorlardi |
