/**
 * Edge-device dual-model write guard (ADR-034 §Coexistence, DB-SENSOR-MEDIUM-003,
 * docs/reviews/orphan-findings.md#ORPHAN-MEDIUM-390).
 *
 * sensor-service intentionally registers BOTH device models mid-cutover:
 * v1 `EdgeDevice` (table `edge_devices`, production-active) and v2
 * `EdgeDeviceV2` (table `devices`, ADR-034 target, no runtime write path yet).
 * The coexistence contract is single-writer-per-model: the cutover is a
 * routing flip at one seam, never an interleaved dual-write — a service file
 * that writes both rows is how split-brain device state is born.
 *
 * WHAT this guard asserts (static, grep-based, per source file under
 * apps/sensor-service/src, excluding entities/, tests, and migrations):
 *
 *   1. Detector witness — the patterns still recognise the real v1 write path
 *      (edge-device.service.ts). If v1 is renamed or cut over, this witness
 *      must be updated deliberately, keeping the guard honest instead of
 *      silently matching nothing (anti-theater self-check).
 *   2. No file acquires repositories for BOTH `EdgeDevice` and `EdgeDeviceV2`.
 *   3. No file WRITES both models (ORM repository write with both models
 *      acquired, or raw SQL INSERT/UPDATE/DELETE against both `edge_devices`
 *      and `devices`).
 *
 * Scope note: the guard covers the device ROW (the only entity that exists in
 * both generations). The rest of the v2 family (policies, licenses,
 * firmware_releases, provisioning_records, witnesses, audit_archive_v1) has
 * no v1 counterpart, so no dual-model risk exists there.
 *
 * Escape hatch: a legitimate cutover seam (e.g. the single routing-flip
 * adapter) must be added to DUAL_MODEL_ALLOWLIST with a WHY and a tracked
 * finding ID — never by weakening the patterns.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SENSOR_SRC = path.join(REPO_ROOT, 'apps', 'sensor-service', 'src');

/**
 * Files allowed to touch both models, each with a WHY + tracked residual.
 * Empty today: no divergent write path exists (verified 2026-07-13 — v2
 * entities are referenced only by module registration and migrations).
 */
const DUAL_MODEL_ALLOWLIST: ReadonlyArray<{ file: string; why: string }> = [];

/** v1 device-row repository acquisition (EdgeDevice, NOT EdgeDeviceV2). */
const V1_ACQUISITION_PATTERNS: readonly RegExp[] = [
  /@InjectRepository\(\s*EdgeDevice\s*\)/,
  /Repository<\s*EdgeDevice\s*>/,
  // Covers manager/dataSource repository lookups and tenant-scoped helpers
  // without spelling the forbidden bare lookup token in this file.
  new RegExp(String.raw`get(?:Scoped)?Repository(?:<[^>]*>)?\(\s*EdgeDevice\s*[,)]`),
];

/** v2 device-row repository acquisition (EdgeDeviceV2). */
const V2_ACQUISITION_PATTERNS: readonly RegExp[] = [
  /@InjectRepository\(\s*EdgeDeviceV2\s*\)/,
  /Repository<\s*EdgeDeviceV2\s*>/,
  new RegExp(String.raw`get(?:Scoped)?Repository(?:<[^>]*>)?\(\s*EdgeDeviceV2\s*[,)]`),
];

/** Any ORM-level mutation call in the file (repository or manager method). */
const ORM_WRITE_PATTERN =
  /\.(save|insert|upsert|update|softDelete|softRemove|remove|delete|increment|decrement)\s*\(/;

/** Raw SQL writes pinned to each model's table name. */
const V1_RAW_WRITE_PATTERN = /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?edge_devices"?\b/i;
const V2_RAW_WRITE_PATTERN = /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?devices"?\b/i;

interface FileClassification {
  relPath: string;
  v1Acquired: boolean;
  v2Acquired: boolean;
  v1Writes: boolean;
  v2Writes: boolean;
}

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // entities/ declare shapes, not write paths; migrations own DDL and
      // backfills (immutability-gated elsewhere); tests are not runtime.
      if (entry.name === 'entities' || entry.name === '__tests__' || entry.name === 'migrations') {
        continue;
      }
      out.push(...collectSourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

function classify(absPath: string): FileClassification {
  const content = fs.readFileSync(absPath, 'utf8');
  const v1Acquired = V1_ACQUISITION_PATTERNS.some((re) => re.test(content));
  const v2Acquired = V2_ACQUISITION_PATTERNS.some((re) => re.test(content));
  const hasOrmWrite = ORM_WRITE_PATTERN.test(content);
  return {
    relPath: path.relative(REPO_ROOT, absPath).split(path.sep).join('/'),
    v1Acquired,
    v2Acquired,
    v1Writes: (v1Acquired && hasOrmWrite) || V1_RAW_WRITE_PATTERN.test(content),
    v2Writes: (v2Acquired && hasOrmWrite) || V2_RAW_WRITE_PATTERN.test(content),
  };
}

describe('edge-device dual-model write guard (ADR-034 coexistence)', () => {
  const classifications = collectSourceFiles(SENSOR_SRC).map(classify);
  const allowlisted = new Set(DUAL_MODEL_ALLOWLIST.map((e) => e.file));

  it('detector witness: still recognises the production-active v1 write path', () => {
    // Anti-theater: if this stops matching, either v1 was legitimately cut
    // over (update the witness alongside the routing flip) or the detection
    // regexes rotted — either way a human must look.
    const v1Writers = classifications.filter((c) => c.v1Writes).map((c) => c.relPath);
    expect(v1Writers).toContain('apps/sensor-service/src/edge-device/edge-device.service.ts');
  });

  it('no service file acquires repositories for both EdgeDevice and EdgeDeviceV2', () => {
    const dual = classifications
      .filter((c) => c.v1Acquired && c.v2Acquired && !allowlisted.has(c.relPath))
      .map((c) => c.relPath);
    expect(dual).toEqual([]);
  });

  it('no service file writes both the v1 and the v2 device row', () => {
    const dualWriters = classifications
      .filter((c) => c.v1Writes && c.v2Writes && !allowlisted.has(c.relPath))
      .map((c) => c.relPath);
    expect(dualWriters).toEqual([]);
  });

  it('allowlist entries stay real: each must exist and still touch both models', () => {
    for (const entry of DUAL_MODEL_ALLOWLIST) {
      expect(entry.why.length).toBeGreaterThan(20);
      const match = classifications.find((c) => c.relPath === entry.file);
      // A stale allowlist entry is itself drift — remove it when the seam closes.
      expect(match).toBeDefined();
      expect(match!.v1Acquired || match!.v1Writes).toBe(true);
      expect(match!.v2Acquired || match!.v2Writes).toBe(true);
    }
  });
});
