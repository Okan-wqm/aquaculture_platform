/**
 * AquaMobil hand-written GraphQL input mirrors must match the subgraph
 * ============================================================================
 *
 * AquaMobil does not generate every input type it sends. `src/types/index.ts`
 * hand-mirrors a number of farm-service GraphQL `input` types, and a mirror
 * cannot fail at compile time when the server changes underneath it.
 *
 * Why this gate exists (2026-08-16 farm/mobile audit, PRODUCT-MOBILE-CRITICAL-001
 * and PRODUCT-FORM-CRITICAL-001, both re-verified against the source):
 *   farm-service deleted the fixed `parameters` field from
 *   `CreateWaterQualityInput` in favour of `dynamicParameters`. The mobile
 *   mirror kept `parameters`, `WaterQualityRecordPage` kept sending `{}` for
 *   it, and GraphQL variable coercion rejected EVERY measurement — while the
 *   offline lane still rendered a green "Measurement Recorded!" screen. The
 *   drift produced zero compile errors and zero failing tests.
 *
 * The water-quality input itself is no longer mirrored: its documents moved
 * into `src/graphql/` so codegen emits the type and the compiler owns it. That
 * is the Tier-1 fix. This spec is the Tier-3 backstop for the mirrors that are
 * still hand-written — it fails the day one of them drifts, instead of leaving
 * the failure for a field worker to discover.
 *
 * Scope note: a mirror is checked when it resolves to a subgraph input, either
 * by an identical name or through MIRROR_TO_SUBGRAPH_INPUT below. Most mirrors
 * are named differently from the input they reproduce, so the map — not the
 * name — is what gives this gate its reach; MINIMUM_MIRRORS_CHECKED keeps that
 * reach from eroding unnoticed. Interfaces that are not inputs at all (queue
 * payloads, UI view-models) resolve to nothing and are ignored.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '..', '..');
const SCHEMA_PATH = join(REPO_ROOT, 'apps/farm-service/schema.graphql');
const MIRROR_PATH = join(REPO_ROOT, 'web/apps/aquamobil/src/types/index.ts');

/**
 * Mirrors whose name does not match the subgraph input they mirror.
 *
 * `StockMovementInput` is the live example and the reason this map exists: the
 * subgraph already has an `input StockMovementInput` — the maintenance
 * spare-part movement — while the aquamobil interface of that name mirrors the
 * warehouse `RecordStockMovementInput`. Two different concepts, one name across
 * the boundary. Matching by name alone would compare the mirror against the
 * wrong input and report drift that is not there.
 */
const MIRROR_TO_SUBGRAPH_INPUT: Record<string, string> = {
  StockMovementInput: 'RecordStockMovementInput',
  MortalityInput: 'RecordMortalityInput',
  CullInput: 'RecordCullInput',
  HarvestInput: 'CreateHarvestRecordInput',
  LiceCountInput: 'RecordLiceCountInput',
  WelfareAssessmentInput: 'RecordWelfareAssessmentInput',
  EscapeIncidentInput: 'RecordEscapeIncidentInput',
  FeedingInput: 'RecordDailyFeedingInput',
  ChecklistItemSetInput: 'SetChecklistItemInput',
  TransferInput: 'TransferBatchInput',
  StockTransferInput: 'TransferStockInput',
};

/**
 * Mirrors of inputs owned by another subgraph. `apps/farm-service/schema.graphql`
 * is the only committed SDL, so these cannot be resolved here; they are named so
 * the gap is visible rather than implied by their absence.
 */
const OWNED_BY_ANOTHER_SUBGRAPH = ['ClockInInput', 'ClockOutInput', 'CreateLeaveRequestInput'];

/**
 * The gate must never quietly degrade into checking nothing. Matching mirrors to
 * inputs by name found exactly ONE pair on its own — the other ten are named
 * differently from the input they mirror, so a name-only gate would have passed
 * forever while they drifted. That is the failure mode this audit cycle logged
 * as PROC-MEDIUM-016 (a rule no lane could ever trip). Lower this number only
 * alongside a mirror that genuinely stopped existing.
 */
const MINIMUM_MIRRORS_CHECKED = 11;

/**
 * Mirrors that intentionally carry a different field set from the subgraph
 * input. Each entry needs a reason; an empty reason is not a waiver. Keep this
 * empty unless a real divergence is deliberate and documented.
 */
const DELIBERATE_DIVERGENCE: Record<string, string> = {};

