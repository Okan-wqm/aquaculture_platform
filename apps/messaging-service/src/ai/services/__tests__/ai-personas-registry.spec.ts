import 'reflect-metadata';
import {
  AI_PERSONA_CATALOGUE,
  findAiPersona,
} from '@aquaculture/shared-contracts';

import { AiPersonasRegistryService } from '../ai-personas-registry.service';

/**
 * FARM-AI (Sprint 2.3 registry slice) — the messaging persona listing is
 * SOURCED from the frozen shared-contracts catalogue (the same SSoT ai-service
 * composes personas from). Shape stays exactly the GraphQL AiPersonaType
 * contract so the admin panel + aquamobil pickers keep working.
 */
describe('AiPersonasRegistryService — catalogue-backed listing (FARM-AI)', () => {
  const service = new AiPersonasRegistryService();

  it('lists the id:null tenant-default entry first, then all 13 catalogue personas', () => {
    const personas = service.getAvailablePersonas('any-tenant');
    expect(personas).toHaveLength(14);
    expect(personas[0]).toMatchObject({ id: null, name: 'General AI Assistant' });
    expect(personas.slice(1).map((p) => p.id)).toEqual(
      AI_PERSONA_CATALOGUE.map((e) => e.id),
    );
  });

  it('every listed persona resolves in the shared catalogue (or is the null default)', () => {
    for (const persona of service.getAvailablePersonas('any-tenant')) {
      if (persona.id === null) continue;
      expect(findAiPersona(persona.id)).not.toBeNull();
    }
  });

  it('carries the full wire shape (GraphQL AiPersonaType compatibility)', () => {
    for (const persona of service.getAvailablePersonas('any-tenant')) {
      expect(typeof persona.name).toBe('string');
      expect(typeof persona.description).toBe('string');
      expect(typeof persona.icon).toBe('string');
      expect(typeof persona.color).toBe('string');
      expect(Array.isArray(persona.capabilities)).toBe(true);
      expect(persona.capabilities.length).toBeGreaterThan(0);
    }
  });

  it('returns defensive copies — callers cannot mutate the frozen listing', () => {
    const first = service.getAvailablePersonas('t');
    first[1]?.capabilities.push('MUTATED');
    const second = service.getAvailablePersonas('t');
    expect(second[1]?.capabilities).not.toContain('MUTATED');
  });
});
