/**
 * FeedTypeTransitionService — the ONE mechanism that decides and records which
 * feed a unit is on.
 *
 * WHY it exists: there were two mechanisms and only one of them worked. The
 * intra-day recalculation applied `transitionBufferG` hysteresis, wrote the
 * assignment's `currentFeedId`/`currentBandIndex`, rewrote the remaining meals'
 * feed and published `FeedTypeTransitioned`. The 06:00 generator selected the
 * band from weight ALONE — it never read `assignment.currentFeedId` (the field
 * was in its input type and unused), so a fish that crossed a band boundary
 * overnight silently got a new feed in the morning plan while the assignment
 * still named yesterday's feed, no event was published, and the first intra-day
 * recalculation then compared against that stale index and could publish a
 * SECOND, contradictory transition for a boundary already crossed.
 *
 * WHAT this service guarantees:
 *  - `decide` is PURE — the 06:00 generator, the K-3 dry-run and the intra-day
 *    recalculation share one hysteresis rule, so no path can drift from another.
 *  - `apply` is the only writer of the assignment's transition state and the
 *    only publisher of `FeedTypeTransitioned`, so the state cannot be written
 *    without the event, nor the event without the state.
 *  - `autoTransition: false` HOLDS the assignment's band instead of silently
 *    following the weight (which is what "no automatic transition" means); the
 *    operator's manual path stays `DayPlanAdminService.transitionUnitFeed`.
 *
 * Hysteresis (unchanged rule, single copy): an up-shift requires the new band's
 * `minWeightG` to be exceeded by `transitionBufferG`, a down-shift requires the
 * new band's `maxWeightG` to be undercut by it; otherwise the current band
 * holds and oscillation at a boundary is impossible.
 *
 * @module FeedingProtocol/Services
 */
import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { createBaseEvent, FeedTypeTransitionedEvent } from '@platform/event-contracts';

import { FeedingProtocolV2, ProtocolBand } from '../entities/feeding-protocol-v2.entity';
import { ProtocolAssignment } from '../entities/protocol-assignment.entity';
import { ProtocolRateService, ResolvedBand, type BandWeightG } from './protocol-rate.service';

/** The assignment's persisted transition state (the only band memory there is). */
export interface BandTransitionState {
  currentBandIndex?: number;
  currentFeedId?: string;
}

/** What `apply` must write. `feedChanged` decides whether a durable event belongs to it. */
export interface BandStateChange {
  fromBandIndex?: number;
  fromFeedId?: string;
  toBandIndex: number;
  toFeedId: string;
  toFeedCode: string;
  /**
   * True only when the FEED PRODUCT changes. A band shift between two bands
   * that carry the same feed changes the rate but is not a feed transition —
   * it updates the state silently. Adopting a band on an assignment that had no
   * band memory is likewise not a transition: nothing was replaced.
   */
  feedChanged: boolean;
}

export interface BandDecision {
  band: ProtocolBand;
  index: number;
  /** null = the assignment already names this band; nothing to write or publish. */
  stateChange: BandStateChange | null;
}

