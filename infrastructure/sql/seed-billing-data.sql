-- ============================================================================
-- Billing & System Seed Data
-- ============================================================================

-- ============================================================================
-- Plan Definitions (Pricing Tiers)
-- ============================================================================

INSERT INTO plan_definitions (id, code, name, description, "shortDescription", tier, visibility, "isActive", "isRecommended", "sortOrder", limits, pricing, features, "trialDays", "createdAt", "updatedAt", "createdBy")
VALUES
  -- Trial Plan
  (gen_random_uuid(), 'TRIAL_PLAN', 'Deneme Planı', 'Ücretsiz 14 günlük deneme süresi. Tüm özelliklere sınırlı erişim.', 'Ücretsiz deneme', 'trial', 'public', true, false, 1,
   '{"maxUsers": 3, "maxPonds": 5, "maxSensors": 10, "dataRetentionDays": 30, "apiCallsPerMonth": 1000}'::jsonb,
   '{"monthly": 0, "yearly": 0, "currency": "TRY"}'::jsonb,
   '["Temel çiftlik yönetimi", "5 havuz desteği", "Günlük raporlar", "Email desteği"]'::jsonb,
   14, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'SYSTEM'),

  -- Starter Plan
  (gen_random_uuid(), 'STARTER_PLAN', 'Başlangıç', 'Küçük çiftlikler için ideal başlangıç paketi.', 'Küçük çiftlikler için', 'starter', 'public', true, false, 2,
   '{"maxUsers": 10, "maxPonds": 20, "maxSensors": 50, "dataRetentionDays": 90, "apiCallsPerMonth": 10000}'::jsonb,
   '{"monthly": 499, "yearly": 4990, "currency": "TRY"}'::jsonb,
   '["Tam çiftlik yönetimi", "20 havuz desteği", "Haftalık raporlar", "Sensor entegrasyonu", "Email ve chat desteği"]'::jsonb,
   7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'SYSTEM'),

  -- Professional Plan
  (gen_random_uuid(), 'PROFESSIONAL_PLAN', 'Profesyonel', 'Orta ölçekli çiftlikler için kapsamlı çözüm.', 'Profesyonel çözüm', 'professional', 'public', true, true, 3,
   '{"maxUsers": 50, "maxPonds": 100, "maxSensors": 200, "dataRetentionDays": 365, "apiCallsPerMonth": 100000}'::jsonb,
   '{"monthly": 1499, "yearly": 14990, "currency": "TRY"}'::jsonb,
   '["Gelişmiş çiftlik yönetimi", "100 havuz desteği", "Anlık raporlar ve analitik", "Tam sensor entegrasyonu", "API erişimi", "7/24 destek", "Özel eğitim"]'::jsonb,
   NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'SYSTEM'),

  -- Enterprise Plan
  (gen_random_uuid(), 'ENTERPRISE_PLAN', 'Kurumsal', 'Büyük işletmeler için özelleştirilmiş kurumsal çözüm.', 'Kurumsal çözüm', 'enterprise', 'public', true, false, 4,
   '{"maxUsers": -1, "maxPonds": -1, "maxSensors": -1, "dataRetentionDays": -1, "apiCallsPerMonth": -1}'::jsonb,
   '{"monthly": 4999, "yearly": 49990, "currency": "TRY"}'::jsonb,
   '["Sınırsız çiftlik yönetimi", "Sınırsız havuz", "Gelişmiş analitik ve AI tahmin", "Özel entegrasyonlar", "Dedicated sunucu", "7/24 öncelikli destek", "Özel hesap yöneticisi", "SLA garantisi"]'::jsonb,
   NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'SYSTEM')
ON CONFLICT (code) DO NOTHING;

-- ============================================================================
-- Subscriptions
-- ============================================================================

-- Create subscriptions for existing tenants
DO $$
DECLARE
  tenant_rec RECORD;
  plan_tier_val subscriptions_plantier_enum;
  status_val subscriptions_status_enum;
  billing_cycle_val subscriptions_billingcycle_enum := 'monthly';
  pricing_val jsonb;
