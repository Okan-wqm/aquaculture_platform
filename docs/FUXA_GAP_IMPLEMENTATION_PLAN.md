# FUXA Gap Implementation Plan

## FUXA Dokümantasyon Analizi → Aquaculture Platform Eksik Modüller

**Tarih:** 2026-03-17
**Kapsam:** FUXA'da olup bizim sistemde eksik olan tüm özellikler
**Mimari:** Enterprise-grade, React/NestJS, TypeScript-first

---

## GAP ÖZET MATRİSİ

| # | Kategori | Mevcut | Eksik | Öncelik |
|---|----------|--------|-------|---------|
| 1 | Device/Protocol | %60 | WebAPI adapter, tag DAQ wiring, tag browser UI, device health check | KRİTİK |
| 2 | Script System | %90 | $getDevice, $invokeObject, scale scripts on tags | ORTA |
| 3 | Event System | %90 | Tag mapping placeholders, "Set from Input" action | DÜŞÜK |
| 4 | View System | %60 | @[tag_name] placeholders, Target Device nav, view lifecycle scripts | YÜKSEK |
| 5 | Widget System | %70 | Bar/Pie chart widget types, $invokeObject | ORTA |
| 6 | Scheduler | %85 | Timer/Event mode, script-on-start/end actions | DÜŞÜK |
| 7 | Chart System | %65 | CSV export wiring, PDF reports | ORTA |
| 8 | Alarm System | %90 | runScript action stub, retention config UI | ORTA |
| 9 | Security | %85 | API key management | DÜŞÜK |
| 10 | Project Mgmt | %80 | Auto-save, standalone JSON export/import | ORTA |

**Not:** Node-RED entegrasyonu kasıtlı olarak atlandı — platformumuz IEC 61131-3 Structured Text kullanıyor.

---

## FAZ 1: Device/Protocol Altyapısı (KRİTİK)

### 1.1 WebAPI Protocol Adapter (Backend)

**Neden:** FUXA'da REST API polling ile cihaz verisi çekme desteği var. IoT gateway'lerden, 3rd party API'lerden veri çekmek için şart.

**Dosyalar:**
- `apps/sensor-service/src/protocol/adapters/webapi-adapter.ts` — YENİ
- `apps/sensor-service/src/protocol/adapters/webapi-adapter.types.ts` — YENİ

**Özellikler:**
- HTTP GET/POST polling (configurable interval: 1s-60s)
- JSON response parsing with JSONPath tag mapping
- Authentication: None, Basic, Bearer, API Key (header/query)
- SSL/TLS verification toggle
- Request headers configuration
- Response timeout (default 10s)
- Tag extraction: JSONPath expressions → tag values
- Error handling: retry with backoff, status code validation
- Device status: HTTP 2xx = online, timeout = offline, 4xx/5xx = error

### 1.2 Tag DAQ Settings Wiring (Backend + Frontend)

**Neden:** FUXA'da her tag'e ayrı ayrı DAQ ayarı (enabled, interval, deadband) verilebiliyor. Bizde tip tanımlı ama bağlı değil.

**Dosyalar:**
- `apps/sensor-service/src/scada-runtime/services/tag-manager.service.ts` — GÜNCELLE
- `apps/sensor-service/src/scada-runtime/services/daq-storage.service.ts` — GÜNCELLE
- `web/modules/sensor-module/src/components/scada-builder/tag-config/TagDaqSettingsPanel.tsx` — YENİ

**Özellikler:**
- TagManagerService: DAQ settings per tag (enabled/interval/deadband)
- Deadband filtering: only store when |newValue - lastStored| > deadband
- Interval-based storage: store at configured interval regardless of change
- "Changed" mode: store only on value change (beyond deadband)
- "Restored" mode: reload last stored value on startup
- Frontend panel: toggle enabled, set interval (ms), set deadband, preview

### 1.3 Generic Tag Browser Dialog (Frontend)

**Neden:** FUXA'da her protokol için tag'leri browse edip seçebiliyorsun. Bizde OPC-UA node browse var ama generic UI yok.

