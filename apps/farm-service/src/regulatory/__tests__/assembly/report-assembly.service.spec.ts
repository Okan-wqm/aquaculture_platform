/**
 * ReportAssemblyService — dispatch, blocking verdict, and the explicit
 * not-yet-landed error (never a silent empty draft).
 */
import { BadRequestException } from '@nestjs/common';

import { BiomassReportAssembler } from '../../assembly/biomass.assembler';
import {
  ReportAssemblyService,
  ReportPrefillType,
} from '../../assembly/report-assembly.service';
import { manualRequired, fromRecords } from '../../assembly/provenance.types';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const siteId = 'ssssssss-ssss-4sss-8sss-ssssssssssss';

function makeService(fields: ReturnType<typeof fromRecords>[]): ReportAssemblyService {
  const biomassAssembler: Pick<BiomassReportAssembler, 'assemble'> = {
    assemble: jest.fn().mockResolvedValue({ draftPayload: { ok: true }, fields }),
  };
  return new ReportAssemblyService(biomassAssembler as BiomassReportAssembler);
}

describe('ReportAssemblyService', () => {
  it('assembles BIOMASS and reports schemaValid=true with zero blocking fields', async () => {
    const service = makeService([fromRecords('/currentBiomass', 'q', 3)]);

    const result = await service.assemble(tenantId, ReportPrefillType.BIOMASS, siteId, {
      year: 2026,
      month: 6,
    });

    expect(result.reportType).toBe(ReportPrefillType.BIOMASS);
    expect(result.periodMonth).toBe(6);
    expect(result.schemaValid).toBe(true);
    expect(result.draftPayload).toEqual({ ok: true });
  });

  it('schemaValid=false when any blocking MANUAL_REQUIRED field remains', async () => {
    const service = makeService([manualRequired('/x', 'missing', true)]);

    const result = await service.assemble(tenantId, ReportPrefillType.BIOMASS, siteId, {
      year: 2026,
      month: 6,
    });

    expect(result.schemaValid).toBe(false);
  });

  it('rejects BIOMASS without a month', async () => {
    const service = makeService([]);
    await expect(
      service.assemble(tenantId, ReportPrefillType.BIOMASS, siteId, { year: 2026 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a type whose assembler has not landed, naming the tracked plan', async () => {
    const service = makeService([]);
    await expect(
      service.assemble(tenantId, ReportPrefillType.SEA_LICE, siteId, { year: 2026, week: 27 }),
    ).rejects.toThrow(/2026-07-06-mattilsynet-automated-reporting/);
  });
});
