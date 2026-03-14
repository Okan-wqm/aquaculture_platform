# Grup N - React.lazy Code Splitting & AdminDashboard Concurrent Fetch Fix

**Tarih:** 2026-03-14
**Grup:** N (Frontend Performans)
**Sprint:** 2

---

## H3: React.lazy Code Splitting (Module.tsx)

### Sorun
Admin panel'deki 38 route, tum sayfa componentlerini eager import ile yuklemekteydi. Bu, admin panelinin ilk yuklenmesinde tum sayfa chunk'larinin indirilmesine neden oluyordu - kullanici sadece dashboard'u gorse bile diger 37 sayfanin kodu da transfer ediliyordu.

### Cozum
- **Dosya:** `/var/aqua-saas/web/modules/admin-panel/src/Module.tsx`
- Tum 38 sayfa import'u `React.lazy(() => import(...))` ile degistirildi
- `security/` ve `system/` alt dizinlerindeki sayfalar barrel export yerine dogrudan dosya yollarindan lazy import edildi (React.lazy default export gerektirir, barrel named re-export ile calismaz)
- Tum Route'lar tek bir `<Suspense>` ile sarildi
- Fallback olarak `@aquaculture/shared-ui` paketinden `Spinner` componenti kullanildi

### Degisiklikler
| Once | Sonra |
|------|-------|
| `import AdminDashboard from './pages/AdminDashboard'` | `const AdminDashboard = lazy(() => import('./pages/AdminDashboard'))` |
| `import { ActivityLogPage } from './pages/security'` | `const ActivityLogPage = lazy(() => import('./pages/security/ActivityLogPage'))` |
| `import { FeatureTogglesPage } from './pages/system'` | `const FeatureTogglesPage = lazy(() => import('./pages/system/FeatureTogglesPage'))` |
| `<Routes>...</Routes>` (Suspense yok) | `<Suspense fallback={<SuspenseFallback />}><Routes>...</Routes></Suspense>` |

### Dogrulama
- Tum security sayfalarinda (4 adet) ve system sayfalarinda (7 adet) `export default` mevcut - lazy import uyumlu
- Toplam 38 route, 38 lazy import

---

## H17: AdminDashboard Concurrent Fetch (AbortController)

### Sorun
`AdminDashboard.tsx` her 30 saniyede `setInterval` ile veri cekiyordu. Ancak:
1. Onceki fetch tamamlanmadan yeni bir fetch baslatilabiliyordu (yavas agda birikim)
2. Component unmount edildiginde in-flight request'ler iptal edilmiyordu (state update on unmounted component uyarisi)
3. `setInterval` pattern'i, fetch suresi + 30 saniye yerine sabit 30 saniye araligi dayatiyordu

### Cozum
- **Dosya:** `/var/aqua-saas/web/modules/admin-panel/src/pages/AdminDashboard.tsx`
- `useRef` ile `AbortController` ve `setTimeout` referanslari eklendi
- `setInterval` yerine `setTimeout` + recursive async pattern kullanildi
- Her yeni fetch oncesinde eski `AbortController.abort()` cagriliyor
- `controller.signal.aborted` kontrolu ile iptal edilen isteklerin sonuclari discard ediliyor
- Cleanup fonksiyonu hem controller'i abort ediyor hem timeout'u temizliyor

### Degisiklikler
```typescript
// Once (sorunlu):
useEffect(() => {
  fetchDashboardData();
  const interval = setInterval(fetchDashboardData, 30000);
  return () => clearInterval(interval);
}, [fetchDashboardData]);

// Sonra (guvenli):
useEffect(() => {
  const controller = new AbortController();
  abortControllerRef.current = controller;

  const scheduleFetch = async () => {
    await fetchDashboardData();
    if (!controller.signal.aborted) {
      refreshTimeoutRef.current = setTimeout(scheduleFetch, 30000);
    }
  };

  scheduleFetch();

  return () => {
    controller.abort();
    if (refreshTimeoutRef.current) {
      clearTimeout(refreshTimeoutRef.current);
    }
  };
}, [fetchDashboardData]);
```

### Concurrency Korumasi Detaylari
1. **Abort onceki:** `fetchDashboardData` icinde her yeni cagri oncesinde `abortControllerRef.current.abort()` cagriliyor
2. **Sonuc discard:** `controller.signal.aborted` true ise `setData` cagirilmiyor
3. **Recursive timeout:** Sonraki fetch ancak onceki tamamlandiktan sonra planlanir (30sn timer fetch sonrasinda baslar)
4. **Cleanup:** Unmount'ta hem abort hem clearTimeout

---

## Etkilenen Dosyalar

| Dosya | Degisiklik |
|-------|-----------|
| `web/modules/admin-panel/src/Module.tsx` | 38 eager import -> React.lazy + Suspense |
| `web/modules/admin-panel/src/pages/AdminDashboard.tsx` | setInterval -> AbortController + setTimeout recursive |

## Test Kontrol Listesi
- [ ] Admin panel ilk yuklemede sadece dashboard chunk'i indirildigini dogrula (Network tab)
- [ ] Diger sayfalara navigasyonda lazy chunk yuklendigini dogrula
- [ ] Suspense fallback (spinner) gosterildigini dogrula
- [ ] Dashboard 30 saniyede bir veri yeniledigini dogrula
- [ ] Yavas agda concurrent fetch birikmedigini dogrula (Network tab throttling)
- [ ] Sayfadan cikildiginda in-flight request'lerin iptal edildigini dogrula
- [ ] TypeScript derleme hatasi olmadigini dogrula (`tsc --noEmit`)
