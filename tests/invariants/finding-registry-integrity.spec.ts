/**
 * Finding Registry Integrity Invariant
 * ============================================================================
 *
 * Phase 6 of /root/.claude/plans/abstract-brewing-mochi.md.
 *
 * docs/reviews/_registry/findings.jsonl is the frozen genesis segment of an
 * append-only hash-chained ledger of every CATCHER-produced finding (since MF-2
 * every later change is an event under docs/reviews/_registry/findings/). This
 * invariant asserts:
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
 *   - Entry mid-registry edited, or a row appended → revert it. findings.jsonl
 *     is frozen: a change to a finding is an event (`finding-registry add`,
 *     `reopen`, `assign`, ... write it under docs/reviews/_registry/findings/).
 *     A branch that wrote rows before the freeze converts them with the branch
 *     converter.
 *   - Schema violation on a new entry → fix the entry to match schema.
 *   - Hash mismatch → content was modified after append; revert the edit.
 *   - A genesis-pin failure names the remedy its base allows. Before the freeze
 *     lands (the base has no genesis.json) that is the branch converter, or
 *     `npm run findings:genesis` at landing. Once the base holds the freeze it is
 *     final, and only the converter, which restores the segment, is named.
 *
 * # References
 *
 *   - /root/.claude/plans/abstract-brewing-mochi.md#Phase-6
 *   - /var/aqua-saas/docs/reviews/_registry/README.md (seed + management docs)
 *   - /var/aqua-saas/docs/reviews/_registry/findings.jsonl.schema.json
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import * as YAML from 'yaml';

import { canonicalOwner, LEGACY_OWNER_SPELLINGS } from '../../tools/gates/finding-registry-owners';

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
   * ARIA-MEDIUM-535 — one identity per owner. owner_user is the CODEOWNERS
   * handle accountable for the finding, stored in its CODEOWNERS spelling
   * (tools/gates/finding-registry-owners.ts). The registry writers store it so;
   * this judges the whole ledger, merged rows included. LEGACY_OWNER_SPELLINGS
   * are spellings whose identity awaits the operator's mapping; the list only
   * shrinks, so a spelling that no longer occurs must leave it.
   */
  it('every owner_user is a .github/CODEOWNERS handle in its CODEOWNERS spelling (ARIA-MEDIUM-535)', () => {
    const stray = entries
      .filter((entry) => typeof entry.owner_user === 'string')
      .map((entry) => ({ id: entry.id, owner: String(entry.owner_user) }))
      .filter(({ owner }) => {
        if (LEGACY_OWNER_SPELLINGS.includes(owner)) return false;
        const resolved = canonicalOwner(owner);
        return !resolved.ok || resolved.owner !== owner;
      })
      .map(({ id, owner }) => `${id}: ${owner}`);
    expect(stray).toEqual([]);
    const occurring = new Set(entries.map((entry) => entry.owner_user));
    expect(LEGACY_OWNER_SPELLINGS.filter((spelling) => !occurring.has(spelling))).toEqual([]);
  });

  /**
   * SEC-REVIEW-005 — finding re-open detection.
   *
   * When a finding previously closed as RESOLVED regresses, the correct
   * shape per the schema is to APPEND a new entry with a fresh id (e.g.
   * `AUDIT-HIGH-008-R1`) and `override_of: "AUDIT-HIGH-008"` pointing at
   * the prior finding. The chain stays append-only; the earlier RESOLVED
   * row is never edited.
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

/**
 * MF-2 (MF-DESIGN §4.1–§4.3, §6 steps 3–4, §7 T6/T7) — findings.jsonl is a
 * frozen genesis segment and every later change is an append-only event in
 * one file per finding.
 *
 * Re-implemented here, independently of tools/gates/finding-registry-events.ts,
 * like the chain checks above: a defect shared by the writer and its own
 * verifier would otherwise pass both.
 *
 *   - T6: the bytes of findings.jsonl are the blob genesis.json pins (sha256,
 *     entry count, tip content_hash). A mismatch names the remedy the base of
 *     the change allows: a branch that edited or appended rows converts them to
 *     events with the branch converter; a landing that merged origin/main
 *     before the freeze also re-pins with `npm run findings:genesis`; once the
 *     base holds genesis.json the freeze is final and no re-pin is offered.
 *   - T6: every event file is `findings/<PREFIX>/<ID>.jsonl` and its lines
 *     form a chain anchored on the finding's genesis row (or the genesis tip
 *     for a finding born after the freeze); the vocabulary is closed and never
 *     reaches RESOLVED; ids are unique over genesis ∪ files; every owner_user
 *     an event writes is a CODEOWNERS handle in its CODEOWNERS spelling.
 *   - T7: every event file at the base of this change is a byte prefix of
 *     itself here, and none is deleted; and once the base holds genesis.json,
 *     genesis.json and findings.jsonl are byte-equal to the base's. This runs
 *     in every PR (the Closes Footer Check that also holds them is not a
 *     required status), so a branch cannot append a row, re-pin and merge. The
 *     cutover itself, whose base has no genesis.json, is exempt.
 */
