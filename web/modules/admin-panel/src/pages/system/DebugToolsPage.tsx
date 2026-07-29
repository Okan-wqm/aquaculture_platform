/**
 * Debug Tools — the Redis cache inspector.
 *
 * # What this page used to be
 *
 * Four tabs, three of which produced nothing:
 *
 *   - **Log Viewer** and **Config Viewer** were `// TODO: Implement …` bodies
 *     that set an empty array and an error string. They shipped as tabs an
 *     operator could click.
 *   - **Query Executor** rendered a SQL textarea, warned that the query would
 *     run against the production database, and then `throw new Error('Query
 *     execution API endpoint not yet implemented')` on submit — client-side,
 *     unconditionally.
 *   - **Active Connections** built its rows in the browser: `Array.from({length:
 *     stats.active})` with `database: 'aquaculture_prod'`, `user: 'app_user'`,
 *     `applicationName: 'service-N'`, `state: 'active'` — a table of invented
 *     values derived from one integer.
 *
 * The remaining tab, **Cache**, read a database table nothing wrote, and its
 * two invalidation controls carried `// Mock success for demo` catch blocks
 * that closed the confirmation dialog and removed the row from local state when
 * the request FAILED. A SUPER_ADMIN clearing cache during an incident was shown
 * success in every case: the backend was a logging stub when reachable, and the
 * frontend faked it when not.
 *
 * # What it is now
 *
 * One surface that talks to Redis. Keys are listed by SCAN with their real type,
 * TTL, memory footprint and idle time; the invalidation controls render the
 * count Redis actually removed, so a no-op regression is visible rather than
 * silent; and when Redis is unreachable the page says so instead of drawing
 * zeros.
 *
 * The namespace is stated on the page rather than implied. `RedisService`
 * prefixes admin-api's keys, so this inspects admin-api's cache — not every
 * service's — and instance-wide counters are labelled as instance-wide.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Input } from '@aquaculture/shared-ui';

import { debugApi } from '../../services/adminApi';
import type { CacheKeyEntry, CacheStats } from '../../services/adminApi';

// ============================================================================
// Formatting
// ============================================================================

function formatBytes(bytes: number | null): string {
  // Null means MEMORY USAGE could not answer for this key. A key of unknown
  // footprint is not a key of zero bytes.
  if (bytes === null) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, exponent)).toFixed(2)} ${units[exponent]}`;
}

function formatTtl(seconds: number): string {
  // Redis reserves two values: -1 is "no expiry set", -2 is "key is gone".
  if (seconds === -1) return 'no expiry';
  if (seconds === -2) return 'expired';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function formatIdle(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

// ============================================================================
// Page
// ============================================================================

export const DebugToolsPage: React.FC = () => {
  const [entries, setEntries] = useState<readonly CacheKeyEntry[]>([]);
  const [namespace, setNamespace] = useState<string>('');
  const [truncated, setTruncated] = useState(false);
  const [matchedCount, setMatchedCount] = useState(0);
  const [stats, setStats] = useState<CacheStats | null>(null);

  const [keyPattern, setKeyPattern] = useState('*');
  const [appliedPattern, setAppliedPattern] = useState('*');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      // Sequential, not Promise.allSettled: both calls fail for the same reason
      // (Redis unreachable), and the previous version's settled-pair handling
      // turned that one cause into two different half-rendered states.
      const listing = await debugApi.listCacheEntries({ keyPattern: appliedPattern, limit: 200 });
      const cacheStats = await debugApi.getCacheStats();

      setEntries(listing.entries);
      setNamespace(listing.namespace);
      setMatchedCount(listing.matchedCount);
      setTruncated(listing.truncated);
      setStats(cacheStats);
    } catch (err) {
      // No fallback rendering. The backend answers 503 when Redis is not
      // connected, and an empty key list drawn over that is indistinguishable
      // from a cache that is genuinely empty.
      setError(err instanceof Error ? err.message : 'Cache is unavailable');
      setEntries([]);
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, [appliedPattern]);

  useEffect(() => {
    void load();
  }, [load]);

  const invalidateKey = async (key: string): Promise<void> => {
    setBusyKey(key);
    setError(null);
    setNotice(null);
    try {
      const result = await debugApi.invalidateCacheEntry(key);
      // The count is read, not assumed. A backend that stopped deleting would
      // report 0 here and the operator would see it.
      setNotice(
        result.invalidated === 0
          ? `"${key}" was already gone — nothing removed.`
          : `Removed "${key}".`,
      );
      await load();
    } catch (err) {
      // The row stays. The version this replaced filtered it out of local state
      // inside the catch block, so a failed delete looked exactly like a
      // successful one until the next refresh.
      setError(err instanceof Error ? err.message : `Could not invalidate "${key}"`);
    } finally {
      setBusyKey(null);
    }
  };

  const clearMatching = async (): Promise<void> => {
    setClearing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await debugApi.invalidateCacheByPattern(appliedPattern);
      setConfirmClear(false);
      setNotice(
        `Removed ${result.invalidated} key${result.invalidated === 1 ? '' : 's'} matching "${appliedPattern}".`,
      );
      await load();
    } catch (err) {
      // The dialog stays open on failure. It used to close inside the catch.
      setError(err instanceof Error ? err.message : 'Could not clear the cache');
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Cache Inspector</h1>
          <p className="text-sm text-gray-500 mt-1">
            Redis keys in the{' '}
            <code className="font-mono text-gray-700">{namespace || 'admin'}</code> namespace.
            Other services keep their own.
          </p>
        </div>
        <Button variant="secondary" onClick={() => void load()} loading={loading}>
          Refresh
        </Button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3" role="alert">
          <span className="text-sm text-red-700">{error}</span>
        </div>
      )}
      {notice && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3" role="status">
          <span className="text-sm text-green-700">{notice}</span>
        </div>
      )}

      {/* Stats. The namespace figure and the instance figures are drawn apart
          because they measure different things — the version this replaced
          merged a hit count with a table row count into one "Hit Rate %". */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="p-6">
          <div className="text-sm font-medium text-gray-500 mb-2">Keys in namespace</div>
          <div className="text-3xl font-bold text-gray-900">
            {stats === null ? '—' : stats.keysInNamespace.toLocaleString()}
          </div>
          <div className="text-xs text-gray-500 mt-1">{namespace || 'admin:'}</div>
        </Card>
        <Card className="p-6">
          <div className="text-sm font-medium text-gray-500 mb-2">Hit rate</div>
          <div className="text-3xl font-bold text-gray-900">
            {stats === null || stats.instance.hitRatePercent === null
              ? '—'
              : `${stats.instance.hitRatePercent}%`}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            {stats === null || stats.instance.hitRatePercent === null
              ? 'no lookups served yet'
              : 'whole instance, all services'}
          </div>
        </Card>
        <Card className="p-6">
          <div className="text-sm font-medium text-gray-500 mb-2">Memory used</div>
          <div className="text-3xl font-bold text-gray-900">
            {stats === null ? '—' : formatBytes(stats.instance.usedMemoryBytes)}
          </div>
          <div className="text-xs text-gray-500 mt-1">whole instance</div>
        </Card>
        <Card className="p-6">
          <div className="text-sm font-medium text-gray-500 mb-2">Keys in instance</div>
          <div className="text-3xl font-bold text-gray-900">
            {stats === null ? '—' : stats.instance.totalKeys.toLocaleString()}
          </div>
          <div className="text-xs text-gray-500 mt-1">every namespace</div>
        </Card>
      </div>

      <Card title="Keys">
        <div className="flex items-end gap-2 mb-4">
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="key-pattern">
              Key pattern
            </label>
            <Input
              id="key-pattern"
              type="text"
              value={keyPattern}
              placeholder="report:*"
              onChange={(event) => setKeyPattern(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') setAppliedPattern(keyPattern || '*');
              }}
            />
          </div>
          <Button variant="secondary" onClick={() => setAppliedPattern(keyPattern || '*')}>
            Apply
          </Button>
          <Button
            variant="danger"
            onClick={() => setConfirmClear(true)}
            disabled={entries.length === 0}
          >
            Clear matching
          </Button>
        </div>

        {truncated && (
          <p className="text-xs text-amber-700 mb-3">
            Showing {entries.length} of {matchedCount.toLocaleString()} matching keys. Narrow the
            pattern to see the rest.
          </p>
        )}

        {loading ? (
          <p className="text-sm text-gray-500">Scanning…</p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-gray-400 italic">
            {error === null
              ? `No keys match "${appliedPattern}".`
              : 'The cache could not be read.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead>
                <tr className="text-left text-xs font-medium text-gray-500 uppercase">
                  <th className="px-3 py-2">Key</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">TTL</th>
                  <th className="px-3 py-2">Size</th>
                  <th className="px-3 py-2">Idle</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {entries.map((entry) => (
                  <tr key={entry.key}>
                    <td className="px-3 py-2 font-mono text-sm text-gray-800 break-all">
                      {entry.key}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant="default" size="sm">
                        {entry.type}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-sm text-gray-600">
                      {formatTtl(entry.ttlSeconds)}
                    </td>
                    <td className="px-3 py-2 text-sm text-gray-600">
                      {formatBytes(entry.sizeBytes)}
                    </td>
                    <td className="px-3 py-2 text-sm text-gray-600">
                      {formatIdle(entry.idleSeconds)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-600"
                        loading={busyKey === entry.key}
                        onClick={() => void invalidateKey(entry.key)}
                      >
                        Invalidate
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {confirmClear && (
        <Card title="Clear matching keys">
          <p className="text-sm text-gray-700">
            This removes every key matching{' '}
            <code className="font-mono">{appliedPattern}</code> from the{' '}
            <code className="font-mono">{namespace || 'admin:'}</code> namespace. Cached data will
            be recomputed on next read.
          </p>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="secondary" onClick={() => setConfirmClear(false)} disabled={clearing}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void clearMatching()} loading={clearing}>
              Clear
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
};

export default DebugToolsPage;
