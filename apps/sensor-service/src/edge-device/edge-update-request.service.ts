import { randomUUID } from 'crypto';

import {
  runInTenantRead,
  runInTenantTransaction,
  SENSOR_SOURCE_SCHEMA,
} from '@aquaculture/backend-common/database';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';

import { EdgeCommandPublisher } from './edge-command-publisher.service';
import { type BoardRow, boardForDeviceModel } from './edge-boards';
import {
  asDeviceBinding,
  type SignedStatement,
  STATEMENT,
  type StatementBodies,
} from './edge-contract';
import type { AdmittedRelease } from './edge-release-catalog.service';
import { EdgeResultTelemetryService, type ResultEvent } from './edge-result-telemetry.service';
import {
  type CarriedStatementType,
  resultKindOf,
  settleVerdict,
  UPDATE_CHANNEL,
} from './edge-update-channel';
import {
  EdgeUpdateManifestService,
  type OsBundle,
  type UpdateTarget,
  type UpdateTerms,
  type UpdateWindow,
  UpdateRefusedError,
} from './edge-update-manifest.service';
import type { EdgeUpdateRecipe, OsUpdateRecipe, UpdateRecipe } from './edge-update-recipe';
import {
  DeviceLifecycleState,
  EdgeAgentChannel,
  type EdgeDevice,
} from './entities/edge-device.entity';
import { EdgeUpdateRequestState } from './entities/edge-update-request.entity';
import { returningRows } from './returning-rows';

/**
 * The update requests the cloud owes Suderra OS devices (ADR-048 DEC-2, DEC-2.12;
 * channels.json update_channel): signed statements stored as signed, delivered on
 * the device's heartbeats inside their window as `request_update` hand-over commands,
 * and concluded by the one result document root writes about each.
 *
 * Rules this service holds to, each from the contract and each tested against it:
 *
 *   - `update_seq` is the device's `edge_statement_seq`, allocated by one
 *     conditional UPDATE in the transaction that signs and stores the statement:
 *     every value is above every value signed before, a refusal rolls it back, and
 *     two replicas cannot allocate the same one.
 *   - A statement with a window is delivered only inside it with 600 s left, never
 *     early "so root applies it when it opens" (root concludes an entry at its first
 *     look, and a conclusion is final).
 *   - The hand-over response says only that the spool holds the file. Only a
 *     result of the request's kind that names its digest concludes the request
 *     (`settleVerdict`); silence ends at `expires_at` (LAPSED).
 *   - A re-issue is a new statement of the same intent, never the same bytes
 *     (a verified statement spends its sequence value): it is the reconciler's job
 *     (edge-update-reconciler.service.ts), not this service's.
 *
 * What a result says is device-reported evidence. It decides one thing here, which
 * request of this tenant's own rows is concluded; it never creates or changes a
 * statement.
 */

/** The agent's refusals a later delivery can cure; any other reason means the statement can never be handed over. */
const TRANSIENT_HANDOFF_REFUSALS: ReadonlySet<string> = new Set([
  'update-requests-backlog',
  'io-error',
  'trust-anchors-unavailable',
]);

/** The lifecycle states of a committed device an update statement may be issued for. */
export const UPDATABLE_STATES: readonly DeviceLifecycleState[] = [
  DeviceLifecycleState.ACTIVE,
  DeviceLifecycleState.OFFLINE,
  DeviceLifecycleState.ERROR,
];

export interface IssueMeta {
  readonly rolloutId?: string | null;
  /** An existing campaign, when this is a re-issue. */
  readonly intentId?: string;
  readonly campaignStartedAt?: Date;
  readonly createdBy?: string | null;
  /**
   * The RETRY request this statement replaces. It is marked REISSUED in the signing
   * transaction, so a re-issue and the end of the request it replaces are one commit:
   * two replicas reconciling at once cannot both re-issue it.
   */
  readonly supersedes?: string;
  /**
   * Runs inside the signing transaction once the request is stored, with the
   * transaction's query runner and the new request's id. What it writes commits
   * with the request or not at all; what it throws rolls the request and its
   * sequence value back. A rollout uses it to take its device's one issue.
   */
  readonly afterStore?: (qr: QueryRunner, requestId: string) => Promise<void>;
}

export interface EdgeUpdateIssue extends IssueMeta {
  readonly release: AdmittedRelease;
  readonly window: UpdateWindow;
  readonly terms: UpdateTerms;
  readonly recipe: EdgeUpdateRecipe;
}

