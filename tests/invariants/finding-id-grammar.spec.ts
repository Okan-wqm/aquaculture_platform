/**
 * REG-ID — the registry finding-id space was exhausted for domain ARIA (999),
 * and the grammar of an id had no owner.
 *
 * ## Why
 *
 * `finding-registry add` refused with "Finding ID space exhausted for domain
 * ARIA (maximum 999)". The three-digit sequence was not one constant: it was
 * restated by hand at every site that read, wrote, sorted or matched an id —
 * the allocator, the explicit-append check, the orphan heading, the Closes
 * trailer grammar, the row schema, the reservation ledger, the kernel's
 * readers — each spelling it with its own digit count (`\d{3}`, `[0-9]{3,}`,
 * `\d+`, `padStart(3`, `slice(-3)`). Widening any one of them leaves the rest
 * refusing the ids the first one issues. The root fix is one owner per language
 * (tools/gates/finding-id-grammar.ts; aria-kernel/aria_kernel/finding_id_grammar.py),
 * both held to one table (tools/gates/fixtures/finding-id-grammar-table.json).
 *
 * ## What this file pins
 *
 *   - the projection and the closer derivation work on a four-digit id: a
 *     `Closes: <review>#ARIA-HIGH-1000` trailer closes ARIA-HIGH-1000 and
 *     neither ARIA-HIGH-100 nor ARIA-HIGH-1001 (a prefix is not the id), run
 *     through the real CLI on a real history;
 *   - the store reads, folds and mirrors its logs with 1000 AFTER 999, not
 *     between 100 and 999 as a text sort of the paths puts it, and the ledger
 *     parity (which orders by id again) agrees with the fold;
 *   - DETECTABLE: no file under tools/, tests/ or aria-kernel/ restates the
 *     id grammar with a digit count of its own instead of taking it from the
 *     owner, and every reader that used to restate it imports the owner.
 *
 * The exemptions are the two owners, their two table tests, and this file
 * (which spells the shapes it looks for). A site that is not a finding id by
 * the registry's grammar (a dialect with a severity the registry does not
 * have, such as the `NIT` of the deferral matcher) does not match the shapes
 * and is not on a list: the shapes are the registry's four severities and the
 * domain-classifier-sequence segments.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { mirrorDifferences, storeEvents } from '../../tools/gates/finding-event-ledger';
import { type Finding } from '../../tools/gates/finding-registry-chain';
import {
  foldRegistry,
  readRegistryStoreIn,
  registryLayout,
} from '../../tools/gates/finding-registry-projection';
import { removeFixtureTree } from '../../tools/gates/fixture-tree';
import {
  createdPayload,
  eventFilePath,
  nextEvent,
  serializeEvents,
} from './helpers/finding-event-fixture';
import {
  closesTrailer,
  fixtureFinding,
  type ProjectionRun,
  REGISTRY_RELATIVE_PATH,
  RegistryFixtureRepo,
} from './helpers/registry-fixture-repo';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CLI_TEST_TIMEOUT_MS = 180_000;

describe('REG-ID — a four-digit finding id is projected and closed like any other', () => {
  const repo = RegistryFixtureRepo.create('reg-id-projection-');
  const shas = { close100: '', close1000: '' };

  beforeAll(() => {
    repo.writeRegistry([
      fixtureFinding('ARIA-HIGH-100'),
      fixtureFinding('ARIA-HIGH-999'),
      fixtureFinding('ARIA-HIGH-1000'),
      fixtureFinding('ARIA-HIGH-1001'),
    ]);
    repo.commit('chore(registry): seed the four-digit fixture registry', '2026-10-01T10:00:00Z');
    shas.close100 = repo.commit(
      `fix(fixture): close 100\n\n${closesTrailer('ARIA-HIGH-100')}`,
      '2026-10-02T10:00:00Z',
    );
    shas.close1000 = repo.commit(
      `fix(fixture): close 1000\n\n${closesTrailer('ARIA-HIGH-1000')}`,
      '2026-10-03T10:00:00Z',
    );
  });

  afterAll(() => repo.dispose());

  function projected(run: ProjectionRun): Map<string, Finding> {
    expect({ status: run.status, stderr: run.status === 0 ? '' : run.stderr }).toEqual({
      status: 0,
      stderr: '',
    });
    return new Map(run.rows.map((row) => [row.id, row]));
  }

  it(
    'closes ARIA-HIGH-1000 by its own trailer, and neither its prefix nor its neighbour',
    () => {
      const rows = projected(repo.project());
      const closed = rows.get('ARIA-HIGH-1000');
      expect(closed?.state).toBe('RESOLVED');
      expect(closed?.closing_commits).toEqual([shas.close1000]);
      // A trailer for 1000 is not a trailer for 100 or 1001, and the other way round.
      const prefix = rows.get('ARIA-HIGH-100');
      expect(prefix?.state).toBe('RESOLVED');
      expect(prefix?.closing_commits).toEqual([shas.close100]);
      expect(rows.get('ARIA-HIGH-1001')?.state).toBe('OPEN');
      expect(rows.get('ARIA-HIGH-999')?.state).toBe('OPEN');
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it(
    'answers a request for the four-digit id alone',
    () => {
      const rows = projected(repo.project(['--ids', 'ARIA-HIGH-1000']));
      expect([...rows.keys()]).toEqual(['ARIA-HIGH-1000']);
      expect(rows.get('ARIA-HIGH-1000')?.state).toBe('RESOLVED');
    },
    CLI_TEST_TIMEOUT_MS,
  );

  it('writes nothing', () => {
    projected(repo.project());
    expect(repo.status()).toBe('');
    expect(readFileSync(join(repo.root, REGISTRY_RELATIVE_PATH), 'utf8')).toContain(
      '"id":"ARIA-HIGH-1000"',
    );
  });
});

describe('REG-ID — the store orders four-digit ids as numbers', () => {
  let root = '';

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'reg-id-order-'));
    // Written out of order: the store's order is the reader's, not the writer's.
    for (const id of ['ARIA-LOW-999', 'ARIA-LOW-1001', 'ARIA-LOW-100', 'ARIA-LOW-1000']) {
      const created = nextEvent(id, [], '0'.repeat(64), {
        event_type: 'CREATED',
        payload: createdPayload(fixtureFinding(id)),
        reason: null,
        occurred_at: '2026-10-01T00:00:00.000Z',
      });
      const path = join(root, eventFilePath(id));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, serializeEvents([created]), 'utf8');
    }
  });

  afterAll(() => removeFixtureTree(root));

  const EXPECTED = ['ARIA-LOW-100', 'ARIA-LOW-999', 'ARIA-LOW-1000', 'ARIA-LOW-1001'];

  it('folds 1000 after 999, not between 100 and 999', () => {
    const store = readRegistryStoreIn(registryLayout(join(root, 'docs/reviews/_registry')).dir);
    expect(foldRegistry(store).map((row) => row.id)).toEqual(EXPECTED);
  });

  it('lists the events in the same order, and a ledger of exactly those lines is in parity', () => {
    const store = readRegistryStoreIn(join(root, 'docs/reviews/_registry'));
    const events = storeEvents(store);
    expect(events.map((event) => event.finding_id)).toEqual(EXPECTED);
    // The ledger rebuilds the store with its own ordering of the same ids: a
    // fold that disagrees with the registry's is a parity failure on every
    // mirror once the first four-digit id lands.
    expect(mirrorDifferences(store, events)).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// DETECTABLE — one owner of the grammar, found by a scan rather than a list.
// -----------------------------------------------------------------------------

const OWNER_TS = 'tools/gates/finding-id-grammar.ts';
const OWNER_PY = 'aria-kernel/aria_kernel/finding_id_grammar.py';
const TABLE_TEST_TS = 'tests/invariants/finding-id-grammar-table.spec.ts';
const TABLE_TEST_PY = 'aria-kernel/tests/test_finding_id_grammar.py';
const THIS_SPEC = 'tests/invariants/finding-id-grammar.spec.ts';
const EXEMPT = new Set([OWNER_TS, OWNER_PY, TABLE_TEST_TS, TABLE_TEST_PY, THIS_SPEC]);
const SCANNED_ROOTS = ['tools', 'tests', 'aria-kernel'];
const SCANNED_EXTENSION = /\.(?:ts|mjs|js|py)$/;

/** A digit class (`\d` or `[0-9]`) and any quantifier on it: a count of the sequence's own. */
const DIGITS = String.raw`(?:\\d|\[0-9\])(?:\{\d+(?:,\d*)?\}|\+|\*)`;

