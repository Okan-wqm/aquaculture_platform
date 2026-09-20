/**
 * INVARIANT: a registry mutation cannot leave the debt-plan mirror stale.
 *
 * `docs/plans/2026-06-18-enterprise-grade-debt-closure/{manifest.json,
 * finding-truth-table.md,README.md}` are DERIVED from `findings.jsonl` — they
 * mirror five scalars and an id list out of it. A registry mutation is the only
 * thing that can make them stale, so the mutation rebuilds them: every mutating
 * subcommand of `finding-registry` routes through one wrapper,
 * `runRegistryMutation`, and that wrapper calls `repinDebtPlan()`
 * (PROC-MEDIUM-037).
 *
 * That is tier 2 — the correct behaviour is the zero-effort default — and it
 * replaces a tier-3 arrangement that had already shipped red four times: the
 * repin was a second npm script a human had to remember, and
 * `enterprise-grade-debt-plan-contract.spec.ts` only told them about it a
 * commit later, on a number nobody chose to change.
 *
 * Tier 2 decays silently, so this is its tier-3 backstop. Two ways to break it:
 *
 *  1. unwire the wrapper — delete the `repinDebtPlan` call and every mutation
 *     goes back to leaving a stale mirror, with nothing red until CI;
 *  2. route around it — add a new mutating subcommand that calls the store
 *     directly instead of through `runRegistryMutation`, and only that one
 *     command leaks, which is the harder version to notice.
 *
 * Both are shape facts about one file, so both are checked here by reading it.
 * A new READ-ONLY subcommand is the one legitimate way to add an `exitCode`
 * assignment that is not a `runRegistryMutation(` call, and it has to be named
 * in `READ_ONLY_COMMANDS` below — by hand, which is the point: it is a claim
 * that the command writes nothing, made where a reviewer sees it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'tools/gates/finding-registry.ts');

/**
 * Subcommand handlers that only READ the ledger. Adding a name here asserts the
 * command writes nothing to `findings.jsonl`; if it does, the mirror it leaves
 * behind is stale and the plan contract goes red on the next contributor.
 */
const READ_ONLY_COMMANDS: readonly string[] = ['cmdVerify', 'cmdExport', 'cmdList'];

function cliSource(): string {
  return fs.readFileSync(CLI_PATH, 'utf8');
}

/** The body of `function main()`, from its brace to the file's last `}`. */
function mainBody(source: string): string {
  const start = source.indexOf('function main(): void {');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('INVARIANT: finding-registry repins the debt plan after every mutation', () => {
  const source = cliSource();

  it('the mutation wrapper calls the repin', () => {
    expect(source).toContain("import { repinDebtPlan } from './repin-debt-plan';");
    const wrapperStart = source.indexOf('function runRegistryMutation(');
    expect(wrapperStart).toBeGreaterThan(-1);
    const wrapper = source.slice(wrapperStart, source.indexOf('\n}', wrapperStart));
    expect(wrapper).toContain('repinAfterMutation()');

    const repinStart = source.indexOf('function repinAfterMutation(): number {');
    expect(repinStart).toBeGreaterThan(-1);
    expect(source.slice(repinStart, source.indexOf('\n}', repinStart))).toContain(
      'repinDebtPlan()',
    );
  });

  it('every subcommand either goes through the wrapper or is declared read-only', () => {
    const body = mainBody(source);
    const assignments = [...body.matchAll(/^ {4}exitCode = ([A-Za-z]+)\(/gm)].flatMap((m) =>
      m[1] === undefined ? [] : [m[1]],
    );
    // A CLI with no dispatch would pass vacuously; it has one, so assert it.
    expect(assignments.length).toBeGreaterThan(5);

    const unguarded = assignments.filter(
      (handler) => handler !== 'runRegistryMutation' && !READ_ONLY_COMMANDS.includes(handler),
    );
    expect(unguarded).toEqual([]);
  });

  it('the repin runs only when the ledger actually changed, so --dry-run stays dry', () => {
    const wrapperStart = source.indexOf('function runRegistryMutation(');
    const wrapper = source.slice(wrapperStart, source.indexOf('\n}', wrapperStart));
    // `sweep --dry-run` and `reconcile --dry-run` write nothing; a repin firing
    // behind them would write three files on a command that promises none.
    // Asserting on the NAMED predicate, not on `registryDigest()`: the digest is
    // also taken for the `before` snapshot, so its mere presence survived
    // deleting the guard — this assertion passed on a wrapper that had lost it.
    expect(wrapper).toContain('const ledgerChanged = registryDigest() !== before;');
    expect(wrapper).toContain('!ledgerChanged');
  });
});
