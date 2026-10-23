import { createHash, randomUUID } from 'crypto';

import { runInTenantTransaction, SENSOR_SOURCE_SCHEMA } from '@aquaculture/backend-common/database';
import { Injectable, Logger } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

import {
  ACTIVATION_RECEIPT_RESIGN_MARGIN_MS,
  ActivationReceiptService,
} from './activation-receipt.service';
import {
  type BindingMethod,
  type DeviceBinding,
  type DsseEnvelope,
  type Sha256Digest,
  type SignedStatement,
  STATEMENT,
  statementDigest,
  wholeSecond,
} from './edge-contract';
import { DeviceLifecycleState, EdgeAgentChannel, EdgeDevice } from './entities/edge-device.entity';

/**
 * The two-phase provisioning token's transitions (ADR-048 DEC-5.7, DEC-5.8,
 * DEC-5.14).
 *
 *   TOKEN_ISSUED ──reserve──▶ MANIFEST_RESERVED ──activate──▶ ACTIVATION_PENDING ──commit──▶ COMMITTED
 *        │                    (Suderra OS; bound to the      (credentials issued;           (first CONNECT with
 *        └──────activate (generic Linux)──────────────▶ re-issuable)                    the device's own credential)
 *
 * Every transition is ONE conditional `UPDATE … RETURNING` inside the
 * device's tenant boundary: the condition is the transition's guard, so two
 * racing requests cannot both pass it (the second matches no row). There is
 * no check-then-act. The single-use token is spent only at the commit — when
 * the device has proved it saved and uses the credential — never at
 * activation, so a device that lost its response can activate again.
 *
 * The token columns describe the CURRENT token. The committed activation
 * (`activation_id`, `activated_at`, the committed binding and the live broker
 * credential) is a separate record: re-provisioning a Suderra OS device
 * issues a new token under a signed device-lifecycle statement and keeps that
 * record until the new commit replaces it, so the cloud never treats a live
 * device as never-activated.
 *
 * The broker credential follows the same rule (SENSOR-MEDIUM-236). The column
 * `mqtt_password_hash` holds the credential of the latest activation; when an
 * activation is issued over a committed one, the committed credential moves to
 * `previous_mqtt_password_hash` in the same statement and keeps authenticating
 * until the new credential commits, which retires it in the statement that
 * spends the token. A reinstall that fails, is rolled back or never reaches
 * the broker therefore leaves the running agent able to connect. The commit
 * names the credential that was proven (`mqtt_password_hash = :proven`), so a
 * later activation cannot be committed by a CONNECT that used an earlier one.
 *
 * The statements a Suderra OS agent hands to root (the receipt, the lifecycle
 * statement) are stored on the row and delivered by claim: one conditional
 * UPDATE stamps the delivery instant, so replicas share one pace and any of
 * them settles the hand-over by the statement digest the agent reports.
 */

const TERMINAL_STATES = [DeviceLifecycleState.REVOKED, DeviceLifecycleState.DECOMMISSIONED];

/** The least time between two deliveries of the same pending statement. */
export const HANDOFF_REDELIVERY_INTERVAL_MS = 2 * 60 * 1000;

/**
 * The oldest token a Suderra OS manifest is issued under (ADR-048 DEC-5.12:
 * the manifest-issuing token's life drops from a day to hours). Binding is
 * first-come — whoever presents the token first binds the manifest — so the
 * window in which a leaked token can bind someone else's hardware is short.
 * The generic channel keeps PROVISIONING_TOKEN_TTL_HOURS; a token issued for
 * a Suderra OS re-provisioning already expires with its 2 h window.
 */
export const SUDERRA_OS_TOKEN_MAX_AGE_MS = 4 * 60 * 60 * 1000;

export function hashProvisioningToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface Reservation {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly deviceCode: string;
  readonly binding: DeviceBinding;
  readonly manifestSeq: number;
  readonly siteConfigSeq: number;
  readonly window: { readonly notBefore: Date; readonly expiresAt: Date };
}

export interface CredentialIssue {
  readonly fingerprint: EdgeDevice['fingerprint'];
  readonly agentVersion: string;
  readonly mqttPasswordHash: string;
}

