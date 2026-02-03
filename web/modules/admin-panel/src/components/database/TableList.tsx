/**
 * TableList Component
 *
 * Displays database tables in a scrollable, searchable, and sortable list.
 * Features grouping by entity type (detects patterns like user_*, sensor_*, etc.)
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Card,
  SearchInput,
  Select,
  Skeleton,
} from '@aquaculture/shared-ui';

// ============================================================================
// Types
// ============================================================================

export interface TableListProps {
  /** Schema name to fetch tables from */
  schema: string;
  /** Type of schema - affects styling/icons */
  schemaType: 'system' | 'tenant';
  /** Callback when a table is selected */
  onTableSelect: (tableName: string) => void;
  /** Currently selected table */
  selectedTable: string | null;
}

interface TableInfo {
  tableName: string;
  schemaName: string;
  rowCount: number;
  sizeBytes: number;
  hasPrimaryKey?: boolean;
  hasForeignKey?: boolean;
  hasIndexes?: boolean;
}

type SortField = 'name' | 'size' | 'rowCount';
type SortDirection = 'asc' | 'desc';

interface TableGroup {
  name: string;
  tables: TableInfo[];
  isExpanded: boolean;
}

// ============================================================================
// API Functions
// ============================================================================

const API_BASE = '/api/database/explorer';

const getAuthHeader = (): Record<string, string> => {
  const token = localStorage.getItem('access_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
};

async function fetchTables(schema: string): Promise<TableInfo[]> {
  const response = await fetch(`${API_BASE}/schemas/${schema}/tables`, {
    headers: { ...getAuthHeader() },
  });
  if (!response.ok) throw new Error('Failed to fetch tables');
  return response.json();
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Format row count with K, M suffixes
 */
function formatRowCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}K`;
  }
  return count.toString();
}

/**
 * Format size in bytes to human readable format
 */
function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  const value = bytes / Math.pow(k, i);

  if (value < 10) {
    return `${value.toFixed(1)} ${units[i]}`;
  }
  return `${Math.round(value)} ${units[i]}`;
}

/**
 * Detect entity group from table name
 * e.g., "user_permissions" -> "user", "sensor_readings" -> "sensor"
 */
function detectEntityGroup(tableName: string): string {
  // Common prefixes to detect
  const knownPrefixes = [
    'user', 'tenant', 'sensor', 'farm', 'pond', 'batch',
    'alert', 'notification', 'billing', 'invoice', 'payment',
    'subscription', 'module', 'permission', 'role', 'audit',
    'config', 'setting', 'log', 'metric', 'report', 'schedule',
    'feeding', 'growth', 'harvest', 'inventory', 'equipment',
    'maintenance', 'employee', 'leave', 'attendance', 'training',
  ];

  const lowerName = tableName.toLowerCase();

  // Check for known prefixes
  for (const prefix of knownPrefixes) {
    if (lowerName.startsWith(`${prefix}_`) || lowerName === prefix || lowerName === `${prefix}s`) {
      return prefix.charAt(0).toUpperCase() + prefix.slice(1);
    }
  }

  // Try to extract prefix from underscore-separated names
  const parts = lowerName.split('_');
  if (parts.length > 1 && parts[0].length >= 3) {
    return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  }

  return 'Other';
}

/**
 * Group tables by entity type
 */
function groupTablesByEntity(tables: TableInfo[]): TableGroup[] {
  const groups = new Map<string, TableInfo[]>();

  tables.forEach((table) => {
    const group = detectEntityGroup(table.tableName);
    if (!groups.has(group)) {
      groups.set(group, []);
    }
    groups.get(group)!.push(table);
  });

  // Sort groups alphabetically, but put "Other" at the end
  const sortedGroups = Array.from(groups.entries())
    .sort((a, b) => {
      if (a[0] === 'Other') return 1;
      if (b[0] === 'Other') return -1;
      return a[0].localeCompare(b[0]);
    })
    .map(([name, tables]) => ({
      name,
      tables,
      isExpanded: true,
    }));

  return sortedGroups;
}

// ============================================================================
// Icons
// ============================================================================

const TableIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
      d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
  </svg>
);

const KeyIcon: React.FC<{ className?: string }> = ({ className = 'w-3 h-3' }) => (
  <svg className={className} fill="currentColor" viewBox="0 0 20 20">
    <path fillRule="evenodd" clipRule="evenodd"
      d="M18 8a6 6 0 01-7.743 5.743L10 14l-1 1-1 1H6v2H2v-4l4.257-4.257A6 6 0 1118 8zm-6-4a1 1 0 100 2 2 2 0 012 2 1 1 0 102 0 4 4 0 00-4-4z" />
  </svg>
);

const LinkIcon: React.FC<{ className?: string }> = ({ className = 'w-3 h-3' }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
      d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
  </svg>
);

const IndexIcon: React.FC<{ className?: string }> = ({ className = 'w-3 h-3' }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
      d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
  </svg>
);

const ChevronIcon: React.FC<{ expanded: boolean; className?: string }> = ({
  expanded,
  className = 'w-4 h-4'
}) => (
  <svg
    className={`${className} transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
  >
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
  </svg>
);

