import { createHash } from 'node:crypto';

import {
  CONFIGURATION_CATALOG_DIGEST,
  CONFIGURATION_DEFINITIONS,
  ConfigurationConsumerId,
  ConfigurationKeyId,
  ConfigurationValueError,
  configurationDefinition,
  canonicalConfigurationJson,
  isConfigurationKeyId,
  parseCanonicalConfigurationValue,
} from '@aquaculture/configuration-contracts';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import { runInRlsScopedSnapshotRead } from '../../database/rls-scoped-session';
import { SYSTEM_TENANT_ID } from '../configuration.constants';
import {
  ConfigurationSnapshotEntryV1,
  ConfigurationSnapshotReadinessV1,
  ConfigurationSnapshotV1,
} from '../dto/configuration-snapshot.dto';
import { ConfigEnvironment, Configuration } from '../entities/configuration.entity';
import { ConfigurationScope } from '../entities/configuration-operation.entity';
import {
  ConfigurationSnapshotSourceV1,
  ConfigurationSnapshotStateV1,
} from '../generated/configuration-graphql.generated';

export type PinConfigurationScope = (tenantId: string) => Promise<void>;

const OPERATOR_DEFINITIONS = CONFIGURATION_DEFINITIONS.filter((definition) =>
  definition.consumers.includes(ConfigurationConsumerId.ADMIN_PANEL_CONFIGURATION),
);

interface ScopeRevisions {
  target: string;
  system: string;
}

@Injectable()
export class ConfigurationSnapshotService {
  constructor(private readonly dataSource: DataSource) {}

  async getSnapshot(
    tenantId: string,
    environment: ConfigEnvironment,
  ): Promise<ConfigurationSnapshotV1> {
    return runInRlsScopedSnapshotRead(
      this.dataSource,
      SYSTEM_TENANT_ID,
      async (manager, pinScope) => this.buildSnapshot(manager, pinScope, tenantId, environment),
    );
  }

  /** Build from an existing snapshot/serializable transaction for CAS. */
  async buildSnapshot(
    manager: EntityManager,
    pinScope: PinConfigurationScope,
    tenantId: string,
    environment: ConfigEnvironment,
  ): Promise<ConfigurationSnapshotV1> {
    await pinScope(SYSTEM_TENANT_ID);
    const systemRows = await tenantManagerRepo(manager, Configuration, SYSTEM_TENANT_ID).find({
      where: { environment },
    });
    const systemRevision = await this.scopeRevision(manager, SYSTEM_TENANT_ID, environment);

    let tenantRows: Configuration[] = [];
    let targetRevision = systemRevision;
    if (tenantId !== SYSTEM_TENANT_ID) {
      await pinScope(tenantId);
      tenantRows = await tenantManagerRepo(manager, Configuration, tenantId).find({
        where: { environment },
      });
      targetRevision = await this.scopeRevision(manager, tenantId, environment);
    }

    const catalogMismatches = [
      ...this.catalogMismatches(SYSTEM_TENANT_ID, systemRows),
      ...this.catalogMismatches(tenantId, tenantRows),
    ].sort();
    const rowsByScope = {
      system: new Map(
        systemRows
          .filter((row) => isConfigurationKeyId(row.catalogId))
          .map((row) => [row.catalogId, row]),
      ),
      tenant: new Map(
        tenantRows
          .filter((row) => isConfigurationKeyId(row.catalogId))
          .map((row) => [row.catalogId, row]),
      ),
    };
    const entries = OPERATOR_DEFINITIONS.map((definition) =>
      catalogMismatches.length === 0
        ? this.resolveEntry(tenantId, definition.id, rowsByScope)
        : this.catalogMismatchEntry(definition.id),
    );
    const missingRequiredKeys = entries
      .filter((entry) => entry.state === ConfigurationSnapshotStateV1.MISSING_REQUIRED)
      .map((entry) => entry.keyId);
    const invalidKeys = entries
      .filter((entry) => entry.state === ConfigurationSnapshotStateV1.INVALID)
      .map((entry) => entry.keyId);
    const revisions: ScopeRevisions = { target: targetRevision, system: systemRevision };
    return {
      catalogDigest: CONFIGURATION_CATALOG_DIGEST,
      tenantId,
      environment,
      scopeRevision: targetRevision,
      snapshotToken: this.snapshotToken(
        tenantId,
        environment,
        revisions,
        entries,
        catalogMismatches,
      ),
      readiness:
        missingRequiredKeys.length === 0 &&
        invalidKeys.length === 0 &&
        catalogMismatches.length === 0
          ? ConfigurationSnapshotReadinessV1.READY
          : ConfigurationSnapshotReadinessV1.RED,
      missingRequiredKeys,
      invalidKeys,
      catalogMismatches,
      entries,
    };
  }

  private async scopeRevision(
    manager: EntityManager,
    tenantId: string,
    environment: ConfigEnvironment,
  ): Promise<string> {
    const scope = await tenantManagerRepo(manager, ConfigurationScope, tenantId).findOne({
      where: { tenantId, environment },
    });
    return scope?.revision ?? '0';
  }

