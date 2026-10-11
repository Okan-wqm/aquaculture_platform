/**
 * CreateChemicalHandler — structured storage fields persistence spec.
 *
 * FARM-E2E Finding 6: CreateChemicalInput declares storageTempMin/Max and
 * storageHumidityMin/Max, and the Chemical entity + Baseline migration carry
 * the columns, but the create handler dropped the four fields from its
 * chemicalRepo.create() payload — structured storage limits silently
 * disappeared on create while update-chemical persisted them via its
 * Object.assign spread.
 *
 * These tests pin that the four fields reach the repository create payload
 * (and therefore the INSERT) on create.
 */
import { createMockDataSource } from '@aquaculture/testing';

import { CreateChemicalHandler } from '../../handlers/create-chemical.handler';
import { CreateChemicalCommand } from '../../commands/create-chemical.command';
import { CreateChemicalInput } from '../../dto/create-chemical.input';
import { ChemicalType } from '../../entities/chemical.entity';
import type { FinanceSettingsService } from '../../../finance/services/finance-settings.service';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SITE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

describe('CreateChemicalHandler — storage fields (FARM-E2E Finding 6)', () => {
  function makeHarness() {
    const { mockDataSource, mockManager } = createMockDataSource();

    // Every tenantManagerRepo() call shares this repository mock (the factory's
    // getRepository returns a single fixed object). The underlying create calls,
    // in order: 1) chemical payload, 2) save() re-create, 3) chemicalSite
    // payload, 4) chemicalSite save() re-create.
    const repoCreate = jest.fn().mockImplementation((p: object) => ({ ...p }));
    const repoSave = jest.fn().mockImplementation(async (p: object) => ({ ...p }));
    const repoFindOne = jest
      .fn() // 1st call: site lookup; 2nd call: duplicate-code check
      .mockResolvedValueOnce({ id: SITE_ID, tenantId: TENANT, isDeleted: false })
      .mockResolvedValueOnce(null);

    (mockManager.getRepository as jest.Mock).mockReturnValue({
      create: repoCreate,
      save: repoSave,
      findOne: repoFindOne,
    });

    const financeSettings: Pick<FinanceSettingsService, 'getDefaultCurrency'> = {
      getDefaultCurrency: jest.fn().mockResolvedValue('TRY'),
    };

    const handler = new CreateChemicalHandler(
      mockDataSource,
      financeSettings as FinanceSettingsService,
    );

    return { handler, repoCreate, repoSave };
  }

  function makeInput(storage: Partial<CreateChemicalInput> = {}): CreateChemicalInput {
    return {
      name: 'Chlorine Dioxide',
      code: 'cdo-001',
      type: ChemicalType.DISINFECTANT,
      siteId: SITE_ID,
      unit: 'L',
      ...storage,
    };
  }

  it('passes the four structured storage fields into the chemical create payload', async () => {
    const { handler, repoCreate } = makeHarness();

    await handler.execute(
      new CreateChemicalCommand(
        makeInput({
          storageRequirements: 'Cool, dry, ventilated area',
          storageTempMin: 2,
          storageTempMax: 8,
          storageHumidityMin: 40,
          storageHumidityMax: 60,
        }),
        TENANT,
        USER,
      ),
    );

    // First underlying create call = the chemical payload assembled by the
    // handler (later calls come from save() and the chemicalSite link).
    const chemicalPayload = repoCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(chemicalPayload).toMatchObject({
      storageTempMin: 2,
      storageTempMax: 8,
      storageHumidityMin: 40,
      storageHumidityMax: 60,
      tenantId: TENANT,
    });
  });

  it('returns the saved chemical with the storage fields intact', async () => {
    const { handler } = makeHarness();

    const result = await handler.execute(
      new CreateChemicalCommand(
        makeInput({
          storageTempMin: 4,
          storageTempMax: 10,
          storageHumidityMin: 30,
          storageHumidityMax: 70,
        }),
        TENANT,
        USER,
      ),
    );

    expect(result.storageTempMin).toBe(4);
    expect(result.storageTempMax).toBe(10);
    expect(result.storageHumidityMin).toBe(30);
    expect(result.storageHumidityMax).toBe(70);
  });
});
