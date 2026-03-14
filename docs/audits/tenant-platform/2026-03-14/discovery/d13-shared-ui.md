# D13 - Shared UI Library Audit

**Tarih**: 2026-03-14
**Auditor**: D13 - UI Kutuphanesi Uzmani
**Kapsam**: `web/shared-ui/` - Enterprise Component Library
**Paket**: `@aquaculture/shared-ui@1.0.0`

---

## 1. YONETICI OZETI

Shared UI kutuphanesi 55+ dosyadan olusan, 30+ component, 6 hook, 8 utility modulu
ve 2 context provider iceren kapsamli bir enterprise component library. Module Federation
uzerinden tum microfrontend'ler tarafindan singleton olarak tuketiliyor.

**Genel Degerlendirme**: Orta-Iyi. Guvenlik iyilestirmeleri yapilmis (SEC-005 thru SEC-015),
performans optimizasyonlari eklenmis (PERF-001 thru PERF-014), ancak test altyapisi tamamen
eksik, a11y kapsaminda bosluklar var ve bazi architectural kararlar belgelenmemis.

| Kategori | Durum | Not |
|---|---|---|
| Guvenlik | ORTA | Token in-memory, open redirect korunmali, stripHtml XSS-safe degil |
| Erisebilirlik | ZAYIF | Temel a11y var ama WCAG 2.1 AA tam saglanamiyor |
| Performans | IYI | useMemo/useCallback dogru kullanilmis, context memoized |
| Test | KRITIK | Sifir test dosyasi, sifir story |
| Tip Guvenligi | IYI | TypeScript strict mode, kapsamli type export'lar |
| Bundle | IYI | Tree-shaking uyumlu, peer deps external |

---

## 2. EXPORT ENVANTERI

### 2.1 Components (30+)