export interface OsUpdateIssue extends IssueMeta {
  readonly bundle: OsBundle;
  readonly window: UpdateWindow;
  readonly terms: UpdateTerms;
  readonly recipe: OsUpdateRecipe;
}

/** A stored request, as far as a caller needs it. */
export interface IssuedUpdateRequest {
  readonly id: string;
  readonly intentId: string;
  readonly statementType: CarriedStatementType;
  readonly statementDigest: string;
  readonly updateSeq: number | null;
  readonly notBefore: Date;
  readonly expiresAt: Date | null;
}

/** The device cannot take an update statement now; nothing was signed or stored. */
export class UpdateTargetUnavailableError extends Error {
  constructor(deviceId: string) {
    super(
      `Device ${deviceId} cannot take an update statement: it is not a committed Suderra OS device in service`,
    );
    this.name = 'UpdateTargetUnavailableError';
  }
}

/** The request to replace is no longer an open RETRY of this device (another replica re-issued it, or it was concluded). */
export class RequestNotReissuableError extends Error {
  constructor(requestId: string) {
    super(`Update request ${requestId} is no longer a retryable request awaiting a re-issue`);
    this.name = 'RequestNotReissuableError';
  }
}

export type DeviceRef = Pick<EdgeDevice, 'id' | 'tenantId'>;

interface AllocatedTarget {
  readonly updateSeq: number;
  readonly target: UpdateTarget;
}

interface RequestRow {
  readonly id: string;
  readonly device_id: string;
  readonly statement_type: string;
  readonly statement_digest: string;
  readonly state: EdgeUpdateRequestState;
  readonly expires_at: Date | null;
}

@Injectable()
export class EdgeUpdateRequestService implements OnModuleInit {
  private readonly logger = new Logger(EdgeUpdateRequestService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly manifests: EdgeUpdateManifestService,
    private readonly commands: EdgeCommandPublisher,
    private readonly results: EdgeResultTelemetryService,
  ) {}

  onModuleInit(): void {
    this.results.addObserver((event) => this.onResult(event));
  }

  private onResult(event: ResultEvent): Promise<void> {
    return event.result.kind === EDGE_ROLLBACK_KIND
      ? this.recordRollback(event)
      : this.settleFromResult(event);
  }

  // ------------------------------------------------------------------- issuing

  /** Signs and stores an agent update of `device` to an admitted release. */
  async issueEdgeUpdate(device: DeviceRef, input: EdgeUpdateIssue): Promise<IssuedUpdateRequest> {
    const running = {
      osVersion: await this.results.latestOsVersion(device.tenantId, device.id),
      installedAgentAbi: null,
    };
    return this.issue(
      device,
      STATEMENT.edgeUpdate,
      input,
      input.window,
      input.recipe,
      null,
      ({ updateSeq, target }) =>
        this.manifests.signEdgeUpdate({
          target,
          release: input.release,
          updateSeq,
          window: input.window,
          terms: input.terms,
          running,
        }),
    );
  }

  /** Signs and stores an OS update of `device` to a registered bundle. */
  async issueOsUpdate(device: DeviceRef, input: OsUpdateIssue): Promise<IssuedUpdateRequest> {
    const running = {
      osVersion: await this.results.latestOsVersion(device.tenantId, device.id),
      installedAgentAbi: null,
    };
    return this.issue(
      device,
      STATEMENT.osUpdate,
      input,
      input.window,
      input.recipe,
      null,
      ({ updateSeq, target }) =>
        this.manifests.signOsUpdate({
          target,
          bundle: input.bundle,
          updateSeq,
          window: input.window,
          terms: input.terms,
          running,
        }),
    );
  }

