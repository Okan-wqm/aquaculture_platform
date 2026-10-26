/**
 * DET crossfile-7 (ledger id Z30(a)) — the static value folder of
 * `tools/gates/event-consumer-index.ts` is exported from its one owner and gains a shape mode.
 *
 * # Why
 *
 * The Z30 defect is a Redis key written as `subscription:${tenantId}` and invalidated as
 * `subscriptions:${tenantId}`: the key has no owner, so eight hand-written literals drifted apart
 * (DET-RCA crossfile.md section 2.2). The check that relates a written key to an invalidated one
 * needs the key's static shape: its literal text with every runtime part replaced by `*`. The
 * repository already owns "what a string expression folds to, through the type checker" in
 * `ValueFolder`, a class that only needs a `TypeChecker` and is private to its module. A second
 * folder in an adapter would be a second owner of the fold, so the owner exports the class and
 * adds the mode the adapter needs (package P8 builds that adapter later; nothing here adds one).
 *
 * # What this pins
 *
 * 1. `ValueFolder` is exported by `tools/gates/event-consumer-index.ts` and is built from a
 *    `TypeChecker` alone. Shape mode is chosen at construction: `new ValueFolder(checker, 'shape')`.
 *    A folder built without a mode is exact, as every caller already assumes. (New API: the export
 *    and the mode name `'shape'`. Every fold test below reads the class through the export, so at
 *    the branch base they all fail on the missing export, not on a fold assertion.)
 * 2. Shape mode replaces exactly the `${...}` parts of a template that do not fold with `*`. A part
 *    that folds stays its value (a const, a literal-union, a for-of element, a private method's
 *    literal arguments), the placeholder joins the other parts' cross product, and it propagates
 *    through const bindings and conditionals the same way the exact fold does.
 * 3. Near-misses: an expression that is not a template and does not fold (a bare parameter, a
 *    property access, a helper call) stays unresolved (null) in shape mode, never `*`; every
 *    expression the exact fold answers gets the same answer in shape mode.
 * 4. No default change: the two existing callers (the consumer scan and the producer scan, both
 *    through `SourceScan`) keep folding exactly, so a subscription or an event type built from a
 *    template with a runtime part is still `unresolved`, never a `*`-shaped value. Those two tests
 *    pass at the base and must keep passing. Same for the single-owner guard.
 *
 * Why this lives here and not in tools/gates: the pre-commit hook runs every tools/gates spec
 * (tools/gates/run-all.mjs), so a red spec there cannot be committed.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import * as ts from 'typescript';

import {
  scanEventConsumers,
  scanEventProducers,
  ValueFolder,
} from '../../tools/gates/event-consumer-index';
import { indexFixtureTree } from '../../tools/gates/fixture-git-index';
import { makeFixtureTree, removeFixtureTree } from '../../tools/gates/fixture-tree';
import { hermeticGitEnv } from '../../tools/gates/hermetic-git';

const REPO_ROOT = resolve(__dirname, '..', '..');
const OWNER_MODULE = 'tools/gates/event-consumer-index.ts';

// ---------------------------------------------------------------------------------------------
// The fold cases: one module per case, each holding exactly one `probe(...)` call whose argument
// is what gets folded, all in one in-memory type-checked program.
// ---------------------------------------------------------------------------------------------

const PROBE = 'declare function probe(key: string): void;\nexport {};\n';
const PARAMS =
  "tenantId: string, command: { tenantId: string; key: string }, build: (value: string) => string, kind: 'a' | 'b'";

/** A module whose function `run` holds `body`; `outside` is declared before it. */
function inRun(body: string, outside = ''): string {
  return `${PROBE}${outside}export function run(${PARAMS}): void {\n  ${body}\n}\n`;
}

/** A class whose private method folds `part` into a key; `calls` are the calls it receives. */
function privateMethod(clearParams: string, calls: string): string {
  return [
    PROBE,
    'export class Cache {',
    `  async clear(${clearParams}): Promise<void> {`,
    `    ${calls}`,
    '  }',
    '  private invalidate(part: string): void {',
    '    probe(`k:${part}`);',
    '  }',
    '}',
    '',
  ].join('\n');
}

interface FoldCase {
  readonly name: string;
  readonly source: string;
  /** What a folder built without a mode answers (sorted values, null = unresolved). */
  readonly exact: readonly string[] | null;
  /** What a folder built with `'shape'` answers. */
  readonly shape: readonly string[] | null;
}