BEGIN
  FOR tenant_rec IN SELECT id, name, plan, status FROM tenants LOOP
    -- Determine plan tier enum value
    plan_tier_val := CASE tenant_rec.plan
      WHEN 'TRIAL' THEN 'trial'::subscriptions_plantier_enum
      WHEN 'STARTER' THEN 'starter'::subscriptions_plantier_enum
      WHEN 'PROFESSIONAL' THEN 'professional'::subscriptions_plantier_enum
      WHEN 'ENTERPRISE' THEN 'enterprise'::subscriptions_plantier_enum
      ELSE 'trial'::subscriptions_plantier_enum
    END;

    -- Determine status
    status_val := CASE tenant_rec.plan
      WHEN 'TRIAL' THEN 'trial'::subscriptions_status_enum
      ELSE 'active'::subscriptions_status_enum
    END;

    -- Set pricing
    pricing_val := CASE tenant_rec.plan
      WHEN 'TRIAL' THEN '{"basePrice": 0, "discounts": []}'::jsonb
      WHEN 'STARTER' THEN '{"basePrice": 499, "discounts": []}'::jsonb
      WHEN 'PROFESSIONAL' THEN '{"basePrice": 1499, "discounts": []}'::jsonb
      WHEN 'ENTERPRISE' THEN '{"basePrice": 4999, "discounts": []}'::jsonb
      ELSE '{"basePrice": 0, "discounts": []}'::jsonb
    END;

    -- Insert subscription if not exists
    INSERT INTO subscriptions (
      id, "tenantId", "planTier", "planName", status, "billingCycle", pricing,
      "startDate", "endDate", "currentPeriodStart", "currentPeriodEnd",
      "trialEndDate", "autoRenew", "createdAt", "updatedAt"
    )
    SELECT
      gen_random_uuid(),
      tenant_rec.id::text,
      plan_tier_val,
      CASE tenant_rec.plan
        WHEN 'TRIAL' THEN 'Deneme Planı'
        WHEN 'STARTER' THEN 'Başlangıç'
        WHEN 'PROFESSIONAL' THEN 'Profesyonel'
        WHEN 'ENTERPRISE' THEN 'Kurumsal'
        ELSE 'Deneme Planı'
      END,
      status_val,
      billing_cycle_val,
      pricing_val,
      CURRENT_TIMESTAMP - INTERVAL '30 days',
      CASE WHEN tenant_rec.plan = 'TRIAL' THEN CURRENT_TIMESTAMP + INTERVAL '14 days' ELSE NULL END,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP + INTERVAL '30 days',
      CASE WHEN tenant_rec.plan = 'TRIAL' THEN CURRENT_TIMESTAMP + INTERVAL '14 days' ELSE NULL END,
      true,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s."tenantId" = tenant_rec.id::text);
  END LOOP;
END $$;

-- ============================================================================
-- Feature Toggles
-- ============================================================================

