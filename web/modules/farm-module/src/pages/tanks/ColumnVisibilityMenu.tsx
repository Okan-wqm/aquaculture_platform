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
import { useI18n, type MessageKey } from '@aquaculture/shared-ui';
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
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 border border-gray-300 bg-white px-4 py-2.5 transition-colors hover:bg-gray-50"
      >
        <svg
          className="h-5 w-5 text-gray-500"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"
          />
        </svg>
        <span className="text-sm font-medium text-gray-700">
          {t('tanksV2.menu.columns', { shown: visibleColumns.size, total: columns.length })}
        </span>
        <svg
          className={`h-4 w-4 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div className="absolute right-0 z-50 mt-2 flex max-h-[70vh] w-72 flex-col overflow-hidden border border-gray-200 bg-white shadow-xl">
          {/* Header */}
          <div className="border-b border-gray-200 bg-gray-50 p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-gray-700">
                {t('tanksV2.menu.showColumns')}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={onShowAll}
                  className="text-xs font-medium text-blue-600 hover:text-blue-800"
                >
                  {t('tanksV2.menu.showAll')}
                </button>
                <span className="text-gray-300">|</span>
                <button
                  onClick={onReset}
                  className="text-xs font-medium text-gray-600 hover:text-gray-800"
                >
                  {t('tanksV2.menu.reset')}
                </button>
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
                    className="flex cursor-pointer items-center gap-2 bg-gray-50 px-3 py-2 hover:bg-gray-100"
                    onClick={() => handleGroupToggle(group.key)}
                  >
                    <input
                      type="checkbox"
                      checked={isFullyVisible}
                      ref={(el) => {
                        if (el) el.indeterminate = isPartiallyVisible;
                      }}
                      onChange={() => handleGroupToggle(group.key)}
                      className="h-4 w-4 cursor-pointer rounded border-gray-300 text-blue-600"
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
                        className="flex cursor-pointer items-center gap-2 px-4 py-1.5 hover:bg-gray-50"
                      >
                        <input
                          type="checkbox"
                          checked={visibleColumns.has(col.key)}
                          onChange={() => onToggle(col.key)}
                          className="h-4 w-4 rounded border-gray-300 text-blue-600"
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
          <div className="border-t border-gray-200 bg-gray-50 p-2">
            <p className="text-center text-xs text-gray-500">{t('tanksV2.menu.saved')}</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default ColumnVisibilityMenu;
