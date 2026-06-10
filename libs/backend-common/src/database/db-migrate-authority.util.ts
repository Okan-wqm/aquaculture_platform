export function isSchemaDdlOwnedByDbMigrate(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env['DB_MIGRATE_AUTHORITATIVE'];
  if (explicit === 'true') {
    return true;
  }
  if (explicit === 'false') {
    return false;
  }

  const nodeEnv = env['NODE_ENV'] ?? 'development';
  const aquaEnv = env['AQUA_ENV'] ?? nodeEnv;

  return nodeEnv === 'production' || aquaEnv === 'production' || aquaEnv === 'staging';
}

export function hasDbMigrateDdlAuthority(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['DB_MIGRATE_DDL_AUTHORITY'] === '1';
}
