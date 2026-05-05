import * as crypto from 'crypto';

const FARM_E2E_DATABASE_ENV = [
  'FARM_E2E_DATABASE_HOST',
  'FARM_E2E_DATABASE_USER',
  'FARM_E2E_DATABASE_PASSWORD',
  'FARM_E2E_DATABASE_NAME',
] as const;

process.env['NODE_ENV'] = process.env['NODE_ENV'] ?? 'test';
process.env['THROTTLE_ENABLED'] = process.env['THROTTLE_ENABLED'] ?? 'false';
process.env['MCP_ENABLED'] = process.env['MCP_ENABLED'] ?? 'false';
process.env['DATABASE_SSL'] = process.env['DATABASE_SSL'] ?? 'false';
process.env['INTERNAL_SERVICE_SECRET'] =
  process.env['INTERNAL_SERVICE_SECRET'] ?? 'farm-e2e-internal-service-secret';
// WHAT: Farm E2E boots the real AppModule, so schema migrations must run
// before the strict SourceSchemaBootstrapService verifies the source schema.
// WHY: disabling migrations would either force a runtime synchronize fallback
// or fail on missing tables; the enterprise contract is "migrations own DDL".
process.env['DATABASE_MIGRATIONS_RUN'] =
  process.env['DATABASE_MIGRATIONS_RUN'] ?? 'true';
// WHAT: The dev-only sample seed depends on platform admin tables (`tenants`,
// `modules`) that are outside farm-service ownership.
// WHY: E2E cases create their own domain rows through GraphQL; letting a
// cross-service demo seed run here makes the farm contract depend on public
// admin schema state and hides the real test signal.
process.env['FARM_SEED_ENABLED'] = process.env['FARM_SEED_ENABLED'] ?? 'false';

if (process.env['FARM_E2E_DATABASE_HOST']) {
  process.env['DATABASE_HOST'] = process.env['FARM_E2E_DATABASE_HOST'];
}

if (process.env['FARM_E2E_DATABASE_PORT']) {
  process.env['DATABASE_PORT'] = process.env['FARM_E2E_DATABASE_PORT'];
}

if (process.env['FARM_E2E_DATABASE_USER']) {
  process.env['DATABASE_USER'] = process.env['FARM_E2E_DATABASE_USER'];
}

if (process.env['FARM_E2E_DATABASE_PASSWORD']) {
  process.env['DATABASE_PASSWORD'] = process.env['FARM_E2E_DATABASE_PASSWORD'];
}

if (process.env['FARM_E2E_DATABASE_NAME']) {
  process.env['DATABASE_NAME'] = process.env['FARM_E2E_DATABASE_NAME'];
}

const { publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

process.env['JWT_PUBLIC_KEY'] = publicKey;
delete process.env['JWT_PUBLIC_KEY_PATH'];

export function assertFarmE2eDatabaseEnvironment(): void {
  const missing = FARM_E2E_DATABASE_ENV.filter(
    (key) => !process.env[key]?.trim(),
  );

  if (missing.length > 0) {
    throw new Error(
      [
        'Farm E2E requires a real Postgres database and explicit FARM_E2E_DATABASE_* variables.',
        `Missing: ${missing.join(', ')}`,
        'Required: FARM_E2E_DATABASE_HOST, FARM_E2E_DATABASE_USER, FARM_E2E_DATABASE_PASSWORD, FARM_E2E_DATABASE_NAME.',
        'Optional: FARM_E2E_DATABASE_PORT, DATABASE_SSL=false for local Docker Postgres.',
      ].join(' '),
    );
  }
}
