/**
 * DataTableConfig - Configuration panel for the DataTable widget.
 *
 * Allows operators to define table columns, each bound to a tag via
 * TagBrowser. Columns support configurable labels, widths, number
 * formats, and sortability. Additional settings control pagination,
 * header styling, and row color rules for alarm-driven highlighting.
 */

import React from 'react';
import { TagBrowser } from '../TagBrowser';

interface WidgetConfigProps {
  config: Record<string, unknown>;
  onChange: (updates: Record<string, unknown>) => void;
  deviceId?: string | null;
}

interface ColumnDef {
  tagName: string;
  label: string;
  width: number;
  format: string;
  sortable: boolean;
}

interface RowColorRule {
  tagName: string;
  min: number;
  max: number;
  color: string;
}

const FORMAT_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'integer', label: 'Integer' },
  { value: 'decimal1', label: '1 Decimal' },
  { value: 'decimal2', label: '2 Decimals' },
  { value: 'decimal3', label: '3 Decimals' },
  { value: 'percent', label: 'Percent' },
  { value: 'scientific', label: 'Scientific' },
];

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

const INPUT_CLS = 'w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500';
const SMALL_INPUT_CLS = 'w-full px-2 py-1 text-xs border border-gray-300 rounded';

export const DataTableConfig: React.FC<WidgetConfigProps> = ({ config, onChange, deviceId }) => {
  const columns = (config.columns ?? []) as ColumnDef[];
  const pageSize = (config.pageSize ?? 10) as number;
  const showPagination = (config.showPagination ?? true) as boolean;
  const showHeader = (config.showHeader ?? true) as boolean;
  const headerBgColor = (config.headerBgColor ?? '#1e293b') as string;
  const headerTextColor = (config.headerTextColor ?? '#ffffff') as string;
  const rowBgColor = (config.rowBgColor ?? '#ffffff') as string;
  const alternateRowColor = (config.alternateRowColor ?? '#f8fafc') as string;
  const fontSize = (config.fontSize ?? 12) as number;
  const rowColorRules = (config.rowColorRules ?? []) as RowColorRule[];

  /* ---------------------------------------------------------------- */
  /*  Column CRUD                                                      */
  /* ---------------------------------------------------------------- */

  const addColumn = () => {
    const newCol: ColumnDef = { tagName: '', label: '', width: 120, format: 'auto', sortable: true };
    onChange({ columns: [...columns, newCol] });
  };

  const updateColumn = (index: number, field: keyof ColumnDef, value: string | number | boolean) => {
    const updated = columns.map((c, i) =>
      i === index ? { ...c, [field]: value } : c,
    );
    onChange({ columns: updated });
  };

  const removeColumn = (index: number) => {
    onChange({ columns: columns.filter((_, i) => i !== index) });
  };

  /* ---------------------------------------------------------------- */
  /*  Row color rule CRUD                                              */
  /* ---------------------------------------------------------------- */

  const addRule = () => {
    const newRule: RowColorRule = { tagName: '', min: 0, max: 100, color: '#ef4444' };
    onChange({ rowColorRules: [...rowColorRules, newRule] });
  };

  const updateRule = (index: number, field: keyof RowColorRule, value: string | number) => {
    const updated = rowColorRules.map((r, i) =>
      i === index ? { ...r, [field]: value } : r,
    );
    onChange({ rowColorRules: updated });
  };

  const removeRule = (index: number) => {
    onChange({ rowColorRules: rowColorRules.filter((_, i) => i !== index) });
  };

  return (
    <div className="space-y-3">
      {/* Columns */}
      <div className="pt-1">
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs text-gray-500 font-medium">Columns</label>
          <button onClick={addColumn} className="text-xs text-cyan-600 hover:text-cyan-700">
            + Add Column
          </button>
        </div>
        <div className="space-y-3">
          {columns.map((col, i) => (
            <div key={i} className="p-2 border border-gray-200 rounded-lg bg-gray-50 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-gray-600">Column {i + 1}</span>
                <button onClick={() => removeColumn(i)} className="text-red-400 hover:text-red-600 text-xs px-1">
                  X
                </button>
              </div>

              {/* Tag binding */}
              <div>
                <label className="block text-xs text-gray-500 mb-1">Tag</label>
                <TagBrowser
                  deviceId={deviceId || null}
                  value={col.tagName}
                  onChange={(tagName) => updateColumn(i, 'tagName', tagName)}
                  placeholder="Select tag..."
                />
              </div>

              {/* Label */}
              <div>
                <label className="block text-xs text-gray-500 mb-1">Label</label>
                <input
                  type="text"
                  value={col.label}
                  onChange={(e) => updateColumn(i, 'label', e.target.value)}
                  placeholder="Column header..."
                  className={SMALL_INPUT_CLS}
                />
              </div>

              <div className="grid grid-cols-3 gap-1">
                {/* Width */}
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Width (px)</label>
                  <input
                    type="number"
                    min={40}
                    max={600}
                    value={col.width}
                    onChange={(e) => updateColumn(i, 'width', Number(e.target.value))}
                    className={SMALL_INPUT_CLS}
                  />
                </div>

                {/* Format */}
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Format</label>
                  <select
                    value={col.format}
                    onChange={(e) => updateColumn(i, 'format', e.target.value)}
                    className={SMALL_INPUT_CLS}
                  >
                    {FORMAT_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>

                {/* Sortable */}
                <div className="flex items-end pb-1">
                  <label className="flex items-center gap-1 text-xs text-gray-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={col.sortable}
                      onChange={(e) => updateColumn(i, 'sortable', e.target.checked)}
                      className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500"
                    />
                    Sort
                  </label>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Pagination */}
      <div className="pt-2 border-t border-gray-100">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Page Size</label>
            <select
              value={pageSize}
              onChange={(e) => onChange({ pageSize: Number(e.target.value) })}
              className={INPUT_CLS}
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>{size}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Font Size</label>
            <input
              type="number"
              min={8}
              max={20}
              value={fontSize}
              onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
              className={INPUT_CLS}
            />
          </div>
        </div>

        <div className="mt-2 space-y-2">
          <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={showPagination}
              onChange={(e) => onChange({ showPagination: e.target.checked })}
              className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500"
            />
            Show Pagination
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={showHeader}
              onChange={(e) => onChange({ showHeader: e.target.checked })}
              className="rounded border-gray-300 text-cyan-600 focus:ring-cyan-500"
            />
            Show Header
          </label>
        </div>
      </div>

      {/* Colors */}
      <div className="pt-2 border-t border-gray-100">
        <label className="text-xs text-gray-500 font-medium mb-2 block">Colors</label>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Header BG</label>
            <input
              type="color"
              value={headerBgColor}
              onChange={(e) => onChange({ headerBgColor: e.target.value })}
              className="w-full h-8 border border-gray-300 rounded cursor-pointer"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Header Text</label>
            <input
              type="color"
              value={headerTextColor}
              onChange={(e) => onChange({ headerTextColor: e.target.value })}
              className="w-full h-8 border border-gray-300 rounded cursor-pointer"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Row BG</label>
            <input
              type="color"
              value={rowBgColor}
              onChange={(e) => onChange({ rowBgColor: e.target.value })}
              className="w-full h-8 border border-gray-300 rounded cursor-pointer"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Alt Row</label>
            <input
              type="color"
              value={alternateRowColor}
              onChange={(e) => onChange({ alternateRowColor: e.target.value })}
              className="w-full h-8 border border-gray-300 rounded cursor-pointer"
            />
          </div>
        </div>
      </div>

      {/* Row Color Rules */}
      <div className="pt-2 border-t border-gray-100">
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs text-gray-500 font-medium">Row Color Rules</label>
          <button onClick={addRule} className="text-xs text-cyan-600 hover:text-cyan-700">
            + Add Rule
          </button>
        </div>
        <div className="space-y-2">
          {rowColorRules.map((rule, i) => (
            <div key={i} className="flex items-center gap-1">
              <input
                type="text"
                value={rule.tagName}
                onChange={(e) => updateRule(i, 'tagName', e.target.value)}
                className="w-20 px-2 py-1 text-xs border border-gray-300 rounded"
                placeholder="Tag"
              />
              <input
                type="number"
                value={rule.min}
                onChange={(e) => updateRule(i, 'min', Number(e.target.value))}
                className="w-14 px-2 py-1 text-xs border border-gray-300 rounded"
                placeholder="Min"
              />
              <input
                type="number"
                value={rule.max}
                onChange={(e) => updateRule(i, 'max', Number(e.target.value))}
                className="w-14 px-2 py-1 text-xs border border-gray-300 rounded"
                placeholder="Max"
              />
              <input
                type="color"
                value={rule.color}
                onChange={(e) => updateRule(i, 'color', e.target.value)}
                className="w-8 h-7 border border-gray-300 rounded cursor-pointer"
              />
              <button onClick={() => removeRule(i)} className="text-red-400 hover:text-red-600 text-xs px-1">
                X
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
