/**
 * APA-320 contract guard: GET /database/schemas/:tenantId/validate returns the
 * SchemaIsolationResult SSoT shape — `{ isIsolated, issues }`, never a `valid`
 * key. The admin-panel had hand-mirrored the wire as `{ valid, issues }` and
 * always read `result.valid` (undefined), so a correctly-isolated schema
 * reported "Issues found: ". The FE now reads `isIsolated` (compile-enforced by
 * the api-type rename); this freezes the backend field name so a future rename
 * fails CI at the source instead of silently re-drifting the FE.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/database-mgmt.md#APA-320
 */
import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';

import { TenantSchema } from '../entities/database-management.entity';
import { SchemaManagementService } from '../services/schema-management.service';

describe('SchemaManagementService.validateSchemaIsolation contract (APA-320)', () => {
  it('returns { isIsolated, issues } and never a legacy `valid` key', async () => {
    const queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([]),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        SchemaManagementService,
        {
          provide: getRepositoryToken(TenantSchema),
          useValue: {
            findOne: jest
              .fn()
              .mockResolvedValue({ tenantId: 't', schemaName: 'tenant_abc123' }),
          },
        },
        {
          provide: getDataSourceToken(),
          useValue: { createQueryRunner: () => queryRunner },
        },
      ],
    }).compile();

    const service = moduleRef.get(SchemaManagementService);
    const result = await service.validateSchemaIsolation(
      '11111111-1111-4111-8111-111111111111',
    );

    expect(typeof result.isIsolated).toBe('boolean');
    expect(Array.isArray(result.issues)).toBe(true);
    expect(result.isIsolated).toBe(true);
    expect(Object.keys(result)).not.toContain('valid');
  });
});