**Dosyalar:**
- `web/modules/sensor-module/src/components/scada-builder/tag-config/TagBrowserDialog.tsx` — YENİ
- `web/modules/sensor-module/src/components/scada-builder/tag-config/ProtocolTagTree.tsx` — YENİ
- `web/modules/sensor-module/src/hooks/useTagBrowser.ts` — YENİ

**Özellikler:**
- Modal dialog with device selector dropdown
- Protocol-aware tag tree (OPC-UA: node hierarchy, Modbus: register ranges, MQTT: topic list)
- Search/filter within tags
- Tag preview (current value, type, quality)
- Multi-select and batch add
- Recent tags list

### 1.4 Device Health Check Loop (Backend)

**Neden:** FUXA 5-saniyede bir cihaz sağlık kontrolü yapıyor. Bizde WebSocket heartbeat var ama cihaz seviyesinde yok.

**Dosyalar:**
- `apps/sensor-service/src/scada-runtime/services/device-health.service.ts` — YENİ

**Özellikler:**
- 5-second polling loop per connected device
- Protocol-specific health check (OPC-UA: readServerStatus, Modbus: read holding register 0, MQTT: ping, WebAPI: HEAD request)
- Status transitions: online → warning (1 miss) → offline (3 miss)
- Status broadcast via ScadaRuntimeGateway (DEVICE_STATUS event)
- Health history: last 100 status changes per device
- Auto-reconnect on offline detection

---

## FAZ 2: View System + Reusable Patterns (YÜKSEK)

### 2.1 Tag Placeholder System (@[tag_name])

**Neden:** FUXA'nın en güçlü reuse pattern'ı. Bir detail view oluştur, farklı cihazlar için aynı view'ı aç.

**Dosyalar:**
- `web/modules/sensor-module/src/services/TagPlaceholderResolver.ts` — YENİ
- `web/modules/sensor-module/src/hooks/useTagPlaceholder.ts` — YENİ
- `web/modules/sensor-module/src/types/scada-runtime.types.ts` — GÜNCELLE

**Özellikler:**
- `@[tag_name]` syntax in widget tag bindings
- When navigating with Target Device, resolve placeholders against the device's tag namespace
- `resolveTagBindings(widgets[], targetDeviceId)` → resolved widget array
- Support in: tag bindings, chart data sources, alarm rule references
- Fallback: if placeholder can't be resolved, show warning indicator

### 2.2 Target Device Navigation Pattern

**Neden:** FUXA'da bir buton "Target Device: Pump1" ile "PumpDetail" sayfasına navigate ediyor. Aynı detay sayfası tüm pompalar için kullanılıyor.

