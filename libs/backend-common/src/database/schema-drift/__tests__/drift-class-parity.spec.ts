/**
 * CI invariant — every DriftClassId in the registry has:
 *   1. A detector wired inside SchemaDriftValidator (route('<classId>', ...))
 *   2. A matching primitive export from @aquaculture/backend-common
 *      (when DRIFT_CLASSES[id].primitive is non-null)
 *   3. The harness DriftClass union covers the same IDs (parity between
 *      production validator + migration-harness surface)
 *
 * This spec fails the build if any of those contracts drift — the
 * classic "add a class, forget to wire it in the validator" bug the
 * registry exists to catch.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { defined } from '@aquaculture/testing';

import { DRIFT_CLASSES, type DriftClassId } from '../drift-classes';

const VALIDATOR_SOURCE_PATH = join(__dirname, '..', '..', 'schema-drift-validator.service.ts');
const HARNESS_EXPECT_DRIFT_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'migration-harness',
  'src',
  'expect-no-drift.ts',
);

function extractClassIdsFromValidator(): Set<string> {
  const src = readFileSync(VALIDATOR_SOURCE_PATH, 'utf8');
  // Match: this.route('<classId>', ... ) — the helper the validator uses
  // to push into error/warning buckets. Captures the first string arg.
  const ids = new Set<string>();
  const re = /this\.route\(\s*'([a-z_]+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const id = m[1];
    if (id) ids.add(id);
  }
  return ids;
}

function extractClassIdsFromHarness(): Set<string> {
  const src = readFileSync(HARNESS_EXPECT_DRIFT_PATH, 'utf8');
  // Match the DriftClass union literal members — single-quoted string
  // between pipes and newlines in the `export type DriftClass =` block.
  // Extract the block first, then tokenize.
  const blockMatch = src.match(/export type DriftClass\s*=([^;]+);/);
  if (!blockMatch) return new Set();
  const ids = new Set<string>();
  const re = /'([a-z_]+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(defined(blockMatch[1]))) !== null) {
    const id = m[1];
    if (id) ids.add(id);
  }
  return ids;
}

describe('drift-class parity — registry ↔ validator ↔ primitive ↔ harness', () => {
  it('every DriftClassId in the registry has a detector in SchemaDriftValidator', () => {
    const wiredInValidator = extractClassIdsFromValidator();
    const missing: DriftClassId[] = [];
    for (const id of Object.keys(DRIFT_CLASSES) as DriftClassId[]) {
      // Classes with primitive=null AND severity=error but no detector
      // are refusal-only classes that are not expected to be wired in
      // the validator directly — Class H (data_cast_incompatible) is
      // flagged by Phase 3.5 primitives at DDL time, not at boot.
      // Every other class MUST have a boot-time detector.
      if (id === 'data_cast_incompatible') continue;
      if (!wiredInValidator.has(id)) missing.push(id);
    }
    expect(missing).toEqual([]);
  });

  it('validator does not use any class IDs that are not in the registry', () => {
    const wiredInValidator = extractClassIdsFromValidator();
    const known = new Set(Object.keys(DRIFT_CLASSES));
    const unknown = Array.from(wiredInValidator).filter((id) => !known.has(id));
    expect(unknown).toEqual([]);
  });

  it('every non-null primitive name is exported from @aquaculture/backend-common', async () => {
    const backendCommon = await import('../../../index');
    const exported = new Set(Object.keys(backendCommon));

    const missing: Array<{ id: DriftClassId; primitive: string }> = [];
    for (const spec of Object.values(DRIFT_CLASSES)) {
      if (spec.primitive === null) continue;
      // Phase 3 complete — every non-null primitive MUST be exported.
      // The previous Phase 3 allowlist bypass has been removed; any
      // class that declares a primitive name must actually export it
      // from @aquaculture/backend-common.
      if (!exported.has(spec.primitive)) {
        missing.push({ id: spec.id, primitive: spec.primitive });
      }
    }
    expect(missing).toEqual([]);
  });

  it('refusal classes (H, I, J) keep primitive=null (they are NOT auto-healed)', () => {
    expect(DRIFT_CLASSES.data_cast_incompatible.primitive).toBeNull();
    expect(DRIFT_CLASSES.per_tenant_shape_divergence.primitive).toBeNull();
    expect(DRIFT_CLASSES.encrypted_column_protection.primitive).toBeNull();
  });

  it('migration-harness DriftClass union covers every registry ID (minus H)', () => {
    const harnessIds = extractClassIdsFromHarness();
    const missingInHarness: DriftClassId[] = [];
    for (const id of Object.keys(DRIFT_CLASSES) as DriftClassId[]) {
      // Class H (data_cast_incompatible) is not a boot-time drift; it's
      // a Phase 3.5 primitive-time semantic check. Harness does not
      // expose it.
      if (id === 'data_cast_incompatible') continue;
      if (!harnessIds.has(id)) missingInHarness.push(id);
    }
    expect(missingInHarness).toEqual([]);
  });

  it('harness DriftClass union does not advertise unknown registry IDs', () => {
    const harnessIds = extractClassIdsFromHarness();
    const known = new Set(Object.keys(DRIFT_CLASSES));
    const unknown = Array.from(harnessIds).filter((id) => !known.has(id));
    expect(unknown).toEqual([]);
  });

  it('registry severity is either error or warn (no stray values)', () => {
    for (const spec of Object.values(DRIFT_CLASSES)) {
      expect(['error', 'warn']).toContain(spec.severity);
    }
  });
});
