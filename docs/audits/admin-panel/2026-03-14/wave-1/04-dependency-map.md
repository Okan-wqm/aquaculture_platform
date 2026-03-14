# P4: Bagimlilik Haritaci Raporu

**Tarih:** 2026-03-14
**Kapsam:** Admin Panel frontend (`web/modules/admin-panel`) + Admin API Service backend (`apps/admin-api-service`) dependency ve build analizi

---

## Yonetici Ozeti

Admin Panel frontend'i Vite + Module Federation ile build ediliyor, backend ise Nx + Webpack kullaniliyor. Bu mimari bilinçli ve dogru; iki farkli build pipeline farkli ihtiyaclara hizmet ediyor. Ancak birkac onemli bulgu tespit edildi:

1. **@tanstack/react-query**: package.json'da dependency ve MF shared singleton olarak tanimli, ancak kodda hicbir yerde import edilmiyor (sifir kullanim). Gereksiz bundle sismesi.
2. **zustand**: vite.config.ts'de shared singleton olarak tanimli ama ne package.json'da dependency ne de kodda import var. Phantom dependency.
3. **Bos placeholder dosyalar**: `bootstrap.tsx`, `App.tsx`, `webpack.config.js` tamamen bos.
4. **MF expose'lari**: 4 endpoint tanimli, sadece 1 tanesi (`./Module`) shell tarafindan fiilen lazy-import ediliyor.
5. **tailwind.config.js**: ESM + require() karisimi -- potansiyel build hatasi.

**Oncelik Sirasi:** zustand phantom > react-query dead dep > expose temizligi > tailwind config uyumu

---

## Dependency Analizi

### Production Dependencies (`dependencies`)

| Paket | Versiyon | Kullaniliyor mu | Nerede | Durum |
|-------|----------|-----------------|--------|-------|
| `@aquaculture/shared-ui` | `file:../../shared-ui` | EVET | 42+ dosya (components, hooks, utils) | OK |
| `@tanstack/react-query` | `^5.17.0` | **HAYIR** | Hicbir src/ dosyasinda import yok | KALDIR |
| `lucide-react` | `^0.294.0` | EVET | 7 dosya (MessagingPage, TicketsPage, AnnouncementsPage, OnboardingPage, ActivityLogPage, AuditTrailPage, CompliancePage) | OK |
| `react` | `^18.2.0` | EVET | 61 dosya | OK |
| `react-dom` | `^18.2.0` | EVET | main.tsx (createRoot) | OK |
| `react-router-dom` | `^6.21.0` | EVET | 16 dosya (Routes, Route, Navigate, useNavigate, useParams, useSearchParams) | OK |

### Dev Dependencies (`devDependencies`)

| Paket | Versiyon | Kullaniliyor mu | Nerede | Durum |
|-------|----------|-----------------|--------|-------|
| `@originjs/vite-plugin-federation` | `^1.3.5` | EVET | vite.config.ts | OK |
| `@types/react` | `^18.2.0` | EVET | TypeScript derleme | OK |
| `@types/react-dom` | `^18.2.0` | EVET | TypeScript derleme | OK |
| `@vitejs/plugin-react` | `^4.2.0` | EVET | vite.config.ts | OK |
| `autoprefixer` | `^10.4.16` | EVET | postcss.config.js | OK |
| `postcss` | `^8.4.32` | EVET | postcss.config.js | OK |
| `tailwindcss` | `^3.4.0` | EVET | tailwind.config.js | OK |
| `typescript` | `^5.3.0` | EVET | tsconfig.json | OK |
| `vite` | `^5.0.0` | EVET | vite.config.ts, scripts | OK |
| `vitest` | `^1.1.0` | EVET | 6 test dosyasi | OK |

### Phantom Dependencies (tanimli degil ama kullaniliyor veya referans ediliyor)

| Paket | Referans | Sorun |
|-------|----------|-------|
| `zustand` | vite.config.ts shared singleton (`requiredVersion: '^4.4.0'`) | package.json'da yok, kodda import yok. MF runtime'da shell'den saglanir ama explicit dependency tanimlanmali veya shared'den cikarilmali |

### Dependency-DevDependency Ayrimi Kontrolu

