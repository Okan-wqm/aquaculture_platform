import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixtureTree } from '../gates/fixture-tree';

import { analyzeBundleBudgets } from './bundle-budget-adapter';

const workspace = makeFixtureTree('aria-bundle-budget-');

// Module WITHOUT a budget, importing a heavyweight statically.
const fat = join(workspace, 'web/modules/fat-module');
mkdirSync(join(fat, 'src'), { recursive: true });
writeFileSync(join(fat, 'package.json'), '{"name":"fat-module"}', 'utf8');
writeFileSync(join(fat, 'vite.config.ts'), 'export default {};\n', 'utf8');
writeFileSync(
  join(fat, 'src', 'report.ts'),
  "import * as XLSX from 'xlsx';\nexport const x = XLSX;\n",
  'utf8',
);

// Module WITH an enforced budget (the per-module budget manifest), loading
// the heavyweight dynamically.
const fit = join(workspace, 'web/modules/fit-module');
mkdirSync(join(fit, 'src'), { recursive: true });
writeFileSync(join(fit, 'package.json'), '{"name":"fit-module"}', 'utf8');
writeFileSync(join(fit, 'vite.config.ts'), 'export default {};\n', 'utf8');
writeFileSync(join(fit, 'bundle-budget.json'), '{"maxInitialKb":500}\n', 'utf8');
writeFileSync(
  join(fit, 'src', 'report.ts'),
  "export async function load() { return import('xlsx'); }\n",
  'utf8',
);

// ARIA-MEDIUM-327 — a module whose vite config raises the WARNING limit. A
// warning fails nothing, so it is not an enforced budget; Vite also warns
// above 500 kB by default, so no message may claim "nothing warns".
const warned = join(workspace, 'web/modules/warned-module');
mkdirSync(join(warned, 'src'), { recursive: true });
writeFileSync(join(warned, 'package.json'), '{"name":"warned-module"}', 'utf8');
writeFileSync(
  join(warned, 'vite.config.ts'),
  'export default { build: { chunkSizeWarningLimit: 600 } };\n',
  'utf8',
);

const output = analyzeBundleBudgets({ roots: ['web/modules'] }, workspace);

const rules = output.findings.map((finding) => `${finding.rule}:${finding.path}`);
assert.ok(
  rules.some((entry) => entry.startsWith('bundle_budget_not_enforced:web/modules/fat-module/')),
  `fat module must be flagged for an unenforced budget, got ${JSON.stringify(rules)}`,
);
assert.ok(
  rules.some((entry) => entry.startsWith('bundle_budget_not_enforced:web/modules/warned-module/')),
  `a warning limit is not an enforced budget, got ${JSON.stringify(rules)}`,
);
for (const finding of output.findings.filter((f) => f.rule === 'bundle_budget_not_enforced')) {
  assert.equal(finding.severity, 'low', 'an unenforced budget is a LOW absence, not a defect');
  assert.ok(
    !/nothing warns/i.test(finding.message),
    `the message must not claim nothing warns (Vite warns above 500 kB): ${finding.message}`,
  );
}
assert.ok(
  rules.some(
    (entry) =>
      entry === 'heavy_dependency_statically_imported:web/modules/fat-module/src/report.ts',
  ),
  'static xlsx import must be flagged',
);
assert.ok(
  !rules.some((entry) => entry.includes('fit-module')),
  `budgeted module with dynamic import must stay clean, got ${JSON.stringify(rules)}`,
);
assert.equal(output.observations.filter((o) => o.type === 'bundle_budget_module').length, 3);
assert.ok(output.read_paths.length > 0);

// DET-scope7 / Z37 layer 1 — `route_page_statically_imported`. A federated
// remote's router lazy-loads its pages; one page imported statically welds that
// page, and everything it imports, into the remote's initial chunk. The rule is
// structural and needs no library list: only a vite config with `exposes`
// makes a module a remote; only a file that lazy-loads >= 5 relative modules
// and keeps >= 75% of its relative page imports lazy is a router; each static
// page import in it is one finding, cited at the import.
const ROUTE_RULE = 'route_page_statically_imported';

type LazyStyle = 'arrow' | 'react' | 'multiline' | 'preload';
const LAZY_DECLARATION: Record<LazyStyle, (index: number, page: string) => string> = {
  arrow: (i, page) => `const P${i} = lazy(() => import('${page}'));`,
  react: (i, page) => `const P${i} = React.lazy(() => import('${page}'));`,
  multiline: (i, page) => `const P${i} = lazy(\n  () => import('${page}'),\n);`,
  preload: (i, page) =>
    `const load${i} = () => import('${page}');\nconst P${i} = React.lazy(load${i});`,
};
const PAGE = "import FinancePage from './pages/finance/FinancePage';";