// ============================================================================
// Sub-components
// ============================================================================

interface TableListItemProps {
  table: TableInfo;
  isSelected: boolean;
  onClick: () => void;
  showZebraStripe: boolean;
  schemaType: 'system' | 'tenant';
}

const TableListItem: React.FC<TableListItemProps> = ({
  table,
  isSelected,
  onClick,
  showZebraStripe,
  schemaType,
}) => {
  const baseStyles = isSelected
    ? 'bg-blue-50 border-l-2 border-l-blue-500'
    : showZebraStripe
    ? 'bg-gray-50/50 hover:bg-gray-100'
    : 'hover:bg-gray-100';

  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        w-full text-left px-3 py-2 transition-colors duration-150
        ${baseStyles}
        ${isSelected ? 'text-blue-900' : 'text-gray-700'}
      `}
      aria-selected={isSelected}
      role="option"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <TableIcon
            className={`w-4 h-4 flex-shrink-0 ${
              schemaType === 'system' ? 'text-purple-500' : 'text-green-500'
            }`}
          />
          <span className="font-medium text-sm truncate" title={table.tableName}>
            {table.tableName}
          </span>

          {/* Table type icons */}
          <div className="flex items-center gap-1 flex-shrink-0">
            {table.hasPrimaryKey && (
              <span title="Has Primary Key" className="text-yellow-500">
                <KeyIcon />
              </span>
            )}
            {table.hasForeignKey && (
              <span title="Has Foreign Keys" className="text-blue-500">
                <LinkIcon />
              </span>
            )}
            {table.hasIndexes && (
              <span title="Has Indexes" className="text-gray-400">
                <IndexIcon />
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs text-gray-500 flex-shrink-0">
          <span title={`${table.rowCount.toLocaleString()} rows`}>
            {formatRowCount(table.rowCount)}
          </span>
          <span
            className="w-16 text-right"
            title={`${table.sizeBytes.toLocaleString()} bytes`}
          >
            {formatSize(table.sizeBytes)}
          </span>
        </div>
      </div>
    </button>
  );
};

interface TableGroupHeaderProps {
  group: TableGroup;
  onToggle: () => void;
  tableCount: number;
}

const TableGroupHeader: React.FC<TableGroupHeaderProps> = ({
  group,
  onToggle,
  tableCount,
}) => (
  <button
    type="button"
    onClick={onToggle}
    className="w-full flex items-center gap-2 px-3 py-2 bg-gray-100 hover:bg-gray-200 transition-colors"
  >
    <ChevronIcon expanded={group.isExpanded} className="w-4 h-4 text-gray-500" />
    <span className="font-semibold text-sm text-gray-700">{group.name}</span>
    <span className="text-xs text-gray-500">({tableCount})</span>
  </button>
);

const LoadingSkeleton: React.FC = () => (
  <div className="space-y-1 p-2">
    {Array.from({ length: 8 }).map((_, i) => (
      <div key={i} className="flex items-center gap-2 px-3 py-2">
        <Skeleton width={16} height={16} />
        <Skeleton width={`${60 + Math.random() * 30}%`} height={16} />
        <div className="ml-auto flex gap-2">
          <Skeleton width={32} height={14} />
          <Skeleton width={48} height={14} />
        </div>
      </div>
    ))}
  </div>
);

const EmptyState: React.FC<{ searchQuery: string }> = ({ searchQuery }) => (
  <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
    <TableIcon className="w-12 h-12 text-gray-300 mb-4" />
    <p className="text-gray-500 text-sm">
      {searchQuery
        ? `No tables found matching "${searchQuery}"`
        : 'No tables found in this schema'}
    </p>
  </div>
);

// ============================================================================
// Main Component
// ============================================================================

export const TableList: React.FC<TableListProps> = ({
  schema,
  schemaType,
  onTableSelect,
  selectedTable,
}) => {
  // State
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [groupByEntity, setGroupByEntity] = useState(true);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Fetch tables when schema changes
  useEffect(() => {
    let isMounted = true;

    const loadTables = async () => {
      setLoading(true);
      setError(null);

      try {
        const data = await fetchTables(schema);
        if (isMounted) {
          setTables(data);
          // Initialize all groups as expanded
          const groups = groupTablesByEntity(data);
          setExpandedGroups(new Set(groups.map(g => g.name)));
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : 'Failed to load tables');
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    loadTables();

    return () => {
      isMounted = false;
    };
  }, [schema]);

  // Filter and sort tables
  const filteredAndSortedTables = useMemo(() => {
    let result = [...tables];

    // Filter by search query
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(table =>
        table.tableName.toLowerCase().includes(query)
      );
    }

    // Sort
    result.sort((a, b) => {
      let comparison = 0;

      switch (sortField) {
        case 'name':
          comparison = a.tableName.localeCompare(b.tableName);
          break;
        case 'size':
          comparison = a.sizeBytes - b.sizeBytes;
          break;
        case 'rowCount':
          comparison = a.rowCount - b.rowCount;
          break;
      }

      return sortDirection === 'asc' ? comparison : -comparison;
    });

    return result;
  }, [tables, searchQuery, sortField, sortDirection]);

  // Group tables
  const tableGroups = useMemo(() => {
    if (!groupByEntity) {
      return null;
    }

    const groups = groupTablesByEntity(filteredAndSortedTables);

    // Apply expanded state
    return groups.map(group => ({
      ...group,
      isExpanded: expandedGroups.has(group.name),
    }));
  }, [filteredAndSortedTables, groupByEntity, expandedGroups]);

  // Handlers
  const handleSortChange = useCallback((value: string) => {
    const [field, direction] = value.split('-') as [SortField, SortDirection];
    setSortField(field);
    setSortDirection(direction);
  }, []);

  const handleToggleGroup = useCallback((groupName: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupName)) {
        next.delete(groupName);
      } else {
        next.add(groupName);
      }
      return next;
    });
  }, []);

  const handleExpandAll = useCallback(() => {
    if (tableGroups) {
      setExpandedGroups(new Set(tableGroups.map(g => g.name)));
    }
  }, [tableGroups]);

  const handleCollapseAll = useCallback(() => {
    setExpandedGroups(new Set());
  }, []);

  // Sort options
  const sortOptions = [
    { value: 'name-asc', label: 'Name (A-Z)' },
    { value: 'name-desc', label: 'Name (Z-A)' },
    { value: 'size-desc', label: 'Size (Largest)' },
    { value: 'size-asc', label: 'Size (Smallest)' },
    { value: 'rowCount-desc', label: 'Rows (Most)' },
    { value: 'rowCount-asc', label: 'Rows (Least)' },
  ];

  // Render
  return (
    <Card className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="p-3 border-b border-gray-200 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-gray-900">
            Tables
            {!loading && (
              <span className="ml-2 text-sm font-normal text-gray-500">
                ({filteredAndSortedTables.length})
              </span>
            )}
          </h3>

          {/* Group toggle */}
          <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
            <input
              type="checkbox"
              checked={groupByEntity}
              onChange={(e) => setGroupByEntity(e.target.checked)}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            Group
          </label>
        </div>

        {/* Search */}
        <SearchInput
          placeholder="Filter tables..."
          value={searchQuery}
          onChange={setSearchQuery}
          size="sm"
        />

        {/* Sort */}
        <div className="flex items-center gap-2">
          <Select
            options={sortOptions}
            value={`${sortField}-${sortDirection}`}
            onChange={(e) => handleSortChange(e.target.value)}
            size="sm"
            fullWidth
          />

          {groupByEntity && tableGroups && tableGroups.length > 0 && (
            <div className="flex gap-1">
              <button
                type="button"
                onClick={handleExpandAll}
                className="px-2 py-1 text-xs text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded"
                title="Expand all groups"
              >
                Expand
              </button>
              <button
                type="button"
                onClick={handleCollapseAll}
                className="px-2 py-1 text-xs text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded"
                title="Collapse all groups"
              >
                Collapse
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Table List */}
      <div
        className="flex-1 overflow-y-auto"
        role="listbox"
        aria-label="Database tables"
      >
        {loading ? (
          <LoadingSkeleton />
        ) : error ? (
          <div className="p-4 text-center">
            <p className="text-red-500 text-sm">{error}</p>
            <button
              type="button"
              onClick={() => {
                setLoading(true);
                fetchTables(schema)
                  .then(setTables)
                  .catch(err => setError(err.message))
                  .finally(() => setLoading(false));
              }}
              className="mt-2 text-sm text-blue-600 hover:text-blue-800"
            >
              Retry
            </button>
          </div>
        ) : filteredAndSortedTables.length === 0 ? (
          <EmptyState searchQuery={searchQuery} />
        ) : groupByEntity && tableGroups ? (
          // Grouped view
          <div className="divide-y divide-gray-200">
            {tableGroups.map((group) => (
              <div key={group.name}>
                <TableGroupHeader
                  group={group}
                  onToggle={() => handleToggleGroup(group.name)}
                  tableCount={group.tables.length}
                />
                {group.isExpanded && (
                  <div>
                    {group.tables.map((table, index) => (
                      <TableListItem
                        key={table.tableName}
                        table={table}
                        isSelected={selectedTable === table.tableName}
                        onClick={() => onTableSelect(table.tableName)}
                        showZebraStripe={index % 2 === 1}
                        schemaType={schemaType}
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          // Flat view
          <div>
            {filteredAndSortedTables.map((table, index) => (
              <TableListItem
                key={table.tableName}
                table={table}
                isSelected={selectedTable === table.tableName}
                onClick={() => onTableSelect(table.tableName)}
                showZebraStripe={index % 2 === 1}
                schemaType={schemaType}
              />
            ))}
          </div>
        )}
      </div>

      {/* Footer with stats */}
      {!loading && filteredAndSortedTables.length > 0 && (
        <div className="px-3 py-2 border-t border-gray-200 bg-gray-50 text-xs text-gray-500">
          <div className="flex justify-between">
            <span>
              Total: {filteredAndSortedTables.reduce((sum, t) => sum + t.rowCount, 0).toLocaleString()} rows
            </span>
            <span>
              {formatSize(filteredAndSortedTables.reduce((sum, t) => sum + t.sizeBytes, 0))}
            </span>
          </div>
        </div>
      )}
    </Card>
  );
};

export default TableList;