Genel olarak **dogru** ayrilmis. Build/dev araclari devDependencies'de, runtime kutuphaneleri dependencies'de. Tek sorun:
- `@tanstack/react-query` dependencies'de ama kullanilmiyor -- kaldirmak yeterli.
- `vitest` dogru olarak devDependencies'de.

---

## Module Federation Analizi

### Expose Listesi (admin-panel remote)

| Expose Key | Kaynak Dosya | Dosya Var mi | Shell'de Import | Durum |
|------------|-------------|-------------|-----------------|-------|
| `./Module` | `./src/Module.tsx` | EVET | `lazy(() => import('adminPanel/Module'))` in App.tsx | AKTIF KULLANIM |
| `./UserManagement` | `./src/pages/UserManagementPage.tsx` | EVET | Sadece type declaration (`remote-modules.d.ts`) | KULLANILMIYOR |
| `./TenantManagement` | `./src/pages/TenantManagementPage.tsx` | EVET | Sadece type declaration (`remote-modules.d.ts`) | KULLANILMIYOR |
| `./SystemSettings` | `./src/pages/SystemSettingsPage.tsx` | EVET | Sadece type declaration (`remote-modules.d.ts`) | KULLANILMIYOR |

**Yorum:** Shell yalnizca `adminPanel/Module`'u lazy-import ediyor. `./Module` zaten kendi icinde Routes ile UserManagement, TenantManagement, SystemSettings sayfalarini icerir. Diger 3 expose endpoint'i shell'de hic kullanilmiyor -- bunlar muhtemelen gelecekte bagımsız sayfa olarak yuklenmek icin planlanmis ama su an dead code. Bundle boyutunu gereksiz artiriyor cunku her biri icin ayri chunk uretiliyor.

### Shared Singleton Karsilastirmasi (admin-panel vs shell)

| Paket | Admin Panel | Shell | Uyumlu mu | Not |
|-------|------------|-------|-----------|-----|
| `react` | `singleton: true, ^18.2.0` | `singleton: true, ^18.2.0` | EVET | |
| `react-dom` | `singleton: true, ^18.2.0` | `singleton: true, ^18.2.0` | EVET | |
| `react-router-dom` | `singleton: true, ^6.21.0` | `singleton: true, ^6.21.0` | EVET | |
| `@tanstack/react-query` | `singleton: true, ^5.17.0` | `singleton: true, ^5.17.0` | EVET | Admin panel'de kullanilmiyor ama shared'de var |
| `@aquaculture/shared-ui` | `singleton: true, import: true` | `singleton: true, ^1.0.0` | UYARI | Admin `import: true` + version yok, Shell `^1.0.0`. `import: true` modulu cift yukleyebilir |
| `zustand` | `singleton: true, ^4.4.0` | `singleton: true, ^4.4.0` | EVET | Admin'de package.json'da ve kodda yok |
| `use-sync-external-store` | - | `singleton: true` | N/A | Sadece shell'de |
| `reactflow` | - | `singleton: true, 11.11.4` | N/A | Sadece shell'de |

**Kritik Bulgu:** `@aquaculture/shared-ui` icin admin-panel `import: true` kullanirken shell'de yok. Bu, Module Federation'da module'un hem host hem remote tarafindan yuklenip duplike olmasina yol acabilir.

---

## Build Konfigurasyonu

### Frontend: Vite

