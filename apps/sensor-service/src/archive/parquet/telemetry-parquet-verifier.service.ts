import {
  getTenantSchemaName,
  validateTenantSchemaName,
} from '@aquaculture/backend-common/database';
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { MinioClientService } from '@platform/storage';

import { TelemetryRetentionOrchestratorService } from '../telemetry-retention-orchestrator.service';
import {
  ARCHIVE_CODEC_ID,
  ARCHIVE_FORMAT_VERSION,
  decodeParquetArchive,
  isParquetArchive,
} from './telemetry-archive-codec';

/**
 * Task 6 (SENSOR-HIGH-095, SENSOR-HIGH-105): the INDEPENDENT verify half.
 * Only this service appends VERIFIED — and it does so only when a full re-read
 * of the stored artifact matches the ledger manifest EXACTLY. Any mismatch
 * appends FAILED and the Task 4 gate keeps refusing the drop.
 *
 * Independence is by construction: the verifier reaches the object through its
 * own download path and recomputes everything from the bytes up — it never
 * trusts the exporter's in-memory values.
 *
 * The format is decided by the BYTES, not by whatever the current exporter
 * writes: a version-2 artifact announces itself with the Parquet magic and is
 * decoded row by row through the codec, while an object written by the earlier
 * columnar-JSONL exporter still verifies under its own rules. A tenant's
 * already-VERIFIED history must not become unverifiable because the writer
 * moved on.
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

    // 2. Structural re-read, in whichever format the bytes actually are.
    const claimed = Number(operation.sourceRowCount);
    const structure = isParquetArchive(bytes)
      ? await this.readParquet(bytes, operation.tenantId, day)
      : this.readColumnarJsonl(bytes, operation.tenantId, day);
    if (typeof structure === 'string') return fail(structure);
    if (structure.rowCount !== claimed) {
      return fail(`row-count mismatch: manifest=${claimed} artifact=${structure.rowCount}`);
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

  /**
   * Version 2. Every row is decoded into a typed ArchiveRow — a file that
   * hashes correctly but holds values the platform could never have written
   * does not verify — and the PK order the exporter promised is re-checked on
   * the stored bytes, because that order is what a restore relies on.
   */
  private async readParquet(
    bytes: Buffer,
    tenantId: string,
    day: string,
  ): Promise<{ rowCount: number } | string> {
    try {
      const decoded = await decodeParquetArchive(bytes);
      if (decoded.header.tenantId !== tenantId || decoded.header.day !== day) {
        return (
          `header identity mismatch: ${JSON.stringify(decoded.header.tenantId)}/` +
          `${JSON.stringify(decoded.header.day)}`
        );
      }
      let previous: string | null = null;
      for (const row of decoded.rows) {
        if (row.tenantId !== tenantId) {
          return `row tenant mismatch: ${JSON.stringify(row.tenantId)}`;
        }
        if (previous !== null && row.time < previous) {
          return `rows are not in PK order at ${row.time}`;
        }
        previous = row.time;
      }
      return { rowCount: decoded.rows.length };
    } catch (error) {
      return `parquet re-read failed: ${(error as Error).message}`;
    }
  }

  /**
   * Version 1 — the columnar-JSONL artifacts written before the Parquet codec
   * landed. Kept verbatim so an object already in a tenant's bucket, with a
   * ledger row carrying a sha256 over exactly these bytes, still verifies.
   */
  private readColumnarJsonl(
    bytes: Buffer,
    tenantId: string,
    day: string,
  ): { rowCount: number } | string {
    const text = bytes.toString('utf8');
    const lines = text.split('\n');
    // Every line (incl. the trailer) ends with \n — the split leaves a
    // trailing empty element; anything else means malformed bytes.
    if (lines[lines.length - 1] !== '' || lines.length < 3) {
      return 'artifact is not newline-terminated or too short';
    }
    lines.pop();

    let header: Record<string, unknown>;
    let trailer: Record<string, unknown>;
    try {
      header = JSON.parse(lines[0]!) as Record<string, unknown>;
      trailer = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
    } catch (error) {
      return `header/trailer JSON parse failed: ${(error as Error).message}`;
    }

    if (header['format'] !== ARCHIVE_FORMAT_VERSION) {
      return `unknown format ${JSON.stringify(header['format'])}`;
    }
    if (header['codec'] !== ARCHIVE_CODEC_ID) {
      return `unknown codec ${JSON.stringify(header['codec'])}`;
    }
    if (header['tenantId'] !== tenantId || header['day'] !== day) {
      return (
        `header identity mismatch: ${JSON.stringify(header['tenantId'])}/` +
        `${JSON.stringify(header['day'])}`
      );
    }

    const trailerCount = Number(trailer['rowCount']);
    const actualRows = lines.length - 2;
    if (trailerCount !== actualRows) {
      return `row-count mismatch: trailer=${trailerCount} lines=${actualRows}`;
    }

    // Every data line must parse — a truncated middle would already fail the
    // sha256 gate, but an exporter bug writing invalid JSON with a
    // self-consistent manifest must not verify.
    for (let index = 1; index < lines.length - 1; index++) {
      try {
        JSON.parse(lines[index]!);
      } catch (error) {
        return `row ${index} is not valid JSON: ${(error as Error).message}`;
      }
    }
    return { rowCount: trailerCount };
  }
}
