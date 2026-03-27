/**
 * VfdParameterBrowser
 *
 * Tab 1 content: Browse, search, and filter VFD parameter definitions.
 * Allows inline editing and adding parameter changes to the draft.
 */

import React, { useState, useMemo, useCallback } from 'react';
import {
  Search,
  Lock,
  AlertTriangle,
  Shield,
  ChevronDown,
  Eye,
  Plus,
  Columns,
  Loader2,
} from 'lucide-react';
import {
  VfdParameterDefinition,
  VfdProgrammingParameterCategory,
  VfdRiskLevel,
} from '../../types/vfd.types';
import { useVfdProgrammingStore } from '../../store/vfdProgrammingStore';

// ============================================================================
// Constants
// ============================================================================

const CATEGORY_OPTIONS: { value: VfdProgrammingParameterCategory; label: string }[] = [
  { value: VfdProgrammingParameterCategory.MOTOR, label: 'Motor' },
  { value: VfdProgrammingParameterCategory.CONTROL, label: 'Control' },
  { value: VfdProgrammingParameterCategory.SPEED, label: 'Speed' },
  { value: VfdProgrammingParameterCategory.PROTECTION, label: 'Protection' },
  { value: VfdProgrammingParameterCategory.PID, label: 'PID' },
  { value: VfdProgrammingParameterCategory.IO, label: 'I/O' },
  { value: VfdProgrammingParameterCategory.COMMUNICATION, label: 'Communication' },
  { value: VfdProgrammingParameterCategory.TORQUE, label: 'Torque' },
  { value: VfdProgrammingParameterCategory.APPLICATION, label: 'Application' },
  { value: VfdProgrammingParameterCategory.DISPLAY, label: 'Display' },
  { value: VfdProgrammingParameterCategory.NETWORK, label: 'Network' },
];

const RISK_COLORS: Record<VfdRiskLevel, { bg: string; text: string; dot: string }> = {
  [VfdRiskLevel.LOW]: { bg: 'bg-green-100', text: 'text-green-800', dot: 'bg-green-500' },
  [VfdRiskLevel.MEDIUM]: { bg: 'bg-yellow-100', text: 'text-yellow-800', dot: 'bg-yellow-500' },
  [VfdRiskLevel.HIGH]: { bg: 'bg-orange-100', text: 'text-orange-800', dot: 'bg-orange-500' },
  [VfdRiskLevel.CRITICAL]: { bg: 'bg-red-100', text: 'text-red-800', dot: 'bg-red-500' },
};

// ============================================================================
// Props
// ============================================================================

interface VfdParameterBrowserProps {
  definitions: VfdParameterDefinition[];
  loading: boolean;
  error: string | null;
}

// ============================================================================
// Sub-components
// ============================================================================

interface ParameterCardProps {
  param: VfdParameterDefinition;
  isDraft: boolean;
  draftValue: number | string | undefined;
  compareMode: boolean;
  onAddToDraft: (parameterName: string, newValue: number, originalValue: number) => void;
}

