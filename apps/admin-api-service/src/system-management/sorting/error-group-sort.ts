export const ERROR_GROUP_SORT_FIELDS = [
  'occurrenceCount',
  'lastSeenAt',
  'firstSeenAt',
  'userCount',
] as const;

export type ErrorGroupSortField = (typeof ERROR_GROUP_SORT_FIELDS)[number];

export const ERROR_GROUP_SORT_COLUMNS: Readonly<Record<ErrorGroupSortField, string>> = {
  occurrenceCount: 'g.occurrenceCount',
  lastSeenAt: 'g.lastSeenAt',
  firstSeenAt: 'g.firstSeenAt',
  userCount: 'g.userCount',
};