export interface Commit {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly channel: EdgeAgentChannel;
  /** Set for a Suderra OS device: the receipt root will verify (DEC-5.8). */
  readonly activationReceipt: string | null;
}

/** The statement a re-provisioning window opens with, signed under its allocated sequence. */
export type LifecycleStatementSigner = (
  updateSeq: number,
) => SignedStatement<typeof STATEMENT.deviceLifecycle>;

export type ReprovisioningRefusal =
  | 'not-committed'
  | 'receipt-not-handed'
  | 'window-open'
  | 'terminal';

export interface ReprovisioningStart {
  readonly lifecycleSeq: number;
  readonly windowEndsAt: Date;
}

/** Which root hand-over a settled response answered. */
export type HandoffKind = 'activation_receipt' | 'lifecycle_request';

/** How far before the issuing instant a statement's window opens. */
const WINDOW_LEAD_MS = 5 * 60 * 1000;

interface ReservedRow {
  readonly edge_statement_seq: string | number;
  readonly device_code: string;
}

interface CommittedRow {
  readonly tenant_id: string;
  readonly id: string;
  readonly agent_channel: EdgeAgentChannel;
  readonly device_binding_method: BindingMethod | null;
  readonly device_binding_sha256: string | null;
  readonly issued_manifest_sha256: string | null;
}

interface ClaimedReceiptRow {
  readonly tenant_id: string;
  readonly id: string;
  readonly activation_receipt: string;
  readonly activation_receipt_expires_at: Date;
  readonly activation_id: string | null;
  readonly activated_at: Date | null;
  readonly device_binding_method: BindingMethod | null;
  readonly device_binding_sha256: string | null;
  readonly issued_manifest_sha256: string | null;
}

interface SeqRow {
  readonly edge_statement_seq: string | number;
}

/** The statement digest of a stored DSSE envelope (statements.json statement_digest). */
export function storedStatementDigest(envelopeJson: string): Sha256Digest {
  const envelope = JSON.parse(envelopeJson) as DsseEnvelope;
  return statementDigest(Buffer.from(envelope.payload, 'base64'));
}

@Injectable()
export class ProvisioningReservationService {
  private readonly logger = new Logger(ProvisioningReservationService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly receipts: ActivationReceiptService,
  ) {}

  /**
   * TOKEN_ISSUED → MANIFEST_RESERVED for `binding` (or a re-fetch by the same
   * binding while the reservation holds). Allocates the manifest's and the
   * site config's update_seq in the same statement. `issue` runs inside the
   * same transaction and returns the manifest digest to record; a refusal
   * from it rolls the reservation back. Returns null when the guard matches
   * no row — the token is wrong, spent or expired, the device is terminal, or
   * the binding differs from the device's committed identity or from a live
   * reservation.
   */
  async reserve<T>(
    device: Pick<EdgeDevice, 'id' | 'tenantId'>,
    token: string,
    binding: DeviceBinding,
    ttlMs: number,
    now: Date,
    issue: (reservation: Reservation) => {
      readonly result: T;
      readonly manifestDigest: Sha256Digest;
    },
  ): Promise<T | null> {
    const issuedAt = wholeSecond(now);
    const expiresAt = new Date(issuedAt.getTime() + ttlMs);
    return runInTenantTransaction(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      device.tenantId,
      async (qr) => {
        const params = {
          id: device.id,
          tenantId: device.tenantId,
          tokenHash: hashProvisioningToken(token),
          method: binding.method,
          digest: binding.digest.sha256,
          now: issuedAt,
          oldestToken: new Date(issuedAt.getTime() - SUDERRA_OS_TOKEN_MAX_AGE_MS),
          expiresAt,
          terminal: TERMINAL_STATES,
        };
        const updated = await qr.manager
          .createQueryBuilder()
          .update(EdgeDevice)
          .set({
            reservedBindingMethod: binding.method,
            reservedBindingSha256: binding.digest.sha256,
            reservationExpiresAt: expiresAt,
            agentChannel: EdgeAgentChannel.SUDERRA_OS,
            edgeStatementSeq: () => 'edge_statement_seq + 2',
          })
          .where('id = :id AND tenant_id = :tenantId', params)
          .andWhere('provisioning_token = :tokenHash AND token_used_at IS NULL')
          .andWhere('token_expires_at > :now AND lifecycle_state NOT IN (:...terminal)')
          // DEC-5.12: only a young token issues a manifest; a token whose
          // issue instant was never recorded issues none.
          .andWhere('token_issued_at > :oldestToken')
          // The device's committed hardware identity, once it has one, is final.
          .andWhere(
            '(device_binding_sha256 IS NULL OR (device_binding_method = :method AND device_binding_sha256 = :digest))',
          )
          // A live reservation — or issued credentials — belong to their binding alone.
          .andWhere(
            '(reserved_binding_sha256 IS NULL' +
              ' OR (reserved_binding_method = :method AND reserved_binding_sha256 = :digest)' +
              ' OR (reservation_expires_at <= :now AND credentials_issued_at IS NULL))',
          )
          // returning() names entity properties; rows come back keyed by column name.
          .returning(['edgeStatementSeq', 'deviceCode'])
          .execute();
        const row = (updated.raw as ReservedRow[])[0];
        if (row === undefined) return null;
        const siteConfigSeq = Number(row.edge_statement_seq);
        const { result, manifestDigest } = issue({
          tenantId: device.tenantId,
          deviceId: device.id,
          deviceCode: row.device_code,
          binding,
          manifestSeq: siteConfigSeq - 1,
          siteConfigSeq,
          window: { notBefore: new Date(issuedAt.getTime() - WINDOW_LEAD_MS), expiresAt },
        });
        await this.recordIssuedManifest(qr.manager, params.id, params.tenantId, manifestDigest);
        return result;
      },
    );
  }

