/**
 * Column Visibility Menu Component
 * Dropdown menu for toggling column visibility with group support
 */
import React, { useState, useRef, useEffect } from 'react';
import { Button } from '@aquaculture/shared-ui';
import { TankColumn } from './types';
import { columnGroups, getColumnsByGroup } from './columns';
import { ChevronDown, Columns3 } from 'lucide-react';

interface ColumnVisibilityMenuProps {
  columns: TankColumn[];
  visibleColumns: Set<string>;
  onToggle: (key: string) => void;
  onToggleGroup: (groupColumns: string[], visible: boolean) => void;
  onReset: () => void;
  onShowAll: () => void;
}

export const ColumnVisibilityMenu: React.FC<ColumnVisibilityMenuProps> = ({
  columns,
  visibleColumns,
  onToggle,
  onToggleGroup,
  onReset,
  onShowAll,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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
    const groupCols = getColumnsByGroup(group);
    return groupCols.every((col) => visibleColumns.has(col.key));
  };

  // Check if any column in a group is visible
  const isGroupPartiallyVisible = (group: string): boolean => {
    const groupCols = getColumnsByGroup(group);
    const visibleInGroup = groupCols.filter((col) => visibleColumns.has(col.key));
    return visibleInGroup.length > 0 && visibleInGroup.length < groupCols.length;
  };

  // Toggle all columns in a group
  const handleGroupToggle = (group: string) => {
    const groupCols = getColumnsByGroup(group);
    const allVisible = isGroupFullyVisible(group);
    onToggleGroup(
      groupCols.map((c) => c.key),
      !allVisible,
    );
  };

  return (
    <div className="relative" ref={menuRef}>
      {/* Toggle Button */}
      <Button variant="secondary" onClick={() => setIsOpen(!isOpen)}>
        <Columns3 className="w-5 h-5 text-gray-500 dark:text-gray-400" aria-hidden="true" />
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Columns ({visibleColumns.size}/{columns.length})
        </span>
        <ChevronDown
          className={`w-4 h-4 text-gray-400 dark:text-gray-500 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </Button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div className="absolute right-0 mt-2 w-72 bg-white dark:bg-gray-900 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 z-50 max-h-[70vh] overflow-hidden flex flex-col">
          {/* Header */}
          <div className="p-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
            <div className="flex justify-between items-center">
              <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                Show Columns
              </span>
              <div className="flex gap-2">
                <Button variant="ghost" size="xs" onClick={onShowAll}>
                  Show All
                </Button>
                <span className="text-gray-300">|</span>
                <Button variant="ghost" size="xs" onClick={onReset}>
                  Reset
                </Button>
              </div>
            </div>
          </div>

          {/* Column Groups */}
          <div className="overflow-y-auto flex-1">
            {columnGroups.map((group) => {
              const groupCols = getColumnsByGroup(group.key);
              const isFullyVisible = isGroupFullyVisible(group.key);
              const isPartiallyVisible = isGroupPartiallyVisible(group.key);

              return (
                <div
                  key={group.key}
                  className="border-b border-gray-100 dark:border-gray-700 last:border-b-0"
                >
                  {/* Group Header */}
                  <div
                    className="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-800 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => handleGroupToggle(group.key)}
                  >
                    <input
                      type="checkbox"
                      checked={isFullyVisible}
                      ref={(el) => {
                        if (el) el.indeterminate = isPartiallyVisible;
                      }}
                      onChange={() => handleGroupToggle(group.key)}
                      className="h-4 w-4 text-info-600 rounded border-gray-300 dark:border-gray-600 cursor-pointer"
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                      {group.label}
                    </span>
                    <span className="text-xs text-gray-400 dark:text-gray-500 ml-auto">
                      {groupCols.filter((c) => visibleColumns.has(c.key)).length}/{groupCols.length}
                    </span>
                  </div>

                  {/* Group Columns */}
                  <div className="py-1">
                    {groupCols.map((col) => (
                      <label
                        key={col.key}
                        className="flex items-center gap-2 px-4 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={visibleColumns.has(col.key)}
                          onChange={() => onToggle(col.key)}
                          className="h-4 w-4 text-info-600 rounded border-gray-300 dark:border-gray-600"
                        />
                        <span className="text-sm text-gray-600 dark:text-gray-400">
                          {col.header}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Footer */}
          <div className="p-2 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
            <p className="text-xs text-gray-500 dark:text-gray-400 text-center">
              Settings are saved automatically
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

export default ColumnVisibilityMenu;
