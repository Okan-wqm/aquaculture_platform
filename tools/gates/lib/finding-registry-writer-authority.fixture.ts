import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import {
  FINDING_WRITER_SENSITIVE_IMPORT_AUTHORITY,
  FINDING_WRITER_SENSITIVE_READ_ONLY_EXPORTS,
} from './finding-registry-writer-authority';

function fixtureModuleSpecifier(importer: string, target: string): string {
  const relativeTarget = relative(dirname(importer), target)
    .replaceAll('\\', '/')
    .replace(/\.[cm]?[jt]sx?$/, '');
  return relativeTarget.startsWith('.') ? relativeTarget : `./${relativeTarget}`;
}

export function renderFindingWriterSensitiveFixtureModule(path: string, body = ''): string {
  const importsByTarget = new Map<string, string[]>();
  for (const authority of FINDING_WRITER_SENSITIVE_IMPORT_AUTHORITY) {
    if (!authority.importers.includes(path)) continue;
    const symbols = importsByTarget.get(authority.target) ?? [];
    symbols.push(authority.symbol);
    importsByTarget.set(authority.target, symbols);
  }
  const imports = [...importsByTarget]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([target, symbols]) =>
        `import { ${[...new Set(symbols)].sort().join(', ')} } from '${fixtureModuleSpecifier(
          path,
          target,
        )}';`,
    );
  const runtimeExports = [
    ...FINDING_WRITER_SENSITIVE_IMPORT_AUTHORITY.filter(
      (authority) => authority.target === path,
    ).map((authority) => authority.symbol),
    ...FINDING_WRITER_SENSITIVE_READ_ONLY_EXPORTS.filter(
      (readOnlyExport) => readOnlyExport.target === path,
    ).map((readOnlyExport) => readOnlyExport.symbol),
  ]
    .sort()
    .map((symbol) => `export const ${symbol} = true;`);
  return [...imports, ...runtimeExports, body, ''].filter((line) => line.length > 0).join('\n');
}

export function writeFindingWriterSensitiveFixtureModule(
  root: string,
  path: string,
  body = '',
): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, renderFindingWriterSensitiveFixtureModule(path, body), 'utf8');
}

export function writeFindingWriterSensitiveAuthorityFixture(root: string): void {
  const paths = new Set<string>();
  for (const authority of FINDING_WRITER_SENSITIVE_IMPORT_AUTHORITY) {
    paths.add(authority.target);
    for (const importer of authority.importers) paths.add(importer);
  }
  for (const readOnlyExport of FINDING_WRITER_SENSITIVE_READ_ONLY_EXPORTS) {
    paths.add(readOnlyExport.target);
  }
  for (const path of [...paths].sort()) {
    writeFindingWriterSensitiveFixtureModule(root, path);
  }
}
