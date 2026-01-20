# /farms → /sites Dönüşümü ve Gerçek Site Verisi

## Özet

1. `/farms` linkini tamamen kaldır
2. `/farms/map` → `/sites/map` olarak değiştir
3. Haritada gerçek Sites verisi göster (mock veri değil)

## Değiştirilecek Dosyalar

### 1. Shell - App.tsx (Route Değişikliği)

**Dosya:** `web/shell/src/App.tsx`

**Mevcut (line 162-171):**
```typescript
<Route
  path="/farms/*"
  element={
    <ErrorBoundary moduleName="Farm">
      <Suspense fallback={<RemoteModuleLoader moduleName="Farm" />}>
        <FarmModule />
      </Suspense>
    </ErrorBoundary>
  }
/>
```

**Yeni:**
```typescript
<Route
  path="/sites/*"
  element={
    <ErrorBoundary moduleName="Farm">
      <Suspense fallback={<RemoteModuleLoader moduleName="Sites" />}>
        <FarmModule />
      </Suspense>
    </ErrorBoundary>
  }
/>
```

### 2. Shell - MainLayout.tsx (Navigation Değişikliği)

**Dosya:** `web/shell/src/layouts/MainLayout.tsx`

**Mevcut MODULE_NAV_CONFIG (lines 194-209):**
```typescript
farm: {
  id: 'farm-module',
  label: 'Farm Management',
  icon: 'farm',
  children: [
    { id: 'farms-list', label: 'Farms', path: '/farms' },
    { id: 'farms-setup', label: 'Setup', path: '/farms/setup' },
    { id: 'farms-map', label: 'Map View', path: '/farms/map' },
    // ...
  ],
},
```

**Yeni:**
```typescript
farm: {
  id: 'farm-module',
  label: 'Site Management',
  icon: 'farm',
  children: [
    { id: 'sites-map', label: 'Site Map', path: '/sites/map' },
    { id: 'sites-setup', label: 'Setup', path: '/sites/setup' },
    { id: 'sites-tanks', label: 'Tanks & Ponds', path: '/sites/tanks' },
    { id: 'sites-species', label: 'Species', path: '/sites/species' },
    { id: 'sites-feeding', label: 'Feeding', path: '/sites/feeding' },
    { id: 'sites-harvest', label: 'Harvest', path: '/sites/harvest' },
    { id: 'sites-production', label: 'Production', path: '/sites/production' },
  ],
},
```
> NOT: `farms-list` ('/farms') kaldırıldı

### 3. Farm Module - Module.tsx (Internal Routes)

**Dosya:** `web/modules/farm-module/src/Module.tsx`

**Mevcut:**
```typescript
<Routes>
  <Route index element={<FarmListPage />} />
  <Route path="map" element={<MapViewPage />} />
  // ...
</Routes>
```

**Yeni:**
```typescript
<Routes>
  {/* index route kaldırıldı - /sites direkt /sites/map'e yönlendir */}
  <Route index element={<Navigate to="map" replace />} />
  <Route path="map" element={<MapViewPage />} />
  // ...
</Routes>
```

### 4. Farm Module - MapViewPage.tsx (Gerçek Veri)

**Dosya:** `web/modules/farm-module/src/pages/MapViewPage.tsx`

**Kaldırılacak:** `mockFarms` array (lines 31-56)

**Eklenecek:**
```typescript
const ACTIVE_SITES_QUERY = `
  query ActiveSites {
    activeSites {
      id
      name
      code
      type
      status
      location { latitude longitude }
      address { city country }
      isActive
    }
  }
`;

// State ve fetch logic
const [sites, setSites] = useState([]);
const [loading, setLoading] = useState(true);

useEffect(() => {
  fetchSites();
}, []);

const fetchSites = async () => {
  const token = localStorage.getItem('access_token');
  const response = await fetch('/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ query: ACTIVE_SITES_QUERY }),
  });
  const { data } = await response.json();
  setSites(data.activeSites || []);
  setLoading(false);
};

// Site → Map marker dönüşümü
const mapSites = sites
  .filter(s => s.location?.latitude && s.location?.longitude)
  .map(site => ({
    id: site.id,
    name: site.name,
    type: site.type?.toLowerCase() || 'land_based',
    status: site.status?.toLowerCase() || 'active',
    coordinates: {
      lat: site.location.latitude,
      lng: site.location.longitude,
    },
    location: [site.address?.city, site.address?.country].filter(Boolean).join(', '),
  }));
```

### 5. Silinecek/Temizlenecek Dosyalar

| Dosya | Aksiyon |
|-------|---------|
| `web/modules/farm-module/src/pages/FarmListPage.tsx` | Sil veya içini boşalt |
| `web/modules/farm-module/src/pages/MapViewPage.tsx` | mockFarms kaldır |
| `web/modules/farm-module/src/pages/FarmDetailPage.tsx` | mockFarm, mockSensors kaldır |
| `web/modules/farm-module/src/pages/SensorDashboardPage.tsx` | mockSensorGroups kaldır |

## Uygulama Sırası

1. Shell App.tsx - `/farms/*` → `/sites/*`
2. Shell MainLayout.tsx - Navigation güncelle, `/farms` linkini kaldır
3. Farm Module Module.tsx - index route'u map'e yönlendir
4. Farm Module MapViewPage.tsx - GraphQL ile gerçek sites çek
5. Mock verileri temizle
6. Build ve test

## Sonuç

- `/farms` → 404 (kaldırıldı)
- `/sites` → `/sites/map`'e yönlendir
- `/sites/map` → Veritabanındaki gerçek Sites gösterir
