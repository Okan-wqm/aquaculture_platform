-- ============================================================================
-- Billing & Analytics Tables
--
-- Creates tables for billing system entities that have synchronize: false.
-- These tables are NOT auto-created by TypeORM and must exist before services start.
-- ============================================================================

-- ============================================================================
-- Subscription Status & Billing Cycle Enums
-- ============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subscription_status') THEN
        CREATE TYPE subscription_status AS ENUM (
            'trial', 'active', 'past_due', 'cancelled', 'suspended', 'expired'
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'billing_cycle') THEN
        CREATE TYPE billing_cycle AS ENUM (
            'monthly', 'quarterly', 'semi_annual', 'annual'
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'plan_tier') THEN
        CREATE TYPE plan_tier AS ENUM (
            'free', 'starter', 'professional', 'enterprise', 'custom'
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'invoice_status') THEN
        CREATE TYPE invoice_status AS ENUM (
            'draft', 'pending', 'sent', 'paid', 'partially_paid', 'overdue', 'void', 'refunded'
        );
    END IF;
END
$$;

-- ============================================================================
-- billing.subscriptions
-- ============================================================================

CREATE TABLE IF NOT EXISTS billing.subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenantId" TEXT NOT NULL,
    "planTier" VARCHAR(50) NOT NULL DEFAULT 'starter',
    "planName" VARCHAR(200) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'trial',
    "billingCycle" VARCHAR(50) NOT NULL DEFAULT 'monthly',
    pricing JSONB NOT NULL DEFAULT '{}',
    limits JSONB DEFAULT '{}',
    "startDate" TIMESTAMPTZ,
    "endDate" TIMESTAMPTZ,
    "currentPeriodStart" TIMESTAMPTZ NOT NULL,
    "currentPeriodEnd" TIMESTAMPTZ NOT NULL,
    "trialEndDate" TIMESTAMPTZ,
    "cancelledAt" TIMESTAMPTZ,
    "cancellationReason" TEXT,
    "autoRenew" BOOLEAN NOT NULL DEFAULT true,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    "stripeSubscriptionId" VARCHAR(255),
    "stripeCustomerId" VARCHAR(255),
    "createdBy" TEXT,
    "updatedBy" TEXT,
    version INT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant_id ON billing.subscriptions ("tenantId");
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON billing.subscriptions (status);

-- ============================================================================
-- billing.subscription_module_items
-- ============================================================================

CREATE TABLE IF NOT EXISTS billing.subscription_module_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "subscriptionId" UUID NOT NULL REFERENCES billing.subscriptions(id) ON DELETE CASCADE,
    "moduleId" UUID NOT NULL,
    "moduleCode" VARCHAR(50) NOT NULL,
    quantities JSONB DEFAULT '{}',
    "monthlyPrice" DECIMAL(12, 2) NOT NULL DEFAULT 0,
    "lineItems" JSONB DEFAULT '[]',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscription_module_items_sub_id ON billing.subscription_module_items ("subscriptionId");

-- ============================================================================
-- billing.invoices
-- ============================================================================

CREATE TABLE IF NOT EXISTS billing.invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenantId" TEXT NOT NULL,
    "subscriptionId" UUID,
    "invoiceNumber" VARCHAR(100) UNIQUE NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'draft',
    "billingAddress" JSONB,
    "lineItems" JSONB DEFAULT '[]',
    subtotal DECIMAL(12, 2) NOT NULL DEFAULT 0,
    tax JSONB,
    discount DECIMAL(12, 2) DEFAULT 0,
    "discountCode" VARCHAR(100),
    total DECIMAL(12, 2) NOT NULL DEFAULT 0,
    "amountPaid" DECIMAL(12, 2) NOT NULL DEFAULT 0,
    "amountDue" DECIMAL(12, 2) NOT NULL DEFAULT 0,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    "issueDate" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "dueDate" TIMESTAMPTZ NOT NULL,
    "paidAt" TIMESTAMPTZ,
    "periodStart" DATE,
    "periodEnd" DATE,
    notes TEXT,
    "stripeInvoiceId" VARCHAR(255),
    "pdfUrl" TEXT,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    version INT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoices_tenant_id ON billing.invoices ("tenantId");