/** Expressions the exact fold answers: shape mode gives the same answer (no `*` is introduced). */
const AGREE: readonly FoldCase[] = [
  {
    name: 'a string literal',
    source: inRun("probe('subscription:abc');"),
    exact: ['subscription:abc'],
    shape: ['subscription:abc'],
  },
  {
    name: 'a literal that already holds a star (a pattern delete)',
    source: inRun("probe('farm:cache:*');"),
    exact: ['farm:cache:*'],
    shape: ['farm:cache:*'],
  },
  {
    name: 'a template with no substitution',
    source: inRun('probe(`subscription:abc`);'),
    exact: ['subscription:abc'],
    shape: ['subscription:abc'],
  },
  {
    name: 'a const prefix and a literal-union span stay values',
    source: inRun('probe(`${PREFIX}:${kind}`);', "const PREFIX = 'subscription';\n"),
    exact: ['subscription:a', 'subscription:b'],
    shape: ['subscription:a', 'subscription:b'],
  },
  {
    name: 'a for-of element over a literal list stays a value',
    source: inRun("for (const part of ['a', 'b'] as const) {\n    probe(`k:${part}`);\n  }"),
    exact: ['k:a', 'k:b'],
    shape: ['k:a', 'k:b'],
  },
  {
    name: 'a private method whose every call passes a literal stays values',
    source: privateMethod('', "this.invalidate('x'); this.invalidate('y');"),
    exact: ['k:x', 'k:y'],
    shape: ['k:x', 'k:y'],
  },
];

/** Templates with a runtime part: exact is unresolved, shape keeps the text and marks the part. */
const PLACEHOLDER: readonly FoldCase[] = [
  {
    name: 'a parameter as the last part (the Z30 key)',
    source: inRun('probe(`subscription:${tenantId}`);'),
    exact: null,
    shape: ['subscription:*'],
  },
  {
    name: 'a property access as a part',
    source: inRun('probe(`subscription:${command.tenantId}`);'),
    exact: null,
    shape: ['subscription:*'],
  },
  {
    name: 'a helper call as a part',
    source: inRun('probe(`subscription:${build(tenantId)}`);'),
    exact: null,
    shape: ['subscription:*'],
  },
  {
    name: 'a placeholder as the first part (no static first segment)',
    source: inRun('probe(`${tenantId}:x`);'),
    exact: null,
    shape: ['*:x'],
  },
  {
    name: 'two runtime parts, one star each',
    source: inRun('probe(`farm:${tenantId}:cache:${command.key}`);'),
    exact: null,
    shape: ['farm:*:cache:*'],
  },
  {
    name: 'values around a placeholder: foldable parts stay values and multiply',
    source: inRun('probe(`${PREFIX}:${tenantId}:${kind}`);', "const PREFIX = 'subscription';\n"),
    exact: null,
    shape: ['subscription:*:a', 'subscription:*:b'],
  },
  {
    name: 'a const binding to a templated key',
    source: inRun('const key = `subscription:${tenantId}`;\n  probe(key);'),
    exact: null,
    shape: ['subscription:*'],
  },
  {
    name: 'a conditional between two templated keys',
    source: inRun("probe(kind === 'a' ? `a:${tenantId}` : `b:${tenantId}`);"),
    exact: null,
    shape: ['a:*', 'b:*'],
  },
  {
    name: 'a private method called with a runtime value',
    source: privateMethod('tenantId: string', 'this.invalidate(tenantId);'),
    exact: null,
    shape: ['k:*'],
  },
  {
    name: 'a private method called with a literal and a runtime value',
    source: privateMethod('tenantId: string', "this.invalidate('x'); this.invalidate(tenantId);"),
    exact: null,
    shape: ['k:*'],
  },
];

/** Not templates and not foldable: unresolved in both modes. A key is counted, never guessed. */
const UNRESOLVED: readonly FoldCase[] = [
  {
    name: 'a bare parameter',
    source: inRun('probe(tenantId);'),
    exact: null,
    shape: null,
  },
  {
    name: 'a property access',
    source: inRun('probe(command.key);'),
    exact: null,
    shape: null,
  },
  {
    name: 'a helper call',
    source: inRun('probe(build(tenantId));'),
    exact: null,
    shape: null,
  },
];

