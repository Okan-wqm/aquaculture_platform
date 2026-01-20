# GridStack Dashboard - Veritabanı Kaydetme ve Duplicate Kanal Engelleme

## Özet

GridStack.js zaten implemente edilmiş. Yapılacaklar:
1. Layout'ları veritabanına kaydetme (localStorage yerine)
2. Aynı kanalın birden fazla widget'a eklenmesini engelleme
3. Her tenant için sistem varsayılanı layout desteği
4. Yeni tenant oluşturulurken tabloların otomatik oluşturulması

---

## 1. Database Tablosu: `dashboard_layouts`

```sql
CREATE TABLE dashboard_layouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID,                      -- NULL = Tenant sistem varsayılanı
  name VARCHAR(255) NOT NULL,
  description TEXT,
  widgets JSONB NOT NULL DEFAULT '[]',
  is_default BOOLEAN DEFAULT false,  -- Kullanıcının varsayılanı
  is_system_default BOOLEAN DEFAULT false, -- Tenant varsayılanı (user_id NULL olmalı)
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  created_by UUID
);

CREATE INDEX idx_dashboard_layouts_tenant ON dashboard_layouts(tenant_id);
CREATE INDEX idx_dashboard_layouts_user ON dashboard_layouts(tenant_id, user_id);
```

**Kurallar:**
- `user_id = NULL` ve `is_system_default = true` → Tenant varsayılan layout
- `user_id = <UUID>` ve `is_default = true` → Kullanıcının kişisel varsayılanı
- Kullanıcı sınırsız layout kaydedebilir

---

## 2. Backend - Sensor Service

### 2.1 Entity
**Dosya:** `apps/sensor-service/src/dashboard/entities/dashboard-layout.entity.ts`

```typescript
@Entity('dashboard_layouts')
export class DashboardLayout {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id' })
  tenantId: string;

  @Column({ name: 'user_id', nullable: true })
  userId?: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  description?: string;

  @Column({ type: 'jsonb', default: [] })
  widgets: WidgetConfig[];

  @Column({ name: 'is_default', default: false })
  isDefault: boolean;

  @Column({ name: 'is_system_default', default: false })
  isSystemDefault: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Column({ name: 'created_by', nullable: true })
  createdBy?: string;
}
```

### 2.2 GraphQL API
**Dosya:** `apps/sensor-service/src/dashboard/dashboard.resolver.ts`

```graphql
# Queries
dashboardLayouts: [DashboardLayout!]!           # Kullanıcının tüm layout'ları
dashboardLayout(id: ID!): DashboardLayout       # Tek layout
myDefaultLayout: DashboardLayout                # Kullanıcının varsayılanı (yoksa sistem varsayılanı)

# Mutations
saveDashboardLayout(input: SaveDashboardLayoutInput!): DashboardLayout!
deleteDashboardLayout(id: ID!): Boolean!
setAsDefault(id: ID!): DashboardLayout!
```

### 2.3 Service Mantığı
**Dosya:** `apps/sensor-service/src/dashboard/dashboard.service.ts`

```typescript
// Kullanıcı için varsayılan layout getir
async getMyDefaultLayout(tenantId: string, userId: string): Promise<DashboardLayout> {
  // 1. Kullanıcının kendi varsayılanını ara
  let layout = await this.repo.findOne({
    where: { tenantId, userId, isDefault: true }
  });

  // 2. Yoksa tenant sistem varsayılanını döndür
  if (!layout) {
    layout = await this.repo.findOne({
      where: { tenantId, userId: IsNull(), isSystemDefault: true }
    });
  }

  return layout;
}

// Layout kaydet (create veya update)
async saveLayout(input: SaveDashboardLayoutInput, tenantId: string, userId: string) {
  if (input.id) {
    // Update
    await this.repo.update(input.id, { ...input, updatedAt: new Date() });
  } else {
    // Create
    return this.repo.save({ ...input, tenantId, userId, createdBy: userId });
  }
}
```

---

## 3. Schema Manager Güncellemesi

**Dosya:** `libs/backend-common/src/database/schema-manager.service.ts`

`MODULE_SCHEMAS` içinde sensor modülüne `dashboard_layouts` eklenmeli:

```typescript
{
  moduleName: 'sensor',
  sourceSchema: 'sensor',
  tables: [
    'sensors',
    'sensor_readings',
    'sensor_metrics',
    'sensor_data_channels',
    'sensor_protocols',
    'processes',
    'vfd_devices',
    'vfd_readings',
    'vfd_register_mappings',
    'dashboard_layouts',  // ← YENİ
  ],
},
```

**Ayrıca:** Tenant oluşturulurken boş bir sistem varsayılanı layout oluşturulabilir.

---

## 4. Frontend - Duplicate Kanal Engelleme

**Dosya:** `web/modules/sensor-module/src/components/dashboard/WidgetConfigModal.tsx`

### 4.1 Props Güncellemesi
```typescript
interface WidgetConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (config: WidgetConfig) => void;
  editWidget?: WidgetConfig;
  usedChannelIds: Set<string>;  // ← YENİ: Kullanılan kanal ID'leri
}
```

