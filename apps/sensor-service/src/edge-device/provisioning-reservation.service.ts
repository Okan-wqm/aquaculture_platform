import { createHash, randomUUID } from 'crypto';

import { runInTenantTransaction, SENSOR_SOURCE_SCHEMA } from '@aquaculture/backend-common/database';
import { Injectable, Logger } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

import { ActivationReceiptService } from './activation-receipt.service';
import {
  BINDING_METHODS,
  type DeviceBinding,
  type Sha256Digest,
  wholeSecond,
} from './edge-contract';
import { DeviceLifecycleState, EdgeAgentChannel, EdgeDevice } from './entities/edge-device.entity';

/**
 * The two-phase provisioning token's transitions (ADR-048 DEC-5.7, DEC-5.8).
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
 */

const TERMINAL_STATES = [DeviceLifecycleState.REVOKED, DeviceLifecycleState.DECOMMISSIONED];

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
  readonly device_binding_method: string | null;
  readonly device_binding_sha256: string | null;
  readonly issued_manifest_sha256: string | null;
}

function isBindingMethod(value: string | null): value is DeviceBinding['method'] {
  return value !== null && (BINDING_METHODS as readonly string[]).includes(value);
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
   * The token stays valid until the commit. Returns false when the guard
   * matches no row.
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
   * reserved binding the device's identity and, for a Suderra OS device,
   * signs the activation receipt naming the manifest root installed. Returns
   * null when there was nothing to commit (already committed, never pending).
   */
  async commitFirstSession(
    device: Pick<EdgeDevice, 'id' | 'tenantId'>,
    now: Date,
  ): Promise<Commit | null> {
    const activatedAt = wholeSecond(now);
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
            deviceBindingMethod: () => 'COALESCE(reserved_binding_method, device_binding_method)',
            deviceBindingSha256: () => 'COALESCE(reserved_binding_sha256, device_binding_sha256)',
            reservedBindingMethod: null,
            reservedBindingSha256: null,
            reservationExpiresAt: null,
          })
          .where('id = :id AND tenant_id = :tenantId', { id: device.id, tenantId: device.tenantId })
          .andWhere('token_used_at IS NULL AND provisioning_token IS NOT NULL')
          .andWhere('credentials_issued_at IS NOT NULL')
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
        if (
          !isBindingMethod(row.device_binding_method) ||
          row.device_binding_sha256 === null ||
          row.issued_manifest_sha256 === null
        ) {
          // The activation guard admits a Suderra OS device only under a
          // reservation with an issued manifest, so this row cannot exist;
          // refusing (and rolling back) keeps the token unspent if it ever does.
          throw new Error(
            `Suderra OS device ${row.id} committed without a reserved binding and manifest`,
          );
        }
        const receipt = this.receipts.issue({
          tenantId: row.tenant_id,
          deviceId: row.id,
          binding: {
            method: row.device_binding_method,
            digest: { sha256: row.device_binding_sha256 },
          },
          manifestDigest: { sha256: row.issued_manifest_sha256 },
          activationId: randomUUID(),
          activatedAt,
        });
        const activationReceipt = JSON.stringify(receipt.envelope);
        await qr.manager
          .createQueryBuilder()
          .update(EdgeDevice)
          .set({ activationReceipt, activationReceiptHandedAt: null })
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
          activationReceipt,
        };
      },
    );
  }

  /** The agent handed the receipt to root (its `activation_receipt` command succeeded). */
  async markReceiptHanded(device: Pick<EdgeDevice, 'id' | 'tenantId'>, now: Date): Promise<void> {
    await runInTenantTransaction(
      this.dataSource,
      SENSOR_SOURCE_SCHEMA,
      device.tenantId,
      async (qr) => {
        await qr.manager
          .createQueryBuilder()
          .update(EdgeDevice)
          .set({ activationReceiptHandedAt: now })
          .where('id = :id AND tenant_id = :tenantId', { id: device.id, tenantId: device.tenantId })
          .andWhere('activation_receipt IS NOT NULL AND activation_receipt_handed_at IS NULL')
          .execute();
      },
    );
  }

  /**
   * A fresh token in TOKEN_ISSUED: no reservation, no pending credentials,
   * no receipt. The committed binding is kept — the same hardware
   * re-provisions (DEC-5.14). With `revokeCredentials` the broker credential
   * goes too (a generic re-install, or a token regenerated before the
   * commit); without it the running agent keeps its credential until its
   * next activation replaces it (Suderra OS re-provisioning, where the agent
   * must stay online to receive the lifecycle statement). Allocates the
   * update_seq of the lifecycle statement that opens re-provisioning.
   * Returns null for a terminal device.
   */
  async reissueToken(
    device: Pick<EdgeDevice, 'id' | 'tenantId'>,
    reissue: {
      readonly tokenHash: string;
      readonly tokenExpiresAt: Date;
      readonly lifecycleState: DeviceLifecycleState;
      readonly revokeCredentials: boolean;
    },
  ): Promise<{ readonly lifecycleSeq: number } | null> {
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
            tokenExpiresAt: reissue.tokenExpiresAt,
            tokenUsedAt: null,
            credentialsIssuedAt: null,
            reservedBindingMethod: null,
            reservedBindingSha256: null,
            reservationExpiresAt: null,
            issuedManifestSha256: null,
            activationReceipt: null,
            activationReceiptHandedAt: null,
            lifecycleState: reissue.lifecycleState,
            edgeStatementSeq: () => 'edge_statement_seq + 1',
            ...(reissue.revokeCredentials
              ? { mqttPasswordHash: null, fingerprint: null, agentVersion: null, isOnline: false }
              : {}),
          })
          .where('id = :id AND tenant_id = :tenantId', {
            id: device.id,
            tenantId: device.tenantId,
            terminal: TERMINAL_STATES,
          })
          .andWhere('lifecycle_state NOT IN (:...terminal)')
          .returning(['edgeStatementSeq'])
          .execute();
        const row = (updated.raw as Array<{ edge_statement_seq: string | number }>)[0];
        return row === undefined ? null : { lifecycleSeq: Number(row.edge_statement_seq) };
      },
    );
  }
}
