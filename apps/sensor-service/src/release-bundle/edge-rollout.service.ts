import {
  listActiveTenantSchemaIdentities,
  runInTenantRead,
  runInTenantTransaction,
  SENSOR_SOURCE_SCHEMA,
} from '@aquaculture/backend-common/database';
import {
  ScheduledJob,
  ScheduledJobRunner,
  type ScheduledJobExecutor,
} from '@aquaculture/backend-common/scheduling';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';

import { boardForDeviceModel, type BoardRow } from '../edge-device/edge-boards';
import { asDeviceBinding } from '../edge-device/edge-contract';
import {
  EdgeReleaseCatalog,
  type AdmittedRelease,
} from '../edge-device/edge-release-catalog.service';
import {
  buildEdgeUpdate,
  buildOsUpdate,
  UpdateRefusedError,
  type UpdateTarget,
  type UpdateWindow,
} from '../edge-device/edge-update-manifest.service';
import type { UpdateRecipe } from '../edge-device/edge-update-recipe';
import {
  EdgeUpdateRequestService,
  UPDATABLE_STATES,
  UpdateTargetUnavailableError,
} from '../edge-device/edge-update-request.service';
import { EdgeAgentChannel } from '../edge-device/entities/edge-device.entity';
import { StatementAdmissionError } from '../edge-device/manifest-signer';
import { TenantOutOfBundleScopeError } from '../edge-device/trust-anchor-bundle.service';
import { returningRows } from '../edge-device/returning-rows';

import {
  assertPlanShape,
  planDevices,
  planDigest,
  recipeOf,
  RolloutPlanError,
  targetOf,
  type RolloutPlan,
} from './edge-rollout-plan';
import {
  EdgeRolloutDevicePhase,
  EdgeRolloutKind,
  EdgeRolloutState,
  MIN_ROLLOUT_APPROVALS,
  type EdgeRollout,
} from './entities/edge-rollout.entity';
import type { EdgeRolloutApproval } from './entities/edge-rollout-approval.entity';

/**
 * Cohort rollouts of an agent release or an OS bundle, with the two-person approval
 * the edge-update statement cannot carry in P1 (ADR-048 DEC-2.4, DEC-23).
 *
 * What holds, and where it is enforced:
 *
 *   - Nothing is signed for any device until two DISTINCT people approved THIS plan.
 *     An approval names the plan digest it confirms; the plan never changes after it
 *     is stored; one person is one approval (unique per rollout and approver); and a
 *     rollout enters RUNNING only in {@link EdgeRolloutService.approve}, in the
 *     transaction that counted the approvals (tests/invariants/edge-rollout-approval
 *     pins that no other write sets it). The creator may be one of the two.
 *   - A rollout names only releases the cloud admitted (signature and provenance,
 *     through EdgeReleaseCatalog) and devices that are committed Suderra OS devices in
 *     service, and it is dry-run through the real statement builders before it is
 *     stored: a plan that could never be signed is refused at creation, before two
 *     people spend an approval on it.
 *   - Waves go in order. A wave starts only when every earlier wave concluded, and the
 *     rollout halts the moment more devices have failed than the plan allows.
 *   - A device is issued once. The signing transaction takes the device's slot
 *     (`edge_rollout_devices.request_id`) with the request, so replicas racing on one
 *     rollout cannot sign twice.
 *   - What became of a device is read from its request's campaign, never copied: a
 *     retryable refusal that the reconciler re-issued is still in flight; a refusal the
 *     campaign gave up on, a lapsed window, a final refusal and a rollback all count as
 *     failures.
 */

