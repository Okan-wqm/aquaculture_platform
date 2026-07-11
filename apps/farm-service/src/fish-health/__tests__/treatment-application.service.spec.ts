/**
 * TreatmentApplicationService — fail-closed write boundary: only official
 * Mattilsynet method/virkestoff/enhet values are persisted, so every stored
 * row is emittable verbatim by the lakselus assembler.
 */
import { BadRequestException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

const runInTenantTransaction = jest.fn();
const tenantManagerRepo = jest.fn();

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantTransaction: (ds: unknown, schema: string, tenantId: string, cb: unknown) =>
    runInTenantTransaction(ds, schema, tenantId, cb),
  tenantManagerRepo: (manager: unknown, entity: unknown, tenantId: string) =>
    tenantManagerRepo(manager, entity, tenantId),
}));

import { TreatmentApplicationService } from '../services/treatment-application.service';
import { TreatmentCategory } from '../entities/treatment-application.entity';
import { RecordTreatmentApplicationInput } from '../dto/field-capture.inputs';

const TENANT = 'aaaaaaaa-1111-4222-8333-444444444444';
const USER = 'uuuuuuuu-1111-4222-8333-444444444444';

function setup(): { service: TreatmentApplicationService; save: jest.Mock } {
  runInTenantTransaction.mockImplementation(
    async (
      _ds,
      _schema,
      _tenant,
      cb: (qr: { manager: Partial<EntityManager> }) => Promise<unknown>,
    ) => cb({ manager: {} as Partial<EntityManager> }),
  );
  const save = jest.fn(async (values: object) => ({ id: 'ta-1', ...values }));
  tenantManagerRepo.mockReturnValue({ create: (values: object) => values, save });
  return {
    service: new TreatmentApplicationService({} as Partial<DataSource> as DataSource),
    save,
  };
}

function medicinal(
  overrides: Partial<RecordTreatmentApplicationInput> = {},
): RecordTreatmentApplicationInput {
  return {
    siteId: 'site-1',
    category: TreatmentCategory.MEDICINAL,
    method: 'BADEBEHANDLING',
    virkestoffType: 'AZAMETHIPHOS',
    appliedAt: '2026-07-01T08:00:00Z',
    ...overrides,
  };
}

describe('TreatmentApplicationService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('persists a valid medicinal application with the recorder stamped', async () => {
    const { service } = setup();

    const saved = await service.record(TENANT, medicinal(), USER);

    expect(saved).toMatchObject({
      tenantId: TENANT,
      category: TreatmentCategory.MEDICINAL,
      method: 'BADEBEHANDLING',
      virkestoffType: 'AZAMETHIPHOS',
      recordedBy: USER,
    });
  });

  it('persists a valid non-medicinal application', async () => {
    const { service } = setup();

    const saved = await service.record(
      TENANT,
      medicinal({
        category: TreatmentCategory.NON_MEDICINAL,
        method: 'TERMISK_BEHANDLING',
        virkestoffType: undefined,
      }),
      USER,
    );

    expect(saved).toMatchObject({ method: 'TERMISK_BEHANDLING' });
  });

  const rejects = async (
    service: TreatmentApplicationService,
    input: RecordTreatmentApplicationInput,
  ): Promise<void> => {
    await expect(service.record(TENANT, input, USER)).rejects.toBeInstanceOf(BadRequestException);
  };

  it('rejects a medicinal application without a virkestoff', async () => {
    const { service, save } = setup();
    await rejects(service, medicinal({ virkestoffType: undefined }));
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects an unofficial method for the category', async () => {
    const { service } = setup();
    await rejects(service, medicinal({ method: 'TERMISK_BEHANDLING' }));
    await rejects(
      service,
      medicinal({
        category: TreatmentCategory.NON_MEDICINAL,
        method: 'BADEBEHANDLING',
        virkestoffType: undefined,
      }),
    );
  });

  it('rejects an unofficial virkestoff value', async () => {
    const { service } = setup();
    await rejects(service, medicinal({ virkestoffType: 'Salmosan' }));
  });

  it('rejects ANNET_VIRKESTOFF without a description naming the substance', async () => {
    const { service } = setup();
    await rejects(service, medicinal({ virkestoffType: 'ANNET_VIRKESTOFF' }));
  });

  it('rejects a virkestoff on a non-medicinal application', async () => {
    const { service } = setup();
    await rejects(
      service,
      medicinal({ category: TreatmentCategory.NON_MEDICINAL, method: 'MEKANISK_BEHANDLING' }),
    );
  });

  it('rejects unofficial styrke/mengde units and half-provided pairs', async () => {
    const { service } = setup();
    await rejects(service, medicinal({ styrkeVerdi: 0.5, styrkeEnhet: 'mg/l' }));
    await rejects(service, medicinal({ mengdeVerdi: 10 }));
  });
});
