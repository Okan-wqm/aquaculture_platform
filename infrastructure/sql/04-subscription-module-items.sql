-- ============================================================================
-- Subscription Module Items Table & Tenant Modules Extensions
-- This migration adds subscription_module_items table and extends tenant_modules
-- ============================================================================

-- ============================================================================
-- 1. Create enum types if not exist
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE subscription_module_status_enum AS ENUM (
    'active', 'suspended', 'cancelled', 'upgraded', 'downgraded'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================================
-- 2. Create subscription_module_items table
-- ============================================================================

CREATE TABLE IF NOT EXISTS subscription_module_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "subscriptionId" UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  "moduleId" UUID NOT NULL,
  "moduleCode" VARCHAR(50) NOT NULL,
  "moduleName" VARCHAR(100) DEFAULT '',
  quantities JSONB DEFAULT '{}',
  "lineItems" JSONB DEFAULT '[]',
  subtotal DECIMAL(12, 2) DEFAULT 0,
  "discountAmount" DECIMAL(12, 2) DEFAULT 0,
  total DECIMAL(12, 2) DEFAULT 0,
  currency VARCHAR(3) DEFAULT 'USD',
  status subscription_module_status_enum DEFAULT 'active',
  "activatedAt" TIMESTAMPTZ DEFAULT NOW(),
  "cancelledAt" TIMESTAMPTZ,
  configuration JSONB,
  notes TEXT,
  "monthlyPrice" DECIMAL(12, 2) DEFAULT 0,
  "isActive" BOOLEAN DEFAULT true,
  "createdAt" TIMESTAMPTZ DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_subscription_module UNIQUE ("subscriptionId", "moduleId")
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_subscription_module_items_subscription
  ON subscription_module_items("subscriptionId");
CREATE INDEX IF NOT EXISTS idx_subscription_module_items_module
  ON subscription_module_items("moduleId");
CREATE INDEX IF NOT EXISTS idx_subscription_module_items_status
  ON subscription_module_items(status);

-- ============================================================================
-- 3. Add quantities and configuration columns to tenant_modules
-- ============================================================================

DO $$
BEGIN
  -- Add quantities column if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tenant_modules'
    AND column_name = 'quantities'
    AND table_schema = 'public'
  ) THEN
    ALTER TABLE public.tenant_modules ADD COLUMN quantities JSONB DEFAULT '{}';
  END IF;

  -- Add configuration column if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tenant_modules'
    AND column_name = 'configuration'
    AND table_schema = 'public'
  ) THEN
    ALTER TABLE public.tenant_modules ADD COLUMN configuration JSONB;
  END IF;
END $$;

-- ============================================================================
-- 4. Add missing columns to subscriptions table for admin-api compatibility
-- ============================================================================

DO $$
BEGIN
  -- Add createdBy column if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'subscriptions'
    AND column_name = 'createdBy'
    AND table_schema = 'public'
  ) THEN
    ALTER TABLE public.subscriptions ADD COLUMN "createdBy" VARCHAR(255);
  END IF;

  -- Add updatedBy column if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'subscriptions'
    AND column_name = 'updatedBy'
    AND table_schema = 'public'
  ) THEN
    ALTER TABLE public.subscriptions ADD COLUMN "updatedBy" VARCHAR(255);
  END IF;
END $$;

-- ============================================================================
-- 5. Create helper function to get subscription with modules
-- ============================================================================

CREATE OR REPLACE FUNCTION get_subscription_with_modules(p_tenant_id UUID)
RETURNS TABLE (
  subscription_id UUID,
  tenant_id TEXT,
  plan_tier TEXT,
  status TEXT,
  monthly_total DECIMAL,
  modules JSONB
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.id AS subscription_id,
    s."tenantId" AS tenant_id,
    s."planTier"::TEXT AS plan_tier,
    s.status::TEXT AS status,
    COALESCE(SUM(smi."monthlyPrice"), 0) AS monthly_total,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', smi.id,
          'moduleId', smi."moduleId",
          'moduleCode', smi."moduleCode",
          'moduleName', smi."moduleName",
          'quantities', smi.quantities,
          'monthlyPrice', smi."monthlyPrice",
          'isActive', smi."isActive"
        )
      ) FILTER (WHERE smi.id IS NOT NULL),
      '[]'::jsonb
    ) AS modules
  FROM subscriptions s
  LEFT JOIN subscription_module_items smi ON s.id = smi."subscriptionId"
  WHERE s."tenantId" = p_tenant_id::TEXT
  GROUP BY s.id, s."tenantId", s."planTier", s.status;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 6. Verification
-- ============================================================================

SELECT 'subscription_module_items' as table_name,
       (SELECT COUNT(*) FROM subscription_module_items) as record_count
UNION ALL
SELECT 'tenant_modules_with_quantities',
       (SELECT COUNT(*) FROM information_schema.columns
        WHERE table_name = 'tenant_modules' AND column_name = 'quantities');
