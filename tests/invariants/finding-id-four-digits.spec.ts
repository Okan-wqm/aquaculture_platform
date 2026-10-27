/**
 * REG-ID — what the finding-registry writers and the commit-msg gate do with a
 * four-digit finding id (1000..9999), run in process on throwaway registries.
 *
 * ## Why
 *
 * `finding-registry add` refused with "Finding ID space exhausted for domain
 * ARIA (maximum 999)": ARIA ids 974..999 were claimed and every package that
 * registers a finding in that domain failed. The sequence was three digits in
 * the allocator (`nextFindingId`), in the sequences it reads from the ids it is
 * handed (`claimedSequences`), in the markdown orphan store's heading pattern,
 * in the reservation ledger (`sequence > 999`, `findingId.slice(-3)`), in the
 * explicit-append shape and its message ("between 001 and 999"), in the
 * narrative import, and in the commit-msg gate's `Closes:` grammar. The fix is
 * one owner of the grammar (tools/gates/finding-id-grammar.ts), not a larger
 * constant at each of them; this file pins what each of those sites then does.
 *
 * ## What it pins
 *
 *   - the id after `ARIA-LOW-999` is `ARIA-<SEVERITY>-1000`, for every severity,
 *     and the one after that is 1001; the maximum is taken as a number (999 is
 *     below 1000); 9999 is the last id, and running out is a NAMED error;
 *   - sequences are read from four-digit ids and only from ids the grammar
 *     spells (no fifth digit, no leading zero past three digits);
 *   - the markdown orphan store's headings carry four-digit sequences to the
 *     allocator;
 *   - `add-explicit ARIA-LOW-1000` is admitted and collides by SEQUENCE with
 *     ARIA-HIGH-1000; `…-0999`, `…-01000`, a fifth digit and two digits are
 *     refused and write nothing; a zero suffix is refused naming 9999;
 *   - the reservation ledger holds and advances a four-digit sequence;
 *   - the narrative import admits ORPHAN-HIGH-1000 and refuses a leading zero;
 *   - the commit-msg gate reads a four-digit `Closes:` trailer (and the table
 *     the Python owner is held to), a four-digit orphan heading, and routes a
 *     four-digit trailer to the registry and orphan stores like any other id.
 *
 * These specs live here, not in tools/gates/finding-registry-store.spec.ts or
 * commit-msg-validator.spec.ts, because the pre-commit hook runs every
 * tools/gates spec and a red one there cannot be committed; the specs the gate
 * owns are updated by the implementation (the exhaustion case that names 999).
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  CLOSES_TRAILER_REGEX,
  type Commit,
  ORPHAN_HEADING_REGEX,
  validateCommit,
} from '../../tools/gates/commit-msg-validator';
import {
  appendAllocatedFinding,
  appendExplicitFinding,
  appendNarrativeFinding,
  type FindingAllocationAuthority,
} from '../../tools/gates/finding-registry';
import type { Finding } from '../../tools/gates/finding-registry-chain';
import {
  foldRegistry,
  readRegistryStoreIn,
  registryLayout,
  type RegistryLayout,
} from '../../tools/gates/finding-registry-projection';
import {
  claimedSequences,
  type FindingSeverity,
  nextFindingId,
  orphanMarkdownReservedIds,
  readOrphanMarkdownStore,
  withRegistryFileLock,
} from '../../tools/gates/finding-registry-store';
import type { FindingTrailerTarget } from '../../tools/gates/finding-traceability';
import { removeFixtureTree } from '../../tools/gates/fixture-tree';

const REGISTRY_SOURCE_DIR = resolve(__dirname, '..', '..', 'docs', 'reviews', '_registry');
const GRAMMAR_TABLE = JSON.parse(
  readFileSync(
    resolve(__dirname, '..', '..', 'tools', 'gates', 'fixtures', 'finding-id-grammar-table.json'),
    'utf8',
  ),
) as { accept: ReadonlyArray<{ id: string }>; reject: readonly string[] };

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;

let fixtureRoot = '';

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'reg-id-four-digits-'));
});

afterAll(() => removeFixtureTree(fixtureRoot));

/** An empty registry directory: an empty genesis segment and the row and event contracts. */
function emptyRegistry(name: string): RegistryLayout {
  const layout = registryLayout(join(fixtureRoot, name));
  mkdirSync(layout.dir, { recursive: true });
  writeFileSync(layout.genesisPath, '', 'utf8');
  copyFileSync(join(REGISTRY_SOURCE_DIR, 'findings.jsonl.schema.json'), layout.rowSchemaPath);
  copyFileSync(join(REGISTRY_SOURCE_DIR, 'finding-event.schema.json'), layout.eventSchemaPath);
  return layout;
}

