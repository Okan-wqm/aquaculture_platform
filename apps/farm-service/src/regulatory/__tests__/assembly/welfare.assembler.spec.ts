/**
 * WelfareReportAssembler — the welfare varsling assembles from the site's latest
 * welfare_assessment: indicator scores as RECORDS, severity DERIVED from the
 * worst score (3 → critical, 2 → high), and the regulatory welfareEventType +
 * mortality rate left MANUAL_REQUIRED (the scores cannot classify the event).
 * A healthy assessment (worst ≤ 1) or no assessment blocks (fail-closed).
 */
import { createMockDataSource } from '@aquaculture/testing';

import { WelfareReportAssembler } from '../../assembly/assemblers/welfare.assembler';
import { ReportFieldProvenance } from '../../assembly/provenance.types';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const siteId = 'ssssssss-ssss-4sss-8sss-ssssssssssss';

function makeAssembler(rows: unknown[]): WelfareReportAssembler {
  const { mockDataSource, mockQueryRunner } = createMockDataSource();
  (mockQueryRunner.query as jest.Mock).mockImplementation((sql: string) => {
    if (sql.includes('FROM welfare_assessments')) return Promise.resolve(rows);
    return Promise.resolve([]);
  });
  return new WelfareReportAssembler(mockDataSource);
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 'wa-1',
  assessedAt: '2026-06-12',
  fishSampled: 100,
  gillScore: 1,
  finScore: 2,
  woundScore: 0,
  deformityScore: 0,
  tankCode: 'MERD-03',
  ...over,
});

describe('WelfareReportAssembler', () => {
  it('surfaces the assessment scores as RECORDS and derives severity from the worst score', async () => {
    const assembler = makeAssembler([row({ gillScore: 3, finScore: 1 })]);

    const { draftPayload, fields } = await assembler.assemble(tenantId, siteId);

    expect(draftPayload.assessmentId).toBe('wa-1');
    expect(draftPayload.worstScore).toBe(3);
    expect(draftPayload.severity).toBe('critical');
    expect(fields.find((f) => f.path === '/gillScore')?.provenance).toBe(
      ReportFieldProvenance.RECORDS,
    );
    expect(fields.find((f) => f.path === '/severity')?.provenance).toBe(
      ReportFieldProvenance.RECORDS,
    );
  });

  it('derives "high" severity from a worst score of 2', async () => {
    const assembler = makeAssembler([row({ gillScore: 2, finScore: 1 })]);
    const { draftPayload } = await assembler.assemble(tenantId, siteId);
    expect(draftPayload.severity).toBe('high');
  });

  it('leaves the regulatory welfareEventType MANUAL_REQUIRED (scores cannot classify it)', async () => {
    const assembler = makeAssembler([row({ finScore: 3 })]);
    const { fields } = await assembler.assemble(tenantId, siteId);
    expect(fields.find((f) => f.path === '/welfareEventType')).toMatchObject({
      provenance: ReportFieldProvenance.MANUAL_REQUIRED,
      blocking: true,
    });
  });

  it('blocks severity when the latest assessment shows no impairment (worst ≤ 1)', async () => {
    const assembler = makeAssembler([
      row({ gillScore: 1, finScore: 0, woundScore: 1, deformityScore: 0 }),
    ]);
    const { draftPayload, fields } = await assembler.assemble(tenantId, siteId);
    expect(draftPayload.severity).toBe('');
    expect(fields.find((f) => f.path === '/severity')).toMatchObject({
      provenance: ReportFieldProvenance.MANUAL_REQUIRED,
      blocking: true,
    });
  });

  it('blocks the whole draft when the site has no welfare assessment', async () => {
    const assembler = makeAssembler([]);
    const { draftPayload, fields } = await assembler.assemble(tenantId, siteId);
    expect(draftPayload.assessmentId).toBeNull();
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ path: '/', blocking: true });
  });
});
