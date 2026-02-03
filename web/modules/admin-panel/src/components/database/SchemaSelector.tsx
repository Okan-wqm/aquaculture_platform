/**
 * SchemaSelector Component
 *
 * A tabbed interface for selecting database schemas.
 * Provides separate views for System (public) schema and Tenant schemas
 * with search, filtering, and status indicators.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Card, Badge, Button, Input, Skeleton } from '@aquaculture/shared-ui';

// ============================================================================
// Type Definitions
// ============================================================================

export interface SchemaSelectorProps {
  /** Callback when a schema is selected */
  onSchemaSelect: (schema: string, type: 'system' | 'tenant') => void;
  /** Currently selected schema */
  selectedSchema: string | null;
}

export interface TenantSchema {
  schemaName: string;
  tenantId: string;
  tenantName: string;
  status: 'active' | 'suspended' | 'inactive';
  size: string;
  tableCount: number;
  createdAt: string;
}

export interface CategorizedSchemas {
  system: {
    schemaName: string;
    tableCount: number;
    size: string;
  };
  tenants: TenantSchema[];
}

type TabType = 'system' | 'tenants';

// ============================================================================
// Constants
// ============================================================================

const STATUS_BADGE_VARIANTS: Record<TenantSchema['status'], 'success' | 'warning' | 'error'> = {
  active: 'success',
  suspended: 'warning',
  inactive: 'error',
};

const STATUS_LABELS: Record<TenantSchema['status'], string> = {
  active: 'Active',
  suspended: 'Suspended',
  inactive: 'Inactive',
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Fetch categorized schemas from the API
 */
async function fetchCategorizedSchemas(): Promise<CategorizedSchemas> {
  const token = localStorage.getItem('access_token');

  const response = await fetch('/api/database/explorer/schemas/categorized', {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `HTTP error! status: ${response.status}`);
  }

  return response.json();
}

// ============================================================================
// Sub-Components
// ============================================================================

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  count?: number;
}

const TabButton: React.FC<TabButtonProps> = ({ active, onClick, children, count }) => (
  <button
    type="button"
    onClick={onClick}
    className={`
      relative px-4 py-3 text-sm font-medium transition-all duration-200
      border-b-2 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2
      ${active
        ? 'border-blue-500 text-blue-600 dark:text-blue-400'
        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300'
      }
    `}
    aria-selected={active}
    role="tab"
  >
    <span className="flex items-center gap-2">
      {children}
      {count !== undefined && (
        <span
          className={`
            px-2 py-0.5 text-xs rounded-full
            ${active
              ? 'bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-300'
              : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
            }
          `}
        >
          {count}
        </span>
      )}
    </span>
  </button>
);

interface SystemSchemaCardProps {
  schema: CategorizedSchemas['system'];
  isSelected: boolean;
  onSelect: () => void;
}

const SystemSchemaCard: React.FC<SystemSchemaCardProps> = ({ schema, isSelected, onSelect }) => (
  <button
    type="button"
    onClick={onSelect}
    className={`
      w-full text-left p-4 rounded-lg border-2 transition-all duration-200
      focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2
      ${isSelected
        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 dark:border-blue-400'
        : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:hover:border-gray-600 dark:hover:bg-gray-800'
      }
    `}
  >
    <div className="flex items-start justify-between">
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <DatabaseIcon className="w-5 h-5 text-gray-500 dark:text-gray-400" />
          <h3 className="font-semibold text-gray-900 dark:text-gray-100">
            {schema.schemaName}
          </h3>
          {isSelected && (
            <CheckIcon className="w-5 h-5 text-blue-500" />
          )}
        </div>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Core system schema containing shared platform data
        </p>
      </div>
    </div>
    <div className="mt-3 flex items-center gap-4 text-sm text-gray-600 dark:text-gray-400">
      <span className="flex items-center gap-1">
        <TableIcon className="w-4 h-4" />
        {schema.tableCount} tables
      </span>
      <span className="flex items-center gap-1">
        <StorageIcon className="w-4 h-4" />
        {schema.size}
      </span>
    </div>
  </button>
);

interface TenantSchemaItemProps {
  tenant: TenantSchema;
  isSelected: boolean;
  onSelect: () => void;
}

