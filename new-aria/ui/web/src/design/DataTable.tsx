import { useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { EmptyState } from './EmptyState.tsx';
import { Icon } from './Icon.tsx';
import './DataTable.css';

export type SortValue = string | number | null;
export type SortDirection = 'asc' | 'desc';

export interface ColumnDef<T> {
  readonly id: string;
  readonly header: string;
  readonly render: (row: T) => ReactNode;
  /** Present → the header becomes a sort button with visible direction state. */
  readonly sortValue?: ((row: T) => SortValue) | undefined;
  /** `end` right-aligns the column and applies tabular numerals. */
  readonly align?: 'start' | 'end' | undefined;
  readonly nowrap?: boolean | undefined;
  /** Monospace cell type for hashes, ids, paths and commands. */
  readonly mono?: boolean | undefined;
  /** Present → this column gets an input in the filter row (needs `filterRow`). */
  readonly filterValue?: ((row: T) => string) | undefined;
  /** Any CSS width, e.g. "12ch" or "180px". */
  readonly width?: string | undefined;
  /** Hover explanation for an abbreviated header. */
  readonly headerTitle?: string | undefined;
}

export interface TableFilter<T> {
  readonly placeholder: string;
  /** Called with the query already lower-cased; return true to keep the row. */
  readonly predicate: (row: T, normalisedQuery: string) => boolean;
}

export interface DataTableProps<T> {
  readonly columns: ReadonlyArray<ColumnDef<T>>;
  readonly rows: ReadonlyArray<T>;
  readonly rowKey: (row: T) => string;
  /** Screen-reader caption naming the table; visually hidden. */
  readonly caption: string;
  /** Free-text search across the whole row, shown in the table toolbar. */
  readonly filter?: TableFilter<T> | undefined;
  /** One sentence: what would appear here, and why it is empty. */
  readonly emptyMessage: string;
  /** Headline above `emptyMessage`, e.g. "No cycles yet". */
  readonly emptyTitle?: string | undefined;
  readonly onRowActivate?: ((row: T) => void) | undefined;
  /** Extra row class: `row-danger`, `row-warning`, `row-success`, `row-muted`. */
  readonly rowClassName?: ((row: T) => string | undefined) | undefined;
  readonly initialSort?: { readonly columnId: string; readonly direction: SortDirection } | undefined;
  readonly dense?: boolean | undefined;
  /** Extra controls in the table toolbar (selects, buttons, legends). */
  readonly toolbar?: ReactNode;
  /** Renders a per-column filter input for every column declaring `filterValue`. */
  readonly filterRow?: boolean | undefined;
  /** Caps the scroll area, e.g. "60vh", so the sticky header stays inside the card. */
  readonly maxHeight?: string | undefined;
  /** rowKey of the row shown in a detail panel; highlights it. */
  readonly selectedKey?: string | undefined;
  readonly footer?: ReactNode;
  /** Noun for the toolbar counter. Default "rows". */
  readonly countNoun?: string | undefined;
}

function compareSortValues(a: SortValue, b: SortValue): number {
  if (a === null && b === null) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  return String(a).localeCompare(String(b), 'en-GB');
}

function cellClass<T>(column: ColumnDef<T>): string | undefined {
  const classes = [column.align === 'end' ? 'is-end' : '', column.nowrap === true ? 'nowrap' : '', column.mono === true ? 'is-mono' : ''].filter(
    (entry) => entry !== '',
  );
  return classes.length === 0 ? undefined : classes.join(' ');
}

/**
 * Client-side sortable and filterable table.
 *
 * WHY: every ledger view in this console is a table, so sorting, filtering,
 * empty states and keyboard traversal are solved once here rather than per page.
 * WHAT: header sort buttons are real <button>s carrying aria-sort; body rows use
 * a roving tabindex (ArrowUp/ArrowDown/Home/End) and Enter or Space activates the
 * focused row when `onRowActivate` is given. Free-text filtering is a predicate
 * supplied by the caller, so each page decides which fields are searchable;
 * column filters are substring matches over each column's `filterValue`.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  filter,
  emptyMessage,
  emptyTitle,
  onRowActivate,
  rowClassName,
  initialSort,
  dense = false,
  toolbar,
  filterRow = false,
  maxHeight,
  selectedKey,
  footer,
  countNoun = 'rows',
}: DataTableProps<T>): ReactNode {
  const [query, setQuery] = useState('');
  const [columnQueries, setColumnQueries] = useState<Readonly<Record<string, string>>>({});
  const [sort, setSort] = useState<{ columnId: string; direction: SortDirection } | null>(initialSort ?? null);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([]);
  const filterId = useId();

  const visibleRows = useMemo(() => {
    const normalised = query.trim().toLowerCase();
    let filtered = filter !== undefined && normalised !== '' ? rows.filter((row) => filter.predicate(row, normalised)) : [...rows];
    for (const column of columns) {
      const columnQuery = (columnQueries[column.id] ?? '').trim().toLowerCase();
      const accessor = column.filterValue;
      if (columnQuery === '' || accessor === undefined) {
        continue;
      }
      filtered = filtered.filter((row) => accessor(row).toLowerCase().includes(columnQuery));
    }
    if (sort === null) {
      return filtered;
    }
    const column = columns.find((entry) => entry.id === sort.columnId);
    if (column?.sortValue === undefined) {
      return filtered;
    }
    const sortValue = column.sortValue;
    const factor = sort.direction === 'asc' ? 1 : -1;
    return filtered.sort((a, b) => compareSortValues(sortValue(a), sortValue(b)) * factor);
  }, [rows, query, columnQueries, sort, columns, filter]);

  const toggleSort = (columnId: string): void => {
    setSort((current) => {
      if (current === null || current.columnId !== columnId) {
        return { columnId, direction: 'asc' };
      }
      return current.direction === 'asc' ? { columnId, direction: 'desc' } : null;
    });
  };

  const focusRow = (index: number): void => {
    const bounded = Math.max(0, Math.min(index, visibleRows.length - 1));
    setFocusedIndex(bounded);
    rowRefs.current[bounded]?.focus();
  };

  const handleRowKey = (event: KeyboardEvent<HTMLTableRowElement>, index: number, row: T): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusRow(index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusRow(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusRow(0);
        break;
      case 'End':
        event.preventDefault();
        focusRow(visibleRows.length - 1);
        break;
      case 'Enter':
      case ' ':
        if (onRowActivate !== undefined && event.target === event.currentTarget) {
          event.preventDefault();
          onRowActivate(row);
        }
        break;
      default:
        break;
    }
  };

  const ariaSort = (columnId: string): 'ascending' | 'descending' | 'none' => {
    if (sort === null || sort.columnId !== columnId) {
      return 'none';
    }
    return sort.direction === 'asc' ? 'ascending' : 'descending';
  };

  const hasColumnFilters = filterRow && columns.some((column) => column.filterValue !== undefined);
  const isFiltered = query.trim() !== '' || Object.values(columnQueries).some((value) => value.trim() !== '');
  const scrollStyle: CSSProperties | undefined = maxHeight === undefined ? undefined : { maxHeight };

  return (
    <div className="data-table">
      {filter !== undefined || toolbar !== undefined ? (
        <div className="data-table__toolbar">
          {filter !== undefined ? (
            <span className="data-table__search">
              <span className="data-table__search-icon">
                <Icon name="search" size={14} />
              </span>
              <label className="visually-hidden" htmlFor={filterId}>
                Search
              </label>
              <input
                id={filterId}
                type="search"
                placeholder={filter.placeholder}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                autoComplete="off"
              />
            </span>
          ) : null}
          {toolbar}
          <span className="data-table__count" aria-live="polite">
            {visibleRows.length === rows.length
              ? `${rows.length} ${countNoun}`
              : `${visibleRows.length} of ${rows.length} ${countNoun}`}
          </span>
        </div>
      ) : null}
      {visibleRows.length === 0 ? (
        <div className="data-table__empty">
          {isFiltered ? (
            <EmptyState
              title="No matching rows"
              message="No row matches the current search. Clear the filters to see the full set."
              flush
            />
          ) : (
            <EmptyState title={emptyTitle} message={emptyMessage} flush />
          )}
        </div>
      ) : (
        <div className="data-table__scroll" style={scrollStyle}>
          <table className={`data-table__table${dense ? ' data-table__table--dense' : ''}`}>
            <caption className="visually-hidden">{caption}</caption>
            <thead>
              <tr>
                {columns.map((column) => {
                  const state = ariaSort(column.id);
                  return (
                    <th
                      key={column.id}
                      scope="col"
                      aria-sort={column.sortValue !== undefined ? state : undefined}
                      className={column.align === 'end' ? 'is-end' : undefined}
                      style={column.width === undefined ? undefined : { width: column.width }}
                      title={column.headerTitle}
                    >
                      {column.sortValue !== undefined ? (
                        <button type="button" className="data-table__sort" onClick={() => toggleSort(column.id)}>
                          {column.header}
                          <span className={`data-table__sort-icon${state === 'none' ? '' : ' data-table__sort-icon--active'}`}>
                            <Icon name={state === 'descending' ? 'chevron-down' : 'chevron-up'} size={12} />
                          </span>
                        </button>
                      ) : (
                        column.header
                      )}
                    </th>
                  );
                })}
              </tr>
              {hasColumnFilters ? (
                <tr className="data-table__filter-row">
                  {columns.map((column) => (
                    <th key={column.id} scope="col">
                      {column.filterValue !== undefined ? (
                        <input
                          type="search"
                          value={columnQueries[column.id] ?? ''}
                          aria-label={`Filter ${column.header}`}
                          placeholder="Filter"
                          autoComplete="off"
                          onChange={(event) => {
                            const next = event.target.value;
                            setColumnQueries((current) => ({ ...current, [column.id]: next }));
                          }}
                        />
                      ) : null}
                    </th>
                  ))}
                </tr>
              ) : null}
            </thead>
            <tbody>
              {visibleRows.map((row, index) => {
                const key = rowKey(row);
                const selected = selectedKey !== undefined && selectedKey === key;
                const classes = [
                  onRowActivate !== undefined ? 'is-activatable' : '',
                  selected ? 'row-selected' : '',
                  rowClassName?.(row) ?? '',
                ]
                  .filter((entry) => entry !== '')
                  .join(' ');
                return (
                  <tr
                    key={key}
                    ref={(element) => {
                      rowRefs.current[index] = element;
                    }}
                    tabIndex={index === Math.min(focusedIndex, visibleRows.length - 1) ? 0 : -1}
                    className={classes === '' ? undefined : classes}
                    aria-current={selected ? 'true' : undefined}
                    onKeyDown={(event) => handleRowKey(event, index, row)}
                    onFocus={() => setFocusedIndex(index)}
                    onClick={onRowActivate !== undefined ? () => onRowActivate(row) : undefined}
                  >
                    {columns.map((column) => (
                      <td key={column.id} className={cellClass(column)}>
                        {column.render(row)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {footer !== undefined ? <div className="data-table__footer">{footer}</div> : null}
    </div>
  );
}
