import {
  getTenantSchemaName,
  validateTenantSchemaName,
} from '@aquaculture/backend-common/database';
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { MinioClientService } from '@platform/storage';

import { TelemetryRetentionOrchestratorService } from '../telemetry-retention-orchestrator.service';
import { ARCHIVE_CODEC_ID, ARCHIVE_FORMAT_VERSION } from './telemetry-archive-codec';

/**
 * Task 6 (SENSOR-HIGH-095): the INDEPENDENT verify half. Only this service
 * appends VERIFIED — and it does so only when a full re-read of the stored
 * artifact matches the ledger manifest EXACTLY (sha256 over the bytes,
 * header format/codec/tenant/day, and the trailer rowCount). Any mismatch
 * appends FAILED and the Task 4 gate keeps refusing the drop.
 *
 * Independence is by construction: the verifier reaches the object through
 * its own download path and recomputes everything from the bytes up — it
 * never trusts the exporter's in-memory values.
 */
@Injectable()
export class TelemetryParquetVerifierService {
  private readonly logger = new Logger(TelemetryParquetVerifierService.name);

  constructor(
    private readonly storage: MinioClientService,
    private readonly ledger: TelemetryRetentionOrchestratorService,
  ) {}

  /**
   * Verify one operation's EXPORTED artifact. Returns 'VERIFIED' or
   * 'FAILED' (also appended to the ledger).
   */
  async verifyOperation(operation: {
    operationId: string;
    tenantId: string;
    rangeStart: Date;
    rangeEnd: Date;
    objectKey: string | null;
    parquetSha256: string | null;
    sourceRowCount: string | null;
  }): Promise<'VERIFIED' | 'FAILED'> {
    const tenantSchema = validateTenantSchemaName(getTenantSchemaName(operation.tenantId));
    const actor = 'telemetry-parquet-verifier';
    const day = operation.rangeStart.toISOString().slice(0, 10);

    const fail = async (reason: string): Promise<'FAILED'> => {
      this.logger.error(`Archive verify FAILED for ${operation.objectKey}: ${reason}`);
      await this.ledger.append({
        operationId: operation.operationId,
        tenantId: operation.tenantId,
        tenantSchema,
        rangeStart: operation.rangeStart,
        rangeEnd: operation.rangeEnd,
        state: 'FAILED',
        objectKey: operation.objectKey,
        actor,
        sourceRowCount: operation.sourceRowCount,
      });
      return 'FAILED';
    };

    if (!operation.objectKey || !operation.parquetSha256 || !operation.sourceRowCount) {
      return fail('EXPORTED event is missing objectKey/sha256/rowCount');
    }

    let bytes: Buffer;
    try {
      bytes = await this.storage.downloadFile(operation.objectKey);
    } catch (error) {
      return fail(`object download failed: ${(error as Error).message}`);
    }

    // 1. Byte identity.
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== operation.parquetSha256) {
      return fail(`sha256 mismatch: manifest=${operation.parquetSha256} actual=${sha256}`);
    }

    // 2. Structural re-read — parse the artifact the way any future
    //    consumer would and cross-check the header + trailer against the
    //    manifest claims.
    const text = bytes.toString('utf8');
    const lines = text.split('\n');
    // Every line (incl. the trailer) ends with \n — the split leaves a
    // trailing empty element; anything else means malformed bytes.
    if (lines[lines.length - 1] !== '' || lines.length < 3) {
      return fail('artifact is not newline-terminated or too short');
    }
    lines.pop();

    let header: Record<string, unknown>;
    let trailer: Record<string, unknown>;
    try {
      header = JSON.parse(lines[0]!) as Record<string, unknown>;
      trailer = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
    } catch (error) {
      return fail(`header/trailer JSON parse failed: ${(error as Error).message}`);
    }

    if (header['format'] !== ARCHIVE_FORMAT_VERSION) {
      return fail(`unknown format ${JSON.stringify(header['format'])}`);
    }
    if (header['codec'] !== ARCHIVE_CODEC_ID) {
      return fail(`unknown codec ${JSON.stringify(header['codec'])}`);
    }
    if (header['tenantId'] !== operation.tenantId || header['day'] !== day) {
      return fail(
        `header identity mismatch: ${JSON.stringify(header['tenantId'])}/${JSON.stringify(header['day'])}`,
      );
    }

    const claimed = Number(operation.sourceRowCount);
    const trailerCount = Number(trailer['rowCount']);
    const actualRows = lines.length - 2;
    if (trailerCount !== actualRows || trailerCount !== claimed) {
      return fail(
        `row-count mismatch: manifest=${claimed} trailer=${trailerCount} lines=${actualRows}`,
      );
    }

    // 3. Every data line must parse — a truncated middle would already fail
    //    the sha256 gate, but an exporter bug writing invalid JSON with a
    //    self-consistent manifest must not verify.
    for (let i = 1; i < lines.length - 1; i++) {
      try {
        JSON.parse(lines[i]!);
      } catch (error) {
        return fail(`row ${i} is not valid JSON: ${(error as Error).message}`);
      }
    }

    await this.ledger.append({
      operationId: operation.operationId,
      tenantId: operation.tenantId,
      tenantSchema,
      rangeStart: operation.rangeStart,
      rangeEnd: operation.rangeEnd,
      state: 'VERIFIED',
      objectKey: operation.objectKey,
      parquetSha256: sha256,
      sourceRowCount: operation.sourceRowCount,
      actor,
    });
    this.logger.log(
      `Archive VERIFIED ${operation.objectKey}: ${claimed} rows, sha256=${sha256.slice(0, 12)}…`,
    );
    return 'VERIFIED';
  }
}