function recordedRows(layout: RegistryLayout): Finding[] {
  return foldRegistry(readRegistryStoreIn(layout.dir));
}

/** The recorded ids in one text order, so an assertion does not depend on the store's order. */
function sortedIds(layout: RegistryLayout): string[] {
  return recordedRows(layout)
    .map((row) => row.id)
    .sort();
}

/** A schema-valid, accountable stub of `severity`; an `id` makes it an explicit-id stub. */
function stub(name: string, severity: FindingSeverity, id?: string): string {
  const path = join(fixtureRoot, `${name}-stub.json`);
  writeFileSync(
    path,
    JSON.stringify({
      ...(id === undefined ? {} : { id }),
      severity,
      state: 'OPEN',
      title: `REG-ID fixture finding ${name}`,
      evidence: ['tests/invariants/finding-id-four-digits.spec.ts:reg-id'],
      owner_agent: 'context-manager',
      owner_user: 'Okan-wqm',
      deadline: '2026-12-31',
      raised_in_cycle: '2026-10-25-reg-id',
      created_at: '2026-10-20T00:00:00.000Z',
    }),
    'utf8',
  );
  return path;
}

function explicit(layout: RegistryLayout, stubPath: string): number {
  return withRegistryFileLock(layout.dir, (lease) =>
    appendExplicitFinding(stubPath, lease, layout),
  );
}

function allocate(domain: string, layout: RegistryLayout, stubPath: string): number {
  return withRegistryFileLock(layout.dir, (lease) =>
    appendAllocatedFinding(domain, stubPath, lease, layout),
  );
}

/** What `run` writes to stderr, and its exit status. */
function withStderr(run: () => number): { status: number; stderr: string } {
  const written: string[] = [];
  const write = jest
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      written.push(String(chunk));
      return true;
    });
  try {
    const status = run();
    return { status, stderr: written.join('') };
  } finally {
    write.mockRestore();
  }
}

describe('REG-ID — the allocator', () => {
  it('allocates 1000 after 999 for every severity, and 9999 last', () => {
    for (const severity of SEVERITIES) {
      expect(nextFindingId('ARIA', severity, ['ARIA-LOW-998', 'ARIA-LOW-999'])).toBe(
        `ARIA-${severity}-1000`,
      );
    }
    expect(nextFindingId('ARIA', 'LOW', ['ARIA-LOW-9998'])).toBe('ARIA-LOW-9999');
  });

  it('takes the maximum sequence as a number, never as text', () => {
    // As text '999' > '1000' > '100', so a text maximum would answer 1000 here.
    expect(
      nextFindingId('ARIA', 'HIGH', ['ARIA-HIGH-999', 'ARIA-LOW-1000', 'ARIA-MEDIUM-100']),
    ).toBe('ARIA-HIGH-1001');
  });

  it('refuses past 9999 with a named error that says what ran out', () => {
    let thrown: unknown;
    try {
      nextFindingId('INFRA', 'CRITICAL', ['INFRA-LOW-9999']);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RangeError);
    expect((thrown as Error).name).toBe('FindingIdSpaceExhaustedError');
    expect((thrown as Error).message).toMatch(/space exhausted.*INFRA.*9999/s);
  });

  it('reads sequences from four-digit ids, and only from ids the grammar spells', () => {
    const claimed = claimedSequences('ARIA', [
      'ARIA-LOW-999',
      'ARIA-HIGH-1000',
      'ARIA-MEDIUM-9999',
      'ARIA-HIGH-10000', // five digits: not an id
      'ARIA-HIGH-0999', // a leading zero past three digits: not an id
      'ARIA-LOW-99', // two digits: not an id
    ]);
    expect([...claimed].sort((a, b) => a - b)).toEqual([999, 1000, 9999]);
    // The synthetic form the allocator is handed carries four digits too.
    expect(claimedSequences('ORPHAN', ['ORPHAN-RESERVED-1000']).has(1000)).toBe(true);
  });

  it('carries a four-digit heading of the markdown orphan store to the allocator', () => {
    const path = join(fixtureRoot, 'orphan-four-digit.md');
    writeFileSync(
      path,
      [
        '# Orphan findings',
        '',
        '## ORPHAN-HIGH-1000 — canonical, four digits',
        '## ORPHAN-1001 — bare, four digits',
        '## ORPHAN-LOW-1002b — suffixed re-open, four digits',
        '## ORPHAN-HIGH-10000 — five digits, not an id',
        '',
      ].join('\n'),
      'utf8',
    );
    const store = readOrphanMarkdownStore(path);
    // A heading the reader cannot see is a sequence the allocator reuses.
    expect([...store.ids].sort()).toEqual(['ORPHAN-1001', 'ORPHAN-HIGH-1000', 'ORPHAN-LOW-1002b']);
    expect([...store.sequences].sort((a, b) => a - b)).toEqual([1000, 1001, 1002]);
    expect(
      nextFindingId('ORPHAN', 'HIGH', ['ORPHAN-CRITICAL-332', ...orphanMarkdownReservedIds(path)]),
    ).toBe('ORPHAN-HIGH-1003');
  });
});