interface RouterCase {
  readonly name: string;
  readonly lazy: number;
  readonly style?: LazyStyle;
  /** Static import statements of the router file; `flagged` names the ones the rule must cite. */
  readonly imports: readonly string[];
  readonly flagged: readonly number[];
  readonly file?: string;
  readonly app?: boolean; // web/apps/<name> with a vite config that declares no `exposes`
  readonly extra?: Readonly<Record<string, string>>; // other files under src/
}

const staticPages = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `import S${i} from './pages/static${i}/Static${i}Page';`);

const ROUTER_CASES: readonly RouterCase[] = [
  // hr-module Module.tsx after the Z37 patch: 20 lazy pages, one static.
  { name: 'hr-shaped', lazy: 20, imports: [PAGE], flagged: [0] },
  // Exactly five lazy modules is a router, whichever way the lazy edge is written.
  {
    name: 'floor-react',
    lazy: 5,
    style: 'react',
    imports: [PAGE],
    flagged: [0],
    file: 'routes/AppRoutes.tsx',
  },
  {
    name: 'floor-multiline',
    lazy: 5,
    style: 'multiline',
    imports: [PAGE],
    flagged: [0],
    file: 'App.tsx',
  },
  { name: 'floor-preload', lazy: 5, style: 'preload', imports: [PAGE], flagged: [0] },
  { name: 'ratio-boundary', lazy: 15, imports: staticPages(5), flagged: [0, 1, 2, 3, 4] }, // 75% lazy
  {
    name: 'multiline-static',
    lazy: 20,
    imports: ["import {\n  FinancePage,\n} from './pages/finance/FinancePage';"],
    flagged: [0],
  },
  // Near-misses: each is one step away from a router that must be flagged.
  { name: 'below-floor', lazy: 4, imports: [PAGE], flagged: [] }, // 80% lazy, only 4 lazy modules
  { name: 'ratio-just-below', lazy: 14, imports: staticPages(5), flagged: [] }, // 73.7% lazy
  { name: 'sensor-shaped', lazy: 17, imports: staticPages(14), flagged: [] }, // 55% lazy
  {
    name: 'all-lazy',
    lazy: 20,
    imports: [],
    flagged: [],
    // a static page import in a file that lazy-loads nothing is not a router's
    extra: {
      'components/Breadcrumb.tsx':
        "import Area0Page from '../pages/area0/Area0Page';\nexport const b = Area0Page;\n",
    },
  },
  {
    name: 'type-only',
    lazy: 20,
    imports: ["import type { FinancePageProps } from './pages/finance/FinancePage';"],
    flagged: [],
  },
  {
    name: 'non-page',
    lazy: 20,
    imports: [
      "import Header from './components/Header';",
      "import { useRoles } from './hooks/useRoles';",
      "import MainLayout from './layouts/MainLayout';",
    ],
    flagged: [],
  },
  // aquamobil-shaped: eager Login/Home pages in an app that no host federates.
  {
    name: 'non-remote',
    lazy: 20,
    imports: ["import Login from './pages/LoginPage';", "import Home from './pages/HomePage';"],
    flagged: [],
    file: 'App.tsx',
    app: true,
  },
];

const routeWorkspace = makeFixtureTree('aria-bundle-budget-routes-');
const routeMismatches: string[] = [];
const wanted = new Map<string, { name: string; ranges: [number, number][] }>();
for (const spec of ROUTER_CASES) {
  const root = join(routeWorkspace, spec.app ? 'web/apps' : 'web/modules', spec.name);
  const file = spec.file ?? 'Module.tsx';
  const style = spec.style ?? 'arrow';
  const lines = ["import React, { Suspense, lazy } from 'react';"];
  const ranges: [number, number][] = [];
  for (const statement of spec.imports) {
    const start = lines.join('\n').split('\n').length + 1;
    ranges.push([start, start + statement.split('\n').length - 1]);
    lines.push(statement);
  }
  for (let i = 0; i < spec.lazy; i += 1) {
    lines.push(LAZY_DECLARATION[style](i, `./pages/area${i}/Area${i}Page`));
  }
  const files: Record<string, string> = {
    'package.json': `{"name":"${spec.name}"}`,
    'bundle-budget.json': '{"maxInitialKb":500}\n',
    'vite.config.ts': spec.app
      ? 'export default { plugins: [] };\n'
      : `export default { plugins: [federation({ name: 'x', exposes: { './Module': './src/${file}' } })] };\n`,
    [`src/${file}`]: `${lines.join('\n')}\nexport { Suspense };\n`,
  };
  for (const [name, body] of Object.entries(spec.extra ?? {})) {
    files[`src/${name}`] = body;
  }
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), body, 'utf8');
  }
  wanted.set(`${spec.app ? 'web/apps' : 'web/modules'}/${spec.name}/src/${file}`, {
    name: spec.name,
    ranges: spec.flagged.map((index) => ranges[index] as [number, number]),
  });
}

