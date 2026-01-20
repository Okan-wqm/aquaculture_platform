-- ============================================================================
-- Security Tables Seed Data
-- ============================================================================

-- ============================================================================
-- Retention Policies (Essential for Compliance)
-- ============================================================================

INSERT INTO retention_policies (id, name, category, description, "retentionDays", "archiveAfterDays", "deleteAfterArchiveDays", "isGlobal", "specificTenants", "complianceFrameworks", "isActive", "createdBy", "createdAt", "updatedAt")
VALUES
  -- Activity Logs - 90 days retention, archive after 30 days
  (gen_random_uuid(), 'activity_logs_default', 'user_action', 'Default retention policy for user activity logs. Logs are archived after 30 days and retained for 90 days total.', 90, 30, 365, true, NULL, ARRAY['gdpr', 'ccpa'], true, 'SYSTEM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- Security Events - 365 days retention (1 year for incident investigation)
  (gen_random_uuid(), 'security_events_default', 'security_event', 'Retention policy for security events. Extended retention period for security investigation and compliance purposes.', 365, 90, 730, true, NULL, ARRAY['gdpr', 'iso27001', 'sox'], true, 'SYSTEM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- Login Attempts - 30 days retention (for brute force detection)
  (gen_random_uuid(), 'login_attempts_default', 'authentication', 'Retention policy for login attempt logs. Short retention for authentication auditing and brute force detection.', 30, NULL, NULL, true, NULL, ARRAY['gdpr', 'ccpa'], true, 'SYSTEM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- API Usage Logs - 60 days retention
  (gen_random_uuid(), 'api_usage_logs_default', 'api_call', 'Retention policy for API usage logs. Moderate retention for API monitoring and rate limit analysis.', 60, 30, 180, true, NULL, ARRAY['gdpr'], true, 'SYSTEM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- User Sessions - 7 days after expiration
  (gen_random_uuid(), 'user_sessions_default', 'authentication', 'Retention policy for user session data. Short retention for security monitoring.', 7, NULL, NULL, true, NULL, ARRAY['gdpr', 'ccpa'], true, 'SYSTEM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- Compliance Data - 7 years (2555 days) for SOX/GDPR
  (gen_random_uuid(), 'compliance_data_default', 'data_access', 'Long-term retention policy for compliance-related data. Required for regulatory audits and legal holds.', 2555, 365, 3650, true, NULL, ARRAY['gdpr', 'sox', 'hipaa', 'pci_dss'], true, 'SYSTEM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- System Events - 180 days retention
  (gen_random_uuid(), 'system_events_default', 'system_event', 'Retention policy for system events. Moderate retention for system health monitoring and debugging.', 180, 60, 365, true, NULL, ARRAY['iso27001'], true, 'SYSTEM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- Configuration Changes - 365 days (audit trail)
  (gen_random_uuid(), 'configuration_changes_default', 'configuration', 'Retention policy for configuration change logs. Extended retention for change management auditing.', 365, 90, 730, true, NULL, ARRAY['gdpr', 'iso27001', 'sox'], true, 'SYSTEM', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT (name) DO NOTHING;

-- ============================================================================
-- Threat Intelligence (Sample Entries)
-- ============================================================================

INSERT INTO threat_intelligence (id, "indicatorType", value, "threatLevel", source, description, "threatTypes", tags, confidence, "isActive", "validFrom", "validUntil", "hitCount", "createdAt", "updatedAt")
VALUES
  -- Known malicious IP ranges (example - Tor exit nodes pattern)
  (gen_random_uuid(), 'cidr', '0.0.0.0/8', 'low', 'internal', 'Reserved IP range - should never appear in legitimate traffic', ARRAY['reconnaissance', 'spoofing'], ARRAY['reserved', 'internal'], 0.95, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '1 year', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- Common attack user agents
  (gen_random_uuid(), 'user_agent', 'sqlmap', 'high', 'internal', 'SQL injection scanning tool user agent', ARRAY['sql_injection', 'scanning'], ARRAY['tool', 'scanner', 'attack'], 0.99, true, CURRENT_TIMESTAMP, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  (gen_random_uuid(), 'user_agent', 'nikto', 'high', 'internal', 'Nikto web vulnerability scanner user agent', ARRAY['vulnerability_scanning', 'reconnaissance'], ARRAY['tool', 'scanner', 'attack'], 0.99, true, CURRENT_TIMESTAMP, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  (gen_random_uuid(), 'user_agent', 'nmap', 'medium', 'internal', 'Nmap network scanner user agent', ARRAY['port_scanning', 'reconnaissance'], ARRAY['tool', 'scanner'], 0.90, true, CURRENT_TIMESTAMP, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  (gen_random_uuid(), 'user_agent', 'masscan', 'high', 'internal', 'Masscan port scanner user agent', ARRAY['port_scanning', 'reconnaissance'], ARRAY['tool', 'scanner', 'attack'], 0.95, true, CURRENT_TIMESTAMP, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  (gen_random_uuid(), 'user_agent', 'dirbuster', 'high', 'internal', 'DirBuster directory enumeration tool', ARRAY['directory_enumeration', 'reconnaissance'], ARRAY['tool', 'scanner', 'attack'], 0.95, true, CURRENT_TIMESTAMP, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  (gen_random_uuid(), 'user_agent', 'gobuster', 'high', 'internal', 'Gobuster directory/file brute-forcer', ARRAY['directory_enumeration', 'brute_force'], ARRAY['tool', 'scanner', 'attack'], 0.95, true, CURRENT_TIMESTAMP, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- Common bot patterns
  (gen_random_uuid(), 'user_agent', 'python-requests', 'low', 'internal', 'Python requests library - may be legitimate automation or scraping', ARRAY['scraping', 'automation'], ARRAY['bot', 'library'], 0.30, true, CURRENT_TIMESTAMP, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  (gen_random_uuid(), 'user_agent', 'curl', 'low', 'internal', 'cURL command line tool - may be legitimate automation', ARRAY['automation'], ARRAY['tool', 'cli'], 0.20, true, CURRENT_TIMESTAMP, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- Suspicious patterns
  (gen_random_uuid(), 'user_agent', '${jndi:', 'critical', 'internal', 'Log4j/Log4Shell exploitation attempt pattern', ARRAY['rce', 'log4j', 'exploitation'], ARRAY['exploit', 'cve', 'critical'], 1.0, true, CURRENT_TIMESTAMP, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  (gen_random_uuid(), 'user_agent', '<script', 'high', 'internal', 'XSS payload in user agent header', ARRAY['xss', 'injection'], ARRAY['attack', 'injection'], 0.99, true, CURRENT_TIMESTAMP, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- Example malicious domains (for demonstration - not real threats)
  (gen_random_uuid(), 'domain', 'malware-c2-example.com', 'critical', 'internal', 'Example malware C2 domain for testing threat intelligence', ARRAY['malware', 'c2'], ARRAY['example', 'test'], 0.50, false, CURRENT_TIMESTAMP, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  -- Common attack patterns in URLs
  (gen_random_uuid(), 'url', '/etc/passwd', 'high', 'internal', 'Path traversal attempt to read system files', ARRAY['path_traversal', 'lfi'], ARRAY['attack', 'linux'], 0.95, true, CURRENT_TIMESTAMP, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  (gen_random_uuid(), 'url', '/wp-admin', 'low', 'internal', 'WordPress admin access attempt - may indicate reconnaissance', ARRAY['reconnaissance', 'cms_detection'], ARRAY['wordpress', 'cms'], 0.40, true, CURRENT_TIMESTAMP, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  (gen_random_uuid(), 'url', '/.env', 'high', 'internal', 'Environment file access attempt - credential theft', ARRAY['credential_theft', 'reconnaissance'], ARRAY['sensitive_file', 'config'], 0.90, true, CURRENT_TIMESTAMP, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  (gen_random_uuid(), 'url', '/.git/config', 'high', 'internal', 'Git configuration exposure attempt', ARRAY['credential_theft', 'source_code_theft'], ARRAY['git', 'sensitive_file'], 0.90, true, CURRENT_TIMESTAMP, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),

  (gen_random_uuid(), 'url', '/phpmyadmin', 'medium', 'internal', 'phpMyAdmin access attempt - database administration panel', ARRAY['reconnaissance', 'database_access'], ARRAY['php', 'database', 'admin'], 0.60, true, CURRENT_TIMESTAMP, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- Sample Activity Log (System initialization)
-- ============================================================================

INSERT INTO activity_logs (id, "tenantId", "tenantName", "userId", "userName", "userEmail", category, severity, action, description, "entityType", "entityId", "ipAddress", "sessionId", success, "createdAt")
VALUES
  (gen_random_uuid(), NULL, NULL, 'SYSTEM', 'System', 'system@aquaculture-platform.local', 'system_event', 'info', 'SECURITY_TABLES_INITIALIZED', 'Security tables and seed data have been successfully initialized', 'system', 'security_module', '127.0.0.1', NULL, true, CURRENT_TIMESTAMP),

  (gen_random_uuid(), NULL, NULL, 'SYSTEM', 'System', 'system@aquaculture-platform.local', 'configuration', 'info', 'RETENTION_POLICIES_CREATED', 'Default data retention policies have been configured for compliance', 'retention_policy', 'default', '127.0.0.1', NULL, true, CURRENT_TIMESTAMP),

  (gen_random_uuid(), NULL, NULL, 'SYSTEM', 'System', 'system@aquaculture-platform.local', 'security_event', 'info', 'THREAT_INTELLIGENCE_LOADED', 'Initial threat intelligence indicators have been loaded into the system', 'threat_intelligence', 'initial_load', '127.0.0.1', NULL, true, CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- Initial Compliance Report (System Baseline)
-- ============================================================================

INSERT INTO compliance_reports (id, title, "complianceType", "reportPeriodStart", "reportPeriodEnd", "includedTenants", "includesAllTenants", "totalDataRequests", "completedDataRequests", "pendingDataRequests", "avgResponseTimeDays", "securityIncidents", "dataBreaches", "complianceScore", violations, recommendations, "executiveSummary", "generatedBy", "generatedByName", "isAutoGenerated", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(),
   'System Initialization Compliance Report',
   'gdpr',
   CURRENT_TIMESTAMP - INTERVAL '1 day',
   CURRENT_TIMESTAMP,
   NULL,
   true,
   0,
   0,
   0,
   NULL,
   0,
   0,
   100.0,
   '[]'::jsonb,
   '["Complete tenant onboarding with data processing agreements", "Configure tenant-specific retention policies", "Enable multi-factor authentication for all admin users", "Schedule regular security audits", "Implement automated compliance monitoring"]'::jsonb,
   'This is the initial compliance report generated during system setup. The security module has been initialized with default retention policies and threat intelligence. No data requests, security incidents, or compliance violations have been recorded as the system is newly deployed. Regular monitoring and reporting should be configured once tenants are onboarded.',
   'SYSTEM',
   'System',
   true,
   CURRENT_TIMESTAMP,
   CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- Verification Query
-- ============================================================================

-- Count records in each seeded table
SELECT 'retention_policies' as table_name, COUNT(*) as record_count FROM retention_policies
UNION ALL
SELECT 'threat_intelligence', COUNT(*) FROM threat_intelligence
UNION ALL
SELECT 'activity_logs', COUNT(*) FROM activity_logs
UNION ALL
SELECT 'compliance_reports', COUNT(*) FROM compliance_reports
ORDER BY table_name;
