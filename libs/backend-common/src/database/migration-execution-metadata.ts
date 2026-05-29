import type { MigrationInterface } from 'typeorm';

export interface MigrationExecutionMetadata {
  /**
   * When true, the migration may run only on the service source schema.
   * Tenant fan-out runners must record it in the tenant migration ledger
   * without executing its DDL.
   */
  readonly sourceOnly?: boolean;
}

type MigrationWithInstance = {
  readonly instance?: unknown;
};

type MigrationConstructorMetadata = {
  readonly sourceOnly?: boolean;
};

function hasSourceOnlyFlag(value: unknown): value is MigrationExecutionMetadata {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as MigrationExecutionMetadata).sourceOnly === true
  );
}

export function isSourceOnlyMigration(migration: MigrationWithInstance): boolean {
  const instance = migration.instance;
  if (hasSourceOnlyFlag(instance)) {
    return true;
  }

  if (
    typeof instance === 'object' &&
    instance !== null &&
    (instance as MigrationInterface).constructor !== undefined
  ) {
    const ctor = (instance as MigrationInterface).constructor as MigrationConstructorMetadata;
    return ctor.sourceOnly === true;
  }

  return false;
}
