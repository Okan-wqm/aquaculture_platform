import { describe, expect, it } from 'vitest';

import { aiPersonaDisplayName } from '../aiPersona';

describe('aiPersonaDisplayName', () => {
  it('maps known persona ids to their display names', () => {
    expect(aiPersonaDisplayName('expert-v1')).toBe('Farm Expert');
    expect(aiPersonaDisplayName('operator-v1')).toBe('Water Quality Specialist');
    expect(aiPersonaDisplayName('manager-v1')).toBe('Management Assistant');
    expect(aiPersonaDisplayName('supervisor-v1')).toBe('SCADA AI');
    expect(aiPersonaDisplayName('general')).toBe('General AI Assistant');
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
