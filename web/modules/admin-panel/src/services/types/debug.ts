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
  CacheInvalidationResult,
  CacheKeyEntry,
  CacheKeyValue,
  CacheNamespaceListing,
  CacheStats,
} from './generated/admin-contracts';

export type {
  DebugSessionType,
  DebugSession,
  CapturedQuery,
  CapturedApiCall,
  FeatureFlagOverride,
  CacheInvalidationResult,
  CacheKeyEntry,
  CacheKeyValue,
  CacheNamespaceListing,
  CacheStats,
};

// `CacheEntry` is deliberately absent.
//
// It described the shape of `admin.cache_entries_snapshot` — id, tenantId,
// hitCount, tags, a jsonb value — a table whose only writer was an endpoint
// nothing ever called, and which is now dropped. Redis reports none of those
// fields; it reports a key's type, TTL, memory footprint and idle time, which
// is what `CacheKeyEntry` above carries, generated from the service that reads
// them.
