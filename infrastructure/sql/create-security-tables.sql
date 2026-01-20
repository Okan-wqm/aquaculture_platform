-- ============================================================================
-- Security & Audit Tables
-- ============================================================================

-- Activity Logs Table
CREATE TABLE IF NOT EXISTS activity_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenantId" VARCHAR(100),
    "tenantName" VARCHAR(100),
    "userId" VARCHAR(100),
    "userName" VARCHAR(255),
    "userEmail" VARCHAR(100),
    category VARCHAR(50) NOT NULL,
    severity VARCHAR(20) DEFAULT 'info',
    action VARCHAR(100) NOT NULL,
    description TEXT NOT NULL,
    "entityType" VARCHAR(100),
    "entityId" VARCHAR(100),
    "entityName" VARCHAR(255),
    "ipAddress" VARCHAR(45) NOT NULL,
    "geoLocation" JSONB,
    "deviceInfo" JSONB,
    "requestInfo" JSONB,
    "sessionId" VARCHAR(255),
    "correlationId" VARCHAR(255),
    "previousValue" JSONB,
    "newValue" JSONB,
    "changedFields" JSONB,
    metadata JSONB,
    tags TEXT[],
    success BOOLEAN DEFAULT true,
    "errorMessage" TEXT,
    "errorCode" VARCHAR(100),
    duration INTEGER,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "isArchived" BOOLEAN DEFAULT false,
    "archivedAt" TIMESTAMP
);

