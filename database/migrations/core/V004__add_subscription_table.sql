-- V004: Create subscriptions table
-- Source-of-truth for tenant billing subscriptions.
-- Entity: apps/billing-service/src/billing/entities/subscription.entity.ts

CREATE TABLE IF NOT EXISTS public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  plan_id UUID,
  plan_tier VARCHAR(20) NOT NULL,
  plan_name VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'trial',
  billing_cycle VARCHAR(20) NOT NULL,
  limits JSONB NOT NULL,
  pricing JSONB NOT NULL,
  start_date TIMESTAMPTZ NOT NULL,
  end_date TIMESTAMPTZ,
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end TIMESTAMPTZ NOT NULL,
  trial_end_date TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  auto_renew BOOLEAN NOT NULL DEFAULT true,
  stripe_subscription_id VARCHAR(255),
  stripe_customer_id VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by VARCHAR(255),
  updated_by VARCHAR(255),
  version INT NOT NULL DEFAULT 1,
  is_deleted BOOLEAN NOT NULL DEFAULT false,
  deleted_at TIMESTAMPTZ,
  deleted_by VARCHAR(255),

  CONSTRAINT "UQ_subscriptions_tenant" UNIQUE (tenant_id)
);

-- ── Indexes ──
CREATE INDEX IF NOT EXISTS "IDX_subscriptions_status" ON public.subscriptions (status);
CREATE INDEX IF NOT EXISTS "IDX_subscriptions_period_end" ON public.subscriptions (current_period_end);
CREATE INDEX IF NOT EXISTS "IDX_subscriptions_is_deleted" ON public.subscriptions (is_deleted);
