/**
 * Sensor FE/BE input-object parity
 * ============================================================================
 *
 * Closes SENSOR-HIGH-063
 * (docs/reviews/2026-07-17-sensor-device-industrial-protocol-audit.md).
 *
 * # The defect this freezes
 *
 * `sensor-module` has no codegen — `codegen.ts` does not scan `web/modules/**` —
 * so every GraphQL input it sends is a hand-written interface. Channel CRUD had
 * drifted so far that it failed 100% of the time: the create payload carried
 * `unitSymbol`, `operationalMin`, `operationalMax` and `discoverySource`, the
 * update payload carried those three plus `dataType`, and
 * `CreateDataChannelInput`/`UpdateDataChannelInput` define none of them. GraphQL
 * raises an error for an input object carrying an undefined field, so ONE such key
 * fails the whole request — and two of them were unconditional.
 *
 * The names were not typos. They are real columns on the `SensorDataChannel`
 * ENTITY. A hand-written client drifts toward whatever shape is nearest to hand,
 * and that is the entity, not the schema. Nothing noticed for months:
 * `validate-graphql-operations.mjs` checks document text rather than variable
 * shape, and `farm-graphql-fe-be-parity` / `hr-graphql-fe-be-parity` had no sensor
 * counterpart — this file is it.
 *
 * # What this enforces (Tier-3, "make it detectable")
 *
 * For each pair in CONTRACT_PAIRS, the frontend interface's field names must be a
 * SUBSET of the backend input type's. Subset rather than equality on purpose: a
 * client that omits an optional field is fine, a client that INVENTS one is a
 * guaranteed runtime rejection.
 *
 * Combined with tsc this is a closed loop. The invariant proves
 * interface ⊆ contract; tsc's excess-property check on an object literal returned
 * as that interface proves payload ⊆ interface. So payload ⊆ contract, and no
 * mapper can reintroduce the defect without one of the two failing.
 *
 * # Coverage is a ratchet, not a claim of completeness
 *
 * sensor-module declares far more input interfaces than this file maps, and
 * mapping all of them at once would mean auditing every sensor mutation in one
 * change. MAX_UNVERIFIED_FE_INPUTS pins today's count so the gap can only shrink:
 * adding a pair lowers it, and a NEW unmapped interface raises it and fails.
 *
 * # When this fails
 *
 *   1. A frontend interface names a field its backend input does not define →
 *      the request would be rejected at the GraphQL boundary. Fix the frontend
 *      to the contract, or add the field to the backend input if it genuinely
 *      belongs there.
 *   2. A pair no longer resolves → a type was renamed or moved. Update the pair;
 *      do not delete it, or the surface silently loses its gate.
 *   3. The unmapped count grew → a new hand-written input appeared. Map it here
 *      rather than raising the ceiling.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

interface ContractPair {
  readonly feFile: string;
  readonly feType: string;
  readonly beFile: string;
  readonly beType: string;
  /** Why these two are the same contract — a reader should not have to guess. */
  readonly note: string;
}

const CONTRACT_PAIRS: readonly ContractPair[] = [
  {
    feFile: 'web/modules/sensor-module/src/hooks/useChannelManagement.ts',
    feType: 'CreateChannelInput',
    beFile: 'apps/sensor-service/src/registration/dto/data-channel.dto.ts',
    beType: 'CreateDataChannelInput',
    note: 'createDataChannel(sensorId, input) — the pair that carried SENSOR-HIGH-063',
  },
  {
    feFile: 'web/modules/sensor-module/src/hooks/useChannelManagement.ts',
    feType: 'UpdateChannelInput',
    beFile: 'apps/sensor-service/src/registration/dto/data-channel.dto.ts',
    beType: 'UpdateDataChannelInput',
    note: 'updateDataChannel(input) — channelId is added by the hook, not the mapper',
  },
  {
    feFile: 'web/modules/sensor-module/src/types/vfd.types.ts',
    feType: 'RegisterVfdInput',
    beFile: 'apps/sensor-service/src/vfd/dto/register-vfd.dto.ts',
    beType: 'RegisterVfdDto',
    note: 'registerVfdDevice — clean today; mapped so it stays that way',
  },
  {
    feFile: 'web/modules/sensor-module/src/types/vfd.types.ts',
    feType: 'UpdateVfdInput',
    beFile: 'apps/sensor-service/src/vfd/dto/update-vfd.dto.ts',
    beType: 'UpdateVfdDto',
    note: 'updateVfdDevice — clean today; mapped so it stays that way',
  },
  {
    feFile: 'web/modules/sensor-module/src/types/vfd.types.ts',
    feType: 'VfdCommandInput',
    beFile: 'apps/sensor-service/src/vfd/dto/vfd-command.dto.ts',
    beType: 'VfdCommandDto',
    note: 'sendVfdCommand — the frontend omits waitForAck/timeoutMs, which is allowed',
  },
] as const;

