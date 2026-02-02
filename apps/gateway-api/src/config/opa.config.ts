import { registerAs } from '@nestjs/config';

/**
 * Open Policy Agent (OPA) configuration
 * Used for fine-grained authorization decisions
 */
export const opaConfig = registerAs('opa', () => ({
  // OPA server settings
  enabled: process.env['OPA_ENABLED'] === 'true',
  url: process.env['OPA_URL'] || 'http://localhost:8181',
  policyPath: process.env['OPA_POLICY_PATH'] || '/v1/data/aquaculture/authz',

  // Request settings
  timeout: parseInt(process.env['OPA_TIMEOUT'] || '5000', 10),
  retries: parseInt(process.env['OPA_RETRIES'] || '3', 10),
  retryDelay: parseInt(process.env['OPA_RETRY_DELAY'] || '100', 10),

  // Caching
  cache: {
    enabled: process.env['OPA_CACHE_ENABLED'] !== 'false',
    ttl: parseInt(process.env['OPA_CACHE_TTL'] || '60', 10), // seconds
    maxSize: parseInt(process.env['OPA_CACHE_MAX_SIZE'] || '1000', 10),
  },

  // Fallback behavior when OPA is unavailable
  fallback: {
    // 'deny' = deny all when OPA unavailable (secure default)
    // 'allow' = allow all when OPA unavailable (not recommended)
    // 'role-based' = fall back to simple role-based checks
    mode: (process.env['OPA_FALLBACK_MODE'] || 'deny') as 'deny' | 'allow' | 'role-based',
  },

  // Audit logging
  audit: {
    enabled: process.env['OPA_AUDIT_ENABLED'] === 'true',
    logDenials: process.env['OPA_LOG_DENIALS'] !== 'false',
    logAllowances: process.env['OPA_LOG_ALLOWANCES'] === 'true',
  },
}));

export type OpaConfig = ReturnType<typeof opaConfig>;
