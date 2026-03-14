# D14 -- Shell (Host) Module Federation Orchestration Audit

**Auditor:** Micro-Frontend Orkestrasyon Uzmani (D14)
**Tarih:** 2026-03-14
**Kapsam:** `web/shell/` host uygulamasi, Module Federation runtime, auth integration, RBAC, layout, guvenlik
**Oncelik Notasyonu:** CRITICAL > HIGH > MEDIUM > LOW > INFO

---

## 1. Executive Summary

Shell uygulamasi `@originjs/vite-plugin-federation` ile 7 remote microfrontend'i orkestre eden host gorevinde. Mimari olarak dogru kararlar alinmis: singleton shared dependencies, lazy loading ile code splitting, per-module ErrorBoundary, ve `remoteIntegrity.ts` ile script origin allowlist guard. Ancak CSP politikasinda `'unsafe-inline'` kullanimi, SRI hash pinning'in uygulanmamis olmasi, tenant-bazli runtime branding eksikligi ve bazi RBAC bosluklari tespit edildi.

**Toplam Bulgu:** 21
- CRITICAL: 2
- HIGH: 5
- MEDIUM: 7
- LOW: 5
- INFO: 2

---

## 2. Module Federation Host Configuration

### 2.1 Remote Tanimlari

**Dosya:** `web/shell/vite.config.ts` (satir 21-31)

| Remote Alias         | Dev URL                                        | Prod URL                                    |
|----------------------|------------------------------------------------|---------------------------------------------|
| `dashboard`          | `http://localhost:8080/mf/dashboard/assets/remoteEntry.js`  | `/remotes/dashboard/assets/remoteEntry.js`  |
| `farmModule`         | `http://localhost:8080/mf/farm-module/assets/remoteEntry.js`| `/remotes/farm-module/assets/remoteEntry.js`|
| `hrModule`           | `http://localhost:8080/mf/hr-module/assets/remoteEntry.js`  | `/remotes/hr-module/assets/remoteEntry.js`  |
| `sensorModule`       | `http://localhost:8080/mf/sensor-module/assets/remoteEntry.js`| `/remotes/sensor-module/assets/remoteEntry.js`|
| `hydroponicsModule`  | `http://localhost:8080/mf/hydroponics-module/assets/remoteEntry.js`| `/remotes/hydroponics-module/assets/remoteEntry.js`|
| `adminPanel`         | `http://localhost:8080/mf/admin-panel/assets/remoteEntry.js`| `/remotes/admin-panel/assets/remoteEntry.js`|
| `tenantAdmin`        | `http://localhost:8080/mf/tenant-admin/assets/remoteEntry.js`| `/remotes/tenant-admin/assets/remoteEntry.js`|

**Prod path convention:** `/remotes/{module-name}/assets/remoteEntry.js`
**Dev path convention:** `http://localhost:8080/mf/{module-name}/assets/remoteEntry.js`

Dev ortaminda `/mf/` prefix ile nginx proxy kullanilirken, prod ortaminda `/remotes/` prefix ile ayri nginx lokasyonlari tanimlanmis. Her iki path seti de `nginx/nginx.conf` icerisinde upstream tanimlarina yonlendiriliyor.

### 2.2 Shared Singleton Dependencies

```
react:              ^18.2.0   singleton
react-dom:          ^18.2.0   singleton
react-router-dom:   ^6.21.0   singleton
@tanstack/react-query: ^5.17.0 singleton
@aquaculture/shared-ui: ^1.0.0 singleton
zustand:            ^4.4.0    singleton
use-sync-external-store: (any) singleton
reactflow:          11.11.4   singleton (version pinned)
```

### 2.3 Bulgu Tablosu -- MF Config

