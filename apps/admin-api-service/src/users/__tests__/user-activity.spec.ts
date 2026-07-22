/**
 * APA-053 regression: GET /users/:id/activity read the auth.audit_logs table.
 * The query projected a `metadata` column that does not exist there — the real
 * jsonb column is `details` (the auth-service AuditLog entity). The query threw
 * `column "metadata" does not exist`, and a blanket catch-and-return-[] masked
 * the drift, so the endpoint silently reported zero activity for every user.
 *
 * These two assertions pin the two defects: the correct `details AS metadata`
 * projection, and that a genuine query failure surfaces instead of being
 * swallowed into an empty list.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/users-roles.md#APA-053
 */
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';

import { UsersService } from '../users.service';

describe('UsersService.getUserActivity (APA-053)', () => {
  const query = jest.fn();
  let service: UsersService;

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    query.mockReset();
    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getDataSourceToken(), useValue: { query } },
        { provide: 'AUTH_NATS_CLIENT', useValue: { send: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(UsersService);
  });

  it('projects the real auth.audit_logs `details` column onto `metadata`', async () => {
    query.mockResolvedValue([]);
    await service.getUserActivity('11111111-1111-4111-8111-111111111111', 10);
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain('details AS metadata');
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      '11111111-1111-4111-8111-111111111111',
      10,
    ]);
  });

  it('does not swallow query failures into [] (schema drift must surface)', async () => {
    query.mockRejectedValue(new Error('column "metadata" does not exist'));
    await expect(
      service.getUserActivity('11111111-1111-4111-8111-111111111111'),
    ).rejects.toThrow('column "metadata" does not exist');
  });
});