### 4.2 Kanal Listesinde Disabled Gösterimi
```tsx
{channels.map((channel) => {
  const isAlreadyUsed = usedChannelIds.has(channel.id) &&
                        !editWidget?.selectedChannels?.some(c => c.id === channel.id);

  return (
    <div key={channel.id} className={isAlreadyUsed ? 'opacity-50' : ''}>
      <input
        type={isSingleSelect ? 'radio' : 'checkbox'}
        disabled={isAlreadyUsed}
        checked={selectedChannelIds.has(channel.id)}
        onChange={() => !isAlreadyUsed && toggleChannel(channel)}
      />
      <span>{channel.displayLabel}</span>
      {isAlreadyUsed && (
        <span className="text-xs text-gray-400 ml-2">(Zaten kullanılıyor)</span>
      )}
    </div>
  );
})}
```

---

## 5. Frontend - GridStackDashboard Güncellemesi

**Dosya:** `web/modules/sensor-module/src/components/dashboard/GridStackDashboard.tsx`

### 5.1 Hook Kullanımı
```typescript
const {
  layouts,
  currentLayout,
  saveLayout,
  loadLayout,
  deleteLayout,
  setAsDefault,
  loading
} = useDashboardLayout();
```

### 5.2 usedChannelIds Hesaplama
```typescript
const usedChannelIds = useMemo(() => {
  const ids = new Set<string>();
  currentLayout?.widgets.forEach(widget => {
    widget.selectedChannels?.forEach(ch => ids.add(ch.id));
  });
  return ids;
}, [currentLayout?.widgets]);
```

### 5.3 Layout Seçim Dropdown
```tsx
<select
  value={currentLayout?.id || ''}
  onChange={(e) => loadLayout(e.target.value)}
>
  <option value="">-- Layout Seçin --</option>
  {layouts.map(layout => (
    <option key={layout.id} value={layout.id}>
      {layout.name} {layout.isDefault && '(Varsayılan)'}
    </option>
  ))}
</select>
```

### 5.4 Kaydet Butonu
```tsx
<button onClick={() => saveLayout(currentLayout)}>
  {saving ? 'Kaydediliyor...' : 'Kaydet'}
</button>
```

---

## 6. Frontend - useDashboardLayout Hook

**Yeni Dosya:** `web/modules/sensor-module/src/hooks/useDashboardLayout.ts`

```typescript
export function useDashboardLayout() {
  const [layouts, setLayouts] = useState<DashboardLayout[]>([]);
  const [currentLayout, setCurrentLayout] = useState<DashboardLayout | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // İlk yüklemede varsayılan layout'u getir
  useEffect(() => {
    loadMyDefault();
  }, []);

  const loadMyDefault = async () => { /* GraphQL: myDefaultLayout */ };
  const loadLayouts = async () => { /* GraphQL: dashboardLayouts */ };
  const loadLayout = async (id: string) => { /* GraphQL: dashboardLayout(id) */ };
  const saveLayout = async (layout: DashboardLayout) => { /* GraphQL: saveDashboardLayout */ };
  const deleteLayout = async (id: string) => { /* GraphQL: deleteDashboardLayout */ };
  const setAsDefault = async (id: string) => { /* GraphQL: setAsDefault */ };

  return {
    layouts,
    currentLayout,
    setCurrentLayout,
    loading,
    saving,
    loadLayouts,
    loadLayout,
    saveLayout,
    deleteLayout,
    setAsDefault,
  };
}
```

---

## Dosya Özeti

### Yeni Dosyalar (5)
| Dosya | Açıklama |
|-------|----------|
| `apps/sensor-service/src/dashboard/entities/dashboard-layout.entity.ts` | Entity |
| `apps/sensor-service/src/dashboard/dashboard.resolver.ts` | GraphQL API |
| `apps/sensor-service/src/dashboard/dashboard.service.ts` | Business logic |
| `apps/sensor-service/src/dashboard/dashboard.module.ts` | NestJS module |
| `web/modules/sensor-module/src/hooks/useDashboardLayout.ts` | Frontend hook |

### Güncellenecek Dosyalar (4)
| Dosya | Değişiklik |
|-------|------------|
| `libs/backend-common/src/database/schema-manager.service.ts` | `dashboard_layouts` tablosu |
| `apps/sensor-service/src/app.module.ts` | DashboardModule import |
| `web/modules/sensor-module/src/components/dashboard/GridStackDashboard.tsx` | DB entegrasyonu |
| `web/modules/sensor-module/src/components/dashboard/WidgetConfigModal.tsx` | Duplicate engelleme |

---

## Uygulama Sırası

1. **Backend Entity & Module** - DashboardLayout entity ve NestJS module
2. **Schema Manager** - Tablo tanımı ekleme
3. **GraphQL API** - Resolver ve service
4. **Frontend Hook** - useDashboardLayout
5. **GridStackDashboard** - Layout yönetimi UI
6. **WidgetConfigModal** - Duplicate kanal engelleme
7. **Test & Deploy**

