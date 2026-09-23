import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStrictJson } from './canonical.mjs';
import { readCommitFile } from './git-objects.mjs';
import { parseMatrix } from './markdown.mjs';

const expectedMetadata = {
  schema_version: '1.0.0',
  oracle_id: 'new-aria-frozen-audit-git-object-v1',
  title_source: {
    commit: '85787e610e26c192c898ffebd4e51ded856cd880',
    path: 'docs/reviews/2026-09-01-aria-full-system-audit.md',
    blob_oid: 'f139345d0fb39b229a616fbe1fed5514e4dcd47e',
    raw_sha256: '4e31fe64c8ffe505e59e1665b19b83d7197d2381d65569f706e8abedcff63749',
    heading_pattern: '^#### ARIA-AUDIT-NNN — Pn — title$',
    expected_count: 88,
  },
  disposition_source: {
    commit: 'c6065d6dac97306f147de67ef58a96e3a67524ac',
    path: 'docs/plans/2026-09-01-new-aria-autonomous-engineering/FINDING-COVERAGE.md',
    blob_oid: '2a744ccf62f776eec8a4a53fc59088342823208d',
    raw_sha256: '4ee24b4141157e1f3f903fe62596b81f8b962d1ce8d02f916e00aef56a0ea9ea',
    expected_count: 88,
  },
};

function add(errors, message) {
  errors.push({ code: 'AUDIT_ORACLE', message });
}

function gitSource(repositoryRoot, metadata, gitTool) {
  return readCommitFile(
    repositoryRoot,
    metadata.commit,
    {
      path: metadata.path,
      blob_oid: metadata.blob_oid,
      sha256: metadata.raw_sha256,
    },
    gitTool,
  ).bytes.toString('utf8');
}

function titleRows(source) {
  const rows = [];
  const pattern = /^#### (ARIA-AUDIT-\d{3}) — (P[0-3]) — (.+)$/gmu;
  for (const match of source.matchAll(pattern)) {
    rows.push({ id: match[1], title: `${match[2]} — ${match[3]}` });
  }
  return rows;
}

export function loadAuditOracle(planRoot, repositoryRoot, errors, gitTool) {
  const metadata = parseStrictJson(
    readFileSync(join(planRoot, 'verification/audit-oracle.json'), 'utf8'),
  );
  if (JSON.stringify(metadata) !== JSON.stringify(expectedMetadata)) {
    add(errors, 'metadata identity drift');
    return [];
  }
  try {
    const titles = titleRows(gitSource(repositoryRoot, metadata.title_source, gitTool));
    const dispositions = parseMatrix(
      gitSource(repositoryRoot, metadata.disposition_source, gitTool),
    );
    if (titles.length !== 88 || dispositions.length !== 88)
      add(errors, 'oracle row count mismatch');
    return titles.map((title, index) => ({
      ...title,
      disposition: index < dispositions.length ? dispositions[index].disposition : undefined,
    }));
  } catch (error) {
    add(errors, error instanceof Error ? error.message : String(error));
    return [];
  }
}

export function verifyAuditRows(errors, current, frozen, oracle) {
  for (let index = 0; index < 88; index += 1) {
    const expected = oracle[index];
    for (const [label, row] of [
      ['matrix', current[index]],
      ['snapshot', frozen[index]],
    ]) {
      if (!row || !expected) {
        add(errors, `${label} row ${index + 1} differs from immutable Git oracle`);
        continue;
      }
      if (
        row.id !== expected.id ||
        row.title !== expected.title ||
        row.disposition !== expected.disposition
      ) {
        add(errors, `${label} row ${index + 1} differs from immutable Git oracle`);
      }
    }
  }
}
