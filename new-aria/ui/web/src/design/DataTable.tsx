import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { EmptyBlock } from './AsyncState.tsx';
import './DataTable.css';

export type SortValue = string | number | null;
export type SortDirection = 'asc' | 'desc';

export interface ColumnDef<T> {
  readonly id: string;
  readonly header: string;
  readonly render: (row: T) => ReactNode;
  /** Present → the header becomes a sort button. */
  readonly sortValue?: ((row: T) => SortValue) | undefined;
  readonly align?: 'start' | 'end' | undefined;
  readonly nowrap?: boolean | undefined;
}

export interface TableFilter<T> {
  readonly placeholder: string;
  readonly predicate: (row: T, normalisedQuery: string) => boolean;
}

export interface DataTableProps<T> {
  readonly columns: ReadonlyArray<ColumnDef<T>>;
  readonly rows: ReadonlyArray<T>;
  readonly rowKey: (row: T) => string;
  /** Screen-reader caption; visually hidden. */
  readonly caption: string;
  readonly filter?: TableFilter<T> | undefined;
  readonly emptyMessage: string;
  readonly onRowActivate?: ((row: T) => void) | undefined;
  readonly rowClassName?: ((row: T) => string | undefined) | undefined;
  readonly initialSort?: { readonly columnId: string; readonly direction: SortDirection } | undefined;
  readonly dense?: boolean | undefined;
  readonly toolbar?: ReactNode;
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
  return String(a).localeCompare(String(b), 'tr');
}

/**
 * Client-side sortable/filterable table.
 *
 * Keyboard: header sort buttons are real <button>s; body rows use a roving
 * tabindex (ArrowUp/ArrowDown/Home/End) and Enter/Space activates the focused row
 * when `onRowActivate` is given. Filtering is a substring match supplied by the
 * caller, so each page decides which fields are searchable.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  filter,
  emptyMessage,
  onRowActivate,
  rowClassName,
  initialSort,
  dense = false,
  toolbar,
}: DataTableProps<T>): ReactNode {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ columnId: string; direction: SortDirection } | null>(initialSort ?? null);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([]);
  const filterId = useId();

  const visibleRows = useMemo(() => {
    const normalised = query.trim().toLocaleLowerCase('tr');
    const filtered = filter !== undefined && normalised !== '' ? rows.filter((row) => filter.predicate(row, normalised)) : [...rows];
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
  }, [rows, query, sort, columns, filter]);

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

  return (
    <div className="data-table">
      {filter !== undefined || toolbar !== undefined ? (
        <div className="data-table__toolbar">
          {filter !== undefined ? (
            <label className="field data-table__filter" htmlFor={filterId}>
              <span className="visually-hidden">Filtre</span>
              <input
                id={filterId}
                type="search"
                placeholder={filter.placeholder}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                autoComplete="off"
              />
            </label>
          ) : null}
          {toolbar}
          <span className="data-table__count" aria-live="polite">
            {visibleRows.length === rows.length ? `${rows.length} satır` : `${visibleRows.length} / ${rows.length} satır`}
          </span>
        </div>
      ) : null}
      {visibleRows.length === 0 ? (
        <EmptyBlock message={rows.length === 0 ? emptyMessage : 'Filtreyle eşleşen satır yok.'} />
      ) : (
        <div className="data-table__scroll">
          <table className={`data-table__table${dense ? ' data-table__table--dense' : ''}`}>
            <caption className="visually-hidden">{caption}</caption>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th
                    key={column.id}
                    scope="col"
                    aria-sort={column.sortValue !== undefined ? ariaSort(column.id) : undefined}
                    className={column.align === 'end' ? 'is-end' : undefined}
                  >
                    {column.sortValue !== undefined ? (
                      <button type="button" className="data-table__sort" onClick={() => toggleSort(column.id)}>
                        {column.header}
                        <span className="data-table__sort-icon" aria-hidden="true">
                          {ariaSort(column.id) === 'ascending' ? '▲' : ariaSort(column.id) === 'descending' ? '▼' : '↕'}
                        </span>
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, index) => {
                const extraClass = rowClassName?.(row);
                const classes = [onRowActivate !== undefined ? 'is-activatable' : '', extraClass ?? ''].filter((entry) => entry !== '').join(' ');
                return (
                  <tr
                    key={rowKey(row)}
                    ref={(element) => {
                      rowRefs.current[index] = element;
                    }}
                    tabIndex={index === Math.min(focusedIndex, visibleRows.length - 1) ? 0 : -1}
                    className={classes === '' ? undefined : classes}
                    onKeyDown={(event) => handleRowKey(event, index, row)}
                    onFocus={() => setFocusedIndex(index)}
                    onClick={onRowActivate !== undefined ? () => onRowActivate(row) : undefined}
                  >
                    {columns.map((column) => (
                      <td
                        key={column.id}
                        className={[column.align === 'end' ? 'is-end' : '', column.nowrap === true ? 'nowrap' : ''].filter((entry) => entry !== '').join(' ') || undefined}
                      >
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
    </div>
  );
}
