# Unified SCADA Editor - Implementation Summary

**Tarih:** 2026-03-06
**Durum:** Phase 1 tamamlandı (Frontend Unification + Backend Entities)

## Genel Bakış

Process Editor (ReactFlow P&ID) ve SCADA Builder (CSS Grid HMI) tek bir "Unified SCADA Editor" altında birleştirildi. 5-modlu editör sistemi (P&ID, HMI, PLC, Runtime, Debug) ile aynı canvas üzerinde hem ekipman bağlantı diyagramları hem SCADA HMI widget'ları yönetilebilir hale getirildi.

## Mimari Kararlar

| Karar | Tercih | Gerekçe |
|-------|--------|---------|
| Canvas teknolojisi | ReactFlow (iframe) | Mevcut 35+ node type korundu, Module Federation uyumluluğu |
| Widget entegrasyonu | Generic ScadaWidgetNode | 16 widget tipi için tek wrapper, z-index 500+ ile P&ID üstüne overlay |
| State yönetimi | Zustand (editorModeStore) | processStore + scadaPackageStore pattern'ına uyumlu |
| iframe iletişimi | PostMessage genişletme | 11 yeni mesaj tipi, geriye uyumlu |
| Tag namespace | OPC-UA FQN (opsiyonel) | Flat tag'lerle geriye uyumlu, hierarchical FQN isteğe bağlı |
| PLC editörü | Monaco + IEC 61131-3 ST | Tarayıcı içi ST IDE, Rust SoftPLC'ye deploy hazır |
| Multi-screen | Viewport save/restore + node visibility | ScreenManager ile tab-based ekran yönetimi |

## Oluşturulan Dosyalar

### Frontend - Unified Editor Core

