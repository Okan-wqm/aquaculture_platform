import { createHash } from 'node:crypto';

import {
  CONFIGURATION_CATALOG_DIGEST,
  ConfigurationChangeIntentV1,
  ConfigurationConsumerId,
  ConfigurationKeyId,
  ConfigurationStoredStateV1,
  canonicalConfigurationInput,
  canonicalConfigurationJson,
  configurationDefinition,
  isConfigurationChangeIntentV1,
  isConfigurationKeyId,
} from '@aquaculture/configuration-contracts';
import { TenantErasureTombstoneError } from '@aquaculture/backend-common/compliance';
import { tenantManagerRepo, updateReturningRows } from '@aquaculture/backend-common/database';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, QueryRunner } from 'typeorm';

import { pinRlsTenantScope } from '../../database/rls-scoped-session';
import { SYSTEM_TENANT_ID } from '../configuration.constants';
import {
  ApplyConfigurationBatchInputV1,
  ConfigurationBatchReceiptV1,
  ConfigurationChangeReceiptEntryV1,
} from '../dto/configuration-snapshot.dto';
import {
  ConfigEnvironment,
  Configuration,
  ConfigurationHistory,
} from '../entities/configuration.entity';
import {
  ConfigurationChangeJournal,
  ConfigurationOperationReceipt,
  ConfigurationScope,
} from '../entities/configuration-operation.entity';
import { emitConfigurationChanged } from '../events/emit-configuration-changed';
import { ConfigurationSnapshotService } from './configuration-snapshot.service';
import { assertTenantConfigurationNotErased } from './configuration-erasure-fence';
import { EncryptionService } from './encryption.service';

interface AppliedChange {
  receipt: ConfigurationChangeReceiptEntryV1;
  eventRow: Configuration;
}

