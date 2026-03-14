# D07 - AquaMobil PWA Audit Raporu

**Auditor:** Mobil Uygulama Uzmani (D7)
**Tarih:** 2026-03-14
**Kapsam:** AquaMobil PWA - Enterprise Mobil Guvenlik ve UX Analizi
**Kaynak:** `web/apps/aquamobil/`

---

## 1. Dosya Yapisi ve Sayfa/Route Listesi

### 1.1 Genel Mimari

AquaMobil, Module Federation shell'den **tamamen bagimsiz** bir Vite React PWA'dir. Kendi
`package.json`, build pipeline ve deploy sureci vardir. `/mobile` path altinda nginx reverse
proxy uzerinden sunulur. Konsta UI (iOS/Material otomatik tema) + Tailwind CSS + Lucide
ikonlari kullanir.

### 1.2 Dizin Yapisi

```
src/
  main.tsx                           # React root, SW registration, Konsta theme
  App.tsx                            # Router: ProtectedRoute + FeatureRoute guard
  vite-env.d.ts
  styles/main.css                    # Tailwind + custom utilities

  pages/
    LoginPage.tsx                    # Giris ekrani
    HomePage.tsx                     # Dashboard: tank kartlari + quick actions
    record/RecordHubPage.tsx         # Record islem hub (feeding/mortality/cull/harvest/transfer)
    mortality/RecordMortalityPage.tsx # Olum kaydi formu
    cull/RecordCullPage.tsx          # Ayiklama kaydi
    harvest/RecordHarvestPage.tsx    # Hasat kaydi
    feeding/RecordFeedingPage.tsx    # Gunluk yemleme kaydi
    transfer/RecordTransferPage.tsx  # Tank arasi transfer
    tasks/MyTasksPage.tsx            # Gorev listesi (today/upcoming/overdue)
    tasks/TaskDetailPage.tsx         # Gorev detay + checklist + notlar
    hr/HrHubPage.tsx                 # IK islem hub
    attendance/AttendancePage.tsx     # Clock in/out (GPS destekli)
    leave/MyLeavesPage.tsx           # Izin bakiye ve gecmis
    leave/LeaveRequestPage.tsx       # Yeni izin talebi
    schedule/MySchedulePage.tsx      # Haftalik vardiya plani
    sync/SyncStatusPage.tsx          # Offline kuyruk durumu
    notifications/NotificationsPage.tsx # Bildirimler
    more/MorePage.tsx                # Daha fazla menu

  layouts/
    MobileLayout.tsx                 # Alt tab nav + offline banner

  components/
    cards/TankCard.tsx               # Tank durum karti
    cards/TaskCard.tsx               # Gorev karti
    InstallPrompt.tsx                # PWA kurulum banner
    NotificationBell.tsx             # Bildirim ikonu + badge

  hooks/
    useAuth.tsx                      # Auth context (login/logout/refresh)
    useTanks.ts                      # Tank listesi (useQuery + IndexedDB fallback)
    useOfflineQueue.tsx              # Offline kuyruk yonetimi context
    useMobilePermissions.ts          # Ozellik bazli erisim kontrol context
    useNetworkStatus.ts              # Online/offline algilama (probe destekli)
    useFirebaseMessaging.ts          # FCM push notification
    useNotifications.ts              # In-app bildirim CRUD
    useMyTasks.ts                    # Gorev listesi + cache
    useTaskActions.ts                # Gorev aksiyonlari (start/complete)
    useAttendance.ts                 # Devam kayitlari
    useLeave.ts                      # Izin islemleri
    useMySchedule.ts                 # Vardiya plani

  pwa/
    offline-queue.ts                 # IndexedDB kuyruk + AES-GCM sifreleme

  graphql/
    operations.ts                    # Tum GraphQL query/mutation string'leri

  types/
    index.ts                         # TypeScript tip tanimlari

public/
  firebase-messaging-sw.js          # FCM background SW
  manifest.webmanifest               # PWA manifest
  icons/                             # PWA ikonlari (192x192, 512x512)
```

### 1.3 Route Tablosu