const ALL_CASES: readonly FoldCase[] = [...AGREE, ...PLACEHOLDER, ...UNRESOLVED];

const FIXTURE_DIR = '/value-folder-fixture';
const fixturePath = (index: number): string => `${FIXTURE_DIR}/case-${index}.ts`;

/** One type-checked program over every case module, read from memory (no file is written). */
function programOf(modules: readonly string[]): ts.Program {
  const sources = new Map(modules.map((text, index) => [fixturePath(index), text]));
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  };
  const host = ts.createCompilerHost(options, true);
  const readSource = host.getSourceFile.bind(host);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreate) => {
    const text = sources.get(fileName);
    return text === undefined
      ? readSource(fileName, languageVersionOrOptions, onError, shouldCreate)
      : ts.createSourceFile(fileName, text, languageVersionOrOptions, true);
  };
  host.fileExists = (fileName) => sources.has(fileName) || fileExists(fileName);
  host.readFile = (fileName) => sources.get(fileName) ?? readFile(fileName);
  return ts.createProgram({ rootNames: [...sources.keys()], options, host });
}

/** The argument of the module's one `probe(...)` call. */
function probeArgument(file: ts.SourceFile): ts.Expression {
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'probe' &&
      node.arguments[0] !== undefined
    ) {
      found.push(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const [only] = found;
  if (found.length !== 1 || only === undefined) {
    throw new Error(`${file.fileName}: expected one probe(...) call, found ${found.length}`);
  }
  return only;
}

describe('DET crossfile-7: ValueFolder is exported and has a shape mode', () => {
  let program: ts.Program;
  let checker: ts.TypeChecker;

  beforeAll(() => {
    program = programOf(ALL_CASES.map((fold) => fold.source));
    checker = program.getTypeChecker();
  }, 120_000);

  /** The class, read through the owner's export (a missing export fails here, by assertion). */
  function owner(): typeof ValueFolder {
    expect(typeof ValueFolder).toBe('function');
    return ValueFolder;
  }

  /** Sorted values the folder gives the case's probe argument, or null when it does not fold. */
  function foldedBy(folder: InstanceType<typeof ValueFolder>, index: number): string[] | null {
    const file = program.getSourceFile(fixturePath(index));
    if (file === undefined) throw new Error(`no source for case ${index}`);
    const folded = folder.fold(probeArgument(file));
    return folded === null ? null : [...folded.values].sort();
  }

  it('is exported by its owner and built from a type checker alone', () => {
    const folder = new (owner())(checker);
    expect(foldedBy(folder, 0)).toEqual(['subscription:abc']);
  });

  const exactCases = ALL_CASES.map((fold, index) => [fold.name, index, fold] as const);

  describe.each(exactCases)('%s', (_name, index, fold) => {
    it('a folder built without a mode folds exactly', () => {
      expect(foldedBy(new (owner())(checker), index)).toEqual(fold.exact);
    });

    it("a folder built with 'shape' gives the shape", () => {
      expect(foldedBy(new (owner())(checker, 'shape'), index)).toEqual(fold.shape);
    });
  });

  it('shape mode answers wherever the exact fold answers, and marks only with a star', () => {
    const exact = new (owner())(checker);
    const shape = new (owner())(checker, 'shape');
    ALL_CASES.forEach((fold, index) => {
      const exactValues = foldedBy(exact, index);
      const shapeValues = foldedBy(shape, index);
      if (exactValues !== null) {
        expect({ case: fold.name, values: shapeValues }).toEqual({
          case: fold.name,
          values: exactValues,
        });
      } else if (shapeValues !== null) {
        expect({ case: fold.name, allStarred: shapeValues.every((v) => v.includes('*')) }).toEqual({
          case: fold.name,
          allStarred: true,
        });
      }
    });
  });

  it('the mode belongs to the folder, not to the module or the checker', () => {
    const z30 = ALL_CASES.findIndex((fold) => fold.name.startsWith('a parameter as the last part'));
    expect(z30).toBeGreaterThanOrEqual(0);
    const exact = new (owner())(checker);
    const shape = new (owner())(checker, 'shape');
    const answers = [shape, exact, shape, exact].map((folder) => foldedBy(folder, z30));
    expect(answers).toEqual([['subscription:*'], null, ['subscription:*'], null]);
  });
});

// ---------------------------------------------------------------------------------------------
// No default change: the two existing callers keep folding exactly (green at the base).
// ---------------------------------------------------------------------------------------------

const trees: string[] = [];
afterAll(() => {
  for (const tree of trees) removeFixtureTree(tree);
});

/** Writes `files` under a fresh fixture tree and indexes it: the scans read tracked files. */
function writeTree(files: Record<string, string>): string {
  const root = makeFixtureTree('value-folder-shape-');
  trees.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text, 'utf8');
  }
  return indexFixtureTree(root);
}