@Injectable()
export class FeedTypeTransitionService {
  constructor(
    private readonly rateService: ProtocolRateService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  /**
   * PURE band resolution with hysteresis. `null` = the protocol has no bands
   * (nothing can be planned or transitioned).
   */
  decide(input: {
    protocol: Pick<FeedingProtocolV2, 'bands' | 'settings'>;
    /** Unit-authoritative average weight — the tank is the cohort (field rule). */
    avgWeightG: BandWeightG;
    state: BandTransitionState;
  }): BandDecision | null {
    const { protocol, avgWeightG, state } = input;
    const resolved = this.rateService.bandFor(protocol.bands, avgWeightG);
    if (!resolved) return null;

    const current = this.knownBand(protocol.bands, state);
    if (current === null) {
      // No band memory (first plan for the assignment, or a protocol edit that
      // invalidated the stored index): adopt the weight-resolved band. Nothing
      // was replaced, so this is a state write WITHOUT a transition event.
      return {
        band: resolved.band,
        index: resolved.index,
        stateChange: {
          fromBandIndex: state.currentBandIndex,
          fromFeedId: state.currentFeedId,
          toBandIndex: resolved.index,
          toFeedId: resolved.band.feedId,
          toFeedCode: resolved.band.feedCode,
          feedChanged: false,
        },
      };
    }

    const effective = protocol.settings.autoTransition
      ? this.applyTransitionHysteresis(resolved, current.index, avgWeightG, protocol)
      : current;

    const alreadyNamed =
      effective.index === current.index && state.currentFeedId === effective.band.feedId;
    if (alreadyNamed) {
      return { band: effective.band, index: effective.index, stateChange: null };
    }

    return {
      band: effective.band,
      index: effective.index,
      stateChange: {
        fromBandIndex: current.index,
        fromFeedId: state.currentFeedId,
        toBandIndex: effective.index,
        toFeedId: effective.band.feedId,
        toFeedCode: effective.band.feedCode,
        feedChanged:
          state.currentFeedId !== undefined && state.currentFeedId !== effective.band.feedId,
      },
    };
  }

  /**
   * Writes the decided state onto the assignment and, when the feed product
   * actually changed, publishes the durable `FeedTypeTransitioned` (P-12).
   *
   * The caller passes the assignment it already holds under `pessimistic_write`
   * (canonical lock order K-1: DayPlan → Meals → Assignment), so this method
   * never takes a second, out-of-order lock on the same row.
   */
  async apply(
    manager: EntityManager,
    tenantId: string,
    assignment: ProtocolAssignment,
    params: {
      unitId: string;
      unitCode: string;
      avgWeightG: number;
      change: BandStateChange;
      /** false only for the operator's manual transition path. */
      automatic: boolean;
    },
  ): Promise<void> {
    const { change } = params;
    assignment.currentFeedId = change.toFeedId;
    assignment.currentBandIndex = change.toBandIndex;
    if (change.feedChanged) {
      assignment.lastTransitionAt = new Date();
      assignment.totalTransitions = (assignment.totalTransitions ?? 0) + 1;
    }
    await manager.save(assignment);

    if (!change.feedChanged) return;

    const event: FeedTypeTransitionedEvent = {
      ...createBaseEvent<FeedTypeTransitionedEvent>('FeedTypeTransitioned', tenantId, {
        aggregateId: params.unitId,
        aggregateType: 'FeedingUnit',
      }),
      unitId: params.unitId,
      unitCode: params.unitCode,
      assignmentId: assignment.id,
      fromFeedId: change.fromFeedId,
      toFeedId: change.toFeedId,
      toFeedCode: change.toFeedCode,
      bandIndex: change.toBandIndex,
      avgWeightG: params.avgWeightG,
      automatic: params.automatic,
    };
    await this.outboxPublisher.enqueue(event, manager);
  }

  /**
   * The assignment's band index, or `null` when it carries no usable memory.
   * A stored index that no longer addresses a band (the protocol's band list was
   * edited) is treated as no memory rather than silently addressing the wrong
   * band — the unit then re-adopts from its weight.
   */
  private knownBand(bands: ProtocolBand[], state: BandTransitionState): ResolvedBand | null {
    if (state.currentBandIndex !== undefined) {
      const stored = bands[state.currentBandIndex];
      if (stored) return { band: stored, index: state.currentBandIndex };
    }
    if (state.currentFeedId) {
      const byFeed = bands.findIndex((band) => band.feedId === state.currentFeedId);
      const band = bands[byFeed];
      if (band) return { band, index: byFeed };
    }
    return null;
  }

  /**
   * Histerezis (transitionBufferG): yukarı geçiş yeni bandın minWeight'ini
   * buffer kadar aşmayı, aşağı geçiş yeni bandın maxWeight'inin buffer kadar
   * altını şart koşar; şart sağlanmazsa MEVCUT band korunur.
   */
  private applyTransitionHysteresis(
    resolved: ResolvedBand,
    currentIndex: number,
    avgWeightG: BandWeightG,
    protocol: Pick<FeedingProtocolV2, 'bands' | 'settings'>,
  ): ResolvedBand {
    if (resolved.index === currentIndex) return resolved;
    const buffer = protocol.settings.transitionBufferG ?? 0;
    const currentBand = protocol.bands[currentIndex];
    if (!currentBand) return resolved;
    if (resolved.index > currentIndex) {
      if (avgWeightG >= resolved.band.minWeightG + buffer) return resolved;
    } else if (avgWeightG <= resolved.band.maxWeightG - buffer) {
      return resolved;
    }
    return { band: currentBand, index: currentIndex };
  }
}