- **Build tool:** Vite 5.x + `@vitejs/plugin-react` + `@originjs/vite-plugin-federation`
- **Target:** `esnext` (modern browsers only)
- **Base path:** `/remotes/admin-panel/` (MEMORY.md'deki pattern ile uyumlu)
- **Dev server:** Port 3004, CORS enabled, strictPort
- **Alias'lar:**
  - `@` -> `src/`
  - `@aquaculture/shared-ui` -> `../../shared-ui/dist`
  - `@platform/shared-ui` -> `../../shared-ui/src`

**Sorun:** `@aquaculture/shared-ui` alias'i `dist`'e isaret ediyor (build ciktisi), `@platform/shared-ui` ise `src`'ye isaret ediyor. `adminApi.ts` dosyasi `@platform/shared-ui/utils/api-client` seklinde import yapiyor -- bu yalnizca source'dan direkt import, dist build'den degil. Tutarsiz ama calisiyor cunku Vite her iki alias'i da çözüyor.

### Backend: Nx + Webpack

- **Build tool:** `@nx/webpack:webpack` (project.json)
- **webpack.config.js:** Minimal `composePlugins(withNx())` wrapper -- bos degil, Nx'in standart NestJS backend config'i
- **Compiler:** `tsc`
- **Target:** Node.js
- **Output:** `dist/apps/admin-api-service`

### Frontend vs Backend Build Tool Tutarsizligi

| | Frontend | Backend |
|---|---------|---------|
| Build Tool | Vite 5 | Nx Webpack |
| Config | vite.config.ts | project.json + webpack.config.js |
| Target | Browser (esnext) | Node.js |
| Sorun mu? | **HAYIR** | **HAYIR** |

**Yorum:** Bu tutarsizlik **bilinçli ve dogru**. Frontend MFE'ler Vite ile build edilir (HMR, ESM native), backend NestJS servisleri Nx monorepo icerisinde Webpack ile build edilir. Farkli runtime'lar farkli build araclari gerektirir.

### TypeScript Konfigurasyonu

- **strict: true** -- ACIK (iyi)
- **noUnusedLocals: false** -- Dead code uyarilari KAPALI
- **noUnusedParameters: false** -- Kullanilmayan parametre uyarilari KAPALI
- **Target:** ES2020
- **Module:** ESNext (bundler moduleResolution)
- **skipLibCheck: true** -- Kütüphane .d.ts kontrolleri atlanir (build performansi icin standart)

**Oneri:** `noUnusedLocals` ve `noUnusedParameters` true yapilirsa dead code tespiti derleme zamaninda yapilir.

### Tailwind + PostCSS Konfigurasyonu

- **tailwind.config.js:** `export default` (ESM syntax) kullanirken `require()` (CJS syntax) ile preset yukluyor
- **postcss.config.js:** ESM syntax, standart config

**BUG:** `tailwind.config.js` satirinda `require('../../shared-ui/tailwind.config.js')` var. Dosya `export default` ile ESM modulu olarak tanimlanmis ama `require()` CJS'dir. package.json'da `"type": "module"` var, bu durumda `require()` calismayabilir veya Vite bundler tarafindan cozulebilir. Potansiyel build hatasi.

---

## Legacy / Placeholder Dosyalar

| Dosya | Icerik | Durum |
|-------|--------|-------|
| `bootstrap.tsx` | Tamamen bos (0 byte) | LEGACY PLACEHOLDER -- Module Federation async bootstrap pattern icin olusturulmus ama kullanilmiyor. `main.tsx` dogrudan render yapiyor. |
| `App.tsx` | Tamamen bos (0 byte) | LEGACY PLACEHOLDER -- Module.tsx tum routing'i kendisi yapiyor. |
| `routes.tsx` | `// Routes are defined in Module.tsx directly. This file is intentionally empty. (BUG-016)` | DOKUMANTE EDILMIS PLACEHOLDER -- BUG-016 referansi ile. |
| `webpack.config.js` (admin-panel) | Tamamen bos (0 byte) | LEGACY PLACEHOLDER -- Muhtemelen backend ile ayni pattern icin olusturulmus. Frontend Vite kullaniyor, bu dosya gereksiz. |

**Etki:** Bu 4 dosya build'i bozmuyor ama kod tabaninda karmasiklik yaratiyor. Yeni gelistiriciler icin yaniltici.

---

## Bulgular

### KRITIK

| # | Bulgu | Etki | Aksiyon |
|---|-------|------|---------|
| DEP-01 | `@tanstack/react-query` package.json + MF shared'de tanimli ama kodda 0 import | Gereksiz bundle boyutu (~40KB gzipped), MF shared negotiation overhead | `dependencies`'den kaldir, `shared` singleton'dan kaldir |
| DEP-02 | `zustand` MF shared singleton tanimli ama ne package.json'da ne kodda var | MF runtime'da phantom shared module negotiation, hata potansiyeli | `shared`'den kaldir veya package.json'a ekle (eger gelecekte kullanilacaksa) |
| DEP-03 | `@aquaculture/shared-ui` shared config'de admin `import: true` vs shell yok | Potansiyel duplike yukleme, memory waste | Her iki tarafta da ayni config kullanilmali |

### ORTA

| # | Bulgu | Etki | Aksiyon |
|---|-------|------|---------|
| DEP-04 | 3/4 MF expose endpoint'i (`./UserManagement`, `./TenantManagement`, `./SystemSettings`) shell'de kullanilmiyor | Her biri icin ayri chunk uretiliyor, build suresi ve output boyutu artisi | Expose'lardan kaldir veya shell'de lazy import ekle |
| DEP-05 | `tailwind.config.js` ESM + CJS karisimi (`export default` + `require()`) | Bazi ortamlarda build hatasi verebilir | `require()` yerine dynamic `import()` veya preset'i inline tanimla |
| DEP-06 | `noUnusedLocals: false` + `noUnusedParameters: false` | Dead code tespiti derleme zamaninda yapilmiyor | `true` yap, dead code'u temizle |

### DUSUK

| # | Bulgu | Etki | Aksiyon |
|---|-------|------|---------|
| DEP-07 | 4 bos/placeholder dosya (bootstrap.tsx, App.tsx, routes.tsx, webpack.config.js) | Karmasiklik, yaniltici | Sil veya amacini README'de dokumante et |
| DEP-08 | Alias tutarsizligi: `@aquaculture/shared-ui` -> `dist`, `@platform/shared-ui` -> `src` | Calisiyor ama iki farkli import path ayni kutuphaneden farkli kaynaklara isaret ediyor | Tek bir alias'a birlestirilmeli |

---

## Spawn Talepleri

Bu rapor yalnizca arastirma amaclidir. Asagidaki duzeltmeler icin ayri gorevler acilmalidir:

1. **DEP-01 + DEP-02 Fix:** `@tanstack/react-query` ve `zustand` temizligi -- package.json ve vite.config.ts shared guncellemesi
2. **DEP-03 Fix:** `@aquaculture/shared-ui` MF shared config'ini shell ve admin-panel arasinda hizala
3. **DEP-04 Review:** Kullanilmayan MF expose endpoint'lerini kaldir veya shell'de aktif et
4. **DEP-05 Fix:** tailwind.config.js'deki ESM/CJS karisimini duzelt
5. **DEP-07 Cleanup:** Bos placeholder dosyalari sil

---

## Ek: Dosya Referans Haritasi

```
web/modules/admin-panel/
  package.json              -- 6 prod dep, 11 dev dep
  vite.config.ts            -- MF remote config, 4 expose, 6 shared singleton
  webpack.config.js         -- BOS (legacy placeholder)
  tsconfig.json             -- strict: true, ES2020 target
  tsconfig.node.json        -- vite.config.ts icin composite config
  tailwind.config.js        -- shared-ui preset, ESM+CJS karisimi
  postcss.config.js         -- tailwindcss + autoprefixer
  index.html                -- Vite entry HTML
  src/
    main.tsx                -- Standalone entry point (dev mode)
    bootstrap.tsx           -- BOS
    App.tsx                 -- BOS
    routes.tsx              -- Bos, BUG-016 notu
    Module.tsx              -- MF expose root, 30+ sayfa route
    styles.css              -- Tailwind directives
    services/adminApi.ts    -- HTTP client, tum backend endpoint'leri
    components/             -- AdminLayout, AdminSidebar, database/*, AlertRuleBuilder/*
    hooks/                  -- useAsyncData, usePagination, useFilters, useUserPermissions
    pages/                  -- 30+ sayfa (admin dashboard, tenant, user, billing, security, system)
      security/             -- ActivityLog, AuditTrail, Compliance, SecurityDashboard
      system/               -- FeatureToggles, Maintenance, Performance, ErrorTracking, JobQueue, Impersonation, DebugTools
      __tests__/            -- 2 spec dosyasi

apps/admin-api-service/
  project.json              -- Nx config, @nx/webpack:webpack executor
  webpack.config.js         -- Minimal Nx wrapper (composePlugins + withNx)
  src/                      -- NestJS backend (modules, controllers, services, entities)
```
