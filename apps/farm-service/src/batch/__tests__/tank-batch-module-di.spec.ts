import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * DI-wiring guard for the TankBatchService SSoT writer (ORPHAN-HIGH-275).
 *
 * #784 added TankBatchService to the create/delete-harvest handler constructors,
 * but HarvestModule did not import the module that provides it. farm-service then
 * crash-looped at boot — "Nest can't resolve dependencies of the
 * CreateHarvestRecordHandler (... TankBatchService at index [11] is available in
 * the HarvestModule)" — and every deploy rolled back at the boot-signal gate.
 *
 * The handler UNIT specs passed because they construct the handler DIRECTLY with
 * a mocked TankBatchService; nothing checked the module DI graph. This static
 * invariant does, without a fragile full-module compile — any farm module that
 * registers a handler/service injecting TankBatchService MUST import
 * TankBatchModule (the single provider of the SSoT writer). Missing that import
 * is precisely the crash-loop — now caught at CI time instead of a deploy-time
 * rollback, and impossible to reintroduce for any future consumer.
 */
const FARM_SRC = join(__dirname, '..', '..');

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTs(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const ALL_TS = walkTs(FARM_SRC);
// A consumer INJECTS TankBatchService (constructor param type annotation). The
// service's own file declares `export class TankBatchService` (not `: TankBatchService`),
// so the annotation regex selects only the injecting handlers/services.
const INJECTS = /:\s*TankBatchService\b/;
const EXPORT_CLASS = /export class (\w+)/;

const consumers = ALL_TS
  .filter((f) => !f.endsWith('.module.ts') && !f.endsWith('.spec.ts'))
  .map((f) => ({ file: f, src: readFileSync(f, 'utf-8') }))
  .filter(({ src }) => INJECTS.test(src))
  .map(({ file, src }) => ({ file, className: src.match(EXPORT_CLASS)?.[1] }))
  .filter((c): c is { file: string; className: string } => Boolean(c.className));

const moduleFiles = ALL_TS.filter((f) => f.endsWith('.module.ts'));

describe('TankBatchService module wiring (ORPHAN-HIGH-275)', () => {
  it('detects the known TankBatchService consumers (harvest + batch handlers)', () => {
    const names = consumers.map((c) => c.className);
    // The two handlers whose missing wiring crash-looped farm-service, plus the
    // batch-side consumers that always worked — the guard must see them all.
    expect(names).toEqual(
      expect.arrayContaining([
        'CreateHarvestRecordHandler',
        'DeleteHarvestRecordHandler',
        'RecordMortalityHandler',
        'TransferBatchHandler',
      ]),
    );
  });

  it('every module registering a TankBatchService consumer imports TankBatchModule', () => {
    const offenders: string[] = [];
    for (const mod of moduleFiles) {
      if (mod.endsWith('tank-batch.module.ts')) continue; // the provider module itself
      const src = readFileSync(mod, 'utf-8');
      const registered = consumers.filter((c) => src.includes(c.className));
      if (registered.length === 0) continue;
      if (!/\bTankBatchModule\b/.test(src)) {
        offenders.push(
          `${mod.slice(FARM_SRC.length + 1)} registers [${registered
            .map((c) => c.className)
            .join(', ')}] but does not import TankBatchModule`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});