**Dosyalar:**
- `web/modules/sensor-module/src/store/scada/operatorSlice.ts` — GÜNCELLE
- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx` — GÜNCELLE
- `web/modules/sensor-module/src/types/scada-runtime.types.ts` — GÜNCELLE

**Özellikler:**
- `WidgetEventParams.navigate` genişletilecek: `targetDeviceId?: string`
- `OperatorView` receives `targetDeviceId` from navigation state
- When `targetDeviceId` is set, widget tag bindings are resolved through `TagPlaceholderResolver`
- Breadcrumb navigation: "List → Pump1 Detail" with back support
- Stack-based navigation history

### 2.3 View Lifecycle Events (onOpen / onClose)

**Neden:** FUXA'da view açıldığında/kapandığında script tetiklenebiliyor. Dashboard initialization, cleanup, data prefetch için kullanılıyor.

**Dosyalar:**
- `web/modules/sensor-module/src/types/scada-package.types.ts` — GÜNCELLE
- `web/modules/sensor-module/src/components/scada-operator/OperatorView.tsx` — GÜNCELLE
- `web/modules/sensor-module/src/hooks/useViewLifecycle.ts` — YENİ

**Özellikler:**
- `Screen` modeline `onOpen?: ScriptReference`, `onClose?: ScriptReference` ekle
- `useViewLifecycle(screenId)` hook: executes scripts on mount/unmount
- Server-side: gateway'e VIEW_OPEN/VIEW_CLOSE event'i gönder
- Script engine'e view context sağla: `$currentView`, `$targetDevice`

---

## FAZ 3: Script & Automation Geliştirmeleri (ORTA)

### 3.1 $getDevice + $invokeObject Bridge Functions

**Neden:** FUXA'da ODBC sorguları ve UI nesnelerini programatik kontrol etmek için kullanılıyor.

**Dosyalar:**
- `apps/sensor-service/src/scada-runtime/services/script-engine.service.ts` — GÜNCELLE
- `web/modules/sensor-module/src/services/ScriptEngine.ts` — GÜNCELLE

**Özellikler:**
- `$getDevice(deviceName, includeConnection?)`: Device metadata + connection handle döndür
- `$invokeObject(objectName, methodName, data)`: Widget'a method call gönder (setTableAndData, refresh, etc.)
- Server-side: Gateway üzerinden INVOKE_OBJECT event'i broadcast et
- Client-side: Widget registry ile methodName → handler mapping

### 3.2 Scale Scripts on Tags

**Neden:** FUXA'da tag'lere read/write transform scripti bağlanabiliyor. Raw değeri mühendislik birimine çevirme.

**Dosyalar:**
- `apps/sensor-service/src/scada-runtime/services/tag-manager.service.ts` — GÜNCELLE
- `web/modules/sensor-module/src/components/scada-builder/tag-config/ScaleScriptEditor.tsx` — YENİ

**Özellikler:**
- `TagDaqSettings.scaleReadScript?: string` — okuma dönüşümü (value → scaled)
- `TagDaqSettings.scaleWriteScript?: string` — yazma dönüşümü (scaled → raw)
- Safe execution via vm module (reuse ScriptEngine pattern)
- Script parameter must be named `value`
- Preview: raw value → scaled value live preview

### 3.3 Alarm runScript Action Implementation

**Neden:** FUXA'da alarm tetiklendiğinde script çalıştırma var. Bizde stub olarak yazılmış.

**Dosyalar:**
- `apps/sensor-service/src/scada-runtime/services/alarm-engine.service.ts` — GÜNCELLE

**Özellikler:**
- `runScript` action type'ı gerçek ScriptEngineService.runScript() çağırsın
- Action params: scriptId, optional parameters
- Execution context: alarm instance bilgisi ($alarm object)
- Error handling: script failure alarm'ı clear etmemeli

---

## FAZ 4: Chart & Report Sistemi (ORTA)

### 4.1 Bar/Pie Chart Widget Types

**Neden:** FUXA'da Chart.js bar/pie var. Bizde BarChart ve PieChart component'ları var ama widget type olarak tanımlı değil.

**Dosyalar:**
- `web/modules/sensor-module/src/types/scada-widget.types.ts` — GÜNCELLE
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/BarChartRenderer.tsx` — GÜNCELLE (mevcut)
- `web/modules/sensor-module/src/components/scada-builder/widget-renderers/PieChartRenderer.tsx` — YENİ
- `web/modules/sensor-module/src/components/scada-operator/widgets/RuntimeWidgetRenderer.tsx` — GÜNCELLE

**Özellikler:**
- `ScadaWidgetType`'a `barChart` ve `pieChart` ekle
- Runtime renderer'lara dispatch ekle
- Widget config: data sources (tag IDs), colors, labels, aggregation, refresh interval
- Builder: config panel for bar/pie settings

### 4.2 PDF Report Generation

**Neden:** FUXA'da server-side PDF rapor oluşturma var. Trend verileri + alarm geçmişi → PDF.

**Dosyalar:**
- `apps/sensor-service/src/scada-runtime/services/report.service.ts` — YENİ
- `web/modules/sensor-module/src/components/scada-operator/ReportDialog.tsx` — YENİ