| Path | Sayfa | Guard | Ozellik |
|------|-------|-------|---------|
| `/login` | LoginPage | Public | - |
| `/` | HomePage | ProtectedRoute | - |
| `/record` | RecordHubPage | ProtectedRoute | - |
| `/mortality/record[/:tankId]` | RecordMortalityPage | FeatureRoute(mortality) | Olum kaydi |
| `/cull/record[/:tankId]` | RecordCullPage | FeatureRoute(cull) | Ayiklama |
| `/harvest/record[/:tankId]` | RecordHarvestPage | FeatureRoute(harvest) | Hasat |
| `/feeding/record[/:tankId]` | RecordFeedingPage | FeatureRoute(feeding) | Yemleme |
| `/transfer/record[/:tankId]` | RecordTransferPage | FeatureRoute(transfer) | Transfer |
| `/tasks` | MyTasksPage | FeatureRoute(tasks) | Gorevler |
| `/tasks/:taskId` | TaskDetailPage | FeatureRoute(tasks) | Gorev detay |
| `/hr` | HrHubPage | ProtectedRoute | IK hub |
| `/attendance` | AttendancePage | FeatureRoute(attendance) | Devam |
| `/leave` | MyLeavesPage | FeatureRoute(leave) | Izinler |
| `/leave/request` | LeaveRequestPage | FeatureRoute(leave) | Izin talebi |
| `/schedule` | MySchedulePage | FeatureRoute(schedule) | Vardiya |
| `/sync` | SyncStatusPage | ProtectedRoute | Sync durumu |
| `/notifications` | NotificationsPage | ProtectedRoute | Bildirimler |
| `/more` | MorePage | ProtectedRoute | Ayarlar/menu |

**Toplam:** 18 route, 16 sayfa bilecseni. Tum ozellik sayfalari lazy-loaded (code splitting).

---

## 2. Auth Flow Analizi

### 2.1 Login Mekanizmasi

- **Endpoint:** `/graphql` uzerinden `Login` mutation (email + password)
- **Token Donusu:** `accessToken` response body'de doner; `refreshToken` **httpOnly cookie**
  olarak backend tarafindan set edilir
- **Token Depolama:** `accessToken` yalnizca React state'te (in-memory) tutulur.
  `localStorage`'a yazilmaz (SEC-01 fix uygulanmis)
- **Session Restore:** Sayfa yenilendiginde `RefreshToken` mutation'i httpOnly cookie ile
  calistirilir. Cookie'den refresh token okunur, yeni accessToken alinir
- **Mobile Access Check:** Login sonrasi `getMyMobileSettings` sorgusu ile kullanicinin
  mobil erisim yetkisi kontrol edilir

### 2.2 Token Yonetimi

| Ozellik | Durum | Detay |
|---------|-------|-------|
| accessToken depolama | GUVENLI | Yalnizca in-memory (React state) |
| refreshToken depolama | GUVENLI | httpOnly cookie (backend kontrol) |
| localStorage kullanimi | YOK | Token'lar localStorage'a yazilmiyor |
| Token refresh | MEVCUT | `refreshAuth()` fonksiyonu + silent refresh on mount |
| CSRF koruması | MEVCUT | `X-Requested-With: XMLHttpRequest` header (SEC-06) |
| credentials: 'include' | MEVCUT | Cookie'lerin gonderimi icin |
| Logout cleanup | MEVCUT | IndexedDB + Cache Storage + state temizligi (BUG-03/SEC-02/SEC-04) |

### 2.3 Biometric Auth

**DURUM: YOK**

WebAuthn/FIDO2, FaceID, TouchID veya herhangi bir biyometrik dogrulama mekanizmasi
implemente edilmemis. Login sadece email/password ile gerceklesir.

**Oneri (ORTA):** Saha calisanlari icin WebAuthn credential'lar olusturularak biometric
login secenegi eklenmeli. Bu, paylasimli cihazlarda guvenlik artirirken kullanici
deneyimini iyilestirir.

---

## 3. Offline Capability

### 3.1 Service Worker

- **Kayit:** `vite-plugin-pwa` ile `registerType: 'autoUpdate'` (otomatik guncelleme)
- **Workbox stratejileri:**
  - Statik asset'ler (JS/CSS/WOFF2): `CacheFirst` (7 gun, max 100 entry)
  - Goruntuler (PNG/JPG/WEBP): `StaleWhileRevalidate` (30 gun, max 100 entry)
  - GraphQL: **Kasitli olarak kaldirilmis** (SEC-02/CRIT-2) - Tenant veri sizintisi riski
- **Precaching:** `globPatterns: ['**/*.{js,css,html,ico,png,woff2}']`
- **Firebase SW:** Ayri `firebase-messaging-sw.js` dosyasi (background push)