  private async recordIssuedManifest(
    manager: EntityManager,
    id: string,
    tenantId: string,
    digest: Sha256Digest,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(EdgeDevice)
      .set({ issuedManifestSha256: digest.sha256 })
      .where('id = :id AND tenant_id = :tenantId', { id, tenantId })
      .execute();
  }

  /**
   * → ACTIVATION_PENDING: issue (or re-issue) the broker credential. A
   * generic-Linux device activates straight from TOKEN_ISSUED; a Suderra OS
   * device only under its reservation (live, or already holding credentials).
   * The token stays valid until the commit. A committed credential the row
   * holds is kept as the previous one, not replaced (SENSOR-MEDIUM-236); a
   * repeated activation replaces only the pending credential. Returns false
   * when the guard matches no row.
   */
  async issueCredentials(
    device: Pick<EdgeDevice, 'id' | 'tenantId'>,
    token: string,
    credentials: CredentialIssue,
    now: Date,
  ): Promise<boolean> {
    return runInTenantTransaction(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      device.tenantId,
      async (qr) => {
        const updated = await qr.manager
          .createQueryBuilder()
          .update(EdgeDevice)
          .set({
            // No credential issued yet under this token: whatever hash the row
            // holds is the committed one, and it stays valid beside the new one
            // until the new one commits. Credentials already issued: the previous
            // slot is untouched, so a repeated activation never moves the
            // uncommitted credential into it.
            previousMqttPasswordHash: () =>
              'CASE WHEN credentials_issued_at IS NULL THEN mqtt_password_hash ELSE previous_mqtt_password_hash END',
            mqttPasswordHash: credentials.mqttPasswordHash,
            credentialsIssuedAt: now,
            fingerprint: credentials.fingerprint,
            agentVersion: credentials.agentVersion,
            lifecycleState: DeviceLifecycleState.ACTIVE,
            isOnline: false,
          })
          .where('id = :id AND tenant_id = :tenantId', {
            id: device.id,
            tenantId: device.tenantId,
            tokenHash: hashProvisioningToken(token),
            now,
            terminal: TERMINAL_STATES,
            generic: EdgeAgentChannel.GENERIC_LINUX,
          })
          .andWhere('provisioning_token = :tokenHash AND token_used_at IS NULL')
          .andWhere('token_expires_at > :now AND lifecycle_state NOT IN (:...terminal)')
          .andWhere(
            '(agent_channel = :generic OR (reserved_binding_sha256 IS NOT NULL AND issued_manifest_sha256 IS NOT NULL' +
              ' AND (credentials_issued_at IS NOT NULL OR reservation_expires_at > :now)))',
          )
          .returning(['id'])
          .execute();
        return (updated.raw as unknown[]).length === 1;
      },
    );
  }

