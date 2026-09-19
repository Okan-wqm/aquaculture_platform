import { composeServices } from '@apollo/composition';
import type { SupergraphManager, SupergraphSdlHookOptions } from '@apollo/gateway/dist/config';
import { Logger } from '@nestjs/common';
import { parse } from 'graphql';

import { CompositionStateService } from './composition-state.service';
import { RetryableIntrospectAndCompose } from './retryable-introspect';

/**
 * Constructor dependencies for {@link BackgroundCompositionManager}.
 *
 * @property retryable - the real composer. Its blocking introspect+retry loop is
 *   moved OFF the NestFactory.create() critical path by this wrapper.
 * @property state - shared readiness state the background cycle writes its
 *   outcome into; HealthService reads it for /health/ready.
 */
interface BackgroundCompositionManagerOptions {
  retryable: RetryableIntrospectAndCompose;
  state: CompositionStateService;
  /**
   * Back-off between composition ROUNDS once the composer's own bounded
   * retry budget is exhausted (GW-COMPOSITION-CONVERGES). Defaults:
   * 5 s doubling to a 60 s cap. Injectable for tests.
   */
  recomposeBackoff?: { baseMs: number; maxMs: number };
  /** Injectable sleep so tests can park or fast-forward the loop. */
  sleep?: (ms: number) => Promise<void>;
}

/** Back-off between composition rounds: 5 s, 10 s, 20 s, 40 s, then 60 s forever. */
export const RECOMPOSE_BACKOFF_DEFAULT = { baseMs: 5_000, maxMs: 60_000 } as const;

/**
 * BackgroundCompositionManager — non-blocking supergraph composition.
 *
 * ARCH-GW-006: Bind the HTTP listener in <1s instead of blocking
 * NestFactory.create() on ~83-94s of all-or-nothing supergraph composition.
 *
 * # The problem this solves
 *
 * RetryableIntrospectAndCompose.initialize() introspects every subgraph and
 * composes the full supergraph SDL. Apollo Gateway AWAITS the supergraphSdl
 * manager's initialize() before NestFactory.create() resolves, so the entire
 * gateway process — including its HTTP listener and /health/live — was blocked
 * until composition succeeded (~83-94s on a cold deploy, or forever if a single
 * subgraph never came up, because composition is all-or-nothing). That broke the
 * deploy health gate, which polls /health/live.
 *
 * # The mechanism (why this is non-blocking AND correct)
 *
 * Apollo only awaits the INITIAL `supergraphSdl` returned synchronously-ish from
 * initialize(). After that, the gateway hot-swaps its live schema every time the
 * manager calls `options.update(newSdl)` — this is the EXACT same path
 * IntrospectAndCompose uses on every poll interval. So:
 *
 *   1. initialize() returns IMMEDIATELY with a tiny, REAL, validly-composed
 *      placeholder supergraph (one trivial subgraph). The listener binds in <1s;
 *      /health/live answers; the deploy gate passes. GraphQL operations against
 *      the real subgraphs 503 via /health/ready until the real schema lands —
 *      they are not silently wrong, the readiness gate keeps the gateway out of
 *      rotation.
 *   2. initialize() fire-and-forgets {@link composeInBackground}, which runs the
 *      real RetryableIntrospectAndCompose introspect+retry loop. On success it
 *      hot-swaps the real schema in via `options.update()` and latches readiness
 *      via state.markComposed(). When a round's bounded budget is exhausted it
 *      records the reason via state.markCompositionError() and does NOT throw —
 *      and does NOT stop either.
 *
 * # Composition converges; it never fails terminally (GW-COMPOSITION-CONVERGES)
 *
 * On 2026-09-18 a deploy restarted the gateway 3.5 minutes before auth-service
 * came back. The composer's 24 attempts (~72 s) exhausted with auth
 * ECONNREFUSED, the manager recorded the error and returned, and the gateway
 * served for hours with /health/live 200, /health/ready 503 and no `auth`
 * subgraph — every login mutation answered "Unknown type LoginInput" until a
 * human restarted the container. "Docker will restart the container" was never
 * true: liveness stayed green, so nothing restarted anything. The order in which
 * containers come back is not a property this process can assume, so the
 * background composer now runs rounds without end: after each exhausted round it
 * records the reason, waits (5 s doubling to a 60 s cap) and composes again,
 * until the schema lands. Readiness stays honest throughout — 503 with the last
 * error until the real supergraph is live — and no operator act is needed for
 * a subgraph that is merely late.
 *
 * # The placeholder is composed, never hand-written
 *
 * Per the architectural ban on hand-writing supergraph SDL, the placeholder is
 * produced by running @apollo/composition's composeServices() over ONE trivial
 * federation-v2 subgraph. We never emit literal supergraph SDL ourselves.
 */
