import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * INVARIANT (SENSOR-MEDIUM-064): new Sensor rows have exactly one write owner —
 * SensorRegistrationService, reached through the registration/ resolver
 * (registerSensor / registerParentWithChildren). That path alone enforces the
 * per-plan maxSensors quota, protocol validation, the DRAFT→test→ACTIVE
 * lifecycle, and the SensorRegistered outbox events farm/alert consume.
 *
 * The audit found a second, divergent write path: SensorResolver.createSensor
 * (and its updateSensor sibling) inserted/updated a Sensor with status=ACTIVE
 * directly, bypassing every one of those invariants — an unused GraphQL back
 * door. It was deleted; registration/ is now the single write path.
 *
 * This invariant fails if that back door returns in any form:
 *   (A) a `createSensor` / `updateSensor` mutation reappears on ANY sensor
 *       resolver, or
 *   (B) any sensor-service GraphQL resolver writes the Sensor repository
 *       directly (persistence must live behind the registration service), or
 *   (C) the canonical registerSensor mutation goes missing from registration/.
 *
 * `updateSensorInfo` / `updateSensorProtocol` (registration path) and
 * `createSensorType` (custom-type catalog) are deliberately NOT matched — the
 * word-boundary anchors exclude them.
 */
const REPO_ROOT = resolve(__dirname, '..', '..');
const SENSOR_SRC = resolve(REPO_ROOT, 'apps', 'sensor-service', 'src');
const REGISTRATION_RESOLVER = resolve(
  SENSOR_SRC,
  'registration',
  'resolvers',
  'registration.resolver.ts',
);

/** The removed back-door mutation names, word-bounded so `updateSensorInfo`,
 *  `updateSensorProtocol` and `createSensorType` never trip the scan. */
const BACK_DOOR_MUTATION = /\b(?:createSensor|updateSensor)\b(?!Type|Info|Protocol)/;

/** Write verbs on the injected Sensor repository. Reads (find/findOne/count) are fine. */
const REPO_WRITE_VERBS = 'save|insert|upsert|update|remove|delete';

function resolverFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...resolverFilesUnder(full));
    } else if (entry.endsWith('.resolver.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Strip block + line comments so the deletion explainer never trips the scan. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const resolverFiles = resolverFilesUnder(SENSOR_SRC);

describe('INVARIANT: single sensor write path (SENSOR-MEDIUM-064)', () => {
  it('discovers the sensor-service resolvers (guards against an empty scan)', () => {
    expect(resolverFiles.length).toBeGreaterThan(0);
    expect(resolverFiles).toContain(REGISTRATION_RESOLVER);
  });

  it('no resolver declares a createSensor/updateSensor back-door mutation', () => {
    const offenders: string[] = [];
    for (const file of resolverFiles) {
      const code = stripComments(readFileSync(file, 'utf8'));
      if (BACK_DOOR_MUTATION.test(code)) {
        offenders.push(file.replace(`${REPO_ROOT}/`, ''));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no resolver writes the Sensor repository directly — persistence lives behind the registration service', () => {
    const offenders: string[] = [];
    for (const file of resolverFiles) {
      const code = stripComments(readFileSync(file, 'utf8'));
      // Bind the property name a resolver injects the Sensor repository into,
      // then flag any write verb applied to that exact property. `\(Sensor\)`
      // is literal so `@InjectRepository(SensorReading)` etc. never match.
      const inject = code.match(
        /@InjectRepository\(Sensor\)\s*(?:private|public|protected)?\s*(?:readonly\s+)?(\w+)\s*:/,
      );
      if (!inject) continue;
      const prop = inject[1];
      const write = new RegExp(`\\b${prop}\\.(?:${REPO_WRITE_VERBS})\\s*\\(`);
      if (write.test(code)) {
        offenders.push(`${file.replace(`${REPO_ROOT}/`, '')} (writes via ${prop})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the canonical registerSensor mutation exists on the registration resolver', () => {
    const code = readFileSync(REGISTRATION_RESOLVER, 'utf8');
    expect(code).toMatch(/name:\s*'registerSensor'/);
  });
});