-- Indexes for activity_logs
CREATE INDEX IF NOT EXISTS idx_activity_logs_tenant_created ON activity_logs("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS idx_activity_logs_user_created ON activity_logs("userId", "createdAt");
CREATE INDEX IF NOT EXISTS idx_activity_logs_category_created ON activity_logs(category, "createdAt");
CREATE INDEX IF NOT EXISTS idx_activity_logs_severity_created ON activity_logs(severity, "createdAt");
CREATE INDEX IF NOT EXISTS idx_activity_logs_ip_created ON activity_logs("ipAddress", "createdAt");
CREATE INDEX IF NOT EXISTS idx_activity_logs_action_created ON activity_logs(action, "createdAt");
CREATE INDEX IF NOT EXISTS idx_activity_logs_entity_type ON activity_logs("entityType");
CREATE INDEX IF NOT EXISTS idx_activity_logs_entity_id ON activity_logs("entityId");

-- Security Events Table
CREATE TABLE IF NOT EXISTS security_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "eventType" VARCHAR(50) NOT NULL,
    "threatLevel" VARCHAR(20) NOT NULL,
    status VARCHAR(20) DEFAULT 'detected',
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    "ipAddress" VARCHAR(45) NOT NULL,
    "geoLocation" JSONB,
    "deviceInfo" JSONB,
    "tenantId" VARCHAR(100),
    "userId" VARCHAR(100),
    "userName" VARCHAR(255),
    "targetResource" VARCHAR(100),
    "targetEndpoint" VARCHAR(255),
    "detectionSource" VARCHAR(100) NOT NULL,
    "confidenceScore" FLOAT,
    "anomalyDetails" JSONB,
    indicators JSONB,
    "rawData" JSONB,
    "relatedActivityIds" TEXT[],
    "autoMitigated" BOOLEAN DEFAULT false,
    "mitigationActions" TEXT[],
    "investigationNotes" TEXT,
    "assignedTo" VARCHAR(100),
    "assignedToName" VARCHAR(255),
    "assignedAt" TIMESTAMP,
    resolution TEXT,
    "resolvedAt" TIMESTAMP,
    "resolvedBy" VARCHAR(100),
    tags TEXT[],
    metadata JSONB,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for security_events
CREATE INDEX IF NOT EXISTS idx_security_events_tenant_created ON security_events("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS idx_security_events_type_created ON security_events("eventType", "createdAt");
CREATE INDEX IF NOT EXISTS idx_security_events_status_created ON security_events(status, "createdAt");
CREATE INDEX IF NOT EXISTS idx_security_events_threat_created ON security_events("threatLevel", "createdAt");
CREATE INDEX IF NOT EXISTS idx_security_events_ip_created ON security_events("ipAddress", "createdAt");
CREATE INDEX IF NOT EXISTS idx_security_events_user ON security_events("userId");

-- Security Incidents Table
CREATE TABLE IF NOT EXISTS security_incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "incidentNumber" VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    severity VARCHAR(20) NOT NULL,
    status VARCHAR(20) DEFAULT 'open',
    category VARCHAR(100) NOT NULL,
    "attackVector" VARCHAR(100),
    "affectedSystems" TEXT[],
    "affectedTenants" TEXT[],
    "dataBreached" BOOLEAN DEFAULT false,
    "affectedUsersCount" INTEGER DEFAULT 0,
    "impactDescription" TEXT,
    "businessImpact" TEXT,
    "detectedAt" TIMESTAMP,
    "containedAt" TIMESTAMP,
    "eradicatedAt" TIMESTAMP,
    "recoveredAt" TIMESTAMP,
    "closedAt" TIMESTAMP,
    "leadInvestigator" VARCHAR(100),
    "leadInvestigatorName" VARCHAR(255),
    "teamMembers" TEXT[],
    "relatedSecurityEvents" TEXT[],
    "rootCauseAnalysis" TEXT,
    "lessonsLearned" TEXT,
    "remediationSteps" JSONB,
    "reportedToAuthorities" BOOLEAN DEFAULT false,
    "reportedAt" TIMESTAMP,
    "reportReference" VARCHAR(255),
    timeline JSONB,
    metadata JSONB,
    "createdBy" VARCHAR(100) NOT NULL,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for security_incidents
CREATE INDEX IF NOT EXISTS idx_security_incidents_status_created ON security_incidents(status, "createdAt");
CREATE INDEX IF NOT EXISTS idx_security_incidents_severity_created ON security_incidents(severity, "createdAt");

-- Threat Intelligence Table
CREATE TABLE IF NOT EXISTS threat_intelligence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "indicatorType" VARCHAR(50) NOT NULL,
    value VARCHAR(500) NOT NULL,
    "threatLevel" VARCHAR(20) NOT NULL,
    source VARCHAR(100) NOT NULL,
    description VARCHAR(255),
    "threatTypes" TEXT[],
    tags TEXT[],
    confidence FLOAT DEFAULT 0.5,
    "isActive" BOOLEAN DEFAULT true,
    "validFrom" TIMESTAMP,
    "validUntil" TIMESTAMP,
    "hitCount" INTEGER DEFAULT 0,
    "lastSeenAt" TIMESTAMP,
    "firstSeenAt" TIMESTAMP,
    "relatedIndicators" TEXT[],
    "geoData" JSONB,
    metadata JSONB,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for threat_intelligence
CREATE INDEX IF NOT EXISTS idx_threat_intel_type ON threat_intelligence("indicatorType");
CREATE INDEX IF NOT EXISTS idx_threat_intel_value ON threat_intelligence(value);
CREATE INDEX IF NOT EXISTS idx_threat_intel_level ON threat_intelligence("threatLevel");
CREATE INDEX IF NOT EXISTS idx_threat_intel_active ON threat_intelligence("isActive");

-- Data Requests Table (GDPR/CCPA)
CREATE TABLE IF NOT EXISTS data_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "requestNumber" VARCHAR(50) NOT NULL,
    "requestType" VARCHAR(50) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    "complianceFramework" VARCHAR(20) NOT NULL,
    "tenantId" VARCHAR(100) NOT NULL,
    "tenantName" VARCHAR(255) NOT NULL,
    "requesterId" VARCHAR(100),
    "requesterName" VARCHAR(255) NOT NULL,
    "requesterEmail" VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    "dataCategories" TEXT[],
    "specificData" TEXT,
    "identityVerified" BOOLEAN DEFAULT false,
    "verifiedAt" TIMESTAMP,
    "verifiedBy" VARCHAR(100),
    "verificationMethod" VARCHAR(100),
    "dueDate" TIMESTAMP NOT NULL,
    "assignedTo" VARCHAR(100),
    "assignedToName" VARCHAR(255),
    "processingStartedAt" TIMESTAMP,
    "completedAt" TIMESTAMP,
    "completedBy" VARCHAR(100),
    "completionNotes" TEXT,
    "deliveryFormat" VARCHAR(20),
    "downloadUrl" VARCHAR(500),
    "downloadExpiresAt" TIMESTAMP,
    "downloadCount" INTEGER DEFAULT 0,
    "rejectionReason" TEXT,
    "auditTrail" JSONB,
    metadata JSONB,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for data_requests
CREATE INDEX IF NOT EXISTS idx_data_requests_tenant_created ON data_requests("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS idx_data_requests_type_status ON data_requests("requestType", status);
CREATE INDEX IF NOT EXISTS idx_data_requests_due ON data_requests("dueDate");

-- Compliance Reports Table
CREATE TABLE IF NOT EXISTS compliance_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    "complianceType" VARCHAR(20) NOT NULL,
    "reportPeriodStart" TIMESTAMP NOT NULL,
    "reportPeriodEnd" TIMESTAMP NOT NULL,
    "includedTenants" TEXT[],
    "includesAllTenants" BOOLEAN DEFAULT true,
    "totalDataRequests" INTEGER DEFAULT 0,
    "completedDataRequests" INTEGER DEFAULT 0,
    "pendingDataRequests" INTEGER DEFAULT 0,
    "avgResponseTimeDays" FLOAT,
    "securityIncidents" INTEGER DEFAULT 0,
    "dataBreaches" INTEGER DEFAULT 0,
    "complianceScore" FLOAT DEFAULT 100,
    violations JSONB,
    recommendations JSONB,
    "executiveSummary" TEXT,
    "detailedFindings" JSONB,
    "pdfUrl" VARCHAR(500),
    "csvUrl" VARCHAR(500),
    "generatedBy" VARCHAR(100) NOT NULL,
    "generatedByName" VARCHAR(255) NOT NULL,
    "isAutoGenerated" BOOLEAN DEFAULT false,
    metadata JSONB,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for compliance_reports
CREATE INDEX IF NOT EXISTS idx_compliance_reports_type_created ON compliance_reports("complianceType", "createdAt");
CREATE INDEX IF NOT EXISTS idx_compliance_reports_period ON compliance_reports("reportPeriodStart", "reportPeriodEnd");

-- Retention Policies Table
CREATE TABLE IF NOT EXISTS retention_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) UNIQUE NOT NULL,
    category VARCHAR(50) NOT NULL,
    description TEXT,
    "retentionDays" INTEGER NOT NULL,
    "archiveAfterDays" INTEGER,
    "deleteAfterArchiveDays" INTEGER,
    "isGlobal" BOOLEAN DEFAULT true,
    "specificTenants" TEXT[],
    "complianceFrameworks" TEXT[],
    "isActive" BOOLEAN DEFAULT true,
    "createdBy" VARCHAR(100) NOT NULL,
    "updatedBy" VARCHAR(100),
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Login Attempts Table
CREATE TABLE IF NOT EXISTS login_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL,
    "ipAddress" VARCHAR(45) NOT NULL,
    success BOOLEAN NOT NULL,
    "failureReason" VARCHAR(100),
    "geoLocation" JSONB,
    "deviceInfo" JSONB,
    "tenantId" VARCHAR(100),
    "userId" VARCHAR(100),
    "sessionId" VARCHAR(255),
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for login_attempts
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_created ON login_attempts("ipAddress", "createdAt");
CREATE INDEX IF NOT EXISTS idx_login_attempts_email_created ON login_attempts(email, "createdAt");
CREATE INDEX IF NOT EXISTS idx_login_attempts_success_created ON login_attempts(success, "createdAt");

-- API Usage Logs Table
CREATE TABLE IF NOT EXISTS api_usage_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "tenantId" VARCHAR(100),
    "userId" VARCHAR(100),
    "apiKeyId" VARCHAR(255),
    method VARCHAR(10) NOT NULL,
    endpoint VARCHAR(500) NOT NULL,
    path VARCHAR(500) NOT NULL,
    "queryParams" JSONB,
    "requestSize" INTEGER,
    "statusCode" INTEGER NOT NULL,
    "responseSize" INTEGER,
    "responseTimeMs" INTEGER NOT NULL,
    "ipAddress" VARCHAR(45) NOT NULL,
    "userAgent" VARCHAR(500),
    "geoLocation" JSONB,
    "rateLimitRemaining" INTEGER,
    "rateLimitExceeded" BOOLEAN DEFAULT false,
    "isError" BOOLEAN DEFAULT false,
    "errorCode" VARCHAR(100),
    "errorMessage" TEXT,
    "correlationId" VARCHAR(255),
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for api_usage_logs
CREATE INDEX IF NOT EXISTS idx_api_usage_tenant_created ON api_usage_logs("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS idx_api_usage_endpoint_created ON api_usage_logs(endpoint, "createdAt");
CREATE INDEX IF NOT EXISTS idx_api_usage_status_created ON api_usage_logs("statusCode", "createdAt");
CREATE INDEX IF NOT EXISTS idx_api_usage_user ON api_usage_logs("userId");
CREATE INDEX IF NOT EXISTS idx_api_usage_ip ON api_usage_logs("ipAddress");

-- User Sessions Table
CREATE TABLE IF NOT EXISTS user_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "sessionToken" VARCHAR(255) UNIQUE NOT NULL,
    "userId" VARCHAR(100) NOT NULL,
    "userName" VARCHAR(255) NOT NULL,
    "tenantId" VARCHAR(100),
    "tenantName" VARCHAR(255),
    "isActive" BOOLEAN DEFAULT true,
    "expiresAt" TIMESTAMP NOT NULL,
    "ipAddress" VARCHAR(45) NOT NULL,
    "geoLocation" JSONB,
    "deviceInfo" JSONB,
    "requestCount" INTEGER DEFAULT 0,
    "lastActivityAt" TIMESTAMP NOT NULL,
    "lastActivityPath" VARCHAR(500),
    "terminatedAt" TIMESTAMP,
    "terminationReason" VARCHAR(50),
    "terminatedBy" VARCHAR(100),
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for user_sessions
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_active ON user_sessions("userId", "isActive");
CREATE INDEX IF NOT EXISTS idx_user_sessions_tenant_active ON user_sessions("tenantId", "isActive");
CREATE INDEX IF NOT EXISTS idx_user_sessions_activity ON user_sessions("lastActivityAt");
