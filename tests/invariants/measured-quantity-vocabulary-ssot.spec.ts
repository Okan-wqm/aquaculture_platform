import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import {
  CHANNEL_KEYS,
  type ChannelKeyMeaning,
  MEASURED_QUANTITIES,
} from '@aquaculture/shared-contracts';
import ts from 'typescript';

/**
 * INVARIANT: what a channel key measures, and in which unit, has ONE owner —
 * `libs/shared-contracts/src/measurement/quantities.ts`.
 *
 * Every earlier copy had one of two shapes, and this spec finds both in the
 * syntax tree of every source file outside the registry:
 *
 *   1. an ALIAS TABLE — one object, array or switch that names two or more
 *      device spellings of the same quantity (`{ temp: …, temperature: … }`,
 *      `case 'do': case 'o2':`). The spellings are read from the registry, so
 *      a new alias is covered the day it is added.
 *   2. a UNIT TABLE — one object mapping three or more quantity names or
 *      channel keys to unit strings (`{ temperature: '°C', ph: '', … }`).
 *
 * Copies that predate the registry are listed in KNOWN_COPIES with the finding
 * that removes them. The list only shrinks: an entry whose file no longer holds
 * a copy fails, so the fix that removes one removes its entry.
 */
const REPO_ROOT = resolve(__dirname, '..', '..');
const REGISTRY = 'libs/shared-contracts/src/measurement/quantities.ts';
const SCAN_ROOTS = ['apps', 'libs', 'platform/libs', 'web', 'mcp'];

/** Pre-registry copies, each removed by the finding named. */
const KNOWN_COPIES: Readonly<Record<string, string>> = {
  'libs/node-components/src/nodes/SensorNode.tsx': 'SENSOR-MEDIUM-168',
  'web/modules/dashboard/src/components/OverviewWidgets.tsx': 'SENSOR-MEDIUM-168',
  'web/modules/farm-module/src/hooks/useWaterQuality.ts': 'FARM-MEDIUM-364',
  'web/modules/sensor-module/src/components/dashboard/WidgetConfigModal.tsx': 'SENSOR-MEDIUM-168',
  'web/modules/sensor-module/src/graphql/aggregatedReadings.ts': 'SENSOR-MEDIUM-168',
  'web/modules/sensor-module/src/hooks/useSensorReadings.ts': 'SENSOR-MEDIUM-168',
  'web/modules/sensor-module/src/pages/water-chemistry/mock/fixtures.ts': 'SENSOR-MEDIUM-168',
};

const meaningName = (meaning: ChannelKeyMeaning): string => meaning.quantity ?? meaning.family;
const SPELLING_OWNER = new Map<string, string>(
  Object.entries(CHANNEL_KEYS).map(([key, meaning]: [string, ChannelKeyMeaning]) => [
    key,
    meaningName(meaning),
  ]),
);
const QUANTITY_NAMES = new Set<string>([
  ...SPELLING_OWNER.keys(),
  ...MEASURED_QUANTITIES.map((quantity) => quantity.id),
]);
const UNIT_SPELLINGS = new Set<string>(
  MEASURED_QUANTITIES.flatMap((quantity) => [...quantity.spellings]).filter((u) => u !== ''),
);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (['node_modules', 'dist', '__tests__', 'migrations', 'generated'].includes(entry)) continue;
    const full = join(dir, entry);
    if (!entry.includes('.')) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.(spec|test|d)\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function nameText(name: ts.PropertyName | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

/** Two or more spellings of one quantity among `names` → that quantity's spellings. */
function aliasGroup(names: readonly string[]): string[] | undefined {
  const byOwner = new Map<string, Set<string>>();
  for (const name of names) {
    const owner = SPELLING_OWNER.get(name.toLowerCase());
    if (owner === undefined) continue;
    byOwner.set(owner, (byOwner.get(owner) ?? new Set()).add(name.toLowerCase()));
  }
  return [...byOwner.values()].map((set) => [...set]).find((spellings) => spellings.length >= 2);
}

interface Finding {
  readonly kind: 'alias table' | 'unit table';
  readonly where: string;
  readonly detail: string;
}

function scan(rel: string, source: string): Finding[] {
  const file = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true);
  const findings: Finding[] = [];
  const at = (node: ts.Node): string =>
    `${rel}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const keyed = node.properties
        .filter((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p))
        .map((p) => ({ name: nameText(p.name), value: p.initializer }));
      const group = aliasGroup(keyed.flatMap((p) => (p.name ? [p.name] : [])));
      if (group) findings.push({ kind: 'alias table', where: at(node), detail: group.join(', ') });
      const units = keyed.filter(
        (p) =>
          p.name !== undefined &&
          QUANTITY_NAMES.has(p.name.toLowerCase()) &&
          ts.isStringLiteralLike(p.value) &&
          UNIT_SPELLINGS.has(p.value.text),
      );
      if (units.length >= 3) {
        findings.push({
          kind: 'unit table',
          where: at(node),
          detail: units.map((p) => p.name).join(', '),
        });
      }
    } else if (ts.isArrayLiteralExpression(node)) {
      const group = aliasGroup(
        node.elements.flatMap((e) => (ts.isStringLiteralLike(e) ? [e.text] : [])),
      );
      if (group) findings.push({ kind: 'alias table', where: at(node), detail: group.join(', ') });
    } else if (ts.isCaseBlock(node)) {
      const group = aliasGroup(
        node.clauses.flatMap((c) =>
          ts.isCaseClause(c) && ts.isStringLiteralLike(c.expression) ? [c.expression.text] : [],
        ),
      );
      if (group) findings.push({ kind: 'alias table', where: at(node), detail: group.join(', ') });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}

describe('INVARIANT: one owner for measured-quantity spellings and units', () => {
  const files = SCAN_ROOTS.flatMap((root) => sourceFiles(resolve(REPO_ROOT, root)))
    .map((file) => relative(REPO_ROOT, file))
    .filter((rel) => rel !== REGISTRY);
  const findings = files.flatMap((rel) => scan(rel, readFileSync(resolve(REPO_ROOT, rel), 'utf8')));

  it('detects both shapes it guards against', () => {
    const probe = scan(
      'probe.ts',
      `const a = { water_temp: 1, temperature: 2 };
       const b = ['do', 'o2'];
       switch (k) { case 'ph': case 'ph_level': break; }
       const u = { temperature: '°C', dissolvedOxygen: 'mg/L', salinity: 'ppt' };
       const fine = { temperature: 1, ph: 2, salinity: 3 };`,
    );
    expect(probe.map((f) => f.kind)).toEqual([
      'alias table',
      'alias table',
      'alias table',
      'unit table',
    ]);
  });

  it('finds no alias or unit table outside the registry but the tracked copies', () => {
    const untracked = findings.filter(
      (f) => KNOWN_COPIES[f.where.split(':')[0] ?? ''] === undefined,
    );
    expect(untracked).toEqual([]);
  });

  it('lists only tracked copies that still exist', () => {
    const present = new Set(findings.map((f) => f.where.split(':')[0]));
    expect(Object.keys(KNOWN_COPIES).filter((rel) => !present.has(rel))).toEqual([]);
  });
});
