/**
 * ReportAssemblyService — dispatch, blocking verdict, and the explicit
 * not-yet-landed error (never a silent empty draft).
 */
import { BadRequestException } from '@nestjs/common';

import { BiomassReportAssembler } from '../../assembly/biomass.assembler';
import { DiseaseReportAssembler } from '../../assembly/assemblers/disease.assembler';
import { EscapeReportAssembler } from '../../assembly/assemblers/escape.assembler';
import { LakselusReportAssembler } from '../../assembly/assemblers/lakselus.assembler';
import { RensefiskReportAssembler } from '../../assembly/assemblers/rensefisk.assembler';
import { SettefiskReportAssembler } from '../../assembly/assemblers/settefisk.assembler';
import { SlaktReportAssembler } from '../../assembly/assemblers/slakt.assembler';
import { WelfareReportAssembler } from '../../assembly/assemblers/welfare.assembler';
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
  const welfareAssembler: Pick<WelfareReportAssembler, 'assemble'> = { assemble: assemble() };
  const diseaseAssembler: Pick<DiseaseReportAssembler, 'assemble'> = { assemble: assemble() };
  return new ReportAssemblyService(
    biomassAssembler as BiomassReportAssembler,
    lakselusAssembler as LakselusReportAssembler,
    settefiskAssembler as SettefiskReportAssembler,
    rensefiskAssembler as RensefiskReportAssembler,
    slaktAssembler as SlaktReportAssembler,
    escapeAssembler as EscapeReportAssembler,
    welfareAssembler as WelfareReportAssembler,
    diseaseAssembler as DiseaseReportAssembler,
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
      // The three varsling types are incident/event-triggered — dispatch to
      // their assemblers with no period.
      [ReportPrefillType.ESCAPE, { year: 2026 }],
      [ReportPrefillType.WELFARE_EVENT, { year: 2026 }],
      [ReportPrefillType.DISEASE_OUTBREAK, { year: 2026 }],
    ] as const) {
      const result = await service.assemble(tenantId, type, siteId, period);
      expect(result.reportType).toBe(type);
      expect(result.draftPayload).toEqual({ ok: true });
    }
    await expect(
      service.assemble(tenantId, ReportPrefillType.SEA_LICE, siteId, { year: 2026 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // Every ReportPrefillType now has an assembler (all five REST + biomass + the
  // three varsling types), so no valid type reaches the defensive default
  // branch. The "not-yet-landed" throw is retained in source as an exhaustiveness
  // guard for future enum additions but is unreachable by the current values.
});
