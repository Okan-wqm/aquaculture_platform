/**
 * Column Visibility Menu Component
 * Dropdown menu for toggling column visibility with group support.
 *
 * Groups are derived from the `columns` prop (optionally reordered/labelled
 * through `groups`), and every label — group or column — is an i18n message
 * key translated here, so the menu serves the production tank table (30
 * columns), the cleaner-fish table, and any other column model.
 */
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Button, Checkbox, useI18n, type MessageKey } from '@aquaculture/shared-ui';
import { ChevronDown, Columns3 } from 'lucide-react';
import { TankColumn } from './types';
import { columnGroups } from './columns';

interface ColumnVisibilityMenuProps {
  columns: TankColumn[];
  visibleColumns: Set<string>;
  onToggle: (key: string) => void;
  onToggleGroup: (groupColumns: string[], visible: boolean) => void;
  onReset: () => void;
  onShowAll: () => void;
  /** Ordered group key → label-key map; defaults to the tank-column groups. */
  groups?: { key: string; label: MessageKey }[];
}

export const ColumnVisibilityMenu: React.FC<ColumnVisibilityMenuProps> = ({
  columns,
  visibleColumns,
  onToggle,
  onToggleGroup,
  onReset,
  onShowAll,
  groups = columnGroups,
}) => {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Only groups that actually have columns in this model, in `groups` order.
  const activeGroups = useMemo(
    () => groups.filter((g) => columns.some((col) => col.group === g.key)),
    [columns, groups],
  );

  const columnsOfGroup = (group: string): TankColumn[] =>
    columns.filter((col) => col.group === group);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // Check if all columns in a group are visible
  const isGroupFullyVisible = (group: string): boolean => {
    const groupCols = columnsOfGroup(group);
    return groupCols.every((col) => visibleColumns.has(col.key));
  };

  // Check if any column in a group is visible
  const isGroupPartiallyVisible = (group: string): boolean => {
    const groupCols = columnsOfGroup(group);
    const visibleInGroup = groupCols.filter((col) => visibleColumns.has(col.key));
    return visibleInGroup.length > 0 && visibleInGroup.length < groupCols.length;
  };

  // Toggle all columns in a group
  const handleGroupToggle = (group: string) => {
    const groupCols = columnsOfGroup(group);
    const allVisible = isGroupFullyVisible(group);
    onToggleGroup(
      groupCols.map((c) => c.key),
      !allVisible,
    );
  };

  return (
    <div className="relative" ref={menuRef}>
      {/* Toggle Button */}
      <Button
        variant="secondary"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-4 py-2.5"
      >
        <Columns3 className="h-5 w-5 text-gray-500" aria-hidden="true" />
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('tanksV2.menu.columns', { shown: visibleColumns.size, total: columns.length })}
        </span>
        <ChevronDown
          className={`h-4 w-4 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </Button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div className="absolute right-0 z-50 mt-2 flex max-h-[70vh] w-72 flex-col overflow-hidden border border-gray-200 bg-white shadow-(--shadow-sd-lg) dark:border-gray-700 dark:bg-gray-900">
          {/* Header */}
          <div className="border-b border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-gray-700">
                {t('tanksV2.menu.showColumns')}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onShowAll}
                  className="text-xs font-medium"
                >
                  {t('tanksV2.menu.showAll')}
                </Button>
                <span className="text-gray-300">|</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onReset}
                  className="text-xs font-medium text-gray-600 dark:text-gray-300"
                >
                  {t('tanksV2.menu.reset')}
                </Button>
              </div>
            </div>
          </div>

          {/* Column Groups */}
          <div className="flex-1 overflow-y-auto">
            {activeGroups.map((group) => {
              const groupCols = columnsOfGroup(group.key);
              const isFullyVisible = isGroupFullyVisible(group.key);
              const isPartiallyVisible = isGroupPartiallyVisible(group.key);

              return (
                <div key={group.key} className="border-b border-gray-100 last:border-b-0">
                  {/* Group Header */}
                  <div
                    className="flex cursor-pointer items-center gap-2 bg-gray-50 px-3 py-2 hover:bg-gray-100 dark:bg-gray-800 dark:hover:bg-gray-700"
                    onClick={() => handleGroupToggle(group.key)}
                  >
                    <Checkbox
                      checked={isFullyVisible}
                      ref={(el) => {
                        if (el) el.indeterminate = isPartiallyVisible;
                      }}
                      onChange={() => handleGroupToggle(group.key)}
                      className="cursor-pointer"
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span className="text-sm font-medium text-gray-700">{t(group.label)}</span>
                    <span className="ml-auto text-xs text-gray-400">
                      {groupCols.filter((c) => visibleColumns.has(c.key)).length}/{groupCols.length}
                    </span>
                  </div>

                  {/* Group Columns */}
                  <div className="py-1">
                    {groupCols.map((col) => (
                      <label
                        key={col.key}
                        className="flex cursor-pointer items-center gap-2 px-4 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-800"
                      >
                        <Checkbox
                          checked={visibleColumns.has(col.key)}
                          onChange={() => onToggle(col.key)}
                        />
                        <span className="text-sm text-gray-600">{t(col.header)}</span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Footer */}
          <div className="border-t border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-800">
            <p className="text-center text-xs text-gray-500">{t('tanksV2.menu.saved')}</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default ColumnVisibilityMenu;
