/**
 * `batches_v2.protocolId` stays retired — architecture invariant.
 *
 * WHY this test exists: the column was a v1-era batch→protocol binding that
 * NOTHING ever wrote, yet three services read it and silently took their "no
 * protocol" branch for the lifetime of the feature. It has now been dropped
 * (DropBatchProtocolId1808700000000) and every reader re-pointed at the unit's
 * `ProtocolAssignment`. A resurrected read is no longer a quiet wrong answer —
 * it is a runtime `42703 column "protocolId" does not exist`. This spec turns
 * that production failure into a red test at build time (tier 3), which is the
 * best a raw-SQL string can be guarded by; the entity check below is tier 1,
 * since a re-added `@Column` would fail the schema-drift validator too.
 *
 * WHAT it checks:
 *  1. no SQL string anywhere in farm-service names `batches_v2` and
 *     `protocolId` together;
 *  2. the Batch entity declares no `protocolId` property.
 * Migrations are exempt: they are the immutable history of the column, and
 * 1802000000000 legitimately still contains its CREATE.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '../../');
const MIGRATIONS_DIR = path.normalize('database/migrations');

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
        files.push(...sourceFiles(fullPath));
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Every quoted/backticked literal in the file, comments excluded.
 *
 * WHY a scanner and not a regex: scanning literals rather than whole files
 * keeps the check precise — a module may legitimately hold a `protocolId`
 * variable AND query `batches_v2`; only putting both inside one SQL string is
 * the violation. But a regex cannot tell a template literal from a backticked
 * term inside a doc comment, and the files that removed this column all
 * *describe* it in prose. A single pass over the source tracking code /
 * comment / string state distinguishes them exactly.
 */
function stringLiterals(source: string): string[] {
  const literals: string[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end + 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === '`' || char === "'" || char === '"') {
      const quote = char;
      let cursor = index + 1;
      let literal = '';
      while (cursor < source.length) {
        const current = source[cursor];
        if (current === '\\') {
          cursor += 2;
          continue;
        }
        if (current === quote) break;
        // An unescaped newline ends an unterminated '/" literal — bail out
        // rather than swallowing the rest of the file as one string.
        if (current === '\n' && quote !== '`') break;
        literal += current;
        cursor += 1;
      }
      literals.push(literal);
      index = cursor + 1;
      continue;
    }
    index += 1;
  }

  return literals;
}

describe('batches_v2.protocolId retirement', () => {
  it('is not referenced by any SQL string in farm-service', () => {
    const violations: string[] = [];

    for (const file of sourceFiles(SRC_ROOT)) {
      const relativePath = path.normalize(path.relative(SRC_ROOT, file));
      if (relativePath.startsWith(MIGRATIONS_DIR)) continue;
      if (relativePath === path.normalize(path.relative(SRC_ROOT, __filename))) continue;

      for (const literal of stringLiterals(fs.readFileSync(file, 'utf8'))) {
        if (literal.includes('batches_v2') && literal.includes('protocolId')) {
          violations.push(relativePath);
          break;
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('is not declared on the Batch entity', () => {
    const entity = fs.readFileSync(path.join(SRC_ROOT, 'batch/entities/batch.entity.ts'), 'utf8');

    // The retirement note in the entity deliberately names the column in prose;
    // what must not come back is a property/column declaration.
    expect(entity).not.toMatch(/^\s*protocolId[?!]?\s*:/m);
  });
});
