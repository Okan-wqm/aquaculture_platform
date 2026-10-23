import { listActiveTenantSchemaIdentities } from '@aquaculture/backend-common/database';
import { type ScheduledJobExecutor } from '@aquaculture/backend-common/scheduling';
import { collaborator } from '@aquaculture/testing';
import { type DataSource } from 'typeorm';

import { type EdgeReleaseCatalog } from '../edge-release-catalog.service';
import { EdgeUpdateReconciler } from '../edge-update-reconciler.service';
import { type EdgeUpdateRequestService } from '../edge-update-request.service';

/**
 * How the reconciler walks the tenants (ADR-048 DEC-2.12). What it does to one
 * tenant's requests is proven against real Postgres in
 * edge-update-request.rls.postgres.spec.ts.
 */

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  listActiveTenantSchemaIdentities: jest.fn(),
}));

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date('2026-10-20T12:00:00Z');

const tenants = jest.mocked(listActiveTenantSchemaIdentities);

describe('EdgeUpdateReconciler.reconcileAll', () => {
  const lapseDue = jest.fn();
  const reissueCandidates = jest.fn();
  let reconciler: EdgeUpdateReconciler;

  beforeEach(() => {
    jest.resetAllMocks();
    reissueCandidates.mockResolvedValue([]);
    reconciler = new EdgeUpdateReconciler(
      collaborator<DataSource>({}, 'DataSource'),
      collaborator<EdgeUpdateRequestService>(
        { lapseDue, reissueCandidates },
        'EdgeUpdateRequestService',
      ),
      collaborator<EdgeReleaseCatalog>({}, 'EdgeReleaseCatalog'),
      collaborator<ScheduledJobExecutor>({}, 'ScheduledJobExecutor'),
    );
  });

  it('reconciles every active tenant and sums what was done', async () => {
    tenants.mockResolvedValue([
      { tenantId: TENANT_A, schemaName: 'tenant_a' },
      { tenantId: TENANT_B, schemaName: 'tenant_b' },
    ]);
    lapseDue.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    await expect(reconciler.reconcileAll(NOW)).resolves.toEqual({
      lapsed: 3,
      reissued: 0,
      failed: 0,
      waiting: 0,
    });
    expect(lapseDue).toHaveBeenCalledWith(TENANT_A, NOW);
    expect(lapseDue).toHaveBeenCalledWith(TENANT_B, NOW);
  });

  it("one tenant's failure never stops the others", async () => {
    tenants.mockResolvedValue([
      { tenantId: TENANT_A, schemaName: 'tenant_a' },
      { tenantId: TENANT_B, schemaName: 'tenant_b' },
    ]);
    lapseDue.mockRejectedValueOnce(new Error('connection terminated')).mockResolvedValueOnce(4);
    await expect(reconciler.reconcileAll(NOW)).resolves.toMatchObject({ lapsed: 4 });
    expect(lapseDue).toHaveBeenCalledTimes(2);
  });

  it('does nothing when the tenant list is unavailable, and says so', async () => {
    tenants.mockRejectedValue(new Error('auth schema unavailable'));
    await expect(reconciler.reconcileAll(NOW)).resolves.toEqual({
      lapsed: 0,
      reissued: 0,
      failed: 0,
      waiting: 0,
    });
    expect(lapseDue).not.toHaveBeenCalled();
  });
});