### 3.2 IndexedDB Offline Queue

**Mimari:** `idb-keyval` kutuphanesi ile iki ayri IndexedDB store:

| Store | Amac | Prefix |
|-------|------|--------|
| `aquamobil-queue` | Islem kuyrugu | `pending_` |
| `aquamobil-cache` | Veri cache | `cache_` |

**Desteklenen Offline Islemler (10 adet):**

| OperationType | Aciklama |
|--------------|----------|
| `recordMortality` | Olum kaydi |
| `recordCull` | Ayiklama kaydi |
| `createHarvestRecord` | Hasat kaydi |
| `recordFeeding` | Yemleme kaydi |
| `clockIn` | Giris kaydi |
| `clockOut` | Cikis kaydi |
| `createLeaveRequest` | Izin talebi |
| `completeTask` | Gorev tamamlama |
| `startTask` | Gorev baslama |
| `recordTransfer` | Transfer kaydi |

### 3.3 Payload Sifreleme (SEC-03)

**OLUMLU:** Offline kuyruga yazilan payload'lar **AES-GCM 256-bit** ile sifrelenir.

- Anahtar: `crypto.subtle.generateKey()` ile oturum basina uretilir (in-memory, non-extractable)
- Her payload icin benzersiz 12-byte IV uretilir
- Uygulama kapatildiginda anahtar kaybolur; eski sifrelenmis veriler okunamaz hale gelir
- Logout'ta `clearAllOperations()` ile tum kuyruk temizlenir

**Sinirlamalar:**
- Anahtar yalnizca bellekte tutulur; sayfa yenileme sonrasi eski kuyruk entryleri okunamaz
  (null donup atlanir, crash etmez)
- Cache store'daki veri (`cache_` prefix) **sifrelenmemis** olarak tutulur -- tank verileri,
  gorev listesi, devam kayitlari duz metin olarak IndexedDB'de kalir

**Bulgu SEC-03-A (ORTA):** Cache store verisi sifrelenmemis. Tank biyokas verileri, alici
adlari (harvest buyerName icin), GPS konumlari (attendance) gibi hassas bilgiler duz metin
olarak IndexedDB'de tutulur. `cacheData()` fonksiyonu sifreleme uygulamiyor.

### 3.4 Sync Mekanizmasi

- **Otomatik sync:** Network geri geldiginde 1 saniye gecikme ile otomatik tetiklenir
- **Manuel sync:** SyncStatusPage'den "Sync Now" butonu
- **Background Sync:** `SyncManager` API kullanimi (sadece Chrome/Android)
- **Retry politikasi:** Maksimum 3 deneme; 3+ hata alanlar kalici olarak takili kalir
- **Stale sync koruması:** `syncing` durumunda kalmis islemler `pending`'e resetlenir (CRIT-4)
- **Auth guard:** Background sync sadece gecerli auth varsa register edilir (SEC-09)

### 3.5 Network Detection (BUG-15 fix)

`navigator.onLine` yaniltici olabilecegi icin (WiFi bagli ama internet yok durumu), her
30 saniyede `/graphql` endpoint'ine HEAD probe gonderilerek gercek baglanti kontrol edilir.
Offline iken probe araligi 10 saniyeye duser.

---

## 4. Push Notification

### 4.1 Firebase Cloud Messaging (FCM)

- **Konfigürasyon:** Environment variable'lardan (`VITE_FIREBASE_*`) okunur
- **Izin isteme:** `Notification.requestPermission()` ile tarayici izni
- **Token kayit:** Backend'e `RegisterDeviceToken` mutation'i ile bildirilir
- **Foreground:** `onMessage()` listener ile `CustomEvent` dispatch edilir
- **Background:** `firebase-messaging-sw.js` service worker'i `onBackgroundMessage()` handler

### 4.2 In-App Bildirimler

- 60 saniyede bir unread count polling
- Bildirim icindeki `data.taskId` ile gorev sayfasina navigasyon
- `markAsRead`, `markAllAsRead` mutation'lari

### 4.3 Guvenlik Degerlendirmesi

| Kontrol | Durum | Aciklama |
|---------|-------|----------|
| FCM token server'a kaydi | MEVCUT | `registerDeviceToken` mutation |
| Token degisim algilama | MEVCUT | `previousTokenRef` ile kontrol |
| Auth reset on logout | MEVCUT | `registeredRef` sifirlaniyor |
| Payload sifreleme | EKSIK | FCM payload'lar duz metin |
| SW kaynak dosyasi | RISKLI | CDN'den Firebase compat yukleniyor |