@Injectable()
export class ConfigurationBatchAuthorityService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly snapshotService: ConfigurationSnapshotService,
    private readonly encryptionService: EncryptionService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async apply(
    input: ApplyConfigurationBatchInputV1,
    tenantId: string,
    actorId: string,
    operatorSurfaceOnly: boolean,
  ): Promise<ConfigurationBatchReceiptV1> {
    this.assertInput(input, tenantId, operatorSurfaceOnly);
    const requestDigest = this.requestDigest(input, tenantId, actorId);
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      const pinScope = async (scopeTenantId: string): Promise<void> => {
        await pinRlsTenantScope(queryRunner, scopeTenantId);
      };
      await this.lockEffectiveScopes(queryRunner, pinScope, tenantId, input.environment);
      await pinScope(tenantId);
      const priorReceipt = await tenantManagerRepo(
        queryRunner.manager,
        ConfigurationOperationReceipt,
        tenantId,
      ).findOne({ where: { operationId: input.operationId, tenantId } });
      if (priorReceipt) {
        if (priorReceipt.requestDigest !== requestDigest) {
          throw new ConflictException('operationId is already bound to a different request');
        }
        await queryRunner.commitTransaction();
        return this.replayReceipt(priorReceipt);
      }

      await assertTenantConfigurationNotErased(queryRunner, tenantId);
      const current = await this.snapshotService.buildSnapshot(
        queryRunner.manager,
        pinScope,
        tenantId,
        input.environment,
      );
      if (current.snapshotToken !== input.expectedSnapshotToken) {
        throw new ConflictException('configuration snapshot changed; refresh before applying');
      }

      await pinScope(tenantId);
      const applied: AppliedChange[] = [];
      for (const change of input.changes) {
        applied.push(
          await this.applyChange(
            queryRunner,
            input,
            tenantId,
            actorId,
            change.keyId,
            change.intent,
            change.value,
          ),
        );
      }
      const resultingScopeRevision = await this.advanceScopeRevision(
        queryRunner,
        tenantId,
        input.environment,
      );
      const resulting = await this.snapshotService.buildSnapshot(
        queryRunner.manager,
        pinScope,
        tenantId,
        input.environment,
      );
      if (resulting.scopeRevision !== resultingScopeRevision) {
        throw new Error('configuration scope revision projection drifted during batch');
      }

      const receipt: ConfigurationBatchReceiptV1 = {
        operationId: input.operationId,
        catalogDigest: CONFIGURATION_CATALOG_DIGEST,
        tenantId,
        environment: input.environment,
        previousSnapshotToken: current.snapshotToken,
        resultingSnapshotToken: resulting.snapshotToken,
        scopeRevision: resultingScopeRevision,
        changes: applied.map((entry) => entry.receipt),
        replayed: false,
      };
      await tenantManagerRepo(queryRunner.manager, ConfigurationOperationReceipt, tenantId).save({
        operationId: input.operationId,
        tenantId,
        environment: input.environment,
        requestDigest,
        catalogDigest: CONFIGURATION_CATALOG_DIGEST,
        previousSnapshotToken: current.snapshotToken,
        resultingSnapshotToken: resulting.snapshotToken,
        resultingScopeRevision,
        actorId,
        reason: input.reason,
        receiptPayload: this.receiptPayload(receipt.changes),
      });
      for (const entry of applied) {
        await emitConfigurationChanged(
          this.outboxPublisher,
          queryRunner.manager,
          entry.eventRow,
          actorId,
        );
      }

      await queryRunner.commitTransaction();
      return receipt;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof ForbiddenException ||
        error instanceof TenantErasureTombstoneError
      ) {
        throw error;
      }
      if (this.postgresCode(error) === '40001') {
        throw new ConflictException(
          'configuration serialization conflict; retry the same operationId',
        );
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private assertInput(
    input: ApplyConfigurationBatchInputV1,
    tenantId: string,
    operatorSurfaceOnly: boolean,
  ): void {
    if (input.catalogDigest !== CONFIGURATION_CATALOG_DIGEST) {
      throw new ConflictException('configuration catalog digest is stale');
    }
    const seen = new Set<ConfigurationKeyId>();
    for (const change of input.changes) {
      if (!isConfigurationKeyId(change.keyId)) {
        throw new BadRequestException(`unknown configuration catalog ID: ${change.keyId}`);
      }
      if (seen.has(change.keyId)) {
        throw new BadRequestException(`duplicate configuration change: ${change.keyId}`);
      }
      seen.add(change.keyId);
      const definition = configurationDefinition(change.keyId);
      if (
        operatorSurfaceOnly &&
        !definition.consumers.includes(ConfigurationConsumerId.ADMIN_PANEL_CONFIGURATION)
      ) {
        throw new ForbiddenException(
          `${change.keyId} is not on the operator configuration surface`,
        );
      }
      if (!definition.mutable) {
        throw new ForbiddenException(`${change.keyId} is catalog-immutable`);
      }
      if (tenantId !== SYSTEM_TENANT_ID && definition.scopePolicy === 'SYSTEM_ONLY') {
        throw new ForbiddenException(`${change.keyId} cannot be overridden by a tenant`);
      }
      if (
        tenantId === SYSTEM_TENANT_ID &&
        (change.intent === ConfigurationChangeIntentV1.SUPPRESS_FALLBACK ||
          (change.intent === ConfigurationChangeIntentV1.CLEAR_OVERRIDE && definition.required))
      ) {
        throw new BadRequestException(
          'system scope cannot suppress fallback or clear a required configuration',
        );
      }
      if (change.intent === ConfigurationChangeIntentV1.SET && change.value === undefined) {
        throw new BadRequestException(`${change.keyId} SET requires value`);
      }
      if (change.intent !== ConfigurationChangeIntentV1.SET && change.value !== undefined) {
        throw new BadRequestException(`${change.keyId} ${change.intent} cannot carry value`);
      }
      if (change.value !== undefined) canonicalConfigurationInput(definition, change.value);
    }
  }

  private async lockEffectiveScopes(
    queryRunner: QueryRunner,
    pinScope: (tenantId: string) => Promise<void>,
    tenantId: string,
    environment: ConfigEnvironment,
  ): Promise<void> {
    const ordered =
      tenantId === SYSTEM_TENANT_ID ? [SYSTEM_TENANT_ID] : [SYSTEM_TENANT_ID, tenantId];
    for (const scopeTenantId of ordered) {
      await pinScope(scopeTenantId);
      await queryRunner.query(
        `INSERT INTO "config"."configuration_scopes" ("tenant_id", "environment", "revision")
         VALUES ($1, $2, 0) ON CONFLICT ("tenant_id", "environment") DO NOTHING`,
        [scopeTenantId, environment],
      );
      await queryRunner.query(
        `SELECT "revision" FROM "config"."configuration_scopes"
          WHERE "tenant_id" = $1 AND "environment" = $2 FOR UPDATE`,
        [scopeTenantId, environment],
      );
    }
  }

  private async applyChange(
    queryRunner: QueryRunner,
    input: ApplyConfigurationBatchInputV1,
    tenantId: string,
    actorId: string,
    keyId: ConfigurationKeyId,
    intent: ConfigurationChangeIntentV1,
    inputValue: string | undefined,
  ): Promise<AppliedChange> {
    const definition = configurationDefinition(keyId);
    const repository = tenantManagerRepo(queryRunner.manager, Configuration, tenantId);
    const existing = await repository.findOne({
      where: { tenantId, catalogId: keyId, environment: input.environment },
    });
    const previousState = this.rowState(existing ?? null);
    const previousDigest = existing ? this.valueDigest(existing.value) : null;
    const previousVersion = existing?.version ?? null;
    const previousDisplayValue =
      definition.valueType === 'SECRET' ? '[REDACTED]' : (existing?.value ?? '[UNSET]');
    let saved: Configuration;
    let newState: ConfigurationStoredStateV1;
    let newDigest: string | null;

    if (intent === ConfigurationChangeIntentV1.SET) {
      const canonical = canonicalConfigurationInput(definition, inputValue ?? '');
      if (definition.valueType === 'SECRET' && !this.encryptionService.isAvailable()) {
        throw new ConflictException('secret configuration writes require CONFIG_ENCRYPTION_KEY');
      }
      const stored =
        definition.valueType === 'SECRET'
          ? this.encryptionService.encrypt(canonical, tenantId, keyId)
          : canonical;
      saved = await repository.save(
        repository.create({
          ...(existing ?? {}),
          tenantId,
          catalogId: keyId,
          environment: input.environment,
          value: stored,
          isActive: true,
          suppressFallback: false,
          deletedAt: null,
          deletedBy: null,
          deleteReason: null,
          retentionUntil: null,
          createdBy: existing?.createdBy ?? actorId,
          updatedBy: actorId,
        }),
      );
      newState =
        definition.valueType === 'SECRET'
          ? ConfigurationStoredStateV1.ACTIVE_SECRET
          : ConfigurationStoredStateV1.ACTIVE_VALUE;
      newDigest = this.valueDigest(saved.value);
    } else if (intent === ConfigurationChangeIntentV1.SUPPRESS_FALLBACK) {
      saved = await repository.save(
        repository.create({
          ...(existing ?? {}),
          tenantId,
          catalogId: keyId,
          environment: input.environment,
          value: existing?.value ?? '',
          isActive: false,
          suppressFallback: true,
          deletedAt: new Date(),
          deletedBy: actorId,
          deleteReason: input.reason,
          createdBy: existing?.createdBy ?? actorId,
          updatedBy: actorId,
        }),
      );
      newState = ConfigurationStoredStateV1.FALLBACK_SUPPRESSED;
      newDigest = null;
    } else {
      if (!existing) {
        throw new BadRequestException(`${keyId} has no tenant override to clear`);
      }
      existing.isActive = false;
      existing.suppressFallback = false;
      existing.deletedAt = new Date();
      existing.deletedBy = actorId;
      existing.deleteReason = input.reason;
      existing.value = '';
      existing.updatedBy = actorId;
      saved = await repository.save(existing);
      newState = ConfigurationStoredStateV1.INACTIVE_OVERRIDE;
      newDigest = null;
    }

    const displayNew =
      intent === ConfigurationChangeIntentV1.SET
        ? definition.valueType === 'SECRET'
          ? '[REDACTED]'
          : (inputValue ?? '')
        : `[${intent}]`;
    await tenantManagerRepo(queryRunner.manager, ConfigurationHistory, tenantId).save({
      configurationId: saved.id,
      operationId: input.operationId,
      tenantId,
      catalogId: keyId,
      previousValue: previousDisplayValue,
      newValue: displayNew,
      changedBy: actorId,
      changedAt: new Date(),
      changeReason: input.reason,
    });
    await tenantManagerRepo(queryRunner.manager, ConfigurationChangeJournal, tenantId).save({
      operationId: input.operationId,
      tenantId,
      catalogId: keyId,
      intent,
      previousState,
      newState,
      previousValueDigest: previousDigest,
      newValueDigest: newDigest,
      previousVersion,
      newVersion: saved.version,
      actorId,
    });
    return { receipt: { keyId, intent, version: saved.version }, eventRow: saved };
  }

  private async advanceScopeRevision(
    queryRunner: QueryRunner,
    tenantId: string,
    environment: ConfigEnvironment,
  ): Promise<string> {
    const raw: unknown = await queryRunner.query(
      `UPDATE "config"."configuration_scopes"
          SET "revision" = "revision" + 1, "updated_at" = now()
        WHERE "tenant_id" = $1 AND "environment" = $2
        RETURNING "revision"::text`,
      [tenantId, environment],
    );
    const rows = updateReturningRows<{ revision: string }>(raw);
    const revision = rows[0]?.revision;
    if (revision === undefined) throw new Error('configuration scope lock disappeared');
    return revision;
  }

  private rowState(row: Configuration | null): ConfigurationStoredStateV1 {
    if (!row) return ConfigurationStoredStateV1.ABSENT;
    if (!row.isActive && row.suppressFallback) {
      return ConfigurationStoredStateV1.FALLBACK_SUPPRESSED;
    }
    if (!row.isActive) return ConfigurationStoredStateV1.INACTIVE_OVERRIDE;
    return configurationDefinition(row.catalogId).valueType === 'SECRET'
      ? ConfigurationStoredStateV1.ACTIVE_SECRET
      : ConfigurationStoredStateV1.ACTIVE_VALUE;
  }

  private valueDigest(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  private requestDigest(
    input: ApplyConfigurationBatchInputV1,
    tenantId: string,
    actorId: string,
  ): string {
    return createHash('sha256')
      .update(
        canonicalConfigurationJson({
          operationId: input.operationId,
          tenantId,
          actorId,
          environment: input.environment,
          catalogDigest: input.catalogDigest,
          expectedSnapshotToken: input.expectedSnapshotToken,
          reason: input.reason,
          changes: input.changes.map((change) => ({
            keyId: change.keyId,
            intent: change.intent,
            value: change.value ?? null,
          })),
        }),
        'utf8',
      )
      .digest('hex');
  }

  private receiptPayload(
    changes: readonly ConfigurationChangeReceiptEntryV1[],
  ): Record<string, unknown> {
    return {
      changes: changes.map((change) => ({
        keyId: change.keyId,
        intent: change.intent,
        version: change.version,
      })),
    };
  }

  private replayReceipt(receipt: ConfigurationOperationReceipt): ConfigurationBatchReceiptV1 {
    const payload = receipt.receiptPayload;
    const rawChanges = payload['changes'];
    if (!Array.isArray(rawChanges)) throw new Error('configuration receipt payload is corrupt');
    const changes = rawChanges.map((raw): ConfigurationChangeReceiptEntryV1 => {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error('configuration receipt change is corrupt');
      }
      const keyId = raw['keyId'];
      const intent = raw['intent'];
      const version = raw['version'];
      if (
        typeof keyId !== 'string' ||
        !isConfigurationKeyId(keyId) ||
        typeof intent !== 'string' ||
        !isConfigurationChangeIntentV1(intent) ||
        (version !== null && typeof version !== 'number')
      ) {
        throw new Error('configuration receipt change is corrupt');
      }
      return {
        keyId,
        intent,
        version,
      };
    });
    return {
      operationId: receipt.operationId,
      catalogDigest: receipt.catalogDigest,
      tenantId: receipt.tenantId,
      environment: receipt.environment,
      previousSnapshotToken: receipt.previousSnapshotToken,
      resultingSnapshotToken: receipt.resultingSnapshotToken,
      scopeRevision: receipt.resultingScopeRevision,
      changes,
      replayed: true,
    };
  }

  private postgresCode(error: unknown): string | null {
    if (typeof error !== 'object' || error === null || !('code' in error)) return null;
    return typeof error.code === 'string' ? error.code : null;
  }
}