const routeOutput = analyzeBundleBudgets({ roots: ['web/modules', 'web/apps'] }, routeWorkspace);
const ruleOf = (finding: { readonly rule: string }): string => finding.rule;
const routeFindings = routeOutput.findings.filter((finding) => ruleOf(finding) === ROUTE_RULE);
for (const [path, { name, ranges }] of wanted) {
  const got = routeFindings.filter((finding) => finding.path === path);
  const lineOf = (finding: { readonly line?: number }): number => finding.line ?? 0;
  const sorted = [...got].sort((a, b) => lineOf(a) - lineOf(b));
  if (
    sorted.length !== ranges.length ||
    !sorted.every(
      (f, i) => lineOf(f) >= (ranges[i]?.[0] ?? 0) && lineOf(f) <= (ranges[i]?.[1] ?? 0),
    )
  ) {
    routeMismatches.push(
      `${name}: expected lines ${JSON.stringify(ranges)}, got ${JSON.stringify(sorted.map(lineOf))}`,
    );
  }
  for (const finding of got) {
    if (!finding.evidence.some((ref) => ref.path === path && ref.line === finding.line)) {
      routeMismatches.push(
        `${name}: finding at line ${finding.line} cites no evidence at its own line`,
      );
    }
  }
}
for (const finding of routeFindings) {
  if (!wanted.has(finding.path)) {
    routeMismatches.push(`stray route finding at ${finding.path}:${finding.line}`);
  }
}
const idCount = new Set(routeOutput.findings.map((finding) => finding.id)).size;
if (idCount !== routeOutput.findings.length) {
  routeMismatches.push('finding ids are not unique');
}
const otherRules = routeOutput.findings.filter((finding) => ruleOf(finding) !== ROUTE_RULE);
if (otherRules.length > 0) {
  routeMismatches.push(
    `no other rule may fire on these modules: ${JSON.stringify(otherRules.map((f) => f.id))}`,
  );
}

// The rule ships SHADOW with its own contract; the version moves past the one
// that had two rules, and no other rule or default appears.
const manifest = JSON.parse(
  readFileSync(join(__dirname, 'bundle-budget-adapter.tool.json'), 'utf8'),
) as {
  readonly version: string;
  readonly status: string;
  readonly rules: Record<string, Record<string, unknown>>;
};
const [major = 0, minor = 0, patch = 0] = manifest.version.split('.').map(Number);
if (!(major > 1 || (major === 1 && (minor > 2 || (minor === 2 && patch > 0))))) {
  routeMismatches.push(`manifest version ${manifest.version} is not above 1.2.0`);
}
if (manifest.status !== 'SHADOW') {
  routeMismatches.push(`manifest status ${manifest.status} is not SHADOW`);
}
const contract = manifest.rules[ROUTE_RULE];
for (const field of ['claim_type', 'severity_cap', 'defect_claim']) {
  if (typeof contract?.[field] !== 'string' || contract[field] === '') {
    routeMismatches.push(`manifest rule ${ROUTE_RULE} has no ${field}`);
  }
}
if (!Array.isArray(contract?.premises) || contract.premises.length === 0) {
  routeMismatches.push(`manifest rule ${ROUTE_RULE} has no premises`);
}
const ruleNames = Object.keys(manifest.rules).sort();
if (
  ruleNames.join() !==
  ['bundle_budget_not_enforced', 'heavy_dependency_statically_imported', ROUTE_RULE].sort().join()
) {
  routeMismatches.push(`manifest rules are ${JSON.stringify(ruleNames)}; exactly one rule is new`);
}
assert.deepEqual(routeMismatches, []);

process.stdout.write('bundle-budget-adapter tests passed\n');