| Dosya | Konum | Açıklama |
|-------|-------|----------|
| `UnifiedEditorPage.tsx` | `pages/unified/` | Ana sayfa: 5-mod editör, toolbar, panel yönetimi, D&D |
| `ModeTabBar.tsx` | `components/unified-editor/` | P&ID/HMI/PLC/Runtime/Debug mod seçici (Ctrl+1..5) |
| `UnifiedPropertiesPanel.tsx` | `components/unified-editor/` | Mod-aware sağ panel (Config/Tag/Alarm/Trend tab'ları) |
| `ScreenManager.tsx` | `components/unified-editor/` | Multi-screen tab bar + viewport kaydetme/geri yükleme |
| `screenTemplates.ts` | `components/unified-editor/` | 4 hazır şablon (Empty, 4-Gauge, Alarm Monitor, Trend Viewer) |
| `WidgetDropHandler.ts` | `components/unified-editor/` | Grid snap (120x100 hücre), D&D utilities |
| `ConnectionStatusBanner.tsx` | `components/unified-editor/` | Bağlantı durumu göstergesi |
| `editorModeStore.ts` | `store/` | 5-mod Zustand store (canvasEditable, pidLocked, panelVisibility) |

### Frontend - SCADA Widget System

| Dosya | Konum | Açıklama |
|-------|-------|----------|
| `ScadaWidgetNode.tsx` | `components/process-editor/nodes/` | Generic ReactFlow node wrapper (resize handles, z-index 500) |
| `WidgetRenderer.tsx` | `components/scada-builder/` | Dynamic dispatch: widgetType → React.lazy component |
| 16x widget renderers | `components/scada-builder/widget-renderers/` | Gauge, NumericDisplay, StatusIndicator, TankLevel, ToggleSwitch, Slider, NumericInput, PushButton, EmergencyStop, TrendChart, AlarmBanner, AlarmList, CalibrationWizard, CalibrationHistory, CalibrationStatus, ProcessView |

### Frontend - PLC Editor

| Dosya | Konum | Açıklama |
|-------|-------|----------|
| `StEditorPanel.tsx` | `components/unified-editor/` | Monaco ST editor bottom panel (resizable, F5/F7/F9) |
| `st-language-enhanced.ts` | `components/unified-editor/` | IEC 61131-3 Monarch tokenizer (keywords, types, FBs, literals) |
| `StCompletionProvider.ts` | `components/unified-editor/` | Tag/keyword/snippet autocomplete (12 snippet) |
| `useStEditor.ts` | `hooks/` | Program CRUD, compile/validate hook, error markers |

### Frontend - Real-time Data

| Dosya | Konum | Açıklama |
|-------|-------|----------|
| `useScadaLiveData.ts` | `hooks/` | Multi-device Socket.IO subscription, debounced sub/unsub |
| `ScadaDataProvider.tsx` | `context/` | React Context provider (subscribeTag/unsubscribeTag API) |
| `useScadaTrend.ts` | `hooks/` | Historical trend data hook (auto-resolution, 60s cache TTL) |

### Backend - Yeni Entity'ler (sensor-service)

| Dosya | Konum | Açıklama |
|-------|-------|----------|
| `unified-tag.entity.ts` | `process/entities/` | OPC-UA FQN tag entity (fqn, ioType, dataType, engUnit, alarm limits) |
| `unified-tag.dto.ts` | `process/dto/` | CreateTagInput, UpdateTagInput, TagFilterInput, GraphQL types |
| `unified-tag.service.ts` | `process/services/` | CRUD + discoverTags + autoBindTags + tagSearch (ILIKE) |
| `unified-tag.resolver.ts` | `process/resolvers/` | GraphQL queries/mutations (TENANT_ADMIN/MODULE_MANAGER roles) |
| `scada-deploy-log.entity.ts` | `process/entities/` | Deploy log entity (8 status enum: pending→success/failed/rolled_back) |
| `scada-deploy-log.service.ts` | `process/services/` | Deploy log CRUD (createLog, updateStatus, getByDevice/Package) |
| `scada-deploy-log.dto.ts` | `process/dto/` | GraphQL types + filter input |

### Güncellenen Mevcut Dosyalar

| Dosya | Değişiklik |
|-------|------------|
| `process-editor-canvas.html` | 7 parent→iframe + 4 iframe→parent yeni mesaj tipi, ScadaWidgetNode render, D&D |
| `nodes/index.ts` | scadaWidget node type kaydı + NODE_TYPE_OPTIONS eklenmesi |
| `WidgetPalette.tsx` | MIME type → `application/reactflow-widget`, payload format güncelleme |
| `Module.tsx` | `/sensor/unified-editor/new` ve `/sensor/unified-editor/:id` rotaları |
| `scadaPackageStore.ts` | screenViewports, screenHistory, saveScreenViewport, getScreenViewport |
| `process.module.ts` | UnifiedTag, ScadaDeployLog entity + service + resolver kayıtları |
| `app.module.ts` | UnifiedTag, ScadaDeployLog root entity kayıtları |

## PostMessage Protokol Genişletmesi

### Parent → iframe (7 yeni mesaj)

| Mesaj | Payload | Açıklama |
|-------|---------|----------|
| `setEditorMode` | `{ mode }` | Canvas davranışını ayarla (hangi node'lar draggable) |
| `addOverlayNode` | `{ node }` | ReactFlow'a scadaWidget node ekle |
| `removeOverlayNode` | `{ nodeId }` | scadaWidget node'u sil |
| `updateOverlayNode` | `{ nodeId, data }` | Node data güncelle |
| `updateLiveValues` | `{ values }` | Widget'ların canlı değerlerini güncelle (tagName match) |
| `setNodeVisibility` | `{ nodeIds, visible }` | Multi-screen node visibility toggle |
| `lockPidNodes` | `{ locked }` | P&ID node'larını kilitle/aç |

### iframe → Parent (4 yeni mesaj)

| Mesaj | Payload | Açıklama |
|-------|---------|----------|
| `overlayNodeSelected` | `{ nodeId, nodeData }` | Widget seçildi → sağ panelde config göster |
| `overlayNodeMoved` | `{ nodeId, position }` | Widget taşındı → pozisyon güncelle |
| `overlayNodeResized` | `{ nodeId, width, height }` | Widget boyutu değişti |
| `overlayNodeDeleted` | `{ nodeId }` | Widget silindi |

## Erişim Yolları

- **Unified Editor:** `/sensor/unified-editor/new` veya `/sensor/unified-editor/:processId`
- **Mevcut Process Editor:** `/sensor/process/new` (hala çalışır, geriye uyumlu)
- **Mevcut SCADA Builder:** `/sensor/scada-builder/:packageId` (hala çalışır)

## Sonraki Adımlar (Phase 2)

1. **Backend GraphQL mutations**: Tag CRUD, deploy log gerçek MQTT entegrasyonu
2. **PLC compile pipeline**: ST → Rust SoftPLC binary, edge deploy
3. **Runtime mode**: Canlı veri akışı ile widget animasyonları
4. **Debug mode**: Breakpoint, watchpoint, step-through
5. **Sidebar entegrasyonu**: Sensor module sidebar'ına "Unified Editor" link eklenmesi