/** The subgraph input a mirror is claiming to reproduce. */
function subgraphInputName(mirrorName: string): string {
  return MIRROR_TO_SUBGRAPH_INPUT[mirrorName] ?? mirrorName;
}

/** Field names of a GraphQL `input X { ... }` block, ignoring descriptions. */
function schemaInputFields(schema: string, name: string): Set<string> | null {
  const header = new RegExp(`^input ${name} \\{$`, 'm').exec(schema);
  if (!header || header.index === undefined) return null;
  const body = schema.slice(header.index + header[0].length);
  const end = body.indexOf('\n}');
  const fields = new Set<string>();
  for (const line of body.slice(0, end).split('\n')) {
    const m = /^\s{2}([a-zA-Z_][a-zA-Z0-9_]*)\s*:/.exec(line);
    if (m?.[1]) fields.add(m[1]);
  }
  return fields;
}

/** Property names of an `export interface X { ... }` block in the mirror file. */
function mirrorInterfaces(source: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const re = /^export interface ([A-Za-z0-9_]+) \{$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const body = source.slice(m.index + m[0].length);
    const end = body.indexOf('\n}');
    const fields = new Set<string>();
    for (const line of body.slice(0, end).split('\n')) {
      const f = /^\s{2}([a-zA-Z_][a-zA-Z0-9_]*)\??\s*:/.exec(line);
      if (f?.[1]) fields.add(f[1]);
    }
    if (m[1]) out.set(m[1], fields);
  }
  return out;
}

describe('AquaMobil hand-written input mirrors match the farm-service subgraph', () => {
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  const mirrors = mirrorInterfaces(readFileSync(MIRROR_PATH, 'utf8'));

  const checked = [...mirrors.keys()].filter(
    (n) => schemaInputFields(schema, subgraphInputName(n)) !== null,
  );

  it(`checks at least ${MINIMUM_MIRRORS_CHECKED} mirrors, so the gate cannot silently cover nothing`, () => {
    expect(checked.length).toBeGreaterThanOrEqual(MINIMUM_MIRRORS_CHECKED);
  });

  it('names every mapped subgraph input that no longer exists', () => {
    const dangling = Object.entries(MIRROR_TO_SUBGRAPH_INPUT)
      .filter(([, input]) => schemaInputFields(schema, input) === null)
      .map(([mirror, input]) => `${mirror} → ${input} (input absent from the subgraph)`);
    expect(dangling).toEqual([]);
  });

  it('leaves other subgraphs unclaimed rather than pretending to cover them', () => {
    for (const name of OWNED_BY_ANOTHER_SUBGRAPH) {
      expect(MIRROR_TO_SUBGRAPH_INPUT[name]).toBeUndefined();
    }
  });

  it('declares no field the subgraph input does not have', () => {
    const drift: string[] = [];
    for (const [name, fields] of mirrors) {
      if (DELIBERATE_DIVERGENCE[name]) continue;
      const serverFields = schemaInputFields(schema, subgraphInputName(name));
      if (!serverFields) continue;
      for (const field of fields) {
        if (!serverFields.has(field)) {
          drift.push(`${name}.${field} — mirrored in aquamobil, absent from the subgraph input`);
        }
      }
    }
    expect(drift).toEqual([]);
  });

  it('declares every non-null subgraph field the input requires', () => {
    // The envelope fields are stamped by the offline queue on enqueue, not
    // supplied by the caller — `OperationPayload` is `(union) & MobileCommandEnvelope`,
    // so a mirror is right to omit them. Read from the mirror's own envelope
    // interface rather than hardcoded, so this exclusion cannot drift from it.
    const envelopeFields = mirrors.get('MobileCommandEnvelope') ?? new Set<string>();
    expect(envelopeFields.size).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const [name, fields] of mirrors) {
      if (DELIBERATE_DIVERGENCE[name]) continue;
      if (name === 'MobileCommandEnvelope') continue;
      const target = subgraphInputName(name);
      const header = new RegExp(`^input ${target} \\{$`, 'm').exec(schema);
      if (!header || header.index === undefined) continue;
      const body = schema.slice(header.index + header[0].length);
      for (const line of body.slice(0, body.indexOf('\n}')).split('\n')) {
        const m = /^\s{2}([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.+?)\s*$/.exec(line);
        const field = m?.[1];
        const type = m?.[2];
        if (field && type?.endsWith('!') && !fields.has(field) && !envelopeFields.has(field)) {
          missing.push(
            `${name}.${field} — required by ${target}, missing from the aquamobil mirror`,
          );
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
