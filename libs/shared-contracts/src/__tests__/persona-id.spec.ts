/**
 * FARM-AI PR-0 — persona id grammar specs.
 *
 * The grammar is a trust boundary shared by the gateway/ws persona gate and
 * the messaging channel validator; these specs pin the exact acceptance set
 * so a regex tweak cannot silently widen or narrow it.
 */
import {
  AI_PERSONA_ID_MAX_LENGTH,
  AI_PERSONA_ID_RE,
  formatAiPersonaId,
  isAiPersonaId,
  parseAiPersonaId,
} from '../ai/persona-id';

describe('isAiPersonaId (grammar-only gate)', () => {
  it.each([
    'operator-v1',
    'manager-v1',
    'expert-v1',
    'supervisor-v1',
    'operator-farm-water-health-v1',
    'manager-farm-production-v1',
    'expert-farm-operations-v1',
    'expert-farm-operations-v12',
  ])('accepts %s', (id) => {
    expect(isAiPersonaId(id)).toBe(true);
  });

  it.each([
    '',
    'Operator-v1', // case-sensitive grammar
    'operator', // missing version
    'operator-v', // empty version
    'operator-v1 ', // whitespace
    ' operator-v1',
    'admin-v1', // unknown tier is a GRAMMAR failure (tier alternation)
    'operator-v1-x', // trailing garbage
    'operator--v1', // empty specialty segment
    'operator-Farm-v1', // uppercase specialty
    'operator-farm_water-v1', // underscore is not a separator
    'operator--farm-v1',
    'operator-v-1',
    new Date(0), // non-string
    null,
    undefined,
    42,
  ])('rejects %s', (v) => {
    expect(isAiPersonaId(v)).toBe(false);
  });

  it('rejects ids longer than AI_PERSONA_ID_MAX_LENGTH', () => {
    const longSpecialty = 'a'.repeat(AI_PERSONA_ID_MAX_LENGTH);
    const id = `operator-${longSpecialty}-v1`;
    expect(id.length).toBeGreaterThan(AI_PERSONA_ID_MAX_LENGTH);
    expect(AI_PERSONA_ID_RE.test(id)).toBe(true); // regex alone would pass…
    expect(isAiPersonaId(id)).toBe(false); // …but the gate enforces the cap
  });
});

describe('parseAiPersonaId (grammar + known vocabulary)', () => {
  it('parses legacy ids as tier × general v1', () => {
    expect(parseAiPersonaId('operator-v1')).toEqual({
      tier: 'operator',
      specialty: 'general',
      version: 1,
    });
    expect(parseAiPersonaId('supervisor-v1')).toEqual({
      tier: 'supervisor',
      specialty: 'general',
      version: 1,
    });
  });

  it('parses composite farm ids', () => {
    expect(parseAiPersonaId('expert-farm-water-health-v1')).toEqual({
      tier: 'expert',
      specialty: 'farm-water-health',
      version: 1,
    });
  });

  it('keeps the numeric version as a number (multi-digit survives)', () => {
    expect(parseAiPersonaId('operator-v12')?.version).toBe(12);
  });

  it.each([
    'expert-general-v1', // general is written by ABSENCE — one canonical form only
    'operator-bogus-v1', // grammar-valid, unknown specialty
    'operator-general-v2',
    'king-farm-water-health-v1', // unknown tier
  ])('rejects %s (known-vocabulary check)', (id) => {
    expect(isAiPersonaId(id)).toBe(id.startsWith('king-') ? false : true); // grammar posture varies…
    expect(parseAiPersonaId(id)).toBeNull(); // …parse is uniformly strict
  });

  it('rejects malformed ids', () => {
    expect(parseAiPersonaId('operator_v1')).toBeNull();
    expect(parseAiPersonaId('operator-vX')).toBeNull();
    expect(parseAiPersonaId('')).toBeNull();
  });
});

describe('formatAiPersonaId (canonical inverse)', () => {
  it('writes general by absence', () => {
    expect(formatAiPersonaId({ tier: 'expert', specialty: 'general', version: 1 })).toBe(
      'expert-v1',
    );
    expect(formatAiPersonaId({ tier: 'operator', specialty: 'farm-operations', version: 3 })).toBe(
      'operator-farm-operations-v3',
    );
  });

  it('round-trips every parseable id (parse∘format = identity)', () => {
    const ids = [
      'operator-v1',
      'manager-v1',
      'expert-v1',
      'supervisor-v1',
      'operator-farm-water-health-v1',
      'manager-farm-production-v1',
      'expert-farm-operations-v1',
      'supervisor-v9',
    ];
    for (const id of ids) {
      const parsed = parseAiPersonaId(id);
      expect(parsed).not.toBeNull();
      if (parsed === null) continue; // narrowed — expectation above already failed
      expect(formatAiPersonaId(parsed)).toBe(id);
    }
  });
});
