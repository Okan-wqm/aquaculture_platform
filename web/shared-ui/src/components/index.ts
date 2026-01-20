/**
 * Components Exports
 * Tüm UI bileşenlerinin merkezi export noktası
 */

// Button
export { Button } from './Button';
export type { ButtonProps } from './Button';

// Card
export { Card, CardGrid, MetricCard } from './Card';
export type { CardProps, CardGridProps, MetricCardProps } from './Card';

// Table
export { Table } from './Table';
export type { TableProps, TableColumn } from './Table';

// Form
export { Input, Textarea } from './Form/Input';
export type { InputProps, TextareaProps } from './Form/Input';
export { Select } from './Form/Select';
export type { SelectProps, SelectOption } from './Form/Select';
export { Checkbox, Switch, RadioGroup } from './Form/Checkbox';
export type { CheckboxProps, SwitchProps, RadioGroupProps, RadioOption } from './Form/Checkbox';
export { FormField } from './Form/FormField';
export type { FormFieldProps } from './Form/FormField';
export { SearchInput } from './Form/SearchInput';
export type { SearchInputProps } from './Form/SearchInput';
export { DatePicker } from './Form/DatePicker';
export type { DatePickerProps } from './Form/DatePicker';
export { DateRangePicker } from './Form/DateRangePicker';
export type { DateRangePickerProps, DateRange } from './Form/DateRangePicker';
export { FileUpload } from './Form/FileUpload';
export type { FileUploadProps, UploadedFile } from './Form/FileUpload';
export { NumberInput } from './Form/NumberInput';
export type { NumberInputProps } from './Form/NumberInput';
export { MultiSelect } from './Form/MultiSelect';
export type { MultiSelectProps, MultiSelectOption } from './Form/MultiSelect';
export { DynamicSpecificationForm } from './Form/DynamicSpecificationForm';
export type {
  DynamicSpecificationFormProps,
  SpecificationField,
  SpecificationGroup,
  SpecificationSchema,
  SpecificationFieldOption,
} from './Form/DynamicSpecificationForm';

// Layout
export { Header } from './Layout/Header';
export type { HeaderProps, HeaderTheme } from './Layout/Header';
export { Sidebar } from './Layout/Sidebar';
export type { SidebarProps, SidebarTheme } from './Layout/Sidebar';

// Modal
export { Modal, ConfirmModal, DeleteConfirmationDialog } from './Modal';
export type {
  ModalProps,
  ConfirmModalProps,
  DeleteConfirmationDialogProps,
  DeletePreviewData,
  AffectedItemGroup,
  AffectedItemSummary,
} from './Modal';

// Alert & Badge
export { Alert, Badge } from './Alert';
export type { AlertProps, BadgeProps } from './Alert';

// Loading
export {
  Spinner,
  LoadingOverlay,
  Skeleton,
  SkeletonText,
  SkeletonCard,
  SkeletonTable,
  PageLoading,
} from './Loading';
export type {
  SpinnerProps,
  LoadingOverlayProps,
  SkeletonProps,
  SkeletonTextProps,
  SkeletonTableProps,
} from './Loading';

// DataTable - Enterprise-grade data table component
export { DataTable } from './DataTable';
export type {
  DataTableProps,
  DataTableColumn,
  SortConfig,
  FilterConfig,
  FilterOption,
  PaginationConfig,
  BulkAction,
  ExportFormat,
} from './DataTable';

// KPI Card - Dashboard metric card component
export { KpiCard } from './KpiCard';
export type {
  KpiCardProps,
  TrendDirection as KpiTrendDirection,
  CardVariant as KpiCardVariant,
  CardSize as KpiCardSize,
} from './KpiCard';

// Charts - SVG-based charting components
export {
  AreaChart,
  BarChart,
  LineChart,
  PieChart,
  DonutChart,
  SparklineChart,
  ChartContainer,
  ChartLegend,
  ChartTooltip,
} from './Charts';
export type {
  AreaChartProps,
  BarChartProps,
  LineChartProps,
  LineDataset,
  PieChartProps,
  PieDataItem,
  DonutChartProps,
  SparklineChartProps,
  ChartContainerProps,
  ChartLegendProps,
  ChartTooltipProps,
  BarDataset,
  DataPoint,
  LegendItem,
  TooltipItem,
} from './Charts';

// Router - Pre-configured router with v7 future flags
export { ConfiguredBrowserRouter } from './ConfiguredBrowserRouter';
export type { ConfiguredBrowserRouterProps } from './ConfiguredBrowserRouter';

// ApiError - Error display component
export { ApiError } from './ApiError';
export type { ApiErrorProps } from './ApiError';
