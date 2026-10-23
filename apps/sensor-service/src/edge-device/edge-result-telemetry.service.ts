import { createHash } from 'crypto';

import {
  runInTenantRead,
  runInTenantTransaction,
  SENSOR_SOURCE_SCHEMA,
} from '@aquaculture/backend-common/database';
import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { DeviceDirectoryService } from './device-directory.service';
import {
  type EdgeResult,
  parseResultDocument,
  RESULT_KINDS,
  ResultDocumentError,
} from './edge-result-document';
import { EdgeDeviceResult } from './entities/edge-device-result.entity';
import { EdgeAgentChannel } from './entities/edge-device.entity';

/**
 * The cloud end of result telemetry (ADR-048 DEC-27; contract channels.json
 * `result_telemetry`): the `suderra.result.v1` documents root writes and the
 * agent republishes on `tenants/{tenant}/devices/{device}/results`, stored per
 * device as device-reported evidence — the fleet view of the installed
 * version, verification, rollbacks and lockdown state.
 *
 * Trust. Results are unsigned observations. The topic's tenant is proven by
 * the broker ACL (a device publishes only inside its own namespace, and only a
 * device writes a results topic, mqtt-auth.service.ts) and re-checked against
 * the device row here; the document is then validated against the contract's
 * result schema, so a malformed publication is refused whole, never stored in
 * part. Nothing stored here decides anything about a device except which
 * update request a result concludes (the update-request service reads the
 * stored result, `edge-update-channel.ts`).
 *
 * Idempotence. The contract deduplicates on (device_id, seq) — `seq` monotonic
 * per device, assigned by root — so the agent's republication after a
 * reconnect, and a QoS 1 redelivery, store nothing. A document reusing a stored
 * seq with other content is not stored either (first writer wins, as the
 * contract says) but is reported as a conflict, because it means the device's
 * sequence restarted (a replaced `/data`) or a result of a non-persistent kind
 * collided with a persistent one: evidence that would otherwise be dropped
 * silently.
 */

/** Newest results kept per device; older ones are removed as new ones arrive. */
export const RESULT_RETENTION_PER_DEVICE = 2000;

/** Most rows one list request returns. */
export const RESULT_LIST_MAX = 200;

/** A stored result, offered to the services that act on one (the update requests it concludes). */
export interface ResultEvent {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly result: EdgeResult;
  /** When the cloud first stored the result: a request created after it cannot be what it concludes. */
  readonly receivedAt: Date;
}

/**
 * Called for every result of a device the store holds, stored now or already
 * stored: a republication after a failed settlement must settle, and settling
 * is idempotent. A failure rejects the message, so the MQTT ack gate holds
 * PUBACK and the device's agent republishes it.
 */
export type ResultObserver = (event: ResultEvent) => Promise<void>;

/** What storing one message did: stored now, already stored as is, or clashing with a stored one. */
type StoreOutcome =
  | { readonly status: 'stored' | 'duplicate'; readonly receivedAt: Date }
  | { readonly status: 'conflict' };

/** Who published: the topic's tenant level and device level. */
export interface ResultSource {
  readonly tenantId: string;
  /** The topic's device level: the device UUID (the contract's form) or the device code. */
  readonly deviceIdentifier: string;
}

export type ResultIngestOutcome =
  | {
      readonly status: 'stored';
      readonly tenantId: string;
      readonly deviceId: string;
      readonly result: EdgeResult;
    }
  | { readonly status: 'duplicate'; readonly deviceId: string; readonly seq: number }
  | { readonly status: 'conflict'; readonly deviceId: string; readonly seq: number }
  | { readonly status: 'refused'; readonly reason: ResultRefusal };

/** Why a publication on a results topic stored nothing. */
export type ResultRefusal = 'unknown-device' | 'tenant-mismatch' | 'not-suderra-os' | 'invalid';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ResultRow {
  readonly id: string;
  readonly device_id: string;
  readonly seq: string | number;
  readonly kind: string;
  readonly outcome: string;
  readonly reason: string | null;
  readonly occurred_at: Date;
  readonly time_state: string;
  readonly board_profile: string;
  readonly os_version: string;
  readonly subject: Record<string, unknown> | null;
  readonly detail: string | null;
  readonly document: Record<string, unknown>;
  readonly received_at: Date;
}

