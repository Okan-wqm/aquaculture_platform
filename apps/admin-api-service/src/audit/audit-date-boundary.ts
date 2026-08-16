import { BadRequestException } from '@nestjs/common';

/**
 * Canonical audit date-only semantics shared by both admin audit surfaces.
 * A date-only end boundary includes the complete UTC calendar day.
 */
export function parseAuditDateBoundary(
  value: string | undefined,
  field: 'startDate' | 'endDate',
): Date | undefined {
  if (value === undefined) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/u.test(value);
  const parsed = new Date(
    dateOnly ? `${value}T${field === 'startDate' ? '00:00:00.000' : '23:59:59.999'}Z` : value,
  );
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`${field} must be a valid ISO 8601 date`);
  }
  return parsed;
}
