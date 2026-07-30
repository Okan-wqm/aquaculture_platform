/**
 * Finding Registry Integrity Invariant
 * ============================================================================
 *
 * Phase 6 of /root/.claude/plans/abstract-brewing-mochi.md.
 *
 * docs/reviews/_registry/findings.jsonl is an append-only hash-chained
 * ledger of every CATCHER-produced finding. This invariant asserts:
 *
 *   1. Every line parses as JSON.
 *   2. Every entry conforms to findings.jsonl.schema.json.
 *   3. The hash chain is intact:
 *        entries[0].prev_hash === '0'.repeat(64)
 *        entries[i].prev_hash === entries[i-1].content_hash
 *        entries[i].content_hash === sha256hex(canonicalJson(entries[i] minus content_hash))
 *
 * Any drift means someone modified the registry mid-chain, which is
 * forbidden for an append-only tamper-evident log.
 *
 * # When this fails
 *
 *   - Entry mid-registry edited → reject the unauthorized delta and compare a
 *     fresh checkout with the last verified protected-main state. Never seed,
 *     rechain, dedupe, or mutate the JSONL from a checkout.
 *   - Schema violation in an authority PR → correct the workflow request and
 *     retry it with the same command_id.
 *   - Hash mismatch → reject the authority PR and investigate its provenance.
 *
 * # References
 *
 *   - /root/.claude/plans/abstract-brewing-mochi.md#Phase-6
 *   - /var/aqua-saas/docs/reviews/_registry/README.md (authority + management docs)
 *   - /var/aqua-saas/docs/reviews/_registry/findings.jsonl.schema.json
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import * as YAML from 'yaml';

import { DEAD_EVIDENCE_PATH_PREFIXES } from './_constants';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = path.join(REPO_ROOT, 'docs', 'reviews', '_registry', 'findings.jsonl');
const SCHEMA_PATH = path.join(
  REPO_ROOT,
  'docs',
  'reviews',
  '_registry',
  'findings.jsonl.schema.json',
);

interface FindingEntry {
  id: string;
  severity: string;
  state: string;
  prev_hash: string;
  content_hash: string;
  [key: string]: unknown;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

function sha256hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function readEntries(): FindingEntry[] {
  if (!fs.existsSync(REGISTRY_PATH)) return [];
  const content = fs.readFileSync(REGISTRY_PATH, 'utf8').trim();
  if (content.length === 0) return [];
  return content.split('\n').map((line) => JSON.parse(line) as FindingEntry);
}

function loadValidator(): ValidateFunction {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  // WHY: Ajv2020 in default mode does not register format validators
  // (`date-time`, `date`, `email`, `uri`, …) — the schema declares
  // `format: "date-time"` on `created_at` / `closed_at` and `format:
  // "date"` on `deadline`. Without `addFormats(ajv)`, AJV emits an
  // "unknown format" warning AND raises `unknownFormat` errors at
  // compile time, which crashes `ajv.compile(schema)` and cascades:
  // every assertion in this spec fails because the validator never
  // existed. Registering ajv-formats wires the JSON-Schema-canonical
  // format checkers structurally (Tier-1 "make impossible" — there is
  // no per-spec opt-in needed; the formats are now part of the AJV
  // instance). This unmasks any TRUE schema violations (such as the
  // FARM-DATAMIG-001 id pattern carve-out documented in
  // findings.jsonl.schema.json's `allOf` block).
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

describe('finding registry integrity invariant', () => {
  const entries = readEntries();
  const validate = loadValidator();

  it('registry file exists and has at least one entry (Phase 6 seed)', () => {
    expect(fs.existsSync(REGISTRY_PATH)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
  });

  it('every entry conforms to findings.jsonl.schema.json', () => {
    const errors: string[] = [];
    for (const entry of entries) {
      const entryId = entry.id;
      const valid = validate(entry);
      if (!valid) {
        errors.push(`${entryId}: ${JSON.stringify(validate.errors)}`);
      }
    }
    expect(errors).toEqual([]);
  });

  it('first entry has prev_hash = 64 zeros', () => {
    if (entries.length === 0) return;
    expect(entries[0]?.prev_hash).toBe('0'.repeat(64));
  });

  it('hash chain is intact (each entry prev_hash equals previous content_hash)', () => {
    for (let i = 1; i < entries.length; i++) {
      const current = entries[i];
      const previous = entries[i - 1];
      if (!current || !previous) continue;
      expect(current.prev_hash).toBe(previous.content_hash);
    }
  });

  it('every entry content_hash matches sha256(canonical JSON without content_hash)', () => {
    for (const entry of entries) {
      const { content_hash: stored, ...forHash } = entry;
      const recomputed = sha256hex(canonicalJson(forHash));
      expect({ id: entry.id, hash: stored }).toEqual({
        id: entry.id,
        hash: recomputed,
      });
    }
  });

  it('every finding ID is unique', () => {
    const ids = entries.map((e) => e.id);
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(duplicates).toEqual([]);
  });

  /**
   * SEC-REVIEW-005 — finding re-open detection.
   *
   * When a finding previously closed as RESOLVED regresses, request a fresh
   * entry from the Finding Registry Authority workflow (e.g.
   * `AUDIT-HIGH-008-R1`) with `override_of: "AUDIT-HIGH-008"` pointing at
   * the prior finding. The chain stays append-only; the earlier RESOLVED row
   * is never edited.
   *
   * Integrity invariant: every `override_of` value, when non-null, must
   * refer to an id that exists earlier in the chain. Without this check
   * a typo (override_of: "AUDIT-HIGH-0008") would pass the Ajv schema
   * (string field) and silently orphan the reopen.
   *
   * Observability: this block additionally emits a console.warn with
   * the list of re-opens (non-null override_of) so the CI log surfaces
   * regressions that matched the semantic `RESOLVED → R1` pattern. The
   * test itself does not fail on re-opens — reopens are legitimate; it
   * fails only when the pointer is orphaned.
   */
  describe('re-open detection (SEC-REVIEW-005)', () => {
    interface OverrideEntry {
      id: string;
      overrides: string;
      state: string;
      severity: string;
    }

    function overrides(): OverrideEntry[] {
      const out: OverrideEntry[] = [];
      for (const e of entries) {
        const ovr = (e as { override_of?: unknown }).override_of;
        if (typeof ovr === 'string' && ovr.length > 0) {
          out.push({ id: e.id, overrides: ovr, state: e.state, severity: e.severity });
        }
      }
      return out;
    }

    it('every non-null override_of references an existing earlier finding id', () => {
      const seen = new Set<string>();
      const orphans: Array<{ id: string; overrides: string }> = [];
      for (const e of entries) {
        const ovr = (e as { override_of?: unknown }).override_of;
        if (typeof ovr === 'string' && ovr.length > 0) {
          if (!seen.has(ovr)) {
            orphans.push({ id: e.id, overrides: ovr });
          }
        }
        seen.add(e.id);
      }
      if (orphans.length > 0) {
        const lines = orphans
          .map((o) => `  ${o.id} → override_of: "${o.overrides}" (not present earlier in chain)`)
          .join('\n');
        throw new Error(
          `findings.jsonl contains ${orphans.length} override_of pointer(s) that do not ` +
            `reference an earlier entry. Either fix the pointer typo OR append the missing ` +
            `override-target as a prior entry first:\n${lines}`,
        );
      }
      expect(orphans).toEqual([]);
    });

    it('surfaces re-opened findings as a CI-visible warning (soft signal, never fails)', () => {
      const reopens = overrides();
      if (reopens.length > 0) {
        console.warn(
          `[registry] ${reopens.length} re-opened finding(s) in chain — review for regression patterns:`,
        );
        for (const r of reopens) {
          console.warn(`  ${r.id} (${r.severity} ${r.state}) overrides ${r.overrides}`);
        }
      }
      // Soft signal only — do not fail the build on re-opens; they are
      // legitimate when a regression genuinely happens. The fail-case
      // (orphan pointer) is caught by the sibling `it` above.
      expect(reopens).toBeDefined();
    });
  });

  /**
   * Soft check — Faz 6 of parallel-jumping-ladybug.md.
   *
   * Append-only ledger cannot be edited, but evidence paths recorded
   * pre-flatten (agents-enterprise-v2/, test-agents/) are dead on disk.
   * Sidecar `path-corrections.yaml` documents the prefix-to-replacement
   * mapping so reviewers reopening old findings have a navigable trail.
   *
   * Invariant: every finding whose evidence array touches a dead prefix
   * must appear in the sidecar's affected_findings list. Prevents the
   * sidecar from silently falling behind the ledger.
   */
  describe('path-corrections sidecar coverage', () => {
    const SIDECAR_PATH = path.join(
      REPO_ROOT,
      'docs',
      'reviews',
      '_registry',
      'path-corrections.yaml',
    );

    interface Sidecar {
      version: number;
      corrections: readonly { prefix: string }[];
      affected_findings: readonly { id: string; state?: string }[];
    }

    function loadSidecar(): Sidecar | null {
      if (!fs.existsSync(SIDECAR_PATH)) return null;
      return YAML.parse(fs.readFileSync(SIDECAR_PATH, 'utf8')) as Sidecar;
    }

    function findingsWithDeadEvidence(): string[] {
      const deadPrefixes = DEAD_EVIDENCE_PATH_PREFIXES as readonly string[];
      const hits: string[] = [];
      for (const entry of entries) {
        const evidence = (entry as { evidence?: unknown }).evidence;
        if (!Array.isArray(evidence)) continue;
        const anyDead = evidence.some(
          (e) => typeof e === 'string' && deadPrefixes.some((p) => e.startsWith(p)),
        );
        if (anyDead) hits.push(entry.id);
      }
      return hits;
    }

    it('sidecar file exists at docs/reviews/_registry/path-corrections.yaml', () => {
      expect(fs.existsSync(SIDECAR_PATH)).toBe(true);
    });

    it('sidecar declares every known-dead evidence prefix', () => {
      const sidecar = loadSidecar();
      expect(sidecar).not.toBeNull();
      if (!sidecar) return;
      const declaredPrefixes = new Set(sidecar.corrections.map((c) => c.prefix));
      const missing = (DEAD_EVIDENCE_PATH_PREFIXES as readonly string[]).filter(
        (p) => !declaredPrefixes.has(p),
      );
      if (missing.length > 0) {
        throw new Error(
          `path-corrections.yaml is missing corrections for dead prefixes: ${missing.join(', ')}. ` +
            'Add a `corrections` entry for each.',
        );
      }
      expect(missing).toEqual([]);
    });

    it('every finding with dead-prefix evidence is listed in affected_findings', () => {
      const sidecar = loadSidecar();
      expect(sidecar).not.toBeNull();
      if (!sidecar) return;
      const listedIds = new Set(sidecar.affected_findings.map((f) => f.id));
      const withDeadEvidence = findingsWithDeadEvidence();
      const missing = withDeadEvidence.filter((id) => !listedIds.has(id));
      if (missing.length > 0) {
        throw new Error(
          `findings.jsonl contains entries with dead-prefix evidence that are not in ` +
            `path-corrections.yaml affected_findings:\n  - ${missing.join('\n  - ')}\n\n` +
            `Append each finding ID to affected_findings (with its current state).`,
        );
      }
      expect(missing).toEqual([]);
    });
  });
});
