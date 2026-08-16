import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  MobileCommandEnvelope,
  RequiredMobileCommandEnvelope,
} from './mobile-command-envelope.input';

export type MobileCommandReceiptTable =
  | 'farm_mobile_command_receipts'
  | 'hr_mobile_command_receipts';

export interface BeginMobileCommandReceiptOptions {
  tableName: MobileCommandReceiptTable;
  tenantId: string;
  envelope?: MobileCommandEnvelope | null;
  operationType: string;
  responseType: string;
}

export type MobileCommandReceiptState =
  | { mode: 'legacy' }
  | { mode: 'started'; receiptId: string }
  | {
      mode: 'replay';
      responseType: string | null;
      responseId: string | null;
      responsePayload: unknown;
    };

export interface CompleteMobileCommandReceiptOptions {
  tableName: MobileCommandReceiptTable;
  receipt: MobileCommandReceiptState;
  responseType: string;
  responseId?: string | null;
  responsePayload?: unknown;
}

export interface PurgeMobileCommandReceiptsOptions {
  tableName: MobileCommandReceiptTable;
  tenantId: string;
  retentionDays: number;
}

const RECEIPT_TABLES: ReadonlySet<string> = new Set([
  'farm_mobile_command_receipts',
  'hr_mobile_command_receipts',
]);

@Injectable()
export class MobileCommandReceiptService {
  async begin(
    manager: EntityManager,
    options: BeginMobileCommandReceiptOptions,
  ): Promise<MobileCommandReceiptState> {
    const envelope = options.envelope;
    if (!envelope?.clientCommandId) {
      return { mode: 'legacy' };
    }
    if (!envelope.payloadHash) {
      throw new BadRequestException('payloadHash is required when clientCommandId is provided');
    }

    const tableName = this.assertReceiptTable(options.tableName);
    const operationType = envelope.operationType ?? options.operationType;
    const inserted: Array<{ id: string }> = await manager.query(
      `
        INSERT INTO ${tableName} (
          "tenantId", "clientCommandId", "payloadHash", "operationType",
          "deviceId", "clientCreatedAt", "status", "responseType"
        )
        VALUES ($1, $2, $3, $4, $5, $6::timestamptz, 'IN_PROGRESS', $7)
        ON CONFLICT ("tenantId", "clientCommandId") DO NOTHING
        RETURNING "id"
      `,
      [
        options.tenantId,
        envelope.clientCommandId,
        envelope.payloadHash,
        operationType,
        envelope.deviceId ?? null,
        envelope.clientCreatedAt ?? null,
        options.responseType,
      ],
    );

    if (inserted[0]?.id) {
      return { mode: 'started', receiptId: inserted[0].id };
    }

    const existing: Array<{
      payloadHash: string;
      status: string;
      responseType: string | null;
      responseId: string | null;
      responsePayload: unknown;
    }> = await manager.query(
      `
        SELECT "payloadHash", "status", "responseType", "responseId", "responsePayload"
        FROM ${tableName}
        WHERE "tenantId" = $1 AND "clientCommandId" = $2
        FOR UPDATE
      `,
      [options.tenantId, envelope.clientCommandId],
    );

    const receipt = existing[0];
    if (!receipt) {
      throw new ConflictException('Mobile command receipt disappeared during replay lookup');
    }
    if (receipt.payloadHash !== envelope.payloadHash) {
      throw new ConflictException('clientCommandId was reused with a different payloadHash');
    }
    if (receipt.status !== 'COMPLETED') {
      throw new ConflictException('Mobile command is already being processed');
    }

    return {
      mode: 'replay',
      responseType: receipt.responseType,
      responseId: receipt.responseId,
      responsePayload: receipt.responsePayload,
    };
  }

  async complete(
    manager: EntityManager,
    options: CompleteMobileCommandReceiptOptions,
  ): Promise<void> {
    if (options.receipt.mode !== 'started') {
      return;
    }

    const tableName = this.assertReceiptTable(options.tableName);
    await manager.query(
      `
        UPDATE ${tableName}
        SET
          "status" = 'COMPLETED',
          "responseType" = $2,
          "responseId" = $3,
          "responsePayload" = $4::jsonb,
          "updatedAt" = now()
        WHERE "id" = $1
      `,
      [
        options.receipt.receiptId,
        options.responseType,
        options.responseId ?? null,
        JSON.stringify(options.responsePayload ?? null),
      ],
    );
  }

  /**
   * The receipt authority owns lifecycle deletion as well as begin/complete;
   * callers can select neither an arbitrary table nor an arbitrary predicate.
   */
  async purgeBeforeRetention(
    manager: EntityManager,
    options: PurgeMobileCommandReceiptsOptions,
  ): Promise<number> {
    const tableName = this.assertReceiptTable(options.tableName);
    if (options.tenantId.trim().length === 0 || options.tenantId !== options.tenantId.trim()) {
      throw new Error('tenantId must be a non-empty canonical identifier');
    }
    if (!Number.isSafeInteger(options.retentionDays) || options.retentionDays < 1) {
      throw new Error('retentionDays must be a positive safe integer');
    }
    const rows: Array<{ count: number }> = await manager.query(
      `WITH deleted AS (
         DELETE FROM ${tableName}
          WHERE "tenantId" = $1
            AND "createdAt" < (now() - ($2 * INTERVAL '1 day'))
         RETURNING 1
       ) SELECT COUNT(*)::int AS count FROM deleted`,
      [options.tenantId, options.retentionDays],
    );
    return Number(rows[0]?.count ?? 0);
  }

  private assertReceiptTable(tableName: MobileCommandReceiptTable): MobileCommandReceiptTable {
    if (!RECEIPT_TABLES.has(tableName)) {
      throw new Error(`Unsupported mobile command receipt table: ${tableName}`);
    }
    return tableName;
  }
}

export function mobileCommandEnvelopeFromInput(
  input: RequiredMobileCommandEnvelope,
): RequiredMobileCommandEnvelope;
export function mobileCommandEnvelopeFromInput(input: MobileCommandEnvelope): MobileCommandEnvelope;
export function mobileCommandEnvelopeFromInput(
  input: MobileCommandEnvelope,
): MobileCommandEnvelope {
  return {
    clientCommandId: input.clientCommandId,
    clientCreatedAt: input.clientCreatedAt,
    deviceId: input.deviceId,
    operationType: input.operationType,
    payloadHash: input.payloadHash,
    schemaVersion: input.schemaVersion,
  };
}