**Özellikler:**
- `ReportConfig` type'ı zaten tanımlı (scada-runtime.types.ts): schedule, data sources, aggregation, recipients
- Server-side: pdfmake ile PDF oluştur (trend data tables, alarm summary, header/footer)
- Scheduled reports: daily/weekly/monthly via SchedulerService
- Email delivery via NotificationService
- On-demand report generation via operator UI
- CSV export: ChartExport.ts'deki `exportCsv` utility'sini backend'e taşı

### 4.3 Chart CSV Export Wiring

**Neden:** Frontend'de ChartExport component'ı var ama RuntimeChart'a bağlı değil.

**Dosyalar:**
- `web/modules/sensor-module/src/components/scada-operator/widgets/RuntimeChart.tsx` — GÜNCELLE

**Özellikler:**
- RuntimeChart toolbar'a CSV export butonu ekle
- ChartExport.exportCsv() çağırsın (zaten var, sadece wire edilmeli)
- PNG export de ekle (ChartExport.exportPng)

---

## FAZ 5: Project Management & Security (ORTA-DÜŞÜK)

### 5.1 Auto-Save System

**Neden:** FUXA'da her değişiklik otomatik kaydediliyor. Bizde manual save + dirty state var.

**Dosyalar:**
- `web/modules/sensor-module/src/hooks/useAutoSave.ts` — YENİ
- `web/modules/sensor-module/src/store/scada/projectSlice.ts` — GÜNCELLE

**Özellikler:**
- Debounced auto-save (5 second delay after last change)
- Save indicator: "Saving...", "Saved", "Unsaved changes"
- Conflict detection: if another user saved, show merge dialog
- Auto-save toggle in settings (enabled by default)
- History: last 10 auto-save snapshots (rollback support)

### 5.2 Standalone JSON Export/Import

**Neden:** FUXA'da tüm proje tek bir JSON dosyası olarak export/import edilebiliyor. Backup ve paylaşım için.

**Dosyalar:**
- `web/modules/sensor-module/src/components/scada-builder/ProjectExportDialog.tsx` — YENİ
- `web/modules/sensor-module/src/components/scada-builder/ProjectImportDialog.tsx` — YENİ
- `web/modules/sensor-module/src/services/ProjectExportService.ts` — YENİ

**Özellikler:**
- Full SCADA package export: screens, widgets, alarm rules, scripts, scheduler events, chart configs, layout
- JSON file download with version metadata
- Import with validation: schema check, ID conflict resolution, merge vs replace options
- Selective import: choose which screens/configs to import
- Cross-tenant import support (remap tenant-specific IDs)

### 5.3 API Key Management

**Neden:** FUXA'da Node-RED ve external API erişimi için API key yönetimi var.

**Dosyalar:**
- `apps/sensor-service/src/scada-runtime/services/api-key.service.ts` — YENİ
- `web/modules/sensor-module/src/components/scada-builder/settings/ApiKeyManager.tsx` — YENİ

**Özellikler:**
- CRUD for API keys: name, key (generated UUID), permissions (read/write/admin), expiry
- Key hashing (store only hash, show key once on creation)
- Rate limiting per key
- Usage logging (last used, request count)
- Revocation support
- Gateway: accept `x-api-key` header as auth alternative

---

## FAZ 6: Scheduler & Event Geliştirmeleri (DÜŞÜK)

### 6.1 Timer/Event Mode + Script Actions

**Neden:** FUXA'da duration-based event mode ve scheduler'dan script tetikleme var.

**Dosyalar:**
- `web/modules/sensor-module/src/types/scada-runtime.types.ts` — GÜNCELLE
- `apps/sensor-service/src/scada-runtime/services/scheduler.service.ts` — GÜNCELLE
- `web/modules/sensor-module/src/components/scada-operator/widgets/RuntimeScheduler.tsx` — GÜNCELLE

**Özellikler:**
- `SchedulerEvent`'e `mode: 'timer' | 'event'` ekle
- Event mode: `duration` (hours/minutes/seconds) field, auto-OFF after duration
- `actions[]` per event: setValue, runScript with scriptId + params
- Actions fire on both start AND end of event
- One-time events: auto-remove after execution

