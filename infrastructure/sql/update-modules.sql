-- ============================================================================
-- Module Structure Update - 3 Core Modules
-- ============================================================================
-- Bu script mevcut 8 modülü 3 ana modüle dönüştürür:
-- 1. farm - Balık Çiftliği Yönetimi
-- 2. hr - İnsan Kaynakları
-- 3. sensor - Sensör İzleme (YENİ)
-- ============================================================================

BEGIN;

-- ============================================================================
-- Adım 1: Eski modüllerin bağımlılıklarını temizle
-- ============================================================================

-- Tenant-module assignments
DELETE FROM tenant_modules
WHERE "moduleId" IN (
  SELECT id FROM modules
  WHERE code IN ('seapod', 'sales', 'inventory', 'crm', 'finance', 'project')
);

-- User-module assignments
DELETE FROM user_module_assignments
WHERE "moduleId" IN (
  SELECT id FROM modules
  WHERE code IN ('seapod', 'sales', 'inventory', 'crm', 'finance', 'project')
);

-- Plan-module assignments
DELETE FROM plan_module_assignments
WHERE "moduleId" IN (
  SELECT id FROM modules
  WHERE code IN ('seapod', 'sales', 'inventory', 'crm', 'finance', 'project')
);

-- Module pricing
DELETE FROM module_pricing
WHERE "moduleCode" IN ('seapod', 'sales', 'inventory', 'crm', 'finance', 'project');

-- ============================================================================
-- Adım 2: Eski modülleri sil
-- ============================================================================

DELETE FROM modules
WHERE code IN ('seapod', 'sales', 'inventory', 'crm', 'finance', 'project');

-- ============================================================================
-- Adım 3: Sensor modülünü ekle
-- ============================================================================

INSERT INTO modules (
  id,
  code,
  name,
  description,
  icon,
  color,
  "isActive",
  "sortOrder",
  "defaultRoute",
  features,
  price,
  is_core,
  "createdAt",
  "updatedAt"
)
VALUES (
  gen_random_uuid(),
  'sensor',
  'Sensör İzleme',
  'IoT sensör yönetimi, gerçek zamanlı veri izleme, uyarılar ve analiz',
  'activity',
  '#06B6D4',
  true,
  3,
  '/sensor/dashboard',
  'devices,readings,alerts,calibration,thresholds,analytics,trends,reports',
  75.00,
  false,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT (code) DO NOTHING;

-- ============================================================================
-- Adım 4: Farm modülünü güncelle (Inventory dahil)
-- ============================================================================

UPDATE modules SET
  features = 'farms,sites,tanks,batches,species,feeding,growth,water-quality,fish-health,harvest,maintenance,equipment,suppliers,chemicals,feeds,inventory,analytics,reports',
  description = 'Tam kapsamlı balık çiftliği yönetimi: havuz yönetimi, stok takibi, besleme programları, büyüme analizi, su kalitesi izleme, hasat planlaması, envanter ve detaylı analitik',
  "sortOrder" = 1,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE code = 'farm';

-- ============================================================================
-- Adım 5: HR modülünü güncelle
-- ============================================================================

UPDATE modules SET
  features = 'employees,departments,attendance,leaves,payroll,performance,training,certifications,scheduling,analytics,reports',
  description = 'İnsan kaynakları yönetimi: personel takibi, departman yönetimi, devam kontrolü, izin yönetimi, bordro, performans değerlendirme, eğitim takibi ve HR analitik',
  "sortOrder" = 2,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE code = 'hr';

-- ============================================================================
-- Adım 6: Module Pricing güncelle
-- ============================================================================

-- Eski pricing'leri temizle (kaldırılan modüller için)
DELETE FROM module_pricing
WHERE "moduleCode" NOT IN ('farm', 'hr', 'sensor');

-- Sensor modülü pricing ekle
INSERT INTO module_pricing (
  id,
  "moduleId",
  "moduleCode",
  "pricingMetrics",
  "tierMultipliers",
  currency,
  "effectiveFrom",
  "isActive",
  version,
  "createdAt",
  "updatedAt"
)
SELECT
  gen_random_uuid(),
  m.id,
  'sensor',
  '[
    {"type": "BASE_PRICE", "price": 75, "currency": "USD", "includedQuantity": 1},
    {"type": "PER_USER", "price": 10, "currency": "USD", "includedQuantity": 2, "minQuantity": 1, "maxQuantity": 100},
    {"type": "PER_SENSOR", "price": 2, "currency": "USD", "includedQuantity": 10, "minQuantity": 1, "maxQuantity": 1000},
    {"type": "PER_DEVICE", "price": 5, "currency": "USD", "includedQuantity": 2, "minQuantity": 1, "maxQuantity": 50},
    {"type": "PER_GB_STORAGE", "price": 0.5, "currency": "USD", "includedQuantity": 10, "minQuantity": 1, "maxQuantity": 500},
    {"type": "PER_ALERT", "price": 0.02, "currency": "USD", "includedQuantity": 1000, "minQuantity": 1}
  ]'::jsonb,
  '{"free": 0, "starter": 1.0, "professional": 0.9, "enterprise": 0.7, "custom": 1.0}'::jsonb,
  'USD',
  CURRENT_TIMESTAMP,
  true,
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM modules m
WHERE m.code = 'sensor'
AND NOT EXISTS (SELECT 1 FROM module_pricing WHERE "moduleCode" = 'sensor');

-- ============================================================================
-- Adım 7: Verification
-- ============================================================================

COMMIT;

-- Sonuçları göster
SELECT
  code,
  name,
  "sortOrder",
  "isActive",
  features
FROM modules
ORDER BY "sortOrder";