/** The legal edges; RUNNING is entered only by `approve`. */
const LEGAL_TRANSITIONS: Readonly<Record<EdgeRolloutState, readonly EdgeRolloutState[]>> = {
  [EdgeRolloutState.AWAITING_APPROVAL]: [EdgeRolloutState.RUNNING, EdgeRolloutState.CANCELLED],
  [EdgeRolloutState.RUNNING]: [
    EdgeRolloutState.COMPLETED,
    EdgeRolloutState.HALTED,
    EdgeRolloutState.CANCELLED,
  ],
  [EdgeRolloutState.COMPLETED]: [],
  [EdgeRolloutState.HALTED]: [],
  [EdgeRolloutState.CANCELLED]: [],
};

export function isLegalRolloutTransition(from: EdgeRolloutState, to: EdgeRolloutState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/** Where one device of a rollout stands. */

export interface RolloutDeviceStatus {
  readonly deviceId: string;
  readonly wave: number;
  readonly phase: EdgeRolloutDevicePhase;
  /** The latest request of the device's campaign. */
  readonly requestState: string | null;
  /** Why the device failed, when it did and the cloud knows. */
  readonly detail: string | null;
}

export interface RolloutProgress {
  readonly queued: number;
  readonly inFlight: number;
  readonly done: number;
  readonly failed: number;
}

interface StatusRow {
  readonly deviceId: string;
  readonly wave: number;
  readonly refusal: string | null;
  readonly requestId: string | null;
  readonly requestState: string | null;
  readonly failureDetail: string | null;
  readonly slotId: string;
}

/** A device that concluded, one way or the other. */
const SETTLED: readonly EdgeRolloutDevicePhase[] = [
  EdgeRolloutDevicePhase.DONE,
  EdgeRolloutDevicePhase.FAILED,
];

/** A device the rollout still waits for or still has to sign for. */
const OPEN: readonly EdgeRolloutDevicePhase[] = [
  EdgeRolloutDevicePhase.QUEUED,
  EdgeRolloutDevicePhase.IN_FLIGHT,
];

/** What the campaign of a device's request says about the device. */
export function phaseOf(
  row: Pick<StatusRow, 'refusal' | 'requestId' | 'requestState'>,
): EdgeRolloutDevicePhase {
  if (row.refusal !== null) return EdgeRolloutDevicePhase.FAILED;
  if (row.requestId === null) return EdgeRolloutDevicePhase.QUEUED;
  switch (row.requestState) {
    case 'pending':
    case 'retry':
    case 'reissued':
      return EdgeRolloutDevicePhase.IN_FLIGHT;
    case 'done':
      return EdgeRolloutDevicePhase.DONE;
    default:
      // failed, reschedule, lapsed — and a request that vanished, which is no success.
      return EdgeRolloutDevicePhase.FAILED;
  }
}

interface CohortDevice {
  readonly id: string;
  readonly deviceCode: string;
  readonly target: UpdateTarget;
}

/** What one advance of a tenant did. */
export interface AdvanceSummary {
  readonly issued: number;
  readonly refused: number;
  readonly halted: number;
  readonly completed: number;
}

/** The slot of the device was taken already (another replica issued it). */
class SlotTakenError extends Error {
  constructor(slotId: string) {
    super(`The rollout slot ${slotId} was taken already`);
    this.name = 'SlotTakenError';
  }
}

const NO_ADVANCE: AdvanceSummary = { issued: 0, refused: 0, halted: 0, completed: 0 };

function addAdvance(a: AdvanceSummary, b: AdvanceSummary): AdvanceSummary {
  return {
    issued: a.issued + b.issued,
    refused: a.refused + b.refused,
    halted: a.halted + b.halted,
    completed: a.completed + b.completed,
  };
}

const ROLLOUT_COLUMNS = `id, tenant_id AS "tenantId", name, kind, target, terms,
  window_not_before AS "windowNotBefore", window_seconds AS "windowSeconds",
  max_failures AS "maxFailures", approvals_required AS "approvalsRequired",
  plan_sha256 AS "planSha256", state, state_detail AS "stateDetail", created_by AS "createdBy",
  approved_at AS "approvedAt", concluded_at AS "concludedAt", created_at AS "createdAt",
  updated_at AS "updatedAt"`;

@Injectable()
export class EdgeRolloutService {
  private readonly logger = new Logger(EdgeRolloutService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly requests: EdgeUpdateRequestService,
    private readonly catalog: EdgeReleaseCatalog,
    @Inject(ScheduledJobRunner) readonly scheduledJobs: ScheduledJobExecutor,
  ) {}

  // ------------------------------------------------------------------ creating

  /**
   * Stores a plan awaiting approval. The cohort must be committed Suderra OS devices in
   * service that no other open rollout holds, and the plan must pass the real
   * statement builders for every device of it.
   */
  async create(
    tenantId: string,
    creatorId: string,
    name: string,
    plan: RolloutPlan,
    now: Date = new Date(),
  ): Promise<EdgeRollout> {
    const label = name.trim();
    if (label.length < 1 || label.length > 120) {
      throw new BadRequestException('A rollout name is 1 to 120 characters');
    }
    if (creatorId.length < 1 || creatorId.length > 128) {
      throw new BadRequestException('A rollout is created by an authenticated user');
    }
    assertPlanShape(plan);
    const cohort = await this.loadCohort(tenantId, planDevices(plan));
    await this.dryRun(plan, cohort, now);
    const digest = planDigest(plan);
    return runInTenantTransaction(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      tenantId,
      async (qr): Promise<EdgeRollout> => {
        await this.assertNotInOpenRollout(qr, tenantId, planDevices(plan));
        const inserted = await returningRows<EdgeRollout>(
          qr,
          `INSERT INTO edge_rollouts
             (tenant_id, name, kind, target, terms, window_not_before, window_seconds,
              max_failures, approvals_required, plan_sha256, state, created_by)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11, $12)
           RETURNING ${ROLLOUT_COLUMNS}`,
          [
            tenantId,
            label,
            plan.kind,
            JSON.stringify(targetOf(plan)),
            JSON.stringify(plan.terms),
            plan.windowNotBefore,
            plan.windowSeconds,
            plan.maxFailures,
            MIN_ROLLOUT_APPROVALS,
            digest,
            EdgeRolloutState.AWAITING_APPROVAL,
            creatorId,
          ],
        );
        const rollout = inserted[0];
        if (rollout === undefined) throw new Error('the rollout was not stored');
        for (const [index, wave] of plan.waves.entries()) {
          await qr.query(
            `INSERT INTO edge_rollout_devices (tenant_id, rollout_id, device_id, wave)
             SELECT $1, $2, d, $4 FROM unnest($3::uuid[]) AS d`,
            [tenantId, rollout.id, [...wave], index + 1],
          );
        }
        this.logger.log({
          event: 'edge_rollout_created',
          tenantId,
          rolloutId: rollout.id,
          kind: plan.kind,
          devices: planDevices(plan).length,
          waves: plan.waves.length,
          createdBy: creatorId,
        });
        return rollout;
      },
    );
  }

  private async loadCohort(
    tenantId: string,
    deviceIds: readonly string[],
  ): Promise<CohortDevice[]> {
    const rows: Array<{
      id: string;
      deviceCode: string;
      model: string;
      method: string | null;
      digest: string | null;
      state: string;
      channel: string;
    }> = await runInTenantRead(this.dataSource, SENSOR_SOURCE_SCHEMA, tenantId, (qr) =>
      qr.query(
        `SELECT id, device_code AS "deviceCode", device_model::text AS model,
                device_binding_method AS method, device_binding_sha256 AS digest,
                lifecycle_state::text AS state, agent_channel AS channel
           FROM edge_devices WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [tenantId, [...deviceIds]],
      ),
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    const cohort: CohortDevice[] = [];
    for (const id of deviceIds) {
      const row = byId.get(id);
      if (row === undefined)
        throw new RolloutPlanError(`device ${id} is not a device of this tenant`);
      const board = boardForDeviceModel(row.model);
      const binding =
        row.method === null || row.digest === null ? null : asDeviceBinding(row.method, row.digest);
      if (row.channel !== EdgeAgentChannel.SUDERRA_OS || board === null || binding === null) {
        throw new RolloutPlanError(
          `device ${row.deviceCode} is not a committed Suderra OS device, so no statement can be bound to it`,
        );
      }
      if (!UPDATABLE_STATES.some((state) => state === row.state)) {
        throw new RolloutPlanError(`device ${row.deviceCode} is ${row.state}, not in service`);
      }
      cohort.push({
        id,
        deviceCode: row.deviceCode,
        target: { tenantId, deviceId: id, binding, board },
      });
    }
    return cohort;
  }

  /**
   * The plan through the real statement builders, one device at a time: the window,
   * the terms, the release or bundle against the device's board. Nothing is signed;
   * the sequence value is a placeholder, the signing transaction allocates the real one.
   */
  private async dryRun(
    plan: RolloutPlan,
    cohort: readonly CohortDevice[],
    now: Date,
  ): Promise<void> {
    const notBefore = plan.windowNotBefore ?? now;
    const window: UpdateWindow = {
      notBefore,
      expiresAt: new Date(notBefore.getTime() + plan.windowSeconds * 1000),
    };
    const running = { osVersion: null, installedAgentAbi: null };
    const releases = new Map<string, AdmittedRelease>();
    for (const device of cohort) {
      try {
        if (plan.kind === EdgeRolloutKind.EDGE_UPDATE) {
          const board = device.target.board;
          let release = releases.get(board.boardProfile);
          if (release === undefined) {
            release = await this.admit(board, plan.version);
            releases.set(board.boardProfile, release);
          }
          buildEdgeUpdate({
            target: device.target,
            release,
            updateSeq: 1,
            window,
            terms: plan.terms,
            running,
          });
        } else {
          buildOsUpdate({
            target: device.target,
            bundle: plan.bundle,
            updateSeq: 1,
            window,
            terms: plan.terms,
            running,
          });
        }
      } catch (error) {
        if (error instanceof UpdateRefusedError) {
          throw new RolloutPlanError(`device ${device.deviceCode}: ${error.message}`);
        }
        throw error;
      }
    }
  }

  /** The release the catalog admits for `board`; a refusal is the plan's fault, not the service's. */
  private async admit(board: BoardRow, version: string): Promise<AdmittedRelease> {
    try {
      return await this.catalog.forVersion(board, version);
    } catch (error) {
      if (error instanceof StatementAdmissionError) throw new RolloutPlanError(error.message);
      throw error;
    }
  }

  private async assertNotInOpenRollout(
    qr: QueryRunner,
    tenantId: string,
    deviceIds: readonly string[],
  ): Promise<void> {
    const held: Array<{ deviceId: string }> = await qr.query(
      `SELECT rd.device_id AS "deviceId"
         FROM edge_rollout_devices rd JOIN edge_rollouts r ON r.id = rd.rollout_id
        WHERE r.tenant_id = $1 AND r.state IN ($2, $3) AND rd.device_id = ANY($4::uuid[])
        LIMIT 5`,
      [tenantId, EdgeRolloutState.AWAITING_APPROVAL, EdgeRolloutState.RUNNING, [...deviceIds]],
    );
    if (held.length > 0) {
      throw new RolloutPlanError(
        `device ${held.map((row) => row.deviceId).join(', ')} is in another rollout that has not ended`,
      );
    }
  }

  // ----------------------------------------------------------------- approving

  /**
   * One person's approval of the plan with digest `planSha256`. The rollout row is
   * locked, so approvals serialize; the approval is recorded once per person (asking
   * again changes nothing); and when the count of distinct approvers reaches what the
   * rollout requires, the rollout starts — here, and nowhere else.
   */
  async approve(
    tenantId: string,
    approverId: string,
    rolloutId: string,
    planSha256: string,
  ): Promise<EdgeRollout> {
    if (approverId.length < 1 || approverId.length > 128) {
      throw new BadRequestException('A rollout is approved by an authenticated user');
    }
    return runInTenantTransaction(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      tenantId,
      async (qr): Promise<EdgeRollout> => {
        const locked: EdgeRollout[] = await qr.query(
          `SELECT ${ROLLOUT_COLUMNS} FROM edge_rollouts WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
          [rolloutId, tenantId],
        );
        const rollout = locked[0];
        if (rollout === undefined) throw new NotFoundException(`Rollout ${rolloutId} not found`);
        if (rollout.state !== EdgeRolloutState.AWAITING_APPROVAL) {
          throw new BadRequestException(
            `Rollout ${rolloutId} is ${rollout.state}, not awaiting approval`,
          );
        }
        if (planSha256 !== rollout.planSha256) {
          throw new BadRequestException(
            'The approval names another plan than this rollout: review the rollout and approve its current digest',
          );
        }
        await qr.query(
          `INSERT INTO edge_rollout_approvals (tenant_id, rollout_id, approver_id, plan_sha256)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (rollout_id, approver_id) DO NOTHING`,
          [tenantId, rolloutId, approverId, rollout.planSha256],
        );
        const counted: Array<{ approvers: string }> = await qr.query(
          `SELECT count(DISTINCT approver_id)::text AS approvers
             FROM edge_rollout_approvals WHERE rollout_id = $1 AND plan_sha256 = $2`,
          [rolloutId, rollout.planSha256],
        );
        const approvers = Number(counted[0]?.approvers ?? 0);
        if (approvers < Math.max(rollout.approvalsRequired, MIN_ROLLOUT_APPROVALS)) return rollout;
        const started = await returningRows<EdgeRollout>(
          qr,
          `UPDATE edge_rollouts
              SET state = 'running', approved_at = now(), updated_at = now()
            WHERE id = $1 AND tenant_id = $2 AND state = 'awaiting-approval'
        RETURNING ${ROLLOUT_COLUMNS}`,
          [rolloutId, tenantId],
        );
        const running = started[0];
        if (running === undefined) throw new Error('the approved rollout did not start');
        this.logger.log({ event: 'edge_rollout_approved', tenantId, rolloutId, approvers });
        return running;
      },
    );
  }

  // ----------------------------------------------------------------- cancelling

  /** Ends a rollout an operator no longer wants; undelivered requests of it are concluded. */
  async cancel(
    tenantId: string,
    actorId: string,
    rolloutId: string,
    reason: string,
  ): Promise<EdgeRollout> {
    const detail = `cancelled by ${actorId}: ${reason.trim() || 'no reason given'}`;
    const ended = await this.transition(tenantId, rolloutId, EdgeRolloutState.CANCELLED, detail);
    if (ended === null) {
      const current = await this.get(tenantId, rolloutId);
      throw new BadRequestException(
        `Rollout ${rolloutId} is ${current.state} and cannot be cancelled`,
      );
    }
    const stopped = await this.requests.concludeForRollout(
      tenantId,
      rolloutId,
      'rollout cancelled',
    );
    this.logger.log({ event: 'edge_rollout_cancelled', tenantId, rolloutId, actorId, stopped });
    return ended;
  }

  /** One conditional write per edge: the row moves only from a state the map allows. */
  private async transition(
    tenantId: string,
    rolloutId: string,
    to: EdgeRolloutState.COMPLETED | EdgeRolloutState.HALTED | EdgeRolloutState.CANCELLED,
    detail: string | null,
  ): Promise<EdgeRollout | null> {
    const from = Object.values(EdgeRolloutState).filter((state) =>
      isLegalRolloutTransition(state, to),
    );
    const rows = await runInTenantTransaction(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      tenantId,
      (qr) =>
        returningRows<EdgeRollout>(
          qr,
          `UPDATE edge_rollouts
            SET state = $3, state_detail = $4, concluded_at = now(), updated_at = now()
          WHERE id = $1 AND tenant_id = $2 AND state = ANY($5::text[])
      RETURNING ${ROLLOUT_COLUMNS}`,
          [rolloutId, tenantId, to, detail?.slice(0, 256) ?? null, from],
        ),
    );
    return rows[0] ?? null;
  }

  // ------------------------------------------------------------------ advancing

  /** The scheduled entry point (a tick takes no arguments and returns nothing). */
  @ScheduledJob({ name: 'edge-rollout.advance', every: 60_000 })
  async advanceTick(): Promise<void> {
    await this.advanceAll(new Date());
  }

  async advanceAll(now: Date): Promise<AdvanceSummary> {
    let tenants: Awaited<ReturnType<typeof listActiveTenantSchemaIdentities>>;
    try {
      tenants = await listActiveTenantSchemaIdentities(this.dataSource);
    } catch (error) {
      this.logger.error({
        event: 'edge_rollout_tenants_unavailable',
        error: error instanceof Error ? error.message : String(error),
      });
      return NO_ADVANCE;
    }
    let total = NO_ADVANCE;
    for (const { tenantId } of tenants) {
      try {
        total = addAdvance(total, await this.advanceTenant(tenantId, now));
      } catch (error) {
        this.logger.error({
          event: 'edge_rollout_advance_failed',
          tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return total;
  }

  /** Moves every running rollout of a tenant one step: halt, complete, or sign its wave in turn. */
  async advanceTenant(tenantId: string, now: Date): Promise<AdvanceSummary> {
    const running: EdgeRollout[] = await runInTenantRead(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      tenantId,
      (qr) =>
        qr.query(
          `SELECT ${ROLLOUT_COLUMNS} FROM edge_rollouts
            WHERE tenant_id = $1 AND state = 'running' ORDER BY created_at, id LIMIT 100`,
          [tenantId],
        ),
    );
    let summary = NO_ADVANCE;
    for (const rollout of running) {
      try {
        summary = addAdvance(summary, await this.advanceRollout(rollout, now));
      } catch (error) {
        this.logger.error({
          event: 'edge_rollout_step_failed',
          tenantId,
          rolloutId: rollout.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return summary;
  }

  private async advanceRollout(rollout: EdgeRollout, now: Date): Promise<AdvanceSummary> {
    const none = NO_ADVANCE;
    const rows = await this.statusRows(rollout.tenantId, rollout.id);
    const failed = rows.filter((row) => phaseOf(row) === EdgeRolloutDevicePhase.FAILED).length;
    if (failed > rollout.maxFailures) {
      const detail = `${failed} devices failed, the plan allows ${rollout.maxFailures}`;
      const halted = await this.transition(
        rollout.tenantId,
        rollout.id,
        EdgeRolloutState.HALTED,
        detail,
      );
      if (halted === null) return none;
      const stopped = await this.requests.concludeForRollout(
        rollout.tenantId,
        rollout.id,
        'rollout halted',
      );
      this.logger.error({
        event: 'edge_rollout_halted',
        tenantId: rollout.tenantId,
        rolloutId: rollout.id,
        failed,
        allowed: rollout.maxFailures,
        stopped,
      });
      return { ...none, halted: 1 };
    }
    if (rows.every((row) => SETTLED.includes(phaseOf(row)))) {
      const completed = await this.transition(
        rollout.tenantId,
        rollout.id,
        EdgeRolloutState.COMPLETED,
        null,
      );
      return completed === null ? none : { ...none, completed: 1 };
    }
    // The wave in turn is the lowest one with a device still to conclude.
    const wave = Math.min(
      ...rows.filter((row) => OPEN.includes(phaseOf(row))).map((row) => row.wave),
    );
    const queued = rows.filter(
      (row) => row.wave === wave && phaseOf(row) === EdgeRolloutDevicePhase.QUEUED,
    );
    if (queued.length === 0) return none;
    const recipe = recipeOf(rollout);
    if (recipe === null) {
      this.logger.error({
        event: 'edge_rollout_recipe_invalid',
        tenantId: rollout.tenantId,
        rolloutId: rollout.id,
      });
      return none;
    }
    return this.issueWave(rollout, recipe, queued, now);
  }

  private async issueWave(
    rollout: EdgeRollout,
    recipe: UpdateRecipe,
    queued: readonly StatusRow[],
    now: Date,
  ): Promise<AdvanceSummary> {
    const notBefore =
      rollout.windowNotBefore !== null && rollout.windowNotBefore.getTime() > now.getTime()
        ? rollout.windowNotBefore
        : now;
    const window: UpdateWindow = {
      notBefore,
      expiresAt: new Date(notBefore.getTime() + rollout.windowSeconds * 1000),
    };
    const releases = new Map<string, AdmittedRelease>();
    const releaseFor = async (board: BoardRow, version: string): Promise<AdmittedRelease> => {
      const known = releases.get(board.boardProfile);
      if (known !== undefined) return known;
      const admitted = await this.catalog.forVersion(board, version);
      releases.set(board.boardProfile, admitted);
      return admitted;
    };
    let issued = 0;
    let refused = 0;
    for (const slot of queued) {
      const device = { id: slot.deviceId, tenantId: rollout.tenantId };
      const meta = {
        rolloutId: rollout.id,
        createdBy: rollout.createdBy,
        afterStore: (qr: QueryRunner, requestId: string): Promise<void> =>
          this.takeSlot(qr, rollout.tenantId, slot.slotId, requestId),
      };
      try {
        await this.requests.issueFromRecipe(device, recipe, window, meta, releaseFor);
        issued += 1;
      } catch (error) {
        if (error instanceof SlotTakenError) continue;
        if (
          error instanceof UpdateRefusedError ||
          error instanceof UpdateTargetUnavailableError ||
          error instanceof StatementAdmissionError ||
          error instanceof TenantOutOfBundleScopeError
        ) {
          if (await this.refuseSlot(rollout.tenantId, slot.slotId, error.message)) refused += 1;
          continue;
        }
        // Not a verdict on this device: a dependency is down. The next tick asks again.
        this.logger.warn({
          event: 'edge_rollout_issue_deferred',
          tenantId: rollout.tenantId,
          rolloutId: rollout.id,
          deviceId: device.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { issued, refused, halted: 0, completed: 0 };
  }

  /** In the signing transaction: the device's one issue of this rollout. */
  private async takeSlot(
    qr: QueryRunner,
    tenantId: string,
    slotId: string,
    requestId: string,
  ): Promise<void> {
    const taken = await returningRows<{ id: string }>(
      qr,
      `UPDATE edge_rollout_devices SET request_id = $3
        WHERE id = $1 AND tenant_id = $2 AND request_id IS NULL AND refusal IS NULL
    RETURNING id`,
      [slotId, tenantId, requestId],
    );
    if (taken.length === 0) throw new SlotTakenError(slotId);
  }

  /** The cloud would not sign for this device: the device failed the rollout, once. */
  private async refuseSlot(tenantId: string, slotId: string, reason: string): Promise<boolean> {
    const refused = await runInTenantTransaction(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      tenantId,
      (qr) =>
        returningRows<{ id: string }>(
          qr,
          `UPDATE edge_rollout_devices SET refusal = $3
          WHERE id = $1 AND tenant_id = $2 AND request_id IS NULL AND refusal IS NULL
      RETURNING id`,
          [slotId, tenantId, reason.slice(0, 256)],
        ),
    );
    return refused.length > 0;
  }

  // -------------------------------------------------------------------- reading

  private async statusRows(tenantId: string, rolloutId: string): Promise<StatusRow[]> {
    return runInTenantRead(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      tenantId,
      (qr): Promise<StatusRow[]> =>
        qr.query(
          `SELECT rd.id AS "slotId", rd.device_id AS "deviceId", rd.wave::int AS wave, rd.refusal,
                  rd.request_id AS "requestId", last.state AS "requestState",
                  last.failure_detail AS "failureDetail"
             FROM edge_rollout_devices rd
             LEFT JOIN edge_update_requests first_r ON first_r.id = rd.request_id
             LEFT JOIN LATERAL (
                   SELECT r.state, r.failure_detail FROM edge_update_requests r
                    WHERE r.intent_id = first_r.intent_id AND r.device_id = rd.device_id
                    ORDER BY r.created_at DESC, r.id DESC LIMIT 1) last ON true
            WHERE rd.tenant_id = $1 AND rd.rollout_id = $2
            ORDER BY rd.wave, rd.created_at, rd.id`,
          [tenantId, rolloutId],
        ),
    );
  }

  async get(tenantId: string, rolloutId: string): Promise<EdgeRollout> {
    const rows: EdgeRollout[] = await runInTenantRead(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      tenantId,
      (qr) =>
        qr.query(`SELECT ${ROLLOUT_COLUMNS} FROM edge_rollouts WHERE id = $1 AND tenant_id = $2`, [
          rolloutId,
          tenantId,
        ]),
    );
    const rollout = rows[0];
    if (rollout === undefined) throw new NotFoundException(`Rollout ${rolloutId} not found`);
    return rollout;
  }

  async list(tenantId: string, state?: EdgeRolloutState, limit = 50): Promise<EdgeRollout[]> {
    const bounded = Math.min(Math.max(1, Math.trunc(limit)), 200);
    return runInTenantRead(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      tenantId,
      (qr): Promise<EdgeRollout[]> =>
        qr.query(
          `SELECT ${ROLLOUT_COLUMNS} FROM edge_rollouts
            WHERE tenant_id = $1 AND ($2::text IS NULL OR state = $2)
            ORDER BY created_at DESC, id DESC LIMIT $3`,
          [tenantId, state ?? null, bounded],
        ),
    );
  }

  async approvals(tenantId: string, rolloutId: string): Promise<EdgeRolloutApproval[]> {
    return runInTenantRead(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      tenantId,
      (qr): Promise<EdgeRolloutApproval[]> =>
        qr.query(
          `SELECT id, tenant_id AS "tenantId", rollout_id AS "rolloutId", approver_id AS "approverId",
                  plan_sha256 AS "planSha256", approved_at AS "approvedAt"
             FROM edge_rollout_approvals WHERE tenant_id = $1 AND rollout_id = $2
            ORDER BY approved_at, id`,
          [tenantId, rolloutId],
        ),
    );
  }

  /** Where each device of a rollout stands, wave by wave. */
  async devices(tenantId: string, rolloutId: string): Promise<RolloutDeviceStatus[]> {
    const rows = await this.statusRows(tenantId, rolloutId);
    return rows.map((row) => ({
      deviceId: row.deviceId,
      wave: row.wave,
      phase: phaseOf(row),
      requestState: row.requestState,
      detail: row.refusal ?? row.failureDetail,
    }));
  }

  async progress(tenantId: string, rolloutId: string): Promise<RolloutProgress> {
    const phases = (await this.statusRows(tenantId, rolloutId)).map(phaseOf);
    const count = (phase: EdgeRolloutDevicePhase): number =>
      phases.filter((p) => p === phase).length;
    return {
      queued: count(EdgeRolloutDevicePhase.QUEUED),
      inFlight: count(EdgeRolloutDevicePhase.IN_FLIGHT),
      done: count(EdgeRolloutDevicePhase.DONE),
      failed: count(EdgeRolloutDevicePhase.FAILED),
    };
  }
}
