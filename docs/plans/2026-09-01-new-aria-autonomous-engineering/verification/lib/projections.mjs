import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStrictJson, sha256, sha256File } from './canonical.mjs';
import { parseMatrix } from './markdown.mjs';
import { formatProjection } from './projection-format.mjs';

const ranges = [
  [1, 11],
  [12, 22],
  [23, 33],
  [34, 44],
  [45, 55],
  [56, 66],
  [67, 77],
  [78, 88],
];

function rangeName(start, end) {
  return `${String(start).padStart(3, '0')}-${String(end).padStart(3, '0')}`;
}

function generatedMarker(sourceDigest, generatorDigest) {
  return [
    '<!-- GENERATED: render-projections.mjs@1.0.0',
    `source-sha256=${sourceDigest}`,
    `generator-sha256=${generatorDigest}`,
    'DO NOT EDIT -->',
  ].join('\n');
}

function findingPage(findings, start, end, marker) {
  const name = rangeName(start, end);
  const lines = [
    marker,
    '',
    `# ARIA audit finding projection ${name}`,
    '',
    '[Canonical writable authority](../FINDING-COVERAGE.md) · [Projection index](INDEX.md)',
    '',
    "Bu sayfa yalnız generated dikey okuma projection'ıdır. Değişiklikler canonical tabloda yapılır.",
  ];
  for (const finding of findings.slice(start - 1, end)) {
    lines.push(
      '',
      `## ${finding.id}`,
      '',
      `- **Orijinal severity / title:** ${finding.title}`,
      `- **Doğrulama disposition:** ${finding.disposition}`,
      `- **Inherited failure mode:** ${finding.inherited_failure}`,
      `- **Preventive/detective control:** ${finding.control}`,
      `- **Test / operational evidence:** ${finding.evidence}`,
      `- **Owning sprint(s):** ${finding.owning_sprints.join(', ')}`,
      `- **Acceptance ID(s):** ${finding.acceptance_ids.join(', ')}`,
      `- **Closure rule:** ${finding.closure_rules.join(', ')}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function projectionIndex(marker) {
  const lines = [
    marker,
    '',
    '# Generated finding projections',
    '',
    '[Canonical writable authority](../FINDING-COVERAGE.md)',
    '',
    'Fixed ranges field-for-field render edilir; bu dizinde elle değişiklik yapılmaz.',
    '',
  ];
  for (const [start, end] of ranges) {
    const name = rangeName(start, end);
    lines.push(`- [${name}](${name}.md)`);
  }
  return `${lines.join('\n')}\n`;
}

function progressHeader(marker, latest, materialized, count) {
  const reviewName = latest.evidence_uri.split('/').at(-1);
  return [
    marker,
    '',
    '# Yeni ARIA Program Progress — D0 Projection',
    '',
    '> Generated projection; writable authority değildir. Authority:',
    '> [`progress/events.jsonl`](progress/events.jsonl) ve [`progress/evidence/`](progress/evidence/).',
    '',
    '- **Program ID:** `new-aria-autonomous-engineering`',
    `- **Projection generated from event at:** \`${latest.occurred_at}\``,
    `- **D0 state:** \`${latest.to_state}\``,
    `- **Materialization evidence:** [D0-plan-materialization.json](${materialized.evidence_uri})`,
    `- **Materialization digest:** \`${materialized.evidence_digest}\``,
    `- **Review evidence:** [${reviewName}](${latest.evidence_uri})`,
    `- **Review evidence digest:** \`${latest.evidence_digest}\``,
    `- **Review verdict:** \`${latest.review_verdict}\` (non-admission)`,
    `- **Event count:** ${count}`,
    `- **Event-chain tail:** \`${latest.event_hash}\``,
    '- **Corrective status:** pending fresh external twelve-role review',
    '- **D0 merge:** pending',
  ];
}

function markdownTable(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length), 3),
  );
  const render = (row) => `| ${row.map((cell, index) => cell.padEnd(widths[index])).join(' | ')} |`;
  return [render(headers), render(widths.map((width) => '-'.repeat(width))), ...rows.map(render)];
}