CREATE INDEX IF NOT EXISTS idx_invoices_subscription_id ON billing.invoices ("subscriptionId");
CREATE INDEX IF NOT EXISTS idx_invoices_status ON billing.invoices (status);

-- ============================================================================
-- public.audit_logs (used by billing for subscription audit trail)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action VARCHAR(100) NOT NULL,
    "entityType" VARCHAR(100),
    "entityId" TEXT,
    "tenantId" TEXT,
    "userId" TEXT,
    details JSONB DEFAULT '{}',
    "ipAddress" VARCHAR(45),
    "userAgent" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_id ON public.audit_logs ("tenantId");
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON public.audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.audit_logs ("createdAt");

-- ============================================================================
-- admin.module_pricing
-- ============================================================================

CREATE TABLE IF NOT EXISTS admin.module_pricing (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "moduleId" UUID NOT NULL,
    "moduleCode" VARCHAR(50) NOT NULL,
    "pricingMetrics" JSONB NOT NULL DEFAULT '[]',
    "tierMultipliers" JSONB NOT NULL DEFAULT '{}',
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    "effectiveFrom" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "effectiveTo" TIMESTAMPTZ,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    notes TEXT,
    version INT NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "createdBy" UUID,
    "updatedBy" UUID,
    UNIQUE ("moduleId", "effectiveFrom")
);

CREATE INDEX IF NOT EXISTS idx_module_pricing_module_id ON admin.module_pricing ("moduleId");
CREATE INDEX IF NOT EXISTS idx_module_pricing_is_active ON admin.module_pricing ("isActive");
CREATE INDEX IF NOT EXISTS idx_module_pricing_effective_from ON admin.module_pricing ("effectiveFrom");

-- ============================================================================
-- admin.analytics_snapshots
-- ============================================================================

CREATE TABLE IF NOT EXISTS admin.analytics_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "snapshotType" VARCHAR(20) NOT NULL,
    category VARCHAR(20) NOT NULL,
    "snapshotDate" DATE NOT NULL,
    metrics JSONB NOT NULL,
    metadata JSONB,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_snapshots_type_date ON admin.analytics_snapshots ("snapshotType", "snapshotDate");
CREATE INDEX IF NOT EXISTS idx_analytics_snapshots_category_date ON admin.analytics_snapshots (category, "snapshotDate");

-- ============================================================================
-- admin.report_definitions
-- ============================================================================

CREATE TABLE IF NOT EXISTS admin.report_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200) NOT NULL,
    description TEXT,
    type VARCHAR(50) NOT NULL,
    "defaultFormat" VARCHAR(20) NOT NULL DEFAULT 'json',
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    schedule VARCHAR(20) NOT NULL DEFAULT 'manual',
    "defaultFilters" JSONB,
    recipients JSONB,
    "includeCharts" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" UUID,
    "createdByEmail" VARCHAR(255),
    "lastRunAt" TIMESTAMP,
    "runCount" INT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_report_definitions_created_by ON admin.report_definitions ("createdBy");
CREATE INDEX IF NOT EXISTS idx_report_definitions_status ON admin.report_definitions (status);

-- ============================================================================
-- admin.report_executions
-- ============================================================================

CREATE TABLE IF NOT EXISTS admin.report_executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "definitionId" UUID,
    "reportName" VARCHAR(200) NOT NULL,
    "reportType" VARCHAR(50) NOT NULL,
    format VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    "startDate" TIMESTAMP,
    "endDate" TIMESTAMP,
    filters JSONB,
    summary JSONB,
    "rowCount" INT,
    "fileSizeBytes" INT,
    "downloadUrl" VARCHAR(500),
    "downloadExpiresAt" TIMESTAMP,
    "errorMessage" TEXT,
    "durationMs" INT,
    "executedBy" UUID,
    "executedByEmail" VARCHAR(255),
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "completedAt" TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_report_executions_definition_id ON admin.report_executions ("definitionId");
CREATE INDEX IF NOT EXISTS idx_report_executions_status ON admin.report_executions (status);
CREATE INDEX IF NOT EXISTS idx_report_executions_created_at ON admin.report_executions ("createdAt");

-- ============================================================================
-- Grant permissions on newly created tables
-- ============================================================================

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO aquaculture;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA admin TO aquaculture;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA billing TO aquaculture;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO aquaculture;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA admin TO aquaculture;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA billing TO aquaculture;
