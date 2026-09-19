import { describe, expect, it } from 'vitest';

import { aiPersonaDisplayName } from '../aiPersona';

describe('aiPersonaDisplayName', () => {
  it('maps catalogue persona ids to their shared display names', () => {
    expect(aiPersonaDisplayName('expert-v1')).toBe('Aquaculture Expert (General)');
    expect(aiPersonaDisplayName('operator-v1')).toBe('Operations Assistant (General)');
    expect(aiPersonaDisplayName('manager-v1')).toBe('Management Assistant (General)');
    expect(aiPersonaDisplayName('supervisor-v1')).toBe('SCADA Supervisor (General)');
    expect(aiPersonaDisplayName('expert-farm-production-v1')).toBe(
      'Production Specialist (Expert)',
    );
  });

  it('passes unknown persona ids through verbatim (never hides the persona)', () => {
    expect(aiPersonaDisplayName('future-persona-9')).toBe('future-persona-9');
  });

  it('returns null for missing personas so the caller falls back to the generic label', () => {
    expect(aiPersonaDisplayName(null)).toBeNull();
    expect(aiPersonaDisplayName(undefined)).toBeNull();
    expect(aiPersonaDisplayName('')).toBeNull();
  });
});