function toResult(tenantId: string, row: ResultRow): EdgeDeviceResult {
  return Object.assign(new EdgeDeviceResult(), {
    id: row.id,
    tenantId,
    deviceId: row.device_id,
    seq: Number(row.seq),
    kind: row.kind,
    outcome: row.outcome,
    reason: row.reason,
    occurredAt: row.occurred_at,
    timeState: row.time_state,
    boardProfile: row.board_profile,
    osVersion: row.os_version,
    subject: row.subject,
    detail: row.detail,
    document: row.document,
    receivedAt: row.received_at,
  });
}

const RESULT_COLUMNS = `id, device_id, seq, kind, outcome, reason, occurred_at, time_state,
  board_profile, os_version, subject, detail, document, received_at`;

@Injectable()
export class EdgeResultTelemetryService {
  private readonly logger = new Logger(EdgeResultTelemetryService.name);

  private readonly observers: ResultObserver[] = [];

  constructor(
    private readonly dataSource: DataSource,
    private readonly devices: DeviceDirectoryService,
  ) {}

  /** Registers a service that acts on stored results (once, at module init). */
  addObserver(observer: ResultObserver): void {
    this.observers.push(observer);
  }

  private async notify(event: ResultEvent): Promise<void> {
    for (const observer of this.observers) await observer(event);
  }

  /**
   * One message of a results topic. Never throws for the publisher's faults:
   * a refused message is counted in the outcome and logged without its
   * content (a hostile device chooses what it sends).
   */
  async ingest(source: ResultSource, payload: Buffer): Promise<ResultIngestOutcome> {
    let result: EdgeResult;
    try {
      result = parseResultDocument(payload);
    } catch (error) {
      if (!(error instanceof ResultDocumentError)) throw error;
      this.logger.warn({
        event: 'edge_result_refused',
        reason: 'invalid',
        tenantId: source.tenantId,
        errors: error.reasons.slice(0, 5),
      });
      return { status: 'refused', reason: 'invalid' };
    }

    const device = await this.devices.findDevice(
      UUID.test(source.deviceIdentifier) ? 'id' : 'device_code',
      source.deviceIdentifier,
    );
    if (device === null) return this.refused('unknown-device', source);
    if (device.tenantId !== source.tenantId) return this.refused('tenant-mismatch', source);
    if (device.agentChannel !== EdgeAgentChannel.SUDERRA_OS) {
      return this.refused('not-suderra-os', source);
    }

    const sha256 = createHash('sha256').update(payload).digest('hex');
    const stored = await runInTenantTransaction(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      device.tenantId,
      async (qr): Promise<StoreOutcome> => {
        const inserted: Array<{ id: string; received_at: Date }> = await qr.query(
          `INSERT INTO edge_device_results
             (tenant_id, device_id, seq, kind, outcome, reason, occurred_at, time_state,
              board_profile, os_version, subject, detail, document, document_sha256)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13::jsonb, $14)
           ON CONFLICT (device_id, seq) DO NOTHING
           RETURNING id, received_at`,
          [
            device.tenantId,
            device.id,
            result.seq,
            result.kind,
            result.outcome,
            result.reason ?? null,
            result.occurred_at,
            result.time_state,
            result.board_profile,
            result.os_version,
            result.subject === undefined ? null : JSON.stringify(result.subject),
            result.detail ?? null,
            JSON.stringify(result),
            sha256,
          ],
        );
        if (inserted.length === 0) {
          const existing: Array<{ document_sha256: string; received_at: Date }> = await qr.query(
            `SELECT document_sha256, received_at FROM edge_device_results WHERE device_id = $1 AND seq = $2`,
            [device.id, result.seq],
          );
          const first = existing[0];
          return first?.document_sha256 === sha256
            ? { status: 'duplicate', receivedAt: first.received_at }
            : { status: 'conflict' };
        }
        await qr.query(
          `DELETE FROM edge_device_results
            WHERE device_id = $1
              AND id IN (SELECT id FROM edge_device_results WHERE device_id = $1
                          ORDER BY received_at DESC, seq DESC OFFSET $2)`,
          [device.id, RESULT_RETENTION_PER_DEVICE],
        );
        const row = inserted[0];
        if (row === undefined) throw new Error('the stored result did not return its row');
        return { status: 'stored', receivedAt: row.received_at };
      },
    );

    if (stored.status === 'conflict') {
      this.logger.warn({
        event: 'edge_result_seq_conflict',
        deviceId: device.id,
        seq: result.seq,
        kind: result.kind,
      });
      return { status: 'conflict', deviceId: device.id, seq: result.seq };
    }
    if (stored.status === 'duplicate') {
      await this.notify({
        tenantId: device.tenantId,
        deviceId: device.id,
        result,
        receivedAt: stored.receivedAt,
      });
      return { status: 'duplicate', deviceId: device.id, seq: result.seq };
    }
    this.logger.log({
      event: 'edge_result_stored',
      deviceId: device.id,
      seq: result.seq,
      kind: result.kind,
      outcome: result.outcome,
      reason: result.reason ?? null,
    });
    await this.notify({
      tenantId: device.tenantId,
      deviceId: device.id,
      result,
      receivedAt: stored.receivedAt,
    });
    return { status: 'stored', tenantId: device.tenantId, deviceId: device.id, result };
  }