  /**
   * ACTIVATION_PENDING → COMMITTED, on the first CONNECT that authenticated
   * with the device's own credential (DEC-5.7). Spends the token, makes the
   * reserved binding the device's identity, records the committed activation,
   * retires the previous credential and closes any re-provisioning window; for
   * a Suderra OS device it signs the activation receipt naming the manifest
   * root installed. Returns null when there was nothing to commit (already
   * committed, never pending) or when the credential issued since is not the
   * one `provenHash` is (an activation replaced it between the CONNECT's
   * verification and this statement: the device holds a credential that no
   * longer exists, so nothing may be spent on its behalf).
   */
  async commitFirstSession(
    device: Pick<EdgeDevice, 'id' | 'tenantId'>,
    now: Date,
    provenHash: string,
  ): Promise<Commit | null> {
    const activatedAt = wholeSecond(now);
    const activationId = randomUUID();
    return runInTenantTransaction(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      device.tenantId,
      async (qr) => {
        const updated = await qr.manager
          .createQueryBuilder()
          .update(EdgeDevice)
          .set({
            tokenUsedAt: activatedAt,
            provisioningToken: null,
            activationId,
            activatedAt,
            deviceBindingMethod: () => 'COALESCE(reserved_binding_method, device_binding_method)',
            deviceBindingSha256: () => 'COALESCE(reserved_binding_sha256, device_binding_sha256)',
            reservedBindingMethod: null,
            reservedBindingSha256: null,
            reservationExpiresAt: null,
            activationReceipt: null,
            activationReceiptExpiresAt: null,
            activationReceiptSentAt: null,
            activationReceiptHandedAt: null,
            lifecycleRequest: null,
            lifecycleRequestSentAt: null,
            lifecycleRequestHandedAt: null,
            maintenanceExpiresAt: null,
            previousMqttPasswordHash: null,
          })
          .where('id = :id AND tenant_id = :tenantId', {
            id: device.id,
            tenantId: device.tenantId,
            proven: provenHash,
          })
          .andWhere('token_used_at IS NULL AND provisioning_token IS NOT NULL')
          .andWhere('credentials_issued_at IS NOT NULL')
          .andWhere('mqtt_password_hash = :proven')
          .returning([
            'tenantId',
            'id',
            'agentChannel',
            'deviceBindingMethod',
            'deviceBindingSha256',
            'issuedManifestSha256',
          ])
          .execute();
        const row = (updated.raw as CommittedRow[])[0];
        if (row === undefined) return null;
        if (row.agent_channel !== EdgeAgentChannel.SUDERRA_OS) {
          return {
            tenantId: row.tenant_id,
            deviceId: row.id,
            channel: row.agent_channel,
            activationReceipt: null,
          };
        }
        if (row.device_binding_method === null || row.device_binding_sha256 === null) {
          // The activation guard admits a Suderra OS device only under a
          // reservation, so this row cannot exist; refusing (and rolling back)
          // keeps the token unspent if it ever does.
          throw new Error(`Suderra OS device ${row.id} committed without a reserved binding`);
        }
        if (row.issued_manifest_sha256 === null) {
          throw new Error(`Suderra OS device ${row.id} committed without an issued manifest`);
        }
        const receipt = this.receipts.issue(
          {
            tenantId: row.tenant_id,
            deviceId: row.id,
            binding: {
              method: row.device_binding_method,
              digest: { sha256: row.device_binding_sha256 },
            },
            manifestDigest: { sha256: row.issued_manifest_sha256 },
            activationId,
            activatedAt,
          },
          activatedAt,
        );
        await qr.manager
          .createQueryBuilder()
          .update(EdgeDevice)
          .set({
            activationReceipt: receipt.envelope,
            activationReceiptExpiresAt: receipt.expiresAt,
          })
          .where('id = :id AND tenant_id = :tenantId', { id: row.id, tenantId: row.tenant_id })
          .execute();
        this.logger.log({
          event: 'edge_activation_committed',
          deviceId: row.id,
          channel: row.agent_channel,
        });
        return {
          tenantId: row.tenant_id,
          deviceId: row.id,
          channel: row.agent_channel,
          activationReceipt: receipt.envelope,
        };
      },
    );
  }

