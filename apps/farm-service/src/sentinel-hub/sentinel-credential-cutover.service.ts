import { createHash } from 'node:crypto';

import {
  MarineProviderCredentialClient,
  type CdseProviderCredentialBundle,
} from '@aquaculture/backend-common/config-client';
import {
  BypassRlsService,
  forEachVerifiedRetainedTenantSchema,
  getTenantSchemaName,
  tenantManagerRepo,
  type TenantSchemaIdentity,
} from '@aquaculture/backend-common/database';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  MarineProviderCredentialMutationOutcome,
  serializeMarineProviderCdseCredentialBundle,
} from '@platform/event-contracts';
import { DataSource, QueryRunner } from 'typeorm';

import { SentinelHubSettings } from './entities/sentinel-hub-settings.entity';

const CUTOVER_TIMEOUT_MS = 30_000;
const CUTOVER_CONCURRENCY = 2;
const DECRYPTION_FAILURE_SENTINEL = '[DECRYPTION_FAILED]';

interface LegacySentinelRowState {
  id: string;
  tenantId: string;
  isConfigured: boolean;
  configCutoverAt: Date | string | null;
  configCutoverBundleDigest: string | null;
  configCutoverErasedAt: Date | string | null;
}

interface PreparedCredentialCutover extends TenantSchemaIdentity {
  rowId: string;
  bundle: CdseProviderCredentialBundle;
  bundleDigest: string;
}

interface CredentialCutoverReceipt {
  sourceTenantId: string;
  configVersion: number;
}

interface CredentialUpsertBatch {
  receipts: Map<string, CredentialCutoverReceipt>;
  erasedTenantIds: Set<string>;
  failureCount: number;
}

/**
 * One-shot, two-phase migration from tenant-local Sentinel credentials to the
 * config-service credential authority.
 *
 * The legacy row is the durable saga record:
 *
 *  1. PREPARE (tenant DB transaction): decrypt and validate the complete
 *     bundle, persist its canonical SHA-256 digest, and let the database
 *     trigger freeze all credential fields.
 *  2. TRANSFER (no DB transaction): send the bundle through the signed,
 *     bounded NATS boundary. Config-service accepts the first value only and
 *     treats an exact retry as idempotent.
 *  3. FINALIZE (new tenant DB transaction): re-read/decrypt, prove the digest
 *     is unchanged, persist the config-service receipt, and scrub every legacy
 *     ciphertext atomically.
 *
 * A crash or lost reply at any boundary leaves either an unprepared or a
 * frozen pending row. The next boot safely retries the exact value; it can
 * never overwrite a different config-service credential. Runtime reads never
 * consult this table, and startup remains fail-closed until every configured
 * legacy row has a verified receipt and no duplicate secret remains.
 */
