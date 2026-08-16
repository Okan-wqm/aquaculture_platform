import {
  auditStatisticsScopeHasValidIdentityV2,
  auditStatisticsProjectionHasValidEvidenceV2,
  createAuditStatisticsScopeV2,
} from '../audit-statistics-scope';

describe('audit statistics scope identity', () => {
  it('binds tenant, interval, source and asOf into one content identity', () => {
    const scope = createAuditStatisticsScopeV2({
      tenantId: '11111111-1111-4111-8111-111111111111',
      startDate: new Date('2026-08-01T00:00:00.000Z'),
      endDate: new Date('2026-08-09T12:00:00.000Z'),
      asOf: new Date('2026-08-09T12:00:00.000Z'),
    });

    expect(auditStatisticsScopeHasValidIdentityV2(scope)).toBe(true);
    expect(scope.scopeSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(auditStatisticsScopeHasValidIdentityV2({ ...scope, tenantId: null })).toBe(false);
  });

  it('rejects incoherent intervals', () => {
    expect(() =>
      createAuditStatisticsScopeV2({
        startDate: new Date('2026-08-10T00:00:00.000Z'),
        endDate: new Date('2026-08-09T00:00:00.000Z'),
        asOf: new Date('2026-08-09T00:00:00.000Z'),
      }),
    ).toThrow(/startDate/u);
  });

  it('requires every complete grouping to reconcile to the same scoped total', () => {
    const scope = createAuditStatisticsScopeV2({
      endDate: new Date('2026-08-09T12:00:00.000Z'),
      asOf: new Date('2026-08-09T12:00:00.000Z'),
    });
    const projection = {
      scope,
      totalLogs: 3,
      observedLogs: 5,
      legacyUnverifiedLogs: 2,
      last24Hours: 2,
      byAction: [{ count: 2 }, { count: 1 }],
      bySeverity: [{ count: 3 }],
      byEntityType: [{ count: 1 }, { count: 2 }],
      topUsers: [{ count: 2 }, { count: 1 }],
    };

    expect(auditStatisticsProjectionHasValidEvidenceV2(projection)).toBe(true);
    expect(
      auditStatisticsProjectionHasValidEvidenceV2({
        ...projection,
        bySeverity: [{ count: 2 }],
      }),
    ).toBe(false);
    expect(
      auditStatisticsProjectionHasValidEvidenceV2({
        ...projection,
        observedLogs: 4,
      }),
    ).toBe(false);
  });
});
