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
  reshapeForWire,
  type WireHeader,
} from '../../services/regulatory-draft-submission.service';
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

/**
 * FARM-HIGH-002 / CONTRACT-HIGH-003 — the slaughter assemblers emit a FLAT,
 * review-friendly body (`arter` / `ukeplanPerArt` at the top level, plus the
 * assembler-only `totalKgPerArt`), but the official schema requires the species
 * arrays nested inside a single-locality wrapper and forbids unknown top-level
 * keys (additionalProperties:false). `reshapeForWire` is the ONLY place that
 * bridges the two; before it, every slaughter draft failed validation and could
 * never be submitted. These tests validate the reshape OUTPUT against the REAL
 * official schema (not a hand-written fixture), so a future assembler/reshape
 * change that re-breaks the wire shape fails here in CI.
 */
describe('reshapeForWire → official schema (slaughter drafts, FARM-HIGH-002)', () => {
  const header: WireHeader = {
    klientReferanse: 'draft-1',
    organisasjonsnummer: '987654321',
    lokalitetsnummer: 12345,
    kontaktperson: { navn: 'Kari Nordmann', epost: 'kari@oppdrett.no', telefonnummer: '+4791234567' },
  };

  it('wraps an assembled EXECUTED body into a schema-valid utførteLokaliteter payload', () => {
    // Exactly what SlaktReportAssembler.assembleExecuted emits (flat + the
    // assembler-only totalKgPerArt that MUST be dropped from the wire).
    const assembledBody = {
      slakteuke: 27,
      slakteår: 2026,
      godkjenningsnummer: 'S123',
      arter: [
        { art: 'SAL', superiorKg: 18000, ordinærKg: 2500, produksjonsfiskKg: 900, utkastKg: 40 },
      ],
      totalKgPerArt: [{ artskode: 'SAL', totalKg: 21440 }],
    };

    const wire = reshapeForWire(RegulatoryReportType.SLAUGHTER_EXECUTED, assembledBody, header);
    // The actual wire bytes (JSON round-trip drops undefined keys); JSON.parse
    // yields the plain object the validator and key checks both read.
    const onWire: Record<string, unknown> = JSON.parse(JSON.stringify(wire));
    // The flat arter + assembler-only totalKgPerArt are gone from the top level.
    expect(onWire.arter).toBeUndefined();
    expect(onWire.totalKgPerArt).toBeUndefined();
    expect(onWire.utførteLokaliteter).toBeDefined();

    const validate = getOfficialSchemaValidator(RegulatoryReportType.SLAUGHTER_EXECUTED);
    const valid = validate(onWire);
    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  it('wraps an assembled PLANNED body into a schema-valid planlagteLokaliteter payload', () => {
    const assembledBody = {
      uke: 29,
      år: 2026,
      godkjenningsnummer: 'S123',
      ukeplanPerArt: [{ artskode: 'SAL', mandagKg: 12000, torsdagKg: 8000 }],
    };

    const wire = reshapeForWire(RegulatoryReportType.SLAUGHTER_PLANNED, assembledBody, header);
    const onWire: Record<string, unknown> = JSON.parse(JSON.stringify(wire));
    expect(onWire.ukeplanPerArt).toBeUndefined();
    expect(onWire.planlagteLokaliteter).toBeDefined();

    const validate = getOfficialSchemaValidator(RegulatoryReportType.SLAUGHTER_PLANNED);
    const valid = validate(onWire);
    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });
});
