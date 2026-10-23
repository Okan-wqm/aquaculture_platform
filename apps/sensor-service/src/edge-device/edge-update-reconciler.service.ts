import { withTenantContext } from '@aquaculture/backend-common/context';
import { listActiveTenantSchemaIdentities } from '@aquaculture/backend-common/database';
import {
  ScheduledJob,
  ScheduledJobRunner,
  type ScheduledJobExecutor,
} from '@aquaculture/backend-common/scheduling';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { EdgeReleaseCatalog } from './edge-release-catalog.service';
import { STATEMENT } from './edge-contract';
import { reissueDecision } from './edge-update-channel';
import { UpdateRefusedError, type UpdateWindow } from './edge-update-manifest.service';
import { parseRecipe, type UpdateRecipe } from './edge-update-recipe';
import {
  EdgeUpdateRequestService,
  RequestNotReissuableError,
  type ReissueCandidate,
  UpdateTargetUnavailableError,
} from './edge-update-request.service';
import { StatementAdmissionError } from './manifest-signer';
import { TenantOutOfBundleScopeError } from './trust-anchor-bundle.service';

/** What one reconciliation of a tenant did. */
export interface ReconcileSummary {
  /** Pending requests whose window closed with no result. */
  readonly lapsed: number;
  /** RETRY requests replaced by a new statement of their intent. */
  readonly reissued: number;
  /** RETRY requests the cloud ended as failed (campaign over, or a re-issue it would not sign). */
  readonly failed: number;
  /** RETRY requests that wait: the re-issue interval has not passed, or a dependency failed and the next tick tries again. */
  readonly waiting: number;
}

const NONE: ReconcileSummary = { lapsed: 0, reissued: 0, failed: 0, waiting: 0 };

function add(a: ReconcileSummary, b: ReconcileSummary): ReconcileSummary {
  return {
    lapsed: a.lapsed + b.lapsed,
    reissued: a.reissued + b.reissued,
    failed: a.failed + b.failed,
    waiting: a.waiting + b.waiting,
  };
}

/**
 * Keeps the update channel's promises on a schedule (ADR-048 DEC-2.12; channels.json
 * update_channel.settlement), for every tenant:
 *
 *   - silence ends at a statement's `expires_at`: a pending request with no result by
 *     then is LAPSED;
 *   - a request a retryable refusal concluded (clock-unsynced, fetch-failed, io-error,
 *     maintenance-blocked, not-yet-valid) is issued again as a NEW statement of the same
 *     intent: not before the contract's interval after the refusal, with a later window
 *     and the device's next update_seq, until the campaign's bound — then it is FAILED
 *     and the operator is told. The re-issue replaces the request in the signing
 *     transaction, so two replicas cannot both issue it.
 *
 * A re-issue the cloud would not sign (the release is no longer admissible, the device
 * left service, the terms no longer pass) ends the intent as FAILED with the reason; a
 * dependency that is only down (the release host, the database) leaves the request
 * waiting for the next tick, and the campaign bound is what ends the waiting.
 */
@Injectable()
export class EdgeUpdateReconciler {
  private readonly logger = new Logger(EdgeUpdateReconciler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly requests: EdgeUpdateRequestService,
    private readonly catalog: EdgeReleaseCatalog,
    @Inject(ScheduledJobRunner) readonly scheduledJobs: ScheduledJobExecutor,
  ) {}

  /** The scheduled entry point (a tick takes no arguments and returns nothing). */
  @ScheduledJob({ name: 'edge-update.reconcile', every: 60_000 })
  async reconcileTick(): Promise<void> {
    await this.reconcileAll(new Date());
  }

