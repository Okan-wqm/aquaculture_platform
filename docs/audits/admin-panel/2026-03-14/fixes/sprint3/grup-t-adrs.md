# Grup T -- Mimari Karar Dokumanlari (ADR)

**Tarih:** 2026-03-14
**Bulgu:** 47/M1 -- ADR'ler eksik (CQRS, guard stratejisi, stil tercihi, data fetch pattern)
**Durum:** Tamamlandi

---

## Yazilan ADR'ler

### ADR-007: CQRS Kullanim Stratejisi
**Dosya:** `docs/adr/007-cqrs-usage-strategy.md`

Koddan elde edilen gercek durum:
- admin-api-service: Sadece tenant modulu CQRS kullaniyor (6 command, 8 query handler)
- hr-service: 7 alt modulde aktif CQRS (hr, attendance, leave, training, scheduling, aquaculture)
- farm-service: CqrsModule 19 submodulde import edilmis ama handler kullanimi sinirli (equipment)
- sensor-service, alert-engine: CQRS yok

**Karar:** CQRS platform genelinde zorunlu degil. Her servis kendi domain karmasikligina gore secer. Varsayilan pattern Controller -> Service.

---

### ADR-008: Guard Stratejisi -- Defense in Depth
**Dosya:** `docs/adr/008-guard-strategy-defense-in-depth.md`

Koddan elde edilen gercek durum:
- `APP_GUARD` olarak `PlatformAdminGuard` global registered (app.module.ts)
- 31 controller'in tamaminda ayrica `@UseGuards(PlatformAdminGuard)` decorator mevcut
- Sprint 1'de tum controller'lara explicit guard eklendi

**Karar:** Iki katman birlikte calisir. Global guard baseline koruma, explicit decorator kod seviyesinde gorunurluk saglar.

---

### ADR-009: Frontend Data Fetch Pattern
**Dosya:** `docs/adr/009-frontend-data-fetch-pattern.md`

Koddan elde edilen gercek durum:
- adminApi decompose edildi (H9 fix): 14 domain-specific modul (`api/tenants.ts`, `api/billing.ts`, vb.)
- `useAsyncData` hook: LRU cache (max 100, 30s TTL), abort/timeout, ref-stabilized callbacks
- Barrel export (`services/adminApi.ts`) geriye donuk uyumluluk sagliyor
- 20+ sayfa standardize edilmis pattern kullaniyor

**Karar:** Tek standart: decomposed adminApi + useAsyncData. Dogrudan fetch() yasak.

---

### ADR-010: Frontend Stil Stratejisi
**Dosya:** `docs/adr/010-frontend-styling-strategy.md`

Koddan elde edilen gercek durum:
- Tailwind CSS: tailwind.config.js + postcss.config.js konfigurasyonu mevcut
- Inline CSS-in-JS (`style={{ }}`): 13 dosyada hala var (QueryEditor, FeatureTogglesPage, SecurityDashboardPage, vb.)
- Inline stiller cogunlukla dinamik degerler icin (chart boyutlari, hesaplanmis genislikler)

**Karar:** Tailwind CSS tek standart. Mevcut 13 dosyadaki inline stiller teknik borc olarak kabul edildi.

---

## Notlar

- ADR numaralari mevcut seriyi takip ediyor (001-006 zaten vardi)
- Her ADR koddan dogrulanan gercek durumu yansitir, ideal durumu degil
- CQRS ADR'i orijinal briefing'den farkli: Sadece tenant degil, hr-service ve farm-service'te de CQRS kullanimi var. ADR bu gercekligi yansitir.
