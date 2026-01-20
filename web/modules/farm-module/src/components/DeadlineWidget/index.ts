export {
  DeadlineWidget,
  DeadlineIcon,
  DeadlineItemCard,
  UrgencyFilter,
  EmptyState,
  LoadingState,
  ErrorState,
  urgencyConfig,
  reportTypeConfig,
  getDeadlineUrgency,
  formatDaysRemaining,
  sortDeadlines,
  filterDeadlines,
  countByUrgency,
  formatDeadlineDate,
} from './DeadlineWidget';

export type {
  DeadlineUrgency,
  ReportType,
  UpcomingDeadline,
  DeadlineWidgetProps,
} from './DeadlineWidget';