  private resolveEntry(
    requestedTenantId: string,
    keyId: ConfigurationKeyId,
    rows: {
      system: ReadonlyMap<ConfigurationKeyId, Configuration>;
      tenant: ReadonlyMap<ConfigurationKeyId, Configuration>;
    },
  ): ConfigurationSnapshotEntryV1 {
    const definition = configurationDefinition(keyId);
    const tenantRow = requestedTenantId === SYSTEM_TENANT_ID ? undefined : rows.tenant.get(keyId);
    const systemRow = rows.system.get(keyId);

    if (tenantRow?.isActive === false && tenantRow.suppressFallback) {
      return this.emptyEntry(
        keyId,
        definition.mutable,
        definition.required,
        definition.requiresRestart,
        true,
      );
    }
    const effective = tenantRow?.isActive ? tenantRow : systemRow?.isActive ? systemRow : undefined;
    if (!effective) {
      return this.emptyEntry(
        keyId,
        definition.mutable,
        definition.required,
        definition.requiresRestart,
        false,
      );
    }
    const secret = definition.valueType === 'SECRET';
    const source =
      effective.tenantId === SYSTEM_TENANT_ID
        ? ConfigurationSnapshotSourceV1.SYSTEM
        : ConfigurationSnapshotSourceV1.TENANT;
    if (!secret) {
      try {
        const value = parseCanonicalConfigurationValue(definition, effective.value);
        return {
          keyId,
          state: ConfigurationSnapshotStateV1.VALUE,
          source,
          value,
          sourceTenantId: effective.tenantId,
          effectiveVersion: `${effective.tenantId}:${effective.version}`,
          mutable: definition.mutable,
          required: definition.required,
          requiresRestart: definition.requiresRestart,
          fallbackSuppressed: false,
        };
      } catch (error) {
        if (!(error instanceof ConfigurationValueError)) throw error;
        return {
          keyId,
          state: ConfigurationSnapshotStateV1.INVALID,
          source,
          value: null,
          sourceTenantId: effective.tenantId,
          effectiveVersion: `${effective.tenantId}:${effective.version}`,
          mutable: definition.mutable,
          required: definition.required,
          requiresRestart: definition.requiresRestart,
          fallbackSuppressed: false,
        };
      }
    }
    return {
      keyId,
      state: ConfigurationSnapshotStateV1.SECRET_SET,
      source,
      value: null,
      sourceTenantId: effective.tenantId,
      effectiveVersion: `${effective.tenantId}:${effective.version}`,
      mutable: definition.mutable,
      required: definition.required,
      requiresRestart: definition.requiresRestart,
      fallbackSuppressed: false,
    };
  }

  private emptyEntry(
    keyId: ConfigurationKeyId,
    mutable: boolean,
    required: boolean,
    requiresRestart: boolean,
    fallbackSuppressed: boolean,
  ): ConfigurationSnapshotEntryV1 {
    return {
      keyId,
      state: required
        ? ConfigurationSnapshotStateV1.MISSING_REQUIRED
        : ConfigurationSnapshotStateV1.OPTIONAL_ABSENT,
      source: ConfigurationSnapshotSourceV1.NONE,
      value: null,
      sourceTenantId: null,
      effectiveVersion: null,
      mutable,
      required,
      requiresRestart,
      fallbackSuppressed,
    };
  }

  private catalogMismatchEntry(keyId: ConfigurationKeyId): ConfigurationSnapshotEntryV1 {
    const definition = configurationDefinition(keyId);
    return {
      keyId,
      state: ConfigurationSnapshotStateV1.CATALOG_MISMATCH,
      source: ConfigurationSnapshotSourceV1.NONE,
      value: null,
      sourceTenantId: null,
      effectiveVersion: null,
      mutable: definition.mutable,
      required: definition.required,
      requiresRestart: definition.requiresRestart,
      fallbackSuppressed: false,
    };
  }

  private catalogMismatches(scopeTenantId: string, rows: readonly Configuration[]): string[] {
    return [
      ...new Set(
        rows
          .map((row) => String(row.catalogId))
          .filter((catalogId) => !isConfigurationKeyId(catalogId))
          .map((catalogId) => `${scopeTenantId}:${catalogId}`),
      ),
    ];
  }

  private snapshotToken(
    tenantId: string,
    environment: ConfigEnvironment,
    revisions: ScopeRevisions,
    entries: readonly ConfigurationSnapshotEntryV1[],
    catalogMismatches: readonly string[],
  ): string {
    const tokenInput = {
      catalogDigest: CONFIGURATION_CATALOG_DIGEST,
      tenantId,
      environment,
      revisions,
      catalogMismatches,
      entries: entries.map((entry) => ({
        keyId: entry.keyId,
        state: entry.state,
        source: entry.source,
        effectiveVersion: entry.effectiveVersion,
        fallbackSuppressed: entry.fallbackSuppressed,
      })),
    };
    return createHash('sha256')
      .update(canonicalConfigurationJson(tokenInput), 'utf8')
      .digest('hex');
  }
}