### 6.2 Alarm Retention Config UI

**Neden:** FUXA'da alarm geçmişi için retention süresi ayarlanabiliyor (7d/30d/90d/1y/3y/5y).

**Dosyalar:**
- `web/modules/sensor-module/src/components/scada-builder/settings/AlarmRetentionSettings.tsx` — YENİ
- `apps/sensor-service/src/scada-runtime/services/alarm-storage.service.ts` — GÜNCELLE

**Özellikler:**
- Retention period selector: 7d, 30d, 90d, 1y, 3y, 5y, forever
- Scheduled cleanup job via SchedulerService
- Storage usage indicator (estimated DB size)
- Archive before delete option

---

## UYGULAMA SİRASI

```
FAZ 1 (KRİTİK) ─────────────────────────────────────────
  1.1 WebAPI Adapter              ← Yeni protokol driver
  1.2 Tag DAQ Settings Wiring     ← Tag'lere per-tag DAQ bağla
  1.3 Tag Browser Dialog          ← Generic tag seçme UI
  1.4 Device Health Check         ← Cihaz sağlık izleme

FAZ 2 (YÜKSEK) ──────────────────────────────────────────
  2.1 Tag Placeholder System      ← @[tag_name] reuse pattern
  2.2 Target Device Navigation    ← Cihaz context'li navigate
  2.3 View Lifecycle Events       ← onOpen/onClose script trigger

FAZ 3 (ORTA) ────────────────────────────────────────────
  3.1 $getDevice + $invokeObject  ← Script bridge genişlet
  3.2 Scale Scripts on Tags       ← Read/write transform
  3.3 Alarm runScript Action      ← Stub'ı gerçek impl'e çevir

FAZ 4 (ORTA) ────────────────────────────────────────────
  4.1 Bar/Pie Chart Widgets       ← Widget type olarak ekle
  4.2 PDF Report Generation       ← Server-side rapor
  4.3 Chart CSV Export Wiring     ← Mevcut export'u bağla

FAZ 5 (ORTA-DÜŞÜK) ──────────────────────────────────────
  5.1 Auto-Save System            ← Debounced otomatik kaydetme
  5.2 JSON Export/Import          ← Proje backup/paylaşım
  5.3 API Key Management          ← External API erişim

FAZ 6 (DÜŞÜK) ───────────────────────────────────────────
  6.1 Timer/Event Mode            ← Scheduler genişletme
  6.2 Alarm Retention Config      ← Retention UI
```

---

## TOPLAM TAHMİN

| Faz | Yeni Dosya | Güncelleme | Agent Sayısı |
|-----|-----------|------------|-------------|
| Faz 1 | 6 | 3 | 4 |
| Faz 2 | 4 | 4 | 3 |
| Faz 3 | 1 | 3 | 3 |
| Faz 4 | 2 | 3 | 3 |
| Faz 5 | 5 | 1 | 3 |
| Faz 6 | 1 | 3 | 2 |
| **TOPLAM** | **19** | **17** | **18** |

---

## MİMARİ NOTLAR

1. **SVG Canvas vs React Components:** FUXA'nın SVG canvas yaklaşımını benimsemiyoruz. React component-based widget sistemi daha maintainable ve type-safe. postValue/putValue/export-markers gibi SVG-spesifik pattern'lar N/A.

2. **Node-RED vs Structured Text:** Node-RED entegrasyonu kasıtlı olarak atlandı. IEC 61131-3 Structured Text editörü endüstriyel otomasyonda daha standart ve güvenli.

3. **Multi-Tenant:** FUXA single-tenant. Bizim her şey tenant-isolated. Placeholder resolver, device health check, API keys hep tenantId-scoped olmalı.

4. **Database:** FUXA SQLite kullanıyor. Biz PostgreSQL + TimescaleDB. DAQ storage ve alarm storage zaten bu altyapıda.