| ID | Seviye | Bulgu | Detay |
|----|--------|-------|-------|
| D14-MF-01 | MEDIUM | Dev/prod path mismatch nginx.prod.conf'ta | `nginx.prod.conf` sadece `/mf/` path'lerini tanimliyor, `/remotes/` path'leri yok. Prod build'in `/remotes/` prefix kullandigi halde prod nginx config'inde karsiligi yok -- bu deployment'i `nginx/nginx.conf` (docker-compose dev) dosyasina bagimli kiliyor. |
| D14-MF-02 | LOW | reactflow version mismatch | Host `11.11.4` pin'liyor, sensorModule `^11.10.0` istiyor. Vite MF singleton mode'da host versiyonunu kullanir ama requiredVersion uyumsuzlugu konsol uyarisi uretir. |
| D14-MF-03 | LOW | `@tanstack/react-query` host'ta shared ama bazi remote'larda yok | Dashboard remote'unda react-query shared listesinde yok, host'ta var. Singleton negotiation sirasinda host versiyonu kullanilir ama remote re-export etmez -- calisir ancak bundle boyutu artabilir. |
| D14-MF-04 | INFO | `module-federation.config.js` bos dosya | Legacy dosya, Vite config icinde inline yapilmis. Temizlik onerisi. |

---

## 3. Route Yapisi ve Remote Module Eslestirme

**Dosya:** `web/shell/src/App.tsx`

### 3.1 Route -> Remote Mapping

| Route Pattern     | Remote Module        | Lazy Import                    | RBAC Guard          |
|-------------------|----------------------|--------------------------------|---------------------|
| `/login`          | --                   | LoginPage (local)              | Public              |
| `/forgot-password`| --                   | LoginPage (local)              | Public              |
| `/reset-password/:token`| --            | LoginPage (local)              | Public              |
| `/accept-invitation/:token`| --         | LoginPage (local)              | Public              |
| `/`               | --                   | RoleBasedRedirect (local)      | ProtectedRoute      |
| `/dashboard/*`    | `dashboard/Module`   | `lazy(() => import(...))`      | ProtectedRoute (any auth user) |
| `/sites/*`        | `farmModule/Module`  | `lazy(() => import(...))`      | ProtectedRoute (any auth user) |
| `/hr/*`           | `hrModule/Module`    | `lazy(() => import(...))`      | ProtectedRoute (any auth user) |
| `/sensor/*`       | `sensorModule/Module`| `lazy(() => import(...))`      | ProtectedRoute (any auth user) |
| `/hydroponics/*`  | `hydroponicsModule/Module`| `lazy(() => import(...))` | ProtectedRoute (any auth user) |
| `/admin/*`        | `adminPanel/Module`  | `lazy(() => import(...))`      | ProtectedRoute + `['SUPER_ADMIN']` |
| `/tenant/*`       | `tenantAdmin/Module` | `lazy(() => import(...))`      | ProtectedRoute + `['TENANT_ADMIN']` |
| `/settings/*`     | --                   | Placeholder `<div>`            | ProtectedRoute      |
| `/unauthorized`   | --                   | NotFoundPage (local)           | Public              |
| `*`               | --                   | NotFoundPage (local)           | Public              |

### 3.2 Bulgu Tablosu -- Routing

| ID | Seviye | Bulgu | Detay |
|----|--------|-------|-------|
| D14-RT-01 | HIGH | TENANT_ADMIN icin `/admin/*` route'una erisim engeli zayif | `/admin/*` route'u sadece `['SUPER_ADMIN']` kontrolu yapiyor. Ancak `/tenant/*` route'u sadece `['TENANT_ADMIN']` kontrolu yapiyor -- SUPER_ADMIN bu route'a erisemedigi icin tenant impersonation yapilamaz. `ProtectedRoute` role check `requiredRoles.some(role => user?.role === role)` kullanir, hierarchy kontrolu yoktur. |
| D14-RT-02 | HIGH | Module-bazli route erisim kontrolu yok | `/sensor/*`, `/hr/*`, `/sites/*`, `/hydroponics/*` route'lari herhangi bir authenticated kullaniciya acik. Backend'de module erisim kontrolu olmasi beklenir ama frontend'de `hasModuleAccess(code)` kontrolu route seviyesinde uygulanmiyor. Bir tenant'in sensor modulu lisansi yoksa bile frontend route'a ulasip 403 alana kadar remote chunk'i indiriyor. |
| D14-RT-03 | MEDIUM | `/settings/*` placeholder | Rota tanimlanmis ama icerik yok (`<div>Settings (TODO)</div>`). UserMenu'de "Settings" linki buraya yonlendiriyor -- bos sayfa goruntuleniyor. |