function progressTables() {
  const projection = markdownTable(
    ['Scope', 'State', 'Evidence / next gate'],
    [
      [
        'D0 correction',
        '`VERIFYING`',
        'c139 D remediation authored; fresh review has not admitted it.',
      ],
      ['P01 / S01-S08', '`PLANNED`', 'D0 merge and P01 external 12-role gate required.'],
      ['P02 / S09-S16', '`PLANNED`', 'P01 evidence seal required.'],
      ['P03 / S17-S24', '`PLANNED`', 'P02 no-side-effect seal required.'],
      ['P04 / S25-S32', '`PLANNED`', 'P03 `EXECUTE_NO_PUSH` seal required.'],
      ['P05 / S33-S40', '`PLANNED`', 'P04 `PR_OPEN` seal required; merge disabled.'],
      ['P06 / S41-S48', '`PLANNED`', 'P05 adversarial seal required.'],
      ['P07 / S49-S56', '`PLANNED`', 'P06 burn-in evidence required.'],
      ['P08 / S57-S64', '`PLANNED`', 'P07 low-risk evidence required.'],
      ['P09 / S65-S72', '`PLANNED`', 'High-risk activation remains prohibited.'],
    ],
  );
  return [
    '',
    '## Projection',
    '',
    ...projection,
    '',
    '## Sprint counts',
    '',
    '| State         | Count |',
    '| ------------- | ----: |',
    '| `PLANNED`     |    72 |',
    '| `READY`       |     0 |',
    '| `IN_PROGRESS` |     0 |',
    '| `VERIFYING`   |     0 |',
    '| `DONE`        |     0 |',
    '| `BLOCKED`     |     0 |',
    '| `SUPERSEDED`  |     0 |',
    '',
    "D0 program sprint'i değildir; D0 ayrıca `VERIFYING` olarak yukarıda gösterilir.",
    '',
    '## Remaining before D0 can leave VERIFYING',
    '',
    '1. Corrective head için fresh, exact-head twelve-role reports ve independent appellate verdict.',
    '2. Fresh verdict `ACCEPTED` ise ayrı immutable admission evidence/event.',
    '3. D0 PR merge ve actual main SHA için external signed operator readback.',
    '',
    'Bu projection live, merge-authorized veya legacy ARIA replacement iddiası taşımaz.',
  ];
}

function progressProjection(planRoot, marker) {
  const events = readFileSync(join(planRoot, 'progress/events.jsonl'), 'utf8')
    .trimEnd()
    .split('\n')
    .map(parseStrictJson);
  const latest = events.at(-1);
  const materialized = events.find((event) => event.event_id === 'd0-0004');
  const lines = [
    ...progressHeader(marker, latest, materialized, events.length),
    ...progressTables(),
  ];
  return `${lines.join('\n')}\n`;
}

function generatorDigest(planRoot) {
  const paths = [
    'verification/lib/projection-format.mjs',
    'verification/lib/projections.mjs',
    'verification/render-projections.mjs',
  ];
  const body = paths.map((path) => `${path}\0${sha256File(join(planRoot, path))}\n`).join('');
  return sha256(Buffer.from(body, 'utf8'));
}

export function buildProjectionSet(planRoot, repositoryRoot) {
  const inputs = [
    'FINDING-COVERAGE.md',
    'progress/events.jsonl',
    'verification/readability-policy.json',
  ];
  const inputDigests = inputs.map((path) => ({ path, sha256: sha256File(join(planRoot, path)) }));
  const findings = parseMatrix(readFileSync(join(planRoot, 'FINDING-COVERAGE.md'), 'utf8'));
  const sourceDigest = inputDigests[0].sha256;
  const generator = generatorDigest(planRoot);
  const marker = generatedMarker(sourceDigest, generator);
  const rawOutputs = new Map([
    ['finding-projections/INDEX.md', projectionIndex(marker)],
    ['PROGRESS.md', progressProjection(planRoot, marker)],
  ]);
  for (const [start, end] of ranges) {
    rawOutputs.set(
      `finding-projections/${rangeName(start, end)}.md`,
      findingPage(findings, start, end, marker),
    );
  }
  const outputs = new Map(
    [...rawOutputs].map(([path, content]) => [
      path,
      formatProjection(repositoryRoot, join(planRoot, path), content),
    ]),
  );
  const manifest = {
    schema_version: '1.0.0',
    owner: 'new-aria-program-authority',
    reason: 'Deterministic readable projections of canonical event and finding authorities.',
    expires_at: 'S72 program closeout',
    input_digests: inputDigests,
    generator_argv: [
      'node',
      'docs/plans/2026-09-01-new-aria-autonomous-engineering/verification/render-projections.mjs',
      '--repo-root',
      '.',
    ],
    generator_version: '1.0.0',
    generator_digest: generator,
    output_digests: [...outputs].map(([path, content]) => ({
      path,
      sha256: sha256(Buffer.from(content, 'utf8')),
    })),
    deterministic_check_argv: [
      'node',
      'docs/plans/2026-09-01-new-aria-autonomous-engineering/verification/render-projections.mjs',
      '--repo-root',
      '.',
      '--check',
    ],
  };
  outputs.set('verification/projection-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  return outputs;
}
