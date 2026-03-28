/**
 * TenantMultiSelect Component
 *
 * Reusable multi-select for choosing multiple tenants.
 * Features: searchable, "Select All" toggle, selected count.
 */

import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Search, Check, ChevronDown, Loader2, X } from 'lucide-react';
import { useActiveTenants, type TenantOption } from '../hooks/useTenants';

// ============================================================================
// Types
// ============================================================================

interface TenantMultiSelectProps {
  value: string[];
  onChange: (tenantIds: string[]) => void;
  placeholder?: string;
}

// ============================================================================
// Component
// ============================================================================

export const TenantMultiSelect: React.FC<TenantMultiSelectProps> = ({
  value,
  onChange,
  placeholder = 'Select tenants...',
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  const { data: tenants, isLoading } = useActiveTenants();

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filteredTenants = useMemo(() => {
    if (!tenants) return [];
    if (!search) return tenants;
    const query = search.toLowerCase();
    return tenants.filter(
      (t: TenantOption) =>
        t.name.toLowerCase().includes(query) ||
        t.tier.toLowerCase().includes(query),
    );
  }, [tenants, search]);

  const allTenantIds = useMemo(() => (tenants || []).map((t: TenantOption) => t.id), [tenants]);

  const allSelected = tenants && tenants.length > 0 && value.length === tenants.length;

  const handleToggleTenant = (tenantId: string) => {
    if (value.includes(tenantId)) {
      onChange(value.filter((id) => id !== tenantId));
    } else {
      onChange([...value, tenantId]);
    }
  };

  const handleSelectAll = () => {
    if (allSelected) {
      onChange([]);
    } else {
      onChange(allTenantIds);
    }
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange([]);
  };

  const selectedNames = useMemo(() => {
    if (!tenants) return [];
    return value
      .map((id) => tenants.find((t: TenantOption) => t.id === id)?.name)
      .filter(Boolean) as string[];
  }, [value, tenants]);

  const totalCount = tenants?.length || 0;

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Trigger */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white hover:bg-gray-50 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
      >
        <span className="text-left truncate flex-1">
          {value.length === 0 ? (
            <span className="text-gray-500">{placeholder}</span>
          ) : value.length <= 2 ? (
            <span className="text-gray-900">{selectedNames.join(', ')}</span>
          ) : (
            <span className="text-gray-900">
              {value.length} of {totalCount} tenants selected
            </span>
          )}
        </span>
        <div className="flex items-center gap-1 ml-2">
          {value.length > 0 && (
            <span
              onClick={handleClear}
              className="p-0.5 text-gray-400 hover:text-gray-600 rounded"
            >
              <X size={14} />
            </span>
          )}
          <ChevronDown size={16} className="text-gray-400" />
        </div>
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-72 flex flex-col">
          {/* Search */}
          <div className="p-2 border-b border-gray-100">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search tenants..."
                className="w-full pl-8 pr-3 py-1.5 border border-gray-200 rounded text-sm focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                autoFocus
              />
            </div>
          </div>

          {/* Select All */}
          {!search && totalCount > 0 && (
            <button
              type="button"
              onClick={handleSelectAll}
              className="flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-gray-50 border-b border-gray-100"
            >
              <div className={`w-4 h-4 rounded border flex items-center justify-center ${
                allSelected
                  ? 'bg-blue-600 border-blue-600'
                  : 'border-gray-300'
              }`}>
                {allSelected && <Check size={12} className="text-white" />}
              </div>
              <span className="font-medium text-gray-700">
                Select All ({totalCount})
              </span>
            </button>
          )}

          {/* Options */}
          <div className="flex-1 overflow-y-auto">
            {isLoading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="animate-spin text-blue-600" size={20} />
              </div>
            ) : filteredTenants.length === 0 ? (
              <div className="text-center py-6 text-sm text-gray-500">
                {search ? 'No tenants match your search' : 'No active tenants found'}
              </div>
            ) : (
              filteredTenants.map((tenant: TenantOption) => {
                const isSelected = value.includes(tenant.id);
                return (
                  <button
                    key={tenant.id}
                    type="button"
                    onClick={() => handleToggleTenant(tenant.id)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-gray-50"
                  >
                    <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                      isSelected
                        ? 'bg-blue-600 border-blue-600'
                        : 'border-gray-300'
                    }`}>
                      {isSelected && <Check size={12} className="text-white" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="text-gray-900 truncate block">{tenant.name}</span>
                    </div>
                    <span className="text-xs text-gray-500 capitalize flex-shrink-0">
                      {tenant.tier}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          {/* Footer */}
          {value.length > 0 && (
            <div className="border-t border-gray-100 px-3 py-2 text-xs text-gray-500">
              {value.length} of {totalCount} tenants selected
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default TenantMultiSelect;
