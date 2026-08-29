export const ACTIVITY_LOG_SORT_FIELDS = [
  'createdAt',
  'severity',
  'category',
  'action',
  'success',
  'duration',
] as const;

export type ActivityLogSortField = (typeof ACTIVITY_LOG_SORT_FIELDS)[number];

export const ACTIVITY_LOG_SORT_COLUMNS: Readonly<Record<ActivityLogSortField, string>> = {
  createdAt: 'activity.createdAt',
  severity: 'activity.severity',
  category: 'activity.category',
  action: 'activity.action',
  success: 'activity.success',
  duration: 'activity.duration',
};

export const AUDIT_TRAIL_SORT_COLUMNS: Readonly<Record<ActivityLogSortField, string>> = {
  createdAt: 'log.createdAt',
  severity: 'log.severity',
  category: 'log.category',
  action: 'log.action',
  success: 'log.success',
  duration: 'log.duration',
};
