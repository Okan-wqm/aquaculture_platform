import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * SENSOR-CRITICAL-007 / SENSOR-CRITICAL-009 terminal regression guard — VFD I/O
 * is edge-only, and the fake in-process adapters are GONE.
 *
 * The `vfd/adapters/` module (Model A) built protocol frames and returned
 * `success:true` without ever reaching a drive — fake writes, fake reads, fake
 * connection tests. Slices 3–6 moved every drive WRITE onto the edge primitives;
 * Faz 4 moved telemetry reads onto the edge; Faz 2C moved the connection test onto
 * the edge and re-homed per-protocol config into the `protocol-config` SSoT. With
 * the last consumer rewired, `vfd/adapters/` was deleted outright.
 *
 * This guard pins that terminal state so a refactor cannot resurrect an
 * in-process drive path: the adapter directory must not exist, the fake-adapter
 * factory must appear nowhere, and no VFD code may import a `/adapters` module.
 */
const SRC_ROOT = join(__dirname, '..', '..', '..'); // apps/sensor-service/src
const VFD_ROOT = join(SRC_ROOT, 'vfd');
const SCAN_ROOTS = [VFD_ROOT, join(SRC_ROOT, 'vfd-programming')];

// Services on the drive-WRITE / control path — must never touch a fake adapter.
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
      if (entry === '__tests__') continue;
      out.push(...walkTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('VFD I/O is edge-only (SENSOR-CRITICAL-007/009 terminal guard)', () => {
  it('the fake vfd/adapters/ module no longer exists', () => {
    expect(existsSync(join(VFD_ROOT, 'adapters'))).toBe(false);
  });

  it('createVfdAdapter (the fake-adapter factory) appears nowhere in vfd/ or vfd-programming/', () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of walkTsFiles(root)) {
        if (readFileSync(file, 'utf8').includes('createVfdAdapter(')) {
          offenders.push(relative(SRC_ROOT, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no VFD source imports a /adapters module', () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of walkTsFiles(root)) {
        if (ADAPTER_IMPORT.test(readFileSync(file, 'utf8'))) {
          offenders.push(relative(SRC_ROOT, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it.each(WRITE_PATH_SERVICES)('%s neither imports nor instantiates a fake adapter', (rel) => {
    const src = readFileSync(join(SRC_ROOT, rel), 'utf8');
    expect(src.includes('createVfdAdapter')).toBe(false);
    expect(ADAPTER_IMPORT.test(src)).toBe(false);
  });
});
