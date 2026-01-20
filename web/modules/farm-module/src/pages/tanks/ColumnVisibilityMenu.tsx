/**
 * Column Visibility Menu Component
 * Dropdown menu for toggling column visibility with group support
 */
import React, { useState, useRef, useEffect } from 'react';
import { TankColumn } from './types';
import { columnGroups, getColumnsByGroup } from './columns';

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
      !allVisible
    );
  };

  return (
    <div className="relative" ref={menuRef}>
      {/* Toggle Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
      >
        <svg
          className="w-5 h-5 text-gray-500"
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
          Columns ({visibleColumns.size}/{columns.length})
        </span>
        <svg
          className={`w-4 h-4 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div className="absolute right-0 mt-2 w-72 bg-white rounded-lg shadow-xl border border-gray-200 z-50 max-h-[70vh] overflow-hidden flex flex-col">
          {/* Header */}
          <div className="p-3 border-b border-gray-200 bg-gray-50">
            <div className="flex justify-between items-center">
              <span className="text-sm font-semibold text-gray-700">Show Columns</span>
              <div className="flex gap-2">
                <button
                  onClick={onShowAll}
                  className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                >
                  Show All
                </button>
                <span className="text-gray-300">|</span>
                <button
                  onClick={onReset}
                  className="text-xs text-gray-600 hover:text-gray-800 font-medium"
                >
                  Reset
                </button>
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
                <div key={group.key} className="border-b border-gray-100 last:border-b-0">
                  {/* Group Header */}
                  <div
                    className="flex items-center gap-2 px-3 py-2 bg-gray-50 cursor-pointer hover:bg-gray-100"
                    onClick={() => handleGroupToggle(group.key)}
                  >
                    <input
                      type="checkbox"
                      checked={isFullyVisible}
                      ref={(el) => {
                        if (el) el.indeterminate = isPartiallyVisible;
                      }}
                      onChange={() => handleGroupToggle(group.key)}
                      className="h-4 w-4 text-blue-600 rounded border-gray-300 cursor-pointer"
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span className="text-sm font-medium text-gray-700">{group.label}</span>
                    <span className="text-xs text-gray-400 ml-auto">
                      {groupCols.filter((c) => visibleColumns.has(c.key)).length}/{groupCols.length}
                    </span>
                  </div>

                  {/* Group Columns */}
                  <div className="py-1">
                    {groupCols.map((col) => (
                      <label
                        key={col.key}
                        className="flex items-center gap-2 px-4 py-1.5 hover:bg-gray-50 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={visibleColumns.has(col.key)}
                          onChange={() => onToggle(col.key)}
                          className="h-4 w-4 text-blue-600 rounded border-gray-300"
                        />
                        <span className="text-sm text-gray-600">{col.header}</span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Footer */}
          <div className="p-2 border-t border-gray-200 bg-gray-50">
            <p className="text-xs text-gray-500 text-center">
              Settings are saved automatically
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

export default ColumnVisibilityMenu;
