/**
 * Debug Tools Page
 *
 * Enterprise-grade debugging interface with real API integration.
 * Provides cache management and database diagnostics backed by governed routes.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Card, Button, Badge, Input } from '@aquaculture/shared-ui';
import { adminCacheInvalidationReceiptHasValidIdentity } from '@aquaculture/shared-contracts';
import { debugApi, databaseApi } from '../../services/adminApi';
import type { CacheEntry } from '../../services/adminApi';
import type { AdminApiRouteResponse } from '../../services/types/generated/admin-route-contracts';

// ============================================================================
// Types
// ============================================================================

type CacheStats = AdminApiRouteResponse<'GET /debug/cache/stats'>;
type CacheInvalidationReceipt = AdminApiRouteResponse<'DELETE /debug/cache/:key'>;
type ConnectionStats = AdminApiRouteResponse<'GET /database/monitoring/connections'>;
type QueryResult = AdminApiRouteResponse<'POST /database/explorer/query'>;

type TabType = 'cache' | 'database';

// ============================================================================
// Component
// ============================================================================

export const DebugToolsPage: React.FC = () => {
  // State
  const [activeTab, setActiveTab] = useState<TabType>('cache');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Cache state
  const [cacheEntries, setCacheEntries] = useState<readonly CacheEntry[]>([]);
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [cacheNamespace, setCacheNamespace] = useState('');
  const [cacheMatchedCount, setCacheMatchedCount] = useState(0);
  const [cacheListingTruncated, setCacheListingTruncated] = useState(false);
  const [keyPattern, setKeyPattern] = useState('*');
  const [appliedKeyPattern, setAppliedKeyPattern] = useState('*');
  const [lastInvalidationReceipt, setLastInvalidationReceipt] =
    useState<CacheInvalidationReceipt | null>(null);
  const [busyCacheKey, setBusyCacheKey] = useState<string | null>(null);
  const [clearingCache, setClearingCache] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  // Database state
  const [connectionStats, setConnectionStats] = useState<ConnectionStats | null>(null);
  const [queryInput, setQueryInput] = useState('SELECT * FROM farms LIMIT 10;');
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [queryExecuting, setQueryExecuting] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);

  // ============================================================================
  // Data Loading
  // ============================================================================

  const loadCacheData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const listing = await debugApi.listCacheEntries({
        keyPattern: appliedKeyPattern,
        limit: 200,
      });
      const stats = await debugApi.getCacheStats();
      setCacheEntries(listing.entries);
      setCacheNamespace(listing.namespace);
      setCacheMatchedCount(listing.matchedCount);
      setCacheListingTruncated(listing.truncated);
      setCacheStats(stats);
    } catch (err) {
      console.error('Failed to load cache data:', err);
      setError('Cache service unavailable');
      setCacheEntries([]);
      setCacheStats(null);
    } finally {
      setLoading(false);
    }
  }, [appliedKeyPattern]);

  const loadDatabaseData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setConnectionStats(await databaseApi.getConnectionStats());
    } catch (err) {
      console.error('Failed to load database data:', err);
      setError('Failed to load database connections');
      setConnectionStats(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Split per-tab effects so unrelated state changes don't re-trigger other capabilities.
  useEffect(() => {
    if (activeTab === 'cache') loadCacheData();
  }, [activeTab, loadCacheData]);

  useEffect(() => {
    if (activeTab === 'database') loadDatabaseData();
  }, [activeTab, loadDatabaseData]);

  // ============================================================================
  // Handlers
  // ============================================================================

  const handleClearCache = async () => {
    setClearingCache(true);
    setError(null);
    try {
      const receipt = await debugApi.invalidateCacheByPattern(appliedKeyPattern);
      if (!adminCacheInvalidationReceiptHasValidIdentity(receipt)) {
        throw new Error('Cache invalidation receipt identity did not match its evidence');
      }
      setLastInvalidationReceipt(receipt);
      if (receipt.outcome === 'FULLY_INVALIDATED') {
        setShowClearConfirm(false);
      } else {
        setError(
          `Cache invalidation left ${receipt.residualCount.toLocaleString()} matching key(s)`,
        );
      }
      await loadCacheData();
    } catch (err) {
      console.error('Failed to clear cache:', err);
      setError(err instanceof Error ? err.message : 'Failed to clear cache');
    } finally {
      setClearingCache(false);
    }
  };

  const handleInvalidateEntry = async (key: string) => {
    if (!confirm(`Are you sure you want to invalidate cache entry "${key}"?`)) return;

    setBusyCacheKey(key);
    setError(null);
    try {
      const receipt = await debugApi.invalidateCacheEntry(key);
      if (!adminCacheInvalidationReceiptHasValidIdentity(receipt)) {
        throw new Error('Cache invalidation receipt identity did not match its evidence');
      }
      setLastInvalidationReceipt(receipt);
      if (receipt.outcome !== 'FULLY_INVALIDATED') {
        setError(
          `Cache invalidation left ${receipt.residualCount.toLocaleString()} matching key(s)`,
        );
      }
      await loadCacheData();
    } catch (err) {
      console.error('Failed to invalidate cache entry:', err);
      setError(err instanceof Error ? err.message : 'Failed to invalidate cache entry');
    } finally {
      setBusyCacheKey(null);
    }
  };

  const handleExecuteQuery = async () => {
    if (!queryInput.trim()) return;

    setQueryExecuting(true);
    setQueryError(null);
    setQueryResult(null);

    try {
      setQueryResult(await databaseApi.executeExplorerQuery(queryInput.trim()));
    } catch (err) {
      console.error('Failed to execute query:', err);
      setQueryError(err instanceof Error ? err.message : 'Failed to execute query');
    } finally {
      setQueryExecuting(false);
    }
  };

  // ============================================================================
  // Helpers
  // ============================================================================

  const formatBytes = (bytes: number | null) => {
    if (bytes === null) return '—';
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
  };

  const formatDuration = (seconds: number) => {
    if (seconds === -1) return 'no expiry';
    if (seconds === -2) return 'expired';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  };

  const formatIdle = (seconds: number | null) => {
    if (seconds === null) return '—';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h`;
  };

  const queryColumns = queryResult
    ? [...new Set(queryResult.rows.flatMap((row) => Object.keys(row)))]
    : [];

  // ============================================================================
  // Render
  // ============================================================================

  if (loading && activeTab === 'cache' && cacheEntries.length === 0) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 bg-gray-200 rounded w-1/4" />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-white rounded-xl p-6 h-24" />
          ))}
        </div>
        <div className="bg-white rounded-xl p-6 h-96" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Debug Tools</h1>
          <p className="mt-1 text-sm text-gray-500">Advanced debugging and diagnostics interface</p>
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            if (activeTab === 'cache') loadCacheData();
            else loadDatabaseData();
          }}
        >
          <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
          Refresh
        </Button>
      </div>

      {/* Tabs */}
      <Card className="p-0">
        <div className="border-b border-gray-200">
          <nav className="flex -mb-px">
            {[
              {
                id: 'cache',
                label: 'Cache Management',
                icon: 'M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4',
              },
              {
                id: 'database',
                label: 'Database Tools',
                icon: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4',
              },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as TabType)}
                className={`flex items-center gap-2 px-6 py-4 border-b-2 font-medium text-sm transition-colors ${
                  activeTab === tab.id
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={tab.icon} />
                </svg>
                <span className="hidden sm:inline">{tab.label}</span>
              </button>
            ))}
          </nav>
        </div>
      </Card>

      {/* Cache Management Tab */}
      {activeTab === 'cache' && (
        <div className="space-y-6">
          {/* Cache Stats */}
          {cacheStats && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card className="p-4">
                <div className="text-2xl font-bold text-gray-900">
                  {cacheStats.keysInNamespace.toLocaleString()}
                </div>
                <div className="text-sm text-gray-500">Keys in namespace</div>
                <div className="text-xs text-gray-400">{cacheNamespace || 'admin:'}</div>
              </Card>
              <Card className="p-4">
                <div className="text-2xl font-bold text-gray-900">
                  {formatBytes(cacheStats.instance.usedMemoryBytes)}
                </div>
                <div className="text-sm text-gray-500">Instance memory</div>
              </Card>
              <Card className="p-4">
                <div className="text-2xl font-bold text-green-600">
                  {cacheStats.instance.hitRatePercent === null
                    ? '—'
                    : `${cacheStats.instance.hitRatePercent}%`}
                </div>
                <div className="text-sm text-gray-500">Instance hit rate</div>
              </Card>
              <Card className="p-4">
                <div className="text-2xl font-bold text-gray-900">
                  {cacheStats.instance.totalKeys.toLocaleString()}
                </div>
                <div className="text-sm text-gray-500">Keys in instance</div>
              </Card>
            </div>
          )}

          {/* Cache Controls */}
          <Card className="p-4">
            <div className="flex flex-col md:flex-row md:items-end gap-4">
              <div className="flex-1">
                <label
                  htmlFor="cache-key-pattern"
                  className="block text-sm font-medium text-gray-700 mb-1"
                >
                  Key pattern
                </label>
                <Input
                  id="cache-key-pattern"
                  placeholder="report:*"
                  value={keyPattern}
                  onChange={(event) => setKeyPattern(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') setAppliedKeyPattern(keyPattern || '*');
                  }}
                />
              </div>
              <Button variant="secondary" onClick={() => setAppliedKeyPattern(keyPattern || '*')}>
                Apply
              </Button>
              <Button
                variant="danger"
                disabled={cacheEntries.length === 0}
                onClick={() => setShowClearConfirm(true)}
              >
                Clear matching
              </Button>
            </div>
            {cacheListingTruncated && (
              <p className="text-xs text-amber-700 mt-3">
                Showing {cacheEntries.length} of {cacheMatchedCount.toLocaleString()} matching keys.
                Narrow the pattern to inspect the complete set.
              </p>
            )}
          </Card>

          {lastInvalidationReceipt && (
            <Card className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-gray-900">
                    Invalidation evidence: {lastInvalidationReceipt.outcome}
                  </div>
                  <div className="text-xs text-gray-500">
                    Discovered {lastInvalidationReceipt.discoveredCount.toLocaleString()}, deleted{' '}
                    {lastInvalidationReceipt.deletedCount.toLocaleString()}, residual{' '}
                    {lastInvalidationReceipt.residualCount.toLocaleString()}
                  </div>
                </div>
                <code className="text-xs text-gray-500 break-all">
                  {lastInvalidationReceipt.receiptId}
                </code>
              </div>
            </Card>
          )}

          {/* Cache Entries Table */}
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Key
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Type
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      TTL
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Size
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Idle
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {cacheEntries.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-6 py-12 text-center text-gray-500">
                        {error
                          ? 'The cache could not be read'
                          : `No keys match "${appliedKeyPattern}"`}
                      </td>
                    </tr>
                  ) : (
                    cacheEntries.map((entry) => (
                      <tr key={entry.key} className="hover:bg-gray-50">
                        <td className="px-6 py-4">
                          <div className="font-mono text-sm text-gray-900">{entry.key}</div>
                        </td>
                        <td className="px-6 py-4">
                          <Badge variant="info" size="sm">
                            {entry.type}
                          </Badge>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {formatDuration(entry.ttlSeconds)}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {formatBytes(entry.sizeBytes)}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {formatIdle(entry.idleSeconds)}
                        </td>
                        <td className="px-6 py-4 text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            loading={busyCacheKey === entry.key}
                            onClick={() => void handleInvalidateEntry(entry.key)}
                          >
                            Invalidate
                          </Button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {/* Database Tools Tab */}
      {activeTab === 'database' && (
        <div className="space-y-6">
          {/* Query Executor */}
          <Card className="p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Query Executor</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">SQL Query</label>
                <textarea
                  value={queryInput}
                  onChange={(e) => setQueryInput(e.target.value)}
                  rows={4}
                  maxLength={10000}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg font-mono text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  placeholder="Enter SQL query..."
                />
                <div className="text-xs text-gray-500 text-right mt-1">
                  {queryInput.length} / 10,000 characters
                </div>
              </div>
              <div className="flex justify-between items-center">
                <div className="text-sm text-yellow-600 flex items-center gap-2">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                    />
                  </svg>
                  <span>Warning: This will execute queries on the production database</span>
                </div>
                <Button
                  onClick={handleExecuteQuery}
                  loading={queryExecuting}
                  disabled={!queryInput.trim() || queryExecuting}
                >
                  Execute Query
                </Button>
              </div>
              {queryError && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
                  {queryError}
                </div>
              )}
              {queryResult && (
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <div className="bg-gray-50 px-4 py-2 flex justify-between items-center">
                    <span className="text-sm text-gray-600">{queryResult.rowCount} rows</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          {queryColumns.map((col) => (
                            <th
                              key={col}
                              className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase"
                            >
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {queryResult.rows.map((row, idx) => (
                          <tr key={idx} className="hover:bg-gray-50">
                            {queryColumns.map((col) => (
                              <td key={col} className="px-4 py-2 text-sm text-gray-900">
                                {String(row[col])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </Card>

          {connectionStats && (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              {[
                ['Total', connectionStats.total],
                ['Active', connectionStats.active],
                ['Idle', connectionStats.idle],
                ['Waiting', connectionStats.waiting],
                ['Maximum', connectionStats.maxConnections],
                ['Utilization', `${connectionStats.utilizationPercent.toFixed(1)}%`],
              ].map(([label, value]) => (
                <Card key={label} className="p-4">
                  <div className="text-2xl font-bold text-gray-900">{value}</div>
                  <div className="text-sm text-gray-500">{label}</div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Clear Cache Confirmation Modal */}
      {showClearConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <Card className="max-w-md w-full">
            <div className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center">
                  <svg
                    className="w-6 h-6 text-red-600"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                    />
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-bold text-gray-900">Clear matching keys</h2>
                  <p className="text-sm text-gray-500">This action cannot be undone</p>
                </div>
              </div>
              <p className="text-sm text-gray-600 mb-6">
                Remove every key matching <code className="font-mono">{appliedKeyPattern}</code>{' '}
                from the <code className="font-mono">{cacheNamespace || 'admin:'}</code> namespace?
                Cached values will be recomputed on the next read.
              </p>
              <div className="flex justify-end gap-3">
                <Button
                  variant="secondary"
                  disabled={clearingCache}
                  onClick={() => setShowClearConfirm(false)}
                >
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  loading={clearingCache}
                  onClick={() => void handleClearCache()}
                >
                  Clear matching
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Error Display */}
      {error && (
        <div className="fixed bottom-4 right-4 max-w-md bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded-lg shadow-lg">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
            <span>{error}</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default DebugToolsPage;
