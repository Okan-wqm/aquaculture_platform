import {
  AI_PERSONA_ID_MAX_LENGTH,
  AI_PERSONA_TIERS,
  AI_SPECIALTY_IDS,
  formatAiPersonaId,
  isAiPersonaId,
  parseAiPersonaId,
} from '../ai/persona-id';

/**
 * Persona id grammar (SSoT) — pins the parse rules every trust boundary
 * (gateway socket, messaging channel DTO, ai-service catalogue) relies on.
 */
describe('AI persona id grammar', () => {
  it('accepts the legacy general ids and composite specialist ids', () => {
    for (const id of [
      'operator-v1',
      'manager-v1',
      'expert-v1',
      'supervisor-v1',
      'expert-farm-production-v1',
      'operator-farm-water-health-v1',
      'supervisor-farm-water-health-v12',
    ]) {
      expect(isAiPersonaId(id)).toBe(true);
    }
  });

  it('parses tier / specialty / version, with general spelled by omission', () => {
    expect(parseAiPersonaId('operator-v1')).toEqual({
      tier: 'operator',
      specialty: 'general',
      version: 1,
    });
    expect(parseAiPersonaId('expert-farm-production-v3')).toEqual({
      tier: 'expert',
      specialty: 'farm-production',
      version: 3,
    });
  });

  it('rejects malformed, unknown-specialty and explicit-general spellings', () => {
    for (const id of [
      'expert-general-v1', // general is spelled by omission → one canonical string
      'farm-production-v1', // no tier prefix
      'operator-v', // no version
      'operator-v0', // versions start at 1
      'operator-v01', // canonical spelling only: no leading zeros (one string per persona)
      'expert-farm-production-v010',
      'Operator-v1', // case-sensitive
      'operator-hr-payroll-v1', // grammar-valid but unknown specialty
      'operator--v1',
      '',
    ]) {
      expect(parseAiPersonaId(id)).toBeNull();
    }
    // Grammar-only check still admits an unknown-but-well-formed specialty;
    // the catalogue lookup is what decides existence.
    expect(isAiPersonaId('operator-hr-payroll-v1')).toBe(true);
    expect(isAiPersonaId('expert-general-v1')).toBe(true);
    expect(isAiPersonaId(42)).toBe(false);
    expect(isAiPersonaId(null)).toBe(false);
  });

  it('formats every tier × specialty into an id that parses back identically', () => {
    for (const tier of AI_PERSONA_TIERS) {
      for (const specialty of AI_SPECIALTY_IDS) {
        const id = formatAiPersonaId({ tier, specialty, version: 1 });
        expect(id.length).toBeLessThanOrEqual(AI_PERSONA_ID_MAX_LENGTH);
        expect(parseAiPersonaId(id)).toEqual({ tier, specialty, version: 1 });
      }
    }
    expect(formatAiPersonaId({ tier: 'manager', specialty: 'general', version: 1 })).toBe(
      'manager-v1',
    );
  });

  it('rejects ids longer than the persisted column width', () => {
    const tooLong = `operator-${'a'.repeat(AI_PERSONA_ID_MAX_LENGTH)}-v1`;
    expect(isAiPersonaId(tooLong)).toBe(false);
  });
});
