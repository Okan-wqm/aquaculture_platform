/**
 * CompositionStateService Tests (ARCH-GW-006).
 *
 * Verifies the WRITER/READER contract: markComposed() latches readiness on,
 * markCompositionError() records the error WITHOUT resetting readiness, and the
 * readers reflect the recorded state.
 */

import { CompositionStateService } from '../composition-state.service';

describe('CompositionStateService', () => {
  let state: CompositionStateService;

  beforeEach(() => {
    state = new CompositionStateService();
  });

  it('starts not composed, with no error and no timestamp', () => {
    expect(state.isComposed()).toBe(false);
    expect(state.getLastError()).toBeNull();
    expect(state.getLastComposedAt()).toBeNull();
  });

  it('markComposed() latches readiness, clears error, and stamps the time', () => {
    state.markCompositionError('transient');
    expect(state.getLastError()).toBe('transient');

    const before = Date.now();
    state.markComposed();
    const after = Date.now();

    expect(state.isComposed()).toBe(true);
    expect(state.getLastError()).toBeNull();

    const composedAt = state.getLastComposedAt();
    expect(composedAt).toBeInstanceOf(Date);
    expect(composedAt?.getTime()).toBeGreaterThanOrEqual(before);
    expect(composedAt?.getTime()).toBeLessThanOrEqual(after);
  });

  it('markCompositionError() records the error but does NOT reset composed', () => {
    state.markComposed();
    expect(state.isComposed()).toBe(true);

    state.markCompositionError('subgraph farm unreachable');

    // Readiness stays on — Apollo keeps serving the last-good schema.
    expect(state.isComposed()).toBe(true);
    expect(state.getLastError()).toBe('subgraph farm unreachable');
  });

  it('markCompositionError() records an error before the first successful compose', () => {
    state.markCompositionError('cold-start failure');

    expect(state.isComposed()).toBe(false);
    expect(state.getLastError()).toBe('cold-start failure');
  });
});
