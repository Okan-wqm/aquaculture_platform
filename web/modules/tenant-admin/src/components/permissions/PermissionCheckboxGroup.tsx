/**
 * PermissionCheckboxGroup Component
 *
 * A matrix-style permission editor that displays categories, resources, and actions
 * as checkboxes for granular permission control.
 *
 * Accessibility features:
 * - ARIA attributes for checkboxes (aria-checked)
 * - ARIA attributes for accordions (aria-expanded, aria-controls)
 * - Keyboard navigation support
 * - Screen reader friendly labels
 */

import React, { useState, useCallback, useMemo, useId } from 'react';
import { Button, useI18n } from '@aquaculture/shared-ui';
import {
  ChevronDown,
  ChevronRight,
  Shield,
  Check,
  Minus,
  Building2,
  Users,
  Beaker,
  Activity,
  Wrench,
  BarChart3,
  Settings,
} from 'lucide-react';
import type { PermissionCategory, PanelPermissions } from '../../services/tenant-api.service';

// ============================================================================
// Types
// ============================================================================

interface PermissionCheckboxGroupProps {
  categories: PermissionCategory[];
  value: PanelPermissions;
  onChange: (value: PanelPermissions) => void;
  disabled?: boolean;
  readOnly?: boolean;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get icon for category
 */
const getCategoryIcon = (categoryKey: string) => {
  const icons: Record<string, React.ReactNode> = {
    farm: <Building2 className="w-4 h-4" />,
    production: <Beaker className="w-4 h-4" />,
    operations: <Activity className="w-4 h-4" />,
    hr: <Users className="w-4 h-4" />,
    maintenance: <Wrench className="w-4 h-4" />,
    reports: <BarChart3 className="w-4 h-4" />,
    settings: <Settings className="w-4 h-4" />,
  };
  return icons[categoryKey] || <Shield className="w-4 h-4" />;
};

/**
 * Format action name for display
 */
const formatActionName = (action: string): string => {
  return action
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

/**
 * Format resource name for display
 */
const formatResourceName = (resource: string): string => {
  return resource
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

// ============================================================================
// Sub-Components
// ============================================================================

interface ActionCheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  readOnly?: boolean;
}

const ActionCheckbox = React.memo<ActionCheckboxProps>(
  ({ checked, onChange, label, disabled, readOnly }) => {
    return (
      <label
        className={`
        inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium
        transition-all duration-150
        ${
          disabled || readOnly
            ? 'cursor-not-allowed opacity-60'
            : 'cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700'
        }
        ${checked ? 'text-success-700 dark:text-success-300' : 'text-gray-500 dark:text-gray-400'}
      `}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => !disabled && !readOnly && onChange(e.target.checked)}
          disabled={disabled || readOnly}
          className="sr-only"
        />
        <span
          className={`
          flex items-center justify-center w-4 h-4 rounded border transition-all
          ${
            checked
              ? 'bg-success-600 border-success-600'
              : 'bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-600'
          }
          ${!disabled && !readOnly && !checked ? 'group-hover:border-success-400' : ''}
        `}
        >
          {checked && <Check className="w-3 h-3 text-white" />}
        </span>
        <span>{label}</span>
      </label>
    );
  },
);
ActionCheckbox.displayName = 'ActionCheckbox';

interface ResourceRowProps {
  categoryKey: string;
  resource: { name: string; actions: string[] };
  permissions: Record<string, boolean>;
  onChange: (resourceName: string, action: string, value: boolean) => void;
  onSelectAll: (resourceName: string, selected: boolean) => void;
  disabled?: boolean;
  readOnly?: boolean;
}

const ResourceRow = React.memo<ResourceRowProps>(
  ({
    categoryKey: _categoryKey,
    resource,
    permissions,
    onChange,
    onSelectAll,
    disabled,
    readOnly,
  }) => {
    const allSelected = resource.actions.every((action) => permissions[action] === true);
    const someSelected =
      resource.actions.some((action) => permissions[action] === true) && !allSelected;

    return (
      <div className="flex items-center py-2 px-3 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-lg transition-colors group">
        {/* Resource Name with Select All */}
        <div className="w-40 flex items-center gap-2">
          <button
            type="button"
            role="checkbox"
            aria-checked={allSelected ? 'true' : someSelected ? 'mixed' : 'false'}
            aria-label={`Select all ${formatResourceName(resource.name)} permissions`}
            onClick={() => !disabled && !readOnly && onSelectAll(resource.name, !allSelected)}
            disabled={disabled || readOnly}
            className={`
            flex items-center justify-center w-5 h-5 rounded border transition-all
            focus:outline-hidden focus:ring-2 focus:ring-success-500
            ${disabled || readOnly ? 'cursor-not-allowed' : 'cursor-pointer'}
            ${
              allSelected
                ? 'bg-success-600 border-success-600'
                : someSelected
                  ? 'bg-success-100 dark:bg-success-900/40 border-success-400'
                  : 'bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-600 hover:border-success-400'
            }
          `}
          >
            {allSelected && <Check className="w-3 h-3 text-white" aria-hidden="true" />}
            {someSelected && (
              <Minus
                className="w-3 h-3 text-success-600 dark:text-success-400"
                aria-hidden="true"
              />
            )}
          </button>
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {formatResourceName(resource.name)}
          </span>
        </div>

        {/* Actions */}
        <div className="flex-1 flex flex-wrap gap-1">
          {resource.actions.map((action) => (
            <ActionCheckbox
              key={action}
              checked={permissions[action] === true}
              onChange={(value) => onChange(resource.name, action, value)}
              label={formatActionName(action)}
              disabled={disabled}
              readOnly={readOnly}
            />
          ))}
        </div>
      </div>
    );
  },
);
ResourceRow.displayName = 'ResourceRow';

interface CategoryAccordionProps {
  category: PermissionCategory;
  permissions: Record<string, Record<string, boolean>>;
  onChange: (resourceName: string, action: string, value: boolean) => void;
  onSelectAllResource: (resourceName: string, selected: boolean) => void;
  onSelectAllCategory: (selected: boolean) => void;
  disabled?: boolean;
  readOnly?: boolean;
  defaultExpanded?: boolean;
}

const CategoryAccordion = React.memo<CategoryAccordionProps>(
  ({
    category,
    permissions,
    onChange,
    onSelectAllResource,
    onSelectAllCategory,
    disabled,
    readOnly,
    defaultExpanded = true,
  }) => {
    const [isExpanded, setIsExpanded] = useState(defaultExpanded);
    const contentId = useId();

    // Calculate category-level selection state
    const allResourcesSelected = category.resources.every((resource) =>
      resource.actions.every((action) => permissions[resource.name]?.[action] === true),
    );
    const someResourcesSelected =
      category.resources.some((resource) =>
        resource.actions.some((action) => permissions[resource.name]?.[action] === true),
      ) && !allResourcesSelected;

    // Count selected permissions
    const totalPermissions = category.resources.reduce((sum, r) => sum + r.actions.length, 0);
    const selectedPermissions = category.resources.reduce(
      (sum, r) => sum + r.actions.filter((a) => permissions[r.name]?.[a] === true).length,
      0,
    );

    return (
      <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden bg-white dark:bg-gray-900">
        {/* Category Header.
          RBAC-MEDIUM-007 (M16): the select-all used to be a click-only
          <span role="checkbox"> NESTED inside the expand <button> — invalid
          interactive-inside-interactive (WCAG 4.1.2) and unreachable by
          keyboard (WCAG 2.1.1). It is now a real sibling <button
          role="checkbox">, so Tab reaches it and Space/Enter toggle natively;
          the expand trigger is its own button covering the rest of the row. */}
        <div className="w-full flex items-center gap-3 px-4 py-3 bg-gradient-to-r from-gray-50 to-white">
          <button
            type="button"
            role="checkbox"
            aria-checked={allResourcesSelected ? 'true' : someResourcesSelected ? 'mixed' : 'false'}
            aria-label={`Select all permissions in ${category.name}`}
            disabled={disabled || readOnly}
            onClick={() => onSelectAllCategory(!allResourcesSelected)}
            className={`
            flex items-center justify-center w-5 h-5 rounded border transition-all
            focus:outline-hidden focus:ring-2 focus:ring-success-500
            ${disabled || readOnly ? 'cursor-not-allowed' : 'cursor-pointer'}
            ${
              allResourcesSelected
                ? 'bg-success-600 border-success-600'
                : someResourcesSelected
                  ? 'bg-success-100 dark:bg-success-900/40 border-success-400'
                  : 'bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-600 hover:border-success-400'
            }
          `}
          >
            {allResourcesSelected && <Check className="w-3 h-3 text-white" aria-hidden="true" />}
            {someResourcesSelected && (
              <Minus
                className="w-3 h-3 text-success-600 dark:text-success-400"
                aria-hidden="true"
              />
            )}
          </button>
          <Button
            variant="ghost"
            className="flex-1"
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            aria-expanded={isExpanded}
            aria-controls={contentId}
          >
            <span className="flex items-center gap-3">
              <span
                className="flex items-center gap-2 text-gray-600 dark:text-gray-400"
                aria-hidden="true"
              >
                {getCategoryIcon(category.categoryKey)}
              </span>
              <span className="font-semibold text-gray-900 dark:text-gray-100">
                {category.name}
              </span>
              <span className="text-xs text-gray-500 dark:text-gray-400">
                ({selectedPermissions}/{totalPermissions})
              </span>
            </span>
            <span className="flex items-center gap-2" aria-hidden="true">
              {isExpanded ? (
                <ChevronDown className="w-5 h-5 text-gray-500 dark:text-gray-400" />
              ) : (
                <ChevronRight className="w-5 h-5 text-gray-500 dark:text-gray-400" />
              )}
            </span>
          </Button>
        </div>

        {/* Category Content */}
        {isExpanded && (
          <div
            id={contentId}
            role="region"
            aria-label={`${category.name} permissions`}
            className="border-t border-gray-100 dark:border-gray-700 divide-y divide-gray-50"
          >
            {category.resources.map((resource) => (
              <ResourceRow
                key={resource.name}
                categoryKey={category.categoryKey}
                resource={resource}
                permissions={permissions[resource.name] || {}}
                onChange={onChange}
                onSelectAll={onSelectAllResource}
                disabled={disabled}
                readOnly={readOnly}
              />
            ))}
          </div>
        )}
      </div>
    );
  },
);
CategoryAccordion.displayName = 'CategoryAccordion';

// ============================================================================
// Main Component
// ============================================================================

export const PermissionCheckboxGroup: React.FC<PermissionCheckboxGroupProps> = ({
  categories,
  value,
  onChange,
  disabled = false,
  readOnly = false,
}) => {
  const { t } = useI18n();
  // Handler for individual permission change
  const handlePermissionChange = useCallback(
    (categoryKey: string, resourceName: string, action: string, checked: boolean) => {
      const newValue = { ...value };

      // Ensure category exists
      if (!newValue[categoryKey]) {
        newValue[categoryKey] = {};
      }

      // Ensure resource exists
      if (!newValue[categoryKey][resourceName]) {
        newValue[categoryKey][resourceName] = {};
      }

      // Update permission
      newValue[categoryKey][resourceName][action] = checked;

      onChange(newValue);
    },
    [value, onChange],
  );

  // Handler for select all in a resource
  const handleSelectAllResource = useCallback(
    (categoryKey: string, resourceName: string, actions: string[], selected: boolean) => {
      const newValue = { ...value };

      if (!newValue[categoryKey]) {
        newValue[categoryKey] = {};
      }

      if (!newValue[categoryKey][resourceName]) {
        newValue[categoryKey][resourceName] = {};
      }

      actions.forEach((action) => {
        newValue[categoryKey][resourceName][action] = selected;
      });

      onChange(newValue);
    },
    [value, onChange],
  );

  // Handler for select all in a category
  const handleSelectAllCategory = useCallback(
    (category: PermissionCategory, selected: boolean) => {
      const newValue = { ...value };
      const categoryKey = category.categoryKey;

      if (!newValue[categoryKey]) {
        newValue[categoryKey] = {};
      }

      category.resources.forEach((resource) => {
        if (!newValue[categoryKey][resource.name]) {
          newValue[categoryKey][resource.name] = {};
        }
        resource.actions.forEach((action) => {
          newValue[categoryKey][resource.name][action] = selected;
        });
      });

      onChange(newValue);
    },
    [value, onChange],
  );

  // Handler for select all globally
  const handleSelectAll = useCallback(
    (selected: boolean) => {
      const newValue: PanelPermissions = {};

      categories.forEach((category) => {
        newValue[category.categoryKey] = {};
        category.resources.forEach((resource) => {
          newValue[category.categoryKey][resource.name] = {};
          resource.actions.forEach((action) => {
            newValue[category.categoryKey][resource.name][action] = selected;
          });
        });
      });

      onChange(newValue);
    },
    [categories, onChange],
  );

  // Calculate global selection state
  const { allSelected, someSelected, totalCount, selectedCount } = useMemo(() => {
    let total = 0;
    let selected = 0;

    categories.forEach((category) => {
      category.resources.forEach((resource) => {
        resource.actions.forEach((action) => {
          total++;
          if (value[category.categoryKey]?.[resource.name]?.[action] === true) {
            selected++;
          }
        });
      });
    });

    return {
      totalCount: total,
      selectedCount: selected,
      allSelected: total > 0 && selected === total,
      someSelected: selected > 0 && selected < total,
    };
  }, [categories, value]);

  return (
    <div className="space-y-4">
      {/* Global Select All */}
      <div className="flex items-center justify-between px-4 py-3 bg-success-50 dark:bg-success-900/20 rounded-xl border border-success-100 dark:border-success-800">
        <div className="flex items-center gap-3">
          <button
            aria-label={t('a11y.selectAll')}
            type="button"
            role="checkbox"
            aria-checked={allSelected ? true : someSelected ? 'mixed' : false}
            onClick={() => !disabled && !readOnly && handleSelectAll(!allSelected)}
            disabled={disabled || readOnly}
            className={`
              flex items-center justify-center w-6 h-6 rounded-md border-2 transition-all
              ${disabled || readOnly ? 'cursor-not-allowed' : 'cursor-pointer'}
              ${
                allSelected
                  ? 'bg-success-600 border-success-600'
                  : someSelected
                    ? 'bg-success-100 dark:bg-success-900/40 border-success-400'
                    : 'bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-600 hover:border-success-400'
              }
            `}
          >
            {allSelected && <Check className="w-4 h-4 text-white" />}
            {someSelected && <Minus className="w-4 h-4 text-success-600 dark:text-success-400" />}
          </button>
          <div>
            <span className="font-semibold text-gray-900 dark:text-gray-100">All Permissions</span>
            <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">
              ({selectedCount}/{totalCount} selected)
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="xs"
            type="button"
            onClick={() => handleSelectAll(true)}
            disabled={disabled || readOnly}
          >
            Select All
          </Button>
          <Button
            variant="secondary"
            size="xs"
            type="button"
            onClick={() => handleSelectAll(false)}
            disabled={disabled || readOnly}
          >
            Clear All
          </Button>
        </div>
      </div>

      {/* Categories */}
      <div className="space-y-3">
        {categories.map((category) => (
          <CategoryAccordion
            key={category.categoryKey}
            category={category}
            permissions={value[category.categoryKey] || {}}
            onChange={(resourceName, action, checked) =>
              handlePermissionChange(category.categoryKey, resourceName, action, checked)
            }
            onSelectAllResource={(resourceName, selected) => {
              const resource = category.resources.find((r) => r.name === resourceName);
              if (resource) {
                handleSelectAllResource(
                  category.categoryKey,
                  resourceName,
                  resource.actions,
                  selected,
                );
              }
            }}
            onSelectAllCategory={(selected) => handleSelectAllCategory(category, selected)}
            disabled={disabled}
            readOnly={readOnly}
          />
        ))}
      </div>
    </div>
  );
};

export default PermissionCheckboxGroup;
