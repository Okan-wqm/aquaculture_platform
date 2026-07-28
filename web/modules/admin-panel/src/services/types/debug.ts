/**
 * Debug tools domain types
 */

// GENERATED backend contracts — tools/codegen/admin-contracts/manifest.ts.
// Imported so shapes below can reference them; re-exported so import sites
// are unchanged.
import type {
  DebugSessionType,
  DebugSession,
  CapturedQuery,
  CapturedApiCall,
  FeatureFlagOverride,
} from './generated/admin-contracts';

export type {
  DebugSessionType,
  DebugSession,
  CapturedQuery,
  CapturedApiCall,
  FeatureFlagOverride,
};

export interface CacheEntry {
  id: string;
  tenantId?: string;
  key: string;
  value?: unknown;
  sizeBytes?: number;
  ttlSeconds?: number;
  expiresAt?: string;
  hitCount: number;
  lastAccessedAt?: string;
  cacheStore?: string;
  tags?: string[];
}
