/**
 * MattilsynetSchemaValidatorService — pre-submit official-schema gate.
 *
 * Pure service (no collaborators): valid payloads come back branded and
 * unchanged; invalid payloads throw MattilsynetSchemaValidationError with
 * field-level valideringsfeil in the regulator's {felt, melding} shape.
 */
import { RegulatoryReportType } from '../entities/regulatory-report.entity';
import {
  MattilsynetSchemaValidatorService,
  MattilsynetSchemaValidationError,
} from '../services/mattilsynet-schema-validator.service';
import { SeaLicePayload, SmoltPayload } from '../mattilsynet-api.service';
import { seaLiceFixture, smoltFixture } from './contract/official-payload.fixtures';

describe('MattilsynetSchemaValidatorService', () => {
  const service = new MattilsynetSchemaValidatorService();

  function expectValidationError(fn: () => unknown): MattilsynetSchemaValidationError {
    try {
      fn();
    } catch (error) {
      if (error instanceof MattilsynetSchemaValidationError) {
        return error;
      }
      throw error;
    }
    throw new Error('expected MattilsynetSchemaValidationError to be thrown');
  }

  it('returns the exact payload object on success (branding does not clone or mutate)', () => {
    const validated = service.validate(RegulatoryReportType.SEA_LICE, seaLiceFixture);
    expect(validated).toBe(seaLiceFixture);
  });

  it('reports a missing required field with its dotted path', () => {
    const { lusetelling: _dropped, ...rest } = seaLiceFixture;
    const error = expectValidationError(() =>
      service.validate(RegulatoryReportType.SEA_LICE, rest as SeaLicePayload),
    );
    expect(error.valideringsfeil).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ felt: 'lusetelling' }),
      ]),
    );
  });

  it('reports a nested violation with the full dotted path', () => {
    const payload: SeaLicePayload = {
      ...seaLiceFixture,
      lusetelling: { ...seaLiceFixture.lusetelling, voksneHunnlus: -1 },
    };
    const error = expectValidationError(() =>
      service.validate(RegulatoryReportType.SEA_LICE, payload),
    );
    expect(error.valideringsfeil).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ felt: 'lusetelling.voksneHunnlus' }),
      ]),
    );
  });

  it('rejects a malformed organisasjonsnummer (official 9-digit pattern)', () => {
    const payload: SeaLicePayload = { ...seaLiceFixture, organisasjonsnummer: '12345' };
    const error = expectValidationError(() =>
      service.validate(RegulatoryReportType.SEA_LICE, payload),
    );
    expect(error.valideringsfeil).toEqual(
      expect.arrayContaining([expect.objectContaining({ felt: 'organisasjonsnummer' })]),
    );
  });

  it('rejects an array-item violation with the indexed path (produksjonsenheter.0.artskode)', () => {
    const payload: SmoltPayload = {
      ...smoltFixture,
      produksjonsenheter: smoltFixture.produksjonsenheter.map((unit) => ({
        ...unit,
        artskode: 'salmon',
      })),
    };
    const error = expectValidationError(() =>
      service.validate(RegulatoryReportType.SMOLT, payload),
    );
    expect(error.valideringsfeil).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ felt: 'produksjonsenheter.0.artskode' }),
      ]),
    );
  });

  it('collects ALL violations in one pass (allErrors), not just the first', () => {
    const payload: SeaLicePayload = {
      ...seaLiceFixture,
      organisasjonsnummer: 'bad',
      rapporteringsuke: 99,
    };
    const error = expectValidationError(() =>
      service.validate(RegulatoryReportType.SEA_LICE, payload),
    );
    const felter = error.valideringsfeil.map((v) => v.felt);
    expect(felter).toEqual(expect.arrayContaining(['organisasjonsnummer', 'rapporteringsuke']));
  });
});
