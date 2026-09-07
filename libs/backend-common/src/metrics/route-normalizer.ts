/**
 * Route Normalizer
 *
 * Normalizes HTTP route paths to prevent Prometheus label cardinality explosion.
 * Replaces dynamic path segments (UUIDs, numeric IDs, slugs) with parameter placeholders.
 *
 * Examples:
 *   /api/sensors/abc-123         -> /api/sensors/:id
 *   /api/tenants/550e8400-.../farms/42  -> /api/tenants/:id/farms/:id
 *   /health/live                 -> /health/live (unchanged)
 */

// UUID pattern: 8-4-4-4-12 hex chars
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// Pure numeric IDs
const NUMERIC_ID_PATTERN = /^\d+$/;

// Mongo-style ObjectId (24 hex chars)
const OBJECTID_PATTERN = /^[0-9a-f]{24}$/i;

// Generic slug-like IDs (contains digits and dashes, at least one digit)
const SLUG_ID_PATTERN = /^[a-z0-9]+-[a-z0-9-]+$/i;

/**
 * Known static path segments that should never be normalized.
 * This prevents false positives on segments like "health", "live", "ready", etc.
 */
const STATIC_SEGMENTS = new Set([
  'health',
  'live',
  'ready',
  'ping',
  'metrics',
  'graphql',
  'api',
  'v1',
  'v2',
  'v3',
  'auth',
  'login',
  'logout',
  'register',
  'refresh',
  'verify',
  'reset',
  'forgot',
  'tenants',
  'users',
  'sensors',
  'farms',
  'alerts',
  'devices',
  'readings',
  'billing',
  'plans',
  'invoices',
  'subscriptions',
  'notifications',
  'settings',
  'admin',
  'upload',
  'download',
  'export',
  'import',
  'search',
  'dashboard',
  'reports',
  'analytics',
  'webhooks',
  'events',
  'jobs',
  'queue',
  'ws',
  'socket',
  'mqtt',
  'edge-devices',
  'automation',
  'processes',
  'vfd',
  'plc',
  'scada',
  'templates',
  'types',
  'channels',
  'protocols',
  'config',
  'system',
  'roles',
  'permissions',
  'audit',
  'compliance',
  'hr',
  'hydroponics',
  'announcements',
  'messaging',
  'support',
  'tickets',
  'onboarding',
]);

/**
 * Check if a path segment looks like a dynamic ID
 */
function isDynamicSegment(segment: string): boolean {
  if (!segment || STATIC_SEGMENTS.has(segment.toLowerCase())) {
    return false;
  }

  // UUID
  if (UUID_PATTERN.test(segment)) {
    // Reset lastIndex since we use the global flag
    UUID_PATTERN.lastIndex = 0;
    return true;
  }

  // Numeric ID
  if (NUMERIC_ID_PATTERN.test(segment)) {
    return true;
  }

  // MongoDB ObjectId
  if (OBJECTID_PATTERN.test(segment)) {
    return true;
  }

  // Slug-like ID with digits (e.g., "sensor-abc-123")
  if (SLUG_ID_PATTERN.test(segment) && /\d/.test(segment)) {
    return true;
  }

  return false;
}

/**
 * Normalize a route path by replacing dynamic segments with :id placeholder.
 *
 * If an Express route pattern is available (e.g., from req.route.path),
 * prefer that over this heuristic normalization.
 */
export function normalizeRoute(path: string): string {
  if (!path) {
    return '/';
  }

  const segments = path.split('/');
  const normalized = segments.map((segment) =>
    isDynamicSegment(segment) ? ':id' : segment,
  );

  return normalized.join('/') || '/';
}
