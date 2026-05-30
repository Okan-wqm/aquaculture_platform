export interface DbMigrateAuthorityEnv {
  readonly DB_MIGRATE_AUTHORITATIVE?: string;
  readonly NODE_ENV?: string;
  readonly AQUA_ENV?: string;
  readonly [key: string]: string | undefined;
}

export interface DbMigrateAuthorityConfigReader {
  get<T = string>(key: string, defaultValue?: T): T | undefined;
}

export interface RuntimeDdlAssertionOptions {
  serviceName: string;
  operation: string;
  env?: DbMigrateAuthorityEnv;
}

function parseExplicitAuthoritative(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;

  throw new Error(
    `DB_MIGRATE_AUTHORITATIVE must be either "true" or "false"; received "${value}".`,
  );
}

export function resolveDbMigrateAuthoritative(env: DbMigrateAuthorityEnv = process.env): boolean {
  const explicit = parseExplicitAuthoritative(env.DB_MIGRATE_AUTHORITATIVE);
  if (explicit !== undefined) {
    return explicit;
  }

  const nodeEnv = env.NODE_ENV ?? 'development';
  const aquaEnv = env.AQUA_ENV ?? nodeEnv;
  return nodeEnv === 'production' || aquaEnv === 'production' || aquaEnv === 'staging';
}

export function resolveDbMigrateAuthoritativeFromConfig(
  configService: DbMigrateAuthorityConfigReader,
): boolean {
  return resolveDbMigrateAuthoritative({
    DB_MIGRATE_AUTHORITATIVE: configService.get<string>('DB_MIGRATE_AUTHORITATIVE'),
    NODE_ENV: configService.get<string>('NODE_ENV', process.env.NODE_ENV ?? 'development'),
    AQUA_ENV: configService.get<string>(
      'AQUA_ENV',
      configService.get<string>('NODE_ENV', process.env.NODE_ENV ?? 'development'),
    ),
  });
}

export function assertRuntimeDdlAllowed({
  serviceName,
  operation,
  env = process.env,
}: RuntimeDdlAssertionOptions): void {
  if (!resolveDbMigrateAuthoritative(env)) {
    return;
  }

  throw new Error(
    `SECURITY: Runtime DDL operation "${operation}" is not allowed for ` +
      `"${serviceName}" when DB_MIGRATE_AUTHORITATIVE=true. ` +
      `aqua-db-migrate is the schema SOT; move this DDL into migrations or ` +
      `SCHEMA_REGISTRY.postMigrationHardening.`,
  );
}
