/**
 * ReportAssemblyService — dispatch, blocking verdict, and the explicit
 * not-yet-landed error (never a silent empty draft).
 */
import { BadRequestException } from '@nestjs/common';

import { BiomassReportAssembler } from '../../assembly/biomass.assembler';
import { EscapeReportAssembler } from '../../assembly/assemblers/escape.assembler';
import { LakselusReportAssembler } from '../../assembly/assemblers/lakselus.assembler';
import { RensefiskReportAssembler } from '../../assembly/assemblers/rensefisk.assembler';
import { SettefiskReportAssembler } from '../../assembly/assemblers/settefisk.assembler';
import { SlaktReportAssembler } from '../../assembly/assemblers/slakt.assembler';
import { ReportAssemblyService, ReportPrefillType } from '../../assembly/report-assembly.service';
import { manualRequired, fromRecords } from '../../assembly/provenance.types';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const siteId = 'ssssssss-ssss-4sss-8sss-ssssssssssss';

function makeService(fields: ReturnType<typeof fromRecords>[]): ReportAssemblyService {
  const draft = { draftPayload: { ok: true }, fields };
  const assemble = (): jest.Mock => jest.fn().mockResolvedValue(draft);
  const biomassAssembler: Pick<BiomassReportAssembler, 'assemble'> = { assemble: assemble() };
  const lakselusAssembler: Pick<LakselusReportAssembler, 'assemble'> = { assemble: assemble() };
  const settefiskAssembler: Pick<SettefiskReportAssembler, 'assemble'> = { assemble: assemble() };
  const rensefiskAssembler: Pick<RensefiskReportAssembler, 'assemble'> = { assemble: assemble() };
  const slaktAssembler: Pick<SlaktReportAssembler, 'assembleExecuted' | 'assemblePlanned'> = {
    assembleExecuted: assemble(),
    assemblePlanned: assemble(),
  };
  const escapeAssembler: Pick<EscapeReportAssembler, 'assemble'> = { assemble: assemble() };
  return new ReportAssemblyService(
    biomassAssembler as BiomassReportAssembler,
    lakselusAssembler as LakselusReportAssembler,
    settefiskAssembler as SettefiskReportAssembler,
    rensefiskAssembler as RensefiskReportAssembler,
    slaktAssembler as SlaktReportAssembler,
    escapeAssembler as EscapeReportAssembler,
  );
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

  it('assembles every REST + biomass type through its assembler (weekly types require a week)', async () => {
    const service = makeService([]);
    for (const [type, period] of [
      [ReportPrefillType.SEA_LICE, { year: 2026, week: 27 }],
      [ReportPrefillType.SMOLT, { year: 2026, month: 6 }],
      [ReportPrefillType.CLEANER_FISH, { year: 2026, month: 6 }],
      [ReportPrefillType.SLAUGHTER_EXECUTED, { year: 2026, week: 27 }],
      [ReportPrefillType.SLAUGHTER_PLANNED, { year: 2026, week: 29 }],
      // ESCAPE is incident-triggered — dispatches to its assembler with no period.
      [ReportPrefillType.ESCAPE, { year: 2026 }],
    ] as const) {
      const result = await service.assemble(tenantId, type, siteId, period);
      expect(result.reportType).toBe(type);
      expect(result.draftPayload).toEqual({ ok: true });
    }
    await expect(
      service.assemble(tenantId, ReportPrefillType.SEA_LICE, siteId, { year: 2026 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a type whose assembler has not landed, naming the tracked plan', async () => {
    const service = makeService([]);
    // WELFARE_EVENT / DISEASE_OUTBREAK assemblers have not landed yet (ESCAPE has).
    await expect(
      service.assemble(tenantId, ReportPrefillType.WELFARE_EVENT, siteId, { year: 2026 }),
    ).rejects.toThrow(/2026-07-06-mattilsynet-automated-reporting/);
  });
});
