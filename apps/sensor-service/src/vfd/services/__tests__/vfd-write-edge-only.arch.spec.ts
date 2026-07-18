import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * SENSOR-CRITICAL-007 regression guard — VFD writes are edge-only.
 *
 * The fake in-process VFD adapters (`vfd/adapters/`, Model A) reported success
 * without ever reaching the drive. Slices 3–5 moved every drive WRITE onto the
 * edge primitives (VfdEdgeWriteService / VfdEdgeReadService); no cloud code opens
 * a socket to a drive anymore. `createVfdAdapter` — the fake-adapter factory —
 * now survives ONLY in two read/test paths whose edge-rewire is later-phase work
 * (connection-test → Faz 2C, telemetry → Faz 4 codec).
 *
 * This guard pins that state so a refactor cannot silently reintroduce a fake
 * in-process write: the write-path services must never touch the adapters, and
 * the adapter factory must stay confined to the allowlist below. The allowlist
 * MUST shrink to empty when the read/test paths are edge-delegated — at which
 * point `vfd/adapters/` can be deleted outright.
 */
const SRC_ROOT = join(__dirname, '..', '..', '..'); // apps/sensor-service/src
const SCAN_ROOTS = [join(SRC_ROOT, 'vfd'), join(SRC_ROOT, 'vfd-programming')];

// The ONLY files still allowed to reach for the fake adapter factory (read/test
// paths pending their edge-rewire). Shrink this to empty, then delete vfd/adapters/.
const ADAPTER_CONSUMER_ALLOWLIST = new Set([
  join('vfd', 'services', 'vfd-connection-tester.service.ts'),
  join('vfd', 'services', 'vfd-data-reader.service.ts'),
]);

// Services on the drive-WRITE / control path — must never touch the fake adapters.
const WRITE_PATH_SERVICES = [
  join('vfd', 'services', 'vfd-command.service.ts'),
  join('vfd-programming', 'services', 'vfd-parameter-writer.service.ts'),
  join('vfd-programming', 'services', 'vfd-change-set.service.ts'),
  join('vfd-programming', 'services', 'vfd-change-set-scheduler.service.ts'),
  join('vfd-programming', 'services', 'vfd-automation-rule.service.ts'),
];

const ADAPTER_IMPORT = /from ['"][^'"]*\/adapters['"]/;

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // The adapters directory itself is the thing being retired; its own tests
      // legitimately reference the factory.
      if (entry === '__tests__' || entry === 'adapters') continue;
      out.push(...walkTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('VFD writes are edge-only (SENSOR-CRITICAL-007 regression guard)', () => {
  it('createVfdAdapter is confined to the allowlisted read/test consumers', () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of walkTsFiles(root)) {
        if (!readFileSync(file, 'utf8').includes('createVfdAdapter(')) continue;
        const rel = relative(SRC_ROOT, file);
        if (!ADAPTER_CONSUMER_ALLOWLIST.has(rel)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it.each(WRITE_PATH_SERVICES)('%s neither imports nor instantiates the fake adapter', (rel) => {
    const src = readFileSync(join(SRC_ROOT, rel), 'utf8');
    expect(src.includes('createVfdAdapter')).toBe(false);
    expect(ADAPTER_IMPORT.test(src)).toBe(false);
  });

  it('every allowlisted adapter consumer still exists (no stale exemption)', () => {
    for (const rel of ADAPTER_CONSUMER_ALLOWLIST) {
      expect(statSync(join(SRC_ROOT, rel)).isFile()).toBe(true);
    }
  });
});
