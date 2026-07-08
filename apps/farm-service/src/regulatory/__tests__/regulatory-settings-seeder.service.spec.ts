/**
 * RegulatorySettingsSeederService — Unit Tests
 *
 * Phase 7.5 onboarding seeder. The service is thin so the test suite
 * pins:
 *
 *   1. Fresh tenant → one row created with Maskinporten env=TEST and
 *      empty credential columns.
 *   2. Existing tenant → no new row (idempotent; matches the unique
 *      `(tenantId)` constraint).
 *   3. Return shape matches the onboarding handler's aggregate log
 *      contract — `{ seeded: string[]; skipped: string[] }`.
 */
import type { Repository } from 'typeorm';

import { RegulatorySettingsSeederService } from '../services/regulatory-settings-seeder.service';
import { RegulatorySettings } from '../entities/regulatory-settings.entity';

function makeRepo(existing: RegulatorySettings | null): {
  repo: Repository<RegulatorySettings>;
  calls: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
} {
  const findOne = jest.fn().mockResolvedValue(existing);
  const create = jest.fn().mockImplementation((payload: Partial<RegulatorySettings>) => payload);
  const save = jest
    .fn()
    .mockImplementation(async (payload: Partial<RegulatorySettings>) => ({
      id: 'generated-uuid',
      ...payload,
    }));
  const repo = {
    findOne,
    create,
    save,
  } as unknown as Repository<RegulatorySettings>;
  return { repo, calls: { findOne, create, save } };
}

describe('RegulatorySettingsSeederService', () => {
  const TENANT_A = '11111111-1111-4111-8111-111111111111';

  it('creates a skeleton row with Maskinporten env=TEST on fresh tenant', async () => {
    const { repo, calls } = makeRepo(null);
    const service = new RegulatorySettingsSeederService(repo);

    const result = await service.seedDefaults(TENANT_A);

    expect(calls.findOne).toHaveBeenCalledWith({
      where: { tenantId: TENANT_A },
      select: ['id'],
    });
    expect(calls.create).toHaveBeenCalledWith({
      tenantId: TENANT_A,
      maskinportenEnvironment: 'TEST',
    });
    expect(calls.save).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      seeded: ['regulatory-settings'],
      skipped: [],
    });
  });

  it('skips when a row already exists for the tenant (idempotent)', async () => {
    const existing = { id: 'existing-row-id' } as RegulatorySettings;
    const { repo, calls } = makeRepo(existing);
    const service = new RegulatorySettingsSeederService(repo);

    const result = await service.seedDefaults(TENANT_A);

    expect(calls.findOne).toHaveBeenCalledTimes(1);
    expect(calls.create).not.toHaveBeenCalled();
    expect(calls.save).not.toHaveBeenCalled();
    expect(result).toEqual({
      seeded: [],
      skipped: ['regulatory-settings'],
    });
  });

  it('does not leak credentials — only non-secret defaults are written', async () => {
    const { repo, calls } = makeRepo(null);
    const service = new RegulatorySettingsSeederService(repo);

    await service.seedDefaults(TENANT_A);

    const payload = calls.create.mock.calls[0]![0];
    expect(payload).not.toHaveProperty('maskinportenClientId');
    expect(payload).not.toHaveProperty('maskinportenPrivateKeyEncrypted');
    expect(payload).not.toHaveProperty('maskinportenKeyId');
    expect(payload).not.toHaveProperty('slaughterApprovalNumber');
    expect(payload).not.toHaveProperty('companyName');
  });
});
