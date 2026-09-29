import { canonicalJsonBytes } from './canonical-json';
import { computeEventHash } from './event-chain';
import { digestBytes, isJsonRecord } from './evidence-object';
import type { OracleBaselineInput } from './negative-control-registry';
import { parseStrictJson } from './strict-json';
import type { JsonRecord } from './evidence-object';

function clone(baseline: OracleBaselineInput): JsonRecord {
  const value = parseStrictJson(canonicalJsonBytes(baseline));
  if (!isJsonRecord(value)) throw new TypeError('negative-control baseline clone is invalid');
  return value;
}

function record(value: unknown, label: string): JsonRecord {
  if (!isJsonRecord(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function dossier(baseline: JsonRecord): JsonRecord {
  return record(baseline.verification_dossier, 'negative-control dossier');
}

function decoded(reference: JsonRecord, label: string): Buffer {
  const encoded = reference.bytes_base64;
  if (typeof encoded !== 'string') throw new TypeError(`${label} bytes are invalid`);
  return Buffer.from(encoded, 'base64');
}

function replaceBytes(reference: JsonRecord, bytes: Uint8Array): void {
  reference.bytes_base64 = Buffer.from(bytes).toString('base64');
  reference.sha256 = digestBytes(bytes);
}

function eventRows(reference: JsonRecord): JsonRecord[] {
  const source = decoded(reference, 'negative-control event chain').toString('utf8');
  if (!source.endsWith('\n')) throw new TypeError('negative-control event chain is invalid');
  return source
    .slice(0, -1)
    .split('\n')
    .map((line) => {
      const value = parseStrictJson(Buffer.from(line));
      return record(value, 'negative-control event');
    });
}

function eventBytes(rows: readonly JsonRecord[]): Buffer {
  return Buffer.from(`${rows.map((row) => canonicalJsonBytes(row).toString()).join('\n')}\n`);
}

const alteredDigest = (value: string): string =>
  `${value.startsWith('0') ? '1' : '0'}${value.slice(1)}`;

export function mutateEventHash(baseline: OracleBaselineInput): JsonRecord {
  const result = clone(baseline);
  const reference = record(dossier(result).event_chain, 'negative-control event reference');
  const rows = eventRows(reference);
  const first = rows[0];
  if (first === undefined || typeof first.event_hash !== 'string') {
    throw new TypeError('negative-control event hash is unavailable');
  }
  first.event_hash = alteredDigest(first.event_hash);
  replaceBytes(reference, eventBytes(rows));
  return result;
}

export function mutateEvidenceDigest(baseline: OracleBaselineInput): JsonRecord {
  const result = clone(baseline);
  const chain = dossier(result).manifest_chain;
  if (!Array.isArray(chain)) throw new TypeError('negative-control manifest chain is invalid');
  const first = record(chain[0], 'negative-control manifest reference');
  const bytes = decoded(first, 'negative-control manifest');
  if (bytes.length === 0 || bytes.at(-1) !== 0x0a) {
    throw new TypeError('negative-control manifest bytes are invalid');
  }
  const manifest = record(parseStrictJson(bytes.slice(0, -1)), 'negative-control manifest');
  manifest.observation_id = 'observation-tampered';
  replaceBytes(first, Buffer.concat([canonicalJsonBytes(manifest), Buffer.from('\n')]));
  return result;
}

export function mutateStaleEvidence(baseline: OracleBaselineInput): JsonRecord {
  const result = clone(baseline);
  const freshness = record(dossier(result).freshness, 'negative-control freshness');
  const observedAt = freshness.observed_at;
  if (typeof observedAt !== 'string')
    throw new TypeError('negative-control freshness time is invalid');
  freshness.valid_until = new Date(Date.parse(observedAt) - 1).toISOString();
  return result;
}

export function mutateUnauthorizedTarget(baseline: OracleBaselineInput): JsonRecord {
  const result = clone(baseline);
  const reference = record(dossier(result).event_chain, 'negative-control event reference');
  const rows = eventRows(reference);
  let previousHash = '0'.repeat(64);
  for (const row of rows) {
    row.target_sha = alteredDigest(baseline.head_sha);
    row.previous_hash = previousHash;
    row.event_hash = '';
    row.event_hash = computeEventHash(row);
    previousHash = row.event_hash;
  }
  replaceBytes(reference, eventBytes(rows));
  return result;
}