describe('REG-ID — the registry writers', () => {
  it('allocate past ARIA-LOW-999 into four digits, for every severity', () => {
    for (const severity of SEVERITIES) {
      const layout = emptyRegistry(`after-999-${severity}`);
      // The last three-digit id is still admitted.
      expect(explicit(layout, stub(`seed-${severity}`, 'LOW', 'ARIA-LOW-999'))).toBe(0);
      expect({
        severity,
        exit: allocate('ARIA', layout, stub(`first-${severity}`, severity)),
      }).toEqual({
        severity,
        exit: 0,
      });
      expect({
        severity,
        exit: allocate('ARIA', layout, stub(`second-${severity}`, severity)),
      }).toEqual({
        severity,
        exit: 0,
      });
      expect(sortedIds(layout)).toEqual(
        ['ARIA-LOW-999', `ARIA-${severity}-1000`, `ARIA-${severity}-1001`].sort(),
      );
    }
  });

  it('refuses to allocate past ARIA-LOW-9999, naming the domain and the maximum, and writes nothing', () => {
    const layout = emptyRegistry('exhausted');
    expect(explicit(layout, stub('last-id', 'LOW', 'ARIA-LOW-9999'))).toBe(0);
    const before = sortedIds(layout);
    const refused = withStderr(() => allocate('ARIA', layout, stub('past-the-last', 'HIGH')));
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/space exhausted.*ARIA.*9999/s);
    expect(sortedIds(layout)).toEqual(before);
  });

  it('add-explicit admits ARIA-LOW-1000, collides by sequence, and refuses a suffix the grammar does not spell', () => {
    const layout = emptyRegistry('explicit');
    expect(explicit(layout, stub('explicit-1000', 'LOW', 'ARIA-LOW-1000'))).toBe(0);
    expect(sortedIds(layout)).toEqual(['ARIA-LOW-1000']);

    // The sequence is the identity: another classifier of the same sequence collides.
    expect(explicit(layout, stub('explicit-dup', 'HIGH', 'ARIA-HIGH-1000'))).toBe(1);

    const before = sortedIds(layout);
    for (const id of ['ARIA-LOW-0999', 'ARIA-LOW-01000', 'ARIA-LOW-10000', 'ARIA-LOW-99']) {
      expect({ id, exit: explicit(layout, stub(`explicit-bad-${id}`, 'LOW', id)) }).toEqual({
        id,
        exit: 2,
      });
      expect(sortedIds(layout)).toEqual(before);
    }
  });

  it('add-explicit names the real range when the suffix is zero', () => {
    const layout = emptyRegistry('explicit-zero');
    const refused = withStderr(() =>
      explicit(layout, stub('explicit-zero', 'LOW', 'ARIA-LOW-000')),
    );
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/between 001 and 9999/);
    expect(sortedIds(layout)).toEqual([]);
  });

  describe('under a reservation ledger', () => {
    interface ReservationRecord {
      readonly sequence: number;
      readonly finding_id: string;
      readonly registry_path: string;
    }

    const authorityFor = (name: string, layout: RegistryLayout): FindingAllocationAuthority => ({
      lockPath: join(fixtureRoot, `${name}.lock`),
      reservationPath: join(fixtureRoot, `${name}-reservations.json`),
      activeRegistryPaths: () => [layout.dir],
    });

    const ledger = (layout: RegistryLayout, findingId: string, sequence: number): string =>
      JSON.stringify({
        version: 1,
        domains: {
          ARIA: {
            sequence,
            finding_id: findingId,
            reserved_at: '2026-10-20T00:00:00.000Z',
            registry_path: layout.dir,
          },
        },
      });

    const reserved = (authority: FindingAllocationAuthority): ReservationRecord | undefined =>
      (
        JSON.parse(readFileSync(authority.reservationPath, 'utf8')) as {
          domains: Record<string, ReservationRecord>;
        }
      ).domains['ARIA'];

    const allocateUnder = (
      layout: RegistryLayout,
      authority: FindingAllocationAuthority,
      stubPath: string,
    ): number =>
      withRegistryFileLock(
        layout.dir,
        (lease) => appendAllocatedFinding('ARIA', stubPath, lease, layout, authority),
        { lockPath: authority.lockPath },
      );

    it('a ledger at 999 hands out 1000 and records it', () => {
      const layout = emptyRegistry('ledger-999');
      const authority = authorityFor('ledger-999', layout);
      writeFileSync(authority.reservationPath, ledger(layout, 'ARIA-LOW-999', 999), 'utf8');

      expect(allocateUnder(layout, authority, stub('ledger-999', 'HIGH'))).toBe(0);
      expect(sortedIds(layout)).toEqual(['ARIA-HIGH-1000']);
      expect(reserved(authority)?.sequence).toBe(1000);
      expect(reserved(authority)?.finding_id).toBe('ARIA-HIGH-1000');
      expect(reserved(authority)?.registry_path).toBe(layout.dir);
    });

    it('a ledger that already holds a four-digit record is valid and advances', () => {
      const layout = emptyRegistry('ledger-1000');
      const authority = authorityFor('ledger-1000', layout);
      writeFileSync(authority.reservationPath, ledger(layout, 'ARIA-LOW-1000', 1000), 'utf8');

      expect(allocateUnder(layout, authority, stub('ledger-1000', 'MEDIUM'))).toBe(0);
      expect(sortedIds(layout)).toEqual(['ARIA-MEDIUM-1001']);
      expect(reserved(authority)?.sequence).toBe(1001);
      expect(reserved(authority)?.finding_id).toBe('ARIA-MEDIUM-1001');
    });
  });

  describe('the narrative import', () => {
    const REVIEW_FILE = 'docs/reviews/orphan-findings.md';

    function narrativeFixture(
      name: string,
      id: string,
    ): { layout: RegistryLayout; run: () => number } {
      const layout = emptyRegistry(name);
      const narrativePath = join(fixtureRoot, `${name}.md`);
      const stubPath = join(fixtureRoot, `${name}-narrative-stub.json`);
      writeFileSync(narrativePath, `## ${id} — historical narrative — RESOLVED\n`, 'utf8');
      writeFileSync(
        stubPath,
        JSON.stringify({
          id,
          severity: 'HIGH',
          state: 'RESOLVED',
          title: 'Governed historical narrative import finding',
          evidence: [`${REVIEW_FILE}#${id}`],
          owner_agent: 'platform-autonomy',
          raised_in_cycle: '2026-08-22-aria-end-to-end-autonomy-closure',
          review_file: REVIEW_FILE,
          created_at: '2026-08-22T00:00:00.000Z',
        }),
        'utf8',
      );
      return {
        layout,
        run: () =>
          withRegistryFileLock(layout.dir, (lease) =>
            appendNarrativeFinding(stubPath, lease, {
              layout,
              narrativePath,
              narrativeReviewFile: REVIEW_FILE,
            }),
          ),
      };
    }

    it('admits ORPHAN-HIGH-1000 and refuses a leading zero past three digits', () => {
      const admitted = narrativeFixture('narrative-1000', 'ORPHAN-HIGH-1000');
      expect(admitted.run()).toBe(0);
      expect(sortedIds(admitted.layout)).toEqual(['ORPHAN-HIGH-1000']);

      const leadingZero = narrativeFixture('narrative-0999', 'ORPHAN-HIGH-0999');
      expect(leadingZero.run()).toBe(2);
      expect(sortedIds(leadingZero.layout)).toEqual([]);
    });
  });
});

