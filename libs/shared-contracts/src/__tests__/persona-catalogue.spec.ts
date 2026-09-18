/**
 * FARM-AI PR-0 — persona catalogue specs.
 *
 * Pins the frozen composition (4 general tiers + 3 farm specialties × 3
 * tiers = 13), the no-supervisor-farm rule, canonical id round-trips, and
 * the requiredCapabilities pattern that PR-1's permission catalogue will
 * cross-check against (katalog ↔ yetenek SSoT sapmaz).
 */
import {
  AI_GENERAL_ASSISTANT_PICKER_ENTRY,
  AI_PERSONA_CATALOGUE,
  AI_SPECIALTY_CATALOGUE,
  DEFAULT_AI_PERSONA_ID,
  findAiPersona,
} from '../ai/persona-catalogue';
import { AI_PERSONA_ID_MAX_LENGTH, parseAiPersonaId } from '../ai/persona-id';

describe('AI_SPECIALTY_CATALOGUE', () => {
  it('has exactly the 4 specialties with unique ids', () => {
    expect(AI_SPECIALTY_CATALOGUE.map((s) => s.id)).toEqual([
      'general',
      'farm-water-health',
      'farm-production',
      'farm-operations',
    ]);
  });

  it('only general has requiresModule null; farm specialties require the farm module', () => {
    for (const s of AI_SPECIALTY_CATALOGUE) {
      if (s.id === 'general') {
        expect(s.requiresModule).toBeNull();
        expect(s.publishedTiers).toHaveLength(4);
      } else {
        expect(s.requiresModule).toBe('farm');
        expect(s.publishedTiers).not.toContain('supervisor');
      }
    }
  });
});

describe('AI_PERSONA_CATALOGUE (frozen derivation)', () => {
  it('has exactly 13 entries', () => {
    expect(AI_PERSONA_CATALOGUE).toHaveLength(13);
  });

  it('has unique ids, all ≤ AI_PERSONA_ID_MAX_LENGTH', () => {
    const ids = AI_PERSONA_CATALOGUE.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id.length).toBeLessThanOrEqual(AI_PERSONA_ID_MAX_LENGTH);
    }
  });

  it('contains NO supervisor farm persona (supervisor stays general-only)', () => {
    const supervisorFarm = AI_PERSONA_CATALOGUE.filter(
      (e) => e.tier === 'supervisor' && e.specialty !== 'general',
    );
    expect(supervisorFarm).toEqual([]);
    expect(AI_PERSONA_CATALOGUE.filter((e) => e.tier === 'supervisor')).toEqual([
      expect.objectContaining({ id: 'supervisor-v1' }),
    ]);
  });

  it('every id parses and round-trips through the grammar', () => {
    for (const e of AI_PERSONA_CATALOGUE) {
      const parsed = parseAiPersonaId(e.id);
      expect(parsed).toEqual({ tier: e.tier, specialty: e.specialty, version: 1 });
    }
  });

  it('legacy 4 ids are catalogue members (backward-compatible channels)', () => {
    for (const id of ['operator-v1', 'manager-v1', 'expert-v1', 'supervisor-v1']) {
      expect(findAiPersona(id)).not.toBeNull();
    }
  });

  it('requiredCapabilities: tier permission always, ai_specialties:farm only for farm specialties', () => {
    for (const e of AI_PERSONA_CATALOGUE) {
      expect(e.requiredCapabilities).toContain(`ai_personas:${e.tier}`);
      if (e.specialty === 'general') {
        expect(e.requiredCapabilities).toEqual([`ai_personas:${e.tier}`]);
      } else {
        expect(e.requiredCapabilities).toEqual([`ai_personas:${e.tier}`, 'ai_specialties:farm']);
      }
    }
  });

  it('display names follow `${specialty.name} (${tierLabel})`', () => {
    const e = findAiPersona('expert-farm-water-health-v1');
    expect(e?.name).toBe('Water & Health (Expert)');
    expect(findAiPersona('operator-v1')?.name).toBe('General Assistant (Operator)');
  });

  it('is deeply frozen (as const posture, mutation must not succeed silently)', () => {
    expect(Object.isFrozen(AI_PERSONA_CATALOGUE)).toBe(true);
    for (const e of AI_PERSONA_CATALOGUE) {
      expect(Object.isFrozen(e)).toBe(true);
    }
  });
});

describe('DEFAULT_AI_PERSONA_ID', () => {
  it('is a catalogue member', () => {
    expect(DEFAULT_AI_PERSONA_ID).toBe('operator-v1');
    expect(findAiPersona(DEFAULT_AI_PERSONA_ID)).not.toBeNull();
  });
});

describe('AI_GENERAL_ASSISTANT_PICKER_ENTRY (messaging id:null entry)', () => {
  it('is the null-id tenant-default entry with operator-tier permissions', () => {
    expect(AI_GENERAL_ASSISTANT_PICKER_ENTRY.id).toBeNull();
    expect(AI_GENERAL_ASSISTANT_PICKER_ENTRY.name).toBe('General AI Assistant');
    expect(AI_GENERAL_ASSISTANT_PICKER_ENTRY.requiredCapabilities).toEqual([
      'ai_personas:operator',
    ]);
    expect(Object.isFrozen(AI_GENERAL_ASSISTANT_PICKER_ENTRY)).toBe(true);
  });
});

describe('findAiPersona', () => {
  it('returns null for grammar-valid but non-catalogue ids', () => {
    expect(findAiPersona('operator-bogus-v1')).toBeNull();
    expect(findAiPersona('expert-general-v1')).toBeNull(); // non-canonical form
  });

  it('returns null for garbage', () => {
    expect(findAiPersona('')).toBeNull();
    expect(findAiPersona('not a persona')).toBeNull();
  });
});
