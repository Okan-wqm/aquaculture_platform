/**
 * A monitoring point's state: still being read, not read (an outage is not
 * "no value"), or read — its sets composed by the shared composition and its
 * engine record over the monitoring settings. A tank needs its own set and
 * its loop's; either failing fails the tank.
 */
import {
  composePointInputs,
  DEFAULT_WATER_CHEMISTRY_INPUTS,
  engineRecordOf,
  type ComposedInputs,
  type EngineRecord,
  loopOf,
  type InputSetResult,
  type PointSets,
  type StaleSet,
} from '@aquaculture/shared-ui';

/** The part of a query result a point's state reads. */
export interface SetAnswer {
  readonly data: InputSetResult | undefined;
  readonly error: Error | null;
  readonly isRefetchError: boolean;
}

export type PointState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly sets: PointSets;
      readonly composed: ComposedInputs;
      readonly record: EngineRecord;
      /** Each set whose last refresh failed (its values are shown as resolved then). */
      readonly stale: readonly StaleSet[];
    };

/**
 * Monitoring has no operator entries and draws its zones with the calculator's
 * targets and limits (disclosed on screen; per-system limits are FARM-MEDIUM-386).
 */
const MONITORING_SETTINGS = DEFAULT_WATER_CHEMISTRY_INPUTS;

export function pointStateOf(own: SetAnswer | undefined, loop: SetAnswer | null): PointState {
  const answers = loop === null ? [own] : [own, loop];
  for (const answer of answers) {
    if (answer !== undefined && answer.data === undefined && answer.error !== null) {
      return { status: 'error', message: answer.error.message };
    }
  }
  if (own === undefined || own.data === undefined || (loop !== null && loop.data === undefined)) {
    return { status: 'loading' };
  }
  // The loop's set is read only for the system the backend names as the tank's one loop.
  const tankLoop = loopOf(own.data);
  const loopData =
    loop === null || loop.data === undefined
      ? null
      : tankLoop.kind === 'one' && tankLoop.systemId === loop.data.point.id
        ? loop.data
        : null;
  const sets: PointSets = { own: own.data, loop: loopData };
  const stale: StaleSet[] = [];
  if (own.isRefetchError) stale.push({ set: own.data.set, asOf: own.data.asOf });
  if (loopData !== null && loop !== null && loop.isRefetchError) {
    stale.push({ set: loopData.set, asOf: loopData.asOf });
  }
  const composed = composePointInputs(sets, {});
  return {
    status: 'ready',
    sets,
    composed,
    record: engineRecordOf(composed, { ...MONITORING_SETTINGS }),
    stale,
  };
}