describe('REG-ID — the commit-msg gate', () => {
  const NEVER_PRE_GATE = (_commit: Commit): boolean => false;
  const registry = (...ids: readonly string[]): Map<string, FindingTrailerTarget> =>
    new Map(ids.map((id) => [id, { id }]));
  const commit = (subject: string, trailer: string): Commit => ({
    sha: 'abc123',
    shortSha: 'abc123',
    subject,
    body: `body\n\n${trailer}`,
  });

  it('reads every tabled finding id as a trailer target', () => {
    for (const { id } of GRAMMAR_TABLE.accept) {
      const match = CLOSES_TRAILER_REGEX.exec(`Closes: docs/reviews/orphan-findings.md#${id}`);
      expect({ id, target: match?.[2] }).toEqual({ id, target: id });
    }
  });

  it('refuses every tabled id the grammar does not spell as a trailer target', () => {
    // The ARIA debt and F-NNN families are different grammars the trailer also
    // admits, and an id with whitespace is not a trailer's business: the
    // line's own whitespace handling decides those.
    const finding = GRAMMAR_TABLE.reject.filter(
      (id) => !/\s/.test(id) && !id.startsWith('F-') && !id.startsWith('DEBT-'),
    );
    expect(finding.length).toBeGreaterThan(15);
    for (const id of finding) {
      expect({
        id,
        matched:
          CLOSES_TRAILER_REGEX.exec(`Closes: docs/reviews/orphan-findings.md#${id}`) !== null,
      }).toEqual({ id, matched: false });
    }
    // The two the issue named, said where a reader of this file looks first.
    expect(CLOSES_TRAILER_REGEX.exec('Closes: docs/x.md#ARIA-HIGH-1000')).not.toBeNull();
    expect(CLOSES_TRAILER_REGEX.exec('Closes: docs/x.md#ARIA-HIGH-0999')).toBeNull();
  });

  it('reads a four-digit orphan heading and refuses a fifth digit', () => {
    const canonical = ORPHAN_HEADING_REGEX.exec('## ORPHAN-HIGH-1000 — canonical, four digits');
    expect(canonical?.[1]).toBe('ORPHAN-HIGH-1000');
    expect(canonical?.[2]).toBe('1000');
    expect(ORPHAN_HEADING_REGEX.exec('## ORPHAN-1001 — bare, four digits')?.[2]).toBe('1001');
    const suffixed = ORPHAN_HEADING_REGEX.exec('## ORPHAN-LOW-1002b — suffixed, four digits');
    expect(suffixed?.[1]).toBe('ORPHAN-LOW-1002b');
    expect(suffixed?.[2]).toBe('1002');
    expect(ORPHAN_HEADING_REGEX.exec('## ORPHAN-HIGH-10000 — five digits')).toBeNull();
  });

  it('resolves a four-digit registry trailer like any other', () => {
    // The trailer regex stopped at three digits, so a feat commit closing
    // ARIA-HIGH-1000 had no trailer at all and was refused as "missing Closes".
    const violations = validateCommit(
      commit(
        'feat(tooling): four-digit registry close',
        'Closes: docs/reviews/nonexistent.md#ARIA-HIGH-1000',
      ),
      registry('ARIA-HIGH-1000'),
      new Set(),
      NEVER_PRE_GATE,
    );
    expect(violations.map((violation) => violation.reason)).toEqual([
      expect.stringMatching(/missing review file/),
    ]);
  });

  it('judges a four-digit trailer naming no finding as an unknown id, not a missing trailer', () => {
    const reasons = validateCommit(
      commit(
        'feat(tooling): four-digit unknown id',
        'Closes: docs/reviews/nonexistent.md#ARIA-HIGH-1001',
      ),
      registry('ARIA-HIGH-999'),
      new Set(),
      NEVER_PRE_GATE,
    ).map((violation) => violation.reason);
    expect(reasons.some((reason) => /missing Closes: trailer/.test(reason))).toBe(false);
    expect(reasons.some((reason) => /unknown finding ID/.test(reason))).toBe(true);
  });

  it('routes a four-digit ORPHAN trailer to the orphan store', () => {
    const violations = validateCommit(
      commit(
        'feat(tooling): four-digit orphan close',
        'Closes: docs/reviews/nonexistent.md#ORPHAN-HIGH-1000',
      ),
      registry(),
      new Set(['ORPHAN-HIGH-1000']),
      NEVER_PRE_GATE,
    );
    expect(violations.map((violation) => violation.reason)).toEqual([
      expect.stringMatching(/missing review file/),
    ]);
  });
});