**Bulgu PUSH-01 (DUSUK):** `firebase-messaging-sw.js` icerisinde Firebase SDK
`importScripts('https://www.gstatic.com/firebasejs/10.8.0/...')` ile CDN'den yukleniyor.
Subresource Integrity (SRI) yok; CDN tehlikeye girerse SW kontamine olabilir. Ancak
Firebase CDN'in guvenilirligi goz onune alindiginda risk dusuktur.

**Bulgu PUSH-02 (BILGI):** `firebase-messaging-sw.js` icindeki default bildirim
metni Turkce (`'Bildirim'`), ancak uygulamanin geri kalani tamamen Ingilizce. Tutarsizlik.

---

## 5. RBAC - Rol Bazli Erisim Kontrolu

### 5.1 Mekanizma

`MobilePermissionsProvider` (context) + `FeatureRoute` (guard) + `canAccess()` (hook)
uclusu ile calisir.

**11 MobileFeature enum degeri:**
`mortality | cull | harvest | feeding | waterQuality | tankView | schedule | attendance | leave | tasks | transfer`

### 5.2 Izin Akisi

1. Login sonrasi `getMyMobileSettings` query backend'den cagrilir
2. `{ isMobileEnabled, allowedFeatures }` objesi alinir
3. Per-user IndexedDB key (`mobile_permissions_{userId}`) ile 8 saatlik cache yapilir
4. Network hatasinda cache'den okunur
5. `FeatureRoute` guard'i `canAccess(feature)` ile kontrol eder; yetkisiz ise `/` yonlendirir
6. `MobileLayout` tab bar'inda yetkisiz tab'lar gizlenir
7. `TankCard` icindeki aksiyon butonlari da `canAccess()` ile filtrelenir

### 5.3 Guvenlik Degerlendirmesi

| Kontrol | Durum |
|---------|-------|
| Per-user izin cache | MEVCUT (SEC-04) |
| Logout'ta izin temizligi | MEVCUT |
| 401'de izin reset | MEVCUT |
| Backend tarafli yetki kontrolu | VARSAYILAN (GraphQL resolver seviyesinde) |
| Default izin degerleri | RISKLI |

**Bulgu RBAC-01 (ORTA):** `DEFAULT_SETTINGS` tum temel ozellikleri `true` olarak ayarliyor.
Backend'e ulasilamadigi ve cache'de veri olmadigi durumda (yeni kullanici, yeni cihaz,
cache expired) kullanici **tum ozelliklere erisim kazanir**. Bu, frontend-only bir
kontrol oldugu icin backend'te de izin kontrolunun mevcut olmasi beklenir, ancak client-side
guard'in fail-open davranisi ihlal girisimleri icin bir pencere acar.

```typescript
// useMobilePermissions.ts satir 34-49
const DEFAULT_SETTINGS: MobileSettings = {
  isMobileEnabled: true,     // <-- Default olarak mobil erisim acik
  allowedFeatures: {
    mortality: true,          // <-- Tum ozellikler acik
    cull: true,
    harvest: true,
    // ...
  },
};
```

**Oneri:** Default degerler `false` olmali; izinler yalnizca backend'ten basariyla
alindiginda aktif olmali.

---

## 6. API Iletisimi

### 6.1 Base URL ve Proxy

- **Gelistirme:** Vite dev proxy `/graphql -> http://localhost:3000`
- **Uretim:** Nginx reverse proxy `/mobile/ -> http://aquamobil/`
- **API:** Tum GraphQL istekleri relative path `/graphql` uzerinden

### 6.2 Interceptor ve Header'lar

Merkezi bir HTTP interceptor **yok**. Her hook kendi `fetch()` cagrisini yapiyor.
Ancak tutarli pattern uygulanmis:

```typescript
headers: {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${accessToken}`,
  'X-Tenant-Id': tenantId,
  'X-Requested-With': 'XMLHttpRequest',  // CSRF defense (SEC-06)
}
```

### 6.3 Retry Mekanizmasi

- **React Query:** `failureCount < 3` retry; 401/403'te retry yok
- **Offline Queue:** 3 deneme siniri, sonra permanent fail
- **networkMode:** `offlineFirst` -- offline'da cache'den servir eder

### 6.4 Error Handling

- GraphQL hatalari `result.errors[0].message` olarak parse edilir
- Error mesajlari 200 karaktere truncate edilir (SEC-07)
- Formlar `errors` state objesi ile inline hata gosterir
- Network hatasinda IndexedDB cache fallback (useTanks, useMyTasks)

### 6.5 Guvenlik Bulgusu

**Bulgu API-01 (DUSUK):** Merkezi HTTP interceptor olmaması nedeniyle:
- Token refresh otomasyonu her hook'ta ayri yonetilmiyor; 401 alindiginda
  `useAuth().refreshAuth()` otomatik tetiklenmeyip kullanici session kaybedebilir
- Rate limiting veya request deduplication client tarafinda yok (React Query staleTime
  ile kismen saglanmis)

---

## 7. Sensor Entegrasyonu (Kamera/GPS)

### 7.1 GPS (Geolocation API)

- **Kullanim:** Yalnizca `AttendancePage` icerisinde clock in/out sirasinda
- **API:** `navigator.geolocation.getCurrentPosition()`
- **Ayarlar:** `{ enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }`
- **Hata yonetimi:** GPS alinamazsa `null` olarak devam eder (zorunlu degil)
- **Veri:** `{ latitude, longitude, accuracy }` olarak queue'ya yazilir

**Bulgu GPS-01 (DUSUK):** GPS koordinatlari offline queue'ya sifrelenerek yazilir
(AES-GCM), ancak cache store'daki attendance kayitlari icin ayni koruma yok.

### 7.2 Kamera

**DURUM: YOK**

Uygulamada kamera, fotograf cekim veya MediaDevices API kullanan hicbir bilecsek bulunmuyor.
Olum kaydinda fotograf eki, hasat kalite fotosu gibi ozellikler mevcut degil.

**Oneri (BILGI):** Saha islemleri icin fotograf eki ozelligi (ornegin olum nedeni icin
fotograf, hasat kalite kontrolu goruntuleri) ileride eklenebilir.

---

## 8. Performance

### 8.1 Bundle Analizi

**Build konfigurasyonu (`vite.config.ts`):**
- `target: 'esnext'` -- modern tarayicilar icin optimize
- `sourcemap: false` (production) -- kaynak kodu gizlenir
- Manuel chunk ayrimi:
  - `vendor`: react, react-dom, react-router-dom
  - `query`: @tanstack/react-query
- Lazy loading: 11 sayfa bilecseni `React.lazy()` ile code-split

**Dist asset'leri (build output'u mevcut):**
- `index-_m5U7X78.js` -- ana bundle (lazy chunklari icerir)
- `vendor-CK9sMXuf.js` -- React core
- `query-D1wn77H8.js` -- TanStack Query
- `index-B0uCxQp1.css` -- tek CSS dosyasi
- `workbox-window.prod.es5-vqzQaGvo.js` -- SW yardimci

### 8.2 Optimizasyonlar

| Teknik | Durum | Detay |
|--------|-------|-------|
| Code splitting | MEVCUT | 11 lazy-loaded sayfa (PERF-02) |
| Permissions tek fetch | MEVCUT | Context provider ile (PERF-03) |
| Sync loop onleme | MEVCUT | Ref-based debounce (PERF-04) |
| IndexedDB sadece offline | MEVCUT | useQuery online, IDB offline fallback (PERF-05) |
| Source map kapatma | MEVCUT | Production'da (PERF-06) |
| FeedingPlan useQuery | MEVCUT | Manuel fetch yerine (PERF-07) |
| Ayri IDB store'lar | MEVCUT | Queue ve cache icin (PERF-08) |
| Tailwind JIT uyumu | MEVCUT | Statik sinif lookup map'i (PERF-09) |
| SW autoUpdate | MEVCUT | Prompt yerine otomatik (PERF-10) |

### 8.3 Potansiyel Sorunlar

**Bulgu PERF-01 (DUSUK):** `useNotifications` her 60 saniyede `fetchUnreadCount` polling
yapiyor. Uygulamada zaten FCM push notification mevcut oldugundan, bu polling gereksiz
network kullanimi ve pil tuketimi yaratabilir. Push event'leri ile unread count
guncellenebilir.

**Bulgu PERF-02 (BILGI):** DM Sans fontu Google Fonts CDN'den yukleniyor (render-blocking
olabilir). Font dosyasi self-host edilerek FCP iyilestirilebilir.

---

## 9. Responsive Tasarim

### 9.1 Viewport ve Safe Area

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0,
      viewport-fit=cover, user-scalable=no" />
```

