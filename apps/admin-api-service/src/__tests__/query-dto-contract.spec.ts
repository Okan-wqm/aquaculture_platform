import 'reflect-metadata';

import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { validate } from 'class-validator';

import { AuditLogQueryDto } from '../audit/dto/audit-log-query.dto';
import { CustomPlanQueryDto } from '../billing/dto/custom-plan-query.dto';
import { booleanQueryValueV1 } from '../shared/query-value';
import {
  TicketCommentQueryDto,
  TicketListQueryDto,
  TicketStatusPageQueryDto,
} from '../support/dto/ticket-query.dto';

async function validationErrors<T extends object>(contract: ClassConstructor<T>, query: object) {
  return validate(plainToInstance(contract, query), {
    forbidNonWhitelisted: true,
    whitelist: true,
  });
}

describe('admin list query DTO contracts', () => {
  it('accepts complete audit filters and transforms pagination coordinates', async () => {
    const query = plainToInstance(AuditLogQueryDto, {
      action: 'TENANT_UPDATED',
      severity: 'warning',
      startDate: '2026-08-01T00:00:00.000Z',
      page: '2',
      limit: '25',
    });

    await expect(validationErrors(AuditLogQueryDto, query)).resolves.toEqual([]);
    expect(query.page).toBe(2);
    expect(query.limit).toBe(25);
  });

  it('rejects invalid audit dates, severities, and undeclared keys', async () => {
    await expect(
      validationErrors(AuditLogQueryDto, {
        severity: 'verbose',
        startDate: 'not-a-date',
        undeclared: 'must-fail',
      }),
    ).resolves.toHaveLength(3);
  });

  it('validates custom-plan filters through one DTO', async () => {
    await expect(
      validationErrors(CustomPlanQueryDto, {
        tenantId: '11111111-1111-4111-8111-111111111111',
        status: 'active',
        tier: 'enterprise',
        search: 'priority tenant',
      }),
    ).resolves.toEqual([]);
    await expect(
      validationErrors(CustomPlanQueryDto, { tenantId: 'not-a-uuid' }),
    ).resolves.toHaveLength(1);
    await expect(
      validationErrors(CustomPlanQueryDto, { status: 'cancelled' }),
    ).resolves.toHaveLength(1);
  });

  it('validates every ticket list variant against the ticket vocabularies', async () => {
    await expect(
      validationErrors(TicketListQueryDto, {
        status: 'in_progress',
        priority: 'critical',
        category: 'technical',
        tenantId: '11111111-1111-4111-8111-111111111111',
      }),
    ).resolves.toEqual([]);
    await expect(
      validationErrors(TicketStatusPageQueryDto, { status: 'unknown' }),
    ).resolves.toHaveLength(1);
  });

  it('accepts only explicit boolean query strings for comments and replies', async () => {
    await expect(
      validationErrors(TicketCommentQueryDto, { includeInternal: 'false' }),
    ).resolves.toEqual([]);
    await expect(
      validationErrors(TicketCommentQueryDto, { includeInternal: 'yes' }),
    ).resolves.toHaveLength(1);
    expect(booleanQueryValueV1('false', true)).toBe(false);
    expect(booleanQueryValueV1(undefined, true)).toBe(true);
  });
});