---

## 4. Authentication Integration

### 4.1 Mimari

Authentication tamamen host (shell) tarafinda yonetiliyor:

1. **Bootstrap sirasi:** `main.tsx` -> `import('./bootstrap')` (async MF singleton negotiation) -> `AuthProvider` render
2. **Token storage:** Access token yalnizca in-memory (`api-client.ts` satir 76), refresh token httpOnly cookie
3. **MF cross-boundary:** `window.__AQUACULTURE_AUTH__.getAccessToken` global uzerinden diger bundle'lar token'a erisir
4. **Login flow:** GraphQL `login` mutation -> `setTokens(accessToken)` -> `fetchMe()` -> `AUTH_SUCCESS` dispatch
5. **Session restore:** Sayfa yenilemede `silentRefresh()` -> httpOnly cookie ile `refreshToken` mutation -> yeni access token
6. **Token refresh:** GraphQL client 401 aldığında `handleUnauthorized()` -> tek retry ile cookie-based refresh

### 4.2 MF Context Fallback

`useAuthContext()` hook'u context bulamazsa (MF boundary sorunlari) **fail-closed** davranir:

```typescript
// AuthContext.tsx satir 490-518
const fallbackValue: AuthContextValue = {
  isAuthenticated: false,
  hasModuleAccess: () => false,
  isSuperAdmin: () => false,
  // ...tum erisimler reddedilir
};
```

Bu dogru bir guvenlik kararidir -- onceki versiyon JWT decode ile fail-open calisiyordu.

### 4.3 Bulgu Tablosu -- Auth

| ID | Seviye | Bulgu | Detay |
|----|--------|-------|-------|
| D14-AU-01 | MEDIUM | `window.__AQUACULTURE_AUTH__` global prototype pollution riski | Herhangi bir 3rd-party script veya XSS saldirisi `window.__AQUACULTURE_AUTH__` objesini override edebilir. `getAccessToken` fonksiyonunu degistirip token exfiltration yapabilir. Object.freeze veya Symbol-based key kullanilmasi oneriliyor. |
| D14-AU-02 | LOW | Login form `autoComplete="off"` HTML attribute'u | Form elementinde `autoComplete="off"` var ama individual input'larda `autoComplete="username"` ve `autoComplete="current-password"` var. Tutarsizlik -- modern browserlar `autocomplete="off"`'u form seviyesinde zaten ignore eder, ancak tutarlilik icin form-level attribute kaldirilabilir. |
| D14-AU-03 | INFO | Logout handler navigate/replace pattern | `MainLayout.handleLogout` try/finally ile her zaman `/login`'a navigate eder -- iyi pratik. AuthContext fallback'te `window.location.replace('/login')` kullanilarak history pollution onleniyor. |

---

## 5. Error Boundary ve Remote Yuklenme Hatalari

### 5.1 Mimari

Her remote module uc katmanli koruma altinda:

```
<ProtectedRoute>
  <ErrorBoundary moduleName="...">
    <Suspense fallback={<RemoteModuleLoader moduleName="..." />}>
      <LazyRemoteModule />
    </Suspense>
  </ErrorBoundary>
</ProtectedRoute>
```

**Yukleme sirasinda:** `RemoteModuleLoader` -- animasyonlu loading spinner
**Hata durumunda:** `ErrorBoundary` -- "Failed to Load {module}" UI, Retry/Refresh/Home butonlari

### 5.2 Bulgu Tablosu -- Error Handling