- `viewport-fit=cover` + `env(safe-area-inset-*)` ile iPhone notch destegi
- `user-scalable=no` -- form zoom sorunlarini onler
- `overscroll-behavior-y: contain` -- pull-to-refresh onleme
- `-webkit-touch-callout: none` -- uzun basma menu'su onleme

### 9.2 Platform Algilama

- iOS tespiti: `navigator.userAgent` + `navigator.maxTouchPoints` (iPadOS 13+ dahil)
- `KonstaApp` tema otomasyonu: iOS -> ios temasi, diger -> material temasi
- `apple-mobile-web-app-status-bar-style: black-translucent`

### 9.3 Layout Yapisi

- **Bottom tab navigation:** 5 tab (Home, Record, Tasks, HR, More)
- **Max genislik:** Tab bar `max-w-lg mx-auto` ile sinirli
- **Icerik alani:** `flex-1 overflow-auto`
- **Safe area padding:** `pb-safe`, `pt-safe-top` utility class'lari

### 9.4 Tablet Uyumu

**Bulgu UX-01 (DUSUK):** Uygulama `orientation: 'portrait'` olarak kilitlenmis (manifest).
Tablet kullanicilar landscape modunda calisamaz. Tank grid'leri tablet'te 1 sutun olarak
kalir (grid-cols-3 max). Tablet icin ayri layout optimizasyonu yapilmamis.