describe('MF-2 — the genesis pin and the per-finding event store', () => {
  const REGISTRY_DIR = path.join(REPO_ROOT, 'docs', 'reviews', '_registry');
  const GENESIS_PATH = path.join(REGISTRY_DIR, 'genesis.json');
  const STORE_RELATIVE = 'docs/reviews/_registry/findings';
  const STORE_DIR = path.join(REPO_ROOT, STORE_RELATIVE);
  const GENESIS_REMEDY = 'npm run findings:genesis';
  const BRANCH_REMEDY = 'tools/gates/finding-registry-migrate-branch.ts';
  const GENESIS_RELATIVE = 'docs/reviews/_registry/genesis.json';
  const SEGMENT_RELATIVE = 'docs/reviews/_registry/findings.jsonl';
  const EVENT_TYPES = [
    'CREATED',
    'STATE_TRANSITIONED',
    'CLOSURE_REJECTED',
    'OWNER_ASSIGNED',
    'AMENDED',
    'SUPERSEDED',
  ];
  const EVENT_KEYS = [
    'actor',
    'content_hash',
    'event_id',
    'event_type',
    'finding_id',
    'occurred_at',
    'payload',
    'prev_hash',
    'reason',
    'version',
  ];
  const GIT_STATE_TARGETS = ['OPEN', 'IN-PROGRESS', 'STALE', 'BLOCKED'];
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const EVENT_FILE = /^([A-Z][A-Z0-9]*)\/([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\.jsonl$/;

  interface EventLine {
    event_id: unknown;
    finding_id: unknown;
    version: unknown;
    event_type: unknown;
    payload: Record<string, unknown>;
    actor: unknown;
    reason: unknown;
    occurred_at: unknown;
    prev_hash: unknown;
    content_hash: unknown;
    [key: string]: unknown;
  }

  interface EventFile {
    /** Path under docs/reviews/_registry/findings/, `/`-separated. */
    rel: string;
    bytes: Buffer;
    events: EventLine[];
  }

  function git(args: readonly string[]): Buffer {
    return execFileSync('git', ['-C', REPO_ROOT, ...args], { maxBuffer: 256 * 1024 * 1024 });
  }

  /** The commit this change is judged against: merge-base(HEAD, origin/main); on main itself, the last merge's first parent. */
  function changeBase(): string {
    const remote = spawnSync(
      'git',
      ['-C', REPO_ROOT, 'rev-parse', '--verify', '--quiet', 'origin/main'],
      { encoding: 'utf8' },
    );
    if (remote.status !== 0) {
      throw new Error(
        'origin/main is not available: the checks against the base compare with merge-base(HEAD, origin/main) (fetch-depth: 0)',
      );
    }
    const head = git(['rev-parse', 'HEAD']).toString('utf8').trim();
    const mergeBase = git(['merge-base', 'HEAD', 'origin/main']).toString('utf8').trim();
    return mergeBase === head
      ? git(['rev-parse', `${head}^1`])
          .toString('utf8')
          .trim()
      : mergeBase;
  }

  /** Whether `base` already holds genesis.json, which is what makes the segment final. */
  function baseHoldsFreeze(base: string): boolean {
    return (
      git(['ls-tree', '--name-only', base, '--', GENESIS_RELATIVE]).toString('utf8').trim() !== ''
    );
  }

  function readGenesis(): Record<string, unknown> | null {
    if (!fs.existsSync(GENESIS_PATH)) return null;
    return JSON.parse(fs.readFileSync(GENESIS_PATH, 'utf8')) as Record<string, unknown>;
  }

  /**
   * Why `blob` is not the segment `genesis` pins. Each reason names the remedy the
   * base allows: before the freeze (`frozenAtBase` false) the converter and the
   * landing re-pin; once the base froze the segment, the converter alone.
   */
  function genesisPinDefects(
    blob: Buffer,
    genesis: Record<string, unknown> | null,
    frozenAtBase: boolean,
  ): string[] {
    const remedy = frozenAtBase
      ? `The base froze findings.jsonl and the freeze is final: a change to the segment is ` +
        `recorded as events. Convert the rows this branch wrote with \`ts-node ${BRANCH_REMEDY}\`, ` +
        `which restores findings.jsonl and genesis.json to the base.`
      : `A branch that edited or appended findings.jsonl rows converts them to events with ` +
        `\`ts-node ${BRANCH_REMEDY}\`; a landing that merged origin/main before the freeze ` +
        `re-pins the segment with \`${GENESIS_REMEDY}\`.`;
    if (genesis === null) return [`docs/reviews/_registry/genesis.json is missing. ${remedy}`];
    const text = blob.toString('utf8').trim();
    const rows =
      text === '' ? [] : text.split('\n').map((line) => JSON.parse(line) as FindingEntry);
    const actual: Record<string, unknown> = {
      path: 'docs/reviews/_registry/findings.jsonl',
      blob_sha256: createHash('sha256').update(blob).digest('hex'),
      entries: rows.length,
      tip_content_hash: rows[rows.length - 1]?.content_hash ?? '0'.repeat(64),
    };
    return Object.entries(actual)
      .filter(([key, value]) => genesis[key] !== value)
      .map(
        ([key, value]) =>
          `findings.jsonl ${key} is ${JSON.stringify(value)}, genesis.json pins ` +
          `${JSON.stringify(genesis[key])}. ${remedy}`,
      );
  }

  function walk(dir: string): string[] {
    return fs.readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return fs.statSync(full).isDirectory() ? walk(full) : [full];
    });
  }

  /** The event store in the tree under test; none when it does not exist. */
  function loadStore(): EventFile[] {
    if (!fs.existsSync(STORE_DIR)) return [];
    return walk(STORE_DIR)
      .map((full) => path.relative(STORE_DIR, full).split(path.sep).join('/'))
      .sort()
      .map((rel) => {
        const bytes = fs.readFileSync(path.join(STORE_DIR, rel));
        const events = bytes
          .toString('utf8')
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => JSON.parse(line) as EventLine);
        return { rel, bytes, events };
      });
  }

  const legacyEntries = readEntries();
  const genesisRows = new Map(legacyEntries.map((entry) => [entry.id, entry]));
  const genesisTip = legacyEntries[legacyEntries.length - 1]?.content_hash ?? '0'.repeat(64);
  const store = loadStore();

  it('T6 — findings.jsonl is the blob genesis.json pins, and a drifted blob names the remedy its base allows', () => {
    const blob = fs.readFileSync(REGISTRY_PATH);
    const genesis = readGenesis();
    expect(genesisPinDefects(blob, genesis, baseHoldsFreeze(changeBase()))).toEqual([]);

    // Before the freeze lands: both the converter and the landing re-pin.
    const drifted = Buffer.concat([blob, Buffer.from('{}\n')]);
    const beforeFreeze = genesisPinDefects(drifted, genesis, false);
    expect(beforeFreeze.length).toBeGreaterThan(0);
    for (const message of beforeFreeze) {
      expect(message).toContain(GENESIS_REMEDY);
      expect(message).toContain(BRANCH_REMEDY);
    }
    // Once the base froze it: the converter only. A re-pin would move a final segment.
    const afterFreeze = genesisPinDefects(drifted, genesis, true);
    expect(afterFreeze.length).toBeGreaterThan(0);
    for (const message of afterFreeze) {
      expect(message).not.toContain(GENESIS_REMEDY);
      expect(message).toContain(BRANCH_REMEDY);
    }
    // Both remedies exist under the names the message gives.
    const scripts = (
      JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts['findings:genesis']).toMatch(/tools\/gates\/finding-registry\.ts genesis\b/);
    expect(fs.existsSync(path.join(REPO_ROOT, BRANCH_REMEDY))).toBe(true);
  });

  it('T6 — every event file is findings/<PREFIX>/<ID>.jsonl with a chain anchored on genesis', () => {
    // MF-2 itself records MF-3's tracked finding through the event writer, so
    // an empty store means the store is not in use.
    expect(store.length).toBeGreaterThan(0);
    const defects: string[] = [];
    for (const file of store) {
      const match = EVENT_FILE.exec(file.rel);
      const prefix = match?.[1];
      const id = match?.[2];
      if (prefix === undefined || id === undefined || id.split('-')[0] !== prefix) {
        defects.push(`${file.rel}: not findings/<PREFIX>/<ID>.jsonl`);
        continue;
      }
      if (!file.bytes.toString('utf8').endsWith('\n')) {
        defects.push(`${file.rel}: the last line is not newline-terminated`);
      }
      const legacy = genesisRows.get(id);
      if (file.events.length === 0) defects.push(`${file.rel}: holds no event`);
      file.events.forEach((event, index) => {
        const where = `${file.rel}:${index + 1}`;
        const keys = Object.keys(event).sort();
        if (JSON.stringify(keys) !== JSON.stringify(EVENT_KEYS)) {
          defects.push(`${where}: fields ${keys.join(',')}`);
        }
        if (event.finding_id !== id)
          defects.push(`${where}: finding_id ${String(event.finding_id)}`);
        if (event.version !== index + 1) defects.push(`${where}: version ${String(event.version)}`);
        if (typeof event.event_id !== 'string' || !UUID.test(event.event_id)) {
          defects.push(`${where}: event_id is not a UUID`);
        }
        if (!EVENT_TYPES.includes(String(event.event_type))) {
          defects.push(
            `${where}: event_type ${String(event.event_type)} is outside the vocabulary`,
          );
        }
        if (typeof event.actor !== 'string' || event.actor.trim() === '') {
          defects.push(`${where}: no actor`);
        }
        if (
          typeof event.occurred_at !== 'string' ||
          !Number.isFinite(Date.parse(event.occurred_at))
        ) {
          defects.push(`${where}: occurred_at is not a timestamp`);
        }
        const created = event.event_type === 'CREATED';
        if (created && event.reason !== null) defects.push(`${where}: CREATED carries a reason`);
        if (!created && (typeof event.reason !== 'string' || event.reason.trim() === '')) {
          defects.push(`${where}: ${String(event.event_type)} without a reason`);
        }
        // A finding born after the freeze starts with CREATED; a genesis finding never does.
        if (created !== (index === 0 && legacy === undefined)) {
          defects.push(
            `${where}: CREATED ${created ? 'where it may not stand' : 'missing'} ` +
              `(${legacy === undefined ? 'not in genesis' : 'a genesis finding'})`,
          );
        }
        // RESOLVED is not a target: only a merged trailer derives it.
        if (
          event.event_type === 'STATE_TRANSITIONED' &&
          !GIT_STATE_TARGETS.includes(String(event.payload?.to_state))
        ) {
          defects.push(`${where}: transitions to ${String(event.payload?.to_state)}`);
        }
        const anchor =
          index === 0 ? (legacy?.content_hash ?? genesisTip) : file.events[index - 1]?.content_hash;
        if (event.prev_hash !== anchor) defects.push(`${where}: prev_hash does not chain`);
        const { content_hash: stored, ...forHash } = event;
        if (stored !== sha256hex(canonicalJson(forHash))) {
          defects.push(`${where}: content_hash does not match the line`);
        }
      });
    }
    expect(defects).toEqual([]);
  });

  it('T6 — finding ids are unique over genesis ∪ files, and event ids over the store', () => {
    expect(store.length).toBeGreaterThan(0);
    const fileIds = store.map((file) => path.posix.basename(file.rel, '.jsonl'));
    expect(fileIds.filter((id, index) => fileIds.indexOf(id) !== index)).toEqual([]);
    const born = store
      .filter((file) => file.events[0]?.event_type === 'CREATED')
      .map((file) => String(file.events[0]?.finding_id));
    expect(born.filter((id) => genesisRows.has(id))).toEqual([]);
    const eventIds = store.flatMap((file) => file.events.map((event) => String(event.event_id)));
    expect(eventIds.filter((id, index) => eventIds.indexOf(id) !== index)).toEqual([]);
  });

  it('T6 — every owner_user an event writes is a CODEOWNERS handle in its CODEOWNERS spelling', () => {
    expect(store.length).toBeGreaterThan(0);
    const written = store.flatMap((file) =>
      file.events.flatMap((event) => {
        const fields =
          event.event_type === 'AMENDED'
            ? ((event.payload?.fields ?? {}) as Record<string, unknown>)
            : event.payload;
        const owner = fields?.owner_user;
        return typeof owner === 'string'
          ? [{ where: `${file.rel}:${String(event.version)}`, owner }]
          : [];
      }),
    );
    const stray = written
      .filter(({ owner }) => {
        const resolved = canonicalOwner(owner);
        return !resolved.ok || resolved.owner !== owner;
      })
      .map(({ where, owner }) => `${where}: ${owner}`);
    expect(stray).toEqual([]);
  });

  it('T7 — every event file at the base is a byte prefix of itself here, and none is deleted', () => {
    expect(store.length).toBeGreaterThan(0);
    const base = changeBase();
    const atBase = git(['ls-tree', '-r', '--name-only', base, '--', `${STORE_RELATIVE}/`])
      .toString('utf8')
      .split('\n')
      .filter(Boolean);
    const here = new Map(store.map((file) => [`${STORE_RELATIVE}/${file.rel}`, file.bytes]));
    const defects = atBase.flatMap((rel) => {
      const now = here.get(rel);
      if (now === undefined) return [`${rel}: deleted since ${base.slice(0, 12)}`];
      const before = git(['show', `${base}:${rel}`]);
      return now.subarray(0, before.length).equals(before)
        ? []
        : [`${rel}: rewritten since ${base.slice(0, 12)} (only appends are allowed)`];
    });
    expect(defects).toEqual([]);
  });

  it('T7 — once the base holds the freeze, genesis.json and findings.jsonl are byte-equal to the base', () => {
    const base = changeBase();
    // The cutover: a base with no genesis.json predates the freeze, so the segment may still
    // move (a landing that merged origin/main re-pins). From the freeze on, nothing moves it.
    if (!baseHoldsFreeze(base)) return;
    const defects = [GENESIS_RELATIVE, SEGMENT_RELATIVE].flatMap((rel) => {
      const file = path.join(REPO_ROOT, rel);
      if (!fs.existsSync(file)) return [`${rel}: deleted since ${base.slice(0, 12)}`];
      return fs.readFileSync(file).equals(git(['show', `${base}:${rel}`]))
        ? []
        : [
            `${rel}: changed since ${base.slice(0, 12)} (the freeze is final: record a change to ` +
              `a finding as an event, or restore the segment with \`ts-node ${BRANCH_REMEDY}\`)`,
          ];
    });
    expect(defects).toEqual([]);
  });
});