INSERT INTO feature_toggles (id, key, name, description, scope, status, category, "rolloutPercentage", "requiresRestart", "isExperimental", "createdBy", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'dark_mode', 'Karanlık Mod', 'Kullanıcı arayüzü için karanlık tema desteği', 'global', 'enabled', 'ui', 100, false, false, 'SYSTEM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'ai_predictions', 'AI Tahminleri', 'Yapay zeka destekli büyüme ve hastalık tahminleri', 'plan', 'enabled', 'features', 100, false, false, 'SYSTEM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'advanced_analytics', 'Gelişmiş Analitik', 'Detaylı veri analizi ve görselleştirme araçları', 'plan', 'enabled', 'features', 100, false, false, 'SYSTEM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'export_excel', 'Excel Dışa Aktarma', 'Verileri Excel formatında dışa aktarma', 'global', 'enabled', 'features', 100, false, false, 'SYSTEM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'sms_notifications', 'SMS Bildirimleri', 'Kritik uyarılar için SMS gönderimi', 'global', 'disabled', 'notifications', 0, false, false, 'SYSTEM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'beta_features', 'Beta Özellikler', 'Deneysel özelliklere erişim', 'tenant', 'disabled', 'experimental', 0, false, true, 'SYSTEM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'multi_language', 'Çoklu Dil Desteği', 'Arayüz çoklu dil seçeneği', 'global', 'enabled', 'ui', 100, false, false, 'SYSTEM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'mobile_app', 'Mobil Uygulama', 'iOS ve Android mobil uygulama erişimi', 'plan', 'enabled', 'features', 100, false, false, 'SYSTEM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- Announcements
-- ============================================================================

INSERT INTO announcements (id, title, content, type, status, scope, "isGlobal", "requiresAcknowledgment", "viewCount", "acknowledgmentCount", "publishAt", "expiresAt", "createdBy", "createdByName", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'Platforma Hoş Geldiniz!', 'Aquaculture Platform''a hoş geldiniz. Çiftlik yönetimi sistemimiz hakkında sorularınız için destek ekibimizle iletişime geçebilirsiniz.', 'info', 'published', 'global', true, false, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '30 days', '00000000-0000-0000-0000-000000000000'::uuid, 'Sistem', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Yeni Özellik: AI Tahminleri', 'Professional ve Enterprise planlarımıza yapay zeka destekli büyüme tahminleri özelliği eklendi. Daha fazla bilgi için belgelerimizi inceleyin.', 'feature', 'published', 'plan', true, false, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '60 days', '00000000-0000-0000-0000-000000000000'::uuid, 'Sistem', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Planlı Bakım Bildirimi', 'Her Pazar gecesi 02:00-04:00 arasında planlı bakım çalışması yapılmaktadır. Bu sürede sistem kısa süreli kesintiler yaşayabilir.', 'maintenance', 'published', 'global', true, false, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '90 days', '00000000-0000-0000-0000-000000000000'::uuid, 'Sistem', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'Güvenlik Güncellemesi', 'Platform güvenliğini artırmak için iki faktörlü kimlik doğrulamayı etkinleştirmenizi öneririz.', 'warning', 'published', 'global', true, true, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '14 days', '00000000-0000-0000-0000-000000000000'::uuid, 'Sistem', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- Job Queues
-- ============================================================================

INSERT INTO job_queues (id, name, description, "isActive", "isPaused", concurrency, "maxJobsPerSecond", "defaultMaxRetries", "defaultTimeoutMs", "pendingCount", "runningCount", "completedCount", "failedCount", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'email', 'Email gönderim kuyruğu', true, false, 5, 10, 3, 60000, 0, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'sms', 'SMS gönderim kuyruğu', true, false, 2, 5, 3, 120000, 0, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'report-generation', 'Rapor oluşturma kuyruğu', true, false, 3, 5, 2, 300000, 0, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'data-export', 'Veri dışa aktarma kuyruğu', true, false, 2, 5, 2, 180000, 0, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'sensor-data-processing', 'Sensor verisi işleme kuyruğu', true, false, 10, 100, 5, 30000, 0, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'alert-processing', 'Uyarı işleme kuyruğu', true, false, 5, 50, 3, 60000, 0, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'cleanup', 'Veri temizleme kuyruğu', true, false, 1, 1, 1, 600000, 0, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'backup', 'Yedekleme kuyruğu', true, false, 1, 1, 3, 1800000, 0, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT (name) DO NOTHING;

-- ============================================================================
-- Verification Query
-- ============================================================================

SELECT 'plan_definitions' as table_name, COUNT(*) as record_count FROM plan_definitions
UNION ALL SELECT 'subscriptions', COUNT(*) FROM subscriptions
UNION ALL SELECT 'feature_toggles', COUNT(*) FROM feature_toggles
UNION ALL SELECT 'announcements', COUNT(*) FROM announcements
UNION ALL SELECT 'job_queues', COUNT(*) FROM job_queues
ORDER BY table_name;
