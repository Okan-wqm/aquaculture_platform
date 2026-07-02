import { describe, expect, it } from 'vitest';

import { cardToEngineInputs, cardValue } from '../engine-adapter';
import { createCard } from '../useWcCards';

describe('card → engine inputs (P2 card model)', () => {
  it('a default tank card is engine-ready: sensor pH + manual alkalinity', () => {
    const card = createCard({ kind: 'tank', id: 't1' }, 'salmon_freshwater', 'Outlet');
    // pH auto-bound to the tank sensor PH-T1 (7.4); alkalinity has no sensor → manual default
    expect(card.paramSources.ph.mode).toBe('sensor');
    expect(cardValue(card, 'ph')).toBe(7.4);
    expect(card.paramSources.alkalinity.mode).toBe('manual');
    const inputs = cardToEngineInputs(card);
    expect(inputs).not.toBeNull();
    expect(inputs?.pH).toBe(7.4);
    expect(inputs?.alkalinityMeq).toBeGreaterThan(0);
  });

  it('a manual override is reflected in the engine inputs', () => {
    const card = createCard({ kind: 'tank', id: 't1' });
    card.paramSources.ph = { mode: 'manual', value: 6.5 };
    expect(cardToEngineInputs(card)?.pH).toBe(6.5);
  });

  it('returns null when a core value is missing (engineReady guard)', () => {
    const card = createCard({ kind: 'tank', id: 't1' });
    card.paramSources.temperature = { mode: 'manual', value: undefined };
    expect(cardToEngineInputs(card)).toBeNull();
  });

  it('species template seeds the editable limits', () => {
    expect(createCard({ kind: 'tank', id: 't1' }, 'tilapia').limits.nh3Limit).toBe(0.1);
    expect(createCard({ kind: 'tank', id: 't1' }, 'salmon_seawater').limits.caMgL).toBe(400);
  });

  it('flow-through tank (Loop-B) auto-binds its own tank sensors, not a loop', () => {
    const card = createCard({ kind: 'tank', id: 't7' });
    // t7 is on a flow-through loop; sensorsForScope still offers its tank sensors
    expect(card.paramSources.ph.mode).toBe('sensor');
    expect(card.paramSources.ph.sensorId).toBe('PH-T7');
  });
});
