import type { ClassConstructor } from 'class-transformer';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';

import { QueryActivitiesDto } from '../activity-log.controller';
import { QueryAuditTrailDto } from '../audit-trail.controller';
import { QueryErrorGroupsDto } from '../../../system-management/controllers/error-tracking.controller';

type SortDto = QueryActivitiesDto | QueryAuditTrailDto | QueryErrorGroupsDto;

const ACTIVITY_SORT_FIELDS = [
  'createdAt',
  'severity',
  'category',
  'action',
  'success',
  'duration',
] as const;
const ERROR_GROUP_SORT_FIELDS = [
  'occurrenceCount',
  'lastSeenAt',
  'firstSeenAt',
  'userCount',
] as const;

const sortValidationErrors = async (
  dtoClass: ClassConstructor<SortDto>,
  sortBy: string,
): Promise<ValidationError[]> => validate(plainToInstance(dtoClass, { sortBy }));

describe('admin sort DTO allowlists', () => {
  it.each([
    ['activity', QueryActivitiesDto, ACTIVITY_SORT_FIELDS],
    ['audit', QueryAuditTrailDto, ACTIVITY_SORT_FIELDS],
    ['error group', QueryErrorGroupsDto, ERROR_GROUP_SORT_FIELDS],
  ] as const)('accepts every documented %s sort field', async (_name, dtoClass, fields) => {
    for (const field of fields) {
      await expect(sortValidationErrors(dtoClass, field)).resolves.toHaveLength(0);
    }
  });

  it.each([
    ['activity', QueryActivitiesDto],
    ['audit', QueryAuditTrailDto],
    ['error group', QueryErrorGroupsDto],
  ] as const)('rejects malicious and unknown %s sort fields', async (_name, dtoClass) => {
    await expect(
      sortValidationErrors(dtoClass, 'createdAt) DESC; SELECT pg_sleep(1); --'),
    ).resolves.toHaveLength(1);
    await expect(sortValidationErrors(dtoClass, 'CREATEDAT')).resolves.toHaveLength(1);
  });
});