  /**
   * Claims one delivery of the pending activation receipt: stamps the
   * delivery instant when the receipt is unhanded and no delivery was
   * claimed within HANDOFF_REDELIVERY_INTERVAL_MS, and returns the envelope
   * to deliver — re-signed first, under the same activation, when less than
   * ACTIVATION_RECEIPT_RESIGN_MARGIN_MS of its window is left. Null when
   * there is nothing to deliver now.
   */
  async claimReceiptDelivery(
    device: Pick<EdgeDevice, 'id' | 'tenantId'>,
    now: Date,
  ): Promise<string | null> {
    const at = wholeSecond(now);
    return runInTenantTransaction(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      device.tenantId,
      async (qr) => {
        const claimed = await qr.manager
          .createQueryBuilder()
          .update(EdgeDevice)
          .set({ activationReceiptSentAt: at })
          .where('id = :id AND tenant_id = :tenantId', {
            id: device.id,
            tenantId: device.tenantId,
            channel: EdgeAgentChannel.SUDERRA_OS,
            paced: new Date(at.getTime() - HANDOFF_REDELIVERY_INTERVAL_MS),
          })
          .andWhere('agent_channel = :channel')
          .andWhere('activation_receipt IS NOT NULL AND activation_receipt_handed_at IS NULL')
          .andWhere('(activation_receipt_sent_at IS NULL OR activation_receipt_sent_at <= :paced)')
          .returning([
            'tenantId',
            'id',
            'activationReceipt',
            'activationReceiptExpiresAt',
            'activationId',
            'activatedAt',
            'deviceBindingMethod',
            'deviceBindingSha256',
            'issuedManifestSha256',
          ])
          .execute();
        const row = (claimed.raw as ClaimedReceiptRow[])[0];
        if (row === undefined) return null;
        const remaining = new Date(row.activation_receipt_expires_at).getTime() - at.getTime();
        if (remaining >= ACTIVATION_RECEIPT_RESIGN_MARGIN_MS) return row.activation_receipt;
        if (
          row.activation_id === null ||
          row.activated_at === null ||
          row.device_binding_method === null ||
          row.device_binding_sha256 === null ||
          row.issued_manifest_sha256 === null
        ) {
          // A stored receipt is written only by the commit, together with
          // every one of these; rolling back keeps the claim unspent.
          throw new Error(`Device ${row.id} holds a receipt without its committed activation`);
        }
        const receipt = this.receipts.issue(
          {
            tenantId: row.tenant_id,
            deviceId: row.id,
            binding: {
              method: row.device_binding_method,
              digest: { sha256: row.device_binding_sha256 },
            },
            manifestDigest: { sha256: row.issued_manifest_sha256 },
            activationId: row.activation_id,
            activatedAt: new Date(row.activated_at),
          },
          at,
        );
        await qr.manager
          .createQueryBuilder()
          .update(EdgeDevice)
          .set({
            activationReceipt: receipt.envelope,
            activationReceiptExpiresAt: receipt.expiresAt,
          })
          .where('id = :id AND tenant_id = :tenantId', { id: row.id, tenantId: row.tenant_id })
          .execute();
        this.logger.log({ event: 'activation_receipt_resigned', deviceId: row.id });
        return receipt.envelope;
      },
    );
  }