/**
 * The shapes a restated finding-id grammar takes, each as it is typed in a
 * regex source: the registry's four severities closed by `)` and followed by
 * the sequence; a `[A-Z0-9]+` classifier segment followed by it; the ORPHAN
 * heading's optional classifier followed by it. `NIT`-style dialects do not
 * close the four severities, so they are not these shapes.
 */
const RESTATEMENT_SHAPES: ReadonlyArray<{ readonly name: string; readonly test: RegExp }> = [
  {
    name: 'the four severities, then a digit count',
    test: new RegExp(String.raw`CRITICAL\|HIGH\|MEDIUM\|LOW\)\??-[^'"\x60\n]{0,14}?${DIGITS}`),
  },
  {
    name: 'a classifier segment, then a digit count',
    test: new RegExp(String.raw`\[A-Z0-9\]\+\)?-\(?${DIGITS}`),
  },
  {
    name: 'the ORPHAN heading form, then a digit count',
    test: new RegExp(String.raw`ORPHAN-\(\?:\[A-Z\]\+-\)\?\(${DIGITS}`),
  },
  {
    name: 'a sequence padded to three digits',
    test: /padStart\(3\b(?=.*(?:domain|sequence|severity|finding|ARIA-|ORPHAN|-HIGH-|-LOW-|-CRITICAL-|-MEDIUM-))|(?<=(?:domain|sequence|severity|finding|ARIA-|ORPHAN|-HIGH-|-LOW-|-CRITICAL-|-MEDIUM-).*)padStart\(3\b/,
  },
  {
    name: 'a sequence read as the last three characters of an id',
    test: /parseInt\([^)]*slice\(-3\)/,
  },
];

const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*|#)/;

/** The shapes `line` restates, none for a comment line. */
function restatementsIn(line: string): string[] {
  if (COMMENT_LINE.test(line)) return [];
  return RESTATEMENT_SHAPES.filter((shape) => shape.test.test(line)).map((shape) => shape.name);
}

function scannedFiles(): string[] {
  return execFileSync(
    'git',
    [
      '-C',
      REPO_ROOT,
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      ...SCANNED_ROOTS,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\0')
    .filter((file) => file !== '' && SCANNED_EXTENSION.test(file) && !EXEMPT.has(file));
}

describe('REG-ID — the detector is not blind and not trigger-happy', () => {
  // Each line is a site this repository restated the grammar at, as it stood
  // at the base of REG-ID; the detector must see every one of them.
  const RESTATEMENTS: readonly string[] = [
    'const FINDING_ID_RX = /\\b[A-Z]+-(?:CRITICAL|HIGH|MEDIUM|LOW)-\\d{3}\\b/g;',
    'FINDING_ID_RE = re.compile(r"^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-(CRITICAL|HIGH|MEDIUM|LOW)-[0-9]{3,}$")',
    '_FINDING_ID_RE = re.compile(r"^[A-Z]+(?:-[A-Z]+)*-(?:CRITICAL|HIGH|MEDIUM|LOW)-\\d+$")',
    'const idParts = /^([A-Z][A-Z0-9]*)-([A-Z0-9]+)-([0-9]{3})$/.exec(stub.id);',
    'const domainPattern = new RegExp(`^${domain}-[A-Z0-9]+-([0-9]{3})$`);',
    'export const ORPHAN_MD_HEADING_REGEX = /^##\\s+(ORPHAN-(?:[A-Z]+-)?(\\d{3})[a-z]?)\\b/;',
    "return `${domain}-${severity}-${String(next).padStart(3, '0')}`;",
    "existingIds.push(`${domain}-RESERVED-${String(reserved.sequence).padStart(3, '0')}`);",
    'if (Number.parseInt(next.slice(-3), 10) <= Number.parseInt(match[2], 10)) {',
    'const shortForm = e.id.match(/^P0-(?:CRITICAL|HIGH|MEDIUM|LOW)-0*(\\d+)$/);',
    '  /^Closes:\\s+(\\S+?)#([A-Z][A-Z0-9]+-(?:CRITICAL|HIGH|MEDIUM|LOW)-\\d{3}|F-\\d{3})\\s*$/;',
  ];
  // Lines that spell a different grammar, or no grammar: the F-NNN and DEBT
  // families, an ADR number, the NIT dialect, an unrelated padded counter, a
  // severity with no sequence, and a comment that quotes a restatement.
  const NOT_RESTATEMENTS: readonly string[] = [
    '/^F-\\d{3}$/.test(id) || /^F-AUTO-V\\d+\\.\\d+(?:-[A-Z0-9-]+)+$/.test(id) ||',
    '/^DEBT-\\d{4}-\\d{2}-\\d{2}-\\d{3}$/.test(id)',
    'const STRUCTURED = /(ADR-\\d+)|(\\bW\\d+(\\.\\d+)?\\b)/i;',
    'const FINDING_ID = /\\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-(?:CRITICAL|HIGH|MEDIUM|LOW|NIT)-\\d{2,}\\b/g;',
    "join(evidenceDirectory, `${String(index).padStart(3, '0')}.json`),",
    'const SEVERITY = /^(CRITICAL|HIGH|MEDIUM|LOW)$/;',
    'r"^F-\\d{3,}$"',
    ' * `ORPHAN-(CRITICAL|HIGH|MEDIUM|LOW)-\\d{3}` form skipped 16 real',
    '# FINDING_ID_RE = ^[A-Z]+-(CRITICAL|HIGH|MEDIUM|LOW)-\\d{3}$',
  ];

  it('sees every restatement the repository carried', () => {
    for (const line of RESTATEMENTS) {
      expect({ line, shapes: restatementsIn(line).length > 0 }).toEqual({ line, shapes: true });
    }
  });

  it('leaves a different grammar, an unrelated counter and a comment alone', () => {
    for (const line of NOT_RESTATEMENTS) {
      expect({ line, shapes: restatementsIn(line) }).toEqual({ line, shapes: [] });
    }
  });
});

describe('REG-ID — the finding-id grammar has one owner per language', () => {
  it('both owners and both table tests exist', () => {
    for (const file of [OWNER_TS, OWNER_PY, TABLE_TEST_TS, TABLE_TEST_PY]) {
      expect({ file, exists: existsSync(resolve(REPO_ROOT, file)) }).toEqual({
        file,
        exists: true,
      });
    }
  });

  it('no file under tools/, tests/ or aria-kernel/ restates it with a digit count of its own', () => {
    const restated: string[] = [];
    for (const file of scannedFiles()) {
      readFileSync(resolve(REPO_ROOT, file), 'utf8')
        .split('\n')
        .forEach((line, index) => {
          for (const shape of restatementsIn(line)) {
            restated.push(`${file}:${index + 1} [${shape}] ${line.trim().slice(0, 140)}`);
          }
        });
    }
    expect(restated).toEqual([]);
  });

  it('every reader that restated it now takes it from the owner', () => {
    const readers: ReadonlyArray<{ file: string; owner: RegExp }> = [
      { file: 'tools/gates/finding-registry-store.ts', owner: /finding-id-grammar/ },
      { file: 'tools/gates/finding-registry.ts', owner: /finding-id-grammar/ },
      { file: 'tools/gates/commit-msg-validator.ts', owner: /finding-id-grammar/ },
      { file: 'aria-kernel/aria_kernel/plan_origin.py', owner: /finding_id_grammar/ },
      { file: 'aria-kernel/aria_kernel/plan_convergence.py', owner: /finding_id_grammar/ },
      { file: 'aria-kernel/aria_kernel/adapter_quarantine.py', owner: /finding_id_grammar/ },
      { file: 'aria-kernel/aria_kernel/twin.py', owner: /finding_id_grammar/ },
    ];
    const missing = readers
      .filter(({ file, owner }) => !owner.test(readFileSync(resolve(REPO_ROOT, file), 'utf8')))
      .map(({ file }) => file);
    expect(missing).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// RECALL — ARIA-MEDIUM-1001. The shapes above are the spellings the repository
// carried when REG-ID began; a detector that knows only yesterday's spellings
// does not make the next one detectable. The lines below are spellings an author
// would write next, and the sites the first scan did not see.
// -----------------------------------------------------------------------------

interface QuotedLine {
  readonly why: string;
  readonly line: string;
}

describe('REG-ID — the detector sees the restatement an author would write next', () => {
  // Each line is a spelling of the grammar with a digit count of its own that none
  // of the shapes above was written for. The first eight are the audit's probe of
  // the invariant; the real sites among them are quoted as they stood.
  const NATURAL_RESTATEMENTS: readonly QuotedLine[] = [
    {
      why: 'three of the four severities',
      line: String.raw`const A = /^[A-Z]+-(HIGH|MEDIUM|LOW)-\d{3}$/;`,
    },
    { why: 'two class segments', line: String.raw`const B = /^([A-Z]+)-([A-Z]+)-(\d{3})$/;` },
    { why: 'two class segments, Python', line: String.raw`X = re.compile(r"[A-Z]+-[A-Z]+-\d{3}")` },
    {
      why: 'a RegExp built from a template literal',
      line: 'const C = new RegExp(`^${domain}-[A-Z]+-\\\\d{3}$`);',
    },
    {
      why: 'the last segment padded to three',
      line: 'const seq = id.split("-").pop().padStart(3, "0");',
    },
    { why: 'the last three characters read as a number', line: 'const n = Number(id.slice(-3));' },
    {
      why: 'a classifier alternation that is not a severity (scripts/ci/check-advisory-ignore-sync.ts)',
      line: String.raw`const FINDING_ID_RE = /\b(?:[A-Z][A-Z0-9]*-)+(?:CI|CVE)-\d{3}\b|\bRUST-CVE-\d{3}\b/;`,
    },
    {
      why: 'a bounded sequence after a chain of domain segments (aria_kernel/system_one.py)',
      line: String.raw`_FINDING_ID_RE = re.compile(r"^[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-[0-9]{1,6}$")`,
    },
    {
      why: 'word-character segments',
      line: String.raw`const m = /^(\w+)-(\w+)-(\d{3})$/.exec(id);`,
    },
    {
      why: 'named groups, Python',
      line: String.raw`FID = re.compile(r"(?P<domain>[A-Z]+)-(?P<severity>[A-Z]+)-(?P<seq>\d{3})")`,
    },
    {
      why: 'a RegExp built from a string literal',
      line: String.raw`const D = new RegExp('^[A-Z]+-(?:CRITICAL|HIGH)-\\d{3}$');`,
    },
    {
      why: 'an f-string with a doubled brace',
      line: String.raw`ID = re.compile(rf"^{domain}-[A-Z]+-\d{{3}}$")`,
    },
    {
      why: 'the last three characters read as a number, Python',
      line: 'sequence = int(finding_id[-3:])',
    },
    {
      why: 'the last segment padded to three, Python',
      line: 'sequence = finding_id.split("-")[-1].zfill(3)',
    },
  ];

  // Lines that spell no finding id, or an id of another family, and that a detector
  // casting a wider net must still leave alone.
  const OTHER_GRAMMARS: readonly string[] = [
    // The NIT dialect of the deferral matchers (tools/gates/banned-phrase.ts): a
    // severity the registry does not have, with a two-or-three-digit tracking number.
    String.raw`  /(ADR-\d+)|(#?[A-Z][A-Z0-9]+-(CRITICAL|HIGH|MEDIUM|LOW|NIT)-\d{2,3})|(\b[A-Z]+-\d{2,3}-FU-\d{1,3}\b)/i;`,
    String.raw`const GHSA = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;`,
    String.raw`const RUSTSEC_RE = /RUSTSEC-\d{4}-\d{4}/g;`,
    String.raw`const ADR_FILE = /^ADR-\d{3}-[a-z-]+\.md$/;`,
    String.raw`const DATE = /^\d{4}-\d{2}-\d{2}$/;`,
    String.raw`const SEMVER = /^v\d{3}\.\d{3}$/;`,
    'const tail = path.slice(-3);',
    'self.assertEqual(limited[-3:], ["bwrap", "--", "claude"])',
    'latest = pending[-3:]',
    'return f"F-{last_num + 1:03d}"',
    'cycle_id=f"cyc-{i:03d}",',
    'name = f"{index:03d}.json"',
    'label = str(index).zfill(3)',
    String.raw`// const B = /^([A-Z]+)-([A-Z]+)-(\d{3})$/ was the base spelling`,
    String.raw`# X = re.compile(r"[A-Z]+-[A-Z]+-\d{3}")`,
    String.raw` * the /^(\w+)-(\w+)-(\d{3})$/ form was one of them`,
  ];

  it('sees every spelling of the grammar with a digit count of its own', () => {
    const missed = NATURAL_RESTATEMENTS.filter(({ line }) => restatementsIn(line).length === 0);
    expect(missed).toEqual([]);
  });

  it('leaves a different family, a plain slice or counter and a comment alone', () => {
    const flagged = OTHER_GRAMMARS.map((line) => ({ line, shapes: restatementsIn(line) })).filter(
      ({ shapes }) => shapes.length > 0,
    );
    expect(flagged).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// ARIA-LOW-1003 — the scan's roots. A restatement outside tools/, tests/ and
// aria-kernel/ is not seen by the scan above; scripts/ is where CI's plain-node
// gates live, and one of them spelled the grammar there.
// -----------------------------------------------------------------------------

describe('REG-ID — the scripts CI runs under plain node spell no finding-id grammar of their own', () => {
  // A script cannot always call the TypeScript owner. Each exemption names the
  // pin that holds its own spelling to the owner's table.
  const HELD_TO_THE_TABLE: ReadonlyMap<string, string> = new Map([
    [
      'scripts/ci/lib/reviewed-exception.mjs',
      'plain ESM that CI runs with node; tests/invariants/finding-id-reviewed-exception.spec.ts holds it to the one table',
    ],
  ]);

  function scriptRestatements(files: readonly string[]): string[] {
    const restated: string[] = [];
    for (const file of files) {
      readFileSync(resolve(REPO_ROOT, file), 'utf8')
        .split('\n')
        .forEach((line, index) => {
          for (const shape of restatementsIn(line)) {
            restated.push(`${file}:${index + 1} [${shape}] ${line.trim().slice(0, 140)}`);
          }
        });
    }
    return restated;
  }

  function scriptFiles(): string[] {
    return execFileSync(
      'git',
      [
        '-C',
        REPO_ROOT,
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        'scripts',
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
      .split('\0')
      .filter((file) => file !== '' && SCANNED_EXTENSION.test(file));
  }

  it('no script restates it, except the ones held to the table', () => {
    const scanned = scriptFiles().filter((file) => !HELD_TO_THE_TABLE.has(file));
    expect(scanned.length).toBeGreaterThan(20);
    expect(scriptRestatements(scanned)).toEqual([]);
  });

  it('each exemption still restates it, so the list stays honest', () => {
    for (const file of HELD_TO_THE_TABLE.keys()) {
      expect({ file, restated: scriptRestatements([file]).length > 0 }).toEqual({
        file,
        restated: true,
      });
    }
  });
});