  /** Reconciles every active tenant; one tenant's failure never stops the others. */
  async reconcileAll(now: Date): Promise<ReconcileSummary> {
    let tenants: Awaited<ReturnType<typeof listActiveTenantSchemaIdentities>>;
    try {
      tenants = await listActiveTenantSchemaIdentities(this.dataSource);
    } catch (error) {
      this.logger.error({
        event: 'update_reconcile_tenants_unavailable',
        error: error instanceof Error ? error.message : String(error),
      });
      return NONE;
    }
    let total = NONE;
    for (const { tenantId } of tenants) {
      try {
        // The tick has no request behind it: each tenant's pass runs inside that
        // tenant's context, so nothing it calls can reach another tenant's rows.
        total = add(
          total,
          await withTenantContext(tenantId, () => this.reconcileTenant(tenantId, now)),
        );
      } catch (error) {
        this.logger.error({
          event: 'update_reconcile_failed',
          tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return total;
  }

  async reconcileTenant(tenantId: string, now: Date): Promise<ReconcileSummary> {
    const lapsed = await this.requests.lapseDue(tenantId, now);
    let reissued = 0;
    let failed = 0;
    let waiting = 0;
    for (const candidate of await this.requests.reissueCandidates(tenantId)) {
      const outcome = await this.reconcileCandidate(candidate, now);
      if (outcome === 'reissued') reissued += 1;
      else if (outcome === 'failed') failed += 1;
      else if (outcome === 'waiting') waiting += 1;
    }
    return { lapsed, reissued, failed, waiting };
  }

  private async reconcileCandidate(
    candidate: ReissueCandidate,
    now: Date,
  ): Promise<'reissued' | 'failed' | 'waiting' | 'settled-elsewhere'> {
    const decision = reissueDecision(candidate.campaignStartedAt, candidate.refusedAt, now);
    if (decision === 'too-early') return 'waiting';
    if (decision === 'campaign-over') {
      this.logger.error({
        event: 'update_campaign_exhausted',
        tenantId: candidate.tenantId,
        deviceId: candidate.deviceId,
        intentId: candidate.intentId,
        statementType: candidate.statementType,
        lastRefusal: candidate.refusalReason,
      });
      return this.conclude(
        candidate,
        `campaign over: still refused (${candidate.refusalReason ?? 'no reason'}) when its time ran out`,
      );
    }
    const recipe = parseRecipe(candidate.recipe);
    if (recipe === null || recipe.kind !== recipeKindOf(candidate)) {
      this.logger.error({
        event: 'update_recipe_invalid',
        tenantId: candidate.tenantId,
        requestId: candidate.id,
      });
      return this.conclude(candidate, 'the stored recipe is not one the cloud wrote');
    }
    try {
      await this.reissue(candidate, recipe, now);
      this.logger.log({
        event: 'update_request_reissued',
        tenantId: candidate.tenantId,
        deviceId: candidate.deviceId,
        intentId: candidate.intentId,
        replaces: candidate.id,
      });
      return 'reissued';
    } catch (error) {
      if (error instanceof RequestNotReissuableError) return 'settled-elsewhere';
      if (
        error instanceof StatementAdmissionError ||
        error instanceof UpdateRefusedError ||
        error instanceof UpdateTargetUnavailableError ||
        error instanceof TenantOutOfBundleScopeError
      ) {
        this.logger.error({
          event: 'update_reissue_refused',
          tenantId: candidate.tenantId,
          deviceId: candidate.deviceId,
          intentId: candidate.intentId,
          error: error.message,
        });
        return this.conclude(candidate, `re-issue refused: ${error.message}`);
      }
      // Not a verdict on the update: a dependency is down. The next tick asks again.
      this.logger.warn({
        event: 'update_reissue_deferred',
        tenantId: candidate.tenantId,
        deviceId: candidate.deviceId,
        intentId: candidate.intentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'waiting';
    }
  }

  private async conclude(
    candidate: ReissueCandidate,
    detail: string,
  ): Promise<'failed' | 'settled-elsewhere'> {
    const concluded = await this.requests.concludeUnreissued(
      candidate.tenantId,
      candidate.id,
      detail,
    );
    return concluded ? 'failed' : 'settled-elsewhere';
  }

  /** A new statement of the intent: a window that starts now and lasts as long as the first one did. */
  private async reissue(
    candidate: ReissueCandidate,
    recipe: UpdateRecipe,
    now: Date,
  ): Promise<void> {
    const window: UpdateWindow = {
      notBefore: now,
      expiresAt: new Date(now.getTime() + recipe.windowSeconds * 1000),
    };
    await this.requests.issueFromRecipe(
      { id: candidate.deviceId, tenantId: candidate.tenantId },
      recipe,
      window,
      {
        intentId: candidate.intentId,
        campaignStartedAt: candidate.campaignStartedAt,
        rolloutId: candidate.rolloutId,
        createdBy: candidate.createdBy,
        supersedes: candidate.id,
      },
      (board, version) => this.catalog.forVersion(board, version),
    );
  }
}

/** The recipe kind a statement type is re-issued from. */
function recipeKindOf(candidate: ReissueCandidate): UpdateRecipe['kind'] {
  switch (candidate.statementType) {
    case STATEMENT.edgeUpdate:
      return 'edge-update';
    case STATEMENT.osUpdate:
      return 'os-update';
    case STATEMENT.siteConfig:
      return 'site-config';
    case STATEMENT.siteNetpolicy:
      return 'site-netpolicy';
    case STATEMENT.trustAnchors:
      return 'trust-anchors';
  }
}