/**
 * Every hand-written input interface in sensor-module that no pair covers.
 * Lower this by adding pairs. It must never rise.
 */
const MAX_UNVERIFIED_FE_INPUTS = 41;

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

/** Field names of `export interface <Name> { ... }`, one indent level deep. */
function interfaceFields(source: string, name: string): string[] | undefined {
  const body = new RegExp(`export interface ${name}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm').exec(
    source,
  )?.[1];
  if (body === undefined) return undefined;
  return [...body.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map((m) => m[1] as string);
}

/** Property names of an `@InputType()` / DTO `export class <Name> { ... }`. */
function classFields(source: string, name: string): string[] | undefined {
  const body = new RegExp(`export class ${name}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm').exec(source)?.[1];
  if (body === undefined) return undefined;
  return [...body.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*)[!?]?:/gm)].map((m) => m[1] as string);
}

/** Names of every `export interface …Input` declared under sensor-module. */
function declaredFeInputs(): string[] {
  const out = execFileSync(
    'grep',
    ['-rhoE', '^export interface [A-Za-z]+Input\\b', 'web/modules/sensor-module/src'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => line.replace('export interface ', '').trim());
}

describe('INVARIANT: sensor FE/BE input parity (SENSOR-HIGH-063)', () => {
  it('every mapped pair still resolves on both sides', () => {
    const unresolved: string[] = [];
    for (const pair of CONTRACT_PAIRS) {
      if (!existsSync(path.join(REPO_ROOT, pair.feFile))) {
        unresolved.push(`${pair.feFile} is gone`);
        continue;
      }
      if (!existsSync(path.join(REPO_ROOT, pair.beFile))) {
        unresolved.push(`${pair.beFile} is gone`);
        continue;
      }
      if (interfaceFields(read(pair.feFile), pair.feType) === undefined) {
        unresolved.push(`${pair.feType} not found in ${pair.feFile}`);
      }
      if (classFields(read(pair.beFile), pair.beType) === undefined) {
        unresolved.push(`${pair.beType} not found in ${pair.beFile}`);
      }
    }
    expect(unresolved).toEqual([]);
  });

  it('the extractors actually find fields (so the subset rule is not vacuous)', () => {
    // A regex that matched nothing would make every subset check trivially pass.
    for (const pair of CONTRACT_PAIRS) {
      expect(interfaceFields(read(pair.feFile), pair.feType)?.length ?? 0).toBeGreaterThan(0);
      expect(classFields(read(pair.beFile), pair.beType)?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('no frontend input names a field its backend contract does not define', () => {
    const offenders: string[] = [];
    for (const pair of CONTRACT_PAIRS) {
      const fe = interfaceFields(read(pair.feFile), pair.feType) ?? [];
      const be = new Set(classFields(read(pair.beFile), pair.beType) ?? []);
      const extra = fe.filter((field) => !be.has(field));
      if (extra.length > 0) {
        offenders.push(`${pair.feType} → ${pair.beType}: ${extra.join(', ')}`);
      }
    }
    // Every entry here is a request GraphQL would reject outright, not a warning.
    expect(offenders).toEqual([]);
  });

  it('the unmapped surface only shrinks', () => {
    const mapped = new Set(CONTRACT_PAIRS.map((p) => p.feType));
    const unmapped = declaredFeInputs().filter((name) => !mapped.has(name));

    expect(unmapped.length).toBeLessThanOrEqual(MAX_UNVERIFIED_FE_INPUTS);
  });

  it('the ceiling is not left above the real count once pairs are added', () => {
    // Without this, lowering the gap by adding a pair would leave slack that a new
    // unmapped interface could occupy silently.
    const mapped = new Set(CONTRACT_PAIRS.map((p) => p.feType));
    const unmapped = declaredFeInputs().filter((name) => !mapped.has(name));

    expect(MAX_UNVERIFIED_FE_INPUTS).toBe(unmapped.length);
  });
});
