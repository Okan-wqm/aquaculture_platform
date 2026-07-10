/**
 * Contract tests: the TS payload interfaces and the official JSON Schemas
 * (schemas/official/*.json) must describe the SAME wire format.
 *
 * The fixtures are typed against the interfaces and validated against the
 * schemas — drift in either direction fails here in CI, long before a
 * payload reaches Mattilsynet (RPT-017 companion gate).
 */
import { RegulatoryReportType } from '../../entities/regulatory-report.entity';
import {
  getOfficialSchemaValidator,
  isMattilsynetRestReportType,
  MattilsynetRestReportType,
} from '../../schemas/schema-registry';
import {
  seaLiceFixture,
  smoltFixture,
  cleanerFishFixture,
  plannedSlaughterFixture,
  executedSlaughterFixture,
} from './official-payload.fixtures';

const CASES: Array<{ type: MattilsynetRestReportType; fixture: object }> = [
  { type: RegulatoryReportType.SEA_LICE, fixture: seaLiceFixture },
  { type: RegulatoryReportType.SMOLT, fixture: smoltFixture },
  { type: RegulatoryReportType.CLEANER_FISH, fixture: cleanerFishFixture },
  { type: RegulatoryReportType.SLAUGHTER_PLANNED, fixture: plannedSlaughterFixture },
  { type: RegulatoryReportType.SLAUGHTER_EXECUTED, fixture: executedSlaughterFixture },
];

describe('Official Mattilsynet schema contract', () => {
  it.each(CASES)('$type golden fixture validates against the official schema', ({ type, fixture }) => {
    const validate = getOfficialSchemaValidator(type);
    const valid = validate(fixture);
    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  it.each(CASES)('$type schema survives a JSON round-trip of the fixture (wire shape)', ({ type, fixture }) => {
    const validate = getOfficialSchemaValidator(type);
    // What actually goes on the wire: JSON.stringify drops undefined keys.
    const wire: unknown = JSON.parse(JSON.stringify(fixture));
    expect(validate(wire)).toBe(true);
  });

  it('covers exactly the five REST report types (varsling + biomass have no REST schema)', () => {
    const restTypes = Object.values(RegulatoryReportType).filter(isMattilsynetRestReportType);
    expect(restTypes.sort()).toEqual(
      [
        RegulatoryReportType.SEA_LICE,
        RegulatoryReportType.CLEANER_FISH,
        RegulatoryReportType.SMOLT,
        RegulatoryReportType.SLAUGHTER_PLANNED,
        RegulatoryReportType.SLAUGHTER_EXECUTED,
      ].sort(),
    );
  });

  it.each(CASES)('$type schema rejects unknown top-level properties (strict wire format)', ({ type, fixture }) => {
    const validate = getOfficialSchemaValidator(type);
    expect(validate({ ...fixture, uventetFelt: 1 })).toBe(false);
  });
});
