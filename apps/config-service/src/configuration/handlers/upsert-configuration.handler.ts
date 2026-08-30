import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource, QueryRunner } from 'typeorm';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { TenantErasureTombstoneError } from '@aquaculture/backend-common/compliance';
import { OutboxPublisher } from '@platform/outbox';
import {
  CONFIG_RUNTIME_SYSTEM_TENANT_ID,
  MARINE_PROVIDER_CREDENTIAL_CUTOVER_ACTOR_ID,
  MARINE_PROVIDER_CREDENTIAL_KEYS,
  MARINE_PROVIDER_CREDENTIAL_SERVICE,
  parseMarineProviderCdseCredentialBundle,
} from '@platform/event-contracts';
import { pinRlsTenantScope } from '../../database/rls-scoped-session';
import { UpsertConfigurationCommand } from '../commands/upsert-configuration.command';
import {
  Configuration,
  ConfigurationHistory,
  ConfigEnvironment,
  ConfigValueType,
} from '../entities/configuration.entity';
import { emitConfigurationChanged } from '../events/emit-configuration-changed';
import { ConfigurationService } from '../services/configuration.service';
import { assertTenantConfigurationNotErased } from '../services/configuration-erasure-fence';
import { EncryptionService } from '../services/encryption.service';

/**
 * Columns overwritten when the (tenant, service, key, environment) row already
 * exists.
 *
 * WHY `value_type` is only overwritten for SECRET writes: the public
 * setConfiguration mutation carries no valueType argument, so a plain write
 * would otherwise downgrade a seeded `number`/`boolean`/`json` row to `string`
 * and every typed consumer of getTypedValue() would silently start receiving
 * raw strings. A non-secret upsert therefore preserves the stored type (the
 * value is still stored in its canonical string form), while a secret write
 * MUST stamp `secret` so redaction is enforced by type, not just by the
 * is_secret flag.
 */
export function resolveUpsertOverwriteColumns(isSecret: boolean): string[] {
  return [
    'value',
    ...(isSecret ? ['value_type'] : []),
    'is_secret',
    'updated_by',
    'updated_at',
    'is_active',
    'deleted_at',
    'deleted_by',
    'delete_reason',
    'retention_until',
    'suppress_fallback',
  ];
}

/**
 * PostgreSQL conflict clause used by the natural-key upsert.
 *
 * TypeORM's `orUpdate(overwriteColumns, ...)` copies every overwritten value
 * from `EXCLUDED`. That is unsafe for a `@VersionColumn`: including `version`
 * resets an existing row to the insert default, while omitting it leaves the
 * version unchanged. The version is part of the provider-credential cache
 * generation, so either behaviour can keep an already-issued access token
 * alive after credential rotation.
 *
 * Increment the persisted value in the database instead. This remains
 * monotonic even if a writer that does not use this handler races the upsert.
 */
export function resolvePostgresUpsertConflictClause(isSecret: boolean): string {
  const assignments = resolveUpsertOverwriteColumns(isSecret).map(
    (column) => `"${column}" = EXCLUDED."${column}"`,
  );
  assignments.push('"version" = "configurations"."version" + 1');

  return [
    '("tenant_id", "service", "key", "environment")',
    `DO UPDATE SET ${assignments.join(', ')}`,
  ].join(' ');
}

/**
 * Serialises same-key upserts so the before/after history record describes the
 * exact value replaced by this transaction. The value itself never enters the
 * lock material.
 */
export function resolveConfigurationUpsertLockKey(
  tenantId: string,
  service: string,
  key: string,
  environment: string,
): string {
  return JSON.stringify(['config-upsert-v1', tenantId, service, key, environment]);
}

export function isMarineProviderCredentialConfiguration(service: string, key: string): boolean {
  return (
    service === MARINE_PROVIDER_CREDENTIAL_SERVICE && key === MARINE_PROVIDER_CREDENTIAL_KEYS.CDSE
  );
}

/**
 * The company CDSE bundle is writable by the platform-admin SYSTEM path.
 * Tenant overrides are create-once migration artifacts and can only be
 * authored by the signed farm cutover boundary.
 */
export function assertMarineProviderCredentialWritePolicy(
  command: UpsertConfigurationCommand,
): void {
  if (!isMarineProviderCredentialConfiguration(command.service, command.key)) {
    return;
  }
  if (
    command.environment !== ConfigEnvironment.ALL ||
    command.isSecret !== true ||
    parseMarineProviderCdseCredentialBundle(command.value) === null
  ) {
    throw new BadRequestException(
      'Marine provider credentials require one complete secret bundle in the all environment',
    );
  }
  if (
    command.tenantId !== CONFIG_RUNTIME_SYSTEM_TENANT_ID &&
    command.userId !== MARINE_PROVIDER_CREDENTIAL_CUTOVER_ACTOR_ID
  ) {
    throw new ForbiddenException(
      'Tenant marine provider credentials are managed only by the one-shot cutover',
    );
  }
}

