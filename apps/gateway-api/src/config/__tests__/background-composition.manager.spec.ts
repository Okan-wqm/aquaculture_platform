/**
 * BackgroundCompositionManager Tests (ARCH-GW-006).
 *
 * Proves the non-blocking mechanism:
 *   1. initialize() returns a REAL composed placeholder IMMEDIATELY, even if the
 *      real composer never resolves (the whole point: liveness must not wait).
 *   2. On background success the real schema is hot-swapped via options.update()
 *      and readiness latches on.
 *   3. On background terminal failure the error is recorded and NOT thrown, and
 *      readiness stays off.
 */

import type { SupergraphSdlHookOptions } from '@apollo/gateway/dist/config';

import { BackgroundCompositionManager } from '../background-composition.manager';
import { CompositionStateService } from '../composition-state.service';
import type { RetryableIntrospectAndCompose } from '../retryable-introspect';

/** Flush pending micro + macro tasks so the fire-and-forget background promise settles. */
const flushAsync = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

const createHookOptions = (): jest.Mocked<SupergraphSdlHookOptions> => ({
  update: jest.fn(),
  healthCheck: jest.fn().mockResolvedValue(undefined),
  getDataSource: jest.fn(),
});

describe('BackgroundCompositionManager', () => {
  let state: CompositionStateService;
  let options: jest.Mocked<SupergraphSdlHookOptions>;

  beforeEach(() => {
    state = new CompositionStateService();
    options = createHookOptions();
  });

  it('returns a real composed placeholder immediately even if the real composer never resolves', async () => {
    // A retryable whose initialize() never settles — if initialize() awaited it,
    // this test would hang. It must not.
    const neverResolves: Pick<RetryableIntrospectAndCompose, 'initialize'> = {
      initialize: jest.fn(() => new Promise(() => undefined)),
    };
    const manager = new BackgroundCompositionManager({
      retryable: neverResolves as RetryableIntrospectAndCompose,
      state,
    });

    const result = await manager.initialize(options);

    // Placeholder is real composed supergraph SDL, not hand-written.
    expect(typeof result.supergraphSdl).toBe('string');
    expect(result.supergraphSdl.length).toBeGreaterThan(0);
    expect(result.supergraphSdl).toContain('_gatewayComposing');
    expect(result.supergraphSdl).toContain('schema');
    expect(typeof result.cleanup).toBe('function');
    await expect(result.cleanup()).resolves.toBeUndefined();

    // Still composing — readiness must not be latched by the placeholder.
    expect(state.isComposed()).toBe(false);
  });

  it('hot-swaps the real schema and latches readiness on background success', async () => {
    const realSdl = 'REAL_SUPERGRAPH_SDL';
    const retryable: Pick<RetryableIntrospectAndCompose, 'initialize'> = {
      initialize: jest.fn().mockResolvedValue({
        supergraphSdl: realSdl,
        cleanup: () => Promise.resolve(),
      }),
    };
    const manager = new BackgroundCompositionManager({
      retryable: retryable as RetryableIntrospectAndCompose,
      state,
    });

    await manager.initialize(options);
    await flushAsync();

    expect(retryable.initialize).toHaveBeenCalledWith(options);
    expect(options.update).toHaveBeenCalledWith(realSdl);
    expect(state.isComposed()).toBe(true);
    expect(state.getLastError()).toBeNull();
  });

  it('records the error and does not throw or compose when a round exhausts its budget', async () => {
    // A sleep that never resolves parks the loop after the first round, so the
    // assertions read the state exactly as /health/ready would between rounds.
    const parked = (): Promise<void> => new Promise(() => undefined);
    const retryable: Pick<RetryableIntrospectAndCompose, 'initialize'> = {
      initialize: jest.fn().mockRejectedValue(new Error('all subgraphs unreachable')),
    };
    const manager = new BackgroundCompositionManager({
      retryable: retryable as RetryableIntrospectAndCompose,
      state,
      sleep: parked,
    });

    // initialize() itself must resolve cleanly (the failure is on the background path).
    await expect(manager.initialize(options)).resolves.toBeDefined();
    await flushAsync();

    expect(options.update).not.toHaveBeenCalled();
    expect(state.isComposed()).toBe(false);
    expect(state.getLastError()).toBe('all subgraphs unreachable');
  });

  // GW-COMPOSITION-CONVERGES — 2026-09-18: the gateway restarted 3.5 minutes
  // before auth-service came back, the composer's budget exhausted, and the
  // gateway served for hours with no `auth` subgraph ("Unknown type
  // LoginInput") until a human restarted it. Composition is a loop, not a
  // verdict: a subgraph that is merely late is composed when it arrives.
  it('keeps composing after an exhausted round and converges when the late subgraph arrives', async () => {
    const sleeps: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      sleeps.push(ms);
      return Promise.resolve();
    };
    const initialize = jest
      .fn()
      .mockRejectedValueOnce(new Error('auth ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('auth ECONNREFUSED'))
      .mockResolvedValueOnce({ supergraphSdl: 'type Query { login: String }', cleanup: jest.fn() });
    const retryable: Pick<RetryableIntrospectAndCompose, 'initialize'> = { initialize };
    const manager = new BackgroundCompositionManager({
      retryable: retryable as RetryableIntrospectAndCompose,
      state,
      recomposeBackoff: { baseMs: 5_000, maxMs: 60_000 },
      sleep,
    });

    await manager.initialize(options);
    await flushAsync();
    await flushAsync();

    expect(initialize).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([5_000, 10_000]);
    expect(options.update).toHaveBeenCalledWith('type Query { login: String }');
    expect(state.isComposed()).toBe(true);
    expect(state.getLastError()).toBeNull();
  });

  it('caps the back-off between rounds and never stops trying', async () => {
    const sleeps: number[] = [];
    let rounds = 0;
    const sleep = (ms: number): Promise<void> => {
      sleeps.push(ms);
      // Park after six rounds so the test can observe a bounded prefix of an unbounded loop.
      return sleeps.length >= 6 ? new Promise(() => undefined) : Promise.resolve();
    };
    const initialize = jest.fn().mockImplementation(() => {
      rounds += 1;
      return Promise.reject(new Error(`round ${rounds} unreachable`));
    });
    const retryable: Pick<RetryableIntrospectAndCompose, 'initialize'> = { initialize };
    const manager = new BackgroundCompositionManager({
      retryable: retryable as RetryableIntrospectAndCompose,
      state,
      recomposeBackoff: { baseMs: 5_000, maxMs: 60_000 },
      sleep,
    });

    await manager.initialize(options);
    for (let i = 0; i < 8; i += 1) await flushAsync();

    expect(sleeps).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
    expect(state.isComposed()).toBe(false);
    expect(state.getLastError()).toBe('round 6 unreachable');
    expect(options.update).not.toHaveBeenCalled();
  });
});
