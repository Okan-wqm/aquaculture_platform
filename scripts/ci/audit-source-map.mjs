#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const [inputPath, outputPath] = process.argv.slice(2);

if (!inputPath || !outputPath) {
  console.error('Usage: node scripts/ci/audit-source-map.mjs <audit.json> <report.md>');
  process.exit(2);
}

const audit = JSON.parse(readFileSync(inputPath, 'utf8'));
const vulnerabilities = Object.entries(audit.vulnerabilities ?? {}).sort(([left], [right]) =>
  left.localeCompare(right),
);

const severityRank = {
  critical: 4,
  high: 3,
  moderate: 2,
  low: 1,
  info: 0,
};

const direct = [];
const transitive = [];

for (const [name, details] of vulnerabilities) {
  const row = {
    name,
    severity: details.severity ?? 'unknown',
    via: (details.via ?? []).map((item) => (typeof item === 'string' ? item : item.name)).filter(Boolean),
    effects: details.effects ?? [],
    fixAvailable: details.fixAvailable,
  };

  if (details.isDirect) {
    direct.push(row);
  } else {
    transitive.push(row);
  }
}

const bySeverityThenName = (left, right) =>
  (severityRank[right.severity] ?? -1) - (severityRank[left.severity] ?? -1) ||
  left.name.localeCompare(right.name);

direct.sort(bySeverityThenName);
transitive.sort(bySeverityThenName);

const formatFix = (fixAvailable) => {
  if (fixAvailable === true) return 'available';
  if (fixAvailable === false || fixAvailable == null) return 'none-reported';
  return `${fixAvailable.name ?? 'package'}@${fixAvailable.version ?? 'unknown'}${fixAvailable.isSemVerMajor ? ' major' : ''}`;
};

const formatRows = (rows) => {
  if (rows.length === 0) return '- None\n';

  return rows
    .map((row) => {
      const via = row.via.length > 0 ? row.via.join(', ') : 'self';
      const effects = row.effects.length > 0 ? row.effects.join(', ') : 'none';
      return `- ${row.name}: ${row.severity}; via=${via}; effects=${effects}; fix=${formatFix(row.fixAvailable)}`;
    })
    .join('\n') + '\n';
};

const metadata = audit.metadata?.vulnerabilities ?? {};

// 2026-04-30: This report exists so CI failures show the owning package family.
// It does not suppress npm audit. Workflows must exit with the original audit
// status after writing this artifact.
const report = `# npm audit source map

Generated: ${new Date().toISOString()}

## Counts

- critical: ${metadata.critical ?? 0}
- high: ${metadata.high ?? 0}
- moderate: ${metadata.moderate ?? 0}
- low: ${metadata.low ?? 0}
- info: ${metadata.info ?? 0}

## Direct package families

${formatRows(direct)}
## Transitive package families

${formatRows(transitive)}
`;

writeFileSync(outputPath, report);