@Injectable()
@CommandHandler(UpsertConfigurationCommand)
export class UpsertConfigurationHandler
  implements ICommandHandler<UpsertConfigurationCommand, Configuration>
{
  private readonly logger = new Logger(UpsertConfigurationHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly configurationService: ConfigurationService,
    private readonly encryptionService: EncryptionService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: UpsertConfigurationCommand): Promise<Configuration> {
    assertMarineProviderCredentialWritePolicy(command);
    const { tenantId, service, key, value, environment, userId, isSecret } = command;
    const canonicalIsSecret = isSecret === true;
    if (canonicalIsSecret && !this.encryptionService.isAvailable()) {
      throw new InternalServerErrorException(
        'Secret configuration writes require CONFIG_ENCRYPTION_KEY',
      );
    }
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('READ COMMITTED');

    try {
      // config.configurations is behind a FORCE RLS policy keyed on the
      // app.current_tenant GUC. Pool-checkout pinning follows the HTTP request
      // context, which is EMPTY for a tenantless SUPER_ADMIN whose scope the
      // resolver resolved to SYSTEM_TENANT_ID — own the GUC transaction-locally
      // so RLS visibility always matches the command's resolved tenant scope.
      await pinRlsTenantScope(queryRunner, tenantId);
      await assertTenantConfigurationNotErased(queryRunner, tenantId);

      await queryRunner.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        resolveConfigurationUpsertLockKey(tenantId, service, key, environment),
      ]);

      const repo = tenantManagerRepo(queryRunner.manager, Configuration, tenantId);

      // Fetch existing config before upsert (for history tracking)
      const existingConfig = await repo.findOne({
        where: { tenantId, service, key, environment },
      });

      if (existingConfig && this.isIdempotentMarineCredentialCutover(existingConfig, command)) {
        await queryRunner.commitTransaction();
        this.logger.log(
          `Marine provider credential cutover already applied for tenant ${tenantId}`,
        );
        return existingConfig;
      }

      // Encrypt secret values before storing
      // PLAT-HIGH-003: Pass tenantId + key as AAD to bind ciphertext to context
      let valueToStore = value;
      if (canonicalIsSecret) {
        valueToStore = this.encryptionService.encrypt(value, tenantId, key);
      }

      // Atomic upsert using INSERT ... ON CONFLICT DO UPDATE
      await repo
        .createQueryBuilder()
        .insert()
        .into(Configuration)
        .values({
          tenantId,
          service,
          key,
          value: valueToStore,
          environment,
          valueType: canonicalIsSecret ? ConfigValueType.SECRET : ConfigValueType.STRING,
          isSecret: canonicalIsSecret,
          isActive: true,
          deletedAt: null,
          deletedBy: null,
          deleteReason: null,
          retentionUntil: null,
          suppressFallback: false,
          createdBy: userId,
          updatedBy: userId,
        })
        .onConflict(resolvePostgresUpsertConflictClause(canonicalIsSecret))
        .returning('*')
        .execute();

      // Fetch the full entity to return with proper type
      const saved = await repo.findOneOrFail({
        where: { tenantId, service, key, environment },
      });

      // Record history if value changed (update case, not insert)
      if (existingConfig && existingConfig.value !== valueToStore) {
        const historyRepo = tenantManagerRepo(queryRunner.manager, ConfigurationHistory, tenantId);

        // SECURITY: Redact secret values in history records
        const previousWasSecret =
          existingConfig.isSecret || existingConfig.valueType === ConfigValueType.SECRET;
        const newIsSecret = canonicalIsSecret;
        const previousDisplayValue = previousWasSecret ? '[REDACTED]' : existingConfig.value;
        const newDisplayValue = newIsSecret ? '[REDACTED]' : value;

        const history = historyRepo.create({
          configurationId: saved.id,
          tenantId,
          service,
          key,
          previousValue: previousDisplayValue,
          newValue: newDisplayValue,
          changedBy: userId || 'system',
          changedAt: new Date(),
          changeReason: command.reason || 'Upsert operation',
        });

        await historyRepo.save(history);

        this.logger.debug(`Configuration history recorded for upsert: ${service}/${key}`);
      }

      // Faz C (D6): enqueue a metadata-only ConfigurationChanged signal into the
      // config_outbox IN THE SAME TRANSACTION as the config write — atomic, so a
      // committed change always emits and a rolled-back one never does. Shared
      // emit path across create/update/delete/upsert (ARCH-MEDIUM-003). The event
      // NEVER carries the value/secret; a consumer (billing) uses it to
      // invalidate its cached snapshot and re-fetch on demand via GET_SECRET.
      await emitConfigurationChanged(this.outboxPublisher, queryRunner.manager, saved, userId);

      await queryRunner.commitTransaction();
      this.configurationService.invalidateCache(tenantId, service, key);

      this.logger.log(`Configuration upserted: ${service}/${key} for tenant ${tenantId}`);

      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`Failed to upsert configuration metadata for ${service}/${key}`);

      if (error instanceof TenantErasureTombstoneError) {
        throw error;
      }

      throw new InternalServerErrorException('Failed to upsert configuration');
    } finally {
      await queryRunner.release();
    }
  }

  private isIdempotentMarineCredentialCutover(
    existing: Configuration,
    command: UpsertConfigurationCommand,
  ): boolean {
    if (
      command.tenantId === CONFIG_RUNTIME_SYSTEM_TENANT_ID ||
      command.userId !== MARINE_PROVIDER_CREDENTIAL_CUTOVER_ACTOR_ID ||
      !isMarineProviderCredentialConfiguration(command.service, command.key)
    ) {
      return false;
    }
    if (
      !existing.isActive ||
      existing.deletedAt != null ||
      existing.isSecret !== true ||
      existing.valueType !== ConfigValueType.SECRET
    ) {
      throw new Error('Existing tenant marine credential is not an active secret bundle');
    }
    const existingBundle = this.encryptionService.decrypt(
      existing.value,
      command.tenantId,
      command.key,
    );
    if (existingBundle !== command.value) {
      throw new Error('One-shot tenant marine credential cannot be overwritten');
    }
    return true;
  }
}
