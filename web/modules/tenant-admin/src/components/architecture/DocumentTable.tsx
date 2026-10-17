/**
 * A read-only table of document rows, rendered through shared-ui's DataTable
 * (FE-HIGH-069: the module draws no table of its own) with everything a
 * reference table does not need switched off — no toolbar, sorting,
 * selection, sticky header or zebra rows — and framed by a card that carries
 * the table's title.
 */
import React from 'react';
import { DataTable, type DataTableColumn } from '@aquaculture/shared-ui';

import { DOCUMENT_LANGUAGE } from './content/language';
import { DOC_FRAME } from './docStyles';

export interface DocumentTableProps<T> {
  rows: readonly T[];
  columns: DataTableColumn<T>[];
  rowKey: (row: T, index: number) => string;
}

export function DocumentTable<T>({
  rows,
  columns,
  rowKey,
}: DocumentTableProps<T>): React.ReactElement {
  return (
    <DataTable<T>
      data={rows}
      columns={columns}
      keyExtractor={rowKey}
      flush
      compact
      striped={false}
      hoverable={false}
      sortable={false}
      searchable={false}
      stickyHeader={false}
    />
  );
}

export interface TableCardProps {
  title?: string;
  sub?: string;
  children: React.ReactNode;
}

/**
 * The blueprint card around a table, with the table's title row when it has one.
 * The card does not clip: `sd-card` draws its corner marks 6px outside the box,
 * and with square corners there is nothing to clip — the DataTable inside
 * scrolls sideways in its own container.
 */
export const TableCard: React.FC<TableCardProps> = ({ title, sub, children }) => (
  <div className={DOC_FRAME}>
    {title ? (
      <div
        lang={DOCUMENT_LANGUAGE}
        className="flex flex-col gap-[3px] border-b border-gray-200 px-6 py-3.5 dark:border-gray-700"
      >
        <h3 className="m-0 font-display text-[22px] font-semibold text-gray-900 dark:text-gray-100">
          {title}
        </h3>
        {sub ? (
          <span className="text-sm leading-snug text-gray-600 dark:text-gray-400">{sub}</span>
        ) : null}
      </div>
    ) : null}
    {children}
  </div>
);

/** A cell in the document's language, bold for a row's lead column. */
export function documentCell(value: string, lead = false): React.ReactElement {
  return (
    <span
      lang={DOCUMENT_LANGUAGE}
      className={
        lead ? 'font-semibold text-gray-900 dark:text-gray-100' : 'text-gray-700 dark:text-gray-300'
      }
    >
      {value}
    </span>
  );
}