  private refused(reason: ResultRefusal, source: ResultSource): ResultIngestOutcome {
    this.logger.warn({
      event: 'edge_result_refused',
      reason,
      tenantId: source.tenantId,
      device: source.deviceIdentifier.slice(0, 64),
    });
    return { status: 'refused', reason };
  }

  /** A device's stored results, newest first, optionally of one kind. */
  async list(
    tenantId: string,
    deviceId: string,
    options: { readonly kind?: string; readonly limit?: number } = {},
  ): Promise<EdgeDeviceResult[]> {
    const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 50)), RESULT_LIST_MAX);
    if (options.kind !== undefined && !RESULT_KINDS.includes(options.kind)) return [];
    const rows = await runInTenantRead(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      tenantId,
      (qr): Promise<ResultRow[]> =>
        qr.query(
          `SELECT ${RESULT_COLUMNS} FROM edge_device_results
            WHERE tenant_id = $1 AND device_id = $2 AND ($3::text IS NULL OR kind = $3)
            ORDER BY seq DESC LIMIT $4`,
          [tenantId, deviceId, options.kind ?? null, limit],
        ),
    );
    return rows.map((row) => toResult(tenantId, row));
  }

  /** The newest stored result of every kind a device reported: the fleet view's last known state. */
  async latestByKind(tenantId: string, deviceId: string): Promise<EdgeDeviceResult[]> {
    const rows = await runInTenantRead(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      tenantId,
      (qr): Promise<ResultRow[]> =>
        qr.query(
          `SELECT DISTINCT ON (kind) ${RESULT_COLUMNS} FROM edge_device_results
            WHERE tenant_id = $1 AND device_id = $2
            ORDER BY kind, seq DESC`,
          [tenantId, deviceId],
        ),
    );
    return rows.map((row) => toResult(tenantId, row));
  }

  /**
   * The OS version the device last reported: every result carries the
   * `os_version` of the image that wrote it, so the newest row is what is known
   * of the running OS. Null for a device that never reported one.
   */
  async latestOsVersion(tenantId: string, deviceId: string): Promise<string | null> {
    const rows = await runInTenantRead(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      tenantId,
      (qr): Promise<Array<{ os_version: string }>> =>
        qr.query(
          `SELECT os_version FROM edge_device_results
            WHERE tenant_id = $1 AND device_id = $2 ORDER BY seq DESC LIMIT 1`,
          [tenantId, deviceId],
        ),
    );
    return rows[0]?.os_version ?? null;
  }

  /** How many results a device has stored (retention bounds it). */
  async count(tenantId: string, deviceId: string): Promise<number> {
    const rows = await runInTenantRead(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      tenantId,
      (qr): Promise<Array<{ n: string }>> =>
        qr.query(
          `SELECT count(*)::text AS n FROM edge_device_results WHERE tenant_id = $1 AND device_id = $2`,
          [tenantId, deviceId],
        ),
    );
    return Number(rows[0]?.n ?? 0);
  }
}