  /**
   * One transaction: allocate the device's next update_seq, build and sign the
   * statement from it, store it. A statement the manifest service refuses leaves
   * no trace — the allocation rolls back with it.
   */
  protected async issue<T extends keyof StatementBodies>(
    device: DeviceRef,
    type: CarriedStatementType,
    meta: IssueMeta,
    window: UpdateWindow,
    recipe: UpdateRecipe,
    siteBundle: string | null,
    sign: (allocated: AllocatedTarget) => SignedStatement<T>,
  ): Promise<IssuedUpdateRequest> {
    const now = new Date();
    return runInTenantTransaction(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      device.tenantId,
      async (qr) => {
        const allocated = await this.allocate(qr, device);
        const signed = sign(allocated);
        const statement = JSON.stringify(signed.envelope);
        if (Buffer.byteLength(statement, 'utf8') > UPDATE_CHANNEL.maxStatementBytes) {
          throw new UpdateRefusedError(
            'bundle-invalid',
            `the signed statement is over the ${UPDATE_CHANNEL.maxStatementBytes} bytes a hand-over command carries`,
          );
        }
        const intentId = meta.intentId ?? randomUUID();
        const inserted: Array<{ id: string }> = await qr.query(
          `INSERT INTO edge_update_requests
             (tenant_id, device_id, rollout_id, intent_id, statement_type, update_seq,
              statement_digest, statement, site_bundle, recipe, not_before, expires_at, state,
              campaign_started_at, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15)
           RETURNING id`,
          [
            device.tenantId,
            device.id,
            meta.rolloutId ?? null,
            intentId,
            type,
            allocated.updateSeq,
            signed.digest.sha256,
            statement,
            siteBundle,
            JSON.stringify(recipe),
            window.notBefore,
            window.expiresAt,
            EdgeUpdateRequestState.PENDING,
            meta.campaignStartedAt ?? now,
            meta.createdBy ?? null,
          ],
        );
        const id = inserted[0]?.id;
        if (id === undefined) throw new Error('the update request was not stored');
        if (meta.supersedes !== undefined) {
          await this.supersede(qr, device, meta.supersedes, id);
        }
        if (meta.afterStore !== undefined) await meta.afterStore(qr, id);
        return {
          id,
          intentId,
          statementType: type,
          statementDigest: signed.digest.sha256,
          updateSeq: allocated.updateSeq,
          notBefore: window.notBefore,
          expiresAt: window.expiresAt,
        };
      },
    );
  }

  private async allocate(qr: QueryRunner, device: DeviceRef): Promise<AllocatedTarget> {
    const rows = await returningRows<{
      seq: string | number;
      method: string;
      digest: string;
      model: string;
    }>(
      qr,
      `UPDATE edge_devices
          SET edge_statement_seq = edge_statement_seq + 1
        WHERE id = $1 AND tenant_id = $2 AND agent_channel = $3
          AND device_binding_sha256 IS NOT NULL AND device_binding_method IS NOT NULL
          AND lifecycle_state::text = ANY($4::text[])
      RETURNING edge_statement_seq AS seq, device_binding_method AS method,
                device_binding_sha256 AS digest, device_model::text AS model`,
      [device.id, device.tenantId, EdgeAgentChannel.SUDERRA_OS, UPDATABLE_STATES],
    );
    const row = rows[0];
    if (row === undefined) throw new UpdateTargetUnavailableError(device.id);
    const binding = asDeviceBinding(row.method, row.digest);
    const board = boardForDeviceModel(row.model);
    if (binding === null || board === null) throw new UpdateTargetUnavailableError(device.id);
    return {
      updateSeq: Number(row.seq),
      target: { tenantId: device.tenantId, deviceId: device.id, binding, board },
    };
  }

  /** Ends the RETRY request `previousId` as REISSUED by `successorId`; refuses when it is not an open RETRY of the device. */
  private async supersede(
    qr: QueryRunner,
    device: DeviceRef,
    previousId: string,
    successorId: string,
  ): Promise<void> {
    const replaced = await returningRows<{ id: string }>(
      qr,
      `UPDATE edge_update_requests
          SET state = 'reissued', superseded_by = $4, updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND device_id = $3
          AND state = 'retry' AND superseded_by IS NULL
    RETURNING id`,
      [previousId, device.tenantId, device.id, successorId],
    );
    if (replaced.length === 0) throw new RequestNotReissuableError(previousId);
  }

  /** The board of a device's committed model, or null when the device is gone or is not a Suderra OS board. */
  async boardOf(device: DeviceRef): Promise<BoardRow | null> {
    const rows: Array<{ model: string }> = await runInTenantRead(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      device.tenantId,
      (qr) =>
        qr.query(
          `SELECT device_model::text AS model FROM edge_devices WHERE id = $1 AND tenant_id = $2`,
          [device.id, device.tenantId],
        ),
    );
    const row = rows[0];
    return row === undefined ? null : boardForDeviceModel(row.model);
  }

  // ------------------------------------------------------------------ delivery

