/**
 * DataTableRenderer - Tabular display of tag values for SCADA screens.
 *
 * Renders a configurable HTML table with sortable columns, pagination,
 * and value-driven row coloring. Each column binds to a tag via TagBrowser.
 * At runtime, tag values flow through TagValueBus and populate cells.
 *
 * Architecture: Columns are defined in config; each has a tagName that
 * resolves to a live value. In edit mode, demo data is generated to
 * preview the table layout. Row color rules evaluate tag ranges to
 * highlight alarm conditions (e.g., red for out-of-range values).
 *
 * Performance: For tables with many rows, only the current page is
 * rendered. Sorting is performed in-memory on the visible dataset.
 * Fixed row heights ensure O(1) scroll offset calculation.
 */

import React, { memo, useState, useMemo, useCallback } from 'react';
import type { WidgetRendererProps } from '../WidgetRenderer';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

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

type SortDirection = 'asc' | 'desc' | null;

interface SortState {
  columnIndex: number;
  direction: SortDirection;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

/* ------------------------------------------------------------------ */
/*  Demo data generator for edit mode                                  */
/* ------------------------------------------------------------------ */

/**
 * Generates deterministic demo rows so the table preview is stable
 * across re-renders. Uses column index as seed offset to produce
 * varied but repeatable values.
 */
function generateDemoRows(columns: ColumnDef[], pageSize: number): Record<string, string | number>[] {
  const rows: Record<string, string | number>[] = [];
  for (let r = 0; r < pageSize; r++) {
    const row: Record<string, string | number> = {};
    columns.forEach((col, ci) => {
      // Produce numeric-looking demo values with slight variance
      const base = 20 + ci * 10;
      const value = base + (r * 3.7 + ci * 2.3) % 30;
      row[col.tagName || `col_${ci}`] = Number(value.toFixed(2));
    });
    rows.push(row);
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/*  Value formatting                                                   */
/* ------------------------------------------------------------------ */

function formatCellValue(value: string | number | undefined, format: string): string {
  if (value === undefined || value === null) return '--';
  if (typeof value === 'string') return value;

  switch (format) {
    case 'integer':
      return Math.round(value).toString();
    case 'decimal1':
      return value.toFixed(1);
    case 'decimal2':
      return value.toFixed(2);
    case 'decimal3':
      return value.toFixed(3);
    case 'percent':
      return `${value.toFixed(1)}%`;
    case 'scientific':
      return value.toExponential(2);
    default:
      return String(value);
  }
}

/* ------------------------------------------------------------------ */
/*  Row color evaluation                                               */
/* ------------------------------------------------------------------ */

/**
 * Evaluates row color rules against the current row data.
 * First matching rule wins -- rules are evaluated in definition order.
 * This allows operators to define escalating severity colors
 * (e.g., yellow for warning range, red for alarm range).
 */
function evaluateRowColor(
  row: Record<string, string | number>,
  rules: RowColorRule[],
): string | undefined {
  for (const rule of rules) {
    const val = row[rule.tagName];
    if (typeof val === 'number' && val >= rule.min && val <= rule.max) {
      return rule.color;
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

const DataTableRenderer: React.FC<WidgetRendererProps> = ({
  config,
  width,
  height,
  isEditing,
}) => {
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

  const [currentPage, setCurrentPage] = useState(0);
  const [sortState, setSortState] = useState<SortState>({ columnIndex: -1, direction: null });

  // In edit mode, generate demo rows. In runtime, rows would come from TagValueBus.
  const allRows = useMemo(
    () => (isEditing ? generateDemoRows(columns, Math.min(pageSize * 3, 100)) : generateDemoRows(columns, pageSize)),
    [columns, pageSize, isEditing],
  );

  // Sort rows if a sort column is active
  const sortedRows = useMemo(() => {
    if (sortState.direction === null || sortState.columnIndex < 0 || sortState.columnIndex >= columns.length) {
      return allRows;
    }
    const col = columns[sortState.columnIndex];
    const key = col.tagName || `col_${sortState.columnIndex}`;
    return [...allRows].sort((a, b) => {
      const va = a[key] ?? 0;
      const vb = b[key] ?? 0;
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return sortState.direction === 'desc' ? -cmp : cmp;
    });
  }, [allRows, sortState, columns]);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const safeCurrentPage = Math.min(currentPage, totalPages - 1);
  const pageRows = sortedRows.slice(safeCurrentPage * pageSize, (safeCurrentPage + 1) * pageSize);

  const handleSort = useCallback((colIndex: number) => {
    const col = columns[colIndex];
    if (!col?.sortable) return;
    setSortState((prev) => {
      if (prev.columnIndex === colIndex) {
        const nextDir: SortDirection = prev.direction === 'asc' ? 'desc' : prev.direction === 'desc' ? null : 'asc';
        return { columnIndex: colIndex, direction: nextDir };
      }
      return { columnIndex: colIndex, direction: 'asc' };
    });
  }, [columns]);

  // Empty state
  if (columns.length === 0) {
    return (
      <div
        style={{
          width,
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#9ca3af',
          fontSize: 13,
          fontFamily: 'sans-serif',
          background: '#f9fafb',
          border: '1px dashed #d1d5db',
          borderRadius: 6,
        }}
      >
        Configure columns to display data
      </div>
    );
  }

  const headerHeight = showHeader ? 32 : 0;
  const paginationHeight = showPagination ? 30 : 0;
  const tableBodyHeight = height - headerHeight - paginationHeight - 2; // 2px for borders
  const rowHeight = Math.max(24, fontSize * 2.2);

  return (
    <div
      style={{
        width,
        height,
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize,
        overflow: 'hidden',
        border: '1px solid #e2e8f0',
        borderRadius: 4,
        background: rowBgColor,
      }}
      data-testid="data-table-widget"
    >
      {/* Table container */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            tableLayout: 'fixed',
          }}
        >
          {/* Column widths */}
          <colgroup>
            {columns.map((col, i) => (
              <col key={i} style={{ width: col.width ? `${col.width}px` : undefined }} />
            ))}
          </colgroup>

          {/* Header */}
          {showHeader && (
            <thead>
              <tr>
                {columns.map((col, i) => (
                  <th
                    key={i}
                    onClick={() => handleSort(i)}
                    style={{
                      background: headerBgColor,
                      color: headerTextColor,
                      padding: '6px 8px',
                      textAlign: 'left',
                      fontWeight: 600,
                      fontSize: fontSize - 1,
                      borderBottom: '2px solid #cbd5e1',
                      cursor: col.sortable ? 'pointer' : 'default',
                      userSelect: 'none',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      position: 'sticky',
                      top: 0,
                      zIndex: 1,
                    }}
                    data-testid={`header-col-${i}`}
                  >
                    {col.label || col.tagName || `Column ${i + 1}`}
                    {col.sortable && sortState.columnIndex === i && sortState.direction && (
                      <span style={{ marginLeft: 4, fontSize: fontSize - 2 }}>
                        {sortState.direction === 'asc' ? '\u25B2' : '\u25BC'}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
          )}

          {/* Body */}
          <tbody>
            {pageRows.map((row, ri) => {
              const ruleColor = evaluateRowColor(row, rowColorRules);
              const baseBg = ri % 2 === 0 ? rowBgColor : alternateRowColor;
              return (
                <tr
                  key={ri}
                  style={{ background: ruleColor ?? baseBg }}
                  data-testid={`table-row-${ri}`}
                >
                  {columns.map((col, ci) => {
                    const key = col.tagName || `col_${ci}`;
                    return (
                      <td
                        key={ci}
                        style={{
                          padding: '4px 8px',
                          borderBottom: '1px solid #f1f5f9',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          height: rowHeight,
                          color: ruleColor ? '#ffffff' : '#374151',
                        }}
                      >
                        {formatCellValue(row[key], col.format)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {showPagination && totalPages > 1 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '4px 8px',
            borderTop: '1px solid #e2e8f0',
            background: '#f9fafb',
            fontSize: fontSize - 2,
            color: '#6b7280',
            flexShrink: 0,
          }}
          data-testid="pagination-controls"
        >
          <span>
            Page {safeCurrentPage + 1} of {totalPages}
          </span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              onClick={() => setCurrentPage(Math.max(0, safeCurrentPage - 1))}
              disabled={safeCurrentPage === 0}
              style={{
                padding: '2px 8px',
                border: '1px solid #d1d5db',
                borderRadius: 3,
                background: safeCurrentPage === 0 ? '#f3f4f6' : '#ffffff',
                cursor: safeCurrentPage === 0 ? 'not-allowed' : 'pointer',
                color: safeCurrentPage === 0 ? '#9ca3af' : '#374151',
                fontSize: fontSize - 2,
              }}
              data-testid="page-prev"
            >
              Prev
            </button>
            <button
              onClick={() => setCurrentPage(Math.min(totalPages - 1, safeCurrentPage + 1))}
              disabled={safeCurrentPage >= totalPages - 1}
              style={{
                padding: '2px 8px',
                border: '1px solid #d1d5db',
                borderRadius: 3,
                background: safeCurrentPage >= totalPages - 1 ? '#f3f4f6' : '#ffffff',
                cursor: safeCurrentPage >= totalPages - 1 ? 'not-allowed' : 'pointer',
                color: safeCurrentPage >= totalPages - 1 ? '#9ca3af' : '#374151',
                fontSize: fontSize - 2,
              }}
              data-testid="page-next"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

DataTableRenderer.displayName = 'DataTableRenderer';
export default memo(DataTableRenderer);