  /**
   * Claims one delivery of the pending device-lifecycle statement while its
   * re-provisioning window is open; same pacing as the receipt. The
   * statement is never re-signed: its update_seq is single-use on root
   * (equal_seq reject), and a window that ends undelivered lapses.
   */
  async claimLifecycleDelivery(
    device: Pick<EdgeDevice, 'id' | 'tenantId'>,
    now: Date,
  ): Promise<string | null> {
    return runInTenantTransaction(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      device.tenantId,
      async (qr) => {
        const claimed = await qr.manager
          .createQueryBuilder()
          .update(EdgeDevice)
          .set({ lifecycleRequestSentAt: now })
          .where('id = :id AND tenant_id = :tenantId', {
            id: device.id,
            tenantId: device.tenantId,
            now,
            paced: new Date(now.getTime() - HANDOFF_REDELIVERY_INTERVAL_MS),
          })
          .andWhere('lifecycle_request IS NOT NULL AND lifecycle_request_handed_at IS NULL')
          .andWhere('maintenance_expires_at > :now')
          .andWhere('(lifecycle_request_sent_at IS NULL OR lifecycle_request_sent_at <= :paced)')
          .returning(['lifecycleRequest'])
          .execute();
        const row = (claimed.raw as Array<{ lifecycle_request: string }>)[0];
        return row === undefined ? null : row.lifecycle_request;
      },
    );
  }

  /**
   * Records that the agent handed the statement whose digest it reported to
   * root. Only the statement stored on this device's row now is settled —
   * a digest of an older (re-signed) receipt or of another device's
   * statement matches nothing. Returns which hand-over it settled.
   */
  async settleHandoff(
    device: Pick<EdgeDevice, 'id' | 'tenantId'>,
    reported: Sha256Digest,
    now: Date,
  ): Promise<HandoffKind | null> {
    return runInTenantTransaction(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      device.tenantId,
      async (qr) => {
        const stored = await qr.manager
          .createQueryBuilder(EdgeDevice, 'd')
          .select(['d.id', 'd.activationReceipt', 'd.lifecycleRequest'])
          .where('d.id = :id AND d.tenantId = :tenantId', {
            id: device.id,
            tenantId: device.tenantId,
          })
          .setLock('pessimistic_write')
          .getOne();
        if (stored === null) return null;
        const where = { id: device.id, tenantId: device.tenantId };
        if (
          stored.activationReceipt !== null &&
          storedStatementDigest(stored.activationReceipt).sha256 === reported.sha256
        ) {
          const settled = await qr.manager
            .createQueryBuilder()
            .update(EdgeDevice)
            .set({ activationReceiptHandedAt: now })
            .where('id = :id AND tenant_id = :tenantId', where)
            .andWhere('activation_receipt_handed_at IS NULL')
            .returning(['id'])
            .execute();
          return (settled.raw as unknown[]).length === 1 ? 'activation_receipt' : null;
        }
        if (
          stored.lifecycleRequest !== null &&
          storedStatementDigest(stored.lifecycleRequest).sha256 === reported.sha256
        ) {
          const settled = await qr.manager
            .createQueryBuilder()
            .update(EdgeDevice)
            .set({ lifecycleRequestHandedAt: now })
            .where('id = :id AND tenant_id = :tenantId', where)
            .andWhere('lifecycle_request_handed_at IS NULL')
            .returning(['id'])
            .execute();
          return (settled.raw as unknown[]).length === 1 ? 'lifecycle_request' : null;
        }
        return null;
      },
    );
  }

