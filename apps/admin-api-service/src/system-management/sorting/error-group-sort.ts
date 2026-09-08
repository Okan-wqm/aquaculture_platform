// `userCount` is deliberately absent: migration 1809700000000 dropped
// `admin.error_groups."userCount"`, so a sort by it would ORDER BY a column
// that does not exist. The real distinct-user count is derived from
// `admin.error_occurrences` where the one consumer needs it — a derived value
// is not a sort key on a paginated group query, and offering it here would be
// a 500 wearing an allowlist's clothes.
export const ERROR_GROUP_SORT_FIELDS = ['occurrenceCount', 'lastSeenAt', 'firstSeenAt'] as const;

export type ErrorGroupSortField = (typeof ERROR_GROUP_SORT_FIELDS)[number];

export const ERROR_GROUP_SORT_COLUMNS: Readonly<Record<ErrorGroupSortField, string>> = {
  occurrenceCount: 'g.occurrenceCount',
  lastSeenAt: 'g.lastSeenAt',
  firstSeenAt: 'g.firstSeenAt',
};
