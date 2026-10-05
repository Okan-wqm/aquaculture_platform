import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyzeBundleBudgets } from './bundle-budget-adapter';

const workspace = mkdtempSync(join(tmpdir(), 'aria-bundle-budget-'));

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

process.stdout.write('bundle-budget-adapter tests passed\n');