  /**
   * Opens a Suderra OS re-provisioning window (DEC-5.14): allocates the
   * lifecycle statement's update_seq, signs it, and in the same transaction
   * stores it with a fresh token that expires with the window. The committed
   * activation, binding and broker credential stay: the running agent must
   * stay online to carry the statement to root, and the device keeps its
   * identity if the window lapses unused. Refused unless the device
   * committed a binding whose receipt root has been handed (root is ACTIVE;
   * lifecycle.json admits enter-maintenance only from ACTIVE), and while a
   * window is still open.
   */
  async beginReprovisioning(
    device: Pick<EdgeDevice, 'id' | 'tenantId'>,
    binding: DeviceBinding,
    tokenHash: string,
    window: { readonly notBefore: Date; readonly expiresAt: Date },
    now: Date,
    sign: LifecycleStatementSigner,
  ): Promise<ReprovisioningStart | ReprovisioningRefusal> {
    return runInTenantTransaction(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      device.tenantId,
      async (qr) => {
        const where = {
          id: device.id,
          tenantId: device.tenantId,
          channel: EdgeAgentChannel.SUDERRA_OS,
          method: binding.method,
          digest: binding.digest.sha256,
          terminal: TERMINAL_STATES,
          now,
        };
        const allocated = await qr.manager
          .createQueryBuilder()
          .update(EdgeDevice)
          .set({ edgeStatementSeq: () => 'edge_statement_seq + 1' })
          .where('id = :id AND tenant_id = :tenantId', where)
          .andWhere('agent_channel = :channel AND lifecycle_state NOT IN (:...terminal)')
          .andWhere('device_binding_method = :method AND device_binding_sha256 = :digest')
          .andWhere('activation_receipt_handed_at IS NOT NULL')
          .andWhere('(maintenance_expires_at IS NULL OR maintenance_expires_at <= :now)')
          .returning(['edgeStatementSeq'])
          .execute();
        const row = (allocated.raw as SeqRow[])[0];
        if (row === undefined) return this.reprovisioningRefusal(qr.manager, device, binding, now);
        const lifecycleSeq = Number(row.edge_statement_seq);
        const statement = sign(lifecycleSeq);
        await qr.manager
          .createQueryBuilder()
          .update(EdgeDevice)
          .set({
            provisioningToken: tokenHash,
            tokenIssuedAt: now,
            tokenExpiresAt: window.expiresAt,
            tokenUsedAt: null,
            credentialsIssuedAt: null,
            // A credential issued under an earlier window that never committed
            // belonged to that window's token: it is dropped and the committed
            // one, kept beside it, is the device's credential again.
            mqttPasswordHash: () => 'COALESCE(previous_mqtt_password_hash, mqtt_password_hash)',
            previousMqttPasswordHash: null,
            reservedBindingMethod: null,
            reservedBindingSha256: null,
            reservationExpiresAt: null,
            lifecycleState: DeviceLifecycleState.MAINTENANCE,
            lifecycleRequest: JSON.stringify(statement.envelope),
            lifecycleRequestSentAt: null,
            lifecycleRequestHandedAt: null,
            maintenanceExpiresAt: window.expiresAt,
          })
          .where('id = :id AND tenant_id = :tenantId', where)
          .execute();
        return { lifecycleSeq, windowEndsAt: window.expiresAt };
      },
    );
  }

  /** Why {@link beginReprovisioning}'s guard matched no row. */
  private async reprovisioningRefusal(
    manager: EntityManager,
    device: Pick<EdgeDevice, 'id' | 'tenantId'>,
    binding: DeviceBinding,
    now: Date,
  ): Promise<ReprovisioningRefusal> {
    const row = await manager
      .createQueryBuilder(EdgeDevice, 'd')
      .where('d.id = :id AND d.tenantId = :tenantId', { id: device.id, tenantId: device.tenantId })
      .getOne();
    if (row === null || TERMINAL_STATES.includes(row.lifecycleState)) return 'terminal';
    if (
      row.agentChannel !== EdgeAgentChannel.SUDERRA_OS ||
      row.deviceBindingMethod !== binding.method ||
      row.deviceBindingSha256 !== binding.digest.sha256
    ) {
      return 'not-committed';
    }
    if (row.activationReceiptHandedAt === null) return 'receipt-not-handed';
    if (row.maintenanceExpiresAt !== null && row.maintenanceExpiresAt > now) return 'window-open';
    return 'not-committed';
  }

