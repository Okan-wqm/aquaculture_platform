import {
  AI_GENERAL_ASSISTANT_PICKER_ENTRY,
  AI_PERSONA_CATALOGUE,
  AI_PERSONA_COLORS,
  AI_PERSONA_ICONS,
  AI_SPECIALTY_CATALOGUE,
  DEFAULT_AI_PERSONA_ID,
  findAiPersona,
  AI_TIER_PRESENTATION,
} from '../ai/persona-catalogue';
import { AI_PERSONA_ID_MAX_LENGTH, parseAiPersonaId } from '../ai/persona-id';

/**
 * Persona catalogue (SSoT) — pins the derived shape every consumer (ai-service
 * composition, messaging picker, gateway validation, web/mobile pickers)
 * depends on.
 */
describe('AI_PERSONA_CATALOGUE (SSoT)', () => {
  it('is derived as specialty × publishedTiers — 4 general + 3 farm specialists × 3 tiers', () => {
    expect(AI_PERSONA_CATALOGUE).toHaveLength(13);
    expect(AI_PERSONA_CATALOGUE.map((e) => e.id)).toEqual([
      'operator-v1',
      'manager-v1',
      'expert-v1',
      'supervisor-v1',
      'operator-farm-water-health-v1',
      'manager-farm-water-health-v1',
      'expert-farm-water-health-v1',
      'operator-farm-production-v1',
      'manager-farm-production-v1',
      'expert-farm-production-v1',
      'operator-farm-operations-v1',
      'manager-farm-operations-v1',
      'expert-farm-operations-v1',
    ]);
  });

  it('never publishes a farm specialist at the supervisor tier (no autonomy for advisors)', () => {
    const supervisorSpecialists = AI_PERSONA_CATALOGUE.filter(
      (e) => e.tier === 'supervisor' && e.specialty !== 'general',
    );
    expect(supervisorSpecialists).toEqual([]);
  });

  it('every id is unique, parseable, consistent with its entry and fits the column', () => {
    const ids = new Set<string>();
    for (const entry of AI_PERSONA_CATALOGUE) {
      expect(ids.has(entry.id)).toBe(false);
      ids.add(entry.id);
      expect(entry.id.length).toBeLessThanOrEqual(AI_PERSONA_ID_MAX_LENGTH);
      expect(parseAiPersonaId(entry.id)).toEqual({
        tier: entry.tier,
        specialty: entry.specialty,
        version: 1,
      });
    }
  });

  it('requires the tier capability, plus the module capability for module-gated specialties', () => {
    expect(findAiPersona('operator-v1')?.requiredCapabilities).toEqual(['ai_personas:operator']);
    expect(findAiPersona('expert-farm-production-v1')?.requiredCapabilities).toEqual([
      'ai_personas:expert',
      'ai_specialties:farm',
    ]);
    for (const entry of AI_PERSONA_CATALOGUE) {
      const specialty = AI_SPECIALTY_CATALOGUE[entry.specialty];
      expect(entry.requiredCapabilities[0]).toBe(`ai_personas:${entry.tier}`);
      expect(entry.requiredCapabilities.length).toBe(specialty.requiresModule === null ? 1 : 2);
    }
  });

  it('uses only icons and colours the pickers know how to render', () => {
    for (const entry of AI_PERSONA_CATALOGUE) {
      expect(AI_PERSONA_ICONS).toContain(entry.icon);
      expect(AI_PERSONA_COLORS).toContain(entry.color);
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.capabilities.length).toBeGreaterThan(0);
    }
    expect(AI_PERSONA_ICONS).toContain(AI_GENERAL_ASSISTANT_PICKER_ENTRY.icon);
  });

  it('is frozen at every level so a hand-edit cannot mutate it at runtime', () => {
    expect(Object.isFrozen(AI_PERSONA_CATALOGUE)).toBe(true);
    for (const entry of AI_PERSONA_CATALOGUE) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.capabilities)).toBe(true);
      expect(Object.isFrozen(entry.requiredCapabilities)).toBe(true);
    }
    // The SOURCE catalogues too — a mutation there would leak into the next
    // derivation and into every picker that reads them directly.
    for (const tier of Object.values(AI_TIER_PRESENTATION)) {
      expect(Object.isFrozen(tier)).toBe(true);
      expect(Object.isFrozen(tier.capabilities)).toBe(true);
    }
    for (const specialty of Object.values(AI_SPECIALTY_CATALOGUE)) {
      expect(Object.isFrozen(specialty)).toBe(true);
      expect(Object.isFrozen(specialty.capabilities)).toBe(true);
      expect(Object.isFrozen(specialty.publishedTiers)).toBe(true);
    }
    expect(Object.isFrozen(AI_GENERAL_ASSISTANT_PICKER_ENTRY.capabilities)).toBe(true);
  });

  it('findAiPersona resolves published ids only; the default persona is published', () => {
    expect(findAiPersona(DEFAULT_AI_PERSONA_ID)?.id).toBe('operator-v1');
    expect(findAiPersona('supervisor-farm-production-v1')).toBeUndefined();
    expect(findAiPersona('expert-general-v1')).toBeUndefined();
    expect(findAiPersona('bogus-v1')).toBeUndefined();
  });

  it('renames the legacy general personas so they no longer collide with the specialists', () => {
    expect(findAiPersona('operator-v1')?.name).toBe('Operations Assistant (General)');
    expect(findAiPersona('expert-v1')?.name).toBe('Aquaculture Expert (General)');
    expect(findAiPersona('expert-farm-water-health-v1')?.name).toBe(
      'Water & Fish Health Specialist (Expert)',
    );
    expect(AI_GENERAL_ASSISTANT_PICKER_ENTRY.id).toBeNull();
  });
});
