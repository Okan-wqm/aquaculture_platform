# SCADA Package Builder - Entegrasyon Dokumantasyonu

Bu dokuman, SCADA Package Builder'in placeholder durumdan tam calisir hale getirilmesi icin yapilan degisiklikleri detayli olarak aciklar.

---

## 1. Genel Bakis

SCADA Builder UI bilesenleri (WidgetPalette, ScreenCanvas, PropertiesPanel, DeployScadaDialog, widget-configs) onceden implement edilmisti ancak birbirine bagli degildi. Bu calisma ile:

- **BuilderPage** tum bilesenleri birbirine bagladi
- **Save/Load** gercek GraphQL mutation'lariyla calisiyor
- **Deploy** dialog entegre edildi
- **Tag Browser** sistemi eklendi (edge device I/O tag'lerini browse etme)
- **Hedef Cihaz Secici** toolbar'a eklendi
- **ScreenTabBar** component'i kullanilmaya baslandi

---

## 2. Yeni Dosyalar

### 2.1 TagBrowser.tsx
**Konum:** `web/modules/sensor-module/src/components/scada-builder/TagBrowser.tsx`

Edge device'in I/O konfigurasyonundan tag listesi gosteren searchable dropdown/autocomplete bileseni.

**Props:**
```typescript
interface TagBrowserProps {
  deviceId: string | null;    // Hedef edge device ID
  value: string;              // Secili tag adi
  onChange: (tagName: string) => void;
  placeholder?: string;
  multiple?: boolean;         // Coklu secim (TrendChart icin)
}
```

**Ozellikler:**
- Tag'leri I/O tipine gore gruplar: Analog Input (AI), Analog Output (AO), Digital Input (DI), Digital Output (DO)
- Her tag icin IO badge'i, tag adi, birim ve kanal numarasi gosterir
- Arama/filtre destegi
- Manuel metin girisi destegi (listede olmayan tag'ler icin)
- Multiple modda chip'ler ile coklu secim
- Empty state'ler: cihaz secilmemis, tag bulunamadi, yukleniyor

### 2.2 useDeviceTags.ts
**Konum:** `web/modules/sensor-module/src/hooks/useDeviceTags.ts`

Edge device'tan tag listesi cekmek icin hook.

```typescript
function useDeviceTags(deviceId: string | null): {
  tags: TagInfo[];
  groupedTags: TagGroup[];
  loading: boolean;
  error: string | null;
}
```

- Mevcut `useEdgeDevice` hook'unu kullanir
- `DeviceIoConfig` entity'sindeki `ioConfig` dizisinden aktif tag'leri parse eder
- Tag'leri AI > AO > DI > DO sirasinda gruplar

### 2.3 device-tags.queries.ts
**Konum:** `web/modules/sensor-module/src/graphql/device-tags.queries.ts`

Edge device I/O tag'leri icin odaklanmis GraphQL query. `edgeDevice(id)` query'sinin sadece `ioConfig` field'ini isteyen versiyonu.

---

## 3. Degisiklik Yapilan Dosyalar

### 3.1 ScadaPackageBuilderPage.tsx (Tam Yeniden Yazim)
**Konum:** `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx`

**Onceki durum:** Placeholder div'ler, no-op save/load handler'lari, deploy baglantisi yok.

**Yeni durum:**

#### Save/Load Entegrasyonu
- `useCreateScadaPackage` ve `useUpdateScadaPackage` mutation hook'lari kullaniliyor
- `packageId` varsa update, yoksa create cagrilir
- Basarili create sonrasi URL `/sensor/scada-builder/${newId}` olarak guncellenir (`useNavigate`)
- Basari toast'u (2 sn yesil badge)
- Mevcut paket yuklenirken loading spinner gosterilir
- `useScadaPackageById` ile route param'dan paket yuklenir

#### PropertiesPanel Entegrasyonu
- Placeholder div yerine gercek `<PropertiesPanel>` component'i render ediliyor
- Store'dan `selectedWidgetId` ile aktif widget bulunuyor
- `onWidgetConfigChange` → `updateWidget(screenId, widgetId, { config: {...existing, ...updates} })`
- `alarmRules`, `controlPermissions`, `trendConfig` store'dan okunup PropertiesPanel'e aktariliyor
- `deviceId` prop'u PropertiesPanel'e iletiliyor (widget config'lerdeki TagBrowser icin)

#### Deploy Entegrasyonu
- "Edge Device'a Deploy" butonu `DeployScadaDialog`'u acar
- Deploy oncesi kaydedilmemis degisiklik varsa otomatik save yapar
- `packageId`, `packageName`, `packageData` (toScadaPackageJSON) dialog'a aktarilir

#### Hedef Cihaz Secici (Toolbar)
- Paket adi yaninda device selector dropdown
- `useEdgeDevices` hook'u ile cihaz listesi
- Online/offline badge gosterimi
- Secilen device → store'daki `targetDeviceId`'ye yazilir
- Status bar'da secili cihaz bilgisi

#### ScreenTabBar Entegrasyonu
- Inline tab kodu kaldirildi, `<ScreenTabBar>` component'i kullaniliyor
- Tip secimli ekran ekleme (dashboard/process/alarms/trends/calibration/control)
- Sag-tik context menu: Yeniden Adlandir, Cokla, Varsayilan Yap, Sil

### 3.2 scadaPackageStore.ts
**Konum:** `web/modules/sensor-module/src/store/scadaPackageStore.ts`

**Eklenen state ve action'lar:**
- `targetDeviceId: string | null` — Secili edge device ID
- `setTargetDeviceId(id)` — Device ID guncelleme action'i
- `toScadaPackageJSON()` → `meta.edgeDeviceId` alani eklendi
- `loadFromJSON()` → `json.meta.edgeDeviceId` okunuyor

### 3.3 PropertiesPanel.tsx
**Konum:** `web/modules/sensor-module/src/components/scada-builder/PropertiesPanel.tsx`

**Degisiklikler:**
- `PropertiesPanelProps` interface'ine `deviceId?: string | null` eklendi
- Component props'unda `deviceId` destructure ediliyor
- `<ConfigComponent>` render'inda `deviceId={deviceId}` prop'u geciriliyor
- Bu sayede widget config'lerdeki TagBrowser hedef cihazin tag'lerini gorebiliyor

### 3.4 widget-configs/index.ts
**Konum:** `web/modules/sensor-module/src/components/scada-builder/widget-configs/index.ts`

- `WidgetConfigProps` interface'ine `deviceId?: string | null` eklendi
- Tum widget config component'leri bu yeni prop'u aliyor

### 3.5 Widget Config Dosyalari (11 adet)

Asagidaki dosyalarda tag/sensor text input'lari `<TagBrowser>` ile degistirildi:

| Dosya | Tag Tipi | Degisiklik |
|-------|----------|------------|
| `GaugeConfig.tsx` | `config.tag` (tekli) | Text input → TagBrowser |
| `NumericDisplayConfig.tsx` | `config.tag` (tekli) | Text input → TagBrowser |
| `StatusIndicatorConfig.tsx` | `config.tag` (tekli) | Text input → TagBrowser |
| `TankLevelConfig.tsx` | `config.tag` (tekli) | Text input → TagBrowser |
| `ToggleSwitchConfig.tsx` | `config.tag` (tekli) | Text input → TagBrowser |
| `SliderConfig.tsx` | `config.tag` (tekli) | Text input → TagBrowser |
| `NumericInputConfig.tsx` | `config.tag` (tekli) | Text input → TagBrowser |
| `PushButtonConfig.tsx` | `config.tag` (tekli) | Text input → TagBrowser |
| `TrendChartConfig.tsx` | `config.tags[]` (coklu) | Her tag input → TagBrowser |
| `CalibrationWizardConfig.tsx` | `config.sensors[]` (coklu) | Her sensor input → TagBrowser |
| `CalibrationStatusConfig.tsx` | `config.sensors[]` (coklu) | Her sensor input → TagBrowser |

Her dosyada yapilan degisiklikler:
1. `import { TagBrowser } from '../TagBrowser';` eklendi
2. `WidgetConfigProps` interface'ine `deviceId?: string | null` eklendi
3. Destructured props'a `deviceId` eklendi
4. `<input type="text">` → `<TagBrowser deviceId={deviceId || null} ... />` degistirildi

---

## 4. Edge Runtime Uyumluluk Kontrolu

Yapilan kontroller (degisiklik gerekmedi):

| Kontrol | Sonuc |
|---------|-------|
| 16 widget tipi edge HTML'de var mi? | Tumu mevcut |
| camelCase/kebab-case uyumlulugu | Tam uyumlu (serde rename_all = "camelCase") |
| `PackageMeta.edgeDeviceId` Rust struct'ta var mi? | Evet, `Option<String>` olarak mevcut |
| Widget type string eslemesi | Builder ve edge HTML ayni camelCase string'leri kullaniyor |

---

## 5. Veri Akisi

```
TagBrowser ──(deviceId)──> useDeviceTags ──> useEdgeDevice ──> GraphQL ──> Backend
                                                                              │
                                                                     DeviceIoConfig[]
                                                                              │
                                                                    ┌─────────┴─────────┐
                                                                    │ tagName, ioType,   │
                                                                    │ channel, engUnit   │
                                                                    └───────────────────-┘

ScadaPackageBuilderPage
  ├── WidgetPalette (sol panel)
  ├── ScreenTabBar + ScreenCanvas (orta panel)
  ├── PropertiesPanel (sag panel)
  │     ├── Widget tab → widgetConfigMap[type] → GaugeConfig/NumericDisplayConfig/...
  │     │                                          └── TagBrowser(deviceId)
  │     ├── Alarmlar tab → alarm kuralları
  │     ├── Kontrol tab → guvenlik seviyeleri + acil durdurma
  │     └── Trend tab → trend ayarlari
  ├── DeployScadaDialog (modal)
  └── Save/Load (GraphQL mutations)
```

---

## 6. Kullanim Akisi

1. `/sensor/scada-packages` → Liste sayfasi, "Yeni Paket" butonu
2. `/sensor/scada-builder/new` → Builder acilir, bos paket
3. Toolbar'dan hedef cihaz sec → TagBrowser'lar o cihazin tag'lerini gosterir
4. Widget ekle (palette'den surukleme) → Canvas'a duser
5. Widget sec → Sag panelde ozellikler gorunur, tag sec (TagBrowser)
6. Kaydet → GraphQL mutation (create veya update)
7. Deploy → Deploy dialog acilir, online cihaz sec, deploy et
8. `/sensor/scada-builder/:id` → Mevcut paketi yukle, duzenle, kaydet