  /**
   * Closes a re-provisioning window that ended unused: no activation was
   * issued under its token, so root returned the device to ACTIVE with its
   * current install and config (DEC-5.14, lifecycle.json). The token and the
   * statement die with the window; the committed activation, binding and
   * credential were never touched. Returns true when a window was closed.
   */
  async settleLapsedMaintenance(
    device: Pick<EdgeDevice, 'id' | 'tenantId'>,
    now: Date,
  ): Promise<boolean> {
    return runInTenantTransaction(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      device.tenantId,
      async (qr) => {
        const settled = await qr.manager
          .createQueryBuilder()
          .update(EdgeDevice)
          .set({
            lifecycleState: DeviceLifecycleState.ACTIVE,
            provisioningToken: null,
            tokenIssuedAt: null,
            tokenExpiresAt: null,
            reservedBindingMethod: null,
            reservedBindingSha256: null,
            reservationExpiresAt: null,
            lifecycleRequest: null,
            lifecycleRequestSentAt: null,
            lifecycleRequestHandedAt: null,
            maintenanceExpiresAt: null,
          })
          .where('id = :id AND tenant_id = :tenantId', {
            id: device.id,
            tenantId: device.tenantId,
            maintenance: DeviceLifecycleState.MAINTENANCE,
            now,
          })
          .andWhere('lifecycle_state = :maintenance AND maintenance_expires_at <= :now')
          .andWhere('credentials_issued_at IS NULL AND token_used_at IS NULL')
          .returning(['id'])
          .execute();
        return (settled.raw as unknown[]).length === 1;
      },
    );
  }

  /**
   * A fresh token in TOKEN_ISSUED for a device the operator re-installs from
   * scratch (a generic-Linux device, a token regenerated before any commit,
   * or a Suderra OS activation root never confirmed): no reservation, no
   * pending credentials, no committed activation, no statements to hand
   * over, and the broker credential revoked. The committed binding is kept —
   * the same hardware re-provisions.
   *
   * The channel is kept only where the committed binding proves it: a
   * device that merely reserved a Suderra OS manifest under the replaced
   * token returns to the generic-Linux channel, so a token holder who
   * fetched the Suderra OS endpoint for a generic device cannot leave it on
   * signed-only commands and reservation-gated activation for good; the next
   * Suderra OS fetch sets the channel again. Returns false for a terminal
   * device, and for a Suderra OS device root recorded as ACTIVE.
   */
  async reissueToken(
    device: Pick<EdgeDevice, 'id' | 'tenantId'>,
    reissue: {
      readonly tokenHash: string;
      readonly tokenIssuedAt: Date;
      readonly tokenExpiresAt: Date;
      readonly lifecycleState: DeviceLifecycleState;
    },
  ): Promise<boolean> {
    return runInTenantTransaction(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      device.tenantId,
      async (qr) => {
        const updated = await qr.manager
          .createQueryBuilder()
          .update(EdgeDevice)
          .set({
            provisioningToken: reissue.tokenHash,
            tokenIssuedAt: reissue.tokenIssuedAt,
            tokenExpiresAt: reissue.tokenExpiresAt,
            tokenUsedAt: null,
            credentialsIssuedAt: null,
            reservedBindingMethod: null,
            reservedBindingSha256: null,
            reservationExpiresAt: null,
            issuedManifestSha256: null,
            activationId: null,
            activatedAt: null,
            activationReceipt: null,
            activationReceiptExpiresAt: null,
            activationReceiptSentAt: null,
            activationReceiptHandedAt: null,
            lifecycleRequest: null,
            lifecycleRequestSentAt: null,
            lifecycleRequestHandedAt: null,
            maintenanceExpiresAt: null,
            lifecycleState: reissue.lifecycleState,
            agentChannel: () =>
              `CASE WHEN device_binding_sha256 IS NULL THEN '${EdgeAgentChannel.GENERIC_LINUX}' ELSE agent_channel END`,
            mqttPasswordHash: null,
            previousMqttPasswordHash: null,
            fingerprint: null,
            agentVersion: null,
            isOnline: false,
          })
          .where('id = :id AND tenant_id = :tenantId', {
            id: device.id,
            tenantId: device.tenantId,
            terminal: TERMINAL_STATES,
            channel: EdgeAgentChannel.SUDERRA_OS,
          })
          .andWhere('lifecycle_state NOT IN (:...terminal)')
          // A Suderra OS device whose root recorded its activation is never
          // revoked by a reissue: it re-provisions in place (beginReprovisioning).
          .andWhere(
            'NOT (agent_channel = :channel AND device_binding_sha256 IS NOT NULL' +
              ' AND activation_receipt_handed_at IS NOT NULL)',
          )
          .returning(['id'])
          .execute();
        return (updated.raw as unknown[]).length === 1;
      },
    );
  }
}
