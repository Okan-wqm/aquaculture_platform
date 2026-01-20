/**
 * DataTable Component Export
 */

import type React from 'react';

export { DataTable, default } from './DataTable';
export type {
  TableColumn,
  SortConfig,
  FilterConfig,
  PaginationConfig,
  DataTableProps,
} from './DataTable';

// Type alias for better naming
export type { TableColumn as DataTableColumn } from './DataTable';

// Additional types for convenience
export type FilterOption = { value: string; label: string };
export type BulkAction = {
  key: string;
  label: string;
  icon?: React.ReactNode;
  variant?: 'primary' | 'secondary' | 'danger';
  onClick: (selectedIds: string[]) => void;
};
export type ExportFormat = 'csv' | 'xlsx' | 'pdf' | 'json';