const BUS = [
  'export interface IEventBus {',
  '  subscribeWildcard(eventType: string, handler: object): Promise<void>;',
  '}',
  '',
].join('\n');

const SUBSCRIBER = [
  "import type { IEventBus } from '../../../platform/libs/event-bus/src/event-bus';",
  'declare function runtimeKey(): string;',
  'export class Subscriber {',
  '  constructor(private readonly bus: IEventBus) {}',
  '  async start(tenantId: string): Promise<void> {',
  "    await this.bus.subscribeWildcard('Literal', this);",
  '    await this.bus.subscribeWildcard(`Tenant.${runtimeKey()}`, this);',
  '    await this.bus.subscribeWildcard(`Param.${tenantId}`, this);',
  '  }',
  '}',
  '',
].join('\n');

const BASE_EVENT = [
  'export interface BaseEvent {',
  '  readonly eventId: string;',
  '  readonly eventType: string;',
  '  readonly tenantId: string;',
  '}',
  'export function createBaseEvent<T extends BaseEvent>(',
  "  eventType: T['eventType'],",
  '  tenantId: string,',
  "): BaseEvent & { readonly eventType: T['eventType'] } {",
  "  return { eventId: 'fixture-id', eventType, tenantId };",
  '}',
  '',
].join('\n');

const PRODUCER = [
  "import { createBaseEvent } from '../../../libs/event-contracts/src/base-event';",
  'export class Producer {',
  '  emit(tenantId: string, action: string): void {',
  "    createBaseEvent('Literal', tenantId);",
  '    createBaseEvent(`audit.${action}`, tenantId);',
  '  }',
  '}',
  '',
].join('\n');

describe('DET crossfile-7: the existing callers keep folding exactly (no default change)', () => {
  it('a subscription built from a template with a runtime part is unresolved, not a shaped value', () => {
    const root = writeTree({
      'platform/libs/event-bus/src/event-bus.ts': BUS,
      'apps/x-service/project.json': JSON.stringify({ name: 'x-service' }),
      'apps/x-service/src/subscriber.ts': SUBSCRIBER,
    });
    const index = scanEventConsumers(root);
    expect(index.entries.map((e) => `${e.application}:${e.kind}:${e.value}`)).toEqual([
      'x-service:event_type:Literal',
    ]);
    expect(index.unresolved.map((site) => site.form).sort()).toEqual([
      '`Param.${tenantId}`',
      '`Tenant.${runtimeKey()}`',
    ]);
    expect(index.sites.filter((site) => site.values === null)).toHaveLength(2);
  });

  it('an event type built from a template with a runtime part is unresolved, not a shaped value', () => {
    const root = writeTree({
      'libs/event-contracts/src/base-event.ts': BASE_EVENT,
      'apps/x-service/project.json': JSON.stringify({ name: 'x-service' }),
      'apps/x-service/src/producer.ts': PRODUCER,
    });
    const index = scanEventProducers(root);
    expect(index.entries.map((e) => `${e.application}:${e.eventType}`)).toEqual([
      'x-service:Literal',
    ]);
    expect(index.unresolved.map((site) => site.form)).toEqual(['`audit.${action}`']);
    expect(index.sites.filter((site) => site.eventTypes === null)).toHaveLength(1);
  });
});

describe('DET crossfile-7: one owner of the fold', () => {
  it('only the owner module declares the folder class', () => {
    // The needle is assembled so this file does not name its own pattern.
    const needle = ['class', 'ValueFolder\\b'].join(' ');
    const declaring = execFileSync(
      'git',
      ['-C', REPO_ROOT, 'grep', '-l', '-E', needle, '--', '*.ts', '*.mts', '*.tsx'],
      { encoding: 'utf8', env: hermeticGitEnv() },
    )
      .split('\n')
      .filter((path) => path.length > 0);
    expect(declaring).toEqual([OWNER_MODULE]);
  });
});