**Bulgu UX-02 (BILGI):** PWA manifest `display: 'standalone'` + `scope: '/mobile/'` dogru
yapilandirilmis. Ancak `manifest.webmanifest` icindeki `start_url` ve `scope` `/` olarak
set edilmis (vite config'daki `/mobile/` ile uyumsuz). Vite plugin'in manifest
olusurmasi bunu override edeceginden pratikte sorun olmayabilir, ancak tutarsizlik mevcut.

---

## 10. Test Durumu

### 10.1 Test Altyapisi

**DURUM: MEVCUT DEGIL**

| Test Turu | Dosya Sayisi | Durum |
|-----------|-------------|-------|
| Unit test (*.test.ts/tsx) | 0 | YOK |
| Integration test (*.spec.ts/tsx) | 0 | YOK |
| E2E test | 0 | YOK |
| Linting | Mevcut | `eslint src --ext .ts,.tsx` script'i |
| Type checking | Mevcut | `tsc --noEmit` build step'inde |

**Bulgu TEST-01 (YUKSEK):** AquaMobil'de hicbir test dosyasi bulunmuyor. Offline queue
sifreleme/desifreleme, sync mekanizmasi, izin kontrolleri, form validasyon mantigi gibi
kritik is mantiklari test edilmemis durumda.

**Oneri:**
- `offline-queue.ts`: Sifreleme/desifreleme, queue CRUD, sync mantigi icin unit test
- `useMobilePermissions.ts`: Default/cache/network fallback senaryolari
- `useAuth.tsx`: Login/logout/refresh akislari
- Form validasyonlari: Quantity sinirlari, tarih kontrolleri
- E2E: Cypress veya Playwright ile kritik akislar (login -> record -> sync)

---

## 11. Mobil Guvenlik Odak

### 11.1 Token Storage - XSS Riski

| Depolama | Icerik | XSS Riski |
|----------|--------|-----------|
| React state (in-memory) | accessToken | DUSUK - XSS ile alinabilir ama persist etmez |
| httpOnly cookie | refreshToken | KORUNMALI - JS'den erisilemez |
| localStorage | Yalnizca `aquamobil_install_dismissed` | DUSUK - hassas veri yok |
| IndexedDB (queue store) | Sifrelenmis payload'lar | DUSUK - AES-GCM ile korunuyor |
| IndexedDB (cache store) | Tank/gorev/devam verileri | ORTA - Duz metin |

**Deger:** Token yonetimi guvenli yapilmis. `accessToken` localStorage yerine in-memory;
`refreshToken` httpOnly cookie. Onceki Knowledge Base'de bahsedilen `localStorage`
kullanimi (access_token, refresh_token) artik gecerli degil -- uygulama guncellenmis.

### 11.2 Certificate Pinning

**DURUM: YOK**

PWA olarak tarayicida calisan bir web uygulamasi oldugu icin certificate pinning native
uygulama seviyesinde mumkun degildir. Ancak:

- HSTS header'i nginx tarafindan set edilmeli (kontrol edilmedi)
- Public Key Pinning (HPKP) deprecated oldugu icin uygulanamaz
- CT (Certificate Transparency) log monitoring onerisi gecerlidir

### 11.3 Deep Link Hijacking

**Risk Seviyesi: DUSUK**

- PWA scope `/mobile/` ile sinirli
- Tum navigasyon SPA icinde `react-router-dom` ile gerceklesir
- manifest.webmanifest `scope: '/'` (vite override ile `/mobile/`)
- Harici deep link hedefi yok (notification'lar icin sadece `/tasks/:taskId` internal route)

**Bulgu DL-01 (BILGI):** Bildirim `data.taskId` ile navigasyon yapiliyor. taskId
`JSON.parse(notification.data)` ile parse ediliyor; hatayi yakalayan try-catch mevcut
ancak taskId'nin format validasyonu yok. Zararli bir push notification ile beklenmeyen
navigate path olusturulabilir, ancak ProtectedRoute + FeatureRoute guard'lari bunu sinirlar.

### 11.4 Offline Data Encryption

| Veri Katmani | Sifreleme | Detay |
|-------------|-----------|-------|
| Queue payload | AES-GCM 256 | Per-session key, non-extractable |
| Queue metadata | DUZ METIN | id, type, createdAt, retryCount, status |
| Cache data | DUZ METIN | Tank, gorev, devam kayitlari |
| Permissions cache | DUZ METIN | allowedFeatures objesi |

**Bulgu SEC-03-B (ORTA):** Queue metadata (islem tipi, zaman damgasi, hata mesaji)
sifrelenmemis. Bir saldirgan IndexedDB'den hangi islemlerin yapildigini gorebilir
(ornegin `recordMortality` tipi ve zamani).

### 11.5 Jailbreak/Root Detection

**DURUM: YOK**

PWA olarak tarayici ortaminda calistigindan donanim seviyesinde jailbreak/root tespiti
mumkun degildir. Bu bir native uygulama yetenegi olup PWA sinirliligi dahilindedir.

**Oneri (BILGI):** Eger hassas veri koruması gerekiyorsa, Capacitor/Ionic wrapper ile
native shell'e gecilerek jailbreak detection entegrasyonu dusunulebilir.

### 11.6 Screenshot Protection

**DURUM: YOK**

Web platform'da ekran goruntusu engelleme API'si bulunmamaz. CSS ile
`-webkit-user-select: none` uygulanmis (touchscreen icin), ancak ekran goruntusu
engellenemez.

**Bulgu SS-01 (BILGI):** Hasat sayfasinda alici adi (`buyerName`), fiyat (`pricePerKg`),
tahmin edilen deger gibi ticari olarak hassas bilgiler goruntulenir. Native wrapper
olmadan ekran goruntusu koruması uygulanamaz.

---

## 12. Ek Guvenlik Bulgulari

### 12.1 GraphQL Caching (CRIT-2 -- DUZELTILMIS)

Workbox runtime cache'inden GraphQL caching **kasitli olarak kaldirilmis**. Nedenleri:
1. Authenticated POST response'lari paylasimli cihazlarda tenant veri sizintisi yaratir
2. Workbox mutation/query ayiramaz
3. POST URL-key cache sadece bir response tutar

Bu duzeltme guvenlik acisindan onemli ve dogru uygulanmis.

### 12.2 Error Message Truncation (SEC-07)

Hata mesajlari 200 karaktere truncate ediliyor. Bu, server tarafli hata mesajlarinin
UI'da gosterilmesinden kaynaklanabilecek bilgi sizintisini sinirlar.

### 12.3 CSRF Koruması (SEC-06)

Tum GraphQL isteklerinde `X-Requested-With: XMLHttpRequest` header'i eklenmis. Bu,
basit CORS pre-flight atlama saldirilarini engeller. `credentials: 'include'` ile
birlikte SameSite cookie politikasina bagli olarak CSRF koruması saglanir.

### 12.4 Form Validasyon

Tum formlar client-side validasyon icermekte:
- Quantity sinir kontrolleri (min 1, max tankta mevcut miktar)
- Email format kontrolu (regex)
- Password minimum uzunluk (6 karakter client, 8 karakter HTML minLength)
- Tarih gecerlilik kontrolleri (izin bitis > baslangic)
- Input sanitizasyonu (non-numeric karakter filtreleme)

**Bulgu VAL-01 (DUSUK):** LoginPage'de `handleSubmit` password kontrolu 6 karakter
(`password.length < 6`), ancak HTML input'unda `minLength={8}` tanimli. Tutarsiz
validasyon -- 6 veya 8 olarak birlestirilmeli.

---

## 13. Kritik Bulgular Ozet Tablosu

| ID | Seviye | Baslik | Konum |
|----|--------|--------|-------|
| TEST-01 | YUKSEK | Hicbir test dosyasi yok | Tum proje |
| RBAC-01 | ORTA | Default izinler fail-open (tum true) | useMobilePermissions.ts:34-49 |
| SEC-03-A | ORTA | Cache store verisi sifrelenmemis | pwa/offline-queue.ts:168-193 |
| SEC-03-B | ORTA | Queue metadata sifrelenmemis | pwa/offline-queue.ts:74-81 |
| PUSH-01 | DUSUK | Firebase SW CDN'den SRI olmadan yukleniyor | firebase-messaging-sw.js:2-3 |
| PUSH-02 | BILGI | SW bildirim metni Turkce, uygulama Ingilizce | firebase-messaging-sw.js:15 |
| API-01 | DUSUK | Merkezi HTTP interceptor yok | Tum hooks |
| PERF-01 | DUSUK | Notification polling + FCM birlikte calisir | useNotifications.ts:109 |
| PERF-02 | BILGI | Font CDN'den yukleniyor | styles/main.css:1 |
| UX-01 | DUSUK | Tablet layout optimizasyonu yok | manifest + layout |
| UX-02 | BILGI | manifest.webmanifest scope uyumsuzlugu | manifest.webmanifest:5-6 |
| DL-01 | BILGI | Notification taskId format validasyonu yok | NotificationsPage.tsx:34 |
| VAL-01 | DUSUK | Password validasyon tutarsizligi (6 vs 8) | LoginPage.tsx:47 vs :150 |
| GPS-01 | DUSUK | Attendance cache verisi sifrelenmemis | pwa/offline-queue.ts |
| SS-01 | BILGI | Hassas ticari veri ekran goruntusu korumasiz | RecordHarvestPage.tsx |

---

## 14. Genel Degerlendirme

### 14.1 Guclu Yanlar

1. **Token Yonetimi:** accessToken in-memory, refreshToken httpOnly cookie -- modern ve guvenli
2. **Offline Payload Sifreleme:** AES-GCM 256-bit ile per-session sifreleme mevcut
3. **Logout Temizligi:** IndexedDB, Cache Storage, permissions tumu koordineli temizleniyor
4. **CSRF Koruması:** Tum isteklerde `X-Requested-With` header
5. **GraphQL Cache Kaldirilmasi:** Tenant veri sizintisi riski onlenmis
6. **RBAC:** Backend kaynakli izin sistemi, per-user cache, FeatureRoute guard
7. **Code Splitting:** 11 lazy-loaded sayfa ile performans optimize
8. **Network Detection:** Probe-based gercek baglanti kontrolu
9. **Sync Guard:** Auth olmadan background sync register edilmiyor
10. **Error Truncation:** Server hata mesajlari 200 karakterle sinirli

### 14.2 Zayif Yanlar

1. **Test yok** -- En kritik eksiklik. Sifreleme, sync, izin mantigi icin test gerekli
2. **Default izinler fail-open** -- Backend guard varsayimina bagli
3. **Cache verisi sifrelenmemis** -- Queue payload korunuyor ama cache duz metin
4. **Biometric auth yok** -- Saha calisanlari icin UX iyilestirme firsati
5. **Kamera entegrasyonu yok** -- Saha kayitlarina gorsel ekleme eksik
6. **Merkezi interceptor yok** -- Token refresh otomasyonu her hook'ta tekrar

### 14.3 Risk Ozeti

| Kategori | Risk Seviyesi |
|----------|---------------|
| Token Guvenligi | DUSUK (in-memory + httpOnly) |
| Offline Veri Guvenligi | ORTA (queue sifrelenmis, cache acik) |
| RBAC | ORTA (fail-open default) |
| Test Kapsamı | YUKSEK (sifir test) |
| Genel PWA Guvenligi | DUSUK-ORTA |

AquaMobil, PWA sinirlamalari dahilinde modern guvenlik uygulamalarini buyuk olcude
benimsemis bir uygulamadir. En acil aksiyon test altyapisinin olusturulmasidir.
