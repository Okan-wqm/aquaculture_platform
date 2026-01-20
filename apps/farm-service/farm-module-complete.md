# FARM MODÜLÜ - TAM SİSTEM DOKÜMANTASYONU
## Setup Tabloları + Batch Sistemi (Entegre)

---

# İÇİNDEKİLER

1. [Sistem Mimarisi](#1-sistem-mimarisi)
2. [Setup Tabloları](#2-setup-tablolari)
   - 2.1 Sites (Tesisler)
   - 2.2 Departments (Departmanlar)
   - 2.3 Systems (Sistemler)
   - 2.4 Sub_systems (Alt Sistemler)
   - 2.5 Species (Türler)
   - 2.6 Suppliers (Tedarikçiler)
   - 2.7 Equipment (Ekipman)
   - 2.8 Chemicals (Kimyasallar)
   - 2.9 Feed_types (Yem Türleri)
3. [Batch Sistemi Tabloları](#3-batch-sistemi-tablolari)
   - 3.1 Batch_inputs (Parti Girişleri)
   - 3.2 Tank_allocations (Tank Dağılımları)
   - 3.3 Tank_batches (Tank Durumu)
   - 3.4 Feed_inventory (Yem Stok)
   - 3.5 Feeding_records (Yemleme Kayıtları)
   - 3.6 Growth_samples (Büyüme Örnekleri)
   - 3.7 Tank_operations (Tank İşlemleri)
4. [Formüller ve Hesaplamalar](#4-formuller-ve-hesaplamalar)
5. [İş Akışları](#5-is-akislari)
6. [Frontend Tasarımları](#6-frontend-tasarimlari)
7. [Yetki Matrisi](#7-yetki-matrisi)

---

# 1. SİSTEM MİMARİSİ

## 1.1 Tablo İlişki Diyagramı

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                              FARM MODULE - ENTITY RELATIONSHIPS                      │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                      │
│  ┌──────────────┐         ┌──────────────┐         ┌──────────────┐                │
│  │   TENANTS    │         │    USERS     │         │   SPECIES    │                │
│  │  (Kiracılar) │         │ (Kullanıcılar)│         │   (Türler)   │                │
│  └──────┬───────┘         └──────────────┘         └──────┬───────┘                │
│         │                                                  │                         │
│         │ 1:N                                              │ 1:N                     │
│         ▼                                                  ▼                         │
│  ┌──────────────┐    1:N    ┌──────────────┐    N:1   ┌──────────────┐             │
│  │    SITES     │◄─────────│ DEPARTMENTS  │         │ BATCH_INPUTS │             │
│  │  (Tesisler)  │           │(Departmanlar)│◄────────│  (Partiler)  │             │
│  └──────┬───────┘           └──────┬───────┘         └──────┬───────┘             │
│         │                          │                        │                       │
│         │ 1:N                      │ 1:N                    │ 1:N                   │
│         ▼                          ▼                        ▼                       │
│  ┌──────────────┐           ┌──────────────┐         ┌──────────────┐             │
│  │   SYSTEMS    │           │  EQUIPMENT   │◄───────│TANK_ALLOCAT. │             │
│  │ (Sistemler)  │           │  (Ekipman)   │         │(Tank Dağıtım)│             │
│  └──────┬───────┘           └──────┬───────┘         └──────────────┘             │
│         │                          │                        │                       │
│         │ 1:N                      │ (type='tank')          │                       │
│         ▼                          ▼                        ▼                       │
│  ┌──────────────┐           ┌──────────────┐         ┌──────────────┐             │
│  │ SUB_SYSTEMS  │           │ TANK_BATCHES │◄────────│TANK_OPERAT.  │             │
│  │(Alt Sistemler)│           │(Tank Durum)  │         │(Tank İşlem)  │             │
│  └──────────────┘           └──────────────┘         └──────────────┘             │
│                                                                                      │
│  ┌──────────────┐    N:M    ┌──────────────┐                                       │
│  │  SUPPLIERS   │◄─────────│SUPPLIER_SITES│                                       │
│  │(Tedarikçiler)│           └──────────────┘                                       │
│  └──────┬───────┘                                                                   │
│         │                                                                            │
│         │ 1:N                                                                        │
│         ▼                                                                            │
│  ┌──────────────┐    1:N    ┌──────────────┐    1:N   ┌──────────────┐             │
│  │  FEED_TYPES  │◄─────────│FEED_INVENTORY│◄────────│FEEDING_REC.  │             │
│  │ (Yem Türleri)│           │ (Yem Stok)   │         │(Yemleme Kay.)│             │
│  └──────────────┘           └──────────────┘         └──────────────┘             │
│                                                                                      │
│  ┌──────────────┐    N:M    ┌──────────────┐                                       │
│  │  CHEMICALS   │◄─────────│CHEMICAL_SITES│                                       │
│  │ (Kimyasallar)│           └──────────────┘                                       │
│  └──────────────┘                                                                   │
│                                                                                      │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

## 1.2 Hiyerarşik Yapı

```
TENANT (Kiracı/Firma)
│
├── SITE (Tesis)
│   │
│   ├── DEPARTMENT (Departman)
│   │   └── Personel atamaları
│   │
│   ├── SYSTEM (Sistem)
│   │   │
│   │   └── SUB_SYSTEM (Alt Sistem)
│   │       └── EQUIPMENT (Ekipman)
│   │           └── Tank, Pompa, Blower, Sensör...
│   │
│   └── BATCH_INPUT (Parti Girişi)
│       │
│       ├── TANK_ALLOCATION (Tank Dağıtımı)
│       │   └── TANK_BATCHES (Tank Durumu)
│       │
│       ├── FEEDING_RECORDS (Yemleme Kayıtları)
│       ├── GROWTH_SAMPLES (Büyüme Örnekleri)
│       └── TANK_OPERATIONS (Tank İşlemleri)
│
├── SUPPLIER (Tedarikçi) ──── N:M ──── SITES
├── CHEMICAL (Kimyasal) ──── N:M ──── SITES
├── FEED_TYPE (Yem Türü)
│   └── FEED_INVENTORY (Yem Stok)
│
└── SPECIES (Tür)
```

---

# 2. SETUP TABLOLARI

## 2.1 SITES (Tesisler)

Tüm operasyonların başladığı merkezi lokasyon bilgisi.

### Tablo Şeması

```sql
CREATE TABLE sites (
    -- Birincil Anahtar
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    
    -- Temel Bilgiler
    name VARCHAR(150) NOT NULL,
    code VARCHAR(20),                             -- Kısa kod: "BOD-01"
    type VARCHAR(30) NOT NULL,                    -- land_based, sea_cage, pond, raceway, recirculating
    
    -- Lokasyon
    address TEXT,
    city VARCHAR(100),
    country VARCHAR(100),
    latitude DECIMAL(10, 7),                      -- -90 ile 90 arası
    longitude DECIMAL(10, 7),                     -- -180 ile 180 arası
    
    -- Kapasite
    area_m2 DECIMAL(12, 2),                       -- Tesis alanı (m²)
    water_capacity_m3 DECIMAL(12, 2),             -- Su kapasitesi (m³)
    max_biomass_kg DECIMAL(12, 2),                -- Maksimum biyokütle kapasitesi
    
    -- Tarihler
    established_date DATE,
    
    -- İletişim
    contact_phone VARCHAR(50),
    contact_email VARCHAR(150),
    
    -- Sorumlu Kişiler (Normalize edilmiş - ayrı tablo)
    
    -- Tesis Özellikleri
    facilities JSONB DEFAULT '{}',
    /*
    {
        "water_supply": true,
        "electricity": true,
        "generator": true,
        "storage": true,
        "office": true,
        "workshop": false,
        "feed_storage": true,
        "cold_storage": false,
        "laboratory": false
    }
    */
    
    -- Durum
    status VARCHAR(20) DEFAULT 'active',          -- active, maintenance, inactive, closed
    
    -- Metadata
    notes TEXT,
    metadata JSONB DEFAULT '{}',
    
    -- Audit
    is_deleted BOOLEAN DEFAULT false,
    deleted_at TIMESTAMPTZ,
    deleted_by UUID,
    created_by UUID,
    updated_by UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Kısıtlamalar
    CONSTRAINT uq_site_code UNIQUE (tenant_id, code),
    CONSTRAINT chk_site_type CHECK (type IN ('land_based', 'sea_cage', 'pond', 'raceway', 'recirculating', 'hatchery')),
    CONSTRAINT chk_site_status CHECK (status IN ('active', 'maintenance', 'inactive', 'closed')),
    CONSTRAINT chk_latitude CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90)),
    CONSTRAINT chk_longitude CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180))
);

-- İndeksler
CREATE INDEX idx_sites_tenant ON sites(tenant_id);
CREATE INDEX idx_sites_status ON sites(tenant_id, status);
CREATE INDEX idx_sites_type ON sites(tenant_id, type);
```

### Site Responsible Persons (Sorumlu Kişiler) - Normalize

```sql
CREATE TABLE site_contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    
    -- Kişi Bilgileri
    name VARCHAR(100) NOT NULL,
    role VARCHAR(100),                            -- Genel Müdür, Tesis Müdürü, vb.
    email VARCHAR(150),
    phone VARCHAR(50),
    is_primary BOOLEAN DEFAULT false,             -- Ana irtibat kişisi mi?
    
    -- Audit
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT uq_site_primary_contact UNIQUE (site_id, is_primary) 
        WHERE is_primary = true                   -- Tek primary contact
);
```

### Form Tasarımı

```
┌─────────────────────────────────────────────────────────────────┐
│ YENİ TESİS OLUŞTUR                                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ TEMEL BİLGİLER                                                  │
│ ─────────────────────────────────────────────────────────────── │
│ Tesis Adı *          Kısa Kod                                   │
│ [____________________] [______]                                 │
│                                                                  │
│ Tesis Tipi *                                                    │
│ [▼ Seçiniz                                          ]           │
│   • Land-based (Kara tabanlı RAS)                              │
│   • Sea-cage (Deniz kafesi)                                    │
│   • Pond (Gölet/Havuz)                                         │
│   • Raceway (Oluk sistemi)                                     │
│   • Recirculating (Kapalı devre)                               │
│   • Hatchery (Kuluçkahane)                                     │
│                                                                  │
│ Kuruluş Tarihi              Durum                              │
│ [📅 ../../....]            [▼ Active]                          │
│                                                                  │
│ LOKASYON BİLGİLERİ                                              │
│ ─────────────────────────────────────────────────────────────── │
│ Adres                                                           │
│ [________________________________________________]             │
│                                                                  │
│ Şehir                       Ülke                               │
│ [__________________]       [__________________]                │
│                                                                  │
│ GPS Koordinatları                                               │
│ Enlem              Boylam                                       │
│ [________] °N     [________] °E    [📍 Haritadan Seç]          │
│                                                                  │
│ KAPASİTE BİLGİLERİ                                              │
│ ─────────────────────────────────────────────────────────────── │
│ Tesis Alanı        Su Kapasitesi       Maks. Biyokütle         │
│ [______] m²       [______] m³         [______] kg              │
│                                                                  │
│ İLETİŞİM                                                        │
│ ─────────────────────────────────────────────────────────────── │
│ Telefon                     Email                               │
│ [__________________]       [__________________]                │
│                                                                  │
│ SORUMLU KİŞİLER                                   [+ Ekle]     │
│ ┌─────────────────────────────────────────────────────────┐    │
│ │ ● Ahmet Yılmaz - Genel Müdür (Ana İrtibat)         [×] │    │
│ │   ayilmaz@firma.com | +90 532 xxx xx xx                │    │
│ ├─────────────────────────────────────────────────────────┤    │
│ │ ○ Mehmet Demir - Tesis Müdürü                      [×] │    │
│ │   mdemir@firma.com | +90 533 yyy yy yy                 │    │
│ └─────────────────────────────────────────────────────────┘    │
│                                                                  │
│ TESİS ÖZELLİKLERİ                                               │
│ ─────────────────────────────────────────────────────────────── │
│ ☑ Su Temini    ☑ Elektrik    ☑ Jeneratör    ☑ Depo           │
│ ☑ Ofis         ☐ Atölye      ☑ Yem Deposu   ☐ Soğuk Depo     │
│ ☐ Laboratuvar                                                   │
│                                                                  │
│ NOTLAR                                                          │
│ [________________________________________________]             │
│                                                                  │
│                        [İptal]    [Kaydet]                      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2.2 DEPARTMENTS (Departmanlar)

Site içindeki organizasyonel bölümler.

### Tablo Şeması

```sql
CREATE TABLE departments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    
    -- Bilgiler
    name VARCHAR(100) NOT NULL,
    code VARCHAR(20),                             -- Kısa kod: "PROD", "MAINT"
    description TEXT,
    
    -- Yönetici (Normalize edilmiş)
    manager_user_id UUID,                         -- Users tablosundan
    
    -- Durum
    status VARCHAR(20) DEFAULT 'active',          -- active, inactive
    
    -- Audit
    is_deleted BOOLEAN DEFAULT false,
    created_by UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT uq_department_code UNIQUE (site_id, code)
);

CREATE INDEX idx_departments_site ON departments(site_id);
```

### Örnek Departmanlar

| Kod | Departman | Açıklama |
|-----|-----------|----------|
| PROD | Üretim Departmanı | Balık üretimi ve büyütme operasyonları |
| MAINT | Bakım Departmanı | Ekipman bakımı ve teknik destek |
| QC | Kalite Kontrol | Su kalitesi ve ürün kontrolü |
| FEED | Yem Departmanı | Yemleme programları ve stok yönetimi |
| ADMIN | İdari İşler | Genel yönetim ve ofis işleri |

---

## 2.3 SYSTEMS (Sistemler)

Tesis içindeki üretim sistemleri (RAS, Büyütme, Kuluçka vb.).

### Tablo Şeması

```sql
CREATE TABLE systems (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    department_id UUID REFERENCES departments(id) ON DELETE SET NULL,
    
    -- Bilgiler
    name VARCHAR(100) NOT NULL,
    code VARCHAR(20),                             -- "SYS-01", "RAS-A"
    type VARCHAR(50),                             -- ras, flow_through, pond, cage
    description TEXT,
    
    -- Kapasite
    total_volume_m3 DECIMAL(12, 2),
    max_biomass_kg DECIMAL(12, 2),
    tank_count INT,
    
    -- Durum
    status VARCHAR(20) DEFAULT 'operational',     -- operational, maintenance, offline
    
    -- Audit
    is_deleted BOOLEAN DEFAULT false,
    created_by UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT uq_system_code UNIQUE (site_id, code),
    CONSTRAINT chk_system_status CHECK (status IN ('operational', 'maintenance', 'offline', 'construction'))
);

CREATE INDEX idx_systems_site ON systems(site_id);
CREATE INDEX idx_systems_department ON systems(department_id);
```

---

## 2.4 SUB_SYSTEMS (Alt Sistemler)

Sistemlerin alt bileşenleri (Havalandırma, Filtrasyon, Isıtma vb.).

### Tablo Şeması

```sql
CREATE TABLE sub_systems (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    system_id UUID NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
    department_id UUID REFERENCES departments(id) ON DELETE SET NULL,
    
    -- Bilgiler
    name VARCHAR(100) NOT NULL,
    code VARCHAR(20),
    type VARCHAR(50),                             -- aeration, filtration, heating, cooling, uv, ozone
    description TEXT,
    
    -- Durum
    status VARCHAR(20) DEFAULT 'operational',
    
    -- Audit
    is_deleted BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT uq_subsystem_code UNIQUE (system_id, code)
);

CREATE INDEX idx_subsystems_system ON sub_systems(system_id);
```

### Örnek Hiyerarşi

```
Site: Bodrum Ana Tesis
│
├── System: Büyütme Sistemi 1 (RAS)
│   ├── Sub-system: Havalandırma
│   │   ├── Equipment: Blower-1
│   │   └── Equipment: Blower-2
│   ├── Sub-system: Mekanik Filtrasyon
│   │   ├── Equipment: Drum Filter-1
│   │   └── Equipment: Pump-MF-1
│   ├── Sub-system: Biyolojik Filtrasyon
│   │   └── Equipment: MBBR Tank-1
│   └── Sub-system: UV Sterilizasyon
│       └── Equipment: UV Unit-1
│
└── System: Kuluçka Sistemi
    ├── Sub-system: Isıtma
    │   └── Equipment: Heater-1
    └── Sub-system: Havalandırma
        └── Equipment: Blower-H1
```

---

## 2.5 SPECIES (Türler)

Üretilen balık/deniz canlısı türleri.

### Tablo Şeması

```sql
CREATE TABLE species (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    
    -- Temel Bilgiler
    common_name VARCHAR(100) NOT NULL,            -- Levrek, Çipura
    scientific_name VARCHAR(150),                 -- Dicentrarchus labrax
    local_name VARCHAR(100),                      -- Yerel isim
    
    -- Kategoriler
    category VARCHAR(50),                         -- marine_fish, freshwater_fish, shrimp, shellfish
    family VARCHAR(100),                          -- Moronidae, Sparidae
    
    -- Büyüme Parametreleri
    optimal_temp_min DECIMAL(4,1),                -- Optimal sıcaklık min (°C)
    optimal_temp_max DECIMAL(4,1),                -- Optimal sıcaklık max (°C)
    optimal_salinity_min DECIMAL(5,2),            -- Optimal tuzluluk min (ppt)
    optimal_salinity_max DECIMAL(5,2),            -- Optimal tuzluluk max (ppt)
    optimal_ph_min DECIMAL(3,1),
    optimal_ph_max DECIMAL(3,1),
    optimal_oxygen_min DECIMAL(4,2),              -- mg/L
    
    -- Üretim Parametreleri
    market_weight_min_g DECIMAL(10,2),            -- Pazar ağırlığı min (g)
    market_weight_max_g DECIMAL(10,2),            -- Pazar ağırlığı max (g)
    typical_fcr DECIMAL(4,2),                     -- Tipik FCR değeri
    
    -- Hasat Süreleri (gün) - Input tipine göre
    days_to_harvest_from_egg INT,
    days_to_harvest_from_fry INT,
    days_to_harvest_from_fingerling INT,
    days_to_harvest_from_juvenile INT,
    
    -- Stocking Density (kg/m³)
    recommended_density_min DECIMAL(6,2),
    recommended_density_max DECIMAL(6,2),
    
    -- Görsel
    image_url TEXT,
    
    -- Durum
    status VARCHAR(20) DEFAULT 'active',
    notes TEXT,
    
    -- Audit
    is_deleted BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT uq_species_name UNIQUE (tenant_id, common_name)
);

CREATE INDEX idx_species_tenant ON species(tenant_id);
CREATE INDEX idx_species_category ON species(category);
```

### Form Tasarımı

```
┌─────────────────────────────────────────────────────────────────┐
│ YENİ TÜR KAYDI                                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ TEMEL BİLGİLER                                                  │
│ ─────────────────────────────────────────────────────────────── │
│ Yaygın Adı *              Bilimsel Adı                         │
│ [Levrek__________]       [Dicentrarchus labrax______]          │
│                                                                  │
│ Kategori *                  Familya                             │
│ [▼ Deniz Balığı]           [Moronidae______________]           │
│                                                                  │
│ OPTİMUM ÇEVRE KOŞULLARI                                         │
│ ─────────────────────────────────────────────────────────────── │
│ Sıcaklık (°C)      Tuzluluk (ppt)       pH                     │
│ [18] - [24]       [30] - [38]         [7.5] - [8.5]            │
│                                                                  │
│ Min. Oksijen (mg/L)                                             │
│ [5.0____]                                                       │
│                                                                  │
│ ÜRETİM PARAMETRELERİ                                            │
│ ─────────────────────────────────────────────────────────────── │
│ Pazar Ağırlığı (g)         Tipik FCR                           │
│ [300] - [600]             [1.5____]                            │
│                                                                  │
│ Önerilen Yoğunluk (kg/m³)                                      │
│ [15] - [25]                                                     │
│                                                                  │
│ HASAT SÜRELERİ (gün)                                            │
│ ─────────────────────────────────────────────────────────────── │
│ Yumurtadan     Larvadan      Parmak Boydan    Gençten          │
│ [365____]     [300____]     [180____]        [120____]         │
│                                                                  │
│                        [İptal]    [Kaydet]                      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Örnek Türler

| Tür | Bilimsel Ad | Pazar Ağırlığı | Tipik FCR | Yoğunluk |
|-----|-------------|----------------|-----------|----------|
| Levrek | Dicentrarchus labrax | 300-600g | 1.5 | 15-25 kg/m³ |
| Çipura | Sparus aurata | 300-500g | 1.6 | 15-25 kg/m³ |
| Alabalık | Oncorhynchus mykiss | 250-400g | 1.1 | 30-50 kg/m³ |
| Somon | Salmo salar | 4-6 kg | 1.2 | 25-40 kg/m³ |
| Tilapia | Oreochromis niloticus | 400-800g | 1.5 | 20-40 kg/m³ |

---

## 2.6 SUPPLIERS (Tedarikçiler)

Yavru, yem, ekipman, kimyasal tedarikçileri.

### Tablo Şeması

```sql
CREATE TABLE suppliers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    
    -- Temel Bilgiler
    name VARCHAR(200) NOT NULL,
    code VARCHAR(20),                             -- Kısa kod
    type VARCHAR(30) NOT NULL,                    -- Ana tip: fry, feed, equipment, chemical, service
    supply_types VARCHAR(30)[],                   -- Çoklu: ['fry', 'feed']
    
    -- İletişim
    contact_person VARCHAR(100),
    email VARCHAR(150),
    phone VARCHAR(50),
    website VARCHAR(200),
    
    -- Adres
    address TEXT,
    city VARCHAR(100),
    country VARCHAR(100),
    
    -- Değerlendirme
    rating DECIMAL(2,1),                          -- 1.0 - 5.0 arası
    
    -- Finansal
    payment_terms VARCHAR(100),                   -- "30 gün vadeli", "Peşin"
    tax_id VARCHAR(50),                           -- Vergi numarası
    
    -- Ürünler
    products TEXT[],                              -- Sunduğu ürünler listesi
    
    -- Durum
    status VARCHAR(20) DEFAULT 'active',          -- active, inactive, suspended, blacklisted
    
    -- Notlar
    notes TEXT,
    
    -- Audit
    is_deleted BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT uq_supplier_code UNIQUE (tenant_id, code),
    CONSTRAINT chk_supplier_type CHECK (type IN ('fry', 'feed', 'equipment', 'chemical', 'service', 'other')),
    CONSTRAINT chk_supplier_status CHECK (status IN ('active', 'inactive', 'suspended', 'blacklisted')),
    CONSTRAINT chk_rating CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5))
);

-- Supplier-Site ilişki tablosu (N:M)
CREATE TABLE supplier_sites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    
    is_preferred BOOLEAN DEFAULT false,           -- Tercih edilen tedarikçi mi?
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT uq_supplier_site UNIQUE (supplier_id, site_id)
);

CREATE INDEX idx_suppliers_tenant ON suppliers(tenant_id);
CREATE INDEX idx_suppliers_type ON suppliers(type);
CREATE INDEX idx_supplier_sites_supplier ON supplier_sites(supplier_id);
CREATE INDEX idx_supplier_sites_site ON supplier_sites(site_id);
```

---

## 2.7 EQUIPMENT (Ekipman)

Tanklar, pompalar, blowerlar, sensörler ve tüm fiziksel ekipmanlar.

### Tablo Şeması

```sql
CREATE TABLE equipment (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    
    -- Temel Bilgiler
    name VARCHAR(100) NOT NULL,
    code VARCHAR(30),                             -- "TANK-A1", "PUMP-01"
    type VARCHAR(30) NOT NULL,                    -- tank, pump, blower, filter, heater, sensor, feeder, uv, ozone, other
    
    -- Lokasyon Hiyerarşisi
    site_id UUID REFERENCES sites(id) ON DELETE SET NULL,
    department_id UUID REFERENCES departments(id) ON DELETE SET NULL,
    system_id UUID REFERENCES systems(id) ON DELETE SET NULL,
    sub_system_id UUID REFERENCES sub_systems(id) ON DELETE SET NULL,
    parent_equipment_id UUID REFERENCES equipment(id) ON DELETE CASCADE,
    
    -- Ürün Bilgileri
    brand VARCHAR(100),
    model VARCHAR(100),
    manufacturer VARCHAR(150),
    serial_number VARCHAR(100),
    supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
    
    -- Satın Alma
    purchase_date DATE,
    purchase_price DECIMAL(12, 2),
    currency VARCHAR(3) DEFAULT 'TRY',
    expected_lifespan_years INT,
    
    -- Garanti
    warranty_start_date DATE,
    warranty_end_date DATE,
    warranty_notes TEXT,
    
    -- Bakım
    last_maintenance_date DATE,
    next_maintenance_date DATE,
    maintenance_interval_days INT,
    
    -- Durum
    status VARCHAR(20) DEFAULT 'operational',     -- operational, maintenance, repair, stored, decommissioned
    
    -- Teknik Özellikler (Tip bazlı JSONB)
    specifications JSONB DEFAULT '{}',
    /*
    Tank için:
    {
        "volume_m3": 50,
        "diameter_m": 5,
        "depth_m": 3,
        "max_capacity_kg": 5000,
        "material": "fiberglass",
        "shape": "circular"
    }
    
    Pump için:
    {
        "flow_rate_m3h": 100,
        "head_m": 15,
        "power_kw": 5.5,
        "voltage": 380
    }
    
    Blower için:
    {
        "air_flow_m3h": 500,
        "pressure_mbar": 250,
        "power_kw": 7.5
    }
    */
    
    -- Lokasyon Detay
    location_description TEXT,                    -- "Açık alan, kuzey sıra, 1. tank"
    installation_notes TEXT,
    
    -- Audit
    is_deleted BOOLEAN DEFAULT false,
    deleted_at TIMESTAMPTZ,
    created_by UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT uq_equipment_code UNIQUE (tenant_id, code),
    CONSTRAINT chk_equipment_type CHECK (type IN ('tank', 'pump', 'blower', 'filter', 'heater', 'cooler', 'sensor', 'feeder', 'uv', 'ozone', 'other')),
    CONSTRAINT chk_equipment_status CHECK (status IN ('operational', 'maintenance', 'repair', 'stored', 'decommissioned'))
);

CREATE INDEX idx_equipment_tenant ON equipment(tenant_id);
CREATE INDEX idx_equipment_site ON equipment(site_id);
CREATE INDEX idx_equipment_type ON equipment(type);
CREATE INDEX idx_equipment_status ON equipment(status);
CREATE INDEX idx_equipment_system ON equipment(system_id);
```

### Tank Özel View'ı

Tank'lar için özel bir view oluşturulabilir:

```sql
CREATE VIEW tanks AS
SELECT 
    e.*,
    (e.specifications->>'volume_m3')::DECIMAL AS volume_m3,
    (e.specifications->>'max_capacity_kg')::DECIMAL AS max_capacity_kg,
    (e.specifications->>'material')::VARCHAR AS material,
    tb.batch_numbers,
    tb.current_quantity,
    tb.current_biomass,
    tb.is_mixed
FROM equipment e
LEFT JOIN tank_batches tb ON tb.tank_id = e.id
WHERE e.type = 'tank' AND e.is_deleted = false;
```

---

## 2.8 CHEMICALS (Kimyasallar)

Dezenfektan, pH ayarlayıcı, ilaç vb. kimyasallar.

### Tablo Şeması

```sql
CREATE TABLE chemicals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    
    -- Temel Bilgiler
    name VARCHAR(150) NOT NULL,
    code VARCHAR(30),
    category VARCHAR(50) NOT NULL,                -- disinfectant, ph_adjuster, algaecide, antibacterial, medication, other
    
    -- Üretici/İçerik
    manufacturer VARCHAR(150),
    active_ingredient VARCHAR(200),
    concentration VARCHAR(50),                    -- "%50", "10 mg/L"
    
    -- Güvenlik
    storage_conditions TEXT NOT NULL,
    safety_info TEXT NOT NULL,
    msds_url TEXT,                                -- Material Safety Data Sheet
    
    -- Kullanım
    usage_instructions TEXT,
    dosage_info TEXT,                             -- "50-100 ppm, 30 dakika"
    withdrawal_period_days INT,                   -- Hasat öncesi bekleme süresi
    
    -- Durum
    status VARCHAR(20) DEFAULT 'active',          -- active, inactive, restricted, banned
    requires_approval BOOLEAN DEFAULT false,      -- Kullanım için onay gerekli mi?
    
    -- Notlar
    notes TEXT,
    
    -- Audit
    is_deleted BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT uq_chemical_code UNIQUE (tenant_id, code),
    CONSTRAINT chk_chemical_category CHECK (category IN ('disinfectant', 'ph_adjuster', 'algaecide', 'antibacterial', 'medication', 'fertilizer', 'water_conditioner', 'other'))
);

-- Chemical-Site ilişki tablosu (N:M)
CREATE TABLE chemical_sites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    chemical_id UUID NOT NULL REFERENCES chemicals(id) ON DELETE CASCADE,
    site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    
    is_approved BOOLEAN DEFAULT true,
    approved_by UUID,
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT uq_chemical_site UNIQUE (chemical_id, site_id)
);

CREATE INDEX idx_chemicals_tenant ON chemicals(tenant_id);
CREATE INDEX idx_chemicals_category ON chemicals(category);
CREATE INDEX idx_chemical_sites ON chemical_sites(chemical_id);
```

---

## 2.9 FEED_TYPES (Yem Türleri)

Farklı büyüme aşamaları için yem çeşitleri.

### Tablo Şeması

```sql
CREATE TABLE feed_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    
    -- Temel Bilgiler
    name VARCHAR(150) NOT NULL,
    code VARCHAR(30),
    category VARCHAR(30) NOT NULL,                -- starter, grower, finisher, breeder, specialized
    brand VARCHAR(100),
    supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
    
    -- Besin Değerleri (%)
    protein_percent DECIMAL(5,2),
    fat_percent DECIMAL(5,2),
    carbohydrate_percent DECIMAL(5,2),
    fiber_percent DECIMAL(5,2),
    ash_percent DECIMAL(5,2),
    moisture_percent DECIMAL(5,2),
    
    -- Fiziksel
    pellet_size VARCHAR(20),                      -- "1mm", "3mm", "6mm", "crumble"
    pellet_type VARCHAR(30),                      -- extruded, pressed, crumble
    
    -- Fiyat
    unit_price DECIMAL(10, 2),
    price_unit VARCHAR(10) DEFAULT 'kg',          -- kg, ton, bag
    bag_size_kg DECIMAL(8,2),
    
    -- Durum
    status VARCHAR(20) DEFAULT 'active',          -- active, inactive, discontinued
    
    -- Kullanım
    usage_notes TEXT,
    recommended_feeding_rate VARCHAR(50),         -- "3-5% biyokütle"
    
    -- Audit
    is_deleted BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT uq_feed_type_code UNIQUE (tenant_id, code),
    CONSTRAINT chk_feed_category CHECK (category IN ('starter', 'grower', 'finisher', 'breeder', 'specialized', 'medicated'))
);

-- Feed_type-Species ilişki tablosu (N:M) - Hangi yem hangi türler için uygun
CREATE TABLE feed_type_species (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    feed_type_id UUID NOT NULL REFERENCES feed_types(id) ON DELETE CASCADE,
    species_id UUID NOT NULL REFERENCES species(id) ON DELETE CASCADE,
    
    -- Önerilen kullanım
    recommended_weight_min_g DECIMAL(10,2),       -- Bu ağırlık aralığı için önerilir
    recommended_weight_max_g DECIMAL(10,2),
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT uq_feed_species UNIQUE (feed_type_id, species_id)
);

CREATE INDEX idx_feed_types_tenant ON feed_types(tenant_id);
CREATE INDEX idx_feed_types_category ON feed_types(category);
CREATE INDEX idx_feed_types_supplier ON feed_types(supplier_id);
```

---

# 3. BATCH SİSTEMİ TABLOLARI

## 3.1 BATCH_INPUTS (Parti Girişleri)

Ana batch takip tablosu.

### Tablo Şeması

```sql
CREATE TABLE batch_inputs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    
    -- Tanımlama
    batch_number VARCHAR(50) NOT NULL,
    input_type VARCHAR(20) NOT NULL,              -- eggs, fry, fingerlings, juveniles, adults
    
    -- İlişkiler
    species_id UUID NOT NULL REFERENCES species(id),
    supplier_id UUID REFERENCES suppliers(id) ON DELETE RESTRICT,
    site_id UUID NOT NULL REFERENCES sites(id),
    
    -- Miktar
    initial_quantity INT NOT NULL,
    current_quantity INT NOT NULL,
    
    -- Kayıplar (AYRI TUTULUR)
    mortality_count INT DEFAULT 0,                -- Doğal ölüm
    cull_count INT DEFAULT 0,                     -- Bilinçli ayıklama
    
    -- Ağırlık ve Biyokütle
    initial_weight_g DECIMAL(10,3),               -- Başlangıç ortalama ağırlık
    average_weight_g DECIMAL(10,3),               -- Güncel ortalama ağırlık
    total_biomass_kg DECIMAL(12,3),               -- Güncel biyokütle
    
    -- Maliyet
    unit_cost DECIMAL(10,4),
    total_cost DECIMAL(15,2),
    
    -- Yem (FCR hesabı için)
    total_feed_consumed_kg DECIMAL(12,3) DEFAULT 0,
    total_feed_cost DECIMAL(15,2) DEFAULT 0,
    
    -- Tarihler
    input_date DATE NOT NULL,
    estimated_harvest_date DATE,
    actual_harvest_date DATE,
    
    -- Performans Metrikleri
    survival_rate DECIMAL(5,2),                   -- (initial - mortality) / initial × 100
    retention_rate DECIMAL(5,2),                  -- current / initial × 100
    mortality_rate DECIMAL(5,2),                  -- mortality / initial × 100
    fcr DECIMAL(5,3),                             -- feed / weight_gain
    sgr DECIMAL(5,3),                             -- günlük büyüme oranı
    
    -- Finansal
    total_revenue DECIMAL(15,2),
    profit_loss DECIMAL(15,2),
    cost_per_kg DECIMAL(10,4),
    
    -- Durum
    status VARCHAR(20) DEFAULT 'planned',
    
    -- Notlar
    notes TEXT,
    metadata JSONB DEFAULT '{}',
    
    -- Audit
    version INT DEFAULT 1,
    is_deleted BOOLEAN DEFAULT false,
    deleted_at TIMESTAMPTZ,
    deleted_by UUID,
    created_by UUID,
    updated_by UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT uq_batch_number UNIQUE (tenant_id, batch_number),
    CONSTRAINT chk_input_type CHECK (input_type IN ('eggs', 'fry', 'fingerlings', 'juveniles', 'adults')),
    CONSTRAINT chk_status CHECK (status IN ('planned', 'in_progress', 'completed', 'harvested', 'cancelled', 'delayed')),
    CONSTRAINT chk_quantities CHECK (current_quantity >= 0 AND initial_quantity > 0)
);

CREATE INDEX idx_batch_inputs_tenant ON batch_inputs(tenant_id);
CREATE INDEX idx_batch_inputs_status ON batch_inputs(status);
CREATE INDEX idx_batch_inputs_species ON batch_inputs(species_id);
CREATE INDEX idx_batch_inputs_site ON batch_inputs(site_id);
CREATE INDEX idx_batch_inputs_date ON batch_inputs(input_date);
```

---

## 3.2 TANK_ALLOCATIONS (Tank Dağıtımları)

Batch'lerin tanklara dağıtım geçmişi.

```sql
CREATE TABLE tank_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    
    batch_input_id UUID NOT NULL REFERENCES batch_inputs(id) ON DELETE CASCADE,
    tank_id UUID NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    
    quantity INT NOT NULL,
    allocation_date DATE NOT NULL,
    
    notes TEXT,
    created_by UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT chk_quantity CHECK (quantity > 0)
);

CREATE INDEX idx_tank_allocations_batch ON tank_allocations(batch_input_id);
CREATE INDEX idx_tank_allocations_tank ON tank_allocations(tank_id);
```

---

## 3.3 TANK_BATCHES (Tank Güncel Durumu)

Her tankın şu anki durumu (snapshot).

```sql
CREATE TABLE tank_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    tank_id UUID NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    
    -- Batch Bilgileri
    batch_numbers TEXT[] NOT NULL,
    is_mixed BOOLEAN DEFAULT false,
    mixed_batch_id VARCHAR(50),
    
    -- Miktar
    current_quantity INT NOT NULL,
    
    -- Batch Detayları (mixed için)
    batch_details JSONB,
    /*
    [
        {"batch_number": "BATCH-001", "quantity": 500, "average_weight_g": 25.5, "biomass_kg": 12.75},
        {"batch_number": "BATCH-002", "quantity": 300, "average_weight_g": 30.0, "biomass_kg": 9.0}
    ]
    */
    
    -- Biyokütle
    average_weight_g DECIMAL(10,3),
    current_biomass_kg DECIMAL(12,3),
    stocking_density_kg_m3 DECIMAL(8,3),
    
    -- Son Güncelleme
    last_updated TIMESTAMPTZ DEFAULT NOW(),
    last_operation_type VARCHAR(20),
    
    CONSTRAINT uq_tank_batch UNIQUE (tenant_id, tank_id),
    CONSTRAINT chk_quantity CHECK (current_quantity >= 0)
);

CREATE INDEX idx_tank_batches_tank ON tank_batches(tank_id);
```

---

## 3.4 FEED_INVENTORY (Yem Stok)

Yem stok takibi.

```sql
CREATE TABLE feed_inventory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    site_id UUID NOT NULL REFERENCES sites(id),
    
    -- Yem Türü
    feed_type_id UUID NOT NULL REFERENCES feed_types(id),
    
    -- Lot Bilgileri
    lot_number VARCHAR(50),
    
    -- Miktar
    initial_quantity_kg DECIMAL(12,3) NOT NULL,
    current_quantity_kg DECIMAL(12,3) NOT NULL,
    
    -- Maliyet
    unit_price_per_kg DECIMAL(10,4),
    total_cost DECIMAL(15,2),
    
    -- Tarihler
    purchase_date DATE,
    production_date DATE,
    expiry_date DATE,
    
    -- Depolama
    storage_location VARCHAR(100),
    supplier_id UUID REFERENCES suppliers(id),
    
    -- Durum
    status VARCHAR(20) DEFAULT 'available',       -- available, low_stock, expired, finished
    
    -- Audit
    created_by UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT chk_quantity CHECK (current_quantity_kg >= 0)
);

CREATE INDEX idx_feed_inventory_site ON feed_inventory(site_id);
CREATE INDEX idx_feed_inventory_type ON feed_inventory(feed_type_id);
CREATE INDEX idx_feed_inventory_status ON feed_inventory(status);
CREATE INDEX idx_feed_inventory_expiry ON feed_inventory(expiry_date);
```

---

## 3.5 FEEDING_RECORDS (Yemleme Kayıtları)

Günlük yemleme işlemleri.

```sql
CREATE TABLE feeding_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    
    -- İlişkiler
    tank_id UUID NOT NULL REFERENCES equipment(id),
    batch_number VARCHAR(50),
    feed_inventory_id UUID REFERENCES feed_inventory(id),
    
    -- Yemleme
    feeding_date DATE NOT NULL,
    feeding_time TIME,
    quantity_kg DECIMAL(10,3) NOT NULL,
    
    -- Ortam
    water_temperature DECIMAL(5,2),
    
    -- Gözlem
    feeding_response VARCHAR(20),                 -- excellent, good, moderate, poor, none
    leftover_observed BOOLEAN DEFAULT false,
    
    notes TEXT,
    recorded_by UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT chk_quantity CHECK (quantity_kg > 0),
    CONSTRAINT chk_response CHECK (feeding_response IS NULL OR feeding_response IN ('excellent', 'good', 'moderate', 'poor', 'none'))
);

CREATE INDEX idx_feeding_records_tank ON feeding_records(tank_id);
CREATE INDEX idx_feeding_records_date ON feeding_records(feeding_date);
CREATE INDEX idx_feeding_records_batch ON feeding_records(batch_number);
```

---

## 3.6 GROWTH_SAMPLES (Büyüme Örnekleri)

Periyodik tartım ve ölçüm kayıtları.

```sql
CREATE TABLE growth_samples (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    
    -- İlişkiler
    tank_id UUID NOT NULL REFERENCES equipment(id),
    batch_number VARCHAR(50) NOT NULL,
    
    -- Örnekleme
    sample_date DATE NOT NULL,
    sample_size INT NOT NULL,
    
    -- Ağırlık (gram)
    min_weight_g DECIMAL(10,3),
    max_weight_g DECIMAL(10,3),
    average_weight_g DECIMAL(10,3) NOT NULL,
    total_sample_weight_g DECIMAL(12,3),
    
    -- İstatistik
    standard_deviation DECIMAL(10,3),
    cv_percent DECIMAL(5,2),                      -- Coefficient of Variation
    
    -- Boy (cm) - Opsiyonel
    average_length_cm DECIMAL(6,2),
    
    -- Kondisyon
    condition_factor DECIMAL(5,3),                -- K = (W / L³) × 100
    
    -- Yöntem
    sampling_method VARCHAR(30),                  -- manual, automatic, image_analysis
    
    notes TEXT,
    sampled_by UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT chk_sample_size CHECK (sample_size > 0)
);

CREATE INDEX idx_growth_samples_batch ON growth_samples(batch_number);
CREATE INDEX idx_growth_samples_date ON growth_samples(sample_date);
```

---

## 3.7 TANK_OPERATIONS (Tank İşlemleri)

Tüm tank operasyonlarının geçmişi.

```sql
CREATE TABLE tank_operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL,
    
    -- İşlem
    operation_type VARCHAR(20) NOT NULL,          -- transfer, mortality, cull, harvest, grading
    operation_date DATE NOT NULL,
    operation_time TIME,
    
    -- Tank ve Batch
    source_tank_id UUID REFERENCES equipment(id),
    target_tank_id UUID REFERENCES equipment(id),
    batch_number VARCHAR(50),
    
    -- Miktar
    quantity INT NOT NULL,
    biomass_kg DECIMAL(12,3),
    average_weight_g DECIMAL(10,3),
    
    -- Detaylar (tip bazlı)
    details JSONB,
    /*
    Mortality: {"cause": "disease", "disease_name": "Vibriosis"}
    Cull: {"reason": "small_size", "destination": "discard"}
    Harvest: {"customer": "ABC Ltd", "price_per_kg": 12.50, "grade": "A"}
    Transfer: {"reason": "growth_stage"}
    Grading: {"grade_a_count": 500, "grade_b_count": 300, "reject_count": 50}
    */
    
    notes TEXT,
    performed_by UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT chk_operation_type CHECK (operation_type IN ('transfer', 'mortality', 'cull', 'harvest', 'grading', 'treatment')),
    CONSTRAINT chk_quantity CHECK (quantity > 0)
);

CREATE INDEX idx_tank_operations_date ON tank_operations(operation_date);
CREATE INDEX idx_tank_operations_type ON tank_operations(operation_type);
CREATE INDEX idx_tank_operations_batch ON tank_operations(batch_number);
CREATE INDEX idx_tank_operations_tank ON tank_operations(source_tank_id);
```

---

# 4. FORMÜLLER VE HESAPLAMALAR

## 4.1 Temel Formüller

### Biyokütle
```
Biyokütle (kg) = Adet × Ortalama Ağırlık (g) ÷ 1000
```

### Stoklama Yoğunluğu
```
Yoğunluk (kg/m³) = Biyokütle (kg) ÷ Tank Hacmi (m³)
```

### Hayatta Kalma Oranı (Survival Rate)
```
Survival Rate (%) = ((Başlangıç - Ölüm) ÷ Başlangıç) × 100
```
> **NOT:** Cull (ayıklama) dahil DEĞİL

### Tutma Oranı (Retention Rate)
```
Retention Rate (%) = (Güncel ÷ Başlangıç) × 100
```
> **NOT:** Tüm kayıplar dahil (ölüm + ayıklama)

### Ölüm Oranı (Mortality Rate)
```
Mortality Rate (%) = (Ölüm ÷ Başlangıç) × 100
```

### Yem Dönüşüm Oranı (FCR)
```
FCR = Toplam Tüketilen Yem (kg) ÷ Ağırlık Artışı (kg)

Ağırlık Artışı = Son Biyokütle - Başlangıç Biyokütle + Hasat Edilen + Ölen Biyokütle
```

### Günlük Büyüme Oranı (SGR)
```
SGR (%/gün) = ((ln(Son Ağırlık) - ln(Başlangıç Ağırlık)) ÷ Gün) × 100
```

### Günlük Yem Miktarı
```
Günlük Yem (kg) = Biyokütle (kg) × Yemleme Oranı (%)
```

### CV% (Homojenite)
```
CV (%) = (Standart Sapma ÷ Ortalama) × 100
```

## 4.2 Referans Değerler

### FCR Referansları
| Tür | İyi | Ortalama | Kötü |
|-----|-----|----------|------|
| Levrek | < 1.4 | 1.4-1.6 | > 1.6 |
| Çipura | < 1.5 | 1.5-1.8 | > 1.8 |
| Alabalık | < 1.1 | 1.1-1.3 | > 1.3 |
| Salmon | < 1.2 | 1.2-1.4 | > 1.4 |

### Yemleme Oranları
| Yaşam Evresi | Oran (%) |
|--------------|----------|
| Larva/Fry | 8-15% |
| Fingerling | 5-8% |
| Juvenile | 3-5% |
| Adult | 1-2% |

### Stocking Density
| Tür | Önerilen (kg/m³) |
|-----|------------------|
| Levrek | 15-25 |
| Çipura | 15-25 |
| Alabalık | 30-50 |
| Tilapia | 20-40 |

---

# 5. İŞ AKIŞLARI

## 5.1 Setup Akışı (Yeni Tesis Kurulumu)

```
ADIM 1: SPECIES (Türleri Tanımla)
────────────────────────────────────
├── Levrek (Dicentrarchus labrax)
├── Çipura (Sparus aurata)
└── Alabalık (Oncorhynchus mykiss)

ADIM 2: SUPPLIERS (Tedarikçileri Ekle)
────────────────────────────────────
├── Akdeniz Yavru Ltd. (fry)
├── BioMar Türkiye (feed)
├── Akvaryum Ekipman A.Ş. (equipment)
└── Aqua Pharma (chemical)

ADIM 3: SITE (Tesis Oluştur)
────────────────────────────────────
└── Bodrum Ana Üretim Tesisi
    ├── Tip: sea_cage
    ├── Kapasite: 12,000 m³
    └── Koordinat: 37.0348, 27.4305

ADIM 4: DEPARTMENTS (Departmanlar)
────────────────────────────────────
└── Bodrum Tesisi
    ├── Üretim Departmanı
    ├── Bakım Departmanı
    └── Kalite Kontrol

ADIM 5: SYSTEMS (Sistemler)
────────────────────────────────────
└── Bodrum Tesisi
    ├── Büyütme Sistemi 1 (RAS)
    │   ├── Havalandırma Alt Sistemi
    │   ├── Filtrasyon Alt Sistemi
    │   └── UV Alt Sistemi
    └── Kuluçka Sistemi
        └── Isıtma Alt Sistemi

ADIM 6: EQUIPMENT (Ekipmanlar)
────────────────────────────────────
└── Büyütme Sistemi 1
    ├── Tank-A1 (50 m³)
    ├── Tank-A2 (50 m³)
    ├── Tank-B1 (80 m³)
    ├── Blower-1
    ├── Pump-1
    └── UV-1

ADIM 7: FEED_TYPES (Yem Türleri)
────────────────────────────────────
├── Starter Feed 1mm (Protein: 55%)
├── Grower Feed 3mm (Protein: 48%)
└── Finisher Feed 6mm (Protein: 42%)

ADIM 8: CHEMICALS (Kimyasallar)
────────────────────────────────────
├── Kloramin-T (dezenfektan)
├── Sodyum Bikarbonat (pH ayarlayıcı)
└── Formalin (tedavi)
```

## 5.2 Batch Yaşam Döngüsü

```
┌─────────────────────────────────────────────────────────────────┐
│                    BATCH YAŞAM DÖNGÜSÜ                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ① BATCH OLUŞTUR (Status: PLANNED)                              │
│  ─────────────────────────────────────                          │
│  • Batch numarası: BATCH-000015                                 │
│  • Tür: Levrek                                                  │
│  • Adet: 5,000                                                  │
│  • Ort. Ağırlık: 2.5 g                                         │
│  • Biyokütle: 12.5 kg                                          │
│  • Maliyet: $2,500                                              │
│                     │                                            │
│                     ▼                                            │
│  ② TANK DAĞITIMI (Status: IN_PROGRESS)                          │
│  ─────────────────────────────────────                          │
│  • Tank-A1: 2,000 adet                                          │
│  • Tank-A2: 1,500 adet                                          │
│  • Tank-B1: 1,500 adet                                          │
│                     │                                            │
│                     ▼                                            │
│  ③ GÜNLÜK OPERASYONLAR                                          │
│  ─────────────────────────────────────                          │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Gün 1-150:                                               │   │
│  │ • Yemleme (günde 2-3 kez)                               │   │
│  │ • Ölüm kaydı (gerektiğinde)                             │   │
│  │ • Ayıklama (gerektiğinde)                               │   │
│  │ • Örnekleme (haftalık/aylık)                            │   │
│  │ • Transfer (büyüme aşamalarında)                        │   │
│  │ • Su kalitesi takibi                                    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                     │                                            │
│                     ▼                                            │
│  ④ HASAT (Status: HARVESTED)                                    │
│  ─────────────────────────────────────                          │
│  • Hasat adedi: 4,750                                           │
│  • Ort. Ağırlık: 450 g                                         │
│  • Biyokütle: 2,137.5 kg                                        │
│  • Gelir: $26,718                                               │
│  • Kar: $19,898                                                 │
│  • FCR: 1.38                                                    │
│  • Survival: 98.4%                                              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## 5.3 Yemleme Akışı

```
① YEM STOĞU KONTROL
   └── Feed Inventory'de stok var mı?
       └── Hayır: Uyarı göster, sipariş oluştur
       └── Evet: Devam

② GÜNLÜK YEM MİKTARI HESAPLA
   └── Biyokütle × Yemleme Oranı = Günlük Yem (kg)
   └── Örnek: 87.75 kg × 5% = 4.39 kg/gün

③ YEMLEMEYİ KAYDET
   └── Tank seç
   └── Yem stoğundan seç
   └── Miktar gir
   └── Gözlem ekle (tepki, artık)

④ STOK GÜNCELLE
   └── Feed Inventory: current -= quantity
   └── Batch: total_feed_consumed += quantity

⑤ FCR GÜNCELLE (opsiyonel, periyodik)
   └── FCR = total_feed / weight_gain
```

---

# 6. FRONTEND TASARIMLARI

## 6.1 Dashboard - Genel Bakış

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 🐟 FARM DASHBOARD                                         [Bodrum Tesisi ▼] │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │ Aktif Batch  │  │ Toplam Stok  │  │ Biyokütle    │  │ Bugün Yem    │    │
│  │     12       │  │   45,200     │  │  1,850 kg    │  │   125 kg     │    │
│  │  ↑ 2 bu ay   │  │    adet      │  │  ↑ 5%        │  │  ₺2,500      │    │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘    │
│                                                                              │
│  TANK DURUMU                                                                 │
│  ────────────────────────────────────────────────────────────────────────   │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐  │
│  │ Tank-A1 │ │ Tank-A2 │ │ Tank-B1 │ │ Tank-B2 │ │ Tank-C1 │ │ Tank-C2 │  │
│  │ ████░░░ │ │ ██████░ │ │ ████░░░ │ │ ░░░░░░░ │ │ ████████│ │ ██░░░░░ │  │
│  │ 12 kg/m³│ │ 18 kg/m³│ │ 14 kg/m³│ │ Boş     │ │ 22 kg/m³│ │ 8 kg/m³ │  │
│  │ BATCH-15│ │ BATCH-15│ │ BATCH-16│ │ ─       │ │ BATCH-14│ │ BATCH-17│  │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘  │
│                                                                              │
│  SON BATCH'LER                                   UYARILAR                   │
│  ────────────────────────────────────────────   ─────────────────────────   │
│  │ Batch     │ Tür    │ Adet  │ Durum    │     │ ⚠️ Tank-C1 yoğunluk yüksek│
│  │ BATCH-017 │ Levrek │ 3,200 │ 🔵 Devam │     │ ⚠️ Yem stoğu düşük (2 gün)│
│  │ BATCH-016 │ Çipura │ 4,100 │ 🔵 Devam │     │ 🔴 BATCH-012 FCR > 1.8    │
│  │ BATCH-015 │ Levrek │ 4,800 │ 🔵 Devam │     │ 📅 Tank-B1 bakım yarın    │
│  │ BATCH-014 │ Çipura │ 0     │ 🟢 Hasat │     └────────────────────────────
│                                                                              │
│  BUGÜNKÜ GÖREVLEamuel                                                              │
│  ────────────────────────────────────────────────────────────────────────   │
│  ☐ 08:00 - Sabah yemleme (Tüm tanklar)                                      │
│  ☐ 09:00 - Su kalitesi ölçümü (Tank-A1, A2)                                │
│  ☐ 10:00 - BATCH-015 örnekleme                                              │
│  ☑ 12:00 - Öğle yemleme (Tamamlandı)                                        │
│  ☐ 17:00 - Akşam yemleme                                                    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 6.2 Batch Detay Sayfası

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ BATCH-000015 - Levrek (Dicentrarchus labrax)                               │
│ Durum: 🔵 Devam Ediyor    Yaş: 85 gün    Kalan: 65 gün                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────┬────────────┬────────────┬────────────┬────────────┐        │
│  │ Başlangıç  │ Güncel     │ Survival   │ FCR        │ SGR        │        │
│  │ 5,000 adet │ 4,850 adet │ 98.5%      │ 1.42       │ 3.2%/gün   │        │
│  │            │            │ ✅ İyi     │ ⚠️ Orta   │ ✅ İyi     │        │
│  └────────────┴────────────┴────────────┴────────────┴────────────┘        │
│                                                                              │
│  TANK DAĞILIMI                                                              │
│  ────────────────────────────────────────────────────────────────────────   │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Tank     │ Adet  │ Biyokütle │ Yoğunluk  │ Son Yemleme │ Aksiyon   │   │
│  ├─────────────────────────────────────────────────────────────────────┤   │
│  │ Tank-A1  │ 1,950 │ 87.75 kg  │ 1.76 kg/m³│ Bugün 12:00 │ [▼]       │   │
│  │ Tank-A2  │ 1,450 │ 65.25 kg  │ 1.31 kg/m³│ Bugün 12:00 │ [▼]       │   │
│  │ Tank-B1  │ 1,450 │ 65.25 kg  │ 0.82 kg/m³│ Bugün 12:00 │ [▼]       │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  BÜYÜME GRAFİĞİ                         MALİYET DAĞILIMI                    │
│  ────────────────────────────────────   ─────────────────────────────────   │
│  Ağırlık (g)                            Toplam: ₺48,500                     │
│    50 ┤                    ●                                                │
│    40 ┤                ●                 Yavru   ████████ 32%               │
│    30 ┤            ●                     Yem     ████████████████ 58%       │
│    20 ┤        ●                         Diğer   ████ 10%                   │
│    10 ┤    ●                                                                │
│     0 ┤●                                                                    │
│       └──┬───┬───┬───┬───┬───                                              │
│         0   20  40  60  80 (gün)                                            │
│                                                                              │
│  SON İŞLEMLER                                                               │
│  ────────────────────────────────────────────────────────────────────────   │
│  │ Tarih      │ İşlem      │ Tank    │ Miktar  │ Detay                │    │
│  │ 2024-03-15 │ 🍽️ Yemleme │ Tank-A1 │ 4.5 kg  │ Tepki: İyi          │    │
│  │ 2024-03-15 │ 🍽️ Yemleme │ Tank-A2 │ 3.5 kg  │ Tepki: İyi          │    │
│  │ 2024-03-14 │ 💀 Ölüm    │ Tank-A1 │ 5 adet  │ Sebep: Bilinmiyor   │    │
│  │ 2024-03-10 │ 📏 Örnek   │ Tank-A1 │ 30 adet │ Ort: 45g, CV: 12%   │    │
│  │ 2024-03-01 │ 🔄 Transfer│ A1→B1   │ 500 adet│ Büyüme aşaması      │    │
│                                                                              │
│  [Yemle] [Ölüm Kaydet] [Örnekle] [Transfer] [Hasat] [Rapor]                │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 6.3 Tank Kartı

```
┌─────────────────────────────────────────┐
│ 📦 TANK-A1                              │
│ Büyütme Sistemi 1 - Bodrum              │
├─────────────────────────────────────────┤
│                                          │
│ BATCH: BATCH-000015                      │
│ Tür: Levrek                              │
│                                          │
│ 📊 STOK                                  │
│ ─────────────────────────────────────── │
│ Adet:         1,950                      │
│ Biyokütle:    87.75 kg                   │
│ Ort. Ağırlık: 45 g                       │
│ Yaş:          85 gün                     │
│                                          │
│ 📐 YOĞUNLUK                              │
│ ─────────────────────────────────────── │
│ Tank Hacmi:   50 m³                      │
│ Yoğunluk:     1.76 kg/m³                 │
│ ████░░░░░░░░░░░░░░░░ 7%                 │
│ Maks: 25 kg/m³                           │
│                                          │
│ 🌊 SU KALİTESİ (Son ölçüm: 2 saat önce) │
│ ─────────────────────────────────────── │
│ Sıcaklık:  18.5°C  ✅                   │
│ Oksijen:   7.8 mg/L ✅                  │
│ pH:        7.4      ✅                  │
│ Amonyak:   0.02 mg/L ✅                 │
│                                          │
│ 🍽️ SON YEMLEME                          │
│ ─────────────────────────────────────── │
│ Bugün 12:00 - 4.5 kg                     │
│ Tepki: İyi | Artık: Yok                  │
│                                          │
├─────────────────────────────────────────┤
│ [Yemle] [Ölüm] [Örnek] [Transfer]       │
│ [Ayıkla] [Hasat] [Detay]                │
└─────────────────────────────────────────┘
```

---

# 7. YETKİ MATRİSİ

## 7.1 Rol Bazlı Yetkiler

| Modül / İşlem | VIEWER | TECHNICIAN | SUPERVISOR | MANAGER | ADMIN |
|---------------|--------|------------|------------|---------|-------|
| **SETUP** |
| Site görüntüle | ✅ | ✅ | ✅ | ✅ | ✅ |
| Site oluştur/düzenle | ❌ | ❌ | ❌ | ✅ | ✅ |
| Site sil | ❌ | ❌ | ❌ | ❌ | ✅ |
| Departman yönetimi | ❌ | ❌ | ❌ | ✅ | ✅ |
| Sistem/Alt sistem | ❌ | ❌ | ❌ | ✅ | ✅ |
| Ekipman görüntüle | ✅ | ✅ | ✅ | ✅ | ✅ |
| Ekipman ekle/düzenle | ❌ | ❌ | ✅ | ✅ | ✅ |
| Tedarikçi yönetimi | ❌ | ❌ | ❌ | ✅ | ✅ |
| Tür yönetimi | ❌ | ❌ | ❌ | ✅ | ✅ |
| Yem türü yönetimi | ❌ | ❌ | ✅ | ✅ | ✅ |
| Kimyasal yönetimi | ❌ | ❌ | ✅ | ✅ | ✅ |
| **BATCH** |
| Batch görüntüle | ✅ | ✅ | ✅ | ✅ | ✅ |
| Batch oluştur | ❌ | ❌ | ✅ | ✅ | ✅ |
| Batch düzenle | ❌ | ❌ | ✅ | ✅ | ✅ |
| Tank allocation | ❌ | ❌ | ✅ | ✅ | ✅ |
| **OPERASYONLAR** |
| Yemleme kaydı | ❌ | ✅ | ✅ | ✅ | ✅ |
| Ölüm kaydı | ❌ | ✅ | ✅ | ✅ | ✅ |
| Ayıklama kaydı | ❌ | ✅ | ✅ | ✅ | ✅ |
| Transfer | ❌ | ✅ | ✅ | ✅ | ✅ |
| Örnekleme | ❌ | ✅ | ✅ | ✅ | ✅ |
| Hasat | ❌ | ❌ | ✅ | ✅ | ✅ |
| **STOK** |
| Yem stok görüntüle | ✅ | ✅ | ✅ | ✅ | ✅ |
| Yem stok yönetimi | ❌ | ❌ | ✅ | ✅ | ✅ |
| **RAPORLAR** |
| Rapor görüntüle | ✅ | ✅ | ✅ | ✅ | ✅ |
| Rapor oluştur | ❌ | ✅ | ✅ | ✅ | ✅ |
| Rapor export | ❌ | ✅ | ✅ | ✅ | ✅ |

## 7.2 Rol Tanımları

| Rol | Açıklama |
|-----|----------|
| **VIEWER** | Sadece görüntüleme yetkisi. Hiçbir değişiklik yapamaz. |
| **TECHNICIAN** | Saha çalışanı. Günlük operasyonları (yemleme, ölüm, transfer) kaydeder. |
| **SUPERVISOR** | Ekip lideri. Batch yönetimi, hasat ve stok yönetimi yapabilir. |
| **MANAGER** | Tesis müdürü. Setup tabloları ve tüm operasyonları yönetir. |
| **ADMIN** | Tam yetki. Silme dahil tüm işlemler. |

---

# 8. EQUIPMENT DİNAMİK FORM SİSTEMİ

Equipment tablosu, farklı ekipman tipleri için **dinamik specifications** yapısı kullanır. Ekipman tipi seçildiğinde form alanları değişir ve ilgili teknik özellikler JSONB olarak kaydedilir.

## 8.1 Ekipman Tipleri ve Kategorileri

```
EQUIPMENT TYPES
│
├── PRODUCTION (Üretim)
│   ├── tank          → Yetiştirme tankları
│   ├── cage          → Deniz kafesleri
│   └── pond          → Havuzlar
│
├── WATER TREATMENT (Su Arıtma)
│   ├── pump          → Su pompaları
│   ├── filter        → Filtreler (mekanik, biyolojik)
│   ├── uv            → UV sterilizatörler
│   └── ozone         → Ozon jeneratörleri
│
├── AERATION (Havalandırma)
│   ├── blower        → Hava üfleyiciler
│   ├── aerator       → Havalandırıcılar (yüzey, difüzör)
│   └── oxygenator    → Oksijen jeneratörleri (PSA, LOX)
│
├── CLIMATE (İklim Kontrolü)
│   ├── heater        → Isıtıcılar
│   ├── cooler        → Soğutucular / Chiller
│   └── heat_pump     → Isı pompaları
│
├── FEEDING (Besleme)
│   └── feeder        → Otomatik yemlikler
│
├── MONITORING (İzleme)
│   ├── sensor        → Su kalitesi sensörleri
│   ├── camera        → Kameralar
│   └── controller    → PLC / Kontrol üniteleri
│
└── UTILITY (Altyapı)
    ├── generator     → Jeneratörler
    ├── transformer   → Trafolar
    └── compressor    → Kompresörler
```

## 8.2 Ortak Form Alanları (Tüm Tipler)

```
┌─────────────────────────────────────────────────────────────────┐
│ EKİPMAN KAYDI                                                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ TEMEL BİLGİLER (Her zaman görünür)                              │
│ ─────────────────────────────────────────────────────────────── │
│                                                                  │
│ Ekipman Adı *              Ekipman Kodu                         │
│ [____________________]    [__________]                          │
│                                                                  │
│ Ekipman Tipi * ← Bu seçime göre TEKNİK ÖZELLİKLER değişir      │
│ [▼ Seçiniz                                          ]           │
│                                                                  │
│ LOKASYON                                                        │
│ ─────────────────────────────────────────────────────────────── │
│ Site *                      Departman                           │
│ [▼ Bodrum Tesisi]          [▼ Üretim Dept.]                    │
│                                                                  │
│ Sistem                      Alt Sistem                          │
│ [▼ Büyütme Sistemi 1]      [▼ Havalandırma]                    │
│                                                                  │
│ Bağlı Olduğu Ekipman (Parent)                                   │
│ [▼ Hiçbiri                                          ]           │
│                                                                  │
│ ÜRÜN BİLGİLERİ                                                  │
│ ─────────────────────────────────────────────────────────────── │
│ Marka                       Model                               │
│ [____________________]     [____________________]               │
│                                                                  │
│ Üretici                                                         │
│ [________________________________________________]             │
│                                                                  │
│ Seri Numarası               Tedarikçi                          │
│ [____________________]     [▼ Seçiniz]                         │
│                                                                  │
│ SATIN ALMA                                                      │
│ ─────────────────────────────────────────────────────────────── │
│ Satın Alma Tarihi     Fiyat              Para Birimi           │
│ [📅 ../../....]      [__________]       [▼ TRY]                │
│                                                                  │
│ Beklenen Ömür (yıl)                                             │
│ [____]                                                          │
│                                                                  │
│ GARANTİ                                                         │
│ ─────────────────────────────────────────────────────────────── │
│ Garanti Başlangıç          Garanti Bitiş                       │
│ [📅 ../../....]           [📅 ../../....]                      │
│                                                                  │
│ Garanti Notları                                                 │
│ [________________________________________________]             │
│                                                                  │
│ BAKIM                                                           │
│ ─────────────────────────────────────────────────────────────── │
│ Son Bakım                   Sonraki Bakım                       │
│ [📅 ../../....]           [📅 ../../....]                      │
│                                                                  │
│ Bakım Periyodu (gün)                                            │
│ [____]                                                          │
│                                                                  │
│ DURUM                                                           │
│ ─────────────────────────────────────────────────────────────── │
│ [▼ Operational                                      ]           │
│   • Operational (Çalışır)                                       │
│   • Maintenance (Bakımda)                                       │
│   • Repair (Onarımda)                                           │
│   • Stored (Depoda)                                             │
│   • Decommissioned (Hizmet dışı)                               │
│                                                                  │
│ ═══════════════════════════════════════════════════════════════ │
│ TEKNİK ÖZELLİKLER (Ekipman tipine göre dinamik)                │
│ ═══════════════════════════════════════════════════════════════ │
│                                                                  │
│                    [Tip seçildiğinde görünür]                   │
│                                                                  │
│ ─────────────────────────────────────────────────────────────── │
│ KURULUM NOTLARI                                                 │
│ [________________________________________________]             │
│ [________________________________________________]             │
│                                                                  │
│                        [İptal]    [Kaydet]                      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## 8.3 Tip Bazlı Specifications Şemaları

### TİP 1: TANK

```
┌─────────────────────────────────────────────────────────────────┐
│ TEKNİK ÖZELLİKLER - TANK                                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ Tank Şekli *                                                    │
│ [▼ Circular                                         ]           │
│   • Circular (Dairesel)                                         │
│   • Rectangular (Dikdörtgen)                                    │
│   • Square (Kare)                                               │
│   • Octagonal (Sekizgen)                                        │
│   • Raceway (Oluk)                                              │
│                                                                  │
│ BOYUTLAR                                                        │
│ ─────────────────────────────────────────────────────────────── │
│ (Dairesel için)                                                 │
│ Hacim (m³) *        Çap (m)            Derinlik (m)            │
│ [______]           [______]           [______]                  │
│                                                                  │
│ (Dikdörtgen için)                                               │
│ Hacim (m³) *        Uzunluk (m)        Genişlik (m)            │
│ [______]           [______]           [______]                  │
│                                                                  │
│ Derinlik (m)                                                    │
│ [______]                                                        │
│                                                                  │
│ Malzeme *                                                       │
│ [▼ Fiberglass                                       ]           │
│   • Concrete (Beton)        • Fiberglass (Fiberglas)           │
│   • HDPE (Plastik)          • Steel (Çelik)                    │
│   • Liner (Geomembran)      • GRP                              │
│                                                                  │
│ KAPASİTE                                                        │
│ ─────────────────────────────────────────────────────────────── │
│ Maks. Yoğunluk (kg/m³)      Maks. Kapasite (kg)                │
│ [______]                   [______] (otomatik hesap)           │
│                                                                  │
│ BAĞLANTILAR                                                     │
│ ─────────────────────────────────────────────────────────────── │
│ Su Giriş (mm)    Su Çıkış (mm)    Dip Tahliye (mm)             │
│ [______]        [______]         [______]                       │
│                                                                  │
│ ÖZELLİKLER                                                      │
│ ─────────────────────────────────────────────────────────────── │
│ ☑ Merkezi Tahliye       ☑ Havalandırma Sistemi                 │
│ ☐ Isıtma Sistemi        ☐ Soğutma Sistemi                      │
│ ☐ Otomatik Yemleme      ☑ Su Kalitesi Sensörü                  │
│ ☐ UV Sterilizasyon      ☐ Kapak/Örtü                           │
│                                                                  │
│ Renk: [▼ Blue]                                                  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Veritabanı Specifications (Tank):**
```json
{
  "shape": "circular",
  "volume_m3": 50,
  "diameter_m": 5,
  "depth_m": 3,
  "length_m": null,
  "width_m": null,
  "material": "fiberglass",
  "max_density_kg_m3": 100,
  "max_capacity_kg": 5000,
  "inlet_diameter_mm": 100,
  "outlet_diameter_mm": 150,
  "drain_diameter_mm": 200,
  "features": {
    "central_drain": true,
    "aeration": true,
    "heating": false,
    "cooling": false,
    "auto_feeder": false,
    "sensors": true,
    "uv": false,
    "cover": false
  },
  "color": "blue"
}
```

**Validation Kuralları (Tank):**
```typescript
interface TankSpecifications {
  shape: 'circular' | 'rectangular' | 'square' | 'octagonal' | 'raceway';  // required
  volume_m3: number;           // required, min: 0.1
  diameter_m?: number;         // required if shape = circular
  length_m?: number;           // required if shape = rectangular
  width_m?: number;            // required if shape = rectangular
  depth_m: number;             // required, min: 0.1
  material: 'concrete' | 'fiberglass' | 'hdpe' | 'steel' | 'liner' | 'grp';  // required
  max_density_kg_m3?: number;  // optional, default: 100
  max_capacity_kg?: number;    // auto-calculated: volume × density
}
```

---

### TİP 2: PUMP (Pompa)

```
┌─────────────────────────────────────────────────────────────────┐
│ TEKNİK ÖZELLİKLER - POMPA                                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ Pompa Tipi *                                                    │
│ [▼ Centrifugal                                      ]           │
│   • Centrifugal (Santrifüj)                                     │
│   • Submersible (Dalgıç)                                        │
│   • Diaphragm (Diyafram)                                        │
│   • Peristaltic (Peristaltik)                                   │
│   • Airlift (Hava kaldırma)                                     │
│   • Axial (Aksiyal)                                             │
│                                                                  │
│ ELEKTRİK                                                        │
│ ─────────────────────────────────────────────────────────────── │
│ Güç (kW) *          Voltaj (V)          Faz                    │
│ [______]           [______]           [▼ 3-Phase]              │
│                                                                  │
│ Frekans (Hz)                                                    │
│ [▼ 50 Hz]                                                       │
│                                                                  │
│ KAPASİTE                                                        │
│ ─────────────────────────────────────────────────────────────── │
│ Maks. Debi (m³/h) *        Maks. Basınç (bar)                  │
│ [__________]              [__________]                          │
│                                                                  │
│ Basma Yüksekliği (m)                                            │
│ [______]                                                        │
│                                                                  │
│ BAĞLANTILAR                                                     │
│ ─────────────────────────────────────────────────────────────── │
│ Emme Çapı (mm)             Basma Çapı (mm)                     │
│ [______]                  [______]                              │
│                                                                  │
│ ÇALIŞMA KOŞULLARI                                               │
│ ─────────────────────────────────────────────────────────────── │
│ Min. Sıcaklık (°C)         Maks. Sıcaklık (°C)                 │
│ [______]                  [______]                              │
│                                                                  │
│ Maks. Çalışma Derinliği (m) (Dalgıç pompa için)                │
│ [______]                                                        │
│                                                                  │
│ Verimlilik (%)                                                  │
│ [______]                                                        │
│                                                                  │
│ KORUMA ÖZELLİKLERİ                                              │
│ ─────────────────────────────────────────────────────────────── │
│ ☑ Frekans Kontrol (VFD)    ☐ Yüzdürme Şalteri                  │
│ ☑ Aşırı Isınma Koruması    ☑ Kuru Çalışma Koruması             │
│ ☐ Aşırı Akım Koruması      ☐ Sızıntı Sensörü                   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Veritabanı Specifications (Pump):**
```json
{
  "pump_type": "centrifugal",
  "power_kw": 5.5,
  "voltage_v": 380,
  "phase": "3-phase",
  "frequency_hz": 50,
  "max_flow_m3h": 120,
  "max_pressure_bar": 4.5,
  "head_m": 15,
  "suction_diameter_mm": 100,
  "discharge_diameter_mm": 80,
  "min_temp_c": 0,
  "max_temp_c": 40,
  "max_depth_m": null,
  "efficiency_percent": 85,
  "protection": {
    "vfd": true,
    "float_switch": false,
    "thermal": true,
    "dry_run": true,
    "overcurrent": false,
    "leak_sensor": false
  }
}
```

---

### TİP 3: BLOWER (Hava Üfleyici)

```
┌─────────────────────────────────────────────────────────────────┐
│ TEKNİK ÖZELLİKLER - BLOWER                                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ Blower Tipi *                                                   │
│ [▼ Rotary Lobe                                      ]           │
│   • Rotary Lobe (Döner loplu)                                   │
│   • Regenerative (Rejeneratif/Side Channel)                     │
│   • Centrifugal (Santrifüj)                                     │
│   • Screw (Vidalı)                                              │
│   • Turbo                                                       │
│                                                                  │
│ ELEKTRİK                                                        │
│ ─────────────────────────────────────────────────────────────── │
│ Güç (kW) *          Voltaj (V)          Faz                    │
│ [______]           [______]           [▼ 3-Phase]              │
│                                                                  │
│ KAPASİTE                                                        │
│ ─────────────────────────────────────────────────────────────── │
│ Hava Debisi (m³/h) *       Basınç (mbar) *                     │
│ [__________]              [__________]                          │
│                                                                  │
│ Maks. Vakum (mbar)                                              │
│ [______] (negatif basınç için)                                 │
│                                                                  │
│ BAĞLANTI                                                        │
│ ─────────────────────────────────────────────────────────────── │
│ Çıkış Çapı (mm)                                                 │
│ [______]                                                        │
│                                                                  │
│ PERFORMANS                                                      │
│ ─────────────────────────────────────────────────────────────── │
│ Gürültü Seviyesi (dB)      Devir (RPM)                         │
│ [______]                  [______]                              │
│                                                                  │
│ Hizmet Verdiği Tank Sayısı                                      │
│ [______]                                                        │
│                                                                  │
│ ÖZELLİKLER                                                      │
│ ─────────────────────────────────────────────────────────────── │
│ ☑ Ses İzolasyonu           ☑ Titreşim Damperi                  │
│ ☑ Giriş Filtresi           ☐ Çıkış Susturucusu                 │
│ ☐ VFD Kontrol              ☐ Basınç Valfi                      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Veritabanı Specifications (Blower):**
```json
{
  "blower_type": "rotary_lobe",
  "power_kw": 15,
  "voltage_v": 380,
  "phase": "3-phase",
  "air_flow_m3h": 500,
  "pressure_mbar": 400,
  "vacuum_mbar": null,
  "outlet_diameter_mm": 80,
  "noise_level_db": 75,
  "rpm": 3000,
  "serves_tank_count": 8,
  "features": {
    "sound_insulation": true,
    "vibration_damper": true,
    "inlet_filter": true,
    "outlet_silencer": false,
    "vfd": false,
    "pressure_relief": false
  }
}
```

---

### TİP 4: FILTER (Filtre)

```
┌─────────────────────────────────────────────────────────────────┐
│ TEKNİK ÖZELLİKLER - FİLTRE                                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ Filtre Tipi *                                                   │
│ [▼ Drum Filter                                      ]           │
│   • Drum Filter (Davul filtre)                                  │
│   • Sand Filter (Kum filtre)                                    │
│   • Bead Filter (Boncuk filtre)                                 │
│   • Cartridge (Kartuş filtre)                                   │
│   • Bag Filter (Torba filtre)                                   │
│   • Moving Bed (MBBR - Biyolojik)                               │
│   • Trickling (Damlatmalı biyofiltre)                           │
│   • Protein Skimmer                                             │
│                                                                  │
│ Filtre Kategorisi                                               │
│ [▼ Mechanical                                       ]           │
│   • Mechanical (Mekanik - partikül tutma)                       │
│   • Biological (Biyolojik - nitrifikasyon)                      │
│   • Chemical (Kimyasal - aktif karbon vb.)                      │
│                                                                  │
│ KAPASİTE                                                        │
│ ─────────────────────────────────────────────────────────────── │
│ Filtre Hacmi (m³)          İşlem Kapasitesi (m³/h) *           │
│ [______]                  [__________]                          │
│                                                                  │
│ Filtrasyon İnceliği (mikron)                                    │
│ [______] µm (mekanik filtre için)                              │
│                                                                  │
│ BAĞLANTILAR                                                     │
│ ─────────────────────────────────────────────────────────────── │
│ Giriş Çapı (mm)            Çıkış Çapı (mm)                     │
│ [______]                  [______]                              │
│                                                                  │
│ MEDYA BİLGİLERİ                                                 │
│ ─────────────────────────────────────────────────────────────── │
│ Medya Tipi                                                      │
│ [▼ Bead                                             ]           │
│   • Sand (Kum)              • Bead (Boncuk)                    │
│   • Bio-ball (Biyotop)      • Ceramic (Seramik)                │
│   • Activated Carbon        • K1/K3 Media                       │
│                                                                  │
│ Medya Miktarı              Birim                               │
│ [______]                  [▼ kg]                               │
│                                                                  │
│ BAKIM                                                           │
│ ─────────────────────────────────────────────────────────────── │
│ Geri Yıkama Periyodu (gün)                                      │
│ [______]                                                        │
│                                                                  │
│ Medya Değişim Periyodu (ay)                                     │
│ [______]                                                        │
│                                                                  │
│ ÖZELLİKLER                                                      │
│ ─────────────────────────────────────────────────────────────── │
│ ☑ Otomatik Geri Yıkama     ☑ Basınç Göstergesi                 │
│ ☐ Diferansiyel Basınç      ☑ Temizleme Alarmı                  │
│ ☐ PLC Kontrol                                                   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Veritabanı Specifications (Filter):**
```json
{
  "filter_type": "drum_filter",
  "filter_category": "mechanical",
  "volume_m3": 2.5,
  "flow_capacity_m3h": 80,
  "filtration_micron": 60,
  "inlet_diameter_mm": 150,
  "outlet_diameter_mm": 150,
  "media": {
    "type": "screen",
    "quantity": null,
    "unit": null
  },
  "maintenance": {
    "backwash_frequency_days": 0,
    "media_replacement_months": 60
  },
  "features": {
    "auto_backwash": true,
    "pressure_gauge": true,
    "differential_pressure": false,
    "cleaning_alarm": true,
    "plc_control": false
  }
}
```

---

### TİP 5: UV STERİLİZATÖR

```
┌─────────────────────────────────────────────────────────────────┐
│ TEKNİK ÖZELLİKLER - UV STERİLİZATÖR                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ UV Tipi *                                                       │
│ [▼ In-line                                          ]           │
│   • In-line (Hat tipi)                                          │
│   • Submersible (Dalgıç)                                        │
│   • Open Channel (Açık kanal)                                   │
│                                                                  │
│ LAMBA BİLGİLERİ                                                 │
│ ─────────────────────────────────────────────────────────────── │
│ Lamba Gücü (W) *           Lamba Sayısı *                      │
│ [______]                  [______]                              │
│                                                                  │
│ Toplam UV Gücü (W)                                              │
│ [______] (otomatik hesap)                                      │
│                                                                  │
│ Dalga Boyu (nm)                                                 │
│ [▼ 254 nm (UV-C)]                                              │
│                                                                  │
│ Lamba Tipi                                                      │
│ [▼ Low Pressure                                     ]           │
│   • Low Pressure (Düşük basınç - 254nm)                        │
│   • Medium Pressure (Orta basınç - geniş spektrum)             │
│   • Amalgam (Yüksek çıkış)                                      │
│                                                                  │
│ KAPASİTE                                                        │
│ ─────────────────────────────────────────────────────────────── │
│ İşlem Kapasitesi (m³/h) *                                       │
│ [__________]                                                    │
│                                                                  │
│ UV Dozu (mJ/cm²)                                                │
│ [______] (önerilen: 40-100 mJ/cm²)                             │
│                                                                  │
│ BAĞLANTILAR                                                     │
│ ─────────────────────────────────────────────────────────────── │
│ Giriş/Çıkış Çapı (mm)                                          │
│ [______]                                                        │
│                                                                  │
│ BAKIM                                                           │
│ ─────────────────────────────────────────────────────────────── │
│ Lamba Ömrü (saat)          Sonraki Değişim                     │
│ [______]                  [📅 ../../....]                      │
│                                                                  │
│ Kuvars Tüp Temizleme Periyodu (gün)                            │
│ [______]                                                        │
│                                                                  │
│ ÖZELLİKLER                                                      │
│ ─────────────────────────────────────────────────────────────── │
│ ☑ Lamba Arıza Alarmı       ☑ UV Yoğunluk Sensörü              │
│ ☐ Otomatik Temizleme       ☐ Sıcaklık Sensörü                  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Veritabanı Specifications (UV):**
```json
{
  "uv_type": "inline",
  "lamp_power_w": 80,
  "lamp_count": 4,
  "total_power_w": 320,
  "wavelength_nm": 254,
  "lamp_type": "low_pressure",
  "flow_capacity_m3h": 50,
  "uv_dose_mj_cm2": 60,
  "connection_diameter_mm": 110,
  "lamp_life_hours": 9000,
  "next_lamp_change": "2025-06-15",
  "quartz_cleaning_days": 30,
  "features": {
    "lamp_failure_alarm": true,
    "uv_intensity_sensor": true,
    "auto_cleaning": false,
    "temperature_sensor": false
  }
}
```

---

### TİP 6: OZONE GENERATOR (Ozon Jeneratörü)

```
┌─────────────────────────────────────────────────────────────────┐
│ TEKNİK ÖZELLİKLER - OZON JENERATÖRÜ                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ Üretim Yöntemi *                                                │
│ [▼ Corona Discharge                                 ]           │
│   • Corona Discharge (Korona deşarj)                            │
│   • UV Ozone (UV ozon)                                          │
│   • Electrolytic (Elektrolitik)                                 │
│                                                                  │
│ KAPASİTE                                                        │
│ ─────────────────────────────────────────────────────────────── │
│ Ozon Üretimi (g/h) *                                            │
│ [__________]                                                    │
│                                                                  │
│ Konsantrasyon (%)                                               │
│ [______] %                                                      │
│                                                                  │
│ ELEKTRİK                                                        │
│ ─────────────────────────────────────────────────────────────── │
│ Güç (kW)            Voltaj (V)                                 │
│ [______]           [______]                                     │
│                                                                  │
│ BESLEME GAZI                                                    │
│ ─────────────────────────────────────────────────────────────── │
│ Gaz Kaynağı                                                     │
│ [▼ Oxygen                                           ]           │
│   • Oxygen (Saf oksijen - yüksek verim)                        │
│   • Air (Hava - düşük verim)                                   │
│                                                                  │
│ Gaz Debisi (L/min)                                              │
│ [______]                                                        │
│                                                                  │
│ BAKIM                                                           │
│ ─────────────────────────────────────────────────────────────── │
│ Hücre Ömrü (saat)          Sonraki Değişim                     │
│ [______]                  [📅 ../../....]                      │
│                                                                  │
│ ÖZELLİKLER                                                      │
│ ─────────────────────────────────────────────────────────────── │
│ ☑ Ozon Monitörü            ☑ Kaçak Dedektörü                   │
│ ☑ Otomatik Ayar            ☐ ORP Kontrol                       │
│                                                                  │
│ ⚠️ GÜVENLİK UYARISI                                            │
│ Ozon gazı tehlikeli olabilir. Havalandırma gereklidir.         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Veritabanı Specifications (Ozone):**
```json
{
  "generation_method": "corona_discharge",
  "ozone_output_gh": 50,
  "concentration_percent": 8,
  "power_kw": 0.8,
  "voltage_v": 220,
  "feed_gas": "oxygen",
  "gas_flow_lpm": 5,
  "cell_life_hours": 20000,
  "next_cell_change": "2026-01-15",
  "features": {
    "ozone_monitor": true,
    "leak_detector": true,
    "auto_adjustment": true,
    "orp_control": false
  }
}
```

---

### TİP 7: HEATER (Isıtıcı)

```
┌─────────────────────────────────────────────────────────────────┐
│ TEKNİK ÖZELLİKLER - ISITICI                                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ Isıtıcı Tipi *                                                  │
│ [▼ Electric Immersion                               ]           │
│   • Electric Immersion (Elektrikli daldırma)                   │
│   • Electric Flow (Elektrikli akış)                            │
│   • Heat Exchanger (Eşanjör)                                    │
│   • Boiler (Kazan)                                              │
│   • Solar (Güneş enerjisi)                                      │
│                                                                  │
│ KAPASİTE                                                        │
│ ─────────────────────────────────────────────────────────────── │
│ Isıtma Gücü (kW) *                                              │
│ [______]                                                        │
│                                                                  │
│ Isıtma Kapasitesi (m³)                                          │
│ [______]                                                        │
│                                                                  │
│ ELEKTRİK (Elektrikli için)                                      │
│ ─────────────────────────────────────────────────────────────── │
│ Voltaj (V)           Faz                                        │
│ [______]            [▼ 3-Phase]                                │
│                                                                  │
│ SICAKLIK KONTROLÜ                                               │
│ ─────────────────────────────────────────────────────────────── │
│ Min. Ayar (°C)             Maks. Ayar (°C)                     │
│ [______]                  [______]                              │
│                                                                  │
│ Hassasiyet (°C)                                                 │
│ [______] ±                                                      │
│                                                                  │
│ MALZEME                                                         │
│ ─────────────────────────────────────────────────────────────── │
│ Element Malzemesi                                               │
│ [▼ Titanium                                         ]           │
│   • Titanium (Tuzlu su için)                                   │
│   • Stainless Steel (Tatlı su için)                            │
│   • Incoloy                                                     │
│                                                                  │
│ KORUMA                                                          │
│ ─────────────────────────────────────────────────────────────── │
│ ☑ Dijital Termostat        ☑ Sıcaklık Sensörü                  │
│ ☑ Aşırı Isınma Koruması    ☐ Kuru Çalışma Koruması             │
│ ☐ Uzaktan Kontrol                                               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Veritabanı Specifications (Heater):**
```json
{
  "heater_type": "electric_immersion",
  "heating_power_kw": 12,
  "heating_capacity_m3": 50,
  "voltage_v": 380,
  "phase": "3-phase",
  "temp_range": {
    "min_c": 10,
    "max_c": 35
  },
  "accuracy_c": 0.5,
  "element_material": "titanium",
  "protection": {
    "digital_thermostat": true,
    "temp_sensor": true,
    "overheat": true,
    "dry_run": false,
    "remote_control": false
  }
}
```

---

### TİP 8: COOLER / CHILLER (Soğutucu)

```
┌─────────────────────────────────────────────────────────────────┐
│ TEKNİK ÖZELLİKLER - SOĞUTUCU                                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ Soğutucu Tipi *                                                 │
│ [▼ Water Chiller                                    ]           │
│   • Water Chiller (Su soğutucu)                                │
│   • Heat Exchanger (Eşanjör)                                    │
│   • Evaporative (Evaporatif)                                    │
│   • Geothermal (Jeotermal)                                      │
│                                                                  │
│ Soğutucu Gazı                                                   │
│ [▼ R410A                                            ]           │
│   • R410A, R134a, R407C, R32                                   │
│                                                                  │
│ KAPASİTE                                                        │
│ ─────────────────────────────────────────────────────────────── │
│ Soğutma Kapasitesi (kW) *                                       │
│ [______]                                                        │
│                                                                  │
│ Soğutma Hacmi (m³)                                              │
│ [______]                                                        │
│                                                                  │
│ ELEKTRİK                                                        │
│ ─────────────────────────────────────────────────────────────── │
│ Güç (kW)            Voltaj (V)                                 │
│ [______]           [______]                                     │
│                                                                  │
│ SICAKLIK                                                        │
│ ─────────────────────────────────────────────────────────────── │
│ Min. Sıcaklık (°C)         Maks. Sıcaklık (°C)                 │
│ [______]                  [______]                              │
│                                                                  │
│ Hassasiyet (°C)                                                 │
│ [______] ±                                                      │
│                                                                  │
│ VERİMLİLİK                                                      │
│ ─────────────────────────────────────────────────────────────── │
│ COP (Performans Katsayısı)                                      │
│ [______]                                                        │
│                                                                  │
│ ÖZELLİKLER                                                      │
│ ─────────────────────────────────────────────────────────────── │
│ ☑ Dijital Kontrol          ☑ Düşük Sıcaklık Alarmı            │
│ ☑ Kompresör Koruması       ☐ Uzaktan İzleme                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Veritabanı Specifications (Cooler):**
```json
{
  "cooler_type": "water_chiller",
  "refrigerant": "R410A",
  "cooling_capacity_kw": 25,
  "cooling_volume_m3": 100,
  "power_kw": 8,
  "voltage_v": 380,
  "temp_range": {
    "min_c": 4,
    "max_c": 25
  },
  "accuracy_c": 0.5,
  "cop": 3.5,
  "features": {
    "digital_control": true,
    "low_temp_alarm": true,
    "compressor_protection": true,
    "remote_monitoring": false
  }
}
```

---

### TİP 9: SENSOR (Sensör)

```
┌─────────────────────────────────────────────────────────────────┐
│ TEKNİK ÖZELLİKLER - SENSÖR                                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ Sensör Tipi *                                                   │
│ [▼ Multi-parameter                                  ]           │
│   • Temperature (Sıcaklık)                                      │
│   • pH                                                          │
│   • Dissolved Oxygen (Çözünmüş oksijen)                        │
│   • Conductivity (İletkenlik / Tuzluluk)                       │
│   • Turbidity (Bulanıklık)                                      │
│   • Ammonia (Amonyak)                                           │
│   • ORP (Redox)                                                 │
│   • Multi-parameter (Çoklu parametre)                          │
│                                                                  │
│ ÖLÇÜM PARAMETRELERİ (Multi-parameter için)                     │
│ ─────────────────────────────────────────────────────────────── │
│ ☑ Temperature     ☑ pH              ☑ Dissolved O₂            │
│ ☑ Conductivity    ☐ Turbidity       ☐ Ammonia                 │
│ ☐ Salinity        ☐ ORP             ☐ Nitrite                 │
│                                                                  │
│ ÖLÇÜM ARALIKLARI                                                │
│ ─────────────────────────────────────────────────────────────── │
│ Temperature: [-5 ~ 50°C_______]                                │
│ pH:          [0 - 14__________]                                │
│ DO:          [0 - 20 mg/L_____]                                │
│ Conductivity:[0 - 50000 µS/cm_]                                │
│                                                                  │
│ HASSASİYET                                                      │
│ ─────────────────────────────────────────────────────────────── │
│ Temperature: [±0.2°C___]                                        │
│ pH:          [±0.05____]                                        │
│ DO:          [±0.1 mg/L]                                        │
│ Conductivity:[±1%______]                                        │
│                                                                  │
│ KALİBRASYON                                                     │
│ ─────────────────────────────────────────────────────────────── │
│ Kalibrasyon Periyodu (gün)                                      │
│ [______]                                                        │
│                                                                  │
│ Son Kalibrasyon             Sonraki Kalibrasyon                │
│ [📅 ../../....]            [📅 ../../....]                     │
│                                                                  │
│ VERİ İLETİMİ                                                    │
│ ─────────────────────────────────────────────────────────────── │
│ Protokol                                                        │
│ [▼ RS485 (Modbus)                                   ]           │
│   • RS485 (Modbus)          • 4-20mA (Analog)                  │
│   • RS232                   • WiFi                              │
│   • Bluetooth               • LoRa                              │
│                                                                  │
│ ÖZELLİKLER                                                      │
│ ─────────────────────────────────────────────────────────────── │
│ ☑ Otomatik Kalibrasyon     ☑ Dahili Veri Kaydedici            │
│ ☑ Alarm Çıkışı             ☑ Su Geçirmez (IP68)               │
│ ☐ Kablosuz Bağlantı        ☐ Güneş Paneli Desteği             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Veritabanı Specifications (Sensor):**
```json
{
  "sensor_type": "multi_parameter",
  "parameters": ["temperature", "ph", "dissolved_oxygen", "conductivity"],
  "measurement_ranges": {
    "temperature": "-5 to 50°C",
    "ph": "0-14",
    "dissolved_oxygen": "0-20 mg/L",
    "conductivity": "0-50000 µS/cm"
  },
  "accuracy": {
    "temperature": "±0.2°C",
    "ph": "±0.05",
    "dissolved_oxygen": "±0.1 mg/L",
    "conductivity": "±1%"
  },
  "calibration": {
    "frequency_days": 30,
    "last_calibration": "2024-02-15",
    "next_calibration": "2024-03-16"
  },
  "data_protocol": "rs485_modbus",
  "features": {
    "auto_calibration": true,
    "data_logger": true,
    "alarm_output": true,
    "waterproof_rating": "IP68",
    "wireless": false,
    "solar_panel": false
  }
}
```

---

### TİP 10: FEEDER (Otomatik Yemlik)

```
┌─────────────────────────────────────────────────────────────────┐
│ TEKNİK ÖZELLİKLER - OTOMATİK YEMLİK                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ Yemlik Tipi *                                                   │
│ [▼ Automatic Belt                                   ]           │
│   • Manual (Manuel)                                             │
│   • Automatic Belt (Bantlı otomatik)                           │
│   • Automatic Screw (Vidalı otomatik)                          │
│   • Demand (Talep bazlı / Pendulum)                            │
│   • Pneumatic (Havalı püskürtme)                               │
│                                                                  │
│ KAPASİTE                                                        │
│ ─────────────────────────────────────────────────────────────── │
│ Hazne Kapasitesi (kg) *                                         │
│ [______]                                                        │
│                                                                  │
│ Dağıtım Hızı (kg/dakika)                                        │
│ [______]                                                        │
│                                                                  │
│ Desteklenen Pelet Boyutu (mm)                                   │
│ Min: [______]  Maks: [______]                                  │
│                                                                  │
│ KONTROL                                                         │
│ ─────────────────────────────────────────────────────────────── │
│ Kontrol Tipi                                                    │
│ [▼ Timer-based                                      ]           │
│   • Timer-based (Zamanlayıcı)                                   │
│   • Sensor-based (Sensör bazlı)                                │
│   • Computer-controlled (Bilgisayar)                           │
│   • Camera-based (Kamera bazlı - AI)                           │
│                                                                  │
│ PROGRAMLAMA                                                     │
│ ─────────────────────────────────────────────────────────────── │
│ Günlük Maks. Öğün Sayısı                                        │
│ [______]                                                        │
│                                                                  │
│ Dağıtım Alanı (m²)                                              │
│ [______]                                                        │
│                                                                  │
│ GÜÇ                                                             │
│ ─────────────────────────────────────────────────────────────── │
│ Güç Kaynağı                                                     │
│ [▼ AC 220V                                          ]           │
│   • AC 220V                 • AC 380V                          │
│   • DC 12V (Solar)          • DC 24V                           │
│                                                                  │
│ ÖZELLİKLER                                                      │
│ ─────────────────────────────────────────────────────────────── │
│ ☑ Programlanabilir          ☑ Yem Seviye Sensörü              │
│ ☑ Besleme Log Kaydı         ☐ Kamera Entegrasyonu              │
│ ☐ Uzaktan Kontrol           ☐ GPS Konum                        │
│ ☐ Güneş Paneli                                                  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Veritabanı Specifications (Feeder):**
```json
{
  "feeder_type": "automatic_belt",
  "hopper_capacity_kg": 100,
  "feed_rate_kg_min": 2,
  "pellet_size_mm": {
    "min": 2,
    "max": 8
  },
  "control_type": "timer_based",
  "max_feedings_per_day": 12,
  "distribution_area_m2": 50,
  "power_source": "ac_220v",
  "features": {
    "programmable": true,
    "feed_level_sensor": true,
    "feeding_log": true,
    "camera_integration": false,
    "remote_control": false,
    "gps": false,
    "solar_panel": false
  }
}
```

---

### TİP 11: GENERATOR (Jeneratör)

```
┌─────────────────────────────────────────────────────────────────┐
│ TEKNİK ÖZELLİKLER - JENERATÖR                                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ Jeneratör Tipi *                                                │
│ [▼ Diesel                                           ]           │
│   • Diesel                  • Gas (Doğalgaz)                   │
│   • Petrol                  • Hybrid                            │
│                                                                  │
│ GÜÇ                                                             │
│ ─────────────────────────────────────────────────────────────── │
│ Prime Güç (kVA) *          Standby Güç (kVA)                   │
│ [______]                  [______]                              │
│                                                                  │
│ Çıkış Voltajı (V)          Frekans (Hz)                        │
│ [______]                  [▼ 50 Hz]                            │
│                                                                  │
│ Faz                                                             │
│ [▼ 3-Phase                                          ]           │
│                                                                  │
│ MOTOR                                                           │
│ ─────────────────────────────────────────────────────────────── │
│ Motor Markası                                                   │
│ [____________________]                                          │
│                                                                  │
│ Yakıt Tüketimi (L/saat) - %100 yükte                           │
│ [______]                                                        │
│                                                                  │
│ Yakıt Tankı Kapasitesi (L)                                      │
│ [______]                                                        │
│                                                                  │
│ OTOMATİK TRANSFER                                               │
│ ─────────────────────────────────────────────────────────────── │
│ ☑ Otomatik Transfer Panosu (ATS)                               │
│ Transfer Süresi (saniye): [______]                             │
│                                                                  │
│ ÖZELLİKLER                                                      │
│ ─────────────────────────────────────────────────────────────── │
│ ☑ Otomatik Start           ☑ Ses İzolasyonu (Kabin)           │
│ ☑ Uzaktan İzleme           ☐ Paralel Çalışma                   │
│ ☐ Yük Paylaşımı                                                 │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Veritabanı Specifications (Generator):**
```json
{
  "generator_type": "diesel",
  "prime_power_kva": 100,
  "standby_power_kva": 110,
  "voltage_v": 400,
  "frequency_hz": 50,
  "phase": "3-phase",
  "engine_brand": "Perkins",
  "fuel_consumption_lph": 22,
  "fuel_tank_capacity_l": 200,
  "ats": {
    "enabled": true,
    "transfer_time_sec": 10
  },
  "features": {
    "auto_start": true,
    "sound_proof_canopy": true,
    "remote_monitoring": true,
    "parallel_operation": false,
    "load_sharing": false
  }
}
```

---

### TİP 12: AERATOR (Havalandırıcı)

```
┌─────────────────────────────────────────────────────────────────┐
│ TEKNİK ÖZELLİKLER - HAVALANDIRICI                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ Havalandırıcı Tipi *                                            │
│ [▼ Paddle Wheel                                     ]           │
│   • Paddle Wheel (Çark tipi)                                   │
│   • Aspirator (Emişli)                                         │
│   • Diffuser (Difüzör)                                         │
│   • Spray (Püskürtmeli)                                        │
│   • Venturi (Enjektör)                                         │
│   • Cascade (Şelale)                                           │
│                                                                  │
│ GÜÇ VE KAPASİTE                                                 │
│ ─────────────────────────────────────────────────────────────── │
│ Motor Gücü (kW/HP) *        Voltaj (V)                         │
│ [______] kW / [______] HP  [______]                            │
│                                                                  │
│ Oksijen Transfer Oranı (kg O₂/kWh)                             │
│ [______]                                                        │
│                                                                  │
│ Hizmet Alanı (m²)                                               │
│ [______]                                                        │
│                                                                  │
│ MONTAJ                                                          │
│ ─────────────────────────────────────────────────────────────── │
│ Montaj Tipi                                                     │
│ [▼ Floating                                         ]           │
│   • Floating (Yüzen)        • Fixed (Sabit)                    │
│   • Submersible (Dalgıç)                                       │
│                                                                  │
│ ÖZELLİKLER                                                      │
│ ─────────────────────────────────────────────────────────────── │
│ ☑ Paslanmaz Şaft           ☐ Değişken Hız                      │
│ ☐ Otomatik Kontrol                                              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Veritabanı Specifications (Aerator):**
```json
{
  "aerator_type": "paddle_wheel",
  "motor_power_kw": 2.2,
  "motor_power_hp": 3,
  "voltage_v": 380,
  "oxygen_transfer_kg_kwh": 1.8,
  "service_area_m2": 1000,
  "mounting_type": "floating",
  "features": {
    "stainless_shaft": true,
    "variable_speed": false,
    "auto_control": false
  }
}
```

---

### TİP 13: OXYGENATOR (Oksijen Sistemi)

```
┌─────────────────────────────────────────────────────────────────┐
│ TEKNİK ÖZELLİKLER - OKSİJEN SİSTEMİ                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ Sistem Tipi *                                                   │
│ [▼ PSA Generator                                    ]           │
│   • PSA Generator (Basınçlı salınım adsorpsiyon)               │
│   • LOX Tank (Sıvı oksijen tankı)                              │
│   • Oxygen Concentrator (Oksijen konsantratörü)                │
│   • Oxygen Cone (Oksijen konisi)                               │
│                                                                  │
│ KAPASİTE                                                        │
│ ─────────────────────────────────────────────────────────────── │
│ Üretim Kapasitesi (Nm³/h) *  (PSA için)                        │
│ [______]                                                        │
│                                                                  │
│ Tank Kapasitesi (L) *        (LOX için)                        │
│ [______]                                                        │
│                                                                  │
│ Saflık (%)                                                      │
│ [______] % (tipik: 90-95%)                                     │
│                                                                  │
│ Basınç (bar)                                                    │
│ [______]                                                        │
│                                                                  │
│ DAĞITIM                                                         │
│ ─────────────────────────────────────────────────────────────── │
│ Dağıtım Yöntemi                                                 │
│ [▼ Diffuser                                         ]           │
│   • Diffuser (Difüzör)      • Cone (Koni)                      │
│   • Venturi (Enjektör)      • U-Tube                           │
│                                                                  │
│ Hizmet Verdiği Tank Sayısı                                      │
│ [______]                                                        │
│                                                                  │
│ ÖZELLİKLER                                                      │
│ ─────────────────────────────────────────────────────────────── │
│ ☑ Otomatik Kontrol         ☑ DO Sensör Entegrasyonu           │
│ ☑ Düşük Oksijen Alarmı     ☐ Uzaktan İzleme                   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Veritabanı Specifications (Oxygenator):**
```json
{
  "system_type": "psa_generator",
  "production_capacity_nm3h": 10,
  "tank_capacity_l": null,
  "purity_percent": 93,
  "pressure_bar": 4,
  "distribution_method": "diffuser",
  "serves_tank_count": 12,
  "features": {
    "auto_control": true,
    "do_sensor_integration": true,
    "low_oxygen_alarm": true,
    "remote_monitoring": false
  }
}
```

---

## 8.4 TypeScript Interface Tanımları

```typescript
// Tüm equipment tiplerinin temel yapısı
interface EquipmentBase {
  id: string;
  tenant_id: string;
  name: string;
  code?: string;
  type: EquipmentType;
  
  // Lokasyon
  site_id: string;
  department_id?: string;
  system_id?: string;
  sub_system_id?: string;
  parent_equipment_id?: string;
  
  // Ürün bilgileri
  brand?: string;
  model?: string;
  manufacturer?: string;
  serial_number?: string;
  supplier_id?: string;
  
  // Satın alma
  purchase_date?: Date;
  purchase_price?: number;
  currency?: string;
  expected_lifespan_years?: number;
  
  // Garanti
  warranty_start_date?: Date;
  warranty_end_date?: Date;
  warranty_notes?: string;
  
  // Bakım
  last_maintenance_date?: Date;
  next_maintenance_date?: Date;
  maintenance_interval_days?: number;
  
  // Durum
  status: EquipmentStatus;
  
  // Dinamik özellikler
  specifications: EquipmentSpecifications;
  
  // Notlar
  location_description?: string;
  installation_notes?: string;
}

type EquipmentType = 
  | 'tank' | 'cage' | 'pond'
  | 'pump' | 'filter' | 'uv' | 'ozone'
  | 'blower' | 'aerator' | 'oxygenator'
  | 'heater' | 'cooler' | 'heat_pump'
  | 'feeder'
  | 'sensor' | 'camera' | 'controller'
  | 'generator' | 'transformer' | 'compressor'
  | 'other';

type EquipmentStatus = 
  | 'operational' 
  | 'maintenance' 
  | 'repair' 
  | 'stored' 
  | 'decommissioned';

// Tip bazlı specifications union type
type EquipmentSpecifications = 
  | TankSpecifications
  | PumpSpecifications
  | BlowerSpecifications
  | FilterSpecifications
  | UvSpecifications
  | OzoneSpecifications
  | HeaterSpecifications
  | CoolerSpecifications
  | SensorSpecifications
  | FeederSpecifications
  | GeneratorSpecifications
  | AeratorSpecifications
  | OxygenatorSpecifications
  | GenericSpecifications;

// Her tip için interface tanımları
interface TankSpecifications {
  shape: 'circular' | 'rectangular' | 'square' | 'octagonal' | 'raceway';
  volume_m3: number;
  diameter_m?: number;
  length_m?: number;
  width_m?: number;
  depth_m: number;
  material: string;
  max_density_kg_m3?: number;
  max_capacity_kg?: number;
  inlet_diameter_mm?: number;
  outlet_diameter_mm?: number;
  drain_diameter_mm?: number;
  features?: {
    central_drain?: boolean;
    aeration?: boolean;
    heating?: boolean;
    cooling?: boolean;
    auto_feeder?: boolean;
    sensors?: boolean;
    uv?: boolean;
    cover?: boolean;
  };
  color?: string;
}

interface PumpSpecifications {
  pump_type: 'centrifugal' | 'submersible' | 'diaphragm' | 'peristaltic' | 'airlift' | 'axial';
  power_kw: number;
  voltage_v: number;
  phase: '1-phase' | '3-phase';
  frequency_hz?: number;
  max_flow_m3h: number;
  max_pressure_bar?: number;
  head_m?: number;
  suction_diameter_mm?: number;
  discharge_diameter_mm?: number;
  min_temp_c?: number;
  max_temp_c?: number;
  max_depth_m?: number;
  efficiency_percent?: number;
  protection?: {
    vfd?: boolean;
    float_switch?: boolean;
    thermal?: boolean;
    dry_run?: boolean;
    overcurrent?: boolean;
    leak_sensor?: boolean;
  };
}

// Diğer tipler için interface'ler benzer şekilde tanımlanır...

interface GenericSpecifications {
  [key: string]: any;  // Diğer/bilinmeyen tipler için esnek yapı
}
```

## 8.5 Frontend Dinamik Form Bileşeni

```typescript
// React bileşeni örneği
const EquipmentForm: React.FC = () => {
  const [equipmentType, setEquipmentType] = useState<EquipmentType | ''>('');
  const [specifications, setSpecifications] = useState<EquipmentSpecifications>({});
  
  // Tip değiştiğinde specifications'ı sıfırla
  useEffect(() => {
    if (equipmentType) {
      setSpecifications(getDefaultSpecifications(equipmentType));
    }
  }, [equipmentType]);
  
  // Tip bazlı specifications form render
  const renderSpecificationsForm = () => {
    switch (equipmentType) {
      case 'tank':
        return <TankSpecificationsForm 
                 value={specifications as TankSpecifications} 
                 onChange={setSpecifications} />;
      case 'pump':
        return <PumpSpecificationsForm 
                 value={specifications as PumpSpecifications} 
                 onChange={setSpecifications} />;
      case 'blower':
        return <BlowerSpecificationsForm 
                 value={specifications as BlowerSpecifications} 
                 onChange={setSpecifications} />;
      case 'filter':
        return <FilterSpecificationsForm 
                 value={specifications as FilterSpecifications} 
                 onChange={setSpecifications} />;
      case 'uv':
        return <UvSpecificationsForm 
                 value={specifications as UvSpecifications} 
                 onChange={setSpecifications} />;
      case 'ozone':
        return <OzoneSpecificationsForm 
                 value={specifications as OzoneSpecifications} 
                 onChange={setSpecifications} />;
      case 'heater':
        return <HeaterSpecificationsForm 
                 value={specifications as HeaterSpecifications} 
                 onChange={setSpecifications} />;
      case 'cooler':
        return <CoolerSpecificationsForm 
                 value={specifications as CoolerSpecifications} 
                 onChange={setSpecifications} />;
      case 'sensor':
        return <SensorSpecificationsForm 
                 value={specifications as SensorSpecifications} 
                 onChange={setSpecifications} />;
      case 'feeder':
        return <FeederSpecificationsForm 
                 value={specifications as FeederSpecifications} 
                 onChange={setSpecifications} />;
      case 'generator':
        return <GeneratorSpecificationsForm 
                 value={specifications as GeneratorSpecifications} 
                 onChange={setSpecifications} />;
      case 'aerator':
        return <AeratorSpecificationsForm 
                 value={specifications as AeratorSpecifications} 
                 onChange={setSpecifications} />;
      case 'oxygenator':
        return <OxygenatorSpecificationsForm 
                 value={specifications as OxygenatorSpecifications} 
                 onChange={setSpecifications} />;
      default:
        return <GenericSpecificationsForm 
                 value={specifications} 
                 onChange={setSpecifications} />;
    }
  };
  
  return (
    <form onSubmit={handleSubmit}>
      {/* Ortak alanlar */}
      <CommonFieldsSection />
      
      {/* Tip seçimi */}
      <Select 
        label="Ekipman Tipi" 
        value={equipmentType}
        onChange={(e) => setEquipmentType(e.target.value as EquipmentType)}
        required
      >
        <optgroup label="Üretim">
          <option value="tank">Tank</option>
          <option value="cage">Kafes</option>
          <option value="pond">Havuz</option>
        </optgroup>
        <optgroup label="Su Arıtma">
          <option value="pump">Pompa</option>
          <option value="filter">Filtre</option>
          <option value="uv">UV Sterilizatör</option>
          <option value="ozone">Ozon Jeneratörü</option>
        </optgroup>
        <optgroup label="Havalandırma">
          <option value="blower">Blower</option>
          <option value="aerator">Havalandırıcı</option>
          <option value="oxygenator">Oksijen Sistemi</option>
        </optgroup>
        <optgroup label="İklim Kontrolü">
          <option value="heater">Isıtıcı</option>
          <option value="cooler">Soğutucu</option>
        </optgroup>
        <optgroup label="Besleme">
          <option value="feeder">Otomatik Yemlik</option>
        </optgroup>
        <optgroup label="İzleme">
          <option value="sensor">Sensör</option>
        </optgroup>
        <optgroup label="Altyapı">
          <option value="generator">Jeneratör</option>
        </optgroup>
        <option value="other">Diğer</option>
      </Select>
      
      {/* Dinamik specifications formu */}
      {equipmentType && (
        <fieldset>
          <legend>Teknik Özellikler</legend>
          {renderSpecificationsForm()}
        </fieldset>
      )}
      
      {/* Ortak alanlar devam */}
      <NotesSection />
      
      <Button type="submit">Kaydet</Button>
    </form>
  );
};
```

## 8.6 Validation Kuralları Özeti

| Tip | Zorunlu Alanlar | Koşullu Zorunlu |
|-----|-----------------|-----------------|
| **Tank** | shape, volume_m3, material, depth_m | diameter (circular), length/width (rectangular) |
| **Pump** | pump_type, power_kw, voltage_v, max_flow_m3h | max_depth_m (submersible için) |
| **Blower** | blower_type, power_kw, air_flow_m3h, pressure_mbar | - |
| **Filter** | filter_type, flow_capacity_m3h | media_type (biological için) |
| **UV** | uv_type, lamp_power_w, lamp_count, flow_capacity_m3h | - |
| **Ozone** | generation_method, ozone_output_gh | - |
| **Heater** | heater_type, heating_power_kw | voltage (electric için), cop (heat_pump için) |
| **Cooler** | cooler_type, cooling_capacity_kw | refrigerant (chiller için) |
| **Sensor** | sensor_type, data_protocol | parameters (multi için) |
| **Feeder** | feeder_type, hopper_capacity_kg | - |
| **Generator** | generator_type, prime_power_kva, voltage_v | - |
| **Aerator** | aerator_type, motor_power_kw | - |
| **Oxygenator** | system_type | production_capacity (PSA için), tank_capacity (LOX için) |

---

# 9. VERİ TUTARLILIĞI KURALLARI

## 8.1 Kritik Kurallar

### Batch Quantity Tutarlılığı
```
batch_inputs.current_quantity = SUM(tank_batches.current_quantity 
                                    WHERE batch_number IN batch_numbers)
```

### Biyokütle Hesaplaması
```
tank_batches.current_biomass_kg = 
    (tank_batches.current_quantity × tank_batches.average_weight_g) / 1000
```

### Yoğunluk Hesaplaması
```
tank_batches.stocking_density_kg_m3 = 
    tank_batches.current_biomass_kg / equipment.specifications.volume_m3
```

### FCR Hesaplaması
```
batch_inputs.fcr = 
    batch_inputs.total_feed_consumed_kg / 
    (final_biomass - initial_biomass + harvested_biomass + mortality_biomass)
```

## 8.2 Cascade Kuralları

| Parent | Child | Delete Action |
|--------|-------|---------------|
| sites | departments | CASCADE |
| sites | systems | CASCADE |
| sites | batch_inputs | RESTRICT |
| systems | sub_systems | CASCADE |
| systems | equipment | SET NULL |
| equipment (tank) | tank_batches | CASCADE |
| equipment (tank) | tank_allocations | CASCADE |
| batch_inputs | tank_allocations | CASCADE |
| suppliers | batch_inputs | RESTRICT |
| species | batch_inputs | RESTRICT |
| feed_types | feed_inventory | RESTRICT |

## 8.3 Soft Delete

Audit trail için veriler kalıcı silinmez:
```sql
UPDATE table SET 
    is_deleted = true,
    deleted_at = NOW(),
    deleted_by = user_id
WHERE id = record_id;
```

---

# 10. ÖZET

Bu doküman, Farm Module'ün tam teknik altyapısını tanımlar:

## 10.1 Tablolar

| Kategori | Tablolar | Adet |
|----------|----------|------|
| **Setup** | sites, site_contacts, departments, systems, sub_systems, species, suppliers, supplier_sites, equipment, chemicals, chemical_sites, feed_types, feed_type_species | 13 |
| **Batch** | batch_inputs, tank_allocations, tank_batches, feed_inventory, feeding_records, growth_samples, tank_operations | 7 |
| **Toplam** | | **20** |

## 10.2 Equipment Tipleri

| Kategori | Tipler |
|----------|--------|
| **Üretim** | tank, cage, pond |
| **Su Arıtma** | pump, filter, uv, ozone |
| **Havalandırma** | blower, aerator, oxygenator |
| **İklim** | heater, cooler, heat_pump |
| **Besleme** | feeder |
| **İzleme** | sensor, camera, controller |
| **Altyapı** | generator, transformer, compressor |

## 10.3 Temel Formüller

```
FCR = Toplam Yem (kg) ÷ Ağırlık Artışı (kg)
Survival Rate = ((Başlangıç - Ölüm) ÷ Başlangıç) × 100
Retention Rate = (Güncel ÷ Başlangıç) × 100
Biyokütle = Adet × Ort. Ağırlık (g) ÷ 1000
Yoğunluk = Biyokütle (kg) ÷ Hacim (m³)
SGR = ((ln(Son) - ln(Baş)) ÷ Gün) × 100
```

## 10.4 Önemli Notlar

1. **Mortality ≠ Cull:** Ayrı sayaçlar, farklı oranlar
2. **FCR hesabı:** `total_feed_consumed` alanı zorunlu
3. **Equipment dinamik:** Tip seçimine göre specifications değişir
4. **Soft Delete:** Audit trail için is_deleted kullanılır
5. **Cascade kuralları:** Parent-child ilişkilerde tutarlı

## 10.5 Yetki Seviyeleri

| Rol          | Açıklama |
|--------------|----------|
| VIEWER       | Sadece görüntüleme |
| TECHNICIAN   | Günlük operasyonlar |
| SUPERVISOR   | Batch + stok yönetimi |
| MANAGER      | Setup + tüm operasyonlar |
| TENANT ADMIN | Tam yetki (silme dahil) |

---

**Versiyon:** 3.0  
**Son Güncelleme:** 2024  
**Toplam Tablo:** 20 (13 setup + 7 batch)  
**Equipment Tipleri:** 13 ana tip + alt tipler