  /**
   * A heartbeat from a Suderra OS device: hands it the requests it is owed, each
   * inside its window with the delivery margin left, each at most once per
   * redelivery interval, while the spool has room. Returns how many were published.
   */
  async deliverDue(
    device: Pick<EdgeDevice, 'id' | 'tenantId' | 'agentChannel'>,
    now: Date,
    redeliveryIntervalMs: number,
  ): Promise<number> {
    if (device.agentChannel !== EdgeAgentChannel.SUDERRA_OS) return 0;
    let published = 0;
    for (let i = 0; i < UPDATE_CHANNEL.maxPendingEntries; i += 1) {
      const commandId = randomUUID();
      const claimed = await this.claimDelivery(device, now, redeliveryIntervalMs, commandId);
      if (claimed === null) break;
      try {
        await this.commands.publish(
          { tenantId: device.tenantId, deviceId: device.id },
          { commandId, command: 'request_update', params: { statement: claimed.statement } },
        );
        published += 1;
        this.logger.log({
          event: 'update_request_delivered',
          deviceId: device.id,
          requestId: claimed.id,
          commandId,
        });
      } catch (error) {
        // A refused publish never fails the heartbeat; the next paced one retries.
        this.logger.warn({
          event: 'update_request_delivery_failed',
          deviceId: device.id,
          requestId: claimed.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return published;
  }

  private async claimDelivery(
    device: Pick<EdgeDevice, 'id' | 'tenantId'>,
    now: Date,
    redeliveryIntervalMs: number,
    commandId: string,
  ): Promise<{ id: string; statement: string } | null> {
    const latestStart = new Date(now.getTime() + UPDATE_CHANNEL.deliveryMarginSeconds * 1000);
    const redeliverBefore = new Date(now.getTime() - redeliveryIntervalMs);
    const rows: Array<{ id: string; statement: string }> = await runInTenantTransaction(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      device.tenantId,
      (qr) =>
        returningRows<{ id: string; statement: string }>(
          qr,
          `UPDATE edge_update_requests r
              SET delivered_at = $3, last_command_id = $4, updated_at = now()
            WHERE r.id = (
              SELECT c.id FROM edge_update_requests c
               WHERE c.tenant_id = $1 AND c.device_id = $2
                 AND c.state = 'pending' AND c.handed_at IS NULL
                 AND c.not_before <= $3
                 AND (c.expires_at IS NULL OR c.expires_at > $5)
                 AND (c.delivered_at IS NULL OR c.delivered_at <= $6)
                 AND (SELECT count(*) FROM edge_update_requests s
                       WHERE s.device_id = $2 AND s.state = 'pending' AND s.handed_at IS NOT NULL) < $7
               ORDER BY c.created_at, c.id
               LIMIT 1
               FOR UPDATE SKIP LOCKED)
        RETURNING r.id, r.statement`,
          [
            device.tenantId,
            device.id,
            now,
            commandId,
            latestStart,
            redeliverBefore,
            UPDATE_CHANNEL.maxPendingEntries,
          ],
        ),
    );
    return rows[0] ?? null;
  }

  /**
   * The agent's response named a digest it handed to root: the spool holds the
   * file. That is not a verdict (only a result is); it only stops the delivery.
   * True when the digest was a pending request of this device.
   */
  async markHanded(device: DeviceRef, digestSha256: string, now: Date): Promise<boolean> {
    const rows: Array<{ id: string }> = await runInTenantTransaction(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      device.tenantId,
      (qr) =>
        returningRows<{ id: string }>(
          qr,
          `UPDATE edge_update_requests
              SET handed_at = $4, handoff_refusal = NULL, updated_at = now()
            WHERE tenant_id = $1 AND device_id = $2 AND statement_digest = $3
              AND state = 'pending' AND handed_at IS NULL
        RETURNING id`,
          [device.tenantId, device.id, digestSha256, now],
        ),
    );
    return rows.length > 0;
  }

  /**
   * The agent refused to hand a statement over (the response names its command
   * id, never a digest). A refusal the agent can recover from — a full spool, a
   * filesystem error — keeps the request owed; any other reason means this
   * statement can never be carried, which is a defect of the producer, so the
   * request fails loudly instead of being redelivered for ever. True when the
   * command id was a delivery of this device's pending request.
   */
  async recordHandoffRefusal(
    device: DeviceRef,
    commandId: string,
    reasons: readonly string[],
    now: Date,
  ): Promise<boolean> {
    const summary = reasons.join(',').slice(0, 256);
    const permanent = reasons.some((reason) => !TRANSIENT_HANDOFF_REFUSALS.has(reason));
    const rows: Array<{ id: string }> = await runInTenantTransaction(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      device.tenantId,
      (qr) =>
        returningRows<{ id: string }>(
          qr,
          permanent
            ? `UPDATE edge_update_requests
                  SET handoff_refusal = $4, state = 'failed', settled_outcome = 'handoff-refused',
                      settled_reason = $5, settled_at = $6, updated_at = now()
                WHERE tenant_id = $1 AND device_id = $2 AND last_command_id = $3
                  AND state = 'pending' AND handed_at IS NULL
            RETURNING id`
            : `UPDATE edge_update_requests
                  SET handoff_refusal = $4, updated_at = now()
                WHERE tenant_id = $1 AND device_id = $2 AND last_command_id = $3
                  AND state = 'pending' AND handed_at IS NULL
            RETURNING id`,
          permanent
            ? [
                device.tenantId,
                device.id,
                commandId,
                summary,
                (reasons[0] ?? 'refused').slice(0, 64),
                now,
              ]
            : [device.tenantId, device.id, commandId, summary],
        ),
    );
    if (permanent && rows.length > 0) {
      this.logger.error({
        event: 'update_request_unhandable',
        deviceId: device.id,
        commandId,
        reasons,
      });
    }
    return rows.length > 0;
  }

  // ---------------------------------------------------------------- settlement

  /**
   * A result a device reported: if it concludes one of this device's requests
   * (its kind is the request's result kind and it names the statement digest),
   * the request ends the way `settleVerdict` says. A request already concluded
   * stays as it is (a republication settles nothing twice); a LAPSED one is
   * concluded after all, because a device that was offline at the window's end
   * reports what it did when it comes back.
   */
  async settleFromResult(event: ResultEvent): Promise<void> {
    const digest = event.result.subject?.statement_digest?.sha256;
    if (digest === undefined) return;
    await runInTenantTransaction(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      event.tenantId,
      async (qr) => {
        const rows: RequestRow[] = await qr.query(
          `SELECT id, device_id, statement_type, statement_digest, state, expires_at
             FROM edge_update_requests
            WHERE tenant_id = $1 AND device_id = $2 AND statement_digest = $3
            FOR UPDATE`,
          [event.tenantId, event.deviceId, digest],
        );
        const row = rows[0];
        if (
          row === undefined ||
          (row.state !== EdgeUpdateRequestState.PENDING &&
            row.state !== EdgeUpdateRequestState.LAPSED)
        ) {
          return;
        }
        const type = STATEMENT_TYPES.find((candidate) => candidate === row.statement_type);
        if (type === undefined || event.result.kind !== resultKindOf(type)) return;
        const verdict = settleVerdict(
          { resultKind: event.result.kind, digestSha256: digest, expiresAt: row.expires_at },
          [event.result],
          new Date(),
        );
        const state = STATE_OF_VERDICT[verdict];
        if (state === undefined) return;
        await qr.query(
          `UPDATE edge_update_requests
              SET state = $2, settled_result_seq = $3, settled_outcome = $4, settled_reason = $5,
                  settled_at = now(), updated_at = now()
            WHERE id = $1`,
          [row.id, state, event.result.seq, event.result.outcome, event.result.reason ?? null],
        );
        this.logger.log({
          event: 'update_request_settled',
          deviceId: event.deviceId,
          requestId: row.id,
          statementType: type,
          verdict,
          reason: event.result.reason ?? null,
        });
      },
    );
  }

  /**
   * Silence ends at `expires_at`: a pending request whose window closed with no
   * result is LAPSED (a result that arrives later still concludes it). Returns
   * the number marked, for one tenant.
   */
  async lapseDue(tenantId: string, now: Date): Promise<number> {
    const rows: Array<{ id: string }> = await runInTenantTransaction(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      tenantId,
      (qr) =>
        returningRows<{ id: string }>(
          qr,
          `UPDATE edge_update_requests
              SET state = 'lapsed', settled_at = $2, updated_at = now()
            WHERE tenant_id = $1 AND state = 'pending'
              AND expires_at IS NOT NULL AND expires_at <= $2
        RETURNING id`,
          [tenantId, now],
        ),
    );
    return rows.length;
  }

  /**
   * The open RETRY requests of a tenant, oldest refusal first: each waits for a new
   * statement of its intent. At most `limit` per call, so a reconciliation tick is bounded.
   */
  async reissueCandidates(tenantId: string, limit = 100): Promise<ReissueCandidate[]> {
    const bounded = Math.min(Math.max(1, Math.trunc(limit)), 500);
    return runInTenantRead(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      tenantId,
      async (qr): Promise<ReissueCandidate[]> => {
        const found: Array<{
          id: string;
          deviceId: string;
          intentId: string;
          rolloutId: string | null;
          statementType: string;
          recipe: unknown;
          campaignStartedAt: Date;
          refusedAt: Date;
          refusalReason: string | null;
          createdBy: string | null;
        }> = await qr.query(
          `SELECT id, device_id AS "deviceId", intent_id AS "intentId", rollout_id AS "rolloutId",
                  statement_type AS "statementType", recipe,
                  campaign_started_at AS "campaignStartedAt", settled_at AS "refusedAt",
                  settled_reason AS "refusalReason", created_by AS "createdBy"
             FROM edge_update_requests
            WHERE tenant_id = $1 AND state = 'retry' AND superseded_by IS NULL
              AND settled_at IS NOT NULL
            ORDER BY settled_at, id LIMIT $2`,
          [tenantId, bounded],
        );
        return found.flatMap((row) => {
          const type = STATEMENT_TYPES.find((candidate) => candidate === row.statementType);
          return type === undefined ? [] : [{ ...row, tenantId, statementType: type }];
        });
      },
    );
  }

  /**
   * Ends a RETRY request as FAILED by the cloud's own decision (a campaign out of
   * time, a re-issue the cloud would not sign): the device's refusal stays as it
   * reported it, `failure_detail` says what ended the intent. False when the request
   * was no longer an open RETRY (another replica got there first).
   */
  async concludeUnreissued(tenantId: string, requestId: string, detail: string): Promise<boolean> {
    const rows = await runInTenantTransaction(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      tenantId,
      (qr) =>
        returningRows<{ id: string }>(
          qr,
          `UPDATE edge_update_requests
              SET state = 'failed', failure_detail = $3, updated_at = now()
            WHERE id = $1 AND tenant_id = $2 AND state = 'retry' AND superseded_by IS NULL
        RETURNING id`,
          [requestId, tenantId, detail.slice(0, 256)],
        ),
    );
    return rows.length > 0;
  }

  /**
   * A rollout ended (cancelled by an operator or halted by its failures): the
   * requests of its devices that no root has been handed yet, and the retryable ones
   * waiting for a new statement, are concluded as FAILED, so nothing more is
   * delivered or re-issued. A statement the agent already handed to root cannot be
   * recalled; its result concludes it as usual. Returns how many were concluded.
   */
  async concludeForRollout(tenantId: string, rolloutId: string, detail: string): Promise<number> {
    const rows = await runInTenantTransaction(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      tenantId,
      (qr) =>
        returningRows<{ id: string }>(
          qr,
          `UPDATE edge_update_requests
              SET state = 'failed', failure_detail = $3, updated_at = now()
            WHERE tenant_id = $1 AND rollout_id = $2
              AND ((state = 'pending' AND handed_at IS NULL) OR state = 'retry')
        RETURNING id`,
          [tenantId, rolloutId, detail.slice(0, 256)],
        ),
    );
    return rows.length;
  }

  /**
   * An `edge-rollback` result: the device installed an update, its health window
   * failed, and root restored the previous release. The result names the release it
   * rolled back (`subject.version`), not a statement digest, so the request it
   * undoes is the device's latest DONE edge-update to that version that concluded
   * before this result (a republished older rollback never fails a newer, healthy
   * install of the same version). That request becomes FAILED: a rollout must not
   * count it as an installed update, and root takes no further update from its spool
   * until a statement with a larger update_seq arrives.
   */
  async recordRollback(event: ResultEvent): Promise<void> {
    const version = event.result.subject?.version;
    if (version === undefined) return;
    const detail = `rolled back by the device: ${event.result.reason ?? event.result.outcome}`;
    const rolled = await runInTenantTransaction(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      event.tenantId,
      (qr) =>
        returningRows<{ id: string }>(
          qr,
          `UPDATE edge_update_requests
              SET state = 'failed', failure_detail = $5, updated_at = now()
            WHERE id = (
              SELECT id FROM edge_update_requests
               WHERE tenant_id = $1 AND device_id = $2 AND statement_type = $3
                 AND state = 'done' AND recipe->>'version' = $4
                 AND settled_result_seq < $6
               ORDER BY settled_result_seq DESC
               LIMIT 1
               FOR UPDATE)
        RETURNING id`,
          [
            event.tenantId,
            event.deviceId,
            STATEMENT.edgeUpdate,
            version,
            detail.slice(0, 256),
            event.result.seq,
          ],
        ),
    );
    for (const row of rolled) {
      this.logger.warn({
        event: 'update_request_rolled_back',
        deviceId: event.deviceId,
        requestId: row.id,
        version,
        reason: event.result.reason ?? null,
      });
    }
  }

  /** A device's requests, newest first, for the console. */
  async listForDevice(
    tenantId: string,
    deviceId: string,
    limit = 50,
  ): Promise<EdgeUpdateRequestView[]> {
    const bounded = Math.min(Math.max(1, Math.trunc(limit)), 200);
    return runInTenantRead(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      tenantId,
      (qr): Promise<EdgeUpdateRequestView[]> =>
        qr.query(
          `SELECT id, rollout_id AS "rolloutId", intent_id AS "intentId",
                  statement_type AS "statementType", update_seq::float8 AS "updateSeq",
                  statement_digest AS "statementDigest", not_before AS "notBefore",
                  expires_at AS "expiresAt", state, delivered_at AS "deliveredAt",
                  handed_at AS "handedAt", handoff_refusal AS "handoffRefusal",
                  settled_result_seq::float8 AS "settledResultSeq",
                  settled_outcome AS "settledOutcome", settled_reason AS "settledReason",
                  settled_at AS "settledAt", superseded_by AS "supersededBy",
                  created_by AS "createdBy", created_at AS "createdAt"
             FROM edge_update_requests
            WHERE tenant_id = $1 AND device_id = $2
            ORDER BY created_at DESC, id DESC LIMIT $3`,
          [tenantId, deviceId, bounded],
        ),
    );
  }
}

/** The columns {@link EdgeUpdateRequestService.listForDevice} reads, the console's view of a request. */
export interface EdgeUpdateRequestView {
  readonly id: string;
  readonly rolloutId: string | null;
  readonly intentId: string;
  readonly statementType: string;
  readonly updateSeq: number | null;
  readonly statementDigest: string;
  readonly notBefore: Date;
  readonly expiresAt: Date | null;
  readonly state: EdgeUpdateRequestState;
  readonly deliveredAt: Date | null;
  readonly handedAt: Date | null;
  readonly handoffRefusal: string | null;
  readonly settledResultSeq: number | null;
  readonly settledOutcome: string | null;
  readonly settledReason: string | null;
  readonly settledAt: Date | null;
  readonly supersededBy: string | null;
  readonly createdBy: string | null;
  readonly createdAt: Date;
}

/** A RETRY request waiting for a new statement of its intent (what the reconciler reads). */
export interface ReissueCandidate {
  readonly id: string;
  readonly tenantId: string;
  readonly deviceId: string;
  readonly intentId: string;
  readonly rolloutId: string | null;
  readonly statementType: CarriedStatementType;
  /** The stored recipe as read; `parseRecipe` decides whether it is one the cloud wrote. */
  readonly recipe: unknown;
  readonly campaignStartedAt: Date;
  /** When the cloud received the refusal that ended the request. */
  readonly refusedAt: Date;
  readonly refusalReason: string | null;
  readonly createdBy: string | null;
}

/** The result kind a device reports when root restored the previous agent release. */
const EDGE_ROLLBACK_KIND = 'edge-rollback';

const STATEMENT_TYPES: readonly CarriedStatementType[] = [
  STATEMENT.edgeUpdate,
  STATEMENT.osUpdate,
  STATEMENT.siteConfig,
  STATEMENT.siteNetpolicy,
  STATEMENT.trustAnchors,
];

/** What each settlement verdict that a result can produce makes of the request. */
const STATE_OF_VERDICT: Readonly<Record<string, EdgeUpdateRequestState | undefined>> = {
  done: EdgeUpdateRequestState.DONE,
  reissue: EdgeUpdateRequestState.RETRY,
  reschedule: EdgeUpdateRequestState.RESCHEDULE,
  final: EdgeUpdateRequestState.FAILED,
};