@Injectable()
export class SentinelCredentialCutoverService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SentinelCredentialCutoverService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly bypassRls: BypassRlsService,
    private readonly credentialClient: MarineProviderCredentialClient,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const candidates = new Map<string, PreparedCredentialCutover>();

    try {
      const prepareResults = await this.bypassRls.withBypass(
        'farm-service:sentinel-credential-cutover-prepare',
        () =>
          forEachVerifiedRetainedTenantSchema(
            this.dataSource,
            async ({ queryRunner, schemaName, tenantId }) => {
              const candidate = await this.prepareCurrentTenantSchema(queryRunner, {
                schemaName,
                tenantId,
              });
              if (candidate) {
                candidates.set(tenantId, candidate);
              }
            },
            {
              searchPathSuffix: 'farm, public',
              concurrency: CUTOVER_CONCURRENCY,
              perTenantTimeoutMs: CUTOVER_TIMEOUT_MS,
              logger: this.logger,
            },
          ),
      );

      const preparedTenantIds = new Set(
        prepareResults.filter((result) => result.outcome === 'ok').map((result) => result.tenantId),
      );
      for (const tenantId of candidates.keys()) {
        if (!preparedTenantIds.has(tenantId)) {
          candidates.delete(tenantId);
        }
      }

      const prepareFailureCount = prepareResults.filter((result) => result.outcome !== 'ok').length;
      const upsertBatch = await this.upsertPreparedCandidates([...candidates.values()]);
      const finalizedTenantIds = new Set<string>();
      const terminalTenantIds = new Set([
        ...upsertBatch.receipts.keys(),
        ...upsertBatch.erasedTenantIds,
      ]);

      const finalizeResults =
        terminalTenantIds.size === 0
          ? []
          : await this.bypassRls.withBypass(
              'farm-service:sentinel-credential-cutover-finalize',
              () =>
                forEachVerifiedRetainedTenantSchema(
                  this.dataSource,
                  async ({ queryRunner, schemaName, tenantId }) => {
                    const candidate = candidates.get(tenantId);
                    const receipt = upsertBatch.receipts.get(tenantId);
                    if (!candidate || !terminalTenantIds.has(tenantId)) {
                      return;
                    }
                    if (receipt) {
                      await this.finalizeCurrentTenantSchema(
                        queryRunner,
                        { schemaName, tenantId },
                        candidate,
                        receipt,
                      );
                    } else {
                      await this.finalizeErasedTenantSchema(
                        queryRunner,
                        { schemaName, tenantId },
                        candidate,
                      );
                    }
                    finalizedTenantIds.add(tenantId);
                  },
                  {
                    searchPathSuffix: 'farm, public',
                    concurrency: CUTOVER_CONCURRENCY,
                    perTenantTimeoutMs: CUTOVER_TIMEOUT_MS,
                    logger: this.logger,
                  },
                ),
            );

      const finalizeResultFailures = finalizeResults.filter(
        (result) => terminalTenantIds.has(result.tenantId) && result.outcome !== 'ok',
      ).length;
      const missingFinalizations = [...terminalTenantIds].filter(
        (tenantId) => !finalizedTenantIds.has(tenantId),
      ).length;
      const failureCount =
        prepareFailureCount +
        upsertBatch.failureCount +
        Math.max(finalizeResultFailures, missingFinalizations);

      if (failureCount > 0) {
        throw new Error(
          `Sentinel credential cutover failed for ${failureCount} tenant schema phase(s); farm-service startup refused`,
        );
      }
    } finally {
      // Drop all reachable bundle objects promptly. JavaScript strings cannot
      // be zeroized, so no candidate is retained on the singleton instance.
      candidates.clear();
    }
  }

  async prepareCurrentTenantSchema(
    queryRunner: QueryRunner,
    canonicalIdentity: TenantSchemaIdentity,
  ): Promise<PreparedCredentialCutover | null> {
    this.assertCanonicalIdentity(canonicalIdentity);
    const rows = await this.lockLegacyRows(queryRunner);
    if (rows.length === 0) {
      return null;
    }
    if (rows.length !== 1) {
      throw new Error('Legacy Sentinel credential uniqueness invariant is violated');
    }

    const row = rows[0];
    if (!row) {
      return null;
    }
    this.assertRowTenant(row, canonicalIdentity);
    if (row.configCutoverAt != null || row.configCutoverErasedAt != null) {
      return null;
    }
    if (!row.isConfigured) {
      await this.scrubDormantLegacySecrets(queryRunner);
      return null;
    }

    const settings = await this.loadSettings(queryRunner, row.id, canonicalIdentity);
    const bundle = this.toBundle(settings);
    const bundleDigest = this.bundleDigest(bundle);
    if (row.configCutoverBundleDigest !== null && row.configCutoverBundleDigest !== bundleDigest) {
      throw new Error('Prepared Sentinel credential bundle digest does not match the legacy row');
    }
    if (row.configCutoverBundleDigest === null) {
      const updated: Array<{ id: string }> = await queryRunner.query(
        `UPDATE "sentinel_hub_settings"
            SET "config_cutover_bundle_digest" = $1,
                "updated_at" = now()
          WHERE "id" = $2
            AND "tenantId" = $3
            AND "config_cutover_at" IS NULL
            AND "config_cutover_bundle_digest" IS NULL
          RETURNING "id"`,
        [bundleDigest, row.id, canonicalIdentity.tenantId],
      );
      if (updated.length !== 1) {
        throw new Error('Legacy Sentinel credential preparation lost its locked row');
      }
    }

    return {
      ...canonicalIdentity,
      rowId: row.id,
      bundle,
      bundleDigest,
    };
  }

  async finalizeCurrentTenantSchema(
    queryRunner: QueryRunner,
    canonicalIdentity: TenantSchemaIdentity,
    candidate: PreparedCredentialCutover,
    receipt: CredentialCutoverReceipt,
  ): Promise<void> {
    this.assertCanonicalIdentity(canonicalIdentity);
    if (
      candidate.tenantId !== canonicalIdentity.tenantId ||
      candidate.schemaName !== canonicalIdentity.schemaName ||
      receipt.sourceTenantId !== canonicalIdentity.tenantId ||
      receipt.configVersion <= 0
    ) {
      throw new Error('Sentinel credential cutover receipt identity is inconsistent');
    }

    const rows = await this.lockLegacyRows(queryRunner);
    if (rows.length !== 1) {
      throw new Error('Prepared legacy Sentinel credential row is missing or duplicated');
    }
    const row = rows[0];
    if (!row) {
      throw new Error('Prepared legacy Sentinel credential row is missing');
    }
    this.assertRowTenant(row, canonicalIdentity);
    if (row.id !== candidate.rowId || row.configCutoverBundleDigest !== candidate.bundleDigest) {
      throw new Error('Prepared Sentinel credential identity changed before finalization');
    }
    if (row.configCutoverAt != null) {
      return;
    }
    if (row.configCutoverErasedAt != null) {
      throw new Error('Prepared Sentinel credential was terminally erased before finalization');
    }
    if (!row.isConfigured) {
      throw new Error('Prepared Sentinel credential was disabled before finalization');
    }

    const settings = await this.loadSettings(queryRunner, row.id, canonicalIdentity);
    if (this.bundleDigest(this.toBundle(settings)) !== candidate.bundleDigest) {
      throw new Error('Prepared Sentinel credential bundle changed before finalization');
    }

    const finalized: Array<{ id: string }> = await queryRunner.query(
      `UPDATE "sentinel_hub_settings"
          SET "config_cutover_at" = now(),
              "config_cutover_version" = $1,
              "config_cutover_source_tenant_id" = $2,
              "client_id" = NULL,
              "client_secret" = NULL,
              "instance_id" = NULL,
              "is_configured" = false,
              "updated_at" = now()
        WHERE "id" = $3
          AND "tenantId" = $2
          AND "config_cutover_bundle_digest" = $4
          AND "config_cutover_at" IS NULL
          AND "config_cutover_erased_at" IS NULL
          AND "is_configured" = true
        RETURNING "id"`,
      [receipt.configVersion, canonicalIdentity.tenantId, candidate.rowId, candidate.bundleDigest],
    );
    if (finalized.length !== 1) {
      throw new Error('Prepared Sentinel credential finalization lost its locked row');
    }
  }

  async finalizeErasedTenantSchema(
    queryRunner: QueryRunner,
    canonicalIdentity: TenantSchemaIdentity,
    candidate: PreparedCredentialCutover,
  ): Promise<void> {
    this.assertCanonicalIdentity(canonicalIdentity);
    if (
      candidate.tenantId !== canonicalIdentity.tenantId ||
      candidate.schemaName !== canonicalIdentity.schemaName
    ) {
      throw new Error('Sentinel erased-tenant cutover identity is inconsistent');
    }

    const rows = await this.lockLegacyRows(queryRunner);
    if (rows.length !== 1) {
      throw new Error('Prepared legacy Sentinel credential row is missing or duplicated');
    }
    const row = rows[0];
    if (!row) {
      throw new Error('Prepared legacy Sentinel credential row is missing');
    }
    this.assertRowTenant(row, canonicalIdentity);
    if (row.id !== candidate.rowId || row.configCutoverBundleDigest !== candidate.bundleDigest) {
      throw new Error('Prepared Sentinel credential identity changed before erased finalization');
    }
    if (row.configCutoverErasedAt != null) {
      return;
    }
    if (row.configCutoverAt != null || !row.isConfigured) {
      throw new Error('Prepared Sentinel credential has an incompatible terminal state');
    }

    const settings = await this.loadSettings(queryRunner, row.id, canonicalIdentity);
    if (this.bundleDigest(this.toBundle(settings)) !== candidate.bundleDigest) {
      throw new Error('Prepared Sentinel credential bundle changed before erased finalization');
    }

    const finalized: Array<{ id: string }> = await queryRunner.query(
      `UPDATE "sentinel_hub_settings"
          SET "config_cutover_erased_at" = now(),
              "client_id" = NULL,
              "client_secret" = NULL,
              "instance_id" = NULL,
              "is_configured" = false,
              "updated_at" = now()
        WHERE "id" = $1
          AND "tenantId" = $2
          AND "config_cutover_bundle_digest" = $3
          AND "config_cutover_at" IS NULL
          AND "config_cutover_erased_at" IS NULL
          AND "is_configured" = true
        RETURNING "id"`,
      [candidate.rowId, canonicalIdentity.tenantId, candidate.bundleDigest],
    );
    if (finalized.length !== 1) {
      throw new Error('Prepared Sentinel erased finalization lost its locked row');
    }
  }

  private async upsertPreparedCandidates(
    candidates: PreparedCredentialCutover[],
  ): Promise<CredentialUpsertBatch> {
    const receipts = new Map<string, CredentialCutoverReceipt>();
    const erasedTenantIds = new Set<string>();
    let failureCount = 0;
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(CUTOVER_CONCURRENCY, candidates.length) },
      async () => {
        while (cursor < candidates.length) {
          const candidate = candidates[cursor++];
          if (!candidate) {
            continue;
          }
          try {
            const result = await this.credentialClient.upsert(
              'CDSE',
              candidate.tenantId,
              candidate.bundle,
            );
            if (result.outcome === MarineProviderCredentialMutationOutcome.TENANT_ERASED) {
              erasedTenantIds.add(candidate.tenantId);
              continue;
            }
            if (
              result.outcome !== MarineProviderCredentialMutationOutcome.APPLIED ||
              result.sourceTenantId !== candidate.tenantId ||
              result.configVersion === null ||
              result.configVersion <= 0
            ) {
              failureCount += 1;
              continue;
            }
            receipts.set(candidate.tenantId, {
              sourceTenantId: result.sourceTenantId,
              configVersion: result.configVersion,
            });
          } catch {
            failureCount += 1;
          }
        }
      },
    );
    await Promise.all(workers);
    return { receipts, erasedTenantIds, failureCount };
  }

  private async lockLegacyRows(queryRunner: QueryRunner): Promise<LegacySentinelRowState[]> {
    return queryRunner.query(
      `SELECT "id", "tenantId",
              "is_configured" AS "isConfigured",
              "config_cutover_at" AS "configCutoverAt",
              "config_cutover_bundle_digest" AS "configCutoverBundleDigest",
              "config_cutover_erased_at" AS "configCutoverErasedAt"
         FROM "sentinel_hub_settings"
        ORDER BY "id"
        LIMIT 2
        FOR UPDATE`,
    );
  }

  private async loadSettings(
    queryRunner: QueryRunner,
    rowId: string,
    canonicalIdentity: TenantSchemaIdentity,
  ): Promise<SentinelHubSettings> {
    const repository = tenantManagerRepo(
      queryRunner.manager,
      SentinelHubSettings,
      canonicalIdentity.tenantId,
    );
    const settings = await repository.findOne({ where: { id: rowId } });
    if (!settings) {
      throw new Error('Legacy Sentinel credential row disappeared during cutover');
    }
    if (settings.tenantId !== canonicalIdentity.tenantId) {
      throw new Error('Loaded Sentinel credential tenant does not match its canonical schema');
    }
    return settings;
  }

  private assertCanonicalIdentity(canonicalIdentity: TenantSchemaIdentity): void {
    if (getTenantSchemaName(canonicalIdentity.tenantId) !== canonicalIdentity.schemaName) {
      throw new Error('Canonical tenant schema identity is inconsistent');
    }
  }

  private assertRowTenant(
    row: LegacySentinelRowState,
    canonicalIdentity: TenantSchemaIdentity,
  ): void {
    if (row.tenantId !== canonicalIdentity.tenantId) {
      throw new Error('Legacy Sentinel credential tenant does not match its canonical schema');
    }
  }

  private async scrubDormantLegacySecrets(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "sentinel_hub_settings"
         SET "client_id" = NULL,
             "client_secret" = NULL,
             "instance_id" = NULL,
             "updated_at" = now()
       WHERE "is_configured" = false
         AND "config_cutover_at" IS NULL
         AND "config_cutover_bundle_digest" IS NULL
         AND (
           "client_id" IS NOT NULL
           OR "client_secret" IS NOT NULL
           OR "instance_id" IS NOT NULL
         )
    `);
  }

  private bundleDigest(bundle: CdseProviderCredentialBundle): string {
    return createHash('sha256')
      .update(serializeMarineProviderCdseCredentialBundle(bundle), 'utf8')
      .digest('hex');
  }

  private toBundle(settings: SentinelHubSettings): CdseProviderCredentialBundle {
    if (
      !this.isUsableDecryptedValue(settings.clientId) ||
      !this.isUsableDecryptedValue(settings.clientSecret)
    ) {
      throw new Error('Configured legacy Sentinel row has an incomplete credential bundle');
    }
    if (settings.instanceId !== null && !this.isUsableDecryptedValue(settings.instanceId)) {
      throw new Error('Configured legacy Sentinel row has an unreadable instance identifier');
    }
    return {
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      ...(settings.instanceId ? { instanceId: settings.instanceId } : {}),
    };
  }

  private isUsableDecryptedValue(value: string | null): value is string {
    return value !== null && value.length > 0 && value !== DECRYPTION_FAILURE_SENTINEL;
  }
}