| ID | Seviye | Bulgu | Detay |
|----|--------|-------|-------|
| D14-ER-01 | MEDIUM | Error reporting entegrasyonu yok | `ErrorBoundary.componentDidCatch` satir 55-58: `TODO: send to error reporting service (e.g. Sentry)`. Production'da remote modul yuklenme hatalari yalnizca dev console'a yaziliyor. |
| D14-ER-02 | LOW | ErrorBoundary retry state sifirlama network hatasi durumunda yanlis calisabilir | `handleRetry` yalnizca React state'i sifirliyor. Eger remote entry script network hatasi nedeniyle yuklenemezse, browser cache'de basarisiz sonuc cache'lenmis olabilir ve retry yine basarisiz olur. `window.location.reload()` daha guvenilir bir retry mekanizmasidir. |

---

## 6. Layout ve Tenant-Facing UI

### 6.1 MainLayout Yapisi

**Dosya:** `web/shell/src/layouts/MainLayout.tsx`

```
+---------------------------------------------------+
| Header (user, tenant, search, notifications, logout)|
+--------+------------------------------------------+
| Sidebar |  <Outlet /> (remote module content)      |
| (nav)   |                                          |
|         |                                          |
+--------+------------------------------------------+
```

**Sidebar theme sistemi:**
- `'admin'` (indigo) -- SUPER_ADMIN
- `'tenant'` (emerald) -- TENANT_ADMIN
- `'default'` (blue) -- MODULE_MANAGER, MODULE_USER

**Logo text:**
- SUPER_ADMIN: "Aqua Admin"
- TENANT_ADMIN: `tenant?.name || 'Tenant Admin'`
- Others: `tenant?.name || 'Aquaculture'`

### 6.2 Navigation Build Logic

Navigation role-based olarak statik dizilerden ve dinamik modul listesinden insa ediliyor:

1. **SUPER_ADMIN:** `superAdminNavigation` -- 12 top-level item, admin panel icin tam navigasyon
2. **TENANT_ADMIN:** `tenantAdminBaseNavigation` + `moduleNavigationItems` (modules array'den)
3. **MODULE_USER/MANAGER:** `moduleUserBaseNavigation` + `moduleNavigationItems`

Modul navigasyonu `MODULE_NAV_CONFIG` map'inden `modules[].code` ile eslestiriliyor. `me` query sonucunda donen modul listesine gore sidebar dinamik olarak olusturuluyor.

### 6.3 Bulgu Tablosu -- Layout

| ID | Seviye | Bulgu | Detay |
|----|--------|-------|-------|
| D14-LY-01 | MEDIUM | Tenant branding icin yalnizca text var, logo/renk ozellestirmesi yok | Sidebar'da tenant adi gosteriliyor ama tenant'a ozel logo, renk paleti veya favicon destegi yok. Multi-tenant SaaS uygulamalarinda white-labeling beklentisi karsilanmiyor. |
| D14-LY-02 | LOW | Sidebar mobile toggle `md:hidden` | Hamburger menu butonuna yalnizca mobil gorunumde erisilebiliyor. Desktop'ta sidebar her zaman gorunur -- collapsed state icin desktop toggle yok. |

---

## 7. Protected Routes ve RBAC

### 7.1 ProtectedRoute Implementasyonu

**Dosya:** `web/shell/src/App.tsx` satir 70-97

```typescript
const ProtectedRoute = memo(({ children, requiredRoles }) => {
  // 1. Loading check
  // 2. Authentication check -> /login redirect
  // 3. Role check (flat, no hierarchy) -> /unauthorized redirect
  // 4. Tenant check (non-SUPER_ADMIN must have tenantId) -> /unauthorized
});
```

### 7.2 RBAC Analizi

| Kontrol | Uygulanan Yer | Guvenlik Notu |
|---------|---------------|---------------|
| Authentication | ProtectedRoute (host) | Dogru -- isAuthenticated false ise /login redirect |
| Role guard | ProtectedRoute requiredRoles prop | Yalnizca /admin ve /tenant route'larinda uygulanmis |
| Module access | Uygulanmamis (frontend) | Backend'e bagimlıi |
| Tenant isolation | ProtectedRoute tenant check | SUPER_ADMIN haric tenantId zorunlu |

### 7.3 Bulgu Tablosu -- RBAC

| ID | Seviye | Bulgu | Detay |
|----|--------|-------|-------|
| D14-RB-01 | CRITICAL | SUPER_ADMIN `/tenant/*` route'una erisemiyor | `/tenant/*` route'u `requiredRoles={['TENANT_ADMIN']}` ile korunuyor. ProtectedRoute `requiredRoles.some(role => user?.role === role)` kullanir -- role hierarchy yok. SUPER_ADMIN'in role'u bu listeye dahil degil, dolayisiyla SUPER_ADMIN tenant yonetim paneline erisemiyor. AuthContext'te `hasRoleOrHigher()` fonksiyonu var ama ProtectedRoute bu fonksiyonu kullanmiyor. |
| D14-RB-02 | HIGH | Frontend route'lar module erisim kontrolu yapmiyor | `/sensor/*`, `/sites/*`, `/hr/*`, `/hydroponics/*` route'lari herhangi bir authenticated kullaniciya acik. Tenant'in bu modullere lisansi olup olmadigini kontrol eden frontend guard yok. Remote chunk gereksiz yere indirilip backend'den 403 alinana kadar kullanici yanlis yonlendiriliyor. `hasModuleAccess()` fonksiyonu AuthContext'te mevcut ama route'larda kullanilmiyor. |

---

## 8. MF Guvenlik Degerlendirmesi

### 8.1 Remote URL Manipulation -- Script Origin Guard

**Dosya:** `web/shell/src/utils/remoteIntegrity.ts`

**Mekanizma:** `document.createElement` monkey-patch ile `<script>` elementlerinin `src` attribute'u set edilirken araya giriliyor. `remoteEntry` iceren src'ler allowlist'e karsi kontrol ediliyor.

**Allowlist:**
```javascript
const REMOTE_SCRIPT_ALLOWLIST = [
  /^\/remotes\//,                         // Same-origin relative
  /^http:\/\/localhost:8080\/mf\//,       // Dev proxy
  /^https:\/\/app\.suderra\.com\//,       // Production domain
];
```

**Bulgu Tablosu -- Remote URL Security:**

| ID | Seviye | Bulgu | Detay |
|----|--------|-------|-------|
| D14-SC-01 | CRITICAL | SRI hash pinning uygulanmamis | `REMOTE_HASH_PINS` objesi bos. Allowlisted origin'den sunulan script degistirilirse (CDN compromise, supply chain attack) herhangi bir integrity kontrolu yok. `remoteIntegrity.ts` dosyasinin yorumlarinda CI/CD pipeline'da hash uretimi onerilmis ama uygulanmamis. CSP'de `script-src` hash directive'leri de yok. |
| D14-SC-02 | HIGH | CSP `'unsafe-inline'` script yurumesine izin veriyor | Tum nginx config'lerinde `script-src 'self' 'unsafe-inline' blob:` kullaniliyor. `unsafe-inline` XSS saldirilarinin inline script injection ile basarili olmasina izin verir. Vite production build'leri `unsafe-inline` gerektirmez (SH-SEC-17 notunda belirtilmis `unsafe-eval` kaldirilmis ama `unsafe-inline` kalmis). |
| D14-SC-03 | HIGH | Microfrontend nginx `Access-Control-Allow-Origin: *` wildcard CORS | `infrastructure/docker/nginx/microfrontend.conf` satir 33-34, 41-42: remoteEntry.js ve /assets/ icin `Access-Control-Allow-Origin: *` kullaniliyor. Bu, herhangi bir origin'den remote entry ve chunk dosyalarinin okunabilmesini saglar. Prod nginx proxy'de CORS map ile sinirlandirilmis olsa da, container seviyesinde wildcard mevcut. |

### 8.2 Shared State Isolation

**Paylasilan State Mekanizmalari:**

| State | Paylasim Yontemi | Isolation |
|-------|-------------------|-----------|
| AuthContext | React Context (singleton shared-ui) | Tum remote'lar ayni provider altinda -- tasarim geregi paylasimli |
| TenantContext | React Context (singleton shared-ui) | Ayni sekilde paylasimli |
| QueryClient | React Context (host'ta olusturulan singleton) | Tum remote'lar ayni cache'i paylasir |
| Zustand stores | Singleton module, window scope | Ayni zustand instance paylasiliyor |
| Access Token | `window.__AQUACULTURE_AUTH__` global | Tum remote'lar okuyabilir |
| Tenant ID | `localStorage.tenant_id` | Tum remote'lar okuyabilir/yazabilir |

**Izolasyon Degerlendirmesi:** Remote module'ler ayni browser context'te calistigi icin tam izolasyon mumkun degil. Bu MF mimarisinin bilinen bir kisitlamasi. Ancak bir malicious remote'un diger remote'larin zustand store'larina veya query cache'ine yazabilmesi mumkun.

### 8.3 CSP Analizi

Production CSP (nginx.prod.conf satir 130):

```
default-src 'self';
script-src 'self' 'unsafe-inline' blob:;
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
connect-src 'self' ws: wss:;
font-src 'self';
frame-src 'self';
```

| Directive | Deger | Risk |
|-----------|-------|------|
| `script-src 'unsafe-inline'` | **HIGH** | XSS ile inline script injection mumkun |
| `script-src blob:` | MEDIUM | Blob URL uzerinden dinamik script olusturma mumkun |
| `style-src 'unsafe-inline'` | LOW | CSS injection riski dusuk ama mevcut |
| `connect-src ws: wss:` | MEDIUM | Herhangi bir WebSocket sunucusuna baglantiyi yasaklamiyor (`wss://evil.com` dahil) |
| `font-src` | Shell.conf'ta `data: https://fonts.gstatic.com`, prod.conf'ta `'self'` | Tutarsizlik -- Google Fonts production'da calismayabilir |

### 8.4 Version Mismatch Riski

Vite MF singleton mode'da host versiyonu enforce eder. Remote'un `requiredVersion` uyumsuz ise runtime uyari logu uretir ama calismayi durdurmaz. Kritik singletonlar (react, react-dom, react-router-dom) icin bu genelde guvenlidir cunku minor version degisiklikleri geriye uyumlu. Ancak `reactflow` gibi kucuk kutuphanelerde breaking change riski mevcuttur.

---

## 9. Performance Analizi

### 9.1 Remote Chunk Yukleme Stratejisi

| Strateji | Durum | Detay |
|----------|-------|-------|
| Lazy loading | UYGULANMIS | `React.lazy(() => import('remote/Module'))` ile tum remote'lar on-demand yukleniyor |
| Preload/prefetch | UYGULANMAMIS | Hicbir remote icin `<link rel="modulepreload">` veya `import()` prefetch kullanilmiyor |
| remoteEntry.js cache | NO-CACHE | `shell.conf` satir 47-50: `no-store, no-cache, must-revalidate` |
| Asset chunks cache | 1Y IMMUTABLE | `shell.conf` satir 40-44: `expires 1y; Cache-Control: public, immutable` |
| Gzip | UYGULANMIS | Tum nginx config'lerinde gzip aktif |
| CSS code splitting | KISMEN | Dashboard `cssCodeSplit: true`, diger remote'lar belirtmemis |

### 9.2 Bulgu Tablosu -- Performance

| ID | Seviye | Bulgu | Detay |
|----|--------|-------|-------|
| D14-PF-01 | MEDIUM | Remote module prefetch/preload yok | Kullanici navigasyon yaparken remote chunk'larin tamamini beklemek zorunda. Sidebar hover/visible durumlarinda modul prefetch yapilabilir. Ozellikle dashboard modulu icin -- login sonrasi ilk erisilen modul oldugu icin eager veya prefetch stratejisi onerilir. |
| D14-PF-02 | MEDIUM | QueryClient `staleTime: 5m` tum moduller icin global | Tum remote'lar ayni QueryClient'i paylasir. Sensor verisi gibi gercek zamanli ihtiyaci olan moduller icin 5dk stale time cok uzun olabilir. Remote'lar kendi override'larini query bazinda yapabilir ama global default yanlisliga aciktor. |

---

## 10. Nginx Altyapi Uyumu

### 10.1 Path Routing Tutarliligi

| Ortam | Remote Path Convention | Nginx Config | Durum |
|-------|------------------------|--------------|-------|
| Dev (vite serve) | `http://localhost:8080/mf/{module}/assets/remoteEntry.js` | `nginx/nginx.conf` `/mf/*` locations | OK |
| Dev (vite build preview) | `/remotes/{module}/assets/remoteEntry.js` | `nginx/nginx.conf` `/remotes/*` locations | OK |
| Production | `/remotes/{module}/assets/remoteEntry.js` | `nginx.prod.conf` -- **EKSIK** | PROBLEM |

**Onemli:** `nginx.prod.conf` dosyasinda `/remotes/` path'leri icin proxy tanimlamasi yok. Yalnizca `/mf/` path'leri tanimli. Bu durum production deployment'in `nginx/nginx.conf` kullanmasini zorunlu kiliyor veya production'da remote module'ler yuklenemiyor.

### 10.2 Microfrontend Container Config

`infrastructure/docker/nginx/microfrontend.conf` tum remote container'lar tarafindan kullaniliyor:
- `index.html` ve `/` erisimi 403 ile engelleniyor (MF bypass korunmasi)
- `remoteEntry.js` no-cache
- `/assets/` 1 yil cache
- CORS: `Access-Control-Allow-Origin: *` (tum origin'lere acik)

---

## 11. Oneriler (Oncelik Sirali)

### CRITICAL

1. **D14-RB-01: ProtectedRoute'a role hierarchy ekle**
   - `ProtectedRoute` component'inde `requiredRoles` kontrolunu `hasRoleOrHigher()` ile degistir
   - `/tenant/*` route'unda SUPER_ADMIN'in de erisebilmesini sagla
   - **Etkilenen dosya:** `web/shell/src/App.tsx` satir 84-86

2. **D14-SC-01: CI/CD pipeline'da SRI hash uretimi uygula**
   - Build adiminda her remote'un `remoteEntry.js` dosyasi icin SHA-256 hash hesapla
   - Hash'leri `REMOTE_HASH_PINS` map'ine inject et
   - CSP `script-src` directive'ine hash'leri ekle
   - **Etkilenen dosya:** `web/shell/src/utils/remoteIntegrity.ts` satir 49-52

### HIGH

3. **D14-SC-02: CSP'den `'unsafe-inline'` kaldir**
   - Vite production build'leri inline script gerektirmez
   - Inline style'lar icin `nonce` bazli yetkilendirme uygula
   - **Etkilenen dosyalar:** Tum nginx config'leri

4. **D14-SC-03: Microfrontend CORS'u sinirla**
   - `microfrontend.conf`'ta `Access-Control-Allow-Origin: *` yerine outer nginx proxy'nin origin map'ini kullan
   - **Etkilenen dosya:** `infrastructure/docker/nginx/microfrontend.conf` satir 33, 41

5. **D14-RB-02: Module-bazli route guard ekle**
   - `ProtectedRoute`'a `requiredModule` prop'u ekle
   - `hasModuleAccess(moduleCode)` kontrolu ile modul route'larini koru
   - **Etkilenen dosya:** `web/shell/src/App.tsx`

6. **D14-RT-01: ProtectedRoute role hierarchy kullanimi**
   - Yukarida D14-RB-01 ile cozulecek

7. **D14-AU-01: `window.__AQUACULTURE_AUTH__` guvenligini artir**
   - `Object.freeze()` ile objeyi koru
   - Symbol key kullanarak enumerable olmayan property yap
   - **Etkilenen dosya:** `web/shared-ui/src/utils/api-client.ts` satir 88-90

### MEDIUM

8. **D14-MF-01: nginx.prod.conf'a `/remotes/` path'leri ekle**
9. **D14-ER-01: Sentry/error reporting entegrasyonu**
10. **D14-PF-01: Dashboard modulu icin prefetch stratejisi**
11. **D14-PF-02: Sensor modulu icin daha dusuk staleTime**
12. **D14-LY-01: Tenant branding -- logo/renk API'si**
13. **D14-RT-03: Settings sayfasinin uygulanmasi veya route'un kaldirilmasi**

### LOW

14. **D14-MF-02: reactflow version uyumu**
15. **D14-AU-02: Login form autoComplete tutarliligi**
16. **D14-ER-02: ErrorBoundary retry mekanizmasi iyilestirmesi**
17. **D14-LY-02: Desktop sidebar collapse toggle**
18. **D14-MF-03: react-query shared config tutarliligi**

---

## 12. Dosya Referanslari

| Dosya | Satirlar | Konu |
|-------|----------|------|
| `web/shell/vite.config.ts` | 21-64 | MF host config, shared singletons |
| `web/shell/src/App.tsx` | 25-55, 70-97, 128-257 | Lazy imports, ProtectedRoute, route tanimlari |
| `web/shell/src/bootstrap.tsx` | 13-20, 55-67 | Integrity guard install, render tree |
| `web/shell/src/layouts/MainLayout.tsx` | 29-264, 300-512 | Navigation config, layout render |
| `web/shell/src/components/ErrorBoundary.tsx` | 34-144 | Error boundary class component |
| `web/shell/src/components/RemoteModuleLoader.tsx` | 52-83 | Loading fallback UI |
| `web/shell/src/utils/remoteIntegrity.ts` | 34-41, 103-172 | Allowlist, createElement patch |
| `web/shell/src/pages/LoginPage.tsx` | 39-101, 188-431 | Login form, invitation accept |
| `web/shared-ui/src/contexts/AuthContext.tsx` | 178-435, 476-521 | Provider, MF fallback hook |
| `web/shared-ui/src/utils/api-client.ts` | 76-180, 227-401 | Token mgmt, GraphQL client, refresh |
| `infrastructure/docker/nginx/nginx.prod.conf` | 99-260 | Production nginx, CSP headers |
| `infrastructure/docker/nginx/microfrontend.conf` | 1-66 | MF container nginx, CORS |
| `infrastructure/docker/nginx/shell.conf` | 1-77 | Shell container nginx, cache |
| `nginx/nginx.conf` | 245-300 | Dev/compose nginx, /remotes/ paths |

---

## 13. Sonuc

Shell host uygulamasi Module Federation perspektifinden iyi yapilandirilmis: singleton shared dependency yonetimi, per-module ErrorBoundary/Suspense pattern'i, ve `remoteIntegrity.ts` ile script origin guard gibi ileri guvenlik onlemleri mevcuttur. AuthContext fail-closed MF fallback'i guvenlik acisindan dogru karardır.

Ancak iki kritik sorun dikkate alinmalidir:

1. **RBAC hierarchy eksikligi** SUPER_ADMIN'in tenant paneline erismesini engelliyor -- bu operasyonel bir engel.
2. **SRI hash pinning'in uygulanmamis olmasi** MF remote entry dosyalarinin bütunlugunu dogrulamayi imkansiz kiliyor -- bu guvenlik acisindan en buyuk risktir.

Bu iki bulgunun cozumu icin tahmini effort: 2-3 gun (1 gun RBAC, 1-2 gun CI/CD SRI pipeline).