| Component | Dosya | forwardRef | displayName |
|---|---|---|---|
| Button, ButtonGroup | Button/Button.tsx | Evet | Evet |
| Card, CardGrid, MetricCard | Card/Card.tsx | - | - |
| Table | Table/Table.tsx | - (generic) | - |
| DataTable | DataTable/DataTable.tsx | - (generic) | - |
| Input, Textarea | Form/Input.tsx | Evet | Evet |
| Select | Form/Select.tsx | Evet | Evet |
| Checkbox, Switch, RadioGroup | Form/Checkbox.tsx | - | - |
| NumberInput | Form/NumberInput.tsx | - | - |
| DatePicker | Form/DatePicker.tsx | - | - |
| DateRangePicker | Form/DateRangePicker.tsx | - | - |
| FileUpload | Form/FileUpload.tsx | - | - |
| SearchInput | Form/SearchInput.tsx | - | - |
| MultiSelect | Form/MultiSelect.tsx | - | - |
| FormField | Form/FormField.tsx | - | - |
| DynamicSpecificationForm | Form/DynamicSpecificationForm.tsx | - | - |
| Modal, ConfirmModal | Modal/Modal.tsx | - | - |
| DeleteConfirmationDialog | Modal/DeleteConfirmationDialog.tsx | - | - |
| Alert, Badge | Alert/Alert.tsx | - | - |
| Header | Layout/Header.tsx | - | - |
| Sidebar | Layout/Sidebar.tsx | - | - |
| Spinner, LoadingOverlay, Skeleton* | Loading/Loading.tsx | - | - |
| KpiCard | KpiCard/KpiCard.tsx | - | - |
| AreaChart, LineChart, BarChart, PieChart, DonutChart, SparklineChart | Charts/*.tsx | - | - |
| ChartContainer, ChartTooltip, ChartLegend | Charts/*.tsx | - | - |
| ApiError | ApiError/ApiError.tsx | - | - |
| ConfiguredBrowserRouter | ConfiguredBrowserRouter.tsx | - | - |

### 2.2 Hooks (6)

| Hook | Dosya | Aciklama |
|---|---|---|
| `useAuth` | hooks/useAuth.ts | AuthContext wrapper, role/permission check |
| `useRequireAuth` | hooks/useAuth.ts | Role-gated authorization check |
| `useTenant` | hooks/useTenant.ts | Tenant context wrapper, tier/feature/limit check |
| `useGraphQLQuery` | hooks/useGraphQL.ts | GraphQL query state (kendi state'i, react-query degil) |
| `useGraphQLMutation` | hooks/useGraphQL.ts | GraphQL mutation state |
| `useToast` | hooks/useToast.ts | Toast notification state |

**Placeholder Hook'lar** (export edilmis ama islevsiz):
- `usePrefetchQuery` - sadece console.log
- `useUpdateQueryCache` - sadece console.log
- `useInvalidateQueries` - sadece console.log

### 2.3 Contexts (2)

| Context | Provider | Hook | Fallback |
|---|---|---|---|
| AuthContext | `AuthProvider` | `useAuthContext()` | Fail-closed (deny all) |
| TenantContext | `TenantProvider` | `useTenantContext()` | throws Error |

### 2.4 Utilities (7 modulleri)

| Modul | Fonksiyon Sayisi | Aciklama |
|---|---|---|
| api-client.ts | 10+ | GraphQLClient, RestClient, token yonetimi |
| validation.ts | 25+ | Form dogrulama kurallari (factory pattern) |
| format.ts | 20+ | Sayi/para/telefon/sensor formatlama |
| date-utils.ts | 25+ | Tarih formatlama/karsilastirma/manipulasyon |
| error-types.ts | 5 | ErrorCode enum, parseError, AppError |
| graphql-utils.ts | 15+ | React Query entegrasyonu, query key factory |
| specificationValidation.ts | 4 | Equipment spec dogrulama |
| utils/index.ts | 1 | `cn()` - clsx + tailwind-merge |

---

## 3. AUTH CONTEXT ANALIZI

### 3.1 AuthProvider Implementasyonu

**Dosya**: `contexts/AuthContext.tsx`

Mimari:
- `useReducer` ile state yonetimi (AUTH_START, AUTH_SUCCESS, AUTH_FAILURE, LOGOUT)
- `login()` -> GraphQL `Login` mutation -> `setTokens(accessToken)` -> `fetchMe()` -> dispatch
- `logout()` -> GraphQL `Logout` mutation -> `clearTokens()` -> dispatch LOGOUT
- `refreshAuth()` -> `fetchMe()` ile state yenileme
- Initial auth check: `getAccessToken()` || `silentRefresh()` -> `fetchMe()`

Guvenlik Olculeri:
- **SEC-005**: `sanitizeRedirectUrl()` open redirect onlemi - '/' ile baslamali, '//' icermemeli, ':' icermemeli
- Role hierarchy: `SUPER_ADMIN > TENANT_ADMIN > MODULE_MANAGER > MODULE_USER`
- `hasModuleAccess()`: SUPER_ADMIN icin false (system access, module access degil)

Performans:
- **PERF-001**: Context value `useMemo` ile memoize edilmis
- Role check callback'leri `userRole` primitive'ine bagimli (obje referansina degil)

### 3.2 useAuthContext() MF Fallback

```typescript
// Context yoksa fail-closed: tum erisimler reddedilir
const fallbackValue: AuthContextValue = {
  isAuthenticated: false,
  hasModuleAccess: () => false,
  hasRoleOrHigher: () => false,
  // ...
};
```

**BULGU [OLUMLU]**: Onceki surumde JWT decode eden fallback vardi, simdi fail-closed. Bu
dogru guvenlik yaklasimi - istemci tarafinda imza dogrulamasi olmadan JWT'ye guvenilmemeli.

### 3.3 Token Yonetimi

**Dosya**: `utils/api-client.ts`

```
Access Token:  In-memory only (module-level variable)
Refresh Token: httpOnly cookie (JS'e erisim yok)
Tenant ID:     Memory + localStorage (hassas olmayan veri)
```

| Fonksiyon | Davranis |
|---|---|
| `setTokens(access)` | Memory'ye yazar, `window.__AQUACULTURE_AUTH__` gunceller |
| `clearTokens()` | Memory ve localStorage temizler |
| `getAccessToken()` | Memory -> window.__AQUACULTURE_AUTH__ fallback |
| `silentRefresh()` | httpOnly cookie ile `/graphql` refreshToken mutation |
| `setTenantId(id)` | Memory + localStorage |
| `getTenantId()` | Memory -> localStorage (SEC-013: cache'lemeden) |

**BULGU [OLUMLU]**: Access token artik localStorage'da tutulmuyor. In-memory + httpOnly
cookie modeli XSS riskini onemli olcude azaltiyor.

**BULGU [RISK]**: `window.__AQUACULTURE_AUTH__` global'i Module Federation icin gerekli
ama kotu niyetli script tarafindan `getAccessToken` fonksiyonu override edilebilir.
Pratikte XSS varsa zaten token alinabilir, bu ek risk minimumdur.

**BULGU [RISK]**: `getTenantId()` SEC-013 ile cache'leme sorunu cozulmus ama hala
localStorage'a yaziliyor. Tenant ID hassas olmayan veri oldugu icin kabul edilebilir,
ancak multi-tab senaryolarda race condition olusabilir.

---

## 4. API CLIENT ANALIZI

### 4.1 GraphQLClient

- Singleton instance: `graphqlClient`
- Her istekte: `Authorization: Bearer <token>`, `X-Tenant-Id`, `X-Request-Id`
- 30 saniye default timeout, AbortController ile
- `credentials: 'include'` - httpOnly cookie icin
- **CRIT-01**: 401'de tek retry (retryCount kapi), sonsuz dongu onlenmis
- Token refresh dedup: `tokenRefreshPromise` ile concurrent refresh engeli
- **SEC-015**: `crypto.randomUUID()` ile request ID (fallback: timestamp+random)

### 4.2 RestClient

- Singleton instance: `restClient`
- Ayni header injection (Authorization, X-Tenant-Id)
- Convenience methods: get/post/put/patch/delete
- 204 No Content handle edilmis

**BULGU [SORUN]**: RestClient'ta 401 retry mekanizmasi YOK. GraphQLClient'ta var ama
RestClient sessizce basarisiz oluyor. Tutarsizlik.

**BULGU [SORUN]**: RestClient `accessToken` degiskenini dogrudan okuyor (module-level),
`getAccessToken()` fonksiyonunu KULLANMIYOR. Bu da MF fallback'in (`window.__AQUACULTURE_AUTH__`)
RestClient icin calismamasi demek.

```typescript
// RestClient (HATALI - dogrudan module var):
if (accessToken) { headers['Authorization'] = `Bearer ${accessToken}`; }

// GraphQLClient (DOGRU - getter fonksiyonu):
const currentToken = getAccessToken();
```

**Oneri**: RestClient satir 477'de `getAccessToken()` kullanilmali.

---

## 5. UI COMPONENT KALITESI

### 5.1 Button

**Kalite**: Iyi
- `forwardRef` + `displayName` dogru
- 7 variant (primary, secondary, danger, success, warning, ghost, outline)
- 5 size (xs-xl), iconOnly modu
- `type="button"` default (form submit onlemi)
- `aria-busy`, `aria-disabled` mevcut
- Loading spinner `aria-hidden="true"`
- ButtonGroup `role="group"` ile

**Props API Tutarliligi**: `isLoading` + `loading` alias (BUG-017 uyarisi ile)

### 5.2 Modal

**Kalite**: Iyi
- Portal render (`createPortal`)
- Focus trap implementasyonu (BUG-005 fix)
- Escape key handler (stable ref pattern - BUG-001/PERF-007)
- `aria-modal="true"`, `role="dialog"`, `aria-labelledby`, `aria-describedby`
- Overlay click ve escape ile kapatma
- Body scroll lock (`overflow: hidden`)
- Focus restore on close

**BULGU [A11Y SORUN]**: Close button aria-label "Kapat" sadece Turkce. i18n destegi yok.

**BULGU [A11Y SORUN]**: ConfirmModal icindeki butonlar `type="button"` ile isaretlenmis
ama aria-label'lari yok. Screen reader kullanicilari icin anlam eksik.

### 5.3 Input / Textarea

**Kalite**: Iyi
- `forwardRef` + `displayName` dogru
- `useId()` ile otomatik ID olusturma
- `aria-invalid`, `aria-describedby` (error ve helper text icin)
- Error mesaji `role="alert"` ile
- `helperText` / `hint` alias destegi

### 5.4 Select

**Kalite**: Iyi
- Native `<select>` elementi (a11y dostu)
- `optgroup` destegi
- `aria-invalid`, `aria-describedby` dogru
- Null-safe options (`const safeOptions = options || []`)

### 5.5 Table

**Kalite**: Iyi
- Generic TypeScript (`<T extends object>`)
- Skeleton loading state
- Empty state (ikon + mesaj)
- Selectable rows (indeterminate checkbox destegi)
- Sortable columns
- Pagination component
- `keyExtractor` + `rowKey` birlestirilmis (BUG-008)

### 5.6 DataTable

**Kalite**: Cok Iyi - Enterprise-grade
- Server-side sort/filter/pagination destegi
- Debounced search (300ms default)
- Column visibility toggle
- Bulk actions
- CSV export (SEC-014: formula injection korunmali)
- Expandable rows
- Sticky header/columns
- Memoized TableBody (PERF-010)
- Click-outside backdrop (BUG-002 fix)

**BULGU [PERF]**: Menu state (`showColumnMenu`, `showExportMenu`, `showFilterPanel`)
hala parent component'te. Yorum olarak belirtilmis ama henuz ayri child component
olarak refactor edilmemis.

### 5.7 Layout (Header + Sidebar)

**Header**:
- Theme destegi (default/admin/tenant)
- User menu dropdown (click-outside dismiss)
- Notification badge
- Search box

**Sidebar**:
- Collapsible
- Nested navigation (recursive MenuItem)
- Role-based access control (`requiredRoles`)
- External link destegi (`noopener,noreferrer`)
- Theme renkleri (blue/indigo/emerald)
- Inert items (BUG-020: path'siz ogeler span olarak render)

**BULGU [A11Y SORUN]**: Sidebar `<aside>` elementi var ama `aria-label` yok.
Header `<header>` elementi var, a11y uyumlu.

### 5.8 Charts

SVG-based chart component'leri (`recharts` KULLANMIYOR - custom SVG implementasyonu).
Package.json'da recharts yok, peer dependency olarak da yok.

**BULGU [TUTARSIZLIK]**: Knowledge base "recharts wrapper" diyor ama gercek implementasyon
pure SVG. Bu bir artis (dis bagimliligi yok, bundle size kucuk).

---

## 6. DESIGN SYSTEM TUTARLILIGI

### 6.1 Theme (`styles/theme.ts`)

Kapsamli token sistemi:
- 7 renk paleti (brand, gray, green, red, yellow, blue, aqua + semantic)
- Tipografi (Inter font, 9 size, 7 weight)
- Spacing (24 step, 0-32 arasi)
- Border radius, shadows, transitions, z-index
- Breakpoints (sm-2xl, Tailwind uyumlu)
- Dark mode renkleri tanimli
- CSS degiskenleri ureteci (`generateCSSVariables`)

**BULGU [SORUN]**: Theme token'lari component'ler tarafindan KULLANILMIYOR.
Button, Input, Modal hepsi hardcoded Tailwind class'lari kullaniyor:
```typescript
// Button.tsx - hardcoded renkler:
primary: 'bg-blue-600 text-white hover:bg-blue-700'

// theme.ts'deki brand.500 (#1890ff) ile tailwind blue-600 FARKLI renkler
```

Bu ciddi bir tutarsizlik: theme dosyasi dekoratif, gercek styling
dogrudan Tailwind utility class'lari ile yapiliyor. Tailwind preset
olarak theme entegrasyonu yapilmamis.

### 6.2 Props Naming Convention

Genel olarak tutarli:
- `isLoading` / `loading` (alias pattern)
- `isOpen` / `open` (alias pattern)
- `size`: `Size` type (`xs | sm | md | lg | xl`)
- `variant`: component-specific type'lar
- `className`: tum component'lerde
- `disabled`: HTML native

**BULGU [TUTARSIZLIK]**: `Table` ve `DataTable` farkli props API'leri:
- Table: `isLoading`, `rowKey`, `pagination.current`
- DataTable: `loading`, `keyExtractor`, `pagination.page`
Ayni amac icin farkli prop isimleri kafa karistirici.

### 6.3 Utility: `cn()` (clsx + tailwind-merge)

```typescript
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

Export ediliyor ama component'lerin HICBIRI kullanmiyor. Hepsi string
concatenation yapiyor:
```typescript
// Button.tsx:
const combinedClassName = `${baseStyles} ${variantStyles[variant]} ...`.replace(/\s+/g, ' ').trim();
```

`cn()` kullanilmadigi icin class cakismalari (`bg-blue-600` ile consumer'in
`bg-red-500` gecmesi) dogru resolve edilmiyor.

---

## 7. MODULE FEDERATION ENTEGRASYONU

### 7.1 Singleton Konfigurasyonu

Shell ve tum modul vite.config.ts dosyalarinda:
```typescript
'@aquaculture/shared-ui': {
  singleton: true,
  import: true,
  requiredVersion: '^1.0.0',
}
```

**OLUMLU**: Singleton olarak dogru configure edilmis. Bu, AuthContext ve
TenantContext'in tum MFE'ler arasinda paylasilan tek instance olmalarini garanti eder.

### 7.2 MF Token Paylasimi

```
Shell (AuthProvider)
  |-- setTokens() -> module-level var + window.__AQUACULTURE_AUTH__
  |
  +-- Remote MFE (useAuthContext fallback)
        |-- getAccessToken() -> module-level var || window.__AQUACULTURE_AUTH__
```

Singleton mode'da module-level var ayni instance. Fallback gereksiz ama savunma amacli.

### 7.3 ConfiguredBrowserRouter

React Router v7 future flags'leri merkezi olarak yonetiyor:
- `v7_startTransition: true`
- `v7_relativeSplatPath: true`

Tum MFE'lerin ayri ayri flag eklemesine gerek kalmadan deprecation uyarilarini onluyor.

---

## 8. GUVENLIK ANALIZI

### 8.1 XSS

| Kontrol Noktasi | Durum | Not |
|---|---|---|
| dangerouslySetInnerHTML | YOK | Hicbir component'te kullanilmamis |
| stripHtml() | UYARI | SEC-006 ile belgelenmis, DOMParser fallback var |
| ApiError context prop | GUVENLI | SEC-010 JSDoc uyarisi, JSX interpolation |
| CSV export | GUVENLI | SEC-014 formula injection korunmasi |
| Redirect URL | GUVENLI | SEC-005 sanitizeRedirectUrl() |

**BULGU [OLUMLU]**: dangerouslySetInnerHTML hicbir yerde kullanilmamis.
ApiError.tsx dosyasinda sadece referans olarak JSDoc'ta gecmis.

### 8.2 Token Guvenligi

| Kontrol | Durum |
|---|---|
| Access token in-memory | EVET |
| Refresh token httpOnly cookie | EVET |
| localStorage'da token yok | EVET |
| credentials: 'include' | EVET |
| Token refresh dedup | EVET |
| Retry limit (1) | EVET |
| Error'da token temizleme | EVET |

### 8.3 Diger

- `window.location.replace('/login')` kullanilmis (history pollution onlemi - SEC-008)
- `noopener,noreferrer` dis linkler icin (Sidebar)
- showDetails sadece `import.meta.env.DEV`'de (SEC-011)
- Request ID: `crypto.randomUUID()` (SEC-015)

---

## 9. ERISEBILIRLIK (A11Y)

### 9.1 Mevcut A11Y Ozellikleri

| Ozellik | Component | Durum |
|---|---|---|
| aria-invalid | Input, Textarea, Select | Evet |
| aria-describedby | Input, Textarea, Select | Evet (error/helper) |
| aria-busy | Button | Evet |
| aria-disabled | Button | Evet |
| aria-hidden (spinner) | Button LoadingSpinner | Evet |
| role="alert" | Input/Textarea error | Evet |
| role="dialog" | Modal | Evet |
| aria-modal | Modal | Evet |
| aria-labelledby | Modal | Evet (title varsa) |
| aria-describedby | Modal (description) | Evet |
| role="group" | ButtonGroup | Evet |
| Focus trap | Modal | Evet |
| Focus restore | Modal | Evet |
| aria-label | NotificationButton | Evet |
| aria-expanded | UserMenu button | Evet |
| aria-haspopup | UserMenu button | Evet |

### 9.2 Eksikler

| Eksik | Component | Onem |
|---|---|---|
| aria-label (Turkce-only) | Modal close button | ORTA |
| aria-label | Sidebar aside | ORTA |
| aria-label | Table sort buttons | DUSUK |
| aria-live region | Toast notifications | YUKSEK |
| Skip navigation link | Layout | ORTA |
| Color contrast ratio | Warning variant (yellow-500 on white) | YUKSEK |
| Keyboard navigation | DataTable column menu | ORTA |
| aria-sort | Table/DataTable th | ORTA |
| Screen reader text | KpiCard trend indicator | DUSUK |

**BULGU [KRITIK]**: useToast hook'u toast'lari DOM'a ekliyor ama `aria-live="polite"`
region tanimli degil. Screen reader kullanicilari toast bildirimlerini duymayacak.

**BULGU [KRITIK]**: Warning button variant `bg-yellow-500 text-white` WCAG 2.1 AA
kontrast oranini saglamiyor (3.4:1, minimum 4.5:1 gerekli).

---

## 10. BUNDLE SIZE VE TREE-SHAKING

### 10.1 Build Konfigurasyonu

```typescript
// vite.config.ts
build: {
  lib: {
    formats: ['es', 'cjs'],     // Dual format
  },
  rollupOptions: {
    external: [
      'react', 'react-dom',
      'react/jsx-runtime', 'react/jsx-dev-runtime',
      'react-router-dom',
      '@tanstack/react-query',
    ],
  },
  sourcemap: true,
  minify: 'terser',             // drop_console, drop_debugger
}
```

**OLUMLU**:
- ES + CJS dual output
- Peer deps external (react, react-dom, react-router-dom, @tanstack/react-query)
- JSX runtime external (onemli, aksi halde React internals bundle edilir)
- Source map mevcut

### 10.2 Tree-shaking

**BULGU [SORUN]**: Tek entry point (`src/index.ts`) tum component'leri re-export ediyor.
Named export'lar kullanilmis (iyi) ama barrel export pattern nedeniyle bundler
optimizasyonlari sinirli olabilir.

Olasi iyilestirme: `package.json` exports field'ina alt-path export'lar eklemek:
```json
{
  "exports": {
    "./components/Button": "...",
    "./hooks/useAuth": "...",
    "./utils/format": "..."
  }
}
```

### 10.3 Bagimliliklari

**dependencies** (bundle'a dahil):
- `clsx@^2.1.0` (~400B)
- `tailwind-merge@^3.4.0` (~5KB gzipped)
- `react-router-dom@^6.21.0` (external)
- `@tanstack/react-query@^5.17.0` (external)

**BULGU [SORUN]**: `graphql` paketi `api-client.ts` satir 7'de import ediliyor:
```typescript
import { print, type DocumentNode } from 'graphql';
```
Ancak `graphql` package.json'da dependency olarak TANIMLANMAMIS. Bu `graphql`
paketinin shell veya modules'un node_modules'undan hoist edilmis olmasi gerekiyor.
Implicit dependency kotu pratik.

---

## 11. TEST DURUMU

### 11.1 Mevcut Testler

**SIFIR** test dosyasi bulundu:
- `*.test.*` dosyasi: 0
- `*.spec.*` dosyasi: 0
- `*.stories.*` dosyasi: 0

### 11.2 Test Altyapisi

package.json'da tanimli:
```json
{
  "scripts": {
    "test": "vitest",
    "test:coverage": "vitest --coverage",
    "storybook": "storybook dev -p 6006",
    "build-storybook": "storybook build"
  },
  "devDependencies": {
    "vitest": "^1.1.0"
  }
}
```

Vitest ve Storybook script'leri tanimli ama hicbir test veya story yazilmamis.

**BULGU [KRITIK]**: Enterprise component library icin sifir test kabul edilemez.
Ozellikle AuthContext, api-client token yonetimi, validation utility'leri ve
Modal focus trap gibi kritik islevler mutlaka test edilmeli.

### 11.3 Oncelikli Test Hedefleri

1. `api-client.ts` - Token refresh, retry logic, 401 handling
2. `AuthContext.tsx` - Login/logout flow, role hierarchy, MF fallback
3. `validation.ts` - Tum validator factory fonksiyonlari
4. `Modal.tsx` - Focus trap, escape key, portal render
5. `format.ts` - Edge case'ler (NaN, negative, very large numbers)
6. `date-utils.ts` - Timezone handling, invalid dates

---

## 12. HOOKS ANALIZI

### 12.1 useGraphQL Hooks

**BULGU [SORUN]**: `useGraphQLQuery` kendi `useState` ile state yonetiyor,
`@tanstack/react-query` kullanmiyor. Ancak `@tanstack/react-query` peer dependency
olarak tanimli ve `graphql-utils.ts`'de `createQueryClient()`, `createQueryOptions()`
gibi React Query utility'leri export ediliyor.

Sonuc: Iki farkli data fetching pattern var:
1. `useGraphQLQuery/useGraphQLMutation` - kendi state'i (caching yok, dedup yok)
2. `graphql-utils.ts` - React Query entegrasyonu (caching, dedup, retry)

Bazi modueller `useGraphQLQuery` kullanirken baskalari dogrudan React Query + graphqlClient
kullaniyor. Bu tutarsizlik karisikliga yol aciyor.

### 12.2 useToast

- `useState` based, global state degil
- Her component instance ayri toast listesi
- Duration sonrasi otomatik dismiss (setTimeout)

**BULGU [MIMARI]**: useToast hook-level state. Farkli component'lerden
yapilan toast cagrilari birbirini gormuyor. Global toast manager yok.

### 12.3 Placeholder Hooks

```typescript
export function usePrefetchQuery() {
  return useCallback(async (key, query, variables) => {
    console.log('Prefetch:', key, query, variables);  // NO-OP
  }, []);
}
```

3 placeholder hook export ediliyor ama hicbiri gercek islevsellige sahip degil.
Tuketiciler bu fonksiyonlari cagirdiginda sadece console.log gorurler.

**Oneri**: Ya kaldirilmali ya da `graphql-utils.ts`'deki React Query utility'leri
ile implemente edilmeli.

---

## 13. TENANT CONTEXT ANALIZI

### 13.1 TenantProvider

- `useReducer` ile state yonetimi
- `initialTenant` prop destegi
- `switchTenant()`: **IMPLEMENTE EDILMEMIS** - throw Error
- `clearTenant()`: calisiyor

**BULGU [KRITIK]**: `switchTenant` fonksiyonu production'da throw ediyor:
```typescript
const switchTenant = useCallback(async (_tenantId: string): Promise<void> => {
  throw new Error('switchTenant: not implemented...');
}, []);
```

### 13.2 useTenant Hook

Zengin API:
- `checkLimit()` - resource limit kontrolu (warning %80 esik)
- `hasFeature()` - tier-based feature gating (hardcoded feature listesi)
- `isTierAtLeast()` - tier karsilastirmasi

**BULGU [SORUN]**: Feature listesi `useTenant.ts` icinde hardcoded:
```typescript
const tierFeatures: Record<TenantTier, string[]> = {
  free: ['basic_dashboard', 'manual_data_entry', 'email_alerts'],
  starter: [..., 'sensor_integration', 'basic_reports', 'api_access'],
  // ...
};
```
Backend'den alinmak yerine frontend'te hardcoded. Tier'a yeni ozellik
eklenmesi icin frontend deploy gerekir.

---

## 14. BILINEN SORUNLAR VE FIXLER

Kod icindeki BUG/PERF/SEC/CRIT etiketleri:

| Etiket | Dosya | Aciklama | Durum |
|---|---|---|---|
| BUG-001 | Modal.tsx | Escape listener ref identity | DUZELTILMIS |
| BUG-002 | DataTable.tsx | Click-outside backdrop | DUZELTILMIS |
| BUG-003 | useAuth.ts | hasAllRoles single-role model | DUZELTILMIS |
| BUG-005 | Modal.tsx | Focus trap | DUZELTILMIS |
| BUG-008 | Table.tsx, DataTable.tsx | rowKey function overload | DUZELTILMIS |
| BUG-011 | Modal.tsx | confirmVariant typing | DUZELTILMIS |
| BUG-012 | Input.tsx | Textarea aria-describedby | DUZELTILMIS |
| BUG-014 | Table.tsx | String(column.key) karsilastirma | DUZELTILMIS |
| BUG-017 | Button.tsx | Dual loading prop uyarisi | DUZELTILMIS |
| BUG-018 | validation.ts | hasErrors empty string check | DUZELTILMIS |
| BUG-019 | DataTable.tsx | Firefox download appendTo body | DUZELTILMIS |
| BUG-020 | Sidebar.tsx | Inert items span render | DUZELTILMIS |
| PERF-001 | AuthContext.tsx | Context value memoization | DUZELTILMIS |
| PERF-002 | DataTable.tsx | processedData stable ref uyarisi | BELGELENMIS |
| PERF-005 | useAuth.ts | Token/tenantId read memoization | DUZELTILMIS |
| PERF-006 | Header.tsx, DataTable.tsx | Conditional listener/class memo | DUZELTILMIS |
| PERF-007 | Modal.tsx | Stable listener ref | DUZELTILMIS |
| PERF-010 | DataTable.tsx | Memoized TableBody | DUZELTILMIS |
| PERF-011 | validation.ts | Schema validation call-site uyari | BELGELENMIS |
| PERF-012 | useAuth.ts | Stable requiredRoles memo | DUZELTILMIS |
| PERF-014 | DataTable.tsx | Selection state memo | DUZELTILMIS |
| SEC-005 | AuthContext.tsx | Open redirect onlemi | DUZELTILMIS |
| SEC-006 | validation.ts | stripHtml XSS uyarisi | BELGELENMIS |
| SEC-008 | AuthContext.tsx | location.replace anti-pattern | DUZELTILMIS |
| SEC-010 | ApiError.tsx | Context prop XSS uyarisi | BELGELENMIS |
| SEC-011 | ApiError.tsx | showDetails DEV-only | DUZELTILMIS |
| SEC-013 | api-client.ts | getTenantId stale cache | DUZELTILMIS |
| SEC-014 | DataTable.tsx | CSV formula injection | DUZELTILMIS |
| SEC-015 | api-client.ts | crypto.randomUUID | DUZELTILMIS |
| CRIT-01 | api-client.ts | 401 retry limit | DUZELTILMIS |
| CRIT-4 | useAuth.ts | Single-role model semantics | BELGELENMIS |
| CRIT-5 | TenantContext.tsx | switchTenant not implemented | ACIK |

---

## 15. ONERILER

### 15.1 Kritik (P0)

| # | Oneri | Etki |
|---|---|---|
| 1 | Test suite olusturmak (en az api-client, AuthContext, validation) | Guvenilirlik |
| 2 | RestClient'ta `getAccessToken()` kullanmak (satir 477) | MF uyumluluk |
| 3 | useToast icin aria-live region eklemek | A11y |
| 4 | Warning buton kontrast oranini duzetmek | A11y/WCAG |
| 5 | `graphql` paketini package.json dependencies'e eklemek | Build guvenligi |

### 15.2 Yuksek (P1)

| # | Oneri | Etki |
|---|---|---|
| 6 | useGraphQLQuery/Mutation'i React Query ile degistirmek | Performans, caching |
| 7 | Placeholder hook'lari kaldirmak veya implemente etmek | API temizligi |
| 8 | Theme token'larini Tailwind preset olarak entegre etmek | Design tutarliligi |
| 9 | `cn()` utility'sini tum component'lerde kullanmak | Class conflict cozumu |
| 10 | switchTenant fonksiyonunu implemente etmek | Islevsellik |
| 11 | Sidebar'a aria-label eklemek | A11y |
| 12 | DataTable menu state'lerini child component'lere tasimak | Performans |

### 15.3 Orta (P2)

| # | Oneri | Etki |
|---|---|---|
| 13 | Table ve DataTable props API'lerini uyumlastirmak | DX tutarliligi |
| 14 | Tier feature listesini backend'den cekecek mekanizma | Esneklik |
| 15 | Storybook story'leri yazmak | Dokumantasyon |
| 16 | Sub-path exports eklemek (selective import) | Bundle size |
| 17 | i18n destegi (en azindan a11y label'lari icin) | Uluslararasilastirma |

---

## 16. DOSYA REFERANSLARI

| Dosya | Satir | Konu |
|---|---|---|
| `src/contexts/AuthContext.tsx` | 476-521 | useAuthContext MF fallback |
| `src/utils/api-client.ts` | 76-180 | Token yonetimi |
| `src/utils/api-client.ts` | 477 | RestClient dogrudan accessToken kullanimi |
| `src/hooks/useGraphQL.ts` | 178-203 | Placeholder hooks |
| `src/utils/validation.ts` | 558-573 | stripHtml SEC-006 uyarisi |
| `src/styles/theme.ts` | 1-346 | Kullanilmayan theme tokens |
| `src/utils/index.ts` | 13-15 | cn() utility (kullanilmiyor) |
| `src/contexts/TenantContext.tsx` | 86-88 | switchTenant not implemented |
| `src/hooks/useTenant.ts` | 70-116 | Hardcoded tier features |

---

*Rapor sonu - D13 Shared UI Library Audit*
