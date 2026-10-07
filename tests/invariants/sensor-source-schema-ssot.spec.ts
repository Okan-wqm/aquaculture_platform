/**
 * Invariant (SENSOR-LOW-147): sensor-service names its source schema through
 * ONE constant, `SENSOR_SOURCE_SCHEMA` (libs/backend-common, derived from the
 * MODULE_SCHEMAS sensor entry), never a hand-written `'sensor'`.
 *
 * Every tenant boundary (runInTenantRead / runInTenantTransaction /
 * runInSourceRead and the binding assertions) takes the source schema as an
 * argument to pin `"tenant_<id>", sensor, public`. Two dozen call sites passed
 * it as a literal and four files kept a local `SENSOR_SCHEMA` copy — five
 * owners of one fact, each free to drift from the registry.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const BOUNDARY_CALL_WITH_LITERAL =
  /\b(?:runIn(?:Tenant|Source)(?:Read|Transaction)|bindTenantRlsContext|assertTenantRlsBound|assertTenantTransactionContext|pinTenantTransactionSearchPath|pinTenantSchemaTransactionSearchPath|assertSourceReadContext)\(\s*[\w.!]+,\s*'sensor'/;
const LOCAL_SCHEMA_CONSTANT = /\bconst\s+\w*SCHEMA\w*\s*=\s*'sensor'/;

function sensorServiceSources(): string[] {
  return execFileSync('git', ['ls-files', 'apps/sensor-service/src/**/*.ts'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => file.length > 0)
    .filter((file) => !/(\.spec|\.test)\.ts$|\/__tests__\//.test(file));
}

describe('sensor-service source schema has one owner (SENSOR-LOW-147)', () => {
  const sources = sensorServiceSources().map((file) => ({
    file,
    text: readFileSync(path.join(REPO_ROOT, file), 'utf8'),
  }));

  it('scans the service', () => {
    expect(sources.length).toBeGreaterThan(100);
  });

  it("no tenant boundary is handed a hand-written 'sensor'", () => {
    expect(
      sources.filter(({ text }) => BOUNDARY_CALL_WITH_LITERAL.test(text)).map(({ file }) => file),
    ).toEqual([]);
  });

  it("no file keeps its own copy of the 'sensor' schema name", () => {
    expect(
      sources.filter(({ text }) => LOCAL_SCHEMA_CONSTANT.test(text)).map(({ file }) => file),
    ).toEqual([]);
  });
});