export class BackgroundCompositionManager implements SupergraphManager {
  private readonly logger = new Logger(BackgroundCompositionManager.name);
  private readonly retryable: RetryableIntrospectAndCompose;
  private readonly state: CompositionStateService;
  private readonly backoff: { baseMs: number; maxMs: number };
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: BackgroundCompositionManagerOptions) {
    this.retryable = options.retryable;
    this.state = options.state;
    this.backoff = options.recomposeBackoff ?? RECOMPOSE_BACKOFF_DEFAULT;
    this.sleep =
      options.sleep ??
      ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Apollo Gateway supergraph hook. Returns the INITIAL live schema, which is
   * all Apollo awaits before binding the HTTP listener.
   *
   * Returns a placeholder supergraph immediately so the listener binds in <1s,
   * then fire-and-forgets the real composition. The real schema is hot-swapped
   * in later via options.update() — Apollo's standard live-update path.
   *
   * @param options - Apollo's supergraph hook options (update / healthCheck /
   *   getDataSource). `options.update(sdl)` hot-swaps the live schema.
   * @returns the placeholder supergraph SDL plus a cleanup hook.
   */
  async initialize(
    options: SupergraphSdlHookOptions,
  ): Promise<{ supergraphSdl: string; cleanup: () => Promise<void> }> {
    const placeholder = this.buildPlaceholderSupergraph();

    /**
     * Fire-and-forget on purpose. This is NOT a silent failure: composeInBackground
     * never rejects — every outcome is routed to CompositionStateService (which
     * /health/ready exposes) AND to this logger. Awaiting here would re-introduce
     * the exact NestFactory.create() blocking we are removing.
     */
    void this.composeInBackground(options);

    return {
      supergraphSdl: placeholder,
      cleanup: (): Promise<void> => Promise.resolve(),
    };
  }

  /**
   * Runs the real RetryableIntrospectAndCompose loop off the critical path.
   * Never throws: success hot-swaps the real schema + latches readiness; terminal
   * failure is recorded for /health/ready and the logs.
   */
  private async composeInBackground(options: SupergraphSdlHookOptions): Promise<void> {
    this.logger.log('Starting background supergraph composition...');
    for (let round = 1; ; round += 1) {
      try {
        const result = await this.retryable.initialize(options);
        options.update(result.supergraphSdl);
        this.state.markComposed();
        this.logger.log(
          `Background supergraph composition complete on round ${round}; live schema swapped in.`,
        );
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.state.markCompositionError(message);
        const delayMs = Math.min(this.backoff.baseMs * 2 ** (round - 1), this.backoff.maxMs);
        this.logger.error(
          `Background supergraph composition round ${round} exhausted: ${message}. ` +
            `Gateway stays not_ready (/health/ready) with this reason; /health/live remains up; ` +
            `next round in ${Math.round(delayMs / 1000)}s.`,
        );
        await this.sleep(delayMs);
      }
    }
  }

  /**
   * Builds a minimal but REAL composed supergraph via @apollo/composition over a
   * single trivial federation-v2 subgraph. Never hand-writes supergraph SDL.
   *
   * @throws if composition of the trivial subgraph fails (a build-time/library
   *   invariant violation, not a runtime/subgraph-reachability condition).
   */
  private buildPlaceholderSupergraph(): string {
    const placeholderTypeDefs = parse(`
      extend schema @link(url: "https://specs.apollo.dev/federation/v2.0")

      type Query {
        _gatewayComposing: Boolean!
      }
    `);

    const result = composeServices([
      { name: '_gateway_placeholder', typeDefs: placeholderTypeDefs },
    ]);

    if (result.errors !== undefined || result.supergraphSdl === undefined) {
      const detail = (result.errors ?? []).map((e) => e.message).join('; ');
      throw new Error(`Failed to compose placeholder supergraph SDL: ${detail}`);
    }

    return result.supergraphSdl;
  }
}