function ParameterCard({
  param,
  isDraft,
  draftValue,
  compareMode,
  onAddToDraft,
}: ParameterCardProps) {
  const [inputValue, setInputValue] = useState<string>(
    draftValue !== undefined ? String(draftValue) : String(param.currentValue ?? param.defaultValue ?? ''),
  );
  const [validationError, setValidationError] = useState<string | null>(null);

  const isReadOnly = !param.isWritable;
  const riskStyle = RISK_COLORS[param.riskLevel] ?? RISK_COLORS[VfdRiskLevel.LOW];
  const currentVal = param.currentValue ?? param.defaultValue ?? 0;

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setInputValue(val);

      const num = parseFloat(val);
      if (isNaN(num)) {
        setValidationError('Must be a number');
        return;
      }
      if (param.minValue !== null && num < param.minValue) {
        setValidationError(`Min: ${param.minValue}`);
        return;
      }
      if (param.maxValue !== null && num > param.maxValue) {
        setValidationError(`Max: ${param.maxValue}`);
        return;
      }
      if (param.step !== null && param.step > 0) {
        const steps = (num - (param.minValue ?? 0)) / param.step;
        if (Math.abs(steps - Math.round(steps)) > 0.001) {
          setValidationError(`Step: ${param.step}`);
          return;
        }
      }
      setValidationError(null);
    },
    [param.minValue, param.maxValue, param.step],
  );

  const handleAddToDraft = useCallback(() => {
    const num = parseFloat(inputValue);
    if (isNaN(num) || validationError) return;
    onAddToDraft(param.parameterName, num, currentVal);
  }, [inputValue, validationError, param.parameterName, currentVal, onAddToDraft]);

  return (
    <div
      className={`rounded-lg border p-4 transition-colors ${
        isDraft ? 'border-indigo-300 bg-indigo-50' : 'border-gray-200 bg-white'
      }`}
      data-testid={`param-card-${param.parameterName}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-semibold text-gray-900">
              {param.parameterName}
            </span>
            <span className="text-sm text-gray-600">{param.displayName || param.description}</span>
            {isReadOnly && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600"
                data-testid={`readonly-badge-${param.parameterName}`}
              >
                <Lock className="h-3 w-3" /> Read Only
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-gray-500">
            <span>Current: {currentVal}{param.unit ? ` ${param.unit}` : ''}</span>
            {param.minValue !== null && param.maxValue !== null && (
              <span>Range: {param.minValue}-{param.maxValue}{param.unit ? ` ${param.unit}` : ''}</span>
            )}
            {param.unit && <span>Unit: {param.unit}</span>}
            <span>Group: {param.group}</span>
          </div>
        </div>
        <div
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${riskStyle.bg} ${riskStyle.text}`}
          data-testid={`risk-badge-${param.parameterName}`}
        >
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${riskStyle.dot}`} />
          {param.riskLevel}
        </div>
      </div>

      {!isReadOnly && (
        <div className="mt-3 flex items-center gap-2">
          <label htmlFor={`input-${param.parameterName}`} className="sr-only">
            New value for {param.parameterName}
          </label>
          <input
            id={`input-${param.parameterName}`}
            type="number"
            step={param.step ?? param.scalingFactor ?? 'any'}
            min={param.minValue ?? undefined}
            max={param.maxValue ?? undefined}
            value={inputValue}
            onChange={handleInputChange}
            className={`w-32 rounded-md border px-3 py-1.5 text-sm ${
              validationError
                ? 'border-red-300 focus:border-red-500 focus:ring-red-500'
                : 'border-gray-300 focus:border-indigo-500 focus:ring-indigo-500'
            }`}
            aria-label={`New value for ${param.parameterName}`}
            aria-invalid={!!validationError}
          />
          <button
            type="button"
            onClick={handleAddToDraft}
            disabled={!!validationError || inputValue === '' || parseFloat(inputValue) === currentVal}
            className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={`Add ${param.parameterName} to draft`}
          >
            <Plus className="h-3 w-3" /> Add to Draft
          </button>
          {validationError && (
            <span className="text-xs text-red-600" role="alert">
              {validationError}
            </span>
          )}
        </div>
      )}

      {compareMode && isDraft && draftValue !== undefined && (
        <div className="mt-2 flex items-center gap-4 rounded bg-indigo-100 px-3 py-1.5 text-xs">
          <span className="text-gray-600">Current: {currentVal}{param.unit ? ` ${param.unit}` : ''}</span>
          <span className="font-bold text-indigo-700">New: {draftValue}{param.unit ? ` ${param.unit}` : ''}</span>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function VfdParameterBrowser({
  definitions,
  loading,
  error,
}: VfdParameterBrowserProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [categoryFilter, setCategoryFilter] = useState<string>('');

  const {
    showAdvancedParams,
    toggleAdvancedParams,
    compareMode,
    toggleCompareMode,
    draftItems,
    addDraftItem,
  } = useVfdProgrammingStore();

  // Derive unique groups from definitions
  const groups = useMemo(() => {
    const groupSet = new Set<string>();
    definitions.forEach((d) => groupSet.add(d.group));
    return Array.from(groupSet).sort();
  }, [definitions]);

  // Filter definitions
  const filtered = useMemo(() => {
    return definitions.filter((d) => {
      // Advanced filter
      if (!showAdvancedParams && d.displayOrder > 100) return false;

      // Group filter
      if (selectedGroups.size > 0 && !selectedGroups.has(d.group)) return false;

      // Category filter
      if (categoryFilter && d.category !== categoryFilter) return false;

      // Search filter
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return (
          d.parameterName.toLowerCase().includes(q) ||
          (d.displayName ?? '').toLowerCase().includes(q) ||
          (d.description ?? '').toLowerCase().includes(q) ||
          String(d.registerAddress).includes(q)
        );
      }

      return true;
    });
  }, [definitions, showAdvancedParams, selectedGroups, categoryFilter, searchQuery]);

  const handleGroupToggle = useCallback((group: string) => {
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  }, []);

  const handleAddToDraft = useCallback(
    (parameterName: string, newValue: number, originalValue: number) => {
      addDraftItem(parameterName, newValue, originalValue);
    },
    [addDraftItem],
  );

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center" role="alert">
        <AlertTriangle className="mb-2 h-8 w-8 text-red-500" />
        <p className="text-sm text-red-600">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex gap-4" data-testid="vfd-parameter-browser">
      {/* Sidebar: Group Filters */}
      <aside className="hidden w-48 shrink-0 lg:block">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
          Groups
        </h3>
        <div className="space-y-1">
          {groups.map((group) => (
            <label
              key={group}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-gray-50"
            >
              <input
                type="checkbox"
                checked={selectedGroups.has(group)}
                onChange={() => handleGroupToggle(group)}
                className="h-3.5 w-3.5 rounded border-gray-300 text-indigo-600"
              />
              <span className="text-gray-700">{group}</span>
            </label>
          ))}
        </div>

        <div className="mt-4 border-t pt-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            Category
          </h3>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
            aria-label="Filter by category"
          >
            <option value="">All Categories</option>
            {CATEGORY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="mt-4 border-t pt-4">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showAdvancedParams}
              onChange={toggleAdvancedParams}
              className="h-3.5 w-3.5 rounded border-gray-300 text-indigo-600"
            />
            <Eye className="h-3.5 w-3.5 text-gray-500" />
            <span className="text-gray-700">Advanced</span>
          </label>
        </div>
      </aside>

      {/* Main content */}
      <div className="min-w-0 flex-1">
        {/* Toolbar */}
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search parameters..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-md border border-gray-300 py-2 pl-9 pr-3 text-sm focus:border-indigo-500 focus:ring-indigo-500"
              aria-label="Search parameters"
            />
          </div>

          {/* Mobile category dropdown */}
          <div className="lg:hidden">
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="rounded-md border border-gray-300 px-2 py-2 text-sm"
              aria-label="Filter by category"
            >
              <option value="">All</option>
              {CATEGORY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={toggleCompareMode}
            className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium ${
              compareMode
                ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
            }`}
            aria-pressed={compareMode}
          >
            <Columns className="h-4 w-4" /> Compare
          </button>
        </div>

        {/* Parameter list */}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-indigo-600" />
            <span className="ml-2 text-sm text-gray-500">Loading parameters...</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center">
            <Shield className="mx-auto mb-2 h-8 w-8 text-gray-300" />
            <p className="text-sm text-gray-500">No parameters found</p>
            {searchQuery && (
              <p className="mt-1 text-xs text-gray-400">
                Try adjusting your search or filters
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map((param) => {
              const draft = draftItems.get(param.parameterName);
              return (
                <ParameterCard
                  key={param.id}
                  param={param}
                  isDraft={!!draft}
                  draftValue={draft?.newValue}
                  compareMode={compareMode}
                  onAddToDraft={handleAddToDraft}
                />
              );
            })}
          </div>
        )}

        <div className="mt-3 text-xs text-gray-400">
          Showing {filtered.length} of {definitions.length} parameters
        </div>
      </div>
    </div>
  );
}