const TenantSchemaItem: React.FC<TenantSchemaItemProps> = ({ tenant, isSelected, onSelect }) => (
  <button
    type="button"
    onClick={onSelect}
    className={`
      w-full text-left p-4 rounded-lg border transition-all duration-200
      focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2
      ${isSelected
        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 dark:border-blue-400 ring-1 ring-blue-500'
        : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:hover:border-gray-600 dark:hover:bg-gray-800'
      }
    `}
  >
    <div className="flex items-start justify-between">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h4 className="font-medium text-gray-900 dark:text-gray-100 truncate">
            {tenant.tenantName}
          </h4>
          <Badge variant={STATUS_BADGE_VARIANTS[tenant.status]} size="sm">
            {STATUS_LABELS[tenant.status]}
          </Badge>
          {isSelected && (
            <CheckIcon className="w-4 h-4 text-blue-500 flex-shrink-0" />
          )}
        </div>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400 font-mono truncate">
          {tenant.schemaName}
        </p>
      </div>
    </div>
    <div className="mt-2 flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
      <span className="flex items-center gap-1">
        <TableIcon className="w-3.5 h-3.5" />
        {tenant.tableCount} tables
      </span>
      <span className="flex items-center gap-1">
        <StorageIcon className="w-3.5 h-3.5" />
        {tenant.size}
      </span>
    </div>
  </button>
);

interface LoadingSkeletonProps {
  type: 'system' | 'tenants';
}

const LoadingSkeleton: React.FC<LoadingSkeletonProps> = ({ type }) => {
  if (type === 'system') {
    return (
      <div className="p-4 border border-gray-200 rounded-lg dark:border-gray-700">
        <div className="animate-pulse">
          <div className="flex items-center gap-2">
            <Skeleton width={20} height={20} circle />
            <Skeleton width={100} height={20} />
          </div>
          <Skeleton width="80%" height={16} className="mt-2" />
          <div className="mt-3 flex gap-4">
            <Skeleton width={80} height={16} />
            <Skeleton width={60} height={16} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {[1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          className="p-4 border border-gray-200 rounded-lg dark:border-gray-700"
        >
          <div className="animate-pulse">
            <div className="flex items-center gap-2">
              <Skeleton width={120} height={18} />
              <Skeleton width={60} height={20} rounded />
            </div>
            <Skeleton width={180} height={14} className="mt-1" />
            <div className="mt-2 flex gap-4">
              <Skeleton width={70} height={14} />
              <Skeleton width={50} height={14} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

interface ErrorStateProps {
  message: string;
  onRetry: () => void;
}

const ErrorState: React.FC<ErrorStateProps> = ({ message, onRetry }) => (
  <div className="flex flex-col items-center justify-center py-12 px-4">
    <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center mb-4">
      <ErrorIcon className="w-6 h-6 text-red-500" />
    </div>
    <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-1">
      Failed to load schemas
    </h3>
    <p className="text-sm text-gray-500 dark:text-gray-400 text-center mb-4 max-w-sm">
      {message}
    </p>
    <Button variant="primary" size="sm" onClick={onRetry}>
      Try Again
    </Button>
  </div>
);

interface EmptyStateProps {
  searchQuery: string;
}

const EmptyState: React.FC<EmptyStateProps> = ({ searchQuery }) => (
  <div className="flex flex-col items-center justify-center py-12 px-4">
    <div className="w-12 h-12 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center mb-4">
      <SearchIcon className="w-6 h-6 text-gray-400" />
    </div>
    <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-1">
      No tenants found
    </h3>
    <p className="text-sm text-gray-500 dark:text-gray-400 text-center">
      {searchQuery
        ? `No tenants match "${searchQuery}"`
        : 'No tenant schemas available'}
    </p>
  </div>
);

// ============================================================================
// Icons
// ============================================================================

const DatabaseIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
  </svg>
);

const TableIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 01-1.125-1.125M3.375 19.5h7.5c.621 0 1.125-.504 1.125-1.125m-9.75 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-7.5A1.125 1.125 0 0112 18.375m9.75-12.75c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125m19.5 0v1.5c0 .621-.504 1.125-1.125 1.125M2.25 5.625v1.5c0 .621.504 1.125 1.125 1.125m0 0h17.25m-17.25 0h7.5c.621 0 1.125.504 1.125 1.125M3.375 8.25c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125m17.25-3.75h-7.5c-.621 0-1.125.504-1.125 1.125m8.625-1.125c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125m-17.25 0h7.5m-7.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125M12 10.875v-1.5m0 1.5c0 .621-.504 1.125-1.125 1.125M12 10.875c0 .621.504 1.125 1.125 1.125m-2.25 0c.621 0 1.125.504 1.125 1.125M13.125 12h7.5c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125m-17.25 0h7.5m-7.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125" />
  </svg>
);

const StorageIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3m0 3h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008zm-3 6h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008z" />
  </svg>
);

const CheckIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);

const SearchIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
  </svg>
);

const ErrorIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
  </svg>
);

// ============================================================================
// Main Component
// ============================================================================

/**
 * SchemaSelector - A tabbed interface for selecting database schemas
 *
 * @example
 * <SchemaSelector
 *   selectedSchema="public"
 *   onSchemaSelect={(schema, type) => console.log(schema, type)}
 * />
 */
export const SchemaSelector: React.FC<SchemaSelectorProps> = ({
  onSchemaSelect,
  selectedSchema,
}) => {
  // State
  const [activeTab, setActiveTab] = useState<TabType>('system');
  const [searchQuery, setSearchQuery] = useState('');
  const [schemas, setSchemas] = useState<CategorizedSchemas | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch schemas
  const loadSchemas = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const data = await fetchCategorizedSchemas();
      setSchemas(data);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unexpected error occurred';
      setError(errorMessage);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    loadSchemas();
  }, [loadSchemas]);

  // Filtered tenant schemas based on search
  const filteredTenants = useMemo(() => {
    if (!schemas?.tenants) return [];

    const query = searchQuery.toLowerCase().trim();
    if (!query) return schemas.tenants;

    return schemas.tenants.filter(
      (tenant) =>
        tenant.tenantName.toLowerCase().includes(query) ||
        tenant.schemaName.toLowerCase().includes(query) ||
        tenant.tenantId.toLowerCase().includes(query)
    );
  }, [schemas?.tenants, searchQuery]);

  // Handlers
  const handleSystemSelect = useCallback(() => {
    if (schemas?.system) {
      onSchemaSelect(schemas.system.schemaName, 'system');
    }
  }, [schemas?.system, onSchemaSelect]);

  const handleTenantSelect = useCallback(
    (tenant: TenantSchema) => {
      onSchemaSelect(tenant.schemaName, 'tenant');
    },
    [onSchemaSelect]
  );

  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
  }, []);

  const handleRetry = useCallback(() => {
    loadSchemas();
  }, [loadSchemas]);

  // Determine if system schema is selected
  const isSystemSelected = selectedSchema === schemas?.system?.schemaName;

  return (
    <Card className="overflow-hidden">
      {/* Tab Navigation */}
      <div className="border-b border-gray-200 dark:border-gray-700">
        <nav className="flex -mb-px" role="tablist" aria-label="Schema type tabs">
          <TabButton
            active={activeTab === 'system'}
            onClick={() => setActiveTab('system')}
          >
            System
          </TabButton>
          <TabButton
            active={activeTab === 'tenants'}
            onClick={() => setActiveTab('tenants')}
            count={schemas?.tenants?.length}
          >
            Tenants
          </TabButton>
        </nav>
      </div>

      {/* Tab Content */}
      <div className="p-4">
        {/* Error State */}
        {error && (
          <ErrorState message={error} onRetry={handleRetry} />
        )}

        {/* Loading State */}
        {isLoading && !error && (
          <LoadingSkeleton type={activeTab} />
        )}

        {/* System Tab Content */}
        {!isLoading && !error && activeTab === 'system' && schemas?.system && (
          <SystemSchemaCard
            schema={schemas.system}
            isSelected={isSystemSelected}
            onSelect={handleSystemSelect}
          />
        )}

        {/* Tenants Tab Content */}
        {!isLoading && !error && activeTab === 'tenants' && (
          <div className="space-y-4">
            {/* Search Input */}
            <Input
              placeholder="Search tenants by name or schema..."
              value={searchQuery}
              onChange={handleSearchChange}
              leftIcon={<SearchIcon className="w-5 h-5" />}
              size="md"
            />

            {/* Tenant List */}
            {filteredTenants.length > 0 ? (
              <div className="space-y-2 max-h-[400px] overflow-y-auto pr-2 -mr-2">
                {filteredTenants.map((tenant) => (
                  <TenantSchemaItem
                    key={tenant.schemaName}
                    tenant={tenant}
                    isSelected={selectedSchema === tenant.schemaName}
                    onSelect={() => handleTenantSelect(tenant)}
                  />
                ))}
              </div>
            ) : (
              <EmptyState searchQuery={searchQuery} />
            )}

            {/* Tenant Count Footer */}
            {filteredTenants.length > 0 && (
              <div className="pt-2 border-t border-gray-100 dark:border-gray-700">
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Showing {filteredTenants.length} of {schemas?.tenants?.length || 0} tenants
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
};

export default SchemaSelector;
